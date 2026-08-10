'use strict';
/**
 * test/canonicalPathSecurity.test.js
 *
 * v2.8.2 Canonical Path Security（spec §86-§91）。
 *
 * 覆盖：
 *   §86 primitive cases（inside/outside/nonexistent/case/prefix/dotdot/junction/broken/rename）
 *   §87 Windows Real Junction（fs.symlinkSync junction，非 mock）
 *   §88 Fixture + Real FS 两类
 *   §89 Conditional Platform Tests（Windows junction / 非 Windows symlink）
 *   §91 TOCTOU deterministic test（execution-time recheck denial）
 *   §40/§41 junction parent + nonexistent leaf / multi tail
 *   §38 inside→inside symlink allowed
 *   §39 root itself junction
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../src/security/pathSecurity');
const { createPathSecurity, CODE, PathSecurityError } = ps;

const isWin = process.platform === 'win32';

/** 创建临时目录并 realpath 统一为长名（避免 Windows 8.3 短名干扰 lexical 比较）。 */
function makeRoot(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cps-')));
}
function makeFile(dir, name, content = 'x') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
function makeDir(dir, name) {
  const p = name ? path.join(dir, name) : dir;
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 尝试创建 junction（Windows）/ symlink（其他平台），失败返回 null。 */
function tryCreateLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type || (isWin ? 'junction' : 'dir'));
    return link;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// §86 Primitive cases
// ---------------------------------------------------------------------------

test('§86 normal inside existing → ALLOW', () => {
  const root = makeRoot('in-');
  try {
    const sub = makeDir(root, 'src');
    const f = makeFile(sub, 'a.js');
    const r = ps.checkPathContainment(root, f);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.targetExists, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§86 normal outside existing → DENY OUTSIDE_ROOT', () => {
  const root = makeRoot('root-');
  const outside = makeRoot('out-');
  try {
    const f = makeFile(outside, 'x.txt');
    const r = ps.checkPathContainment(root, f);
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.OUTSIDE_ROOT);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§86 nonexistent inside → ALLOW', () => {
  const root = makeRoot('ne-');
  try {
    const sub = makeDir(root, 'src');
    const r = ps.checkPathContainment(root, path.join(sub, 'new', 'deep', 'file.js'));
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.targetExists, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§86 nonexistent outside (absolute) → DENY', () => {
  const root = makeRoot('neo-');
  const outside = makeRoot('neo2-');
  try {
    const r = ps.checkPathContainment(root, path.join(outside, 'nope.txt'));
    assert.strictEqual(r.allowed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§46 root case variation (Windows) → same root', () => {
  if (!isWin) return; // §89 conditional
  const root = makeRoot('case-');
  try {
    const sub = makeDir(root, 'src');
    const f = makeFile(sub, 'a.js');
    // root 大写、target 小写 → 仍应识别为同一 root
    const r = ps.checkPathContainment(root.toUpperCase(), f.toLowerCase());
    assert.strictEqual(r.allowed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§45 prefix collision → DENY', () => {
  const root = makeRoot('pre-');
  try {
    const fakeRoot = root + '-old';
    makeDir(fakeRoot);
    const r = ps.checkPathContainment(root, path.join(fakeRoot, 'f.txt'));
    assert.strictEqual(r.allowed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§43 dotdot escape → DENY', () => {
  const root = makeRoot('dd-');
  try {
    const sub = makeDir(root, 'src');
    const r = ps.checkPathContainment(root, path.join(sub, '..', '..', 'escape.txt'));
    assert.strictEqual(r.allowed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§14 nonexistent root → ROOT_INVALID', () => {
  const r = ps.checkPathContainment(path.join(os.tmpdir(), 'definitely-not-exist-cps'), 'a.js');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.errorCode, CODE.ROOT_INVALID);
});

test('§14 root is file → ROOT_INVALID', () => {
  const dir = makeRoot('rf-');
  try {
    const f = makeFile(dir, 'file.txt');
    const r = ps.checkPathContainment(f, 'b.js');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.ROOT_INVALID);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// §87 Windows Real Junction / §89 symlink tests
// ---------------------------------------------------------------------------

test('§38/§87 junction inside→inside → ALLOW', () => {
  const root = makeRoot('ji-');
  try {
    const sub = makeDir(root, 'src');
    makeFile(sub, 'a.js');
    const backInside = path.join(root, 'backinside');
    const link = tryCreateLink(sub, backInside);
    if (!link) { console.log('  [skip] cannot create junction/symlink'); return; }
    const r = ps.checkPathContainment(root, path.join(backInside, 'a.js'));
    assert.strictEqual(r.allowed, true, 'inside→inside symlink 应允许');
    fs.rmSync(backInside, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§6/§22 junction inside→outside → DENY REPARSE_ESCAPE', () => {
  const root = makeRoot('jo-');
  const outside = makeRoot('jo2-');
  try {
    const junction = path.join(root, 'jlink');
    const link = tryCreateLink(outside, junction);
    if (!link) { console.log('  [skip] cannot create junction/symlink'); return; }
    const r = ps.checkPathContainment(root, path.join(junction, 'escaped.txt'));
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.REPARSE_ESCAPE);
    assert.strictEqual(r.viaReparsePoint, true);
    fs.rmSync(junction, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§40 junction parent + nonexistent leaf → DENY REPARSE_ESCAPE', () => {
  const root = makeRoot('jnl-');
  const outside = makeRoot('jnl2-');
  try {
    const junction = path.join(root, 'jlink');
    const link = tryCreateLink(outside, junction);
    if (!link) { console.log('  [skip] cannot create junction/symlink'); return; }
    const r = ps.checkPathContainment(root, path.join(junction, 'new', 'file.txt'));
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.REPARSE_ESCAPE);
    fs.rmSync(junction, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§41 junction parent + multi nonexistent tail → DENY REPARSE_ESCAPE', () => {
  const root = makeRoot('jmt-');
  const outside = makeRoot('jmt2-');
  try {
    const junction = path.join(root, 'jlink');
    const link = tryCreateLink(outside, junction);
    if (!link) { console.log('  [skip] cannot create junction/symlink'); return; }
    const r = ps.checkPathContainment(root, path.join(junction, 'n1', 'n2', 'n3', 'file.txt'));
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.REPARSE_ESCAPE);
    fs.rmSync(junction, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§36 junction chain → DENY', () => {
  const root = makeRoot('jc-');
  const outside = makeRoot('jc2-');
  try {
    const link1 = path.join(root, 'link1');
    const link2 = path.join(root, 'link2');
    // link2 → outside, link1 → link2（链）
    if (!tryCreateLink(outside, link2)) { console.log('  [skip]'); return; }
    if (!tryCreateLink(link2, link1)) { console.log('  [skip] chain'); fs.rmSync(link2, {recursive:true,force:true}); return; }
    const r = ps.checkPathContainment(root, path.join(link1, 'f.txt'));
    assert.strictEqual(r.allowed, false);
    fs.rmSync(link1, { recursive: true, force: true });
    fs.rmSync(link2, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§50 broken symlink → DENY CANONICALIZATION_FAILED', () => {
  const root = makeRoot('bs-');
  const outside = makeRoot('bs2-');
  try {
    const broken = path.join(root, 'brokenlink');
    // 指向不存在目标
    const link = tryCreateLink(path.join(outside, 'NONEXISTENT_TARGET'), broken, 'file');
    if (!link) { console.log('  [skip] cannot create symlink'); return; }
    // 访问 broken symlink 下的子路径 → canonicalization failed
    const r = ps.checkPathContainment(root, path.join(broken, 'child.txt'));
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.errorCode, CODE.CANONICALIZATION_FAILED);
    fs.rmSync(broken, { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('§39 root itself is junction → canonicalize to real root', () => {
  const realRoot = makeRoot('rj-');
  try {
    const sub = makeDir(realRoot, 'src');
    makeFile(sub, 'a.js');
    // 创建一个指向 realRoot 的 junction，用它作为 projectRoot
    const junctionRoot = path.join(path.dirname(realRoot), 'junction-root-cps');
    const link = tryCreateLink(realRoot, junctionRoot);
    if (!link) { console.log('  [skip] cannot create junction root'); return; }
    // projectRoot 是 junction → 应 canonicalize 到 realRoot，然后判断
    const r = ps.checkPathContainment(junctionRoot, path.join(sub, 'a.js'));
    assert.strictEqual(r.allowed, true, 'root 是 junction 时应 canonicalize 后判断');
    fs.rmSync(junctionRoot, { recursive: true, force: true });
  } finally { fs.rmSync(realRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// §79/§80 rename / copy containment（source + destination 都检查）
// ---------------------------------------------------------------------------

test('§79/§80 rename src inside + dst inside → both ALLOW', () => {
  const root = makeRoot('rn-');
  try {
    const sub = makeDir(root, 'src');
    const src = makeFile(sub, 'a.js');
    const dst = path.join(sub, 'b.js');
    const rs = ps.checkPathContainment(root, src);
    const rd = ps.checkPathContainment(root, dst);
    assert.strictEqual(rs.allowed, true);
    assert.strictEqual(rd.allowed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§81 rename src inside + dst outside → dst DENY', () => {
  const root = makeRoot('rno-');
  const outside = makeRoot('rno2-');
  try {
    const sub = makeDir(root, 'src');
    const src = makeFile(sub, 'a.js');
    const dst = path.join(outside, 'b.js');
    const rs = ps.checkPathContainment(root, src);
    const rd = ps.checkPathContainment(root, dst);
    assert.strictEqual(rs.allowed, true);
    assert.strictEqual(rd.allowed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §102/§103 root cache
// ---------------------------------------------------------------------------

test('§103 root cache：相同 root 复用 canonicalRoot', () => {
  const root = makeRoot('cache-');
  try {
    const inst = createPathSecurity({ cacheRoots: true });
    assert.strictEqual(inst.hasRootCache(), true);
    const r1 = inst.checkPathContainment(root, path.join(root, 'a.js'));
    const r2 = inst.checkPathContainment(root, path.join(root, 'b.js'));
    assert.strictEqual(r1.canonicalRoot, r2.canonicalRoot);
    inst.clearRootCache();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('§104 target 不缓存（fresh canonicalization）', () => {
  const root = makeRoot('tc-');
  try {
    const sub = makeDir(root, 'src');
    const target = path.join(sub, 'new.txt');
    const r1 = ps.checkPathContainment(root, target);
    // 创建文件后再检查 → targetExists 应更新（非缓存）
    makeFile(sub, 'new.txt');
    const r2 = ps.checkPathContainment(root, target);
    assert.strictEqual(r1.targetExists, false);
    assert.strictEqual(r2.targetExists, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// §91 TOCTOU deterministic test（execution-time recheck）
// ---------------------------------------------------------------------------

test('§91 TOCTOU：execution-time recheck 检测路径被替换为 junction', () => {
  const root = makeRoot('toctou-');
  const outside = makeRoot('toctou2-');
  try {
    const sub = makeDir(root, 'src');
    const target = path.join(sub, 'victim.txt');
    makeFile(sub, 'victim.txt');

    // 1. 初始授权时：target 在 root 内
    const initial = ps.assertPathInside(root, target);
    assert.strictEqual(initial.allowed, true);

    // 2. 模拟 TOCTOU：删除 victim.txt，在 src 下创建 junction 指向 outside
    fs.unlinkSync(target);
    // 把 src/victim 改成 junction（用目录 junction，名为 victim）
    const junctionDir = path.join(sub, 'victim');
    fs.mkdirSync(junctionDir); // 先建目录占位
    fs.rmdirSync(junctionDir);
    fs.symlinkSync(outside, junctionDir, 'junction');

    // 3. execution-time recheck：访问 victim/child.txt → 应 DENY（canonical 逃逸）
    const r = ps.checkPathContainment(root, path.join(junctionDir, 'child.txt'));
    assert.strictEqual(r.allowed, false, 'TOCTOU 后 recheck 必须拒绝');
    assert.strictEqual(r.errorCode, CODE.REPARSE_ESCAPE);

    fs.rmSync(junctionDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §82-§95 link creation risk classification（通过 PermissionRiskClassifier）
// ---------------------------------------------------------------------------

test('§93 mklink /J → isLinkCreation HIGH', () => {
  const { classifyRisk } = require('../src/security/permissionRiskClassifier');
  const { analyzeCommandRisk } = require('../src/security/commandRiskAnalyzer');
  const s = analyzeCommandRisk({ command: 'mklink /J link target', shell: 'cmd', platform: 'win32' });
  assert.strictEqual(s.isLinkCreation, true);
  const r = classifyRisk({ command: 'mklink /J link target', shell: 'cmd', platform: 'win32' }, 'run_shell', makeRoot('lc-'));
  assert.strictEqual(r.risk, 'high');
});

test('§95 ln -s → isLinkCreation HIGH', () => {
  const { analyzeCommandRisk } = require('../src/security/commandRiskAnalyzer');
  const s = analyzeCommandRisk({ command: 'ln -s target link' });
  assert.strictEqual(s.isLinkCreation, true);
});

test('§83/§84 link creation + canonical outside → CRITICAL', () => {
  const { classifyRisk } = require('../src/security/permissionRiskClassifier');
  const root = makeRoot('lco-');
  const outside = makeRoot('lco2-');
  try {
    const r = classifyRisk({
      command: 'mklink /J link target', shell: 'cmd', platform: 'win32',
      targetPath: path.join(outside, 'link')
    }, 'run_shell', root, { pathSecurity: ps });
    assert.strictEqual(r.risk, 'critical');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
