# ClineCore Sidecar Runtime

## Architecture

```text
Main Agent / AgentHub
  -> ClineAgentAdapter
  -> ClineSidecarManager
  -> bundled Node.js 22.23.2
  -> sidecars/cline-runtime
  -> @cline/sdk 0.0.72
  -> ClineCore
  -> official read/search/editor/command/web tools
  -> canonical parent-authorized projectRoot
```

The Electron 31 main process uses its bundled Node runtime for the app. It never imports the production Cline SDK. `ClineSidecarManager` launches the separately bundled Node 22 executable with `shell: false`, hidden windows, pipe-only stdio, a canonical project root as `cwd`, and an environment allowlist.

## Runtime ownership and protocol

Protocol 1 is JSONL: stdout contains protocol frames only; ordinary logs are redirected to bounded, redacted stderr. Frames are capped at 2 MiB. Five malformed frames terminate the process; a version mismatch terminates immediately. Required messages are `hello.ok`, `runtime.probe`, `run.start/started/event/result/failed/cancelled/timeout`, `run.cancel`, and `runtime.shutdown/goodbye/error`.

The manager enforces one active run, request/run ID correlation, exactly one terminal result, local timeout intent before cancellation acknowledgement, late-result rejection, crash failure, and next-run restart. Shutdown rejects new work, requests graceful disposal, waits up to five seconds, and then kills the Windows process tree.

## Workspace and permissions

Both parent and sidecar resolve `projectRoot` with `realpath`. The sidecar requires the requested and parent-authorized paths to match exactly. `ClineCore.start()` receives both `cwd` and `workspaceRoot`; the returned `manifest.cwd` and `manifest.workspace_root` are canonicalized and verified again. A mismatch is terminal (`CLINE_WORKSPACE_MISMATCH`). Cline's data directory is the app's `userData/cline`, never the project directory.

The parent permission engine supplies the exact `allowedScopes`. The sidecar intersects those scopes with Cline tool policies:

| Parent scope | Enabled Cline tools |
| --- | --- |
| `filesystem.read` | `read_files`, `search_codebase` |
| `filesystem.write` | `editor`, `apply_patch` |
| `terminal.read` or `terminal.write` | `run_commands` |
| `network` | `fetch_web_content` |
| `mcp` | permits Cline MCP settings tools for that run |

All unspecified tools are disabled. Spawn-agent and agent-team capabilities are disabled in v2.7.3. `ProjectMutationLock` is acquired by AgentHub before a writing child run starts and released on every terminal or start-failure path.

## Credentials and diagnostics

Ambient provider/cloud credentials are removed from the child environment. A selected API connection is decrypted in the main process only when a run starts and only provider/model/key/base URL/headers for that run are sent. Sidecar and adapter clear credential references after terminal cleanup. Protocol output, stderr, events, errors, and provenance are redacted and bounded; no credential is persisted by the platform's Cline adapter.

Health checks do not call an LLM. `HEALTHY` requires the Node runtime, handshake, SDK import, `ClineCore` construction, usable API configuration, and current workspace probe. Missing API/workspace is `DEGRADED`; a missing runtime is `UNAVAILABLE`. Auto routing excludes degraded Cline.

## Reproducible packaging

`runtime-manifest.json` pins Node 22.23.2, its official archive URL and SHA-256, SDK 0.0.72, protocol 1, and the researched Cline commit. `npm run prepare-cline-runtime`:

1. accepts only official `https://nodejs.org/dist/` URLs;
2. validates the cached/downloaded archive against both the pin and official `SHASUMS256.txt`;
3. stages `node.exe` and the Node distribution `LICENSE`;
4. runs the bundled npm with the sidecar lockfile and production-only dependencies;
5. verifies the staged Node version; and
6. atomically publishes `build-runtime/cline-runtime`.

`npm run prepare-cline-runtime -- --offline` or `ADP_OFFLINE=1` reuses validated caches. A missing cache fails with `CLINE_NODE_RUNTIME_MISSING`; it never creates an incomplete successful package. electron-builder copies the staged directory to `resources/cline-runtime`, found only through `process.resourcesPath` in packaged mode.

## Verification and development

- `npm test`: protocol, manager, adapter, permissions, lifecycle, security, crash/restart, cancel/timeout/late-result tests.
- `npm run e2e`: Agent Center readiness states and Cases 44-53, including a real packaged-layout Node 22/ClineCore probe.
- `npm run integration-smoke`: real Node 22 + real SDK + real ClineCore, with a local no-cost OpenAI-compatible fixture driving editor and command tools against `test/fixtures/cline-coding`.
- `npm run dist`: rebuilds/stages the pinned runtime before NSIS and portable packaging.

The fixture verifies ClineCore startup, tools, workspace, protocol, file mutation, test execution, and shutdown without using a paid provider. Real paid-provider LLM execution is deliberately **NOT VERIFIED**.

## Upgrade checklist

Update all pins together, refresh the independent sidecar lockfile, re-check the upstream matrix and RPC decision, compare official event/tool schemas, re-validate resolved manifest fields, update notices, and run unit/E2E/source integration/packaged integration/build gates. Never silently float the SDK or Node version.
