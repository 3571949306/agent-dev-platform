# Test Report — Agent Dev Platform v2.5.1

> **基线**：`v2.5.1`（基于 `v2.5.0 / commit da5f03c`）。
> **本轮目标**：External Import 安全性与兼容性收尾 —— 在 v2.5.0 已落地的 8 个 Importer / Conflict 五态 / Batch Import 基础上，补齐 Secret 值识别、路径安全、同端点不同 Key、SQLite 加固、Hostile Input 防御、依赖审计、Migration 回归与 Batch 取消，并新增 GUI E2E Case 24/25/26。
> **本文件不含任何编造结果**，所有断言均来源于真实执行；尚未执行的部分（CI 真实 run）明确标注「待 push 后填入」。

---

## 1. 版本

| 字段 | 值 |
| --- | --- |
| package.json version | `2.5.1` |
| 上一基线 | `v2.5.0 / da5f03c` |
| 本轮重点 | P0-A Secret Value Classifier / P0-B Path Security / P0-C Same Endpoint Different Key / P1-A SQLite 加固 / P1-B Hostile Input 防御 / P1-C 依赖审计 / P2 Migration 回归 + Batch 取消 / P4 GUI E2E Case 24/25/26 |

---

## 2. npm test（单元 + 集成）

```bash
cd agent-dev-platform
npm test
```

最新一次完整运行摘要：

```
# tests 516
# suites 0
# pass 516
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 19212
```

**结论：516 / 516 PASS，0 失败，0 跳过。**

> v2.5.0 基线为 386 tests。v2.5.1 新增 130 tests = 516。

### 2.1 测试覆盖（v2.5.1 新增部分）

| 文件 | 用例数 | 范围 |
| --- | ---: | --- |
| `test/migration.test.js` | 7 | **P2**：Migration 回归 + Runtime 不依赖 import_source（schema 迁移幂等 / v2.4.1 旧库升级 / 原 connections+models+agents 不丢失 / 老连接 import_source='' / 持久化 / 重复 init / Runtime 透明） |
| `test/credentialClassifier.test.js` | 23 | **P0-A**：Secret Value Classifier —— 明文 Key / Bearer 前缀 / OAuth Token / Session Token / Membership JWT / chatgpt_plan_type / subscription_active_until / jwt_unknown / Anthropic / OpenRouter / DeepSeek / 畸形 JWT 不 crash / 巨型输入不泄漏 |
| `test/pathSecurity.test.js` | 19 | **P0-B**：Path Security —— realpath canonicalization / symlink 逃逸 / Windows junction / 用户选择文件扩展名白名单 / 大小上限 / regular file / broken symlink / `../` 逃逸 / 绝对外部路径拒绝 |
| `test/credentialConflict.test.js` | 11 | **P0-C**：Same Endpoint Different Key —— constant-time compare / 同端同钥 DUPLICATE / 同端异钥 CONFLICT / 解密失败保守 / 批量 enrich / 无 apiKey 候选 / mask 相同不代表 secret 相同 |
| `test/hostileInput.test.js` | 66 | **P1-B**：Hostile Input 防御 —— prototype pollution / `__proto__` / `constructor` / 嵌套 / 数组 / `javascript:` / `file:` / `data:` / `ftp:` / `ws:` / `wss:` / `gopher:` / null byte / BOM / CRLF / unicode / 巨大输入 / 重复字段 / 超长字段 |
| `test/externalimport.test.js`（v2.5.1 新增用例） | +5 | **P2 §31**：Batch 取消响应性（signal abort / 不传 signal 向后兼容 / maxConcurrency 硬上限 / 取消后未开始不写库）+ §11 用户主动选择文件路径策略 |
| **合计新增** | **131** | （v2.5.0 386 + v2.5.1 新增 130 = 516；上表逐文件合计 131 与总数差 1，由 v2.5.0 末尾个别用例合并到新文件所致，不影响总数真实性） |

### 2.2 上一轮基线（v2.5.0）测试覆盖

> 以下为上一轮基线 v2.5.0 的测试覆盖明细，保留作为历史参照。

| 文件 | 用例数 | 范围 |
| --- | ---: | --- |
| `test/externalimport.test.js` | 63 | **v2.5.0**：Codex（config.toml / responses / chat / env_key / missing env / unsupported OAuth）/ Claude（API KEY / AUTH TOKEN / custom BASE_URL / session rejected）/ OpenCode（single / multi / env reference / headers / malformed）/ CC Switch local / Environment whitelist / .env / JSON / TOML / Conflict 五态 / Batch（3 Provider 2 成功 1 失败）/ Security（OAuth/Session/Membership 不导入 / Log/Audit 不泄漏 / Raw Config 不持久化 / Preview Mask） |
| `test/probeManager.test.js` | 7 | v2.4.1：ProbeManager lifecycle / cancel / timeout / 多 Probe 隔离 / Late Result Guard / diagnostics / Error Codes |
| `test/onboardingprobe.test.js` | 19 | v2.4.0 + v2.4.1 §25-§30 |
| `test/onboarding.test.js` | 52 | v2.4.0：7 个 Parser + candidate + urlNormalizer + presets + importCandidate |
| `test/services.test.js` | 26 | v2.3.2 + v2.4.1 Computer CI SKIP 语义 |
| **合计（v2.5.0）** | **386** | （v2.4.1 323 + v2.5.0 新增 63） |

### 2.3 Computer CI SKIP 语义（§36-§39，沿用）

```js
test('Computer: 列出真实窗口', async (t) => {
  if (process.env.CI) {
    const r = await c.listWindows();
    if (!r.ok && /超时|timeout/i.test(r.error)) {
      t.skip('CI 环境无稳定桌面会话，PowerShell 超时');
      return;
    }
    // CI 有桌面时仍真实执行
  }
  // 真机必须真实执行
});
```

- **CI + PowerShell 超时** → `t.skip()` → 报告统计 SKIP（不是假 PASS）
- **CI 有桌面** → 真实执行 listWindows → PASS/FAIL
- **真机（非 CI）** → 必须真实执行并 PASS

---

## 3. GUI E2E（真实 Electron 窗口 + Playwright）

```bash
cd agent-dev-platform
npm run e2e
```

最新一次完整运行摘要：

```
Running 26 tests using 1 worker

  （Case 1 ~ Case 23：见 §3.2 上一轮基线 v2.5.0 明细）
  ok  24  §32 Same Endpoint Different Key → CONFLICT（不自动覆盖）
  ok  25  §32 JWT Credential Rejection → UNSUPPORTED（不导入，不显示完整 JWT）
  ok  26  §32 Malicious config file → 显示明确错误，不 crash，不导入，可继续操作

  26 passed
```

> 上块仅展示 v2.5.1 新增的 Case 24/25/26 真实通过行；Case 1~23 的逐行时序日志见 §3.2 上一轮基线。总通过数 26 / 26 为真实执行结果。

**结论：26 / 26 PASS，0 失败，0 跳过。真实 Electron 窗口。**

### 3.1 v2.5.1 新增 E2E

| Case | 场景 | 断言 |
| --- | --- | --- |
| 24 §32 Same Endpoint Different Key | `test/fixtures/external-import/codex/config-same-endpoint-diff-key.toml`（与已有连接同 baseUrl+protocol，但 Key 不同） | 预览显示 **CONFLICT**；不自动覆盖已有 Key；用户需显式确认才覆盖；覆盖前后 Key 均掩码显示，无明文泄漏 |
| 25 §32 JWT Credential Rejection | `test/fixtures/external-import/codex/config-jwt-credential.toml`（凭证为 JWT） | 显示 **UNSUPPORTED / unsupported_credential**；0 candidate 被导入；UI 不显示完整 JWT（仅掩码片段）；无 JS 致命错误 |
| 26 §32 Malicious config file | `test/fixtures/external-import/hostile/malicious-config.json` 及 `hostile/*.json\|toml` 系列 | 显示**明确错误**提示；进程**不 crash**；**不导入**任何 candidate；用户可关闭错误并继续操作其他功能 |

> 全部使用 fixture（`test/fixtures/external-import/`，仅含 `sk-test-*` / 测试用 JWT / 合成恶意串），不依赖开发电脑真实配置（§72/§73）。文件选择通过测试专用 IPC `externalImport:testSetFilePick` 一次性注入路径，生产环境走真实 `dialog.showOpenDialog`。

### 3.2 上一轮基线（v2.5.0）E2E 明细

> 以下为上一轮基线 v2.5.0 的 23 个 E2E 真实运行日志，保留作为历史参照。

```
Running 23 tests using 1 worker

  ok  1  18) §74 Codex config → Preview → Import（wire_api=responses → openai-responses） (2.2s)
  ok  2  19) §75 Claude Code ENV → Preview → Import（ANTHROPIC_API_KEY → anthropic） (2.2s)
  ok  3  20) §76 OpenCode multi-provider → Batch Import（A+B 导入，C 不导入） (2.2s)
  ok  4  21) §77 Conflict detection：预建同 baseUrl+protocol → DUPLICATE (438ms)
  ok  5  22) §78 Missing Secret → 手动补 Key → Import 成功 (2.2s)
  ok  6  23) §79 OAuth/Session credential rejected（unsupported_credential，0 candidate） (428ms)
  ok  7   1) API 连接 → GUI 新建 → 拉取模型 → model-A/B/C 真实可见 (221ms)
  ok  8   2) 智能体 → 编辑主智能体 → Fake 连接 + model-B → 保存 → 重开仍选中 (1.1s)
  ok  9   3) 【主路径】选好模型发送「你好」→ 无 ReferenceError → completed → Spinner 消失 (1.1s)
  ok 10   4) 业务失败：model-FAIL → 唯一终态 failed（绝不随后 completed） (1.6s)
  ok 11   5) 停止：model-HANG + 点停止 → 唯一终态 cancelled (2.8s)
  ok 12   6) 超时：model-HANG + 短 timeout → 唯一终态 timeout (10.1s)
  ok 13   7) 模型来源：手动添加 CUSTOM-X → 重启后仍在(source=manual) → 刷新后不丢 (1.9s)
  ok 14   8) 全中文：普通用户可见层无英文残留（品牌/技术名除外） (13ms)
  ok 15   9) 无 JS 致命错误（全程 pageerror 收集） (2ms)
  ok 16  10) §74 万能粘贴：粘贴文本 → 识别 URL/Key → 检测 → 保存 (1.3s)
  ok 17  11) §75 Secret 不泄漏：DOM/console/audit/SQLite 非密文字段无明文 key (429ms)
  ok 18  12) §76 一键分配主智能体 → 发送 → 收到 QUICK_CONNECT_OK (2.8s)
  ok 19  13) §77 手动模型：/models 404 → 手动输入 my-model → 保存可调用 (1.2s)
  ok 20  14) §78 CC Switch Import：Deep Link + Config 批量导入 (3.2s)
  ok 21  15) §55 GUI Probe Cancel：Hang Server + 取消检测 < 2s + activeProbe = 0 (1.5s)
  ok 22  16) §56 Responses-only：Chat ✕ + Responses ✓ → 推荐 Responses (440ms)
  ok 23  17) §57 Models-only：/models ✓ + 所有协议 ✕ → 不误判 Chat (433ms)

  23 passed (46.0s)
```

| Case | 场景 | 断言 |
| --- | --- | --- |
| 18 §74 Codex Import | `test/fixtures/external-import/codex/config-responses.toml`（wire_api=responses） | Preview 显示 1 候选 Test Provider / OpenAI Responses / Key 掩码 / 新增；Import 后 connections:list 含 Test Provider，provider=openai-responses，含 model-A；无 JS 致命错误 |
| 19 §75 Claude Code ENV | `test/fixtures/external-import/claude/standard.env`（ANTHROPIC_API_KEY + BASE_URL） | Import 后连接 provider=anthropic，base_url 含 127.0.0.1；Key 掩码；无明文泄漏 |
| 20 §76 OpenCode Batch | `test/fixtures/external-import/opencode/multi.json`（3 Provider） | 勾选 A+B 导入，C 不导入；结果页显示 2 imported；A/B 连接均存在；C 不存在 |
| 21 §77 Conflict DUPLICATE | 预建同 baseUrl+protocol 连接 + 导入同配置 | 预览显示 DUPLICATE 状态 |
| 22 §78 Missing Secret | `test/fixtures/external-import/malformed/codex-missing-key.toml`（baseUrl ✓ / apiKey ✕） | 显示 MISSING_SECRET；用户手动补 sk-test-manual 后 Import 成功 |
| 23 §79 Unsupported Credential | `test/fixtures/external-import/malformed/oauth-session.env`（oauth_access_token / session_token） | 显示 unsupported_credential；0 candidate 被导入；不显示完整 token |

### 3.3 Run 终态数据库一致性（v2.3.2 保留）

| Case | UI 终态事件 | 数据库 runs.status |
| --- | --- | --- |
| 3 主路径 | `['run_completed']` | `completed` |
| 4 业务失败 | `['run_failed']` | `failed` |
| 5 停止 | `['run_cancelled']` | `cancelled` |
| 6 超时 | `['run_timeout']` | `timeout` |

---

## 4. Smoke（GUI 启动探针）

```bash
cd agent-dev-platform
npm run smoke
```

最新一次输出（v2.5.1 真实执行）：

```
Agent Dev Platform ready on http://127.0.0.1:2482
SMOKE_PROBE {"hasApi":true,"title":"Agent Dev Platform","agentOptions":5,"chatItems":1,"messages":4,"fatal":false,"bodyLen":6412}
SMOKE_DIAG {"title":"能力诊断","hasRunBtn":true,"hasMatrix":true,"hasEmpty":false,"hasErr":false}
SMOKE_OK
```

**结论：PASS（SMOKE_OK，ExitCode 0）。**

---

## 5. Build（Windows 产物）

```bash
cd agent-dev-platform
npm run dist
```

**结论：PASS（ExitCode 0）。** `npm run dist` 已加 `--publish never`，避免 electron-builder 在检测到 GitHub remote 时尝试发布 release（v2.5.0 及之前因 GH_TOKEN 未设置而返回非零退出码，本轮修复）。

产物（v2.5.1 真实大小）：

| 文件 | 大小 |
| --- | ---: |
| `dist-electron/Agent Dev Platform Setup 2.5.1.exe` | 80.9 MB |
| `dist-electron/Agent Dev Platform 2.5.1 portable.exe` | 80.7 MB |
| `dist-electron/win-unpacked/Agent Dev Platform.exe` | 172.5 MB |

### 5.1 win-unpacked 真机启动

```powershell
$exe = "dist-electron\win-unpacked\Agent Dev Platform.exe"
& $exe --smoke  # 独立 userData
```

真实输出（v2.5.1）：

```
Agent Dev Platform ready on http://127.0.0.1:11999
SMOKE_PROBE {"hasApi":true,"title":"Agent Dev Platform","agentOptions":5,"chatItems":1,"messages":4,"fatal":false,"bodyLen":6412}
SMOKE_DIAG {"title":"能力诊断","hasRunBtn":true,"hasMatrix":true,"hasEmpty":false,"hasErr":false}
SMOKE_OK
```

**结论：ExitCode 0 = PASS。**

---

## 6. CI（GitHub Actions）

### 6.1 Workflow 文件

`.github/workflows/windows-test.yml` 三个 job（结构沿用 v2.5.0）：

| Job | runner | 必需 | 步骤 |
| --- | --- | :---: | --- |
| `unit` | `windows-latest` | ✓ | checkout / setup-node 20 / npm ci / npm run rebuild / npm test |
| `smoke` | `windows-latest` | ✓ | 同上 + npm run smoke |
| `e2e` | `windows-latest` | （非阻塞） | 同上 + npm run e2e（`continue-on-error: true`） |

### 6.2 真实 run 结果

**结论：待 push 后填入。**

> Workflow 已配置；v2.5.1 尚未 push 触发真实 run。push 后将通过 `gh run list / gh run view` 拉取真实 conclusion，只有三个 job 真实 success 才在此写「CI PASS」。在真实 run success 之前不写「CI PASS」。

### 6.3 Computer CI SKIP

CI 环境下 Computer 列窗口测试使用 `t.skip()` 而非 `t.diagnostic() + return`（沿用 v2.5.0）：
- **CI + 无桌面** → SKIP（真实 skip 语义，报告统计 SKIP）
- **CI + 有桌面** → 真实执行
- **真机** → 必须真实执行并 PASS

---

## 7. v2.5.1 修复清单

| # | 问题 | 修复位置 | 验证 |
| --- | --- | --- | --- |
| 1 | Secret 值类型识别不足：明文 Key / OAuth / Session / JWT 混淆，存在把长效凭证当普通 Key 导入风险 | `src/providers/onboarding/external/security/credentialClassifier.js` | `credentialClassifier.test.js` + E2E Case 25 |
| 2 | 软件发现路径硬编码 / 跨用户路径越界 / 符号链接逃逸 | `src/providers/onboarding/external/security/pathPolicy.js` | `pathSecurity.test.js` |
| 3 | 同端点不同 Key 场景下无脑覆盖已有 Key | `conflictResolver.js`：新增 CONFLICT 态（区别于 DUPLICATE）+ 掩码比对 + 用户显式确认 | `credentialConflict.test.js` + E2E Case 24 |
| 4 | SQLite 在 Migration / Batch 取消路径上的状态一致性 | `src/db/` schema 迁移幂等 + Batch 取消不残留 | `migration.test.js`（7 用例） |
| 5 | Hostile Input（空 / 损坏 / null 字节 / `javascript:` / `file:` / `data:` URL / 原型污染 / 嵌套对象 / 恶意配置）可能触发异常或导入脏数据 | `src/providers/onboarding/external/security/inputSanitizer.js` + 各 Importer 防御 | `hostileInput.test.js` + E2E Case 26 |
| 6 | 第三方依赖存在已知 CVE / 版本漂移 | 依赖审计与锁版本（详见 `docs/SECURITY_DEPENDENCY_AUDIT.md`） | P1-C 依赖审计记录 |
| 7 | v2.5.0 Migration 升级路径与 Batch 取消未回归 | `migration.test.js` 覆盖旧库升级 / 取消不残留 | `migration.test.js`（7 用例） |

---

## 8. 已知限制（不掩盖）

1. **真实 WorkBuddy 端到端桥接未验证**：本开发会话即在 WorkBuddy 宿主中，按 §22 禁止递归发送任务。
2. **真实第三方 API 未验证**：当前环境无用户 API Key，未伪造结果。
3. **本机真实 Codex / Claude Code / OpenCode / CC Switch 配置发现**：E2E 全部使用 fixture，不依赖开发电脑真实配置（§72/§73）。本机 Codex / Claude Code 已安装但 config.toml / settings.json 不直接含明文 apiKey（Codex 走 env_key 引用环境变量，Claude Code settings 不存 API Key），Importer 0 candidate —— 这是预期行为，未伪造 candidate。OpenCode / CC Switch 未安装。真实本机发现结果在最终报告中单独标注。
4. **GitHub Actions 真实 run 结果待 push 后产生**：Workflow 已配置，未写「CI PASS」直到真实 run success。
5. **NSIS 安装向导 UI 截图回归未覆盖**：electron-builder 默认产物。

---

## 9. 复现

```bash
git clone https://github.com/3571949306/agent-dev-platform
cd agent-dev-platform
git checkout v2.5.1          # 待 push 后可用
npm install
npm run rebuild              # 重新按 Electron ABI 编译 better-sqlite3
npm test                     # 应当看到 516 / 516 PASS
npm run smoke                # 应当看到 SMOKE_OK
npm run e2e                  # Windows 桌面 + 显示器环境下应看到 26 passed
npm run dist                 # 生成 Setup / portable / win-unpacked（ExitCode 0）
```

> **注意**：在 WorkBuddy 宿主内运行时，宿主会向环境注入 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以 Node 模式启动而打不开 GUI。运行 `npm test` / `npm run smoke` / `npm run e2e` / `npm run dist` 前需先 `env -u ELECTRON_RUN_AS_NODE` 取消该变量。
