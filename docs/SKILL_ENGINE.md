# Skill Engine

> Agent Dev Platform v2.9.3

## 1. Identity and boundaries

A Skill is a reusable, declarative Agent capability pack. It is NOT anything else:

```text
Skill != Agent
Skill != Tool
Skill != Workflow
Skill != Hook
```

- Skill cannot grant permission — it only states which permissions must ALREADY be held.
- Skill cannot bypass Tool Policy — `requiredTools` is a requirement, never a grant.
- Skill cannot directly select a Provider — it proposes ModelRequirements that flow into the existing Model Router.
- Skill does not create a fourth runtime — execution always belongs to the Main Run or a Dynamic Child Run; there is no `SkillRun`.

## 2. Pipeline

```text
SkillDefinition
      ↓
SkillRegistry (persistent: skill_definitions table)
      ↓
SkillResolver (deterministic, 0 provider calls)
      ↓
ResolvedSkillSet
      ↓
Runtime Skill Context
      ├─ Prompt Instructions      (R5, below Runtime Safety Contract)
      ├─ Tool Requirements        (R4, requirement only — never grant)
      ├─ Permission Requirements  (R4, must already be held)
      └─ Model Requirements       (R6, strict merge into Model Router)
              ↓
       Existing Main / Dynamic Agent
              ↓
         Existing Model Router
```

## 3. SkillDefinition contract (R1)

```js
{
  schemaVersion: 1,
  id, name, description, instructions,
  tags: [],
  toolRequirements: { required: [], optional: [], denied: [] },
  permissionRequirements: { required: [] },
  modelRequirements: { required: {}, preferences: {}, constraints: {} },
  compatibility: { agentTypes: ["native"], platforms: ["windows"], projectSignals: [] },
  requiresSkills: [],            // optional transitive dependency (cycle → SKILL_DEPENDENCY_CYCLE)
  metadata: {}
}
```

Forbidden fields are rejected with `SKILL_DEFINITION_INVALID`:

```text
apiKey / Authorization / Bearer / Cookie / password / accessToken / refreshToken
Provider / ModelAdapter / AgentAdapter / functions / runtime objects
```

Skill instructions are Skill-level guidance only. They can never override the Runtime Safety Contract, the Main/Dynamic base prompt, the Permission Policy, or the Workspace Boundary.

Tool names accept deterministic alias expansion: `search` → `search_files` + `search_text` + `search_symbols`, `patch_file` → `apply_patch`, `run_command`/`run_tests` → `terminal_run`.

## 4. Registry + persistence (R2)

`SkillRegistry` supports `register / unregister / get / list / enable / disable` (plus `create / update / delete`), persisted in the `skill_definitions` table. Persistent records hold the SkillDefinition only — runtime objects (`activeSkillRuntime`, ModelAdapter, PermissionEngine) are never persisted. A store restart keeps definitions and their enabled state.

Built-in skills (`readonly-code-review`, `test-analysis`, `security-review`) are seeded on first access and immutable (update/delete → `SKILL_BUILTIN`); enable/disable still works.

## 5. Resolver (R3)

```js
resolve({ requestedSkillIds, agentContext, projectContext }) -> ResolvedSkillSet
{
  skills, instructions, requiredTools, optionalTools, deniedTools,
  requiredPermissions, modelRequirements, reasons
}
```

- Deterministic: same input resolved 100× gives identical output; shuffled input still yields the same ordered result.
- Final skill order is always a stable sort by `skillId` (R5).
- Transitive `requiresSkills` are expanded with cycle detection.
- Unknown id → `SKILL_UNKNOWN`; disabled → `SKILL_DISABLED`; both fail closed.
- `resolveModelMerge()` performs the model-requirements-only merge for Main Agent routing (0 provider calls).
- No LLM scanning of the store, no AI-generated Skills, no Skill Marketplace in this release.

## 6. Tool / Permission ceiling (R4 — the core invariant)

A Skill can only REQUIRE capabilities:

```text
final tools = Agent Tool Policy ∩ Platform Tool Availability − Skill deniedTools
```

- required tool outside the agent tool policy / platform → `SKILL_REQUIRED_TOOL_UNAVAILABLE`
- required permission not already held (read-only agent, deny list, allow-list miss, or `PermissionEngine.evaluate() !== 'allow'`) → `SKILL_REQUIRED_PERMISSION_UNAVAILABLE`
- Skill A denies + Skill B requires the same tool → `SKILL_CONFLICT` (fail closed)
- read-only Agent + mutation Skill → fail; never auto-grant `write_file` because the Skill asks for it.

Enforcement points (single system, no second SkillPermissionEngine / SkillPathSecurity / SkillModelAdapter):
- Dynamic agents: skill denied tools are merged into the definition `toolPolicy.deny` at factory time; `DynamicNativeAgentAdapter.getTool` is the only enforcement gate.
- Main Agent: the run wraps `getTool` with the resolved denied set before the loop and the orchestrator.
- PermissionEngine / PathSecurity / ProjectMutationLock / Tool Policy / Model Router remain the only authority.

## 7. Prompt composition (R5)

Layered, fixed order:

```text
Runtime Safety Contract
        ↓
Main / Dynamic Base Prompt
        ↓
Agent Role
        ↓
Resolved Skill Instructions (sorted by skillId, with an explicit cannot-override note)
        ↓
Task Context
```

A Skill can never become the highest system authority. The R5 proof loads `security-review` + `spring-boot` fixtures and asserts `SKILL_SECURITY_MARKER_7319` / `SKILL_SPRING_MARKER_4821` appear in the actual model `system`, in stable order, while the Runtime Safety Contract is still present.

## 8. Model Router integration (R6)

Skill proposes ModelRequirements; the existing Model Router decides.

Merge semantics (strict, order-independent):

| Field | Rule |
| --- | --- |
| required booleans (`text/vision/nativeTools/streaming`) | OR (stricter) |
| `minContextWindow` | max |
| allowed sets (`allowedConnectionIds/Providers/Models`) | intersection |
| denied sets | union |
| `maxInputPrice` / `maxOutputPrice` | min, comparable price basis only, else `SKILL_MODEL_REQUIREMENTS_CONFLICT` |
| `maxLatencyMs` | min |
| preferences | strongest wins; can never loosen hard constraints |

A Skill can never relax an Agent constraint: `Agent denied openai` stays denied even when a Skill prefers openai. The R6 production proof routes a Dynamic Agent with a vision-requiring Skill through the production ModelRouter and proves the wire model equals the selected model.

## 9. Runtime integration (R7)

- Main Agent: `mainAgent:run` accepts `skillIds`; Skill ModelRequirements are merged into routing before the run, and the run itself resolves + validates (fail fast, `SKILL_*` errors terminate the run).
- Dynamic Agent: `AgentDefinition` gains `skills: { required: [], optional: [] }`; `inlineAgentDefinition` may reference the same Skill IDs instead of copying prompts. Required skill resolution failure rejects instance creation; optional failures skip.
- Delegation: `Main Agent → create Dynamic Agent → attach existing Skill → SkillResolver → AgentHub Child`.
- No `SkillRun`: Route Audit stays bound to the existing Main Run / Dynamic Child Run.

## 10. IPC (minimal)

```text
skill:list / skill:get / skill:create / skill:update / skill:delete
skill:enable / skill:disable
skill:resolve            (pure, 0 provider calls)
skill:resolveModelMerge  (pure, 0 provider calls)
```

## 11. Tests

```text
npm run test:skill               # unit: R1-R7 proofs, adversarial x100 determinism
npm run test:skill:production    # R8 production chain: registry → resolver → prompt → router → wire → child result
```

The R8 chain proves: SkillDefinition loaded, instructions observed by the model, Runtime Safety Contract preserved, `write_file` denied and unavailable, permission escalation blocked, vision requirement routed to model B, selected model == provider wire model, child result consumed by the parent, and no independent Skill Run (only parent + hub child + inner child runs exist).

All tests are deterministic with zero paid provider calls.
