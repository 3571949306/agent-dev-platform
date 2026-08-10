'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { stripSecrets } = require('../../runtime/resultSanitizer');
const { locateClineRuntime } = require('./runtimeLocator');
const { JsonlDecoder, createMessage, encodeMessage } = require('./sidecarProtocol');

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const STDERR_CAPTURE_BYTES = 64 * 1024;
const SAFE_ENV_KEYS = new Set([
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE',
  'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
]);

function codedError(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = stripSecrets(detail);
  return error;
}

function errorFromMessage(message, fallbackCode = 'CLINE_RUNTIME_ERROR') {
  const raw = message && message.payload && message.payload.error;
  return codedError(raw && raw.code || fallbackCode, raw && raw.message || 'Cline sidecar runtime error');
}

function canonicalDirectory(directory) {
  if (!directory) throw codedError('CLINE_WORKSPACE_INVALID', 'projectRoot is required');
  try {
    const resolved = fs.realpathSync.native(directory);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch (error) {
    throw codedError('CLINE_WORKSPACE_INVALID', `Cannot resolve projectRoot: ${error.message}`);
  }
}

function buildSidecarEnv(sourceEnv, dataDir) {
  const env = Object.create(null);
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (SAFE_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  env.NODE_ENV = 'production';
  env.ADP_CLINE_PROTOCOL = '1';
  if (dataDir) env.CLINE_DATA_DIR = path.resolve(dataDir);
  return env;
}

function defaultKillTree(child) {
  if (!child) return false;
  if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const killer = childProcess.spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', () => { try { child.kill(); } catch {} });
      killer.unref?.();
      return true;
    } catch { /* fall through to direct process termination */ }
  }
  try { return child.kill(); } catch { return false; }
}

class ClineSidecarManager {
  constructor(options = {}) {
    this.options = options;
    this.spawn = options.spawn || childProcess.spawn;
    this.killTree = options.killTree || defaultKillTree;
    this.locator = options.locator || locateClineRuntime;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.dataDir = options.dataDir || null;
    this.child = null;
    this.childCwd = null;
    this.runtime = null;
    this.decoder = null;
    this.starting = null;
    this.handshake = null;
    this.expectedExit = false;
    this.pending = new Map();
    this.activeRuns = new Map();
    this.terminalRunIds = new Set();
    this.stderrTail = '';
    this.disposed = false;
    this.stopping = null;
  }

  detect() {
    const located = this.locator(this.options);
    return {
      available: !!located?.available,
      installed: !!located?.available,
      configured: !!located?.available,
      version: located?.manifest?.cline?.sdkVersion || null,
      nodeVersion: located?.manifest?.node?.version || null,
      path: located?.root || null,
      error: located?.error || (located?.missing?.length ? `Missing runtime files: ${located.missing.join(', ')}` : null),
      runtime: located || null
    };
  }

  async start(projectRoot) {
    if (this.disposed) throw codedError('CLINE_SIDECAR_STOPPED', 'Cline sidecar manager has been disposed');
    if (this.stopping) await this.stopping;
    const cwd = projectRoot ? canonicalDirectory(projectRoot) : null;
    if (this.child && !this.child.killed && (!cwd || this.childCwd === cwd)) return this.handshake;
    if (this.starting) {
      await this.starting;
      if (!cwd || this.childCwd === cwd) return this.handshake;
    }
    if (this.child && this.childCwd !== cwd) {
      if (this.activeRuns.size) throw codedError('CLINE_AGENT_BUSY', 'Cannot switch Cline sidecar workspace during an active run');
      await this.shutdown();
    }
    this.starting = this._spawn(cwd).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _spawn(cwd) {
    const runtime = this.locator(this.options);
    if (!runtime || !runtime.available) {
      throw codedError('CLINE_NODE_RUNTIME_MISSING', runtime?.error || `Cline runtime is unavailable${runtime?.missing?.length ? `: ${runtime.missing.join(', ')}` : ''}`);
    }
    const spawnCwd = cwd || runtime.root;
    const env = buildSidecarEnv(this.options.env || process.env, this.dataDir);
    this.runtime = runtime;
    this.childCwd = spawnCwd;
    this.expectedExit = false;
    this.stderrTail = '';
    this.handshake = null;
    let child;
    try {
      child = this.spawn(runtime.nodePath, [runtime.sidecarPath], {
        cwd: spawnCwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      throw codedError('CLINE_SIDECAR_START_FAILED', `Failed to spawn Cline sidecar: ${error.message}`);
    }
    this.child = child;
    this.decoder = new JsonlDecoder({
      onMessage: message => this._handleMessage(message),
      onWarning: () => {},
      onFatal: error => this._protocolFatal(error)
    });
    child.stdout.on('data', chunk => this.decoder.push(chunk));
    child.stdout.on('end', () => this.decoder.end());
    child.stderr.on('data', chunk => this._captureStderr(chunk));
    child.once('error', error => this._handleChildError(error));
    child.once('exit', (code, signal) => this._handleExit(code, signal));

    const handshake = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(codedError('CLINE_SIDECAR_HANDSHAKE_FAILED', `Cline sidecar handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);
      timeout.unref?.();
      this._handshakeWaiter = {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); }
      };
      // A very fast child can write hello.ok before the waiter is installed.
      if (this.handshake) this._handshakeWaiter.resolve(this.handshake);
    }).catch(error => {
      this._killChild();
      throw error;
    });
    this.handshake = handshake;
    return handshake;
  }

  _captureStderr(chunk) {
    const text = String(stripSecrets(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)));
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_CAPTURE_BYTES);
  }

  _handleMessage(message) {
    if (message.type === 'hello.ok') {
      const payload = message.payload || {};
      if (Number(String(payload.nodeVersion || '').split('.')[0]) < 22 || payload.runtime !== 'ClineCore') {
        this._handshakeWaiter?.reject(codedError('CLINE_SIDECAR_HANDSHAKE_FAILED', 'Cline sidecar reported an incompatible runtime'));
        this._handshakeWaiter = null;
        return;
      }
      this.handshake = payload;
      this._handshakeWaiter?.resolve(payload);
      this._handshakeWaiter = null;
      return;
    }

    const pending = message.requestId && this.pending.get(message.requestId);
    if (message.type === 'runtime.error' && pending) {
      this.pending.delete(message.requestId);
      pending.reject(errorFromMessage(message));
      return;
    }
    if (message.type === 'runtime.error' && message.runId) {
      const record = this.activeRuns.get(message.runId);
      if (record) this._settleRun(record, null, errorFromMessage(message));
      return;
    }
    if (pending && (message.type === pending.responseType || !pending.responseType)) {
      this.pending.delete(message.requestId);
      pending.resolve(message);
      return;
    }

    if (message.type.startsWith('run.')) {
      const record = message.runId && this.activeRuns.get(message.runId);
      if (!record) {
        if (message.runId && this.terminalRunIds.has(message.runId)) return;
        this._protocolFatal(codedError('CLINE_PROTOCOL_ERROR', `Unexpected runId in ${message.type}`));
        return;
      }
      if (message.type === 'run.started') {
        record.started = true;
        record.onStarted?.(message.payload || {});
        return;
      }
      if (message.type === 'run.event') {
        record.onEvent?.(message.payload?.event);
        return;
      }
      if (['run.result', 'run.failed', 'run.cancelled', 'run.timeout'].includes(message.type)) {
        this._settleRun(record, message);
      }
    }
  }

  _settleRun(record, message, error) {
    if (!record || record.settled) return false;
    record.settled = true;
    if (record.timer) clearTimeout(record.timer);
    this.activeRuns.delete(record.runId);
    this.terminalRunIds.add(record.runId);
    if (this.terminalRunIds.size > 1000) this.terminalRunIds.delete(this.terminalRunIds.values().next().value);
    if (error) record.reject(error);
    else record.resolve(message);
    return true;
  }

  _request(type, payload, responseType) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, responseType });
      try { this._write(createMessage(type, { requestId, payload })); }
      catch (error) { this.pending.delete(requestId); reject(error); }
    });
  }

  async probe(projectRoot) {
    await this.start(projectRoot);
    const response = await this._request('runtime.probe', {}, 'runtime.probe');
    return response.payload || {};
  }

  async run({ runId, projectRoot, payload, timeoutMs, onEvent, onStarted } = {}) {
    if (this.disposed) throw codedError('CLINE_SIDECAR_STOPPED', 'Cline sidecar manager has been disposed');
    if (!runId) throw codedError('CLINE_PROTOCOL_ERROR', 'runId is required');
    const canonicalRoot = canonicalDirectory(projectRoot);
    await this.start(canonicalRoot);
    if (this.activeRuns.size) throw codedError('CLINE_AGENT_BUSY', 'Cline sidecar maxConcurrency is 1');
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      const record = { runId, requestId, resolve, reject, onEvent, onStarted, settled: false, started: false, timer: null };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        record.timer = setTimeout(() => {
          if (record.settled) return;
          // Settle locally first: a fast sidecar can acknowledge cancel in the
          // same tick, but timeout intent must remain distinct from user cancel.
          this._settleRun(record, createMessage('run.timeout', {
            requestId,
            runId,
            payload: { error: { code: 'CLINE_RUN_TIMEOUT', message: `Cline run timed out after ${timeoutMs}ms` } }
          }));
          try { this._write(createMessage('run.cancel', { requestId: crypto.randomUUID(), runId, payload: { reason: 'timeout' } })); } catch {}
        }, timeoutMs);
      }
      this.activeRuns.set(runId, record);
      try {
        this._write(createMessage('run.start', {
          requestId,
          runId,
          payload: { ...(payload || {}), projectRoot: canonicalRoot, authorizedProjectRoot: canonicalRoot, timeoutMs }
        }));
      } catch (error) {
        this._settleRun(record, null, error);
      }
    });
    return promise;
  }

  cancel(runId, reason = 'user_cancel') {
    const record = this.activeRuns.get(runId);
    if (!record || record.settled) return false;
    this._write(createMessage('run.cancel', { requestId: crypto.randomUUID(), runId, payload: { reason } }));
    return true;
  }

  _write(message) {
    if (!this.child || this.child.killed || !this.child.stdin || this.child.stdin.destroyed) {
      throw codedError('CLINE_SIDECAR_NOT_RUNNING', 'Cline sidecar is not running');
    }
    this.child.stdin.write(encodeMessage(message));
  }

  _protocolFatal(error) {
    const fatal = error && error.code ? error : codedError('CLINE_PROTOCOL_ERROR', error?.message || String(error));
    for (const record of [...this.activeRuns.values()]) this._settleRun(record, null, fatal);
    for (const pending of this.pending.values()) pending.reject(fatal);
    this.pending.clear();
    this._handshakeWaiter?.reject(fatal);
    this._handshakeWaiter = null;
    this._killChild();
  }

  _handleChildError(error) {
    const failure = codedError('CLINE_SIDECAR_START_FAILED', `Cline sidecar process error: ${error.message}`);
    this._handshakeWaiter?.reject(failure);
    this._handshakeWaiter = null;
    for (const record of [...this.activeRuns.values()]) this._settleRun(record, null, failure);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }

  _handleExit(code, signal) {
    const unexpected = !this.expectedExit;
    const error = codedError(
      unexpected ? 'CLINE_SIDECAR_CRASHED' : 'CLINE_SIDECAR_STOPPED',
      `Cline sidecar exited${code != null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`,
      { stderr: this.stderrTail }
    );
    this._handshakeWaiter?.reject(error);
    this._handshakeWaiter = null;
    for (const record of [...this.activeRuns.values()]) this._settleRun(record, null, error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = null;
    this.childCwd = null;
    this.decoder = null;
    this.handshake = null;
    this.expectedExit = false;
  }

  _killChild() {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    try { this.killTree(child); } catch { try { child.kill(); } catch {} }
  }

  async shutdown() {
    if (this.stopping) return this.stopping;
    this.stopping = this._shutdown().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async _shutdown() {
    const child = this.child;
    if (!child) return { ok: true, alreadyStopped: true };
    this.expectedExit = true;
    let timer;
    try {
      const exitPromise = new Promise(resolve => child.once('exit', () => resolve(true)));
      const response = await Promise.race([
        this._request('runtime.shutdown', {}, 'runtime.goodbye'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(codedError('CLINE_SIDECAR_SHUTDOWN_TIMEOUT', 'Cline sidecar graceful shutdown timed out')), this.shutdownTimeoutMs);
        })
      ]);
      await Promise.race([
        exitPromise,
        new Promise(resolve => {
          const exitTimer = setTimeout(() => { this._killChild(); resolve(false); }, this.shutdownTimeoutMs);
        })
      ]);
      return { ok: true, response: response.payload || null };
    } catch (error) {
      this._killChild();
      return { ok: false, killed: true, error: error.message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispose() {
    this.disposed = true;
    await this.shutdown();
  }
}

module.exports = {
  ClineSidecarManager,
  buildSidecarEnv,
  canonicalDirectory,
  codedError,
  SAFE_ENV_KEYS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  STDERR_CAPTURE_BYTES,
  defaultKillTree
};
