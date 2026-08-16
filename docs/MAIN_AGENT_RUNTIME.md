# Main Agent Runtime — 自主编码闭环（v2.6.0）

> **版本**：v2.6.0  
> **状态**：已交付，617 单元测试 + 30 GUI E2E 全部通过  
> **核心能力**：主智能体独立完成编码任务——理解需求 → 读项目 → 分析代码 → 制定计划 → 修改文件 → 运行命令 → 测试 → 错误检测 → 修复 → 输出结果

---

## 1. 架构概览

```
用户目标 (goal)
    │
    ▼
┌──────────────────────────────────────────────────┐
│            mainAgentRuntime.js                   │  ← 编排器
│  创建 Run → 构建 ctx → 运行 Loop → 终态收口       │
└────────────────┬─────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────┐
│              agentLoop.js                        │  ← 核心状态机
│  IDLE → PLANNING → EXECUTING → TESTING →         │
│  EVALUATING → REPAIRING → COMPLETED/FAILED       │
└────┬──────────┬──────────┬──────────┬────────────┘
     │          │          │          │
     ▼          ▼          ▼          ▼
 contextBuilder  actionExecutor  completionPolicy  blackboard
 (构建上下文)    (执行动作)      (完成策略)        (共享黑板)
     │          │
     ▼          ▼
  taskPlanner  actionSchema
  (任务规划)   (结构化校验)
```

### 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| 编排器 | `src/agent/runtime/mainAgentRuntime.js` | 创建 Run、构建 ctx、超时管理、终态收口、Run 持久化 |
| 核心循环 | `src/agent/runtime/agentLoop.js` | 状态机驱动的主循环：模型决策 → 执行 → 评估 → 修复 |
| 状态机 | `src/agent/runtime/states.js` | 状态定义与迁移规则（IDLE→PLANNING→EXECUTING→…） |
| 上下文构建 | `src/agent/runtime/contextBuilder.js` | 系统提示 + 项目摘要 + blackboard + plan → 模型上下文 |
| 任务规划 | `src/agent/runtime/taskPlanner.js` | 从目标生成任务列表，支持动态调整 |
| 共享黑板 | `src/agent/runtime/blackboard.js` | 事实/问题/任务进度跟踪，完成策略评估依据 |
| 动作执行 | `src/agent/runtime/actionExecutor.js` | 结构化 Action → 工具调用映射（read_file/patch/run_tests…） |
| 动作校验 | `src/agent/runtime/actionSchema.js` | JSON Schema 校验 + 容错解析 |
| 完成策略 | `src/agent/runtime/completionPolicy.js` | 验证条件评估（测试通过 + 必需文件已改 + 无未解问题） |
| 重试策略 | `src/agent/runtime/retryPolicy.js` | 迭代上限 + 修复轮次上限 + 运行超时 |
| 结果评估 | `src/agent/runtime/resultEvaluator.js` | 工具结果 → 问题描述提取 |
| 检查点 | `src/agent/runtime/checkpoint.js` | 文件修改前快照 + diff 跟踪 |
| 事件定义 | `src/agent/runtime/runtimeEvents.js` | 17 种 mainAgent:* 事件类型 + safeEmit |
| Fake 模型 | `src/agent/runtime/fakeCodingModel.js` | 确定性测试模型（4 种脚本构建器） |
| Provider 适配 | `src/agent/runtime/providerModelAdapter.js` | 生产环境模型适配（OpenAI/Anthropic/Ollama） |

---

## 2. 状态机

```
IDLE
  │
  ├─→ PLANNING ──→ READING_CONTEXT
  │                     │
  │                     ▼
  │               EXECUTING ←──────────┐
  │                     │              │
  │                     ▼              │
  │               WAITING_TOOL         │
  │                     │              │
  │                     ▼              │
  │                  TESTING ──────────┤（测试失败 → REPAIRING）
  │                     │              │
  │                     ▼              │
  │                EVALUATING          │
  │                     │              │
  │              ┌──────┴──────┐       │
  │              ▼             ▼       │
  │         REPAIRING      COMPLETED   │
  │              │                     │
  │              └─────────────────────┘
  │
  ├─→ WAITING_PERMISSION
  │
  ├─→ FAILED
  ├─→ CANCELLED
  └─→ TIMEOUT
```

### 终态规则

- **COMPLETED**：完成策略满足（测试通过 + 必需文件已改 + 无未解问题）
- **FAILED**：达到迭代上限 / 模型响应无效 / 路径逃逸 / 权限拒绝
- **CANCELLED**：用户停止（abortSignal）
- **TIMEOUT**：运行超时（maxRuntimeMs）

一个 Run 只能进入一次终态（RunManager terminal gate 保证）。

---

## 3. 结构化 Action

模型必须返回结构化 JSON Action（而非自然语言），由 `actionSchema.js` 校验：

```json
{
  "thought": "先读取 math.js 了解当前实现",
  "action": {
    "type": "read_file",
    "args": { "path": "src/math.js" }
  }
}
```

### 支持的 Action 类型

| 类型 | 映射工具 | 说明 |
|------|----------|------|
| `read_file` | `read_file` | 读取单个文件 |
| `read_files` | `read_file`（循环） | 批量读取 |
| `list_directory` | `list_directory` | 列目录 |
| `search` / `find_text` | `search` | 搜索文件/代码 |
| `read_file_range` | `read_file_range` | 按行号范围读取 |
| `write_file` | `write_file` | 整文件写入 |
| `patch_file` | `apply_patch` | 统一 diff 修改（模糊匹配） |
| `create_file` | `create_file` | 创建新文件 |
| `delete_file` | `delete_file` | 删除文件 |
| `run_command` | `terminal_run` | 运行命令 |
| `run_tests` | `terminal_run` | 运行测试（影响 Test→Repair Loop） |
| `git_status` | `git_status` | 查看 Git 状态 |
| `git_diff` | `git_diff` | 查看 Git 改动 |
| `complete` | （loop 处理） | 完成任务 |
| `ask_permission` | （loop 处理） | 请求权限 |
| `delegate` | （loop 处理） | 委派子智能体 |

### 模糊 Patch 匹配

LLM 生成的行号可能不准确。`patch.js` 实现了三段式匹配：
1. **严格匹配**：按声明的 `oldStart` 行号尝试
2. **模糊搜索**：从文件开头扫描，找第一处上下文完整匹配的位置
3. **精确错误**：全部失败时按声明位置生成精确错误信息

---

## 4. Test→Repair Loop

```
执行动作 → 测试 → 评估
    │              │
    │    ┌─────────┤
    │    │         │
    │    ▼         ▼
    │  通过      失败
    │    │         │
    │    ▼         ▼
    │  解决问题  REPAIRING（修复轮次 +1）
    │    │         │
    │    │         ▼
    │    │    下一轮模型决策（带错误上下文）
    │    │         │
    │    └─────────┘
    │
    ▼
  完成策略评估
```

- 测试通过时，`blackboard.resolveProblemsMatching` 模糊清除相关失败问题
- 修复轮次上限由 `retryPolicy.maxRepairRounds` 控制（默认 5）
- 必需验证（`verification[].required=true`）失败时不得 COMPLETED

---

## 5. IPC 通道

| 通道 | 说明 |
|------|------|
| `mainAgent:run` | 启动 Run（立即返回 runId，后台执行） |
| `mainAgent:stop` | 停止 Run（abort + RunManager cancel） |
| `mainAgent:changedFiles` | 返回本次 Run 修改的文件列表 |
| `mainAgent:fileDiff` | 返回某文件 before/after/diff |
| `mainAgent:listRuns` | 列出 Run 历史 |
| `mainAgent:testSetModel` | 测试钩子：注入 FakeCodingModel（仅 NODE_ENV=test/CI） |
| `mainAgent:states` | 返回状态机定义 |

### 调用示例

```javascript
// 启动 Main Agent Run
const { runId, conversationId } = await window.api.invoke('mainAgent:run', {
  conversationId: 'conv-xxx',
  agentId: 'agent-xxx',
  goal: '修复 add 函数并确保测试通过',
  verification: [{ type: 'command', command: 'npm test', required: true }],
  requiredFiles: ['src/math.js'],
  timeoutMs: 600000
});

// 停止
await window.api.invoke('mainAgent:stop', { conversationId: 'conv-xxx' });
```

---

## 6. GUI 事件（mainAgent:* 命名空间）

| 事件 | 负载 | GUI 渲染 |
|------|------|----------|
| `mainAgent:runStarted` | `{ runId, conversationId, goal }` | 启动 Spinner + 清空时间线 |
| `mainAgent:stateChanged` | `{ runId, state, previousState }` | 更新状态栏 |
| `mainAgent:planCreated` | `{ runId, plan: { goal, tasks } }` | 计划卡片 |
| `mainAgent:taskUpdated` | `{ runId, taskId, status, title }` | 更新计划卡片任务状态 |
| `mainAgent:action` | `{ runId, action, thought }` | 动作卡片（含思考） |
| `mainAgent:toolResult` | `{ runId, tool, ok, summary }` | 填充动作卡片结果 |
| `mainAgent:testResult` | `{ runId, command, passed, summary, errors }` | 测试结果卡片 |
| `mainAgent:repairStart` | `{ runId, round, reason }` | 修复横幅 |
| `mainAgent:fileChanged` | `{ runId, path, diff }` | Diff 面板 |
| `mainAgent:timeline` | `{ runId, entry: {kind, icon, text, detail, t} }` | 时间线面板 |
| `mainAgent:assistantText` | `{ runId, text }` | 智能体气泡 |
| `mainAgent:runCompleted` | `{ runId, summary, changedFiles, tests }` | 完成气泡 |
| `mainAgent:runFailed` | `{ runId, error, errorCode }` | 错误卡片 |
| `mainAgent:runCancelled` | `{ runId }` | 停止提示 |
| `mainAgent:runTimeout` | `{ runId }` | 超时提示 |

终态事件（runCompleted/Failed/Cancelled/Timeout）同时由 RunManager 的 `run_*` 标准事件统一处理，保证 Spinner 收尾。

---

## 7. 安全机制

- **项目沙箱**：所有文件操作经 `pathguard.js` 规范化 realpath 检查，防止符号链接/junction 逃逸
- **终端环境隔离**：子进程剥离 `NODE_TEST_CONTEXT`，防止嵌套测试运行器干扰退出码
- **权限引擎**：`PermissionEngine` 对高风险操作（terminal.dangerous / filesystem.delete）要求确认
- **API Key 安全**：不记录、不序列化、safeStorage 加密存储

---

## 8. 测试覆盖

### 单元测试（617 通过）

| 测试文件 | 用例数 | 覆盖 |
|----------|--------|------|
| `mainAgentLoop.test.js` | 11 | 完整闭环：成功/修复/取消/超时/无效响应/路径逃逸/checkpoint/requiredFiles |
| `mainAgentRuntime.test.js` | — | RunManager 集成、终态门、超时 |
| `actionExecutor.test.js` | — | Action→Tool 映射、patch 修复、测试结果 |
| `actionSchema.test.js` | — | JSON 校验、容错解析 |
| `completionPolicy.test.js` | — | 完成策略评估 |
| `contextBuilder.test.js` | — | 上下文构建 |
| `runtimeStates.test.js` | — | 状态迁移规则 |
| `taskPlanner.test.js` | — | 任务规划 |

### GUI E2E（30 通过，含 4 个 Main Agent 专属用例）

| Case | 场景 | 断言 |
|------|------|------|
| 27 | 编码成功 | completed + action 卡片 + 时间线条目 + 文件修复 |
| 28 | 修复循环 | completed + repairStart 事件 + 修复横幅 |
| 29 | 停止 | cancelled + 停止按钮可见→点击→终态 |
| 30 | 必需验证失败 | 不得 completed + repair 触发 + 文件未正确修复 |

### 测试模型

`FakeCodingModel` 提供确定性测试，不调用真实 API：

- `buildFixAddScript()` — 标准：读取→测试失败→修复→测试通过→完成
- `buildRepairLoopScript()` — 修复循环：第一次 patch 错→第二次 patch 对
- `buildPrematureCompleteScript()` — 提前完成：改了但没改对→verification 失败
- `buildHangScript()` — 长命令：平台原生阻塞命令（ping/sleep）

---

## 9. 项目沙箱 fixture

`test/fixtures/coding-agent/` 是一个故意有 bug 的小项目：

```
coding-agent/
├── package.json    # "test": "node --test test/math.test.js"
├── src/math.js     # add(a,b) { return a - b; }  ← 故意错误
└── test/math.test.js  # assert add(2,3) === 5
```

`reset.js` 提供 `copyFixture()`（复制到临时目录）、`resetToBroken()`（恢复 bug 基线）、`cleanup()`（清理）。

## 模型交互协议（v2.9.9 体验对标）

- **原生 Tool Calling**：支持 tools 的 provider（anthropic / openai-chat / openai-responses）会收到 16 个 action 的 tool 定义，`tool_use`/`tool_calls` 优先解析为结构化 Action；不支持的 provider（Ollama/自定义兼容）自动回退纯文本 JSON 路径。
- **并行只读**：一轮可并发执行多个只读 Action（read/search/list/git_status/git_diff），写类仍单轮单个。
- **ripgrep**：search_text/search_files/search_symbols 优先用 `rg`（argv 数组传参、防注入），无 `rg` 无缝回退 JS walker。
- **Token 预算**：`buildContext` 按近似 token（ASCII/4 + 非ASCII/1.5）在 `maxContextTokens`（默认 24000，可经 `agent.max_context_tokens` 覆盖）内按优先级裁剪。
- **max_tokens**：Main Agent 默认 `8192`（大 patch 不易截断），可经 `agent.max_tokens` 覆盖；不同 provider/模型上限不同时的越界报错复用现有错误处理路径。
- **多轮历史 + Prompt Caching**：tools 路径维护真实 `assistant(tool_use) → user(tool_result)` 多轮历史（tool_use/tool_result 严格配对，压缩不破坏配对）；Anthropic system 块加 `cache_control: ephemeral` 降本提速。纯文本路径保持单条 context 拼接（两条路径并存，`supportsTools` 区分）。
