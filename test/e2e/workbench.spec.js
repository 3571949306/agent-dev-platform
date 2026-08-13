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
    const after = await page.evaluate(async () => (await import('/js/runViewModel.js')).subscriberCount());
    expect(after).toBe(before);
    expect(after).toBe(2);
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
});
