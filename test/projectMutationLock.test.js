'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createProjectMutationLock } = require('../src/security/projectMutationLock');

test.describe('ProjectMutationLock', () => {
  let lock;

  test.beforeEach(() => {
    lock = createProjectMutationLock();
  });

  test('write lock acquisition succeeds when no lock held', () => {
    const result = lock.acquireWrite('/project/a', 'run-1', 'cline');
    assert.ok(result.ok);
    // path.resolve() canonicalizes to OS-native absolute path (e.g. D:\project\a on Windows)
    assert.equal(result.lock.projectRoot, path.resolve('/project/a'));
  });

  test('second write lock on same project fails', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    const result = lock.acquireWrite('/project/a', 'run-2', 'opencode');
    assert.ok(!result.ok);
    assert.equal(result.lockHolder.runId, 'run-1');
  });

  test('write lock on different project succeeds', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    const result = lock.acquireWrite('/project/b', 'run-2', 'opencode');
    assert.ok(result.ok);
  });

  test('read lock succeeds when no write lock held', () => {
    const result = lock.acquireRead('/project/a', 'run-1', 'review-agent');
    assert.ok(result.ok);
  });

  test('multiple read locks on same project succeed', () => {
    lock.acquireRead('/project/a', 'run-1', 'review-a');
    const result = lock.acquireRead('/project/a', 'run-2', 'review-b');
    assert.ok(result.ok);
  });

  test('read lock fails when write lock held', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    const result = lock.acquireRead('/project/a', 'run-2', 'review-agent');
    assert.ok(!result.ok);
  });

  test('write lock fails when read locks held', () => {
    lock.acquireRead('/project/a', 'run-1', 'review-a');
    const result = lock.acquireWrite('/project/a', 'run-2', 'cline');
    assert.ok(!result.ok);
  });

  test('release allows new write lock', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    lock.release('run-1');
    const result = lock.acquireWrite('/project/a', 'run-2', 'opencode');
    assert.ok(result.ok);
  });

  test('release read lock allows write lock', () => {
    lock.acquireRead('/project/a', 'run-1', 'review-a');
    lock.release('run-1');
    const result = lock.acquireWrite('/project/a', 'run-2', 'cline');
    assert.ok(result.ok);
  });

  test('isBusy returns true when write lock held', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    assert.equal(lock.isBusy('/project/a'), true);
  });

  test('isBusy returns false when only read locks held', () => {
    lock.acquireRead('/project/a', 'run-1', 'review');
    assert.equal(lock.isBusy('/project/a'), false);
  });

  test('getLockHolder returns lock info', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    const holder = lock.getLockHolder('/project/a');
    assert.equal(holder.runId, 'run-1');
    assert.equal(holder.agentId, 'cline');
  });

  test('getLockHolder returns null when no lock', () => {
    assert.equal(lock.getLockHolder('/project/a'), null);
  });

  test('listBusy returns all write-locked projects', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    lock.acquireWrite('/project/b', 'run-2', 'opencode');
    const busy = lock.listBusy();
    assert.equal(busy.length, 2);
  });

  test('waitForLock resolves when lock released', async () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    setTimeout(() => lock.release('run-1'), 100);
    const result = await lock.waitForLock('/project/a', 5000);
    assert.equal(result, true);
  });

  test('waitForLock times out', async () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    const result = await lock.waitForLock('/project/a', 200);
    assert.equal(result, false);
  });

  test('canonical path resolution', () => {
    lock.acquireWrite('/project/../project/a', 'run-1', 'cline');
    // Should be same as /project/a after resolve
    const result = lock.acquireWrite(path.resolve('/project/a'), 'run-2', 'opencode');
    assert.ok(!result.ok); // Should be blocked
  });

  test('clearAll releases all locks', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    lock.acquireWrite('/project/b', 'run-2', 'opencode');
    lock.clearAll();
    assert.equal(lock.listBusy().length, 0);
  });

  test('cancel scenario: release on cancel', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    // Simulate cancel
    lock.release('run-1');
    // New agent should be able to acquire
    const result = lock.acquireWrite('/project/a', 'run-2', 'opencode');
    assert.ok(result.ok);
  });

  test('crash scenario: clearAll on startup', () => {
    lock.acquireWrite('/project/a', 'run-1', 'cline');
    // Simulate app restart — all in-memory locks cleared
    lock.clearAll();
    assert.equal(lock.isBusy('/project/a'), false);
  });
});
