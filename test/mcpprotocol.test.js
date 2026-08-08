'use strict';
/**
 * v2.1.0 — MCP protocol version negotiation / rejection tests.
 *
 * v2.0.0 sent a protocolVersion to the server and then ignored whatever came
 * back, so a server answering with an incompatible revision looked exactly like
 * a healthy one. These tests pin the new contract:
 *   - checkProtocol() classifies every server version correctly (unit)
 *   - a supported version connects AND the negotiated version is recorded
 *   - an UNSUPPORTED version makes connect() THROW (never silently succeed)
 *   - negotiation to a higher revision is allowed and the mismatch is warned
 *
 * Hits the REAL McpClient/McpManager against real stdio JSON-RPC fixtures.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { McpClient, McpManager, checkProtocol, PROTOCOL_VERSION, SUPPORTED_PROTOCOLS } =
  require('../src/services/mcp');

const ECHO = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
const BAD = path.join(__dirname, 'fixtures', 'mcp-bad-version-server.js');
// Under ELECTRON_RUN_AS_NODE=1 execPath is electron.exe behaving as node, and the
// child inherits that env, so it is a valid node runner either way.
const NODE_BIN = process.execPath;

/* ----------------------------------------------------------- checkProtocol */

test('checkProtocol: 首选版本 2024-11-05 通过且无需协商', () => {
  const r = checkProtocol('2024-11-05');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.negotiated, '2024-11-05');
  assert.strictEqual(r.warning, undefined, '完全匹配不应有 warning');
});

test('checkProtocol: 已知更高版本 2025-03-26 / 2025-06-18 通过但带协商 warning', () => {
  for (const v of ['2025-03-26', '2025-06-18']) {
    const r = checkProtocol(v);
    assert.strictEqual(r.ok, true, v + ' 应被接受');
    assert.strictEqual(r.negotiated, v);
    assert.ok(r.warning && r.warning.includes(v), '应说明按服务端版本继续');
    assert.ok(r.warning.includes(PROTOCOL_VERSION), 'warning 应提到本机首选版本');
  }
});

test('checkProtocol: 不支持的版本 1999-01-01 被拒绝', () => {
  const bad = '1999-01-01';
  const r = checkProtocol(bad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.negotiated, bad);
  assert.ok(r.warning.includes(bad), 'warning 必须点名不支持的版本');
  assert.ok(SUPPORTED_PROTOCOLS.every(v => r.warning.includes(v)), 'warning 应列出本机支持版本');
});

test('checkProtocol: 服务端未回报 protocolVersion 时按首选版本处理', () => {
  const r = checkProtocol(null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.negotiated, PROTOCOL_VERSION);
  assert.ok(r.warning && r.warning.includes(PROTOCOL_VERSION), '应提示按首选版本兜底');
});

test('导出：SUPPORTED_PROTOCOLS 含首选版本且 checkProtocol 是其判断依据', () => {
  assert.ok(Array.isArray(SUPPORTED_PROTOCOLS) && SUPPORTED_PROTOCOLS.length >= 3);
  assert.ok(SUPPORTED_PROTOCOLS.includes(PROTOCOL_VERSION));
  // 一个完全陌生的版本必须不在支持列表里，否则上面的拒绝测试无意义
  assert.ok(!SUPPORTED_PROTOCOLS.includes('1999-01-01'));
});

/* ----------------------------------------------------------- 集成：握手协商 */

test('MCP: 真实 echo 服务器(2024-11-05)连接后记录协商版本', async () => {
  const client = new McpClient({ id: 'proto-ok', transport: 'stdio', command: NODE_BIN, args: [ECHO], timeoutMs: 15000 });
  const tools = await client.connect();
  assert.strictEqual(client.connected, true);
  assert.strictEqual(client.protocolVersion, '2024-11-05', '应记录服务端回报的协议版本');
  assert.strictEqual(client.protocolWarning, null, '版本精确匹配不应有 warning');
  assert.ok(Array.isArray(tools) && tools.length >= 1, '工具仍应被发现');
  client.disconnect();
});

test('MCP: 协商到更高版本(2025-03-26)时允许连接并记录 warning', async () => {
  const client = new McpClient({
    id: 'proto-high', transport: 'stdio', command: NODE_BIN,
    args: [BAD], timeoutMs: 15000, env: { ...process.env, MCP_PROTOCOL: '2025-03-26' }
  });
  const tools = await client.connect();
  assert.strictEqual(client.connected, true);
  assert.strictEqual(client.protocolVersion, '2025-03-26', '应记录实际协商到的版本');
  assert.ok(client.protocolWarning && client.protocolWarning.includes('2025-03-26'), '应警告已按服务端版本继续');
  assert.ok(Array.isArray(tools), '高版本服务器工具仍应被发现');
  client.disconnect();
});

test('MCP: 不支持的协议版本(1999-01-01)连接时直接抛错，绝不静默成功', async () => {
  const mgr = new McpManager();
  await assert.rejects(
    () => mgr.connect({ id: 'proto-bad', transport: 'stdio', command: NODE_BIN, args: [BAD], timeoutMs: 15000 }),
    (e) => {
      assert.ok(/不支持的 MCP 协议版本/.test(e.message), '错误应点明协议不支持');
      assert.ok(e.message.includes('1999-01-01'), '错误应包含具体版本号');
      return true;
    }
  );
  assert.strictEqual(mgr.get('proto-bad'), undefined, '失败的连接绝不能被登记到管理器');
});
