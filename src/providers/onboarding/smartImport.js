'use strict';
/**
 * v2.4.0 Smart API Onboarding — smartImport 调度器。
 *
 * 按「先粘贴，再识别」语义，把任意输入分发给各 parser，取第一个成功结果。
 * 优先级（基于输入特征，不是固定顺序）：
 *   1. ccswitch:// Deep Link → ccSwitch.parseDeepLink
 *   2. ccswitch config 数组 → ccSwitch.parseConfigBatch（多 provider，返回 batch）
 *   3. curl 开头 → curl
 *   4. JSON 对象/数组 → json（数组走 ccSwitch.parseConfigBatch 兼容）
 *   5. ENV（含 KEY=value 或 $env:）→ env
 *   6. new OpenAI( → codeSnippet
 *   7. TOML（[section] 或 key=value）→ toml
 *   8. 兜底 → plainText
 *
 * 返回 { candidate?: ImportCandidate, batch?: ImportCandidate[], source } 。
 */

const plainText = require('./parsers/plainText');
const env = require('./parsers/env');
const json = require('./parsers/json');
const toml = require('./parsers/toml');
const curl = require('./parsers/curl');
const codeSnippet = require('./parsers/codeSnippet');
const ccSwitch = require('./parsers/ccSwitch');

/**
 * @param {string} text 用户粘贴的原始输入
 * @returns {{ candidate?: object, batch?: object[], matchedParser?: string, note?: string }}
 */
function parseInput(text) {
  if (!text || typeof text !== 'string') return {};
  const trimmed = text.trim();
  if (!trimmed) return {};

  // 1. CC Switch Deep Link
  if (/^ccswitch:\/\//i.test(trimmed)) {
    const c = ccSwitch.parseDeepLink(trimmed);
    if (c) return { candidate: c, matchedParser: 'ccSwitch-deeplink' };
  }

  // 2. JSON 数组 → 视为 CC Switch 批量配置
  if (trimmed.startsWith('[')) {
    let arr;
    try { arr = JSON.parse(trimmed); } catch { arr = null; }
    if (Array.isArray(arr) && arr.length && arr[0] && typeof arr[0] === 'object' && (arr[0].name || arr[0].settingsConfig)) {
      const batch = ccSwitch.parseConfigBatch(arr);
      if (batch.length) return { batch, matchedParser: 'ccSwitch-config-batch' };
    }
  }

  // 3. curl
  if (/^curl\s+/i.test(trimmed)) {
    const c = curl.parse(trimmed);
    if (c) return { candidate: c, matchedParser: 'curl' };
  }

  // 4. JSON 对象
  if (trimmed.startsWith('{')) {
    const c = json.parse(trimmed);
    if (c) return { candidate: c, matchedParser: 'json' };
  }

  // 5. ENV（sh / PowerShell）
  //    含 $env: 或 多行 KEY=value 且至少一个已知 KEY
  //    注意：\b 在 _ 旁不构成边界（_ 是 word char），故用子串匹配
  if (/^\$env:/m.test(trimmed) || /^export\s+[A-Z][A-Z0-9_]*\s*=/m.test(trimmed) ||
      (/^[A-Z][A-Z0-9_]*\s*=\s*[^\n]+\n/m.test(trimmed) && /(OPENAI|ANTHROPIC|DEEPSEEK|OPENROUTER|API_KEY|API_BASE|BASE_URL)/.test(trimmed))) {
    const c = env.parse(trimmed);
    if (c) return { candidate: c, matchedParser: 'env' };
  }

  // 6. Code snippet（JS/Python 构造调用）
  if (/\b(?:new\s+)?(?:OpenAI|Anthropic|OpenRouter|DeepSeek|Client|AzureOpenAI)\s*\(/i.test(trimmed)) {
    const c = codeSnippet.parse(trimmed);
    if (c) return { candidate: c, matchedParser: 'codeSnippet' };
  }

  // 7. TOML（[section] 或 key = value，但不含 {）
  if (!trimmed.startsWith('{') && (/^\[[^\]]+\]/m.test(trimmed) || /^[A-Za-z0-9_\-]+\s*=\s*["']/m.test(trimmed))) {
    const c = toml.parse(trimmed);
    if (c) return { candidate: c, matchedParser: 'toml' };
  }

  // 8. 兜底 plainText
  const c = plainText.parse(trimmed);
  if (c) return { candidate: c, matchedParser: 'plainText' };

  return { matchedParser: null, note: '无法识别输入格式' };
}

module.exports = { parseInput };
