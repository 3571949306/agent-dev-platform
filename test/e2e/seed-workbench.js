'use strict';

const path = require('path');
const store = require('../../src/db/store');

const userData = process.argv[2];
const projectRoot = process.argv[3];
store.init(userData);

const project = store.projects.create({ name: 'Workbench Fixture', rootPath: projectRoot });
store.settings.set('lastProjectId', project.id);
const agent = store.agents.listNative().find(item => item.is_main) || store.agents.list()[0];
const conversation = store.conversations.create({ projectId: project.id, agentId: agent && agent.id, title: 'Seeded workbench runs' });

store.permissionGrants.save({ scope: 'filesystem.read', range: 'project', projectId: project.id });
store.permissionGrants.save({ scope: 'terminal.write', range: 'project', projectId: project.id });
store.permissionGrants.save({ scope: 'subagent', range: 'project', projectId: project.id });

const statuses = ['completed', 'failed', 'cancelled', 'timeout'];
for (let i = 0; i < statuses.length; i++) {
  const status = statuses[i];
  const task = store.tasks.create({ projectId: project.id, conversationId: conversation.id, agentId: agent && agent.id, title: `${status} fixture goal`, status });
  const id = `seed-${status}-run`;
  store.runs.upsert({
    id, conversationId: conversation.id, agentId: agent && agent.id, taskId: task.id,
    status, stage: status, startedAt: Date.now() - (i + 1) * 60000,
    terminalAt: Date.now() - i * 30000, parentRunId: null, rootRunId: id, depth: 0,
    message: status === 'completed' ? 'Verified fixture result' : '', error: status === 'failed' ? 'Fixture failure' : ''
  });
  store.events.append({ conversation_id: conversation.id, task_id: task.id, agent_id: agent && agent.id, type: 'mainAgent:timeline', payload: { runId: id, entry: { kind: status === 'completed' ? 'complete' : 'error', text: `${status} event`, t: Date.now() } } });
}

// v2.9.9 Phase B PART A（A1）— Verification Truth seed：completed != PASS。
// 三种机器证据：真实 PASS / 无配置测试（NOT_AVAILABLE）/ 验证从未执行（NOT_VERIFIED）。
function seedVerificationRun(id, verificationStatus, offsetMinutes) {
  store.runs.upsert({
    id, conversationId: conversation.id, agentId: agent && agent.id, taskId: null,
    status: 'completed', stage: 'completed', startedAt: Date.now() - offsetMinutes * 60000,
    terminalAt: Date.now() - (offsetMinutes - 1) * 60000,
    parentRunId: null, rootRunId: id, depth: 0, message: '', error: ''
  });
  if (verificationStatus) store.runs.setVerification(id, verificationStatus);
}
seedVerificationRun('seed-verify-pass', 'PASS', 20);
seedVerificationRun('seed-verify-notavail', 'NOT_AVAILABLE', 21);
seedVerificationRun('seed-verify-notverified', null, 22);

// v2.9.9 Phase B PART A（A2）— Effective Project Identity seed：
// Project A: main + child（child 无 conversation，沿 root lineage 解析）
store.runs.upsert({
  id: 'seed-child-a1', conversationId: null, agentId: agent && agent.id, taskId: null,
  status: 'completed', stage: 'completed', startedAt: Date.now() - 19 * 60000,
  terminalAt: Date.now() - 18 * 60000,
  parentRunId: 'seed-completed-run', rootRunId: 'seed-completed-run', depth: 1, message: '', error: ''
});

// Project B：main-b（有 conversation）+ child-b1（无 conversation）—— 跨项目过滤证据
const projectB = store.projects.create({ name: 'Workbench Fixture B', rootPath: projectRoot });
const conversationB = store.conversations.create({ projectId: projectB.id, agentId: agent && agent.id, title: 'Seeded project B runs' });
store.runs.upsert({
  id: 'seed-main-b', conversationId: conversationB.id, agentId: agent && agent.id, taskId: null,
  status: 'completed', stage: 'completed', startedAt: Date.now() - 17 * 60000,
  terminalAt: Date.now() - 16 * 60000, parentRunId: null, rootRunId: 'seed-main-b', depth: 0, message: '', error: ''
});
store.runs.upsert({
  id: 'seed-child-b1', conversationId: null, agentId: agent && agent.id, taskId: null,
  status: 'completed', stage: 'completed', startedAt: Date.now() - 15 * 60000,
  terminalAt: Date.now() - 14 * 60000,
  parentRunId: 'seed-main-b', rootRunId: 'seed-main-b', depth: 1, message: '', error: ''
});

// v2.9.9 Phase B（B12）— Generator 草稿 seed：READY（合法）与 INVALID（未知工具）
store.generatorDrafts.create({
  draftId: 'seed-draft-ready', generationId: 'seed-gen-ready', artifactType: 'agent', status: 'READY',
  candidate: {
    schemaVersion: 1, id: 'gen-fixture-reviewer', name: 'Generated Fixture Reviewer',
    description: 'Read-only reviewer generated for E2E save boundary proof.',
    role: 'review', systemPrompt: 'Review the fixture project without modifying files.',
    runtime: { kind: 'native' },
    toolPolicy: { allow: ['read_file'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'inherit_parent', fallback: 'fail' },
    lifetime: 'run', canDelegate: false
  },
  validation: { valid: true, errors: [], warnings: [] },
  attempts: 1, repairCount: 0
});
store.generatorDrafts.create({
  draftId: 'seed-draft-invalid', generationId: 'seed-gen-invalid', artifactType: 'agent', status: 'FAILED',
  candidate: {
    schemaVersion: 1, id: 'gen-fixture-broken', name: 'Broken Fixture Agent',
    role: 'review', systemPrompt: 'fixture',
    runtime: { kind: 'native' },
    toolPolicy: { allow: ['no_such_tool_xyz'], deny: [] },
    permissionPolicy: { readOnly: false, allow: [], deny: [] },
    modelPolicy: { mode: 'inherit_parent', fallback: 'fail' },
    lifetime: 'run', canDelegate: false
  },
  validation: { valid: false, errors: [{ code: 'UNKNOWN_TOOL', message: 'tool no_such_tool_xyz is unavailable' }], warnings: [] },
  attempts: 1, repairCount: 0, errorCode: 'UNKNOWN_TOOL', error: 'tool no_such_tool_xyz is unavailable'
});

console.log(`WORKBENCH_SEED_OK project=${project.id} projectB=${projectB.id}`);
process.exit(0);
