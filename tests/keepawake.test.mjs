// Sleeping tabs: no banner, tip or notification - the tracker keeps itself
// awake (Web Lock, Worker tick, Screen Wake Lock while visible) and, if the
// browser still put the tab to sleep, catches up the moment it wakes.
// A userscript cannot add the site to Edge's "Always keep these sites
// active" list (edge:// pages are closed to pages and to Tampermonkey).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript } from './harness/userscript.mjs';
import { FixtureServer, RACK_URL } from './harness/server.mjs';

const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function open(server, options = {}) {
  const tm = await openWithScript(browser, RACK_URL, server, options);
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel' });
  await tm.waitFor(async () => /tick (worker|page timer)/.test(await status(tm)), { message: 'tick started' });
  return tm;
}
const status = tm => tm.page.$eval('#eve-keepalive-status', el => el.textContent).catch(() => '');

for (const [name, ua] of [['Edge', EDGE_UA], ['Chrome', undefined]]) {
  test(`${name}: no sleeping-tab banner, tip or settings buttons anywhere`, async () => {
    const tm = await open(new FixtureServer(), { userAgent: ua });
    try {
      assert.equal(await tm.page.$('#eve-sleep-banner'), null);
      assert.equal(await tm.page.$('[class*="eve-sleep"]'), null);
      const text = await tm.page.textContent('#eve-tracker-panel');
      assert.doesNotMatch(text, /Keep this page awake|Always keep these sites active|Copy settings link|Copy site/);
      assert.equal(await tm.page.evaluate(() => localStorage.getItem('eveRackTrackerKeepAwakeTipDone')), null);
    } finally { await tm.close(); }
  });
}

test('keeps itself awake: Web Lock, Screen Wake Lock and Worker tick are all attempted at start', async () => {
  const tm = await open(new FixtureServer());
  try {
    const s = await status(tm);
    assert.match(s, /lock (held|unsupported|failed)/, s);
    assert.match(s, /screen (held|denied|unsupported)/, s);
    assert.doesNotMatch(s, /not tried/, s);
    assert.match(s, /tick worker/, s);
  } finally { await tm.close(); }
});

test('after a sleep: catches up at once, silently - no banner, no desktop notification', async () => {
  const server = new FixtureServer();
  const tm = await open(server);
  try {
    const before = server.requests.filter(r => r.includes('out.eveslt.php')).length;
    await tm.eval('__eve.noteWake("frozen", Date.now() - 10 * 60 * 1000, Date.now(), true)'); // 10 min asleep
    await tm.waitFor(() => server.requests.filter(r => r.includes('out.eveslt.php')).length > before,
      { message: 'immediate catch-up refresh' });
    await tm.page.waitForTimeout(500);
    assert.deepEqual((await tm.gm()).notifications, [], 'no "was asleep" notification');
    assert.equal(await tm.page.$('#eve-sleep-banner'), null);
    assert.match(await status(tm), /sleeps 1 \(last 10m/);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});
