// Loads the REAL userscript into a page the way Tampermonkey does:
//   - in an isolated JS world (not the page's world),
//   - at document start,
//   - with `window` replaced by a proxy (Tampermonkey's sandbox window is not
//     a real Window - this is what exposed the v0.9.9 `view: window` crash),
//   - with GM_* APIs stubbed and recorded.
// The script file is never edited. For unit tests a hook exposing internal
// functions is appended to an in-memory copy (see HOOK_NAMES).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// EVE_SCRIPT lets tests/mutation.mjs point the whole suite at a mutated copy.
export const SCRIPT_PATH = process.env.EVE_SCRIPT || path.join(ROOT, 'EVE_SLT_Tracker.user.js');
export const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');
export const SCRIPT_VERSION = SCRIPT_SOURCE.match(/^\/\/ @version\s+(\S+)/m)[1];

// Internal functions exposed to tests as globalThis.__eve.<name>. If one is
// renamed in the script, instrument() throws naming it - update this list and
// docs/TESTING.md together.
export const HOOK_NAMES = [
  'getTransitionType', 'resolveTransitionFromDetail', 'canonicalColor',
  'normalizePhaseWord', 'normalizeStatusWord', 'normalizePassFlag',
  'parseDetailDocument', 'parseJiraResponse', 'safeUrl', 'escapeHtml', 'csvEscape',
  'shiftWindowAt', 'guessShift', 'isDuplicateAlert', 'scan', 'performSoftRefresh',
  'getAlertLog', 'buildAlertLogCsv', 'buildAlertLogText',
  'buildTestViewUrl', 'isTestViewOrigin', 'readTestViewSerial'
];

const TAIL = '  bootstrap();\n})();';

export function instrument(source = SCRIPT_SOURCE, names = HOOK_NAMES) {
  if (!source.trimEnd().endsWith(TAIL.trimEnd())) {
    throw new Error('userscript no longer ends with "bootstrap();\\n})();" - update the test hook');
  }
  for (const name of names) {
    if (!new RegExp(`function ${name}\\(`).test(source)) {
      throw new Error(`test hook: function ${name}() not found in the userscript`);
    }
  }
  const hook =
    '  globalThis.__eve = { ' + names.join(', ') +
    ', state: () => ({ settings, previousStates: Object.fromEntries(previousStates) }) };\n';
  const at = source.lastIndexOf(TAIL);
  return source.slice(0, at) + hook + source.slice(at);
}

// Runs inside the isolated world before the script.
function gmPrelude(seed) {
  return `
    var __gm = globalThis.__gm = {
      store: ${JSON.stringify(seed.gmStore || {})},
      notifications: [], openedTabs: [], windowOpens: [], xhr: []
    };
    var GM_info = { script: { version: ${JSON.stringify(seed.version)}, name: 'EVE SLT Tracker' } };
    function GM_notification(details) { __gm.notifications.push(JSON.parse(JSON.stringify(details, (k, v) => typeof v === 'function' ? '[fn]' : v))); __gm.lastNotification = details; }
    function GM_openInTab(url, opts) { __gm.openedTabs.push(String(url)); return { close() {} }; }
    function GM_setValue(k, v) { __gm.store[k] = v; }
    function GM_getValue(k, d) { return k in __gm.store ? __gm.store[k] : d; }
    function GM_deleteValue(k) { delete __gm.store[k]; }
    function GM_xmlhttpRequest(o) {
      __gm.xhr.push(o.url);
      fetch(o.url, { method: o.method || 'GET', headers: o.headers || {} })
        .then(r => r.text().then(t => o.onload && o.onload({ status: r.status, responseText: t, finalUrl: r.url })))
        .catch(e => o.onerror && o.onerror(e));
      return { abort() { o.onabort && o.onabort(); } };
    }
  `;
}

function wrapInSandboxWindow(body) {
  // Proxy like Tampermonkey's: property reads work, but it is NOT a Window,
  // so `new MouseEvent(t, { view: window })` throws exactly as in the field.
  return `
    (function (window) {
${body}
    })(new Proxy(window, {
      get(t, k) {
        if (k === 'open') return (...a) => { __gm.windowOpens.push(String(a[0])); return null; };
        const v = Reflect.get(t, k);
        return typeof v === 'function' && !/^[A-Z]/.test(String(k)) ? v.bind(t) : v;
      },
      set(t, k, v) { return Reflect.set(t, k, v); }
    }));
  `;
}

export async function launchBrowser() {
  return chromium.launch(
    process.env.EVE_CHROMIUM ? { executablePath: process.env.EVE_CHROMIUM } : {}
  );
}

// Opens `url` with the userscript injected. `server` is a fixture router
// (see server.mjs). Every request is answered by it; nothing reaches the network.
export async function openWithScript(browser, url, server, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const logs = [];
  const errors = [];
  page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => server.handle(route));
  if (options.localStorage) {
    // Seed once per test (not again on reload), before the script runs.
    await context.addInitScript(seed => {
      if (location.host === seed.host && !sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1');
        for (const [k, v] of Object.entries(seed.items)) localStorage.setItem(k, JSON.stringify(v));
      }
    }, { host: new URL(url).host, items: options.localStorage });
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('Runtime.enable');
  let tmContext = null;
  cdp.on('Runtime.executionContextCreated', ({ context: c }) => {
    if (c.name === 'tm' && c.auxData && c.auxData.isDefault === false) {
      tmContext = c.id;
    }
  });
  const source = options.source || (options.instrument === false ? SCRIPT_SOURCE : instrument());
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    worldName: 'tm',
    source:
      gmPrelude({ version: SCRIPT_VERSION, gmStore: options.gmStore }) +
      wrapInSandboxWindow(source)
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const tm = {
    page, context, logs, errors,
    // Evaluate an expression in the userscript's world. Promises are awaited.
    async eval(expression) {
      for (let i = 0; i < 50 && !tmContext; i += 1) await page.waitForTimeout(20);
      const r = await cdp.send('Runtime.evaluate', {
        expression, contextId: tmContext, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error('tm.eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    gm() { return this.eval('JSON.parse(JSON.stringify({store: __gm.store, notifications: __gm.notifications, openedTabs: __gm.openedTabs, windowOpens: __gm.windowOpens, xhr: __gm.xhr}))'); },
    trackerLogs(re = /\[EVE Tracker\]/) { return logs.filter(l => re.test(l)); },
    async waitFor(fn, { timeout = 15000, interval = 100, message = 'condition' } = {}) {
      const until = Date.now() + timeout;
      let last;
      while (Date.now() < until) {
        last = await fn();
        if (last) return last;
        await page.waitForTimeout(interval);
      }
      throw new Error(`timed out after ${timeout} ms waiting for ${message}`);
    },
    // Re-run the script as after a full page reload (Tampermonkey re-injects).
    async reload() {
      tmContext = null;
      await page.reload({ waitUntil: 'domcontentloaded' });
    },
    close: () => context.close()
  };
  return tm;
}
