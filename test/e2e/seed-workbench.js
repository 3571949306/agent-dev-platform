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

console.log(`WORKBENCH_SEED_OK project=${project.id}`);
process.exit(0);
