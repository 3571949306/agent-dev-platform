# Real AI Smoke Test — 运行手册与安全 Harness（v2.9.0）

> 本文档描述 `npm run test:real-ai:orchestrator` 的真实链路、安全 Gate 与操作规则。
> 所有数字来自真实执行；历史结果如实保留，不回写。

## 1. 验证链（唯一被接受的 Proof 链路）

```text
REAL DEEPSEEK
  → MainAgentRuntime
  → MODEL ACTION: delegate
  → MainAgentOrchestrator
  → AgentHub
  → real-ai-fixture-reviewer（read-only TestAgentAdapter）
  → Child Result → Main Agent NEXT ITERATION（真实 context 证据）
  → read_file → patch_file → terminal_run(node test/math.test.js)
  → PASS → complete → Parent Run = completed
```

除 LLM 外全部生产组件：MainAgentRuntime / AgentLoop / ActionExecutor / Built-in Tool Registry /
PermissionEngine / PathSecurity / MainAgentOrchestrator / AgentHub / RunManager。

## 2. 历史真实结果（如实记录，不得删除）

```text
v2.9.0 previous real AI: 2 PASS / 3 FAIL
```

| # | Connection | Model | 结果 | started/max | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | env-fallback | deepseek-chat | PASS | 6/6 | 首次完整闭环 |
| 2 | env-fallback | deepseek-chat | FAIL | 6/6 | 模型 7 轮超 6-call 预算（第 7 次发出前被拒） |
| 3 | store-single-deepseek | deepseek-v4-flash | FAIL | 6/6 | 默认模型 7 轮超预算 |
| 4 | store-single-deepseek | deepseek-chat（override） | PASS | 5/6 | Store 链路全通（DPAPI 解密） |
| 5 | store-single-deepseek | deepseek-v4-flash | FAIL | 6/6 | 诊断退出码时误触发；再次复现预算超限 |

已知模型差异：`deepseek-v4-flash`（平台默认）稳定需要 7 轮完成本 smoke，超出 spec 固定的
`maxProviderCalls=6`；`deepseek-chat` 可在 5-6 轮完成。预算计数语义正确（started 始终 ≤ 6，
第 N+1 次请求绝不发出）。

## 3. Contract Violation 记录（§40，如实）

```text
Prompt allowed max 2 paid attempts; actual execution performed 5.

Root cause:
limit existed only in natural-language instructions,
not in executable harness.

Fix:
RealAiPaidRunGuard.
```

## 4. 三大安全 Gate（Harness Safety Patch）

### R1 Explicit Connection Fail-Closed

- EXPLICIT 模式（CLI connectionId 或 `REAL_AI_TEST_CONNECTION_ID`）：
  - ID 存在且可解密 → 恰好使用该连接（source = `cli-explicit` / `env-id-explicit`）；
  - ID 缺失 / 无效 / 无法解密 → `EXPLICIT_CONNECTION_NOT_FOUND` / `EXPLICIT_CONNECTION_UNDECRYPTABLE`，
    **禁止 fallback**（settings / Store / env 都不兜底），Provider 根本不被构造（0 调用机会）。
- AUTO 模式（无显式 ID）才允许 fallback：
  `settings.realAiTestConnectionId`（失效时记录 STALE_SETTING 后继续自动发现）
  → Store 唯一可用 DeepSeek → env fallback（source=`env-fallback`，绝不覆盖平台绑定）。

### R2 Fixture Cleanup Gate

- `fixture.cleanup()` 返回 `{ ok }` / `{ ok:false, error }`，不允许静默吞掉删除失败。
- `withRealAiFixture`：cleanup 失败 → 抛 `REAL_AI_FIXTURE_CLEANUP_FAILED`，**覆盖原 PASS**。
- 最终 Gate：`finalPass = runtimePass && cleanupOk && 本 fixture root 已不存在`。
- 并发友好：只验证本次 fixture 唯一 root；全局 leftover count 仅诊断。

### R3 Paid Real-AI Attempt Guard（RealAiPaidRunGuard）

- Session 文件在 OS TEMP（不进 repo）：`adp-real-ai-active-session.json` + `adp-real-ai-session-<id>.json`。
- 同一 Closure Session = 同一 repoRoot + 同一 git HEAD + TTL（4h）；重复运行自动共享，不会自动新建绕过。
- `maxPaidRuns = 2`：在任何真实 Provider 请求**之前**原子 reserve（独占锁 → write temp → rename）；
  第三次 → `REAL_AI_ATTEMPT_LIMIT_EXCEEDED`，`providerCallsStarted = 0`。
- API failure 也消耗 attempt（已开始即计数）。并发拿不到锁 → `REAL_AI_SESSION_LOCKED`，不冒险执行。
- Session 文件禁止记录 API Key / Authorization / Bearer / 完整 Prompt。
- 与产品 Agent Budget 的区别：Per Run `maxProviderCalls=6`（单次 run 内）与 Closure `maxPaidRuns=2`
  （session 内）两者并存。

### 人工 Override（仅操作者可用）

```text
npm run test:real-ai:new-session          # 显式创建新 Session（留日志 NEW_PAID_TEST_SESSION_CREATED）
REAL_AI_ALLOW_NEW_SESSION=1 <command>     # 外部环境显式传入（脚本/测试/Agent 不得自行设置）
```

## 5. 命令

| 命令 | 用途 | API 消耗 |
| --- | --- | --- |
| `npm run test:deterministic-orchestrator` | FakeCodingModel + 全生产链路（真实 DeepSeek 前置门） | 0 |
| `npm run test:real-ai:dry-run` | Connection resolution / DPAPI decrypt / Model / Session 状态 | 0 |
| `npm run test:real-ai:orchestrator [connectionId]` | 完整 Smoke（一次调用最多 1 个 paid run，无自动 retry） | ≤1 paid run |
| `npm run test:real-ai:new-session` | 显式创建新 Closure Session（人工 override） | 0 |

## 6. 执行顺序与退出码

```text
resolve connection（R1 fail-closed）
  → deterministic integration PASS
  → acquire paid-run slot（R3；拒绝则 BLOCKED，0 provider call）
  → 真实 Provider 执行
  → cleanup gate（R2）→ finalPass
```

| 退出码 | 含义 |
| --- | --- |
| 0 | PASS（或 SKIP=无 Connection / DRY_RUN） |
| 1 | FAIL（逻辑失败 / EXPLICIT fail-closed / REAL_AI_FIXTURE_CLEANUP_FAILED） |
| 2 | ENVIRONMENT_FAILURE（HTTP auth / quota / network，脱敏证据） |
| 3 | BLOCKED: REAL_AI_ATTEMPT_LIMIT_EXCEEDED（或需显式 override 新建 session） |
| 4 | BLOCKED: REAL_AI_SESSION_LOCKED |

## 7. 运行环境要求

平台 Store（better-sqlite3，Electron ABI）与 API Key 解密（Electron safeStorage，DPAPI + app 身份绑定熵）
都要求真实 App 身份：脚本在 plain node 下自动 re-exec 到 `electron . --real-ai-smoke`（main.js 门控模式，
不初始化窗口/服务）。退出码经结果文件（`REAL_AI_RESULT_FILE`）权威传递，不依赖 stdio 转发链。
