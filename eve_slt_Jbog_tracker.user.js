// ==UserScript==
// @name         eve_slt_Jbog_tracker
// @namespace    https://github.com/zayd117/EVE-SLT-TRACKER
// @version      2.0.1
// @description  Monitors EVE SLT racks and Lion King tests with in-page and desktop completion alerts.
// @author       Zay Davidson
// @homepageURL  https://github.com/zayd117/EVE-SLT-TRACKER
// @supportURL   https://github.com/zayd117/EVE-SLT-TRACKER/issues
// @match        *://*/out/out.eveslt.php*
// @match        *://*/out/out.evelionking_all.php*
// @match        *://*/slt/list*
// @match        *://*/uut/gpu_jbog_test/list*
// @match        http://hyve-cmd101-ramses.hyvesolutions.org/*
// @run-at       document-start
// @noframes
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @connect      jira.synnex.com
// @connect      testview-eve-fmt.hyvesolutions.org
// @updateURL    https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/eve_slt_Jbog_tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/eve_slt_Jbog_tracker.user.js
// ==/UserScript==

// eve_slt_Jbog_tracker - by Zay Davidson
// Docs, changelog and design notes: https://github.com/zayd117/EVE-SLT-TRACKER
// Every "// ===== SECTION =====" marker below has notes in docs/CODE_NOTES.md.
// Bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues

(function () {
  'use strict';

  // ===== VERSION - single source of truth =====
  const SCRIPT_VERSION =
    typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version
      ? GM_info.script.version
      : '2.0.1';
  const LOG_PREFIX = '[eve_slt_Jbog_tracker]';

  // ===== SOURCE PROFILE =====
  const LION_RAMSES_URL = 'http://hyve-cmd101-ramses.hyvesolutions.org:8001/?dashboard=jbog';
  const IS_LION_RAMSES_PAGE = window.location.origin === new URL(LION_RAMSES_URL).origin &&
    window.location.pathname === '/' && new URLSearchParams(window.location.search).get('dashboard') === 'jbog';
  const IS_LION_KING_PAGE = IS_LION_RAMSES_PAGE || window.location.pathname === '/out/out.evelionking_all.php';
  let lionInitialDocumentComplete = document.readyState !== 'loading';
  const TRACKER_LABEL = 'eve_slt_Jbog_tracker';

  function trackerStorageKey(legacyKey) {
    return IS_LION_KING_PAGE ? legacyKey.replace(/^eveRackTracker/, 'lionKingTracker') : legacyKey;
  }

  // ===== STORAGE KEYS =====
  const SETTINGS_KEY = trackerStorageKey('eveRackTrackerSettings');
  const PREV_STATES_KEY = trackerStorageKey('eveRackTrackerPreviousStates');
  const ACTIVE_ALERTS_KEY = trackerStorageKey('eveRackTrackerActiveAlerts');
  const RECENT_ALERTS_KEY = trackerStorageKey('eveRackTrackerRecentAlerts');
  const ALERT_LOG_KEY = trackerStorageKey('eveRackTrackerAlertLog');
  const LOG_SHIFT_KEY = trackerStorageKey('eveRackTrackerAlertLogDay');
  const LOG_AUTO_SHIFT_KEY = trackerStorageKey('eveRackTrackerAutoShift');
  const LOG_CLEARED_KEY = trackerStorageKey('eveRackTrackerAlertLogClearedAt');
  const ALERTS_COLLAPSED_KEY = trackerStorageKey('eveRackTrackerAlertsCollapsed');
  const PANEL_POSITION_KEY = trackerStorageKey('eveRackTrackerPanelPosition');
  const DEBUG_SNAPSHOT_KEY = trackerStorageKey('eveRackTrackerDebugSnapshot');
  const ALERT_PANEL_POSITION_KEY = trackerStorageKey('eveRackTrackerAlertPanelPosition');
  const JIRA_CACHE_KEY = trackerStorageKey('eveRackTrackerJiraCache');
  const JIRA_ATTENTION_KEY = trackerStorageKey('eveRackTrackerJiraAttention');
  const HEARTBEAT_KEY = trackerStorageKey('eveRackTrackerHeartbeat');
  const EVENT_CLAIMS_KEY = trackerStorageKey('eveRackTrackerEventClaims');

  // ===== STORAGE I/O =====

  function readJSON(store, key, fallback, label) {
    try {
      const saved = store.getItem(key);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      if (label) {
        warn(label + ' load error:', error);
      }
    }
    return fallback;
  }

  // Saved lists can be damaged (edited by hand, cut short): keep only
  // entries that are objects, so one bad entry cannot stop the tracker.
  function isRecordObject(entry) {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry);
  }

  function writeJSON(store, key, value, label) {
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (label) {
        warn(label + ' save error:', error);
      }
      return false;
    }
  }
  const PANEL_MARGIN = 10;
  const PANEL_SNAP_DISTANCE = 35;

  // ===== TUNABLES =====
  const SHIFTS = {
    day: { label: 'Day', start: '06:00', end: '14:30' },
    swing: { label: 'Swing', start: '15:30', end: '00:15' },
    graveyard: { label: 'Graveyard', start: '22:00', end: '06:30' }
  };
  const SHIFT_EARLY_MIN = 60;
  const SHIFT_LATE_MIN = 60;
  const MAX_LOG_ENTRIES = 2000;
  const MAX_STORED_ALERTS = 50;
  const MAX_RENDERED_ALERTS = 200;
  const ALERT_COOLDOWN_MS = 60000;
  const MAX_RECENT_ALERT_KEYS = 500;
  const SOFT_REFRESH_TIMEOUT_MS = 15000;
  const LOG_WRITE_DEBOUNCE_MS = 2000;
  const OBSERVER_DEBOUNCE_MS = 250;
  const MAX_CHRONOLOGICAL_ENTRIES = 500;
  const PRUNE_MIN_RATIO = 0.5;
  const TOAST_INDIVIDUAL_LIMIT = 3;
  const HEALTH_TOAST_MIN_INTERVAL_MS = 300000;
  const BLIND_SCAN_THRESHOLD = 3;
  const EVE_HEADER_PATTERN = /^TA\.([^-]+)-EVE(\d+)/i;
  const REFRESH_INTERVAL_OPTIONS = [30, 20, 10];
  const SITE_TIME_ZONE = 'America/Los_Angeles';
  const DEFAULT_REFRESH_SECONDS = 30;

  // ===== SETTINGS =====
  const defaultSettings = {
    sections: {},
    refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
    notificationTimeoutSeconds: 0,
    developerMode: false,
    jiraBaseUrl: 'https://jira.synnex.com',
    notificationClickTarget: 'jira',
    logShiftChoice: 'auto',
    logShiftOverrideFor: ''
  };

  // ===== RUNTIME STATE =====
  let settings = null;
  let previousStates = new Map();
  let recentAlerts = new Map();
  let scanTimer = null;
  let autoRefreshTimer = null;
  let autoRefreshDueAt = null;
  let softRefreshInFlight = false;
  let softRefreshController = null;
  let softRefreshFailingSince = 0;
  let pageObserver = null;
  let observerSuppressDepth = 0;
  let alertFilter = 'all';
  let alertSearch = '';
  let rackDataAt = 0;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function fail(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function devLog(...args) {
    if (settings && settings.developerMode) {
      console.log(LOG_PREFIX + '[DEV]', ...args);
    }
  }

  // ===== DETECTION HEALTH =====
  let healthState = 'OK';
  let healthDetail = '';
  let lastHealthToastAt = 0;
  let blindScans = 0;

  function reportHealth(state, detail, quiet) {
    const changed = state !== healthState;
    healthState = state;
    healthDetail = detail || '';
    const chip = document.getElementById('eve-health-chip');
    if (chip) {
      chip.textContent = state;
      chip.className = 'eve-health-chip eve-health-' + state.toLowerCase();
      chip.title = healthDetail || 'Detection is healthy.';
    }
    if (!changed) {
      return;
    }
    if (state === 'OK') {
      log('Health: OK \u{2014} detection restored.');
      return;
    }
    fail(`Health: ${state} \u{2014} ${healthDetail}`);
    if (quiet) {
      return;
    }
    const now = Date.now();
    if (now - lastHealthToastAt < HEALTH_TOAST_MIN_INTERVAL_MS) {
      return;
    }
    lastHealthToastAt = now;
    sendDesktopNotification(
      `eve_slt_Jbog_tracker ${state}`,
      `${healthDetail}\nThis page may NOT be monitored.`,
      ICON_FAIL,
      null
    );
  }

  function safeUrl(url) {
    if (!url) {
      return '';
    }
    try {
      const parsed = new URL(url, window.location.href);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : '';
    } catch (error) {
      return '';
    }
  }

  function openExternal(url) {
    const target = safeUrl(url);
    if (!target) {
      warn('Refused to open a non-http(s) URL:', url);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  }

  function openFromNotification(url) {
    const target = safeUrl(url);
    if (!target) {
      return;
    }
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(target, { active: true, insert: true });
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  }

  // ===== TESTVIEW =====
  const TESTVIEW_LIST_URL = 'https://testview-eve-fmt.hyvesolutions.org/slt/list';
  const TESTVIEW_HASH_PARAM = 'eveSn';
  const TESTVIEW_HANDOFF_KEY = 'eveTestViewHandoff';
  const TESTVIEW_HANDOFF_TTL_MS = 2 * 60 * 1000;
  const TESTVIEW_WAIT_MS = 20000;
  const TESTVIEW_POLL_MS = 250;
  const TESTVIEW_API_PATH = '/api/v1/server_level_tests/view';
  const TESTVIEW_DETAIL_PATH = '/slt/testdetail/';
  const TESTVIEW_LOOKUP_TIMEOUT_MS = 8000;
  const TESTVIEW_KEY_MS = 40;
  const TESTVIEW_COMMIT_MS = 700;
  const TESTVIEW_QUIET_MS = 1000;
  const TESTVIEW_LOAD_CAP_MS = 30000;
  const TESTVIEW_RESULT_WAIT_MS = 3000;
  const TESTVIEW_SETTLE_MS = 250;
  const TESTVIEW_MAX_TRIES = 3;

  function buildTestViewUrl(serial) {
    return `${TESTVIEW_LIST_URL}#${TESTVIEW_HASH_PARAM}=${encodeURIComponent(serial)}`;
  }

  function openTestView(serial, opener) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(TESTVIEW_HANDOFF_KEY, JSON.stringify({ serial, ts: Date.now() }));
      }
    } catch (error) {}
    opener(buildTestViewUrl(serial));
  }

  function readTestViewSerial() {
    const match = String(window.location.hash || '').match(
      new RegExp(`[#&]${TESTVIEW_HASH_PARAM}=([^&]+)`)
    );
    let handoff = null;
    try {
      if (typeof GM_getValue === 'function') {
        handoff = JSON.parse(GM_getValue(TESTVIEW_HANDOFF_KEY, 'null'));
      }
      if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(TESTVIEW_HANDOFF_KEY);
      }
    } catch (error) {}
    if (match) {
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (error) {}
      try {
        return decodeURIComponent(match[1]).trim();
      } catch (error) {
        return '';
      }
    }
    if (
      handoff &&
      typeof handoff.serial === 'string' &&
      Date.now() - (Number(handoff.ts) || 0) < TESTVIEW_HANDOFF_TTL_MS
    ) {
      return handoff.serial.trim();
    }
    return '';
  }

  function findTestViewSnInput() {
    const byId = document.getElementById('server_sn');
    if (byId) {
      return byId;
    }
    for (const item of document.querySelectorAll('.ant-form-item')) {
      const label = item.querySelector('label, .ant-form-item-label');
      if (label && /^SN\s*:?$/i.test(label.textContent.trim())) {
        const input = item.querySelector('input');
        if (input) {
          return input;
        }
      }
    }
    return (
      document.querySelector('input[id$="sn" i]') ||
      document.querySelector('input[placeholder*="SN"]') ||
      null
    );
  }

  function findTestViewQueryButton() {
    let fallback = null;
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent.replace(/\s+/g, '').toLowerCase() !== 'query') {
        continue;
      }
      if (button.offsetParent !== null) {
        return button;
      }
      fallback = fallback || button;
    }
    return fallback;
  }

  function clickTestViewButton(button) {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
    button.focus();
    for (const [Ctor, type] of [
      [window.PointerEvent || MouseEvent, 'pointerdown'],
      [MouseEvent, 'mousedown'],
      [window.PointerEvent || MouseEvent, 'pointerup'],
      [MouseEvent, 'mouseup']
    ]) {
      try {
        button.dispatchEvent(new Ctor(type, opts));
      } catch (error) {}
    }
    button.click();
  }

  function testViewIsLoading() {
    for (const spin of document.querySelectorAll('.ant-spin-spinning, .ant-spin-blur')) {
      if (spin.offsetParent !== null) {
        return true;
      }
    }
    const button = findTestViewQueryButton();
    return !!(
      button &&
      (button.disabled ||
        button.classList.contains('ant-btn-loading') ||
        button.getAttribute('aria-busy') === 'true')
    );
  }

  function testViewTableSignature() {
    return Array.from(document.querySelectorAll('.ant-table-tbody tr.ant-table-row'))
      .map(row => (row.firstElementChild ? row.firstElementChild.textContent.trim() : ''))
      .join(',');
  }

  function describeTestViewPage(input) {
    const button = findTestViewQueryButton();
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    return (
      `SN box #${input.id || '?'} = "${input.value}", ` +
      `Query button ${button ? `class="${button.className}"` : 'NOT FOUND'}, ` +
      `inside <form>: ${input.closest('form') ? 'yes' : 'no'}, ` +
      `busy: ${testViewIsLoading()}, rows: ${rows.length}, ` +
      `first row: "${rows.length ? testViewTableSignature().split(',')[0] : '-'}"`
    );
  }

  function triggerTestViewQuery(input, attempt) {
    const form = input.closest('form');
    const keepPage = event => {
      if (form && event.target === form) {
        event.preventDefault();
      }
    };
    window.addEventListener('submit', keepPage);
    try {
      return pressTestViewQuery(input, form, attempt);
    } finally {
      window.removeEventListener('submit', keepPage);
    }
  }

  function pressTestViewQuery(input, form, attempt) {
    if (attempt === 2 && form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return 'form.requestSubmit()';
    }
    const button = findTestViewQueryButton();
    if (button) {
      clickTestViewButton(button);
      return 'Query click';
    }
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', enter));
    input.dispatchEvent(new KeyboardEvent('keyup', enter));
    return 'Enter key';
  }

  function testViewResultsFiltered(serial) {
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    if (!rows.length) {
      return !!document.querySelector('.ant-table-placeholder');
    }
    const want = serial.toUpperCase();
    for (const row of rows) {
      if (row.textContent.toUpperCase().indexOf(want) === -1) {
        return false;
      }
    }
    return true;
  }

  function testViewSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function testViewWaitFor(condition, capMs) {
    const until = Date.now() + capMs;
    while (!condition()) {
      if (Date.now() > until) {
        return false;
      }
      await testViewSleep(TESTVIEW_POLL_MS / 2);
    }
    return true;
  }

  async function testViewWaitQuiet(quietMs, capMs) {
    const until = Date.now() + capMs;
    let idleSince = 0;
    while (Date.now() < until) {
      if (testViewIsLoading()) {
        idleSince = 0;
      } else {
        idleSince = idleSince || Date.now();
        if (Date.now() - idleSince >= quietMs) {
          return true;
        }
      }
      await testViewSleep(TESTVIEW_POLL_MS / 2);
    }
    return false;
  }

  function testViewKey(input, type, ch) {
    input.dispatchEvent(
      new KeyboardEvent(type, {
        key: ch,
        code: /^[a-z]$/i.test(ch) ? `Key${ch.toUpperCase()}` : /^\d$/.test(ch) ? `Digit${ch}` : '',
        keyCode: ch.toUpperCase().charCodeAt(0),
        which: ch.toUpperCase().charCodeAt(0),
        bubbles: true,
        cancelable: true
      })
    );
  }

  function testViewInsert(input, text, inputType) {
    let done = false;
    try {
      done = document.execCommand(inputType === 'insertText' ? 'insertText' : 'delete', false, text);
    } catch (error) {}
    if (done) {
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, inputType === 'insertText' ? input.value + text : '');
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text || null, inputType })
    );
  }

  async function typeIntoTestViewInput(input, value) {
    input.focus();
    input.select();
    if (input.value) {
      testViewInsert(input, '', 'deleteContentBackward');
    }
    for (const ch of value) {
      testViewKey(input, 'keydown', ch);
      testViewKey(input, 'keypress', ch);
      testViewInsert(input, ch, 'insertText');
      testViewKey(input, 'keyup', ch);
      await testViewSleep(TESTVIEW_KEY_MS);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  async function submitTestViewQuery(input, serial) {
    const say = message => console.log(LOG_PREFIX + ` TestView: ${message}`);
    let userTookOver = false;
    const onUserKey = event => {
      if (event.isTrusted) {
        userTookOver = true;
      }
    };
    document.addEventListener('keydown', onUserKey, true);
    try {
      for (let attempt = 1; attempt <= TESTVIEW_MAX_TRIES; attempt += 1) {
        if (!input.isConnected) {
          input = findTestViewSnInput() || input;
        }
        if (attempt === 1) {
          say(`waiting for the page to finish loading. ${describeTestViewPage(input)}`);
        }
        const ready = await testViewWaitQuiet(TESTVIEW_QUIET_MS, TESTVIEW_LOAD_CAP_MS);
        if (userTookOver) {
          say('user is typing; auto-query stopped.');
          return;
        }
        if (!input.isConnected) {
          input = findTestViewSnInput() || input;
        }
        await typeIntoTestViewInput(input, serial);
        say(`try ${attempt}: page ${ready ? 'idle' : 'still busy'}; typed SN, pausing before Query.`);
        await testViewSleep(TESTVIEW_COMMIT_MS);
        await testViewWaitQuiet(TESTVIEW_SETTLE_MS, TESTVIEW_LOAD_CAP_MS);
        if (userTookOver) {
          say('user is typing; auto-query stopped.');
          return;
        }
        if (!input.isConnected || input.value !== serial) {
          say(`try ${attempt}: SN box changed to "${input.value}" before Query; typing again.`);
          continue;
        }
        const before = testViewTableSignature();
        const how = triggerTestViewQuery(input, attempt);
        say(`try ${attempt}: ${how} (page ${ready ? 'was idle' : 'still busy'}); ${describeTestViewPage(input)}`);
        const reacted = await testViewWaitFor(
          () => testViewIsLoading() || testViewTableSignature() !== before,
          TESTVIEW_RESULT_WAIT_MS
        );
        await testViewWaitFor(() => !testViewIsLoading(), TESTVIEW_LOAD_CAP_MS);
        await testViewSleep(TESTVIEW_SETTLE_MS);
        if (testViewResultsFiltered(serial)) {
          say(`results filtered to SN ${serial}.`);
          return;
        }
        if (userTookOver) {
          say('user is typing; auto-query stopped.');
          return;
        }
        say(
          `try ${attempt}: not filtered (${reacted ? 'table reloaded' : 'NO reload after ' + how}); ` +
            describeTestViewPage(input)
        );
      }
      say(`gave up after ${TESTVIEW_MAX_TRIES} tries.`);
      showTestViewBanner(`eve_slt_Jbog_tracker: typed SN ${serial} but the list did not filter. Press Query.`);
    } finally {
      document.removeEventListener('keydown', onUserKey, true);
    }
  }

  function showTestViewBanner(text) {
    try {
      const banner = document.createElement('div');
      banner.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:2147483647;' +
        'max-width:360px;padding:10px 12px;border-radius:8px;' +
        'background:#7f1d1d;color:#fff;border:2px solid #ef4444;' +
        'font:13px Arial,Helvetica,sans-serif;cursor:pointer;';
      banner.textContent = text;
      banner.title = 'Click to dismiss';
      banner.addEventListener('click', () => banner.remove());
      document.body.appendChild(banner);
    } catch (error) {}
  }

  async function lookupTestViewDetailId(serial) {
    const params = new URLSearchParams();
    for (const field of ['id', 'server_sn', 'started']) {
      params.append('fields', field);
    }
    params.append('only_latest_slt', 'true');
    params.append('page_num', '1');
    params.append('page_size', '10');
    params.append('server_sn', serial);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller && controller.abort(), TESTVIEW_LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetch(`${TESTVIEW_API_PATH}?${params}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json();
      const items = (body && body.data && Array.isArray(body.data.items) && body.data.items) || [];
      const want = serial.toUpperCase();
      const matches = items.filter(
        item => item && item.id && String(item.server_sn || '').toUpperCase() === want
      );
      matches.sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
      return matches.length ? String(matches[0].id) : '';
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Is the serial's test running right now (TestView 2.0)? ----
  // PuTTY refuses "ticket <serial>" while a test runs ("The test is still
  // running. No ticket was created."), and TestView counts every step -
  // power off included - as RUNNING. So before telling anyone to raise a
  // ticket by hand, ask TestView (from the rack page: GM_xmlhttpRequest,
  // @connect). Result per serial, cached briefly: true / false / null
  // (unknown - no answer, no login, or no status in the reply).
  const TESTVIEW_STATUS_CACHE_MS = 60 * 1000;
  const MAX_TESTVIEW_STATUS_ENTRIES = 200;
  const testViewStatusCache = new Map();

  function testViewStatusFrom(item) {
    const raw = item && (item.status || item.test_status || item.slt_status || item.state);
    return raw ? String(raw) : '';
  }

  // The TestView 2.0 page of the serial's latest run, if known.
  function testViewRunUrl(serial) {
    if (IS_LION_KING_PAGE) return buildLionKingTestViewUrl(serial, '');
    const hit = testViewStatusCache.get(serial);
    return hit && /^\d+$/.test(hit.id || '')
      ? `${new URL(TESTVIEW_LIST_URL).origin}${TESTVIEW_DETAIL_PATH}${hit.id}`
      : '';
  }

  function testViewRunningCached(serial) {
    if (IS_LION_KING_PAGE) return lionKingRunningOnPage(serial);
    const hit = testViewStatusCache.get(serial);
    return hit ? hit.running : null;
  }

  function testViewRunning(serial) {
    if (IS_LION_KING_PAGE) return Promise.resolve(lionKingRunningOnPage(serial));
    const hit = testViewStatusCache.get(serial);
    if (hit && Date.now() - hit.at < TESTVIEW_STATUS_CACHE_MS) {
      return hit.promise || Promise.resolve(hit.running);
    }
    const params = new URLSearchParams();
    for (const field of ['id', 'server_sn', 'started', 'status']) {
      params.append('fields', field);
    }
    params.append('only_latest_slt', 'true');
    params.append('page_num', '1');
    params.append('page_size', '10');
    params.append('server_sn', serial);
    const url = `${new URL(TESTVIEW_LIST_URL).origin}${TESTVIEW_API_PATH}?${params}`;
    const entry = { at: Date.now(), running: hit ? hit.running : null, id: hit ? hit.id : '' };
    entry.promise = new Promise(resolve => {
      const done = running => {
        entry.running = running;
        entry.promise = null;
        resolve(running);
      };
      if (typeof GM_xmlhttpRequest !== 'function') {
        done(null);
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: { Accept: 'application/json' },
          timeout: TESTVIEW_LOOKUP_TIMEOUT_MS,
          onload: response => {
            try {
              if (response.status !== 200) {
                done(null);
                return;
              }
              const body = JSON.parse(response.responseText || 'null');
              const items = (body && body.data && Array.isArray(body.data.items) && body.data.items) || [];
              const want = serial.toUpperCase();
              const matches = items.filter(
                item => item && String(item.server_sn || '').toUpperCase() === want
              );
              matches.sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
              const status = matches.length ? testViewStatusFrom(matches[0]) : '';
              entry.id = matches.length && matches[0].id ? String(matches[0].id) : '';
              done(status ? /running|in[ _-]?progress/i.test(status) : null);
            } catch (error) {
              done(null);
            }
          },
          onerror: () => done(null),
          onabort: () => done(null),
          ontimeout: () => done(null)
        });
      } catch (error) {
        done(null);
      }
    });
    testViewStatusCache.delete(serial);
    testViewStatusCache.set(serial, entry);
    while (testViewStatusCache.size > MAX_TESTVIEW_STATUS_ENTRIES) {
      testViewStatusCache.delete(testViewStatusCache.keys().next().value);
    }
    return entry.promise;
  }

  function isTestViewOrigin() {
    try {
      return window.location.origin === new URL(TESTVIEW_LIST_URL).origin;
    } catch (error) {
      return false;
    }
  }

  function runTestViewAutoQuery() {
    if (!isTestViewOrigin()) {
      return;
    }
    const serial = readTestViewSerial();
    if (!serial) {
      return;
    }
    lookupTestViewDetailId(serial)
      .then(id => {
        if (/^\d+$/.test(id)) {
          console.log(LOG_PREFIX + ` TestView: SN ${serial} is test ${id}; opening its detail page.`);
          window.location.replace(TESTVIEW_DETAIL_PATH + id);
          return;
        }
        console.log(LOG_PREFIX + ` TestView: no test found for SN ${serial}; querying the list.`);
        startTestViewListQuery(serial);
      })
      .catch(error => {
        console.warn(LOG_PREFIX + ' TestView: detail lookup failed; querying the list.', error);
        startTestViewListQuery(serial);
      });
  }

  function startTestViewListQuery(serial) {
    const startedAt = Date.now();
    let done = false;
    let observer = null;
    let timer = 0;
    const finish = () => {
      done = true;
      if (observer) {
        observer.disconnect();
      }
      clearInterval(timer);
    };
    const attempt = () => {
      if (done) {
        return;
      }
      const input = findTestViewSnInput();
      if (!input) {
        if (Date.now() - startedAt > TESTVIEW_WAIT_MS) {
          finish();
          console.warn(LOG_PREFIX + ' TestView: SN input not found; auto-query skipped.');
          showTestViewBanner(`eve_slt_Jbog_tracker: could not auto-fill SN ${serial}. Enter it manually.`);
        }
        return;
      }
      finish();
      submitTestViewQuery(input, serial).catch(error => {
        console.error(LOG_PREFIX + ' TestView: auto-query crashed:', error);
        showTestViewBanner(`eve_slt_Jbog_tracker: auto-query failed (${error && error.message}). Press Query.`);
      });
    };
    observer = new MutationObserver(attempt);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timer = setInterval(attempt, TESTVIEW_POLL_MS);
    attempt();
  }

  // ===== JIRA =====
  const JIRA_DEFAULT_BASE_URL = 'https://jira.synnex.com';
  const JIRA_FOUND_TTL_MS = 10 * 60 * 1000;
  const JIRA_MISS_TTL_MS = 3 * 60 * 1000;
  const JIRA_AUTH_PAUSE_MS = 2 * 60 * 1000;
  const JIRA_TIMEOUT_MS = 15000;
  const JIRA_MAX_CONCURRENT = 2;
  const JIRA_MAX_CACHE = 300;
  const JIRA_RESOLVE_WAIT_MS = 6000;
  const JIRA_TICKET_LEAD_MS = 5 * 60 * 1000;
  const JIRA_TICKET_USUAL_MIN = 5;
  const JIRA_TICKET_USUAL_MAX = 10;
  const JIRA_TICKET_EXPECT_MS = 20 * 60 * 1000;
  // After this long with no ticket, the Jira bot has had its chance: the
  // no-ticket page (any failure) says how to raise one by hand, and a
  // pre-test chip says "No ticket (create one)". Display only - lookups
  // continue as before.
  const JIRA_CREATE_BY_HAND_MS = 15 * 60 * 1000;
  const JIRA_TICKET_LATE_MS = 2 * 60 * 60 * 1000;
  // Attention marks (green "new ticket", gold pre-test "create one") are
  // remembered per failure so a page reload never re-fires or drops them.
  const JIRA_ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;
  const JIRA_PENDING_STATES = ['waiting', 'noticket', 'none'];
  // After the first hover, attention effects stay this long, then go.
  const JIRA_HOVER_FADE_MS = 10 * 1000;
  // The green "new ticket" mark goes quicker once seen.
  const JIRA_NEW_FADE_MS = 3 * 1000;
  const JIRA_PEAK_POLL_MS = 30 * 1000;
  const JIRA_PENDING_POLL_MS = 60 * 1000;
  const JIRA_LATE_POLL_MS = 5 * 60 * 1000;
  const JIRA_TAB_POLL_MS = 15 * 1000;
  const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

  // Card chip text for a ticket: "JIRA - 587632" says where the click goes;
  // the project prefix (MFGS) means nothing to most readers. Display only -
  // the tooltip, link and search keep the real key.
  function jiraChipText(key) {
    return `JIRA - ${String(key).split('-').pop()}`;
  }
  const JIRA_ICON_SVG =
    '<svg class="eve-jira-ext" width="12" height="12" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 4h6v6"/><path d="M20 4 10 14"/>' +
    '<path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>' +
    '</svg>';
  let jiraCache = null;
  const jiraInFlight = new Map();
  const jiraQueue = [];
  let jiraActive = 0;
  let jiraAuthPausedUntil = 0;
  let jiraNeedsLogin = false;
  let jiraConnected = false;

  function jiraBaseUrl() {
    const raw = String((settings && settings.jiraBaseUrl) || JIRA_DEFAULT_BASE_URL)
      .trim()
      .replace(/\/+$/, '');
    return /^https?:\/\/[^\s/]+/i.test(raw) && safeUrl(raw) ? raw : JIRA_DEFAULT_BASE_URL;
  }

  function jiraSerialKey(serial) {
    return String(serial || '')
      .trim()
      .toUpperCase();
  }

  function jiraJql(serial) {
    const escaped = String(serial || '')
      .trim()
      .replace(/["\\]/g, '\\$&');
    return `text ~ "${escaped}"`;
  }

  function jiraFailedAt(record) {
    if (!record || isDebugData(record)) {
      return 0;
    }
    const meta = transitionMeta(record.transition);
    return meta && meta.failure ? Number(record.ts) || 0 : 0;
  }

  function jiraIsPretest(record) {
    return !!record && record.transition === 'PRETEST_FAILURE';
  }

  function isPassResult(record) {
    const meta = record ? transitionMeta(record.transition) : null;
    return !!meta && !meta.failure && !meta.diagnostic;
  }

  function jiraExpecting(failedAt) {
    return !!failedAt && Date.now() - failedAt < JIRA_TICKET_EXPECT_MS;
  }

  function jiraStillChecking(failedAt) {
    return !!failedAt && Date.now() - failedAt < JIRA_TICKET_LATE_MS;
  }

  function jiraMinutesSince(failedAt) {
    return Math.max(0, Math.floor((Date.now() - failedAt) / 60000));
  }

  function jiraUsualText(failedAt) {
    const minutes = jiraMinutesSince(failedAt);
    return (
      `Tickets usually appear ${JIRA_TICKET_USUAL_MIN}\u{2013}` +
      `${JIRA_TICKET_USUAL_MAX} min after a fail (sometimes sooner or ` +
      'later) \u{2014} this one failed ' +
      (minutes < 1 ? 'under a minute ago.' : `${minutes} min ago.`)
    );
  }

  function jiraLookupKey(serial, failedAt) {
    const id = jiraSerialKey(serial);
    // Lion King board timestamps are detection times, not ticket creation
    // times. Separate this unrestricted lookup from earlier filtered misses.
    if (IS_LION_KING_PAGE) return id ? `${id}@lion-latest` : '';
    return id && failedAt ? `${id}@${failedAt}` : id;
  }

  function jiraOrderedJql(serial, failedAt) {
    if (IS_LION_KING_PAGE || !failedAt) {
      return jiraJql(serial) + ' ORDER BY updated DESC';
    }
    const minutes = Math.max(1, Math.ceil((Date.now() - failedAt + JIRA_TICKET_LEAD_MS) / 60000));
    return jiraJql(serial) + ` AND created >= -${minutes}m ORDER BY created DESC`;
  }
  const JIRA_LIST_ORDER = {
    updated: 'ORDER BY updated DESC',
    created: 'ORDER BY created DESC, updated DESC'
  };

  function jiraListUrl(serial, order, key) {
    const jql = `${jiraJql(serial)} ` + (JIRA_LIST_ORDER[order] || JIRA_LIST_ORDER.updated);
    const page =
      key && JIRA_KEY_PATTERN.test(String(key)) ? `/browse/${encodeURIComponent(key)}` : '/issues/';
    return `${jiraBaseUrl()}${page}?jql=${encodeURIComponent(jql)}`;
  }

  function jiraLatestKey(serial) {
    const hit = jiraCached(serial, 0);
    return hit && hit.state === 'found' && JIRA_KEY_PATTERN.test(String(hit.key)) ? hit.key : '';
  }

  function jiraSearchUrl(serial, failedAt) {
    return jiraListUrl(serial, !IS_LION_KING_PAGE && failedAt ? 'created' : 'updated', jiraLatestKey(serial));
  }

  function jiraIssueUrl(key) {
    return `${jiraBaseUrl()}/browse/${encodeURIComponent(key)}`;
  }

  function jiraFoundUrl(serial, failedAt) {
    const hit = jiraCached(serial, failedAt);
    if (!hit || hit.state !== 'found' || !JIRA_KEY_PATTERN.test(String(hit.key))) return '';
    // A cached JBOG ticket may be old; keep the serial's latest activity visible.
    return IS_LION_KING_PAGE ? jiraListUrl(serial, 'updated', hit.key) : jiraIssueUrl(hit.key);
  }

  function jiraUrlFor(serial, failedAt) {
    return jiraFoundUrl(serial, failedAt || 0) || jiraSearchUrl(serial, failedAt || 0);
  }

  function jiraKnownUrl(serial, failedAt) {
    if (failedAt) {
      return jiraFoundUrl(serial, failedAt);
    }
    return jiraIsFresh(jiraCached(serial, 0)) ? jiraFoundUrl(serial, 0) : '';
  }

  function jiraCardResult(serial, failedAt) {
    const hit = jiraCached(serial, failedAt || 0);
    if (!IS_LION_KING_PAGE && failedAt && hit && hit.state === 'none') {
      return { ...hit, state: jiraExpecting(failedAt) ? 'waiting' : 'noticket' };
    }
    return hit;
  }

  function jiraWithin(promise, ms) {
    return Promise.race([
      Promise.resolve(promise).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
  }

  async function resolveJiraUrl(serial, failedAt) {
    const at = failedAt || 0;
    const known = jiraKnownUrl(serial, at);
    if (known || !jiraLookupAvailable()) {
      return known || jiraUrlFor(serial, at);
    }
    await jiraWithin(lookupJira(serial, false, at), JIRA_RESOLVE_WAIT_MS);
    return jiraUrlFor(serial, at);
  }

  async function resolveJiraListUrl(serial, order) {
    if (!jiraLatestKey(serial) && jiraLookupAvailable()) {
      await jiraWithin(lookupJira(serial, false, 0), JIRA_RESOLVE_WAIT_MS);
    }
    return jiraListUrl(serial, order, jiraLatestKey(serial));
  }

  function loadJiraCache() {
    if (!jiraCache) {
      const saved = readJSON(sessionStorage, JIRA_CACHE_KEY, null, null);
      jiraCache = new Map(
        Array.isArray(saved)
          ? saved.filter(
              entry =>
                Array.isArray(entry) &&
                entry.length === 2 &&
                typeof entry[0] === 'string' &&
                entry[1] &&
                typeof entry[1] === 'object'
            )
          : []
      );
    }
    return jiraCache;
  }

  function saveJiraCache() {
    writeJSON(sessionStorage, JIRA_CACHE_KEY, Array.from(loadJiraCache()), null);
  }

  function jiraCached(serial, failedAt) {
    return loadJiraCache().get(jiraLookupKey(serial, failedAt || 0)) || null;
  }

  function jiraIsFresh(entry) {
    if (!entry) {
      return false;
    }
    const ttl =
      entry.state === 'found'
        ? JIRA_FOUND_TTL_MS
        : entry.failure
          ? JIRA_PENDING_POLL_MS
          : JIRA_MISS_TTL_MS;
    return Date.now() - Number(entry.at || 0) < ttl;
  }

  function storeJiraResult(id, result) {
    const cache = loadJiraCache();
    cache.delete(id);
    cache.set(id, result);
    while (cache.size > JIRA_MAX_CACHE) {
      cache.delete(cache.keys().next().value);
    }
    saveJiraCache();
  }

  function jiraLookupAvailable() {
    return typeof GM_xmlhttpRequest === 'function';
  }

  function parseJiraResponse(response) {
    const status = Number(response && response.status) || 0;
    if (status === 401 || status === 403) {
      return { state: 'auth', reason: `HTTP ${status}` };
    }
    if (status < 200 || status >= 300) {
      return { state: 'error', reason: `HTTP ${status}` };
    }
    let data = null;
    try {
      data = JSON.parse(response.responseText);
    } catch (error) {
      data = null;
    }
    if (!data || !Array.isArray(data.issues)) {
      return { state: 'auth', reason: 'Jira returned a login page' };
    }
    const issues = data.issues.filter(issue => issue && JIRA_KEY_PATTERN.test(String(issue.key)));
    if (!issues.length) {
      return { state: 'none', count: 0 };
    }
    const top = issues[0];
    const fields = top.fields || {};
    const status_ = fields.status || {};
    return {
      state: 'found',
      key: String(top.key),
      status: String(status_.name || ''),
      category: String((status_.statusCategory && status_.statusCategory.key) || '').replace(
        /[^a-z-]/gi,
        ''
      ),
      summary: String(fields.summary || '').slice(0, 200),
      created: String(fields.created || '').slice(0, 40),
      count: Math.max(Number(data.total) || 0, issues.length)
    };
  }

  function requestJira(serial, failedAt) {
    return new Promise(resolve => {
      const done = result => resolve({ ...result, at: Date.now(), failure: !IS_LION_KING_PAGE && !!failedAt });
      const url =
        `${jiraBaseUrl()}/rest/api/2/search?jql=` +
        encodeURIComponent(jiraOrderedJql(serial, failedAt || 0)) +
        '&fields=summary,status,created&maxResults=1';
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: { Accept: 'application/json' },
          timeout: JIRA_TIMEOUT_MS,
          onload: response => done(parseJiraResponse(response)),
          onerror: () => done({ state: 'error', reason: 'network error' }),
          onabort: () => done({ state: 'error', reason: 'aborted' }),
          ontimeout: () => done({ state: 'error', reason: 'timed out' })
        });
      } catch (error) {
        done({
          state: 'error',
          reason: String((error && error.message) || error)
        });
      }
    });
  }

  function lookupJira(serial, force, failedAt) {
    const at = failedAt || 0;
    const id = jiraLookupKey(serial, at);
    if (!id || !jiraLookupAvailable()) {
      return Promise.resolve(null);
    }
    const cached = jiraCached(serial, at);
    if (!force && jiraIsFresh(cached)) {
      return Promise.resolve(cached);
    }
    if (Date.now() < jiraAuthPausedUntil) {
      return Promise.resolve({ state: 'auth', reason: 'waiting for Jira login' });
    }
    if (jiraInFlight.has(id)) {
      return jiraInFlight.get(id);
    }
    const promise = new Promise(resolve => {
      jiraQueue.push({
        id: id,
        serial: String(serial).trim(),
        failedAt: at,
        resolve: resolve
      });
      pumpJiraQueue();
    }).then(result => {
      jiraInFlight.delete(id);
      return result;
    });
    jiraInFlight.set(id, promise);
    return promise;
  }

  function pumpJiraQueue() {
    while (jiraActive < JIRA_MAX_CONCURRENT && jiraQueue.length) {
      const job = jiraQueue.shift();
      jiraActive += 1;
      const run =
        Date.now() < jiraAuthPausedUntil
          ? Promise.resolve({
              state: 'auth',
              reason: 'waiting for Jira login',
              at: Date.now()
            })
          : requestJira(job.serial, job.failedAt);
      run
        .then(result => {
          if (result.state === 'found' || result.state === 'none') {
            storeJiraResult(job.id, result);
          } else if (result.state === 'auth') {
            if (!jiraNeedsLogin) {
              log(
                'Jira ticket lookup paused \u{2014} this browser is ' +
                  'not logged in to Jira. Log in once; lookups ' +
                  'resume when you come back to this tab.'
              );
            }
            jiraAuthPausedUntil = Date.now() + JIRA_AUTH_PAUSE_MS;
          } else {
            devLog(`Jira lookup for ${job.serial} failed:`, result.reason);
          }
          setJiraBadge(result.state);
          job.resolve(result);
        })
        .catch(error => {
          fail('Jira lookup threw:', error);
          job.resolve({ state: 'error', reason: 'internal error' });
        })
        .finally(() => {
          jiraActive -= 1;
          pumpJiraQueue();
        });
    }
  }

  function setJiraBadge(state) {
    if (state === 'found' || state === 'none') {
      jiraConnected = true;
      jiraNeedsLogin = false;
    } else if (state === 'auth') {
      jiraConnected = false;
      jiraNeedsLogin = true;
    }
    const badge = document.getElementById('eve-jira-badge');
    if (!badge) {
      return;
    }
    let text = '';
    let cls = '';
    if (typeof GM_xmlhttpRequest !== 'function') {
      text = 'NO ACCESS';
      cls = 'eve-badge-off';
    } else if (jiraNeedsLogin) {
      text = 'LOG IN';
      cls = 'eve-badge-soon';
    } else if (jiraConnected) {
      text = 'CONNECTED';
      cls = 'eve-badge-on';
    }
    setTextIfChanged(badge, text);
    setClassIfChanged(badge, `eve-summary-badge ${cls}`.trim());
    badge.style.display = text ? '' : 'none';
  }

  function jiraTimeText(value) {
    const time = Date.parse(String(value || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
    return Number.isFinite(time) ? new Date(time).toLocaleTimeString() : '';
  }

  function paintJiraButton(button, serial, result, loading) {
    const label = button.querySelector('.eve-jira-label');
    if (result && result.state === 'passed') {
      setClassIfChanged(button, 'eve-alert-jira eve-jira-passed');
      button.removeAttribute('href');
      button.title = `${serial} passed \u{2014} passes do not get a Jira ticket.`;
      button.setAttribute('aria-label', `${serial} passed, no Jira ticket needed`);
      setTextIfChanged(label, 'PASSED (no ticket)');
      syncJiraExtras(button, result, false);
      return;
    }
    button.setAttribute('aria-label', `Open ${serial} in Jira`);
    const failedAt = Number(button.dataset.failedAt) || 0;
    const pretest = button.dataset.pretest === '1';
    if (
      pretest &&
      result &&
      result.state === 'waiting' &&
      failedAt &&
      Date.now() - failedAt >= JIRA_CREATE_BY_HAND_MS
    ) {
      result = { ...result, state: 'noticket' };
    }
    let cls = 'eve-alert-jira';
    let text = 'Jira';
    let tip = `Search Jira for ${serial}`;
    if (loading) {
      cls += ' eve-jira-loading';
      tip = `Looking up ${serial} in Jira\u{2026} (click to search now)`;
    } else if (result && result.state === 'found' && JIRA_KEY_PATTERN.test(String(result.key))) {
      const count = Number(result.count) || 1;
      cls += ' eve-jira-found';
      if (result.category) {
        cls += ` eve-jira-cat-${String(result.category).replace(/[^a-z-]/gi, '')}`;
      }
      const created = jiraTimeText(result.created);
      text = jiraChipText(result.key);
      tip =
        result.key +
        (result.status ? ` \u{b7} ${result.status}` : '') +
        (result.summary ? `\n${result.summary}` : '') +
        (failedAt
          ? `\nRaised for this failure${created ? ` at ${created}` : ''}` +
            (count > 1 ? ` (newest of ${count})` : '')
          : count > 1
            ? `\nMost recently updated of ${count} tickets for ${serial}`
            : '') +
        (IS_LION_KING_PAGE
          ? '\nClick to search all tickets for this serial, most recently updated first'
          : '\nClick to open in Jira');
    } else if (result && result.state === 'waiting') {
      cls += ' eve-jira-waiting';
      text = pretest ? 'No ticket yet' : 'Ticket pending';
      tip =
        (pretest
          ? 'No Jira ticket for this pre-test fail yet. Pre-test ' +
            'fails often never get one, but the Jira bot sometimes ' +
            'raises one.'
          : 'The Jira bot has not raised the ticket for this ' + 'failure yet.') +
        `\n${jiraUsualText(failedAt)}` +
        '\nChecking regularly \u{2014} click to open it the moment it ' +
        'exists, or to search Jira.' +
        (failedAt ? `\n${jiraPuttyTip(serial, failedAt)}` : '');
    } else if (result && result.state === 'noticket') {
      cls += ' eve-jira-noticket';
      // Pre-test fails do not get a ticket automatically: say what to do,
      // with a tracing yellow outline until acknowledged (hover + 10 s).
      const testRunning = testViewRunningCached(serial) === true;
      text = pretest ? (testRunning ? 'No ticket (re-testing)' : 'No ticket (create one)') : 'No ticket';
      if (pretest && !testRunning && !jiraAttentionSeen(serial, failedAt, 'attn')) {
        cls += ' eve-jira-attn';
      }
      // Keep TestView's answer fresh (cached 60 s); repaint if it changed.
      const painted = result;
      testViewRunning(serial).then(now => {
        if (now !== null && now !== testRunning && button.isConnected) {
          paintJiraButton(button, serial, painted);
        }
      });
      tip =
        `${jiraPuttyTip(serial, failedAt)}\n` +
        (pretest ? 'Pre-test fails often get no ticket automatically. ' : '') +
        (jiraStillChecking(failedAt)
          ? 'Still checking Jira every few minutes until ' +
            `${new Date(failedAt + JIRA_TICKET_LATE_MS).toLocaleTimeString()} ` +
            'in case one is raised late.'
          : '') +
        '\nClick for the PuTTY command and the Jira searches.';
    } else if (result && result.state === 'none') {
      cls += ' eve-jira-none';
      if (IS_LION_KING_PAGE) text = 'Search Jira';
      tip =
        `No Jira ticket mentions ${serial} yet \u{2014} click to ` + 'search Jira (newest first)';
    } else if (result && result.state === 'auth') {
      cls += ' eve-jira-auth';
      tip =
        'Log in to Jira in this browser to see the ticket here ' + '\u{2014} click to open Jira';
    } else if (result && result.state === 'error') {
      tip = `Jira lookup failed (${result.reason || 'unknown'}) ` + '\u{2014} click to search Jira';
    }
    setClassIfChanged(button, cls);
    button.href = jiraUrlFor(serial, failedAt);
    button.title = tip;
    if (label) {
      setTextIfChanged(label, text);
    }
    syncJiraExtras(button, result, loading);
  }

  // Copy control and "new ticket" badge. Both hang off the paint, which runs
  // on every lookup / rescan / card update, so they must be idempotent: the
  // badge fires only on a real no-ticket -> ticket change of THIS chip (not
  // a repaint, not the same key again, not a card that was found at first
  // look), and there is never more than one of either element.
  function syncJiraExtras(button, result, loading) {
    const found =
      !loading && !!result && result.state === 'found' && JIRA_KEY_PATTERN.test(String(result.key));
    const copy = button.parentElement
      ? button.parentElement.querySelector('.eve-jira-copy')
      : null;
    if (copy) {
      copy.hidden = !found;
      const link = found
        ? (IS_LION_KING_PAGE ? jiraListUrl(button.dataset.serial || '', 'updated', result.key) : jiraIssueUrl(result.key))
        : '';
      if (found && copy.dataset.link !== link) {
        copy.dataset.link = link;
        copy.title = `Copy link: ${link}`;
        copy.setAttribute('aria-label', IS_LION_KING_PAGE
          ? `Copy Jira search for ${button.dataset.serial}, most recently updated first`
          : `Copy link to Jira ticket ${result.key}`);
      }
    }
    if (!loading && result && JIRA_PENDING_STATES.indexOf(result.state) !== -1) {
      button.dataset.wasPending = '1';
    }
    const serial = button.dataset.serial || '';
    const failedAt = Number(button.dataset.failedAt) || 0;
    if (found && button.dataset.noticedKey !== result.key) {
      if (button.dataset.wasPending === '1') {
        // A real no-ticket -> ticket change seen by this chip: remember it,
        // so it survives reloads until acknowledged.
        setJiraAttention(serial, failedAt, 'new', { state: 'new', key: result.key });
      }
      button.dataset.noticedKey = result.key;
      button.dataset.wasPending = '';
    }
    const mark = found ? jiraAttention(serial, failedAt, 'new') : null;
    const badge = button.querySelector('.eve-jira-new');
    if (mark && mark.state === 'new' && mark.key === result.key) {
      showJiraNewBadge(button, result.key);
    } else if (badge && (!found || (mark && mark.state === 'seen'))) {
      clearJiraNewBadge(badge);
    }
    // The paint rewrites the chip's class list; keep the glow with the badge.
    button.classList.toggle('eve-jira-fresh', !!button.querySelector('.eve-jira-new'));
  }

  // ---- attention marks, per failure (serial + failure time), all tabs ----
  function jiraAttentionId(serial, failedAt, kind) {
    return `${serial}|${failedAt}|${kind}`;
  }

  function readJiraAttention() {
    const map = readJSON(localStorage, JIRA_ATTENTION_KEY, {}, 'Jira attention marks');
    return map && typeof map === 'object' ? map : {};
  }

  function jiraAttention(serial, failedAt, kind) {
    if (!serial || !failedAt) {
      return null;
    }
    return readJiraAttention()[jiraAttentionId(serial, failedAt, kind)] || null;
  }

  function jiraAttentionSeen(serial, failedAt, kind) {
    const mark = jiraAttention(serial, failedAt, kind);
    return !!mark && mark.state === 'seen';
  }

  function setJiraAttention(serial, failedAt, kind, mark) {
    if (!serial || !failedAt) {
      return;
    }
    const map = readJiraAttention();
    const now = Date.now();
    Object.keys(map).forEach(id => {
      if (!map[id] || now - (Number(map[id].at) || 0) > JIRA_ATTENTION_TTL_MS) {
        delete map[id];
      }
    });
    map[jiraAttentionId(serial, failedAt, kind)] = { ...mark, at: now };
    writeJSON(localStorage, JIRA_ATTENTION_KEY, map, 'Jira attention marks');
  }

  function clearJiraNewBadge(badge) {
    if (!badge.isConnected) {
      return;
    }
    const chip = badge.parentElement;
    badge.remove();
    if (chip) {
      chip.classList.remove('eve-jira-fresh');
    }
  }

  function showJiraNewBadge(button, key) {
    if (button.querySelector('.eve-jira-new')) {
      return;
    }
    const badge = document.createElement('span');
    badge.className = 'eve-jira-new';
    badge.textContent = '!';
    badge.title = `New: ${key} was just raised for this failure`;
    badge.setAttribute('aria-label', `New Jira ticket ${key}`);
    button.appendChild(badge);
    button.classList.add('eve-jira-fresh');
    devLog(`${key} marked as new on its card until acknowledged.`);
  }

  function buildJiraButton(serial) {
    const button = document.createElement('a');
    button.className = 'eve-alert-jira';
    button.dataset.serial = serial;
    button.target = '_blank';
    button.rel = 'noopener noreferrer';
    button.innerHTML =
      '<span class="eve-jira-dot" aria-hidden="true"></span>' +
      '<span class="eve-jira-label">Jira</span>' +
      JIRA_ICON_SVG;
    // First hover acknowledges the "new ticket" glow and the pre-test
    // outline; each fades JIRA_HOVER_FADE_MS later (armed once, not per hover).
    // Acknowledged for good (stored): neither comes back after a reload.
    button.addEventListener('mouseenter', () => {
      const failedAt = Number(button.dataset.failedAt) || 0;
      const badge = button.querySelector('.eve-jira-new');
      if (badge && !badge.dataset.hovered) {
        badge.dataset.hovered = '1';
        setTimeout(() => {
          setJiraAttention(serial, failedAt, 'new', { state: 'seen' });
          clearJiraNewBadge(badge);
        }, JIRA_NEW_FADE_MS);
      }
      if (button.classList.contains('eve-jira-attn') && !button.dataset.attnArmed) {
        button.dataset.attnArmed = '1';
        setTimeout(() => {
          setJiraAttention(serial, failedAt, 'attn', { state: 'seen' });
          button.classList.remove('eve-jira-attn');
        }, JIRA_HOVER_FADE_MS);
      }
    });
    button.addEventListener('click', event => {
      if (button.dataset.passed === '1') {
        event.preventDefault();
        return;
      }
      const at = Number(button.dataset.failedAt) || 0;
      const known = jiraKnownUrl(serial, at);
      button.href = known || jiraUrlFor(serial, at);
      if (
        known ||
        !jiraLookupAvailable() ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const tab = window.open('about:blank', '_blank');
      if (!tab) {
        return;
      }
      event.preventDefault();
      try {
        tab.opener = null;
      } catch (error) {}
      writeJiraTab(tab, 'Jira\u{2026}', [`Finding the Jira ticket for ${serial}\u{2026}`]);
      const current = jiraCardResult(serial, at);
      if (!current) {
        paintJiraButton(button, serial, current, true);
      }
      followJiraInTab(tab, serial, at, button.dataset.pretest === '1').then(() => {
        if (!button.isConnected) {
          return;
        }
        const shown = jiraCardResult(serial, at);
        paintJiraButton(button, serial, shown);
        const card = button.closest('.eve-alert');
        if (card) {
          indexJiraKey(card, shown);
        }
      });
    });
    return button;
  }
  const JIRA_COPY_IDLE = '\u{29c9}';

  // Chip + copy control, built once per card. The copy control copies the
  // ticket's full Jira link and stays hidden until the chip shows a real
  // ticket (syncJiraExtras).
  function buildJiraGroup(serial) {
    const group = document.createElement('span');
    group.className = 'eve-jira-group';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'eve-jira-copy';
    copy.hidden = true;
    copy.innerHTML = `<span class="eve-alert-copy-hint">${JIRA_COPY_IDLE}</span>`;
    copy.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (copy.dataset.link) {
        copyToClipboard(copy.dataset.link, copy, JIRA_COPY_IDLE);
      }
    });
    group.appendChild(buildJiraButton(serial));
    group.appendChild(copy);
    return group;
  }
  const JIRA_TAB_CSS =
    '.eve-opts{display:grid;gap:10px;margin-top:22px;}' +
    '.eve-opt{display:block;padding:12px 16px;border-radius:10px;' +
    'border:1px solid rgba(76,154,255,.18);background:rgba(38,132,255,.04);' +
    'text-decoration:none;outline:none;' +
    'transition:background .18s ease,border-color .18s ease,' +
    'box-shadow .18s ease,transform .18s ease;}' +
    '.eve-opt-label{color:#7f9cc4;font-size:15px;font-weight:600;' +
    'transition:color .18s ease;}' +
    '.eve-opt-note{color:#6b7078;font-size:12.5px;margin-top:2px;' +
    'transition:color .18s ease;}' +
    '.eve-opt:hover,.eve-opt:focus-visible{background:rgba(38,132,255,.2);' +
    'border-color:rgba(76,154,255,.75);' +
    'box-shadow:0 0 0 1px rgba(76,154,255,.25),0 6px 20px rgba(12,102,228,.25);}' +
    '.eve-opt:hover .eve-opt-label,.eve-opt:focus-visible .eve-opt-label{color:#dbe9ff;}' +
    '.eve-opt:hover .eve-opt-note,.eve-opt:focus-visible .eve-opt-note{color:#b9c0c9;}' +
    '.eve-opt:active{background:rgba(38,132,255,.05);border-color:rgba(76,154,255,.3);' +
    'box-shadow:none;transform:scale(.99);transition-duration:.05s;}' +
    '.eve-opt:active .eve-opt-label{color:#8aa9d4;transition-duration:.05s;}' +
    '.eve-opt:active .eve-opt-note{color:#7a8089;transition-duration:.05s;}' +
    '.eve-howto{margin-top:18px;padding:12px 16px;border-radius:10px;' +
    'border:1px solid rgba(250,204,21,.45);background:rgba(250,204,21,.07);color:#e8eaed;}' +
    '.eve-howto-row{display:flex;align-items:center;gap:10px;margin-top:8px;}' +
    '.eve-howto code{font:600 15px Consolas,monospace;color:#fde68a;background:#0f1013;' +
    'padding:4px 10px;border-radius:6px;user-select:all;}' +
    '.eve-howto-note{margin-top:10px;color:#b9c0c9;font-size:13px;}' +
    '.eve-howto-plain .eve-howto-row{display:inline;}' +
    '.eve-howto-link{margin-top:6px;}.eve-howto-link a{color:#7f9cc4;}' +
    '.eve-howto-link a:hover{color:#dbe9ff;}' +
    '.eve-howto-plain .eve-howto-cmd{font:600 13px Consolas,monospace;color:#e8eaed;' +
    'background:#0f1013;border:1px solid rgba(255,255,255,.14);border-radius:5px;' +
    'padding:1px 7px;user-select:all;}' +
    '.eve-howto-plain button{margin-left:8px;padding:0;border:0;background:none;' +
    'color:#7f9cc4;font:inherit;text-decoration:underline;cursor:pointer;}' +
    '.eve-howto button{font:600 12px Segoe UI,Arial,sans-serif;color:#fde68a;cursor:pointer;' +
    'background:rgba(250,204,21,.15);border:1px solid rgba(250,204,21,.5);border-radius:6px;padding:4px 10px;}' +
    '@media (prefers-reduced-motion:reduce){' +
    '.eve-opt,.eve-opt-label,.eve-opt-note{transition:none;}' +
    '.eve-opt:active{transform:none;}}';

  // howto (optional): { text, command } - an instruction box with the exact
  // command to send and a Copy button (pre-test fails: create by PuTTY).
  function writeJiraTab(tab, title, lines, links, howto) {
    const list = links || [];
    try {
      const doc = tab.document;
      const signature = JSON.stringify([title, lines, list, howto || null]);
      if (doc.__eveTabSignature === signature) {
        return;
      }
      doc.__eveTabSignature = signature;
      doc.title = title;
      doc.body.style.cssText =
        'font:14px Segoe UI,Arial,sans-serif;color:#9aa0a6;' +
        'background:#16171b;padding:28px;line-height:1.6;max-width:760px;';
      if (!doc.getElementById('eve-jira-tab-style')) {
        const style = doc.createElement('style');
        style.id = 'eve-jira-tab-style';
        style.textContent = JIRA_TAB_CSS;
        (doc.head || doc.documentElement).appendChild(style);
      }
      doc.body.textContent = lines
        .concat(list.map(link => `${link.text}: ${link.href}`))
        .join('\n');
      const rows = lines.map((line, index) => {
        const row = doc.createElement('div');
        row.textContent = line;
        if (index === 0) {
          row.style.cssText = 'color:#e8eaed;font-size:16px;font-weight:600;margin-bottom:6px;';
        }
        return row;
      });
      if (howto) {
        // plain: one line of ordinary text (before 15 min); otherwise the
        // highlighted gold box.
        const box = doc.createElement('div');
        box.className = howto.plain ? 'eve-howto-plain' : 'eve-howto';
        box.textContent = howto.text;
        const row = doc.createElement(howto.plain ? 'span' : 'div');
        row.className = 'eve-howto-row';
        const code = doc.createElement(howto.plain ? 'span' : 'code');
        code.className = 'eve-howto-cmd';
        code.textContent = howto.command;
        const copy = doc.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => {
          const done = ok => {
            copy.textContent = ok ? '\u{2713} Copied' : 'Select and copy';
            setTimeout(() => {
              copy.textContent = 'Copy';
            }, 2000);
          };
          const clip = tab.navigator && tab.navigator.clipboard;
          if (clip && clip.writeText) {
            clip.writeText(howto.command).then(
              () => done(true),
              () => done(false)
            );
          } else {
            done(false);
          }
        });
        if (howto.plain) {
          box.appendChild(doc.createTextNode(' '));
        }
        row.appendChild(code);
        row.appendChild(copy);
        box.appendChild(row);
        if (howto.link) {
          const line = doc.createElement('div');
          line.className = 'eve-howto-link';
          const a = doc.createElement('a');
          a.href = howto.link.href;
          a.textContent = howto.link.text;
          line.appendChild(a);
          box.appendChild(line);
        }
        if (howto.note) {
          const note = doc.createElement('div');
          note.className = 'eve-howto-note';
          note.textContent = howto.note;
          box.appendChild(note);
        }
        rows.push(box);
      }
      if (list.length) {
        const options = doc.createElement('div');
        options.className = 'eve-opts';
        list.forEach(link => {
          const anchor = doc.createElement('a');
          const label = doc.createElement('div');
          anchor.href = link.href;
          anchor.className = 'eve-opt';
          label.className = 'eve-opt-label';
          label.textContent = link.text;
          anchor.appendChild(label);
          if (link.note) {
            const note = doc.createElement('div');
            note.className = 'eve-opt-note';
            note.textContent = link.note;
            anchor.appendChild(note);
          }
          options.appendChild(anchor);
        });
        rows.push(options);
      }
      doc.body.textContent = '';
      rows.forEach(row => doc.body.appendChild(row));
    } catch (error) {}
  }

  function jiraTabIsWaiting(tab) {
    try {
      return !!tab && !tab.closed && String(tab.location.href) === 'about:blank';
    } catch (error) {
      return false;
    }
  }

  function writeJiraWaitPage(tab, serial, failedAt, pretest, running) {
    // Any failure: from 15 min without a ticket, say how to raise one.
    const createByHand = Date.now() - failedAt >= JIRA_CREATE_BY_HAND_MS;
    const expecting = jiraExpecting(failedAt) && !createByHand;
    const key = jiraLatestKey(serial);
    const time = ms => new Date(ms).toLocaleTimeString();
    const lines = [
      expecting ? `No ticket yet for ${serial}` : `No ticket for ${serial}`,
      `${pretest ? 'Pre-test fail' : 'Test fail'} at ${time(failedAt)}`
    ];
    if (jiraStillChecking(failedAt)) {
      lines.push('This tab opens the ticket by itself if one is raised.');
    }
    writeJiraTab(tab, `${expecting ? 'No ticket yet' : 'No ticket'} \u{2014} ${serial}`, lines, [
      {
        href: jiraListUrl(serial, 'updated', key),
        text: 'Most recently updated',
        note: `Tickets for ${serial}, latest activity first`
      },
      {
        href: jiraListUrl(serial, 'created', key),
        text: 'Most recently created',
        note: `Tickets for ${serial}, newest first`
      }
    ], ticketHowTo(serial, failedAt, running));
  }

  // How to raise a missing ticket by hand (PuTTY). Before 15 min: one plain
  // line with the time; from 15 min: the highlighted gold box.
  function jiraByHandDue(failedAt) {
    return new Date(failedAt + JIRA_CREATE_BY_HAND_MS).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function ticketHowTo(serial, failedAt, running) {
    const command = `ticket ${serial}`;
    if (running === true) {
      // PuTTY would refuse it now - never prompt for a ticket mid-test.
      return {
        plain: true,
        text:
          'This server failed and is being re-tested now (TestView 2.0: RUNNING), so ' +
          'PuTTY cannot create a ticket yet. If it fails again, after the test finishes use:',
        command: command,
        link: testViewRunUrl(serial)
          ? { href: testViewRunUrl(serial), text: 'Open this run in TestView 2.0' }
          : null
      };
    }
    if (Date.now() - failedAt < JIRA_CREATE_BY_HAND_MS) {
      return {
        plain: true,
        text: `If there is no ticket by ${jiraByHandDue(failedAt)}, please open PuTTY and create one with:`,
        command: command
      };
    }
    return {
      text:
        `It has been more than ${JIRA_CREATE_BY_HAND_MS / 60000} minutes` +
        (running === false ? ', the server is not running,' : '') +
        ' and no ticket has been created. Please make one in PuTTY:',
      command: command
    };
  }

  function jiraPuttyTip(serial, failedAt) {
    if (testViewRunningCached(serial) === true) {
      return (
        'Re-testing now (TestView 2.0: RUNNING) - PuTTY cannot create a ticket until ' +
        `it finishes. If it fails again: ticket ${serial}`
      );
    }
    if (Date.now() - failedAt < JIRA_CREATE_BY_HAND_MS) {
      return (
        `If there is no ticket by ${jiraByHandDue(failedAt)}, please open PuTTY and ` +
        `create one with: ticket ${serial}`
      );
    }
    return (
      `It has been more than ${JIRA_CREATE_BY_HAND_MS / 60000} minutes` +
      (testViewRunningCached(serial) === false ? ', the server is not running,' : '') +
      ` and no ticket has been created - please make one in PuTTY: ticket ${serial}`
    );
  }

  async function followJiraInTab(tab, serial, failedAt, pretest) {
    const go = url => {
      try {
        tab.location.replace(url);
      } catch (error) {
        tab.location.href = url;
      }
    };
    if (IS_LION_KING_PAGE || !failedAt) {
      go(await resolveJiraUrl(serial, 0));
      return;
    }
    let askedLatest = false;
    for (let first = true; ; first = false) {
      const own = await jiraWithin(lookupJira(serial, !first, failedAt), JIRA_RESOLVE_WAIT_MS);
      if (!jiraTabIsWaiting(tab)) {
        return;
      }
      if (own && own.state === 'found' && JIRA_KEY_PATTERN.test(String(own.key))) {
        go(jiraIssueUrl(own.key));
        return;
      }
      if (own && own.state === 'auth') {
        go(jiraSearchUrl(serial, failedAt));
        return;
      }
      if (!askedLatest) {
        askedLatest = true;
        await jiraWithin(lookupJira(serial, false, 0), JIRA_RESOLVE_WAIT_MS);
        if (!jiraTabIsWaiting(tab)) {
          return;
        }
      }
      const running =
        Date.now() - failedAt >= JIRA_CREATE_BY_HAND_MS ? await testViewRunning(serial) : null;
      if (!jiraTabIsWaiting(tab)) {
        return;
      }
      writeJiraWaitPage(tab, serial, failedAt, pretest, running);
      if (!jiraStillChecking(failedAt)) {
        return;
      }
      await new Promise(resolve =>
        setTimeout(resolve, jiraExpecting(failedAt) ? JIRA_TAB_POLL_MS : JIRA_PENDING_POLL_MS)
      );
      if (!jiraTabIsWaiting(tab)) {
        return;
      }
    }
  }

  function indexJiraKey(card, result) {
    if (card.dataset.searchBase === undefined) {
      card.dataset.searchBase = card.dataset.search || '';
    }
    const key =
      result && result.state === 'found' && JIRA_KEY_PATTERN.test(String(result.key))
        ? result.key
        : '';
    const next = key ? `${card.dataset.searchBase} ${key}` : card.dataset.searchBase;
    if (card.dataset.search !== next) {
      card.dataset.search = next;
      if (alertSearch) {
        applyAlertFilter();
      }
    }
  }

  function syncJiraForCard(card, record) {
    const button = card ? card.querySelector('.eve-alert-jira') : null;
    if (!button || !record || !record.serial) {
      return;
    }
    if (isPassResult(record)) {
      clearTimeout(button.__eveJiraPoll);
      button.dataset.passed = '1';
      button.dataset.failedAt = '';
      button.dataset.pretest = '';
      paintJiraButton(button, record.serial, { state: 'passed' });
      indexJiraKey(card, null);
      return;
    }
    button.dataset.passed = '';
    const failedAt = jiraFailedAt(record);
    if (IS_LION_RAMSES_PAGE && record.tracker === 'lionking') {
      const board = getRamsesFailedBoard();
      const row = board?.usable ? board.rows.find(entry => entry.serial === record.serial &&
        (jiraIsPretest(record) ? lionIsPretestOperation(entry.operation) :
          entry.operation === 'GPU_JBOG_TEST')) : null;
      if (row?.jiraKey) record.jiraKey = row.jiraKey;
    }
    if (record.tracker === 'lionking' && JIRA_KEY_PATTERN.test(String(record.jiraKey || '')) &&
        jiraCached(record.serial, failedAt)?.state !== 'found') {
      storeJiraResult(jiraLookupKey(record.serial, failedAt), {
        state: 'found', key: record.jiraKey, at: Date.now(), failure: true, count: 1
      });
    }
    button.dataset.failedAt = !IS_LION_KING_PAGE && failedAt ? String(failedAt) : '';
    button.dataset.pretest = jiraIsPretest(record) ? '1' : '';
    const shown = jiraCardResult(record.serial, failedAt);
    paintJiraButton(button, record.serial, shown);
    indexJiraKey(card, shown);
    if (failedAt && jiraLookupAvailable()) {
      refreshCardTicket(card, button, record.serial, failedAt, false);
    } else {
      clearTimeout(button.__eveJiraPoll);
    }
  }

  function jiraPollDelay(failedAt) {
    const minutes = (Date.now() - failedAt) / 60000;
    if (minutes >= JIRA_TICKET_USUAL_MIN - 1 && minutes < JIRA_TICKET_USUAL_MAX + 2) {
      return JIRA_PEAK_POLL_MS;
    }
    if (jiraExpecting(failedAt)) {
      return JIRA_PENDING_POLL_MS;
    }
    return jiraStillChecking(failedAt) ? JIRA_LATE_POLL_MS : 0;
  }

  function refreshCardTicket(card, button, serial, failedAt, force) {
    clearTimeout(button.__eveJiraPoll);
    const repaint = result => {
      if (!button.isConnected) {
        return false;
      }
      const shown = jiraCardResult(serial, failedAt) || result;
      paintJiraButton(button, serial, shown);
      indexJiraKey(card, shown);
      return true;
    };
    const pollAgain = result => {
      const own = jiraCached(serial, failedAt);
      const delay = IS_LION_KING_PAGE ? JIRA_MISS_TTL_MS : jiraPollDelay(failedAt);
      const settled =
        (own && own.state === 'found') || (result && result.state === 'auth') || !delay;
      if (!settled) {
        button.__eveJiraPoll = setTimeout(() => {
          if (button.isConnected) {
            refreshCardTicket(card, button, serial, failedAt, true);
          }
        }, delay);
      }
    };
    if (!force && jiraIsFresh(jiraCached(serial, failedAt))) {
      pollAgain(null);
      return;
    }
    if (!force) {
      paintJiraButton(button, serial, jiraCardResult(serial, failedAt), true);
    }
    lookupJira(serial, force, failedAt).then(result => {
      if (repaint(result)) {
        pollAgain(result);
      }
    });
  }

  function refreshJiraOnCards() {
    const byId = new Map(loadActiveAlerts().map(record => [record.id, record]));
    document.querySelectorAll('#eve-alert-body .eve-alert[data-alert-id]').forEach(card => {
      const record = byId.get(card.dataset.alertId);
      if (record) {
        syncJiraForCard(card, record);
      }
    });
    setJiraBadge('');
  }

  function onJiraWindowFocus() {
    if (!jiraNeedsLogin) {
      return;
    }
    jiraAuthPausedUntil = 0;
    jiraNeedsLogin = false;
    refreshJiraOnCards();
  }

  function openNotificationTarget(record) {
    const detailUrl = record.detailUrl;
    const serial = record.serial;
    const target = (settings && settings.notificationClickTarget) || 'jira';
    const wantJira = (target === 'jira' || target === 'both') && !!serial && !isPassResult(record);
    const wantPage = target === 'detail' || target === 'both' || !wantJira;
    const wantTestView = wantPage && !!serial;
    const wantDetail = wantPage && !serial && !!detailUrl;
    if (wantDetail) {
      openFromNotification(detailUrl);
    } else if (wantTestView) {
      if (record.tracker === 'lionking') openLionKingTestView(serial, record.started, openFromNotification,
        record.operation || (record.transition === 'PRETEST_FAILURE' ? 'PRETEST' : undefined));
      else openTestView(serial, openFromNotification);
    }
    if (wantJira) {
      return openJiraFromToast(serial, jiraFailedAt(record), jiraIsPretest(record));
    }
    return Promise.resolve();
  }

  async function openJiraFromToast(serial, failedAt, pretest) {
    if (IS_LION_KING_PAGE || !failedAt || !jiraLookupAvailable()) {
      openFromNotification(await resolveJiraUrl(serial, IS_LION_KING_PAGE ? 0 : failedAt));
      return;
    }
    const own = jiraFoundUrl(serial, failedAt)
      ? null
      : await jiraWithin(lookupJira(serial, false, failedAt), JIRA_RESOLVE_WAIT_MS);
    const ticket = jiraFoundUrl(serial, failedAt);
    if (ticket) {
      openFromNotification(ticket);
      return;
    }
    if (own && own.state === 'auth') {
      openFromNotification(jiraSearchUrl(serial, failedAt));
      return;
    }
    if (jiraExpecting(failedAt)) {
      openJiraWhenRaised(serial, failedAt, pretest);
      return;
    }
    await openUpdatedListInstead(serial, failedAt, pretest);
  }

  function openUpdatedListInstead(serial, failedAt, pretest) {
    return resolveJiraListUrl(serial, 'updated').then(url => {
      sendDesktopNotification(
        'No Jira ticket for this failure',
        `Serial #: ${serial}\n` +
          `Nothing raised since the ${pretest ? 'pre-test ' : ''}fail at ` +
          `${new Date(failedAt).toLocaleTimeString()}. ` +
          'Opened its tickets, most recently updated first.',
        null,
        null
      );
      openFromNotification(url);
    });
  }
  const jiraOpenWhenRaised = new Set();

  function openJiraWhenRaised(serial, failedAt, pretest) {
    const id = jiraLookupKey(serial, failedAt);
    if (jiraOpenWhenRaised.has(id)) {
      return;
    }
    jiraOpenWhenRaised.add(id);
    const until = new Date(failedAt + JIRA_TICKET_EXPECT_MS).toLocaleTimeString();
    log(
      `No Jira ticket for ${serial} yet \u{2014} it opens by itself if ` +
        `one is raised by ${until}.`
    );
    sendDesktopNotification(
      pretest ? 'No Jira ticket yet' : 'Jira ticket not raised yet',
      `Serial #: ${serial}\n` +
        (pretest ? 'Pre-test fails often never get one. ' : '') +
        `Tickets usually appear ${JIRA_TICKET_USUAL_MIN}\u{2013}` +
        `${JIRA_TICKET_USUAL_MAX} min after a fail. ` +
        `It opens by itself if one is raised by ${until}.`,
      null,
      null
    );
    const check = () => {
      lookupJira(serial, true, failedAt).then(own => {
        if (own && own.state === 'found' && JIRA_KEY_PATTERN.test(String(own.key))) {
          jiraOpenWhenRaised.delete(id);
          refreshJiraOnCards();
          openFromNotification(jiraIssueUrl(own.key));
          return;
        }
        if (own && own.state === 'auth') {
          jiraOpenWhenRaised.delete(id);
          openFromNotification(jiraSearchUrl(serial, failedAt));
          return;
        }
        if (!jiraExpecting(failedAt)) {
          jiraOpenWhenRaised.delete(id);
          refreshJiraOnCards();
          log(
            `No Jira ticket was raised for ${serial} within ` +
              `${JIRA_TICKET_EXPECT_MS / 60000} min of the failure.`
          );
          sendDesktopNotification(
            'No Jira ticket raised',
            `Serial #: ${serial}\n` +
              `Nothing raised within ${JIRA_TICKET_EXPECT_MS / 60000} min` +
              (pretest ? ' (common for pre-test fails)' : '') +
              '. The card keeps checking for a late one. ' +
              'Click to see its tickets, most recently updated first.',
            null,
            () => {
              resolveJiraListUrl(serial, 'updated').then(openFromNotification);
            }
          );
          return;
        }
        setTimeout(check, JIRA_TAB_POLL_MS);
      });
    };
    setTimeout(check, JIRA_TAB_POLL_MS);
  }

  // ===== LOAD / SAVE SETTINGS =====

  function loadSettings() {
    const parsed = readJSON(localStorage, SETTINGS_KEY, null, 'Settings');
    if (parsed && typeof parsed === 'object') {
      delete parsed.autoRefresh;
      delete parsed.softRefresh;
      delete parsed.jiraLookup;
      delete parsed.showDebug;
      delete parsed.hideTestResults;
      if (typeof parsed.developerMode !== 'boolean') {
        parsed.developerMode = defaultSettings.developerMode;
      }
      const merged = { ...defaultSettings, ...parsed };
      merged.refreshIntervalSeconds = coerceRefreshInterval(merged.refreshIntervalSeconds);
      if (!merged.sections || typeof merged.sections !== 'object') {
        merged.sections = {};
      }
      return withLogShift(merged);
    }
    return withLogShift({ ...defaultSettings, sections: {} });
  }

  // Before 0.9.11 the shift was picked by hand (`logShift`) and stayed picked,
  // so a shared PC stayed on whichever shift touched it last. Every saved
  // pick becomes Auto once; a pick now lasts until the next shift change.
  function withLogShift(loaded) {
    const legacy = Object.prototype.hasOwnProperty.call(loaded, 'logShift');
    delete loaded.logShift;
    if (loaded.logShiftChoice !== 'auto' && !SHIFTS[loaded.logShiftChoice]) {
      loaded.logShiftChoice = 'auto';
      loaded.logShiftOverrideFor = '';
    }
    if (legacy) {
      writeJSON(localStorage, SETTINGS_KEY, loaded, 'Settings');
    }
    return loaded;
  }

  function coerceRefreshInterval(value) {
    const seconds = Number(value);
    return REFRESH_INTERVAL_OPTIONS.indexOf(seconds) !== -1 ? seconds : DEFAULT_REFRESH_SECONDS;
  }

  function saveSettings() {
    writeJSON(localStorage, SETTINGS_KEY, settings, 'Settings');
  }

  function getSectionSettings(section) {
    if (!settings.sections[section]) {
      settings.sections[section] = { show: true, watch: true };
      saveSettings();
    }
    return settings.sections[section];
  }

  // ===== BASELINE STATE (previousStates) =====

  function loadPreviousStates() {
    const parsed = readJSON(sessionStorage, PREV_STATES_KEY, null, 'Previous state');
    return parsed && typeof parsed === 'object' ? new Map(Object.entries(parsed)) : new Map();
  }

  function savePreviousStates() {
    writeJSON(
      sessionStorage,
      PREV_STATES_KEY,
      Object.fromEntries(previousStates),
      'Previous state'
    );
  }

  // ===== OUR OWN UI ELEMENTS =====
  const OWN_UI_IDS = ['eve-tracker-panel', 'eve-alert-container'];

  function isOwnUiNode(node) {
    const element = node && node.nodeType === 1 ? node : node ? node.parentElement : null;
    if (!element || !element.closest) {
      return false;
    }
    return OWN_UI_IDS.some(id => element.closest('#' + id)) ||
      (IS_LION_KING_PAGE && !!element.closest('[data-lion-tracker-ui]'));
  }

  // ===== OBSERVER SUPPRESSION =====

  function withoutObserver(fn) {
    observerSuppressDepth += 1;
    try {
      return fn();
    } finally {
      if (pageObserver) {
        pageObserver.takeRecords();
      }
      observerSuppressDepth -= 1;
    }
  }

  // ===== EVE TABLE / HEADER DISCOVERY (cached) =====
  let cachedGroups = null;

  function invalidateHeaderCache() {
    cachedGroups = null;
  }

  function getEveTableGroups(root) {
    const scanRoot = root || document;
    if (!root && cachedGroups) {
      const first = cachedGroups[0];
      if (!first || first.table.isConnected) {
        return cachedGroups;
      }
      cachedGroups = null;
    }
    const byTable = new Map();
    scanRoot.querySelectorAll('th').forEach(th => {
      const match = th.textContent.trim().match(EVE_HEADER_PATTERN);
      if (!match) {
        return;
      }
      const table = th.closest('table');
      if (!table) {
        return;
      }
      if (!byTable.has(table)) {
        byTable.set(table, { table: table, headers: [] });
      }
      byTable.get(table).headers.push({
        element: th,
        section: match[1],
        eve: 'EVE' + match[2],
        column: th.cellIndex
      });
    });
    const groups = [];
    byTable.forEach(group => {
      const spanned = group.table.querySelector(
        'td[colspan], th[colspan], td[rowspan], th[rowspan]'
      );
      if (spanned) {
        if (!root) {
          reportHealth(
            'DEGRADED',
            'An EVE table uses colspan/rowspan, so column ' +
              'mapping is unreliable. That table is NOT scanned.'
          );
        }
        return;
      }
      groups.push(group);
    });
    if (!root) {
      cachedGroups = groups;
    }
    return groups;
  }

  // ===== META REFRESH =====

  function stripMetaRefresh(root) {
    let removed = 0;
    root.querySelectorAll('meta[http-equiv]').forEach(meta => {
      if ((meta.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') {
        meta.remove();
        removed += 1;
      }
    });
    return removed;
  }

  // ===== AUTO REFRESH =====

  function startAutoRefresh() {
    const seconds = coerceRefreshInterval(settings.refreshIntervalSeconds);
    devLog(`Auto refresh: next soft refresh in ${seconds}s`);
    autoRefreshDueAt = Date.now() + seconds * 1000;
    updateRefreshCountdown();
    autoRefreshTimer = setTimeout(fireAutoRefresh, seconds * 1000);
  }

  function fireAutoRefresh() {
    if (!autoRefreshTimer) {
      return;
    }
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
    performSoftRefresh(restartAutoRefresh);
  }

  function refreshNow() {
    if (IS_LION_KING_PAGE) {
      return refreshLionKing();
    }
    if (softRefreshInFlight) {
      return;
    }
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    autoRefreshDueAt = Date.now();
    updateRefreshCountdown();
    log('Manual refresh.');
    performSoftRefresh(restartAutoRefresh);
  }

  function restartAutoRefresh() {
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    autoRefreshDueAt = null;
    startAutoRefresh();
  }

  // ===== AUTO REFRESH WATCHDOG =====

  function autoRefreshWatchdog() {
    if (!autoRefreshDueAt) {
      return;
    }
    const overdueMs = Date.now() - autoRefreshDueAt;
    const graceMs =
      Math.max(30000, coerceRefreshInterval(settings.refreshIntervalSeconds) * 1000) +
      SOFT_REFRESH_TIMEOUT_MS;
    if (overdueMs <= graceMs) {
      return;
    }
    warn(
      `WATCHDOG: auto refresh is ${Math.round(overdueMs / 1000)}s ` +
        'overdue. Aborting any in-flight fetch and rescheduling. If ' +
        'this repeats, the network path to the page is the problem.'
    );
    if (softRefreshController) {
      try {
        softRefreshController.abort();
      } catch (error) {
        warn('Could not abort the in-flight soft refresh:', error);
      }
      softRefreshController = null;
    }
    softRefreshInFlight = false;
    restartAutoRefresh();
  }

  // ===== LIVE REFRESH COUNTDOWN =====

  function setTextIfChanged(element, text) {
    if (element && element.__eveText !== text) {
      element.textContent = text;
      element.__eveText = text;
    }
  }

  function setClassIfChanged(element, className) {
    if (element && element.__eveClass !== className) {
      element.className = className;
      element.__eveClass = className;
    }
  }

  function setRefreshProgress(fill, percent) {
    if (!fill) {
      return;
    }
    const pct = Math.min(100, Math.max(0, percent));
    const width = `${pct.toFixed(1)}%`;
    if (fill.__eveWidth === width) {
      return;
    }
    fill.style.transition = pct < (fill.__evePct || 0) ? 'none' : '';
    fill.style.width = width;
    fill.__eveWidth = width;
    fill.__evePct = pct;
  }

  function updateRefreshCountdown() {
    const badge = document.getElementById('eve-refresh-badge');
    const status = document.getElementById('eve-refresh-status');
    const mini = document.getElementById('eve-refresh-mini');
    if (!badge && !status) {
      return;
    }
    const fill = document.getElementById('eve-refresh-progress-fill');
    if (!autoRefreshDueAt) {
      setTextIfChanged(badge, '\u{2026}');
      setClassIfChanged(badge, 'eve-summary-badge eve-badge-on');
      setTextIfChanged(mini, '\u{2026}');
      setTextIfChanged(status, 'Starting\u{2026}');
      setRefreshProgress(fill, 0);
      return;
    }
    const remaining = Math.max(0, autoRefreshDueAt - Date.now()) / 1000;
    const label =
      remaining >= 60
        ? `${Math.floor(remaining / 60)}m ` +
          `${String(Math.floor(remaining % 60)).padStart(2, '0')}s`
        : `${remaining.toFixed(1)}s`;
    setTextIfChanged(badge, remaining > 0 ? label : 'refreshing\u{2026}');
    setTextIfChanged(mini, remaining > 0 ? label : '\u{21bb}');
    setClassIfChanged(
      mini,
      'eve-summary-badge ' + (remaining <= 5 ? 'eve-badge-soon' : 'eve-badge-on')
    );
    const total = coerceRefreshInterval(settings.refreshIntervalSeconds);
    setRefreshProgress(fill, remaining > 0 ? (1 - remaining / total) * 100 : 100);
    setClassIfChanged(
      badge,
      'eve-summary-badge ' + (remaining <= 5 ? 'eve-badge-soon' : 'eve-badge-on')
    );
    setTextIfChanged(
      status,
      remaining > 0
        ? `Every ${settings.refreshIntervalSeconds}s \u{2022} ` + `next refresh in ${label}`
        : 'Refreshing now\u{2026}'
    );
  }

  // ===== SOFT REFRESH =====

  function transientRefreshError(error) {
    const wrapped = new Error(
      error && error.name === 'AbortError'
        ? `timed out after ${SOFT_REFRESH_TIMEOUT_MS / 1000}s`
        : `network error: ${(error && error.message) || error}`
    );
    wrapped.eveTransient = true;
    return wrapped;
  }

  async function rackServerReachable() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(window.location.href, {
        method: 'HEAD',
        mode: 'no-cors',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
      });
      return true;
    } catch (error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function performSoftRefresh(onDone) {
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        if (onDone) {
          onDone();
        }
      } catch (error) {
        fail('Soft refresh completion callback threw:', error);
      }
    };
    if (softRefreshInFlight) {
      warn(
        'Soft refresh skipped - one is already in flight. ' + 'Rescheduling the next cycle anyway.'
      );
      finish();
      return;
    }
    softRefreshInFlight = true;
    savePreviousStates();
    const controller = new AbortController();
    softRefreshController = controller;
    const abortTimer = setTimeout(() => controller.abort(), SOFT_REFRESH_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetch(window.location.href, {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal
        });
      } catch (error) {
        if (!(error && error.name === 'AbortError') && (await rackServerReachable())) {
          throw new Error('request blocked after a redirect (session likely expired)');
        }
        throw transientRefreshError(error);
      }
      if (!response.ok) {
        const httpError = new Error(`HTTP ${response.status} ${response.statusText}`);
        httpError.eveTransient =
          response.status >= 500 || response.status === 408 || response.status === 429;
        throw httpError;
      }
      if (
        response.redirected &&
        response.url.split('?')[0] !== window.location.href.split('?')[0]
      ) {
        throw new Error(`redirected to ${response.url} ` + '(session likely expired)');
      }
      let html;
      try {
        html = await response.text();
      } catch (error) {
        throw transientRefreshError(error);
      }
      const doc = new DOMParser().parseFromString(html, 'text/html');
      stripMetaRefresh(doc);
      const newGroups = getEveTableGroups(doc);
      if (!newGroups.length) {
        throw new Error(
          'no EVE tables in fetched page (session expired, ' +
            'or the table is rendered by page JavaScript ' +
            'rather than the server)'
        );
      }
      if (softRefreshFailingSince) {
        log(
          'Soft refresh working again after ' +
            `${formatSleep(Date.now() - softRefreshFailingSince)} of failures.`
        );
        softRefreshFailingSince = 0;
      }
      const swapped = swapEveTables(
        newGroups.map(g => g.table),
        doc
      );
      devLog(
        `Soft refresh OK \u{2014} ${swapped} table(s) updated, ` +
          `${previousStates.size} states tracked. Panel position ` +
          'and alerts preserved.'
      );
      finish();
    } catch (error) {
      const reason =
        error && error.name === 'AbortError'
          ? `timed out after ${SOFT_REFRESH_TIMEOUT_MS / 1000}s`
          : error && error.message
            ? error.message
            : error;
      if (error && error.eveTransient) {
        if (!softRefreshFailingSince) {
          softRefreshFailingSince = Date.now();
        }
        warn(
          `Soft refresh failed (${reason}) \u{2014} keeping this ` +
            'page and retrying next cycle. (No reload: during an ' +
            'outage it would land on an error page where the ' +
            'tracker cannot run.)'
        );
        reportHealth(
          'DEGRADED',
          'Rack page not updated since ' +
            `${new Date(softRefreshFailingSince).toLocaleTimeString()} ` +
            `\u{2014} soft refresh failing (${reason}). Retrying every cycle.`
        );
        finish();
        return;
      }
      warn('Soft refresh failed \u{2014} full page reload as ' + 'fail-safe:', reason);
      debugSnapshotBeforeRefresh('soft-refresh-fallback');
      flushAlertLog();
      finish();
      location.reload();
    } finally {
      clearTimeout(abortTimer);
      softRefreshController = null;
      softRefreshInFlight = false;
    }
  }

  function swapEveTables(newTables, doc) {
    if (pageObserver) {
      pageObserver.disconnect();
    }
    invalidateHeaderCache();
    const liveTables = getEveTableGroups().map(g => g.table);
    let swapped = 0;
    if (liveTables.length && liveTables.length === newTables.length) {
      liveTables.forEach((liveTable, index) => {
        liveTable.replaceWith(document.importNode(newTables[index], true));
        swapped += 1;
      });
    } else {
      swapped = swapPageBody(doc || (newTables[0] ? newTables[0].ownerDocument : null));
    }
    invalidateHeaderCache();
    afterSwap();
    return swapped;
  }

  function swapPageBody(doc) {
    if (!doc || !doc.body) {
      return 0;
    }
    [...document.body.children].forEach(node => {
      if (!isOwnUiNode(node)) {
        node.remove();
      }
    });
    const firstOwn = document.body.firstChild;
    let inserted = 0;
    [...doc.body.children].forEach(node => {
      if (node.tagName === 'SCRIPT') {
        return;
      }
      document.body.insertBefore(document.importNode(node, true), firstOwn);
      inserted += 1;
    });
    return inserted;
  }

  function afterSwap() {
    rackDataAt = Date.now();
    observePage();
    const groups = getEveTableGroups();
    buildSectionControls(groups);
    applyVisibility(groups);
    scan(groups);
  }

  // ===== PAGE MUTATION OBSERVER =====

  function isRelevantMutation(mutation) {
    if (observerSuppressDepth > 0) {
      return false;
    }
    if (mutation.type === 'childList') {
      const touched = [...mutation.addedNodes, ...mutation.removedNodes];
      if (touched.length && touched.every(node => isOwnUiNode(node))) {
        return false;
      }
    }
    return !isOwnUiNode(mutation.target);
  }

  function touchesTable(mutation) {
    const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
    if (target && target.closest('table')) {
      return true;
    }
    return [...mutation.addedNodes, ...mutation.removedNodes].some(
      node => node.nodeType === 1 && (node.tagName === 'TABLE' || !!node.querySelector('table'))
    );
  }
  let pendingRackChange = false;

  function observePage() {
    if (pageObserver) {
      pageObserver.disconnect();
    }
    pageObserver = new MutationObserver(mutations => {
      const relevant = mutations.filter(isRelevantMutation);
      if (!relevant.length) {
        return;
      }
      if (relevant.some(touchesTable)) {
        pendingRackChange = true;
      }
      if (scanTimer) {
        clearTimeout(scanTimer);
      }
      scanTimer = setTimeout(() => {
        scanTimer = null;
        if (pendingRackChange) {
          pendingRackChange = false;
          rackDataAt = Date.now();
        }
        invalidateHeaderCache();
        const groups = getEveTableGroups();
        buildSectionControls(groups);
        applyVisibility(groups);
        scan(groups);
      }, OBSERVER_DEBOUNCE_MS);
    });
    pageObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'bgcolor']
    });
  }

  // ===== NOTIFICATION TIMEOUT (ms) =====

  function getNotificationTimeoutMs() {
    const seconds = Number(settings.notificationTimeoutSeconds);
    if (!seconds || seconds <= 0 || Number.isNaN(seconds)) {
      return 0;
    }
    return seconds * 1000;
  }

  // ===== CENTRAL DESKTOP NOTIFICATION SENDER =====
  let notificationTagCounter = 0;

  function sendDesktopNotification(title, text, imageUrl, onclick) {
    if (typeof GM_notification !== 'function') {
      fail(
        'Cannot send desktop notification: GM_notification is ' +
          'not a function. Verify "@grant GM_notification" is in ' +
          'the header and that Tampermonkey is enabled for this page.'
      );
      return false;
    }
    const timeoutMs = getNotificationTimeoutMs();
    notificationTagCounter += 1;
    const tag = `${IS_LION_KING_PAGE ? 'eve-lion' : 'eve-slt'}-${Date.now()}-${notificationTagCounter}`;
    const payload = {
      title: title,
      text: text,
      tag: tag,
      silent: /PASS/.test(String(title))
    };
    if (imageUrl) {
      payload.image = imageUrl;
    }
    if (timeoutMs > 0) {
      payload.timeout = timeoutMs;
    }
    if (typeof onclick === 'function') {
      payload.onclick = onclick;
    }
    const sentAt = Date.now();
    payload.ondone = () => {
      const aliveMs = Date.now() - sentAt;
      if (aliveMs < 250) {
        warn(
          `Toast "${title}" closed after only ${aliveMs}ms. It ` +
            'was almost certainly never visible - a zero/near-zero ' +
            'timeout, or the browser rejecting the notification.'
        );
      } else {
        devLog(`Toast "${title}" closed after ${aliveMs}ms.`);
      }
    };
    try {
      GM_notification(payload);
      devLog('GM_notification() dispatched.', {
        title: title,
        tag: tag,
        timeout: timeoutMs > 0 ? `${timeoutMs}ms` : 'omitted (never auto-close)',
        image: imageUrl ? 'included' : 'none'
      });
      return true;
    } catch (error) {
      fail('GM_notification() threw with image included. Retrying ' + 'as text-only:', error);
      try {
        delete payload.image;
        GM_notification(payload);
        warn(
          'Text-only fallback toast succeeded. The embedded ' +
            'icon is the problem, not the notification system.'
        );
        return true;
      } catch (fallbackError) {
        fail(
          'Text-only fallback ALSO threw. The notification ' + 'system itself is unavailable:',
          fallbackError
        );
        return false;
      }
    }
  }

  // ===== NOTIFICATION ICONS (embedded, no external dependency) =====
  const ICON_FAIL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAE8UlEQVR42u3dUVIUSRhG0ep/g2wVV4hvPhiGCnR1ZdY9dwNDZ34nBydGeLwfUrdxBAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAr+7t4wMA95Fe/w3OfNyHvvPW7H7m4z70zX/Tbn3m4z70/e8z9z3zcR96yp+yNj3zcR961n9j2PHMx33oiSe53ZmP+9Bzz3CvMx/3oaef3kZnPu5DZ5zbLmc+7kMnndgWZz7uQ+ed1fpnPu5Dp57S4mc+7kNnn8/KZz7uQy84mWXPfNyHXnMma575uA+97DQWPPNxH3rlOax25uM+rP/2/8SdAMTvI/LZ1znzcR9ZA9d+6kXOfNxH08AKn3eFr2HcR9DAOp/08q9knELNwGqf8dqvZ9xHysCan+7Cr2rcR8fAsp/rx+MRBXDhJ68ZsP5FvwViwPrrfwhmwPrTABiw/joABqy/DoAB668DYMD66wAYsP46AAasvw6AAeuvA2DA+usAGLD+OgAGrL8OgAHrrwNgwPrrABiw/joABqy/DoAB668DYMD66wDKBqwfgK4B6wega8D6AegasH4AugasH4CuAesHoGvA+gHoGrB+ALoGrB+ArgHrB6BrwPoB6BqwfgC6BqwfgK4B6wega8D6AegasP4Le7wflcq/Ed760/8GSN2oswLAvTolANyu8wHAHTsZANy0MwHAfTsNANy6cwDA3TsBACzA+gGI78D6AeiuwfoB6G7C+gHoLsP6Aejuw/oB6K7E+gHobsX6AeguxvoB6O7G+gHorsf6AehuyPoB6C7J+gHo7sn6AeiuyvoB6G7L+gHoLsz6ATi9lX/CnJ9+B0B9YQwAUN8WAwDUV8UAAPU9MQBAfUkMAFDfEAMA1NfDAAD13TAAQH0xDABQ3woDANRXwgAA9X0wAEB9GQwAUN8EAwDU18AAAPUdMDDW7wQAcPcMAODWGQDAfTMAgJtmAAB3zAAAbpcBANwrAwC40XNa9me5RQyM9V++fgYAqL/9DABQ/86HAQDq3/czAED9T70MANBdPwMA1NfPAAD19TMAQH39DABQXz8DANTXzwAA9fUzAEB9/QwAUF8/AwDU188AAPX1MwBAff0MAODvdjEQBmD9DHQBWD8DXQDWz0AXgPUz0AVg/Qx0AVg/A10A1s9AF4D1M9AFYP0MdAFYPwNdANbPQBeA9TPQBWD9DHQBWD8DXQDWz0AXgPUz0AVg/T7RtRsYt1JYPwPrfgvk/yrz6S78qsatdNbvxVkUwOFvlnhx4gAOf7fQixMHcPjb5V6cOIDDzxfx4sQBHH7ClBcnDuDI/4xBL04dwBH+KbNeHABOPy/r9+JsAOCI/aYJLw4Ap5+d9XtxNgNwBH7bnBcHgNPP0fq9OBsDOG76G6e9OACcfqbW78W5CYAvnKz1e3FuBeBT52v9XpwbAvjPU7Z+L85tAfzzrK3fi3NzAH85cev34iQA/PHcrd+LEwLw2+lbvxcnB+DXHVi/F+ezPd7dp77U28fHDV4cAJRuHIEAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQvtdPemt/a0HAQ/wAAAAASUVORK5CYII=';
  const ICON_PASS =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAEZUlEQVR42u3c3ZHTShhFUcyTicPk6Ql08uCVACiq5key+uu9dgAwI53VslXce7s/Hz+kaj9dAgEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAAkAKT/9+ftHQCl17+rAQD00bN/SwO3+/PhNutTn3x+vf32BBAYAKi68m0MAKAv7nsPAwDo68vewAAA+tampxvwFkjHrHnoqyFPAB1zlg99FACgVQgBoPHbHWcAAB282lkGALD+9xF/5kl5C2T9J7b+qyFPAOtPfy0GwPrTBgBQ2gAAFpk2AID1pw14C2T9r26pV0OeANaffhQAYP3pHwYA609/CgJAvgPI8Z9cPwDWXw8A6+8e/wBYf3r9AFh/ev0AWH96/QAovX4AHP/1ALD+7vEPgPWn1w+A9afXD4D1p9cPgPWn1w+A0usHwPFfDwDr7x7/AFh/ev0AWH96/QBYf3r9AFh/ev0AqB4Ajv/u8Q+A9afXD4D1p9cPgPWn1w+A9afXD4D1p9cPgPXXA0Dd4x8Ax396/TsDGP35wfoBOGBAQw1YPwCHDWicAesH4Fvr+XdAgwx47QPAKesZMawFf8jtj/99ADg7rb8L4CPrX1yIj/4AnD6dZQ1YPwAvms6CBqz/2m7356P2oX+de2z9ngAX7GaR2fniDsBlu7l8fF56AnDxbhzA1j8MwOGTvcqAj/4AdA9s61+qAW+Bzl7MKxdg/Z4Ayy3mZaP0rQOA7jS99gFg6cWc+tdZPwADFtP5iGL9SwO4cIhn/NW++K7cWm+BFtnKgROxfk+AeVs56iexfgC6n7+99ARg8OG0xz84dfxP+gi0jQHrB8BzwFUFIGnAF18Admvuf3dv/SMBLHjbJv6fV6x/8BNgnAEvPQHoGvDaB4DuXbR+AEL3cv2POta/FYDFDfjiC0DXgPUD0M1rHwAcb64PAO6xKwOAO+2aAOB+uxoAuOuuAwDuvSsAgAUIAAb84gDI+gGwBr8vADbhNwXAMvyOANiHAGDArwaAoVg/AOZi/QDI+gGwG+sHwHqsHwAbEgBNA+gC0B2T9QPQnZT1A9AdlvUD0J2X9QMgAZA8ZR3/AHSnZv0AdAdn/QB0Z2f9AHTHZ/0AdA1YPwCeAwKAOgGQmqP1A9A1YP0AdA1YPwBdA9YPgOeAAEga4AqArgHrB6BrwPoBoEgA9OZr/QB0DVg/AJ4DAiBpgBkAugasH4CuAesHoGvA+gFgQwAYugBIGaACgK4B6wega8D6p3e7Px+ugjwBJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAEgEsgACQApF5/ASm83YWSRjGVAAAAAElFTkSuQmCC';

  // ===== THE TRANSITION TABLE - ONE SOURCE OF TRUTH =====
  const TRANSITIONS = {
    PRETEST_FAILURE: {
      title: 'PRE-TEST FAIL \u{274c}',
      status: 'Pre-Testing \u{1f537}. . . \u{25ba} Pre-Test FAIL \u{274c}',
      icon: ICON_FAIL,
      css: 'eve-pretest',
      logHeading: 'PRE-TEST FAILS',
      csvName: 'PRE-TEST FAIL',
      diagnostic: false,
      failure: true
    },
    TEST_FAILURE: {
      title: 'TEST FAIL \u{274c}',
      status: 'Testing \u{1f7e2}. . . \u{25ba} Test FAIL \u{274c}',
      icon: ICON_FAIL,
      css: 'eve-failure',
      logHeading: 'TEST FAILS',
      csvName: 'TEST FAIL',
      diagnostic: false,
      failure: true
    },
    PRETEST_SUCCESS: {
      title: 'PRE-TEST PASS \u{2705}',
      status: 'Pre-Testing \u{1f537}. . . \u{25ba} Pre-Test PASS \u{2705}',
      icon: ICON_PASS,
      css: 'eve-pretest-pass',
      logHeading: 'PRE-TEST PASSES',
      csvName: 'PRE-TEST PASS',
      diagnostic: false,
      failure: false
    },
    TEST_SUCCESS: {
      title: 'TEST PASS \u{2705}',
      status: 'Testing \u{1f7e2}. . . \u{25ba} Test PASS \u{2705}',
      icon: ICON_PASS,
      css: 'eve-success',
      logHeading: 'TEST PASSES',
      csvName: 'TEST PASS',
      diagnostic: false,
      failure: false
    },
    DEKIT_FAILURE: {
      title: 'SYS_DEKIT \u{1f527}',
      status: 'SYS_DEKIT \u{1f527}. . . \u{25ba} diagnostic, Pass=0',
      icon: ICON_PASS,
      css: 'eve-dekit',
      logHeading: 'SYS_DEKIT \u{2014} DIAGNOSTIC, NOT A RESULT (Pass=0)',
      csvName: 'SYS_DEKIT (Pass=0)',
      diagnostic: true,
      failure: false
    },
    DEKIT_SUCCESS: {
      title: 'SYS_DEKIT \u{1f527}',
      status: 'SYS_DEKIT \u{1f527}. . . \u{25ba} diagnostic, Pass=1',
      icon: ICON_PASS,
      css: 'eve-dekit',
      logHeading: 'SYS_DEKIT \u{2014} DIAGNOSTIC, NOT A RESULT (Pass=1)',
      csvName: 'SYS_DEKIT (Pass=1)',
      diagnostic: true,
      failure: false
    }
  };

  function transitionMeta(transition) {
    return TRANSITIONS[transition] || null;
  }

  function getTransitionIcon(transition) {
    const meta = transitionMeta(transition);
    return meta ? meta.icon : ICON_FAIL;
  }

  // ===== SHARED NOTIFICATION FORMAT =====

  function getStatusLine(transition) {
    const meta = transitionMeta(transition);
    return meta ? meta.status : '';
  }

  function getTransitionTitle(transition) {
    const meta = transitionMeta(transition);
    return meta ? meta.title : '';
  }

  function buildNotificationBody(info, transition) {
    return [
      `Serial #: ${info.serial}`,
      `\u{1f4cd} ${info.section} \u{2022} ${info.eve} \u{2022} ${info.unit}`,
      getStatusLine(transition)
    ].join('\n');
  }

  // ===== NOTIFICATION PERMISSION CHECK =====

  function checkNotificationPermission() {
    try {
      if (typeof GM_notification !== 'function') {
        fail(
          'GM_notification is not available in this script ' +
            'context. Check that "@grant GM_notification" is ' +
            'present in the userscript header and that ' +
            'Tampermonkey has not disabled grants for this script.'
        );
      } else {
        devLog(
          'GM_notification() is available. If a test button ' +
            'logs a successful dispatch but no toast appears, ' +
            'the cause is Edge/Windows notification permissions ' +
            'for the Tampermonkey EXTENSION - not this script.'
        );
      }
    } catch (error) {
      warn('GM_notification availability check failed:', error);
    }
    try {
      if (typeof Notification === 'undefined') {
        devLog(
          'Page-level Notification API unavailable (not used ' +
            'by GM_notification - informational only).'
        );
        return;
      }
      devLog(
        `Page-level Notification.permission: ` + `${Notification.permission} (informational only).`
      );
    } catch (error) {
      warn('Page-level notification permission check failed:', error);
    }
  }

  // ===== NOTIFICATION SELF-TEST =====

  function runNotificationDiagnostic() {
    console.log(
      '%c' + LOG_PREFIX + ' NOTIFICATION DIAGNOSTIC STARTING',
      'font-weight:bold;font-size:14px;'
    );
    log('Environment:', {
      scriptVersion: SCRIPT_VERSION,
      GM_notification: typeof GM_notification,
      GM_openInTab: typeof GM_openInTab,
      pageNotificationPermission:
        typeof Notification !== 'undefined' ? Notification.permission : 'API unavailable',
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent
    });
    log('Watch your desktop for the next ~10 seconds and note ' + 'WHICH of the 5 toasts appear.');
    const tests = [
      {
        n: 1,
        label: 'BASELINE (ascii, no image, no timeout, no tag)',
        run: () =>
          GM_notification({
            title: 'EVE Test 1 BASELINE',
            text: 'Plain ASCII only. No image. No timeout.',
            silent: false
          })
      },
      {
        n: 2,
        label: 'TIMEOUT ZERO',
        run: () =>
          GM_notification({
            title: 'EVE Test 2 TIMEOUT-0',
            text: 'Same as test 1 but timeout is 0.',
            timeout: 0,
            silent: false
          })
      },
      {
        n: 3,
        label: 'EMOJI (unicode title and body, no image)',
        run: () =>
          GM_notification({
            title: 'EVE Test 3 \u{274c} EMOJI',
            text:
              '\u{1f4cd} A7 \u{2022} EVE01 \u{2022} U12\n' +
              'Testing \u{1f7e2}. . . \u{25ba} Test FAIL \u{274c}',
            silent: false
          })
      },
      {
        n: 4,
        label: 'IMAGE (baseline plus embedded base64 icon)',
        run: () =>
          GM_notification({
            title: 'EVE Test 4 IMAGE',
            text: 'ASCII text plus the embedded PNG icon.',
            image: ICON_FAIL,
            silent: false
          })
      },
      {
        n: 5,
        label: 'FULL (identical to a real live alert)',
        run: () =>
          sendDesktopNotification(
            'EVE Test 5 \u{274c} FULL',
            '\u{1f4cd} A7 \u{2022} EVE01 \u{2022} U12\n' +
              'Testing \u{1f7e2}. . . \u{25ba} Test FAIL \u{274c}',
            ICON_FAIL,
            null
          )
      }
    ];
    tests.forEach((test, index) => {
      setTimeout(() => {
        log(`--> Firing test ${test.n}: ${test.label}`);
        try {
          test.run();
        } catch (error) {
          fail(`Test ${test.n} THREW:`, error);
        }
      }, index * 2000);
    });
    setTimeout(
      () => {
        console.log(
          '%c' + LOG_PREFIX + ' DIAGNOSTIC COMPLETE - HOW TO READ IT',
          'font-weight:bold;font-size:14px;'
        );
        console.log(
          'NO toasts at all      -> Not a script bug. The\n' +
            '                         extension or Windows is\n' +
            '                         blocking every toast.\n' +
            '1 appears, 2 does not -> timeout:0 is the problem.\n' +
            '3 does not appear     -> Emoji are breaking the toast.\n' +
            '4 does not appear     -> The embedded icon is breaking\n' +
            '                         the toast.\n' +
            'ALL 5 appear          -> Notifications are healthy.'
        );
      },
      tests.length * 2000 + 1000
    );
  }
  try {
    const consoleTarget = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    consoleTarget.eveNotifyDiagnostic = function () {
      if (!settings || !settings.developerMode) {
        console.warn(
          LOG_PREFIX +
            ' Diagnostic is available in Developer Mode only. ' +
            'Tick "Dev" at the bottom of the tracker panel.'
        );
        return;
      }
      runNotificationDiagnostic();
    };
  } catch (error) {
    warn('Could not expose the diagnostic on window:', error);
  }

  // ===== NORMALIZE COLOR =====
  const COLOR_ALIASES = {
    'lightgreen': 'lightgreen',
    'rgb(144, 238, 144)': 'lightgreen',
    '#90ee90': 'lightgreen',
    'darkgreen': 'darkgreen',
    'green': 'darkgreen',
    'rgb(0, 100, 0)': 'darkgreen',
    'rgb(0, 128, 0)': 'darkgreen',
    '#006400': 'darkgreen',
    '#008000': 'darkgreen',
    'red': 'red',
    'rgb(255, 0, 0)': 'red',
    '#ff0000': 'red',
    '#f00': 'red',
    'lightblue': 'lightblue',
    'rgb(173, 216, 230)': 'lightblue',
    '#add8e6': 'lightblue'
  };

  function canonicalColor(raw) {
    const value = (raw || '').toLowerCase().trim();
    if (!value) {
      return '';
    }
    return COLOR_ALIASES[value] || value;
  }

  function normalizeColor(element) {
    if (!element) {
      return '';
    }
    const inline = canonicalColor(element.style.backgroundColor);
    if (inline) {
      return inline;
    }
    const attribute = canonicalColor(element.getAttribute('bgcolor'));
    if (attribute) {
      return attribute;
    }
    return canonicalColor(getComputedStyle(element).backgroundColor);
  }

  // ===== PHASE CONFIRMATION (authoritative, from the detail page) =====
  const PHASE_CONFIRM_TIMEOUT_MS = 10000;
  const PHASE_CONFIRM_MAX_PARALLEL = 4;
  const PHASE_CONFIRM_CACHE_MS = 120000;
  const TOAST_CONFIRM_WAIT_MS = 8000;
  const phaseConfirmCache = new Map();
  const MAX_PHASE_CACHE_ENTRIES = 400;

  function cachePhaseResult(cacheKey, value) {
    phaseConfirmCache.delete(cacheKey);
    phaseConfirmCache.set(cacheKey, { at: Date.now(), value: value });
    if (phaseConfirmCache.size <= MAX_PHASE_CACHE_ENTRIES) {
      return;
    }
    const cutoff = Date.now() - PHASE_CONFIRM_CACHE_MS;
    phaseConfirmCache.forEach((entry, key) => {
      if (entry.at < cutoff) {
        phaseConfirmCache.delete(key);
      }
    });
    while (phaseConfirmCache.size > MAX_PHASE_CACHE_ENTRIES) {
      const oldest = phaseConfirmCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      phaseConfirmCache.delete(oldest);
    }
  }
  let phaseConfirmActive = 0;
  let phaseConfirmQueue = [];
  let phaseConfirmFailures = 0;
  const PRETEST_OPERATION_RE = /pre[\s_-]*test|^pt$/;
  const TEST_OPERATION_RE = /\bslt\b|\btest(?:ing)?\b|\bburn[\s_-]*in\b|\brun[\s_-]*in\b|\bft\b/;
  const DEKIT_OPERATION_RE = /\bsys[\s_-]*dekit\b|\bdekit\b/;

  function normalizePhaseWord(raw) {
    const value = String(raw || '')
      .trim()
      .toLowerCase();
    if (!value) {
      return '';
    }
    if (DEKIT_OPERATION_RE.test(value)) {
      return 'DEKIT';
    }
    if (PRETEST_OPERATION_RE.test(value)) {
      return 'PRETEST';
    }
    return 'TEST';
  }

  function isKnownOperationWord(raw) {
    const value = String(raw || '')
      .trim()
      .toLowerCase();
    if (!value) {
      return false;
    }
    return (
      PRETEST_OPERATION_RE.test(value) ||
      TEST_OPERATION_RE.test(value) ||
      DEKIT_OPERATION_RE.test(value)
    );
  }

  function normalizeStatusWord(raw) {
    const value = String(raw || '')
      .trim()
      .toLowerCase();
    if (!value) {
      return '';
    }
    if (/fail|error|abort/.test(value)) {
      return 'FAIL';
    }
    if (/pass|success|complete/.test(value)) {
      return 'PASS';
    }
    return '';
  }

  function normalizePassFlag(raw) {
    const value = String(raw || '')
      .trim()
      .toLowerCase();
    if (value === '1' || value === 'true' || value === 'y') {
      return 1;
    }
    if (value === '0' || value === 'false' || value === 'n') {
      return 0;
    }
    return null;
  }

  function cellText(cell) {
    return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function parseDetailDocument(doc, serial) {
    const result = {
      confirmed: false,
      phase: '',
      operation: '',
      phaseExact: false,
      status: '',
      pass: null,
      running: false,
      resultConfirmed: false,
      taskset: '',
      taskcase: '',
      started: '',
      finished: '',
      serialOnPage: '',
      serialMatches: null,
      rackSerialOnPage: '',
      positionOnPage: '',
      locationMatches: null,
      reason: ''
    };
    if (!doc || !doc.body) {
      result.reason = 'empty document';
      return result;
    }
    doc.querySelectorAll('tr').forEach(row => {
      const cells = row.children;
      if (cells.length < 2) {
        return;
      }
      const label = cellText(cells[0]).toLowerCase();
      if (!result.serialOnPage && (label === 'server serial' || label === 'server asset')) {
        result.serialOnPage = cellText(cells[1]);
      }
      if (!result.rackSerialOnPage && label === 'rack serial') {
        result.rackSerialOnPage = cellText(cells[1]);
      }
      if (!result.positionOnPage && label === 'position') {
        result.positionOnPage = cellText(cells[1]);
      }
    });
    if (result.serialOnPage && serial) {
      result.serialMatches = result.serialOnPage.toUpperCase() === String(serial).toUpperCase();
    }
    let statusTable = null;
    let columnIndex = null;
    const tables = [...doc.querySelectorAll('table')];
    for (const table of tables) {
      const headerCells = [...table.querySelectorAll('th')].map(th =>
        th.textContent.trim().toLowerCase()
      );
      if (!headerCells.length) {
        continue;
      }
      const hasPhase = headerCells.includes('operation') || headerCells.includes('taskset');
      const hasStatus = headerCells.includes('taskset_status') || headerCells.includes('pass');
      if (!hasPhase || !hasStatus) {
        continue;
      }
      statusTable = table;
      columnIndex = {};
      headerCells.forEach((name, index) => {
        if (columnIndex[name] === undefined) {
          columnIndex[name] = index;
        }
      });
      break;
    }
    if (!statusTable) {
      result.reason = 'no Test Status table on the detail page';
      return result;
    }
    const bodyRows = [...statusTable.querySelectorAll('tr')].filter(row => row.querySelector('td'));
    if (!bodyRows.length) {
      result.reason = 'Test Status table has no data rows';
      return result;
    }
    const snIndex = columnIndex.sn;
    const startedIndex = columnIndex.started;
    const wanted = serial ? String(serial).toUpperCase() : '';
    const candidates =
      snIndex !== undefined && wanted
        ? bodyRows.filter(row => cellText(row.children[snIndex]).toUpperCase() === wanted)
        : [];
    const pool = candidates.length ? candidates : bodyRows;
    let chosen = pool[pool.length - 1];
    if (startedIndex !== undefined && pool.length > 1) {
      let best = '';
      pool.forEach(row => {
        const started = cellText(row.children[startedIndex]);
        if (started && started >= best) {
          best = started;
          chosen = row;
        }
      });
    }
    if (startedIndex !== undefined) {
      result.started = cellText(chosen.children[startedIndex]);
    }
    if (candidates.length > 1) {
      devLog(
        `${serial} has ${candidates.length} Test Status rows; ` +
          `using the one started ${result.started || 'n/a'}.`
      );
    }
    const readColumn = name => {
      const index = columnIndex[name];
      if (index === undefined) {
        return '';
      }
      return cellText(chosen.children[index]);
    };
    result.taskset = readColumn('taskset');
    result.taskcase = readColumn('taskcase');
    result.finished = readColumn('finished');
    const operationCell = readColumn('operation');
    result.operation = operationCell || result.taskset || '';
    result.phase = normalizePhaseWord(operationCell) || normalizePhaseWord(result.taskset);
    result.phaseExact = isKnownOperationWord(operationCell) || isKnownOperationWord(result.taskset);
    result.pass = normalizePassFlag(readColumn('pass'));
    const statusWord = normalizeStatusWord(readColumn('taskset_status'));
    result.running = !result.finished && !statusWord;
    if (result.running) {
      result.status = '';
      result.reason = 'that operation is still running';
    } else if (result.pass === 1) {
      result.status = 'PASS';
    } else if (result.pass === 0) {
      result.status = 'FAIL';
    } else {
      result.status = statusWord;
    }
    if (statusWord && result.status && statusWord !== result.status) {
      fail(
        `${serial}: detail page Pass=${result.pass} disagrees with ` +
          `taskset_status "${statusWord}". Using taskset_status.`
      );
      result.status = statusWord;
    }
    result.resultConfirmed = !!result.status;
    if (!result.phase) {
      result.reason = 'detail page has no Operation on the latest row';
      return result;
    }
    result.confirmed = true;
    if (!result.reason && !result.resultConfirmed) {
      result.reason = 'detail page stated no result for that row';
    }
    return result;
  }

  function fetchDetailDocument(url) {
    return new Promise(resolve => {
      const run = async () => {
        phaseConfirmActive += 1;
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), PHASE_CONFIRM_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          const html = await response.text();
          resolve(new DOMParser().parseFromString(html, 'text/html'));
        } catch (error) {
          devLog(
            'Phase confirmation fetch failed:',
            error && error.message ? error.message : error
          );
          resolve(null);
        } finally {
          clearTimeout(abortTimer);
          phaseConfirmActive -= 1;
          const next = phaseConfirmQueue.shift();
          if (next) {
            next();
          }
        }
      };
      if (phaseConfirmActive < PHASE_CONFIRM_MAX_PARALLEL) {
        run();
      } else {
        phaseConfirmQueue.push(run);
      }
    });
  }

  function normalizeRackSerial(value) {
    const text = String(value || '')
      .trim()
      .toUpperCase();
    const match = text.match(/^TA\.([^-]+)-EVE0*(\d+)/);
    return match ? `TA.${match[1]}-EVE${parseInt(match[2], 10)}` : text;
  }

  function checkLocationAgreement(parsed, info) {
    if (!parsed.rackSerialOnPage || !info) {
      return null;
    }
    if (!info.section || !info.eve || !info.unit) {
      return null;
    }
    const expectedRack = `TA.${info.section}-${info.eve}`;
    const rackOk =
      normalizeRackSerial(parsed.rackSerialOnPage) === normalizeRackSerial(expectedRack);
    let positionOk = true;
    if (parsed.positionOnPage) {
      const pagePosition = parseInt(parsed.positionOnPage, 10);
      const unitNumber = parseInt(String(info.unit).replace(/\D/g, ''), 10);
      if (!Number.isNaN(pagePosition) && !Number.isNaN(unitNumber)) {
        positionOk = pagePosition === unitNumber;
      }
    }
    return {
      ok: rackOk && positionOk,
      expected: `${expectedRack} / U${String(info.unit).replace(/\D/g, '')}`,
      actual: `${parsed.rackSerialOnPage} / position ${parsed.positionOnPage || '?'}`
    };
  }
  const SLOT_DISAGREEMENT_ESCALATION = 3;
  const slotAgreementByTable = new Map();

  function slotTallyFor(info) {
    const key = `${info.section}|${info.eve}`;
    if (!slotAgreementByTable.has(key)) {
      slotAgreementByTable.set(key, { ok: 0, bad: 0 });
    }
    return slotAgreementByTable.get(key);
  }

  function noteSlotAgreement(info) {
    slotTallyFor(info).ok += 1;
  }

  function noteSlotDisagreement(serial, info, location) {
    const tally = slotTallyFor(info);
    tally.bad += 1;
    warn(
      `Slot disagreement for ${serial}: the tracker read it as ` +
        `${location.expected}, its detail page says ` +
        `${location.actual}. One of: the server moved, the detail ` +
        'page is newer than the rack render, or the column mapping ' +
        `is wrong. ${info.section}|${info.eve} so far: ` +
        `${tally.ok} agree, ${tally.bad} disagree.`
    );
    if (tally.bad < SLOT_DISAGREEMENT_ESCALATION || tally.ok > 0) {
      return;
    }
    fail(
      `${tally.bad} servers in ${info.section}|${info.eve} disagree ` +
        'with their detail pages and none agree. That pattern is a ' +
        'column-mapping fault, not moved hardware - alert LOCATIONS ' +
        'from this table cannot be trusted.'
    );
    reportHealth(
      'DEGRADED',
      `${tally.bad} servers in ${info.section}\u{2022}${info.eve} ` +
        'disagree with their detail pages. Column mapping may be wrong.'
    );
  }

  async function confirmPhase(detailUrl, info, options) {
    const serial = info ? info.serial : '';
    const checkLocation = !options || options.live !== false;
    const url = safeUrl(detailUrl);
    if (!url) {
      return {
        confirmed: false,
        reason: 'no detail URL on this cell'
      };
    }
    const cacheKey = `${url}|${serial}`;
    const cached = phaseConfirmCache.get(cacheKey);
    const force = !!(options && options.force);
    if (!force && cached && Date.now() - cached.at < PHASE_CONFIRM_CACHE_MS) {
      return cached.value;
    }
    const doc = await fetchDetailDocument(url);
    if (!doc) {
      phaseConfirmFailures += 1;
      const value = {
        confirmed: false,
        reason: 'detail page unreachable'
      };
      cachePhaseResult(cacheKey, value);
      return value;
    }
    const parsed = parseDetailDocument(doc, serial);
    if (parsed.confirmed) {
      phaseConfirmFailures = 0;
    } else {
      phaseConfirmFailures += 1;
    }
    if (phaseConfirmFailures >= 3) {
      reportHealth(
        'DEGRADED',
        'Phase confirmation is failing. PRE-TEST vs TEST labels ' +
          'are falling back to colour guesses and may be wrong.'
      );
    }
    if (parsed.serialMatches === false) {
      fail(
        `Detail page for "${serial}" reports Server Serial ` +
          `"${parsed.serialOnPage}". The cell's link points at a ` +
          'DIFFERENT server - phase not applied. Check the rack ' +
          'page markup for that cell.'
      );
      const mismatch = {
        confirmed: false,
        reason: `serial mismatch (page says ${parsed.serialOnPage})`
      };
      cachePhaseResult(cacheKey, mismatch);
      return mismatch;
    }
    const location = checkLocation ? checkLocationAgreement(parsed, info) : null;
    parsed.locationMatches = location ? location.ok : null;
    if (location && !location.ok) {
      noteSlotDisagreement(serial, info, location);
    } else if (location && location.ok) {
      noteSlotAgreement(info);
    }
    cachePhaseResult(cacheKey, parsed);
    return parsed;
  }

  // ===== VALID TRANSITIONS =====
  const FAILURE_FROM_COLORS = ['lightblue', 'lightgreen', 'darkgreen'];

  function getTransitionType(oldColor, newColor) {
    if (newColor === 'red' && FAILURE_FROM_COLORS.indexOf(oldColor) !== -1) {
      return oldColor === 'lightblue' ? 'PRETEST_FAILURE' : 'TEST_FAILURE';
    }
    if (newColor === 'darkgreen' && oldColor === 'lightgreen') {
      return 'TEST_SUCCESS';
    }
    return null;
  }
  const TRANSITION_BY_PHASE_RESULT = {
    'PRETEST|FAIL': 'PRETEST_FAILURE',
    'PRETEST|PASS': 'PRETEST_SUCCESS',
    'TEST|FAIL': 'TEST_FAILURE',
    'TEST|PASS': 'TEST_SUCCESS',
    'DEKIT|FAIL': 'DEKIT_FAILURE',
    'DEKIT|PASS': 'DEKIT_SUCCESS'
  };

  function isDiagnosticTransition(transition) {
    const meta = transitionMeta(transition);
    if (meta) {
      return meta.diagnostic;
    }
    return /^DEKIT_/.test(String(transition || ''));
  }

  function resolveTransitionFromDetail(transition, parsed) {
    if (!parsed || !parsed.phase) {
      return transition;
    }
    const provisionalIsFailure = /FAILURE$/.test(transition);
    if (parsed.phase === 'DEKIT') {
      return parsed.status === 'PASS' ? 'DEKIT_SUCCESS' : 'DEKIT_FAILURE';
    }
    if (!parsed.status) {
      if (!provisionalIsFailure) {
        return transition;
      }
      return parsed.phase === 'PRETEST' ? 'PRETEST_FAILURE' : 'TEST_FAILURE';
    }
    if (parsed.status === 'PASS' && provisionalIsFailure) {
      return parsed.phase === 'PRETEST' ? 'PRETEST_FAILURE' : 'TEST_FAILURE';
    }
    return TRANSITION_BY_PHASE_RESULT[`${parsed.phase}|${parsed.status}`] || transition;
  }

  // ===== READ SERVER INFORMATION =====

  function getServerInfo(cell, section, eve, unit) {
    if (!cell) {
      return null;
    }
    const anchor = cell.querySelector('a');
    if (!anchor) {
      return null;
    }
    const text = anchor.textContent.trim();
    if (!text) {
      return null;
    }
    const parts = text.split(/\s+/);
    return {
      section: section,
      eve: eve,
      unit: unit,
      serial: parts[0] || '',
      serverType: parts.slice(1).join(' '),
      color: normalizeColor(cell),
      detailUrl: safeUrl(anchor.href),
      cell: cell
    };
  }

  // ===== RACK CELL CLICK =====
  // A red (failed) server cell opens TestView for its serial - the same
  // openTestView() the alert cards use - instead of the old detail page its
  // link points at. ONE capture-phase listener on the document: the cells
  // belong to the page and a soft refresh replaces whole tables, so nothing
  // is attached per cell and nothing has to be re-attached after a refresh.
  // Work happens only on a click. Modified / non-primary clicks keep the
  // browser's own behaviour (e.g. Ctrl+click still opens the old detail page).

  function rackCellForClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !event.target ||
      !event.target.closest
    ) {
      return null;
    }
    const cell = event.target.closest('td');
    const table = cell && cell.closest('table');
    if (!table || normalizeColor(cell) !== 'red') {
      return null;
    }
    const group = getEveTableGroups().find(g => g.table === table);
    if (!group || !group.headers.some(header => header.column === cell.cellIndex)) {
      return null;
    }
    const info = getServerInfo(cell, '', '', '');
    return info && info.serial ? info : null;
  }

  function onRackCellClick(event) {
    const info = rackCellForClick(event);
    if (!info) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    devLog(`Red cell ${info.serial} clicked - opening TestView.`);
    openTestView(info.serial, openExternal);
  }

  // ===== FLAP PROTECTION =====

  function loadRecentAlerts() {
    const parsed = readJSON(sessionStorage, RECENT_ALERTS_KEY, null, 'Flap-protection');
    const map = new Map();
    if (parsed && typeof parsed === 'object') {
      const now = Date.now();
      Object.entries(parsed).forEach(([sig, time]) => {
        if (now - time < ALERT_COOLDOWN_MS) {
          map.set(sig, time);
        }
      });
    }
    return map;
  }

  function saveRecentAlerts() {
    writeJSON(sessionStorage, RECENT_ALERTS_KEY, Object.fromEntries(recentAlerts), null);
  }

  function isDuplicateAlert(key, serial, transition) {
    const signature = `${key}|${serial}|${transition}`;
    const last = recentAlerts.get(signature);
    const now = Date.now();
    if (last && now - last < ALERT_COOLDOWN_MS) {
      devLog(
        `${signature} suppressed \u{2014} same transition already ` +
          `alerted within the last ${ALERT_COOLDOWN_MS / 1000}s ` +
          '(flap protection).'
      );
      return true;
    }
    recentAlerts.set(signature, now);
    if (recentAlerts.size > MAX_RECENT_ALERT_KEYS) {
      recentAlerts.forEach((time, sig) => {
        if (now - time > ALERT_COOLDOWN_MS) {
          recentAlerts.delete(sig);
        }
      });
      if (recentAlerts.size > MAX_RECENT_ALERT_KEYS) {
        const ordered = [...recentAlerts.entries()].sort((a, b) => a[1] - b[1]);
        const excess = recentAlerts.size - MAX_RECENT_ALERT_KEYS;
        for (let i = 0; i < excess; i += 1) {
          recentAlerts.delete(ordered[i][0]);
        }
      }
    }
    saveRecentAlerts();
    return false;
  }

  // ===== EVENT CLAIMS (one event -> one log entry + one toast, across tabs) =====
  const EVENT_CLAIM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  const MAX_EVENT_CLAIMS = 400;

  function readEventClaims() {
    const claims = readJSON(localStorage, EVENT_CLAIMS_KEY, null, null);
    return claims && typeof claims === 'object' ? claims : {};
  }

  function findEventClaim(key, serial, transition, seenAt) {
    if (!seenAt) {
      return null;
    }
    const claim = readEventClaims()[`${key}|${serial}|${transition}`];
    return claim && Number(claim.at) >= seenAt ? claim : null;
  }

  function recordEventClaim(key, serial, transition, eventId) {
    const claims = readEventClaims();
    claims[`${key}|${serial}|${transition}`] = { at: rackDataAt, eventId: eventId || '' };
    const cutoff = Date.now() - EVENT_CLAIM_MAX_AGE_MS;
    const live = Object.entries(claims)
      .filter(([, claim]) => claim && Number(claim.at) > cutoff)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_EVENT_CLAIMS);
    writeJSON(localStorage, EVENT_CLAIMS_KEY, Object.fromEntries(live), null);
  }

  // ===== SCAN PAGE =====

  function scan(groupsIn) {
    const groups = groupsIn || getEveTableGroups();
    let statesDirty = false;
    const seenKeys = new Set();
    let headerCount = 0;
    let slotErrors = 0;
    const sectionCounts = {};
    groups.forEach(group => {
      const headers = group.headers;
      headerCount += headers.length;
      group.table.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.children;
        if (!cells.length) {
          return;
        }
        const unit = cells[0].textContent.trim();
        if (!/^U\d+$/i.test(unit)) {
          return;
        }
        headers.forEach(header => {
          const serverCell = cells[header.column];
          if (!serverCell) {
            return;
          }
          const info = getServerInfo(serverCell, header.section, header.eve, unit);
          if (!info) {
            return;
          }
          tallySectionStatus(sectionCounts, header.section, info.color);
          try {
            processSlot(header, unit, info, seenKeys, () => {
              statesDirty = true;
            });
          } catch (error) {
            slotErrors += 1;
            fail('processSlot threw for ' + `${header.section}|${header.eve}|${unit}:`, error);
          }
        });
      });
    });
    if (headerCount && previousStates.size) {
      const floor = Math.max(1, Math.floor(previousStates.size * PRUNE_MIN_RATIO));
      if (seenKeys.size >= floor) {
        let pruned = 0;
        previousStates.forEach((value, key) => {
          if (!seenKeys.has(key)) {
            previousStates.delete(key);
            pruned += 1;
          }
        });
        if (pruned) {
          statesDirty = true;
          devLog(`Pruned ${pruned} slot(s) no longer present on the page.`);
        }
      } else {
        reportHealth(
          'DEGRADED',
          `Scan read only ${seenKeys.size} of ` +
            `${previousStates.size} tracked slots. Baselines ` +
            'PRESERVED rather than pruned.'
        );
      }
    }
    if (!headerCount) {
      blindScans += 1;
      if (blindScans >= BLIND_SCAN_THRESHOLD) {
        reportHealth(
          'BLIND',
          'No EVE table headers found. The page structure has ' +
            'probably changed, or the page failed to load.'
        );
      }
    } else {
      blindScans = 0;
      if (slotErrors) {
        reportHealth(
          'DEGRADED',
          `${slotErrors} slot(s) threw during this scan. See ` + 'the console for the failing keys.'
        );
      } else if (
        healthState !== 'OK' &&
        seenKeys.size &&
        !document.hidden &&
        !softRefreshFailingSince
      ) {
        reportHealth('OK', '');
      }
    }
    if (statesDirty) {
      savePreviousStates();
    }
    if (headerCount && !slotErrors) {
      markGoneCards(groups, seenKeys);
    }
    if (headerCount) {
      lastSectionCounts = sectionCounts;
      renderSectionCounts();
    }
    const lastScanEl = document.getElementById('eve-last-scan');
    if (lastScanEl) {
      lastScanEl.textContent =
        `Last scan: ${new Date().toLocaleTimeString()} ` +
        `(${headerCount} headers, ${previousStates.size} states)`;
    }
    flushPendingToasts();
  }
  const STATUS_BY_COLOR = {
    lightblue: 'pretest',
    lightgreen: 'testing',
    red: 'failed',
    darkgreen: 'passed'
  };
  let lastSectionCounts = {};

  function tallySectionStatus(counts, section, color) {
    const bucket = STATUS_BY_COLOR[color];
    if (!bucket) {
      return;
    }
    if (!counts[section]) {
      counts[section] = { pretest: 0, testing: 0, failed: 0, passed: 0 };
    }
    counts[section][bucket] += 1;
  }

  function setSectionStat(pill, count, word) {
    setTextIfChanged(pill.querySelector('b'), String(count));
    setTextIfChanged(pill.querySelector('span'), word);
    pill.classList.toggle('eve-stat-zero', !count);
  }

  function renderSectionCounts() {
    const list = document.getElementById('eve-section-list');
    if (!list) {
      return;
    }
    list.querySelectorAll('.eve-section-row').forEach(row => {
      const stats = row.querySelector('.eve-section-stats');
      if (!stats) {
        return;
      }
      const section = row.dataset.section;
      const c = lastSectionCounts[section] || { pretest: 0, testing: 0, failed: 0, passed: 0 };
      const testing = c.pretest + c.testing;
      setSectionStat(stats.querySelector('.eve-stat-testing'), testing, 'test');
      setSectionStat(stats.querySelector('.eve-stat-failed'), c.failed, 'fail');
      setSectionStat(stats.querySelector('.eve-stat-passed'), c.passed, 'pass');
      const tip =
        `${section}: ${testing} testing` +
        (testing ? ` (${c.pretest} pre-test, ${c.testing} test)` : '') +
        ` \u{b7} ${c.failed} failed (pre-test + test fails together)` +
        ` \u{b7} ${c.passed} passed` +
        '\nLive from the rack colours, updated every few seconds.';
      if (stats.title !== tip) {
        stats.title = tip;
      }
    });
  }

  function syncSectionRowShown(row, shown) {
    row.classList.toggle('eve-section-shown', !!shown);
  }

  function processSlot(header, unit, info, seenKeys, markDirty) {
    const key = `${header.section}|${header.eve}|${unit}`;
    seenKeys.add(key);
    const oldState = previousStates.get(key);
    const newState = {
      color: info.color,
      serial: info.serial,
      seen: rackDataAt
    };
    const colorChanged = oldState && oldState.color !== info.color;
    const serialChanged = oldState && oldState.serial !== info.serial;
    if (!oldState || colorChanged || serialChanged) {
      markDirty();
      devLog(
        `${key} \u{2192} color:${info.color} serial:${info.serial}` +
          (oldState ? ` (was ${oldState.color}/${oldState.serial})` : ' (baseline)')
      );
    } else if (oldState.seen !== rackDataAt) {
      markDirty();
    }
    previousStates.set(key, newState);
    if (!oldState) {
      return;
    }
    if (serialChanged) {
      log(
        `${key} \u{2014} server swapped (${oldState.serial} ` +
          `\u{2192} ${info.serial}). Re-baselined; no alert raised.`
      );
      return;
    }
    if (!colorChanged) {
      return;
    }
    const transition = getTransitionType(oldState.color, info.color);
    if (!transition) {
      return;
    }
    if (findEventClaim(key, info.serial, transition, oldState.seen)) {
      const repeat = isDuplicateAlert(key, info.serial, transition);
      devLog(
        `${key} ${transition} already logged and notified by another ` +
          'tracker tab \u{2014} card only, no second log entry or toast.'
      );
      if (!repeat && getSectionSettings(header.section).watch) {
        const confirmation = info.detailUrl ? confirmPhase(info.detailUrl, info, { force: true }) : null;
        surfaceAlert(info, transition, confirmation, '', true);
      }
      return;
    }
    const suppressed = isDuplicateAlert(key, info.serial, transition);
    const eventId = logRealAlert(info, transition, !!suppressed);
    if (eventId) {
      recordEventClaim(key, info.serial, transition, eventId);
    }
    const confirmation = confirmEvent(info, transition, eventId);
    if (suppressed) {
      return;
    }
    const sectionSettings = getSectionSettings(header.section);
    if (!sectionSettings.watch) {
      log(
        `${key} ${transition} recorded to the log but not ` +
          `surfaced \u{2014} "Notifs" is off for section ` +
          `${header.section}.`
      );
      return;
    }
    surfaceAlert(info, transition, confirmation, eventId);
  }

  function confirmEvent(info, transition, eventId) {
    if (!eventId || !info || !info.detailUrl || isDebugData(info)) {
      return null;
    }
    if (isLogEntryResolved(eventId)) {
      return null;
    }
    return confirmPhase(info.detailUrl, info, { force: true })
      .then(result => {
        applyConfirmationToLogEntry(eventId, transition, result);
        return result;
      })
      .catch(error => {
        fail('Event confirmation threw:', error);
        applyConfirmationToLogEntry(eventId, transition, null);
        return null;
      });
  }

  // ===== SURFACE AN ALERT (in-page card + desktop toast) =====
  let pendingToasts = [];
  const CORRECTION_TOAST_MAX_AGE_MS = 1800000;

  function markToastSent(record, transition) {
    if (!record) {
      return;
    }
    record.notifiedTransition = transition || record.transition || '';
    updateStoredAlert(record);
  }

  function notifyLabelCorrection(record, previousTransition) {
    if (!record || !previousTransition) {
      return;
    }
    if (previousTransition === record.transition) {
      return;
    }
    if (!record.ts || Date.now() - Number(record.ts) > CORRECTION_TOAST_MAX_AGE_MS) {
      return;
    }
    if (isDebugData(record) && !settings.developerMode) {
      return;
    }
    const becameDiagnostic =
      isDiagnosticTransition(record.transition) && !isDiagnosticTransition(previousTransition);
    if (isDiagnosticTransition(record.transition) && !becameDiagnostic) {
      return;
    }
    const title = becameDiagnostic
      ? 'SYS_DEKIT \u{1f527} \u{2014} NOT A FAILURE'
      : `${getTransitionTitle(record.transition)} \u{2014} CORRECTED`;
    const tail = becameDiagnostic
      ? `(earlier alert said ${getTransitionTitle(previousTransition)} \u{2014} disregard)`
      : `(earlier alert said ${getTransitionTitle(previousTransition)})`;
    sendDesktopNotification(
      title,
      [
        `Serial #: ${record.serial}`,
        `\u{1f4cd} ${record.location || ''}`,
        record.statusLine || '',
        tail
      ].join('\n'),
      getTransitionIcon(record.transition),
      record.detailUrl || record.serial ? () => openNotificationTarget(record) : null
    );
  }

  function surfaceAlert(info, transition, eventConfirmation, eventId, cardOnly) {
    const record = createPersistentAlert(getTransitionTitle(transition), info, transition);
    record.eventId = eventId || '';
    linkLogEntryToAlert(eventId, record.id);
    updateStoredAlert(record);
    const confirmation = eventConfirmation
      ? trackConfirmation(record, eventConfirmation)
          .then(result => {
            reconcileAlertPhase(record, result);
            return result;
          })
          .catch(error => {
            fail('Phase confirmation threw:', error);
            reconcileAlertPhase(record, null);
            return null;
          })
      : null;
    if (cardOnly) {
      return;
    }
    pendingToasts.push({
      info: info,
      record: record,
      confirmation: confirmation
    });
  }

  async function flushPendingToasts() {
    let batch = pendingToasts;
    pendingToasts = [];
    if (!batch.length) {
      return;
    }
    const confirmations = batch.map(item => item.confirmation).filter(Boolean);
    if (confirmations.length) {
      await Promise.race([
        Promise.allSettled(confirmations),
        new Promise(r => setTimeout(r, TOAST_CONFIRM_WAIT_MS))
      ]);
    }
    batch.forEach(item => {
      item.transition = item.record ? item.record.transition : item.transition;
    });
    const diagnostics = batch.filter(item => isDiagnosticTransition(item.transition));
    diagnostics.forEach(item => {
      markToastSent(item.record, item.transition);
    });
    if (diagnostics.length) {
      devLog(
        `${diagnostics.length} SYS_DEKIT event(s) recorded ` + 'without a desktop notification.'
      );
    }
    batch = batch.filter(item => !isDiagnosticTransition(item.transition));
    if (!batch.length) {
      return;
    }
    if (batch.length <= TOAST_INDIVIDUAL_LIMIT) {
      batch.forEach(item => {
        const unverified =
          settings.developerMode && item.record && item.record.phaseSource === 'unverified';
        sendDesktopNotification(
          getTransitionTitle(item.transition) + (unverified ? ' \u{26a0}' : ''),
          buildNotificationBody(item.info, item.transition) +
            (unverified ? '\n\u{26a0} phase not verified' : ''),
          getTransitionIcon(item.transition),
          item.record.detailUrl || item.record.serial
            ? () => openNotificationTarget(item.record)
            : null
        );
        markToastSent(item.record, item.transition);
      });
      return;
    }
    const counts = {
      TEST_FAILURE: 0,
      PRETEST_FAILURE: 0,
      TEST_SUCCESS: 0,
      PRETEST_SUCCESS: 0
    };
    batch.forEach(item => {
      if (counts[item.transition] !== undefined) {
        counts[item.transition] += 1;
      }
    });
    const passes = counts.TEST_SUCCESS + counts.PRETEST_SUCCESS;
    const failParts = [];
    if (counts.TEST_FAILURE) {
      failParts.push(`${counts.TEST_FAILURE} TEST FAIL`);
    }
    if (counts.PRETEST_FAILURE) {
      failParts.push(`${counts.PRETEST_FAILURE} PRE-TEST FAIL`);
    }
    sendDesktopNotification(
      failParts.length
        ? `${failParts.join(' \u{b7} ')} \u{274c} (+${passes} pass)`
        : `${passes} PASS \u{2705}`,
      `${counts.TEST_FAILURE} test fail \u{2022} ` +
        `${counts.PRETEST_FAILURE} pre-test fail \u{2022} ` +
        `${counts.TEST_SUCCESS} test pass \u{2022} ` +
        `${counts.PRETEST_SUCCESS} pre-test pass\n` +
        'Open JIRAlerts for details.',
      failParts.length ? ICON_FAIL : ICON_PASS,
      null
    );
    batch.forEach(item => markToastSent(item.record, item.transition));
    log(
      `${batch.length} events this cycle \u{2014} sent one summary ` +
        'toast instead of one per event. All cards are in the panel.'
    );
  }

  // ===== DEBUG: PERSISTENCE TESTER (Developer Mode only) =====

  function debugSnapshotBeforeRefresh(reason) {
    if (!settings.developerMode) {
      return;
    }
    try {
      const snapshot = {
        reason: reason,
        timestamp: new Date().toISOString(),
        count: previousStates.size,
        data: Object.fromEntries(previousStates)
      };
      sessionStorage.setItem(DEBUG_SNAPSHOT_KEY, JSON.stringify(snapshot));
      devLog(`Snapshot taken before refresh (${reason}). ` + `${snapshot.count} states saved.`);
    } catch (error) {
      warn('[DEV] Snapshot failed:', error);
    }
  }

  function debugCompareAfterRefresh() {
    if (!settings.developerMode) {
      return;
    }
    try {
      const raw = sessionStorage.getItem(DEBUG_SNAPSHOT_KEY);
      if (!raw) {
        devLog('No pre-refresh snapshot found (fresh session, or no ' + 'test was run).');
        return;
      }
      const snapshot = JSON.parse(raw);
      const beforeKeys = Object.keys(snapshot.data);
      const missing = beforeKeys.filter(k => !previousStates.has(k));
      const changed = beforeKeys.filter(k => {
        const before = snapshot.data[k];
        const after = previousStates.get(k);
        return after && (after.color !== before.color || after.serial !== before.serial);
      });
      devLog('===== PERSISTENCE TEST RESULT =====');
      devLog(`Snapshot reason: ${snapshot.reason}`);
      devLog(`Before: ${beforeKeys.length} states | ` + `After: ${previousStates.size} states`);
      if (!missing.length && !changed.length) {
        devLog('\u{2705} PASS \u{2014} all states survived the refresh intact.');
      } else {
        warn('[DEV] \u{274c} FAIL \u{2014} mismatch detected.');
        if (missing.length) {
          warn('[DEV] Missing keys after refresh:', missing);
        }
        if (changed.length) {
          warn('[DEV] Keys with different values after refresh:', changed);
        }
      }
      devLog('===================================');
      sessionStorage.removeItem(DEBUG_SNAPSHOT_KEY);
    } catch (error) {
      warn('[DEV] Compare failed:', error);
    }
  }

  // ===== RANDOM TEST DATA =====

  function randomTestServerInfo() {
    const sections = ['B1', 'B2', 'B3', 'B4', 'B5'];
    const eveNumbers = ['EVE01', 'EVE02', 'EVE03', 'EVE04', 'EVE05', 'EVE06', 'EVE07', 'EVE08'];
    const uNumber = String(Math.floor(Math.random() * 42) + 1).padStart(2, '0');
    const serial = 'DEBUG #' + String(Math.floor(Math.random() * 9000) + 8231000);
    return {
      serial: serial,
      section: sections[Math.floor(Math.random() * sections.length)],
      eve: eveNumbers[Math.floor(Math.random() * eveNumbers.length)],
      unit: `U${uNumber}`,
      serverType: 'E62CSTANDARDCNIC',
      detailUrl: ''
    };
  }

  // ===== TEST NOTIFICATION (debug buttons only) =====

  function sendTestNotification(type) {
    const transitionByType = {
      success: 'TEST_SUCCESS',
      failure: 'TEST_FAILURE',
      pretest: 'PRETEST_FAILURE'
    };
    const transition = transitionByType[type];
    if (!transition) {
      return;
    }
    const info = randomTestServerInfo();
    const title = getTransitionTitle(transition);
    createPersistentAlert(title, info, transition);
    if (settings.developerMode) {
      sendDesktopNotification(
        title,
        buildNotificationBody(info, transition),
        getTransitionIcon(transition),
        () => log('Test desktop notification clicked')
      );
    }
    log('TEST NOTIFICATION:', {
      type: type,
      serial: info.serial,
      location: `${info.section}-${info.eve} | ${info.unit}`
    });
  }

  // ===== REAL-ALERT AUDIT LOG =====
  let alertLogCache = null;
  let logWriteTimer = null;
  let logWritePending = false;
  const logDirtyIds = new Set();
  let logRetentionFloor = 0;

  function shiftMinutes(hhmm) {
    const parts = String(hhmm).split(':').map(Number);
    return parts[0] * 60 + (parts[1] || 0);
  }

  function shiftLengthMin(shift) {
    return (shiftMinutes(shift.end) - shiftMinutes(shift.start) + 1440) % 1440 || 1440;
  }

  function shiftClock(hhmm) {
    const minutes = shiftMinutes(hhmm);
    const hours = Math.floor(minutes / 60);
    return (
      `${((hours + 11) % 12) + 1}:` +
      `${String(minutes % 60).padStart(2, '0')} ` +
      (hours < 12 ? 'AM' : 'PM')
    );
  }

  // The shift a session starting at `date` most likely belongs to: the one
  // whose LOG WINDOW opened most recently (start - SHIFT_EARLY_MIN, the same
  // early margin the log uses) among those still open. Near a boundary the
  // incoming shift wins - someone starting at 9:40 PM is a Graveyard tester
  // arriving early, not a Swing tester, and 6:00 AM is Day, not the tail of
  // Graveyard. Outside every window, the next shift to open.
  function guessShift(date) {
    const now = date.getHours() * 60 + date.getMinutes();
    const ids = Object.keys(SHIFTS);
    const opens = id => shiftMinutes(SHIFTS[id].start) - SHIFT_EARLY_MIN;
    const sinceOpen = id => (((now - opens(id)) % 1440) + 1440) % 1440;
    const open = ids
      .filter(id => sinceOpen(id) < SHIFT_EARLY_MIN + shiftLengthMin(SHIFTS[id]))
      .sort((a, b) => sinceOpen(a) - sinceOpen(b));
    if (open.length) {
      return open[0];
    }
    return ids.sort((a, b) => 1440 - sinceOpen(a) - (1440 - sinceOpen(b)))[0];
  }

  // ===== AUTO LOG SHIFT =====
  // Auto follows the shift the session is in: the running shift (the one that
  // started most recently where two overlap) is kept until its window closes
  // (end + SHIFT_LATE_MIN), then the shift running at that moment takes over.
  // Stored per browser so every tab exports the same window.

  function readAutoShiftKey() {
    try {
      return localStorage.getItem(LOG_AUTO_SHIFT_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function autoShiftId(now) {
    const stored = readAutoShiftKey();
    const storedId = stored.split('@')[0];
    if (SHIFTS[storedId]) {
      const win = shiftWindowAt(now, storedId);
      if (win.key === stored && now < win.closes.getTime()) {
        return storedId;
      }
    }
    const id = guessShift(new Date(now));
    const key = shiftWindowAt(now, id).key;
    if (key !== stored) {
      try {
        localStorage.setItem(LOG_AUTO_SHIFT_KEY, key);
      } catch (error) {
        warn('Could not record the auto log shift:', error);
      }
    }
    return id;
  }

  // A hand-picked shift applies until Auto moves to its next shift.
  function logShiftOverride(now) {
    const choice = settings && settings.logShiftChoice;
    if (!SHIFTS[choice]) {
      return '';
    }
    return settings.logShiftOverrideFor === shiftWindowAt(now, autoShiftId(now)).key ? choice : '';
  }

  function currentShiftId(now) {
    const at = now === undefined ? Date.now() : now;
    return logShiftOverride(at) || autoShiftId(at);
  }

  function localDateKey(date) {
    return (
      `${date.getFullYear()}-` +
      `${String(date.getMonth() + 1).padStart(2, '0')}-` +
      `${String(date.getDate()).padStart(2, '0')}`
    );
  }

  function shiftWindowAt(when, shiftId) {
    const id = SHIFTS[shiftId] ? shiftId : 'graveyard';
    const shift = SHIFTS[id];
    const at = new Date(when);
    const start = shiftMinutes(shift.start);
    const length = shiftLengthMin(shift);
    const onDay = (day, minutes) =>
      new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
    let day = null;
    for (const offset of [1, 0, -1, -2]) {
      const candidate = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
      if (onDay(candidate, start - SHIFT_EARLY_MIN) <= at) {
        day = candidate;
        break;
      }
    }
    const starts = onDay(day, start);
    return {
      id: id,
      shift: shift,
      opens: onDay(day, start - SHIFT_EARLY_MIN),
      starts: starts,
      ends: onDay(day, start + length),
      closes: onDay(day, start + length + SHIFT_LATE_MIN),
      key: `${id}@${localDateKey(starts)}`
    };
  }

  function currentShiftWindow() {
    return shiftWindowAt(Date.now(), currentShiftId());
  }

  function shiftWindowLabel(win) {
    const day = d =>
      d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    const time = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return (
      `${win.shift.label} shift \u{b7} ` +
      `${day(win.starts)} ${time(win.starts)} \u{2013} ` +
      `${day(win.ends)} ${time(win.ends)}`
    );
  }

  function entryTime(entry) {
    return entry && entry.iso ? Date.parse(entry.iso) : NaN;
  }

  function isEntryInShiftWindow(entry, win) {
    const time = entryTime(entry);
    return Number.isFinite(time) && time >= win.opens.getTime() && time < win.closes.getTime();
  }
  let activeLogShift = '';

  function pruneLogBefore(opensMs) {
    logRetentionFloor = opensMs;
    const entries = getAlertLog();
    const kept = entries.filter(entry => {
      const time = entryTime(entry);
      return Number.isFinite(time) && time >= opensMs;
    });
    const removed = entries.length - kept.length;
    if (!removed) {
      return 0;
    }
    alertLogCache = kept;
    logWritePending = true;
    flushAlertLog();
    return removed;
  }

  function recordActiveLogShift(key) {
    activeLogShift = key;
    try {
      localStorage.setItem(LOG_SHIFT_KEY, key);
    } catch (error) {
      warn('Could not record the log shift:', error);
    }
  }

  // Oldest time any shift can still export: each shift's most recent window
  // (the one its exports cover now) is kept until that shift opens again.
  // Clearing at the selected shift's own window used to delete a neighbour
  // shift that was still running (Day opens at 5:00 AM, mid-Graveyard).
  function logRetentionFloorAt(now) {
    return Math.min(...Object.keys(SHIFTS).map(id => shiftWindowAt(now, id).opens.getTime()));
  }

  function expireLogShiftOverride(now) {
    if (!settings || !SHIFTS[settings.logShiftChoice] || logShiftOverride(now)) {
      return;
    }
    const label = SHIFTS[settings.logShiftChoice].label;
    settings.logShiftChoice = 'auto';
    settings.logShiftOverrideFor = '';
    saveSettings();
    log(`Log shift: the ${label} pick ended at the shift change - back to Auto.`);
  }

  function checkLogShiftRollover(now) {
    const at = now === undefined ? Date.now() : now;
    expireLogShiftOverride(at);
    updateLogShiftControl(at);
    const win = shiftWindowAt(at, currentShiftId(at));
    if (activeLogShift === win.key) {
      return;
    }
    const previous = activeLogShift;
    recordActiveLogShift(win.key);
    const removed = pruneLogBefore(logRetentionFloorAt(at));
    if (!removed) {
      return;
    }
    const count = removed === 1 ? '1 entry' : `${removed} entries`;
    if (!previous) {
      log(
        `Alert log: cleared ${count} from before the current ` +
          `log window (${shiftWindowLabel(win)}).`
      );
      return;
    }
    log(
      `Alert log: new ${win.shift.label} shift ` +
        `(${shiftWindowLabel(win)}). ${count} from the previous ` +
        'shift were cleared.'
    );
    sendDesktopNotification(
      `eve_slt_Jbog_tracker \u{2014} NEW ${win.shift.label.toUpperCase()} SHIFT LOG`,
      `${count} from the previous shift were cleared.\n` + `Now logging: ${shiftWindowLabel(win)}.`,
      null,
      null
    );
  }

  function shiftRangeLabel(shift) {
    return `${shift.label} \u{b7} ${shiftClock(shift.start)} \u{2013} ${shiftClock(shift.end)}`;
  }

  function logShiftTooltip(shiftId, manual) {
    const shift = SHIFTS[shiftId] || SHIFTS.graveyard;
    const clock = minutes => shiftClock(`0:${(minutes + 1440) % 1440}`);
    const opens = clock(shiftMinutes(shift.start) - SHIFT_EARLY_MIN);
    const closes = clock(shiftMinutes(shift.end) + SHIFT_LATE_MIN);
    const lead = manual
      ? `Manual: ${shift.label} until the next shift change, then back to Auto.`
      : `Auto: follows the shift you are in - ${shift.label} now - and moves ` +
        'to the next shift when this window ends. Pick a shift to override ' +
        'it until the next shift change.';
    return (
      `${lead} The alert log and TXT/CSV exports cover ${opens} - ${closes} ` +
      `(${SHIFT_EARLY_MIN} min before the shift starts to ${SHIFT_LATE_MIN} min ` +
      `after it ends). This log is kept until ${opens}, when the next ` +
      `${shift.label} window opens - export before then. Entries another ` +
      "shift's latest window still covers are never cleared, and changing " +
      'this setting clears nothing.'
    );
  }

  function updateLogShiftControl(now) {
    const select = document.getElementById('eve-log-shift');
    if (!select) {
      return;
    }
    const at = now === undefined ? Date.now() : now;
    const manual = logShiftOverride(at);
    const autoOption = select.querySelector('option[value="auto"]');
    const autoText = `Auto \u{b7} ${SHIFTS[autoShiftId(at)].label} now`;
    if (autoOption && autoOption.textContent !== autoText) {
      autoOption.textContent = autoText;
    }
    const value = manual || 'auto';
    if (select.value !== value) {
      select.value = value;
    }
    const title = logShiftTooltip(currentShiftId(at), !!manual);
    if (select.title !== title) {
      select.title = title;
    }
  }

  function setLogShiftChoice(choice, now) {
    const at = now === undefined ? Date.now() : now;
    const manual = !!SHIFTS[choice];
    settings.logShiftChoice = manual ? choice : 'auto';
    settings.logShiftOverrideFor = manual ? shiftWindowAt(at, autoShiftId(at)).key : '';
    saveSettings();
    const win = shiftWindowAt(at, currentShiftId(at));
    recordActiveLogShift(win.key);
    updateLogShiftControl(at);
    log(
      `Log shift set to ${manual ? win.shift.label : `Auto (${win.shift.label} now)`}. ` +
        `Exports now cover ${shiftWindowLabel(win)} (plus ${SHIFT_EARLY_MIN} min ` +
        `before, ${SHIFT_LATE_MIN} min after). ` +
        (manual ? 'Back to Auto at the next shift change. ' : '') +
        'Nothing was cleared.'
    );
  }

  function loadAlertLogFromStorage() {
    const parsed = readJSON(localStorage, ALERT_LOG_KEY, null, 'Alert log');
    return Array.isArray(parsed) ? parsed.filter(isRecordObject) : [];
  }

  function getAlertLog() {
    if (!alertLogCache) {
      alertLogCache = loadAlertLogFromStorage();
    }
    return alertLogCache;
  }

  function logEntryId(entry) {
    return (
      (entry && entry.eventId) ||
      `${entry && entry.iso}|${entry && entry.serial}|${entry && entry.transition}`
    );
  }

  function markLogEntryChanged(entry) {
    if (entry) {
      logDirtyIds.add(logEntryId(entry));
    }
    scheduleLogWrite();
  }

  function readLogClearedAt() {
    try {
      return Number(localStorage.getItem(LOG_CLEARED_KEY)) || 0;
    } catch (error) {
      return 0;
    }
  }

  function mergeAlertLogWithStorage() {
    const clearedAt = readLogClearedAt();
    const byId = new Map();
    loadAlertLogFromStorage().forEach(entry => {
      if (entry && typeof entry === 'object') {
        byId.set(logEntryId(entry), entry);
      }
    });
    (alertLogCache || []).forEach(entry => {
      const id = logEntryId(entry);
      if (logDirtyIds.has(id)) {
        byId.set(id, entry);
      }
    });
    const merged = [...byId.values()].filter(entry => {
      const time = entryTime(entry);
      return Number.isFinite(time) && time >= logRetentionFloor && time > clearedAt;
    });
    merged.sort((a, b) => entryTime(a) - entryTime(b));
    while (merged.length > MAX_LOG_ENTRIES) {
      merged.shift();
    }
    return merged;
  }

  function flushAlertLog(sync) {
    if (logWriteTimer) {
      clearTimeout(logWriteTimer);
      logWriteTimer = null;
    }
    if (!logWritePending && !sync) {
      return;
    }
    const merged = mergeAlertLogWithStorage();
    if (!logWritePending) {
      alertLogCache = merged;
      return;
    }
    try {
      localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(merged));
      alertLogCache = merged;
      logWritePending = false;
      logDirtyIds.clear();
    } catch (error) {
      fail(
        'Could not write the alert log to localStorage. Entries ' +
          'recorded since the last successful write may be lost on ' +
          'reload. Export the log and clear it to free space.',
        error
      );
    }
  }

  function scheduleLogWrite() {
    logWritePending = true;
    if (logWriteTimer) {
      return;
    }
    logWriteTimer = setTimeout(() => {
      logWriteTimer = null;
      flushAlertLog();
    }, LOG_WRITE_DEBOUNCE_MS);
  }

  function appendAlertLog(entry) {
    const logEntries = getAlertLog();
    logEntries.push(entry);
    let evicted = 0;
    while (logEntries.length > MAX_LOG_ENTRIES) {
      logEntries.shift();
      evicted += 1;
    }
    if (evicted && !appendAlertLog.warnedEviction) {
      appendAlertLog.warnedEviction = true;
      fail(
        `Alert log hit the ${MAX_LOG_ENTRIES}-entry cap and is ` +
          'now discarding the OLDEST entries. Export and clear the ' +
          'log to keep a complete record.'
      );
    }
    markLogEntryChanged(entry);
  }

  function isDebugData(candidate) {
    if (!candidate) {
      return false;
    }
    if (candidate.debug === true) {
      return true;
    }
    const serial = String(candidate.serial || '').toUpperCase();
    const section = String(candidate.section || '').toUpperCase();
    const location = String(candidate.location || '').toUpperCase();
    const title = String(candidate.title || '').toUpperCase();
    return (
      section === 'DEBUG' ||
      serial.startsWith('DEBUG') ||
      location.includes('DEBUG') ||
      title.includes('DEBUG')
    );
  }

  function logRealAlert(info, transition, suppressed) {
    if (isDebugData(info)) {
      devLog(
        'Debug/test transition \u{2014} not written to the alert ' + 'log (real servers only).'
      );
      return '';
    }
    const now = new Date();
    if (suppressed) {
      const entries = getAlertLog();
      const limit = Math.max(0, entries.length - 200);
      for (let i = entries.length - 1; i >= limit; i -= 1) {
        const candidate = entries[i];
        if (
          candidate.transition === transition &&
          candidate.serial === info.serial &&
          candidate.section === info.section &&
          candidate.eve === info.eve &&
          candidate.unit === info.unit
        ) {
          candidate.repeats = (candidate.repeats || 0) + 1;
          candidate.lastRepeatIso = now.toISOString();
          markLogEntryChanged(candidate);
          return candidate.eventId || '';
        }
      }
      return '';
    }
    const eventId = `evt-${now.getTime()}-` + Math.random().toString(36).slice(2, 8);
    appendAlertLog({
      eventId: eventId,
      iso: now.toISOString(),
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString(),
      result: getTransitionTitle(transition),
      transition: transition,
      diagnostic: false,
      phaseSource: 'color',
      resultConfirmed: false,
      taskset: '',
      taskcase: '',
      operation: '',
      pass: '',
      serial: info.serial,
      section: info.section,
      eve: info.eve,
      unit: info.unit,
      serverType: info.serverType || ''
    });
    return eventId;
  }

  function findLogEntry(eventId) {
    if (!eventId) {
      return null;
    }
    const entries = getAlertLog();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i].eventId === eventId) {
        return entries[i];
      }
    }
    return null;
  }

  function isLogEntryResolved(eventId) {
    const entry = findLogEntry(eventId);
    return !!(entry && entry.phaseSource === 'confirmed' && entry.resultConfirmed === true);
  }

  function linkLogEntryToAlert(eventId, alertId) {
    const entry = findLogEntry(eventId);
    if (!entry) {
      return;
    }
    entry.alertId = alertId;
    markLogEntryChanged(entry);
  }

  function writeLogEntryResult(entry, fields) {
    entry.transition = fields.transition;
    entry.result = getTransitionTitle(fields.transition);
    entry.diagnostic = isDiagnosticTransition(fields.transition);
    entry.phaseSource = fields.phaseSource;
    entry.resultConfirmed = fields.resultConfirmed === true;
    entry.operation = fields.operation || '';
    entry.taskset = fields.taskset || '';
    entry.taskcase = fields.taskcase || '';
    entry.pass = fields.pass === 0 || fields.pass === 1 ? String(fields.pass) : '';
    const happened = eventTimeFromDetail(fields.finished, entry.iso);
    if (happened) {
      entry.eventIso = happened;
    }
  }

  function applyConfirmationToLogEntry(eventId, transition, confirmation) {
    const entry = findLogEntry(eventId);
    if (!entry) {
      return;
    }
    if (confirmation && confirmation.confirmed) {
      writeLogEntryResult(entry, {
        transition: resolveTransitionFromDetail(transition, confirmation),
        phaseSource: 'confirmed',
        resultConfirmed: !!confirmation.resultConfirmed,
        operation: confirmation.operation,
        taskset: confirmation.taskset,
        taskcase: confirmation.taskcase,
        pass: confirmation.pass,
        finished: confirmation.finished
      });
    } else {
      entry.phaseSource = 'unverified';
      entry.resultConfirmed = false;
      entry.unverifiedReason = (confirmation && confirmation.reason) || 'unknown';
    }
    markLogEntryChanged(entry);
  }

  function loadRealAlertLog() {
    const win = currentShiftWindow();
    return getAlertLog().filter(entry => !isDebugData(entry) && isEntryInShiftWindow(entry, win));
  }

  // ===== LOG FORMATTING HELPERS =====

  function formatDuration(ms) {
    const totalMinutes = Math.max(0, Math.floor(ms / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days) {
      return `${days}d ${hours}h`;
    }
    if (hours) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  function padOrTrim(text, width) {
    const value = String(text === undefined || text === null ? '' : text);
    if (value.length === width) {
      return value;
    }
    if (value.length > width) {
      return width > 1 ? value.slice(0, width - 1) + '\u{2026}' : value.slice(0, width);
    }
    return value + ' '.repeat(width - value.length);
  }

  const SITE_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  function isoDateParts(iso) {
    const parsed = iso ? new Date(iso) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return { date: '', time: '' };
    }
    const p = {};
    SITE_PARTS_FORMAT.formatToParts(parsed).forEach(part => {
      p[part.type] = part.value;
    });
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
  }

  function siteDateTime(date) {
    return date.toLocaleString('en-US', { timeZone: SITE_TIME_ZONE, timeZoneName: 'short' });
  }

  // "2026-09-23 02:39:49" as shown on the detail page (Fremont wall clock) ->
  // epoch ms. Corrects the UTC guess by the Pacific offset at that moment, so
  // PDT/PST follow the date. NaN when the text is not a date-time.
  function siteTimeToMs(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      String(text || '').trim()
    );
    if (!m) {
      return NaN;
    }
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (Number.isNaN(wall)) {
      return NaN;
    }
    let ms = wall;
    for (let i = 0; i < 2; i += 1) {
      const p = isoDateParts(new Date(ms).toISOString());
      const d = p.date.split('-').map(Number);
      const t = p.time.split(':').map(Number);
      ms += wall - Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], t[2]);
    }
    return ms;
  }

  // When the result actually happened: the detail page's Finished time, if it
  // is plausible for this detection (not after it beyond clock skew, not more
  // than a day before it). Otherwise '' and the detection time is used.
  const EVENT_TIME_SKEW_MS = 10 * 60 * 1000;
  const EVENT_TIME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function eventTimeFromDetail(finished, detectedIso) {
    const at = siteTimeToMs(finished);
    const detected = Date.parse(detectedIso || '');
    if (!Number.isFinite(at) || !Number.isFinite(detected)) {
      return '';
    }
    if (at > detected + EVENT_TIME_SKEW_MS || at < detected - EVENT_TIME_MAX_AGE_MS) {
      return '';
    }
    return new Date(at).toISOString();
  }

  function entryWhenIso(entry) {
    return entry.eventIso || entry.iso;
  }
  const LOG_CATEGORIES = Object.keys(TRANSITIONS).map(key => ({
    transition: key,
    heading: TRANSITIONS[key].logHeading
  }));
  const LOG_COLUMNS = [
    { label: '#', width: 5 },
    { label: 'DATE', width: 12 },
    { label: 'TIME', width: 11 },
    { label: 'SERIAL', width: 22 },
    { label: 'LOCATION', width: 24 }
  ];
  const LOG_TABLE_WIDTH = LOG_COLUMNS.reduce((sum, column) => sum + column.width, 0);
  const LOG_RULE = '='.repeat(LOG_TABLE_WIDTH + 2);
  const LOG_THIN = '-'.repeat(LOG_TABLE_WIDTH);

  function buildLogTable(entries, lines) {
    lines.push(
      '  ' +
        LOG_COLUMNS.map(column => padOrTrim(column.label, column.width))
          .join('')
          .trimEnd()
    );
    lines.push('  ' + LOG_THIN);
    entries.forEach((entry, index) => {
      const parts = isoDateParts(entryWhenIso(entry));
      lines.push(
        '  ' +
          padOrTrim(index + 1, LOG_COLUMNS[0].width) +
          padOrTrim(parts.date || entry.date, LOG_COLUMNS[1].width) +
          padOrTrim(parts.time || entry.time, LOG_COLUMNS[2].width) +
          padOrTrim(entry.serial, LOG_COLUMNS[3].width) +
          `${entry.section} \u{2022} ${entry.eve} \u{2022} ${entry.unit}`
      );
    });
  }

  // ===== .TXT REPORT =====

  function buildAlertLogText() {
    if (IS_LION_KING_PAGE) return buildLionKingLog(false);
    const logEntries = loadRealAlertLog();
    const win = currentShiftWindow();
    const lines = [];
    lines.push(
      LOG_RULE,
      'eve_slt_Jbog_tracker \u{2014} ALERT LOG',
      'by Zay Davidson',
      `Tracker version: ${SCRIPT_VERSION}`,
      LOG_RULE,
      '',
      `Exported:      ${siteDateTime(new Date())}`,
      `Shift:         ${shiftWindowLabel(win)}`,
      `Log window:    ${siteDateTime(win.opens)} \u{2013} ` + `${siteDateTime(win.closes)}`
    );
    if (logEntries.length) {
      const times = logEntries.map(entry => Date.parse(entryWhenIso(entry)));
      const first = new Date(Math.min(...times));
      const last = new Date(Math.max(...times));
      lines.push(
        `First alert:   ${siteDateTime(first)}`,
        `Last alert:    ${siteDateTime(last)}`,
        `Time span:     ${formatDuration(last - first)}`
      );
    }
    lines.push(
      `Total alerts:  ${logEntries.length}`,
      '',
      `This log covers ONE ${win.shift.label.toUpperCase()} SHIFT: every entry in`,
      `the log window above (the shift plus ${SHIFT_EARLY_MIN} min before and`,
      `${SHIFT_LATE_MIN} min after). Entries outside it are not included.`,
      'The previous shift is cleared automatically when the next',
      'one opens - never at midnight, never mid-shift.',
      ''
    );
    const unverified = logEntries.filter(e => (e.phaseSource || 'color') !== 'confirmed').length;
    if (unverified) {
      lines.push(
        '',
        `WARNING: ${unverified} of ${logEntries.length} entries ` + 'have an UNCONFIRMED phase.',
        '      The PRE-TEST vs TEST half of those categories was',
        '      inferred from cell colour, which does not reliably',
        '      encode phase. Treat them as "fail"/"pass" only.'
      );
    }
    lines.push(
      '',
      'Note: debug/test notifications are NOT recorded here.',
      '      Every entry is a real detected transition.',
      '      Section "Notifs" being off does NOT affect this',
      '      log - muted sections are still recorded.',
      ''
    );
    if (!logEntries.length) {
      lines.push(
        LOG_RULE,
        'No alerts recorded this shift yet.',
        LOG_RULE,
        'Report bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues'
      );
      return lines.join('\n');
    }
    const grouped = {};
    LOG_CATEGORIES.forEach(category => {
      grouped[category.transition] = logEntries.filter(
        entry => entry.transition === category.transition
      );
    });
    const known = LOG_CATEGORIES.map(c => c.transition);
    const other = logEntries.filter(entry => known.indexOf(entry.transition) === -1);
    lines.push(LOG_RULE, 'SUMMARY', LOG_RULE);
    const resultEntries = logEntries.filter(entry => !entry.diagnostic);
    LOG_CATEGORIES.forEach(category => {
      const count = grouped[category.transition].length;
      const diagnosticCategory = isDiagnosticTransition(category.transition);
      const denominator = diagnosticCategory ? logEntries.length : resultEntries.length;
      const share = denominator ? Math.round((count / denominator) * 100) : 0;
      lines.push('  ' + padOrTrim(category.heading, 46) + padOrTrim(count, 8) + `${share}%`);
    });
    lines.push(
      '',
      `  Hardware results: ${resultEntries.length}` +
        `  \u{2022}  SYS_DEKIT diagnostics: ` +
        `${logEntries.length - resultEntries.length}`,
      '  Percentages above are of hardware results only, except',
      '  the SYS_DEKIT rows, which are of all entries.'
    );
    if (other.length) {
      lines.push('  ' + padOrTrim('OTHER', 20) + padOrTrim(other.length, 8));
    }
    lines.push('');
    const bySection = {};
    logEntries.forEach(entry => {
      bySection[entry.section] = (bySection[entry.section] || 0) + 1;
    });
    const sectionNames = Object.keys(bySection).sort();
    if (sectionNames.length > 1) {
      lines.push(LOG_RULE, 'ALERTS BY SECTION', LOG_RULE);
      sectionNames.forEach(section => {
        lines.push('  ' + padOrTrim(section, 20) + bySection[section]);
      });
      lines.push('');
    }
    LOG_CATEGORIES.forEach(category => {
      const entries = grouped[category.transition];
      lines.push(LOG_RULE, `${category.heading} (${entries.length})`, LOG_RULE);
      if (!entries.length) {
        lines.push('  None recorded.');
      } else {
        buildLogTable(entries, lines);
      }
      lines.push('');
    });
    if (other.length) {
      lines.push(LOG_RULE, `OTHER (${other.length})`, LOG_RULE);
      buildLogTable(other, lines);
      lines.push('');
    }
    lines.push(LOG_RULE, `FULL CHRONOLOGICAL RECORD (${logEntries.length})`, LOG_RULE);
    if (logEntries.length > MAX_CHRONOLOGICAL_ENTRIES) {
      lines.push(
        `  Omitted: ${logEntries.length} entries exceeds the ` +
          `${MAX_CHRONOLOGICAL_ENTRIES}-entry cap for this section.`,
        '  Every entry appears above in its category table, and',
        '  the .csv export contains the full chronological data.'
      );
    } else {
      logEntries.forEach((entry, index) => {
        const at = isoDateParts(entryWhenIso(entry));
        lines.push(
          `[${index + 1}] ${at.date || entry.date} ${at.time || entry.time} \u{2014} ` + `${entry.result}`,
          `      Serial #: ${entry.serial}`,
          `      Location: ${entry.section} \u{2022} ` + `${entry.eve} \u{2022} ${entry.unit}`
        );
        if (entry.serverType) {
          lines.push(`      Type:     ${entry.serverType}`);
        }
        if (entry.eventIso) {
          const seen = isoDateParts(entry.iso);
          lines.push(`      Detected: ${seen.date} ${seen.time} (time above: detail page Finished)`);
        }
        lines.push(`      ISO:      ${entry.iso}`, '');
      });
    }
    lines.push(
      '',
      LOG_RULE,
      'Report bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues',
      LOG_RULE
    );
    return lines.join('\n');
  }

  // ===== .CSV EXPORT =====

  function csvEscape(value) {
    let text = String(value === undefined || value === null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
    }
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function buildAlertLogCsv() {
    if (IS_LION_KING_PAGE) return buildLionKingLog(true);
    const logEntries = loadRealAlertLog();
    const rows = [];
    rows.push(
      [
        'Date',
        'Time',
        'ISO Timestamp',
        'Result',
        'Category',
        'Serial',
        'Section',
        'EVE',
        'Unit',
        'Server Type',
        'Repeats',
        'Category Kind',
        'Phase Source',
        'Result Verified',
        'Operation',
        'Pass',
        'Taskset',
        'Taskcase',
        'Notified',
        'Time Source',
        'Detected At'
      ].join(',')
    );
    logEntries.forEach(entry => {
      const parts = isoDateParts(entryWhenIso(entry));
      const seen = isoDateParts(entry.iso);
      rows.push(
        [
          parts.date,
          parts.time,
          entry.iso,
          entry.result,
          transitionMeta(entry.transition)
            ? transitionMeta(entry.transition).csvName
            : entry.transition,
          entry.serial,
          entry.section,
          entry.eve,
          entry.unit,
          entry.serverType || '',
          entry.repeats || 0,
          entry.diagnostic ? 'diagnostic' : 'result',
          entry.phaseSource || 'color',
          entry.resultConfirmed === true ? 'yes' : 'no',
          entry.operation || '',
          entry.pass === undefined ? '' : entry.pass,
          entry.taskset || '',
          entry.taskcase || '',
          entry.alertId ? 'yes' : 'no',
          entry.eventIso ? 'detail page Finished' : 'detected',
          `${seen.date} ${seen.time}`
        ]
          .map(csvEscape)
          .join(',')
      );
    });
    return rows.join('\r\n');
  }

  // ===== DOWNLOAD / EXPORT / CLEAR =====

  function downloadFile(content, extension, mimeType) {
    try {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const time = isoDateParts(new Date().toISOString()).time.replace(/:/g, '-');
      const win = currentShiftWindow();
      const link = document.createElement('a');
      link.href = url;
      link.download =
        `eve_slt_Jbog_tracker-log-${localDateKey(win.starts)}-${win.id}-` + `${time}.${extension}`;
      withoutObserver(() => {
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return true;
    } catch (error) {
      fail('Export failed:', error);
      return false;
    }
  }
  const LOG_EXPORTS = {
    txt: { build: buildAlertLogText, mime: 'text/plain;charset=utf-8' },
    csv: { build: buildAlertLogCsv, mime: 'text/csv;charset=utf-8' }
  };

  function exportLog(kind) {
    const spec = LOG_EXPORTS[kind];
    if (!spec) {
      fail(`Unknown export format "${kind}".`);
      return;
    }
    flushAlertLog(true);
    const count = loadRealAlertLog().length;
    if (downloadFile(spec.build(), kind, spec.mime)) {
      log(`Exported alert log as .${kind} (${count} real entries).`);
    }
  }

  function clearAlertLog() {
    flushAlertLog(true);
    const count = loadRealAlertLog().length;
    const total = getAlertLog().length;
    if (!total) {
      log('Alert log is already empty.');
      return;
    }
    const other = total - count;
    const extra = other
      ? `\n(${other === 1 ? '1 other stored entry' : `${other} other stored entries`} ` +
        '- outside this shift or old test data - will also be removed.)'
      : '';
    const confirmed = window.confirm(
      `Permanently delete all ${count} alert(s) logged this shift?\n` +
        `${shiftWindowLabel(currentShiftWindow())}${extra}\n\n` +
        'This cannot be undone. Export the log first if you need to ' +
        'keep a record.'
    );
    if (!confirmed) {
      return;
    }
    try {
      alertLogCache = [];
      logWritePending = false;
      logDirtyIds.clear();
      if (logWriteTimer) {
        clearTimeout(logWriteTimer);
        logWriteTimer = null;
      }
      localStorage.setItem(LOG_CLEARED_KEY, String(Date.now()));
      localStorage.removeItem(ALERT_LOG_KEY);
      log(`Alert log cleared (${total} entries removed).`);
    } catch (error) {
      fail('Could not clear the alert log:', error);
    }
  }

  // ===== COPY TO CLIPBOARD =====

  // Serial numbers and Jira keys. `idle` is the hint text to restore.
  function copyToClipboard(text, buttonEl, idle) {
    function showCopied(ok) {
      if (!buttonEl) {
        return;
      }
      const hint = buttonEl.querySelector('.eve-alert-copy-hint');
      if (!hint) {
        return;
      }
      hint.textContent = ok ? '\u{2713} copied' : '\u{2715} failed';
      buttonEl.classList.add(ok ? 'eve-copied' : 'eve-copy-failed');
      setTimeout(() => {
        hint.textContent = idle || '\u{29c9} copy';
        buttonEl.classList.remove('eve-copied', 'eve-copy-failed');
      }, 1500);
    }

    function fallbackCopy() {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        let ok = false;
        withoutObserver(() => {
          document.body.appendChild(textarea);
          textarea.select();
          ok = document.execCommand('copy');
          document.body.removeChild(textarea);
        });
        showCopied(ok);
        devLog(`${text} copied (fallback method).`);
      } catch (error) {
        showCopied(false);
        fail('Clipboard copy failed:', error);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          showCopied(true);
          devLog(`${text} copied to clipboard.`);
        })
        .catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  // ===== RELATIVE TIME LABELS =====

  function formatRelativeTime(ts) {
    if (!ts) {
      return '';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    let relative;
    if (seconds < 10) {
      relative = 'just now';
    } else if (seconds < 60) {
      relative = `${seconds}s ago`;
    } else if (seconds < 3600) {
      relative = `${Math.floor(seconds / 60)}m ago`;
    } else if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      relative = mins ? `${hours}h ${mins}m ago` : `${hours}h ago`;
    } else {
      relative = `${Math.floor(seconds / 86400)}d ago`;
    }
    const clock = IS_LION_KING_PAGE
      ? new Date(ts).toLocaleTimeString('en-US', { timeZone: SITE_TIME_ZONE, timeZoneName: 'short' })
      : new Date(ts).toLocaleTimeString();
    return `\u{1f552} ${relative} \u{b7} ${clock}`;
  }
  const ALERT_AGED_MS = 45 * 60 * 1000;

  function isAlertAged(ts) {
    const time = Number(ts) || 0;
    return time > 0 && Date.now() - time >= ALERT_AGED_MS;
  }

  function refreshRelativeTimes() {
    document.querySelectorAll('.eve-alert-time[data-ts]').forEach(el => {
      const ts = Number(el.dataset.ts);
      if (ts) {
        el.textContent = formatRelativeTime(ts);
        const card = el.closest('.eve-alert');
        if (card) {
          card.classList.toggle('eve-alert-aged', isAlertAged(ts));
        }
      }
    });
  }

  // ===== ESCAPE HTML =====
  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text).replace(
      /[&<>"']/g,
      ch => HTML_ESCAPES[ch]
    );
  }

  // ===== ALERT PERSISTENCE ACROSS REFRESHES =====

  function loadActiveAlerts() {
    const parsed = readJSON(sessionStorage, ACTIVE_ALERTS_KEY, null, 'Active alert');
    return Array.isArray(parsed) ? parsed.filter(isRecordObject) : [];
  }

  function saveActiveAlerts(alerts) {
    writeJSON(sessionStorage, ACTIVE_ALERTS_KEY, alerts, 'Active alert');
  }

  function storeAlert(record) {
    const alerts = loadActiveAlerts();
    alerts.push(record);
    while (alerts.length > MAX_STORED_ALERTS) {
      const debugIndex = alerts.findIndex(a => isDebugData(a));
      alerts.splice(debugIndex === -1 ? 0 : debugIndex, 1);
    }
    saveActiveAlerts(alerts);
  }

  function removeStoredAlert(alertId) {
    saveActiveAlerts(loadActiveAlerts().filter(record => record.id !== alertId));
  }

  function clearStoredAlerts() {
    saveActiveAlerts([]);
  }

  function infoFromRecord(record) {
    const parts = String(record.location || '')
      .split('\u{2022}')
      .map(part => part.trim());
    return {
      serial: record.serial || '',
      detailUrl: record.detailUrl || '',
      section: record.section || parts[0] || '',
      eve: record.eve || parts[1] || '',
      unit: record.unit || parts[2] || ''
    };
  }

  function needsReconfirmation(record) {
    if (record && record.tracker === 'lionking') {
      return false;
    }
    if (!record || !record.detailUrl || isDebugData(record)) {
      return false;
    }
    return record.phaseSource !== 'confirmed' || record.resultConfirmed !== true;
  }
  const RESULT_RETRY_MAX_ATTEMPTS = 8;
  const confirmationsInFlight = new Set();

  function trackConfirmation(record, promise) {
    confirmationsInFlight.add(record.id);
    const done = () => confirmationsInFlight.delete(record.id);
    return Promise.resolve(promise).then(
      result => {
        done();
        return result;
      },
      error => {
        done();
        throw error;
      }
    );
  }

  function reconfirmRecord(record) {
    const attempts = Number(record.resultAttempts) || 0;
    if (attempts >= RESULT_RETRY_MAX_ATTEMPTS || confirmationsInFlight.has(record.id)) {
      return false;
    }
    record.resultAttempts = attempts + 1;
    updateStoredAlert(record);
    trackConfirmation(
      record,
      confirmPhase(safeUrl(record.detailUrl), infoFromRecord(record), { live: false, force: true })
    )
      .then(result => reconcileAlertPhase(record, result))
      .catch(error => {
        fail('Re-confirmation threw:', error);
        reconcileAlertPhase(record, null);
      });
    return true;
  }

  function chaseStaleConfirmations(alerts) {
    let started = 0;
    alerts.filter(needsReconfirmation).forEach(record => {
      if (reconfirmRecord(record)) {
        started += 1;
      }
    });
    return started;
  }

  function retryPendingConfirmations() {
    const started = chaseStaleConfirmations(loadActiveAlerts());
    if (started) {
      devLog(`Re-checking ${started} alert(s) whose result is still ` + 'pending.');
    }
  }

  function restorePersistedAlerts() {
    const alerts = loadActiveAlerts();
    if (!alerts.length) {
      return;
    }
    alerts.forEach(record => {
      try {
        renderAlertElement(record, false);
      } catch (error) {
        warn('Skipped a saved alert that could not be shown:', error);
      }
    });
    log(`Restored ${alerts.length} alert(s) that survived the page refresh.`);
    const stale = alerts.filter(needsReconfirmation);
    if (!stale.length) {
      return;
    }
    log(
      `Re-confirming ${stale.length} restored alert(s) with an ` +
        'unverified phase or an unresolved result.'
    );
    stale.forEach(record => reconfirmRecord(record));
  }

  // ===== CARDS WHOSE SERVER HAS LEFT ITS SLOT =====
  // A card can outlive its server: the unit is pulled or swapped and its
  // cell now holds another serial, or nothing. Such a card is struck
  // through and tagged, not removed (it is still the record of what
  // happened). Only for columns this page shows - a card from a rack not
  // on this page is left alone. A retest (same serial, new colour) is not
  // "gone".
  function markGoneCards(groups, seenKeys) {
    const columns = new Set();
    groups.forEach(group => group.headers.forEach(h => columns.add(`${h.section}|${h.eve}`)));
    document.querySelectorAll('#eve-alert-body .eve-alert[data-slot]').forEach(card => {
      const slot = card.dataset.slot;
      const serial = card.dataset.serial;
      if (!slot || !serial || !columns.has(slot.split('|').slice(0, 2).join('|'))) {
        return;
      }
      const now = seenKeys.has(slot) ? previousStates.get(slot) : null;
      const gone = !now || now.serial !== serial;
      card.classList.toggle('eve-alert-gone', gone);
      // The tag takes the copy hint's place in the serial box, and copying
      // is off: the serial is no longer in the rack. Jira and TestView stay.
      const serialBox = card.querySelector('button.eve-alert-serial');
      if (serialBox) {
        serialBox.disabled = gone;
        serialBox.title = gone ? '' : 'Click to copy serial number';
      }
      let tag = card.querySelector('.eve-gone-tag');
      if (gone && !tag && serialBox) {
        tag = document.createElement('span');
        tag.className = 'eve-gone-tag';
        tag.textContent = 'Removed from rack';
        serialBox.appendChild(tag);
      } else if (!gone && tag) {
        tag.remove();
      }
      if (gone && tag) {
        tag.title =
          `${serial} is no longer in ${slot.split('|').join(' \u{2022} ')}` +
          (now && now.serial ? ` (now ${now.serial}).` : ' (the slot is empty).');
      }
    });
  }

  // ===== CREATE PERSISTENT IN-PAGE ALERT =====

  function createPersistentAlert(title, info, transition) {
    const record = {
      id: `alert-${Date.now()}-` + Math.random().toString(36).slice(2, 8),
      title: title,
      transition: transition,
      debug: isDebugData(info),
      serial: info && info.serial ? info.serial : '',
      detailUrl: info && info.detailUrl ? safeUrl(info.detailUrl) : '',
      location: info ? `${info.section} \u{2022} ${info.eve} \u{2022} ${info.unit}` : '',
      section: info ? info.section : '',
      eve: info ? info.eve : '',
      unit: info ? info.unit : '',
      statusLine: getStatusLine(transition),
      eventId: '',
      notifiedTransition: '',
      phaseSource: 'color',
      taskset: '',
      taskcase: '',
      operation: '',
      passFlag: null,
      resultConfirmed: false,
      phaseExact: false,
      pendingReason: '',
      ts: Date.now()
    };
    renderAlertElement(record, true);
    revealNewAlert(record.id);
    return record;
  }

  // ===== RECONCILE A CARD WITH THE CONFIRMED PHASE =====

  function buildPhaseNote(record) {
    if (!record) {
      return '';
    }
    if (record.phaseSource === 'unverified') {
      return `\u{26a0} phase NOT verified \u{2014} ` + `${record.unverifiedReason || 'unknown'}`;
    }
    if (record.phaseSource !== 'confirmed') {
      return '';
    }
    const parts = [record.operation || record.phase || 'detail page'];
    if (record.passFlag === 0 || record.passFlag === 1) {
      parts.push(`Pass=${record.passFlag}`);
    }
    if (record.taskset) {
      parts.push(record.taskset);
    }
    if (record.passFlag === 0 && record.taskcase) {
      parts.push(
        record.taskcase.length > 48 ? `${record.taskcase.slice(0, 48)}\u{2026}` : record.taskcase
      );
    }
    const head =
      record.resultConfirmed === undefined
        ? '\u{2713} phase confirmed'
        : record.resultConfirmed
          ? '\u{2713} confirmed'
          : '\u{23f3} result pending';
    const tail =
      !record.resultConfirmed && record.pendingReason ? ` \u{2014} ${record.pendingReason}` : '';
    return `${head}\u{a0}\u{b7}\u{a0}${parts.join(' \u{b7} ')}${tail}`;
  }

  function reconcileAlertPhase(record, confirmation) {
    if (!record) {
      return;
    }
    const before = record.transition;
    if (confirmation && confirmation.confirmed) {
      record.transition = resolveTransitionFromDetail(before, confirmation);
      record.phaseSource = 'confirmed';
      record.taskset = confirmation.taskset || '';
      record.taskcase = confirmation.taskcase || '';
      record.operation = confirmation.operation || '';
      record.finished = confirmation.finished || '';
      record.phase = confirmation.phase || '';
      record.passFlag =
        confirmation.pass === 0 || confirmation.pass === 1 ? confirmation.pass : null;
      record.resultConfirmed = !!confirmation.resultConfirmed;
      record.phaseExact = !!confirmation.phaseExact;
      record.pendingReason = confirmation.resultConfirmed ? '' : confirmation.reason || '';
    } else {
      record.phaseSource = 'unverified';
      record.unverifiedReason = (confirmation && confirmation.reason) || 'unknown';
    }
    record.title = getTransitionTitle(record.transition);
    record.statusLine = getStatusLine(record.transition);
    if (before !== record.transition) {
      log(
        `${record.serial} re-labelled ${before} \u{2192} ` +
          `${record.transition} from the detail page ` +
          `(taskset: ${record.taskset || 'n/a'}).`
      );
      if (record.notifiedTransition && record.notifiedTransition !== record.transition) {
        const announced = record.notifiedTransition;
        record.notifiedTransition = record.transition;
        notifyLabelCorrection(record, announced);
      }
    }
    updateAlertCard(record);
    updateStoredAlert(record);
    updateLogEntryForAlert(record);
  }

  function updateAlertCard(record) {
    const card = document.querySelector(`.eve-alert[data-alert-id="${CSS.escape(record.id)}"]`);
    if (!card) {
      return;
    }
    applyCardState(card, record);
    syncJiraForCard(card, record);
    const titleEl = card.querySelector('.eve-alert-header span');
    if (titleEl) {
      titleEl.textContent = record.title;
    }
    const statusEl = card.querySelector('.eve-alert-status');
    if (statusEl) {
      statusEl.textContent = record.statusLine || '';
    }
    let noteEl = card.querySelector('.eve-alert-phase-note');
    const noteText = buildPhaseNote(record);
    if (!noteText) {
      if (noteEl) {
        noteEl.remove();
      }
      applyAlertFilter();
      return;
    }
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.className = 'eve-alert-phase-note';
      const timeEl =
        card.querySelector('.eve-alert-footer') || card.querySelector('.eve-alert-time');
      if (timeEl && timeEl.parentNode === card) {
        card.insertBefore(noteEl, timeEl);
      } else {
        card.appendChild(noteEl);
      }
    }
    noteEl.textContent = noteText;
    applyAlertFilter();
  }

  function updateStoredAlert(record) {
    const alerts = loadActiveAlerts();
    const index = alerts.findIndex(a => a.id === record.id);
    if (index === -1) {
      return;
    }
    alerts[index] = { ...alerts[index], ...record };
    saveActiveAlerts(alerts);
  }

  function updateLogEntryForAlert(record) {
    const entries = getAlertLog();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const matches =
        (record.eventId && entry.eventId === record.eventId) ||
        (entry.alertId && entry.alertId === record.id);
      if (!matches) {
        continue;
      }
      writeLogEntryResult(entry, {
        transition: record.transition,
        phaseSource: record.phaseSource,
        resultConfirmed: record.resultConfirmed,
        operation: record.operation,
        taskset: record.taskset,
        taskcase: record.taskcase,
        pass: record.passFlag,
        finished: record.finished
      });
      markLogEntryChanged(entry);
      return;
    }
  }

  // ===== RENDER ONE ALERT CARD =====
  const ALERT_CLASS_BY_TRANSITION = Object.fromEntries(
    Object.keys(TRANSITIONS).map(key => [key, TRANSITIONS[key].css])
  );

  function isCardClickable(record) {
    return !!(record.serial || safeUrl(record.detailUrl));
  }

  function openCardTarget(record) {
    if (record.tracker === 'lionking') {
      if (isDebugData(record)) return;
      openLionKingTestView(record.tailSerial || record.serial, record.started, openExternal,
        record.operation || (record.transition === 'PRETEST_FAILURE' ? 'PRETEST' : undefined));
      return;
    }
    if (record.serial) {
      openTestView(record.serial, openExternal);
      return;
    }
    openExternal(record.detailUrl);
  }

  function applyCardState(element, record) {
    const alertClass = ALERT_CLASS_BY_TRANSITION[record.transition] || 'eve-failure';
    element.className =
      `eve-alert ${alertClass}` +
      (isCardClickable(record) ? ' eve-alert-clickable' : '') +
      (record.phaseSource === 'unverified' ? ' eve-alert-unverified' : '') +
      (isAlertAged(record.ts) ? ' eve-alert-aged' : '');
    element.dataset.transition = record.transition || '';
    element.dataset.diagnostic = isDiagnosticTransition(record.transition) ? '1' : '0';
  }

  function renderAlertElement(record, shouldStore) {
    if (IS_LION_KING_PAGE && record.tracker === 'lionking' && !isDebugData(record)) {
      record = { ...record, ...lionPhysicalLocation(record) };
    }
    const container = getAlertContainer();
    const alert = document.createElement('div');
    const clickable = isCardClickable(record);
    applyCardState(alert, record);
    if (clickable) {
      alert.title = record.tracker === 'lionking'
        ? record.started ? 'Open this Lion King run in TestView 2.0' : 'Open the latest Lion King test in TestView 2.0'
        : record.serial
        ? 'Click anywhere on this alert to open this serial in TestView'
        : 'Click anywhere on this alert to open Server Detail';
    }
    alert.dataset.alertId = record.id;
    alert.dataset.slot =
      record.section && record.eve && record.unit ? `${record.section}|${record.eve}|${record.unit}` : '';
    alert.dataset.serial = record.serial || '';
    if (record.tracker === 'lionking') {
      alert.dataset.tracker = 'lionking';
      alert.dataset.headSerial = record.headSerial || '';
    }
    alert.dataset.debug = isDebugData(record) ? '1' : '0';
    alert.dataset.search = `${record.serial || ''} ${record.location || ''}` +
      (record.tracker === 'lionking' ? ` ${record.headSerial || ''} ${record.started || ''}` : '');
    const ts = Number(record.ts) || 0;
    const phaseNote = buildPhaseNote(record);
    const serialBlock = record.tracker === 'lionking'
      ? ['tail', 'head'].filter(node => record[node + 'Serial']).map(node => `<button class="eve-alert-serial lion-node-serial"
          data-node="${node}" title="Copy ${node} node serial">
          <span>${record.source === 'ramses' ? 'JBOG' : node === 'tail' ? 'Tail' : 'Head'}: </span>
          <span class="eve-alert-serial-value">${escapeHtml(record[node + 'Serial'])}</span>
          <span class="eve-alert-copy-hint">copy</span></button>`).join('')
      : record.serial
      ? `
<button
class="eve-alert-serial"
title="Click to copy serial number"
>
<span class="eve-alert-serial-value">${escapeHtml(record.serial)}</span>
<span class="eve-alert-copy-hint">\u{29c9} copy</span>
</button>
`
      : `
<div class="eve-alert-serial eve-alert-serial-empty">
<span class="eve-alert-serial-value">\u{2014}</span>
</div>
`;
    alert.innerHTML = `
<div class="eve-alert-header">
<span>
${escapeHtml(record.title)}
</span>
<button
class="eve-alert-close"
title="Dismiss"
>
\u{d7}
</button>
</div>
${serialBlock}
<div class="eve-alert-loc">
\u{1f4cd} ${escapeHtml(record.location || '')}
</div>
${record.tracker === 'lionking' && record.started ? `<div class="eve-alert-started">Started: ${escapeHtml(record.started)}</div>` : ''}
${record.tracker === 'lionking' && record.finished ? `<div class="eve-alert-started">Finished: ${escapeHtml(record.finished)}${Number.isFinite(record.durationMs) ? ' - ' + escapeHtml(lionHoursMinutes(record.durationMs)) : ''}</div>` : ''}
<div class="eve-alert-status">
${escapeHtml(record.statusLine || '')}
</div>
${phaseNote ? `<div class="eve-alert-phase-note">${escapeHtml(phaseNote)}</div>` : ''}
<div class="eve-alert-footer">
<div
class="eve-alert-time"
data-ts="${ts}"
>
${escapeHtml(formatRelativeTime(ts))}
</div>
</div>
`;
    if (record.serial) {
      alert.querySelector('.eve-alert-footer').appendChild(buildJiraGroup(record.serial));
    }
    if (clickable) {
      alert.addEventListener('click', event => {
        if (
          event.target.closest('.eve-alert-serial') ||
          event.target.closest('.eve-alert-close') ||
          event.target.closest('.eve-jira-group')
        ) {
          return;
        }
        openCardTarget(record);
      });
    }
    alert.querySelector('.eve-alert-close').addEventListener('click', () => {
      removeStoredAlert(record.id);
      alert.remove();
      refreshAlertChrome();
    });
    const serialButton = alert.querySelector('button.eve-alert-serial');
    if (record.tracker === 'lionking') {
      alert.querySelectorAll('.lion-node-serial').forEach(button => {
        button.addEventListener('click', () =>
          copyToClipboard(record[button.dataset.node + 'Serial'], button));
      });
    } else if (serialButton && record.serial) {
      serialButton.addEventListener('click', () =>
        copyToClipboard(record.serial, serialButton)
      );
    }
    container.insertBefore(alert, container.firstChild);
    while (container.children.length > (record.tracker === 'lionking' ? MAX_STORED_ALERTS : MAX_RENDERED_ALERTS)) {
      container.lastElementChild.remove();
    }
    syncJiraForCard(alert, record);
    if (shouldStore) {
      storeAlert(record);
    }
    refreshAlertChrome();
  }

  // ===== ALERT CONTAINER =====

  function setAlertsCollapsed(collapsed) {
    const container = document.getElementById('eve-alert-container');
    if (!container) {
      return;
    }
    container.classList.toggle('eve-alerts-collapsed', collapsed);
    const caret = document.getElementById('eve-alert-caret');
    if (caret) {
      caret.textContent = collapsed ? '\u{25b8}' : '\u{25be}';
    }
    try {
      sessionStorage.setItem(ALERTS_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch (error) {}
  }

  function revealNewAlert(alertId) {
    const container = document.getElementById('eve-alert-container');
    if (!container || !container.classList.contains('eve-alerts-collapsed')) {
      return;
    }
    const card = Array.prototype.find.call(
      container.querySelectorAll('.eve-alert'),
      el => el.dataset.alertId === alertId
    );
    if (card && card.style.display !== 'none') {
      setAlertsCollapsed(false);
    }
  }

  function getAlertContainer() {
    const existing = document.getElementById('eve-alert-body');
    if (existing) {
      return existing;
    }
    const container = document.createElement('div');
    container.id = 'eve-alert-container';
    container.innerHTML = `
<div id="eve-alert-header">
<span id="eve-alert-toggle">
<span id="eve-alert-caret">\u{25be}</span>
\u{1f514} JIRAlerts
<span id="eve-alert-count">(0)</span>
</span>
<span id="eve-alert-header-actions">
<button id="eve-alert-menu-btn" type="button" aria-haspopup="menu" aria-expanded="false"
aria-controls="eve-alert-menu" title="Export log / dismiss cards">\u{22ef}</button>
</span>
</div>
<div id="eve-alert-menu" role="menu" aria-label="JIRAlerts actions" hidden>
<button id="eve-alert-export" type="button" role="menuitem"
title="Save this shift's real notifications to a .txt report">
<span class="eve-menu-icon">\u{1f4be}</span>Export shift log (.txt)
</button>
<button id="eve-alert-export-csv" type="button" role="menuitem"
title="Save this shift's real notifications to a .csv for Excel">
<span class="eve-menu-icon">\u{1f4ca}</span>Export for Excel (.csv)
</button>
<div class="eve-menu-sep" role="separator"></div>
<button id="eve-alert-dismiss-all" type="button" role="menuitem"
title="Dismiss all alerts on screen (the exportable log is NOT affected)">
<span class="eve-menu-icon">\u{2715}</span>Dismiss all cards
</button>
</div>
<div id="eve-alert-toolbar">
<div id="eve-alert-filters">
<button class="eve-filter-btn eve-filter-category eve-filter-active"
data-filter="all">All<span class="eve-chip-count"></span></button>
<button class="eve-filter-btn eve-filter-category"
data-filter="TEST_FAILURE">Fails<span class="eve-chip-count"></span></button>
<button class="eve-filter-btn eve-filter-category"
data-filter="PRETEST_FAILURE">Pre-test<span class="eve-chip-count"></span></button>
<button class="eve-filter-btn eve-filter-category"
data-filter="TEST_SUCCESS">Passes<span class="eve-chip-count"></span></button>
</div>
<input
type="search"
id="eve-alert-search"
placeholder="Search serial, location or Jira\u{2026}"
>
</div>
<div id="eve-alert-body"></div>
`;
    withoutObserver(() => document.body.appendChild(container));
    setupAlertWindowUX(container);
    const body = document.getElementById('eve-alert-body');
    document.getElementById('eve-alert-toggle').addEventListener('click', () => {
      setAlertsCollapsed(!container.classList.contains('eve-alerts-collapsed'));
    });
    try {
      if (sessionStorage.getItem(ALERTS_COLLAPSED_KEY) === '1') {
        setAlertsCollapsed(true);
      }
    } catch (error) {}
    const dismissAll = document.getElementById('eve-alert-dismiss-all');
    const dismissAllLabel = dismissAll.innerHTML;
    let dismissArmedTimer = null;
    const disarmDismissAll = () => {
      clearTimeout(dismissArmedTimer);
      dismissArmedTimer = null;
      dismissAll.classList.remove('eve-confirm');
      dismissAll.innerHTML = dismissAllLabel;
    };
    const menu = setupAlertMenu(container, disarmDismissAll);
    dismissAll.addEventListener('click', () => {
      if (!dismissArmedTimer) {
        dismissAll.classList.add('eve-confirm');
        dismissAll.innerHTML =
          '<span class="eve-menu-icon">\u{2715}</span>Click again to dismiss all';
        dismissArmedTimer = setTimeout(disarmDismissAll, 3000);
        return;
      }
      menu.close();
      clearStoredAlerts();
      body.querySelectorAll('.eve-alert').forEach(node => node.remove());
      refreshAlertChrome();
      log(
        'All alerts dismissed and cleared from storage. ' + '(The exportable log is NOT affected.)'
      );
    });
    document.getElementById('eve-alert-export').addEventListener('click', () => {
      menu.close();
      exportLog('txt');
    });
    document.getElementById('eve-alert-export-csv').addEventListener('click', () => {
      menu.close();
      exportLog('csv');
    });
    container.querySelectorAll('.eve-filter-category').forEach(button => {
      button.addEventListener('click', () => {
        container
          .querySelectorAll('.eve-filter-category')
          .forEach(other => other.classList.remove('eve-filter-active'));
        button.classList.add('eve-filter-active');
        alertFilter = button.dataset.filter;
        applyAlertFilter();
      });
    });
    const searchInput = document.getElementById('eve-alert-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        alertSearch = searchInput.value.trim().toLowerCase();
        applyAlertFilter();
      });
      searchInput.addEventListener('keydown', event => {
        if (event.key === 'Escape' && searchInput.value) {
          event.preventDefault();
          searchInput.value = '';
          alertSearch = '';
          applyAlertFilter();
        }
      });
    }
    return body;
  }

  // ===== ALERT ACTIONS MENU =====
  // TXT / CSV / dismiss-all live behind one small "..." button so the title
  // bar stays free for dragging. The menu is position: fixed inside the panel,
  // so the panel's overflow: hidden cannot clip it (even when folded).

  function setupAlertMenu(container, onClose) {
    const button = container.querySelector('#eve-alert-menu-btn');
    const menu = container.querySelector('#eve-alert-menu');
    const items = () =>
      [...menu.querySelectorAll('[role="menuitem"]')].filter(el => el.style.display !== 'none');
    const isOpen = () => !menu.hidden;

    function place() {
      const anchor = button.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.min(
        Math.max(PANEL_MARGIN, anchor.right - width),
        window.innerWidth - width - PANEL_MARGIN
      );
      const below = anchor.bottom + 4;
      const top =
        below + height > window.innerHeight - PANEL_MARGIN
          ? Math.max(PANEL_MARGIN, anchor.top - 4 - height)
          : below;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }

    function close(options) {
      if (!isOpen()) {
        return;
      }
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.classList.remove('eve-menu-open');
      onClose();
      if (options && options.focusButton) {
        button.focus();
      }
    }

    function open(focusFirst) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      button.classList.add('eve-menu-open');
      place();
      if (focusFirst && items()[0]) {
        items()[0].focus();
      }
    }

    button.addEventListener('click', event => {
      if (isOpen()) {
        close();
      } else {
        open(event.detail === 0);
      }
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && !isOpen()) {
        event.preventDefault();
        open(true);
      }
    });
    menu.addEventListener('keydown', event => {
      const list = items();
      const index = list.indexOf(document.activeElement);
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') {
          event.preventDefault();
        }
        close({ focusButton: event.key === 'Escape' });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = list[(index + step + list.length) % list.length];
        if (next) {
          next.focus();
        }
      }
    });
    document.addEventListener(
      'pointerdown',
      event => {
        if (isOpen() && !menu.contains(event.target) && !button.contains(event.target)) {
          close();
        }
      },
      true
    );
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isOpen()) {
        close({ focusButton: true });
      }
    });
    window.addEventListener('resize', () => close());
    return { close: close, isOpen: isOpen };
  }

  // ===== ALERT WINDOW UX (drag / snap / persistent position) =====
  const MIN_ALERT_PANEL_HEIGHT = 120;

  function syncAlertPanelHeight(container) {
    const panel = container || document.getElementById('eve-alert-container');
    if (!panel) {
      return;
    }
    const top = panel.getBoundingClientRect().top;
    const available = window.innerHeight - top - 10;
    panel.style.maxHeight = `${Math.max(MIN_ALERT_PANEL_HEIGHT, available)}px`;
  }

  function saveAlertPanelPosition(container) {
    if (!container) {
      return;
    }
    writeJSON(
      localStorage,
      ALERT_PANEL_POSITION_KEY,
      { left: container.style.left, top: container.style.top },
      null
    );
  }

  function restoreAlertPanelPosition(container) {
    const pos = readJSON(localStorage, ALERT_PANEL_POSITION_KEY, null, null);
    if (!pos || !container) {
      return;
    }
    const clamped = clampToViewport(
      container,
      Number.parseInt(pos.left, 10) || PANEL_MARGIN,
      Number.parseInt(pos.top, 10) || PANEL_MARGIN
    );
    container.style.left = `${clamped.left}px`;
    container.style.top = `${clamped.top}px`;
    container.style.right = 'auto';
    syncAlertPanelHeight(container);
  }

  function setupAlertWindowUX(container) {
    if (!container) return;
    const header = container.querySelector('#eve-alert-header');
    if (!header) return;
    header.style.cursor = 'move';
    header.style.userSelect = 'none';
    header.style.touchAction = 'none';
    restoreAlertPanelPosition(container);
    let dragState = null;
    let draggedEnough = false;
    header.addEventListener(
      'click',
      event => {
        if (!draggedEnough) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        draggedEnough = false;
      },
      true
    );

    function getHeaderViewportBounds() {
      const panel = container.getBoundingClientRect();
      const barHeight = header.getBoundingClientRect().bottom - panel.top;
      const margin = PANEL_MARGIN;
      return {
        margin,
        maxLeft: Math.max(margin, window.innerWidth - panel.width - margin),
        maxTop: Math.max(margin, window.innerHeight - barHeight - margin)
      };
    }

    function positionHeaderFromPointer(event) {
      const bounds = getHeaderViewportBounds();
      const left = Math.min(
        Math.max(bounds.margin, event.clientX - dragState.offsetX),
        bounds.maxLeft
      );
      const top = Math.min(
        Math.max(bounds.margin, event.clientY - dragState.offsetY),
        bounds.maxTop
      );
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.right = 'auto';
      syncAlertPanelHeight(container);
    }

    function onPointerMove(event) {
      if (!dragState) return;
      if (
        Math.abs(event.clientX - dragState.startX) > 4 ||
        Math.abs(event.clientY - dragState.startY) > 4
      ) {
        draggedEnough = true;
      }
      positionHeaderFromPointer(event);
    }

    function onPointerUp() {
      if (!dragState) return;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      const wasDragged = draggedEnough;
      dragState = null;
      if (!wasDragged) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const bar = header.getBoundingClientRect();
      const bounds = getHeaderViewportBounds();
      const snapDistance = PANEL_SNAP_DISTANCE;
      let left = rect.left;
      let top = rect.top;
      const nearLeft = rect.left <= bounds.margin + snapDistance;
      const nearRight = window.innerWidth - rect.right <= bounds.margin + snapDistance;
      const nearTop = rect.top <= bounds.margin + snapDistance;
      const nearBottom = window.innerHeight - bar.bottom <= bounds.margin + snapDistance;
      if (nearLeft && nearTop) {
        left = bounds.margin;
        top = bounds.margin;
      } else if (nearRight && nearTop) {
        left = bounds.maxLeft;
        top = bounds.margin;
      } else if (nearLeft && nearBottom) {
        left = bounds.margin;
        top = bounds.maxTop;
      } else if (nearRight && nearBottom) {
        left = bounds.maxLeft;
        top = bounds.maxTop;
      } else {
        if (nearLeft) left = bounds.margin;
        if (nearRight) left = bounds.maxLeft;
        if (nearTop) top = bounds.margin;
        if (nearBottom) top = bounds.maxTop;
      }
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.right = 'auto';
      syncAlertPanelHeight(container);
      saveAlertPanelPosition(container);
      setTimeout(() => {
        draggedEnough = false;
      }, 0);
    }
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, input, a')) {
        return;
      }
      const rect = container.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY
      };
      draggedEnough = false;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      event.preventDefault();
    });
    window.addEventListener('resize', () => {
      const rect = container.getBoundingClientRect();
      const bounds = getHeaderViewportBounds();
      const left = Math.max(bounds.margin, Math.min(rect.left, bounds.maxLeft));
      const top = Math.max(bounds.margin, Math.min(rect.top, bounds.maxTop));
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.right = 'auto';
      syncAlertPanelHeight(container);
      saveAlertPanelPosition(container);
    });
  }

  // ===== ALERT FILTER + SEARCH =====
  const FILTER_TRANSITION_GROUPS = {
    TEST_SUCCESS: ['TEST_SUCCESS', 'PRETEST_SUCCESS'],
    PRETEST_FAILURE: ['PRETEST_FAILURE']
  };

  function applyAlertFilter() {
    const body = document.getElementById('eve-alert-body');
    if (!body) {
      return;
    }
    const cards = body.querySelectorAll('.eve-alert');
    let visible = 0;
    const chips = document.querySelectorAll('#eve-alert-filters .eve-filter-category');
    const chipCounts = {};
    chips.forEach(chip => {
      chipCounts[chip.dataset.filter] = 0;
    });
    const allowedTransitions = FILTER_TRANSITION_GROUPS[alertFilter] || [alertFilter];
    const showDebug = !!settings.developerMode;
    cards.forEach(card => {
      const matchesType =
        alertFilter === 'all' || allowedTransitions.indexOf(card.dataset.transition) !== -1;
      const matchesSearch =
        !alertSearch || (card.dataset.search || '').toLowerCase().indexOf(alertSearch) !== -1;
      const matchesDebugVisibility =
        showDebug || (card.dataset.debug !== '1' && card.dataset.diagnostic !== '1');
      const matchesLionWork = card.dataset.tracker !== 'lionking' || card.dataset.debug === '1' ||
        lionRowShow({ tailSerial: card.dataset.serial || '', headSerial: card.dataset.headSerial || '' });
      if (matchesDebugVisibility && matchesLionWork) {
        Object.keys(chipCounts).forEach(key => {
          if (
            key === 'all' ||
            (FILTER_TRANSITION_GROUPS[key] || [key]).indexOf(card.dataset.transition) !== -1
          ) {
            chipCounts[key] += 1;
          }
        });
      }
      const show = matchesType && matchesSearch && matchesDebugVisibility && matchesLionWork;
      card.style.display = show ? '' : 'none';
      if (show) {
        visible += 1;
      }
    });
    chips.forEach(chip => {
      const countSpan = chip.querySelector('.eve-chip-count');
      const count = chipCounts[chip.dataset.filter];
      setTextIfChanged(countSpan, count ? String(count) : '');
    });
    const countEl = document.getElementById('eve-alert-count');
    if (countEl) {
      countEl.textContent =
        visible === cards.length ? `(${cards.length})` : `(${visible}/${cards.length})`;
    }
  }

  // ===== ALERT CONTAINER VISIBILITY =====

  function updateAlertContainerVisibility() {
    const container = document.getElementById('eve-alert-container');
    const body = document.getElementById('eve-alert-body');
    if (!container || !body) {
      return;
    }
    const count = body.querySelectorAll('.eve-alert').length;
    container.style.display = count > 0 ? 'flex' : 'none';
    if (count > 0) {
      syncAlertPanelHeight(container);
    }
    const dismissAll = document.getElementById('eve-alert-dismiss-all');
    if (dismissAll) {
      dismissAll.style.display = count > 1 ? '' : 'none';
      const sep = dismissAll.previousElementSibling;
      if (sep) {
        sep.style.display = dismissAll.style.display;
      }
    }
  }

  function refreshAlertChrome() {
    updateAlertContainerVisibility();
    applyAlertFilter();
    if (IS_LION_KING_PAGE) {
      const count = [...document.querySelectorAll('#eve-alert-body .eve-alert')].filter(card => card.style.display !== 'none').length;
      setTextIfChanged(document.getElementById('lion-rack-back'), 'Back to tracker' + (count ? ' · ' + count + ' alerts' : ''));
    }
  }

  // ===== SAFE BUTTON WIRING =====

  function bindSetting(id, key, options) {
    const el = document.getElementById(id);
    if (!el) {
      return null;
    }
    const opts = options || {};
    const isCheckbox = el.type === 'checkbox';
    if (isCheckbox) {
      el.checked = !!settings[key];
    } else {
      el.value = String(settings[key]);
    }
    el.addEventListener('change', () => {
      const raw = isCheckbox ? el.checked : el.value;
      settings[key] = opts.coerce ? opts.coerce(raw) : raw;
      if (!isCheckbox && opts.writeBack) {
        el.value = String(settings[key]);
      }
      saveSettings();
      if (opts.after) {
        opts.after(settings[key]);
      }
      if (opts.message) {
        log(opts.message(settings[key]));
      }
    });
    return el;
  }

  function wireButton(id, handler) {
    const el = document.getElementById(id);
    if (!el) {
      fail(
        `Button #${id} not found \u{2014} UI may be stale. ` +
          'Hard-refresh the page (Ctrl+Shift+R) and confirm ' +
          `Tampermonkey is running v${SCRIPT_VERSION}.`
      );
      return;
    }
    el.addEventListener('click', event => {
      devLog(`Button #${id} clicked`);
      try {
        handler(event);
      } catch (error) {
        fail(`Handler for #${id} threw:`, error);
      }
    });
  }

  // ===== PANEL POSITION PERSISTENCE =====

  function savePanelPosition(panel) {
    if (!panel) {
      return;
    }
    writeJSON(
      localStorage,
      PANEL_POSITION_KEY,
      {
        left: panel.style.left,
        top: panel.style.top,
        collapsed: panel.classList.contains('eve-tracker-collapsed')
      },
      null
    );
  }

  function clampToViewport(panel, left, top) {
    const margin = PANEL_MARGIN;
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight - margin);
    return {
      left: Math.max(margin, Math.min(left, maxLeft)),
      top: Math.max(margin, Math.min(top, maxTop))
    };
  }

  function restorePanelPosition(panel, body, collapseButton) {
    const pos = readJSON(localStorage, PANEL_POSITION_KEY, null, null);
    if (!pos) {
      return;
    }
    {
      if (pos.left && pos.top) {
        const clamped = clampToViewport(
          panel,
          parseInt(pos.left, 10) || 10,
          parseInt(pos.top, 10) || 10
        );
        panel.style.left = `${clamped.left}px`;
        panel.style.top = `${clamped.top}px`;
        panel.style.right = 'auto';
      }
      if (pos.collapsed) {
        panel.classList.add('eve-tracker-collapsed');
        if (body) {
          body.style.display = 'none';
        }
        if (collapseButton) {
          collapseButton.textContent = '\u{ff0b}';
          collapseButton.title = 'Expand ' + TRACKER_LABEL;
        }
      }
    }
  }

  // ===== TRACKER WINDOW UX (drag / collapse / snap) =====

  function setupTrackerWindowUX(panel) {
    if (!panel) {
      return;
    }
    const title = panel.querySelector('.eve-panel-title');
    if (!title) {
      return;
    }
    title.style.cursor = 'move';
    title.style.userSelect = 'none';
    title.style.touchAction = 'none';
    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'eve-collapse-btn';
    collapseButton.textContent = '\u{2212}';
    collapseButton.title = 'Collapse ' + TRACKER_LABEL;
    title.appendChild(collapseButton);
    const body = document.createElement('div');
    body.className = 'eve-tracker-body';
    while (title.nextSibling) {
      body.appendChild(title.nextSibling);
    }
    panel.appendChild(body);
    restorePanelPosition(panel, body, collapseButton);
    collapseButton.addEventListener('click', event => {
      event.stopPropagation();
      const collapsed = panel.classList.toggle('eve-tracker-collapsed');
      body.style.display = collapsed ? 'none' : '';
      collapseButton.textContent = collapsed ? '\u{ff0b}' : '\u{2212}';
      collapseButton.title = collapsed ? 'Expand ' + TRACKER_LABEL : 'Collapse ' + TRACKER_LABEL;
      savePanelPosition(panel);
    });
    let dragState = null;

    function onPointerMove(event) {
      if (!dragState) {
        return;
      }
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      panel.style.left = `${Math.min(Math.max(0, event.clientX - dragState.offsetX), maxLeft)}px`;
      panel.style.top = `${Math.min(Math.max(0, event.clientY - dragState.offsetY), maxTop)}px`;
    }

    function onPointerUp() {
      if (!dragState) {
        return;
      }
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      dragState = null;
      const margin = PANEL_MARGIN;
      const snapDistance = PANEL_SNAP_DISTANCE;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      let left = rect.left;
      let top = rect.top;
      const nearLeft = left <= snapDistance;
      const nearRight = window.innerWidth - rect.right <= snapDistance;
      const nearTop = top <= snapDistance;
      const nearBottom = window.innerHeight - rect.bottom <= snapDistance;
      if (nearLeft && nearTop) {
        left = margin;
        top = margin;
      } else if (nearRight && nearTop) {
        left = maxLeft;
        top = margin;
      } else if (nearLeft && nearBottom) {
        left = margin;
        top = maxTop;
      } else if (nearRight && nearBottom) {
        left = maxLeft;
        top = maxTop;
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      savePanelPosition(panel);
    }
    title.addEventListener('pointerdown', event => {
      if (event.target.closest('.eve-collapse-btn')) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      dragState = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      event.preventDefault();
    });
    window.addEventListener('resize', () => {
      const rect = panel.getBoundingClientRect();
      const clamped = clampToViewport(panel, rect.left, rect.top);
      panel.style.left = `${clamped.left}px`;
      panel.style.top = `${clamped.top}px`;
      panel.style.right = 'auto';
    });
  }

  // ===== TRACKER UI =====

  function createUI() {
    if (document.getElementById('eve-tracker-panel')) {
      return;
    }
    const panel = document.createElement('div');
    panel.id = 'eve-tracker-panel';
    panel.classList.add('eve-tracker-window');
    panel.innerHTML = buildTrackerPanelMarkup();
    withoutObserver(() => document.body.appendChild(panel));
    addProfileNavigation(panel);
    setupTrackerWindowUX(panel);
    buildSectionControls();
    wireTrackerSettings();
    wireDeveloperMode();
    wireDebugButtons();
  }

  function wireDebugButtons() {
    wireButton('eve-debug-success', () => sendTestNotification('success'));
    wireButton('eve-debug-failure', () => sendTestNotification('failure'));
    wireButton('eve-debug-notify-diagnostic', () => {
      log('Open this console and watch your desktop for ~10 seconds.');
      runNotificationDiagnostic();
    });
    wireButton('eve-debug-pretest', () => sendTestNotification('pretest'));
    wireButton('eve-clear-log', () => clearAlertLog());
  }

  // ===== BUILD SECTION CONTROLS =====
  let renderedSectionSignature = null;

  function buildTrackerPanelMarkup() {
    return `
<div class="eve-panel-title">
<div class="eve-title-info">
<div class="eve-title-name">${TRACKER_LABEL}</div>
<div class="eve-title-meta">
by Zay Davidson <span class="eve-version">v${SCRIPT_VERSION}</span>
</div>
</div>
<span id="eve-refresh-mini"
class="eve-summary-badge eve-badge-on"
title="Next refresh (panel collapsed)"></span>
<span id="eve-health-chip"
class="eve-health-chip eve-health-ok"
title="Detection is healthy.">OK</span>
</div>
<div id="eve-ui-page-main"
class="eve-ui-page eve-ui-page-active">
<div class="eve-section-title">
Tracker Controls
</div>
<div class="eve-buttons eve-bulk-buttons">
<button id="eve-show-all" title="Show every section on the page">
Show All
</button>
<button id="eve-hide-all" title="Hide every section on the page">
Hide All
</button>
<button id="eve-watch-all" title="Notifications ON for every section">
All Notifs
</button>
<button id="eve-watch-none" title="Notifications OFF for every section">
No Notifs
</button>
</div>
<div class="eve-section-card">
<div class="eve-section-head" aria-hidden="true">
<span>Section</span>
<span title="Show or hide this section on the rack page">Show</span>
<span title="Desktop notifications for this section (results are logged either way)">Notifs</span>
</div>
<div id="eve-section-list"></div>
</div>
<div class="eve-refresh-card">
<div class="eve-refresh-row">
<span class="eve-refresh-label">
<span class="eve-live-dot" aria-hidden="true"></span>
Auto refresh
</span>
<select id="eve-refresh-interval" title="Refresh interval">
<option value="30">Every 30s</option>
<option value="20">Every 20s</option>
<option value="10">Every 10s</option>
</select>
<span
class="eve-summary-badge eve-badge-on"
id="eve-refresh-badge"
title="Time until the next refresh"
></span>
<button type="button"
id="eve-refresh-now"
class="eve-icon-btn"
title="Refresh now"
aria-label="Refresh now">
<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
stroke="currentColor" stroke-width="2.2"
stroke-linecap="round" stroke-linejoin="round"
aria-hidden="true">
<path d="M21 12a9 9 0 1 1-2.64-6.36"/>
<path d="M21 3v6h-6"/>
</svg>
</button>
</div>
<div class="eve-refresh-progress" aria-hidden="true">
<span id="eve-refresh-progress-fill"></span>
</div>
</div>
<div class="eve-refresh-card eve-shift-card">
<div class="eve-refresh-row">
<span class="eve-refresh-label">
<span class="eve-shift-icon" aria-hidden="true">\u{1f4cb}</span>
Log shift
</span>
<select id="eve-log-shift"
title="${escapeHtml(logShiftTooltip(currentShiftId(), false))}">
<option value="auto">Auto</option>
${Object.keys(SHIFTS)
  .map(id => `<option value="${id}">${shiftRangeLabel(SHIFTS[id])}</option>`)
  .join('')}
</select>
</div>
</div>
<div class="eve-dev-group eve-dev-only">
<div class="eve-dev-label">Refresh diagnostics</div>
<div class="eve-refresh-status"
id="eve-refresh-status">
</div>
<div class="eve-refresh-status"
id="eve-last-scan">
</div>
<div class="eve-refresh-status"
id="eve-keepalive-status">
</div>
<div class="eve-debug-hint">
Soft refresh reloads the data in the background;
a full page reload only happens if that fails.
</div>
</div>
<div class="eve-dev-group eve-dev-only">
<div class="eve-dev-label">
Jira
<span
class="eve-summary-badge"
id="eve-jira-badge"
style="display:none"
></span>
</div>
<label class="eve-dev-row" for="eve-notification-click">
<span>Toast click opens</span>
<select id="eve-notification-click" class="eve-dev-input">
<option value="jira">${IS_LION_KING_PAGE ? 'Jira serial search' : 'Jira ticket'}</option>
<option value="detail">TestView search</option>
<option value="both">Both</option>
</select>
</label>
<label class="eve-dev-row" for="eve-jira-base-url">
<span>Jira URL</span>
<input
type="url"
id="eve-jira-base-url"
class="eve-dev-input eve-jira-url"
spellcheck="false"
>
</label>
<div class="eve-debug-hint">
Card Jira buttons open ${IS_LION_KING_PAGE
  ? 'all tickets for the serial, sorted by most recently updated'
  : 'the most recently updated ticket for the serial'}, using this browser's Jira
login. Nothing is stored or sent anywhere else.
</div>
</div>
</div>
<div id="eve-ui-page-debug"
class="eve-ui-page"
hidden>
<div class="eve-section-title">
Developer
</div>
<div class="eve-dev-group">
<div class="eve-dev-label">Test notifications</div>
<div class="eve-dev-grid">
<button id="eve-debug-success"
class="eve-dev-btn"
title="Card + desktop toast for a fake PASS (DEBUG serial, never logged)">
<span class="eve-dot eve-dot-pass" aria-hidden="true"></span>
Test pass
</button>
<button id="eve-debug-failure"
class="eve-dev-btn"
title="Card + desktop toast for a fake FAIL (DEBUG serial, never logged)">
<span class="eve-dot eve-dot-fail" aria-hidden="true"></span>
Test fail
</button>
<button id="eve-debug-notify-diagnostic"
class="eve-dev-btn"
title="Sends 5 toasts with different options over ~10s - watch the desktop and the console">
Diagnose toasts
</button>
<button id="eve-debug-pretest"
class="eve-dev-btn"
title="Card + desktop toast for a fake PRE-TEST FAIL (DEBUG serial, never logged)">
<span class="eve-dot eve-dot-pretest" aria-hidden="true"></span>
Pre-test fail
</button>
</div>
</div>
<div class="eve-dev-group">
<div class="eve-dev-label">Desktop toasts</div>
<label class="eve-dev-row" for="eve-notification-timeout">
<span>Auto-close after</span>
<span class="eve-dev-inline">
<input type="number"
id="eve-notification-timeout"
class="eve-dev-input eve-dev-number"
min="0"
step="1">
<span class="eve-dev-unit">sec</span>
</span>
</label>
<div class="eve-debug-hint">0 = stays until you close it.</div>
</div>
<div class="eve-dev-group">
<div class="eve-dev-label">Alert log</div>
<div class="eve-dev-row">
<span class="eve-dev-note">Deletes this shift's saved history. Export first.</span>
<button id="eve-clear-log"
class="eve-dev-btn eve-danger-btn"
title="Permanently delete this shift's alert log (asks first)">
Clear log
</button>
</div>
</div>
</div>
<div
id="eve-page-navigation"
class="eve-page-navigation"
hidden
aria-label="Developer page navigation"
>
<button
type="button"
class="eve-page-dot eve-page-dot-active"
data-page="0"
aria-label="Main page"
title="Main"
></button>
<button
type="button"
class="eve-page-dot"
data-page="1"
aria-label="Developer / Diagnostics page"
title="Developer / Diagnostics"
></button>
</div>
<div class="eve-credit">
<span class="eve-credit-contact">
Found a bug?
\u{1f41e} <a href="https://github.com/zayd117/EVE-SLT-TRACKER/issues"
target="_blank" rel="noopener noreferrer"
style="color:inherit;">Open an issue on GitHub</a>
</span>
<label
class="eve-developer-footer-toggle"
title="Developer Mode"
>
<input
type="checkbox"
id="eve-developer-mode"
aria-label="Developer Mode"
>
<span>Dev</span>
</label>
</div>
`;
  }

  function wireDeveloperMode() {
    const developerModeCheckbox = document.getElementById('eve-developer-mode');
    const mainPage = document.getElementById('eve-ui-page-main');
    const debugPage = document.getElementById('eve-ui-page-debug');
    const pageNavigation = document.getElementById('eve-page-navigation');
    const pageDots = pageNavigation ? pageNavigation.querySelectorAll('.eve-page-dot') : [];
    let developerPage = 0;

    function showDeveloperPage(pageIndex) {
      developerPage = settings.developerMode && pageIndex === 1 ? 1 : 0;
      if (mainPage) {
        mainPage.hidden = developerPage !== 0;
        mainPage.classList.toggle('eve-ui-page-active', developerPage === 0);
      }
      if (debugPage) {
        const showDebugPage = developerPage === 1 && settings.developerMode;
        debugPage.hidden = !showDebugPage;
        debugPage.classList.toggle('eve-ui-page-active', showDebugPage);
      }
      pageDots.forEach((dot, index) => {
        const active = index === developerPage && settings.developerMode;
        dot.classList.toggle('eve-page-dot-active', active);
        dot.setAttribute('aria-current', active ? 'page' : 'false');
      });
    }

    function applyDeveloperModeUI() {
      const enabled = !!settings.developerMode;
      const trackerPanel = document.getElementById('eve-tracker-panel');
      if (trackerPanel) {
        trackerPanel.classList.toggle('eve-developer-enabled', enabled);
      }
      if (document.body) {
        document.body.classList.toggle('eve-dev-mode', enabled);
      }
      if (developerModeCheckbox) {
        developerModeCheckbox.checked = enabled;
      }
      if (pageNavigation) {
        pageNavigation.hidden = false;
        pageNavigation.classList.toggle('eve-dev-nav-disabled', !enabled);
        pageNavigation.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      }
      pageDots.forEach(dot => {
        dot.hidden = !enabled;
        dot.tabIndex = enabled ? 0 : -1;
      });
      if (!enabled) {
        developerPage = 0;
      }
      showDeveloperPage(developerPage);
    }
    pageDots.forEach(dot => {
      dot.addEventListener('click', () => {
        if (!settings.developerMode) {
          return;
        }
        showDeveloperPage(Number(dot.dataset.page));
      });
    });
    if (developerModeCheckbox) {
      developerModeCheckbox.addEventListener('change', () => {
        settings.developerMode = developerModeCheckbox.checked;
        saveSettings();
        developerPage = 0;
        applyDeveloperModeUI();
        applyAlertFilter();
        log(
          'Developer Mode ' +
            (settings.developerMode
              ? 'ENABLED. Developer page available.'
              : 'DISABLED. Developer page hidden.')
        );
      });
    }
    applyDeveloperModeUI();
  }

  function wireTrackerSettings() {
    bindSetting('eve-refresh-interval', 'refreshIntervalSeconds', {
      coerce: coerceRefreshInterval,
      writeBack: true,
      after: restartAutoRefresh,
      message: seconds => `Auto refresh interval set to ${seconds}s.`
    });
    updateRefreshCountdown();
    const shiftSelect = document.getElementById('eve-log-shift');
    if (shiftSelect) {
      shiftSelect.addEventListener('change', () => setLogShiftChoice(shiftSelect.value));
      updateLogShiftControl();
    }
    bindSetting('eve-notification-timeout', 'notificationTimeoutSeconds', {
      coerce: raw => {
        const value = Number(raw);
        return !Number.isNaN(value) && value >= 0 ? value : 0;
      },
      writeBack: true,
      message: seconds =>
        'Notification auto-close set to ' + `${seconds} seconds (0 = never auto-closes).`
    });
    bindSetting('eve-notification-click', 'notificationClickTarget', {
      coerce: raw => (['jira', 'detail', 'both'].indexOf(raw) !== -1 ? raw : 'jira'),
      message: target => `Desktop notification click now opens: ${target}.`
    });
    bindSetting('eve-jira-base-url', 'jiraBaseUrl', {
      coerce: raw => {
        const value = String(raw || '')
          .trim()
          .replace(/\/+$/, '');
        return /^https?:\/\/[^\s/]+/i.test(value) ? value : JIRA_DEFAULT_BASE_URL;
      },
      writeBack: true,
      after: () => {
        loadJiraCache().clear();
        saveJiraCache();
        jiraAuthPausedUntil = 0;
        jiraNeedsLogin = false;
        jiraConnected = false;
        refreshJiraOnCards();
      },
      message: url => `Jira URL set to ${url}.`
    });
    setJiraBadge('');
    wireButton('eve-refresh-now', refreshNow);
    wireButton('eve-show-all', () => setAllSections('show', true));
    wireButton('eve-hide-all', () => setAllSections('show', false));
    wireButton('eve-watch-all', () => setAllSections('watch', true));
    wireButton('eve-watch-none', () => setAllSections('watch', false));
  }

  function buildSectionControls(groups) {
    const list = document.getElementById('eve-section-list');
    if (!list) {
      return;
    }
    const sections = [
      ...new Set(
        (groups || getEveTableGroups())
          .flatMap(group => group.headers)
          .map(header => header.section)
      )
    ];
    const signature = sections.join('|');
    if (signature === renderedSectionSignature) {
      sections.forEach(section => {
        const row = list.querySelector(`.eve-section-row[data-section="${CSS.escape(section)}"]`);
        if (!row) {
          return;
        }
        const sectionSettings = getSectionSettings(section);
        row.querySelector('.eve-show-checkbox').checked = sectionSettings.show;
        row.querySelector('.eve-watch-checkbox').checked = sectionSettings.watch;
        syncSectionRowShown(row, sectionSettings.show);
      });
      return;
    }
    renderedSectionSignature = signature;
    list.innerHTML = '';
    sections.forEach(section => {
      const sectionSettings = getSectionSettings(section);
      const row = document.createElement('div');
      row.className = 'eve-section-row';
      row.dataset.section = section;
      row.innerHTML = `
<span class="eve-section-label">
<span class="eve-section-name">${escapeHtml(section)}</span>
<span class="eve-section-stats">
<span class="eve-stat eve-stat-testing"><b></b><span></span></span>
<span class="eve-stat eve-stat-failed"><b></b><span></span></span>
<span class="eve-stat eve-stat-passed"><b></b><span></span></span>
</span>
</span>
<label class="eve-switch" title="Show ${escapeHtml(section)} on the page">
<input
type="checkbox"
class="eve-show-checkbox"
aria-label="Show ${escapeHtml(section)}"
>
</label>
<label class="eve-switch" title="Desktop notifications for ${escapeHtml(section)}">
<input
type="checkbox"
class="eve-watch-checkbox"
aria-label="Notifications for ${escapeHtml(section)}"
>
</label>
`;
      const showCheckbox = row.querySelector('.eve-show-checkbox');
      const watchCheckbox = row.querySelector('.eve-watch-checkbox');
      showCheckbox.checked = sectionSettings.show;
      watchCheckbox.checked = sectionSettings.watch;
      syncSectionRowShown(row, sectionSettings.show);
      showCheckbox.addEventListener('change', () => {
        sectionSettings.show = showCheckbox.checked;
        saveSettings();
        syncSectionRowShown(row, sectionSettings.show);
        applyVisibility();
      });
      watchCheckbox.addEventListener('change', () => {
        sectionSettings.watch = watchCheckbox.checked;
        saveSettings();
        log(
          `Section ${section} notifications ` +
            (sectionSettings.watch ? 'ON.' : 'OFF.') +
            ' Transitions are still recorded in the alert log ' +
            'either way.'
        );
      });
      list.appendChild(row);
    });
    renderSectionCounts();
  }

  // ===== SET ALL SECTIONS =====

  function setAllSections(property, value) {
    const groups = getEveTableGroups();
    [...new Set(groups.flatMap(group => group.headers).map(header => header.section))].forEach(
      section => {
        getSectionSettings(section)[property] = value;
      }
    );
    saveSettings();
    buildSectionControls(groups);
    applyVisibility(groups);
  }

  // ===== APPLY VISIBILITY =====

  function applyVisibility(groupsIn) {
    const groups = groupsIn || getEveTableGroups();
    withoutObserver(() => {
      groups.forEach(group => {
        const visibility = group.headers.map(header => {
          const visible = getSectionSettings(header.section).show;
          header.element.style.display = visible ? '' : 'none';
          return { column: header.column, visible: visible };
        });
        group.table.querySelectorAll('tbody tr').forEach(row => {
          visibility.forEach(entry => {
            const cell = row.children[entry.column];
            if (cell) {
              cell.style.display = entry.visible ? '' : 'none';
            }
          });
        });
      });
    });
  }

  // ===== CSS =====

  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
#eve-tracker-panel, #eve-alert-container {
  --eve-font: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  --eve-mono: "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
  --eve-text: #e8eaed;
  --eve-muted: #9aa0a6;
  --eve-line: rgba(255, 255, 255, .08);
  --eve-line-strong: rgba(255, 255, 255, .14);
  --eve-control: rgba(255, 255, 255, .06);
  --eve-control-hover: rgba(255, 255, 255, .11);
  --eve-blue: #3b82f6;
}
#eve-tracker-panel.eve-tracker-window { min-width: 300px; max-width: 520px; }
#eve-tracker-panel .eve-panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#eve-tracker-panel .eve-collapse-btn {
  flex: 0 0 auto;
  width: 27px;
  height: 25px;
  padding: 0;
  margin: 0;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: var(--eve-control);
  color: var(--eve-text);
  font-size: 18px;
  font-weight: bold;
  line-height: 22px;
  cursor: pointer;
}
#eve-tracker-panel .eve-collapse-btn:hover { background: var(--eve-control-hover); }
#eve-tracker-panel.eve-tracker-collapsed { width: 340px; }
#eve-tracker-panel {
  position: fixed;
  top: 10px;
  right: 10px;
  width: 340px;
  max-height: 90vh;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, .18) transparent;
  z-index: 2147483646;
  background: #16171b;
  color: var(--eve-text);
  border: 1px solid var(--eve-line-strong);
  border-radius: 12px;
  padding: 12px;
  font-family: var(--eve-font);
  font-size: 13px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .45), 0 1px 0 rgba(255, 255, 255, .04) inset;
}
.eve-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -.01em;
  margin-bottom: 7px;
}
.eve-title-info { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.eve-title-name { line-height: 1.05; }
.eve-title-meta { margin-top: 3px; font-size: 11px; font-weight: normal; opacity: .72; white-space: nowrap; }
.eve-version { margin-left: 6px; font-weight: bold; opacity: 1; }
.eve-summary-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .03em;
  padding: 2px 7px;
  border-radius: 999px;
  margin-left: 6px;
  vertical-align: middle;
}
.eve-badge-on { background: #087f23; color: #fff; }
.eve-badge-off { background: #7a2020; color: #fff; }
.eve-badge-soon { background: #b06a00; color: #fff; }
.eve-health-chip {
  display: none;
  flex: 0 0 auto;
  margin-left: auto;
  margin-right: 8px;
  font-size: 10px;
  font-weight: bold;
  letter-spacing: .4px;
  padding: 2px 7px;
  border-radius: 3px;
  cursor: help;
}
#eve-tracker-panel.eve-developer-enabled .eve-health-chip { display: inline-block; }
.eve-health-ok { background: #087f23; color: #fff; }
.eve-health-degraded { background: #b06a00; color: #fff; }
.eve-health-blind { background: #b00000; color: #fff; animation: eve-health-pulse 1.6s ease-in-out infinite; }
@keyframes eve-health-pulse { 0%, 100% { opacity: 1; }
50% { opacity: .45; }
}
#eve-alert-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: #17181c;
  border-bottom: 1px solid var(--eve-line);
}
.eve-alerts-collapsed #eve-alert-toolbar { display: none; }
#eve-alert-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.eve-filter-btn {
  background: var(--eve-control);
  color: #c4c7cc;
  border: 1px solid var(--eve-line-strong);
  border-radius: 999px;
  padding: 3px 10px;
  font-family: var(--eve-font);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.eve-filter-btn:hover { background: var(--eve-control-hover); color: #fff; }
.eve-filter-btn.eve-filter-active { background: var(--eve-blue); border-color: var(--eve-blue); color: #fff; }
.eve-filter-btn { display: inline-flex; align-items: center; height: 24px; box-sizing: border-box; }
.eve-chip-count {
  display: inline-block;
  min-width: 8px;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .12);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.eve-chip-count:empty { display: none; }
.eve-filter-btn[data-filter="TEST_FAILURE"] .eve-chip-count {
  background: rgba(230, 9, 86, .3);
  color: #ffc2d6;
}
.eve-filter-btn[data-filter="PRETEST_FAILURE"] .eve-chip-count {
  background: rgba(145, 4, 33, .75);
  color: #f4b6c2;
}
.eve-filter-btn[data-filter="TEST_SUCCESS"] .eve-chip-count {
  background: rgba(9, 230, 138, .22);
  color: #b3f9da;
}
.eve-filter-btn.eve-filter-active .eve-chip-count { background: rgba(255, 255, 255, .25); color: #fff; }
#eve-tracker-panel:not(.eve-developer-enabled) .eve-dev-only { display: none !important; }
#eve-alert-search {
  width: 100%;
  box-sizing: border-box;
  background: #0f1013;
  color: var(--eve-text);
  border: 1px solid var(--eve-line-strong);
  border-radius: 8px;
  padding: 6px 10px;
  font-family: var(--eve-font);
  font-size: 12px;
  outline: none;
  transition: border-color .12s, box-shadow .12s;
}
#eve-alert-search::placeholder { color: #6b7078; }
#eve-alert-search:focus { border-color: var(--eve-blue); box-shadow: 0 0 0 3px rgba(59, 130, 246, .2); }
.eve-credit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  color: #999;
  line-height: 1.4;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--eve-line);
  word-break: break-word;
}
.eve-section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--eve-muted);
  margin-top: 12px;
  margin-bottom: 8px;
}
.eve-buttons { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.eve-buttons.eve-bulk-buttons {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.eve-buttons.eve-bulk-buttons button { padding: 6px 4px; font-size: 11.5px; white-space: nowrap; }
.eve-buttons button {
  cursor: pointer;
  padding: 5px 10px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: var(--eve-control);
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12px;
  font-weight: 600;
  transition: background .12s, border-color .12s;
}
.eve-buttons button:hover { background: var(--eve-control-hover); border-color: rgba(255, 255, 255, .22); }
.eve-refresh-card {
  margin-top: 10px;
  background: rgba(255, 255, 255, .03);
  border: 1px solid var(--eve-line);
  border-radius: 10px;
  overflow: hidden;
}
.eve-refresh-row { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 11px; }
.eve-refresh-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.eve-live-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, .18);
  animation: eve-live 2s ease-in-out infinite;
}
@keyframes eve-live { 0%, 100% { opacity: 1; }
50% { opacity: .35; }
}
.eve-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: var(--eve-control);
  color: var(--eve-muted);
  cursor: pointer;
  transition: background .12s, color .12s;
}
.eve-icon-btn:hover { background: var(--eve-control-hover); color: var(--eve-text); }
.eve-icon-btn:active svg { transform: rotate(90deg); }
.eve-icon-btn svg { transition: transform .2s ease; }
#eve-refresh-mini { display: none; margin-left: auto; font-variant-numeric: tabular-nums; }
#eve-tracker-panel.eve-tracker-collapsed #eve-refresh-mini { display: inline-block; }
#eve-tracker-panel.eve-tracker-collapsed.eve-developer-enabled .eve-health-chip { margin-left: 6px; }
#eve-refresh-badge {
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 58px;
  padding: 3px 8px;
  box-sizing: border-box;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
#eve-refresh-interval, #eve-log-shift {
  flex: 0 0 auto;
  padding: 4px 6px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: #0f1013;
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12px;
  cursor: pointer;
}
#eve-refresh-interval:focus, #eve-log-shift:focus { outline: none; border-color: var(--eve-blue); }
#eve-log-shift { flex: 0 1 auto; min-width: 0; margin-left: auto; }
.eve-shift-icon { flex: 0 0 auto; font-size: 12px; line-height: 1; }
.eve-refresh-progress { height: 2px; background: rgba(255, 255, 255, .05); }
#eve-refresh-progress-fill {
  display: block;
  width: 0;
  height: 100%;
  background: linear-gradient(90deg, #16a34a, #4ade80);
  transition: width .2s linear;
}
.eve-refresh-status {
  font-family: var(--eve-mono);
  font-size: 10.5px;
  color: var(--eve-muted);
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}
.eve-refresh-status:empty { display: none; }
.eve-dev-group {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--eve-line);
  border-radius: 10px;
  background: rgba(255, 255, 255, .03);
}
.eve-dev-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--eve-muted);
}
.eve-dev-label .eve-summary-badge { margin-left: 0; letter-spacing: .03em; }
.eve-dev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.eve-dev-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
  font-size: 12.5px;
}
.eve-dev-row + .eve-debug-hint { margin: 6px 0 0; }
.eve-dev-group > .eve-debug-hint:last-child { margin-bottom: 0; }
.eve-dev-inline { display: inline-flex; align-items: center; gap: 6px; }
.eve-dev-unit { color: var(--eve-muted); font-size: 11px; }
.eve-dev-note { color: var(--eve-muted); font-size: 11px; line-height: 1.35; }
.eve-dev-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: var(--eve-control);
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .12s, border-color .12s;
}
.eve-dev-btn:hover { background: var(--eve-control-hover); border-color: rgba(255, 255, 255, .22); }
.eve-danger-btn {
  flex: 0 0 auto;
  border-color: rgba(239, 68, 68, .45);
  background: rgba(239, 68, 68, .1);
  color: #fca5a5;
}
.eve-danger-btn:hover {
  background: rgba(239, 68, 68, .22);
  border-color: rgba(239, 68, 68, .7);
  color: #fff;
}
.eve-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; }
.eve-dot-pass { background: #09e68a; }
.eve-dot-fail { background: #e60956; }
.eve-dot-pretest { background: #c2334f; }
.eve-dev-input {
  flex: 0 1 auto;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  background: #0f1013;
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12px;
}
.eve-dev-input:focus { outline: none; border-color: var(--eve-blue); }
.eve-dev-number { width: 64px; text-align: right; }
.eve-jira-url { flex: 1 1 auto; max-width: 210px; font-family: var(--eve-mono); font-size: 11px; }
.eve-ui-page { width: 100%; }
.eve-ui-page[hidden] { display: none !important; }
.eve-page-navigation {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 16px;
  margin-top: 4px;
  user-select: none;
}
.eve-page-navigation[hidden] { display: flex !important; }
.eve-page-navigation.eve-dev-nav-disabled .eve-page-dot {
  display: none !important;
  visibility: hidden;
  pointer-events: none;
}
.eve-page-dot[hidden] { display: none !important; visibility: hidden; pointer-events: none; }
.eve-page-dot {
  width: 6px;
  height: 6px;
  min-width: 6px;
  min-height: 6px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #555;
  opacity: 0.65;
  cursor: pointer;
  box-shadow: none;
}
.eve-page-dot:hover { opacity: 1; background: #888; }
.eve-page-dot.eve-page-dot-active {
  width: 7px;
  height: 7px;
  min-width: 7px;
  min-height: 7px;
  background: #bbb;
  opacity: 1;
}
.eve-credit-contact { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eve-developer-footer-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  color: #4a4d53;
  font-size: 8px;
  font-weight: normal;
  cursor: pointer;
  user-select: none;
  opacity: 0.35;
  transition: opacity 0.15s ease;
}
.eve-developer-footer-toggle:hover { opacity: 0.8; color: #6b7078; }
.eve-developer-footer-toggle input {
  -webkit-appearance: none;
  appearance: none;
  width: 9px;
  height: 9px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 2px;
  background: transparent;
  cursor: pointer;
}
.eve-developer-footer-toggle input:checked { background: #3f4247; border-color: rgba(255, 255, 255, .24); }
.eve-developer-footer-toggle span { line-height: 1; }
.eve-debug-hint { font-size: 11px; color: var(--eve-muted); margin-bottom: 6px; line-height: 1.45; }
.eve-section-card {
  background: rgba(255, 255, 255, .03);
  border: 1px solid var(--eve-line);
  border-radius: 10px;
  padding: 0 10px;
}
.eve-section-card:has(#eve-section-list:empty) { display: none; }
.eve-section-head, .eve-section-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px 54px;
  align-items: center;
  justify-items: center;
}
.eve-section-label {
  justify-self: start;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.eve-section-label .eve-section-name { flex: 0 0 auto; min-width: 24px; }
.eve-section-stats { display: inline-flex; gap: 4px; min-width: 0; cursor: help; }
.eve-section-row:not(.eve-section-shown) .eve-section-stats { display: none; }
.eve-stat {
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 3px;
  box-sizing: border-box;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transition: opacity .2s ease;
}
.eve-stat b { font-weight: 700; }
.eve-stat span { font-weight: 500; opacity: .8; }
.eve-stat-testing { min-width: 48px; background: rgba(98, 245, 174, .16); color: #62f5ae; }
.eve-stat-failed { min-width: 42px; background: rgba(230, 9, 86, .24); color: #ffc2d6; }
.eve-stat-passed { min-width: 46px; background: rgba(9, 230, 138, .16); color: #b3f9da; }
.eve-stat-zero { opacity: .35; }
.eve-section-head {
  padding: 8px 0 6px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--eve-muted);
  border-bottom: 1px solid var(--eve-line);
}
.eve-section-head span:first-child, .eve-section-name { justify-self: start; }
.eve-section-row { padding: 6px 0; }
.eve-section-row + .eve-section-row { border-top: 1px solid rgba(255, 255, 255, .05); }
.eve-section-name { font-size: 13px; font-weight: 700; letter-spacing: .02em; }
.eve-switch { display: inline-flex; cursor: pointer; }
.eve-switch input {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  width: 30px;
  height: 18px;
  margin: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, .16);
  cursor: pointer;
  transition: background .15s ease;
}
.eve-switch input::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .4);
  transition: transform .15s ease;
}
.eve-switch input:checked { background: var(--eve-blue); }
.eve-switch input:checked::before { transform: translateX(12px); }
.eve-switch input:focus-visible { outline: 2px solid var(--eve-blue); outline-offset: 2px; }
#eve-alert-container {
  position: fixed;
  top: 10px;
  left: 10px;
  width: 430px;
  max-width: calc(100vw - 20px);
  max-height: calc(100vh - 20px);
  overflow: hidden;
  z-index: 2147483647;
  display: none;
  flex-direction: column;
  background: #141518;
  border: 1px solid var(--eve-line-strong);
  border-radius: 12px;
  font-family: var(--eve-font);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .5);
}
#eve-alert-header, #eve-alert-toolbar { flex: 0 0 auto; }
#eve-alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: #1b1c20;
  border-bottom: 1px solid var(--eve-line);
  border-radius: 11px 11px 0 0;
  color: var(--eve-text);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -.005em;
}
#eve-alert-toggle { cursor: pointer; user-select: none; }
#eve-alert-caret { display: inline-block; width: 14px; }
#eve-alert-count { color: var(--eve-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
#eve-alert-header-actions { display: flex; flex: 0 0 auto; }
#eve-alert-menu-btn {
  width: 28px;
  height: 24px;
  padding: 0;
  background: transparent;
  color: var(--eve-muted);
  border: 1px solid transparent;
  border-radius: 7px;
  font-family: var(--eve-font);
  font-size: 16px;
  font-weight: 700;
  line-height: 20px;
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
#eve-alert-menu-btn:hover, #eve-alert-menu-btn.eve-menu-open {
  background: var(--eve-control-hover);
  border-color: var(--eve-line-strong);
  color: var(--eve-text);
}
#eve-alert-menu-btn:focus-visible { outline: 2px solid var(--eve-blue); outline-offset: 1px; }
#eve-alert-menu {
  position: fixed;
  z-index: 2147483647;
  min-width: 210px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #1f2025;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .55);
  font-family: var(--eve-font);
}
#eve-alert-menu[hidden] { display: none; }
#eve-alert-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  color: var(--eve-text);
  border: 0;
  border-radius: 6px;
  font-family: var(--eve-font);
  font-size: 12.5px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
#eve-alert-menu button:hover, #eve-alert-menu button:focus-visible {
  background: var(--eve-control-hover);
  outline: none;
}
#eve-alert-menu button.eve-confirm { background: #b91c1c; color: #fff; }
.eve-menu-icon { width: 16px; text-align: center; flex: 0 0 auto; }
.eve-menu-sep { height: 1px; margin: 3px 4px; background: var(--eve-line); }
#eve-alert-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, .18) transparent;
}
#eve-alert-body::-webkit-scrollbar, #eve-tracker-panel::-webkit-scrollbar { width: 8px; }
#eve-alert-body::-webkit-scrollbar-track, #eve-tracker-panel::-webkit-scrollbar-track {
  background: transparent;
}
#eve-alert-body::-webkit-scrollbar-thumb, #eve-tracker-panel::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, .16);
  border-radius: 8px;
}
#eve-alert-body::-webkit-scrollbar-thumb:hover, #eve-tracker-panel::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, .28);
}
.eve-alerts-collapsed #eve-alert-body { display: none; }
.eve-alerts-collapsed #eve-alert-header { border-radius: 11px; border-bottom: 0; }
.eve-alert {
  --eve-accent: #e60956;
  --eve-accent-rgb: 230, 9, 86;
  position: relative;
  border-radius: 10px;
  padding: 10px 12px 9px 15px;
  color: var(--eve-text);
  font-family: var(--eve-font);
  background: linear-gradient(120deg, rgba(var(--eve-accent-rgb), .13) 0%, rgba(var(--eve-accent-rgb), .03) 55%, rgba(0, 0, 0, 0) 100%), #1c1d22;
  border: 1px solid rgba(var(--eve-accent-rgb), .26);
  box-shadow: inset 3px 0 0 var(--eve-accent), 0 1px 2px rgba(0, 0, 0, .35), 0 6px 16px rgba(0, 0, 0, .22);
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  animation: eve-card-in .18s ease-out;
}
@keyframes eve-card-in { from { opacity: 0; transform: translateY(-4px); }
to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .eve-alert, .eve-live-dot { animation: none; transition: none; }
}
.eve-alert-clickable { cursor: pointer; }
.eve-alert-clickable:hover {
  border-color: rgba(var(--eve-accent-rgb), .55);
  box-shadow: inset 3px 0 0 var(--eve-accent), 0 2px 4px rgba(0, 0, 0, .35), 0 10px 24px rgba(0, 0, 0, .3);
}
/* Old cards dim under a darkening layer (40% black + desaturate = the old
   brightness(.6) saturate(.55) filter). A layer, not a filter on the card,
   so the Jira chip can sit above it: a pre-test chip with its gold
   "create one" outline stays bright on an old card until acknowledged. */
.eve-alert.eve-alert-gone { border-style: dashed; }
.eve-alert-gone .eve-alert-serial-value,
.eve-alert-gone .eve-alert-header > span:first-child,
.eve-alert-gone .eve-alert-loc {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  text-decoration-color: rgba(232, 234, 237, .55);
  opacity: .6;
}
.eve-alert-gone button.eve-alert-serial { cursor: default; }
.eve-alert-gone button.eve-alert-serial:hover { background: rgba(0, 0, 0, .3); border-color: transparent; }
.eve-alert-gone .eve-alert-serial .eve-alert-copy-hint { display: none; }
.eve-gone-tag {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--eve-line-strong);
  background: rgba(255, 255, 255, .06);
  color: var(--eve-muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .03em;
  text-transform: uppercase;
  white-space: nowrap;
}
.eve-alert.eve-alert-aged { isolation: isolate; }
.eve-alert.eve-alert-aged::after {
  content: '';
  position: absolute;
  inset: -1px;
  z-index: 1;
  border-radius: inherit;
  background: rgba(0, 0, 0, .4);
  -webkit-backdrop-filter: saturate(.55);
  backdrop-filter: saturate(.55);
  pointer-events: none;
  transition: opacity .25s ease;
}
.eve-alert.eve-alert-aged:hover::after { opacity: 0; }
/* Lifted above the layer, on the card's own base colour, so its translucent
   fill blends exactly as on an undimmed card. */
.eve-alert.eve-alert-aged .eve-jira-group:has(.eve-jira-attn) {
  position: relative;
  z-index: 2;
  border-radius: 999px;
  background: #1c1d22;
}
@media (prefers-reduced-motion: reduce) { .eve-alert.eve-alert-aged::after { transition: none; }
}
.eve-success { --eve-accent: #09e68a; --eve-accent-rgb: 9, 230, 138; }
.eve-failure { --eve-accent: #e60956; --eve-accent-rgb: 230, 9, 86; }
.eve-pretest { --eve-accent: #910421; --eve-accent-rgb: 145, 4, 33; --eve-accent-text: #c2334f; }
.eve-pretest-pass { --eve-accent: #14b8a6; --eve-accent-rgb: 20, 184, 166; }
.eve-dekit { --eve-accent: #94a3b8; --eve-accent-rgb: 148, 163, 184; }
.eve-dekit .eve-alert-header span { color: #cbd5e1; }
.eve-alert-unverified { border-style: dashed; border-color: rgba(var(--eve-accent-rgb), .7); }
.eve-alert-phase-note {
  display: none;
  font-size: 11px;
  color: var(--eve-muted);
  margin-bottom: 6px;
  word-break: break-word;
}
body.eve-dev-mode .eve-alert-phase-note { display: block; }
.eve-alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .03em;
  margin-bottom: 8px;
}
.eve-alert-header span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--eve-accent-text, var(--eve-accent));
  min-width: 0;
}
.eve-alert-header span::before {
  content: '';
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--eve-accent-text, var(--eve-accent));
  box-shadow: 0 0 0 3px rgba(var(--eve-accent-rgb), .2);
}
.eve-alert-close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--eve-muted);
  font-size: 18px;
  font-weight: 400;
  line-height: 22px;
  cursor: pointer;
  padding: 0;
  transition: background .12s, color .12s;
}
.eve-alert-close:hover { background: rgba(255, 255, 255, .1); color: #fff; }
.eve-alert-serial {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  background: rgba(0, 0, 0, .28);
  border: 1px solid var(--eve-line);
  border-radius: 8px;
  color: #f5f6f7;
  font-family: var(--eve-mono);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: .05em;
  padding: 7px 8px 7px 10px;
  margin-bottom: 8px;
  cursor: pointer;
  text-align: left;
  transition: background .12s, border-color .12s;
}
.eve-alert-serial:hover { background: rgba(0, 0, 0, .4); border-color: var(--eve-line-strong); }
.eve-alert-serial-value { word-break: break-all; }
.eve-alert-copy-hint {
  flex: 0 0 auto;
  font-family: var(--eve-font);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--eve-muted);
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .06);
}
.eve-alert-serial:hover .eve-alert-copy-hint { color: var(--eve-text); background: rgba(255, 255, 255, .1); }
.eve-alert-serial.eve-copied { border-color: rgba(34, 197, 94, .5); }
.eve-alert-serial.eve-copied .eve-alert-copy-hint { color: #86efac; background: rgba(34, 197, 94, .16); }
.eve-alert-serial.eve-copy-failed { border-color: rgba(239, 68, 68, .5); }
.eve-alert-serial.eve-copy-failed .eve-alert-copy-hint { color: #fca5a5; background: rgba(239, 68, 68, .16); }
.eve-alert-loc { font-size: 12.5px; font-weight: 600; color: #d7dade; margin-bottom: 3px; }
.eve-alert-status { font-size: 12px; font-weight: 500; color: var(--eve-muted); margin-bottom: 8px; }
.eve-alert-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--eve-line);
}
.eve-alert-time {
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--eve-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.eve-alert-jira {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  box-sizing: border-box;
  padding: 0 10px 0 9px;
  border-radius: 999px;
  border: 1px solid rgba(76, 154, 255, .45);
  background: rgba(38, 132, 255, .12);
  color: #a9cbff;
  font-family: var(--eve-font);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .02em;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.eve-alert-jira:hover { background: #0c66e4; border-color: #0c66e4; color: #fff; text-decoration: none; }
.eve-alert-jira:focus-visible { outline: 2px solid #4c9aff; outline-offset: 2px; }
.eve-jira-group { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; }
.eve-jira-group .eve-alert-jira { position: relative; }
.eve-jira-copy {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.eve-jira-copy[hidden] { display: none; }
.eve-jira-copy .eve-alert-copy-hint { padding: 4px 8px; }
.eve-jira-copy:hover .eve-alert-copy-hint { color: var(--eve-text); background: rgba(255, 255, 255, .1); }
.eve-jira-copy:focus-visible { outline: 2px solid #4c9aff; outline-offset: 1px; border-radius: 999px; }
.eve-jira-copy.eve-copied .eve-alert-copy-hint { color: #86efac; background: rgba(34, 197, 94, .16); }
.eve-jira-copy.eve-copy-failed .eve-alert-copy-hint { color: #fca5a5; background: rgba(239, 68, 68, .16); }
.eve-jira-new {
  position: absolute;
  top: -6px;
  right: -5px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #22c55e;
  color: #052e16;
  box-shadow: 0 0 0 2px #141518;
  font-family: var(--eve-font);
  font-size: 10px;
  font-weight: 800;
  line-height: 15px;
  text-align: center;
  animation: eve-jira-new-pulse 1.6s ease-out 3;
}
@keyframes eve-jira-new-pulse {
  0% { box-shadow: 0 0 0 2px #141518, 0 0 0 2px rgba(34, 197, 94, .6); }
  100% { box-shadow: 0 0 0 2px #141518, 0 0 0 9px rgba(34, 197, 94, 0); }
}
/* Pre-test "No ticket (create one)": a yellow light traces the outline. */
@property --eve-trace-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
.eve-alert-jira.eve-jira-attn { position: relative; border-color: rgba(250, 204, 21, .35); }
.eve-alert-jira.eve-jira-attn::before {
  content: '';
  position: absolute;
  inset: -2px;
  padding: 2px;
  border-radius: inherit;
  background: conic-gradient(from var(--eve-trace-angle), transparent 0 62%,
    rgba(250, 204, 21, .15) 72%, #facc15 88%, rgba(250, 204, 21, .15) 96%, transparent 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  filter: drop-shadow(0 0 3px rgba(250, 204, 21, .7));
  animation: eve-jira-trace 2.4s linear infinite;
  pointer-events: none;
}
@keyframes eve-jira-trace { to { --eve-trace-angle: 360deg; } }
/* The whole chip glows green while the ticket is new (same lifetime as the badge). */
.eve-alert-jira.eve-jira-fresh {
  border-color: rgba(34, 197, 94, .85);
  color: #bbf7d0;
  animation: eve-jira-fresh-glow 1.8s ease-in-out infinite;
}
@keyframes eve-jira-fresh-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .15), 0 0 4px rgba(34, 197, 94, .25); }
  50% { box-shadow: 0 0 0 3px rgba(34, 197, 94, .28), 0 0 14px rgba(34, 197, 94, .55); }
}
@media (prefers-reduced-motion: reduce) {
  .eve-jira-new { animation: none; }
  .eve-alert-jira.eve-jira-fresh { animation: none; box-shadow: 0 0 10px rgba(34, 197, 94, .5); }
  .eve-alert-jira.eve-jira-attn::before { animation: none; }
}
.eve-jira-ext { flex: 0 0 auto; opacity: .85; }
.eve-jira-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: .5;
}
.eve-jira-found .eve-jira-label { font-family: var(--eve-mono); font-weight: 600; letter-spacing: 0; }
.eve-jira-cat-new .eve-jira-dot { background: #8c9bab; opacity: 1; }
.eve-jira-cat-indeterminate .eve-jira-dot { background: #579dff; opacity: 1; }
.eve-jira-cat-done .eve-jira-dot { background: #4bce97; opacity: 1; }
.eve-jira-loading .eve-jira-dot { animation: eve-jira-pulse 1s ease-in-out infinite; }
@keyframes eve-jira-pulse { 0%, 100% { opacity: .25; }
50% { opacity: 1; }
}
.eve-jira-none { color: #c4c7cc; border-color: var(--eve-line-strong); background: var(--eve-control); }
.eve-jira-auth { color: #fcd34d; border-color: rgba(245, 158, 11, .5); background: rgba(245, 158, 11, .1); }
.eve-jira-auth .eve-jira-dot { background: #f59e0b; opacity: 1; }
.eve-jira-waiting {
  color: #d6d9de;
  border-color: rgba(245, 158, 11, .45);
  background: rgba(245, 158, 11, .08);
}
.eve-jira-waiting .eve-jira-dot {
  background: #f59e0b;
  opacity: 1;
  animation: eve-jira-pulse 1.6s ease-in-out infinite;
}
.eve-jira-noticket { color: #b8bcc3; border-color: var(--eve-line-strong); background: var(--eve-control); }
.eve-jira-noticket .eve-jira-dot { background: #6b7280; opacity: 1; }
.eve-jira-passed, .eve-jira-passed:hover {
  color: #86efac;
  border-color: rgba(34, 197, 94, .4);
  background: rgba(34, 197, 94, .1);
  cursor: default;
}
.eve-jira-passed .eve-jira-dot { background: #22c55e; opacity: 1; }
.eve-jira-passed .eve-jira-ext { display: none; }
`;
    document.head.appendChild(style);
  }

  // ===== INITIALIZE =====

  const RUNNING_ATTR = 'data-eve-slt-tracker';

  function claimThisTab() {
    const root = document.documentElement;
    const running = root.getAttribute(RUNNING_ATTR);
    if (running) {
      warn(
        `Another copy of eve_slt_Jbog_tracker (v${running}) is already running in this ` +
          `tab. This copy (v${SCRIPT_VERSION}) stays idle so every alert is not ` +
          'logged and notified twice. Remove the extra copy in the Tampermonkey ' +
          'Dashboard.'
      );
      return false;
    }
    root.setAttribute(RUNNING_ATTR, SCRIPT_VERSION);
    return true;
  }

  function initialize() {
    if (!claimThisTab()) {
      return;
    }
    try {
      rackDataAt = Date.now();
      document.addEventListener('click', onRackCellClick, true);
      settings = loadSettings();
      previousStates = loadPreviousStates();
      recentAlerts = loadRecentAlerts();
      const strippedMeta = stripMetaRefresh(document);
      if (strippedMeta) {
        warn(
          `Removed ${strippedMeta} page-level meta refresh ` +
            'tag(s) at DOMContentLoaded. The tracker now ' +
            'controls refreshing.'
        );
      }
      debugCompareAfterRefresh();
      checkNotificationPermission();
      checkLogShiftRollover();
      injectCSS();
      if (document.body) {
        document.body.classList.toggle('eve-dev-mode', !!settings.developerMode);
      }
      createUI();
      restorePersistedAlerts();
      window.addEventListener('focus', onJiraWindowFocus);
      const groups = getEveTableGroups();
      applyVisibility(groups);
      scan(groups);
      startMasterTick();
      startCountdownAnimation();
      holdKeepAliveLock();
      holdScreenWakeLock();
      wireSleepDetection();
      observePage();
      window.addEventListener('beforeunload', () => {
        persistBeforeUnload(true);
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          reportHealth(
            'DEGRADED',
            'Tab is in the background. Browser timer ' +
              'throttling means detection is delayed. Keep ' +
              'this tab visible.',
            true
          );
          flushAlertLog();
          return;
        }
        blindScans = 0;
        holdScreenWakeLock();
        restartAutoRefresh();
        scan();
      });
      window.addEventListener('pagehide', () => {
        persistBeforeUnload(false);
      });
      log(
        `eve_slt_Jbog_tracker v${SCRIPT_VERSION} running\n` +
          '  by Zay Davidson\n' +
          '  Report bugs: ' +
          'https://github.com/zayd117/EVE-SLT-TRACKER/issues'
      );
      startAutoRefresh();
    } catch (error) {
      fail(
        'FATAL: the tracker failed to start. The page is NOT ' +
          'being monitored. Hard-refresh (Ctrl+Shift+R); if it ' +
          'persists, send this error to Zay.',
        error
      );
      showFatalBanner(error);
    }
  }

  function persistBeforeUnload(takeSnapshot) {
    savePreviousStates();
    saveRecentAlerts();
    flushAlertLog();
    if (takeSnapshot) {
      debugSnapshotBeforeRefresh('manual-refresh');
    }
  }

  function showFatalBanner(error) {
    try {
      const banner = document.createElement('div');
      banner.id = 'eve-tracker-panel';
      banner.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:2147483647;' +
        'max-width:340px;padding:12px;border-radius:8px;' +
        'background:#7f1d1d;color:#fff;border:2px solid #ef4444;' +
        'font:13px Arial,Helvetica,sans-serif;';
      banner.textContent =
        `eve_slt_Jbog_tracker v${SCRIPT_VERSION} FAILED TO START. ` +
        'This page is NOT being monitored. ' +
        `Error: ${error && error.message ? error.message : error}`;
      document.body.appendChild(banner);
    } catch (bannerError) {}
  }

  // ===== KEEP AWAKE + SLEEP DETECTION =====
  const HEARTBEAT_EVERY_TICKS = 5;
  const SLEEP_GAP_MS = 120000;
  const keepAwake = {
    lock: 'not tried',
    screen: 'not tried',
    ticker: 'not started'
  };
  let screenWakeLock = null;
  let lastTickAt = 0;
  let frozenAt = 0;
  let sleepCount = 0;
  let lastSleep = null;

  function writeHeartbeat(now) {
    try {
      sessionStorage.setItem(HEARTBEAT_KEY, String(now || Date.now()));
    } catch (error) {}
  }

  function readHeartbeat() {
    try {
      return Number(sessionStorage.getItem(HEARTBEAT_KEY)) || 0;
    } catch (error) {
      return 0;
    }
  }

  function holdKeepAliveLock() {
    if (!navigator.locks || typeof navigator.locks.request !== 'function') {
      keepAwake.lock = window.isSecureContext ? 'unsupported' : 'unavailable (page is not https)';
      renderKeepAwakeStatus();
      return;
    }
    navigator.locks
      .request('eve-slt-tracker-keepalive', { mode: 'shared' }, () => {
        keepAwake.lock = 'held';
        renderKeepAwakeStatus();
        return new Promise(() => {});
      })
      .catch(error => {
        keepAwake.lock = 'failed';
        renderKeepAwakeStatus();
        devLog('Keep-alive Web Lock failed:', error);
      });
  }

  // Screen Wake Lock: while the tracker tab is the one on screen, the display
  // and the PC do not go to sleep (a sleeping PC runs nothing). The browser
  // drops it whenever the tab is hidden, so it is re-taken each time the tab
  // is visible again (initialize's visibilitychange handler, noteWake).
  function holdScreenWakeLock() {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      keepAwake.screen = window.isSecureContext ? 'unsupported' : 'unavailable (page is not https)';
      renderKeepAwakeStatus();
      return;
    }
    if (document.hidden || (screenWakeLock && !screenWakeLock.released)) {
      return;
    }
    navigator.wakeLock
      .request('screen')
      .then(lock => {
        screenWakeLock = lock;
        keepAwake.screen = 'held';
        lock.addEventListener('release', () => {
          keepAwake.screen = 'released (tab hidden)';
          renderKeepAwakeStatus();
        });
        renderKeepAwakeStatus();
      })
      .catch(error => {
        keepAwake.screen = 'denied';
        renderKeepAwakeStatus();
        devLog('Screen wake lock not granted:', error);
      });
  }

  function startTicker(onTick) {
    let fallbackStarted = false;
    let workerAlive = false;
    let worker = null;
    const fallback = reason => {
      if (fallbackStarted || workerAlive) {
        return;
      }
      fallbackStarted = true;
      if (worker) {
        try {
          worker.terminate();
        } catch (error) {}
      }
      keepAwake.ticker = `page timer (${reason})`;
      renderKeepAwakeStatus();
      devLog(`Master tick on setInterval: ${reason}.`);
      setInterval(onTick, 1000);
    };
    try {
      const source = 'setInterval(function () { postMessage(0); }, 1000);';
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = () => {
        if (fallbackStarted) {
          return;
        }
        if (!workerAlive) {
          workerAlive = true;
          keepAwake.ticker = 'worker';
          renderKeepAwakeStatus();
        }
        onTick();
      };
      worker.onerror = event => {
        if (event && event.preventDefault) {
          event.preventDefault();
        }
        fallback('worker blocked');
      };
    } catch (error) {
      fallback('worker unavailable');
      return;
    }
    setTimeout(() => {
      if (!workerAlive) {
        fallback('worker silent');
      }
    }, 3000);
  }

  function formatSleep(ms) {
    return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : formatDuration(ms);
  }

  function noteWake(kind, fromTs, toTs, refresh) {
    const sleptMs = fromTs ? Math.max(0, toTs - fromTs) : 0;
    sleepCount += 1;
    lastSleep = { kind: kind, from: fromTs, to: toTs };
    // No banner and no notification: catch up immediately and quietly.
    devLog(
      `Tab was ${kind === 'discarded' ? 'unloaded' : 'asleep'}` +
        (sleptMs ? ` for ${formatSleep(sleptMs)}` : '') +
        ' - catching up now.'
    );
    if (refresh) {
      refreshNow();
    }
    holdScreenWakeLock();
    renderKeepAwakeStatus();
  }

  function renderKeepAwakeStatus() {
    const el = document.getElementById('eve-keepalive-status');
    if (!el) {
      return;
    }
    const sleeps = sleepCount
      ? `${sleepCount}` +
        (lastSleep && lastSleep.from
          ? ` (last ${formatSleep(lastSleep.to - lastSleep.from)}, ${lastSleep.kind})`
          : ` (last: ${lastSleep ? lastSleep.kind : '?'})`)
      : '0';
    setTextIfChanged(
      el,
      `Keep-awake: lock ${keepAwake.lock} \u{2022} screen ${keepAwake.screen} ` +
        `\u{2022} tick ${keepAwake.ticker} ` +
        `\u{2022} sleeps ${sleeps}`
    );
  }

  function wireSleepDetection() {
    document.addEventListener('freeze', () => {
      frozenAt = Date.now();
      writeHeartbeat(frozenAt);
      savePreviousStates();
      flushAlertLog();
    });
    document.addEventListener('resume', () => {
      const from = frozenAt || lastTickAt;
      frozenAt = 0;
      lastTickAt = Date.now();
      noteWake('frozen', from, lastTickAt, true);
    });
    if (document.wasDiscarded) {
      const last = readHeartbeat();
      noteWake('discarded', last, Date.now(), false);
    }
    renderKeepAwakeStatus();
  }

  function startCountdownAnimation() {
    if (typeof requestAnimationFrame !== 'function') {
      return;
    }
    let lastPaint = 0;
    const frame = time => {
      if (time - lastPaint >= 100) {
        lastPaint = time;
        updateRefreshCountdown();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ===== MASTER TICK =====

  // One step that throws (every tick, say, on unexpected markup) must not
  // skip the steps after it - the shift rollover and the watchdog share
  // ticks with scan. Each failing step is reported once, until it recovers.
  const failingTickSteps = new Set();

  function runTickStep(name, fn) {
    try {
      fn();
      if (failingTickSteps.delete(name)) {
        log(`Tick step "${name}" recovered.`);
      }
    } catch (error) {
      if (!failingTickSteps.has(name)) {
        failingTickSteps.add(name);
        fail(`Tick step "${name}" failed; the other steps keep running:`, error);
      }
    }
  }

  function startMasterTick() {
    const SCAN_TICKS = 4;
    const RELATIVE_TICKS = 15;
    const WATCHDOG_TICKS = 10;
    const RECONFIRM_TICKS = 45;
    const LOG_SHIFT_TICKS = 60;
    let tick = 0;
    startTicker(() => {
      const now = Date.now();
      runTickStep('wake check', () => {
        if (lastTickAt && now - lastTickAt > SLEEP_GAP_MS && !frozenAt) {
          noteWake('paused', lastTickAt, now, true);
        }
      });
      lastTickAt = now;
      runTickStep('auto refresh', () => {
        if (autoRefreshTimer && autoRefreshDueAt && now > autoRefreshDueAt + 2000) {
          fireAutoRefresh();
        }
      });
      tick += 1;
      runTickStep('countdown', updateRefreshCountdown);
      if (tick % HEARTBEAT_EVERY_TICKS === 0) {
        writeHeartbeat(now);
      }
      if (tick % SCAN_TICKS === 0) {
        runTickStep('scan', () => scan());
      }
      if (tick % RELATIVE_TICKS === 0) {
        runTickStep('relative times', refreshRelativeTimes);
      }
      if (tick % WATCHDOG_TICKS === 0) {
        runTickStep('watchdog', autoRefreshWatchdog);
      }
      if (tick % RECONFIRM_TICKS === 0) {
        runTickStep('reconfirm', retryPendingConfirmations);
      }
      if (tick % LOG_SHIFT_TICKS === 0) {
        runTickStep('log shift', checkLogShiftRollover);
      }
    });
  }

  // ===== LION KING TESTVIEW HANDOFF =====
  // Resolve UUT IDs through the observed list API, then verify identity with
  // by_id. The user's browser session supplies authentication for both.
  const LION_TESTVIEW_LIST_PATH = '/uut/gpu_jbog_test/list';
  const LION_TESTVIEW_API_PATH = '/api/v1/uut_status/view';
  const LION_TESTVIEW_HANDOFF_KEY = 'eveLionTestViewHandoff';
  const LION_TESTVIEW_HANDOFF_TTL_MS = 120000;
  const LION_TESTVIEW_HASH_SERIAL = 'eveLionSn';
  const LION_TESTVIEW_HASH_STARTED = 'eveLionStarted';
  const LION_TESTVIEW_HASH_OPERATION = 'eveLionOperation';
  const lionDetailLookups = new Map();

  function lionTestViewOperation(operation) {
    const value = String(operation || '').trim().toUpperCase();
    if (value === 'PRETEST' || value === 'GPU_JBOG_TEST_PRETEST') return 'GPU_JBOG_TEST_PRETEST';
    return !value || value === 'GPU_JBOG_TEST' ? 'GPU_JBOG_TEST' : '';
  }

  function lionTestViewAPIRecords(body) {
    const records = [];
    const inspect = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 3 || records.length >= 1000) return;
      if (Array.isArray(value)) { value.slice(0, 1000).forEach(item => inspect(item, depth + 1)); return; }
      if (Object.prototype.hasOwnProperty.call(value, 'id')) records.push(value);
      for (const key of ['data', 'item', 'items', 'result', 'results']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) inspect(value[key], depth + 1);
      }
    };
    inspect(body, 0);
    return records;
  }

  async function requestLionKingAPI(url) {
    const origin = new URL(TESTVIEW_LIST_URL).origin;
    if (url.origin !== origin || !/^\/api\/v1\/uut_status\/view(?:\/\d+\/by_id)?$/.test(url.pathname)) return null;
    const parse = (status, text, finalURL) => {
      if (Number(status) !== 200 || typeof text !== 'string' || text.length > 2 * 1024 * 1024) return null;
      try {
        if (finalURL) {
          const final = new URL(finalURL);
          if (final.origin !== origin || final.pathname !== url.pathname) return null;
        }
        return JSON.parse(text);
      } catch (error) { return null; }
    };
    if (isTestViewOrigin()) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), TESTVIEW_LOOKUP_TIMEOUT_MS);
      try {
        const response = await fetch(url.href, { credentials: 'include', headers: { Accept: 'application/json' },
          signal: controller?.signal });
        return parse(response.status, await response.text(), response.url);
      } catch (error) { return null; }
      finally { clearTimeout(timeout); }
    }
    if (typeof GM_xmlhttpRequest !== 'function') return null;
    return new Promise(resolve => {
      let finished = false, request;
      const done = value => { if (!finished) { finished = true; clearTimeout(timeout); resolve(value); } };
      const timeout = setTimeout(() => { done(null); try { request?.abort(); } catch (error) {} }, TESTVIEW_LOOKUP_TIMEOUT_MS + 1000);
      try {
        request = GM_xmlhttpRequest({ method: 'GET', url: url.href, anonymous: false,
          headers: { Accept: 'application/json' }, timeout: TESTVIEW_LOOKUP_TIMEOUT_MS,
          onload: response => done(parse(response.status, response.responseText, response.finalUrl)),
          onerror: () => done(null), ontimeout: () => done(null), onabort: () => done(null) });
      } catch (error) { done(null); }
    });
  }

  function lionTestViewAPIRun(record, serial, operation) {
    const wantedOperation = lionTestViewOperation(operation);
    return !!record && /^[1-9]\d{0,15}$/.test(String(record.id || '')) &&
      typeof record.uut_sn === 'string' && record.uut_sn.trim().toUpperCase() === serial &&
      !!wantedOperation && typeof record.operation === 'string' &&
      record.operation.trim().toUpperCase() === wantedOperation &&
      typeof record.started === 'string' && Number.isFinite(lionStartedAt(record.started.trim()));
  }

  async function lookupLionKingDirect(serial, started, operation) {
    const sn = String(serial || '').trim().toUpperCase();
    const requested = String(started || '').trim();
    const wantedOperation = lionTestViewOperation(operation);
    const wantStarted = requested ? lionStartedAt(requested) : null;
    if (!wantedOperation || !/^[A-Z0-9_-]{1,120}$/.test(sn) || (requested && !Number.isFinite(wantStarted))) return '';
    const key = JSON.stringify([sn, requested, wantedOperation]);
    if (lionDetailLookups.has(key)) return lionDetailLookups.get(key);
    const lookup = async () => {
      const query = async (latest, page) => {
        const url = new URL(LION_TESTVIEW_API_PATH, TESTVIEW_LIST_URL);
        for (const field of ['id', 'uut_sn', 'fixture_sn', 'status', 'finished', 'started', 'operation']) {
          url.searchParams.append('fields', field);
        }
        url.searchParams.set('only_latest_uut_status', String(latest));
        url.searchParams.set('operation', wantedOperation);
        url.searchParams.set('operation_is_exact', 'true');
        url.searchParams.set('page_num', String(page));
        url.searchParams.set('page_size', '10');
        url.searchParams.set('return_page_info', 'true');
        url.searchParams.set('uut_sn', sn);
        const body = await requestLionKingAPI(url);
        return body ? lionTestViewAPIRecords(body) : null;
      };
      const select = rows => {
        const matches = rows.filter(row => lionTestViewAPIRun(row, sn, wantedOperation) &&
          (wantStarted === null || lionStartedAt(row.started.trim()) === wantStarted));
        matches.sort((a, b) => lionStartedAt(b.started.trim()) - lionStartedAt(a.started.trim()));
        if (!matches.length) return null;
        const newest = lionStartedAt(matches[0].started.trim());
        const ids = new Set(matches.filter(row => lionStartedAt(row.started.trim()) === newest).map(row => String(row.id)));
        return ids.size === 1 ? matches[0] : null;
      };
      const latest = await query(true, 1);
      if (!latest) return '';
      let selected = select(latest);
      // A PASS card can describe an earlier attempt. Search API history for
      // that exact Started value rather than opening a newer retest.
      if (!selected && requested) {
        for (let page = 1; page <= 5; page += 1) {
          const rows = await query(false, page);
          if (!rows) return '';
          selected = select(rows);
          if (selected || rows.length < 10) break;
        }
      }
      if (!selected) return '';
      const verified = await lookupLionKingDetail(String(selected.id), sn, selected.started, wantedOperation);
      return verified ? new URL(`/uut/detail/${selected.id}`, TESTVIEW_LIST_URL).href : '';
    };
    const pending = lookup().catch(() => '').finally(() => lionDetailLookups.delete(key));
    lionDetailLookups.set(key, pending);
    return pending;
  }

  function buildLionKingTestViewUrl(serial, started, operation) {
    const url = new URL(LION_TESTVIEW_LIST_PATH, TESTVIEW_LIST_URL);
    url.hash = new URLSearchParams({ [LION_TESTVIEW_HASH_SERIAL]: String(serial || '').trim(),
      [LION_TESTVIEW_HASH_STARTED]: String(started || '').trim(),
      [LION_TESTVIEW_HASH_OPERATION]: lionTestViewOperation(operation) }).toString();
    return url.href;
  }

  async function openLionKingTestView(serial, started, opener, operation) {
    const target = { serial: String(serial || '').trim(), started: String(started || '').trim(),
      operation: lionTestViewOperation(operation) };
    if (!target.serial || !target.operation) return;
    const open = typeof opener === 'function' ? opener : openExternal;
    let popup = null;
    if (open === openExternal || (open === openFromNotification && typeof GM_openInTab !== 'function')) {
      // Reserve the user's click before awaiting the API to avoid popup blocking.
      try {
        popup = window.open('about:blank', '_blank');
        if (popup) {
          popup.opener = null;
          popup.document.title = 'Opening Lion King TestView';
          popup.document.body.textContent = 'Opening TestView...';
        }
      } catch (error) {}
    }
    const navigate = url => {
      if (popup) {
        if (popup.closed) return;
        try {
          if (popup.location.href !== 'about:blank') return;
          popup.location.replace(url);
        } catch (error) {}
      } else if (open === openExternal && typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true });
      } else open(url);
    };
    const detail = await lookupLionKingDirect(target.serial, target.started, target.operation);
    if (popup?.closed) return;
    if (detail) { navigate(detail); return; }
    // Retry from the signed-in TestView origin if cross-origin session cookies
    // are unavailable. That helper also uses the API; it never types or clicks Query.
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(LION_TESTVIEW_HANDOFF_KEY, JSON.stringify({ ...target, ts: Date.now() }));
      }
    } catch (error) {}
    navigate(buildLionKingTestViewUrl(target.serial, target.started, target.operation));
  }

  function readLionKingTestViewTarget() {
    let handoff = null;
    try {
      if (typeof GM_getValue === 'function') {
        handoff = JSON.parse(GM_getValue(LION_TESTVIEW_HANDOFF_KEY, 'null'));
      }
    } catch (error) {}
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(LION_TESTVIEW_HANDOFF_KEY);
    } catch (error) {}
    const hash = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    if (hash.has(LION_TESTVIEW_HASH_SERIAL)) {
      const serial = (hash.get(LION_TESTVIEW_HASH_SERIAL) || '').trim();
      const started = (hash.get(LION_TESTVIEW_HASH_STARTED) || '').trim();
      const operation = lionTestViewOperation(hash.get(LION_TESTVIEW_HASH_OPERATION));
      hash.delete(LION_TESTVIEW_HASH_SERIAL);
      hash.delete(LION_TESTVIEW_HASH_STARTED);
      hash.delete(LION_TESTVIEW_HASH_OPERATION);
      try {
        const rest = hash.toString();
        history.replaceState(null, '', window.location.pathname + window.location.search +
          (rest ? `#${rest}` : ''));
      } catch (error) {}
      return { serial, started, operation };
    }
    const age = handoff && Date.now() - Number(handoff.ts);
    if (handoff && typeof handoff.serial === 'string' && Number.isFinite(age) &&
        age >= 0 && age < LION_TESTVIEW_HANDOFF_TTL_MS) {
      return { serial: handoff.serial.trim(),
        started: typeof handoff.started === 'string' ? handoff.started.trim() : '',
        operation: lionTestViewOperation(handoff.operation) };
    }
    return { serial: '', started: '', operation: 'GPU_JBOG_TEST' };
  }

  function findLionKingTestViewSnInput() {
    const input = document.getElementById('uut_sn');
    return input && input.tagName === 'INPUT' ? input : findTestViewSnInput();
  }

  function lionTestViewElementVisible(element) {
    return !!element && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden';
  }

  function lionTestViewRows() {
    return [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row, tbody tr')]
      .filter(row => lionTestViewElementVisible(row) && row.querySelector('td') &&
        !row.classList.contains('ant-table-placeholder'));
  }

  function lionTestViewExactSerial(row, serial) {
    const want = String(serial || '').trim().toUpperCase();
    if (!want) return false;
    return Array.from(row.cells).some(cell => cell.textContent.trim().toUpperCase() === want ||
      Array.from(cell.querySelectorAll('a')).some(anchor => anchor.textContent.trim().toUpperCase() === want));
  }

  function lionTestViewResultsFiltered(serial) {
    const rows = lionTestViewRows();
    if (rows.length) return rows.every(row => lionTestViewExactSerial(row, serial));
    return [...document.querySelectorAll('.ant-table-placeholder')]
      .some(lionTestViewElementVisible);
  }

  function lionTestViewRowStarted(row) {
    // Read the Started column, never another date such as Finished. Some
    // Ant Design tables keep the header in a separate table above the body.
    const table = row.closest('table');
    const scope = table && table.querySelector('thead') ? table : row.closest('.ant-table');
    if (!scope) return NaN;
    for (const header of scope.querySelectorAll('thead tr')) {
      const cells = [...header.children];
      if (cells.some(cell => Number(cell.getAttribute('colspan') || 1) !== 1 ||
          Number(cell.getAttribute('rowspan') || 1) !== 1)) continue;
      const index = cells.findIndex(cell =>
        /^STARTED(?:TIME)?$/.test(cell.textContent.replace(/\s+/g, '').toUpperCase()));
      if (index !== -1 && row.children[index]) {
        return lionStartedAt(row.children[index].textContent.replace(/\s+/g, ' ').trim());
      }
    }
    return NaN;
  }

  function lionTestViewDetailCandidates(serial, started) {
    const wantStarted = lionStartedAt(String(started || '').trim());
    if (!Number.isFinite(wantStarted)) return [];
    const found = new Map();
    for (const row of lionTestViewRows()) {
      if (!lionTestViewExactSerial(row, serial) || lionTestViewRowStarted(row) !== wantStarted) continue;
      for (const anchor of row.querySelectorAll('a[href]')) {
        if (!lionTestViewElementVisible(anchor)) continue;
        try {
          const url = new URL(anchor.getAttribute('href'), window.location.href);
          const match = /^\/uut\/detail\/(\d+)\/?$/.exec(url.pathname);
          if (url.origin === new URL(TESTVIEW_LIST_URL).origin && match) {
            found.set(match[1], url.href);
          }
        } catch (error) {}
      }
    }
    return [...found.values()];
  }

  async function lookupLionKingDetail(id, serial, started, operation) {
    const runId = String(id || '');
    const sn = String(serial || '').trim().toUpperCase();
    const wantedOperation = lionTestViewOperation(operation);
    const wantStarted = lionStartedAt(String(started || '').trim());
    if (!wantedOperation || !/^[1-9]\d{0,15}$/.test(runId) || !sn ||
        !Number.isFinite(wantStarted)) return null;
    const url = new URL(`${LION_TESTVIEW_API_PATH}/${runId}/by_id`, TESTVIEW_LIST_URL);
    for (const field of ['id', 'uut_sn', 'fixture_sn', 'status', 'operation', 'started',
      'finished', 'duration']) url.searchParams.append('fields', field);
    try {
      const body = await requestLionKingAPI(url);
      if (!body) return null;
      const matches = lionTestViewAPIRecords(body).filter(record =>
        String(record.id) === runId && lionTestViewAPIRun(record, sn, wantedOperation) &&
        lionStartedAt(record.started.trim()) === wantStarted);
      // Verify the serial, operation and Started value of the requested run.
      return matches.length === 1 ? matches[0] : null;
    } catch (error) {
      return null;
    }
  }

  async function runLionKingTestViewAutoQuery() {
    if (!isTestViewOrigin() || window.location.pathname !== LION_TESTVIEW_LIST_PATH) return;
    const target = readLionKingTestViewTarget();
    if (!target.serial || !target.operation) return;
    let userTookOver = false;
    const onUserInput = event => { if (event.isTrusted) userTookOver = true; };
    document.addEventListener('keydown', onUserInput, true);
    document.addEventListener('paste', onUserInput, true);
    try {
      const detail = await lookupLionKingDirect(target.serial, target.started, target.operation);
      if (userTookOver) return;
      if (detail) {
        window.location.replace(detail);
        return;
      }
      showTestViewBanner(`eve_slt_Jbog_tracker: could not resolve the ${target.operation} detail for ${target.serial}. ` +
        'Check your TestView login and try again.');
    } catch (error) {
      if (!userTookOver) {
        showTestViewBanner(`eve_slt_Jbog_tracker: could not resolve the test for ${target.serial}. ` +
          'Check your TestView login and try again.');
      }
    } finally {
      document.removeEventListener('keydown', onUserInput, true);
      document.removeEventListener('paste', onUserInput, true);
    }
  }

  // ===== PROFILE NAVIGATION =====

  function addProfileNavigation(panel) {
    const nav = document.createElement('nav');
    nav.className = 'eve-profile-navigation';
    nav.setAttribute('aria-label', 'Tracker pages');
    const collector = IS_LION_RAMSES_PAGE ? 'https://mfg-collector.hyvesolutions.org' : '';
    nav.innerHTML = `<a href="${collector}/out/out.eveslt.php">EVE SLT</a> | ` +
      `<a href="${collector}/out/out.evelionking_all.php">Lion King</a> | ` +
      `<a href="${LION_RAMSES_URL}">Ramses JBOG</a>`;
    panel.appendChild(nav);
  }

  // ===== LION KING ROW MONITOR =====
  const LION_DAY_MS = 24 * 60 * 60 * 1000;
  const LION_MAX_RUNS = 12000;
  const LION_AREAS = { b6: 'B6', b7: 'B7', lionking2: 'E2/E4/BL',
    unassigned: 'Unassigned' };

  // ===== LION KING PHYSICAL RACK BOARD =====
  // The source supplies test identity, not physical location. Only scans made
  // on this board assign locations; sorting or test status never moves a JBOG.
  const LION_RACK_BOARD_KEY = 'eveLionRackBoardV1';
  const LION_RACK_WINDOW_KEY = 'lionKingTrackerRackBoardWindow';
  const LION_RACK_LAYOUT_REVISION = 2;
  const LION_WORK_PREFS_REVISION = 1;
  const LION_RACK_SEEN_KEY = 'lionKingTrackerRackSeenTimesV1';
  let lionRackSeenTimes = null;
  const LION_RACK_ROWS = [
    { area: 'b6', racks: ['TA.B6-EVE03', 'TA.B6-EVE02', 'TA.B6-EVE01', 'TA.B6-EVE04', 'TA.B7-EVE05'] },
    { area: 'b7', racks: ['TA.B7-EVE02', 'TA.B6-EVE05', 'TA.B7-EVE01', 'TA.B7-EVE03', 'TA.B7-EVE04'] },
    { area: 'lionking2', racks: ['TA.E2-EVE04', 'TA.E4-EVE06', 'TA.E2-EVE06', 'TA.E4-EVE01', 'TA.BL-EVE03',
      'TA.E4-EVE05', 'TA.E2-EVE03', 'TA.E4-EVE04', 'TA.E2-EVE02', 'TA.E2-EVE05', 'TA.E4-EVE02'] }
  ];
  const LION_SLOT_LABELS = ['Top middle', 'Bottom middle', 'Left middle', 'Right middle'];
  let lionRackBoard = null;
  let lionRackIndex = new Map();
  let lionRackSnapshot = null;
  let lionRackDisplay = new Map();
  let lionRackNodeDisplay = new Map();
  let lionRackUI = null;
  let lionRackDragging = false;
  let lionRackSelected = null;
  // Visibility, expansion and notifications share one saved Enabled state.
  let lionRackPairedScrollLeft = 0;
  let lionRackPairedScrollFrame = 0;
  const lionRackExpectedScroll = new WeakMap();
  let lionRackSelectionLoading = false;
  let lionRackSelectionNextAt = 0;

  function lionRackSerial(value) {
    const text = String(value || '').trim().toUpperCase();
    return /^[A-Z0-9_-]{1,120}$/.test(text) ? text : '';
  }

  function lionRackBarcode(value) {
    const text = String(value || '').trim().toUpperCase();
    return /^TA\.[A-Z0-9]{1,12}-EVE\d{1,3}$/.test(text) ? text : '';
  }

  function normalizeLionRackBoard(value) {
    const valid = isRecordObject(value) && value.version === 1 && Array.isArray(value.rows) && value.rows.length === 3;
    const usedRacks = new Set(), usedSerials = new Set(), slots = {};
    const rows = LION_RACK_ROWS.map((defaults, index) => {
      const source = valid && Array.isArray(value.rows[index]?.racks) ? value.rows[index].racks : defaults.racks;
      const racks = source.slice(0, 96).map(lionRackBarcode).filter(rack => {
        if (!rack || usedRacks.has(rack) || usedRacks.size >= 96) return false;
        usedRacks.add(rack); return true;
      });
      racks.forEach(rack => {
        slots[rack] = Array.from({ length: 4 }, (_, position) => {
          const saved = valid && Array.isArray(value.slots?.[rack]) ? value.slots[rack][position] : null;
          let serial = lionRackSerial(saved?.serial), partner = lionRackSerial(saved?.partner);
          if (usedSerials.has(serial)) serial = '';
          if (!serial) return { serial: '', partner: '' };
          usedSerials.add(serial);
          if (partner === serial || usedSerials.has(partner)) partner = '';
          if (partner) usedSerials.add(partner);
          return { serial, partner };
        });
      });
      return { area: defaults.area, racks };
    });
    const work = { racks: {}, slots: {} };
    const currentWorkPrefs = valid && value.workRevision === LION_WORK_PREFS_REVISION;
    rows.forEach(row => row.racks.forEach(rack => {
      const rackPrefs = valid ? value.work?.racks?.[rack] : null;
      // Old releases enabled every rack by default. Start that layout off
      // once, preserving scans and all choices made after this migration.
      const enabled = currentWorkPrefs && rackPrefs?.show === true && rackPrefs?.watch === true;
      work.racks[rack] = { show: enabled, watch: enabled };
      work.slots[rack] = Array.from({ length: 4 }, (_, position) => {
        const prefs = valid ? value.work?.slots?.[rack]?.[position] : null;
        return { show: prefs?.show !== false, watch: prefs?.watch !== false };
      });
    }));
    return { version: 1, kind: 'eve-lion-rack-board', workRevision: LION_WORK_PREFS_REVISION,
      layoutRevision: valid ? (value.layoutRevision === LION_RACK_LAYOUT_REVISION ? LION_RACK_LAYOUT_REVISION : 0) : LION_RACK_LAYOUT_REVISION,
      rows, slots, work };
  }

  function restoreLionRackScanOrder(board) {
    if (board.layoutRevision === LION_RACK_LAYOUT_REVISION) return board;
    // Repair older layouts once. Assignments and work preferences are keyed
    // by rack barcode, so restoring scan order does not move any JBOG slots.
    // Row names describe the physical rows, never the barcode prefix.
    const scannedRacks = new Set(LION_RACK_ROWS.flatMap(row => row.racks));
    const rows = LION_RACK_ROWS.map((defaults, index) => ({ area: defaults.area,
      racks: [...defaults.racks.filter(rack => Object.prototype.hasOwnProperty.call(board.slots, rack)),
        ...board.rows[index].racks.filter(rack => !scannedRacks.has(rack))] }));
    return normalizeLionRackBoard({ ...board, rows, layoutRevision: LION_RACK_LAYOUT_REVISION });
  }

  function readLionRackBoard() {
    let shared = null;
    try {
      if (typeof GM_getValue === 'function') {
        const raw = GM_getValue(LION_RACK_BOARD_KEY, null);
        shared = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
    } catch (error) {}
    const stored = shared || readJSON(localStorage, LION_RACK_BOARD_KEY, null, 'Rack board');
    const migrateWork = !isRecordObject(stored) || stored.workRevision !== LION_WORK_PREFS_REVISION;
    const saved = normalizeLionRackBoard(stored);
    const board = restoreLionRackScanOrder(saved);
    if (board !== saved || migrateWork) {
      try { if (typeof GM_setValue === 'function') GM_setValue(LION_RACK_BOARD_KEY, JSON.stringify(board)); } catch (error) {}
      writeJSON(localStorage, LION_RACK_BOARD_KEY, board, 'Rack board');
    }
    return board;
  }

  function indexLionRacks() {
    lionRackIndex = new Map();
    lionRackBoard.rows.forEach(row => row.racks.forEach(rack => {
      lionRackBoard.slots[rack].forEach((entry, position) => {
        const location = { rackId: rack, rackSlot: position + 1, area: row.area };
        if (entry.serial) lionRackIndex.set(entry.serial, location);
        if (entry.partner) lionRackIndex.set(entry.partner, location);
      });
    }));
  }

  function lionRackPlacement(row) {
    const tail = lionRackIndex.get(lionRackSerial(row.tailSerial || row.serial));
    const head = lionRackIndex.get(lionRackSerial(row.headSerial));
    if (tail && head && (tail.rackId !== head.rackId || tail.rackSlot !== head.rackSlot)) return { conflict: true };
    return tail || head || null;
  }

  function lionPhysicalLocation(row) {
    const placement = lionRackPlacement(row);
    const area = lionAreaForRow(row);
    return { area, rackId: placement && !placement.conflict ? placement.rackId : '',
      rackSlot: placement && !placement.conflict ? placement.rackSlot : null,
      location: placement?.conflict ? 'Conflicting rack assignments - check tail and head nodes' :
        placement ? placement.rackId + ' · JBOG ' + placement.rackSlot + ' (' + LION_SLOT_LABELS[placement.rackSlot - 1] + ')' :
          LION_AREAS[area] + ' - JBOG ' + (row.jbog || row.tailSerial || row.serial || '') };
  }

  function lionRackAreaSettings(rack) {
    const area = lionRackBoard?.rows.find(row => row.racks.includes(rack))?.area || 'unassigned';
    return lionAreaSettings(area);
  }

  function lionRowPreference(row, property) {
    return lionAreaSettings(lionAreaForRow(row))[property];
  }

  function lionRowShow(row) { return lionRowPreference(row, 'show'); }
  function lionRowWatch(row) { return lionRowPreference(row, 'watch'); }

  function renderLionRackWorkControls() {
    const board = document.getElementById('eve-lion-rack-board');
    if (!board) return;
    board.querySelectorAll('[data-lion-area-controls]').forEach(holder => {
      const area = holder.dataset.lionAreaControls, name = LION_AREAS[area];
      const prefs = lionAreaSettings(area), counts = lastSectionCounts?.[area] || {};
      const stats = [['testing', 'test', 'Testing'], ['pretest', 'pre', 'Running pre-test'],
        ['failed', 'fail', 'Test failures'], ['pretestFailed', 'pre-fail', 'Pre-test failures'], ['passed', 'pass', 'Passed']]
        .filter(([field]) => counts[field] > 0).map(([field, label, title]) =>
          '<span class="lion-work-count lion-work-count-' + field + '" title="' + title + '">' +
          counts[field] + ' ' + label + '</span>').join('') || '<span class="lion-work-count">0 active</span>';
      const markup = '<label class="lion-work-toggle" title="Visibility and notifications for ' + escapeHtml(name) +
        '"><input type="checkbox" data-work-area="' + area + '" data-work-property="enabled" aria-label="Enable ' +
        escapeHtml(name) + ' visibility and notifications"' + (prefs.show ? ' checked' : '') +
        '><span>Enabled</span></label><span class="lion-work-counts">' + stats + '</span>';
      if (holder.innerHTML !== markup) holder.innerHTML = markup;
      const row = board.querySelector('#lion-rack-row-' + area);
      if (row) { row.open = prefs.show; row.hidden = !prefs.show; }
      const toggle = board.querySelector('[data-lion-row-toggle="' + area + '"]');
      if (toggle) toggle.setAttribute('aria-expanded', String(prefs.show));
    });
  }

  function refreshLionRackAlertLocations() {
    const records = loadActiveAlerts().map(record =>
      record.tracker === 'lionking' && !isDebugData(record) ? { ...record, ...lionPhysicalLocation(record) } : record);
    saveActiveAlerts(records);
    const byId = new Map(records.map(record => [record.id, record]));
    document.querySelectorAll('#eve-alert-body .eve-alert').forEach(card => {
      const record = byId.get(card.dataset.alertId);
      if (!record || record.tracker !== 'lionking' || isDebugData(record)) return;
      setTextIfChanged(card.querySelector('.eve-alert-loc'), '\u{1f4cd} ' + record.location);
      const oldBase = card.dataset.searchBase || '';
      const suffix = oldBase && (card.dataset.search || '').startsWith(oldBase)
        ? card.dataset.search.slice(oldBase.length) : '';
      const base = (record.serial || '') + ' ' + record.location + ' ' +
        (record.headSerial || '') + ' ' + (record.started || '');
      card.dataset.searchBase = base; card.dataset.search = base + suffix;
    });
    applyAlertFilter();
  }

  function lionRackFeedback(message) {
    setTextIfChanged(document.getElementById('lion-rack-feedback'), message);
  }

  function saveLionRackBoard(next) {
    const candidate = restoreLionRackScanOrder(normalizeLionRackBoard(next));
    let sharedSaved = false;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(LION_RACK_BOARD_KEY, JSON.stringify(candidate)); sharedSaved = true;
      }
    } catch (error) {}
    const localSaved = writeJSON(localStorage, LION_RACK_BOARD_KEY, candidate, 'Rack board');
    if (!sharedSaved && !localSaved) { lionRackFeedback('Could not save the rack board. Assignment was not changed.'); return false; }
    lionRackBoard = candidate; indexLionRacks();
    const board = document.getElementById('eve-lion-rack-board');
    if (board) board.dataset.signature = '';
    refreshLionRackAlertLocations();
    refreshLionRackBoard(lionRackSnapshot);
    scanLionKing();
    return true;
  }

  function assignLionRackSlot(rack, position, serial, partner, options = {}) {
    const sn = lionRackSerial(serial), other = partner ? lionRackSerial(partner) : '';
    if (!sn || (partner && !other) || other === sn) {
      lionRackFeedback('Scan a JBOG serial. The optional other node must be a different serial.'); return false;
    }
    const next = readLionRackBoard();
    if (!next.slots[rack] || !Number.isInteger(position) || position < 0 || position > 3) return false;
    const target = next.slots[rack][position];
    if (target.serial && target.serial !== sn && target.partner !== sn && !options.replace) {
      lionRackFeedback(rack + ' slot ' + (position + 1) + ' is occupied by ' + target.serial + '. Clear it or choose an empty slot.');
      return false;
    }
    // Move the whole physical assignment, including a previously saved second
    // node, and remove its old slot before storing the new one.
    let companion = other;
    Object.values(next.slots).forEach(entries => entries.forEach(entry => {
      if (entry.serial === sn || entry.partner === sn) {
        if (!companion) companion = entry.serial === sn ? entry.partner : entry.serial;
      }
    }));
    Object.values(next.slots).forEach(entries => entries.forEach((entry, index) => {
      if ([entry.serial, entry.partner].some(value => value && (value === sn || value === companion))) {
        entries[index] = { serial: '', partner: '' };
      }
    }));
    next.slots[rack][position] = { serial: sn, partner: companion || '' };
    if (!saveLionRackBoard(next)) return false;
    lionRackFeedback(sn + ' saved in ' + rack + ' · JBOG ' + (position + 1) + '.');
    return true;
  }

  function clearLionRackSlot(rack, position, expectedSerial) {
    const next = readLionRackBoard(), entry = next.slots[rack]?.[position];
    if (!Number.isInteger(position) || !entry?.serial) return false;
    if (expectedSerial && entry.serial !== expectedSerial) {
      // Another tab may have assigned a different JBOG since this was drawn.
      lionRackBoard = next; indexLionRacks();
      refreshLionRackAlertLocations(); refreshLionRackBoard(lionRackSnapshot);
      lionRackFeedback('This slot changed. Use the × on its current JBOG.');
      return false;
    }
    next.slots[rack][position] = { serial: '', partner: '' };
    if (!saveLionRackBoard(next)) return false;
    if (lionRackSelected?.rack === rack && lionRackSelected.position === position) {
      const input = document.getElementById('lion-rack-serial');
      if (input) input.value = '';
      renderLionRackSelection();
      lionRackFeedback('Slot cleared. Ready for a new JBOG.');
    }
    return true;
  }

  function updateLionRackSeenTimes(snapshot) {
    if (!snapshot?.attention?.usable) return;
    const now = Date.now();
    if (!lionRackSeenTimes) {
      const saved = readJSON(localStorage, LION_RACK_SEEN_KEY, {}, 'Rack observation times');
      lionRackSeenTimes = Object.fromEntries(Object.entries(isRecordObject(saved) ? saved : {})
        .filter(([key, value]) => key.length <= 300 && isRecordObject(value) && Number.isFinite(value.at) &&
          value.at > 0 && value.at <= now + 600000 && Number.isSafeInteger(value.episode) &&
          value.episode >= 0 && typeof value.present === 'boolean').slice(0, LION_MAX_RUNS));
    }
    const alerts = new Map(loadActiveAlerts().filter(record => record.tracker === 'lionking' &&
      record.phaseSource === 'ramses-failed-board' && Number.isFinite(record.ts))
      .map(record => [record.runKey, record.ts]));
    const present = new Set();
    let changed = false;
    snapshot.attention.rows.forEach(row => {
      const episode = ramsesFailedState?.members[row.key]?.episode || 0;
      const eventKey = JSON.stringify(['ramses-failed-board', row.serial, row.operation, episode]);
      const alertAt = alerts.get(eventKey);
      const prior = lionRackSeenTimes[row.key];
      present.add(row.key);
      if (!prior || !prior.present || prior.episode !== episode) {
        lionRackSeenTimes[row.key] = { at: Number.isFinite(alertAt) ? alertAt : now, episode, present: true };
        changed = true;
      } else if (Number.isFinite(alertAt) && alertAt < prior.at) {
        prior.at = alertAt; changed = true;
      }
    });
    Object.entries(lionRackSeenTimes).forEach(([key, value]) => {
      if (value.present && !present.has(key)) { value.present = false; changed = true; }
    });
    const excess = Object.keys(lionRackSeenTimes).length - LION_MAX_RUNS;
    if (excess > 0) Object.entries(lionRackSeenTimes).filter(([, value]) => !value.present)
      .sort((a, b) => a[1].at - b[1].at).slice(0, excess).forEach(([key]) => { delete lionRackSeenTimes[key]; changed = true; });
    if (changed) writeJSON(localStorage, LION_RACK_SEEN_KEY, lionRackSeenTimes, 'Rack observation times');
  }

  function lionRackObservations(snapshot) {
    const result = new Map();
    const hours = settings.lionHistoryHours === 'all' ? Infinity : Number(settings.lionHistoryHours);
    const dated = (snapshot?.rows || []).concat((snapshot?.pretestRows || []).map(row => ({
      ...row, status: 'PRETEST', startedAt: lionStartedAt(row.started || ''), statusText: 'Running PRETEST'
    })));
    dated.forEach(row => {
      if (['PASS', 'FAIL'].includes(row.status) &&
          (row.finishedAt || row.startedAt || 0) < Date.now() - hours * 3600000) return;
      const sn = lionRackSerial(row.tailSerial || row.serial);
      if (!sn) return;
      const prior = result.get(sn);
      if (!prior || (row.startedAt || 0) > (prior.startedAt || 0)) result.set(sn, row);
    });
    if (snapshot?.attention?.usable) snapshot.attention.rows.forEach(row => {
      const sn = lionRackSerial(row.tailSerial || row.serial), prior = result.get(sn);
      if (!sn) return;
      if (prior && ['RUNNING', 'PRETEST'].includes(prior.status)) {
        result.set(sn, { ...prior, boardNote: 'Also on failed action board' });
      } else {
        result.set(sn, { ...row, status: row.operation === 'GPU_JBOG_TEST' ? 'FAIL' : 'PRETEST_FAIL',
          started: '', observedAt: lionRackSeenTimes?.[row.key]?.at || null,
          statusText: 'Failed action board · ' + (row.route || row.statusText || 'Online') });
      }
    });
    return result;
  }

  // Rack-only metadata: these observations never enter source snapshots or alerts.
  const lionRackInfoCache = new Map();
  const lionRackInfoRequests = new Map();
  const LION_RACK_INFO_TTL_MS = 60000;

  function lionRackSourceInfo(serial) {
    const sn = lionRackSerial(serial);
    if (!sn) return null;
    const indexed = lionRackNodeDisplay.get(sn);
    if (indexed) return indexed;
    const candidates = [...lionRackObservations(lionRackSnapshot).values()].filter(row =>
      [row.tailSerial || row.serial, row.headSerial].some(value => lionRackSerial(value) === sn));
    candidates.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return candidates[0] || null;
  }

  function lionRackInfoForSerial(serial) {
    const sn = lionRackSerial(serial), source = lionRackSourceInfo(sn);
    const cached = lionRackInfoCache.get(sn)?.row;
    if (!cached) return source;
    if (!source) return cached;
    if ((source.startedAt || 0) < cached.startedAt && source.started) return cached;
    const sameRun = source.startedAt === cached.startedAt || !source.started;
    return sameRun ? { ...cached, ...source, headSerial: source.headSerial || cached.headSerial,
      detailURL: cached.detailURL, uutId: cached.uutId, lookupAt: cached.lookupAt,
      model: source.model || cached.model, customer_ipn: source.customer_ipn || cached.customer_ipn,
      customer: source.customer || cached.customer,
      jiraKey: source.jiraKey || cached.jiraKey } : source;
  }

  function lionRackAPIRow(record, serial) {
    const tail = lionRackSerial(record?.uut_sn), head = lionRackSerial(record?.fixture_sn);
    if (!tail || ![tail, head].includes(serial) || !lionTestViewAPIRun(record, tail)) return null;
    const raw = typeof record.status === 'string' ? record.status.trim() : '';
    const word = raw.toUpperCase().replace(/[\s_-]+/g, '');
    const status = ['PASS', 'PASSED', 'SUCCESS', 'TESTPASS', 'TESTSUCCESS'].includes(word) ? 'PASS' :
      ['FAIL', 'FAILED', 'FAILURE', 'TESTFAIL', 'TESTFAILURE'].includes(word) ? 'FAIL' :
      ['RUNNING', 'INTEST', 'TESTING', 'INPROGRESS'].includes(word) ? 'RUNNING' : 'UNKNOWN';
    const started = record.started.trim(), startedAt = lionStartedAt(started);
    const finished = typeof record.finished === 'string' ? record.finished.trim() : '';
    const finish = finished ? lionStartedAt(finished) : NaN;
    if (startedAt > Date.now() + 600000) return null;
    const finishedAt = Number.isFinite(finish) && finish >= startedAt && finish <= Date.now() + 600000 ? finish : null;
    const text = field => typeof record[field] === 'string' ? record[field].trim().slice(0, 160) : '';
    return { source: 'rack-api', jbog: tail, tailSerial: tail, headSerial: head,
      started, startedAt, finished: finishedAt === null ? '' : finished, finishedAt,
      durationMs: finishedAt === null ? null : finishedAt - startedAt, status,
      statusText: 'GPU_JBOG_TEST · ' + (raw || 'Unknown status'), operation: 'GPU_JBOG_TEST',
      model: text('model'), customer_ipn: text('customer_ipn'), customer: text('customer'),
      uutId: String(record.id), detailURL: new URL('/uut/detail/' + record.id, TESTVIEW_LIST_URL).href,
      lookupAt: Date.now() };
  }

  async function lookupLionRackInfo(serial) {
    const sn = lionRackSerial(serial);
    if (!sn) return null;
    const cached = lionRackInfoCache.get(sn);
    if (cached && Date.now() - cached.at < LION_RACK_INFO_TTL_MS) return cached.row;
    if (lionRackInfoRequests.has(sn)) return lionRackInfoRequests.get(sn);
    const pending = (async () => {
      for (const field of ['uut_sn', 'fixture_sn']) {
        const url = new URL(LION_TESTVIEW_API_PATH, TESTVIEW_LIST_URL);
        for (const name of ['id', 'uut_sn', 'fixture_sn', 'status', 'started', 'finished', 'operation',
          'model', 'customer_ipn', 'customer'])
          url.searchParams.append('fields', name);
        for (const [key, value] of Object.entries({ only_latest_uut_status: 'true',
          operation: 'GPU_JBOG_TEST', operation_is_exact: 'true', page_num: '1',
          page_size: '10', return_page_info: 'true', [field]: sn })) url.searchParams.set(key, value);
        const body = await requestLionKingAPI(url);
        if (!body) break;
        const rows = lionTestViewAPIRecords(body).map(record => lionRackAPIRow(record, sn)).filter(Boolean);
        rows.sort((a, b) => b.startedAt - a.startedAt);
        if (!rows.length) continue;
        const latest = rows.filter(row => row.startedAt === rows[0].startedAt);
        if (new Set(latest.map(row => row.uutId)).size !== 1) break;
        const row = latest[0];
        lionRackInfoCache.set(sn, { at: Date.now(), row });
        return row;
      }
      return null;
    })().catch(() => null).finally(() => lionRackInfoRequests.delete(sn));
    lionRackInfoRequests.set(sn, pending);
    return pending;
  }

  async function loadLionRackSlotInfo(rack, position, serial, onUpdate) {
    const sn = lionRackSerial(serial);
    const current = () => {
      const entry = lionRackBoard?.slots[rack]?.[position];
      return !!sn && !!entry && [entry.serial, entry.partner].includes(sn);
    };
    const update = (loading, message) => {
      if (!current() || typeof onUpdate !== 'function') return;
      const row = lionRackInfoForSerial(sn);
      const key = row?.jiraKey || jiraLatestKey(row?.tailSerial || sn), validKey = JIRA_KEY_PATTERN.test(String(key || '')) ? key : '';
      onUpdate({ row, loading, message, jiraKey: validKey,
        jiraURL: jiraListUrl(row?.tailSerial || sn, 'updated', validKey) });
    };
    if (!current()) return;
    update(true, 'Saved · loading test details…');
    const row = await lookupLionRackInfo(sn);
    if (!current()) return;
    update(false, row || lionRackSourceInfo(sn) ? 'Saved · live details ready' :
      'Saved · no matching test details available. Your rack assignment is kept.');
    const jiraSerial = lionRackInfoForSerial(sn)?.tailSerial || sn;
    try { await resolveJiraUrl(jiraSerial, 0); } catch (error) {}
    const cached = lionRackInfoCache.get(sn), jiraKey = jiraLatestKey(jiraSerial);
    if (cached && JIRA_KEY_PATTERN.test(String(jiraKey || ''))) cached.row.jiraKey = jiraKey;
    update(false, '');
  }

  function lionRackStatusText(row, average) {
    if (!row) return 'Not in current source';
    if (row.status === 'RUNNING') {
      const finish = average ? row.startedAt + average : null;
      return 'Running' + (finish ? ' · ETA ' + siteDateTime(new Date(finish)) : ' · no estimate yet');
    }
    if (row.status === 'PRETEST') return 'Running PRETEST';
    if (row.status === 'PRETEST_FAIL') return 'PRETEST · failed action board';
    if (row.status === 'FAIL') return row.started ? 'Failed' : 'Failed action board';
    if (row.status === 'PASS') return 'Passed' + (row.durationMs ? ' · ' + lionHoursMinutes(row.durationMs) : '');
    return 'Unknown result';
  }

  function setLionRackPairedScroll(element, left) {
    element.scrollLeft = left;
    lionRackExpectedScroll.set(element, element.scrollLeft);
  }

  function updateLionRackPairedScroll() {
    const board = document.getElementById('eve-lion-rack-board');
    if (!board || board.hidden) return;
    const group = board.querySelector('.lion-rack-linked-rows');
    const shared = group?.querySelector('.lion-rack-shared-scroll');
    if (!shared) return;
    const scrollers = [...group.querySelectorAll('details.lion-rack-row')]
      .filter(row => row.open && !row.hidden).map(row => row.querySelector('.lion-rack-row-scroll'));
    const range = Math.max(0, ...scrollers.map(row => row.scrollWidth - row.clientWidth));
    shared.hidden = range <= 1;
    if (shared.hidden) return;
    shared.firstElementChild.style.width = (shared.clientWidth + range) + 'px';
    lionRackPairedScrollLeft = Math.max(0, Math.min(lionRackPairedScrollLeft, range));
    setLionRackPairedScroll(shared, lionRackPairedScrollLeft);
    scrollers.forEach(row => setLionRackPairedScroll(row, lionRackPairedScrollLeft));
  }

  function queueLionRackPairedScroll() {
    if (lionRackPairedScrollFrame) return;
    lionRackPairedScrollFrame = requestAnimationFrame(() => {
      lionRackPairedScrollFrame = 0;
      updateLionRackPairedScroll();
    });
  }

  function refreshLionRackBoard(snapshot) {
    if (snapshot) lionRackSnapshot = snapshot;
    const board = document.getElementById('eve-lion-rack-board');
    if (!board || !lionRackBoard || lionRackDragging) return;
    updateLionRackSeenTimes(lionRackSnapshot);
    lionRackDisplay = lionRackObservations(lionRackSnapshot);
    lionRackNodeDisplay = new Map(lionRackDisplay);
    lionRackDisplay.forEach(row => {
      const head = lionRackSerial(row.headSerial);
      const prior = lionRackNodeDisplay.get(head);
      if (head && (!prior || (row.startedAt || 0) > (prior.startedAt || 0))) lionRackNodeDisplay.set(head, row);
    });
    const average = lionKingPassAverage(lionRackSnapshot?.rows || []).averageMs;
    const rackCount = lionRackBoard.rows.reduce((total, row) => total + row.racks.length, 0);
    const occupied = Object.values(lionRackBoard.slots).flat().filter(entry => entry.serial).length;
    setTextIfChanged(board.querySelector('#lion-rack-count'), occupied + '/' + rackCount * 4 + ' slots assigned · ' + rackCount + ' racks');
    setTextIfChanged(board.querySelector('#lion-rack-source'), !lionHasCompletedSnapshot
      ? 'Waiting for the live source; assignments are saved.' : 'Last source update: ' + siteDateTime(new Date(rackDataAt)));
    const signature = JSON.stringify([lionRackBoard, [...lionRackDisplay].map(([sn, row]) =>
      [sn, row.headSerial, row.status, row.started, row.finished, row.durationMs, row.statusText, row.boardNote, row.jiraKey, row.observedAt]), average, settings.sections,
      lionRackSelected, Math.floor(Date.now() / 60000), Object.values(lionRackBoard.slots).flat().filter(entry => entry.serial).map(entry => {
        const info = lionRackInfoForSerial(entry.serial);
        return [entry.serial, info?.status, info?.started, info?.finished, info?.durationMs,
          info?.jiraKey || jiraLatestKey(info?.tailSerial || entry.serial), info?.lookupAt];
      })]);
    const grid = board.querySelector('#lion-rack-grid');
    if (board.dataset.signature !== signature) {
      const scrolls = [...grid.querySelectorAll('.lion-rack-row-scroll')].map(row => row.scrollLeft);
      board.dataset.signature = signature;
      const renderedRows = lionRackBoard.rows.map((row, rowIndex) =>
        '<section class="lion-rack-area" data-area="' + row.area + '"><div class="lion-rack-area-head">' +
        '<button type="button" class="lion-rack-row-toggle" data-lion-row-toggle="' + row.area +
        '" aria-controls="lion-rack-row-' + row.area + '" aria-expanded="' + lionAreaSettings(row.area).show +
        '" title="Enable or disable ' + escapeHtml(LION_AREAS[row.area]) + ' visibility and notifications">' +
        '<span class="lion-rack-row-chevron" aria-hidden="true">›</span><strong>' + escapeHtml(LION_AREAS[row.area]) +
        '</strong><small>' + row.racks.length + ' racks</small></button>' +
        '<div class="lion-rack-area-controls" data-lion-area-controls="' + row.area + '"></div></div>' +
        '<details id="lion-rack-row-' + row.area + '" class="lion-rack-row" data-area="' + row.area + '" data-row="' + rowIndex + '"' +
        (lionAreaSettings(row.area).show ? ' open' : ' hidden') + '>' +
        '<summary hidden>' + escapeHtml(LION_AREAS[row.area]) + ' racks</summary>' +
        '<div class="lion-rack-row-scroll"><div class="lion-rack-row-content">' +
        row.racks.map(rack => {
          const occupied = lionRackBoard.slots[rack].filter(entry => entry.serial).length;
          return '<article class="lion-physical-rack" data-rack="' + rack + '">' +
            '<header draggable="true" data-rack-drag="' + rack + '"><strong>' + rack + '</strong>' +
            '<span class="lion-rack-assigned">' + occupied + '/4</span><span class="lion-rack-layout-actions">' +
            '<button type="button" data-rack-action="left" title="Move rack left" aria-label="Move ' + rack + ' left">‹</button>' +
            '<button type="button" data-rack-action="right" title="Move rack right" aria-label="Move ' + rack + ' right">›</button>' +
            '<button type="button" data-rack-action="remove" title="Remove empty rack" aria-label="Remove empty ' + rack + '">×</button></span></header>' +
            '<div id="lion-rack-positions-' + rack + '" class="lion-rack-positions">' +
            [0, 2, 3, 1].map(position => renderLionRackSlot(rack, position, lionRackBoard.slots[rack][position])).join('') +
            '</div></article>';
        }).join('') + '</div></div></details></section>');
      grid.innerHTML = '<section class="lion-rack-linked-rows" aria-label="B6 and B7 racks">' + renderedRows.slice(0, 2).join('') +
        '<div class="lion-rack-shared-scroll" role="region" tabindex="0" aria-label="Scroll B6 and B7 racks together" hidden>' +
        '<div class="lion-rack-shared-scroll-content"></div></div></section>' +
        renderedRows.slice(2).join('');
      grid.querySelectorAll('.lion-rack-row-scroll').forEach((row, index) => {
        if (row.closest('.lion-rack-linked-rows')) setLionRackPairedScroll(row, lionRackPairedScrollLeft);
        else row.scrollLeft = scrolls[index] || 0;
      });
      board.querySelector('#lion-rack-options').innerHTML = lionRackBoard.rows.flatMap(row => row.racks)
        .map(rack => '<option value="' + rack + '"></option>').join('');
    }
    const query = board.querySelector('#lion-rack-find').value.trim().toUpperCase();
    const unplaced = [...lionRackDisplay].filter(([, row]) => lionRowShow(row) && (!lionRackPlacement(row) || lionRackPlacement(row).conflict))
      .filter(([sn, row]) => !query || (sn + ' ' + (row.headSerial || '') + ' ' + (row.status || '')).toUpperCase().includes(query));
    const pool = board.querySelector('#lion-rack-unplaced');
    const poolHTML = unplaced.map(([sn, row]) => '<button type="button" draggable="true" data-unplaced="' + escapeHtml(sn) +
      '" class="lion-rack-pool-item lion-rack-' + row.status.toLowerCase() + '">' + escapeHtml(sn) +
      '<small>' + escapeHtml(lionRackStatusText(row, null)) + '</small></button>').join('') ||
      '<span class="lion-rack-note">' + (query ? 'No matching unassigned JBOGs.' : 'No unassigned JBOGs in the current source.') + '</span>';
    if (pool.innerHTML !== poolHTML) pool.innerHTML = poolHTML;
    setTextIfChanged(board.querySelector('#lion-rack-unplaced-count'), String(unplaced.length));
    renderLionRackWorkControls();
    renderLionRackSelection();
    queueLionRackPairedScroll();
    if (!board.hidden && lionRackSelected && Date.now() >= lionRackSelectionNextAt) hydrateLionRackSelection();
  }

  function lionRackTimestampMarkup(row) {
    if (!row) return '';
    const startedAt = row.started ? lionStartedAt(row.started) : NaN;
    const finishedAt = row.finished ? lionStartedAt(row.finished) : NaN;
    const completed = ['PASS', 'FAIL'].includes(row.status) && Number.isFinite(startedAt) &&
      Number.isFinite(finishedAt) && finishedAt >= startedAt;
    const today = isoDateParts(new Date().toISOString()).date;
    const stamp = (label, at, relative) => {
      const date = new Date(at);
      const age = relative ? formatRelativeTime(at).split(' \u{b7} ')[0].replace(/^\S+\s+/, '') : '';
      const parts = isoDateParts(date.toISOString());
      const clock = (parts.date === today ? '' : parts.date.slice(5).replace('-', '/') + ' ') + parts.time.slice(0, 5);
      const shortLabel = label === 'Started' ? 'Start' : label === 'Finished' ? 'End' : label;
      return '<small class="lion-rack-stamp" title="' + escapeHtml(label + ': ' + siteDateTime(date) + (age ? ' · ' + age : '')) + '"><span>' +
        escapeHtml(shortLabel + (!completed && age ? ' · ' + age : '')) + '</span><time datetime="' + date.toISOString() + '">' +
        escapeHtml(clock) + '</time></small>';
    };
    let html = Number.isFinite(startedAt) ? stamp('Started', startedAt, false) : '';
    if (completed) html += stamp('Finished', finishedAt, true);
    // The failed action board has no test start/finish. Keep its observation
    // time distinct from a completed test's actual timestamp.
    if (!Number.isFinite(startedAt) && Number.isFinite(row.observedAt)) html += stamp('Seen', row.observedAt, true);
    return html ? '<span class="lion-rack-stamps' + (completed ? ' has-two' : '') + '">' + html + '</span>' : '';
  }

  function renderLionRackSlot(rack, position, entry) {
    const row = entry.serial ? lionRackInfoForSerial(entry.serial) || lionRackInfoForSerial(entry.partner) : null;
    const conflict = row && lionRackPlacement(row)?.conflict;
    const state = conflict ? 'CONFLICT' : row?.status || (entry.serial ? 'ABSENT' : 'EMPTY');
    const work = lionRackAreaSettings(rack);
    const selected = lionRackSelected?.rack === rack && lionRackSelected.position === position;
    const label = { RUNNING: 'Running', PASS: 'Passed', FAIL: 'Test fail',
      PRETEST: 'Pre-test', PRETEST_FAIL: 'Pre-test fail', CONFLICT: 'Check location', ABSENT: 'No current data',
      UNKNOWN: 'Status unavailable' }[state] || 'Empty';
    const timing = row?.status === 'RUNNING' && Number.isFinite(row.startedAt)
      ? lionHoursMinutes(Date.now() - row.startedAt)
      : row?.status === 'PASS' && row.durationMs ? lionHoursMinutes(row.durationMs) : '';
    const jira = row?.jiraKey || jiraLatestKey(row?.tailSerial || entry.serial);
    const muted = work.show && entry.serial && !lionRowWatch(row || { tailSerial: entry.serial, headSerial: entry.partner });
    const description = escapeHtml(rack + ', ' + LION_SLOT_LABELS[position] + ', ' + (entry.serial || 'scan a JBOG'));
    return '<div class="lion-rack-slot lion-rack-' + (work.show ? state.toLowerCase() : 'hidden-slot') + (selected ? ' is-selected' : '') +
      (entry.serial ? ' has-remove' : '') +
      '" data-slot="' + position + '" role="group" aria-label="' + description + '">' +
      (entry.serial ? '<button type="button" class="lion-rack-slot-remove" data-slot-action="remove" data-slot-serial="' +
        escapeHtml(entry.serial) + '" draggable="false" title="Remove ' + escapeHtml(entry.serial) +
        ' from this slot" aria-label="Remove ' + description + ' from slot">×</button>' : '') +
      '<button type="button" class="lion-rack-slot-select" data-slot-action="select" aria-label="Select ' + description + '"' +
      (entry.serial ? ' draggable="true"' : '') + '>' +
      '<span class="lion-rack-slot-label">' + ['Top', 'Bottom', 'Left', 'Right'][position] + '</span>' +
      (!work.show ? '<span class="lion-rack-scan-hint">Hidden · click to show</span>' :
      entry.serial ? '<strong class="lion-rack-sn">' + escapeHtml(entry.serial) + '</strong>' +
        '<span class="lion-rack-result"><i></i>' + escapeHtml(label) +
        (muted ? '<span class="lion-rack-muted" role="img" aria-label="Alerts muted" title="Alerts muted">\u{1f515}</span>' : '') + '</span>' +
        (timing ? '<small class="lion-rack-time">' + escapeHtml(timing) + '</small>' : '') +
        lionRackTimestampMarkup(row) :
        '<span class="lion-rack-plus">+</span><span class="lion-rack-scan-hint">Scan</span>') +
      '</button>' +
      (entry.serial ? '<div class="lion-rack-slot-links"><button type="button" data-slot-action="jira" draggable="false" title="Open Jira for ' +
        escapeHtml(entry.serial + (JIRA_KEY_PATTERN.test(String(jira || '')) ? ' · ' + jira : '')) + '" aria-label="Open Jira for ' + description + '">' +
        'Jira ↗</button>' +
        '<button type="button" data-slot-action="testview" draggable="false" title="Open this JBOG in TestView 2.0" aria-label="Open TestView for ' +
        description + '">TestView ↗</button></div>' : '') + '</div>';
  }

  function renderLionRackSelection() {
    const board = document.getElementById('eve-lion-rack-board');
    const drawer = board?.querySelector('#lion-rack-drawer');
    if (!drawer || !lionRackSelected) return;
    const { rack, position } = lionRackSelected, entry = lionRackBoard.slots[rack]?.[position];
    if (!entry) { closeLionRackSelection(); return; }
    const area = lionRackBoard.rows.find(item => item.racks.includes(rack))?.area || 'unassigned';
    const parent = lionAreaSettings(area);
    setTextIfChanged(drawer.querySelector('#lion-rack-work-note'), !parent.show ? 'This row is disabled: hidden and alerts muted.' : '');
    const row = entry.serial ? lionRackInfoForSerial(entry.serial) || lionRackInfoForSerial(entry.partner) : null;
    setTextIfChanged(drawer.querySelector('#lion-rack-selected-name'), rack);
    setTextIfChanged(drawer.querySelector('#lion-rack-selected-position'), LION_SLOT_LABELS[position] + ' · JBOG ' + (position + 1));
    setTextIfChanged(drawer.querySelector('#lion-rack-scan-label'), entry.serial ? 'Scan a new serial to replace this JBOG' : 'Scan the JBOG serial');
    setTextIfChanged(drawer.querySelector('#lion-rack-scan-save'), entry.serial ? 'Replace JBOG' : 'Add JBOG');
    const detail = drawer.querySelector('#lion-rack-selected-info');
    const average = lionKingPassAverage(lionRackSnapshot?.rows || []).averageMs;
    const finish = row?.status === 'RUNNING' && average && Number.isFinite(row.startedAt) ? row.startedAt + average : null;
    const key = row?.jiraKey || jiraLatestKey(row?.tailSerial || entry.serial);
    const paired = row ? [row.tailSerial, row.headSerial].find(sn => lionRackSerial(sn) && lionRackSerial(sn) !== entry.serial) : entry.partner;
    const data = [
      ['Started', row?.started], ['Finished', row?.finished],
      ['Elapsed', row?.status === 'RUNNING' && Number.isFinite(row.startedAt) ? lionHoursMinutes(Date.now() - row.startedAt) : ''],
      ['Pass time', row?.status === 'PASS' && row.durationMs ? lionHoursMinutes(row.durationMs) : ''],
      ['Estimated finish', finish ? siteDateTime(new Date(finish)) : ''],
      ['Paired node', paired], ['Model', row?.model], ['Part number', row?.customer_ipn],
      ['Route', row?.route], ['Ticket', JIRA_KEY_PATTERN.test(String(key || '')) ? key : '']
    ].filter(([, value]) => value);
    const html = entry.serial ? '<div class="lion-selected-serial">' + escapeHtml(entry.serial) + '</div>' +
      '<div class="lion-selected-status lion-rack-' + (row?.status || 'absent').toLowerCase() + '">' +
      escapeHtml(row ? lionRackStatusText(row, null) : 'Assignment saved · waiting for test data') + '</div>' +
      '<dl class="lion-selected-facts">' + data.map(([name, value]) => '<div><dt>' + escapeHtml(name) +
        '</dt><dd>' + escapeHtml(value) + '</dd></div>').join('') + '</dl>' +
      (finish ? '<p class="lion-rack-note">Estimate based on ' + lionKingPassAverage(lionRackSnapshot?.rows || []).samples + ' recent passed runs.</p>' : '') +
      (row?.boardNote ? '<p class="lion-rack-note">' + escapeHtml(row.boardNote) + '</p>' : '') :
      '<div class="lion-scan-empty"><span>⌁</span><strong>Ready to scan</strong><p>Scan one serial. Its test details appear here automatically.</p></div>';
    if (detail.innerHTML !== html) detail.innerHTML = html;
    drawer.querySelector('#lion-rack-open-test').hidden = !entry.serial;
    drawer.querySelector('#lion-rack-open-jira').hidden = !entry.serial;
    drawer.querySelector('#lion-rack-copy-selected').hidden = !entry.serial;
    drawer.querySelector('#lion-rack-clear-selected').hidden = !entry.serial;
    setTextIfChanged(drawer.querySelector('#lion-rack-open-jira'),
      JIRA_KEY_PATTERN.test(String(key || '')) ? key : 'Search Jira');
  }

  function closeLionRackSelection() {
    const board = document.getElementById('eve-lion-rack-board');
    lionRackSelected = null;
    if (!board) return;
    board.classList.remove('has-selection'); board.querySelector('#lion-rack-drawer').hidden = true;
    board.dataset.signature = ''; refreshLionRackBoard(lionRackSnapshot);
  }

  function linkLionRackPartner(rack, position, serial, row) {
    if (!row) return;
    const companion = [row.tailSerial, row.headSerial].map(lionRackSerial).find(value => value && value !== serial);
    if (!companion) return;
    const current = lionRackBoard.slots[rack]?.[position];
    if (!current || current.serial !== serial || current.partner === companion) return;
    const otherLocation = lionRackIndex.get(companion);
    if (otherLocation && (otherLocation.rackId !== rack || otherLocation.rackSlot !== position + 1)) return;
    const next = readLionRackBoard(), entry = next.slots[rack]?.[position];
    if (entry?.serial !== serial || (entry.partner && entry.partner !== companion)) return;
    entry.partner = companion; saveLionRackBoard(next);
  }

  async function hydrateLionRackSelection() {
    if (!lionRackSelected) return;
    const { rack, position } = lionRackSelected, serial = lionRackBoard.slots[rack]?.[position]?.serial;
    if (!serial) return;
    const identity = JSON.stringify([rack, position, serial]);
    if (lionRackSelectionLoading === identity) return;
    lionRackSelectionLoading = identity; lionRackSelectionNextAt = Date.now() + LION_RACK_INFO_TTL_MS;
    try {
      await loadLionRackSlotInfo(rack, position, serial, info => {
        linkLionRackPartner(rack, position, serial, info.row);
        refreshLionRackBoard(lionRackSnapshot);
        if (lionRackSelected?.rack === rack && lionRackSelected.position === position) {
          renderLionRackSelection();
          if (info.message) lionRackFeedback(info.message);
        }
      });
    } finally {
      if (lionRackSelectionLoading === identity) lionRackSelectionLoading = false;
    }
  }

  function submitLionRackScan() {
    const board = document.getElementById('eve-lion-rack-board');
    if (!board || board.hidden || !lionRackSelected) return;
    const input = board.querySelector('#lion-rack-serial'), serial = lionRackSerial(input.value);
    if (!serial || serial.length < 6) { lionRackFeedback('Scan the complete JBOG serial, then press Enter.'); input.focus(); return; }
    const { rack, position } = lionRackSelected;
    const known = lionRackInfoForSerial(serial);
    let companion = known ? [known.tailSerial, known.headSerial].map(lionRackSerial).find(value => value && value !== serial) : '';
    const companionLocation = companion && lionRackIndex.get(companion);
    if (companionLocation && (companionLocation.rackId !== rack || companionLocation.rackSlot !== position + 1)) companion = '';
    if (!assignLionRackSlot(rack, position, serial, companion || '', { replace: true })) return;
    input.value = ''; input.focus();
    lionRackSelectionNextAt = 0;
    renderLionRackSelection(); hydrateLionRackSelection();
  }

  function setLionRackView(open) {
    const board = document.getElementById('eve-lion-rack-board');
    if (!board) return;
    if (open) {
      board.hidden = false; fitLionRackWindow(board); saveLionRackWindow(board);
    } else {
      if (!board.hidden) saveLionRackWindow(board);
      board.hidden = true;
      lionRackUI = { ...(lionRackUI || {}), open: false };
      writeJSON(localStorage, LION_RACK_WINDOW_KEY, lionRackUI, 'Rack board window');
    }
    document.documentElement.classList.toggle('lion-rack-map-active', open);
    if (open) refreshLionRackBoard(lionRackSnapshot);
    else refreshAlertChrome();
  }

  function selectLionRackSlot(rack, position, serial) {
    const board = document.getElementById('eve-lion-rack-board');
    if (!board || !lionRackBoard.slots[rack]?.[position]) return;
    lionRackSelected = { rack, position }; lionRackSelectionNextAt = 0;
    board.classList.add('has-selection'); board.querySelector('#lion-rack-drawer').hidden = false;
    const input = board.querySelector('#lion-rack-serial');
    input.value = serial || '';
    board.dataset.signature = ''; refreshLionRackBoard(lionRackSnapshot);
    renderLionRackSelection();
    input.focus(); input.select();
    lionRackFeedback('Selected ' + rack + ' · ' + LION_SLOT_LABELS[position] + '. Scan one serial.');
    if (lionRackBoard.slots[rack][position].serial) hydrateLionRackSelection();
  }

  async function openLionRackJira(serial) {
    let tab = null;
    try { tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null; } catch (error) {}
    let url = jiraSearchUrl(serial, 0);
    try { url = await resolveJiraListUrl(serial, 'updated') || url; } catch (error) {}
    if (tab) {
      if (!tab.closed) try { if (tab.location.href === 'about:blank') tab.location.replace(url); } catch (error) {}
    } else openFromNotification(url);
  }

  function openLionRackSlotLink(rack, position, action) {
    const entry = lionRackBoard?.slots[rack]?.[position];
    if (!entry?.serial) return;
    const row = lionRackInfoForSerial(entry.serial) || lionRackInfoForSerial(entry.partner);
    const serial = row?.tailSerial || entry.serial;
    if (action === 'jira') openLionRackJira(serial);
    else if (action === 'testview') {
      const pretest = ['PRETEST', 'PRETEST_FAIL'].includes(row?.status) ||
        ['PRETEST', 'GPU_JBOG_TEST_PRETEST'].includes(row?.operation);
      if (row?.detailURL && !pretest) openExternal(row.detailURL);
      else openLionKingTestView(serial, row?.started || '', openExternal,
        pretest ? 'GPU_JBOG_TEST_PRETEST' : 'GPU_JBOG_TEST');
    }
  }

  function saveLionRackWindow(board) {
    // Persist whether the map is open, never the browser's temporary size.
    lionRackUI = { layout: 'viewport-fit-v1', open: !board.hidden };
    writeJSON(localStorage, LION_RACK_WINDOW_KEY, lionRackUI, 'Rack board window');
  }

  function fitLionRackWindow(board) {
    // Viewport units grow again when a restored/maximized browser grows.
    // Old saved pixel dimensions must not keep the map at its smaller size.
    board.style.width = 'max(1px, calc(100vw - 20px))';
    board.style.height = 'max(1px, calc(100vh - 20px))';
    board.style.minWidth = 'min(280px, max(1px, calc(100vw - 20px)))';
    board.style.minHeight = 'min(240px, max(1px, calc(100vh - 20px)))';
    board.style.left = '10px'; board.style.top = '10px';
    queueLionRackPairedScroll();
  }

  function mountLionRackBoard() {
    const board = document.createElement('section');
    board.id = 'eve-lion-rack-board'; board.setAttribute('data-lion-tracker-ui', 'physical-racks');
    board.setAttribute('aria-label', 'Lion King physical rack board');
    board.innerHTML = '<header id="lion-rack-title"><div><span class="lion-rack-eyebrow">LION KING · LIVE OPERATIONS</span>' +
      '<strong>Rack Board</strong><small id="lion-rack-count" title="Click a slot, then scan its serial"></small>' +
      '<span id="lion-rack-source" hidden></span></div><div class="lion-rack-window-actions">' +
      '<details class="lion-rack-board-options"><summary aria-label="Board controls" title="Board controls">⋯</summary>' +
      '<div class="lion-rack-all-controls"><button type="button" data-all-work="enabled:true">Enable all</button>' +
      '<button type="button" data-all-work="enabled:false">Disable all</button>' +
      '<button type="button" id="lion-rack-edit-layout" aria-pressed="false">Edit layout</button></div></details>' +
      '<button type="button" id="lion-rack-back" title="Show tracker controls and alert cards">Back to tracker</button>' +
      '<button type="button" id="lion-rack-expand" title="Fit board to screen" aria-label="Expand rack board">⛶</button>' +
      '<button type="button" id="lion-rack-close" aria-label="Close rack board">×</button></div></header>' +
      '<div id="lion-rack-workspace"><div class="lion-rack-body"><div id="lion-rack-grid"></div>' +
      '<section class="lion-rack-area lion-rack-unplaced-section" data-area="unassigned"><div class="lion-rack-area-head">' +
      '<button type="button" class="lion-rack-row-toggle" data-lion-row-toggle="unassigned" aria-controls="lion-rack-row-unassigned" aria-expanded="false">' +
      '<span class="lion-rack-row-chevron" aria-hidden="true">›</span><strong>Unassigned</strong><small id="lion-rack-unplaced-count">0</small></button>' +
      '<div class="lion-rack-area-controls" data-lion-area-controls="unassigned"></div></div>' +
      '<details id="lion-rack-row-unassigned"><summary hidden>Unassigned JBOGs</summary>' +
      '<input id="lion-rack-find" placeholder="Find a serial or status" aria-label="Find an unassigned JBOG">' +
      '<p>Choose a rack slot, then click a serial here to place it.</p><div id="lion-rack-unplaced"></div></details></section>' +
      '<section id="lion-rack-layout-tools" hidden><h3>Layout &amp; backup</h3><div class="lion-rack-layout-controls">' +
      '<input id="lion-rack-barcode" list="lion-rack-options" autocomplete="off" placeholder="New rack barcode" aria-label="New rack barcode" maxlength="40">' +
      '<datalist id="lion-rack-options"></datalist><select id="lion-rack-new-row" aria-label="Row for new rack">' +
      '<option value="0">Row 1 · B6</option><option value="1">Row 2 · B7</option><option value="2">Row 3 · E2/E4/BL</option></select>' +
      '<button type="button" id="lion-rack-add">Add rack</button><button type="button" id="lion-rack-backup">Backup</button>' +
      '<button type="button" id="lion-rack-restore">Restore</button><input type="file" id="lion-rack-file" accept=".json,application/json" hidden></div>' +
      '<p class="lion-rack-note">Drag rack headers to arrange them. Drag a JBOG to an empty slot to move it. Each rack holds four JBOGs.</p></section></div>' +
      '<aside id="lion-rack-drawer" hidden><header><div><span class="lion-rack-eyebrow">SELECTED SLOT</span>' +
      '<strong id="lion-rack-selected-name"></strong><small id="lion-rack-selected-position"></small></div>' +
      '<button type="button" id="lion-rack-drawer-close" aria-label="Close slot details">×</button></header>' +
      '<div class="lion-rack-drawer-body">' +
      '<div id="lion-rack-work-note" class="lion-rack-note"></div><div id="lion-rack-selected-info"></div>' +
      '<form id="lion-rack-scan"><label id="lion-rack-scan-label" for="lion-rack-serial">Scan the JBOG serial</label>' +
      '<div class="lion-rack-scan-input"><span aria-hidden="true">⌁</span><input id="lion-rack-serial" autocomplete="off" spellcheck="false" placeholder="Scan serial here" maxlength="120" required></div>' +
      '<button type="submit" id="lion-rack-scan-save">Add JBOG</button><small>Scanner Enter saves automatically. You can also type a serial and press Enter.</small></form>' +
      '<div id="lion-rack-feedback" role="status">Ready to scan.</div><div class="lion-rack-detail-actions">' +
      '<button type="button" id="lion-rack-open-test">TestView ↗</button><button type="button" id="lion-rack-open-jira">Jira ↗</button>' +
      '<button type="button" id="lion-rack-copy-selected">Copy serial</button></div>' +
      '<button type="button" id="lion-rack-clear-selected">Remove from slot</button></div></aside></div>';
    const style = document.createElement('style');
    style.textContent = [
      '.lion-rack-map-active #eve-tracker-panel,.lion-rack-map-active #eve-alert-container{display:none!important}',
      '#eve-lion-rack-board{--lr-bg:#14181f;--lr-line:#2c3544;--lr-muted:#91a0b7;position:fixed;z-index:1000000;display:flex;flex-direction:column;resize:both;overflow:hidden;box-sizing:border-box;background:var(--lr-bg);color:#eaf0fa;border:1px solid #39475e;border-radius:16px;box-shadow:0 20px 65px #0008;font:13px Segoe UI,Arial,sans-serif;min-width:280px;min-height:240px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px)}',
      '#eve-lion-rack-board[hidden],#eve-lion-rack-board [hidden]{display:none!important}#eve-lion-rack-board *{box-sizing:border-box}',
      '#eve-lion-rack-board button,#eve-lion-rack-board input,#eve-lion-rack-board select{font:inherit;color:inherit;border:1px solid #354155;background:#202938;border-radius:8px;padding:7px 10px}#eve-lion-rack-board button{cursor:pointer}#eve-lion-rack-board button:hover{background:#2c3950}#eve-lion-rack-board button:focus-visible,#eve-lion-rack-board input:focus,#eve-lion-rack-board select:focus,.lion-rack-slot:focus-visible{outline:2px solid #6caeff;outline-offset:2px}',
      '#lion-rack-title{display:flex;align-items:center;justify-content:space-between;padding:17px 20px;background:#1b222d;cursor:move;touch-action:none;flex-shrink:0;border-bottom:1px solid var(--lr-line)}#lion-rack-title strong{display:block;font-size:22px;letter-spacing:-.4px;margin-top:3px}#lion-rack-title small{display:block;color:var(--lr-muted);margin-top:4px;font-size:11px}.lion-rack-eyebrow{display:block;font-size:9px;letter-spacing:1.4px;font-weight:700;color:#8cafdf}.lion-rack-window-actions{display:flex;gap:6px}.lion-rack-window-actions button{font-size:19px!important;padding:2px 9px!important}',
      '.lion-rack-toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--lr-line);font-size:12px;color:#c6d2e4}.lion-rack-toolbar>span{flex:1}.lion-rack-toolbar>button{font-size:11px!important}.lion-rack-legend{display:flex;gap:12px;font-size:10px;color:var(--lr-muted)}.lion-rack-legend span{display:flex;gap:5px;align-items:center}.lion-rack-legend i{width:6px;height:6px;border-radius:50%;display:inline-block}.is-running{background:#a7e548}.is-pass{background:#37cf91}.is-fail{background:#fb6385}',
      '#lion-rack-workspace{display:flex;flex:1;min-height:0;overflow:hidden}.lion-rack-body{overflow:auto;padding:14px 18px 20px;flex:1;min-width:0}.lion-rack-note{font-size:11px;line-height:1.6;color:var(--lr-muted)}#eve-lion-rack-board h3{margin:20px 0 10px;font-size:12px;font-weight:600;color:#cbd7e8}',
      '.lion-rack-row-scroll{overflow-x:auto;padding-bottom:10px;scrollbar-color:#3d4f6a transparent;scrollbar-width:thin}.lion-rack-row-content{display:flex;gap:14px;align-items:stretch;min-height:100px}.lion-physical-rack{flex:0 0 340px;border:1px solid #303c4f;border-radius:13px;background:#1a212c;padding:10px;overflow:hidden}.lion-physical-rack>header{display:flex;align-items:center;justify-content:space-between;min-height:28px;margin:0 2px 12px;font-size:12px}.lion-physical-rack>header strong{font-size:12px;letter-spacing:.3px}.lion-rack-assigned{font-size:10px;color:var(--lr-muted)}.lion-rack-layout-actions{display:none}.lion-layout-editing .lion-rack-layout-actions{display:flex;gap:3px}.lion-layout-editing .lion-rack-assigned{display:none}.lion-layout-editing [data-rack-drag]{cursor:grab}.lion-rack-layout-actions button{padding:0 6px!important}',
      '.lion-rack-positions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:104px 104px;gap:8px;position:relative}.lion-rack-positions:before{content:"";grid-column:2;grid-row:1/3;border:1px solid #4b5b72;background:#10151e;border-radius:10px;transform:scale(1.05,1.03);pointer-events:none}.lion-rack-slot{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-width:0;border:1px solid #40506a;border-radius:9px;background:#212c3b;cursor:pointer;text-align:center;padding:8px 4px;transition:border-color .15s,transform .15s,box-shadow .15s}.lion-rack-slot:hover{transform:translateY(-2px);border-color:#81b7fb;box-shadow:0 4px 18px #0004}.lion-rack-slot[data-slot="0"]{grid-column:2;grid-row:1}.lion-rack-slot[data-slot="1"]{grid-column:2;grid-row:2}.lion-rack-slot[data-slot="2"]{grid-column:1;grid-row:1/3;align-self:center;height:104px}.lion-rack-slot[data-slot="3"]{grid-column:3;grid-row:1/3;align-self:center;height:104px}.lion-rack-slot.is-selected{outline:2px solid #77b7ff;outline-offset:3px;box-shadow:0 0 18px #348dff2b}',
      '.lion-rack-slot-label{font-size:9px;color:#a5b6ce;text-transform:uppercase;letter-spacing:.8px}.lion-rack-sn{font:700 11px Consolas,monospace;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lion-rack-result{display:flex;gap:4px;align-items:center;justify-content:center;font-size:10px;line-height:1.2}.lion-rack-result i{width:5px;height:5px;background:currentColor;border-radius:50%;flex-shrink:0}.lion-rack-time,.lion-rack-ticket{font-size:9px;color:#b3c3d7}.lion-rack-plus{font-size:26px;font-weight:300;color:#7798c0;line-height:1}.lion-rack-scan-hint{font-size:10px;color:#a5bad4}.lion-rack-empty{border-style:dashed;background:#171e28}.lion-rack-running{border-color:#a8d94c!important;background:#26371c!important;color:#d8f4ad}.lion-rack-pass{border-color:#32c28a!important;background:#12392d!important;color:#bbefda}.lion-rack-fail,.lion-rack-pretest_fail{border-color:#e65c7d!important;background:#3d1f2c!important;color:#ffd0dc}.lion-rack-pretest{border-color:#4db0ed!important;background:#173246!important;color:#c6eaff}.lion-rack-conflict{border-color:#e5b65b!important;background:#42331d!important}',
      '#lion-rack-drawer{flex:0 0 320px;width:320px;background:#1b232f;border-left:1px solid #34445b;display:flex;flex-direction:column;min-height:0}#lion-rack-drawer>header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:17px 18px;border-bottom:1px solid var(--lr-line)}#lion-rack-drawer strong{display:block;font-size:16px;margin-top:7px}#lion-rack-drawer header small{display:block;font-size:11px;color:#acbcd2;margin-top:5px}#lion-rack-drawer-close{padding:2px 8px!important;font-size:18px!important}.lion-rack-drawer-body{overflow:auto;padding:16px 18px;flex:1;min-height:0}',
      '.lion-selected-serial{font:700 20px Consolas,monospace;overflow-wrap:anywhere;margin-bottom:10px}.lion-selected-status{display:inline-block;border:1px solid #40506a;border-radius:20px;padding:6px 10px;font-size:11px;line-height:1.5}.lion-selected-facts{margin:16px 0}.lion-selected-facts>div{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #2d394b;font-size:11px}.lion-selected-facts dt{color:#94a6bf;flex-shrink:0}.lion-selected-facts dd{margin:0;text-align:right;overflow-wrap:anywhere;color:#d5e0f1;min-width:0}.lion-scan-empty{text-align:center;padding:22px 8px 10px}.lion-scan-empty>span{display:block;font-size:40px;color:#77adf4}.lion-scan-empty strong{font-size:15px!important}.lion-scan-empty p{font-size:12px;line-height:1.6;color:#a5b6ce}',
      '#lion-rack-scan{display:flex;flex-direction:column;gap:9px;margin-top:20px}#lion-rack-scan label{font-size:11px;color:#b8c9df}.lion-rack-scan-input{display:flex;align-items:center;gap:6px;border:1px solid #597dae;background:#111b29;border-radius:10px;padding:4px 8px}.lion-rack-scan-input:focus-within{border-color:#8bc3ff;box-shadow:0 0 0 3px #438df023}.lion-rack-scan-input>span{color:#8fb9ec;font-size:25px}#lion-rack-serial{min-width:0;width:100%;border:0!important;background:transparent!important;font:14px Consolas,monospace!important;outline:0!important}#lion-rack-scan-save{background:#316ece!important;border-color:#4687e7!important;font-weight:600!important}#lion-rack-scan small{font-size:10px;line-height:1.5;color:#8fa3be}#lion-rack-feedback{font-size:11px;line-height:1.6;color:#9dc6fc;margin:12px 0;min-height:18px}.lion-rack-detail-actions{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 8px}.lion-rack-detail-actions button{font-size:11px!important}#lion-rack-clear-selected{font-size:10px!important;border:0!important;background:transparent!important;color:#ce92a0!important;padding-left:0!important}',
      '.lion-rack-unplaced-section{border-top:1px solid var(--lr-line);padding-top:13px;margin-top:15px}.lion-rack-unplaced-section summary{cursor:pointer;font-size:12px;color:#b5c8e4}.lion-rack-unplaced-section summary b{display:inline-block;margin-left:7px;background:#2c3b50;border-radius:12px;padding:2px 8px;font-size:10px}.lion-rack-unplaced-section p{font-size:11px;color:#91a5c0;line-height:1.5}#lion-rack-find{margin-top:12px;width:100%;max-width:340px}#lion-rack-unplaced{display:flex;flex-wrap:wrap;gap:6px;padding:8px 0}.lion-rack-pool-item{text-align:left;border-left-width:3px!important;font:11px Consolas,monospace!important}.lion-rack-pool-item small{display:block;font:10px Segoe UI,Arial,sans-serif;margin-top:4px}.lion-rack-layout-controls{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}#lion-rack-layout-tools{border-top:1px solid #35435a;margin-top:18px}',
      '.lion-rack-work-bar{padding:10px 18px;border-bottom:1px solid var(--lr-line);display:flex;flex-wrap:wrap;gap:10px;align-items:center}#lion-rack-work-controls{display:flex;flex:1;flex-wrap:wrap;gap:8px}.lion-work-area{display:flex;align-items:center;gap:9px;background:#1c2532;border:1px solid #334155;border-radius:9px;padding:8px 10px;flex:1;min-width:240px}.lion-work-area>div{flex:1}.lion-work-area strong{font-size:11px}.lion-work-area small{display:block;font-size:9px;color:#9caec8;margin-top:4px}.lion-work-toggle{display:flex;align-items:center;gap:5px;font-size:10px;color:#aebfd6;cursor:pointer;white-space:nowrap}.lion-work-toggle input{appearance:none!important;padding:0!important;width:25px;height:15px;border:0!important;border-radius:10px!important;background:#455166!important;position:relative;cursor:pointer;margin:0}.lion-work-toggle input:before{content:"";position:absolute;width:11px;height:11px;top:2px;left:2px;border-radius:50%;background:#d6e2f5;transition:left .15s}.lion-work-toggle input:checked{background:#427dd6!important}.lion-work-toggle input:checked:before{left:12px;background:#fff}.lion-rack-all-controls{display:flex;flex-wrap:wrap;gap:5px}.lion-rack-all-controls button{font-size:10px!important;padding:5px 7px!important}.lion-rack-work-row,.lion-rack-slot-work{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 3px 13px}.lion-rack-slot-work{margin:0 0 16px;padding-bottom:14px;border-bottom:1px solid #344156}.lion-physical-rack.is-hidden-rack{flex-basis:190px;align-self:flex-start;background:#171c25}.lion-rack-hidden-slot{border-style:dashed;background:#171c25;color:#7588a2}.lion-rack-hidden-slot .lion-rack-slot-label{color:#7588a2}',
      '#lion-rack-back{font-size:11px!important;padding:8px 10px!important;background:#275997!important;white-space:nowrap}.lion-work-toggle input:disabled{opacity:.4;cursor:default}',
      '.lion-rack-positions{grid-template-rows:136px 136px}.lion-rack-slot[data-slot="2"],.lion-rack-slot[data-slot="3"]{height:136px}.lion-rack-slot{padding:7px 4px}.lion-rack-slot-select{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0;width:100%;border:0!important;background:transparent!important;padding:0!important;color:inherit!important;text-align:center;cursor:pointer}.lion-rack-slot-links{display:flex;gap:3px;width:100%;flex-shrink:0}#eve-lion-rack-board .lion-rack-slot-links button{flex:1 1 auto;min-width:0;padding:4px 2px;font-size:9px;white-space:nowrap;background:#101820b3;border-color:#8298b64d;border-radius:5px}#eve-lion-rack-board .lion-rack-slot-links button:hover{background:#2c3950;border-color:#81b7fb}',
      '.lion-work-area[data-area="b6"],.lion-rack-row[data-area="b6"],#eve-tracker-panel .eve-section-row[data-section="b6"]{--lion-group-bg:#192638;--lion-group-border:#37506b;--lion-group-accent:#83a9d8}.lion-work-area[data-area="b7"],.lion-rack-row[data-area="b7"],#eve-tracker-panel .eve-section-row[data-section="b7"]{--lion-group-bg:#242236;--lion-group-border:#514762;--lion-group-accent:#b29dd8}.lion-work-area[data-area="lionking2"],.lion-rack-row[data-area="lionking2"],#eve-tracker-panel .eve-section-row[data-section="lionking2"]{--lion-group-bg:#1b2b2d;--lion-group-border:#3b575b;--lion-group-accent:#93bec3}',
      '#lion-rack-work-controls{align-items:stretch}.lion-work-pair{flex:2 1 460px;min-width:0;padding:6px;background:#171d27;border:1px solid #374359;border-radius:12px}.lion-work-pair-label{display:block;font-size:9px;font-weight:600;color:#b4c4dc;margin:0 4px 5px;letter-spacing:.5px}.lion-work-pair-cards{display:flex;gap:6px}.lion-work-pair-cards .lion-work-area{min-width:0;flex:1}.lion-work-area[data-area="b6"],.lion-work-area[data-area="b7"],.lion-work-area[data-area="lionking2"]{background:var(--lion-group-bg);border-color:var(--lion-group-border);border-left:3px solid var(--lion-group-accent)}.lion-work-area[data-area] strong{color:var(--lion-group-accent,#eaf0fa)}',
      '.lion-rack-linked-rows{padding:10px;border:1px solid #374359;border-radius:15px;background:#171d27;margin-top:12px}.lion-rack-linked-label{font-size:10px;font-weight:600;letter-spacing:.6px;color:#b4c4dc;margin:1px 3px 9px}.lion-rack-row{padding:12px 10px 4px;margin-top:16px;border:1px solid var(--lion-group-border);border-left:3px solid var(--lion-group-accent);border-radius:11px;background:var(--lion-group-bg)}.lion-rack-linked-rows .lion-rack-row{margin:8px 0 0}#eve-lion-rack-board .lion-rack-row>h3{margin:0 0 10px;color:var(--lion-group-accent)}.lion-rack-row .lion-physical-rack{border-color:var(--lion-group-border);background:#11192480}.lion-rack-row .lion-physical-rack>header strong{color:var(--lion-group-accent)}',
      '.lion-rack-row:not([open]){padding-bottom:12px}.lion-rack-row-title{display:flex;align-items:center;gap:9px;list-style:none;cursor:pointer;color:var(--lion-group-accent);padding:2px 1px}.lion-rack-row-title::-webkit-details-marker{display:none}.lion-rack-row-title:focus-visible{outline:2px solid var(--lion-group-accent);outline-offset:5px;border-radius:4px}.lion-rack-row-title strong{font-size:12px;font-weight:600}.lion-rack-row-title small{margin-left:auto;color:#a8b9cf;font-size:10px}.lion-rack-row-chevron{display:inline-block;font-size:21px;line-height:15px;transition:transform .15s}.lion-rack-row[open]>.lion-rack-row-title{margin-bottom:12px}.lion-rack-row[open]>.lion-rack-row-title .lion-rack-row-chevron{transform:rotate(90deg)}',
      '.lion-rack-linked-rows .lion-rack-row-scroll{scrollbar-width:none;padding-bottom:2px}.lion-rack-linked-rows .lion-rack-row-scroll::-webkit-scrollbar{display:none}.lion-rack-shared-scroll{overflow-x:auto;overflow-y:hidden;height:16px;margin-top:9px;scrollbar-width:thin;scrollbar-color:#6c7b9a #151c28}.lion-rack-shared-scroll-content{height:1px}.lion-rack-shared-scroll:focus-visible{outline:2px solid #83a9d8;outline-offset:2px;border-radius:4px}',
      '.lion-rack-positions{grid-template-rows:192px 192px}.lion-rack-slot[data-slot="2"],.lion-rack-slot[data-slot="3"]{height:192px}.lion-rack-slot-select{gap:3px}.lion-rack-stamp{display:block;font-size:9px;line-height:1.3;max-width:100%;color:#d0daea}.lion-rack-stamp>span{display:block;font-size:8px;color:#a6b5ca}.lion-rack-stamp time{display:block;font-variant-numeric:tabular-nums}.lion-rack-stamp+.lion-rack-stamp{margin-top:2px}',
      '#eve-tracker-panel .eve-section-row[data-section="b6"],#eve-tracker-panel .eve-section-row[data-section="b7"],#eve-tracker-panel .eve-section-row[data-section="lionking2"]{background:var(--lion-group-bg);border-left:3px solid var(--lion-group-accent);padding-left:8px;padding-right:6px}#eve-tracker-panel .eve-section-row[data-section="b6"]{border-radius:8px 8px 0 0;border-bottom-color:transparent}#eve-tracker-panel .eve-section-row[data-section="b7"]{border-radius:0 0 8px 8px}#eve-tracker-panel .eve-section-row[data-section="lionking2"]{margin-top:8px;border-radius:8px}#eve-tracker-panel .eve-section-row[data-section="unassigned"]{margin-top:8px}#eve-tracker-panel .eve-section-row[data-section="b6"] .eve-section-name,#eve-tracker-panel .eve-section-row[data-section="b7"] .eve-section-name,#eve-tracker-panel .eve-section-row[data-section="lionking2"] .eve-section-name{color:var(--lion-group-accent)}',
      '@media(max-width:700px){.lion-work-pair-cards{flex-direction:column}.lion-work-pair{flex-basis:100%}.lion-rack-linked-rows{padding:7px}.lion-rack-row{padding:10px 7px 3px}}',
      '@media(max-width:700px){#eve-lion-rack-board.has-selection #lion-rack-drawer{position:absolute;inset:0 0 0 auto;width:min(100%,340px);z-index:5;box-shadow:-15px 0 40px #0008}.lion-physical-rack{flex-basis:310px}.lion-rack-toolbar .lion-rack-legend{display:none}#lion-rack-back{max-width:110px;white-space:normal}#lion-rack-title{padding:12px}}',
      '#eve-lion-rack-board{font-size:12px;border-radius:12px}#lion-rack-title{padding:6px 10px;min-height:34px}#lion-rack-title>div:first-child{display:flex;align-items:baseline;gap:10px;min-width:0}#lion-rack-title .lion-rack-eyebrow{display:none}#lion-rack-title strong{font-size:17px;line-height:1.1;margin:0;white-space:nowrap}#lion-rack-title small{font-size:9px;line-height:1.2;margin:0;white-space:nowrap}.lion-rack-window-actions{gap:4px}.lion-rack-window-actions button{font-size:15px!important;padding:1px 7px!important}#lion-rack-back{font-size:10px!important;padding:4px 7px!important}.lion-rack-toolbar{padding:4px 10px;gap:8px;font-size:10px}.lion-rack-toolbar>button{font-size:9px!important;padding:3px 7px!important}.lion-rack-legend{gap:8px;font-size:9px}',
      '.lion-rack-work-bar{padding:4px 8px;flex-wrap:nowrap;gap:6px;flex-shrink:0;align-items:center}#lion-rack-work-controls{display:grid;grid-template-columns:minmax(390px,2fr) repeat(2,minmax(175px,1fr));gap:5px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin}.lion-work-pair{display:block;min-width:0;padding:3px;border-radius:8px;flex:none}.lion-work-pair-label{display:none}.lion-work-pair-cards{display:flex;flex-direction:row;gap:4px}.lion-work-area{min-width:0;min-height:30px;padding:3px 5px;gap:5px;border-radius:6px}.lion-work-area>div{min-width:0}.lion-work-area strong{font-size:10px;line-height:12px}.lion-work-area small{font-size:8px;line-height:10px;margin-top:1px;white-space:nowrap}.lion-work-area .lion-work-toggle{font-size:8px;gap:3px}.lion-work-area .lion-work-toggle input{width:23px;height:14px}.lion-work-area .lion-work-toggle input:before{width:10px;height:10px}.lion-work-area .lion-work-toggle input:checked:before{left:11px}.lion-rack-all-controls{flex-wrap:nowrap;gap:3px;flex-shrink:0}.lion-rack-all-controls button{font-size:9px!important;padding:4px 5px!important;white-space:nowrap}',
      '.lion-rack-body{padding:5px 7px 7px}#lion-rack-source{font-size:9px;line-height:12px}.lion-rack-linked-rows{padding:4px;margin-top:4px;border-radius:10px}.lion-rack-linked-label{font-size:9px;line-height:10px;margin:0 2px 3px}.lion-rack-linked-rows .lion-rack-row{margin:4px 0 0}.lion-rack-row{padding:4px 5px 3px;margin-top:6px;border-radius:8px}.lion-rack-row:not([open]){padding-bottom:4px}.lion-rack-row-title{padding:0;gap:6px;min-height:15px}.lion-rack-row-title strong{font-size:11px}.lion-rack-row-title small{font-size:9px}.lion-rack-row-chevron{font-size:17px;line-height:13px}.lion-rack-row[open]>.lion-rack-row-title{margin-bottom:4px}.lion-rack-row-scroll{padding-bottom:5px}.lion-rack-linked-rows .lion-rack-row-scroll{padding-bottom:1px}.lion-rack-shared-scroll{height:12px;margin-top:4px}.lion-rack-row-content{gap:8px;min-height:0}',
      '.lion-physical-rack{flex:0 0 748px;padding:5px;border-radius:8px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:18px auto;gap:4px 8px;align-content:start}.lion-physical-rack>header{grid-column:1;grid-row:1;min-height:18px;margin:0;gap:8px;justify-content:flex-start}.lion-physical-rack>header strong{font-size:11px}.lion-rack-assigned{font-size:9px;margin-left:auto}.lion-rack-work-row{grid-column:2;grid-row:1;gap:10px;margin:0}.lion-rack-work-row .lion-work-toggle{font-size:9px;gap:3px}.lion-rack-work-row .lion-work-toggle input{width:23px;height:14px}.lion-rack-work-row .lion-work-toggle input:before{width:10px;height:10px}.lion-rack-work-row .lion-work-toggle input:checked:before{left:11px}.lion-physical-rack.is-hidden-rack{flex-basis:280px}.lion-rack-positions{grid-column:1/3;grid-row:2;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:76px;gap:5px}.lion-rack-positions:before{display:none}.lion-rack-slot[data-slot="0"]{grid-column:2;grid-row:1;height:76px}.lion-rack-slot[data-slot="1"]{grid-column:3;grid-row:1;height:76px}.lion-rack-slot[data-slot="2"]{grid-column:1;grid-row:1;height:76px;align-self:stretch}.lion-rack-slot[data-slot="3"]{grid-column:4;grid-row:1;height:76px;align-self:stretch}.lion-rack-slot{padding:4px 5px;gap:3px;border-radius:6px;justify-content:flex-start}.lion-rack-slot:hover{transform:none;box-shadow:0 0 0 1px #81b7fb55}.lion-rack-slot.is-selected{outline-offset:1px}',
      '.lion-rack-slot-select{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:13px 12px auto;gap:2px 4px;align-content:start;align-items:center;text-align:left;min-height:0;flex:1}.lion-rack-slot-label{grid-column:2;grid-row:1;justify-self:end;font-size:8px;letter-spacing:.3px}.lion-rack-sn{grid-column:1;grid-row:1;justify-self:start;font-size:11px}.lion-rack-result{grid-column:1;grid-row:2;justify-self:start;justify-content:flex-start;font-size:9px;white-space:nowrap;max-width:100%;overflow:hidden}.lion-rack-time{grid-column:2;grid-row:2;justify-self:end;font-size:8px;white-space:nowrap}.lion-rack-muted{font-size:8px;margin-left:2px}.lion-rack-stamps{grid-column:1/3;grid-row:3;display:flex;align-items:center;gap:6px;width:100%;min-width:0}.lion-rack-stamp{display:inline-flex;align-items:baseline;gap:3px;min-width:0;max-width:100%;font-size:8.5px;line-height:11px;white-space:nowrap}.lion-rack-stamps.has-two .lion-rack-stamp{flex:1;overflow:hidden}.lion-rack-stamp>span{display:inline;font-size:8px;flex-shrink:0}.lion-rack-stamp time{display:inline;overflow:hidden;text-overflow:ellipsis;min-width:0}.lion-rack-stamp+.lion-rack-stamp{margin-top:0}.lion-rack-slot-links{gap:4px;margin-top:auto}#eve-lion-rack-board .lion-rack-slot-links button{font-size:9px;line-height:11px;padding:3px 4px;min-height:19px}.lion-rack-empty .lion-rack-slot-select,.lion-rack-hidden-slot .lion-rack-slot-select{display:flex;flex-direction:column;justify-content:center;gap:3px}.lion-rack-empty .lion-rack-slot-label,.lion-rack-hidden-slot .lion-rack-slot-label{align-self:flex-end}.lion-rack-plus{font-size:18px}.lion-rack-scan-hint{font-size:9px}.lion-rack-unplaced-section{padding-top:5px;margin-top:6px}.lion-rack-unplaced-section summary{font-size:10px}',
      '#eve-tracker-panel.eve-lion-compact{width:min(352px,calc(100vw - 20px));padding:8px;font-size:12px;max-height:calc(100vh - 20px)}#eve-tracker-panel.eve-lion-compact .eve-panel-title{font-size:16px;gap:5px;margin-bottom:4px}#eve-tracker-panel.eve-lion-compact .eve-title-meta{font-size:10px;margin-top:2px}#eve-tracker-panel.eve-lion-compact .eve-section-title{margin-top:7px;margin-bottom:5px;font-size:10px}#eve-tracker-panel.eve-lion-compact .eve-bulk-buttons{gap:4px;margin-bottom:6px}#eve-tracker-panel.eve-lion-compact .eve-bulk-buttons button{padding:5px 3px;font-size:10px}#eve-tracker-panel.eve-lion-compact .lion-rack-quick-open{padding:8px 10px;margin:5px 0 7px;border-radius:8px}#eve-tracker-panel.eve-lion-compact .lion-rack-quick-open>span{font-size:14px}#eve-tracker-panel.eve-lion-compact .lion-rack-quick-open>small{font-size:10px;margin-top:2px}#eve-tracker-panel.eve-lion-compact .eve-section-card{padding:0 6px}#eve-tracker-panel.eve-lion-compact .eve-section-head,#eve-tracker-panel.eve-lion-compact .eve-section-row{grid-template-columns:minmax(0,1fr) 38px 38px}#eve-tracker-panel.eve-lion-compact .eve-section-head{font-size:9px;padding:6px 0 4px}#eve-tracker-panel.eve-lion-compact .eve-section-row{padding-top:5px;padding-bottom:5px}#eve-tracker-panel.eve-lion-compact .eve-section-label{display:flex;flex-direction:column;align-items:flex-start;gap:3px;overflow:visible}#eve-tracker-panel.eve-lion-compact .eve-section-name{font-size:12px}#eve-tracker-panel.eve-lion-compact .eve-section-stats{gap:3px;flex-wrap:wrap}#eve-tracker-panel.eve-lion-compact .eve-stat{min-width:0;height:15px;line-height:15px;padding:0 4px;font-size:9px;gap:2px}#eve-tracker-panel.eve-lion-compact .eve-refresh-card{padding:6px 7px;margin-top:7px}#eve-tracker-panel.eve-lion-compact .eve-refresh-label{font-size:11px}#eve-tracker-panel.eve-lion-compact .eve-credit{font-size:9px;padding-top:5px}#eve-tracker-panel.eve-lion-compact:not(.eve-developer-enabled) #eve-page-navigation{display:none}',
      '@media(max-width:1050px){.lion-rack-all-controls{display:grid;grid-template-columns:repeat(2,auto);gap:2px}.lion-rack-all-controls button{font-size:8px!important;padding:2px 4px!important}}@media(max-width:700px){#lion-rack-title small{display:none}.lion-rack-legend{display:none}.lion-rack-work-bar{padding:3px 5px}.lion-rack-workspace{min-width:0}#lion-rack-drawer{width:300px;flex-basis:300px}.lion-rack-toolbar{gap:5px}.lion-rack-row-title{gap:4px}}',
      '.lion-rack-area[data-area="b6"],.lion-rack-row[data-area="b6"],.lion-work-area[data-area="b6"],#eve-tracker-panel .eve-section-row[data-section="b6"]{--lion-group-bg:#192638;--lion-group-border:#37506b;--lion-group-accent:#83a9d8}.lion-rack-area[data-area="b7"],.lion-rack-row[data-area="b7"],.lion-work-area[data-area="b7"],#eve-tracker-panel .eve-section-row[data-section="b7"]{--lion-group-bg:#1b2b2d;--lion-group-border:#3b575b;--lion-group-accent:#93bec3}.lion-rack-area[data-area="lionking2"],.lion-rack-row[data-area="lionking2"],.lion-work-area[data-area="lionking2"],#eve-tracker-panel .eve-section-row[data-section="lionking2"]{--lion-group-bg:#242236;--lion-group-border:#514762;--lion-group-accent:#b29dd8}.lion-rack-area[data-area="unassigned"]{--lion-group-bg:#1b222d;--lion-group-border:#334155;--lion-group-accent:#b5c8e4}',
      '#lion-rack-title{padding:5px 9px;min-height:34px}.lion-rack-board-options{position:relative;cursor:default}.lion-rack-board-options>summary{cursor:pointer;list-style:none;font-size:17px;line-height:24px;width:28px;text-align:center;border:1px solid #354155;border-radius:6px}.lion-rack-board-options>summary::-webkit-details-marker{display:none}.lion-rack-board-options>summary:focus-visible{outline:2px solid #6caeff;outline-offset:2px}.lion-rack-board-options .lion-rack-all-controls{position:absolute;right:0;top:30px;z-index:10;display:grid;grid-template-columns:repeat(2,auto);padding:7px;background:#1b232f;border:1px solid #40506a;border-radius:8px;box-shadow:0 8px 24px #0007;gap:5px}.lion-rack-board-options #lion-rack-edit-layout{grid-column:1/3}.lion-rack-body{padding:4px 6px 6px}.lion-rack-linked-rows{margin:0;padding:0;border:0;border-radius:0;background:transparent}.lion-rack-area{background:var(--lion-group-bg);border:0;border-left:3px solid var(--lion-group-accent);border-radius:6px;margin:0 0 5px;padding:0 5px}.lion-rack-area-head{display:flex;align-items:center;gap:10px;min-height:27px;padding:2px 1px}.lion-rack-area-controls{display:flex;align-items:center;gap:10px;flex:1;min-width:0}.lion-work-counts{display:flex;gap:5px;flex-wrap:wrap;flex:1;min-width:0}.lion-work-count{font-size:9px;line-height:14px;color:#acbfd7;white-space:nowrap}.lion-work-count-testing{color:#b6dcc5}.lion-work-count-pretest{color:#9bd2f3}.lion-work-count-failed{color:#ed91a6}.lion-work-count-pretestFailed{color:#cc6b83}.lion-work-count-passed{color:#75c7a1}.lion-rack-area-controls .lion-work-toggle{font-size:9px;gap:4px}#eve-lion-rack-board .lion-rack-row-toggle{display:flex;align-items:center;gap:6px;padding:1px 0;border:0;background:transparent;color:var(--lion-group-accent);font-size:12px;border-radius:3px;white-space:nowrap}.lion-rack-row-toggle strong{font-size:12px}.lion-rack-row-toggle small{font-size:9px;font-weight:400;color:#9bacc3}.lion-rack-row-toggle:disabled{opacity:.55;cursor:default}.lion-rack-row-toggle[aria-expanded="true"] .lion-rack-row-chevron{transform:rotate(90deg)}.lion-rack-area .lion-rack-row,.lion-rack-linked-rows .lion-rack-row{padding:0 0 2px;margin:0;border:0;border-radius:0;background:transparent}.lion-rack-row:not([open]){padding:0}.lion-rack-shared-scroll{height:11px;margin:0 2px 5px}.lion-rack-row-content{gap:0}.lion-rack-row-scroll{padding-bottom:5px}.lion-rack-linked-rows .lion-rack-row-scroll{padding-bottom:0}',
      '.lion-rack-row .lion-physical-rack{flex:0 0 554px;padding:3px 8px 5px;border:0;border-right:1px solid var(--lion-group-border);border-radius:0;background:transparent;grid-template-rows:17px auto;gap:3px 8px}.lion-rack-row .lion-physical-rack:last-child{border-right:0}.lion-rack-row .lion-physical-rack.is-hidden-rack{flex-basis:240px}.lion-physical-rack>header{min-height:17px}.lion-physical-rack>header strong{font-size:11px}.lion-rack-work-row{gap:8px}.lion-rack-positions{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:64px 64px;gap:4px}.lion-rack-positions:before{display:none}.lion-rack-slot[data-slot="0"]{grid-column:2;grid-row:1;height:64px}.lion-rack-slot[data-slot="1"]{grid-column:2;grid-row:2;height:64px}.lion-rack-slot[data-slot="2"]{grid-column:1;grid-row:1/3;height:64px;align-self:center}.lion-rack-slot[data-slot="3"]{grid-column:3;grid-row:1/3;height:64px;align-self:center}.lion-rack-slot{padding:3px 5px;gap:2px;align-items:stretch;border-radius:5px}.lion-rack-slot-select{grid-template-rows:12px 11px 10px;gap:1px 4px;flex:1;align-content:start}.lion-rack-sn{font-size:11px;line-height:12px}.lion-rack-slot-label{font-size:7px;letter-spacing:.25px}.lion-rack-result{font-size:9px;line-height:11px}.lion-rack-time{font-size:8px;line-height:11px}.lion-rack-stamps{gap:5px}.lion-rack-stamp,.lion-rack-stamp>span{font-size:8px;line-height:10px}.lion-rack-slot-links{margin-top:auto;gap:4px}#eve-lion-rack-board .lion-rack-slot-links button{padding:1px 4px;min-height:16px;line-height:12px;font-size:9px}.lion-rack-empty .lion-rack-slot-select{display:grid;grid-template-columns:1fr auto;grid-template-rows:12px 1fr;gap:2px;align-items:center}.lion-rack-empty .lion-rack-slot-label{grid-column:2;grid-row:1;align-self:auto}.lion-rack-empty .lion-rack-plus{grid-column:1;grid-row:1/3;justify-self:center;font-size:22px}.lion-rack-empty .lion-rack-scan-hint{grid-column:2;grid-row:2;justify-self:end;font-size:9px}.lion-rack-unplaced-section{padding-top:0;margin-top:0}.lion-rack-unplaced-section p{margin:5px 0}.lion-rack-unplaced-section #lion-rack-find{margin-top:3px;font-size:11px;padding:4px 7px}.lion-rack-unplaced-section #lion-rack-unplaced{padding:5px 0}',
      '.lion-rack-running{background:#4a7858!important;border-color:#7dab89!important;color:#f0fff4}.lion-rack-running .lion-rack-slot-label,.lion-rack-running .lion-rack-time,.lion-rack-running .lion-rack-stamp,.lion-rack-running .lion-rack-stamp>span{color:#e5f3e8}#eve-lion-rack-board .lion-rack-running .lion-rack-slot-links button{background:#35583f;border-color:#7dab89;color:#f0fff4}.lion-rack-pass{background:#12392d!important;border-color:#32c28a!important;color:#bbefda}.lion-rack-fail{background:#3d1f2c!important;border-color:#e65c7d!important;color:#ffd0dc}.lion-rack-pretest_fail{background:#290d17!important;border-color:#8f2541!important;color:#f1b0c0}#eve-tracker-panel.eve-lion-compact .eve-stat-pretest-failed{background:#290d17;color:#f1b0c0}.lion-rack-pretest_fail .lion-rack-slot-label,.lion-rack-pretest_fail .lion-rack-stamp,.lion-rack-pretest_fail .lion-rack-stamp>span{color:#c994a3}',
      '.lion-rack-pretest{background:#4a7858!important;border-color:#7dab89!important;color:#f0fff4}.lion-rack-pretest .lion-rack-slot-label,.lion-rack-pretest .lion-rack-time,.lion-rack-pretest .lion-rack-stamp,.lion-rack-pretest .lion-rack-stamp>span{color:#e5f3e8}#eve-lion-rack-board .lion-rack-pretest .lion-rack-slot-links button{background:#35583f;border-color:#7dab89;color:#f0fff4}',
      '@media(max-width:700px){.lion-rack-area-head{flex-wrap:wrap;gap:1px 8px}.lion-rack-area-controls{min-width:240px;gap:6px}.lion-work-counts{gap:4px}.lion-rack-row .lion-physical-rack{flex-basis:518px}.lion-rack-area{padding:0 3px}#lion-rack-title{padding:5px 7px}#lion-rack-back{max-width:120px}}',
      '#eve-lion-rack-board .lion-rack-pool-item:is(.lion-rack-running,.lion-rack-pretest){color:#f0fff4}#eve-lion-rack-board .lion-rack-pool-item:is(.lion-rack-running,.lion-rack-pretest) small{color:#e5f3e8}.lion-rack-area-head{justify-content:flex-start;gap:7px}.lion-rack-area-controls{flex:0 1 auto;gap:10px;min-width:0}.lion-work-counts{flex:0 1 auto}.lion-rack-row .lion-physical-rack{grid-template-columns:max-content minmax(0,1fr);column-gap:8px}.lion-rack-work-row{justify-content:flex-start}.lion-rack-assigned{margin-left:0}#eve-tracker-panel.eve-lion-compact .eve-section-head,#eve-tracker-panel.eve-lion-compact .eve-section-row{grid-template-columns:minmax(0,1fr)}#eve-tracker-panel.eve-lion-compact .lion-section-heading{display:flex;align-items:center;gap:9px}#eve-tracker-panel.eve-lion-compact .eve-bulk-buttons{grid-template-columns:repeat(2,minmax(0,1fr))}#eve-tracker-panel.eve-lion-compact .eve-section-label{width:100%}',
      '#eve-lion-rack-board .lion-physical-rack>header{grid-column:1/3}',
      '#eve-lion-rack-board .lion-rack-slot-remove{position:absolute;top:2px;right:3px;z-index:3;width:16px;height:16px;min-width:16px;padding:0!important;border:0!important;border-radius:3px;background:transparent!important;color:inherit!important;font-size:15px;line-height:16px;cursor:pointer}#eve-lion-rack-board .lion-rack-slot-remove:hover{background:#0004!important}.lion-rack-slot.has-remove .lion-rack-slot-label{margin-right:16px}'
    ].join('');
    document.head.appendChild(style); document.body.appendChild(board);
    lionRackUI = readJSON(localStorage, LION_RACK_WINDOW_KEY, null, 'Rack board window');
    fitLionRackWindow(board); board.hidden = lionRackUI?.open === false;
    document.documentElement.classList.toggle('lion-rack-map-active', !board.hidden);
    board.querySelector('#lion-rack-close').addEventListener('click', () => setLionRackView(false));
    board.querySelector('#lion-rack-back').addEventListener('click', () => setLionRackView(false));
    board.querySelector('#lion-rack-expand').addEventListener('click', () => {
      fitLionRackWindow(board); saveLionRackWindow(board);
    });
    board.querySelector('#lion-rack-drawer-close').addEventListener('click', closeLionRackSelection);
    board.querySelector('#lion-rack-edit-layout').addEventListener('click', event => {
      const editing = board.classList.toggle('lion-layout-editing');
      event.currentTarget.setAttribute('aria-pressed', String(editing));
      event.currentTarget.textContent = editing ? 'Done editing' : 'Edit layout';
      board.querySelector('#lion-rack-layout-tools').hidden = !editing;
    });
    board.querySelector('#lion-rack-find').addEventListener('input', () => refreshLionRackBoard(lionRackSnapshot));
    board.addEventListener('change', event => {
      const input = event.target, property = input.dataset.workProperty;
      if (input.dataset.workArea && property === 'enabled') {
        updateLionAreaEnabled(input.dataset.workArea, input.checked);
      }
    });
    board.querySelector('#lion-rack-scan').addEventListener('submit', event => { event.preventDefault(); submitLionRackScan(); });
    let scanTimer = null, scanStart = 0, lastInput = 0, scanCharacters = 0;
    const scanInput = board.querySelector('#lion-rack-serial');
    scanInput.addEventListener('input', event => {
      clearTimeout(scanTimer);
      const now = Date.now();
      if (!lastInput || now - lastInput > 65) { scanStart = now; scanCharacters = 0; }
      scanCharacters += String(event.data || '').length; lastInput = now;
      if (scanCharacters >= 6 && now - scanStart < 450 && /^\d{4}YW[A-Z0-9]{4}$/i.test(scanInput.value.trim())) {
        const selected = JSON.stringify(lionRackSelected);
        scanTimer = setTimeout(() => {
          if (JSON.stringify(lionRackSelected) === selected && scanInput.value.trim()) submitLionRackScan();
        }, 200);
      }
    });
    scanInput.addEventListener('keydown', event => { if (event.key === 'Enter') clearTimeout(scanTimer); });
    scanInput.addEventListener('paste', () => {
      clearTimeout(scanTimer);
      const selected = JSON.stringify(lionRackSelected);
      scanTimer = setTimeout(() => {
        if (JSON.stringify(lionRackSelected) === selected && scanInput.value.trim()) submitLionRackScan();
      }, 200);
    });
    board.addEventListener('toggle', event => {
      const row = event.target;
      if (!(row instanceof Element) || !board.contains(row)) return;
      const area = row.id === 'lion-rack-row-unassigned' ? 'unassigned' : row.dataset.area;
      if (!area || !row.matches('details')) return;
      // Native toggle events also fire after programmatic opens and renders.
      // The saved Enabled preference is authoritative, so those events never
      // create an independent expansion state or replay notification changes.
      const enabled = lionAreaSettings(area).show;
      if (row.open !== enabled) row.open = enabled;
      board.querySelector('[data-lion-row-toggle="' + area + '"]')?.setAttribute('aria-expanded', String(enabled));
      queueLionRackPairedScroll();
    }, true);
    board.addEventListener('scroll', event => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.lion-rack-linked-rows') ||
          !target.matches('.lion-rack-shared-scroll,.lion-rack-row-scroll') ||
          lionRackExpectedScroll.get(target) === target.scrollLeft) return;
      if (target.closest('details.lion-rack-row')?.open === false || target.hidden) return;
      lionRackPairedScrollLeft = target.scrollLeft;
      updateLionRackPairedScroll();
    }, true);
    if (typeof ResizeObserver === 'function') {
      const pairedScrollResize = new ResizeObserver(queueLionRackPairedScroll);
      pairedScrollResize.observe(board.querySelector('.lion-rack-body'));
    }
    board.addEventListener('click', event => {
      const button = event.target.closest('button'), slot = event.target.closest('[data-slot]'), rackElement = event.target.closest('[data-rack]');
      if (button?.dataset.lionRowToggle) {
        const area = button.dataset.lionRowToggle;
        updateLionAreaEnabled(area, !lionAreaSettings(area).show);
        return;
      }
      if (button?.dataset.allWork) {
        const [property, enabled] = button.dataset.allWork.split(':');
        setLionKingAreas(property, enabled === 'true'); return;
      }
      if (button?.dataset.unplaced) {
        if (!lionRackSelected) { board.querySelector('#lion-rack-unplaced').previousElementSibling.textContent = 'Click a rack slot first, then choose this serial.'; return; }
        scanInput.value = button.dataset.unplaced; submitLionRackScan(); return;
      }
      if (slot && rackElement && button?.dataset.slotAction === 'remove') {
        event.preventDefault(); event.stopPropagation();
        const rack = rackElement.dataset.rack, position = Number(slot.dataset.slot);
        if (lionRackSelected?.rack === rack && lionRackSelected.position === position) clearTimeout(scanTimer);
        clearLionRackSlot(rack, position, button.dataset.slotSerial);
        return;
      }
      if (slot && rackElement && ['jira', 'testview'].includes(button?.dataset.slotAction)) {
        event.preventDefault(); event.stopPropagation();
        openLionRackSlotLink(rackElement.dataset.rack, Number(slot.dataset.slot), button.dataset.slotAction); return;
      }
      if (slot && rackElement) { clearTimeout(scanTimer); selectLionRackSlot(rackElement.dataset.rack, Number(slot.dataset.slot)); return; }
      if (!rackElement || !button?.dataset.rackAction) return;
      const rack = rackElement.dataset.rack, next = readLionRackBoard(), row = next.rows.find(item => item.racks.includes(rack));
      if (!row) return;
      const index = row.racks.indexOf(rack), action = button.dataset.rackAction;
      if (action === 'remove') {
        if (next.slots[rack].some(entry => entry.serial)) { button.title = 'Remove its JBOGs before removing this rack.'; return; }
        row.racks.splice(index, 1); delete next.slots[rack];
      } else {
        const destination = index + (action === 'left' ? -1 : 1);
        if (destination < 0 || destination >= row.racks.length) return;
        [row.racks[index], row.racks[destination]] = [row.racks[destination], row.racks[index]];
      }
      saveLionRackBoard(next);
    });
    board.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key) || event.target.closest('button,input,select,textarea,a')) return;
      const slot = event.target.closest('[data-slot]');
      if (!slot) return;
      event.preventDefault(); selectLionRackSlot(slot.closest('[data-rack]').dataset.rack, Number(slot.dataset.slot));
    });
    const selectedInfo = () => {
      const entry = lionRackSelected && lionRackBoard.slots[lionRackSelected.rack]?.[lionRackSelected.position];
      return { entry, row: entry?.serial ? lionRackInfoForSerial(entry.serial) : null };
    };
    board.querySelector('#lion-rack-open-test').addEventListener('click', () => {
      if (lionRackSelected) openLionRackSlotLink(lionRackSelected.rack, lionRackSelected.position, 'testview');
    });
    board.querySelector('#lion-rack-open-jira').addEventListener('click', () => {
      if (lionRackSelected) openLionRackSlotLink(lionRackSelected.rack, lionRackSelected.position, 'jira');
    });
    board.querySelector('#lion-rack-copy-selected').addEventListener('click', event => {
      const { entry } = selectedInfo(); if (entry?.serial) copyToClipboard(entry.serial, event.currentTarget);
    });
    board.querySelector('#lion-rack-clear-selected').addEventListener('click', () => {
      if (!lionRackSelected) return;
      clearTimeout(scanTimer);
      const { rack, position } = lionRackSelected;
      if (clearLionRackSlot(rack, position, lionRackBoard.slots[rack]?.[position]?.serial)) scanInput.focus();
    });
    board.querySelector('#lion-rack-add').addEventListener('click', () => {
      const input = board.querySelector('#lion-rack-barcode'), rack = lionRackBarcode(input.value), next = readLionRackBoard();
      const row = Number(board.querySelector('#lion-rack-new-row').value);
      if (!rack || next.slots[rack] || Object.keys(next.slots).length >= 96) {
        input.setCustomValidity(!rack ? 'Scan a complete barcode, such as TA.E2-EVE04.' : next.slots[rack] ? 'This rack is already on the board.' : 'Remove an unused rack first.');
        input.reportValidity(); return;
      }
      input.setCustomValidity('');
      next.rows[row].racks.push(rack); next.slots[rack] = Array.from({ length: 4 }, () => ({ serial: '', partner: '' }));
      if (saveLionRackBoard(next)) { input.value = ''; selectLionRackSlot(rack, 0); }
    });
    board.querySelector('#lion-rack-barcode').addEventListener('input', event => event.target.setCustomValidity(''));
    board.addEventListener('dragstart', event => {
      if (['jira', 'testview', 'remove'].includes(event.target.closest('button')?.dataset.slotAction)) { event.preventDefault(); return; }
      const rackHeader = event.target.closest('[data-rack-drag]'), slot = event.target.closest('[data-slot]'), unplaced = event.target.closest('[data-unplaced]');
      if (rackHeader) {
        if (!board.classList.contains('lion-layout-editing')) { event.preventDefault(); return; }
        event.dataTransfer.setData('application/x-lion-rack', rackHeader.dataset.rackDrag);
      } else if (slot) {
        const entry = lionRackBoard.slots[slot.closest('[data-rack]').dataset.rack][Number(slot.dataset.slot)];
        if (!entry.serial) { event.preventDefault(); return; }
        event.dataTransfer.setData('application/x-lion-jbog', JSON.stringify(entry));
      } else if (unplaced) event.dataTransfer.setData('application/x-lion-jbog', JSON.stringify({ serial: unplaced.dataset.unplaced, partner: '' }));
      else return;
      lionRackDragging = true; event.dataTransfer.effectAllowed = 'move';
    });
    board.addEventListener('dragover', event => {
      const types = [...event.dataTransfer.types];
      if ((types.includes('application/x-lion-jbog') && event.target.closest('[data-slot]')) ||
          (types.includes('application/x-lion-rack') && event.target.closest('.lion-rack-row'))) event.preventDefault();
    });
    board.addEventListener('drop', event => {
      lionRackDragging = false;
      const rack = event.dataTransfer.getData('application/x-lion-rack'), jbog = event.dataTransfer.getData('application/x-lion-jbog');
      if (rack) {
        const destination = event.target.closest('.lion-rack-row');
        if (!destination) return;
        event.preventDefault();
        const next = readLionRackBoard(), from = next.rows.find(row => row.racks.includes(rack));
        if (!from) return;
        const before = event.target.closest('[data-rack]')?.dataset.rack;
        if (before === rack) return;
        from.racks.splice(from.racks.indexOf(rack), 1);
        const row = next.rows[Number(destination.dataset.row)], index = before ? row.racks.indexOf(before) : -1;
        row.racks.splice(index < 0 ? row.racks.length : index, 0, rack); saveLionRackBoard(next);
      } else if (jbog) {
        const slot = event.target.closest('[data-slot]');
        if (!slot) return;
        event.preventDefault();
        try {
          const entry = JSON.parse(jbog), target = slot.closest('[data-rack]').dataset.rack, position = Number(slot.dataset.slot);
          if (assignLionRackSlot(target, position, entry.serial, entry.partner)) selectLionRackSlot(target, position);
        } catch (error) {}
      }
    });
    board.addEventListener('dragend', () => { lionRackDragging = false; refreshLionRackBoard(lionRackSnapshot); });
    const title = board.querySelector('#lion-rack-title');
    title.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button,summary,input,select,a,label')) return;
      event.preventDefault(); title.setPointerCapture(event.pointerId);
      const rect = board.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
      const move = current => {
        board.style.left = Math.max(10, Math.min(window.innerWidth - rect.width - 10, rect.left + current.clientX - startX)) + 'px';
        board.style.top = Math.max(10, Math.min(window.innerHeight - rect.height - 10, rect.top + current.clientY - startY)) + 'px';
      };
      const finish = () => {
        title.removeEventListener('pointermove', move); title.removeEventListener('pointerup', finish); title.removeEventListener('pointercancel', finish);
        saveLionRackWindow(board);
      };
      title.addEventListener('pointermove', move); title.addEventListener('pointerup', finish); title.addEventListener('pointercancel', finish);
    });
    window.addEventListener('resize', () => fitLionRackWindow(board));
    board.addEventListener('pointerup', () => { if (!board.hidden) saveLionRackWindow(board); });
    board.querySelector('#lion-rack-backup').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(lionRackBoard, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'lion-king-rack-assignments.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    board.querySelector('#lion-rack-restore').addEventListener('click', () => board.querySelector('#lion-rack-file').click());
    board.querySelector('#lion-rack-file').addEventListener('change', async event => {
      const file = event.target.files[0]; event.target.value = '';
      if (!file || file.size > 200000) return;
      try {
        const imported = JSON.parse(await file.text());
        if (imported.kind !== 'eve-lion-rack-board' || imported.version !== 1 || !Array.isArray(imported.rows) ||
            imported.rows.length !== 3 || !isRecordObject(imported.slots)) throw new Error('Invalid backup.');
        const normalized = normalizeLionRackBoard(imported);
        if (normalized.rows.some((row, index) =>
              !isRecordObject(imported.rows[index]) ||
              ![LION_RACK_ROWS[index].area, index < 2 ? 'lionking1' : 'lionking2'].includes(imported.rows[index].area) ||
              JSON.stringify(row.racks) !== JSON.stringify(imported.rows[index].racks)) ||
            Object.keys(normalized.slots).length !== Object.keys(imported.slots).length ||
            Object.keys(normalized.slots).some(rack => JSON.stringify(normalized.slots[rack]) !== JSON.stringify(imported.slots[rack]))) throw new Error('Invalid assignments.');
        if (saveLionRackBoard(imported)) board.querySelector('#lion-rack-restore').textContent = 'Restored';
      } catch (error) { board.querySelector('#lion-rack-restore').textContent = 'Invalid backup'; }
    });
    const adopt = () => {
      const next = readLionRackBoard();
      if (JSON.stringify(next) === JSON.stringify(lionRackBoard)) return;
      lionRackBoard = next; indexLionRacks(); refreshLionRackAlertLocations(); refreshLionRackBoard(lionRackSnapshot); scanLionKing();
    };
    if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener(LION_RACK_BOARD_KEY, (name, oldValue, newValue, remote) => { if (remote) adopt(); });
    window.addEventListener('storage', event => { if (event.key === LION_RACK_BOARD_KEY) adopt(); });
    window.addEventListener('focus', adopt);
    refreshLionRackBoard(null);
  }

  function lionAreaForRow(row) {
    const physical = lionRackPlacement(row);
    if (physical) return physical.conflict ? 'unassigned' : physical.area;
    const areas = settings.lionAreas || {};
    const tail = areas[String(row.tailSerial || row.serial || '').toUpperCase()];
    const head = areas[String(row.headSerial || '').toUpperCase()];
    const known = value => value !== 'unassigned' && Object.prototype.hasOwnProperty.call(LION_AREAS, value);
    if (known(tail) && known(head) && tail !== head) return 'unassigned';
    return known(tail) ? tail : known(head) ? head : 'unassigned';
  }

  function lionAreaSettings(area) {
    const saved = settings.sections[area];
    if (!isRecordObject(saved)) {
      settings.sections[area] = { show: false, watch: false };
    } else {
      // Preserve existing mutes when upgrading to a single enabled switch.
      const enabled = saved.show !== false && saved.watch !== false;
      saved.show = enabled;
      saved.watch = enabled;
    }
    return settings.sections[area];
  }

  function setLionAreaEnabled(area, enabled) {
    const prefs = lionAreaSettings(area);
    prefs.show = enabled; prefs.watch = enabled;
  }

  function updateLionAreaEnabled(area, enabled) {
    setLionAreaEnabled(area, enabled);
    syncLionKingControls(); saveSettings(); refreshLionRackBoard(lionRackSnapshot);
    scanLionKing(); applyAlertFilter();
  }

  function syncLionKingControls() {
    document.querySelectorAll('#eve-section-list .eve-section-row').forEach(row => {
      const prefs = lionAreaSettings(row.dataset.section);
      row.querySelectorAll('.eve-show-checkbox,.eve-watch-checkbox').forEach(input => { input.checked = prefs.show; });
      syncSectionRowShown(row, prefs.show);
    });
    settings.lionNotifications = Object.keys(LION_AREAS).some(area => lionAreaSettings(area).watch);
  }

  function setLionKingAreas(property, value) {
    Object.keys(LION_AREAS).forEach(area => setLionAreaEnabled(area, value));
    syncLionKingControls();
    saveSettings();
    refreshLionRackBoard(lionRackSnapshot);
    applyAlertFilter();
    scanLionKing();
  }

  let lionRefreshError = '';
  let lionHasCompletedSnapshot = false;
  let lionCachedSnapshot = null;
  let lionCacheSignature = '';
  let lionCacheWriteFailed = false;
  const LION_SNAPSHOT_KEY = 'lionKingTrackerSnapshot';
  const LION_CACHE_MAX_ROWS = 2500;
  const lionPendingEvents = new Set();

  function lionSnapshotRowData(row) {
    if (!isRecordObject(row) || !['RUNNING', 'PASS', 'FAIL', 'UNKNOWN'].includes(row.status)) return null;
    const strings = ['jbog', 'tailSerial', 'headSerial', 'started', 'statusText'];
    if (strings.some(field => typeof row[field] !== 'string' || row[field].length > (field === 'statusText' ? 1000 : 120)) ||
        !row.jbog || !row.tailSerial || (!row.headSerial && !IS_LION_RAMSES_PAGE) ||
        (IS_LION_RAMSES_PAGE && row.source !== 'ramses')) return null;
    const startedAt = lionStartedAt(row.started);
    if (!Number.isFinite(startedAt) || startedAt > Date.now() + 10 * 60000) return null;
    const ramsesDuration = Number.isFinite(row.finishedAt) && row.finishedAt > startedAt &&
      row.finishedAt <= Date.now() + 10 * 60000 ? row.finishedAt - startedAt : null;
    return { source: IS_LION_RAMSES_PAGE ? 'ramses' : 'collector',
      jbog: row.jbog, tailSerial: row.tailSerial, headSerial: row.headSerial,
      started: row.started, startedAt, status: row.status, statusText: row.statusText,
      finishedAt: IS_LION_RAMSES_PAGE ? row.finishedAt : undefined,
      durationMs: row.status === 'PASS' ? IS_LION_RAMSES_PAGE ? ramsesDuration : parseLionKingDuration(row.statusText) : null,
      key: IS_LION_RAMSES_PAGE ? ramsesRunKey(row.tailSerial, startedAt) :
        JSON.stringify([row.tailSerial.toUpperCase(), row.headSerial.toUpperCase(), startedAt]) };
  }

  function loadLionKingSnapshotCache() {
    const saved = readJSON(localStorage, LION_SNAPSHOT_KEY, null, 'Lion snapshot');
    if (!isRecordObject(saved) || saved.version !== 1 || saved.origin !== window.location.origin ||
        saved.path !== window.location.pathname || !Number.isFinite(saved.savedAt) || saved.savedAt <= 0 ||
        saved.savedAt > Date.now() + 10 * 60000 || !Array.isArray(saved.rows) ||
        saved.rows.length > LION_CACHE_MAX_ROWS) return null;
    const rows = saved.rows.map(lionSnapshotRowData).filter(Boolean);
    return rows.length ? { ...saved, rows } : null;
  }

  function saveLionKingSnapshotCache(snapshot) {
    const rows = new Map();
    // A malformed or missing row cannot erase an earlier active observation.
    // Retained cached rows are display-only until the live source validates them.
    if (lionCachedSnapshot) lionCachedSnapshot.rows.forEach(row => {
      if (row.status === 'RUNNING' || row.status === 'UNKNOWN' || snapshot.quarantinedKeys?.includes(row.key)) {
        rows.set(row.key, row);
      }
    });
    snapshot.rows.forEach(row => {
      const plain = lionSnapshotRowData(row);
      if (plain) rows.set(plain.key, plain);
    });
    const sorted = [...rows.values()].sort((a, b) => {
      const active = row => row.status === 'RUNNING' || row.status === 'UNKNOWN';
      return Number(active(b)) - Number(active(a)) || b.startedAt - a.startedAt;
    });
    const saved = { version: 1, origin: window.location.origin, path: window.location.pathname,
      savedAt: rackDataAt, rows: sorted.filter(row => row.status === 'RUNNING' || row.status === 'UNKNOWN' ||
        (IS_LION_RAMSES_PAGE && row.finishedAt ? row.finishedAt : row.startedAt) >= Date.now() - 2 * LION_DAY_MS).slice(0, LION_CACHE_MAX_ROWS) };
    const signature = JSON.stringify(saved);
    lionCachedSnapshot = saved;
    if (signature === lionCacheSignature && !lionCacheWriteFailed) return;
    lionCacheWriteFailed = !writeJSON(localStorage, LION_SNAPSHOT_KEY, saved, 'Lion snapshot');
    if (!lionCacheWriteFailed) lionCacheSignature = signature;
  }

  function showLionKingSnapshotCache() {
    if (!lionCachedSnapshot || lionHasCompletedSnapshot) return;
    let holder = document.getElementById('lion-cached-view');
    if (!holder) {
      holder = document.createElement('section');
      holder.id = 'lion-cached-view';
      holder.setAttribute('data-lion-tracker-ui', 'cached-snapshot');
      const title = document.createElement('h3');
      title.textContent = 'Saved Lion King data - waiting for the live source';
      holder.appendChild(title);
      const age = document.createElement('p');
      age.id = 'lion-cache-age';
      holder.appendChild(age);
      const table = document.createElement('table');
      table.id = 'lion-cached-source';
      const header = table.createTHead().insertRow();
      (IS_LION_RAMSES_PAGE ? ['JBOG SN', 'Started', 'Status'] :
        ['JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status']).forEach(label => {
        const cell = document.createElement('th'); cell.textContent = label; header.appendChild(cell);
      });
      table.createTBody();
      holder.appendChild(table);
      document.body.insertBefore(holder, document.body.firstChild);
    }
    setTextIfChanged(document.getElementById('lion-cache-age'),
      `Saved ${siteDateTime(new Date(lionCachedSnapshot.savedAt))}; ${lionHoursMinutes(Date.now() - lionCachedSnapshot.savedAt)} old. ` +
      'These saved rows do not establish new results or source freshness.');
    const body = holder.querySelector('tbody');
    body.replaceChildren();
    const rows = lionCachedSnapshot.rows.map(row => {
      const element = body.insertRow();
      const cells = (IS_LION_RAMSES_PAGE ? [row.tailSerial, row.started, row.statusText] :
        [row.jbog, row.tailSerial, row.headSerial, row.started, row.statusText]).map(text => {
        const cell = element.insertCell(); cell.textContent = text; return cell;
      });
      const statusCell = cells[IS_LION_RAMSES_PAGE ? 2 : 4];
      const nodeCells = IS_LION_RAMSES_PAGE ? [cells[0]] : cells.slice(0, 3);
      statusCell.style.backgroundColor = { RUNNING: 'lightgreen', PASS: 'green', FAIL: 'red', UNKNOWN: '#666' }[row.status];
      statusCell.style.color = row.status === 'RUNNING' ? '#111' : '#fff';
      nodeCells.forEach((cell, index) => {
        const open = event => {
          if (event.type === 'keydown' && event.key !== 'Enter') return;
          if (event.type === 'click' && event.button !== 0) return;
          if (event.type === 'auxclick' && event.button !== 1) return;
          event.preventDefault();
          openLionKingTestView(index === 2 ? row.headSerial : row.tailSerial, row.started,
            (event.button === 1 || event.ctrlKey || event.metaKey) && typeof GM_openInTab === 'function'
              ? url => GM_openInTab(url, { active: false, insert: true }) : openExternal);
        };
        cell.addEventListener('click', open);
        cell.addEventListener('auxclick', open);
        cell.addEventListener('keydown', open);
      });
      return { ...row, element, statusCell, nodeCells };
    });
    updateLionKingRows({ rows });
  }

  function lionInvalidRowSummary(snapshot) {
    return Object.entries(snapshot.invalidReasons || {}).filter(([, count]) => count)
      .map(([reason, count]) => `${reason}: ${count}`).join(', ');
  }

  function lionCellText(cell) {
    if (!cell) return '';
    let source = cell;
    if (cell.querySelector('[data-lion-tracker-ui]')) {
      source = cell.cloneNode(true);
      source.querySelectorAll('[data-lion-tracker-ui]').forEach(node => node.remove());
    }
    return String(source.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeLionKingStatus(cell) {
    const text = lionCellText(cell).toUpperCase();
    const words = { PASS: 'PASS', PASSED: 'PASS', FAIL: 'FAIL', FAILED: 'FAIL',
      RUNNING: 'RUNNING', TESTING: 'RUNNING' };
    const color = normalizeColor(cell);
    const coloredStatus = { lightgreen: 'RUNNING', darkgreen: 'PASS', red: 'FAIL' }[color];
    if (words[text]) return coloredStatus && coloredStatus !== words[text] ? 'UNKNOWN' : words[text];
    return coloredStatus || 'UNKNOWN';
  }

  function parseLionKingDuration(text) {
    const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(text || '').trim());
    if (!match) return null;
    const duration = (Number(match[1]) * 60 + Number(match[2])) * 60000;
    return duration > 0 ? duration : null;
  }

  function lionStartedAt(text) {
    const wall = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (wall) {
      const expected = `${wall[1]}-${wall[2]}-${wall[3]} ${wall[4]}:${wall[5]}:${wall[6]}`;
      const parsed = siteTimeToMs(text);
      if (!Number.isFinite(parsed)) return NaN;
      const parts = isoDateParts(new Date(parsed).toISOString());
      return `${parts.date} ${parts.time}` === expected ? parsed : NaN;
    }
    const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
    if (iso) {
      const date = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]));
      if (date.getUTCFullYear() !== +iso[1] || date.getUTCMonth() + 1 !== +iso[2] ||
          date.getUTCDate() !== +iso[3] || date.getUTCHours() !== +iso[4] ||
          date.getUTCMinutes() !== +iso[5] || date.getUTCSeconds() !== +iso[6]) return NaN;
      return Date.parse(text);
    }
    return NaN;
  }

  function lionRowDetail(row, tail, head) {
    for (const anchor of row.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.getAttribute('href'), window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== '/out/out.eveserverdetail.php') continue;
        if ([...url.searchParams.values()].some(value => value === tail || value === head)) return url.href;
      } catch (error) {}
    }
    return '';
  }

  function getLionKingSnapshot(root = document) {
    if (IS_LION_RAMSES_PAGE) return getRamsesSnapshot(root);
    const expected = ['JBOGNUM', 'TAILNODESN', 'HEADNODESN', 'STARTED', 'STATUS'];
    const headerText = cell => lionCellText(cell).toUpperCase().replace(/[\s_]+/g, '');
    const candidates = [];
    for (const table of root.querySelectorAll('table')) {
      // A retained tracker snapshot is display-only, never a live source.
      if (table.closest('[data-lion-tracker-ui]')) continue;
      const header = Array.from(table.rows).find(row => {
        const cells = Array.from(row.cells);
        return cells.length === 5 && cells.every(cell => cell.colSpan === 1 && cell.rowSpan === 1) &&
          expected.every(label => cells.some(cell => headerText(cell) === label));
      });
      if (header) candidates.push({ table, header });
    }
    if (candidates.length !== 1) return null;
    const { table, header } = candidates[0];
    const columns = expected.map(label => Array.from(header.cells).findIndex(cell => headerText(cell) === label));
    const rows = [];
    const seen = new Map();
    const quarantinedKeys = new Set();
    const invalidReasons = { shape: 0, identity: 0, date: 0, future: 0, conflict: 0 };
    const futureLimit = Date.now() + 10 * 60000;
    let invalidRows = 0;
    const rejectRow = reason => {
      invalidRows += 1;
      invalidReasons[reason] += 1;
    };
    for (const row of Array.from(table.rows)) {
      if (row === header) continue;
      const cells = Array.from(row.cells);
      if (cells.length !== 5 || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) {
        rejectRow('shape');
        continue;
      }
      if (expected.every(label => cells.some(cell => headerText(cell) === label))) continue;
      const [jbog, tailSerial, headSerial, started, statusText] = columns.map(index => lionCellText(cells[index]));
      const startedAt = lionStartedAt(started);
      if (![jbog, tailSerial, headSerial].every(value => value && value.length <= 120)) {
        rejectRow('identity');
        continue;
      }
      if (!Number.isFinite(startedAt)) {
        rejectRow('date');
        continue;
      }
      const key = JSON.stringify([tailSerial.toUpperCase(), headSerial.toUpperCase(), startedAt]);
      if (startedAt > futureLimit) {
        rejectRow('future');
        quarantinedKeys.add(key);
        continue;
      }
      const statusCell = cells[columns[4]];
      const status = normalizeLionKingStatus(statusCell);
      const info = { jbog, tailSerial, headSerial, started, startedAt, status, statusText,
        durationMs: status === 'PASS' ? parseLionKingDuration(statusText) : null,
        detailUrl: lionRowDetail(row, tailSerial, headSerial), key };
      Object.defineProperties(info, { element: { value: row }, statusCell: { value: statusCell },
        nodeCells: { value: columns.slice(0, 3).map(index => cells[index]) } });
      if (seen.has(key) && seen.get(key) !== status) quarantinedKeys.add(key);
      seen.set(key, status);
      rows.push(info);
    }
    // Discover every duplicate before returning any row. Selecting the first
    // PASS/FAIL of a contradictory identity could manufacture a completion.
    const usableRows = rows.filter(row => !quarantinedKeys.has(row.key));
    invalidReasons.conflict = rows.length - usableRows.length;
    invalidRows += invalidReasons.conflict;
    const unknownStatuses = usableRows.filter(row => row.status === 'UNKNOWN').length;
    return { table, rows: usableRows, invalidRows, invalidReasons, unknownStatuses,
      quarantinedKeys: Array.from(quarantinedKeys) };
  }

  function lionSnapshotUsable(snapshot) {
    return !!snapshot && Array.isArray(snapshot.rows) && (snapshot.rows.length > 0 ||
      (snapshot.source === 'ramses' && snapshot.invalidRows === 0)) &&
      snapshot.rows.length <= LION_MAX_RUNS;
  }

  // Ramses provides a live running table and a passed-only CSV download.
  // Inventory "Online", PRETEST and row disappearance are not test outcomes.
  const RAMSES_PASSED_KEY = 'lionKingTrackerRamsesPassedCSV';
  const RAMSES_CSV_MAX_BYTES = 2 * 1024 * 1024;
  let ramsesPassed = [];
  let ramsesCSVAt = 0;
  let ramsesCSVCheckedAt = 0;
  let ramsesCSVSignature = '';
  let ramsesCSVError = '';
  let ramsesCSVInFlight = false;
  let ramsesNextCSVRead = 0;
  let ramsesPassSignature = '';
  let ramsesDOMSignature = '';
  const RAMSES_FAILED_KEY = 'lionKingTrackerRamsesFailedBoard';
  const RAMSES_PASS_CARDS_KEY = 'lionKingTrackerRamsesPassedCards';
  let ramsesPassCardState = null;
  let ramsesFailedState = null;
  let ramsesSourceChanged = false;
  const ramsesStartedAt = Date.now();

  function ramsesTime(value) {
    const text = String(value || '').trim();
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
    const canonical = slash ? `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')} ` +
      `${slash[4].padStart(2, '0')}:${slash[5]}:${slash[6] || '00'}` : text;
    return { at: lionStartedAt(canonical), text: canonical,
      precision: slash && !slash[6] ? 'minute' : 'second' };
  }

  function ramsesRunKey(serial, startedAt) {
    return JSON.stringify(['ramses', 'GPU_JBOG_TEST', serial.toUpperCase(), startedAt]);
  }

  function ramsesValidPass(row) {
    if (!isRecordObject(row) || typeof row.serial !== 'string' ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(row.serial) || !['minute', 'second'].includes(row.precision) ||
        typeof row.started !== 'string' || typeof row.finished !== 'string' ||
        !Number.isSafeInteger(row.attempt) || row.attempt < 1 || row.attempt > 10000) return null;
    const start = ramsesTime(row.started), finish = ramsesTime(row.finished);
    if (!Number.isFinite(start.at) || !Number.isFinite(finish.at) || finish.at <= start.at ||
        finish.at > Date.now() + 10 * 60000 || finish.at - start.at > 10 * LION_DAY_MS) return null;
    return { serial: row.serial.toUpperCase(), started: start.text, startedAt: start.at,
      finished: finish.text, finishedAt: finish.at, precision: row.precision,
      attempt: row.attempt, durationMs: finish.at - start.at };
  }

  function parseRamsesCSV(text) {
    if (typeof text !== 'string' || text.length > RAMSES_CSV_MAX_BYTES) throw new Error('CSV is too large.');
    text = text.replace(/^\uFEFF/, '');
    const separator = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
    const records = [];
    let record = [], cell = '', quoted = false, closed = false;
    const pushCell = () => { record.push(cell); cell = ''; closed = false; };
    const pushRow = () => {
      pushCell();
      if (record.some(value => value.trim())) records.push(record);
      record = [];
      if (records.length > LION_MAX_RUNS + 1) throw new Error('CSV has too many rows.');
    };
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (char === '"') { quoted = false; closed = true; }
        else cell += char;
      } else if (char === '"' && !cell && !closed) quoted = true;
      else if (char === separator) pushCell();
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        pushRow();
      } else {
        if (char === '"' || closed) throw new Error('CSV quoting is invalid.');
        cell += char;
      }
      if (cell.length > 1000 || record.length > 30) throw new Error('CSV field is too large.');
    }
    if (quoted) throw new Error('CSV has an incomplete quoted field.');
    if (cell || record.length) pushRow();
    const expected = ['uut_sn', 'Start Time', 'Finish Time', 'PASSED', 'Attempt', 'FPY_Stat'];
    const headers = (records.shift() || []).map(value => value.trim());
    if (headers.length !== expected.length || new Set(headers).size !== headers.length ||
        !expected.every(label => headers.includes(label))) throw new Error('CSV column headings do not match the MPY passed export.');
    const rows = [], seen = new Map(), conflicts = new Set();
    for (const values of records) {
      if (values.length !== headers.length) throw new Error('CSV row has an unexpected column count.');
      const data = Object.fromEntries(headers.map((label, index) => [label, values[index].trim()]));
      // FPY_Stat can say Retest/Fail for a PASSED=1 row. It is not this outcome.
      if (data.PASSED !== '1') throw new Error('Passed export contains an unverified outcome; previous data retained.');
      const start = ramsesTime(data['Start Time']);
      const pass = ramsesValidPass({ serial: data.uut_sn, started: start.text,
        finished: ramsesTime(data['Finish Time']).text, precision: start.precision, attempt: Number(data.Attempt) });
      if (!pass) throw new Error('CSV contains an invalid node, timestamp, attempt or duration.');
      const key = JSON.stringify([pass.serial, pass.startedAt, pass.precision]);
      const signature = JSON.stringify(pass);
      if (seen.has(key) && seen.get(key) !== signature) conflicts.add(key);
      seen.set(key, signature);
      rows.push({ ...pass, csvKey: key });
    }
    if (conflicts.size) throw new Error('CSV has conflicting results for the same run; previous data retained.');
    return [...new Map(rows.map(row => [row.csvKey, row])).values()];
  }

  function loadRamsesPassedCSV() {
    const saved = readJSON(localStorage, RAMSES_PASSED_KEY, null, 'Ramses passed CSV');
    if (!isRecordObject(saved) || saved.version !== 1 || !Array.isArray(saved.rows) ||
        saved.rows.length > LION_CACHE_MAX_ROWS || !Number.isFinite(saved.at) ||
        saved.at <= 0 || saved.at > Date.now() + 10 * 60000) return;
    ramsesPassed = saved.rows.map(ramsesValidPass).filter(Boolean);
    ramsesCSVAt = saved.at;
    ramsesCSVSignature = JSON.stringify(ramsesPassed);
  }

  function acceptRamsesCSV(text, automatic) {
    try {
      const incoming = parseRamsesCSV(text);
      const merged = new Map(ramsesPassed.map(row => [JSON.stringify([row.serial, row.startedAt, row.precision]), row]));
      for (const row of incoming) {
        const prior = merged.get(row.csvKey);
        if (prior && (prior.finishedAt !== row.finishedAt || prior.attempt !== row.attempt)) {
          throw new Error('Export conflicts with a saved run; previous data retained.');
        }
        merged.set(row.csvKey, row);
      }
      ramsesPassed = [...merged.values()].filter(row => row.finishedAt >= Date.now() - 2 * LION_DAY_MS)
        .sort((a, b) => b.finishedAt - a.finishedAt).slice(0, LION_CACHE_MAX_ROWS);
      ramsesCSVCheckedAt = Date.now();
      const signature = JSON.stringify(ramsesPassed.map(ramsesValidPass));
      if (signature !== ramsesCSVSignature) {
        ramsesCSVSignature = signature; ramsesCSVAt = ramsesCSVCheckedAt;
      }
      ramsesCSVError = writeJSON(localStorage, RAMSES_PASSED_KEY,
        { version: 1, at: ramsesCSVAt, rows: ramsesPassed }, 'Ramses passed CSV') ? '' : 'Passed CSV could not be saved.';
      setTextIfChanged(document.getElementById('lion-csv-feedback'),
        `${automatic ? 'Automatically read' : 'Imported'} ${incoming.length} passed runs. ` +
        'PASS is determined by PASSED=1; first-pass yield is separate.');
      scanLionKing();
      return true;
    } catch (error) {
      ramsesCSVError = error.message;
      setTextIfChanged(document.getElementById('lion-csv-feedback'), error.message);
      scanLionKing();
      return false;
    }
  }

  function ramsesDownloadURL(anchor) {
    if (!anchor || anchor.tagName !== 'A' ||
        !/^jbog_passed_finished_\d{4}-\d{2}-\d{2}\.csv$/i.test(anchor.download)) return null;
    try {
      const url = new URL(anchor.getAttribute('href'), window.location.href);
      if (url.protocol === 'data:' && /^data:(?:text\/csv|text\/plain|application\/octet-stream)[;,]/i.test(url.href) &&
          url.href.length < RAMSES_CSV_MAX_BYTES * 3) return url;
      if (url.protocol === 'blob:' && url.origin === window.location.origin) return url;
      if (url.origin === window.location.origin && /^\/media\//.test(url.pathname)) return url;
    } catch (error) {}
    return null;
  }

  function ramsesSourceCurrent(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"], [data-stale="true"]')) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }

  function ramsesCurrentPassedSource() {
    const matching = [...document.querySelectorAll('a[download]')]
      .filter(anchor => ramsesDownloadURL(anchor) && !isOwnUiNode(anchor));
    const visible = matching.filter(ramsesSourceCurrent);
    // Streamlit may retain old or duplicated download anchors. Prefer the
    // verified current MPY card and treat byte-identical copies as one source.
    // Its label can be followed by the count and subtitle inside the anchor.
    const metrics = visible.filter(anchor => anchor.classList.contains('kpi-link') &&
      /\bMPY\s*\(\s*PASSED\s+JBOGS\s*\)/i.test(anchor.textContent));
    const candidates = metrics.length ? metrics : visible;
    const sources = new Map();
    for (const anchor of candidates) {
      const url = ramsesDownloadURL(anchor);
      const key = JSON.stringify([anchor.download.toLowerCase(), url.href]);
      if (!sources.has(key)) sources.set(key, { anchor, url, key });
    }
    return { matching: matching.length, visible: visible.length, metrics: metrics.length,
      unique: sources.size, selected: sources.size === 1 ? sources.values().next().value : null };
  }

  async function readRamsesDownload(anchor) {
    const url = ramsesDownloadURL(anchor);
    if (!url || ramsesCSVInFlight) return;
    const source = ramsesCurrentPassedSource();
    const key = JSON.stringify([anchor.download.toLowerCase(), url.href]);
    if (!source.selected || source.selected.key !== key) return;
    ramsesCSVInFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok || (/^https?:$/.test(url.protocol) && new URL(response.url).origin !== window.location.origin)) {
        throw new Error('Passed CSV is unavailable; check the dashboard session.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Passed CSV response cannot be read.');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let total = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > RAMSES_CSV_MAX_BYTES) throw new Error('Passed CSV is too large.');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
      // A native update can replace the card while this read is in flight.
      // An obsolete or newly ambiguous source cannot establish completion.
      if (ramsesCurrentPassedSource().selected?.key === key) acceptRamsesCSV(text, true);
    } catch (error) {
      ramsesCSVError = 'Automatic passed CSV read failed; last validated results retained.';
      setTextIfChanged(document.getElementById('lion-csv-feedback'), ramsesCSVError);
    } finally {
      clearTimeout(timeout);
      ramsesCSVInFlight = false;
      const current = ramsesCurrentPassedSource();
      if (current.selected?.key !== key) { pollRamsesPassedCSV(true); scanLionKing(); }
    }
  }

  function pollRamsesPassedCSV(force = false) {
    if (!IS_LION_RAMSES_PAGE || !lionInitialDocumentComplete || ramsesCSVInFlight ||
        (!force && Date.now() < ramsesNextCSVRead)) return;
    ramsesNextCSVRead = Date.now() + settings.refreshIntervalSeconds * 1000;
    const source = ramsesCurrentPassedSource();
    if (source.selected) { readRamsesDownload(source.selected.anchor); return; }
    ramsesCSVError = source.unique > 1
      ? 'Multiple distinct current passed-result sources; automatic source is ambiguous.'
      : 'Current MPY passed-result data is not available; last validated results retained.';
  }

  function getRamsesSnapshot(root = document) {
    const expected = ['JBOGSN', 'STATUS', 'OPERATION', 'STARTED'];
    const label = cell => lionCellText(cell).toUpperCase().replace(/[\s_]+/g, '');
    const candidates = [];
    for (const table of root.querySelectorAll('table')) {
      // Filter only whole source tables. A row hidden by the tracker's Show
      // toggle still participates in observations and completion detection.
      if (table.closest('[data-lion-tracker-ui]') || !ramsesSourceCurrent(table)) continue;
      const header = [...table.rows].find(row => row.cells.length === 4 &&
        [...row.cells].every(cell => cell.colSpan === 1 && cell.rowSpan === 1) &&
        expected.every(value => [...row.cells].some(cell => label(cell) === value)));
      if (header) candidates.push({ table, header });
    }
    if (candidates.length !== 1) return null;
    const { table, header } = candidates[0];
    const runningBadge = table.closest('.board-card')?.querySelector('.badge');
    if (runningBadge && Number(runningBadge.textContent.trim()) !== table.rows.length - 1) return null;
    const columns = expected.map(value => [...header.cells].findIndex(cell => label(cell) === value));
    const rows = [], seen = new Set(), conflicts = new Set();
    const invalidReasons = { shape: 0, identity: 0, date: 0, future: 0, conflict: 0 };
    let pretests = 0;
    const pretestRows = [];
    for (const element of [...table.rows]) {
      if (element === header) continue;
      const cells = [...element.cells];
      if (cells.length !== 4 || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) { invalidReasons.shape += 1; continue; }
      const [serial, statusText, operation, started] = columns.map(index => lionCellText(cells[index]));
      if (operation.toUpperCase() === 'GPU_JBOG_TEST_PRETEST') {
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(serial)) { invalidReasons.identity += 1; continue; }
        pretests += 1;
        pretestRows.push({ tailSerial: serial.toUpperCase(), headSerial: '', element,
          started: Number.isFinite(ramsesTime(started).at) ? ramsesTime(started).text : '', nodeCell: cells[columns[0]] });
        continue;
      }
      if (operation.toUpperCase() !== 'GPU_JBOG_TEST' || !/^[A-Za-z0-9_-]{1,120}$/.test(serial)) { invalidReasons.identity += 1; continue; }
      const parsed = ramsesTime(started);
      if (!Number.isFinite(parsed.at)) { invalidReasons.date += 1; continue; }
      if (parsed.at > Date.now() + 10 * 60000) { invalidReasons.future += 1; continue; }
      const key = ramsesRunKey(serial, parsed.at);
      if (seen.has(key)) { conflicts.add(key); invalidReasons.conflict += 1; }
      seen.add(key);
      rows.push({ source: 'ramses', jbog: serial, tailSerial: serial.toUpperCase(), headSerial: '',
        started: parsed.text, startedAt: parsed.at, status: /^running slt$/i.test(statusText) ? 'RUNNING' : 'UNKNOWN',
        statusText, key, durationMs: null, element, statusCell: cells[columns[1]], nodeCells: [cells[columns[0]]] });
    }
    const running = rows.filter(row => !conflicts.has(row.key));
    const known = new Map(running.map(row => [row.key, { serial: row.tailSerial, at: row.startedAt }]));
    for (const [key, prior] of previousStates) {
      if (prior.source === 'ramses' && typeof prior.serial === 'string') known.set(key, { serial: prior.serial, at: prior.startedAt });
    }
    const completed = [], unresolved = [];
    for (const pass of ramsesPassed) {
      const matches = [...known].filter(([, value]) => value.serial === pass.serial &&
        (pass.precision === 'minute' ? Math.floor(value.at / 60000) === Math.floor(pass.startedAt / 60000) : value.at === pass.startedAt));
      if (matches.length > 1) { unresolved.push(pass); continue; }
      const key = matches.length ? matches[0][0] : ramsesRunKey(pass.serial, pass.startedAt);
      // A still-running source contradicts a terminal CSV observation.
      if (running.some(row => row.key === key)) { unresolved.push(pass); continue; }
      const startedAt = matches.length ? matches[0][1].at : pass.startedAt;
      const parts = isoDateParts(new Date(startedAt).toISOString());
      completed.push({ source: 'ramses', jbog: pass.serial, tailSerial: pass.serial, headSerial: '',
        started: `${parts.date} ${parts.time}`, startedAt, finishedAt: pass.finishedAt, finished: pass.finished,
        durationMs: pass.durationMs, attempt: pass.attempt, status: 'PASS', statusText: 'PASSED=1', key });
    }
    if (root === document) renderRamsesPassedRows(completed);
    const attention = getRamsesFailedBoard(root);
    const all = [...running, ...completed];
    if (unresolved.length) setTextIfChanged(document.getElementById('lion-csv-feedback'),
      `${unresolved.length} passed rows unresolved: active source conflict or ambiguous minute-precision start. No completion alert for those rows.`);
    const signature = JSON.stringify({ running: running.map(row => [row.key, row.status]), pretests,
      attention: attention?.rows.map(row => [row.serial, row.operation, row.route, row.idle, row.statusText]) });
    if (signature !== ramsesDOMSignature || ramsesSourceChanged) {
      ramsesDOMSignature = signature; rackDataAt = Date.now(); ramsesSourceChanged = false;
    }
    return { source: 'ramses', table, rows: all, attention, pretests, pretestRows, unresolvedPasses: unresolved.length,
      invalidRows: Object.values(invalidReasons).reduce((a, b) => a + b, 0), invalidReasons,
      unknownStatuses: running.filter(row => row.status === 'UNKNOWN').length, quarantinedKeys: [...conflicts] };
  }

  function getRamsesFailedBoard(root = document) {
    const expected = ['JBOGSN', 'OPERATION', 'CURRENTROUTE', 'IDLETIME', 'STATUS', 'TICKETNUMBER'];
    const label = cell => lionCellText(cell).toUpperCase().replace(/[\s_]+/g, '');
    const candidates = [];
    for (const table of root.querySelectorAll('table')) {
      if (table.closest('[data-lion-tracker-ui]') || !ramsesSourceCurrent(table)) continue;
      const card = table.closest('.board-card');
      const title = card?.querySelector('.board-title > span:not(.badge)') || card?.querySelector('.board-title');
      if (!card || !/^JBOG Failed Test\b/i.test(title?.textContent.trim() || '')) continue;
      const header = [...table.rows].find(row => row.cells.length === 6 &&
        [...row.cells].every(cell => cell.colSpan === 1 && cell.rowSpan === 1) &&
        expected.every(value => [...row.cells].some(cell => label(cell) === value)));
      if (header) candidates.push({ table, header, card });
    }
    if (candidates.length !== 1) return null;
    const { table, header, card } = candidates[0];
    const columns = expected.map(value => [...header.cells].findIndex(cell => label(cell) === value));
    const rows = [], seen = new Set();
    let invalidRows = 0;
    for (const element of [...table.rows]) {
      if (element === header) continue;
      const cells = [...element.cells];
      if (cells.length !== 6 || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) { invalidRows += 1; continue; }
      const [serial, operationText, route, idle, statusText, ticket] = columns.map(index => lionCellText(cells[index]));
      const operation = operationText.toUpperCase();
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(serial) || [route, idle, statusText].some(value => value.length > 500) ||
          !['GPU_JBOG_TEST', 'PRETEST', 'GPU_JBOG_TEST_PRETEST'].includes(operation)) { invalidRows += 1; continue; }
      const key = JSON.stringify([serial.toUpperCase(), operation]);
      if (seen.has(key)) { invalidRows += 1; continue; }
      seen.add(key);
      rows.push({ key, serial: serial.toUpperCase(), tailSerial: serial.toUpperCase(), headSerial: '',
        operation, route, idle, statusText, jiraKey: JIRA_KEY_PATTERN.test(ticket) ? ticket : '',
        element, statusCell: cells[columns[4]], nodeCell: cells[columns[0]] });
    }
    const badge = card.querySelector('.badge');
    const usable = invalidRows === 0 && (!badge || Number(badge.textContent.trim()) === table.rows.length - 1);
    return { table, rows, invalidRows, usable };
  }

  function lionIsPretestOperation(operation) {
    return ['PRETEST', 'GPU_JBOG_TEST_PRETEST'].includes(String(operation || '').trim().toUpperCase());
  }

  function loadRamsesFailedState() {
    const saved = readJSON(localStorage, RAMSES_FAILED_KEY, null, 'Ramses failed board');
    if (!isRecordObject(saved) || ![1, 2].includes(saved.version) || !isRecordObject(saved.members) ||
        Object.keys(saved.members).length > LION_MAX_RUNS || !Number.isSafeInteger(saved.sequence) ||
        saved.sequence < 0) return null;
    const valid = Object.values(saved.members).every(value => isRecordObject(value) &&
      Number.isSafeInteger(value.episode) && value.episode > 0 && value.episode <= saved.sequence &&
      typeof value.present === 'boolean' && typeof value.pending === 'boolean');
    return valid ? saved : null;
  }

  function saveRamsesFailedState() {
    return writeJSON(localStorage, RAMSES_FAILED_KEY, ramsesFailedState, 'Ramses failed board');
  }

  function loadRamsesPassCardState() {
    const saved = readJSON(localStorage, RAMSES_PASS_CARDS_KEY, null, 'Ramses passed cards');
    if (!isRecordObject(saved) || saved.version !== 1 || !isRecordObject(saved.members) ||
        Object.keys(saved.members).length > LION_MAX_RUNS) return null;
    if (!Object.values(saved.members).every(member => isRecordObject(member) &&
        typeof member.pending === 'boolean' && typeof member.notify === 'boolean' &&
        Number.isFinite(member.finishedAt))) return null;
    return saved;
  }

  function saveRamsesPassCardState() {
    return writeJSON(localStorage, RAMSES_PASS_CARDS_KEY, ramsesPassCardState, 'Ramses passed cards');
  }

  function syncRamsesPassedCards(snapshot) {
    if (!ramsesCSVCheckedAt || ramsesCSVError) return;
    const initial = !ramsesPassCardState;
    if (initial) ramsesPassCardState = { version: 1, members: {} };
    const passed = snapshot.rows.filter(row => row.status === 'PASS')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    for (const row of passed) {
      if (ramsesPassCardState.members[row.key]) continue;
      const prior = previousStates.get(row.key);
      ramsesPassCardState.members[row.key] = { pending: true,
        notify: !initial || !!(prior && prior.status === 'RUNNING' && !prior.completed),
        finishedAt: row.finishedAt };
    }
    const current = new Set(passed.map(row => row.key));
    const obsolete = Object.keys(ramsesPassCardState.members).filter(key => !current.has(key) &&
      !ramsesPassCardState.members[key].pending);
    const excess = Object.keys(ramsesPassCardState.members).length - LION_MAX_RUNS;
    obsolete.sort((a, b) => ramsesPassCardState.members[a].finishedAt - ramsesPassCardState.members[b].finishedAt)
      .slice(0, Math.max(0, excess)).forEach(key => delete ramsesPassCardState.members[key]);
    // Persist delivery intent first; refreshes cannot consume a pending PASS.
    if (!saveRamsesPassCardState()) return;
    const hours = settings.lionHistoryHours === 'all' ? Infinity : Number(settings.lionHistoryHours);
    for (const row of passed) {
      const member = ramsesPassCardState.members[row.key];
      if (!member?.pending || (!member.notify && row.finishedAt < Date.now() - hours * 3600000)) continue;
      emitLionKingCompletion(row, { notify: member.notify, history: !member.notify });
    }
  }

  function lionKingRunningOnPage(serial) {
    const snapshot = getLionKingSnapshot();
    if (!lionSnapshotUsable(snapshot)) return null;
    const sn = String(serial || '').trim().toUpperCase();
    const matches = snapshot.rows.filter(row => [row.tailSerial, row.headSerial].includes(sn));
    if (matches.some(row => row.status === 'RUNNING')) return true;
    if (matches.some(row => row.status === 'UNKNOWN')) return null;
    if (matches.length || (snapshot.attention?.usable &&
        snapshot.attention.rows.some(row => row.serial === sn && row.operation === 'GPU_JBOG_TEST'))) return false;
    return null;
  }

  function scanRamsesFailedBoard(snapshot) {
    const board = snapshot.attention;
    if (!board?.usable) return;
    const failures = board.rows.filter(row => row.operation === 'GPU_JBOG_TEST' ||
      lionIsPretestOperation(row.operation));
    if (!ramsesFailedState) {
      ramsesFailedState = { version: 2, sequence: failures.length, members: Object.fromEntries(failures.map((row, index) =>
        [row.key, { episode: index + 1, present: true, pending: false }])) };
      saveRamsesFailedState();
      return;
    }
    if (ramsesFailedState.version === 1) {
      // Earlier releases never monitored PRETEST failures. Establish their
      // existing membership quietly without replaying old failures on upgrade.
      // Keep all GPU episodes and any pending deliveries unchanged.
      failures.filter(row => lionIsPretestOperation(row.operation)).forEach(row => {
        const prior = ramsesFailedState.members[row.key];
        ramsesFailedState.members[row.key] = {
          episode: prior?.episode || ++ramsesFailedState.sequence, present: true, pending: false
        };
      });
      ramsesFailedState.version = 2;
    }
    const present = new Set(failures.map(row => row.key));
    Object.entries(ramsesFailedState.members).forEach(([key, value]) => {
      if (!present.has(key)) value.present = false;
    });
    for (const row of failures) {
      let member = ramsesFailedState.members[row.key];
      if (!member || !member.present) {
        member = { episode: ++ramsesFailedState.sequence, present: true, pending: true };
        ramsesFailedState.members[row.key] = member;
      }
      if (!member.pending) continue;
      // This proves a newly listed failed-board entry, not a particular
      // Started value or TestView ID. Preserve that distinction in the alert.
      emitLionKingCompletion({ source: 'ramses', evidence: 'ramses-failed-board',
        failureMember: row.key, failureEpisode: member.episode,
        key: JSON.stringify(['ramses-failed-board', row.serial, row.operation, member.episode]),
        jbog: row.serial, tailSerial: row.serial, headSerial: '', started: '', status: 'FAIL', jiraKey: row.jiraKey,
        operation: row.operation,
        statusText: `New on JBOG Failed Test board; ${row.operation}; ${row.statusText}; route: ${row.route}` });
    }
    if (Object.keys(ramsesFailedState.members).length > LION_MAX_RUNS) {
      Object.entries(ramsesFailedState.members).filter(([, value]) => !value.present && !value.pending)
        .slice(0, Object.keys(ramsesFailedState.members).length - LION_MAX_RUNS)
        .forEach(([key]) => delete ramsesFailedState.members[key]);
    }
    saveRamsesFailedState();
  }

  function renderRamsesPassedRows(rows) {
    let holder = document.getElementById('lion-ramses-passed-view');
    if (!holder) {
      holder = document.createElement('section');
      holder.id = 'lion-ramses-passed-view';
      holder.setAttribute('data-lion-tracker-ui', 'passed-results');
      const heading = document.createElement('h3'); heading.textContent = 'Lion King - validated passed runs'; holder.appendChild(heading);
      const table = document.createElement('table'); table.id = 'lion-ramses-passed';
      const header = table.createTHead().insertRow();
      ['JBOG SN', 'Started', 'Finished', 'Duration', 'Status'].forEach(label => {
        const cell = document.createElement('th'); cell.textContent = label; header.appendChild(cell);
      });
      table.createTBody(); holder.appendChild(table); document.body.appendChild(holder);
    }
    const signature = JSON.stringify(rows.map(row => [row.key, row.finishedAt]));
    const body = holder.querySelector('tbody');
    if (signature !== ramsesPassSignature) {
      withoutObserver(() => {
        body.replaceChildren();
        rows.forEach(row => {
          const element = body.insertRow(); element.dataset.runKey = row.key;
          [row.tailSerial, row.started, row.finished, lionHoursMinutes(row.durationMs), 'PASS'].forEach(value => {
            const cell = element.insertCell(); cell.textContent = value;
          });
          element.cells[4].style.backgroundColor = 'green'; element.cells[4].style.color = 'white';
          const open = event => {
            if (event.type === 'keydown' && event.key !== 'Enter') return;
            if (event.type === 'click' && event.button !== 0) return;
            if (event.type === 'auxclick' && event.button !== 1) return;
            event.preventDefault();
            openLionKingTestView(row.tailSerial, row.started,
              (event.button === 1 || event.ctrlKey || event.metaKey) && typeof GM_openInTab === 'function'
                ? url => GM_openInTab(url, { active: false, insert: true }) : openExternal);
          };
          ['click', 'auxclick', 'keydown'].forEach(type => element.cells[0].addEventListener(type, open));
        });
      });
      ramsesPassSignature = signature;
    }
    const elements = new Map([...body.rows].map(element => [element.dataset.runKey, element]));
    rows.forEach(row => {
      row.element = elements.get(row.key); row.statusCell = row.element.cells[4]; row.nodeCells = [row.element.cells[0]];
    });
  }

  function lionKingPassAverage(rows, now = Date.now()) {
    const seen = new Set();
    let total = 0;
    let samples = 0;
    for (const row of rows) {
      const sampleAt = IS_LION_RAMSES_PAGE ? row.finishedAt : row.startedAt;
      if (row.status !== 'PASS' || !Number.isFinite(sampleAt) || sampleAt < now - LION_DAY_MS || sampleAt > now || seen.has(row.key)) continue;
      const duration = IS_LION_RAMSES_PAGE ? row.durationMs : parseLionKingDuration(row.statusText);
      if (!duration) continue;
      seen.add(row.key);
      total += duration;
      samples += 1;
    }
    return { averageMs: samples ? total / samples : null, samples };
  }

  function lionHoursMinutes(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function updateLionKingRows(snapshot) {
    const now = Date.now();
    const average = lionKingPassAverage(snapshot.rows, now);
    const averageLabel = document.getElementById('lion-average-pass');
      if (averageLabel) setTextIfChanged(averageLabel, 'Average pass: ' +
      (average.averageMs ? lionHoursMinutes(average.averageMs) : 'unavailable') +
      ` (${average.samples} samples, ${IS_LION_RAMSES_PAGE ? 'finished' : 'started'} in last 24h)`);
    const counts = { RUNNING: 0, PASS: 0, FAIL: 0, UNKNOWN: 0 };
    const areaCounts = Object.fromEntries(Object.keys(LION_AREAS).map(area =>
      [area, { pretest: 0, pretestFailed: 0, testing: 0, failed: 0, passed: 0 }]));
    let attentionGPU = 0, attentionPretest = 0;
    let hidden = 0;
    const hours = settings.lionHistoryHours === 'all' ? Infinity : Number(settings.lionHistoryHours);
    withoutObserver(() => {
      snapshot.rows.forEach(row => {
        row.nodeCells.forEach((cell, index) => {
          const label = IS_LION_RAMSES_PAGE ? 'JBOG' : index === 2 ? 'Head' : 'Tail';
          if (cell.getAttribute('role') !== 'link') cell.setAttribute('role', 'link');
          if (cell.tabIndex !== 0) cell.tabIndex = 0;
          const title = `Open ${label} node in Lion King TestView 2.0`;
          if (cell.title !== title) cell.title = title;
          if (!cell.classList.contains('eve-lion-node-link')) cell.classList.add('eve-lion-node-link');
        });
        const area = lionAreaForRow(row);
        const old = (row.status === 'PASS' || row.status === 'FAIL') &&
          (IS_LION_RAMSES_PAGE && row.finishedAt ? row.finishedAt : row.startedAt) < now - hours * 3600000;
        const hide = old || !lionRowShow(row);
        if (row.element.hidden !== hide) row.element.hidden = hide;
        if (old) hidden += 1;
        if (!hide) counts[row.status] += 1;
        if (!old) {
          const category = { RUNNING: 'testing', PASS: 'passed', FAIL: 'failed' }[row.status];
          if (category) areaCounts[area][category] += 1;
        }
        let eta = row.statusCell.querySelector('[data-lion-tracker-ui]');
        if (row.status !== 'RUNNING') {
          if (eta) eta.remove();
          return;
        }
        if (!eta) {
          eta = document.createElement('span');
          eta.className = 'eve-lion-eta';
          eta.setAttribute('data-lion-tracker-ui', 'eta');
          row.statusCell.appendChild(eta);
        }
        const finish = average.averageMs ? row.startedAt + average.averageMs : null;
        const text = finish ? `Estimated finish: ${siteDateTime(new Date(finish))} (` +
          (finish <= now ? 'past estimate' : `${lionHoursMinutes(finish - now)} remaining`) + ')' :
          'Estimate unavailable';
        setTextIfChanged(eta, text);
      });
      if (IS_LION_RAMSES_PAGE && snapshot.attention?.usable) snapshot.attention.rows.forEach(row => {
        const area = lionAreaForRow(row), gpu = row.operation === 'GPU_JBOG_TEST';
        row.element.hidden = !lionRowShow(row);
        if (gpu) { attentionGPU += 1; areaCounts[area].failed += 1; }
        else { attentionPretest += 1; areaCounts[area].pretestFailed += 1; }
        row.nodeCell.classList.add('eve-lion-node-link'); row.nodeCell.setAttribute('role', 'link'); row.nodeCell.tabIndex = 0;
        row.nodeCell.title = 'Open this node in the Lion King TestView UUT list';
      });
      if (IS_LION_RAMSES_PAGE) (snapshot.pretestRows || []).forEach(row => {
        const area = lionAreaForRow(row);
        row.element.hidden = !lionRowShow(row);
        areaCounts[area].pretest += 1;
        row.nodeCell.classList.add('eve-lion-node-link'); row.nodeCell.setAttribute('role', 'link'); row.nodeCell.tabIndex = 0;
        row.nodeCell.title = 'Open this node in the Lion King TestView UUT list (PRETEST)';
      });
    });
    lastSectionCounts = areaCounts;
    renderSectionCounts();
    document.querySelectorAll('#eve-section-list .eve-section-stats').forEach(stats => {
      if (IS_LION_RAMSES_PAGE) {
        const counts = areaCounts[stats.closest('.eve-section-row').dataset.section];
        setSectionStat(stats.querySelector('.eve-stat-pretest'), counts.pretest, 'pre');
        setSectionStat(stats.querySelector('.eve-stat-testing'), counts.testing, 'test');
        setSectionStat(stats.querySelector('.eve-stat-pretest-failed'), counts.pretestFailed, 'pre fail');
        stats.title = `${counts.pretest} running PRETEST · ${counts.testing} running GPU tests · ` +
          `${counts.pretestFailed} PRETEST fails · ${counts.failed} test fails · ${counts.passed} passed. ` +
          'Failed-board entries are detected observations; the board does not supply test start times.';
        return;
      }
      stats.title = 'Lion King results within the selected completed-history window; active runs have no age limit.';
    });
    const summary = document.getElementById('lion-summary');
    if (summary) setTextIfChanged(summary, `Visible: ${counts.RUNNING} running, ${counts.PASS} pass, ` +
      `${counts.FAIL} fail, ${counts.UNKNOWN} unknown. ${hidden} old completed rows hidden.` +
      (snapshot.invalidRows ? ` ${snapshot.invalidRows} rows rejected (${lionInvalidRowSummary(snapshot)}); valid rows continue monitoring.` : '') +
      (IS_LION_RAMSES_PAGE ? ` ${snapshot.pretests || 0} running PRETEST rows. Failed board: ` +
        (snapshot.attention?.usable ? `${attentionGPU} GPU test fails, ${attentionPretest} PRETEST fails. New entries notify separately; Started is not supplied on this board.` :
          'unavailable or incomplete; saved observations retained.') : ''));
    refreshLionRackBoard(snapshot);
    applyAlertFilter();
  }

  function emitLionKingCompletion(row, options = {}) {
    if (lionPendingEvents.has(row.key)) return;
    lionPendingEvents.add(row.key);
    if (!emitLionKingCompletion.failedRuns) emitLionKingCompletion.failedRuns = new Set();
    const failed = detail => {
      emitLionKingCompletion.failedRuns.add(row.key);
      reportHealth('DEGRADED', detail, true);
      return false;
    };
    const act = () => {
      const now = Date.now();
      const saved = readJSON(localStorage, EVENT_CLAIMS_KEY, {}, 'Lion event claims');
      const claims = Object.fromEntries(Object.entries(isRecordObject(saved) ? saved : {})
        .filter(([, at]) => typeof at === 'number' && Number.isFinite(at) && at > 0 &&
          at <= now + EVENT_TIME_SKEW_MS));
      if (claims[row.key]) return true;
      const matchesRun = entry => entry.tracker === 'lionking' && entry.runKey === row.key &&
        ['PASS', 'FAIL'].includes(entry.result) && typeof entry.eventId === 'string' &&
        entry.eventId && Number.isFinite(entry.ts) && Number.isFinite(Date.parse(entry.iso || ''));
      // Reuse a durable or still-pending event after a quota failure. A claim
      // must never be saved before its audit entry, or reload could lose it.
      let record = loadAlertLogFromStorage().find(matchesRun) || getAlertLog().find(matchesRun);
      if (!record) {
        const operation = lionIsPretestOperation(row.operation) ? row.operation : 'GPU_JBOG_TEST';
        const pretest = row.status === 'FAIL' && lionIsPretestOperation(operation);
        const transition = row.status === 'PASS' ? 'TEST_SUCCESS' : pretest ? 'PRETEST_FAILURE' : 'TEST_FAILURE';
        const id = 'lion-' + now + '-' + Math.random().toString(36).slice(2);
        const displayAt = options.history && Number.isFinite(row.finishedAt) ? row.finishedAt : now;
        record = { id, eventId: id, ts: displayAt, tracker: 'lionking', source: row.source || 'collector', transition,
          title: row.status === 'PASS' ? 'LION KING PASS' : pretest ? 'LION KING PRE-TEST FAIL' : 'LION KING TEST FAIL',
          serial: row.tailSerial, tailSerial: row.tailSerial,
          headSerial: row.headSerial, started: row.started, finished: row.finished || '',
          durationMs: Number.isFinite(row.durationMs) ? row.durationMs : null,
          jiraKey: row.jiraKey || '', history: !!options.history, runKey: row.key,
          ...lionPhysicalLocation(row), statusLine: `${operation}: ${row.statusText}`,
          detailUrl: row.detailUrl, phaseSource: row.evidence || (row.source === 'ramses' ? 'ramses-passed-data' : 'lionking-table'),
          resultConfirmed: row.source === 'ramses' && row.status === 'PASS',
          iso: new Date(displayAt).toISOString(), result: row.status, operation,
          statusText: row.statusText, jbog: row.jbog,
          alertId: lionRowWatch(row) ? id : '',
          eventIso: row.source === 'ramses' && row.finishedAt ? new Date(row.finishedAt).toISOString() : '',
          timeSource: row.source === 'ramses' && row.finishedAt ? 'source-finished' : 'detected' };
        appendAlertLog(record);
      }
      flushAlertLog(true);
      const durable = loadAlertLogFromStorage().find(entry => matchesRun(entry) &&
        entry.eventId === record.eventId);
      if (!durable) return failed('Cannot save the completion log; export logs and free browser storage. Retrying.');
      record = durable;
      const keys = Object.keys(claims);
      if (keys.length >= LION_MAX_RUNS) {
        keys.sort((a, b) => claims[a] - claims[b]).slice(0, keys.length - LION_MAX_RUNS + 1)
          .forEach(key => delete claims[key]);
      }
      claims[row.key] = now;
      if (!writeJSON(localStorage, EVENT_CLAIMS_KEY, claims, 'Lion event claims')) {
        return failed('Cannot save completion claims; export logs and free browser storage. Retrying.');
      }
      if (record.alertId && lionRowWatch(row)) {
        renderAlertElement(record, true);
        if (options.notify !== false) {
          revealNewAlert(record.id);
          sendDesktopNotification(record.title,
          `${record.source === 'ramses' ? 'JBOG' : 'Tail'}: ${record.tailSerial}\n` +
            (record.headSerial ? `Head: ${record.headSerial}\n` : '') + record.statusText,
          record.result === 'PASS' ? ICON_PASS : ICON_FAIL,
            () => openNotificationTarget(record));
        }
      }
      return true;
    };
    Promise.resolve().then(() => navigator.locks && typeof navigator.locks.request === 'function'
      ? navigator.locks.request('eve-lion-king-completion', { mode: 'exclusive' }, act)
      : act()).then(acknowledged => {
      if (!acknowledged) return;
      emitLionKingCompletion.failedRuns.delete(row.key);
      if (row.source === 'ramses' && row.status === 'PASS') {
        const member = ramsesPassCardState?.members[row.key];
        if (member) {
          member.pending = false;
          if (!saveRamsesPassCardState()) member.pending = true;
        }
      }
      if (row.evidence === 'ramses-failed-board') {
        const member = ramsesFailedState?.members[row.failureMember];
        if (member && member.episode === row.failureEpisode) {
          member.pending = false;
          if (!saveRamsesFailedState()) member.pending = true;
        }
      }
      const prior = previousStates.get(row.key);
      if (prior && !prior.completed) {
        previousStates.set(row.key, { ...prior, status: row.status, completed: true, seenAt: Date.now() });
        savePreviousStates();
      }
    }).catch(error => {
      fail('Lion completion could not be recorded:', error);
      failed('Completion logging failed; export the log and inspect browser storage. Retrying.');
    }).finally(() => lionPendingEvents.delete(row.key));
  }

  function scanLionKing() {
    if (!settings) return;
    if (!lionInitialDocumentComplete) {
      reportHealth('LOADING', 'Controls are ready. Waiting for the initial Lion King table; no partial results are recorded.', true);
      if (lionCachedSnapshot) showLionKingSnapshotCache();
      else setTextIfChanged(document.getElementById('lion-summary'), 'Loading the source table. Controls are available.');
      setTextIfChanged(document.getElementById('lion-rack-source'), 'Live source is loading. Rack assignments are saved.');
      return;
    }
    if (!autoRefreshTimer && !softRefreshInFlight) scheduleLionKingRefresh();
    if (IS_LION_RAMSES_PAGE) pollRamsesPassedCSV();
    const snapshot = getLionKingSnapshot();
    if (!lionSnapshotUsable(snapshot)) {
      const detail = snapshot?.invalidRows ? `${snapshot.invalidRows} rejected rows (${lionInvalidRowSummary(snapshot)}). ` : '';
      if (lionCachedSnapshot && !lionHasCompletedSnapshot) showLionKingSnapshotCache();
      else setTextIfChanged(document.getElementById('lion-summary'), 'No usable live rows. ' + detail + 'Previous observations are preserved.');
      reportHealth('BLIND', detail + 'No usable Lion King table; saved data and baselines preserved.', true);
      setTextIfChanged(document.getElementById('lion-rack-source'), 'Live source unavailable; last observations and rack assignments are kept.');
      return;
    }
    const now = Date.now();
    if (!lionHasCompletedSnapshot) {
      rackDataAt = now;
      lionHasCompletedSnapshot = true;
    }
    for (const row of snapshot.rows) {
      if (row.status === 'UNKNOWN') continue;
      const prior = previousStates.get(row.key);
      const terminal = row.status === 'PASS' || row.status === 'FAIL';
      if (IS_LION_RAMSES_PAGE && row.status === 'PASS') {
        previousStates.set(row.key, prior ? { ...prior, seenAt: now } : {
          status: 'PASS', completed: false, seenAt: now, startedAt: row.startedAt,
          source: row.source, serial: row.tailSerial });
        continue;
      }
      if (prior && prior.status === 'RUNNING' && !prior.completed && terminal) {
        // Display-history limits never suppress a newly observed completion.
        // Keep RUNNING until the async log/claim write acknowledges success,
        // so a quota failure is retried without consuming this transition.
        previousStates.set(row.key, { ...prior, seenAt: now });
        emitLionKingCompletion(row);
        continue;
      }
      previousStates.set(row.key, { status: row.status, completed: terminal || !!(prior && prior.completed),
        seenAt: now, startedAt: row.startedAt, source: row.source, serial: row.tailSerial });
    }
    // Retain absent runs through partial refreshes. Bound the saved history by
    // last observation, without changing identities of rows still on the page.
    if (previousStates.size > LION_MAX_RUNS) {
      const present = new Set(snapshot.rows.map(row => row.key));
      [...previousStates.entries()].filter(([key]) => !present.has(key))
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, previousStates.size - LION_MAX_RUNS).forEach(([key]) => previousStates.delete(key));
    }
    savePreviousStates();
    if (IS_LION_RAMSES_PAGE) { syncRamsesPassedCards(snapshot); scanRamsesFailedBoard(snapshot); }
    document.getElementById('lion-cached-view')?.remove();
    saveLionKingSnapshotCache(snapshot);
    updateLionKingRows(snapshot);
    if (lionRefreshError) reportHealth('DEGRADED', lionRefreshError, true);
    else if (emitLionKingCompletion.failedRuns && emitLionKingCompletion.failedRuns.size) reportHealth('DEGRADED',
      'Completion storage failed; pending results will be retried. Export logs and free browser storage.', true);
    else if (lionCacheWriteFailed) reportHealth('DEGRADED',
      'Live monitoring continues, but the saved snapshot could not be persisted. Check browser storage.', true);
    else if (snapshot.invalidRows) reportHealth('DEGRADED',
      `${snapshot.invalidRows} rejected Lion King rows (${lionInvalidRowSummary(snapshot)}); ${snapshot.rows.length} valid rows continue monitoring.`, true);
    else if (snapshot.unknownStatuses) reportHealth('DEGRADED',
      `${snapshot.unknownStatuses} unrecognized Lion King statuses; no alerts for those rows.`, true);
    else if (IS_LION_RAMSES_PAGE) reportHealth(snapshot.attention?.usable && ramsesCSVCheckedAt && !ramsesCSVError &&
        !snapshot.unresolvedPasses ? 'OK' : 'DEGRADED',
      ramsesCSVError || (!ramsesCSVAt ? 'Running tests monitored. Automatic passed-result source not yet available.' :
        snapshot.unresolvedPasses ? `${snapshot.unresolvedPasses} passed results conflict with active runs or have ambiguous start times; no alerts for them.` :
          snapshot.attention?.usable ? 'Monitoring running tests, completed passes and newly listed GPU failed-board entries.' :
            'Running/PASS monitoring active. Failed board missing, incomplete or ambiguous; earlier observations preserved.'), true);
    else reportHealth('OK', 'Lion King table validated. Results are read from the collector.', true);
  }

  function scheduleLionKingRefresh() {
    if (!lionInitialDocumentComplete) return;
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshDueAt = Date.now() + settings.refreshIntervalSeconds * 1000;
    autoRefreshTimer = setTimeout(refreshLionKing, settings.refreshIntervalSeconds * 1000);
  }

  function onLionKingNodeClick(event) {
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    const cell = event.target.closest && event.target.closest('td.eve-lion-node-link');
    if (!cell || isOwnUiNode(cell) || isOwnUiNode(event.target)) return;
    const snapshot = getLionKingSnapshot();
    if (!lionSnapshotUsable(snapshot)) return;
    if (IS_LION_RAMSES_PAGE && snapshot.attention?.usable) {
      const attention = snapshot.attention.rows.find(row => row.nodeCell === cell);
      if (attention) {
        event.preventDefault(); event.stopPropagation();
        openLionKingTestView(attention.serial, '',
          (event.button === 1 || event.ctrlKey || event.metaKey) && typeof GM_openInTab === 'function'
            ? url => GM_openInTab(url, { active: false, insert: true }) : openExternal, attention.operation);
        return;
      }
    }
    if (IS_LION_RAMSES_PAGE) {
      const pretest = snapshot.pretestRows.find(row => row.nodeCell === cell);
      if (pretest) {
        event.preventDefault(); event.stopPropagation();
        openLionKingTestView(pretest.tailSerial, pretest.started,
          (event.button === 1 || event.ctrlKey || event.metaKey) && typeof GM_openInTab === 'function'
            ? url => GM_openInTab(url, { active: false, insert: true }) : openExternal, pretest.operation || 'PRETEST');
        return;
      }
    }
    const row = snapshot.rows.find(info => info.nodeCells.includes(cell));
    if (!row) return;
    const serial = row.nodeCells.indexOf(cell) === 2 ? row.headSerial : row.tailSerial;
    event.preventDefault();
    event.stopPropagation();
    const background = event.button === 1 || event.ctrlKey || event.metaKey;
    openLionKingTestView(serial, row.started, background && typeof GM_openInTab === 'function'
      ? url => GM_openInTab(url, { active: false, insert: true }) : openExternal, row.operation);
  }

  async function refreshLionKing() {
    if (!lionInitialDocumentComplete) { scanLionKing(); return; }
    if (IS_LION_RAMSES_PAGE) {
      if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
      pollRamsesPassedCSV(true);
      scanLionKing();
      const nativeRefresh = [...document.querySelectorAll('iframe[src]')].some(frame => {
        try {
          const url = new URL(frame.getAttribute('src'), window.location.href);
          return url.origin === window.location.origin &&
            url.pathname === '/component/streamlit_autorefresh.st_autorefresh/index.html';
        } catch (error) { return false; }
      });
      if (!nativeRefresh && Date.now() - ramsesStartedAt >= 60000) {
        savePreviousStates(); flushAlertLog(true); saveRamsesFailedState();
        window.location.reload();
        return;
      }
      scheduleLionKingRefresh();
      return;
    }
    if (softRefreshInFlight) return;
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
    softRefreshInFlight = true;
    softRefreshController = new AbortController();
    const timeout = setTimeout(() => softRefreshController && softRefreshController.abort(), 120000);
    try {
      const response = await fetch(window.location.href, { credentials: 'include', cache: 'no-store',
        signal: softRefreshController.signal });
      const finalUrl = new URL(response.url);
      if (!response.ok || finalUrl.origin !== window.location.origin ||
          finalUrl.pathname !== '/out/out.evelionking_all.php') throw new Error('Session or HTTP response is invalid.');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      const incoming = getLionKingSnapshot(parsed);
      const current = getLionKingSnapshot();
      if (!lionSnapshotUsable(incoming)) {
        throw new Error('Response does not contain a complete Lion King table.');
      }
      withoutObserver(() => {
        const table = document.importNode(incoming.table, true);
        if (current) current.table.replaceWith(table);
        else document.body.insertBefore(table, document.getElementById('eve-tracker-panel'));
      });
      rackDataAt = Date.now();
      lionRefreshError = '';
      scanLionKing();
    } catch (error) {
      lionRefreshError = 'Refresh failed; last valid table retained. Check this page login or connection.';
      reportHealth('DEGRADED', lionRefreshError, true);
      warn('Lion King refresh failed:', error);
    } finally {
      clearTimeout(timeout);
      softRefreshController = null;
      softRefreshInFlight = false;
      scheduleLionKingRefresh();
    }
  }

  function buildLionKingLog(csv) {
    const entries = loadRealAlertLog().filter(entry => entry.tracker === 'lionking');
    const headers = ['Detected At', 'Outcome', 'Area', 'JBOG_NUM', 'TailNode_SN', 'HeadNode_SN', 'Started', 'Status', 'Notified'];
    if (IS_LION_RAMSES_PAGE) headers.push('Evidence', 'Source Finished At');
    const values = entry => {
      const row = [entry.iso, entry.result, LION_AREAS[entry.area] || 'Unassigned', entry.jbog, entry.tailSerial, entry.headSerial,
        entry.started, entry.statusText, entry.alertId ? 'yes' : 'no'];
      if (IS_LION_RAMSES_PAGE) row.push(entry.phaseSource, entry.eventIso || '');
      return row;
    };
    if (csv) return [headers.join(','), ...entries.map(entry => values(entry).map(csvEscape).join(','))].join('\r\n');
    return ['eve_slt_Jbog_tracker - ALERT LOG', `Tracker version: ${SCRIPT_VERSION}`,
      `Shift: ${shiftWindowLabel(currentShiftWindow())}`, `Total alerts: ${entries.length}`,
      IS_LION_RAMSES_PAGE ? 'Detection times are separate from passed-source Finished times. Failed-board entries have no authoritative Started or Finished.' :
        'Times are detection times; the source does not expose a verified Finished timestamp.', '',
      ...entries.map(entry => headers.map((label, index) => `${label}: ${values(entry)[index] || ''}`).join('\n') + '\n')].join('\n');
  }

  function showLionKingDemo(status) {
    const now = Date.now();
    const parts = isoDateParts(new Date(now).toISOString());
    const record = { id: 'debug-lion-' + now, ts: now, tracker: 'lionking', debug: true,
      title: 'DEBUG LION KING ' + status, transition: status === 'PASS' ? 'TEST_SUCCESS' : 'TEST_FAILURE',
      serial: 'DEBUG-LION-TAIL', tailSerial: 'DEBUG-LION-TAIL', headSerial: 'DEBUG-LION-HEAD',
      started: parts.date + ' ' + parts.time, location: 'Synthetic notification test',
      statusLine: 'Synthetic ' + status + ' - not a real server result', result: status };
    renderAlertElement(record, true);
    revealNewAlert(record.id);
    sendDesktopNotification(record.title, record.statusLine,
      status === 'PASS' ? ICON_PASS : ICON_FAIL, null);
  }

  function initializeLionKing() {
    if (!claimThisTab()) return;
    settings = loadSettings();
    settings.lionHistoryHours = ['24', '48', 'all'].includes(String(settings.lionHistoryHours))
      ? String(settings.lionHistoryHours) : '24';
    settings.lionNotifications = settings.lionNotifications !== false;
    settings.sections = isRecordObject(settings.sections) ? settings.sections : {};
    if (settings.lionRowWorkRevision !== LION_WORK_PREFS_REVISION) {
      Object.keys(LION_AREAS).forEach(area => { settings.sections[area] = { show: false, watch: false }; });
      settings.lionNotifications = false;
      settings.lionRowWorkRevision = LION_WORK_PREFS_REVISION;
      saveSettings();
    }
    settings.lionAreas = Object.fromEntries(Object.entries(isRecordObject(settings.lionAreas) ? settings.lionAreas : {})
      .filter(([serial, area]) => serial && serial.length <= 120 &&
        (area === 'lionking1' || (area !== 'unassigned' && Object.prototype.hasOwnProperty.call(LION_AREAS, area)))).slice(0, LION_MAX_RUNS)
      .map(([serial, area]) => [serial.trim().toUpperCase(), area]));
    lionRackBoard = readLionRackBoard();
    indexLionRacks();
    Object.keys(LION_AREAS).forEach(lionAreaSettings);
    previousStates = new Map([...loadPreviousStates()].filter(([, value]) => isRecordObject(value) &&
      ['RUNNING', 'PASS', 'FAIL'].includes(value.status) && typeof value.completed === 'boolean' &&
      Number.isFinite(value.startedAt) && Number.isFinite(value.seenAt)));
    lionCachedSnapshot = loadLionKingSnapshotCache();
    if (IS_LION_RAMSES_PAGE) {
      loadRamsesPassedCSV(); ramsesFailedState = loadRamsesFailedState();
      ramsesPassCardState = loadRamsesPassCardState();
    }
    stripMetaRefresh(document);
    rackDataAt = Date.now();
    checkLogShiftRollover();
    injectCSS();
    const panel = document.createElement('div');
    panel.id = 'eve-tracker-panel';
    panel.className = 'eve-tracker-window eve-lion-compact';
    // Use the actual SLT panel shell and styles; only its source-specific
    // controls and developer actions differ for Lion King.
    panel.innerHTML = buildTrackerPanelMarkup();
    const main = panel.querySelector('#eve-ui-page-main');
    main.querySelectorAll('.eve-dev-group').forEach(group => {
      if (group.querySelector('#eve-jira-base-url')) group.classList.add('eve-dev-only');
      else group.remove();
    });
    main.insertAdjacentHTML('beforeend', `<div class="eve-dev-group">
      <div class="eve-dev-label">GPU_JBOG_TEST</div><div id="lion-summary"></div>
      <div id="lion-average-pass"></div><div class="eve-debug-hint">Finish times are estimates from recent passed runs.</div>
      <label class="eve-dev-row">Completed history <select id="lion-history-hours" class="eve-dev-input">
      <option value="24">24 hours</option><option value="48">48 hours</option><option value="all">All</option></select></label>
      </div><div class="eve-dev-group"><div class="eve-dev-label">Physical racks</div>
      <div class="eve-debug-hint">Use Rack Map in Tracker Controls. Click a slot and scan one serial; its location and details are filled automatically.</div>
      <details><summary class="eve-debug-hint">Area only (without a rack slot)</summary>
      <input id="lion-area-serial" class="eve-dev-input" placeholder="Tail or head node serial" maxlength="120"
      aria-label="Node serial for area assignment"><div class="eve-dev-row">
      <select id="lion-area-choice" class="eve-dev-input" aria-label="Area assignment">
      ${Object.entries(LION_AREAS).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
      </select><button id="lion-area-save" class="eve-dev-btn" type="button">Save area</button></div>
      <div id="lion-area-feedback" class="eve-debug-hint" role="status"></div>
      <div class="eve-debug-hint">The source has no rack column. Assignments are saved for future runs of that node;
      unknown or conflicting pairs stay Unassigned. A rack-slot assignment takes priority.</div></details></div>
      <div class="eve-dev-group"><div class="eve-dev-label">Monitoring status</div>
      <div id="lion-data-age" class="eve-refresh-status"></div><div id="eve-keepalive-status" class="eve-refresh-status"></div>
      <button id="lion-copy-diagnostics" class="eve-dev-btn" type="button"><span class="eve-alert-copy-hint">Copy source diagnostics</span></button>
      <div class="eve-debug-hint">Latest 50 alert cards are retained; export the shift log for the full record.</div></div>`);
    panel.querySelector('#eve-ui-page-debug').innerHTML = `<div class="eve-section-title">Developer</div>
      <div class="eve-dev-group"><div class="eve-dev-label">Synthetic notification tests</div>
      <div class="eve-dev-grid"><button id="lion-debug-pass" class="eve-dev-btn" type="button">Test pass</button>
      <button id="lion-debug-fail" class="eve-dev-btn" type="button">Test fail</button></div>
      <div class="eve-debug-hint">Fake cards and toasts only. These never enter the result log or open a real run.</div></div>
      <div class="eve-dev-group"><label class="eve-dev-row">Toast auto-close
      <input type="number" id="eve-notification-timeout" class="eve-dev-input eve-dev-number" min="0" step="1"> seconds</label>
      <div class="eve-debug-hint">0 keeps the toast until you close it.</div></div>
      <div class="eve-dev-group"><div class="eve-dev-label">Alert log</div>
      <button id="eve-clear-log" type="button" class="eve-dev-btn eve-danger-btn">Clear log</button>
      <div class="eve-debug-hint">Export first. Clearing asks for confirmation.</div></div>`;
    if (IS_LION_RAMSES_PAGE) {
      main.insertAdjacentHTML('beforeend', `<div class="eve-dev-group"><div class="eve-dev-label">Ramses automatic monitoring</div>
        <div id="lion-csv-feedback" class="eve-debug-hint" role="status">Watching live tables and the dashboard's passed-result data.</div>
        <div class="eve-debug-hint">Streamlit refreshes its tables. The tracker checks those updates and reads available passed results in the background.
        If the native refresh component is absent, the tracker reloads this page after one minute with its saved observations.
        Online and PRETEST are separate from completed GPU test outcomes.</div></div>`);
      panel.querySelector('#eve-refresh-interval').title = 'Tracker scan interval; native Streamlit supplies new running data.';
    }
    main.querySelectorAll('.eve-dev-group').forEach(group => group.classList.add('eve-dev-only'));
    panel.querySelector('.eve-bulk-buttons').insertAdjacentHTML('afterend',
      '<button id="lion-rack-open" type="button" class="lion-rack-quick-open"><span>▦ Rack Map</span>' +
      '<small>Click a slot · scan a serial</small><b aria-hidden="true">→</b></button>');
    panel.querySelector('#eve-show-all').textContent = 'Enable all';
    panel.querySelector('#eve-hide-all').textContent = 'Disable all';
    panel.querySelector('#eve-watch-all').style.display = 'none';
    panel.querySelector('#eve-watch-none').style.display = 'none';
    panel.querySelector('.eve-section-head').innerHTML = '<span>SECTION</span>';
    const list = panel.querySelector('#eve-section-list');
    Object.entries(LION_AREAS).forEach(([area, label]) => {
      const row = document.createElement('div');
      row.className = 'eve-section-row';
      row.dataset.section = area;
      row.innerHTML = `<span class="eve-section-label"><span class="lion-section-heading"><span class="eve-section-name">${label}</span>
        <label class="eve-switch" title="Visibility and notifications for ${label}"><input type="checkbox" class="eve-show-checkbox"
        aria-label="Enable ${label} visibility and notifications"></label></span>
        <span class="eve-section-stats">${IS_LION_RAMSES_PAGE ? '<span class="eve-stat eve-stat-pretest"><b>0</b><span>pre</span></span>' : ''}<span class="eve-stat eve-stat-testing"><b>0</b><span>test</span></span>
        ${IS_LION_RAMSES_PAGE ? '<span class="eve-stat eve-stat-pretest-failed"><b>0</b><span>pre fail</span></span>' : ''}
        <span class="eve-stat eve-stat-failed"><b>0</b><span>fail</span></span>
        <span class="eve-stat eve-stat-passed"><b>0</b><span>pass</span></span></span></span>`;
      row.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
        updateLionAreaEnabled(area, input.checked);
      }));
      list.appendChild(row);
    });
    addProfileNavigation(panel);
    panel.querySelector('.eve-profile-navigation')?.classList.add('eve-dev-only');
    document.body.appendChild(panel);
    syncLionKingControls();
    setupTrackerWindowUX(panel);
    wireDeveloperMode();
    wireButton('eve-show-all', () => setLionKingAreas('show', true));
    wireButton('eve-hide-all', () => setLionKingAreas('show', false));
    wireButton('eve-watch-all', () => setLionKingAreas('watch', true));
    wireButton('eve-watch-none', () => setLionKingAreas('watch', false));
    wireButton('lion-debug-pass', () => showLionKingDemo('PASS'));
    wireButton('lion-debug-fail', () => showLionKingDemo('FAIL'));
    wireButton('lion-copy-diagnostics', () => {
      const snapshot = getLionKingSnapshot();
      const report = { version: SCRIPT_VERSION, path: window.location.pathname, readyState: document.readyState,
        matchingTable: !!snapshot, validRows: snapshot ? snapshot.rows.length : 0,
        rejectedRows: snapshot ? snapshot.invalidRows : 0, reasons: snapshot ? snapshot.invalidReasons : {},
        unknownStatuses: snapshot ? snapshot.unknownStatuses : 0,
        savedRows: lionCachedSnapshot ? lionCachedSnapshot.rows.length : 0,
        initialComplete: lionInitialDocumentComplete, refreshInFlight: softRefreshInFlight };
      if (IS_LION_RAMSES_PAGE) {
        const source = ramsesCurrentPassedSource();
        report.passedSource = { matchingLinks: source.matching, visibleLinks: source.visible,
          currentMPYLinks: source.metrics, distinctSources: source.unique,
          selectedScheme: source.selected?.url.protocol || null,
          validatedRuns: ramsesPassed.length, readInFlight: ramsesCSVInFlight, error: ramsesCSVError };
      }
      copyToClipboard(JSON.stringify(report, null, 2), document.getElementById('lion-copy-diagnostics'), 'Copy source diagnostics');
    });
    wireButton('eve-clear-log', clearAlertLog);
    bindSetting('eve-notification-timeout', 'notificationTimeoutSeconds', {
      coerce: raw => Math.max(0, Number(raw) || 0), writeBack: true
    });
    const history = panel.querySelector('#lion-history-hours');
    bindSetting('eve-notification-click', 'notificationClickTarget', {
      coerce: raw => ['jira', 'detail', 'both'].includes(raw) ? raw : 'jira'
    });
    bindSetting('eve-jira-base-url', 'jiraBaseUrl', {
      coerce: raw => {
        const value = String(raw || '').trim().replace(/\/+$/, '');
        return /^https?:\/\/[^\s/]+/i.test(value) ? value : JIRA_DEFAULT_BASE_URL;
      },
      writeBack: true,
      after: () => {
        loadJiraCache().clear(); saveJiraCache(); jiraAuthPausedUntil = 0;
        jiraNeedsLogin = false; jiraConnected = false; refreshJiraOnCards();
      }
    });
    history.value = settings.lionHistoryHours;
    history.addEventListener('change', () => { settings.lionHistoryHours = history.value; saveSettings(); scanLionKing(); });
    const interval = panel.querySelector('#eve-refresh-interval');
    interval.value = String(settings.refreshIntervalSeconds);
    interval.addEventListener('change', () => { settings.refreshIntervalSeconds = coerceRefreshInterval(interval.value);
      saveSettings(); if (!softRefreshInFlight) scheduleLionKingRefresh(); });
    panel.querySelector('#eve-refresh-now').addEventListener('click', refreshLionKing);
    const shift = panel.querySelector('#eve-log-shift');
    shift.addEventListener('change', () => setLogShiftChoice(shift.value));
    updateLogShiftControl();
    panel.querySelector('#lion-area-save').addEventListener('click', () => {
      const serial = panel.querySelector('#lion-area-serial').value.trim().toUpperCase();
      const area = panel.querySelector('#lion-area-choice').value;
      const feedback = panel.querySelector('#lion-area-feedback');
      if (!serial) { feedback.textContent = 'Enter a tail or head node serial.'; return; }
      if (/^TA\./i.test(serial)) {
        feedback.textContent = 'This is a rack barcode. Enter a node serial (TailNode or HeadNode) here; rack-to-node mapping is not set by this control.';
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(LION_AREAS, area)) return;
      if (area === 'unassigned') delete settings.lionAreas[serial];
      else if (Object.keys(settings.lionAreas).length < LION_MAX_RUNS || settings.lionAreas[serial]) {
        settings.lionAreas[serial] = area;
      } else { feedback.textContent = 'Area assignments are full; remove an old assignment first.'; return; }
      const saved = writeJSON(localStorage, SETTINGS_KEY, settings, 'Lion area settings');
      feedback.textContent = saved ? `${serial}: ${LION_AREAS[area]} saved.` : 'Area changed in this tab but could not be saved; check browser storage.';
      refreshLionRackAlertLocations();
      scanLionKing();
    });
    const style = document.createElement('style');
    style.textContent = '.eve-lion-eta{display:block;font-size:11px;font-weight:normal;margin-top:3px}' +
      '#eve-tracker-panel .eve-stat-pretest-failed{background:rgba(185,99,43,.23);color:#f4c7a7}' +
      '.eve-lion-node-link{cursor:pointer}.eve-lion-node-link:focus{outline:2px solid #579dff}' +
      '.eve-profile-navigation{margin:8px 0}.eve-profile-navigation a{color:#9ecaff}' +
      '#lion-summary,#lion-average-pass{margin:8px 0}#eve-tracker-panel p{margin:8px 0}' +
      '#eve-tracker-panel .eve-health-chip{display:inline-block}.eve-health-loading{color:#fbbf24}' +
      '#lion-area-serial{box-sizing:border-box;width:100%;margin:4px 0}' +
      '#eve-section-list .eve-section-label{flex-direction:column;align-items:flex-start;gap:4px}' +
      '#eve-section-list .eve-section-name{white-space:normal}' +
      '#lion-cached-view{margin:12px;padding:12px;border:2px solid #b7791f;background:#fff9e6;color:#222}' +
      '#lion-cached-source,#lion-ramses-passed{border-collapse:collapse;width:100%}' +
      '#lion-cached-source td,#lion-cached-source th,#lion-ramses-passed td,#lion-ramses-passed th{border:1px solid #bbb;padding:4px}' +
      '#lion-ramses-passed-view{margin:12px;padding:12px;background:#fff;color:#222;border:1px solid #bbb}' +
      '.eve-alert-started{color:var(--eve-muted);font-size:11px;margin-bottom:6px}' +
      '#eve-tracker-panel .lion-rack-quick-open{display:grid;grid-template-columns:1fr auto;text-align:left;width:100%;margin:10px 0;padding:12px 14px;border:1px solid #4b80c2;border-radius:10px;background:linear-gradient(115deg,#234771,#285d98);color:#eff6ff;cursor:pointer}' +
      '#eve-tracker-panel .lion-rack-quick-open span{font-size:15px;font-weight:700}#eve-tracker-panel .lion-rack-quick-open small{grid-column:1;font-size:10px;margin-top:5px;color:#bdd9ff}#eve-tracker-panel .lion-rack-quick-open b{grid-column:2;grid-row:1/3;align-self:center;font-size:22px}#eve-tracker-panel .lion-rack-quick-open:hover{filter:brightness(1.12)}';
    document.head.appendChild(style);
    mountLionRackBoard();
    wireButton('lion-rack-open', () => setLionRackView(true));
    getAlertContainer();
    [['TEST_FAILURE', 'Test Fails'], ['PRETEST_FAILURE', 'Pre-test Fails']].forEach(([transition, label]) => {
      const tab = document.querySelector('#eve-alert-filters [data-filter="' + transition + '"]');
      if (tab?.firstChild?.nodeType === 3) tab.firstChild.textContent = label;
    });
    const toggle = document.getElementById('eve-alert-toggle');
    document.getElementById('eve-alert-search').placeholder = 'Search serial, Jira or start time...';
    for (const child of toggle.childNodes) {
      if (child.nodeType === 3 && child.textContent.includes('JIRAlerts')) child.textContent = ' Lion King Alerts ';
    }
    restorePersistedAlerts();
    refreshLionRackAlertLocations();
    showLionKingSnapshotCache();
    window.addEventListener('focus', onJiraWindowFocus);
    scanLionKing();
    document.addEventListener('click', onLionKingNodeClick, true);
    document.addEventListener('auxclick', onLionKingNodeClick, true);
    document.addEventListener('keydown', onLionKingNodeClick, true);
    let scanDebounce = null;
    pageObserver = new MutationObserver(records => {
      if (IS_LION_RAMSES_PAGE) {
        let passedLinkChanged = false;
        records.forEach(record => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (isOwnUiNode(target)) return;
          if (target?.closest('.board-card')) ramsesSourceChanged = true;
          const anchor = target?.closest('a[download]');
          if (ramsesDownloadURL(anchor) || (target?.tagName === 'A' && record.type === 'attributes')) passedLinkChanged = true;
          if (record.type === 'attributes' && [...target.querySelectorAll('a[download]')]
            .some(link => ramsesDownloadURL(link))) passedLinkChanged = true;
          [...record.addedNodes, ...record.removedNodes].forEach(node => {
            if (node.nodeType !== 1 || isOwnUiNode(node)) return;
            if (node.matches('.board-card') || node.querySelector('.board-card')) ramsesSourceChanged = true;
            const links = node.matches('a') ? [node] : [...node.querySelectorAll('a[download]')];
            if (links.some(anchor => ramsesDownloadURL(anchor))) passedLinkChanged = true;
          });
        });
        if (passedLinkChanged) setTimeout(() => pollRamsesPassedCSV(true), OBSERVER_DEBOUNCE_MS);
      }
      if (observerSuppressDepth || records.every(record => isOwnUiNode(record.target) ||
          (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(isOwnUiNode)))) return;
      clearTimeout(scanDebounce);
      scanDebounce = setTimeout(scanLionKing, OBSERVER_DEBOUNCE_MS);
    });
    pageObserver.observe(document.body, { childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: IS_LION_RAMSES_PAGE
        ? ['bgcolor', 'style', 'class', 'href', 'download', 'hidden', 'aria-hidden', 'data-stale'] : ['bgcolor', 'style', 'class'] });
    scheduleLionKingRefresh();
    let tick = 0;
    startTicker(() => {
      tick += 1;
      const now = Date.now();
      if (lastTickAt && now - lastTickAt > SLEEP_GAP_MS && !frozenAt) noteWake('paused', lastTickAt, now, true);
      lastTickAt = now;
      const countdown = !lionInitialDocumentComplete ? 'Loading' : softRefreshInFlight ? 'Loading' :
        `${Math.max(0, Math.ceil((autoRefreshDueAt - now) / 1000))}s`;
      setTextIfChanged(document.getElementById('eve-refresh-badge'), countdown);
      setTextIfChanged(document.getElementById('eve-refresh-mini'), countdown);
      const progress = document.getElementById('eve-refresh-progress-fill');
      if (progress) progress.style.width = (!lionInitialDocumentComplete || softRefreshInFlight ? 0 :
        Math.min(100, Math.max(0, 100 * (1 - (autoRefreshDueAt - now) / (settings.refreshIntervalSeconds * 1000))))) + '%';
      setTextIfChanged(document.getElementById('lion-data-age'), !lionInitialDocumentComplete
        ? lionCachedSnapshot ? `Live source loading. Saved data: ${lionHoursMinutes(now - lionCachedSnapshot.savedAt)} old.`
          : 'Source table is still loading; no completed snapshot yet.'
        : !lionHasCompletedSnapshot ? lionCachedSnapshot ? `No validated live snapshot. Saved data: ${lionHoursMinutes(now - lionCachedSnapshot.savedAt)} old.`
          : 'No validated source snapshot yet.'
        : `Last page update: ${siteDateTime(new Date(rackDataAt))} (${lionHoursMinutes(now - rackDataAt)} ago)`);
      if (tick % 4 === 0) runTickStep('Lion scan', scanLionKing);
      if (tick % 15 === 0) runTickStep('relative times', refreshRelativeTimes);
      if (tick % 60 === 0) runTickStep('log shift', checkLogShiftRollover);
      if (tick % HEARTBEAT_EVERY_TICKS === 0) writeHeartbeat(now);
      if (autoRefreshTimer && autoRefreshDueAt && now > autoRefreshDueAt + 2000) refreshLionKing();
    });
    holdKeepAliveLock();
    holdScreenWakeLock();
    wireSleepDetection();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { holdScreenWakeLock(); scanLionKing(); }
    });
    window.addEventListener('beforeunload', () => { savePreviousStates(); flushAlertLog(true); writeHeartbeat(Date.now()); });
  }

  // ===== BOOTSTRAP =====

  function bootstrap() {
    if (window.location.origin === new URL(LION_RAMSES_URL).origin && !IS_LION_RAMSES_PAGE) return;
    if (window.location.pathname === LION_TESTVIEW_LIST_PATH) {
      const startLionHelper = () => runLionKingTestViewAutoQuery();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startLionHelper);
      else startLionHelper();
      return;
    }
    if (/^\/slt\//.test(window.location.pathname)) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runTestViewAutoQuery);
      } else {
        runTestViewAutoQuery();
      }
      return;
    }
    let earlyObserver = null;
    try {
      if (document.documentElement) {
        stripMetaRefresh(document);
        earlyObserver = new MutationObserver(records => {
          let sawMeta = false;
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType === 1 && (node.tagName === 'META' || node.tagName === 'HEAD')) {
                sawMeta = true;
                break;
              }
            }
            if (sawMeta) {
              break;
            }
          }
          if (!sawMeta) {
            return;
          }
          if (stripMetaRefresh(document.head || document)) {
            console.warn(
              LOG_PREFIX + ' Stripped a page-level meta refresh tag at ' + 'parse time.'
            );
          }
        });
        earlyObserver.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      }
    } catch (error) {
      console.warn(LOG_PREFIX + ' Early meta-refresh guard failed:', error);
    }
    const stopEarlyMetaObserver = () => {
      if (earlyObserver) {
        earlyObserver.disconnect();
        earlyObserver = null;
      }
    };
    if (IS_LION_KING_PAGE) {
      let lionStarted = false;
      let bodyObserver = null;
      const startLionWhenBodyExists = () => {
        if (lionStarted || !document.body) return;
        lionStarted = true;
        if (bodyObserver) {
          bodyObserver.disconnect();
          bodyObserver = null;
        }
        // Show controls during parsing; the scanner waits for the full baseline.
        initializeLionKing();
      };
      const finishInitialLionDocument = () => {
        lionInitialDocumentComplete = true;
        stopEarlyMetaObserver();
        startLionWhenBodyExists();
        scanLionKing();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', finishInitialLionDocument, { once: true });
        if (!document.body) {
          bodyObserver = new MutationObserver(startLionWhenBodyExists);
          bodyObserver.observe(document, { childList: true, subtree: true });
        }
        startLionWhenBodyExists();
      } else {
        finishInitialLionDocument();
      }
      return;
    }
    const start = () => {
      stopEarlyMetaObserver();
      initialize();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
  bootstrap();
})();
