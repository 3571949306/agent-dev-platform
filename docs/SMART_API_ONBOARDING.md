# Smart API Onboarding — 智能 API 快速接入

> v2.4.0 新增。让用户从「拿到 API 信息」到「主智能体已经能使用这个 API」，尽可能只需要一次粘贴和几次确认。

## 概述

在 **API 连接** 页面点击 **⚡ 快速接入**，把 API 地址、密钥、配置或代码片段粘贴进去，平台会自动识别 URL / Key / Provider / 协议，安全预览后测试连接、自动发现模型，一键创建连接并可选分配给主智能体。

手动新建 / 编辑 / 测试 / 拉取模型等旧功能全部保留，快速接入只是新的推荐入口。

## 支持的输入格式

| 格式 | 示例 | Parser |
|------|------|--------|
| 普通文本 | `接口地址：https://api.example.com/v1` + `API Key：sk-xxx` | plainText |
| 纯 URL + Key | `https://api.example.com/v1` + `sk-xxx`（两行） | plainText |
| ENV | `OPENAI_API_KEY=sk-xxx` + `OPENAI_BASE_URL=https://...` | env |
| PowerShell ENV | `$env:OPENAI_API_KEY="sk-xxx"` | env |
| JSON | `{"apiKey":"sk-xxx","baseURL":"https://...","model":"xxx"}` | json |
| JavaScript / TypeScript | `new OpenAI({ apiKey:"sk-xxx", baseURL:"https://..." })` | codeSnippet |
| Python | `OpenAI(api_key="sk-xxx", base_url="https://...")` | codeSnippet |
| curl | `curl https://... -H "Authorization: Bearer sk-xxx"` | curl |
| TOML | `base_url = "https://..."` + `api_key = "sk-xxx"` | toml |
| CC Switch Deep Link | `ccswitch://v1/import?resource=provider&...` | ccSwitch |
| CC Switch Config JSON | `[{name, settingsConfig:{env:{...}}}, ...]` | ccSwitch（批量） |

所有 Parser 输出统一的 `ImportCandidate` 结构，在用户确认前不写数据库。

## 识别流程

```
用户粘贴
  ↓
本地 Parser 识别（规则 + 正则，不调用 LLM）
  ↓
ImportCandidate（只在内存）
  ↓
安全预览（Key 掩码显示）
  ↓
用户点击「开始检测」
  ↓
Protocol Probe（最多 4 个请求）
  ↓
模型自动发现
  ↓
用户确认协议 + 选择默认模型
  ↓
保存为 Connection（Key 经 safeStorage / DPAPI 加密落盘）
  ↓
可选：分配给主智能体
```

## 协议检测（Protocol Probe）

检测使用轻量 HTTP 请求（GET），不发真实大模型调用，避免成本。探测策略：

| 探测路径 | 200 | 401 | 405 | 404 |
|----------|-----|-----|-----|-----|
| `/models` 或 `/v1/models` | 模型发现可用 | Key 无效但端点存在 | — | 不支持模型发现 |
| `/chat/completions` | — | — | OpenAI Chat 端点存在 | 不存在 |
| `/responses` | — | — | OpenAI Responses 端点存在 | 不存在 |
| `/v1/messages` | — | — | Anthropic 端点存在 | 不存在 |
| `/api/tags` | Ollama 模型发现可用 | — | — | — |

- **MAX_PROBES = 4**：总请求数上限，不会暴力探测几十个路径。
- **超时 + 取消**：复用 v2.2 HTTP Abort 合约，用户点击「取消检测」立即停止网络请求（< 2s）。
- **多协议共存**：如果 Chat 和 Responses 都可用，UI 列出全部支持协议并标注推荐项，由用户选择，不偷偷覆盖。
- **推荐只是推荐**：用户可以手动切换协议。

### URL Normalizer

自动处理尾部斜杠和版本段，避免 `/v1/v1/models`：

| 输入 | 归一化输出 |
|------|-----------|
| `https://api.xxx.com` | `https://api.xxx.com` |
| `https://api.xxx.com/` | `https://api.xxx.com` |
| `https://api.xxx.com/v1` | `https://api.xxx.com/v1` |
| `https://api.xxx.com/v1/` | `https://api.xxx.com/v1` |

## 模型发现

- 检测成功后自动从 `/models` 获取模型列表，`source = remote`。
- 模型结构复用 v2.3.2：`{ id, source, favorite, addedAt }`。
- 如果 `/models` 不存在（404），不认为 API 不可用 —— 显示「手动输入模型」输入框，保存后 `source = manual`。
- 手动添加的模型与远端模型共存，可随时刷新。

## CC Switch Import

基于 CC Switch（commit `413c09e`，v3.19.2）实际源码研究实现。

### Deep Link

```
ccswitch://v1/import?resource=provider&app=codex&name=My%20API&endpoint=https://...&apiKey=sk-xxx&model=model-A
```

- 支持多 endpoint（逗号分隔）。
- 支持 `config` 参数（Base64 编码的 JSON/TOML 配置片段）。
- `app` 字段映射到协议：`claude` → anthropic，`codex` → openai-responses。

### Config 批量导入

粘贴 CC Switch Provider 配置 JSON 数组，可批量导入多个 Provider：

```json
[
  { "name": "Provider A", "settingsConfig": { "env": { "OPENAI_BASE_URL": "...", "OPENAI_API_KEY": "..." } } },
  { "name": "Provider B", "settingsConfig": { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "..." } } }
]
```

- 每个 Provider 都先 Normalize → Validate → Mask Secret。
- 批量导入页显示勾选列表，用户选择要导入的项。
- 只读：不写 CC Switch 数据库，不修改 CC Switch 配置，不切换 CC Switch 当前 Provider。
- 用户主动点击才读取，不在 App 启动时扫描。

## Secret 安全

- **GUI 始终掩码**：`sk-abcd••••••••wxyz`，禁止默认显示完整 Key。
- **不进日志**：console.log / audit / model_calls / event / trace / E2E screenshot / TEST_REPORT 均不记录完整 Key。Parser debug 使用 `sanitizeCandidate()` 输出掩码副本。
- **加密存储**：沿用 Electron `safeStorage`（Windows DPAPI），不新增 Secret 数据库。
- **不保存原始输入**：Import History 只记录 `import source` / `timestamp` / `result`，不保存含 Key 的原始剪贴板文本。
- **Deep Link 安全**：导出的 Deep Link 默认不携带 API Key；第三方 Deep Link 含 Key 时允许解析但只在内存，mask 显示，确认后写入 safeStorage。
- **Authorization 抽取**：`Authorization: Bearer ...` 和 `x-api-key` header 统一抽取为 `apiKey`，不重复存在。

## Provider Preset

内置 7 个 Preset，帮助快速配置（不是新的运行时协议）：

| Preset | 协议 | 默认 Base URL |
|--------|------|---------------|
| OpenAI | openai | `https://api.openai.com/v1` |
| Anthropic | anthropic | `https://api.anthropic.com` |
| OpenRouter | openai | `https://openrouter.ai/api/v1` |
| DeepSeek | openai | `https://api.deepseek.com/v1` |
| Ollama | ollama | `http://localhost:11434` |
| LM Studio | local | `http://localhost:1234/v1` |
| 自定义 | custom | — |

- Preset 和协议严格分离（§22）：DeepSeek 使用 OpenAI-compatible 协议，不为每个供应商新增 Provider 类。
- 不做 Remote Marketplace（§58），只做本地 preset。

## 重复检测

- 基于 `baseUrl` + `protocol` 判断重复（不用 Secret hash）。
- 检测到重复时提示：更新现有连接 / 另存为新连接 / 取消。

## 一键分配主智能体

- 最终确认页可勾选「分配给主智能体」。
- 如果主智能体已配置 API，显示当前连接 + 模型，用户选择「切换」或「只添加连接」。
- 禁止静默覆盖。

## IPC 接口

| Channel | 功能 |
|---------|------|
| `onboarding:presets` | 获取 Preset 列表 |
| `onboarding:parse` | 解析粘贴文本 → ImportCandidate / batch |
| `onboarding:probe` | 协议检测 + 模型发现 |
| `onboarding:import` | 将 ImportCandidate 保存为 Connection |
| `onboarding:ccswitch` | 解析 CC Switch Deep Link / Config |
| `onboarding:duplicate` | 重复检测 |

## 限制

- 系统级 `agentdev://` Deep Link 注册未在 v2.4.0 实现（如注册增加安装器风险则推迟到 v2.4.1）。当前支持粘贴 CC Switch Deep Link。
- 不使用 LLM 辅助识别（本地 deterministic parser）。AI-assisted parsing 预留给未来版本。
- 不做在线 Provider Marketplace / 广告 / 付费推荐。
