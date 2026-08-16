// lib/dsh-profile.js — DSH Profile 读写器
//
// DSH 每个 profile 是 $DSH_HOME/profiles/<name>/ 下的独立 pnpm 工作区，
// 由三件套驱动：
//   - cordis.yml          : 基础 plugin 清单（来自 @deepseek-ai/dsh-base 等 bundle）
//   - cordis.patch.yml    : 用户 patch 层（启用/禁用/insert）—— 直接编辑这个就够
//   - package.json        : dependencies + dsh.bundles 列表 —— 真正决定 npm 包
//   - pnpm-workspace.yaml : pnpm 工作区设置
//
// 本模块只做安全的纯文本读写，不做执行。每个写操作都返回"前后对比"以便前端预览。
///
//
import fs from 'node:fs';
import path from 'node:path';
import { listMarksForProfile } from './plugin-marks.js';

// ---------------------------------------------------------------------------
// YAML 极简读写（cordis.patch.yml 是简单的 YAML 数组 / !js 表达式）
// ---------------------------------------------------------------------------
// 不引入 js-yaml 依赖，理由：
//   1) cordis.patch.yml 99% 的情况是空数组 `[]` 或 `insert: [{id, name, ...}]`
//   2) 引入新依赖会触发 pnpm install 网络
//   3) 用正则做最小解析，对格式错误的输入直接报错让用户改
//
// 复杂的 cordis.yml（base 层）不需要我们读 —— 它是只读的 bundle 来源。
// 我们要写的主要是 cordis.patch.yml 和 package.json（JSON，安全）。
//
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function writeText(filePath, content) {
  // 原子写：先写 .tmp 再 rename
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
export function profileDir(dshHome, profileName) {
  return path.join(dshHome, 'profiles', profileName);
}

export function listProfiles(dshHome) {
  const root = path.join(dshHome, 'profiles');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // 过滤误识别：node_modules、.git、.DS_Store 等
    .filter((e) => !['node_modules', '.git'].includes(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name);
}

export function profileExists(dshHome, profileName) {
  return fs.existsSync(profileDir(dshHome, profileName));
}

// ---------------------------------------------------------------------------
// cordis.yml / cordis.patch.yml
// ---------------------------------------------------------------------------
// 这两个文件本质是 YAML list，patch.yml 格式：
//   []                            # 空
//   - id: foo                      # disable
//     disabled: true
//   - insert:                      # insert
//       - id: bar
//         name: '@scope/bar'
//
export function readCordisPatch(dshHome, profileName) {
  const file = path.join(profileDir(dshHome, profileName), 'cordis.patch.yml');
  if (!fs.existsSync(file)) return '[]\n';
  return readText(file);
}

/**
 * 解析 cordis.patch.yml，返回结构化的 patch rows
 * 注意：这是简化版解析，不支持嵌套复杂表达式，遇到解析不了会抛错
 */
export function parseCordisPatch(dshHome, profileName) {
  const text = readCordisPatch(dshHome, profileName);
  return parseCordisPatchText(text);
}

export function parseCordisPatchText(text) {
  // 去掉注释和空行
  const lines = text.split('\n');
  const rows = [];

  // YAML 标量去引号：'xxx' / "xxx" → xxx（patch 里 name 常带引号）
  const stripScalar = (v) => {
    v = (v || '').trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      return v.slice(1, -1);
    }
    return v;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }

    // 顶层数组项：- id: ... / - insert: ...
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      const row = {};
      const afterDash = trimmed.slice(1).trim();

      // - insert: （这种是嵌套 list 操作）
      if (afterDash.startsWith('insert:')) {
        row.type = 'insert';
        // 接下来几行是 insert list 的成员
        row.entries = [];
        i += 1;
        // 跳过空行
        while (i < lines.length && !lines[i].trim()) i += 1;
        // 收集 insert 列表成员（以 "      -" 开头的，即比 - 多缩进的项）
        while (i < lines.length) {
          const cur = lines[i];
          if (!cur.trim()) { i += 1; continue; }
          // 看缩进：必须是比顶层 "- " 多 2 个以上空格
          const dashIdx = cur.indexOf('- ');
          if (dashIdx < 2) break;
          // 解析 "- id: foo, name: bar" 或 "- id: foo\n        name: bar"
          let rest = cur.slice(dashIdx + 2).trim();
          const entry = {};
          // 解析 key: value
          const kvMatch = rest.match(/^([\w-]+):\s*(.*)$/);
          if (kvMatch) {
            entry[kvMatch[1]] = stripScalar(kvMatch[2]);
          }
          i += 1;
          // 继续吃同一 entry 的多行属性
          while (i < lines.length) {
            const next = lines[i];
            if (!next.trim()) { i += 1; continue; }
            // 缩进必须比 "- " 更深
            if (next.search(/\S/) <= dashIdx) break;
            const subMatch = next.trim().match(/^([\w-]+):\s*(.*)$/);
            if (subMatch) entry[subMatch[1]] = stripScalar(subMatch[2]);
            i += 1;
          }
          row.entries.push(entry);
        }
        rows.push(row);
        continue;
      }

      // - id: xxx, 其它属性
      const m = afterDash.match(/^([\w-]+):\s*(.*)$/);
      if (m) row[m[1]] = stripScalar(m[2]);
      i += 1;
      // 吃多行属性
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) { i += 1; continue; }
        // 必须是更深缩进（多 2 空格以上）
        if (!cur.startsWith(' ') && !cur.startsWith('\t')) break;
        const kvMatch = cur.trim().match(/^([\w-]+):\s*(.*)$/);
        if (kvMatch) row[kvMatch[1]] = stripScalar(kvMatch[2]);
        i += 1;
      }
      rows.push(row);
      continue;
    }

    // 兜底：跳过这一行（容错）
    i += 1;
  }
  return rows;
}

export function serializeCordisPatch(rows) {
  if (!rows || rows.length === 0) return '[]\n';
  const out = [];
  for (const row of rows) {
    if (row.type === 'insert') {
      out.push('- insert:');
      for (const e of row.entries || []) {
        const entries = Object.entries(e);
        if (entries.length === 0) continue;
        const [firstKey, firstVal] = entries[0];
        out.push(`    - ${firstKey}: ${firstVal}`);
        for (let j = 1; j < entries.length; j += 1) {
          const [k, v] = entries[j];
          out.push(`      ${k}: ${v}`);
        }
      }
    } else {
      const entries = Object.entries(row);
      const [firstKey, firstVal] = entries[0];
      out.push(`- ${firstKey}: ${firstVal}`);
      for (let j = 1; j < entries.length; j += 1) {
        const [k, v] = entries[j];
        out.push(`  ${k}: ${v}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
export function readPackageJson(dshHome, profileName) {
  const file = path.join(profileDir(dshHome, profileName), 'package.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(readText(file));
}

export function writePackageJson(dshHome, profileName, pkg) {
  const file = path.join(profileDir(dshHome, profileName), 'package.json');
  writeText(file, JSON.stringify(pkg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// cordis patch 路径解析
// ---------------------------------------------------------------------------
// 每个 bundle 包的 cordis patch 文件：包根目录的 cordis.patch.yml，或
// package.json 的 dsh.bundle.patch 指向的文件（如 "./cordis.patch.yml"）。
function bundlePatchPath(dshHome, profileName, bundleName) {
  const pkgDir = path.join(profileDir(dshHome, profileName), 'node_modules', bundleName);
  // package.json 的 dsh.bundle.patch 优先（标准字段）
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (pj.dsh?.bundle?.patch) {
      const p = path.resolve(pkgDir, pj.dsh.bundle.patch);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  const fallback = path.join(pkgDir, 'cordis.patch.yml');
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * 读取某 bundle 包的 cordis 插件 id 列表。
 *
 * 关键：cordis 的 row id ≠ 包名（例：dsh-usage-stats 包 insert 的 row id 是 usage-stats）。
 * 禁用/启用必须用 cordis id，否则 dsh 的 applyEntryPatches 在 bundle 层找不到目标会静默跳过。
 *
 * 规则：只取 patch 里 name === 包名 的 row（插件本体）。name !== 包名 的是 patch 到别的
 * 共享 row（如 @nanmicoder/dsh-auto-mode 会 patch 核心 permission 服务），禁用时不能动。
 */
export function cordisIdsOfBundle(dshHome, profileName, bundleName) {
  const patchPath = bundlePatchPath(dshHome, profileName, bundleName);
  if (!patchPath) return [];
  let rows;
  try {
    rows = parseCordisPatchText(fs.readFileSync(patchPath, 'utf8'));
  } catch { return []; }
  const ids = [];
  for (const r of rows) {
    if (r.type === 'insert') {
      for (const e of r.entries || []) {
        if (e.name === bundleName && e.id) ids.push(e.id);
      }
    } else if (r.name === bundleName && r.id) {
      ids.push(r.id);
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// 高层 API：列出 / 安装 / 卸载 / 启用 / 禁用
// ---------------------------------------------------------------------------
//
/**
 * 列出 profile 的所有 plugin（含来源、版本、启用状态）
 * 数据来源：
 *   - package.json.dependencies        (实际安装的 npm 包)
 *   - package.json.dsh.profile.bundles (DSH 启用的 bundle 名)
 *   - cordis.patch.yml                (用户层 patch，含 disabled / insert)
 */
export function listPlugins(dshHome, profileName, dataDir) {
  const pkg = readPackageJson(dshHome, profileName);
  if (!pkg) return { bundles: [], dependencies: [], patch: [] };

  const bundles = pkg.dsh?.profile?.bundles || [];
  const deps = pkg.dependencies || {};
  const patchRows = parseCordisPatch(dshHome, profileName);

  // 用 patch 找出 disabled / insert 的 cordis id（注意：cordis id ≠ 包名，必须逐包解析）
  const disabledRows = new Map();   // cordisId -> true
  const insertIds = new Set();      // 用户层 insert 里的 entry.id
  for (const row of patchRows) {
    if (row.disabled === 'true' && row.id) disabledRows.set(row.id, true);
    if (row.type === 'insert') {
      for (const e of row.entries || []) if (e.id) insertIds.add(e.id);
    }
  }

  // bundle → dep 映射：bundle 名 = dependencies 中的 key
  const pluginMarks = dataDir ? listMarksForProfile(dataDir, profileName) : {};
  const result = bundles.map((bundleName) => {
    const depSpec = deps[bundleName] || null;
    const pkgInfo = depSpec ? parseDepSpec(depSpec) : null;
    // core bundle: 在 dsh.profile.bundles 里、但不在 dependencies 里 → 跟随 dsh-hanako 主包内置
    // （例：@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app），不是用户装的插件，不应该被启用/卸载/标 FORK
    const isCore = !depSpec;
    // 该插件的 cordis row id（包内 patch 里 name===包名的 row）——禁用/启用的正确目标
    const cordisIds = isCore ? [] : cordisIdsOfBundle(dshHome, profileName, bundleName);
    // enabled = 没有被 disabled（按 cordis id 匹配）；用户层 insert 里若有（旧版错误写法 id===包名）不算启用信号
    // enabled = 没有被 disabled（按 cordis id 匹配）；兼容旧版错误写法（disabled 行用包名）
    const disabled = cordisIds.some((cid) => disabledRows.has(cid));
    let enabled = !(disabled || disabledRows.has(bundleName));
    return {
      id: bundleName,
      source: isCore ? 'core' : (pkgInfo?.source || 'unknown'),
      version: pkgInfo?.version || null,
      detail: pkgInfo?.detail || null,
      enabled,
      cordisIds,
      inPatch: patchRows.some((r) => r.id === bundleName || r.id === cordisIds[0]) || insertIds.has(bundleName),
      isCore,
      // 魔改标记：dataDir 可选（为不调用代码路径），传入时读取 plugin-marks.json
      isModified: !!(dataDir && pluginMarks && pluginMarks[bundleName]),
      markInfo: dataDir && pluginMarks && pluginMarks[bundleName] ? pluginMarks[bundleName] : null,
    };
  });

  // 不在 bundle 里但 dependencies 里有 —— 可能是 peerDep 或工具包，列出来供参考
  const extras = Object.entries(deps)
    .filter(([name]) => !bundles.includes(name))
    .map(([name, spec]) => {
      const info = parseDepSpec(spec);
      return {
        id: name,
        source: info.source,
        version: info.version,
        detail: info.detail,
        enabled: null,
        inPatch: false,
        isBundle: false,
      };
    });

  return {
    bundles: result,
    extras,
    patch: patchRows,
    packageJson: pkg,
    patchText: readCordisPatch(dshHome, profileName),
  };
}

/**
 * 解析 dependency 字符串，区分 npm / github / link / file / tarball
 * 例：
 *   "1.2.3"                          -> { source: 'npm', version: '1.2.3' }
 *   "^1.2.3"                         -> { source: 'npm', version: '^1.2.3' }
 *   "github:user/repo"               -> { source: 'github', detail: 'user/repo' }
 *   "github:user/repo#commit"        -> { source: 'github', detail: 'user/repo', version: '#commit' }
 *   "link:C:/path/to/dir"            -> { source: 'link', detail: 'C:/path/to/dir' }
 *   "file:../local"                  -> { source: 'file', detail: '../local' }
 *   "https://..."                    -> { source: 'url', detail: 'https://...' }
 */
export function parseDepSpec(spec) {
  if (!spec) return { source: 'unknown', version: null, detail: null };
  if (spec.startsWith('link:')) return { source: 'link', detail: spec.slice(5) };
  if (spec.startsWith('file:')) return { source: 'file', detail: spec.slice(5) };
  if (spec.startsWith('github:')) {
    const rest = spec.slice(7);
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) {
      return { source: 'github', detail: rest.slice(0, hashIdx), version: rest.slice(hashIdx) };
    }
    return { source: 'github', detail: rest };
  }
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return { source: 'url', detail: spec };
  }
  // 默认是 npm version spec
  return { source: 'npm', version: spec };
}

// ---------------------------------------------------------------------------
// 改写三件套
// ---------------------------------------------------------------------------
//
/**
 * 添加一个 bundle 到 profile
 * @param depsSpec "link:..." | "github:..." | "npm-version" | null
 *                 null 表示已经安装，只更新 bundles/patch
 */
export function addBundle(dshHome, profileName, { id, depsSpec, depsKey }) {
  const pkg = readPackageJson(dshHome, profileName);
  if (!pkg) throw new Error(`profile ${profileName} 不存在或 package.json 缺失`);

  const key = depsKey || id;

  // 1) package.json.dependencies
  pkg.dependencies = pkg.dependencies || {};
  if (depsSpec) pkg.dependencies[key] = depsSpec;

  // 2) package.json.dsh.profile.bundles
  const bundles = (pkg.dsh?.profile?.bundles) || [];
  if (!bundles.includes(key)) bundles.push(key);
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = bundles;

  writePackageJson(dshHome, profileName, pkg);
  // 注意：不写 cordis.patch.yml 的 insert——bundle 包自带 cordis patch（node_modules 里），
  // 用户层 insert 用包名写会导致同插件加载两次（2026-08-16 修复禁用链路的教训）。
}

export function removeBundle(dshHome, profileName, id) {
  const pkg = readPackageJson(dshHome, profileName);
  if (!pkg) throw new Error(`profile ${profileName} 不存在或 package.json 缺失`);

  // 1) package.json.dependencies
  pkg.dependencies = pkg.dependencies || {};
  delete pkg.dependencies[id];

  // 2) package.json.dsh.profile.bundles
  const bundles = (pkg.dsh?.profile?.bundles) || [];
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = bundles.filter((b) => b !== id);

  writePackageJson(dshHome, profileName, pkg);

  // 3) cordis.patch.yml —— 移除相关 row
  const rows = parseCordisPatch(dshHome, profileName);
  const filtered = rows.filter((r) => {
    if (r.id === id) return false;
    if (r.type === 'insert') {
      const before = r.entries?.length || 0;
      r.entries = (r.entries || []).filter((e) => e.id !== id);
      return (r.entries?.length || 0) > 0; // 空 insert 整段删掉
    }
    return true;
  });
  writeText(
    path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
    serializeCordisPatch(filtered)
  );
}

export function setBundleEnabled(dshHome, profileName, id, enabled) {
  const rows = parseCordisPatch(dshHome, profileName);
  // cordis 插件 id ≠ 包名（如 dsh-usage-stats 包的 row id 是 usage-stats）。
  // 必须读该包 bundle patch 里 name===包名 的 row id，否则禁用 patch 找不到目标被 dsh 静默跳过。
  const cordisIds = cordisIdsOfBundle(dshHome, profileName, id);
  if (cordisIds.length === 0) {
    throw new Error(`插件 ${id} 未找到 cordis patch（包内 cordis.patch.yml 缺失或没有 name===${id} 的 row），无法通过 UI 切换启用状态`);
  }

  if (enabled) {
    // 启用：移除所有 disabled 行（id ∈ cordisIds）；清理历史错误 insert（bundle 层已 insert，
    // 用户层写 insert 会造成同一插件加载两次——旧版代码用包名写过这种行）。
    const cleaned = rows
      .map((r) => {
        if (r.type === 'insert') {
          // 删掉 id 属于本插件 cordisIds 的 entry；也删掉 name===包名 的错误 entry（旧版遗留）
          r.entries = (r.entries || []).filter((e) =>
            !cordisIds.includes(e.id) && e.name !== id);
          return r.entries.length > 0 ? r : null;
        }
        // 删掉 disabled 本插件的行（r.id 在 cordisIds 里，或旧版错误写法 r.id===包名）
        if (cordisIds.includes(r.id) || r.id === id) return null;
        return r;
      })
      .filter(Boolean);
    writeText(
      path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
      serializeCordisPatch(cleaned)
    );
  } else {
    // 禁用：从 insert 里移除本插件 entry，然后为每个 cordis id 写 disabled:true 行
    const cleaned = rows
      .map((r) => {
        if (r.type === 'insert') {
          r.entries = (r.entries || []).filter((e) =>
            !cordisIds.includes(e.id) && e.name !== id);
          return r.entries.length > 0 ? r : null;
        }
        return r;
      })
      .filter(Boolean);
    for (const cid of cordisIds) {
      if (!cleaned.some((r) => r.id === cid && r.disabled === 'true')) {
        cleaned.push({ id: cid, disabled: 'true' });
      }
    }
    writeText(
      path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
      serializeCordisPatch(cleaned)
    );
  }
}
