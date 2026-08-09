'use strict';
/**
 * ProjectMutationLock — 项目级写锁，防止两个会修改文件的 Agent 并发操作同一 projectRoot。
 *
 * 锁模型：
 *   - 写锁（exclusive）：coding / filesystem.write / terminal mutation 任务必须先获取。
 *     同一 projectRoot 上已有任意锁（读或写）时，新的写锁获取失败。
 *   - 读锁（shared）：readOnly 任务（review / research / analysis）可并行持有。
 *     同一 projectRoot 上可叠加多个读锁；但已存在写锁时，新的读锁获取失败。
 *
 * 锁对象：{ projectRoot, runId, agentId, acquiredAt, mode: 'write'|'read' }
 *
 * 锁仅存在于内存（Map），不持久化到 SQLite。App 启动时调用 clearAll() 清理上次崩溃残留。
 *
 * 集成：在 agentHub.start(agentId, task) 之前，根据 task 是否 readOnly 决定获取读 / 写锁。
 *   获取失败时返回 { error: 'PROJECT_LOCKED', lockHolder, message: '正在等待项目写锁...' }。
 *   Run 完成 / 取消 / 失败 / 超时 / 崩溃后调用 release(runId) 释放。
 *
 * v2.9 计划引入 Worktree Parallel Coding，届时不修改文件的 Agent 可在独立 worktree 中并行，
 * 此锁将退化为对“主 worktree”的写互斥。
 */

const path = require('path');
const fs = require('fs');

/** 默认 waitForLock 超时（毫秒）。 */
const DEFAULT_WAIT_TIMEOUT_MS = 30000;

/** 轮询间隔（毫秒）——waitForLock 用 setTimeout 轮询，避免 setImmediate 饥饿。 */
const WAIT_POLL_INTERVAL_MS = 50;

/**
 * 把任意路径归一化为 canonical absolute path，作为锁 key。
 *
 * 必须满足 spec §44 / §45：
 *   - realpath：解析 symlink / junction 到真实目标，防止 `A\link → B` 绕过同一把锁；
 *   - case-insensitive：Windows 路径大小写不敏感，`D:\Project` 与 `d:\project` 视为同一 root；
 *   - normalize：`./a/../b` 与 `/b` 映射到同一 key。
 *
 * 路径不存在时（如尚未 clone 的 projectRoot）realpath 会失败，回退到 path.resolve，
 * 仍保证 normalize + case-insensitive，避免锁泄漏。
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
function canonical(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') return null;
  let resolved;
  try {
    // 优先解析符号链接 / junction 到真实目标（§45），让 A\link 与 A 真实根共享一把锁
    resolved = fs.realpathSync.native(projectRoot);
  } catch {
    try { resolved = path.resolve(projectRoot); } catch { return null; }
  }
  // Windows 路径大小写不敏感：归一化为小写 key，避免 D:\Project 与 d:\project 视作不同（§44）
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
}

/**
 * 创建 ProjectMutationLock 实例。
 * @returns {object} lock 实例
 */
function createProjectMutationLock() {
  // key: canonical projectRoot -> Lock（写锁时为单个 Lock；读锁时为该 root 上的所有读锁，存于 readLocks）
  // writeLocks: Map<projectRoot, Lock>
  // readLocks:  Map<projectRoot, Map<runId, Lock>>
  const writeLocks = new Map();
  const readLocks = new Map();
  // runId -> { projectRoot, mode } 反查表，方便 release(runId) 定位
  const runIndex = new Map();

  // waitForLock 的等待者队列：projectRoot -> Array<{ resolve }>}
  const waiters = new Map();

  /** 触发该 projectRoot 上所有 waitForLock 等待者重新尝试获取。 */
  function notifyWaiters(projectRoot) {
    const key = canonical(projectRoot);
    if (!key) return;
    const list = waiters.get(key);
    if (!list || !list.length) return;
    // 复制一份再清空，避免回调里再次 push 造成死循环
    const pending = list.splice(0, list.length);
    for (const w of pending) {
      try { w.resolve(); } catch { /* noop */ }
    }
  }

  /**
   * 获取写锁（排他）。
   * 同一 projectRoot 上已存在任意锁（读或写）时失败。
   * @param {string} projectRoot
   * @param {string} runId
   * @param {string} agentId
   * @returns {{ ok: true, lock: object } | { ok: false, lockHolder: { runId, agentId, acquiredAt } | null }}
   */
  function acquireWrite(projectRoot, runId, agentId) {
    const key = canonical(projectRoot);
    if (!key) return { ok: false, lockHolder: null };

    // 同一 runId 已持锁——幂等返回当前持有的锁（避免重复获取误判）
    const existing = runIndex.get(runId);
    if (existing && existing.projectRoot === key) {
      // 已持读锁：写升级不允许，需先 release 再 acquireWrite
      if (existing.mode === 'read') {
        return { ok: false, lockHolder: null };
      }
      // 已持写锁：幂等成功
      const lk = writeLocks.get(key);
      if (lk) return { ok: true, lock: lk };
    }

    // 已有写锁
    if (writeLocks.has(key)) {
      const wl = writeLocks.get(key);
      return {
        ok: false,
        lockHolder: { runId: wl.runId, agentId: wl.agentId, acquiredAt: wl.acquiredAt }
      };
    }
    // 已有任意读锁
    const readers = readLocks.get(key);
    if (readers && readers.size > 0) {
      // 读锁阻塞写锁：返回其中一个读锁持有者作为提示（取第一个稳定 entry）
      const first = readers.values().next().value;
      return {
        ok: false,
        lockHolder: { runId: first.runId, agentId: first.agentId, acquiredAt: first.acquiredAt }
      };
    }

    const lock = {
      projectRoot: key,
      runId,
      agentId,
      acquiredAt: Date.now(),
      mode: 'write'
    };
    writeLocks.set(key, lock);
    runIndex.set(runId, { projectRoot: key, mode: 'write' });
    return { ok: true, lock };
  }

  /**
   * 获取读锁（共享）。
   * 同一 projectRoot 上已存在写锁时失败；已有读锁时可叠加。
   * @param {string} projectRoot
   * @param {string} runId
   * @param {string} agentId
   * @returns {{ ok: true, lock: object } | { ok: false, lockHolder: { runId, agentId, acquiredAt } | null }}
   */
  function acquireRead(projectRoot, runId, agentId) {
    const key = canonical(projectRoot);
    if (!key) return { ok: false, lockHolder: null };

    // 同一 runId 已持写锁：不允许降级为读锁（避免歧义）
    const existing = runIndex.get(runId);
    if (existing && existing.projectRoot === key && existing.mode === 'write') {
      const wl = writeLocks.get(key);
      return {
        ok: false,
        lockHolder: wl ? { runId: wl.runId, agentId: wl.agentId, acquiredAt: wl.acquiredAt } : null
      };
    }
    // 同一 runId 已持读锁：幂等成功
    if (existing && existing.projectRoot === key && existing.mode === 'read') {
      const readers = readLocks.get(key);
      const lk = readers && readers.get(runId);
      if (lk) return { ok: true, lock: lk };
    }

    // 已有写锁：读锁阻塞
    if (writeLocks.has(key)) {
      const wl = writeLocks.get(key);
      return {
        ok: false,
        lockHolder: { runId: wl.runId, agentId: wl.agentId, acquiredAt: wl.acquiredAt }
      };
    }

    let readers = readLocks.get(key);
    if (!readers) {
      readers = new Map();
      readLocks.set(key, readers);
    }
    const lock = {
      projectRoot: key,
      runId,
      agentId,
      acquiredAt: Date.now(),
      mode: 'read'
    };
    readers.set(runId, lock);
    runIndex.set(runId, { projectRoot: key, mode: 'read' });
    return { ok: true, lock };
  }

  /**
   * 释放 runId 持有的锁（读或写）。
   * 释放后唤醒等待该 projectRoot 的 waitForLock 等待者。
   * @param {string} runId
   * @returns {boolean} 是否真的释放了一把锁
   */
  function release(runId) {
    const entry = runIndex.get(runId);
    if (!entry) return false;
    const key = entry.projectRoot;

    if (entry.mode === 'write') {
      const wl = writeLocks.get(key);
      if (wl && wl.runId === runId) {
        writeLocks.delete(key);
        runIndex.delete(runId);
        notifyWaiters(key);
        return true;
      }
      // 写锁已被其它机制清掉，仅清理索引
      runIndex.delete(runId);
      return false;
    }

    // 读锁
    const readers = readLocks.get(key);
    if (readers) {
      if (readers.delete(runId)) {
        if (readers.size === 0) readLocks.delete(key);
        runIndex.delete(runId);
        // 读锁全部释放后，写锁等待者才能成功
        if (!readers.size) notifyWaiters(key);
        return true;
      }
    }
    runIndex.delete(runId);
    return false;
  }

  /**
   * projectRoot 上是否持有写锁。
   * @param {string} projectRoot
   * @returns {boolean}
   */
  function isBusy(projectRoot) {
    const key = canonical(projectRoot);
    if (!key) return false;
    return writeLocks.has(key);
  }

  /**
   * 获取 projectRoot 上的写锁持有者信息。
   * @param {string} projectRoot
   * @returns {{ runId, agentId, acquiredAt } | null}
   */
  function getLockHolder(projectRoot) {
    const key = canonical(projectRoot);
    if (!key) return null;
    const wl = writeLocks.get(key);
    if (!wl) return null;
    return { runId: wl.runId, agentId: wl.agentId, acquiredAt: wl.acquiredAt };
  }

  /**
   * 列出所有持有写锁的 projectRoot。
   * @returns {Array<{ projectRoot, runId, agentId, acquiredAt }>}
   */
  function listBusy() {
    const out = [];
    for (const wl of writeLocks.values()) {
      out.push({
        projectRoot: wl.projectRoot,
        runId: wl.runId,
        agentId: wl.agentId,
        acquiredAt: wl.acquiredAt
      });
    }
    return out;
  }

  /**
   * 等待 projectRoot 上的写锁被释放（之后并不自动获取——
   * 调用方在 resolve 后需自行 acquireWrite/acquireRead，存在 race，但本锁仅做"可用性提示"）。
   *
   * 注意：本方法只表明"当前无写锁"，调用方随后应再次调用 acquire* 完成实际获取。
   *
   * @param {string} projectRoot
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<boolean>} true 表示超时前写锁已释放；false 表示超时
   */
  function waitForLock(projectRoot, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    const key = canonical(projectRoot);
    if (!key) return Promise.resolve(false);

    // 已无写锁，立即返回
    if (!writeLocks.has(key)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;

      const done = (ok) => {
        if (settled) return;
        settled = true;
        // 从等待者列表中移除（如果还在）
        const list = waiters.get(key);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          if (!list.length) waiters.delete(key);
        }
        clearTimeout(timer);
        resolve(ok);
      };

      // 等待者 entry：notifyWaiters 触发后立刻探测一次
      const entry = { resolve: () => {
        if (settled) return;
        if (!writeLocks.has(key)) done(true);
        else if (Date.now() >= deadline) done(false);
      } };

      let list = waiters.get(key);
      if (!list) { list = []; waiters.set(key, list); }
      list.push(entry);

      // 超时兜底
      const timer = setTimeout(() => {
        done(false);
      }, timeoutMs);
    });
  }

  /**
   * 清空所有锁（App 启动时调用，清理上次崩溃残留）。
   * waitForLock 等待者会被全部唤醒（视为可用）。
   */
  function clearAll() {
    const keys = new Set([...writeLocks.keys(), ...readLocks.keys()]);
    writeLocks.clear();
    readLocks.clear();
    runIndex.clear();
    for (const key of keys) notifyWaiters(key);
  }

  /** 调试 / 测试辅助：返回当前快照（不暴露内部 Map 引用）。 */
  function snapshot() {
    return {
      writeLocks: Array.from(writeLocks.values()).map(lk => ({ ...lk })),
      readLocks: Array.from(readLocks.entries()).map(([k, m]) => ({
        projectRoot: k,
        holders: Array.from(m.values()).map(lk => ({ ...lk }))
      }))
    };
  }

  return {
    acquireWrite,
    acquireRead,
    release,
    isBusy,
    getLockHolder,
    listBusy,
    waitForLock,
    clearAll,
    snapshot
  };
}

module.exports = { createProjectMutationLock, DEFAULT_WAIT_TIMEOUT_MS };
