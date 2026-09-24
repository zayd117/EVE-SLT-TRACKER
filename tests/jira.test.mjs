// Jira integration on alert cards: ticket found / pending / login needed.
// Jira is reached through GM_xmlhttpRequest (stubbed -> fixture Jira).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openRack, setSlot } from './harness/rack.mjs';
import { FixtureServer } from './harness/server.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

const issue = (key, serial) => ({ key, fields: { summary: `EVE: ${serial}: failure`,
  created: new Date().toISOString(), status: { name: 'Open', statusCategory: { key: 'new' } } } });

// Fail a slot, then wait until the card's Jira button reaches `wantClass`.
async function failAndWaitForButton(server, wantClass) {
  const { tm } = await openRack(browser, { server });
  await setSlot(tm, 'EVE01', 'U2', { color: 'red' });
  const button = await tm.waitFor(() => tm.page.$eval('.eve-alert .eve-alert-jira', el => ({
    cls: el.className, label: el.querySelector('.eve-jira-label').textContent.trim(), title: el.title
  })).then(b => b.cls.includes(wantClass) && b).catch(() => null), { timeout: 20000, message: wantClass });
  return { tm, button };
}

test('failure with a ticket: button shows the key; lookup queried Jira for the serial', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U2').serial;
  server.jira.set(serial, [issue('MFGS-1001', serial)]);
  const { tm, button } = await failAndWaitForButton(server, 'eve-jira-found');
  try {
    assert.equal(button.label, 'MFGS-1001');
    assert.match(button.title, /Raised for this failure/);
    const gm = await tm.gm();
    assert.ok(gm.xhr.some(u => u.startsWith('https://jira.synnex.com/rest/api/2/search') && decodeURIComponent(u).includes(serial)));
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('failure without a ticket yet: button says "Ticket pending"', async () => {
  const { tm, button } = await failAndWaitForButton(new FixtureServer(), 'eve-jira-waiting');
  try {
    assert.equal(button.label, 'Ticket pending');
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('Jira login needed (401): button asks to log in, card stays, no crash', async () => {
  const server = new FixtureServer();
  server.jiraStatus = 401;
  const { tm, button } = await failAndWaitForButton(server, 'eve-jira-auth');
  try {
    assert.match(button.title, /Log in to Jira/);
    assert.equal((await tm.page.$$('.eve-alert')).length, 1);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

// ---- PASSED servers never get a Jira ticket (0.9.11) ----

async function passCard(server, eve = 'EVE01', unit = 'U2') {
  const { tm } = await openRack(browser, { server });
  await setSlot(tm, eve, unit, { color: 'darkgreen' });
  const button = await tm.waitFor(() => tm.page.$eval('.eve-alert .eve-alert-jira', el => ({
    cls: el.className, label: el.querySelector('.eve-jira-label').textContent.trim(),
    href: el.getAttribute('href'), title: el.title
  })).then(b => b.cls.includes('eve-jira-passed') && b).catch(() => null), { message: 'passed label' });
  return { tm, button };
}
const jiraCalls = gm => gm.xhr.filter(u => u.includes('jira.synnex.com'));

test('PASS card: "PASSED (no ticket)", no link, no Jira lookup, clicking it does nothing', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE01', 'U2').serial, { operation: 'SLT', status: 'PASS', pass: '1' });
  const { tm, button } = await passCard(server);
  try {
    assert.equal(button.label, 'PASSED (no ticket)');
    assert.equal(button.href, null);
    assert.match(button.title, /passes do not get a Jira ticket/);
    assert.match((await tm.page.$eval('.eve-alert .eve-alert-header span', el => el.textContent)), /^TEST PASS/);
    await tm.page.click('.eve-alert .eve-alert-jira');
    await tm.page.waitForTimeout(1500);
    const gm = await tm.gm();
    assert.deepEqual(jiraCalls(gm), [], 'no Jira API call for a pass');
    assert.deepEqual(gm.windowOpens, [], 'clicking the label opened nothing');
    assert.deepEqual(gm.openedTabs, []);
    assert.deepEqual(tm.errors, []);
  } finally { await tm.close(); }
});

test('pre-test PASS also shows "PASSED (no ticket)"', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE02', 'U1').serial, { operation: 'PRETEST', status: 'PASS', pass: '1' });
  const { tm, button } = await passCard(server, 'EVE02', 'U1');
  try {
    await tm.waitFor(async () => /^PRE-TEST PASS/.test(await tm.page.$eval('.eve-alert .eve-alert-header span', el => el.textContent)),
      { message: 'PRE-TEST PASS title' });
    assert.equal(button.label, 'PASSED (no ticket)');
    assert.deepEqual(jiraCalls(await tm.gm()), []);
  } finally { await tm.close(); }
});

test('PASS toast click (default target Jira) opens TestView, not Jira', async () => {
  const server = new FixtureServer();
  const serial = server.rack.slot('EVE01', 'U3').serial;
  server.details.set(serial, { operation: 'SLT', status: 'PASS', pass: '1' });
  const { tm } = await openRack(browser, { server });
  try {
    await setSlot(tm, 'EVE01', 'U3', { color: 'darkgreen' });
    await tm.waitFor(async () => (await tm.gm()).notifications.length, { message: 'toast' });
    await tm.eval('__gm.lastNotification.onclick()');
    const gm = await tm.waitFor(async () => { const g = await tm.gm(); return g.openedTabs.length && g; }, { message: 'tab' });
    assert.deepEqual(gm.openedTabs, [`https://testview-eve-fmt.hyvesolutions.org/slt/list#eveSn=${serial}`]);
    assert.deepEqual(jiraCalls(gm), []);
  } finally { await tm.close(); }
});

test('a PASS relabelled FAIL by the detail page switches to the live Jira button', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE01', 'U2').serial, { operation: 'SLT', status: 'FAIL', pass: '0' });
  const { tm } = await openRack(browser, { server });
  try {
    await setSlot(tm, 'EVE01', 'U2', { color: 'darkgreen' });
    const b = await tm.waitFor(() => tm.page.$eval('.eve-alert .eve-alert-jira', el => ({
      cls: el.className, label: el.querySelector('.eve-jira-label').textContent.trim(), href: el.getAttribute('href')
    })).then(x => x.cls.includes('eve-jira-waiting') && x).catch(() => null), { timeout: 20000, message: 'live Jira state' });
    assert.equal(b.label, 'Ticket pending');
    assert.match(b.href, /^https:\/\/jira\.synnex\.com\//);
    assert.match((await tm.page.$eval('.eve-alert .eve-alert-header span', el => el.textContent)), /^TEST FAIL/);
  } finally { await tm.close(); }
});

test('pre-test FAIL keeps the Jira behaviour ("No ticket yet" while waiting)', async () => {
  const server = new FixtureServer();
  server.details.set(server.rack.slot('EVE01', 'U2').serial, { operation: 'PRETEST', status: 'FAIL', pass: '0' });
  const { tm, button } = await failAndWaitForButton(server, 'eve-jira-waiting');
  try {
    await tm.waitFor(async () => (await tm.page.$eval('.eve-alert .eve-jira-label', el => el.textContent.trim())) === 'No ticket yet',
      { message: 'pre-test waiting label' });
    assert.ok(button.cls.includes('eve-jira-waiting'));
    assert.ok(jiraCalls(await tm.gm()).length >= 1, 'a failure is looked up in Jira');
  } finally { await tm.close(); }
});
