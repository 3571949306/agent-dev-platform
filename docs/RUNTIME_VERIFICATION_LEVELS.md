# Runtime Verification Levels（spec §39-§45/§82）

**单一真相源：** `src/agents/verification/verificationLevel.js`（等级定义与声明约束）、
`src/agents/verification/verificationRegistry.js`（证据登记与等级判定）、
`src/agents/verification/agentVerification.js`（Agent 画像计算）。

**规则（spec §40）：** 任何 Adapter / GUI / 报告都不得再自行书写
`verified` / `working` / `real` 之类的自由文案；验证结论只能来自上述单一真相源。

---

## 1. 等级偏序（从低到高）

| 等级 | GUI 标签 | 含义 |
| --- | --- | --- |
| `not_verified` | 未验证 | 没有任何实现级证据 |
| `implementation_verified` | 实现级验证 | 仓库中存在真实实现（`src/agents/adapters/*`） |
| `fixture_verified` | Fixture 验证 | 存在真实 fixture 测试并可通过（`test/*`） |
| `packaged_verified` | 打包级验证 | 在打包产物中验证过（如 sidecar 随包启动） |
| `local_detection_verified` | 本地检测验证 | 运行时满足其 transport profile 的真实本机/端点前置条件 |
| `real_protocol_verified` | 真实协议验证 | 真实 initialize / session / prompt 握手发生过 |
| `real_agent_task_verified` | 真实任务验证 | 真实端到端 Agent 任务完成且独立项目 effect 已观察 |

等级判定是偏序：任何证据只允许声明"不超过其证明强度"的等级，绝不越级。

---

## 2. 声明约束（`isClaimAllowed`，spec §41-§43）

| 场景 | 允许的最高等级 |
| --- | --- |
| CLI/process 未找到可执行文件（如本机未安装 codex CLI） | `packaged_verified`（最高） |
| CLI 仅 `--version` 成功，无协议交互 | `local_detection_verified`（最高） |
| HTTP endpoint 已配置/探测；SDK API surface 存在；Desktop 唯一 HWND+PID | `local_detection_verified`（最高） |
| 无真实 initialize / session / prompt | 不得声明 `real_protocol_verified` |
| 仅真实响应、未观察到项目 mutation | 不得声明 `real_agent_task_verified` |
| 付费/subscription transport | 自动验证 0 task；立即显式同意的真实证据可按实际强度升级 |

**判例（spec §101）：**
- Codex 未安装却标 `real_protocol_verified` → Release Blocker。
- Claude 只 `--version` 却标 `real_agent_task_verified` → Release Blocker。

---

## 3. 维度（GUI Agent Center 展示）

| key | 标签 | 取值（固定枚举） |
| --- | --- | --- |
| `installed` | 安装 | 是 / 未检测到 |
| `auth` | 认证 | 认证状态或 未知 |
| `localDetection` | 本机探测 | 已验证 / 未验证 |
| `protocolImpl` | 协议实现 | Fixture 已验证 / 仅实现级 / 未验证 |
| `realProtocol` | 真实本机协议 | 已验证 / 未验证 |
| `agentResponse` | 真实新响应 | 已验证 / 未验证 |
| `realAgentTask` | 真实模型任务 | 已验证 / 未验证 |

维度取值只来自 `agentVerification.js` 的 `DIM` 常量。CLI 的本机探测需要 executable + version；SDK/ACP/HTTP/server/desktop 使用各自 transport profile。Desktop 仅窗口存在仍不是协议证据；响应证据仍不是项目 mutation 证据。

---

## 4. 证据记录（spec §65/§66）

每条证据含：

```text
type       — implementation | fixture | packaged | local_detection | protocol | agent_response | agent_task
status     — pass | fail | skipped
timestamp  — ISO 8601
version    — 探测到的版本（可能为空）
source     — 真实来源（源码路径 / 测试文件 / runtime detect() / 握手事件）
details    — 补充说明
callCountEvidence — EXACT | UNOBSERVABLE_EXTERNAL_RUNTIME
```

**不含任何 credentials**（spec §78）。证据不是永久假设：用户升级 Claude CLI 后旧的
`local_detection` 证据应重新 probe，等级会随新证据重算（spec §66）。

---

## 5. Health ≠ Verification（spec §45）

| 概念 | 回答的问题 | 来源 |
| --- | --- | --- |
| Health | 现在能不能跑（sidecar ready / API configured / workspace ready） | `healthCheck()` |
| Verification | 我们实际验证到了哪一步（安装 / 协议 / 任务） | 本模块 |

**Health 绿不抬升验证等级。** 一台装好、配好、探测通过的机器，如果从未做过真实协议
握手，其等级仍停留在 `local_detection_verified`，不得因 health=healthy 升级。

---

## 6. 各 Agent 的权限中介能力现状（spec §35-§38）

| Agent | 权限中介 | 说明 |
| --- | --- | --- |
| Codex | 统一 Permission Broker + Risk Classifier + GUI | app-server review 走同一套分类器（§35） |
| Claude Code | 统一 Permission Broker + Risk Classifier + GUI | `canUseTool` → Broker → Classifier → GUI/Policy（§36） |
| Cline | 统一 Permission Broker（scope-level） | `requestToolApproval` 无同步回问通道；宿主在 scope 下发前做交集评估（§37）。命令级风险分级不可用，如实记录 |
| OpenCode | **permission mediation capability unavailable** | 无可用权限回调可映射（§38），保持现状，不伪造 |
| OpenHands | **permission mediation capability unavailable** | 无可用权限回调可映射（§38），保持现状，不伪造 |

---

## 7. 消费者

- `src/ipc/handlers.js` → `hub:verification` IPC（§82）：返回全部 Agent 画像。
- `public/js/api.js` → `hubVerification()`。
- `public/js/pages.js` → Agent Center 卡片 `验证：<levelLabel>` + 维度明细表。
- GUI 判定颜色仅对 `real_agent_task_verified` / `real_protocol_verified` 显示 ok 色，
  `not_verified` 显示警示色，其余中性（`hubVerificationClass`）。
