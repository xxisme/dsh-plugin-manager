// lib/plugin-backup.js
// 备份执行器：按 PluginSpec[] 把插件落盘到 backupRoot/plugins/
//
// 存储布局（v2 对齐）：
//   <backupRoot>/plugins/
//     index.json                 # 全量 PluginSpec[]（还原用）
//     <safeName>/                # 每个插件一个目录（safeName = 包名转安全文件名）
//       spec.json                # 该插件的独立 spec（容错：index 损坏也能恢复单插件）
//       content/                 # blob-raw / blob-modified 的实际内容（pointer 无此目录）
//       origin.<ext>             # blob-raw 原物（zip 原样复制；目录则复制到 content/）
//
// 设计决策：
//  - 不用 tar/gzip（不依赖外部命令，保持目录原样，便于 diff 和 sha 校验）
//  - pointer 只写 spec.json（重装时 pnpm add / git clone 拉回）
//  - symlink 插件备份的是 realpath 目标内容（否则还原后断链），spec 里记录 symlinkTarget
//  - sha256 由 scanner 的 fingerprint 承担（目录树指纹），copy 后不重算（内容字节相同）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 包名 → 安全目录名（@scope/name → scope__name，Windows 安全）
function safeName(pkg) {
  return pkg.replace(/^@/, '').replace(/[\/\\:*?"<>|]/g, '__');
}

// 复制目录（保持原样；Windows 下 junction/symlink 用 realpath 内容）
// 与 dirFingerprint 同规则排除噪音目录（node_modules/.git/.bin/.cache）
const SKIP_COPY = new Set(['node_modules', '.git', '.bin', '.cache', '__pycache__']);
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue; // 不复制依赖目录（pnpm 重装）
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) {
      // 保留符号链接（Windows junction 语义：目录链接）
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d, 'junction'); } catch (e) { /* 已存在或权限问题，跳过 */ }
    } else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// 计算文件 sha256
function fileSha256(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// 把单个插件落盘
// 返回: { ok, path, error?, bytes? }
function backupOne(spec, pluginsRoot) {
  const dir = path.join(pluginsRoot, safeName(spec.pkg));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

  if (spec.strategy === 'pointer') {
    // 只存指针（spec.json 已含 name/version/resolved/commit），无 content
    return { ok: true, path: dir, bytes: 0, mode: 'pointer' };
  }

  // blob-raw / blob-modified：物理复制内容
  if (!spec.sourceDir) {
    return { ok: false, path: dir, error: 'spec 缺少 sourceDir（物理来源路径）' };
  }
  const contentDir = path.join(dir, 'content');
  fs.rmSync(contentDir, { recursive: true, force: true });
  copyDir(spec.sourceDir, contentDir);
  const bytes = dirSize(contentDir);
  return { ok: true, path: dir, bytes, mode: spec.strategy, files: countFiles(contentDir) };
}

function dirSize(d) {
  let total = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}
function countFiles(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) n += countFiles(p);
    else if (e.isFile()) n++;
  }
  return n;
}

// 主入口：备份整个 profile 的插件集
// specs: PluginSpec[]（来自 scanProfile，须含 sourceDir 字段）
// pluginsRoot: <backupRoot>/plugins
function backupPlugins(specs, pluginsRoot) {
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const results = [];
  for (const spec of specs) {
    const r = backupOne(spec, pluginsRoot);
    results.push({ pkg: spec.pkg, ...r });
  }
  // 写 index.json（全量 spec + 备份结果）
  const index = { at: new Date().toISOString(), plugins: specs.map((s, i) => ({ ...s, _backup: results[i] })) };
  fs.writeFileSync(path.join(pluginsRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  return results;
}

export { backupPlugins, safeName, copyDir, fileSha256, dirSize, countFiles };
