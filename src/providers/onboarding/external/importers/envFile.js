'use strict';
/**
 * v2.5.0 External Config Import — .env File Importer。
 *
 * §29/§30/§31：用户主动选择文件，不能扫描整个项目或 C:\。
 * §31：复用现有 env parser，不重新写一套解析器。
 */

const { createExternalSource } = require('../externalSource');
const { readFileSyncSafe } = require('../security/pathPolicy');
const { parse: parseEnvText } = require('../../parsers/env');

const ID = 'env-file';
const NAME = '.env 文件';
const DESCRIPTION = '从用户选择的 .env 文件导入 API 配置';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  // §29：.env 文件不支持自动发现，必须用户主动选择
  src.exists = false;
  src.errors.push('请通过「选择文件」按钮选择 .env 文件');
  return src;
}

function parse(opts = {}) {
  const src = discover();
  const candidates = [];
  const warnings = [];

  if (!opts.filePath) {
    src.errors.push('未选择文件');
    return { source: src, candidates, warnings };
  }

  // §55：用户主动选择，userSelected=true
  const policy = { sourceType: null, userSelected: true };
  let text;
  try {
    text = readFileSyncSafe(opts.filePath, policy);
  } catch (e) {
    src.errors.push(`读取失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  src.exists = true;
  src.readable = true;
  src.sourcePath = opts.filePath;
  src.configType = 'env';

  // §31：复用现有 env parser
  const c = parseEnvText(text);
  if (!c) {
    src.warnings.push({ type: 'parse_warning', message: '.env 文件中未发现可识别的 API 配置' });
    return { source: src, candidates, warnings };
  }

  // 覆盖 source.type 为 env-file
  c.source.type = 'env-file';
  c.source.parser = ID;
  c.source.path = opts.filePath;
  c.source.confidence = 0.92;
  c.source.rawLength = text.length;

  candidates.push(c);
  src.candidates = candidates;
  return { source: src, candidates, warnings };
}

module.exports = {
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  supportedPlatforms: ['win32', 'darwin', 'linux'],
  requiresFile: true,
  supportsDiscovery: false,
  discover,
  parse
};
