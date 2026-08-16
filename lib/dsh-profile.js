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
  // 先去掉注释和空行
  const lines = text.split('\n');
  const rows = [];

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
            entry[kvMatch[1]] = kvMatch[2];
          }
          i += 1;
          // 继续吃同一 entry 的多行属性
          while (i < lines.length) {
            const next = lines[i];
            if (!next.trim()) { i += 1; continue; }
            // 缩进必须比 "- " 更深
            if (next.search(/\S/) <= dashIdx) break;
            const subMatch = next.trim().match(/^([\w-]+):\s*(.*)$/);
            if (subMatch) entry[subMatch[1]] = subMatch[2];
            i += 1;
          }
          row.entries.push(entry);
        }
        rows.push(row);
        continue;
      }

      // - id: xxx, 其它属性
      const m = afterDash.match(/^([\w-]+):\s*(.*)$/);
      if (m) row[m[1]] = m[2];
      i += 1;
      // 吃多行属性
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) { i += 1; continue; }
        // 必须是更深缩进（多 2 空格以上）
        if (!cur.startsWith(' ') && !cur.startsWith('\t')) break;
        const kvMatch = cur.trim().match(/^([\w-]+):\s*(.*)$/);
        if (kvMatch) row[kvMatch[1]] = kvMatch[2];
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

  // 用 patch 找出 disabled / insert 的 id
  const disabledIds = new Set();
  const insertIds = new Set();
  for (const row of patchRows) {
    if (row.disabled === 'true') disabledIds.add(row.id);
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
    let enabled = !disabledIds.has(bundleName);
    // 如果在 insert 列表里，强制 enabled
    if (insertIds.has(bundleName)) enabled = true;
    return {
      id: bundleName,
      source: isCore ? 'core' : (pkgInfo?.source || 'unknown'),
      version: pkgInfo?.version || null,
      detail: pkgInfo?.detail || null,
      enabled,
      inPatch: patchRows.some((r) => r.id === bundleName) || insertIds.has(bundleName),
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

  // 3) cordis.patch.yml —— 添加 insert 项
  const rows = parseCordisPatch(dshHome, profileName);
  // 检查是否已经在 patch 中（id 或 entry.id）
  const exists = rows.some((r) =>
    (r.id && r.id === key) ||
    (r.type === 'insert' && r.entries?.some((e) => e.id === key))
  );
  if (!exists) {
    rows.push({ type: 'insert', entries: [{ id: key, name: key }] });
    writeText(
      path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
      serializeCordisPatch(rows)
    );
  }
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

  if (enabled) {
    // 启用：移除所有 disabled=true 的同 id row，确保有 insert 行
    const cleaned = rows
      .map((r) => {
        if (r.type === 'insert') return r;
        if (r.id === id) return null; // 删掉 disabled row
        return r;
      })
      .filter(Boolean);
    // 没有 insert 就加一个
    const hasInsert = cleaned.some((r) =>
      r.type === 'insert' && r.entries?.some((e) => e.id === id)
    );
    if (!hasInsert) {
      cleaned.push({ type: 'insert', entries: [{ id, name: id }] });
    }
    writeText(
      path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
      serializeCordisPatch(cleaned)
    );
  } else {
    // 禁用：从 insert 里移除，并加 disabled:true row
    const cleaned = rows
      .map((r) => {
        if (r.type === 'insert') {
          r.entries = (r.entries || []).filter((e) => e.id !== id);
          return r.entries.length > 0 ? r : null;
        }
        return r;
      })
      .filter(Boolean);
    if (!cleaned.some((r) => r.id === id && r.disabled === 'true')) {
      cleaned.push({ id, disabled: 'true' });
    }
    writeText(
      path.join(profileDir(dshHome, profileName), 'cordis.patch.yml'),
      serializeCordisPatch(cleaned)
    );
  }
}
