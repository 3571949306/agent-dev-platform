# Agent Dev Platform — Overview

## 项目概述

本地桌面客户端版 Agent 开发平台，打包为 Windows 安装程序 (.exe)。

## 技术栈

- **桌面框架**: Electron 31 (Chromium + Node.js)
- **后端**: Express 4 (内嵌在 Electron 主进程中)
- **前端**: 原生 HTML/CSS/JS（暗色主题 SPA）
- **存储**: JSON 文件，存放在用户数据目录 `%APPDATA%\Agent Dev Platform\data.json`
- **打包**: electron-builder (NSIS 安装程序)
- **LLM**: OpenAI 兼容 API（流式 SSE + Function Calling）

## 核心能力（5 大实体）

1. **Prompt 管理** — 提示词库、版本管理、标签分类、测试状态追踪
2. **Agent 配置 & 测试** — 多 Agent 配置、实时流式对话测试、工具调用循环
3. **工具编排** — JSON Schema 参数定义、Mock/Webhook 执行模式
4. **对话记录 & 评测** — 对话历史、1-5 星评分、Token 统计、工具调用可视化
5. **API 连接管理** — 统一管理的 LLM 服务地址/密钥；可测试连通性、自动拉取模型列表；Agent 通过 `api_connection_id` 引用连接

## 文件结构

```
├── main.js             # Electron 主进程（启动服务器 + 创建窗口）
├── server.js           # Express 服务器 + API 路由
├── store.js            # JSON 文件存储层
├── llm.js              # OpenAI 兼容 LLM 客户端
├── package.json        # 项目配置 + electron-builder 构建配置
├── public/
│   ├── index.html      # SPA 入口
│   ├── style.css       # 暗色主题样式
│   └── app.js          # 前端逻辑
├── dist-electron/
│   ├── Agent Dev Platform Setup 1.0.0.exe   # Windows 安装包 (76MB)
│   └── win-unpacked/                          # 免安装版
│       └── Agent Dev Platform.exe
```

## 使用方式

### 方式一：安装版（推荐）
双击 `dist-electron\Agent Dev Platform Setup 1.0.0.exe` 运行安装程序。
安装后从开始菜单或桌面快捷方式启动。

### 方式二：免安装版
直接运行 `dist-electron\win-unpacked\Agent Dev Platform.exe`

### 开发模式
```bash
npm run electron     # 启动 Electron 开发模式
npm run dist         # 重新打包构建
```

## 数据存储位置

安装后的数据文件位于：
```
C:\Users\{用户名}\AppData\Roaming\Agent Dev Platform\data.json
```

数据在卸载和重装后都会保留。可通过应用内的「导出备份」/「导入恢复」功能迁移数据。

## 构建说明

```bash
cd C:\Users\Administrator\WorkBuddy\2026-08-08-15-47-21
npm run dist
# 产物: dist-electron\Agent Dev Platform Setup 1.0.0.exe
```

## 技术要点

- 所有 JS 文件使用 CommonJS 格式（非 ESM），避免 Electron 内置 Node v20 的 ESM/CJS 互操作问题
- Express 服务器运行在 Electron 主进程内，无需额外进程
- 端口 3456 被占用时自动递增到 3457、3458...
- 数据文件使用 `app.getPath('userData')` 存储，首次运行自动从项目目录迁移
- 单实例锁：防止同时运行多个实例

## Phase 4 新增能力（解决 4 个用户问题）

1. **独立对话窗口**：对话页提供「独立窗口」(弹出原生子窗口) 与「全屏」(隐藏侧边栏) 两种模式；`main.js` 的 `setWindowOpenHandler` 已允许 localhost 弹窗并赋予独立窗口尺寸/标题。
2. **主 Agent 调度子 Agent**：Agent 新增 `is_main` 与 `sub_agent_ids` 字段。主 Agent 对话时，其子 Agent 作为可调用工具（Agent-as-Tool）暴露给 LLM；`callSubAgent()` 负责执行子 Agent 并回传结果。预制「主调度 Agent」已绑定「通用助手」「代码审查员」两个子 Agent。
3. **API 统一管理**：新增 `api_connections` 实体（CRUD + 测试 + 拉取模型）；Agent 不再内嵌 base_url/api_key，改为引用 `api_connection_id`，用户可自由决定哪个连接供哪个 Agent 使用。
4. **连接测试与模型列表**：参照 GitHub `CCswitch` 开源实现——
   - `llm.testConnection(conn)`：发送最小化请求（`max_tokens:1`，消息 "hi"）到 `/chat/completions`，按 HTTP 状态码判断（2xx=有效、401/403=密钥无效、404=地址错误、5xx=服务端错误、网络错误=无法连接）；本地服务商(Ollama/LM Studio)免密钥。
   - `llm.fetchModels(conn)`：`GET {base_url}/models`，解析 `data[].id` 为模型列表。

### 相关 API 路由
- `GET/POST /api/connections`、`GET/PUT/DELETE /api/connections/:id`
- `POST /api/connections/:id/test` — 连接测试
- `POST /api/connections/:id/models` — 拉取模型列表
- `POST /api/chat` — 支持主 Agent→子 Agent 编排（SSE 事件新增 `subagent_start` / `subagent_result`）

### 数据模型变更（向后兼容）
- `agents` 表：移除内嵌 `base_url`/`api_key`，新增 `api_connection_id` / `is_main` / `sub_agent_ids`；`store.js` 加载旧数据时自动回填默认值。
- `api_connections` 表：全新实体，含 `name/provider/base_url/api_key/models/tested/tested_at`。
