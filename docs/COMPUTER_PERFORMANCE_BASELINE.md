# Computer Use — Performance Baseline (P3 Production Hardening)

Measured on the real production matrix (`npm run test:computer-hardening:production`)
against the test-only WPF fixture (`test/fixtures/computerFixture.ps1`), on the
development workstation (Windows, PowerShell 5.1 helpers, DPI > 100%).

These are RECORDED measurements from an actual run — not targets, not estimates.
Every Computer helper call spawns a fresh `powershell.exe` and re-runs
`Add-Type`, so the dominant cost is process + type compilation, not the desktop
operation itself. Values will vary by machine load (the desktop is shared with
the user during these tests); treat the numbers as an order-of-magnitude baseline.

## Operation latency (median of the passing production run)

| Operation                              | Latency (ms) | Notes |
| -------------------------------------- | -----------: | ----- |
| Window discovery (EnumWindows → WindowRef) | ~1600   | one helper process; returns all visible top-level windows |
| Verified focus (SetForegroundWindow + GetForegroundWindow poll) | ~540 | Alt-trick only when not already foreground |
| Observation (validate + true UIA tree, no screenshot) | ~2900 | TreeWalker traversal, bounded depth 6 / 1000 nodes |
| Observation + window screenshot (PrintWindow) | ~2900 | screenshot captured in the same observation path |
| Semantic invoke (UIA InvokePattern)    | ~1000        | re-resolves element by path + RuntimeId |
| Vision grounding (Model Router round-trip) | model-bound | fake-provider round-trip in tests measured ~2 ms; a real provider adds its own network/model latency |

## Cancellation / quiescence

| Metric | Value | Notes |
| ------ | ----: | ----- |
| cancel → helper settled (`taskkill /T /F` + confirmed exit) | ~260 ms | 30 s `Start-Sleep` helper cancelled; never runs to term |
| settled → registry quiesced | ~0 ms | registry only shrinks on CONFIRMED exit |
| nested (grandchild) residue after cancel | 0 / 20 | soak cancel race |

## Repetition gates observed

| Gate | Result |
| ---- | ------ |
| Computer Production core cycle | 10/10 |
| Computer Cancel Race | 20/20 |
| Computer Interaction Lock (contention) | 20/20 |
| Soak fixture action cycles | 100/100 |
| Soak focus-theft fence | 20/20 (violations = 0) |
| Soak stale-move fence | 20/20 (violations = 0) |

## Known cost drivers / optimization headroom

- Each helper recompiles its `Add-Type` payloads (~0.5–1.5 s). A persistent
  helper process with cached compiled types would cut most of this, at the cost
  of a long-lived child that must itself be cancellable — deliberately deferred
  (correctness over speed for P3).
- Observations skip the screenshot (`screenshot: false`) when only the UIA tree
  is needed, saving one PrintWindow round-trip.
- Read-only operations (list windows / UI tree / screenshot) deliberately do not
  take the DesktopInteractionLock; only mutations serialize.

_Last measured: P3 Computer Use Production Hardening build (version 2.9.9)._
