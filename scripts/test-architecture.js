'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SIGNATURE_PATTERNS, EXECUTION_PATH_POLICY, classify, runAdversarialProof, runPositiveControls } = require('./executionPathPolicy');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('docs/ARCHITECTURE_MANIFEST.json'));
const pkg = JSON.parse(read('package.json'));

function walk(dir) {
  const absolute = path.join(root, dir);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const item = path.join(dir, entry.name).replace(/\\/g, '/');
    return entry.isDirectory() ? walk(item) : [item];
  });
}

const sourceFiles = walk('src').filter(file => file.endsWith('.js'));
const source = new Map(sourceFiles.map(file => [file, read(file)]));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

check(manifest.schemaVersion === 1, 'architecture manifest schemaVersion must be 1');
check(manifest.frozenAtVersion === '2.9.7', 'frozenAtVersion must be 2.9.7');
check(manifest.executionPathPolicyVersion === 1, 'executionPathPolicyVersion must be 1 (fail-closed path policy)');
check(manifest.currentPackageVersion === pkg.version, 'manifest/package version mismatch');
for (const [name, state] of Object.entries(manifest.frameworks)) {
  check(state === 'frozen', `framework ${name} is not frozen`);
}
for (const file of Object.values(manifest.canonicalModules)) {
  check(fs.existsSync(path.join(root, file)), `canonical module missing: ${file}`);
}

const generatorSource = sourceFiles.filter(file => file.startsWith('src/generator/')).map(file => source.get(file)).join('\n');
check(!/agentHub|agents\/hub\/agentHub|\.start\s*\(/.test(generatorSource), 'Generator must not execute through AgentHub');

const skillSource = sourceFiles.filter(file => file.startsWith('src/skills/')).map(file => source.get(file)).join('\n');
check(!/\.grant\s*\(|new\s+PermissionEngine/.test(skillSource), 'Skill Engine must not grant permission');

const hookSource = sourceFiles.filter(file => file.startsWith('src/hooks/')).map(file => source.get(file)).join('\n');
check(!/\.grant\s*\(|new\s+PermissionEngine/.test(hookSource), 'Hook Engine must not grant permission');

const workflowSource = sourceFiles.filter(file => file.startsWith('src/workflows/')).map(file => source.get(file)).join('\n');
check(!/streamResponse\s*\(|require\([^)]*providers|getProvider\s*\(/.test(workflowSource), 'Workflow must not call providers directly');
check(/agent\/runtime\/actionExecutor/.test(workflowSource), 'Workflow tool steps must use the shared action executor');

const routerDefinitions = sourceFiles.filter(file => /function\s+createModelRouter\s*\(/.test(source.get(file)));
check(routerDefinitions.length === 1 && routerDefinitions[0] === 'src/models/router/modelRouter.js', 'duplicate Model Router implementation');

const actionExecutor = read('src/agent/runtime/actionExecutor.js');
check(/permissionEngine\.evaluate/.test(actionExecutor), 'shared Tool executor lacks PermissionEngine gate');
check(/pathSecurity/.test(read('src/tools/filesystem.js')) && /pathSecurity/.test(read('src/tools/patch.js')), 'filesystem Tool providers lack PathSecurity gate');

const mainRuntime = read('src/agent/runtime/mainAgentRuntime.js');
const dynamicFactory = read('src/agents/dynamic/agentFactory.js');
check(/getSkillRuntime|skillRegistry/.test(mainRuntime) && /getSkillRuntime|skillResolver/.test(dynamicFactory), 'Main/Dynamic must share Skill Engine');
check(/getHookRuntime|hookEngine/.test(mainRuntime) && /getHookRuntime|hookEngine/.test(dynamicFactory), 'Main/Dynamic must share Hook Engine');

const freezeDoc = read('docs/ARCHITECTURE_FREEZE.md');
for (const phrase of manifest.requiredContractPhrases) {
  check(freezeDoc.includes(phrase), `frozen contract is undocumented: ${phrase}`);
}

// v2.9.7 Final Closure — fail-closed execution path classification.
// Every monitored signature occurrence is classified against the explicit
// EXECUTION_PATH_POLICY allowlist; unknown src/** production paths are
// UNSAFE_DUPLICATE by default (DEFAULT DENY, never DEFAULT CANONICAL).
for (const [name] of SIGNATURE_PATTERNS) {
  check(EXECUTION_PATH_POLICY[name], `execution path policy missing for ${name}`);
}
const inventory = {};
for (const [name, pattern] of SIGNATURE_PATTERNS) {
  inventory[name] = { CANONICAL: 0, LEGACY_COMPATIBILITY: 0, TEST_ONLY: 0, UNSAFE_DUPLICATE: 0 };
  for (const file of [...sourceFiles, ...walk('test').filter(item => item.endsWith('.js')), ...walk('scripts').filter(item => item.endsWith('.js'))]) {
    const text = file.startsWith('src/') ? source.get(file) : read(file);
    const count = (text.match(pattern) || []).length;
    if (!count) continue;
    const classification = classify(name, file);
    if (!classification) {
      failures.push(`${name} occurrence in unclassified path: ${file}`);
      continue;
    }
    if (classification === 'UNSAFE_DUPLICATE') {
      failures.push(`${name} in unknown production path: ${file} (fail-closed default deny)`);
    }
    inventory[name][classification] += count;
  }
}
const unsafeDuplicates = Object.values(inventory).reduce((sum, counts) => sum + counts.UNSAFE_DUPLICATE, 0);
check(unsafeDuplicates === 0, `${unsafeDuplicates} unsafe duplicate call(s) in unknown production paths`);

// Self-adversarial proof: the classifier itself must be fail-closed. Synthetic
// unknown production paths never touch the real repository tree.
const adversarial = runAdversarialProof();
for (const item of adversarial.results) {
  check(item.blocked, `synthetic unknown production path not blocked: ${item.signature} @ ${item.filePath} -> ${item.classification}`);
}
const positiveControls = runPositiveControls();
for (const item of positiveControls.results) {
  check(item.actual === item.expected, `policy control mismatch: ${item.signature} @ ${item.filePath} expected ${item.expected} got ${item.actual}`);
}

if (failures.length) {
  console.error('ARCHITECTURE_GATE FAILED');
  failures.forEach(item => console.error('- ' + item));
  process.exit(1);
}
console.log('ARCHITECTURE_GATE PASS');
console.log('Architecture policy mode:');
console.log('DEFAULT_DENY');
console.log('Architecture current unsafe duplicates:');
console.log(String(unsafeDuplicates));
console.log('Synthetic unknown production paths:');
console.log(adversarial.allBlocked ? 'ALL BLOCKED' : 'NOT ALL BLOCKED');
console.log(JSON.stringify(inventory, null, 2));
