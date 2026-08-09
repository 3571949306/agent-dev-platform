'use strict';
/**
 * Cline SDK Bridge — 动态加载 ESM-only @cline/sdk，为 CJS 主进程提供接口。
 * 不在启动时加载 SDK（lazy load），避免影响 app 启动性能。
 */

let _sdk = null;
let _loadPromise = null;
// v2.7.1 — 测试注入：E2E 用 fake SDK 替换真实 @cline/sdk，避免消耗真实 API。
let _testSdk = null;

/**
 * 测试专用：注入 fake SDK 模块（仅 NODE_ENV=test 下由 IPC test handler 调用）。
 * 调用后 loadSdk/probeSdk/createAgent 全部使用 fake，直到 clearSdkForTest()。
 * @param {object} fakeSdk — { Agent, ClineCore, createTool }
 */
function setSdkForTest(fakeSdk) {
  _testSdk = fakeSdk || null;
  _sdk = null;
  _loadPromise = null;
}

/** 测试专用：清除 fake SDK 注入，恢复真实 lazy load 行为。 */
function clearSdkForTest() {
  _testSdk = null;
  _sdk = null;
  _loadPromise = null;
}

/**
 * 动态加载 @cline/sdk。
 * @returns {Promise<object>} SDK 模块
 */
async function loadSdk() {
  if (_testSdk) return _testSdk;
  if (_sdk) return _sdk;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      // 动态 import ESM 模块
      const mod = await import('@cline/sdk');
      _sdk = mod;
      return _sdk;
    } catch (err) {
      _loadPromise = null;
      throw err;
    }
  })();
  return _loadPromise;
}

/**
 * 检查 SDK 是否已安装。
 * @returns {Promise<{ available: boolean, version: string|null, error: string|null }>}
 */
async function probeSdk() {
  try {
    const sdk = await loadSdk();
    const version = sdk.Agent ? '0.0.72' : null; // 从 package.json 读取更准确
    return { available: true, version, error: null };
  } catch (err) {
    return { available: false, version: null, error: err.message };
  }
}

/**
 * 创建 Cline Agent 运行实例。
 * @param {object} config — { providerId, modelId, apiKey, systemPrompt?, maxIterations?, cwd? }
 * @param {function} onEvent — 事件回调
 * @returns {Promise<object>} agent 实例
 */
async function createAgent(config, onEvent) {
  const sdk = await loadSdk();
  const { Agent } = sdk;
  const agent = new Agent({
    providerId: config.providerId,
    modelId: config.modelId,
    apiKey: config.apiKey,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations || 50,
    onEvent: onEvent || undefined
  });
  return agent;
}

/**
 * 创建 ClineCore 运行时（带 built-in tools 和持久化）。
 * @param {object} config — { clientName, cwd? }
 * @returns {Promise<object>} cline 实例
 */
async function createCore(config) {
  const sdk = await loadSdk();
  const { ClineCore } = sdk;
  const cline = await ClineCore.create({
    clientName: config.clientName || 'agent-dev-platform'
  });
  return cline;
}

module.exports = { loadSdk, probeSdk, createAgent, createCore, setSdkForTest, clearSdkForTest };
