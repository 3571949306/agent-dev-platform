# Agent Dev Platform

> 本地 AI Agent IDE（智能体开发环境）—— 一个真正能读项目、改代码、跑命令、调子 Agent、把活干完的 Windows 桌面 Coding Agent。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4) ![electron](https://img.shields.io/badge/electron-31-47848F) ![node](https://img.shields.io/badge/node-20-339933) ![sqlite](https://img.shields.io/badge/sqlite-WAL-003B57) ![tests](https://img.shields.io/badge/tests-764%2B35-3fb950)

## 它能做什么

把一个本地仓库丢给 Main Agent，说一句「把 `utils.js` 的 `slugify` 函数改成支持中文」，它会自己：
读 → 改 → 跑测试 → 看到失败就再改 → 直到通过，然后把改动整理给你看。

* **读项目**：本地文件 / 目录树 / 文本与符号搜索 / git 历史
* **改代码**：结构化 patch + 行级上下文校验 + 失败重试
* **跑命令**：终端工具 + 进程树取消（防止 npm 之类的孙进程漏掉）
* **调子 Agent**：Reviewer / Computer / External（Codex / WorkBuddy Bridge）
* **随时停止**：AbortController 真的中断正在进行的 LLM 请求
* **多重校验**：权限门控（ask / once / always）+ 文件路径守卫 + 密钥不落明文

## 智能 API 快速接入

v2.4.0 新增。在「API 连接」页面点击 **⚡ 快速接入**，把 API 地址、密钥、ENV、JSON、curl、代码片段或 CC Switch 配置粘贴进去，平台自动识别 URL / Key / Provider / 协议，安全预览后一键检测连接、发现模型并分配给主智能体。详见 [`docs/SMART_API_ONBOARDING.md`](docs/SMART_API_ONBOARDING.md)。

## 外部 API 配置一键迁移

v2.5.0 新增。在「API 连接」页面点击 **📥 从其他工具导入**，可从 Codex、Claude Code、OpenCode、CC Switch、环境变量或配置文件（.env / JSON / TOML）一键迁移已有 API 配置。自动发现 → 预览 → 冲突检测 → 批量导入，全程只读、密钥掩码、不迁移账号登录态或 OAuth 凭据。详见 [`docs/EXTERNAL_CONFIG_IMPORT.md`](docs/EXTERNAL_CONFIG_IMPORT.md)。

## Main Agent 自主编码闭环

v2.6.0 新增。主智能体现在能独立走完整个编码任务，**不依赖外部智能体（Codex / WorkBuddy）**：

```
理解需求 → 读项目 → 分析代码 → 制定计划 → 修改文件 → 运行命令 → 测试 → 错误检测 → 修复 → 输出结果
```

* **状态机驱动**：`IDLE → PLANNING → READING_CONTEXT → EXECUTING → TESTING → EVALUATING → REPAIRING → COMPLETED`，外加 `FAILED` / `CANCELLED` / `TIMEOUT` / `WAITING_PERMISSION` 旁支终态。
* **结构化 Action**：17 种动作（read_file / apply_patch / run_command / git_* / finish …）走 JSON Schema 校验，无效输出累计超限即 FAILED，不假装完成。
* **Test → Repair Loop**：测试失败自动提取错误 → 进入修复 → 把失败信息喂回模型 → 重测，受 `maxIterations` / `maxRepairRounds` / `maxRuntimeMs` 五重限额保护。
* **模糊 Patch 匹配**：LLM 行号不准时按上下文在全文件搜索最相似位置应用，不再因行号偏差直接失败。
* **Run Timeline GUI**：底部时间线面板 + 右侧栏实时显示每一步（analyze / read / edit / run / repair / complete / error），plan 卡片 / action 卡片 / 修复横幅完整呈现。
* **随时停止**：AbortController 真正中断正在进行的模型请求与终端命令进程树，一个 runId 最多一个终态，Late Result 不覆盖 cancelled/timeout。

详见 [`docs/MAIN_AGENT_RUNTIME.md`](docs/MAIN_AGENT_RUNTIME.md)。

## Agent Integration Hub

v2.7.0 新增。把平台从「拥有多个 Agent 功能」升级为「可以统一管理和调度各种 Agent 的平台」。

```
                        Main Agent
                            │
                       Agent Router
                            │
                  Agent Integration Hub
                            │
       ┌────────────────────┼─────────────────────┐
       │                    │                     │
 Native Agents        External Agents         Future Agents
 ─────────────        ───────────────         ─────────────
 Main Coding          Codex                   Cline
 Research             WorkBuddy               OpenCode
 Computer             Claude Code             OpenHands
```

* **AgentAdapter 统一接口**：所有 Agent 通过同一接口接入（detect / healthCheck / startTask / cancel / getResult）
* **AgentRouter 确定性评分**：按 Capability 匹配 + Health + Busy 状态打分，可解释，不调用 LLM
* **Capability Registry**：17 种统一能力（coding / terminal / git / browser / computer / mcp 等）
* **Fallback Chain**：首选 Agent 失败自动切换，最多 3 次
* **当前已接入**：Native Agent / Codex / WorkBuddy
* **未来接入**（只需写 Adapter + 注册 Manifest + 通过 Contract Tests）：Cline / OpenCode / OpenHands

详见 [`docs/AGENT_INTEGRATION_HUB.md`](docs/AGENT_INTEGRATION_HUB.md)。

## ClineCore Sidecar Runtime

v2.7.3 makes Cline a real coding provider. Production runs the official `@cline/sdk 0.0.72` and `ClineCore` in a separately bundled Node.js 22.23.2 sidecar. Cline receives the current canonical project root, parent-authorized tool scopes, an in-memory API credential, and a project mutation lock before it can edit or run commands.

The Agent Center reports Node, SDK, sidecar, API, workspace, and overall health independently. A present runtime with a missing API connection is degraded—not healthy—and auto routing will not choose it. Use **Configure Cline** on the card to select an existing encrypted API connection and model.

```bash
npm run prepare-cline-runtime # verify/cache/stage pinned Node 22 + sidecar
npm run integration-smoke     # real ClineCore coding fixture, no paid provider
npm run e2e                   # includes Cline Cases 44-53
```

See [`docs/CLINE_SIDECAR_RUNTIME.md`](docs/CLINE_SIDECAR_RUNTIME.md), [`docs/CLINE_RUNTIME_DECISION.md`](docs/CLINE_RUNTIME_DECISION.md), and [`docs/UPSTREAM_REFERENCE_MATRIX.md`](docs/UPSTREAM_REFERENCE_MATRIX.md).

## 安装

> 完整安装包与免安装版在 `dist-electron/` 目录中（构建产物，请参见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)）。

### 方式一：安装版（推荐）
双击 `dist-electron/Agent Dev Platform Setup 2.0.0.exe` 运行 NSIS 安装程序，按提示选择目录。
安装后从开始菜单或桌面快捷方式启动。

### 方式二：免安装版
直接运行 `dist-electron/win-unpacked/Agent Dev Platform.exe`，无需安装即可使用，
适合临时评估、U 盘携带、或不便安装到系统盘的场景。

## 首次使用

1. 启动后进入「设置 → API 连接」，添加一个 OpenAI / Anthropic / Ollama / 自定义兼容接入点。
   密钥用 Electron `safeStorage`（Windows DPAPI）加密落盘，非 Electron 环境下回退为 base64。
2. 切到「项目」，点「打开项目文件夹」选定一个本地仓库。
3. 进入「对话」，选 **Main Agent**，输入自然语言任务，回车。
4. 工具调用与终端输出会实时流入对话流；遇到敏感操作会弹权限确认。
5. 顶部 ⏹ 一键停止正在执行的 Agent。

## 开发模式

```bash
npm install                  # 装依赖
npm run rebuild              # 把 better-sqlite3 重新按 Electron ABI 编译
npm run test                 # 跑 764 个单元 / 集成 / 服务端到端测试
npm run smoke                # 启 Electron + 探测渲染层是否挂载（headless 友好）
npm run integration-smoke    # Node 22 Sidecar + real ClineCore + local coding fixture
npm run e2e                  # Playwright E2E（会先准备 pinned Cline runtime）
npm run electron             # 开发模式启动
npm run dist                 # 打 NSIS + Portable 到 dist-electron/
```

## 安全与隐私

- 所有数据存在本地 SQLite，**不上云、不联网传数据**。
- API Key 在 Electron 环境下走 DPAPI；Node 环境下退化为 base64（并在 UI 显示提示）。
- 渲染层禁用了 `nodeIntegration`，IPC 是唯一高权限入口，contextIsolation=true。
- 静态服务器只绑 `127.0.0.1`，CSP `script-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 模块、数据流、设计权衡
- [`docs/SMART_API_ONBOARDING.md`](docs/SMART_API_ONBOARDING.md) — 智能 API 快速接入（v2.4.0）
- [`docs/EXTERNAL_CONFIG_IMPORT.md`](docs/EXTERNAL_CONFIG_IMPORT.md) — 外部 API 配置一键迁移（v2.5.0）
- [`docs/MAIN_AGENT_RUNTIME.md`](docs/MAIN_AGENT_RUNTIME.md) — Main Agent 自主编码闭环（v2.6.0）
- [`docs/AGENT_INTEGRATION_HUB.md`](docs/AGENT_INTEGRATION_HUB.md) — Agent Integration Hub 统一智能体适配层（v2.7.0）
- [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) — 真实测试结果
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — 第三方开源项目声明
- [`CHANGELOG.md`](CHANGELOG.md) — 版本变更
