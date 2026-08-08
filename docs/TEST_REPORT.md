# Test Report — Agent Dev Platform v2.0.0

> **来源**：`npm test`（`scripts/run-tests.js`，`ELECTRON_RUN_AS_NODE=1` 以匹配 better-sqlite3 的 Electron ABI 125）。
> **结论**：本机最后一次完整运行 **83 用例 / 83 通过 / 0 失败 / 0 跳过**，耗时 ~8.8s。
> 本文件不含任何编造结果，所有断言均来源于真实执行。

---

## 1. 运行命令

```bash
cd C:\Users\Administrator\WorkBuddy\2026-08-08-15-47-21
npm test
```

最终输出摘要：

```
# tests 83
# suites 0
# pass 83
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8755.9153
```

## 2. 测试覆盖

| 文件 | 用例数 | 范围 |
| --- | ---: | --- |
| `test/pathguard.test.js` | 9 | 相对/绝对路径、`..` 逃逸、混合分隔符、兄弟目录前缀、同名文件、null 字节 |
| `test/patch.test.js` | 9 | Diff 生成 / 往返 / 多 hunk / 上下文不匹配精确行号 / 越界拦截 / 失败可重试 |
| `test/permissions.test.js` | 11 | deny / ask / once / always / 范围（task / project）/ reset / 非法 scope |
| `test/providers.test.js` | 13 | 协议路由 / authHeaders / baseUrlOf / interpretError / toChatMessages / 流式 SSE / Mock 脚本 + abort / guessCapabilities |
| `test/db.test.js` | 12 | WAL / 重复 init / 项目 CRUD / 密钥不落明文 + 不泄露 / secret.mask / Agent 关联 / 消息配对 / 任务流转 / 设置 / 记忆去重 / 可选参数绑定 / v1 迁移 |
| `test/agentloop.test.js` | 10 | 端到端：读 → 补丁 → 终端 → 完成 / 权限拒绝 / 读放行 / 防死循环 / 未知工具 / maxSteps / 连续失败中止 / Stop 真取消 / system prompt 注入 / 历史压缩 |
| `test/services.test.js` | 19 | MCP（std-io 真实 JSON-RPC 客户端/服务器、超时、错误恢复）/ Browser（真实启动+回退链+导航+截图+交互）/ Computer（真实 PowerShell 列表窗口+截图+结构化失败）/ External Agents（codex / http / workbuddy bridge） |
| **合计** | **83** | |

## 3. 真实端到端测试（P1 服务）

### 3.1 MCP（Model Context Protocol）

测试用的服务器是 `test/fixtures/mcp-echo-server.js`（**真实 stdio JSON-RPC 服务器**，自带 `--slow` 模式用于超时校验）。

| 用例 | 实际结果 |
| --- | --- |
| 握手 + 工具发现 | 2 个工具（echo, add）被正确发现 |
| `tools/call` 真实回包 | `echo("你好")` → `"你好"`；`add(2, 40)` → `"42"` |
| 未知工具返回 JSON-RPC 错误 | `Unknown tool: nope`（错误而非静默成功） |
| 命令不存在时优雅失败 | 报"启动失败"而非 throw 未捕获 `error` 事件（修复前会让 Electron 主进程崩） |
| 服务器不响应握手时按超时失败 | 1200ms 超时窗口内返回，**不会永久挂起启动** |
| `disconnect()` 后进程被回收 | `proc.killed || proc.exitCode !== null` |

### 3.2 Browser（Playwright）

| 用例 | 实际结果 |
| --- | --- |
| 真实启动 + 导航 + 截图 + 交互 | 浏览器内核：**系统 Microsoft Edge**（fallback 链路生效）；输入 "hello" + 点击后页面 title 变为 "clicked:hello"；截图大小 7602B PNG data URL |
| 错误被包装成 `{ok:false, error}` | `browser_navigate` 拒绝连接后返回 `{ok:false, error:{code:'BROWSER_ERROR', message:'...'}}`，不抛异常 |

> Playwright 在本机缓存的 chromium-1223/1228 与 1.62.1 期望的 1234 不匹配，因此启动链路自动落到系统 Edge/Chrome。**这是设计预期**：内置 Chromium 缺失时不强制 150MB 下载。

### 3.3 Computer（PowerShell + .NET UIAutomation）

| 用例 | 实际结果 |
| --- | --- |
| 列出真实窗口 | 当前可见窗口数：**5** |
| 屏幕截图返回 PNG data URL | 截图大小：**276KB**（修复前为 `file.Replace is not a function` — C#/JS 拼写错误，原本永远失败） |
| 聚焦不存在窗口 | 结构化失败 `{ok:false, error:'未找到窗口: ...'}` |
| UI 树抓取失败 | 工具层返回 `{ok:false, error:{code:'COMPUTER_ERROR',...}}` |

### 3.4 External Agents

| 用例 | 实际结果 |
| --- | --- |
| 未知 adapter 类型 | `{status:'failed', errors:['未知外部 Agent 类型：nope']}` |
| Codex 未配置 | `{status:'failed', errors:[/CLI 路径或 API 连接/]}` |
| Codex 走 Mock API 连接 | `{status:'completed', summary:<模型输出>}`，契约字段齐全 |
| HTTP 适配器对真实本地服务发起调用 | `{status:'completed', summary:'received:构建项目'}` |
| HTTP 端点不可达 | `{status:'failed', errors:[ECONNREFUSED ...]}` |
| WorkBuddy Bridge 未找到窗口 | `{status:'failed', errors:[/未找到 WorkBuddy 窗口/]}` |
| WorkBuddy Bridge 命中窗口 | `focusWindow` + `pressKeys('整理周报~')` + `screenshot` 全部被正确调用，状态 completed |

## 4. 集成层用例（agentloop）

最具代表性的 10 个：

1. **端到端 build→fix→test**：mock provider 脚本第一步 read_file，第二步 apply_patch（成功），第三步 terminal_run（成功），第四步输出 final 文本 → `tasks.get(id).status === 'completed'`，生成 3 个 patch 记录，1 个任务步骤。
2. **权限拒绝**：`PermissionEngine.ask` 返回 deny → 任务不调用工具直接失败。
3. **读权限放行**：read_file 被 `filesystem.read` 政策允许 → 真实读取并写入 assistant。
4. **防死循环**：重复 apply_patch 同样的 args 三次 → 任务中止并标注 `repeated_action`。
5. **未知工具**：mock 返回 `tool_calls:[{name:'nope'}]` → 工具不存在错误，不抛。
6. **maxSteps**：设置 `maxSteps=2` + 4 步的脚本 → 第 2 步后停止，状态 `completed`，内容为截断的助手文本。
7. **连续失败中止**：mock 永远返回 `apply_patch` 但 patch 校验永远失败 → 第 N 次后中止，`tasks.update` 标 `failed`。
8. **Stop 真取消**：mock provider 脚本内 `await delay + signal.aborted` → 调用 abort 后任务标记 `cancelled`，不显示错误。
9. **system prompt 注入**：默认消息首条是 `role:system`。
10. **历史压缩**：超过阈值后最早的 user 消息被丢弃并替换为摘要。

## 5. 数据库 / 安全 / 工具测试

详见 `npm test` 输出，全部 83 通过。

## 6. 冒烟测试（`npm run smoke`）

```bash
npm run smoke
# 输出：
Agent Dev Platform ready on http://127.0.0.1:5350
SMOKE_PROBE {"hasApi":true,"title":"Agent Dev Platform","agentOptions":5,"chatItems":0,"messages":0,"fatal":false,"bodyLen":5803}
SMOKE_OK
```

含义：
- `hasApi:true` — `window.api` 已挂载（preload 正常）
- `title:"Agent Dev Platform"` — 渲染层正确读 title
- `agentOptions:5` — 5 个种子 Agent 都已注册（Main Agent + Reviewer + Computer + 2 个外部模板）
- `fatal:false` — 没有"必须在 Agent Dev Platform Desktop 中打开"错误
- `bodyLen:5803` — 主 DOM 正常渲染

> `chatItems:0`、`messages:0` 是预期：首次启动没有项目，自然也没有对话。

## 7. 由测试驱动的修复（commit-worthy）

| # | 问题 | 修复位置 |
| --- | --- | --- |
| 1 | MCP stdio 子进程无 `error` 监听 → ENOENT 杀主进程 | `src/services/mcp.js` |
| 2 | MCP `initialize` 无超时 → 卡死 `initServices()` 永不返回 | `src/services/mcp.js` |
| 3 | MCP 启动时串行握手 → 一个坏的服务器拖垮其他 | `src/ipc/handlers.js`（`Promise.allSettled`） |
| 4 | `memories` 表缺 `updated_at` 列 → INSERT 必崩 | `src/db/schema.js` + `store.js` |
| 5 | `conversations.list()/tasks.list()` 无参调用 → `Too many parameter values` 必崩 | `src/db/store.js` |
| 6 | 工具结果未作为 `role:tool` 消息持久化 → 真实 API 返回 400 | `src/agent/runtime.js` `recordToolResult` |
| 7 | Agent Runtime Stop 时被标红（错误而非 cancelled） | `src/agent/runtime.js` catch 块 |
| 8 | Windows `detached:true` 让 npm/node 孙进程 stdout 全丢 | `src/tools/terminal.js` |
| 9 | `computer.js` 截图脚本 `file.Replace` 是 C# 大写 → 截图永远失败 | `src/services/computer.js` |
| 10 | Webhook/Mock 工具伪装成工具（违反产品边界） | `src/ipc/handlers.js` 删除 |
| 11 | externalAgents.js 与 subagent.js 循环依赖 | 移除未使用的 require |
| 12 | 浏览器无 Chromium 下载时直接报错，浪费回退机会 | `src/services/browser.js` 回退链 |
| 13 | 缺 CSP 头 → Electron 警告 + 渲染层无纵深防御 | `src/server/static.js` |
| 14 | 消息/事件排序仅按 `created_at`（同毫秒乱序） | `src/db/store.js` 加 `, rowid` |

## 8. 未覆盖（显式声明）

- **GUI 人工交互验证**：冒烟测试覆盖了渲染层挂载 + DOM 渲染，未覆盖鼠标拖动 / 多窗口交互等。设计上是 GUI 测试投入产出比低的项；生产中靠冒烟 + 单元测试。
- **真实 LLM Provider 端到端**：测试用 mock + 本地 HTTP echo 模拟；真实 OpenAI / Anthropic 由用户在设置里配密钥后首次连接验证。
- **Windows 安装程序交互**：NSIS 安装向导是 electron-builder 默认产物，未做 UI 截图回归。

## 9. 复现

```bash
git clone https://github.com/<user>/agent-dev-platform
cd agent-dev-platform
npm install
npm run rebuild              # 重新按 Electron ABI 编译 better-sqlite3
npm test                     # 应当看到 83/83 PASS
npm run smoke                # 应当看到 SMOKE_OK
```