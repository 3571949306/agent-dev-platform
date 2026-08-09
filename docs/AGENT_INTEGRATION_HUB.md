# Agent Integration Hub — 多智能体集成中枢（v2.6.0）

> **版本**：v2.6.0  
> **状态**：Hub 核心已交付（Registry / Router / Health / Lifecycle / RunBridge），GUI + IPC 接线中  
> **核心能力**：统一接入 Native / Codex / WorkBuddy / MCP / HTTP Agent，提供能力匹配、确定性路由、健康检查、生命周期管理、自动 Fallback 与 Main Agent 委派

---

## 1. 架构概览

```
Main Agent / 用户任务
        │
        ▼
┌───────────────────────────────────────────────────┐
│              AgentHub (agentHub.js)                │  ← 中央门面
│   register / detect / health / route /            │
│   start / startAuto / cancel / status / result    │
└──────┬──────────┬──────────┬──────────┬───────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
 AgentRegistry  AgentRouter  HealthMgr  LifecycleMgr
 (运行时状态)   (确定性评分) (超时+缓存) (状态机)
       │                      │          │
       │                      │          ▼
       │                      │     RunBridge
       │                      │     (↔ RunManager)
       │                      │
       ▼                      ▼
  Adapters (native/cli/desktop/http)   EventNormalizer
  ┌─────────┬─────────┬──────────┐     (归一化 21 种事件)
  │ Native  │ Codex   │ WorkBuddy │
  │ Adapter │ Adapter │ Adapter   │
  └─────────┴─────────┴──────────┘
```

Hub 不直接拥有状态——它委托给 Registry / Router / HealthManager / LifecycleManager / RunBridge，只编排流程。所有运行时状态在内存中（Registry 的 Map），配置数据由 SQLite `store` 管理，通过 manifest 注入。

---

## 2. AgentAdapter 接口

所有 Agent 接入必须实现 `BaseAgentAdapter`（`src/agents/adapters/baseAgentAdapter.js`）定义的方法集合。Hub 路由层只依赖这套接口，不感知传输细节。

| 方法 | 职责 | 返回 |
|------|------|------|
| `getManifest()` | 返回规范视图（id / capabilities / transport ...） | `object` |
| `detect()` | 判定本机是否可用 | `{ available, version, path }` |
| `healthCheck()` | 周期性探活 | `{ status, version, latencyMs, detail }` |
| `startTask(task, ctx)` | 发起一次 Run | `{ runId }` |
| `sendMessage(runId, msg)` | 向运行中 Run 追加消息 | — |
| `cancel(runId)` | 取消运行中 Run | — |
| `getStatus(runId)` | 查询生命周期状态（非阻塞） | `object` |
| `getResult(runId)` | 取终态结果 | `object` |
| `dispose()` | 释放底层资源 | — |

基类为纯接口：未覆盖的方法调用即抛 `NOT_IMPLEMENTED`。现有实现：`nativeAgentAdapter` / `codexAgentAdapter` / `workBuddyAgentAdapter` / `cliAgentAdapter` / `desktopAgentAdapter` / `httpAgentAdapter`。

---

## 3. Agent Manifest

manifest 是 Agent 的**静态描述**（`src/agents/manifests/builtinAgents.js`），Hub 启动时加载，再由 `detect()` / `healthCheck()` 回填运行时可用性。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 全局唯一 agent id |
| `displayName` | `string` | 展示名 |
| `source` | `'native' \| 'external'` | 平台内置 / 外部接入 |
| `transport` | `TRANSPORT.*` | 接入通道 |
| `capabilities` | `object` | 能力声明（键 → boolean） |
| `availability` | `boolean` | 静态可用性初值 |
| `version` | `string \| null` | 已知版本 |
| `path` | `string \| null` | 可执行路径 / 命令名 |
| `maxConcurrency` | `number` | 最大并发 Run 数 |

内置 manifest：`native-main`（主智能体）、`codex`（CLI 编码）、`workbuddy`（桌面 Computer Use）。

---

## 4. Capabilities（17 项）

规范化能力键定义在 `src/agents/hub/capabilityRegistry.js`。值为 `true` 表示支持；路由器据此匹配，而非硬编码 agent id。

| 键 | 说明 |
|------|------|
| `coding` | 代码生成 / 编辑 / 重构 |
| `planning` | 任务分解 / 执行计划 |
| `research` | 检索 / 调研 / 阅读 |
| `review` | 代码审查 / 评估 |
| `filesystem` | 文件读写 |
| `terminal` | 命令行执行 |
| `git` | git 操作 |
| `browser` | 浏览器自动化 |
| `computer` | Computer Use（键鼠 / 桌面操作） |
| `vision` | 视觉 / 截图理解 |
| `mcp` | MCP 工具接入 |
| `longRunning` | 支持长时运行任务 |
| `parallel` | 支持并行子任务 |
| `streaming` | 支持流式输出 |
| `resume` | 支持断点续跑 |
| `diff` | 产出结构化 diff |
| `sandbox` | 沙箱隔离执行 |

`CapabilityRegistry.match(agentCaps, required, preferred)` 返回 `{ matched, missing, preferredMatched }`。

---

## 5. AgentRegistry

AgentRegistry（`src/agents/hub/agentRegistry.js`）是运行时状态的唯一真相源。维护已注册 adapter 的 Map（非持久化）。

| 方法 | 说明 |
|------|------|
| `register(adapter)` | 注册 adapter（重复注册覆盖） |
| `unregister(id)` | 注销 adapter |
| `get(id)` | 按 id 获取 |
| `list()` | 列出所有已注册 adapter |
| `listAvailable()` | 已检测可用 + 未禁用 |
| `detectAll()` | 并行执行所有 adapter.detect() |
| `getByCapability(required, preferred)` | 按能力过滤（required 必须全部满足） |
| `getManifests()` | 所有 adapter 的 manifest |

---

## 6. AgentRouter

确定性评分路由器（`src/agents/hub/agentRouter.js`），无 LLM，可解释。每个候选返回 `score + reasons[] + penalties[]`。

### 评分因子

| 因子 | 分值 | 说明 |
|------|------|------|
| 必需能力匹配 | `+40` | 每个 required 匹配 |
| 缺失必需能力 | `-100` | 每个 required 缺失 |
| 偏好能力匹配 | `+10` | 每个 preferred 匹配 |
| healthy 可用 | `+20` | 健康状态 |
| degraded 可用 | `+5` | 降级但仍可用 |
| unavailable | `-200` | 不可用 |
| disabled | `-500` | 已禁用 |
| 健康加分 | `+10` | healthy 额外鼓励 |
| 负载达上限 | `-30` | activeRunCount ≥ maxConcurrency |
| 用户偏好 Agent | `+50` | preferences.preferredAgent |
| 手动指定 | `+1000` | task.agentId |
| 委托环路 | `-1000`（硬排除） | delegationPath 含此 agent |

### 可解释性

每个候选返回 `reasons[]`（加分项）和 `penalties[]`（扣分项），GUI 可直接展示"为什么选了这个 Agent"。

### 手动指定

`task.agentId` 覆盖路由——直接 `+1000`，保证排名第一。

### 硬排除规则

- `adapter.disabled === true` 或 `preferences.disabledAgents` 包含 → 不进入结果
- `agentId` 出现在 `delegationPath` → 不进入结果（防委托环路）

---

## 7. Lifecycle

LifecycleManager（`src/agents/hub/lifecycleManager.js`）——单次 Run 的状态机。

### 状态

| 状态 | 说明 | 终态？ |
|------|------|--------|
| `idle` | 初始 | 否 |
| `starting` | 启动中 | 否 |
| `running` | 运行中 | 否 |
| `waiting` | 等待（权限 / 子 Agent） | 否 |
| `completed` | 完成 | 是 |
| `failed` | 失败 | 是 |
| `cancelled` | 已取消 | 是 |
| `timeout` | 超时 | 是 |
| `unavailable` | 不可用 | 是 |

### 终态

`completed / failed / cancelled / timeout / unavailable`。终态一旦确定，后续状态变更被忽略（与 RunManager 的终态门一致）。

### 迁移规则

非终态之间必须符合 `TRANSITIONS` 表；非终态 → 终态始终合法。每次状态变更发射 `agent.run.status` 事件，终态发射专用事件（`run.completed` / `run.failed` / ...）。

---

## 8. Health

HealthManager（`src/agents/hub/healthManager.js`）——统一健康检查，有界超时 + 缓存。

### 状态

`unknown`（初始）→ `checking`（检查中）→ `healthy` / `degraded` / `unavailable` / `disabled`。

### 各 transport 检查方式

| Transport | 检查方式 |
|-----------|----------|
| `native` | 进程内自检（恒 healthy） |
| `cli` | 执行 `--version` 或探活命令 |
| `desktop` | 检测桌面应用进程 / 窗口 |
| `http` | GET 健康端点 |

### 超时

单个 Agent 健康检查默认 `5000ms`（`Promise.race`），不会因某个 Agent 卡住阻塞 `checkAll`。

### 缓存

结果缓存默认 `30s` TTL（`DEFAULT_CACHE_TTL_MS`）。`force=true` 跳过缓存。`checkAll` 并行检查，并发上限 `8`（`MAX_CONCURRENCY`）。检查完成后更新 `adapter.healthStatus`，供 Router 读取。

---

## 9. Events（21 种）

统一 Agent 事件类型定义在 `src/agents/hub/types.js` 的 `AGENT_EVENT`。EventNormalizer 把各 adapter 的原生事件归一化到这套命名，GUI 据此渲染 Timeline / Chat。

| 事件 | 说明 |
|------|------|
| `agent.detected` | Agent 检测完成 |
| `agent.health.changed` | 健康状态变更 |
| `agent.run.started` | Run 已启动 |
| `agent.run.status` | Run 状态变更 |
| `agent.plan.updated` | 计划更新 |
| `agent.message` | 消息 / 文本输出 |
| `agent.tool.started` | 工具调用开始 |
| `agent.tool.completed` | 工具调用完成 |
| `agent.tool.failed` | 工具调用失败 |
| `agent.file.read` | 文件读取 |
| `agent.file.changed` | 文件修改 |
| `agent.command.started` | 命令开始 |
| `agent.command.completed` | 命令完成 |
| `agent.test.failed` | 测试失败 |
| `agent.test.passed` | 测试通过 |
| `agent.permission.required` | 需要权限确认 |
| `agent.run.completed` | Run 完成（终态） |
| `agent.run.failed` | Run 失败（终态） |
| `agent.run.cancelled` | Run 已取消（终态） |
| `agent.run.timeout` | Run 超时（终态） |
| `agent.fallback` | Fallback 切换 |

事件归一化时自动移除 `rawMetadata` 中的敏感字段（token / key / auth / secret / password / bearer / session），防止凭据泄漏。

---

## 10. Fallback

`AgentHub.startAuto(task)` 自动路由 + Fallback：

### 链

1. `router.route(task)` 获取候选列表（按得分降序）
2. 依次尝试 top 候选
3. 失败则 fallback 到下一个，发射 `agent.fallback` 事件
4. 最多 **3 次** fallback（`MAX_FALLBACKS = 3`，不含首次尝试）
5. 全部失败 → `AGENT_ROUTE_EXHAUSTED`

### 事件

每次 fallback 发射 `agent.fallback`：`{ fromAgentId, toAgentId, error, attempt, timestamp }`。

### AGENT_ROUTE_EXHAUSTED

候选 Agent 全部失败时返回 `{ error, errorCode: 'AGENT_ROUTE_EXHAUSTED' }`。

---

## 11. Delegation

Main Agent 通过 Hub 把子任务委派给最合适的 Agent（非递归）。

### Main Agent → Hub

Main Agent 识别委派意图（如"让合适的智能体帮我 Review"）→ 调用 `hub.startAuto(task)` 或 `hub.delegate(task)`。

### parent / child Run

- 子 Run 通过 `parentRunId` 链接到父 Run，供时间线展示
- RunBridge 在 RunManager + LifecycleManager 中同时创建 Run，保持同步

### 委托路径

`task.delegationPath` 记录委派链（如 `['native-main']`）。Router 硬排除路径中已有的 Agent。

### 环路防护

`AGENT_DELEGATION_LOOP` 错误码——检测到委托环路时拒绝。External Agent 不递归（WorkBuddy Bridge 走 desktop 驱动，不回到本进程再派生）。

---

## 12. Security

### 权限继承

子 Run 继承父 Run 的权限范围（project / task）。`PermissionEngine` 基于 `projectId` 初始化，工具调用前 `check(name, args)`。

### 项目根目录

所有文件操作受 `pathguard` 约束——`guard(root, rel)` 拒绝绝对路径、规范化 `..`、检测同名前缀穿越。Agent 的 `projectRoot` 决定其文件操作边界。

### 凭据过滤

- `EventNormalizer.stripSecrets()` 移除事件 `rawMetadata` 中的敏感字段（token / key / auth / secret / password / bearer / session）
- API 密钥由 `secret.js` 加密存储（Electron 下 `safeStorage` / DPAPI）
- Agent manifest 不携带凭据；运行时由 `config` 注入解密后的配置

---

## 13. 添加新 Agent

### 步骤

1. **定义 manifest**：在 `src/agents/manifests/builtinAgents.js` 添加 manifest 对象（id / transport / capabilities / maxConcurrency）
2. **实现 adapter**：在 `src/agents/adapters/` 创建 `xxxAgentAdapter.js`，继承 `BaseAgentAdapter`，实现 `detect()` / `healthCheck()` / `startTask()` / `cancel()` / `getStatus()` / `getResult()` / `dispose()`
3. **注册**：Hub 初始化时调用 `hub.register(adapter)`
4. **验证**：GUI「智能体」页面 → Agent Integration Hub 区段应出现新 Agent 卡片

### 代码示例

```js
// src/agents/adapters/myAgentAdapter.js
'use strict';
const { BaseAgentAdapter } = require('./baseAgentAdapter');
const { TRANSPORT } = require('../hub/types');

class MyAgentAdapter extends BaseAgentAdapter {
  constructor({ manifest, config } = {}) {
    super({ manifest, config });
    this.id = manifest.id;
    this.adapterType = manifest.transport;
    this.transport = manifest.transport;
    this.capabilities = Object.keys(manifest.capabilities || {}).filter(k => manifest.capabilities[k]);
    this.maxConcurrency = manifest.maxConcurrency || 1;
    this.healthStatus = 'unknown';
    this.activeRunCount = 0;
  }

  getManifest() { return this.manifest; }

  async detect() {
    // 检测本机是否可用
    return { available: true, version: '1.0.0', path: this.config.binPath || null };
  }

  async healthCheck({ timeoutMs } = {}) {
    // 探活逻辑
    return { status: 'healthy', version: '1.0.0', latencyMs: 10, detail: 'ok' };
  }

  async startTask(task, ctx) {
    // 发起 Run，返回 { ok: true, runId } 或 { ok: false, error }
    this.activeRunCount++;
    try {
      // ... 实际启动逻辑 ...
      return { ok: true, runId: ctx.runId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async cancel(runId) { /* 取消逻辑 */ }
  async getStatus(runId) { /* 返回状态 */ }
  async getResult(runId) { /* 返回结果 */ }
  async dispose() { /* 释放资源 */ }
}

module.exports = { MyAgentAdapter };
```

```js
// 注册（Hub 初始化处）
const { MyAgentAdapter } = require('./agents/adapters/myAgentAdapter');
const { BUILTIN_AGENT_MANIFESTS } = require('./agents/manifests/builtinAgents');

const myManifest = {
  id: 'my-agent',
  displayName: 'My Agent',
  source: 'external',
  transport: TRANSPORT.HTTP,
  capabilities: { coding: true, filesystem: true, review: true },
  availability: false,
  version: null,
  path: null,
  maxConcurrency: 2
};

hub.register(new MyAgentAdapter({ manifest: myManifest, config: { endpoint: 'http://...' } }));
```

注册后，Router 自动将其纳入候选；GUI Agent Integration Hub 区段自动展示卡片、能力标签与健康状态。
