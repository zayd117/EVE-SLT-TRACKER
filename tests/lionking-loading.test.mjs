// Real document-start userscript tests with a parser-blocking resource. Holding
// this resource leaves a valid-looking partial table on screen while the rest
// of the 4,001-row document and DOMContentLoaded are still pending.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES } from './harness/userscript.mjs';
import { withEnabledLionRows } from './harness/lion.mjs';
import { FixtureServer } from './harness/server.mjs';

const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
const BLOCK_PATH = '/fixture/lion-parser-block.js';
const HEADERS = ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'];
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

function siteDate(at) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function makeRun(index, values = {}) {
  const startedAt = Math.floor((Date.now() - 3600000) / 1000) * 1000;
  return { index, tail: '2699YW' + String(index).padStart(4, '0'),
    head: '2698YW' + String(index).padStart(4, '0'), startedAt, started: siteDate(startedAt),
    color: 'lightgreen', text: 'X11-2C.TEST -- : 00:01', ...values };
}
const runKey = row => JSON.stringify([row.tail.toUpperCase(), row.head.toUpperCase(), row.startedAt]);
const rowHtml = row => `<tr data-loading-run="${row.index}"><td>${row.index + 1}</td>` +
  `<td>${row.tail}</td><td>${row.head}</td><td>${row.started}</td>` +
  `<td bgcolor="${row.color}">${row.text}</td></tr>`;

class HeldDocument extends FixtureServer {
  constructor(rows, { noTable = false } = {}) {
    super();
    this.rows = rows;
    this.noTable = noTable;
    this.releaseGate = deferred();
    this.requested = deferred();
  }
  render() {
    const blocker = `<script src="${BLOCK_PATH}"></script>`;
    const table = this.noTable ? blocker : '<table id="loading-source"><thead><tr>' +
      HEADERS.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rowHtml(this.rows[0]) + blocker + this.rows.slice(1).map(rowHtml).join('') + '</tbody></table>';
    return '<!doctype html><html><head><title>Lion King loading fixture</title></head><body>' +
      '<h2>EVE LionKing GPU_JBOG_TEST</h2>' + table + '<p id="end-of-document">All source data received.</p>' +
      '</body></html>';
  }
  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      return { status: 200, contentType: 'text/html', body: this.render() };
    }
    if (url.host === 'rack.test' && url.pathname === BLOCK_PATH) {
      this.requested.resolve();
      await this.releaseGate.promise;
      return { status: 200, contentType: 'application/javascript', body: 'window.fixtureBlockReleased = true;' };
    }
    return super.respond(url, req);
  }
  release() { this.releaseGate.resolve(); }
}

// Count only resources allocated in the userscript's isolated world. Temporary
// document-start observers may exist during parsing, but must disconnect after
// readiness; the actual monitor and ticker must not be initialized twice.
const COUNTERS = `
  var __loadResources = globalThis.__loadResources = { observers: new Set(), workers: 0 };
  (() => {
    const observe = MutationObserver.prototype.observe;
    const disconnect = MutationObserver.prototype.disconnect;
    MutationObserver.prototype.observe = function (...args) {
      __loadResources.observers.add(this); return observe.apply(this, args);
    };
    MutationObserver.prototype.disconnect = function () {
      __loadResources.observers.delete(this); return disconnect.call(this);
    };
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = function (...args) {
      __loadResources.workers += 1; return new OriginalWorker(...args);
    };
  })();
`;

async function holdOpen(server, { previousStates } = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.route('**/*', route => server.handle(route));
  await context.addInitScript(settings => {
    localStorage.setItem('lionKingTrackerSettings', JSON.stringify(settings));
  }, withEnabledLionRows().localStorage.lionKingTrackerSettings);
  if (previousStates) await context.addInitScript(states => {
    sessionStorage.setItem('lionKingTrackerPreviousStates', JSON.stringify(states));
  }, previousStates);
  const created = context.waitForEvent('page');
  const source = instrument(SCRIPT_SOURCE, [...new Set([
    ...HOOK_NAMES, 'scanLionKing', 'getLionKingSnapshot', 'refreshLionKing'
  ])]);
  // This promise intentionally remains pending while the parser is blocked.
  const opening = openWithScript(browser, LION_URL, server, { context, source, prelude: COUNTERS });
  opening.catch(() => {});
  const page = await created;
  await server.requested.promise;
  const cdp = await context.newCDPSession(page);
  let world;
  cdp.on('Runtime.executionContextCreated', ({ context: execution }) => {
    if (execution.name === 'tm' && execution.auxData?.isDefault === false) world = execution.id;
  });
  await cdp.send('Runtime.enable');
  async function isolated(expression) {
    assert.ok(world, 'the Tampermonkey isolated world exists before document readiness');
    const result = await cdp.send('Runtime.evaluate', {
      expression, contextId: world, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  let tm;
  return {
    page, isolated,
    async finish() {
      server.release();
      tm = await opening;
      await page.waitForSelector('#end-of-document');
      return tm;
    },
    async close() {
      server.release();
      await opening.catch(() => {});
      await context.close();
    }
  };
}
const getLogs = tm => tm.eval('__eve.getAlertLog()');
const resources = read => read(`({
  panels: document.querySelectorAll('#eve-tracker-panel').length,
  workers: __loadResources.workers, observers: __loadResources.observers.size
})`);

test('Lion King controls render while the 4,001-row document is parsing; only a completed document establishes a quiet baseline', async () => {
  const oldAt = Math.floor((Date.now() - 36 * 3600000) / 1000) * 1000;
  const rows = [makeRun(0), ...Array.from({ length: 4000 }, (_, n) => makeRun(n + 1, {
    startedAt: oldAt, started: siteDate(oldAt), color: n % 2 ? 'red' : 'darkgreen',
    text: n % 2 ? 'X11-2C.TEST -- CHECK_GPU : 03:12' : '05:58'
  }))];
  const server = new HeldDocument(rows);
  const held = await holdOpen(server);
  try {
    await held.page.locator('#eve-tracker-panel').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await held.page.evaluate(() => document.readyState), 'loading');
    assert.equal(await held.page.locator('#loading-source tbody tr').count(), 1,
      'the fixture genuinely holds the remaining four thousand source rows');
    assert.match(await held.page.textContent('#eve-health-chip'), /loading/i);
    // Even a manual scan must not acknowledge a valid-looking partial table.
    await held.isolated('__eve.scanLionKing(); __eve.scanLionKing()');
    await held.isolated('__eve.refreshLionKing()');
    assert.equal(server.requests.filter(request => request.includes('/out/out.evelionking_all.php')).length, 1,
      'manual refresh does not issue another full-source request during the initial document load');
    assert.equal(await held.page.locator('#loading-source tbody tr').count(), 1,
      'manual refresh does not replace a source table that is still being parsed');
    assert.equal(await held.isolated('Object.keys(__eve.state().previousStates).length'), 0);
    assert.deepEqual(await held.isolated('__gm.notifications'), []);
    assert.deepEqual(await held.isolated('__eve.getAlertLog()'), []);
    const early = await resources(held.isolated);
    assert.equal(early.panels, 1);
    assert.equal(early.workers, 1);

    // Advance only the userscript clock instead of making this regression
    // test actually wait 90 seconds for a slow initial collector response.
    await held.isolated(`(() => {
      const actualNow = Date.now.bind(Date);
      Date.now = () => actualNow() + 90000;
    })()`);

    const tm = await held.finish();
    await tm.waitFor(async () => (await tm.eval('Object.keys(__eve.state().previousStates).length')) === 4001,
      { message: 'all completed-document runs establish their baseline' });
    assert.deepEqual(await getLogs(tm), []);
    assert.deepEqual((await tm.gm()).notifications, []);
    assert.equal(await tm.page.locator('#loading-source tbody tr').count(), 4001);
    assert.equal(await tm.page.locator('#loading-source tbody tr:visible').count(), 1,
      'historical completed rows stay hidden by the default 24-hour filter');
    assert.equal(await tm.page.textContent('#eve-health-chip'), 'OK');
    await tm.waitFor(async () => (await tm.page.textContent('#lion-data-age')).includes('Last page update:'),
      { message: 'completed source freshness label' });
    assert.match(await tm.page.textContent('#lion-data-age'), /\(0h 0m ago\)/,
      'the first completed snapshot is fresh even when the initial response took 90 seconds');
    assert.deepEqual(await resources(expression => tm.eval(expression)), { panels: 1, workers: 1, observers: 1 },
      'readiness does not initialize a second panel, ticker, or monitor observer');

    await tm.page.evaluate(() => {
      const cell = document.querySelector('[data-loading-run="0"]').cells[4];
      cell.setAttribute('bgcolor', 'darkgreen'); cell.textContent = '05:58';
    });
    await tm.waitFor(async () => (await getLogs(tm)).length === 1, { message: 'one later observed completion' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length === 1, { message: 'one completion notification' });
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await getLogs(tm)).length, 1);
    assert.equal((await tm.gm()).notifications.length, 1);
    assert.equal((await getLogs(tm))[0].tailSerial, rows[0].tail);
    assert.deepEqual(tm.errors, []);
  } finally { await held.close(); }
});

test('an existing RUNNING baseline is preserved while a matching completed row arrives in the partial initial document', async () => {
  const row = makeRun(5, { color: 'darkgreen', text: '05:58' });
  const previousStates = { [runKey(row)]: {
    status: 'RUNNING', completed: false, startedAt: row.startedAt, seenAt: Date.now() - 60000
  } };
  const held = await holdOpen(new HeldDocument([row, makeRun(6)]), { previousStates });
  try {
    await held.page.locator('#eve-tracker-panel').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await held.page.evaluate(() => document.readyState), 'loading');
    assert.match(await held.page.textContent('#eve-health-chip'), /loading/i);
    await held.isolated('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.deepEqual(await held.isolated('__eve.state().previousStates'), previousStates,
      'partial parsing cannot change or consume the saved RUNNING state');
    assert.deepEqual(await held.isolated('__eve.getAlertLog()'), []);
    assert.deepEqual(await held.isolated('__gm.notifications'), []);
    const tm = await held.finish();
    await tm.waitFor(async () => (await getLogs(tm)).length === 1, { message: 'completion is recorded only after initial readiness' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length === 1, { message: 'one resumed completion notification' });
    assert.equal((await getLogs(tm))[0].tailSerial, row.tail);
    assert.equal((await getLogs(tm))[0].transition, 'TEST_SUCCESS');
    await tm.eval('__eve.scanLionKing(); __eve.scanLionKing()');
    assert.equal((await getLogs(tm)).length, 1);
    assert.deepEqual(await resources(expression => tm.eval(expression)), { panels: 1, workers: 1, observers: 1 });
    assert.deepEqual(tm.errors, []);
  } finally { await held.close(); }
});

test('a loading Lion King page exposes controls even without a table, then reports BLIND when the finished source contains no valid table', async () => {
  const held = await holdOpen(new HeldDocument([], { noTable: true }));
  try {
    await held.page.locator('#eve-tracker-panel').waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await held.page.evaluate(() => document.readyState), 'loading');
    assert.match(await held.page.textContent('#eve-health-chip'), /loading/i);
    const tm = await held.finish();
    await tm.waitFor(async () => (await tm.page.textContent('#eve-health-chip')) === 'BLIND',
      { message: 'missing completed source is clearly marked BLIND' });
    assert.deepEqual(await getLogs(tm), []);
    assert.deepEqual((await tm.gm()).notifications, []);
    assert.equal(await tm.eval('Object.keys(__eve.state().previousStates).length'), 0);
    assert.deepEqual(await resources(expression => tm.eval(expression)), { panels: 1, workers: 1, observers: 1 });
    assert.deepEqual(tm.errors, []);
  } finally { await held.close(); }
});
