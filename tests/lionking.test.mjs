// Lion King fixture tests run the complete installed userscript in its isolated
// Tampermonkey world. Every page/request is synthetic and stays in the router.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES
} from './harness/userscript.mjs';
import { withEnabledLionRows } from './harness/lion.mjs';
import { FixtureServer, RACK_URL } from './harness/server.mjs';

const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
const lionTestView = (serial, started) => 'https://testview-eve-fmt.hyvesolutions.org/uut/gpu_jbog_test/list#' +
  new URLSearchParams({ eveLionSn: serial, eveLionStarted: started, eveLionOperation: 'GPU_JBOG_TEST' }).toString();
const HEADERS = ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'];
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

function siteDate(agoHours = 1) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(Date.now() - agoHours * 3600000));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const run = (id = 'a', extra = {}) => ({
  id, jbog: id === 'a' ? '1' : '2', tail: id === 'a' ? '2699YW1001' : '2699YW1002',
  head: id === 'a' ? '2699YW2001' : '2699YW2002', started: siteDate(),
  color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01', ...extra
});

class LionServer extends FixtureServer {
  constructor(rows = [run()]) {
    super();
    this.rows = rows;
    this.headers = [...HEADERS];
    this.lionStatus = 200;
    this.lionHtml = null;
  }
  render() {
    const rows = this.rows.map(r => {
      const tail = r.detail ? `<a href="${escape(r.detail)}">${escape(r.tail)}</a>` : escape(r.tail);
      return `<tr data-lion-fixture="${escape(r.id)}"><td>${escape(r.jbog)}</td><td>${tail}</td>` +
        `<td>${escape(r.head)}</td><td>${escape(r.started)}</td>` +
        `<td bgcolor="${escape(r.color)}">${escape(r.text)}</td></tr>`;
    }).join('');
    return `<!doctype html><html><head><title>EVE LionKing GPU_JBOG_TEST</title>` +
      '<meta http-equiv="refresh" content="60"></head><body><h2>EVE LionKing GPU_JBOG_TEST</h2>' +
      `<div>Total:${this.rows.length}</div><table id="lion-source"><thead><tr>` +
      this.headers.map(h => `<th>${escape(h)}</th>`).join('') +
      `</tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }
  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      return { status: this.lionStatus, contentType: 'text/html', body: this.lionHtml || this.render() };
    }
    return super.respond(url, req);
  }
}

function source() {
  return instrument(SCRIPT_SOURCE, [...new Set([
    ...HOOK_NAMES, 'getLionKingSnapshot', 'normalizeLionKingStatus', 'scanLionKing',
    'parseLionKingDuration', 'lionKingPassAverage'
  ])]);
}
async function openLion(server = new LionServer(), options = {}) {
  const tm = await openWithScript(browser, LION_URL, server, withEnabledLionRows({ source: source(), ...options }));
  await tm.waitFor(() => tm.page.$('#lion-history-hours'), { message: 'Lion King controls' });
  await tm.eval('__eve.scanLionKing()');
  return { tm, server };
}
const logs = tm => tm.eval('__eve.getAlertLog()');
const notifications = async tm => (await tm.gm()).notifications;
const cards = tm => tm.page.$$eval('.eve-alert', elements => elements.map(el => el.textContent));
const snapshot = tm => tm.eval(`(() => {
  const s = __eve.getLionKingSnapshot();
  return s && { rows: s.rows, invalidRows: s.invalidRows, unknownStatuses: s.unknownStatuses };
})()`);
async function change(tm, id, values) {
  await tm.page.evaluate(({ id, values }) => {
    const row = document.querySelector(`[data-lion-fixture="${id}"]`);
    if (!row) throw new Error(`missing Lion fixture row ${id}`);
    const fields = { jbog: 0, tail: 1, head: 2, started: 3, text: 4 };
    for (const [field, index] of Object.entries(fields)) {
      if (field in values) row.cells[index].textContent = values[field];
    }
    if ('color' in values) row.cells[4].setAttribute('bgcolor', values.color);
  }, { id, values });
  await tm.eval('__eve.scanLionKing()');
}
async function eventCount(tm, count) {
  await tm.waitFor(async () => (await logs(tm)).length === count, { message: `${count} Lion log entries` });
}
const visibleRows = tm => tm.page.$$eval('#lion-source tbody tr', rows => rows
  .filter(row => !row.hidden && getComputedStyle(row).display !== 'none')
  .map(row => row.dataset.lionFixture));
async function quiet(tm) {
  await tm.page.waitForTimeout(450);
  assert.equal((await logs(tm)).length, 0, 'no historical alerts logged');
  assert.deepEqual(await notifications(tm), [], 'no historical desktop notifications');
  assert.deepEqual(await cards(tm), [], 'no historical alert cards');
}

test('one installed script chooses Lion King, preserves the five-column source, and starts silently', async () => {
  const server = new LionServer([run(), run('b', { color: 'red', text: 'X11-2C.TEST -- CHECK_GPU : 03:12' }),
    run('c', { jbog: '3', tail: '2699YW1003', head: '2699YW2003', color: 'darkgreen', text: '06:58' })]);
  const { tm } = await openLion(server);
  try {
    assert.match(await tm.page.textContent('#eve-tracker-panel'), /EVE SLT\+JBOG TRACKER/);
    assert.deepEqual(await tm.page.$$eval('#lion-source th', els => els.map(el => el.textContent)), HEADERS);
    const s = await snapshot(tm);
    assert.equal(s.invalidRows, 0);
    assert.equal(s.unknownStatuses, 0);
    assert.deepEqual(s.rows.map(row => row.status), ['RUNNING', 'FAIL', 'PASS']);
    assert.ok(Math.abs(s.rows[0].startedAt - (Date.now() - 3600000)) < 10000,
      'collector Started is interpreted in Pacific time even with the browser in UTC');
    await quiet(tm);
    assert.equal(server.requests.filter(r => /eveserverdetail|\/api\/|jira/.test(r)).length, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('status words are exact; model/step/elapsed text uses recognized colors only', async () => {
  const { tm } = await openLion();
  try {
    const cases = [
      { text: ' pass ', color: '', want: 'PASS' }, { text: 'FAIL', color: '', want: 'FAIL' },
      { text: 'RUNNING', color: '', want: 'RUNNING' },
      { text: 'X11-2C.TEST -- : 00:01', color: 'lightgreen', want: 'RUNNING' },
      { text: '06:58', color: 'darkgreen', want: 'PASS' },
      { text: '06:58', color: '#008000', want: 'PASS' },
      { text: 'X11-2C.TEST -- VERIFY_OSFP_LINKS 02:59', color: 'rgb(255, 0, 0)', want: 'FAIL' },
      { text: 'CHECK_PASS : 00:01', color: 'gray', want: 'UNKNOWN' },
      { text: 'PASS', color: 'red', want: 'UNKNOWN' },
      { text: 'FAIL', color: 'darkgreen', want: 'UNKNOWN' },
      { text: 'RUNNING', color: 'darkgreen', want: 'UNKNOWN' },
      { text: 'UNKNOWN', color: '', want: 'UNKNOWN' }
    ];
    const actual = await tm.eval(`(${JSON.stringify(cases)}).map(c => {
      const cell = document.createElement('td'); cell.textContent = c.text;
      if (c.color) cell.setAttribute('bgcolor', c.color);
      return __eve.normalizeLionKingStatus(cell);
    })`);
    assert.deepEqual(actual, cases.map(c => c.want));
  } finally { await tm.close(); }
});

test('a completed PASS and FAIL each create one Lion event without SLT confirmation lookups', async () => {
  const { tm, server } = await openLion(new LionServer([run(), run('b')]));
  try {
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await change(tm, 'b', { color: 'red', text: 'X11-2C.TEST -- HOST_POWER_ON_PRETEST : 04:01' });
    await eventCount(tm, 2);
    await tm.waitFor(async () => (await cards(tm)).length === 2, { message: 'Lion PASS and FAIL cards' });
    const entries = await logs(tm);
    assert.deepEqual(entries.map(e => e.transition).sort(), ['TEST_FAILURE', 'TEST_SUCCESS']);
    assert.ok(entries.every(e => e.tracker === 'lionking'));
    assert.ok(entries.every(e => /^2699YW/.test(e.tailSerial) && /^2699YW/.test(e.headSerial)));
    assert.equal(server.requests.filter(r => /eveserverdetail|\/api\/v1\/server_level_tests/.test(r)).length, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('both TailNode and HeadNode remain visible and searchable in the reused alert panel', async () => {
  const { tm } = await openLion();
  try {
    await change(tm, 'a', { color: 'red', text: 'X11-2C.TEST -- CHECK_GPU : 02:59' });
    await eventCount(tm, 1);
    await tm.waitFor(() => tm.page.$('.eve-alert'), { message: 'Lion alert card' });
    assert.match((await cards(tm))[0], /2699YW1001/);
    assert.match((await cards(tm))[0], /2699YW2001/);
    const nodes = await tm.page.$$eval('.eve-alert .lion-node-serial', els => els.map(e => e.dataset.node).sort());
    assert.deepEqual(nodes, ['head', 'tail']);
    for (const serial of ['2699YW1001', '2699YW2001']) {
      await tm.page.fill('#eve-alert-search', serial);
      assert.equal(await tm.page.$eval('.eve-alert', el => getComputedStyle(el).display !== 'none'), true);
    }
    await tm.page.fill('#eve-alert-search', '2699YW9999');
    assert.equal(await tm.page.$eval('.eve-alert', el => getComputedStyle(el).display !== 'none'), false);
  } finally { await tm.close(); }
});

test('24-hour noise filter hides old completed rows, keeps old running, and offers 48 hours or all', async () => {
  const server = new LionServer([
    run('a', { started: siteDate(40), color: 'lightgreen' }),
    run('b', { started: siteDate(30), color: 'darkgreen', text: '06:58' }),
    run('c', { started: siteDate(60), color: 'red', text: 'CHECK_GPU : 03:12' }),
    run('d', { started: siteDate(2), color: 'red', text: 'CHECK_GPU : 03:12' })
  ]);
  const { tm } = await openLion(server);
  try {
    assert.equal(await tm.page.$eval('#lion-history-hours', el => el.value), '24');
    assert.deepEqual(await visibleRows(tm), ['a', 'd']);
    await tm.page.selectOption('#lion-history-hours', '48');
    assert.deepEqual(await visibleRows(tm), ['a', 'b', 'd']);
    await tm.page.selectOption('#lion-history-hours', 'all');
    assert.deepEqual(await visibleRows(tm), ['a', 'b', 'c', 'd']);
    await quiet(tm);
  } finally { await tm.close(); }
});

test('ordinal renumbering and row reordering preserve run identity and cannot create duplicate events', async () => {
  const { tm } = await openLion(new LionServer([run(), run('b')]));
  try {
    const original = (await snapshot(tm)).rows.find(row => row.tailSerial === '2699YW1001').key;
    await change(tm, 'a', { jbog: '27' });
    await tm.page.evaluate(() => {
      const body = document.querySelector('#lion-source tbody');
      body.prepend(body.lastElementChild);
    });
    await tm.eval('__eve.scanLionKing()');
    assert.equal((await snapshot(tm)).rows.find(row => row.tailSerial === '2699YW1001').key, original);
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await eventCount(tm, 1);
    await change(tm, 'a', { jbog: '99' });
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await logs(tm)).length, 1);
    assert.equal((await notifications(tm)).length, 1);
  } finally { await tm.close(); }
});

test('unseen terminal rows remain quiet; a new Started value permits a later observed retest event', async () => {
  const { tm } = await openLion();
  try {
    await tm.page.evaluate(rowHtml => document.querySelector('#lion-source tbody').insertAdjacentHTML('beforeend', rowHtml),
      `<tr data-lion-fixture="b"><td>2</td><td>2699YW1002</td><td>2699YW2002</td><td>${siteDate(2)}</td><td bgcolor="red">CHECK_GPU : 03:12</td></tr>`);
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
    await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await eventCount(tm, 1);
    await change(tm, 'a', { started: siteDate(0.1), color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01' });
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await eventCount(tm, 2);
    assert.deepEqual((await logs(tm)).map(e => e.transition), ['TEST_FAILURE', 'TEST_SUCCESS']);
  } finally { await tm.close(); }
});

test('the HeadNode belongs to run identity, and a completed identity cannot complete again', async () => {
  const { tm } = await openLion();
  try {
    const original = (await snapshot(tm)).rows[0].key;
    await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await eventCount(tm, 1);
    // Transient table changes/corrections do not establish a new test run.
    await change(tm, 'a', { color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01' });
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    assert.equal((await logs(tm)).length, 1, 'same pair and Started is already complete');
    await change(tm, 'a', { head: '2699YW2009', color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01' });
    assert.notEqual((await snapshot(tm)).rows[0].key, original, 'a different head changes the pair identity');
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await eventCount(tm, 2);
  } finally { await tm.close(); }
});

test('node buttons copy either serial; cards open the Lion GPU_JBOG_TEST list while validating collector links', async () => {
  const detail = '/out/out.eveserverdetail.php?facility=test&in=2699YW1001';
  const { tm, server } = await openLion(new LionServer([
    run('a', { detail }), run('b', { detail: 'https://untrusted.test/out/out.eveserverdetail.php?in=2699YW1002' })
  ]));
  try {
    const s = await snapshot(tm);
    assert.equal(s.rows[0].detailUrl, new URL(detail, LION_URL).href);
    assert.ok(!s.rows[1].detailUrl, 'foreign origin detail link rejected');
    await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await change(tm, 'b', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await eventCount(tm, 2);
    await tm.waitFor(async () => (await cards(tm)).length === 2, { message: 'two Lion cards' });
    const first = tm.page.locator('.eve-alert').filter({ hasText: '2699YW1001' });
    const second = tm.page.locator('.eve-alert').filter({ hasText: '2699YW1002' });
    await tm.eval('navigator.clipboard.writeText = t => { globalThis.__copied = t; return Promise.resolve(); }');
    await first.locator('.lion-node-serial[data-node="tail"]').click();
    assert.equal(await tm.eval('globalThis.__copied'), '2699YW1001');
    await second.locator('.lion-node-serial[data-node="head"]').click();
    assert.equal(await tm.eval('globalThis.__copied'), '2699YW2002');
    assert.deepEqual((await tm.gm()).windowOpens, [], 'copy does not navigate');
    await first.locator('.eve-alert-loc').click();
    await tm.waitFor(async () => (await tm.gm()).openedTabs.length === 1,
      { message: 'first API-miss fallback navigation' });
    await second.locator('.eve-alert-loc').click();
    await tm.waitFor(async () => (await tm.gm()).openedTabs.length === 2,
      { message: 'second API-miss fallback navigation' });
    const gm = await tm.gm();
    assert.deepEqual(gm.openedTabs, [lionTestView('2699YW1001', s.rows[0].started),
      lionTestView('2699YW1002', s.rows[1].started)]);
    assert.deepEqual(gm.windowOpens, ['about:blank', 'about:blank'], 'clicks reserve a popup before awaiting API results');
    assert.equal(server.requests.filter(r => /eveserverdetail|\/api\/v1\/server_level_tests/.test(r)).length, 0,
      'Lion clicks do not call the SLT confirmation API');
  } finally { await tm.close(); }
});

test('source JBOG and either node open the matching Lion TestView serial and Started run', async () => {
  const { tm } = await openLion();
  try {
    const started = (await snapshot(tm)).rows[0].started;
    for (const [index, column] of [1, 2, 3].entries()) {
      await tm.page.click(`[data-lion-fixture="a"] td:nth-child(${column})`);
      await tm.waitFor(async () => (await tm.gm()).openedTabs.length === index + 1,
        { message: 'API-miss source-link fallback navigation' });
    }
    const gm = await tm.gm();
    assert.deepEqual(gm.openedTabs, [
      lionTestView('2699YW1001', started), lionTestView('2699YW1001', started),
      lionTestView('2699YW2001', started)
    ]);
    assert.ok(gm.xhr.every(url => url.includes('/api/v1/uut_status/view')), 'source navigation uses only the UUT API');
    await quiet(tm);
  } finally { await tm.close(); }
});

test('unknown color/text stays visible, creates no event, and preserves the prior running observation', async () => {
  const { tm } = await openLion();
  try {
    await change(tm, 'a', { color: 'gray', text: 'CHECK_PASS : 00:01' });
    const s = await snapshot(tm);
    assert.equal(s.rows[0].status, 'UNKNOWN');
    assert.equal(s.unknownStatuses, 1);
    assert.deepEqual(await visibleRows(tm), ['a']);
    await quiet(tm);
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await eventCount(tm, 1);
    assert.equal((await logs(tm))[0].transition, 'TEST_SUCCESS');
  } finally { await tm.close(); }
});

test('an observed run older than the history display window still alerts when it completes now', async () => {
  const { tm } = await openLion(new LionServer([run('a', { started: siteDate(40) })]));
  try {
    assert.deepEqual(await visibleRows(tm), ['a'], 'old RUNNING remains active');
    await change(tm, 'a', { color: 'darkgreen', text: '40:05' });
    await eventCount(tm, 1);
    assert.equal((await logs(tm))[0].transition, 'TEST_SUCCESS');
    assert.equal((await notifications(tm)).length, 1, 'new completion still notifies');
    assert.deepEqual(await visibleRows(tm), [], 'completed history filter is a display preference');
  } finally { await tm.close(); }
});

for (const failedKey of ['lionKingTrackerEventClaims', 'lionKingTrackerAlertLog']) {
  test(`failed ${failedKey} persistence can retry the same observed completion once storage recovers`, async () => {
    const { tm } = await openLion();
    try {
      await tm.eval(`(() => {
        const original = Storage.prototype.setItem;
        globalThis.__lionFailureKey = ${JSON.stringify(failedKey)};
        globalThis.__lionFailureAttempts = 0;
        Storage.prototype.setItem = function(key, value) {
          if (key === globalThis.__lionFailureKey) {
            globalThis.__lionFailureAttempts += 1;
            throw new DOMException('fixture quota exceeded', 'QuotaExceededError');
          }
          return original.call(this, key, value);
        };
      })()`);
      await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
      await tm.waitFor(() => tm.eval('globalThis.__lionFailureAttempts > 0'), { message: 'simulated quota failure' });
      await tm.page.waitForTimeout(100);
      assert.deepEqual(await notifications(tm), [], 'no toast before durable completion recording');
      await tm.eval('globalThis.__lionFailureKey = ""; __eve.scanLionKing()');
      await tm.waitFor(() => tm.page.evaluate(() =>
        JSON.parse(localStorage.getItem('lionKingTrackerAlertLog') || '[]').length === 1),
      { message: 'durable recovered completion log' });
      await tm.waitFor(async () => (await notifications(tm)).length === 1, { message: 'one recovered completion toast' });
      await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
      assert.equal((await logs(tm)).length, 1);
      assert.equal((await notifications(tm)).length, 1);
    } finally { await tm.close(); }
  });
}

test('a production-size historical page remains quiet and displays only current active runs by default', async () => {
  const old = siteDate(48), current = siteDate(1);
  const unique = n => n.toString(36).toUpperCase().padStart(4, '0');
  const rows = Array.from({ length: 4025 }, (_, i) => run(`scale-${i}`, {
    jbog: String(i + 1), tail: `2699YW${unique(i)}`, head: `2698YW${unique(i)}`,
    started: i < 4000 ? old : current,
    color: i < 4000 ? (i % 2 ? 'red' : 'darkgreen') : 'lightgreen',
    text: i < 4000 ? (i % 2 ? 'CHECK_GPU : 03:12' : '06:58') : 'X11-2C.TEST -- : 00:01'
  }));
  const { tm } = await openLion(new LionServer(rows));
  try {
    const s = await snapshot(tm);
    assert.equal(s.rows.length, 4025);
    assert.equal(s.invalidRows, 0);
    assert.equal(s.unknownStatuses, 0);
    assert.equal((await visibleRows(tm)).length, 25);
    assert.deepEqual(await tm.eval('__eve.lionKingPassAverage(__eve.getLionKingSnapshot().rows)'),
      { averageMs: null, samples: 0 }, 'historical PASS records do not distort current estimates');
    assert.equal(await tm.page.$eval('#eve-health-chip', el => getComputedStyle(el).display !== 'none'), true,
      'health remains visible without developer mode');
    await tm.waitFor(() => tm.page.textContent('#lion-data-age'), { message: 'last-page age' });
    await quiet(tm);
  } finally { await tm.close(); }
});

test('burst completions keep the latest 50 cards without dropping any audit events', async () => {
  const rows = Array.from({ length: 55 }, (_, i) => run(`burst-${i}`, {
    jbog: String(i + 1), tail: `2699YW${String(1000 + i)}`, head: `2699YW${String(2000 + i)}`
  }));
  const { tm } = await openLion(new LionServer(rows));
  try {
    await tm.page.evaluate(() => {
      for (const row of document.querySelectorAll('#lion-source tbody tr')) {
        row.cells[4].setAttribute('bgcolor', 'darkgreen');
        row.cells[4].firstChild.nodeValue = '06:58';
      }
    });
    await tm.eval('__eve.scanLionKing()');
    await eventCount(tm, 55);
    await tm.waitFor(async () => (await cards(tm)).length === 50, { message: '50 retained Lion cards' });
    const persisted = await tm.page.evaluate(() => ({
      alerts: JSON.parse(sessionStorage.getItem('lionKingTrackerActiveAlerts') || '[]'),
      log: JSON.parse(localStorage.getItem('lionKingTrackerAlertLog') || '[]')
    }));
    assert.equal(persisted.alerts.length, 50);
    assert.equal(persisted.log.length, 55);
    assert.equal(new Set(persisted.log.map(e => e.runKey)).size, 55);
    assert.equal((await notifications(tm)).length, 55);
  } finally { await tm.close(); }
});

test('schema errors and malformed Started values stop scanning without manufacturing terminal events', async () => {
  const { tm } = await openLion();
  try {
    await tm.page.evaluate(() => document.querySelector('#lion-source th').textContent = 'Rack');
    assert.equal(await snapshot(tm), null);
    await change(tm, 'a', { color: 'red' });
    await quiet(tm);
    await tm.page.evaluate(() => document.querySelector('#lion-source th').textContent = 'JBOG_NUM');
    await change(tm, 'a', { started: 'not a date' });
    assert.ok((await snapshot(tm)).invalidRows > 0);
    await quiet(tm);
    await change(tm, 'a', { started: '2026-02-30T10:00:00-08:00' });
    assert.ok((await snapshot(tm)).invalidRows > 0, 'ISO dates cannot silently normalize impossible calendar days');
    await quiet(tm);
  } finally { await tm.close(); }
});

test('ambiguous matching tables and merged data cells fail safely instead of selecting a guessed layout', async () => {
  const { tm } = await openLion();
  try {
    await tm.page.evaluate(() => {
      const copy = document.getElementById('lion-source').cloneNode(true);
      copy.id = 'lion-ambiguous'; document.body.appendChild(copy);
    });
    assert.equal(await snapshot(tm), null, 'two matching tables are ambiguous');
    await change(tm, 'a', { color: 'red' });
    await quiet(tm);
    await tm.page.evaluate(() => {
      document.getElementById('lion-ambiguous').remove();
      document.querySelector('#lion-source tbody tr').cells[1].colSpan = 2;
    });
    const s = await snapshot(tm);
    assert.ok(s === null || s.invalidRows > 0, 'merged cells are rejected');
    await tm.eval('__eve.scanLionKing()');
    await quiet(tm);
  } finally { await tm.close(); }
});

test('text-node status edits are observed without attribute changes or manual scans', async () => {
  const { tm } = await openLion(new LionServer([run('a', { color: '', text: 'RUNNING' })]));
  try {
    await tm.page.evaluate(() => {
      const status = document.querySelector('[data-lion-fixture="a"]').cells[4];
      status.firstChild.nodeValue = 'PASS';
    });
    await eventCount(tm, 1);
    assert.equal((await logs(tm))[0].transition, 'TEST_SUCCESS');
  } finally { await tm.close(); }
});

test('muting Lion notifications keeps audit events while suppressing cards and desktop toasts', async () => {
  const { tm } = await openLion();
  try {
    await tm.page.click('#eve-hide-all');
    await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await eventCount(tm, 1);
    assert.deepEqual(await cards(tm), []);
    assert.deepEqual(await notifications(tm), []);
    assert.equal((await logs(tm))[0].tracker, 'lionking');
  } finally { await tm.close(); }
});

test('reload preserves the Lion completed event and does not emit it again', async () => {
  const server = new LionServer();
  const { tm } = await openLion(server);
  try {
    await change(tm, 'a', { color: 'darkgreen', text: '06:58' });
    await eventCount(tm, 1);
    server.rows[0].color = 'darkgreen';
    server.rows[0].text = '06:58';
    await tm.page.waitForTimeout(2600);
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#lion-history-hours'), { message: 'reloaded Lion controls' });
    await tm.eval('__eve.scanLionKing()');
    assert.equal((await logs(tm)).length, 1);
    assert.deepEqual(await notifications(tm), [], 'reload emits no repeat toast');
  } finally { await tm.close(); }
});

test('SLT and Lion King share one installation and origin while keeping settings, alerts and state separate', async () => {
  const server = new LionServer();
  const slt = await openWithScript(browser, RACK_URL, server, { source: source() });
  await slt.waitFor(() => slt.page.$('#eve-tracker-panel'), { message: 'SLT panel' });
  await slt.waitFor(async () => Object.keys((await slt.eval('__eve.state()')).previousStates).length === 6,
    { message: 'SLT baseline' });
  const before = await slt.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
    .filter(([key]) => key.startsWith('eveRackTracker'))));
  const { tm } = await openLion(server, { context: slt.context });
  try {
    // The reused context skips the harness seeds, so Dev-only controls start hidden.
    await tm.page.check('#eve-developer-mode');
    await tm.page.selectOption('#lion-history-hours', '48');
    await change(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await eventCount(tm, 1);
    await tm.page.waitForTimeout(2600);
    const after = await tm.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)
      .filter(([key]) => key.startsWith('eveRackTracker'))));
    assert.deepEqual(after, before, 'Lion writes never overwrite SLT local storage');
    assert.equal((await logs(slt)).length, 0, 'SLT log remains empty');
    assert.deepEqual(await cards(slt), [], 'SLT tab receives no Lion cards');
    const lionKeys = await tm.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('lionKingTracker')));
    assert.ok(lionKeys.length > 0, 'Lion data uses its own namespace');
  } finally { await slt.context.close(); }
});

test('two Lion tabs observing the same completion share one audit event and one desktop notification', async () => {
  const server = new LionServer();
  const { tm: one } = await openLion(server);
  const { tm: two } = await openLion(server, { context: one.context });
  try {
    await Promise.all([
      change(one, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' }),
      change(two, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' })
    ]);
    await one.waitFor(() => one.page.evaluate(() =>
      JSON.parse(localStorage.getItem('lionKingTrackerAlertLog') || '[]').length === 1),
    { message: 'one shared durable completion' });
    await one.waitFor(async () => (await notifications(one)).length + (await notifications(two)).length === 1,
      { message: 'one desktop notification across both tabs' });
    await Promise.all([one.eval('__eve.scanLionKing()'), two.eval('__eve.scanLionKing()')]);
    const durable = await one.page.evaluate(() => JSON.parse(localStorage.getItem('lionKingTrackerAlertLog') || '[]'));
    assert.equal(durable.length, 1);
    assert.equal((await notifications(one)).length + (await notifications(two)).length, 1);
    assert.deepEqual([...one.errors, ...two.errors], []);
  } finally { await one.context.close(); }
});

test('Refresh now uses the existing authenticated session, replaces only the validated source table, and scans it', async () => {
  const server = new LionServer();
  const { tm } = await openLion(server);
  try {
    await tm.context.addCookies([{ name: 'existing_session', value: 'synthetic-fixture', url: LION_URL }]);
    const requests = [];
    tm.page.on('request', req => {
      if (new URL(req.url()).pathname === '/out/out.evelionking_all.php') requests.push(req);
    });
    await tm.page.evaluate(() => {
      document.getElementById('eve-tracker-panel').dataset.fixturePreserved = 'yes';
      const note = document.createElement('p'); note.id = 'local-page-note'; note.textContent = 'keep me';
      document.body.appendChild(note);
    });
    server.rows[0].color = 'darkgreen';
    server.rows[0].text = '06:58';
    await tm.page.click('#eve-refresh-now');
    await eventCount(tm, 1);
    assert.equal(await tm.page.getAttribute('#eve-tracker-panel', 'data-fixture-preserved'), 'yes');
    assert.equal(await tm.page.textContent('#local-page-note'), 'keep me');
    assert.equal((await snapshot(tm)).rows[0].status, 'PASS');
    assert.equal(requests.length, 1, 'one explicit refresh request');
    assert.equal(requests[0].isNavigationRequest(), false, 'no full-page navigation');
    assert.match((await requests[0].allHeaders()).cookie || '', /existing_session=synthetic-fixture/);
  } finally { await tm.close(); }
});

test('failed refresh and a login HTML response retain the last source table and tracker UI', async () => {
  const server = new LionServer();
  const { tm } = await openLion(server);
  try {
    await tm.page.evaluate(() => document.getElementById('eve-tracker-panel').dataset.fixturePreserved = 'yes');
    const original = await tm.page.innerHTML('#lion-source');
    const initialRequests = server.requests.filter(r => r.includes('/out/out.evelionking_all.php')).length;
    server.lionStatus = 503;
    await tm.page.click('#eve-refresh-now');
    await tm.waitFor(() => server.requests.filter(r => r.includes('/out/out.evelionking_all.php')).length === initialRequests + 1,
      { message: 'failed refresh request' });
    await tm.page.waitForTimeout(700);
    assert.equal(await tm.page.innerHTML('#lion-source'), original);
    server.lionStatus = 200;
    server.lionHtml = '<html><body><form><h2>Please log in</h2><input type="password"></form></body></html>';
    await tm.page.click('#eve-refresh-now');
    await tm.waitFor(() => server.requests.filter(r => r.includes('/out/out.evelionking_all.php')).length === initialRequests + 2,
      { message: 'login HTML refresh request' });
    await tm.page.waitForTimeout(700);
    assert.equal(await tm.page.innerHTML('#lion-source'), original);
    assert.equal(await tm.page.getAttribute('#eve-tracker-panel', 'data-fixture-preserved'), 'yes');
    await quiet(tm);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('Lion elapsed durations mean hours:minutes and reject status/step text or invalid minutes', async () => {
  const { tm } = await openLion();
  try {
    const cases = [
      ['05:58', (5 * 60 + 58) * 60000], ['6:03', (6 * 60 + 3) * 60000],
      ['120:03', (120 * 60 + 3) * 60000], [' 06:58 ', (6 * 60 + 58) * 60000],
      ['05:60', null], ['05:58:01', null], ['-05:58', null], ['CHECK_GPU 05:58', null],
      ['X11-2C.TEST -- : 00:01', null], ['00:00', null], ['', null]
    ];
    const actual = await tm.eval(`${JSON.stringify(cases)}.map(c => __eve.parseLionKingDuration(c[0]))`);
    assert.deepEqual(actual, cases.map(c => c[1]));
  } finally { await tm.close(); }
});

test('average uses deduplicated valid PASS durations from the last 24 hours regardless of display history', async () => {
  const server = new LionServer([
    run('a', { color: 'darkgreen', text: '05:58' }),
    run('b', { color: 'darkgreen', text: '06:02' }),
    run('c', { started: siteDate(30), color: 'darkgreen', text: '20:00' }),
    run('d', { started: siteDate(0.5), color: 'lightgreen', text: '00:20' }),
    run('e', { started: siteDate(0.25), color: 'red', text: 'CHECK_GPU 01:20' }),
    run('f', { started: siteDate(0.1), color: 'darkgreen', text: '00:00' }),
    run('g', { started: siteDate(0.15), color: 'darkgreen', text: 'CHECK_GPU 02:00' })
  ]);
  const { tm } = await openLion(server);
  try {
    const average = () => tm.eval(`(() => {
      const rows = __eve.getLionKingSnapshot().rows;
      return __eve.lionKingPassAverage([...rows, rows[0]]);
    })()`);
    assert.deepEqual(await average(), { averageMs: 6 * 3600000, samples: 2 });
    await tm.page.selectOption('#lion-history-hours', 'all');
    assert.deepEqual(await average(), { averageMs: 6 * 3600000, samples: 2 }, 'old displayed PASS remains excluded');
    assert.match(await tm.page.textContent('#lion-average-pass'), /2/);
    await quiet(tm);
  } finally { await tm.close(); }
});

test('RUNNING ETA uses Started plus average PASS duration and its UI never becomes source status or an alert', async () => {
  const server = new LionServer([
    run('a', { started: siteDate(1), color: 'lightgreen', text: 'X11-2C.TEST -- : 01:00' }),
    run('b', { started: siteDate(8), color: 'lightgreen', text: 'X11-2C.TEST -- : 08:00' }),
    run('c', { started: siteDate(10), color: 'darkgreen', text: '06:00' })
  ]);
  const { tm } = await openLion(server);
  try {
    await tm.waitFor(() => tm.page.$('[data-lion-fixture="a"] .eve-lion-eta[data-lion-tracker-ui]'),
      { message: 'running Lion ETA' });
    const eta = await tm.page.textContent('[data-lion-fixture="a"] .eve-lion-eta');
    assert.match(eta, /estimate|ETA/i);
    const overdue = await tm.page.textContent('[data-lion-fixture="b"] .eve-lion-eta');
    assert.match(overdue, /overdue|past|exceed/i);
    assert.match(overdue, /estimate|ETA/i);
    const before = await snapshot(tm);
    assert.deepEqual(before.rows.map(r => r.status), ['RUNNING', 'RUNNING', 'PASS']);
    const expectedFinish = await tm.page.evaluate(ms => new Date(ms).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', timeZoneName: 'short'
    }), before.rows[0].startedAt + 6 * 3600000);
    assert.ok(eta.includes(expectedFinish), 'ETA finish equals Started plus the six-hour observed average');
    // Even deliberately PASS-like presentation text cannot change source rows.
    await tm.page.evaluate(() => {
      document.querySelector('[data-lion-fixture="a"] .eve-lion-eta').textContent = 'PASS (ETA estimate)';
    });
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    const after = await snapshot(tm);
    assert.deepEqual(after.rows.map(r => ({ key: r.key, status: r.status })),
      before.rows.map(r => ({ key: r.key, status: r.status })));
    await quiet(tm);
  } finally { await tm.close(); }
});

test('RUNNING ETA is unavailable without valid recent PASS samples and never predicts a terminal result', async () => {
  const { tm } = await openLion(new LionServer([
    run('a', { started: siteDate(40) }),
    run('b', { started: siteDate(30), color: 'darkgreen', text: '06:00' })
  ]));
  try {
    assert.deepEqual(await tm.eval('__eve.lionKingPassAverage(__eve.getLionKingSnapshot().rows)'),
      { averageMs: null, samples: 0 });
    assert.match(await tm.page.textContent('#lion-average-pass'), /unavailable|no .*pass/i);
    assert.match(await tm.page.textContent('[data-lion-fixture="a"] .eve-lion-eta'), /unavailable|no .*pass/i);
    await tm.eval('__eve.scanLionKing()');
    assert.equal((await snapshot(tm)).rows[0].status, 'RUNNING');
    await quiet(tm);
  } finally { await tm.close(); }
});
