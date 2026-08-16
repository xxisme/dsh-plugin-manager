// lib/pnpm-build-allow.js — 检测并自动批准 pnpm 10+ 拒绝的 build script
//
// pnpm 10+ 默认拒绝跑依赖的 build script，会报：
//   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: xxx
//   Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
//
// 解决方案（update / install / install-from-github 都适用）：
//   1) 检测第一次 dsh plugin run 是否包含 allowBuilds / Ignored build scripts / approve-builds 关键词
//   2) 若是，手动 patch pnpm-workspace.yaml 的 allowBuilds 字段
//   3) 重跑命令
//
// patch 的 key 形式（按源区分）：
//   - GitHub 源：仓库通配 key（pnpm 11.11+ 匹配所有 commit）
//       pkg@git+ssh://git@github.com/owner/repo.git: true
//       pkg@https://codeload.github.com/owner/repo/tar.gz: true   ← github: 简写会被 pnpm 解析到这个 URL
//   - npm registry 源：纯包名 key（如 `node-pty: true`）
//
// 提取成可复用函数：install / update / install-from-github 三处都调一次。

import fs from 'node:fs';
import path from 'node:path';
import { runDsh } from './cmd-runner.js';

/**
 * 检测并自动批准 pnpm GitHub 源包的 build script
 *
 * @param {object} opts
 * @param {string} opts.profDir - profile 目录（绝对路径，含 pnpm-lock.yaml）
 * @param {string} opts.profile - profile 名（传给 dsh 命令）
 * @param {string[]} opts.dshArgs - dsh plugin 子命令参数，例如 ['add', '@scope/pkg'] 或 ['update', 'pkg']
 * @param {string} [opts.pkg] - 用于定位 repo key 的包名（默认从 dshArgs 取最后一个）
 * @param {object} [opts.repo] - {owner, repo} 用于生成 GitHub 仓库通配 key；不传（npm 源）则写纯包名 key
 * @param {object} [opts.log] - 日志对象 {info?, warn?}
 * @returns {Promise<{firstJob, secondJob, autoApproved, pkg}>}
 *   - firstJob: 第一次跑的结果
 *   - secondJob: 第二次跑的结果（autoApproved=false 时 = firstJob）
 *   - autoApproved: 是否触发了 autoApprove
 *   - pkg: 用于日志的包名
 */
export async function autoApprovePnpmBuilds({ profDir, profile, dshArgs, pkg, repo, log }) {
  const firstJob = await runDsh(['plugin', '--profile', profile, ...dshArgs], { cwd: profDir });
  // dsh 把 pnpm 输出写到 stdout（不是 stderr），所以同时检查两者。
  // 注意：pnpm 中文报错里"allowBuilds"被包在中文双引号里（"allowBuilds" allowlist），
  // 不能用 allowBuilds allowlist 这种粘合的正则。
  const approveAndRetry = /allowBuilds|Ignored build scripts|approve-builds/i.test((firstJob.stderr || '') + (firstJob.stdout || ''));
  if (!approveAndRetry) {
    return { firstJob, secondJob: firstJob, autoApproved: false, pkg };
  }
  log?.info?.('auto-approving pnpm builds for', pkg || dshArgs.join(' '));

  // pnpm approve-builds 需要 lockfile 已更新才看得到 pending——update/add 失败时它会说 "no awaiting"。
  // 所以同时手动 patch pnpm-workspace.yaml。
  //   - github 源（有 repo）→ 写仓库通配 key（git+ssh / codeload tarball 两种形式，pnpm 11.11+ 匹配所有 commit）
  //   - npm 源（无 repo）→ 写纯包名 key（registry 包形式，如 `node-pty: true`）
  if (pkg) {
    try {
      const wsPath = path.join(profDir, 'pnpm-workspace.yaml');
      if (fs.existsSync(wsPath)) {
        let text = fs.readFileSync(wsPath, 'utf8');
        const keys = repo
          ? [
            `${pkg}@git+ssh://git@github.com/${repo.owner}/${repo.repo}.git`, // git+ssh 形式
            `${pkg}@https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz`, // codeload tarball 形式（github: 简写会被 pnpm 解析到这个 URL）
          ]
          : [pkg]; // npm 源：纯包名 key
        for (const key of keys) {
          const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm');
          if (!re.test(text)) {
            const line = `  ${key}: true`;
            if (/^allowBuilds:\s*$/m.test(text)) {
              text = text.replace(/^(allowBuilds:\s*)$/m, `$1\n${line}`);
            } else if (/^allowBuilds:\s*\n[\s\S]+?(\n[a-zA-Z@_-]|\n$)/m.test(text)) {
              text = text.replace(/^(allowBuilds:\s*\n[\s\S]*?)(  [a-zA-Z@_-])/m, `$1${line}\n$2`);
            } else {
              text = text.replace(/(\n[a-zA-Z])/m, `\nallowBuilds:\n${line}$1`);
            }
          }
        }
        fs.writeFileSync(wsPath, text, 'utf8');
      }
    } catch (e) {
      log?.warn?.('patch pnpm-workspace.yaml failed', e.message);
    }
  }

  // 重试命令
  const secondJob = await runDsh(['plugin', '--profile', profile, ...dshArgs], { cwd: profDir });
  return { firstJob, secondJob, autoApproved: true, pkg };
}