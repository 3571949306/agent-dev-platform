# ACP Runtime（v2.8.0 spec §20 / §136）

通用外部 Agent 通信层中"会说 ACP 的 Agent"一侧的运行时。决策背景见
`docs/ACP_RUNTIME_DECISION.md`；上游钉版见 `docs/UPSTREAM_REFERENCE_MATRIX.md`。

## 1. 在整体架构中的位置

```text
Main Agent → Agent Router → Agent Hub → External Agent Runtime
                                            ├─ AcpClientRuntime      ← 本文
                                            ├─ Codex App Server / exec
                                            ├─ Claude Agent SDK / CLI
                                            └─ CLI / HTTP / Desktop / Native ...
```

`AcpAgentAdapter`（`src/agents/adapters/acpAgentAdapter.js`）实现统一的
`BaseAgentAdapter` 接口，内部驱动 `AcpClientRuntime`；每 Run 独立 Agent 进程，
终态即回收。

## 2. 模块清单（`src/agents/protocols/acp/`）

| 模块 | 导出 | 职责 |
| --- | --- | --- |
| `constants.js` | `PROTOCOL_VERSION`, `METHOD`, `NOTIFICATION`, `CLIENT_METHOD`, `SESSION_UPDATE`, `STOP_REASON`, `PERMISSION_OPTION_KIND`, `ACP_SESSION_CAPABILITY`, `V2_RECORD` ... | ACP **wire v1** 全部常量，逐字对齐 `agent-client-protocol/schema/v1`。禁止在本文件之外硬编码 ACP method 字符串 |
| `acpProcessTransport.js` | `createAcpProcessTransport` | spawn 子进程，stdio 行分帧，进程退出/崩溃信号上报 |
| `acpTransport.js` | `createAcpTransport`, `DEFAULT_REQUEST_TIMEOUT_MS` | JSON-RPC 2.0 请求/响应/通知编解码，pending 表，超时 |
| `acpClientRuntime.js` | `createAcpClientRuntime`, `toContentBlocks`, `classifyStopReason` | 客户端协议状态机：握手、session、prompt、cancel、反向请求分发 |
| `capabilityMapper.js` | `extractAcpCapabilityFlags`, `negotiateCapabilities`, `hasSessionCap` ... | InitializeResponse.capabilities → 平台能力旗标；resume/load 等按需判 capability |
| `eventMapper.js` | `createAcpEventMapper`, `contentBlockToText`, `isExecuteKind`, `isWriteKind` | SessionUpdate 11 变体 → 平台 `AGENT_EVENT`（含 REASONING / COMMAND_OUTPUT） |
| `authBroker.js` | `createExternalAgentAuthBroker`, `AUTH_STATE`, `AUTH_MODE` | 认证**状态机**（只存状态不存凭据）：UNKNOWN / AUTH_REQUIRED / AUTHENTICATED / API_KEY / EXTERNAL_LOGIN / FAILED |
| `permissionBroker.js` | `OPERATION`, `mapAcpToolCall`, `mapAcpPermissionRequest`, `evaluate`, `selectPermissionOption` ... | 权限交集裁决：Parent Run Permission ∩ Platform Policy ∩ External Agent Policy |
| `errors.js` | `ACP_ERROR`, `AcpError`, `jsonRpcError` | 协议错误码：`ACP_PROTOCOL_UNSUPPORTED` / `RESUME_UNSUPPORTED` 等，fail-closed 语义 |

## 3. 生命周期

```text
connect()
  spawn(command, args, { cwd, env: allowlist })
  → initialize { protocolVersion: 1, clientCapabilities }
  → 校验 Agent 回包 protocolVersion ≤ MAX_SUPPORTED(=1)，否则 ACP_PROTOCOL_UNSUPPORTED 断开
  → 记录 agentCapabilities / authMethods / agentInfo

createSession({ cwd, mcpServers?, resume? })
  → session/new（sessionId 由 Agent 生成，client 不自造）
  → resume 需 sessionCapabilities.resume，否则 RESUME_UNSUPPORTED（禁止重放历史冒充）

prompt(text | ContentBlock[])
  → session/prompt，流式接收 session/update
  → Agent 反向请求 session/request_permission → permissionBroker.evaluate()
      ├─ 交集内且策略允许 → 交 GUI 逐次审批（allow_once / allow_always / reject_*）
      └─ 交集外 → 直接 reject（不发 GUI）
  → fs/* / terminal/* 反向请求同样过 Broker + externalTerminalGate
  → PromptResponse.stopReason → classifyStopReason()
      end_turn → completed(ok)；max_tokens / max_turn_requests → completed(truncated)；
      refusal → completed(ok=false，上层凭 errors 感知，不冒充崩溃)；
      cancelled → cancelled；缺失 → failed(协议违规)；未知值 → completed(ok=false)

cancel()
  → 发 session/cancel **通知**（不是请求！），flush pending permissions 为 cancelled，
    grace period 后进程仍存活则 killTree
```

## 4. 终态语义（与全平台一致）

- 终态恰好一次（terminalCount == 1），之后的 late event 一律忽略；
- 进程 unexpected exit = **FAILED**，绝不判 COMPLETED（spec §65）；
- timeout ≠ cancelled：超时记 FAILED/TIMEOUT 语义，不冒用 CANCELLED（spec §67）；
- `session/cancel` 之后 Agent 最终回 `stopReason: 'cancelled'` 才落 CANCELLED。

## 5. 安全边界

- env 走 allowlist（`cliProcessSupervisor.buildEnvAllowlist`），不透传宿主全量环境；
- 认证只存状态不存凭据；平台从不提取外部 Agent 的登录 token（spec §30–§32）；
- 权限是交集不是并集；只读父 Run 下写类操作（`WRITE_OPERATIONS`）一律 deny；
- 第三方 Agent 的 terminal 请求经 `externalTerminalGate` 二次把关。

## 6. 验证状态（spec §138）

| 对端 | 状态 |
| --- | --- |
| `test/fakes/fakeAcpAgent.js`（严格 wire v1 fixture） | **Verified**：`test/acpClientRuntime.test.js` + `test/acpAgentAdapter.test.js` 全程真进程跑通握手/会话/权限/cancel/崩溃路径 |
| codex-acp / claude-agent-acp（真实 Agent） | 架构兼容（ACP-compatible architecture）；未在本轮 CI 环境真实联调，**不标 Verified** |
