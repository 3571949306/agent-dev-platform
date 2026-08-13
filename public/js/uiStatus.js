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
