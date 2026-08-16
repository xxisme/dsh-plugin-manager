/**
 * tools/dsh-install-plugin.js — Agent 工具：安装插件（zip / 本地目录 / registry）
 *
 * 这是修改用户工作区的操作：每次都会自动备份 + pnpm install。
 * 设计选择：不做 Auto 模式的人工审批 gate，因为 install 是用户主动发起的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { addBundle, profileExists } from '../lib/dsh-profile.js';
import { backupProfile } from '../lib/backup.js';
import { install, addPackage } from '../lib/pnpm-runner.js';
import { extractAndInspect } from '../lib/zip-extractor.js';
import { appendLog } from '../lib/operation-log.js';
import { getDshHome, getDataDir, getLog, getConfig } from '../lib/plugin-context.js';

export const name = 'dsh_install_plugin';
export const description = '把一个插件装进指定 DSH profile。支持三种来源：本地 zip（source=zip + path=绝对路径）、本地目录（source=local + path=绝对路径）、npm/github（source=registry + spec=包名或 github:user/repo）。每次自动备份并跑 pnpm install。';

export const parameters = {
  type: 'object',
  properties: {
    profile: { type: 'string', description: 'profile 名称，如 web' },
    source: {
      type: 'string',
      enum: ['zip', 'local', 'registry'],
      description: '插件来源类型：zip=本地 zip 文件；local=本地已解压目录；registry=npm/github',
    },
    path: {
      type: 'string',
      description: 'zip 文件绝对路径 或 本地目录绝对路径（source=zip/local 时必填）',
    },
    spec: {
      type: 'string',
      description: 'npm 包名或 github:user/repo 形式的 spec（source=registry 时必填）',
    },
    force: {
      type: 'boolean',
      description: '目标已存在时是否覆盖',
    },
  },
  required: ['profile', 'source'],
  additionalProperties: false,
};

export async function execute(input) {
  const { profile, source, path: sourcePath, spec, force = false } = input || {};
  const dshHome = getDshHome();
  const dataDir = getDataDir();
  const log = getLog();
  if (!dshHome) return { ok: false, error: 'DSH_HOME 未配置' };
  if (!profileExists(dshHome, profile)) return { ok: false, error: `profile 不存在: ${profile}` };
  const registry = getConfig('registry', 'https://registry.npmmirror.com');

  try {
    const backupDir = backupProfile(dataDir, dshHome, profile);
    const profDir = path.join(dshHome, 'profiles', profile);
    const externalDir = path.join(profDir, 'external');
    if (!fs.existsSync(externalDir)) fs.mkdirSync(externalDir, { recursive: true });

    if (source === 'registry') {
      if (!spec) return { ok: false, error: 'source=registry 时 spec 必填' };
      const onLog = (line) => log.info?.(`[pnpm] ${line.trim()}`);
      const addResult = await addPackage(spec, profDir, { registry, onStdout: onLog, onStderr: onLog });
      if (addResult.exitCode !== 0) {
        return { ok: false, error: 'pnpm add 失败', output: addResult, backupDir };
      }
      // 从 spec 推断 dependencies key：@scope/pkg@ver → @scope/pkg；pkg@ver → pkg；github:user/repo → 取 repo 名
      let depsKey = spec.split(/\s+/)[0];
      if (depsKey.startsWith('github:')) depsKey = depsKey.slice('github:'.length).split('/').slice(-1)[0];
      else if (depsKey.startsWith('@')) {
        const parts = depsKey.slice(1).split('/');
        depsKey = parts.length >= 2 ? '@' + parts[0] + '/' + parts[1].split('@')[0] : '@' + parts[0];
      } else {
        depsKey = depsKey.split('@')[0];
      }
      if (!depsKey) return { ok: false, error: `无法从 spec 解析包名: ${spec}` };
      addBundle(dshHome, profile, { id: depsKey, depsSpec: spec, depsKey });
      appendLog(dataDir, { action: 'install.registry', profile, plugin: depsKey, spec, ok: true, backupDir });
      return { ok: true, pluginName: depsKey, backupDir, output: addResult };
    }

    if (source === 'zip') {
      if (!sourcePath) return { ok: false, error: 'source=zip 时 path 必填' };
      if (!fs.existsSync(sourcePath)) return { ok: false, error: `zip 不存在: ${sourcePath}` };
      const tmpName = `${Date.now()}-${path.basename(sourcePath, '.zip')}`;
      const destDir = path.join(externalDir, tmpName);
      const { pluginRoot, metadata } = extractAndInspect(sourcePath, destDir);
      const pluginName = metadata.name;
      if (!pluginName) return { ok: false, error: 'package.json 缺少 name' };
      const finalDir = path.join(externalDir, pluginName);
      if (fs.existsSync(finalDir) && !force) {
        return { ok: false, error: `目标已存在: ${finalDir}，传 force=true 覆盖`, pluginName, backupDir };
      }
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
      fs.cpSync(pluginRoot, finalDir, { recursive: true });
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      const depsSpec = `link:${finalDir.replace(/\\/g, '/')}`;
      addBundle(dshHome, profile, { id: pluginName, depsSpec, depsKey: pluginName });
      const onLog = (line) => log.info?.(`[pnpm] ${line.trim()}`);
      const installResult = await install(profDir, { registry, onStdout: onLog, onStderr: onLog });
      appendLog(dataDir, { action: 'install.zip', profile, plugin: pluginName, ok: installResult.exitCode === 0, backupDir });
      return { ok: installResult.exitCode === 0, pluginName, finalDir, backupDir, install: installResult };
    }

    if (source === 'local') {
      if (!sourcePath) return { ok: false, error: 'source=local 时 path 必填' };
      if (!fs.existsSync(sourcePath)) return { ok: false, error: `目录不存在: ${sourcePath}` };
      const pkgPath = path.join(sourcePath, 'package.json');
      if (!fs.existsSync(pkgPath)) return { ok: false, error: '源目录缺少 package.json' };
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const pluginName = pkg.name;
      if (!pluginName) return { ok: false, error: 'package.json 缺少 name' };
      const finalDir = path.join(externalDir, pluginName);
      if (fs.existsSync(finalDir) && !force) {
        return { ok: false, error: `目标已存在: ${finalDir}，传 force=true 覆盖`, pluginName, backupDir };
      }
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
      fs.cpSync(sourcePath, finalDir, { recursive: true });
      const depsSpec = `link:${finalDir.replace(/\\/g, '/')}`;
      addBundle(dshHome, profile, { id: pluginName, depsSpec, depsKey: pluginName });
      const onLog = (line) => log.info?.(`[pnpm] ${line.trim()}`);
      const installResult = await install(profDir, { registry, onStdout: onLog, onStderr: onLog });
      appendLog(dataDir, { action: 'install.local', profile, plugin: pluginName, ok: installResult.exitCode === 0, backupDir });
      return { ok: installResult.exitCode === 0, pluginName, finalDir, backupDir, install: installResult };
    }

    return { ok: false, error: `未知 source: ${source}` };
  } catch (e) {
    log.error?.('dsh_install_plugin failed', e);
    return { ok: false, error: e.message };
  }
}
