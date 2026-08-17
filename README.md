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
| **dsh 命令** | `dsh plugin --profile web add <pkg>` | 白名单校验后直接执行 |
| **npx 命令** | `npx <pkg>` / `npx dsh plugin add <pkg>` | 归一化为 dsh 安装（见下） |

不管哪种来源，都会：
- **自动备份** profile 的 `package.json` / `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml`
- **自动写入** `dsh.profile.bundles` 列表
- **自动 insert** 到 `cordis.patch.yml`
- **自动 pnpm install** 拉新依赖

### npx 命令怎么处理

「命令安装」tab 同时吃 `dsh` 和 `npx` 两种写法。npx 形式**不会原样执行**，而是按 DeepSeek Harness
的安装规范归一化到 dsh CLI：

| 你粘贴的 | 实际执行 |
|---|---|
| `npx dsh plugin --profile web add pkg` | `dsh plugin --profile web add pkg`（剥掉 npx 外壳，用本地 dsh） |
| `npx -y dsh plugin add pkg` | `dsh plugin --profile <UI 选中> add pkg` |
| `npx @scope/some-plugin` | `dsh plugin --profile <UI 选中> add @scope/some-plugin` |

**为什么不直接跑 npx：**

1. DSH 的安装规范（`package.json.dependencies` + `dsh.profile.bundles` + `cordis.patch.yml` +
   `pnpm install`）只有 dsh CLI 写得全。`npx <任意包>` 写不全这些文件，装完 DSH 起不来。
2. 原样执行 npx = 任意代码执行，与本插件「参数白名单」的安全基线冲突。
3. 本地已装的 dsh 已经绑定当前 `DSH_HOME`，比 npx 临时拉的 CLI 可靠。

只有本地找不到 `dsh` 时，`npx dsh plugin ...` 才会真的退化去 spawn npx 拉官方 CLI。

#### 包名探测（只对 `npx <pkg>` 转译路径）

`npx` 的语义是“跑一个 CLI”，它后面的包**未必是插件本体**——也可能是个安装器脚本，或者干脆是打错的名字。
所以转译前会先查一次 registry 元数据，做**三态判定**（不是布尔值）：

| 判定 | 含义 | 行为 |
|---|---|---|
| `dsh-plugin` | 有 `dsh.bundle` 字段 / 依赖 cordis、`@deepseek-ai/dsh*` / keywords 命中 | 直接放行 |
| `unknown` | 包存在，但看不出 DSH 插件特征 | 弹窗要求确认后才装 |
| `not-found` | registry 上没这个包 | 直接拒（省掉一整轮 pnpm 等待） |
| `probe-failed` | 超时 / 离线 / 内网 | **不阻断**，只给警告 |

设计取舍：**宁可 `unknown` 也不误杀**。DSH 生态没有强制元数据规范，判定只能靠特征聚合；
包名长得像（`dsh-xxx`）、带 `bin` 字段这类**弱信号只展示不判定**。
后端执行时会再探一次（带 60s 缓存，不重复打网络），防止直接打 API 绕过 UI 把关。

##### 探测源 == 安装源（重要）

探测用哪个 registry，必须跟 `dsh` 实际装包的源一致。否则会出现
“探测说有但装不上” / “探测说没有其实能装”——一个替另一个服务器背书的把关，比不把关更害人。

`dsh plugin add` 内部调 pnpm，pnpm 的 registry 由 **`.npmrc` 层级**决定：

```
profile 目录 .npmrc  >  用户 ~/.npmrc  >  npm 全局配置  >  内置默认
```

所以探测在 profile 目录下跑 `npm config get registry`（让 npm 自己合并层级），
拿到的就是装包时会用的那个地址。

插件设置里的 `registry` 字段：

- **留空（默认，推荐）** —— 完全跟随 `.npmrc`，探测与安装天然一致
- **填了** —— 同时作用于探测和安装（安装侧通过 `npm_config_registry` 环境变量注入，
  因为 `dsh` 不透传 `--registry`），两边仍然不会错位

> 旧版本这个字段默认 `npmmirror` 且**在 UI 安装路径上不生效**（只影响 Agent 工具的 pnpm 直调）。
> v0.2.1 修正：默认改为空，并让它在两条路径上都真正生效。

实网验证样本：

```
@nanmicoder/dsh-agent-teams  -> dsh-plugin  (dsh.bundle + 依赖 + keywords 三重信号)
@anionex/dsh-vision-toolkit  -> dsh-plugin
lodash                       -> unknown
create-react-app             -> unknown     (带 bin 的 CLI，npx 跑它是执行命令不是装插件)
```

安全边界（两种形式都生效）：命令含 `&& | ; \` $ ( ) < >` 直接拒；`npx -c/--call` 拒；
包名 / profile 名走字符集白名单；全程不拼 shell 字符串，spawn 只接参数数组。

解析器单测：`node scripts/parse-cmd-test.mjs`（36 条用例，覆盖每一条拒绝路径）。
探测器单测：`node scripts/pkg-probe-test.mjs`（加 `--online` 跑真实 registry）。

### 装前格式检查（zip 安装）

zip 安装前会解压到临时目录校验包结构：`package.json` 必需字段、`dsh.bundle.patch` 声明、
`cordis.patch.yml` 是否存在、`main` 指向的产物是否已 build。

> 注意：这是**格式检查**，不是安全扫描。它只回答“这个包能不能装、装了 dsh 能不能起来”，
> 不回答“这个包安不安全”。插件代码本身的可信度需要你自己判断。

## 功能清单

- 列出所有 profile（web / headless / tui 等）
- 每个 profile 下看到所有 bundle 插件（来源标签 / 版本 / 启用状态）
- 三 tab 安装向导：本地 zip / 命令安装（dsh、npx）/ GitHub URL
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
| `registry` | 空（= 跟随 `.npmrc`） | npm 源覆盖；填了同时作用于探测与安装 |

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
