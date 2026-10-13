// Ramses workflows run the installed userscript in its Tampermonkey sandbox.
// Every source, row and CSV is synthetic and every network request is routed.
// Native passed-download discovery supplies automatic results. There is no
// tracker export/import flow and no operator file upload in these tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES
} from './harness/userscript.mjs';
import { withEnabledLionRows } from './harness/lion.mjs';
import { FixtureServer } from './harness/server.mjs';

const RAMSES_URL = 'http://hyve-cmd101-ramses.hyvesolutions.org:8001/?dashboard=jbog';
const RUN_HEADERS = ['JBOG SN', 'Status', 'Operation', 'Started'];
const ONLINE_HEADERS = ['JBOG SN', 'Operation', 'Current Route', 'Idle Time', 'Status', 'Ticket Number'];
const CSV_HEADERS = ['uut_sn', 'Start Time', 'Finish Time', 'PASSED', 'Attempt', 'FPY_Stat'];
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

function siteDate(at, minuteOnly = false) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
  if (minuteOnly) return `${Number(parts.month)}/${Number(parts.day)}/${parts.year} ${Number(parts.hour)}:${parts.minute}`;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function run(values = {}) {
  const startedAt = Math.floor((Date.now() - 7 * 3600000) / 1000) * 1000;
  return { id: 'active', serial: '2699YW1001', startedAt, started: siteDate(startedAt),
    status: 'Running SLT', operation: 'GPU_JBOG_TEST', ...values };
}
const runKey = row => JSON.stringify(['ramses', 'GPU_JBOG_TEST', row.serial.toUpperCase(), row.startedAt]);
const cell = value => `<td>${escape(value)}</td>`;
class RamsesServer extends FixtureServer {
  constructor(rows = [run()], online = []) {
    super(); this.rows = rows; this.online = online; this.login = false; this.nativeRefresh = false;
  }
  render() {
    if (this.login) return '<!doctype html><title>Login</title><h1>Sign in</h1><input type="password">';
    return '<!doctype html><html><head><title>LION KING Live Operations Dashboard</title></head><body>' +
      '<h1>LION KING Live Operations Dashboard</h1><div class="board-card good"><div class="board-title">' +
      `<span>JBOG Running Test</span><span class="badge good">${this.rows.length}</span></div><div class="small-table">` +
      '<table id="ramses-running"><thead><tr>' + RUN_HEADERS.map(h => `<th>${h}</th>`).join('') +
      '</tr></thead><tbody>' + this.rows.map(r => `<tr data-ramses-run="${escape(r.id)}">` +
        [r.serial, r.status, r.operation, r.started].map(cell).join('') + '</tr>').join('') +
      '</tbody></table></div></div><div class="board-card bad"><div class="board-title">' +
      `<span>JBOG Failed Test</span><span class="badge bad">${this.online.length}</span></div>` +
      '<div class="small-table"><table id="ramses-online"><thead><tr>' +
      ONLINE_HEADERS.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' + this.online.map(r =>
        `<tr data-ramses-failed="${escape(r.id || r.serial)}">` +
        [r.serial, r.operation, r.route || 'SLT', r.idle || '0h2m', r.status || 'Online',
          r.ticket || ''].map(cell).join('') + '</tr>').join('') + '</tbody></table></div></div>' +
      (this.nativeRefresh ? '<iframe src="/component/streamlit_autorefresh.st_autorefresh/index.html"></iframe>' : '') +
      '</body></html>';
  }
  async respond(url, req) {
    if (url.href === RAMSES_URL) return { status: 200, contentType: 'text/html', body: this.render() };
    if (url.origin === new URL(RAMSES_URL).origin &&
        url.pathname === '/component/streamlit_autorefresh.st_autorefresh/index.html') {
      return { status: 200, contentType: 'text/html', body: '<!doctype html><p>Native autorefresh fixture</p>' };
    }
    return super.respond(url, req);
  }
}
const source = () => instrument(SCRIPT_SOURCE, [...new Set([
  ...HOOK_NAMES, 'scanLionKing', 'getLionKingSnapshot', 'refreshLionKing', 'pollRamsesPassedCSV'
])]);
async function openRamses(server = new RamsesServer(), options = {}) {
  const tm = await openWithScript(browser, RAMSES_URL, server, withEnabledLionRows({ source: source(), ...options }));
  await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { timeout: 4000, message: 'Ramses automatic source status' });
  await tm.eval('__eve.scanLionKing()');
  return { tm, server };
}
const log = tm => tm.eval('__eve.getAlertLog()');
const states = tm => tm.eval('__eve.state().previousStates');
const cards = tm => tm.page.locator('.eve-alert').count();
const notify = async tm => (await tm.gm()).notifications;
function passed(row, values = {}) {
  return { serial: row.serial, start: row.started, finish: siteDate(row.startedAt + 6 * 3600000),
    passed: '1', attempt: '1', fpy: 'First Pass', ...values };
}
function csv(rows, headers = CSV_HEADERS) {
  const quote = value => /[",\r\n]/.test(String(value)) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value);
  return headers.join(',') + '\r\n' + rows.map(r =>
    [r.serial, r.start, r.finish, r.passed, r.attempt, r.fpy].map(quote).join(',')).join('\r\n');
}
async function publishCsv(tm, rows, headers = CSV_HEADERS) {
  await addPassedAnchor(tm, rows, headers);
  await tm.eval('__eve.pollRamsesPassedCSV(true)');
  await tm.waitFor(async () => (await tm.page.textContent('#lion-csv-feedback')).trim(),
    { message: 'automatic native CSV source validation feedback' });
  await tm.eval('__eve.scanLionKing()');
}
async function removeRunning(tm, id = 'active') {
  await tm.page.evaluate(id => {
    const table = document.querySelector('#ramses-running');
    table.querySelector(`[data-ramses-run="${id}"]`)?.remove();
    table.closest('.board-card').querySelector('.badge').textContent = String(table.tBodies[0].rows.length);
  }, id);
  await tm.eval('__eve.scanLionKing()');
}
async function quiet(tm) {
  await tm.page.waitForTimeout(400);
  assert.deepEqual(await log(tm), []);
  assert.deepEqual(await notify(tm), []);
  assert.equal(await cards(tm), 0);
}
async function onePass(tm, serial = '2699YW1001') {
  await tm.waitFor(async () => (await log(tm)).length === 1, { message: 'one observed Ramses PASS' });
  const entries = await log(tm);
  assert.equal(entries[0].tracker, 'lionking');
  assert.equal(entries[0].tailSerial, serial);
  assert.equal(entries[0].result, 'PASS');
  assert.equal(entries[0].transition, 'TEST_SUCCESS');
  await tm.waitFor(async () => (await notify(tm)).length === 1, { message: 'one PASS notification' });
  assert.equal(await cards(tm), 1);
}
async function addPassedAnchor(tm, rows, headers = CSV_HEADERS) {
  await tm.page.evaluate(text => {
    let anchor = document.querySelector('#native-passed-download');
    if (!anchor) { anchor = document.createElement('a'); anchor.id = 'native-passed-download'; } anchor.textContent = 'Download passed JBOGs';
    anchor.download = 'jbog_passed_finished_2026-10-10.csv';
    anchor.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
    document.body.appendChild(anchor);
  }, csv(rows, headers));
}

test('Ramses selects the Lion profile; PRETEST stays separate and existing failed-board entries establish quiet baselines', async () => {
  const active = run();
  const pre = run({ id: 'pretest', serial: '2699YW1002', status: 'PRETEST', operation: 'GPU_JBOG_TEST_PRETEST' });
  const { tm, server } = await openRamses(new RamsesServer([active, pre], [
    { serial: active.serial, operation: 'GPU_JBOG_TEST', status: 'Online' },
    { serial: '2699YW1003', operation: 'PRETEST', status: 'Online' }
  ]));
  try {
    assert.match(await tm.page.textContent('#eve-tracker-panel'), /EVE SLT\+JBOG TRACKER/);
    assert.equal(await tm.page.locator('#lion-passed-csv, input[type="file"]:not(#lion-rack-file)').count(), 0,
      'the tracker has no manual CSV import UI');
    const current = await states(tm);
    assert.equal(current[runKey(active)]?.status, 'RUNNING');
    assert.equal(Object.keys(current).length, 1, 'PRETEST is a separate count, not a GPU_JBOG_TEST baseline');
    assert.match(await tm.page.textContent('#lion-summary'), /pre.?test/i,
      'the panel exposes the distinct PRETEST count');
    await quiet(tm);
    assert.deepEqual((await tm.gm()).xhr, [], 'Ramses must not invoke SLT or Jira confirmation APIs');
    assert.equal(server.requests.filter(r => /api|eveserverdetail|jira/.test(r)).length, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('hidden and stale retained Ramses board wrappers cannot obscure current running or failed tables', async () => {
  const active = run(); const initial = failed({ id: 'initial', serial: '2699YW1006' });
  const { tm } = await openRamses(new RamsesServer([active], [initial]));
  try {
    await tm.page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      for (const id of ['ramses-running', 'ramses-online']) {
        const current = document.querySelector('#' + id).closest('.board-card');
        current.dataset.stale = 'false';
        for (const mode of ['hidden', 'aria-hidden', 'stale', 'display-none', 'visibility-hidden']) {
          const holder = document.createElement('section'); holder.dataset.retainedBoard = mode;
          const copy = current.cloneNode(true); copy.querySelector('table').id = id + '-' + mode;
          copy.querySelector('tbody tr td').textContent = '2699YW1099';
          if (mode === 'hidden') holder.hidden = true;
          if (mode === 'aria-hidden') holder.setAttribute('aria-hidden', 'true');
          if (mode === 'stale') holder.dataset.stale = 'true';
          if (mode === 'display-none') holder.style.display = 'none';
          if (mode === 'visibility-hidden') holder.style.visibility = 'hidden';
          holder.appendChild(copy); fragment.appendChild(holder);
        }
      }
      document.body.appendChild(fragment);
    });
    const snapshot = await tm.eval(`(() => {
      const value = __eve.getLionKingSnapshot();
      return value && { rows: value.rows.map(row => row.tailSerial),
        failed: value.attention?.rows.map(row => row.serial), usable: value.attention?.usable };
    })()`);
    assert.ok(snapshot, 'retained hidden running tables must not make the current source ambiguous');
    assert.deepEqual(snapshot.rows, [active.serial]);
    assert.deepEqual(snapshot.failed, [initial.serial]);
    assert.equal(snapshot.usable, true);
    await quiet(tm);
    await appendFailed(tm, failed());
    await failureCount(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('two distinct visible running tables remain ambiguous and preserve the observed run', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await tm.page.evaluate(() => {
      const copy = document.querySelector('#ramses-running').closest('.board-card').cloneNode(true);
      copy.id = 'visible-running-copy'; copy.querySelector('table').id = 'ramses-running-copy';
      copy.querySelector('tbody tr td').textContent = '2699YW1009'; document.body.appendChild(copy);
    });
    assert.equal(await tm.eval('__eve.getLionKingSnapshot()'), null);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    await tm.page.evaluate(() => document.querySelector('#visible-running-copy').remove());
    await tm.waitFor(async () => await tm.eval('__eve.getLionKingSnapshot() !== null'),
      { timeout: 4000, message: 'one visible current running board restored' });
    await quiet(tm);
  } finally { await tm.close(); }
});

// A fresh failure has only just landed on the board (idle 2 minutes); the tracker settles older ones quietly.
function failed(values = {}) {
  return { id: 'failure', serial: '2699YW1005', operation: 'GPU_JBOG_TEST', route: 'SLT',
    idle: '0h2m', status: 'Online', ticket: '', ...values };
}
async function appendFailed(tm, row = failed()) {
  await tm.page.evaluate(row => {
    const table = document.querySelector('#ramses-online');
    const element = table.tBodies[0].insertRow(); element.dataset.ramsesFailed = row.id;
    for (const value of [row.serial, row.operation, row.route, row.idle, row.status, row.ticket]) {
      element.insertCell().textContent = value;
    }
    table.closest('.board-card').querySelector('.badge').textContent = String(table.tBodies[0].rows.length);
  }, row);
}
async function removeFailed(tm, id = 'failure', { updateBadge = true } = {}) {
  await tm.page.evaluate(({ id, updateBadge }) => {
    const table = document.querySelector('#ramses-online');
    table.querySelector(`[data-ramses-failed="${id}"]`)?.remove();
    if (updateBadge) table.closest('.board-card').querySelector('.badge').textContent = String(table.tBodies[0].rows.length);
  }, { id, updateBadge });
}
async function failureCount(tm, count = 1) {
  await tm.waitFor(async () => (await log(tm)).length === count,
    { timeout: 4000, message: `${count} observed failed-board membership events` });
  await tm.waitFor(async () => (await notify(tm)).length === count,
    { timeout: 4000, message: `${count} failed-board notifications` });
  const entry = (await log(tm)).at(-1);
  assert.equal(entry.tracker, 'lionking');
  assert.equal(entry.result, 'FAIL');
  assert.equal(entry.transition, 'TEST_FAILURE');
  assert.equal(entry.started, '', 'a failed-board membership has no authoritative run Started');
  assert.equal(entry.phaseSource || entry.evidence, 'ramses-failed-board');
  return entry;
}

test('a newly observed GPU_JBOG_TEST failed-board member raises one automatic FAIL without inventing a run start', async () => {
  const { tm } = await openRamses();
  try {
    await appendFailed(tm);
    const entry = await failureCount(tm);
    assert.equal(entry.tailSerial, '2699YW1005');
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.equal(await cards(tm), 1);
    assert.match(await tm.page.textContent('#lion-summary'), /fail/i);
    assert.equal(await tm.page.textContent('.eve-section-row[data-section="unassigned"] .eve-stat-failed b'), '1');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('new PRETEST failed-board memberships notify separately from GPU_JBOG_TEST failures', async () => {
  const { tm } = await openRamses();
  try {
    await appendFailed(tm, failed({ operation: 'PRETEST' }));
    await appendFailed(tm, failed({ id: 'failure-pretest2', serial: '2699YW1006', operation: 'GPU_JBOG_TEST_PRETEST' }));
    await tm.eval('__eve.scanLionKing()');
    await tm.waitFor(async () => (await log(tm)).length === 2 && (await notify(tm)).length === 2,
      { message: 'two separate PRETEST failure alerts' });
    assert.deepEqual((await log(tm)).map(entry => entry.transition), ['PRETEST_FAILURE', 'PRETEST_FAILURE']);
    assert.ok((await log(tm)).every(entry => entry.result === 'FAIL' && entry.started === ''));
    assert.match(await tm.page.textContent('#lion-summary'), /pre.?test/i);
    assert.equal(await tm.page.textContent('.eve-section-row[data-section="unassigned"] .eve-stat-failed b'), '0');
    assert.equal(await tm.page.textContent('.eve-section-row[data-section="unassigned"] .eve-stat-pretest-failed b'), '2');
    await appendFailed(tm, failed({ id: 'failure-test', serial: '2699YW1007' }));
    const entry = await failureCount(tm, 3);
    assert.equal(entry.tailSerial, '2699YW1007');
  } finally { await tm.close(); }
});

test('Lion Jira card clicks open a serial query ordered by most recently updated even with an old ticket', async () => {
  const row = failed({ ticket: 'MFGS-1001' });
  const server = new RamsesServer();
  server.jira.set(row.serial, [{ key: 'MFGS-1001', fields: {
    summary: `EVE: ${row.serial}: historical failure`, created: '2025-01-01T00:00:00.000Z',
    updated: new Date().toISOString(), status: { name: 'Open' }
  } }]);
  const { tm } = await openRamses(server);
  try {
    await appendFailed(tm, row);
    await failureCount(tm);
    const chip = '.eve-alert .eve-alert-jira';
    const href = await tm.waitFor(async () => {
      const value = await tm.page.getAttribute(chip, 'href');
      return value?.includes('/browse/MFGS-1001?jql=') && value;
    }, { message: 'serial-query Jira card link' });
    const url = new URL(href);
    assert.equal(url.origin, 'https://jira.synnex.com');
    assert.equal(url.searchParams.get('jql'), `text ~ "${row.serial}" ORDER BY updated DESC`);
    const opened = tm.context.waitForEvent('page');
    await tm.page.click(chip);
    const queryPage = await opened;
    await queryPage.waitForLoadState('domcontentloaded');
    assert.equal(queryPage.url(), href);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('ticket, idle time, route and Online text edits cannot repeat a failed-board membership alert', async () => {
  const { tm } = await openRamses();
  try {
    await appendFailed(tm);
    await failureCount(tm);
    await tm.page.evaluate(() => {
      const row = document.querySelector('[data-ramses-failed="failure"]');
      row.cells[2].textContent = 'Repair Queue'; row.cells[3].textContent = '1h24m';
      row.cells[4].textContent = 'Offline'; row.cells[5].textContent = 'SYNTHETIC-1001';
    });
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    await tm.page.waitForTimeout(400);
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.equal(await cards(tm), 1);
  } finally { await tm.close(); }
});

test('a failure already idle when first listed settles silently; a fresh one alerts, dated by its idle time', async () => {
  const { tm } = await openRamses();
  try {
    // The page was just opened: these failed long before the tracker looked, so they are not news.
    await appendFailed(tm, failed({ id: 'old-gpu', serial: '2699YW1011', idle: '1h5m' }));
    await appendFailed(tm, failed({ id: 'old-pretest', serial: '2699YW1012', operation: 'PRETEST', idle: '3d4h10m' }));
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    await quiet(tm);
    // A failure that has just landed alerts, and its card is as old as the board says, not as old as this tab's look at it.
    const landed = Date.now();
    await appendFailed(tm, failed({ id: 'fresh', serial: '2699YW1013', idle: '0h3m' }));
    const entry = await failureCount(tm);
    assert.equal(entry.tailSerial, '2699YW1013');
    assert.equal(entry.timeSource, 'source-idle');
    assert.ok(Math.abs(entry.ts - (landed - 3 * 60000)) < 30000, 'the card time is now minus the idle time');
    assert.ok(Math.abs(Date.parse(entry.iso) - landed) < 30000, 'the audit log still records when it was detected');
    assert.match(entry.statusText, /idle 0h3m/);
    assert.match(await tm.page.textContent('.eve-alert .eve-alert-time'), /\b3m ago\b/);
    // The settled entries stay quiet however often the board is read.
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    await tm.page.waitForTimeout(400);
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('an idle time the board does not give as a duration cannot hide a new failure', async () => {
  const { tm } = await openRamses();
  try {
    await appendFailed(tm, failed({ idle: 'n/a' }));
    const entry = await failureCount(tm);
    assert.equal(entry.timeSource, 'detected', 'with no readable idle time, the detection time is all there is');
    assert.equal(entry.ts, Date.parse(entry.iso));
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a settled old failure stays quiet after a reload; the same JBOG failing again with a fresh idle time alerts', async () => {
  const old = failed({ idle: '2h0m' }), server = new RamsesServer();
  const { tm } = await openRamses(server);
  try {
    await appendFailed(tm, old);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    server.online = [old];
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { message: 'reloaded Ramses controls' });
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    // It leaves the board and fails again: a new episode, and this time it has only just landed.
    await removeFailed(tm);
    await tm.eval('__eve.scanLionKing()');
    await appendFailed(tm, failed({ idle: '0h1m' }));
    const entry = await failureCount(tm);
    assert.equal(entry.tailSerial, old.serial);
    assert.equal(entry.timeSource, 'source-idle');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('the Rack Map Seen time of a failure follows the board idle time, not the moment the tab noticed it', async () => {
  const { tm } = await openRamses();
  try {
    const before = Date.now();
    await appendFailed(tm, failed({ idle: '2h10m' }));
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    const seen = await tm.waitFor(() => tm.page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('lionKingTrackerRackSeenTimesV1') || 'null');
      return saved && Object.values(saved)[0];
    }), { message: 'saved Seen time' });
    assert.ok(Math.abs(seen.at - (before - 130 * 60000)) < 30000, 'Seen is about two hours ago');
    assert.equal(seen.present, true);
    // A later read cannot move it forward.
    await tm.eval('__eve.scanLionKing()');
    const again = await tm.page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('lionKingTrackerRackSeenTimesV1')))[0]);
    assert.ok(again.at <= seen.at + 1000);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('failed-board disappearance never means PASS; a valid leave and return starts a distinct failure episode', async () => {
  const { tm } = await openRamses();
  try {
    await appendFailed(tm);
    const first = await failureCount(tm);
    await removeFailed(tm);
    await tm.eval('__eve.scanLionKing()');
    await tm.page.waitForTimeout(400);
    assert.equal((await log(tm)).length, 1, 'leaving the action board cannot manufacture a PASS');
    assert.equal((await notify(tm)).length, 1);
    await appendFailed(tm);
    const second = await failureCount(tm, 2);
    assert.notEqual(first.eventId, second.eventId);
    assert.equal((await log(tm)).filter(entry => entry.result === 'PASS').length, 0);
  } finally { await tm.close(); }
});

test('failed-board membership persists across reload and never replays an existing failure notification', async () => {
  const row = failed(); const server = new RamsesServer();
  const { tm } = await openRamses(server);
  try {
    await appendFailed(tm, row); await failureCount(tm);
    server.online = [row];
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { message: 'reloaded Ramses controls' });
    await tm.eval('__eve.scanLionKing()');
    await tm.page.waitForTimeout(400);
    assert.equal((await log(tm)).length, 1);
    assert.deepEqual(await notify(tm), []);
    assert.equal(await cards(tm), 1);
  } finally { await tm.close(); }
});

test('area Show and Notifs apply to the failed board while muted failures still enter the audit log', async () => {
  const row = failed();
  const { tm } = await openRamses(new RamsesServer([run({ serial: row.serial })]));
  try {
    await tm.page.locator('details:has(#lion-area-serial)').evaluate(el => { el.open = true; });
    await tm.page.fill('#lion-area-serial', row.serial);
    await tm.page.selectOption('#lion-area-choice', 'b6');
    await tm.page.click('#lion-area-save');
    await tm.page.uncheck('.eve-section-row[data-section="b6"] .eve-show-checkbox');
        await appendFailed(tm, row);
    await tm.waitFor(async () => (await log(tm)).length === 1, { timeout: 4000, message: 'muted failed-board audit' });
    const entry = (await log(tm))[0];
    assert.equal(entry.result, 'FAIL'); assert.equal(entry.area, 'b6');
    assert.deepEqual(await notify(tm), []);
    assert.equal(await cards(tm), 0);
    assert.equal(await tm.page.$eval('[data-ramses-failed="failure"]', element => element.hidden), true);
    assert.equal(await tm.page.$eval('[data-ramses-run="active"]', element => element.hidden), true,
      'the same Show preference filters both native board rows');
    await tm.page.check('.eve-section-row[data-section="b6"] .eve-show-checkbox');
    assert.equal(await tm.page.$eval('[data-ramses-failed="failure"]', element => element.hidden), false);
    assert.equal((await log(tm)).length, 1);
  } finally { await tm.close(); }
});

test('a missing failed board preserves membership rather than treating its restored rows as new failures', async () => {
  const row = failed();
  const { tm } = await openRamses(new RamsesServer([run()], [row]));
  try {
    await quiet(tm);
    await tm.page.evaluate(() => {
      window.heldFailedBoard = document.querySelector('#ramses-online').closest('.board-card');
      window.heldFailedBoard.remove();
    });
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    await tm.page.evaluate(() => document.body.appendChild(window.heldFailedBoard));
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
  } finally { await tm.close(); }
});

test('a failed-board badge mismatch cannot infer an absent member or create a fresh failure episode', async () => {
  const row = failed();
  const { tm } = await openRamses(new RamsesServer([run()], [row]));
  try {
    await quiet(tm);
    await removeFailed(tm, row.id, { updateBadge: false });
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    await appendFailed(tm, row);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
  } finally { await tm.close(); }
});

test('two matching failed boards are ambiguous and cannot produce a guessed new-member alert', async () => {
  const { tm } = await openRamses();
  try {
    await tm.page.evaluate(() => {
      const copy = document.querySelector('#ramses-online').closest('.board-card').cloneNode(true);
      copy.id = 'ambiguous-failed-board'; copy.querySelector('table').id = 'ramses-online-copy';
      document.body.appendChild(copy);
    });
    await appendFailed(tm);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    await tm.page.evaluate(() => document.querySelector('#ambiguous-failed-board').remove());
    await tm.eval('__eve.scanLionKing()');
    await failureCount(tm);
  } finally { await tm.close(); }
});

test('removing a running Ramses row never proves PASS or FAIL and retains its known run identity', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.notEqual(await tm.page.textContent('#eve-health-chip'), 'BLIND',
      'an empty table with the exact running schema is still an observable dashboard');
  } finally { await tm.close(); }
});

test('matching native passed CSV completes an observed run even when FPY says Retest/Fail and Attempt is greater than one', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active, { attempt: '3', fpy: 'Retest/Fail' })]);
    await onePass(tm);
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.equal((await states(tm))[runKey(active)].completed, true);
    await tm.page.locator('.eve-alert-loc').click();
    await tm.waitFor(async () => (await tm.gm()).openedTabs.length === 1,
      { message: 'API-miss TestView fallback navigation' });
    const opened = (await tm.gm()).openedTabs;
    assert.equal(opened.length, 1);
    const url = new URL(opened[0]);
    assert.equal(url.pathname, '/uut/gpu_jbog_test/list', 'UUT navigation never aliases the similar SLT flow');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('eveLionSn'), active.serial);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('passed CSV conflicts with a still-visible RUNNING row until native Streamlit removes that row', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await publishCsv(tm, [passed(active)]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    await tm.page.evaluate(() => {
      const table = document.querySelector('#ramses-running');
      table.querySelector('[data-ramses-run="active"]').remove();
      table.closest('.board-card').querySelector('.badge').textContent = String(table.tBodies[0].rows.length);
    });
    // No manual scan: the live dashboard's own mutation must drive detection.
    await onePass(tm);
  } finally { await tm.close(); }
});

test('automatic native passed-download discovery monitors completions with no tracker import/export flow', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  let downloads = 0;
  tm.page.on('download', () => { downloads += 1; });
  try {
    await removeRunning(tm);
    await addPassedAnchor(tm, [passed(active, { attempt: '2', fpy: 'Retest/Fail' })]);
    await onePass(tm);
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await log(tm)).length, 1);
    assert.equal(downloads, 0, 'reading a native data CSV link does not download files to the operator');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('the verified MPY base64 download anchor supplies automatic second-precision PASS evidence without downloads or extra requests', async () => {
  const minute = Math.floor((Date.now() - 7 * 3600000) / 60000) * 60000;
  const active = run({ startedAt: minute + 43000, started: siteDate(minute + 43000) });
  const { tm, server } = await openRamses(new RamsesServer([active]));
  let downloads = 0;
  tm.page.on('download', () => { downloads += 1; });
  try {
    await removeRunning(tm);
    const href = 'data:text/csv;base64,' + Buffer.from(csv([passed(active, { attempt: '2', fpy: 'Retest/Fail' })])).toString('base64');
    await tm.page.evaluate(href => {
      const anchor = document.createElement('a');
      anchor.className = 'kpi-link'; anchor.id = 'native-mpy';
      anchor.download = 'jbog_passed_finished_2026-10-10.csv';
      anchor.textContent = 'MPY (Passed JBOGs)'; anchor.href = href;
      document.body.appendChild(anchor);
    }, href);
    // This is the native persistent anchor contract supplied by the user.
    // Parsing its embedded CSV must not click it or invoke a page-world bridge.
    await onePass(tm);
    assert.equal((await log(tm))[0].started, active.started, 'all observed start seconds remain intact');
    assert.equal((await states(tm))[runKey(active)].status, 'PASS');
    assert.equal(server.requests.length, 1, 'the embedded payload needs only the initial dashboard navigation');
    assert.equal(downloads, 0, 'automatic reading never initiates the native download');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('first-seen completed CSV rows add silent history cards and average Start-to-Finish durations', async () => {
  const first = run({ id: 'first', serial: '2699YW1002', startedAt: Math.floor((Date.now() - 10 * 3600000) / 1000) * 1000 });
  first.started = siteDate(first.startedAt);
  const second = run({ id: 'second', serial: '2699YW1003', startedAt: Math.floor((Date.now() - 8 * 3600000) / 1000) * 1000 });
  second.started = siteDate(second.startedAt);
  const { tm } = await openRamses();
  try {
    const pass1 = passed(first, { finish: siteDate(first.startedAt + (5 * 60 + 58) * 60000) });
    const pass2 = passed(second, { finish: siteDate(second.startedAt + (6 * 60 + 2) * 60000), attempt: '2', fpy: 'Retest/Fail' });
    await publishCsv(tm, [pass1, pass2, pass1]);
    await tm.waitFor(async () => (await log(tm)).length === 2 && (await cards(tm)) === 2,
      { message: 'two silent historical PASS cards' });
    assert.deepEqual(await notify(tm), [], 'first discovery does not replay desktop completion alerts');
    assert.ok((await log(tm)).every(entry => entry.history === true && entry.result === 'PASS'));
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await log(tm)).length, 2, 'repeated scans do not duplicate historical cards');
    assert.equal((await states(tm))[runKey(first)].status, 'PASS');
    assert.equal((await states(tm))[runKey(second)].status, 'PASS');
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
    assert.match(await tm.page.textContent('#lion-average-pass'), /2 samples/,
      'agreeing duplicate CSV rows do not bias the recent average');
  } finally { await tm.close(); }
});

test('minute-precision CSV cannot choose between two known GPU_JBOG_TEST attempts in the same minute', async () => {
  const minute = Math.floor((Date.now() - 7 * 3600000) / 60000) * 60000;
  const first = run({ id: 'first', startedAt: minute + 5000, started: siteDate(minute + 5000) });
  const second = run({ id: 'second', startedAt: minute + 45000, started: siteDate(minute + 45000) });
  const { tm } = await openRamses(new RamsesServer([first, second]));
  try {
    await removeRunning(tm, 'first'); await removeRunning(tm, 'second');
    await publishCsv(tm, [passed(first, { start: siteDate(minute, true), finish: siteDate(minute + 6 * 3600000, true) })]);
    await quiet(tm);
    const current = await states(tm);
    assert.equal(current[runKey(first)].status, 'RUNNING');
    assert.equal(current[runKey(second)].status, 'RUNNING');
    assert.match(await tm.page.getAttribute('#eve-health-chip', 'title'), /ambiguous|match|minute|quarantin/i,
      'the source can parse successfully while health reports an unresolved run match');
  } finally { await tm.close(); }
});

test('minute-precision CSV can match one uniquely known attempt without inventing another identity', async () => {
  const minute = Math.floor((Date.now() - 7 * 3600000) / 60000) * 60000;
  const active = run({ startedAt: minute + 43000, started: siteDate(minute + 43000) });
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active, { start: siteDate(minute, true), finish: siteDate(minute + 6 * 3600000, true) })]);
    await onePass(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'PASS');
    assert.equal((await log(tm))[0].started, active.started, 'navigation keeps the observed precise source start');
  } finally { await tm.close(); }
});

test('a passed CSV for another second-precision attempt cannot complete the observed run of the same node', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active, {
      start: siteDate(active.startedAt - 3000), finish: siteDate(active.startedAt + 6 * 3600000 - 3000)
    })]);
    await tm.waitFor(async () => (await log(tm)).length === 1,
      { message: 'separate verified attempt is retained as history' });
    assert.equal((await log(tm))[0].history, true);
    assert.notEqual((await log(tm))[0].runKey, runKey(active));
    assert.deepEqual(await notify(tm), []);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
  } finally { await tm.close(); }
});

test('PASSED=0 and FPY failure metrics never turn online action rows into terminal FAIL evidence', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active], [
    { serial: active.serial, operation: 'GPU_JBOG_TEST', status: 'Online' }
  ]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active, { passed: '0', fpy: 'Fail' })]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.textContent('#lion-average-pass'), /unavailable|0 samples/);
  } finally { await tm.close(); }
});

test('invalid CSV schema cannot acknowledge a completion or replace retained running observations', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active)], ['serial', ...CSV_HEADERS.slice(1)]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.textContent('#lion-csv-feedback'), /schema|header|heading|column|invalid|unsupported/i);
  } finally { await tm.close(); }
});

test('saved passed CSV and completion cards survive Ramses reload without duplicate completion notifications', async () => {
  const active = run(); const server = new RamsesServer([active]);
  const { tm } = await openRamses(server);
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active)]);
    await onePass(tm);
    assert.ok(await tm.page.evaluate(() => localStorage.getItem('lionKingTrackerRamsesPassedCSV')),
      'the automatically observed source is persisted across page reloads');
    server.rows = [];
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { message: 'reloaded automatic Ramses source status' });
    await tm.eval('__eve.scanLionKing()');
    assert.equal((await log(tm)).length, 1);
    assert.equal(await cards(tm), 1, 'the single existing card is restored');
    assert.deepEqual(await notify(tm), [], 'reload never replays the historical completion toast');
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
    await publishCsv(tm, [passed(active)]);
    assert.equal((await log(tm)).length, 1);
    assert.deepEqual(await notify(tm), []);
  } finally { await tm.close(); }
});

test('Ramses refresh uses native DOM data rather than fetching a Streamlit HTML shell, with isolated SLT storage', async () => {
  const sltSettings = { sections: { B4: { show: false, watch: false } }, debug: 'synthetic sentinel' };
  const sltPrevious = { 'synthetic-slt-slot': { status: 'RUNNING', seenAt: 123 } };
  const { tm, server } = await openRamses(new RamsesServer(), {
    localStorage: { eveRackTrackerSettings: sltSettings },
    sessionStorage: { eveRackTrackerPreviousStates: sltPrevious }
  });
  try {
    await tm.eval('__eve.refreshLionKing(); __eve.refreshLionKing()');
    await tm.page.evaluate(() => {
      const row = document.querySelector('[data-ramses-run="active"]');
      row.cells[1].firstChild.nodeValue = 'PRETEST';
      row.cells[2].firstChild.nodeValue = 'GPU_JBOG_TEST_PRETEST';
    });
    await tm.page.waitForTimeout(450);
    await quiet(tm);
    assert.equal(server.requests.length, 1, 'only initial navigation fetched the native dashboard HTML');
    assert.deepEqual(await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerSettings'))), sltSettings);
    assert.deepEqual(await tm.page.evaluate(() => JSON.parse(sessionStorage.getItem('eveRackTrackerPreviousStates'))), sltPrevious);
    assert.deepEqual((await tm.gm()).xhr, []);
    assert.deepEqual(server.unrouted, []);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a login response cannot reinterpret a retained passed CSV as fresh completion or switch into SLT monitoring', async () => {
  const active = run(); const server = new RamsesServer([active]);
  const { tm } = await openRamses(server);
  try {
    await publishCsv(tm, [passed(active)]);
    await quiet(tm);
    server.login = true;
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { message: 'retained Lion Ramses status' });
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.equal(await tm.page.textContent('#eve-health-chip'), 'BLIND');
    assert.match(await tm.page.textContent('#eve-tracker-panel'), /EVE SLT\+JBOG TRACKER/);
    assert.deepEqual((await tm.gm()).xhr, [], 'a login shell must not fall through to SLT APIs');
    assert.equal(server.requests.filter(r => /slt|api|jira/.test(r)).length, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a PASSED row with malformed or reversed finish time cannot acknowledge a result or supply an average', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await publishCsv(tm, [passed(active, { finish: 'not a date' })]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    await publishCsv(tm, [passed(active, { finish: siteDate(active.startedAt - 60000) })]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.textContent('#lion-average-pass'), /unavailable|0 samples/);
  } finally { await tm.close(); }
});

test('an all-malformed Ramses running table becomes BLIND while preserving its prior valid running observation', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await tm.page.evaluate(() => {
      document.querySelector('[data-ramses-run="active"]').cells[3].textContent = 'not a date';
    });
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    assert.equal(await tm.page.textContent('#eve-health-chip'), 'BLIND');
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.getAttribute('#eve-health-chip', 'title'), /rejected|invalid|usable/i);
    await tm.page.evaluate(started => {
      document.querySelector('[data-ramses-run="active"]').cells[3].textContent = started;
    }, active.started);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    assert.notEqual(await tm.page.textContent('#eve-health-chip'), 'BLIND');
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('multiple native passed-download anchors are ambiguous and cannot complete an observed run', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    const payloads = [csv([passed(active)]), csv([passed(active, {
      finish: siteDate(active.startedAt + (5 * 60 + 58) * 60000)
    })])];
    await tm.page.evaluate(texts => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 2; index += 1) {
        const anchor = document.createElement('a');
        anchor.id = `ambiguous-native-pass-${index}`;
        anchor.download = 'jbog_passed_finished_2026-10-10.csv';
        anchor.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(texts[index]);
        anchor.textContent = 'MPY (Passed JBOGs)'; fragment.appendChild(anchor);
      }
      // Both candidates arrive in the same native update; selecting the first
      // mutation record instead of validating the whole DOM would be unsafe.
      document.body.appendChild(fragment);
    }, payloads);
    await quiet(tm);
    await tm.eval('__eve.pollRamsesPassedCSV(true); __eve.scanLionKing()');
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.getAttribute('#eve-health-chip', 'title'), /ambiguous|multiple/i);
    await tm.page.evaluate(() => document.querySelector('#ambiguous-native-pass-1').remove());
    await tm.eval('__eve.pollRamsesPassedCSV(true)');
    await onePass(tm);
  } finally { await tm.close(); }
});

async function appendMetricSources(tm, specs) {
  await tm.page.evaluate(specs => {
    const fragment = document.createDocumentFragment();
    for (const spec of specs) {
      const holder = document.createElement('div'); holder.id = spec.id + '-holder';
      holder.dataset.stale = spec.stale ? 'true' : 'false';
      if (spec.hidden) holder.hidden = true;
      if (spec.ariaHidden) holder.setAttribute('aria-hidden', 'true');
      if (spec.style) holder.setAttribute('style', spec.style);
      const anchor = document.createElement('a'); anchor.id = spec.id;
      if (!spec.generic) anchor.className = 'kpi-link';
      anchor.download = 'jbog_passed_finished_2026-10-10.csv';
      anchor.textContent = spec.generic ? 'Other native passed result' : 'MPY (Passed JBOGs)';
      if (spec.wrapped) {
        anchor.innerHTML = '<span class="kpi-title">MPY (Passed JBOGs)</span>' +
          '<strong class="kpi-value">1</strong><span class="kpi-sub">GPU_JBOG_TEST passed on selected finish date. Click card to download CSV.</span>';
      }
      anchor.href = 'data:text/csv;base64,' + spec.base64;
      holder.appendChild(anchor); fragment.appendChild(holder);
    }
    document.body.appendChild(fragment);
  }, specs);
}
const metricSource = (id, rows, options = {}) => ({
  id, base64: Buffer.from(csv(rows)).toString('base64'), ...options
});
async function metricPass(tm) {
  await tm.waitFor(async () => (await log(tm)).length === 1,
    { timeout: 4000, message: 'one logical current MPY source completion' });
  await onePass(tm);
}

test('identical visible MPY download anchors are one logical automatic passed source', async () => {
  const active = run(); const { tm, server } = await openRamses(new RamsesServer([active]));
  let downloads = 0; tm.page.on('download', () => { downloads += 1; });
  try {
    await removeRunning(tm);
    const result = passed(active);
    await appendMetricSources(tm, [metricSource('current-mpy-1', [result]), metricSource('current-mpy-2', [result])]);
    await tm.eval('__eve.pollRamsesPassedCSV(true)');
    await metricPass(tm);
    await tm.eval('__eve.pollRamsesPassedCSV(true); __eve.scanLionKing()');
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
    assert.equal(server.requests.length, 1); assert.equal(downloads, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('current MPY data ignores conflicting hidden aria-hidden stale and CSS-hidden copies', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    const current = passed(active);
    const old = passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) });
    await appendMetricSources(tm, [
      metricSource('current-mpy', [current]),
      metricSource('hidden-mpy', [old], { hidden: true }),
      metricSource('aria-hidden-mpy', [old], { ariaHidden: true }),
      metricSource('stale-mpy', [old], { stale: true }),
      metricSource('display-none-mpy', [old], { style: 'display:none' }),
      metricSource('visibility-hidden-mpy', [old], { style: 'visibility:hidden' })
    ]);
    await tm.eval('__eve.pollRamsesPassedCSV(true)');
    await metricPass(tm);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/,
      'a current data-stale=false source supplies the duration, not a hidden older payload');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('distinct visible MPY payloads stay ambiguous and cannot choose a first passed result', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await appendMetricSources(tm, [
      metricSource('visible-mpy-1', [passed(active)]),
      metricSource('visible-mpy-2', [passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) })])
    ]);
    await tm.eval('__eve.pollRamsesPassedCSV(true); __eve.scanLionKing()');
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.match(await tm.page.getAttribute('#eve-health-chip', 'title'), /ambiguous|multiple/i);
  } finally { await tm.close(); }
});

test('the verified current MPY metric takes precedence over another generic same-filename download', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await appendMetricSources(tm, [
      metricSource('generic-passed-link', [passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) })], { generic: true }),
      metricSource('current-mpy', [passed(active)])
    ]);
    await tm.eval('__eve.pollRamsesPassedCSV(true)');
    await metricPass(tm);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
  } finally { await tm.close(); }
});

test('a wrapped MPY metric label count and subtitle still identify the current automatic passed source', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await appendMetricSources(tm, [
      metricSource('generic-passed-link', [passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) })], { generic: true }),
      metricSource('wrapped-current-mpy', [passed(active)], { wrapped: true })
    ]);
    await metricPass(tm);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
    assert.equal(await tm.page.locator('#wrapped-current-mpy .kpi-title').count(), 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('hiding a conflicting MPY copy automatically recovers the visible current source without a forced poll', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm);
    await appendMetricSources(tm, [
      metricSource('current-mpy', [passed(active)]),
      metricSource('competing-mpy', [passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) })])
    ]);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    await tm.page.evaluate(() => { document.querySelector('#competing-mpy-holder').hidden = true; });
    // Streamlit's own visibility mutation must trigger source re-selection.
    await metricPass(tm);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('an MPY source replaced during a delayed read cannot complete the run from its obsolete payload', async () => {
  const active = run(); const { tm } = await openRamses(new RamsesServer([active]));
  const obsolete = metricSource('current-mpy', [passed(active, { finish: siteDate(active.startedAt + 5 * 3600000) })]);
  const current = metricSource('current-mpy', [passed(active)]);
  try {
    await removeRunning(tm);
    // Delay the real native data-URL fetch in the userscript's isolated world.
    // Parsing and response streaming still use the production implementation.
    await tm.eval(`(() => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const obsoleteURL = ${JSON.stringify('data:text/csv;base64,' + obsolete.base64)};
      globalThis.__delayedMPYFetchCount = 0;
      globalThis.fetch = async (...args) => {
        if (String(args[0]) === obsoleteURL && globalThis.__delayedMPYFetchCount === 0) {
          globalThis.__delayedMPYFetchCount += 1;
          await new Promise(resolve => { globalThis.__releaseMPYFetch = resolve; });
        }
        return nativeFetch(...args);
      };
    })()`);
    await appendMetricSources(tm, [obsolete]);
    await tm.waitFor(async () => await tm.eval('globalThis.__delayedMPYFetchCount === 1'),
      { timeout: 4000, message: 'obsolete native source read held in flight' });
    await tm.page.evaluate(href => { document.querySelector('#current-mpy').href = href; },
      'data:text/csv;base64,' + current.base64);
    await tm.eval('globalThis.__releaseMPYFetch()');
    await metricPass(tm);
    assert.match(await tm.page.textContent('#lion-average-pass'), /6h\s+0m/,
      'only the replacement source can supply the completed-run duration');
    assert.equal((await log(tm)).length, 1);
    assert.equal((await notify(tm)).length, 1);
    assert.deepEqual(tm.errors, []);
  } finally {
    await tm.eval('globalThis.__releaseMPYFetch?.()').catch(() => {});
    await tm.close();
  }
});

test('a native passed anchor href update automatically detects PASS without another upload or download', async () => {
  const active = run();
  const { tm, server } = await openRamses(new RamsesServer([active]));
  let downloads = 0; tm.page.on('download', () => { downloads += 1; });
  try {
    await publishCsv(tm, []);
    await quiet(tm);
    await removeRunning(tm);
    const href = 'data:text/csv;base64,' + Buffer.from(csv([passed(active)])).toString('base64');
    await tm.page.evaluate(href => { document.querySelector('#native-passed-download').href = href; }, href);
    // No forced scan/poll: changing an existing anchor's attribute must drive
    // the automatic source reader just as inserting a fresh anchor does.
    await onePass(tm);
    assert.equal(downloads, 0);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('validated Ramses passed rows support Enter and background Ctrl/middle UUT navigation', async () => {
  const active = run();
  const { tm } = await openRamses(new RamsesServer([active]));
  try {
    await removeRunning(tm); await publishCsv(tm, [passed(active)]); await onePass(tm);
    // The compact fixture places native rows under the movable alert panel.
    // Fold it through its actual UI so pointer navigation targets the row.
    await tm.page.click('#eve-alert-toggle');
    const node = tm.page.locator('#lion-ramses-passed tbody tr').filter({ hasText: active.serial }).locator('td').first();
    await node.focus(); await node.press('Enter');
    await node.click({ modifiers: ['Control'] }); await node.click({ button: 'middle' });
    await tm.waitFor(async () => (await tm.gm()).openedTabs.length === 3,
      { message: 'foreground and two background API-miss fallbacks' });
    const gm = await tm.gm();
    assert.deepEqual(gm.windowOpens, ['about:blank'], 'Enter reserves one foreground popup');
    assert.equal(gm.openedTabs.length, 3, 'foreground fallback and Ctrl/middle clicks each navigate once');
    for (const target of gm.openedTabs) {
      const url = new URL(target); const params = new URLSearchParams(url.hash.slice(1));
      assert.equal(url.pathname, '/uut/gpu_jbog_test/list');
      assert.equal(params.get('eveLionSn'), active.serial);
      assert.equal(params.get('eveLionStarted'), active.started);
    }
    assert.ok(gm.xhr.every(url => url.includes('/api/v1/uut_status/view')), 'UUT navigation uses only its own API');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('without the native autorefresh iframe a source reload after 60 seconds preserves observations and failure claims', async () => {
  const active = run(); const initial = failed({ id: 'initial', serial: '2699YW1006' });
  const added = failed(); const server = new RamsesServer([active], [initial]);
  const { tm } = await openRamses(server);
  try {
    await appendFailed(tm, added); await failureCount(tm);
    server.online = [initial, added];
    const navigation = tm.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
    await tm.eval(`(() => {
      const actualNow = Date.now.bind(Date);
      Date.now = () => actualNow() + 61000;
      __eve.refreshLionKing();
    })()`).catch(error => {
      // A real reload may invalidate this isolated context before CDP returns.
      if (!/context|navigation|destroyed/i.test(error.message)) throw error;
    });
    await navigation;
    await tm.waitFor(() => tm.page.$('#lion-csv-feedback'), { message: 'automatic reload restored controls' });
    await tm.eval('__eve.scanLionKing()');
    assert.equal(server.requests.filter(request => request.includes(':8001/?dashboard=jbog')).length, 2,
      'the fallback performs an actual authenticated source navigation');
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.equal((await log(tm)).length, 1); assert.equal(await cards(tm), 1);
    assert.deepEqual(await notify(tm), [], 'the reload does not replay the recorded failed-board entry');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('the recognized native autorefresh iframe prevents a redundant fallback source reload', async () => {
  const active = run(); const server = new RamsesServer([active]); server.nativeRefresh = true;
  const { tm } = await openRamses(server);
  try {
    await tm.eval(`(() => {
      const actualNow = Date.now.bind(Date);
      Date.now = () => actualNow() + 61000;
      __eve.refreshLionKing();
    })()`);
    await quiet(tm);
    assert.equal(server.requests.filter(request => request.includes(':8001/?dashboard=jbog')).length, 1,
      'the app owns source refresh when its known native component is present');
    assert.equal((await states(tm))[runKey(active)].status, 'RUNNING');
    assert.deepEqual(server.unrouted, []);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('area Show toggles filter both GPU and PRETEST running rows while other areas stay visible and quiet', async () => {
  const active = run();
  const pretest = run({ id: 'pretest', serial: '2699YW1002', status: 'PRETEST', operation: 'GPU_JBOG_TEST_PRETEST' });
  const other = run({ id: 'other', serial: '2699YW1003' });
  const { tm } = await openRamses(new RamsesServer([active, pretest, other]));
  try {
    for (const [serial, area] of [[active.serial, 'b6'], [pretest.serial, 'b6'], [other.serial, 'lionking2']]) {
      await tm.page.locator('details:has(#lion-area-serial)').evaluate(el => { el.open = true; });
    await tm.page.fill('#lion-area-serial', serial);
      await tm.page.selectOption('#lion-area-choice', area);
      await tm.page.click('#lion-area-save');
    }
    assert.equal(await tm.page.textContent('.eve-section-row[data-section="b6"] .eve-stat-pretest b'), '1',
      'PRETEST entries have their own accurate area count');
    assert.equal(await tm.page.textContent('.eve-section-row[data-section="b6"] .eve-stat-testing b'), '1',
      'GPU running count excludes PRETEST');
    await tm.page.uncheck('.eve-section-row[data-section="b6"] .eve-show-checkbox');
    assert.equal(await tm.page.$eval('[data-ramses-run="active"]', element => element.hidden), true);
    assert.equal(await tm.page.$eval('[data-ramses-run="pretest"]', element => element.hidden), true,
      'PRETEST is an independent state but follows its assigned area visibility');
    assert.equal(await tm.page.$eval('[data-ramses-run="other"]', element => element.hidden), false);
    await quiet(tm);
    await tm.page.check('.eve-section-row[data-section="b6"] .eve-show-checkbox');
    assert.equal(await tm.page.$eval('[data-ramses-run="active"]', element => element.hidden), false);
    assert.equal(await tm.page.$eval('[data-ramses-run="pretest"]', element => element.hidden), false);
    assert.equal(await tm.page.$eval('[data-ramses-run="other"]', element => element.hidden), false);
    await quiet(tm);
    assert.equal((await states(tm))[runKey(pretest)], undefined, 'visibility changes never fabricate a completed-test baseline');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});
