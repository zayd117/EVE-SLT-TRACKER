// Development helper: paste on the signed-in TestView UUT list or detail page.
// Reads DOM labels and Resource Timing metadata, then up to 6 already-loaded
// same-origin JS assets (2 MiB each, 6 MiB total, 5-second timeout per asset).
// No API requests/replays, cookie/storage/input reads, request headers, or
// API response bodies. Query values, identifiers, and script text are omitted.
// Set READ_LOADED_SCRIPTS to false below for entirely passive inspection.
(async () => {
  'use strict';

  const READ_LOADED_SCRIPTS = true;
  const OBSERVE_MS = 15000;
  const MAX_SCRIPTS = 6;
  const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
  const SCRIPT_TIMEOUT_MS = 5000;
  const fieldNames = new Set([
    'id', 'run_id', 'test_id', 'uut_id', 'server_sn', 'uut_sn', 'sn', 'serial',
    'serial_number', 'server_serial', 'status', 'state', 'test_status',
    'started', 'finished', 'start_time', 'end_time', 'finish_time', 'duration',
    'operation', 'test_type', 'test_name', 'taskset', 'taskcase', 'pass',
    'result', 'model', 'product', 'rack', 'rack_serial', 'position', 'location',
    'section', 'facility', 'type', 'gpu_jbog_test', 'gpu_jbog_tests',
    'only_latest_uut', 'only_latest', 'page_num', 'page_size', 'page',
    'offset', 'limit', 'sort', 'order', 'filter', 'filters', 'search', 'query',
    'fields', 'data', 'items', 'page_info', 'count', 'total', 'code', 'msg'
  ]);
  const queryNames = new Set([
    ...fieldNames, 'in', 'keyword', 'start', 'end', 'only_latest_slt'
  ]);
  const routeWords = new Set([
    'api', 'uut', 'gpu_jbog_test', 'gpu_jbog_tests', 'unit_under_test',
    'unit_under_tests', 'unit_level_test', 'unit_level_tests', 'list', 'view',
    'detail', 'details', 'testdetail', 'test', 'tests', 'run', 'runs', 'unit',
    'units', 'server', 'servers', 'status', 'statuses', 'result', 'results',
    'history', 'latest', 'search', 'query', 'data', 'summary', 'summaries',
    'statistics', 'steps', 'tasksets', 'taskcases', 'live-dashboard', 'live'
  ]);
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const fieldLabel = value => {
    const normalized = normalize(value).replace(/\s*:\s*$/, '').replace(/[ -]+/g, '_');
    return fieldNames.has(normalized) ? normalized : null;
  };

  function sameOriginUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return /^https?:$/.test(url.protocol) && url.origin === window.location.origin
        ? url : null;
    } catch (error) {
      return null;
    }
  }

  function routeMetadata(value) {
    const url = sameOriginUrl(value);
    if (!url) return null;
    const path = url.pathname.split('/').map(segment => {
      const word = segment.toLowerCase();
      if (!word) return '';
      if (routeWords.has(word) || /^v[1-9]\d?$/.test(word)) return word;
      return ':redacted';
    }).join('/');
    return {
      path,
      queryNames: [...new Set(url.searchParams.keys())].filter(name => queryNames.has(name)).sort()
    };
  }

  const observed = new Map();
  const loadedScripts = new Map();
  function addScript(value) {
    const url = sameOriginUrl(value);
    if (url && /\.(?:m?js)$/i.test(url.pathname) && loadedScripts.size < 40) {
      loadedScripts.set(url.href, url.href);
    }
  }
  for (const script of document.querySelectorAll('script[src]')) addScript(script.src);
  function recordResources(entries) {
    for (const entry of entries) {
      if (entry.initiatorType === 'script') addScript(entry.name);
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      const route = routeMetadata(entry.name);
      if (!route || !/^\/(?:api|uut)\//.test(route.path)) continue;
      observed.set(JSON.stringify(route), route);
      if (observed.size > 80) observed.delete(observed.keys().next().value);
    }
  }

  recordResources(performance.getEntriesByType('resource'));
  let observer = null;
  let observingNewResources = false;
  try {
    observer = new PerformanceObserver(list => recordResources(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
    observingNewResources = true;
  } catch (error) {}
  await new Promise(resolve => setTimeout(resolve, OBSERVE_MS));
  if (observer) observer.disconnect();
  recordResources(performance.getEntriesByType('resource'));

  const apiLiterals = new Map();
  const scriptFields = new Set();
  function inspectScript(text) {
    // Only static quoted API paths mentioning the relevant resource are leads.
    // Template substitutions, fragments, query values, and source text stay private.
    const literals = /(["'`])(\/api\/[a-zA-Z0-9_./?-]{1,200})\1/g;
    for (const match of text.matchAll(literals)) {
      const path = match[2];
      if (!/(?:gpu_jbog|\/uut(?:\/|_|$))/i.test(path)) continue;
      const route = routeMetadata(path);
      if (route) apiLiterals.set(JSON.stringify(route), route);
      if (apiLiterals.size >= 60) break;
    }
    // Recognized code references are hints, not a verified response schema.
    for (const name of fieldNames) {
      const literal = new RegExp('(?:["\x27`]' + name + '["\x27`]|\\.' + name + '\\b)');
      if (literal.test(text)) scriptFields.add(name);
    }
  }

  async function inspectLoadedScript(url, byteLimit, index) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT_MS);
    let reader = null;
    let bytes = 0;
    try {
      const response = await fetch(url, {
        method: 'GET', credentials: 'same-origin', redirect: 'error',
        cache: 'force-cache', signal: controller.signal
      });
      if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
        return { asset: index, outcome: 'unavailable', bytes: 0 };
      }
      // A login/error document must not be mistaken for application source.
      if (!/javascript|ecmascript|text\/plain/i.test(response.headers.get('content-type') || '')) {
        await response.body.cancel();
        return { asset: index, outcome: 'unsupported-content', bytes: 0 };
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts = [];
      let complete = false;
      while (bytes < byteLimit) {
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          break;
        }
        const retained = chunk.value.subarray(0, byteLimit - bytes);
        bytes += retained.byteLength;
        parts.push(decoder.decode(retained, { stream: true }));
      }
      if (!complete) {
        await reader.cancel();
        controller.abort();
      }
      parts.push(decoder.decode());
      inspectScript(parts.join(''));
      return { asset: index, outcome: complete ? 'scanned' : 'truncated', bytes };
    } catch (error) {
      // Do not log fetch errors: their messages may contain the original URL.
      return { asset: index, outcome: 'read-error', bytes };
    } finally {
      clearTimeout(timeout);
      if (reader) {
        try { reader.releaseLock(); } catch (error) {}
      }
    }
  }

  const assetReads = [];
  let totalBytes = 0;
  if (READ_LOADED_SCRIPTS) {
    for (const url of [...loadedScripts.values()].slice(0, MAX_SCRIPTS)) {
      const remaining = MAX_TOTAL_BYTES - totalBytes;
      if (remaining <= 0) break;
      const result = await inspectLoadedScript(url, Math.min(MAX_SCRIPT_BYTES, remaining), assetReads.length + 1);
      assetReads.push(result);
      totalBytes += result.bytes;
    }
  }

  const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"],.ant-card-head-title')]
    .slice(0, 30).map(node => {
      const text = normalize(node.textContent);
      return { label: fieldLabel(text) || (/gpu[ _-]*jbog|lion[ _-]*king/.test(text)
        ? 'gpu_jbog_or_lion_king_heading' : '(unrecognized label; text omitted)') };
    });
  const inputs = [...document.querySelectorAll('input,select,textarea')].slice(0, 40).map(input => {
    const labels = input.labels ? [...input.labels].map(label => fieldLabel(label.textContent)).filter(Boolean) : [];
    const formItem = input.closest('.ant-form-item');
    const formLabel = formItem && formItem.querySelector('label,.ant-form-item-label');
    const type = String(input.type || '').toLowerCase();
    return {
      element: ['INPUT', 'SELECT', 'TEXTAREA'].includes(input.tagName) ? input.tagName.toLowerCase() : 'control',
      type: ['text', 'search', 'number', 'date', 'datetime-local', 'select-one', 'select-multiple', 'textarea'].includes(type) ? type : '(omitted)',
      idField: fieldLabel(input.getAttribute('id')),
      nameField: fieldLabel(input.getAttribute('name')),
      labels: [...new Set([...labels, fieldLabel(formLabel && formLabel.textContent)].filter(Boolean))]
    };
  });
  const tables = [...document.querySelectorAll('table')].slice(0, 20).map(table => ({
    headers: [...table.querySelectorAll('th')].slice(0, 60).map(cell => ({
      column: cell.cellIndex, field: fieldLabel(cell.textContent), colSpan: cell.colSpan, rowSpan: cell.rowSpan
    })),
    // Key/value detail tables often use TD labels rather than TH headings.
    detailFieldNames: [...new Set([...table.rows].slice(0, 80)
      .map(row => fieldLabel(row.cells[0] && row.cells[0].textContent)).filter(Boolean))],
    rowCount: table.rows.length
  }));
  const detailRoutes = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const url = sameOriginUrl(link.getAttribute('href'));
    if (!url || !/^\/uut\/detail\//i.test(url.pathname)) continue;
    const route = routeMetadata(url.href);
    detailRoutes.set(JSON.stringify(route), route);
    if (detailRoutes.size >= 30) break;
  }

  const report = {
    helper: 'eve-lion-testview-inspection-v1',
    page: routeMetadata(window.location.href),
    observation: { seconds: OBSERVE_MS / 1000, observingNewResources },
    observedRequestRoutes: [...observed.values()],
    loadedScriptApiLiterals: [...apiLiterals.values()],
    loadedScriptFieldReferences: [...scriptFields].sort(),
    assetReads,
    headings, inputs, tables, detailRoutes: [...detailRoutes.values()],
    note: 'Routes and code field references are discovery leads, not verified APIs or response schemas. Unknown route segments/field names and every query value/identifier are omitted. No API requests were replayed: Resource Timing does not reveal the original method. Missing entries do not prove there is no API.'
  };
  window.__eveLionTestViewInspection = report;
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
