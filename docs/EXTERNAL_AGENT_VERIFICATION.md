# External Agent Production Verification (P4)

The verification registry is the single long-lived evidence source for external agents. Evidence is persisted in SQLite with a stable fingerprint and sanitized before storage or IPC.

## Safe Test

Safe Test may perform executable detection, version probing, local protocol/fixture handshakes, health checks, and lifecycle cleanup. It must make zero model calls and zero paid-provider calls. It may create only an owned temporary git repository and must remove it before returning.

Safe Test can prove installation, detection, implementation, fixture, packaging, or protocol behavior supported by the evidence. It cannot claim that a real model task completed.

## Real Verification

Real Verification is disabled unless the immediate request carries `explicitConsent: true`. The GUI presents a confirmation that identifies possible quota/cost and temporary-project isolation. The backend independently rejects missing consent with model calls = 0 and paid calls = 0.

With consent, the service creates an isolated temporary git repository, dispatches one bounded task only through `AgentHub`, requires a successful terminal result plus independently observed file/git effects, waits for cleanup, stores sanitized evidence, and removes the repository. A claimed success without an observed effect is a failed verification. P4's automated release suite never opts in and therefore makes no real model call.

## Evidence levels

From weakest to strongest: `not_verified`, `implementation_verified`, `fixture_verified`, `packaged_verified`, `local_detection_verified`, `real_protocol_verified`, `real_agent_task_verified`.

Installed != Available != Verified. Protocol Verified != Real Task Verified. Health never promotes a verification level, and detection alone never proves protocol or task execution.

## Reproducible commands

```text
npm run test:external-verification
npm run test:external-verification:production
npm run test:external-verification:soak
npm run test:external-verification:real
```

The last command prints `REAL_EXTERNAL_AGENT_TESTS=SKIPPED_USER_OPT_IN_REQUIRED` unless `RUN_REAL_EXTERNAL_AGENT_TESTS=1` is explicitly supplied. Do not set that variable in automated release verification.
