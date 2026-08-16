/**
 * tools/dsh-uninstall-plugin.js — Agent 工具：卸载插件
 */

import fs from 'node:fs';
import path from 'node:path';
import { removeBundle, profileExists } from '../lib/dsh-profile.js';
import { backupProfile } from '../lib/backup.js';
import { runDsh } from '../lib/cmd-runner.js';
import { appendLog } from '../lib/operation-log.js';
import { getDshHome, getDataDir, getLog } from '../lib/plugin-context.js';

export const name = 'dsh_uninstall_plugin';
export const description = '从指定 DSH profile 卸载一个 bundle 插件。调用 dsh plugin remove（pnpm remove + bundles 自动 reconcile），再补 cordis.patch.yml 清理。可选同时删除本地 link 文件（removeFiles=true）。';

export const parameters = {
  type: 'object',
  properties: {
    profile: { type: 'string', description: 'profile 名称' },
    id: { type: 'string', description: '要卸载的 bundle 名（package.json dependencies 里的 key）' },
    removeFiles: {
      type: 'boolean',
      description: '是否同时删除 link 安装的本地文件（profiles/<name>/external/<id>/）',
    },
  },
  required: ['profile', 'id'],
  additionalProperties: false,
};

export async function execute(input) {
  const { profile, id, removeFiles = false } = input || {};
  const dshHome = getDshHome();
  const dataDir = getDataDir();
  const log = getLog();
  if (!dshHome) return { ok: false, error: 'DSH_HOME 未配置' };
  if (!profileExists(dshHome, profile)) return { ok: false, error: `profile 不存在: ${profile}` };

  try {
    const backupDir = backupProfile(dataDir, dshHome, profile);
    const profDir = path.join(dshHome, 'profiles', profile);
    // 直连 dsh plugin remove：内部跑 pnpm remove + reconcilePlugins（bundles 自动出栈）。
    // 不用裸 pnpm remove——裸跑会绕过 bundles reconcile，留下 dsh.profile.bundles 残留。
    const job = await runDsh(['plugin', '--profile', profile, 'remove', id], { cwd: profDir });
    // dsh reconcile 只动 bundles；profile 层 cordis.patch.yml 的 insert 残留仍需兜底清
    removeBundle(dshHome, profile, id);

    let removedDir = null;
    if (removeFiles) {
      const externalDir = path.join(profDir, 'external', id);
      if (fs.existsSync(externalDir)) {
        fs.rmSync(externalDir, { recursive: true, force: true });
        removedDir = externalDir;
      }
    }
    appendLog(dataDir, {
      action: 'uninstall',
      profile,
      plugin: id,
      removeFiles,
      ok: job.exitCode === 0,
      backupDir,
      removedDir,
    });
    return {
      ok: job.exitCode === 0,
      pluginName: id,
      backupDir,
      removedDir,
      output: job,
    };
  } catch (e) {
    log.error?.('dsh_uninstall_plugin failed', e);
    return { ok: false, error: e.message };
  }
}
