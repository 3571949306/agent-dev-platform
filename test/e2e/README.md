# GUI E2E 测试（test/e2e）

v2.3.1 的真机主路径验收：**真实 Electron 窗口 + 本地 Fake API + 临时 userData**。

## 文件

- `fake-api.js` — 本地 `http` 服务器，提供 `/v1/models`（model-A/B/C）+ `/v1/chat/completions` SSE 流式回复；`model-FAIL` → 500，`model-HANG` → 永不返回。
- `seed-db.js` — `ELECTRON_RUN_AS_NODE=1` 下运行（匹配 better-sqlite3 的 Electron ABI），初始化临时数据库 + 创建测试项目 + 创建 Fake API 连接并预填模型 + 指向主智能体。
- `gui-main-path.spec.js` — 9 个真机 Playwright 用例。
- `README.md` — 本文件。

## 运行

```bash
# 前置：@playwright/test 已安装（v1.62.x）
npm run e2e
```

`playwright.config.js` 默认指向 `./test/e2e`，1 worker 串行（GUI 共享同一窗口），超时 90s。

## 隔离

- `main.js` 支持 `ADP_USER_DATA` 环境变量 → E2E 每次使用 `%TEMP%\adp-e2e-<uuid>` 临时目录，绝不污染真实数据。
- 关闭 Electron 进程后清理临时目录（`test.afterAll`）。

## 用例覆盖

1. **API 模型中心** —— GUI 新建连接 → 拉取模型 → 查看模型 → model-A/B/C 可见 + 来源 chip「API 获取」→ 关闭弹窗。
2. **Agent 模型选择** —— 编辑主智能体 → 选 Fake API + model-B → 保存 → 重开仍选中。
3. **【主路径】** —— 发「你好」→ 无 ReferenceError → Spinner 消失 → 唯一终态 `run_completed`。
4. **业务失败** —— model-FAIL → 唯一终态 `run_failed`（**绝不随后 completed**）。
5. **停止** —— model-HANG + 停止按钮 → 唯一终态 `run_cancelled`。
6. **超时** —— model-HANG + `agent.timeout_ms=8000` → 唯一终态 `run_timeout`。
7. **来源持久化** —— 手动添加 CUSTOM-X → 刷新后保留 → 重启 App 后仍存在 + 来源 chip「手动添加」。
8. **全中文** —— 普通用户可见层无英文残留（品牌/技术名除外）。
9. **无 JS 致命错误** —— 全程 pageerror 收集，0 个 ReferenceError/TypeError/Cannot read。

## 已知沙箱时序限制

本仓库沙箱中 GPU cache 初始化 + Electron 首帧延迟较高，`send → 等待 终态` 时序存在抖动；E2E 用例因此可能偶发需要重跑。对应逻辑已由以下单元/集成测试完整覆盖：

- `test/runmanager.test.js`（10 用例）—— 唯一终态、非法迁移忽略。
- `test/runstate.test.js`（5 用例）—— TERMINAL_STATES、isTerminal 闭合。
- `test/modelsource.test.js`（5 用例）—— 模型来源迁移 / 手动保留 / 收藏持久化 / External 四态映射。
- `test/workbuddy-emptyuia.test.js`（4 用例）—— 空 UIA 阈值、累积。
- `test/preflight.test.js`（6 用例）—— models 作用域 ReferenceError 回归（Case A/B/C/D）。

这些用例共同提供 v2.3.1 主路径逻辑的真实验证，**独立于 GUI E2E 时序**。

## 调试技巧

- Playwright 自动保存失败用例的 trace zip 到 `test-results/<test-name>/trace.zip`。
- `playwright.config.js` 设 `screenshot: 'only-on-failure'` 与 `trace: 'retain-on-failure'`。
- GUI E2E 启动前会清理上次的 `test-results/` 与 `dist-electron/win-unpacked/` 中的 userData 残留。