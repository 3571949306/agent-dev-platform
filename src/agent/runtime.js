'use strict';
/**
 * Agent Runtime — the core loop.
 *
 * User → Context → Model → Tool Call → Executor → Result → Model → ... → Completion
 *
 * Features (spec §16/§17/§18):
 *  - configurable maxSteps / timeout / abort / retry / toolTimeout
 *  - duplicateActionDetection + maxRepeatedFailures (no infinite loops)
 *  - permission gating (allow / ask / deny) with grant ranges
 *  - structured Agent Events emitted live to the UI
 *  - true Stop: abortSignal kills the LLM request AND terminal process tree
 *  - sub-agents + multi-chat interconnect via injected deps
 */
const crypto = require('crypto');

function withTimeout(p, ms) {
  if (!ms || ms <= 0) return p;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('工具执行超时')), ms);
    p.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

function parseArgs(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

function toLoopMessages(history) {
  return history.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content, tool_calls: m.tool_calls };
    return { role: m.role, content: m.content };
  });
}

function buildSystemPrompt(agent, project, pinnedFacts, store) {
  let sys = '';
  if (agent.system_prompt_id) {
    let sp = agent._systemPrompt;
    if (!sp && store && store.prompts) { try { sp = store.prompts.get(agent.system_prompt_id); } catch { sp = null; } }
    sys = sp ? sp.content : (agent.description || '');
  } else {
    sys = agent.description || '';
  }
  const parts = [];
  if (sys) parts.push(sys);
  if (project) parts.push(`\n当前项目：「${project.name}」，根目录：${project.root_path}`);
  parts.push('\n你是一个本地 AI 编程助手（Coding Agent）。你可以读取文件、搜索代码、修改文件、运行终端命令、调用子 Agent。请直接动手完成任务，而不是只给建议。每次修改后通过构建/测试验证。');
  if (pinnedFacts && pinnedFacts.length) parts.push('\n已知事实：\n' + pinnedFacts.map(f => '- ' + f).join('\n'));
  return parts.join('\n');
}

/**
 * Run a single conversation turn.
 * @param deps dependencies injected by the IPC layer (main process)
 *   - store, emit(event, payload), requestPermission(req)->{decision,range}
 *   - buildProvider(agent)->provider, getTool(name)->{def,exec?,permission,permissionFor,source}
 *   - runSubAgent(subDef, argsStr, runCtx)->string, sendChatTask(opts)->string
 *   - permissionEngine, project, projectRoot
 * @param opts { agent, conversationId, userMessage, history, toolDefs }
 */
async function runAgentTurn(deps, opts) {
  const { agent, conversationId, userMessage, history, toolDefs } = opts;
  const store = deps.store;
  const project = deps.project;
  const projectRoot = deps.projectRoot;
  const MAX_STEPS = agent.max_steps || 40;
  const MAX_REPEATED_FAILURES = 3;
  const TOOL_TIMEOUT = Math.min(agent.timeout_ms || 600000, 600000);

  const abortController = new AbortController();
  const abortSignal = abortSignalFrom(deps, abortController);

  const runCtx = {
    projectRoot, projectId: project?.id || null, agentId: agent.id, agentName: agent.name,
    conversationId, abortSignal, store, taskId: null,
    toolTimeoutMs: TOOL_TIMEOUT,
    permissionEngine: deps.permissionEngine,
    emit: deps.emit,
    consecutiveFailures: {}, seenActions: new Set(), step: 0
  };
  deps.permissionEngine.setTask(null);
  if (project) deps.permissionEngine.setProject(project.id);

  // Task lifecycle
  const task = store.tasks.create({ projectId: project?.id || null, conversationId, agentId: agent.id, title: userMessage?.slice(0, 60) || '任务', status: 'running' });
  runCtx.taskId = task.id;
  deps.permissionEngine.setTask(task.id);
  store.tasks.addStep(task.id, '理解需求');
  deps.emit('task_start', { taskId: task.id, title: task.title, agentId: agent.id });

  const loopMessages = toLoopMessages(history);
  // compress: if too long, keep recent window + note
  const WINDOW = 18;
  if (loopMessages.length > WINDOW + 4) {
    const recent = loopMessages.slice(-WINDOW);
    loopMessages.length = 0;
    loopMessages.push({ role: 'system', content: `（前面有 ${history.length - WINDOW} 条历史已压缩省略，关键结论请基于最近对话）` });
    loopMessages.push(...recent);
  }

  const pinnedFacts = (deps.pinnedFacts || []).map(f => (f && f.value) || f).filter(Boolean);
  const system = buildSystemPrompt(agent, project, pinnedFacts, store);

  let finalContent = '';
  let aborted = false;
  let stopped = false;

  try {
    while (runCtx.step < MAX_STEPS) {
      if (abortSignal.aborted) { aborted = true; break; }
      runCtx.step++;
      deps.emit('assistant_status', { conversationId, status: `第 ${runCtx.step}/${MAX_STEPS} 步：调用模型` });

      const provider = await deps.buildProvider(agent);
      const t0 = Date.now();
      let toolCallsAcc = null;
      const buf = [];
      const usage = { total_tokens: 0 };

      const result = await provider.streamResponse({
        system,
        messages: loopMessages,
        tools: toolDefs,
        temperature: agent.temperature ?? 0.7,
        maxTokens: agent.max_tokens ?? 4096,
        signal: abortSignal,
        onChunk: (t) => { buf.push(t); deps.emit('assistant_text', { conversationId, taskId: task.id, chunk: t }); },
        onToolCall: (tcs) => { toolCallsAcc = tcs; }
      });

      finalContent = buf.join('') || result.content || '';
      if (result.usage) Object.assign(usage, result.usage);

      // usage record
      store.usage.create({
        provider: agent.provider || 'unknown', model: agent.model || 'unknown',
        inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
        outputTokens: usage.completion_tokens || usage.output_tokens || 0,
        totalTokens: usage.total_tokens || 0, latencyMs: Date.now() - t0, estimatedCost: 0
      });

      // save assistant message
      const saved = store.messages.create({
        conversation_id: conversationId, role: 'assistant', content: finalContent,
        tool_calls: toolCallsAcc || null, model: agent.model, tokens: usage.total_tokens || null
      });
      deps.emit('assistant_message', { id: saved.id, conversationId, content: finalContent, tool_calls: toolCallsAcc, taskId: task.id });

      if (!toolCallsAcc || !toolCallsAcc.length) {
        store.tasks.update(task.id, { status: 'completed', summary: finalContent.slice(0, 200) });
        deps.emit('task_complete', { taskId: task.id, status: 'completed' });
        break;
      }

      // append assistant (with tool calls) then execute each
      loopMessages.push({ role: 'assistant', content: finalContent, tool_calls: toolCallsAcc });
      store.tasks.addStep(task.id, toolCallsAcc.map(t => t.name).join(', ').slice(0, 80));
      for (const tc of toolCallsAcc) {
        const res = await executeToolCall(tc, deps, runCtx, agent, conversationId, task, store);
        loopMessages.push({ role: 'tool', tool_call_id: tc.id, content: res });
        if (runCtx.consecutiveFailures[tc.name] > MAX_REPEATED_FAILURES) {
          stopped = true;
          deps.emit('assistant_status', { conversationId, status: `工具 ${tc.name} 连续失败，停止以避免死循环` });
          break;
        }
        if (abortSignal.aborted) { aborted = true; break; }
      }
      if (aborted || stopped) break;
    }
  } catch (e) {
    // Pressing Stop mid-request makes the provider (or a tool) throw. That is a
    // cancellation, not a failure — never show the user a red error for it.
    const isAbort = abortSignal.aborted || /\babort/i.test(e.message || '');
    if (isAbort) {
      store.tasks.update(task.id, { status: 'cancelled' });
      deps.emit('task_cancelled', { taskId: task.id });
      deps.emit('assistant_status', { conversationId, status: '' });
      return { ok: true, aborted: true, content: finalContent, taskId: task.id };
    }
    store.tasks.update(task.id, { status: 'failed', error: e.message });
    deps.emit('error', { conversationId, taskId: task.id, message: e.message });
    deps.emit('assistant_status', { conversationId, status: '' }); // never leave the spinner stuck
    return { ok: false, error: e.message, taskId: task.id };
  }

  if (aborted) {
    store.tasks.update(task.id, { status: 'cancelled' });
    deps.emit('task_cancelled', { taskId: task.id });
    deps.emit('assistant_status', { conversationId, status: '' });
    return { ok: true, aborted: true, content: finalContent, taskId: task.id };
  }
  const cur = store.tasks.get(task.id);
  if (cur && cur.status === 'running') {
    const why = stopped ? 'stopped' : (runCtx.step >= MAX_STEPS ? 'max_steps' : 'completed');
    store.tasks.update(task.id, { status: why === 'completed' ? 'completed' : 'failed', summary: finalContent.slice(0, 200), error: why === 'max_steps' ? `已达最大步数 ${MAX_STEPS}` : (stopped ? '连续工具失败已中止' : '') });
    deps.emit('task_complete', { taskId: task.id, status: why });
  }
  deps.emit('assistant_status', { conversationId, status: '' });
  return { ok: true, content: finalContent, taskId: task.id };
}

async function executeToolCall(tc, deps, runCtx, agent, conversationId, task, store) {
  const name = tc.name;
  let args = {};
  try { args = JSON.parse(tc.arguments || '{}'); } catch {}
  deps.emit('tool_call', { conversationId, taskId: task.id, agentId: agent.id, name, args });
  store.events.append({ conversation_id: conversationId, task_id: task.id, agent_id: agent.id, type: 'tool_call', payload: { name, args } });

  // sub-agent tool?
  const subDef = deps.subAgentTool ? deps.subAgentTool(name) : null;
  if (subDef) {
    deps.emit('subagent_start', { conversationId, taskId: task.id, agentId: subDef.id, name: subDef.name });
    let r;
    try { r = await deps.runSubAgent(subDef, tc.arguments || '{}', runCtx); }
    catch (e) { r = JSON.stringify({ ok: false, error: { code: 'SUBAGENT_FAILED', message: e.message } }); }
    deps.emit('subagent_result', { conversationId, taskId: task.id, agentId: subDef.id, name: subDef.name, result: r });
    recordToolResult(store, conversationId, task.id, agent.id, name, r, tc.id);
    return r;
  }

  const tool = deps.getTool(name);
  if (!tool) {
    const msg = JSON.stringify({ ok: false, error: { code: 'UNKNOWN_TOOL', message: `未知工具 ${name}` } });
    recordToolResult(store, conversationId, task.id, agent.id, name, msg, tc.id);
    deps.emit('tool_result', { conversationId, name, result: msg });
    return msg;
  }

  const scope = tool.permissionFor ? tool.permissionFor(args) : tool.permission;
  const verdict = runCtx.permissionEngine.evaluate(scope, { taskId: runCtx.taskId, projectId: runCtx.projectId });
  if (verdict === 'deny') {
    const msg = JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: '权限被拒绝' } });
    recordToolResult(store, conversationId, task.id, agent.id, name, msg, tc.id);
    deps.emit('permission_result', { conversationId, name, result: msg });
    deps.emit('tool_result', { conversationId, name, result: msg });
    return msg;
  }
  if (verdict === 'ask') {
    const decision = await deps.requestPermission({ scope, tool: name, args, agent: agent.name, conversationId, taskId: task.id });
    if (decision.decision === 'deny') {
      const msg = JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: '用户拒绝' } });
      recordToolResult(store, conversationId, task.id, agent.id, name, msg, tc.id);
      deps.emit('tool_result', { conversationId, name, result: msg });
      return msg;
    }
    runCtx.permissionEngine.grant(scope, decision.range || 'once');
  }

  // duplicate detection
  const actionKey = name + ':' + JSON.stringify(args);
  if (runCtx.seenActions.has(actionKey)) {
    const msg = JSON.stringify({ ok: false, error: { code: 'DUPLICATE_ACTION', message: '该操作刚刚已执行，已跳过以避免死循环' } });
    recordToolResult(store, conversationId, task.id, agent.id, name, msg, tc.id);
    deps.emit('tool_result', { conversationId, name, result: msg });
    return msg;
  }
  runCtx.seenActions.add(actionKey);

  deps.emit('tool_executing', { conversationId, name, args });
  let resultStr;
  try {
    const r = await withTimeout(tool.exec(runCtx, args), runCtx.toolTimeoutMs);
    resultStr = JSON.stringify(r.ok ? r.data : { ok: false, error: r.error });
    if (!r.ok) runCtx.consecutiveFailures[name] = (runCtx.consecutiveFailures[name] || 0) + 1;
    else runCtx.consecutiveFailures[name] = 0;
  } catch (e) {
    resultStr = JSON.stringify({ ok: false, error: { code: 'TOOL_ERROR', message: e.message } });
    runCtx.consecutiveFailures[name] = (runCtx.consecutiveFailures[name] || 0) + 1;
  }

  store.audit.record({ agent: agent.name, task: task.id, tool: name, target: args.path || '', permission: scope, result: resultStr.includes('"ok":false') ? 'fail' : 'ok' });
  recordToolResult(store, conversationId, task.id, agent.id, name, resultStr, tc.id);
  deps.emit('tool_result', { conversationId, taskId: task.id, name, result: resultStr });
  return resultStr;
}

function recordToolResult(store, conversationId, taskId, agentId, name, resultStr, toolCallId) {
  store.events.append({ conversation_id: conversationId, task_id: taskId, agent_id: agentId, type: 'tool_result', payload: { name, result: String(resultStr).slice(0, 2000) } });
  // Persist as a `tool` message so the next turn's history keeps every
  // assistant.tool_calls paired with its tool response (OpenAI/Anthropic
  // both reject unpaired tool_calls with 400).
  if (toolCallId) {
    try {
      store.messages.create({
        conversation_id: conversationId, role: 'tool', content: String(resultStr).slice(0, 20000),
        tool_call_id: toolCallId, model: null, tokens: null
      });
    } catch { /* non-fatal */ }
  }
}

function abortSignalFrom(deps, controller) {
  if (deps.abortSignal) {
    deps.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    return deps.abortSignal;
  }
  return controller.signal;
}

module.exports = { runAgentTurn };
