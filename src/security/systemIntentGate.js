'use strict';
/**
 * P3 Computer Use Hardening (P0 safety) — System / Destructive Intent Gate.
 *
 * shutdown / restart / logoff / sleep / format / diskpart / system reset /
 * user deletion / registry destruction must NEVER execute because an old
 * message, a model suggestion, a test fixture or an error summary mentioned
 * it. They require ALL FOUR of:
 *
 *   current user request  +  specific action match  +  PermissionEngine  +
 *   destructive confirmation
 *
 * Missing any one → DENY (spawn = 0). This gate runs INSIDE the terminal exec
 * path, so even an `always` grant on terminal.dangerous cannot skip it: the
 * intent must be in THIS turn's user message, and an explicit confirmation
 * callback must approve the exact action.
 */

/**
 * System-level action patterns. `keywords` are what the CURRENT user request
 * must contain (any one) for the intent to count as "the user asked for this".
 */
const SYSTEM_ACTIONS = [
  {
    kind: 'shutdown',
    label: '关机',
    re: /\bshutdown(\.exe)?\b[^\n]*(\/s\b|\/p\b|\/h\b|-s\b|-p\b|-h\b)|Stop-Computer/i,
    keywords: [/关机/, /shut\s*down/i, /\bshutdown\b/i]
  },
  {
    kind: 'restart',
    label: '重启',
    re: /\bshutdown(\.exe)?\b[^\n]*(\/r\b|\/g\b|-r\b|-g\b)|\breboot\b|Restart-Computer/i,
    keywords: [/重启/, /重新启动/, /\brestart\b/i, /\breboot\b/i]
  },
  {
    kind: 'logoff',
    label: '注销',
    re: /\blogoff(\.exe)?\b|\bshutdown(\.exe)?\b[^\n]*(\/l\b|-l\b)/i,
    keywords: [/注销/, /\blog\s*off\b/i, /\bsign\s*out\b/i]
  },
  {
    kind: 'sleep',
    label: '睡眠/休眠',
    re: /rundll32(\.exe)?\s+powrprof\.dll\s*,\s*SetSuspendState/i,
    keywords: [/睡眠/, /休眠/, /\bsleep\b/i, /\bhibernate\b/i]
  },
  {
    kind: 'format',
    label: '格式化磁盘',
    re: /\bformat(\.exe)?\s+[a-z]:/i,
    keywords: [/格式化/, /\bformat\b/i]
  },
  {
    kind: 'diskpart',
    label: '磁盘分区操作',
    re: /\bdiskpart(\.exe)?\b/i,
    keywords: [/diskpart/, /分区/]
  },
  {
    kind: 'system-reset',
    label: '系统重置',
    re: /\bsystemreset(\.exe)?\b|\bresetpc\b/i,
    keywords: [/重置系统/, /重置电脑/, /system\s*reset/i, /\bsystemreset\b/i]
  },
  {
    kind: 'user-delete',
    label: '删除用户',
    re: /\bnet\s+user\s+\S+\s+\/delete/i,
    keywords: [/删除用户/, /delete\s+user/i]
  },
  {
    kind: 'registry-destructive',
    label: '注册表破坏',
    re: /\breg(\.exe)?\s+delete\s+(hklm|hkcu|hkcr|hkcc|hku)\b/i,
    keywords: [/注册表/, /registry/i]
  }
];

/** @returns {{isSystem:boolean, kind?:string, label?:string}} */
function detectSystemAction(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return { isSystem: false };
  for (const rule of SYSTEM_ACTIONS) {
    if (rule.re.test(cmd)) return { isSystem: true, kind: rule.kind, label: rule.label };
  }
  return { isSystem: false };
}

/**
 * P3 Closure — intent hardening.
 *
 * Pure keyword matching is NOT intent: "不要关机", "解释 shutdown 命令",
 * "测试不要真的重启" and "代码里有 Restart-Computer" all contain the keyword
 * yet are the OPPOSITE of an execution request. Two extra fences:
 *
 *   negation      — a negator (不要/别/勿/不用/don't/never …) governs the
 *                   keyword occurrence → NO intent for that action kind.
 *   mention-only  — the message talks ABOUT the command (解释/说明/示例/
 *                   代码里/文档 …) instead of requesting it → NO intent.
 *
 * A genuine request like "请帮我关机" passes both fences untouched.
 */

/** Negators that invalidate a keyword match when they govern it. */
const NEGATORS_RE = /(不要|不需要|不用|别去|别|勿|禁止|不能|不许|千万别|绝不|无需|没让|没有让|don'?t|do\s+not|never|avoid|no\s+need)/i;
/** How far BEFORE a keyword occurrence a negator still governs it. */
const NEGATION_WINDOW = 10;
/** Discourse markers that turn a command mention into talk ABOUT the command. */
const MENTION_MARKERS_RE = /(解释|说明|是什么意思|什么意思|什么作用|介绍|科普|学习|了解|文档|注释|代码里|代码中|脚本里|示例|举例|比如|例如|就像|假如|如果.*才|假装|模拟|提到|说过|不要真的|别真的)/i;

/** Does `msg` contain a keyword occurrence that is NOT negated? */
function hasAffirmativeKeyword(rule, msg) {
  for (const re of rule.keywords) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = global.exec(msg)) !== null) {
      const before = msg.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      if (!NEGATORS_RE.test(before)) return true; // this occurrence is affirmative
      if (m.index === global.lastIndex) global.lastIndex++; // zero-width safety
    }
  }
  return false;
}

/** Does the CURRENT user message actually ask for this kind of action?
 * Keyword present + not negated + not a mere mention of the command. */
function intentMatches(kind, userMessage) {
  const rule = SYSTEM_ACTIONS.find(r => r.kind === kind);
  if (!rule) return false;
  const msg = String(userMessage == null ? '' : userMessage);
  if (!msg.trim()) return false;
  if (!rule.keywords.some(re => re.test(msg))) return false;           // no keyword at all
  if (MENTION_MARKERS_RE.test(msg)) return false;                      // talking about it
  if (!hasAffirmativeKeyword(rule, msg)) return false;                 // every occurrence negated
  return true;
}

/**
 * @param {object} o
 * @param {string} o.command             the command about to run
 * @param {string} [o.currentUserMessage] THIS turn's user request (never history)
 * @param {Function} [o.confirm]         async ({kind,label,command}) => {approved:boolean}
 * @returns {Promise<{allowed:true}|{allowed:false, code:string, kind?:string, error:string}>}
 */
async function authorizeSystemAction(o = {}) {
  const d = detectSystemAction(o.command);
  if (!d.isSystem) return { allowed: true };

  // 1. current explicit intent — stale/history mentions are worthless here
  if (!intentMatches(d.kind, o.currentUserMessage)) {
    return {
      allowed: false,
      code: 'SYSTEM_ACTION_NO_CURRENT_INTENT',
      kind: d.kind,
      error: `系统级动作「${d.label}」被拦截：当前用户请求未明确要求该操作（历史消息/模型建议不构成授权）`
    };
  }
  // 2. destructive confirmation — ALWAYS interactive, even with an `always` grant
  if (typeof o.confirm !== 'function') {
    return {
      allowed: false,
      code: 'SYSTEM_ACTION_CONFIRM_UNAVAILABLE',
      kind: d.kind,
      error: `系统级动作「${d.label}」被拦截：缺少破坏性确认通道（fail-closed）`
    };
  }
  let decision = null;
  try {
    decision = await o.confirm({ kind: d.kind, label: d.label, command: o.command });
  } catch (e) {
    return { allowed: false, code: 'SYSTEM_ACTION_CONFIRM_FAILED', kind: d.kind, error: '确认通道异常：' + (e.message || e) };
  }
  if (!decision || decision.approved !== true) {
    return { allowed: false, code: 'SYSTEM_ACTION_USER_DENIED', kind: d.kind, error: `用户未批准系统级动作「${d.label}」` };
  }
  return { allowed: true, kind: d.kind };
}

module.exports = { SYSTEM_ACTIONS, detectSystemAction, intentMatches, authorizeSystemAction };
