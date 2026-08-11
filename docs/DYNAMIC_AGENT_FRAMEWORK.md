# Dynamic Agent Framework

> Agent Dev Platform v2.9.2

## 1. Scope

v2.9.1 adds a runtime framework for structured, specialist Native Agents:

```text
AgentTemplate
  -> AgentDefinition
  -> AgentFactory
  -> AgentInstance
  -> AgentHub.register(runtime adapter)
  -> Main Agent delegate
  -> Child Run
  -> AgentResult
  -> Main Agent observation
  -> dispose / unregister
```

This release does not implement an AI Agent Generator, Model Router, Skill Engine, Hook Engine, Workflow DAG, marketplace, worktree swarm, or external runtime generator.

### v2.9.2 model policy integration

The shared `resolveRuntimeModel()` entry supports `inherit_parent`, `explicit`, and `auto`. Inheritance returns the exact Parent adapter without routing; explicit requires the exact configured connection/model; auto submits `modelPolicy.requirements` to ModelRouter and allows only `fallback = fail`. A no-candidate auto route never continues on the Parent model. ModelRouter chooses model providers only and remains separate from AgentRouter. A Dynamic route created before its Child Run has `runId = null`; after AgentHub creates the child, the adapter binds the decision to that exact Child Run (with separate root/parent IDs) before its first model decision. See `docs/MODEL_ROUTER_FRAMEWORK.md`.

## 2. Identity and persistence boundaries

- `AgentDefinition` is versioned, validated, serializable configuration.
- `AgentTemplate` contains reusable defaults that compile into an `AgentDefinition`.
- `AgentInstance` is an in-memory runtime object created by `AgentFactory`.
- `AgentRegistry` continues to contain runtime adapters only.
- A persistent Definition is not a persistent running process. App restart restores definitions and templates, but restores zero live instances.
- A Dynamic Agent is not an external Agent provider. v2.9.1 supports `runtime.kind = native` only.

The correct runtime boundary is:

```text
persistent AgentDefinition
  -> AgentFactory
  -> ephemeral AgentInstance + Native runtime adapter
  -> AgentRegistry / AgentHub
```

## 3. AgentDefinition contract

The schema version is `1`. Core fields are `id`, `name`, `description`, `role`, `systemPrompt`, `runtime`, `capabilities`, tool/permission/model policy, `lifetime`, budgets, `canDelegate`, tags, and metadata.

`normalizeAgentDefinition()` supplies deterministic defaults and returns a JSON-serializable object. `validateAgentDefinition()` rejects invalid data with `DYNAMIC_AGENT_DEFINITION_INVALID`. Rejected inputs include unknown runtime/lifetime/model modes, malformed policies, functions, cyclic/class instances, and credential-like fields at any nesting level.

Definitions may store a `connectionId`, but never a key, bearer value, cookie, password, refresh/access token, provider object, or runtime adapter.

## 4. Templates and permission ceilings

`compileAgentDefinition(template, overrides, context)` performs deterministic merging. Deny lists are unions; allow lists are restrictive intersections when both layers specify them; read-only is monotonic (`true` cannot become `false`). Optional parent and platform ceilings are applied after template/override merging.

Effective access remains:

```text
Platform policy
  ∩ Parent authorization
  ∩ AgentDefinition policy
```

## 5. Runtime behavior

`AgentFactory` exposes:

- `createInstance(definition, context)`
- `registerInstance(instanceId, hub)`
- `disposeInstance(instanceId)`
- `getInstance(instanceId)`
- `listInstances()`

An instance records definition/template IDs, unique adapter ID, parent/root Run IDs, status, lifetime, timestamps, and its adapter. Lifecycle is:

```text
CREATED -> REGISTERED -> RUNNING
  -> COMPLETED | FAILED | CANCELLED | TIMEOUT
  -> DISPOSED
```

The Dynamic Native adapter uses the existing `runMainAgent -> AgentLoop` runtime, but injects the Definition's role and system prompt into the real model `system` context, installs a filtered `getTool()`, chains a restrictive permission engine to the parent engine, inherits or explicitly resolves the configured model, and maps budgets to existing loop/runtime limits.

Prompt composition is role-specific:

```text
Main Agent    = Runtime Safety Contract + Main Coding Agent Base + Dynamic delegation API guide
Dynamic Agent = Runtime Safety Contract + Dynamic Agent Base + Definition role prompt
```

The Dynamic Agent Base is a generic specialist contract: complete only the assigned child task, respect visible tools and effective permissions, and return a concise result to the Parent. It does not instruct the child to modify code, repair failures, run tests, or own the complete user goal. Those behaviors require an appropriate Definition role and effective policy.

The platform safety contract is always prepended. A Definition prompt cannot replace workspace, permission, tool-policy, truthful-verification, or privilege-escalation rules.

## 6. Dynamic delegate

The existing structured `delegate` action accepts either:

```js
{ preferredAgentId }
{ agentDefinitionId }
{ inlineAgentDefinition }
```

For dynamic targets, `MainAgentOrchestrator` validates/loads the Definition, creates the instance, registers its adapter, and then calls the ordinary `AgentHubBridge -> AgentHub.start` path. It never directly calls the child runtime. The child result is normalized into `AgentResult`, written to the orchestration blackboard, and included in the Main Agent's next model context. A `run`-lifetime instance is disposed and unregistered in `finally`.

## 7. Security boundary

- Read-only policy removes mutation tools from exposure and denies mutation scopes again at execution time.
- Parent permission `deny`/`ask` cannot become child `allow`.
- Existing PathSecurity, ProjectMutationLock, PermissionEngine, delegation depth, fallback no-bypass policy, and Run lifecycle remain in the execution chain.
- `canDelegate` defaults to `false`; a nested delegate action is rejected with `PERMISSION_DENIED`.
- At most eight active Dynamic Agent instances may exist for one root Run. The ninth fails with `DYNAMIC_AGENT_LIMIT_EXCEEDED`.
- Disposal cancels an active child, waits for a bounded interval, clears monitoring timers, disposes its adapter, unregisters it, and removes the instance.

## 8. Persistence and IPC

SQLite tables `agent_definitions` and `agent_templates` store JSON configuration independently from the legacy `agents` table. Definitions support create/get/list/update/delete; templates support create/get/list/delete. Deleting an in-use Definition fails with `AGENT_DEFINITION_IN_USE`.

IPC channels:

```text
dynamicAgent:def:list/create/update/delete
dynamicAgent:template:list/create/delete
dynamicAgent:instance:list/dispose
```

## 9. Deterministic verification

Run `npm run test:dynamic-agent` for all Dynamic tests, or `npm run test:dynamic-agent:production` for the production-stack smoke alone. The latter replaces only the model with a deterministic adapter and uses production MainAgentRuntime, AgentLoop, MainAgentOrchestrator, AgentFactory, Dynamic Native Adapter, AgentHub, RunBridge, Built-in Tool Registry, PermissionEngine, PathSecurity, lifecycle, and tool resolution.

It executes production `read_file` against an isolated TEMP project and proves its content reaches the child model. It also proves the custom marker and Dynamic Base reach model system context without Main Coding Agent identity, mutation and terminal tools are absent, direct mutation is permission-denied, Parent deny cannot be widened, production PathSecurity rejects `../outside.txt`, a Child Run returns a finding, Main Agent consumes the finding on its next iteration, the source hash is unchanged, and Registry/instance/timer counts return to zero.
