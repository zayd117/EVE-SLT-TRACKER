// Shared helpers for the fixture-mapping tests. Everything here is synthetic: the script's shipped
// fixture list is swapped for a test list, so no test needs (or contains) a real serial.
import assert from 'node:assert/strict';
import {
  launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES
} from './userscript.mjs';
import { FixtureServer, TESTVIEW_ORIGIN } from './server.mjs';
import { withEnabledLionRows } from './lion.mjs';

export { launchBrowser, openWithScript, instrument, SCRIPT_SOURCE, HOOK_NAMES, FixtureServer, TESTVIEW_ORIGIN, withEnabledLionRows };

export const LION_URL = 'https://rack.test/out/out.evelionking_all.php';
export const BOARD = '#eve-lion-rack-board';
export const RACK = 'TA.B6-EVE03';       // row B6
export const RACK_B7 = 'TA.B7-EVE02';    // row B7 (a different, separately enabled row)
export const OP = 'GPU_JBOG_TEST';
export const PRE = 'GPU_JBOG_TEST_PRETEST';
export const REGISTRY_KEY = 'eveLionRackFixtureRegistryV1';
export const OCCUPANCY_KEY = 'eveLionRackOccupancyV1';
export const DEV_KEY = 'eveLionRackDevV1';
export const API_PATH = '/api/v1/uut_status/view';

export const pacific = ms => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

let nextId = 9000100;
// One TestView test record. ago = hours since Started; done = hours the test took (omit while running).
export function rec(fixture, uut, { ago = 0.5, op = OP, status, done, id } = {}) {
  const startedMs = Date.now() - ago * 3600000;
  const finished = done === undefined ? '' : pacific(startedMs + done * 3600000);
  return { id: id ?? nextId++, uut_sn: uut, fixture_sn: fixture, operation: op,
    status: status ?? (done === undefined ? 'Running' : 'Success'), started: pacific(startedMs), finished };
}

const started = hours => new Date(Date.now() - hours * 3600000).toISOString();
export const LIVE_ROWS = [
  { tail: '2699YW1001', head: '2699YW2001', started: started(1), color: 'lightgreen', text: 'X11-2C.TEST -- : 01:00' },
  { tail: '2699YW1002', head: '2699YW2002', started: started(2), color: 'darkgreen', text: '06:00' },
  { tail: '2699YW1003', head: '2699YW2003', started: started(1), color: 'red', text: 'CHECK_GPU : 03:12' }
];

export class FxServer extends FixtureServer {
  constructor() {
    super();
    this.records = [];            // every TestView record, any fixture
    this.status = new Map();      // fixture -> forced HTTP status
    this.delay = new Map();       // fixture -> response delay (ms)
    this.calls = [];              // one entry per resolver/lookup request
    this.leak = false;            // ignore fixture_sn filtering (a server that cannot be trusted)
    this.liveRows = LIVE_ROWS;
    this.order = 'asc';           // return oldest first, so ordering is never relied on
  }

  add(...records) { this.records.push(...records); return this; }
  forFixture(fixture) { return this.calls.filter(call => call.fixture === fixture); }

  async respond(url, req) {
    if (url.host === 'rack.test' && url.pathname === '/out/out.evelionking_all.php') {
      const body = '<!doctype html><html><head><title>EVE LionKing GPU_JBOG_TEST</title></head><body>' +
        '<h2>EVE LionKing GPU_JBOG_TEST</h2><table><thead><tr>' +
        ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status'].map(h => `<th>${h}</th>`).join('') +
        '</tr></thead><tbody>' + this.liveRows.map((r, i) =>
          `<tr data-lion-fixture="${'abcdef'[i]}"><td>${i + 1}</td><td>${r.tail}</td><td>${r.head}</td><td>${r.started}</td>` +
          `<td bgcolor="${r.color}">${r.text}</td></tr>`).join('') + '</tbody></table></body></html>';
      return { status: 200, contentType: 'text/html', body };
    }
    if (url.origin === TESTVIEW_ORIGIN && url.pathname === API_PATH) {
      const q = url.searchParams, fixture = (q.get('fixture_sn') || '').toUpperCase(), uut = (q.get('uut_sn') || '').toUpperCase();
      const operation = q.get('operation'), page = Number(q.get('page_num')) || 1, size = Number(q.get('page_size')) || 10;
      this.calls.push({ fixture, uut, operation, page, size, latest: q.get('only_latest_uut_status'),
        exact: q.get('operation_is_exact'), fields: q.getAll('fields') });
      const wait = this.delay.get(fixture) || 0;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const cors = { 'access-control-allow-origin': '*' };
      if (this.status.has(fixture)) return { status: this.status.get(fixture), headers: cors, body: 'forced error' };
      let rows = this.records.filter(r => (!operation || r.operation === operation) &&
        (this.leak && fixture ? true : !fixture || r.fixture_sn.toUpperCase() === fixture) && (!uut || r.uut_sn.toUpperCase() === uut));
      rows = rows.slice().sort((a, b) => this.order === 'asc' ? a.id - b.id : b.id - a.id);
      if (q.get('only_latest_uut_status') === 'true') {
        const seen = new Set();
        rows = rows.slice().sort((a, b) => b.id - a.id).filter(r => !seen.has(r.uut_sn) && seen.add(r.uut_sn));
      }
      const items = rows.slice((page - 1) * size, page * size);
      return { status: 200, headers: cors, contentType: 'application/json',
        body: JSON.stringify({ code: 200, data: { items, page_info: { count: rows.length, page_num: page, page_size: size } } }) };
    }
    return super.respond(url, req);
  }
}

// A registry in the saved shape. racks: rack -> [fixtures per position in slot order: top, bottom, left, right].
// mapRevision defaults to the script's own, i.e. a registry written by this version.
export function registryOf(racks, { revision = 1, history = [], mapRevision = 1 } = {}) {
  const slots = {};
  for (const [rack, list] of Object.entries(racks)) {
    slots[rack] = [0, 1, 2, 3].map(position => {
      const entry = list[position];
      const fixtures = Array.isArray(entry) ? entry : entry ? [entry] : [];
      return { fixtures, maintenance: false, rev: 1, changedAt: 0, suppress: null };
    });
  }
  return { version: 1, kind: 'eve-lion-fixture-registry', ...(mapRevision === null ? {} : { mapRevision }), revision, slots, history };
}

// The script's built-in fixture list is one object literal; tests replace it. A list is rack -> [fixture per
// position in slot order], written in the script's own { top, bottom, left, right } form.
const BUILT_IN = /const LION_DEFAULT_FIXTURES = \{[\s\S]*?\n  \};/;
const POSITION_KEYS = ['top', 'bottom', 'left', 'right'];
export function withBuiltIn(source, map = {}) {
  assert.equal(source.split('const LION_DEFAULT_FIXTURES = {').length, 2, 'one built-in list in the script');
  const table = Object.fromEntries(Object.entries(map).map(([rack, list]) =>
    [rack, Object.fromEntries(POSITION_KEYS.map((key, position) => [key, list[position] || '']))]));
  return source.replace(BUILT_IN, () => `const LION_DEFAULT_FIXTURES = ${JSON.stringify(table)};`);
}

const TAIL = '  bootstrap();\n})();';
const EXTRA = [
  'evaluateLionSlot', 'resolveLionSlot', 'resolveLionRack', 'setLionFixture', 'removeLionFixture', 'resetLionFixtures',
  'setLionMaintenance', 'pumpLionFixtures', 'lionSlotIdentities', 'lionRackSlotView', 'scanLionKing', 'flushLionOccupancy',
  'normalizeLionFixtureRegistry', 'normalizeLionOccupancy', 'lionFixtureDiagnostics', 'saveLionFixtureRegistry',
  'refreshLionRackBoard', 'lionAttempt', 'lionTestViewStatus'
];

// The script with the hooks the fixture tests need. builtIn: the built-in list to run with (default none).
export function hooked(source = SCRIPT_SOURCE, builtIn = {}) {
  const base = instrument(withBuiltIn(source, builtIn), [...HOOK_NAMES, ...EXTRA]);
  const at = base.lastIndexOf(TAIL);
  const extra =
    '  globalThis.__efm = { registry: () => lionFixtureRegistry, occupancy: () => lionOccupancy,' +
    ' identities: () => [...lionSlotIdentities().values()].map(id => ({ rack: id.rack, position: id.position, mode: id.mode,' +
    ' serial: id.serial, stale: id.stale, state: lionRackSlotView(id.rack, id.position).state })),' +
    ' index: () => [...lionRackIndex], busy: () => lionResolveBusy, focus: () => ({ rack: lionFocusRack, until: lionFocusUntil }) };\n';
  return base.slice(0, at) + extra + base.slice(at);
}

// dev: the Dev box is on (fixtures can be changed). It lives in this tab's sessionStorage.
export async function openFx(browser, { server = new FxServer(), registry, enabled = true, source = SCRIPT_SOURCE,
  builtIn = {}, localStorage = {}, open = true, dev = true } = {}) {
  const seeds = { ...localStorage, ...(registry ? { [REGISTRY_KEY]: registry } : {}) };
  const options = enabled ? withEnabledLionRows({ localStorage: seeds }) : { localStorage: seeds };
  const tm = await openWithScript(browser, LION_URL, server, { ...options, ...(dev ? { rawSessionStorage: { [DEV_KEY]: '1' } } : {}),
    source: hooked(source, builtIn) });
  await tm.waitFor(() => tm.page.$('#eve-tracker-panel'), { message: 'Lion panel' });
  await tm.eval('__eve.scanLionKing()');
  if (open) await tm.page.click('#lion-rack-open');
  return { tm, server };
}

export const slotSel = (position, rack = RACK) => `${BOARD} [data-rack="${rack}"] [data-slot="${position}"]`;
export const slotText = async (tm, position, rack = RACK) => (await tm.page.locator(slotSel(position, rack)).innerText()).replace(/\s+/g, ' ').trim();
export const efm = (tm, expression) => tm.eval(`__efm.${expression}`);
export const identity = async (tm, position, rack = RACK) =>
  (await efm(tm, 'identities()')).find(item => item.rack === rack && item.position === position);

export async function scanRack(tm, value) {
  await tm.page.fill('#lion-rack-locate', value);
  await tm.page.press('#lion-rack-locate', 'Enter');
}
export const locateNote = tm => tm.page.textContent('#lion-rack-locate-note');

// Change a live-source row the way the page does (cells + bgcolor), then rescan.
export async function changeRow(tm, id, values) {
  await tm.page.evaluate(({ id, values }) => {
    const row = document.querySelector(`[data-lion-fixture="${id}"]`);
    const fields = { tail: 1, head: 2, started: 3, text: 4 };
    for (const [field, index] of Object.entries(fields)) if (field in values) row.cells[index].textContent = values[field];
    if ('color' in values) row.cells[4].setAttribute('bgcolor', values.color);
  }, { id, values });
  await tm.eval('__eve.scanLionKing()');
}
