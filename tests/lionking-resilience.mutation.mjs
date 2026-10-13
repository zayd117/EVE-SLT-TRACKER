#!/usr/bin/env node
// Mutate immutable copies of the real userscript after passing complete and
// identical selected baselines. Infrastructure failures never count as kills.
// Run: node tests/lionking-resilience.mutation.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = readFileSync(path.join(ROOT, 'EVE_SLT_JBOG_TRACKER.user.js'), 'utf8');
const SUITE = 'lionking-resilience.test.mjs';
const MUTANTS = [
  {
    name: 'one invalid historical row disables every valid run',
    selectedTests: ['one invalid historical Started value degrades one row while a valid observed run still completes once'],
    from: '    return !!snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length > 0 &&\n' +
      '      snapshot.rows.length <= LION_MAX_RUNS;',
    to: '    return !!snapshot && !snapshot.invalidRows && Array.isArray(snapshot.rows) && snapshot.rows.length > 0 &&\n' +
      '      snapshot.rows.length <= LION_MAX_RUNS;'
  },
  {
    name: 'conflicting duplicate PASS and FAIL copies escape run quarantine',
    selectedTests: ['conflicting duplicate outcomes quarantine every copy of that run, preserve its baseline, and allow another run to complete'],
    from: '    const usableRows = rows.filter(row => !quarantinedKeys.has(row.key));',
    to: '    const usableRows = rows;'
  },
  {
    name: 'a foreign-origin persistent snapshot is accepted as local saved data',
    selectedTests: ['corrupt, foreign-origin, and oversized saved snapshots are ignored without alerts or monitoring baselines'],
    from: '    if (!isRecordObject(saved) || saved.version !== 1 || saved.origin !== window.location.origin ||',
    to: '    if (!isRecordObject(saved) || saved.version !== 1 ||'
  },
  {
    name: 'saved display rows are imported as monitoring baselines',
    selectedTests: ['a reload into a login page restores stale display data and settings without importing cached results as monitoring baselines'],
    from: '  function showLionKingSnapshotCache() {\n    if (!lionCachedSnapshot || lionHasCompletedSnapshot) return;',
    to: '  function showLionKingSnapshotCache() {\n    if (!lionCachedSnapshot || lionHasCompletedSnapshot) return;\n' +
      '    lionCachedSnapshot.rows.forEach(row => previousStates.set(row.key, {\n' +
      "      status: row.status, completed: row.status === 'PASS' || row.status === 'FAIL',\n" +
      '      startedAt: row.startedAt, seenAt: Date.now()\n    }));'
  },
  {
    name: 'validated live observations never persist their display snapshot',
    selectedTests: ['a reload into a login page restores stale display data and settings without importing cached results as monitoring baselines'],
    from: '    saveLionKingSnapshotCache(snapshot);',
    to: '    // MUTANT: omit durable display snapshot persistence.'
  }
];

function run(args, sourcePath) {
  const processGroup = process.platform !== 'win32';
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, env: { ...process.env, EVE_SCRIPT: sourcePath }, encoding: 'utf8',
    detached: processGroup, timeout: 180000, maxBuffer: 8 * 1024 * 1024
  });
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

const directory = mkdtempSync(path.join(tmpdir(), 'eve-lion-resilience-mutant-'));
let baselinePassed = true;
let baselineSummary;
let killed = 0;
let survived = 0;
let notTested = 0;
try {
  const baselineFile = path.join(directory, 'baseline.user.js');
  const suitePath = path.join(ROOT, 'tests', SUITE);
  writeFileSync(baselineFile, original, { mode: 0o600 });
  const baseline = run(['--test', '--test-reporter=tap', '--test-concurrency=1', suitePath], baselineFile);
  baselineSummary = counts(baseline);
  if (!tested(baseline, baselineSummary) || baseline.status !== 0 || baselineSummary.failed !== 0) {
    baselinePassed = false;
    console.error(`BASELINE FAILED ${SUITE}: ${baselineSummary.passed}/${baselineSummary.tests} passed ` +
      `(exit ${baseline.status}): ${details(baseline)}`);
  } else {
    console.log(`BASELINE PASSED ${SUITE}: ${baselineSummary.passed}/${baselineSummary.tests} tests`);
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
      const args = ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-name-pattern=' + pattern, suitePath];
      const selected = run(args, baselineFile);
      const expected = counts(selected);
      const selectedPassed = tested(selected, expected, expected.skipped) && selected.status === 0 &&
        expected.failed === 0 && expected.passed >= mutant.selectedTests.length;
      const omitted = baselineSummary.tests - expected.tests;
      console.log(`SELECTED BASELINE ${selectedPassed ? 'PASSED' : 'FAILED'} ${SUITE}: ` +
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
