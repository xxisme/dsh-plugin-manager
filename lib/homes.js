/**
 * lib/homes.js — DSH_HOME 解析与切换
 *
 * 候选来源（按优先级）：
 *   1. process.env.DSH_HOME（环境变量，hana 进程级）
 *   2. ~/.dsh（传统默认）
 *   3. ~/.hanako/plugin-data/<pluginId>/dsh-home/（hana 插件隔离 home，递归扫描所有 plugin）
 *   4. 用户在 plugin settings / 状态文件里手动添加的路径
 *
 * 当前 home 选择持久化到 ${ctx.dataDir}/current-home.json。
 * 没设置时 fallback 到「探测顺序里第一个存在」的候选。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 判断路径是否是有效 DSH home（必须含 profiles 子目录）
 */
function isValidDshHome(p) {
  if (!p) return false;
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory() &&
      fs.existsSync(path.join(p, 'profiles'));
  } catch { return false; }
}

/**
 * 探测所有候选 home
 * @param {string} [dataDir] plugin data dir（用户自定义 home 的持久化位置）
 * @returns {{current: string|null, candidates: Array<{path, label, source, exists}>}}
 */
export function detectHomes(dataDir) {
  const candidates = [];

  // 1. env DSH_HOME
  const envHome = process.env.DSH_HOME;
  if (envHome) {
    candidates.push({
      path: envHome,
      label: `env: ${path.basename(envHome)}`,
      source: 'env',
      exists: isValidDshHome(envHome),
    });
  }

  // 2. ~/.dsh（传统默认）
  const defaultHome = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
    : path.join(os.homedir(), '.dsh');
  if (!candidates.find((c) => c.path === defaultHome)) {
    candidates.push({
      path: defaultHome,
      label: `默认 home（${defaultHome}）`,
      source: 'default',
      exists: isValidDshHome(defaultHome),
    });
  }

  // 3. hana 插件隔离 home：扫描 ~/.hanako/plugin-data/*/dsh-home/
  const pluginDataDir = path.join(os.homedir(), '.hanako', 'plugin-data');
  if (fs.existsSync(pluginDataDir)) {
    try {
      for (const entry of fs.readdirSync(pluginDataDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidateDshHome = path.join(pluginDataDir, entry.name, 'dsh-home');
        if (!candidates.find((c) => c.path === candidateDshHome) && fs.existsSync(candidateDshHome)) {
          candidates.push({
            path: candidateDshHome,
            label: `${entry.name} 隔离 home`,
            source: `plugin:${entry.name}`,
            exists: isValidDshHome(candidateDshHome),
          });
        }
      }
    } catch { /* ignore */ }
  }

  // 4. 用户自定义（持久化在 plugin-data/dsh-plugin-manager/custom-homes.json）
  const custom = readCustomHomes(dataDir);
  for (const p of custom) {
    if (!candidates.find((c) => c.path === p)) {
      candidates.push({
        path: p,
        label: `自定义：${path}`,
        source: 'custom',
        exists: isValidDshHome(p),
      });
    }
  }

  // 读当前选定（持久化）
  const current = readCurrentHome(dataDir);

  // current 可能是 null 或失效的路径 → fallback
  let finalCurrent = null;
  if (current && isValidDshHome(current)) {
    finalCurrent = current;
  } else {
    // 选第一个 exists 的
    const first = candidates.find((c) => c.exists);
    finalCurrent = first ? first.path : null;
  }

  return { current: finalCurrent, candidates };
}

/**
 * 解析「当前选定的 DSH_HOME」。所有路由调这里而不是探测 env。
 */
export function getCurrentDshHome(dataDir) {
  const { current } = detectHomes(dataDir);
  return current;
}

/**
 * 切换当前 home。返回新的当前 home 路径（写入失败时抛错）。
 */
export function setCurrentDshHome(dataDir, newHome) {
  if (!newHome || typeof newHome !== 'string') throw new Error('dshHome 必须是字符串路径');
  // 不强求 isValidDshHome（允许切到一个新建的空路径，让用户能初始化）
  if (!fs.existsSync(newHome)) {
    // 不存在但允许（用户可能正在新建），但要警告
    fs.mkdirSync(newHome, { recursive: true });
    fs.mkdirSync(path.join(newHome, 'profiles'), { recursive: true });
  }
  const stateFile = path.join(dataDir, 'current-home.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ dshHome: newHome, updatedAt: new Date().toISOString() }, null, 2));
  return newHome;
}

/**
 * 添加用户自定义 home
 */
export function addCustomDshHome(dataDir, customPath) {
  if (!customPath) throw new Error('路径不能为空');
  const abs = path.resolve(customPath);
  const list = readCustomHomes(dataDir);
  if (!list.includes(abs)) {
    list.push(abs);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'custom-homes.json'), JSON.stringify(list, null, 2));
  }
  return abs;
}

function readCurrentHome(dataDir) {
  if (!dataDir) return null;
  const f = path.join(dataDir, 'current-home.json');
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return j.dshHome || null;
  } catch { return null; }
}

function readCustomHomes(dataDir) {
  if (!dataDir) return [];
  const f = path.join(dataDir, 'custom-homes.json');
  if (!fs.existsSync(f)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}