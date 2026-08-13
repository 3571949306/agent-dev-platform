# GUI Architecture（v2.9.9 Phase B Final）

> Renderer 是 **presentation + user intent** 层：不持有执行、授权、密钥、状态权威。
> 一切权威在 Electron main 进程：唯一执行真源、唯一权限真源（PermissionEngine）、
> 唯一模型路由真源（Model Router）、唯一终端真源、唯一密钥边界（DPAPI）。

## 进程与边界

```
┌──────────────────────────── Electron Main ────────────────────────────┐
│ main.js — 启动/窗口/生命周期；BOOT 阶段真话（Database→Runtime→Project→Interface）│
│ src/ipc/handlers.js — 全部 IPC 唯一注册点（232 通道，契约见 GUI_IPC_CONTRACT.md）│
│   ├─ store（SQLite better-sqlite3）—— 持久化唯一真源                     │
│   ├─ RunManager / MainAgentService —— Run 生命周期唯一真源                │
│   ├─ PermissionEngine —— 权限裁决唯一真源（过期请求 fail-closed）          │
│   ├─ Model Router —— 模型选择唯一真源（explicit fail-closed，无静默回退）  │
│   ├─ TerminalManager / ComputerManager —— 进程/桌面操作唯一真源           │
│   ├─ Workflow Runtime / Generator Service —— 各自唯一运行时               │
│   └─ Problem Center —— 全产品问题持久真源（去重；dismiss ≠ resolved）      │
├──────────────────────── preload.js — contextBridge（contextIsolation=true）│
└─────────────────────────────────────────────────────────────────────────┘
                ▲ window.api.invoke（请求-响应）/ onEvent（事件流）
┌──────────────────────────── Renderer（public/）────────────────────────┐
│ index.html — Boot Splash（B30）+ Workbench Shell（Activity Bar 布局）     │
│ js/app.js — boot 编排 / 全局错误边界（B37）/ 全局状态（B44）/ Onboarding（B29）│
│ js/workspace.js — Run Detail（Timeline/Actions/Model Routing B16）/ 布局   │
│ js/chat.js — Composer 3.0（草稿持久化 B27.4 / chips B27.1）/ 权限弹窗       │
│ js/pages.js — 管理页：Connections(B15)/Skills+Hooks(B17)/Workflow/         │
│               Generator/Diagnostics Health Center(B20)/Settings            │
│ js/panels.js — Terminal(B19)/Diff/Problems(B21)/Computer(B18)/Timeline     │
│ js/runViewModel.js — 事件去重（eventId LRU bounded）+ Run 视图聚合          │
│ js/util.js — esc()/统一破坏性确认（目标/后果/可逆性 B42）                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## 页面状态契约（B23）

所有页面/面板必须落在四种状态之一，且带机器可验标记：

| 状态 | 标记 | 说明 |
|---|---|---|
| LOADING | `data-page-state="loading"` | open() 入口统一渲染 |
| EMPTY | `data-page-state="empty"` | 空集合给引导文案，绝不空白 |
| ERROR | `data-page-state="error"` | error code + 解释 + 重试按钮 |
| READY | （内容本体） | 真实数据渲染完成 |

## 状态词汇真话（No Fake Status）

- 连接：`AVAILABLE / UNAVAILABLE / DEGRADED / UNKNOWN / ERROR` —— 只从真实测试结果推导，未测试就是 UNKNOWN。
- 验证：`PASS / FAIL / NOT_AVAILABLE / NOT_VERIFIED / RUNNING` —— completed ≠ PASS，只认机器证据。
- 模型来源：`REMOTE / MANUAL / FALLBACK / UNKNOWN` —— 回退模型绝不冒充 API 获取。
- 终端：`cancelled ≠ timeout`，两种终态永不互换。
- 诊断：未知就是 UNKNOWN；「没报错 → READY」被禁止。

## 密钥边界（B15.3 / B15.4 / B68）

- API Key：写入即 DPAPI（safeStorage）加密，Renderer 只见 `api_key_masked`。
- 自定义 Header：值写入即加密；`connections:list/get` 只回掩码 `••••••••` + header_names。
- 解密值只在 main 进程 `getDecrypted` 边界内存在，供 provider 发请求使用。
- Renderer 禁用 localStorage/sessionStorage；UI 持久化一律走 settings IPC（B48 白名单）。

## 性能与有界渲染（B35）

- Action cards ≤ 500 / Timeline ≤ 1000 / Terminal DOM ≤ 200KB / Problems 分页有界 / Runs 分页。
- 高频事件经 runViewModel eventId 去重（bounded LRU 5000 / TTL 10min），1 事件 → 1 渲染。
- 性能基线测量见 `docs/GUI_PERFORMANCE_BASELINE.md`（只记录机器结果）。

## 测试矩阵

见 `docs/GUI_TEST_MATRIX.md` 与 `docs/GUI_IPC_CONTRACT.md`（静态边界由 test/guiContract.test.js 机器验证）。
