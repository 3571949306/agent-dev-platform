# Test Report — Agent Dev Platform v2.8.1

## v2.8.1 — Runtime Truthfulness & Permission Hardening（2026-08-10）

> **基线：** `v2.8.0 / 60e3fc4`（Universal External Agent Runtime）。
> **本文件不含任何编造结果**，所有断言均来源于真实执行。

### 本轮单元 / 集成测试

```text
# tests 1402
# pass 1401
# fail 0
# cancelled 0
# skipped 1
# duration_ms 86192
```

**结论：1402 / 1401 PASS，0 失败，1 跳过**（`npm test`，2026-08-10 真实执行）。

- 相对 v2.8.0（1345）增量：**+57**。其中 +8 来自新验证模块
  （`test/agentVerification.test.js`，§40/§44/§45/§82 单一真相源）、+5 来自 §37
  Cline scope 统一 Permission Broker、其余为 permission/risk/audit/verification
  相关测试的既有增量。
- 完整 E2E：**65 / 65 PASS**（2.3m，GUI 权限弹窗与 Agent Center 改动无回归）。

### E2E（spec §51/§100 口径）

```text
65 passed (2.3m)
```

本轮 GUI 改动（权限弹窗 / Agent Center 三维度分离）经完整 E2E 回归：65 / 65 PASS。
（`npm run e2e` 真实输出，2026-08-10。）

### 依赖审计（spec §100：三项分开报告）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Root production | `npm audit --omit=dev` | **0** |
| Root dev/build | `npm audit` | **13**（12 high + 1 critical，全部 build-only，除 `electron` 需逐条评估） |
| Bundled Cline sidecar production | `cd sidecars/cline-runtime && npm audit --omit=dev` | **19**（1 high + 15 moderate + 3 low） |

**`Remaining Advisories` 不是 0**（spec §54：Root prod=0 但 Sidecar prod=19）。
明细与逐项 mitigation 见 `docs/SECURITY_DEPENDENCY_AUDIT.md`。

### CI（spec §67/§68）

本轮改动尚未提交/推送，GitHub Actions 无对应 run 可核对。

```text
CI TRIGGERED — NO（改动未推送）
INDEPENDENT VERIFICATION UNAVAILABLE
```

不写 "CI PASS"。提交推送后需在 Actions 页面核对 `ci.yml` + `windows-test.yml`
的真实 conclusion（success / failure），方可补记。

### 本轮 Release Blocker 自查（spec §101）

| Blocker | 状态 |
| --- | --- |
| 危险 Permission 无 GUI 自动 allow | ✅ 消除 —— 外部 Agent HIGH/CRITICAL 走 GUI 弹窗（§27-§30） |
| parent readOnly 被绕过 | ✅ 消除 —— Cline scope 下发纳入统一 Permission Broker（§37） |
| Codex/Claude/Cline 不同危险权限规则 | ✅ 消除 —— 统一 classifier + broker（§35-§37） |
| Verification Level 靠自由文本 | ✅ 消除 —— `agentVerification.js` 单一真相源（§39/§40/§44/§45/§82） |
| Codex 未安装却标 Real Protocol Verified | ✅ 不成立 —— 本机未装 codex，最高只到 FIXTURE |
| Claude 只 --version 却标 Real Agent Task Verified | ✅ 不成立 —— 无真实任务证据不升级 |
| TEST_REPORT 仍是 v2.7.3 | ✅ 已修复（本文件头部为 v2.8.1） |
| v2.8.0 baseline 数字写错 | ✅ 见下方 v2.8.0 节（复算一致） |
| Root audit 0 就声称所有 production 0 | ✅ 已纠正 —— sidecar prod = 19 |
| Sidecar audit 未执行 | ✅ 已执行 |
| Unit FAIL / E2E FAIL | ✅ 全绿 |

---

## v2.8.0 — Universal External Agent Runtime（历史，spec §98/§99）

**基线：** `v2.7.3 / 8450f0a`。
**官方记录（CHANGELOG v2.8.0，2026-08-10）：**

```text
unit 1345 tests（1344 PASS / 0 FAIL / 1 SKIP）
E2E 65 PASS / 0 FAIL
```

**2026-08-10 复算（git worktree + Junction 共享 node_modules，`npm test`）：**

```text
# tests 1345
# pass 1344
# fail 0
# skipped 1
```

复算与官方记录**完全一致**（1345/1344/0/1）。

### Release-to-release delta

| 指标 | v2.7.3 | v2.8.0 | Delta |
| --- | ---: | ---: | ---: |
| Unit / integration | 943（官方记录，见下方复算说明） | 1345 | **+402** |
| E2E | 53 | 65 | **+12** |

> 说明（spec §49/§50）：release-to-release 的单元测试增量为 **+402**，不是 +46。
> +46 是 v2.8.0 最后开发阶段（1299 → 1345）的批次增量，本仓库 CHANGELOG 未记录
> 1299 这个中间数字，git 历史中也没有对应门禁记录，因此本报告只呈现可复算的
> 发布级增量 +402，不虚构中间批次数字。

---

## v2.7.3 — ClineCore Sidecar Runtime（历史，spec §99）

> **Documentation correction in v2.8.1：** v2.7.3 官方报告记录 unit 总数为
> **943 / 942 pass / 0 fail / 1 skip**。2026-08-10 以 git worktree + Junction
> 对精确基线 `8450f0a` 复算 `npm test`，得到 **942 / 941 pass / 0 fail / 1 skip**，
> 少 1 个。复算环境为同一 node_modules（v2.7.3→v2.8.0 依赖零变更），未找到该
> 差异的确定性来源（测试文件无动态注册、无 subtest）。因此保留官方 943 作为
> v2.7.3 的 release 数字，同时如实记录复算偏差，不把任何一侧改写为"当时完全正确"。

本节记录从精确基线 `v2.7.2 / cf573aba9479f8bb01f65018e27a7d15b3224357`
升级到 v2.7.3 后的最终本地门禁。Cline 集成使用固定的 `@cline/sdk 0.0.72`、
`ClineCore` 与内置 Node `22.23.2`，测试不调用付费模型。

| Gate | Previous | New | Final result |
| --- | ---: | ---: | --- |
| Unit / integration tests | 922（919 pass / 2 fail / 1 skip） | +21 | 943 total / 942 pass / 0 fail / 1 skip |
| Electron E2E | 43 | +10（Cases 44–53） | 53 pass / 0 fail / 0 skip |
| Source smoke | — | — | `SMOKE_OK` |
| Cline integration smoke | — | — | Real SDK + ClineCore + local model fixture + coding tools PASS |
| Windows build | — | — | `npm run dist` ExitCode 0 |
| win-unpacked smoke | — | — | `--smoke` ExitCode 0 |
| win-unpacked integration | — | — | `--integration-smoke` ExitCode 0; sidecar processes 0 → 0 |

基线的两个失败来自依赖环境状态的 service tests；v2.7.3 将其改为确定性 fixture，
没有删除或跳过旧测试。最终 `npm test` 实际耗时 67.2 秒，`npm run e2e` 实际耗时
约 1.5 分钟。

### Integration evidence

```text
CLINE_INTEGRATION_SMOKE_OK node=22.23.2 sdk=0.0.72 networkCall=false
CLINE_CODING_FIXTURE_OK turns=3 changed=src/math.js test=passed
PACKAGED_SMOKE_EXIT=0
PACKAGED_INTEGRATION_SMOKE_EXIT=0
CLINE_SIDECAR_PROCESS_COUNT_AFTER=0
```

该 fixture 从固定 Node 22 启动真实 sidecar，导入真实 `@cline/sdk`，构造真实
`ClineCore`，使用本地 OpenAI-compatible SSE fixture 驱动真实工作区工具修复
`src/math.js` 并运行测试。结论分级如下：

- ClineCore Runtime: **VERIFIED**
- Model Execution Fixture: **VERIFIED**
- Real paid/provider LLM task: **NOT VERIFIED**

### Build size

为避免猜测，v2.7.2 大小来自在 `.cache` 隔离 worktree 中对精确基线提交重新打包；
该目录和所有生成产物均不提交。

| Artifact | v2.7.2 | v2.7.3 | Delta |
| --- | ---: | ---: | ---: |
| NSIS setup | 84,969,786 B | 142,404,294 B | +57,434,508 B |
| Portable | 84,762,073 B | 142,196,587 B | +57,434,514 B |

官方 Node ZIP 为 35,683,585 B（解压后 `node.exe` 86,997,320 B）；Cline sidecar
及生产依赖解压后为 164,898,682 B。按安装包压缩增量粗略拆分，Node 贡献约
35.7 MB，SDK/sidecar/依赖及少量 manifest/source 贡献约 21.8 MB。

### Dependency and license audit

- Root production audit: 0 vulnerabilities (`npm audit --omit=dev`).
- Root full audit: 13 development/build findings（12 high, 1 critical），来自既有
  Electron/electron-builder/electron-rebuild/tar 工具链；它们不在 production dependency
  audit 中，但仍需在后续 Electron/toolchain 升级中处理。
- Sidecar production audit: 16 transitive findings（15 moderate, 1 high）。高危项是
  SDK provider dependency tree 中的 `undici 5.29.0`；其余主要来自 OpenTelemetry。
  `npm audit fix --package-lock-only --dry-run` 无可应用的非破坏性变更；强行跨 major
  override 会偏离已验证的 Cline SDK 依赖闭包，因此本版如实保留并列为跟踪项。

> **v2.8.1 更正：** 上述 sidecar 数字为 16（15 moderate / 1 high）。2026-08-10
> 重新审计（lockfile 未变更）为 **19**（1 high / 15 moderate / 3 low）——新增 3 项
> low 来自 `dify-ai-provider` → `@cline/llms` → `@cline/agents` 传递链上新披露的
> advisory。详见 `docs/SECURITY_DEPENDENCY_AUDIT.md`。

- Sidecar lockfile license metadata: Apache-2.0 104、MIT 186、BSD/ISC/0BSD 等 27；
  三个 `@cline/*` 子包缺少 npm license metadata，但上游 Cline 仓库及 SDK 为
  Apache-2.0。`@jerome-benoit/sap-ai-provider` 的 package metadata 名称不准确，随包
  `LICENSE` 实际为 Apache-2.0。所有依赖自带 license/notice 文件随完整生产依赖树保留。

---

## v2.6.0 — Main Agent 自主编码闭环（历史）

> **基线**：`v2.6.0`（基于 `v2.5.1 / commit 08fc7a5`）。
> **本轮目标**：Main Agent 自主编码闭环 —— 实现状态机驱动的 Main Agent Runtime，让主智能体独立完成编码任务（理解需求 → 读项目 → 分析代码 → 制定计划 → 修改文件 → 运行命令 → 测试 → 错误检测 → 修复 → 输出结果），不依赖外部智能体（Codex/WorkBuddy）。
> **本文件不含任何编造结果**，所有断言均来源于真实执行。

---

### 1. 版本

| 字段 | 值 |
| --- | --- |
| package.json version | `2.6.0` |
| 上一基线 | `v2.5.1 / 08fc7a5` |
| 本轮重点 | Main Agent Runtime 状态机 / 结构化 Action Schema / Test→Repair Loop / 模糊 Patch 匹配 / 终端环境隔离 / Run Timeline GUI / 4 个 Main Agent E2E |

---

### 2. npm test（单元 + 集成）

```bash
cd agent-dev-platform
npm test
```

最新一次完整运行摘要：

```
# tests 617
# suites 0
# pass 617
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19258
```

**结论：617 / 617 PASS，0 失败，0 跳过。**

> v2.5.1 基线为 516 tests。v2.6.0 新增 101 tests = 617。

### 2.1 测试覆盖（v2.6.0 新增部分）

| 文件 | 用例数 | 范围 |
| --- | ---: | --- |
| `test/mainAgentLoop.test.js` | 11 | **核心闭环**：成功路径 / Repair Loop / Required Verification Fail / cancel / maxIterations / invalid action / tool failure / 路径逃逸 / blackboard 更新 / RunManager terminal gate / checkpoint / requiredFiles |
| `test/mainAgentRuntime.test.js` | — | RunManager 集成、终态门、超时映射 |
| `test/actionExecutor.test.js` | — | Action→Tool 映射、patch 修复、测试结果提取 |
| `test/actionSchema.test.js` | — | JSON Schema 校验、容错解析、未知类型拒绝 |
| `test/completionPolicy.test.js` | — | 完成策略评估（测试通过 + 必需文件 + 无未解问题） |
| `test/contextBuilder.test.js` | — | 系统提示 + 项目摘要 + blackboard → 上下文 |
| `test/runtimeStates.test.js` | — | 状态迁移规则、非法迁移拒绝 |
| `test/taskPlanner.test.js` | — | 从目标生成任务列表 |

### 2.2 关键 Bug 修复

| Bug | 根因 | 修复 |
| --- | --- | --- |
| 终端命令退出码 0 但测试失败 | `NODE_TEST_CONTEXT` 环境变量导致嵌套测试运行器进入通信模式 | `terminal.js` 子进程剥离 `NODE_TEST_CONTEXT` / `NODE_TEST_TMPDIR` |
| Patch 应用失败 | LLM 生成的行号不准确，严格匹配失败 | `patch.js` 三段式匹配：严格 → 模糊搜索全文件 → 精确错误 |
| 测试通过后未清除失败问题 | `resolveProblem(blackboard, '')` 空字符串不匹配 | `blackboard.js` 新增 `resolveProblemsMatching` 模糊匹配 |
| RunManager 终态被覆盖 | 大写 'COMPLETED' 被当作未知终态拒绝 | `agentLoop.js` 统一使用小写终态名 |
| 内存中文件变更丢失 | 无 store 时 `listChangedFiles` 返回空 | `checkpoint.js` 新增 `ctx._changedFiles` 内存追踪 |
| cancel 测试不工作 | `node -e "setTimeout"` 在 cmd.exe 下引号被吃掉 | `fakeCodingModel.js` 改用平台原生阻塞命令（ping/sleep） |
| abortSignal 防御不足 | 非真正 AbortSignal 调用 addEventListener 报错 | `terminal.js` 检查 `typeof addEventListener === 'function'` |

---

### 3. GUI E2E（playwright）

```bash
cd agent-dev-platform
npm run e2e
```

```
Running 30 tests using 1 worker

  ✓  1-9   gui-main-path.spec.js        （v2.3.1 主路径 9 用例）
  ✓  10-17 smart-onboarding.spec.js     （v2.4.0/2.4.1 Smart API 8 用例）
  ✓  18-26 external-import.spec.js      （v2.5.0/2.5.1 External Import 9 用例）
  ✓  27-30 main-agent.spec.js           （v2.6.0 Main Agent 4 用例）

30 passed (1.0m)
```

**结论：30 / 30 PASS。**

### 3.1 v2.6.0 新增 E2E 用例

| Case | 场景 | 注入脚本 | 终态 | 关键断言 |
| --- | --- | --- | --- | --- |
| 27 | 编码成功 | `buildFixAddScript` | `run_completed` | action 卡片 + 时间线条目 + 文件修复为 `a + b` |
| 28 | 修复循环 | `buildRepairLoopScript` | `run_completed` | `repairStart` 事件 ≥1 + `.ma-repair-banner` 可见 + 文件修复 |
| 29 | 停止 | `buildHangScript` | `run_cancelled` | 停止按钮可见 → 点击 → `run_cancelled` + 状态「已取消」 |
| 30 | 必需验证失败 | `buildPrematureCompleteScript` | `run_failed` | 不得 `run_completed` + repair 触发 + 文件未正确修复 |

### 3.2 测试方法

- 真实 Electron 窗口 + 临时 userData（`%TEMP%\adp-e2e-ma-<uuid>`）
- 通过 `mainAgent:testSetModel` IPC 注入 `FakeCodingModel`（仅 `NODE_ENV=test` 可用）
- 通过 `mainAgent:run` IPC 触发自主编码 Run
- `test/fixtures/coding-agent/` 临时副本作为项目（故意有 bug 的 `add` 函数）
- 事件探针收集 `run_*` 终态 + `mainAgent:*` 事件流

---

### 4. Smoke 测试

```bash
npm run smoke
```

```
SMOKE_OK
```

---

### 5. 构建

```bash
npm run dist
```

| 产物 | 大小 | 说明 |
| --- | ---: | --- |
| `dist-electron/Agent Dev Platform Setup 2.6.0.exe` | 80.9 MB | NSIS 安装包 |
| `dist-electron/Agent Dev Platform 2.6.0 portable.exe` | 80.7 MB | Portable 便携版 |
| `dist-electron/win-unpacked/` | — | 解压目录 |

`dist-electron\win-unpacked\Agent Dev Platform.exe --smoke` 返回 `SMOKE_OK`。

---

### 6. CI（GitHub Actions）

| Job | 状态 | 说明 |
| --- | --- | --- |
| Unit | ⏳ 已触发 / 未独立验证 | push `7660954` 触发 `ci.yml`+`windows-test.yml`；本地 `npm test` 已 617/617 |
| Smoke | ⏳ 已触发 / 未独立验证 | 本地 `npm run smoke` 已 `SMOKE_OK` |
| E2E | ⏳ 已触发 / 未独立验证 | 本地 `npm run e2e` 已 30/30（`windows-test.yml` 的 e2e job `continue-on-error: true`） |

> 本轮未在会话内独立核对 GitHub Actions 运行结果（仓库私有 + 未登录 gh/浏览器）。本地三项全绿，CI 已随 push 触发；如需核验可在 Actions 页面查看 `7660954` 的运行。

---

### 7. 已知遗留

| 项 | 说明 | 风险 |
| --- | --- | --- |
| 46 依赖漏洞 | 全部在 dev/build 依赖，无生产影响 | 低（dependabot 跟踪） |
| WorkBuddy 端到端验证 | 需单独会话验证 | 不影响 Main Agent |
| NSIS UI 回归 | electron-builder 版本差异 | 仅安装界面外观 |
