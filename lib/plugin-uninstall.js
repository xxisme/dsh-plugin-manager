// lib/plugin-uninstall.js — 深度卸载：7 落点扫描 + 清理
//
// DSH 插件在磁盘上的落点（除 pnpm/dsh 自动清理的 1–4 外，5–7 需要手工）：
//   1) package.json 的 dependencies            → pnpm remove / dsh plugin remove
//   2) package.json 的 dsh.profile.bundles     → removeBundle() 显式清
//   3) pnpm-lock.yaml                          → pnpm remove 重写
//   4) node_modules/<pkg>                       → pnpm remove 删
//   5) node_modules/.pnpm/<pkg>@<hash> CAS     → 本模块扫描 + 清理（lockfile 已无引用才删）
//   6) ~/.dsh/runtime/<profile>/ 运行时缓存    → 本模块扫描 + 清理（按插件名匹配）
//   7) ~/.dsh/{skills,mcp,plugins}/<pkg> 旁路  → 本模块扫描 + 清理（精确匹配）
//
// 另：profiles/<profile>/external/ 下的孤儿目录（link 安装残留 / zip 解压残留 /
//     .pre-restore 还原前快照）也由本模块负责扫描与清理。

import fs from 'node:fs';
import path from 'node:path';

// ── 工具 ──────────────────────────────────────────

// 插件名变体：id（dependencies key）+ package.json.name + 尾部短名（去 scope）+ 去 dsh- 前缀（cordis id 风格）
// 例如 @anionex/dsh-vision-toolkit → ['@anionex/dsh-vision-toolkit', 'anionex+dsh-vision-toolkit', 'dsh-vision-toolkit', 'vision-toolkit']
// 运行时缓存常按 cordis id 命名（dsh-usage-stats 包 → usage-stats-state.json），所以必须有短名变体
const PREFIXES = ['dsh-', '@dsh-external/', 'dsh-external-'];
export function nameVariants(id, packageJson) {
  const set = new Set([id]);
  if (packageJson?.name && typeof packageJson.name === 'string') set.add(packageJson.name);
  for (const n of [...set]) {
    if (n.startsWith('@') && n.includes('/')) {
      set.add(n.slice(1).replace('/', '+')); // pnpm .pnpm 目录形态
      set.add(n.split('/').pop()); // 尾部短名
    }
    for (const p of PREFIXES) {
      if (n.startsWith(p)) set.add(n.slice(p.length)); // 去前缀（cordis id 风格）
    }
  }
  return [...set];
}

function dirSize(dir) {
  try {
    let size = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) size += dirSize(full);
      else if (e.isFile()) size += fs.statSync(full).size;
    }
    return size;
  } catch { return 0; }
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── 扫描 ──────────────────────────────────────────

/**
 * 扫描卸载残留（不删除）
 * @param {object} opts
 * @param {string} opts.dshHome
 * @param {string} opts.profile
 * @param {string} opts.id - dependencies key（bundle 名）
 * @param {object} [opts.packageJson] - 插件自己的 package.json（拿 name）
 * @returns {{cas: object[], runtime: object[], bypass: object[]}}
 */
export function scanUninstallResidues({ dshHome, profile, id, packageJson }) {
  const profDir = path.join(dshHome, 'profiles', profile);
  const names = nameVariants(id, packageJson);
  const residues = { cas: [], runtime: [], bypass: [] };

  // 落点 5: node_modules/.pnpm/<pkg>@<hash>
  const pnpmDir = path.join(profDir, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmDir)) {
    const lockText = fs.existsSync(path.join(profDir, 'pnpm-lock.yaml'))
      ? fs.readFileSync(path.join(profDir, 'pnpm-lock.yaml'), 'utf8')
      : '';
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry === 'lock.yaml') continue;
      // .pnpm 条目形态: pkg@1.0.0_hash 或 @scope+pkg@1.0.0_hash
      const m = entry.match(/^(.+?)@[\w.+-]+/);
      if (!m) continue;
      const base = m[1].replace(/\+/g, '/').replace(/^@\//, '@'); // scope+pkg → @scope/pkg
      if (!names.some((n) => base === n)) continue;
      // 保守：只要 lockfile 里还能找到 <pkg>@ 字样（还被引用/没删干净）就不清 CAS，避免删坏其他依赖
      if (lockText.includes(base + '@')) continue;
      residues.cas.push({ kind: 'cas', path: path.join(pnpmDir, entry), entry, size: dirSize(path.join(pnpmDir, entry)) });
    }
  }

  // 落点 6: ~/.dsh/runtime/<profile>/
  const runtimeDir = path.join(dshHome, 'runtime', profile);
  if (fs.existsSync(runtimeDir)) {
    for (const item of fs.readdirSync(runtimeDir)) {
      const full = path.join(runtimeDir, item);
      const st = fs.statSync(full);
      if (names.some((n) => item === n || item.includes(n))) {
        residues.runtime.push({
          kind: 'runtime',
          path: full,
          entry: item,
          isDir: st.isDirectory(),
          size: st.isDirectory() ? dirSize(full) : st.size,
        });
      }
    }
  }

  // 落点 7: ~/.dsh/{skills,mcp,plugins}/<pkg>（精确匹配插件名）
  for (const dir of ['skills', 'mcp', 'plugins']) {
    const bypassDir = path.join(dshHome, dir);
    if (!fs.existsSync(bypassDir)) continue;
    for (const item of fs.readdirSync(bypassDir)) {
      if (!names.some((n) => item === n)) continue;
      const full = path.join(bypassDir, item);
      const st = fs.statSync(full);
      residues.bypass.push({
        kind: 'bypass',
        path: full,
        entry: item,
        dir, // skills | mcp | plugins
        isDir: st.isDirectory(),
        size: st.isDirectory() ? dirSize(full) : st.size,
      });
    }
  }

  return residues;
}

/**
 * 扫描 external/ 孤儿目录（未被 dependencies 引用 / 明显残留命名）
 * @returns {object[]} [{path, entry, size, reason}]
 */
export function scanExternalOrphans({ dshHome, profile }) {
  const profDir = path.join(dshHome, 'profiles', profile);
  const externalDir = path.join(profDir, 'external');
  if (!fs.existsSync(externalDir)) return [];

  let refs = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profDir, 'package.json'), 'utf8'));
    refs = Object.values(pkg.dependencies || {}).filter((v) => typeof v === 'string');
  } catch { /* package.json 读不到就当无引用 */ }

  const orphans = [];
  for (const item of fs.readdirSync(externalDir)) {
    const full = path.join(externalDir, item);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;

    const isReferenced = refs.some((v) => v.includes('external/' + item) || v.includes('external\\' + item));
    // .pre-restore-*（还原前快照）和纯数字前缀（zip 解压临时目录）= 明显历史残留
    const isResiduePattern = /\.pre-restore-/i.test(item) || /^\d+[-_]/.test(item);

    if (!isReferenced || isResiduePattern) {
      orphans.push({
        path: full,
        entry: item,
        size: dirSize(full),
        reason: isReferenced ? '历史残留（zip 解压/还原快照）' : '未被 dependencies 引用',
      });
    }
  }
  return orphans;
}

// ── 清理 ──────────────────────────────────────────

/**
 * 按清单清理残留
 * @param {object} opts
 * @param {object} opts.residues - scanUninstallResidues 或 {cas,runtime,bypass} 结构
 * @param {boolean} [opts.dryRun] - true 只返回将删除的清单，不真删
 * @returns {{removed: object[], skipped: object[], errors: object[]}}
 */
export function cleanResidues({ residues, dryRun = false }) {
  const result = { removed: [], skipped: [], errors: [] };
  const groups = residues.cas ? residues : { cas: [], runtime: [], bypass: [], external: [] };
  const all = [
    ...(groups.cas || []),
    ...(groups.runtime || []),
    ...(groups.bypass || []),
    ...(residues.external || []),
  ];
  for (const it of all) {
    if (!fs.existsSync(it.path)) {
      result.skipped.push({ ...it, reason: 'already gone' });
      continue;
    }
    if (dryRun) {
      result.removed.push({ ...it, dryRun: true });
      continue;
    }
    try {
      fs.rmSync(it.path, { recursive: true, force: true });
      result.removed.push(it);
    } catch (e) {
      result.errors.push({ ...it, error: e.message });
    }
  }
  return result;
}

export { fmtSize };
