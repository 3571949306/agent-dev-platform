'use strict';

/**
 * Portable payload smoke test (C12, §69-71).
 *
 * electron-builder's `portable` target is a 7-Zip self-extracting wrapper
 * (7zSD.sfx + 7z payload) around the real Electron app. Running the wrapper
 * and waiting for stdout is unreliable (§69: "不要等待 portable wrapper
 * stdout 300s") — the SFX module does not reliably forward the inner
 * process's stdout to the parent console.
 *
 * This script therefore tests the EXTRACTED PAYLOAD, not the wrapper launch:
 *   1. Resolve an external 7-Zip binary (PATH lookup, then common Windows
 *      install locations) and extract the portable.exe payload WITHOUT
 *      honoring the SFX RunProgram directive (we invoke `7z x` directly,
 *      not the wrapper).
 *   2. Launch the inner "Agent Dev Platform.exe" with `--smoke
 *      --smoke-result-file=<tempfile>` so the smoke outcome is communicated
 *      via a JSON file instead of stdout (§71).
 *   3. Read the result file and report PASS/FAIL.
 *
 * Usage:
 *   node scripts/portable-smoke.js --portable="path/to/Agent Dev Platform X.Y.Z portable.exe"
 *   node scripts/portable-smoke.js --portable=... --result-file=out.json
 *
 * Exit code: 0 = payload smoke passed, 1 = failed / missing / error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// matches build.productName in package.json — the inner Electron executable
// is named after it.
const PRODUCT_NAME = 'Agent Dev Platform';
const SMOKE_TIMEOUT_MS = 120000; // inner --smoke boots Electron + settles ~3s; 2min is plenty
const EXTRACTION_TIMEOUT_MS = 180000;

function parseArgs(argv) {
  const args = { portable: null, resultFile: null, help: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--portable=')) args.portable = a.slice('--portable='.length);
    else if (a.startsWith('--result-file=')) args.resultFile = a.slice('--result-file='.length);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/portable-smoke.js --portable=<path-to-portable.exe> [--result-file=<path>]\n' +
    '\n' +
    'Tests the EXTRACTED PAYLOAD of a portable.exe (not the wrapper launch, §69).\n' +
    '  --portable=<path>     Path to the portable.exe (7z SFX wrapper).\n' +
    '  --result-file=<path>  Optional. Where to keep the smoke result JSON.\n' +
    '                        Defaults to a temp file that is deleted after the run.\n'
  );
}

/**
 * Resolve a 7-Zip binary to a full executable path. We deliberately avoid
 * `shell: true` so argv with spaces (the portable path, the -o dir) stay
 * separated and never pass through a shell (same convention as
 * prepare-cline-runtime.js using tar.exe).
 *
 * Lookup order:
 *   1. `where 7z` / `which 7z`        (7-Zip installed and on PATH)
 *   2. `where 7za` / `which 7za`      (standalone 7za build)
 *   3. Common Windows install paths   (7-Zip's default installer location)
 */
function findSevenZip() {
  const isWin = process.platform === 'win32';
  const lookup = isWin ? 'where.exe' : 'which';

  for (const cmd of ['7z', '7za']) {
    const probe = spawnSync(lookup, [cmd], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
    if (probe.status === 0) {
      const resolved = (probe.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (resolved && fs.existsSync(resolved)) return resolved;
    }
  }

  // Fallback: 7-Zip's default installer layout. Useful on dev machines where
  // 7-Zip is installed but not added to PATH.
  if (isWin) {
    const candidates = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

function extractPortable(portablePath, extractDir, sevenZip) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  // `x` preserves the archive's directory layout; `-o<dir>` sets the output
  // directory (joined to the flag, no space); `-y` assumes yes to all
  // overwrites; `-bd` disables the progress bar so CI logs stay clean.
  // Critically, invoking `7z x` directly — NOT the SFX — means the 7zSD
  // RunProgram directive is never honored: we extract, we do not run.
  const r = spawnSync(sevenZip, ['x', portablePath, `-o${extractDir}`, '-y', '-bd'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: EXTRACTION_TIMEOUT_MS
  });
  if (r.error || r.status !== 0) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().slice(-2048);
    const reason = r.error ? r.error.message : `status=${r.status}`;
    throw new Error(`7z extraction failed (${reason}): ${tail}`);
  }
}

/**
 * Locate the real Electron executable inside the extracted payload. The inner
 * exe is named after build.productName ("Agent Dev Platform.exe"). We walk the
 * extracted tree rather than assuming a fixed depth — electron-builder lays
 * it at the root of the 7z payload, but be defensive against layout shifts.
 */
function findInnerExe(extractDir) {
  const target = `${PRODUCT_NAME}.exe`;
  const seen = new Set();
  function walk(dir) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const e of entries) {
      if (e.isFile() && e.name === target) return path.join(dir, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = walk(path.join(dir, e.name));
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(extractDir);
}

function runPayloadSmoke(innerExe, resultFile) {
  // --smoke-result-file lets the payload write its outcome as JSON, fully
  // sidestepping the SFX stdout-redirection problem (§71). We still capture
  // the child's stdout/stderr for diagnostics but do not gate on them — a
  // payload that boots fine yet emits nothing to stdout is the exact case
  // this file-based handshake exists to handle.
  return spawnSync(innerExe, ['--smoke', `--smoke-result-file=${resultFile}`], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: SMOKE_TIMEOUT_MS
  });
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }

  if (!args.portable) {
    process.stderr.write('PORTABLE_SMOKE_FAILED missing required --portable=<path>\n');
    usage();
    process.exitCode = 1;
    return;
  }

  const portablePath = path.resolve(args.portable);
  if (!fs.existsSync(portablePath) || !fs.statSync(portablePath).isFile()) {
    process.stderr.write('Portable exe not found: ' + portablePath + '\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`PORTABLE_SMOKE_START portable=${portablePath}\n`);
  // §69: the wrapper launch is observable in principle but NOT FULLY
  // AUTOMATABLE from this script — its stdout is not reliably forwarded by
  // the 7zSD SFX module. We deliberately do NOT launch the wrapper here; we
  // test the extracted payload only. This line is the explicit, auditable
  // acknowledgment of that boundary so release logs read correctly.
  process.stdout.write('Portable wrapper launch: NOT FULLY AUTOMATABLE (wrapper stdout unreliable, §69)\n');

  const sevenZip = findSevenZip();
  if (!sevenZip) {
    process.stderr.write(
      'PORTABLE_SMOKE_FAILED no 7-Zip binary found. Install 7-Zip (https://7-zip.org) ' +
      'or add 7z to PATH, then re-run. Extraction is required to test the payload.\n'
    );
    process.exitCode = 1;
    return;
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-portable-extract-'));
  // Use os.tmpdir() for the temp result file (spec requirement). If the caller
  // passed --result-file, we write there directly and leave it intact; if not,
  // we own a temp file and clean it up.
  const isUserResultFile = !!args.resultFile;
  const resultFile = path.resolve(
    args.resultFile || path.join(os.tmpdir(), `adp-portable-smoke-${process.pid}-${Date.now()}.json`)
  );

  try {
    process.stdout.write(`PORTABLE_EXTRACT_START 7z=${sevenZip} dir=${extractDir}\n`);
    extractPortable(portablePath, extractDir, sevenZip);
    process.stdout.write('PORTABLE_EXTRACT_OK\n');

    const innerExe = findInnerExe(extractDir);
    if (!innerExe) {
      throw new Error(`extracted payload did not contain "${PRODUCT_NAME}.exe"`);
    }
    process.stdout.write(`PORTABLE_PAYLOAD_FOUND exe=${innerExe}\n`);

    // Remove any stale result file so a non-emitting crash is detected as a
    // missing-file failure rather than a stale PASS from a prior run.
    fs.rmSync(resultFile, { force: true });

    process.stdout.write(`PORTABLE_PAYLOAD_SMOKE_START exe=${innerExe} resultFile=${resultFile}\n`);
    const child = runPayloadSmoke(innerExe, resultFile);

    // Surface whatever the child printed for diagnostics. May be empty — that
    // is precisely the §69 problem the file-result approach works around, so
    // an empty stdout here is not itself a failure signal.
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);

    if (child.error && !fs.existsSync(resultFile)) {
      // Spawn-level failure (exe missing, blocked, etc.) and no result written.
      throw new Error(`payload did not launch: ${child.error.message}`);
    }

    if (!fs.existsSync(resultFile)) {
      const reason = child.status === null ? 'timeout' : `exit=${child.status}`;
      throw new Error(`smoke result file not written (${reason}); payload did not complete the smoke run`);
    }

    let result;
    try {
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (e) {
      throw new Error(`failed to parse smoke result file: ${e.message}`);
    }

    if (result && result.ok === true) {
      process.stdout.write(
        'Portable extracted payload: SMOKE PASS' +
        ` smoke=${result.smoke || 'SMOKE_OK'}` +
        ` version=${result.version || 'unknown'}` +
        ` timestamp=${result.timestamp || 'n/a'}\n`
      );
      process.stdout.write('PORTABLE_SMOKE_OK\n');
      process.exitCode = 0;
    } else {
      process.stderr.write('Portable extracted payload: SMOKE FAIL\n');
      process.stderr.write(`PORTABLE_SMOKE_FAIL ${result ? (result.error || JSON.stringify(result)) : 'no result body'}\n`);
      process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write('Portable extracted payload: SMOKE FAIL\n');
    process.stderr.write(`PORTABLE_SMOKE_FAIL ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    // Always clean up the extracted payload (it can be hundreds of MB).
    // Only delete the result file when we own it (temp file); a caller-supplied
    // --result-file is left intact as the durable record of the outcome.
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (!isUserResultFile) {
      fs.rmSync(resultFile, { force: true });
    }
  }
}

main();
