// lib/plugin-scanner.js
// 扫描 DSH profile，对每个直接依赖（插件）分类 → PluginSpec[]
//
// 设计依据（2026-08-16 备份 v2 对齐）：
//  - 插件清单 = pnpm-lock.yaml 的 importers → . → dependencies（直接依赖），
//    不是 node_modules 全部条目（那包含大量传递依赖，pnpm 能重装）
//  - 三策略：
//      pointer       → 能从上游重拉的纯净包（npm registry / GitHub 源）
//      blob-raw      → 本地物理物（link 目录 / zip 包 / patch 文件），原样存
//      blob-modified → 魔改/自研源码，存完整 tar.gz + sha256（用户标记或指纹变化触发）
//  - 魔改检测：目录指纹（sha256 of [path:hash] 排序列表），二次备份指纹变化 → 建议升级 blob
//  - symlink 插件（如 @anionex/dsh-vision-toolkit → dsh-workspace/...）：指纹按真实目标算，
//    备份时必须连同 symlink 目标内容一起打包，否则还原后断链
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 解析 pnpm-lock.yaml 的 importers → . → dependencies（最小 YAML 解析，够用）──
// 返回 { 'pkgName': { specifier, version } }（version 是 lock 里解析后的 install spec）
function parseLockDeps(lockText) {
  const lines = lockText.split('\n');
  const deps = {};
  let inImporters = false;
  let inRootDeps = false;
  let curName = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.match(/^ */)[0].length;
    const t = l.trim();
    if (t === 'importers:') { inImporters = true; continue; }
    if (t === 'packages:') break; // importers 段结束
    if (!inImporters) continue;
    if (indent === 2 && t === '.:') { inRootDeps = true; continue; }
    if (inRootDeps && indent === 4 && t === 'dependencies:') { continue; }
    if (inRootDeps && indent === 6 && t.endsWith(':')) {
      curName = t.slice(0, -1).replace(/^'|'$/g, '');
      deps[curName] = { specifier: '', version: '' };
      continue;
    }
    if (inRootDeps && indent === 8 && curName && deps[curName]) {
      if (t.startsWith('specifier:')) deps[curName].specifier = t.slice(10).trim().replace(/^'|'$/g, '');
      if (t.startsWith('version:')) deps[curName].version = t.slice(8).trim().replace(/^'|'$/g, '');
    }
    if (indent < 6 && inRootDeps) { inRootDeps = false; curName = null; }
  }
  return deps;
}

// ── 判定安装方式：link / git / github-tarball / github / registry ──
function classifyInstall(version, specifier) {
  const v = version + ' ' + specifier;
  if (v.includes('link:') || v.includes('file:')) return 'link';
  if (v.includes('git+ssh:') || v.includes('git+https:') || v.includes('git@')) return 'git';
  if (v.includes('codeload.github.com') || v.includes('/tar.gz/')) return 'github-tarball';
  if (v.includes('github:')) return 'github';
  return 'registry';
}

// ── 目录指纹：所有文件 [相对路径:sha256] 排序后整体 sha256 ──
// 排除 node_modules/.git/.bin/.cache 等噪音；symlink 只记目标路径不追入（防循环）
function dirFingerprint(dir, opts = {}) {
  const skipDirs = new Set(['node_modules', '.git', '.bin', '.cache', '__pycache__']);
  const files = [];
  function walk(d, rel) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const full = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) files.push(r);
      else if (e.isSymbolicLink()) files.push(r + '@symlink:' + (fs.readlinkSync(full) || ''));
    }
  }
  walk(dir, '');
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f + '\n');
    try { h.update(fs.readFileSync(path.join(dir, f))); }
    catch (e) { h.update('<unreadable>'); }
  }
  return { hash: h.digest('hex'), fileCount: files.length };
}

// 计算单个文件 sha256
function fileSha256(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ── 主入口：扫描 profile → PluginSpec[] ──
// profileDir: 含 pnpm-lock.yaml + node_modules 的目录
// opts.marks: 用户标记的魔改包集合 { pkgName: true }（来自 UI / install-manifest）
function scanProfile(profileDir, opts = {}) {
  const marks = opts.marks || {};
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  const nmPath = path.join(profileDir, 'node_modules');
  if (!fs.existsSync(lockPath)) {
    return { ok: false, error: `no pnpm-lock.yaml at ${lockPath}`, plugins: [] };
  }

  const deps = parseLockDeps(fs.readFileSync(lockPath, 'utf8'));
  const plugins = [];

  for (const [name, d] of Object.entries(deps)) {
    const installKind = classifyInstall(d.version, d.specifier);
    const rel = name.startsWith('@') ? name.split('/').join(path.sep) : name;
    const pkgDir = path.join(nmPath, rel);

    let isSymlink = false;
    let localVersion = null;
    let exists = false;
    let realTarget = null;
    let scanDir = null;

    try {
      const st = fs.lstatSync(pkgDir);
      isSymlink = st.isSymbolicLink();
      if (isSymlink) {
        realTarget = fs.realpathSync(pkgDir);
        scanDir = realTarget;
        exists = fs.existsSync(path.join(realTarget, 'package.json'));
      } else {
        scanDir = pkgDir;
        exists = fs.existsSync(path.join(pkgDir, 'package.json'));
      }
      if (exists) {
        const pj = JSON.parse(fs.readFileSync(path.join(scanDir, 'package.json'), 'utf8'));
        localVersion = pj.version || null;
      }
    } catch (e) { /* 未安装或损坏 */ }

    // 初始策略（用户标记魔改 → 升级 blob-modified）
    // 未安装（lockfile 有但 node_modules 无）→ 无法物理备份，按 pointer（重装时从上游拉）
    let strategy;
    if (!exists) strategy = 'pointer';
    else if (marks[name]) strategy = 'blob-modified';
    else if (installKind === 'link') strategy = 'blob-raw';
    else strategy = 'pointer'; // registry / git / github-tarball 都能从上游重拉

    let fp = null;
    if (scanDir && exists) fp = dirFingerprint(scanDir);

    plugins.push({
      pkg: name,
      installKind,
      strategy,
      lockSpecifier: d.specifier,
      lockVersion: d.version,
      localVersion,
      isSymlink,
      symlinkTarget: realTarget,
      sourceDir: scanDir, // 物理复制来源（symlink 时为 realpath 目标，否则为 node_modules/<pkg>）
      exists,
      fingerprint: fp ? fp.hash : null,
      fingerprintShort: fp ? fp.hash.slice(0, 16) : null,
      fileCount: fp ? fp.fileCount : 0,
    });
  }

  return { ok: true, profileDir, lock: { directDeps: Object.keys(deps).length }, plugins };
}

export { scanProfile, parseLockDeps, classifyInstall, dirFingerprint, fileSha256 };
