# Architecture Freeze — v2.9.7

This document freezes the production architecture after Framework First. Core framework changes now require an explicit architecture-manifest update and a passing architecture gate. Product work may compose these modules, but must not introduce another runtime, router, permission engine, tool executor, or framework truth.

## Production chain

```text
User / GUI
  -> preload API -> Electron IPC
  -> application service entry (src/services/productEntry.js and src/ipc/mainAgent.js)
  -> Main Agent Orchestrator (src/agent/runtime/mainAgentRuntime.js)
  -> Skill Resolver / Hook Engine / Workflow Runtime
  -> Dynamic Agent Factory or external Agent adapter
  -> AgentHub and RunBridge
  -> Model Router
  -> ProviderModelAdapter
  -> model Provider
```

Tool execution branches from the Main, Dynamic, or Workflow path into the Tool Registry and the shared action executor. The action executor applies PermissionEngine and PathSecurity before a tool implementation. Mutating Agent runs additionally acquire ProjectMutationLock. RunManager owns persisted execution terminal truth; AgentHub LifecycleManager is synchronized through RunBridge.

The provider domains remain distinct: **Model Provider != Agent Provider != Tool Provider**. Model providers produce model output, Agent providers own delegated execution transports, and Tool providers implement bounded actions.

## Frozen boundaries

- Skill cannot grant authority. It contributes instructions and requirements; resolution is an intersection with existing authority.
- Hook may block, observe, or append bounded context. Hook cannot grant authority.
- Workflow orchestrates existing authority. Workflow cannot create authority.
- Generator produces validated, disabled-by-default configuration drafts. Generator cannot execute configuration.
- Dynamic authority is exactly **Platform ∩ Parent ∩ AgentDefinition ∩ Skill**. Hook guards may only further block that result.
- Production tool execution must cross **PermissionEngine + PathSecurity** where a filesystem path applies.
- Model selection goes through the Model Router; ProviderModelAdapter is the only native Agent-to-model wire.
- Agent execution identities are created by RunManager/AgentHub. A conversation, Workflow step, or Generator draft is not an Agent run.
- Terminal means terminal: completion, failure, cancellation, and timeout reject late provider, tool, Agent, approval, and desktop results.

## Execution, authority, and identity truths

The single native loop is `runMainAgent`. Dynamic native adapters invoke that loop through AgentHub rather than implementing a second loop. `src/agent/runtime.js` remains only the legacy chat compatibility loop and is not the Main/Dynamic/Workflow execution truth.

The single model-selection implementation is `src/models/router/modelRouter.js`. The single production tool gate is `src/agent/runtime/actionExecutor.js`; the legacy chat compatibility gate remains in `src/agent/runtime.js`. The single permission-policy implementation is `src/security/permissions.js`; `DynamicPermissionEngine` is an intersection wrapper whose parent call fails closed.

Identity fields are not interchangeable:

| Field | Owner and meaning |
|---|---|
| `conversationId` | UI/chat grouping; never an execution identity |
| `workflowRunId` | durable Workflow execution |
| `workflowStepId` | step identity inside one Workflow run |
| `runId` | real RunManager Agent execution |
| `rootRunId` | root of an Agent delegation tree |
| `parentRunId` | immediate parent Agent run |
| `agentId` | configured or adapter Agent identity |
| `routeDecisionId` | Model Router audit decision |
| `hookInvocationId` | one Hook dispatch audit record |
| `generatorDraftId` | configuration draft; never execution |

Standalone Workflow tool steps intentionally carry null Agent `runId`, `rootRunId`, and `parentRunId`, while retaining their real `workflowRunId` and `workflowStepId`. Agent-owned tool actions carry the actual Agent run identity.

## Repository-wide call-path inventory

The architecture gate searches production source, tests, and scripts for the requested execution signatures. Every match receives one of these classifications; any `UNSAFE_DUPLICATE` fails the gate.

| Signature | CANONICAL | LEGACY_COMPATIBILITY | TEST_ONLY | Forbidden location |
|---|---|---|---|---|
| `provider.streamResponse` | ProviderModelAdapter and provider capability probes | legacy chat, external-Agent compatibility, vision fallback | fake-network and smoke fixtures | Workflow or Generator execution bypass |
| `model.decide` | Main loop, Dynamic native loop, Generator configuration generation | none | deterministic models | an alternate native loop |
| `tool.exec` | shared action executor | legacy chat gate | tool fixtures | direct Workflow/Dynamic execution |
| `child_process` | owned MCP, terminal, Computer, Git, external-adapter, and sidecar transports | none | test/build scripts | an unowned process without bounded cleanup |
| filesystem writes | DB persistence, checkpointing, Tool providers, owned session/config persistence | legacy import/compatibility paths | fixtures/build output | Generator, Skill, or Hook execution |
| `AgentHub.start` | delegation and Workflow Agent steps | none | Hub fixtures | Generator |
| `runMainAgent` | application Main service and Native Agent adapter | none | deterministic production smokes | a second Main loop |
| `PermissionEngine.evaluate` | shared action executor and authority intersection | legacy chat compatibility gate | adversarial fixtures | a permissive duplicate engine |

The static classifier is implemented by `scripts/test-architecture.js`; its printed inventory is the machine-readable release proof.

## Lifecycle and ownership

Main providers own AbortControllers. Dynamic instances are disposed after run lifetime. AgentHub cancellation reaches the active adapter and RunBridge terminal gate. Workflow cancellation settles approval waiters and downstream runs. Generator cancellation aborts its model request and cannot save a cancelled draft. External adapters, MCP clients, Computer PowerShell processes, browser instances, and sidecars own and bound their child processes.

App quit is bounded to ten seconds. It aborts Main/chat requests, rejects pending permission prompts, cancels managed Hub/Workflow/Generator work, disposes Dynamic and external adapters, disconnects MCP, closes the browser, checkpoints SQLite, and releases every project lock. The finalizer repeats abort/disconnect/lock cleanup even after timeout.

On cold start, durable nonterminal Agent runs become `interrupted`; Workflow `RUNNING`/`WAITING_APPROVAL` records become `FAILED` with `WORKFLOW_INTERRUPTED`; Generator `GENERATING`/`VALIDATING`/`REPAIRING` drafts become `FAILED` with `GENERATOR_INTERRUPTED`. No process-local ownership is pretended to survive restart.

## Diagnostics truth

Product Diagnostics is a read/probe composition service, not a framework. Database health uses a real SQLite query. Model connection availability comes only from enabled and successfully tested connections. Model Router readiness requires at least one usable candidate. Computer availability requires real Windows window discovery. Browser is `UNKNOWN` until a real launch attempt establishes availability. External Agent availability comes from bounded health checks; missing installations are `UNAVAILABLE`, while absent evidence is `UNKNOWN`. No credential or request payload is returned.

## Change policy

The architecture manifest is authoritative for frozen module locations. A core-boundary change must intentionally update both manifest and this document, add or revise a failing-first architecture assertion, pass product production smoke, and preserve zero unsafe duplicate paths. Future framework ideas belong only in `PRODUCTIZATION_ROADMAP.md`.
