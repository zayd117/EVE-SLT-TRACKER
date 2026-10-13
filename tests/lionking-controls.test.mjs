// Controls parity uses the installed userscript and a local, synthetic Lion
// source. These tests exercise user actions without changing the shared harness.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES } from './harness/userscript.mjs';
import { FixtureServer } from './harness/server.mjs';

const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const started = hours => new Date(Date.now() - hours * 3600000).toISOString();
class ControlsServer extends FixtureServer {
  constructor() {
    super();
    this.rows = [
      { id: 'active', tail: '2699YW1001', head: '2699YW2001', started: started(1), color: 'lightgreen', text: 'X11-2C.TEST -- : 01:00' },
      { id: 'recent-pass', tail: '2699YW1002', head: '2699YW2002', started: started(2), color: 'darkgreen', text: '06:00' },
      { id: 'old-pass', tail: '2699YW1003', head: '2699YW2003', started: started(30), color: 'darkgreen', text: '06:00' },
      { id: 'old-active', tail: '2699YW1004', head: '2699YW2004', started: started(40), color: 'lightgreen', text: 'X11-2C.TEST -- : 40:00' }
    ];
  }
  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      const body = '<!doctype html><html><head><title>EVE LionKing GPU_JBOG_TEST</title></head><body>' +
        '<h2>EVE LionKing GPU_JBOG_TEST</h2><table id="controls-source"><thead><tr>' +
        ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'].map(h => `<th>${h}</th>`).join('') +
        '</tr></thead><tbody>' + this.rows.map((r, i) =>
          `<tr data-controls-fixture="${r.id}"><td>${i + 1}</td><td>${r.tail}</td><td>${r.head}</td>` +
          `<td>${r.started}</td><td bgcolor="${r.color}">${r.text}</td></tr>`).join('') +
        '</tbody></table></body></html>';
      return { status: 200, contentType: 'text/html', body };
    }
    return super.respond(url, req);
  }
}

async function openControls(options = {}) {
  const server = options.server || new ControlsServer();
  const source = instrument(SCRIPT_SOURCE, [...new Set([...HOOK_NAMES, 'scanLionKing'])]);
  const tm = await openWithScript(browser, LION_URL, server, { source, ...options });
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'Lion panel' });
  await tm.eval('__eve.scanLionKing()');
  if (options.enabled !== false) await tm.page.click('#eve-show-all');
  return { tm, server };
}
const visible = tm => tm.page.$$eval('#controls-source tbody tr', rows => rows
  .filter(row => !row.hidden && getComputedStyle(row).display !== 'none' && row.getClientRects().length)
  .map(row => row.dataset.controlsFixture));
const log = tm => tm.eval('__eve.getAlertLog()');
const notifications = async tm => (await tm.gm()).notifications;
const cardCount = tm => tm.page.locator('.eve-alert').count();
async function complete(tm) {
  await tm.page.evaluate(() => {
    const cell = document.querySelector('[data-controls-fixture="active"]').cells[4];
    cell.setAttribute('bgcolor', 'darkgreen');
    cell.firstChild.nodeValue = '06:00';
  });
  await tm.eval('__eve.scanLionKing()');
  await tm.waitFor(async () => (await log(tm)).length === 1, { message: 'observed completion audit' });
}
const checked = (tm, selector) => tm.page.isChecked(selector);
const group = key => `.eve-section-row[data-section="${key}"]`;
const show = (key = 'unassigned') => `${group(key)} .eve-show-checkbox`;
const GROUPS = ['b6', 'b7', 'lionking2', 'unassigned'];
async function assign(tm, serial, area) {
  await tm.page.check('#eve-developer-mode');
  await tm.page.locator('details:has(#lion-area-serial)').evaluate(el => { el.open = true; });
  await tm.page.fill('#lion-area-serial', serial);
  await tm.page.selectOption('#lion-area-choice', area);
  await tm.page.click('#lion-area-save');
}

test('four Lion groups default off with one Enabled switch for visibility and notifications', async () => {
  const { tm } = await openControls({ enabled: false });
  try {
    assert.deepEqual(await tm.page.$$eval('.eve-section-row', els => els.map(el => el.dataset.section)), GROUPS);
    assert.match(await tm.page.textContent(group('b6')), /B6/);
    assert.match(await tm.page.textContent(group('b7')), /B7/);
    assert.match(await tm.page.textContent(group('lionking2')), /E2.?E4.?BL/i);
    assert.match(await tm.page.textContent(group('unassigned')), /Unassigned/i);
    for (const selector of ['#eve-show-all', '#eve-hide-all']) {
      assert.equal(await tm.page.locator(selector).count(), 1, `${selector} is available`);
      assert.equal(await tm.page.locator(selector).isVisible(), true);
    }
    for (const key of GROUPS) {
      assert.equal(await tm.page.getAttribute(show(key), 'type'), 'checkbox');
      assert.equal(await tm.page.locator(show(key)).count(), 1);
      assert.equal(await checked(tm, show(key)), false);
      assert.deepEqual(await tm.eval(`__eve.state().settings.sections[${JSON.stringify(key)}]`), { show: false, watch: false });
    }
    assert.equal(await tm.page.locator('.eve-watch-checkbox').count(), 0);
    assert.deepEqual(await visible(tm), []);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('rack-map row arrows and Enabled switches share one state without per-rack switches', async () => {
  const { tm } = await openControls({ enabled: false });
  try {
    await tm.page.click('#lion-rack-open');
    const board = '#eve-lion-rack-board';
    for (const key of ['b6', 'b7', 'lionking2']) {
      assert.equal(await tm.page.getAttribute(`${board} [data-lion-row-toggle="${key}"]`, 'aria-expanded'), 'false');
      assert.equal(await tm.page.locator(`#lion-rack-row-${key}`).isVisible(), false);
    }
    assert.equal(await tm.page.locator(`${board} .lion-physical-rack input[type="checkbox"]`).count(), 0);
    await tm.page.click(`${board} [data-lion-row-toggle="b6"]`);
    assert.equal(await tm.page.getAttribute(`${board} [data-lion-row-toggle="b6"]`, 'aria-expanded'), 'true');
    assert.equal(await tm.page.locator('#lion-rack-row-b6').isVisible(), true);
    assert.equal(await checked(tm, `${board} [data-work-area="b6"]`), true);
    assert.deepEqual(await tm.eval('__eve.state().settings.sections.b6'), { show: true, watch: true });
    await tm.page.uncheck(`${board} [data-work-area="b6"]`);
    assert.equal(await tm.page.getAttribute(`${board} [data-lion-row-toggle="b6"]`, 'aria-expanded'), 'false');
    assert.equal(await tm.page.locator('#lion-rack-row-b6').isVisible(), false);
    assert.deepEqual(await tm.eval('__eve.state().settings.sections.b6'), { show: false, watch: false });
  } finally { await tm.close(); }
});

test('Hide All and Show All change source visibility while preserving the selected 24-hour history cutoff', async () => {
  const { tm } = await openControls();
  try {
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
    await tm.page.click('#eve-hide-all');
    for (const key of GROUPS) assert.equal(await checked(tm, show(key)), false);
    assert.deepEqual(await visible(tm), []);
    await tm.page.click('#eve-show-all');
    for (const key of GROUPS) assert.equal(await checked(tm, show(key)), true);
    assert.equal(await tm.page.inputValue('#lion-history-hours'), '24');
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
    assert.equal((await log(tm)).length, 0);
    assert.deepEqual(await notifications(tm), []);
  } finally { await tm.close(); }
});

test('disabling a row hides its source and silences notifications while completion auditing continues', async () => {
  const { tm } = await openControls();
  try {
    await tm.page.click('#eve-hide-all');
    await complete(tm);
    assert.deepEqual(await visible(tm), []);
    assert.deepEqual(await notifications(tm), []);
    assert.equal(await cardCount(tm), 0);
    assert.equal((await log(tm))[0].transition, 'TEST_SUCCESS');
    assert.equal(await checked(tm, show()), false);
    assert.deepEqual(await tm.eval('__eve.state().settings.sections.unassigned'), { show: false, watch: false });
  } finally { await tm.close(); }
});

test('Disable All suppresses cards and desktop toasts but retains observed completion audit events', async () => {
  const { tm } = await openControls();
  try {
    await tm.page.click('#eve-hide-all');
    for (const key of GROUPS) assert.equal(await checked(tm, show(key)), false);
    await complete(tm);
    assert.equal(await cardCount(tm), 0);
    assert.deepEqual(await notifications(tm), []);
    assert.equal((await log(tm))[0].tracker, 'lionking');
    assert.equal(await checked(tm, show()), false, 'visibility and notifications share one preference');
  } finally { await tm.close(); }
});

test('individual and bulk switches stay synchronized across repeated changes', async () => {
  const { tm } = await openControls();
  try {
    await tm.page.uncheck(show());
    assert.deepEqual(await visible(tm), []);
    await tm.page.click('#eve-show-all');
    assert.equal(await checked(tm, show()), true);
    await tm.page.click('#eve-hide-all');
    await tm.page.check(show());
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
    for (const key of GROUPS) {
      const enabled = key === 'unassigned';
      assert.deepEqual(await tm.eval(`__eve.state().settings.sections[${JSON.stringify(key)}]`), { show: enabled, watch: enabled });
    }
  } finally { await tm.close(); }
});

test('Lion controls persist across reload without overwriting existing SLT settings or state', async () => {
  const legacyLocal = {
    eveRackTrackerSettings: '{"sections":{"A7":{"show":false,"watch":false}},"refreshIntervalSeconds":30}',
    eveRackTrackerAlertLog: '[{"eventId":"fixture-existing-slt-log"}]'
  };
  const legacySession = { eveRackTrackerPreviousStates: '{"fixture-existing-slt-slot":{"color":"lightgreen"}}' };
  const { tm } = await openControls({ rawLocalStorage: legacyLocal, rawSessionStorage: legacySession });
  try {
    await assign(tm, '2699YW1001', 'b6');
    await tm.page.click('#eve-hide-all');
    await tm.page.selectOption('#eve-refresh-interval', '20');
    await tm.reload();
    await tm.waitFor(() => tm.page.$(show()), { message: 'reloaded section controls' });
    for (const key of GROUPS) {
      assert.equal(await checked(tm, show(key)), false);
    }
    assert.equal(await tm.page.inputValue('#eve-refresh-interval'), '20');
    assert.deepEqual(await visible(tm), []);
    const saved = await tm.page.evaluate(() => ({
      local: Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('eveRackTracker'))),
      session: Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('eveRackTracker'))),
      lion: JSON.parse(localStorage.getItem('lionKingTrackerSettings') || 'null')
    }));
    assert.deepEqual(saved.local, legacyLocal);
    assert.deepEqual(saved.session, legacySession);
    assert.equal(saved.lion.refreshIntervalSeconds, 20);
    assert.equal(saved.lion.lionNotifications, false);
    assert.equal(saved.lion.lionAreas['2699YW1001'], 'b6');
  } finally { await tm.close(); }
});

test('Auto refresh uses the shared interval selector and visible countdown badge', async () => {
  const { tm } = await openControls();
  try {
    assert.deepEqual(await tm.page.$$eval('#eve-refresh-interval option', els => els.map(el => el.value)), ['30', '20', '10']);
    assert.equal(await tm.page.locator('#eve-refresh-badge.eve-summary-badge').count(), 1);
    assert.equal(await tm.page.locator('#eve-refresh-badge').isVisible(), true);
    await tm.page.selectOption('#eve-refresh-interval', '10');
    await tm.waitFor(async () => {
      const text = await tm.page.textContent('#eve-refresh-badge');
      const count = Number((text.match(/\d+/) || [])[0]);
      return Number.isFinite(count) && count > 0 && count <= 10;
    }, { message: 'ten-second refresh countdown' });
    const saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('lionKingTrackerSettings')));
    assert.equal(saved.refreshIntervalSeconds, 10);
    assert.equal(await tm.page.inputValue('#eve-refresh-interval'), '10');
  } finally { await tm.close(); }
});

test('Log shift offers Auto and all shifts, keeps recorded events, and explains the current choice', async () => {
  const { tm } = await openControls();
  try {
    assert.deepEqual(await tm.page.$$eval('#eve-log-shift option', els => els.map(el => el.value)),
      ['auto', 'day', 'swing', 'graveyard']);
    assert.equal(await tm.page.inputValue('#eve-log-shift'), 'auto');
    assert.match(await tm.page.getAttribute('#eve-log-shift', 'title'), /Auto/);
    await complete(tm);
    const eventId = (await log(tm))[0].eventId;
    for (const choice of ['day', 'swing', 'graveyard', 'auto']) {
      await tm.page.selectOption('#eve-log-shift', choice);
      assert.equal(await tm.page.inputValue('#eve-log-shift'), choice);
      assert.match(await tm.page.getAttribute('#eve-log-shift', 'title'), choice === 'auto' ? /Auto/ : /Manual/);
      assert.deepEqual((await log(tm)).map(entry => entry.eventId), [eventId], 'changing report shift does not delete audit records');
    }
  } finally { await tm.close(); }
});

test('Enabled switches have accessible labels and respond to the keyboard', async () => {
  const { tm } = await openControls();
  try {
    for (const selector of GROUPS.map(key => show(key))) {
      const labeled = await tm.page.$eval(selector, input =>
        Boolean(input.getAttribute('aria-label')?.trim()) || [...input.labels].some(label => label.textContent.trim()));
      assert.equal(labeled, true, `${selector} has an accessible label`);
      await tm.page.focus(selector);
      await tm.page.keyboard.press('Space');
      assert.equal(await checked(tm, selector), false);
      await tm.page.keyboard.press('Space');
      assert.equal(await checked(tm, selector), true);
    }
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
  } finally { await tm.close(); }
});

test('manual area assignments normalize serials and let B6 visibility change independently', async () => {
  const { tm } = await openControls();
  try {
    assert.equal(await tm.page.textContent(`${group('unassigned')} .eve-stat-testing b`), '2');
    assert.equal(await tm.page.textContent(`${group('unassigned')} .eve-stat-passed b`), '1', 'old PASS is excluded by the history window');
    await tm.page.uncheck(show('b6'));
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active'], 'unassigned rows are not guessed into an area');
    await assign(tm, '2699yw1001', 'b6');
    assert.deepEqual(await visible(tm), ['recent-pass', 'old-active']);
    assert.equal(await tm.eval('__eve.state().settings.lionAreas["2699YW1001"]'), 'b6');
    assert.equal(await tm.page.textContent(`${group('b6')} .eve-stat-testing b`), '1');
    assert.equal(await tm.page.textContent(`${group('unassigned')} .eve-stat-testing b`), '1', 'area counts move with the manual assignment');
    await tm.page.check(show('b6'));
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
    await assign(tm, '2699YW1001', 'unassigned');
    await tm.page.uncheck(show('b6'));
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active']);
  } finally { await tm.close(); }
});

test('disabling B6 keeps its audit event while enabled unassigned completions still notify', async () => {
  const { tm } = await openControls();
  try {
    await assign(tm, '2699YW1001', 'b6');
    await tm.page.uncheck(show('b6'));
    await complete(tm);
    assert.equal((await log(tm))[0].area, 'b6');
    assert.equal(await cardCount(tm), 0);
    assert.deepEqual(await notifications(tm), []);
    await tm.page.evaluate(() => {
      const cell = document.querySelector('[data-controls-fixture="old-active"]').cells[4];
      cell.setAttribute('bgcolor', 'red');
      cell.firstChild.nodeValue = 'CHECK_GPU : 40:01';
    });
    await tm.eval('__eve.scanLionKing()');
    await tm.waitFor(async () => (await log(tm)).length === 2, { message: 'independent unassigned completion audit' });
    await tm.waitFor(async () => (await notifications(tm)).length === 1, { message: 'unassigned completion notification' });
    assert.equal((await log(tm))[1].area, 'unassigned');
    assert.equal(await checked(tm, show('unassigned')), true);
  } finally { await tm.close(); }
});

test('one known head assigns the pair, while conflicting tail and head assignments remain Unassigned', async () => {
  const { tm } = await openControls();
  try {
    await assign(tm, '2699YW2001', 'lionking2');
    await tm.page.uncheck(show('lionking2'));
    assert.deepEqual(await visible(tm), ['recent-pass', 'old-active'], 'a known head is sufficient to assign the pair');
    await assign(tm, '2699YW1001', 'b6');
    await tm.page.uncheck(show('b6'));
    assert.deepEqual(await visible(tm), ['active', 'recent-pass', 'old-active'], 'conflicting assignments cannot hide the unassigned pair');
    await complete(tm);
    assert.equal((await log(tm))[0].area, 'unassigned');
    await tm.waitFor(async () => (await notifications(tm)).length === 1, { message: 'conflicting pair uses unassigned notification preference' });
  } finally { await tm.close(); }
});

test('legacy settings migrate every Lion row to off without suppressing audit events', async () => {
  const { tm } = await openControls({ enabled: false, localStorage: { lionKingTrackerSettings: { lionNotifications: false } } });
  try {
    for (const key of GROUPS) {
      assert.equal(await checked(tm, show(key)), false);
    }
    await complete(tm);
    assert.equal(await cardCount(tm), 0);
    assert.deepEqual(await notifications(tm), []);
    assert.equal((await log(tm)).length, 1);
  } finally { await tm.close(); }
});

test('Developer test pass and fail create synthetic cards and toasts without audit entries, lookups or run navigation', async () => {
  const { tm, server } = await openControls();
  try {
    assert.equal(await tm.page.locator('#lion-debug-pass').isVisible(), false);
    await tm.page.check('#eve-developer-mode');
    await tm.page.click('#eve-page-navigation button[data-page="1"]');
    assert.equal(await tm.page.locator('#lion-debug-pass').isVisible(), true);
    assert.equal(await tm.page.locator('#lion-debug-fail').isVisible(), true);
    await tm.page.click('#lion-debug-pass');
    await tm.page.click('#lion-debug-fail');
    await tm.waitFor(async () => (await notifications(tm)).length === 2, { message: 'two synthetic Lion test toasts' });
    assert.equal(await cardCount(tm), 2);
    assert.deepEqual((await notifications(tm)).map(n => n.title), ['DEBUG LION KING PASS', 'DEBUG LION KING FAIL']);
    assert.equal((await log(tm)).length, 0, 'synthetic results are absent from the real audit log');
    await tm.page.locator('.eve-alert .eve-alert-loc').first().click();
    await tm.page.locator('.eve-alert .eve-alert-status').last().click();
    const gm = await tm.gm();
    assert.deepEqual(gm.windowOpens, []);
    assert.deepEqual(gm.openedTabs, []);
    assert.deepEqual(gm.xhr, []);
    assert.equal(server.requests.filter(r => /eveserverdetail|\/api\/|jira|testview/.test(r)).length, 0);
    const persisted = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('lionKingTrackerAlertLog') || '[]'));
    assert.deepEqual(persisted, []);
  } finally { await tm.close(); }
});
