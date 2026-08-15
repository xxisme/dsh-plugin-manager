/**
 * tools/dsh-toggle-plugin.js — Agent 工具：启用 / 禁用插件
 */

import { setBundleEnabled, profileExists } from '../lib/dsh-profile.js';
import { backupProfile } from '../lib/backup.js';
import { appendLog } from '../lib/operation-log.js';
import { getDshHome, getDataDir, getLog } from '../lib/plugin-context.js';

export const name = 'dsh_toggle_plugin';
export const description = '启用或禁用指定 DSH profile 中的 bundle（仅修改 cordis.patch.yml，不动 npm 依赖）。enabled=true 启用，false 禁用。';

export const parameters = {
  type: 'object',
  properties: {
    profile: { type: 'string', description: 'profile 名称' },
    id: { type: 'string', description: 'bundle 名称' },
    enabled: { type: 'boolean', description: 'true=启用，false=禁用' },
  },
  required: ['profile', 'id', 'enabled'],
  additionalProperties: false,
};

export async function execute(input) {
  const { profile, id, enabled } = input || {};
  const dshHome = getDshHome();
  const dataDir = getDataDir();
  const log = getLog();
  if (!dshHome) return { ok: false, error: 'DSH_HOME 未配置' };
  if (!profileExists(dshHome, profile)) return { ok: false, error: `profile 不存在: ${profile}` };
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是 boolean' };
  try {
    const backupDir = backupProfile(dataDir, dshHome, profile);
    setBundleEnabled(dshHome, profile, id, enabled);
    appendLog(dataDir, { action: enabled ? 'enable' : 'disable', profile, plugin: id, ok: true, backupDir });
    return { ok: true, id, enabled, backupDir };
  } catch (e) {
    log.error?.('dsh_toggle_plugin failed', e);
    return { ok: false, error: e.message };
  }
}
