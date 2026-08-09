# External Agent Runtime Research — Cline SDK

> spec: Agent Dev Platform v2.7.2 — External Agent Runtime Reliability
> 对应章节：§4 / §5 / §6 / §7 / §35 / §36 / §37

- **research date**: 2026-08-09
- **researcher**: automated (WebBuddy agent)
- **sources**:
  - Cline 官方 SDK 文档 — https://docs.cline.bot/sdk/overview
  - Cline SDK 架构 / 包边界 — https://docs.cline.bot/sdk/architecture/overview
  - Cline 官网 SDK 页 — https://cline.bot/sdk
  - npm registry — `npm view @cline/sdk version | engines | type`

---

## 1. Tested package & version

| 项 | 值 |
| --- | --- |
| package name | `@cline/sdk` |
| tested version (npm latest @ research date) | **0.0.72** |
| distribution | npm public registry |
| license | Apache 2.0（官方博客明确声明 open source） |

> **重要（spec §7）**：旧代码硬编码 `'0.0.72'`。本轮已改为从 SDK package metadata 动态读取
> （`sdkBridge.readSdkVersion` → `probeSdk().version` / `versionSource`）。`0.0.72` 恰好是
> 当前真实最新版本，因此动态读取会得到它——这是**真实值**，不是伪造；若 metadata 缺失则
> `version = null`（标记 `unknown`），绝不回退到字面量。

## 2. Node requirement & Electron compatibility

| 项 | 值 |
| --- | --- |
| `engines.node` | **`>=22`** |
| module type | **`module`**（ESM-only，无 CJS 构建产物） |
| Electron 31 内置 Node | **18.x** |

**结论：@cline/sdk 无法在 Electron 31 主进程的 Node 18 运行时内直接加载。**
动态 `import('@cline/sdk')` 在 Node 18 下会因 engines 不满足 / 原生依赖不兼容而失败（MODULE_NOT_FOUND 或运行时报错）。

## 3. Integration decision（spec §5 / §6）

**采用 Sidecar Process，不升级 Electron 大版本。**

```text
Electron Main (Node 18)
   ↓ child_process
Cline SDK Sidecar (Node 22+)
   ↓ import('@cline/sdk')
@cline/sdk runtime
```

- Sidecar 使用 Node ≥22 独立进程承载 `@cline/sdk`。
- 与宿主通过 **IPC JSONL / stdio** 通信，消息包含：`start` / `event` / `cancel` / `timeout` / `exit` / `secret-filtering`。
- 当前 `src/agents/integrations/cline/sdkBridge.js` 的 in-process `dynamic import()` 作为 **facade** 保留：
  在 @cline/sdk 未安装 / Node 不兼容时，`detect()` 如实返回 `available=false`（不谎报 healthy）。
  真正的 Sidecar 进程实现是后续任务，不在 v2.7.2 阻塞项内。

> **P0 §4 现状**：`package.json` 当前**未声明** `@cline/sdk` 依赖。这是预期状态——
> 因为 in-process 集成不可行，依赖应随 Sidecar 运行时单独安装（或在 Sidecar 子项目中声明），
> 而非塞进主进程的 `dependencies`。v2.7.2 不强行 `npm install @cline/sdk@latest` 到主进程。

## 4. Exports & Agent API（spec §35）

`@cline/sdk` 是 `@cline/core` 的用户态别名，re-export 全部子包：

| export | 含义 |
| --- | --- |
| `Agent` | 无状态 Agent 运行时（= `@cline/agents` 的 `AgentRuntime` 别名） |
| `ClineCore` | 有状态会话运行时（session / storage / hub / automation） |
| `createTool` | 声明自定义工具的 helper |

**构造函数（与我们适配器假设一致 ✅）：**

```ts
import { Agent } from '@cline/sdk';
const agent = new Agent({
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxIterations: 1,
});
```

> 我们 `clineAgentAdapter.js` 的 `agentConfig`（`providerId` / `modelId` / `apiKey` / `maxIterations`）与官方一致，
> 无需为构造签名改代码。

**运行 / 取消：**

```ts
agent.subscribe((event) => { /* event.type: 'assistant-text-delta' ... */ });
const result = await agent.run('prompt');   // AgentRunResult
agent.abort(reason?);                        // 取消活动 run；.run() resolve 为 status 'aborted'
```

- 取消 API 是 **`agent.abort(reason?)`**，不是 `cancel()`。
- 我们适配器 `_cancelAgent()` 同时调用 `agent.cancel?.()` 与 `agent.abort?.()`（均 guarded），兼容两种命名。
- **注意**：官方 `AgentRuntimeConfig` **没有**顶层 `onEvent` 字段；事件必须走 `agent.subscribe()`
  或 `hooks.onEvent`。我们 `sdkBridge.createAgent(config, onEvent)` 的 `onEvent` 是当前 facade 的
  自定义约定；接入真实 SDK 时，bridge 必须把 `onEvent` 转发为 `agent.subscribe(onEvent)`。

## 5. Event API（spec §36）

真实事件名（节选）：`assistant-text-delta`、`tool-*`、`run` 边界（`run` / `turn`）、usage 更新、
`run` 完成 / 失败。结果文本在 `AgentRunResult.outputText`，usage 在 `result.usage`。

> 我们当前的 `mapClineEvent` 与 `parseClineResult` 假设事件名 `content_update` / `tool_call` /
> `task_completed` 与字段 `raw.text` / `raw.usage`。这些是 **facade 自创 shape**，与官方不一致。
> Sidecar 接入时必须：
> 1. `eventMapper` 改为映射 `assistant-text-delta` 等真实事件；
> 2. `parseClineResult` 增加 `outputText` 读取（保留 `text`/`output` 兼容）。
> 此项随 Sidecar 实现一并完成，v2.7.2 先固化 facade 的「诚实性」（detect/health/timeout/cancel/late-result）。

## 6. projectRoot / workspace scoping（spec §37 / §38）

- 官方 Agent 通过构造配置指定工作目录（SDK 文档示例未明确字段名；`cwd` / `workspacePath` / `workingDirectory` 之一或组合）。
- 我们 bridge 已同时下发 `cwd` / `workspacePath` / `workingDirectory` 三个别名，并 `describeAgentWorkspace` 回读确认是否接住；
  未接住时在结果 `warnings` 如实标注「workspace scoping is unverified」，不假装沙箱化。
- 若官方 SDK 不提供内置 sandbox，Agent Dev Platform 需另加 **Tool Policy** 或 **Sidecar cwd 约束**（spec §38）。

## 7. OpenCode / OpenHands（对照）

- **OpenCode**：本地 `opencode serve`（127.0.0.1 + 口令），HTTP/SSE。无 Node 版本限制，in-process 可达；
  已落地 server 引用计数、SSE 异常 → FAILED、abrupt disconnect → `AGENT_STREAM_ENDED_WITHOUT_TERMINAL`。
- **OpenHands**：本地 CLI（`openhands-agent-server` / `python -m openhands.agent_server`）不稳定，官方更适合
  远程 `serverUrl`。采用 spec §33 方案 B：未配置 `serverUrl` 时 `installed=true / configured=false / available=false`，
  不谎报 healthy（GUI 显示「已检测到 OpenHands，尚未配置 Agent Server」）。

## 8. Follow-ups（不在 v2.7.2 阻塞项）

1. 实现 Cline SDK **Sidecar 进程**（Node 22+），IPC JSONL/stdio，含 start/event/cancel/timeout/exit/secret-filtering。
2. 把 `onEvent` facade 改为 `agent.subscribe()` 转发，更新 `eventMapper` 到真实事件名。
3. `parseClineResult` 增加 `outputText` 读取；结果契约统一（§39）。
4. spec §10：在 packaged app 增加 `--integration-smoke`，验证 `@cline/sdk` 在 Sidecar 运行时内
   `dynamic import` 成功、`no MODULE_NOT_FOUND`（仅在 Sidecar 依赖落地后才有意义）。
5. spec §54-§57：GUI Agent Center 展示 Installed / Configured / Runtime / Health / Version / Integration 六维状态。
