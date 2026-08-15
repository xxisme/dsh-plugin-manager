/**
 * lib/plugin-context.js — 插件运行时上下文单例
 *
 * 为什么需要这个：
 *   hana 的 tools/*.js 只给 execute(input)，不给 ctx 参数。
 *   但我们的工具需要知道 dshHome、dataDir、log 等上下文。
 *   解决方案：onload 时把 ctx 存到这个单例，工具从这里读。
 *
 * 这是典型的"为运行时兼容而做的妥协"——一个干净的设计应该每个调用都传 ctx，
 * 但工具的约束是不传，那就只能共享状态。
 */

let _dshHome = null;
let _dataDir = null;
let _log = null;
let _configGet = null; // function(key) -> value

export function setContext({ dshHome, dataDir, log, configGet }) {
  if (dshHome !== undefined) _dshHome = dshHome;
  if (dataDir !== undefined) _dataDir = dataDir;
  if (log !== undefined) _log = log;
  if (configGet !== undefined) _configGet = configGet;
}

export function getDshHome() {
  return _dshHome;
}

export function getDataDir() {
  return _dataDir;
}

export function getLog() {
  return _log || console;
}

export function getConfig(key, fallback = null) {
  try {
    if (typeof _configGet === 'function') {
      const v = _configGet(key);
      return v !== undefined && v !== null ? v : fallback;
    }
  } catch { /* ignore */ }
  // 最后兜底：从环境变量
  const envKey = `DSH_PLUGIN_${key.toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey];
  return fallback;
}
