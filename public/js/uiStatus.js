export const UI_STATUS = Object.freeze({
  RUNNING: 'RUNNING', WAITING: 'WAITING', COMPLETED: 'COMPLETED', FAILED: 'FAILED',
  CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT', INTERRUPTED: 'INTERRUPTED', UNKNOWN: 'UNKNOWN'
});

const LABELS = Object.freeze({
  RUNNING: '运行中', WAITING: '等待中', COMPLETED: '已完成', FAILED: '失败',
  CANCELLED: '已取消', TIMEOUT: '超时', INTERRUPTED: '已中断', UNKNOWN: '未知'
});

export function normalizeStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['preparing', 'requesting_model', 'streaming', 'executing_tool', 'testing', 'running', 'tool', 'thinking'].includes(status)) return UI_STATUS.RUNNING;
  if (['waiting_permission', 'waiting_subagent', 'waiting_external_agent', 'waiting', 'queued'].includes(status)) return UI_STATUS.WAITING;
  if (status === 'completed') return UI_STATUS.COMPLETED;
  if (status === 'failed') return UI_STATUS.FAILED;
  if (status === 'cancelled' || status === 'canceled') return UI_STATUS.CANCELLED;
  if (status === 'timeout') return UI_STATUS.TIMEOUT;
  if (status === 'interrupted') return UI_STATUS.INTERRUPTED;
  return UI_STATUS.UNKNOWN;
}

export function statusLabel(value) { return LABELS[normalizeStatus(value)] || LABELS.UNKNOWN; }
export function isTerminalStatus(value) { return ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'INTERRUPTED'].includes(normalizeStatus(value)); }

export const STAGE_LABELS = Object.freeze({
  analyzing: 'Analyzing', planning: 'Planning', reading: 'Reading', searching: 'Searching', editing: 'Editing',
  running_command: 'Running Command', testing: 'Testing', delegating: 'Delegating', waiting_child: 'Waiting Child',
  repairing: 'Repairing', verifying: 'Verifying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  timeout: 'Timeout', interrupted: 'Interrupted', unknown: 'Unknown'
});

export function stageLabel(stage) { return STAGE_LABELS[String(stage || '').toLowerCase()] || STAGE_LABELS.unknown; }

// v2.9.9 Phase B（B40）— 新增产品区域的统一状态词汇：
// Permission / Workflow / Generator / Agent / Connection / External Agent。
// Renderer 各页面一律从这里取标签，不得各写各的 success/ready/ok/working。
export const WORKFLOW_STEP_LABELS = Object.freeze({
  PENDING: '等待', READY: '就绪', RUNNING: '运行中', WAITING_APPROVAL: '等待批准',
  COMPLETED: '已完成', FAILED: '失败', SKIPPED: '已跳过', CANCELLED: '已取消'
});
export const WORKFLOW_RUN_LABELS = Object.freeze({
  RUNNING: '运行中', WAITING_APPROVAL: '等待批准', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消'
});
export const GENERATOR_STATUS_LABELS = Object.freeze({
  GENERATING: '生成中', REPAIRING: '修复中', VALIDATING: '验证中', READY: 'READY（草稿）',
  FAILED: '失败', CANCELLED: '已取消', SAVED: '已保存', DISCARDED: '已丢弃'
});
export const VERIFICATION_LABELS = Object.freeze({
  PASS: 'PASS', FAIL: 'FAIL', NOT_AVAILABLE: 'NOT_AVAILABLE',
  NOT_VERIFIED: 'NOT_VERIFIED', RUNNING: 'RUNNING', UNKNOWN: 'UNKNOWN'
});
export const EXTERNAL_AVAILABILITY = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'ERROR']);
export const CONNECTION_STATUS = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
export function workflowStepLabel(status) { return WORKFLOW_STEP_LABELS[status] || status || '—'; }
export function workflowRunLabel(status) { return WORKFLOW_RUN_LABELS[status] || status || '—'; }
export function generatorStatusLabel(status) { return GENERATOR_STATUS_LABELS[status] || status || '—'; }
export function verificationLabel(status) { return VERIFICATION_LABELS[String(status || '').toUpperCase()] || status || '—'; }
