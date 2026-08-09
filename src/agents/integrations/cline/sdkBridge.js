'use strict';
/**
 * Cline SDK Bridge — 动态加载 ESM-only @cline/sdk，为 CJS 主进程提供接口。
 * 不在启动时加载 SDK（lazy load），避免影响 app 启动性能。
 *
 * v2.7.2 External Agent Runtime Reliability 修正（spec §7 / §8 / §9 / §37）：
 *   §7  版本禁止硬编码：改为从 SDK package metadata 读取（require('@cline/sdk/package.json')
 *       → resolve 后回溯目录读 package.json → SDK 自身导出的 version）。三条路径都拿不到时
 *       version = null / versionSource = 'unknown'，绝不伪造一个看起来合理的版本号。
 *   §8  detect 必须真实：probeSdk() 现在校验「模块可解析 + 动态 import 成功 + 期望导出存在」，
 *       而不是「文件存在即 Healthy」。缺失关键导出时 available=false 并给出 missing 列表。
 *   §9  健康检查需要 runtime constructibility：verifyRuntime() 用探针配置构造一个 Agent 实例，
 *       只校验对象形状（有 run 方法），不发起任何真实 API 调用。
 *   §37 projectRoot 必须真实传给 SDK：createAgent() 把 cwd 同时以 cwd / workspacePath /
 *       workingDirectory 三个别名注入构造参数（真实 SDK 字段名未在公开文档中固定），
 *       并由 describeAgentWorkspace() 回读实例，判断 SDK 是否真的接住了这个值。
 */

const fs = require('fs');
const path = require('path');

let _sdk = null;
let _loadPromise = null;
// v2.7.1 — 测试注入：E2E 用 fake SDK 替换真实 @cline/sdk，避免消耗真实 API。
let _testSdk = null;

/** SDK 必须存在的导出（缺失即视为 API 形状不符，不可用）。 */
const REQUIRED_EXPORTS = ['Agent'];
/** 可选导出（缺失不致命，仅记录能力差异）。 */
const OPTIONAL_EXPORTS = ['ClineCore', 'createTool'];

/** 健康检查用的构造探针配置：不含任何真实凭据，不触发网络调用。 */
const PROBE_AGENT_CONFIG = Object.freeze({
  providerId: '__probe__',
  modelId: '__probe__',
  apiKey: '',
  maxIterations: 1
});

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
 * ESM namespace 互操作：部分构建把命名导出挂在 default 上。
 * @param {object} sdk
 * @returns {object}
 */
function unwrapSdk(sdk) {
  if (!sdk) return sdk;
  const hasTop = REQUIRED_EXPORTS.some(k => sdk[k]);
  if (hasTop) return sdk;
  if (sdk.default && REQUIRED_EXPORTS.some(k => sdk.default[k])) return sdk.default;
  return sdk;
}

/**
 * 定位并读取 @cline/sdk 的 package.json（§7 版本真实来源）。
 * @returns {object|null}
 */
function resolveSdkPackageJson() {
  // 1) 包若在 exports 中暴露了 package.json，直接 require
  try {
    // eslint-disable-next-line global-require
    const pkg = require('@cline/sdk/package.json');
    if (pkg && pkg.version) return pkg;
  } catch { /* exports map 可能不暴露 package.json，继续下一条路径 */ }

  // 2) 解析入口文件后向上回溯目录，找到 name === '@cline/sdk' 的 package.json
  try {
    const entry = require.resolve('@cline/sdk');
    let dir = path.dirname(entry);
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (pkg && pkg.name === '@cline/sdk') return pkg;
        } catch { /* 坏 JSON：继续回溯 */ }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ESM-only 包可能无法 require.resolve，继续下一条路径 */ }

  // 3) node_modules 直查（require.resolve 对纯 ESM 包可能抛 ERR_PACKAGE_PATH_NOT_EXPORTED）
  try {
    const candidates = (require.resolve.paths('@cline/sdk') || []);
    for (const base of candidates) {
      const p = path.join(base, '@cline', 'sdk', 'package.json');
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (pkg && pkg.version) return pkg;
      }
    }
  } catch { /* noop */ }

  return null;
}

/**
 * 读取 SDK 版本（§7）。拿不到就返回 null，绝不伪造。
 * @param {object} [sdk]
 * @returns {{ version: string|null, versionSource: string }}
 */
function readSdkVersion(sdk) {
  const pkg = resolveSdkPackageJson();
  if (pkg && typeof pkg.version === 'string' && pkg.version) {
    return { version: pkg.version, versionSource: 'package.json' };
  }
  const mod = unwrapSdk(sdk);
  const exported = mod && (mod.version || mod.VERSION || mod.SDK_VERSION);
  if (typeof exported === 'string' && exported) {
    return { version: exported, versionSource: 'sdk-export' };
  }
  return { version: null, versionSource: 'unknown' };
}

/**
 * 校验 SDK 导出形状（§8）。
 * @param {object} sdk
 * @returns {{ apiSurfaceOk: boolean, exports: object, missing: string[] }}
 */
function inspectExports(sdk) {
  const mod = unwrapSdk(sdk);
  const found = {};
  const missing = [];
  for (const name of [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS]) {
    found[name] = !!(mod && mod[name]);
  }
  for (const name of REQUIRED_EXPORTS) {
    if (!found[name]) missing.push(name);
  }
  return { apiSurfaceOk: missing.length === 0, exports: found, missing };
}

/**
 * 探测 @cline/sdk 是否真实可用（§8）。
 * 判定链：模块可 import → 期望导出齐全 → 版本可读（版本不可读不影响 available）。
 * @returns {Promise<{ available:boolean, installed:boolean, apiSurfaceOk:boolean,
 *                     version:string|null, versionSource:string, exports:object,
 *                     missing:string[], error:string|null }>}
 */
async function probeSdk() {
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (err) {
    return {
      available: false,
      installed: false,
      apiSurfaceOk: false,
      version: null,
      versionSource: 'unknown',
      exports: {},
      missing: [...REQUIRED_EXPORTS],
      error: err && err.message ? err.message : String(err)
    };
  }
  const surface = inspectExports(sdk);
  const { version, versionSource } = readSdkVersion(sdk);
  return {
    available: surface.apiSurfaceOk,
    installed: true,
    apiSurfaceOk: surface.apiSurfaceOk,
    version,
    versionSource,
    exports: surface.exports,
    missing: surface.missing,
    error: surface.apiSurfaceOk
      ? null
      : `@cline/sdk loaded but expected exports are missing: ${surface.missing.join(', ')}`
  };
}

/**
 * 运行时可构造性校验（§9）：用探针配置构造一个 Agent，只检查实例形状。
 * 不发起任何真实 API 调用、不消耗额度。
 * @returns {Promise<{ apiSurfaceOk:boolean, constructible:boolean, detail:string }>}
 */
async function verifyRuntime() {
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (err) {
    return { apiSurfaceOk: false, constructible: false, detail: `sdk load failed: ${err && err.message ? err.message : String(err)}` };
  }
  const surface = inspectExports(sdk);
  if (!surface.apiSurfaceOk) {
    return { apiSurfaceOk: false, constructible: false, detail: `missing exports: ${surface.missing.join(', ')}` };
  }
  const { Agent } = unwrapSdk(sdk);
  if (typeof Agent !== 'function') {
    return { apiSurfaceOk: false, constructible: false, detail: 'Agent export is not constructible' };
  }
  let instance = null;
  try {
    instance = new Agent({ ...PROBE_AGENT_CONFIG });
  } catch (e) {
    return { apiSurfaceOk: true, constructible: false, detail: `Agent constructor threw: ${e && e.message ? e.message : String(e)}` };
  }
  const constructible = !!instance && typeof instance.run === 'function';
  // 探针实例立刻释放，避免持有句柄
  if (instance && typeof instance.dispose === 'function') { try { instance.dispose(); } catch { /* noop */ } }
  else if (instance && typeof instance.cancel === 'function') { try { instance.cancel(); } catch { /* noop */ } }
  return {
    apiSurfaceOk: true,
    constructible,
    detail: constructible ? 'Agent constructible with run()' : 'Agent instance has no run() method'
  };
}

/**
 * 判断构造出的 agent 实例是否真的接住了 workspace 根目录（§37）。
 * SDK 若忽略该字段，这里会返回 applied=false，适配器据此如实上报，
 * 而不是「变量里存了 projectRoot 但 SDK 根本没用」。
 * @param {object} agent
 * @param {string|null} cwd
 * @returns {{ applied: boolean, field: string|null }}
 */
function describeAgentWorkspace(agent, cwd) {
  if (!agent || !cwd) return { applied: false, field: null };
  const candidates = [
    ['cwd', agent.cwd],
    ['workspacePath', agent.workspacePath],
    ['workingDirectory', agent.workingDirectory],
    ['config.cwd', agent.config && agent.config.cwd],
    ['options.cwd', agent.options && agent.options.cwd]
  ];
  for (const [field, value] of candidates) {
    if (value && String(value) === String(cwd)) return { applied: true, field };
  }
  return { applied: false, field: null };
}

/**
 * 创建 Cline Agent 运行实例。
 * @param {object} config — { providerId, modelId, apiKey, systemPrompt?, maxIterations?, cwd? }
 * @param {function} onEvent — 事件回调
 * @returns {Promise<object>} agent 实例
 */
async function createAgent(config, onEvent) {
  const sdk = await loadSdk();
  const { Agent } = unwrapSdk(sdk);
  const opts = {
    providerId: config.providerId,
    modelId: config.modelId,
    apiKey: config.apiKey,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations || 50,
    onEvent: onEvent || undefined
  };
  // §37：workspace 根目录必须真实下发给 SDK。真实字段名未在公开文档固定，
  // 三个常见别名一并传入；由 describeAgentWorkspace() 回读确认是否被接住。
  if (config.cwd) {
    opts.cwd = config.cwd;
    opts.workspacePath = config.cwd;
    opts.workingDirectory = config.cwd;
  }
  const agent = new Agent(opts);
  return agent;
}

/**
 * 创建 ClineCore 运行时（带 built-in tools 和持久化）。
 * @param {object} config — { clientName, cwd? }
 * @returns {Promise<object>} cline 实例
 */
async function createCore(config) {
  const sdk = await loadSdk();
  const { ClineCore } = unwrapSdk(sdk);
  const cline = await ClineCore.create({
    clientName: config.clientName || 'agent-dev-platform',
    ...(config.cwd ? { cwd: config.cwd, workspacePath: config.cwd } : {})
  });
  return cline;
}

module.exports = {
  loadSdk,
  probeSdk,
  verifyRuntime,
  createAgent,
  createCore,
  describeAgentWorkspace,
  readSdkVersion,
  inspectExports,
  setSdkForTest,
  clearSdkForTest,
  REQUIRED_EXPORTS,
  OPTIONAL_EXPORTS
};
