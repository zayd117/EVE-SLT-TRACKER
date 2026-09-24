// Red (failed) rack cells open TestView through the SAME openTestView() the
// alert cards use, via ONE delegated listener. Everything else on the page -
// other colours, other tables, modifier clicks - keeps the browser's own
// behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot } from './harness/rack.mjs';
import { RACK_URL } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function withRack(fn) {
  const { tm, server } = await openRack(browser);
  try {
    await fn(tm, server);
    assert.deepEqual(tm.errors, [], 'no uncaught page errors');
  } finally { await tm.close(); }
}

const tv = serial => `https://testview-eve-fmt.hyvesolutions.org/slt/list#eveSn=${serial}`;
const opens = async tm => (await tm.gm()).windowOpens;
const cellSel = (col, unit) => `xpath=//tbody/tr[td[1][normalize-space()="${unit}"]]/td[${col + 1}]`;
const EVE01 = 1, EVE02 = 2;
const refresh = tm => tm.eval('new Promise(r => __eve.performSoftRefresh(r))');

test('clicking a red cell opens TestView exactly like the alert card (same URL, same handoff), not the old detail page', () =>
  withRack(async (tm, server) => {
    const serial = server.rack.slot('EVE01', 'U2').serial;
    await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
    await tm.page.click(`${cellSel(EVE01, 'U2')}//a`);
    await tm.waitFor(async () => (await opens(tm)).length === 1, { message: 'window.open' });
    assert.deepEqual(await opens(tm), [tv(serial)]);
    assert.equal(JSON.parse((await tm.gm()).store.eveTestViewHandoff).serial, serial);
    assert.equal(tm.page.url(), RACK_URL, 'old detail link was not followed');
    // The card for the same failure produces the identical destination.
    await tm.waitFor(() => tm.page.$('.eve-alert'), { message: 'card' });
    await tm.page.click('.eve-alert .eve-alert-status');
    await tm.waitFor(async () => (await opens(tm)).length === 2, { message: 'card open' });
    const [fromCell, fromCard] = await opens(tm);
    assert.equal(fromCell, fromCard);
  }));

test('the whole red cell is the target, not only the link text; each serial goes to its own TestView', () =>
  withRack(async (tm, server) => {
    await tm.page.addStyleTag({ content: 'td { padding: 12px !important; }' });
    await setSlot(tm, 'EVE01', 'U1', { color: 'red' });
    await setSlot(tm, 'EVE02', 'U3', { color: 'red' });
    for (const [col, unit, eve] of [[EVE01, 'U1', 'EVE01'], [EVE02, 'U3', 'EVE02']]) {
      const box = await (await tm.page.$(cellSel(col, unit))).boundingBox();
      await tm.page.mouse.click(box.x + 3, box.y + 3); // padding, outside the <a>
    }
    await tm.waitFor(async () => (await opens(tm)).length === 2, { message: '2 opens' });
    assert.deepEqual(await opens(tm), [tv(server.rack.slot('EVE01', 'U1').serial), tv(server.rack.slot('EVE02', 'U3').serial)]);
  }));

test('keyboard: Enter on a red cell link opens TestView', () =>
  withRack(async (tm, server) => {
    await setSlot(tm, 'EVE02', 'U1', { color: 'red' });
    await tm.page.focus(`${cellSel(EVE02, 'U1')}//a`);
    await tm.page.keyboard.press('Enter');
    await tm.waitFor(async () => (await opens(tm)).length === 1, { message: 'open' });
    assert.deepEqual(await opens(tm), [tv(server.rack.slot('EVE02', 'U1').serial)]);
    assert.equal(tm.page.url(), RACK_URL);
  }));

test('non-red cells keep their normal link (old detail page), nothing intercepted', () =>
  withRack(async (tm, server) => {
    const serial = server.rack.slot('EVE01', 'U3').serial; // lightgreen (testing)
    await Promise.all([tm.page.waitForURL(/eveserverdetail/), tm.page.click(`${cellSel(EVE01, 'U3')}//a`)]);
    assert.match(tm.page.url(), new RegExp(`in=${serial}`));
    assert.deepEqual(await opens(tm), []);
  }));

for (const [name, opts] of [
  ['Ctrl+click', { modifiers: ['Control'] }],
  ['Shift+click', { modifiers: ['Shift'] }],
  ['middle click', { button: 'middle' }]
]) {
  test(`${name} on a red cell keeps the browser's own behaviour (not intercepted)`, () =>
    withRack(async tm => {
      await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
      const popup = tm.context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
      await tm.page.click(`${cellSel(EVE01, 'U2')}//a`, opts);
      const opened = await popup;
      assert.deepEqual(await opens(tm), [], 'tracker did not open TestView');
      if (opened) {
        await opened.waitForLoadState('domcontentloaded').catch(() => {});
        assert.match(opened.url(), /eveserverdetail/, 'browser opened the link itself');
        await opened.close();
      }
    }));
}

test('red cells outside a rack table, the Unit column, headers and other links are not intercepted', () =>
  withRack(async tm => {
    await tm.page.evaluate(() => {
      const t = document.createElement('table');
      t.id = 'other';
      t.innerHTML = '<tr><th>Something else</th></tr><tr><td bgcolor="red"><a id="other-link" href="#other-link">2639YW114G X</a></td></tr>';
      document.body.appendChild(t);
      const row = [...document.querySelectorAll('tbody tr')].find(r => r.cells[0].textContent.trim() === 'U1');
      row.cells[0].setAttribute('bgcolor', 'red'); // a red Unit-column cell
      row.cells[0].innerHTML = '<a id="unit-link" href="#unit-link">U1</a>';
    });
    await tm.page.click('#other-link');
    assert.match(tm.page.url(), /#other-link$/, 'other table link followed normally');
    await tm.page.click('#unit-link');
    assert.match(tm.page.url(), /#unit-link$/, 'Unit column not intercepted');
    await tm.page.click('thead th:nth-child(2)');
    assert.deepEqual(await opens(tm), []);
  }));

test('after soft refreshes replace the table: new red cells work, one open per click, no extra DOM', () =>
  withRack(async (tm, server) => {
    const nodes = () => tm.page.evaluate(() => document.querySelector('tbody').getElementsByTagName('*').length);
    const before = await nodes();
    for (let i = 0; i < 3; i += 1) await refresh(tm);
    server.rack.slot('EVE02', 'U2').color = 'red';
    await refresh(tm);
    assert.equal(await nodes(), before, 'tracker added no elements to the table');
    await tm.page.click(`${cellSel(EVE02, 'U2')}//a`);
    await tm.page.waitForTimeout(500);
    assert.deepEqual(await opens(tm), [tv(server.rack.slot('EVE02', 'U2').serial)], 'exactly one open (no stacked listeners)');
    const listeners = await tm.page.evaluate(async () => document.querySelector('tbody td[bgcolor] a').getAttributeNames().join());
    assert.equal(listeners, 'href', 'cells are not modified');
  }));
