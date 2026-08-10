# Upstream Reference Matrix

This matrix pins the sources used for the v2.7.3 Cline integration and the v2.8.0 Universal External Agent Runtime. The implementation must be re-audited when any pin changes.

| Project | Version / commit | Files and documentation inspected | API or design used | License | Our implementation |
| --- | --- | --- | --- | --- | --- |
| Cline | `@cline/sdk 0.0.72`; commit `b3cee3f973ffe9d023a10c5c414deba68cd6e09d` | `sdk/README.md`, `sdk/ARCHITECTURE.md`, `sdk/packages/core/src/ClineCore.ts`, `sdk/packages/core/src/types/config.ts`, `sdk/packages/shared/src/rpc/runtime.ts`, `apps/cli/src/runtime/run-agent.ts`, `apps/cli/src/runtime/session-events.ts`, `apps/cli/src/runtime/tool-policies.ts`, `apps/examples/cline-core-cli-agent/src/index.ts`, `apps/examples/desktop-app/sidecar/index.ts`, `apps/examples/desktop-app/sidecar/ARCHITECTURE.md`, and the official SDK reference/event pages | `ClineCore.create`, `start`, `subscribe`, `abort`, `stop`, `dispose`, session manifest workspace fields, tool policies, event envelopes, and lifecycle ownership | Apache-2.0 | An independent Node 22 sidecar invokes the published SDK. The Electron main process never imports the production SDK. |
| Node.js | `22.23.2`, Windows x64 archive; release tag `v22.23.2` | Node 22 archive, `SHASUMS256.txt`, child process documentation, distribution `LICENSE` | Pinned runtime, `spawn` with pipes, canonical `cwd`, environment allowlist, shutdown and process-tree fallback | Node.js license plus bundled third-party notices | `prepare-cline-runtime.js` downloads only from `nodejs.org`, checks the pinned and official checksum, and stages `node.exe` plus `LICENSE`. |
| Electron | `31.7.7` | `app` lifecycle and `process.resourcesPath` documentation | `before-quit`, packaged resource discovery | MIT | Main-process lifecycle awaits sidecar disposal; packaged lookup uses `process.resourcesPath`. |
| electron-builder | `24.13.3` | Application Contents and Configuration documentation | `extraResources` | MIT | Stages the complete runtime at `resources/cline-runtime/`. |

## Source URLs

- Cline repository: https://github.com/cline/cline
- Cline SDK overview: https://docs.cline.bot/sdk/overview
- ClineCore reference: https://docs.cline.bot/sdk/clinecore
- Agent reference: https://docs.cline.bot/sdk/reference/agent
- Cline events: https://docs.cline.bot/sdk/events
- Node 22 archive: https://nodejs.org/en/download/archive/v22
- Node child processes: https://nodejs.org/api/child_process.html
- Electron app lifecycle: https://www.electronjs.org/docs/latest/api/app
- electron-builder contents: https://www.electron.build/docs/contents/

## v2.8.0 — Universal External Agent Runtime（spec §18）

| Repository | URL | Commit | Version | License | Files inspected | Relevant API | Integration decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ACP（agent-client-protocol） | https://github.com/agentclientprotocol/agent-client-protocol | `e388d69b640060bcdd2b5449f01e1bb2b2a7d882` | wire v1（protocolVersion=1）；v2 = 2.0.0-alpha | Apache-2.0 | `schema/v1/schema.json`、`schema/v1/meta.json`、协议文档（initialize / session / permissions / capabilities / StopReason） | JSON-RPC 2.0：initialize、authenticate、session/new\|prompt\|cancel\|load\|resume\|close、session/request_permission、session/update、fs/*、terminal/* | 自研 AcpClientRuntime 逐字对齐 schema/v1（`src/agents/protocols/acp/constants.js`）；v2 仅记录不参与协商（fail-closed） |
| ACP TypeScript SDK | https://github.com/agentclientprotocol/typescript-sdk | `e1054d0122e844cca9f1016a598a1da06f78ccef` | `@agentclientprotocol/sdk 1.3.0` | Apache-2.0 | `src/schema/index.ts`（PROTOCOL_VERSION=1）、`src/v2/schema/index.ts`（=2）、Client/Agent 类、ContentBlock 定义 | 消息形状与版本双轨取证（根命名空间=v1，/v2=alpha） | 不引入为运行时依赖；schema 已转写为自有常量层（见 docs/ACP_RUNTIME_DECISION.md §3-A） |
| ACP Registry | https://github.com/agentclientprotocol/registry | `2ae27530cd78604cc468c785e939a5a0a8894611` | —（服务端） | Apache-2.0 | 仓库结构、agent 条目格式、已知 ACP Agent 清单 | ACP Agent 发现 / 元数据 | 仅研究参考：确认 codex-acp / claude-agent-acp 均为官方 v1 实现；不依赖其在线服务 |
| Codex | https://github.com/openai/codex | `21aa552e8727c03189d0f7d18bbd6e7583e88f88` | 用户本机 codex CLI | Apache-2.0 | `codex-rs/app-server-protocol/src/protocol/v2/*.rs`（thread/turn/item/review）、`codex-rs/app-server`、exec 子命令 JSON 输出格式 | `codex app-server`（JSON-RPC：thread/*、turn/*、review/start、getAuthStatus）、`codex exec --json` | Direct App Server 为 primary，exec 为结构化 fallback，legacy runCodex 兜底（见 docs/CODEX_RUNTIME_DECISION.md） |
| codex-acp | https://github.com/agentclientprotocol/codex-acp | `9edc92458504a9653f539f2a515f59e4a95796a7` | `@agentclientprotocol/codex-acp 1.1.14`（deps: @agentclientprotocol/sdk 1.3.0） | Apache-2.0 | `package.json`、入口/打包配置、ACP 映射层 | Codex core → ACP v1 映射（session/update、request_permission） | 不引入为依赖；保留经通用 AcpAgentAdapter 显式接入的能力 |
| Claude Code | https://github.com/anthropics/claude-code | `2bb60696142b493eafaeacfe00eac51d16c50c4f` | 用户本机 claude CLI | **Anthropic Commercial Terms（非 OSS）** | CLI 文档、非交互模式 flag（-p / --output-format / --resume / --session-id / --permission-mode / --allowedTools）、SDK 集成说明 | `claude -p --output-format stream-json --verbose` | 仅作 CLI fallback 通道与 flag 取证；不 vendor、不再分发；`.research/upstream/claude-code` 不进制品 |
| Claude Agent SDK (TypeScript) | https://github.com/anthropics/claude-agent-sdk-typescript | `d13c50c54d591cb2355672c8259fbb6e159687f9` | `@anthropic-ai/claude-agent-sdk 0.3.220`（经 claude-agent-acp deps 取证） | **Anthropic Commercial Terms（非 OSS）**；本仓库为 docs-only | 文档：query()、Options（cwd/env/mcpServers/resume/forkSession/canUseTool/permissionMode）、SDKMessage 事件形状、Query.interrupt()/setPermissionMode()/setModel() | query() + streaming input；canUseTool 逐次审批；stream-json schema | Claude primary runtime（SDK 依赖引入，不 vendor 源码）；见 docs/CLAUDE_RUNTIME_DECISION.md |
| claude-agent-acp | https://github.com/agentclientprotocol/claude-agent-acp | `3df1ede89f217312bc237124dc1eccc10c860f99` | `@agentclientprotocol/claude-agent-acp 0.66.0`（deps: @anthropic-ai/claude-agent-sdk 0.3.220、@agentclientprotocol/sdk 1.3.0） | Apache-2.0（包本体）；依赖的 SDK 为 Commercial Terms | `package.json`、SDK → ACP 映射层（tool calls / permission / session） | Claude Agent SDK → ACP v1 桥 | 不进 auto 链；仅显式 runtimeMode='acp' 时经通用 AcpAgentAdapter 接入（pin 0.66.0 + audit，spec §52） |

### v2.8.0 Source URLs

- ACP 仓库：https://github.com/agentclientprotocol/agent-client-protocol
- ACP TS SDK：https://github.com/agentclientprotocol/typescript-sdk
- ACP Registry：https://github.com/agentclientprotocol/registry
- Codex：https://github.com/openai/codex
- codex-acp：https://github.com/agentclientprotocol/codex-acp
- Claude Code：https://github.com/anthropics/claude-code
- Claude Agent SDK：https://github.com/anthropics/claude-agent-sdk-typescript
- claude-agent-acp：https://github.com/agentclientprotocol/claude-agent-acp

The `.research/cline-upstream` and `.research/upstream` checkouts are intentionally ignored by git and are not distributed.

## v2.8.1 — Upstream re-audit（spec §63）

**Re-audit date:** 2026-08-10
**Method:** 对 `.research/upstream/` 下每个本地快照执行 `git rev-parse HEAD` 与
`git log -1 --format=%cs`，逐仓库与上表 v2.8.0 记录的 pin 比对。

| Repository | Pinned commit (v2.8.0) | Re-audited HEAD (2026-08-10) | Snapshot last commit date | Drift |
| --- | --- | --- | --- | --- |
| agent-client-protocol（ACP） | `e388d69b640060bcdd2b5449f01e1bb2b2a7d882` | `e388d69b640060bcdd2b5449f01e1bb2b2a7d882` | 2026-08-09 | 无 |
| typescript-sdk（ACP TS SDK） | `e1054d0122e844cca9f1016a598a1da06f78ccef` | `e1054d0122e844cca9f1016a598a1da06f78ccef` | 2026-08-08 | 无 |
| registry（ACP Registry） | `2ae27530cd78604cc468c785e939a5a0a8894611` | `2ae27530cd78604cc468c785e939a5a0a8894611` | 2026-08-10 | 无 |
| codex | `21aa552e8727c03189d0f7d18bbd6e7583e88f88` | `21aa552e8727c03189d0f7d18bbd6e7583e88f88` | 2026-08-10 | 无 |
| codex-acp | `9edc92458504a9653f539f2a515f59e4a95796a7` | `9edc92458504a9653f539f2a515f59e4a95796a7` | 2026-08-09 | 无 |
| claude-code | `2bb60696142b493eafaeacfe00eac51d16c50c4f` | `2bb60696142b493eafaeacfe00eac51d16c50c4f` | 2026-08-08 | 无 |
| claude-agent-sdk-typescript | `d13c50c54d591cb2355672c8259fbb6e159687f9` | `d13c50c54d591cb2355672c8259fbb6e159687f9` | 2026-08-08 | 无 |
| claude-agent-acp | `3df1ede89f217312bc237124dc1eccc10c860f99` | `3df1ede89f217312bc237124dc1eccc10c860f99` | 2026-08-09 | 无 |

**结论：8/8 仓库 pin 未漂移。** v2.8.1 未改动任何上游协议映射，
`src/agents/protocols/acp/constants.js` 的 wire v1 常量层无需重新转写。

### 本机 CLI 取证（re-audit 时实测）

| CLI | 本机检测结果 | 用途 |
| --- | --- | --- |
| `claude` | **2.1.220 (Claude Code)** — 已安装 | Claude Code 集成的 local detection 证据来源 |
| `codex` | **未安装** | 因此 Codex 适配器在本机最高只能达到 `FIXTURE_VERIFIED`，不得声明 local detection（见 `src/agents/verification/agentVerification.js`） |
| `cline` | 未安装（不需要——走内置 sidecar，不依赖全局 CLI） | — |
| `opencode` | 未安装 | 同 Codex 规则 |

> Claude Code 为 **Anthropic Commercial Terms（非 OSS）**，本轮同样只做 flag/文档取证，
> 不 vendor、不再分发。上表中的 `2.1.220` 是本机 `claude --version` 的真实输出，
> 不代表上游最新发布版本。
