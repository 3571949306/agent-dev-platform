'use strict';
/**
 * Browser automation via Playwright. Tools are exposed to the Agent Runtime.
 * If Playwright/browser binaries are not installed, tools report a clear message
 * instead of crashing (so the app still boots).
 */
// Launch strategies, tried in order. The bundled Chromium is preferred, but a
// fresh machine often has no Playwright browser downloaded — every Windows
// box does have Edge, so we fall back to the system browsers instead of
// forcing a ~150MB download before the feature works at all.
const LAUNCH_CHAIN = [
  { label: 'Playwright Chromium', opts: {} },
  { label: '系统 Microsoft Edge', opts: { channel: 'msedge' } },
  { label: '系统 Google Chrome', opts: { channel: 'chrome' } }
];

class BrowserManager {
  constructor() { this.browser = null; this.page = null; this.available = null; this.engine = null; this.headless = false; }
  async _ensure() {
    if (this.page) return;
    let pw;
    try { pw = require('playwright'); } catch { this.available = false; throw new Error('未安装 playwright 依赖，请运行：npm i playwright'); }
    const errors = [];
    for (const cand of LAUNCH_CHAIN) {
      try {
        this.browser = await pw.chromium.launch({ headless: this.headless, args: ['--no-sandbox'], ...cand.opts });
        this.page = await this.browser.newPage();
        this.available = true;
        this.engine = cand.label;
        return;
      } catch (e) {
        errors.push(`${cand.label}: ${String(e.message).split('\n')[0]}`);
      }
    }
    this.available = false;
    throw new Error('无法启动浏览器。可运行 `npx playwright install chromium` 下载内置内核，或安装 Edge/Chrome。尝试记录：\n' + errors.join('\n'));
  }
  setHeadless(v) { this.headless = !!v; }
  async launch(opts) {
    if (opts && typeof opts.headless === 'boolean' && !this.page) this.headless = opts.headless;
    await this._ensure();
    return { ok: true, url: this.page.url(), engine: this.engine };
  }
  async navigate(url) { await this._ensure(); await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return { ok: true, url: this.page.url(), title: await this.page.title() }; }
  async snapshot() {
    await this._ensure();
    let a11y = null;
    try { a11y = await this.page.accessibility.snapshot(); } catch {}
    const text = a11y ? JSON.stringify(a11y).slice(0, 4000) : '(无法获取无障碍树)';
    return { ok: true, url: this.page.url(), title: await this.page.title(), accessibility: text };
  }
  async click(target) {
    await this._ensure();
    try { await this.page.click(target, { timeout: 8000 }); }
    catch { await this.page.getByText(target, { exact: false }).first().click({ timeout: 8000 }); }
    return { ok: true };
  }
  async type(target, text) { await this._ensure(); await this.page.fill(target, text); return { ok: true }; }
  async press(key) { await this._ensure(); await this.page.keyboard.press(key); return { ok: true }; }
  async select(target, value) { await this._ensure(); await this.page.selectOption(target, value); return { ok: true }; }
  async scroll(dx, dy) { await this._ensure(); await this.page.mouse.wheel(dx || 0, dy || 0); return { ok: true }; }
  async screenshot() {
    await this._ensure();
    const buf = await this.page.screenshot();
    return { ok: true, data_url: 'data:image/png;base64,' + buf.toString('base64') };
  }
  async close() { try { await this.browser?.close(); } catch {} this.browser = null; this.page = null; this.engine = null; return { ok: true }; }
  status() {
    let installed = false;
    try { require.resolve('playwright'); installed = true; } catch {}
    return { installed, launched: !!this.page, available: this.available, engine: this.engine, headless: this.headless, url: this.page ? this.page.url() : null };
  }
}

const manager = new BrowserManager();

function createBrowserTools() {
  const defs = [
    { name: 'browser_launch', description: '启动浏览器（优先内置 Chromium，缺失时自动回退系统 Edge/Chrome）。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: { headless: { type: 'boolean', description: '是否无界面运行，默认 false（可见，便于用户观察）' } } } },
    { name: 'browser_navigate', description: '打开指定 URL。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'browser_snapshot', description: '获取当前页面 URL、标题与可访问性树（DOM 结构）。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: {} } },
    { name: 'browser_click', description: '按选择器或文本点击元素。', risk_level: 'medium', permission: 'browser', input_schema: { type: 'object', properties: { target: { type: 'string', description: 'CSS 选择器或可见文本' } }, required: ['target'] } },
    { name: 'browser_type', description: '在输入框中填写文本。', risk_level: 'medium', permission: 'browser', input_schema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] } },
    { name: 'browser_press', description: '按下键盘按键（如 Enter）。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    { name: 'browser_select', description: '选择下拉框选项。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: { target: { type: 'string' }, value: { type: 'string' } }, required: ['target', 'value'] } },
    { name: 'browser_scroll', description: '滚动页面。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: { dx: { type: 'number' }, dy: { type: 'number' } } } },
    { name: 'browser_screenshot', description: '截图并返回图片（base64）。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: {} } },
    { name: 'browser_close', description: '关闭浏览器。', risk_level: 'low', permission: 'browser', input_schema: { type: 'object', properties: {} } }
  ];
  const raw = {
    browser_launch: async (ctx, a) => manager.launch(a),
    browser_navigate: async (ctx, a) => manager.navigate(a.url),
    browser_snapshot: async () => manager.snapshot(),
    browser_click: async (ctx, a) => manager.click(a.target),
    browser_type: async (ctx, a) => manager.type(a.target, a.text),
    browser_press: async (ctx, a) => manager.press(a.key),
    browser_select: async (ctx, a) => manager.select(a.target, a.value),
    browser_scroll: async (ctx, a) => manager.scroll(a.dx, a.dy),
    browser_screenshot: async () => manager.screenshot(),
    browser_close: async () => manager.close()
  };
  // Normalize to the runtime tool contract: { ok, data } | { ok:false, error:{code,message} }
  const execs = {};
  for (const [name, fn] of Object.entries(raw)) {
    execs[name] = async (ctx, a) => {
      try { const r = await fn(ctx, a || {}); const { ok, ...rest } = r || {}; return { ok: true, data: rest }; }
      catch (e) { return { ok: false, error: { code: 'BROWSER_ERROR', message: e.message } }; }
    };
  }
  return { defs, execs, manager };
}

module.exports = { BrowserManager, createBrowserTools, manager };
