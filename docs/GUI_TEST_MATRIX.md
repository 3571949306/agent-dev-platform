# GUI Test Matrix（v2.9.9 Phase B Final）

> 原则：IMPLEMENTED ≠ VERIFIED。没有机器 Proof 就不算 VERIFIED。
> 所有 E2E 全程离线（本地 Fake API + 临时 userData），0 付费调用，0 网络依赖。

## 单元测试层（node:test，Electron ABI）

| 套件 | 命令 | 覆盖 |
|---|---|---|
| 全量单测 | `npm test` | 全部 `test/*.test.js`（~1700 断言级用例，串行防资源抖动） |
| PART A 核心闭环 | coreClosure / guiWorkbench / mainCanonicalEntry | A1 Verification Truth / A2 Child Project Identity / A3 Event Dedupe / A4 Git Rename / A8 Inline Child Library |
| Workflow | workflow.test / workflowProduction | 含 A6 Cancel Race 确定性回归（CANCELLED only） |
| Generator | generator.test / generatorProduction | A7 READY ≠ SAVED ≠ EXECUTED |
| Connections | connectionManager.test | B15 全部 Proof（含 SECRET_MASK / FALLBACK_SOURCE_TRUTH） |
| Model Routing | modelRoutingInspector / modelRouter / modelRouterProduction | B16 Wire Truth / EXPLICIT_NO_FALLBACK / Capability Evidence |
| Health & Problems | healthCenter.test | B20 Sections / 0 fake READY / Self-Test 0 paid / B21 去重与 dismiss≠resolved |
| Terminal | terminalWorkspace.test | B19 Active/History/Owner/Cancel Tree/Timeout≠Cancelled |
| Computer | computerWorkspace.test | B18 Availability 词汇 / Stop 真实终止 / 有界历史 |
| GUI 静态边界 | guiContract.test | B38 Renderer 无 node/DB/第二权威/eval/localStorage；孤儿通道=0；SKILL_GRANT_UI=0；HOOK_RAW_SCRIPT_UI=0 |
| 架构门禁 | `npm run test:architecture` / `test:architecture-policy` | DEFAULT_DENY；unsafe duplicate execution paths = 0 |

## E2E 层（Playwright + 真实 Electron + IPC + Runtime）

| Spec | 覆盖 |
|---|---|
| workbench.spec.js（43） | Core Run Workbench / Permission Queue / Workflow UX / Generator UX / Event Soak 2200 |
| operations.spec.js（21） | B15 Wizard+Secret Mask / B17 Skills+Hooks / B18 Availability / B19 Terminal / B20 Health / B21 Problems / B23 Page States / B30 Boot / B42 Confirm / B47 Badges / B66 Security / B67 XSS / B68 Secret Leak |
| product-scenarios.spec.js（11） | B54 场景 A 编码闭环 / B55 权限拒绝 0 变更 / B56 Cancel≠Timeout / B57 Workflow / B58 Generator 边界 / B59 外部状态 / B60 Recovery 0 replay / B52 Soak 100 / B27 Draft / B44 全局状态 |
| perf.spec.js（6） | B35 Boot/切页/2000行文件/1000事件/500终端更新基线 + B34 四分辨率矩阵 |
| gui-main-path.spec.js（13） | Main GUI 入口主路径 |
| main-agent.spec.js（4） | Main Agent Runtime |
| agent-hub.spec.js（5） | AgentHub |
| external-agent-pack.spec.js（18） | 外部智能体 Pack |
| external-import.spec.js（9） | 外部配置导入 |
| smart-onboarding.spec.js（8） | Smart API Onboarding |
| acp-runtime.spec.js（12） | ACP Runtime |

E2E 总量 ≥ 150（B49 目标）。

## 关键机器证明索引

```
PART A:  RUN_STATUS_NOT_USED_AS_VERIFICATION / PROJECT_A_CHILD_FILTER / EVENT_DEDUPE_BOUNDED
         / GIT_RENAME_R / EXPIRED_PERMISSION_CANNOT_APPROVE / WORKFLOW_CANCEL_RACE=CANCELLED_ONLY
         / INLINE_CHILD_LIBRARY_UNCHANGED
B15:     CONNECTION_SECRET_LEAK=0 / CUSTOM_HEADER_SECRET_LEAK=0 / FALLBACK_MODEL_SOURCE_TRUTH
B16:     MODEL_ROUTE_VISIBLE / SELECTED_WIRE_EQUAL=YES / EXPLICIT_MISSING_NO_FALLBACK
         / CAPABILITY_EVIDENCE_TRUTH / MODEL_MISMATCH → Problem
B17:     SKILL_PERMISSION_GRANT_UI=0 / HOOK_RAW_SCRIPT_UI=0 / HOOK_TRUSTED_HANDLER_ONLY
B18:     COMPUTER_AVAILABILITY_TRUTH / COMPUTER_STOP_RESIDUE=0 / NORMAL_CODING_COMPUTER_EXEC=0
B19:     TERMINAL_CANCEL_RESIDUE=0 / TERMINAL_OWNER_TRUTH / TERMINAL_OUTPUT_BOUNDED
B20/21:  DIAGNOSTICS_FALSE_READY=0 / SELF_TEST_ZERO_PAID_CALLS / DISMISS_NOT_RESOLVED
B22/60:  RECOVERY_PROVIDER_REPLAY=0 / RECOVERY_TOOL_REPLAY=0 / RECOVERY_MUTATION_REPLAY=0
B38/66:  GUI_BOUNDARY_* / ELECTRON_SECURITY / GUI_ORPHAN_CHANNELS=0
B67/68:  GUI_XSS_EXECUTIONS=0 / GUI_SECRET_LEAKS=0
Soak:    NAVIGATION_SOAK_100 / UI_EVENT_SOAK_DUPLICATES=0
```

## 运行

```powershell
npm test                 # 全量单测（Electron Node ABI）
npm run e2e              # 全部 E2E（Playwright + Electron）
npm run test:gui:production
node scripts/release-gates-v299.js   # 22+ 门禁严格串行
```
