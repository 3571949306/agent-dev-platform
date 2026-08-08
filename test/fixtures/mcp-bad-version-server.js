'use strict';
/**
 * MCP stdio server used by test/mcpprotocol.test.js.
 * Identical to mcp-echo-server.js except it reports a *configurable*
 * protocolVersion (default an unsupported one) so we can exercise the
 * client's version negotiation / rejection path without touching the
 * happy-path fixture that the other suites depend on.
 *
 * Set MCP_PROTOCOL to control what initialize reports, e.g.
 *   MCP_PROTOCOL=2025-03-26 node mcp-bad-version-server.js   -> negotiated
 *   MCP_PROTOCOL=1999-01-01  node mcp-bad-version-server.js   -> rejected
 */
const VERSION = process.env.MCP_PROTOCOL || '1999-01-01';

const TOOLS = [
  { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-bad-version-server', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const text = String((params && params.arguments && params.arguments.text) || '');
    return ok(id, { content: [{ type: 'text', text }] });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    try { handle(JSON.parse(t)); } catch { /* ignore malformed frame */ }
  }
});
process.stdin.on('end', () => process.exit(0));
