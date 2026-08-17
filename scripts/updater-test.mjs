/**
 * scripts/updater-test.mjs — 锁文件解析 + 哈希验证
 *
 * 跑法：node scripts/updater-test.mjs
 *
 * 重点：
 *   1) parseImporterVersions 能正确读 lockfile 的 resolved version
 *   2) lockfileImportersHash 在 importers 段变化时返回不同 hash
 *   3) listPlugins 的 version 字段优先 lockfile，specifier 单独存
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseImporterVersions,
  lockfileImportersHash,
} from '../lib/updater.js';
import { listPlugins } from '../lib/dsh-profile.js';

let pass = 0;
let fail = 0;
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else {
    fail += 1;
    console.log(`  ❌ ${name}\n     实际: ${JSON.stringify(actual)}\n     期望: ${JSON.stringify(expect)}`);
  }
}
function group(t) { console.log(`\n── ${t} ──`); }

// ── 真实 lockfile 样本（模仿用户 ~/.dsh/profiles/web 的格式）──
const LOCKFILE_FIXTURE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false

importers:

  .:
    dependencies:
      '@nanmicoder/dsh-auto-mode':
        specifier: ^0.1.2
        version: 0.1.2
      '@nanmicoder/dsh-plugin-market':
        specifier: ^0.1.1
        version: 0.1.1
      dsh-better-sidebar:
        specifier: 0.12.2
        version: 0.12.2
      dsh-vision-router:
        specifier: ^1.2.3
        version: 1.2.3

packages:

  '@scope/pkg@1.0.0':
    resolution: {integrity: sha512-xxx}
`;

// ── parseImporterVersions ──
group('parseImporterVersions（lockfile importers 段解析）');
{
  const r = parseImporterVersions(LOCKFILE_FIXTURE);
  check('@scope 包的引号正确剥除',
    r['@nanmicoder/dsh-auto-mode'], '0.1.2');
  check('普通包名', r['dsh-better-sidebar'], '0.12.2');
  check('精确版本', r['dsh-vision-router'], '1.2.3');
}
{
  // lockfile 文本为空
  const r = parseImporterVersions('');
  check('空 lockfile 不炸', r, {});
}

// ── lockfileImportersHash ──
group('lockfileImportersHash（验证更新是否真的改了 lockfile）');
{
  const h1 = lockfileImportersHash(LOCKFILE_FIXTURE);
  check('返回 sha256 hex（64 字符）', typeof h1 === 'string' && h1.length === 64, true);
  // 模拟 dsh plugin update 改了 importers 段（把 auto-mode 从 0.1.2 升到 0.1.4）
  const updated = LOCKFILE_FIXTURE.replace("version: 0.1.2\n      '@nanmicoder", "version: 0.1.4\n      '@nanmicoder");
  const h2 = lockfileImportersHash(updated);
  check('importers 段 version 变化 → hash 不同', h1 !== h2, true);
}
{
  // packages 段变化（传递依赖变化）不影响 importers hash
  const updatedPackages = LOCKFILE_FIXTURE.replace(
    "@scope/pkg@1.0.0",
    "@scope/pkg@2.0.0"
  );
  const h = lockfileImportersHash(updatedPackages);
  check('packages 段变化 → hash 不变（验证只看 importers）',
    h === lockfileImportersHash(LOCKFILE_FIXTURE), true);
}
{
  // null 输入
  check('null 输入返回 null', lockfileImportersHash(null), null);
}

// ── listPlugins 返回的 version 字段必须读 lockfile ──
group('listPlugins：version 优先 lockfile resolved version');
{
  // 临时建一个伪 profile 目录，验证 listPlugins 走的是 lockfile 而不是 specifier
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listplugins-test-'));
  try {
    const dshHome = path.join(tmp, 'dsh');
    const profileName = 'web';
    const profilePath = path.join(dshHome, 'profiles', profileName);
    fs.mkdirSync(profilePath, { recursive: true });

    // package.json: dependency 写的是 specifier
    fs.writeFileSync(path.join(profilePath, 'package.json'), JSON.stringify({
      dependencies: { '@nanmicoder/dsh-auto-mode': '^0.1.2' },
      dsh: { profile: { bundles: ['@nanmicoder/dsh-auto-mode'] } },
    }, null, 2));
    // lockfile: resolved 是 0.1.4（模拟已更新）
    fs.writeFileSync(path.join(profilePath, 'pnpm-lock.yaml'),
      LOCKFILE_FIXTURE.replace("version: 0.1.2", "version: 0.1.4"));

    // cordis.patch.yml 必须存在（listPlugins 走 parseCordisPatch）
    fs.writeFileSync(path.join(profilePath, 'cordis.patch.yml'), '[]\n');

    const r = listPlugins(dshHome, profileName, null);
    const bundle = r.bundles[0];
    check('bundle 数量', r.bundles.length, 1);
    check('version = lockfile 解析的 0.1.4（不是 specifier 0.1.2）',
      bundle.version, '0.1.4');
    check('specifier 单独存 = package.json 写的 ^0.1.2',
      bundle.specifier, '^0.1.2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
{
  // 没有 lockfile 时应该回退到 specifier
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'listplugins-test-'));
  try {
    const dshHome = path.join(tmp, 'dsh');
    const profileName = 'web';
    const profilePath = path.join(dshHome, 'profiles', profileName);
    fs.mkdirSync(profilePath, { recursive: true });
    fs.writeFileSync(path.join(profilePath, 'package.json'), JSON.stringify({
      dependencies: { 'pkg': '^1.0.0' },
      dsh: { profile: { bundles: ['pkg'] } },
    }, null, 2));
    fs.writeFileSync(path.join(profilePath, 'cordis.patch.yml'), '[]\n');

    const r = listPlugins(dshHome, profileName, null);
    check('无 lockfile 时回退到 specifier',
      r.bundles[0].version, '^1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);