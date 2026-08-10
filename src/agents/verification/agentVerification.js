'use strict';
/**
 * agentVerification — 把「验证等级」从各 Adapter 的自由文案收敛成单一真相源
 * （spec §39/§40/§44/§45/§82）。
 *
 * 设计约束：
 *   1. §40 —— 任何地方都不许再自己写 "verified" / "working" / "real"。
 *      GUI 只能显示本模块给出的 VERIFICATION_LEVEL 与维度值。
 *   2. §45 —— Health（当前运行时状态）与 Verification（我们实际验证到哪一步）
 *      是两件事，本模块只回答后者，绝不读 health.status 当作验证结论。
 *   3. 诚实优先 —— 静态基线只声明仓库里真实存在的证据（实现 + fixture 测试）；
 *      更高等级必须由运行时探测/协议握手真实产生，探测不到就是「未验证」。
 *      因此在一台没装 codex 的机器上，Codex 永远不会显示成「本地检测验证」。
 *
 * 等级判定完全委托 verificationRegistry / isClaimAllowed，本模块只负责
 * 「把仓库事实与运行时事实翻译成 evidence」。
 */

const { createVerificationRegistry } = require('./verificationRegistry');
const { VERIFICATION_LEVEL, formatLevel } = require('./verificationLevel');

/**
 * 静态基线证据：仓库里**确实存在**的实现与 fixture 级测试。
 * source 指向真实测试文件，便于审计时逐条复核（§48 证据可追溯）。
 * 注意：这里绝不写 local_detection / protocol / agent_task —— 那些只能来自运行时。
 * @type {Record<string, {implementation?: string, fixture?: string}>}
 */
const BASELINE_EVIDENCE = {
  native: { implementation: 'src/agent/runtime/mainAgentRuntime.js', fixture: 'test/mainAgentRuntime.test.js' },
  codex: { implementation: 'src/agents/adapters/codexAgentAdapter.js', fixture: 'test/codexAppServerClient.test.js' },
  'claude-code': { implementation: 'src/agents/adapters/claudeCodeAgentAdapter.js', fixture: 'test/claudeCodeAdapter.test.js' },
  cline: { implementation: 'src/agents/adapters/clineAgentAdapter.js', fixture: 'test/clineSidecarProtocol.test.js' },
  opencode: { implementation: 'src/agents/adapters/openCodeAgentAdapter.js', fixture: 'test/openCodeAdapter.test.js' },
  openhands: { implementation: 'src/agents/adapters/openHandsAgentAdapter.js', fixture: 'test/openHandsAdapter.test.js' },
  workbuddy: { implementation: 'src/agents/adapters/workBuddyAgentAdapter.js', fixture: 'test/agentAdapter.test.js' }
};

/** 维度值的固定文案（§40：不允许 adapter 自由发挥）。 */
const DIM = {
  YES: '是',
  NO: '否',
  VERIFIED: '已验证',
  NOT_VERIFIED: '未验证',
  UNKNOWN: '未知',
  FIXTURE: 'Fixture 已验证',
  IMPL_ONLY: '仅实现级',
  NOT_DETECTED: '未检测到'
};

/**
 * 判断运行时是否真的完成过协议握手。
 *
 * 只认「有据可查」的信号，宁可少认不可多认：
 *   - cline：sidecar 起来且 ClineCore 可构造 → 与 sidecar 的 JSON-RPC 握手真的发生过
 *   - 其它 agent：availability 明确带 protocolVerified / verification.protocol 标志
 * @param {string} agentId
 * @param {object} a availability 条目
 * @returns {boolean}
 */
function protocolInitializedFrom(agentId, a) {
  if (!a || typeof a !== 'object') return false;
  if (a.protocolVerified === true) return true;
  if (a.verification && a.verification.protocol === true) return true;
  if (agentId === 'cline') {
    const h = a.health || {};
    return !!(h.sidecar && h.sidecar.ready) || !!(h.runtime && h.runtime.probe && h.runtime.coreConstructible);
  }
  return false;
}

/**
 * 计算单个 Agent 的验证画像。
 *
 * @param {string} agentId
 * @param {object} [availability] hub getAvailable() 里对应的条目（可缺省 → 视为未探测到）
 * @returns {{
 *   agentId: string, level: string, levelLabel: string,
 *   dimensions: Array<{key:string,label:string,value:string}>,
 *   evidence: object[]
 * }}
 */
function describeAgentVerification(agentId, availability) {
  const a = availability || null;
  const base = BASELINE_EVIDENCE[agentId] || {};
  const reg = createVerificationRegistry();

  if (base.implementation) {
    reg.record(agentId, { type: 'implementation', status: 'pass', source: base.implementation });
  }
  if (base.fixture) {
    reg.record(agentId, { type: 'fixture', status: 'pass', source: base.fixture });
  }

  // ── 运行时证据（只在真的探测到时才记录）──
  const detected = !!(a && (a.available === true || a.detected === true));
  const version = (a && (a.version || (a.health && a.health.runtime && a.health.runtime.nodeVersion))) || '';
  if (detected && version) {
    reg.record(agentId, { type: 'local_detection', status: 'pass', version: String(version), source: 'runtime detect()' });
  } else if (detected) {
    // 探测到进程/服务但拿不到版本号 —— 记 fail，保证不会被误当成 LOCAL_DETECTION
    reg.record(agentId, { type: 'local_detection', status: 'fail', source: 'runtime detect()（无版本号）' });
  }

  const protocolOk = protocolInitializedFrom(agentId, a);
  if (protocolOk) {
    reg.record(agentId, { type: 'protocol', status: 'pass', source: 'runtime initialize/session 握手' });
  }

  const level = reg.getLevel(agentId);

  const authState = (a && a.auth && (a.auth.state || a.auth.mode)) || '';
  const dimensions = [
    { key: 'installed', label: '安装', value: detected ? DIM.YES : DIM.NOT_DETECTED },
    { key: 'auth', label: '认证', value: authState ? String(authState) : DIM.UNKNOWN },
    { key: 'localDetection', label: '本机探测', value: (detected && version) ? DIM.VERIFIED : DIM.NOT_VERIFIED },
    { key: 'protocolImpl', label: '协议实现', value: base.fixture ? DIM.FIXTURE : (base.implementation ? DIM.IMPL_ONLY : DIM.NOT_VERIFIED) },
    { key: 'realProtocol', label: '真实本机协议', value: protocolOk ? DIM.VERIFIED : DIM.NOT_VERIFIED },
    // §43 —— 真实模型任务始终由真实端到端任务证据决定；付费 provider 不因"配好了"就算验证
    { key: 'realAgentTask', label: '真实模型任务', value: level === VERIFICATION_LEVEL.REAL_AGENT_TASK_VERIFIED ? DIM.VERIFIED : DIM.NOT_VERIFIED }
  ];

  return {
    agentId,
    level,
    levelLabel: formatLevel(level),
    dimensions,
    evidence: reg.getEvidence(agentId)
  };
}

/**
 * 批量计算：给定 manifests + availability 列表，返回 agentId → 验证画像。
 * @param {Array<{id:string}>} manifests
 * @param {Array<{id:string}>} available
 * @returns {Record<string, object>}
 */
function describeAll(manifests, available) {
  const byId = new Map((available || []).filter(Boolean).map(a => [a.id, a]));
  const out = {};
  for (const m of (manifests || [])) {
    if (!m || !m.id) continue;
    out[m.id] = describeAgentVerification(m.id, byId.get(m.id) || null);
  }
  return out;
}

module.exports = {
  BASELINE_EVIDENCE,
  describeAgentVerification,
  describeAll
};
