// Stability for a tracker that runs for hours: bad saved data, storage that
// throws, resources that must not grow, and a failing step that must not
// stop the rest of the monitoring loop. Real script, fixture site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot, cards } from './harness/rack.mjs';
import { FixtureServer } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const refresh = tm => tm.eval('new Promise(r => __eve.performSoftRefresh(r))');
const cardCount = async tm => (await cards(tm)).length;

const KEYS = {
  local: [
    'eveRackTrackerSettings', 'eveRackTrackerAlertLog', 'eveRackTrackerAlertLogDay',
    'eveRackTrackerAutoShift', 'eveRackTrackerAlertLogClearedAt', 'eveRackTrackerAlertsCollapsed',
    'eveRackTrackerPanelPosition', 'eveRackTrackerAlertPanelPosition', 'eveRackTrackerJiraAttention',
    'eveRackTrackerEventClaims'
  ],
  session: [
    'eveRackTrackerPreviousStates', 'eveRackTrackerActiveAlerts', 'eveRackTrackerRecentAlerts',
    'eveRackTrackerJiraCache', 'eveRackTrackerDebugSnapshot', 'eveRackTrackerHeartbeat'
  ]
};
const fill = (keys, value) => Object.fromEntries(keys.map(k => [k, value]));

// Boots with the given saved data, then must still detect a failure on a
// slot and show it - the whole point of the tool.
async function assertStillMonitors(options, label) {
  const { tm } = await openRack(browser, options);
  try {
    const panelText = await tm.page.$eval('#eve-tracker-panel', el => el.textContent);
    assert.doesNotMatch(panelText, /FAILED TO START/, `${label}: no fatal banner`);
    await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
    await tm.waitFor(async () => (await cards(tm)).some(c => /FAIL/.test(c.title)), { message: `${label}: fail card` });
    await tm.waitFor(async () => (await tm.gm()).notifications.length === 1, { message: `${label}: toast` });
    assert.deepEqual(tm.errors, [], `${label}: no uncaught page errors`);
    assert.equal(tm.trackerLogs(/FATAL/).length, 0, `${label}: no FATAL log`);
  } finally {
    await tm.close();
  }
}

for (const [label, raw] of [
  ['invalid JSON', '{not json'],
  ['JSON null', 'null'],
  ['a number', '42'],
  ['a string', '"text"'],
  ['an array', '[1,2]'],
  ['an empty object', '{}']
]) {
  test(`corrupt storage (${label} in every key): starts and still alerts`, () =>
    assertStillMonitors({ rawLocalStorage: fill(KEYS.local, raw), rawSessionStorage: fill(KEYS.session, raw) }, label));
}

test('wrong-shaped saved values (bad baselines, cards, log rows, settings): starts and still alerts', () =>
  assertStillMonitors({
    localStorage: {
      eveRackTrackerSettings: { sections: [], refreshIntervalSeconds: 'abc', logShiftChoice: 42, developerMode: 'yes' },
      eveRackTrackerAlertLog: [null, 5, 'x', {}, { id: 7 }],
      eveRackTrackerJiraAttention: { 'a|b|new': null, x: 5 },
      eveRackTrackerEventClaims: { 'A7|EVE01|U2|x|y': null }
    },
    sessionStorage: {
      // The slot that will fail has a garbage baseline: it must not stay dead.
      eveRackTrackerPreviousStates: { 'A7|EVE01|U2': 'garbage', 'A7|EVE01|U3': null, 'A7|EVE02|U1': 5 },
      eveRackTrackerActiveAlerts: [null, 5, {}, { id: 'x' }],
      eveRackTrackerRecentAlerts: { a: null, b: 'x' },
      eveRackTrackerJiraCache: [[1, 2], null, ['k', null]]
    }
  }, 'wrong-shaped values'));

test('non-object entries in saved cards and the shift log are dropped, objects kept', async () => {
  const card = { id: 'keep-1', serial: '2699YW9001', title: 'TEST FAIL', ts: Date.now(), location: 'A7 EVE01 U1' };
  const row = { id: 'row-1', serial: '2699YW9001', ts: Date.now(), transition: 'FAIL' };
  const { tm } = await openRack(browser, {
    localStorage: { eveRackTrackerAlertLog: [null, 5, 'x', [1], row] },
    sessionStorage: { eveRackTrackerActiveAlerts: [null, 5, 'x', [1], card] }
  });
  try {
    assert.equal(await cardCount(tm), 1, 'only the real saved card is shown');
    const log = await tm.eval('__eve.getAlertLog()');
    assert.ok(log.every(e => e && typeof e === 'object' && !Array.isArray(e)), 'log rows are objects (any kept by the shift filter)');
    assert.deepEqual(tm.errors, []);
  } finally {
    await tm.close();
  }
});

test('storage that throws on every write (quota full / blocked): starts and still alerts', () =>
  assertStillMonitors({
    prelude: `Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };`
  }, 'throwing storage'));

// Counts, in the script's own world only, what could pile up over hours.
const COUNTERS = `
  var __res = globalThis.__res = { globalListeners: 0, observers: new Set(), intervals: new Set(), timeouts: new Set(), workers: 0 };
  (function () {
    const add = EventTarget.prototype.addEventListener;
    const rem = EventTarget.prototype.removeEventListener;
    const isGlobal = t => t === window || t === document;
    EventTarget.prototype.addEventListener = function (...a) { if (isGlobal(this)) __res.globalListeners += 1; return add.apply(this, a); };
    EventTarget.prototype.removeEventListener = function (...a) { if (isGlobal(this)) __res.globalListeners -= 1; return rem.apply(this, a); };
    const observe = MutationObserver.prototype.observe;
    const disconnect = MutationObserver.prototype.disconnect;
    MutationObserver.prototype.observe = function (...a) { __res.observers.add(this); return observe.apply(this, a); };
    MutationObserver.prototype.disconnect = function () { __res.observers.delete(this); return disconnect.call(this); };
    const si = setInterval, ci = clearInterval, st = setTimeout, ct = clearTimeout;
    globalThis.setInterval = function (...a) { const id = si(...a); __res.intervals.add(id); return id; };
    globalThis.clearInterval = function (id) { __res.intervals.delete(id); return ci(id); };
    globalThis.setTimeout = function (fn, ...rest) {
      const id = st(function () { __res.timeouts.delete(id); return typeof fn === 'function' ? fn.apply(this, arguments) : undefined; }, ...rest);
      __res.timeouts.add(id); return id;
    };
    globalThis.clearTimeout = function (id) { __res.timeouts.delete(id); return ct(id); };
    const W = globalThis.Worker;
    globalThis.Worker = function (...a) { __res.workers += 1; return new W(...a); };
  })();
`;
const resources = tm => tm.eval(`({
  globalListeners: __res.globalListeners, observers: __res.observers.size, intervals: __res.intervals.size,
  timeouts: __res.timeouts.size, workers: __res.workers,
  panels: document.querySelectorAll('#eve-tracker-panel').length,
  alertPanels: document.querySelectorAll('#eve-alert-container').length,
  styles: [...document.querySelectorAll('style')].filter(s => s.textContent.includes('#eve-tracker-panel, #eve-alert-container')).length,
  slots: Object.keys(__eve.state().previousStates).length,
  nodes: document.getElementsByTagName('*').length
})`);

test('long run: 40 soft refreshes, scans and results do not grow listeners, observers, timers, UI or state', async () => {
  const server = new FixtureServer();
  const { tm } = await openRack(browser, { server, prelude: COUNTERS });
  try {
    // The JIRAlerts window (and its few window listeners) is created with
    // the first card, once - so start counting after that.
    server.rack.slot('EVE01', 'U1').color = 'red';
    await refresh(tm);
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'first card' });
    await tm.page.waitForTimeout(3500); // worker ticker settled
    const start = await resources(tm);
    const cdp = await tm.context.newCDPSession(tm.page);
    await cdp.send('HeapProfiler.collectGarbage');
    const domStart = await cdp.send('Memory.getDOMCounters');
    for (let i = 0; i < 40; i += 1) {
      // Alternate slots between testing and failed, as a busy rack does.
      const unit = ['U1', 'U2', 'U3'][i % 3];
      server.rack.slot('EVE02', unit).color = i % 2 ? '#90ee90' : 'red';
      await refresh(tm);
      await tm.eval('__eve.scan(); __eve.refreshRelativeTimes(); __eve.checkLogShiftRollover()');
    }
    await tm.page.waitForTimeout(1500);
    const end = await resources(tm);
    await cdp.send('HeapProfiler.collectGarbage');
    const domEnd = await cdp.send('Memory.getDOMCounters');
    assert.equal(end.globalListeners, start.globalListeners, 'window/document listeners');
    assert.equal(end.observers, start.observers, 'active MutationObservers');
    assert.equal(end.intervals, start.intervals, 'active intervals');
    assert.equal(end.workers, start.workers, 'workers');
    assert.ok(end.timeouts <= start.timeouts + 10, `pending timeouts bounded (${start.timeouts} -> ${end.timeouts})`);
    assert.deepEqual([end.panels, end.alertPanels, end.styles, end.slots], [1, 1, 1, 6],
      'one panel, one alert window, one stylesheet, 6 tracked slots');
    assert.ok(await cardCount(tm) <= 50, 'cards capped');
    // Cards were added, so allow their nodes and listeners; the rest must not scale with refreshes.
    const perCard = 80;
    const cardsNow = await cardCount(tm);
    assert.ok(domEnd.nodes <= domStart.nodes + cardsNow * perCard,
      `DOM nodes bounded (${domStart.nodes} -> ${domEnd.nodes}, ${cardsNow} cards)`);
    assert.ok(domEnd.jsEventListeners <= domStart.jsEventListeners + cardsNow * 20,
      `event listeners bounded (${domStart.jsEventListeners} -> ${domEnd.jsEventListeners})`);
    assert.deepEqual(tm.errors, []);
  } finally {
    await tm.close();
  }
});

test('reload many times: exactly one tracker, one ticker and one observer each time', async () => {
  const { tm } = await openRack(browser, { prelude: COUNTERS });
  try {
    for (let i = 0; i < 3; i += 1) {
      await tm.reload();
      await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel after reload' });
      await tm.page.waitForTimeout(3500);
      const r = await resources(tm);
      assert.deepEqual([r.panels, r.alertPanels, r.styles, r.observers, r.workers], [1, 0, 1, 1, 1], `reload ${i + 1}`);
      assert.ok(r.intervals <= 1, 'at most the fallback interval');
    }
    assert.equal(await cardCount(tm), 0, 'no alerts from reloads alone');
    assert.equal((await tm.gm()).notifications.length, 0, 'no toasts from reloads alone');
  } finally {
    await tm.close();
  }
});

test('a step that keeps throwing does not stop the rest of the monitoring loop', async () => {
  // Every table read throws while __breakScan is set: scan() fails each tick.
  const prelude = `
    globalThis.__breakScan = false;
    const qsa = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (sel) {
      if (globalThis.__breakScan && this.tagName === 'TABLE') throw new Error('broken table');
      return qsa.call(this, sel);
    };`;
  const { tm } = await openRack(browser, { prelude });
  try {
    await tm.eval('__breakScan = true');
    const hb1 = Number(await tm.page.evaluate(() => sessionStorage.getItem('eveRackTrackerHeartbeat')));
    await tm.page.waitForTimeout(12000);
    const hb2 = Number(await tm.page.evaluate(() => sessionStorage.getItem('eveRackTrackerHeartbeat')));
    assert.ok(hb2 > hb1, 'ticker still running');
    const stepLogs = tm.trackerLogs(/Tick step "scan" failed/);
    assert.equal(stepLogs.length, 1, 'the failing step is reported once, not every tick');
    await tm.eval('__breakScan = false');
    await setSlot(tm, 'EVE01', 'U3', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'detection resumes' });
    await tm.waitFor(() => tm.trackerLogs(/Tick step "scan" recovered/).length === 1, { message: 'recovery logged' });
  } finally {
    await tm.close();
  }
});

test('TestView status cache stays bounded: the oldest serial is dropped past 200', async () => {
  const { tm } = await openRack(browser, {});
  try {
    const requests = () => tm.eval(`__gm.xhr.filter(u => u.includes('server_level_tests')).length`);
    await tm.eval(`Promise.all(Array.from({ length: 201 }, (_, i) => __eve.testViewRunning('SN' + i)))`);
    assert.equal(await requests(), 201);
    await tm.eval(`__eve.testViewRunning('SN200')`);
    assert.equal(await requests(), 201, 'newest still cached');
    await tm.eval(`__eve.testViewRunning('SN0')`);
    assert.equal(await requests(), 202, 'oldest was evicted and is asked again');
  } finally {
    await tm.close();
  }
});
