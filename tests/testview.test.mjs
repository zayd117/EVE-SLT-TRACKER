// TestView helper: card-click handoff -> test-detail redirect, list-query
// fallback, and the origin guard. Runs the real script on fixture TestView pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript, SCRIPT_SOURCE } from './harness/userscript.mjs';
import { FixtureServer, TESTVIEW_ORIGIN } from './harness/server.mjs';

const LIST = `${TESTVIEW_ORIGIN}/slt/list`;
const SN = '2699YW2001';
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const apiCalls = server => server.requests.filter(r => r.includes('/api/v1/server_level_tests/view'));

async function run(server, url, options, fn) {
  const tm = await openWithScript(browser, url, server, options);
  try {
    await fn(tm);
    assert.deepEqual(tm.errors, [], 'no uncaught page errors');
    assert.deepEqual(server.unrouted, [], 'no requests outside the fixtures');
  } finally {
    await tm.close();
  }
}

test('serial in the link -> looks up the test id and opens its detail page', async () => {
  const server = new FixtureServer();
  server.testview.api.set(SN, [{ id: 8000001, server_sn: SN, status: 'FAILED', started: '2026-01-01T01:00:00' }]);
  await run(server, `${LIST}#eveSn=${SN}`, {}, async tm => {
    await tm.page.waitForURL(`${TESTVIEW_ORIGIN}/slt/testdetail/8000001`, { timeout: 10000 });
    assert.equal(apiCalls(server).length, 1);
    assert.match(apiCalls(server)[0], new RegExp(`server_sn=${SN}`));
    assert.match(apiCalls(server)[0], /only_latest_slt=true/);
  });
});

test('several tests for the serial -> newest started wins; other serials ignored', async () => {
  const server = new FixtureServer();
  server.testview.api.set(SN, [
    { id: 11, server_sn: SN, started: '2026-01-01T01:00:00' },
    { id: 33, server_sn: '2699YW9999', started: '2026-03-01T01:00:00' },
    { id: 22, server_sn: SN.toLowerCase(), started: '2026-02-01T01:00:00' }
  ]);
  await run(server, `${LIST}#eveSn=${SN}`, {}, async tm => {
    await tm.page.waitForURL(`${TESTVIEW_ORIGIN}/slt/testdetail/22`, { timeout: 10000 });
  });
});

test('login redirect dropped the hash -> GM handoff still delivers the serial, once', async () => {
  const server = new FixtureServer();
  server.testview.api.set(SN, [{ id: 8000002, server_sn: SN, started: '2026-01-01T01:00:00' }]);
  const gmStore = { eveTestViewHandoff: JSON.stringify({ serial: SN, ts: Date.now() }) };
  await run(server, LIST, { gmStore }, async tm => {
    await tm.page.waitForURL(/\/slt\/testdetail\/8000002$/, { timeout: 10000 });
  });
});

test('stale handoff (older than 2 min) and no hash -> does nothing', async () => {
  const server = new FixtureServer();
  const gmStore = { eveTestViewHandoff: JSON.stringify({ serial: SN, ts: Date.now() - 10 * 60 * 1000 }) };
  await run(server, LIST, { gmStore }, async tm => {
    await tm.page.waitForTimeout(2500);
    assert.equal(apiCalls(server).length, 0);
    assert.equal(await tm.eval('__gm.store.eveTestViewHandoff'), undefined, 'stale handoff consumed');
    assert.deepEqual(await tm.page.evaluate(() => window.queries), []);
  });
});

async function expectListFallback(server) {
  await run(server, `${LIST}#eveSn=${SN}`, {}, async tm => {
    const rows = await tm.waitFor(async () => {
      const r = await tm.page.$$eval('tbody tr', els => els.map(e => e.textContent));
      return r.length === 1 && r;
    }, { timeout: 20000, message: 'table filtered to one row' });
    assert.deepEqual(rows, [SN]);
    assert.deepEqual(await tm.page.evaluate(() => window.queries), [SN], 'exactly one Query, with the SN');
    assert.equal(await tm.page.inputValue('#server_sn'), SN);
    assert.equal(new URL(tm.page.url()).hash, '', 'hash stripped so a reload does not re-run');
  });
}

test('no test found -> list fallback types the SN and presses Query once', async () => {
  await expectListFallback(new FixtureServer());
});

test('list fallback: serial not in TestView -> empty result counts as filtered (one Query, no retries)', async () => {
  const server = new FixtureServer();
  await run(server, `${LIST}#eveSn=2699YW0404`, {}, async tm => {
    await tm.waitFor(() => tm.trackerLogs(/results filtered/).length, { timeout: 20000, message: 'filtered log' });
    assert.deepEqual(await tm.page.evaluate(() => window.queries), ['2699YW0404']);
    assert.ok(await tm.page.$('.ant-table-placeholder'));
  });
});

test('API error -> list fallback', async () => {
  const server = new FixtureServer();
  server.testview.apiStatus = 500;
  await expectListFallback(server);
});

// Regression (v0.9.9 field bug): the Query click built MouseEvents with
// `view: window`, which throws under Tampermonkey's proxied window. The
// harness proxies window the same way, so the fallback above would fail with
// "Failed to convert value to 'Window'" if that ever comes back. This test
// proves the harness really reproduces it.
test('regression: harness reproduces the `view: window` crash', async () => {
  const buggy = SCRIPT_SOURCE.replace(
    'const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };',
    'const opts = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };'
  ).replace(/try \{\n\s+button\.dispatchEvent\(new Ctor\(type, opts\)\);\n\s+\} catch \(error\) \{\}/,
    'button.dispatchEvent(new Ctor(type, opts));');
  assert.notEqual(buggy, SCRIPT_SOURCE, 'mutation applied');
  const { instrument } = await import('./harness/userscript.mjs');
  const server = new FixtureServer();
  server.testview.apiStatus = 500;
  const tm = await openWithScript(browser, `${LIST}#eveSn=${SN}`, server, { source: instrument(buggy) });
  try {
    await tm.waitFor(() => tm.trackerLogs(/auto-query crashed/).length, { timeout: 20000, message: 'crash log' });
    assert.match(tm.trackerLogs(/auto-query crashed/)[0], /Failed to convert value to 'Window'/);
    assert.deepEqual(await tm.page.evaluate(() => window.queries), []);
  } finally {
    await tm.close();
  }
});

test('origin guard: another site with /slt/list gets nothing, handoff untouched', async () => {
  const server = new FixtureServer();
  const handoff = JSON.stringify({ serial: SN, ts: Date.now() });
  await run(server, `https://elsewhere.test/slt/list#eveSn=${SN}`, { gmStore: { eveTestViewHandoff: handoff } }, async tm => {
    await tm.page.waitForTimeout(2000);
    assert.equal(apiCalls(server).length, 0);
    assert.equal(await tm.eval('__gm.store.eveTestViewHandoff'), handoff);
    assert.equal(new URL(tm.page.url()).hash, `#eveSn=${SN}`);
  });
});

test('TestView page without a serial: script stays idle, tracker UI not injected', async () => {
  const server = new FixtureServer();
  await run(server, LIST, {}, async tm => {
    await tm.page.waitForTimeout(1500);
    assert.equal(apiCalls(server).length, 0);
    assert.equal(await tm.page.$('#eve-tracker-panel'), null);
  });
});
