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
async function fetchLatestCommit(repo, opts = {}) {
  const timeout = opts.timeoutMs || 8000;
  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=1`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'dsh-plugin-manager', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
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

// 主入口：检查 profile 里所有 github 插件的更新
// profileDir: 含 pnpm-lock.yaml 的目录
// opts.marks: 魔改标记 { pkg: true }
// opts.timeoutMs: 单请求超时
async function checkUpdates(profileDir, opts = {}) {
  const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) return { ok: false, error: `no pnpm-lock.yaml at ${lockPath}`, plugins: [] };

  const githubDeps = parseGithubDeps(fs.readFileSync(lockPath, 'utf8'));
  const plugins = [];

  // 逐个查上游（串行，避免 GitHub 限流；插件数少，足够快）
  for (const [pkg, d] of Object.entries(githubDeps)) {
    const upstream = await fetchLatestCommit(d.repo, opts);
    const isModified = !!(opts.marks && opts.marks[pkg]);
    const status = upstream.ok
      ? (upstream.commit === d.localCommit ? 'up-to-date' : 'has-update')
      : 'check-failed';

    plugins.push({
      pkg,
      repo: d.repo,
      installKind: d.installKind,
      specifier: d.specifier,
      localCommit: d.localCommit,
      localCommitShort: d.localCommit ? d.localCommit.slice(0, 12) : null,
      upstream: upstream.ok ? { commit: upstream.commit, commitShort: upstream.commit.slice(0, 12), date: upstream.date, message: upstream.message } : null,
      upstreamError: upstream.ok ? null : upstream.error,
      status,              // up-to-date | has-update | check-failed
      isModified,          // 魔改标记 → 只提醒不更新
      canUpdate: status === 'has-update' && !isModified,
    });
  }

  return { ok: true, plugins, summary: { hasUpdate: plugins.filter(p => p.status === 'has-update').length, upToDate: plugins.filter(p => p.status === 'up-to-date').length, failed: plugins.filter(p => p.status === 'check-failed').length, modified: plugins.filter(p => p.isModified).length } };
}

export { checkUpdates, parseGithubDeps, fetchLatestCommit };
