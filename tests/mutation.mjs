#!/usr/bin/env node
// Mutation check: proves the suite catches real bugs. Each mutant plants one
// bug in a temp copy of the script and runs the tests that should catch it.
// A mutant that SURVIVES (its tests still pass) means a coverage hole.
// Run: npm run test:mutation   (slow: a few minutes)
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const original = readFileSync(new URL('../EVE_SLT_Tracker.user.js', import.meta.url), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'eve-mutant-'));

const MUTANTS = [
  { name: 'pre-test failure reported as test failure', suite: 'logic',
    from: "return oldColor === 'lightblue' ? 'PRETEST_FAILURE' : 'TEST_FAILURE';", to: "return 'TEST_FAILURE';" },
  { name: 'retest start (red -> lightgreen) alerts', suite: 'logic',
    from: "if (newColor === 'darkgreen' && oldColor === 'lightgreen') {", to: "if ((newColor === 'darkgreen' || newColor === 'lightgreen') && (oldColor === 'lightgreen' || oldColor === 'red')) {" },
  { name: 'CSV formula-injection guard removed', suite: 'logic',
    from: "if (/^[=+\\-@\\t\\r]/.test(text)) {", to: 'if (false) {' },
  { name: 'flap protection disabled', suite: 'rack',
    from: 'const ALERT_COOLDOWN_MS = 60000;', to: 'const ALERT_COOLDOWN_MS = 0;' },
  { name: '"Notifs off" section still surfaces alerts', suite: 'rack',
    from: '    if (!sectionSettings.watch) {\n      log(', to: '    if (false) {\n      log(' },
  { name: 'card click opens old Server Detail', suite: 'rack',
    from: '      openTestView(record.serial, openExternal);\n      return;', to: '      openExternal(record.detailUrl);\n      return;' },
  { name: 'server swap raises an alert', suite: 'rack',
    from: '    if (serialChanged) {\n      log(', to: '    if (false) {\n      log(' },
  { name: 'origin guard removed', suite: 'testview',
    from: '    if (!isTestViewOrigin()) {\n      return;\n    }\n    const serial', to: '    const serial' },
  { name: 'oldest TestView test chosen', suite: 'testview',
    from: "matches.sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));",
    to: "matches.sort((a, b) => String(a.started || '').localeCompare(String(b.started || '')));" },
  { name: 'view: window reintroduced', suite: 'static',
    from: 'const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };',
    to: 'const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };' },
  { name: 'native form submission not cancelled on Query press', suite: 'testview',
    from: '      if (form && event.target === form) {\n        event.preventDefault();', to: '      if (false) {\n        event.preventDefault();' },
  { name: 'Jira key shown for a non-found result', suite: 'jira',
    from: "    } else if (result && result.state === 'waiting') {\n      cls += ' eve-jira-waiting';\n      text = pretest ? 'No ticket yet' : 'Ticket pending';",
    to: "    } else if (result && result.state === 'waiting') {\n      cls += ' eve-jira-waiting';\n      text = 'MFGS-0';" }
];

let survived = 0;
for (const m of MUTANTS) {
  if (!original.includes(m.from)) {
    console.log(`?? ${m.name}: anchor not found - update tests/mutation.mjs`);
    survived += 1;
    continue;
  }
  const file = path.join(dir, 'mutant.user.js');
  writeFileSync(file, original.replace(m.from, m.to));
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `tests/${m.suite}.test.mjs`],
    { env: { ...process.env, EVE_SCRIPT: file }, encoding: 'utf8' });
  const killed = r.status !== 0;
  if (!killed) survived += 1;
  const failing = (r.stdout.match(/^not ok \d+ - .*/gm) || []).slice(0, 2).join(' | ');
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.name}${killed ? `  <- ${failing}` : ''}`);
}
console.log(`\n${MUTANTS.length - survived}/${MUTANTS.length} mutants killed`);
process.exit(survived ? 1 : 0);
