# External Agent Production Verification (P4)

The verification registry is the single long-lived evidence source for external agents. Evidence is persisted in SQLite with a stable fingerprint and sanitized before storage or IPC.

## Safe Test

Safe Test may perform transport-appropriate detection, version/runtime probing, non-task protocol checks, health checks, and lifecycle cleanup. It dispatches zero external Agent tasks and makes zero platform provider/model/paid calls. It may create only an owned temporary repository and must remove it before returning.

Safe Test can prove installation, detection, implementation, fixture, packaging, or protocol behavior supported by the evidence. It cannot claim that a real model task completed.

## Real Verification

Real Verification is disabled unless the immediate request carries `explicitConsent: true`. The GUI presents a confirmation that identifies possible quota/cost and temporary-project isolation. The backend independently rejects missing consent with model calls = 0 and paid calls = 0.

With consent, the service creates an isolated temporary git repository and dispatches at most one bounded task only through `AgentHub`. A mutating verification requires a successful terminal plus independently observed in-scope file/git effects. WorkBuddy uses a response-only path requiring exact HWND+PID, an owned P3 ComputerSession and a fresh nonce response; that response evidence never proves project mutation. A temporary scope is removed only after Hub confirms quiescence and releases mutation authority; otherwise it stays quarantined for truthful diagnosis. P4's automated release suite never opts in and therefore dispatches no real external Agent task.

Claude Code with externally managed login may remain auth `UNKNOWN`. `UNKNOWN` is not authentication success, but a currently consented real verification may test the already managed session once without reading, exporting or guessing credentials. A real auth error is recorded as `AGENT_AUTH_REQUIRED` or `AGENT_AUTH_FAILED`.

## Evidence levels

From weakest to strongest: `not_verified`, `implementation_verified`, `fixture_verified`, `packaged_verified`, `local_detection_verified`, `real_protocol_verified`, `real_agent_task_verified`.

Installed != Available; Available != Verified; Health != Verification; Protocol Verified != Response Verified; Response Verified != Project Task Verified. Health never promotes a verification level, and detection alone never proves protocol, response or task execution. When an external runtime does not expose usage telemetry, external model and paid-call counts are `UNKNOWN`, not fabricated values.

## Reproducible commands

```text
npm run test:external-verification
npm run test:external-verification:production
npm run test:external-verification:soak
npm run test:external-verification:real
```

The last command prints `REAL_EXTERNAL_AGENT_TESTS=SKIPPED_USER_OPT_IN_REQUIRED` unless `ADP_P4_ALLOW_REAL_AGENT_TASKS=1` is explicitly supplied. That variable gates only the standalone script; the verification service still requires `explicitConsent: true` for each immediate action. Do not set it in automated release verification. The obsolete `RUN_REAL_EXTERNAL_AGENT_TESTS` variable never authorizes a task.
