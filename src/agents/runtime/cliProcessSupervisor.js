'use strict';
/**
 * v2.8.0 — 通用 CLI 进程监督器（spec §26/§27/§28）。
 *
 * 所有 ACP agent（codex-acp / claude-agent-acp / 未来其他 ACP agent）共用同一套
 * 进程生命周期管理，禁止每个 Adapter 各写一套 spawn。
 *
 * 职责：
 *   - detect executable（PATH 解析 / 绝对路径存在性）
 *   - version 探测
 *   - spawn（cwd / env allowlist / stdin / stdout / stderr / output cap / timeout / cancel）
 *   - killTree（Windows 走 taskkill /T /F fallback，禁止残留 zombie）
 *   - graceful shutdown / crash / restart / dispose
 *
 * 通过依赖注入（spawnImpl / killTreeImpl / resolveImpl）支持单测，无需真实进程。
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { killTree, resolveCliInPath } = require('../../services/externalAgents');

const DEFAULT_OUTPUT_CAP_BYTES = 8 * 1024 * 1024; // 8 MiB 累积上限
const DEFAULT_VERSION_TIMEOUT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 600000;

/** env 透传白名单（spec §28）：只放行运行所需的最小集合，绝不整体复制 process.env。 */
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'SYSTEMROOT', 'SYSTEMDRIVE',
  'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'USERNAME', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM', 'OS', 'windir', 'PATHEXT', 'NUMBER_OF_PROCESSORS'
];

/**
 * 构建 env allowlist。
 * @param {string[]} [passthrough] 额外允许的 key（来自平台策略，已审查）
 * @param {object} [explicit] 显式注入的凭据 / 配置（来自安全存储，调用方负责）
 * @returns {object}
 */
function buildEnvAllowlist(passthrough = [], explicit = {}) {
  const env = {};
  const keys = new Set([...ENV_ALLOWLIST, ...passthrough]);
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  // 显式凭据 / 配置（调用方已确认安全）
  for (const k of Object.keys(explicit || {})) {
    if (explicit[k] !== undefined) env[k] = explicit[k];
  }
  return env;
}

/**
 * 创建 CLI 进程监督器。
 * @param {object} [opts]
 * @param {Function} [opts.spawnImpl] (cmd, args, opts) => ChildProcess
 * @param {Function} [opts.killTreeImpl] (child, signal) => void
 * @param {Function} [opts.resolveImpl] (cmd) => Promise<string>  PATH 解析
 */
function createCliProcessSupervisor(opts = {}) {
  const spawnImpl = opts.spawnImpl || ((cmd, args, o) => spawn(cmd, args, o));
  const killTreeImpl = opts.killTreeImpl || ((child, sig) => killTree(child, sig));
  const resolveImpl = opts.resolveImpl || ((cmd) => resolveCliInPath(cmd));

  let current = null; // backward-compatible last handle
  const handles = new Map(); // runId/pid -> ProcessHandle

  /** 探测可执行文件。 */
  async function detect(executable) {
    let path = null;
    if (!executable) return { available: false, path: null, version: null };
    if (executable.includes('/') || executable.includes('\\') || executable.toLowerCase().endsWith('.exe')) {
      path = fs.existsSync(executable) ? executable : null;
    } else {
      try { path = await resolveImpl(executable); } catch { path = null; }
    }
    return { available: !!path, path };
  }

  /** 跑 version 命令，返回 trimmed stdout。 */
  async function readVersion(executablePath, versionCommand = ['--version'], timeoutMs = DEFAULT_VERSION_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let out = '';
      let child;
      try {
        child = spawnImpl(executablePath, Array.isArray(versionCommand) ? versionCommand : [versionCommand], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: buildEnvAllowlist()
        });
      } catch (e) {
        return reject(new Error('spawn failed: ' + e.message));
      }
      const timer = setTimeout(() => {
        try { killTreeImpl(child, 'SIGKILL'); } catch { /* gone */ }
        reject(new Error('version command timed out'));
      }, timeoutMs);
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`version command exited with code ${code}`));
      });
    });
  }

  /**
   * 启动一个进程。
   *
   * ⚠️ 语义要点：本函数**在 spawn 成功后立即返回**，不等进程退出。
   * 退出结果通过 `handle.done`（Promise）获取。这样同一套监督器能同时服务：
   *   - 长驻协议服务（ACP agent / codex app-server）：拿到 handle 立刻开始收发消息，
   *     若在此处等待退出会直接死锁；
   *   - 一次性 CLI 运行（codex exec / claude -p）：`const r = await handle.done`。
   *
   * @param {object} spawnOpts
   * @param {string} spawnOpts.command 可执行路径
   * @param {string[]} [spawnOpts.args]
   * @param {string} [spawnOpts.cwd]
   * @param {object} [spawnOpts.env] 已 allowlist 构造好的 env
   * @param {number} [spawnOpts.timeoutMs] 超时后 killTree 并把 done 标记 timedOut
   * @param {number} [spawnOpts.outputCapBytes] stdout/stderr 累积上限
   * @param {boolean} [spawnOpts.captureOutput=true] 长驻服务可设 false，避免无谓累积
   * @param {AbortSignal} [spawnOpts.signal]
   * @returns {Promise<object>} ProcessHandle { pid, child, stdout, stderr, kill, done }
   */
  function spawnProcess(spawnOpts = {}) {
    const {
      command, args = [], cwd, env,
      timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
      outputCapBytes = DEFAULT_OUTPUT_CAP_BYTES,
      captureOutput = true,
      signal,
      runId = null,
      killConfirmTimeoutMs = 5000
    } = spawnOpts;

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(command, args, {
          windowsHide: true,
          cwd,
          env: env || buildEnvAllowlist(),
          detached: process.platform !== 'win32' // POSIX: 进程组 leader，便于 killTree
        });
      } catch (e) {
        return reject(Object.assign(new Error('spawn failed: ' + e.message), { code: 'SPAWN_FAILED' }));
      }

      let settleDone;
      const handle = {
        pid: child.pid,
        child,
        stdout: '',
        stderr: '',
        timedOut: false,
        killed: false,
        exited: false,
        quiesced: false,
        runId: runId || null,
        error: null,
        _finished: false,
        _timer: null,
        _onAbort: null,
        kill(sig = 'SIGKILL') {
          handle.killed = true;
          try { killTreeImpl(child, sig); } catch { /* gone */ }
        },
        awaitExit(waitMs = killConfirmTimeoutMs) {
          if (handle.exited) return Promise.resolve({ quiesced: true, residual: 0 });
          return new Promise(resolveWait => {
            let settled = false;
            let t = null;
            const done = (value) => {
              if (settled) return;
              settled = true;
              if (t) clearTimeout(t);
              resolveWait(value);
            };
            handle.done.then(() => done({ quiesced: handle.exited, residual: handle.exited ? 0 : { pid: handle.pid } }));
            t = setTimeout(() => done({ quiesced: handle.exited, residual: handle.exited ? 0 : { pid: handle.pid } }), waitMs);
          });
        }
      };
      // 进程退出结果（永不 reject —— 退出属正常事件，错误信息放在 result.error）
      handle.done = new Promise(res => { settleDone = res; });

      const capReached = () => (handle.stdout.length + handle.stderr.length) >= outputCapBytes;

      const finish = (result, confirmedExit = false) => {
        if (handle._finished) return;
        handle._finished = true;
        handle.exited = confirmedExit;
        handle.quiesced = confirmedExit;
        if (handle._timer) { clearTimeout(handle._timer); handle._timer = null; }
        if (signal && handle._onAbort) {
          try { signal.removeEventListener('abort', handle._onAbort); } catch { /* noop */ }
        }
        settleDone(result);
      };

      let killConfirmTimer = null;
      const requestStop = (kind) => {
        handle.kill('SIGKILL');
        if (killConfirmTimer) return;
        killConfirmTimer = setTimeout(() => {
          finish({
            code: null, signal: 'SIGKILL',
            timedOut: kind === 'timeout', aborted: kind === 'abort',
            quiesced: false, residual: { pid: handle.pid },
            stdout: handle.stdout, stderr: handle.stderr
          }, false);
        }, killConfirmTimeoutMs);
      };

      if (timeoutMs && timeoutMs > 0) {
        handle._timer = setTimeout(() => {
          handle.timedOut = true;
          requestStop('timeout');
        }, timeoutMs);
        // The process itself keeps a real runtime alive. A forgotten fake or
        // already-detached handle must not pin application/test shutdown.
        if (typeof handle._timer.unref === 'function') handle._timer.unref();
      }

      if (signal) {
        if (signal.aborted) {
          requestStop('abort');
          current = handle;
          handles.set(runId || String(handle.pid), handle);
          return resolve(handle);
        }
        handle._onAbort = () => {
          requestStop('abort');
        };
        try { signal.addEventListener('abort', handle._onAbort, { once: true }); } catch { /* noop */ }
      }

      if (captureOutput) {
        if (child.stdout) child.stdout.on('data', d => { if (!capReached()) handle.stdout += d.toString(); });
        if (child.stderr) child.stderr.on('data', d => { if (!capReached()) handle.stderr += d.toString(); });
      } else if (child.stderr) {
        // 长驻服务仍保留 stderr（诊断用），但同样受 cap 约束
        child.stderr.on('data', d => { if (!capReached()) handle.stderr += d.toString(); });
      }

      child.on('error', e => {
        handle.error = e.message;
        handles.delete(runId || String(handle.pid));
        finish({
          code: null, signal: null, error: handle.error,
          timedOut: handle.timedOut, aborted: !!(signal && signal.aborted),
          quiesced: true, residual: 0,
          stdout: handle.stdout, stderr: handle.stderr
        }, true);
      });
      child.on('close', (code, sig) => {
        if (killConfirmTimer) { clearTimeout(killConfirmTimer); killConfirmTimer = null; }
        handle.exited = true;
        handle.quiesced = true;
        handles.delete(runId || String(handle.pid));
        finish({
          code, signal: sig, error: handle.error,
          timedOut: handle.timedOut, aborted: !!(signal && signal.aborted),
          quiesced: true, residual: 0,
          stdout: handle.stdout, stderr: handle.stderr
        }, true);
      });

      current = handle;
      handles.set(runId || String(handle.pid), handle);
      resolve(handle);
    });
  }

  function dispose() {
    for (const handle of handles.values()) {
      if (!handle.exited) { try { handle.kill('SIGKILL'); } catch { /* gone */ } }
    }
    handles.clear();
    current = null;
  }

  async function cancelRun(runId, timeoutMs = 5000) {
    const handle = handles.get(runId);
    if (!handle) return { ok: false, status: 'unknown', quiesced: false, residual: 'unknown runId' };
    if (!handle.exited) handle.kill('SIGKILL');
    const q = await handle.awaitExit(timeoutMs);
    return { ok: q.quiesced, status: 'cancelled', quiesced: q.quiesced, residual: q.residual, detail: q.quiesced ? 'process tree exited' : 'process tree exit unconfirmed' };
  }

  return {
    detect,
    readVersion,
    spawnProcess,
    buildEnvAllowlist,
    cancelRun,
    dispose,
    activeCount: () => [...handles.values()].filter(h => !h.exited).length,
    _getCurrent: () => current,
    _getHandle: runId => handles.get(runId) || null
  };
}

module.exports = {
  createCliProcessSupervisor,
  buildEnvAllowlist,
  ENV_ALLOWLIST,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_VERSION_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS
};
