/**
 * tools/dsh-list-profiles.js — Agent 工具：列出所有 DSH profile
 *
 * hana 要求的导出格式：named exports（name/description/parameters/execute）
 * 不传 ctx 参数，运行时从 plugin-context 单例读 dshHome。
 */

import { listProfiles, listPlugins } from '../lib/dsh-profile.js';
import { getDshHome } from '../lib/plugin-context.js';

export const name = 'dsh_list_profiles';
export const description = '列出本机 DSH_HOME 下所有 profile 及其已安装的 bundle 数量。返回每个 profile 的 name / bundleCount / enabledCount。';

export const parameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export async function execute() {
  const dshHome = getDshHome();
  if (!dshHome) {
    return { ok: false, error: 'DSH_HOME 未配置（请在插件 Settings 里设置，或确保 ~/.dsh 存在）' };
  }
  try {
    const profiles = listProfiles(dshHome);
    const detailed = profiles.map((name) => {
      try {
        const data = listPlugins(dshHome, name);
        return {
          name,
          bundleCount: (data.bundles || []).length,
          enabledCount: (data.bundles || []).filter((p) => p.enabled).length,
        };
      } catch {
        return { name, bundleCount: 0, enabledCount: 0, error: true };
      }
    });
    return { ok: true, dshHome, profiles: detailed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
