# GUI IPC Contract（v2.9.9 Phase B Final · B38）

> 本文件由 `scripts/gen-gui-ipc-contract.js` 从 `public/js/api.js` 真实代码生成。
> Renderer（public/js）是 presentation + user intent 层：不持有执行/授权/密钥权威。
> 一切权威在 main 进程：唯一执行真源、唯一权限真源（PermissionEngine）、
> 唯一模型路由真源（Model Router）、唯一终端真源、唯一密钥边界（DPAPI）。

共 193 条 Renderer 使用的 IPC 通道。

| 分类 | 语义 | 通道数 |
|---|---|---|
| READ | 对应 backend store / service | 124 |
| WRITE | 对应 backend store | 38 |
| RUN | Main Agent Runtime / Provider / Terminal Runtime | 13 |
| CANCEL | RunManager / TerminalManager / Workflow Runtime | 9 |
| APPROVE | PermissionEngine / Workflow Runtime | 3 |
| DANGEROUS | PermissionEngine / 危险命令规则 | 2 |
| SYSTEM | Electron main | 4 |

## READ

- authority owner：对应 backend store / service（只读投影，Renderer 无权威）
- side effects：无（只读投影）
- secret exposure：connections 只回掩码（api_key_masked / header 掩码）；解密值绝不跨 IPC

| channel | direction |
|---|---|
| `agents:get` | renderer → main（invoke/handle，请求-响应） |
| `agents:list` | renderer → main（invoke/handle，请求-响应） |
| `artifactUsage` | renderer → main（invoke/handle，请求-响应） |
| `audit:list` | renderer → main（invoke/handle，请求-响应） |
| `browser:status` | renderer → main（invoke/handle，请求-响应） |
| `checkpoints:list` | renderer → main（invoke/handle，请求-响应） |
| `computer:active` | renderer → main（invoke/handle，请求-响应） |
| `computer:availability` | renderer → main（invoke/handle，请求-响应） |
| `computer:history` | renderer → main（invoke/handle，请求-响应） |
| `connections:getDefaults` | renderer → main（invoke/handle，请求-响应） |
| `connections:list` | renderer → main（invoke/handle，请求-响应） |
| `connections:models` | renderer → main（invoke/handle，请求-响应） |
| `connections:test` | renderer → main（invoke/handle，请求-响应） |
| `conversations:get` | renderer → main（invoke/handle，请求-响应） |
| `conversations:list` | renderer → main（invoke/handle，请求-响应） |
| `dashboard:stats` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:describe` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:known` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:listActiveProbes` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:mismatches` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:modelCalls` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:product` | renderer → main（invoke/handle，请求-响应） |
| `dynamicAgent:def:delete` | renderer → main（invoke/handle，请求-响应） |
| `dynamicAgent:def:list` | renderer → main（invoke/handle，请求-响应） |
| `dynamicAgent:instance:list` | renderer → main（invoke/handle，请求-响应） |
| `events:list` | renderer → main（invoke/handle，请求-响应） |
| `extcfg:get` | renderer → main（invoke/handle，请求-响应） |
| `extcfg:getAll` | renderer → main（invoke/handle，请求-响应） |
| `externalAgents:list` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:discover` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:discoverAll` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:listSources` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:parse` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:parseFile` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:resolveConflicts` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:selectFile` | renderer → main（invoke/handle，请求-响应） |
| `fileChanges:list` | renderer → main（invoke/handle，请求-响应） |
| `files:listAll` | renderer → main（invoke/handle，请求-响应） |
| `files:openExternal` | renderer → main（invoke/handle，请求-响应） |
| `files:read` | renderer → main（invoke/handle，请求-响应） |
| `files:reveal` | renderer → main（invoke/handle，请求-响应） |
| `files:tree` | renderer → main（invoke/handle，请求-响应） |
| `generator:discard` | renderer → main（invoke/handle，请求-响应） |
| `generator:getDraft` | renderer → main（invoke/handle，请求-响应） |
| `generator:listDrafts` | renderer → main（invoke/handle，请求-响应） |
| `generator:save` | renderer → main（invoke/handle，请求-响应） |
| `generator:validate` | renderer → main（invoke/handle，请求-响应） |
| `git:changedFiles` | renderer → main（invoke/handle，请求-响应） |
| `git:diff` | renderer → main（invoke/handle，请求-响应） |
| `hook:audit:list` | renderer → main（invoke/handle，请求-响应） |
| `hook:delete` | renderer → main（invoke/handle，请求-响应） |
| `hook:disable` | renderer → main（invoke/handle，请求-响应） |
| `hook:enable` | renderer → main（invoke/handle，请求-响应） |
| `hook:get` | renderer → main（invoke/handle，请求-响应） |
| `hook:handlers:list` | renderer → main（invoke/handle，请求-响应） |
| `hook:list` | renderer → main（invoke/handle，请求-响应） |
| `hub:available` | renderer → main（invoke/handle，请求-响应） |
| `hub:detect` | renderer → main（invoke/handle，请求-响应） |
| `hub:health` | renderer → main（invoke/handle，请求-响应） |
| `hub:manifests` | renderer → main（invoke/handle，请求-响应） |
| `hub:result` | renderer → main（invoke/handle，请求-响应） |
| `hub:route` | renderer → main（invoke/handle，请求-响应） |
| `hub:sessions` | renderer → main（invoke/handle，请求-响应） |
| `hub:start` | renderer → main（invoke/handle，请求-响应） |
| `hub:startAuto` | renderer → main（invoke/handle，请求-响应） |
| `hub:status` | renderer → main（invoke/handle，请求-响应） |
| `hub:verification` | renderer → main（invoke/handle，请求-响应） |
| `lock:getHolder` | renderer → main（invoke/handle，请求-响应） |
| `lock:isBusy` | renderer → main（invoke/handle，请求-响应） |
| `lock:listBusy` | renderer → main（invoke/handle，请求-响应） |
| `mcp:connect` | renderer → main（invoke/handle，请求-响应） |
| `mcp:disconnect` | renderer → main（invoke/handle，请求-响应） |
| `mcp:list` | renderer → main（invoke/handle，请求-响应） |
| `memories:list` | renderer → main（invoke/handle，请求-响应） |
| `messages:list` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:ccswitch` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:duplicate` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:parse` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:presets` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:status` | renderer → main（invoke/handle，请求-响应） |
| `orchestrator:cancelChild` | renderer → main（invoke/handle，请求-响应） |
| `orchestrator:children` | renderer → main（invoke/handle，请求-响应） |
| `orchestrator:result` | renderer → main（invoke/handle，请求-响应） |
| `orchestrator:status` | renderer → main（invoke/handle，请求-响应） |
| `permissions:list` | renderer → main（invoke/handle，请求-响应） |
| `problems:countActive` | renderer → main（invoke/handle，请求-响应） |
| `problems:list` | renderer → main（invoke/handle，请求-响应） |
| `problems:report` | renderer → main（invoke/handle，请求-响应） |
| `problems:resolve` | renderer → main（invoke/handle，请求-响应） |
| `project:gitStatus` | renderer → main（invoke/handle，请求-响应） |
| `projects:current` | renderer → main（invoke/handle，请求-响应） |
| `projects:list` | renderer → main（invoke/handle，请求-响应） |
| `projects:open` | renderer → main（invoke/handle，请求-响应） |
| `prompts:list` | renderer → main（invoke/handle，请求-响应） |
| `recovery:newTaskDraft` | renderer → main（invoke/handle，请求-响应） |
| `recovery:summary` | renderer → main（invoke/handle，请求-响应） |
| `runs:children` | renderer → main（invoke/handle，请求-响应） |
| `runs:events` | renderer → main（invoke/handle，请求-响应） |
| `runs:get` | renderer → main（invoke/handle，请求-响应） |
| `runs:list` | renderer → main（invoke/handle，请求-响应） |
| `runs:modelRouting` | renderer → main（invoke/handle，请求-响应） |
| `settings:get` | renderer → main（invoke/handle，请求-响应） |
| `skill:delete` | renderer → main（invoke/handle，请求-响应） |
| `skill:disable` | renderer → main（invoke/handle，请求-响应） |
| `skill:enable` | renderer → main（invoke/handle，请求-响应） |
| `skill:get` | renderer → main（invoke/handle，请求-响应） |
| `skill:list` | renderer → main（invoke/handle，请求-响应） |
| `skill:resolve` | renderer → main（invoke/handle，请求-响应） |
| `skills:list` | renderer → main（invoke/handle，请求-响应） |
| `tasks:list` | renderer → main（invoke/handle，请求-响应） |
| `tasks:steps` | renderer → main（invoke/handle，请求-响应） |
| `terminal:active` | renderer → main（invoke/handle，请求-响应） |
| `terminal:history` | renderer → main（invoke/handle，请求-响应） |
| `terminal:output` | renderer → main（invoke/handle，请求-响应） |
| `tools:list` | renderer → main（invoke/handle，请求-响应） |
| `usage:list` | renderer → main（invoke/handle，请求-响应） |
| `usage:summary` | renderer → main（invoke/handle，请求-响应） |
| `workflow:delete` | renderer → main（invoke/handle，请求-响应） |
| `workflow:disable` | renderer → main（invoke/handle，请求-响应） |
| `workflow:enable` | renderer → main（invoke/handle，请求-响应） |
| `workflow:get` | renderer → main（invoke/handle，请求-响应） |
| `workflow:getRun` | renderer → main（invoke/handle，请求-响应） |
| `workflow:list` | renderer → main（invoke/handle，请求-响应） |
| `workflow:listRuns` | renderer → main（invoke/handle，请求-响应） |

## WRITE

- authority owner：对应 backend store（main 进程独占写；Renderer 只提交意图）
- side effects：持久化写入本地 SQLite（better-sqlite3）
- secret exposure：API Key / Header 值写入即 DPAPI 加密；回包只含掩码投影

| channel | direction |
|---|---|
| `agents:create` | renderer → main（invoke/handle，请求-响应） |
| `agents:remove` | renderer → main（invoke/handle，请求-响应） |
| `agents:update` | renderer → main（invoke/handle，请求-响应） |
| `connections:create` | renderer → main（invoke/handle，请求-响应） |
| `connections:remove` | renderer → main（invoke/handle，请求-响应） |
| `connections:setDefault` | renderer → main（invoke/handle，请求-响应） |
| `connections:update` | renderer → main（invoke/handle，请求-响应） |
| `conversations:create` | renderer → main（invoke/handle，请求-响应） |
| `conversations:remove` | renderer → main（invoke/handle，请求-响应） |
| `dynamicAgent:def:create` | renderer → main（invoke/handle，请求-响应） |
| `dynamicAgent:def:update` | renderer → main（invoke/handle，请求-响应） |
| `extcfg:set` | renderer → main（invoke/handle，请求-响应） |
| `externalAgents:create` | renderer → main（invoke/handle，请求-响应） |
| `externalAgents:remove` | renderer → main（invoke/handle，请求-响应） |
| `externalAgents:update` | renderer → main（invoke/handle，请求-响应） |
| `externalImport:importBatch` | renderer → main（invoke/handle，请求-响应） |
| `files:create` | renderer → main（invoke/handle，请求-响应） |
| `files:createDir` | renderer → main（invoke/handle，请求-响应） |
| `files:deleteRequest` | renderer → main（invoke/handle，请求-响应） |
| `files:rename` | renderer → main（invoke/handle，请求-响应） |
| `hook:create` | renderer → main（invoke/handle，请求-响应） |
| `hook:update` | renderer → main（invoke/handle，请求-响应） |
| `mcp:create` | renderer → main（invoke/handle，请求-响应） |
| `mcp:remove` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:complete` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:import` | renderer → main（invoke/handle，请求-响应） |
| `problems:dismiss` | renderer → main（invoke/handle，请求-响应） |
| `projects:create` | renderer → main（invoke/handle，请求-响应） |
| `projects:remove` | renderer → main（invoke/handle，请求-响应） |
| `prompts:create` | renderer → main（invoke/handle，请求-响应） |
| `prompts:remove` | renderer → main（invoke/handle，请求-响应） |
| `prompts:update` | renderer → main（invoke/handle，请求-响应） |
| `recovery:dismiss` | renderer → main（invoke/handle，请求-响应） |
| `settings:set` | renderer → main（invoke/handle，请求-响应） |
| `skill:create` | renderer → main（invoke/handle，请求-响应） |
| `skill:update` | renderer → main（invoke/handle，请求-响应） |
| `workflow:create` | renderer → main（invoke/handle，请求-响应） |
| `workflow:update` | renderer → main（invoke/handle，请求-响应） |

## RUN

- authority owner：Main Agent Runtime / Provider / Terminal Runtime（唯一执行真源）
- side effects：可能发起模型调用 / 子进程 / 文件读写（按权限裁决）
- secret exposure：provider 调用在 main 进程解密使用密钥；Renderer 永远拿不到明文

| channel | direction |
|---|---|
| `agent:send` | renderer → main（invoke/handle，请求-响应） |
| `computer:focus` | renderer → main（invoke/handle，请求-响应） |
| `computer:screenshot` | renderer → main（invoke/handle，请求-响应） |
| `computer:windows` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:capabilities` | renderer → main（invoke/handle，请求-响应） |
| `diagnostics:selfTest` | renderer → main（invoke/handle，请求-响应） |
| `generator:generate` | renderer → main（invoke/handle，请求-响应） |
| `mainAgent:run` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:probe` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:probe:get` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:probe:start` | renderer → main（invoke/handle，请求-响应） |
| `terminal:riskCheck` | renderer → main（invoke/handle，请求-响应） |
| `workflow:run` | renderer → main（invoke/handle，请求-响应） |

## CANCEL

- authority owner：RunManager / TerminalManager / Workflow Runtime（终止真源）
- side effects：终止活动 Run / 进程树（taskkill /t /f 或 kill(-pid)）
- secret exposure：无密钥暴露

| channel | direction |
|---|---|
| `agent:stop` | renderer → main（invoke/handle，请求-响应） |
| `computer:stop` | renderer → main（invoke/handle，请求-响应） |
| `generator:cancel` | renderer → main（invoke/handle，请求-响应） |
| `hub:cancel` | renderer → main（invoke/handle，请求-响应） |
| `mainAgent:stop` | renderer → main（invoke/handle，请求-响应） |
| `onboarding:probe:cancel` | renderer → main（invoke/handle，请求-响应） |
| `orchestrator:cancel` | renderer → main（invoke/handle，请求-响应） |
| `terminal:cancel` | renderer → main（invoke/handle，请求-响应） |
| `workflow:cancel` | renderer → main（invoke/handle，请求-响应） |

## APPROVE

- authority owner：PermissionEngine / Workflow Runtime（裁决真源；过期请求不可批准）
- side effects：推进或阻断等待中的权限/审批决策
- secret exposure：无密钥暴露

| channel | direction |
|---|---|
| `agent:permission-response` | renderer → main（invoke/handle，请求-响应） |
| `workflow:approve` | renderer → main（invoke/handle，请求-响应） |
| `workflow:reject` | renderer → main（invoke/handle，请求-响应） |

## DANGEROUS

- authority owner：PermissionEngine / 危险命令规则（fail-closed；Renderer 绝不绕过）
- side effects：破坏性操作（删除文件 / 高风险命令），需显式确认
- secret exposure：无密钥暴露

| channel | direction |
|---|---|
| `files:delete` | renderer → main（invoke/handle，请求-响应） |
| `terminal:run` | renderer → main（invoke/handle，请求-响应） |

## SYSTEM

- authority owner：Electron main（对话框/外壳；不含业务权威）
- side effects：打开对话框 / 外部链接
- secret exposure：无密钥暴露

| channel | direction |
|---|---|
| `dialog:pickFolder` | renderer → main（invoke/handle，请求-响应） |
| `shell:openExternal` | renderer → main（invoke/handle，请求-响应） |
| `shell:showItem` | renderer → main（invoke/handle，请求-响应） |
| `system:info` | renderer → main（invoke/handle，请求-响应） |

## 静态边界（机器验证）

`test/guiContract.test.js` 每次测试运行都会扫描 `public/js/*.js`：

- 禁止 `require('fs')` / `require('child_process')` / `better-sqlite3` / 直接 DB；
- 禁止引入 `PermissionEngine` 或任何第二套权限/执行权威；
- 禁止 `eval` / `new Function`；
- 禁止把 API Key / Authorization / Cookie / 解密后的自定义 Header 存入 localStorage 或渲染到 DOM；
- Renderer 使用的每个通道必须在 main 端真实注册（无孤儿通道）。

违反任一条 → GUI_BOUNDARY=FAIL，发布门禁阻断。
