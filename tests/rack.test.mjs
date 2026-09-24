// End-to-end workflows on the rack page: detection -> alert card -> toast ->
// audit log -> persistence, plus click targets. Real script, fixture site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot, cards } from './harness/rack.mjs';
import { FixtureServer } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function withRack(options, fn) {
  const { tm, server } = await openRack(browser, options);
  try {
    await fn(tm, server);
    assert.deepEqual(tm.errors, [], 'no uncaught page errors');
    assert.deepEqual(server.unrouted, [], 'no requests outside the fixture site');
  } finally {
    await tm.close();
  }
}

const cardCount = async tm => (await cards(tm)).length;

test('boot: panel renders, meta refresh stripped, baseline raises no alerts', () =>
  withRack({}, async tm => {
    assert.equal(await tm.page.$('meta[http-equiv="refresh"]'), null);
    await tm.page.waitForTimeout(1500);
    assert.equal(await cardCount(tm), 0);
    assert.equal((await tm.gm()).notifications.length, 0);
    assert.ok(tm.trackerLogs(/running/).length, 'startup banner logged');
  }));

test('testing -> failed raises TEST FAIL card, toast and audit-log entry', () =>
  withRack({}, async (tm, server) => {
    await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'one card' });
    const [card] = await cards(tm);
    assert.match(card.title, /^TEST FAIL/);
    assert.equal(card.serial, server.rack.slot('EVE01', 'U2').serial);
    assert.match(card.location, /A7.*EVE01.*U2/);
    const toast = await tm.waitFor(async () => (await tm.gm()).notifications[0], { message: 'toast' });
    assert.match(toast.title, /TEST FAIL/);
    assert.match(toast.text, new RegExp(card.serial));
    const logEntries = await tm.eval('__eve.getAlertLog()');
    assert.equal(logEntries.length, 1);
    assert.equal(logEntries[0].serial, card.serial);
    assert.ok(server.requests.some(r => r.includes('eveserverdetail') && r.includes(card.serial)), 'detail page consulted');
  }));

test('detail page overrides colour phase: lightgreen -> red on a PRETEST row becomes PRE-TEST FAIL', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE02', 'U1').serial, { operation: 'PRETEST', status: 'FAIL', pass: '0' });
  await withRack({ server }, async tm => {
    await setSlot(tm, 'EVE02', 'U1', { color: 'red' });
    await tm.waitFor(async () => /^PRE-TEST FAIL/.test((await cards(tm))[0]?.title || ''), { message: 'PRE-TEST FAIL card' });
  });
});

test('testing -> passed raises TEST PASS; non-result colour changes raise nothing', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE01', 'U1').serial, { operation: 'SLT', status: 'PASS', pass: '1' });
  await withRack({ server }, async tm => {
    await setSlot(tm, 'EVE01', 'U3', { color: 'lightblue' }); // testing -> pretest: nothing
    await setSlot(tm, 'EVE01', 'U1', { color: 'darkgreen' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'one card' });
    assert.match((await cards(tm))[0].title, /^TEST PASS/);
    await tm.page.waitForTimeout(800);
    assert.equal(await cardCount(tm), 1, 'lightgreen -> lightblue raised nothing');
  });
});

test('server swapped in a slot re-baselines without an alert', () =>
  withRack({}, async tm => {
    await setSlot(tm, 'EVE02', 'U3', { serial: '2699YW5555', color: 'red' });
    await tm.page.waitForTimeout(1500);
    assert.equal(await cardCount(tm), 0);
    const st = await tm.eval('__eve.state()');
    assert.equal(st.previousStates['A7|EVE02|U3'].serial, '2699YW5555');
  }));

test('flap protection: the same failure twice within the cooldown alerts once', () =>
  withRack({}, async tm => {
    await setSlot(tm, 'EVE01', 'U3', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'first card' });
    await setSlot(tm, 'EVE01', 'U3', { color: 'lightgreen' });
    await tm.page.waitForTimeout(600);
    await setSlot(tm, 'EVE01', 'U3', { color: 'red' });
    await tm.page.waitForTimeout(1500);
    assert.equal(await cardCount(tm), 1);
    // By design the repeat is folded into the first entry, not logged twice.
    const log = await tm.eval('__eve.getAlertLog()');
    assert.equal(log.length, 1);
    assert.equal(log[0].repeats, 1);
  }));

test('section with Notifs off: logged, not surfaced', () =>
  withRack({ localStorage: { eveRackTrackerSettings: { sections: { A7: { show: true, watch: false } } } } }, async tm => {
    await setSlot(tm, 'EVE02', 'U2', { color: 'red' });
    await tm.waitFor(async () => (await tm.eval('__eve.getAlertLog()')).length === 1, { message: 'log entry' });
    await tm.page.waitForTimeout(800);
    assert.equal(await cardCount(tm), 0);
    assert.equal((await tm.gm()).notifications.length, 0);
  }));

test('cards survive a page reload without re-alerting', () =>
  withRack({}, async tm => {
    await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'card' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length === 1, { message: 'toast' });
    await tm.reload(); // fixture serves the original (all testing) page again
    await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel after reload' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'restored card' });
    await tm.page.waitForTimeout(1500);
    assert.equal(await cardCount(tm), 1);
    assert.equal((await tm.gm()).notifications.length, 0, 'no new toast after reload (fresh GM stub)');
  }));

test('soft refresh: a result that arrives via the background re-fetch is detected', () =>
  withRack({}, async (tm, server) => {
    server.rack.slot('EVE02', 'U2').color = 'red';
    await tm.eval('new Promise(r => __eve.performSoftRefresh(r))');
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'card from soft refresh' });
    assert.equal((await cards(tm))[0].serial, server.rack.slot('EVE02', 'U2').serial);
    assert.ok(await tm.page.$('#eve-tracker-panel'), 'our UI survived the body swap');
  }));

test('card click opens TestView for the serial and hands it over via GM storage', () =>
  withRack({}, async (tm, server) => {
    const serial = server.rack.slot('EVE01', 'U1').serial;
    await setSlot(tm, 'EVE01', 'U1', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'card' });
    await tm.page.click('.eve-alert .eve-alert-status');
    const gm = await tm.waitFor(async () => { const g = await tm.gm(); return g.windowOpens.length && g; }, { message: 'window.open' });
    assert.deepEqual(gm.windowOpens, [`https://testview-eve-fmt.hyvesolutions.org/slt/list#eveSn=${serial}`]);
    assert.equal(JSON.parse(gm.store.eveTestViewHandoff).serial, serial);
  }));

test('clicking the serial copies it and does NOT open TestView', () =>
  withRack({}, async tm => {
    await setSlot(tm, 'EVE01', 'U1', { color: 'red' });
    await tm.waitFor(async () => (await cardCount(tm)) === 1, { message: 'card' });
    await tm.page.click('.eve-alert button.eve-alert-serial');
    await tm.page.click('.eve-alert .eve-alert-close');
    await tm.page.waitForTimeout(300);
    assert.equal((await tm.gm()).windowOpens.length, 0);
    assert.equal(await cardCount(tm), 0, 'close removed the card');
  }));

test('toast click with target "TestView search" opens TestView; default target opens Jira', async () => {
  await withRack({ localStorage: { eveRackTrackerSettings: { notificationClickTarget: 'detail' } } }, async (tm, server) => {
    const serial = server.rack.slot('EVE02', 'U3').serial;
    await setSlot(tm, 'EVE02', 'U3', { color: 'red' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length, { message: 'toast' });
    await tm.eval('__gm.lastNotification.onclick && __gm.lastNotification.onclick()');
    const gm = await tm.waitFor(async () => { const g = await tm.gm(); return g.openedTabs.length && g; }, { message: 'tab' });
    assert.ok(gm.openedTabs.includes(`https://testview-eve-fmt.hyvesolutions.org/slt/list#eveSn=${serial}`), gm.openedTabs.join());
  });
  // Default target: Jira. A failure opens its ticket (a toast click is not a
  // user gesture, so with no ticket yet it waits instead of opening a tab).
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE02', 'U3').serial;
  server.jira.set(serial, [{ key: 'MFGS-4242', fields: { summary: `EVE: ${serial}`, created: new Date().toISOString(),
    status: { name: 'Open', statusCategory: { key: 'new' } } } }]);
  await withRack({ server }, async tm => {
    await setSlot(tm, 'EVE02', 'U3', { color: 'red' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length, { message: 'toast' });
    await tm.eval('__gm.lastNotification.onclick && __gm.lastNotification.onclick()');
    const gm = await tm.waitFor(async () => { const g = await tm.gm(); return g.openedTabs.length && g; }, { message: 'jira tab' });
    assert.deepEqual(gm.openedTabs, ['https://jira.synnex.com/browse/MFGS-4242']);
  });
});
