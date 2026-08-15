/**
 * index.js — dsh-plugin-manager 生命周期入口
 *
 * 职责：
 *  - onload: 探测 DSH_HOME，初始化数据目录，注册 Agent tools
 *  - onunload: 清理
 *
 * 设计要点：
 *  - 状态全部写入 dataDir，Hana 重启后能恢复
 *  - 工具注册通过 ctx.registerTool() 手动注册
 *  - 把 ctx 同步给 plugin-context 单例，让工具在执行时能拿 dshHome/dataDir/log
 */

import fs from 'node:fs';
import path from 'node:path';
import { setContext } from './lib/plugin-context.js';

const LOG_FILE = 'operations.log';
const TMP_DIR = 'tmp';

// 工具定义列表
const TOOL_DEFINITIONS = [
  './tool-modules/dsh-list-profiles.js',
  './tool-modules/dsh-list-plugins.js',
  './tool-modules/dsh-install-plugin.js',
  './tool-modules/dsh-uninstall-plugin.js',
  './tool-modules/dsh-toggle-plugin.js',
];

function detectDshHome(configValue) {
  if (configValue && fs.existsSync(configValue)) return configValue;
  if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.USERPROFILE || '', '.dsh')]
    : [
        path.join(process.env.HOME || '', '.dsh'),
        path.join(process.env.HOME || '', '.config', 'dsh'),
      ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export default class DshPluginManager {
  constructor() {
    this._dshHome = null;
    this._dataDir = null;
    this._log = console;
    this._toolDisposers = [];
    this._toolModules = new Map();
  }

  async onload(ctx) {
    this.ctx = ctx || {};
    const dataDir = this.ctx.dataDir
      || process.env.HANA_PLUGIN_DATA_DIR
      || (process.env.HANA_HOME ? path.join(process.env.HANA_HOME, 'plugin-data', 'dsh-plugin-manager') : null);
    this._dataDir = dataDir;
    this._log = this.ctx.log || console;

    this._dshHome = detectDshHome(process.env.DSH_PLUGIN_DSH_HOME || null);
    if (this._dshHome) {
      this._log.info(`[dsh-plugin-manager] DSH_HOME = ${this._dshHome}`);
    } else {
      this._log.warn('[dsh-plugin-manager] 未检测到 DSH_HOME');
    }

    if (dataDir) {
      try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const logPath = path.join(dataDir, LOG_FILE);
        if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf-8');
      } catch (e) {
        this._log.warn(`[dsh-plugin-manager] dataDir init failed: ${e.message}`);
      }
    }

    setContext({
      dshHome: this._dshHome,
      dataDir: this._dataDir,
      log: this._log,
      configGet: (key) => {
        try { return this.ctx.config?.get?.(key); } catch { return undefined; }
      },
    });

    await this._syncTools();
  }

  async _syncTools() {
    if (typeof this.ctx.registerTool !== 'function') {
      this._log.warn?.('[dsh-plugin-manager] ctx.registerTool 不可用');
      return;
    }
    for (const p of TOOL_DEFINITIONS) {
      try {
        const tool = await import(p);
        this._toolModules.set(p, tool);
        const dispose = this.ctx.registerTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: (input = {}, runtimeCtx = {}) =>
            tool.execute(input, { ...this.ctx, ...(runtimeCtx || {}) }),
        });
        if (typeof dispose === 'function') this._toolDisposers.push(dispose);
        this._log.info?.(`[dsh-plugin-manager] registered: ${tool.name}`);
      } catch (err) {
        this._log.warn?.(`[dsh-plugin-manager] failed to load ${p}: ${err.message}`);
      }
    }
  }

  async onunload() {
    for (const d of this._toolDisposers.splice(0)) {
      try { d?.(); } catch { /* ignore */ }
    }
    if (this._dataDir) {
      const tmpDir = path.join(this._dataDir, TMP_DIR);
      if (fs.existsSync(tmpDir)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }
}