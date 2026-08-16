// lib/plugin-backup.js
// 备份执行器：按 PluginSpec[] 把插件落盘到 backupRoot/plugins/
//
// 存储布局（v2 对齐）：
//   <backupRoot>/plugins/
//     index.json                 # 全量 PluginSpec[]（还原用）
//     <safeName>/                # 每个插件一个目录（safeName = 包名转安全文件名）
//       spec.json                # 该插件的独立 spec（容错：index 损坏也能恢复单插件）
//       content/                 # blob-raw / blob-modified 的实际内容（pointer 无此目录）
//
// 设计决策：
//  - 不用 tar/gzip（不依赖外部命令，保持目录原样，便于 diff 和 sha 校验）
//  - pointer 只写 spec.json（重装时 pnpm add / git clone 拉回）
//  - symlink 插件备份的是 realpath 目标内容（否则还原后断链），spec 里记录 symlinkTarget
//  - sha256 由 scanner 的 fingerprint 承担（目录树指纹），copy 后不重算（内容字节相同）
//  - 文件源（工作区快照里的 zip/mjs/bat）直接复制文件，目录源递归复制
//  - 全部目录遍历用显式栈（非递归）防 Windows junction 循环栈溢出
//  - fs.rmSync 前先 existsSync 检查（Windows 对 .zip 后缀父目录的 rmSync 有 native crash）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 包名 → 安全目录名（@scope/name → scope__name，Windows 安全）
// 扩展名 .zip/.tar 等换成 .dir：避免 Windows 对「.zip 后缀目录」的 rmSync native crash
function safeName(pkg) {
  const n = pkg.replace(/^@/, '').replace(/[\\/:*?"<>|]/g, '__');
  return n.replace(/\.(zip|tar|gz|tgz|rar|7z)$/i, '.dir');
}

// 复制（目录递归 / 文件直拷），显式栈 + visited(realpath) 防循环
const SKIP_COPY = new Set(['node_modules', '.git', '.bin', '.cache', '__pycache__']);
function copyDir(src, dst) {
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
      if (SKIP_COPY.has(entry.name)) continue;
      const sp = path.join(s, entry.name);
      const dp = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push([sp, dp]);
      else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(sp);
        try { fs.symlinkSync(target, dp, 'junction'); } catch (e) { /* 忽略 */ }
      } else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
  }
}

// 文件 sha256
function fileSha256(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// 目录大小（显式栈，非递归）
function dirSize(d) {
  const st = fs.statSync(d);
  if (st.isFile()) return st.size;
  let total = 0;
  const visited = new Set();
  const stack = [d];
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { continue; }
    if (visited.has(real)) continue;
    visited.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

// 文件数（显式栈，非递归）
function countFiles(d) {
  const st = fs.statSync(d);
  if (st.isFile()) return 1;
  let n = 0;
  const visited = new Set();
  const stack = [d];
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { continue; }
    if (visited.has(real)) continue;
    visited.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

// 安全递归删除（显式栈，不依赖 fs.rmSync——规避 Windows 对 .zip 后缀目录的 rmSync native crash）
function safeRm(dir) {
  if (!fs.existsSync(dir)) return;
  const stack = [dir];
  const dirs = [];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { fs.unlinkSync(p); } catch (e2) { /* 忽略 */ } }
    }
    dirs.push(d);
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    try { fs.rmdirSync(dirs[i]); } catch (e) { /* 忽略 */ }
  }
}

// 把单个插件落盘
function backupOne(spec, pluginsRoot) {
  const dir = path.join(pluginsRoot, safeName(spec.pkg));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

  if (spec.strategy === 'pointer') {
    return { ok: true, path: dir, bytes: 0, mode: 'pointer' };
  }
  if (!spec.sourceDir) {
    return { ok: false, path: dir, error: 'spec 缺少 sourceDir（物理来源路径）' };
  }
  const contentDir = path.join(dir, 'content');
  // 先检查存在再删（Windows .zip 后缀父目录 rmSync native crash 规避）
  if (fs.existsSync(contentDir)) {
    try { fs.rmSync(contentDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
  copyDir(spec.sourceDir, contentDir);
  const bytes = dirSize(contentDir);
  return { ok: true, path: dir, bytes, mode: spec.strategy, files: countFiles(contentDir) };
}

// 主入口：备份整个 profile / 工作区的条目集
function backupPlugins(specs, pluginsRoot) {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const results = [];
  for (const spec of specs) {
    const r = backupOne(spec, pluginsRoot);
    results.push({ pkg: spec.pkg, ...r });
  }
  const index = { at: new Date().toISOString(), plugins: specs.map((s, i) => ({ ...s, _backup: results[i] })) };
  fs.writeFileSync(path.join(pluginsRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  return results;
}

export { backupPlugins, safeName, copyDir, fileSha256, dirSize, countFiles, safeRm };
