# Codex Deep Integration（v2.8.0 spec §42–§48 / §136）

对既有 `CodexAgentAdapter` 的原地升级（spec §42：不删除，只升级）。运行时
选型依据见 `docs/CODEX_RUNTIME_DECISION.md`。

## 1. 升级后的形态

```text
CodexAgentAdapter（类名 / 构造签名 / parseCodexResult 导出保持向后兼容）
  └─ runtimeMode = auto
       1) app-server —— codex app-server（JSON-RPC 2.0，逐行 JSONL over stdio）
       2) exec       —— codex exec --json（官方结构化事件流）
       3) legacy     —— v2.6.0 runCodex（最后兜底，发 FALLBACK 事件留痕）
```

spec §44 硬约束落地：production primary path 全程结构化 JSON；任何"正则分析
自然语言终端文本"的路径都不允许成为 primary。legacy 启用时 GUI 可见降级事件。

## 2. 模块清单（`src/agents/protocols/codex/`）

| 模块 | 职责 |
| --- | --- |
| `appServerConstants.js` | App Server 协议常量：`thread/start|resume|list|read`、`turn/start|interrupt|steer`、`review/start`、`getAuthStatus`、turn 通知（`turn/started|completed|diff/updated|plan/updated` ...）、审批 decision 枚举。逐字取证自 `codex-rs/app-server-protocol/src/protocol/v2/*.rs` |
| `codexAppServerClient.js` | `createCodexAppServerClient`：spawn + 握手 + request/notify + server→client 审批请求分发；`REQUIRED_METHODS` 握手探测 |
| `codexExecRunner.js` | `createCodexExecRunner`、`buildExecArgs`、`SANDBOX_MODES`：`codex exec --json` 单轮结构化运行 |
| `codexEventMapper.js` | `createCodexAppServerEventMapper` / `createCodexExecEventMapper` / `createAccumulator`：App Server / exec 事件 → 平台 `AGENT_EVENT` |

## 3. 事件映射（spec §46 / §47）

| Codex 官方事件 | 平台标准事件 / 结果 |
| --- | --- |
| turn plan 更新 | `agent.plan.updated` |
| turn reasoning 项 | `agent.reasoning`（**只透传官方提供的 summary/event**；上游不给完整内部思维就不提取，spec §46） |
| `turn/diff/updated` / file change item | `agent.file.changed` + `AgentResult.changedFiles` + `AgentResult.diff`（spec §47） |
| 命令 / 文件改动审批请求 | permissionBroker 交集裁决 → GUI 逐次审批（app-server 独有） |
| item 文本输出 | `agent.message` 流式增量 |

## 4. Review（spec §48）

- app-server 提供 `review/start`，因此 app-server 运行时声明 `review: true`，Main Agent 可将 Review 类任务 delegate 给 Codex 而不要求其改代码；
- exec 模式的 review 需另起 `codex exec review` 子命令，本轮未接线 → 如实声明 `review: false`（spec §45：实际支持什么填什么）；
- legacy 无 review。

## 5. 能力矩阵（spec §45，按运行时动态给）

见 `codexAgentAdapter.js` 的 `RUNTIME_CAPABILITIES`：app-server 最全（含
approval / interrupt / review / session / resume）；exec 砍掉交互式审批与
interrupt；legacy 只剩基础 coding 能力。Router 按 Adapter 当前声明的能力计分。

## 6. Session 与认证

- **Session ≠ Run**（spec §109）：Codex threadId 经 `externalAgentSessionManager`
  管理，支持"新会话 / 继续上次 Agent 会话"（GUI 显示 `Codex Thread ...`，不暴露全量 UUID）；
- **认证只读状态**：app-server 连接后只调 `getAuthStatus` 缓存
  authenticated/required 两态，供 Router 评分与 GUI 展示；从不读取 / 提取
  token 本体（spec §30/§79）。API Key 场景读 `OPENAI_API_KEY` 是否存在（不读值）。

## 7. 终态与降级语义

- 进程 unexpected exit = FAILED（spec §65）；timeout ≠ cancelled（spec §67）；
- app-server 方法 `-32601 method not found`（旧版 codex）→ 自动降级 exec；
- exec 不可用 → legacy + FALLBACK 事件；全链失败 = Run FAILED，不静默。

## 8. 测试

- 单测：`test/codexAppServerClient.test.js`、`test/codexExecRunner.test.js`、
  `test/codexEventMapper.test.js`（握手 / method-not-found 降级 / 事件映射 /
  审批 decision）+ `test/agentRouter.test.js` 认证状态评分；
- E2E：既有 Test 33（Codex 启动失败 → 回退 Native）保持通过，且新增认证评分
  防止未登录外部 Agent 截胡 fallback 链。
