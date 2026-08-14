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

The production smoke covers 216 deterministic assertions: ACP 15/15, CLI 2/2, HTTP 1/1, and desktop 1/1, plus Hub/evidence/security invariants. The soak covers repeated detection, identity, cancel, lifecycle, lock, false-completion, and 1000 late-event cases with zero final residues. GUI cases 160–180 cover truth labels, separate Safe/Real controls, six verification dimensions, consent enforcement, secret absence, evidence refresh, and temporary-repository cleanup.

Installed != Available != Verified. Protocol Verified != Real Task Verified. Fixture and smoke coverage prove platform behavior; they do not assert that an unconsented real provider task ran.
