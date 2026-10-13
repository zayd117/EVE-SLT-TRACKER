// Corrupt historical rows must not disable valid runs. Restored snapshots are
// explicitly stale display data, never evidence of a new completion. All
// fixtures use the real userscript in its isolated Tampermonkey world.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES } from './harness/userscript.mjs';
import { withEnabledLionRows } from './harness/lion.mjs';
import { FixtureServer } from './harness/server.mjs';

const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
const CACHE_KEY = 'lionKingTrackerSnapshot';
const HEADERS = ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'];
const LOGIN_HTML = '<!doctype html><html><head><title>Sign in</title></head><body>' +
  '<form><input type="password" name="password"><button>Log in</button></form></body></html>';
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const makeRun = (id = 'a', values = {}) => ({
  id, jbog: id === 'a' ? '1' : '2', tail: id === 'a' ? '2699YW1001' : '2699YW1002',
  head: id === 'a' ? '2699YW2001' : '2699YW2002',
  started: new Date(Math.floor((Date.now() - 3600000) / 1000) * 1000).toISOString(),
  color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01', ...values
});
const rowHtml = row => `<tr data-resilience-run="${escape(row.id)}"><td>${escape(row.jbog)}</td>` +
  `<td>${escape(row.tail)}</td><td>${escape(row.head)}</td><td>${escape(row.started)}</td>` +
  `<td bgcolor="${escape(row.color)}">${escape(row.text)}</td></tr>`;
const keyFor = row => JSON.stringify([row.tail.toUpperCase(), row.head.toUpperCase(), Date.parse(row.started)]);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class ResilienceServer extends FixtureServer {
  constructor(rows = [makeRun()]) {
    super();
    this.rows = rows;
    this.footer = '';
    this.html = null;
    this.held = null;
  }
  holdNextDocument() {
    this.held = { requested: deferred(), release: deferred() };
    return this.held;
  }
  render() {
    const blocker = this.held ? '<script src="/fixture/lion-resilience-block.js"></script>' : '';
    const rows = this.rows.map((row, index) => rowHtml(row) + (index === 0 ? blocker : '')).join('');
    return '<!doctype html><html><head><title>EVE LionKing GPU_JBOG_TEST</title></head><body>' +
      '<h2>EVE LionKing GPU_JBOG_TEST</h2><table id="resilience-source"><thead><tr>' +
      HEADERS.map(header => `<th>${header}</th>`).join('') + '</tr></thead><tbody>' +
      rows + this.footer + '</tbody></table><p id="resilience-end">Document received.</p></body></html>';
  }
  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      return { status: 200, contentType: 'text/html', body: this.html || this.render() };
    }
    if (url.host === 'rack.test' && url.pathname === '/fixture/lion-resilience-block.js' && this.held) {
      this.held.requested.resolve();
      await this.held.release.promise;
      return { status: 200, contentType: 'application/javascript', body: 'window.resilienceBlockReleased = true;' };
    }
    return super.respond(url, req);
  }
}

async function openResilience(server = new ResilienceServer(), options = {}) {
  const source = instrument(SCRIPT_SOURCE, [...new Set([
    ...HOOK_NAMES, 'scanLionKing', 'getLionKingSnapshot', 'refreshLionKing'
  ])]);
  const tm = await openWithScript(browser, LION_URL, server, withEnabledLionRows({ source, ...options }));
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'Lion controls' });
  await tm.eval('__eve.scanLionKing()');
  return { tm, server };
}
const logs = tm => tm.eval('__eve.getAlertLog()');
const prior = tm => tm.eval('__eve.state().previousStates');
const health = tm => tm.page.textContent('#eve-health-chip');
const healthDetail = tm => tm.page.getAttribute('#eve-health-chip', 'title');
const cacheRaw = tm => tm.page.evaluate(key => localStorage.getItem(key), CACHE_KEY);
const snapshot = tm => tm.eval(`(() => {
  const value = __eve.getLionKingSnapshot();
  return value && { rows: value.rows, invalidRows: value.invalidRows };
})()`);
async function mutate(tm, id, values) {
  await tm.page.evaluate(({ id, values }) => {
    const row = document.querySelector(`[data-resilience-run="${id}"]`);
    if (!row) throw new Error('Missing fixture row ' + id);
    if (values.text !== undefined) row.cells[4].textContent = values.text;
    if (values.color !== undefined) row.cells[4].setAttribute('bgcolor', values.color);
    if (values.started !== undefined) row.cells[3].textContent = values.started;
  }, { id, values });
  await tm.eval('__eve.scanLionKing()');
}
async function waitEvents(tm, count) {
  await tm.waitFor(async () => (await logs(tm)).length === count,
    { timeout: 4000, message: `${count} observed valid-run completions` });
  await tm.waitFor(async () => (await tm.gm()).notifications.length === count,
    { timeout: 4000, message: `${count} valid-run desktop notifications` });
}
async function assertQuiet(tm) {
  await tm.page.waitForTimeout(350);
  assert.deepEqual(await logs(tm), [], 'no cached or quarantined completion log');
  assert.deepEqual((await tm.gm()).notifications, [], 'no cached or quarantined desktop alert');
  assert.equal(await tm.page.locator('.eve-alert').count(), 0, 'no cached or quarantined alert card');
}

test('one invalid historical Started value degrades one row while a valid observed run still completes once', async () => {
  const running = makeRun();
  const old = makeRun('bad', { started: '0000-00-00 00:00:00', color: 'darkgreen', text: '05:58' });
  const { tm } = await openResilience(new ResilienceServer([running, old]));
  try {
    assert.equal(await health(tm), 'DEGRADED');
    assert.match(await healthDetail(tm), /1.*(?:row|invalid|quarantin)|(?:row|invalid|quarantin).*1/i);
    assert.equal((await snapshot(tm)).rows.length, 1);
    assert.equal((await snapshot(tm)).invalidRows, 1);
    assert.equal((await prior(tm))[keyFor(running)].status, 'RUNNING');
    await assertQuiet(tm);
    await mutate(tm, 'a', { color: 'darkgreen', text: '05:58' });
    await waitEvents(tm, 1);
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await logs(tm)).length, 1);
    assert.equal((await logs(tm))[0].tailSerial, running.tail);
    assert.equal(await health(tm), 'DEGRADED', 'bad history remains visible as degraded coverage');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a malformed colspan footer is quarantined without preventing a valid run from completing', async () => {
  const row = makeRun();
  const server = new ResilienceServer([row]);
  server.footer = '<tr data-resilience-footer><td colspan="5">Malformed historical footer</td></tr>';
  const { tm } = await openResilience(server);
  try {
    assert.equal(await health(tm), 'DEGRADED');
    assert.equal((await snapshot(tm)).invalidRows, 1);
    assert.equal((await prior(tm))[keyFor(row)].status, 'RUNNING');
    await mutate(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await waitEvents(tm, 1);
    assert.equal((await logs(tm))[0].result, 'FAIL');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('conflicting duplicate outcomes quarantine every copy of that run, preserve its baseline, and allow another run to complete', async () => {
  const a = makeRun();
  const b = makeRun('b');
  const { tm } = await openResilience(new ResilienceServer([a, b]));
  try {
    await tm.page.evaluate(duplicate => {
      const source = document.querySelector('[data-resilience-run="a"]');
      source.cells[4].setAttribute('bgcolor', 'darkgreen'); source.cells[4].textContent = '05:58';
      source.insertAdjacentHTML('afterend', duplicate);
      const other = document.querySelector('[data-resilience-run="b"]');
      other.cells[4].setAttribute('bgcolor', 'red'); other.cells[4].textContent = 'CHECK_GPU : 03:12';
    }, rowHtml({ ...a, id: 'a-conflict', color: 'red', text: 'CHECK_GPU : 03:12' }));
    await tm.eval('__eve.scanLionKing()');
    const s = await snapshot(tm);
    assert.equal(s.rows.some(row => row.key === keyFor(a)), false,
      'the PASS copy is removed along with the conflicting FAIL copy');
    assert.equal((await prior(tm))[keyFor(a)].status, 'RUNNING', 'quarantined run remains eligible for repair');
    await waitEvents(tm, 1);
    assert.equal((await logs(tm))[0].tailSerial, b.tail);
    assert.equal(await health(tm), 'DEGRADED');
    await tm.page.evaluate(() => document.querySelector('[data-resilience-run="a-conflict"]').remove());
    await tm.eval('__eve.scanLionKing()');
    await waitEvents(tm, 2);
    assert.deepEqual((await logs(tm)).map(row => row.tailSerial).sort(), [a.tail, b.tail].sort());
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await logs(tm)).length, 2);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a soft refresh accepts its valid rows despite malformed history, preserves controls, and records a valid completion', async () => {
  const row = makeRun();
  const { tm, server } = await openResilience(new ResilienceServer([row]));
  try {
    await tm.page.selectOption('#lion-history-hours', '48');
    server.rows = [{ ...row, color: 'darkgreen', text: '05:58' },
      makeRun('bad', { started: '0000-00-00 00:00:00', color: 'red' })];
    await tm.eval('__eve.refreshLionKing()');
    await waitEvents(tm, 1);
    assert.equal(await tm.page.inputValue('#lion-history-hours'), '48');
    assert.equal(await tm.page.locator('#eve-tracker-panel').count(), 1);
    assert.equal(await health(tm), 'DEGRADED');
    assert.equal((await snapshot(tm)).invalidRows, 1);
    const cached = JSON.parse(await cacheRaw(tm));
    assert.equal(cached.rows.length, 1, 'persistent display excludes quarantined rows');
    assert.equal(cached.rows[0].tailSerial, row.tail);
    assert.equal(cached.rows[0].status, 'PASS');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('all-invalid and login refreshes retain the last valid table, display cache, and running baseline', async () => {
  const row = makeRun();
  const { tm, server } = await openResilience(new ResilienceServer([row]));
  try {
    const saved = await cacheRaw(tm);
    assert.ok(saved, 'a validated source persists display data');
    const savedStates = await prior(tm);
    server.rows = [makeRun('bad', { started: '0000-00-00 00:00:00', color: 'red' })];
    await tm.eval('__eve.refreshLionKing()');
    assert.equal((await snapshot(tm)).rows[0].tailSerial, row.tail);
    assert.equal(await cacheRaw(tm), saved, 'all-invalid response cannot replace display cache');
    assert.deepEqual(await prior(tm), savedStates);
    assert.equal(await health(tm), 'DEGRADED');
    server.html = LOGIN_HTML;
    await tm.eval('__eve.refreshLionKing()');
    assert.equal((await snapshot(tm)).rows[0].tailSerial, row.tail);
    assert.equal(await cacheRaw(tm), saved, 'login response cannot replace display cache');
    assert.deepEqual(await prior(tm), savedStates);
    await assertQuiet(tm);
    server.html = null;
    server.rows = [{ ...row, color: 'darkgreen', text: '05:58' }];
    await tm.eval('__eve.refreshLionKing()');
    await waitEvents(tm, 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a reload into a login page restores stale display data and settings without importing cached results as monitoring baselines', async () => {
  const row = makeRun('a', { color: 'darkgreen', text: '05:58' });
  const { tm, server } = await openResilience(new ResilienceServer([row]));
  let fresh;
  try {
    await tm.page.selectOption('#lion-history-hours', '48');
    await tm.page.selectOption('#eve-refresh-interval', '20');
    await tm.page.uncheck('.eve-section-row[data-section="b6"] .eve-show-checkbox');
    const saved = await cacheRaw(tm);
    assert.ok(saved, 'a validated source persists display data');
    const cached = JSON.parse(saved);
    assert.equal(cached.version, 1);
    assert.equal(cached.origin, 'https://rack.test');
    assert.equal(cached.path, '/out/out.evelionking_all.php');
    assert.equal(cached.rows[0].tailSerial, row.tail);
    assert.ok(Number.isFinite(cached.savedAt));
    server.html = LOGIN_HTML;
    // A fresh tab shares the persistent display cache/settings but starts with
    // no per-tab RUNNING baseline. Reload it to exercise reinjection without
    // falsely treating beforeunload's legitimate baseline save as cache import.
    ({ tm: fresh } = await openResilience(server, { context: tm.context }));
    await fresh.reload();
    await fresh.page.locator('#lion-cached-source').waitFor({ state: 'visible', timeout: 3000 });
    assert.match(await fresh.page.textContent('#lion-cached-source'), new RegExp(row.tail));
    assert.match(await fresh.page.textContent('#eve-tracker-panel'), /cached|saved|stale/i,
      'restored data is visibly distinguished from live source observations');
    assert.notEqual(await health(fresh), 'OK', 'cached data must not claim live freshness');
    assert.equal(await snapshot(fresh), null, 'cached display is excluded from source discovery');
    assert.deepEqual(await prior(fresh), {}, 'display cache cannot seed RUNNING or terminal monitoring state');
    assert.equal(await cacheRaw(fresh), saved, 'reloading stale data cannot refresh its savedAt');
    assert.equal(await fresh.page.inputValue('#lion-history-hours'), '48');
    assert.equal(await fresh.page.inputValue('#eve-refresh-interval'), '20');
    assert.equal(await fresh.page.isChecked('.eve-section-row[data-section="b6"] .eve-show-checkbox'), false);
    await assertQuiet(fresh);
    assert.deepEqual(fresh.errors, []);
  } finally { await fresh?.close(); await tm.close(); }
});

test('a saved snapshot is visible during a blocked document reload but cannot consume a live partial result', async () => {
  const row = makeRun();
  const { tm, server } = await openResilience(new ResilienceServer([row]));
  let reloading;
  let gate;
  try {
    const saved = await cacheRaw(tm);
    assert.ok(saved, 'a validated source persists display data');
    const states = await prior(tm);
    server.rows = [{ ...row, color: 'darkgreen', text: '05:58' }, makeRun('b')];
    gate = server.holdNextDocument();
    reloading = tm.reload();
    reloading.catch(() => {});
    await gate.requested.promise;
    await tm.page.locator('#lion-cached-source').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await tm.page.evaluate(() => document.readyState), 'loading');
    assert.equal(await tm.page.locator('#resilience-source tbody tr').count(), 1,
      'the fixture is genuinely incomplete');
    assert.match(await tm.page.textContent('#lion-cached-source'), new RegExp(row.tail));
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.deepEqual(await prior(tm), states, 'partial PASS cannot consume the saved RUNNING baseline');
    assert.equal(await cacheRaw(tm), saved, 'partial source cannot overwrite the last display snapshot');
    assert.equal(await health(tm), 'LOADING');
    await assertQuiet(tm);
    gate.release.resolve();
    await reloading;
    await waitEvents(tm, 1);
    assert.equal((await logs(tm))[0].tailSerial, row.tail);
    assert.equal(await tm.page.locator('#lion-cached-source').count(), 0,
      'validated live data replaces the stale display table');
    assert.deepEqual(tm.errors, []);
  } finally {
    gate?.release.resolve();
    await reloading?.catch(() => {});
    await tm.close();
  }
});

test('corrupt, foreign-origin, and oversized saved snapshots are ignored without alerts or monitoring baselines', async () => {
  const row = makeRun();
  const plainRow = { jbog: row.jbog, tailSerial: row.tail, headSerial: row.head,
    started: row.started, startedAt: Date.parse(row.started), status: 'PASS', statusText: '05:58',
    durationMs: 358 * 60000, detailUrl: '', key: keyFor(row) };
  const valid = { version: 1, path: '/out/out.evelionking_all.php', origin: 'https://rack.test',
    savedAt: Date.now(), rows: [plainRow] };
  const cases = [
    '{invalid JSON',
    JSON.stringify({ ...valid, origin: 'https://foreign.test' }),
    JSON.stringify({ ...valid, rows: Array.from({ length: 17000 }, () => plainRow) }),
    JSON.stringify({ ...valid, rows: [{ ...plainRow, started: 'not-a-time' }] })
  ];
  for (const raw of cases) {
    const server = new ResilienceServer(); server.html = LOGIN_HTML;
    const { tm } = await openResilience(server, { rawLocalStorage: { [CACHE_KEY]: raw } });
    try {
      assert.equal(await tm.page.locator('#lion-cached-source').count(), 0, 'invalid cache is not rendered');
      assert.deepEqual(await prior(tm), {}, 'invalid cache cannot initialize monitoring');
      assert.notEqual(await health(tm), 'OK');
      await assertQuiet(tm);
      assert.deepEqual(tm.errors, []);
    } finally { await tm.close(); }
  }
});

test('manual node-area assignment rejects a rack barcode and explains that a node serial is required', async () => {
  const { tm } = await openResilience();
  try {
    await tm.page.locator('details:has(#lion-area-serial)').evaluate(el => { el.open = true; });
    await tm.page.fill('#lion-area-serial', 'TA.B6-EVE03');
    await tm.page.selectOption('#lion-area-choice', 'b6');
    await tm.page.click('#lion-area-save');
    assert.match(await tm.page.textContent('#lion-area-feedback'), /node serial/i);
    assert.equal(await tm.eval('__eve.state().settings.lionAreas["TA.B6-EVE03"]'), undefined,
      'a physical rack barcode cannot masquerade as a node assignment');
    assert.doesNotMatch(await tm.page.textContent('#lion-area-feedback'), /saved\./i);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('a valid node still opens the Lion UUT list when another historical row is quarantined', async () => {
  const row = makeRun();
  const bad = makeRun('bad', { started: '0000-00-00 00:00:00', color: 'red' });
  const { tm, server } = await openResilience(new ResilienceServer([row, bad]));
  try {
    const cell = tm.page.locator('[data-resilience-run="a"] td').nth(2);
    await cell.click({ modifiers: ['Control'] });
    await tm.waitFor(async () => (await tm.gm()).openedTabs.length === 1,
      { timeout: 3000, message: 'valid node UUT navigation despite corrupt historical row' });
    const url = new URL((await tm.gm()).openedTabs[0]);
    assert.equal(url.pathname, '/uut/gpu_jbog_test/list');
    const selection = new URLSearchParams(url.hash.slice(1));
    assert.equal(selection.get('eveLionSn'), row.head);
    assert.equal(selection.get('eveLionStarted'), row.started);
    assert.equal(server.requests.filter(request => /\/slt\/|eveserverdetail|jira/.test(request)).length, 0,
      'mixed history cannot divert a valid Lion node into SLT or Jira');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});
