// i18n — 轻量中文显示层
// 内部 IPC channel / Tool ID / Event ID / 数据库字段保持英文不变。
// 这里只负责把用户可见的 Display Layer 统一中文化。

export const ZH = {
  // 顶部导航
  nav: {
    dashboard: '总览',
    connections: 'API 连接',
    agents: '智能体',
    mcp: 'MCP',
    diagnostics: '能力诊断',
    settings: '设置',
  },
  // 左侧栏
  left: {
    chats: '对话',
    files: '文件',
  },
  // 右侧栏
  right: {
    agents: '智能体',
    tasks: '任务',
  },
  // 底部面板
  bottom: {
    terminal: '终端',
    diff: '文件更改',
    problems: '问题',
    tasks: '任务',
    timeline: '时间线',
    computer: '电脑控制',
    logs: '日志',
    usage: '用量',
  },
  // v2.6.0 Main Agent 状态机
  mainAgentState: {
    IDLE: '空闲',
    PLANNING: '规划中',
    READING_CONTEXT: '读取上下文',
    EXECUTING: '执行中',
    WAITING_TOOL: '等待工具',
    TESTING: '测试中',
    EVALUATING: '评估中',
    REPAIRING: '修复中',
    WAITING_PERMISSION: '等待权限',
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    TIMEOUT: '超时',
  },
  // v2.6.0 Main Agent 事件
  mainAgentEvent: {
    'mainAgent:runStarted': '运行开始',
    'mainAgent:stateChanged': '状态变更',
    'mainAgent:planCreated': '计划已创建',
    'mainAgent:taskUpdated': '任务更新',
    'mainAgent:action': '执行动作',
    'mainAgent:toolResult': '工具结果',
    'mainAgent:testResult': '测试结果',
    'mainAgent:repairStart': '开始修复',
    'mainAgent:fileChanged': '文件已修改',
    'mainAgent:checkpoint': '检查点',
    'mainAgent:permission': '权限请求',
    'mainAgent:timeline': '时间线',
    'mainAgent:assistantText': '智能体输出',
    'mainAgent:runCompleted': '运行完成',
    'mainAgent:runFailed': '运行失败',
    'mainAgent:runCancelled': '运行已取消',
    'mainAgent:runTimeout': '运行超时',
  },
  // v2.6.0 Main Agent Action 类型
  mainAgentAction: {
    read_file: '读取文件',
    read_file_range: '读取文件片段',
    list_directory: '查看目录',
    search_files: '搜索文件',
    search_text: '搜索代码',
    apply_patch: '修改代码',
    create_file: '创建文件',
    write_file: '写入文件',
    delete_file: '删除文件',
    move_file: '移动文件',
    run_command: '运行命令',
    git_status: '查看 Git 状态',
    git_diff: '查看 Git 更改',
    git_log: '查看 Git 历史',
    git_add: '暂存更改',
    git_commit: 'Git 提交',
    finish: '完成任务',
    delegate: '委派子智能体',
    checkpoint: '创建检查点',
  },
  // 状态
  status: {
    ready: '就绪',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    timeout: '超时',
    interrupted: '已中断',
    preparing: '准备中',
    streaming: '正在生成',
    requesting_model: '正在请求模型',
    executing_tool: '正在执行工具',
    waiting_permission: '等待权限',
    waiting_subagent: '等待子智能体',
    waiting_external_agent: '等待外部智能体',
    testing: '正在测试',
    stopped: '已停止',
    queued: '排队中',
    max_steps: '已达步数上限',
  },
  // 按钮
  btn: {
    stop: '停止',
    retry: '重试',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    edit: '编辑',
    add: '添加',
    refresh: '刷新',
    test: '测试',
    run: '运行',
    open: '打开',
    close: '关闭',
    copy: '复制',
    send: '发送',
    newchat: '新建对话',
  },
  // Run 状态中文
  run: {
    preparing: '准备中',
    requesting_model: '正在请求模型',
    streaming: '正在生成',
    executing_tool: '正在执行工具',
    waiting_permission: '等待权限确认',
    waiting_subagent: '等待子智能体',
    waiting_external_agent: '等待外部智能体',
    testing: '正在测试',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    timeout: '超时',
    interrupted: '已中断',
  },
  // Tool Display Names
  tool: {
    list_directory: '查看目录',
    read_file: '读取文件',
    read_file_range: '读取文件片段',
    create_file: '创建文件',
    write_file: '写入文件',
    move_file: '移动文件',
    copy_file: '复制文件',
    delete_file: '删除文件',
    file_exists: '检查文件',
    get_file_metadata: '查看文件信息',
    search_files: '搜索文件',
    search_text: '搜索代码',
    search_symbols: '搜索符号',
    apply_patch: '修改代码',
    terminal_run: '运行命令',
    terminal_cancel: '停止命令',
    terminal_status: '查看命令状态',
    git_status: '查看 Git 状态',
    git_diff: '查看 Git 更改',
    git_log: '查看 Git 历史',
    git_show: '查看 Git 内容',
    git_branch: '查看 Git 分支',
    git_add: '暂存更改',
    git_commit: 'Git 提交',
    checkpoint_create: '创建检查点',
    checkpoint_restore: '恢复检查点',
    browser_launch: '启动浏览器',
    browser_navigate: '打开网页',
    browser_click: '点击网页',
    browser_type: '输入网页内容',
    browser_screenshot: '网页截图',
    computer_list_windows: '查看窗口',
    computer_focus_window: '切换窗口',
    computer_screenshot: '屏幕截图',
    computer_screenshot_window: '窗口截图',
    computer_click_at: '点击屏幕',
    computer_get_ui_tree: '读取界面结构',
    send_message_to_chat: '向其他对话派发任务',
    list_project_chats: '查看项目对话',
    get_chat_summary: '查看对话摘要',
    get_chat_status: '查看委派状态',
  },
  // Event Display Names
  event: {
    assistant_status: '智能体状态',
    assistant_text: '模型输出',
    assistant_message: '智能体回复',
    tool_call: '调用工具',
    tool_result: '工具执行完成',
    subagent_start: '子智能体开始工作',
    subagent_result: '子智能体返回结果',
    file_changed: '文件已更改',
    terminal_start: '终端开始执行',
    terminal_output: '终端输出',
    terminal_exit: '终端执行完成',
    task_start: '任务开始',
    task_complete: '任务完成',
    task_cancelled: '任务已取消',
    permission_request: '权限请求',
    permission_expired: '权限请求已过期',
    'workflow:state': '工作流状态变更',
    'workflow:step': '工作流步骤变更',
    'workflow:approval': '工作流等待批准',
    error: '错误',
    diagnostics_progress: '诊断进度',
    run_state_changed: '运行状态变更',
    run_completed: '运行完成',
    run_failed: '运行失败',
    run_cancelled: '运行已取消',
    run_timeout: '运行超时',
    run_interrupted: '运行已中断',
  },
  // 模型来源（B15.6 真话词汇：REMOTE / MANUAL / FALLBACK / UNKNOWN）
  source: {
    remote: 'API 获取',
    manual: '手动添加',
    preset: '回退（内置推荐）',
    cached: '未知（本地缓存）',
  },
  // 能力
  cap: {
    text: '文本生成',
    streaming: '流式输出',
    tools: '工具调用',
    vision: '视觉 / 多模态',
  },
  // 错误信息
  err: {
    conn_refused: '无法连接到模型服务。',
    auth_failed: '身份验证失败，请检查 API Key。',
    aborted: '请求已取消。',
    timeout: '模型服务响应超时。',
    no_model: '主智能体尚未选择模型。',
    no_conn: '主智能体尚未配置 API 连接。',
    no_models_in_conn: '当前 API 连接尚未获取模型列表。',
    vision_required: 'WorkBuddy 的界面无法直接读取，需要配置支持图片输入的视觉模型。',
    ext_not_found: '未找到 WorkBuddy 窗口，请先启动 WorkBuddy。',
  },
  // Agent 类型
  agentType: {
    native: '编码',
    computer: '电脑操作',
    external: '外部',
  },
  // v2.9.9 Phase B（B41）— 新增产品区域中文词汇统一入口：
  // Verification / Permission / Workflow / Generator / External Agent。
  // 页面不得各写各的标签，一律从这里取。
  verification: {
    PASS: '验证通过',
    FAIL: '验证失败',
    NOT_AVAILABLE: '无验证配置',
    NOT_VERIFIED: '未验证',
    RUNNING: '验证中',
    UNKNOWN: '未知',
  },
  permissionDecision: {
    once: '仅本次允许',
    task: '本会话内允许',
    project: '本项目内始终允许',
    always: '始终允许',
    deny: '拒绝',
    expired: '已过期',
  },
  externalAvailability: {
    AVAILABLE: '可用',
    UNAVAILABLE: '不可用',
    UNKNOWN: '未知',
    ERROR: '出错',
  },
  // v2.9.9 Phase B Final（B15.1）— 连接状态词汇：只来自真实测试结果，未知就是未知
  connStatus: {
    AVAILABLE: '可用',
    UNAVAILABLE: '不可用',
    DEGRADED: '已降级',
    UNKNOWN: '未测试',
    ERROR: '测试异常',
    testing: '测试中',
  },
  // v2.9.9 Phase B Final（B15.1）— 认证模式：只描述存储形态，不代表凭据有效
  connAuthMode: {
    API_KEY: 'API Key',
    API_KEY_HEADERS: 'API Key + 请求头',
    CUSTOM_HEADERS: '自定义请求头',
    NO_AUTH: '无认证',
    UNKNOWN: '未知',
  },
};

/** 查找 Tool 的中文名，找不到时返回原始 ID */
export function toolName(rawId) {
  return ZH.tool[rawId] || rawId;
}

/** 查找 Event 的中文名（含 v2.6.0 Main Agent 事件） */
export function eventName(rawType) {
  if (ZH.event[rawType]) return ZH.event[rawType];
  if (ZH.mainAgentEvent[rawType]) return ZH.mainAgentEvent[rawType];
  return rawType;
}

/** 查找 Run 状态的中文名 */
export function runStatus(rawStatus) {
  return ZH.run[rawStatus] || rawStatus;
}

/** 查找模型来源的中文名 */
export function sourceName(src) {
  return ZH.source[src] || src || '';
}

/** v2.6.0 — Main Agent 状态中文名 */
export function mainAgentStateName(s) {
  return ZH.mainAgentState[s] || s || '';
}

/** v2.6.0 — Main Agent 事件中文名 */
export function mainAgentEventName(type) {
  return ZH.mainAgentEvent[type] || type || '';
}

/** v2.6.0 — Main Agent Action 中文名 */
export function mainAgentActionName(t) {
  return ZH.mainAgentAction[t] || t || '';
}

/** v2.6.0 — Main Agent 状态是否终态 */
export function isMainAgentTerminal(s) {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(s);
}

/** 终态判断 */
export function isTerminal(status) {
  return ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(status);
}

/** v2.9.9 Phase B（B41）— Verification 状态中文标签 */
export function verificationName(status) {
  return ZH.verification[String(status || '').toUpperCase()] || status || '—';
}

/** v2.9.9 Phase B（B41）— External Agent 可用性中文标签 */
export function availabilityName(status) {
  return ZH.externalAvailability[String(status || '').toUpperCase()] || status || '';
}
