'use strict';
/**
 * v2.5.0 External Config Import — JSON File Importer。
 *
 * §31：复用现有 json parser，不重新写一套解析器。
 * §29：用户主动选择文件。
 */

const { createExternalSource } = require('../externalSource');
const { readFileSyncSafe } = require('../security/pathPolicy');
const { parse: parseJsonText } = require('../../parsers/json');

const ID = 'json-file';
const NAME = 'JSON 文件';
const DESCRIPTION = '从用户选择的 JSON 文件导入 API 配置';

function discover() {
  const src = createExternalSource(ID);
  src.sourceName = NAME;
  src.exists = false;
  src.errors.push('请通过「选择文件」按钮选择 JSON 文件');
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
  src.configType = 'json';

  // §31：复用现有 json parser，支持对象或数组
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    src.errors.push(`JSON 解析失败：${e.message}`);
    return { source: src, candidates, warnings };
  }

  if (Array.isArray(obj)) {
    // 批量
    for (const item of obj) {
      if (item && typeof item === 'object') {
        const c = parseJsonText(JSON.stringify(item));
        if (c) {
          c.source.type = 'json-file';
          c.source.parser = ID;
          c.source.path = opts.filePath;
          c.source.confidence = 0.9;
          c.source.rawLength = text.length;
          candidates.push(c);
        }
      }
    }
  } else if (obj && typeof obj === 'object') {
    const c = parseJsonText(text);
    if (c) {
      c.source.type = 'json-file';
      c.source.parser = ID;
      c.source.path = opts.filePath;
      c.source.confidence = 0.92;
      c.source.rawLength = text.length;
      candidates.push(c);
    }
  }

  if (!candidates.length) {
    src.warnings.push({ type: 'parse_warning', message: 'JSON 文件中未发现可识别的 API 配置' });
  }

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
