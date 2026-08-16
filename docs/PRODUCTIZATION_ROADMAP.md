# Productization Roadmap

The frozen post-v2.9.7 order is:

1. P1 — Real Project Reliability — **COMPLETE (v2.9.8)**：R0-R8 全部 VERIFIED。Cancellation leaves nothing behind；two runs cannot corrupt one project（ProjectMutationLock 接入 Main Agent 生产链）；a real dirty project survives a complete fail→repair→pass coding task（ProductEntry 真实链 + 20/20 fresh-repo soak）。
2. P2 — Unified GUI / UX — **COMPLETE (v2.9.9)**：Phase B Final。PART A 增量审计（A1-A8）+ B15-B72 全部 VERIFIED：Connection Manager 3.0（密钥/Header 永掩码、状态真话词汇、默认连接=路由偏好）、Model Router Inspector（selected vs wire、explicit fail-closed、能力证据）、Skills/Hooks Workbench（仅受信 handler、零授权 UI）、Computer/Terminal Workspace 2.0（真实可用性/进程树 Cancel/Owner 真话）、Health Center（0 fake READY、自检 0 付费）、Problems Center（去重、dismiss≠resolved）、Recovery（0 replay、无 Resume）、页面状态契约、Composer 3.0（草稿持久化）、Onboarding 2.0、Boot 体验、响应式四分辨率、性能基线、GUI IPC 契约与静态边界、统一确认/Toast 策略/全局状态/徽标/UI 持久化白名单、E2E ≥150、产品场景 A-F、XSS/Secret/Electron 安全门禁。
3. P3 — Computer Use Production Hardening — **FROZEN (v2.9.9)**：C3 Target Fence 与 C7 action-point HWND+PID 收口；legacy/missing-authorizer/raw-coordinate/cross-session exec 均 0；PID mismatch、same-title retarget、focus theft、stale observation、clipboard cancel、desktop lock 各 20/20；Computer soak 100/100；DEFAULT_DENY + 0 unsafe duplicates；30 条 clean release 命令连续 0 failure；E2E 159/159；build PASS；最终残留全 0。Architecture `frozenAtVersion` 仍为 2.9.7。
4. P4 — External Agent Production Verification — **FROZEN (v2.9.9 FINAL CLOSURE)**：mutating completion 受独立 effect proof 约束；pending terminal 有唯一有界 finalizer；never-quiescent runtime 保留锁/slot 隔离；transport-aware verification、paid explicit-consent、Claude external-login UNKNOWN、WorkBuddy fresh response-only、Hub-only production、canonical env 与 UNKNOWN call-count truth 均已闭包。Production 229/229 + repeat 10/10；soak repeat 20/20；closure 13/13；P4 GUI 33/33；full E2E 192/192；DEFAULT_DENY、unsafe duplicate 0；默认真实外部任务/付费调用 0。Installed != Available；Available != Verified；Health != Verification；Protocol != Response；Response != Project Task。本状态冻结平台契约，不声称每台本机 Agent 已完成真实任务。Architecture `frozenAtVersion` 仍为 2.9.7。
5. P5 — Parallel Worktree Execution — **IN PROGRESS**（整体 NOT FROZEN，禁标 COMPLETE/FROZEN）
   - P5-A — Parallel Worktree Isolation Foundation — **IMPLEMENTED**
   - P5-A.1 — Worktree Truth & Permission Scope Closure — **VERIFIED**：真实 Git root identity（show-toplevel 唯一权威）、caller projectId 不作 storage/limit authority、cleanup ownership fail-closed、git status 失败≠CLEAN、force-remove 失败≠removed、原子 max=2 reservation、完整 snapshot diff truth（staged/unstaged/untracked/deleted/renamed/binary/committed，真实 index 不变）、NUL-safe 解析、dirty-base non-mutating snapshot（A/B 同一 base、用户 HEAD/index/status 零变异）、shared ProjectMutationLock 强制注入、worker authority isolation、BUSY cleanup deny、bounded cancel/quiescence、lock release in finally。对抗套件 28/28；权限 70/70；架构门 PASS；P3/P4 闭包无回归。PAID_PROVIDER_CALLS=0 / REAL_EXTERNAL_AGENT_CALLS=0。
   - P5-B — Parallel Agent Execution — **NOT STARTED**
   - P5-C — Integration / Conflict / Approval — **NOT STARTED**
6. P6 — Performance / Long Context / Memory Optimization
7. P7 — Security Hardening
8. P8 — Packaging / Update / Crash Recovery
9. P9 — Release Candidate
