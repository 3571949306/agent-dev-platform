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
 *
 * v2.1.0:
 *  - the model the Agent selected is passed explicitly to the provider and the
 *    whole routing decision is recorded (model_calls table)
 *  - screenshots returned by tools become real ImageParts in the next request
 *    when the model can see (Vision loop), and are stored as artifact files so
 *    neither the UI nor the DB carries megabytes of base64
 *  - history compaction writes a factual summary instead of dropping messages
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compressHistory } = require('./context');
const { plainText, imagePart } = require('../providers/content');
const { subAgentScopes, ensureScopes } = require('../security/agentScopes');

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
  parts.push('\n你是一个本地 AI 编程助手（Coding Agent）。你可以读取文件、搜索代码、修改文件、运行终端命令、调用子智能体。请直接动手完成任务，而不是只给建议。每次修改后通过构建/测试验证。');
  if (pinnedFacts && pinnedFacts.length) parts.push('\n已知事实：\n' + pinnedFacts.map(f => '- ' + f).join('\n'));
  return parts.join('\n');
}

/** Default routing info when the host did not inject a resolver (tests, sub-agents). */
function defaultModelInfo(agent) {
  const m = (agent && agent.model) || null;
  return { requested: m, model: m, source: m ? 'agent' : 'none', fellBack: false, provider: agent && agent.provider, connectionId: null, connectionName: null };
}

function artifactsDir(deps) {
  const base = deps.artifactsDir || path.join(os.tmpdir(), 'adp-artifacts');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

/**
 * Run a single conversation turn.
 * @param deps dependencies injected by the IPC layer (main process)
 *   - store, emit(event, payload), requestPermission(req)->{decision,range}
 *   - buildProvider(agent)->provider, getTool(name)->{def,exec?,permission,permissionFor,source}
 *   - resolveModel(agent)->{requested,model,source,fellBack,connectionId,connectionName,provider}
 *   - visionSupport(agent)->boolean
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

  const modelInfo = deps.resolveModel ? deps.resolveModel(agent) : defaultModelInfo(agent);
  const visionEnabled = deps.visionSupport ? !!deps.visionSupport(agent) : false;

  const runCtx = {
    projectRoot, projectId: project?.id || null, agentId: agent.id, agentName: agent.name,
    conversationId, abortSignal, store, taskId: null,
    // P3 — system intent gate truth: THIS turn's user request (never history)
    currentUserMessage: userMessage || '',
    toolTimeoutMs: TOOL_TIMEOUT,
    permissionEngine: deps.permissionEngine,
    emit: deps.emit,
    chatDepth: deps.chatDepth || 0,
    maxChatDelegationDepth: deps.maxChatDelegationDepth ?? 2,
    // P1-6: the chain of conversations that led here. Depth alone cannot tell
    // A→B→C from A→B→A; the path can.
    delegationPath: Array.isArray(deps.delegationPath) ? deps.delegationPath.slice() : [],
    isChatBusy: deps.isChatBusy,
    sendChatTask: deps.sendChatTask,
    consecutiveFailures: {}, seenActions: new Set(), step: 0,
    pendingImages: [], artifactsDir: artifactsDir(deps), visionEnabled
  };
  deps.permissionEngine.setTask(null);
  if (project) deps.permissionEngine.setProject(project.id);

  // Task lifecycle
  const task = store.tasks.create({ projectId: project?.id || null, conversationId, agentId: agent.id, title: userMessage?.slice(0, 60) || '任务', status: 'running' });
  runCtx.taskId = task.id;
  deps.permissionEngine.setTask(task.id);
  store.tasks.addStep(task.id, '理解需求');
  deps.emit('task_start', { taskId: task.id, title: task.title, agentId: agent.id });

  // history → window + factual summary of what fell out of it
  const loopMessages = compressHistory(toLoopMessages(history), 18);

  const pinnedFacts = (deps.pinnedFacts || []).map(f => (f && f.value) || f).filter(Boolean);
  const system = buildSystemPrompt(agent, project, pinnedFacts, store);

  let finalContent = '';
  let aborted = false;
  let stopped = false;

  try {
    while (runCtx.step < MAX_STEPS) {
      if (abortSignal.aborted) { aborted = true; break; }
      runCtx.step++;
      deps.emit('assistant_status', { conversationId, status: `第 ${runCtx.step}/${MAX_STEPS} 步：调用模型（${modelInfo.model || '未指定模型'}）` });

      const provider = await deps.buildProvider(agent);
      const t0 = Date.now();
      let toolCallsAcc = null;
      const buf = [];
      const usage = { total_tokens: 0 };
      const imageParts = loopMessages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p && p.type === 'image').length : 0), 0);

      let result;
      try {
        result = await provider.streamResponse({
          model: modelInfo.model,
          system,
          messages: loopMessages,
          tools: toolDefs,
          temperature: agent.temperature ?? 0.7,
          maxTokens: agent.max_tokens ?? 4096,
          // v2.3.1: agent.timeout_ms 同时约束「模型请求」与工具执行——服务端永不返回时
          // 也能以 timeout 终态收尾，而不是让 Spinner 无限转（P0-6 超时用例）。
          timeoutMs: TOOL_TIMEOUT,
          signal: abortSignal,
          onChunk: (t) => { buf.push(t); deps.emit('assistant_text', { conversationId, taskId: task.id, chunk: t }); },
          onToolCall: (tcs) => { toolCallsAcc = tcs; }
        });
      } catch (err) {
        traceModelCall(store, {
          ...modelInfo, agent, conversationId, taskId: task.id, provider,
          latencyMs: Date.now() - t0, ok: false, error: err.message, imageParts
        });
        throw err;
      }

      traceModelCall(store, {
        ...modelInfo, agent, conversationId, taskId: task.id, provider,
        actualModel: result.responseModel || result.model || modelInfo.model,
        latencyMs: Date.now() - t0, ok: true, imageParts
      });

      finalContent = buf.join('') || result.content || '';
      if (result.usage) Object.assign(usage, result.usage);

      // usage record — estimated cost stays NULL unless we can actually price it
      store.usage.create({
        provider: modelInfo.provider || agent.provider || 'unknown',
        model: result.responseModel || modelInfo.model || 'unknown',
        requestedModel: modelInfo.requested || null,
        agentId: agent.id, connectionId: modelInfo.connectionId || null,
        protocol: provider.protocol || null,
        inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
        outputTokens: usage.completion_tokens || usage.output_tokens || 0,
        totalTokens: usage.total_tokens || 0, latencyMs: Date.now() - t0,
        estimatedCost: null
      });

      // save assistant message
      const saved = store.messages.create({
        conversation_id: conversationId, role: 'assistant', content: finalContent,
        tool_calls: toolCallsAcc || null, model: modelInfo.model, tokens: usage.total_tokens || null
      });
      deps.emit('assistant_message', { id: saved.id, conversationId, content: finalContent, tool_calls: toolCallsAcc, taskId: task.id, model: modelInfo.model });

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

      // Vision loop: images produced by tools this step become a real image
      // message so the model SEES the screen instead of reading about it.
      if (runCtx.pendingImages.length) {
        const imgs = runCtx.pendingImages.splice(0, runCtx.pendingImages.length);
        if (visionEnabled) {
          loopMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `以下是刚才工具返回的 ${imgs.length} 张截图，请直接根据画面内容判断下一步操作。` },
              ...imgs.map(i => imagePart(i.data, i.mime))
            ]
          });
          deps.emit('vision_input', { conversationId, taskId: task.id, count: imgs.length, files: imgs.map(i => i.file) });
        } else {
          loopMessages.push({
            role: 'user',
            content: `工具已截图 ${imgs.length} 张（保存在 ${imgs.map(i => i.file).join('、')}），但当前模型「${modelInfo.model}」不具备视觉能力，无法查看图片内容。请改用 computer_get_ui_tree 等文本方式获取界面信息。`
          });
          deps.emit('vision_skipped', { conversationId, taskId: task.id, model: modelInfo.model, count: imgs.length });
        }
      }

      if (aborted || stopped) break;
    }
  } catch (e) {
    // Pressing Stop mid-request makes the provider (or a tool) throw. That is a
    // cancellation, not a failure — never show the user a red error for it.
    const isAbort = abortSignal.aborted || e.aborted === true || e.name === 'AbortError' || /\babort/i.test(e.message || '');
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
  return { ok: true, content: finalContent, taskId: task.id, model: modelInfo.model };
}

/** Persist one model invocation so "why did it use that model?" is answerable. */
function traceModelCall(store, r) {
  if (!store || !store.modelCalls) return;
  try {
    store.modelCalls.record({
      agentId: r.agent?.id, agentName: r.agent?.name,
      conversationId: r.conversationId, taskId: r.taskId,
      connectionId: r.connectionId, connectionName: r.connectionName,
      provider: r.provider?.protocol ? (r.providerName || r.agent?.provider || null) : (r.agent?.provider || null),
      protocol: r.provider?.protocol || null,
      endpoint: r.provider?.endpoint || null,
      requestedModel: r.requested || null,
      actualModel: r.actualModel || r.model || null,
      modelSource: r.source || null,
      fellBack: !!r.fellBack,
      imageParts: r.imageParts || 0,
      latencyMs: r.latencyMs,
      ok: r.ok !== false,
      error: r.error || ''
    });
  } catch { /* telemetry must never break a run */ }
}

const IMAGE_FIELDS = ['data_url', 'image_data_url', 'screenshot'];

/**
 * Pull any base64 image out of a tool result: store it as a file, hand the model
 * a short reference, and queue the bytes for the Vision loop.
 */
function extractImages(data, runCtx, toolName) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  for (const key of IMAGE_FIELDS) {
    const v = out[key];
    if (typeof v !== 'string' || !/^data:image\//.test(v)) continue;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(v);
    if (!m) continue;
    const [, mime, b64] = m;
    const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const file = path.join(runCtx.artifactsDir, `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`);
    try { fs.writeFileSync(file, Buffer.from(b64, 'base64')); } catch { /* keep going */ }
    runCtx.pendingImages.push({ mime, data: b64, file });
    delete out[key];
    out.image_file = file;
    out.image_bytes = Math.round(b64.length * 0.75);
    out.note = runCtx.visionEnabled
      ? '截图已作为图片输入发送给模型，可直接描述画面。'
      : '当前模型不支持视觉，无法查看该截图。';
  }
  return out;
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
    // P0-2: delegating is itself a privileged action. An external adapter that
    // drives the desktop or spawns a CLI must clear the same gate a built-in
    // tool would — the old code jumped straight to runSubAgent().
    const scopes = subAgentScopes(subDef);
    const gate = await ensureScopes(
      runCtx.permissionEngine,
      scopes,
      { taskId: runCtx.taskId, projectId: runCtx.projectId },
      deps.requestPermission
        ? ({ scope }) => deps.requestPermission({
            scope, tool: name, args, agent: agent.name, conversationId,
            taskId: task.id, subAgent: subDef.name, external: subDef.type === 'external'
          })
        : null
    );
    if (!gate.ok) {
      const msg = JSON.stringify({
        ok: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: `子智能体「${subDef.name}」需要权限 ${gate.scope}，${gate.reason === 'user_denied' ? '用户已拒绝' : '当前策略不允许'}`,
          scope: gate.scope,
          requiredScopes: scopes
        }
      });
      recordToolResult(store, conversationId, task.id, agent.id, name, msg, tc.id);
      deps.emit('permission_result', { conversationId, name, result: msg });
      deps.emit('tool_result', { conversationId, name, result: msg });
      return msg;
    }

    deps.emit('subagent_start', { conversationId, taskId: task.id, agentId: subDef.id, name: subDef.name, scopes });
    let r;
    try { r = await deps.runSubAgent(subDef, tc.arguments || '{}', runCtx); }
    catch (e) {
      const isAbort = e && (e.aborted === true || /\babort/i.test(e.message || ''));
      r = JSON.stringify(isAbort
        ? { status: 'cancelled', summary: '', findings: [], changedFiles: [], artifacts: [], errors: ['用户已停止'] }
        : { ok: false, error: { code: 'SUBAGENT_FAILED', message: e.message } });
    }
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
    const payload = r.ok ? extractImages(r.data, runCtx, name) : { ok: false, error: r.error };
    resultStr = JSON.stringify(payload);
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

module.exports = { runAgentTurn, extractImages, defaultModelInfo };
