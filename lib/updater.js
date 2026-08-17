// lib/updater.js
// 插件更新检查 + 执行（dsh plugin update）
//
// 支持两类源：
//  1) GitHub 源（github:/git+ssh:/codeload tarball）—— 本地 commit vs 上游最新 commit（GitHub REST API）
//  2) npm registry 源（semver range）—— 本地已解析版本 vs registry dist-tags.latest（registry.npmjs.org）
//
// 设计：
//  - 本地状态从 pnpm-lock.yaml 的 importers → . → dependencies 解析
//  - GitHub 源：上游最新 commit 走 GitHub REST API（GET /repos/{owner}/{repo}/commits，无需 token，公共仓库）
//  - npm 源：registry 的 dist-tags.latest + 精简 semver 比较（不引依赖）
//  - 魔改标记（marks）的插件：只返回 upstreamHasUpdate:true 提醒，不提供更新（避免覆盖魔改）
//  - 执行更新走 runDsh(['plugin','--profile',profile,'update',pkg])，返回 job（前端轮询）
'use strict';

import fs from 'node:fs';
import path from 'node:path';

// ── GitHub token：加速限流（未认证 60/h，加 token 后 5000/h）──
// 读取顺序：process.env.GITHUB_TOKEN → <dataDir>/github-token（明文 .txt）
// 未设置时返回 null，调用方走未认证请求。
function readGithubToken(dataDir) {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) return process.env.GITHUB_TOKEN.trim();
  if (!dataDir) return null;
  const p = path.join(dataDir, 'github-token');
  try {
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) return t;
    }
  } catch { /* ignore */ }
  return null;
}

// 构建 GitHub fetch headers（带 token 时加速）
function ghHeaders(token) {
  const h = { 'user-agent': 'dsh-plugin-manager', accept: 'application/vnd.github+json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// 从 lockfile importers 段解析 github 插件的本地 commit
// 返回 { 'pkg': { repo: 'owner/repo', localCommit, specifier, installKind } }
function parseGithubDeps(lockText) {
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
    if (t === 'packages:') break;
    if (!inImporters) continue;
    if (indent === 2 && t === '.:') { inRootDeps = true; continue; }
    if (inRootDeps && indent === 4 && t === 'dependencies:') { continue; }
    if (inRootDeps && indent === 6 && t.endsWith(':')) {
      curName = t.slice(0, -1).replace(/^'|'$/g, '');
      deps[curName] = { specifier: '', version: '', repo: null, localCommit: null, installKind: null };
      continue;
    }
    if (inRootDeps && indent === 8 && curName && deps[curName]) {
      if (t.startsWith('specifier:')) deps[curName].specifier = t.slice(10).trim().replace(/^'|'$/g, '');
      if (t.startsWith('version:')) deps[curName].version = t.slice(8).trim().replace(/^'|'$/g, '');
    }
    if (indent < 6 && inRootDeps) { inRootDeps = false; curName = null; }
  }

  for (const [name, d] of Object.entries(deps)) {
    const v = d.version + ' ' + d.specifier;
    // git+ssh://git@github.com/owner/repo.git#commit
    let m = v.match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?#([0-9a-f]{40})/);
    // https://codeload.github.com/owner/repo/tar.gz/<commit>
    if (!m) m = v.match(/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/([0-9a-f]{40})/);
    if (m) {
      d.repo = m[1].replace(/\.git$/, '');
      d.localCommit = m[2];
      d.installKind = v.includes('codeload') ? 'github-tarball' : 'git';
    } else {
      // github:owner/repo 形式（无 commit，lock 里可能没写全）
      m = v.match(/github:([^\/]+\/[^\s#]+)/);
      if (m) d.repo = m[1].replace(/\.git$/, '');
    }
  }
  return Object.fromEntries(Object.entries(deps).filter(([, d]) => d.repo));
}

// ── npm registry 源插件版本检查 ──────────────────

// 精简 semver 解析：major.minor.patch[-prerelease]（忽略 build metadata）
// 返回 { nums: [maj,min,pat], pre: string[] } 或 null
function parseSemver(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

// 精简 semver 比较（npm 语义）：数字段数值比较，prerelease 版本 < 正式版
// 返回 a > b ? 1 : a < b ? -1 : 0；解析失败返回 0（不误报更新）
export function semverCompare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  const ha = pa.pre.length ? 1 : 0;
  const hb = pb.pre.length ? 1 : 0;
  if (ha !== hb) return ha > hb ? -1 : 1; // 有 prerelease 的版本更旧
  if (!ha) return 0;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i] ?? '';
    const y = pb.pre[i] ?? '';
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (xn) return 1;  // 数字段 > 字母段（npm 规则）
    else if (yn) return -1;
    else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 判定 specifier 是否为 npm registry 可解析的形式（semver range / 精确版本 / * / latest）
function isNpmSpecifier(spec) {
  const s = String(spec || '').trim();
  if (!s) return false;
  // 非 registry 源：link/file/github/git/http/workspace/catalog/别名
  if (/^(link:|file:|github:|git\+|https?:\/\/|workspace:|catalog:|npm:)|\.git(#|$)/.test(s)) return false;
  // semver range 或精确版本（*、^1.2.3、~1.2.3、1.2.3、>=1.0.0、latest）
  return /^[\^~<>=*.\d ]+$/.test(s) || s === 'latest';
}

// 从 lockfile importers 段读取指定 pkg 的本地已解析 version
// 用于 update 成功判定：versionBefore/After 对比决定“是否真升级了”（pnpm 可能 exit 0 但 version 未变）
export function parseLocalVersion(lockText, pkg) {
  if (!lockText || !pkg) return null;
  // 需要准确匹配包名（scoped 包含 /、带引号）
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 匹配置 importer.dependencies 下的 pkg: 块后两行（specifier: ... \n version: ...）
  const re = new RegExp(`['"]?${escaped}['"]?:\\s*\\n\\s*specifier:\\s*\\S+\\s*\\n\\s*version:\\s*(\\S+)`, 'm');
  const m = lockText.match(re);
  return m ? m[1] : null;
}

// 从 lockfile importers 段解析已解析版本（pkg → version）
function parseImporterVersions(lockText) {
  const lines = lockText.split('\n');
  const versions = {};
  let inImporters = false;
  let inRootDeps = false;
  let curName = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const indent = l.match(/^ */)[0].length;
    const t = l.trim();
    if (t === 'importers:') { inImporters = true; continue; }
    if (t === 'packages:') break;
    if (!inImporters) continue;
    if (indent === 2 && t === '.:') { inRootDeps = true; continue; }
    if (inRootDeps && indent === 4 && t === 'dependencies:') { continue; }
    if (inRootDeps && indent === 6 && t.endsWith(':')) {
      curName = t.slice(0, -1).replace(/^'|'$/g, '');
      versions[curName] = '';
      continue;
    }
    if (inRootDeps && indent === 8 && curName) {
      if (t.startsWith('version:')) versions[curName] = t.slice(8).trim().replace(/^'|'$/g, '');
    }
    if (indent < 6 && inRootDeps) { inRootDeps = false; curName = null; }
  }
  return versions;
}

// 从 lockfile packages 段解析所有已解析版本（pkg → 版本列表，含同名多版本）
// packages 段 entry 形态：`  pkg@1.0.0:` 或 `  '@scope/pkg@1.0.0':` 或 snapshot `'@scope/pkg@1.0.0_abc':`
function parsePackageVersions(lockText) {
  const versions = {};
  let inPackages = false;
  for (const l of lockText.split('\n')) {
    const t = l.trim();
    if (t === 'packages:') { inPackages = true; continue; }
    if (!inPackages) continue;
    const m = t.match(/^'?(@?[^'@:]+)@(\d+\.\d+\.\d+[^'_]*?)(?:_|['"]?\s*:)/);
    if (!m) continue;
    const name = m[1].replace(/^'|'$/g, '');
    (versions[name] ||= []).push(m[2]);
  }
  return versions;
}

// 从版本列表取 semver 最大的
function maxVersion(list) {
  if (!list?.length) return null;
  let best = list[0];
  for (const v of list) { if (semverCompare(v, best) > 0) best = v; }
  return best;
}

// 从 profile 解析 npm registry 源插件（package.json 主源 + lockfile 补版本）
// 返回 { 'pkg': { specifier, version } }（排除 github/link/file 等非 registry 源）
function parseNpmDeps(profileDir, opts = {}) {
  // 主源：package.json.dependencies（直接依赖 + specifier，不会因 lockfile 不同步而丢）
  let pkgJson = {};
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  } catch { /* package.json 缺失 → 空 */ }
  const deps = pkgJson.dependencies || {};

  // 版本来源：lockfile importers 段（准确）→ packages 段（兜底，容忍 importers 不同步）
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  const lockText = opts.lockText || (fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '');
  const importerVersions = parseImporterVersions(lockText);
  const packageVersions = parsePackageVersions(lockText);

  const out = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (!isNpmSpecifier(spec)) continue;
    const version = importerVersions[name] || maxVersion(packageVersions[name] || []);
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) continue;
    out[name] = { specifier: spec, version };
  }
  return out;
}

// 查 npm registry 最新版本
// 返回 { ok:true, latest } 或 { ok:false, error }
async function checkNpmUpdate(pkg, opts = {}) {
  const timeout = opts.timeoutMs || 8000;
  try {
    // scoped 包需要编码 @scope/pkg → @scope%2Fpkg
    const enc = pkg.startsWith('@') ? pkg.replace('/', '%2F') : pkg;
    const url = `https://registry.npmjs.org/${enc}`;
    const r = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'dsh-plugin-manager' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return { ok: false, error: `registry HTTP ${r.status}` };
    const j = await r.json();
    const latest = j['dist-tags']?.latest;
    if (!latest) return { ok: false, error: 'registry 响应缺少 dist-tags.latest' };
    return { ok: true, latest };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '请求超时' : e.message };
  }
}

// 查 GitHub 上游最新 commit
// 返回 { ok, commit, date, message } 或 { ok:false, error, rateLimitReset? }
// error 可能携带 rateLimitReset（秒级时间戳）让前端告知何时能重试
async function fetchLatestCommit(repo, opts = {}) {
  const timeout = opts.timeoutMs || 8000;
  const token = opts.token || readGithubToken(opts.dataDir);
  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=1`;
    const r = await fetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      const reset = parseInt(r.headers.get('x-ratelimit-reset') || '0', 10);
      const remaining = r.headers.get('x-ratelimit-remaining');
      if (r.status === 403 && reset > 0) {
        const waitMin = Math.ceil((reset * 1000 - Date.now()) / 60000);
        return { ok: false, error: `GitHub API 限流（未认证 60/h，加 token 后 5000/h）— 大约 ${waitMin} 分钟后恢复`, rateLimitReset: reset, rateLimitRemaining: remaining };
      }
      if (r.status === 404) return { ok: false, error: '仓库不存在或私有' };
      return { ok: false, error: `GitHub HTTP ${r.status}` };
    }
    const j = await r.json();
    const commit = j[0]?.sha;
    const date = j[0]?.commit?.committer?.date;
    const message = j[0]?.commit?.message?.split('\n')[0] || '';
    if (!commit) return { ok: false, error: '响应缺少 commit' };
    return { ok: true, commit, date, message };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '请求超时' : e.message };
  }
}

// 查上游 commit 列表（per_page=100）—— 判断本地 commit 是否还在上游 history 中
// 返回 { ok, history: [{sha, date, message}] } 或 { ok:false, error }
async function fetchUpstreamHistory(repo, opts = {}) {
  const timeout = opts.timeoutMs || 10000;
  const token = opts.token || readGithubToken(opts.dataDir);
  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=100`;
    const r = await fetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      if (r.status === 404) return { ok: false, error: '仓库不存在或私有' };
      const reset = parseInt(r.headers.get('x-ratelimit-reset') || '0', 10);
      const remaining = r.headers.get('x-ratelimit-remaining');
      if (r.status === 403 && reset > 0) {
        const waitMin = Math.ceil((reset * 1000 - Date.now()) / 60000);
        return { ok: false, error: `GitHub API 限流 — 大约 ${waitMin} 分钟后恢复`, rateLimitReset: reset, rateLimitRemaining: remaining };
      }
      return { ok: false, error: `GitHub HTTP ${r.status}` };
    }
    const j = await r.json();
    const history = Array.isArray(j) ? j.slice(0, 100).map(c => ({
      sha: c.sha,
      short: c.sha.slice(0, 12),
      date: c.commit?.committer?.date,
      message: c.commit?.message?.split('\n')[0] || '',
    })) : [];
    return { ok: true, history };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? '请求超时' : e.message };
  }
}

// 在上游 history 中查找本地 commit，返回 index（0 = 最新）
function findLocalInHistory(localCommit, history) {
  if (!localCommit) return { found: false, index: -1, historySize: history.length };
  const idx = history.findIndex(c => c.sha === localCommit);
  return { found: idx >= 0, index: idx, historySize: history.length };
}

// 主入口：检查 profile 里所有 github 插件的更新
// profileDir: 含 pnpm-lock.yaml 的目录
// opts.marks: 魔改标记 { pkg: true }
// opts.timeoutMs: 单请求超时
// opts.historyPageSize: 上游 history 拉多少条（默认 100，判断本地是否在 history）
async function checkUpdates(profileDir, opts = {}) {
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return { ok: false, error: `no pnpm-lock.yaml at ${lockPath}`, plugins: [] };

  const lockText = fs.readFileSync(lockPath, 'utf8');
  const githubDeps = parseGithubDeps(lockText);
  const npmDeps = parseNpmDeps(profileDir, { lockText });
  const plugins = [];

  // ── GitHub 源：逐个查上游（串行，避免 GitHub 限流；插件数少，足够快）──
  for (const [pkg, d] of Object.entries(githubDeps)) {
    // 只拉一次上游 history（per_page=100）：history[0] 就是最新 commit，
    // 同时还能判断本地 commit 是否还在上游 history（forked 检测）。
    // 旧实现每插件打 2 次 /commits（latest + history），60/h 限流下浪费一半配额。
    const historyResult = await fetchUpstreamHistory(d.repo, opts);
    const history = historyResult.ok ? historyResult.history : [];
    const localInHist = findLocalInHistory(d.localCommit, history);

    // upstream = history[0]（最新 commit）；history 失败时回退 fetchLatestCommit
    let upstream;
    if (historyResult.ok && history[0]) {
      upstream = { ok: true, commit: history[0].sha, date: history[0].date, message: history[0].message };
    } else {
      upstream = await fetchLatestCommit(d.repo, opts);
    }

    const isModified = !!(opts.marks && opts.marks[pkg]);
    // 状态：up-to-date / has-update / forked / check-failed
    // forked = 本地 commit 不在上游 history 中 → 你改了源码/fork 或上游 force-push 过
    let status;
    if (!upstream.ok) status = 'check-failed';
    else if (upstream.commit === d.localCommit) status = 'up-to-date';
    else if (historyResult.ok && !localInHist.found) status = 'forked';
    else status = 'has-update';

    // 落后几个 commit：仅在 has-update 时有意义（本地 commit 在 history 中）
    const commitsBehind = (status === 'has-update' && localInHist.found) ? localInHist.index : null;

    plugins.push({
      pkg,
      repo: d.repo,
      installKind: d.installKind,
      specifier: d.specifier,
      localCommit: d.localCommit,
      localCommitShort: d.localCommit ? d.localCommit.slice(0, 12) : null,
      upstream: upstream.ok ? { commit: upstream.commit, commitShort: upstream.commit.slice(0, 12), date: upstream.date, message: upstream.message } : null,
      upstreamError: upstream.ok ? null : upstream.error,
      historyError: historyResult.ok ? null : historyResult.error,
      status,              // up-to-date | has-update | forked | check-failed
      isModified,          // 魔改标记 → 只提醒不更新
      canUpdate: status === 'has-update' && !isModified,
      // 魔改检测：本地 commit 不在上游 history → 几乎肯定魔改过（也可能上游 force-push）
      likelyModified: status === 'forked',
      // 落后 commit 数（仅 has-update 且本地 commit 在 history）
      commitsBehind,
      // localCommit 在上游 history 中的提交信息（has-update 时能看到本地是何时拉的）
      localCommitInHistory: localInHist.found ? {
        index: localInHist.index,
        historySize: localInHist.historySize,
        date: history[localInHist.index]?.date,
        message: history[localInHist.index]?.message,
      } : null,
    });
  }

  // ── npm registry 源：本地已解析版本 vs dist-tags.latest（串行，registry 无 token 限流）──
  for (const [pkg, d] of Object.entries(npmDeps)) {
    const up = await checkNpmUpdate(pkg, opts);
    const isModified = !!(opts.marks && opts.marks[pkg]);
    let status;
    if (!up.ok) status = 'check-failed';
    else {
      const cmp = semverCompare(up.latest, d.version);
      // cmp > 0 → registry 有更新；cmp <= 0 → 已最新（本地相等或超前，不误报）
      status = cmp > 0 ? 'has-update' : 'up-to-date';
    }
    plugins.push({
      pkg,
      source: 'npm',
      installKind: 'npm',
      specifier: d.specifier,
      localVersion: d.version,
      upstreamVersion: up.ok ? up.latest : null,
      status,
      isModified,
      canUpdate: status === 'has-update' && !isModified,
      upstreamError: up.ok ? null : up.error,
      // npm 源没有 commit 维度，commitsBehind 无意义 → null
      commitsBehind: null,
      likelyModified: false,
    });
  }

  return {
    ok: true, plugins,
    summary: {
      hasUpdate: plugins.filter(p => p.status === 'has-update').length,
      upToDate: plugins.filter(p => p.status === 'up-to-date').length,
      forked: plugins.filter(p => p.status === 'forked').length,
      failed: plugins.filter(p => p.status === 'check-failed').length,
      modified: plugins.filter(p => p.isModified).length,
      likelyModified: plugins.filter(p => p.likelyModified).length,
      npm: Object.keys(npmDeps).length,
      github: Object.keys(githubDeps).length,
    }
  };
}

export { checkUpdates, parseGithubDeps, parseNpmDeps, fetchLatestCommit, fetchUpstreamHistory, findLocalInHistory };
