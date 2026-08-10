# Unified Main Agent Orchestrator

> Agent Dev Platform v2.9.0 — Unified Main Agent Orchestrator
>
> 在现有三套 Runtime（General Chat / Main Coding / AgentHub）之上建立统一编排层，
> 实现 Main Agent → delegate → AgentHub → Child Run → Blackboard → Main Agent 真正闭环。

## 1. 架构定位

v2.8.2 及以前存在三套独立 Runtime，未形成统一 Main Agent：

```
General Chat Runtime      Main Coding Runtime       AgentHub
(Tool Calling/Subagent)   (Planning/Coding/Test)    (Codex/Claude/Cline/...)
```

v2.9.0 建立 **MainAgentOrchestrator** 统一编排层（§9），不合并底层实现（§56）：

```
                         User
                          │
                 Unified Main Agent
                          │
                    Main Coding Runtime (agentLoop)
                          │
                    delegate action
                          │
                 MainAgentOrchestrator
                          │
                    AgentHubBridge
                          │
                      AgentHub.route → start
                          │
                      Child Run
                          │
                    Child Result
                          │
                 OrchestrationBlackboard
                          │
                    Main Agent (下一轮)
                          │
                    Verify / Repair → Complete
```

## 2. 核心模块（src/agent/orchestrator/）

| 模块 | 职责 | spec |
|------|------|------|
| `agentTaskContract.js` | AgentTask 契约 + delegationPath/depth + 防自委派 | §11/§42-44 |
| `orchestrationBlackboard.js` | Root Run 共享工作状态 + secret sanitize + context budget | §34-38/§115 |
| `childRunTracker.js` | Parent/Child Run 树 + 取消级联 + event-driven wait | §23-29 |
| `executionContextFactory.js` | 统一 Adapter context（修复 Native Hub Context 缺口） | §39-40 |
| `delegationController.js` | fallback policy + no-bypass | §30-33 |
| `agentHubBridge.js` | AgentTask → AgentHub.route/start → wait → AgentResult | §18 |
| `mainAgentOrchestrator.js` | 统一编排入口 + 事件总线 | §9/§72 |

## 3. 两个关键结构缺口（已修复）

### 缺口 A：delegate 是 placeholder（§7A）

**v2.8.2**：`agentLoop.js:196-202` 在 delegate action 时直接 `continue`（"无可用子智能体，自行继续"），`actionExecutor.executeDelegate`（完整实现）是不可达死代码。

**v2.9.0 修复**：删除 placeholder，delegate 走 `executeAction → executeDelegate`。executeDelegate 优先用 `ctx.orchestrator.delegate`（如注入）走完整编排链，否则回退现有 hub 逻辑（向后兼容）。

### 缺口 B：NativeAgentAdapter context 缺失（§7B）

**v2.8.2**：`agentHub.start` 只传 8 字段（runId/projectRoot/emit/finishRun/...），缺 `runManager`/`model`/`getTool`。NativeAgentAdapter.startTask 第 97-98 行因 `runManager`/`model` 必填而 throw。

**v2.9.0 修复**：`ExecutionContextFactory` 统一构建 context（§39-40）。`handlers.js` 创建 AgentHub 时注入 `contextFactory`（含 runManager/getTool/store/buildProvider/resolveModel/pathSecurity/projectMutationLock）。`hub.start` 用 `contextFactory.create(adapter, task, run, hubCtx)` 补全 Native 必填字段。

## 4. AgentTask Contract（§11）

```js
{
  id, goal, taskType, projectId, projectRoot,
  requiredCapabilities: [], preferredCapabilities: [],
  preferredAgentId: null,
  readOnly: false,
  permissions: {}, expectedOutput: null,
  verificationRequirements: [],
  context: {},
  parentRunId, parentAgentId,
  delegationPath: [],          // §43 追踪 agentId#runId 链
  budget: { maxRuntimeMs, maxIterations, maxToolCalls },
  // 预留未来接口（§69-71，不实现）
  modelRequirements: null, skillIds: []
}
```

## 5. Child Result Contract（§12）

统一 AgentResult，禁止 Main Agent 按 Provider 单独解析：
```js
{ ok, agentId, runId, sessionId, status, summary, findings,
  changedFiles, diff, tests, artifacts, usage, errors, durationMs, provenance }
```

## 6. Parent/Child Run Tree（§21-29）

- **持久化**：runs 表新增 `root_run_id`/`depth` 列（§116 migration，`parent_run_id` 已有列但 v2.7 未写入，v2.9.0 补 store.upsert SQL + RunManager.createRun 参数）。
- **内存**：`ChildRunTracker` 维护 parentOf/childrenOf/runs Map。
- **取消级联**（§24）：Parent CANCEL → 递归 cancel 所有 owned children → external abort → Parent CANCELLED。
- **Child terminal 不终结 Parent**（§27-28）：Child TIMEOUT/FAILED 反馈 Main Agent 决定下一步。
- **防自委派**（§42）/ **maxDepth=3**（§44）。
- **event-driven wait**（§19）：平台 Runtime `await childRunTracker.wait(runId)`，不轮询 DB。

## 7. Fallback Policy（§30-33）

| 失败类型 | 自动 fallback |
|---------|:---:|
| RUNTIME_UNAVAILABLE | ✅ |
| PROTOCOL_ERROR | ✅ |
| CRASH | ✅ |
| TIMEOUT | ❌（保守，第一版不自动） |
| PERMISSION_DENIED | ❌（No-Bypass §29） |
| USER_CANCELLED | ❌ |
| POLICY_DENIED | ❌ |

`maxDelegationAttempts = 2`（§33），避免 Codex→Claude→Cline→... 无限烧资源。

## 8. Blackboard（§34-38）

只属于当前 Root Run（§35，≠ 跨 Run Memory）。Child Result 写 Blackboard（§36），Main Agent 下一轮从 Blackboard 取 observation（不重新搜索聊天记录）。

- **Context Budget**（§37）：summary/findings/diff/artifacts 分层，大输出存 artifact。
- **Reasoning Privacy**（§38）：只保存 reasoning summary，不提取隐藏 CoT。
- **Secret Sanitization**（§115）：sk-/Bearer/AKIA/Cookie 等模式 `[REDACTED]`。

## 9. Security 保留（§46-53）

- **PathSecurity**（v2.8.2）：进入 AgentExecutionContext（§50），新 Orchestrator 不绕过。
- **ProjectMutationLock**（§46）：同一 projectRoot 只有一个 writer。
- **Permission 继承**（§49）：Child effective = Parent Auth ∩ Platform Policy ∩ Agent Policy。
- **Main Final Verification**（§51）：External Agent 的"完成"只是 Claim，Main Agent 仍需本地 `git diff`/`test`/`CompletionPolicy` 复核。
- **externalClaim ≠ localVerification**（§53）：Child 报 tests passed 标记 externalClaim，不自动当本地验证。

## 10. 事件总线（§72，供未来 Hook 订阅）

```
run.started
delegation.before / delegation.started / delegation.completed / delegation.failed
verification.started / verification.completed
run.before_complete / run.completed
```

本轮不实现 Hook Engine（§73），只确保事件稳定。

## 11. 预留未来接口（§69-71，不实现）

- `AgentDefinition`（Dynamic Agent Framework，v2.9.1）
- `modelRequirements`（Model Router，v2.9.2）
- `skillIds`（Skill Engine，v2.9.3）
- Hook Engine（v2.9.4）/ Workflow Engine（v2.9.5）/ AI Extension Generator（v2.9.6）

## 12. IPC（§58-59）

新增 `orchestrator:start/cancel/status/result/children`。现有 `mainAgent:*`/`hub:*`/`agent:*` 保留兼容（§59，不删除，内部可转发）。

## 13. Real AI Smoke（§74-99）

`npm run test:real-ai:orchestrator`：真实 DeepSeek Main Agent → delegate → fixture reviewer → Blackboard → Main Agent 修复 → 测试通过。CI 无 credential 时 SKIP（§76），不 FAIL。
