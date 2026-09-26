// v1.0.1 Jira chip UX: "new ticket" badge on a real no-ticket -> ticket
// change (IMAGE 1), a copy control for a real ticket only (IMAGE 2), and the
// pre-test "No ticket (create one)" label (IMAGE 5). Detection itself is
// unchanged; these tests drive it through the fixture Jira.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot } from './harness/rack.mjs';
import { FixtureServer } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const issue = (key, serial) => ({ key, fields: { summary: `EVE: ${serial}: failure`,
  created: new Date().toISOString(), status: { name: 'Open', statusCategory: { key: 'new' } } } });
const chipClass = tm => tm.page.$eval('.eve-alert .eve-alert-jira', el => el.className).catch(() => '');
const badges = tm => tm.page.$$eval('.eve-jira-new', els => els.length);
const copyShown = tm => tm.page.$eval('.eve-alert .eve-jira-copy', el => !el.hidden);
const refreshTicket = (tm, serial) => tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
  return __eve.refreshCardTicket(b.closest('.eve-alert'), b, ${JSON.stringify(serial)}, Number(b.dataset.failedAt), true); })()`);

async function failedCard(server, unit = 'U2') {
  const { tm } = await openRack(browser, { server });
  await setSlot(tm, 'EVE01', unit, { color: 'red' });
  await tm.waitFor(async () => (await chipClass(tm)).includes('eve-jira-waiting') || (await chipClass(tm)).includes('eve-jira-found'),
    { timeout: 20000, message: 'chip settled' });
  return tm;
}

test('IMAGE 1: pending -> ticket shows ONE "new" badge; rescans, refreshes and repaints never add or re-add it', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  const tm = await failedCard(server);
  try {
    assert.match(await chipClass(tm), /eve-jira-waiting/);
    assert.equal(await badges(tm), 0, 'no badge while pending');
    server.jira.set(serial, [issue('MFGS-123456', serial)]);
    await refreshTicket(tm, serial);
    await tm.waitFor(async () => (await chipClass(tm)).includes('eve-jira-found'), { message: 'ticket found' });
    assert.equal(await badges(tm), 1);
    const badge = await tm.page.$eval('.eve-jira-new', el => ({ text: el.textContent, title: el.title, inChip: !!el.closest('.eve-alert-jira') }));
    assert.deepEqual(badge, { text: '!', title: 'New: MFGS-123456 was just raised for this failure', inChip: true });
    const glowing = () => tm.page.$eval('.eve-alert .eve-alert-jira', el => el.classList.contains('eve-jira-fresh'));
    assert.equal(await glowing(), true, 'chip glows with the badge');
    // Same ticket seen again through every path that repaints the chip.
    for (let i = 0; i < 3; i += 1) {
      await tm.eval('__eve.scan()');
      await refreshTicket(tm, serial);
      await tm.eval('new Promise(r => __eve.performSoftRefresh(r))');
    }
    await tm.page.waitForTimeout(500);
    assert.equal(await badges(tm), 1, 'still exactly one');
    assert.equal(await glowing(), true, 'repaints keep the glow');
    // A repaint that rewrites the chip's classes (ticket moved to In Progress).
    await tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
      __eve.paintJiraButton(b, ${JSON.stringify(serial)}, { state: 'found', key: 'MFGS-123456', category: 'indeterminate' }); })()`);
    assert.match(await chipClass(tm), /eve-jira-cat-indeterminate/);
    assert.equal(await glowing(), true, 'status change keeps the glow');
    assert.equal(await badges(tm), 1);
    // First hover acknowledges it: it stays 10 s more, then goes. Later hovers
    // and repaints never bring it back or extend it.
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.mouse.move(5, 5);
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.waitForTimeout(1500);
    assert.equal(await badges(tm), 1, 'still showing 1.5 s after the hover started');
    assert.equal(await glowing(), true);
    await tm.page.waitForTimeout(2100);
    assert.equal(await badges(tm), 0, 'gone ~3 s after the hover started');
    assert.equal(await glowing(), false, 'glow gone with it');
    await refreshTicket(tm, serial);
    await tm.eval('__eve.scan()');
    await tm.page.waitForTimeout(500);
    assert.equal(await badges(tm), 0, 'not re-triggered by the same ticket');
    assert.equal(await glowing(), false);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('IMAGE 1: a ticket found at the first look (no pending state) gets no badge', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  server.jira.set(serial, [issue('MFGS-1001', serial)]);
  const tm = await failedCard(server);
  try {
    await tm.waitFor(async () => (await chipClass(tm)).includes('eve-jira-found'), { message: 'found' });
    await tm.page.waitForTimeout(500);
    assert.equal(await badges(tm), 0);
    assert.doesNotMatch(await chipClass(tm), /eve-jira-fresh/, 'no glow either');
  } finally { await tm.close(); }
});

test('IMAGE 1: the green "!" has no timeout, survives page reloads until hovered, then fades 3 s later for good', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  const tm = await failedCard(server);
  try {
    server.jira.set(serial, [issue('MFGS-2002', serial)]);
    await refreshTicket(tm, serial);
    await tm.waitFor(async () => (await badges(tm)) === 1, { message: 'badge' });
    for (let i = 0; i < 3; i += 1) await tm.eval('__eve.refreshRelativeTimes()'); // the old expiry tick
    assert.equal(await badges(tm), 1, 'no timeout while not hovered');
    // A full page reload rebuilds every card: the mark comes back, once.
    await tm.page.reload();
    await tm.waitFor(async () => (await badges(tm)) === 1, { timeout: 20000, message: 'badge restored after reload' });
    assert.match(await chipClass(tm), /eve-jira-fresh/, 'glow restored too');
    assert.equal(await badges(tm), 1);
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.mouse.move(5, 5);
    await tm.page.waitForTimeout(3800);
    assert.equal(await badges(tm), 0, 'faded 3 s after the hover');
    // Acknowledged for good: another reload does not bring it back.
    await tm.page.reload();
    await tm.waitFor(async () => (await chipClass(tm)).includes('eve-jira-found'), { timeout: 20000, message: 'found after reload' });
    await tm.page.waitForTimeout(800);
    assert.equal(await badges(tm), 0, 'not re-fired after reload');
    assert.doesNotMatch(await chipClass(tm), /eve-jira-fresh/);
  } finally { await tm.close(); }
});

test('IMAGE 5: the gold pre-test outline fires once per failure - back after a reload until acknowledged, never after', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    const failedAt = Date.now() - 25 * 60 * 1000;
    const paintNoTicket = () => tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
      b.dataset.pretest = '1'; b.dataset.failedAt = '${failedAt}';
      __eve.paintJiraButton(b, b.dataset.serial, { state: 'noticket' });
      return b.classList.contains('eve-jira-attn'); })()`);
    assert.equal(await paintNoTicket(), true, 'fires');
    await tm.page.reload();
    await tm.waitFor(() => tm.page.$('.eve-alert .eve-alert-jira'), { message: 'card back' });
    assert.equal(await paintNoTicket(), true, 'still there after a reload - not acknowledged yet');
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.mouse.move(5, 5);
    await tm.page.waitForTimeout(10800);
    assert.equal(await tm.page.$eval('.eve-alert .eve-alert-jira', el => el.classList.contains('eve-jira-attn')), false, 'faded');
    for (let i = 0; i < 2; i += 1) {
      await tm.page.reload();
      await tm.waitFor(() => tm.page.$('.eve-alert .eve-alert-jira'), { message: 'card back' });
      assert.equal(await paintNoTicket(), false, `reload ${i + 1}: never comes back`);
    }
  } finally { await tm.close(); }
});

test('IMAGE 2: copy control only for a real ticket; copies the full ticket link; shows copied; opens nothing', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  const tm = await failedCard(server);
  try {
    assert.equal(await copyShown(tm), false, 'pending: no copy control');
    server.jira.set(serial, [issue('MFGS-123456', serial)]);
    await refreshTicket(tm, serial);
    await tm.waitFor(async () => (await copyShown(tm)) === true, { message: 'copy shown with the ticket' });
    assert.equal(await tm.page.$$eval('.eve-alert .eve-jira-copy', els => els.length), 1, 'one control');
    assert.equal(await tm.page.getAttribute('.eve-alert .eve-jira-copy', 'title'), 'Copy link: https://jira.synnex.com/browse/MFGS-123456');
    await tm.eval('navigator.clipboard.writeText = t => { globalThis.__copied = t; return Promise.resolve(); }');
    const urlBefore = tm.page.url();
    await tm.page.click('.eve-alert .eve-jira-copy');
    await tm.waitFor(() => tm.eval('globalThis.__copied'), { message: 'copied' });
    assert.equal(await tm.eval('globalThis.__copied'), 'https://jira.synnex.com/browse/MFGS-123456', 'the full ticket link');
    assert.match(await tm.page.textContent('.eve-alert .eve-jira-copy'), /copied/);
    await tm.page.waitForTimeout(1800);
    assert.equal((await tm.page.textContent('.eve-alert .eve-jira-copy')).trim(), '⧉', 'back to idle');
    const gm = await tm.gm();
    assert.deepEqual(gm.windowOpens, [], 'did not open Jira or TestView');
    assert.deepEqual(gm.openedTabs, []);
    assert.equal(tm.page.url(), urlBefore);
    // The chip itself still links to the ticket.
    assert.equal(await tm.page.getAttribute('.eve-alert .eve-alert-jira', 'href'), 'https://jira.synnex.com/browse/MFGS-123456');
    // Repaints never duplicate the control.
    for (let i = 0; i < 3; i += 1) await refreshTicket(tm, serial);
    assert.equal(await tm.page.$$eval('.eve-jira-copy', els => els.length), 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('IMAGE 2 + 5: no copy control for pending, no ticket, pass; pre-test "No ticket (create one)"', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    const paint = (state, pretest, ageMin = 25) => tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
      b.dataset.pretest = ${pretest ? "'1'" : "''"}; b.dataset.failedAt = String(Date.now() - ${ageMin} * 60 * 1000);
      __eve.paintJiraButton(b, b.dataset.serial, { state: ${JSON.stringify(state)} });
      return { label: b.querySelector('.eve-jira-label').textContent, title: b.title, href: b.getAttribute('href'),
        copy: !b.parentElement.querySelector('.eve-jira-copy').hidden }; })()`);
    for (const state of ['waiting', 'noticket', 'none', 'auth', 'error', 'passed']) {
      assert.equal((await paint(state, false)).copy, false, `${state}: no copy control`);
    }
    const pre = await paint('noticket', true);
    assert.equal(pre.label, 'No ticket (create one)');
    assert.match(pre.title, /^It has been more than 15 minutes and no ticket has been created - please make one in PuTTY: ticket \S+\nPre-test fails often get no ticket automatically\./);
    assert.match(pre.href, /^https:\/\/jira\.synnex\.com\//, 'click still searches Jira as before');
    const normal = await paint('noticket', false);
    assert.equal(normal.label, 'No ticket', 'test (non pre-test) label unchanged');
    assert.match(normal.title, /^It has been more than 15 minutes and no ticket has been created - please make one in PuTTY: ticket \S+\n/, 'test-fail tooltip says how to raise one');
    assert.match((await paint('waiting', false, 10)).title, /\nIf there is no ticket by .+, please open PuTTY and create one with: ticket \S+$/, 'before 15 min: says by when');
    const attn = () => tm.page.$eval('.eve-alert .eve-alert-jira', el => el.classList.contains('eve-jira-attn'));
    assert.equal(await attn(), false, 'no yellow outline for a test fail');
    await paint('noticket', true);
    assert.equal(await attn(), true, 'pre-test: yellow tracing outline');
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.waitForTimeout(8000);
    assert.equal(await attn(), true, 'stays 8 s after the first hover');
    await tm.page.waitForTimeout(2800);
    assert.equal(await attn(), false, 'gone ~10 s after the first hover');
    await paint('noticket', true);
    assert.equal(await attn(), false, 'repaint does not bring it back');
    // Pre-test: still waiting before 15 min, "create one" from 15 min.
    assert.equal((await paint('waiting', true, 14)).label, 'No ticket yet', 'pre-test at 14 min: waiting');
    assert.equal((await paint('waiting', true, 15)).label, 'No ticket (create one)', 'pre-test at 15 min: create one');
    assert.equal((await paint('waiting', false, 16)).label, 'Ticket pending', 'test fail at 16 min: still pending');
    // No ticket is ever created: every Jira call is a read.
    const jira = (await tm.gm()).xhr.filter(u => u.includes('jira.synnex.com'));
    assert.ok(jira.every(u => /\/rest\/api\/2\/search/.test(u)), jira.join('\n'));
  } finally { await tm.close(); }
});

// Old (45 min+) cards dim - except a pre-test "create one" chip whose gold
// outline has not been acknowledged: only that chip stays bright.
test('old pre-test card: the card dims, only the gold "create one" chip stays bright until acknowledged', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    // Freeze the tracing animation so screenshots compare pixel for pixel.
    await tm.page.addStyleTag({ content: '.eve-jira-attn::before { animation: none !important; } .eve-alert::after { transition: none !important; }' });
    await tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
      b.dataset.pretest = '1'; b.dataset.failedAt = String(Date.now() - 105 * 60 * 1000);
      __eve.paintJiraButton(b, b.dataset.serial, { state: 'noticket' }); })()`);
    await tm.page.mouse.move(5, 5);
    const shot = sel => tm.page.$(sel).then(el => el.screenshot());
    // Brightness of `now` relative to `ref` (sum of RGB, decoded in the page).
    const ratio = (ref, now) => tm.page.evaluate(async ([a, b]) => {
      const sum = src => new Promise(r => { const i = new Image(); i.onload = () => {
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height;
        const g = c.getContext('2d'); g.drawImage(i, 0, 0); const d = g.getImageData(0, 0, i.width, i.height).data;
        let t = 0; for (let k = 0; k < d.length; k += 4) t += d[k] + d[k + 1] + d[k + 2]; r(t); };
        i.src = 'data:image/png;base64,' + src; });
      return (await sum(b)) / (await sum(a));
    }, [ref.toString('base64'), now.toString('base64')]);
    const setAged = aged => tm.page.evaluate(a => document.querySelector('.eve-alert').classList.toggle('eve-alert-aged', a), aged);
    await setAged(false);
    const chipBright = await shot('.eve-alert .eve-jira-group');
    const serialBright = await shot('.eve-alert .eve-alert-serial');
    await setAged(true);
    const serialRatio = await ratio(serialBright, await shot('.eve-alert .eve-alert-serial'));
    const chipRatio = await ratio(chipBright, await shot('.eve-alert .eve-jira-group'));
    assert.ok(serialRatio < 0.75, `rest of the card dims (${serialRatio.toFixed(2)})`);
    assert.ok(chipRatio > 0.95, `gold chip stays bright (${chipRatio.toFixed(2)})`);
    // Acknowledged (hover + 10 s): the chip dims with the card.
    await tm.page.hover('.eve-alert .eve-alert-jira');
    await tm.page.mouse.move(5, 5);
    await tm.page.waitForTimeout(10800);
    assert.equal(await tm.page.$eval('.eve-alert .eve-alert-jira', el => el.classList.contains('eve-jira-attn')), false);
    const chipAfter = await shot('.eve-alert .eve-jira-group');
    await setAged(false);
    const afterRatio = await ratio(await shot('.eve-alert .eve-jira-group'), chipAfter);
    assert.ok(afterRatio < 0.8, `chip now dims too (${afterRatio.toFixed(2)})`);
    // Hovering an old card still shows it at full brightness.
    await setAged(true);
    await tm.page.hover('.eve-alert .eve-alert-loc');
    await tm.page.waitForTimeout(100);
    assert.equal(await tm.page.evaluate(() => getComputedStyle(document.querySelector('.eve-alert'), '::after').opacity), '0');
  } finally { await tm.close(); }
});

test('no-ticket page: plain "by <time>" PuTTY line before 15 min; gold "more than 15 minutes" box after (test and pre-test fails)', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    await tm.page.evaluate(() => { for (const id of ['t1', 't2', 't3', 't4']) { const f = document.createElement('iframe'); f.id = id; document.body.appendChild(f); } });
    const page = (id, ageMin, pretest) => tm.eval(`(() => { const w = document.getElementById('${id}').contentWindow;
      __eve.writeJiraWaitPage(w, '2639YW11H5', Date.now() - ${ageMin} * 60000, ${pretest});
      const d = w.document; const gold = d.querySelector('.eve-howto'); const plain = d.querySelector('.eve-howto-plain');
      const box = gold || plain;
      return { lines: [...d.body.children].filter(e => e.tagName === 'DIV' && !e.className).map(e => e.textContent),
        gold: !!gold, plain: !!plain, text: box ? box.textContent : null,
        command: box ? box.querySelector('.eve-howto-row').firstChild.textContent : null,
        note: box && box.querySelector('.eve-howto-note') ? box.querySelector('.eve-howto-note').textContent : null,
        options: d.querySelectorAll('.eve-opt').length }; })()`);
    for (const [id, pretest, kind] of [['t1', true, 'Pre-test fail'], ['t3', false, 'Test fail']]) {
      const late = await page(id, 16, pretest);
      assert.equal(late.lines[0], 'No ticket for 2639YW11H5');
      assert.match(late.lines[1], new RegExp(`^${kind} at `));
      assert.equal(late.lines[2], 'This tab opens the ticket by itself if one is raised.');
      assert.equal(late.gold, true, `${kind} 15 min+: gold box`);
      assert.match(late.text, /^It has been more than 15 minutes and no ticket has been created\. Please make one in PuTTY:ticket 2639YW11H5Copy/);
      assert.equal(late.command, 'ticket 2639YW11H5');
      assert.equal(late.note, null, 'no extra PuTTY text - the command is all they need');
      assert.equal(late.options, 2, 'the two Jira searches are still there');
    }
    // Copy works and resets.
    await tm.eval(`(() => { const w = document.getElementById('t1').contentWindow;
      w.navigator.clipboard.writeText = t => { globalThis.__copied = t; return Promise.resolve(); };
      w.document.querySelector('.eve-howto button').click(); })()`);
    await tm.waitFor(() => tm.eval('globalThis.__copied'), { message: 'copied' });
    assert.equal(await tm.eval('globalThis.__copied'), 'ticket 2639YW11H5');
    const copyLabel = () => tm.page.evaluate(() => document.getElementById('t1').contentDocument.querySelector('.eve-howto button').textContent);
    assert.equal(await copyLabel(), '\u2713 Copied');
    await tm.page.waitForTimeout(2300);
    assert.equal(await copyLabel(), 'Copy', 'ready to copy again');
    // Before 15 min: one plain line, no gold box, no note - the Jira bot gets its chance.
    for (const [id, pretest] of [['t2', true], ['t4', false]]) {
      const early = await page(id, 10, pretest);
      assert.equal(early.lines[0], 'No ticket yet for 2639YW11H5');
      assert.equal(early.gold, false);
      assert.equal(early.plain, true);
      assert.match(early.text, /^If there is no ticket by \d{1,2}:\d{2}\s?[AP]M, please open PuTTY and create one with: ticket 2639YW11H5Copy$/);
      assert.equal(early.note, null);
      const style = await tm.page.evaluate(i => { const b = document.getElementById(i).contentDocument.querySelector('.eve-howto-plain');
        const cs = getComputedStyle(b); return cs.backgroundColor + '|' + cs.borderTopStyle; }, id);
      assert.equal(style, 'rgba(0, 0, 0, 0)|none', 'regular text: no highlight, no border');
      const cmdBox = await tm.page.evaluate(i => { const c = document.getElementById(i).contentDocument.querySelector('.eve-howto-plain .eve-howto-cmd');
        const cs = getComputedStyle(c); return cs.borderTopStyle + '|' + cs.fontFamily; }, id);
      assert.match(cmdBox, /^solid\|.*Consolas/, 'the command itself sits in a small box');
    }
  } finally { await tm.close(); }
});

// PuTTY refuses "ticket <serial>" while a test runs, and TestView 2.0 counts
// every step (power off included) as RUNNING: never prompt for a ticket then.
test('TestView 2.0 status: RUNNING -> no "make a ticket" prompt; finished or unknown -> the gold box', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    const S = '2639YW109S';
    const status = s => server.testview.api.set(S, [
      { id: 8086318, server_sn: S, started: '2026-09-25T01:04:51.157-07:00', status: 'FAILED' },
      { id: 8086367, server_sn: S, started: '2026-09-25T05:02:20.954-07:00', status: s }
    ]);
    status('RUNNING');
    assert.equal(await tm.eval(`__eve.testViewRunning('${S}')`), true, 'newest run is RUNNING');
    const xhr = (await tm.gm()).xhr.filter(u => u.includes('/api/v1/server_level_tests/view'));
    assert.equal(xhr.length, 1);
    assert.match(decodeURIComponent(xhr[0]), /fields=status/);
    await tm.eval(`__eve.testViewRunning('${S}')`);
    assert.equal((await tm.gm()).xhr.filter(u => u.includes('server_level_tests')).length, 1, 'cached (no second request)');
    await tm.page.evaluate(() => { for (const id of ['r1', 'r2', 'r3']) { const f = document.createElement('iframe'); f.id = id; document.body.appendChild(f); } });
    const page = (id, running) => tm.eval(`(() => { const w = document.getElementById('${id}').contentWindow;
      __eve.writeJiraWaitPage(w, '${S}', Date.now() - 20 * 60000, true, ${running});
      const d = w.document; const a = d.querySelector('.eve-howto-link a'); return { gold: !!d.querySelector('.eve-howto'),
        plain: d.querySelector('.eve-howto-plain') ? d.querySelector('.eve-howto-plain').textContent : null,
        link: a ? { href: a.href, text: a.textContent } : null }; })()`);
    const running = await page('r1', true);
    assert.equal(running.gold, false, 'no "make one now" box while running');
    assert.match(running.plain, /^This server failed and is being re-tested now \(TestView 2\.0: RUNNING\), so PuTTY cannot create a ticket yet\. If it fails again, after the test finishes use: ticket 2639YW109SCopy/);
    assert.deepEqual(running.link, { href: 'https://testview-eve-fmt.hyvesolutions.org/slt/testdetail/8086367',
      text: 'Open this run in TestView 2.0' }, 'link to the running (newest) run');
    const done = await tm.eval(`(() => { const w = document.getElementById('r2').contentWindow;
      __eve.writeJiraWaitPage(w, '${S}', Date.now() - 20 * 60000, true, false);
      return w.document.querySelector('.eve-howto') ? w.document.querySelector('.eve-howto').firstChild.textContent : null; })()`);
    assert.equal(done, 'It has been more than 15 minutes, the server is not running, and no ticket has been created. Please make one in PuTTY:',
      'finished (TestView says not running) and still no ticket: gold box says so');
    const unknown = await tm.eval(`(() => { const w = document.getElementById('r3').contentWindow;
      __eve.writeJiraWaitPage(w, '${S}', Date.now() - 20 * 60000, true, null);
      return w.document.querySelector('.eve-howto') ? w.document.querySelector('.eve-howto').firstChild.textContent : null; })()`);
    assert.equal(unknown, 'It has been more than 15 minutes and no ticket has been created. Please make one in PuTTY:',
      'TestView unknown: gold box without the running claim');
  } finally { await tm.close(); }
});

test('TestView status: finished / unreachable / no status field -> not running', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    server.testview.api.set('SN1', [{ id: 1, server_sn: 'SN1', started: '2026-09-25T01:04:51.157-07:00', status: 'FAILED' }]);
    server.testview.api.set('SN2', [{ id: 2, server_sn: 'SN2', started: '2026-09-25T05:00:00Z' }]);
    assert.equal(await tm.eval(`__eve.testViewRunning('SN1')`), false);
    assert.equal(await tm.eval(`__eve.testViewRunning('SN2')`), null, 'no status field: unknown');
    assert.equal(await tm.eval(`__eve.testViewRunning('SN3')`), null, 'serial not in TestView: unknown');
    server.testview.apiStatus = 500;
    assert.equal(await tm.eval(`__eve.testViewRunning('SN4')`), null, 'TestView error: unknown');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('pre-test chip: while TestView says RUNNING it reads "No ticket (test running)" with no gold', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    const serial = await tm.page.$eval('.eve-alert .eve-alert-jira', el => el.dataset.serial);
    server.testview.api.set(serial, [{ id: 9, server_sn: serial, started: '2026-09-25T05:02:20Z', status: 'RUNNING' }]);
    const paint = () => tm.eval(`(() => { const b = document.querySelector('.eve-alert .eve-alert-jira');
      b.dataset.pretest = '1'; b.dataset.failedAt = String(Date.now() - 20 * 60000);
      __eve.paintJiraButton(b, b.dataset.serial, { state: 'noticket' }); })()`);
    await paint();
    const chip = () => tm.page.$eval('.eve-alert .eve-alert-jira', el => ({ label: el.querySelector('.eve-jira-label').textContent,
      gold: el.classList.contains('eve-jira-attn'), title: el.title }));
    await tm.waitFor(async () => (await chip()).label === 'No ticket (re-testing)', { message: 'repainted after TestView answered' });
    const c = await chip();
    assert.equal(c.gold, false);
    assert.match(c.title, /^Re-testing now \(TestView 2\.0: RUNNING\) - PuTTY cannot create a ticket until it finishes/);
  } finally { await tm.close(); }
});

// A card can outlive its server: pulled or swapped, its cell now holds
// another serial or nothing. Strike it through, do not delete it.
test('card whose server left its slot: struck through + "Removed from rack"; a retest is not; other racks untouched', async () => {
  const server = new FixtureServer();
  const tm = await failedCard(server);
  try {
    const serial = server.rack.slot('EVE01', 'U2').serial;
    const state = () => tm.page.$eval('.eve-alert', el => ({ gone: el.classList.contains('eve-alert-gone'),
      tag: el.querySelector('.eve-gone-tag') ? el.querySelector('.eve-gone-tag').title : null,
      strike: getComputedStyle(el.querySelector('.eve-alert-serial-value')).textDecorationLine }));
    assert.deepEqual(await state(), { gone: false, tag: null, strike: 'none' });
    // Retest: same serial, running again - not gone.
    await setSlot(tm, 'EVE01', 'U2', { color: 'lightblue' });
    await tm.eval('__eve.scan()');
    assert.equal((await state()).gone, false, 'retest is not removal');
    // Swapped: another serial in the cell.
    await setSlot(tm, 'EVE01', 'U2', { serial: '2639YW11ND', color: 'lightgreen' });
    await tm.eval('__eve.scan()');
    let s = await state();
    assert.equal(s.gone, true);
    assert.equal(s.strike, 'line-through');
    assert.equal(s.tag, `${serial} is no longer in A7 \u2022 EVE01 \u2022 U2 (now 2639YW11ND).`);
    const box = await tm.page.$eval('.eve-alert button.eve-alert-serial', el => ({ disabled: el.disabled,
      tagInBox: !!el.querySelector('.eve-gone-tag'), hint: getComputedStyle(el.querySelector('.eve-alert-copy-hint')).display }));
    assert.deepEqual(box, { disabled: true, tagInBox: true, hint: 'none' }, 'tag replaces "copy"; copying is off');
    await tm.eval('navigator.clipboard.writeText = t => { globalThis.__copied = t; return Promise.resolve(); }');
    await tm.page.click('.eve-alert button.eve-alert-serial', { force: true });
    await tm.page.waitForTimeout(300);
    assert.equal(await tm.eval('globalThis.__copied || null'), null, 'nothing copied');
    assert.equal(await tm.page.$$eval('.eve-alert .eve-gone-tag', els => els.length), 1, 'one tag after rescans');
    await tm.eval('__eve.scan()');
    assert.equal(await tm.page.$$eval('.eve-alert .eve-gone-tag', els => els.length), 1);
    // Empty cell.
    await tm.page.evaluate(() => { const row = [...document.querySelectorAll('tbody tr')].find(r => r.cells[0].textContent.trim() === 'U2');
      row.cells[1].innerHTML = ''; row.cells[1].removeAttribute('bgcolor'); });
    await tm.eval('__eve.scan()');
    s = await state();
    assert.equal(s.gone, true);
    assert.match(s.tag, /\(the slot is empty\)\.$/);
    // Back in its slot: unmarked.
    await tm.page.evaluate(sn => { const row = [...document.querySelectorAll('tbody tr')].find(r => r.cells[0].textContent.trim() === 'U2');
      row.cells[1].setAttribute('bgcolor', 'red'); row.cells[1].innerHTML = `<a href="/out/out.eveserverdetail.php?in=${sn}">${sn} X</a>`; }, serial);
    await tm.eval('__eve.scan()');
    assert.deepEqual(await state(), { gone: false, tag: null, strike: 'none' });
    assert.equal(await tm.page.$eval('.eve-alert button.eve-alert-serial', el => el.disabled), false, 'copy back on');
    // A card from a rack column this page does not show is left alone.
    await tm.page.evaluate(() => { document.querySelector('.eve-alert').dataset.slot = 'B9|EVE07|U1'; });
    await tm.eval('__eve.scan()');
    assert.equal((await state()).gone, false);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('clicking the copy control or the chip never triggers the card\'s TestView click', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  server.jira.set(serial, [issue('MFGS-3003', serial)]);
  const tm = await failedCard(server);
  try {
    await tm.waitFor(async () => (await copyShown(tm)) === true, { message: 'copy' });
    await tm.eval('navigator.clipboard.writeText = () => Promise.resolve()');
    await tm.page.click('.eve-alert .eve-jira-copy');
    await tm.page.waitForTimeout(400);
    assert.ok(!(await tm.gm()).windowOpens.some(u => u.includes('testview')), 'no TestView from copy');
  } finally { await tm.close(); }
});
