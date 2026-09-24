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
  { name: 'cross-tab event claim ignored', suite: 'dedupe',
    from: '    if (findEventClaim(key, info.serial, transition, oldState.seen)) {',
    to: '    if (false && findEventClaim(key, info.serial, transition, oldState.seen)) {' },
  { name: 'claim matched by serial only (later event swallowed)', suite: 'dedupe',
    from: '    return claim && Number(claim.at) >= seenAt ? claim : null;',
    to: '    return claim || null;' },
  { name: 'second installed copy not idled', suite: 'dedupe',
    from: '    if (!claimThisTab()) {\n      return;\n    }', to: '    claimThisTab();' },
  { name: 'retry overlaps an in-flight confirmation', suite: 'dedupe',
    from: 'if (attempts >= RESULT_RETRY_MAX_ATTEMPTS || confirmationsInFlight.has(record.id)) {',
    to: 'if (attempts >= RESULT_RETRY_MAX_ATTEMPTS) {' },
  { name: 'new event reuses the cached detail result', suite: 'dedupe',
    from: '    return confirmPhase(info.detailUrl, info, { force: true })', to: '    return confirmPhase(info.detailUrl, info)' },
  { name: 'any page change advances the sighting time', suite: 'dedupe',
    from: '      if (relevant.some(touchesTable)) {', to: '      if (relevant.length) {' },
  { name: 'PASS card keeps the live Jira button', suite: 'jira',
    from: '    if (isPassResult(record)) {\n      clearTimeout(button.__eveJiraPoll);', to: '    if (false) {\n      clearTimeout(button.__eveJiraPoll);' },
  { name: 'PASS toast click goes to Jira', suite: 'jira',
    from: "&& !!serial && !isPassResult(record);", to: '&& !!serial;' },
  { name: 'title span stretches again (thin drag strip)', suite: 'ui',
    from: '#eve-alert-toggle { cursor: pointer; user-select: none; }', to: '#eve-alert-toggle { cursor: pointer; user-select: none; flex: 1; }' },
  { name: 'post-drag click not swallowed (drag from title folds)', suite: 'ui',
    from: '      setTimeout(() => {\n        draggedEnough = false;\n      }, 0);', to: '      draggedEnough = false;' },
  { name: 'drag measured from the header box (creep)', suite: 'ui',
    from: "      const rect = container.getBoundingClientRect();\n      dragState = {", to: "      const rect = header.getBoundingClientRect();\n      dragState = {" },
  { name: 'Jira key shown for a non-found result', suite: 'jira',
    from: "    } else if (result && result.state === 'waiting') {\n      cls += ' eve-jira-waiting';\n      text = pretest ? 'No ticket yet' : 'Ticket pending';",
    to: "    } else if (result && result.state === 'waiting') {\n      cls += ' eve-jira-waiting';\n      text = 'MFGS-0';" },
  { name: 'export times follow the PC clock, not Fremont', suite: 'timezone',
    from: "const SITE_TIME_ZONE = 'America/Los_Angeles';", to: 'const SITE_TIME_ZONE = undefined;' },
  { name: 'chronological record prints stored PC-clock time', suite: 'timezone',
    from: '`[${index + 1}] ${at.date || entry.date} ${at.time || entry.time} \\u{2014} `',
    to: '`[${index + 1}] ${entry.date} ${entry.time} \\u{2014} `' },
  { name: 'detail page Finished time ignored (detection time logged)', suite: 'timezone',
    from: '    if (happened) {\n      entry.eventIso = happened;', to: '    if (false) {\n      entry.eventIso = happened;' },
  { name: 'implausible Finished time accepted', suite: 'timezone',
    from: 'if (at > detected + EVENT_TIME_SKEW_MS || at < detected - EVENT_TIME_MAX_AGE_MS) {', to: 'if (false) {' },
  { name: 'actions menu ignores outside clicks', suite: 'ui',
    from: '        if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) {',
    to: '        if (false) {' },
  { name: 'actions menu never opens upward (off-screen near the bottom)', suite: 'ui',
    from: '        below + height > window.innerHeight - PANEL_MARGIN\n', to: '        false\n' },
  { name: 'closing the menu leaves Dismiss all armed', suite: 'ui',
    from: "      button.classList.remove('eve-menu-open');\n      onClose();", to: "      button.classList.remove('eve-menu-open');" },
  { name: 'actions menu clipped by the panel (absolute, not fixed)', suite: 'ui',
    from: '#eve-alert-menu {\n  position: fixed;', to: '#eve-alert-menu {\n  position: absolute;' },
  { name: 'log cleared at the selected shift\'s own window (Day wipes a running Graveyard)', suite: 'shiftlog',
    from: 'const removed = pruneLogBefore(logRetentionFloorAt(at));', to: 'const removed = pruneLogBefore(win.opens.getTime());' },
  { name: 'Log shift tooltip not updated when the shift changes', suite: 'shiftlog',
    from: '    if (select.title !== title) {', to: '    if (false) {' },
  { name: 'Auto flips shift mid-session (no sticky window)', suite: 'shiftlog',
    from: '      if (win.key === stored && now < win.closes.getTime()) {', to: '      if (false) {' },
  { name: 'manual shift pick never expires', suite: 'shiftlog',
    from: "    if (!settings || !SHIFTS[settings.logShiftChoice] || logShiftOverride(now)) {", to: '    if (true) {' },
  { name: 'old hand-picked shift not migrated to Auto', suite: 'shiftlog',
    from: '    delete loaded.logShift;\n', to: "    if (SHIFTS[loaded.logShift]) { loaded.logShiftChoice = loaded.logShift; loaded.logShiftOverrideFor = 'legacy'; }\n    delete loaded.logShift;\n" },
  { name: 'Finished read as UTC, not Fremont time', suite: 'timezone',
    from: '    for (let i = 0; i < 2; i += 1) {\n      const p = isoDateParts', to: '    for (let i = 0; i < 0; i += 1) {\n      const p = isoDateParts' }
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
