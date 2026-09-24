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
