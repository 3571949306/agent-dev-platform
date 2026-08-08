'use strict';
/**
 * Minimal but REAL MCP stdio server used by test/services.test.js.
 * Speaks JSON-RPC 2.0 over NDJSON on stdin/stdout, exactly like a production
 * MCP server would. Supports: initialize, notifications/initialized,
 * tools/list, tools/call (echo + add).
 *
 * Run with `--slow` to never answer `initialize` (used to prove the client
 * times out instead of hanging the app forever).
 */
const SLOW = process.argv.includes('--slow');

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the given text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  }
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (SLOW) return; // deliberately silent
    return ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-echo-server', version: '1.0.0' }
    });
  }
  if (method === 'notifications/initialized') return; // notification, no reply
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'echo') return ok(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
    if (name === 'add') return ok(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
    return fail(id, -32602, 'Unknown tool: ' + name);
  }
  if (id !== undefined) fail(id, -32601, 'Method not found: ' + method);
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
