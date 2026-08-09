'use strict';
/**
 * v2.6.0 Main Agent Runtime — 事件定义与发射助手（spec §17/§18/§20）。
 *
 * Runtime 通过 emit 推送结构化事件，GUI 据此渲染 Run Timeline / Chat / Diff。
 * 事件类型区分：普通回复 / Agent Action / Tool Result / Task Update /
 * Test Result / Permission Request / Final Result，而非全部当 Markdown。
 */

// 事件类型常量
const EVENTS = {
  RUN_STARTED: 'mainAgent:runStarted',           // { runId, conversationId, goal }
  STATE_CHANGED: 'mainAgent:stateChanged',       // { runId, state, previousState }
  PLAN_CREATED: 'mainAgent:planCreated',         // { runId, plan: { goal, tasks } }
  TASK_UPDATED: 'mainAgent:taskUpdated',         // { runId, taskId, status, title }
  ACTION: 'mainAgent:action',                    // { runId, action: {type,args}, thought }
  TOOL_RESULT: 'mainAgent:toolResult',           // { runId, tool, ok, summary }
  TEST_RESULT: 'mainAgent:testResult',           // { runId, command, passed, summary, errors }
  REPAIR_START: 'mainAgent:repairStart',         // { runId, round, reason }
  FILE_CHANGED: 'mainAgent:fileChanged',         // { runId, path, diff, added, removed }
  CHECKPOINT: 'mainAgent:checkpoint',            // { runId, checkpointId, kind }
  PERMISSION_REQUEST: 'mainAgent:permission',    // { runId, scope, tool, args }
  TIMELINE: 'mainAgent:timeline',                // { runId, entry: {kind, icon, text, detail} }
  ASSISTANT_TEXT: 'mainAgent:assistantText',     // { runId, text }
  RUN_COMPLETED: 'mainAgent:runCompleted',       // { runId, summary, changedFiles, tests }
  RUN_FAILED: 'mainAgent:runFailed',             // { runId, error, errorCode }
  RUN_CANCELLED: 'mainAgent:runCancelled',       // { runId }
  RUN_TIMEOUT: 'mainAgent:runTimeout'            // { runId }
};

/**
 * 构造一个 timeline entry（GUI Run Timeline 渲染单元，spec §18）。
 * kind: 'analyze'|'read'|'plan'|'edit'|'run'|'test-fail'|'repair'|'test-pass'|'complete'|'error'|'info'
 */
function timelineEntry(kind, text, detail = '') {
  const icons = {
    analyze: '✓', read: '✓', plan: '✓', edit: '✓', run: '▶',
    'test-fail': '✕', repair: '↻', 'test-pass': '✓', complete: '✓',
    error: '✕', info: '•'
  };
  return { kind, icon: icons[kind] || '•', text, detail, t: Date.now() };
}

/**
 * 包装 emit，容错：emit 失败不得中断 Run。
 * @param {Function} emit  发射函数（接受 (type, payload)）
 * @param {string} type    事件类型
 * @param {object} payload 事件负载
 */
function safeEmit(emit, type, payload) {
  if (typeof emit !== 'function') return;
  try { emit(type, payload); } catch { /* telemetry must never break a run */ }
}

module.exports = { EVENTS, timelineEntry, safeEmit };
