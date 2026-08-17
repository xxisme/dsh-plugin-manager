/**
 * lib/cmd-runner.js — 跨平台命令执行器（dsh / npx）
 *
 * 关键点：
 *  - windowsHide: true 隐藏 cmd 窗口
 *  - 实时 stdout/stderr 回调（前端可用 SSE/轮询拿到进度）
 *  - 不允许任意 shell 拼接，只接受参数数组
 *  - Windows 必须 shell:true（Node 20+ spawn .cmd shim 否则 EINVAL）
 *    args 数组 是参数级传递，不会被 cmd 拆词（避免 shell 注入）
 *
 * 典型用法：
 *   const job = await runDsh(args, { cwd });
 *   // job: { id, exitCode, stdout, stderr, durationMs, status }
 *
 * 2026-08-17：命令安装支持 npx 形式。
 *   设计决定：npx 命令不原样执行，而是**归一化到 dsh CLI**再跑。理由有三：
 *     1) DSH 的插件安装规范（package.json.dependencies + dsh.profile.bundles +
 *        cordis.patch.yml + pnpm install）只有 dsh CLI 自己写得全，
 *        原样跑 `npx <任意包>` 无法保证这些文件被正确落盘，dsh web 起不来；
 *     2) 原样执行 npx 等于任意代码执行，与本模块「参数白名单」的安全基线冲突；
 *     3) 本地已装的 dsh 已绑定当前 DSH_HOME，比 npx 临时拉的 CLI 更可靠。
 *   只有本地找不到 dsh 时，才真的退化去 spawn npx 拉官方 CLI（见 runNpx）。
 */

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
// 读插件配置里的 registry 覆盖。这里确实引入了对单例的隐式依赖，
// 但替代方案是给每一个 runDsh 调用点都手传 registry（十几处，漏一个就不一致）。
// plugin-context 不引用本项目任何其它模块，不会循环依赖。
import { getConfig } from './plugin-context.js';

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
 * Windows cmd 参数转义：把 '^' 变成 '^^'
 *
 * 为什么需要：cmd.exe 把 '^' 当行内转义符，解析时会吞掉一层。
 * 实测（Node v22 / Windows）：传 'pkg@^1.2.3' 给 .cmd，目标程序收到的是 'pkg@1.2.3'
 * —— semver 语义从「兼容 1.x」静默变成「锁死 1.2.3」。
 * 这是改造前就存在的 bug，不是 npx 支持引入的。
 *
 * 失败模式是安全的：万一转义无效，dsh 会收到字面的 'pkg@^^1.2.3' 并报版本非法
 * —— 可见的失败优于静默的语义篖改。
 *
 * 注意：其他 cmd 元字符（& | < > 等）不在这里处理 —— 它们在解析层
 * （parseInstallCommand）就被拒了，根本到不了 spawn。
 */
export function escapeCaretForCmd(arg) {
  return typeof arg === 'string' && arg.includes('^') ? arg.replace(/\^/g, '^^') : arg;
}

/**
 * 通用可执行文件解析（dsh / npx 共用）。
 * 理由：hana plugin 进程可能没继承到 npm 全局 prefix 的 PATH（看到过的 ENOENT bug）。
 * 顺序：
 *   1) npm config get prefix -> <prefix>/<bin>.cmd
 *   2) where <bin> (走 cmd shell) -> 第一行
 *   3) null（让调用方决定报错文案）
 *
 * @param {string} bin 可执行文件基名，如 'dsh' / 'npx'
 * @returns {string|null} 绝对路径
 */
function resolveBin(bin) {
  const tryPaths = [];
  if (process.platform === 'win32') {
    // 1) npm config get prefix（快且准）
    try {
      const prefix = execSync('npm config get prefix', {
        encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000,
      }).trim();
      const candidates = [`${bin}.cmd`, `${bin}.exe`, `${bin}.ps1`, bin];
      for (const n of candidates) {
        const p = path.join(prefix, n);
        if (fs.existsSync(p)) tryPaths.push(p);
      }
    } catch { /* npm 不可用 */ }
    // 2) where <bin>
    try {
      const out = execSync(`where ${bin}`, { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000 }).trim();
      for (const line of out.split(/\r?\n/)) {
        const l = line.trim();
        if (l && fs.existsSync(l)) tryPaths.push(l);
      }
    } catch { /* where 找不到 */ }
  } else {
    // POSIX: command -v
    try {
      const out = execSync(`command -v ${bin}`, { encoding: 'utf-8', shell: true, windowsHide: true, timeout: 5000 }).trim();
      if (out && fs.existsSync(out)) tryPaths.push(out);
    } catch { /* ignore */ }
  }

  // 去重（保留顺序）
  const seen = new Set();
  const unique = tryPaths.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  // Windows 下按扩展名优先级排序（稳定排序，同级保持来源顺序）。
  // 坑：`where npx` 第一行往往是无扩展名的 `C:\Program Files\nodejs\npx`，
  // 那是给 POSIX sh 用的脚本，cmd.exe 根本执行不了；必须挑 .cmd。
  // （dsh 之前没报错只是因为它刚好在 npm prefix 里先命中了 dsh.cmd，属于候得一命。）
  if (process.platform === 'win32') {
    const rank = (p) => ({ '.cmd': 0, '.exe': 1, '.bat': 2, '.ps1': 8 })[path.extname(p).toLowerCase()] ?? 9;
    unique.sort((a, b) => rank(a) - rank(b));
  }
  return unique[0] || null;
}

// 60s 缓存（npm prefix 不会频繁变），dsh / npx 各一份。
// 注意：**负结果（null）也要缓存**。早先写成 `hit.value &&` 才算命中，
// 导致本机没装 dsh 时每次调用都要重跑 `npm config get prefix`(≤5s) + `where dsh`(≤5s)，
// 而这两个都是 execSync——同步阻塞整个插件进程。负结果 TTL 短一点，兼顾用户中途装了 dsh 的情况。
const binCache = new Map(); // bin -> { at, value }
const BIN_TTL_OK = 60000;
const BIN_TTL_MISS = 15000;
function resolveBinCached(bin) {
  const hit = binCache.get(bin);
  if (hit) {
    const ttl = hit.value ? BIN_TTL_OK : BIN_TTL_MISS;
    if (Date.now() - hit.at < ttl) return hit.value;
  }
  const value = resolveBin(bin);
  binCache.set(bin, { at: Date.now(), value });
  return value;
}

/** 解析 dsh 可执行文件绝对路径，找不到返回 null。带 60s 缓存。 */
export function resolveDshCmd() {
  return resolveBinCached('dsh');
}

/** 解析 npx 可执行文件绝对路径，找不到返回 null。带 60s 缓存。 */
export function resolveNpxCmd() {
  return resolveBinCached('npx');
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
 * 内部：spawn 一个可执行文件并把输出灌进 job（dsh / npx 共用）
 *
 * @param {object} opts
 * @param {string} opts.label      job.cmd 展示名（'dsh' / 'npx'）
 * @param {string|null} opts.binPath  已解析的绝对路径；null 表示没找到
 * @param {string[]} opts.args     参数数组（参数级传递，不经 shell 拆词）
 * @param {string} [opts.cwd]
 * @param {string} [opts.notFoundHint] 找不到可执行文件时的补充说明
 * @param {number} [opts.timeoutMs] 硬超时，到点 kill（默认 30min）
 * @returns {Promise<object>} job
 */
function spawnJob({ label, binPath, args, cwd, notFoundHint, timeoutMs }) {
  const job = createJob();
  job.cmd = label;
  job.args = args;
  job.cwd = cwd || process.cwd();

  return new Promise((resolve) => {
    const startedAt = Date.now();

    if (!binPath) {
      const tag = `[spawn error] ${label} command not found in PATH (searched npm prefix + process.env.PATH)`
        + `${notFoundHint ? '; ' + notFoundHint : ''}; fullArgs: ${label} ${args.join(' ')}`;
      job.status = 'error';
      job.error = tag;
      job.stderr = tag;
      job.stdoutLines.push({ t: Date.now(), text: tag });
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - startedAt;
      cleanupJobs();
      return resolve(job);
    }
    job.resolvedCmd = binPath;  // 给前端 / 日志看到实际 spawn 路径

    // registry 覆盖（2026-08-17）：
    //   dsh plugin add 内部调 pnpm，但 dsh 不透传 --registry（那是 pnpm 的参数），
    //   唯一能影响它的口子是环境变量 npm_config_registry（npm/pnpm 都认）。
    //   默认空 = 不注入 = 完全跟随 .npmrc 层级（零行为变更）。
    //   用户显式填了才注入，此时探测与安装用同一个源，不会错位。
    const cfgRegistry = getConfig('registry', '');
    const extraEnv = cfgRegistry ? { npm_config_registry: cfgRegistry } : {};

    // Windows 上 Node 20+ spawn .cmd shim 必须 shell: true（不然会 EINVAL）。
    // POSIX 上保持 shell: false。
    //
    // ⚠️ 实测结论（2026-08-17，Node v22 / Windows）：
    //   shell:true 时 Node **不对参数做任何转义**，直接拼成命令行交给 cmd.exe：
    //     传 'foo&calc'    -> cmd 把 &calc 当第二条命令执行
    //     传 'foo|whoami'  -> whoami 真的被执行了
    //     传 'pkg@^1.2.3'  -> 目标程序收到 'pkg@1.2.3'（^ 被吞一层）
    //     传 'C:/T(x86)/f' -> 原样通过（括号无害，所以不应拦）
    //   换 cmd.exe /c + shell:false 行为一致；改 shell:false 直接 spawn .cmd 则 EINVAL。
    //   结论：注入防线必须放在解析层（parseInstallCommand 的元字符拦截）；
    //   '^' 这个合法但会被吞的字符，在这里按 cmd 规则转义还原。
    const safeArgs = process.platform === 'win32' ? args.map(escapeCaretForCmd) : args;

    const proc = spawn(binPath, safeArgs, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,  // 关键：不弹 cmd 窗口
      // stdin 直接给 ignore（2026-08-17 review 修）：
      // 子进程一旦交互式提问（npx 的 "Ok to proceed? (y)"、pnpm 认证、git host key），
      // 继承的 stdin 没人答 → 进程永久挂起，job 永远 running，Map 也清不掉。
      // ignore 会让它读到 EOF 直接失败退出——快速可见的失败优于无声挂死。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...extraEnv },
    });

    // 硬超时：到点 kill，避免 job 无限期占着 running 状态
    const limitMs = timeoutMs || 30 * 60 * 1000;
    const killTimer = setTimeout(() => {
      if (job.status === 'running') {
        const tag = `[timeout] 超过 ${Math.round(limitMs / 1000)}s 未结束，已终止进程`;
        job.stderr += (job.stderr ? '\n' : '') + tag;
        job.stdoutLines.push({ t: Date.now(), text: tag });
        try { proc.kill(); } catch { /* 已退出 */ }
      }
    }, limitMs);
    // Node 不要因为这个定时器而保持存活
    if (typeof killTimer.unref === 'function') killTimer.unref();

    const pushLines = (s, prefix = '') => {
      const lines = s.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        job.stdoutLines.push({ t: Date.now(), text: prefix + line });
      }
      if (job.stdoutLines.length > 200) {
        job.stdoutLines = job.stdoutLines.slice(-200);
      }
    };

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      job.stdout += s;
      pushLines(s);
    });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      job.stderr += s;
      pushLines(s, '[err] ');
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
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
      clearTimeout(killTimer);
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
 * 执行 dsh 命令
 * @param {string[]} args      dsh 后面的参数，如 ['plugin', '--profile', 'web', 'add', '@scope/pkg']
 * @param {object} options
 * @param {string} options.cwd     工作目录（可选）
 * @param {string} options.dshPath 显式指定 dsh 路径（可选）
 * @returns {Promise<object>}     job 对象
 */
export function runDsh(args, options = {}) {
  const { cwd } = options;
  // 解析 dsh 命令绝对路径：hana 进程可能没继承到 npm 全局 prefix 的 PATH，
  // 直接 spawn('dsh') 会 ENOENT。
  const dshPath = options.dshPath || resolveDshCmd();
  return spawnJob({ label: 'dsh', binPath: dshPath, args, cwd, timeoutMs: options.timeoutMs });
}

/**
 * 执行 npx 命令（仅用于本地没装 dsh 时，临时拉官方 dsh CLI 的退化路径）
 *
 * ⚠️ 安全：args 由 parseInstallCommand 白名单产出，调用方不要把用户原始字符串直接塞进来。
 *
 * @param {string[]} args   npx 后面的参数，如 ['-y', 'dsh', 'plugin', '--profile', 'web', 'add', 'pkg']
 * @param {object} options
 * @param {string} options.cwd
 * @returns {Promise<object>} job 对象
 */
export function runNpx(args, options = {}) {
  const { cwd } = options;
  const npxPath = options.npxPath || resolveNpxCmd();
  // 强制 -y（2026-08-17 review 修）：npx 首次拉包会交互式问
  // "Need to install the following packages... Ok to proceed? (y)"。
  // stdin 已经是 ignore，不加 -y 就是一次必然的失败。
  const hasYes = args.some((a) => a === '-y' || a === '--yes');
  const finalArgs = hasYes ? args : ['-y', ...args];
  return spawnJob({
    label: 'npx',
    binPath: npxPath,
    args: finalArgs,
    cwd,
    timeoutMs: options.timeoutMs,
    notFoundHint: '请先安装 Node.js（npx 随 npm 一起分发）',
  });
}

// ---------------------------------------------------------------------------
// 命令解析
// ---------------------------------------------------------------------------

// dsh CLI 的合法包名/命令名白名单。
// npx 形式可能写成 `npx dsh ...` / `npx @deepseek-ai/dsh@latest ...` / `npx -p @deepseek-ai/dsh dsh ...`
const DSH_CLI_NAMES = new Set(['dsh', '@deepseek-ai/dsh', 'deepseek-harness']);

// dsh plugin 允许的动作
const ALLOWED_ACTIONS = ['add', 'remove', 'update', 'install', 'uninstall'];

// npm 包 spec 白名单：@scope/name[@version] / name[@version] / github:owner/repo[#ref] /
// git+https://...#ref / link:path
// 版本段只允许 [\w.^~*-]：不写 > < |，因为它们在解析入口就被 shell 元字符检查拦下了，
// 写在这里只会造成「正则允许但入口拒绝」的自相矛盾（死代码）。
// semver range （>=1.0.0）本来就不该出现在安装命令里 —— README 里不会这么写。
const PKG_SPEC_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~*-]+)?$|^github:[a-z0-9-]+\/[a-z0-9._-]+(#[\w./-]+)?$|^git\+https:\/\/[^\s]+#[\w./-]+$|^link:.+$/i;

/**
 * 判断一个 token 是不是 dsh CLI（允许带版本后缀）
 * 例：dsh / dsh.cmd / dsh@latest / @deepseek-ai/dsh@1.2.3
 */
function isDshCliSpec(token) {
  if (!token) return false;
  const bare = token.toLowerCase().replace(/\.(cmd|exe|ps1)$/, '');
  // 剥版本：@scope/name@ver -> @scope/name ; name@ver -> name
  const name = bare.startsWith('@')
    ? bare.replace(/^(@[^/]+\/[^@]+)@.+$/, '$1')
    : bare.replace(/^([^@]+)@.+$/, '$1');
  return DSH_CLI_NAMES.has(name);
}

/**
 * 解析 `plugin --profile X <action> <pkg...>` 形式的参数段（dsh / npx-dsh 共用）
 *
 * @param {string[]} parts 从 'plugin' 开始的 token 数组
 * @param {string|null} fallbackProfile 命令里没写 --profile 时的兜底（UI 当前选中）
 * @returns {{ok, profile?, profileSource?, action?, package?, fullArgs?, error?}}
 */
function parsePluginArgs(parts, fallbackProfile) {
  if (parts[0] !== 'plugin') {
    return { ok: false, error: `只允许 plugin 子命令，不是 ${parts[0] || '(空)'}` };
  }

  // 重复 --profile 直接拒：静默取最后一个意味着 `--profile web --profile evil` 会装到 evil，
  // 而用户看着自己写的 web。
  let profile = null;
  let profileSeen = 0;
  const args = [];
  for (let i = 1; i < parts.length; i += 1) {
    const eq = parts[i].match(/^--profile=(.+)$/);
    if (eq) {
      profile = eq[1];
      profileSeen += 1;
      continue;
    }
    if (parts[i] === '--profile') {
      if (i + 1 >= parts.length) {
        return { ok: false, error: '--profile 后面缺少 profile 名' };
      }
      profile = parts[i + 1];
      profileSeen += 1;
      i += 1;
    } else {
      args.push(parts[i]);
    }
  }
  if (profileSeen > 1) {
    return { ok: false, error: '命令里出现了多个 --profile，请只保留一个' };
  }

  // profile 兜底：README 里的命令常写成 `dsh plugin add xxx`（不带 --profile），
  // 这时用 UI 当前选中的 profile，并在预览里标明来源，避免用户误装到别的 profile。
  let profileSource = 'command';
  if (!profile) {
    if (!fallbackProfile) return { ok: false, error: '缺少 --profile <name> 参数（也没有选中的 profile 可兜底）' };
    profile = fallbackProfile;
    profileSource = 'ui';
  }

  // profile 名验证：字母数字下划线连字符
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    return { ok: false, error: `profile 名非法: ${profile}` };
  }

  const action = args[0];
  if (!ALLOWED_ACTIONS.includes(action)) {
    return { ok: false, error: `不支持的 plugin 动作: ${action || '(空)'}，只允许 ${ALLOWED_ACTIONS.join('/')}` };
  }

  const pkgTokens = args.slice(1);
  if (pkgTokens.length === 0) return { ok: false, error: '缺少包名或路径' };

  // 包 token 校验（2026-08-17 review 补）—— 之前这里是零校验的 args.slice(1).join(' ')，
  // 后果很实在：`dsh plugin --profile web add pkg --force` 会让 '--force' 成为最后一个 token，
  // 而 routes/api.js 取 fullArgs 末尾当包名传给 autoApprovePnpmBuilds，
  // 那边会把它当 YAML key 写进 pnpm-workspace.yaml 的 allowBuilds（写坏整个 profile 的 pnpm）。
  for (const t of pkgTokens) {
    if (t.startsWith('-')) {
      return { ok: false, error: `不支持的参数 ${t}（只接受包名/路径，不接受额外 flag）` };
    }
    if (!PKG_SPEC_RE.test(t)) {
      return { ok: false, error: `包名格式非法: ${t}（仅支持 npm 包名 / github:owner/repo / link:路径）` };
    }
  }
  // 一次只装一个：多包时日志、备份、allowBuilds key 都只能记录一个，静默丢失不如拒绝
  if (pkgTokens.length > 1) {
    return { ok: false, error: `一次只能安装一个包（收到 ${pkgTokens.length} 个: ${pkgTokens.join(', ')}），请分次执行` };
  }

  const packageSpec = pkgTokens[0];

  return {
    ok: true,
    profile,
    profileSource,
    action,
    package: packageSpec,
    fullArgs: ['plugin', '--profile', profile, action, ...pkgTokens],
  };
}

// npx 的无参 flag 白名单（有参的 -p/--package 单独处理）
const NPX_BOOL_FLAGS = new Set([
  '-y', '--yes', '--no', '-q', '--quiet', '--silent',
  '--prefer-online', '--prefer-offline', '--offline',
  '--ignore-existing', '--no-install', '--install',
]);

/**
 * 解析 npx 形式的安装命令
 *
 * 支持两类：
 *   A) npx 包装的 dsh CLI —— `npx [-y] dsh plugin --profile X add <pkg>`
 *      → 剥掉 npx 外壳，等价于 dsh 命令本身（kind: 'npx-dsh'）
 *   B) npx 直接跑一个包 —— `npx [-y] @scope/some-plugin [args...]`
 *      → 按 DSH 安装规范转译为 `dsh plugin --profile <UI> add @scope/some-plugin`
 *        （kind: 'npx-pkg'），保证 package.json / bundles / cordis 由 dsh CLI 正确落盘
 *
 * @param {string[]} parts token 数组（parts[0] === 'npx'）
 * @param {string|null} fallbackProfile
 */
function parseNpxCommand(parts, fallbackProfile) {
  let i = 1;
  const npxFlags = [];
  let pkgFromFlag = null;

  while (i < parts.length && parts[i].startsWith('-')) {
    const tok = parts[i];
    // -c / --call：能塞任意 shell 字符串，直接拒绝（这是本模块最不想开的口子）
    if (tok === '-c' || tok === '--call' || tok.startsWith('--call=')) {
      return { ok: false, error: 'npx -c/--call 会执行任意 shell 命令，出于安全考虑不支持' };
    }
    const eq = tok.match(/^--package=(.+)$/);
    if (eq) {
      pkgFromFlag = eq[1];
      npxFlags.push(tok);
      i += 1;
      continue;
    }
    if ((tok === '-p' || tok === '--package') && i + 1 < parts.length) {
      pkgFromFlag = parts[i + 1];
      npxFlags.push(tok, parts[i + 1]);
      i += 2;
      continue;
    }
    if (NPX_BOOL_FLAGS.has(tok)) {
      npxFlags.push(tok);
      i += 1;
      continue;
    }
    return { ok: false, error: `不支持的 npx 参数: ${tok}（只允许 ${[...NPX_BOOL_FLAGS].join(' / ')} / -p <pkg>）` };
  }

  const rest = parts.slice(i);
  if (rest.length === 0) return { ok: false, error: 'npx 后面缺少包名' };

  // ── A 类：npx 包装的 dsh CLI ──
  // 形式1: npx dsh plugin ...        → rest[0] 是 dsh CLI
  // 形式2: npx -p @deepseek-ai/dsh dsh plugin ...  → pkgFromFlag 是 dsh CLI
  const cliIsDsh = isDshCliSpec(rest[0]) || (pkgFromFlag && isDshCliSpec(pkgFromFlag) && rest[0] === 'dsh');
  if (cliIsDsh && rest[1] === 'plugin') {
    const parsed = parsePluginArgs(rest.slice(1), fallbackProfile);
    if (!parsed.ok) return parsed;
    return {
      ...parsed,
      kind: 'npx-dsh',
      // 本地有 dsh 就直接用本地的（更快、且已绑定当前 DSH_HOME）；
      // 没有才退化真跑 npx —— npxArgs 保留原样外壳供退化使用
      npxArgs: [...npxFlags, rest[0], ...parsed.fullArgs],
      note: '已识别为 npx 包装的 dsh 命令，将直接用本地 dsh 执行（本地无 dsh 时退化为 npx 拉取官方 CLI）',
    };
  }
  if (cliIsDsh) {
    return { ok: false, error: `npx dsh 后面只允许 plugin 子命令，不是 ${rest[1] || '(空)'}` };
  }

  // ── B 类：npx 直跑一个包 → 按 DSH 规范转译成 dsh plugin add ──
  const pkg = pkgFromFlag || rest[0];
  if (!PKG_SPEC_RE.test(pkg)) {
    return { ok: false, error: `包名格式非法（仅支持 npm 包名 / github:owner/repo / link:path）: ${pkg}` };
  }
  if (!fallbackProfile) {
    return { ok: false, error: 'npx 命令里没有 --profile，请先在左侧选中一个 profile' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(fallbackProfile)) {
    return { ok: false, error: `profile 名非法: ${fallbackProfile}` };
  }

  // 包名后面跟的额外参数（如 `npx foo install`）在转译时会被丢弃 —— 必须显式告知用户，
  // 否则会出现「我明明写了 install，它却只 add 了包」的困惑。
  const droppedArgs = pkgFromFlag ? rest : rest.slice(1);

  return {
    ok: true,
    kind: 'npx-pkg',
    profile: fallbackProfile,
    profileSource: 'ui',
    action: 'add',
    package: pkg,
    fullArgs: ['plugin', '--profile', fallbackProfile, 'add', pkg],
    droppedArgs,
    note: `将按 DSH 安装规范执行：dsh plugin --profile ${fallbackProfile} add ${pkg}`
      + '（由 dsh CLI 写 package.json / dsh.profile.bundles / cordis.patch.yml 并跑 pnpm install，'
      + '保证装完 DeepSeek Harness 能正常启动）',
    warnings: droppedArgs.length
      ? [`原命令里的额外参数会被忽略：${droppedArgs.join(' ')}（dsh 安装规范只需要包名）`]
      : [],
  };
}

/**
 * 统一解析用户粘贴的安装命令（dsh / npx）
 *
 * 安全规则（对两种形式都生效）：
 *  - 首 token 必须是 dsh 或 npx
 *  - 只支持 plugin 子命令 / 只允许 add/remove/update/install/uninstall
 *  - profile 名与包名走白名单字符集
 *  - 一律不做 shell 字符串拼接，产出的是参数数组
 *
 * @param {string} cmdStr 用户粘贴的原始命令
 * @param {object} [options]
 * @param {string|null} [options.fallbackProfile] 命令没写 --profile 时的兜底（UI 当前选中）
 * @returns {{ok, kind?, profile?, profileSource?, action?, package?, fullArgs?, npxArgs?, note?, warnings?, error?}}
 */
export function parseInstallCommand(cmdStr, options = {}) {
  const fallbackProfile = options.fallbackProfile || null;
  if (typeof cmdStr !== 'string') return { ok: false, error: '命令必须是字符串' };
  const trimmed = cmdStr.trim();
  if (!trimmed) return { ok: false, error: '命令为空' };

  // 安全：整行字符白名单。
  //
  // 为什么是白名单而不是黑名单（2026-08-17 review 改）：
  // 实测（Node v22 / Windows）证实 Node 在 shell:true 下 **不转义参数**，
  // 直接拼命令行交给 cmd.exe：传 'foo|whoami' 会真的执行 whoami。
  // 所以这里是真实的注入防线。早先用黑名单 [&|;`$<>%] 漏了 " ! ' 等字符，
  // 黑名单永远漏，白名单只会误伤——而误伤能给出明确提示。
  //
  // 允许集的来源（每一个都有真实用例，不是拍脑袋）：
  //   A-Za-z0-9  包名/profile 名
  //   @ / -  _  .  作用域包名 @scope/pkg、路径分隔
  //   :  \        link:C:\path 与 github: 前缀
  //   ^ ~ * +      semver range（^1.2.3 / ~1.2 / 1.x）与 git+https
  //   #            github:owner/repo#ref
  //   =            --profile=web
  //   ( )          Windows 路径常带（Tools(x86)），实测传给 cmd 原样通过，拦它是误伤
  //   空格         token 分隔
  const ILLEGAL_CHAR_RE = /[^A-Za-z0-9@/\\:._+#=~^() -]/;
  const bad = trimmed.match(ILLEGAL_CHAR_RE);
  if (bad) {
    const ch = bad[0];
    const hint = {
      '&': '（不支持 && 串联）',
      '|': '（不支持管道）',
      ';': '（不支持 ; 串联）',
      '>': '（不支持重定向；semver range 请用 ^ ~ 写法）',
      '<': '（不支持重定向；semver range 请用 ^ ~ 写法）',
      '%': '（cmd 会展开 %VAR%）',
      '$': '（shell 会做命令替换）',
      '`': '（shell 会做命令替换）',
      '"': '（不支持引号；带空格的路径请改用「本地 zip」入口）',
      "'": '（不支持引号）',
      '\n': '（只接受单行命令）',
      '\r': '（只接受单行命令）',
    }[ch] || '（不在允许的字符集内）';
    return { ok: false, error: `命令含不允许的字符 ${JSON.stringify(ch)}${hint}` };
  }

  // 用简单 tokenizer（不去引号内的空格，避免引号转义复杂度）
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return { ok: false, error: '命令太短' };

  const first = parts[0].toLowerCase().replace(/\.cmd$|\.exe$|\.ps1$/, '');

  if (first === 'npx') {
    const r = parseNpxCommand(parts, fallbackProfile);
    return r.ok ? { warnings: [], ...r } : r;
  }

  if (first === 'dsh') {
    const parsed = parsePluginArgs(parts.slice(1), fallbackProfile);
    if (!parsed.ok) return parsed;
    return { ...parsed, kind: 'dsh', warnings: [] };
  }

  return { ok: false, error: `只支持 dsh / npx 开头的命令（不是 ${parts[0]}）` };
}

/**
 * 兼容旧调用：只解析 dsh 命令。
 * 行为与改造前一致（不传 fallbackProfile 时缺 --profile 直接报错）。
 * @deprecated 新代码用 parseInstallCommand
 */
export function parseDshCommand(cmdStr, options = {}) {
  const r = parseInstallCommand(cmdStr, options);
  if (r.ok && r.kind !== 'dsh') {
    return { ok: false, error: '此入口只接受 dsh 命令' };
  }
  return r;
}
