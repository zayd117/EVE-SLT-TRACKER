// Fixture "internet" for the browser tests. Every request the page or the
// userscript makes is answered here; anything unrouted gets a 404 and is
// recorded, so a test can assert no unexpected host was contacted.
//
// All data is synthetic: serials follow the real shape (4 digits + YW + 4)
// but are made up. Never paste real serials, tokens or hostnames' data here.

export const RACK_URL = 'https://rack.test/out/out.eveslt.php?rack=A7';
export const JIRA_HOST = 'jira.synnex.com';
export const TESTVIEW_ORIGIN = 'https://testview-eve-fmt.hyvesolutions.org';

export class FixtureServer {
  constructor() {
    this.requests = [];
    this.unrouted = [];
    this.rack = new RackModel();
    this.details = new Map();        // serial -> detail page options
    this.detailStatus = 200;
    this.detailDelayMs = 0;          // slow detail pages (confirmation races)
    this.jira = new Map();           // serial -> jira issues array
    this.jiraStatus = 200;
    this.testview = {
      api: new Map(),                // serial -> items array
      apiStatus: 200,
      apiDelayMs: 0,
      listHtml: null                 // override for /slt/list
    };
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    this.requests.push(`${req.method()} ${url.host}${url.pathname}${url.search}`);
    const res = await this.respond(url, req);
    if (!res) {
      this.unrouted.push(url.href);
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no fixture' });
    }
    return route.fulfill(res);
  }

  async respond(url, req) {
    const html = body => ({ status: 200, contentType: 'text/html', body });
    if (url.host === 'rack.test') {
      if (url.pathname === '/out/out.eveslt.php') return html(this.rack.render());
      if (url.pathname === '/out/out.eveserverdetail.php') {
        const serial = url.searchParams.get('in') || '';
        if (this.detailDelayMs) await new Promise(r => setTimeout(r, this.detailDelayMs));
        if (this.detailStatus !== 200) return { status: this.detailStatus, body: 'error' };
        return html(detailPage(serial, this.details.get(serial)));
      }
    }
    if (url.host === JIRA_HOST) {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (this.jiraStatus !== 200) return { status: this.jiraStatus, headers: cors, body: 'nope' };
      const jql = url.searchParams.get('jql') || '';
      const serial = (jql.match(/[0-9]{4}YW[0-9A-Z]{4}/) || [''])[0];
      const issues = this.jira.get(serial) || [];
      return {
        status: 200, headers: cors, contentType: 'application/json',
        body: JSON.stringify({ total: issues.length, issues })
      };
    }
    if (url.origin === TESTVIEW_ORIGIN) {
      if (url.pathname === '/api/v1/server_level_tests/view') {
        const tv = this.testview;
        if (tv.apiDelayMs) await new Promise(r => setTimeout(r, tv.apiDelayMs));
        if (tv.apiStatus !== 200) return { status: tv.apiStatus, body: 'error' };
        const sn = url.searchParams.get('server_sn') || '';
        const items = tv.api.get(sn) || [];
        return {
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ code: 200, msg: 'OK', data: { page_info: { count: items.length }, items } })
        };
      }
      if (url.pathname === '/slt/list') return html(this.testview.listHtml || testViewListPage());
      if (url.pathname.startsWith('/slt/testdetail/')) return html('<h1 id="detail">test detail</h1>');
    }
    if (url.host === 'elsewhere.test' && url.pathname === '/slt/list') {
      return html('<h1>some other site</h1>');
    }
    return null;
  }
}

// ---------------------------------------------------------------- rack page
// Colours are the page's real bgcolor names.
export const COLOR = {
  pretest: 'lightblue', testing: 'lightgreen', failed: 'red', passed: 'darkgreen', empty: ''
};

export class RackModel {
  constructor() {
    this.section = 'A7';
    this.eves = ['EVE01', 'EVE02'];
    this.units = ['U1', 'U2', 'U3'];
    this.slots = new Map(); // `${eve}|${unit}` -> { serial, color }
    let n = 0;
    for (const eve of this.eves) {
      for (const unit of this.units) {
        n += 1;
        this.slots.set(`${eve}|${unit}`, {
          serial: `2699YW${String(1000 + n)}`, color: COLOR.testing
        });
      }
    }
  }

  slot(eve, unit) { return this.slots.get(`${eve}|${unit}`); }

  render() {
    const head = this.eves.map(e => `<th>TA.${this.section}-${e}</th>`).join('');
    const rows = this.units.map(unit => {
      const cells = this.eves.map(eve => {
        const s = this.slot(eve, unit);
        if (!s || !s.serial) return '<td></td>';
        return `<td bgcolor="${s.color}"><a href="/out/out.eveserverdetail.php?facility=test&in=${s.serial}">` +
          `${s.serial} X000TESTTYPE -SLT - 01:00 1234567</a></td>`;
      }).join('');
      return `<tr><td>${unit}</td>${cells}</tr>`;
    }).join('');
    return `<!doctype html><html><head><title>EVE SLT</title>
      <meta http-equiv="refresh" content="60"></head><body>
      <h2>Rack fixture</h2>
      <table border="1"><thead><tr><th>Unit</th>${head}</tr></thead><tbody>${rows}</tbody></table>
      </body></html>`;
  }
}

// -------------------------------------------------------------- detail page
// opts: { operation, taskset, status, pass, finished, rows }
export function detailPage(serial, opts = {}) {
  const o = { operation: 'SLT', taskset: 'SLT_MAIN', status: 'FAIL', pass: '0',
    started: '2026-01-01 01:00:00', finished: '2026-01-01 02:00:00', ...opts };
  const row = r => `<tr><td>${serial}</td><td>${r.operation}</td><td>${r.taskset}</td>` +
    `<td>${r.status}</td><td>${r.pass}</td><td>${r.started}</td><td>${r.finished}</td></tr>`;
  const rows = (o.rows || [o]).map(r => row({ ...o, ...r })).join('');
  return `<!doctype html><html><body>
    <table><tr><td>Server Serial</td><td>${serial}</td></tr><tr><td>Position</td><td>4</td></tr></table>
    <table><tr><th>SN</th><th>Operation</th><th>taskset</th><th>taskset_status</th><th>Pass</th><th>Started</th><th>Finished</th></tr>
    ${rows}</table></body></html>`;
}

// ------------------------------------------------------------ TestView list
// Minimal stand-in for the Ant Design SLT list: SN input, Query button, table.
// Behaves like antd where the script depends on it: the form's submit handler
// preventDefault()s and runs the query; an empty result renders
// .ant-table-placeholder. window.queries records every SN actually queried.
//
// nativeSubmit: the form's submit handler runs the query but does NOT
// preventDefault (a plain, non-antd form): a real submission then reloads the
// page. buttonType / clickQueries shape how the Query button behaves.
export function testViewListPage({ firstLoadMs = 600, rows = ['2699YW1001', '2699YW2001', '2699YW1003'],
  nativeSubmit = false, buttonType = 'button', clickQueries = true } = {}) {
  return `<!doctype html><html><body>
  <form class="ant-form"><div class="ant-form-item"><label>SN</label>
    <input id="server_sn" class="ant-input" placeholder="Please enter"></div>
    <button type="${buttonType}" class="ant-btn ant-btn-primary"><span>Query</span></button></form>
  <div class="ant-table-wrapper"><div id="spin"></div>
    <table><tbody class="ant-table-tbody"></tbody></table></div>
  <script>
    const ALL = ${JSON.stringify(rows)};
    window.queries = [];
    const tbody = document.querySelector('tbody'), spin = document.getElementById('spin');
    let sn = '';
    document.getElementById('server_sn').addEventListener('input', e => { sn = e.target.value; });
    const load = (filter, ms) => {
      spin.className = 'ant-spin ant-spin-spinning';
      setTimeout(() => {
        const hits = ALL.filter(x => !filter || x === filter);
        tbody.innerHTML = hits.length
          ? hits.map(x => '<tr class="ant-table-row"><td>' + x + '</td></tr>').join('')
          : '<tr class="ant-table-placeholder"><td>No data</td></tr>';
        spin.className = '';
      }, ms);
    };
    const query = () => { window.queries.push(sn); load(sn, 300); };
    if (${clickQueries}) document.querySelector('button').addEventListener('click', e => { if (e.target.closest('button').type !== 'submit') query(); });
    document.querySelector('form').addEventListener('submit', e => { if (!${nativeSubmit}) e.preventDefault(); query(); });
    load('', ${firstLoadMs});
  </script></body></html>`;
}
