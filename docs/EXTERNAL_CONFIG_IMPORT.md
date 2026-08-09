# External Config Import — 外部 API 配置一键迁移（v2.5.0）

> 把其他 Agent / AI 开发工具中已经配好的 API 安全地一键迁移到 Agent Dev Platform。

## 支持的来源

| 来源 | 说明 | 自动发现 | 手动选文件 |
| --- | --- | :---: | :---: |
| **Codex** | `~/.codex/config.toml`（model_providers / wire_api / env_key） | ✓ | ✓ |
| **Claude Code** | `~/.claude/.env` / `credentials.json` / `ANTHROPIC_*` 环境变量 | ✓ | ✓ |
| **OpenCode** | `opencode.json`（支持多 Provider 批量） | ✓ | ✓ |
| **CC Switch** | CC Switch 本地配置（只读复制 SQLite，不锁冲突） | ✓ | — |
| **环境变量** | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` 等白名单 | ✓ | — |
| **.env 文件** | 用户主动选择 `.env` 文件 | — | ✓ |
| **JSON 文件** | 用户主动选择 `.json` 文件 | — | ✓ |
| **TOML 文件** | 用户主动选择 `.toml` 文件 | — | ✓ |

## 导入流程

```
API 连接 → 从其他工具导入 → 选择来源
  ↓
自动发现（或手动选文件）
  ↓
解析为 ImportCandidate
  ↓
预览（密钥掩码）
  ↓
冲突检测（NEW / DUPLICATE / CONFLICT / MISSING_SECRET / INVALID）
  ↓
用户选择 + 手动补 key
  ↓
批量导入（并发 2~3，每个独立处理）
  ↓
结果展示
  ↓
可选：分配给主智能体
```

## 安全边界

### 只迁移

- 用户自己配置的第三方 API Key（`sk-*` 格式）
- 公开配置文件中的 base_url / model / protocol 信息

### 不迁移

- 浏览器 Cookie
- GitHub Token
- 系统登录凭据
- OAuth Refresh Token
- ChatGPT Plus / Codex membership token
- Claude Pro / Max session
- WorkBuddy membership
- 任何非公开协议的 session token

### 检测到会员/会话凭据时

```
检测到 Codex 账号认证 / Claude 登录态
  ↓
标记 Unsupported Secret
  ↓
不导入，显示警告
```

## 冲突处理

| 状态 | 含义 | 默认操作 |
| --- | --- | --- |
| **NEW** | 无现有连接冲突 | 导入 |
| **DUPLICATE** | 同 baseUrl + 同协议 | 跳过（可选更新/另存） |
| **CONFLICT** | 同名但 baseUrl 或协议不同 | 跳过（可选覆盖/另存） |
| **MISSING_SECRET** | 有 baseUrl 但缺 API Key | 手动补 Key 后导入 |
| **INVALID** | 候选不可导入 | 跳过 |

### 密钥比较

比较时只显示掩码形式，不显示完整 Key：

```
现有：sk-abcd••••••••wxyz
导入：sk-efgh••••••••5678
```

## Codex Importer

识别 `config.toml` 中的 `[model_providers.*]`：

```toml
model = "gpt-xxx"
model_provider = "my-provider"

[model_providers.my-provider]
name = "My API"
base_url = "https://api.example.com/v1"
wire_api = "responses"    # → openai-responses
env_key = "MY_API_KEY"    # → 导入时读取环境变量
```

- `wire_api = responses` → `openai-responses`
- `wire_api = chat` → `openai`
- `requires_openai_auth = true` → 跳过（账号登录，不可迁移）
- `auth.json` 含 OAuth tokens → 警告，不导入

## Claude Code Importer

识别 `ANTHROPIC_*` 环境变量和配置文件：

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_AUTH_TOKEN=sk-ant-...
ANTHROPIC_BASE_URL=https://...
```

- 第三方网关不强制 `provider = Anthropic Official`，交给 Probe 验证
- `credentials.json` 含 `claude_session` / `oauthToken` → 拒绝，不迁移登录态

## OpenCode Importer

识别 `opencode.json`（支持批量）：

```json
[
  { "provider": "openai", "model": "xxx", "baseURL": "...", "apiKey": "sk-..." },
  { "provider": "anthropic", "model": "xxx", "baseURL": "...", "apiKey": "${ENV_VAR}" }
]
```

- 一个 Provider → 一个 ImportCandidate
- `${ENV_VAR}` 引用只在导入时读取，不存在则 MISSING_SECRET

## Batch Import

- 支持勾选多个候选批量导入
- 每个 Candidate 独立处理，一个失败不影响其他
- 最大并发 3，避免同时请求 20 个 API

## 技术实现

### 架构

```
外部配置文件
  ↓
External Config Importer（每个工具独立）
  ↓
ImportCandidate（统一结构）
  ↓
Normalize（wireApi → protocolHint 等）
  ↓
Conflict Resolver（5 种状态）
  ↓
importCandidate → Connection（现有 onboarding 链路）
  ↓
现有 Provider Runtime
```

### 文件结构

```
src/providers/onboarding/external/
├── index.js                  # 模块入口
├── registry.js               # Importer 注册
├── conflictResolver.js       # 冲突检测
├── importNormalizer.js       # 归一化
├── externalSource.js         # ExternalSource 结构
├── importers/
│   ├── codex.js              # Codex CLI
│   ├── claudeCode.js         # Claude Code
│   ├── openCode.js           # OpenCode
│   ├── ccSwitchLocal.js      # CC Switch 本地
│   ├── environment.js        # 环境变量
│   ├── envFile.js            # .env 文件
│   ├── jsonFile.js           # JSON 文件
│   └── tomlFile.js           # TOML 文件
└── security/
    ├── pathPolicy.js         # 路径安全策略
    └── secretSanitizer.js    # 凭据过滤
```

### 安全措施

- **路径策略**：只读取已知配置目录 + 用户手动选择的文件
- **凭据过滤**：OAuth / Session / Membership token 自动检测并拒绝
- **密钥掩码**：GUI 预览始终 mask，不显示完整 Key
- **safeStorage**：导入后 Key 用 Electron safeStorage (DPAPI) 加密存储
- **不持久化原文**：只保存 normalized fields，不保存原始配置文件内容
- **日志安全**：audit 日志只记录 `source=codex provider=xxx result=imported`，不含 Key
- **只读**：所有 Importer READ ONLY，不修改外部配置

### IPC 通道

| 通道 | 说明 |
| --- | --- |
| `externalImport:listSources` | 列出可用导入源 |
| `externalImport:discover` | 检查单个来源是否安装 |
| `externalImport:parse` | 解析为 candidates（opts: `{ filePath?, env? }`） |
| `externalImport:resolveConflicts` | 批量冲突检测 |
| `externalImport:importBatch` | 批量导入 |
| `externalImport:selectFile` | 用户选择文件（dialog.showOpenDialog） |
| `externalImport:parseFile` | 根据扩展名自动选择 importer |

### import_source 元数据

Connection 新增 `import_source` 和 `import_source_path` 字段，用于显示和审计：

| 来源 | import_source |
| --- | --- |
| 手动新建 | `manual` |
| 快速接入 | `smart-paste` |
| Codex | `codex` |
| Claude Code | `claude-code` |
| OpenCode | `opencode` |
| CC Switch | `ccswitch` |
| 环境变量 | `environment` |
| .env 文件 | `env-file` |
| JSON 文件 | `json-file` |
| TOML 文件 | `toml-file` |

> `import_source` 只用于显示/审计/诊断，Runtime 不依赖它做特殊逻辑。
