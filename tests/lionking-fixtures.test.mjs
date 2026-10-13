// Fixture-anchored rack mapping, against the real userscript, a synthetic Lion source and a
// synthetic TestView API. Nothing here touches a real host, serial or ticket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  launchBrowser, FxServer, openFx, registryOf, rec, pacific, slotSel, slotText, efm, identity, scanRack, locateNote, changeRow,
  BOARD, RACK, RACK_B7, OP, PRE, REGISTRY_KEY, OCCUPANCY_KEY, API_PATH, LIVE_ROWS
} from './harness/fixtures.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const FX = n => `2699FX${String(n).padStart(4, '0')}`;
const resolve = (tm, position, rack = RACK) =>
  tm.eval(`__eve.resolveLionSlot(${JSON.stringify(rack)}, ${position}, true)`);
const resolveRack = (tm, rack = RACK) => tm.eval(`__eve.resolveLionRack(${JSON.stringify(rack)}, true)`);
const registry = tm => efm(tm, 'registry()');
const occupancy = tm => efm(tm, 'occupancy()');
async function finish(tm, server) {
  assert.deepEqual(tm.errors, [], 'no uncaught page errors');
  assert.deepEqual(server.unrouted, [], 'every request stayed inside the synthetic fixtures');
  // The Lion source, the TestView UUT API and (the board's existing ticket lookup) Jira: no other host.
  assert.ok(server.requests.every(request => /^GET (rack\.test\/out\/out\.evelionking_all\.php|testview-eve-fmt\.hyvesolutions\.org\/api\/v1\/uut_status\/view|jira\.synnex\.com\/)/.test(request)),
    'unexpected request: ' + JSON.stringify([...new Set(server.requests.map(r => r.split('?')[0]))]));
}

test('setup is one fixture scan per position and advances to the next position without one', async () => {
  const server = new FxServer();
  const { tm } = await openFx(browser, { server });
  try {
    await tm.page.click(`${slotSel(0)} .lion-rack-slot-select`);
    await tm.page.click('#lion-fixture-setup > summary');
    const sequence = [[0, 'Top middle'], [2, 'Left middle'], [3, 'Right middle'], [1, 'Bottom middle']];
    for (const [index, [position, label]] of sequence.entries()) {
      assert.match(await tm.page.textContent('#lion-rack-selected-position'), new RegExp(label));
      assert.equal(await tm.page.evaluate(() => document.activeElement?.id), 'lion-fixture-serial', 'ready for the scan');
      await tm.page.fill('#lion-fixture-serial', FX(index + 1));
      await tm.page.press('#lion-fixture-serial', 'Enter');
      assert.equal(await tm.page.textContent('#lion-fixture-feedback'), `${FX(index + 1)} saved to ${label}.`);
      assert.deepEqual((await registry(tm)).slots[RACK][position].fixtures, [FX(index + 1)]);
    }
    assert.match(await tm.page.textContent('#lion-rack-selected-position'), /Bottom middle/, 'stays on the last position');
    const saved = await registry(tm);
    assert.deepEqual(saved.history.map(item => item.type), Array(4).fill('FIXTURE_ADDED'));
    await tm.waitFor(() => server.calls.length >= 8, { message: 'both operations looked up for four fixtures' });
    for (let index = 1; index <= 4; index += 1) {
      const calls = server.forFixture(FX(index));
      assert.deepEqual(calls.map(call => call.operation).sort(), [PRE, OP].sort());
      assert.ok(calls.every(call => call.exact === 'true' && call.latest === 'false'), 'exact operation, full history');
    }
    assert.equal(await tm.page.evaluate(() => !!localStorage.getItem('eveLionRackFixtureRegistryV1')), true, 'saved to the local fallback too');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('only an active test fills a slot; history alone is "Waiting for new"; fixture ids stay out of the JBOG cards', async () => {
  const [F0, F1, F2, F3] = [FX(101), FX(102), FX(103), FX(104)];
  const server = new FxServer().add(
    rec(F0, '2699YW4001', { ago: 1 }),
    rec(F1, '2699YW4002', { ago: 5, done: 3 }),
    rec(F2, '2699YW4003', { ago: 1 }), rec(F2, '2699YW4004', { ago: 0.7 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F0, F1, F2, F3] }) });
  try {
    await scanRack(tm, RACK);
    await tm.waitFor(async () => /4 fixtures detected/.test(await locateNote(tm) || ''), { message: 'rack summary' });
    assert.equal(await locateNote(tm), `${RACK} \u{b7} 4 fixtures detected: Top: ${F0} (Occupied); Right: ${F3} (Empty); ` +
      `Left: ${F2} (Check location); Bottom: ${F1} (Waiting for new) \u{b7} 1/4 assigned \u{b7} 1 to check \u{b7} 1 running`);
    const top = await slotText(tm, 0);
    assert.match(top, /2699YW4001/); assert.match(top, /Running/); assert.match(top, /occupied/);
    const bottom = await slotText(tm, 1);
    assert.match(bottom, /Waiting for new/); assert.match(bottom, /Last tested/); assert.doesNotMatch(bottom, /2699YW4002/);
    const left = await slotText(tm, 2);
    assert.match(left, /Check location/); assert.match(left, /2699YW4003/); assert.match(left, /2699YW4004/);
    const right = await slotText(tm, 3);
    assert.match(right, /Empty/); assert.match(right, /No test records yet/);
    // A fixture shows where no JBOG is, and in the tooltip of a slot that has one. It is never shown as a JBOG.
    assert.match(bottom, new RegExp(F1)); assert.match(right, new RegExp(F3));
    assert.ok(!top.includes(F0), 'a slot with a JBOG shows the JBOG, not its fixture');
    assert.match(await tm.page.getAttribute(`${slotSel(0)} .lion-rack-slot-select`, 'title'), new RegExp(`Fixture ${F0}`));
    assert.equal(await tm.page.locator(`${BOARD} .lion-rack-sn:not(.lion-rack-sn-note)`).evaluateAll(
      (items, fixtures) => items.filter(item => fixtures.includes(item.textContent.trim())).length, [F0, F1, F2, F3]), 0,
    'no fixture is listed as a JBOG');
    assert.equal(await tm.page.getAttribute(`${BOARD} [data-rack="${RACK}"]`, 'data-worst'), 'check');

    // History-only slot: the unit is available on demand, and an operator may confirm it.
    await tm.page.click(`${slotSel(1)} .lion-rack-slot-select`);
    await tm.waitFor(async () => (await tm.page.textContent('#lion-rack-selected-info')).includes('2699YW4002'), { message: 'last tested' });
    assert.match(await tm.page.textContent('#lion-rack-selected-info'), /Last tested, from TestView history/);
    assert.equal(await tm.page.locator('#lion-fixture-confirm').isVisible(), true);
    assert.match(await tm.page.textContent('#lion-rack-selected-info .lion-fixture-line'), new RegExp(`Fixture detected ${F1} \u{b7} `));
    assert.equal(await tm.page.locator('#lion-rack-selected-info .lion-selected-facts dd').filter({ hasText: F1 }).count(), 0,
      'the fixture is not listed as the unit');
    await tm.page.click('#lion-fixture-confirm');
    assert.match(await slotText(tm, 1), /2699YW4002/); assert.match(await slotText(tm, 1), /confirmed/);
    assert.equal((await identity(tm, 1)).mode, 'confirmed');
    assert.match(await tm.page.textContent('#lion-rack-selected-info'), /Confirmed by an operator/);
    assert.equal((await registry(tm)).history.at(-1).type, 'JBOG_ASSOCIATED');
    // A history refresh keeps the confirmed unit.
    await resolve(tm, 1);
    assert.equal((await identity(tm, 1)).serial, '2699YW4002');
    // The setup view lists the fixture too.
    await tm.page.click('#lion-fixture-setup > summary');
    assert.match(await tm.page.textContent('#lion-fixture-list'), new RegExp(F1));
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a finished test keeps its slot, an outage dims it without clearing, and a newer unit replaces it', async () => {
  const F = FX(201), first = rec(F, '2699YW4101', { ago: 1 });
  const server = new FxServer().add(first);
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F] }) });
  try {
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4101.*Running/);
    // The test completes: the unit stays where it was observed.
    Object.assign(first, { status: 'Success', finished: pacific(Date.now() - 60000) });
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4101.*Passed/);
    assert.equal((await identity(tm, 0)).mode, 'observed');
    // TestView stops answering: the unit is dimmed as last known, never cleared.
    server.status.set(F, 500);
    await resolve(tm, 0);
    assert.equal((await identity(tm, 0)).mode, 'stale');
    assert.match(await slotText(tm, 0), /2699YW4101/); assert.match(await slotText(tm, 0), /last known/);
    assert.equal(await tm.page.locator(slotSel(0)).evaluate(el => el.classList.contains('is-stale')), true);
    assert.equal((await occupancy(tm)).slots[RACK][0].state, 'unavailable');
    // Recovery with a different unit testing on the fixture: replaced once, no removal announced.
    server.status.delete(F);
    server.add(rec(F, '2699YW4102', { ago: 0.2 }));
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4102.*Running/);
    assert.equal(await tm.page.locator(slotSel(0)).evaluate(el => el.classList.contains('is-stale')), false);
    const events = (await occupancy(tm)).slots[RACK][0].events.map(event => event.type);
    assert.deepEqual(events, ['JBOG_ASSOCIATED', 'JBOG_REPLACED']);
    // Occupancy changes are not test results: no alert cards, no desktop notifications.
    assert.equal(await tm.page.locator('.eve-alert').count(), 0);
    assert.deepEqual((await tm.gm()).notifications, []);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('the x clears only the rotating JBOG; the same attempt is not added back, a newer one is', async () => {
  const F = FX(301), run = rec(F, '2699YW4201', { ago: 1 });
  const server = new FxServer().add(run);
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F] }) });
  try {
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4201/);
    await tm.page.click(`${slotSel(0)} [data-slot-action="remove"]`);
    assert.doesNotMatch(await slotText(tm, 0), /2699YW4201/);
    assert.match(await slotText(tm, 0), /Empty/);
    let saved = await registry(tm);
    assert.deepEqual(saved.slots[RACK][0].fixtures, [F], 'the fixture binding stays');
    assert.equal(saved.slots[RACK][0].suppress.id, String(run.id));
    assert.equal(saved.history.at(-1).type, 'JBOG_REMOVED');
    // Several history refreshes later it is still gone.
    for (let i = 0; i < 3; i += 1) await resolve(tm, 0);
    assert.doesNotMatch(await slotText(tm, 0), /2699YW4201/, 'a refresh must not lift the suppression');
    // The operator can restore the cleared attempt...
    await tm.page.click(`${slotSel(0)} .lion-rack-slot-select`);
    assert.equal(await tm.page.locator('#lion-fixture-undo').isVisible(), true);
    await tm.page.click('#lion-fixture-undo');
    await tm.waitFor(async () => /2699YW4201/.test(await slotText(tm, 0)), { message: 'restored' });
    // ...or clear again, and then a genuinely new attempt by the same unit does return.
    await tm.page.click(`${slotSel(0)} [data-slot-action="remove"]`);
    server.add(rec(F, '2699YW4201', { ago: 0.1 }));
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4201.*Running/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a slot under maintenance is excluded from lookups while its neighbours keep working', async () => {
  const [F0, F1] = [FX(401), FX(402)];
  const server = new FxServer().add(rec(F0, '2699YW4301', { ago: 1 }), rec(F1, '2699YW4302', { ago: 1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F0, F1] }) });
  try {
    await resolveRack(tm);
    await tm.page.click(`${slotSel(0)} .lion-rack-slot-select`);
    await tm.page.click('#lion-fixture-setup > summary');
    await tm.page.click('#lion-fixture-maintenance');
    assert.match(await slotText(tm, 0), /Under maintenance/); assert.doesNotMatch(await slotText(tm, 0), /2699YW4301/);
    assert.equal((await registry(tm)).slots[RACK][0].fixtures[0], F0, 'fixture history is kept');
    const before = [server.forFixture(F0).length, server.forFixture(F1).length];
    await resolveRack(tm);
    assert.equal(server.forFixture(F0).length, before[0], 'no lookup for the maintenance slot');
    assert.ok(server.forFixture(F1).length > before[1], 'its neighbour is still resolved');
    assert.match(await slotText(tm, 1), /2699YW4302/);
    await tm.page.click('#lion-fixture-maintenance');
    await tm.waitFor(async () => /2699YW4301/.test(await slotText(tm, 0)), { message: 'restored slot resolves again' });
    assert.deepEqual((await registry(tm)).history.filter(item => item.type === 'SLOT_MAINTENANCE_CHANGED').length, 2);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('replacing a fixture discards the old fixture\'s in-flight answer and resolves the new one from scratch', async () => {
  const [OLD, NEW] = [FX(501), FX(502)];
  const server = new FxServer().add(rec(OLD, '2699YW4401', { ago: 1 }), rec(NEW, '2699YW4402', { ago: 1 }));
  server.delay.set(OLD, 600);
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [OLD] }) });
  try {
    await tm.eval(`void __eve.resolveLionSlot(${JSON.stringify(RACK)}, 0, true)`);
    await tm.waitFor(() => server.forFixture(OLD).length >= 1, { message: 'old lookup started' });
    await tm.page.click(`${slotSel(0)} .lion-rack-slot-select`);
    await tm.page.click('#lion-fixture-setup > summary');
    await tm.page.click('[data-fixture-action="replace"]');
    assert.match(await tm.page.textContent('#lion-fixture-label'), new RegExp(`replace ${OLD}`));
    await tm.page.fill('#lion-fixture-serial', NEW);
    await tm.page.press('#lion-fixture-serial', 'Enter');
    await tm.waitFor(async () => /2699YW4402/.test(await slotText(tm, 0)), { message: 'new fixture resolved' });
    await tm.page.waitForTimeout(900);
    assert.doesNotMatch(await slotText(tm, 0), /2699YW4401/, 'the replaced fixture\'s unit never appears');
    const saved = await registry(tm);
    assert.deepEqual(saved.slots[RACK][0].fixtures, [NEW]);
    assert.ok(saved.slots[RACK][0].rev > 1, 'binding revision advanced');
    assert.equal(saved.history.at(-1).type, 'FIXTURE_REPLACED');
    assert.equal((await occupancy(tm)).slots[RACK][0].rev, saved.slots[RACK][0].rev);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('moving a fixture is explicit and never leaves two bindings; bad scans and fixtures-as-JBOGs are refused', async () => {
  const [A, B] = [FX(601), FX(602)];
  const server = new FxServer();
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A, B] }) });
  try {
    await tm.page.click(`${slotSel(2)} .lion-rack-slot-select`);
    await tm.page.click('#lion-fixture-setup > summary');
    await tm.page.fill('#lion-fixture-serial', '1234');
    await tm.page.press('#lion-fixture-serial', 'Enter');
    assert.match(await tm.page.textContent('#lion-fixture-feedback'), /complete fixture serial/);
    await tm.page.fill('#lion-fixture-serial', A);
    await tm.page.press('#lion-fixture-serial', 'Enter');
    assert.match(await tm.page.textContent('#lion-fixture-feedback'), new RegExp(`${A} is saved at ${RACK} \u{b7} Top middle\\. Choose Move here`));
    assert.deepEqual((await registry(tm)).slots[RACK][2].fixtures, [], 'nothing changed yet');
    assert.equal(await tm.page.locator('#lion-fixture-move').isVisible(), true);
    await tm.page.click('#lion-fixture-move');
    const saved = await registry(tm);
    assert.deepEqual(saved.slots[RACK].map(slot => slot.fixtures), [[], [B], [A], []]);
    assert.deepEqual(saved.history.slice(-2).map(item => item.type), ['FIXTURE_MOVED', 'FIXTURE_MOVED']);
    assert.equal(saved.slots[RACK][0].rev > 1 && saved.slots[RACK][2].rev > 1, true, 'both bindings advanced');
    // The same fixture cannot be added twice to one position.
    await tm.page.fill('#lion-fixture-serial', A);
    await tm.page.press('#lion-fixture-serial', 'Enter');
    assert.match(await tm.page.textContent('#lion-fixture-feedback'), /already saved here/);
    // With Dev on, a saved fixture typed into the JBOG box is still a fixture and goes through the same move offer.
    await tm.page.fill('#lion-rack-serial', B);
    await tm.page.press('#lion-rack-serial', 'Enter');
    assert.match(await tm.page.textContent('#lion-rack-feedback'), new RegExp(`${B} is saved at ${RACK} \u{b7} Bottom middle\\. Choose Move here`));
    // With Dev off, the JBOG box refuses a saved fixture outright.
    await tm.page.click('.lion-rack-board-options > summary');
    await tm.page.uncheck('#lion-dev-mode');
    await tm.page.fill('#lion-rack-serial', B);
    await tm.page.press('#lion-rack-serial', 'Enter');
    assert.match(await tm.page.textContent('#lion-rack-feedback'), new RegExp(`${B} is a fixture, not a JBOG`));
    assert.deepEqual((await tm.eval('JSON.parse(localStorage.getItem("eveLionRackBoardV1")).slots["' + RACK + '"]')).map(slot => slot.serial), ['', '', '', '']);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('scanning a rack turns on its disabled row, resolves only that rack, and replays no alerts', async () => {
  const [A, B] = [FX(701), FX(702)];
  const server = new FxServer().add(rec(A, '2699YW4501', { ago: 1 }), rec(B, '2699YW4502', { ago: 1 }));
  const { tm } = await openFx(browser, { server, enabled: false,
    registry: registryOf({ [RACK]: [A], [RACK_B7]: [B] }) });
  try {
    assert.equal(await tm.page.isChecked(`${BOARD} [data-work-area="b6"]`), false);
    const alertsBefore = await tm.page.locator('.eve-alert').count();
    await scanRack(tm, RACK);
    await tm.waitFor(async () => /1\/4 assigned/.test(await locateNote(tm) || ''), { message: 'summary after lookup' });
    assert.match(await locateNote(tm), /^B6 turned on\. TA\.B6-EVE03 \u00b7 1 fixture detected: .* \u00b7 1\/4 assigned/);
    assert.equal(await tm.page.isChecked(`${BOARD} [data-work-area="b6"]`), true);
    assert.equal(await tm.page.isChecked(`${BOARD} [data-work-area="b7"]`), false, 'only the scanned rack\'s row');
    assert.match(await slotText(tm, 0), /2699YW4501/);
    assert.equal(server.forFixture(B).length, 0, 'the other, disabled row is never queried');
    assert.equal(await tm.page.locator('.eve-alert').count(), alertsBefore, 'enabling by scan creates no alert cards');
    // A serial scan still refuses a disabled row, as before.
    await tm.page.uncheck(`${BOARD} [data-work-area="b6"]`);
    await scanRack(tm, '2699YW4501');
    assert.match(await locateNote(tm), /is in B6, which is off/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('background lookups cover only enabled rows, two positions at a time, oldest first', async () => {
  const fixtures = [0, 1, 2, 3].map(i => FX(800 + i)), other = [0, 1, 2, 3].map(i => FX(810 + i));
  const server = new FxServer();
  server.delay.set(fixtures[0], 300); server.delay.set(fixtures[1], 300); server.delay.set(fixtures[2], 300);
  const { tm } = await openFx(browser, { server, enabled: false,
    registry: registryOf({ [RACK]: fixtures, [RACK_B7]: other }) });
  try {
    await tm.page.check(`${BOARD} [data-work-area="b6"]`);
    await tm.eval('__eve.pumpLionFixtures()');
    await tm.eval('__eve.pumpLionFixtures()');
    assert.ok((await efm(tm, 'busy()')) <= 2, 'never more than two positions in flight');
    await tm.waitFor(() => server.calls.length >= 4, { message: 'first two positions' });
    const touched = new Set(server.calls.map(call => call.fixture));
    assert.ok(touched.size <= 2, 'two positions per pass: ' + [...touched]);
    for (let i = 0; i < 6; i += 1) { await tm.page.waitForTimeout(400); await tm.eval('__eve.pumpLionFixtures()'); }
    await tm.waitFor(() => server.calls.length >= 8, { message: 'rest of the rack' });
    assert.ok(server.calls.every(call => fixtures.includes(call.fixture)), 'the disabled B7 row is never polled');
    // Just-resolved positions are not asked again inside the background interval.
    const count = server.calls.length;
    await tm.eval('__eve.pumpLionFixtures()'); await tm.page.waitForTimeout(500);
    assert.equal(server.calls.length, count);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('fixture registry backup and restore validate before replacing anything', async () => {
  const [A, B] = [FX(901), FX(902)];
  const server = new FxServer();
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A, B] }) });
  try {
    await tm.page.click('.lion-rack-board-options > summary');
    await tm.page.click('#lion-rack-edit-layout');
    const [download] = await Promise.all([tm.page.waitForEvent('download'), tm.page.click('#lion-fixture-backup')]);
    assert.equal(download.suggestedFilename(), 'lion-king-fixture-registry.json');
    const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(backup.kind, 'eve-lion-fixture-registry'); assert.deepEqual(backup.slots[RACK].map(slot => slot.fixtures), [[A], [B], [], []]);
    // Valid restore: move B to the left position.
    const next = structuredClone(backup); next.slots[RACK][1].fixtures = []; next.slots[RACK][2].fixtures = [B]; next.slots[RACK][2].custom = true;
    await tm.page.setInputFiles('#lion-rack-file', { name: 'ok.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
    await tm.waitFor(async () => (await tm.page.textContent('#lion-rack-restore')) === 'Restored', { message: 'restored' });
    let saved = await registry(tm);
    assert.deepEqual(saved.slots[RACK].map(slot => slot.fixtures), [[A], [], [B], []]);
    assert.equal(saved.slots[RACK][0].rev, 1, 'an unchanged binding keeps its revision');
    assert.ok(saved.slots[RACK][1].rev > 1 && saved.slots[RACK][2].rev > 1, 'changed bindings advance');
    // Invalid backups change nothing: wrong kind, and a duplicate fixture that normalization would drop.
    const wrong = { ...structuredClone(backup), kind: 'something-else' };
    const dupe = structuredClone(backup); dupe.slots[RACK][3].fixtures = [A]; dupe.slots[RACK][3].custom = true;
    for (const bad of [wrong, dupe, { nope: true }]) {
      await tm.page.setInputFiles('#lion-rack-file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
      await tm.waitFor(async () => (await tm.page.textContent('#lion-rack-restore')) === 'Invalid backup', { message: 'rejected' });
      await tm.page.evaluate(() => { document.querySelector('#lion-rack-restore').textContent = 'Restore'; });
      assert.deepEqual((await registry(tm)).slots[RACK].map(slot => slot.fixtures), [[A], [], [B], []]);
    }
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('what was observed survives a reload; the saved fixtures and the unit come back before any lookup', async () => {
  const F = FX(1001);
  const server = new FxServer().add(rec(F, '2699YW4601', { ago: 1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F] }) });
  try {
    await resolve(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW4601/);
    await tm.eval('__eve.flushLionOccupancy()');
    server.status.set(F, 500);                       // TestView is down after the reload
    const before = server.forFixture(F).length;
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel' });
    assert.equal(await tm.page.locator(BOARD).isVisible(), true, 'the map stays open across the reload');
    await tm.waitFor(async () => /2699YW4601/.test(await slotText(tm, 0)), { message: 'cached unit shown' });
    assert.equal((await identity(tm, 0)).mode === 'observed' || (await identity(tm, 0)).mode === 'stale', true);
    assert.deepEqual((await registry(tm)).slots[RACK][0].fixtures, [F]);
    assert.ok(server.forFixture(F).length >= before);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a server that ignores the fixture filter cannot put another fixture\'s units on a slot', async () => {
  const [A, B] = [FX(1101), FX(1102)];
  const server = new FxServer().add(rec(B, '2699YW4701', { ago: 1 }), rec(B, '2699YW4702', { ago: 0.5 }));
  server.leak = true;
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A] }) });
  try {
    await resolve(tm, 0);
    assert.doesNotMatch(await slotText(tm, 0), /2699YW470/);
    assert.match(await slotText(tm, 0), /Empty/);
    const diagnostics = await tm.eval(`__eve.lionFixtureDiagnostics(${JSON.stringify(RACK)}, 0)`);
    assert.match(diagnostics, /2 records, 0 used, 2 other fixture/);
    assert.match(diagnostics, /statuses: Running 2/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('PRETEST attempts are distinct, and one unit on both operations is not a conflict', async () => {
  const [A, B] = [FX(1201), FX(1202)];
  const server = new FxServer().add(
    rec(A, '2699YW4801', { ago: 0.3, op: PRE }),
    rec(B, '2699YW4802', { ago: 0.6, op: PRE, done: 0.2, status: 'Success' }), rec(B, '2699YW4802', { ago: 0.1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A, B] }) });
  try {
    await resolveRack(tm);
    assert.match(await slotText(tm, 0), /2699YW4801/); assert.match(await slotText(tm, 0), /Pre-test/);
    assert.equal((await identity(tm, 0)).state, 'PRETEST');
    assert.match(await slotText(tm, 1), /2699YW4802.*Running/, 'the same unit on PRETEST and the test is one occupant');
    const open = await tm.eval(`(() => { const v = __eve.lionRackSlotView(${JSON.stringify(RACK)}, 0); return [v.row.operation, v.row.detailURL]; })()`);
    assert.equal(open[0], PRE); assert.match(open[1], /\/uut\/detail\/\d+$/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a unit claimed by two positions goes to the one that is testing it now; otherwise both are flagged', async () => {
  const [A, B] = [FX(1301), FX(1302)];
  const first = rec(A, '2699YW4901', { ago: 2 });
  const server = new FxServer().add(first);
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A, B] }) });
  try {
    await resolveRack(tm);
    assert.equal((await identity(tm, 0)).serial, '2699YW4901');
    // The unit moves: its old test ends and it starts on the other fixture.
    Object.assign(first, { status: 'Success', finished: pacific(Date.now() - 3600000) });
    server.add(rec(B, '2699YW4901', { ago: 0.1 }));
    await resolveRack(tm);
    assert.equal((await identity(tm, 1)).serial, '2699YW4901');
    const old = await identity(tm, 0);
    assert.equal(old.mode, 'last'); assert.equal(old.serial, '');
    assert.match(await slotText(tm, 0), /Waiting for new/); assert.match(await slotText(tm, 0), /is testing in/);
    assert.deepEqual((await efm(tm, 'index()')).filter(([sn]) => sn === '2699YW4901').map(([, where]) => where.rackSlot), [2]);
    // Two finished claims and nothing running: neither is guessed.
    Object.assign(server.records.at(-1), { status: 'Success', finished: pacific(Date.now() - 60000) });
    await resolveRack(tm);
    const [x, y] = [await identity(tm, 0), await identity(tm, 1)];
    assert.deepEqual([x.mode, y.mode], ['conflict', 'conflict']);
    assert.match(await slotText(tm, 0), /claimed by more than one position/);
    assert.deepEqual((await efm(tm, 'index()')).filter(([sn]) => sn === '2699YW4901'), []);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('scanning finds a fixture or a resolved unit; a rack with fixtures cannot be removed', async () => {
  const F = FX(1401);
  const server = new FxServer().add(rec(F, '2699YW5001', { ago: 1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [undefined, undefined, F] }) });
  try {
    await resolveRack(tm);
    await scanRack(tm, F);
    assert.equal(await locateNote(tm), `Fixture ${F} is in ${RACK} \u{b7} Left middle \u{b7} Occupied`);
    assert.equal(await tm.page.locator(slotSel(2)).evaluate(el => el.classList.contains('is-found')), true);
    await scanRack(tm, '2699YW5001');
    assert.equal(await locateNote(tm), `2699YW5001 is in ${RACK} \u{b7} Left middle \u{b7} Running`);
    await tm.page.click('.lion-rack-board-options > summary');
    await tm.page.click('#lion-rack-edit-layout');
    await tm.page.locator(`${BOARD} [data-rack="${RACK}"] [data-rack-action="remove"]`).click();
    assert.equal(await tm.page.locator(`${BOARD} [data-rack="${RACK}"]`).count(), 1, 'still on the board');
    assert.equal(await tm.page.getAttribute(`${BOARD} [data-rack="${RACK}"] [data-rack-action="remove"]`, 'title'),
      'Remove its JBOGs and fixtures before removing this rack.');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('another tab\'s change to the registry is adopted without a reload', async () => {
  const [A, B] = [FX(1501), FX(1502)];
  const server = new FxServer().add(rec(B, '2699YW5101', { ago: 1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [A] }) });
  try {
    assert.deepEqual((await registry(tm)).slots[RACK].map(slot => slot.fixtures), [[A], [], [], []]);
    await tm.page.evaluate(({ key, value }) => {
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, { key: REGISTRY_KEY, value: JSON.stringify({ ...registryOf({ [RACK]: [undefined, B] }), revision: 7 }) });
    await tm.waitFor(async () => (await registry(tm)).slots[RACK][1].fixtures[0] === B, { message: 'registry adopted' });
    await resolveRack(tm);
    assert.match(await slotText(tm, 1), /2699YW5101/);
    assert.equal((await identity(tm, 0)).mode, 'empty', 'the removed binding no longer shows anything');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a resolved unit gives its alert card the physical location, including a card that already exists', async () => {
  const F = FX(1601);
  const server = new FxServer().add(rec(F, LIVE_ROWS[0].tail, { ago: 1 }));
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [undefined, undefined, F] }) });
  try {
    await changeRow(tm, 'a', { color: 'red', text: 'CHECK_GPU : 03:12' });
    await tm.waitFor(() => tm.page.$('.eve-alert'), { message: 'failure card' });
    assert.doesNotMatch(await tm.page.textContent('.eve-alert .eve-alert-loc'), /TA\.B6/, 'no location yet');
    await resolveRack(tm);
    await tm.waitFor(async () => /TA\.B6-EVE03/.test(await tm.page.textContent('.eve-alert .eve-alert-loc')), { message: 'card located' });
    assert.match(await tm.page.textContent('.eve-alert .eve-alert-loc'), /TA\.B6-EVE03 \u00b7 JBOG 3 \(Left middle\)/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

// ----------------------------------------------------------------------- the pure rules
const NOW = Date.now();
const attempt = (uut, id, { ago = 0.5, status = 'RUNNING', finished = '', op = OP, fixture = 'FXU000001' } = {}) =>
  ({ uut, id: String(id), startedAt: NOW - ago * 3600000, op, status, started: 'x', finished, raw: status, fixture });
const config = (extra = {}) => ({ fixtures: ['FXU000001'], maintenance: false, rev: 4, changedAt: 0, suppress: null, ...extra });
const ok = (rows, complete = true) => ({ ok: true, complete, rows, diag: null });
const FAILED = { ok: false, complete: false, rows: [], diag: null };
const J = JSON.stringify;
async function evaluate(tm, cfg, prior, results, live = {}) {
  return tm.eval(`JSON.parse(JSON.stringify(__eve.evaluateLionSlot(${J(cfg)}, ${J(prior)}, ${J(results)}, sn => (${J(live)})[sn] || null, ${NOW})))`);
}

test('evaluateLionSlot: the evidence rules, one at a time', async () => {
  const { tm, server } = await openFx(browser, { open: false });
  try {
    const done = (uut, id, ago) => attempt(uut, id, { ago, status: 'PASS', finished: 'done' });
    // History only, several older units: nothing is confirmed; the newest is only "last".
    let next = await evaluate(tm, config(), null, [ok([done('U1', 1, 9), done('U2', 2, 5), done('U3', 3, 3), done('U4', 4, 7), done('U5', 5, 4)])]);
    assert.equal(next.occ, null); assert.equal(next.last.uut, 'U3'); assert.deepEqual(next.active, []); assert.equal(next.state, 'ok');
    // One unique active attempt is observed (not claimed as presence).
    next = await evaluate(tm, config(), null, [ok([done('U1', 1, 9), attempt('U2', 2)])]);
    assert.equal(next.occ.uut, 'U2'); assert.equal(next.occ.evidence, 'active'); assert.deepEqual(next.events.map(e => e.type), ['JBOG_ASSOCIATED']);
    const occupied = next;
    // The test completing does not clear it, and its result is carried.
    next = await evaluate(tm, config(), occupied, [ok([attempt('U2', 2, { status: 'PASS', finished: 'done' })])]);
    assert.equal(next.occ.uut, 'U2'); assert.equal(next.occ.status, 'PASS'); assert.equal(next.active.length, 0);
    // A newer attempt by another unit replaces it (once); an older record by another unit does not.
    next = await evaluate(tm, config(), occupied, [ok([attempt('U2', 2), done('U9', 9, 8)])]);
    assert.equal(next.occ.uut, 'U2', 'an older record by another unit changes nothing');
    next = await evaluate(tm, config(), occupied, [ok([attempt('U2', 2, { status: 'PASS', finished: 'done' }), done('U7', 7, 0.1)])]);
    assert.equal(next.occ, null); assert.equal(next.last.uut, 'U7'); assert.deepEqual(next.events.map(e => e.type), ['JBOG_ASSOCIATED', 'JBOG_REPLACED']);
    // Two different units active at once is a conflict; the prior occupant is not overwritten.
    next = await evaluate(tm, config(), occupied, [ok([attempt('U2', 2), attempt('U8', 8, { ago: 0.2 })])]);
    assert.deepEqual([...next.conflict].sort(), ['U2', 'U8']); assert.equal(next.occ.uut, 'U2');
    // The same unit active on both operations is one occupant.
    next = await evaluate(tm, config(), null, [ok([attempt('U2', 2), attempt('U2', 3, { op: PRE, ago: 0.9 })])]);
    assert.equal(next.occ.uut, 'U2'); assert.deepEqual(next.conflict, []);
    // Outages and bad answers keep everything, and say so.
    next = await evaluate(tm, config(), occupied, [FAILED]);
    assert.equal(next.state, 'unavailable'); assert.equal(next.occ.uut, 'U2'); assert.equal(next.at, occupied.at);
    next = await evaluate(tm, config(), occupied, [FAILED, ok([])]);
    assert.equal(next.state, 'incomplete'); assert.equal(next.occ.uut, 'U2', 'an empty answer does not clear it');
    next = await evaluate(tm, config(), occupied, [ok([], false)]);
    assert.equal(next.state, 'incomplete'); assert.equal(next.occ.uut, 'U2');
    // A different binding revision discards the prior state entirely.
    next = await evaluate(tm, config({ rev: 5 }), occupied, [FAILED]);
    assert.equal(next.occ, null); assert.equal(next.rev, 5); assert.deepEqual(next.events, []);
    // Suppression applies to that attempt only.
    const suppress = { uut: 'U2', id: '2', at: NOW };
    next = await evaluate(tm, config({ suppress }), null, [ok([attempt('U2', 2)])]);
    assert.equal(next.occ, null); assert.deepEqual(next.active, []);
    assert.equal(next.last.id, '2', 'the cleared attempt stays available as the last one');
    next = await evaluate(tm, config({ suppress }), null, [ok([attempt('U2', 2), attempt('U2', 12, { ago: 0.1 })])]);
    assert.equal(next.occ.id, '12');
    // A cleared unit that another tab still has cached is not shown again.
    next = await evaluate(tm, config({ suppress }), { ...occupied, rev: 4 }, [ok([attempt('U2', 2)])]);
    assert.equal(next.occ, null);
    // An unrecognised status is not an active test unless the live source agrees on the same run.
    const odd = attempt('U6', 6, { status: 'UNKNOWN' });
    next = await evaluate(tm, config(), null, [ok([odd])]);
    assert.equal(next.occ, null); assert.equal(next.last.uut, 'U6');
    next = await evaluate(tm, config(), null, [ok([odd])], { U6: { status: 'RUNNING', startedAt: odd.startedAt } });
    assert.equal(next.occ.uut, 'U6');
    next = await evaluate(tm, config(), null, [ok([odd])], { U6: { status: 'RUNNING', startedAt: odd.startedAt - 1000 } });
    assert.equal(next.occ, null, 'a different run does not corroborate');
    // A "running" record older than any real test is not active.
    next = await evaluate(tm, config(), null, [ok([attempt('U5', 5, { ago: 49 })])]);
    assert.equal(next.occ, null);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('record validation: wrong fixture, bad ids, bad times and future starts are all rejected', async () => {
  const [F, G] = [FX(1701), FX(1702)];
  const server = new FxServer().add(rec(F, '2699YW5201', { ago: 1 }),
    { ...rec(F, '2699YW5202', { ago: 1 }), id: 'abc' },
    { ...rec(F, '2699YW5203', { ago: 1 }), started: 'yesterday' },
    { ...rec(F, '2699YW5204', { ago: -3 }) },                       // starts in the future
    { ...rec(F, '2699YW5205', { ago: 1 }), uut_sn: 'bad serial!' },
    { ...rec(F, '2699YW5206', { ago: 1 }), fixture_sn: FX(9999) },  // another fixture
    { ...rec(F, '2699YW5207', { ago: 1 }), operation: 'SLT' },
    { ...rec(F, '2699YW5208', { ago: 1 }), finished: pacific(Date.now() - 1800000) },   // "Running" with a real finish time
    { ...rec(G, '2699YW5209', { ago: 1 }), finished: '0000-00-00 00:00:00' });             // placeholder finish: still running
  server.leak = true;
  const { tm } = await openFx(browser, { server, registry: registryOf({ [RACK]: [F, G] }) });
  try {
    await resolveRack(tm);
    assert.match(await slotText(tm, 0), /2699YW5201/);
    for (const bad of ['5202', '5203', '5204', '5205', '5206', '5207', '5208']) assert.doesNotMatch(await slotText(tm, 0), new RegExp(bad));
    assert.equal((await identity(tm, 0)).mode, 'observed', 'one valid active attempt is not a conflict with the invalid ones');
    assert.match(await slotText(tm, 1), /2699YW5209/, 'a placeholder finish time does not hide a running test');
    await finish(tm, server);
  } finally { await tm.close(); }
});
