'use strict';
/**
 * v2.9.9 Phase B Final（B60）— Recovery 场景 seed：
 * 制造「上次会话被中断」的持久现场（非终态 Run / 活跃 Workflow / GENERATING 草稿）。
 * 用法：electron test/e2e/seed-interrupted.js <userData> <projectRoot>
 */
const path = require('path');
const store = require('../../src/db/store');

const userData = process.argv[2];
const projectRoot = process.argv[3];
store.init(userData);

const project = store.projects.create({ name: 'Interrupted Fixture', rootPath: projectRoot });
store.settings.set('lastProjectId', project.id);
const agent = store.agents.listNative().find(item => item.is_main) || store.agents.list()[0];
const conversation = store.conversations.create({ projectId: project.id, agentId: agent && agent.id, title: 'Interrupted session' });

// 非终态 Run：启动时恢复必须标记 interrupted，且绝不复活/重放
store.runs.upsert({
  id: 'seed-interrupted-run', conversationId: conversation.id, agentId: agent && agent.id, taskId: null,
  status: 'executing_tool', stage: 'executing_tool',
  startedAt: Date.now() - 120000, lastActivityAt: Date.now() - 60000,
  parentRunId: null, rootRunId: 'seed-interrupted-run', depth: 0, message: '', error: ''
});

// 活跃 Workflow：恢复后必须 FAILED/WORKFLOW_INTERRUPTED
store.workflowDefinitions.create({
  schemaVersion: 1, id: 'interrupted-flow', name: 'Interrupted Flow', description: '',
  inputs: {}, steps: [{ id: 'step-1', type: 'tool', dependsOn: [], config: { toolName: 'read_file', args: { path: 'README.md' } }, timeoutMs: 5000, retry: { maxAttempts: 1 }, onFailure: 'fail' }],
  outputs: {}, limits: { maxSteps: 4, maxRuntimeMs: 60000 }, metadata: {}
});
store.workflowExecutions.create({
  workflowRunId: 'seed-interrupted-wf', workflowId: 'interrupted-flow',
  status: 'RUNNING', projectId: project.id, currentStepId: 'step-1', input: {}
});
store.workflowStepExecutions.create({
  workflowRunId: 'seed-interrupted-wf', stepId: 'step-1', stepType: 'tool', status: 'RUNNING'
});

// GENERATING 草稿：恢复后必须 FAILED/GENERATOR_INTERRUPTED
store.generatorDrafts.create({
  draftId: 'seed-interrupted-draft', generationId: 'seed-gen-interrupted', artifactType: 'skill',
  status: 'GENERATING', candidate: null, validation: { valid: false, errors: [], warnings: [] }
});

console.log('INTERRUPTED_SEED_OK');
process.exit(0);
