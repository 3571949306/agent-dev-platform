# ACP Runtime Decision（v2.8.0 spec §19 / §136）

> 状态：已定稿并实现。决策对应代码：`src/agents/protocols/acp/*` + `src/agents/adapters/acpAgentAdapter.js`。
> 上游取证钉版见 `docs/UPSTREAM_REFERENCE_MATRIX.md`。本文不允许出现任何未经上游验证的 API/flag。

## 1. 决策结论

```text
以 ACP v1（wire protocolVersion = 1）作为通用外部 Agent 结构化协议基线，
自研 AcpClientRuntime（JSON-RPC 2.0 over stdio），不引入官方 TS SDK 作为运行时依赖；
非 ACP Agent 走各自官方结构化通道（Codex App Server / Claude Agent SDK），
CLI 文本通道只允许作为显式降级，禁止作为 production primary path。
```

## 2. 为什么选 ACP 作为"通用通信层"

1. **单一协议覆盖多 Agent**。Codex（codex-acp@1.1.14）与 Claude（claude-agent-acp@0.66.0）都有官方维护的 ACP 适配层，且二者都依赖同一个 `@agentclientprotocol/sdk@1.3.0`。实现一次 Client 即可对接一整类 Agent。
2. **wire 协议已稳定且可取证**。ACP v1 是 JSON-RPC 2.0 上的整数协议版本（`PROTOCOL_VERSION = 1`），method 清单、SessionUpdate 11 变体、StopReason 5 值、PermissionOptionKind 全部在 `agent-client-protocol/schema/v1/*.json` 中逐字可查，不存在"猜 flag"空间。
3. **生命周期语义完整**：`initialize` 握手 + capability negotiation、`authenticate`、`session/new|prompt|cancel|load|resume|close`、`session/request_permission`、`session/update` 流式事件、`fs/*`、`terminal/*` 反向请求——正好覆盖本平台的 Run 生命周期 / 权限桥 / 事件总线需求。
4. **License 干净**：agent-client-protocol、typescript-sdk、registry、codex-acp、claude-agent-acp 全部 Apache-2.0。

## 3. 替代方案与比较结果

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 直接引入 `@agentclientprotocol/sdk` 作为运行时依赖 | **否决**（仅作取证参照） | SDK 面向 Node ≥ 特定版本且随 v2 演进引入 `/v2` 子路径双轨；我们的宿主是 Electron 主进程，已有 CLI 监督器 / env allowlist / 权限 Broker 等自有基础设施，直接包 SDK 会让这些能力变成第二套实现。SDK 的 schema 已转写为 `constants.js`（逐字对齐 `schema/v1`），等价能力自持。 |
| B. 为每个 Agent 写专属协议适配（现状延续） | **否决作为唯一路径** | Codex App Server / Claude SDK 仍然是各自 Agent 的**最优**深度通道（见两篇 RUNTIME_DECISION），但无法泛化到"任意第三方 ACP Agent"。保留为专属路径，ACP 作为通用路径并存。 |
| C. CLI 文本抓取 | **否决（primary）** | spec §44 硬约束。正则分析自然语言输出不可判终态、不可取权限事件。仅保留 `codex exec --json` / `claude -p --output-format stream-json` 这类**官方结构化 JSON** 模式作为 fallback，纯 ANSI 文本抓取全面禁止。 |
| D. 等 ACP v2 稳定后再做 | **否决** | v2 当前仍为 `2.0.0-alpha`，真实 Agent（codex-acp / claude-agent-acp）均跑 v1。v2 常量已记录在 `V2_RECORD`，稳定后可接线，不阻塞本轮。 |

## 4. wire 版本取证（禁止再凭猜测改动）

- codex-acp@1.1.14 与 claude-agent-acp@0.66.0 的依赖均为 `@agentclientprotocol/sdk: 1.3.0`；
- SDK `src/schema/index.ts` 导出 `PROTOCOL_VERSION = 1`（根命名空间 = v1）；`src/v2/schema/index.ts` 为 `2`，但包版本仍是 2.0.0-alpha；
- 因此 `SUPPORTED_PROTOCOL_VERSION = 1`，且 `MAX_SUPPORTED_PROTOCOL_VERSION = 1`：Agent 若回 `protocolVersion = 2`，我们无法正确编解码 v2 消息形状，必须 **fail-closed** 断开（`ACP_PROTOCOL_UNSUPPORTED`），不得继续用 v1 形状发 v2。上游 InitializeResponse 文档原话："The client should disconnect, if it doesn't support this version."

关键形状取证（全部逐字来自 `schema/v1`）：

- `session/cancel` 是 **notification** 不是 request——误当 request 会永久挂起（Agent 不回响应）；
- `sessionId` 由 **Agent** 在 `session/new` 响应里生成，client 不得自造；
- `session/resume` 需要 `sessionCapabilities.resume`，缺失即 `RESUME_UNSUPPORTED`，禁止重放历史消息冒充 resume；
- StopReason = `end_turn | max_tokens | max_turn_requests | refusal | cancelled`；
- v1 的 auth 是 `authenticate` / `logout`（v2 才改名为 `auth/login` / `auth/logout`）。

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Agent 回 v2 | fail-closed：`ACP_PROTOCOL_UNSUPPORTED`，Run 记 FAILED 并回退路由，绝不降级乱发 |
| Agent 不响应 `initialize` | 握手超时（fail-closed），healthCheck 记 UNAVAILABLE，Router 扣分 |
| `session/cancel` 后 Agent 继续产出 | cancel 后 flush 所有 pending permission 为 `cancelled`，late event 按终态语义忽略（terminalCount == 1） |
| Agent 进程崩溃 | unexpected exit = FAILED（spec §65），禁止判 COMPLETED |
| 第三方 Agent 的 `fs/*` / `terminal/*` 反向请求 | 全部进 permissionBroker 交集裁决 + externalTerminalGate；只读父 Run 下写类操作一律 deny |
| SDK/v2 演进 | `V2_RECORD` 冻结记录差异（`auth/login`、`plan_update`、`state_update` 等新变体），升级时只改常量层与协商层 |

## 6. Fallback 链

```text
ACP Agent 配置 → initialize 握手成功？
  ├─ 是 → session/new → session/prompt（结构化全程）
  └─ 否 → 记录失败原因（超时 / 协议版本 / spawn 失败）
          → AgentHub 路由下一个候选（Router 认证/健康评分）
          → 全链失败 = Run FAILED（不静默吞掉）
```

ACP Runtime 自身**不**负责降级到 CLI——降级决策属于各 Agent 的 Adapter（Codex: app-server → exec → legacy；Claude: sdk → cli）。通用 `AcpAgentAdapter` 是"该 Agent 只会说 ACP"的场景，失败即 FAILED + 留痕。

## 7. 不做什么（边界）

- 不提取 / 不读取任何外部 Agent 的登录 token（spec §30–§32）；`authBroker` 只存状态机（UNKNOWN / AUTH_REQUIRED / AUTHENTICATED / API_KEY / EXTERNAL_LOGIN / FAILED），不存凭据；
- 不实现 v2 消息形状；
- 不声称"所有 ACP Agent 都支持"（spec §138）——当前只有 fake-acp-agent（测试用）为 Verified；
- 权限不并集：Parent Run Permission ∩ Platform Policy ∩ External Agent Policy。
