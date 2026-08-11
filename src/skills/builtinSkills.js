'use strict';
/**
 * v2.9.3 Skill Engine — built-in example Skills.
 *
 * The goal is to prove the framework, not to fill a content library: exactly
 * three small, safe, read-first capability packs. Each one only REQUIRES
 * capabilities — none of them grants anything.
 */

const BUILTIN_SKILLS = [
  {
    id: 'readonly-code-review',
    name: 'Read-only Code Review',
    description: '审查代码差异并返回发现的问题；不修改任何文件。',
    instructions: [
      'Act as a strict read-only code reviewer.',
      'Inspect the requested files and the current diff only.',
      'Report concrete findings (severity, file, line, reason).',
      'Do not modify, create, or delete any file. Never run mutation commands.'
    ].join('\n'),
    tags: ['review', 'readonly'],
    toolRequirements: {
      required: ['read_file', 'search'],
      optional: ['git_diff'],
      denied: ['write_file', 'create_file', 'delete_file', 'apply_patch', 'move_file', 'copy_file']
    },
    permissionRequirements: { required: ['filesystem.read'] },
    modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  },
  {
    id: 'test-analysis',
    name: 'Test Analysis',
    description: '分析测试失败日志、定位根因并提出修复方向。',
    instructions: [
      'Act as a test analyst.',
      'Read the failing test output, the related source and test files.',
      'Identify the root cause and the minimal fix direction.',
      'Do not claim a test passed unless you actually observed it.'
    ].join('\n'),
    tags: ['testing', 'analysis'],
    toolRequirements: {
      required: ['read_file', 'search'],
      optional: ['terminal_run'],
      denied: []
    },
    permissionRequirements: { required: ['filesystem.read'] },
    modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  },
  {
    id: 'security-review',
    name: 'Security Review',
    description: '检查凭据泄漏、权限边界与危险操作；只读，不产生任何写入。',
    instructions: [
      'Act as a security reviewer.',
      'Scan the target code for credential leakage, unsafe paths, and permission bypasses.',
      'Report findings with severity and concrete locations.',
      'Never request, reveal, or persist credentials. Never write outside the workspace.'
    ].join('\n'),
    tags: ['security', 'review', 'readonly'],
    toolRequirements: {
      required: ['read_file', 'search'],
      optional: ['git_diff'],
      denied: ['write_file', 'create_file', 'delete_file', 'apply_patch', 'move_file', 'copy_file']
    },
    permissionRequirements: { required: ['filesystem.read'] },
    modelRequirements: { required: { text: true } },
    compatibility: { agentTypes: ['native'], platforms: ['windows'], projectSignals: [] },
    metadata: {}
  }
];

module.exports = { BUILTIN_SKILLS };
