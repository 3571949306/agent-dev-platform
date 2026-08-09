# Smart API Onboarding — 智能 API 快速接入

> v2.4.0 新增，v2.4.1 可靠性闭环。让用户从「拿到 API 信息」到「主智能体已经能使用这个 API」，尽可能只需要一次粘贴和几次确认。

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
ProbeManager.startProbe（立即返回 probeId，后台执行）
  ↓
Protocol Probe（最多 6 个请求，分阶段调度）
  ↓
模型自动发现 + 协议能力独立检测
  ↓
用户确认协议 + 选择默认模型
  ↓
保存为 Connection（Key 经 safeStorage / DPAPI 加密落盘）
  ↓
可选：分配给主智能体
```

## 协议检测（Protocol Probe）

> v2.4.1 重构：Model Discovery 与 Protocol Capability 严格分离，Probe Scheduler 按优先级调度，真正 Cancel 机制。

### Model Discovery 与 Protocol Capability 分离（v2.4.1）

v2.4.0 的一个关键缺陷：`/models` 200 就认为 OpenAI Chat supported，这会产生假阳性。v2.4.1 严格分离：

| 检测类别 | 探测路径 | 200 | 401/403 | 405/400 | 404 |
|----------|----------|-----|---------|---------|-----|
| **Model Discovery** | `/models` 或 `/v1/models` | 模型列表可用 | Key 无效但端点存在 | — | 模型发现不可用 |
| **Model Discovery (Ollama)** | `/api/tags` | 模型列表可用 + Ollama 协议 supported | — | — | — |
| **Protocol: OpenAI Chat** | `/chat/completions` | supported | supported（端点存在） | supported | unsupported |
| **Protocol: OpenAI Responses** | `/responses` | supported | supported | supported | unsupported |
| **Protocol: Anthropic** | `/v1/messages` | supported | supported | supported | unsupported |
| **Protocol: Ollama** | `/api/tags` | supported + 模型发现 | — | — | unsupported |

**关键规则**：
- `/models` 200 **只说明** API 可达 + 模型列表能力 + 可能是 OpenAI-compatible family，**不说明** `/chat/completions` 一定存在。
- 每个协议独立探测 endpoint：405/400/401/403 → endpoint exists = supported；404 → unsupported。
- 401/403 只说明端点存在但认证失败。

### Probe Scheduler（v2.4.1）

v2.4.0 固定 `MAX_PROBES=4`，对完全未知 API 可能漏掉关键协议（如 Responses）。v2.4.1 重构为分阶段调度：

```
Stage A: Model Discovery（/models 或 /api/tags）
  ↓
Stage B: Protocol Capability（按优先级排序探测）
  ↓
可提前结束（如 Ollama + localhost → 跳过其他协议）
```

**优先级规则**（`prioritizeProtocols()`）：
- URL Hint：`localhost:11434` → Ollama 高优先级；`api.anthropic.com` → Anthropic 高优先级；`api.openai.com` → Responses + Chat 高优先级。
- Port Hint：`11434` → Ollama；`1234` → OpenAI-compatible / LM Studio。
- Parser/Preset Hint：`anthropic` → Anthropic；`ollama` → Ollama；`openai-responses` → Responses。

**Hint 只影响优先级，不禁止其他候选**：即使用户选了 OpenAI preset，仍会探测 Anthropic / Ollama，只是优先级较低。

**预算**：`MAX_TOTAL_PROBES = 6`，不会暴力探测几十个路径，但也不因固定 4 请求而漏掉关键协议。

### 真正 Probe Cancel（v2.4.1）

v2.4.0 的 Cancel 是假的：Renderer 只回到预览页，Main Process 的 `fetch()` 仍然继续。v2.4.1 实现**真正的 abort**：

```
Renderer: 点击「取消检测」
  ↓
调用 onboarding:probe:cancel(probeId)
  ↓
Main: ProbeManager.cancelProbe(probeId)
  ↓
AbortController.abort()
  ↓
fetch 真正立即结束（< 2s）
  ↓
Probe state = cancelled
  ↓
ProbeManager cleanup
```

**关键设计**：
- **不把 AbortSignal 跨 IPC 传输**（不可靠），使用 `probeId` 作为取消句柄。
- `onboarding:probe:start` 立即返回 `probeId`，`probe()` 在后台执行。
- Probe 结果通过 `onboarding:probe:event` 推送。
- **Late Result Guard**：cancel 后迟到的 result 不覆盖 `cancelled` 状态。
- **Renderer 绑定 `currentProbeId`**：所有事件必须 `event.probeId === currentProbeId` 才处理。
- **Cancel ≠ Timeout**：`cancelProbe` → `cancelled`；`timeoutMs` 到期 → `timeout`。
- **Cancel 后 UI**：回到预览页，不显示「检测失败」或 `AbortError`。

### Probe ID 生命周期

```
probe:start
  ↓
生成唯一 probeId + new AbortController()
  ↓
保存到 ProbeManager Map（state = running）
  ↓
后台执行 probe(candidate, { signal })
  ↓
completed / failed / cancelled / timeout
  ↓
从 Map 清理（延迟 5s 供迟到事件读取）
```

**状态**：`running` → `completed` / `cancelled` / `timeout` / `failed`

**Probe Error Codes**：
- `PROBE_CANCELLED` — 用户取消
- `PROBE_TIMEOUT` — 超时
- `PROBE_NETWORK_ERROR` — 网络错误
- `PROBE_AUTH_FAILED` — 认证失败
- `PROBE_NO_PROTOCOL` — 没有可用协议

### Probe Report 结构（v2.4.1）

```js
{
  probeId,
  baseUrl,
  reachable: true,
  latencyMs: 29,
  modelDiscovery: {
    status: "supported",   // supported | auth_failed | unsupported | unknown
    path: "/models",
    models: ["gpt-4o", "gpt-4o-mini"]
  },
  protocols: [
    { protocol: "openai",           status: "unsupported", endpoint: "/chat/completions" },
    { protocol: "openai-responses", status: "supported",   endpoint: "/responses" },
    { protocol: "anthropic",        status: "unsupported", endpoint: "/v1/messages" },
    { protocol: "ollama",           status: "unsupported", endpoint: "/api/tags" }
  ],
  recommendedProtocol: "openai-responses",
  state: "completed",     // completed | cancelled | timeout | failed
  errorCode: null,        // PROBE_CANCELLED | PROBE_TIMEOUT | ...
  aborted: false,
  probeCount: 4,
  protocolsAttempted: ["openai", "openai-responses", "anthropic", "ollama"],
  // 向后兼容
  candidates: [...],
  models: [...]
}
```

GUI 通过 `modelDiscovery` / `protocols` / `recommendedProtocol` 渲染，不依赖 `candidates[0]` 位置假设。

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
| `onboarding:probe:start` | **v2.4.1** 立即返回 probeId，后台执行 Probe，结果通过 `onboarding:probe:event` 推送 |
| `onboarding:probe:cancel` | **v2.4.1** 通过 probeId 取消 Probe，真实 abort fetch |
| `onboarding:probe:get` | **v2.4.1** 获取 Probe 安全 diagnostics（不含 apiKey） |
| `onboarding:probe` | （向后兼容）同步等待 Probe 完成 |
| `onboarding:import` | 将 ImportCandidate 保存为 Connection |
| `onboarding:ccswitch` | 解析 CC Switch Deep Link / Config |
| `onboarding:duplicate` | 重复检测 |
| `diagnostics:listActiveProbes` | **v2.4.1** 列出活跃 Probe（供 E2E / Diagnostics 读取） |

## 限制

- 系统级 `agentdev://` Deep Link 注册未在 v2.4.0 实现（如注册增加安装器风险则推迟到 v2.4.1）。当前支持粘贴 CC Switch Deep Link。
- 不使用 LLM 辅助识别（本地 deterministic parser）。AI-assisted parsing 预留给未来版本。
- 不做在线 Provider Marketplace / 广告 / 付费推荐。
