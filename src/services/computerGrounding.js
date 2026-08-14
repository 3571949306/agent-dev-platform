'use strict';
/**
 * P3 Computer Use Hardening — Vision Grounding.
 *
 * Vision is the SECOND choice (UIA semantic > Vision grounding > raw
 * coordinate). When UIA is insufficient, a vision model grounded on the
 * observation's screenshot PROPOSES a normalized target; the proposal is
 * inert — execution must re-enter the canonical Computer Tool (Tool Gate →
 * PermissionEngine → ComputerSession → Target Fence → Observation Fence →
 * DesktopInteractionLock). This service never executes anything.
 *
 * P3 Closure (C4): model access goes through the REAL routing chain —
 * Model Catalog → Model Router → RuntimeModelResolver → ProviderModelAdapter
 * → selected wire model. The injected `resolveVision` returns
 * `{ modelAdapter, selection }` exactly as createRuntimeModelResolver does;
 * this module performs ZERO direct provider calls, ZERO connection secret
 * access and owns NO provider client. Confidence below threshold → no
 * proposal accepted, full stop: confidence is NOT a substitute for
 * PermissionEngine and never replaces the destructive-confirmation path.
 */
const { extractJson } = require('./visionReader');
const { textPart, imagePart } = require('../providers/content');

const GROUNDING_SYSTEM_PROMPT = [
  '你是桌面界面定位助手。给你一张目标窗口截图和任务目标，请定位要操作的界面元素。',
  '',
  '只输出一个 JSON 对象。不要 Markdown 代码块，不要解释文字。字段固定为：',
  '{"action":"click|type|scroll|none","target":"目标元素的简短描述","normalizedX":0到1的小数,"normalizedY":0到1的小数,"confidence":0到1的小数,"reason":"一句话依据"}',
  '',
  '规则：',
  '- normalizedX/normalizedY 是相对整张截图（即目标窗口）的归一化坐标，左上角为 (0,0)，右下角为 (1,1)。',
  '- 指到元素中心点。找不到可信目标时 action="none" 并把 confidence 调低。',
  '- 绝不猜测被遮挡或不存在的内容。'
].join('\n');

const MIN_CONFIDENCE_DEFAULT = 0.6;

/**
 * Validate a parsed grounding response (pure; unit-tested without providers).
 * @returns {{ok:true, grounding:object}|{ok:false, code:string, error:string}}
 */
function validateGroundingResponse(parsed, { minConfidence = MIN_CONFIDENCE_DEFAULT } = {}) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, code: 'GROUNDING_BAD_OUTPUT', error: '视觉模型未返回可解析的 JSON' };
  }
  const action = String(parsed.action || '').toLowerCase();
  if (!['click', 'type', 'scroll', 'none'].includes(action)) {
    return { ok: false, code: 'GROUNDING_BAD_OUTPUT', error: '未知的 grounding action' };
  }
  const nx = Number(parsed.normalizedX);
  const ny = Number(parsed.normalizedY);
  const confidence = Number(parsed.confidence);
  if (action !== 'none' && (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1)) {
    return { ok: false, code: 'GROUNDING_BAD_OUTPUT', error: 'grounding 坐标非法（必须为 0..1 有限数）' };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, code: 'GROUNDING_BAD_OUTPUT', error: 'grounding confidence 非法' };
  }
  if (action !== 'none' && confidence < minConfidence) {
    // Blind clicks are forbidden: low confidence → zero execution.
    return { ok: false, code: 'COMPUTER_GROUNDING_LOW_CONFIDENCE', error: `grounding 置信度 ${confidence.toFixed(2)} 低于阈值 ${minConfidence}，禁止执行` };
  }
  return {
    ok: true,
    grounding: {
      action,
      target: String(parsed.target || '').slice(0, 200),
      normalizedX: action === 'none' ? null : nx,
      normalizedY: action === 'none' ? null : ny,
      confidence,
      reason: String(parsed.reason || '').slice(0, 300)
    }
  };
}

class ComputerGroundingService {
  /**
   * @param opts.resolveVision () => { modelAdapter, selection } | null
   *        production wiring: runtimeModelResolver.resolveRuntimeModel({
   *          mode: 'auto', requirements: { required: { vision: true } }, … })
   *        — i.e. Model Catalog → Model Router → ProviderModelAdapter.
   *        modelAdapter.decide({ system, context, abortSignal }) is the ONLY
   *        model call surface this service ever touches.
   * @param opts.minConfidence
   * @param opts.timeoutMs
   */
  constructor({ resolveVision = null, minConfidence = MIN_CONFIDENCE_DEFAULT, timeoutMs = 60000 } = {}) {
    this.resolveVision = resolveVision || (() => null);
    this.minConfidence = minConfidence;
    this.timeoutMs = timeoutMs;
    this.calls = 0;
    this.lastRoute = null; // public route audit truth (never contains secrets)
  }

  available() {
    try { return !!this.resolveVision(); } catch { return false; }
  }

  /** Public route audit snapshot: capability/connection/model/reasons only. */
  routeAudit() { return this.lastRoute ? { ...this.lastRoute } : null; }

  /**
   * @param {object} req GroundingRequest { observationId, goal, screenshotDataUrl,
   *                        windowMeta, uiaNodes }
   * @param {object} [o] { signal } Run/Session AbortSignal — cancellation aborts
   *                     the routed adapter and a late result can never act.
   * @returns {Promise<{ok:true, grounding, route}|{ok:false, code, error}>}
   */
  async ground(req = {}, { signal = null } = {}) {
    let route = null;
    try { route = this.resolveVision({ signal }); } catch (e) {
      return { ok: false, code: 'VISION_MODEL_REQUIRED', error: '视觉模型路由失败：' + (e.message || e) };
    }
    if (!route || !route.modelAdapter || typeof route.modelAdapter.decide !== 'function') {
      return { ok: false, code: 'VISION_MODEL_REQUIRED', error: '未配置可用的视觉模型（Grounding 需要多模态连接）' };
    }
    if (!req.screenshotDataUrl) return { ok: false, code: 'NO_FRAME', error: '缺少观察截图' };
    if (!req.goal) return { ok: false, code: 'NO_GOAL', error: '缺少 grounding 目标描述' };

    const selection = route.selection || null;
    const selected = (selection && selection.selected) || {};
    // Route audit truth: requested capability / connection / model / reasons.
    // NEVER secrets — decrypted connection material never enters this module.
    this.lastRoute = {
      requestedCapability: 'vision',
      connectionId: selected.connectionId || null,
      model: selected.modelId || null,
      mode: (selection && selection.mode) || null,
      reasons: Array.isArray(selection && selection.reasons) ? selection.reasons.map(r => r && r.code).filter(Boolean) : [],
      decisionId: (selection && selection.decisionId) || null
    };

    const uiaHint = Array.isArray(req.uiaNodes) && req.uiaNodes.length
      ? `\n\nUI 自动化已识别的元素（优先利用）：\n${req.uiaNodes.slice(0, 30).join('\n')}`
      : '';
    const meta = req.windowMeta ? `\n窗口：${req.windowMeta.title || ''}（${req.windowMeta.processName || ''}）` : '';
    // ProviderModelAdapter.decide sends `context` as the single user message —
    // multipart parts carry the screenshot to the wire model.
    const context = [
      textPart(`任务目标：${String(req.goal).slice(0, 400)}${meta}${uiaHint}`),
      imagePart(req.screenshotDataUrl)
    ];

    this.calls++;
    let raw = '';
    try {
      const r = await route.modelAdapter.decide({
        system: GROUNDING_SYSTEM_PROMPT,
        context,
        iteration: 0,
        abortSignal: signal || undefined
      });
      raw = (r && r.text) || '';
    } catch (e) {
      const aborted = (e && (e.aborted === true || e.name === 'AbortError')) || !!(signal && signal.aborted);
      return { ok: false, code: aborted ? 'CANCELLED' : 'GROUNDING_CALL_FAILED', error: e.message };
    }

    const parsed = extractJson(raw);
    const v = validateGroundingResponse(parsed, { minConfidence: this.minConfidence });
    if (!v.ok) return v;
    return {
      ok: true,
      grounding: { ...v.grounding, model: this.lastRoute.model, observationId: req.observationId || null },
      route: this.routeAudit()
    };
  }
}

module.exports = { ComputerGroundingService, validateGroundingResponse, GROUNDING_SYSTEM_PROMPT, MIN_CONFIDENCE_DEFAULT };
