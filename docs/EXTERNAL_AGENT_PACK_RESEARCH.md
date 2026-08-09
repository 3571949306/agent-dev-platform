# External Agent Pack Research — 外部 Agent 接入调研（Cline / OpenCode / OpenHands）

> **调研日期**：2026-08-09
> **数据来源**：全部来自官方源（GitHub 官方仓库、官方 npm 包、官方文档）
> **目的**：为 Agent Dev Platform 的 External Agent Pack 选型提供事实依据，明确每个候选 Agent 的集成方式、API 表面、取消机制与鉴权模型。

---

## 1. Cline

- **官方仓库**：https://github.com/cline/cline
- **SDK 包**：`@cline/sdk`（npm）
- **SDK 版本**：0.0.72（pre-1.0，仅 ESM）
- **License**：Apache-2.0
- **模块格式**：仅 ESM（无 CJS 导出）
- **Node 引擎**：>= 22

### 1.1 SDK API 表面

| API | 说明 |
|-----|------|
| `Agent` 类 | 构造参数：`{ providerId, modelId, apiKey, systemPrompt?, tools?, maxIterations?, onEvent? }` |
| `agent.run(prompt)` | 启动任务，阻塞直到当前 turn 结束 |
| `agent.continue(prompt)` | 多轮续接 |
| `agent.subscribe(callback)` | 订阅流式事件 |
| `ClineCore` 类 | 完整运行时，含会话与内置工具（bash、editor、read_files、apply_patch、search、fetch_web） |
| `createTool({ name, description, inputSchema, execute })` | 注册自定义工具 |
| `ClineAgent`（ACP 兼容） | `initialize` / `authenticate` / `newSession` / `prompt` / `cancel` / `shutdown` + 事件发射器 |

**事件类型**：

- SDK 流式事件：`content_start`、`content_update`、`usage`
- ACP 事件类型：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`error`

### 1.2 模型配置

- 行内传入 `providerId` + `modelId` + `apiKey`；或
- 使用 `cline auth` CLI 持久化凭据。

### 1.3 集成方式

- **集成类型**：npm 依赖（CJS 宿主通过 `dynamic import()` 加载 ESM）。
- **取消**：`agent.cancel()`（ACP 路径）或 `AbortController`。

---

## 2. OpenCode

- **官方仓库**：https://github.com/anomalyco/opencode
- **当前版本**：v1.18.15
- **License**：MIT

### 2.1 服务器命令

```
opencode serve [--port <number>] [--hostname <string>]
```

- 默认端口：`4096`
- 默认 hostname：`127.0.0.1`
- OpenAPI 规范：`/doc`

### 2.2 服务器 API 端点

| 方法 | 路径 | 说明 / 返回 |
|------|------|-------------|
| `GET` | `/global/health` | `{ healthy: true, version: string }` |
| `POST` | `/session` | 创建会话 → `Session` |
| `POST` | `/session/:id/message` | 同步发送 prompt → `{ info, parts }` |
| `POST` | `/session/:id/prompt_async` | 异步发送 prompt → `204 No Content` |
| `GET` | `/session/:id/message` | 列出消息 |
| `GET` | `/event` | SSE 事件流，首个事件 `server.connected` |
| `POST` | `/session/:id/abort` | 取消 → `boolean` |
| `GET` | `/session/:id/diff?messageID=` | → `FileDiff[]` |
| `GET` | `/session/status` | 会话状态 |
| `DELETE` | `/session/:id` | 删除会话 |
| `GET` | `/global/event` | 全局 SSE 事件流 |

### 2.3 鉴权

- HTTP Basic Auth（可选，通过 `OPENCODE_SERVER_PASSWORD` 环境变量启用）。

### 2.4 集成方式

- **CLI 探测**：在 `PATH` 中执行 `opencode --version`。
- **集成类型**：托管 HTTP 服务器（以子进程方式启动 `opencode serve`）。
- **取消**：`POST /session/:id/abort`。

---

## 3. OpenHands

- **官方仓库（Agent Server）**：https://github.com/OpenHands/software-agent-sdk
- **主仓库**：https://github.com/OpenHands/OpenHands
- **当前版本**：v1.41.0（`openhands-agent-server`）
- **License**：MIT

### 3.1 Agent Server 架构

- FastAPI + uvicorn + WebSockets。

### 3.2 HTTP API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `POST` | `/conversations` | 创建会话 |
| `GET` | `/conversations/{conversation_id}` | 获取会话 |
| `GET` | `/conversations/search` | 搜索会话 |
| `GET` | `/conversations/{conversation_id}/events` | 获取事件 |
| `POST` | `/conversations/{conversation_id}/events` | 发送消息 |
| `DELETE` | `/conversations/{conversation_id}` | 删除会话 |
| `POST` | `/v1/chat/completions` | OpenAI 网关（需 `X-OpenHands-ServerConversation-ID` 头） |
| `PATCH` | `/api/settings` | 设置 |

### 3.3 WebSocket API

- 地址：`ws://<host>:<port>/conversations/{conversation_id}/events/socket`
- 客户端发送：`{"type": "message", "content": "..."}`
- 服务端推送：Action / Observation 事件。

### 3.4 工作区模型

基于文件，根目录 `workspace/`：

- `workspace/conversations/{conversation_id}/events.jsonl` — 事件日志
- `workspace/project/` — Agent 工作区
- 创建会话时指定 per-conversation `working_dir`。

### 3.5 本地服务器命令

```
python -m openhands.agent_server --host 127.0.0.1 --port 8000
```

### 3.6 鉴权

- 可选 Session API Key，通过 `OH_SESSION_API_KEY` 环境变量配置：
  - 经 `X-Session-API-Key` 头或 `Authorization: Bearer` 头发送。
- 密钥加密：`OH_SECRET_KEY` 环境变量。

### 3.7 集成方式

- **集成类型**：HTTP REST API + WebSocket。
- **取消**：关闭 WebSocket 或删除会话。

---

## 4. 选型摘要

| 维度 | Cline | OpenCode | OpenHands |
|------|-------|----------|-----------|
| 集成类型 | npm 依赖（ESM） | 托管 HTTP 服务器（子进程） | HTTP REST + WebSocket |
| License | Apache-2.0 | MIT | MIT |
| 版本 | 0.0.72（pre-1.0） | v1.18.15 | v1.41.0 |
| 模块格式 | 仅 ESM | CLI / HTTP | HTTP / WS |
| 取消机制 | `agent.cancel()` / `AbortController` | `POST /session/:id/abort` | WS 关闭 / 删除会话 |
| 鉴权 | `cline auth` CLI 或行内 | HTTP Basic（可选） | Session API Key（可选） |
| 流式事件 | `content_start` / `content_update` / `usage` | SSE（`/event`） | WebSocket 事件流 |
