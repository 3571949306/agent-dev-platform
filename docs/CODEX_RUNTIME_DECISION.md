# Codex Runtime Decision（v2.8.0 spec §43 / §19）

> 状态：已定稿并实现。决策对应代码：`src/agents/adapters/codexAgentAdapter.js` + `src/agents/protocols/codex/*`。
> 依据 spec §42：不删除既有 CodexAgentAdapter，只升级其内部运行时选路。

## 1. 决策结论

```text
选择 A：Direct Codex App Server（primary）
保留 B：codex-acp —— 不引入（理由见 §3），但 ACP 通道对 Codex 可用（通过通用 AcpAgentAdapter 显式配置）
保留 C：codex exec --json（fallback）；legacy runCodex 仅作最后兜底
```

即 `runtimeMode = auto` 时的实际链路：**app-server → exec → legacy**。

## 2. 三个候选的取证事实

取证钉版：codex `21aa552e`（Apache-2.0）、codex-acp `9edc9245`（v1.1.14，Apache-2.0）。

### A. Direct Codex App Server

- `codex app-server` 是 OpenAI 官方 CLI 的一等子命令，JSON-RPC 2.0（裸信封，逐行 JSONL over stdio）；
- 结构化接口覆盖最完整：`thread/start|resume|list|read`、`turn/start|interrupt|steer`、`review/start`、`getAuthStatus`，turn 事件含 reasoning / item / diff / plan；
- 事件形状逐字取证自 `codex-rs/app-server` 协议层（v2/turn.rs、v2/item.rs 等）；
- 与 CLI 同一二进制分发，无额外依赖。

### B. codex-acp

- 官方维护的 ACP 适配层（`@agentclientprotocol/codex-acp@1.1.14`），本质是 **Codex core 外面包一层 ACP**；
- 对我们的价值 = 走通用 AcpClientRuntime 也能驱动 Codex。但它不是更薄的抽象，反而多一层进程内转换与一个 npm 依赖；
- 它的能力集合是 ACP v1 能力集合的子集（受限于 v1 SessionUpdate 11 变体），不如直连 App Server 拿到的事件细（例如 review/start）。

### C. codex exec structured output

- `codex exec --json` 输出官方结构化 JSON 事件流，无交互审批通道、无 turn/interrupt；
- 满足 spec §44（结构化 JSON，不是文本抓取），作为 app-server 不可用时的合规 fallback。

## 3. 为什么选 A 而不是 B

| 维度 | A. App Server | B. codex-acp | C. exec |
| --- | --- | --- | --- |
| 官方支持度 | 官方 CLI 一等子命令 | 官方维护（ACP org） | 官方 CLI 子命令 |
| 结构化事件完整度 | 最全（含 review / diff / plan / interrupt） | ACP v1 子集 | 单轮事件，无交互 |
| 交互审批 | 有（turn 级请求-响应） | 有（session/request_permission） | 无 |
| Session / Resume | thread 语义完整 | sessionCapabilities 决定 | resume 有限 |
| 额外依赖 | 无（同一 codex 二进制） | 需引入 npm 包并 pin | 无 |
| 版本耦合 | 与用户本机 codex 版本同步，method-not-found 可探测降级 | 依赖 codex-acp 发布节奏 | 同 A |

结论：**A 最完整且零额外依赖**。B 不作为默认路径，但平台保留经通用 ACP 通道接入 Codex 的能力（用户显式配置 ACP Agent 指向 codex-acp 时可用）。C 为结构化 fallback。

关键降级机制：App Server 对旧版 codex 返回 `-32601 method not found` 的深度方法，适配器捕获后自动降级到 exec，不猜测版本。

## 4. 能力声明（spec §45，实际支持什么填什么）

| 能力 | app-server | exec | legacy |
| --- | :-: | :-: | :-: |
| coding / filesystem / terminal / git / diff | ✓ | ✓ | ✓ |
| review / planning / reasoning / mcp / web | ✓ | planning/reasoning/mcp/web ✓，review ✗（需另起 `codex exec review` 子命令，未接线即不声明） | ✗ |
| sandbox | ✓ | ✓ | ✓ |
| session / resume | ✓ | ✓ | ✗ |
| streaming | ✓ | ✓ | ✓ |
| approval / interrupt | ✓ | ✗ | ✗ |
| subagent | ✗（无官方接口，不臆造） | ✗ | ✗ |

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 用户 codex 版本过旧，无 app-server 子命令 | spawn 失败 / method-not-found → 自动降级 exec → legacy，并留 FALLBACK 事件 |
| app-server 协议随 codex 版本演进 | 常量集中在 `protocols/codex/appServerConstants.js`；未知事件忽略而不报错（forward-compat） |
| 进程意外退出 | unexpected exit = FAILED（spec §65），绝不判 COMPLETED；timeout ≠ cancelled（spec §67） |
| 登录态探测越界 | 只调 `getAuthStatus` 读布尔登录态供 Router/GUI 展示，从不触碰 token 本体（spec §30/§79） |

## 6. Fallback 链（实现于 `CodexAgentAdapter.startTask` 的 auto 选路段）

```text
auto:
  app-server 可用（spawn + initialize 成功）→ 结构化全程
  否则 exec（codex exec --json）            → 结构化单轮
  否则 legacy（v2.6.0 runCodex）            → 发 FALLBACK 事件留痕，GUI 可见降级
```

禁止路径（spec §44）：任何 production primary 都不允许 `spawn codex` 后正则分析自然语言终端文本。
