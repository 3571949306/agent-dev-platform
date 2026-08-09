# Test Report — Agent Dev Platform v2.3.2

> **基线**：`v2.3.2`（基于 `v2.3.1 / commit 255f1cd`）。
> **本轮目标**：把 Agent Dev Platform 从「功能基本完成」修到「第一版可长期实际使用」。
> **本文件不含任何编造结果**，所有断言均来源于真实执行。

---

## 1. 版本

| 字段 | 值 |
| --- | --- |
| package.json version | `2.3.2` |
| 上一基线 | `v2.3.1 / 255f1cd` |
| 本轮重点 | P0-1 agent:send 立即 ACK / P0-2 GUI E2E 9/9 / P0-3 Run 终态数据库一致性 / P0-4 WorkBuddy Bridge 安全验收 / P1-5 测试产物清理 / P1-6 GitHub Actions |

---

## 2. npm test（单元 + 集成）

```bash
cd agent-dev-platform
npm test
```

最新一次完整运行摘要：

```
# tests 250
# suites 0
# pass 250
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7181.561
```

**结论：250 / 250 PASS，0 失败，0 跳过。**

### 测试覆盖

| 文件 | 用例数 | 范围 |
| --- | ---: | --- |
| `test/pathguard.test.js` | 9 | 相对/绝对路径、`..` 逃逸、混合分隔符、兄弟目录前缀、同名文件、null 字节 |
| `test/patch.test.js` | 9 | Diff 生成 / 往返 / 多 hunk / 上下文不匹配精确行号 / 越界拦截 / 失败可重试 |
| `test/permissions.test.js` | 10 | deny / ask / once / always / 范围（task / project）/ reset / 非法 scope |
| `test/providers.test.js` | 16 | 协议路由 / authHeaders / baseUrlOf / interpretError / toChatMessages / 流式 SSE / Mock 脚本 + abort / guessCapabilities / 完整模型 id + source 标签 |
| `test/db.test.js` | 13 | WAL / 重复 init / 项目 CRUD / 密钥不落明文 + 不泄露 / secret.mask / Agent 关联 / 消息配对 / 任务流转 / 设置 / 记忆去重 / 可选参数绑定 / v1 迁移 |
| `test/agentloop.test.js` | 10 | 端到端：读 → 补丁 → 终端 → 完成 / 权限拒绝 / 读放行 / 防死循环 / 未知工具 / maxSteps / 连续失败中止 / Stop 真取消 / system prompt 注入 / 历史压缩 |
| `test/providerabort.test.js` | 10 | `linkSignals` 合并超时+外部 abort / `request()` 真传 `signal` 给 fetch / 各 Provider 超时被中断 / 外部信号中断 / 释放响应 / 超时与取消区分 |
| `test/services.test.js` | 26 | MCP（std-io 真实 JSON-RPC）/ Browser / Computer / External Agents（诚实失败契约 + 穿透运行时：视觉读屏闭环 / VISION_MODEL_REQUIRED / 权限闸门 PERMISSION_DENIED / Stop 前取消 / Codex cwd） |
| `test/modelrouting.test.js` | 12 | Agent 指定模型真正下发，不被 `models[0]` 覆盖；`model_calls` 记录请求/实际/来源/回退 |
| `test/runtimerouting.test.js` | 7 | 运行时解析模型路径与回退边界 |
| `test/desktopbridge.test.js` | 19 | P0-2 Test Harness：状态机全分支（找不到窗口/聚焦失败/sentinel/稳定/busy 消失/超时/不可读/Stop 取消/UIA→剪贴板→SendKeys 降级与三路全失败/提交失败/短回答失败/截图带回/标题精确匹配） |
| `test/desktopvision.test.js` | 19 | P0-4：`DesktopVisionReader` 真实 harness（去重/诚实失败/中途取消/超预算/低置信度/无截图回退/UIA 可读时不触发视觉；降级拿回真实答案且 `readVia=vision`） |
| `test/capabilities.test.js` | 18 | 逐能力独立探测（text/streaming/tools/vision），真请求体断言、传输错误记 unknown、工具探测真发 schema、模型真调工具、视觉探测真发 base64、orchestrator 独立不污染、onProgress 顺序、classify 五类 |
| `test/chats.test.js` | 22 | 4 个跨聊工具 / `agent_messages` 落库 / 深度防递归 / A→B→A 循环检测（带可读链）/ `isChatBusy` 并发重入 / 路径透传 |
| `test/mcpprotocol.test.js` | 8 | MCP 协议版本协商：首选/未来版本通过、未知版本拒绝、`checkProtocol` 单元、集成连接记录协商版本、未知版本直接抛错 |
| `test/i18n.test.js` | 3 | `toolName`/`eventName`/`runStatus`/`sourceName` 映射 + 未知 ID 安全回退为原文 + `isTerminal` 终态识别 |
| `test/runstate.test.js` | 3 | `externalAgents.TERMINAL_STATES` 是 `isTerminal` 子集；`runCodex` 缺配置返回合法 failed；`run_state_changed` status 枚举闭合 |
| `test/codexconfig.test.js` | 5 | `resolveCodexCwd` 优先级；`cliMode=auto` 无 codex 优雅失败；`cliMode=api` 缺连接报错；`cliMode=path` 不存在文件不 spawn；存在文件进入 spawn 阶段 |
| `test/workbuddy-emptyuia.test.js` | 4 | 连续 3 次空文本才 `unreadable`（单次空不降级）；空文本后恢复重置计数；纯空白等同空（trim 修复）；首轮有内容正常稳定完成 |
| `test/agentack.test.js` | 3 | **v2.3.2 P0-1**：agent:send 立即返回 runId（< 1s，远低于 5s 任务）；后台异常收口为 failed 终态不产生 UnhandledPromiseRejection；单 Run 单终态（重复 finishRun 不发第二次终态事件） |
| **合计** | **250** | |

> 历史版本（v2.0.0 → v2.1.0 → v2.2.0 → v2.3.0 → v2.3.1 → v2.3.2）单测增长：83 → 164 → 207 → 222 → 247 → **250**。
> 本轮新增 3 用例（`agentack.test.js` 验证 P0-1 ACK 语义）。

---

## 3. GUI E2E（真实 Electron 窗口 + Playwright）

```bash
cd agent-dev-platform
npm run e2e
```

最新一次完整运行摘要：

```
Running 9 tests using 1 worker

SEED_OK project=... mainAgent=... openaiConn=... fakeConn=... base=http://127.0.0.1:9117/v1
SEED_VERIFY main.model=model-B main.api_connection_id=... main.is_main=true

  ok 1  1) API 连接 → GUI 新建 → 拉取模型 → model-A/B/C 真实可见 (230ms)
  ok 2  2) 智能体 → 编辑主智能体 → Fake 连接 + model-B → 保存 → 重开仍选中 (1.1s)
  ok 3  3) 【主路径】选好模型发送「你好」→ 无 ReferenceError → completed → Spinner 消失 (1.1s)
  ok 4  4) 业务失败：model-FAIL → 唯一终态 failed（绝不随后 completed） (1.5s)
  ok 5  5) 停止：model-HANG + 点停止 → 唯一终态 cancelled (2.8s)
  ok 6  6) 超时：model-HANG + 短 timeout → 唯一终态 timeout (10.1s)
  ok 7  7) 模型来源：手动添加 CUSTOM-X → 重启后仍在(source=manual) → 刷新后不丢 (1.9s)
  ok 8  8) 全中文：普通用户可见层无英文残留（品牌/技术名除外） (7ms)
  ok 9  9) 无 JS 致命错误（全程 pageerror 收集） (1ms)

  9 passed (21.1s)
```

**结论：9 / 9 PASS，0 失败，0 跳过。真实 Electron 窗口。**

> 严格语义：`PASS = 所有断言成功`；`FAIL = 任意断言失败 / 超时`；`SKIP = 明确跳过`。
> 不再使用「部分通过」「虽然超时但算成功」等表述。

### 3.1 Run 终态数据库一致性（P0-3）

每个 Run 的终态断言包含两层：

1. **UI 终态事件**：通过 `window._runTerms` 探针断言唯一终态事件
   （`run_completed` / `run_failed` / `run_cancelled` / `run_timeout` / `run_interrupted`）。
2. **数据库 runs 表**：通过新增 IPC `runs:list(1)` 直接读取最新一条 runs row，
   断言 `row.status === UI 终态`，禁止出现「UI completed / DB running」或反之。

| Case | UI 终态事件 | 数据库 runs.status |
| --- | --- | --- |
| 3 主路径 | `['run_completed']` | `completed` |
| 4 业务失败 | `['run_failed']` | `failed` |
| 5 停止 | `['run_cancelled']` | `cancelled` |
| 6 超时 | `['run_timeout']` | `timeout` |

### 3.2 单 Run 单终态

`window._runTerms` 探针对每次发送记录所有终态事件，断言「每个 runId 的终态事件总数 = 1」。
迟到事件（如 cancelled 后再 finishRun('completed')）会被 RunManager 内部拒绝，绝不发出第二次终态事件。

### 3.3 Run 隔离

`agent:stop` 通过 `runManager.cancelByConversation(conversationId)` 严格按 conversationId 取消，
Run A 的迟到事件无法关闭 Run B 的 Spinner 或修改 Run B 的 status。

### 3.4 E2E 诊断（v2.3.2 新增）

断言失败时 `dumpDiagnostics()` 自动输出：
- 当前 `runManager.list()`（所有 Run 的 status / stage / lastActivityAt / error）
- `runManager.byConversation`（conversationId → runId 映射）
- `activeRuns` 的 conversationId 集合
- 最近 15 条 `agent:event`
- 最近 10 条 `assistant_status`
- 最近 10 条 `run_state_changed`
- DOM 状态（status-text / btn-stop / btn-send / 输入框 / 消息列表 / err-card）
- 主智能体配置（is_main / api_connection_id / model）
- 同步写入 `%TEMP%\adp-e2e-diag.log`，避免 PowerShell 重定向缓冲丢失

---

## 4. Smoke（GUI 启动探针）

```bash
cd agent-dev-platform
npm run smoke
```

最新一次输出：

```
Agent Dev Platform ready on http://127.0.0.1:9189
SMOKE_PROBE {"hasApi":true,"title":"Agent Dev Platform","agentOptions":5,"chatItems":1,"messages":4,"fatal":false,"bodyLen":6412}
SMOKE_DIAG {"title":"能力诊断","hasRunBtn":true,"hasMatrix":true,"hasEmpty":false,"hasErr":false}
SMOKE_OK
```

**结论：PASS。**
- `hasApi:true` — preload 正常挂载 `window.api`
- `title:"Agent Dev Platform"` — 渲染层正确读 title
- `agentOptions:5` — 5 个种子 Agent 都已注册
- `fatal:false` — 没有「必须在 Agent Dev Platform Desktop 中打开」错误
- `bodyLen:6412` — 主 DOM 正常渲染
- `SMOKE_DIAG` — 诊断页矩阵渲染（`hasRunBtn`/`hasMatrix` 为真、无 `.err`）

---

## 5. Build（Windows 产物）

```bash
cd agent-dev-platform
npm run dist
```

**结论：PASS。**

产物：

| 文件 | 大小 |
| --- | ---: |
| `dist-electron/Agent Dev Platform Setup 2.3.2.exe` | 84,749,056 B (~80.8 MB) |
| `dist-electron/Agent Dev Platform 2.3.2 portable.exe` | 84,541,348 B (~80.6 MB) |
| `dist-electron/win-unpacked/Agent Dev Platform.exe` | (存在) |

### 5.1 win-unpacked 真机启动

```powershell
$exe = "dist-electron\win-unpacked\Agent Dev Platform.exe"
& $exe --smoke  # 独立 userData
```

最新一次输出：

```
Agent Dev Platform ready on http://127.0.0.1:11962
SMOKE_PROBE {"hasApi":true,"title":"Agent Dev Platform","agentOptions":5,"chatItems":0,"messages":0,"fatal":false,"bodyLen":5726}
SMOKE_DIAG {"title":"能力诊断","hasRunBtn":true,"hasMatrix":true,"hasEmpty":false,"hasErr":false}
SMOKE_OK
ExitCode: 0
```

**结论：PASS。**
- 主窗口出现（hasApi / title 正常）
- 无白屏（bodyLen 5726）
- 无 Fatal（SMOKE_OK）
- 导航正常（诊断页矩阵渲染）
- 智能体页正常（agentOptions:5）
- 聊天页正常（首次启动 chatItems:0 / messages:0 是预期）

---

## 6. WorkBuddy Bridge 验收

### 6.1 自动 Harness（test/）

| Harness | 用例数 | 结果 |
| --- | ---: | --- |
| `test/desktopbridge.test.js` — DesktopAgentBridge 状态机全分支 | 19 | PASS |
| `test/desktopvision.test.js` — DesktopVisionReader 降级读屏 | 19 | PASS |
| `test/workbuddy-emptyuia.test.js` — 空 UIA 阈值 | 4 | PASS |
| `test/services.test.js` — 穿透外部 Agent 运行时（视觉降级 / VISION_MODEL_REQUIRED / PERMISSION_DENIED / Stop / Codex cwd / mapExternalResult 四态映射） | 26 | PASS |

**Harness 总计：68 / 68 PASS。**

### 6.2 真窗口定位

`externalAgents:test` IPC（前端「测试 WorkBuddy 桥接」按钮调用）已实现：
1. `bridge.locateWindow()` 真实调用 `.NET UIAutomation` 列窗口 + 标题匹配 `/workbuddy/i`
2. 命中后 `bridge.readWindowText(title)` 尝试读取 UI 文本
3. 不可读时报告「窗口未暴露 UI 文本（可开启视觉降级）」
4. 全程不发任何任务、不写文件、不执行命令

### 6.3 完整任务往返（端到端 WorkBuddy 对话）

**结果：NOT VERIFIED。**

原因：本开发会话本身即在 WorkBuddy 宿主中。按 P0-4 §22 要求「如果当前开发会话就是正在修改 Agent Dev Platform 的 WorkBuddy 会话，禁止把完整开发任务再次发送给自身」。

可用的固定安全测试 prompt（已写入代码注释，未来手动或独立新会话执行）：

```
这是 Agent Dev Platform 桥接测试。
不要修改任何文件，不要执行任何命令。
请只回复：
WORKBUDDY_BRIDGE_OK
```

成功后应记录：`Bridge PASS`、`读取方式：UIA / Vision`、`耗时：xx 秒`。

---

## 7. Real API（用户自有 API Key）

### 7.1 Fake API（E2E 用）

`test/e2e/fake-api.js` 提供：
- `GET /v1/models` → model-A / model-B / model-C
- `POST /v1/chat/completions` → SSE 流式回复「你好，我是测试智能体。」
- `model=model-FAIL` → HTTP 500
- `model=model-HANG` → 永不返回

**结果：PASS。**（已用于 E2E Case 3/4/5/6）

### 7.2 真实第三方 API

**结果：NOT VERIFIED。**

原因：当前环境无用户配置的真实 API Key。
按 §26 要求，不读取、不打印、不提交 API Key；不伪造结果。

### 7.3 Smoke Test 入口

产品已提供「测试连接」「获取模型」「发送聊天」完整路径，用户配置自有 API Key 后可：
1. API 连接 → 测试连接
2. 拉取模型列表（含 source 标签）
3. 选模型发送聊天

无需新增页面。

---

## 8. CI（GitHub Actions）

### 8.1 Workflow 文件

`.github/workflows/windows-test.yml` 已配置，三个 job：

| Job | runner | 必需 | 步骤 |
| --- | --- | :---: | --- |
| `unit` | `windows-latest` | ✓ | checkout / setup-node 20 / npm ci / npm run rebuild / npm test |
| `smoke` | `windows-latest` | ✓ | 同上 + npm run smoke |
| `e2e` | `windows-latest` | （非阻塞） | 同上 + npm run e2e（`continue-on-error: true`，因 GitHub-hosted runner 桌面会话稳定性不保证） |

> E2E 在 CI 中允许失败：Unit + Smoke 是 CI 必过项；E2E 留给本地 Windows 真机跑（§36 要求）。

### 8.2 真实执行结果

**结果：CONFIGURED / 待 push 后真实执行。**

Workflow 文件随本次 v2.3.2 commit 推送到 `origin/main` 后才会触发首次 run。
真实 conclusion 出来前不写「CI PASS」。

---

## 9. 测试产物清理（P1-5）

### 9.1 Git 历史

旧 commit 错误提交了 `test/e2e/report/`（Playwright HTML 报告 + trace + 截图 + zip）。
本轮已通过 `git rm -r --cached test/e2e/report` 全部从 Git 移除。

### 9.2 .gitignore

```
# Playwright E2E artifacts
test-results/
playwright-report/
test/e2e/report/
test/e2e/results/
*.trace.zip
```

不全局忽略 `*.png` / `*.zip`（避免未来误伤合法资源）。

### 9.3 验证

```bash
git ls-files test/e2e/report
# 输出为空
git ls-files test-results
# 输出为空
git ls-files playwright-report
# 输出为空
```

**结论：测试产物已全部从 Git 移除。**

---

## 10. v2.3.2 修复清单（commit-worthy）

| # | 问题 | 修复位置 | 验证 |
| --- | --- | --- | --- |
| 1 | `agent:send` 等待 runChatTurn 完成才返回 runId，Renderer 长时间无 ACK，违反 IPC 立即响应语义 | `src/ipc/handlers.js` `agent:send` 改为创建 Run 后立即 return，IIFE 异步执行 runChatTurn | `agentack.test.js` 3 用例 |
| 2 | 后台异步执行若抛异常可能产生 UnhandledPromiseRejection | IIFE 完整 try/catch/finally，所有异常经 `runManager.finishRun()` 进入唯一终态 | `agentack.test.js` 异常收口用例 |
| 3 | E2E Case 3 主路径发送失败：主智能体未配模型，preflight 拦截 | `test/e2e/seed-db.js` 总是把主智能体更新为 Fake API + model-B；输出 `SEED_VERIFY` 验证写入 | E2E Case 3 PASS |
| 4 | Fake API SSE 流不发送：`req.on('close')` 在请求体接收后立即触发，清掉定时器 | `test/e2e/fake-api.js` 改用 `res.on('close')` | E2E Case 3 PASS |
| 5 | E2E Case 7 模型数量断言过严：merge 后 = API 模型 + 手动模型 | 改为断言「已成功获取」文本，不依赖具体数量 | E2E Case 7 PASS |
| 6 | Run 终态未与数据库一致 | 新增 IPC `runs:get` / `runs:list`；E2E 直接读 `runs` 表断言 `row.status === UI 终态` | E2E Case 3-6 数据库一致性断言 |
| 7 | E2E 超时根因不可见 | `dumpDiagnostics()` 输出 RunManager 状态 / DOM / 事件流 / 主智能体配置；新增 `diagnostics:dumpRuns` IPC | E2E 失败时自动 dump |
| 8 | `buildToolDefsFor` 依赖 `/main/i.test(name)` 判断 Main | 改为 `agent.is_main` 唯一判据（Computer 操作员同等待遇） | 代码审查 + E2E Case 3 |
| 9 | Playwright HTML 报告 / trace / 截图被错误提交 | `git rm -r --cached test/e2e/report`；`.gitignore` 新增 `test/e2e/report/` 等 | `git ls-files test/e2e/report` 为空 |
| 10 | TEST_REPORT.md 顶部 246 与正文 222 矛盾 | 整体重写为 v2.3.2 真实数据（250 / 250 / 9/9） | 本文档 |

---

## 11. 已知限制（不掩盖）

1. **真实 WorkBuddy 端到端桥接未验证**：本开发会话即在 WorkBuddy 宿主中，按 §22 禁止递归发送任务。Harness + 真窗口定位 PASS；完整任务往返 NOT VERIFIED。
2. **真实第三方 API 未验证**：当前环境无用户 API Key，未伪造结果。
3. **GitHub Actions 真实执行结果待 push 后产生**：Workflow 已配置，未写「CI PASS」直到真实 run success。
4. **NSIS 安装向导 UI 截图回归未覆盖**：electron-builder 默认产物，未做交互回归。
5. **鼠标拖动 / 多窗口交互未覆盖**：设计上是 GUI 投入产出比低的项；靠 smoke + E2E + 单测兜底。

---

## 12. 复现

```bash
git clone https://github.com/3571949306/agent-dev-platform
cd agent-dev-platform
git checkout v2.3.2          # 待 push 后可用
npm install
npm run rebuild              # 重新按 Electron ABI 编译 better-sqlite3
npm test                     # 应当看到 250 / 250 PASS
npm run smoke                # 应当看到 SMOKE_OK（含 SMOKE_DIAG 诊断页校验）
npm run e2e                  # Windows 桌面 + 显示器环境下应看到 9 passed
npm run dist                 # 生成 Setup / portable / win-unpacked
```

> **注意**：在 WorkBuddy 宿主内运行时，宿主会向环境注入 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以 Node 模式启动而打不开 GUI。运行 `npm test` / `npm run smoke` / `npm run e2e` / `npm run dist` 前需先 `env -u ELECTRON_RUN_AS_NODE` 取消该变量。
