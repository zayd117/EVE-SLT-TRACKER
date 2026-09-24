// JIRAlerts window header: drag hitbox, fold/unfold, and the "..." actions
// menu (TXT / CSV export, dismiss all).
// Real pointer input (page.mouse) against the real script.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot } from './harness/rack.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function openWithPanel(cards = 1) {
  const { tm, server } = await openRack(browser);
  for (const unit of ['U1', 'U2', 'U3'].slice(0, cards)) {
    await setSlot(tm, 'EVE01', unit, { color: 'red' });
  }
  await tm.waitFor(async () => (await tm.page.$$('.eve-alert')).length === cards, { message: `${cards} card(s)` });
  return { tm, server };
}

const box = (tm, sel) => tm.page.$eval(sel, el => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});
const panelPos = async tm => { const b = await box(tm, '#eve-alert-container'); return { x: Math.round(b.x), y: Math.round(b.y) }; };
const collapsed = tm => tm.page.$eval('#eve-alert-container', el => el.classList.contains('eve-alerts-collapsed'));

// Point in the empty header area between the title and the buttons.
async function gapPoint(tm) {
  const toggle = await box(tm, '#eve-alert-toggle');
  const actions = await box(tm, '#eve-alert-header-actions');
  const header = await box(tm, '#eve-alert-header');
  return { x: (toggle.right + actions.x) / 2, y: header.y + header.h / 2 };
}

async function drag(tm, from, dx, dy) {
  await tm.page.mouse.move(from.x, from.y);
  await tm.page.mouse.down();
  await tm.page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await tm.page.mouse.up();
}

const menuOpen = tm => tm.page.$eval('#eve-alert-menu', el => !el.hidden);
const openMenu = async tm => { await tm.page.click('#eve-alert-menu-btn'); assert.equal(await menuOpen(tm), true, 'menu open'); };

test('title bar holds only the title and one compact menu button; the rest is drag area', async () => {
  const { tm } = await openWithPanel(2);
  try {
    const header = await box(tm, '#eve-alert-header');
    const actions = await box(tm, '#eve-alert-header-actions');
    const toggle = await box(tm, '#eve-alert-toggle');
    assert.ok(actions.w <= 32, `actions area is one small button (${actions.w}px)`);
    assert.ok(actions.x - toggle.right >= header.w * 0.4, `free drag gap ${actions.x - toggle.right}px of ${header.w}px`);
    for (const id of ['eve-alert-export', 'eve-alert-export-csv', 'eve-alert-dismiss-all']) {
      assert.equal(await tm.page.$eval(`#${id}`, el => el.closest('#eve-alert-header') === null && el.offsetParent === null), true, `${id} tucked away in the menu`);
    }
    assert.equal(await tm.page.getAttribute('#eve-alert-menu-btn', 'aria-expanded'), 'false');
    assert.equal(await tm.page.getAttribute('#eve-alert-menu-btn', 'aria-haspopup'), 'menu');
  } finally { await tm.close(); }
});

test('the menu opens below its button inside the viewport, closes on outside click and Escape', async () => {
  const { tm } = await openWithPanel(2);
  try {
    await openMenu(tm);
    assert.equal(await tm.page.getAttribute('#eve-alert-menu-btn', 'aria-expanded'), 'true');
    const btn = await box(tm, '#eve-alert-menu-btn');
    const menu = await box(tm, '#eve-alert-menu');
    const vp = tm.page.viewportSize();
    assert.ok(menu.y >= btn.bottom && menu.y <= btn.bottom + 8, 'directly below the button');
    assert.ok(menu.x >= 10 && menu.right <= vp.width - 10, 'inside the viewport');
    const item = await box(tm, '#eve-alert-export');
    const hit = await tm.page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('button')?.id, { x: item.x + item.w / 2, y: item.y + item.h / 2 });
    assert.equal(hit, 'eve-alert-export', 'menu item is on top and clickable');
    await tm.page.mouse.click(vp.width / 2, vp.height - 20);
    assert.equal(await menuOpen(tm), false, 'outside click closes');
    await openMenu(tm);
    await tm.page.keyboard.press('Escape');
    assert.equal(await menuOpen(tm), false, 'Escape closes');
    assert.equal(await tm.page.evaluate(() => document.activeElement.id), 'eve-alert-menu-btn', 'focus returns to the button');
    await tm.page.click('#eve-alert-menu-btn');
    await tm.page.click('#eve-alert-menu-btn');
    assert.equal(await menuOpen(tm), false, 'button toggles');
  } finally { await tm.close(); }
});

test('keyboard: Enter opens with focus on the first item, arrows move, Enter exports', async () => {
  const { tm } = await openWithPanel(2);
  try {
    await tm.page.focus('#eve-alert-menu-btn');
    await tm.page.keyboard.press('Enter');
    assert.equal(await tm.page.evaluate(() => document.activeElement.id), 'eve-alert-export');
    await tm.page.keyboard.press('ArrowDown');
    assert.equal(await tm.page.evaluate(() => document.activeElement.id), 'eve-alert-export-csv');
    await tm.page.keyboard.press('ArrowUp');
    await tm.page.keyboard.press('ArrowUp');
    assert.equal(await tm.page.evaluate(() => document.activeElement.id), 'eve-alert-dismiss-all', 'wraps around');
    await tm.page.keyboard.press('ArrowDown');
    const [txt] = await Promise.all([tm.page.waitForEvent('download'), tm.page.keyboard.press('Enter')]);
    assert.match(txt.suggestedFilename(), /\.txt$/);
    assert.equal(await menuOpen(tm), false);
  } finally { await tm.close(); }
});

test('the menu is not clipped when the panel is folded', async () => {
  const { tm } = await openWithPanel(2);
  try {
    await tm.page.click('#eve-alert-toggle');
    assert.equal(await collapsed(tm), true);
    await openMenu(tm);
    const item = await box(tm, '#eve-alert-export-csv');
    const hit = await tm.page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('button')?.id, { x: item.x + item.w / 2, y: item.y + item.h / 2 });
    assert.equal(hit, 'eve-alert-export-csv');
    const [csv] = await Promise.all([tm.page.waitForEvent('download'), tm.page.click('#eve-alert-export-csv')]);
    assert.match(csv.suggestedFilename(), /\.csv$/);
  } finally { await tm.close(); }
});

test('near the bottom of the screen the menu opens upward', async () => {
  const { tm } = await openWithPanel(2);
  try {
    const vp = tm.page.viewportSize();
    await drag(tm, await gapPoint(tm), 0, vp.height);
    await openMenu(tm);
    const btn = await box(tm, '#eve-alert-menu-btn');
    const menu = await box(tm, '#eve-alert-menu');
    assert.ok(menu.bottom <= btn.y, 'above the button');
    assert.ok(menu.y >= 10);
  } finally { await tm.close(); }
});

test('the empty area between title and buttons is the draggable header, and dragging it moves the panel', async () => {
  const { tm } = await openWithPanel();
  try {
    const p = await gapPoint(tm);
    const under = await tm.page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, p);
    assert.equal(under, 'eve-alert-header');
    const start = await panelPos(tm);
    await drag(tm, p, 300, 200);
    const end = await panelPos(tm);
    assert.deepEqual(end, { x: start.x + 300, y: start.y + 200 });
    assert.equal(await collapsed(tm), false, 'drag did not fold the panel');
    const saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerAlertPanelPosition')));
    assert.deepEqual(saved, { left: `${end.x}px`, top: `${end.y}px` }, 'position persisted');
  } finally { await tm.close(); }
});

test('the title can start a drag too; a plain click on it still folds and unfolds', async () => {
  const { tm } = await openWithPanel();
  try {
    const t = await box(tm, '#eve-alert-toggle');
    const start = await panelPos(tm);
    await drag(tm, { x: t.x + t.w / 2, y: t.y + t.h / 2 }, 200, 120);
    assert.deepEqual(await panelPos(tm), { x: start.x + 200, y: start.y + 120 });
    assert.equal(await collapsed(tm), false, 'a drag from the title does not fold');
    await tm.page.click('#eve-alert-toggle');
    assert.equal(await collapsed(tm), true, 'click folds');
    assert.equal(await tm.page.$eval('#eve-alert-caret', el => el.textContent), '▸');
    await tm.page.click('#eve-alert-toggle');
    assert.equal(await collapsed(tm), false, 'click unfolds');
  } finally { await tm.close(); }
});

test('menu: TXT and CSV download the log and close the menu; Dismiss all asks, then clears the cards', async () => {
  const { tm } = await openWithPanel(2); // Dismiss all is only shown with 2+ cards
  try {
    await openMenu(tm);
    const [txt] = await Promise.all([tm.page.waitForEvent('download'), tm.page.click('#eve-alert-export')]);
    assert.match(txt.suggestedFilename(), /^eve-slt-tracker-log-.*\.txt$/);
    assert.equal(await menuOpen(tm), false, 'closes after export');
    await openMenu(tm);
    const [csv] = await Promise.all([tm.page.waitForEvent('download'), tm.page.click('#eve-alert-export-csv')]);
    assert.match(csv.suggestedFilename(), /\.csv$/);
    await openMenu(tm);
    await tm.page.click('#eve-alert-dismiss-all');
    assert.match(await tm.page.textContent('#eve-alert-dismiss-all'), /Click again/);
    assert.equal((await tm.page.$$('.eve-alert')).length, 2, 'first click only arms');
    assert.equal(await menuOpen(tm), true, 'menu stays open to confirm');
    await tm.page.click('#eve-alert-dismiss-all');
    assert.equal((await tm.page.$$('.eve-alert')).length, 0);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('closing the menu disarms Dismiss all; with one card it is hidden', async () => {
  const { tm } = await openWithPanel(2);
  try {
    await openMenu(tm);
    await tm.page.click('#eve-alert-dismiss-all');
    await tm.page.keyboard.press('Escape');
    await openMenu(tm);
    assert.match(await tm.page.textContent('#eve-alert-dismiss-all'), /Dismiss all cards/, 'disarmed');
    await tm.page.click('#eve-alert-dismiss-all');
    await tm.page.mouse.click(5, tm.page.viewportSize().height - 5);
    assert.equal((await tm.page.$$('.eve-alert')).length, 2, 'nothing cleared');
    await tm.page.click('.eve-alert .eve-alert-close');
    await openMenu(tm);
    assert.equal(await tm.page.$eval('#eve-alert-dismiss-all', el => el.offsetParent === null), true, 'hidden with one card');
    assert.equal(await tm.page.$eval('.eve-menu-sep', el => el.offsetParent === null), true);
  } finally { await tm.close(); }
});

test('a drag never activates a control: ending on the menu button does not open it; starting on it does not drag', async () => {
  const { tm } = await openWithPanel();
  try {
    const start = await panelPos(tm);
    const btn = await box(tm, '#eve-alert-menu-btn');
    const p = await gapPoint(tm);
    await drag(tm, p, btn.x + btn.w / 2 - p.x, 0);
    assert.equal(await menuOpen(tm), false, 'drag released over the button did not open the menu');
    assert.equal(await collapsed(tm), false);
    const moved = await panelPos(tm);
    assert.notDeepEqual(moved, start, 'it was a drag');

    const btn2 = await box(tm, '#eve-alert-menu-btn');
    await drag(tm, { x: btn2.x + btn2.w / 2, y: btn2.y + btn2.h / 2 }, 0, 120);
    assert.deepEqual(await panelPos(tm), moved, 'pressing on the button never starts a drag');
    assert.equal(await menuOpen(tm), false, 'released elsewhere, so no click');
  } finally { await tm.close(); }
});

test('starting a drag closes an open menu', async () => {
  const { tm } = await openWithPanel();
  try {
    await openMenu(tm);
    await drag(tm, await gapPoint(tm), 120, 80);
    assert.equal(await menuOpen(tm), false);
  } finally { await tm.close(); }
});

// The drag maths was moved from the header's box to the panel's box (the
// header sits 1 px inside the border, which made the panel creep 1-2 px per
// drag). Snapping and clamping must still land exactly on the margins.
test('drag snaps to the corner margins and clamps to the viewport, with no creep', async () => {
  const { tm } = await openWithPanel();
  try {
    const margin = 10;
    const p = await gapPoint(tm);
    await drag(tm, p, 400, 300);
    const moved = await panelPos(tm);
    assert.deepEqual(moved, { x: margin + 400, y: margin + 300 }, 'exact move, no creep');
    const p2 = await gapPoint(tm);
    await drag(tm, p2, -(moved.x - margin) + 20, -(moved.y - margin) + 15);
    assert.deepEqual(await panelPos(tm), { x: margin, y: margin }, 'snapped into the top-left corner');
    const vp = tm.page.viewportSize();
    const p3 = await gapPoint(tm);
    await drag(tm, p3, vp.width + 500, vp.height + 500);
    const panel = await box(tm, '#eve-alert-container');
    const header = await box(tm, '#eve-alert-header');
    assert.equal(Math.round(panel.right), vp.width - margin, 'right edge clamped to the margin');
    assert.equal(Math.round(header.bottom), vp.height - margin, 'title bar clamped to the bottom margin');
  } finally { await tm.close(); }
});
