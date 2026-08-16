// lib/plugin-restore.js
// 恢复执行器：按 PluginSpec[] 把插件还原到目标 profile
//
// 恢复语义（v2 对齐）：
//  - pointer      → 输出 pnpm add 命令（registry: pkg@ver；github/git: 原始 specifier），
//                   由 pnpm 完成拉取 + 校验 integrity（dry-run 时只列命令）
//  - blob-raw     → 把备份 content/ 复制回原位；symlink 插件先重建 link 再复制内容
//  - blob-modified→ 把备份 content/ 覆盖到 node_modules/<pkg>/（可能覆盖用户改动，先备份当前）
//
// 安全设计：
//  - restorePlugins(..., { dryRun: true }) 只预览，不写盘（默认 dry-run）
//  - 覆盖前先把当前目录 rename 成 <pkg>.pre-restore-<ts>（可回滚）
//  - symlink 还原需要知道原 target 路径（spec.symlinkTarget 或用户提供）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { safeName } from './plugin-backup.js';

// 从 lockfile 的 version 提取 github commit：
//   git+ssh://git@github.com/owner/repo.git#<40hex>
//   https://codeload.github.com/owner/repo/tar.gz/<40hex>
// 返回 40 位 commit 或 null
function githubCommitOf(lockVersion) {
  if (!lockVersion) return null;
  const s = String(lockVersion);
  const m = s.match(/#([0-9a-f]{40})/) || s.match(/tar\.gz\/([0-9a-f]{40})/);
  return m ? m[1] : null;
}

// 还原用的安装 spec：优先锁到备份时的 commit（specifier 已带 # 则不重复拼）
function restoreSpecOf(spec) {
  if (['git', 'github', 'github-tarball'].includes(spec.installKind)) {
    const commit = githubCommitOf(spec.lockVersion);
    const base = spec.lockSpecifier || spec.pkg;
    if (commit && !String(base).includes('#')) return `${base}#${commit}`;
    return base;
  }
  if (spec.installKind === 'registry') {
    return spec.localVersion ? `${spec.pkg}@${spec.localVersion}` : spec.pkg;
  }
  return spec.lockSpecifier || spec.pkg;
}

// 构建还原命令（dry-run 用）
function buildRestoreCommands(spec, opts = {}) {
  const cmds = [];
  const { npmRegistry } = opts;
  if (spec.strategy === 'pointer') {
    if (spec.installKind === 'registry') {
      const reg = npmRegistry ? ` --registry=${npmRegistry}` : '';
      cmds.push(`pnpm add ${spec.pkg}@${spec.localVersion}${reg}`);
    } else if (spec.installKind === 'git' || spec.installKind === 'github' || spec.installKind === 'github-tarball') {
      // 用原始 specifier 还原；若有备份时的 commit 则锁定（#commit）
      cmds.push(`pnpm add "${restoreSpecOf(spec)}"`);
    } else {
      cmds.push(`# [${spec.pkg}] pointer 但无法自动还原（installKind=${spec.installKind}），需手动处理`);
    }
  } else {
    // blob-raw / blob-modified：复制 content/ 回去
    cmds.push(`# [${spec.pkg}] blob 恢复：复制 content/ 到 ${spec.installKind === 'link' ? 'symlink 目标' : 'node_modules/'}${spec.pkg}`);
  }
  return cmds;
}

// 恢复单个 blob 插件：复制 content/ 到目标
// spec.sourceDir 是备份时的原始路径（可能是 node_modules/<pkg> 或 symlink 目标）
// restoreOpts.targetDir 可覆盖（默认用 spec.sourceDir）
function restoreBlobOne(spec, pluginsRoot, targetDir) {
  const content = path.join(pluginsRoot, safeName(spec.pkg), 'content');
  if (!fs.existsSync(content)) {
    return { ok: false, pkg: spec.pkg, error: `备份缺少 content/: ${content}` };
  }
  const dst = targetDir || spec.sourceDir;
  if (!dst) return { ok: false, pkg: spec.pkg, error: '缺少目标路径（spec.sourceDir 或 restoreOpts.targetDir）' };

  // 覆盖前先备份当前（可回滚）
  if (fs.existsSync(dst)) {
    const rollback = dst + '.pre-restore-' + Date.now();
    try { fs.renameSync(dst, rollback); } catch (e) { /* 可能被占用，忽略 */ }
  }
  fs.mkdirSync(dst, { recursive: true });
  copyDirFlat(content, dst);
  return { ok: true, pkg: spec.pkg, restoredTo: dst };
}

// 递归复制（不跳过任何内容——备份时已过滤噪音）
// 兼容文件源：content 是文件时（工作区快照里的 zip/mjs/bat）直接复制
// 非递归显式栈 + visited(realpath) 防 Windows junction 循环
function copyDirFlat(src, dst) {
  const st = fs.statSync(src);
  if (st.isFile()) {
    const target = fs.existsSync(dst) && fs.statSync(dst).isDirectory()
      ? path.join(dst, path.basename(src))
      : dst;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    return;
  }
  const visited = new Set();
  const stack = [[src, dst]];
  while (stack.length) {
    const [s, d] = stack.pop();
    let real;
    try { real = fs.realpathSync(s); } catch (e) { continue; }
    if (visited.has(real)) continue;
    visited.add(real);
    fs.mkdirSync(d, { recursive: true });
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, entry.name);
      const dp = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push([sp, dp]);
      else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
  }
}

// 主入口
// specs: PluginSpec[]（从备份 index.json 读）
// pluginsRoot: <backupRoot>/plugins
// opts: { dryRun?: boolean, targetDir?: Record<pkg, string> }
function restorePlugins(specs, pluginsRoot, opts = {}) {
  const dryRun = opts.dryRun !== false; // 默认 dry-run（安全）
  const results = [];
  for (const spec of specs) {
    if (spec.strategy === 'pointer') {
      results.push({
        pkg: spec.pkg,
        strategy: 'pointer',
        dryRun,
        commands: buildRestoreCommands(spec, opts),
        applied: false,
      });
    } else {
      if (dryRun) {
        results.push({
          pkg: spec.pkg,
          strategy: spec.strategy,
          dryRun,
          commands: [`复制 content/ → ${opts.targetDir?.[spec.pkg] || spec.sourceDir || '?'}`],
          applied: false,
        });
      } else {
        const r = restoreBlobOne(spec, pluginsRoot, opts.targetDir?.[spec.pkg]);
        results.push({ pkg: spec.pkg, strategy: spec.strategy, dryRun: false, ...r });
      }
    }
  }
  return results;
}

/**
 * 真实执行还原（apply）：
 *  - pointer registry → pnpm add pkg@version
 *  - pointer github/git → pnpm add <原始 specifier>
 *  - blob-raw（link）→ 复制 content 到 external/<pkg>，pnpm add link:<路径> 注册
 *  - blob 兑底 → 复制 content 到 node_modules/<pkg>
 *  - 全部成功后注册到 dsh.profile.bundles
 *
 * @param {object[]} specs PluginSpec[]（从备份 index.json 读）
 * @param {string} pluginsRoot 备份的 plugins 目录
 * @param {object} exec 执行器：{ add(specStr) → Promise<{ok, error}>, registerBundle(pkg) → void, copyBlob(spec, dst) → Promise<{ok, restoredTo, error}>, targetDirFor?(spec) }
 * @returns {{ok: boolean, results: object[]}} 每插件真实结果
 */
async function restorePluginsExec(specs, pluginsRoot, exec) {
  const results = [];
  let allOk = true;
  for (const spec of specs) {
    try {
      if (spec.strategy === 'pointer') {
        // pointer：从上游重拉（registry 锁版本，github/git 锁定备份时的 commit）
        let specStr;
        if (['git', 'github', 'github-tarball'].includes(spec.installKind)) {
          specStr = restoreSpecOf(spec);
        } else if (spec.installKind === 'registry') {
          specStr = spec.localVersion ? `${spec.pkg}@${spec.localVersion}` : spec.pkg;
        } else {
          results.push({ pkg: spec.pkg, strategy: 'pointer', ok: false, applied: false, error: `无法自动还原（installKind=${spec.installKind}）` });
          allOk = false;
          continue;
        }
        const r = await exec.add(specStr);
        if (r.ok) {
          try { exec.registerBundle(spec.pkg); } catch { /* bundles 注册失败不影响安装 */ }
        }
        results.push({ pkg: spec.pkg, strategy: 'pointer', ok: !!r.ok, applied: !!r.ok, specStr, error: r.error || undefined });
        if (!r.ok) allOk = false;
      } else {
        // blob：复制备份 content 到目标（link 插件 → external/<pkg> + link 注册）
        const isLink = spec.installKind === 'link';
        const dst = exec.targetDirFor ? exec.targetDirFor(spec) : (isLink ? null : spec.sourceDir);
        const r = await exec.copyBlob(spec, dst);
        if (r.ok && isLink) {
          const linkPath = r.restoredTo.startsWith('link:') ? r.restoredTo : `link:${r.restoredTo}`;
          const linkAdd = await exec.add(linkPath);
          if (!linkAdd.ok) {
            results.push({ pkg: spec.pkg, strategy: spec.strategy, ok: false, applied: false, error: 'link 注册失败: ' + (linkAdd.error || '') });
            allOk = false;
            continue;
          }
          try { exec.registerBundle(spec.pkg); } catch { /* ignore */ }
        }
        results.push({ pkg: spec.pkg, strategy: spec.strategy, ok: !!r.ok, applied: !!r.ok, restoredTo: r.restoredTo, error: r.error || undefined });
        if (!r.ok) allOk = false;
      }
    } catch (e) {
      results.push({ pkg: spec.pkg, strategy: spec.strategy, ok: false, applied: false, error: e.message });
      allOk = false;
    }
  }
  return { ok: allOk, results };
}

export { restorePlugins, buildRestoreCommands, restoreBlobOne, copyDirFlat, restorePluginsExec, githubCommitOf, restoreSpecOf };
