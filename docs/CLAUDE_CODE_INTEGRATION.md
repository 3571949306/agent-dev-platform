# Claude Code Integration（v2.8.0 spec §49–§54 / §136）

新增 `ClaudeCodeAgentAdapter`（spec §49）。production runtime 由研究决定，
结论见 `docs/CLAUDE_RUNTIME_DECISION.md`：SDK primary → CLI fallback，ACP 显式可选。

## 1. 统一的是 Internal Contract（spec §51）

Claude 接入不要求"所有 Agent 都走 CLI"，统一目标是内部契约：

```text
Claude（SDK / CLI / ACP）→ ClaudeCodeAgentAdapter → AgentEvent → AgentResult → AgentLifecycle
```

与 Codex / Cline / Native 等走同一套 Hub 接口；v2.8.0 为事件总线新增了
`AGENT_EVENT.REASONING` / `COMMAND_OUTPUT` 两个标准事件类型。

## 2. 模块清单

| 模块 | 职责 |
| --- | --- |
| `src/agents/adapters/claudeCodeAgentAdapter.js` | Adapter 主体：runtimeMode 选路（auto/sdk/acp/cli）、SDK query() 驱动、CLI 监督、session 管理、getAuthState() |
| `src/agents/protocols/claude/claudeConstants.js` | 事件 schema 常量（MESSAGE_TYPE / SYSTEM_SUBTYPE / RESULT_SUBTYPE / CONTENT_BLOCK）、`PERMISSION_MODE` 白名单（`ALLOWED_PERMISSION_MODES`，**不含 bypassPermissions**）、工具分类 `TOOL_KIND` / `classifyTool` |
| `src/agents/protocols/claude/claudeEventMapper.js` | `createClaudeEventMapper`、`extractPaths`：SDK 与 CLI **共用**（同一 stream-json schema） |
| `src/agents/runtime/cliProcessSupervisor.js` | CLI 模式的进程监督 + env allowlist |
| `src/agents/runtime/structuredStreamDecoder.js` | stream-json 逐行解码（跨 Agent 复用） |
| `src/agents/manifests/builtinAgents.js` | `CLAUDE_CODE` manifest（transport: protocol），注册进 `BUILTIN_AGENT_MANIFESTS` |

## 3. SDK primary（spec §50）

- `query()` + streaming input 模式：支持 `interrupt()` / `setPermissionMode()` / `setModel()`；
- 事件最全：thinking / stream_event / permission_denials / usage+cost；
- Session 最全：sessionId / resume / forkSession；
- `canUseTool` 逐次回调是平台侧权限裁决的唯一官方通道：
  ```text
  canUseTool(toolName, input)
    → permissionBroker.evaluate(父 Run 权限 ∩ 平台策略 ∩ Agent 策略)
      ├─ 交集外 → deny（不打扰用户）
      └─ 交集内 → GUI 逐次审批；无 GUI → deny（缺省 deny，spec §36）
  ```
- env：SDK `options.env` 整体替换子进程环境 → 显式 allowlist，不透传宿主环境。

## 4. CLI fallback（spec §53）

只使用公开官方 flag（已逐项取证，未验证的一律不用）：

```text
claude -p <prompt> --output-format stream-json --verbose
  [--resume <sessionId>] [--session-id <uuid>]
  [--permission-mode default|acceptEdits|plan]   # 白名单校验，禁止 bypassPermissions
  [--allowedTools ...] [--disallowedTools ...] [--mcp-config ...]
```

验证结论（spec §53 五项）：non-interactive（`-p`）✓、structured output
（`--output-format stream-json`）✓、session id（`--session-id` / `--resume`）✓、
resume ✓、permissions（仅预置策略，无运行时逐次回调 → 能力声明
approval:false / interrupt:false）。只读父 Run 下额外 deny 写类工具
（Write / Edit / MultiEdit / NotebookEdit / Bash）。

**禁止**：`--dangerously-skip-permissions`（常量层白名单直接拦截）。

## 5. ACP 显式模式（spec §52）

`runtimeMode='acp'`（或 `config.acpEnabled`）时交给通用 `AcpAgentAdapter` +
`@agentclientprotocol/claude-agent-acp@0.66.0`（pin version；其依赖
`@anthropic-ai/claude-agent-sdk@0.3.220` 为 Anthropic Commercial Terms，
已在 THIRD_PARTY_NOTICES 登记，不 vendor）。不进 auto 链的理由见决策文档 §3。

## 6. 认证（spec §79 对齐）

- 不读取 / 不提取 Claude 登录凭据；
- `getAuthState()` 两态：配置了 `ANTHROPIC_API_KEY`（存在性，不读值）→
  `API_KEY / authenticated`；否则 `UNKNOWN`（依赖官方登录态，平台无法核实）→
  Router 按 UNKNOWN 扣分，避免未登录 Agent 截胡 fallback 链。

## 7. 终态语义

- SDK：result 消息 subtype 决定终态；进程 unexpected exit = FAILED（spec §65）；
- CLI：stream-json `result` 事件为唯一终态来源，decoder 保证恰好一次；
- timeout ≠ cancelled（spec §67）；cancel 经 `interrupt()`（SDK）或 killTree（CLI，仅用户主动取消时才允许杀进程）。

## 8. 测试

- `test/claudeCodeAdapter.test.js`：选路 / 能力矩阵 / CLI flag 白名单 / 权限
  交集 / 终态语义；
- `test/claudeEventMapper.test.js`：stream-json 事件映射；
- E2E：agent-hub 用例覆盖 claude-code 注册与健康展示；Router 认证评分
  回归用例（`test/agentRouter.test.js`）确保未登录的 claude-code 不截胡
  native fallback。
