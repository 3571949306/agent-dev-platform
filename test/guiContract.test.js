'use strict';
/**
 * v2.9.9 Phase B Final — B38 GUI IPC Contract 静态边界测试。
 *
 * 机器证明：
 *   GUI_BOUNDARY_RENDERER_NO_NODE=PASS   Renderer 不 require fs/child_process/DB/provider
 *   GUI_BOUNDARY_NO_SECOND_AUTHORITY=PASS Renderer 不引入 PermissionEngine/第二套权威
 *   GUI_BOUNDARY_NO_DYNAMIC_CODE=PASS    Renderer 无 eval / new Function
 *   GUI_BOUNDARY_NO_LOCAL_STORAGE_SECRETS=PASS 密钥绝不进 localStorage
 *   GUI_ORPHAN_CHANNELS=0                Renderer 通道全部在 main 端注册
 *   SKILL_PERMISSION_GRANT_UI=0          Skill UI 无授予权限入口
 *   HOOK_RAW_SCRIPT_UI=0                 Hook 编辑器只选择受信 handler
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'public', 'js');

function rendererFiles() {
  return fs.readdirSync(RENDERER_DIR).filter(f => f.endsWith('.js')).map(f => path.join(RENDERER_DIR, f));
}
function read(p) { return fs.readFileSync(p, 'utf8'); }

/** 去掉注释行后再匹配，避免把说明文字当成违规。 */
function codeLines(src) {
  return src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
}

test('B38 renderer never imports node builtins, DB, providers or a second authority', () => {
  const FORBIDDEN = [
    /require\(\s*['"]fs['"]/,
    /require\(\s*['"]child_process['"]/,
    /require\(\s*['"]better-sqlite3['"]/,
    /require\(\s*['"]\.\.?\//, // renderer 不得直接相对引入 src/ 模块（ESM 服务层）
    /from\s+['"]\.\.\/\.\.\//,
    /import\s+[^'"]*PermissionEngine/, // 不得导入权限引擎（第二套权威）
    /require\([^)]*permissions['"]\)/,
    /\bpermissionEngine\.grant\b/
  ];
  let violations = 0;
  for (const file of rendererFiles()) {
    const lines = codeLines(read(file));
    for (const re of FORBIDDEN) {
      const hit = lines.find(l => re.test(l));
      if (hit) { violations++; console.log(`VIOLATION ${path.basename(file)}: ${hit.trim().slice(0, 120)}`); }
    }
  }
  assert.strictEqual(violations, 0, 'renderer boundary must stay clean');
  console.log('GUI_BOUNDARY_RENDERER_NO_NODE=PASS');
  console.log('GUI_BOUNDARY_NO_SECOND_AUTHORITY=PASS');
});

test('B38 renderer has no dynamic code execution (eval / Function constructor)', () => {
  let violations = 0;
  for (const file of rendererFiles()) {
    const lines = codeLines(read(file));
    for (const l of lines) {
      if (/\beval\s*\(/.test(l) || /new\s+Function\s*\(/.test(l)) {
        violations++;
        console.log(`DYNAMIC_CODE ${path.basename(file)}: ${l.trim().slice(0, 120)}`);
      }
    }
  }
  assert.strictEqual(violations, 0);
  console.log('GUI_BOUNDARY_NO_DYNAMIC_CODE=PASS');
});

test('B38 secrets never touch localStorage / sessionStorage in the renderer', () => {
  let violations = 0;
  for (const file of rendererFiles()) {
    const lines = codeLines(read(file));
    for (const l of lines) {
      if (/localStorage|sessionStorage/.test(l)) {
        violations++;
        console.log(`STORAGE ${path.basename(file)}: ${l.trim().slice(0, 120)}`);
      }
    }
  }
  assert.strictEqual(violations, 0, 'UI persistence goes through settings IPC only; never raw storage');
  console.log('GUI_BOUNDARY_NO_LOCAL_STORAGE_SECRETS=PASS');
  console.log('ONBOARDING_LOCALSTORAGE_SECRETS=0');
});

test('B38 every renderer channel is registered in the main process (no orphan channels)', () => {
  const apiSource = read(path.join(RENDERER_DIR, 'api.js'));
  const rendererChannels = [...apiSource.matchAll(/call\('([^']+)'/g)].map(m => m[1]);
  assert.ok(rendererChannels.length > 100, 'renderer surface extracted');

  const handlersSource = read(path.join(ROOT, 'src', 'ipc', 'handlers.js'));
  const mainAgentSource = read(path.join(ROOT, 'src', 'ipc', 'mainAgent.js'));
  const registered = new Set();
  for (const src of [handlersSource, mainAgentSource]) {
    for (const m of src.matchAll(/(?:reg|expose)\('([^']+)'/g)) registered.add(m[1]);
    for (const m of src.matchAll(/ipcMain\.handle\('([^']+)'/g)) registered.add(m[1]);
  }
  const orphans = [...new Set(rendererChannels)].filter(ch => !registered.has(ch));
  assert.deepStrictEqual(orphans, [], `orphan channels: ${orphans.join(', ')}`);
  console.log('GUI_ORPHAN_CHANNELS=0');
});

test('B17 skill UI never grants authority; hook editor only selects trusted handlers', () => {
  const pagesSource = read(path.join(RENDERER_DIR, 'pages.js'));
  const appSource = read(path.join(RENDERER_DIR, 'app.js'));

  // SKILL_PERMISSION_GRANT_UI=0 — 没有任何「授予权限」UI 或 grant 通道调用
  assert.ok(!/permission:grant|permissionGrant|grantPermission/.test(pagesSource), 'no grant-permission UI in pages');
  assert.ok(!/permission:grant|permissionGrant|grantPermission/.test(appSource), 'no grant-permission UI in app');
  assert.ok(!read(path.join(RENDERER_DIR, 'api.js')).includes('permission:grant'), 'no grant channel in renderer API');
  console.log('SKILL_PERMISSION_GRANT_UI=0');

  // HOOK_RAW_SCRIPT_UI=0 — hook 的 handler 只能是 <select>（受信 handler 列表），
  // 不存在任何脚本/URL 输入框
  const hookHandlerLine = pagesSource.split('\n').find(l => l.includes('id="h-handler"'));
  assert.ok(hookHandlerLine && /<select/.test(hookHandlerLine), 'hook handler bound to a select only');
  assert.ok(!/id="h-script"|id="h-code"|id="h-webhook"|id="h-shell"/.test(pagesSource), 'no raw script/webhook/shell inputs for hooks');
  console.log('HOOK_RAW_SCRIPT_UI=0');
  console.log('HOOK_TRUSTED_HANDLER_ONLY=PASS');
});

test('B38 docs/GUI_IPC_CONTRACT.md exists and matches the real renderer surface', () => {
  const docPath = path.join(ROOT, 'docs', 'GUI_IPC_CONTRACT.md');
  assert.ok(fs.existsSync(docPath), 'contract doc generated');
  const doc = read(docPath);
  const apiSource = read(path.join(RENDERER_DIR, 'api.js'));
  const channels = [...new Set([...apiSource.matchAll(/call\('([^']+)'/g)].map(m => m[1]))];
  for (const cls of ['READ', 'WRITE', 'RUN', 'CANCEL', 'APPROVE', 'DANGEROUS', 'SYSTEM']) {
    assert.ok(doc.includes(`## ${cls}`), `doc covers ${cls}`);
  }
  // 抽样：每个通道都出现在文档里
  const missing = channels.filter(ch => !doc.includes('`' + ch + '`'));
  assert.deepStrictEqual(missing, [], `channels missing from doc: ${missing.slice(0, 5).join(', ')}`);
  console.log('GUI_IPC_CONTRACT_DOC=PASS');
});
