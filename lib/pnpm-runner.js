/**
 * lib/pnpm-runner.js — pnpm 命令执行器
 *
 * 为什么不用 child_process.exec 而用 spawn：
 *  - 长任务（pnpm install）需要实时输出给 UI
 *  - Windows 下 npm/pnpm 经常带 ANSI 色码，exec 不便解析
 *  - spawn 的 stdout/stderr 可以分流给前端
 *
 * 所有方法返回 Promise<{ exitCode, stdout, stderr }>
 * 长任务可以传 onProgress 回调接收流式输出
 */

import { spawn } from 'node:child_process';

/** 检测 pnpm 是否可用 */
export function pnpmAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('pnpm', ['--version'], { shell: process.platform === 'win32' });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve({ ok: false, error: 'pnpm not found' }));
    proc.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, version: out.trim() });
      else resolve({ ok: false, error: `pnpm exit ${code}` });
    });
  });
}

/**
 * 执行 pnpm 命令
 * @param {string[]} args           pnpm 后面的参数，例如 ['install', '--prefer-offline']
 * @param {object}   options
 * @param {string}   options.cwd    工作目录（profile 根目录）
 * @param {string}   options.registry  可选，传入 --registry
 * @param {function} options.onStdout  可选，实时接收 stdout chunk (string)
 * @param {function} options.onStderr  可选，实时接收 stderr chunk
 * @returns {Promise<{exitCode, stdout, stderr, durationMs}>}
 */
export function runPnpm(args, options = {}) {
  const { cwd, registry, onStdout, onStderr } = options;
  const finalArgs = [...args];
  if (registry) {
    finalArgs.push('--registry', registry);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn('pnpm', finalArgs, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      // 让 ANSI 色码原样输出，前端判断要不要清
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onStdout) {
        try { onStdout(s); } catch { /* ignore */ }
      }
    });
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (onStderr) {
        try { onStderr(s); } catch { /* ignore */ }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`spawn pnpm failed: ${err.message}`));
    });

    proc.on('exit', (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * pnpm install（profile 目录里跑）
 */
export function install(cwd, options = {}) {
  return runPnpm(['install'], { cwd, ...options });
}

/**
 * pnpm add <spec> —— 安装新依赖到 profile
 */
export function addPackage(spec, cwd, options = {}) {
  return runPnpm(['add', spec], { cwd, ...options });
}

/**
 * pnpm remove <pkg> —— 移除依赖
 */
export function removePackage(pkg, cwd, options = {}) {
  return runPnpm(['remove', pkg], { cwd, ...options });
}

/**
 * pnpm prune —— 清掉无用依赖
 */
export function prune(cwd, options = {}) {
  return runPnpm(['prune'], { cwd, ...options });
}
