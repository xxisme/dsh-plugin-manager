/**
 * lib/pkg-probe.js — npm 包名探测：这个包到底是不是一个 DSH 插件？
 *
 * 为什么需要：「命令安装」tab 支持 `npx <pkg>` 时，我们把它转译成
 * `dsh plugin --profile X add <pkg>`。但 npx 的语义是"跑一个 CLI"，
 * 它后面的包**未必是插件本体**——也可能是个安装器脚本、或者干脆是打错的名字。
 * 转译成 dsh add 之后就会装错东西，或者跑完一整轮 pnpm install 才发现包不存在。
 *
 * 所以在执行前先查一次 registry 的包元数据，做三态判定（不是布尔）：
 *   dsh-plugin  → 有明确的 DSH/cordis 特征，放行
 *   unknown     → 包存在，但看不出是 DSH 插件，要用户确认
 *   not-found   → registry 上没这个包，直接拒（装了必然失败）
 *   probe-failed→ 网络/超时，不阻断（可能是内网或离线），只给警告
 *
 * 设计取舍：宁可 unknown 也不误杀。DSH 插件生态没有强制元数据规范，
 * 判定依据只能是「特征聚合」，一刀切成布尔必然误伤。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const PROBE_TIMEOUT_MS = 5000;

// 60s 结果缓存：预览阶段探一次、执行阶段再探一次，不该打两次网络
const cache = new Map(); // key: `${registry}|${pkg}` -> { at, result }
const CACHE_TTL_MS = 60000;

// ---------------------------------------------------------------------------
// registry 解析：探测必须跟随「实际装包会用的那个 registry」
// ---------------------------------------------------------------------------
//
// 为什么这件事要单独处理（2026-08-17 修正）：
//   dsh plugin add 内部调 pnpm，pnpm 的 registry 由 .npmrc 层级决定
//   （项目目录 .npmrc > 用户 ~/.npmrc > 全局 > 内置默认），
//   而**不是**本插件配置里那个 registry 字段。
//   如果探测查 npmmirror、实际装包走 npmjs.org，就会出现
//   「探测说有但装不上」/「探测说没有其实能装」——
//   一个替另一个服务器背书的把关，比不把关更害人。
//
// 解析策略：在 profile 目录下跑 `npm config get registry`——
// npm 会自己按作用域层级合并 .npmrc，一条命令拿到真相，比我们自己逐层解析可靠。
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const registryCache = new Map(); // cwd -> { at, value }

/**
 * 解析某个目录下实际生效的 npm registry
 * @param {string} [cwd] profile 目录；不传则取全局配置
 * @returns {string} 形如 https://registry.npmjs.org（已去尾斜杠）
 */
export function resolveEffectiveRegistry(cwd) {
  // cwd 不存在时就是在插件进程 cwd 下跑的，结果跟这个目录无关，
  // 不能拿它当 key 缓存（否则目录建好后 60s 内会一直返回那个错值）。
  const usable = cwd && fs.existsSync(cwd) ? cwd : null;
  const key = usable || '(global)';
  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = DEFAULT_REGISTRY;
  let resolved = false;
  try {
    const out = execSync('npm config get registry', {
      cwd: usable || undefined,
      encoding: 'utf-8',
      shell: true,
      windowsHide: true,
      timeout: 5000,
    }).trim();
    if (/^https?:\/\//i.test(out)) {
      value = out.replace(/\/+$/, '');
      resolved = true;
    }
  } catch { /* npm 不可用 → 用官方默认，但不缓存 */ }

  // 只缓存真正解析成功的结果。
  // 否则一次偶发的 execSync 失败会把「官方默认源」钉在缓存里 60s，
  // 而真实安装走的是用户镜像——这正是本模块发誓要避免的「探测源 ≠ 安装源」。
  if (resolved) registryCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * 从 npm spec 里拆出 包名 / 版本
 * 例：@scope/pkg@1.2.3 -> { name: '@scope/pkg', version: '1.2.3' }
 *     pkg             -> { name: 'pkg', version: null }
 */
export function splitPkgSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return { name: '', version: null };
  if (s.startsWith('@')) {
    // @scope/name[@version]
    const slash = s.indexOf('/');
    if (slash < 0) return { name: s, version: null };
    const at = s.indexOf('@', slash);
    if (at < 0) return { name: s, version: null };
    return { name: s.slice(0, at), version: s.slice(at + 1) };
  }
  const at = s.indexOf('@');
  if (at <= 0) return { name: s, version: null };
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

/**
 * 判定一份 package.json 是否具备 DSH 插件特征
 *
 * ❗ 重要前提：这里用的字段（dsh / keywords / dependencies）**全部由发包者自由填写**。
 * 它回答的是「这个包自称是 DSH 插件吗」，不是「这个包安全吗」。
 * 任何人都可以发一个 keywords 写了 dsh 的包。UI 措辞必须体现这一点。
 *
 * @returns {{ verdict: 'dsh-plugin'|'unknown', signals: string[], weak: string[] }}
 */
export function judgeDshFeatures(pj) {
  const signals = [];   // 强/中信号：命中则判定为 DSH 插件
  const weak = [];      // 弱信号 / 反向证据

  // ── 强信号：dsh 字段（dsh-profile.js 读的就是 pj.dsh.bundle.patch）──
  if (pj?.dsh?.bundle) signals.push('package.json 有 dsh.bundle 字段（标准 DSH bundle 声明）');
  else if (pj?.dsh) signals.push('package.json 有 dsh 字段');

  // ── 中信号：cordis / dsh 相关依赖 ──
  const allDeps = {
    ...(pj?.dependencies || {}),
    ...(pj?.peerDependencies || {}),
    ...(pj?.devDependencies || {}),
  };
  const depHit = Object.keys(allDeps).filter((d) =>
    d === 'cordis' || d.startsWith('@cordisjs/') || d.startsWith('@deepseek-ai/dsh'));
  if (depHit.length) signals.push(`依赖了 ${depHit.slice(0, 3).join('、')}（cordis/DSH 运行时）`);

  // ── 中信号：keywords ──
  const kws = (pj?.keywords || []).map((k) => String(k).toLowerCase());
  const kwHit = kws.filter((k) => ['dsh', 'cordis', 'deepseek', 'deepseek-harness', 'dsh-plugin'].includes(k));
  if (kwHit.length) signals.push(`keywords 含 ${kwHit.join('、')}`);

  // ── 弱信号：包名带 dsh 前缀（约定俗成，但不足以判定）──
  const name = String(pj?.name || '');
  if (/(^|\/)dsh-/.test(name) || /-dsh(-|$)/.test(name)) {
    weak.push(`包名 ${name} 符合 DSH 插件命名习惯`);
  }

  // ── 反向证据：有 bin = 它是个 CLI，npx 跑它通常是「执行命令」而不是「装插件本体」──
  // 这条必须能**降级**正信号（2026-08-17 review 修）：
  // 早先 bin 只写进 weak、不参与 verdict，于是一个「带 bin 且 keywords 有 dsh 的安装器」
  // —— 正是这个探测器发明出来要防的那一类 —— 会被判绿一路放行。
  // 负面证据不能被正面证据盖过去。
  const hasBin = !!pj?.bin;
  if (hasBin) {
    weak.push('包带 bin（是个 CLI 工具）——npx 跑它通常是执行命令，未必是装插件本体');
  }

  return {
    verdict: (signals.length > 0 && !hasBin) ? 'dsh-plugin' : 'unknown',
    signals,
    weak,
  };
}

/**
 * 探测一个 npm 包是不是 DSH 插件
 *
 * @param {string} spec 包 spec（可带版本）。github:/link:/file: 会被跳过（registry 上查不到）
 * @param {object} [opts]
 * @param {string} [opts.registry] 显式指定 registry（用户在插件设置里填了才传）
 * @param {string} [opts.cwd] profile 目录；不传 registry 时从这里解析实际生效的源
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{verdict, pkg, version?, signals, weak, registry?, description?, error?, skipped?}>}
 *   verdict: 'dsh-plugin' | 'unknown' | 'not-found' | 'probe-failed' | 'skipped'
 */
export async function probeDshPackage(spec, opts = {}) {
  // 优先用调用方显式指定的 registry；否则跟随实际安装源（.npmrc 层级解析）。
  // 关键：绝不在这里写死一个镜像地址——探测源必须 == 安装源。
  const registry = String(opts.registry || resolveEffectiveRegistry(opts.cwd)).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;

  // 非 registry 源不探测：github:/link:/file: 的元数据不在 npm 上
  if (/^(github:|link:|file:|git\+|https?:\/\/)/i.test(spec)) {
    return { verdict: 'skipped', pkg: spec, signals: [], weak: [], registry, skipped: '非 npm registry 源，跳过探测' };
  }

  const { name, version } = splitPkgSpec(spec);
  if (!name) return { verdict: 'probe-failed', pkg: spec, signals: [], weak: [], registry, error: '包名为空' };

  // 版本段处理（2026-08-17 review 修）：
  // registry 的 /{pkg}/{version} 端点只认**精确版本或 dist-tag**，不认 semver range。
  // 早先直接把 version 拼进 URL，导致 `npx pkg@^1.0.0` 变成 GET /pkg/^1.0.0
  // → 404 → 判 not-found → 前端硬拒。一条完全合法的命令装不了。
  // 策略：range 一律降级查 latest（元数据特征不会因版本而变），并在结果里标明。
  const isExact = version && /^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version);
  const isTag = version && /^[a-z][\w-]*$/i.test(version);
  const versionForUrl = (isExact || isTag) ? version : 'latest';
  const rangeDowngraded = !!version && versionForUrl !== version;

  // scoped 包名里的 / 必须保留（registry 认 /@scope/pkg），但其余字符要编码，
  // 否则换个不那么宽容的私有 registry 就会 400。
  const encName = name.split('/').map(encodeURIComponent).join('/');

  const cacheKey = `${registry}|${name}|${versionForUrl}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  // registry 的版本文档端点直接返回该版本完整 package.json，
  // 比 packument 省流量，且含 keywords / dsh / dependencies 全字段。
  // 注意：不能用 abbreviated packument（application/vnd.npm.install-v1+json），那个会剥掉 keywords 和自定义字段。
  const url = `${registry}/${name}/${version || 'latest'}`;

  let result;
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-manager' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 404) {
      result = {
        verdict: 'not-found',
        pkg: name,
        version,
        registry,
        signals: [],
        weak: [],
        error: `registry 上找不到包 ${name}${version ? '@' + version : ''}（源：${registry}）`,
      };
    } else if (!r.ok) {
      result = { verdict: 'probe-failed', pkg: name, version, registry, signals: [], weak: [], error: `registry HTTP ${r.status}` };
    } else {
      const pj = await r.json();
      const judged = judgeDshFeatures(pj);
      result = {
        verdict: judged.verdict,
        pkg: pj.name || name,
        version: pj.version || version || null,
        description: pj.description || null,
        registry,
        rangeDowngraded,
        signals: judged.signals,
        weak: judged.weak,
      };
    }
  } catch (e) {
    // 超时 / DNS / 离线：不阻断安装，只降级为警告
    result = {
      verdict: 'probe-failed',
      pkg: name,
      version,
      registry,
      signals: [],
      weak: [],
      error: e.name === 'TimeoutError' ? `探测超时（${timeoutMs}ms）` : e.message,
    };
  }

  cache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** 给前端/日志用的一句话摘要 */
export function probeSummary(probe) {
  if (!probe) return '';
  switch (probe.verdict) {
    case 'dsh-plugin':
      return `✅ 确认是 DSH 插件：${probe.signals[0] || ''}`;
    case 'unknown':
      return `❓ 包存在但看不出 DSH 插件特征${probe.weak.length ? '（' + probe.weak[0] + '）' : ''}`;
    case 'not-found':
      return `❌ ${probe.error}`;
    case 'probe-failed':
      return `⚠️ 探测失败（${probe.error}），已跳过把关`;
    case 'skipped':
      return `➖ ${probe.skipped}`;
    default:
      return '';
  }
}
