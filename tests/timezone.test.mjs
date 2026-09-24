// Log exports show Fremont, CA time (America/Los_Angeles: PDT in summer, PST
// in winter) whatever timezone the PC is set to. Entries are stored as UTC ISO
// strings. 0.9.11 field report: a 10 PM - 6:30 AM shift exported as 05:18 -
// 09:55 the next day (raw UTC). The container runs in UTC, so these tests pin
// the browser's timezone explicitly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript } from './harness/userscript.mjs';
import { FixtureServer, RACK_URL } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

async function open(timezoneId) {
  const tm = await openWithScript(browser, RACK_URL, new FixtureServer(), { timezoneId });
  await tm.waitFor(() => tm.eval('!!globalThis.__eve'), { message: 'hook' });
  return tm;
}

// What a Fremont wall clock showed at `iso`, computed independently in Node.
function pacific(iso) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

for (const pcZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  test(`regression: export date/time are Pacific (PDT/PST) on a PC set to ${pcZone}`, async () => {
    const tm = await open(pcZone);
    try {
      const parts = iso => tm.eval(`__eve.isoDateParts(${JSON.stringify(iso)})`);
      // Summer, PDT (UTC-7): the field report's first and last entries.
      assert.deepEqual(await parts('2026-09-24T05:18:41.000Z'), { date: '2026-09-23', time: '22:18:41' });
      assert.deepEqual(await parts('2026-09-24T09:55:21.000Z'), { date: '2026-09-24', time: '02:55:21' });
      // Winter, PST (UTC-8).
      assert.deepEqual(await parts('2026-12-15T06:30:00.000Z'), { date: '2026-12-14', time: '22:30:00' });
      // Across the November 1 2026 change: 08:30Z is 01:30 PDT, 09:30Z is 01:30 PST.
      assert.deepEqual(await parts('2026-11-01T08:30:00.000Z'), { date: '2026-11-01', time: '01:30:00' });
      assert.deepEqual(await parts('2026-11-01T09:30:00.000Z'), { date: '2026-11-01', time: '01:30:00' });
      assert.deepEqual(await parts(''), { date: '', time: '' });
      assert.deepEqual(await parts('not a date'), { date: '', time: '' });
    } finally { await tm.close(); }
  });
}

test('a real detected failure exports with Fremont wall-clock time (TXT and CSV, PC in UTC)', async () => {
  const tm = await open('UTC');
  try {
    await tm.page.evaluate(() => document.querySelectorAll('td[bgcolor]')[0].setAttribute('bgcolor', 'red'));
    await tm.waitFor(async () => (await tm.eval('__eve.getAlertLog()')).length === 1, { message: 'log entry' });
    const out = await tm.eval(`({ iso: __eve.getAlertLog()[0].iso, txt: __eve.buildAlertLogText(), csv: __eve.buildAlertLogCsv() })`);
    const want = pacific(out.iso);
    const utcTime = out.iso.slice(11, 19);
    assert.notEqual(want.time, utcTime, 'Pacific differs from UTC');
    const tableRow = out.txt.split('\n').find(l => l.includes(want.time));
    assert.ok(tableRow && tableRow.includes(want.date), `TXT row shows ${want.date} ${want.time}`);
    // Only the explicitly labelled raw "ISO:" line may carry UTC.
    const utcLines = out.txt.split('\n').filter(l => l.includes(utcTime));
    assert.ok(utcLines.every(l => /ISO:\s+\d{4}-\d{2}-\d{2}T.*Z/.test(l)), utcLines.join('\n'));
    assert.match(out.txt, /Exported:\s+.*\b(PDT|PST)\b/, 'report header names the Pacific zone');
    assert.ok(out.csv.includes(`${want.date},${want.time},${out.iso}`), 'CSV date/time columns are Pacific, raw ISO kept');
  } finally { await tm.close(); }
});

// Field request (0.9.11 review): log the time the result actually HAPPENED -
// the detail page's Finished column (Fremont wall clock) - not the time the
// tracker noticed it. Detection time stays as the fallback and on the record.
const pacificText = ms => { const p = pacific(new Date(ms).toISOString()); return `${p.date} ${p.time}`; };

test('siteTimeToMs: detail-page wall clock read as Fremont time (PDT/PST by date)', async () => {
  const tm = await open('Asia/Tokyo');
  try {
    const ms = t => tm.eval(`(v => Number.isNaN(v) ? 'NaN' : new Date(v).toISOString())(__eve.siteTimeToMs(${JSON.stringify(t)}))`);
    assert.equal(await ms('2026-09-23 22:18:41'), '2026-09-24T05:18:41.000Z');
    assert.equal(await ms('2026-09-23 09:39:49'), '2026-09-23T16:39:49.000Z');
    assert.equal(await ms('2026-12-14 22:30:00'), '2026-12-15T06:30:00.000Z');
    assert.equal(await ms('2026-11-01 03:00:00'), '2026-11-01T11:00:00.000Z');
    assert.equal(await ms(''), 'NaN');
    assert.equal(await ms('n/a'), 'NaN');
    const ev = (f, d) => tm.eval(`__eve.eventTimeFromDetail(${JSON.stringify(f)}, ${JSON.stringify(d)})`);
    assert.equal(await ev('2026-09-23 22:10:00', '2026-09-24T05:18:41.000Z'), '2026-09-24T05:10:00.000Z');
    assert.equal(await ev('2026-01-01 02:00:00', '2026-09-24T05:18:41.000Z'), '', 'older than a day: ignored');
    assert.equal(await ev('2026-09-24 05:10:00', '2026-09-24T05:18:41.000Z'), '', 'hours after detection: ignored');
    assert.equal(await ev('', '2026-09-24T05:18:41.000Z'), '');
  } finally { await tm.close(); }
});

async function detectFail(finished) {
  const server = new FixtureServer();
  const tm = await openWithScript(browser, RACK_URL, server, { timezoneId: 'UTC' });
  await tm.waitFor(() => tm.eval('!!globalThis.__eve'), { message: 'hook' });
  const serial = await tm.page.evaluate(() => document.querySelectorAll('td[bgcolor] a')[0].textContent.trim().split(/\s+/)[0]);
  server.details.set(serial, { operation: 'SLT', status: 'FAIL', pass: '0', finished: finished(Date.now()) });
  await tm.page.evaluate(() => document.querySelectorAll('td[bgcolor]')[0].setAttribute('bgcolor', 'red'));
  await tm.waitFor(async () => (await tm.eval('__eve.getAlertLog()'))[0]?.phaseSource === 'confirmed', { message: 'confirmed' });
  const out = await tm.eval(`({ e: __eve.getAlertLog()[0], txt: __eve.buildAlertLogText(), csv: __eve.buildAlertLogCsv() })`);
  await tm.close();
  return out;
}

test('a failure is logged at the detail page Finished time, detection time kept', async () => {
  let finishedMs;
  const out = await detectFail(now => { finishedMs = Math.floor((now - 7 * 60000) / 1000) * 1000; return pacificText(finishedMs); });
  assert.equal(out.e.eventIso, new Date(finishedMs).toISOString());
  const happened = pacific(out.e.eventIso);
  const seen = pacific(out.e.iso);
  assert.match(out.txt, new RegExp(`\\[1\\] ${happened.date} ${happened.time} `), 'chronological line: happened time');
  assert.ok(out.txt.split('\n').some(l => /^\s+1\s/.test(l) && l.includes(happened.time)), 'table row: happened time');
  assert.match(out.txt, new RegExp(`Detected: ${seen.date} ${seen.time}`));
  const row = out.csv.split('\r\n')[1];
  assert.ok(row.startsWith(`${happened.date},${happened.time},${out.e.iso},`), row);
  assert.ok(row.endsWith(`,detail page Finished,${seen.date} ${seen.time}`), row);
});

for (const [name, finished] of [
  ['blank', () => ''],
  ['in the future (site clock not Fremont time)', now => pacificText(now + 7 * 3600000)],
  ['more than a day old (an older row)', now => pacificText(now - 30 * 3600000)]
]) {
  test(`Finished ${name}: falls back to the detection time`, async () => {
    const out = await detectFail(finished);
    assert.equal(out.e.eventIso, undefined);
    const seen = pacific(out.e.iso);
    assert.match(out.txt, new RegExp(`\\[1\\] ${seen.date} ${seen.time} `));
    assert.doesNotMatch(out.txt, /Detected:/);
    assert.ok(out.csv.split('\r\n')[1].endsWith(`,detected,${seen.date} ${seen.time}`));
  });
}
