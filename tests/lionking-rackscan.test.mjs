// Rack Map first-load state, per-rack status chips and the scan-to-find box.
// Uses the installed userscript and a local, synthetic Lion source. The built-in fixture list is emptied, so
// these racks are mapped by hand only (the fixture-mapped behaviour has its own suites).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES } from './harness/userscript.mjs';
import { FixtureServer } from './harness/server.mjs';
import { withBuiltIn } from './harness/fixtures.mjs';

const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
const BOARD = '#eve-lion-rack-board';
const RACK = 'TA.B6-EVE03';
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const started = hours => new Date(Date.now() - hours * 3600000).toISOString();
const ROWS = [
  { id: 'run', tail: '2699YW1001', head: '2699YW2001', started: started(1), color: 'lightgreen', text: 'X11-2C.TEST -- : 01:00' },
  { id: 'pass', tail: '2699YW1002', head: '2699YW2002', started: started(2), color: 'darkgreen', text: '06:00' },
  { id: 'fail', tail: '2699YW1003', head: '2699YW2003', started: started(1), color: 'red', text: 'CHECK_GPU : 03:12' }
];
class RackScanServer extends FixtureServer {
  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      const body = '<!doctype html><html><head><title>EVE LionKing GPU_JBOG_TEST</title></head><body>' +
        '<h2>EVE LionKing GPU_JBOG_TEST</h2><table><thead><tr>' +
        ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'].map(h => `<th>${h}</th>`).join('') +
        '</tr></thead><tbody>' + ROWS.map((r, i) =>
          `<tr><td>${i + 1}</td><td>${r.tail}</td><td>${r.head}</td><td>${r.started}</td>` +
          `<td bgcolor="${r.color}">${r.text}</td></tr>`).join('') + '</tbody></table></body></html>';
      return { status: 200, contentType: 'text/html', body };
    }
    return super.respond(url, req);
  }
}

async function openMap({ enabled = true } = {}) {
  const source = instrument(withBuiltIn(SCRIPT_SOURCE), [...new Set([...HOOK_NAMES, 'scanLionKing'])]);
  const tm = await openWithScript(browser, LION_URL, new RackScanServer(), { source });
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'Lion panel' });
  await tm.eval('__eve.scanLionKing()');
  if (enabled) await tm.page.click('#eve-show-all');
  return tm;
}

async function place(tm, position, serial) {
  await tm.page.click(`${BOARD} [data-rack="${RACK}"] [data-slot="${position}"] .lion-rack-slot-select`);
  await tm.page.fill('#lion-rack-serial', serial);
  await tm.page.press('#lion-rack-serial', 'Enter');
  await tm.waitFor(async () => (await tm.eval('__eve.state()')) && tm.page.locator(
    `${BOARD} [data-rack="${RACK}"] [data-slot="${position}"] .lion-rack-sn`).count(), { message: 'slot saved' });
}

const scan = async (tm, value) => {
  await tm.page.fill('#lion-rack-locate', value);
  await tm.page.press('#lion-rack-locate', 'Enter');
};
const note = tm => tm.page.textContent('#lion-rack-locate-note');

test('the Rack Map is closed on first load, keeps the tracker panel visible and stays closed after closing', async () => {
  const tm = await openMap({ enabled: false });
  try {
    assert.equal(await tm.page.locator(BOARD).isHidden(), true);
    assert.equal(await tm.page.locator('#eve-tracker-panel').isVisible(), true);
    assert.equal(await tm.page.evaluate(() => document.documentElement.classList.contains('lion-rack-map-active')), false);
    await tm.page.click('#lion-rack-open');
    assert.equal(await tm.page.locator(BOARD).isVisible(), true);
    assert.equal(await tm.page.locator('#eve-tracker-panel').isVisible(), false);
    await tm.page.click('#lion-rack-close');
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel after reload' });
    assert.equal(await tm.page.locator(BOARD).isHidden(), true);
    assert.equal(await tm.page.locator('#eve-tracker-panel').isVisible(), true);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('rack headers summarise their servers and scanning finds a rack or a server', async () => {
  const tm = await openMap();
  try {
    await tm.page.click('#lion-rack-open');
    assert.equal(await tm.page.evaluate(() => document.activeElement?.id), 'lion-rack-locate', 'scanner can start immediately');
    await place(tm, 0, ROWS[0].tail);
    await place(tm, 1, ROWS[1].tail);
    await place(tm, 2, ROWS[2].tail);
    const rack = `${BOARD} [data-rack="${RACK}"]`;
    await tm.waitFor(async () => (await tm.page.getAttribute(`${rack} .lion-rack-rollup`, 'aria-label').catch(() => '')) === '1 failed \u{b7} 1 running \u{b7} 1 passed',
      { message: 'roll-up chips' });
    assert.equal(await tm.page.getAttribute(rack, 'data-worst'), 'fail');
    assert.equal(await tm.page.locator(`${rack} .lion-rack-rollup b`).count(), 3);

    await scan(tm, 'ta.b6-eve03');
    assert.equal(await note(tm), `${RACK} \u{b7} 3/4 assigned \u{b7} 1 failed \u{b7} 1 running \u{b7} 1 passed`);
    assert.equal(await tm.page.inputValue('#lion-rack-locate'), '', 'ready for the next scan');
    assert.equal(await tm.page.locator(rack).evaluate(el => el.classList.contains('is-found')), true);

    await scan(tm, ROWS[2].tail);
    assert.equal(await note(tm), `${ROWS[2].tail} is in ${RACK} \u{b7} Left middle \u{b7} Test fail`);
    assert.equal(await tm.page.locator(`${rack} [data-slot="2"]`).evaluate(el => el.classList.contains('is-found')), true);
    await scan(tm, ROWS[2].head);
    assert.equal(await note(tm), `${ROWS[2].head} is in ${RACK} \u{b7} Left middle \u{b7} Test fail`, 'the partner node finds the same slot');

    await scan(tm, '2699YW9999');
    assert.match(await note(tm), /is not in any rack/);
    await scan(tm, 'TA.B6-EVE99');
    assert.match(await note(tm), /TA\.B6-EVE99 is not on the board/);

    await tm.page.uncheck(`${BOARD} [data-work-area="b6"]`);
    await scan(tm, ROWS[2].tail);
    assert.match(await note(tm), /is in B6, which is off/);
    assert.equal(await tm.page.locator(`${BOARD} [data-rack="${RACK}"] .lion-rack-rollup`).count(), 0, 'a disabled row shows no status');
    // Scanning the rack itself turns its row on (a serial scan does not).
    await scan(tm, RACK);
    assert.match(await note(tm), /^B6 turned on\. TA\.B6-EVE03 \u00b7 3\/4 assigned/);
    assert.equal(await tm.page.isChecked(`${BOARD} [data-work-area="b6"]`), true);
    assert.equal(await tm.page.locator(`${BOARD} [data-rack="${RACK}"] .lion-rack-rollup`).count(), 1, 'the enabled row shows its status again');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});
