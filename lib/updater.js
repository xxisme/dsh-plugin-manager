// lib/updater.js
// GitHub 源插件更新检查 + 执行（dsh plugin update）
//
// 背景：dsh-plugin-manager 管理的插件有一部分来自 GitHub（github:/git+ssh:/codeload tarball）。
// 用户不上传 GitHub 但会拉取，所以"上游有更新"是可以自动检测的。
//
// 设计：
//  - 本地 commit 从 pnpm-lock.yaml 的 importers → . → dependencies 解析（git+ssh:#commit / tar.gz/<commit>）
//  - 上游最新 commit 走 GitHub REST API（GET /repos/{owner}/{repo}/commits?per_page=1，无需 token，公共仓库）
//  - 对比 commit → 有更新 / 已最新 / 检查失败（网络/仓库不存在）
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

  const githubDeps = parseGithubDeps(fs.readFileSync(lockPath, 'utf8'));
  const plugins = [];

  // 逐个查上游（串行，避免 GitHub 限流；插件数少，足够快）
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

  return {
    ok: true, plugins,
    summary: {
      hasUpdate: plugins.filter(p => p.status === 'has-update').length,
      upToDate: plugins.filter(p => p.status === 'up-to-date').length,
      forked: plugins.filter(p => p.status === 'forked').length,
      failed: plugins.filter(p => p.status === 'check-failed').length,
      modified: plugins.filter(p => p.isModified).length,
      likelyModified: plugins.filter(p => p.likelyModified).length,
    }
  };
}

export { checkUpdates, parseGithubDeps, fetchLatestCommit, fetchUpstreamHistory, findLocalInHistory };
