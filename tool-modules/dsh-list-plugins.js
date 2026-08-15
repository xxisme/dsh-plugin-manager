/**
 * tools/dsh-list-plugins.js — Agent 工具：列出 profile 的所有插件
 */

import { listPlugins, profileExists } from '../lib/dsh-profile.js';
import { getDshHome } from '../lib/plugin-context.js';

export const name = 'dsh_list_plugins';
export const description = '列出指定 DSH profile 的所有 bundle 插件及其状态（来源、版本、启用/禁用）。profile 必填。';

export const parameters = {
  type: 'object',
  properties: {
    profile: {
      type: 'string',
      description: 'profile 名称，如 web / headless / tui',
    },
  },
  required: ['profile'],
  additionalProperties: false,
};

export async function execute(input) {
  const { profile } = input || {};
  const dshHome = getDshHome();
  if (!dshHome) return { ok: false, error: 'DSH_HOME 未配置' };
  if (!profile) return { ok: false, error: 'profile 必填' };
  if (!profileExists(dshHome, profile)) return { ok: false, error: `profile 不存在: ${profile}` };
  try {
    const data = listPlugins(dshHome, profile);
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
