// lib/github-installer.js — 从 GitHub 页面分析推荐 install 命令
//
// 流程：用户输入 GitHub URL → 抓 README → 匹配 install 命令模式 → 返回推荐 + 备选

const README_PATHS = ['README.md', 'README_EN.md', 'readme.md', 'docs/README.md'];

/**
 * 从 GitHub URL 提取 owner/repo
 * 接受：https://github.com/owner/repo, https://github.com/owner/repo/tree/...
 */
export function parseGithubUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.match(/^(www\.)?github\.com$/i)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch { return null; }
}

// 抓取 README 内容（GitHub raw）。多个候选路径，默认 branch 从页面 HTML 推断（main / master / 其他）
async function fetchReadme(owner, repo) {
  const headers = {
    'user-agent': 'dsh-plugin-manager',
    accept: 'application/vnd.github+json',
  };
  // 先用 GitHub API 拿默认分支
  let defaultBranch = 'main';
  try {
    const apiRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(10000) });
    if (apiRes.ok) {
      const j = await apiRes.json();
      if (j.default_branch) defaultBranch = j.default_branch;
    }
  } catch { /* ignore */ }

  // 尝试 raw 多个路径
  const candidates = [];
  for (const path of README_PATHS) {
    candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${path}`);
    candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/master/${path}`);
    candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`);
  }
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 50) return { text, url, branch: url.includes('/main/') ? 'main' : (url.includes('/master/') ? 'master' : defaultBranch) };
      }
    } catch { /* ignore */ }
  }
  return null;
}

// 从 README 文本里提取 install 命令候选
// 优先级：
//   1) dsh plugin ... add <pkg>   ← 最优（官方，CLI 自动处理 bundle 注册）
//   2) npx ... dsh plugin ... add  ← 同上但用 npx
//   3) npm install / pnpm add <pkg> ← 次之（需要手动注册 bundle）
//   4) curl | bash / irm | iex install script  ← 第三方安装脚本
export function extractInstallCommands(readmeText) {
  const candidates = [];
  const lines = readmeText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 抓 ``` 块内命令（GitHub markdown code fence）
    // 这里只看单行命令就够（README 命令都独立成行）
    if (trimmed.startsWith('dsh plugin')) {
      candidates.push({
        type: 'dsh-cli',
        priority: 1,
        command: trimmed,
        detail: '官方 CLI 安装，bundle 自动注册',
      });
    } else if (trimmed.startsWith('npx ') && trimmed.includes('dsh plugin')) {
      candidates.push({
        type: 'npx-dsh',
        priority: 1,
        command: trimmed,
        detail: 'npx 拉官方 dsh CLI 安装',
      });
    } else if (/^(npm i|npm install|pnpm add|pnpm i)\b/.test(trimmed)) {
      candidates.push({
        type: 'pkg-manager',
        priority: 2,
        command: trimmed,
        detail: '包管理器直接装，需要手动 addBundle',
      });
    } else if (/^curl\s.*\|\s*(bash|sh)\b/.test(trimmed)) {
      candidates.push({
        type: 'curl-script',
        priority: 3,
        command: trimmed,
        detail: '第三方安装脚本（macOS/Linux）',
      });
    } else if (/^irm\s.*\|\s*iex\b/.test(trimmed)) {
      candidates.push({
        type: 'irm-script',
        priority: 3,
        command: trimmed,
        detail: '第三方安装脚本（Windows PowerShell）',
      });
    }
  }
  // 去重（同一命令只保留一次）+ 排序（priority 低在前 = 优）
  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    const key = c.command;
    if (!seen.has(key)) { seen.add(key); uniq.push(c); }
  }
  uniq.sort((a, b) => a.priority - b.priority);
  return uniq;
}

/**
 * 一站式：给定 GitHub URL，返回分析结果
 * @param {string} url
 * @returns {Promise<{ok, owner?, repo?, recommended?, alternatives?, readmeSnippet?, error?}>}
 */
export async function analyzeGithubRepo(url) {
  const parsed = parseGithubUrl(url);
  if (!parsed) return { ok: false, error: '不是有效的 GitHub 仓库 URL' };
  const { owner, repo } = parsed;

  const readme = await fetchReadme(owner, repo);
  if (!readme) return { ok: false, owner, repo, error: '找不到 README.md（仓库可能没有 README，或网络问题）' };

  const commands = extractInstallCommands(readme.text);
  if (!commands.length) return { ok: false, owner, repo, error: 'README 里没找到 install 命令' };

  return {
    ok: true,
    owner,
    repo,
    readmeUrl: readme.url,
    readmeSnippet: readme.text.slice(0, 500),
    recommended: commands[0],
    alternatives: commands.slice(1, 6), // 最多展示 5 个备选
    allCommands: commands,
  };
}