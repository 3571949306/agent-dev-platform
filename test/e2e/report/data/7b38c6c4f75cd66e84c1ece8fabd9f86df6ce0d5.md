# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: gui-main-path.spec.js >> 5) 停止：model-HANG + 点停止 → 唯一终态 cancelled
- Location: test\e2e\gui-main-path.spec.js:212:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  locator('#btn-stop')
Expected: visible
Received: hidden
Timeout:  10000ms

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('#btn-stop')
    23 × locator resolved to <button id="btn-stop" class="btn danger hidden">■ 停止</button>
       - unexpected value "hidden"

```

```yaml
- banner:
  - img
  - text: Agent Dev Platform
  - button "E2E 测试项目"
  - text: 就绪
  - navigation:
    - button "总览"
    - button "API 连接"
    - button "智能体"
    - button "MCP"
    - button "能力诊断"
    - button "设置"
- complementary:
  - button "对话"
  - button "文件"
  - text: 还没有对话 点击「+ 新对话」开始
- main:
  - combobox:
    - option "代码审查员"
    - option "Computer 操作员"
    - option "主智能体（主）" [selected]
    - option "Codex（外部）"
    - option "WorkBuddy（外部）"
  - combobox:
    - option "未设置模型" [selected]
  - button "+ 新对话"
  - heading "开始一个任务" [level=2]
  - paragraph: 先打开一个项目，然后用自然语言描述你要做的事。
  - text: ⚠ 主智能体尚未选择模型。 API 连接：OpenAI 当前连接已获取：0 个模型
  - button "选择模型"
  - button "打开智能体设置"
  - textbox "输入自然语言需求，例如：分析这个项目为什么构建失败并修复…（Enter 发送，Shift+Enter 换行）": 停不下来
  - button "发送 ▸"
- complementary: 智能体 代码审查员 编码 · 4 工具 · gpt-4o Computer 操作员 电脑操作 · 26 工具 · gpt-4o 主智能体 主智能体 · 编码 · 26 工具 · 未设置模型 Codex 外部 · 0 工具 WorkBuddy 外部 · 0 工具 任务 暂无任务
- contentinfo:
  - button "终端"
  - button "文件更改"
  - button "问题"
  - button "任务"
  - button "电脑控制"
  - button "日志"
  - button "用量"
  - text: 终端输出会在智能体运行命令时实时显示。你也可以在下面直接执行命令（工作目录 = 项目根目录）。 >
  - textbox "例如：npm test（Enter 执行）"
  - button "清空"
```

# Test source

```ts
  117 |   userData = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-e2e-'));
  118 |   await seedDb(userData, fake.baseUrl);
  119 |   app = await launchApp(userData);
  120 |   page = app.firstWindow ? await app.firstWindow() : page;
  121 | });
  122 | 
  123 | test.afterAll(async () => {
  124 |   try { if (app) await app.close(); } catch { /* already closed */ }
  125 |   try { if (fake) fake.server.close(); } catch { /* already closed */ }
  126 |   try { if (userData) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  127 | });
  128 | 
  129 | test('1) API 连接 → GUI 新建 → 拉取模型 → model-A/B/C 真实可见', async () => {
  130 |   await page.getByRole('button', { name: 'API 连接' }).click();
  131 |   await page.waitForSelector('tbody tr', { timeout: 10000 });
  132 |   // 用 GUI 新建另一个连接（Fake API 已由 seed 创建，本用例证明 新建→拉取→看到 完整路径）
  133 |   await page.locator('#conn-add').click();
  134 |   await page.locator('#f-name').fill('E2E Test Conn');
  135 |   await page.locator('#f-provider').selectOption('openai');
  136 |   await page.locator('#f-url').fill(fake.baseUrl);
  137 |   await page.locator('#f-key').fill('sk-e2e-fake');
  138 |   await page.getByRole('button', { name: '保存' }).click();
  139 |   const testRow = page.locator('tbody tr', { hasText: 'E2E Test Conn' });
  140 |   await expect(testRow).toBeVisible({ timeout: 10000 });
  141 |   await testRow.locator('[data-models]').click();
  142 |   await expect(page.locator('body')).toContainText('已成功获取 3 个模型', { timeout: 15000 });
  143 |   // 重新定位行（页面已重渲）
  144 |   const testRow2 = page.locator('tbody tr', { hasText: 'E2E Test Conn' });
  145 |   await testRow2.locator('[data-view]').click();
  146 |   await expect(page.locator('#mm-list')).toContainText('model-A', { timeout: 10000 });
  147 |   await expect(page.locator('#mm-list')).toContainText('model-B');
  148 |   await expect(page.locator('#mm-list')).toContainText('model-C');
  149 |   await expect(page.locator('.mm-source').first()).toContainText('API 获取');
  150 |   // 关闭弹窗（必须真正关掉，否则 overlay 会挡住后续用例）
  151 |   await page.locator('#modal-overlay .modal-x').click();
  152 |   await expect(page.locator('#modal-overlay')).toBeHidden();
  153 | });
  154 | 
  155 | test('2) 智能体 → 编辑主智能体 → Fake 连接 + model-B → 保存 → 重开仍选中', async () => {
  156 |   await page.getByRole('button', { name: '智能体' }).click();
  157 |   await page.waitForSelector('.acard', { timeout: 10000 });
  158 |   const mainCard = page.locator('.acard', { hasText: '主智能体' });
  159 |   await expect(mainCard).toBeVisible({ timeout: 10000 });
  160 |   await mainCard.locator('[data-ae]').click();
  161 |   // 等待 modal 真正打开（连接下拉渲染完成）
  162 |   await page.waitForSelector('#a-conn', { timeout: 10000 });
  163 |   // Fake API 由 seed 创建并指向主智能体，所以下拉里一定能找到
  164 |   await page.locator('#a-conn').selectOption({ label: 'Fake API' });
  165 |   await page.waitForTimeout(300);
  166 |   await page.locator('#a-model').click();
  167 |   await expect(page.locator('#a-model-dropdown')).toBeVisible({ timeout: 10000 });
  168 |   await page.locator('#a-model-dropdown .mm-option[data-model="model-B"]').click();
  169 |   await page.getByRole('button', { name: '保存' }).click();
  170 |   await page.waitForTimeout(600);
  171 |   // 重新打开验证
  172 |   const mainCard2 = page.locator('.acard', { hasText: '主智能体' });
  173 |   await mainCard2.locator('[data-ae]').click();
  174 |   await page.waitForSelector('#a-conn', { timeout: 10000 });
  175 |   await expect(page.locator('#a-model')).toHaveValue('model-B');
  176 |   await page.getByRole('button', { name: '保存' }).click();
  177 | });
  178 | 
  179 | test('3) 【主路径】选好模型发送「你好」→ 无 ReferenceError → completed → Spinner 消失', async () => {
  180 |   pageErrors = [];
  181 |   // 回到聊天
  182 |   await closePage();
  183 |   await page.locator('#btn-newchat').click().catch(() => {});
  184 |   await page.waitForTimeout(500);
  185 |   await page.locator('#input').fill('你好');
  186 |   await page.getByRole('button', { name: '发送 ▸' }).click();
  187 |   // 收到回复并完成（快任务可能直接跳过「运行中」，直接断言终态）
  188 |   await expect(page.locator('#status-text')).toContainText('已完成', { timeout: 30000 });
  189 |   await expect(page.locator('.msg.assistant')).toContainText('你好，我是测试智能体。', { timeout: 10000 });
  190 |   // Spinner 消失：停止按钮隐藏、发送按钮恢复
  191 |   await expect(page.locator('#btn-stop')).toBeHidden();
  192 |   await expect(page.locator('#btn-send')).toBeEnabled();
  193 |   // 终态唯一：只有 run_completed，且没有任何 ReferenceError
  194 |   const delta = await getTerminalDelta();
  195 |   expect(delta).toEqual(['run_completed']);
  196 |   expect(pageErrors.filter(e => /models is not defined|ReferenceError/.test(e))).toEqual([]);
  197 | });
  198 | 
  199 | test('4) 业务失败：model-FAIL → 唯一终态 failed（绝不随后 completed）', async () => {
  200 |   await closePage();
  201 |   await setMainModel('model-FAIL');
  202 |   await page.locator('#input').fill('触发失败');
  203 |   await page.getByRole('button', { name: '发送 ▸' }).click();
  204 |   await expect(page.locator('#status-text')).toContainText('失败', { timeout: 30000 });
  205 |   await expect(page.locator('#btn-stop')).toBeHidden();
  206 |   await expect(page.locator('#btn-send')).toBeEnabled();
  207 |   await page.waitForTimeout(1500); // 留时间给“迟到的 completed”（若有 bug 会冒出来）
  208 |   const delta = await getTerminalDelta();
  209 |   expect(delta).toEqual(['run_failed'], '业务失败后不得再出现 run_completed');
  210 | });
  211 | 
  212 | test('5) 停止：model-HANG + 点停止 → 唯一终态 cancelled', async () => {
  213 |   await closePage();
  214 |   await setMainModel('model-HANG', { timeout_ms: 120000 });
  215 |   await page.locator('#input').fill('停不下来');
  216 |   await page.getByRole('button', { name: '发送 ▸' }).click();
> 217 |   await expect(page.locator('#btn-stop')).toBeVisible({ timeout: 10000 });
      |                                           ^ Error: expect(locator).toBeVisible() failed
  218 |   await page.waitForTimeout(1200);
  219 |   await page.locator('#btn-stop').click();
  220 |   await expect(page.locator('#status-text')).toContainText('已取消', { timeout: 15000 });
  221 |   await expect(page.locator('#btn-stop')).toBeHidden();
  222 |   await page.waitForTimeout(1500);
  223 |   const delta = await getTerminalDelta();
  224 |   expect(delta).toEqual(['run_cancelled'], 'cancelled 后不得再出现 run_completed');
  225 | });
  226 | 
  227 | test('6) 超时：model-HANG + 短 timeout → 唯一终态 timeout', async () => {
  228 |   await closePage();
  229 |   await setMainModel('model-HANG', { timeout_ms: 8000 });
  230 |   await page.locator('#input').fill('超时用例');
  231 |   await page.getByRole('button', { name: '发送 ▸' }).click();
  232 |   await expect(page.locator('#status-text')).toContainText('超时', { timeout: 30000 });
  233 |   await expect(page.locator('#btn-stop')).toBeHidden();
  234 |   await expect(page.locator('#btn-send')).toBeEnabled();
  235 |   await page.waitForTimeout(1500);
  236 |   const delta = await getTerminalDelta();
  237 |   expect(delta).toEqual(['run_timeout'], 'timeout 后不得再出现 run_completed');
  238 |   // 恢复正常模型
  239 |   await setMainModel('model-B', { timeout_ms: 600000 });
  240 | });
  241 | 
  242 | test('7) 模型来源：手动添加 CUSTOM-X → 重启后仍在(source=manual) → 刷新后不丢', async () => {
  243 |   const openFakeModels = async () => {
  244 |     await page.getByRole('button', { name: 'API 连接' }).click();
  245 |     await page.waitForSelector('tbody tr', { timeout: 10000 });
  246 |     const row = page.locator('tbody tr', { hasText: 'Fake API' });
  247 |     await expect(row).toBeVisible({ timeout: 10000 });
  248 |     await row.locator('[data-view]').click();
  249 |     await page.waitForSelector('#mm-list', { timeout: 10000 });
  250 |   };
  251 |   // 手动添加
  252 |   await openFakeModels();
  253 |   await page.locator('#mm-add').click();
  254 |   await page.locator('#mm-add-input').fill('CUSTOM-X');
  255 |   await page.getByRole('button', { name: '添加' }).click();
  256 |   await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  257 |   // 来源 chip = 手动添加
  258 |   await expect(page.locator('.mm-item').filter({ hasText: 'CUSTOM-X' })).toContainText('手动添加');
  259 |   // 筛选：手动添加
  260 |   await page.locator('.mm-filter [data-filter="manual"]').click();
  261 |   await expect(page.locator('#mm-list')).toContainText('CUSTOM-X');
  262 |   // 刷新模型（merge 语义：手动模型保留）
  263 |   await page.locator('#mm-refresh').click();
  264 |   await expect(page.locator('body')).toContainText('已成功获取 3 个模型', { timeout: 15000 });
  265 |   await openFakeModels();
  266 |   await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  267 |   // 重启 App（同一 userData）验证持久化
  268 |   await app.close();
  269 |   app = await launchApp(userData);
  270 |   page = await app.firstWindow();
  271 |   await openFakeModels();
  272 |   await expect(page.locator('#mm-list')).toContainText('CUSTOM-X', { timeout: 10000 });
  273 |   await expect(page.locator('.mm-item').filter({ hasText: 'CUSTOM-X' })).toContainText('手动添加');
  274 | });
  275 | 
  276 | test('8) 全中文：普通用户可见层无英文残留（品牌/技术名除外）', async () => {
  277 |   const bodyText = await page.locator('body').innerText();
  278 |   const forbidden = ['Agents 页', 'Main Agent', 'External Agent', '外部 Agent', '子 Agent', '未指定 Agent', '调用外部 Agent', 'Ready', 'Chats', 'Files', 'Running', 'Completed', 'Failed', 'Cancelled', 'Stop'];
  279 |   for (const bad of forbidden) {
  280 |     expect(bodyText.includes(bad), `页面出现禁止英文「${bad}」`).toBe(false);
  281 |   }
  282 |   // 品牌保留
  283 |   expect(bodyText).toContain('Agent Dev Platform');
  284 | });
  285 | 
  286 | test('9) 无 JS 致命错误（全程 pageerror 收集）', async () => {
  287 |   const fatals = pageErrors.filter(e => /Cannot read|TypeError|ReferenceError|is not defined/.test(e));
  288 |   expect(fatals).toEqual([]);
  289 | });
  290 | 
```