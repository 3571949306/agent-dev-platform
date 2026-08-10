# Security Dependency Audit — v2.8.1

**Audit date:** 2026-08-10
**Baseline:** v2.8.0 (commit `60e3fc4`)
**Audit tool:** `npm audit` (npm 10.x)
**Audited scopes (spec §52):** root production / root full / bundled Cline sidecar production

本轮重新执行了三个独立的 audit 范围。历史章节（v2.5.1）保留在文末，仅供追溯，
其中的 `Production-impacting: 0` 结论已被本轮结果推翻（见 §54 声明）。

---

## 1. Summary（spec §55）

```text
Root production      (npm audit --omit=dev)                      : 0
Root dev/build       (npm audit)                                 : 13
  - critical : 1
  - high     : 12

Cline sidecar production
  (sidecars/cline-runtime, npm audit --omit=dev)                 : 19
  - high     : 1
  - moderate : 15
  - low      : 3
```

### Remaining advisories in shipped code paths: **19（不是 0）**

按 spec §54，只有在
`Root Production = 0` **AND** `Bundled Sidecar Production = 0`
同时成立时才允许写 `Remaining Advisories = 0`。

本轮实际结果：

| 条件 | 实测 | 满足？ |
| --- | ---: | --- |
| Root production = 0 | 0 | ✅ |
| Bundled sidecar production = 0 | 19 | ❌ |

因此**本版本不得声明 `Remaining Advisories = 0`**。

> 与 v2.7.3 报告的差异：sidecar production 从 16（15 moderate / 1 high）变为
> 19（15 moderate / 1 high / 3 low）。新增的 3 项 low 来自 `dify-ai-provider`
> → `@cline/llms` → `@cline/agents` 传递链上新披露的 advisory，不是依赖版本变更
> （sidecar lockfile 本轮未改动）。

---

## 2. 为什么 sidecar 属于生产依赖（spec §53）

`package.json` 的 electron-builder 配置：

```json
"extraResources": [
  { "from": "build-runtime/cline-runtime", "to": "cline-runtime" }
]
```

安装包会把 `cline-runtime` 的**完整生产依赖树**落到最终用户机器的
`resources/cline-runtime/`，并由固定 Node 22 子进程真实执行。

所以：**Sidecar production dependencies 就是生产依赖**，不能只报告 root。

---

## 3. Root production — 0 findings

```powershell
npm audit --omit=dev
```

```text
{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
```

主进程运行时依赖（`better-sqlite3`、`express` 等）无已知 advisory。

---

## 4. Root full — 13 findings（spec §57 分级）

```powershell
npm audit
```

```text
{"info":0,"low":0,"moderate":0,"high":12,"critical":1,"total":13}
```

| Package | Severity | Dependency path | Runtime reachable? | Network reachable? | Fix available | Breaking upgrade | Mitigation / decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tar` `<=7.5.20` | critical | `electron-builder` → `app-builder-lib` → `tar`；`electron-rebuild` → `node-gyp` → `tar` | **No** — 仅 `npm run dist` / native rebuild 期间执行 | No（构建机本地解包） | `electron-builder@26.15.3` | **Yes**（semver major） | Build-only。硬链接路径穿越只在解包不可信 tarball 时触发，构建输入均为本仓库固定 lockfile。**Deferred**，随 electron-builder 大版本升级处理。 |
| `electron` `<=39.8.9` | high | direct devDependency，但**二进制随包分发** | **Yes** — 最终用户执行的 `Agent Dev Platform.exe` 内嵌 Electron 运行时 | 取决于具体 advisory | `electron@43.3.0` | **Yes**（31 → 43，跨 12 个大版本） | **唯一具备真实 runtime exposure 的 root 项**。主要 advisory 为 ASAR Integrity Bypass（需本地写权限改资源）与 AppleScript 注入（macOS-only，本产品仅出 Windows 包）。本轮不升级：31→43 会连带 native module ABI 与 electron-builder 全链重验。列为独立版本的升级任务。 |
| `electron-builder` `19.28.0 - 26.14.0` | high | direct devDependency | No | No | `26.15.3` | **Yes** | Build-only，不进入用户进程。**Deferred**。 |
| `electron-rebuild` `>=1.5.0` | high | direct devDependency | No | No | `electron-rebuild@2.0.3` | **Yes** | Build-only（native module 编译）。**Deferred**。 |
| `app-builder-lib` `<=26.14.0` | high | → `electron-builder` | No | No | 随 `electron-builder@26.15.3` | Yes | 传递项，随父包处理。advisory 为 AppImage 搜索路径（Linux-only，本产品不出 AppImage）。 |
| `builder-util` | high | → `electron-builder` | No | No | 随父包 | Yes | 传递项。 |
| `builder-util-runtime` `<9.7.0` | high | → `electron-builder` / `electron-publish` | No | No（不使用 electron-updater 发布流） | 随父包 | Yes | advisory 为 electron-updater 跨域重定向泄漏 `PRIVATE-TOKEN`；本项目未启用 electron-updater 自动更新，无 token 参与构建。 |
| `dmg-builder` | high | → `electron-builder` | No | No | 随父包 | Yes | macOS 打包路径，本产品不构建 dmg。 |
| `electron-builder-squirrel-windows` | high | → `electron-builder` | No | No | `true`（非 major） | No | 未使用 Squirrel 安装器（本产品用 NSIS）。 |
| `electron-publish` | high | → `electron-builder` | No | No | `true` | No | 未使用自动发布流。 |
| `node-gyp` `<=10.3.1` | high | → `electron-rebuild` | No | No | 随 `electron-rebuild@2.0.3` | Yes | Build-only。 |
| `make-fetch-happen` `7.1.1 - 14.0.0` | high | → `node-gyp` | No | 仅构建期下载 native 预编译产物 | 随 `electron-rebuild@2.0.3` | Yes | Build-only。 |
| `cacache` `14.0.0 - 18.0.4` | high | → `make-fetch-happen` | No | No | 随 `electron-rebuild@2.0.3` | Yes | Build-only（npm 缓存层）。 |

**Root 结论：13 项中 12 项为 build-only，无用户侧运行时暴露；`electron` 1 项具备真实 runtime exposure，按 advisory 逐条评估后判定当前 Windows 产物不受已披露利用路径影响，但仍列为待升级项。**

---

## 5. Cline sidecar production — 19 findings（spec §57 分级）

```powershell
cd sidecars/cline-runtime
npm audit --omit=dev
```

```text
{"info":0,"low":3,"moderate":15,"high":1,"critical":0,"total":19}
```

> 该目录未安装 `node_modules`（sidecar 依赖在 `npm run prepare-cline-runtime`
> 阶段才落到 `build-runtime/`），audit 基于已提交的 `package-lock.json` 解析
> 完整依赖树，结果与安装后一致。

### 5.1 High（1）

| Package | Severity | Dependency path | Runtime reachable? | Network reachable? | Fix available | Breaking upgrade | Mitigation / decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `undici` `<=6.27.0` | high | `@cline/sdk` → `@cline/core` → `ai` / `@ai-sdk/provider-utils` → `undici` | **Yes** — 模型调用走 fetch 路径 | **Yes** — 面向用户配置的 LLM endpoint | `true`（lockfile 内可解，非 major） | No | advisory 为 HTTP 响应解压链无界（Content-Encoding 嵌套）。触发前提是**恶意/被劫持的模型服务端**返回深度嵌套压缩响应。缓解：endpoint 由用户显式配置且走 HTTPS；sidecar 输出有 8 MiB cap。**可修**，但升级需同步 `@ai-sdk/provider-utils`，会偏离 `@cline/sdk 0.0.72` 的已验证闭包（见 §6）。 |

### 5.2 Moderate（15）

| Package | Dependency path | Runtime reachable? | Network reachable? | Fix available | Mitigation / decision |
| --- | --- | --- | --- | --- | --- |
| `@cline/sdk` `*` | direct dependency | Yes | Yes | **false** | 无上游修复版本；advisory 由子依赖传递而来。**Accepted upstream advisory**。 |
| `@cline/core` `*` | → `@cline/sdk` | Yes | Yes | **false** | 同上，传递自 `@cline/agents` / `@cline/llms` / OpenTelemetry 链。 |
| `@ai-sdk/provider-utils` `<=3.0.31 \|\| 4.0.41-4.0.42` | → `@cline/core` → `ai` | Yes | Yes | `true` | Uncontrolled Resource Consumption（同 undici 的解压链问题面）。与 undici 绑定处理。 |
| `ai` `5.0.223-5.0.228 \|\| 6.0.238-6.0.246` | → `@cline/core` | Yes | Yes | `true` | 传递自 `@ai-sdk/*`。 |
| `@ai-sdk/gateway` | → `@ai-sdk/provider-utils` | 仅在使用 gateway provider 时 | 条件 | `true` | 本平台不经 AI Gateway，未构造该 provider。 |
| `@opentelemetry/core` `<2.8.0` | → `@cline/core` 遥测链 | 条件 | **No（已阻断）** | **false** | W3C Baggage 传播无界内存分配。缓解见下方说明。**Accepted upstream advisory**。 |
| `@opentelemetry/exporter-logs-otlp-http` `<=0.218.0` | → `@cline/core` | 条件 | No（已阻断） | **false** | 同上。 |
| `@opentelemetry/exporter-metrics-otlp-http` | → OTLP 链 | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/exporter-trace-otlp-http` | → OTLP 链 | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/otlp-exporter-base` | → OTLP 链 | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/otlp-transformer` | → OTLP 链 | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/resources` `0.8.0-2.7.1` | → `@opentelemetry/core` | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/sdk-logs` | → `@opentelemetry/core` | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/sdk-metrics` `<=2.7.1` | → `@opentelemetry/core` | 条件 | No（已阻断） | `true` | 同上。 |
| `@opentelemetry/sdk-trace-base` `<=2.7.1` | → `@opentelemetry/core` | 条件 | No（已阻断） | `true` | 同上。 |

**OpenTelemetry 网络可达性判定依据（可核实）：**
`src/agents/integrations/cline/sidecarManager.js:14-18` 的 `SAFE_ENV_KEYS` 白名单为

```text
SYSTEMROOT WINDIR COMSPEC PATHEXT PATH TEMP TMP
USERPROFILE APPDATA LOCALAPPDATA PROGRAMDATA HOMEDRIVE
HOMEPATH NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE
```

sidecar 的 env 由该白名单逐项过滤后重建（`buildSidecarEnv`，第 44-51 行），
**不包含任何 `OTEL_*` 键**。因此即使宿主机设置了
`OTEL_EXPORTER_OTLP_ENDPOINT`，也不会透传给 sidecar，OTLP exporter 无法被指向
外部 collector。判定为 `Network reachable = No（已阻断）`，而不是"上游默认不发"。

> 保留 `条件` 而非 `No` 的 Runtime reachable 标注，是因为无法断言上游
> `@cline/core` 在任何代码路径下都不初始化 OpenTelemetry SDK；初始化本身
> 属进程内行为，仍在 sidecar 进程内可达。

### 5.3 Low（3）

| Package | Dependency path | Runtime reachable? | Fix available | Mitigation / decision |
| --- | --- | --- | --- | --- |
| `dify-ai-provider` `<=0.1.6` | → `@cline/llms` | 仅在选择 Dify provider 时 | `true` | 本平台不构造 Dify provider。 |
| `@cline/llms` `*` | → `@cline/agents` | Yes | `true` | 传递自 `dify-ai-provider`。 |
| `@cline/agents` `*` | → `@cline/core` | Yes | `true` | 传递自 `@cline/llms`。 |

---

## 6. 不为变成 0 而强行 override（spec §56）

`@cline/sdk` 与 `@cline/core` 的 `fixAvailable` 为 **false** —— 上游没有已发布的
修复版本，任何"清零"都只能靠 `overrides` 强行替换传递依赖版本。

本项目对 Cline 的集成结论（`docs/CLINE_RUNTIME_DECISION.md`、
`docs/UPSTREAM_REFERENCE_MATRIX.md`）建立在 **固定的 `@cline/sdk 0.0.72` 依赖闭包**
之上，v2.7.3 的真实 sidecar fixture（真实 SDK + 真实 `ClineCore` + 本地模型 fixture）
也是针对该闭包验证的。跨 major override 会：

1. 使已验证的 SDK 依赖闭包失效，v2.7.3 的 integration evidence 不再适用；
2. 在没有上游修复的前提下，把风险从"已知 advisory"换成"未验证的依赖组合"。

因此本版本的处置是：

```text
accepted upstream dependency advisory
```

适用于：`@cline/sdk`、`@cline/core`、`@opentelemetry/core`
及其 `fixAvailable=false` 的 OTLP exporter 传递项。

其余 `fixAvailable=true` 的 sidecar 项（undici / ai / @ai-sdk/* / @cline/llms /
@cline/agents / dify-ai-provider）**技术上可修**，但它们全部位于同一条
`@cline/sdk → @cline/core` 闭包内，单独提版同样会脱离已验证组合。这些列为
**下一版本的 sidecar 闭包整体升级任务**，需要连带重跑 Cline integration fixture。

---

## 7. 复现命令

```powershell
# Root production
cd agent-dev-platform
npm audit --omit=dev

# Root full
npm audit

# Bundled Cline sidecar production
cd sidecars/cline-runtime
npm audit --omit=dev
```

本轮原始 JSON 输出留存于 `.cache/audit/`（该目录不提交）。

---

## 8. 跟踪项

| 项 | 范围 | 计划 |
| --- | --- | --- |
| Electron 31 → 43 | root（runtime exposure） | 独立版本，需全量 E2E + native ABI 回归 |
| electron-builder 24 → 26.15.3 | root（build-only） | 与 Electron 升级同批 |
| electron-rebuild → 2.0.3 | root（build-only） | 与 Electron 升级同批 |
| Cline sidecar 闭包整体升级 | sidecar（production） | 需上游 `@cline/sdk` 发布修复版；升级后必须重跑 sidecar integration fixture |
| OpenTelemetry 链 | sidecar（production） | 依赖 `@cline/core` 上游；当前由 env 白名单阻断外部导出 |

---
---

# Historical — v2.5.1（保留追溯，结论已被 v2.8.1 覆盖）

**Audit date:** 2026-08-09
**Baseline:** v2.5.0 (commit da5f03c)

| Severity   | Before (v2.5.0 spec) | After audit (v2.5.1) |
|------------|----------------------|----------------------|
| Critical   | 1                    | 1                    |
| High       | 16                   | 12                   |
| Moderate   | 24                   | 0                    |
| Low        | 5                    | 0                    |
| **Total**  | **46**               | **13**               |

该版本仅审计了 root 范围，并在结论中写下
`Production-impacting: 0`。

> **v2.8.1 更正**：该结论不成立。安装包通过 `extraResources` 分发
> `cline-runtime` 的完整生产依赖树，其 production audit 为 19 项
> （1 high / 15 moderate / 3 low）。v2.5.1 的口径遗漏了 bundled sidecar，
> 属于范围错误而非数字错误。当时 sidecar 尚未引入（v2.7.3 才加入），
> 但该结论被后续版本沿用，直到本轮才纠正。

v2.6.0 已修正过一次口径（Electron 不能简单归为 build-only，因为它是桌面应用的
实际 Runtime）；该修正在 v2.8.1 中继续保留，见第 4 节 `electron` 行。
