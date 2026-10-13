// Lion King TestView uses authenticated API lookups, never SN typing or Query.
// All serials, runs and responses here are synthetic and fixture-only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES
} from './harness/userscript.mjs';
import { FixtureServer, TESTVIEW_ORIGIN } from './harness/server.mjs';

const LIST_PATH = '/uut/gpu_jbog_test/list';
const LIST = TESTVIEW_ORIGIN + LIST_PATH;
const API_PATH = '/api/v1/uut_status/view';
const SN = '2699YW3001';
const STARTED = '2026-10-09 04:43:11';
const RUN_ID = 8200002;
const HANDOFF_KEY = 'eveLionTestViewHandoff';
const TEST_OPERATION = 'GPU_JBOG_TEST';
const PRETEST_OPERATION = 'GPU_JBOG_TEST_PRETEST';
const VALID = {
  id: RUN_ID, uut_sn: SN, fixture_sn: 'FIXTURE-SYNTHETIC-01',
  operation: TEST_OPERATION, started: STARTED, status: 'PASS'
};
const NEWER = { ...VALID, id: 8200003, started: '2026-10-09 05:43:11', status: 'RUNNING' };
const OLDER = { ...VALID, id: 8200001, started: '2026-10-09 03:43:11' };
const HOOKS = [...HOOK_NAMES, 'buildLionKingTestViewUrl', 'openLionKingTestView',
  'lookupLionKingDirect', 'lookupLionKingDetail', 'requestLionKingAPI', 'readLionKingTestViewTarget'];

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

function targetUrl(serial = SN, started = STARTED, operation = TEST_OPERATION) {
  return `${LIST}#${new URLSearchParams({ eveLionSn: serial, eveLionStarted: started,
    eveLionOperation: operation })}`;
}

// Both forms and a misleading DOM link must stay untouched by direct lookup.
const LIST_HTML = `<!doctype html><html><body>
  <form><input id="server_sn" value="KEEP-SLT"><input id="uut_sn" value="KEEP-JBOG">
    <button type="submit">Query</button></form>
  <table><tbody><tr><td>${SN}</td><td>${STARTED}</td>
    <td><a href="/uut/detail/9999999">Wrong DOM run</a></td></tr></tbody></table>
  <script>
    sessionStorage.setItem('uut-form-activity', JSON.stringify({ edits: [], queries: 0 }));
    const record = edit => {
      const activity = JSON.parse(sessionStorage.getItem('uut-form-activity'));
      if (edit) activity.edits.push(edit); else activity.queries += 1;
      sessionStorage.setItem('uut-form-activity', JSON.stringify(activity));
    };
    document.querySelectorAll('input').forEach(input => input.addEventListener('input', () => record(input.id)));
    document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); record(); });
    document.querySelector('button').addEventListener('click', () => record());
  </script></body></html>`;

class UutServer extends FixtureServer {
  constructor(options = {}) {
    super();
    this.options = options;
    this.latest = options.latest ?? [VALID];
    this.history = options.history ?? [[OLDER, VALID, NEWER]];
    this.byId = options.byId ?? new Map([VALID, OLDER, NEWER].map(row => [String(row.id), { data: row }]));
  }

  async respond(url, req) {
    if (url.origin === TESTVIEW_ORIGIN || url.origin === 'https://elsewhere.test') {
      if (url.pathname === LIST_PATH) return { status: 200, contentType: 'text/html', body: LIST_HTML };
      if (/^\/uut\/detail\/\d+$/.test(url.pathname)) {
        return { status: 200, contentType: 'text/html', body: '<h1 id="uut-detail">UUT detail</h1>' };
      }
      if (url.origin === TESTVIEW_ORIGIN && (url.pathname === API_PATH ||
          /^\/api\/v1\/uut_status\/view\/\d+\/by_id$/.test(url.pathname))) {
        const list = url.pathname === API_PATH;
        const prefix = list ? 'list' : 'detail';
        const latest = url.searchParams.get('only_latest_uut_status') === 'true';
        const page = Number(url.searchParams.get('page_num')) || 1;
        const id = url.pathname.split('/').at(-2);
        const body = list
          ? (this.options.listBody ?? { data: { items: latest ? this.latest : (this.history[page - 1] || []) } })
          : (this.options.detailBody ?? this.byId.get(id) ?? { data: [] });
        return { status: this.options[`${prefix}Status`] ?? 200,
          headers: { 'access-control-allow-origin': '*' },
          contentType: this.options[`${prefix}Type`] ?? 'application/json',
          body: typeof body === 'string' ? body : JSON.stringify(body) };
      }
    }
    return super.respond(url, req);
  }
}

const apiCalls = server => server.requests.filter(request => request.includes(API_PATH));
const listCalls = server => apiCalls(server).filter(request => !request.includes('/by_id'));
const detailCalls = server => apiCalls(server).filter(request => request.includes('/by_id'));
const detailLoads = server => server.requests.filter(request => request.includes('/uut/detail/'));
const requestUrl = request => new URL(`https://${request.split(' ')[1]}`);

async function run(server, fn, { url = LIST, ...options } = {}) {
  const tm = await openWithScript(browser, url, server,
    { ...options, source: options.source || instrument(SCRIPT_SOURCE, HOOKS) });
  try {
    await fn(tm);
    assert.deepEqual(tm.errors, [], 'no uncaught page errors');
    assert.deepEqual(server.unrouted, [], 'all requests stayed in synthetic fixtures');
    assert.deepEqual(server.requests.filter(request => request.includes('/api/v1/server_level_tests/')),
      [], 'Lion King never calls the SLT API');
    const activity = await tm.page.evaluate(() => JSON.parse(sessionStorage.getItem('uut-form-activity')));
    if (activity) assert.deepEqual(activity, { edits: [], queries: 0 }, 'never types an SN or clicks/submits Query');
  } catch (error) {
    throw new Error(`${error.message}\nFixture requests: ${JSON.stringify(server.requests)}\n` +
      `Tracker logs: ${JSON.stringify(tm.trackerLogs())}`, { cause: error });
  } finally { await tm.close(); }
}

async function lookup(tm, started = STARTED, operation = TEST_OPERATION, serial = SN) {
  return tm.eval(`__eve.lookupLionKingDirect(${JSON.stringify(serial)}, ${JSON.stringify(started)}, ` +
    `${JSON.stringify(operation)})`);
}

test('passive UUT list does not query, request APIs or inject the tracker', async () => {
  const server = new UutServer();
  await run(server, async tm => {
    await tm.page.waitForTimeout(300);
    assert.deepEqual(apiCalls(server), []);
    assert.equal(await tm.page.$('#eve-tracker-panel'), null);
  });
});

test('direct lookup validates the exact historical Started run through list and by-id APIs', async () => {
  const server = new UutServer({ latest: [NEWER] });
  await run(server, async tm => {
    assert.equal(await lookup(tm), `${TESTVIEW_ORIGIN}/uut/detail/${RUN_ID}`);
    assert.equal(listCalls(server).length, 2, 'latest miss searches exact history');
    assert.equal(requestUrl(listCalls(server)[0]).searchParams.get('only_latest_uut_status'), 'true');
    assert.equal(requestUrl(listCalls(server)[1]).searchParams.get('only_latest_uut_status'), 'false');
    assert.equal(detailCalls(server).length, 1);
    assert.equal(requestUrl(detailCalls(server)[0]).pathname, `${API_PATH}/${RUN_ID}/by_id`);
    assert.deepEqual(detailLoads(server), [], 'lookup returns a URL without navigating on its own');
    for (const request of apiCalls(server)) {
      const url = requestUrl(request);
      assert.match(request, /^GET /);
      for (const field of ['id', 'uut_sn', 'operation', 'started']) {
        assert.ok(url.searchParams.getAll('fields').includes(field), `requests ${field} for validation`);
      }
    }
    const params = requestUrl(listCalls(server)[0]).searchParams;
    assert.equal(params.get('uut_sn'), SN);
    assert.equal(params.get('operation'), TEST_OPERATION);
    assert.equal(params.get('operation_is_exact'), 'true');
  });
});

test('list retry navigates to a verified detail using only the existing browser session', async () => {
  const server = new UutServer();
  const prelude = `
    const originalLionFetch = fetch;
    globalThis.fetch = (resource, options = {}) => {
      const url = new URL(String(resource), location.href);
      if (url.pathname.startsWith('${API_PATH}')) {
        const calls = JSON.parse(sessionStorage.getItem('lion-fetch-metadata') || '[]');
        calls.push({ method: options.method || 'GET', credentials: options.credentials,
          headers: [...new Headers(options.headers || {}).keys()], bodyPresent: !!options.body });
        sessionStorage.setItem('lion-fetch-metadata', JSON.stringify(calls));
      }
      return originalLionFetch(resource, options);
    };
  `;
  await run(server, async tm => {
    await tm.page.waitForURL(`${TESTVIEW_ORIGIN}/uut/detail/${RUN_ID}`);
    assert.equal(detailLoads(server).length, 1);
    assert.equal(listCalls(server).length, 1);
    assert.equal(detailCalls(server).length, 1);
    const calls = await tm.page.evaluate(() => JSON.parse(sessionStorage.getItem('lion-fetch-metadata')));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.credentials, 'include');
      assert.equal(call.bodyPresent, false);
      assert.deepEqual(call.headers, ['accept'], 'no constructed API authorization header');
    }
  }, { url: targetUrl(), prelude });
});

test('missing Started opens the newest verified run instead of guessing from DOM rows', async () => {
  const server = new UutServer({ latest: [OLDER, NEWER, VALID] });
  await run(server, async tm => {
    assert.equal(await lookup(tm, ''), `${TESTVIEW_ORIGIN}/uut/detail/${NEWER.id}`);
    assert.equal(listCalls(server).length, 1);
    assert.equal(detailCalls(server).length, 1);
  });
});

test('PRETEST alias resolves its own operation and cannot open the full test', async () => {
  const pretest = { ...VALID, id: 8300002, operation: PRETEST_OPERATION };
  const server = new UutServer({ latest: [VALID, pretest], byId: new Map([[String(pretest.id), { data: pretest }]]) });
  await run(server, async tm => {
    assert.equal(await lookup(tm, STARTED, 'PRETEST'), `${TESTVIEW_ORIGIN}/uut/detail/${pretest.id}`);
    assert.equal(requestUrl(listCalls(server)[0]).searchParams.get('operation'), PRETEST_OPERATION);
    const url = new URL(await tm.eval(`__eve.buildLionKingTestViewUrl('${SN}', '${STARTED}', 'PRETEST')`));
    assert.equal(url.pathname, LIST_PATH);
    assert.equal(url.search, '');
    const hash = new URLSearchParams(url.hash.slice(1));
    assert.equal(hash.get('eveLionSn'), SN);
    assert.equal(hash.get('eveLionStarted'), STARTED);
    assert.equal(hash.get('eveLionOperation'), PRETEST_OPERATION);
  });
});

test('API identity or unknown schema cannot return an unverified detail', async t => {
  for (const [name, options] of [
    ['different id', { detailBody: { data: { ...VALID, id: 8200009 } } }],
    ['different serial', { detailBody: { data: { ...VALID, uut_sn: `${SN}X` } } }],
    ['fixture-only serial', { detailBody: { data: { ...VALID, uut_sn: undefined, fixture_sn: SN } } }],
    ['different Started', { detailBody: { data: { ...VALID, started: NEWER.started } } }],
    ['wrong operation', { detailBody: { data: { ...VALID, operation: PRETEST_OPERATION } } }],
    ['SLT operation', { detailBody: { data: { ...VALID, operation: 'SLT' } } }],
    ['operation object', { detailBody: { data: { ...VALID, operation: { name: TEST_OPERATION } } } }],
    ['duplicate records', { detailBody: { data: { items: [VALID, VALID] } } }],
    ['unknown envelope', { detailBody: { unexpected: VALID } }],
    ['login HTML', { detailBody: '<html>Sign in</html>', detailType: 'text/html' }],
    ['malformed JSON', { detailBody: '{not-json' }],
    ['expired session', { detailStatus: 401 }],
    ['unavailable API', { detailStatus: 503 }]
  ]) {
    await t.test(name, async () => {
      const server = new UutServer(options);
      await run(server, async tm => {
        assert.equal(await lookup(tm), '');
        assert.equal(detailCalls(server).length, 1, 'list identity is insufficient without by-id verification');
      });
    });
  }
});

test('ambiguous newest IDs and invalid list identities never choose an arbitrary run', async t => {
  for (const [name, latest] of [
    ['different IDs at the same start', [VALID, { ...VALID, id: 8200009 }]],
    ['prefix-only serial', [{ ...VALID, uut_sn: `${SN}X` }]],
    ['fixture-only serial', [{ ...VALID, uut_sn: undefined, fixture_sn: SN }]],
    ['invalid run ID', [{ ...VALID, id: 'not-numeric' }]],
    ['unknown operation', [{ ...VALID, operation: 'SLT' }]],
    ['invalid Started', [{ ...VALID, started: 'not-a-date' }]]
  ]) {
    await t.test(name, async () => {
      const server = new UutServer({ latest });
      await run(server, async tm => {
        assert.equal(await lookup(tm, ''), '');
        assert.deepEqual(detailCalls(server), []);
      });
    });
  }
});

test('historical lookup is bounded and never substitutes a newer retest', async () => {
  const fullPage = Array.from({ length: 10 }, (_, index) => ({ ...NEWER, id: 8400000 + index }));
  const server = new UutServer({ latest: [NEWER], history: Array.from({ length: 6 }, () => fullPage) });
  await run(server, async tm => {
    assert.equal(await lookup(tm), '');
    assert.equal(listCalls(server).length, 6, 'one latest request plus at most five history pages');
    assert.deepEqual(detailCalls(server), []);
  });
});

test('malformed target, unsupported operation and unsafe API routes stay passive', async () => {
  const server = new UutServer();
  await run(server, async tm => {
    for (const [serial, started, operation] of [
      ['<script>', STARTED, TEST_OPERATION], [SN, 'not-a-date', TEST_OPERATION], [SN, STARTED, 'SLT']
    ]) assert.equal(await lookup(tm, started, operation, serial), '');
    for (const url of ['https://elsewhere.test' + API_PATH, TESTVIEW_ORIGIN + '/api/v1/server_level_tests/view']) {
      assert.equal(await tm.eval(`__eve.requestLionKingAPI(new URL(${JSON.stringify(url)}))`), null);
    }
    assert.deepEqual(apiCalls(server), []);
  });
});

test('opening a verified test goes directly to detail without a hash handoff', async () => {
  const server = new UutServer();
  await run(server, async tm => {
    await tm.eval(`__eve.openLionKingTestView('${SN}', '${STARTED}', url => { globalThis.lionOpened = url; })`);
    assert.equal(await tm.eval('globalThis.lionOpened'), `${TESTVIEW_ORIGIN}/uut/detail/${RUN_ID}`);
    assert.equal((await tm.gm()).store[HANDOFF_KEY], undefined);
  });
});

test('failed lookup opens a one-use API retry handoff and does not type or Query', async () => {
  const server = new UutServer({ listStatus: 401 });
  await run(server, async tm => {
    await tm.eval(`__eve.openLionKingTestView('${SN}', '${STARTED}', url => { globalThis.lionOpened = url; }, 'PRETEST')`);
    assert.equal(await tm.eval('globalThis.lionOpened'), targetUrl(SN, STARTED, PRETEST_OPERATION));
    const handoff = JSON.parse((await tm.gm()).store[HANDOFF_KEY]);
    assert.equal(handoff.serial, SN);
    assert.equal(handoff.started, STARTED);
    assert.equal(handoff.operation, PRETEST_OPERATION);
    assert.ok(Number.isFinite(handoff.ts));
  });
  const retry = new UutServer({ listStatus: 401 });
  await run(retry, async tm => {
    await tm.waitFor(() => tm.page.getByText(/EVE SLT\+JBOG TRACKER: could not resolve/).count());
    assert.equal(new URL(tm.page.url()).pathname, LIST_PATH);
    assert.deepEqual(detailLoads(retry), []);
    assert.equal(await tm.page.inputValue('#uut_sn'), 'KEEP-JBOG');
    assert.equal(await tm.page.inputValue('#server_sn'), 'KEEP-SLT');
  }, { url: targetUrl(SN, STARTED, PRETEST_OPERATION) });
});

test('target handoff is independent from SLT, expires and preserves unrelated hash values', async t => {
  const sltHandoff = JSON.stringify({ serial: '2699YW3888', ts: Date.now() });
  for (const [name, handoff, expectedSerial] of [
    ['fresh', JSON.stringify({ serial: SN, started: STARTED, operation: 'PRETEST', ts: Date.now() }), SN],
    ['stale', JSON.stringify({ serial: SN, ts: Date.now() - 121000 }), ''],
    ['future', JSON.stringify({ serial: SN, ts: Date.now() + 60000 }), ''],
    ['invalid JSON', '{', ''],
    ['wrong serial type', JSON.stringify({ serial: 123, ts: Date.now() }), '']
  ]) {
    await t.test(name, async () => {
      await run(new UutServer(), async tm => {
        // /detail is intentionally outside the automatic list helper.
        const target = await tm.eval('__eve.readLionKingTestViewTarget()');
        assert.equal(target.serial, expectedSerial);
        if (expectedSerial) assert.equal(target.operation, PRETEST_OPERATION);
        const gm = await tm.gm();
        assert.equal(gm.store[HANDOFF_KEY], undefined);
        assert.equal(gm.store.eveTestViewHandoff, sltHandoff);
      }, { url: `${TESTVIEW_ORIGIN}/uut/detail/1`, gmStore: { [HANDOFF_KEY]: handoff, eveTestViewHandoff: sltHandoff } });
    });
  }
  await run(new UutServer({ listStatus: 401 }), async tm => {
    await tm.waitFor(() => tm.page.getByText(/EVE SLT\+JBOG TRACKER: could not resolve/).count());
    const hash = new URLSearchParams(new URL(tm.page.url()).hash.slice(1));
    assert.equal(hash.get('other'), 'keep');
    assert.equal(hash.has('eveLionSn'), false);
    assert.equal(hash.has('eveLionStarted'), false);
    assert.equal(hash.has('eveLionOperation'), false);
    assert.equal((await tm.gm()).store[HANDOFF_KEY], undefined);
  }, { url: `${targetUrl()}&other=keep`, gmStore: { [HANDOFF_KEY]: JSON.stringify({ serial: '2699YW3999', ts: Date.now() }) } });
});

test('foreign origin with a UUT path leaves targets and both handoffs untouched', async () => {
  const server = new UutServer();
  const handoff = JSON.stringify({ serial: SN, started: STARTED, ts: Date.now() });
  const sltHandoff = JSON.stringify({ serial: SN, ts: Date.now() });
  await run(server, async tm => {
    await tm.page.waitForTimeout(300);
    assert.deepEqual(apiCalls(server), []);
    assert.equal((await tm.gm()).store[HANDOFF_KEY], handoff);
    assert.equal((await tm.gm()).store.eveTestViewHandoff, sltHandoff);
    assert.equal(new URL(tm.page.url()).hash, `#eveLionSn=${SN}`);
  }, { url: `https://elsewhere.test${LIST_PATH}#eveLionSn=${SN}`,
    gmStore: { [HANDOFF_KEY]: handoff, eveTestViewHandoff: sltHandoff } });
});
