// lib/pnpm-build-allow.js — 检测并自动批准 pnpm 10+ 拒绝的 build script，
//                       并迁移 package.json 里被废弃的 pnpm.* 字段。
//
// 两个职责：
//  1) autoApprovePnpmBuilds —— install / update / install-from-github 三处的统一入口。
//     检测第一次 dsh plugin run 是否包含 allowBuilds / Ignored build scripts / approve-builds 关键词，
//     若是，手动 patch pnpm-workspace.yaml 的 allowBuilds 字段并重跑命令。
//
//  2) migrateLegacyPnpmFields —— pnpm 10+ 起 package.json#pnpm 字段被整体忽略，
//     仍按旧语法写时会发 [WARN] The "pnpm" field in package.json is no longer read by pnpm ...
//     这条 WARN 本身 exit 0，但副作用是原本"允许 node-pty 跑 build"的设置被静默忽略，
//     node-pty 没装对 → dsh 后续起不来 → update 退出非零 → 前端误报"更新失败"。
//     在 dsh 命令跑之前，把 package.json#pnpm.onlyBuiltDependencies 等子字段搬到
//     pnpm-workspace.yaml 的现代写法（pnpm 11 仍接受的顶级字段 onlyBuiltDependencies）。

import fs from 'node:fs';
import path from 'node:path';
import { runDsh } from './cmd-runner.js';

/**
 * 检测并自动批准 pnpm GitHub/npm 源包的 build script
 *
 * @param {object} opts
 * @param {string} opts.profDir - profile 目录（绝对路径，含 pnpm-lock.yaml）
 * @param {string} opts.profile - profile 名（传给 dsh 命令）
 * @param {string[]} opts.dshArgs - dsh plugin 子命令参数，例如 ['add', '@scope/pkg'] 或 ['update', 'pkg']
 * @param {string} [opts.pkg] - 用于定位 repo key 的包名（默认从 dshArgs 取最后一个）
 * @param {object} [opts.repo] - {owner, repo} 用于生成 GitHub 仓库通配 key；不传（npm 源）则写纯包名 key
 * @param {object} [opts.log] - 日志对象 {info?, warn?}
 * @param {string} [opts.dataDir] - 数据目录（写操作日志用，可选）
 * @returns {Promise<{firstJob, secondJob, autoApproved, pkg, migrated}>}
 */
export async function autoApprovePnpmBuilds({ profDir, profile, dshArgs, pkg, repo, log, dataDir }) {
  // 先做废弃字段迁移：避免 pnpm 发"被忽略"告警 + 让原本写在 package.json#pnpm 的
  // onlyBuiltDependencies 真正生效。幂等——无废弃字段时直接返回 migrated:false。
  const migrated = migrateLegacyPnpmFields(profDir, { log });
  if (migrated.migrated && dataDir) {
    try {
      const { appendLog } = await import('./operation-log.js');
      appendLog(dataDir, {
        action: 'pnpm-legacy-migrate',
        profile,
        profDir,
        fields: migrated.fields,
        backups: migrated.backups,
      });
    } catch (e) {
      log?.warn?.('[pnpm-build-allow] appendLog failed', e.message);
    }
  }

  const firstJob = await runDsh(['plugin', '--profile', profile, ...dshArgs], { cwd: profDir });
  // dsh 把 pnpm 输出写到 stdout（不是 stderr），所以同时检查两者。
  // 注意：pnpm 中文报错里"allowBuilds"被包在中文双引号里（"allowBuilds" allowlist），
  // 不能用 allowBuilds allowlist 这种粘合的正则。
  const approveAndRetry = /allowBuilds|Ignored build scripts|approve-builds/i.test((firstJob.stderr || '') + (firstJob.stdout || ''));
  if (!approveAndRetry) {
    return { firstJob, secondJob: firstJob, autoApproved: false, pkg, migrated };
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
  return { firstJob, secondJob, autoApproved: true, pkg, migrated };
}

// ── 废弃字段迁移：package.json#pnpm → pnpm-workspace.yaml ──

/**
 * 备份文件到 <file>.legacy-migrate.bak（已存在则跳过）
 */
function makeBackupFile(filePath) {
  const backup = `${filePath}.legacy-migrate.bak`;
  if (fs.existsSync(filePath) && !fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
  return backup;
}

/**
 * 把 items 合并到 yaml 文本里 key: 下的列表块（仅支持块列表 `- xxx` 形式，不动 inline [...]）。
 * 返回 { text, changed }。
 */
function mergeYamlList(yamlText, key, items) {
  if (!items || items.length === 0) return { text: yamlText, changed: false };
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`(^${escKey}:[ \\t]*)\\n((?:[ \\t]*-[ \\t]+.+\\n?)*)`, 'm');
  const m = yamlText.match(blockRe);
  // 已有项去重
  const existing = new Set();
  if (m) {
    for (const line of m[2].split('\n')) {
      const item = line.match(/^[ \t]*-[ \t]+(.+?)\s*$/);
      if (item) existing.add(item[1]);
    }
  }
  const newItems = items.filter((it) => !existing.has(it));
  if (m && newItems.length === 0) return { text: yamlText, changed: false };

  // 注意：只追加新项（newItems），避免和已有项重复
  const newListBlock = newItems.map((it) => `  - ${it}`).join('\n');
  let text;
  if (m) {
    // 已有块：保留缩进风格，把新项追加到列表末尾
    const tail = m[2].endsWith('\n') ? m[2] : m[2] + '\n';
    text = yamlText.replace(blockRe, `${m[1]}\n${tail}${newListBlock}\n`);
  } else {
    // 没有块：追加到文件末尾（确保前面有换行）
    const sep = yamlText.length === 0 || yamlText.endsWith('\n') ? '' : '\n';
    text = `${yamlText}${sep}${key}:\n${newListBlock}\n`;
  }
  return { text, changed: true };
}

/**
 * 把 profile 里 package.json#pnpm 的废弃子字段迁移到 pnpm-workspace.yaml。
 *
 * 当前覆盖：
 *   pnpm.onlyBuiltDependencies     → pnpm-workspace.yaml#onlyBuiltDependencies
 *   pnpm.ignoredBuiltDependencies  → pnpm-workspace.yaml#ignoredBuiltDependencies
 *
 * 无废弃字段时只清理"pnpm 块为空"的占位（避免 pnpm 仍然发"被忽略"告警），整体返回 migrated:false。
 *
 * @param {string} profDir  profile 目录（含 package.json 与 pnpm-workspace.yaml）
 * @param {object} [opts]
 * @param {object} [opts.log] {info?, warn?}
 * @returns {{migrated: boolean, fields: string[], backups: string[]}}
 */
export function migrateLegacyPnpmFields(profDir, opts = {}) {
  const { log } = opts;
  const pkgPath = path.join(profDir, 'package.json');
  const wsPath = path.join(profDir, 'pnpm-workspace.yaml');
  const result = { migrated: false, fields: [], backups: [] };

  if (!fs.existsSync(pkgPath)) return result;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return result;
  }
  const pnpmBlock = pkg.pnpm;
  if (!pnpmBlock || typeof pnpmBlock !== 'object') return result;

  const onlyBuilt = Array.isArray(pnpmBlock.onlyBuiltDependencies)
    ? pnpmBlock.onlyBuiltDependencies.filter((s) => typeof s === 'string' && s.trim())
    : [];
  const ignoredBuilt = Array.isArray(pnpmBlock.ignoredBuiltDependencies)
    ? pnpmBlock.ignoredBuiltDependencies.filter((s) => typeof s === 'string' && s.trim())
    : [];

  // 没有要迁移的子字段：但 pnpm 块整体为空的话顺手清掉，避免 pnpm 仍然发"被忽略"告警
  if (onlyBuilt.length === 0 && ignoredBuilt.length === 0) {
    if (Object.keys(pnpmBlock).length === 0) {
      const backup = makeBackupFile(pkgPath);
      delete pkg.pnpm;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      result.migrated = true;
      result.fields.push('pnpm.empty');
      result.backups.push(backup);
      log?.info?.(`[pnpm-legacy-migrate] 清理空 pnpm 字段（备份：${path.basename(backup)}）`);
    }
    return result;
  }

  // 1) 备份
  const pkgBackup = makeBackupFile(pkgPath);
  result.backups.push(pkgBackup);
  let yamlText = 'packages:\n  - .\n';
  if (fs.existsSync(wsPath)) {
    result.backups.push(makeBackupFile(wsPath));
    yamlText = fs.readFileSync(wsPath, 'utf8');
  }

  // 2) 合并到 pnpm-workspace.yaml
  let changed = false;
  if (onlyBuilt.length) {
    const r = mergeYamlList(yamlText, 'onlyBuiltDependencies', onlyBuilt);
    yamlText = r.text;
    if (r.changed) { changed = true; result.fields.push('onlyBuiltDependencies'); }
  }
  if (ignoredBuilt.length) {
    const r = mergeYamlList(yamlText, 'ignoredBuiltDependencies', ignoredBuilt);
    yamlText = r.text;
    if (r.changed) { changed = true; result.fields.push('ignoredBuiltDependencies'); }
  }
  if (changed || !fs.existsSync(wsPath)) {
    fs.writeFileSync(wsPath, yamlText.replace(/\s+$/, '') + '\n', 'utf8');
  }

  // 3) 从 package.json 清掉已迁移的子字段；空块顺手删掉
  if (onlyBuilt.length) delete pkg.pnpm.onlyBuiltDependencies;
  if (ignoredBuilt.length) delete pkg.pnpm.ignoredBuiltDependencies;
  if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  result.migrated = true;
  log?.info?.(
    `[pnpm-legacy-migrate] 已迁移 ${result.fields.join(', ')} ` +
    `→ ${path.basename(wsPath)}（package.json 备份：${path.basename(pkgBackup)}）`
  );
  return result;
}
