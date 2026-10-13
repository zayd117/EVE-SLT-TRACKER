#!/usr/bin/env node
// Targeted mutation checks for Lion King direct UUT API resolution. Every mutant is a trusted local copy
// of the real userscript; neither the checkout nor dependency files are edited.
// Run: node tests/lionking-testview.mutation.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'EVE_SLT_JBOG_TRACKER.user.js');
const SUITE = path.join(ROOT, 'tests', 'lionking-testview.test.mjs');
const original = readFileSync(SCRIPT, 'utf8');
const MUTANTS = [
  {
    "name": "UUT direct lookup accidentally uses the SLT API",
    "selectedTests": [
      "direct lookup validates the exact historical Started run through list and by-id APIs"
    ],
    "from": "      const query = async (latest, page) => {\n        const url = new URL(LION_TESTVIEW_API_PATH, TESTVIEW_LIST_URL);",
    "to": "      const query = async (latest, page) => {\n        const url = new URL('/api/v1/server_level_tests/view', TESTVIEW_LIST_URL);"
  },
  {
    "name": "UUT API chooses a newer attempt without matching Started",
    "selectedTests": [
      "direct lookup validates the exact historical Started run through list and by-id APIs"
    ],
    "from": "          (wantStarted === null || lionStartedAt(row.started.trim()) === wantStarted));",
    "to": "          true);"
  },
  {
    "name": "UUT by-id response is trusted without identity validation",
    "selectedTests": [
      "API identity or unknown schema cannot return an unverified detail"
    ],
    "from": "      const matches = lionTestViewAPIRecords(body).filter(record =>\n        String(record.id) === runId && lionTestViewAPIRun(record, sn, wantedOperation) &&\n        lionStartedAt(record.started.trim()) === wantStarted);",
    "to": "      const matches = lionTestViewAPIRecords(body).slice(0, 1);"
  },
  {
    "name": "UUT operation check ignores PRETEST versus full test",
    "selectedTests": [
      "PRETEST alias resolves its own operation and cannot open the full test"
    ],
    "from": "      record.operation.trim().toUpperCase() === wantedOperation &&",
    "to": "      true &&"
  }
];

function run(args, sourcePath) {
  const processGroup = process.platform !== 'win32';
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, EVE_SCRIPT: sourcePath },
    encoding: 'utf8',
    detached: processGroup,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  // On timeout, Node's direct child may leave browser/test descendants behind.
  // A separate process group lets us terminate only this run's descendants.
  if (processGroup && result.pid > 0 && (result.error || result.signal)) {
    try { process.kill(-result.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return result;
}

function counts(result) {
  const value = key => {
    const match = result.stdout?.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { tests: value('tests'), passed: value('pass'), failed: value('fail'),
    cancelled: value('cancelled'), skipped: value('skipped'), todo: value('todo') };
}

function details(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `terminated by ${result.signal}`;
  const failures = (result.stdout?.match(/^not ok \d+ - .*/gm) || []).slice(0, 2);
  if (failures.length) return failures.join(' | ');
  return (result.stderr || result.stdout || `exit status ${result.status}`).trim().slice(-1600);
}

function tested(result, summary, expectedSkipped = 0) {
  return !result.error && !result.signal &&
    !/^\s+failureType: ['"](?:hookFailed|testTimeoutFailure|cancelledByParent)['"]$/m.test(result.stdout || '') &&
    (result.status === 0 || result.status === 1) &&
    Number.isInteger(summary.tests) && summary.tests > 0 &&
    Number.isInteger(summary.passed) && Number.isInteger(summary.failed) &&
    summary.passed + summary.failed + expectedSkipped === summary.tests &&
    summary.skipped === expectedSkipped && summary.todo === 0 && summary.cancelled === 0;
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) {
    count += 1;
    at += needle.length;
  }
  return count;
}

const directory = mkdtempSync(path.join(tmpdir(), 'eve-lion-uut-mutant-'));
let baselinePassed = false;
let killed = 0;
let survived = 0;
let notTested = 0;
try {
  // Baseline and mutants use the same immutable source snapshot, even if an
  // editor saves another change in the checkout while this runner is active.
  const baselineFile = path.join(directory, 'baseline.user.js');
  writeFileSync(baselineFile, original, { mode: 0o600 });
  const baseline = run(['--test', '--test-reporter=tap', '--test-concurrency=1', SUITE], baselineFile);
  const baselineCounts = counts(baseline);
  if (!tested(baseline, baselineCounts) || baseline.status !== 0 || baselineCounts.failed !== 0) {
    notTested = MUTANTS.length;
    console.error(`BASELINE FAILED: ${baselineCounts.passed}/${baselineCounts.tests} passed, ${baselineCounts.failed} failed (exit ${baseline.status}): ${details(baseline)}`);
    console.error('No mutants executed.');
  } else {
    baselinePassed = true;
    console.log(`BASELINE PASSED: ${baselineCounts.passed}/${baselineCounts.tests} tests (exit ${baseline.status})`);
    const selectionBaselines = new Map();
    for (const [index, mutant] of MUTANTS.entries()) {
      const found = occurrences(original, mutant.from);
      if (found !== 1) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: expected one source anchor, found ${found}`);
        continue;
      }
      const file = path.join(directory, `${index + 1}.user.js`);
      writeFileSync(file, original.replace(mutant.from, mutant.to), { mode: 0o600 });
      const syntax = run(['--check', file], file);
      if (syntax.error || syntax.signal || syntax.status !== 0) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: invalid mutant syntax: ${details(syntax)}`);
        continue;
      }
      const pattern = mutant.selectedTests ? '^(' + mutant.selectedTests
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$' : '';
      const extraArgs = pattern ? ['--test-name-pattern=' + pattern] : [];
      if (pattern && !selectionBaselines.has(pattern)) {
        const selected = run(['--test', '--test-reporter=tap', '--test-concurrency=1', ...extraArgs, SUITE], baselineFile);
        const selectedCounts = counts(selected);
        // Node versions either omit nonmatching tests from TAP, or report
        // them as skipped. Compare each mutant with this exact selection.
        const passed = tested(selected, selectedCounts, selectedCounts.skipped) && selected.status === 0 &&
          selectedCounts.failed === 0 && selectedCounts.passed >= mutant.selectedTests.length;
        selectionBaselines.set(pattern, passed ? selectedCounts : null);
        console.log(`SELECTED BASELINE ${passed ? 'PASSED' : 'FAILED'}: ${selectedCounts.passed} executed, ` +
          `${baselineCounts.tests - selectedCounts.tests} deliberately omitted, ` +
          `${selectedCounts.skipped} TAP-skipped (exit ${selected.status}); ` +
          `matching UUT behavior selected explicitly${passed ? '' : ': ' + details(selected)}`);
      }
      if (pattern && !selectionBaselines.get(pattern)) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: the identical selected original baseline did not pass`);
        continue;
      }
      const expectedCounts = pattern ? selectionBaselines.get(pattern) : baselineCounts;
      const expectedSkipped = expectedCounts.skipped;
      const result = run(['--test', '--test-reporter=tap', '--test-concurrency=1', ...extraArgs, SUITE], file);
      const summary = counts(result);
      const skippedNote = pattern ? `; ${summary.passed + summary.failed} executed, ` +
        `${baselineCounts.tests - expectedCounts.tests} deliberately omitted for targeted UUT coverage, ` +
        `${summary.skipped} TAP-skipped` : '';
      if (!tested(result, summary, expectedSkipped) || summary.tests !== expectedCounts.tests ||
          (result.status === 1 && summary.failed === 0) ||
          (result.status === 0 && summary.failed !== 0)) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: ${summary.passed}/${summary.tests} passed, ${summary.failed} failed (exit ${result.status}${skippedNote}); no conclusive test result: ${details(result)}`);
      } else if (result.status === 0) {
        survived += 1;
        console.log(`SURVIVED ${mutant.name}: ${summary.passed}/${summary.tests} tests passed (exit ${result.status}${skippedNote})`);
      } else {
        killed += 1;
        console.log(`KILLED ${mutant.name}: ${summary.failed}/${summary.tests} tests failed (exit ${result.status}${skippedNote}) <- ${details(result)}`);
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${killed} killed, ${survived} survived, ${notTested} not tested (${MUTANTS.length} total)`);
process.exitCode = !baselinePassed || survived || notTested || !MUTANTS.length ? 1 : 0;
