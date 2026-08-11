# AI Generator Framework

The AI Generator Framework turns a bounded natural-language request into a previewable configuration draft for one of four existing platform artifacts:

- Dynamic Native Agent Definition
- Skill Definition
- Hook Definition
- Workflow Definition

It is deliberately not an Agent, Tool, Workflow runtime, permission system, provider, or model router. Its only output is configuration understood by the existing platform.

## Non-negotiable boundaries

```text
Generated != Validated.
Validated != Saved.
Saved != Executed.

AI may generate configuration.
AI may never generate authority.
```

Generation never starts an Agent, runs a Workflow, executes a Tool, grants a permission, creates a trusted Hook handler, or saves/enables a definition. The generator model receives no tools.

## Pipeline

```text
GeneratorRequest
  -> input bounds and secret gate
  -> GeneratorArtifactAdapterRegistry
  -> secret-free GeneratorCapabilityContext
  -> existing RuntimeModelResolver / ModelRouter
  -> existing ProviderModelAdapter
  -> exact JSON.parse
  -> existing Definition normalizer/validator
  -> reference and authority validation
  -> bounded repair (maximum two repairs)
  -> GeneratorDraft READY
  -> explicit generator:save
  -> complete revalidation
  -> existing Registry, disabled/not running
```

The initial call plus repairs can make at most three provider calls. Per-call timeout is 120 seconds and total generation timeout is 300 seconds. Cancellation aborts the provider request and a late response cannot revive a terminal draft.

## Request contract

`GeneratorRequest` is a strict `schemaVersion: 1` object with `artifactType`, `intent`, `mode`, optional explicit `connectionId`/`modelId`, and optional public `projectSummary`. Unknown fields are rejected. Intent is bounded to 12,000 characters and project summary to 16,000 characters.

Credential-shaped input is rejected before model routing or provider construction with `GENERATOR_INPUT_SECRET_DETECTED`. This includes API keys, Bearer/Authorization values, cookies, private keys, access/refresh tokens, and password-like credentials.

## Artifact adapters and source of truth

The adapter registry exposes the same interface for Agent, Skill, Hook, and Workflow artifacts. Each adapter delegates final structural judgment to the existing normalizer/validator:

- `normalizeAgentDefinition`
- `normalizeSkillDefinition`
- `normalizeHookDefinition`
- `normalizeWorkflowDefinition`

The generation contract is concise guidance derived from existing defaults and enums; it is not a competing schema. A candidate is never READY unless the real validator accepts it.

Generator authority validation additionally rejects credential, provider, adapter, permission-engine, permission-bypass, executable callback, JavaScript, and webhook fields. Hook generation may only reference an already registered trusted `handlerId`. Workflow generation remains limited to agent, tool, condition, and approval steps supported by the real Workflow validator.

## Capability and reference context

The model sees a canonical, sorted, secret-free catalog containing public tool names/permission labels, enabled state for Skills and Hooks, trusted handler IDs, public Agent identity/capabilities, and public Model identity/capability flags.

It never receives provider objects, model adapters, tool implementations, permission engines, API keys, custom-header values, database rows, or file contents. References to missing or disabled platform resources fail closed with `GENERATOR_REFERENCE_UNAVAILABLE` or `GENERATOR_REFERENCE_DISABLED`.

## Model routing and structured output

Auto mode asks the existing Model Router for text capability with balanced cost/latency preferences. Explicit mode uses the existing router's exact connection/model semantics; a missing explicit model fails without fallback.

The existing `ProviderModelAdapter.decide({ system, context, iteration, abortSignal })` is the only model wire. The system instruction requires exactly one JSON object and configuration-only behavior. Markdown fences, prose, multiple objects, arrays, and malformed JSON produce `GENERATOR_OUTPUT_INVALID_JSON` and may enter bounded repair.

## Draft and save lifecycle

```text
GENERATING -> VALIDATING -> REPAIRING? -> READY -> explicit SAVE -> SAVED
                                      \-> FAILED
GENERATING/VALIDATING/REPAIRING -> CANCELLED
READY/FAILED/CANCELLED -> DISCARDED
```

Drafts persist candidate JSON, validation state, selected model IDs, route decision ID, attempt counts, errors, and timestamps. They do not persist raw intent, prompts, provider responses/objects, model adapters, abort controllers, permission engines, or tool implementations.

`generator:validate` makes zero provider calls. `generator:save` also makes zero provider calls and repeats normalization, definition validation, and reference validation against current resources. This prevents READY drafts from bypassing resource deletion/disablement between generation and save. Existing IDs fail with `GENERATOR_TARGET_EXISTS`; nothing is overwritten.

Saved Skills, Hooks, and Workflows are disabled. Saved Agent definitions do not create an Agent instance or Run. Saved Workflows are never executed automatically.

## IPC and GUI

The minimal IPC surface is:

```text
generator:generate
generator:getDraft
generator:listDrafts
generator:validate
generator:save
generator:discard
generator:cancel
```

The AI Generator page supports artifact type, natural-language requirement, automatic or explicit existing model selection, draft JSON/validation/model/repair preview, Save, Discard, Regenerate, and Cancel.

## Audit and verification

Generator audit records IDs, artifact/status, attempt/repair counts, route/model IDs, validation codes, saved artifact ID, duration, and only the SHA-256 hash plus length of user intent. Raw intent, prompts, responses, generated instructions, credentials, and runtime objects are excluded.

Run the deterministic suites with:

```text
npm run test:generator
npm run test:generator:production
```

The production suite uses the real SQLite Store, all four real definition validators/registries, ModelCatalog, ModelRouter, RuntimeModelResolver, and ProviderModelAdapter with a fake network provider. It proves `generator-model-B` is both selected and placed on the wire, while Agent Runs, Workflow executions, Tool executions, permission grants, paid calls, and secret-input provider calls remain zero.
