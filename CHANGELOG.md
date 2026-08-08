# Changelog

## v2.1.0 — 2026-08-08

> 在 v2.0.0 已打通的骨架之上，把「存在但未真正闭环」的关键能力修成可工作的真实能力，并完成端到端验证。**不推倒重做、不删旧功能、不夸大、不假实现。**

### P0 — 核心能力真正生效

* **P0-1 模型路由真正生效**：Agent 指定的模型会真正下发到 Provider，不再被 `conn.models[0]` 静默覆盖；每次回退都在 `model_calls` 表留痕（请求的模型 / 实际模型 / 来源 / 是否回退），「为什么用了这个模型」可追溯。
* **P0-2 WorkBuddy Desktop 桥接真正返回结果**：`DesktopAgentBridge` 状态机（locating→focusing→inputting→submitted→waiting→reading→completed/failed/timeout/cancelled）；输入优先级链 **UIA ValuePattern → 剪贴板+Ctrl+V → SendKeys**；四种完成检测策略（sentinel 独占行 / 文本稳定 / busy 指示器消失 / 硬超时）；读到真实回答才标 `completed`，读不到窗口文本则**诚实失败**不再假装完成。19 个 Test Harness 用例驱动状态机全分支（`fakeClock` 用注入时钟让 180s 生产超时在微秒内跑完）。
* **P0-3 Vision 真正进入 Model Request**：截图作为 `imagePart` 进多模态 `ContentPart`；各 Provider 真实转换成对应线格式（OpenAI `image_url` / Responses `input_image` / Anthropic `source.base64` / Ollama `images[]`）。`detectCapabilities` 的视觉探测真实发送 1×1 PNG 并断言请求体。

### P1 — 互通与诊断

* **P1-4 多聊天真正互联**：4 个内置跨聊工具（列项目内对话 / 取对话摘要 / 向指定对话发消息 / 查对话状态），主 Agent 自动启用；委派通过 `agent_messages` 表真实落库并带终态；`maxChatDelegationDepth=2` 防 A→B→A 死循环。
* **P1-5 Responses API 修正 + 独立能力检测 + 诊断页**：
  * 修正 Responses API 路径的若干不一致。
  * `capabilities.js` **逐项独立探测**（text / streaming / tools / vision），每个结果带诚实状态：`declared` / `tested` / `inferred` / `unknown`；传输错误记 `unknown` 而非 `tested/false`，不污染其他能力。
  * 新增 **能力诊断页**（导航「诊断」）：选连接+模型 → 发起真实探测 → 能力矩阵随 `diagnostics_progress` 事件实时翻转 → 结果写入本地库；并展示「已探测记录 / 模型调用记录 / 模型回退·不匹配」审计。
  * **MCP 协议版本检查**：客户端与服务端协商 `protocolVersion`，不支持的版本（如 `1999-01-01`）直接抛错，**不再静默成功**；协商到更高版本时记录 warning。

### 附加项（边界加固）

* 上下文 Summary 升级：超阈值历史压缩更稳，摘要带「已压缩省略」标记。
* 用量 `estimated_cost`：无法计价时写 **NULL**（不再写 0 误导）。
* 权限持久化：项目级 `always` 决策落库，重启不丢失。
* 子 Agent 权限继承：主 Agent 的权限范围对子 Agent 委派生效。
* Computer 输入安全转义：SendKeys 路径对 `+ ^ % ~ ( ) { } [ ]` 包 `{}` 防注入（UIA / 剪贴板路径无需转义）。
* Codex Adapter 完善：补齐超时与中断处理。
* External Agent 统一状态：Codex / HTTP / WorkBuddy 三路结果结构统一 `{status, summary, findings, changedFiles, artifacts, errors}`。

### 测试 164 / 164 全过

* 新增：modelrouting（12）· runtimerouting（7）· desktopbridge（19）· capabilities（18）· chats（16）· mcpprotocol（8）· services（21，含 P0-2 诚实失败契约）。
* 原有 83 全部保留（pathguard 9 · patch 8 · permissions 10 · providers 13 · db 13 · agentloop 10 · 其余）。
* 冒烟测试（`npm run smoke`）增强：额外点击「诊断」页并断言能力矩阵渲染，无控制台错误 → `SMOKE_OK`。

### 打包

* 重新生成 `Agent Dev Platform Setup 2.1.0.exe`（NSIS）与 `Agent Dev Platform 2.1.0 portable.exe`（均为 ~84MB，unsigned）。
* 自绘应用图标沿用；asar 仍关闭（便于本地调试与工具文件外置）。

### 已知边界（明确告知）

* 诊断页的「开始探测」会对选中连接发起**真实请求**（短文本 / 流式 / 工具定义 / 1×1 图片）；探测结果仅写入本机数据库。
* 真实 LLM Provider 端到端仍由用户在设置里配密钥后首次连接验证（测试用 mock + 本地 echo 服务器）。
* NSIS 安装向导为 electron-builder 默认产物，未做 UI 截图回归。

---

## v2.0.0 — 2026-08-08

### 架构重构（v1 JSON 单文件 → v2 SQLite + 模块化）

* **数据库**：v1 单 JSON → v2 `better-sqlite3` + WAL，12 个表（projects / connections / agents / external_agents / skills / tools / mcp_servers / conversations / messages / tasks / memories / usage / audit / events / file_changes / checkpoints / settings）。schema 兼容 v1 旧数据，自动备份为 `data.json.migrated.bak`。
* **代码组织**：`main.js` + `preload.js` + `src/**`（主进程 CommonJS），`public/js/*`（渲染层 ES Module）。删除 v1 残留的 `server.js / llm.js / store.js / public/app.js / public/style.css`。
* **安全**：渲染层禁用 `nodeIntegration` + `contextIsolation:true` + CSP（`script-src 'self'`、`object-src 'none'`），preload 通过 `window.api` 暴露受限 IPC；静态服务器仅绑 `127.0.0.1`。
* **密钥**：`safeStorage`（Windows DPAPI）加密 API Key；Node 环境下退化为 base64 并在 UI 标注后端名。

### P0 完工

* **多协议 Provider 适配**：openai-chat / openai-responses / anthropic / ollama / local / mock；统一 `streamResponse` 接口；abort signal 透传 → 真中断 LLM 请求。
* **Agent Runtime**：AbortController 真中断；重复动作防护；maxRepeatedFailures 连续失败中止；权限四档（deny / ask / once / always）+ 范围限定；上下文超阈值压缩；sub-agent 与 external-agent 委派；`agent:event` 结构化事件流 → `webContents.send`。
* **工具 32 个**：filesystem / search / **patch**（diff 生成 + 行级上下文校验 + 失败精确行号） / terminal（Windows 进程树正确取消，孙进程 stdout 不丢）/ git / checkpoint。
* **任务系统**：task + task_step + agent_event 三件套，状态机（pending / running / completed / failed / cancelled）。
* **存储**：SQLite WAL；自动迁移（CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN 增量）。
* **多协议子 Agent**：主 Agent 通过 `agent_<name>` 工具调度子 Agent；子 Agent 不能再次派生。
* **多聊互联**：每个对话独立 conversationId，互不干扰；事件以 conversationId 为前缀路由。

### P1 完工

* **MCP（Model Context Protocol）**：JSON-RPC 2.0 over stdio（NDJSON）/ HTTP（SSE）。修复 ENOENT 未处理事件崩溃、超时缺失、握手串行阻塞；真实连接本地 stdio 服务器走完握手 + 工具列表 + 调用 + 错误回包 + 超时 + 进程回收。
* **Browser（Playwright）**：内置 Chromium → 系统 Edge → 系统 Chrome 三级回退链；可见/无头切换；navigation / snapshot / screenshot / click / type / press / select / scroll / close 9 个工具。
* **Computer（PowerShell + .NET）**：窗口列表、聚焦、按键、坐标点击、屏幕截图（修复 `file.Replace` C# 拼写 bug 后真正能截图，276KB PNG）、UI 自动化控件树、点击控件。
* **External Agents**：Codex（CLI / OpenAI 兼容 API）/ WorkBuddy Desktop Bridge（驱动用户已登录的桌面应用）/ 通用 HTTP 适配器。统一 `{status, summary, findings, changedFiles, artifacts, errors}` 结构化结果。
* **用量与日志**：usage / audit 表 + 事件流；面板可看。

### 测试 83 / 83 全过

* pathguard（9）·patch（9）·permissions（11）·providers（13）·db（12）·agentloop 端到端（10）·services P1（19）。
* **驱动出 14 个真实缺陷修复**（详见 `docs/TEST_REPORT.md` § 7）。

### 打包

* electron-builder 同时产出 NSIS 安装包 + Portable 单 exe。
* 自绘 256×256 应用图标（`scripts/make-icon.js`，纯 zlib 无依赖）。

### 已知边界（明确告知）

* 首次启动需要用户在「设置 → API 连接」添加至少一个 LLM 连接，否则 Main Agent 跑不起来。
* Playwright Chromium 是可选下载；缺失时浏览器工具自动回退到系统 Edge / Chrome。
* 没有内置的 LLM 密钥——平台只调用户配的连接，所有数据不出本机。
* 没有内置 Webhook / Mock 工具（边界问题）。
* GUI 自动化测试受限于环境依赖；冒烟 + 单元 + 集成覆盖了渲染层挂载、IPC、工具、Provider、Service、Database、Security、Agent Runtime 全部链路。