// scripts/test-legacy-migrate.mjs — 单元测试 migrateLegacyPnpmFields
//
// 模拟真实场景：
//   1) 用户 profile 里有 pnpm.onlyBuiltDependencies → 应迁移到 pnpm-workspace.yaml
//   2) 再跑一次（幂等）→ 应不动
//   3) 一个干净的 profile（pnpm 块为空）→ 应清理 pnpm 块
//   4) 一个没 pnpm 块的 profile → 不动

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateLegacyPnpmFields } from '../lib/pnpm-build-allow.js';

function mkTmpProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-mig-test-'));
  return root;
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); pass++; }
  else { console.log(`  ❌ ${msg}`); fail++; }
}

// ── 场景 1：package.json#pnpm.onlyBuiltDependencies 迁移到 yaml ──
console.log('\n[场景 1] 标准迁移');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), {
    name: 'demo-profile',
    dependencies: { 'node-pty': '1.0.0' },
    pnpm: { onlyBuiltDependencies: ['node-pty'] },
  });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: false\n', 'utf8');

  const r = migrateLegacyPnpmFields(dir, { log: { info: m => console.log('   log:', m) } });
  assert(r.migrated === true, '返回 migrated=true');
  assert(r.fields.includes('onlyBuiltDependencies'), 'fields 含 onlyBuiltDependencies');

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert(!pkg.pnpm, 'package.json#pnpm 字段已删除');

  const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
  assert(/^onlyBuiltDependencies:\s*\n  - node-pty/m.test(ws), 'pnpm-workspace.yaml 含 onlyBuiltDependencies 块');
  assert(ws.includes('allowBuilds:'), '原有 allowBuilds 块未被破坏');

  // 备份文件存在
  assert(fs.existsSync(path.join(dir, 'package.json.legacy-migrate.bak')), 'package.json 已备份');
  assert(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml.legacy-migrate.bak')), 'pnpm-workspace.yaml 已备份');
}

// ── 场景 2：幂等 — 再次调用应不动 ──
console.log('\n[场景 2] 幂等');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), { name: 'demo', dependencies: {} });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\nonlyBuiltDependencies:\n  - node-pty\n', 'utf8');

  const r = migrateLegacyPnpmFields(dir);
  assert(r.migrated === false, '返回 migrated=false');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert(pkg.pnpm === undefined, 'package.json 仍无 pnpm 字段');
}

// ── 场景 3：pnpm 块为空 → 仅清理占位 ──
console.log('\n[场景 3] 清理空 pnpm 块');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), { name: 'demo', dependencies: {}, pnpm: {} });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8');

  const r = migrateLegacyPnpmFields(dir);
  assert(r.migrated === true, 'migrated=true');
  assert(r.fields.includes('pnpm.empty'), 'fields 含 pnpm.empty');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert(pkg.pnpm === undefined, '空 pnpm 块已删');
}

// ── 场景 4：无 pnpm 字段 → 不动 ──
console.log('\n[场景 4] 无 pnpm 字段');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), { name: 'demo', dependencies: {} });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8');

  const r = migrateLegacyPnpmFields(dir);
  assert(r.migrated === false, 'migrated=false');
}

// ── 场景 5：合并去重 — 现有 yaml 已有该项，应跳过 ──
console.log('\n[场景 5] 合并去重');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), {
    name: 'demo',
    pnpm: { onlyBuiltDependencies: ['node-pty', 'esbuild'] },
  });
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\nonlyBuiltDependencies:\n  - node-pty\n', 'utf8');

  const r = migrateLegacyPnpmFields(dir);
  assert(r.migrated === true, 'migrated=true');
  const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
  assert(/^onlyBuiltDependencies:\s*\n  - node-pty\n  - esbuild/m.test(ws), 'esbuild 已追加到末尾，node-pty 不重复');
}

// ── 场景 6：profile 没 pnpm-workspace.yaml → 自动创建 ──
console.log('\n[场景 6] 缺 pnpm-workspace.yaml');
{
  const dir = mkTmpProfile();
  writeJson(path.join(dir, 'package.json'), {
    name: 'demo',
    pnpm: { onlyBuiltDependencies: ['sharp'] },
  });
  // 不创建 yaml

  const r = migrateLegacyPnpmFields(dir);
  assert(r.migrated === true, 'migrated=true');
  assert(fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')), '已自动创建 pnpm-workspace.yaml');
  const ws = fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
  assert(/packages:\s*\n  - \./.test(ws), '新 yaml 含 packages: [.]\n');
  assert(/onlyBuiltDependencies:\s*\n  - sharp/.test(ws), '新 yaml 含 onlyBuiltDependencies');
}

console.log(`\n总结: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
