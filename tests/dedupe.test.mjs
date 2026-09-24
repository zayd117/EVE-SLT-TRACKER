// One real event -> one log entry + one toast, however many tracker tabs or
// installed copies are watching the rack; a LATER real event for the same
// serial is still processed. Root cause and design: CODE_NOTES "EVENT CLAIMS".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript } from './harness/userscript.mjs';
import { FixtureServer, RACK_URL } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function ready(tm) {
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel' });
  await tm.waitFor(async () => Object.keys((await tm.eval('__eve.state()')).previousStates).length === 6,
    { message: 'baseline' });
}
async function openTab(server, options = {}) {
  const tm = await openWithScript(browser, RACK_URL, server, options);
  await ready(tm);
  return tm;
}
// The page's data changes on the server; a tab sees it on its next soft refresh.
const refresh = tm => tm.eval('new Promise(r => __eve.performSoftRefresh(r))');
// Shared audit log as written to localStorage (after the 2 s write debounce).
async function sharedLog(tm) {
  await tm.page.waitForTimeout(2600);
  return tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerAlertLog') || '[]')
    .map(e => `${e.serial} ${e.transition}`));
}
const toasts = async (tm, world) => (await tm.gm(world)).notifications.map(n => n.title);
const cardTitles = tm => tm.page.$$eval('.eve-alert .eve-alert-header span', els => els.map(e => e.textContent.trim()));

test('two tabs on the same rack: one failure -> one log entry, one toast, card in both tabs', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  const t1 = await openTab(server);
  const t2 = await openTab(server, { context: t1.context });
  try {
    server.rack.slot('EVE01', 'U2').color = 'red';
    await refresh(t1);
    await refresh(t2);
    await t1.waitFor(async () => (await toasts(t1)).length === 1, { message: 'toast in tab 1' });
    await t2.waitFor(async () => (await cardTitles(t2)).length === 1, { message: 'card in tab 2' });
    assert.deepEqual(await sharedLog(t1), [`${serial} TEST_FAILURE`]);
    assert.deepEqual(await toasts(t2), [], 'no second toast');
    assert.match((await cardTitles(t1))[0], /^TEST FAIL/);
    assert.match((await cardTitles(t2))[0], /^TEST FAIL/);
    assert.deepEqual([...t1.errors, ...t2.errors], []);
  } finally { await t1.context.close(); }
});

test('whichever tab sees the change first processes it (order does not matter)', async () => {
  const server = new FixtureServer();
  const t1 = await openTab(server);
  const t2 = await openTab(server, { context: t1.context });
  try {
    server.rack.slot('EVE02', 'U3').color = 'red';
    await refresh(t2);
    await refresh(t1);
    await t2.waitFor(async () => (await toasts(t2)).length === 1, { message: 'toast in tab 2' });
    await t1.page.waitForTimeout(1500);
    assert.deepEqual(await toasts(t1), []);
    assert.equal((await sharedLog(t1)).length, 1);
  } finally { await t1.context.close(); }
});

test('two installed copies in one tab: the second stays idle and says why', async () => {
  const server = new FixtureServer();
  const tm = await openTab(server, { copies: 2 });
  try {
    await tm.page.evaluate(() => document.querySelectorAll('td[bgcolor]')[1].setAttribute('bgcolor', 'red'));
    await tm.waitFor(async () => (await toasts(tm)).length === 1, { message: 'toast' });
    await tm.page.waitForTimeout(1500);
    assert.deepEqual(await toasts(tm, 'tm2'), []);
    assert.equal((await sharedLog(tm)).length, 1);
    assert.equal((await tm.page.$$('.eve-alert')).length, 1, 'one card in the shared panel');
    assert.ok(tm.trackerLogs(/Another copy of EVE SLT Tracker .* is already running/).length, 'idle copy warned');
    assert.ok(await tm.page.$('html[data-eve-slt-tracker]'));
  } finally { await tm.close(); }
});

test('the same event seen again (repeated scans and refreshes) is processed once', async () => {
  const server = new FixtureServer();
  const tm = await openTab(server);
  try {
    server.rack.slot('EVE01', 'U1').color = 'red';
    await refresh(tm);
    await tm.eval('__eve.scan(); __eve.scan(); __eve.scan()');
    await refresh(tm);
    await refresh(tm);
    await tm.waitFor(async () => (await toasts(tm)).length === 1, { message: 'toast' });
    await tm.page.waitForTimeout(1500);
    assert.equal((await toasts(tm)).length, 1);
    assert.equal((await sharedLog(tm)).length, 1);
    assert.equal((await cardTitles(tm)).length, 1);
  } finally { await tm.close(); }
});

test('PASS, FAIL and pre-test FAIL each processed exactly once', async () => {
  const server = new FixtureServer();
  const pass = server.rack.slot('EVE01', 'U1');
  const fail = server.rack.slot('EVE01', 'U2');
  const pre = server.rack.slot('EVE01', 'U3');
  server.details.set(pass.serial, { operation: 'SLT', status: 'PASS', pass: '1' });
  server.details.set(pre.serial, { operation: 'PRETEST', status: 'FAIL', pass: '0' });
  pre.color = 'lightblue';
  const tm = await openTab(server);
  try {
    pass.color = 'darkgreen';
    fail.color = 'red';
    pre.color = 'red';
    await refresh(tm);
    await refresh(tm);
    await tm.waitFor(async () => (await toasts(tm)).length === 3, { message: '3 toasts' });
    assert.deepEqual((await toasts(tm)).sort(), ['PRE-TEST FAIL ❌', 'TEST FAIL ❌', 'TEST PASS ✅']);
    assert.deepEqual((await sharedLog(tm)).sort(), [
      `${pass.serial} TEST_SUCCESS`, `${fail.serial} TEST_FAILURE`, `${pre.serial} PRETEST_FAILURE`
    ].sort());
    assert.equal((await cardTitles(tm)).length, 3);
  } finally { await tm.close(); }
});

test('legitimate later event, one tab: FAIL -> retest -> FAIL again is processed twice', async () => {
  const server = new FixtureServer();
  const slot = server.rack.slot('EVE02', 'U1');
  const tm = await openTab(server);
  try {
    slot.color = 'red';
    await refresh(tm);
    await tm.waitFor(async () => (await toasts(tm)).length === 1, { message: 'first toast' });
    slot.color = 'lightgreen'; // retest running
    await refresh(tm);
    await tm.eval('__eve.resetFlap()'); // the retest takes longer than the 60 s cooldown
    slot.color = 'red';
    await refresh(tm);
    await tm.waitFor(async () => (await toasts(tm)).length === 2, { message: 'second toast' });
    assert.deepEqual(await sharedLog(tm), [`${slot.serial} TEST_FAILURE`, `${slot.serial} TEST_FAILURE`]);
    assert.equal((await cardTitles(tm)).length, 2);
  } finally { await tm.close(); }
});

test('legitimate later event, two tabs: FAIL, retest, FAIL again -> two log entries and two toasts in total', async () => {
  const server = new FixtureServer();
  const slot = server.rack.slot('EVE01', 'U3');
  const t1 = await openTab(server);
  const t2 = await openTab(server, { context: t1.context });
  try {
    slot.color = 'red';
    await refresh(t1);
    await refresh(t2);
    slot.color = 'lightgreen';
    await refresh(t1);
    await refresh(t2);
    await t1.eval('__eve.resetFlap()');
    await t2.eval('__eve.resetFlap()');
    slot.color = 'red';
    await refresh(t2); // the other tab is first this time
    await refresh(t1);
    await t1.waitFor(async () => (await toasts(t1)).length + (await toasts(t2)).length === 2, { message: '2 toasts' });
    await t1.page.waitForTimeout(1500);
    assert.equal((await toasts(t1)).length + (await toasts(t2)).length, 2);
    assert.deepEqual(await sharedLog(t1), [`${slot.serial} TEST_FAILURE`, `${slot.serial} TEST_FAILURE`]);
    assert.equal((await cardTitles(t1)).length, 2, 'tab 1 shows both events');
    assert.equal((await cardTitles(t2)).length, 2, 'tab 2 shows both events');
  } finally { await t1.context.close(); }
});

test('a different result for the same serial later (FAIL then PASS) is processed', async () => {
  const server = new FixtureServer();
  const slot = server.rack.slot('EVE02', 'U2');
  const tm = await openTab(server);
  try {
    slot.color = 'red';
    await refresh(tm);
    slot.color = 'lightgreen';
    await refresh(tm);
    server.details.set(slot.serial, { operation: 'SLT', status: 'PASS', pass: '1' });
    slot.color = 'darkgreen';
    await refresh(tm);
    await tm.waitFor(async () => (await toasts(tm)).length === 2, { message: '2 toasts' });
    assert.deepEqual(await sharedLog(tm), [`${slot.serial} TEST_FAILURE`, `${slot.serial} TEST_SUCCESS`]);
  } finally { await tm.close(); }
});

test('baseline saved by an older version (no sighting time) never suppresses a real event', async () => {
  const server = new FixtureServer();
  const slot = server.rack.slot('EVE01', 'U1');
  const legacy = {};
  for (const eve of ['EVE01', 'EVE02']) {
    for (const unit of ['U1', 'U2', 'U3']) {
      const s = server.rack.slot(eve, unit);
      legacy[`A7|${eve}|${unit}`] = { color: s.color, serial: s.serial };
    }
  }
  const claim = { [`A7|EVE01|U1|${slot.serial}|TEST_FAILURE`]: { at: Date.now() + 60000, eventId: 'evt-old' } };
  slot.color = 'red'; // changed while the tab was away
  const tm = await openWithScript(browser, RACK_URL, server, {
    sessionStorage: { eveRackTrackerPreviousStates: legacy },
    localStorage: { eveRackTrackerEventClaims: claim }
  });
  try {
    await tm.waitFor(async () => (await toasts(tm)).length === 1, { message: 'toast' });
    assert.deepEqual(await sharedLog(tm), [`${slot.serial} TEST_FAILURE`]);
  } finally { await tm.close(); }
});

// Race found while tracing duplicate toasts: the 45 s retry used to start a
// second detail-page confirmation for a card whose first one was still in
// flight (two record copies -> can send "CORRECTED" twice).
test('the retry never overlaps an in-flight confirmation (one detail fetch)', async () => {
  const server = new FixtureServer();
  server.detailDelayMs = 3000;
  const slot = server.rack.slot('EVE02', 'U2');
  const tm = await openTab(server);
  try {
    slot.color = 'red';
    await refresh(tm);
    await tm.waitFor(async () => (await cardTitles(tm)).length === 1, { message: 'card' });
    await tm.eval('__eve.retryPendingConfirmations()');
    await tm.page.waitForTimeout(4500);
    const fetches = server.requests.filter(r => r.includes('eveserverdetail') && r.includes(slot.serial));
    assert.equal(fetches.length, 1, fetches.join('\n'));
  } finally { await tm.close(); }
});

// The claim test compares against "when this tab last saw the slot's previous
// state", in rack-data time. Only rack TABLE changes may move that clock: an
// unrelated page change must not make stale table data look fresh.
test('only rack-table changes advance the sighting time', async () => {
  const server = new FixtureServer();
  const tm = await openTab(server);
  try {
    const seen = async () => (await tm.eval('__eve.state()')).previousStates['A7|EVE01|U1'].seen;
    const t0 = await seen();
    assert.ok(t0 > 0);
    await tm.page.evaluate(() => { const d = document.createElement('div'); d.textContent = 'page clock'; document.body.appendChild(d); });
    await tm.page.waitForTimeout(900);
    assert.equal(await seen(), t0, 'non-table change: unchanged');
    await tm.page.evaluate(() => document.querySelector('td[bgcolor]').setAttribute('bgcolor', 'lightgreen'));
    await tm.waitFor(async () => (await seen()) > t0, { message: 'table change advances it' });
  } finally { await tm.close(); }
});
