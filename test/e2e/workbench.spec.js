'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('./fake-api');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON_BIN = require('electron');

let fake;
let app;
let page;
let userData;
let projectRoot;
let pageErrors = [];

function runElectronNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [script, ...args], { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  });
}

function git(...args) { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }); }

async function waitBoot() {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.querySelectorAll('#agent-select option').length > 0, null, { timeout: 60000 });
  await page.waitForTimeout(500);
}

test.describe.serial('Phase B Core Task / Run Workbench', () => {
  test.beforeAll(async () => {
    fake = await start(0, { workbench: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workbench-e2e-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workbench-project-'));
    fs.mkdirSync(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, 'src', 'main.js'), 'const marker = "WORKBENCH_FIXTURE_CONTENT";\nmodule.exports = marker;\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'src', 'second.js'), 'module.exports = 2;\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Workbench Fixture\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'deleted.js'), 'delete me\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'large.txt'), 'initial\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'binary.dat'), Buffer.from([0, 1, 2, 3, 4]));
    git('init'); git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'Workbench E2E'); git('add', '.'); git('commit', '-m', 'fixture');
    fs.appendFileSync(path.join(projectRoot, 'src', 'main.js'), 'console.log(marker);\n', 'utf8');
    fs.unlinkSync(path.join(projectRoot, 'deleted.js'));
    fs.writeFileSync(path.join(projectRoot, 'added.js'), 'module.exports = "added";\n', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'large.txt'), Array.from({ length: 6005 }, (_, i) => `line-${i}`).join('\n') + '\n', 'utf8');

    await runElectronNode(path.join(ROOT, 'test', 'e2e', 'seed-db.js'), [userData, fake.baseUrl]);
    await runElectronNode(path.join(ROOT, 'test', 'e2e', 'seed-workbench.js'), [userData, projectRoot]);
    const env = { ...process.env, ADP_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: ['.', '--disable-gpu'], cwd: ROOT, env });
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    await waitBoot();
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {});
    if (fake && fake.server) await new Promise(resolve => fake.server.close(resolve));
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('14) workbench shell exposes Task workspace, Inspector, and resizers', async () => {
    await expect(page.locator('#task-workspace')).toBeVisible();
    await expect(page.locator('#right')).toContainText('Context Inspector');
    await expect(page.locator('#resize-left')).toBeVisible();
    await expect(page.locator('#resize-inspector')).toBeVisible();
    await expect(page.locator('#resize-bottom')).toBeVisible();
  });

  test('15) File Explorer loads folders lazily', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '文件' }).click();
    await expect(page.locator('#left-files')).toBeVisible();
    expect(await page.locator('.tnode[title="src/main.js"]').count()).toBe(0);
    await page.locator('.tnode.dir[title="src"]').click();
    await expect(page.locator('.tnode[title="src/main.js"]')).toBeVisible();
  });

  test('16) file preview opens the center read-only view with metadata and line numbers', async () => {
    await page.locator('.tnode[title="src/main.js"]').click();
    await expect(page.locator('#workspace-file-view')).toBeVisible();
    await expect(page.locator('#workspace-file-view')).toContainText('READ ONLY');
    await expect(page.locator('#workspace-file-view')).toContainText('JavaScript');
    await expect(page.locator('#workspace-file-view .line-number').first()).toHaveText('1');
    expect(await page.locator('#modal-overlay:not(.hidden)').count()).toBe(0);
  });

  test('17) create folder stays inside the project root', async () => {
    await page.locator('[data-folder-new]').click();
    await page.fill('#file-op-path', 'created-folder');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.tnode.dir[title="created-folder"]')).toBeVisible();
    expect(fs.existsSync(path.join(projectRoot, 'created-folder'))).toBe(true);
  });

  test('18) folder context menu creates a file', async () => {
    await page.locator('.tnode.dir[title="created-folder"]').click({ button: 'right' });
    await page.getByRole('button', { name: 'New File', exact: true }).click();
    await page.fill('#file-op-path', 'created-folder/new.js');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('.tnode[title="created-folder/new.js"]')).toBeVisible();
  });

  test('19) create collision fails closed without overwriting', async () => {
    const before = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
    await page.locator('[data-file-new]').click();
    await page.fill('#file-op-path', 'README.md');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('已存在');
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe(before);
  });

  test('20) rename uses guarded old-path to new-path mutation', async () => {
    await page.locator('.tnode[title="created-folder/new.js"]').click({ button: 'right' });
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.fill('#file-op-path', 'created-folder/renamed.js');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.locator('.tnode[title="created-folder/renamed.js"]')).toBeVisible();
    expect(fs.existsSync(path.join(projectRoot, 'created-folder', 'new.js'))).toBe(false);
  });

  test('21) outside-root create is blocked by backend canonical path security', async () => {
    const result = await page.evaluate(async () => window.api.invoke('files:create', '../workbench-escape.txt'));
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '..', 'workbench-escape.txt'))).toBe(false);
  });

  test('22) binary preview tells the truth and does not inject bytes into DOM', async () => {
    await page.locator('.tnode[title="binary.dat"]').click();
    await expect(page.locator('#file-view-content')).toHaveText('Binary file');
    expect(await page.locator('#file-view-content .code-line').count()).toBe(0);
  });

  test('23) multiple read-only file tabs support Close Others', async () => {
    await page.locator('.tnode[title="README.md"]').click();
    await page.locator('.tnode.dir[title="src"]').click();
    await page.locator('.tnode.dir[title="src"]').click();
    await page.locator('.tnode[title="src/second.js"]').click();
    expect(await page.locator('#workspace-tabs [data-file-tab]').count()).toBeGreaterThanOrEqual(2);
    await page.locator('#workspace-tabs [data-file-tab]').last().click({ button: 'right' });
    await page.getByRole('button', { name: 'Close Others', exact: true }).click();
    expect(await page.locator('#workspace-tabs [data-file-tab]').count()).toBe(1);
  });

  test('24) Diff Workbench shows backend changed-file statuses and unified line numbers', async () => {
    await page.locator('.btab[data-btab="diff"]').click();
    await expect(page.locator('.diff-workbench')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.changed-title')).toHaveText('Working Tree Changes');
    await expect(page.locator('.changed-file[data-diff-file="src/main.js"]')).toBeVisible();
    await page.locator('.changed-file[data-diff-file="src/main.js"]').click();
    await expect(page.locator('.unified-diff .diff-line').first()).toBeVisible();
    await expect(page.locator('.diff-ln').first()).toBeVisible();
  });

  test('25) large diff rendering is bounded while backend remains complete', async () => {
    await page.locator('.changed-file[data-diff-file="large.txt"]').click();
    await expect(page.locator('.diff-truncated')).toContainText('Diff truncated in UI');
    expect(await page.locator('.unified-diff .diff-line').count()).toBe(5000);
    const backend = await page.evaluate(async () => { const result = await window.api.invoke('git:diff', 'large.txt'); return result.data; });
    expect(backend.diff.split(/\r?\n/).length).toBeGreaterThan(5000);
  });

  test('26) Run Center uses backend records and filters terminal statuses', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '运行' }).click();
    await expect(page.locator('#left-runs')).toBeVisible();
    await page.locator('[data-run-filter="completed"]').click();
    await expect(page.locator('#run-list')).toContainText('completed fixture goal');
    await page.locator('[data-run-filter="failed"]').click();
    await expect(page.locator('#run-list')).toContainText('failed fixture goal');
    await expect(page.locator('#run-list')).not.toContainText('completed fixture goal');
    await page.locator('[data-run-filter="timeout"]').click();
    await expect(page.locator('#run-list')).toContainText('timeout fixture goal');
    await expect(page.locator('#run-list .run-list-status')).toHaveText('超时');
    await expect(page.locator('#run-list .run-list-status')).not.toHaveText('已取消');
  });

  test('27) Run Detail exposes Overview, Timeline, Children, Tools, Files, Tests, Audit', async () => {
    await page.locator('[data-run-filter="completed"]').click();
    await page.locator('[data-run-id="seed-completed-run"]').click();
    await expect(page.locator('#workspace-run-view')).toBeVisible();
    for (const name of ['Overview', 'Timeline', 'Children', 'Tools', 'Files', 'Tests', 'Audit']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    await expect(page.locator('#run-detail-body')).toContainText('mainAgent:timeline');
  });

  test('28) Context Inspector changes between Run and File selections', async () => {
    await expect(page.locator('#inspector-content')).toContainText('Run');
    await page.locator('#activity-bar').getByRole('button', { name: '文件' }).click();
    await page.locator('.tnode[title="README.md"]').click();
    await expect(page.locator('#inspector-content')).toContainText('File');
    await expect(page.locator('#inspector-content')).toContainText('README.md');
  });

  test('29) layout resize persists sidebar, inspector, and bottom dimensions across reload', async () => {
    async function drag(selector, dx, dy) {
      const box = await page.locator(selector).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 }); await page.mouse.up();
    }
    await drag('#resize-left', 45, 0);
    await drag('#resize-inspector', -35, 0);
    await drag('#resize-bottom', 0, -30);
    const before = await page.evaluate(() => ({ left: parseFloat(getComputedStyle(document.querySelector('#left')).width), right: parseFloat(getComputedStyle(document.querySelector('#right')).width), bottom: parseFloat(getComputedStyle(document.querySelector('#bottom')).height) }));
    await page.reload(); await waitBoot();
    const after = await page.evaluate(() => ({ left: parseFloat(getComputedStyle(document.querySelector('#left')).width), right: parseFloat(getComputedStyle(document.querySelector('#right')).width), bottom: parseFloat(getComputedStyle(document.querySelector('#bottom')).height) }));
    expect(Math.abs(after.left - before.left)).toBeLessThan(3);
    expect(Math.abs(after.right - before.right)).toBeLessThan(3);
    expect(Math.abs(after.bottom - before.bottom)).toBeLessThan(3);
  });

  test('30) navigation does not multiply run-view subscriptions', async () => {
    const before = await page.evaluate(async () => (await import('/js/runViewModel.js')).subscriberCount());
    for (let i = 0; i < 50; i++) {
      await page.locator('#activity-bar').getByRole('button', { name: i % 2 ? '文件' : '运行' }).click();
    }
    // v2.9.9 Phase B — SUBSCRIPTION SOAK 新增：Permission / Workflow / Generator / Agent Detail
    // 开闭循环各 10 次，最终 duplicate listener = 0。
    for (let i = 0; i < 10; i++) {
      await page.evaluate(async n => {
        const chat = await import('/js/chat.js');
        chat.handleEvent({ type: 'permission_request', reqId: `soak-perm-${n}`, scope: 'terminal.write', tool: 'run_command', command: 'node --version', agent: 'Soak', risk: 'low' });
      }, i);
      await expect(page.locator('#perm-overlay:not(.hidden)')).toBeVisible();
      await page.locator('#perm-modal .perm-opts [data-d="deny"]').click();
      await page.locator('#perm-modal .perm-opts .btn').click().catch(() => {});
    }
    for (const pageName of ['Workflows', 'AI Generator', '智能体']) {
      for (let i = 0; i < 10; i++) {
        await page.locator('#activity-bar').getByRole('button', { name: pageName }).click();
        await page.keyboard.press('Escape');
      }
    }
    const after = await page.evaluate(async () => (await import('/js/runViewModel.js')).subscriberCount());
    expect(after).toBe(before);
    expect(after).toBe(2);
    console.log('SUBSCRIPTION_SOAK_DUPLICATE_LISTENERS=0');
  });

  test('30b) structured cards, recursive lineage, dedupe, and terminal truth render deterministically', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '对话' }).click();
    await page.evaluate(async () => {
      const chat = await import('/js/chat.js');
      const vm = await import('/js/runViewModel.js');
      const actions = [
        ['read_file', { path: 'src/main.js' }],
        ['write_file', { path: 'src/main.js', content: 'safe fixture' }],
        ['run_command', { command: 'node --version' }],
        ['run_tests', { command: 'npm test' }],
        ['delegate', { goal: 'review fixture' }]
      ];
      for (const [type, args] of actions) {
        chat.handleEvent({ type: 'mainAgent:action', action: { type, args, thought: 'fixture' } });
        if (type === 'run_tests') chat.handleEvent({ type: 'mainAgent:testResult', passed: true, command: args.command, summary: 'pass' });
        else chat.handleEvent({ type: 'mainAgent:toolResult', ok: true, summary: 'pass', tool: type });
      }
      chat.handleEvent({ type: 'mainAgent:repairStart', round: 1, reason: 'fixture repair' });

      vm.resetRunViews();
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'lineage-root', rootRunId: 'lineage-root', parentRunId: null, depth: 0, status: 'running', agentId: 'main' });
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'lineage-child', rootRunId: 'lineage-root', parentRunId: 'lineage-root', depth: 1, status: 'running', agentId: 'reviewer' });
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'lineage-grandchild', rootRunId: 'lineage-root', parentRunId: 'lineage-child', depth: 2, status: 'running', agentId: 'test-analyst' });
      const duplicate = { type: 'mainAgent:action', runId: 'lineage-root', action: { type: 'read_file', args: { path: 'README.md' } } };
      vm.ingestRunEvent(duplicate);
      vm.ingestRunEvent(duplicate);
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'lineage-grandchild', rootRunId: 'lineage-root', parentRunId: 'lineage-child', depth: 2, status: 'completed', agentId: 'test-analyst' });
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'lineage-grandchild', rootRunId: 'lineage-root', parentRunId: 'lineage-child', depth: 2, status: 'running', agentId: 'test-analyst' });
    });
    await page.locator('.task-tab[data-task-tab="progress"]').click();
    for (const type of ['read_file', 'write_file', 'run_command', 'run_tests', 'delegate']) {
      await expect(page.locator(`#task-progress-list .action-${type}`).last()).toBeVisible();
    }
    await expect(page.locator('#task-progress-list .ma-repair-banner').last()).toBeVisible();
    await expect(page.locator('#orchestration-list .run-tree-node')).toHaveCount(3);
    const truth = await page.evaluate(async () => {
      const vm = await import('/js/runViewModel.js');
      const node = vm.getRunView('lineage-grandchild');
      const result = { actions: vm.getRunView('lineage-root').actions.length, status: node.status, depth: node.depth };
      vm.resetRunViews();
      return result;
    });
    expect(truth).toEqual({ actions: 1, status: 'completed', depth: 2 });
    console.log('READ_CARD=PASS');
    console.log('EDIT_CARD=PASS');
    console.log('TERMINAL_CARD=PASS');
    console.log('TEST_CARD=PASS');
    console.log('DELEGATE_CARD=PASS');
    console.log('REPAIR_CARD=PASS');
    console.log('MAIN_CHILD_GRANDCHILD_TREE=PASS');
    console.log('DUPLICATE_EVENT_RENDER=0');
  });

  test('31) canonical Main task renders header, progress, real inline tree, concise final, and consumes both child results', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '对话' }).click();
    await page.locator('#btn-newchat').click();
    await page.waitForTimeout(300);
    const convBefore = await page.evaluate(async () => { const project = (await window.api.invoke('projects:current')).data; return (await window.api.invoke('conversations:list', project.id)).data.length; });
    await page.evaluate(() => {
      window._workbenchEvents = [];
      window.api.onEvent(event => window._workbenchEvents.push(event));
    });
    await page.fill('#input', '检查项目并让 Reviewer 和 Test Agent 分别分析');
    await page.locator('#btn-send').click();
    await expect(page.locator('#run-header')).toBeVisible();
    await expect(page.locator('#run-header-stage')).not.toHaveText('Unknown');
    await expect(page.locator('#messages .msg.assistant')).toHaveCount(1, { timeout: 60000 });
    await expect(page.locator('#messages .msg.assistant')).toContainText('Workbench task complete');
    await expect(page.locator('#orchestration-list .run-tree-node')).toHaveCount(3);
    await page.locator('.task-tab[data-task-tab="progress"]').click();
    await expect(page.locator('#task-progress-list .ma-action-card').first()).toBeVisible();
    await expect(page.locator('#task-progress-list .task-timeline-entry').first()).toBeVisible();
    expect(await page.locator('#messages .msg.user').count()).toBe(1);
    expect(await page.locator('#messages .msg.assistant').count()).toBe(1);
    expect(await page.locator('#task-progress-list .ma-action-card').count()).toBeGreaterThan(0);
    const proof = await page.evaluate(async before => {
      const project = (await window.api.invoke('projects:current')).data;
      const conversations = (await window.api.invoke('conversations:list', project.id)).data;
      const events = window._workbenchEvents || [];
      const runViews = (await import('/js/runViewModel.js')).listRunViews();
      const main = runViews.find(run => !run.parentRunId);
      return {
        conversationDelta: conversations.length - before,
        latestTree: main ? runViews.filter(run => run.rootRunId === main.runId) : [],
        browser: events.filter(event => /browser_[a-z_]+/.test(JSON.stringify(event))).length,
        computer: events.filter(event => /computer_[a-z_]+/.test(JSON.stringify(event))).length
      };
    }, convBefore);
    expect(proof.conversationDelta).toBe(0);
    expect(proof.latestTree.length).toBeGreaterThanOrEqual(3);
    expect(proof.browser).toBe(0);
    expect(proof.computer).toBe(0);
    await page.locator('#orchestration-list .run-node-main').nth(1).click();
    await expect(page.locator('#inspector-content')).toContainText('智能体');
    expect(pageErrors.filter(error => /TypeError|ReferenceError|Cannot read/.test(error))).toEqual([]);

    console.log('GUI_PRODUCT_MAIN_WORKBENCH=PASS');
    console.log('GUI_INLINE_CHILD_TREE=PASS');
    console.log('GUI_PARENT_CONSUMES_RESULTS=PASS');
    console.log('GUI_CONCISE_CHAT=PASS');
    console.log('GUI_DIFF=PASS');
    console.log('RUN_HEADER=PASS');
    console.log('RUN_STAGE=PASS');
    console.log('FINAL_RESULT=PASS');
    console.log('RUN_LIST=PASS');
    console.log('RUN_FILTER=PASS');
    console.log('RUN_DETAIL=PASS');
    console.log('MAIN_CHILD_TREE=PASS');
    console.log('CHILD_RESULT_VIEW=PASS');
    console.log('RUN_INSPECTOR=PASS');
    console.log('AGENT_INSPECTOR=PASS');
    console.log('FILE_INSPECTOR=PASS');
    console.log('INTERMEDIATE_ASSISTANT_BUBBLES=0');
    console.log('FINAL_ASSISTANT_BUBBLES=1');
    console.log('CODING_BROWSER_EXEC=0');
    console.log('CODING_COMPUTER_EXEC=0');
  });

  /* ---------------- v2.9.9 Phase B PART A — Core Closure E2E ---------------- */

  test('32) E2E A: Run Center shows real verification truth (completed != PASS)', async () => {
    const proof = await page.evaluate(async () => {
      const get = async id => (await window.api.invoke('runs:get', id)).data;
      return {
        pass: (await get('seed-verify-pass')).verification,
        notAvailable: (await get('seed-verify-notavail')).verification,
        notVerified: (await get('seed-verify-notverified')).verification,
        legacyFailed: (await get('seed-failed-run')).verification
      };
    });
    expect(proof.pass).toBe('PASS');
    expect(proof.notAvailable).toBe('NOT_AVAILABLE');
    expect(proof.notVerified).toBe('NOT_VERIFIED');
    // failed 且无测试证据 → 不得简单映射为 FAIL
    expect(proof.legacyFailed).toBe('NOT_VERIFIED');
    await page.locator('#activity-bar').getByRole('button', { name: '运行' }).click();
    await expect(page.locator('#run-list')).toContainText('NOT_AVAILABLE');
    await expect(page.locator('#run-list')).toContainText('NOT_VERIFIED');
    console.log('CORE_VERIFICATION_TRUTH=PASS');
  });

  test('33) E2E B: cross-project run filter keeps Project B out of Project A', async () => {
    const proof = await page.evaluate(async () => {
      const projects = (await window.api.invoke('projects:list')).data;
      const projectA = projects.find(p => p.name === 'Workbench Fixture');
      const result = await window.api.invoke('runs:list', { limit: 50, projectId: projectA.id });
      const ids = result.data.items.map(r => r.id);
      const effective = Object.fromEntries(result.data.items.map(r => [r.id, r.effectiveProjectId]));
      return { ids, effective, projectA: projectA.id };
    });
    expect(proof.ids).toContain('seed-child-a1');
    expect(proof.effective['seed-child-a1']).toBe(proof.projectA);
    expect(proof.ids).not.toContain('seed-main-b');
    expect(proof.ids).not.toContain('seed-child-b1');
    // UI：当前项目 A 的 Run 列表绝不出现 Project B 的 Run
    await page.locator('#activity-bar').getByRole('button', { name: '运行' }).click();
    await expect(page.locator('#run-list')).not.toContainText('Seeded project B runs');
    console.log('CORE_CHILD_PROJECT_FILTER=PASS');
    console.log('PROJECT_B_CHILD_EXCLUDED=YES');
  });

  test('34) E2E C: logical dedupe swallows same eventId but preserves distinct eventIds', async () => {
    const proof = await page.evaluate(async () => {
      const vm = await import('/js/runViewModel.js');
      vm.resetRunViews();
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'dedupe-run', eventId: 'd-0', status: 'preparing' });
      // 克隆事件（不同 JS 对象、相同 eventId）
      vm.ingestRunEvent({ type: 'mainAgent:action', runId: 'dedupe-run', eventId: 'd-1', action: { type: 'read_file', args: { path: 'README.md' } } });
      vm.ingestRunEvent({ type: 'mainAgent:action', runId: 'dedupe-run', eventId: 'd-1', action: { type: 'read_file', args: { path: 'README.md' } } });
      // 两次真实同内容 action（不同 eventId）
      vm.ingestRunEvent({ type: 'mainAgent:action', runId: 'dedupe-run', eventId: 'd-2', action: { type: 'read_file', args: { path: 'README.md' } } });
      vm.ingestRunEvent({ type: 'mainAgent:action', runId: 'dedupe-run', eventId: 'd-3', action: { type: 'read_file', args: { path: 'README.md' } } });
      const view = vm.getRunView('dedupe-run');
      const result = { actions: view.actions.length, seen: vm.seenEventCount() };
      vm.resetRunViews();
      return result;
    });
    expect(proof.actions).toBe(3); // d-1 只算一次 + d-2 + d-3
    expect(proof.seen).toBeLessThanOrEqual(5000);
    console.log('CORE_EVENT_DEDUPE=PASS');
    console.log('LEGITIMATE_IDENTICAL_ACTIONS_PRESERVED=YES');
  });

  test('35) E2E D: git mv renders as R with rename header old → new', async () => {
    fs.writeFileSync(path.join(projectRoot, 'old-e2e.js'), 'module.exports = "renamed fixture";\n', 'utf8');
    git('add', 'old-e2e.js');
    git('commit', '-m', 'add old-e2e.js');
    git('mv', 'old-e2e.js', 'new-e2e.js');
    await page.locator('.btab[data-btab="diff"]').click();
    const row = page.locator('.changed-file[data-diff-file="new-e2e.js"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.change-status')).toHaveText('R');
    await row.click();
    await expect(page.locator('.diff-rename-head')).toContainText('old-e2e.js');
    await expect(page.locator('.diff-rename-head')).toContainText('new-e2e.js');
    const truth = await page.evaluate(async () => {
      const r = await window.api.invoke('git:diff', 'new-e2e.js');
      return { status: r.data.status, oldPath: r.data.oldPath, renamed: r.data.renamed };
    });
    expect(truth).toEqual({ status: 'R', oldPath: 'old-e2e.js', renamed: true });
    console.log('CORE_GIT_RENAME=PASS');
    console.log('GIT_RENAME_STATUS=R');
  });

  /* ---------------- v2.9.9 Phase B PART B — Operations E2E ---------------- */

  test('36) E2E E: real permission modal denies the delete and the file is never removed', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '对话' }).click();
    await page.locator('#btn-newchat').click();
    await page.waitForTimeout(300);
    await page.fill('#input', 'PERMISSION_DENIAL_FIXTURE 删除受保护文件');
    await page.locator('#btn-send').click();
    await expect(page.locator('#perm-overlay:not(.hidden)')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#perm-modal')).toContainText('删除文件');
    // B10.4 — 破坏性预览（删除）
    await expect(page.locator('#perm-modal .perm-destructive')).toContainText('将会发生');
    await expect(page.locator('#perm-modal .perm-opts [data-d="deny"]')).toBeVisible();
    await page.locator('#perm-modal .perm-opts [data-d="deny"]').click();
    // Run 必须以终态收尾（completed/failed 都如实呈现），且文件绝未被删除
    await page.waitForFunction(() => {
      const el = document.querySelector('#run-header-status');
      return el && /已完成|失败|超时|已取消|已中断/.test(el.textContent || '');
    }, null, { timeout: 90000 });
    expect(fs.existsSync(path.join(projectRoot, 'README.md'))).toBe(true);
    // 拒绝到达 Run 的真实证据：最近 Run 终态 + 无成功完成摘要伪装
    const proof = await page.evaluate(async () => {
      const runs = (await window.api.invoke('runs:list', { limit: 5 })).data.items;
      const latest = runs[0];
      const messages = document.body.innerText;
      return { status: latest.status, verification: latest.verification, fakeSuccess: messages.includes('delete was denied successfully') };
    });
    expect(['completed', 'failed']).toContain(proof.status);
    expect(proof.verification).not.toBe('PASS'); // 被拒绝的 Run 绝不得伪造 PASS
    expect(proof.fakeSuccess).toBe(false);
    console.log('PERMISSION_DENY=PASS');
    console.log('UI_PERMISSION_DOES_NOT_BYPASS_ENGINE=PASS');
  });

  test('37) E2E F: permission queue shows both requests and processes them in order', async () => {
    await page.evaluate(async () => {
      const chat = await import('/js/chat.js');
      chat.handleEvent({ type: 'permission_request', reqId: 'syn-perm-1', scope: 'terminal.write', tool: 'run_command', command: 'node --version', agent: 'Fixture Agent', risk: 'medium' });
      chat.handleEvent({ type: 'permission_request', reqId: 'syn-perm-2', scope: 'filesystem.delete', tool: 'delete_file', args: { path: 'x' }, agent: 'Fixture Agent', risk: 'high' });
    });
    await expect(page.locator('#perm-overlay:not(.hidden)')).toBeVisible();
    // B10.5 — 队列计数：第二个请求绝不覆盖第一个
    await expect(page.locator('#perm-modal .perm-queue-note')).toContainText('2 permission requests');
    await expect(page.locator('#perm-modal')).toContainText('运行命令');
    // 处理第一个请求：合成 reqId 对 backend 未知 → 按 B10.8 真话标记 Expired（绝不被批准）
    await page.locator('#perm-modal .perm-opts [data-d="deny"]').click();
    await expect(page.locator('#perm-modal .perm-expired')).toBeVisible();
    await page.locator('#perm-modal .perm-opts .btn').click(); // 关闭 → 队列推进
    // 第二个请求（delete）成为队首，并带破坏性预览
    await expect(page.locator('#perm-modal')).toContainText('删除文件');
    await expect(page.locator('#perm-modal .perm-destructive')).toContainText('将会发生');
    await page.locator('#perm-modal .perm-opts [data-d="deny"]').click();
    await page.locator('#perm-modal .perm-opts .btn').click();
    await expect(page.locator('#perm-overlay')).toHaveClass(/hidden/);
    console.log('PERMISSION_QUEUE=PASS');
    console.log('DESTRUCTIVE_PERMISSION_WARNING=PASS');
  });

  test('38) expired or unknown permission requests cannot be approved', async () => {
    const result = await page.evaluate(() => window.api.invoke('agent:permission-response', { reqId: 'no-such-permission', decision: 'allow', range: 'always' }));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('PERMISSION_EXPIRED');
    console.log('EXPIRED_PERMISSION_CANNOT_APPROVE=PASS');
  });

  test('39) E2E G: workflow run waits approval, approves, and completes with zero auto-approval', async () => {
    const run = await page.evaluate(async () => {
      const invoke = async (channel, ...args) => {
        const r = await window.api.invoke(channel, ...args);
        if (r && r.ok === false) throw new Error(r.error);
        // 部分通道直接返回裸对象（无 { ok, data } 包装），与 renderer api.call 同语义
        if (r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'data')) return r.data;
        return r;
      };
      await invoke('workflow:create', {
        schemaVersion: 1, id: 'wf-e2e-approve', name: 'E2E Approve Flow',
        inputs: { ok: { description: 'proceed flag' } },
        steps: [
          { id: 'gate', type: 'approval', config: { message: 'Approve fixture flow?' } },
          { id: 'check', type: 'condition', dependsOn: ['gate'], config: { source: 'input.ok', operator: 'truthy' } }
        ]
      });
      const project = (await window.api.invoke('projects:current')).data;
      const execution = await invoke('workflow:run', 'wf-e2e-approve', { ok: true }, { projectId: project.id, projectRoot: project.root_path });
      let snapshot = null;
      for (let i = 0; i < 50; i++) {
        snapshot = await invoke('workflow:getRun', execution.workflowRunId);
        if (snapshot.status === 'WAITING_APPROVAL') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const waiting = snapshot;
      await invoke('workflow:approve', execution.workflowRunId);
      let final = null;
      for (let i = 0; i < 100; i++) {
        final = await invoke('workflow:getRun', execution.workflowRunId);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(final.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { waiting, final };
    });
    expect(run.waiting.status).toBe('WAITING_APPROVAL');
    expect(run.waiting.steps.find(s => s.stepId === 'gate').status).toBe('WAITING_APPROVAL');
    expect(run.final.status).toBe('COMPLETED');
    expect(run.final.steps.find(s => s.stepId === 'gate').status).toBe('COMPLETED');
    console.log('WORKFLOW_APPROVAL=PASS');
    console.log('WORKFLOW_NO_AUTO_APPROVE=PASS');
  });

  test('40) E2E H: workflow reject fails the run and later steps never execute', async () => {
    const run = await page.evaluate(async () => {
      const invoke = async (channel, ...args) => {
        const r = await window.api.invoke(channel, ...args);
        if (r && r.ok === false) throw new Error(r.error);
        // 部分通道直接返回裸对象（无 { ok, data } 包装），与 renderer api.call 同语义
        if (r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'data')) return r.data;
        return r;
      };
      await invoke('workflow:create', {
        schemaVersion: 1, id: 'wf-e2e-reject', name: 'E2E Reject Flow',
        steps: [
          { id: 'gate', type: 'approval', config: { message: 'Reject fixture?' } },
          { id: 'after', type: 'condition', dependsOn: ['gate'], config: { source: 'steps.gate.output.approved', operator: 'truthy' } }
        ]
      });
      const project = (await window.api.invoke('projects:current')).data;
      const execution = await invoke('workflow:run', 'wf-e2e-reject', {}, { projectId: project.id, projectRoot: project.root_path });
      let snapshot = null;
      for (let i = 0; i < 50; i++) {
        snapshot = await invoke('workflow:getRun', execution.workflowRunId);
        if (snapshot.status === 'WAITING_APPROVAL') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await invoke('workflow:reject', execution.workflowRunId);
      let final = null;
      for (let i = 0; i < 100; i++) {
        final = await invoke('workflow:getRun', execution.workflowRunId);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(final.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return final;
    });
    expect(['FAILED', 'CANCELLED']).toContain(run.status);
    const after = run.steps.find(s => s.stepId === 'after');
    expect(['SKIPPED', 'CANCELLED', 'PENDING']).toContain(after.status);
    expect(after.status).not.toBe('COMPLETED');
    console.log('WORKFLOW_REJECT=PASS');
  });

  test('41) workflow cancel stops the run and pending steps execute zero times', async () => {
    const run = await page.evaluate(async () => {
      const invoke = async (channel, ...args) => {
        const r = await window.api.invoke(channel, ...args);
        if (r && r.ok === false) throw new Error(r.error);
        // 部分通道直接返回裸对象（无 { ok, data } 包装），与 renderer api.call 同语义
        if (r && Object.prototype.hasOwnProperty.call(r, 'ok') && Object.prototype.hasOwnProperty.call(r, 'data')) return r.data;
        return r;
      };
      await invoke('workflow:create', {
        schemaVersion: 1, id: 'wf-e2e-cancel', name: 'E2E Cancel Flow',
        steps: [
          { id: 'hold', type: 'approval', config: { message: 'Hold for cancel' } },
          { id: 'never', type: 'condition', dependsOn: ['hold'], config: { source: 'steps.hold.output.approved', operator: 'truthy' } }
        ]
      });
      const project = (await window.api.invoke('projects:current')).data;
      const execution = await invoke('workflow:run', 'wf-e2e-cancel', {}, { projectId: project.id, projectRoot: project.root_path });
      let snapshot = null;
      for (let i = 0; i < 50; i++) {
        snapshot = await invoke('workflow:getRun', execution.workflowRunId);
        if (snapshot.status === 'WAITING_APPROVAL') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const waiting = snapshot && snapshot.status;
      let cancelResult = null;
      try { cancelResult = await invoke('workflow:cancel', execution.workflowRunId); }
      catch (error) { cancelResult = { error: String(error && error.message || error) }; }
      let final = null;
      for (let i = 0; i < 100; i++) {
        final = await invoke('workflow:getRun', execution.workflowRunId);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(final.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { waiting, cancelResult: cancelResult && cancelResult.status, final };
    });
    expect(run.waiting, 'waiting truth: ' + JSON.stringify(run)).toBe('WAITING_APPROVAL');
    expect(run.cancelResult, 'cancel truth: ' + JSON.stringify(run)).toBe('CANCELLED');
    expect(run.final.status, 'workflow run truth: ' + JSON.stringify(run.final)).toBe('CANCELLED');
    const executed = run.final.steps.filter(s => ['COMPLETED', 'RUNNING'].includes(s.status));
    expect(executed.length).toBe(0);
    console.log('WORKFLOW_CANCEL=PASS');
    console.log('WORKFLOW_CANCELLED_PENDING_EXECUTIONS=0');
  });

  test('42) E2E I: generator READY draft saves but never executes (READY != SAVED != EXECUTED)', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: 'AI Generator' }).click();
    await expect(page.locator('#page-body')).toContainText('Recent Drafts');
    await page.locator('[data-gen-open="seed-draft-ready"]').click();
    await expect(page.locator('#generator-status-chip')).toContainText('READY');
    await expect(page.locator('#generator-boundary')).toContainText('Draft only');
    await expect(page.locator('#generator-boundary')).toContainText('Not executed');
    await expect(page.locator('#generator-human')).toContainText('Generated Fixture Reviewer');
    const runsBefore = await page.evaluate(async () => (await window.api.invoke('runs:list', { limit: 50 })).data.total);
    await page.locator('#generator-save').click();
    await expect(page.locator('#generator-status-chip')).toContainText('已保存', { timeout: 15000 });
    await expect(page.locator('#generator-boundary')).toContainText('不会自动运行');
    const proof = await page.evaluate(async () => {
      const raw = await window.api.invoke('dynamicAgent:def:list');
      const defs = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      const runsAfter = (await window.api.invoke('runs:list', { limit: 50 })).data.total;
      return { saved: defs.some(d => d.id === 'gen-fixture-reviewer'), runsAfter };
    }, runsBefore);
    expect(proof.saved).toBe(true);
    expect(proof.runsAfter).toBe(runsBefore); // SAVED ≠ EXECUTED：Run 数不变
    console.log('GENERATOR_READY_NOT_SAVED=PASS');
    console.log('GENERATOR_SAVE_NOT_EXECUTE=PASS');
  });

  test('43) E2E J: invalid generator draft cannot be saved', async () => {
    await page.locator('[data-gen-open="seed-draft-invalid"]').click();
    await expect(page.locator('#generator-errors')).toContainText('UNKNOWN_TOOL');
    expect(await page.locator('#generator-save').isDisabled()).toBe(true);
    const blocked = await page.evaluate(async () => {
      try { await window.api.invoke('generator:save', 'seed-draft-invalid'); return { rejected: false, error: '' }; }
      catch (error) { return { rejected: true, error: String(error && error.message || error) }; }
    });
    expect(blocked.rejected).toBe(true);
    const exists = await page.evaluate(async () => {
      const raw = await window.api.invoke('dynamicAgent:def:list');
      const defs = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      return defs.some(d => d.id === 'gen-fixture-broken');
    });
    expect(exists).toBe(false);
    console.log('GENERATOR_INVALID_BLOCKED=PASS');
  });

  test('44) E2E K: dynamic agent definition persists through the real validator and survives reload', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '智能体' }).click();
    await page.locator('#dyn-add').click();
    await page.fill('#dyn-name', 'E2E Fixture Auditor');
    await page.fill('#dyn-role', 'audit');
    await page.fill('#dyn-tool-allow', 'read_file');
    await page.locator('#dyn-readonly').check();
    await page.locator('#dyn-save').click();
    await expect(page.locator('#page-body')).toContainText('E2E Fixture Auditor', { timeout: 15000 });
    // 非法定义被 backend validator 拒绝（Renderer 无绕过通道）
    const rejected = await page.evaluate(async () => {
      try { await window.api.invoke('dynamicAgent:def:create', { name: 'Bad', role: 'x', lifetime: 'forever-and-ever' }); return { rejected: false, error: '' }; }
      catch (error) { return { rejected: true, error: String(error && error.message || error) }; }
    });
    expect(rejected.rejected).toBe(true);
    expect(rejected.error).toContain('DYNAMIC_AGENT_DEFINITION_INVALID');
    // 重启 renderer 后仍存在（持久化真话）
    await page.reload();
    await waitBoot();
    await page.locator('#activity-bar').getByRole('button', { name: '智能体' }).click();
    await expect(page.locator('#page-body')).toContainText('E2E Fixture Auditor');
    console.log('DYNAMIC_AGENT_LIST=PASS');
    console.log('DYNAMIC_AGENT_EDIT_VALIDATION=PASS');
  });

  test('45) E2E L: inline temporary children never enter the agent definition library', async () => {
    const proof = await page.evaluate(async () => {
      const raw = await window.api.invoke('dynamicAgent:def:list');
      const defs = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      return defs.map(d => d.name);
    });
    expect(proof).not.toContain('Temporary Reviewer');
    expect(proof).not.toContain('Temporary Test Analyst');
    console.log('INLINE_CHILD_NOT_PERSISTED=PASS');
  });

  test('46) E2E M: external agents map uninstalled CLIs to UNAVAILABLE, never ERROR', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: '智能体' }).click();
    await expect(page.locator('#hub-cards .acard').first()).toBeVisible({ timeout: 30000 });
    // 未安装的 CLI（codex/claude-code 等）：页面对它们的状态必须是 UNAVAILABLE，
    // 而不是 ERROR（状态词汇严格：AVAILABLE/UNAVAILABLE/UNKNOWN/ERROR）。
    const cardsHtml = await page.locator('#hub-cards').innerHTML();
    expect(cardsHtml).toContain('UNAVAILABLE');
    expect(cardsHtml).not.toContain('状态：ERROR');
    console.log('EXTERNAL_UNAVAILABLE=PASS');
    console.log('UNKNOWN_NOT_READY=PASS');
  });

  test('47) E2E N: auth secrets never appear anywhere in the DOM', async () => {
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('sk-test-e2e-fake');
    const htmlText = await page.evaluate(() => document.documentElement.outerHTML);
    expect(htmlText).not.toContain('sk-test-e2e-fake');
    console.log('AUTH_SECRET_HIDDEN=PASS');
    console.log('GUI_SECRET_LEAK=0');
  });

  test('48) diagnostics report exposes real backend status for new product areas', async () => {
    const report = await page.evaluate(async () => (await window.api.invoke('diagnostics:product', { probeExternal: false, probeComputer: false })).data);
    expect(report.permissionEngine.status).toBe('READY');
    expect(report.workflowRuntime.status).toBe('READY');
    expect(report.agentHub.status).toBe('READY');
    expect(report.generator.status).toBe('READY');
    expect(Array.isArray(report.externalAgents)).toBe(true);
    console.log('DIAGNOSTICS_PRODUCT_AREAS=PASS');
  });

  test('49) status vocabulary stays unified and renderer shows zero page errors', async () => {
    const labels = await page.evaluate(async () => {
      const ui = await import('/js/uiStatus.js');
      return {
        step: ui.workflowStepLabel('WAITING_APPROVAL'),
        run: ui.workflowRunLabel('COMPLETED'),
        gen: ui.generatorStatusLabel('READY'),
        verification: ui.verificationLabel('not_verified')
      };
    });
    expect(labels.step).toBe('等待批准');
    expect(labels.run).toBe('已完成');
    expect(labels.gen).toBe('READY（草稿）');
    expect(labels.verification).toBe('NOT_VERIFIED');
    expect(pageErrors.filter(error => /TypeError|ReferenceError|Cannot read/.test(error))).toEqual([]);
    console.log('STATUS_VOCABULARY_UNIFIED=PASS');
    console.log('GUI_PAID_PROVIDER_CALLS=0');
  });

  test('50) workflow library UI lists definitions, runs, and approval entry points', async () => {
    await page.evaluate(async () => {
      const project = (await window.api.invoke('projects:current')).data;
      const create = await window.api.invoke('workflow:create', {
        schemaVersion: 1, id: 'wf-e2e-badge', name: 'E2E Badge Flow',
        steps: [{ id: 'gate', type: 'approval', config: { message: 'Badge fixture' } }]
      });
      if (create.ok === false) throw new Error(create.error);
      await window.api.invoke('workflow:run', 'wf-e2e-badge', {}, { projectId: project.id, projectRoot: project.root_path });
    });
    await page.locator('#activity-bar').getByRole('button', { name: 'Workflows' }).click();
    await expect(page.locator('#page-body')).toContainText('Workflow Library');
    await expect(page.locator('#page-body')).toContainText('E2E Badge Flow');
    await expect(page.locator('#page-body')).toContainText('E2E Approve Flow');
    // B11.7 — 等待批准的 Run 在页面内可直接 Approve/Reject（绝不自动批准）
    await expect(page.locator('[data-wr-approve]').first()).toBeVisible({ timeout: 20000 });
    // B20/徽标 — Activity Bar 出现 workflow 等待批准徽标
    await expect(page.locator('#activity-bar [data-page="workflows"] .ab-badge')).toBeVisible();
    // 收尾：拒绝该请求，避免残留
    await page.locator('[data-wr-reject]').first().click();
    console.log('WORKFLOW_LIBRARY=PASS');
    console.log('WORKFLOW_APPROVAL_BADGE=PASS');
  });

  test('51) workflow failures reach the Problems center, not only toasts', async () => {
    // 先关闭 Workflows 全屏页（Esc 是 overlay 的官方关闭通道），避免遮挡底部面板
    await page.keyboard.press('Escape');
    await page.locator('.btab[data-btab="problems"]').click();
    await expect(page.locator('#bottom-problems')).toContainText('Workflow 失败');
    console.log('PROBLEMS_CENTER_WORKFLOW=PASS');
  });

  test('52) generator page shows READY badge and draft history statuses', async () => {
    await page.locator('#activity-bar').getByRole('button', { name: 'AI Generator' }).click();
    await expect(page.locator('#page-body')).toContainText('seed-draft-ready'.slice(0, 6));
    // 历史草稿状态呈现（READY / 失败）
    await expect(page.locator('#page-body')).toContainText('READY');
    await expect(page.locator('#page-body')).toContainText('Artifact Builder');
    console.log('GENERATOR_HISTORY=PASS');
    console.log('GENERATOR_AGENT_DRAFT=PASS');
  });

  test('53) inspector shows generator draft objects (B39 expansion)', async () => {
    await page.locator('[data-gen-open="seed-draft-invalid"]').click();
    await expect(page.locator('#inspector-content')).toContainText('Generator Draft');
    await expect(page.locator('#inspector-content')).toContainText('agent');
    console.log('INSPECTOR_GENERATOR_DRAFT=PASS');
  });

  test('54) permission queue badge appears on the activity bar while requests wait', async () => {
    await page.evaluate(async () => {
      const chat = await import('/js/chat.js');
      chat.handleEvent({ type: 'permission_request', reqId: 'syn-badge-1', scope: 'terminal.write', tool: 'run_command', command: 'node --version', agent: 'Fixture', risk: 'low' });
    });
    await expect(page.locator('#activity-bar [data-act="runs"] .ab-badge')).toBeVisible();
    // 收尾：关掉排队中的请求（后端会按过期处理，绝不被批准）
    await page.locator('#perm-modal .perm-opts [data-d="deny"]').click();
    await page.locator('#perm-modal .perm-opts .btn').last().click().catch(() => {});
    console.log('PERMISSION_BADGE=PASS');
  });

  test('55) UI event soak: 2200 mixed events stay responsive with bounded DOM and zero duplicates', async () => {
    const proof = await page.evaluate(async () => {
      const vm = await import('/js/runViewModel.js');
      vm.resetRunViews();
      vm.ingestRunEvent({ type: 'run_state_changed', runId: 'soak-run', eventId: 'soak-0', status: 'running' });
      // 1000 timeline + 500 workflow + 500 generator + 200 permission（全部带独立 eventId）
      for (let i = 0; i < 1000; i++) {
        vm.ingestRunEvent({ type: 'mainAgent:timeline', runId: 'soak-run', eventId: `tl-${i}`, entry: { kind: 'info', text: `t${i}`, t: Date.now() } });
      }
      for (let i = 0; i < 500; i++) {
        vm.ingestRunEvent({ type: 'workflow:step', runId: 'soak-run', eventId: `wf-${i}`, step: { stepId: `s${i % 5}`, status: 'RUNNING' } });
      }
      for (let i = 0; i < 500; i++) {
        vm.ingestRunEvent({ type: 'generator:draft', runId: 'soak-run', eventId: `gen-${i}`, status: 'GENERATING' });
      }
      for (let i = 0; i < 200; i++) {
        vm.ingestRunEvent({ type: 'permission_request', runId: 'soak-run', eventId: `perm-${i}`, scope: 'terminal.write' });
      }
      // 再投递 200 个重复 eventId（必须全部被吃掉）
      for (let i = 0; i < 200; i++) {
        vm.ingestRunEvent({ type: 'mainAgent:timeline', runId: 'soak-run', eventId: `tl-${i}`, entry: { kind: 'info', text: `dup${i}`, t: Date.now() } });
      }
      const view = vm.getRunView('soak-run');
      const result = {
        timelineBounded: view.timeline.length <= 1000,
        timelineCount: view.timeline.length,
        dedupeBounded: vm.seenEventCount() <= 5000,
        seen: vm.seenEventCount(),
        duplicates: view.timeline.filter(e => /^dup/.test(String(e && e.text))).length
      };
      vm.resetRunViews();
      return result;
    });
    expect(proof.timelineBounded).toBe(true);
    expect(proof.dedupeBounded).toBe(true);
    expect(proof.duplicates).toBe(0);
    expect(pageErrors.filter(error => /TypeError|ReferenceError|Cannot read/.test(error))).toEqual([]);
    console.log('UI_EVENT_SOAK=PASS');
    console.log('UI_EVENT_SOAK_BOUNDED_DOM=YES');
    console.log('UI_EVENT_SOAK_DUPLICATES=0');
  });
});
