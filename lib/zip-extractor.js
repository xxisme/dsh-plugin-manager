/**
 * lib/zip-extractor.js — 本地 zip 解压与 plugin 元数据探测
 *
 * 纯 Node 内置实现（无 adm-zip 依赖），见 lib/zip-native.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractZip } from './zip-native.js';

/**
 * 解压 zip 到目标目录
 */
export { extractZip };

/**
 * 在解压目录里找 package.json 的根
 * 策略：取第一层目录里唯一一个含 package.json 的目录
 */
export function findPluginRoot(extractedDir) {
  const rootPkg = path.join(extractedDir, 'package.json');
  if (fs.existsSync(rootPkg)) return extractedDir;

  const subs = fs.readdirSync(extractedDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(extractedDir, e.name));
  for (const sub of subs) {
    if (fs.existsSync(path.join(sub, 'package.json'))) return sub;
  }

  // 再深一层（github zip 经常是 user-repo-main/ 结构，再嵌一层）
  for (const sub of subs) {
    try {
      const subs2 = fs.readdirSync(sub, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(sub, e.name));
      for (const sub2 of subs2) {
        if (fs.existsSync(path.join(sub2, 'package.json'))) return sub2;
      }
    } catch { /* ignore */ }
  }

  throw new Error('解压后未找到 package.json，请检查 zip 内容');
}

/**
 * 读 plugin 元数据
 */
export function readPluginMetadata(pluginRoot) {
  const pkgPath = path.join(pluginRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('plugin 根目录缺少 package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  return {
    name: pkg.name,
    version: pkg.version || '0.0.0',
    description: pkg.description || '',
    main: pkg.main,
    dependencies: pkg.dependencies || {},
    peerDependencies: pkg.peerDependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
    engines: pkg.engines || {},
    dsh: pkg.dsh || null,
    hasCordisPatch: fs.existsSync(path.join(pluginRoot, 'cordis.patch.yml')),
    pkgPath,
  };
}

/**
 * 高层 API：解压 + 找根 + 读元数据
 */
export function extractAndInspect(zipPath, destDir) {
  extractZip(zipPath, destDir);
  const pluginRoot = findPluginRoot(destDir);
  const metadata = readPluginMetadata(pluginRoot);
  return { destDir, pluginRoot, metadata };
}
