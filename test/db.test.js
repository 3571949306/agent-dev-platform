'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const store = require('../src/db/store');
const sec = require('../src/security/secret');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-db-'));
store.init(USER_DATA);

test('数据库文件被创建并启用 WAL', () => {
  assert.ok(fs.existsSync(path.join(USER_DATA, 'agent.db')));
  const mode = store.getDb().pragma('journal_mode', { simple: true });
  assert.strictEqual(String(mode).toLowerCase(), 'wal');
});

test('重复 init（schema IF NOT EXISTS）不破坏已有数据', () => {
  const p = store.projects.create({ name: 'keepme', rootPath: USER_DATA });
  store.init(USER_DATA);
  assert.ok(store.projects.get(p.id), '重新初始化后项目应仍在');
});

test('项目 CRUD', () => {
  const p = store.projects.create({ name: '演示项目', rootPath: 'C:\\tmp\\demo' });
  assert.strictEqual(p.name, '演示项目');
  store.projects.update(p.id, { name: '改名了' });
  assert.strictEqual(store.projects.get(p.id).name, '改名了');
  assert.ok(store.projects.list().some(x => x.id === p.id));
});

test('API Key 不以明文入库，且 list() 不泄露密钥', () => {
  const c = store.connections.create({
    name: 'OpenAI', provider: 'openai', base_url: 'https://api.openai.com/v1', api_key: 'sk-super-secret-1234'
  });
  const raw = store.getDb().prepare('SELECT api_key_enc, api_key_masked FROM api_connections WHERE id=?').get(c.id);
  assert.ok(!raw.api_key_enc.includes('sk-super-secret-1234'), '密文中不得包含明文');
  assert.ok(/^(enc|obf):/.test(raw.api_key_enc), '必须带加密前缀');
  assert.ok(raw.api_key_masked.includes('*'), '掩码应包含 *');

  const listed = store.connections.list().find(x => x.id === c.id);
  assert.strictEqual(listed.api_key, undefined, 'list() 不得返回密钥字段');
  assert.strictEqual(listed.has_key, true);

  const dec = store.connections.getDecrypted(c.id);
  assert.strictEqual(dec.api_key, 'sk-super-secret-1234', '主进程可解密还原');
});

test('secret.mask 保留首尾、隐藏中间', () => {
  assert.strictEqual(sec.mask('sk-abcdefghijkl').slice(0, 4), 'sk-a');
  assert.ok(sec.mask('sk-abcdefghijkl').includes('*'));
  assert.strictEqual(sec.looksSecret('sk-abc123'), true);
  assert.strictEqual(sec.looksSecret('hello'), false);
});

test('Agent 创建 / 子 Agent 关联 / 主 Agent 标记', () => {
  const conn = store.connections.create({ name: 'c', provider: 'mock', base_url: 'http://x' });
  const sub = store.agents.create({ name: '测试子Agent', api_connection_id: conn.id });
  const main = store.agents.create({ name: '主Agent', api_connection_id: conn.id, is_main: true, sub_agent_ids: [sub.id], tools: ['read_file'] });
  const got = store.agents.get(main.id);
  assert.strictEqual(got.is_main, true, 'rowToAgent 应把 is_main 归一化为布尔');
  assert.deepStrictEqual(got.sub_agent_ids, [sub.id]);
  assert.deepStrictEqual(got.tools, ['read_file']);
  assert.strictEqual(got.max_steps, 40, 'maxSteps 默认应为 40');
});

test('对话 / 消息：tool 消息带 tool_call_id 且顺序稳定', () => {
  const conv = store.conversations.create({ title: 't' });
  store.messages.create({ conversation_id: conv.id, role: 'user', content: 'hi' });
  store.messages.create({ conversation_id: conv.id, role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] });
  store.messages.create({ conversation_id: conv.id, role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
  const msgs = store.messages.list(conv.id);
  assert.deepStrictEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.strictEqual(msgs[1].tool_calls[0].id, 'c1');
  assert.strictEqual(msgs[2].tool_call_id, 'c1');
});

test('任务状态流转 + 步骤追加', () => {
  const t = store.tasks.create({ title: '构建', status: 'running' });
  store.tasks.addStep(t.id, '读取文件');
  store.tasks.addStep(t.id, '运行测试');
  store.tasks.update(t.id, { status: 'completed', summary: 'ok' });
  const got = store.tasks.get(t.id);
  assert.strictEqual(got.status, 'completed');
  const steps = store.tasks.steps ? store.tasks.steps(t.id) : null;
  if (steps) assert.strictEqual(steps.length, 2);
});

test('列表接口在未指定项目时不崩溃（可选参数绑定）', () => {
  assert.doesNotThrow(() => store.conversations.list());
  assert.doesNotThrow(() => store.tasks.list());
  assert.ok(Array.isArray(store.conversations.list()));
  assert.ok(Array.isArray(store.tasks.list()));
  const pid = store.projects.create({ name: 'scoped', rootPath: 'x' }).id;
  store.conversations.create({ projectId: pid, title: 'in-scope' });
  assert.strictEqual(store.conversations.list(pid).length, 1, '按项目过滤应生效');
});

test('设置项读写', () => {
  store.settings.set('lastProjectId', 'abc');
  assert.strictEqual(store.settings.get('lastProjectId'), 'abc');
});

test('记忆层去重覆盖', () => {
  const pid = store.projects.create({ name: 'm', rootPath: 'x' }).id;
  store.memories.set({ layer: 'project', projectId: pid, key: 'stack', value: 'node' });
  store.memories.set({ layer: 'project', projectId: pid, key: 'stack', value: 'electron' });
  const list = store.memories.list('project', pid).filter(m => m.key === 'stack');
  assert.strictEqual(list.length, 1, '同 key 应覆盖而非重复');
  assert.strictEqual(list[0].value, 'electron');
});

test('v1 JSON 数据可迁移到 SQLite（连接/Prompt/Agent/对话/消息）', () => {
  const jsonPath = path.join(USER_DATA, 'legacy.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    api_connections: [{ id: 'oldc1', name: '旧连接', provider: 'openai', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-legacy-key-9999', models: ['deepseek-chat'] }],
    prompts: [{ id: 'oldp1', name: '旧Prompt', content: '你是助手' }],
    agents: [{ id: 'olda1', name: '旧Agent', api_connection_id: 'oldc1', model: 'deepseek-chat', is_main: true }],
    conversations: [{ id: 'oldconv1', title: '旧对话', agent_id: 'olda1' }],
    messages: [
      { conversation_id: 'oldconv1', role: 'user', content: '你好' },
      { conversation_id: 'oldconv1', role: 'assistant', content: '你好呀' }
    ]
  }), 'utf8');

  const before = store.connections.list().length;
  const ok = store.migrateFromJson(jsonPath);
  assert.strictEqual(ok, true);

  const conns = store.connections.list();
  assert.strictEqual(conns.length, before + 1);
  const migrated = conns.find(c => c.name === '旧连接');
  assert.ok(migrated);
  const dec = store.connections.getDecrypted(migrated.id);
  assert.strictEqual(dec.api_key, 'sk-legacy-key-9999', '迁移后密钥应可解密且已加密存储');

  const agent = store.agents.list().find(a => a.name === '旧Agent');
  assert.ok(agent, 'Agent 应迁移');
  assert.strictEqual(agent.api_connection_id, migrated.id, '外键应重映射到新连接 id');

  const conv = store.conversations.list().find(c => c.title === '旧对话');
  assert.ok(conv);
  assert.strictEqual(conv.agent_id, agent.id, '对话应指向新 Agent id');
  assert.strictEqual(store.messages.list(conv.id).length, 2);
});

test('迁移不存在的文件返回 false 而不抛错', () => {
  assert.strictEqual(store.migrateFromJson(path.join(USER_DATA, 'nope.json')), false);
});
