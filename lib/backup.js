/**
 * lib/backup.js — Profile 备份与恢复
 *
 * 在每次写操作前自动备份三件套 + cordis.patch.yml
 * 备份路径：${HANA_HOME}/plugins-dev-runs/dsh-plugin-manager/backups/<timestamp>/
 */

import fs from 'node:fs';
import path from 'node:path';
import { profileDir } from './dsh-profile.js';

const BACKUP_FILES = [
  'package.json',
  'cordis.yml',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
];

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

export function backupRoot(dataDir) {
  return path.join(dataDir, 'backups');
}

/**
 * 创建一次 profile 备份
 * @returns {string} 备份目录绝对路径
 */
export function backupProfile(dataDir, dshHome, profileName) {
  const root = profileDir(dshHome, profileName);
  if (!fs.existsSync(root)) throw new Error(`profile 不存在: ${profileName}`);

  const dir = path.join(backupRoot(dataDir), `${timestamp()}-${profileName}`);
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
 * 清理超过 keepLimit 的旧备份（按时间倒序保留前 N 个）
 */
export function cleanupOldBackups(dataDir, keepLimit = 20) {
  const list = listBackups(dataDir);
  const toRemove = list.slice(keepLimit);
  for (const b of toRemove) {
    try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return toRemove.length;
}
