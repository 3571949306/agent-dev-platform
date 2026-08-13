# GUI Performance Baseline（v2.9.9 Phase B Final · B35）

> 本文只记录**机器实测结果**，不制定虚构指标。测量来自 `test/e2e/perf.spec.js`
> （真实 Electron + 本地 Fake API，离线、0 付费调用）。复现：`npx playwright test test/e2e/perf.spec.js`。
> 测量钩子在 `public/js/app.js` 的 `window.__adpBench`（boot 打点 + 真实渲染路径计时），
> 不引入独立 Benchmark Framework。

## 测量环境

```text
OS:        Windows 25H2
Runtime:   Electron（仓库内置）+ Playwright driver
Backend:   本地 Fake API（http://127.0.0.1:<port>/v1），全程离线
Renderer:  public/ 真实前端（非 mock）
```

## 基线数字（2026-08-13 实测）

| 指标 | 数值 | 说明 |
|---|---|---|
| Boot → Workbench ready | **255 ms** | `window.__adpPerfBootStart`（HTML 内联）到 `__adpPerfWorkbenchReady`（boot 完成）|
| Activity switch · Connections | 28 ms | 打开管理页到 LOADING 态被真实内容替换 |
| Activity switch · Agents | 26 ms | 同上 |
| Activity switch · Skills | 52 ms | 同上 |
| Activity switch · Workflows | 26 ms | 同上 |
| Activity switch · Diagnostics | 3286 ms | 含真实 Computer/External 探测（非渲染耗时）|
| Open 2000-line file | 13 ms | 真实 `workspace.openFile` 渲染路径 |
| Render 1000 timeline events | <1 ms | 真实 `ingestRunEvent` 去重 + 聚合路径 |
| Render 500 terminal updates | 669 ms | 真实 termWrite（bounded DOM）|
| Terminal DOM bytes（500 updates 后） | 11937 B | 有界渲染生效（≤200KB 上限）|

## 响应式矩阵（B34）

同一用例在四个分辨率下断言 Composer / Send-Stop / 管理页可用、中心工作区不消失：

```text
RESPONSIVE_1280x720=PASS     （Inspector 自动收起，中心区保留）
RESPONSIVE_1366x768=PASS
RESPONSIVE_1920x1080=PASS
RESPONSIVE_2560x1440=PASS
```

## 有界渲染契约（防止 DOM 无限增长）

```text
Terminal DOM   ≤ 200 KB（超出从头部丢弃，backend 保留完整输出）
Timeline       ≤ 1000 条
Action cards   ≤ 500
Problems       分页/有界
Runs           分页
事件去重       eventId bounded LRU（5000 / TTL 10min）
```

## 复现与回归

```powershell
npx playwright test test/e2e/perf.spec.js --workers=1 --reporter=list
```

数值会随硬件波动；本文记录的是**方法与一次真实采样**，回归判断以「有界渲染不失效、
关键交互无数量级劣化」为准，而非逐毫秒对齐。
