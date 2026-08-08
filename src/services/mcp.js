'use strict';
/**
 * MCP (Model Context Protocol) client.
 * Implements the official JSON-RPC 2.0 protocol over stdio (NDJSON) and HTTP.
 * Tools discovered on connect are exposed to the Agent Runtime like built-ins.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Revisions we know how to speak. v2.0.0 sent a version and then ignored
 * whatever came back, so a server answering with an incompatible revision looked
 * exactly like a healthy one — right up until tools/call started failing in ways
 * nobody could explain.
 */
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

/**
 * @returns {{ok:boolean, negotiated:string, warning?:string}}
 */
function checkProtocol(serverVersion) {
  if (!serverVersion) {
    return { ok: true, negotiated: PROTOCOL_VERSION, warning: '服务端未回报 protocolVersion，按 ' + PROTOCOL_VERSION + ' 处理' };
  }
  if (serverVersion === PROTOCOL_VERSION) return { ok: true, negotiated: serverVersion };
  if (SUPPORTED_PROTOCOLS.includes(serverVersion)) {
    return { ok: true, negotiated: serverVersion, warning: `服务端使用 MCP ${serverVersion}（本机首选 ${PROTOCOL_VERSION}），已按服务端版本继续` };
  }
  return {
    ok: false,
    negotiated: serverVersion,
    warning: `不支持的 MCP 协议版本 ${serverVersion}（本机支持 ${SUPPORTED_PROTOCOLS.join(' / ')}）`
  };
}

class McpClient {
  constructor(server) {
    this.server = server;
    this.timeoutMs = Number(server.timeoutMs) > 0 ? Number(server.timeoutMs) : 20000;
    this.idCounter = 1;
    this.pending = new Map();
    this.tools = [];
    this.proc = null;
    this.buf = '';
    this.onMessage = null;
  }
  nextId() { return this.idCounter++; }
  call(method, params, isNotification = false, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const msg = { jsonrpc: '2.0', method, params: params || {} };
      if (!isNotification) {
        msg.id = this.nextId();
        // A server that never answers must not hang the caller forever —
        // initServices() awaits this at boot, so a stuck handshake would
        // mean the app never opens a window.
        const timer = setTimeout(() => {
          if (this.pending.delete(msg.id)) reject(new Error(`MCP 请求超时（${method}，${timeoutMs}ms）`));
        }, timeoutMs);
        this.pending.set(msg.id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); }
        });
      }
      try { this._send(msg); }
      catch (e) { if (msg.id) this.pending.delete(msg.id); return reject(e); }
      if (isNotification) resolve();
    });
  }
  _failAllPending(err) {
    for (const [, p] of this.pending) { try { p.reject(err); } catch {} }
    this.pending.clear();
  }
  async connect() {
    if (this.server.transport === 'stdio') {
      const args = Array.isArray(this.server.args) ? this.server.args : [];
      this.proc = spawn(this.server.command, args, { env: { ...process.env, ...(this.server.env || {}) }, windowsHide: true });
      this.proc.stdout.on('data', d => this._onData(d.toString()));
      this.proc.stderr.on('data', d => { this.lastStderr = (this.lastStderr || '') + d.toString().slice(0, 2000); });
      // Without this listener an ENOENT (bad command) is an *unhandled*
      // 'error' event, which kills the whole Electron main process.
      this.proc.on('error', (e) => {
        this.connected = false;
        this._failAllPending(new Error(`MCP 进程启动失败: ${e.message}`));
      });
      this.proc.on('exit', (code) => {
        this.connected = false;
        this._failAllPending(new Error(`MCP 进程已退出（code ${code}）${this.lastStderr ? ': ' + this.lastStderr.slice(0, 200) : ''}`));
      });
    } else {
      this.baseUrl = this.server.url;
    }
    const init = await this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'Agent-Dev-Platform', version: '2.1.0' }
    });

    // Protocol negotiation — refuse loudly rather than half-work silently.
    const reported = init && init.result ? init.result.protocolVersion : null;
    const check = checkProtocol(reported);
    this.protocolVersion = check.negotiated;
    this.protocolWarning = check.warning || null;
    this.serverInfo = (init && init.result && init.result.serverInfo) || null;
    if (!check.ok) {
      try { this.proc?.kill(); } catch { /* nothing to kill on http */ }
      this.connected = false;
      throw new Error(check.warning);
    }

    await this.call('notifications/initialized', {}, true);
    this.connected = true;
    this.serverCapabilities = (init && init.result && init.result.capabilities) || {};
    if (init && init.result && init.result.capabilities && init.result.capabilities.tools !== undefined) {
      const list = await this.call('tools/list', {});
      this.tools = (list.result?.tools || []).map(t => ({
        name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} }
      }));
    }
    return this.tools;
  }
  async callTool(name, args) {
    const r = await this.call('tools/call', { name, arguments: args || {} });
    const content = r.result?.content;
    if (Array.isArray(content)) return content.map(c => c.text ?? JSON.stringify(c)).join('\n');
    return JSON.stringify(r.result || {});
  }
  _send(msg) {
    if (this.server.transport === 'stdio' && this.proc) {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } else {
      // HTTP: POST JSON-RPC, read SSE responses
      fetch(this.baseUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(msg)
      }).then(async resp => {
        if (resp.headers.get('content-type')?.includes('text/event-stream')) {
          const reader = resp.body.getReader(); const dec = new TextDecoder(); let b = '';
          while (true) { const { done, value } = await reader.read(); if (done) break; b += dec.decode(value, { stream: true }); const lines = b.split('\n'); b = lines.pop() || ''; for (const ln of lines) { const t = ln.trim(); if (t.startsWith('data:')) { try { this._handle(JSON.parse(t.slice(5).trim())); } catch {} } } }
        } else { const j = await resp.json(); this._handle(j); }
      }).catch(e => { if (msg.id) { const p = this.pending.get(msg.id); if (p) p.reject(new Error(e.message)); } });
    }
  }
  _onData(s) {
    this.buf += s;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() || '';
    for (const ln of lines) { const t = ln.trim(); if (!t) continue; try { this._handle(JSON.parse(t)); } catch {} }
  }
  _handle(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg);
    }
  }
  disconnect() {
    try { this.proc?.kill(); } catch {}
    this.connected = false;
    this._failAllPending(new Error('MCP 连接已关闭'));
  }
}

class McpManager {
  constructor() { this.clients = new Map(); }
  async connect(serverRecord) {
    const client = new McpClient(serverRecord);
    try {
      const tools = await client.connect();
      this.clients.set(serverRecord.id, client);
      return tools;
    } catch (e) {
      // Never leave a half-spawned child process behind on a failed handshake.
      try { client.disconnect(); } catch {}
      throw e;
    }
  }
  get(id) { return this.clients.get(id); }
  async callTool(serverId, name, args) {
    const c = this.clients.get(serverId);
    if (!c || !c.connected) throw new Error('MCP 服务器未连接');
    return c.callTool(name, args);
  }
  disconnect(id) { this.clients.get(id)?.disconnect(); this.clients.delete(id); }
}

module.exports = { McpManager, McpClient, checkProtocol, PROTOCOL_VERSION, SUPPORTED_PROTOCOLS };
