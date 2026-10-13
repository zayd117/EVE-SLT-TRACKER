#!/usr/bin/env node
// Mutation check: proves the suite catches real bugs. Each mutant plants one
// bug in a temp copy of the script and runs the tests that should catch it.
// A mutant that SURVIVES (its tests still pass) means a coverage hole.
// Run: npm run test:mutation   (slow: a few minutes)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const original = readFileSync(new URL('../EVE SLT+JBOG TRACKER.user.js', import.meta.url), 'utf8');
const dir = mkdtempSync(path.join(tmpdir(), 'eve-mutant-'));

const MUTANTS = [
  { name: 'saved lists keep non-object entries', suite: 'stability',
    from: "    return !!entry && typeof entry === 'object' && !Array.isArray(entry);", to: '    return true;' },
  { name: 'a failing tick step is logged every tick', suite: 'stability',
    from: '        failingTickSteps.add(name);', to: '' },
  { name: 'a failing tick step escapes the loop', suite: 'stability',
    from: '    } catch (error) {\n      if (!failingTickSteps.has(name)) {', to: '    } catch (error) {\n      throw error;\n      if (!failingTickSteps.has(name)) {' },
  { name: 'TestView status cache unbounded', suite: 'stability',
    from: '    while (testViewStatusCache.size > MAX_TESTVIEW_STATUS_ENTRIES) {', to: '    while (testViewStatusCache.size > Infinity) {' },
  { name: 'removed card still copies its serial', suite: 'jiraux',
    from: '        serialBox.disabled = gone;', to: '        serialBox.disabled = false;' },
  { name: 'removed-from-rack card not marked', suite: 'jiraux',
    from: "      card.classList.toggle('eve-alert-gone', gone);", to: "      card.classList.toggle('eve-alert-gone', false);" },
  { name: 'retest counted as removed', suite: 'jiraux',
    from: '      const gone = !now || now.serial !== serial;', to: "      const gone = !now || now.serial !== serial || now.color !== 'red';" },
  { name: 'no TestView link while retesting', suite: 'jiraux',
    from: "        link: testViewRunUrl(serial)\n", to: "        link: false && testViewRunUrl(serial)\n" },
  { name: 'ticket prompt ignores a RUNNING test in TestView', suite: 'jiraux',
    from: '    if (running === true) {\n      // PuTTY would refuse it now', to: '    if (false) {\n      // PuTTY would refuse it now' },
  { name: 'TestView FAILED counted as running', suite: 'jiraux',
    from: '              done(status ? /running|in[ _-]?progress/i.test(status) : null);', to: '              done(status ? true : null);' },
  { name: 'gold outline on a chip whose test is running', suite: 'jiraux',
    from: "      if (pretest && !testRunning && !jiraAttentionSeen(serial, failedAt, 'attn')) {", to: "      if (pretest && !jiraAttentionSeen(serial, failedAt, 'attn')) {" },
  { name: 'green mark fades instantly on hover', suite: 'jiraux',
    from: '  const JIRA_NEW_FADE_MS = 3 * 1000;', to: '  const JIRA_NEW_FADE_MS = 0;' },
  { name: 'no PuTTY instruction on the pre-test no-ticket page', suite: 'jiraux',
    from: '    ], ticketHowTo(serial, failedAt, running));', to: '    ], null);' },
  { name: 'gold PuTTY box before the Jira bot had 15 min', suite: 'jiraux',
    from: '    if (Date.now() - failedAt < JIRA_CREATE_BY_HAND_MS) {\n      return {\n        plain: true,', to: '    if (false) {\n      return {\n        plain: true,' },
  { name: 'plain PuTTY line styled like the gold box', suite: 'jiraux',
    from: "        box.className = howto.plain ? 'eve-howto-plain' : 'eve-howto';", to: "        box.className = 'eve-howto';" },
  { name: 'gold acknowledgement not remembered (back after reload)', suite: 'jiraux',
    from: '      if (pretest && !testRunning && !jiraAttentionSeen(serial, failedAt, \'attn\')) {', to: '      if (pretest && !testRunning && !button.dataset.attnArmed) {' },
  { name: 'green mark not remembered across reloads', suite: 'jiraux',
    from: "    if (mark && mark.state === 'new' && mark.key === result.key) {", to: "    if (false) {" },
  { name: 'green acknowledgement not remembered (back after reload)', suite: 'jiraux',
    from: "          setJiraAttention(serial, failedAt, 'new', { state: 'seen' });\n", to: '' },
  { name: 'gold chip dims with an old card', suite: 'jiraux',
    from: '.eve-alert.eve-alert-aged .eve-jira-group:has(.eve-jira-attn) {\n  position: relative;\n  z-index: 2;', to: '.eve-alert.eve-alert-aged .eve-jira-group:has(.eve-jira-attn) {\n  position: relative;\n  z-index: auto;' },
  { name: 'pre-test "create one" only at 20 min', suite: 'jiraux',
    from: '  const JIRA_CREATE_BY_HAND_MS = 15 * 60 * 1000;', to: '  const JIRA_CREATE_BY_HAND_MS = 20 * 60 * 1000;' },
  { name: 'screen wake lock never taken', suite: 'keepawake',
    from: '      holdKeepAliveLock();\n      holdScreenWakeLock();', to: '      holdKeepAliveLock();' },
  { name: 'no catch-up refresh after a sleep', suite: 'keepawake',
    from: '    if (refresh) {\n      refreshNow();\n    }\n    holdScreenWakeLock();', to: '    holdScreenWakeLock();' },
  { name: 'Jira glow lost on repaint', suite: 'jiraux',
    from: "    button.classList.toggle('eve-jira-fresh', !!button.querySelector('.eve-jira-new'));", to: '' },
  { name: 'Jira copy copies the bare key, not the link', suite: 'jiraux',
    from: "      const link = found ? jiraIssueUrl(result.key) : '';", to: "      const link = found ? result.key : '';" },
  { name: 'Jira badge on a repaint / first look (no pending check)', suite: 'jiraux',
    from: '      if (button.dataset.wasPending === \'1\') {\n        // A real no-ticket', to: '      if (true) {\n        // A real no-ticket' },
  { name: 'Jira badge never fades after hover', suite: 'jiraux',
    from: '          setJiraAttention(serial, failedAt, \'new\', { state: \'seen\' });\n          clearJiraNewBadge(badge);', to: '          setJiraAttention(serial, failedAt, \'new\', { state: \'seen\' });' },
  { name: 'pre-test outline never fades after hover', suite: 'jiraux',
    from: "          button.classList.remove('eve-jira-attn');", to: '' },
  { name: 'pre-test outline missing', suite: 'jiraux',
    from: "        cls += ' eve-jira-attn';", to: '' },
  { name: 'hover fade is instant', suite: 'jiraux',
    from: '  const JIRA_HOVER_FADE_MS = 10 * 1000;', to: '  const JIRA_HOVER_FADE_MS = 0;' },
  { name: 'Jira copy control shown without a ticket', suite: 'jiraux',
    from: '      copy.hidden = !found;', to: '      copy.hidden = false;' },
  { name: 'pre-test no-ticket label reverted', suite: 'jiraux',
    from: '      text = pretest ? (testRunning ? \'No ticket (re-testing)\' : \'No ticket (create one)\') : \'No ticket\';', to: '      text = \'No ticket\';' },
  { name: 'shift guess ignores the early-arrival window', suite: 'logic',
    from: '    const opens = id => shiftMinutes(SHIFTS[id].start) - SHIFT_EARLY_MIN;', to: '    const opens = id => shiftMinutes(SHIFTS[id].start);' },
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
    from: '      matches.sort((a, b) => String(b.started || \'\').localeCompare(String(a.started || \'\')));\n      return matches.length ? String(matches[0].id) : \'\';', to: '      matches.sort((a, b) => String(a.started || \'\').localeCompare(String(b.started || \'\')));\n      return matches.length ? String(matches[0].id) : \'\';' },
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
  { name: 'Jira chip shows the project key again', suite: 'jira',
    from: '      text = jiraChipText(result.key);', to: '      text = result.key;' },
  { name: 'red-cell click intercepts modifier clicks', suite: 'cellclick',
    from: '      event.button !== 0 ||\n      event.ctrlKey ||\n', to: '      event.button !== 0 ||\n' },
  { name: 'red-cell click intercepts any colour', suite: 'cellclick',
    from: "    if (!table || normalizeColor(cell) !== 'red') {", to: '    if (!table) {' },
  { name: 'red-cell click intercepts any table / column', suite: 'cellclick',
    from: '    if (!group || !group.headers.some(header => header.column === cell.cellIndex)) {', to: '    if (false) {' },
  { name: 'red-cell click lets the old detail link fire too', suite: 'cellclick',
    from: '    event.preventDefault();\n    event.stopPropagation();\n    devLog(`Red cell', to: '    devLog(`Red cell' },
  { name: 'Finished read as UTC, not Fremont time', suite: 'timezone',
    from: '    for (let i = 0; i < 2; i += 1) {\n      const p = isoDateParts', to: '    for (let i = 0; i < 0; i += 1) {\n      const p = isoDateParts' }
];

// Optional targeted runs keep the full original suite as a prerequisite, then
// prove the selected behavioral tests pass unmodified before running a mutant.
// No assertion is removed; --full (the default) still runs every test per bug.
const TARGET_TESTS = {
  'saved lists keep non-object entries': 'non-object entries',
  'a failing tick step is logged every tick': 'a step that keeps throwing',
  'a failing tick step escapes the loop': 'a step that keeps throwing',
  'TestView status cache unbounded': 'TestView status cache stays bounded',
  'removed card still copies its serial': 'card whose server left its slot',
  'removed-from-rack card not marked': 'card whose server left its slot',
  'retest counted as removed': 'card whose server left its slot',
  'no TestView link while retesting': 'TestView 2.0 status:',
  'ticket prompt ignores a RUNNING test in TestView': 'TestView 2.0 status:',
  'TestView FAILED counted as running': 'TestView status: finished',
  'gold outline on a chip whose test is running': 'pre-test chip: while TestView',
  'green mark fades instantly on hover': 'pending -> ticket shows ONE',
  'no PuTTY instruction on the pre-test no-ticket page': 'no-ticket page: plain',
  'gold PuTTY box before the Jira bot had 15 min': 'no-ticket page: plain',
  'plain PuTTY line styled like the gold box': 'no-ticket page: plain',
  'gold acknowledgement not remembered (back after reload)': 'gold pre-test outline fires once',
  'green mark not remembered across reloads': 'has no timeout, survives page reloads',
  'green acknowledgement not remembered (back after reload)': 'has no timeout, survives page reloads',
  'gold chip dims with an old card': 'old pre-test card:',
  'pre-test "create one" only at 20 min': 'no copy control for pending',
  'screen wake lock never taken': 'keeps itself awake:',
  'no catch-up refresh after a sleep': 'after a sleep:',
  'Jira glow lost on repaint': 'pending -> ticket shows ONE',
  'Jira copy copies the bare key, not the link': 'copy control only for a real ticket',
  'Jira badge on a repaint / first look (no pending check)': 'ticket found at the first look',
  'Jira badge never fades after hover': 'pending -> ticket shows ONE',
  'pre-test outline never fades after hover': 'gold pre-test outline fires once',
  'pre-test outline missing': 'gold pre-test outline fires once',
  'hover fade is instant': 'gold pre-test outline fires once',
  'Jira copy control shown without a ticket': 'no copy control for pending',
  'pre-test no-ticket label reverted': 'no copy control for pending',
  'flap protection disabled': 'flap protection:',
  '"Notifs off" section still surfaces alerts': 'section with Notifs off:',
  'card click opens old Server Detail': 'card click opens TestView for the serial',
  'server swap raises an alert': 'server swapped in a slot',
  'origin guard removed': 'origin guard:',
  'oldest TestView test chosen': 'several tests for the serial',
  'native form submission not cancelled on Query press': 'Query as a submit button',
  'cross-tab event claim ignored': 'two tabs on the same rack:',
  'claim matched by serial only (later event swallowed)': 'legitimate later event, one tab:',
  'second installed copy not idled': 'two installed copies in one tab:',
  'retry overlaps an in-flight confirmation': 'the retry never overlaps',
  'new event reuses the cached detail result': 'different result for the same serial later',
  'any page change advances the sighting time': 'only rack-table changes',
  'PASS card keeps the live Jira button': 'PASS card:',
  'PASS toast click goes to Jira': 'PASS toast click',
  'title span stretches again (thin drag strip)': 'title bar holds only the title',
  'post-drag click not swallowed (drag from title folds)': 'title can start a drag too',
  'drag measured from the header box (creep)': 'drag snaps to the corner margins',
  'Jira key shown for a non-found result': 'failure without a ticket yet:',
  'export times follow the PC clock, not Fremont': 'export date/time are Pacific',
  'chronological record prints stored PC-clock time': 'real detected failure exports',
  'detail page Finished time ignored (detection time logged)': 'failure is logged at the detail page Finished',
  'implausible Finished time accepted': 'Finished in the future|Finished more than a day old',
  'actions menu ignores outside clicks': 'closes on outside click and Escape',
  'actions menu never opens upward (off-screen near the bottom)': 'near the bottom of the screen',
  'closing the menu leaves Dismiss all armed': 'closing the menu disarms Dismiss all',
  'actions menu clipped by the panel (absolute, not fixed)': 'menu is not clipped when the panel is folded',
  "log cleared at the selected shift's own window (Day wipes a running Graveyard)": 'Day picked by hand at 4 AM',
  'Log shift tooltip not updated when the shift changes': 'Log shift tooltip says Auto or Manual',
  'Auto flips shift mid-session (no sticky window)': 'Auto, open session:',
  'manual shift pick never expires': 'manual pick lasts until the next shift change',
  'old hand-picked shift not migrated to Auto': 'upgrade: a shift picked by hand',
  'Jira chip shows the project key again': 'failure with a ticket:',
  'Finished read as UTC, not Fremont time': 'siteTimeToMs:'
};

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

const suiteArgument = process.argv.slice(2).find(argument => argument.startsWith('--suite='));
const suiteFilter = suiteArgument ? suiteArgument.slice('--suite='.length) : '';
const mutantArgument = process.argv.slice(2).find(argument => argument.startsWith('--mutant='));
const mutantFilter = mutantArgument ? mutantArgument.slice('--mutant='.length) : '';
const selected = MUTANTS.filter(mutant => (!suiteFilter || mutant.suite === suiteFilter) &&
  (!mutantFilter || mutant.name === mutantFilter));
const targeted = process.argv.includes('--targeted');
const baselines = new Map();
const selectedBaselines = new Map();
let killed = 0;
let survived = 0;
let notTested = 0;
try {
  if (!selected.length) throw new Error('No mutation suite matched ' + suiteFilter);
  const baselineFile = path.join(dir, 'baseline.user.js');
  writeFileSync(baselineFile, original, { mode: 0o600 });
  for (const [index, mutant] of selected.entries()) {
    const suite = path.join(ROOT, 'tests', mutant.suite + '.test.mjs');
    if (!baselines.has(suite)) {
      const result = run(['--test', '--test-reporter=tap', '--test-concurrency=1', suite], baselineFile);
      const summary = counts(result);
      const passed = tested(result, summary) && result.status === 0 && summary.failed === 0;
      baselines.set(suite, passed ? summary : null);
      console.log(`BASELINE ${mutant.suite}: ${passed ? 'PASSED' : 'FAILED'} ${summary.passed}/${summary.tests} tests (exit ${result.status})${passed ? '' : ' <- ' + details(result)}`);
    }
    let baseline = baselines.get(suite);
    if (!baseline) {
      notTested += 1;
      console.log(`NOT TESTED ${mutant.name}: original ${mutant.suite} suite did not pass`);
      continue;
    }
    const pattern = targeted ? TARGET_TESTS[mutant.name] : '';
    const args = ['--test', '--test-reporter=tap', '--test-concurrency=1'];
    if (pattern) args.push('--test-name-pattern=' + pattern);
    args.push(suite);
    if (pattern) {
      const key = suite + '\n' + pattern;
      if (!selectedBaselines.has(key)) {
        const result = run(args, baselineFile);
        const summary = counts(result);
        const passed = tested(result, summary) && result.status === 0 && summary.failed === 0;
        selectedBaselines.set(key, passed ? summary : null);
        console.log(`SELECTED BASELINE ${mutant.suite} / ${pattern}: ${passed ? 'PASSED' : 'FAILED'} ${summary.passed}/${summary.tests} executed; ${baseline.tests - (summary.tests || 0)} omitted by name${passed ? '' : ' <- ' + details(result)}`);
      }
      baseline = selectedBaselines.get(key);
      if (!baseline) {
        notTested += 1;
        console.log(`NOT TESTED ${mutant.name}: selected original tests did not pass`);
        continue;
      }
    }
    const found = occurrences(original, mutant.from);
    if (found !== 1) {
      notTested += 1;
      console.log(`NOT TESTED ${mutant.name}: expected one source anchor, found ${found}`);
      continue;
    }
    const file = path.join(dir, `${index + 1}.user.js`);
    writeFileSync(file, original.replace(mutant.from, mutant.to), { mode: 0o600 });
    const syntax = run(['--check', file], file);
    if (syntax.error || syntax.signal || syntax.status !== 0) {
      notTested += 1;
      console.log(`NOT TESTED ${mutant.name}: invalid mutant syntax <- ${details(syntax)}`);
      continue;
    }
    const result = run(args, file);
    const summary = counts(result);
    if (!tested(result, summary) || summary.tests !== baseline.tests ||
        (result.status === 1 && summary.failed === 0) || (result.status === 0 && summary.failed !== 0)) {
      notTested += 1;
      console.log(`NOT TESTED ${mutant.name}: inconclusive run (exit ${result.status}) <- ${details(result)}`);
    } else if (result.status === 0) {
      survived += 1;
      console.log(`SURVIVED ${mutant.name}: ${summary.passed}/${summary.tests} tests (exit ${result.status})`);
    } else {
      killed += 1;
      console.log(`KILLED ${mutant.name}: ${summary.failed}/${summary.tests} failed (exit ${result.status}) <- ${details(result)}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${killed} killed, ${survived} survived, ${notTested} not tested (${selected.length} total)`);
process.exitCode = survived || notTested || !selected.length ? 1 : 0;
