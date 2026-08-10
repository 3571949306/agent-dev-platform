# ClineCore sidecar runtime

This package is the Node 22 execution boundary for Agent Dev Platform's Cline
integration. It owns the exact `@cline/sdk` dependency and exposes a small,
versioned JSONL protocol over stdio. The Electron main process never imports the
SDK directly.

`stdout` is reserved for protocol frames. Operational diagnostics go to
`stderr` after secret redaction. Only one coding run is accepted at a time.

The production runtime is staged by `scripts/prepare-cline-runtime.js`; neither
the downloaded Node binary nor installed dependencies are committed to Git.
