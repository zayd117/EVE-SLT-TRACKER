// Log shift: Auto by default (follows the shift the session is in), a manual
// pick lasts until the next shift change, and retention never clears a shift
// that any shift's latest window still covers. Field review (0.9.11): the
// +/-60 min margins overlap the neighbouring shifts, and users had to pick the
// shift by hand. Times are simulated (2030, America/Los_Angeles) through the
// functions' `now` parameter, so the real clock never interferes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript } from './harness/userscript.mjs';
import { FixtureServer, RACK_URL } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

// Fremont wall clock -> epoch ms. All simulated times are in January (PST).
const ms = text => Date.parse(`${text}:00-08:00`);

async function openWithLog(times = [], extra = {}) {
  const entries = times.map((t, i) => ({ eventId: `evt-${i}`, iso: new Date(ms(t)).toISOString(), serial: `SIM${i}`,
    transition: 'TEST_FAILURE', result: 'TEST FAIL', section: 'A7', eve: 'EVE01', unit: 'U1' }));
  const tm = await openWithScript(browser, RACK_URL, new FixtureServer(), {
    timezoneId: 'America/Los_Angeles', localStorage: { eveRackTrackerAlertLog: entries, ...extra }
  });
  await tm.waitFor(() => tm.page.$('#eve-log-shift'), { message: 'settings' });
  return tm;
}
const roll = (tm, text) => tm.eval(`__eve.checkLogShiftRollover(${ms(text)})`);
const shiftAt = (tm, text) => tm.eval(`__eve.currentShiftId(${ms(text)})`);
const choose = (tm, choice, text) => tm.eval(`__eve.setLogShiftChoice(${JSON.stringify(choice)}, ${ms(text)})`);
const kept = tm => tm.eval(`__eve.getAlertLog().filter(e => /^SIM/.test(e.serial)).map(e => e.serial)`);
const selectValue = tm => tm.page.$eval('#eve-log-shift', el => el.value);
const newSession = tm => tm.page.evaluate(() => localStorage.removeItem('eveRackTrackerAutoShift'));

test('Auto is the default and the dropdown offers Auto plus the three shifts', async () => {
  const tm = await openWithLog();
  try {
    assert.equal(await selectValue(tm), 'auto');
    const options = await tm.page.$$eval('#eve-log-shift option', els => els.map(e => e.value));
    assert.deepEqual(options, ['auto', 'day', 'swing', 'graveyard']);
    await roll(tm, '2030-01-09T23:00');
    assert.equal(await tm.page.$eval('#eve-log-shift option[value="auto"]', el => el.textContent),
      'Auto · Graveyard now');
  } finally { await tm.close(); }
});

test('Auto, new session: picks the shift whose window opened most recently (early arrivals get the incoming shift)', async () => {
  const tm = await openWithLog();
  try {
    // v1.0.1 boundary rule: the shift whose log window opened most recently.
    for (const [t, want] of [['2030-01-10T10:00', 'day'], ['2030-01-10T16:00', 'swing'], ['2030-01-10T21:30', 'graveyard'],
      ['2030-01-10T23:00', 'graveyard'], ['2030-01-11T05:30', 'day'], ['2030-01-11T14:45', 'swing']]) {
      await newSession(tm);
      assert.equal(await shiftAt(tm, t), want, t);
    }
  } finally { await tm.close(); }
});

test('Auto, open session: stays on its shift through the overlap, then moves on when the window ends', async () => {
  const tm = await openWithLog();
  try {
    await newSession(tm);
    for (const [t, want] of [
      ['2030-01-09T22:30', 'graveyard'], ['2030-01-10T06:30', 'graveyard'], ['2030-01-10T07:29', 'graveyard'],
      ['2030-01-10T07:30', 'day'], ['2030-01-10T15:29', 'day'], ['2030-01-10T15:30', 'swing'],
      ['2030-01-10T23:00', 'swing'], ['2030-01-11T01:14', 'swing'], ['2030-01-11T01:15', 'graveyard']
    ]) {
      assert.equal(await shiftAt(tm, t), want, t);
    }
  } finally { await tm.close(); }
});

test('Auto retention: nothing cleared at 6:30 / 7:30 AM or during the day; last night cleared only once no window covers it', async () => {
  const tm = await openWithLog(['2030-01-09T22:30', '2030-01-10T06:15', '2030-01-10T07:15', '2030-01-10T08:00']);
  try {
    await newSession(tm);
    for (const t of ['2030-01-09T22:30', '2030-01-10T06:30', '2030-01-10T07:30', '2030-01-10T15:30', '2030-01-10T21:00', '2030-01-11T01:14']) {
      await roll(tm, t);
      assert.deepEqual(await kept(tm), ['SIM0', 'SIM1', 'SIM2', 'SIM3'], `all kept at ${t}`);
    }
    await roll(tm, '2030-01-11T01:15'); // the new Graveyard (opened 9 PM) takes over
    assert.deepEqual(await kept(tm), ['SIM1', 'SIM2', 'SIM3'], 'entries the Day window still covers stay');
  } finally { await tm.close(); }
});

test('manual pick lasts until the next shift change, then Auto takes over again', async () => {
  const tm = await openWithLog();
  try {
    await newSession(tm);
    await roll(tm, '2030-01-09T23:00');
    await choose(tm, 'swing', '2030-01-09T23:00');
    assert.equal(await selectValue(tm), 'swing');
    await roll(tm, '2030-01-10T06:00');
    assert.equal(await shiftAt(tm, '2030-01-10T06:00'), 'swing', 'still the pick');
    assert.equal(await selectValue(tm), 'swing');
    await roll(tm, '2030-01-10T07:30'); // Graveyard window ends: shift change
    assert.equal(await selectValue(tm), 'auto');
    assert.equal(await shiftAt(tm, '2030-01-10T07:30'), 'day');
    const saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerSettings')));
    assert.equal(saved.logShiftChoice, 'auto');
    assert.ok(tm.trackerLogs(/Swing pick ended at the shift change - back to Auto/).length);
  } finally { await tm.close(); }
});

test('regression: Day picked by hand at 4 AM never wipes the Graveyard shift still running at 5 AM', async () => {
  const tm = await openWithLog(['2030-01-09T22:30', '2030-01-10T04:30']);
  try {
    await newSession(tm);
    await roll(tm, '2030-01-10T04:00');
    await choose(tm, 'day', '2030-01-10T04:00');
    await roll(tm, '2030-01-10T05:00'); // Day window opens (6:00 AM start - 60 min)
    assert.equal(await shiftAt(tm, '2030-01-10T05:00'), 'day');
    assert.deepEqual(await kept(tm), ['SIM0', 'SIM1'], 'Graveyard window (9 PM - 7:30 AM) is still open');
  } finally { await tm.close(); }
});

test('upgrade: a shift picked by hand in an older version becomes Auto', async () => {
  const tm = await openWithLog([], { eveRackTrackerSettings: { sections: {}, logShift: 'day' } });
  try {
    assert.equal(await selectValue(tm), 'auto');
    const saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerSettings')));
    assert.equal(saved.logShiftChoice, 'auto');
    assert.equal('logShift' in saved, false);
    assert.equal(tm.trackerLogs(/pick ended/).length, 0, 'an upgrade is not reported as a shift change');
  } finally { await tm.close(); }
});

test('the Log shift tooltip says Auto or Manual and exactly when the log is cleared', async () => {
  const tm = await openWithLog();
  try {
    const title = () => tm.page.getAttribute('#eve-log-shift', 'title');
    await newSession(tm);
    await roll(tm, '2030-01-09T23:00');
    assert.match(await title(), /^Auto: .*Graveyard now/);
    assert.match(await title(), /9:00 PM - 7:30 AM/);
    assert.match(await title(), /kept until 9:00 PM/);
    await choose(tm, 'day', '2030-01-09T23:00');
    assert.match(await title(), /^Manual: Day until the next shift change/);
    assert.match(await title(), /5:00 AM - 3:30 PM/);
    assert.match(await title(), /kept until 5:00 AM/);
  } finally { await tm.close(); }
});

test('choosing in the dropdown sets a manual pick; choosing Auto clears it', async () => {
  const tm = await openWithLog();
  try {
    await tm.page.selectOption('#eve-log-shift', 'swing');
    let saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerSettings')));
    assert.equal(saved.logShiftChoice, 'swing');
    assert.ok(saved.logShiftOverrideFor);
    assert.equal(await tm.eval('__eve.currentShiftId()'), 'swing');
    await tm.page.selectOption('#eve-log-shift', 'auto');
    saved = await tm.page.evaluate(() => JSON.parse(localStorage.getItem('eveRackTrackerSettings')));
    assert.equal(saved.logShiftChoice, 'auto');
    assert.equal(saved.logShiftOverrideFor, '');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});
