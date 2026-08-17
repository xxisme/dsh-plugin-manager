// lib/plugin-zip-check.js — 装前格式检查：解压 zip 校验是不是可装的 DSH bundle
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// zip → 解压到临时目录
function extractZipToTemp(zipPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipcheck-'));
  // 用 PowerShell Expand-Archive（PowerShell 5.1+ / Windows 都内置）
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${tmp.replace(/\//g, '\\')}" -Force`], { encoding: 'utf8' });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('解压失败: ' + (r.stderr || r.stdout || 'unknown'));
  }
  return tmp;
}

// 递归找文件（限制深度避免 junction 循环）
function findFile(root, name, maxDepth = 3) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory() && maxDepth > 0) {
      const r = findFile(full, name, maxDepth - 1);
      if (r) return r;
    }
  }
  return null;
}

// 找 pluginRoot（兼容 flat zip 和嵌套 `<repo>-main/`）
function findPluginRoot(zipExtractDir) {
  const top = fs.readdirSync(zipExtractDir);
  if (!top.length) return null;
  // 顶层直接有 package.json → flat zip
  if (fs.existsSync(path.join(zipExtractDir, 'package.json'))) return zipExtractDir;
  // 顶层是 `<repo>-main/` 等单层目录
  const first = top[0];
  const firstStat = fs.statSync(path.join(zipExtractDir, first));
  if (firstStat.isDirectory()) {
    const inner = path.join(zipExtractDir, first);
    if (fs.existsSync(path.join(inner, 'package.json'))) return inner;
    // 再深一层（GitHub user-repo-main 结构）
    const sub = fs.readdirSync(inner).find((n) => {
      try { return fs.statSync(path.join(inner, n)).isDirectory(); } catch { return false; }
    });
    if (sub && fs.existsSync(path.join(inner, sub, 'package.json'))) return path.join(inner, sub);
  }
  return null;
}

/**
 * 装前格式检查：检查 zip 是否可直接作为 DSH bundle 装入
 * @param {string} zipPath
 * @returns {{
 *   ok: boolean,           // 是否通过所有关键检查（err 数组为空）
 *   errors: string[],       // 阻塞性问题
 *   warnings: string[],     // 非阻塞但建议关注
 *   info: string[],         // 信息性提示
 *   pluginName?: string,
 *   pluginRoot?: string,   // 临时解压目录里的 pluginRoot 路径
 *   packageJson?: object,
 *   cordisPatch?: string,  // cordis.patch.yml 路径
 *   cleanup: () => void     // 清理临时目录
 * }}
 */
export function checkZipReady(zipPath) {
  const errors = [];
  const warnings = [];
  const info = [];
  let pluginRoot, packageJson, cordisPatch;
  const tmp = extractZipToTemp(zipPath);
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  try {
    pluginRoot = findPluginRoot(tmp);
    if (!pluginRoot) {
      errors.push('未找到 plugin 根目录（解压后没有 package.json，可能不是 DSH 插件 zip）');
      return { ok: false, errors, warnings, info, cleanup };
    }
    info.push('pluginRoot: ' + path.basename(pluginRoot));

    // package.json 校验
    const pkgPath = path.join(pluginRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      errors.push('plugin 根目录缺少 package.json');
      return { ok: false, errors, warnings, info, cleanup };
    }
    try {
      packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      errors.push('package.json JSON 解析失败: ' + e.message);
      return { ok: false, errors, warnings, info, cleanup };
    }

    if (!packageJson.name || typeof packageJson.name !== 'string') {
      errors.push('package.json 缺少 name 字段');
    }
    if (!packageJson.main || typeof packageJson.main !== 'string') {
      warnings.push('package.json 缺少 main 字段');
    }

    // dsh.bundle.patch 声明
    if (!packageJson.dsh?.bundle?.patch) {
      errors.push('package.json 缺少 dsh.bundle.patch 字段（这是 DSH bundle 的必需声明）');
    }

    // cordis.patch.yml 存在
    const patchRel = packageJson.dsh?.bundle?.patch || './cordis.patch.yml';
    cordisPatch = path.resolve(pluginRoot, patchRel);
    if (!fs.existsSync(cordisPatch)) {
      errors.push('cordis.patch.yml 不存在（按 dsh.bundle.patch 声明查找: ' + patchRel + '）');
    }

    // main 字段指向的文件存在
    if (packageJson.main) {
      const mainPath = path.resolve(pluginRoot, packageJson.main);
      if (!fs.existsSync(mainPath)) {
        errors.push(`main 指向的文件不存在: ${packageJson.main} —— 这是源码 zip 未 build。需先 \`pnpm install && pnpm build\` 生成 ${packageJson.main}`);
      } else {
        info.push('main: ' + packageJson.main);
      }
    }

    // dependencies / build 提示
    const deps = Object.keys(packageJson.dependencies || {});
    if (deps.length > 5) {
      warnings.push(`依赖较多（${deps.length} 个）—— link: 安装方式会跳 pnpm install，可能缺失传递依赖。建议改用官方 \`dsh plugin add <pkg>\` 安装 npm 版`);
      info.push('依赖: ' + deps.slice(0, 8).join(', ') + (deps.length > 8 ? '...' : ''));
    }
    if (packageJson.scripts?.build) {
      warnings.push('package.json 有 scripts.build —— 这是源码包，未 build。需先 build 才能装');
    }

    // 危险字符检查
    if (packageJson.name && /["&|^<>%!*?()\\]/.test(packageJson.name)) {
      errors.push(`插件名含不安全字符（可能被 shell 解释）: ${packageJson.name}`);
    }
  } catch (e) {
    errors.push('检查过程异常: ' + e.message);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info,
    pluginName: packageJson?.name,
    pluginRoot,
    packageJson,
    cordisPatch,
    cleanup,
  };
}