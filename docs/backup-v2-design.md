# dsh-plugin-manager · 插件源备份 v2（已落地）

> 2026-08-16 · 状态：已实现并验证（scan → backup → restore 全链路）
> 补充 2026-08-16-dsh-plugin-backup-design.md 的实际落地版

## 核心思路

**问题**：现有备份只存 profile 配置文件（配方），插件本体代码不备份——魔改/自研/zip 包装的插件恢复后会丢。

**答案**：把插件按「能不能从上游一键重装」分三类：

```
能 pnpm add 重装的（纯净 npm / GitHub 源）  → pointer（只存指针）
不能重装的本地物（link 目录 / zip / patch）  → blob-raw（原样存）
魔改 / 自研代码                              → blob-modified（存完整源码）
```

判定依据 = `pnpm-lock.yaml` 的 `importers → . → dependencies`（**直接依赖才是插件清单**，
node_modules 里其余 128 项全是传递依赖，pnpm 能重装，不用备份）。

## 三个新模块（lib/）

| 模块 | 职责 | 关键逻辑 |
|---|---|---|
| `plugin-scanner.js` | 扫描 profile → `PluginSpec[]` | 解析 lockfile importers 段；判定 installKind（link/git/registry/github-tarball）；算目录指纹 sha256；symlink 插件按 realpath 目标算 |
| `plugin-backup.js` | 按 spec 落盘 | pointer 只写 spec.json；blob 复制 content/（**排除 node_modules/.git**）；写 index.json |
| `plugin-restore.js` | 按 spec 还原 | 默认 dry-run；pointer 生成 `pnpm add` 命令；blob 复制 content/ 回原位（覆盖前先 rename 备份可回滚） |

## 存储布局

```
<dataDir>/backups-v2/<profile>/<timestamp>/
└── plugins/
    ├── index.json              # 全量 PluginSpec[]（还原用）
    ├── <safeName>/             # 每个插件一个目录
    │   ├── spec.json           # 独立 spec（容错）
    │   └── content/            # blob 内容（pointer 无此目录）
```

## 后端端点（routes/api.js）

| 端点 | 用途 |
|---|---|
| `GET /api/v2/scan?profile=X` | 扫描预览（返回 PluginSpec[]） |
| `POST /api/v2/backup {profile, marks}` | 备份落盘 |
| `GET /api/v2/backups` | 历史列表（按 profile 分组） |
| `POST /api/v2/restore {profile, timestamp, apply}` | dry-run 预览 / apply 恢复 |

## 前端（app/manager.js）

顶栏新增「📦 插件源」按钮 → modal：扫描预览表（策略/来源/版本/文件数/指纹）→
立即备份 → 历史列表（预览恢复 / 应用恢复）。

## 验证记录（真实数据）

- 扫描 `~/.dsh/profiles/web`：5 个直接依赖，分类正确
  - `@anionex/dsh-vision-toolkit` → blob-raw（🔗 symlink 指向 dsh-workspace）
  - 4 个 pointer（registry 1 + github-tarball 2 + git 1）
- 备份：blob 5.93MB / 217 文件（排除 node_modules 后）；指纹与扫描一致
- 恢复 dry-run：5 条命令正确生成
- 全部测试：scanner 13/13、backup 14/14、restore 5/5，HTTP 端点 + UI 全流程验证

## 已知边界（未做，后续可选）

1. **✅ 已做（本轮）**：dsh-workspace 级快照——`lib/workspace.js` 备份整个 `dsh-workspace/`（13 个条目：token-tracker、补丁脚本、zip、bat 等），复用 v2 体系，落盘 `backups-v2/workspace/<ts>/`
2. **`marks` 魔改标记**：路由已支持 `marks` 参数（强制升级 blob-modified），UI 尚未暴露——用户改完源码后可以在未来加"标记此插件已魔改"
3. **zip 源溯源**：从 zip 装的插件，profile 不记录来源——需要 dsh-plugin-manager 安装时写 `install-manifest.json` 才能自动识别（目前会当作 registry/unknown 处理）
4. **pointer 插件应用恢复**：dry-run 已生成 pnpm 命令，但 UI 的"应用恢复"只恢复了 blob 插件——pointer 插件需手动在 profile 里跑 pnpm add（或后续接 runDsh 自动执行）
5. **工作区恢复入口**：本轮只做了工作区备份（scan + backup），恢复（restore）尚未接 UI——可从备份目录手动复制回 dsh-workspace/

## 经验教训

- **PowerShell `Set-Content -NoNewline` 会把源码压成单行**，ESM import 全错位导致模块导出为空（routes 404 根因）——改源码一律用 write/edit 工具，同步用 node 脚本
- **pnpm 9 hoisted 模式**：node_modules 里 package.json 不写 `_resolved`/`_integrity`，魔改检测不能靠这两个字段，用目录指纹 + 用户标记
- **symlink 插件**（link: 装法）：备份/指纹都按 realpath 目标算，否则还原后断链
