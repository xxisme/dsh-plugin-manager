// lib/workspace.js
// 工作区快照：备份 dsh-workspace/ 整个目录（魔改/自研/zip/bat/脚本 资产库）
//
// 背景：用户不上传 GitHub，魔改/自研代码（token-tracker、补丁脚本、dsh 源码 zip 等）
// 都在 dsh-workspace/ 下，独立于任何 profile。这些是"重装/迁移必须还原"的资产。
//
// 设计：
//  - 复用 v2 的 PluginSpec + backupPlugins/restorePlugins 体系
//  - 每个顶层条目（目录或文件）生成一个 spec：strategy=blob-raw（物理原样存）
//  - 目录条目 → copyDir（排除 node_modules/.git）；文件条目 → 直接复制
//  - 备份落盘 <dataDir>/backups-v2/workspace/<timestamp>/
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupPlugins } from './plugin-backup.js';

// 扫描工作区：每个顶层条目 → PluginSpec（blob-raw）
// wsDir: dsh-workspace 路径（或用户指定的任意目录）
function scanWorkspace(wsDir) {
  if (!fs.existsSync(wsDir)) {
    return { ok: false, error: `工作区不存在: ${wsDir}`, entries: [] };
  }
  const entries = [];
  for (const e of fs.readdirSync(wsDir, { withFileTypes: true })) {
    const full = path.join(wsDir, e.name);
    const isFile = e.isFile();
    const isDir = e.isDirectory();
    if (!isFile && !isDir) continue; // 跳过 symlink 顶层（罕见，避免循环）
    const spec = {
      pkg: e.name,
      installKind: isDir ? 'folder' : 'file',
      strategy: 'blob-raw',        // 工作区一切条目都物理备份（无上游可重拉）
      kind: isDir ? 'folder' : 'file',
      sourceDir: full,
      localVersion: null,
      isSymlink: false,
      exists: true,
      fingerprint: null,
      fingerprintShort: null,
      fileCount: isDir ? 0 : 1,
    };
    entries.push(spec);
  }
  return { ok: true, workspaceDir: wsDir, entries };
}

// 备份整个工作区 → <backupRoot>/workspace/<timestamp>/
// 复用 backupPlugins（把 entries 当 plugins）
function backupWorkspace(wsDir, backupRoot, opts = {}) {
  const scan = scanWorkspace(wsDir);
  if (!scan.ok) return { ok: false, error: scan.error };
  const results = backupPlugins(scan.entries, backupRoot);
  return { ok: true, workspaceDir: wsDir, results };
}

export { scanWorkspace, backupWorkspace };
