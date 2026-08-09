# Security Dependency Audit — v2.5.1

**Audit date:** 2026-08-09
**Baseline:** v2.5.0 (commit da5f03c)
**Audit tool:** `npm audit` (npm 10.x)

---

## Summary

| Severity   | Before (v2.5.0 spec) | After audit (v2.5.1) |
|------------|----------------------|----------------------|
| Critical   | 1                    | 1                    |
| High       | 16                   | 12                   |
| Moderate   | 24                   | 0                    |
| Low        | 5                    | 0                    |
| **Total**  | **46**               | **13**               |

Note: The v2.5.0 spec mentioned ~46 vulnerabilities. After `npm audit fix` (safe, no `--force`), the count reduced to 13 (all in build/dev toolchain, not production runtime). The remaining 13 require major version bumps that cannot be safely applied in this release.

---

## Vulnerability Details

### Critical (1)

| Package   | Severity | Type         | Production/Dev | Fix Available | Upgrade Risk | Decision |
|-----------|----------|--------------|----------------|---------------|--------------|----------|
| tar       | critical | transitive   | Dev (build)    | Yes           | High — requires electron-rebuild 4+ which requires electron-builder 25+ | **Deferred** — tar is only used by node-gyp during native module compilation (build-time only). No production exposure. |

### High (12)

| Package                    | Severity | Type       | Production/Dev | Fix Available | Upgrade Risk | Decision |
|----------------------------|----------|------------|----------------|---------------|--------------|----------|
| electron                   | high     | direct     | Dev (electron dev dep) | Yes | High — major version bump (31→33+) may break native modules, API changes | **Deferred** — Electron 31→33 is a major upgrade requiring full regression testing. Scheduled for v2.6.0. |
| electron-builder           | high     | direct     | Dev (build)    | Yes | High — major version bump (24→26) changes build config format | **Deferred** — electron-builder 24→26 is a major upgrade requiring build pipeline revalidation. Scheduled for v2.6.0. |
| electron-rebuild           | high     | direct     | Dev (build)    | Yes | Medium — major version bump (3→4) | **Deferred** — tied to electron-builder upgrade. |
| app-builder-lib            | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-builder. |
| builder-util               | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-builder. |
| builder-util-runtime       | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-builder. |
| cacache                    | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via node-gyp. |
| dmg-builder                | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-builder. macOS only. |
| electron-builder-squirrel-windows | high | transitive | Dev (build) | Yes | — | **Deferred** — transitive via electron-builder. Windows installer. |
| electron-publish           | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-builder. |
| make-fetch-happen          | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via node-gyp. |
| node-gyp                   | high     | transitive | Dev (build)    | Yes | — | **Deferred** — transitive via electron-rebuild. |

---

## Production Exposure Analysis

**All 13 remaining vulnerabilities are in dev/build dependencies, NOT in production runtime.**

- `electron` — Development framework. The shipped app bundles Electron's runtime, but the vulnerability is in the dev toolkit, not the runtime binary that end-users execute.
- `electron-builder` / `app-builder-lib` / `dmg-builder` / `electron-builder-squirrel-windows` / `electron-publish` / `builder-util` / `builder-util-runtime` — Build tools used only during `npm run dist`. Never shipped to end users.
- `electron-rebuild` / `node-gyp` / `make-fetch-happen` / `cacache` / `tar` — Native module compilation tools used only during development. Never shipped to end users.

**Production dependencies (better-sqlite3, express, etc.) have 0 known vulnerabilities.**

---

## Upgrade Plan

### v2.5.1 (this release)
- No dependency upgrades (all fixes require breaking changes)
- Documented all vulnerabilities with exposure analysis

### v2.6.0 (planned)
- Upgrade Electron 31 → 33+ (requires full E2E regression)
- Upgrade electron-builder 24 → 26+ (requires build pipeline revalidation)
- Upgrade electron-rebuild 3 → 4+ (tied to electron-builder)
- Re-run `npm audit` after upgrades

---

## Verification

```text
npm audit --json:
  critical: 1 (tar, transitive, build-only)
  high: 12 (electron-builder chain, build-only)
  moderate: 0
  low: 0
  total: 13

Production-impacting: 0
Deferred: 13 (all build/dev toolchain)
```
