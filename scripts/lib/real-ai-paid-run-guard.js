'use strict';
/**
 * v2.9.0 Harness Safety Patch — RealAiPaidRunGuard（R3）。
 *
 * Prompt 级「最多 2 次真实测试」不能只依赖 Agent 遵守，必须由程序强制：
 * 在任何真实 Provider 请求发出之前 reserve 一个 paid-run slot，否则
 * REAL_AI_ATTEMPT_LIMIT_EXCEEDED，绝无 Provider 调用机会。
 *
 * 违约背景（如实记录，§40）：
 *   Prompt allowed max 2 paid attempts; actual execution performed 5.
 *   Root cause: limit existed only in natural-language instructions,
 *   not in executable harness. Fix: RealAiPaidRunGuard.
 *
 * 与产品 Agent Budget 的区别（两者都必须存在，§26）：
 *   - Per Run Provider Budget:  maxProviderCalls = 6（单次 run 内，real-ai-runtime.createRealAiBudget）
 *   - Closure Paid Run Budget:  maxPaidRuns = 2（一个 Closure Session 内，本模块）
 *
 * Session 规则（§12/§14/§15）：
 *   - Session 文件在 OS TEMP（不进 repo）：adp-real-ai-active-session.json
 *     + adp-real-ai-session-<sessionId>.json；测试可经 ADP_REAL_AI_SESSION_DIR 隔离。
 *   - 同一 repoRoot + 同一 git HEAD + TTL（4h）内自动视为同一 Closure Session，
 *     重复运行不会自动绕开限制。
 *   - TTL 到期或 HEAD 变化后，仅当显式 override（REAL_AI_ALLOW_NEW_SESSION=1 由外部环境
 *     传入，或 newSession 命令）才创建新 Session，并留下日志
 *     NEW_PAID_TEST_SESSION_CREATED reason=...（§17）。Harness/脚本/测试不得自行设置 override（§18）。
 *
 * Crash Consistency（§23/§24）：atomic reserve —— 先拿独占锁 → 写 session（write temp → rename）
 * → 再返回允许；绝不「先发 API 再记账」。
 *
 * 并发（§25）：独占锁文件 open(..., 'wx') 短锁；抢不到 → REAL_AI_SESSION_LOCKED，不冒险执行 Provider。
 *
 * Session 文件禁止记录：API Key / Authorization / Bearer / 完整 Prompt（§9）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ACTIVE_SESSION_FILE = 'adp-real-ai-active-session.json';
const LOCK_FILE = 'adp-real-ai-session.lock';
const DEFAULT_MAX_PAID_RUNS = 2;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;   // §15：4 小时
const LOCK_STALE_MS = 30 * 1000;

function defaultSessionDir() {
  return process.env.ADP_REAL_AI_SESSION_DIR || os.tmpdir();
}

function activeSessionPath(dir) { return path.join(dir, ACTIVE_SESSION_FILE); }
function sessionFilePath(dir, sessionId) { return path.join(dir, `adp-real-ai-session-${sessionId}.json`); }
function lockPath(dir) { return path.join(dir, LOCK_FILE); }

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** §24：write temp → rename 原子写。 */
function atomicWriteJson(p, obj) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** §25：独占短锁（open 'wx'）。返回 release 函数；抢不到抛 REAL_AI_SESSION_LOCKED。 */
function acquireSessionLock(dir) {
  const lp = lockPath(dir);
  // stale lock 回收（持锁进程 crash 遗留）
  try {
    const st = fs.statSync(lp);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      try { fs.unlinkSync(lp); } catch { /* 竞争下由下一轮处理 */ }
    }
  } catch { /* 不存在 → 正常 */ }
  try {
    const fd = fs.openSync(lp, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const err = new Error('REAL_AI_SESSION_LOCKED: 另一个 Real AI Smoke 正在操作 session；为避免双重付费执行，拒绝运行');
      err.code = 'REAL_AI_SESSION_LOCKED';
      throw err;
    }
    throw e;
  }
  return () => { try { fs.unlinkSync(lp); } catch { /* noop */ } };
}

function repoIdentity(repoRoot) {
  let head = null;
  try {
    head = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch { /* 非 git 环境：仅用 repoRoot hash */ }
  return {
    repoRootHash: crypto.createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 16),
    head: head || null
  };
}

function newSessionRecord({ repoRoot, maxPaidRuns, reason }) {
  const { repoRootHash, head } = repoIdentity(repoRoot);
  const sessionId = crypto.randomUUID();
  return {
    sessionId,
    createdAt: new Date().toISOString(),
    repoRootHash,
    head,
    maxPaidRuns,
    paidRunsStarted: 0,
    creationReason: reason || 'initial',
    runs: []
  };
}

/**
 * 创建 Paid Run Guard。
 * @param {object} opts { repoRoot, sessionDir?, maxPaidRuns? }
 */
function createRealAiPaidRunGuard(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const dir = opts.sessionDir || defaultSessionDir();
  const maxPaidRuns = opts.maxPaidRuns ?? DEFAULT_MAX_PAID_RUNS;

  function loadActive() {
    const pointer = readJsonSafe(activeSessionPath(dir));
    if (!pointer || !pointer.sessionId) return null;
    const session = readJsonSafe(sessionFilePath(dir, pointer.sessionId));
    return session;
  }

  function sameContext(session) {
    if (!session) return false;
    const { repoRootHash, head } = repoIdentity(repoRoot);
    return session.repoRootHash === repoRootHash && session.head === head && !!session.head;
  }

  function withinTtl(session) {
    const t = Date.parse(session.createdAt || '');
    return Number.isFinite(t) && (Date.now() - t) < SESSION_TTL_MS;
  }

  /** 只读查看当前 session（不消耗 slot；dry-run / 报告用）。 */
  function inspect() {
    const s = loadActive();
    if (!s) return { hasSession: false };
    return {
      hasSession: true,
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      maxPaidRuns: s.maxPaidRuns,
      paidRunsStarted: s.paidRunsStarted,
      sameContext: sameContext(s),
      withinTtl: withinTtl(s),
      runs: (s.runs || []).map(r => ({ startedAt: r.startedAt, connectionId: r.connectionId, model: r.model, reason: r.reason }))
    };
  }

  /**
   * 获取当前 Closure Session（§12/§13）：
   *   - 从未有过 session → 首次创建允许（§13：Smoke 第一次执行时创建 session 并输出 ID）。
   *   - 存在且同 context（repoRoot+HEAD）且未过 TTL → 复用（不得每次自动新建绕过限制）。
   *   - 存在但 context 变化 / TTL 过期 → 仅显式 override（REAL_AI_ALLOW_NEW_SESSION=1
   *     由外部环境传入，或 new-session 命令）才创建新 Session，否则 FAIL CLOSED。
   * @param {object} o { allowNew?: boolean, newReason?: string }
   * @returns {{ ok: true, session, createdNew } | { ok: false, code, detail }}
   */
  function acquireSession(o = {}) {
    let release;
    try {
      release = acquireSessionLock(dir);
    } catch (e) {
      // §25：拿不到锁 → 不冒险执行，结构化返回（上层 BLOCKED，exit 4）
      return { ok: false, code: e.code === 'REAL_AI_SESSION_LOCKED' ? 'REAL_AI_SESSION_LOCKED' : 'REAL_AI_SESSION_LOCK_ERROR', detail: e.message };
    }
    try {
      const existing = loadActive();
      // force（new-session 命令 / 人工 override）：无条件创建新 Session（§16）
      if (o.force) {
        const reason = o.newReason || 'explicit_new_session_command';
        const session = newSessionRecord({ repoRoot, maxPaidRuns, reason });
        atomicWriteJson(sessionFilePath(dir, session.sessionId), session);
        atomicWriteJson(activeSessionPath(dir), { sessionId: session.sessionId, updatedAt: session.createdAt });
        // §17：Override 必须留下日志
        console.log(`[paid-run-guard] NEW_PAID_TEST_SESSION_CREATED sessionId=${session.sessionId} reason=${reason}`);
        return { ok: true, session, createdNew: true };
      }
      if (!existing) {
        // 首次：创建初始 session（§13）
        const session = newSessionRecord({ repoRoot, maxPaidRuns, reason: 'initial' });
        atomicWriteJson(sessionFilePath(dir, session.sessionId), session);
        atomicWriteJson(activeSessionPath(dir), { sessionId: session.sessionId, updatedAt: session.createdAt });
        console.log(`[paid-run-guard] REAL_AI_SESSION_CREATED sessionId=${session.sessionId} maxPaidRuns=${session.maxPaidRuns} reason=initial`);
        return { ok: true, session, createdNew: true };
      }
      if (sameContext(existing) && withinTtl(existing)) {
        return { ok: true, session: existing, createdNew: false };
      }
      if (!o.allowNew) {
        const why = !sameContext(existing) ? 'SESSION_CONTEXT_CHANGED (repo HEAD/root 不同)' : 'SESSION_TTL_EXPIRED';
        return { ok: false, code: 'REAL_AI_NEW_SESSION_REQUIRES_OVERRIDE', detail: why };
      }
      const reason = o.newReason || (!sameContext(existing) ? 'context_changed_explicit_override' : 'ttl_expired_explicit_override');
      const session = newSessionRecord({ repoRoot, maxPaidRuns, reason });
      atomicWriteJson(sessionFilePath(dir, session.sessionId), session);
      atomicWriteJson(activeSessionPath(dir), { sessionId: session.sessionId, updatedAt: session.createdAt });
      // §17：Override 必须留下日志
      console.log(`[paid-run-guard] NEW_PAID_TEST_SESSION_CREATED sessionId=${session.sessionId} reason=${reason}`);
      return { ok: true, session, createdNew: true };
    } finally {
      release();
    }
  }

  /**
   * §10/§19/§23：在第一个真实 Provider 请求之前 reserve 一个 paid-run slot。
   * atomic：锁内读-改-写 session（先 reserve → 写 session → 再调 API）；
   * API failure 也消耗 attempt（已开始即计数，§21）。
   * @param {object} meta { connectionId?, model?, reason? }（禁止放 key/prompt）
   * @returns {{ ok: true, paidRunsStarted, maxPaidRuns, sessionId }
   *          | { ok: false, code, paidRunsStarted, maxPaidRuns, providerCallsStarted: 0 }}
   */
  function reservePaidRun(meta = {}) {
    const allowNew = o_allowNewFromEnv();
    let release;
    try {
      release = acquireSessionLock(dir);
    } catch (e) {
      // §25：并发拿不到锁 → 拒绝运行（不冒险执行 Provider）
      return {
        ok: false,
        code: e.code === 'REAL_AI_SESSION_LOCKED' ? 'REAL_AI_SESSION_LOCKED' : 'REAL_AI_SESSION_LOCK_ERROR',
        detail: e.message,
        providerCallsStarted: 0
      };
    }
    try {
      let session = loadActive();
      if (!session) {
        // 首次：初始 session（§13）
        session = newSessionRecord({ repoRoot, maxPaidRuns, reason: 'initial' });
        console.log(`[paid-run-guard] REAL_AI_SESSION_CREATED sessionId=${session.sessionId} maxPaidRuns=${session.maxPaidRuns} reason=initial`);
      } else if (!sameContext(session) || !withinTtl(session)) {
        if (!allowNew) {
          const why = !sameContext(session) ? 'SESSION_CONTEXT_CHANGED (repo HEAD/root 不同)' : 'SESSION_TTL_EXPIRED';
          return { ok: false, code: 'REAL_AI_NEW_SESSION_REQUIRES_OVERRIDE', detail: why, providerCallsStarted: 0 };
        }
        session = newSessionRecord({ repoRoot, maxPaidRuns, reason: 'explicit_user_or_operator_override' });
        // §17：Override 必须留下日志
        console.log(`[paid-run-guard] NEW_PAID_TEST_SESSION_CREATED sessionId=${session.sessionId} reason=explicit_user_or_operator_override`);
      }
      if (session.paidRunsStarted >= session.maxPaidRuns) {
        // 写回（首次创建场景也要落盘）后再拒绝
        atomicWriteJson(sessionFilePath(dir, session.sessionId), session);
        atomicWriteJson(activeSessionPath(dir), { sessionId: session.sessionId, updatedAt: new Date().toISOString() });
        return {
          ok: false,
          code: 'REAL_AI_ATTEMPT_LIMIT_EXCEEDED',
          paidRunsStarted: session.paidRunsStarted,
          maxPaidRuns: session.maxPaidRuns,
          sessionId: session.sessionId,
          providerCallsStarted: 0   // §11/§22：绝无 Provider 调用机会
        };
      }
      session.paidRunsStarted += 1;
      session.runs.push({
        startedAt: new Date().toISOString(),
        connectionId: meta.connectionId || null,
        model: meta.model || null,
        reason: meta.reason || 'real-ai-orchestrator-smoke'
      });
      atomicWriteJson(sessionFilePath(dir, session.sessionId), session);
      atomicWriteJson(activeSessionPath(dir), { sessionId: session.sessionId, updatedAt: new Date().toISOString() });
      return {
        ok: true,
        paidRunsStarted: session.paidRunsStarted,
        maxPaidRuns: session.maxPaidRuns,
        sessionId: session.sessionId
      };
    } finally {
      release();
    }
  }

  /** §16/§18：override 只认外部环境传入，guard 自身绝不发明。 */
  function o_allowNewFromEnv() {
    return process.env.REAL_AI_ALLOW_NEW_SESSION === '1';
  }

  /** 显式创建新 Session（new-session 命令；等价于人工 override，必留日志）。 */
  function forceNewSession(reason) {
    return acquireSession({ allowNew: true, force: true, newReason: reason || 'explicit_new_session_command' });
  }

  /** 关闭/重置（测试与运维用；删除 active 指针与对应 session 文件）。 */
  function closeSession() {
    let release;
    try {
      release = acquireSessionLock(dir);
    } catch (e) {
      return { ok: false, code: 'REAL_AI_SESSION_LOCKED', detail: e.message };
    }
    try {
      const s = loadActive();
      if (s) {
        try { fs.unlinkSync(sessionFilePath(dir, s.sessionId)); } catch { /* noop */ }
      }
      try { fs.unlinkSync(activeSessionPath(dir)); } catch { /* noop */ }
      return { ok: true };
    } finally {
      release();
    }
  }

  return { inspect, acquireSession, reservePaidRun, forceNewSession, closeSession, sessionDir: dir };
}

module.exports = {
  createRealAiPaidRunGuard,
  DEFAULT_MAX_PAID_RUNS,
  SESSION_TTL_MS,
  ACTIVE_SESSION_FILE
};
