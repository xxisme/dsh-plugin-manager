/**
 * lib/backup.js — Profile 备份与恢复
 *
 * 在每次写操作前自动备份三件套 + cordis.patch.yml
 * 备份路径：${HANA_HOME}/plugins-dev-runs/dsh-plugin-manager/backups/<timestamp>/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { profileDir } from './dsh-profile.js';

const BACKUP_FILES = [
  'package.json',
  'cordis.yml',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
];

/**
 * 解析插件数据目录。优先用 ctx.dataDir，fallback 到 hana 约定的 plugin-data 目录。
 * 原因：plugin_dev_install 后 dev slot 被自动 promote，ctx.dataDir 可能指向 dev slot 之外的临时路径，
 *      但磁盘上真的备份在 ${HANA_HOME}/plugin-data/dsh-plugin-manager/backups/
 */
function resolveDataDir(ctxDataDir) {
  // 1. ctx.dataDir 非空且目录存在 → 优先用（不管里面有没有 backups/，首次备份会创建）
  if (ctxDataDir && fs.existsSync(ctxDataDir) && fs.statSync(ctxDataDir).isDirectory()) {
    return ctxDataDir;
  }
  // 2. hana 约定的 plugin-data 目录
  const hanaHome = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
  const candidate = path.join(hanaHome, 'plugin-data', 'dsh-plugin-manager');
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  // 3. 都找不到 → 走 ctx.dataDir（写入时尽可能是有效路径）
  return ctxDataDir || candidate;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

/**
 * 生成不冲突的备份目录名。timestamp 是秒级精度，同秒内多次备份（自动+手动连点）会碰撞，
 * 碰撞时追加毫秒后缀保证唯一，避免互相覆盖。
 */
function uniqueBackupDirName(root, profileName) {
  const base = `${timestamp()}-${profileName}`;
  if (!fs.existsSync(path.join(root, base))) return base;
  const ms = String(Date.now() % 1000).padStart(3, '0');
  const candidate = `${base}-${ms}`;
  if (!fs.existsSync(path.join(root, candidate))) return candidate;
  // 极端：同秒+同毫秒，追加序号
  for (let i = 2; i < 100; i++) {
    const c = `${base}-${ms}-${i}`;
    if (!fs.existsSync(path.join(root, c))) return c;
  }
  return `${base}-${Date.now()}`;
}

export function backupRoot(dataDir) {
  return path.join(resolveDataDir(dataDir), 'backups');
}

/**
 * 创建一次 profile 备份
 * @param {boolean} [manual] 手动备份标记（写进 meta，用于 UI 区分手动/自动）
 * @returns {string} 备份目录绝对路径
 */
export function backupProfile(dataDir, dshHome, profileName, manual = false) {
  const root = profileDir(dshHome, profileName);
  if (!fs.existsSync(root)) throw new Error(`profile 不存在: ${profileName}`);

  const dir = path.join(backupRoot(dataDir), uniqueBackupDirName(backupRoot(dataDir), profileName));
  fs.mkdirSync(dir, { recursive: true });

  const copied = [];
  for (const f of BACKUP_FILES) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, f));
      copied.push(f);
    }
  }

  // 写一个 meta 文件描述这次备份
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      profile: profileName,
      timestamp: new Date().toISOString(),
      files: copied,
      manual: !!manual,
    }, null, 2)
  );

  return dir;
}

/**
 * 从备份恢复
 */
export function restoreProfile(dataDir, backupDir, dshHome, profileName) {
  if (!fs.existsSync(backupDir)) throw new Error(`备份目录不存在: ${backupDir}`);
  const root = profileDir(dshHome, profileName);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  const restored = [];
  for (const f of BACKUP_FILES) {
    const src = path.join(backupDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(root, f));
      restored.push(f);
    }
  }
  return restored;
}

/**
 * 列出所有备份
 */
export function listBackups(dataDir) {
  const root = backupRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      let meta = null;
      const metaPath = path.join(dir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
      }
      return { name: e.name, dir, meta };
    })
    .sort((a, b) => b.name.localeCompare(a.name)); // 倒序，新的在前
}

/**
 * 更新一条备份的备注（写入 meta.json 的 note 字段）
 * @returns {boolean} 成功与否
 */
export function updateBackupNote(backupDir, note) {
  if (!backupDir || !fs.existsSync(backupDir)) return false;
  const metaPath = path.join(backupDir, 'meta.json');
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
  }
  meta.note = String(note == null ? '' : note);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return true;
}

/**
 * 删除一条备份（目录 + 全部内容）
 * @returns {boolean} 成功与否
 */
export function deleteBackup(backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) return false;
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 清理超过 keepLimit 的旧备份（按时间倒序保留前 N 个）
 */
export function cleanupOldBackups(dataDir, keepLimit = 10) {
  const list = listBackups(dataDir);
  const toRemove = list.slice(keepLimit);
  for (const b of toRemove) {
    try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return toRemove.length;
}
