// Unit tests of the script's pure logic, run inside the real userscript world
// (functions reached through the test hook - see harness/userscript.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, openWithScript } from './harness/userscript.mjs';
import { FixtureServer, RACK_URL, detailPage } from './harness/server.mjs';

let browser, tm;
before(async () => {
  browser = await launchBrowser();
  tm = await openWithScript(browser, RACK_URL, new FixtureServer());
  await tm.waitFor(() => tm.eval('!!globalThis.__eve'), { message: 'test hook' });
});
after(async () => { await browser?.close(); });

const call = (fn, ...args) => tm.eval(`__eve.${fn}(...${JSON.stringify(args)})`);

test('getTransitionType: only real result transitions alert', async () => {
  const cases = [
    ['lightgreen', 'red', 'TEST_FAILURE'],
    ['darkgreen', 'red', 'TEST_FAILURE'],
    ['lightblue', 'red', 'PRETEST_FAILURE'],
    ['lightgreen', 'darkgreen', 'TEST_SUCCESS'],
    ['red', 'lightgreen', null],       // retest start
    ['lightblue', 'lightgreen', null], // pre-test -> test
    ['red', 'red', null],
    ['', 'red', null],                 // empty slot filled red
    ['darkgreen', 'lightgreen', null],
    ['lightblue', 'darkgreen', null]   // skipped state: not trusted
  ];
  for (const [from, to, want] of cases) {
    assert.equal(await call('getTransitionType', from, to), want, `${from} -> ${to}`);
  }
});

test('canonicalColor: aliases, case, whitespace, unknown passthrough', async () => {
  assert.equal(await call('canonicalColor', ' RGB(255, 0, 0) '), 'red');
  assert.equal(await call('canonicalColor', '#90EE90'), 'lightgreen');
  assert.equal(await call('canonicalColor', 'green'), 'darkgreen');
  assert.equal(await call('canonicalColor', 'rgb(0, 128, 0)'), 'darkgreen');
  assert.equal(await call('canonicalColor', ''), '');
  assert.equal(await call('canonicalColor', null), '');
  assert.equal(await call('canonicalColor', 'purple'), 'purple');
});

test('resolveTransitionFromDetail: detail page is authoritative, but a colour FAIL is never downgraded to PASS', async () => {
  const r = (t, parsed) => call('resolveTransitionFromDetail', t, parsed);
  assert.equal(await r('TEST_FAILURE', { phase: 'PRETEST', status: 'FAIL' }), 'PRETEST_FAILURE');
  assert.equal(await r('TEST_FAILURE', { phase: 'PRETEST', status: 'PASS' }), 'PRETEST_FAILURE');
  assert.equal(await r('TEST_SUCCESS', { phase: 'PRETEST', status: 'PASS' }), 'PRETEST_SUCCESS');
  assert.equal(await r('TEST_SUCCESS', { phase: 'TEST', status: 'FAIL' }), 'TEST_FAILURE');
  assert.equal(await r('TEST_FAILURE', { phase: 'DEKIT', status: 'PASS' }), 'DEKIT_SUCCESS');
  assert.equal(await r('TEST_FAILURE', { phase: 'DEKIT', status: '' }), 'DEKIT_FAILURE');
  assert.equal(await r('TEST_SUCCESS', { phase: 'TEST', status: '' }), 'TEST_SUCCESS');
  assert.equal(await r('TEST_FAILURE', null), 'TEST_FAILURE');
  assert.equal(await r('TEST_FAILURE', { phase: '' }), 'TEST_FAILURE');
});

test('phase / status / pass-flag word normalisation', async () => {
  for (const [w, want] of [['Pre-Test', 'PRETEST'], ['PRE_TEST', 'PRETEST'], ['pt', 'PRETEST'],
    ['SLT', 'TEST'], ['burn-in', 'TEST'], ['SYS_DEKIT', 'DEKIT'], ['', ''], ['whatever', 'TEST']]) {
    assert.equal(await call('normalizePhaseWord', w), want, `phase ${w}`);
  }
  for (const [w, want] of [['FAILED', 'FAIL'], ['error', 'FAIL'], ['Aborted', 'FAIL'],
    ['PASSED', 'PASS'], ['complete', 'PASS'], ['RUNNING', ''], ['', '']]) {
    assert.equal(await call('normalizeStatusWord', w), want, `status ${w}`);
  }
  for (const [w, want] of [['1', 1], ['true', 1], ['0', 0], ['N', 0], ['', null], ['maybe', null]]) {
    assert.equal(await call('normalizePassFlag', w), want, `pass ${w}`);
  }
});

const parse = (serial, html) => tm.eval(
  `__eve.parseDetailDocument(new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html'), ${JSON.stringify(serial)})`
);

test('parseDetailDocument: SLT failure', async () => {
  const p = await parse('2699YW0001', detailPage('2699YW0001', { operation: 'SLT', status: 'FAIL', pass: '0' }));
  assert.equal(p.confirmed, true);
  assert.equal(p.phase, 'TEST');
  assert.equal(p.status, 'FAIL');
  assert.equal(p.serialMatches, true);
  assert.equal(p.running, false);
});

test('parseDetailDocument: pre-test pass', async () => {
  const p = await parse('2699YW0001', detailPage('2699YW0001', { operation: 'PRETEST', status: 'PASS', pass: '1' }));
  assert.equal(p.phase, 'PRETEST');
  assert.equal(p.status, 'PASS');
});

test('parseDetailDocument: still running -> no result', async () => {
  const p = await parse('2699YW0001', detailPage('2699YW0001', { status: 'RUNNING', pass: '', finished: '' }));
  assert.equal(p.running, true);
  assert.equal(p.status, '');
  assert.equal(p.resultConfirmed, false);
});

test('parseDetailDocument: picks the newest started row for the serial', async () => {
  const p = await parse('2699YW0001', detailPage('2699YW0001', { rows: [
    { operation: 'PRETEST', status: 'PASS', pass: '1', started: '2026-01-01 01:00:00' },
    { operation: 'SLT', status: 'FAIL', pass: '0', started: '2026-01-02 01:00:00' },
    { operation: 'PRETEST', status: 'PASS', pass: '1', started: '2026-01-01 05:00:00' }
  ] }));
  assert.equal(p.phase, 'TEST');
  assert.equal(p.status, 'FAIL');
  assert.equal(p.started, '2026-01-02 01:00:00');
});

test('parseDetailDocument: Pass flag vs taskset_status disagreement uses taskset_status', async () => {
  const p = await parse('2699YW0001', detailPage('2699YW0001', { status: 'FAIL', pass: '1' }));
  assert.equal(p.status, 'FAIL');
});

test('parseDetailDocument: serial on page differs', async () => {
  const p = await parse('2699YW9999', detailPage('2699YW0001', {}));
  assert.equal(p.serialMatches, false);
});

test('parseDetailDocument: empty / login / unrelated pages are not confirmed', async () => {
  for (const html of ['', '<html><body><form>Login</form></body></html>',
    '<table><tr><th>Foo</th></tr><tr><td>1</td></tr></table>']) {
    const p = await parse('2699YW0001', html);
    assert.equal(p.confirmed, false, html);
    assert.ok(p.reason, 'has a reason');
  }
});

test('parseJiraResponse: found / none / auth / error / login page', async () => {
  const issue = { key: 'MFGS-123', fields: { summary: 's', created: '2026-01-01', status: { name: 'Open', statusCategory: { key: 'new' } } } };
  const r = resp => call('parseJiraResponse', resp);
  const found = await r({ status: 200, responseText: JSON.stringify({ total: 3, issues: [issue] }) });
  assert.equal(found.state, 'found');
  assert.equal(found.key, 'MFGS-123');
  assert.equal(found.count, 3);
  assert.equal((await r({ status: 200, responseText: '{"total":0,"issues":[]}' })).state, 'none');
  assert.equal((await r({ status: 401, responseText: '' })).state, 'auth');
  assert.equal((await r({ status: 403, responseText: '' })).state, 'auth');
  assert.equal((await r({ status: 500, responseText: '' })).state, 'error');
  assert.equal((await r({ status: 200, responseText: '<html>SSO login</html>' })).state, 'auth');
  // keys that are not Jira-shaped are ignored (defence against odd payloads)
  assert.equal((await r({ status: 200, responseText: JSON.stringify({ issues: [{ key: '<img>' }] }) })).state, 'none');
});

test('csvEscape: formula injection neutralised, quoting correct', async () => {
  assert.equal(await call('csvEscape', '=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(await call('csvEscape', '+1'), "'+1");
  assert.equal(await call('csvEscape', '-2'), "'-2");
  assert.equal(await call('csvEscape', '@a'), "'@a");
  assert.equal(await call('csvEscape', 'a,b'), '"a,b"');
  assert.equal(await call('csvEscape', 'line\nbreak'), '"line\nbreak"');
  assert.equal(await call('csvEscape', null), '');
  assert.equal(await call('csvEscape', 'plain'), 'plain');
});

test('escapeHtml and safeUrl block markup and script URLs', async () => {
  assert.equal(await call('escapeHtml', '<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  assert.equal(await call('safeUrl', 'javascript:alert(1)'), '');
  assert.equal(await call('safeUrl', 'data:text/html,x'), '');
  assert.match(await call('safeUrl', '/out/out.eveserverdetail.php?in=1'), /^https:\/\/rack\.test\//);
});

test('shiftWindowAt: graveyard crosses midnight; windows include early/late margins', async () => {
  const w = await tm.eval(`(() => { const w = __eve.shiftWindowAt(new Date(2026, 0, 2, 1, 0).getTime(), 'graveyard');
    return { key: w.key, starts: w.starts.getHours() + ':' + w.starts.getDate(), ends: w.ends.getHours() + ':' + w.ends.getMinutes() + ':' + w.ends.getDate(),
             opens: w.opens.getHours() }; })()`);
  assert.equal(w.key, 'graveyard@2026-01-01');
  assert.equal(w.starts, '22:1');
  assert.equal(w.ends, '6:30:2');
  assert.equal(w.opens, 21);
  const day = await tm.eval(`__eve.shiftWindowAt(new Date(2026, 0, 2, 5, 30).getTime(), 'day').key`);
  assert.equal(day, 'day@2026-01-02', 'early margin: 05:30 already belongs to the 06:00 day shift');
  assert.equal(await tm.eval(`__eve.guessShift(new Date(2026, 0, 2, 12, 0))`), 'day');
  assert.equal(await tm.eval(`__eve.guessShift(new Date(2026, 0, 2, 18, 0))`), 'swing');
  assert.equal(await tm.eval(`__eve.guessShift(new Date(2026, 0, 2, 3, 0))`), 'graveyard');
});

test('isDuplicateAlert: same slot+serial+transition within cooldown is suppressed', async () => {
  assert.equal(await call('isDuplicateAlert', 'A7|EVE01|U9', '2699YW7777', 'TEST_FAILURE'), false);
  assert.equal(await call('isDuplicateAlert', 'A7|EVE01|U9', '2699YW7777', 'TEST_FAILURE'), true);
  assert.equal(await call('isDuplicateAlert', 'A7|EVE01|U9', '2699YW7777', 'TEST_SUCCESS'), false, 'different transition');
  assert.equal(await call('isDuplicateAlert', 'A7|EVE01|U9', '2699YW8888', 'TEST_FAILURE'), false, 'different serial');
});

test('buildTestViewUrl encodes the serial; isTestViewOrigin false off TestView', async () => {
  assert.equal(await call('buildTestViewUrl', '26 39/YW'),
    'https://testview-eve-fmt.hyvesolutions.org/slt/list#eveSn=26%2039%2FYW');
  assert.equal(await call('isTestViewOrigin'), false);
});
