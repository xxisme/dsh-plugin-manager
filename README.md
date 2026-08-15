# DSH 插件管理

管理本机 **DeepSeek Harness** (DSH) 的 profile 插件，让你在 hanaagent 里直接装 / 卸 / 启 / 禁 DSH 插件，**不用再被 git 拉取和 npm 装包失败折磨**。

## 它解决什么问题

DSH 插件本质是 npm 包，但日常装插件有两类典型坑：

1. **网络问题**：`npm install / pnpm add` 在国内经常超时，特别是装带 `node-gyp` native build 的插件
2. **zip 包本地下载好却装不上**：`dsh plugin add <package>` 只会调 `pnpm add`，根本不认识本地 zip

DSH 插件管理把"读 `package.json` + `cordis.patch.yml` + 跑 `pnpm install` + 处理 link 路径"这一坨手工活做成了一个 UI + 工具。

## 支持的安装来源

| 来源 | 例子 | 行为 |
|---|---|---|
| **本地 zip** | `C:\downloads\my-plugin.zip` | 解压到 `profile/external/<name>/`，自动加 `link:`，跑 pnpm install |
| **本地已解压目录** | `C:\work\my-plugin\` | 复制到 `profile/external/<name>/`，同上 |
| **npm 包** | `@anionex/dsh-vision-toolkit` | 等价 `pnpm add` |
| **GitHub 仓库** | `github:user/repo` | 等价 `pnpm add github:user/repo` |

不管哪种来源，都会：
- **自动备份** profile 的 `package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml`
- **自动写入** `dsh.profile.bundles` 列表
- **自动 insert** 到 `cordis.patch.yml`
- **自动 pnpm install** 拉新依赖

## 功能清单

- 列出所有 profile（web / headless / tui 等）
- 每个 profile 下看到所有 bundle 插件（来源标签 / 版本 / 启用状态）
- 三 tab 安装向导：本地 zip / 本地目录 / npm+GitHub
- 一键启用 / 禁用（只改 `cordis.patch.yml`，不需要重启 npm）
- 一键卸载（可选删除本地 link 文件）
- 备份管理（自动备份 + 一键恢复 + 查看历史）
- 操作日志（最近 50 条，每 5 秒刷新）

## Agent 工具（让 Agent 也能用）

如果你是通过对话让 Agent 帮你装插件，可以直接说：

> "帮我把 D:\downloads\foo.zip 装到 web profile"
> "卸载 web 里的 dsh-better-sidebar"
> "禁用 web 里的 vision-toolkit"

Agent 会自动调用这些工具：

- `dsh_list_profiles` — 列出 profile
- `dsh_list_plugins` — 列出 profile 的插件
- `dsh_install_plugin` — 装插件（zip/local/registry）
- `dsh_uninstall_plugin` — 卸插件
- `dsh_toggle_plugin` — 启/禁插件

## 内部细节（你可能想知道）

DSH 的 profile 结构：

```
$DSH_HOME/profiles/<name>/
├── cordis.yml                # base 层插件（DSH 自己管）
├── cordis.patch.yml          # ★ 用户层（插件启用/禁用/insert 在这）
├── package.json              # ★ 实际依赖声明 + dsh.profile.bundles
├── pnpm-workspace.yaml       # pnpm 工作区设置
└── node_modules/             # pnpm 装出来的
```

我们改的是 `cordis.patch.yml` + `package.json` 这两个。`cordis.yml` 是 base 层，不动。

每次写操作前自动备份到 `${HANA_HOME}/plugins-dev-runs/dsh-plugin-manager/backups/<时间戳>/`，一键恢复。

## 安装

把 `dsh-plugin-manager/` 整个文件夹放到 `${HANA_HOME}/plugins/` 下（或用 hana 的 plugin dev tools 装），重启 hanaagent，在主页面里就能看到「DSH 插件」入口。

如果你想从源码装到 dev 槽位（不改 plugins/），让 Agent 调用：

```
plugin_dev_install({ sourcePath: "C:\\path\\to\\dsh-plugin-manager" })
```

## 配置

在 hana 插件设置里可以改：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dshHome` | 自动探测 `~/.dsh` | DSH 主目录 |
| `registry` | `https://registry.npmmirror.com` | pnpm install 用的镜像 |

## 安全注意

- 所有写操作前会自动备份，能一键恢复
- 操作会让 DSH 服务**需要重启**才能看到效果（pnpm install 完生效）
- 卸载时如果选「同时删除本地文件」，那个目录会被删掉（请谨慎）
- 浏览器内嵌的文件浏览 API 限制在 OS 用户主目录内，防止越权

## 已知限制

- 不处理带 native build（node-gyp）的依赖——这需要 pnpm run build，DSH 的 `allowBuilds` 配置才会生效
- 不支持多 profile 批量操作（一个一个来）
- DSH 服务运行中改 `cordis.patch.yml` 后，必须 `dsh` 重启才能看到效果（本插件不会自动重启 DSH）

## 文件结构

```
dsh-plugin-manager/
├── manifest.json            # 插件声明
├── index.js                 # 生命周期入口（探测 DSH_HOME）
├── package.json
├── lib/
│   ├── dsh-profile.js      # 读/写 cordis.yml / patch.yml / package.json
│   ├── pnpm-runner.js      # 调 pnpm install/add/remove
│   ├── zip-extractor.js    # 解压 zip + 找 package.json
│   ├── backup.js           # 备份/恢复
│   └── operation-log.js    # 操作日志
├── routes/
│   └── api.js              # HTTP 路由（/page + /api/*）
├── tools/                   # Agent 可调工具（5 个）
│   ├── dsh_list_profiles.js
│   ├── dsh_list_plugins.js
│   ├── dsh_install_plugin.js
│   ├── dsh_uninstall_plugin.js
│   └── dsh_toggle_plugin.js
└── app/
    ├── manager.css
    └── manager.js          # 前端 vanilla JS
```
