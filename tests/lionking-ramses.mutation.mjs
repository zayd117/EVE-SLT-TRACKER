#!/usr/bin/env node
// Exercise immutable userscript copies only. A passing complete baseline and
// an identical passing selected baseline are required before each mutation.
// Syntax, anchors, TAP execution counts and infrastructure failures are checked.
// Run after the source is frozen: node tests/lionking-ramses.mutation.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = readFileSync(path.join(ROOT, 'EVE_SLT_JBOG_TRACKER.user.js'), 'utf8');
const SUITE = 'lionking-ramses.test.mjs';
const MUTANTS = [
  {
    name: 'first-pass yield is used instead of PASSED for the current result',
    selectedTests: ['matching native passed CSV completes an observed run even when FPY says Retest/Fail and Attempt is greater than one'],
    edits: [{
      from: "      if (data.PASSED !== '1') throw new Error('Passed export contains an unverified outcome; previous data retained.');",
      to: "      if (data.FPY_Stat !== 'First Pass') throw new Error('Passed export contains an unverified outcome; previous data retained.');"
    }]
  },
  {
    name: 'PRETEST failed-board membership is omitted from separately typed failure alerts',
    selectedTests: ['new PRETEST failed-board memberships notify separately from GPU_JBOG_TEST failures'],
    edits: [{
      from: "    const failures = board.rows.filter(row => row.operation === 'GPU_JBOG_TEST' ||\n" +
        '      lionIsPretestOperation(row.operation));',
      to: "    const failures = board.rows.filter(row => row.operation === 'GPU_JBOG_TEST');"
    }]
  },
  {
    name: 'historical failed-board entries alert on their first observation',
    selectedTests: ['Ramses selects the Lion profile; PRETEST stays separate and existing failed-board entries establish quiet baselines'],
    edits: [{
      from: '    if (!ramsesFailedState) {\n' +
        '      ramsesFailedState = { version: 2, sequence: failures.length, members: Object.fromEntries(failures.map((row, index) =>\n' +
        '        [row.key, { episode: index + 1, present: true, pending: false }])) };\n' +
        '      saveRamsesFailedState();\n' +
        '      return;\n' +
        '    }',
      to: '    if (!ramsesFailedState) {\n' +
        '      ramsesFailedState = { version: 2, sequence: 0, members: {} };\n' +
        '    }'
    }]
  },
  {
    name: 'an absent running row is manufactured into a PASS result',
    selectedTests: ['removing a running Ramses row never proves PASS or FAIL and retains its known run identity'],
    edits: [{
      from: '    const completed = [], unresolved = [];',
      to: '    const completed = [], unresolved = [];\n' +
        '    for (const [key, prior] of previousStates) {\n' +
        "      if (prior.source !== 'ramses' || prior.status !== 'RUNNING' ||\n" +
        '          running.some(row => row.key === key)) continue;\n' +
        '      const parts = isoDateParts(new Date(prior.startedAt).toISOString());\n' +
        "      completed.push({ source: 'ramses', jbog: prior.serial, tailSerial: prior.serial, headSerial: '',\n" +
        '        started: `${parts.date} ${parts.time}`, startedAt: prior.startedAt, key,\n' +
        '        finishedAt: Date.now(), finished: new Date().toISOString(), durationMs: Date.now() - prior.startedAt,\n' +
        "        status: 'PASS', statusText: 'Disappeared from running table' });\n" +
        '    }'
    }]
  },
  {
    name: 'minute-precision PASS evidence chooses the first of two known attempts',
    selectedTests: ['minute-precision CSV cannot choose between two known GPU_JBOG_TEST attempts in the same minute'],
    edits: [{
      from: '      if (matches.length > 1) { unresolved.push(pass); continue; }',
      to: '      if (false && matches.length > 1) { unresolved.push(pass); continue; }'
    }]
  },
  {
    name: 'multiple distinct current passed-result sources silently select the first',
    selectedTests: [
      'multiple native passed-download anchors are ambiguous and cannot complete an observed run',
      'distinct visible MPY payloads stay ambiguous and cannot choose a first passed result'
    ],
    // Initial discovery and the in-flight guard share this source resolver.
    // Mutating the policy here reproduces selecting a first conflicting URL.
    edits: [{
      from: '      unique: sources.size, selected: sources.size === 1 ? sources.values().next().value : null };',
      to: '      unique: sources.size, selected: sources.size ? sources.values().next().value : null };'
    }]
  },
  {
    name: 'identical MPY anchor copies count as different automatic sources',
    selectedTests: ['identical visible MPY download anchors are one logical automatic passed source'],
    edits: [{
      from: '      unique: sources.size, selected: sources.size === 1 ? sources.values().next().value : null };',
      to: '      unique: candidates.length, selected: candidates.length === 1 ? sources.values().next().value : null };'
    }]
  },
  {
    name: 'hidden stale and CSS-hidden MPY payloads remain current source candidates',
    selectedTests: ['current MPY data ignores conflicting hidden aria-hidden stale and CSS-hidden copies'],
    edits: [{
      from: '    const visible = matching.filter(ramsesSourceCurrent);',
      to: '    const visible = matching.slice();'
    }]
  },
  {
    name: 'generic same-filename links compete with the verified current MPY metric',
    selectedTests: ['the verified current MPY metric takes precedence over another generic same-filename download'],
    edits: [{
      from: '    const candidates = metrics.length ? metrics : visible;',
      to: '    const candidates = visible;'
    }]
  },
  {
    name: 'a failure already old on first sight raises a card and a notification',
    selectedTests: ['a failure already idle when first listed settles silently; a fresh one alerts, dated by its idle time'],
    edits: [{
      from: 'pending: !(idleMs > LION_FAILURE_FRESH_MS) };',
      to: 'pending: true };'
    }]
  },
  {
    name: 'a new failure is dated with the laptop clock instead of the board idle time',
    selectedTests: ['a failure already idle when first listed settles silently; a fresh one alerts, dated by its idle time'],
    edits: [{
      from: 'failedAt: Number.isFinite(idleMs) ? Date.now() - idleMs : NaN,',
      to: 'failedAt: NaN,'
    }]
  },
  {
    name: 'a replaced MPY source supplies obsolete PASS evidence after its read finishes',
    selectedTests: ['an MPY source replaced during a delayed read cannot complete the run from its obsolete payload'],
    edits: [{
      from: '      if (ramsesCurrentPassedSource().selected?.key === key) acceptRamsesCSV(text, true);',
      to: '      acceptRamsesCSV(text, true);'
    }]
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

function escapeRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const directory = mkdtempSync(path.join(tmpdir(), 'eve-lion-ramses-mutant-'));
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
      const invalidAnchor = mutant.edits.find(edit => occurrences(original, edit.from) !== 1);
      if (invalidAnchor) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: expected one source anchor, found ${occurrences(original, invalidAnchor.from)}`);
        continue;
      }
      let changed = original;
      for (const edit of mutant.edits) changed = changed.replace(edit.from, edit.to);
      const file = path.join(directory, `${index + 1}.user.js`);
      writeFileSync(file, changed, { mode: 0o600 });
      const syntax = run(['--check', file], file);
      if (syntax.error || syntax.signal || syntax.status !== 0) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: invalid mutant syntax: ${details(syntax)}`);
        continue;
      }
      const pattern = '^(' + mutant.selectedTests.map(escapeRegex).join('|') + ')$';
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
