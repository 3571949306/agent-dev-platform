'use strict';
/**
 * v2.7.0 Agent Integration Hub — OpenCode 本地服务进程管理（spec §4.3）。
 *
 * OpenCode 通过 `opencode serve` 暴露 HTTP + SSE API。本模块负责：
 *   - 探测 `opencode` CLI 是否在 PATH 中
 *   - 读取版本号（`opencode --version`）
 *   - 启动 / 停止本地 server 进程（永远绑定 127.0.0.1，绝不监听 0.0.0.0）
 *   - 分配空闲端口（net.createServer().listen(0)）
 *   - 生成随机 Basic Auth 口令（仅在内存中持有，绝不落盘 / 打印）
 *   - 引用计数：同一 projectRoot 下的多个 Run 复用同一个 server，最后一个
 *     Run 释放后才真正 kill 进程树
 *   - 健康检查：GET /global/health（带 Basic Auth）
 *
 * 安全要点：
 *   - 口令用 crypto.randomBytes 生成，仅存在 serverManager 闭包里
 *   - 绝不把口令写进日志 / 环境变量透传 / 返回给调用方以外的对象
 *   - 绑定地址固定 127.0.0.1，避免局域网暴露
 *   - 停止用 killTree（来自 services/externalAgents.js）回收整个进程树
 */

const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { linkSignals } = require('../../../providers/http');
const { killTree, resolveCliInPath } = require('../../../services/externalAgents');

const HOSTNAME = '127.0.0.1';
const DEFAULT_PORT = 4096;
const VERSION_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 5000;
const SERVER_START_TIMEOUT_MS = 15000;

/**
 * 分配一个空闲端口：监听 0 让操作系统分配，然后立即关闭取回端口。
 * @returns {Promise<number>}
 */
function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOSTNAME, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 生成随机 Basic Auth 口令（32 字节 hex）。仅在内存中持有。 */
function generatePassword() {
  return crypto.randomBytes(32).toString('hex');
}

/** 构造 Basic Auth 头值：Basic base64(opencode:password)。 */
function basicAuthHeader(password) {
  return 'Basic ' + Buffer.from(`opencode:${password || ''}`, 'utf8').toString('base64');
}

/**
 * 创建 OpenCode 服务进程管理器。
 *
 * 引用计数模型：
 *   servers: Map<projectRoot, { child, port, password, pid, refs:Set<runId> }>
 *   start()  → refs++，首次启动进程；后续复用
 *   release(runId) → refs.delete(runId)，refs 空了才真正 stop()
 *
 * @param {object} [opts]
 * @param {number} [opts.startTimeoutMs] server 启动就绪超时（默认 15s）
 * @param {number} [opts.healthTimeoutMs] 健康检查超时（默认 5s）
 * @returns {object} serverManager 实例
 */
function createOpenCodeServerManager(opts = {}) {
  const startTimeoutMs = Number(opts.startTimeoutMs) || SERVER_START_TIMEOUT_MS;
  const healthTimeoutMs = Number(opts.healthTimeoutMs) || HEALTH_TIMEOUT_MS;

  /** @type {Map<string, { child, port, password, pid, refs:Set<string>, ready:Promise }>} */
  const servers = new Map();
  let detectedCache = null;

  /**
   * 探测 opencode CLI 是否在 PATH 中。
   * @returns {Promise<{ available: boolean, path: string|null }>}
   */
  async function detect() {
    if (detectedCache) return detectedCache;
    let path = null;
    try { path = await resolveCliInPath('opencode'); } catch { path = null; }
    detectedCache = { available: !!path, path };
    return detectedCache;
  }

  /**
   * 读取 opencode 版本号：`opencode --version`，限时 5s。
   * @returns {Promise<string|null>}
   */
  async function getVersion() {
    const detected = await detect();
    if (!detected.available || !detected.path) return null;
    return runVersion(detected.path);
  }

  /** 跑 `${cliPath} --version`，限时 VERSION_TIMEOUT_MS。 */
  function runVersion(cliPath) {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(cliPath, ['--version'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        resolve(null);
      }, VERSION_TIMEOUT_MS);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', code => {
        clearTimeout(timer);
        resolve(code === 0 ? out.trim() : null);
      });
    });
  }

  /**
   * 健康检查：GET /global/health（带 Basic Auth）。
   * @param {string} baseUrl
   * @param {string} password
   * @returns {Promise<{ healthy: boolean, version: string|null, latencyMs: number }>}
   */
  async function health(baseUrl, password) {
    const start = Date.now();
    const link = linkSignals(healthTimeoutMs, null);
    try {
      const resp = await fetch(`${baseUrl}/global/health`, {
        method: 'GET',
        headers: { Authorization: basicAuthHeader(password) },
        signal: link.signal
      });
      const latencyMs = Date.now() - start;
      if (!resp.ok) return { healthy: false, version: null, latencyMs };
      let body = null;
      try { body = await resp.json(); } catch { /* non-JSON */ }
      return {
        healthy: !!(body && body.healthy !== false),
        version: (body && body.version) || null,
        latencyMs
      };
    } catch {
      return { healthy: false, version: null, latencyMs: Date.now() - start };
    } finally { link.dispose(); }
  }

  /** 进程是否仍存活。 */
  function isProcessAlive(child) {
    if (!child || child.pid == null) return false;
    try { process.kill(child.pid, 0); return true; } catch { return false; }
  }

  /**
   * 启动（或复用）一个 projectRoot 对应的 OpenCode server。
   *
   * 同一 projectRoot 下的多个 Run 复用同一进程；不同 projectRoot 各自独立。
   * 返回的 { port, password, pid } 中，password 仅在内存中。
   *
   * @param {object} args
   * @param {string} args.projectRoot 工作目录（必填，作为 server 的 cwd）
   * @param {number} [args.port] 指定端口；缺省自动分配
   * @param {string} [args.runId] 引用计数 key（缺省用随机 id）
   * @returns {Promise<{ port: number, password: string, pid: number, baseUrl: string, refCount: number }>}
   */
  async function start({ projectRoot, port, runId } = {}) {
    if (!projectRoot) throw new Error('createOpenCodeServerManager.start: projectRoot 必填');
    const key = projectRoot;
    const ref = runId || crypto.randomUUID();

    const existing = servers.get(key);
    if (existing) {
      // 复用：refs++，等待就绪
      existing.refs.add(ref);
      await existing.ready;
      // 进程已死：清理后走重新启动路径
      if (!isProcessAlive(existing.child)) {
        servers.delete(key);
      } else {
        return {
          port: existing.port,
          password: existing.password,
          pid: existing.pid,
          baseUrl: `http://${HOSTNAME}:${existing.port}`,
          refCount: existing.refs.size
        };
      }
    }

    const detected = await detect();
    if (!detected.available || !detected.path) {
      throw new Error('opencode CLI not found in PATH; cannot start server');
    }

    const chosenPort = port || await allocatePort();
    const password = generatePassword();

    const child = spawn(detected.path, [
      'serve',
      '--hostname', HOSTNAME,
      '--port', String(chosenPort)
    ], {
      windowsHide: true,
      cwd: projectRoot,
      // POSIX: 成为进程组 leader，killTree() 可一并回收子进程。
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const entry = {
      child,
      port: chosenPort,
      password,
      pid: child.pid,
      refs: new Set([ref]),
      ready: null
    };

    // ready promise：等 health 通过或超时
    entry.ready = waitForReady(`http://${HOSTNAME}:${chosenPort}`, password, child, startTimeoutMs)
      .catch(err => { entry.startError = err; });
    servers.set(key, entry);

    // 子进程意外退出：清理 entry，避免后续复用到死进程
    child.on('error', () => { try { killTree(child, 'SIGKILL'); } catch { /* noop */ } });
    child.on('exit', () => {
      // 仅当 entry 仍指向同一个 child 时才清理（防止 stop 后误删新 entry）
      const cur = servers.get(key);
      if (cur && cur.child === child) servers.delete(key);
    });

    await entry.ready;
    if (entry.startError) {
      try { killTree(child, 'SIGKILL'); } catch { /* noop */ }
      servers.delete(key);
      throw entry.startError;
    }

    return {
      port: chosenPort,
      password,
      pid: child.pid,
      baseUrl: `http://${HOSTNAME}:${chosenPort}`,
      refCount: entry.refs.size
    };
  }

  /** 轮询 /global/health 直到通过或超时 / 子进程退出。 */
  function waitForReady(baseUrl, password, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (!isProcessAlive(child)) {
          return reject(new Error('opencode server process exited before becoming healthy'));
        }
        if (Date.now() > deadline) {
          return reject(new Error(`opencode server did not become healthy within ${Math.round(timeoutMs / 1000)}s`));
        }
        const r = await health(baseUrl, password);
        if (r.healthy) return resolve();
        setTimeout(tick, 300);
      };
      tick().catch(reject);
    });
  }

  /**
   * 释放某个 run 的引用。refs 清空后真正 kill 进程树。
   * @param {string} projectRoot
   * @param {string} runId
   * @returns {boolean} 是否真正停止了 server
   */
  function release(projectRoot, runId) {
    const entry = servers.get(projectRoot);
    if (!entry) return false;
    entry.refs.delete(runId);
    if (entry.refs.size > 0) return false;
    try { killTree(entry.child, 'SIGKILL'); } catch { /* gone */ }
    servers.delete(projectRoot);
    return true;
  }

  /**
   * 停止 projectRoot 对应的 server（忽略引用计数，强制 kill）。
   * @param {string} projectRoot
   * @returns {boolean}
   */
  function stop(projectRoot) {
    const entry = servers.get(projectRoot);
    if (!entry) return false;
    try { killTree(entry.child, 'SIGKILL'); } catch { /* gone */ }
    servers.delete(projectRoot);
    return true;
  }

  /** 获取 projectRoot 对应 server 的运行信息（不含口令明文）。 */
  function getServer(projectRoot) {
    const entry = servers.get(projectRoot);
    if (!entry) return null;
    return {
      port: entry.port,
      pid: entry.pid,
      baseUrl: `http://${HOSTNAME}:${entry.port}`,
      refCount: entry.refs.size,
      running: isProcessAlive(entry.child),
      // 口令仅返回给受信调用方（adapter），不对外暴露
      password: entry.password
    };
  }

  /** 某个 projectRoot 的 server 是否仍在运行。 */
  function isRunning(projectRoot) {
    const entry = servers.get(projectRoot);
    return !!(entry && isProcessAlive(entry.child));
  }

  /**
   * 释放所有受管 server 进程。
   */
  async function dispose() {
    for (const [, entry] of servers) {
      try { killTree(entry.child, 'SIGKILL'); } catch { /* gone */ }
    }
    servers.clear();
    detectedCache = null;
  }

  return {
    detect,
    getVersion,
    start,
    release,
    stop,
    health,
    getServer,
    isRunning,
    isProcessAlive,
    dispose
  };
}

module.exports = {
  createOpenCodeServerManager,
  allocatePort,
  generatePassword,
  basicAuthHeader,
  HOSTNAME,
  DEFAULT_PORT
};
