// Built-in fixture list, per-PC override and the Dev gate, against the real userscript with a synthetic Lion
// source and a synthetic TestView API. Nothing here touches a real host, serial or ticket: the script's
// shipped list is swapped for a test list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  launchBrowser, FxServer, openFx, registryOf, rec, slotSel, slotText, efm, identity, scanRack, locateNote,
  RACK, RACK_B7, BOARD, LIVE_ROWS, REGISTRY_KEY, DEV_KEY
} from './harness/fixtures.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const FX = n => `2699FX${String(n).padStart(4, '0')}`;
const LOCKED = 'Turn on Dev in the \u{22ef} board menu to change fixtures.';
// The built-in list is a constant in the script: tests run with their own list (rack -> fixture per position
// in slot order: top, bottom, left, right), never the shipped one.
const open = (server, map, extra = {}) => openFx(browser, { server, builtIn: map, ...extra });
const registry = tm => efm(tm, 'registry()');
const resolveRack = (tm, rack = RACK) => tm.eval(`__eve.resolveLionRack(${JSON.stringify(rack)}, true)`);
const shape = slots => slots.map(slot => [slot.fixtures, slot.custom]);
async function finish(tm, server) {
  assert.deepEqual(tm.errors, [], 'no uncaught page errors');
  assert.deepEqual(server.unrouted, [], 'every request stayed inside the synthetic fixtures');
}
const select = (tm, position) => tm.page.click(`${slotSel(position)} .lion-rack-slot-select`);
const setup = async (tm, position) => {
  await select(tm, position);
  if (!(await tm.page.locator('#lion-fixture-setup').evaluate(el => el.open))) await tm.page.click('#lion-fixture-setup > summary');
};
const scanFixture = async (tm, serial) => {
  await tm.page.fill('#lion-fixture-serial', serial);
  await tm.page.press('#lion-fixture-serial', 'Enter');
};
const scanJbog = async (tm, serial) => {
  await tm.page.fill('#lion-rack-serial', serial);
  await tm.page.press('#lion-rack-serial', 'Enter');
};
// The Dev box sits in the board's ... menu; the menu is a <details>, so open it only when it is closed.
async function dev(tm, on) {
  if (!(await tm.page.locator('.lion-rack-board-options').evaluate(el => el.open))) await tm.page.click('.lion-rack-board-options > summary');
  await tm.page[on ? 'check' : 'uncheck']('#lion-dev-mode');
}

test('a fresh PC maps a rack from the built-in list with no fixture scanned', async () => {
  const [A, B, C, D] = [FX(1), FX(2), FX(3), FX(4)];
  const server = new FxServer().add(rec(A, '2699YW5001', { ago: 1 }), rec(C, '2699YW5002', { ago: 0.5 }), rec(B, '2699YW5003', { ago: 6, done: 2 }));
  const { tm } = await open(server, { [RACK]: [A, B, C, D] });
  try {
    assert.equal(await tm.page.evaluate(key => localStorage.getItem(key), REGISTRY_KEY), null, 'nothing was set up on this PC');
    await scanRack(tm, RACK);
    await tm.waitFor(async () => /4 fixtures detected/.test(await locateNote(tm) || ''), { message: 'rack summary' });
    // Written order (top, right, left, bottom), each with its state in plain words.
    assert.equal(await locateNote(tm), `${RACK} \u{b7} 4 fixtures detected: Top: ${A} (Occupied); Right: ${D} (Empty); ` +
      `Left: ${C} (Occupied); Bottom: ${B} (Waiting for new) \u{b7} 2/4 assigned \u{b7} 2 running`);
    assert.match(await slotText(tm, 0), /2699YW5001.*Running/);
    assert.match(await slotText(tm, 2), /2699YW5002.*Running/);
    assert.doesNotMatch(await slotText(tm, 1), /2699YW5003/, 'history alone does not fill a slot');
    // A fixture shows where no JBOG is; it is never listed as a JBOG.
    assert.match(await slotText(tm, 1), new RegExp(B)); assert.match(await slotText(tm, 3), new RegExp(D));
    assert.equal(await tm.page.locator(`${BOARD} .lion-rack-sn:not(.lion-rack-sn-note)`).evaluateAll(
      (items, fixtures) => items.filter(item => fixtures.includes(item.textContent.trim())).length, [A, B, C, D]), 0);
    await setup(tm, 0);
    assert.equal(await tm.page.textContent('#lion-fixture-setup > summary'), 'Fixture setup');
    assert.equal(await tm.page.textContent('#lion-fixture-source'), 'Built-in fixture list.');
    assert.equal(await tm.page.locator('#lion-fixture-reset').isVisible(), false);
    assert.match(await tm.page.textContent('#lion-fixture-list'), new RegExp(A));
    assert.deepEqual(shape((await registry(tm)).slots[RACK]), [[[A], false], [[B], false], [[C], false], [[D], false]]);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('an override wins on this PC, is marked, and Reset to built-in brings the shared fixture back', async () => {
  const [A, B, N] = [FX(11), FX(12), FX(19)];
  const server = new FxServer().add(rec(A, '2699YW5101', { ago: 1 }), rec(N, '2699YW5102', { ago: 0.5 }));
  const { tm } = await open(server, { [RACK]: [A, B] });
  try {
    await setup(tm, 0);
    const queried = server.forFixture(A).length;            // looked up when the position was opened
    await tm.page.click('[data-fixture-action="replace"]');
    await scanFixture(tm, N);
    await tm.waitFor(async () => /2699YW5102/.test(await slotText(tm, 0)), { message: 'override fixture resolved' });
    let saved = await registry(tm);
    assert.deepEqual(shape(saved.slots[RACK]).slice(0, 2), [[[N], true], [[B], false]], 'the neighbour still follows the built-in list');
    assert.equal(await tm.page.textContent('#lion-fixture-setup > summary'), 'Fixture setup \u{b7} overridden');
    assert.equal(await tm.page.textContent('#lion-fixture-source'), `Overridden on this PC. Built-in: ${A}.`);
    assert.equal(await tm.page.locator('#lion-fixture-reset').isVisible(), true);
    await scanRack(tm, RACK);
    await tm.waitFor(async () => /overridden on this PC/.test(await locateNote(tm) || ''), { message: 'rack summary' });
    assert.match(await locateNote(tm), /1 fixture overridden on this PC/);
    assert.equal(server.forFixture(A).length, queried, 'the replaced built-in fixture is not queried again');
    // Reset: the built-in fixture is back, and its unit with it.
    await tm.page.click('#lion-fixture-reset');
    assert.equal(await tm.page.textContent('#lion-fixture-feedback'), 'Back to the built-in fixtures.');
    await tm.waitFor(async () => /2699YW5101/.test(await slotText(tm, 0)), { message: 'built-in fixture resolved' });
    saved = await registry(tm);
    assert.deepEqual(shape(saved.slots[RACK]).slice(0, 2), [[[A], false], [[B], false]]);
    assert.equal(saved.history.at(-1).type, 'FIXTURE_RESET');
    assert.ok(saved.slots[RACK][0].rev > 2, 'the binding changed twice');
    assert.equal(await tm.page.textContent('#lion-fixture-setup > summary'), 'Fixture setup');
    assert.equal(await tm.page.locator('#lion-fixture-reset').isVisible(), false);
    assert.doesNotMatch(await slotText(tm, 0), /2699YW5102/, 'the override\'s unit is gone with it');
    // The reset persisted too.
    assert.deepEqual(shape(JSON.parse(await tm.page.evaluate(key => localStorage.getItem(key), REGISTRY_KEY)).slots[RACK]).slice(0, 1), [[[A], false]]);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('removing a built-in fixture is an override; Reset waits while that fixture is set elsewhere on this PC', async () => {
  const [A, B] = [FX(21), FX(22)];
  const server = new FxServer();
  const { tm } = await open(server, { [RACK]: [A, B] });
  try {
    await setup(tm, 0);
    await tm.page.click('[data-fixture-action="remove"]');
    let saved = await registry(tm);
    assert.deepEqual(shape(saved.slots[RACK]).slice(0, 2), [[[], true], [[B], false]]);
    assert.equal(await tm.page.textContent('#lion-fixture-source'), `Overridden on this PC. Built-in: ${A}.`);
    assert.match(await tm.page.textContent('#lion-fixture-list'), /No fixture saved/);
    // The removed fixture is free: add it to the bottom position, next to its built-in one.
    await setup(tm, 1);
    await scanFixture(tm, A);
    saved = await registry(tm);
    assert.deepEqual(shape(saved.slots[RACK]).slice(0, 2), [[[], true], [[B, A], true]]);
    // Resetting the top position is refused: its built-in fixture is in use at the bottom.
    await setup(tm, 0);
    await tm.page.click('#lion-fixture-reset');
    assert.match(await tm.page.textContent('#lion-fixture-feedback'), new RegExp(`set at ${RACK} \u{b7} Bottom middle on this PC\\. Reset that position first`));
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[], true], [[B, A], true]], 'nothing changed');
    // Reset the bottom first, then the top.
    await setup(tm, 1);
    await tm.page.click('#lion-fixture-reset');
    await setup(tm, 0);
    await tm.page.click('#lion-fixture-reset');
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[A], false], [[B], false]]);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a registry saved before the built-in map existed is ignored on mapped racks and kept on the others', async () => {
  const [A, B, C, D, OWN, ELSEWHERE] = [FX(31), FX(32), FX(33), FX(34), FX(39), FX(38)];
  // The first test round saved scans with no map revision. On a rack the list covers they must not hide it.
  const old = registryOf({ [RACK]: [OWN, B], [RACK_B7]: [ELSEWHERE] }, { mapRevision: null });
  old.slots[RACK][2].rev = 3;                              // a position the built-in list now fills
  const server = new FxServer();
  const { tm } = await open(server, { [RACK]: [A, B, C, D] }, { registry: old });
  try {
    const slots = (await registry(tm)).slots;
    assert.deepEqual(shape(slots[RACK]), [[[A], false], [[B], false], [[C], false], [[D], false]], 'the built-in list shows');
    assert.deepEqual(slots[RACK].map(slot => slot.rev), [2, 1, 4, 2], 'a position whose fixture changed starts a new binding');
    assert.deepEqual(shape(slots[RACK_B7]), [[[ELSEWHERE], true], [[], false], [[], false], [[], false]], 'a rack the list does not cover keeps its own');
    await setup(tm, 0);
    assert.equal(await tm.page.textContent('#lion-fixture-setup > summary'), 'Fixture setup');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a registry saved by this map keeps its own lists; one equal to the built-in list dissolves; a changed built-in fixture drops its old lookups', async () => {
  const [A, B, C, D, OWN] = [FX(51), FX(52), FX(53), FX(54), FX(59)];
  const saved = registryOf({ [RACK]: [OWN, B] });          // no custom flags: judged against the built-in list
  saved.slots[RACK][2].rev = 3;                             // a position the built-in list now fills
  const server = new FxServer();
  const { tm } = await open(server, { [RACK]: [A, B, C, D] }, { registry: saved });
  try {
    const loaded = (await registry(tm)).slots[RACK];
    assert.deepEqual(shape(loaded), [[[OWN], true], [[B], false], [[C], false], [[D], false]]);
    assert.equal(loaded[0].rev, 1, 'an own list is left alone');
    assert.equal(loaded[1].rev, 1, 'a scan equal to the built-in one is now just the built-in one');
    assert.equal(loaded[2].rev, 4, 'a built-in fixture that replaced nothing starts a new binding');
    await setup(tm, 0);
    assert.equal(await tm.page.textContent('#lion-fixture-setup > summary'), 'Fixture setup \u{b7} overridden');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('backup keeps this PC\'s overrides and still rejects a file that would lose fixtures', async () => {
  const [A, B, N] = [FX(41), FX(42), FX(49)];
  const server = new FxServer();
  const { tm } = await open(server, { [RACK]: [A, B] });
  try {
    await setup(tm, 0);
    await tm.page.click('[data-fixture-action="replace"]');
    await scanFixture(tm, N);
    await tm.page.click('.lion-rack-board-options > summary');
    await tm.page.click('#lion-rack-edit-layout');
    const [download] = await Promise.all([tm.page.waitForEvent('download'), tm.page.click('#lion-fixture-backup')]);
    const backup = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.deepEqual(shape(backup.slots[RACK]).slice(0, 2), [[[N], true], [[B], false]]);
    const send = async file => {
      await tm.page.evaluate(() => { document.querySelector('#lion-rack-restore').textContent = 'Restore'; });
      await tm.page.setInputFiles('#lion-rack-file', { name: 'f.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
      await tm.waitFor(async () => (await tm.page.textContent('#lion-rack-restore')) !== 'Restore', { message: 'restore answered' });
      return tm.page.textContent('#lion-rack-restore');
    };
    assert.equal(await send(backup), 'Restored', 'a backup made with built-in fixtures in it restores');
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[N], true], [[B], false]]);
    const dupe = structuredClone(backup); dupe.slots[RACK][3].fixtures = [N]; dupe.slots[RACK][3].custom = true;
    assert.equal(await send(dupe), 'Invalid backup', 'a duplicate fixture would be dropped, so the file is refused');
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[N], true], [[B], false]]);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a fixture TestView has not seen for a week points at the fixture list; a recent one does not', async () => {
  const [OLD, FRESH, NONE] = [FX(61), FX(62), FX(63)];
  const server = new FxServer().add(rec(OLD, '2699YW5601', { ago: 250, done: 1 }), rec(FRESH, '2699YW5602', { ago: 50, done: 1 }));
  const { tm } = await open(server, { [RACK]: [OLD, FRESH, NONE] });
  try {
    await resolveRack(tm);
    const detail = async position => {
      await select(tm, position);
      return tm.page.textContent('#lion-rack-selected-info');
    };
    assert.match(await detail(0), /No tests on this fixture for 10 days\. If it was replaced, update it under Fixture setup\./);
    assert.doesNotMatch(await detail(1), /update it under Fixture setup/);
    const none = await detail(2);
    assert.match(none, /If it was replaced, update it under Fixture setup\./);
    assert.doesNotMatch(none, /No tests on this fixture for/);
    // A tester without Dev cannot change the list, so the hint names the built-in list instead.
    await dev(tm, false);
    assert.match(await detail(0), /No tests on this fixture for 10 days\. If it was replaced, the built-in fixture list needs updating\./);
    assert.doesNotMatch(await detail(0), /Fixture setup/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('Dev gate: fixture changes are locked until Dev is on; reading, finding and the JBOG box stay open', async () => {
  const [A, B] = [FX(71), FX(72)];
  const server = new FxServer().add(rec(A, '2699YW5701', { ago: 1 }));
  const { tm } = await open(server, { [RACK]: [A, B] }, { dev: false });
  try {
    await resolveRack(tm);
    await select(tm, 0);
    assert.match(await slotText(tm, 0), /2699YW5701/, 'the map reads without Dev');
    assert.equal(await tm.page.locator('#lion-fixture-setup').isVisible(), false, 'no fixture setup without Dev');
    assert.equal(await tm.page.textContent('#lion-rack-scan-label'), 'Scan the JBOG serial');
    assert.equal(await tm.page.textContent('#lion-rack-scan-save'), 'Add JBOG');
    assert.match(await tm.page.textContent('#lion-rack-selected-info .lion-fixture-line'), new RegExp(`Fixture detected ${A}`), 'the fixture is shown, not editable');
    // The code paths refuse on their own, whatever the page shows.
    const refused = await tm.eval(`[__eve.setLionFixture(${JSON.stringify(RACK)}, 0, 'FXNEW00001'), __eve.removeLionFixture(${JSON.stringify(RACK)}, 0, ${JSON.stringify(A)}), ` +
      `__eve.resetLionFixtures(${JSON.stringify(RACK)}, 0), __eve.setLionMaintenance(${JSON.stringify(RACK)}, 0, true)]`);
    assert.deepEqual(refused, Array(4).fill({ ok: false, message: LOCKED }));
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[A], false], [[B], false]], 'nothing changed');
    assert.equal(await tm.page.evaluate(key => localStorage.getItem(key), REGISTRY_KEY), null, 'nothing was saved');
    // Layout edit mode has no fixture backup without Dev.
    await tm.page.click('.lion-rack-board-options > summary');
    await tm.page.click('#lion-rack-edit-layout');
    assert.equal(await tm.page.locator('#lion-fixture-backup').isVisible(), false);
    // A JBOG still goes in by hand (the second position has no unit of its own).
    await select(tm, 1);
    await scanJbog(tm, '2699YW5702');
    assert.equal((await identity(tm, 1)).serial, '2699YW5702');
    // Dev on: the setup panel and the backup button appear, and the box takes a fixture or a JBOG.
    await dev(tm, true);
    assert.equal(await tm.page.evaluate(key => sessionStorage.getItem(key), DEV_KEY), '1');
    assert.equal(await tm.page.locator('#lion-fixture-setup').isVisible(), true);
    assert.equal(await tm.page.locator('#lion-fixture-backup').isVisible(), true);
    assert.equal(await tm.page.textContent('#lion-rack-scan-label'), 'Scan a JBOG or a fixture serial');
    assert.equal(await tm.page.textContent('#lion-rack-scan-save'), 'Add');
    // The setting is this tab's and survives a reload.
    await tm.reload();
    await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'panel' });
    await tm.waitFor(() => tm.page.$('#lion-dev-mode'), { message: 'board back' });
    assert.equal(await tm.page.isChecked('#lion-dev-mode'), true);
    await select(tm, 0);
    assert.equal(await tm.page.locator('#lion-fixture-setup').isVisible(), true);
    // Turning it off drops a half-done replace and hides the panel again.
    await tm.page.click('#lion-fixture-setup > summary');
    await tm.page.click('[data-fixture-action="replace"]');
    assert.match(await tm.page.textContent('#lion-fixture-label'), new RegExp(`replace ${A}`));
    await dev(tm, false);
    assert.equal(await tm.page.locator('#lion-fixture-setup').isVisible(), false);
    assert.equal(await tm.page.evaluate(key => sessionStorage.getItem(key), DEV_KEY), '0');
    await dev(tm, true);
    assert.equal(await tm.page.textContent('#lion-fixture-label'), 'Scan a fixture installed at this position');
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('Dev: an unknown serial in a mapped rack asks fixture or JBOG; a unit the live source lists just goes in', async () => {
  const [A, B, N, M] = [FX(81), FX(82), FX(89), FX(88)];
  const server = new FxServer();
  const { tm } = await open(server, { [RACK]: [A, B] });
  try {
    await select(tm, 0);
    await scanJbog(tm, N);
    assert.equal(await tm.page.locator('#lion-scan-choice').isVisible(), true);
    assert.equal(await tm.page.textContent('#lion-scan-choice p'), `${N} is new here. Replace fixture ${A} with it, or use it as the JBOG?`);
    await tm.page.click('[data-scan-choice="cancel"]');
    assert.equal(await tm.page.locator('#lion-scan-choice').isVisible(), false);
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[A], false], [[B], false]], 'cancel changes nothing');
    await scanJbog(tm, N);
    await tm.page.click('[data-scan-choice="fixture"]');
    assert.deepEqual(shape((await registry(tm)).slots[RACK]).slice(0, 2), [[[N], true], [[B], false]], 'as a fixture it replaces the one fixture here');
    // As a JBOG it is a by-hand assignment on a slot that has a fixture.
    await select(tm, 1);
    await scanJbog(tm, '2699YW5801');
    await tm.page.click('[data-scan-choice="jbog"]');
    assert.equal((await identity(tm, 1)).mode, 'manual');
    assert.match(await slotText(tm, 1), /2699YW5801/);
    // A position with no fixture offers to save one; a unit the live source lists is a JBOG without asking.
    await select(tm, 2);
    await scanJbog(tm, M);
    assert.equal(await tm.page.textContent('#lion-scan-choice p'), `${M} is new here. Save it as a fixture here, or use it as the JBOG?`);
    await tm.page.click('[data-scan-choice="cancel"]');
    await scanJbog(tm, LIVE_ROWS[0].tail);
    assert.equal(await tm.page.locator('#lion-scan-choice').isVisible(), false);
    assert.equal((await identity(tm, 2)).serial, LIVE_ROWS[0].tail);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a position the list leaves empty says "No fixture" and still takes a JBOG by hand', async () => {
  const [A, C] = [FX(91), FX(93)];
  const server = new FxServer().add(rec(A, '2699YW5901', { ago: 1 }));
  const { tm } = await open(server, { [RACK]: [A, '', C] }, { dev: false });
  try {
    await scanRack(tm, RACK);
    await tm.waitFor(async () => /2 fixtures detected/.test(await locateNote(tm) || ''), { message: 'rack summary' });
    assert.equal(await locateNote(tm), `${RACK} \u{b7} 2 fixtures detected: Top: ${A} (Occupied); Right: no fixture; ` +
      `Left: ${C} (Empty); Bottom: no fixture \u{b7} 1/4 assigned \u{b7} 1 running`);
    for (const position of [1, 3]) {
      assert.match(await slotText(tm, position), /No fixture/);
      assert.match(await slotText(tm, position), /No fixture in this position/);
    }
    assert.match(await slotText(tm, 2), /Empty/);
    await select(tm, 1);
    const info = await tm.page.textContent('#lion-rack-selected-info');
    assert.match(info, /No fixture here/);
    assert.match(info, /No fixture is listed for this position\. Scan a JBOG to place one by hand\./);
    await scanJbog(tm, '2699YW5902');
    assert.match(await slotText(tm, 1), /2699YW5902/);
    await finish(tm, server);
  } finally { await tm.close(); }
});

test('a rack barcode with a dot before EVE finds the same rack; a fixture or a unit scan names its position and state', async () => {
  const [A, B] = [FX(101), FX(102)];
  const server = new FxServer().add(rec(A, '2699YW6001', { ago: 1 }));
  const { tm } = await open(server, { [RACK]: [A, B] });
  try {
    await scanRack(tm, 'ta.b6.eve03');
    await tm.waitFor(async () => /2 fixtures detected/.test(await locateNote(tm) || ''), { message: 'rack summary' });
    assert.ok((await locateNote(tm)).startsWith(`${RACK} \u{b7} 2 fixtures detected: Top: ${A} (Occupied); Right: no fixture;`));
    await scanRack(tm, B);
    assert.equal(await locateNote(tm), `Fixture ${B} is in ${RACK} \u{b7} Bottom middle \u{b7} Empty`);
    await scanRack(tm, '2699YW6001');
    assert.equal(await locateNote(tm), `2699YW6001 is in ${RACK} \u{b7} Top middle \u{b7} Running`);
    await scanRack(tm, 'TA.B6.EVE99');
    assert.equal(await locateNote(tm), 'TA.B6-EVE99 is not on the board.');
    await finish(tm, server);
  } finally { await tm.close(); }
});
