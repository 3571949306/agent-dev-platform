# External Agent P4 Test Matrix

| Path | Deterministic production proof | Cancel / timeout / late-event proof | Real local claim |
| --- | --- | --- | --- |
| ACP process transport | Real fixture subprocess initialize/session/prompt | Process exit, cancel, timeout and late-result gates | Only when an installed runtime is separately verified |
| Shared CLI supervisor | Real child process with canonical Run ID | Tree termination, bounded exit confirmation, environment allowlist | Detection is not a real task |
| Codex | App-server/exec fixtures through production adapter contracts | Native cancel plus quiescence | No automated real-model call |
| Claude Code | ACP/CLI production adapter fixtures | Poll disposal, cancel race, process cleanup | No automated real-model call |
| Cline | Bundled sidecar/runtime fixture | Sidecar health/run shutdown and late-event fencing | No automated real-model call |
| OpenCode | Managed HTTP server/session fixture | Abort, server reference release and quiescence | No automated real-model call |
| OpenHands | HTTP/WebSocket fixture | Abort, timeout and unique terminal state | No automated real-model call |
| WorkBuddy / desktop | Exact HWND+PID P3 session fixture | Action-point abort fence and session cleanup | No automated real desktop/model task |
| AgentHub writer path | Canonical ID/root, baseline/effect verifier, lock | Terminal race and lock-release soak | Requires explicit-consent isolated task |

The final production smoke covers 229/229 assertions: closure 13/13, ACP 15/15, CLI 2/2, HTTP 1/1, desktop 1/1, and the existing Hub/evidence/security invariants. Production repeats 10/10; soak repeats 20/20. Each soak includes detection 50/50, identity 100/100, the required 20-cycle cancel/lifecycle/lock/false-completion matrices and 1000 ignored late events with zero final residue. Closure cases C1–C12 cover false completion, one-owner late quiescence, quarantine, terminal races, transport profiles, paid policy, Claude UNKNOWN, WorkBuddy fresh response, Hub-only production, consent env, call-count truth and nested sanitization. GUI cases 160–192 provide 33 meaningful P4 cases; full E2E is 192/192.

Installed != Available; Available != Verified; Health != Verification; Protocol Verified != Response Verified; Response Verified != Project Task Verified. Fixture and smoke coverage prove frozen platform behavior; they do not assert that an unconsented real provider task ran or that every local Agent is usable.
