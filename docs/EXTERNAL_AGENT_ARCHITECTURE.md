# External Agent Production Architecture (P4)

P4 keeps `AgentHub` as the only production entry point for external-agent work. An adapter is a transport boundary, not an independent orchestrator and not an authority that may complete a parent Main Agent run.

```text
Main Agent / IPC
  -> AgentRouter (capability + truthful availability)
  -> AgentHub (canonical runId + canonical projectRoot)
  -> ProjectMutationLock (one writer per project)
  -> adapter (ACP / CLI / HTTP / desktop)
  -> terminal gate (one terminal result)
  -> independent git/filesystem effect verification
  -> adapter quiescence
  -> lock release + sanitized result/evidence persistence
```

## Production invariants

- The Hub-generated Run ID is canonical from lifecycle creation through adapter start, events, cancellation, evidence, and persistence. An adapter-reported mismatch fails closed and triggers cleanup.
- A coding task must have a canonical project root. The Hub captures an independent pre-effect baseline, verifies the post-effect filesystem/git state, and never treats an adapter's `changedFiles` claim as proof.
- `ProjectMutationLock` is held until the adapter confirms quiescence. Cancel, timeout, process crash, sidecar shutdown, server release, and desktop action cancellation cannot release the lock early.
- Each Run crosses one terminal gate exactly once. Late completion or output cannot overwrite `cancelled`, `timeout`, or `failed`.
- Fallback is allowed only before external execution starts. Once an external writer may have acted, the platform does not silently start a second writer.
- CLI descendants are owned by `CliProcessSupervisor`, use an environment allowlist, and require bounded exit confirmation. ACP transport, managed HTTP servers, Cline sidecar, and P3 desktop sessions expose equivalent quiescence contracts.
- External results and persisted verification evidence are recursively sanitized. Credentials, authorization headers, cookies, tokens, prompts containing secrets, and raw environment values are not evidence.

## Truth model

Installed is not Available, and Available is not Verified. Protocol Verified is not Real Task Verified. Health answers whether a runtime can run now; evidence levels answer what was actually observed. The GUI and router consume those separate facts without inventing a stronger status.

P4 is **IMPLEMENTED**, not architecture-frozen. P5 parallel worktree execution is deliberately outside this change.
