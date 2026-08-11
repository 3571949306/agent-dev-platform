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
| `nativeModelContextResolver.js` | Native Child Model 解析（Gap 1：产出真实 ProviderModelAdapter，优先级 modelOverride→context.model→agent api_connection_id/model→parentModelContext） | §5-17 |
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

Framework Closure Patch（Gap 1）进一步把「Native Child 的 Model 来源」抽成 `nativeModelContextResolver`，明确优先级与「无来源即明确失败（不静默取首个 Connection）」契约；编排委派路径经 `parentModelContext` 注入 Main Agent 当前 model（真实 ProviderModelAdapter，带 decide），顶层 `hub.start('native-main')` 则沿用 truthy model 描述由 `mainAgentRuntime` 内部解析。

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

## 10. 事件总线（§65/§71/§72，供未来 Hook 订阅）

Framework Closure Patch（Gap 4）统一了事件命名空间，**单一标准命名空间 `orchestration.*`**：

```
orchestration.run.started
orchestration.delegation.before / delegation.started / delegation.completed / delegation.failed
orchestration.verification.started / verification.completed
orchestration.run.before_complete / run.completed
```

为兼容旧前端（`delegation.*` 直接订阅），保留 **Legacy alias `agent.delegation.*`**（`agentHubBridge` 同时 emit canonical + legacy，
`orchestrationEvents.test.js` §65/§71 验证两者并存）。后端不再以 `agent.delegation.*` 作为规范名。

本轮不实现 Hook Engine（§73），只确保事件稳定。

## 11. 预留未来接口（§69-71，不实现）

- `AgentDefinition`（Dynamic Agent Framework，v2.9.1）
- `modelRequirements`（Model Router，v2.9.2）
- `skillIds`（Skill Engine，v2.9.3）
- Hook Engine（v2.9.4）/ Workflow Engine（v2.9.5）/ AI Extension Generator（v2.9.6）

## 12. IPC（§58-59）

新增 `orchestrator:cancel/status/result/children/cancelChild`（§56-60，**不新增 `orchestrator:start`**——统一 Parent 入口为 `mainAgent:run`，见 §58）。现有 `mainAgent:*`/`hub:*`/`agent:*` 保留兼容（§59，不删除，内部可转发）。

## 13. Real AI Smoke（§74-99）

`npm run test:real-ai:orchestrator`：真实 DeepSeek Main Agent → delegate → fixture reviewer → Blackboard → Main Agent 修复 → 测试通过。CI 无 credential 时 SKIP（§76），不 FAIL。

## 14. Real Runtime Smoke Closure（v2.9.0 收口，R1-R9）

> 目标：让真实 DeepSeek 驱动真实 Main Agent Runtime，完成一次最小但完整的
> `delegate → reviewer → read → patch → test → complete`，全部走生产组件，禁止任何 fake 旁路。

### 14.1 验证层次（不得互相替代）

| 层次 | 含义 | 本轮状态 |
| --- | --- | --- |
| Provider connectivity verified | API 可达 / key 有效（testConnection / 首次 stream） | ✅ |
| Real Main Agent verified | 真实模型驱动 MainAgentRuntime + AgentLoop + 生产工具完成编码 | ✅（deepseek-chat） |
| Real Orchestrator verified | MODEL_ACTION(delegate) + orchestration.delegation.started 双层证据，Child Result 真实进入下一轮 context | ✅（deepseek-chat） |

### 14.2 生产化改造（相对 Framework Closure Patch 的占位实现）

- **R1 Native ModelAdapter**：`NativeAgentAdapter.startTask` 强校验 `typeof context.model.decide === 'function'`，
  metadata object（{ model, provider, connectionId }）一律拒绝（`NATIVE_MODEL_CONTEXT_UNRESOLVED`）。
  resolver 新增第 4 优先级：**已配置 Native Main Agent**（`store.agents.listNative()` 唯一 `is_main + api_connection_id`）
  → `createProviderModelAdapter()`，覆盖 top-level / AgentHub fallback 场景（无 parentModelContext）；
  0 个或 >1 个候选 → 明确失败，禁止静默选第一个 Connection。`executionContextFactory` 不再用元数据兑底。
- **R2 生产工具**：Smoke 的 `getTool` 复用 `src/tools/registry.js`（Built-in Tools），删除 `getTool: () => null`。
- **R3 PathSecurity**：删除 fake `isWithinAllowed: () => true`，改用生产 `createPathSecurity({cacheRoots})` +
  TEMP fixture 作为 projectRoot；Harness 自动做确定性逃逸断言（`../outside.txt` 等 3 种写法必须全部被拒，
  `successfulOutsideWrites = 0`）。
- **R4 PermissionEngine**：删除 `permissionEngine: null`；生产 PermissionEngine + 仅限 TEMP 项目的权限上下文
  （allow: filesystem.read/write、terminal.read/write、subagent；deny: outside_workspace、dangerous、computer、
  browser、clipboard、network、mcp）。`actionExecutor.runTool` 新增权限闸门：deny → PERMISSION_DENIED；
  ask → requestPermission，无交互通道时 fail-safe 拒绝。
- **R5 模型自发 delegate**：双层证据（`mainAgent:action` type=delegate + `orchestration.delegation.started`
  且 childAgentId = real-ai-fixture-reviewer），Harness 不得代发。
- **R6 Child Result 真实消费**：修复 `agentHubBridge.normalizeResult` 字符串结果丢失、`agentLoop` summary 被
  undefined 覆盖两个 bug；证据取自真实 runtime：delegate 之后某一轮 model context 必须包含 reviewer finding。
  禁止 `blackboardConsumed = delegateObserved` 假证明。
- **R7 独立终验 8 条**：test 文件 SHA256 未变 / package.json 未变 / src/math.js 是唯一 mutation（全目录快照对比）/
  Harness 亲自 `node test/math.test.js` exit=0 / Parent Run completed / delegate observed / result consumed / outside writes=0。
- **R8 Fixture 无条件清理**：`withRealAiFixture(fn)` —— create 与 cleanup 在同一函数 try/finally；
  success / provider throws / model timeout / tool error 四条异常路径单测验证零残留。
- **R9 Budget**：`modelCallAttempts / providerCallsStarted / providerCallsSucceeded / providerCallsFailed` 精确区分；
  **调用前预检** `started >= max → REAL_AI_BUDGET_EXCEEDED`，第 N+1 次请求绝不发出（maxProviderCalls = 6）。

### 14.3 执行入口与 Connection 解析（§5/§6）

- `npm run test:real-ai:orchestrator`：plain node 下自动 re-exec 到 `electron . --real-ai-smoke`（main.js 门控模式）。
  原因：better-sqlite3 为 Electron ABI，且平台 API Key 由 safeStorage（DPAPI + app 身份绑定熵）加密，
  只有真实 App 身份能解密 —— §5 的 Store 优先级才真正生效。
- Connection 优先级：CLI connectionId → REAL_AI_TEST_CONNECTION_ID → settings.realAiTestConnectionId
  → Store 唯一可用 DeepSeek 连接 → env fallback（source=env-fallback，仅兑底，不覆盖平台绑定）。
- Model：REAL_AI_TEST_MODEL override → Connection 默认 → 已配置 Native Main Agent 的 model（Store 为准）→ connection.models[0]；
  不硬编码型号。
- **Deterministic Integration 前置门**（`npm run test:deterministic-orchestrator`）：FakeCodingModel
  （delegate → read → patch → run_tests → complete）+ 除 LLM 外全生产链路，不 PASS 则禁止烧真实 API。

### 14.4 P1 Run State Consistency

修复 `preparing → executing_tool` 非法迁移警告：**修映射链不放宽 RunManager** ——
`mapToRunManagerState` 把 READING_CONTEXT 映为 `requesting_model`、TESTING 映为 `executing_tool`，
全部 updateRun 落在合法迁移表内（preparing → requesting_model → executing_tool）。
