#!/usr/bin/env node
// Follow-up regression mutations use immutable userscript copies and the real
// document-start/browser controls suites. The checkout is never rewritten.
// Run: node tests/lionking-controls.mutation.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = readFileSync(path.join(ROOT, 'EVE_SLT_JBOG_TRACKER.user.js'), 'utf8');
const MUTANTS = [
  {
    name: 'partial initial document is scanned and consumes the saved RUNNING baseline',
    suite: 'lionking-loading.test.mjs',
    selectedTests: ['an existing RUNNING baseline is preserved while a matching completed row arrives in the partial initial document'],
    from: "    if (!lionInitialDocumentComplete) {\n" +
      "      reportHealth('LOADING', 'Controls are ready. Waiting for the initial Lion King table; no partial results are recorded.', true);\n" +
      "      if (lionCachedSnapshot) showLionKingSnapshotCache();\n" +
      "      else setTextIfChanged(document.getElementById('lion-summary'), 'Loading the source table. Controls are available.');\n" +
      '      return;\n    }',
    to: '    // MUTANT: allow a partial parser-owned source to be scanned.'
  },
  {
    name: 'manual refresh fetches and replaces source during the initial document load',
    suite: 'lionking-loading.test.mjs',
    selectedTests: ['Lion King controls render while the 4,001-row document is parsing; only a completed document establishes a quiet baseline'],
    from: '  async function refreshLionKing() {\n    if (!lionInitialDocumentComplete) { scanLionKing(); return; }',
    to: '  async function refreshLionKing() {'
  },
  {
    name: 'conflicting tail and head area assignments incorrectly use the tail area',
    suite: 'lionking-controls.test.mjs',
    selectedTests: ['one known head assigns the pair, while conflicting tail and head assignments remain Unassigned'],
    from: "    if (known(tail) && known(head) && tail !== head) return 'unassigned';",
    to: "    if (known(tail) && known(head) && tail !== head) return tail;"
  },
  {
    name: 'disabled rows incorrectly lose completion detection and audit records',
    suite: 'lionking-controls.test.mjs',
    selectedTests: ['disabling a row hides its source and silences notifications while completion auditing continues'],
    from: "      if (prior && prior.status === 'RUNNING' && !prior.completed && terminal) {",
    to: "      if (prior && prior.status === 'RUNNING' && !prior.completed && terminal && lionAreaSettings(lionAreaForRow(row)).show) {"
  }
];

function run(args, sourcePath) {
  const processGroup = process.platform !== 'win32';
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, env: { ...process.env, EVE_SCRIPT: sourcePath }, encoding: 'utf8',
    detached: processGroup, timeout: 180000, maxBuffer: 8 * 1024 * 1024
  });
  // Terminate only this run's descendants if its test process times out.
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
  let total = 0;
  let at = 0;
  while ((at = haystack.indexOf(needle, at)) !== -1) { total += 1; at += needle.length; }
  return total;
}

const directory = mkdtempSync(path.join(tmpdir(), 'eve-lion-controls-mutant-'));
const fullBaselines = new Map();
let baselinePassed = true;
let killed = 0;
let survived = 0;
let notTested = 0;
try {
  const baselineFile = path.join(directory, 'baseline.user.js');
  writeFileSync(baselineFile, original, { mode: 0o600 });
  // Run complete unmodified suites first. A baseline failure cannot be
  // reported as a killed mutant, including browser/setup infrastructure errors.
  for (const suite of new Set(MUTANTS.map(mutant => mutant.suite))) {
    const suitePath = path.join(ROOT, 'tests', suite);
    const result = run(['--test', '--test-reporter=tap', '--test-concurrency=1', suitePath], baselineFile);
    const summary = counts(result);
    if (!tested(result, summary) || result.status !== 0 || summary.failed !== 0) {
      baselinePassed = false;
      console.error(`BASELINE FAILED ${suite}: ${summary.passed}/${summary.tests} passed (exit ${result.status}): ${details(result)}`);
      break;
    }
    fullBaselines.set(suite, summary);
    console.log(`BASELINE PASSED ${suite}: ${summary.passed}/${summary.tests} tests`);
  }
  if (!baselinePassed) {
    notTested = MUTANTS.length;
    console.error('No mutants executed.');
  } else {
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
      const pattern = '^(' + mutant.selectedTests
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$';
      const suitePath = path.join(ROOT, 'tests', mutant.suite);
      const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-name-pattern=' + pattern, suitePath];
      // Each mutation is preceded by the identical selected original tests.
      // Node may omit nonmatching tests or report them as skipped; compare the
      // mutant's execution counts with this precise original selection.
      const selected = run(args, baselineFile);
      const expected = counts(selected);
      const selectedPassed = tested(selected, expected, expected.skipped) && selected.status === 0 &&
        expected.failed === 0 && expected.passed >= mutant.selectedTests.length;
      const omitted = fullBaselines.get(mutant.suite).tests - expected.tests;
      console.log(`SELECTED BASELINE ${selectedPassed ? 'PASSED' : 'FAILED'} ${mutant.suite}: ` +
        `${expected.passed} executed, ${omitted} deliberately omitted, ${expected.skipped} TAP-skipped` +
        (selectedPassed ? '' : ': ' + details(selected)));
      if (!selectedPassed) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: identical selected original baseline did not pass`);
        continue;
      }
      const result = run(args, file);
      const summary = counts(result);
      if (!tested(result, summary, expected.skipped) || summary.tests !== expected.tests ||
          (result.status === 1 && summary.failed === 0) || (result.status === 0 && summary.failed !== 0)) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: no conclusive test result: ${details(result)}`);
      } else if (result.status === 0) {
        survived += 1;
        console.log(`SURVIVED ${mutant.name}: ${summary.passed}/${summary.tests} tests passed`);
      } else {
        killed += 1;
        console.log(`KILLED ${mutant.name}: ${summary.failed}/${summary.tests} tests failed <- ${details(result)}`);
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(`\n${killed} killed, ${survived} survived, ${notTested} not tested (${MUTANTS.length} total)`);
process.exitCode = !baselinePassed || survived || notTested || !MUTANTS.length ? 1 : 0;
