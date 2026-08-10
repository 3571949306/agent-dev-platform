'use strict';
/**
 * OrchestrationBlackboard — v2.9.0 当前 Root Run 的共享工作状态（spec §34-38）。
 *
 * 只属于当前 Root Run（§35），不是跨 Run Memory。Main Agent 下一轮从 Blackboard
 * 取 Child Result，而非重新搜索聊天记录（§36）。
 *
 * Context Budget（§37）：Child raw output 分层 summary/findings/diff/artifacts，
 * 不把 20MB stdout / 完整 reasoning 塞回模型。
 *
 * Reasoning Privacy（§38）：外部 Agent 只提供 reasoning summary 就只保存 summary，
 * 禁止试图提取隐藏 Chain-of-Thought。
 *
 * Secret Sanitization（§115）：Child Result / Blackboard 中 sanitize 凭据模式。
 */

const SECRET_PATTERN = /(sk-[A-Za-z0-9]|gh[pous]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|xox[bpoa]-[A-Za-z0-9-]+|-----BEGIN[\s\S]*?END [A-Z ]+-----|Cookie=[^;\s]+|refresh_token[=:]\S+|password[=:]\S+)/gi;

/** 内联结果字符上限（§114）：超过存 artifact，Blackboard 只放摘要。 */
const MAX_INLINE_RESULT_CHARS = 8000;

/**
 * sanitize 凭据模式（§115）。
 */
function sanitize(text) {
  if (typeof text !== 'string' || !text) return text || '';
  return text.replace(SECRET_PATTERN, '[REDACTED]');
}

/**
 * 创建 OrchestrationBlackboard 实例（per Root Run）。
 */
function createBlackboard() {
  const state = {
    goal: null,
    plan: null,
    knownFacts: [],
    childResults: [],
    findings: [],
    changedFiles: [],
    tests: [],
    blockers: [],
    decisions: []
  };

  function setGoal(goal) { state.goal = goal; }
  function setPlan(plan) { state.plan = plan; }
  function addFact(fact) {
    if (fact && typeof fact === 'string') state.knownFacts.push(fact);
  }
  function addFinding(finding) {
    if (!finding) return;
    const f = typeof finding === 'string' ? finding : (finding && finding.summary) || JSON.stringify(finding);
    state.findings.push({ time: Date.now(), text: sanitize(f) });
  }
  function addBlocker(blocker) {
    if (blocker) state.blockers.push({ time: Date.now(), text: sanitize(String(blocker)) });
  }
  function addDecision(decision) {
    if (decision) state.decisions.push({ time: Date.now(), text: sanitize(String(decision)) });
  }

  /**
   * 写入 Child Result（§36/§52/§53）。
   *   - changedFiles 加入 Parent changedFiles 集合（§52）
   *   - tests 标记 externalClaim（§53：external tests passed ≠ localVerification）
   *   - 大输出截断为 summary，完整存 artifact（§37/§114）
   *   - sanitize secrets（§115）
   * @param {object} childResult  AgentResult（§12）
   * @returns {object} 写入 Blackboard 的摘要（喂回 Main Agent 的 observation）
   */
  function addChildResult(childResult) {
    if (!childResult) return null;
    const entry = {
      time: Date.now(),
      agentId: childResult.agentId || null,
      runId: childResult.runId || null,
      status: childResult.status || 'unknown',
      summary: sanitize(truncate(childResult.summary)),
      findings: Array.isArray(childResult.findings)
        ? childResult.findings.map(sanitize).slice(0, 20) : [],
      changedFiles: Array.isArray(childResult.changedFiles)
        ? childResult.changedFiles.slice(0, 200) : [],
      tests: childResult.tests
        ? {
            externalClaim: true,   // §53：external tests passed ≠ localVerification
            passed: !!childResult.tests.passed,
            summary: sanitize(truncate(childResult.tests.summary || ''))
          } : null,
      errors: Array.isArray(childResult.errors)
        ? childResult.errors.map(e => sanitize(typeof e === 'string' ? e : (e && e.message) || '')).slice(0, 10) : [],
      durationMs: childResult.durationMs || null,
      artifactRef: null   // 大输出存 artifact 后引用（§114）
    };
    state.childResults.push(entry);
    // §52: Child changedFiles 加入 Parent 集合
    if (entry.changedFiles.length) {
      for (const f of entry.changedFiles) {
        if (!state.changedFiles.includes(f)) state.changedFiles.push(f);
      }
    }
    // findings 合并
    if (entry.findings.length) {
      for (const f of entry.findings) state.findings.push({ time: entry.time, text: f });
    }
    return entry;
  }

  /**
   * 生成喂回 Main Agent 的 observation 文本（§36）。
   * 不重新搜索聊天记录，而是从 Blackboard 提取当前状态。
   */
  function buildObservation() {
    const lines = [];
    if (state.goal) lines.push(`目标: ${state.goal}`);
    if (state.childResults.length) {
      const last = state.childResults[state.childResults.length - 1];
      lines.push(`子 Agent 结果 (${last.agentId || 'unknown'}):`);
      lines.push(`  状态: ${last.status}`);
      if (last.summary) lines.push(`  摘要: ${last.summary}`);
      if (last.findings.length) lines.push(`  发现: ${last.findings.join('; ')}`);
      if (last.tests) lines.push(`  测试(外部声明): passed=${last.tests.passed}（需本地复核）`);
      if (last.changedFiles.length) lines.push(`  改动文件: ${last.changedFiles.join(', ')}`);
      if (last.errors.length) lines.push(`  错误: ${last.errors.join('; ')}`);
    }
    if (state.blockers.length) lines.push(`阻塞: ${state.blockers.map(b => b.text).join('; ')}`);
    return lines.join('\n');
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  return {
    setGoal, setPlan, addFact, addFinding, addBlocker, addDecision,
    addChildResult, buildObservation, snapshot,
    get: (key) => state[key]
  };
}

/** 截断大输出（§114）。 */
function truncate(text, max) {
  const m = max || MAX_INLINE_RESULT_CHARS;
  if (typeof text !== 'string') return text || '';
  if (text.length <= m) return text;
  return text.slice(0, m) + `\n...[截断，完整输出存 artifact，原始 ${text.length} 字符]`;
}

module.exports = { createBlackboard, sanitize, truncate, MAX_INLINE_RESULT_CHARS };
