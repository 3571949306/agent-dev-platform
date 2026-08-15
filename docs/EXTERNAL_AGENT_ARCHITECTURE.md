# External Agent Production Architecture (P4)

P4 keeps `AgentHub` as the only production entry point for external-agent work. An adapter is a transport boundary, not an independent orchestrator and not an authority that may complete a parent Main Agent run.

```text
Main Agent / IPC
  -> AgentRouter (capability + truthful availability)
  -> AgentHub (canonical runId + canonical projectRoot)
  -> ProjectMutationLock (one writer per project)
  -> adapter (ACP / CLI / HTTP / desktop)
  -> bounded terminal finalizer (one owner; adapter quiescence first)
  -> terminal gate (one terminal result)
  -> independent git/filesystem effect verification for mutating tasks
  -> lock release + sanitized result/evidence persistence
```

## Production invariants

- The Hub-generated Run ID is canonical from lifecycle creation through adapter start, events, cancellation, evidence, and persistence. An adapter-reported mismatch fails closed and triggers cleanup.
- A coding task must have a canonical project root. The Hub captures an independent pre-effect baseline, verifies the post-effect filesystem/git state, and never treats an adapter's `changedFiles` claim as proof.
- `ProjectMutationLock` is held until the adapter confirms quiescence. Cancel, timeout, process crash, sidecar shutdown, server release, and desktop action cancellation cannot release the lock early.
- An early adapter terminal is pending, not authoritative. One bounded finalizer polls for quiescence; late quiescence consumes the pending terminal once. Missing/expired quiescence proof fails and quarantines the runtime while retaining mutation authority.
- A mutating completion with no independently observed in-scope effect is `FAILED`. Read-only/response-only runs may complete with effect verification `NOT_APPLICABLE`, but can never create project-task evidence.
- Each Run crosses one terminal gate exactly once. Late completion or output cannot overwrite `cancelled`, `timeout`, or `failed`.
- Fallback is allowed only before external execution starts. Once an external writer may have acted, the platform does not silently start a second writer.
- CLI descendants are owned by `CliProcessSupervisor`, use an environment allowlist, and require bounded exit confirmation. ACP transport, managed HTTP servers, Cline sidecar, and P3 desktop sessions expose equivalent quiescence contracts.
- External results and persisted verification evidence are recursively sanitized. Credentials, authorization headers, cookies, tokens, prompts containing secrets, and raw environment values are not evidence.

## Truth model

Installed is not Available; Available is not Verified; Health is not Verification; Protocol Verified is not Response Verified; Response Verified is not Project Task Verified. Health answers whether a runtime can run now; evidence levels answer what was actually observed. The GUI and router consume those separate facts without inventing a stronger status.

P4 platform production contracts are **FROZEN at v2.9.9**. This does not claim that every local external Agent completed a real task. The repository architecture marker remains `frozenAtVersion = 2.9.7`; P5 parallel worktree execution is deliberately outside this change and remains not started.
