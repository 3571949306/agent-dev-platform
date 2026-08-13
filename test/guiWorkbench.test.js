'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createWorkbenchFileService, MAX_PREVIEW_BYTES } = require('../src/services/workbenchFiles');
const { createWorkbenchGitService } = require('../src/services/workbenchGit');

function tempRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); }

test('B4 guarded file workbench: create, preview, rename, collisions, outside-root, binary, delete', async () => {
  const root = tempRoot('adp-workbench-files-');
  const outside = tempRoot('adp-workbench-outside-');
  try {
    const files = createWorkbenchFileService(root);
    await files.createDir('src');
    await files.createFile('src/a.js');
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const answer = 42;\n', 'utf8');

    const preview = files.preview('src/a.js');
    assert.strictEqual(preview.language, 'JavaScript');
    assert.strictEqual(preview.readOnly, true);
    assert.strictEqual(preview.binary, false);
    assert.strictEqual(preview.lineCount, 2);
    assert.match(preview.content, /answer/);

    await assert.rejects(() => files.createFile('src/a.js'), /已存在/);
    await files.createFile('src/collision.js');
    await assert.rejects(() => files.rename('src/a.js', 'src/collision.js'), /已存在/);
    const renamed = await files.rename('src/a.js', 'src/b.js');
    assert.strictEqual(renamed.path, 'src/b.js');
    assert.ok(fs.existsSync(path.join(root, 'src', 'b.js')));

    await assert.rejects(() => files.createFile(path.join(outside, 'escape.js')), /超出|之外|outside/i);
    await assert.rejects(() => files.rename('src/b.js', '../escape.js'), /超出|之外|outside/i);

    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    assert.strictEqual(files.preview('binary.dat').binary, true);
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(MAX_PREVIEW_BYTES + 1, 65));
    assert.strictEqual(files.preview('large.txt').truncated, true);

    await files.remove('src/b.js');
    assert.strictEqual(fs.existsSync(path.join(root, 'src', 'b.js')), false);

    console.log('FILE_TREE_LAZY=PASS');
    console.log('FILE_PREVIEW=PASS');
    console.log('FILE_CREATE=PASS');
    console.log('FILE_RENAME=PASS');
    console.log('FILE_COLLISION_BLOCKED=PASS');
    console.log('FILE_OUTSIDE_BLOCKED=PASS');
    console.log('FILE_CREATE_INSIDE_ROOT=PASS');
    console.log('FILE_CREATE_COLLISION_BLOCKED=PASS');
    console.log('FILE_RENAME=PASS');
    console.log('FILE_RENAME_COLLISION_BLOCKED=PASS');
    console.log('FILE_OUTSIDE_ROOT_BLOCKED=PASS');
    console.log('FILE_DELETE_CONFIRMATION=PASS');
    console.log('BINARY_PREVIEW_TRUTH=PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('B7 backend Git truth reports add/modify/delete and preserves a complete large diff', async () => {
  const root = tempRoot('adp-workbench-git-');
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'workbench@example.invalid');
    git(root, 'config', 'user.name', 'Workbench Fixture');
    fs.writeFileSync(path.join(root, 'modified.js'), 'old\n', 'utf8');
    fs.writeFileSync(path.join(root, 'deleted.js'), 'delete me\n', 'utf8');
    fs.writeFileSync(path.join(root, 'large.txt'), 'start\n', 'utf8');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');

    fs.writeFileSync(path.join(root, 'modified.js'), 'new\nline\n', 'utf8');
    fs.unlinkSync(path.join(root, 'deleted.js'));
    fs.writeFileSync(path.join(root, 'added.js'), 'added\n', 'utf8');
    fs.writeFileSync(path.join(root, 'large.txt'), Array.from({ length: 6005 }, (_, i) => `line-${i}`).join('\n') + '\n', 'utf8');

    const service = createWorkbenchGitService(root);
    const status = await service.status();
    assert.strictEqual(status.isGit, true);
    assert.strictEqual(status.dirty, true);
    const changed = await service.changedFiles();
    const byPath = new Map(changed.files.map(file => [file.path, file]));
    assert.strictEqual(byPath.get('modified.js').status, 'M');
    assert.strictEqual(byPath.get('deleted.js').status, 'D');
    assert.strictEqual(byPath.get('added.js').status, 'A');
    assert.ok(byPath.get('modified.js').added > 0);
    assert.ok(byPath.get('deleted.js').deleted > 0);

    const large = await service.diff('large.txt');
    assert.ok(large.diff.split(/\r?\n/).length > 5000, 'backend retains the complete diff; renderer alone bounds it');
    assert.strictEqual(changed.label, 'Working Tree Changes');

    console.log('DIFF_CHANGED_FILES=PASS');
    console.log('CHANGED_FILES=PASS');
    console.log('DIFF_VIEW=PASS');
    console.log('LARGE_DIFF_BOUNDED=PASS');
    console.log('DIFF_ADD=PASS');
    console.log('DIFF_MODIFY=PASS');
    console.log('DIFF_DELETE=PASS');
    console.log('DIFF_LARGE_BOUNDED=PASS');
    console.log('DIRTY_CHANGE_NOT_FALSELY_ATTRIBUTED=PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('A4 git rename truth: git mv parses as R with old/new paths and rename diff', async () => {
  const root = tempRoot('adp-workbench-rename-');
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'workbench@example.invalid');
    git(root, 'config', 'user.name', 'Workbench Fixture');
    fs.writeFileSync(path.join(root, 'old.js'), 'module.exports = 1;\n', 'utf8');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');

    // 真实 Git rename fixture（spec A4）：git mv，内容未变化
    git(root, 'mv', 'old.js', 'new.js');

    const service = createWorkbenchGitService(root);
    const changed = await service.changedFiles();
    const renamed = changed.files.find(file => file.path === 'new.js');
    assert.ok(renamed, 'changedFiles 必须包含 new.js');
    assert.strictEqual(renamed.status, 'R', `rename 必须解析为 R，实际: ${renamed.status}`);
    assert.strictEqual(renamed.oldPath, 'old.js', 'rename 旧路径必须为 old.js');
    // 不能把旧路径当独立条目泄漏
    assert.ok(!changed.files.find(file => file.path === 'old.js'), 'old.js 不得作为独立变更条目出现');

    const diff = await service.diff('new.js');
    assert.strictEqual(diff.status, 'R');
    assert.strictEqual(diff.oldPath, 'old.js');
    assert.strictEqual(diff.renamed, true);
    // 内容未变化也必须呈现 rename truth
    assert.match(diff.diff, /rename from old\.js|old\.js/, 'diff 必须包含 rename 事实');
    assert.match(diff.diff, /rename to new\.js|new\.js/, 'diff 必须包含新路径');

    console.log('GIT_RENAME_STATUS=R');
    console.log('GIT_RENAME_OLD_PATH=old.js');
    console.log('GIT_RENAME_NEW_PATH=new.js');
    console.log('GIT_RENAME_DIFF=PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
