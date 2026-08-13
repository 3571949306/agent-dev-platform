import { isTerminalStatus, normalizeStatus } from './uiStatus.js';

const runs = new Map();
const subscribers = new Set();
const seenObjects = new WeakSet();
let revision = 0;

function deriveStage(event, previous) {
  const type = String(event.type || '');
  if (type === 'mainAgent:planCreated') return 'planning';
  if (type === 'mainAgent:repairStart') return 'repairing';
  if (type === 'mainAgent:testResult') return 'testing';
  if (type.includes('delegation.started')) return 'waiting_child';
  if (type.includes('delegation.completed')) return 'reading';
  if (type.includes('verification.started')) return 'verifying';
  if (type === 'mainAgent:action') {
    const actionType = event.action && event.action.type;
    if (['read_file', 'read_files', 'list_directory'].includes(actionType)) return 'reading';
    if (['search', 'search_text', 'search_files'].includes(actionType)) return 'searching';
    if (['patch_file', 'write_file', 'create_file', 'move_file', 'delete_file'].includes(actionType)) return 'editing';
    if (['run_command'].includes(actionType)) return 'running_command';
    if (['run_tests'].includes(actionType)) return 'testing';
    if (actionType === 'delegate') return 'delegating';
    if (actionType === 'complete') return 'completed';
  }
  const raw = String(event.stage || event.status || '').toLowerCase();
  const map = {
    preparing: 'analyzing', requesting_model: 'planning', streaming: 'reading', executing_tool: 'running_command',
    waiting_permission: 'waiting_child', waiting_subagent: 'waiting_child', waiting_external_agent: 'waiting_child',
    testing: 'testing', completed: 'completed', failed: 'failed', cancelled: 'cancelled', timeout: 'timeout', interrupted: 'interrupted'
  };
  return map[raw] || previous || 'unknown';
}

function ensureRun(event) {
  const id = event.runId || event.parentRunId;
  if (!id) return null;
  const existing = runs.get(id);
  const canCreate = event.type === 'run_state_changed' || event.type === 'mainAgent:runStarted';
  // Delegation/orchestration presentation events may carry operation IDs that
  // are not persisted Runs. They may enrich an existing node, but must never
  // invent a second hierarchy node.
  if (!existing && !canCreate) return null;
  const previous = existing || {
    runId: id, status: 'preparing', stage: 'analyzing', startedAt: event.timestamp || Date.now(),
    parentRunId: null, rootRunId: id, depth: 0, agentId: null, adapterId: '', actions: [], timeline: [], files: [], tests: [], repairs: 0,
    children: new Set(), result: '', error: ''
  };
  return { previous, id };
}

function updateRun(event) {
  const ensured = ensureRun(event);
  if (!ensured) return false;
  const { previous, id } = ensured;
  const incomingStatus = event.status || (event.type === 'run_completed' ? 'completed' : event.type === 'run_failed' ? 'failed' : event.type === 'run_cancelled' ? 'cancelled' : event.type === 'run_timeout' ? 'timeout' : event.type === 'run_interrupted' ? 'interrupted' : null);
  const terminal = isTerminalStatus(previous.status);
  const nextStatus = terminal && incomingStatus && normalizeStatus(incomingStatus) !== normalizeStatus(previous.status)
    ? previous.status
    : (incomingStatus || previous.status);
  const node = {
    ...previous,
    runId: id,
    status: nextStatus,
    stage: terminal ? previous.stage : deriveStage(event, previous.stage),
    conversationId: event.conversationId || previous.conversationId || null,
    agentId: event.agentId || previous.agentId || null,
    adapterId: event.adapterId || previous.adapterId || '',
    parentRunId: event.parentRunId !== undefined ? event.parentRunId : previous.parentRunId,
    rootRunId: event.rootRunId || previous.rootRunId || id,
    depth: event.depth !== undefined ? Number(event.depth) : previous.depth,
    model: event.model || previous.model || '',
    goal: event.goal || previous.goal || '',
    updatedAt: event.timestamp || Date.now(),
    terminalAt: isTerminalStatus(nextStatus) ? (previous.terminalAt || event.timestamp || Date.now()) : null,
    error: event.error || event.message || previous.error || ''
  };
  const type = String(event.type || '');
  if (type === 'mainAgent:action' && event.action) node.actions = [...previous.actions, { ...event.action, at: event.timestamp || Date.now() }].slice(-500);
  if (type === 'mainAgent:timeline' && event.entry) node.timeline = [...previous.timeline, event.entry].slice(-1000);
  if (type === 'mainAgent:fileChanged' && event.path) node.files = [...new Set([...previous.files, event.path])];
  if (type === 'mainAgent:testResult') node.tests = [...previous.tests, { command: event.command, passed: !!event.passed, required: !!event.required, at: event.timestamp || Date.now() }].slice(-100);
  if (type === 'mainAgent:repairStart') node.repairs = previous.repairs + 1;
  if (type === 'mainAgent:runCompleted') node.result = event.summary || event.result || previous.result;
  if (type === 'mainAgent:action' && event.action && event.action.type === 'complete') node.result = event.action.args && event.action.args.summary || previous.result;
  runs.set(id, node);
  if (node.parentRunId) {
    const parent = runs.get(node.parentRunId);
    if (parent) parent.children.add(id);
  }
  return true;
}

export function ingestRunEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (seenObjects.has(event)) return;
  seenObjects.add(event);
  if (!updateRun(event)) return;
  revision++;
  for (const fn of subscribers) {
    try { fn({ event, revision, runs }); } catch (error) { console.error('run view subscriber failed', error); }
  }
}

export function subscribeRunView(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getRunView(runId) { return runs.get(runId) || null; }
export function listRunViews() { return [...runs.values()]; }
export function resetRunViews() { runs.clear(); revision++; }
export function subscriberCount() { return subscribers.size; }
export { deriveStage };
