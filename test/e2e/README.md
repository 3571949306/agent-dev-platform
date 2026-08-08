# GUI E2E 测试（test/e2e）

v2.3.0 主路径的端到端界面测试，**共 12 个用例**，覆盖：全中文、模型中心、模型选择器、
模型缓存同步、Agent Preflight、Run 状态机收尾、Codex 配置兼容、External 状态卡。

## 运行环境

- **Windows 桌面 + 显示器**（或带显示的服务会话）。
- 渲染层与 Electron 桌面版共用同一套 `public/` 前端，故以本地 HTTP 服务作为 E2E 入口，
  不需要真正的 Electron GUI 进程。

## 步骤

```bash
# 终端 1：启动 HTTP 服务
npm start
#   → Agent Dev Platform ready on http://127.0.0.1:3733

# 终端 2：运行 E2E
npm run e2e
#   → Playwright 报告在 test/e2e/report/
```

如需指向别的基础地址：

```bash
E2E_BASE=http://127.0.0.1:3733 npm run e2e
```

## 说明

- 这些用例**不计入 `npm test` 通过率**（`scripts/run-tests.js` 只收集 `test/*.test.js`，
  不含 `test/e2e/`）。无头 CI / 纯服务器环境不应运行它们，避免误报失败。
- 用例 9 / 10 依赖测试环境已为主 Agent 预置可用模型与合法 API 连接；真实环境请在「设置 /
  API 连接」中先配置。
- 选择器的文本（如「发送」「保存」「查看模型」）与 v2.3.0 全中文 UI 对齐；若后续文案调整，
  同步更新本目录 spec。
