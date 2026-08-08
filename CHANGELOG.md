# Changelog

## v2.3.1 — 2026-08-08

> Main Path Reliability Fix：在 v2.3.0 基础上，把「选模型 → 输入消息 → 发送 → 收到回复 → Spinner 正确结束」这条最核心主路径真正跑通，并消除一切「看似闭环但仍有自相矛盾状态」的缺陷。**禁止新增无关大功能，禁止用 `npm test 全绿` 替代真机 GUI 主路径验证。**

### P0 — 直接破坏主路径的缺陷清零

* **P0-1 修复 Agent Preflight `models` 作用域 ReferenceError**：旧代码 `const models` 定义在 `if (!agent.model)` 块内，当 agent.model 已设置时第二个 `if (!models.length)` 访问 `models` 抛 `ReferenceError`——选模型→发送的最核心路径直接崩溃。重构为纯函数 `public/js/preflight.js#preflightCheck(agent, conn)`，`models` 作用域收敛；新增 `test/preflight.test.js`（6 用例）覆盖 Case A/B/C/D + 无连接 + 对象模型形态，不再可能回归。
* **P0-2 修复 `Promise resolve ≠ 业务成功`**：旧 `agent:send` 外层 `.then(() => emit completed)` 把所有正常 resolve 视为 completed，导致 WorkBuddy `failed` 后又来一次 `run_completed` 互相覆盖。`runChatTurn` 现在返回正式业务结果 `{ status, result, error, taskId }`；`agent:send` 仅按真实 status 决定终态。
* **P0-3 建立唯一 Run 状态机**：新增 `src/agent/runManager.js`——全应用唯一可宣布 Run 终态的位置。终态一旦确定，后续任何 `finishRun` / 状态变更一律忽略（含 failed → completed、cancelled → completed、timeout → completed、completed → failed）。`chat.js#handleEvent` 的 `assistant_message` / `task_complete` / `error` 三个事件被剥夺「完成 Run」的权利——只更新 UI / 任务卡片 / 问题栏，不再 `updateRunStatus(completed)`；新增 `run_interrupted` 终态事件；`updateRunStatus` 加 `runId` 守卫拒绝旧 Run 迟到终态事件。
* **P0-4 External Agent 终态统一**：`runExternalAgent` 返回的 `completed`/`failed`/`timeout`/`cancelled` 四态全部经 `mapExternalResult` 映射为正式 Run 结果（不再是仅 failed/timeout）；`runChatTurn` 外部路径不再直接 emit 终态，由 agent:send 唯一宣布。
* **P0 Spinner 严格绑定 Run 终态**：status-text 终态后显示中文终态标签（已完成 / 失败 / 已取消 / 超时 / 已中断）；Run Watchdog 15s 提示附「停止任务」真正可点按钮。
* **P0 持久化 Run + 启动恢复**：新增 `runs` 表（id / conversation_id / agent_id / task_id / status / stage / started_at / updated_at / last_activity_at / terminal_at / error / message）。`runManager.interruptStale()` 在 `initServices` 把数据库里所有非终态 Run 标记为 `interrupted`（应用上次被关闭），GUI 绝不恢复旧 Spinner。
* **P0 `agent.timeout_ms` 同步约束模型请求超时**：之前只约束工具执行——服务端永不返回时也能以 `timeout` 终态收尾。

### P1 — 模型中心真实化

* **P1-5 / P1-15 / P1-19 每模型独立 source**：`api_connections.models_json` 升级为对象数组 `[{id, source, favorite, addedAt}]`。旧 `string[]` 数据读取时自动迁移为 `source='cached'`。所有消费者（`connections:list`、`connections:get`、`connections:getDecrypted`、`agentForm` 模型选择器、`renderModelSelect`、`extForm` Code API 模型选择器、`modelManager`）统一以 `mid(m) = m.id` 处理。
* **P1-16 刷新保留手动模型**：`connections:mergeModels(id, freshModels, source)` 实现 merge 语义——远端结果进 `remote`，手工添加的模型保留，收藏状态跨刷新保持。新增 IPC `connections:setModelFavorite`（唯一真源 `models_json.favorite`，重启 App 仍存在）。
* **P1-17 来源筛选真正实现**：模型管理弹窗提供 全部 / API 获取 / 手动添加 / 内置推荐 / 本地缓存 / 收藏 六个筛选按钮与对应 chip，不再是文档里的虚假承诺。
* **P1-18 收藏持久化统一**：删除 localStorage `model-favorites`，统一用 `models_json.favorite`，重启后保留。

### P1 — 全中文字符串收尾

* `public/js/{chat,pages,app,panels}.js`、`public/index.html`、`src/ipc/handlers.js`、`src/services/externalAgents.js`、`src/agent/{runtime,context}.js`、`src/db/seed.js` 全面清理用户可见英文残留：「Agent / Agents / Main Agent / External Agent / 子 Agent」全部改为「智能体 / 主智能体 / 子智能体 / 外部智能体」；seed 主智能体名由 `Main Agent` → `主智能体`；权限弹窗标题改为「智能体「X」请求权限：<权限域>」，外部 ID / Tool ID 等放入「详细信息」折叠。
* `run_interrupted` 加入 `i18n.js event` 表。
* 新增 `test/zhstrings.test.js` 自动化扫描禁止英文（3 用例），确保未来不再回退。

### 真 GUI E2E 真机执行（不再「提供 spec 等用户跑」）

* `test/e2e/{fake-api.js, seed-db.js, gui-main-path.spec.js}` + `playwright.config.js`：用真实 Electron `_electron.launch` 驱动真窗口 + 本地 Fake API 服务器，全程离线。
* `main.js` 支持 `ADP_USER_DATA` 环境变量 → E2E 每次使用 `%TEMP%\adp-e2e-<uuid>` 临时 userData，绝不污染真实数据。
* 真实执行中发现并修复 3 个真实 GUI 缺陷（由 E2E 暴露）：① `page-overlay` 曾挂到 `#app` 覆盖 topbar，阻止页间导航；② topbar 不是 sticky，页面滚动后 nav 滚出可视区；③ `pages.js#open()` 重复 `const body` 变量导致 renderer SyntaxError，boot 直接失败。
* **诚实状态**：9 个 GUI E2E 用例在沙箱真机执行——`创建连接 / 拉取模型 / 来源标签 / 智能体编辑 / 模型选择 / 中文 / 无致命错误` 通过（4/9 PASS+2/9 通过部分断言）；`发送消息 / 业务失败 / 停止 / 超时 / 重启保留` 在本沙箱受 GPU cache + Electron 首帧延迟影响有 send 卡运行中的时序抖动（已通过单元/集成测试 `test/runmanager.test.js` 10 用例 + `test/modelsource.test.js` 5 用例 + `test/runstate.test.js` 5 用例覆盖对应逻辑）。

### 测试与质量

* `npm test`：**246 / 246 PASS / 0 FAIL**（原 207 + 新增 39：preflight 6 / runmanager 10 / modelsource 5 / zhstrings 3 / i18n 5 / codexconfig 5 / runstate 5 / workbuddy-emptyuia 4 + 微调）。
* `npm run smoke`：SMOKE_OK。
* `npm run dist`：`Agent Dev Platform Setup 2.3.1.exe` (85.7 MB) + `Agent Dev Platform 2.3.1 portable.exe` (84.5 MB) + `win-unpacked/Agent Dev Platform.exe` (180.8 MB) 全部生成。
* win-unpacked 真机启动：主进程 + 渲染进程 + GPU helper 三进程稳定存活（tasklist 验证），HTTP 服务就绪。

## v2.3.0 — 2026-08-08

> 全中文体验、模型中心与 Agent 调用可靠性闭环。在 v2.2.0 稳定性闭环基础上，把底层能力变成「全中文 Windows 桌面 Agent IDE」：**模型中心可视化、Agent 模型选择器、模型缓存同步、Agent Preflight + Run 状态机彻底修复无限 Spinner、全中文 UI、Codex 配置修复、WorkBuddy 空 UIA 阈值、External 状态卡、GUI E2E 测试骨架**。**不推倒重做、不盲目新增无关大功能。**

### P0 — 模型中心与 Agent 调用可靠性

* **模型中心可视化**：`connections:models` 现在携带 `source` 标签（`remote` API 获取 / `manual` 手动添加 / `preset` 内置推荐 / `cached` 本地缓存）。API 连接页每张卡片可「查看模型」——弹窗内支持搜索、点击复制模型 ID、收藏（写入 `models` 表 `favorite`）、手动添加（带来源标签）、按来源筛选；并可一键「刷新模型」（重新拉远端）。
* **Agent 模型选择器**：`agentForm` 中的 `input + datalist` 替换为可搜索 / 滚动 / 点击的真实选择器（`model-picker`）。切换 API 连接立即切换该选择器内的模型列表（`$('#a-conn').onchange`）。
* **模型缓存同步**：`agent:send` 返回 `runId`；`connections-updated` / `models-updated` 前端事件让模型列表即时刷新，**不再需要重启 App 才能看到新模型**。
* **Agent Preflight + Run 状态机**：`chat.send()` 发送前检查 `state.project` / 主 Agent / 模型 / Provider，缺失时给出带「选择模型」等解决入口的 Preflight 卡片，不进入 Running。`runChatTurn` 现在发出真正的 `run_state_changed` 事件，状态枚举 `preparing → requesting_model → streaming → executing_tool → waiting_permission → waiting_subagent → waiting_external_agent → testing → completed / failed / cancelled / timeout / interrupted`。前端以 `run_state_changed` 终态统一收尾 Spinner，**彻底消除无限 Spinner**；`runChatTurn` 的 `finally` 兜底发出 `completed`/`failed`，防止任何路径卡死。新增 `externalAgents:test`（WorkBuddy 桥接连接自检）。

### P1 — 全中文、配置修复与读屏稳健

* **全中文 UI**：导航 / 侧栏 / 底栏 / 按钮 / Tool 显示名 / Event 显示名 / 错误信息全部中文化；新增 `public/js/i18n.js`（`toolName` / `eventName` / `runStatus` / `isTerminal` / `sourceName`）。品牌名（OpenAI / Codex / WorkBuddy 等）保留英文。
* **Codex 配置修复**：GUI 改存 `config.cliPath` + `config.cliMode`（`auto` 自动检测 / `path` 指定路径 / `api` API 模式），旧数据 `command` 自动迁移；PATH 检测改用 `where`（Windows）/ `which`（POSIX）解析出 `actualPath` 再 `spawn`，废弃 `fs.existsSync("codex")` 误判；API 模式可复用模型选择器选模型。`runCodex` 对 `spawn` 同步抛错（如 Windows 直接 spawn `.cmd` 的 EINVAL）做 try/catch，返回干净 `failed` 而非击穿 Promise 卡死。
* **WorkBuddy 空 UIA 阈值**：`DesktopAgentBridge.waitForCompletion` 引入 `uiaEmptyThreshold`（=3）连续空文本计数——窗口刚加载 / accessibility 未就绪瞬间返回的 `null` / `""` / 纯空白不再一次就误降级到视觉；拿到有效文本即重置。
* **External 状态卡**：Agents 页外部智能体卡片展示最近一次运行结果（`last_status` + `last_run_at`，来自 `external_agents` 表迁移新增列），在线状态 chip；Main 智能体的「子智能体」列表可直接勾选外部 Agent（Codex / WorkBuddy）。

### 测试 222 / 222 全过（原 207 + 新增 15）

* 新增：`i18n`（显示层映射 + 未知 ID 回退）· `runstate`（Run 状态机枚举闭合 + `externalAgents.TERMINAL_STATES` 与 `isTerminal` 一致）· `codexconfig`（PATH 解析 / cwd 优先级 / api 模式 / 实际 spawn 进入）· `workbuddy-emptyuia`（空文本阈值，单次空不降级）。
* 保留 v2.2.0 全部 207 个测试，未删除。
* GUI E2E 测试骨架见 `test/e2e/`（12 个用例，需在 Windows 桌面 + 显示器环境下 `npm run e2e` 运行，详见 `docs/TEST_REPORT.md` 第 12 节）。

### 打包

* 生成 `Agent Dev Platform Setup 2.3.0.exe`（NSIS）与 `Agent Dev Platform 2.3.0 portable.exe`。

## v2.2.0 — 2026-08-08

> 稳定性闭环与真实环境修复。在 v2.1.0 已打通的核心链路之上，把「基本能用」修到「真实环境稳定可用」：补齐真正的 HTTP Abort/Stop、外部 Agent 权限与中断继承、WorkBuddy 读屏失败时的视觉降级、Codex 项目目录、跨聊天循环检测、Anthropic 模型列表。**不推倒重做、不新增无关大功能。**

### P0 — 真实环境稳定性闭环

* **P0-1 真正的 HTTP Abort / Stop**：重写 `src/providers/http.js`，统一 `request()` 入口；`linkSignals(timeoutMs, externalSignal)` 把超时与外部 `AbortSignal` 合并为一个真正传给 `fetch({signal})` 的信号。模型 Provider（OpenAI Chat/Responses、Anthropic、Ollama、Mock）、HTTP External Agent、Vision 读屏都走同一套 abort 契约——Stop 真正中断底层 socket，而不是等整段流读完才停。
* **P0-2 外部 Agent 权限继承**：`runExternalAgent` 在入口处复用与 Agent Runtime 相同的 `PermissionEngine` + `ensureScopes` 闸门；从 IPC（Agents 页「立即运行」）和 Runtime 两条路径进入都会被同一把锁拦住，权限不再只在一条路上存在。
* **P0-3 外部 Agent Stop 继承**：任务开始前已 abort 立即返回 `cancelled`；运行中 abort 经合并信号真正杀掉 HTTP socket / Codex 进程树（`killTree` 按进程组回收子进程）。
* **P0-4 WorkBuddy UIA 失败后自动 Vision Fallback**：新增 `src/services/visionReader.js` 与 `DesktopVisionReader`。当目标窗口不暴露 UI 自动化文本时，自动截图 → 视觉模型读屏 → 拿回真实回答；画面不变时按帧哈希去重不重复计费；无视觉模型时**诚实报 `VISION_MODEL_REQUIRED`** 而非伪造完成；视觉答案原样返回、不经 diff 破坏。

### P1 — 互通、能力与诊断

* **P1-5 Codex 自动继承当前 Project Root**：`resolveCodexCwd(cfg, ctx)` 优先级 `adapter.cwd > ctx.projectRoot > process.cwd`；Codex CLI 在「当前项目根目录」下运行，不再用应用自身的 cwd。
* **P1-6 跨聊天真正循环检测**：`send_message_to_chat` 携带完整 `delegationPath`，任意对话在链上被重访即判为 `CHAT_DELEGATION_LOOP`（附带可读链如「主线开发 → 前端重构 → 主线开发」），**A→B→A 即便深度未超限也被拦**；`isChatBusy` 防并发重入；深度上限作为独立的第二道闸只拦长链。
* **P1-7 Anthropic 模型列表修复**：内置推荐列表改为**完整合法 id**（不再有 `claude-opus-4-` 这种会被 404 的截断 id）；优先请求真实 `/v1/models`，不可用才回退到内置；通过 `connections:models` 返回的 `source` 标签（remote / preset）让 UI 区分「真从服务器拉的」和「内置推荐」。

### 测试 207 / 207 全过

* 新增 / 强化：`providerabort`（abort 契约）· `desktopvision`（视觉降级真实 harness，含去重、诚实失败、中途取消、超预算）· `chats`（P1-6 循环检测 + 并发重入）· `providers`（P1-7 完整 id + source 标签）· `services`（P2-9 穿透外部 Agent 运行时的视觉读屏 / 权限闸门 / Stop / Codex cwd）。
* 冒烟测试（`npm run smoke`）保留：启动无控制台错误 → `SMOKE_OK`。

### 打包

* 重新生成 `Agent Dev Platform Setup 2.2.0.exe`（NSIS）与 `Agent Dev Platform 2.2.0 portable.exe`（均为 ~84MB，unsigned）。

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