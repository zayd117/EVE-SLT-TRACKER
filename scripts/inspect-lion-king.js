// Development helper: paste into the console of a signed-in source/detail page.
// Reads rendered structure and resource route metadata only. No requests,
// cookie/storage reads, request headers, response bodies, or input values.
// Waits 15 seconds for the page's normal API polling, then prints JSON.
(async () => {
  'use strict';

  const headerNames = new Set([
    'sn', 'serial', 'serial number', 'server serial', 'server asset', 'server_sn',
    'unit', 'uut', 'rack', 'rack serial', 'position', 'location', 'section',
    'status', 'state', 'test status', 'test_status', 'taskset_status', 'slt_status',
    'operation', 'taskset', 'taskcase', 'pass', 'result', 'started', 'finished',
    'start time', 'finish time', 'end time', 'duration', 'id', 'run id',
    'test id', 'attempt', 'model', 'type', 'product', 'test type', 'failure',
    'failure reason', 'reason', 'error', 'test name', 'name'
  ]);
  const states = new Set([
    'pass', 'passed', 'fail', 'failed', 'running', 'in progress', 'in_progress',
    'idle', 'pending', 'waiting', 'queued', 'complete', 'completed', 'success',
    'failure', 'error', 'aborted', 'cancelled', 'canceled', 'testing',
    'pretest', 'pre-test', 'test', 'slt', 'uut', 'lion king', 'lionking',
    'sys_dekit', 'dekit'
  ]);
  const queryFields = new Set([
    'fields', 'server_sn', 'sn', 'serial', 'in', 'facility', 'type', 'status',
    'state', 'id', 'run_id', 'test_id', 'uut_id', 'page', 'page_num', 'page_size',
    'offset', 'limit', 'sort', 'order', 'filter', 'filters', 'search', 'query',
    'keyword', 'rack', 'position', 'location', 'section', 'model', 'product',
    'only_latest_slt', 'only_latest_uut', 'only_latest', 'started', 'finished',
    'start', 'end', 'start_time', 'end_time'
  ]);
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

  function routeMetadata(value) {
    try {
      const url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
        return null;
      }
      // Keep route words; redact identifiers, filenames/hashes, and long segments.
      const path = url.pathname.split('/').map(segment => {
        if (!segment) return '';
        const lower = segment.toLowerCase();
        if (/^(?:api|v\d+|out|slt|uut|live-dashboard|live|list|view|detail|details|testdetail|server_level_tests|unit_under_tests|unit_level_tests|lionking|lion_king|lion|king|dashboard|dashboards|test|tests|run|runs|unit|units|server|servers|status|statuses|result|results|data|history|latest|search|query)$/.test(lower)) {
          return lower;
        }
        if (['out.eveslt.php', 'out.evelionking_all.php', 'out.eveserverdetail.php'].includes(lower)) return lower;
        return ':redacted';
      }).join('/');
      // Keep recognized schema names only; unknown/dynamic keys and all values
      // are omitted because either can contain an identifier or credential.
      const queryNames = [...new Set([...url.searchParams.keys()])]
        .filter(name => queryFields.has(name))
        .sort();
      return { path, queryNames };
    } catch (error) {
      return null;
    }
  }

  function knownLabel(text) {
    const value = normalize(text);
    if (headerNames.has(value)) return value;
    if (/^TA\.[a-z0-9_-]+-EVE\d+$/i.test(value)) return 'TA.<section>-EVE<number>';
    if (/^U\d+$/i.test(value)) return 'U<number>';
    if (/lion\s*king/i.test(value)) return 'lion king label';
    return value ? '(unrecognized label; text omitted)' : '(blank)';
  }

  const resources = new Map();
  function recordResources(entries) {
    for (const entry of entries) {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      const route = routeMetadata(entry.name);
      if (!route) continue;
      const key = JSON.stringify(route);
      resources.set(key, route);
      if (resources.size > 100) resources.delete(resources.keys().next().value);
    }
  }

  recordResources(performance.getEntriesByType('resource'));
  let observer = null;
  try {
    observer = new PerformanceObserver(list => recordResources(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
  } catch (error) {}
  await new Promise(resolve => setTimeout(resolve, 15000));
  if (observer) observer.disconnect();
  recordResources(performance.getEntriesByType('resource'));

  const tables = [...document.querySelectorAll('table')].slice(0, 30).map(table => ({
    headers: [...table.querySelectorAll('th')].slice(0, 80).map(th => ({
      column: th.cellIndex,
      label: knownLabel(th.textContent),
      colSpan: th.colSpan,
      rowSpan: th.rowSpan
    })),
    rowCount: table.rows.length,
    sampleRows: [...table.rows].filter(row => row.querySelector('td')).slice(0, 5).map(row => ({
      cellCount: row.cells.length,
      cells: [...row.cells].slice(0, 80).map(cell => {
        const text = normalize(cell.textContent);
        const links = [...cell.querySelectorAll('a[href]')].slice(0, 3)
          .map(a => routeMetadata(a.getAttribute('href'))).filter(Boolean);
        return {
          label: headerNames.has(text) ? text : null,
          status: states.has(text) ? text : null,
          color: getComputedStyle(cell).backgroundColor,
          colSpan: cell.colSpan,
          rowSpan: cell.rowSpan,
          links
        };
      })
    }))
  }));
  const detailLinks = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const route = routeMetadata(link.getAttribute('href'));
    if (route && /detail|test|lion|uut/i.test(route.path)) {
      detailLinks.set(JSON.stringify(route), route);
      if (detailLinks.size >= 40) break;
    }
  }
  const report = {
    helper: 'eve-lion-king-schema-inspection-v1',
    page: routeMetadata(window.location.href),
    scope: 'Rendered structure and same-origin observed request routes; identifiers and query values omitted.',
    observedRoutes: [...resources.values()],
    tables,
    detailRoutes: [...detailLinks.values()],
    note: 'Observed routes are candidates, not verified Lion King APIs. No API response fields or live behavior have been validated.'
  };
  window.__eveLionKingInspection = report;
  console.log(JSON.stringify(report, null, 2));
  return report;
})();
