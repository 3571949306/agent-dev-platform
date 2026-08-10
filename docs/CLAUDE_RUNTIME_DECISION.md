# Claude Runtime Decision（v2.8.0 spec §16 / §19）

> 状态：已定稿并实现。决策对应代码：`src/agents/adapters/claudeCodeAgentAdapter.js` + `src/agents/protocols/claude/*`。
> 本文不预设答案——先研究后比较，结论在 §3。

## 1. 候选

```text
A. Claude Agent SDK（@anthropic-ai/claude-agent-sdk，query() API）
B. Claude Code CLI structured mode（claude -p --output-format stream-json）
C. ACP adapter（@agentclientprotocol/claude-agent-acp，SDK 外包一层 ACP）
```

取证钉版：claude-code `2bb60696`、claude-agent-sdk-typescript `d13c50c5`（docs 仓库）、claude-agent-acp `3df1ede8`（v0.66.0，依赖 `@anthropic-ai/claude-agent-sdk@0.3.220`）。

## 2. 14 维评分（spec §16）

评分：★★★ 完整 / ★★ 部分 / ★ 缺失或不可用。

| 维度 | A. SDK | B. CLI structured | C. ACP adapter |
| --- | --- | --- | --- |
| 官方支持度 | ★★★ Anthropic 官方 SDK，持续发布 | ★★★ 官方 CLI 一等模式 | ★★ ACP org 维护，底层仍是 SDK |
| 稳定性 | ★★★ 版本化 API | ★★★ 与 CLI 同版本 | ★★ 依赖 SDK+ACP 双版本对齐（0.66.0 ↔ sdk 0.3.220） |
| 结构化事件 | ★★★ thinking / stream_event / permission_denials / usage+cost 全集 | ★★ 同一 schema 子集（stream-json 逐行） | ★★ ACP v1 SessionUpdate 11 变体 |
| Session | ★★★ sessionId + forkSession | ★★ --session-id / --resume | ★★ sessionCapabilities 决定 |
| Resume | ★★★ options.resume | ★★ --resume | ★★ 需 resume capability |
| Permissions | ★★★ canUseTool 逐次回调（**唯一**可平台侧逐次裁决的官方通道） | ★ 仅预置策略（--permission-mode / --allowedTools） | ★★★ session/request_permission |
| Cancel | ★★★ Query.interrupt()（streaming input 模式） | ★ 无官方中断协议 | ★★★ session/cancel |
| MCP | ★★★ mcpServers 选项 | ★★ --mcp-config | ★★ ACP mcpCapabilities |
| cwd | ★★★ options.cwd | ★★ 进程 cwd | ★★ session/new cwd |
| Coding Tools | ★★★ 全套内置工具 | ★★★ 同左（同一引擎） | ★★★ 经 SDK 同引擎 |
| 打包难度 | ★★★ 纯 npm 依赖，无需分发 CLI 二进制 | ★★ 要求用户本机装有 claude CLI | ★ 需 pin 两个包 + CLI 引擎，最重 |
| License / Terms | ★ Anthropic Commercial Terms（**非 OSS**，可作依赖使用，禁止 vendor/再分发） | ★ 同左 | ★★★ Apache-2.0（但依赖的 SDK 仍是 Commercial Terms） |
| 用户登录支持 | ★★★ 复用官方登录态（平台不触碰凭据） | ★★★ 同左 | ★★★ 同左 |
| API Key 支持 | ★★★ ANTHROPIC_API_KEY | ★★★ 同左 | ★★★ 同左 |

## 3. 决策结论

```text
runtimeMode = auto（默认）
  1) sdk  —— primary
  2) cli  —— fallback（SDK 依赖缺失或初始化失败时）
  acp     —— 不进 auto 链，仅显式 runtimeMode='acp' / config.acpEnabled 启用
```

理由：

- **SDK 在 Permissions / Cancel / Session / 事件完整度四个决定性维度全面领先**，且 canUseTool 是满足本平台"权限交集 + GUI 逐次审批"硬约束的唯一官方通道（spec §50：不要为了 CLI 统一反而放弃官方 SDK）；
- CLI 与 SDK **同一套事件 schema**（stream-json），共用 `claudeEventMapper`，因此 cli 作为 fallback 的接线成本极低，但能力声明必须如实降级（approval:false / interrupt:false，spec §45 精神）；
- claude-agent-acp 本质是"SDK 外面套一层 ACP"：多一层依赖、License 上仍拖着 Commercial Terms 的 SDK，而它能给的权限/事件语义我们用 SDK 直连已经全部拿到 → 不进 auto 链；保留显式入口是为了 spec §52 场景（用户明确想走 ACP 统一通道时，经通用 AcpAgentAdapter 接入，pin version + audit）。

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| SDK 是 Anthropic Commercial Terms（非 OSS） | 只作为 npm 运行时依赖引入，**不 vendor、不再分发、不复制源码**；THIRD_PARTY_NOTICES 如实登记；`.research/upstream/claude-code` 与 `claude-agent-sdk-typescript` 仅本地研究，不进制品 |
| SDK 的 `options.env` 会整体替换子进程环境 | 正合最小化诉求：显式构造 env allowlist（PATH / HOME / ANTHROPIC_API_KEY 等按需），不透传宿主全量环境 |
| canUseTool 缺省行为 | 缺省 deny：先过权限交集（permissionBroker），再交 GUI；无 GUI 一律拒绝 |
| 危险 flag 误用 | 代码层面禁止 `permissionMode='bypassPermissions'` 与 `--dangerously-skip-permissions`（claudeConstants 白名单校验） |
| SDK 不可用（未安装 / 版本不兼容） | 自动降级 cli（stream-json），发 FALLBACK 事件留痕；能力声明随之降级 |
| 进程意外退出 / 超时 | unexpected exit = FAILED（spec §65）；timeout ≠ cancelled（spec §67） |
| 登录凭据 | 不读取、不提取；`getAuthState()` 只输出 API_KEY（显式配置了 key）或 UNKNOWN（依赖官方登录态，平台无法核实）两种状态 |

## 5. Fallback 链（实现于 `claudeCodeAgentAdapter` startTask 选路段）

```text
auto:
  SDK 可加载（require @anthropic-ai/claude-agent-sdk 成功）→ query() + canUseTool + streaming input（interrupt 可用）
  否则 claude CLI 存在 → claude -p --output-format stream-json --verbose（预置权限策略，无逐次审批）
  两者皆无 → Run FAILED + UNAVAILABLE 健康态
acp（显式）:
  → 交给通用 AcpAgentAdapter + claude-agent-acp（pin 0.66.0）
```

## 6. 不做什么（边界）

- 不使用 `--dangerously-skip-permissions` / `bypassPermissions`，无例外；
- 只读父 Run 下额外 deny 写类工具（Write / Edit / MultiEdit / NotebookEdit / Bash）——CLI 模式没有逐次回调，只能靠 deny 规则兜底；
- 不把 claude-code 仓库 / claude-agent-sdk-typescript 仓库任何源码纳入分发；
- 不声称 SDK 版本无限兼容：按取证版本 0.3.220 的事件形状实现 mapper，升级 SDK 需重新取证。
