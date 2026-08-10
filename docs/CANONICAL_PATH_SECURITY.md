# Canonical Path Security

> Agent Dev Platform v2.8.2 — Canonical Path Security Hardening
>
> 彻底消除"字符串路径看起来在 projectRoot 内，但真实文件系统目标已通过 Junction / Symlink / Reparse Point 跳到项目外"的安全问题。

## 1. Threat Model

### 问题

旧实现（v2.8.1 及以前）的路径 containment 判断基于 `path.resolve` + `path.relative`（lexical 字符串比较）：

```js
const base = path.resolve(projectRoot);
const abs = path.resolve(base, target);
const rel = path.relative(base, abs);
return !rel.startsWith('..') && !path.isAbsolute(rel);
```

这只能证明**字符串路径**在 projectRoot 下，不能证明**真实文件系统对象**也在 projectRoot 下。

### 攻击案例

```
D:\project
├─ src
└─ external-link   ← Junction → C:\Users\User\Documents
```

用户/Agent 请求 `D:\project\external-link\private.txt`：

- 字符串分析：`path.relative(D:\project, D:\project\external-link\private.txt)` = `external-link\private.txt` → 看似 INSIDE
- 真实目标：`C:\Users\User\Documents\private.txt` → 实际 OUTSIDE

lexical 判断被 Junction 绕过。

### 受影响的 Reparse Point 类型

| 类型 | 创建命令 | 可指向不存在目标 | 需要权限 |
|------|----------|------------------|----------|
| Junction | `mklink /J` / `fs.symlinkSync(target, link, 'junction')` | 否（目标通常需存在） | 普通用户 |
| Symbolic Link (dir) | `mklink /D` | 是（broken symlink） | 开发者模式/管理员 |
| Symbolic Link (file) | `mklink` | 是 | 开发者模式/管理员 |
| Volume Mount Point | `mountvol` | 否 | 管理员 |

单路径最多 63 个 reparse point。

## 2. 架构

### 单一真相源（§12）

```
src/security/pathSecurity/
├── canonicalPath.js      原语层（filesystem-aware）
├── pathContainment.js    containment 判断层（双层信号）
└── index.js              工厂 + 统一导出
```

所有 containment 判断统一使用本模块，不再各自实现：

```
Raw Operation
      ↓
CommandRiskAnalyzer (lexical signal)
      ↓
PathSecurity Analyzer (canonical containment)  ← 本模块
      ↓
PermissionRiskClassifier (deterministic policy)
      ↓
Permission Broker
      ↓
ALLOW / ASK / DENY
      ↓
Execution-Time Recheck (§66 TOCTOU)
      ↓
Filesystem Mutation
```

### 分层（§28）

- **PathSecurity = filesystem-aware layer**：canonicalizeRoot / canonicalizeTargetPath / checkPathContainment，做 realpath I/O。
- **RiskClassifier = deterministic policy layer**：纯规则，注入 PathSecurity 结果决策，自身不做 I/O（可注入 mock 测试）。

## 3. 核心 API

### 原语（canonicalPath.js）

```js
canonicalizeRoot(projectRoot)        // → canonicalRoot，失败 fail-closed（PATH_ROOT_INVALID）
canonicalizeExistingPath(target)     // 目标存在 → realpath
canonicalizeTargetPath(target)       // 目标可能不存在 → deepest-existing-ancestor 算法
isInsideCanonical(parent, child)     // case-insensitive + prefix-collision-safe
normalizeForCompare(p)               // strip \\?\ + Windows lowercase + trailing sep
realpathSafe(p)                      // → canonical 或 null（锁 key 用，非安全 enforcement）
```

### Containment（pathContainment.js）

```js
checkPathContainment(root, target)   // → PathContainmentResult
assertPathInside(root, target)       // 断言，失败抛 PathSecurityError（execution-time recheck 用）
```

### PathContainmentResult（§25）

```js
{
  allowed: boolean,
  root, target,                      // 原始输入
  canonicalRoot, canonicalTarget,     // canonical 解析后
  deepestExistingAncestor,            // 最深已存在祖先（nonexistent target 用）
  viaReparsePoint: boolean,           // 是否经过 reparse point
  targetExists: boolean,
  lexicalInside: boolean,            // 字符串层 inside（双层信号）
  canonicalInside: boolean,           // canonical 层 inside
  reason: string,
  errorCode: string | null            // PATH_ROOT_INVALID | PATH_CANONICALIZATION_FAILED
                                      // | PATH_OUTSIDE_ROOT | PATH_REPARSE_ESCAPE
                                      // | PATH_UNC_UNSUPPORTED | PATH_TAIL_ESCAPE
}
```

## 4. Deepest Existing Ancestor 算法（§20-22）

目标不存在时（Agent 要创建新文件），`realpathSync.native(target)` 会失败（ENOENT）。算法：

```
targetAbsolute (path.resolve)
    ↓ 不断 dirname() 找到 deepestExistingAncestor（lstat 成功）
    ↓ realpathSync.native(deepestExistingAncestor) → canonicalExistingAncestor
    ↓ 保存不存在的 tail segments
    ↓ tail invariant：不得含 ..（§76）；祖先必须是目录（§77）
    ↓ lexical append tail 到 canonicalExistingAncestor
    ↓ predictedCanonicalTarget
    ↓ isInsideCanonical(canonicalRoot, predictedCanonicalTarget)
```

### 示例（§22）

```
D:\project\link  → Junction → C:\outside
用户目标：D:\project\link\new\file.txt（new\file.txt 不存在）

deepest existing ancestor: D:\project\link
realpath(link) → C:\outside
predicted canonical: C:\outside\new\file.txt
isInsideCanonical(D:\project, C:\outside\new\file.txt) → false
→ REPARSE_ESCAPE → DENY
```

## 5. 双层信号（§30/§31）

| lexicalInside | canonicalInside | 含义 | 风险 |
|---------------|-----------------|------|------|
| true | true | 正常项目内 | 继续 risk 分类 |
| false | false | 字符串层就逃逸（../） | HIGH (OUTSIDE_ROOT) |
| true | false | **路径经 reparse point 逃逸** | HIGH (REPARSE_ESCAPE) |
| false | true | （罕见）canonical 回到内 | ALLOW |

`lexicalInside + canonicalOutside → REPARSE_ESCAPE` 是本轮核心修复信号。

## 6. Fail-Closed（§23）

canonicalization 错误（EACCES/EPERM/ELOOP/broken symlink）**不 fallback 回 lexical 判断**：

```js
try {
  real = fs.realpathSync.native(target);
} catch (e) {
  // broken symlink：lstat 成功但 realpath 失败 → fail-closed（§50）
  throw new PathSecurityError('PATH_CANONICALIZATION_FAILED', ...);
}
```

只有 `ENOENT`（目标不存在）进入 deepest-existing-ancestor 算法。

## 7. TOCTOU 防护（§64-67）

### 问题

```
Check path (permission 评估)
    ↓ 另一个进程替换 directory 为 Junction
Execute (fs.writeFile)
```

### 执行时复检（§66）

mutation 工具（write/create/patch/delete/move/copy/rename/mkdir）在实际 fs 操作前再次 `assertPathInside`：

```js
// src/tools/filesystem.js write_file
const abs = guardCanonical(ctx, args.path);      // initial check
// ... read before content ...
recheckMutationTarget(ctx, args.path);           // execution-time recheck (§66)
await fsp.writeFile(abs, args.content);          // actual mutation
```

### 路径变化（§67）

如果 permission 评估后到执行前路径被替换为 junction 逃逸：

```
Permission 时: inside
执行前: junction → outside
→ DENY (PATH_CHANGED_AFTER_APPROVAL 语义)
```

## 8. 授权边界（§54-56）

权限模型顺序（不可被 GUI allow_once 绕过）：

```
1. Parent Authorization Boundary   (projectRoot only)
2. Canonical Path Boundary          (PathSecurity)
3. Platform Policy
4. External Agent Policy
5. Risk Classification
6. GUI / Policy Decision
```

Parent Run 只授权 projectRoot 时，canonical target outside 必须 `PARENT_SCOPE_DENIED`，即使用户在 Risk GUI 点"允许一次"也不执行。用户需修改 Parent Run Authorization。

## 9. 链接创建风险（§82-85）

创建链接 / reparse point 改变路径拓扑，至少 HIGH：

| 命令 | 信号 | 风险 |
|------|------|------|
| `mklink /J` (junction) | isLinkCreation | HIGH |
| `mklink /D` (dir symlink) | isLinkCreation | HIGH |
| `New-Item -ItemType Junction` | isLinkCreation | HIGH |
| `New-Item -ItemType SymbolicLink` | isLinkCreation | HIGH |
| `ln -s` | isLinkCreation | HIGH |

链接创建 + canonical outside → **CRITICAL**（可改变未来路径边界逃逸）。

## 10. Windows 特性处理

| 特性 | 处理 |
|------|------|
| 大小写不敏感（§46） | `normalizeForCompare` 稳定 toLowerCase（非 localeLowerCase） |
| Trailing separator（§16） | 比较前 strip，避免 D:\proj\ vs D:\proj |
| Prefix collision（§45） | `isInsideCanonical` 用 `parent + sep` 前缀，D:\project 不误判 D:\project-old |
| Extended-length path（§18） | `stripLongPrefix` 去除 `\\?\`，以 Node canonical result 为准 |
| 8.3 短名 | realpath 统一为长名；lexical 层在短名不一致时保守 deny |
| Junction lstat.isDirectory | 用 realpath 后 `statSync(realAncestor).isDirectory()` 判断（lstat 对 junction 返回 false） |

## 11. 性能（§102-104）

- **canonicalRoot 可缓存**（§103）：Run 生命周期内 projectRoot 稳定，`createPathSecurity({ cacheRoots: true })` 缓存 canonicalRoot。
- **target 不缓存**（§104）：每次 mutation 操作执行前 fresh canonicalization，保留 TOCTOU recheck 能力。

## 12. 工具覆盖（§60-62）

| 组件 | 状态 |
|------|------|
| Native filesystem tools (filesystem.js/patch.js) | ✅ PathSecurity + execution-time recheck |
| PermissionRiskClassifier | ✅ 注入 PathSecurity，默认 canonical |
| CommandRiskAnalyzer | ✅ lexical 信号保留，canonical 为准 |
| External Agents (Codex/Claude/ACP) | ✅ 经 classifyRisk 默认 canonical |
| Terminal (terminal.js) | pathguard 兼容层（委托 PathSecurity） |
| Search (search.js) | pathguard 兼容层 |
| Git wrapper | cwd canonical root（复用） |
| ProjectMutationLock | 复用 normalizeForCompare / realpathSafe |

## 13. 已知限制（Remaining Issues）

- **Hard links**（§48）：realpath 不能检测 hard link。Windows hard link 要求同 volume，路径本身仍在 projectRoot。本轮记录决策，不做 inode/file-id policy。如需未来可加 file-id 比对。
- **OS-level TOCTOU**（§65）：本轮不做 Windows 内核级原子 check-then-execute，只在 mutation 前重新 canonicalize。理论上 check 与 execute 之间仍有微秒级窗口，但已大幅缩小攻击面。
- **Shell 内未知路径**（§63）：`node custom-script.js` 脚本内部访问路径无法静态确定，继续由 CommandRiskAnalyzer 的 unknown executable policy 处理。本轮不实现沙箱。

## 14. 测试

- `test/canonicalPathSecurity.test.js`：覆盖 §86 全部 primitive case + Windows Real Junction + TOCTOU + 链接创建风险。
- Pure/Mock + Real FS 两类（§88）。
- Conditional Platform Tests（§89）：Windows junction / 非 Windows symlink。
- 现有 pathguard/permissionRiskClassifier/commandRiskAnalyzer/patch/actionExecutor 测试保留并通过（兼容码映射）。

## 15. 上游参考

| 资料 | URL | checked |
|------|-----|---------|
| Node.js fs.realpath | https://nodejs.org/api/fs.html | 2026-08-10 |
| Windows Reparse Points | https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points | 2026-08-10 |
| Windows Symbolic Links | https://learn.microsoft.com/en-us/windows/win32/fileio/symbolic-link-programming-considerations | 2026-08-10 |
| Sysinternals Junction | https://learn.microsoft.com/en-us/sysinternals/downloads/junction | 2026-08-10 |

### 关键结论

- `fs.realpathSync.native()` 调用 OS 原生 `realpath()` / `GetFinalPathNameByHandle`，可靠解析 reparse point。
- Symbolic Link 可指向不存在目标（broken symlink），realpath 失败须 fail-closed。
- Junction 可由普通用户创建（`fs.symlinkSync(target, link, 'junction')`），不需管理员权限，测试可覆盖。
- 单路径最多 63 个 reparse point。
