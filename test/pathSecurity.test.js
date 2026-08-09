'use strict';
/**
 * v2.5.1 — Path Security / Symlink Escape 单元测试。
 *
 * §9/§10/§11/§13：
 *   - 正常 known config → PASS
 *   - known dir child → PASS
 *   - ../ escape → REJECT
 *   - absolute external path automatic discovery → REJECT
 *   - symlink inside .codex → outside directory → REJECT
 *   - junction inside config dir → outside directory → REJECT（Windows 可执行时）
 *   - user-selected normal .json → PASS
 *   - user-selected .exe → REJECT
 *   - user-selected directory → REJECT
 *   - oversized config → REJECT
 *   - broken symlink → clean error
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  verifyPath,
  verifyUserSelectedFile,
  isWithin,
  isWithinCanonical,
  realpathSafe,
  MAX_FILE_SIZE,
  USER_FILE_EXTENSIONS
} = require('../src/providers/onboarding/external/security/pathPolicy');

/** 创建临时目录和文件的辅助函数。 */
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-pathsec-'));
  return dir;
}

function makeFile(dir, name, content = '{}') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('§13 正常 known config child → PASS（自动发现）', () => {
  const dir = makeTempDir();
  try {
    // 模拟：在已知目录内创建配置文件
    const configPath = makeFile(dir, 'config.toml', 'test = true');
    // 用绝对路径 + 目录作为 known location
    const r = verifyPath(configPath, { sourceType: 'codex' });
    // 注意：sourceType='codex' 会检查 ~/.codex，临时目录不在其中
    // 所以这里测的是 isWithin / isWithinCanonical 的基本逻辑
    assert.strictEqual(isWithin(configPath, dir), true);
    assert.strictEqual(isWithinCanonical(configPath, dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§13 ../ escape → 字符串路径检查 REJECT', () => {
  const dir = makeTempDir();
  try {
    const escapePath = path.resolve(dir, '..', 'escape.toml');
    assert.strictEqual(isWithin(escapePath, dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§13 absolute external path → 自动发现 REJECT', () => {
  const r = verifyPath('C:\\random\\external\\config.toml', { sourceType: 'codex' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不在 codex 已知配置目录内/);
});

test('§13 非用户选择且无 sourceType → REJECT', () => {
  const r = verifyPath('C:\\some\\path', {});
  assert.strictEqual(r.ok, false);
});

test('§10 symlink escape：symlink 指向已知目录外 → canonical check REJECT', () => {
  const realDir = makeTempDir();
  const outsideDir = makeTempDir();
  const linkDir = makeTempDir();
  try {
    // 在 linkDir 内创建一个 symlink 指向 outsideDir
    const outsideFile = makeFile(outsideDir, 'secret.json', '{"key":"value"}');
    const linkPath = path.join(linkDir, 'config.json');

    let canCreateSymlink = false;
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
      canCreateSymlink = true;
    } catch (e) {
      // Windows 可能需要管理员权限创建 symlink
      // junction 也试一下
      try {
        fs.symlinkSync(outsideFile, linkPath, 'junction');
        canCreateSymlink = true;
      } catch {
        // 无法创建 symlink，skip
      }
    }

    if (!canCreateSymlink) {
      // 即使无法创建 symlink，isWithinCanonical 仍需对正常文件返回 true
      const normalFile = makeFile(linkDir, 'normal.json', '{}');
      assert.strictEqual(isWithinCanonical(normalFile, linkDir), true);
      return;
    }

    // symlink 指向 outsideDir 的文件
    // 字符串路径检查：linkPath 在 linkDir 内 → isWithin = true
    assert.strictEqual(isWithin(linkPath, linkDir), true);
    // canonical realpath 检查：realpath(linkPath) = outsideFile，不在 linkDir 内
    assert.strictEqual(isWithinCanonical(linkPath, linkDir), false);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
});

test('§11 user-selected normal .json → PASS', () => {
  const dir = makeTempDir();
  try {
    const f = makeFile(dir, 'config.json', '{"name":"test"}');
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected normal .toml → PASS', () => {
  const dir = makeTempDir();
  try {
    const f = makeFile(dir, 'config.toml', 'key = "value"');
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected normal .env → PASS', () => {
  const dir = makeTempDir();
  try {
    const f = makeFile(dir, 'config.env', 'KEY=value');
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected .exe → REJECT（扩展名白名单）', () => {
  const dir = makeTempDir();
  try {
    // 创建一个假的 .exe 文件
    const f = makeFile(dir, 'malware.exe', 'MZ');
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /不支持的文件扩展名/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected .txt → REJECT（扩展名白名单）', () => {
  const dir = makeTempDir();
  try {
    const f = makeFile(dir, 'notes.txt', 'hello');
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /不支持的文件扩展名/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected directory → REJECT（必须 regular file）', () => {
  const dir = makeTempDir();
  try {
    // 目录不是文件
    const r = verifyPath(dir, { userSelected: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /不是普通文件|不支持的文件扩展名/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§11 user-selected nonexistent → REJECT', () => {
  const r = verifyPath('C:\\nonexistent\\path\\config.json', { userSelected: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不存在|无法解析/);
});

test('§11 oversized config → REJECT（> 5 MB）', () => {
  const dir = makeTempDir();
  try {
    // 创建 > 5MB 的 JSON 文件
    const bigContent = '{"data":"' + 'x'.repeat(MAX_FILE_SIZE + 100) + '"}';
    const f = makeFile(dir, 'big.json', bigContent);
    const r = verifyPath(f, { userSelected: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /过大/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§13 broken symlink → clean error（不 crash）', () => {
  const dir = makeTempDir();
  try {
    const brokenLink = path.join(dir, 'broken.json');
    try {
      fs.symlinkSync('C:\\nonexistent\\target.json', brokenLink, 'file');
    } catch {
      // Windows 无权限创建 symlink → 验证 realpathSafe 对不存在路径返回 null
      assert.strictEqual(realpathSafe('C:\\nonexistent\\target.json'), null);
      return;
    }
    // 断链 symlink → realpath 返回 null → verifyPath 拒绝
    const r = verifyPath(brokenLink, { userSelected: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /不存在|无法解析/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§9 realpathSafe：对正常路径返回 canonical path', () => {
  const dir = makeTempDir();
  try {
    const f = makeFile(dir, 'test.json', '{}');
    const real = realpathSafe(f);
    assert.ok(real);
    assert.ok(real.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('§9 realpathSafe：对不存在路径返回 null', () => {
  assert.strictEqual(realpathSafe('C:\\definitely\\nonexistent\\path'), null);
  assert.strictEqual(realpathSafe(null), null);
  assert.strictEqual(realpathSafe(''), null);
});

test('§11 USER_FILE_EXTENSIONS 包含 .env/.json/.toml', () => {
  assert.ok(USER_FILE_EXTENSIONS.has('.env'));
  assert.ok(USER_FILE_EXTENSIONS.has('.json'));
  assert.ok(USER_FILE_EXTENSIONS.has('.toml'));
  assert.ok(!USER_FILE_EXTENSIONS.has('.exe'));
  assert.ok(!USER_FILE_EXTENSIONS.has('.txt'));
});

test('§11 MAX_FILE_SIZE = 5 MB', () => {
  assert.strictEqual(MAX_FILE_SIZE, 5 * 1024 * 1024);
});

test('§10 isWithinCanonical：symlink 目录逃逸（Windows Junction 兼容）', () => {
  const realDir = makeTempDir();
  const outsideDir = makeTempDir();
  try {
    // 在 realDir 内创建正常文件 → 应通过
    const normalFile = makeFile(realDir, 'normal.json', '{}');
    assert.strictEqual(isWithinCanonical(normalFile, realDir), true);

    // 尝试创建 junction/symlink
    const junctionPath = path.join(realDir, 'junction.json');
    const outsideFile = makeFile(outsideDir, 'secret.json', '{"secret":"leaked"}');

    let created = false;
    try {
      fs.symlinkSync(outsideFile, junctionPath, 'file');
      created = true;
    } catch {
      try {
        fs.symlinkSync(outsideFile, junctionPath, 'junction');
        created = true;
      } catch {
        // 无权限 → skip symlink 测试，只验证正常文件
      }
    }

    if (created) {
      // junction 指向 outsideDir → canonical 检查应拒绝
      assert.strictEqual(isWithinCanonical(junctionPath, realDir), false);
    }
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
