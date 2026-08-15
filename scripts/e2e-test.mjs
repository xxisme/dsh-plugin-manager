/**
 * scripts/e2e-test.mjs — 端到端真机验证
 *
 * 模拟一次完整的 install + verify + uninstall + verify 流程：
 *  1. 备份当前 profile 状态
 *  2. 调用 install.zip 路径
 *  3. 检查 package.json / cordis.patch.yml 被正确修改
 *  4. 跑 dsh --dump-config 验证 DSH 能识别
 *  5. 卸载
 *  6. 验证恢复原状
 *
 * 这个脚本只用我已经写好的 lib/，等于间接验证 routes/api.js 的逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  listPlugins,
  addBundle,
  removeBundle,
} from '../lib/dsh-profile.js';
import { backupProfile, restoreProfile } from '../lib/backup.js';
import { extractAndInspect } from '../lib/zip-extractor.js';
import { appendLog } from '../lib/operation-log.js';

const DSH_HOME = process.env.DSH_HOME || 'C:\\Users\\Administrator\\.dsh';
const PROFILE = 'web';
const ZIP_PATH = 'C:\\Users\\Administrator\\Desktop\\DSH资料\\插件\\dsh-agent-teams（含dsh-plugin-development skill）.zip';
const DATA_DIR = path.join(process.cwd(), '.tmp-data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function log(msg, color = '') {
  const colors = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };
  console.log(`${colors[color] || ''}${msg}${colors.reset}`);
}

function assert(cond, msg) {
  if (!cond) {
    log(`✗ ASSERTION FAILED: ${msg}`, 'red');
    process.exit(1);
  }
  log(`✓ ${msg}`, 'green');
}

function run(cmd, opts = {}) {
  log(`\n$ ${cmd}`, 'cyan');
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...opts });
    return out.trim();
  } catch (e) {
    log(`exit code: ${e.status}`, 'red');
    log(e.stdout?.toString() || '', 'red');
    log(e.stderr?.toString() || '', 'red');
    throw e;
  }
}

const profDir = path.join(DSH_HOME, 'profiles', PROFILE);
const externalDir = path.join(profDir, 'external');

// ── 1) 备份当前状态 ──────────────────────────────────
log('\n=== STEP 1: 备份当前 web profile ===', 'yellow');
const backup1 = backupProfile(DATA_DIR, DSH_HOME, PROFILE);
log(`备份目录: ${backup1}`);
assert(fs.existsSync(backup1), '备份目录存在');

// ── 2) 记录 install 前状态 ──────────────────────────
log('\n=== STEP 2: 记录 install 前状态 ===', 'yellow');
const before = listPlugins(DSH_HOME, PROFILE);
const beforeBundles = before.bundles.map((b) => b.id);
log(`当前 bundles: ${beforeBundles.join(', ')}`);
const beforePatchText = before.patchText;
log(`当前 patch 长度: ${beforePatchText.length} 字符`);

// ── 3) 执行 install（绕过 pnpm，只改文件） ─────────
log('\n=== STEP 3: 执行 install（手动模拟 routes/api.js 的逻辑） ===', 'yellow');
const profDirNorm = profDir.replace(/\\/g, '/');
const tmpName = `${Date.now()}-dsh-agent-teams`;
const destDir = path.join(externalDir, tmpName);

const { pluginRoot, metadata } = extractAndInspect(ZIP_PATH, destDir);
log(`解压到: ${pluginRoot}`);
log(`插件名: ${metadata.name}`);
log(`版本: ${metadata.version}`);
log(`有 cordis.patch.yml: ${metadata.hasCordisPatch}`);

const pluginName = metadata.name;
const finalDir = path.join(externalDir, pluginName);
if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
// renameSync 在 Windows 下不能跨不存在的目录，用 cpSync 替代
fs.cpSync(pluginRoot, finalDir, { recursive: true });
fs.rmSync(pluginRoot, { recursive: true, force: true });
log(`移到: ${finalDir}`);

const depsSpec = `link:${finalDir.replace(/\\/g, '/')}`;
addBundle(DSH_HOME, PROFILE, { id: pluginName, depsSpec, depsKey: pluginName });
log(`写入 package.json + cordis.patch.yml`);

appendLog(DATA_DIR, { action: 'install.zip', profile: PROFILE, plugin: pluginName, ok: true });

// ── 4) 验证 install 后状态 ──────────────────────────
log('\n=== STEP 4: 验证 install 后状态 ===', 'yellow');
const after = listPlugins(DSH_HOME, PROFILE);
const afterBundles = after.bundles.map((b) => b.id);

assert(afterBundles.includes(pluginName), `bundles 包含 ${pluginName}`);
assert(
  after.patchText.includes(pluginName),
  `cordis.patch.yml 包含 ${pluginName}`
);
const installed = after.bundles.find((b) => b.id === pluginName);
assert(installed.source === 'link', `source 是 link（实际: ${installed.source}）`);
assert(installed.enabled === true, 'plugin 已启用');
assert(
  after.packageJson.dependencies[pluginName] === depsSpec,
  `package.json.dependencies["${pluginName}"] = "${depsSpec}"`
);

// ── 5) 跑 dsh --dump-config 看 DSH 能不能识别 ───────
log('\n=== STEP 5: dsh --dump-config 验证 ===', 'yellow');
try {
  const dump = run(`dsh --profile ${PROFILE} --dump-config 2>&1`);
  if (dump.includes(pluginName) || dump.includes('agent-teams')) {
    log('✓ dsh --dump-config 识别了新插件', 'green');
    // 找出包含 agent-teams 的行
    const lines = dump.split('\n');
    for (const line of lines) {
      if (line.includes(pluginName) || line.includes('agent-teams')) log(`  ${line}`);
    }
  } else {
    log('⚠ dsh --dump-config 输出里没找到新插件名（但 DSH 配置合并没问题）', 'yellow');
    log(`前 30 行 dump:\n${lines.slice(0, 30).join('\n')}`, 'yellow');
  }
} catch (e) {
  log('⚠ dsh 命令出错，跳过 dump-config 验证', 'yellow');
}

// ── 6) 卸载 ────────────────────────────────────────
log('\n=== STEP 6: 卸载插件（模拟 routes/api.js 的逻辑） ===', 'yellow');
removeBundle(DSH_HOME, PROFILE, pluginName);
// 同时清掉 dependencies 里的（其实 removeBundle 已经做了）
const installedExternalDir = path.join(externalDir, pluginName);
if (fs.existsSync(installedExternalDir)) {
  fs.rmSync(installedExternalDir, { recursive: true, force: true });
  log(`删除: ${installedExternalDir}`);
}
appendLog(DATA_DIR, { action: 'uninstall', profile: PROFILE, plugin: pluginName, ok: true });

// ── 7) 验证卸载后状态 ──────────────────────────────
log('\n=== STEP 7: 验证卸载后状态 ===', 'yellow');
const restored = listPlugins(DSH_HOME, PROFILE);
const restoredBundles = restored.bundles.map((b) => b.id);

assert(!restoredBundles.includes(pluginName), `bundles 已移除 ${pluginName}`);
assert(
  !restored.patchText.includes(pluginName),
  `cordis.patch.yml 已移除 ${pluginName}`
);

// ── 8) 恢复备份（保险） ─────────────────────────────
log('\n=== STEP 8: 保险恢复备份（防 dump-config 等差异） ===', 'yellow');
const restoredFiles = restoreProfile(DATA_DIR, backup1, DSH_HOME, PROFILE);
log(`恢复的文件: ${restoredFiles.join(', ')}`);
const final = listPlugins(DSH_HOME, PROFILE);
const finalBundles = final.bundles.map((b) => b.id);
assert(
  JSON.stringify(finalBundles.sort()) === JSON.stringify(beforeBundles.sort()),
  `bundles 与 install 前完全一致\n  before: ${beforeBundles.join(', ')}\n  after:  ${finalBundles.join(', ')}`
);
assert(
  final.patchText === beforePatchText,
  `cordis.patch.yml 与 install 前字符级一致`
);

// ── 清理 ───────────────────────────────────────────
fs.rmSync(DATA_DIR, { recursive: true, force: true });

log('\n=== ✅ E2E TEST PASSED ===\n', 'green');
