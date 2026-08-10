# Cline Runtime Decision

## Decision

v2.7.3 uses a thin, versioned JSONL sidecar around the official `ClineCore` API (option B). It does not reuse Cline's current hub/RPC server as the Electron integration boundary.

The public SDK exposes the stable lifecycle needed by this product: construct a core, start a session, subscribe to events, abort/stop it, inspect its resolved manifest, and dispose it. Cline's repository also contains RPC and desktop sidecar code, but the inspected implementations are coupled to Cline's own hub discovery/session model or to the example application's Bun/Tauri packaging. Treating those internal boundaries as a general public embedding contract would add more Cline application machinery than the platform needs.

## Required ten-question assessment

1. **Is RPC part of the public SDK?** RPC types/helpers are present in the monorepo, but the complete app-level runtime boundary is not documented as the supported generic embedding API.
2. **Is it stable?** Not sufficiently for this product boundary; the documented `ClineCore` API is the smaller stable surface.
3. **Can it start independently?** Cline's hub/runtime pieces can run, but expect Cline-specific discovery, storage, and session infrastructure.
4. **Does it support ClineCore?** Yes, internally, but indirectly through Cline's runtime host.
5. **Does it support sessions?** Yes.
6. **Does it stream events?** Yes.
7. **Does it abort?** Yes.
8. **Does it support cwd/workspace?** Yes, through session configuration and resolved manifests.
9. **Does it depend on Bun?** The inspected desktop example build does; the published SDK itself runs on Node 22+.
10. **Is it a good Electron-host boundary?** Not currently. A small Node sidecar using the public `ClineCore` lifecycle is easier to pin, package, audit, and upgrade.

## Consequences

- Production uses real `@cline/sdk` and real `ClineCore`; it does not recreate a Cline-like agent.
- The custom protocol carries only lifecycle commands, normalized events, bounded errors, and results. It is not a replacement for Cline's internal session protocol.
- Protocol version 1 and SDK 0.0.72 are explicit compatibility pins.
- The old in-process `sdkBridge` remains only for legacy injected tests. It is not a production fallback.
- An SDK or upstream upgrade requires reviewing `UPSTREAM_REFERENCE_MATRIX.md`, event mappings, tool names/policies, manifest fields, and integration fixtures.
