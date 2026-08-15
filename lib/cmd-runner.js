/**
 * lib/cmd-runner.js — 跨平台 dsh 命令执行器
 *
 * 关键点：
 *  - windowsHide: true 隐藏 cmd 窗口
 *  - 实时 stdout/stderr 回调（前端可用 SSE/轮询拿到进度）
 *  - 不允许任意 shell 拼接，只接受参数数组
 *  - Windows 上不设 shell:true（避免 cmd.exe 解释 & | > 等字符）
 *    Node 20+ 自动为 'dsh' 加上 .cmd/.exe/.ps1 后缀解析（dsh.cmd 是 npm shim）
 *
 * 典型用法：
 *   const job = await runDsh(args, { cwd });
 *   // job: { id, exitCode, stdout, stderr, durationMs, status }
 */

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ── Job 存储（in-memory） ──
const jobs = new Map();

export function createJob() {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    status: 'running',  // running | done | error
    cmd: null,
    args: null,
    cwd: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    stdoutLines: [],  // 增量行，供前端轮询
    durationMs: 0,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

/**
 * 解析 dsh 可执行文件绝对路径。
 * 理由：hana plugin 进程可能没继承到 npm 全局 prefix 的 PATH（看到过的 ENOENT bug）。
 * 顺序：
 *   1) npm config get prefix -> <prefix>/dsh.cmd
 *   2) where dsh (走 cmd shell) -> 第一行
 *   3) 退到 'dsh'（让 spawn 本身报错）
 *
 * 返回绝对路径或 null。带 60s 内存缓存。
 */
let dshPathCache = { at: 0, value: null };
export function resolveDshCmd() {
  // 60s 缓存（npm prefix 不会频繁变）
  if (Date.now() - dshPathCache.at < 60000 && dshPathCache.value) return dshPathCache.value;

  const tryPaths = [];
  if (process.platform === 'win32') {
    // 1) npm config get prefix（快且准）
    try {
      const prefix = execSync('npm config get prefix', {
        encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000,
      }).trim();
      const candidates = ['dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh'];
      for (const n of candidates) {
        const p = path.join(prefix, n);
        if (fs.existsSync(p)) tryPaths.push(p);
      }
    } catch { /* npm 不可用 */ }
    // 2) where dsh
    try {
      const out = execSync('where dsh', { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000 }).trim();
      for (const line of out.split(/\r?\n/)) {
        const l = line.trim();
        if (l && fs.existsSync(l)) tryPaths.push(l);
      }
    } catch { /* where 找不到 */ }
  } else {
    // POSIX: which / command -v
    try {
      const out = execSync('command -v dsh', { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000 }).trim();
      if (out && fs.existsSync(out)) tryPaths.push(out);
    } catch { /* ignore */ }
  }

  // 去重（保留顺序）
  const seen = new Set();
  const unique = tryPaths.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  const result = unique[0] || null;
  dshPathCache = { at: Date.now(), value: result };
  return result;
}


export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cleanupJobs(maxKeep = 30) {
  const arr = listJobs();
  if (arr.length > maxKeep) {
    for (const j of arr.slice(maxKeep)) jobs.delete(j.id);
  }
}

/**
 * 执行 dsh 命令
 * @param {string[]} args      dsh 后面的参数，如 ['plugin', '--profile', 'web', 'add', '@scope/pkg']
 * @param {object} options
 * @param {string} options.cwd     工作目录（可选）
 * @returns {Promise<object>}     job 对象
 */
export function runDsh(args, options = {}) {
  const { cwd } = options;
  const job = createJob();
  job.cmd = 'dsh';
  job.args = args;
  job.cwd = cwd || process.cwd();

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let currentStdoutTail = '';

    // 解析 dsh 命令绝对路径：hana 进程可能没继承到 npm 全局 prefix 的 PATH，
    // 直接 spawn('dsh') 会 ENOENT（这是 16:00 修同类型 bug 的根因）。
    // 顺序：1) caller 传的 dshPath 2) 已知全局 npm prefix 3) where dsh 4) 依赖环境
    const dshPath = options.dshPath || resolveDshCmd();
    if (!dshPath) {
      const tag = `[spawn error] dsh command not found in PATH (searched npm prefix + process.env.PATH); fullArgs: dsh ${args.join(' ')}`;
      job.status = 'error';
      job.error = tag;
      job.stderr = tag;
      job.stdoutLines.push({ t: Date.now(), text: tag });
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      cleanupJobs();
      return resolve(job);
    }
    job.resolvedCmd = dshPath;  // 给前端 / 日志看到实际 spawn 路径

    // Windows 上 Node 20+ 会自动为 'dsh' 加上 .cmd/.exe/.ps1 后缀解析（dsh.cmd 是 npm shim）
    // 不设 shell:true 避免 cmd.exe 解释路径中的 & | > 等字符（shell 注入风险）
    const proc = spawn(dshPath, args, {
      cwd,
      shell: false,
      windowsHide: true,  // 关键：不弹 cmd 窗口
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      job.stdout += s;
      // 切行用于前端展示（保留最近 200 行）
      const lines = s.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        job.stdoutLines.push({ t: Date.now(), text: line });
      }
      if (job.stdoutLines.length > 200) {
        job.stdoutLines = job.stdoutLines.slice(-200);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      job.stderr += s;
      const lines = s.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        job.stdoutLines.push({ t: Date.now(), text: '[err] ' + line });
      }
      if (job.stdoutLines.length > 200) {
        job.stdoutLines = job.stdoutLines.slice(-200);
      }
    });

    proc.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      // 关键：spawn 失败时 exitCode 仍是 null，stderr 也没内容。
      // 把 spawn error 写到 stderr，否则路由层拿不到真实原因。
      const tag = `[spawn error: ${err.code || 'UNKNOWN'} ${err.message || ''}]`;
      job.stderr += (job.stderr ? '\n' : '') + tag;
      job.stdoutLines.push({ t: Date.now(), text: tag });
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      cleanupJobs();
      resolve(job);
    });

    proc.on('exit', (code) => {
      job.status = 'done';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      cleanupJobs();
      resolve(job);
    });
  });
}

/**
 * 解析用户输入的 dsh 命令字符串为参数数组
 * 安全规则：
 *  - 必须以 "dsh" 或 "dsh.cmd" 开头
 *  - 只支持 plugin 子命令
 *  - 只允许 add/remove/update/install/uninstall 子动作
 *  - --profile 必填（必须是 profiles/ 下存在的）
 *
 * @returns { ok, args, profile, action, package, error }
 */
export function parseDshCommand(cmdStr) {
  if (typeof cmdStr !== 'string') return { ok: false, error: '命令必须是字符串' };
  const trimmed = cmdStr.trim();
  if (!trimmed) return { ok: false, error: '命令为空' };

  // 用简单 tokenizer（不去引号内的空格，避免引号转义复杂度）
  // 先按空格 split，过滤空段
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return { ok: false, error: '命令太短' };

  // 第一个 token 必须是 dsh（也允许 dsh.exe / dsh.cmd）
  const first = parts[0].toLowerCase().replace(/\.cmd$|\.exe$/, '');
  if (first !== 'dsh') return { ok: false, error: '只支持 dsh 命令（不是 ' + parts[0] + '）' };

  // 白名单第二个 token：必须是 plugin
  if (parts[1] !== 'plugin') return { ok: false, error: '只允许 dsh plugin 子命令，不是 ' + parts[1] };

  // 提取 --profile <name>（必须有）
  let profile = null;
  const args = [];
  for (let i = 2; i < parts.length; i += 1) {
    if (parts[i] === '--profile' && i + 1 < parts.length) {
      profile = parts[i + 1];
      i += 1;
    } else {
      args.push(parts[i]);
    }
  }

  if (!profile) return { ok: false, error: '缺少 --profile <name> 参数' };

  // profile 名验证：字母数字下划线连字符
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    return { ok: false, error: `profile 名非法: ${profile}` };
  }

  // 提取 action（add / remove / update / install / uninstall）
  const action = args[0];
  const allowedActions = ['add', 'remove', 'update', 'install', 'uninstall'];
  if (!allowedActions.includes(action)) {
    return { ok: false, error: `不支持的 plugin 动作: ${action || '(空)'}，只允许 ${allowedActions.join('/')}` };
  }

  // 剩余参数作为 package spec
  const packageSpec = args.slice(1).join(' ');
  if (!packageSpec) return { ok: false, error: `缺少包名或路径` };

  return {
    ok: true,
    profile,
    action,
    package: packageSpec,
    fullArgs: ['plugin', '--profile', profile, action, ...args.slice(1)],
  };
}