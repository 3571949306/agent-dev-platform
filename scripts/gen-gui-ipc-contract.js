'use strict';
/**
 * v2.9.9 Phase B Final（B38）— 生成 docs/GUI_IPC_CONTRACT.md。
 *
 * 从 public/js/api.js 提取 Renderer 实际使用的全部 IPC 通道，按
 * READ / WRITE / RUN / CANCEL / APPROVE / DANGEROUS / SYSTEM 分类，
 * 并为每条通道标注 direction / authority owner / side effects / secret exposure。
 *
 * 生成结果只反映真实代码（单一真源），不手写虚构通道。
 * 用法：node scripts/gen-gui-ipc-contract.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const apiSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'api.js'), 'utf8');

const channels = [];
const seen = new Set();
const re = /call\('([^']+)'/g;
let m;
while ((m = re.exec(apiSource)) !== null) {
  if (!seen.has(m[1])) { seen.add(m[1]); channels.push(m[1]); }
}

function classify(ch) {
  if (/^(system:|dialog:|shell:)/.test(ch)) return 'SYSTEM';
  if (/permission-response|:approve$|:reject$/.test(ch)) return 'APPROVE';
  if (/(:cancel|:stop)$/.test(ch)) return 'CANCEL';
  if (/^terminal:run$|:run$|agent:send|mainAgent:run|:generate$|probe|diagnostics:capabilities|diagnostics:selfTest|computer:(screenshot|focus|windows)$|terminal:riskCheck/.test(ch)) return 'RUN';
  if (/(:create|:update|:remove|:set|:setDefault|:addModel|:setModelFavorite|:import|:importBatch|:complete|:dismiss)$|files:(create|createDir|rename|delete)/.test(ch)) return 'WRITE';
  if (/files:delete/.test(ch)) return 'DANGEROUS';
  return 'READ';
}

// 覆盖规则：特定通道按更高权限类别标注
const OVERRIDE = {
  'files:delete': 'DANGEROUS',
  'terminal:run': 'DANGEROUS', // 高风险命令需 confirmDangerous 显式确认（B19.6）
  'projects:remove': 'WRITE',
  'connections:remove': 'WRITE'
};

const AUTHORITY = {
  READ: '对应 backend store / service（只读投影，Renderer 无权威）',
  WRITE: '对应 backend store（main 进程独占写；Renderer 只提交意图）',
  RUN: 'Main Agent Runtime / Provider / Terminal Runtime（唯一执行真源）',
  CANCEL: 'RunManager / TerminalManager / Workflow Runtime（终止真源）',
  APPROVE: 'PermissionEngine / Workflow Runtime（裁决真源；过期请求不可批准）',
  DANGEROUS: 'PermissionEngine / 危险命令规则（fail-closed；Renderer 绝不绕过）',
  SYSTEM: 'Electron main（对话框/外壳；不含业务权威）'
};
const SIDE_EFFECTS = {
  READ: '无（只读投影）',
  WRITE: '持久化写入本地 SQLite（better-sqlite3）',
  RUN: '可能发起模型调用 / 子进程 / 文件读写（按权限裁决）',
  CANCEL: '终止活动 Run / 进程树（taskkill /t /f 或 kill(-pid)）',
  APPROVE: '推进或阻断等待中的权限/审批决策',
  DANGEROUS: '破坏性操作（删除文件 / 高风险命令），需显式确认',
  SYSTEM: '打开对话框 / 外部链接'
};
const SECRET = {
  READ: 'connections 只回掩码（api_key_masked / header 掩码）；解密值绝不跨 IPC',
  WRITE: 'API Key / Header 值写入即 DPAPI 加密；回包只含掩码投影',
  RUN: 'provider 调用在 main 进程解密使用密钥；Renderer 永远拿不到明文',
  CANCEL: '无密钥暴露',
  APPROVE: '无密钥暴露',
  DANGEROUS: '无密钥暴露',
  SYSTEM: '无密钥暴露'
};

const byClass = { READ: [], WRITE: [], RUN: [], CANCEL: [], APPROVE: [], DANGEROUS: [], SYSTEM: [] };
for (const ch of channels) {
  const cls = OVERRIDE[ch] || classify(ch);
  byClass[cls].push(ch);
}

let out = `# GUI IPC Contract（v2.9.9 Phase B Final · B38）

> 本文件由 \`scripts/gen-gui-ipc-contract.js\` 从 \`public/js/api.js\` 真实代码生成。
> Renderer（public/js）是 presentation + user intent 层：不持有执行/授权/密钥权威。
> 一切权威在 main 进程：唯一执行真源、唯一权限真源（PermissionEngine）、
> 唯一模型路由真源（Model Router）、唯一终端真源、唯一密钥边界（DPAPI）。

共 ${channels.length} 条 Renderer 使用的 IPC 通道。

| 分类 | 语义 | 通道数 |
|---|---|---|
${Object.keys(byClass).map(k => `| ${k} | ${AUTHORITY[k].split('（')[0]} | ${byClass[k].length} |`).join('\n')}

`;

for (const cls of Object.keys(byClass)) {
  if (!byClass[cls].length) continue;
  out += `## ${cls}\n\n`;
  out += `- authority owner：${AUTHORITY[cls]}\n`;
  out += `- side effects：${SIDE_EFFECTS[cls]}\n`;
  out += `- secret exposure：${SECRET[cls]}\n\n`;
  out += '| channel | direction |\n|---|---|\n';
  for (const ch of byClass[cls].sort()) {
    out += `| \`${ch}\` | renderer → main（invoke/handle，请求-响应） |\n`;
  }
  out += '\n';
}

out += `## 静态边界（机器验证）

\`test/guiContract.test.js\` 每次测试运行都会扫描 \`public/js/*.js\`：

- 禁止 \`require('fs')\` / \`require('child_process')\` / \`better-sqlite3\` / 直接 DB；
- 禁止引入 \`PermissionEngine\` 或任何第二套权限/执行权威；
- 禁止 \`eval\` / \`new Function\`；
- 禁止把 API Key / Authorization / Cookie / 解密后的自定义 Header 存入 localStorage 或渲染到 DOM；
- Renderer 使用的每个通道必须在 main 端真实注册（无孤儿通道）。

违反任一条 → GUI_BOUNDARY=FAIL，发布门禁阻断。
`;

fs.writeFileSync(path.join(ROOT, 'docs', 'GUI_IPC_CONTRACT.md'), out, 'utf8');
console.log(`GUI_IPC_CONTRACT_CHANNELS=${channels.length}`);
console.log('GUI_IPC_CONTRACT_GENERATED=PASS');
