# Agent Dev Platform — Architecture (v2.0.0)

## 1. 设计目标与边界

Agent Dev Platform 是一个**本地桌面 AI Agent IDE**，目标是让 Coding Agent 能像一名真正的工程师一样工作：读取项目、修改代码、运行命令、调用工具、在失败中自愈。设计原则：

| 原则 | 体现 |
| --- | --- |
| **数据不出本机** | SQLite 本地存储；HTTP 仅用于已配置的 LLM / MCP / HTTP 外部 Agent；UI 通过 IPC 调主进程，渲染层不接触 Node |
| **失败可见、可控、可重试** | 结构化事件流；权限四档（deny / ask / once / always）；patch 上下文不匹配直接拒绝 |
| **真实可运行** | 测试覆盖真实浏览器、真实 PowerShell、真实 JSON-RPC 服务器，**不靠 mock 装成功** |
| **可打包成单机应用** | 单文件 HTML 内联进打包，CSS / JS / 图标内联；原生模块按 Electron ABI 编译 |

## 2. 模块全景

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Electron 31 主进程                            │
│                                                                      │
│   main.js                  preload.js          IPC handlers           │
│   ┌──────────────┐         ┌──────────┐        ┌────────────────┐    │
│   │ BrowserWindow│ ◀─────▶ │ contextIs│ ◀────▶ │ src/ipc/       │    │
│   │ + --smoke    │   IPC   │ olation  │   invoke │ handlers.js   │    │
│   │ + CSP headers│         │ + window.│        │  (60+ 路由)    │    │
│   └──────┬───────┘         │   api    │        └────────┬───────┘    │
│          │                 └──────────┘                 │            │
│   ┌──────▼──────────┐  src/server/static.js  ┌─────────▼─────────┐  │
│   │ 127.0.0.1:PORT  │  (Express + CSP)        │   src/db/store.js │  │
│   │ 静态服务器      │ ──────────────▶        │   better-sqlite3  │  │
│   └─────────────────┘                          │   (WAL + DPAPI)   │  │
│                                                └─────────┬─────────┘  │
│   ┌──────────────────────────────────────────────────────▼──────┐   │
│   │                   src/agent/runtime.js                       │  │
│   │   • AbortController 真中断  • 重复动作检测  • 权限门控        │  │
│   │   • 子 Agent / 外部 Agent 委派  • 结构化事件 webContents.send │  │
│   └──────┬─────────────┬─────────────┬─────────────┬─────────────┘  │
│          │             │             │             │                │
│   ┌──────▼────┐ ┌──────▼─────┐ ┌─────▼─────┐ ┌─────▼──────────┐    │
│   │ tools/    │ │ providers/ │ │ services/ │ │ security/      │    │
│   │ 文件/搜索 │ │ openai     │ │ mcp       │ │ pathguard      │    │
│   │ patch     │ │ openai-    │ │ browser   │ │ permissions     │    │
│   │ terminal  │ │  responses │ │ computer  │ │ secret (DPAPI)  │    │
│   │ git       │ │ anthropic  │ │ external  │ │                 │    │
│   │ checkpoint│ │ ollama     │ │  Agents   │ │                 │    │
│   └───────────┘ │ local      │ └───────────┘ └─────────────────┘    │
│                 │ mock       │                                     │
│                 └────────────┘                                     │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. 关键模块

### 3.1 Agent Runtime (`src/agent/runtime.js`)

核心循环：读取消息 → 调用 Provider → 解析 tool_calls → 执行工具 → 写回结果 → 循环，直到模型给出最终文本或达到 `max_steps` / 超时 / 用户停止。

| 能力 | 实现 |
| --- | --- |
| **真中断** | 每次 `streamResponse` 传入 `AbortSignal`；Provider 把信号转给 `fetch`；AbortController.abort() 立刻终止进行中的 SSE 解析 |
| **重复动作防护** | 同一 (name, arguments) hash 连续 2 次触发告警；连续 3 次强制停止 |
| **maxRepeatedFailures** | 同一工具连续失败 5 次中止任务 |
| **权限门控** | `PermissionEngine.check()`；命中 ask/once/always 时通过 `emit('permission_request')` 推给渲染层等待用户决策 |
| **工具结果配对** | `recordToolResult` 同步把工具结果**既写入事件流也作为 role=tool 消息持久化**，避免下轮请求中 OpenAI/Anthropic 因未配对 `tool_calls` 返回 400 |
| **历史压缩** | 上下文超过阈值时丢弃最早的非 system 消息，再注入一段摘要 |
| **子 Agent 调度** | `deps.runSubAgent` 把 sub_agent_ids 暴露为 `agent_<name>` 工具；子 Agent 不能再次派生 |
| **External Agent** | `codex` / `workbuddy` / `http` 适配器由 `services/externalAgents.js` 实现 |

### 3.2 Provider 适配器 (`src/providers/`)

统一的 OpenAI Chat 兼容协议作为最小公共子集，再为各家扩展：

| Provider | 实现 | 备注 |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions | 函数调用原生支持 |
| `openai-responses` | OpenAI Responses API | 新的统一入口 |
| `anthropic` | Messages API + SSE | 工具调用结构不同，单独适配 |
| `ollama` | OpenAI 兼容 ( `/v1/chat/completions`) | 本地免密钥 |
| `local` | OpenAI 兼容 | LM Studio / llama.cpp |
| `mock` | 脚本化多步驱动 | **测试专用**，支持 `mockScript` 多步 + abort 校验 |

`streamResponse` 接口对所有 Provider 一致：`{system, messages, tools, onChunk, signal} → {content, tool_calls, usage, error}`。

### 3.3 工具 (`src/tools/`)

6 大类共 32 个内置工具 + 动态注入的 MCP / Computer / Browser 工具。所有工具统一为 `{defs, execs, manager}` 三件套：

| 工具 | 风险 | 权限 | 说明 |
| --- | --- | --- | --- |
| 文件系统（list_directory / read_file / write_file / move_file / copy_file / delete_file / file_exists / get_file_metadata） | write:high / read:low | `filesystem.read` / `filesystem.write` | 路径守卫 (`pathguard`) 拦截逃逸；写操作走 patch |
| 搜索（search_files / search_text / search_symbols） | low | `filesystem.read` | ripgrep 风格；按大小写敏感 |
| **patch**（apply_patch） | high | `filesystem.write` | 生成 diff → 校验行号上下文 → 失败提示精确行号 → 可重试 |
| 终端（terminal_run / terminal_cancel / terminal_status） | high | `terminal.write` | `taskkill /t /f` 杀进程树；stdout 不会丢 |
| Git（git_status / git_diff / git_log / git_show / git_branch / git_add / git_commit） | medium | `terminal.write` | 包装 git CLI |
| Checkpoint（checkpoint_create / checkpoint_restore） | medium | `git.write` | 用 git stash + 标签做轻量快照 |

### 3.4 数据库 (`src/db/`)

`better-sqlite3` + WAL，单文件 `agent.db`（默认 5MB 上限够存几十万条消息）。
Schema 模块 (`schema.js`) 用 `CREATE TABLE IF NOT EXISTS` + 增量 `ALTER TABLE ADD COLUMN`，
保证旧数据库可以被新版本直接打开。

主要表：`projects / api_connections / prompts / agents / external_agents / skills / tools / mcp_servers / conversations / messages / tasks / task_steps / memories / usage / audit / agent_events / file_changes / checkpoints / settings`。

### 3.5 安全 (`src/security/`)

| 模块 | 职责 |
| --- | --- |
| `pathguard.js` | `guard(root, rel)`：拒绝绝对路径、规范化 `..`、检测同名前缀穿越 |
| `permissions.js` | 四档策略 + 范围限定（project / task / once / always / deny）+ 内存缓存 |
| `secret.js` | `encrypt/decrypt/isUsingSafe`：Electron 下走 `safeStorage`（DPAPI），Node 下退化为 base64，并在 UI 显示后端名 |

### 3.6 服务 (`src/services/`)

* `mcp.js` — JSON-RPC 2.0 over stdio（NDJSON）/ HTTP（SSE）。
  **修复点**：补 `proc.on('error')` 监听（避免 ENOENT 杀进程）+ 请求超时（防止卡死启动）+ 自动清理失败的连接 + 启动握手并发化（一个坏的服务器不阻塞其他）。
* `browser.js` — Playwright Chromium。**回退链**：内置 Chromium → 系统 Edge → 系统 Chrome；用户无需额外下载即可使用。
* `computer.js` — PowerShell + .NET（UIAutomation / Drawing）。**修复点**：截图脚本里 `file.Replace`（C# 大写）→ `file.replace`（JS 小写），原本这个功能从未真正工作过。
* `externalAgents.js` — Codex（CLI / OpenAI 兼容）/ WorkBuddy Bridge（驱动用户已登录桌面应用）/ 通用 HTTP。

### 3.7 渲染层 (`public/`)

ES Modules + `<script type="module">`：

| 文件 | 职责 |
| --- | --- |
| `index.html` | 单页结构 |
| `css/style.css` | 暗色 IDE 风样式 |
| `js/state.js` | 全局状态 + 事件总线 |
| `js/api.js` | `window.api`（preload 暴露 IPC） |
| `js/util.js` | DOM / 字符串 / Markdown 工具 |
| `js/panels.js` | 顶部 / 侧边 / 底部布局 |
| `js/files.js` | 文件树渲染 |
| `js/pages.js` | 设置 / Agents / Skills / MCP / Connections 等表单 |
| `js/chat.js` | 对话流、工具调用可视化、权限弹窗、Stop |
| `js/app.js` | 启动序列、路由、事件总线挂载 |

CSP 在 `static.js` 里以响应头设置（`script-src 'self'`、`object-src 'none'`、`style-src 'self' 'unsafe-inline'` 因为渲染层会注入行内样式），与 Electron 渲染层的 `contextIsolation:true` 形成纵深防御。

### 3.8 IPC (`src/ipc/handlers.js`)

唯一的渲染 ↔ 主进程桥梁。60+ 路由全部走 `reg(channel, fn)` 包装，错误统一返回 `{ok:false, error}` 而不是抛异常，避免渲染层崩溃。

## 4. 数据流：一次完整的 Agent 回合

```
[用户输入]
  ↓ window.api.agentSend()
  ↓ ipcMain 'agent:send'
  ↓ handlers.runChatTurn
  ↓
runtime.runAgentTurn(conversationId, agentId, message, ctx)
  ├─ store.messages.append(user)
  ├─ emit('task_started')
  ├─ while (steps < maxSteps):
  │   ├─ ctx.messages = load + 历史压缩 if needed
  │   ├─ provider.streamResponse(signal)
  │   ├─ 若返回 tool_calls:
  │   │   ├─ PermissionEngine.check(name, args)
  │   │   ├─ executeTool()
  │   │   ├─ recordToolResult → events + tool 消息
  │   ├─ 若返回文本:
  │   │   ├─ store.messages.append(assistant)
  │   │   ├─ emit('assistant_message')
  │   └─ 若 aborted: emit('task_cancelled')
  ↓
emit('task_finished') / 'task_failed'
  ↓ webContents.send('agent:event')
  ↓ chat.js 增量渲染
```

## 5. 设计权衡

| 决策 | 为什么不选另一边 |
| --- | --- |
| **better-sqlite3 而非纯 JSON** | v1 用 JSON 单文件：30MB+ 时 IO 慢、并发易坏；SQLite + WAL 给同步 API，调试路径短 |
| **主进程 CommonJS，渲染层 ESM** | Electron 内置 Node 的 CJS/ESM 互操作坑多；分两套各取所长 |
| **`asar: false`** | better-sqlite3 + Playwright 都不能跑在 asar 内，必须 unpacked；显式禁用 |
| **contextIsolation:true + preload window.api** | 不开 contextIsolation 等于把 Node 暴露给被 XSS 的页面；开 + preload 是 Electron 官方推荐 |
| **静态服务器绑 127.0.0.1** | 渲染层需要一个 URL 才能让 BrowserWindow 加 CSP；127.0.0.1 让外部完全无法访问 |
| **工具 schema 显式 JSON Schema** | 让 Provider 自由选函数调用还是文本调用；mock Provider 可脚本化 |
| **Permissions 四档 + 范围** | 仅 on/off 太粗；过细又会卡开发流 |
| **External Agent 不递归** | WorkBuddy Bridge 走 desktop 驱动，不应回到本进程再派生 |

## 6. 构建产物

```
dist-electron/
├── Agent Dev Platform Setup 2.0.0.exe        # NSIS 安装包（双击安装）
├── Agent Dev Platform 2.0.0 portable.exe      # 免安装单文件
└── win-unpacked/                               # 免安装展开目录
    └── Agent Dev Platform.exe
```

构建：`npm run dist` → `electron-builder --win nsis portable`，约 3-5 分钟（取决于磁盘）。

## 7. 数据目录

```
%APPDATA%\Agent Dev Platform\
├── agent.db                 # SQLite（WAL 模式，自动产生 .db-wal / .db-shm）
├── agent.db-shm
├── agent.db-wal
├── Network State/           # Chromium 网络缓存
└── Local Storage/           # 本地存储
```

首次启动自动从项目目录或 `%APPDATA%/Agent Dev Platform/data.json`（v1 旧格式）迁移并备份为 `*.migrated.bak`。