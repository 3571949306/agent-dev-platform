'use strict';
/**
 * Minimal static file server for the renderer. Bound to 127.0.0.1 only.
 * No sensitive API is exposed over HTTP — all logic goes through IPC.
 */
const express = require('express');
const path = require('path');

// The renderer must never be able to pull remote code. Scripts are 'self'
// only (no inline, no eval); inline styles are allowed because list/tree
// rendering injects style attributes; data:/blob: images are needed for
// screenshots coming back from the browser & computer runtimes.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function start(preferredPort) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  return new Promise((resolve, reject) => {
    const srv = app.listen(preferredPort || 0, '127.0.0.1', () => {
      resolve({ server: srv, port: srv.address().port });
    });
    srv.on('error', reject);
  });
}

module.exports = { start };
