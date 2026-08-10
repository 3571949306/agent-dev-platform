# External Agent Pack

The v2.7.x external pack connects Cline, OpenCode, and OpenHands through the common AgentHub lifecycle. Each provider remains a child run: it may report a result, changed files, tests, and provenance, but it cannot complete the parent Main Agent run. The parent still reviews the diff, runs required local verification, and applies CompletionPolicy.

## Cline in v2.7.3

Cline is no longer an in-process `Agent` facade in production. Its path is:

```text
AgentHub -> ProjectMutationLock -> ClineAgentAdapter
  -> ClineSidecarManager -> bundled Node 22 -> real ClineCore
```

The adapter maps the selected encrypted platform connection to Cline provider/model configuration, passes credentials in memory for one run, forwards exact parent scopes, and normalizes official Core/Agent event envelopes. The sidecar verifies Cline's resolved session manifest before accepting completion. Cancel, timeout, process crash, late results, and shutdown all pass through the shared terminal gate and release the project lock.

`sdkBridge.js` remains only to keep legacy injected tests compatible. It is not selected in packaged or normal development production mode.

## Other providers

- OpenCode keeps its managed HTTP server/session integration.
- OpenHands keeps its configured HTTP/WebSocket Agent Server integration.
- Codex and WorkBuddy remain unaffected if the Cline runtime is absent or damaged.

For Cline operations and upgrade pins, see `CLINE_SIDECAR_RUNTIME.md`. Historical discovery notes remain in `EXTERNAL_AGENT_PACK_RESEARCH.md` and `EXTERNAL_AGENT_RUNTIME_RESEARCH.md`; current production behavior is defined by this document and the runtime decision.
