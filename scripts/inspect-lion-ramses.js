// Development helper: paste into the signed-in Lion King dashboard console.
// Reports structure, allow-listed labels and redacted resource route metadata.
// Optionally reads up to 6 already-loaded same-origin JS assets (2 MiB each,
// 6 MiB total, 5-second timeout each). No API replay or WebSocket frame reads.
// Never reads cookies, storage, request headers, input values or credentials.
// No serials, ticket values, identifiers, query values or script source printed.
(async () => {
  'use strict';

  const READ_LOADED_SCRIPTS = true;
  const OBSERVE_MS = 15000;
  const MAX_SCRIPTS = 6;
  const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
  const SCRIPT_TIMEOUT_MS = 5000;
  const labels = new Set([
    'jbog sn', 'jbog_sn', 'jbog_num', 'tailnode_sn', 'headnode_sn',
    'sn', 'serial', 'serial number', 'uut_sn', 'fixture_sn', 'status',
    'operation', 'started', 'finished', 'duration', 'current route',
    'idle time', 'ticket number', 'id', 'run id', 'test id',
    'gpu_jbog_test started from', 'gpu_jbog_test finished date',
    'lion king live operations dashboard', 'jbog operations action board',
    'jbog running test', 'jbog failed test', 'running test', 'failing online',
    'active total', 'mpy (passed jbogs)', 'selected range fpy',
    'test capacity utilization', '30-day jbog trend'
  ]);
  const knownValues = new Set([
    'running slt', 'pretest', 'gpu_jbog_test', 'gpu_jbog_test_pretest',
    'running', 'pass', 'passed', 'fail', 'failed', 'online', 'offline',
    'slt', 'test-sv-hp', 'repair queue', 'complete', 'completed',
    'pending', 'waiting', 'unknown', 'idle'
  ]);
  const fields = new Set([
    'id', 'run_id', 'test_id', 'uut_id', 'uut_sn', 'fixture_sn', 'jbog_sn',
    'tailnode_sn', 'headnode_sn', 'status', 'state', 'operation', 'started',
    'finished', 'duration', 'result', 'current_route', 'idle_time',
    'ticket_number', 'items', 'data', 'total', 'count', 'page', 'page_size',
    'offset', 'limit', 'sort', 'order', 'filter', 'start', 'end', 'fields',
    'dashboard', 'type', 'query', 'search'
  ]);
  const routeWords = new Set([
    '_stcore', 'stream', 'health', 'host-config', 'upload_file',
    'media', 'static', 'assets', 'component', 'components', 'index.html',
    'api', 'uut', 'uut_status', 'gpu_jbog_test', 'gpu_jbog_test_pretest',
    'jbog', 'dashboard', 'dashboards', 'list', 'view', 'by_id', 'detail',
    'test', 'tests', 'run', 'runs', 'status', 'statuses', 'result', 'results',
    'history', 'latest', 'search', 'query', 'data', 'summary', 'download',
    'csv', 'export', 'streamlit'
  ]);
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const knownLabel = value => labels.has(normalize(value)) ? normalize(value) : null;
  const knownValue = value => knownValues.has(normalize(value)) ? normalize(value) : null;

  function pageUrl(value) {
    try {
      const url = new URL(value, location.href);
      return /^https?:$/.test(url.protocol) && url.origin === location.origin ? url : null;
    } catch (error) {
      return null;
    }
  }

  function routeMetadata(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^(?:https?|wss?):$/.test(url.protocol)) return null;
      const sameHost = url.host === location.host;
      // Relevant UUT detail links may be cross-origin. Never print the host.
      const isUut = /^\/uut\/(?:detail|gpu_jbog_test\/list)(?:\/|$)/.test(url.pathname);
      if (!sameHost && !isUut) return null;
      const path = url.pathname.split('/').map(segment => {
        const word = segment.toLowerCase();
        if (!word) return '';
        return routeWords.has(word) || /^v[1-9]\d?$/.test(word) ? word : ':redacted';
      }).join('/');
      return {
        origin: sameHost ? 'page-origin' : 'cross-origin-uut-candidate',
        transport: /^wss?:$/.test(url.protocol) ? 'websocket' : 'http',
        path,
        queryNames: [...new Set(url.searchParams.keys())].filter(name => fields.has(name)).sort()
      };
    } catch (error) {
      return null;
    }
  }

  const routes = new Map();
  const loadedScripts = new Map();
  const timings = { count: 0, maxDurationMs: 0, transferredBytes: 0 };
  const timedEntries = new Set();
  function addScript(value) {
    const url = pageUrl(value);
    if (url && /\.(?:m?js)$/i.test(url.pathname) && loadedScripts.size < 40) {
      loadedScripts.set(url.href, url.href);
    }
  }
  function recordResources(entries) {
    for (const entry of entries) {
      if (entry.initiatorType === 'script') addScript(entry.name);
      if (!['fetch', 'xmlhttprequest', 'script', 'other'].includes(entry.initiatorType)) continue;
      const route = routeMetadata(entry.name);
      if (!route) continue;
      const key = JSON.stringify(route);
      routes.set(key, route);
      if (routes.size > 100) routes.delete(routes.keys().next().value);
      const timingKey = entry.name + ':' + entry.startTime;
      if (!timedEntries.has(timingKey)) {
        timedEntries.add(timingKey);
        timings.count++;
        timings.maxDurationMs = Math.max(timings.maxDurationMs, Math.round(Number(entry.duration) || 0));
        timings.transferredBytes += Math.max(0, Number(entry.transferSize) || 0);
      }
    }
  }
  for (const script of document.querySelectorAll('script[src]')) addScript(script.src);
  recordResources(performance.getEntriesByType('resource'));
  let observer = null;
  try {
    observer = new PerformanceObserver(list => recordResources(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
  } catch (error) {}
  await new Promise(resolve => setTimeout(resolve, OBSERVE_MS));
  if (observer) observer.disconnect();
  recordResources(performance.getEntriesByType('resource'));

  const routeHints = new Map();
  const codeFields = new Set();
  function inspectScript(source) {
    // Streamlit's generic client bundle may expose transport names, but not
    // the Python application's data-query API or a validated row schema.
    for (const path of ['/_stcore/stream', '/_stcore/health', '/_stcore/host-config']) {
      if (source.includes(path) || source.includes(path.slice(1))) {
        const route = routeMetadata(path);
        routeHints.set(JSON.stringify(route), route);
      }
    }
    const literalPattern = /(["'`])(\/(?:api|uut|_stcore)\/[a-zA-Z0-9_./?-]{1,200})\1/g;
    for (const match of source.matchAll(literalPattern)) {
      const route = routeMetadata(match[2]);
      if (route) routeHints.set(JSON.stringify(route), route);
      if (routeHints.size >= 50) break;
    }
    for (const name of fields) {
      const literal = new RegExp('(?:["\x27`]' + name + '["\x27`]|\\.' + name + '\\b)');
      if (literal.test(source)) codeFields.add(name);
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
        if (chunk.done) { complete = true; break; }
        const retained = chunk.value.subarray(0, byteLimit - bytes);
        bytes += retained.byteLength;
        parts.push(decoder.decode(retained, { stream: true }));
      }
      if (!complete) { await reader.cancel(); controller.abort(); }
      parts.push(decoder.decode());
      inspectScript(parts.join(''));
      return { asset: index, outcome: complete ? 'scanned' : 'truncated', bytes };
    } catch (error) {
      return { asset: index, outcome: 'read-error', bytes };
    } finally {
      clearTimeout(timeout);
      if (reader) { try { reader.releaseLock(); } catch (error) {} }
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

  function valueShape(text) {
    const value = String(text || '').trim();
    if (!value) return 'blank';
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) return 'date-time';
    if (/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(value)) return 'date';
    if (/^\d{1,4}:\d{2}$/.test(value)) return 'hours-minutes-shaped';
    if (/^(?:\d+d)?\d+h\d+m$/i.test(value)) return 'idle-duration-shaped';
    if (/^\d+$/.test(value)) return 'integer-shaped';
    return 'omitted';
  }
  const tables = [...document.querySelectorAll('table')].slice(0, 30).map(table => {
    const rows = [...table.rows].filter(row => row.querySelector('td'));
    const counts = {};
    for (const row of rows) {
      for (const cell of row.cells) {
        const value = knownValue(cell.textContent);
        if (value) counts[value] = (counts[value] || 0) + 1;
      }
    }
    return {
      headers: [...table.querySelectorAll('th')].slice(0, 40).map(cell => ({
        column: cell.cellIndex, label: knownLabel(cell.textContent),
        colSpan: cell.colSpan, rowSpan: cell.rowSpan
      })),
      rowCount: rows.length,
      recognizedValueCounts: counts,
      sampleRows: rows.slice(0, 5).map(row => ({
        cellCount: row.cells.length,
        cells: [...row.cells].slice(0, 40).map(cell => ({
          label: knownLabel(cell.textContent), value: knownValue(cell.textContent),
          shape: valueShape(cell.textContent),
          links: [...cell.querySelectorAll('a[href]')].slice(0, 3)
            .map(link => routeMetadata(link.getAttribute('href'))).filter(Boolean)
        }))
      }))
    };
  });
  const links = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const route = routeMetadata(link.getAttribute('href'));
    if (route && /(?:uut|csv|download|export|api|_stcore)/.test(route.path)) {
      links.set(JSON.stringify(route), route);
      if (links.size >= 40) break;
    }
  }
  const report = {
    helper: 'eve-lion-ramses-schema-inspection-v1',
    scope: 'Allow-listed DOM labels and redacted route hints; no identifiers, query values or socket frames.',
    page: routeMetadata(location.href), readyState: document.readyState,
    headings: [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],label')]
      .slice(0, 80).map(node => knownLabel(node.textContent)).filter(Boolean),
    dateControls: [...document.querySelectorAll('input,select')].slice(0, 40).map(control => ({
      element: control.tagName.toLowerCase(),
      type: ['date', 'text', 'number', 'select-one'].includes(control.type) ? control.type : 'omitted',
      labels: [...(control.labels || [])].map(label => knownLabel(label.textContent)).filter(Boolean)
    })),
    tables,
    nonDomDataframes: {
      canvasCount: document.querySelectorAll('canvas').length,
      ariaGridCount: document.querySelectorAll('[role="grid"]').length,
      iframeCount: document.querySelectorAll('iframe').length
    },
    observedRoutes: [...routes.values()],
    observedResourceTiming: timings,
    linkRoutes: [...links.values()],
    assetReads,
    staticRouteHints: [...routeHints.values()],
    staticFieldHints: [...codeFields].sort(),
    notes: [
      'Static route/field hints are candidates, not verified data APIs or response fields.',
      'WebSocket Resource Timing may be absent. No socket is intercepted, opened or read.',
      'Canvas/iframe data may not be represented by DOM tables. Counts do not prove full source coverage.',
      'Online inventory and row disappearance do not establish completed PASS/FAIL results.',
      'Zero transferred bytes may reflect caching or timing restrictions, not an empty response.'
    ]
  };
  window.__eveLionRamsesInspection = report;
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
