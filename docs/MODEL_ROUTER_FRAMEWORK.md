# Model Router Framework

> Agent Dev Platform v2.9.2

## Scope and boundaries

The Model Router chooses a configured model provider connection and model for a Native Agent. It does not choose which Agent executes a task:

```text
AgentRouter -> Agent/provider choice
ModelRouter -> model connection/model choice for that Native Agent
```

`ModelSelection` is public routing evidence, not a runtime adapter. Selected IDs become an Agent-like configuration for the existing `createProviderModelAdapter()`; only the existing `buildProvider()` boundary may decrypt credentials.

## Routing pipeline

```text
Main or Dynamic Agent
  -> ModelRequirements v1
  -> ModelCatalog (existing Connections, Models, probe evidence)
  -> hard constraint filter
  -> deterministic metadata scoring
  -> explainable ModelSelection
  -> RuntimeModelResolver
  -> existing ProviderModelAdapter
  -> provider wire
  -> route outcome audit
```

The router never performs a capability probe and never fetches prices. Diagnostics and Model Center remain responsible for metadata updates.

## Requirements and evidence

`ModelRequirements` separates `required`, `preferences`, and `constraints`. Required capabilities and numeric limits are hard gates; preferences affect score only after filtering.

Evidence states retain their meaning: `tested > declared > inferred > unknown`. Only `tested true` or `declared true` satisfies a hard capability. Unknown is not supported, and inferred is not tested. A context, price, or latency hard limit rejects an unknown metric.

The catalog reads existing public connection/model metadata. Model names never imply price, speed, context, or quality. Presence in the configured model catalog declares a text model; optional vision, tools, streaming, context, price, and latency retain stored evidence or remain unknown.

## Filtering, scoring, and explicit selection

Filtering explains every rejection with stable codes such as `VISION_REQUIRED_NOT_PROVEN`, `CONTEXT_WINDOW_UNKNOWN`, `PRICE_UNKNOWN_FOR_HARD_LIMIT`, `CONNECTION_DISABLED`, and `MODEL_DENIED`.

Explicit selection requires an exact `connectionId + modelId`. Missing or hard-invalid explicit candidates fail closed and never use another model. Auto mode throws `MODEL_ROUTE_NO_CANDIDATE` when no candidate survives.

Scoring uses only candidate metadata: evidence strength, measured latency, supplied pricing, locality, and explicit provider/model preferences. Unknown cost or latency receives a small penalty and is never treated as free or fastest. Ties use score descending, then provider, connection ID, and model ID ascending. Input order, time, and randomness do not affect the winner.

## Runtime integration

`resolveRuntimeModel()` is the shared Main/Dynamic Native entry:

- `inherit_parent` returns the exact Parent ModelAdapter without invoking ModelRouter.
- `explicit` routes only the exact configured candidate.
- `auto` selects through ModelRouter, then creates the existing ProviderModelAdapter from selected IDs.

Dynamic `modelPolicy` supports all three modes; auto fallback is fail-only. A no-candidate result never falls back to the Parent.

For Main Agent, a manual Connection + Model binding always remains explicit. Auto is used only for an unbound Main Agent with `modelRoutingMode = auto` directly or in `workspace`. Legacy connection-only records retain the pre-v2.9.2 ProviderModelAdapter fallback path.

## Explainability and audit

Each selection contains public identity, normalized requirements, score and breakdown, selection reasons, rejected candidates and reasons, mode, and route time. `model_route_decisions` persists that data plus nullable outcome status, latency, token counts, and error code. No-candidate failures also record requirements and rejection evidence.

Candidates, selections, logs, and route decisions exclude decrypted connections, credentials, provider objects, and ModelAdapter objects. Outcome records do not estimate missing token data.

## Verification

Run `npm run test:model-router` for the fast contract/adversarial suite and `npm run test:model-router:production` for the deterministic production smoke.

The production smoke uses a TEMP SQLite Store, production ModelCatalog/ModelRouter/AgentFactory/ProviderModelAdapter, and only a fake network provider. It proves Dynamic auto selects B, provider wire receives B, the child completes, the outcome is audited, and failed auto routing cannot continue on a Parent model. Paid provider calls are zero.
