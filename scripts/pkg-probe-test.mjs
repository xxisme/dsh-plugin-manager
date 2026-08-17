/**
 * scripts/pkg-probe-test.mjs — 包名探测器单测
 *
 * 跑法：
 *   node scripts/pkg-probe-test.mjs          # 只跑离线用例（纯函数）
 *   node scripts/pkg-probe-test.mjs --online # 额外跑真实 registry 探测
 *
 * 判定逻辑是「特征聚合」而不是布尔开关，所以用例重点在：
 *   1) 强/中信号必须命中 dsh-plugin
 *   2) 弱信号（包名像、有 bin）绝不能单独判定为插件 —— 宁可 unknown 也不误杀
 */

import { splitPkgSpec, judgeDshFeatures, probeDshPackage, resolveEffectiveRegistry } from '../lib/pkg-probe.js';

let pass = 0;

// ── bin 反向证据能降级正面信号 ──
// 2026-08-17 review 加：这是 P0-2 的单点护栏。
// 场景：发布者 keywords 写了 dsh、又 depend 了 dsh-*（这些都能命中正面信号），
// 同时又是个带 bin 的 CLI——这正是探测器要防的「npx 跑安装器」那一类。
// 如果 bin 不参与 verdict，这一条就会被判绿一路放行。
group('bin 反向证据能降级正面信号');
{
  const r = judgeDshFeatures({
    name: '@evil/dsh-fake',
    keywords: ['dsh'],
    dependencies: { '@deepseek-ai/dsh-agent': '*' },
    bin: { 'evil-cli': './evil.js' },
  });
  check('keywords+bin → unknown', r.verdict, 'unknown');
  check('bin 提示写进 weak', r.weak.some((w) => w.includes('bin')), true);
}
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

// ── spec 拆分 ──
group('包名/版本拆分');
check('普通包', splitPkgSpec('pkg'), { name: 'pkg', version: null });
check('普通包带版本', splitPkgSpec('pkg@1.2.3'), { name: 'pkg', version: '1.2.3' });
check('scoped 包', splitPkgSpec('@scope/pkg'), { name: '@scope/pkg', version: null });
check('scoped 包带版本', splitPkgSpec('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' });
check('scoped 带 tag', splitPkgSpec('@scope/pkg@latest'), { name: '@scope/pkg', version: 'latest' });
check('空值', splitPkgSpec(''), { name: '', version: null });

// ── 特征判定 ──
group('DSH 特征判定（强/中信号 → dsh-plugin）');
check('dsh.bundle 字段', judgeDshFeatures({ name: 'x', dsh: { bundle: { patch: './c.yml' } } }).verdict, 'dsh-plugin');
check('仅 dsh 字段', judgeDshFeatures({ name: 'x', dsh: {} }).verdict, 'dsh-plugin');
check('依赖 cordis', judgeDshFeatures({ name: 'x', dependencies: { cordis: '^3' } }).verdict, 'dsh-plugin');
check('依赖 @cordisjs/*', judgeDshFeatures({ name: 'x', peerDependencies: { '@cordisjs/core': '^3' } }).verdict, 'dsh-plugin');
check('依赖 @deepseek-ai/dsh*', judgeDshFeatures({ name: 'x', devDependencies: { '@deepseek-ai/dsh-base': '^1' } }).verdict, 'dsh-plugin');
check('keywords 含 dsh', judgeDshFeatures({ name: 'x', keywords: ['DSH', 'tool'] }).verdict, 'dsh-plugin');

group('弱信号不足以判定（→ unknown）');
{
  const r = judgeDshFeatures({ name: 'dsh-something' });
  check('包名像但无实证 → unknown', r.verdict, 'unknown');
  check('弱信号被记录', r.weak.length > 0, true);
}
{
  const r = judgeDshFeatures({ name: '@scope/dsh-installer', bin: { 'dsh-installer': './cli.js' } });
  check('带 bin 的 CLI → unknown', r.verdict, 'unknown');
  check('bin 提示写进 weak', r.weak.some((w) => w.includes('bin')), true);
}
check('完全无关的包 → unknown', judgeDshFeatures({ name: 'lodash', description: 'utils' }).verdict, 'unknown');
check('空对象不炸', judgeDshFeatures({}).verdict, 'unknown');
check('null 不炸', judgeDshFeatures(null).verdict, 'unknown');

// ── registry 解析：探测源必须 == 安装源 ──
group('registry 解析（跟随实际安装源）');
{
  const reg = resolveEffectiveRegistry();
  check('返回合法 http(s) 地址', /^https?:\/\/[^\s]+$/.test(reg), true);
  check('不带尾斜杠', reg.endsWith('/'), false);
  console.log(`     当前解析到：${reg}`);
}
{
  // 不存在的 cwd 不能把流程弄崩（降级到全局/默认）
  const reg = resolveEffectiveRegistry('C:/this/path/does/not/exist/xyz');
  check('无效 cwd 不报错', /^https?:\/\//.test(reg), true);
}

// ── 非 registry 源跳过 ──
group('非 npm 源跳过探测');
for (const spec of ['github:owner/repo', 'link:C:/x/y', 'file:../z', 'git+https://a.com/b#c', 'https://x/y.tgz']) {
  const r = await probeDshPackage(spec);
  check(spec, r.verdict, 'skipped');
}

// ── 联网用例（可选） ──
if (process.argv.includes('--online')) {
  group('真实 registry 探测（联网）');
  {
    // lodash 一定存在、且一定不是 DSH 插件 → unknown（验证不误杀也不误判）
    const r = await probeDshPackage('lodash');
    check('lodash → unknown', r.verdict, 'unknown');
  }
  {
    const r = await probeDshPackage('this-package-should-never-exist-xyz-20260817');
    check('不存在的包 → not-found', r.verdict, 'not-found');
  }
  {
    // cordis 本体带 keywords/特征，验证正向命中
    const r = await probeDshPackage('cordis');
    console.log(`     cordis 判定 = ${r.verdict}，信号: ${JSON.stringify(r.signals)}`);
  }
} else {
  console.log('\n（跳过联网用例，加 --online 可运行）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
