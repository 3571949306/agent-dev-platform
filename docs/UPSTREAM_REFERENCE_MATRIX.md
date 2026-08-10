# Upstream Reference Matrix

This matrix pins the sources used for the v2.7.3 Cline integration. The implementation must be re-audited when any pin changes.

| Project | Version / commit | Files and documentation inspected | API or design used | License | Our implementation |
| --- | --- | --- | --- | --- | --- |
| Cline | `@cline/sdk 0.0.72`; commit `b3cee3f973ffe9d023a10c5c414deba68cd6e09d` | `sdk/README.md`, `sdk/ARCHITECTURE.md`, `sdk/packages/core/src/ClineCore.ts`, `sdk/packages/core/src/types/config.ts`, `sdk/packages/shared/src/rpc/runtime.ts`, `apps/cli/src/runtime/run-agent.ts`, `apps/cli/src/runtime/session-events.ts`, `apps/cli/src/runtime/tool-policies.ts`, `apps/examples/cline-core-cli-agent/src/index.ts`, `apps/examples/desktop-app/sidecar/index.ts`, `apps/examples/desktop-app/sidecar/ARCHITECTURE.md`, and the official SDK reference/event pages | `ClineCore.create`, `start`, `subscribe`, `abort`, `stop`, `dispose`, session manifest workspace fields, tool policies, event envelopes, and lifecycle ownership | Apache-2.0 | An independent Node 22 sidecar invokes the published SDK. The Electron main process never imports the production SDK. |
| Node.js | `22.23.2`, Windows x64 archive; release tag `v22.23.2` | Node 22 archive, `SHASUMS256.txt`, child process documentation, distribution `LICENSE` | Pinned runtime, `spawn` with pipes, canonical `cwd`, environment allowlist, shutdown and process-tree fallback | Node.js license plus bundled third-party notices | `prepare-cline-runtime.js` downloads only from `nodejs.org`, checks the pinned and official checksum, and stages `node.exe` plus `LICENSE`. |
| Electron | `31.7.7` | `app` lifecycle and `process.resourcesPath` documentation | `before-quit`, packaged resource discovery | MIT | Main-process lifecycle awaits sidecar disposal; packaged lookup uses `process.resourcesPath`. |
| electron-builder | `24.13.3` | Application Contents and Configuration documentation | `extraResources` | MIT | Stages the complete runtime at `resources/cline-runtime/`. |

## Source URLs

- Cline repository: https://github.com/cline/cline
- Cline SDK overview: https://docs.cline.bot/sdk/overview
- ClineCore reference: https://docs.cline.bot/sdk/clinecore
- Agent reference: https://docs.cline.bot/sdk/reference/agent
- Cline events: https://docs.cline.bot/sdk/events
- Node 22 archive: https://nodejs.org/en/download/archive/v22
- Node child processes: https://nodejs.org/api/child_process.html
- Electron app lifecycle: https://www.electronjs.org/docs/latest/api/app
- electron-builder contents: https://www.electron.build/docs/contents/

The `.research/cline-upstream` checkout is intentionally ignored and is not distributed.
