// ==UserScript==
// @name         EVE SLT TRACKER
// @namespace    https://github.com/zayd117/EVE-SLT-TRACKER
// @version      3.1.2
// @description  Monitors EVE SLT racks (on the rack board or the TestView live dashboard) with in-page and desktop completion alerts, a Quick Actions tray on each alert card (Jira, TestView, PuTTY ticket, Send to repair), sends failed units to repair in SFCS from their Jira ticket, and bulk-starts PRETEST on the TestView operator page.
// @author       Zay Davidson
// @homepageURL  https://github.com/zayd117/EVE-SLT-TRACKER
// @supportURL   https://github.com/zayd117/EVE-SLT-TRACKER/issues
// @match        *://*/out/out.eveslt.php*
// @match        *://*/slt/list*
// @match        https://testview-eve-fmt.hyvesolutions.org/slt/operator*
// @match        https://testview-eve-fmt.hyvesolutions.org/live-dashboard/live*
// @match        https://jira.synnex.com/browse/MFGS-*
// @match        https://sfc-fm-p1.hyvesolutions.org/*
// @run-at       document-start
// @noframes
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @connect      jira.synnex.com
// @connect      testview-eve-fmt.hyvesolutions.org
// @connect      sfc-fm-p1.hyvesolutions.org
// @updateURL    https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_TRACKER.user.js
// @downloadURL  https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_TRACKER.user.js
// ==/UserScript==

// EVE SLT TRACKER - by Zay Davidson
// Docs, changelog and design notes: https://github.com/zayd117/EVE-SLT-TRACKER
// Function maps and design notes: docs/CODE_NOTES.md and AGENTS.md.
// Bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues

(function () {
  'use strict';

  // ===== VERSION - single source of truth =====
  const SCRIPT_VERSION =
    typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version
      ? GM_info.script.version
      : '3.1.2';
  const LOG_PREFIX = '[EVE SLT TRACKER]';

  const TRACKER_LABEL = 'EVE SLT TRACKER';

  // ===== STORAGE KEYS =====
  const SETTINGS_KEY = 'eveRackTrackerSettings';
  const PREV_STATES_KEY = 'eveRackTrackerPreviousStates';
  const ACTIVE_ALERTS_KEY = 'eveRackTrackerActiveAlerts';
  const RECENT_ALERTS_KEY = 'eveRackTrackerRecentAlerts';
  const ALERT_LOG_KEY = 'eveRackTrackerAlertLog';
  const LOG_SHIFT_KEY = 'eveRackTrackerAlertLogDay';
  const LOG_AUTO_SHIFT_KEY = 'eveRackTrackerAutoShift';
  const LOG_CLEARED_KEY = 'eveRackTrackerAlertLogClearedAt';
  const ALERTS_COLLAPSED_KEY = 'eveRackTrackerAlertsCollapsed';
  const PANEL_POSITION_KEY = 'eveRackTrackerPanelPosition';
  const DEBUG_SNAPSHOT_KEY = 'eveRackTrackerDebugSnapshot';
  const ALERT_PANEL_POSITION_KEY = 'eveRackTrackerAlertPanelPosition';
  const JIRA_CACHE_KEY = 'eveRackTrackerJiraCache';
  const JIRA_ATTENTION_KEY = 'eveRackTrackerJiraAttention';
  const HEARTBEAT_KEY = 'eveRackTrackerHeartbeat';
  const EVENT_CLAIMS_KEY = 'eveRackTrackerEventClaims';

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
  // Each panel's own - / + size, in percent (see PANEL SIZE).
  const PANEL_SIZE_MIN = 50;
  const PANEL_SIZE_MAX = 100;
  const PANEL_SIZE_STEP = 10;
  const PANEL_SIZE_DEFAULT = 70;
  // Saved sizes from before 3.0.1 (60-150%, default 100%) are reset to the new
  // default once: settings.sizeRev below marks a save that has been through it.
  const PANEL_SIZE_REV = 1;

  // ===== TUNABLES =====
  const SHIFTS = {
    day: { label: 'Day', start: '06:00', end: '14:30' },
    swing: { label: 'Swing', start: '15:30', end: '00:15' },
    graveyard: { label: 'Graveyard', start: '22:00', end: '06:30' }
  };
  const SHIFT_EARLY_MIN = 60;
  const SHIFT_LATE_MIN = 60;
  const MAX_LOG_ENTRIES = 2000;
  const MAX_STORED_ALERTS = 500;
  const MAX_RENDERED_ALERTS = 500;
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
  const DEFAULT_REFRESH_SECONDS = 10;

  // ===== SETTINGS =====
  const defaultSettings = {
    sections: {},
    refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
    notificationTimeoutSeconds: 0,
    developerMode: false,
    jiraBaseUrl: 'https://jira.synnex.com',
    notificationClickTarget: 'jira',
    logShiftChoice: 'auto',
    logShiftOverrideFor: '',
    alertSize: PANEL_SIZE_DEFAULT,
    trackerSize: PANEL_SIZE_DEFAULT,
    sizeRev: PANEL_SIZE_REV
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
      `EVE SLT TRACKER ${state}`,
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
  const TESTVIEW_OPERATOR_URL = 'https://testview-eve-fmt.hyvesolutions.org/slt/operator';
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

  // ===== TESTVIEW LIVE DASHBOARD =====
  // The dashboard shows the racks as cards instead of a table. There the tracker
  // turns every card into a slot of a hidden copy of the board (one table per
  // rack), so scanning, alerts, the ETA and the Show/Notifs switches work as on
  // the board, and Show hides the dashboard's own rack boxes. Never reloaded.
  // Settings and the shift log stay in each site's own storage; with both open,
  // each event is recorded and toasted once (SHARED COORDINATION).
  const BOARD_COPY_ID = 'eve-board-copy';
  const ON_LIVE_DASHBOARD =
    window.location.origin === new URL(TESTVIEW_LIST_URL).origin &&
    /^\/live-dashboard\//.test(window.location.pathname);

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
      showTestViewBanner(`EVE SLT TRACKER: typed SN ${serial} but the list did not filter. Press Query.`);
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
    const hit = testViewStatusCache.get(serial);
    return hit && /^\d+$/.test(hit.id || '')
      ? `${new URL(TESTVIEW_LIST_URL).origin}${TESTVIEW_DETAIL_PATH}${hit.id}`
      : '';
  }

  function testViewRunningCached(serial) {
    const hit = testViewStatusCache.get(serial);
    return hit ? hit.running : null;
  }

  function testViewRunning(serial) {
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
          showTestViewBanner(`EVE SLT TRACKER: could not auto-fill SN ${serial}. Enter it manually.`);
        }
        return;
      }
      finish();
      submitTestViewQuery(input, serial).catch(error => {
        console.error(LOG_PREFIX + ' TestView: auto-query crashed:', error);
        showTestViewBanner(`EVE SLT TRACKER: auto-query failed (${error && error.message}). Press Query.`);
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
    if (record.manual) {
      return 0; // the real failure time is unknown: newest ticket for the serial, no create-one prompt
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
    return id && failedAt ? `${id}@${failedAt}` : id;
  }

  function jiraOrderedJql(serial, failedAt) {
    if (!failedAt) {
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
    return jiraListUrl(serial, failedAt ? 'created' : 'updated', jiraLatestKey(serial));
  }

  function jiraIssueUrl(key) {
    return `${jiraBaseUrl()}/browse/${encodeURIComponent(key)}`;
  }

  function jiraFoundUrl(serial, failedAt) {
    const hit = jiraCached(serial, failedAt);
    if (!hit || hit.state !== 'found' || !JIRA_KEY_PATTERN.test(String(hit.key))) return '';
    return jiraIssueUrl(hit.key);
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
    if (failedAt && hit && hit.state === 'none') {
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
      // Jira's own limit: the whole title, for the titled-link copy.
      summary: String(fields.summary || '').slice(0, 255),
      created: String(fields.created || '').slice(0, 40),
      count: Math.max(Number(data.total) || 0, issues.length)
    };
  }

  function requestJira(serial, failedAt) {
    return new Promise(resolve => {
      const done = result => resolve({ ...result, at: Date.now(), failure: !!failedAt });
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

  // The ticket link sits on the status row; a state with no ticket to open
  // (pending, none yet, passed) is the bottom-right chip of the card instead.
  function paintJiraButton(button, serial, result, loading) {
    paintJiraButtonIn(button, serial, result, loading);
    const group = button.closest('.eve-jira-group');
    const alert = group ? group.closest('.eve-alert') : null;
    if (!alert) {
      return;
    }
    const host = alert.querySelector(':scope > .eve-alert-footer');
    if (host && group.parentNode !== host) {
      host.appendChild(group);
    }
  }

  function paintJiraButtonIn(button, serial, result, loading) {
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
        '\nClick to open in Jira';
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
      // Pre-test fails always may; a test fail once it is past the wait for the bot.
      const createByHand = pretest || !failedAt || Date.now() - failedAt >= JIRA_CREATE_BY_HAND_MS;
      text = createByHand && testRunning ? 'No ticket (re-testing)' : 'No ticket';
      if (createByHand && !testRunning && !jiraAttentionSeen(serial, failedAt, 'attn')) {
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
  // A loading repaint carries the cached result, so a ticket already known
  // stays known while it re-checks: the copy control, the Send to repair row
  // (and an armed Confirm in it) and the reply badge no longer blink out.
  function syncJiraExtras(button, result, loading) {
    const found =
      !!result && result.state === 'found' && JIRA_KEY_PATTERN.test(String(result.key));
    const copy = button.parentElement
      ? button.parentElement.querySelector('.eve-jira-copy')
      : null;
    if (copy) {
      copy.hidden = !found;
      const summary = found ? String(result.summary || '') : '';
      if (found && (copy.dataset.key !== result.key || copy.dataset.summary !== summary)) {
        copy.dataset.key = result.key;
        copy.dataset.summary = summary;
        copy.title =
          `Copy as a titled link: [${result.key}] ` + (summary || button.dataset.serial || '');
        copy.setAttribute('aria-label', `Copy a titled link to Jira ticket ${result.key}`);
      }
    }
    if (!loading && result && JIRA_PENDING_STATES.indexOf(result.state) !== -1) {
      button.dataset.wasPending = '1';
    }
    const serial = button.dataset.serial || '';
    const failedAt = Number(button.dataset.failedAt) || 0;
    // Send to repair: SLT failures with a ticket only (it reads the SLT title format).
    const card = button.closest('.eve-alert');
    const repair = card ? card.querySelector('.jstr-card') : null;
    if (repair) {
      repairTool.syncCard(repair, found && failedAt > 0);
    }
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

  // Ticket for a card's Send to repair box: the cached Jira result of this
  // failure (key and title), or null while there is none.
  function repairTicketFor(card, serial) {
    const button = card.querySelector('.eve-alert-jira');
    const hit = jiraCached(serial, button ? Number(button.dataset.failedAt) || 0 : 0);
    if (!hit || hit.state !== 'found' || !JIRA_KEY_PATTERN.test(String(hit.key))) {
      return null;
    }
    return { key: hit.key, link: jiraIssueUrl(hit.key), summary: hit.summary || '', serial: serial,
      failedAt: button ? Number(button.dataset.failedAt) || 0 : 0 };
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
  // ticket as a titled link (copyJiraLink) and stays hidden until the chip
  // shows a real ticket (syncJiraExtras).
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
      if (copy.dataset.key) {
        // A bare check, so the chip keeps its width and the card row does not move.
        copyJiraLink(copy.dataset.key, copy.dataset.summary, serial).then(kind =>
          showCopyHint(copy, !!kind, JIRA_COPY_IDLE, '\u{2713}')
        );
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
    '.eve-putty-note{margin-top:8px;color:#b9c0c9;font-size:13px;}' +
    '.eve-putty-note:empty{display:none;}' +
    '.eve-howto .eve-putty-note button,.eve-howto-plain .eve-putty-note button{margin-left:6px;padding:0;border:0;' +
    'background:none;color:#7f9cc4;font:inherit;text-decoration:underline;cursor:pointer;}' +
    '.eve-putty-note .eve-putty-again{margin-left:0;font-size:12px;color:#6b7078;}' +
    '.eve-howto button{font:600 12px Segoe UI,Arial,sans-serif;color:#fde68a;cursor:pointer;' +
    'background:rgba(250,204,21,.15);border:1px solid rgba(250,204,21,.5);border-radius:6px;padding:4px 10px;}' +
    '@media (prefers-reduced-motion:reduce){' +
    '.eve-opt,.eve-opt-label,.eve-opt-note{transition:none;}' +
    '.eve-opt:active{transform:none;}}';

  // ===== PASTE INTO PUTTY / MOBAXTERM (Windows helper) =====
  // A web page cannot reach desktop programs, so a small helper does it. The
  // one-time setup file below (built from this script, current Windows user
  // only, no admin) registers eve-putty: links that run a PowerShell script.
  // That script accepts only "ticket <serial>", brings the front-most open
  // PuTTY / MobaXterm session forward (restoring it if minimized), checks it
  // really is in front, puts the command on the clipboard, then clicks in the
  // terminal and right-clicks there to paste (how PuTTY and MobaXterm paste) and
  // puts the mouse pointer back, WITHOUT pressing Enter. No session, a closed
  // one, a dialog, a window that will not come forward or a covered terminal:
  // it pastes nothing and says why; the command stays on the clipboard.
  const PUTTY_SCHEME = 'eve-putty';
  const PUTTY_HELPER_KEY = 'evePuttyPasteHelper';
  // Bump with every change to PUTTY_HELPER_PS1: PCs with an older copy are asked to run setup again.
  const PUTTY_HELPER_VERSION = '5';
  const PUTTY_SETUP_NAME = 'EVE-PuTTY-paste-setup.cmd';
  const PUTTY_COMMAND_RE = /^ticket ([A-Za-z0-9]{6,20})$/;
  const PUTTY_SETUP_CMD = String.raw`@echo off
rem EVE SLT TRACKER - one-time setup for "Paste into PuTTY".
rem For this Windows user only; no admin needed. To remove it: run this file with /uninstall
setlocal
set "EVE_DIR=%LOCALAPPDATA%\EveTracker"
set "EVE_KEY=HKCU\Software\Classes\eve-putty"
set "EVE_SELF=%~f0"
if /i "%~1"=="/uninstall" goto uninstall
if not exist "%EVE_DIR%" mkdir "%EVE_DIR%"
if not exist "%EVE_DIR%" goto failed
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText($env:EVE_SELF); $m = '#EVE-PS1' + '-START#'; $i = $t.LastIndexOf($m); if ($i -lt 0) { exit 1 }; [IO.File]::WriteAllText((Join-Path $env:EVE_DIR 'eve-putty.ps1'), $t.Substring($i + $m.Length).TrimStart())"
if errorlevel 1 goto failed
reg add "%EVE_KEY%" /ve /d "URL:EVE tracker paste into PuTTY" /f >nul
if errorlevel 1 goto failed
reg add "%EVE_KEY%" /v "URL Protocol" /d "" /f >nul
if errorlevel 1 goto failed
reg add "%EVE_KEY%\shell\open\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%EVE_DIR%\eve-putty.ps1\" \"%%1\"" /f >nul
if errorlevel 1 goto failed
echo.
echo Done. "Paste into PuTTY" is set up for %USERNAME%.
echo Go back to the tracker tab and click "Done, it's installed".
echo.
pause
exit /b 0
:uninstall
reg delete "%EVE_KEY%" /f >nul 2>&1
del "%EVE_DIR%\eve-putty.ps1" >nul 2>&1
echo Removed "Paste into PuTTY" for %USERNAME%.
pause
exit /b 0
:failed
echo.
echo Setup did not finish. If scripts are blocked on this PC, ask your team lead.
pause
exit /b 1
#EVE-PS1-START#
`;
  const PUTTY_HELPER_PS1 = String.raw`# EVE SLT TRACKER - pastes "ticket <serial>" into your open PuTTY or MobaXterm session.
# The browser starts it for eve-putty:ticket/<SERIAL> links. It puts the command on the
# clipboard, then clicks in the terminal and right-clicks there (how PuTTY and MobaXterm
# paste), as you would by hand; the mouse pointer goes back where it was. It never presses Enter.
# Helper version 5.
param([string]$Link = '')
$ErrorActionPreference = 'Stop'
$Title = 'EVE tracker - Paste into PuTTY'
$NL = [Environment]::NewLine
$LogFile = Join-Path $env:LOCALAPPDATA 'EveTracker\eve-putty.log'

function Write-Note([string]$Text) {
  try { Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format s) + ' ' + $Text) } catch { }
}

# Keep the log small.
try {
  if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 1MB) {
    Remove-Item -LiteralPath $LogFile -Force
  }
} catch { }

# A message on top of every window (this script has no window of its own).
function Show-Message([string]$Text, [string]$Icon = 'Information', [string]$Buttons = 'OK') {
  Write-Note $Text
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    try {
      return [string][System.Windows.Forms.MessageBox]::Show($owner, $Text, $Title, $Buttons, $Icon)
    } finally {
      $owner.Dispose()
    }
  } catch {
    return 'Cancel'
  }
}

# Only "ticket <serial>" (letters and digits): a web page cannot make this paste anything else.
if ($Link -match '^eve-putty:(?://)?ticket/([A-Za-z0-9]{6,20})/?$') {
  $Command = 'ticket ' + $Matches[1].ToUpperInvariant()
} else {
  Write-Note ('ignored link: ' + $Link)
  exit 1
}

# One paste at a time: a double click must not paste the command twice.
$Mutex = New-Object System.Threading.Mutex($false, 'Local\EveTrackerPuttyPaste')
$Owned = $false
try { $Owned = $Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $Owned = $true }
if (-not $Owned) { exit 0 }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class EveWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus;
    public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;
  }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  // Real screen pixels on scaled displays, so clicks land where they are aimed.
  public static string MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { return "per-monitor"; } } catch (EntryPointNotFoundException) { }
    try { if (SetProcessDPIAware()) { return "system"; } } catch (EntryPointNotFoundException) { }
    return "unchanged";
  }

  // Every visible top-level window (owned ones too), front-most first.
  public static List<IntPtr> TopLevel() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (IsWindowVisible(h)) { found.Add(h); }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // The visible windows directly inside h, front-most first.
  public static List<IntPtr> ChildrenOf(IntPtr h) {
    List<IntPtr> found = new List<IntPtr>();
    for (IntPtr c = GetWindow(h, 5); c != IntPtr.Zero; c = GetWindow(c, 2)) {
      if (IsWindowVisible(c)) { found.Add(c); }
    }
    return found;
  }
  public static IntPtr OwnerOf(IntPtr h) { return GetWindow(h, 4); }
  public static string Text(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string ClassOf(IntPtr h) { StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static uint ProcessOf(IntPtr h) { uint id; GetWindowThreadProcessId(h, out id); return id; }
  public static long Area(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) { return 0; }
    return (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
  }
  public static long ClientArea(IntPtr h) {
    RECT r;
    if (!GetClientRect(h, out r)) { return 0; }
    return (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
  }
  public static string SizeOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) { return "?"; }
    return (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " at " + r.Left + "," + r.Top;
  }

  // The control that has the keyboard focus in that window's program, or zero.
  public static IntPtr FocusOf(IntPtr top) {
    uint id;
    uint thread = GetWindowThreadProcessId(top, out id);
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    return GetGUIThreadInfo(thread, ref info) ? info.hwndFocus : IntPtr.Zero;
  }

  // The windows inside "top", one line each (class and size only), for the log.
  public static string Tree(IntPtr top, int maxLines) {
    StringBuilder sb = new StringBuilder();
    int lines = 0;
    AddTree(top, 1, sb, ref lines, maxLines);
    return sb.ToString();
  }
  static void AddTree(IntPtr h, int depth, StringBuilder sb, ref int lines, int maxLines) {
    foreach (IntPtr c in ChildrenOf(h)) {
      if (lines >= maxLines || depth > 12) { return; }
      sb.Append(new string(' ', depth * 2)).Append(ClassOf(c)).Append(' ').Append(SizeOf(c)).Append(Environment.NewLine);
      lines++;
      AddTree(c, depth + 1, sb, ref lines, maxLines);
    }
  }

  // The terminal of a window: follow its biggest visible child for as long as that
  // child fills at least 40% of its parent (menus, side panel, tabs and the status
  // bar are smaller). A terminal's own scroll bar is small, so it stops there.
  public static IntPtr MainContent(IntPtr top) {
    IntPtr at = top;
    for (int depth = 0; depth < 15; depth++) {
      long room = ClientArea(at);
      RECT outer;
      if (room <= 0 || !GetWindowRect(at, out outer)) { break; }
      IntPtr best = IntPtr.Zero;
      long bestArea = 0;
      foreach (IntPtr c in ChildrenOf(at)) {
        RECT r;
        if (!GetWindowRect(c, out r)) { continue; }
        // Skip windows parked outside their parent (hidden tabs).
        int cx = (r.Left + r.Right) / 2, cy = (r.Top + r.Bottom) / 2;
        if (cx < outer.Left || cx > outer.Right || cy < outer.Top || cy > outer.Bottom) { continue; }
        long a = (long)Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
        if (a > bestArea) { best = c; bestArea = a; }
      }
      if (best == IntPtr.Zero || bestArea * 10 < room * 4) { break; }
      at = best;
    }
    return at;
  }

  // A screen point inside h where h itself is the window under the mouse (not
  // covered by another window or one of its own small parts), or null.
  public static int[] ClickPoint(IntPtr h) {
    RECT r;
    if (!GetClientRect(h, out r)) { return null; }
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w < 40 || ht < 40) { return null; }
    double[] xs = { 0.5, 0.5, 0.3, 0.7, 0.5 };
    double[] ys = { 0.5, 0.7, 0.5, 0.5, 0.3 };
    for (int i = 0; i < xs.Length; i++) {
      POINT p = new POINT();
      p.X = (int)(w * xs[i]);
      p.Y = (int)(ht * ys[i]);
      if (!ClientToScreen(h, ref p)) { return null; }
      if (WindowFromPoint(p) == h) { return new int[] { p.X, p.Y }; }
    }
    return null;
  }

  // Shift, Ctrl, Alt, a Windows key or a mouse button held down would change what a click does.
  public static bool KeysHeld() {
    int[] keys = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02, 0x04 };
    foreach (int k in keys) {
      if ((GetAsyncKeyState(k) & 0x8000) != 0) { return true; }
    }
    return false;
  }

  // Moves the pointer to (x, y) and checks that "top" is still in front and the
  // terminal is still the window under the pointer.
  static bool Aim(IntPtr top, IntPtr term, int x, int y) {
    if (!SetCursorPos(x, y)) { return false; }
    Thread.Sleep(40);
    POINT p = new POINT();
    p.X = x;
    p.Y = y;
    return GetForegroundWindow() == top && WindowFromPoint(p) == term;
  }

  // A click in the terminal (puts the cursor there) and then a right-click (pastes),
  // with real mouse input, exactly as by hand; then the pointer goes back where it
  // was. Before each click it checks that nothing moved. "" when done, else why not.
  public static string ClickAndPaste(IntPtr top, IntPtr term, int x, int y) {
    POINT back;
    bool haveBack = GetCursorPos(out back);
    // With the mouse buttons swapped (left-handed), Windows swaps these too.
    bool swapped = GetSystemMetrics(23) != 0;
    uint leftDown = swapped ? 0x0008u : 0x0002u, leftUp = swapped ? 0x0010u : 0x0004u;
    uint rightDown = swapped ? 0x0002u : 0x0008u, rightUp = swapped ? 0x0004u : 0x0010u;
    try {
      if (!Aim(top, term, x, y)) { return "moved"; }
      mouse_event(leftDown, 0, 0, 0, UIntPtr.Zero);
      mouse_event(leftUp, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(250);
      if (!Aim(top, term, x, y)) { return "moved"; }
      mouse_event(rightDown, 0, 0, 0, UIntPtr.Zero);
      mouse_event(rightUp, 0, 0, 0, UIntPtr.Zero);
      Thread.Sleep(200);
      return "";
    } finally {
      if (haveBack) { SetCursorPos(back.X, back.Y); }
    }
  }
}
'@
  Write-Note ('helper 5, screen scaling: ' + [EveWin]::MakeDpiAware())

  # The clipboard must hold exactly the command: no line break, so a paste never presses Enter.
  function Test-Clipboard {
    try { return ([System.Windows.Forms.Clipboard]::GetText() -ceq $Command) } catch { return $false }
  }
  $Copied = $false
  for ($try = 0; $try -lt 5 -and -not $Copied; $try++) {
    if ($try -gt 0) { Start-Sleep -Milliseconds 150 }
    try { [System.Windows.Forms.Clipboard]::SetText($Command) } catch { Write-Note ('clipboard busy: ' + $_.Exception.Message) }
    $Copied = Test-Clipboard
  }
  if (-not $Copied) {
    [void](Show-Message ('Could not put "' + $Command + '" on the clipboard (another program is using it), so nothing was pasted.' + $NL + 'Click Paste again.') 'Warning')
    exit 2
  }
  $Fallback = 'The command "' + $Command + '" is on your clipboard.'
  $Details = 'Details were written to ' + $LogFile
  $BoxPattern = 'Edit|Combo|Tree|List|Memo|Button|Grid|VirtualString'

  # PuTTY / KiTTY sessions and MobaXterm (installed or portable).
  $Apps = @{}
  foreach ($p in Get-Process) {
    if ($p.ProcessName -match '^(putty|kitty)$' -or $p.ProcessName -match '^MobaXterm') {
      $Apps[[uint32]$p.Id] = $p.ProcessName
    }
  }

  # Every visible window, front-most first. MobaXterm (a Delphi program) has
  # its main window owned by a hidden application window, so owned windows count.
  $Windows = [EveWin]::TopLevel()
  $Seen = [System.Collections.Generic.List[string]]::new()
  foreach ($h in $Windows) {
    $procId = [EveWin]::ProcessOf($h)
    if ($Apps.ContainsKey($procId)) {
      $owner = [EveWin]::OwnerOf($h)
      $ownerClass = 'none'
      if ($owner -ne [IntPtr]::Zero) { $ownerClass = [EveWin]::ClassOf($owner) }
      $Seen.Add($Apps[$procId] + ' pid=' + $procId + ' class=' + [EveWin]::ClassOf($h) + ' owner=' + $ownerClass +
        ' area=' + [EveWin]::Area($h) + ' minimized=' + [EveWin]::IsIconic($h) + ' enabled=' + [EveWin]::IsWindowEnabled($h) +
        ' title="' + [EveWin]::Text($h) + '"')
    }
  }

  # The MobaXterm main window (TMobaXtermForm), even when minimized. Other
  # versions: its biggest titled window that is not a dialog or the hidden
  # application window.
  function Get-MobaMain([uint32]$ProcId) {
    $best = [IntPtr]::Zero
    $bestArea = 0
    foreach ($w in $Windows) {
      if ([EveWin]::ProcessOf($w) -ne $ProcId) { continue }
      $c = [EveWin]::ClassOf($w)
      if ($c -eq 'TMobaXtermForm') { return $w }
      if ($c -eq '#32770' -or $c -eq 'TApplication' -or [EveWin]::Text($w) -eq '') { continue }
      $area = [EveWin]::Area($w)
      if ([EveWin]::IsIconic($w)) { $area = 40000 }
      if ($area -gt $bestArea) {
        $best = $w
        $bestArea = $area
      }
    }
    if ($bestArea -lt 40000) { return [IntPtr]::Zero }
    return $best
  }

  # The front-most PuTTY terminal or MobaXterm main window.
  $Target = [IntPtr]::Zero
  $TargetIsPutty = $false
  foreach ($h in $Windows) {
    $procId = [EveWin]::ProcessOf($h)
    if (-not $Apps.ContainsKey($procId)) { continue }
    if ($Apps[$procId] -match '^(putty|kitty)$') {
      # Terminal windows only (not the settings box, event log or alerts), and not a closed session.
      $class = [EveWin]::ClassOf($h)
      if (($class -eq 'PuTTY' -or $class -eq 'KiTTY') -and [EveWin]::Text($h) -notmatch '\(inactive\)') {
        $Target = $h
        $TargetIsPutty = $true
        break
      }
    } else {
      $Target = Get-MobaMain $procId
      if ($Target -ne [IntPtr]::Zero) { break }
    }
  }

  if ($Target -eq [IntPtr]::Zero) {
    Write-Note ('windows seen:' + $NL + ($Seen -join $NL))
    [void](Show-Message ('No open PuTTY or MobaXterm session window was found, so nothing was pasted.' + $NL + 'Open your session and log in, then click Paste again.' + $NL + $NL + $Fallback + $NL + $NL + $Details) 'Warning')
    exit 3
  }
  $TargetTitle = [EveWin]::Text($Target)
  if (-not $TargetIsPutty -and $TargetTitle -match '^MobaXterm') {
    Write-Note ('windows seen:' + $NL + ($Seen -join $NL))
    [void](Show-Message ('MobaXterm has no session tab in front ("' + $TargetTitle + '"), so nothing was pasted.' + $NL + 'Click your session tab, then click Paste again.' + $NL + $NL + $Fallback + $NL + $NL + $Details) 'Warning')
    exit 3
  }
  if (-not [EveWin]::IsWindowEnabled($Target)) {
    [void](Show-Message ('"' + $TargetTitle + '" has a dialog open, so nothing was pasted.' + $NL + 'Close that dialog, then click Paste again.' + $NL + $NL + $Fallback) 'Warning')
    exit 3
  }

  # PuTTY keeps "host - PuTTY" as its title until the server sets one after log-in.
  if ($TargetIsPutty -and $TargetTitle -match ' - (PuTTY|KiTTY)$') {
    $answer = Show-Message ('This PuTTY window may not be logged in yet:' + $NL + '"' + $TargetTitle + '"' + $NL + $NL + 'Paste "' + $Command + '" into it anyway? Enter is not pressed.') 'Question' 'YesNo'
    if ($answer -ne 'Yes') {
      Write-Note 'not logged in? the user said no'
      exit 4
    }
  }

  # Minimized: restore it the way its taskbar button does, then let it lay out.
  if ([EveWin]::IsIconic($Target)) {
    [void][EveWin]::PostMessage($Target, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero)
    for ($wait = 0; $wait -lt 15 -and [EveWin]::IsIconic($Target); $wait++) { Start-Sleep -Milliseconds 100 }
    if ([EveWin]::IsIconic($Target)) {
      [void][EveWin]::ShowWindow($Target, 9)
      Start-Sleep -Milliseconds 300
    }
    if ([EveWin]::IsIconic($Target)) {
      [void](Show-Message ('Could not restore the minimized "' + $TargetTitle + '", so nothing was pasted.' + $NL + $NL + $Fallback) 'Warning')
      exit 5
    }
    Start-Sleep -Milliseconds 400
  }

  $Front = $false
  for ($try = 0; $try -lt 3 -and -not $Front; $try++) {
    if ($try -gt 0) {
      # Windows lets a background program take the focus right after a key press: tap Alt.
      [EveWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [EveWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    }
    [void][EveWin]::SetForegroundWindow($Target)
    Start-Sleep -Milliseconds 250
    $Front = ([EveWin]::GetForegroundWindow() -eq $Target)
  }
  if (-not $Front) {
    [void](Show-Message ('Could not bring "' + $TargetTitle + '" to the front, so nothing was pasted.' + $NL + $NL + $Fallback) 'Warning')
    exit 5
  }

  # The terminal itself: a PuTTY window is its own terminal; in MobaXterm it is the
  # biggest part of the window (the keyboard focus can sit in a side list instead).
  if ($TargetIsPutty) {
    $Term = $Target
  } else {
    Write-Note ('"' + $TargetTitle + '" is made of:' + $NL + [EveWin]::Tree($Target, 60))
    $Term = [EveWin]::MainContent($Target)
  }
  $TermClass = [EveWin]::ClassOf($Term)
  $FocusClass = ''
  $Focus = [EveWin]::FocusOf($Target)
  if ($Focus -ne [IntPtr]::Zero) { $FocusClass = [EveWin]::ClassOf($Focus) }
  Write-Note ('target "' + $TargetTitle + '": terminal class=' + $TermClass + ' ' + [EveWin]::SizeOf($Term) + ', keyboard focus class=' + $FocusClass)
  $TooSmall = ([EveWin]::ClientArea($Term) * 5) -lt [EveWin]::ClientArea($Target)
  if ((-not $TargetIsPutty -and $Term -eq $Target) -or $TermClass -match $BoxPattern -or $TooSmall) {
    [void](Show-Message ('Could not find the terminal in "' + $TargetTitle + '", so nothing was pasted.' + $NL + $NL + $Fallback + $NL + $NL + $Details) 'Warning')
    exit 7
  }
  $Point = [EveWin]::ClickPoint($Term)
  if ($null -eq $Point) {
    [void](Show-Message ('The terminal in "' + $TargetTitle + '" is covered by another window, so nothing was pasted.' + $NL + $NL + $Fallback + $NL + $NL + $Details) 'Warning')
    exit 7
  }

  # Wait for keys and mouse buttons to be let go (Ctrl + right-click opens a menu instead).
  for ($wait = 0; $wait -lt 30 -and [EveWin]::KeysHeld(); $wait++) { Start-Sleep -Milliseconds 100 }
  if ([EveWin]::KeysHeld()) {
    [void](Show-Message ('A key or mouse button is held down, so nothing was pasted.' + $NL + 'Let go of it, then click Paste again.' + $NL + $NL + $Fallback) 'Warning')
    exit 6
  }
  # Another program may have changed the clipboard in the meantime.
  if (-not (Test-Clipboard)) {
    [void](Show-Message ('The clipboard changed before pasting, so nothing was pasted.' + $NL + 'Click Paste again.') 'Warning')
    exit 8
  }

  $Result = [EveWin]::ClickAndPaste($Target, $Term, $Point[0], $Point[1])
  if ($Result -ne '') {
    [void](Show-Message ('Another window got in the way of "' + $TargetTitle + '", so nothing was pasted.' + $NL + 'Click Paste again.' + $NL + $NL + $Fallback) 'Warning')
    exit 6
  }
  $FocusClass = ''
  $Focus = [EveWin]::FocusOf($Target)
  if ($Focus -ne [IntPtr]::Zero) { $FocusClass = [EveWin]::ClassOf($Focus) }
  Write-Note ('pasted "' + $Command + '" into "' + $TargetTitle + '" at ' + $Point[0] + ',' + $Point[1] + '; keyboard focus now class=' + $FocusClass)
} catch {
  [void](Show-Message ('Paste into PuTTY failed: ' + $_.Exception.Message + $NL + $NL + 'Copy the command from the tracker and paste it by hand.') 'Error')
  exit 9
} finally {
  if ($Owned) { try { $Mutex.ReleaseMutex() } catch { } }
  $Mutex.Dispose()
}
`;

  // 'ready', 'old' (an earlier helper version is installed) or 'none'.
  function puttyHelperState() {
    let saved = '';
    try {
      saved = typeof GM_getValue === 'function' ? String(GM_getValue(PUTTY_HELPER_KEY, '') || '') : '';
    } catch (error) {
      saved = '';
    }
    if (saved === `installed-${PUTTY_HELPER_VERSION}`) {
      return 'ready';
    }
    return /^installed/.test(saved) ? 'old' : 'none';
  }

  function setPuttyHelperReady(ready) {
    try {
      GM_setValue(PUTTY_HELPER_KEY, ready ? `installed-${PUTTY_HELPER_VERSION}` : '');
    } catch (error) {}
  }

  // The setup file: installer, then the helper script it copies out of itself.
  function downloadPuttySetup(doc) {
    const text = (PUTTY_SETUP_CMD + PUTTY_HELPER_PS1).replace(/\r?\n/g, '\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const link = doc.createElement('a');
    link.href = url;
    link.download = PUTTY_SETUP_NAME;
    withoutObserver(() => {
      doc.body.appendChild(link);
      link.click();
      link.remove();
    });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Hands "ticket <serial>" to the helper through an eve-putty: link; the
  // helper pastes it and never presses Enter. Used by the Jira tab and the
  // card's Quick Actions tray (where the link must not wake the rack scan).
  function pastePuttyCommand(doc, serial) {
    const link = doc.createElement('a');
    link.href = `${PUTTY_SCHEME}:ticket/${String(serial).toUpperCase()}`;
    withoutObserver(() => {
      doc.body.appendChild(link);
      link.click();
      link.remove();
    });
  }

  // "Paste into PuTTY" next to Copy on a "ticket <serial>" instruction. Until
  // this PC has the helper, the button offers the one-time setup instead (an
  // eve-putty: link with no helper would only bring up a Windows error).
  function appendPuttyPaste(doc, row, box, command) {
    const match = PUTTY_COMMAND_RE.exec(String(command || ''));
    if (!match) {
      return;
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'eve-putty-paste';
    const note = doc.createElement('div');
    note.className = 'eve-putty-note';
    note.setAttribute('role', 'status');
    row.appendChild(button);
    box.appendChild(note);
    let noteTimer = 0;
    const offerSetup = () => {
      downloadPuttySetup(doc);
      note.textContent = `Run the downloaded ${PUTTY_SETUP_NAME} once (if Windows warns, choose Keep, then More info and Run anyway), then `;
      const done = doc.createElement('button');
      done.type = 'button';
      done.textContent = 'Done, it\'s installed';
      done.addEventListener('click', () => {
        setPuttyHelperReady(true);
        show();
        button.focus();
      });
      note.appendChild(done);
    };
    const show = () => {
      clearTimeout(noteTimer);
      note.textContent = '';
      const state = puttyHelperState();
      if (state === 'ready') {
        button.textContent = 'Paste into PuTTY';
        button.title = 'Pastes this command into your open, logged-in PuTTY or MobaXterm session for you (it clicks in the terminal and right-click pastes, then puts your mouse back). It does not press Enter.';
        const again = doc.createElement('button');
        again.type = 'button';
        again.className = 'eve-putty-again';
        again.textContent = 'Paste not working? Set it up again';
        again.addEventListener('click', offerSetup);
        note.appendChild(again);
      } else if (state === 'old') {
        button.textContent = 'Update Paste into PuTTY';
        button.title = 'This PC has an older Paste into PuTTY helper: run the new setup file once (no admin)';
      } else {
        button.textContent = 'Set up Paste into PuTTY';
        button.title = 'One-time setup on this PC (no admin) so a button can paste this command into PuTTY or MobaXterm';
      }
    };
    button.addEventListener('click', () => {
      if (puttyHelperState() !== 'ready') {
        offerSetup();
        return;
      }
      pastePuttyCommand(doc, match[1]);
      note.textContent = 'Pasting into your PuTTY / MobaXterm session (if the browser asks, choose Open). Check the command there, then press Enter. ' +
        'If it cannot paste, a message says why.';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(show, 12000);
    });
    show();
  }

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
        if (!howto.wait) {
          appendPuttyPaste(doc, row, box, howto.command);
        }
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
        wait: true,
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
    if (!failedAt) {
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
    button.dataset.failedAt = failedAt ? String(failedAt) : '';
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
      const delay = jiraPollDelay(failedAt);
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
      openTestView(serial, openFromNotification);
    }
    if (wantJira) {
      return openJiraFromToast(serial, jiraFailedAt(record), jiraIsPretest(record));
    }
    return Promise.resolve();
  }

  async function openJiraFromToast(serial, failedAt, pretest) {
    if (!failedAt || !jiraLookupAvailable()) {
      openFromNotification(await resolveJiraUrl(serial, failedAt));
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
      // Dev starts off on every page load, whatever an old save says; only the
      // Dev checkbox turns it on, for that page load.
      const devWasSaved = parsed.developerMode === true;
      parsed.developerMode = false;
      const merged = { ...defaultSettings, ...parsed };
      merged.refreshIntervalSeconds = coerceRefreshInterval(merged.refreshIntervalSeconds);
      // The save's own mark (the defaults always carry the current one).
      const legacySizes = parsed.sizeRev !== PANEL_SIZE_REV;
      merged.alertSize = legacySizes ? PANEL_SIZE_DEFAULT : coercePanelSize(merged.alertSize);
      merged.trackerSize = legacySizes ? PANEL_SIZE_DEFAULT : coercePanelSize(merged.trackerSize);
      merged.sizeRev = PANEL_SIZE_REV;
      if (!merged.sections || typeof merged.sections !== 'object') {
        merged.sections = {};
      }
      if (devWasSaved || legacySizes) {
        writeJSON(localStorage, SETTINGS_KEY, merged, 'Settings');
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

  // Missing / non-numeric / non-finite -> the default; any finite number is
  // rounded to a step and kept between the minimum and maximum.
  function coercePanelSize(value) {
    const number =
      typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) {
      return PANEL_SIZE_DEFAULT;
    }
    const size = Math.round(number / PANEL_SIZE_STEP) * PANEL_SIZE_STEP;
    return Math.min(PANEL_SIZE_MAX, Math.max(PANEL_SIZE_MIN, size));
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
  const OWN_UI_IDS = ['eve-tracker-panel', 'eve-alert-container', BOARD_COPY_ID];

  function isOwnUiNode(node) {
    const element = node && node.nodeType === 1 ? node : node ? node.parentElement : null;
    if (!element || !element.closest) {
      return false;
    }
    return OWN_UI_IDS.some(id => element.closest('#' + id));
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

  // Where the rack tables are: the page itself, or on the live dashboard the
  // hidden copy built from its cards (recreated if the page removed it).
  function boardRoot() {
    if (!ON_LIVE_DASHBOARD) {
      return document;
    }
    let copy = document.getElementById(BOARD_COPY_ID);
    if (!copy) {
      copy = document.createElement('div');
      copy.id = BOARD_COPY_ID;
      copy.hidden = true;
      copy.style.setProperty('display', 'none', 'important');
      document.body.appendChild(copy);
    }
    return copy;
  }

  function getEveTableGroups(root) {
    const scanRoot = root || boardRoot();
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
    if (ON_LIVE_DASHBOARD) {
      // The dashboard updates itself; a refresh re-reads its cards.
      refreshFromDashboard(true);
      finish();
      return;
    }
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
    } else if (ON_LIVE_DASHBOARD) {
      boardRoot().replaceChildren(...newTables.map(table => document.importNode(table, true)));
      swapped = newTables.length;
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

  // ===== LIVE DASHBOARD READER =====
  // Each unit card on the dashboard ("2642YW117Z", "Rack SN TA.A7-EVE01 \u{b7}
  // Position 2", then Test ID, Operation, Model, Status, Test Set, Test Case,
  // Failed, Started, Finished) becomes one cell of the hidden board copy: unit
  // U<position>, colour from Status (pre-test by Operation), link text "serial
  // model -SLT - h:mm testId" as the board prints it. Cards are found by their
  // visible text, not by class names.
  // shortcut: mapped from a screenshot of the dashboard only; when cards are not
  // picked up, the console says so (Dev shows a "Dashboard read" line per read).
  const DASH_LABELS = [
    'Test ID',
    'Operation',
    'Model',
    'Customer',
    'Status',
    'Test Set',
    'Test Case',
    'Attempt',
    'Failed',
    'Started',
    'Finished',
    'View Details'
  ];
  const DASH_RACK_LINE_RE = /Rack\s*SN\s*:?\s*(TA\.[^\s-]+-EVE\d+)[\s\S]*?Position\s*:?\s*(\d+)/i;
  const DASH_RACK_NAME_RE = /^TA\.[^\s-]+-EVE\d+$/i;
  const DASH_COUNT_RE = /^\d+\s*records?$/i;
  const DASH_SERIAL_RE = /^(?=[A-Z0-9]*\d)[A-Z0-9]{6,}$/i;
  const DASH_HIDDEN_ATTR = 'data-eve-hidden';
  const DASH_DEBOUNCE_MS = 1000;
  const DASH_BLIND_SCANS = 5;
  const DASH_EMPTY_READS = 3;
  // Per tab, like the baselines: the newest run start seen per rack position.
  const DASH_RUNS_KEY = 'eveRackTrackerDashboardRuns';
  let dashboardRecords = new Map();
  let dashboardSlots = new Map();
  let dashboardBoxes = new Map();
  let dashboardRuns = null;
  let dashboardSignature = '';
  let dashboardEmptyReads = 0;
  let dashboardMissWarned = false;
  let dashboardRehidePending = false;

  // Walks the non-empty text under `root` in page order, skipping the tracker's own UI.
  function dashboardWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node.nodeType === 1) {
          return OWN_UI_IDS.includes(node.id) ||
            /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
  }

  function dashboardTexts(root) {
    const nodes = [];
    const walker = dashboardWalker(root);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node);
    }
    return nodes;
  }

  // True when some text under `root` passes test(node, trimmedText); stops at the first.
  function dashboardHasText(root, test) {
    const walker = dashboardWalker(root);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (test(node, node.nodeValue.trim())) {
        return true;
      }
    }
    return false;
  }

  function dashboardCardCount(element) {
    return (element.textContent.match(/Rack\s*SN/gi) || []).length;
  }

  // A rack's record count ("7 records"), also when the page renders it as
  // several text nodes ("7", " records") inside one or two elements.
  function dashboardIsCount(node) {
    if (DASH_COUNT_RE.test(node.nodeValue.trim())) {
      return true;
    }
    for (let el = node.parentElement, hops = 0; el && hops < 2; el = el.parentElement, hops += 1) {
      if (DASH_COUNT_RE.test(el.textContent.replace(/\s+/g, ' ').trim())) {
        return true;
      }
    }
    return false;
  }

  // The card around a "Rack SN" line: up to the nearest box that also holds the
  // card's fields, then out through wrappers that still hold only this card and no
  // rack title or record count, so Show can hide the whole card.
  function dashboardCardAround(line) {
    let card = line;
    while (card && card !== document.body && !/Test\s*ID|View\s*Details/i.test(card.textContent)) {
      card = card.parentElement;
    }
    if (!card || card === document.body || dashboardCardCount(card) !== 1) {
      return null;
    }
    while (card.parentElement && card.parentElement !== document.body) {
      const parent = card.parentElement;
      if (
        dashboardCardCount(parent) !== 1 ||
        dashboardHasText(
          parent,
          (node, text) =>
            !card.contains(node) && (DASH_RACK_NAME_RE.test(text) || dashboardIsCount(node))
        )
      ) {
        break;
      }
      card = parent;
    }
    return card;
  }

  // The field label a card text is ("Test ID", "Status:", "STATUS" ...), or ''.
  function dashboardLabel(text) {
    const name = text.replace(/\s*:$/, '').toLowerCase();
    return DASH_LABELS.find(label => label.toLowerCase() === name) || '';
  }

  // One card's fields; null without an EVE rack line or a serial before it. The
  // fields start at the first label after the rack line other than "Failed", since
  // that is also the wording of the badge in a failed card's corner.
  function readDashboardCard(card) {
    const texts = dashboardTexts(card).map(node => node.nodeValue.replace(/\s+/g, ' ').trim());
    const where = texts.join(' ').match(DASH_RACK_LINE_RE);
    const lineAt = texts.findIndex(text => /Rack\s*SN/i.test(text));
    const serial = texts.slice(0, Math.max(lineAt, 0)).find(text => DASH_SERIAL_RE.test(text));
    if (!where || !serial) {
      return null;
    }
    let start = texts.findIndex(
      (text, index) => index > lineAt && dashboardLabel(text) && dashboardLabel(text) !== 'Failed'
    );
    if (start < 0) {
      start = texts.length;
    }
    const fields = {};
    let label = '';
    texts.slice(start).forEach(text => {
      const name = dashboardLabel(text);
      const value = text.replace(/^:\s*/, '');
      if (name) {
        label = name;
        fields[label] = '';
      } else if (label && value) {
        fields[label] = fields[label] ? `${fields[label]} ${value}` : value;
      }
    });
    const badge = texts
      .slice(0, start)
      .filter(text => text !== serial && !/Rack\s*SN/i.test(text))
      .join(' ');
    const testId = fields['Test ID'] || '';
    const link = [...card.querySelectorAll('a[href]')].find(
      a =>
        /View\s*Details/i.test(a.textContent) &&
        !/^\s*(#|javascript:)/i.test(a.getAttribute('href'))
    );
    return {
      rack: where[1].toUpperCase(),
      position: where[2],
      unit: `U${parseInt(where[2], 10)}`,
      serial: serial.toUpperCase(),
      status: fields.Status || badge,
      operation: fields.Operation || '',
      model: fields.Model || '',
      testId: testId,
      testSet: fields['Test Set'] || '',
      testCase: fields['Test Case'] || '',
      failed: fields.Failed || '',
      started: fields.Started || '',
      finished: fields.Finished || '',
      detailUrl: link
        ? safeUrl(link.href)
        : testId
          ? safeUrl(TESTVIEW_DETAIL_PATH + encodeURIComponent(testId))
          : '',
      card: card
    };
  }

  // The largest box around a rack's title that holds nothing but the title, its
  // record count and that rack's cards (a Set): Show hides it whole.
  function dashboardRackBox(title, rackCards) {
    let box = title;
    while (box.parentElement && box.parentElement !== document.body) {
      const parent = box.parentElement;
      const foreign = dashboardHasText(parent, node => {
        if (box.contains(node) || dashboardIsCount(node)) {
          return false;
        }
        for (let el = node.parentElement; el && el !== parent; el = el.parentElement) {
          if (rackCards.has(el)) {
            return false;
          }
        }
        return true;
      });
      if (foreign) {
        break;
      }
      box = parent;
    }
    return box;
  }

  // Board colour for a card: red failed (aborted counts, as on the detail page),
  // darkgreen passed, otherwise still running: lightblue pre-test, lightgreen test.
  function dashboardColor(record) {
    const word = normalizeStatusWord(record.status);
    if (word === 'FAIL') {
      return 'red';
    }
    if (word === 'PASS') {
      return 'darkgreen';
    }
    return normalizePhaseWord(record.operation) === 'PRETEST' ? 'lightblue' : 'lightgreen';
  }

  // The cell text after the serial, as the board prints it: the run timer
  // "-SLT - h:mm" (from Started) while an SLT run is going, for the running ETA.
  function dashboardServerType(record, color) {
    let run = record.operation;
    const started = Date.parse(record.started);
    if (color === 'lightgreen' && /\bslt\b/i.test(record.operation) && started) {
      const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
      run = `-SLT - ${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
    }
    return [record.model, run, record.testId].filter(Boolean).join(' ');
  }

  // One rack as a board table: "Unit | TA.A7-EVE01" and a row per position.
  function dashboardTable(rack, rackSlots) {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    head.appendChild(document.createElement('th')).textContent = 'Unit';
    head.appendChild(document.createElement('th')).textContent = rack;
    const body = table.createTBody();
    [...rackSlots.values()]
      .sort((a, b) => parseInt(a.position, 10) - parseInt(b.position, 10))
      .forEach(record => {
        const row = body.insertRow();
        row.insertCell().textContent = record.unit;
        const cell = row.insertCell();
        const color = dashboardColor(record);
        cell.setAttribute('bgcolor', color);
        const link = cell.appendChild(document.createElement('a'));
        if (record.detailUrl) {
          link.href = record.detailUrl;
        }
        link.textContent = `${record.serial} ${dashboardServerType(record, color)}`;
      });
    return table;
  }

  // Reads every card on the page: board-copy tables (one per rack, the newest card
  // per position), the newest card per serial, what Show hides per rack, and a
  // signature of the data so an unchanged redraw is not rescanned.
  function readDashboard() {
    const cards = [];
    const titles = [];
    const seen = new Set();
    let lines = 0;
    dashboardTexts(document.body).forEach(node => {
      const text = node.nodeValue.trim();
      if (DASH_RACK_NAME_RE.test(text)) {
        titles.push({ rack: text.toUpperCase(), element: node.parentElement });
      }
      if (!/Rack\s*SN/i.test(text)) {
        return;
      }
      lines += 1;
      const card = dashboardCardAround(node.parentElement);
      if (!card || seen.has(card)) {
        return;
      }
      seen.add(card);
      const record = readDashboardCard(card);
      if (record) {
        cards.push(record);
      }
    });
    const newer = (a, b) => (Date.parse(a.started) || 0) >= (Date.parse(b.started) || 0);
    const slots = new Map();
    const bySerial = new Map();
    cards.forEach(record => {
      if (!slots.has(record.rack)) {
        slots.set(record.rack, new Map());
      }
      const rackSlots = slots.get(record.rack);
      const held = rackSlots.get(record.unit);
      if (!held || newer(record, held)) {
        rackSlots.set(record.unit, record);
      }
      const same = bySerial.get(record.serial);
      if (!same || newer(record, same)) {
        bySerial.set(record.serial, record);
      }
    });
    // A position never goes back to an older run: with the page filtered (say to
    // failed runs only) a retested unit's earlier failed card would read as a new
    // failure. Such a position is left out until its newest run shows again.
    if (!dashboardRuns) {
      const saved = readJSON(sessionStorage, DASH_RUNS_KEY, null, 'Dashboard runs');
      dashboardRuns = saved && typeof saved === 'object' ? saved : {};
    }
    let runsChanged = false;
    slots.forEach((rackSlots, rack) => {
      rackSlots.forEach((record, unit) => {
        const key = `${rack}|${unit}`;
        const at = Date.parse(record.started) || 0;
        const newest = Number(dashboardRuns[key]) || 0;
        if (at < newest) {
          rackSlots.delete(unit);
        } else if (at > newest) {
          dashboardRuns[key] = at;
          runsChanged = true;
        }
      });
    });
    if (runsChanged) {
      writeJSON(sessionStorage, DASH_RUNS_KEY, dashboardRuns, 'Dashboard runs');
    }
    const titlesOutside = titles.filter(
      entry => !cards.some(record => record.card.contains(entry.element))
    );
    const boxes = new Map();
    slots.forEach((rackSlots, rack) => {
      const rackCards = cards.filter(record => record.rack === rack).map(record => record.card);
      const title = titlesOutside.find(entry => entry.rack === rack);
      const box = title ? dashboardRackBox(title.element, new Set(rackCards)) : null;
      boxes.set(rack, box ? [box, ...rackCards.filter(card => !box.contains(card))] : rackCards);
    });
    return {
      tables: [...slots]
        .filter(([, rackSlots]) => rackSlots.size)
        .map(([rack, rackSlots]) => dashboardTable(rack, rackSlots)),
      slots: slots,
      bySerial: bySerial,
      boxes: boxes,
      count: cards.length,
      lines: lines,
      signature: cards
        .map(r =>
          [r.rack, r.unit, r.serial, r.status, r.operation, r.testId, r.failed, r.finished].join('|')
        )
        .join('\n')
    };
  }

  // The detail-page answer for a serial (confirmPhase on the dashboard), from the
  // card the slot shows, else the serial's newest card: phase from Operation,
  // result from Status, and on a failure the test set / case from "Failed". Times
  // go to the board's "YYYY-MM-DD HH:MM:SS".
  function dashboardDetail(serial, info) {
    const wanted = String(serial || '').toUpperCase();
    const rackSlots = info
      ? dashboardSlots.get(`TA.${info.section}-${info.eve}`.toUpperCase())
      : null;
    const own = rackSlots ? rackSlots.get(String(info.unit).toUpperCase()) : null;
    const record = own && own.serial === wanted ? own : dashboardRecords.get(wanted);
    if (!record) {
      return { confirmed: false, reason: 'no card for this serial on the dashboard' };
    }
    const status = normalizeStatusWord(record.status);
    const failedAt =
      status === 'FAIL' && /[A-Z0-9]/i.test(record.failed)
        ? record.failed.split(/\s*\/\s*/)
        : null;
    const siteStamp = text =>
      String(text || '')
        .replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?).*$/, '$1 $2')
        .replace(/^-$/, '');
    return {
      confirmed: !!record.operation,
      phase: normalizePhaseWord(record.operation),
      operation: record.operation,
      phaseExact: isKnownOperationWord(record.operation),
      status: status,
      pass: status === 'PASS' ? 1 : status === 'FAIL' ? 0 : null,
      running: !status,
      resultConfirmed: !!status,
      taskset: failedAt ? failedAt[0] : record.testSet,
      taskcase: failedAt ? failedAt.slice(1).join(' / ') : record.testCase,
      started: siteStamp(record.started),
      finished: siteStamp(record.finished),
      serialOnPage: record.serial,
      serialMatches: true,
      rackSerialOnPage: record.rack,
      positionOnPage: record.position,
      locationMatches: null,
      reason: !record.operation
        ? 'the card shows no Operation'
        : status
          ? ''
          : 'that operation is still running'
    };
  }

  const DASH_CONTENT = 'img, svg, canvas, video, iframe, input, select, textarea, button';

  // A wrapper Show left with nothing to show: some part of it is hidden and the
  // rest is blank or a record count. A wrapper holding a shown rack, a control or
  // any other text stays.
  function dashboardEmptied(parent) {
    if (!parent || !parent.parentElement || parent === document.body || isOwnUiNode(parent)) {
      return false;
    }
    let hidden = 0;
    for (const child of parent.children) {
      if (child.hasAttribute(DASH_HIDDEN_ATTR)) {
        hidden += 1;
      } else if (!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(child.tagName)) {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (child.matches(DASH_CONTENT) || child.querySelector(DASH_CONTENT) || (text && !DASH_COUNT_RE.test(text))) {
          return false;
        }
      }
    }
    const loose = [...parent.childNodes]
      .filter(node => node.nodeType === 3)
      .map(node => node.nodeValue)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return hidden > 0 && (!loose || DASH_COUNT_RE.test(loose));
  }

  // Show off for a section hides its racks' boxes on the dashboard, through a
  // marker attribute and one CSS rule, so the page's own styles are left alone.
  // Wrappers that are left empty (a rack's frame and record count, a row of
  // racks all hidden) are marked too, from the inside out, so the next shown
  // rack moves up; the nodes stay where they are for Show on.
  function applyDashboardVisibility() {
    document.querySelectorAll(`[${DASH_HIDDEN_ATTR}]`).forEach(element => {
      element.removeAttribute(DASH_HIDDEN_ATTR);
    });
    dashboardBoxes.forEach((boxes, rack) => {
      const match = rack.match(EVE_HEADER_PATTERN);
      if (match && !getSectionSettings(match[1]).show) {
        boxes.forEach(box => box.setAttribute(DASH_HIDDEN_ATTR, ''));
      }
    });
    let fresh = [...document.querySelectorAll(`[${DASH_HIDDEN_ATTR}]`)];
    while (fresh.length) {
      fresh = [...new Set(fresh.map(element => element.parentElement))].filter(
        parent => parent && !parent.hasAttribute(DASH_HIDDEN_ATTR) && dashboardEmptied(parent)
      );
      fresh.forEach(parent => parent.setAttribute(DASH_HIDDEN_ATTR, ''));
    }
  }

  // While a section is hidden, rack boxes the page draws anew are hidden again
  // before the next paint, instead of showing until the next read.
  function rehideDashboardSoon() {
    const hiding = Object.values(settings.sections).some(section => section && !section.show);
    if (!hiding || dashboardRehidePending) {
      return;
    }
    dashboardRehidePending = true;
    requestAnimationFrame(() => {
      dashboardRehidePending = false;
      try {
        dashboardBoxes = readDashboard().boxes;
        withoutObserver(applyDashboardVisibility);
      } catch (error) {
        fail('Hiding dashboard racks failed:', error);
      }
    });
  }

  // Reads the dashboard again. Hidden boxes are re-marked every time (the page may
  // have redrawn them); the copy is rebuilt and scanned when the cards changed, or
  // always when `force` (the refresh timer, which also moves the SLT run timers).
  // A read with no cards keeps the last copy for a few refreshes, so a redraw in
  // progress does not blank the tracker; with no copy kept, forced reads still
  // scan, so a dashboard the tracker cannot read ends up BLIND.
  function refreshFromDashboard(force) {
    try {
      const read = readDashboard();
      dashboardBoxes = read.boxes;
      withoutObserver(applyDashboardVisibility);
      if (read.lines && !read.count && !dashboardMissWarned) {
        dashboardMissWarned = true;
        warn(
          `Dashboard read: ${read.lines} "Rack SN" line(s) on the page but no card could ` +
            'be read. Send this line and the HTML of one card (right-click > Inspect) to Zay.'
        );
      }
      if (read.count) {
        dashboardEmptyReads = 0;
      } else if (dashboardSignature) {
        dashboardEmptyReads += force ? 1 : 0;
        if (dashboardEmptyReads < DASH_EMPTY_READS) {
          return;
        }
      }
      if (!force && read.signature === dashboardSignature) {
        return;
      }
      dashboardSignature = read.signature;
      dashboardRecords = read.bySerial;
      dashboardSlots = read.slots;
      swapEveTables(read.tables, null);
      devLog(`Dashboard read: ${read.count} card(s) in ${read.tables.length} rack(s).`);
    } catch (error) {
      fail('Reading the live dashboard failed:', error);
    }
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
      if (ON_LIVE_DASHBOARD) {
        rehideDashboardSoon();
      }
      if (relevant.some(touchesTable)) {
        pendingRackChange = true;
      }
      if (scanTimer) {
        clearTimeout(scanTimer);
      }
      scanTimer = setTimeout(() => {
        scanTimer = null;
        if (ON_LIVE_DASHBOARD) {
          refreshFromDashboard(false);
          return;
        }
        if (pendingRackChange) {
          pendingRackChange = false;
          rackDataAt = Date.now();
        }
        invalidateHeaderCache();
        const groups = getEveTableGroups();
        buildSectionControls(groups);
        applyVisibility(groups);
        scan(groups);
      }, ON_LIVE_DASHBOARD ? DASH_DEBOUNCE_MS : OBSERVER_DEBOUNCE_MS);
    });
    // The board changes cell colours (attributes); the dashboard redraws its cards'
    // text, so there text changes are watched instead.
    pageObserver.observe(
      document.body,
      ON_LIVE_DASHBOARD
        ? { subtree: true, childList: true, characterData: true }
        : {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'bgcolor']
          }
    );
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
    const tag = `eve-slt-${Date.now()}-${notificationTagCounter}`;
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
    // On the live dashboard the unit's own card is its detail page.
    const doc = ON_LIVE_DASHBOARD ? null : await fetchDetailDocument(url);
    if (!doc && !ON_LIVE_DASHBOARD) {
      phaseConfirmFailures += 1;
      const value = {
        confirmed: false,
        reason: 'detail page unreachable'
      };
      cachePhaseResult(cacheKey, value);
      return value;
    }
    const parsed = ON_LIVE_DASHBOARD
      ? dashboardDetail(serial, info)
      : parseDetailDocument(doc, serial);
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
    try {
      learnSltPass(info, parsed);
    } catch (error) {
      warn('Could not record the SLT pass time:', error);
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
    // The rack page links only "serial model" and prints the run timer ("-SLT -
    // 03:14 8241695") next to the link, inside the same cell; the dashboard copy
    // holds it all in the link. cellType is the cell's whole text after the
    // serial, for the running ETA (serverType keeps the link's own text).
    const whole = cell.textContent.replace(/\s+/g, ' ').trim();
    return {
      section: section,
      eve: eve,
      unit: unit,
      serial: parts[0] || '',
      serverType: parts.slice(1).join(' '),
      cellType: parts[0] && whole.indexOf(parts[0]) === 0 ? whole.slice(parts[0].length).trim() : whole,
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

  function recordEventClaim(key, serial, transition, eventId, at) {
    const claims = readEventClaims();
    claims[`${key}|${serial}|${transition}`] = { at: at || rackDataAt, eventId: eventId || '' };
    const cutoff = Date.now() - EVENT_CLAIM_MAX_AGE_MS;
    const live = Object.entries(claims)
      .filter(([, claim]) => claim && Number(claim.at) > cutoff)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_EVENT_CLAIMS);
    writeJSON(localStorage, EVENT_CLAIMS_KEY, Object.fromEntries(live), null);
  }

  // ===== SHARED COORDINATION (the board and the live dashboard at once) =====
  // Both tracker pages may run together (the board, the TestView live
  // dashboard, more tabs of either). They are different sites, so their
  // localStorage, locks and channels never meet; the script storage (GM_*) is
  // the one store every page of this script shares, in one browser profile
  // (pages in another profile or on another PC coordinate with nothing).
  // That storage has no compare-and-set, so nothing here is a lock in the
  // storage sense: each page writes only its own keys and reads everyone's.
  //   eveCoord.hb.<page>  heartbeat, every few seconds while the page runs
  //   eveCoord.cl.<page>  its claims: { key: { thing, ts, ... } }
  // A thing (a rack event, a repair request toast, a repair send) goes to the
  // earliest claim by write time (then page id) still in play, decided
  // COORD_SETTLE_MS after writing: every earlier claim has reached this page by
  // then as long as the storage passes writes between pages faster than that
  // (normally well under a second). A claim already acted on (done / sent)
  // outranks any later decision, so a page that sees an event late (asleep, a
  // slower refresh) only mirrors it. With no other tracker page alive an event
  // is decided at once, as before.
  const COORD_BEAT_KEY = 'eveCoord.hb.';
  const COORD_CLAIMS_KEY = 'eveCoord.cl.';
  const COORD_PAGE = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const COORD_KIND = ON_LIVE_DASHBOARD ? 'live dashboard' : 'board';
  const COORD_SETTLE_MS = 1500;
  const COORD_BEAT_MS = 5000;
  const COORD_ALIVE_MS = 15000;
  const COORD_KEEP_MS = 12 * 60 * 60 * 1000;
  const COORD_MAX_CLAIMS = 300;
  const COORD_SWEEP_MS = 10 * 60 * 1000;
  const COORD_DEAD_BEAT_MS = 60 * 60 * 1000;
  // A page that did not own an event checks this long after its decision that
  // the owner acted (the owner's toast waits for the phase first).
  const COORD_HANDOVER_MS = TOAST_CONFIRM_WAIT_MS + 6000;
  const coordOn =
    typeof GM_getValue === 'function' &&
    typeof GM_setValue === 'function' &&
    typeof GM_listValues === 'function';
  const coordOwn = {};
  const coordDue = [];
  let coordSeq = 0;
  let coordBeatAt = 0;
  let coordSweptAt = 0;
  let coordTicking = false;
  let coordSaveQueued = false;

  function coordRead(key) {
    try {
      const text = GM_getValue(key, null);
      return typeof text === 'string' ? JSON.parse(text) : null;
    } catch (error) {
      return null;
    }
  }

  function coordWrite(key, value) {
    try {
      if (value !== null) {
        GM_setValue(key, JSON.stringify(value));
      } else if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(key);
      }
    } catch (error) {
      warn('Shared page coordination: script storage write failed:', error);
    }
  }

  function coordKeys(prefix) {
    try {
      return GM_listValues().filter(key => String(key).indexOf(prefix) === 0);
    } catch (error) {
      return [];
    }
  }

  // Page ids (this one included) whose heartbeat is recent.
  function coordLivePages(now) {
    const live = new Set([COORD_PAGE]);
    if (coordOn) {
      coordKeys(COORD_BEAT_KEY).forEach(key => {
        const beat = coordRead(key);
        if (beat && now - Number(beat.at) < COORD_ALIVE_MS) {
          live.add(key.slice(COORD_BEAT_KEY.length));
        }
      });
    }
    return live;
  }

  function coordBeat(now) {
    coordBeatAt = now;
    coordWrite(COORD_BEAT_KEY + COORD_PAGE, { at: now, page: COORD_KIND, origin: window.location.origin });
    const status = document.getElementById('eve-pages-status');
    if (status) {
      const others = coordKeys(COORD_BEAT_KEY)
        .filter(key => key !== COORD_BEAT_KEY + COORD_PAGE)
        .map(coordRead)
        .filter(beat => beat && now - Number(beat.at) < COORD_ALIVE_MS);
      setTextIfChanged(
        status,
        others.length
          ? `Shared with ${others.length} other tracker page${others.length === 1 ? '' : 's'} ` +
              `(${others.map(beat => beat.page).join(', ')}): each event is logged and toasted once`
          : 'No other tracker page open'
      );
    }
  }

  // Closing or reloading: other pages stop waiting for this one at once.
  function coordLeave() {
    if (coordOn) {
      coordWrite(COORD_BEAT_KEY + COORD_PAGE, null);
    }
  }

  // Written once per task (claims made together go out in one write).
  function coordSaveOwn() {
    if (!coordOn || coordSaveQueued) {
      return;
    }
    coordSaveQueued = true;
    Promise.resolve().then(() => {
      coordSaveQueued = false;
      coordWrite(COORD_CLAIMS_KEY + COORD_PAGE, coordOwn);
    });
  }

  function coordClaim(thing, fields) {
    coordSeq += 1;
    const ts = Date.now();
    const claim = { thing: thing, key: `${ts.toString(36)}.${coordSeq}`, ts: ts, ...fields };
    coordOwn[claim.key] = claim;
    coordSaveOwn();
    return claim;
  }

  // Every page's claims on a thing (this page's from memory), with page ids.
  function coordClaimsOf(thing) {
    const found = [];
    const add = (page, claims) => {
      Object.values(claims || {}).forEach(claim => {
        if (claim && claim.thing === thing) {
          found.push({ ...claim, page: page });
        }
      });
    };
    add(COORD_PAGE, coordOwn);
    if (coordOn) {
      coordKeys(COORD_CLAIMS_KEY).forEach(key => {
        const page = key.slice(COORD_CLAIMS_KEY.length);
        if (page !== COORD_PAGE) {
          add(page, coordRead(key));
        }
      });
    }
    return found;
  }

  function coordFirst(claims) {
    return (
      claims
        .slice()
        .sort((a, b) => a.ts - b.ts || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))[0] || null
    );
  }

  function coordIsOwn(claim, own) {
    return !!claim && claim.page === COORD_PAGE && claim.key === own.key;
  }

  // Runs fn at `due`: on the master tick (a background tab's timers are slowed,
  // the tick is not), else on a timer (the Jira and SFCS pages have no tick).
  function coordAt(due, fn) {
    if (coordTicking) {
      coordDue.push({ due: due, run: fn });
      return;
    }
    setTimeout(() => {
      fn();
      flushPendingToasts();
    }, Math.max(0, due - Date.now()));
  }

  function coordTick(now) {
    if (!coordOn) {
      return;
    }
    if (now - coordBeatAt >= COORD_BEAT_MS) {
      coordBeat(now);
    }
    const ready = coordDue.filter(item => item.due <= now).sort((a, b) => a.due - b.due);
    if (ready.length) {
      ready.forEach(item => coordDue.splice(coordDue.indexOf(item), 1));
      ready.forEach(item => {
        try {
          item.run();
        } catch (error) {
          fail('Shared page coordination step threw:', error);
        }
      });
      flushPendingToasts();
    }
    if (now - coordSweptAt >= COORD_SWEEP_MS) {
      coordSweep(now);
    }
  }

  // Old claims go; so do pages long gone (their heartbeat over an hour old,
  // their newest claim past the keep time). A live page rewrites its own keys.
  function coordSweep(now) {
    coordSweptAt = now;
    const own = Object.keys(coordOwn).sort((a, b) => coordOwn[b].ts - coordOwn[a].ts);
    const drop = own.filter((key, index) => index >= COORD_MAX_CLAIMS || now - coordOwn[key].ts > COORD_KEEP_MS);
    drop.forEach(key => delete coordOwn[key]);
    if (drop.length) {
      coordSaveOwn();
    }
    coordKeys(COORD_BEAT_KEY).forEach(key => {
      const beat = coordRead(key);
      if (key !== COORD_BEAT_KEY + COORD_PAGE && (!beat || now - Number(beat.at) > COORD_DEAD_BEAT_MS)) {
        coordWrite(key, null);
      }
    });
    coordKeys(COORD_CLAIMS_KEY).forEach(key => {
      if (key === COORD_CLAIMS_KEY + COORD_PAGE) {
        return;
      }
      const claims = Object.values(coordRead(key) || {});
      const newest = Math.max(0, ...claims.map(claim => Number(claim && claim.ts) || 0));
      if (now - newest > COORD_KEEP_MS) {
        coordWrite(key, null);
      }
    });
  }

  // Two pages' claims on one transition (same slot, serial and kind) are the
  // same occurrence when the test run id matches (pages of one kind print it
  // the same way); otherwise when their spans overlap: each saw the old colour
  // last at seenAt and the new one first at `at`, so the change lies between.
  // A later retest (the old colour seen again after the first page's `at`)
  // does not overlap.
  function coordSameEvent(a, b) {
    if (a.run && b.run && a.kind === b.kind) {
      return a.run === b.run;
    }
    return (Number(a.seenAt) || 0) < Number(b.at) && (Number(b.seenAt) || 0) < Number(a.at);
  }

  function coordSameAs(own) {
    return claim => (claim.page === COORD_PAGE ? claim.key === own.key : coordSameEvent(claim, own));
  }

  // A new rack event: this page claims it and, with another tracker page alive,
  // learns its part after the settle time. finish(plan): plan.record = write the
  // log entry (else mirror plan.id, the one event id every page uses);
  // plan.toast = send the desktop toast (the first page with Notifs on, so a
  // page with Notifs off never uses it up); plan.standby = keep the card and
  // take the toast over if its owner closes before sending it.
  function coordinateEvent(thing, span, eligible, finish) {
    const own = coordClaim(thing, {
      at: span.at,
      seenAt: span.seenAt || 0,
      run: span.run || '',
      kind: COORD_KIND,
      ok: !!eligible,
      id: newEventId()
    });
    const decide = () => finish(coordDecideEvent(own));
    if (coordOn && coordLivePages(Date.now()).size > 1) {
      coordAt(own.ts + COORD_SETTLE_MS, decide);
    } else {
      decide();
    }
  }

  function coordDecideEvent(own) {
    const live = coordLivePages(Date.now());
    const same = coordClaimsOf(own.thing).filter(coordSameAs(own));
    const inPlay = same.filter(claim => live.has(claim.page));
    const recorder = coordFirst(same.filter(claim => claim.done)) || coordFirst(inPlay);
    const toaster =
      coordFirst(same.filter(claim => claim.sent)) || coordFirst(inPlay.filter(claim => claim.ok));
    const plan = {
      record: coordIsOwn(recorder, own),
      id: recorder.id,
      toast: coordIsOwn(toaster, own),
      standby: own.ok && !!toaster && !toaster.sent && !coordIsOwn(toaster, own),
      own: own
    };
    own.id = plan.id;
    if (plan.record) {
      own.done = true;
    }
    coordSaveOwn();
    return plan;
  }

  function coordMarkSent(key) {
    const claim = key ? coordOwn[key] : null;
    if (claim && !claim.sent) {
      claim.sent = true;
      coordSaveOwn();
    }
  }

  // After a decision this page did not own: if the owner page closed (or
  // reloaded) before acting, the first page still open takes over: its mirror
  // entry becomes the recorded one (promote) and, with Notifs on, the toast goes
  // out from here (send). A live owner is never second-guessed: checked again a
  // few times while it is still open, then left to it.
  function coordFollowUp(own, plan, send, promote, tries) {
    const left = tries === undefined ? 3 : tries;
    coordAt(Date.now() + (tries === undefined ? COORD_HANDOVER_MS : 2 * COORD_BEAT_MS), () => {
      const live = coordLivePages(Date.now());
      const same = coordClaimsOf(own.thing).filter(coordSameAs(own));
      let waiting = false;
      if (!plan.record && !same.some(claim => claim.done)) {
        if (coordIsOwn(coordFirst(same.filter(claim => live.has(claim.page))), own)) {
          plan.record = true;
          own.done = true;
          coordSaveOwn();
          promote();
        } else {
          waiting = true;
        }
      }
      if (plan.standby && !same.some(claim => claim.sent)) {
        if (coordIsOwn(coordFirst(same.filter(claim => claim.ok && live.has(claim.page))), own)) {
          plan.standby = false;
          send();
        } else {
          waiting = true;
        }
      }
      if (waiting && left > 1) {
        coordFollowUp(own, plan, send, promote, left - 1);
      }
    });
  }

  // One page at a time (a repair send) or once on every page together (a
  // repair request toast): after the settle time the earliest claim still in
  // play wins. A claim counts until released or past its lease (a page that
  // died mid-send frees it by then); a once claim stays taken when its page
  // won (done). callback(won, release); release() only clears this page's claim.
  function coordTake(thing, options, callback) {
    const own = coordClaim(thing, { exp: Date.now() + options.lease });
    const release = () => {
      if (!own.released) {
        own.released = true;
        coordSaveOwn();
      }
    };
    const decide = () => {
      const now = Date.now();
      const counted = coordClaimsOf(thing).filter(
        claim =>
          coordIsOwn(claim, own) ||
          (options.once && claim.done) ||
          (!claim.released && Number(claim.exp) > now)
      );
      const won = coordIsOwn(coordFirst(counted), own);
      if (won && options.once) {
        own.done = true;
        coordSaveOwn();
      }
      callback(won, release);
    };
    if (coordOn) {
      coordAt(own.ts + COORD_SETTLE_MS, decide);
    } else {
      decide();
    }
  }

  // ===== RUNNING ETA (SLT) =====
  // An estimated pass time for every running SLT server. The board prints how
  // long the run has gone in the cell ("... -SLT - 03:22 ...") and the cell's
  // second word is the model code, which picks the typical pass time: a starting
  // figure until this tracker has seen three passes of that model, then the
  // median of the passes it has seen (kept per model code in localStorage).
  // shortcut: a model with no starting figure (X10 today) gets no estimate until
  // one of its passes is seen; add its typical minutes to SLT_DURATION_SEEDS.
  const SLT_DURATIONS_KEY = 'eveRackTrackerSltDurations';
  // [model code pattern, typical pass minutes]: X11 10h20m, X12 15h50m, E6-2C 9h30m, other E5/E6 7h.
  const SLT_DURATION_SEEDS = [
    [/^X11/, 620],
    [/^X12/, 950],
    [/^E62C/, 570],
    [/^E[56]/, 420]
  ];
  const SLT_DURATION_MIN_SAMPLES = 3;
  const SLT_DURATION_MAX_SAMPLES = 40;
  // ETA clock only ("01:41am", site time); shift and export clocks keep their own.
  const ETA_CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  const ETA_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  });
  let sltDurations = null;
  let etaListHtml = '';
  let etaOverdueHtml = '';
  let etaNextHtml = '';
  let etaOverdueNow = [];
  let etaCleared = null;
  const ETA_CLEARED_KEY = 'eveEtaClearedOverdue';
  const ETA_SAME_RUN_MS = 20 * 60000;
  const ETA_OVERDUE_SHOW_MS = 24 * 3600000;

  function loadSltDurations() {
    const saved = readJSON(localStorage, SLT_DURATIONS_KEY, null, 'SLT durations');
    return isRecordObject(saved) ? saved : {};
  }

  // Minutes of the passes seen for a model (damaged saved entries are skipped).
  function sltSamples(model) {
    if (!sltDurations) {
      sltDurations = loadSltDurations();
    }
    const list = Array.isArray(sltDurations[model]) ? sltDurations[model] : [];
    return list.map(sample => (isRecordObject(sample) ? sample.m : NaN)).filter(Number.isFinite);
  }

  function medianOf(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  // Typical pass time in minutes for a model; null when there is nothing to base one on.
  function sltExpectedMin(model) {
    const samples = sltSamples(model);
    const flat = model.replace(/[^A-Z0-9]/g, '');
    const seed = SLT_DURATION_SEEDS.find(entry => entry[0].test(flat));
    const basis =
      samples.length >= SLT_DURATION_MIN_SAMPLES || !seed ? samples : samples.concat(seed[1]);
    return basis.length ? medianOf(basis) : null;
  }

  // "X112CB200 -SLT - 03:22 8223088" -> "X112CB200"; '' when the first word is not a model code.
  function sltModelCode(serverType) {
    const word = String(serverType || '').trim().split(/\s+/)[0].toUpperCase();
    return /^(?=.*[A-Z])[A-Z0-9][A-Z0-9._-]*$/.test(word) ? word : '';
  }

  // "... -SLT - 03:22 ..." -> 202 minutes into the run; null without that timer (pre-test cells have none).
  function sltElapsedMin(serverType) {
    const match = String(serverType || '').match(/-\s*SLT\s*-\s*(\d+):(\d{1,2})\b/i);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  // A passed SLT run on the detail page adds one sample for its model, once per run.
  function learnSltPass(info, parsed) {
    if (
      !info ||
      !parsed ||
      parsed.status !== 'PASS' ||
      !/\bslt\b/i.test(parsed.operation)
    ) {
      return;
    }
    const model = sltModelCode(info.serverType);
    const minutes = Math.round(
      (siteTimeToMs(parsed.finished) - siteTimeToMs(parsed.started)) / 60000
    );
    if (!model || !(minutes > 60 && minutes <= 72 * 60)) {
      return;
    }
    const stored = loadSltDurations();
    const key = `${info.serial}|${parsed.started}`;
    const list = Array.isArray(stored[model]) ? stored[model] : [];
    if (!list.some(sample => isRecordObject(sample) && sample.k === key)) {
      list.push({ k: key, m: minutes });
      stored[model] = list.slice(-SLT_DURATION_MAX_SAMPLES);
      writeJSON(localStorage, SLT_DURATIONS_KEY, stored, 'SLT durations');
    }
    sltDurations = stored;
  }

  // The ETA for one scanned cell; null unless it is a running SLT unit with a timer.
  // `dataAt` is when the board text was read: its timer is that old, and using it
  // (not the scan time) keeps the ETA still between refreshes.
  function sltEtaFor(info, dataAt) {
    const elapsed = sltElapsedMin(info.cellType || info.serverType);
    if (elapsed === null) {
      return null;
    }
    const model = sltModelCode(info.serverType) || sltModelCode(info.cellType);
    const expected = model ? sltExpectedMin(model) : null;
    return {
      info: info,
      model: model,
      elapsed: elapsed,
      expected: expected,
      samples: model ? sltSamples(model).length : 0,
      eta: expected ? dataAt + (expected - elapsed) * 60000 : null
    };
  }

  function etaClock(eta) {
    const parts = ETA_CLOCK_FORMAT.formatToParts(new Date(eta));
    const part = type => (parts.find(item => item.type === type) || {}).value || '';
    return `${part('hour').replace(/^0/, '')}:${part('minute')}${part('dayPeriod').toLowerCase()}`;
  }

  // '' on the site's today; 'tomorrow' / 'yesterday', else the weekday, so a
  // time past midnight is not read as today's.
  function etaDay(eta, now) {
    const day = ms => {
      const parts = ETA_DAY_FORMAT.formatToParts(new Date(ms));
      const part = type => (parts.find(item => item.type === type) || {}).value || '';
      return {
        n: Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))) / 86400000,
        weekday: part('weekday')
      };
    };
    const at = day(eta);
    const gap = at.n - day(now).n;
    return gap === 0 ? '' : gap === 1 ? 'tomorrow' : gap === -1 ? 'yesterday' : at.weekday;
  }

  // "in 12 minutes", "in 4h 59m", "due now", "41 min overdue": never a negative countdown.
  function etaWhen(eta, now) {
    const gap = eta - now;
    if (Math.abs(gap) < 60000) {
      return 'due now';
    }
    const minutes = Math.floor(Math.abs(gap) / 60000);
    if (gap > 0) {
      return minutes < 60 ? `in ${minutes} minute${minutes === 1 ? '' : 's'}` : `in ${formatDuration(gap)}`;
    }
    return `${minutes < 60 ? `${minutes} min` : formatDuration(-gap)} overdue`;
  }

  function etaTip(row, now) {
    const run = `Running ${formatDuration(row.elapsed * 60000)}.`;
    if (!row.eta) {
      return (
        `${run} No typical pass time for ${row.model || 'this model'} yet; ` +
        'it is learned from the passes this tracker sees.'
      );
    }
    const basis =
      row.samples >= SLT_DURATION_MIN_SAMPLES
        ? `median of ${row.samples} passes seen`
        : 'starting estimate';
    const day = etaDay(row.eta, now);
    return (
      `Estimated pass ${etaClock(row.eta)}${day ? ` ${day}` : ''} (${etaWhen(row.eta, now)}). ` +
      `${run} ${row.model} usually takes ${formatDuration(row.expected * 60000)} (${basis}). ` +
      'An estimate from the typical SLT duration, not a result.'
    );
  }

  // Panel list (soonest first) plus a tooltip on each running cell. Sections
  // hidden with "Show" are left out, like the cells themselves.
  function renderRunningEta(infos) {
    const card = document.getElementById('eve-eta-card');
    if (!card) {
      return;
    }
    const now = Date.now();
    const rows = infos
      .filter(info => getSectionSettings(info.section).show)
      .map(info => sltEtaFor(info, rackDataAt || now))
      .filter(Boolean);
    card.hidden = !rows.length;
    if (!rows.length) {
      return;
    }
    withoutObserver(() => {
      rows.forEach(row => {
        const link = row.info.cell.querySelector('a');
        if (!link) {
          return;
        }
        if (link.dataset.eveEtaBase === undefined) {
          link.dataset.eveEtaBase = link.title || '';
        }
        const tip = etaTip(row, now);
        const title = link.dataset.eveEtaBase ? `${link.dataset.eveEtaBase}\n${tip}` : tip;
        if (link.title !== title) {
          link.title = title;
        }
      });
    });
    const known = rows.filter(row => row.eta).sort((a, b) => a.eta - b.eta);
    // Overdue (estimate passed by a minute or more) is its own group, never in
    // the upcoming list; it is an estimate, not a result. A row you cleared
    // stays out for that run, and one overdue for more than a day is dropped
    // from the display (nothing else is touched).
    const cleared = etaClearedRuns();
    const runStart = row => (rackDataAt || now) - row.elapsed * 60000;
    const isCleared = row => {
      const at = cleared[row.info.serial];
      return at !== undefined && Math.abs(Number(at) - runStart(row)) <= ETA_SAME_RUN_MS;
    };
    const lateRows = known.filter(row => now - row.eta >= 60000);
    const overdue = lateRows.filter(row => now - row.eta <= ETA_OVERDUE_SHOW_MS && !isCleared(row));
    const upcoming = known.filter(row => now - row.eta < 60000);
    const next = upcoming[0] || null;
    const missing = {};
    rows
      .filter(row => !row.eta)
      .forEach(row => {
        const key = row.model || 'unknown model';
        missing[key] = (missing[key] || 0) + 1;
      });
    const missingText = Object.keys(missing)
      .sort()
      .map(key => `${key} (${missing[key]})`)
      .join(', ');
    const whereOf = info => `${info.section} \u{b7} ${info.eve} \u{b7} ${info.unit}`;
    const rowHtml = (row, isLate) => {
      const info = row.info;
      const day = etaDay(row.eta, now);
      return (
        `<div class="eve-eta-row${isLate ? ' eve-eta-late' : ''}" ` +
        `title="${escapeHtml(etaTip(row, now))}">` +
        `<div class="eve-eta-line"><b class="eve-eta-sn-main">${escapeHtml(info.serial)}</b>` +
        ' <span class="eve-eta-sep">\u{2014}</span> ' +
        `<b class="eve-eta-clock">${etaClock(row.eta)}</b>` +
        (day ? ` <span class="eve-eta-day">${escapeHtml(day)}</span>` : '') +
        '</div>' +
        `<div class="eve-eta-where">${qaIcon('pin', 'eve-eta-pin')}` +
        `<span>${escapeHtml(whereOf(info))}</span>` +
        `<span class="eve-eta-when">${escapeHtml(isLate ? etaOverdueText(row.eta, now) : etaLeftText(row.eta, now))}</span>` +
        '</div></div>'
      );
    };
    let html = upcoming.slice(1).map(row => rowHtml(row, false)).join('');
    if (missingText) {
      const noneText = `No typical pass time yet: ${missingText}`;
      html += `<div class="eve-eta-none">${escapeHtml(noneText)}</div>`;
    }
    const overdueHtml = overdue.map(row => rowHtml(row, true)).join('');
    const count = card.querySelector('.eve-eta-count');
    if (count) {
      setTextIfChanged(count, `${rows.length} testing`);
      const tip =
        `${rows.length} running SLT in the shown sections, ` +
        `${known.length} with an estimate`;
      if (count.title !== tip) {
        count.title = tip;
      }
    }
    // Above the fold: the next server to pass (earliest future estimate in the
    // shown sections), or a plain empty state.
    const nextBox = card.querySelector('.eve-eta-next');
    const lead = card.querySelector('.eve-eta-lead');
    if (nextBox && lead) {
      // Line 1: "Server pass ETA [#] testing / Next [SN] -- x:xxam"; line 2:
      // "Location: B6  EVE03  U7  31 min left".
      let leadHtml = '';
      let nextHtml;
      if (next) {
        const day = etaDay(next.eta, now);
        const gap = '\u{a0}\u{a0}\u{a0}\u{a0}';
        const pair = '\u{a0}\u{a0}';
        leadHtml =
          `<span class="eve-eta-sep">/</span> Next Server pass ETA in <b class="eve-eta-in">${escapeHtml(etaInText(next.eta, now))}</b> ` +
          `- <b class="eve-eta-clock">${etaClock(next.eta)}</b>` +
          (day ? ` <span class="eve-eta-day">${escapeHtml(day)}</span>` : '');
        nextHtml =
          `<span class="eve-eta-next-line eve-eta-next-where">SN <b>${escapeHtml(next.info.serial)}</b>${gap}location ` +
          `${escapeHtml([next.info.section, next.info.eve, next.info.unit].join(pair))}</span>`;
      } else {
        leadHtml = '<span class="eve-eta-sep">/</span> Server pass ETA';
        nextHtml =
          '<span class="eve-eta-next-line eve-eta-next-where">' +
          (known.length ? 'No upcoming pass estimate' : 'No pass estimate yet') +
          '</span>';
      }
      if (lead.innerHTML !== leadHtml) {
        lead.innerHTML = leadHtml;
      }
      if (nextHtml !== etaNextHtml) {
        nextBox.innerHTML = nextHtml;
        etaNextHtml = nextHtml;
      }
      const nextTip = next ? etaTip(next, now) : '';
      if (nextBox.title !== nextTip) {
        nextBox.title = nextTip;
      }
      if (lead.title !== nextTip) {
        lead.title = nextTip;
      }
    }
    const overBox = document.getElementById('eve-eta-overdue');
    if (overBox) {
      overBox.hidden = !overdue.length;
      setTextIfChanged(document.getElementById('eve-eta-overdue-n'), String(overdue.length));
    }
    const body = document.getElementById('eve-eta-body');
    const overList = document.getElementById('eve-eta-overdue-list');
    const list = document.getElementById('eve-eta-list');
    const scrollTop = body ? body.scrollTop : 0;
    let changed = false;
    if (overList && overdueHtml !== etaOverdueHtml) {
      overList.innerHTML = overdueHtml;
      etaOverdueHtml = overdueHtml;
      changed = true;
    }
    if (list && html !== etaListHtml) {
      list.innerHTML = html;
      etaListHtml = html;
      changed = true;
    }
    if (changed && body) {
      body.scrollTop = scrollTop;
    }
    etaOverdueNow = overdue;
  }

  // "1 hr 20 min left", "35 min left", "due now": never a negative countdown.
  function etaLeftText(eta, now) {
    const gap = eta - now;
    if (gap < 60000) {
      return 'due now';
    }
    const minutes = Math.floor(gap / 60000);
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''} left` : `${minutes} min left`;
  }

  // "2 hr 35 mins", "35 mins", "due now": one phrase, never a negative countdown.
  function etaInText(eta, now) {
    const gap = eta - now;
    if (gap < 60000) {
      return 'due now';
    }
    const minutes = Math.floor(gap / 60000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const mins = `${rest} ${rest === 1 ? 'min' : 'mins'}`;
    return hours ? `${hours} hr${rest ? ` ${mins}` : ''}` : mins;
  }

  function etaOverdueText(eta, now) {
    const minutes = Math.max(1, Math.floor((now - eta) / 60000));
    const hours = Math.floor(minutes / 60);
    return `Overdue by ${hours ? `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`}`;
  }

  // Overdue rows cleared by hand: serial -> the run's start time, so the same
  // run stays hidden and a later run of the same serial gets a fresh ETA.
  function etaClearedRuns() {
    if (!etaCleared) {
      let saved = {};
      try {
        saved = JSON.parse(localStorage.getItem(ETA_CLEARED_KEY) || '{}') || {};
      } catch (error) {
        saved = {};
      }
      etaCleared = isRecordObject(saved) ? saved : {};
    }
    return etaCleared;
  }

  function clearOverdueEta() {
    const cleared = etaClearedRuns();
    const horizon = Date.now() - 3 * 86400000;
    Object.keys(cleared).forEach(serial => {
      if (Number(cleared[serial]) < horizon) {
        delete cleared[serial];
      }
    });
    const base = rackDataAt || Date.now();
    etaOverdueNow.forEach(row => {
      cleared[row.info.serial] = base - row.elapsed * 60000;
    });
    try {
      localStorage.setItem(ETA_CLEARED_KEY, JSON.stringify(cleared));
    } catch (error) {}
    redrawRunningEta();
  }

  // ===== SCAN PAGE =====

  function scan(groupsIn) {
    const groups = groupsIn || getEveTableGroups();
    let statesDirty = false;
    const seenKeys = new Set();
    let headerCount = 0;
    let slotErrors = 0;
    const sectionCounts = {};
    const runningInfos = [];
    // False when the read is too thin to call anything "removed".
    let scanComplete = true;
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
          if (info.color === 'lightgreen') {
            runningInfos.push(info);
          }
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
        scanComplete = false;
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
      // The dashboard draws its cards a while after it loads, so it gets longer.
      if (blindScans >= (ON_LIVE_DASHBOARD ? DASH_BLIND_SCANS : BLIND_SCAN_THRESHOLD)) {
        reportHealth(
          'BLIND',
          ON_LIVE_DASHBOARD
            ? 'No EVE rack cards found on the dashboard. It may still be loading, ' +
                'be filtered to nothing, or its layout changed.'
            : 'No EVE table headers found. The page structure has ' +
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
    if (headerCount && !slotErrors && scanComplete) {
      markGoneCards(groups, seenKeys);
      goneVerifiedAt = Date.now();
    } else {
      goneVerifiedAt = 0;
    }
    if (headerCount) {
      lastSectionCounts = sectionCounts;
      lastRunningInfos = runningInfos;
      renderSectionCounts();
      redrawRunningEta();
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
  let lastRunningInfos = [];

  // Also run on a Show change, so a hidden section leaves the list at once.
  function redrawRunningEta() {
    try {
      renderRunningEta(lastRunningInfos);
    } catch (error) {
      warn('Running ETA could not be drawn:', error);
    }
  }

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

  function setSectionStat(pill, count) {
    setTextIfChanged(pill.querySelector('b'), String(count));
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
      setSectionStat(stats.querySelector('.eve-stat-testing'), testing);
      setSectionStat(stats.querySelector('.eve-stat-failed'), c.failed);
      setSectionStat(stats.querySelector('.eve-stat-passed'), c.passed);
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
    const claimed = findEventClaim(key, info.serial, transition, oldState.seen);
    if (claimed) {
      const repeat = isDuplicateAlert(key, info.serial, transition);
      devLog(
        `${key} ${transition} already logged and notified by another ` +
          'tracker tab \u{2014} card only, no second log entry or toast.'
      );
      if (!repeat && getSectionSettings(header.section).watch) {
        const confirmation = info.detailUrl ? confirmPhase(info.detailUrl, info, { force: true }) : null;
        surfaceAlert(info, transition, confirmation, claimed.eventId || '', true);
      }
      return;
    }
    if (isDuplicateAlert(key, info.serial, transition)) {
      // A repeat within the cooldown: counted on this page's own log entry.
      const repeatId = logRealAlert(info, transition, true);
      if (repeatId) {
        recordEventClaim(key, info.serial, transition, repeatId);
      }
      confirmEvent(info, transition, repeatId);
      return;
    }
    const watch = !!getSectionSettings(header.section).watch;
    const at = rackDataAt;
    const finish = plan => finishSlotEvent(key, info, transition, watch, at, plan);
    if (isDebugData(info)) {
      finish({ record: true, id: '', toast: true, standby: false, own: null });
      return;
    }
    const run = (String(info.serverType || '').match(/(\d{5,})\s*$/) || [])[1] || '';
    coordinateEvent(`ev|${key}|${info.serial}|${transition}`, { at: at, seenAt: oldState.seen, run: run }, watch, finish);
  }

  // The rest of a new event once the tracker pages agree (at once with no other
  // page open): the recording page writes the log entry, another page the same
  // entry marked mirror; the card where Notifs is on; the toast on one page.
  function finishSlotEvent(key, info, transition, watch, at, plan) {
    const eventId = plan.record
      ? logRealAlert(info, transition, false, plan.id)
      : mirrorLogEntry(info, transition, plan.id);
    if (eventId) {
      recordEventClaim(key, info.serial, transition, eventId, at);
    }
    const confirmation = confirmEvent(info, transition, eventId);
    let record = null;
    if (watch) {
      record = surfaceAlert(info, transition, confirmation, eventId, !plan.toast, plan.own);
    } else {
      log(
        `${key} ${transition} recorded to the log but not ` +
          `surfaced \u{2014} "Notifs" is off for section ` +
          `${info.section}.`
      );
    }
    if (plan.own && (!plan.record || plan.standby)) {
      const send = () => {
        const card = record && document.querySelector(`.eve-alert[data-alert-id="${CSS.escape(record.id)}"]`);
        if (card && !card.dataset.leaving) {
          log(`${info.serial} ${transition}: the page that owned this toast closed before sending it; sent from here.`);
          pendingToasts.push({ info: info, record: record, confirmation: null });
        }
      };
      const promote = () => {
        const entry = findLogEntry(eventId);
        if (entry && entry.mirror) {
          entry.mirror = false;
          markLogEntryChanged(entry);
        }
        log(`${info.serial} ${transition}: the page that saw it first closed before recording it; recorded here.`);
      };
      coordFollowUp(plan.own, plan, send, promote);
    }
  }

  // Another page recorded this event: the same entry here (its event id, marked
  // mirror) so this page's shift log is complete, unless this site's log
  // already has it (a tab of the same site wrote it).
  function mirrorLogEntry(info, transition, eventId) {
    if (!eventId || isDebugData(info)) {
      return '';
    }
    return findLogEntry(eventId) ? eventId : logRealAlert(info, transition, false, eventId, true);
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
    coordMarkSent(record.coordKey);
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

  function surfaceAlert(info, transition, eventConfirmation, eventId, cardOnly, claim) {
    const record = createPersistentAlert(getTransitionTitle(transition), info, transition);
    record.eventId = eventId || '';
    record.coordKey = claim ? claim.key : '';
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
    if (!cardOnly) {
      pendingToasts.push({
        info: info,
        record: record,
        confirmation: confirmation
      });
    }
    return record;
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
      `EVE SLT TRACKER \u{2014} NEW ${win.shift.label.toUpperCase()} SHIFT LOG`,
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

  function newEventId(time) {
    return `evt-${time || Date.now()}-` + Math.random().toString(36).slice(2, 8);
  }

  // eventId: the event's id agreed with the other tracker pages; mirror: another
  // page recorded it, this entry keeps this page's log complete.
  function logRealAlert(info, transition, suppressed, eventId, mirror) {
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
    const id = eventId || newEventId(now.getTime());
    appendAlertLog({
      eventId: id,
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
      serverType: info.serverType || '',
      ...(mirror ? { mirror: true } : {})
    });
    return id;
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
    const logEntries = loadRealAlertLog();
    const win = currentShiftWindow();
    const lines = [];
    lines.push(
      LOG_RULE,
      'EVE SLT TRACKER \u{2014} ALERT LOG',
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
        `EVE SLT TRACKER-log-${localDateKey(win.starts)}-${win.id}-` + `${time}.${extension}`;
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

  // Serial numbers, Jira keys and the PuTTY ticket command. `idle` is the
  // hint text to restore. Resolves true once the text is on the clipboard.
  const COPY_IDLE = '\u{29c9} Copy';

  const hintTimers = new WeakMap();

  // The copy button's hint: a tick (or a cross) for 1.5 s, then `idle` again.
  function showCopyHint(buttonEl, ok, idle, okText) {
    if (!buttonEl) {
      return;
    }
    const hint = buttonEl.querySelector('.eve-alert-copy-hint');
    if (!hint) {
      return;
    }
    // One timer per button: a second copy within the 1.5 s keeps its own full
    // 1.5 s and the older timer cannot cut it short. The hint is announced.
    clearTimeout(hintTimers.get(buttonEl));
    hint.setAttribute('role', 'status');
    hint.textContent = ok ? okText || '\u{2713} Copied' : '\u{2715} Failed';
    buttonEl.classList.remove('eve-copied', 'eve-copy-failed');
    buttonEl.classList.add(ok ? 'eve-copied' : 'eve-copy-failed');
    hintTimers.set(
      buttonEl,
      setTimeout(() => {
        hint.textContent = idle || COPY_IDLE;
        buttonEl.classList.remove('eve-copied', 'eve-copy-failed');
        hintTimers.delete(buttonEl);
      }, 1500)
    );
  }

  function copyToClipboard(text, buttonEl, idle) {
    function showCopied(ok) {
      showCopyHint(buttonEl, ok, idle);
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
        return ok;
      } catch (error) {
        showCopied(false);
        fail('Clipboard copy failed:', error);
        return false;
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => {
          showCopied(true);
          devLog(`${text} copied to clipboard.`);
          return true;
        })
        .catch(fallbackCopy);
    }
    return Promise.resolve(fallbackCopy());
  }

  // ===== COPY A TITLED JIRA LINK =====
  // "[MFGS-123] <ticket title>" as a link to the issue, for rich editors (Teams,
  // Outlook); plain-text editors get the title, then the URL. Without a title
  // (not looked up yet) the label is the key and serial. Resolves 'link' (the
  // link is on the clipboard), 'text' (title + URL only) or '' (nothing copied).
  function copyJiraLink(key, summary, serial) {
    const url = jiraIssueUrl(key);
    const label = `[${key}] ${String(summary || serial || '').trim()}`.trim();
    const text = `${label}\n${url}`;
    const html = `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function') {
      return navigator.clipboard
        .write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' })
          })
        ])
        .then(
          () => 'link',
          () => copyJiraLinkByEvent(html, text)
        );
    }
    return Promise.resolve(copyJiraLinkByEvent(html, text));
  }

  // execCommand('copy') filling the copy event's own data (works on http pages,
  // which have no async clipboard); the selected text is the plain fallback.
  function copyJiraLinkByEvent(html, text) {
    let rich = false;
    const onCopy = event => {
      try {
        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        rich = true;
      } catch (error) {}
    };
    let ok = false;
    try {
      document.addEventListener('copy', onCopy, true);
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      withoutObserver(() => {
        document.body.appendChild(area);
        area.select();
        ok = !!document.execCommand('copy');
        area.remove();
      });
    } catch (error) {
      ok = false;
    } finally {
      document.removeEventListener('copy', onCopy, true);
    }
    return ok ? (rich ? 'link' : 'text') : '';
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
    const clock = new Date(ts).toLocaleTimeString();
    // No-break spaces: a footer too narrow for one line wraps after the dot only.
    const keep = text => text.replace(/ /g, '\u{a0}');
    return `${keep(relative)}\u{a0}\u{b7} ${keep(clock)}`;
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
    // Only Dev debug cards make room; an operator's undismissed card is never
    // evicted (the count in the panel header shows when it is getting full).
    while (alerts.length > MAX_STORED_ALERTS) {
      const debugIndex = alerts.findIndex(a => isDebugData(a));
      if (debugIndex === -1) {
        break;
      }
      alerts.splice(debugIndex, 1);
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
    if (!record || (record.manual && record.phaseSource === 'manual') || !record.detailUrl || isDebugData(record)) {
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
  // through and tagged (it is still the record of what happened) and stays
  // until the person dismisses it (X or Dismiss all). Only for columns this
  // page shows - a card from a rack not on this page is left alone. A retest
  // (same serial, new colour) is not "gone".
  //
  // The first scan that sees the slot without the serial (a different serial
  // there is no return) stamps when (record.goneAt, mirrored in the card's
  // data-gone-at; a reload and repeat scans keep it). The serial back in its
  // slot clears it; a later removal stamps again. It never dismisses the card.
  let goneVerifiedAt = 0;

  function setGoneStamp(card, stamp) {
    const had = Number(card.dataset.goneAt) || 0;
    if (!stamp) {
      if (!had) {
        return;
      }
      delete card.dataset.goneAt;
    } else {
      // Keep the first stamp; one in the future (clock set back) starts over.
      if (had && had <= stamp) {
        return;
      }
      card.dataset.goneAt = String(stamp);
    }
    if (card.dataset.alertId) {
      updateStoredAlert({ id: card.dataset.alertId, goneAt: stamp });
    }
  }

  function markGoneCards(groups, seenKeys) {
    const columns = new Set();
    groups.forEach(group => group.headers.forEach(h => columns.add(`${h.section}|${h.eve}`)));
    const stamp = Date.now();
    document.querySelectorAll('#eve-alert-body .eve-alert[data-slot]').forEach(card => {
      if (card.dataset.leaving === '1') {
        return;
      }
      const slot = card.dataset.slot;
      const serial = card.dataset.serial;
      if (!slot || !serial) {
        return;
      }
      if (!columns.has(slot.split('|').slice(0, 2).join('|'))) {
        // Not readable here: it can neither start nor keep a removal clock.
        setGoneStamp(card, 0);
        return;
      }
      const now = seenKeys.has(slot) ? previousStates.get(slot) : null;
      const present = !!now && now.serial === serial;
      const empty = !now || !now.serial;
      // Another serial in the slot is a replacement: confirmed at once. An empty
      // or missing slot may be a reboot after a killed test: pending, not gone.
      let gone = !present && !empty;
      let pending = false;
      if (present) {
        notePresence(card, serial, stamp, true);
      } else if (empty) {
        gone = presenceGone(card, serial, stamp);
        pending = !gone;
      }
      card.classList.toggle('eve-alert-gone', gone);
      setGoneStamp(card, gone ? stamp : 0);
      // The tag takes the copy hint's place in the serial box, and copying
      // is off: the serial is no longer in the rack. Jira and TestView stay.
      const serialBox = card.querySelector('button.eve-alert-serial');
      if (serialBox) {
        serialBox.disabled = gone;
        serialBox.title = gone ? '' : 'Click to copy serial number';
      }
      const retestNext = (card.querySelector('.jstr-card') || { dataset: {} }).dataset.next || '';
      const tagText = gone
        ? 'Removed from rack'
        : pending
          ? /retest/i.test(retestNext) ? 'Waiting for retest' : 'Checking presence\u{2026}'
          : '';
      let tag = card.querySelector('.eve-gone-tag');
      if (tagText && !tag && serialBox) {
        tag = document.createElement('span');
        tag.className = 'eve-gone-tag';
        serialBox.appendChild(tag);
      } else if (!tagText && tag) {
        tag.remove();
        tag = null;
      }
      if (tag && tagText) {
        setTextIfChanged(tag, tagText);
        tag.title = gone
          ? `${serial} is no longer in ${slot.split('|').join(' \u{2022} ')}` +
            (now && now.serial ? ` (now ${now.serial}).` : ' (the slot is empty).') +
            ' The card stays until you dismiss it.'
          : `${serial} is not listed in ${slot.split('|').join(' \u{2022} ')} right now. ` +
            'It may be rebooting after a killed test, so it is not marked removed until that is confirmed.';
      }
    });
  }

  // A serial missing from its slot is only "pending" until fresh, complete reads
  // keep showing the slot without it: PRESENCE_MIN_READS distinct rack reads over
  // PRESENCE_GRACE_MS, a healthy refresh, and no other open page having seen it
  // lately. Time alone never confirms; a loading, failed, partial or repeated
  // snapshot never reaches here (markGoneCards runs only on complete scans). A
  // card already marked removed (saved or restored) stays removed.
  const PRESENCE_GRACE_MS = 3 * 60 * 1000;
  const PRESENCE_MIN_READS = 3;
  const PRESENCE_SEEN_KEY = 'eveCoord.seen.';
  const presenceWrittenAt = new Map();

  // Seen in its slot: clears a pending absence and tells the other pages.
  function notePresence(card, serial, stamp) {
    if (card.dataset.absentAt) {
      delete card.dataset.absentAt;
      delete card.dataset.absentReads;
      delete card.dataset.absentData;
      if (card.dataset.alertId) {
        updateStoredAlert({ id: card.dataset.alertId, absentAt: 0 });
      }
    }
    if (coordOn && stamp - (presenceWrittenAt.get(serial) || 0) > 20000) {
      presenceWrittenAt.set(serial, stamp);
      coordWrite(PRESENCE_SEEN_KEY + serial, { at: stamp, page: COORD_PAGE });
    }
  }

  function presenceGone(card, serial, stamp) {
    if (Number(card.dataset.goneAt) > 0) {
      return true;
    }
    let since = Number(card.dataset.absentAt) || 0;
    if (!since || since > stamp) {
      since = stamp;
      card.dataset.absentAt = String(stamp);
      card.dataset.absentReads = '0';
      card.dataset.absentData = '';
      if (card.dataset.alertId) {
        updateStoredAlert({ id: card.dataset.alertId, absentAt: stamp });
      }
    }
    if (String(rackDataAt) !== card.dataset.absentData) {
      card.dataset.absentData = String(rackDataAt);
      card.dataset.absentReads = String((Number(card.dataset.absentReads) || 0) + 1);
    }
    const other = coordOn ? coordRead(PRESENCE_SEEN_KEY + serial) : null;
    const elsewhere = !!other && other.page !== COORD_PAGE && stamp - Number(other.at) < PRESENCE_GRACE_MS;
    const confirmed =
      stamp - since >= PRESENCE_GRACE_MS &&
      (Number(card.dataset.absentReads) || 0) >= PRESENCE_MIN_READS &&
      !softRefreshFailingSince &&
      !elsewhere;
    if (confirmed && coordOn) {
      coordWrite(PRESENCE_SEEN_KEY + serial, null);
    }
    return confirmed;
  }

  // ===== DISMISSING A CARD =====
  // One path for the X button, the 90 s expiry and Dismiss all. The saved
  // alert goes first and at once (a reload can never bring the card back),
  // the open Quick Actions tray lets go of it, the card fades and shrinks
  // while the cards below close the gap, and a timer finishes the removal if
  // the animation never reports back (hidden tab, cancelled animation).
  const CARD_EXIT_MS = 170;

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  let alertChromeQueued = false;

  function queueAlertChrome() {
    if (alertChromeQueued) {
      return;
    }
    alertChromeQueued = true;
    Promise.resolve().then(() => {
      alertChromeQueued = false;
      refreshAlertChrome();
    });
  }

  function dismissAlertCard(card, options) {
    const opts = options || {};
    if (!card || card.dataset.leaving === '1') {
      return false;
    }
    card.dataset.leaving = '1';
    card.setAttribute('aria-hidden', 'true');
    if ('inert' in card) {
      card.inert = true;
    }
    if (!opts.skipStore) {
      removeStoredAlert(card.dataset.alertId);
    }
    if (qa && qa.card === card) {
      closeQuickActions(false);
    }
    let finished = false;
    let guard = 0;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(guard);
      card.remove();
      queueAlertChrome();
    };
    const body = card.parentNode;
    if (
      !body ||
      opts.instant ||
      prefersReducedMotion() ||
      typeof card.animate !== 'function' ||
      card.offsetParent === null
    ) {
      finish();
      return true;
    }
    const style = getComputedStyle(card);
    const gap = parseFloat(getComputedStyle(body).rowGap) || 0;
    card.style.overflow = 'hidden';
    const animation = card.animate(
      [
        {
          opacity: 1,
          transform: 'scale(1)',
          height: style.height,
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          borderTopWidth: style.borderTopWidth,
          borderBottomWidth: style.borderBottomWidth,
          marginBottom: style.marginBottom
        },
        {
          opacity: 0,
          transform: 'scale(.96)',
          height: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          borderTopWidth: '0px',
          borderBottomWidth: '0px',
          marginBottom: `${-gap}px`
        }
      ],
      { duration: CARD_EXIT_MS, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }
    );
    animation.addEventListener('finish', finish);
    animation.addEventListener('cancel', finish);
    guard = setTimeout(finish, CARD_EXIT_MS + 250);
    return true;
  }

  // ===== SAME-SLOT UNDO BAR =====
  // X folds the card into a compact "Alert dismissed" bar in its own list slot
  // for 8 seconds. The card itself stays in the page, hidden and marked
  // leaving (so counts, filters, presence checks and Jira polls treat it as
  // gone or ignore it); only its saved record is removed. Undo puts the very
  // same card back, its record where it was, and nothing is notified. The
  // bar's X, or the timer, finalizes it; whichever comes first wins. Dismiss
  // all finalizes every bar at once, so nothing can come back after it.
  // Motion: one measure per click, then transform + opacity only; the cards
  // below glide by the height difference (no per-frame layout).
  const UNDO_MS = 8000;
  const UNDO_ANIM_MS = 200;
  const UNDO_EASE = 'cubic-bezier(.2, .8, .2, 1)';
  const undoEntries = [];

  function snapshotForUndo(card) {
    const alerts = loadActiveAlerts();
    const index = alerts.findIndex(a => a.id === card.dataset.alertId);
    if (index === -1) {
      return null;
    }
    return { record: { ...alerts[index] }, index: index, timer: 0, done: false, card: null, bar: null };
  }

  // The visible cards from `start` on were `delta` px lower before: glide them up.
  function glideFollowing(start, delta) {
    if (!delta || prefersReducedMotion()) {
      return;
    }
    let node = start;
    let count = 0;
    while (node && count < 14) {
      if (node.style.display !== 'none' && typeof node.animate === 'function') {
        node.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
          { duration: UNDO_ANIM_MS, easing: UNDO_EASE }
        );
        count += 1;
      }
      node = node.nextElementSibling;
    }
  }

  function buildUndoBar(entry) {
    const bar = document.createElement('div');
    bar.className = 'eve-undo-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Alert dismissed');
    bar.dataset.alertId = entry.record.id;
    bar.innerHTML =
      '<span class="eve-undo-mark" aria-hidden="true">\u{2713}</span>' +
      '<span class="eve-undo-text"><span class="eve-undo-title">Alert dismissed</span>' +
      '<span class="eve-undo-sub"></span></span>' +
      '<button type="button" class="eve-undo-do">Undo</button>' +
      '<button type="button" class="eve-undo-x" title="Dismiss for good" aria-label="Dismiss for good">\u{d7}</button>';
    bar.querySelector('.eve-undo-sub').textContent =
      `${entry.record.serial || 'Alert'} \u{b7} 8-second window`;
    bar.querySelector('.eve-undo-do').addEventListener('click', event => {
      event.stopPropagation();
      undoCard(entry);
    });
    bar.querySelector('.eve-undo-x').addEventListener('click', event => {
      event.stopPropagation();
      finalizeUndo(entry, false);
    });
    return bar;
  }

  function foldIntoUndo(card, focusUndo) {
    if (!card || card.dataset.leaving === '1') {
      return false;
    }
    const entry = snapshotForUndo(card);
    if (!entry || !card.parentNode || card.offsetParent === null) {
      return dismissAlertCard(card);
    }
    if (qa && qa.card === card) {
      closeQuickActions(false);
    }
    const before = card.offsetHeight; // the one read before the writes
    card.dataset.leaving = '1';
    card.setAttribute('aria-hidden', 'true');
    if ('inert' in card) {
      card.inert = true;
    }
    removeStoredAlert(card.dataset.alertId);
    const bar = buildUndoBar(entry);
    entry.card = card;
    entry.bar = bar;
    card.parentNode.insertBefore(bar, card);
    card.style.display = 'none';
    const after = bar.offsetHeight; // and the one read after
    undoEntries.push(entry);
    entry.timer = setTimeout(() => finalizeUndo(entry, false), UNDO_MS);
    if (!prefersReducedMotion() && typeof bar.animate === 'function') {
      bar.animate(
        [{ opacity: 0, transform: 'scaleY(.7)' }, { opacity: 1, transform: 'none' }],
        { duration: UNDO_ANIM_MS, easing: UNDO_EASE }
      );
      glideFollowing(bar.nextElementSibling, before - after);
    }
    queueAlertChrome();
    if (focusUndo) {
      bar.querySelector('.eve-undo-do').focus();
    }
    return true;
  }

  // X on the bar, the 8 s timer, or Dismiss all: the card is gone for good.
  function finalizeUndo(entry, instant) {
    if (!entry || entry.done) {
      return;
    }
    entry.done = true;
    clearTimeout(entry.timer);
    const at = undoEntries.indexOf(entry);
    if (at !== -1) {
      undoEntries.splice(at, 1);
    }
    const { bar, card } = entry;
    const finish = () => {
      bar.remove();
      card.remove();
      queueAlertChrome();
    };
    if (instant || prefersReducedMotion() || !bar.isConnected || typeof bar.animate !== 'function') {
      finish();
      return;
    }
    const body = bar.parentNode;
    const gap = body ? parseFloat(getComputedStyle(body).rowGap) || 0 : 0;
    const height = bar.offsetHeight + gap;
    const next = bar.nextElementSibling;
    bar.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scaleY(.7)' }],
      { duration: UNDO_ANIM_MS * 0.7, easing: 'ease-out', fill: 'forwards' }
    ).addEventListener('finish', () => {
      finish();
      glideFollowing(next, height);
    });
    setTimeout(() => {
      if (bar.isConnected) {
        finish();
      }
    }, UNDO_ANIM_MS + 250);
  }

  function clearUndo() {
    undoEntries.slice().forEach(entry => finalizeUndo(entry, true));
  }

  function undoCard(entry) {
    if (!entry || entry.done) {
      return;
    }
    entry.done = true;
    clearTimeout(entry.timer);
    const at = undoEntries.indexOf(entry);
    if (at !== -1) {
      undoEntries.splice(at, 1);
    }
    const { bar, card, record } = entry;
    if (!bar.isConnected || !card.isConnected) {
      return;
    }
    const barHeight = bar.offsetHeight;
    delete card.dataset.leaving;
    card.removeAttribute('aria-hidden');
    if ('inert' in card) {
      card.inert = false;
    }
    bar.remove();
    card.style.display = '';
    const alerts = loadActiveAlerts();
    if (!alerts.some(a => a.id === record.id)) {
      alerts.splice(Math.min(entry.index, alerts.length), 0, record);
      saveActiveAlerts(alerts);
    }
    if (!prefersReducedMotion() && typeof card.animate === 'function') {
      const cardHeight = card.offsetHeight;
      card.animate(
        [{ opacity: 0, transform: 'scaleY(.8)' }, { opacity: 1, transform: 'none' }],
        { duration: UNDO_ANIM_MS, easing: UNDO_EASE }
      );
      glideFollowing(card.nextElementSibling, barHeight - cardHeight);
    }
    queueAlertChrome();
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
    renderAlertElement(record, true, { enter: true });
    revealNewAlert(record.id);
    return record;
  }

  // ===== MANUAL CARD (JIRAlerts "+ Add card") =====
  // A card for a serial typed in by hand: a real TEST FAIL / PRE-TEST FAIL /
  // PASS card in the same record and renderer as any alert (manual only says
  // where it came from). The result comes from the live rack slot when that
  // is authoritative (dark green = pass; red = fail, with test vs pre-test
  // confirmed from the detail page like any alert); otherwise the person picks
  // it. Nothing is logged or notified, no test is started, and the location,
  // TestView page and Jira chip come from what the page really shows.
  // chosen: a transition picked by the person (after { choose: true }).
  function addManualCard(raw, chosen) {
    const serial = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!serial) {
      return { ok: false, message: 'Enter a serial number.' };
    }
    if (!/^[A-Z0-9]{8,16}$/.test(serial)) {
      return { ok: false, message: 'A serial is 8 to 16 letters and digits.' };
    }
    let slot = '';
    previousStates.forEach((state, key) => {
      if (!slot && state && state.serial === serial) {
        slot = key;
      }
    });
    const parts = slot ? slot.split('|') : [];
    const color = slot ? previousStates.get(slot).color : '';
    let transition = chosen && TRANSITIONS[chosen] ? chosen : '';
    let source = transition ? 'manual' : 'color';
    if (!transition && color === 'darkgreen') {
      transition = 'TEST_SUCCESS';
    } else if (!transition && color === 'red') {
      transition = 'TEST_FAILURE';
    }
    if (!transition) {
      return {
        ok: false,
        hint: 'Assume: server still running',
        message:
          `${serial} is still running on the rack or does not have a supported result yet. ` +
          'No card created.'
      };
    }
    const body = getAlertContainer();
    const same = [...body.querySelectorAll('.eve-alert')].find(
      node => node.dataset.serial === serial && node.dataset.leaving !== '1' && node.dataset.transition === transition
    );
    if (same) {
      same.scrollIntoView({ block: 'nearest' });
      return { ok: false, message: `${serial} already has that card.` };
    }
    const link = [...document.querySelectorAll('a[href*="eveserverdetail"]')].find(
      a => a.href.indexOf(serial) !== -1
    );
    const record = {
      id: `alert-${Date.now()}-` + Math.random().toString(36).slice(2, 8),
      title: getTransitionTitle(transition),
      transition: transition,
      manual: true,
      debug: false,
      serial: serial,
      detailUrl: link ? safeUrl(link.href) : '',
      location: slot ? `${parts[0]} \u{2022} ${parts[1]} \u{2022} ${parts[2]}` : 'Location unavailable',
      section: parts[0] || '',
      eve: parts[1] || '',
      unit: parts[2] || '',
      statusLine: getStatusLine(transition),
      eventId: '',
      notifiedTransition: '',
      phaseSource: source,
      taskset: '',
      taskcase: '',
      operation: '',
      passFlag: null,
      resultConfirmed: false,
      phaseExact: false,
      pendingReason: '',
      ts: Date.now()
    };
    renderAlertElement(record, true, { enter: true });
    revealNewAlert(record.id);
    return { ok: true, message: `${serial} added.` };
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
    card.dataset.transition = record.transition || '';
    syncJiraForCard(card, record);
    const titleEl = card.querySelector('.eve-alert-header span');
    if (titleEl) {
      titleEl.textContent = record.title;
    }
    const statusEl = card.querySelector('.eve-alert-status');
    if (statusEl) {
      statusEl.textContent = record.statusLine || '';
    }
    syncPhaseNote(card, record);
    applyAlertFilter();
  }

  // The detail row (what the detail page confirmed: operation, Pass, taskset,
  // failing taskcase). Built on every card but shown only with Dev on (CSS on
  // body.eve-dev-mode, so the Dev switch shows / hides it at once); with a
  // detail URL it is a button that opens the server detail page.
  function syncPhaseNote(card, record) {
    let note = card.querySelector('.eve-alert-phase-note');
    const text = buildPhaseNote(record);
    if (!text) {
      if (note) {
        note.remove();
      }
      return;
    }
    if (!note) {
      const url = card.dataset.detailUrl || '';
      note = document.createElement(url ? 'button' : 'div');
      note.className = 'eve-alert-phase-note';
      note.innerHTML =
        '<span class="eve-alert-phase-text"></span>' +
        (url ? qaIcon('chevron', 'eve-ico eve-phase-chev') : '');
      if (url) {
        note.type = 'button';
        note.title = 'Open the server detail page';
        note.addEventListener('click', () => openExternal(url));
      }
      const footer = card.querySelector('.eve-alert-footer');
      card.insertBefore(note, footer && footer.parentNode === card ? footer : null);
    }
    setTextIfChanged(note.querySelector('.eve-alert-phase-text'), text);
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
    Object.keys(TRANSITIONS)
      .map(key => [key, TRANSITIONS[key].css])
  );

  function isCardClickable(record) {
    return !!(record.serial || safeUrl(record.detailUrl));
  }

  // A card's own controls do only their own job; a click anywhere else on the
  // card toggles its Quick Actions (TestView 2.0 is a row there).
  const CARD_OWN_CONTROLS =
    '.eve-alert-serial, .eve-alert-close, .eve-jira-group, .jstr-card, ' +
    '.eve-qa-tab, button.eve-alert-phase-note';

  function applyCardState(element, record) {
    const alertClass = ALERT_CLASS_BY_TRANSITION[record.transition] || 'eve-failure';
    // Set by the scan / the entrance, not by the record: a re-applied state keeps them.
    const kept = ['eve-alert-gone', 'eve-alert-enter']
      .filter(name => element.classList.contains(name))
      .map(name => ` ${name}`)
      .join('');
    element.className =
      `eve-alert ${alertClass}` +
      kept +
      (isCardClickable(record) ? ' eve-alert-clickable' : '') +
      (record.phaseSource === 'unverified' ? ' eve-alert-unverified' : '') +
      (isAlertAged(record.ts) ? ' eve-alert-aged' : '');
    element.dataset.transition = record.transition || '';
    element.dataset.diagnostic = isDiagnosticTransition(record.transition) ? '1' : '0';
  }

  // The visible card after (else before) this one, for keyboard focus after a dismissal.
  function adjacentAlertCard(card) {
    const live = el => el.classList.contains('eve-alert') && el.dataset.leaving !== '1' && el.style.display !== 'none';
    let other = card.nextElementSibling;
    while (other && !live(other)) {
      other = other.nextElementSibling;
    }
    if (!other) {
      other = card.previousElementSibling;
      while (other && !live(other)) {
        other = other.previousElementSibling;
      }
    }
    return other;
  }

  function renderAlertElement(record, shouldStore, options) {
    const opts = options || {};
    const container = getAlertContainer();
    const alert = document.createElement('div');
    const clickable = isCardClickable(record);
    applyCardState(alert, record);
    if (clickable) {
      alert.title = record.serial
        ? 'Click the card to open its Quick Actions'
        : 'Click anywhere on this alert to open Server Detail';
    }
    alert.dataset.alertId = record.id;
    alert.dataset.slot =
      record.section && record.eve && record.unit ? `${record.section}|${record.eve}|${record.unit}` : '';
    alert.dataset.serial = record.serial || '';
    alert.dataset.debug = isDebugData(record) ? '1' : '0';
    alert.dataset.manual = record.manual ? '1' : '0';
    alert.dataset.transition = record.transition || '';
    alert.dataset.search = `${record.serial || ''} ${record.location || ''}`;
    alert.dataset.detailUrl = safeUrl(record.detailUrl);
    if (Number(record.goneAt) > 0) {
      // Restored after a reload: the removal clock goes on from its first stamp.
      alert.dataset.goneAt = String(Number(record.goneAt));
    } else if (Number(record.absentAt) > 0) {
      // Pending presence goes on across a reload (reads start over, the clock does not).
      alert.dataset.absentAt = String(Number(record.absentAt));
    }
    const ts = Number(record.ts) || 0;
    const serialBlock = record.serial
      ? `
<button
class="eve-alert-serial"
title="Click to copy serial number"
>
<span class="eve-alert-serial-value">${escapeHtml(record.serial)}</span>
<span class="eve-alert-copy-hint">${COPY_IDLE}</span>
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
<span class="eve-alert-loc-label">Server Location</span>
<span class="eve-alert-loc-value">
${qaIcon('pin', 'eve-ico')}
<span>${escapeHtml(record.location || '\u{2014}')}</span>
</span>
</div>
<div class="eve-alert-status-row">
<span class="eve-alert-status">${escapeHtml(record.statusLine || '')}</span>
</div>
<div class="eve-alert-footer">
${qaIcon('clock', 'eve-ico')}
<div
class="eve-alert-time"
data-ts="${ts}"
>
${escapeHtml(formatRelativeTime(ts))}
</div>
</div>
`;
    syncPhaseNote(alert, record);
    if (record.serial) {
      alert.querySelector('.eve-alert-footer').appendChild(buildJiraGroup(record.serial));
      alert.appendChild(repairTool.buildCard(() => repairTicketFor(alert, record.serial)));
    }
    if (clickable) {
      // Every Quick Actions row needs the serial: a card without one opens
      // Server Detail instead.
      const tab = record.serial ? buildQuickActionsTab(alert, record.serial) : null;
      if (tab) {
        alert.appendChild(tab);
      }
      alert.addEventListener('click', event => {
        if (event.target.closest(CARD_OWN_CONTROLS)) {
          return;
        }
        if (tab) {
          toggleQuickActions(alert, tab, event.detail === 0);
        } else {
          openExternal(record.detailUrl);
        }
      });
    }
    alert.querySelector('.eve-alert-close').addEventListener('click', event => {
      // The X dismisses and nothing else: the card's own click (Quick
      // Actions) never sees it, and a second press finds the card leaving.
      event.stopPropagation();
      foldIntoUndo(alert, event.detail === 0);
    });
    const serialButton = alert.querySelector('button.eve-alert-serial');
    if (serialButton && record.serial) {
      serialButton.addEventListener('click', () =>
        copyToClipboard(record.serial, serialButton)
      );
    }
    if (opts.enter && !prefersReducedMotion()) {
      // A genuinely new alert settles in once; restored and re-shown cards do not replay it.
      alert.classList.add('eve-alert-enter');
      alert.addEventListener('animationend', () => alert.classList.remove('eve-alert-enter'), {
        once: true
      });
    }
    container.insertBefore(alert, container.firstChild);
    while (container.children.length > MAX_RENDERED_ALERTS) {
      const spares = container.querySelectorAll('.eve-alert[data-debug="1"]');
      if (!spares.length) {
        break;
      }
      spares[spares.length - 1].remove();
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
<span id="eve-alert-caret">${qaIcon('chevron', 'eve-ico')}</span>
\u{1f514} JIRAlerts
<span id="eve-alert-count">(<b>0</b>)</span>
</span>
<span id="eve-alert-header-actions">
${panelSizeMarkup('alerts')}
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
<form class="eve-add-wrap" id="eve-add-form" novalidate>
<input
type="text"
id="eve-add-serial"
placeholder="Enter serial number"
aria-label="Enter serial number"
aria-describedby="eve-add-msg"
aria-keyshortcuts="Control+K Meta+K"
autocomplete="off"
spellcheck="false"
maxlength="24"
>
<button type="submit" id="eve-add-btn" title="Add a card for this serial number">+ Add card</button>
</form>
<div id="eve-add-msg" role="status" aria-live="polite" hidden></div>
</div>
<div id="eve-alert-body"></div>
<div id="eve-alert-empty" role="status" hidden></div>
`;
    container.dataset.filter = alertFilter;
    withoutObserver(() => document.body.appendChild(container));
    // Its size first: the saved position is placed at that size.
    applyPanelSize('alerts');
    setupAlertWindowUX(container);
    wirePanelSize('alerts');
    const body = document.getElementById('eve-alert-body');
    document.getElementById('eve-alert-toggle').addEventListener('click', () => {
      const opening = container.classList.contains('eve-alerts-collapsed');
      alertsOpenedByPerson = opening;
      setAlertsCollapsed(!opening);
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
      clearUndo();
      clearStoredAlerts();
      const nodes = body.querySelectorAll('.eve-alert');
      nodes.forEach(node => dismissAlertCard(node, { skipStore: true, instant: nodes.length > 6 }));
      queueAlertChrome();
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
        // The panel's outline and glow take the filter's colour (CSS).
        container.dataset.filter = alertFilter;
        applyAlertFilter();
      });
    });
    const addForm = document.getElementById('eve-add-form');
    const addInput = document.getElementById('eve-add-serial');
    const addMsg = document.getElementById('eve-add-msg');
    let addMsgTimer = 0;
    const say = (text, bad, hint) => {
      clearTimeout(addMsgTimer);
      addMsg.hidden = !text;
      addMsg.textContent = text;
      if (text && hint) {
        const chip = document.createElement('span');
        chip.className = 'eve-add-hint';
        chip.textContent = hint;
        addMsg.appendChild(chip);
      }
      addMsg.classList.toggle('eve-add-bad', !!bad);
      addInput.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (text) {
        addMsgTimer = setTimeout(() => say('', false), bad ? 9000 : 3000);
      }
    };
    addForm.addEventListener('submit', event => {
      event.preventDefault();
      const result = addManualCard(addInput.value);
      say(result.message, !result.ok, result.hint);
      if (result.ok) {
        addInput.value = '';
      }
    });
    addInput.addEventListener('input', () => {
      if (!addMsg.hidden && addMsg.classList.contains('eve-add-bad')) {
        say('', false);
      }
    });
    // Ctrl+K (Cmd+K on a Mac) jumps to the Add card box while the panel is on screen.
    document.addEventListener('keydown', event => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        String(event.key).toLowerCase() === 'k' &&
        container.getClientRects().length
      ) {
        event.preventDefault();
        alertsOpenedByPerson = true;
        setAlertsCollapsed(false);
        addInput.focus();
        addInput.select();
      }
    });
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
      const { width, height } = menu.getBoundingClientRect();
      const left = Math.min(
        Math.max(PANEL_MARGIN, anchor.right - width),
        window.innerWidth - width - PANEL_MARGIN
      );
      const below = anchor.bottom + 4;
      const top =
        below + height > window.innerHeight - PANEL_MARGIN
          ? Math.max(PANEL_MARGIN, anchor.top - 4 - height)
          : below;
      setWindowSpot(menu, Math.round(left), Math.round(top));
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

  // ===== QUICK ACTIONS TRAY =====
  // Each card has an "Actions" tab on its right edge. A click slides one
  // shared tray out of that card's right side, with the "Quick Actions" rail
  // (which folds it away again) on its far right. Its rows call what the card
  // already has: its Jira chip (ticket, search or wait page), TestView 2.0,
  // the PuTTY "ticket <serial>" command and its Send to repair row (which
  // keeps its own Send, then Confirm), then the server detail page as a small
  // extra. Like the "..." menu the tray is position: fixed inside the panel,
  // so the scrolling body cannot clip it. It re-reads its card twice a second
  // and follows it every frame, so rescans, Jira repaints and new cards never
  // reset or strand it; it closes when the card is dismissed, filtered out,
  // folded away or scrolled out.
  const QA_PATHS = {
    bolt: '<path fill="currentColor" stroke="none" d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    ext:
      '<path d="M14 4h6v6"/><path d="M20 4 10 14"/>' +
      '<path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    jira:
      '<path fill="currentColor" stroke="none" fill-rule="evenodd" ' +
      'd="M12 2 2 12l10 10 10-10zm0 5.5L16.5 12 12 16.5 7.5 12z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
    cart:
      '<path d="M3 14h13M16 14V4M13.5 4H18"/><path d="M6 14v-2.5M10 14v-2.5"/>' +
      '<circle cx="6.5" cy="17.5" r="1.8"/><circle cx="12.5" cy="17.5" r="1.8"/>',
    wrench:
      '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94' +
      'l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    doc:
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
      '<path d="M14 3v5h5M9 13h6M9 17h6"/>',
    gear:
      '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3' +
      'M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.8"/>',
    database:
      '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/>' +
      '<path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    copy:
      '<rect x="8" y="8" width="12" height="12" rx="2"/>' +
      '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    pin:
      '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M12 2a7 7 0 0 0-7 7' +
      'c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    play: '<path d="M6 4v16l14-8z"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    ticket:
      '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5' +
      'a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/>',
    rack:
      '<rect x="3" y="3" width="18" height="5" rx="1.3"/><rect x="3" y="9.5" width="18" height="5" rx="1.3"/>' +
      '<rect x="3" y="16" width="18" height="5" rx="1.3"/>' +
      '<path d="M6.5 5.5h.01M6.5 12h.01M6.5 18.5h.01M10 5.5h7.5M10 12h7.5M10 18.5h7.5"/>',
    link:
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    bell:
      '<path fill="currentColor" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
      '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellOff:
      '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/>' +
      '<path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/>' +
      '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>'
  };

  // Inline SVG only: no image requests, nothing for a page's CSP to block.
  function qaIcon(name, cls) {
    return (
      `<svg class="${cls || 'eve-qa-ico'}" width="24" height="24" viewBox="0 0 24 24" ` +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true" focusable="false">${QA_PATHS[name] || ''}</svg>`
    );
  }

  let qaTray = null;
  let qaClosing = null; // the fold-back in progress: { card, tab, focus, anim }
  let qaNote = null;
  // { card, tab, at, syncAt } while the tray is open.
  let qa = null;
  // The tray stretches to its card's height up to this, so card and tray end together.
  const QA_TRAY_RADIUS = 16;

  function buildQuickActionsTab(card, serial) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'eve-qa-tab';
    tab.title = 'Quick Actions';
    tab.setAttribute('aria-expanded', 'false');
    tab.setAttribute('aria-controls', 'eve-qa-tray');
    tab.setAttribute('aria-label', `Quick Actions for ${serial || 'this server'}`);
    tab.innerHTML =
      qaIcon('bolt', 'eve-qa-tab-ico') +
      '<span class="eve-qa-tab-label">Quick Actions</span>' +
      qaIcon('chevron', 'eve-qa-tab-chev');
    tab.addEventListener('click', event => toggleQuickActions(card, tab, event.detail === 0));
    return tab;
  }

  // A repair request waiting for its send (repairTool sets the card's
  // data-repair) is part of the tab's name; the gold pulse is CSS.
  function syncQuickActionsTab(card) {
    const tab = card.querySelector('.eve-qa-tab');
    if (!tab) {
      return;
    }
    const requested = card.dataset.repair === 'requested';
    const label =
      `Quick Actions for ${card.dataset.serial || 'this server'}` +
      (requested ? ': repair requested' : '');
    if (tab.getAttribute('aria-label') !== label) {
      tab.setAttribute('aria-label', label);
      tab.title = requested ? 'Quick Actions: repair requested' : 'Quick Actions';
    }
  }

  // The tab's click and a click on the card's background.
  function toggleQuickActions(card, tab, viaKeyboard) {
    if (qa && qa.tab === tab) {
      closeQuickActions(false);
    } else {
      openQuickActions(card, tab, viaKeyboard);
    }
  }

  // Read from the card each time, never from a saved record: rescans and
  // re-confirmations update the card, not the record the card was built from.
  function quickActionContext(card) {
    const serial = card.dataset.serial || '';
    const chip = card.querySelector('.eve-alert-jira');
    const meta = transitionMeta(card.dataset.transition);
    return {
      card: card,
      serial: serial,
      chip: chip,
      failedAt: chip ? Number(chip.dataset.failedAt) || 0 : 0,
      // The card's own (current) result, for when failedAt is not there yet.
      failure: !!(meta && meta.failure),
      passed: !!chip && chip.dataset.passed === '1',
      ticket: chip ? repairTicketFor(card, serial) : null,
      running: serial ? testViewRunningCached(serial) : null,
      repair: card.querySelector('.jstr-card')
    };
  }

  // state(context): null hides the action; { title, sub, disabled, tip }.
  // The second line only carries what changes a decision (a reply, a re-test,
  // why a row is off); a disabled row stays in view with its reason there.
  // Order = the tray's.
  const QA_PASSING_TITLES = { jira: 'Jira', putty: 'Create Ticket (PuTTY)', repair: 'Send to Repair' };

  const QUICK_ACTIONS = [
    {
      id: 'jira',
      icon: 'jira',
      external: true,
      state: c => {
        if (!c.chip || c.passed) {
          return null;
        }
        const label = c.chip.querySelector('.eve-jira-label');
        const text = label ? label.textContent.trim() : '';
        const hit = c.ticket ? jiraCached(c.serial, c.failedAt) : null;
        return {
          title: c.ticket ? `${c.ticket.key} (Jira)` : 'Jira',
          sub: c.chip.classList.contains('eve-jira-replied')
            ? 'New reply on the ticket'
            : c.ticket
              ? (hit && hit.status) || ''
              : text && text !== 'Jira'
                ? text
                : 'Search Jira for this serial',
          tip: c.chip.title
        };
      },
      // The chip's own click: wait page, reply jump and acknowledgements included.
      run: c => c.chip.click()
    },
    {
      id: 'testview',
      icon: 'monitor',
      external: true,
      state: c =>
        c.serial
          ? {
              title: 'TestView 2.0',
              sub: c.running === true ? 'Re-testing now' : '',
              tip: `Open ${c.serial} in TestView 2.0 (the latest run)`
            }
          : null,
      run: c => openTestView(c.serial, openExternal)
    },
    {
      id: 'putty',
      icon: 'terminal',
      iconDone: 'check',
      flash: true,
      external: true,
      keepOpen: true,
      // On for every failure card (test or pre-test) with a serial PuTTY takes.
      // Once its Jira ticket exists the row greys out and takes no clicks (zay);
      // a re-test or the bot's window are hints, never a lock.
      state: c => {
        if (!(c.failure || c.failedAt) || !PUTTY_COMMAND_RE.test(`ticket ${c.serial}`)) {
          return null;
        }
        if (c.ticket) {
          return {
            title: 'Create Ticket (PuTTY)',
            disabled: true,
            sub: `Ticket exists: ${c.ticket.key}`,
            tip: `${c.ticket.key} is already the ticket for this failure: no new ticket needed.`
          };
        }
        const ready = puttyHelperState() === 'ready';
        return {
          title: 'Create Ticket (PuTTY)',
          sub:
            c.running === true
              ? 'Re-testing now'
              : c.failedAt && Date.now() - c.failedAt < JIRA_CREATE_BY_HAND_MS
                ? `Bot may raise it by ${jiraByHandDue(c.failedAt)}`
                : '',
          tip: `ticket ${c.serial}: ` + (ready ? 'pastes it into PuTTY' : 'copies it for PuTTY')
        };
      },
      run: c => runPuttyTicket(c.serial)
    },
    {
      id: 'repair',
      icon: 'wrench',
      iconDone: 'check',
      external: true,
      // The card's repair row decides (repairTool.syncCard): 'requested' = a
      // Jira request still waiting for its send (gold), 'sent' = sent here or
      // seen in the SFCS queue (green, with the next step), else off.
      state: c => {
        if (!c.failedAt || !c.repair) {
          return null;
        }
        const toggle = c.repair.querySelector('.jstr-card-toggle');
        const mark = c.repair.hidden || !toggle ? '' : c.repair.dataset.state || '';
        if (!mark) {
          return {
            title: 'Send to Repair',
            disabled: true,
            sub:
              c.ticket && Date.now() < jiraAuthPausedUntil
                ? 'Sign in to Jira to check for a request'
                : 'No repair request yet',
            tip: c.ticket
              ? `Turns on when a comment on ${c.ticket.key} asks to send this unit to repair. ` +
                'Open the ticket to check for one.'
              : 'Turns on when a Jira comment asks to send this unit to repair. ' +
                'No ticket yet: search Jira or use Create Ticket (PuTTY) first.'
          };
        }
        const tip = toggle.title || 'Opens Send to repair on this card (Send, then Confirm).';
        if (c.repair.dataset.wait === 'testing') {
          return { title: 'Retesting', sub: 'Released \u{b7} Collector shows it moving on', kind: mark, tip: tip };
        }
        if (c.repair.dataset.wait === 'ready') {
          return { title: 'Ready for Retest', sub: 'Collector shows it back in SLT', kind: mark, tip: tip };
        }
        if (c.repair.dataset.wait === 'release') {
          return { title: 'Waiting for Release', sub: 'In repair \u{b7} Repair releases it for retest', kind: mark, tip: tip };
        }
        return mark === 'requested'
          ? { title: 'Send to Repair', sub: 'Repair requested \u{b7} Review and confirm', kind: mark, tip: tip }
          : { title: 'Sent to Repair', sub: c.repair.dataset.next || '', kind: mark, tip: tip };
      },
      // Opens the card's own repair box; nothing is sent from the tray.
      run: c => {
        const toggle = c.repair.querySelector('.jstr-card-toggle');
        if (toggle.getAttribute('aria-expanded') !== 'true') {
          toggle.click();
        } else {
          c.repair.scrollIntoView({ block: 'nearest' });
        }
        toggle.focus({ preventScroll: true });
      }
    }
  ];

  // PuTTY action: with the helper, paste "ticket <serial>" into the open
  // PuTTY / MobaXterm session (Enter stays with the person); without it, copy
  // the command and offer the same one-time setup as the Jira tab.
  function runPuttyTicket(serial) {
    const command = `ticket ${serial}`;
    const owner = qa;
    qaNote.textContent = '';
    if (puttyHelperState() === 'ready') {
      pastePuttyCommand(document, serial);
      flashQuickAction('putty', 'Sent');
      qaNote.textContent =
        `Pasting "${command}" into your PuTTY / MobaXterm session (if the browser asks, ` +
        'choose Open). Check it there, then press Enter.';
      return;
    }
    copyToClipboard(command, null).then(ok => {
      if (qa !== owner) {
        return;
      }
      if (ok) {
        flashQuickAction('putty', 'Copied');
      }
      // Copied: the row's own "Copied" flash is the confirmation; no note under the tray.
      qaNote.textContent = ok ? '' : `Could not copy. Type "${command}" in PuTTY, then press Enter.`;
      const row = document.createElement('div');
      row.className = 'eve-qa-putty-row';
      qaNote.appendChild(row);
      appendPuttyPaste(document, row, qaNote, command);
    });
  }

  let qaFlashTimer = 0;
  const QA_FLASH_MS = 1600;

  // A moment of green with a check and `tag` on an action row, so a click that
  // copied (or reached the paste helper) shows it did. A new click restarts it.
  function flashQuickAction(id, tag) {
    const action = QUICK_ACTIONS.find(item => item.id === id);
    const button = action && action.button;
    if (!button) {
      return;
    }
    const label = button.querySelector('.eve-qa-flash-tag');
    if (label) {
      label.textContent = tag;
    }
    clearQuickActionFlash();
    void button.offsetWidth; // restart the flash animation
    button.classList.add('eve-qa-flash');
    qaFlashTimer = setTimeout(clearQuickActionFlash, QA_FLASH_MS);
  }

  function clearQuickActionFlash() {
    clearTimeout(qaFlashTimer);
    QUICK_ACTIONS.forEach(action => {
      if (action.button) {
        action.button.classList.remove('eve-qa-flash');
      }
    });
  }

  function buildQuickActionsTray() {
    const tray = document.createElement('div');
    tray.id = 'eve-qa-tray';
    tray.setAttribute('role', 'group');
    tray.hidden = true;
    tray.innerHTML =
      '<div class="eve-qa-main"><div class="eve-qa-list"></div>' +
      '<div class="eve-qa-note" aria-live="polite"></div></div>' +
      '<button type="button" class="eve-qa-rail" title="Fold the Quick Actions away" ' +
      'aria-label="Close Quick Actions">' +
      qaIcon('bolt', 'eve-qa-rail-ico') +
      '<span class="eve-qa-rail-label">Quick Actions</span>' +
      qaIcon('chevron', 'eve-qa-rail-chev') +
      '</button>';
    const list = tray.querySelector('.eve-qa-list');
    QUICK_ACTIONS.forEach(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `eve-qa-btn eve-qa-${action.id}`;
      button.innerHTML =
        qaIcon(action.icon) +
        (action.iconDone ? qaIcon(action.iconDone, 'eve-qa-ico eve-qa-ico-done') : '') +
        '<span class="eve-qa-text"><span class="eve-qa-title"></span>' +
        '<span class="eve-qa-sub"></span></span>' +
        (action.flash ? '<span class="eve-qa-flash-tag" aria-hidden="true"></span>' : '') +
        (action.external ? qaIcon('ext', 'eve-qa-ext') : '');
      action.button = button;
      action.titleEl = button.querySelector('.eve-qa-title');
      action.subEl = button.querySelector('.eve-qa-sub');
      button.addEventListener('click', () => {
        if (!qa) {
          return;
        }
        const context = quickActionContext(qa.card);
        const state = action.state(context);
        if (!state || state.disabled) {
          syncQuickActions();
          return;
        }
        if (!action.keepOpen) {
          closeQuickActions(false);
        }
        action.run(context);
      });
      list.appendChild(button);
    });
    qaNote = tray.querySelector('.eve-qa-note');
    tray.querySelector('.eve-qa-rail').addEventListener('click', () => closeQuickActions(true));
    tray.addEventListener('keydown', event => {
      const items = [...tray.querySelectorAll('button')].filter(button => !button.hidden);
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = items[(index + step + items.length) % items.length];
        if (next) {
          next.focus();
        }
      } else if (event.key === 'Tab' && (event.shiftKey ? index <= 0 : index === items.length - 1)) {
        // Tabbing past either end hands focus back to the card's tab.
        event.preventDefault();
        closeQuickActions(true);
      }
    });
    document.addEventListener(
      'pointerdown',
      event => {
        if (!qa || tray.contains(event.target) || qa.tab.contains(event.target)) {
          return;
        }
        // The owning card's background: its click toggles the tray shut.
        if (qa.card.contains(event.target) && !event.target.closest(CARD_OWN_CONTROLS)) {
          return;
        }
        // A press on the alert panel's header may start a drag: the tray rides
        // along with its card, and only a press that stays put (a click) closes it.
        const header = document.getElementById('eve-alert-header');
        if (header && header.contains(event.target) && !event.target.closest('button, input, a')) {
          const owner = qa;
          const startX = event.clientX;
          const startY = event.clientY;
          document.addEventListener(
            'pointerup',
            up => {
              if (
                qa === owner &&
                Math.abs(up.clientX - startX) <= 4 &&
                Math.abs(up.clientY - startY) <= 4
              ) {
                closeQuickActions(false);
              }
            },
            { capture: true, once: true }
          );
          return;
        }
        closeQuickActions(false);
      },
      true
    );
    // Skips an Esc already used (search box, an open repair box or Confirm).
    document.addEventListener('keydown', event => {
      if (qa && event.key === 'Escape' && !event.defaultPrevented) {
        closeQuickActions(tray.contains(document.activeElement) || document.activeElement === qa.tab);
      }
    });
    window.addEventListener('resize', () => closeQuickActions(false));
    const container = document.getElementById('eve-alert-container');
    withoutObserver(() => container.appendChild(tray));
    qaTray = tray;
    return tray;
  }

  function openQuickActions(card, tab, viaKeyboard) {
    closeQuickActions(false);
    endQuickActionsClose();
    const tray = qaTray || buildQuickActionsTray();
    const state = { card: card, tab: tab, at: '', syncAt: 0 };
    qa = state;
    const glow = getComputedStyle(card).getPropertyValue('--eve-glow-rgb').trim();
    tray.style.setProperty('--eve-qa-rgb', glow || '47, 123, 255');
    tray.setAttribute('aria-label', `Quick Actions for ${card.dataset.serial || 'this server'}`);
    qaNote.textContent = '';
    clearQuickActionFlash();
    syncQuickActions();
    tab.setAttribute('aria-expanded', 'true');
    tray.hidden = false;
    placeQuickActions();
    if (!prefersReducedMotion() && typeof tray.animate === 'function') {
      // The tab (hidden while open) is the tray's rail: the rail leads from
      // the card's edge to the far end, the four rows are uncovered behind it.
      const slide = tray.offsetWidth - 28;
      const side = tray.dataset.side;
      const dir = side === 'left' ? 1 : -1;
      const frames =
        side === 'float'
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              {
                transform: `translateX(${dir * slide}px)`,
                clipPath: side === 'left' ? `inset(0 ${slide}px 0 0)` : `inset(0 0 0 ${slide}px)`
              },
              { transform: 'none', clipPath: 'inset(0 0 0 0)' }
            ];
      tray.animate(frames, { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
    const follow = () => {
      if (qa === state && followQuickActions()) {
        requestAnimationFrame(follow);
      }
    };
    requestAnimationFrame(follow);
    if (viaKeyboard) {
      const first = tray.querySelector('.eve-qa-btn:not([hidden])');
      if (first) {
        first.focus();
      }
    }
  }

  function closeQuickActions(focusTab) {
    if (!qa) {
      return;
    }
    const { tab, card } = qa;
    const side = qaTray.dataset.side;
    qa = null;
    endQuickActionsClose();
    tab.setAttribute('aria-expanded', 'false');
    if (!prefersReducedMotion() && typeof qaTray.animate === 'function' && !qaTray.hidden && side === 'right' && card.isConnected) {
      // The drawer folds back into the one tab: the tray's left edge stays on the
      // card's edge, its width shrinks, and the rail (last in the row) leads
      // back to it; the rows are cut off at the tray's own edge, never over the card.
      const full = qaTray.offsetWidth;
      qaTray.style.setProperty('--eve-qa-mw', `${full - 28 - 3}px`);
      qaTray.classList.add('eve-qa-folding');
      card.classList.add('eve-qa-closing');
      const anim = qaTray.animate([{ width: `${full}px` }, { width: '31px' }], {
        duration: 160,
        easing: 'cubic-bezier(.4, 0, .6, 1)',
        fill: 'forwards'
      });
      qaClosing = { card: card, tab: tab, focus: !!focusTab, anim: anim };
      anim.onfinish = endQuickActionsClose;
    } else {
      qaTray.hidden = true;
      if (focusTab && tab.isConnected) {
        tab.focus();
      }
    }
    card.removeAttribute('data-qa-open');
    card.removeAttribute('data-qa-join');
  }

  function endQuickActionsClose() {
    if (!qaClosing) {
      return;
    }
    const { card, tab, focus, anim } = qaClosing;
    qaClosing = null;
    anim.onfinish = null;
    anim.cancel();
    card.classList.remove('eve-qa-closing');
    qaTray.classList.remove('eve-qa-folding');
    qaTray.style.removeProperty('--eve-qa-mw');
    qaTray.hidden = true;
    if (focus && tab.isConnected) {
      tab.focus();
    }
  }

  // Every frame while open: close when the card is gone, hidden (filter,
  // fold) or scrolled (nearly) out of the body; otherwise stay on its card.
  function followQuickActions() {
    const body = document.getElementById('eve-alert-body');
    if (!body || !qa.card.isConnected || !qa.tab.isConnected || qa.card.offsetParent === null) {
      closeQuickActions(false);
      return false;
    }
    const card = qa.card.getBoundingClientRect();
    const view = body.getBoundingClientRect();
    if (Math.min(card.bottom, view.bottom) - Math.max(card.top, view.top) < 40) {
      closeQuickActions(false);
      return false;
    }
    if (Date.now() - qa.syncAt >= 500) {
      syncQuickActions();
    }
    const at =
      `${Math.round(card.left)},${Math.round(card.top)},${Math.round(card.height)},` +
      `${Math.round(view.top)},${qaTray.offsetHeight}`;
    if (at !== qa.at) {
      qa.at = at;
      placeQuickActions();
    }
    return true;
  }

  // Out of the card's right edge, its outline running on from the card's
  // (both go square where they meet), the rail on the far right. With no room
  // right of the card, the same out of its left edge; with room on neither
  // side (a narrow screen), floating over the card itself. Always in the window.
  function placeQuickActions() {
    // Window px: the tray's own px times the JIRAlerts size.
    const zoom = zoomOf(qaTray);
    const card = qa.card.getBoundingClientRect();
    const body = document.getElementById('eve-alert-body');
    const viewTop = body ? body.getBoundingClientRect().top : 0;
    const width = qaTray.offsetWidth * zoom;
    const edge = 1.5 * zoom; // the card's border: the tray's own border lies on it
    const side =
      card.right - edge + width <= window.innerWidth - PANEL_MARGIN
        ? 'right'
        : card.left + edge - width >= PANEL_MARGIN
          ? 'left'
          : 'float';
    qaTray.dataset.side = side;
    // The tray is as tall as its four rows, whatever the card's height.
    qaTray.style.minHeight = '';
    const height = qaTray.offsetHeight * zoom;
    const left =
      side === 'right'
        ? card.right - edge
        : side === 'left'
          ? card.left + edge - width
          : Math.min(
              Math.max(PANEL_MARGIN, card.right - width - 8 * zoom),
              window.innerWidth - width - PANEL_MARGIN
            );
    // From the middle of the card's side (the closed rail's own spot).
    const middle = card.top + (card.height - height) / 2;
    const top = Math.min(
      Math.max(side === 'float' ? card.top + 8 * zoom : middle, viewTop, PANEL_MARGIN),
      Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN)
    );
    setWindowSpot(qaTray, Math.round(left), Math.round(top));
    const r = QA_TRAY_RADIUS;
    let radius = `${r}px`;
    let join = '';
    if (side !== 'float') {
      // Card-side corners: square where they lie on the card's edge.
      const innerTop = top < card.top - 1 ? r : 0;
      const innerBottom = top + height > card.bottom + 1 ? r : 0;
      radius =
        side === 'right'
          ? `${innerTop}px ${r}px ${r}px ${innerBottom}px`
          : `${r}px ${innerTop}px ${innerBottom}px ${r}px`;
      join = [top <= card.top + 1 ? 'top' : '', top + height >= card.bottom - 1 ? 'bottom' : '']
        .filter(Boolean)
        .join(' ');
    }
    qaTray.style.borderRadius = radius;
    if (qa.card.dataset.qaOpen !== side) {
      qa.card.dataset.qaOpen = side;
    }
    if (qa.card.dataset.qaJoin !== join) {
      qa.card.dataset.qaJoin = join;
    }
  }

  function syncQuickActions() {
    qa.syncAt = Date.now();
    const context = quickActionContext(qa.card);
    const repair = qa.card.dataset.repair || '';
    if ((qaTray.dataset.repair || '') !== repair) {
      qaTray.dataset.repair = repair;
    }
    QUICK_ACTIONS.forEach(action => {
      let state = action.state(context);
      // A passing card keeps the usual set: what does not apply is greyed out
      // with its reason (the click guard already refuses a disabled action).
      if (!state && context.passed && QA_PASSING_TITLES[action.id]) {
        state = {
          title: QA_PASSING_TITLES[action.id],
          disabled: true,
          sub: 'Not needed for a passing server',
          tip: `${QA_PASSING_TITLES[action.id]}: not needed for a passing server (there is no failure to follow up).`
        };
      }
      if (action.button.hidden !== !state) {
        action.button.hidden = !state;
      }
      if (!state) {
        return;
      }
      setTextIfChanged(action.titleEl, state.title);
      setTextIfChanged(action.subEl, state.sub || '');
      const disabled = state.disabled ? 'true' : 'false';
      if (action.button.getAttribute('aria-disabled') !== disabled) {
        action.button.setAttribute('aria-disabled', disabled);
      }
      if ((action.button.dataset.state || '') !== (state.kind || '')) {
        action.button.dataset.state = state.kind || '';
      }
      if (action.button.title !== (state.tip || '')) {
        action.button.title = state.tip || '';
      }
    });
  }

  // ===== ALERT WINDOW UX (drag / snap / persistent position) =====
  const MIN_ALERT_PANEL_HEIGHT = 120;

  function syncAlertPanelHeight(container) {
    const panel = container || document.getElementById('eve-alert-container');
    if (!panel) {
      return;
    }
    const top = panel.getBoundingClientRect().top;
    const available = (window.innerHeight - top - 10) / zoomOf(panel);
    const value = `${roundOwnPx(Math.max(MIN_ALERT_PANEL_HEIGHT, available))}px`;
    if (panel.style.maxHeight !== value) {
      panel.style.maxHeight = value;
    }
  }

  function saveAlertPanelPosition(container) {
    if (!container) {
      return;
    }
    writeJSON(
      localStorage,
      ALERT_PANEL_POSITION_KEY,
      { left: windowPx(container, container.style.left), top: windowPx(container, container.style.top) },
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
    setWindowSpot(container, clamped.left, clamped.top);
    container.style.right = 'auto';
    syncAlertPanelHeight(container);
  }

  // The window room left for the panel: its title bar stays on screen.
  function alertPanelBounds(container) {
    const panel = container.getBoundingClientRect();
    const header = container.querySelector('#eve-alert-header');
    const barHeight = header ? header.getBoundingClientRect().bottom - panel.top : panel.height;
    const margin = PANEL_MARGIN;
    return {
      margin,
      maxLeft: Math.max(margin, window.innerWidth - panel.width - margin),
      maxTop: Math.max(margin, window.innerHeight - barHeight - margin)
    };
  }

  // Back inside the window after a resize or a size change (not while hidden).
  function keepAlertPanelInWindow(container) {
    if (!container.getClientRects().length) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const bounds = alertPanelBounds(container);
    const left = Math.max(bounds.margin, Math.min(rect.left, bounds.maxLeft));
    const top = Math.max(bounds.margin, Math.min(rect.top, bounds.maxTop));
    if (!container.style.left || movedPastHalfPx(rect, left, top)) {
      setWindowSpot(container, left, top);
    }
    if (container.style.right !== 'auto') {
      container.style.right = 'auto';
    }
    syncAlertPanelHeight(container);
    saveAlertPanelPosition(container);
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

    function positionHeaderFromPointer(event) {
      const bounds = alertPanelBounds(container);
      const left = Math.min(
        Math.max(bounds.margin, event.clientX - dragState.offsetX),
        bounds.maxLeft
      );
      const top = Math.min(
        Math.max(bounds.margin, event.clientY - dragState.offsetY),
        bounds.maxTop
      );
      setWindowSpot(container, left, top);
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
      const bounds = alertPanelBounds(container);
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
      setWindowSpot(container, left, top);
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
    window.addEventListener('resize', () => keepAlertPanelInWindow(container));
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
    const cards = body.querySelectorAll('.eve-alert:not([data-leaving])');
    let visible = 0;
    const chips = document.querySelectorAll('#eve-alert-filters .eve-filter-category');
    const chipCounts = {};
    chips.forEach(chip => {
      chipCounts[chip.dataset.filter] = 0;
    });
    const allowedTransitions = FILTER_TRANSITION_GROUPS[alertFilter] || [alertFilter];
    const showDebug = !!settings.developerMode;
    // Cards the operator can see: Dev-only debug / diagnostic cards count only with Dev on.
    let operatorCards = 0;
    cards.forEach(card => {
      const matchesType =
        alertFilter === 'all' || allowedTransitions.indexOf(card.dataset.transition) !== -1;
      const matchesSearch =
        !alertSearch || (card.dataset.search || '').toLowerCase().indexOf(alertSearch) !== -1;
      const matchesDebugVisibility =
        showDebug || (card.dataset.debug !== '1' && card.dataset.diagnostic !== '1');
      if (matchesDebugVisibility) {
        operatorCards += 1;
        Object.keys(chipCounts).forEach(key => {
          if (
            key === 'all' ||
            (FILTER_TRANSITION_GROUPS[key] || [key]).indexOf(card.dataset.transition) !== -1
          ) {
            chipCounts[key] += 1;
          }
        });
      }
      const show = matchesType && matchesSearch && matchesDebugVisibility;
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
    setTextIfChanged(
      document.querySelector('#eve-alert-count b'),
      visible === operatorCards ? String(operatorCards) : `${visible}/${operatorCards}`
    );
    const countBox = document.getElementById('eve-alert-count');
    const full = operatorCards >= MAX_STORED_ALERTS
      ? `Holding ${operatorCards} alerts. None are removed for you; dismiss some to keep this panel light.`
      : '';
    if (countBox && countBox.title !== full) {
      countBox.title = full;
    }
    syncAlertEmptyState(operatorCards, visible);
  }

  // null until startup has restored the saved cards; then whether the
  // operator had no cards at the last pass.
  let alertsWereEmpty = null;
  // True once the person has opened the panel since it last held a card.
  let alertsOpenedByPerson = false;

  // The empty body: "No alerts yet", or "No matching alerts" when the filter
  // or search hides every card. A sibling of #eve-alert-body, so it is never
  // counted, capped or dismissed as a card. The panel stays open (filters and
  // the Add card control visible) when its last card goes.
  function syncAlertEmptyState(operatorCards, visible) {
    const empty = operatorCards === 0;
    if (!empty) {
      alertsOpenedByPerson = false;
    }
    // Empty never folds the panel: only the person's own fold (header click)
    // does, and it is kept. A new alert still unfolds it (revealNewAlert).
    alertsWereEmpty = empty;
    const box = document.getElementById('eve-alert-empty');
    const kind = empty ? 'empty' : visible === 0 ? 'nomatch' : '';
    if (!box || box.dataset.kind === kind) {
      return;
    }
    box.dataset.kind = kind;
    box.hidden = !kind;
    box.innerHTML =
      kind === 'empty'
        ? `${qaIcon('bell', 'eve-empty-ico')}<b>No alerts yet</b>` +
          '<span>New alerts will appear here</span>'
        : kind === 'nomatch'
          ? `${qaIcon('search', 'eve-empty-ico')}<b>No matching alerts</b>`
          : '';
  }

  // ===== ALERT CONTAINER VISIBILITY =====

  // JIRAlerts stays on screen with no cards (its empty state above).
  function updateAlertContainerVisibility() {
    const container = document.getElementById('eve-alert-container');
    const body = document.getElementById('eve-alert-body');
    if (!container || !body) {
      return;
    }
    const count = body.querySelectorAll('.eve-alert:not([data-leaving])').length;
    const firstShow = container.style.display !== 'flex';
    container.style.display = 'flex';
    if (firstShow && container.style.left) {
      // Restored while hidden (no size to measure): now keep it in the window.
      keepAlertPanelInWindow(container);
    }
    syncAlertPanelHeight(container);
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
        left: windowPx(panel, panel.style.left),
        top: windowPx(panel, panel.style.top),
        collapsed: panel.classList.contains('eve-tracker-collapsed')
      },
      null
    );
  }

  // left/top and the result in window px.
  function clampToViewport(panel, left, top) {
    const margin = PANEL_MARGIN;
    const zoom = zoomOf(panel);
    const maxLeft = Math.max(margin, window.innerWidth - panel.offsetWidth * zoom - margin);
    const maxTop = Math.max(margin, window.innerHeight - panel.offsetHeight * zoom - margin);
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
        setWindowSpot(panel, clamped.left, clamped.top);
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

  // Fold / unfold of the tracker body: the measured height and the opacity
  // move together in 220 ms, the rows fading in 35 ms apart. The state (class,
  // storage) is already final when this starts; reduced motion is immediate.
  const FOLD_MS = 220;
  const FOLD_STAGGER_MS = 35;
  let foldTimer = 0;

  function foldTrackerBody(body, collapsed) {
    clearTimeout(foldTimer);
    const kids = Array.from(body.children);
    const reset = () => {
      body.style.transition = '';
      body.style.height = '';
      body.style.opacity = '';
      body.style.overflow = '';
      kids.forEach(kid => {
        kid.style.transition = '';
        kid.style.opacity = '';
      });
    };
    reset();
    if (prefersReducedMotion()) {
      body.style.display = collapsed ? 'none' : '';
      return;
    }
    const ease = 'cubic-bezier(.4, 0, .2, 1)';
    if (collapsed) {
      const from = body.offsetHeight;
      body.style.overflow = 'hidden';
      body.style.height = `${from}px`;
      void body.offsetHeight;
      body.style.transition = `height ${FOLD_MS}ms ${ease}, opacity ${FOLD_MS}ms ease`;
      body.style.height = '0px';
      body.style.opacity = '0';
      foldTimer = setTimeout(() => {
        reset();
        body.style.display = 'none';
      }, FOLD_MS + 20);
      return;
    }
    body.style.display = '';
    const to = body.scrollHeight;
    body.style.overflow = 'hidden';
    body.style.height = '0px';
    body.style.opacity = '0';
    // Only the first rows stagger in; the page dots and the GitHub footer ride with the body.
    const staggered = kids.slice(0, 4);
    staggered.forEach(kid => {
      kid.style.opacity = '0';
    });
    void body.offsetHeight;
    body.style.transition = `height ${FOLD_MS}ms ${ease}, opacity ${FOLD_MS}ms ease`;
    body.style.height = `${to}px`;
    body.style.opacity = '1';
    staggered.forEach((kid, index) => {
      kid.style.transition = `opacity ${FOLD_MS - 40}ms ease ${index * FOLD_STAGGER_MS}ms`;
      kid.style.opacity = '1';
    });
    foldTimer = setTimeout(reset, FOLD_MS + FOLD_STAGGER_MS * 4 + 40);
  }

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
      foldTrackerBody(body, collapsed);
      collapseButton.textContent = collapsed ? '\u{ff0b}' : '\u{2212}';
      collapseButton.title = collapsed ? 'Expand ' + TRACKER_LABEL : 'Collapse ' + TRACKER_LABEL;
      savePanelPosition(panel);
    });
    let dragState = null;

    function onPointerMove(event) {
      if (!dragState) {
        return;
      }
      const zoom = zoomOf(panel);
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth * zoom);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight * zoom);
      setWindowSpot(
        panel,
        Math.min(Math.max(0, event.clientX - dragState.offsetX), maxLeft),
        Math.min(Math.max(0, event.clientY - dragState.offsetY), maxTop)
      );
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
      setWindowSpot(panel, left, top);
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
      setWindowSpot(panel, rect.left, rect.top);
      panel.style.right = 'auto';
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
      event.preventDefault();
    });
    window.addEventListener('resize', () => keepTrackerInWindow(panel));
    // A placed panel that grows (its sections filling in after a reload, the
    // ETA list, unfolding) stays in the window too.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (panel.style.left && !dragState) {
          keepTrackerInWindow(panel);
        }
      }).observe(panel);
    }
  }

  function keepTrackerInWindow(panel) {
    const rect = panel.getBoundingClientRect();
    const clamped = clampToViewport(panel, rect.left, rect.top);
    if (!panel.style.left || movedPastHalfPx(rect, clamped.left, clamped.top)) {
      setWindowSpot(panel, clamped.left, clamped.top);
    }
    if (panel.style.right !== 'auto') {
      panel.style.right = 'auto';
    }
  }

  // A bounds check that lands within half a pixel of where the panel is
  // leaves it alone: rewriting the same spot through a fractional size only
  // nudges it by rounding.
  function movedPastHalfPx(rect, left, top) {
    return Math.abs(rect.left - left) > 0.5 || Math.abs(rect.top - top) > 0.5;
  }

  // ===== PANEL SIZE (- / + on each panel) =====
  // JIRAlerts and the tracker each have their own size, 50-100% in 10% steps
  // (70% to start), kept in the settings. A size scales the whole panel with CSS zoom (text,
  // gaps and buttons, and with them its "..." menu, Quick Actions tray or HYVE
  // tab), so the layout stays the same, only smaller or larger. The size shown
  // never passes the largest that fits the window: a smaller window steps the
  // panel down, and the chosen size comes back when there is room again.
  // Geometry stays in window px: inside a zoomed panel an element's own px
  // (style left/top, offsetWidth/Height) are its window px divided by the size.
  const PANEL_SIZES = {
    // The room (own px) a size must fit in the window: JIRAlerts' title bar,
    // toolbar and one card; the tracker's top part with the HYVE tab beside it.
    alerts: { id: 'eve-alert-container', key: 'alertSize', name: 'JIRAlerts', width: 462, height: 380 },
    tracker: { id: 'eve-tracker-panel', key: 'trackerSize', name: 'Tracker', width: 400, height: 260 }
  };
  // Panel id -> the zoom it shows now: the CSS fallback until a size is applied.
  const panelZoom = {
    'eve-alert-container': PANEL_SIZE_DEFAULT / 100,
    'eve-tracker-panel': PANEL_SIZE_DEFAULT / 100
  };

  function zoomOf(el) {
    const panel = el && el.closest('#eve-alert-container, #eve-tracker-panel');
    return (panel && panelZoom[panel.id]) || 1;
  }

  // Writes a spot in window px as the element's own left/top.
  function setWindowSpot(el, left, top) {
    const zoom = zoomOf(el);
    const x = `${roundOwnPx(left / zoom)}px`;
    const y = `${roundOwnPx(top / zoom)}px`;
    if (el.style.left !== x) {
      el.style.left = x;
    }
    if (el.style.top !== y) {
      el.style.top = y;
    }
  }

  // Own px to 0.01: a window px / size division (16.666666666666668) stays
  // the same string every time, so an unchanged spot is never rewritten.
  function roundOwnPx(px) {
    return Math.round(px * 100) / 100;
  }

  // An own-px left/top in window px, for saving ('' stays '').
  function windowPx(el, value) {
    const px = Number.parseFloat(value);
    return Number.isFinite(px) ? `${Math.round(px * zoomOf(el))}px` : value;
  }

  // The largest whole step at which the panel fits the window.
  function panelSizeCap(spec) {
    const fit = Math.min(
      (window.innerWidth - 2 * PANEL_MARGIN) / spec.width,
      (window.innerHeight - 2 * PANEL_MARGIN) / spec.height
    );
    const size = Math.floor((fit * 100) / PANEL_SIZE_STEP + 1e-6) * PANEL_SIZE_STEP;
    return Math.max(PANEL_SIZE_MIN, Math.min(PANEL_SIZE_MAX, size));
  }

  function panelSizeMarkup(which) {
    const name = PANEL_SIZES[which].name;
    return (
      `<span class="eve-size-ctl" role="group" aria-label="${name} size" data-size-for="${which}">` +
      `<button type="button" class="eve-size-step" data-step="-1" aria-label="Smaller ${name}">\u{2212}</button>` +
      `<button type="button" class="eve-size-pct">${PANEL_SIZE_DEFAULT}%</button>` +
      `<button type="button" class="eve-size-step" data-step="1" aria-label="Larger ${name}">+</button>` +
      '</span>'
    );
  }

  // Shows the panel at its saved size, capped to the window. A panel placed
  // by left/top keeps its top and the window edge it sits at (a free-standing
  // one its centre), then stays in the window.
  function applyPanelSize(which) {
    const spec = PANEL_SIZES[which];
    const panel = document.getElementById(spec.id);
    if (!panel || !settings) {
      return;
    }
    const cap = panelSizeCap(spec);
    const size = Math.min(settings[spec.key], cap);
    const before = panelZoom[spec.id] || 1;
    const zoom = size / 100;
    if (zoom !== before) {
      const old = panel.style.left && panel.getClientRects().length ? panel.getBoundingClientRect() : null;
      panelZoom[spec.id] = zoom;
      panel.style.setProperty('--eve-ui-zoom', String(zoom));
      if (old) {
        const width = panel.getBoundingClientRect().width;
        const edge = PANEL_MARGIN + PANEL_SNAP_DISTANCE;
        const left =
          old.left <= edge
            ? old.left
            : window.innerWidth - old.right <= edge
              ? old.right - width
              : old.left + (old.width - width) / 2;
        setWindowSpot(panel, left, old.top);
        if (which === 'alerts') {
          keepAlertPanelInWindow(panel);
        } else {
          keepTrackerInWindow(panel);
        }
      } else if (which === 'alerts') {
        syncAlertPanelHeight(panel);
      }
    }
    const ctl = document.querySelector(`.eve-size-ctl[data-size-for="${which}"]`);
    if (!ctl) {
      return;
    }
    const [smaller, reset, larger] = ctl.querySelectorAll('button');
    setTextIfChanged(reset, `${size}%`);
    reset.title =
      size < settings[spec.key]
        ? `${size}% is the largest that fits this window. Click for ${PANEL_SIZE_DEFAULT}%`
        : `Click for ${PANEL_SIZE_DEFAULT}%`;
    reset.setAttribute('aria-label', `${spec.name} size ${size}%, reset to ${PANEL_SIZE_DEFAULT}%`);
    smaller.setAttribute('aria-disabled', String(size <= PANEL_SIZE_MIN));
    smaller.title = size <= PANEL_SIZE_MIN ? 'Smallest size' : 'Smaller';
    larger.setAttribute('aria-disabled', String(size >= cap));
    larger.title =
      size >= PANEL_SIZE_MAX ? 'Largest size' : size >= cap ? 'Largest size for this window' : 'Larger';
  }

  function wirePanelSize(which) {
    const spec = PANEL_SIZES[which];
    const ctl = document.querySelector(`.eve-size-ctl[data-size-for="${which}"]`);
    if (!ctl) {
      return;
    }
    ctl.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.getAttribute('aria-disabled') === 'true') {
        return;
      }
      const shown = Math.min(settings[spec.key], panelSizeCap(spec));
      const step = Number(button.dataset.step) || 0;
      settings[spec.key] = coercePanelSize(step ? shown + step * PANEL_SIZE_STEP : PANEL_SIZE_DEFAULT);
      saveSettings();
      applyPanelSize(which);
      const panel = document.getElementById(spec.id);
      if (which === 'tracker' && panel && panel.style.left) {
        savePanelPosition(panel);
      }
    });
    window.addEventListener('resize', () => applyPanelSize(which));
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
    // Its size first: the saved position is placed at that size.
    applyPanelSize('tracker');
    setupTrackerWindowUX(panel);
    wirePanelSize('tracker');
    addProfileNavigation(panel);
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
    wireButton('eve-debug-motion', () => watchPanelMotion(20000));
    wireButton('eve-clear-log', () => clearAlertLog());
  }

  // Dev: every frame for a while, where JIRAlerts, its first card, its card
  // list scroll and the tracker sit, plus style writes on the two panels.
  // Anything that moved more than half a pixel is reported with its range.
  function watchPanelMotion(ms) {
    const out = document.getElementById('eve-motion-result');
    const button = document.getElementById('eve-debug-motion');
    if (!out || !button || button.getAttribute('aria-disabled') === 'true') {
      return;
    }
    const alerts = document.getElementById('eve-alert-container');
    const tracker = document.getElementById('eve-tracker-panel');
    const body = document.getElementById('eve-alert-body');
    const watched = [alerts, tracker].filter(Boolean);
    const ranges = {};
    const note = (name, value) => {
      const r = ranges[name] || (ranges[name] = { min: value, max: value, changes: 0, last: value });
      if (Math.abs(value - r.last) > 0.5) {
        r.changes += 1;
        r.last = value;
      }
      r.min = Math.min(r.min, value);
      r.max = Math.max(r.max, value);
    };
    let writes = 0;
    const observer = new MutationObserver(list => {
      writes += list.filter(m => watched.includes(m.target)).length;
    });
    watched.forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['style'] }));
    button.setAttribute('aria-disabled', 'true');
    setTextIfChanged(out, `Watching for ${Math.round(ms / 1000)} s\u{2026} leave the page idle.`);
    const start = performance.now();
    let frames = 0;
    const frame = now => {
      frames += 1;
      if (alerts && alerts.getClientRects().length) {
        const rect = alerts.getBoundingClientRect();
        note('JIRAlerts top', rect.top);
        note('JIRAlerts height', rect.height);
        const card = body && body.querySelector('.eve-alert:not([data-leaving])');
        if (card && card.offsetParent !== null) {
          const c = card.getBoundingClientRect();
          note('first card top', c.top);
          note('first card height', c.height);
        }
        if (body) {
          note('card list scroll', body.scrollTop);
        }
      }
      if (tracker && tracker.getClientRects().length) {
        note('tracker top', tracker.getBoundingClientRect().top);
      }
      if (now - start < ms) {
        requestAnimationFrame(frame);
        return;
      }
      observer.disconnect();
      button.setAttribute('aria-disabled', 'false');
      const moved = Object.entries(ranges)
        .filter(([, r]) => r.max - r.min > 0.5)
        .map(([name, r]) => `${name} ${r.min.toFixed(1)}\u{2013}${r.max.toFixed(1)} px (${r.changes} moves)`);
      const text =
        (moved.length
          ? `Moved: ${moved.join('; ')}.`
          : `Still: nothing moved more than half a pixel in ${frames} frames.`) +
        ` ${writes} style write${writes === 1 ? '' : 's'} on the panels.`;
      setTextIfChanged(out, text);
      log(`Panel motion check (${Math.round(ms / 1000)} s): ${text}`);
    };
    requestAnimationFrame(frame);
  }

  // ===== BUILD SECTION CONTROLS =====
  let renderedSectionSignature = null;

  function buildTrackerPanelMarkup() {
    return `
<div class="eve-panel-title">
<span class="eve-title-icon" aria-hidden="true">${qaIcon('rack', 'eve-ico')}</span>
<div class="eve-title-info">
<div class="eve-title-name">${TRACKER_LABEL}</div>
<div class="eve-title-meta">
<span class="eve-title-by">by Zay Davidson</span> <span class="eve-version">v${SCRIPT_VERSION}</span>
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
<div class="eve-section-title eve-section-title-row">
<span>Tracker Controls</span>
${panelSizeMarkup('tracker')}
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
<span title="Units testing now (pre-test and test), live from the rack colours">Tests</span>
<span title="Failed units (pre-test and test fails together)">Fails</span>
<span title="Passed units">Passes</span>
</div>
<div id="eve-section-list"></div>
</div>
<details id="eve-eta-card" class="eve-eta-card" hidden>
<summary id="eve-eta-summary"><span class="eve-eta-head">
<span class="eve-eta-count"></span><span class="eve-eta-lead"></span></span>
<span class="eve-eta-next"></span></summary>
<div class="eve-eta-sub">Estimates from typical SLT duration.</div>
<div id="eve-eta-body">
<details id="eve-eta-overdue" class="eve-eta-overdue" hidden>
<summary id="eve-eta-overdue-sum">Overdue servers (<span id="eve-eta-overdue-n">0</span>)</summary>
<div class="eve-eta-overdue-tools"><button type="button" id="eve-eta-clear"
title="Hide these overdue estimates for their current runs. Nothing is started, dismissed or deleted.">Clear overdue</button>
<span>Estimates, not results.</span></div>
<div id="eve-eta-overdue-list"></div>
</details>
<div id="eve-eta-list"></div>
</div>
</details>
<div id="eve-eta-list"></div>
</div>
</details>
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
<div class="eve-refresh-status"
id="eve-pages-status">
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
<option value="jira">Jira ticket</option>
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
Card Jira buttons open the most recently updated ticket for the serial, using this browser's Jira
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
<div class="eve-dev-label">Refresh and logging</div>
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
${qaIcon('doc', 'eve-ico eve-shift-icon')}
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
<div class="eve-dev-label">Panel motion check</div>
<div class="eve-dev-row">
<span class="eve-dev-note">Leave the page idle while it watches JIRAlerts and the tracker.</span>
<button id="eve-debug-motion"
class="eve-dev-btn"
title="Measures both panels and the first card every frame for 20 seconds">
Watch 20 s
</button>
</div>
<div class="eve-debug-hint" id="eve-motion-result" role="status"></div>
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
    const clearEta = document.getElementById('eve-eta-clear');
    if (clearEta) {
      clearEta.addEventListener('click', clearOverdueEta);
    }
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

  // Blue only for a true aggregate: every section shown / hidden / watched / unwatched.
  function syncBulkButtons() {
    const states = [...document.querySelectorAll('#eve-section-list .eve-section-row')].map(row =>
      getSectionSettings(row.dataset.section)
    );
    const every = (prop, value) => states.length > 0 && states.every(item => !!item[prop] === value);
    [
      ['eve-show-all', every('show', true)],
      ['eve-hide-all', every('show', false)],
      ['eve-watch-all', every('watch', true)],
      ['eve-watch-none', every('watch', false)]
    ].forEach(([id, on]) => {
      const button = document.getElementById(id);
      if (button) {
        button.classList.toggle('eve-btn-primary', on);
        button.setAttribute('aria-pressed', String(on));
      }
    });
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
      syncBulkButtons();
      return;
    }
    renderedSectionSignature = signature;
    list.innerHTML = '';
    sections.forEach(section => {
      const sectionSettings = getSectionSettings(section);
      const row = document.createElement('div');
      row.className = 'eve-section-row';
      row.dataset.section = section;
      // One grid row: name, Show switch, Notifs bell (green = on, grey and
      // slashed = off), then the live Tests / Fails / Passes counts.
      row.innerHTML = `
<span class="eve-section-name">${escapeHtml(section)}</span>
<label class="eve-switch" title="Show ${escapeHtml(section)} on the page">
<input
type="checkbox"
class="eve-show-checkbox"
aria-label="Show ${escapeHtml(section)}"
>
</label>
<label class="eve-bell" title="Desktop notifications for ${escapeHtml(section)}">
<input
type="checkbox"
class="eve-watch-checkbox"
aria-label="Notifications for ${escapeHtml(section)}"
>
${qaIcon('bell', 'eve-bell-on')}${qaIcon('bellOff', 'eve-bell-off')}
</label>
<span class="eve-section-stats">
<span class="eve-stat eve-stat-testing"><b></b></span>
<span class="eve-stat eve-stat-failed"><b></b></span>
<span class="eve-stat eve-stat-passed"><b></b></span>
</span>
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
        syncBulkButtons();
        applyVisibility();
        redrawRunningEta();
      });
      watchCheckbox.addEventListener('change', () => {
        sectionSettings.watch = watchCheckbox.checked;
        saveSettings();
        syncBulkButtons();
        // One light ring, only when turning notifications on (never delays the save).
        const bell = watchCheckbox.closest('.eve-bell');
        if (bell && watchCheckbox.checked && !prefersReducedMotion()) {
          bell.classList.remove('eve-bell-ring');
          void bell.offsetWidth;
          bell.classList.add('eve-bell-ring');
          setTimeout(() => bell.classList.remove('eve-bell-ring'), 320);
        }
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
    syncBulkButtons();
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
    redrawRunningEta();
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
        // Every section in the table hidden: the table goes too, so no lone
        // Unit column is left. A table with any shown section keeps its columns.
        const allHidden = visibility.every(entry => !entry.visible);
        if (allHidden !== (group.table.dataset.eveAllHidden === '1')) {
          group.table.dataset.eveAllHidden = allHidden ? '1' : '';
          group.table.style.display = allHidden ? 'none' : '';
        }
      });
      if (ON_LIVE_DASHBOARD) {
        applyDashboardVisibility();
      }
    });
  }

  // ===== CSS =====

  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = `
/* 3.0.1 look (3.0.0 design), from zay's mock-ups and handoffs: dark navy panels, a blue neon
   tracker, JIRAlerts lit in its filter's colour, cyan headings. */
#eve-tracker-panel, #eve-alert-container {
  --eve-font: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif;
  --eve-mono: "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace;
  --eve-text: #e8ecf5;
  --eve-muted: #9aa5bd;
  --eve-cyan: #38c6ff;
  --eve-line: rgba(120, 150, 255, .12);
  --eve-line-strong: rgba(120, 150, 255, .24);
  --eve-control: rgba(120, 150, 255, .08);
  --eve-control-hover: rgba(120, 150, 255, .16);
  --eve-blue: #1f7aff;
  --eve-panel-bg: linear-gradient(180deg, #0d1531 0, #090c1f 160px);
  --eve-panel-edge: rgba(64, 145, 255, .85);
  --eve-panel-glow: 0 0 0 1px rgba(47, 123, 255, .2), 0 0 26px rgba(47, 123, 255, .45),
    0 18px 50px rgba(0, 0, 0, .55);
}
#eve-tracker-panel.eve-tracker-window { min-width: 300px; max-width: 520px; }
#eve-tracker-panel .eve-panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
#eve-tracker-panel .eve-collapse-btn {
  flex: 0 0 auto;
  width: 32px;
  height: 30px;
  padding: 0;
  margin: 0;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  background: #0b1430;
  color: var(--eve-text);
  font-size: 18px;
  font-weight: bold;
  line-height: 28px;
  cursor: pointer;
}
#eve-tracker-panel .eve-collapse-btn:hover { background: var(--eve-control-hover); }
#eve-tracker-panel.eve-tracker-collapsed { width: 372px; }
/* --eve-ui-zoom: the panel's own - / + size (applyPanelSize). Window-based
   lengths are divided by it, so they still mean window px once zoomed. */
#eve-tracker-panel {
  position: fixed;
  zoom: var(--eve-ui-zoom, .7);
  top: calc(10px / var(--eve-ui-zoom, .7));
  right: calc(10px / var(--eve-ui-zoom, .7));
  width: 372px;
  /* 90vh plus its padding and border (27px), as at 100%. */
  max-height: calc((90vh + 27px) / var(--eve-ui-zoom, .7) - 27px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, .18) transparent;
  z-index: 2147483646;
  background: var(--eve-panel-bg) #090c1f;
  color: var(--eve-text);
  border: 1.5px solid var(--eve-panel-edge);
  border-radius: 18px;
  padding: 12px 13px;
  font-family: var(--eve-font);
  font-size: 13px;
  box-shadow: var(--eve-panel-glow);
}
.eve-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: .005em;
  margin: 0 -13px 4px;
  padding: 0 13px 11px;
  border-bottom: 1px solid var(--eve-line);
}
.eve-panel-title { transition: margin-bottom .22s cubic-bezier(.4, 0, .2, 1), padding-bottom .22s cubic-bezier(.4, 0, .2, 1), border-bottom-color .22s ease; }
.eve-tracker-collapsed .eve-panel-title { margin-bottom: 0; padding-bottom: 0; border-bottom-color: transparent; }
/* The body always keeps its own margins (it is clipped while it folds), so nothing shifts when the fold ends. */
.eve-tracker-body { display: flow-root; }
.eve-title-icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: #3b8cff;
  filter: drop-shadow(0 0 6px rgba(59, 140, 255, .7));
}
.eve-title-icon .eve-ico { width: 32px; height: 32px; stroke-width: 1.7; }
/* The name keeps its room when a chip shares the open header (Dev, health). Folded,
   the icon stays and is a little smaller, so the name, version and chips all fit. */
#eve-tracker-panel.eve-developer-enabled:not(.eve-tracker-collapsed) .eve-title-icon,
#eve-tracker-panel:not(.eve-tracker-collapsed) .eve-panel-title:has(.eve-health-chip:not(.eve-health-ok)) .eve-title-icon { display: none; }
#eve-tracker-panel.eve-tracker-collapsed .eve-panel-title { gap: 7px; }
#eve-tracker-panel.eve-tracker-collapsed .eve-title-icon .eve-ico { width: 28px; height: 28px; }
.eve-title-info { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.eve-title-name { line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.eve-title-meta { margin-top: 3px; font-size: 12px; font-weight: normal; color: var(--eve-muted); white-space: nowrap; }
.eve-title-by { font-weight: 700; }
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
.eve-badge-on { background: #16a34a; color: #fff; box-shadow: 0 0 10px rgba(22, 163, 74, .45); }
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
  gap: 10px;
  padding: 11px 14px 12px;
  background: transparent;
  border-bottom: 1px solid rgba(var(--eve-filter-rgb), .16);
}
.eve-alerts-collapsed #eve-alert-toolbar { display: none; }
#eve-alert-filters { display: flex; gap: 7px; flex-wrap: wrap; }
.eve-filter-btn {
  background: #0b1530;
  color: #dbe3f4;
  border: 1px solid rgba(110, 140, 220, .34);
  border-radius: 999px;
  padding: 0 15px;
  font-family: var(--eve-font);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background .12s, border-color .12s, color .12s, box-shadow .12s, transform .12s;
}
.eve-filter-btn:active { transform: scale(.96); }
.eve-filter-btn[data-filter="TEST_FAILURE"] { border-color: rgba(255, 64, 140, .5); }
.eve-filter-btn:hover { background: #142846; border-color: rgba(120, 160, 240, .65); color: #fff; }
.eve-filter-btn.eve-filter-active {
  background: linear-gradient(180deg, #2b86ff, #0a6cff);
  border-color: #4d9bff;
  color: #fff;
  box-shadow: 0 0 12px rgba(10, 108, 255, .55);
}
.eve-filter-btn:focus-visible { outline: 2px solid #9cc4ff; outline-offset: 2px; }
.eve-filter-btn { display: inline-flex; align-items: center; height: 30px; box-sizing: border-box; }
.eve-chip-count {
  display: inline-block;
  min-width: 8px;
  margin-left: 8px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .12);
  font-size: 11.5px;
  font-weight: 700;
  line-height: 19px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.eve-chip-count:empty { display: none; }
.eve-chip-count:not(:empty) { animation: eve-chip-pop .2s cubic-bezier(.2, .9, .3, 1.3); }
@keyframes eve-chip-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
.eve-filter-btn[data-filter="TEST_FAILURE"] .eve-chip-count {
  background: #c8105f;
  color: #fff;
}
.eve-filter-btn[data-filter="PRETEST_FAILURE"] .eve-chip-count {
  background: #8f1d36;
  color: #ffd6de;
}
.eve-filter-btn[data-filter="TEST_SUCCESS"] .eve-chip-count {
  background: rgba(9, 230, 138, .28);
  color: #c9fbe5;
}
.eve-filter-btn.eve-filter-active .eve-chip-count { background: #5cb0ff; color: #fff; }
#eve-tracker-panel:not(.eve-developer-enabled) .eve-dev-only { display: none !important; }
.eve-search-wrap { position: relative; display: block; }
#eve-alert-toolbar .eve-search-ico {
  position: absolute;
  top: 50%;
  left: 12px;
  width: 17px;
  height: 17px;
  transform: translateY(-50%);
  color: #a9b8d8;
  pointer-events: none;
}
#eve-alert-search {
  width: 100%;
  height: 38px;
  box-sizing: border-box;
  background: #070f24;
  color: var(--eve-text);
  border: 1px solid rgba(110, 140, 220, .34);
  border-radius: 11px;
  padding: 0 70px 0 38px;
  font-family: var(--eve-font);
  font-size: 13.5px;
  outline: none;
  transition: border-color .12s, box-shadow .12s;
}
#eve-alert-search::placeholder { color: #8391b3; }
.eve-add-wrap { display: flex; gap: 8px; align-items: stretch; }
#eve-add-serial {
  flex: 1 1 auto;
  min-width: 0;
  height: 38px;
  box-sizing: border-box;
  background: #070f24;
  color: var(--eve-text);
  border: 1px solid rgba(110, 140, 220, .34);
  border-radius: 11px;
  padding: 0 12px;
  font-family: var(--eve-font);
  font-size: 13.5px;
  outline: none;
  transition: border-color .12s, box-shadow .12s;
}
#eve-add-serial::placeholder { color: #8391b3; }
#eve-add-serial:hover:not(:focus) { border-color: rgba(120, 160, 240, .6); }
#eve-add-serial:focus { border-color: #4d9bff; box-shadow: 0 0 0 3px rgba(47, 123, 255, .25); }
#eve-add-serial[aria-invalid="true"] { border-color: #ff6b81; }
#eve-add-btn {
  flex: 0 0 auto;
  height: 38px;
  box-sizing: border-box;
  padding: 0 14px;
  border-radius: 11px;
  border: 1px solid #4d9bff;
  background: linear-gradient(180deg, #2b86ff, #0a6cff);
  color: #fff;
  font-family: var(--eve-font);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  transition: filter .12s, transform .12s;
}
#eve-add-btn:hover { filter: brightness(1.12); }
#eve-add-btn:active { transform: scale(.97); }
#eve-add-btn:focus-visible { outline: 2px solid #9cc4ff; outline-offset: 2px; }
#eve-add-msg { margin-top: -4px; font-size: 12px; color: #9fe8c4; }
#eve-add-msg.eve-add-bad { color: #ff9aa9; }
#eve-add-msg[hidden] { display: none; }
.eve-add-hint { display: inline-block; margin-left: 6px; padding: 1px 8px; border: 1px solid rgba(250, 204, 21, .55); border-radius: 999px; background: rgba(250, 204, 21, .1); color: #ffe9a8; font-size: 11px; font-weight: 600; white-space: nowrap; }
#eve-alert-search:hover:not(:focus) { border-color: rgba(120, 160, 240, .6); }
#eve-alert-search:focus { border-color: #4d9bff; box-shadow: 0 0 0 3px rgba(47, 123, 255, .25); }
.eve-search-kbd {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  padding: 2px 8px;
  border: 1px solid rgba(120, 150, 255, .3);
  border-radius: 7px;
  background: rgba(120, 150, 255, .1);
  color: #c3cde6;
  font-family: var(--eve-font);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 17px;
  white-space: nowrap;
  pointer-events: none;
}
#eve-alert-search:not(:placeholder-shown) ~ .eve-search-kbd { display: none; }
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
/* HYVE Quick Links: a side tab on the tracker's outer edge (left, or right when
   only the right has room) that slides the honeycomb out. A fixed child of the
   panel, so the panel's own scrolling never clips it; placeHyveDock keeps it on
   the panel. The tab and the open drawer share one cyan outline, open on the
   panel's side. */
#eve-hyve-dock {
  position: fixed;
  top: 0;
  left: 0;
  display: flex;
  align-items: flex-start;
  width: max-content;
  box-sizing: border-box;
  border: 1.5px solid rgba(34, 211, 238, .62);
  border-right: 0;
  border-radius: 14px 0 0 14px;
  background: var(--eve-panel-bg) #090c1f;
  color: var(--eve-text);
  font-family: var(--eve-font);
  box-shadow: -4px 0 14px -2px rgba(34, 211, 238, .3), -10px 14px 30px -8px rgba(0, 0, 0, .55);
}
#eve-hyve-dock[data-side="right"] {
  flex-direction: row-reverse;
  border-right: 1.5px solid rgba(34, 211, 238, .62);
  border-left: 0;
  border-radius: 0 14px 14px 0;
  box-shadow: 4px 0 14px -2px rgba(34, 211, 238, .3), 10px 14px 30px -8px rgba(0, 0, 0, .55);
}
#eve-hyve-dock .eve-hyve-tab {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 30px;
  height: 168px;
  box-sizing: border-box;
  margin: 0;
  padding: 10px 0 9px;
  border: 0;
  border-radius: 12.5px 0 0 12.5px;
  background: linear-gradient(90deg, rgba(34, 211, 238, .16), rgba(34, 211, 238, .04));
  color: #e6fbff;
  font-family: var(--eve-font);
  cursor: pointer;
  transition: background .15s;
}
#eve-hyve-dock[data-side="right"] .eve-hyve-tab {
  border-radius: 0 12.5px 12.5px 0;
  background: linear-gradient(270deg, rgba(34, 211, 238, .16), rgba(34, 211, 238, .04));
}
#eve-hyve-dock .eve-hyve-tab:hover,
#eve-hyve-dock .eve-hyve-tab:focus-visible,
#eve-hyve-dock[data-open] .eve-hyve-tab { background: rgba(34, 211, 238, .2); outline: none; }
#eve-hyve-dock .eve-hyve-tab:focus-visible { box-shadow: inset 0 0 0 2px #fff; }
/* Open: the tab becomes the drawer's far edge, its full height. */
#eve-hyve-dock[data-open] .eve-hyve-tab { align-self: stretch; height: auto; min-height: 168px; }
.eve-hyve-tab-ico { width: 18px; height: 18px; color: #22d3ee; filter: drop-shadow(0 0 4px rgba(34, 211, 238, .7)); }
.eve-hyve-tab-label {
  writing-mode: vertical-rl;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .03em;
  line-height: 1;
  white-space: nowrap;
}
/* The chevron points the way the drawer goes: out when closed, back when open. */
.eve-hyve-tab-chev { width: 14px; height: 14px; color: var(--eve-muted); transform: rotate(180deg); transition: transform .15s; }
#eve-hyve-dock[data-open] .eve-hyve-tab-chev,
#eve-hyve-dock[data-side="right"] .eve-hyve-tab-chev { transform: none; }
#eve-hyve-dock[data-side="right"][data-open] .eve-hyve-tab-chev { transform: rotate(180deg); }
/* Tracker folded to its title: the closed tab is just its icon. */
#eve-hyve-dock[data-compact]:not([data-open]) .eve-hyve-tab {
  height: calc(var(--eve-dock-h, 61px) - 3px);
  justify-content: center;
  padding: 0;
  border-radius: 16.5px 0 0 16.5px;
}
#eve-hyve-dock[data-compact][data-side="right"]:not([data-open]) .eve-hyve-tab { border-radius: 0 16.5px 16.5px 0; }
/* Folded and closed, the tab is the folded header's own end: the same height, one
   rounded outline together, the header squared where they join. */
#eve-hyve-dock[data-compact]:not([data-open]) { border-radius: 18px 0 0 18px; }
#eve-hyve-dock[data-compact][data-side="right"]:not([data-open]) { border-radius: 0 18px 18px 0; }
#eve-tracker-panel.eve-dock-flush-left { border-top-left-radius: 0; border-bottom-left-radius: 0; }
#eve-tracker-panel.eve-dock-flush-right { border-top-right-radius: 0; border-bottom-right-radius: 0; }
#eve-hyve-dock[data-compact]:not([data-open]) .eve-hyve-tab-label,
#eve-hyve-dock[data-compact]:not([data-open]) .eve-hyve-tab-chev { display: none; }
/* Open beside the folded tracker it outgrows: its own outline all round. */
#eve-hyve-dock[data-compact][data-open] { border: 1.5px solid rgba(34, 211, 238, .62); border-radius: 14px; }
#eve-hyve-dock .eve-hyve-drawer {
  flex: 0 0 auto;
  width: 308px;
  box-sizing: border-box;
  padding: 11px 8px 14px 4px;
  border-left: 1px solid rgba(34, 211, 238, .22);
  color: var(--eve-muted);
  animation: eve-hyve-in .16s ease-out;
}
#eve-hyve-dock[data-side="right"] .eve-hyve-drawer { padding: 11px 4px 14px 8px; border-left: 0; border-right: 1px solid rgba(34, 211, 238, .22); }
#eve-hyve-dock .eve-hyve-drawer[hidden] { display: none; }
.eve-hyve-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 2px 8px;
  color: var(--eve-text);
  font-size: 13.5px;
  font-weight: 700;
}
/* Seam mode: the tab is the tracker header's height and sits on the panel's edge;
   the drawer opens outward from it, one shared outline. */
#eve-hyve-dock[data-seam] { flex-direction: row-reverse; }
#eve-hyve-dock[data-seam][data-side="right"] { flex-direction: row; }
#eve-hyve-dock[data-seam] .eve-hyve-tab {
  height: calc(var(--eve-dock-h, 61px) - 3px);
  justify-content: center;
  padding: 0;
}
#eve-hyve-dock[data-seam] .eve-hyve-tab-label,
#eve-hyve-dock[data-seam] .eve-hyve-tab-chev { display: none; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-tab {
  align-self: flex-start;
  height: calc(var(--eve-dock-h, 61px) - 3px);
  min-height: 0;
  border-radius: 0;
}
#eve-hyve-dock[data-seam] .eve-hyve-drawer { border-left: 0; border-right: 1px solid rgba(34, 211, 238, .22); animation-name: eve-hyve-in-right; }
#eve-hyve-dock[data-seam][data-side="right"] .eve-hyve-drawer { border-right: 0; border-left: 1px solid rgba(34, 211, 238, .22); animation-name: eve-hyve-in; }
#eve-hyve-dock[data-seam][data-compact][data-open] { border: 1.5px solid rgba(34, 211, 238, .62); border-radius: 14px 0 0 14px; border-right: 0; }
#eve-hyve-dock[data-seam][data-compact][data-open][data-side="right"] { border: 1.5px solid rgba(34, 211, 238, .62); border-radius: 0 14px 14px 0; border-left: 0; }
/* Open: the link icon heads the drawer at its outer corner, beside "HYVE Quick Links (7)". */
#eve-hyve-dock[data-seam][data-open] { flex-direction: row; }
#eve-hyve-dock[data-seam][data-open][data-side="right"] { flex-direction: row-reverse; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-tab { border-radius: 12.5px 0 0 0; }
#eve-hyve-dock[data-seam][data-open][data-side="right"] .eve-hyve-tab { border-radius: 0 12.5px 0 0; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-drawer { border-right: 0; border-left: 0; animation-name: eve-hyve-in; }
#eve-hyve-dock[data-seam][data-open][data-side="right"] .eve-hyve-drawer { animation-name: eve-hyve-in-right; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-head { min-height: calc(var(--eve-dock-h, 61px) - 3px); margin: -11px 2px 4px 0; padding-left: 8px; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-head > .eve-ico { display: none; }
/* The tab is only the header-height square in the outer corner; the drawer runs
   under it, so the honeycomb spans the whole dock with no empty tab column. */
#eve-hyve-dock[data-seam][data-open] .eve-hyve-tab { position: relative; z-index: 1; }
/* The honeycomb has the same 10px on every side (the outline's 1.5px included): left, right, bottom, and under the header. */
#eve-hyve-dock[data-seam][data-open] .eve-hyve-drawer { width: 316px; margin-left: -30px; padding: 11px 10px 8.5px 8.5px; }
#eve-hyve-dock[data-seam][data-open] .eve-hyve-head { margin-left: 20px; margin-bottom: 10px; }
#eve-hyve-dock[data-seam][data-open][data-side="right"] .eve-hyve-drawer { margin-left: 0; margin-right: -30px; padding: 11px 8.5px 8.5px 10px; }
#eve-hyve-dock[data-seam][data-open][data-side="right"] .eve-hyve-head { margin-left: 0; margin-right: 20px; }
#eve-hyve-dock[data-seam][data-open] .eve-quick-tiles { margin-top: 0; }
/* Expanded tracker, drawer closed: the labelled vertical rail; folded: icon only (above). */
#eve-hyve-dock[data-seam]:not([data-compact]):not([data-open]) .eve-hyve-tab {
  height: 168px;
  justify-content: space-between;
  padding: 10px 0 9px;
}
#eve-hyve-dock[data-seam]:not([data-compact]):not([data-open]) .eve-hyve-tab-label,
#eve-hyve-dock[data-seam]:not([data-compact]):not([data-open]) .eve-hyve-tab-chev { display: block; }
#eve-tracker-panel.eve-dock-seam-left { border-top-left-radius: 0; }
#eve-tracker-panel.eve-dock-seam-right { border-top-right-radius: 0; }
/* Closing: the drawer clips away at full size instead of reflowing narrower. */
#eve-hyve-dock[data-closing] .eve-hyve-drawer > * { flex: none; width: var(--eve-close-w); white-space: nowrap; }
@keyframes eve-hyve-in { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
#eve-hyve-dock[data-side="right"] .eve-hyve-drawer { animation-name: eve-hyve-in-right; }
@keyframes eve-hyve-in-right { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: none; } }
.eve-quick-link-ico { width: 19px; height: 19px; color: #22d3ee; filter: drop-shadow(0 0 4px rgba(34, 211, 238, .6)); }
.eve-quick-count { color: #22d3ee; font-weight: 700; }
/* The honeycomb: seven equal pointy-top hexagons, 2-3-2, the same gap between
   every pair. A hexagon is 32% of the cluster wide (width / height = 0.866),
   rows step 29.45% of the width, so the cluster is 1.0434 times as wide as high. */
#eve-tracker-panel .eve-quick-tiles {
  position: relative;
  width: 100%;
  max-width: 300px;
  margin: 2px auto 0;
  aspect-ratio: 1.0434;
}
#eve-tracker-panel .eve-quick-cell {
  --qa: 47, 123, 255;
  position: absolute;
  width: 32%;
  height: 38.55%;
  pointer-events: none;
  filter: drop-shadow(0 0 5px rgba(var(--qa), .35));
  /* The glow fades slower than the lift returns: a sweep leaves a short trail. */
  transition: filter .36s ease-out;
}
#eve-tracker-panel .eve-quick-cell:nth-child(1) { left: 17%; top: 0; }
#eve-tracker-panel .eve-quick-cell:nth-child(2) { left: 51%; top: 0; }
#eve-tracker-panel .eve-quick-cell:nth-child(3) { left: 0; top: 30.72%; }
#eve-tracker-panel .eve-quick-cell:nth-child(4) { left: 34%; top: 30.72%; }
#eve-tracker-panel .eve-quick-cell:nth-child(5) { left: 68%; top: 30.72%; }
#eve-tracker-panel .eve-quick-cell:nth-child(6) { left: 17%; top: 61.45%; }
#eve-tracker-panel .eve-quick-cell:nth-child(7) { left: 51%; top: 61.45%; }
#eve-tracker-panel .eve-quick-cell:focus-within { filter: drop-shadow(0 0 9px rgba(var(--qa), .7)); transition-duration: .15s; }
/* The link fills its cell and never moves, and it takes no pointer itself:
   .eve-quick-hit (the hexagon-shaped clip, also fixed) does, so the pointer
   never chases a hexagon that lifted away from under it. Only .eve-quick-face
   (the drawn hexagon: outline, fill, icon, label) moves, by transform. */
#eve-tracker-panel .eve-quick-tile {
  position: absolute;
  inset: 0;
  display: block;
  color: #fff;
  text-decoration: none;
  pointer-events: none;
  outline: none;
}
#eve-tracker-panel .eve-quick-hit {
  position: absolute;
  inset: 0;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  pointer-events: auto;
  cursor: pointer;
}
#eve-tracker-panel .eve-quick-face {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  padding: 0 11%;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: rgb(var(--qa));
  font-size: 11px;
  font-weight: 600;
  line-height: 1.15;
  text-align: center;
  transform-origin: 50% 55%;
  /* Back down softly (the trail); the rise below is quicker. */
  transition: transform .22s cubic-bezier(.3, .6, .3, 1);
}
#eve-tracker-panel .eve-quick-face::before {
  content: '';
  position: absolute;
  inset: 2px;
  z-index: -1;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
  background: linear-gradient(rgba(var(--qa), .1), rgba(var(--qa), .1)), #0b1024;
  transition: background .22s;
}
#eve-tracker-panel .eve-quick-cell:hover,
#eve-tracker-panel .eve-quick-cell:focus-within { z-index: 1; }
#eve-tracker-panel .eve-quick-cell:hover { filter: drop-shadow(0 0 9px rgba(var(--qa), .7)); transition-duration: .15s; }
#eve-tracker-panel .eve-quick-cell:hover .eve-quick-face,
#eve-tracker-panel .eve-quick-cell:focus-within .eve-quick-face {
  /* --hx / --hy / --hr follow the cursor inside the hexagon (set in addProfileNavigation). */
  transform: translate(var(--hx, 0px), calc(-3px + var(--hy, 0px))) rotate(var(--hr, 0deg)) scale(1.05);
  transition-duration: .15s;
  transition-timing-function: cubic-bezier(.2, .8, .3, 1);
}
#eve-tracker-panel .eve-quick-cell:hover .eve-quick-face::before {
  background: linear-gradient(rgba(var(--qa), .22), rgba(var(--qa), .22)), #0b1024;
  transition-duration: .15s;
}
#eve-tracker-panel .eve-quick-cell:active .eve-quick-face { transform: translateY(-1px) scale(.99); transition-duration: .06s; }
/* Keyboard focus: the outline turns white. */
#eve-tracker-panel .eve-quick-tile:focus-visible .eve-quick-face { background: #fff; }
#eve-tracker-panel .eve-quick-tile .eve-ico { width: 22px; height: 22px; color: rgb(var(--qa)); }
#eve-tracker-panel .eve-quick-label { max-width: 100%; overflow-wrap: break-word; }
@media (hover: none) {
  /* Touch: no hover to leave behind a lifted hexagon; the press shows. */
  #eve-tracker-panel .eve-quick-cell:hover .eve-quick-face { transform: none; }
  #eve-tracker-panel .eve-quick-cell:active .eve-quick-face { transform: scale(.97); }
}
.eve-section-title {
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--eve-cyan);
  text-shadow: 0 0 10px rgba(56, 198, 255, .35);
  margin-top: 10px;
  margin-bottom: 9px;
}
.eve-section-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
/* - 70% + : each panel's own size (PANEL SIZE). The middle button resets to 70%. */
.eve-size-ctl {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: stretch;
  height: 26px;
  box-sizing: border-box;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  background: #0b1430;
  overflow: hidden;
  text-transform: none;
  letter-spacing: 0;
  text-shadow: none;
}
.eve-size-ctl button {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #c3cde6;
  font-family: var(--eve-font);
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.eve-size-ctl .eve-size-step { width: 26px; font-size: 16px; }
.eve-size-ctl .eve-size-pct {
  min-width: 44px;
  padding: 0 4px;
  border-left: 1px solid var(--eve-line);
  border-right: 1px solid var(--eve-line);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.eve-size-ctl button:hover { background: var(--eve-control-hover); color: var(--eve-text); }
.eve-size-ctl button[aria-disabled="true"] { opacity: .35; cursor: default; background: transparent; color: #c3cde6; }
.eve-size-ctl button:focus-visible { outline: 2px solid var(--eve-blue); outline-offset: -2px; }
.eve-buttons { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.eve-buttons.eve-bulk-buttons {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.eve-buttons.eve-bulk-buttons button { height: 32px; padding: 0 4px; font-size: 12px; white-space: nowrap; }
.eve-buttons button {
  cursor: pointer;
  padding: 5px 10px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  background: #0b1430;
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12px;
  font-weight: 600;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.eve-buttons button:active { transform: translateY(1px) scale(.97); }
.eve-buttons button:hover { background: #13214a; border-color: rgba(140, 170, 255, .45); }
.eve-buttons button:focus-visible { outline: 2px solid #9cc4ff; outline-offset: 2px; }
.eve-buttons button.eve-btn-primary {
  background: linear-gradient(180deg, #2b86ff, #0a6cff);
  border-color: #4d9bff;
  color: #fff;
  box-shadow: 0 0 12px rgba(10, 108, 255, .5);
}
.eve-buttons button.eve-btn-primary:hover { background: linear-gradient(180deg, #4595ff, #1f7aff); border-color: #7ab4ff; }
.eve-refresh-card {
  margin-top: 10px;
  background: rgba(255, 255, 255, .03);
  border: 1px solid var(--eve-line);
  border-radius: 12px;
  overflow: hidden;
}
.eve-refresh-row { display: flex; align-items: center; gap: 8px; padding: 9px 9px 9px 12px; }
.eve-refresh-label {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
}
.eve-live-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, .18), 0 0 8px rgba(34, 197, 94, .7);
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
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  background: #0b1430;
  color: #b9c6e4;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.eve-icon-btn:hover { background: var(--eve-control-hover); color: var(--eve-text); }
.eve-icon-btn:active svg { transform: rotate(90deg); }
.eve-icon-btn svg { transition: transform .2s ease; }
#eve-refresh-mini { display: none; margin-left: auto; font-variant-numeric: tabular-nums; }
#eve-tracker-panel.eve-tracker-collapsed.eve-developer-enabled #eve-refresh-mini { display: inline-block; }
#eve-tracker-panel.eve-tracker-collapsed.eve-developer-enabled .eve-health-chip { margin-left: 6px; }
#eve-refresh-badge {
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 60px;
  padding: 5px 10px;
  box-sizing: border-box;
  text-align: center;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
#eve-refresh-interval, #eve-log-shift {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--eve-line-strong);
  border-radius: 9px;
  background: #070f24;
  color: var(--eve-text);
  font-family: var(--eve-font);
  font-size: 12.5px;
  cursor: pointer;
}
#eve-refresh-interval:focus, #eve-log-shift:focus { outline: none; border-color: var(--eve-blue); }
#eve-log-shift { flex: 0 1 auto; min-width: 0; margin-left: auto; }
.eve-shift-icon { flex: 0 0 auto; width: 17px; height: 17px; color: #dbe3f4; }
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
  background: #061121;
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
/* Without Developer mode there are no dots: drop the empty band above the footer. */
.eve-page-navigation.eve-dev-nav-disabled { display: none !important; }
.eve-page-navigation.eve-dev-nav-disabled + .eve-credit { margin-top: 8px; }
/* The first row sits closer under the title line. */
#eve-tracker-panel .eve-ui-page-active > .eve-section-title-row:first-child { margin-top: 6px; }
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
  border-radius: 12px;
  padding: 0 10px;
}
.eve-section-card:has(#eve-section-list:empty) { display: none; }
.eve-eta-card {
  margin-top: 10px;
  background: rgba(255, 255, 255, .03);
  border: 1px solid var(--eve-line);
  border-radius: 12px;
  padding: 0 10px;
}
.eve-eta-card > summary {
  cursor: pointer;
  padding: 9px 0 4px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
}
/* Pass ETA: a compact readout in the sidebar's own width. */
.eve-eta-count {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border: 1px solid rgba(47, 123, 255, .45);
  border-radius: 999px;
  background: rgba(47, 123, 255, .12);
  font-size: 11px;
  font-weight: 600;
  vertical-align: 1px;
}
.eve-eta-count:empty { display: none; }
.eve-eta-sub { padding-bottom: 6px; color: var(--eve-muted); font-size: 11px; line-height: 1.35; }
#eve-eta-body { max-height: 260px; overflow-y: auto; padding-bottom: 4px; overscroll-behavior: contain; }
.eve-eta-card > summary { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr); position: relative; padding-right: 14px; align-items: center; gap: 2px 6px; }
.eve-eta-card > summary::-webkit-details-marker { display: none; }
.eve-eta-card > summary::after {
  content: "";
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  position: absolute;
  top: 50%;
  right: 3px;
  margin: -5px 0 0;
  border-right: 1.6px solid var(--eve-muted);
  border-bottom: 1.6px solid var(--eve-muted);
  transform: rotate(45deg);
  transition: transform .2s ease;
}
.eve-eta-card[open] > summary::after { transform: rotate(-135deg); }
.eve-eta-head { display: flex; grid-column: 1; align-items: center; min-width: 0; white-space: nowrap; font-size: 12px; }
.eve-eta-count { flex: 0 0 auto; }
.eve-eta-head .eve-eta-title { font-size: 11px; }
.eve-eta-head .eve-eta-count { margin-left: 4px; padding: 0 5px; font-size: 10px; }
.eve-eta-lead .eve-eta-sn-main { font-family: inherit; letter-spacing: 0; }
.eve-eta-lead .eve-eta-in { color: #5eead4; font-weight: 700; }
.eve-eta-lead .eve-eta-clock { color: #fcd34d; font-weight: 700; }
.eve-eta-lead { min-width: 0; margin-left: 4px; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; font-weight: 500; font-variant-numeric: tabular-nums; }
.eve-eta-next { display: flex; grid-column: 1; flex-direction: column; gap: 1px; min-width: 0; margin-top: 0; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.eve-eta-next-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eve-eta-next-where { color: #c3cad9; font-size: 11.5px; }
.eve-eta-overdue-tools { display: flex; align-items: center; gap: 8px; padding: 0 0 6px; color: var(--eve-muted); font-size: 11px; }
.eve-eta-overdue-tools button {
  padding: 3px 10px;
  border: 1px solid rgba(251, 191, 36, .5);
  border-radius: 7px;
  background: rgba(251, 191, 36, .1);
  color: #fde68a;
  font: 600 11px var(--eve-font);
  cursor: pointer;
}
.eve-eta-overdue-tools button:hover { background: rgba(251, 191, 36, .2); }
.eve-eta-where .eve-eta-when { margin-left: auto; flex: 0 0 auto; color: var(--eve-muted); font-size: 11px; font-weight: 600; }
.eve-eta-late .eve-eta-when { color: #fbbf24; }
.eve-eta-overdue {
  margin-bottom: 4px;
  border: 1px solid rgba(251, 191, 36, .28);
  border-radius: 9px;
  padding: 0 8px;
}
.eve-eta-overdue[hidden] { display: none; }
.eve-eta-overdue > summary {
  cursor: pointer;
  padding: 6px 0;
  color: #fbbf24;
  font-size: 12px;
  font-weight: 600;
}
.eve-eta-sn-main { font-family: var(--eve-mono); font-size: 11.5px; letter-spacing: .03em; }
.eve-eta-row {
  min-width: 0;
  padding: 6px 0;
  border-top: 1px solid rgba(255, 255, 255, .06);
  font-size: 12px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.eve-eta-line, .eve-eta-where span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eve-eta-k, .eve-eta-sep { color: var(--eve-muted); }
.eve-eta-clock { font-weight: 700; color: var(--eve-text); }
.eve-eta-day { color: var(--eve-muted); font-size: 11px; font-weight: 600; }
.eve-eta-when { font-weight: 600; }
.eve-eta-late .eve-eta-when { color: #fbbf24; }
.eve-eta-where {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 2px;
  color: #c3cad9;
  font-size: 11.5px;
}
.eve-eta-pin { flex: 0 0 auto; width: 12px; height: 12px; color: var(--eve-muted); }
.eve-eta-sn {
  margin-top: 1px;
  color: var(--eve-muted);
  font-family: var(--eve-mono);
  font-size: 10.5px;
  letter-spacing: .03em;
}
.eve-eta-none { padding: 5px 0; color: var(--eve-muted); font-size: 11px; line-height: 1.4; }
/* Section table: name, Show, Notifs, then the live Tests / Fails / Passes. */
.eve-section-head, .eve-section-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 44px 44px 44px 48px;
  column-gap: 3px;
  align-items: center;
  justify-items: center;
}
.eve-section-stats { display: contents; }
.eve-stat {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 32px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: help;
  transition: opacity .2s ease;
}
.eve-stat b { font-weight: 700; }
.eve-stat-testing { background: #13244b; color: #eef3ff; box-shadow: inset 0 0 0 1px rgba(90, 140, 255, .3); }
.eve-stat-failed { background: rgba(200, 16, 72, .3); color: #ff5f8f; box-shadow: inset 0 0 0 1px rgba(255, 64, 120, .32); }
.eve-stat-passed { background: rgba(16, 160, 90, .24); color: #3ff0a0; box-shadow: inset 0 0 0 1px rgba(40, 220, 140, .3); }
.eve-stat-zero { opacity: .65; }
.eve-section-row:not(.eve-section-shown) .eve-stat { opacity: .4; }
.eve-section-head {
  padding: 9px 0 7px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: #aab6d3;
  border-bottom: 1px solid var(--eve-line);
}
.eve-section-head span:first-child, .eve-section-name { justify-self: start; }
.eve-section-row { padding: 7px 0; }
.eve-section-row + .eve-section-row { border-top: 1px solid rgba(255, 255, 255, .05); }
.eve-section-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: .02em;
}
.eve-switch { display: inline-flex; cursor: pointer; }
.eve-switch input {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  width: 34px;
  height: 20px;
  margin: 0;
  border-radius: 999px;
  background: #283049;
  cursor: pointer;
  transition: background .2s ease, box-shadow .2s ease;
}
.eve-switch input::before {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #8b94ab;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .4);
  transition: transform .22s cubic-bezier(.3, 1.35, .5, 1), width .18s ease, background .18s ease;
}
.eve-switch input:checked { background: var(--eve-blue); box-shadow: 0 0 10px rgba(31, 122, 255, .55); }
.eve-switch input:checked::before { transform: translateX(14px); background: #fff; }
.eve-switch input:focus-visible { outline: 2px solid var(--eve-blue); outline-offset: 2px; }
.eve-switch input:hover { filter: brightness(1.15); }
.eve-switch input:active::before { width: 18px; }
.eve-switch input:checked:active::before { transform: translateX(10px); }
/* Notifs bell: green, no slash = on; dark grey with a slash = off. */
.eve-bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 26px;
  border-radius: 8px;
  cursor: pointer;
}
.eve-bell input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.eve-bell svg { width: 20px; height: 20px; pointer-events: none; transition: color .15s ease, transform .15s ease; }
.eve-bell:hover svg { transform: scale(1.08); }
.eve-bell:active svg { transform: scale(.88); }
.eve-bell-on { color: #22e07a; filter: drop-shadow(0 0 5px rgba(34, 224, 122, .6)); }
.eve-bell.eve-bell-ring .eve-bell-on { transform-origin: 50% 12%; animation: eve-bell-ring .28s ease-in-out 1; }
@keyframes eve-bell-ring {
  0% { transform: rotate(0); }
  25% { transform: rotate(-14deg); }
  60% { transform: rotate(10deg); }
  100% { transform: rotate(0); }
}
.eve-bell-off { color: #59627a; }
.eve-bell input:checked ~ .eve-bell-off, .eve-bell input:not(:checked) ~ .eve-bell-on { display: none; }
.eve-bell:hover .eve-bell-off { color: #7d879f; }
.eve-bell:has(input:focus-visible) { outline: 2px solid var(--eve-blue); outline-offset: 1px; }
/* The outline and glow follow the active filter (data-filter), in the colours
   of the filter badges: All blue, Fails red-pink, Pre-test dark red, Passes green. */
#eve-alert-container {
  --eve-filter-rgb: 64, 145, 255;
  position: fixed;
  zoom: var(--eve-ui-zoom, .7);
  top: calc(10px / var(--eve-ui-zoom, .7));
  left: calc(10px / var(--eve-ui-zoom, .7));
  width: 460px;
  max-width: calc((100vw - 20px) / var(--eve-ui-zoom, .7));
  max-height: calc((100vh - 20px) / var(--eve-ui-zoom, .7));
  overflow: hidden;
  z-index: 2147483647;
  display: none;
  flex-direction: column;
  background: linear-gradient(180deg, #0f1230 0, #0a0b1f 180px) #0a0b1f;
  border: 1.5px solid rgba(var(--eve-filter-rgb), .82);
  border-radius: 18px;
  font-family: var(--eve-font);
  box-shadow: 0 0 0 1px rgba(var(--eve-filter-rgb), .16), 0 0 26px rgba(var(--eve-filter-rgb), .4),
    0 18px 50px rgba(0, 0, 0, .55);
  transition: border-color .18s ease, box-shadow .18s ease;
}
#eve-alert-container[data-filter="TEST_FAILURE"] { --eve-filter-rgb: 200, 16, 95; }
#eve-alert-container[data-filter="PRETEST_FAILURE"] { --eve-filter-rgb: 143, 29, 54; }
#eve-alert-container[data-filter="TEST_SUCCESS"] { --eve-filter-rgb: 9, 230, 138; }
@media (prefers-reduced-motion: reduce) {
  #eve-alert-container { transition: none; }
}
#eve-alert-header, #eve-alert-toolbar { flex: 0 0 auto; }
#eve-alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 11px;
  background: linear-gradient(180deg, rgba(60, 20, 80, .35), rgba(20, 12, 40, 0));
  border-bottom: 1px solid rgba(var(--eve-filter-rgb), .16);
  border-radius: 17px 17px 0 0;
  color: var(--eve-text);
  font-size: 19px;
  font-weight: 800;
  letter-spacing: -.005em;
}
#eve-alert-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; }
#eve-alert-caret { display: inline-flex; color: #c3cde6; }
#eve-alert-caret .eve-ico { width: 17px; height: 17px; transform: rotate(90deg); transition: transform .15s; }
.eve-alerts-collapsed #eve-alert-caret .eve-ico { transform: none; }
#eve-alert-count { font-weight: 800; font-variant-numeric: tabular-nums; }
#eve-alert-count b { color: #4d9bff; }
#eve-alert-header-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
#eve-alert-menu-btn {
  width: 32px;
  height: 28px;
  padding: 0;
  background: transparent;
  color: #c3cde6;
  border: 1px solid transparent;
  border-radius: 8px;
  font-family: var(--eve-font);
  font-size: 18px;
  font-weight: 700;
  line-height: 24px;
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
  background: #0d1630;
  border: 1px solid rgba(80, 140, 255, .35);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, .55), 0 0 16px rgba(47, 123, 255, .2);
  font-family: var(--eve-font);
}
#eve-alert-menu[hidden] { display: none; }
#eve-alert-menu { transform-origin: top right; animation: eve-menu-in .13s ease-out; }
@keyframes eve-menu-in { from { opacity: 0; transform: translateY(-4px) scale(.97); } to { opacity: 1; transform: none; } }
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
  overflow-anchor: none;
  overscroll-behavior: contain;
  padding: 12px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.eve-alerts-collapsed #eve-alert-header { border-radius: 17px; border-bottom: 0; }
/* Empty state under the (empty or all-hidden) body; folded away with it. */
#eve-alert-container:has(#eve-alert-empty:not([hidden])) #eve-alert-body { padding-bottom: 0; }
#eve-alert-empty {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  margin: 0 12px 14px;
  padding: 18px 12px 20px;
  border: 1.5px dashed rgba(120, 150, 255, .28);
  border-radius: 14px;
  color: var(--eve-muted);
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
}
#eve-alert-empty[hidden], .eve-alerts-collapsed #eve-alert-empty { display: none; }
#eve-alert-empty { animation: eve-empty-in .22s ease-out; }
@keyframes eve-empty-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
#eve-alert-empty b { color: var(--eve-text); font-size: 14px; font-weight: 700; }
.eve-empty-ico { flex: 0 0 auto; width: 28px; height: 28px; margin-bottom: 5px; color: #8391b3; }
.eve-empty-ico path { fill: none; }
#eve-alert-empty[data-kind="nomatch"] { flex-direction: row; justify-content: center; gap: 8px; padding: 12px; }
#eve-alert-empty[data-kind="nomatch"] .eve-empty-ico { width: 16px; height: 16px; margin: 0; }
#eve-alert-empty[data-kind="nomatch"] b { font-size: 13px; font-weight: 600; color: #c3cde6; }
/* Neon cards: --eve-glow-rgb drives the glow (the accent, brighter for the
   dark pre-test red) and --eve-card-base is the solid colour under the
   gradients. The right margin is the gutter the Quick Actions tab sits in. */
.eve-alert {
  --eve-accent: #e60956;
  --eve-accent-rgb: 230, 9, 86;
  --eve-glow-rgb: var(--eve-accent-rgb);
  --eve-card-base: #110f24;
  position: relative;
  margin-right: 30px;
  border-radius: 14px;
  padding: 9px 14px 9px 16px;
  color: var(--eve-text);
  font-family: var(--eve-font);
  background:
    radial-gradient(130% 100% at 0 0, rgba(var(--eve-glow-rgb), .2), rgba(var(--eve-glow-rgb), 0) 60%),
    linear-gradient(135deg, rgba(var(--eve-glow-rgb), .1), rgba(var(--eve-glow-rgb), .02) 60%),
    var(--eve-card-base);
  border: 1.5px solid rgba(var(--eve-glow-rgb), .78);
  box-shadow:
    inset 3px 0 0 var(--eve-accent-text, var(--eve-accent)),
    0 0 0 1px rgba(var(--eve-glow-rgb), .14),
    0 0 16px rgba(var(--eve-glow-rgb), .38),
    inset 0 0 22px rgba(var(--eve-glow-rgb), .1);
  transition: border-color .15s ease, box-shadow .15s ease;
}
/* One-shot, only for a genuinely new alert (a class JS removes when it ends). */
.eve-alert.eve-alert-enter { animation: eve-card-in .24s cubic-bezier(.2, .9, .3, 1.15) backwards; }
@keyframes eve-card-in { from { opacity: 0; transform: translateY(10px) scale(.96); }
to { opacity: 1; transform: none; }
}
/* A dismissed card: out of the way of clicks while it fades (JS animates it). */
.eve-alert[data-leaving] { pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .eve-alert, .eve-live-dot { animation: none; transition: none; }
}
.eve-alert-clickable { cursor: pointer; }
.eve-alert-clickable:hover {
  border-color: rgba(var(--eve-glow-rgb), .95);
  box-shadow:
    inset 3px 0 0 var(--eve-accent-text, var(--eve-accent)),
    0 0 0 1px rgba(var(--eve-glow-rgb), .2),
    0 0 24px rgba(var(--eve-glow-rgb), .55),
    inset 0 0 22px rgba(var(--eve-glow-rgb), .12);
}
/* Open tray: the card's corners go square where the tray runs on from them. */
.eve-alert[data-qa-open] .eve-qa-tab, .eve-alert.eve-qa-closing .eve-qa-tab { visibility: hidden; }
.eve-alert[data-qa-open="right"][data-qa-join~="top"] { border-top-right-radius: 0; }
.eve-alert[data-qa-open="right"][data-qa-join~="bottom"] { border-bottom-right-radius: 0; }
.eve-alert[data-qa-open="left"][data-qa-join~="top"] { border-top-left-radius: 0; }
.eve-alert[data-qa-open="left"][data-qa-join~="bottom"] { border-bottom-left-radius: 0; }
/* Old cards dim under a darkening layer (40% black + desaturate = the old
   brightness(.6) saturate(.55) filter). A layer, not a filter on the card,
   so the Jira chip can sit above it: a pre-test chip with its gold
   "create one" outline stays bright on an old card until acknowledged. */
.eve-alert.eve-alert-gone { border-style: dashed; }
.eve-alert-gone .eve-alert-serial-value,
.eve-alert-gone .eve-alert-header > span:first-child,
.eve-alert-gone .eve-alert-loc-value {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  text-decoration-color: rgba(232, 234, 237, .55);
  opacity: .6;
}
.eve-alert-gone button.eve-alert-serial { cursor: default; }
.eve-alert-gone button.eve-alert-serial:hover { background: rgba(10, 6, 22, .6); border-color: rgba(var(--eve-glow-rgb), .2); }
.eve-alert-gone .eve-alert-serial .eve-alert-copy-hint { display: none; }
.eve-undo-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: 30px;
  padding: 8px 10px;
  border: 1.5px solid #6d4ae8;
  border-radius: 12px;
  background: #0b1224;
  box-shadow: 0 0 12px rgba(109, 74, 232, .35);
  color: var(--eve-text);
  font-family: var(--eve-font);
  transform-origin: 50% 0;
}
.eve-undo-mark {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1.5px solid #34d399;
  border-radius: 8px;
  background: rgba(16, 185, 129, .18);
  color: #6ee7b7;
  font-size: 15px;
}
.eve-undo-text { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.eve-undo-title { font-size: 13.5px; font-weight: 700; }
.eve-undo-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa5c4; font-size: 11.5px; }
.eve-undo-do, .eve-undo-x {
  flex: 0 0 auto;
  height: 30px;
  border-radius: 8px;
  font: 700 13px var(--eve-font);
  cursor: pointer;
}
.eve-undo-do { padding: 0 14px; border: 1px solid #8b6cf5; background: #6d4ae8; color: #fff; }
.eve-undo-do:hover { background: #7c5cf0; }
.eve-undo-x { width: 30px; padding: 0; border: 1px solid rgba(148, 163, 184, .35); background: #1b2340; color: #e2e8f0; font-size: 16px; }
.eve-undo-x:hover { background: #26305a; }
.eve-undo-do:focus-visible, .eve-undo-x:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
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
/* The outer glow and the Quick Actions tab sit outside the layer: dim them too. */
.eve-alert.eve-alert-aged:not(:hover) {
  box-shadow: inset 3px 0 0 var(--eve-accent-text, var(--eve-accent)), 0 0 8px rgba(var(--eve-glow-rgb), .14);
}
.eve-alert.eve-alert-aged:not(:hover) .eve-qa-tab:not([aria-expanded="true"]) { opacity: .7; }
.eve-alert.eve-alert-aged::after {
  content: '';
  position: absolute;
  inset: -1.5px;
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
  background: var(--eve-card-base);
}
@media (prefers-reduced-motion: reduce) { .eve-alert.eve-alert-aged::after { transition: none; }
}
.eve-success { --eve-accent: #09e68a; --eve-accent-rgb: 9, 230, 138; }
.eve-failure { --eve-accent: #e60956; --eve-accent-rgb: 230, 9, 86; --eve-accent-text: #ff4f8b; }
.eve-pretest { --eve-accent: #910421; --eve-accent-rgb: 145, 4, 33; --eve-accent-text: #c2334f; --eve-glow-rgb: 194, 51, 79; }
.eve-pretest-pass { --eve-accent: #14b8a6; --eve-accent-rgb: 20, 184, 166; }
.eve-dekit { --eve-accent: #94a3b8; --eve-accent-rgb: 148, 163, 184; }
.eve-dekit .eve-alert-header span { color: #cbd5e1; }
.eve-alert-unverified { border-style: dashed; border-color: rgba(var(--eve-glow-rgb), .8); }
/* What the detail page confirmed: one plain line under the status, wrapping
   under its own text (the leading check mark hangs). */
.eve-alert-phase-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  margin: -2px 0 10px;
  padding: 2px 4px 2px 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #c2cadd;
  font-family: var(--eve-font);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  text-align: left;
  word-break: break-word;
}
/* Diagnostics: only with Dev on (display: none also takes the button out of
   the tab order and the pointer's way). The card's Send to Repair box marks
   its lookup details the same way; the Jira page panel has no Dev switch and
   shows them all. */
body:not(.eve-dev-mode) .eve-alert-phase-note,
body:not(.eve-dev-mode) .eve-alert .eve-dev-only { display: none; }
.eve-alert-phase-text { flex: 1 1 auto; min-width: 0; padding-left: 1.15em; text-indent: -1.15em; }
.eve-phase-chev { width: 14px; height: 14px; margin-top: 2px; opacity: 0; transition: opacity .12s; }
button.eve-alert-phase-note { cursor: pointer; transition: background .12s, color .12s; }
button.eve-alert-phase-note:hover { background: rgba(var(--eve-glow-rgb), .08); color: #fff; }
button.eve-alert-phase-note:hover .eve-phase-chev,
button.eve-alert-phase-note:focus-visible .eve-phase-chev { opacity: .85; }
button.eve-alert-phase-note:focus-visible { outline: 2px solid rgba(var(--eve-glow-rgb), .9); outline-offset: 2px; }
.eve-alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 15.5px;
  font-weight: 800;
  letter-spacing: .04em;
  margin-bottom: 6px;
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
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--eve-accent-text, var(--eve-accent));
  box-shadow: 0 0 0 3px rgba(var(--eve-glow-rgb), .22), 0 0 10px rgba(var(--eve-glow-rgb), .8);
}
.eve-alert-close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #c5cbe0;
  font-size: 20px;
  font-weight: 400;
  line-height: 24px;
  cursor: pointer;
  padding: 0;
  transition: background .12s, color .12s, transform .14s cubic-bezier(.2, .9, .3, 1.2);
}
.eve-alert-close:hover { background: rgba(255, 255, 255, .12); color: #fff; transform: scale(1.08); }
.eve-alert-close:focus-visible {
  background: rgba(255, 255, 255, .12);
  color: #fff;
  outline: 2px solid #8fb5ff;
  outline-offset: 1px;
}
.eve-alert-close:active { background: rgba(255, 255, 255, .22); color: #fff; transform: scale(.88); transition-duration: .05s; }
@media (prefers-reduced-motion: reduce) { .eve-alert-close { transition: background .12s, color .12s; transform: none !important; } }
.eve-alert-serial {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  background: rgba(10, 6, 22, .6);
  border: 1px solid rgba(var(--eve-glow-rgb), .2);
  border-radius: 11px;
  color: #fff;
  font-family: var(--eve-font);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: .01em;
  padding: 5px 8px 5px 14px;
  margin-bottom: 7px;
  cursor: pointer;
  text-align: left;
  transition: background .12s, border-color .12s;
}
.eve-alert-serial:hover { background: rgba(10, 6, 22, .8); border-color: rgba(var(--eve-glow-rgb), .45); }
.eve-alert-serial-value { word-break: break-all; }
.eve-alert-copy-hint {
  flex: 0 0 auto;
  font-family: var(--eve-font);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  color: #dfe6ff;
  white-space: nowrap;
  padding: 2px 8px;
  border: 1px solid rgba(140, 160, 255, .25);
  border-radius: 8px;
  background: #1e1e39;
}
.eve-alert-serial .eve-alert-copy-hint { font-size: 13px; padding: 6px 12px; min-width: 92px; box-sizing: border-box; text-align: center; transition: background .12s, color .12s; }
.eve-alert-serial:hover .eve-alert-copy-hint { color: #fff; background: #2a2a52; }
.eve-alert-serial.eve-copied { border-color: rgba(34, 197, 94, .5); }
.eve-alert-serial.eve-copied .eve-alert-copy-hint { color: #86efac; background: rgba(34, 197, 94, .16); }
.eve-alert-serial.eve-copy-failed { border-color: rgba(239, 68, 68, .5); }
.eve-alert-serial.eve-copy-failed .eve-alert-copy-hint { color: #fca5a5; background: rgba(239, 68, 68, .16); }
/* "Server Location" over a larger pin + B4 \u{2022} EVE06 \u{2022} U3. */
.eve-alert-loc { display: flex; flex-direction: column; gap: 1px; min-width: 0; margin-bottom: 5px; }
.eve-alert-loc-label { font-size: 12px; font-weight: 600; letter-spacing: .02em; color: #b9c2da; }
.eve-alert-loc-value {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.25;
  color: #f1f3f9;
  overflow-wrap: anywhere;
}
.eve-alert-loc .eve-ico { width: 18px; height: 18px; color: var(--eve-accent-text, var(--eve-accent)); }
.eve-alert-status-row { display: flex; flex-wrap: nowrap; align-items: center; justify-content: space-between; gap: 4px 8px; margin-bottom: 6px; color: #d3d9e8; }
.eve-alert-status-row .eve-jira-group { margin-left: auto; }
.eve-alert-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.eve-alert-status-row .eve-alert-jira, .eve-alert-footer .eve-alert-jira { height: 26px; padding: 0 9px 0 8px; gap: 5px; font-size: 12px; }
.eve-alert-status-row .eve-jira-copy, .eve-alert-footer .eve-jira-copy { height: 26px; }
.eve-alert-footer .eve-jira-group { margin-left: auto; }
.eve-jira-copy .eve-alert-copy-hint { box-sizing: border-box; min-width: 28px; padding: 4px 0; text-align: center; }
/* Time on the left, the Jira chip on the right. */
.eve-alert-footer {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px 8px;
}
.eve-alert-footer .eve-ico { color: #c5cbe0; }
.eve-alert-time {
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.25;
  color: #c5cbe0;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.eve-alert-jira {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  box-sizing: border-box;
  padding: 0 12px 0 11px;
  border-radius: 999px;
  border: 1.5px solid rgba(76, 154, 255, .75);
  background: rgba(38, 132, 255, .16);
  color: #cfe2ff;
  font-family: var(--eve-font);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .02em;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(38, 132, 255, .35);
  transition: background .12s, border-color .12s, color .12s, box-shadow .12s;
}
.eve-alert-jira:hover { background: #0c66e4; border-color: #4c9aff; color: #fff; text-decoration: none; }
.eve-alert-jira:focus-visible { outline: 2px solid #4c9aff; outline-offset: 2px; }
.eve-jira-group { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; }
.eve-jira-group .eve-alert-jira { position: relative; }
.eve-jira-copy {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.eve-jira-copy[hidden] { display: none; }
.eve-jira-copy:hover .eve-alert-copy-hint { color: #fff; background: #2a2a52; }
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
  box-shadow: 0 0 0 2px #110f24;
  font-family: var(--eve-font);
  font-size: 10px;
  font-weight: 800;
  line-height: 15px;
  text-align: center;
  animation: eve-jira-new-pulse 1.6s ease-out 3;
}
@keyframes eve-jira-new-pulse {
  0% { box-shadow: 0 0 0 2px #110f24, 0 0 0 2px rgba(34, 197, 94, .6); }
  100% { box-shadow: 0 0 0 2px #110f24, 0 0 0 9px rgba(34, 197, 94, 0); }
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
.eve-jira-found .eve-jira-label { font-variant-numeric: tabular-nums; letter-spacing: .01em; }
.eve-jira-cat-new .eve-jira-dot { background: #8c9bab; opacity: 1; }
.eve-jira-cat-indeterminate .eve-jira-dot { background: #579dff; opacity: 1; }
.eve-jira-cat-done .eve-jira-dot { background: #4bce97; opacity: 1; }
.eve-jira-loading .eve-jira-dot { animation: eve-jira-pulse 1s ease-in-out infinite; }
@keyframes eve-jira-pulse { 0%, 100% { opacity: .25; }
50% { opacity: 1; }
}
.eve-jira-none { color: #c4c7cc; border-color: var(--eve-line-strong); background: var(--eve-control); box-shadow: none; }
.eve-jira-auth {
  color: #fcd34d;
  border-color: rgba(245, 158, 11, .6);
  background: rgba(245, 158, 11, .1);
  box-shadow: 0 0 10px rgba(245, 158, 11, .25);
}
.eve-jira-auth .eve-jira-dot { background: #f59e0b; opacity: 1; }
.eve-jira-waiting {
  color: #ffe9a8;
  border-color: rgba(250, 195, 4, .85);
  background: rgba(250, 195, 4, .12);
  box-shadow: 0 0 10px rgba(250, 195, 4, .35);
}
.eve-jira-waiting .eve-jira-dot {
  background: #fac304;
  opacity: 1;
  animation: eve-jira-pulse 1.6s ease-in-out infinite;
}
.eve-jira-noticket { color: #b8bcc3; border-color: var(--eve-line-strong); background: var(--eve-control); box-shadow: none; }
.eve-jira-noticket .eve-jira-dot { background: #6b7280; opacity: 1; }
.eve-jira-noticket.eve-jira-attn {
  color: #ffe9a8;
  border-color: rgba(250, 204, 21, .6);
  background: rgba(250, 195, 4, .12);
  box-shadow: 0 0 10px rgba(250, 195, 4, .3);
}
.eve-jira-noticket.eve-jira-attn .eve-jira-dot { background: #fac304; }
.eve-jira-passed, .eve-jira-passed:hover {
  color: #86efac;
  border-color: rgba(34, 197, 94, .6);
  background: rgba(34, 197, 94, .1);
  box-shadow: 0 0 10px rgba(34, 197, 94, .3);
  cursor: default;
}
.eve-jira-passed .eve-jira-dot { background: #22c55e; opacity: 1; }
.eve-jira-passed .eve-jira-ext { display: none; }
/* ===== Icons, the Quick Actions tab and tray ===== */
.eve-ico { flex: 0 0 auto; width: 16px; height: 16px; }
/* Dark tab on the card's right edge, its outline running on from the card's. */
.eve-qa-tab {
  position: absolute;
  top: 50%;
  right: -29px;
  transform: translateY(-50%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 28px;
  height: min(150px, calc(100% - 16px));
  min-height: 128px;
  box-sizing: border-box;
  padding: 10px 0 9px;
  border: 1.5px solid rgba(var(--eve-glow-rgb), .78);
  border-left: 0;
  border-radius: 0 13px 13px 0;
  background: linear-gradient(90deg, rgba(var(--eve-glow-rgb), .16), rgba(var(--eve-glow-rgb), .05)),
    var(--eve-card-base);
  color: #f1f3f9;
  font-family: var(--eve-font);
  cursor: pointer;
  box-shadow: 0 0 12px rgba(var(--eve-glow-rgb), .3);
  transition: background .15s, box-shadow .15s, opacity .15s;
}
.eve-qa-tab:hover, .eve-qa-tab:focus-visible, .eve-qa-tab[aria-expanded="true"] {
  background: linear-gradient(90deg, rgba(var(--eve-glow-rgb), .34), rgba(var(--eve-glow-rgb), .14)),
    var(--eve-card-base);
  box-shadow: 0 0 18px rgba(var(--eve-glow-rgb), .6);
  outline: none;
}
.eve-qa-tab:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 18px rgba(var(--eve-glow-rgb), .6); }
.eve-qa-tab-ico {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  color: var(--eve-accent-text, var(--eve-accent));
  filter: drop-shadow(0 0 4px rgba(var(--eve-glow-rgb), .85));
}
.eve-qa-tab-chev { width: 14px; height: 14px; flex: 0 0 auto; transition: transform .15s; }
.eve-qa-tab[aria-expanded="true"] .eve-qa-tab-chev { transform: rotate(180deg); }
.eve-qa-tab-label {
  writing-mode: vertical-rl;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .03em;
  line-height: 1;
  white-space: nowrap;
}
/* The tray: the four action rows, then the rail. Placed by placeQuickActions
   (data-side right / left / float, corner radii inline). */
#eve-qa-tray {
  --eve-qa-rgb: 255, 64, 140;
  position: fixed;
  z-index: 2147483647;
  display: flex;
  align-items: stretch;
  width: 300px;
  box-sizing: border-box;
  border: 1.5px solid rgba(var(--eve-qa-rgb), .78);
  border-radius: 0 16px 16px 0;
  background:
    radial-gradient(120% 80% at 100% 0, rgba(var(--eve-qa-rgb), .14), rgba(var(--eve-qa-rgb), 0) 60%),
    linear-gradient(180deg, #100e26, #0a0919);
  color: var(--eve-text);
  font-family: var(--eve-font);
  box-shadow: 0 0 18px rgba(var(--eve-qa-rgb), .35), 0 16px 40px rgba(0, 0, 0, .55);
  transition: opacity .16s ease-out, transform .16s ease-out;
}
#eve-qa-tray[hidden] { display: none; }
#eve-qa-tray[data-side="left"] { flex-direction: row-reverse; }
#eve-qa-tray.eve-qa-folding { overflow: hidden; justify-content: flex-end; }
#eve-qa-tray.eve-qa-folding .eve-qa-main { flex: 0 0 var(--eve-qa-mw); }
#eve-qa-tray[data-side="float"] {
  box-shadow: 0 0 0 1px rgba(var(--eve-qa-rgb), .2), 0 0 22px rgba(var(--eve-qa-rgb), .45),
    0 18px 44px rgba(0, 0, 0, .7);
}
#eve-qa-tray.eve-qa-enter { opacity: 0; transform: translateX(-12px); }
#eve-qa-tray.eve-qa-enter[data-side="left"] { transform: translateX(12px); }
#eve-qa-tray.eve-qa-enter[data-side="float"] { transform: translateY(-6px); }
.eve-qa-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  padding: 7px 4px 7px 10px;
}
#eve-qa-tray[data-side="left"] .eve-qa-main { padding: 7px 10px 7px 4px; }
.eve-qa-list { display: flex; flex-direction: column; gap: 4px; }
.eve-qa-btn {
  --qa: 47, 123, 255;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  box-sizing: border-box;
  margin: 0;
  padding: 2px 8px 2px 9px;
  border: 1.5px solid rgba(var(--qa), .82);
  border-radius: 11px;
  background: linear-gradient(180deg, rgba(var(--qa), .3), rgba(var(--qa), .12)), #0b0f22;
  color: #f3f6ff;
  font-family: var(--eve-font);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.15;
  text-align: left;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(var(--qa), .32), inset 0 1px 0 rgba(255, 255, 255, .06);
  transition: background .12s, border-color .12s, box-shadow .12s, opacity .12s, transform .08s;
}
.eve-qa-btn:active:not([aria-disabled="true"]) { transform: translateY(1px) scale(.992); }
.eve-qa-btn[hidden] { display: none; }
.eve-qa-btn:hover, .eve-qa-btn:focus-visible {
  background: linear-gradient(180deg, rgba(var(--qa), .46), rgba(var(--qa), .2)), #0b0f22;
  border-color: rgb(var(--qa));
  box-shadow: 0 0 16px rgba(var(--qa), .55);
  outline: none;
}
.eve-qa-btn:focus-visible { box-shadow: 0 0 0 2px #fff, 0 0 16px rgba(var(--qa), .55); }
.eve-qa-btn[aria-disabled="true"] { cursor: not-allowed; opacity: .55; box-shadow: none; filter: saturate(.35); }
.eve-qa-btn[aria-disabled="true"]:hover {
  background: linear-gradient(180deg, rgba(var(--qa), .3), rgba(var(--qa), .12)), #0b0f22;
  border-color: rgba(var(--qa), .82);
  box-shadow: none;
}
.eve-qa-ico {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  color: rgb(var(--qa));
  filter: drop-shadow(0 0 4px rgba(var(--qa), .7));
}
.eve-qa-text { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.eve-qa-title, .eve-qa-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eve-qa-sub { font-size: 10.5px; font-weight: 500; line-height: 1.1; color: #b9c2da; }
.eve-qa-sub:empty { display: none; }
.eve-qa-ext { flex: 0 0 auto; width: 16px; height: 16px; color: #e3e9ff; opacity: .9; }
.eve-qa-btn[aria-disabled="true"] .eve-qa-ext { display: none; }
/* Identity colours shared with the HYVE Quick Links: Jira blue, TestView purple,
   repair gold; PuTTY its own cyan. */
.eve-qa-jira { --qa: 59, 130, 246; }
.eve-qa-testview { --qa: 168, 85, 247; }
.eve-qa-putty { --qa: 34, 211, 238; }
.eve-qa-putty .eve-qa-sub { color: #cffafe; }
.eve-qa-repair { --qa: 250, 204, 21; }
/* Send to Repair by state (button data-state from the card's repair row).
   Off: a charcoal row whose reason stays readable red (the generic dimming
   would fade it); still aria-disabled, with no hover. */
.eve-qa-btn.eve-qa-repair[aria-disabled="true"],
.eve-qa-btn.eve-qa-repair[aria-disabled="true"]:hover {
  opacity: 1;
  filter: none;
  border-color: rgba(148, 156, 172, .38);
  background: linear-gradient(180deg, rgba(255, 255, 255, .05), rgba(255, 255, 255, .02)), #15171e;
  box-shadow: none;
  color: #c9ced8;
}
.eve-qa-repair[aria-disabled="true"] .eve-qa-ico { color: #6b7280; filter: none; }
.eve-qa-repair[aria-disabled="true"] .eve-qa-sub { color: #ff6b81; }
/* Requested and not sent yet: gold text, a slow pulse and a gold trace
   running round the outline. Opening the tray does not clear it; the send
   (or SFCS showing it already sent) does. */
.eve-qa-repair[data-state="requested"] {
  position: relative;
  border-color: rgba(250, 204, 21, .95);
  animation: eve-qa-gold 2.4s ease-in-out infinite;
}
.eve-qa-repair[data-state="requested"]:focus-visible {
  animation: none;
  box-shadow: 0 0 0 2px #fff, 0 0 16px rgba(250, 204, 21, .55);
}
.eve-qa-repair[data-state="requested"] .eve-qa-title { color: #fde047; }
.eve-qa-repair[data-state="requested"] .eve-qa-sub { color: #fde68a; }
.eve-qa-repair[data-state="requested"]::after {
  content: '';
  position: absolute;
  inset: -1.5px;
  padding: 1.5px;
  border-radius: inherit;
  background: conic-gradient(from var(--eve-qa-trace), rgba(254, 240, 138, 0) 0deg,
    rgba(254, 240, 138, 0) 250deg, #fef08a 330deg, rgba(254, 240, 138, 0) 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  animation: eve-qa-trace 3.6s linear infinite;
}
@property --eve-qa-trace { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
@keyframes eve-qa-trace { to { --eve-qa-trace: 360deg; } }
@keyframes eve-qa-gold {
  0%, 100% { box-shadow: 0 0 8px rgba(250, 204, 21, .28); }
  50% { box-shadow: 0 0 0 2px rgba(250, 204, 21, .18), 0 0 16px rgba(250, 204, 21, .5); }
}
/* Sent (here, or seen in the SFCS queue): green, a check, no pulse. */
.eve-qa-repair[data-state="sent"] { --qa: 34, 197, 94; }
.eve-qa-repair[data-state="sent"] .eve-qa-title { color: #86efac; }
.eve-qa-repair[data-state="sent"] .eve-qa-sub { color: #bbf7d0; }
.eve-qa-ico-done, .eve-qa-btn[data-state="sent"] .eve-qa-ico:not(.eve-qa-ico-done) { display: none; }
.eve-qa-btn[data-state="sent"] .eve-qa-ico-done { display: block; }
/* Create Ticket (PuTTY) once the ticket exists: greyed out, no hover glow, and
   its click does nothing. */
.eve-qa-btn.eve-qa-putty[aria-disabled="true"],
.eve-qa-btn.eve-qa-putty[aria-disabled="true"]:hover {
  opacity: .62;
  filter: grayscale(1);
  border-color: rgba(148, 156, 172, .38);
  background: linear-gradient(180deg, rgba(255, 255, 255, .05), rgba(255, 255, 255, .02)), #15171e;
  box-shadow: none;
}
.eve-qa-putty[aria-disabled="true"] .eve-qa-ico { color: #6b7280; filter: none; }
.eve-qa-putty[aria-disabled="true"] .eve-qa-title { color: #a3aab8; }
.eve-qa-putty[aria-disabled="true"] .eve-qa-sub { color: #c3c9d4; }
/* A click that copied (or handed the command to the paste helper): green, a
   check and "Copied" / "Sent" for a moment (flashQuickAction). */
.eve-qa-btn.eve-qa-flash,
.eve-qa-btn.eve-qa-flash:hover,
.eve-qa-btn.eve-qa-flash:focus-visible {
  --qa: 34, 197, 94;
  border-color: #22c55e;
  background: linear-gradient(180deg, rgba(34, 197, 94, .38), rgba(34, 197, 94, .14)), #0b0f22;
}
.eve-qa-btn.eve-qa-flash { animation: eve-qa-flash .7s ease-out; }
.eve-qa-btn.eve-qa-flash .eve-qa-title { color: #bbf7d0; }
.eve-qa-btn.eve-qa-flash .eve-qa-sub { color: #dcfce7; }
.eve-qa-btn.eve-qa-flash .eve-qa-ico-done { display: block; }
.eve-qa-btn.eve-qa-flash .eve-qa-ico:not(.eve-qa-ico-done),
.eve-qa-btn.eve-qa-flash .eve-qa-ext { display: none; }
.eve-qa-flash-tag { display: none; }
.eve-qa-btn.eve-qa-flash .eve-qa-flash-tag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid rgba(34, 197, 94, .6);
  border-radius: 999px;
  background: rgba(34, 197, 94, .22);
  color: #dcfce7;
  font-size: 11px;
  font-weight: 700;
}
@keyframes eve-qa-flash {
  0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, .75), 0 0 20px rgba(34, 197, 94, .7); }
  100% { box-shadow: 0 0 0 7px rgba(34, 197, 94, 0), 0 0 14px rgba(34, 197, 94, .45); }
}
/* A request waiting on its card: the closed tab pulses gold with a gold dot;
   the open tray's rail turns steady gold (green with a dot once sent). */
.eve-qa-tab-chev, .eve-qa-rail-chev { order: 2; }
.eve-alert[data-repair="requested"] .eve-qa-tab:not([aria-expanded="true"]) {
  border-color: rgba(250, 204, 21, .9);
  opacity: 1;
  animation: eve-qa-tab-gold 2.4s ease-in-out infinite;
}
.eve-alert[data-repair="requested"] .eve-qa-tab:not([aria-expanded="true"]):focus-visible {
  animation: none;
  box-shadow: 0 0 0 2px #fff, 0 0 18px rgba(250, 204, 21, .6);
}
.eve-alert[data-repair="requested"] .eve-qa-tab:not([aria-expanded="true"]) .eve-qa-tab-ico,
#eve-qa-tray[data-repair="requested"] .eve-qa-rail-ico {
  color: #facc15;
  filter: drop-shadow(0 0 4px rgba(250, 204, 21, .85));
}
.eve-alert[data-repair="requested"] .eve-qa-tab:not([aria-expanded="true"])::after,
#eve-qa-tray[data-repair="requested"] .eve-qa-rail::after,
#eve-qa-tray[data-repair="sent"] .eve-qa-rail::after {
  content: '';
  order: 1;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #facc15;
  box-shadow: 0 0 6px rgba(250, 204, 21, .85);
}
#eve-qa-tray[data-repair="requested"] .eve-qa-rail { box-shadow: inset 0 0 0 1.5px rgba(250, 204, 21, .75); }
#eve-qa-tray[data-repair="sent"] .eve-qa-rail { box-shadow: inset 0 0 0 1.5px rgba(34, 197, 94, .6); }
#eve-qa-tray[data-repair="sent"] .eve-qa-rail-ico {
  color: #4ade80;
  filter: drop-shadow(0 0 4px rgba(34, 197, 94, .85));
}
#eve-qa-tray[data-repair="sent"] .eve-qa-rail::after {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, .85);
}
#eve-qa-tray .eve-qa-rail:focus-visible { box-shadow: inset 0 0 0 2px #fff; }
.eve-alert.eve-alert-aged[data-repair="requested"]:not(:hover) .eve-qa-tab { opacity: 1; }
@keyframes eve-qa-tab-gold {
  0%, 100% { box-shadow: 0 0 10px rgba(250, 204, 21, .3); }
  50% { box-shadow: 0 0 0 2px rgba(250, 204, 21, .22), 0 0 20px rgba(250, 204, 21, .6); }
}
/* The rail on the tray's far edge: folds the tray away. */
.eve-qa-rail {
  flex: 0 0 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 13px 0 11px;
  border: 0;
  border-radius: 0 14px 14px 0;
  background: transparent;
  color: #eef1fa;
  font-family: var(--eve-font);
  cursor: pointer;
  transition: background .12s;
}
#eve-qa-tray[data-side="left"] .eve-qa-rail { border-radius: 14px 0 0 14px; }
.eve-qa-rail:hover, .eve-qa-rail:focus-visible { background: rgba(var(--eve-qa-rgb), .14); outline: none; }
.eve-qa-rail:focus-visible { box-shadow: inset 0 0 0 2px #fff; }
.eve-qa-rail-ico {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: rgb(var(--eve-qa-rgb));
  filter: drop-shadow(0 0 4px rgba(var(--eve-qa-rgb), .85));
}
.eve-qa-rail-label {
  writing-mode: vertical-rl;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: .05em;
  line-height: 1;
  white-space: nowrap;
}
.eve-qa-rail-chev { width: 14px; height: 14px; flex: 0 0 auto; }
#eve-qa-tray[data-side="left"] .eve-qa-rail-chev { transform: rotate(180deg); }
.eve-qa-note { padding: 2px 3px 1px; color: #c9d5ea; font-size: 11.5px; line-height: 1.4; }
.eve-qa-note:empty { display: none; }
.eve-qa-putty-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
#eve-qa-tray .eve-putty-note { margin-top: 6px; color: #9aa5bd; font-size: 11px; }
#eve-qa-tray .eve-putty-note:empty { display: none; }
#eve-qa-tray .eve-qa-note button {
  padding: 5px 10px;
  border: 1px solid rgba(34, 211, 238, .7);
  border-radius: 8px;
  background: rgba(34, 211, 238, .16);
  color: #ecfeff;
  font-family: var(--eve-font);
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
}
#eve-qa-tray .eve-qa-note button:hover, #eve-qa-tray .eve-qa-note button:focus-visible {
  background: rgba(34, 211, 238, .32);
  outline: none;
}
#eve-qa-tray .eve-qa-note .eve-putty-again {
  padding: 0;
  border: 0;
  background: none;
  color: #67e8f9;
  font-weight: 600;
  text-decoration: underline;
}
@media (prefers-reduced-motion: reduce) {
  #eve-qa-tray, .eve-qa-btn, .eve-qa-tab, .eve-qa-tab-chev, .eve-qa-rail, .eve-bell svg,
  #eve-alert-caret .eve-ico, .eve-phase-chev, #eve-tracker-panel .eve-quick-cell,
  #eve-tracker-panel .eve-quick-face, #eve-tracker-panel .eve-quick-face::before,
  #eve-hyve-dock .eve-hyve-tab, .eve-hyve-tab-chev { transition: none; }
  #eve-tracker-panel .eve-quick-cell:hover .eve-quick-face,
  #eve-tracker-panel .eve-quick-cell:focus-within .eve-quick-face,
  #eve-tracker-panel .eve-quick-cell:active .eve-quick-face { transform: none; }
  #eve-hyve-dock .eve-hyve-drawer, .eve-qa-btn.eve-qa-flash, #eve-alert-menu, #eve-alert-empty,
  .eve-chip-count { animation: none; }
  .eve-filter-btn, .eve-bell svg, .eve-switch input::before { transition: none; }
  .eve-bell.eve-bell-ring .eve-bell-on { animation: none; }
  .eve-eta-card > summary::after { transition: none; }
  .eve-filter-btn:active, .eve-bell:hover svg, .eve-bell:active svg { transform: none; }
  /* A steady gold outline instead of the pulse and the moving trace. */
  .eve-qa-repair[data-state="requested"],
  .eve-alert[data-repair="requested"] .eve-qa-tab:not([aria-expanded="true"]) {
    animation: none;
    box-shadow: 0 0 0 1px rgba(250, 204, 21, .45), 0 0 12px rgba(250, 204, 21, .45);
  }
  .eve-qa-repair[data-state="requested"]::after { animation: none; background: rgba(254, 240, 138, .85); }
}
`;
    if (ON_LIVE_DASHBOARD) {
      // Live dashboard: Show off hides marked rack boxes; the health chip shows a
      // problem without Dev; the page's own page-wide CSS (box sizing, line height)
      // is undone inside the panels so they look as on the board.
      style.textContent += `
[data-eve-hidden] { display: none !important; }
#eve-tracker-panel .eve-health-chip:not(.eve-health-ok) { display: inline-block; }
#eve-tracker-panel.eve-tracker-collapsed .eve-health-chip { margin-left: 6px; }
:where(#eve-tracker-panel, #eve-alert-container) { line-height: normal; }
:where(#eve-tracker-panel, #eve-alert-container, #eve-tracker-panel *, #eve-alert-container *),
:where(#eve-tracker-panel, #eve-alert-container, #eve-tracker-panel *, #eve-alert-container *)::before,
:where(#eve-tracker-panel, #eve-alert-container, #eve-tracker-panel *, #eve-alert-container *)::after {
  box-sizing: revert;
}
`;
    }
    document.head.appendChild(style);
  }

  // ===== INITIALIZE =====

  const RUNNING_ATTR = 'data-eve-slt-tracker';

  function claimThisTab() {
    const root = document.documentElement;
    const running = root.getAttribute(RUNNING_ATTR);
    if (running) {
      warn(
        `Another copy of EVE SLT TRACKER (v${running}) is already running in this ` +
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
      const strippedMeta = ON_LIVE_DASHBOARD ? 0 : stripMetaRefresh(document);
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
      // JIRAlerts is there from the start; with no cards it opens folded at "(0)".
      getAlertContainer();
      alertsWereEmpty = false;
      refreshAlertChrome();
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
        coordLeave();
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
        `EVE SLT TRACKER v${SCRIPT_VERSION} running\n` +
          '  by Zay Davidson\n' +
          '  Report bugs: ' +
          'https://github.com/zayd117/EVE-SLT-TRACKER/issues'
      );
      if (ON_LIVE_DASHBOARD) {
        log('Live dashboard: tracking the rack cards on this page.');
        refreshFromDashboard(true);
      }
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
        `EVE SLT TRACKER v${SCRIPT_VERSION} FAILED TO START. ` +
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
    const REPAIR_REQUEST_TICKS = 5;
    const RETEST_RELEASE_TICKS = 10;
    let tick = 0;
    coordTicking = true;
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
      runTickStep('pages', () => coordTick(now));
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
      if (tick % REPAIR_REQUEST_TICKS === 0) {
        runTickStep('jira comments', repairTool.pollComments);
      }
      if (tick % RETEST_RELEASE_TICKS === 0) {
        runTickStep('retest release', repairTool.pollRelease);
      }
    });
  }

  // ===== PROFILE NAVIGATION =====

  // Green Bank: the link exactly as zay gave it (http, port 31808, rackintesting page).
  const GREEN_BANK_URL =
    'http://hyve-k8s-ramses-minion001.hyvesolutions.org:31808/loginout/in/?next=/#/rackintesting/';
  const SERVER_EXCEL_LOGS_URL =
    'https://tdworldwide-my.sharepoint.com/:x:/r/personal/t518506n_tdsynnex_com/_layouts/15/doc2.aspx' +
    '?sourcedoc=%7B72A3961D-DF72-4BAB-B2CC-D4FA7200F86C%7D&file=SLT_Tracker.xlsx&action=default' +
    '&mobileredirect=true&wdExp=TEAMS-TREATMENT&web=1&CID=0ce5dc84-a68f-4250-859f-2b214d212489&isSPOFile=1';

  // The HYVE dock's width when open (tab + drawer, see the CSS): the room it
  // needs beside the tracker to open on that side.
  const HYVE_DOCK_OPEN_WIDTH = 326;
  // Below the tracker's rounded top corner.
  const HYVE_DOCK_TOP = 16;

  // HYVE Quick Links: a side tab on the tracker panel's outer edge that slides
  // out seven hexagon links in a 2-3-2 honeycomb (positions in CSS, by order),
  // one solid colour each, each opening in a new tab. Closed on every load.
  // The dock is a fixed child of the panel (the panel's scrolling never clips
  // it) that placeHyveDock keeps on the panel as it moves, folds or resizes.
  function addProfileNavigation(panel) {
    const dock = document.createElement('div');
    dock.id = 'eve-hyve-dock';
    dock.dataset.side = 'left';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'eve-hyve-tab';
    tab.setAttribute('aria-expanded', 'false');
    tab.setAttribute('aria-controls', 'eve-hyve-drawer');
    tab.innerHTML =
      qaIcon('link', 'eve-ico eve-hyve-tab-ico') +
      '<span class="eve-hyve-tab-label">HYVE Quick Links</span>' +
      qaIcon('chevron', 'eve-ico eve-hyve-tab-chev');
    const nav = document.createElement('nav');
    nav.id = 'eve-hyve-drawer';
    nav.className = 'eve-hyve-drawer';
    nav.setAttribute('aria-label', 'HYVE quick links');
    nav.hidden = true;
    nav.innerHTML =
      `<div class="eve-hyve-head">${qaIcon('link', 'eve-ico eve-quick-link-ico')}` +
      '<span>HYVE Quick Links <span class="eve-quick-count"></span></span></div>';
    dock.append(tab, nav);
    const sfcs = 'https://sfc-fm-p1.hyvesolutions.org/mfg-local-sfcs/';
    const tiles = document.createElement('div');
    tiles.className = 'eve-quick-tiles';
    nav.appendChild(tiles);
    // Reading order: top row, middle row, bottom row.
    [
      ['TestView 2.0', TESTVIEW_LIST_URL, 'monitor', '168, 85, 247'],
      ['Bulk start', new URL('/slt/operator', TESTVIEW_LIST_URL).href, 'play', '114, 108, 247'],
      ['Collector', sfcs + 'collector?path=collector', 'database', '101, 141, 171'],
      ['Send to repair', sfcs + 'repairProcess/sendToRepair?path=repairProcess/sendToRepair', 'wrench', '250, 204, 21'],
      [
        'JIRA tickets',
        `${jiraBaseUrl()}/issues/?jql=${encodeURIComponent('project = MFGS ORDER BY created DESC')}`,
        'jira',
        '59, 130, 246'
      ],
      ['Green Bank', GREEN_BANK_URL, 'database', '34, 197, 94'],
      ['Server Excel Sheet Logs', SERVER_EXCEL_LOGS_URL, 'doc', '47, 164, 170']
    ].forEach(([text, href, icon, rgb]) => {
      const cell = document.createElement('span');
      cell.className = 'eve-quick-cell';
      cell.style.setProperty('--qa', rgb);
      const link = document.createElement('a');
      link.className = 'eve-quick-tile';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = text;
      link.innerHTML =
        '<span class="eve-quick-face">' +
        qaIcon(icon, 'eve-ico') +
        '<span class="eve-quick-label"></span></span><span class="eve-quick-hit"></span>';
      link.querySelector('.eve-quick-label').textContent = text;
      cell.appendChild(link);
      tiles.appendChild(cell);
      // A subtle sway toward the cursor: up to 3 px and 2 degrees, eased by the face's own transition.
      cell.addEventListener('pointermove', event => {
        if (prefersReducedMotion() || event.pointerType === 'touch') {
          return;
        }
        const box = cell.getBoundingClientRect();
        const nx = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width - 0.5) * 2));
        const ny = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height - 0.5) * 2));
        cell.style.setProperty('--hx', (nx * 3).toFixed(2) + 'px');
        cell.style.setProperty('--hy', (ny * 3).toFixed(2) + 'px');
        cell.style.setProperty('--hr', (nx * 2).toFixed(2) + 'deg');
      });
      cell.addEventListener('pointerleave', () => {
        cell.style.removeProperty('--hx');
        cell.style.removeProperty('--hy');
        cell.style.removeProperty('--hr');
      });
    });
    const count = nav.querySelectorAll('a').length;
    const name = `HYVE Quick Links (${count})`;
    nav.querySelector('.eve-quick-count').textContent = `(${count})`;
    tab.setAttribute('aria-label', name);
    // Closing shrinks the drawer toward its tab (width, height and the tab's own
    // height together) while the dock stays glued to the tracker, so it never grows
    // first. The final closed look is applied when the shrink ends.
    let closing = null;
    const endClose = () => {
      if (!closing) {
        return;
      }
      const run = closing;
      closing = null;
      cancelAnimationFrame(run.raf);
      run.anims.forEach(anim => anim.cancel());
      nav.style.overflow = '';
      nav.style.removeProperty('--eve-close-w');
      dock.removeAttribute('data-closing');
      nav.hidden = true;
      dock.toggleAttribute('data-open', false);
      placeHyveDock(panel, dock);
    };
    const animateClose = () => {
      const from = { width: nav.offsetWidth, height: nav.offsetHeight };
      const tabFrom = tab.offsetHeight;
      const tabTo = dock.hasAttribute('data-compact') ? tabFrom : 168;
      const timing = { duration: 180, easing: 'ease-in', fill: 'forwards' };
      const navStyle = getComputedStyle(nav);
      nav.style.setProperty(
        '--eve-close-w',
        from.width - (parseFloat(navStyle.paddingLeft) || 0) - (parseFloat(navStyle.paddingRight) || 0) + 'px'
      );
      nav.style.overflow = 'hidden';
      dock.setAttribute('data-closing', '');
      tab.setAttribute('aria-expanded', 'false');
      tab.title = name;
      const run = { anims: [], raf: 0 };
      closing = run;
      run.anims.push(
        nav.animate(
          [
            { width: from.width + 'px', height: from.height + 'px', padding: getComputedStyle(nav).padding, marginLeft: getComputedStyle(nav).marginLeft, marginRight: getComputedStyle(nav).marginRight, opacity: 1 },
            { width: '0px', height: tabTo + 'px', padding: '0px', marginLeft: '0px', marginRight: '0px', opacity: 0 }
          ],
          timing
        ),
        tab.animate([{ height: tabFrom + 'px' }, { height: tabTo + 'px' }], timing)
      );
      run.anims[0].onfinish = endClose;
      const tick = () => {
        if (closing === run) {
          placeHyveDock(panel, dock);
          run.raf = requestAnimationFrame(tick);
        }
      };
      tick();
    };
    const setOpen = open => {
      endClose();
      if (!open && !nav.hidden && typeof nav.animate === 'function' &&
          !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        animateClose();
        return;
      }
      nav.hidden = !open;
      dock.toggleAttribute('data-open', open);
      tab.setAttribute('aria-expanded', String(open));
      tab.title = open ? 'Fold HYVE Quick Links away' : name;
      placeHyveDock(panel, dock);
    };
    setOpen(false);
    tab.addEventListener('click', () => setOpen(nav.hidden || !!closing));
    // Folding the tracker also closes the links; unfolding never opens them (each stays its own state).
    const foldButton = panel.querySelector('.eve-collapse-btn');
    if (foldButton) {
      foldButton.addEventListener('click', () => {
        if (panel.classList.contains('eve-tracker-collapsed') && !nav.hidden && !closing) {
          setOpen(false);
        }
      });
    }
    dock.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !nav.hidden) {
        event.preventDefault();
        setOpen(false);
        tab.focus();
      }
    });
    // After setupTrackerWindowUX, so it stays outside the folding panel body.
    withoutObserver(() => panel.appendChild(dock));
    const place = () => placeHyveDock(panel, dock);
    new MutationObserver(place).observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
    if (typeof ResizeObserver === 'function') {
      const sizes = new ResizeObserver(place);
      sizes.observe(panel);
      const header = panel.querySelector('.eve-panel-title');
      if (header) {
        sizes.observe(header);
      }
    }
    window.addEventListener('resize', place);
    place();
  }

  // The dock on the tracker's left edge when the open dock fits there, else on
  // its right edge when it fits there, else on the left over the panel; never
  // off screen. data-compact: the tracker is folded to its title.
  function placeHyveDock(panel, dock) {
    if (!dock.isConnected) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    // Window px: the dock's own px times the tracker's size.
    const zoom = zoomOf(dock);
    const room = HYVE_DOCK_OPEN_WIDTH * zoom + PANEL_MARGIN;
    const side = rect.left >= room || viewWidth - rect.right < room ? 'left' : 'right';
    if (dock.dataset.side !== side) {
      dock.dataset.side = side;
    }
    const compact = panel.classList.contains('eve-tracker-collapsed');
    dock.toggleAttribute('data-compact', compact);
    const open = dock.hasAttribute('data-open');
    // The tracker header's measured top and height: the tab is exactly that tall
    // and joins it at the panel's edge; the open drawer grows out from the same
    // seam. Without a measurable header the old folded-only join stays.
    const header = panel.querySelector('.eve-panel-title');
    const headRect = header ? header.getBoundingClientRect() : null;
    const seam = !!(headRect && headRect.height > 8);
    dock.toggleAttribute('data-seam', seam);
    // Folded and closed: the tab is as tall as the folded header and joins it flush.
    const flush = compact && !open;
    // Folded: the cap is the whole folded bar (panel border box), not just its title row.
    // Measured from the title row plus the panel's bottom padding and border, never from
    // the panel's live height: that is still tall while the body folds away.
    const foldedBar = () => {
      const style = getComputedStyle(panel);
      const below = (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      // The title's own bottom padding is still easing away while it folds; leave it out so the bar is steady.
      const easing = parseFloat(getComputedStyle(header).paddingBottom) || 0;
      return Math.round(((headRect.bottom - rect.top) / zoom - easing + below) * 100) / 100;
    };
    const ownHeight = compact && seam
      ? foldedBar()
      : compact
        ? Math.round((rect.height / zoom) * 100) / 100
        : seam
        ? Math.round(((headRect.bottom - rect.top) / zoom) * 100) / 100 // panel top to the title row's bottom line
        : panel.offsetHeight;
    if (seam || flush) {
      const own = `${ownHeight}px`;
      if (dock.style.getPropertyValue('--eve-dock-h') !== own) {
        dock.style.setProperty('--eve-dock-h', own);
      }
    }
    // Folded tracker (cap or open drawer): both joined corners square, one flush seam.
    panel.classList.toggle('eve-dock-flush-left', compact && side === 'left');
    panel.classList.toggle('eve-dock-flush-right', compact && side === 'right');
    panel.classList.toggle('eve-dock-seam-left', seam && !flush && side === 'left');
    panel.classList.toggle('eve-dock-seam-right', seam && !flush && side === 'right');
    // Fractional sizes (the 1.5px outline), so no hairline gap shows at the seam.
    const { width, height } = dock.getBoundingClientRect();
    const left =
      side === 'left' ? Math.max(4, rect.left - width) : Math.min(rect.right, viewWidth - width - 4);
    const top = compact
      ? rect.top
      : seam
        ? open
          ? Math.max(4, Math.min(rect.top, viewHeight - height - 4))
          : rect.top
        : Math.max(4, Math.min(rect.top + HYVE_DOCK_TOP * zoom, viewHeight - height - 4));
    setWindowSpot(dock, left, top);
  }

  // ===== SEND TO REPAIR (SFCS) =====
  // Merged from "Jira Send to Repair (SFCS)" 0.3.0. One repair view, in two places:
  //   JIRAlerts cards   an SLT failure with a Jira ticket is watched in the
  //                     background; when a comment asks to send the unit to
  //                     repair, a gold "Send to repair" row appears under its
  //                     footer and opens the view inside the card.
  //   Jira MFGS ticket  floating "Send to repair" button (same rule), same view.
  // The view reads the serial and symptom code from the ticket title, looks the
  // unit up in SFCS Send To Repair, picks the closest symptom entry and, after
  // Send then Confirm, sends it to repair with the ticket link as the comment,
  // then checks the collector position. Nothing is sent before Confirm.
  // SFCS pages: only copies the authorization header the page itself sends into
  // this script's storage (shared by every tab), for these requests.
  // Requests (all on sfc-fm-p1, with the same sign-in the SFCS page uses):
  //   GET  .../public/api/repairProcess/sendToRepair/serNoOrAssetTag/<SN>
  //        route, line, asset tag, symptom list (with top10 flags).
  //   POST .../public/api/repairProcess/sendToRepair
  //        the body the SFCS page sends (captured 2026-10-16): the lookup
  //        reply with symptomCode = the chosen entry, comments = ticket link.
  //   GET  .../public/api/collector/serNoOrAssetTag/<SN>/flowMap
  //        the position before the send, then up to 3 times until Repair.
  // The saved sign-in is deleted after 9 hours, when SFCS rejects it, or on
  // "Forget". It is never shown or copied out.
  const repairTool = (() => {
    const SFCS = 'https://sfc-fm-p1.hyvesolutions.org';
    const SFCS_HOST = new URL(SFCS).hostname;
    const JIRA_HOST = new URL(JIRA_DEFAULT_BASE_URL).hostname;
    const LOOKUP_PATH = '/mfg-local-sfcs/public/api/repairProcess/sendToRepair/serNoOrAssetTag/';
    const SEND_PATH = '/mfg-local-sfcs/public/api/repairProcess/sendToRepair';
    const SEND_PAGE = SFCS + '/mfg-local-sfcs/repairProcess/sendToRepair?path=repairProcess/sendToRepair';
    const ACCEPT = 'application/json, text/plain, */*';
    const REPAIR_CONTACT = 'Shift Lead Repair Tech';
    const SEND_MESSAGE = 'Sending to repair physically\n{serial}';
    const TIMING = { verify: [2000, 5000, 10000], sendTimeoutMs: 30000, authPollMs: 2000 };
    const AUTH_KEY = 'jstr.sfcsAuth';
    const AUTH_MAX_AGE_MS = 9 * 3600 * 1000;
    const SN_RE = /^[A-Z0-9]{8,16}$/;

    function flowPath(sn) {
      return '/mfg-local-sfcs/public/api/collector/serNoOrAssetTag/' + encodeURIComponent(sn) + '/flowMap';
    }

    // ---- storage (script storage, shared by the Jira and SFCS tabs) ----

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function getVal(key, fallback) {
      try {
        const saved = hasGM ? GM_getValue(key, null) : window.localStorage.getItem(key);
        return saved === null || saved === undefined ? fallback : JSON.parse(saved);
      } catch (error) {
        return fallback;
      }
    }

    function setVal(key, value) {
      try {
        const text = JSON.stringify(value);
        if (hasGM) {
          GM_setValue(key, text);
        } else {
          window.localStorage.setItem(key, text);
        }
      } catch (error) {}
    }

    const pad = n => (n < 10 ? '0' : '') + n;

    function hhmm(time) {
      const d = new Date(time);
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function stamp(time) {
      const d = new Date(time);
      return (d.toDateString() === new Date().toDateString() ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hhmm(time);
    }

    // ---- your SFCS sign-in (picked up from SFCS pages) ----

    function getAuth() {
      const saved = getVal(AUTH_KEY, null);
      if (!saved || !saved.value) {
        return null;
      }
      if (Date.now() - (Number(saved.at) || 0) > AUTH_MAX_AGE_MS) {
        setVal(AUTH_KEY, null);
        return null;
      }
      return saved;
    }

    function keepAuth(raw) {
      const value = String(raw || '').trim();
      if (value.length < 12 || /(^|\s)(null|undefined)$/i.test(value)) {
        return;
      }
      const current = getVal(AUTH_KEY, null);
      const now = Date.now();
      if (current && current.value === value && now - (Number(current.at) || 0) < 60000) {
        return;
      }
      setVal(AUTH_KEY, { value: value, at: now });
    }

    function forgetAuth() {
      setVal(AUTH_KEY, null);
    }

    // 401, or a message about the token or the authorization header (403 alone can mean other things).
    function isAuthError(reply) {
      if (!reply) {
        return false;
      }
      if (reply.status === 401) {
        return true;
      }
      const message = reply.body && reply.body.message ? String(reply.body.message) : '';
      return /access token|authori[sz]ation header|unauthori[sz]ed|token (is )?(expired|invalid)|invalid token|not logged in|login required/i.test(message);
    }

    function isSfcsUrl(url) {
      try {
        return new URL(String(url || ''), window.location.href).hostname === SFCS_HOST;
      } catch (error) {
        return false;
      }
    }

    function headerOf(headers, name) {
      if (!headers) {
        return '';
      }
      try {
        if (typeof headers.get === 'function') {
          return headers.get(name) || '';
        }
        if (Array.isArray(headers)) {
          for (const pair of headers) {
            if (pair && String(pair[0]).toLowerCase() === name) {
              return String(pair[1] || '');
            }
          }
          return '';
        }
        for (const key in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === name) {
            return String(headers[key] || '');
          }
        }
      } catch (error) {}
      return '';
    }

    // On SFCS pages: watch the page's own requests and keep the authorization header it sends.
    function hookSfcsPage() {
      const keep = (value, url) => {
        if (value && isSfcsUrl(url)) {
          keepAuth(value);
        }
      };
      const w = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
      try {
        const proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
        if (proto && !proto.__jstrHook) {
          const open0 = proto.open;
          const set0 = proto.setRequestHeader;
          proto.open = function (method, url) {
            try {
              this.__jstrUrl = String(url || '');
            } catch (error) {}
            return open0.apply(this, arguments);
          };
          proto.setRequestHeader = function (name, value) {
            try {
              if (/^authorization$/i.test(String(name))) {
                keep(value, this.__jstrUrl);
              }
            } catch (error) {}
            return set0.apply(this, arguments);
          };
          proto.__jstrHook = true;
        }
      } catch (error) {}
      try {
        if (typeof w.fetch === 'function' && !w.fetch.__jstrHook) {
          const fetch0 = w.fetch;
          const hooked = function (input, init) {
            try {
              keep(
                headerOf(init && init.headers, 'authorization') || headerOf(input && input.headers, 'authorization'),
                typeof input === 'string' ? input : (input && input.url) || ''
              );
            } catch (error) {}
            return fetch0.apply(w, arguments);
          };
          hooked.__jstrHook = true;
          w.fetch = hooked;
        }
      } catch (error) {}
      // If Tampermonkey keeps this script apart from the page, a small in-page hook
      // hands the header over through a page event instead.
      document.addEventListener('jstr-sfcs-auth', event => {
        try {
          const detail = JSON.parse(event.detail);
          keep(detail.v, detail.u);
        } catch (error) {}
      });
      // At document-start the page may have no root element yet: wait for it.
      const injectPageHook = () => {
        const root = document.head || document.documentElement;
        if (!root) {
          return false;
        }
        const script = document.createElement('script');
        script.textContent = '(' + String(pageHook) + ')();';
        root.appendChild(script);
        script.remove();
        return true;
      };
      try {
        if (!injectPageHook()) {
          const waiter = new MutationObserver(() => {
            if (injectPageHook()) {
              waiter.disconnect();
            }
          });
          waiter.observe(document, { childList: true });
        }
      } catch (error) {}
    }

    // Runs inside the SFCS page itself (self-contained on purpose).
    function pageHook() {
      const tell = (value, url) => {
        try {
          document.dispatchEvent(new CustomEvent('jstr-sfcs-auth', {
            detail: JSON.stringify({ v: String(value || ''), u: String(url || '') })
          }));
        } catch (error) {}
      };
      const authOf = headers => {
        if (!headers) {
          return '';
        }
        try {
          if (typeof headers.get === 'function') {
            return headers.get('authorization') || '';
          }
          if (Array.isArray(headers)) {
            for (const pair of headers) {
              if (pair && String(pair[0]).toLowerCase() === 'authorization') {
                return String(pair[1] || '');
              }
            }
            return '';
          }
          for (const key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === 'authorization') {
              return String(headers[key] || '');
            }
          }
        } catch (error) {}
        return '';
      };
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto && !proto.__jstrHook) {
        const open0 = proto.open;
        const set0 = proto.setRequestHeader;
        proto.open = function (method, url) {
          try {
            this.__jstrUrl = String(url || '');
          } catch (error) {}
          return open0.apply(this, arguments);
        };
        proto.setRequestHeader = function (name, value) {
          try {
            if (/^authorization$/i.test(String(name))) {
              tell(value, this.__jstrUrl);
            }
          } catch (error) {}
          return set0.apply(this, arguments);
        };
        proto.__jstrHook = true;
      }
      if (typeof window.fetch === 'function' && !window.fetch.__jstrHook) {
        const fetch0 = window.fetch;
        const hooked = function (input, init) {
          try {
            const value = authOf(init && init.headers) || authOf(input && input.headers);
            if (value) {
              tell(value, typeof input === 'string' ? input : (input && input.url) || '');
            }
          } catch (error) {}
          return fetch0.apply(window, arguments);
        };
        hooked.__jstrHook = true;
        window.fetch = hooked;
      }
    }

    // ---- the ticket ----

    // "EVE: 2641YW10HF: TA.B4-EVE07: LOC 6: 7_HWDIAG_ON" -> serial, rack, loc, codes
    function parseTitle(summary) {
      const out = { serial: '', rack: '', loc: '', codes: [] };
      const parts = String(summary || '').split(':').map(part => part.trim()).filter(Boolean);
      let rackIdx = -1;
      let locIdx = -1;
      parts.forEach((part, index) => {
        const up = part.toUpperCase();
        if (!out.serial && SN_RE.test(up) && /\d/.test(up)) {
          out.serial = up;
        } else if (!out.rack && /^TA\.[A-Z0-9]+-EVE\d+$/i.test(part)) {
          out.rack = up;
          rackIdx = index;
        } else if (!out.loc && /^LOC\s*\d+$/i.test(part)) {
          out.loc = up.replace(/\s+/, ' ');
          locIdx = index;
        }
      });
      const start = locIdx >= 0 ? locIdx + 1 : (rackIdx >= 0 ? rackIdx + 1 : parts.length);
      parts.slice(start).forEach(segment => {
        segment.split(/[\s,;|]+/).forEach(token => {
          const code = token.trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9_]+$/g, '');
          if (!code || !/[A-Z]/.test(code) || code === out.serial) {
            return;
          }
          if (!/_/.test(code) && code.length < 4) {
            return;
          }
          out.codes.push({ full: code, base: code.replace(/^\d+_/, '') });
        });
      });
      return out;
    }

    function ticketInfo() {
      const match = /\/browse\/(MFGS-\d+)/i.exec(window.location.pathname);
      const key = match ? match[1].toUpperCase() : '';
      const summaryEl = document.getElementById('summary-val');
      let summary = summaryEl ? summaryEl.textContent.trim() : '';
      if (!summary) {
        const fromTitle = /^\[[^\]]+\]\s*(.*?)\s*-\s*[^-]*JIRA\s*$/i.exec(document.title || '');
        summary = fromTitle ? fromTitle[1] : '';
      }
      return {
        key: key,
        link: key ? window.location.origin + '/browse/' + key : '',
        summary: summary
      };
    }

    // ---- symptom matching ----

    // "SYS_MISC_CHECK:7_HWDIAG_ON" -> taskset SYS_MISC_CHECK, step 7_HWDIAG_ON, check HWDIAG_ON
    function splitDesc(desc) {
      const text = String(desc || '').toUpperCase().trim();
      const match = /^([A-Z0-9_]+)\s*:\s*(.+)$/.exec(text);
      if (!match) {
        return { taskset: /^[A-Z0-9_]+$/.test(text) ? text : '', step: '', check: '', text: text };
      }
      return { taskset: match[1], step: match[2].trim(), check: match[2].trim().replace(/^\d+_/, ''), text: text };
    }

    const escRe = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function scoreEntry(entry, code) {
      const s = splitDesc(entry.description);
      if (s.step && s.step === code.full) return { score: 100, why: 'exact match, same step number' };
      if (s.check && s.check === code.base && s.step === s.check) return { score: 85, why: 'same check, no step number' };
      if (s.check && s.check === code.base) return { score: 80, why: 'same check, different step number' };
      if (!s.step && s.taskset && s.taskset === code.base) return { score: 70, why: 'same test step name' };
      if (new RegExp('(^|[^A-Z0-9])' + escRe(code.base) + '([^A-Z0-9]|$)').test(s.text)) return { score: 50, why: 'contains the code' };
      if (s.text.indexOf(code.base) !== -1) return { score: 30, why: 'partly contains the code' };
      return { score: 0, why: '' };
    }

    const topUsed = list => (list || []).filter(entry => entry.top10);

    // Which entry to use for these title codes.
    function pickSymptom(list, codes, rotation) {
      list = list || [];
      const perCode = (codes || []).map(code => {
        const ranked = [];
        list.forEach((entry, order) => {
          const scored = scoreEntry(entry, code);
          if (scored.score > 0) {
            ranked.push({ entry: entry, score: scored.score, why: scored.why, order: order });
          }
        });
        ranked.sort((a, b) => b.score - a.score || a.order - b.order);
        return { code: code, ranked: ranked, best: ranked[0] || null };
      }).filter(item => item.best);
      if (perCode.length) {
        // several codes: one whose match is most used, then the shortest, then the last in the title
        perCode.forEach((item, index) => {
          item.idx = index;
        });
        perCode.sort((a, b) => {
          const ta = a.best.entry.top10 ? 1 : 0;
          const tb = b.best.entry.top10 ? 1 : 0;
          return tb - ta || a.code.base.length - b.code.base.length || b.idx - a.idx;
        });
        const chosen = perCode[0];
        const ties = chosen.ranked.filter(item => item.score === chosen.best.score).length;
        return {
          code: chosen.code,
          entry: chosen.best.entry,
          score: chosen.best.score,
          why: chosen.best.why + (ties > 1 ? ' (' + ties + ' equally close, took the first)' : ''),
          fallback: false,
          alternatives: chosen.ranked.slice(0, 12).map(item => item.entry),
          otherCodes: perCode.slice(1).map(item => item.code.full)
        };
      }
      const top = topUsed(list).slice(0, 3);
      if (!top.length) {
        return { code: (codes || [])[0] || null, entry: null, score: 0, why: 'no match and no most-used list', fallback: true, alternatives: [] };
      }
      const k = Math.abs(Number(rotation) || 0) % top.length;
      return {
        code: (codes || [])[0] || null,
        entry: top[k],
        score: 0,
        why: 'no entry matches the title, so one of the 3 most used (#' + (k + 1) + ', rotating)',
        fallback: true,
        alternatives: top
      };
    }

    // ---- SFCS requests ----

    function gmRequest(options) {
      const timeout = options.timeout || 15000;
      const headers = {};
      Object.keys(options.headers || {}).forEach(key => {
        headers[key] = options.headers[key];
      });
      const auth = options.auth ? getAuth() : null;
      if (auth) {
        headers.Authorization = auth.value;
      }
      return new Promise(resolve => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          resolve({ status: 0, error: 'Tampermonkey cross-site requests unavailable', notSent: true });
          return;
        }
        try {
          GM_xmlhttpRequest({
            method: options.method,
            url: SFCS + options.path,
            headers: headers,
            data: options.data,
            timeout: timeout,
            onload: response => {
              let body = null;
              try {
                body = JSON.parse(response.responseText);
              } catch (error) {
                body = null;
              }
              resolve({ status: response.status, body: body, text: response.responseText || '', authSent: !!auth });
            },
            onerror: () => resolve({ status: 0, error: 'collector not reachable', authSent: !!auth }),
            ontimeout: () => resolve({
              status: 0,
              error: 'collector did not answer in ' + Math.round(timeout / 1000) + ' s',
              authSent: !!auth
            })
          });
        } catch (error) {
          resolve({ status: 0, error: String((error && error.message) || error), notSent: true });
        }
      });
    }

    const isHtml = text => /<html|<!doctype/i.test(String(text || ''));

    // SFCS's answer when the unit is already in its repair queue, whoever sent
    // it: "The Serial Number or Asset Tag you have entered has already been Sent
    // To Repair!". That is the sent state, not an error. Matched narrowly: no
    // other message with "repair" in it counts.
    const ALREADY_SENT_RE = /\bhas already been sent to repair\b/i;
    const isAlreadySent = body => !!body && ALREADY_SENT_RE.test(String(body.message || ''));

    // { data } | { alreadySent, msg } | { error, auth? }
    function lookupUnit(sn) {
      return gmRequest({ method: 'GET', path: LOOKUP_PATH + encodeURIComponent(sn), headers: { Accept: ACCEPT }, auth: true }).then(reply => {
        if (reply.error) {
          return { error: reply.error };
        }
        if (isAuthError(reply) || (!reply.body && isHtml(reply.text))) {
          if (reply.authSent) {
            forgetAuth();
          }
          return { auth: true, error: reply.authSent ? 'SFCS turned down the saved sign-in (it may have expired)' : 'SFCS needs your sign-in for this' };
        }
        if (!reply.body) {
          return { error: 'collector reply was not readable (HTTP ' + reply.status + ')' };
        }
        if (reply.body.status !== 200 || !reply.body.data) {
          if (isAlreadySent(reply.body)) {
            return { alreadySent: true, msg: String(reply.body.message) };
          }
          return { error: reply.body.message ? String(reply.body.message) : 'collector answered ' + reply.body.status };
        }
        return { data: reply.body.data };
      });
    }

    function lookupPosition(sn) {
      return gmRequest({ method: 'GET', path: flowPath(sn), headers: { Accept: ACCEPT } }).then(reply =>
        // Works without a sign-in today; if that changes, retry once with yours.
        isAuthError(reply) && getAuth()
          ? gmRequest({ method: 'GET', path: flowPath(sn), headers: { Accept: ACCEPT }, auth: true })
          : reply
      ).then(reply => {
        if (reply.error) {
          return { error: reply.error };
        }
        if (!reply.body || !Array.isArray(reply.body.data)) {
          return { error: isHtml(reply.text) ? 'collector sign-in needed' : ((reply.body && reply.body.message) ? String(reply.body.message) : 'no route data') };
        }
        let last = null;
        reply.body.data.forEach(station => {
          if (station && String(station.status || '').toLowerCase() !== 'wait') {
            last = station;
          }
        });
        if (!last) {
          return { label: 'no station reached yet', raw: null };
        }
        const parts = [last.routeCodeLabel || last.routeCode || '?'];
        if (last.currentOptType) parts.push(String(last.currentOptType));
        if (last.attachedRoute) parts.push(String(last.attachedRoute));
        return { label: parts.join(' '), raw: last };
      });
    }

    // The page's Send body: the lookup reply sent back with the symptom entry and the comment filled in.
    function buildPayload(data, entry, comments) {
      return {
        serialNumber: data.serialNumber,
        assetTag: data.assetTag,
        lineNo: data.lineNo,
        routeCode: data.routeCode,
        classification: null,
        symptomCode: entry,
        comments: comments,
        classifications: data.classifications,
        symptomDropdownList: data.symptomDropdownList
      };
    }

    // sent: SFCS answered status 200. already: it refused because the unit is
    // already in its repair queue. failed: it refused or the request never left.
    // unknown: no usable answer, so it may or may not have gone through.
    function postSend(payload) {
      return gmRequest({
        method: 'POST',
        path: SEND_PATH,
        timeout: TIMING.sendTimeoutMs,
        auth: true,
        headers: { Accept: ACCEPT, 'Content-Type': 'application/json;charset=UTF-8' },
        data: JSON.stringify(payload)
      }).then(reply => {
        if (reply.error) {
          return { kind: reply.notSent ? 'failed' : 'unknown', msg: reply.error };
        }
        if (isAuthError(reply) || (!reply.body && isHtml(reply.text))) {
          if (reply.authSent) {
            forgetAuth();
          }
          return { kind: 'failed', auth: true, msg: 'SFCS sign-in needed, so nothing was sent' };
        }
        if (!reply.body) {
          return { kind: 'unknown', msg: 'collector reply was not readable (HTTP ' + reply.status + ')' };
        }
        if (reply.status === 200 && reply.body.status === 200) {
          return { kind: 'sent', requestId: reply.body.requestId ? String(reply.body.requestId) : '' };
        }
        if (isAlreadySent(reply.body)) {
          return { kind: 'already', msg: String(reply.body.message) };
        }
        return { kind: 'failed', msg: reply.body.message ? String(reply.body.message) : 'collector answered ' + (reply.body.status || reply.status) };
      });
    }

    // ---- per-ticket record ----

    // ---- records shared by every page (script storage) ----
    // One key per record (name/<ticket>): two pages saving different tickets at
    // the same moment never overwrite each other, as a whole map read, changed
    // and written back would. A 3.0.0 save (the whole map under `name`) is
    // still read underneath and never written again.
    const hasList = hasGM && typeof GM_listValues === 'function';
    const RECORDS_MAX = 300;

    function readMap(name) {
      const legacy = getVal(name, {});
      const all = isRecordObject(legacy) ? { ...legacy } : {};
      if (hasList) {
        const prefix = name + '/';
        GM_listValues().forEach(key => {
          if (String(key).indexOf(prefix) === 0) {
            const value = getVal(key, null);
            if (isRecordObject(value)) {
              all[String(key).slice(prefix.length)] = value;
            }
          }
        });
      }
      return all;
    }

    function readEntry(name, key) {
      const own = hasList ? getVal(name + '/' + key, null) : null;
      if (isRecordObject(own)) {
        return own;
      }
      const legacy = getVal(name, {});
      return isRecordObject(legacy) && isRecordObject(legacy[key]) ? legacy[key] : null;
    }

    function trimRecords(all) {
      const keys = Object.keys(all);
      if (keys.length > RECORDS_MAX) {
        keys.sort((a, b) => (Number(all[a].at) || 0) - (Number(all[b].at) || 0));
        keys.slice(0, keys.length - RECORDS_MAX).forEach(old => {
          delete all[old];
        });
      }
      return all;
    }

    // Oldest dropped past RECORDS_MAX.
    function writeEntry(name, key, value) {
      if (!hasList) {
        const all = readMap(name);
        all[key] = value;
        setVal(name, trimRecords(all));
        return;
      }
      setVal(name + '/' + key, value);
      const prefix = name + '/';
      const keys = GM_listValues().filter(k => String(k).indexOf(prefix) === 0);
      if (keys.length > RECORDS_MAX && typeof GM_deleteValue === 'function') {
        keys
          .map(k => ({ k: k, at: Number((getVal(k, null) || {}).at) || 0 }))
          .sort((a, b) => a.at - b.at)
          .slice(0, keys.length - RECORDS_MAX)
          .forEach(item => GM_deleteValue(item.k));
      }
    }

    // ---- per-ticket record ----

    function sentLog() {
      return readMap('jstr.sent');
    }

    // A record older than the stored one (a late answer to an earlier send or
    // check, from this page or another) never replaces it.
    function saveRecord(key, record) {
      const prior = readEntry('jstr.sent', key);
      if (prior && (Number(prior.at) || 0) > (Number(record.at) || 0)) {
        return prior;
      }
      writeEntry('jstr.sent', key, record);
      return record;
    }

    // ---- clipboard ----

    function copyText(text, button) {
      const done = ok => {
        if (!button) {
          return;
        }
        const idle = button.getAttribute('data-label') || button.textContent;
        button.setAttribute('data-label', idle);
        button.textContent = ok ? '\u2713 copied' : 'copy failed';
        setTimeout(() => {
          button.textContent = idle;
        }, 1200);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
          return;
        }
      } catch (error) {}
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px';
        let ok = false;
        withoutObserver(() => {
          document.body.appendChild(area);
          area.select();
          ok = !!document.execCommand('copy');
          area.remove();
        });
        done(ok);
      } catch (error) {
        done(false);
      }
    }

    // "Copy ticket link": the ticket title as a link to it (copyJiraLink); the
    // button says which landed, the link or (plain text only) title and URL.
    function copyTicketLink(ticket, sn, button) {
      const idle = button.getAttribute('data-label') || button.textContent;
      button.setAttribute('data-label', idle);
      copyJiraLink(ticket.key, ticket.summary, sn).then(kind => {
        button.textContent = kind === 'link'
          ? '\u2713 Title link copied'
          : kind ? '\u2713 Title and URL copied' : 'copy failed';
        setTimeout(() => {
          button.textContent = idle;
        }, 1500);
      });
    }

    // ---- view ----

    function el(tag, attrs, text) {
      const node = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(key => {
          if (key === 'className') node.className = attrs[key];
          else if (key === 'style') node.style.cssText = attrs[key];
          else node.setAttribute(key, attrs[key]);
        });
      }
      if (text !== undefined && text !== null) {
        node.textContent = text;
      }
      return node;
    }

    function pill(text, kind) {
      return el('span', { className: 'jstr-pill' + (kind ? ' ' + kind : '') }, text);
    }

    function row(parent, label, value, cls) {
      const line = el('div', { className: 'jstr-row' });
      line.appendChild(el('span', { className: 'jstr-k' }, label));
      const cell = value && value.nodeType ? value : el('span', { className: 'jstr-v' + (cls ? ' ' + cls : '') }, value);
      if (value && value.nodeType) {
        cell.classList.add('jstr-v');
      }
      line.appendChild(cell);
      parent.appendChild(line);
      return line;
    }

    const upperFirst = text => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);

    const REPAIR_CSS = [
      '#jstr-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#1f2937;color:#fde68a;border:1px solid #facc15;border-radius:18px;padding:7px 14px;font:bold 13px sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.4)}',
      '#jstr-btn[hidden]{display:none}',
      '#jstr-btn.requested{animation:jstr-btn-glow 2.4s ease-in-out infinite}',
      '#jstr-btn.requested:hover{background:#374151;color:#fef9c3}',
      '#jstr-btn.sent{color:#86efac;border-color:#22c55e}',
      '@keyframes jstr-btn-glow{0%,100%{box-shadow:0 4px 12px rgba(0,0,0,.4),0 0 4px rgba(250,204,21,.3)}50%{box-shadow:0 4px 12px rgba(0,0,0,.4),0 0 0 3px rgba(250,204,21,.25),0 0 18px rgba(250,204,21,.55)}}',
      '#jstr-btn:focus-visible,#jstr-head button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}',
      '#jstr-panel{position:fixed;right:18px;top:80px;z-index:2147483001;width:440px;max-width:calc(100vw - 30px);max-height:calc(100vh - 110px);overflow:auto;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:13px/1.45 sans-serif;color-scheme:dark}',
      '#jstr-head{display:flex;align-items:center;gap:6px;padding:8px 12px;background:#1f2937;border-radius:10px 10px 0 0}',
      '#jstr-head b{flex:1}',
      '#jstr-head button{background:#374151;color:#e5e7eb;border:1px solid #4b5563;border-radius:6px;padding:2px 9px;cursor:pointer;font:inherit}',
      '#jstr-body{padding:10px 12px 12px}',
      '.jstr-card{margin-top:8px}',
      '.jstr-card[hidden],.jstr-box[hidden]{display:none}',
      '.jstr-card-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:0 12px;border-radius:8px;border:1px solid rgba(250,204,21,.6);background:rgba(250,204,21,.1);color:#fde68a;font:700 12px var(--eve-font,sans-serif);letter-spacing:.02em;cursor:pointer;transition:background .12s,border-color .12s,color .12s}',
      '.jstr-card-toggle:hover{background:rgba(250,204,21,.2);border-color:#facc15;color:#fef9c3}',
      '.jstr-card-toggle.requested{animation:jstr-glow 2.4s ease-in-out infinite}',
      '@keyframes jstr-glow{0%,100%{box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 4px rgba(250,204,21,.25)}50%{box-shadow:0 0 0 2px rgba(250,204,21,.22),0 0 14px rgba(250,204,21,.45)}}',
      '.jstr-card-meta{margin-left:auto;font-weight:500;opacity:.85}',
      '.jstr-resp{display:inline-flex;align-items:center;gap:6px;min-width:0;margin-left:auto;padding:3px 9px;border:1px solid rgba(148,163,184,.3);border-radius:8px;background:rgba(15,20,36,.7);font-size:11.5px;font-weight:600;line-height:1.3;color:#b9c2da;white-space:nowrap}',
      '.jstr-resp-dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:0 0 auto}',
      '.jstr-resp-text{overflow:hidden;text-overflow:ellipsis}',
      '.eve-jira-resp{display:inline-flex;align-items:center;padding-right:4px;border-right:1px solid rgba(148,163,184,.35);font-size:10.5px;letter-spacing:0;font-weight:700;color:#b9c2da}',
      '.eve-jira-resp[data-state="received"]{color:#5eead4}',
      '.eve-jira-resp[data-state="auth"],.eve-jira-resp[data-state="error"]{color:#fbbf24}',
      '.eve-alert-jira:has(.eve-jira-resp) .eve-jira-dot{display:none}',
      '.eve-alert-footer .eve-alert-jira:has(.eve-jira-resp){gap:3px;padding:0 6px 0 7px;font-size:11.5px;letter-spacing:0}',
      '.jstr-resp-preview{margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:1.35;color:#b9c2da}',
      '.jstr-resp[data-state="received"]{color:#5eead4;border-color:rgba(45,212,191,.5)}',
      '.jstr-resp[data-state="received"] .jstr-resp-dot{background:#2dd4bf;box-shadow:0 0 6px rgba(45,212,191,.7)}',
      '.jstr-resp[data-state="auth"],.jstr-resp[data-state="error"]{color:#fbbf24}',
      '.jstr-resp[data-state="auth"] .jstr-resp-dot,.jstr-resp[data-state="error"] .jstr-resp-dot{background:#fbbf24}',
      '.eve-alert-jira.eve-jira-replied{border-color:rgba(250,204,21,.85);color:#fde68a;animation:jstr-reply-glow 1.8s ease-in-out infinite}',
      '@keyframes jstr-reply-glow{0%,100%{box-shadow:0 0 0 0 rgba(250,204,21,.15),0 0 4px rgba(250,204,21,.25)}50%{box-shadow:0 0 0 3px rgba(250,204,21,.28),0 0 14px rgba(250,204,21,.55)}}',
      '.eve-jira-reply{position:absolute;top:-7px;left:-6px;display:flex;align-items:center;justify-content:center;width:17px;height:17px;border-radius:50%;background:#facc15;color:#422006;box-shadow:0 0 0 2px #110f24}',
      '.eve-alert.eve-alert-aged .eve-jira-group:has(.eve-jira-replied){position:relative;z-index:2;border-radius:999px;background:var(--eve-card-base,#1c1d22)}',
      '.eve-alert.eve-alert-aged .jstr-card:has(.jstr-card-toggle.requested){position:relative;z-index:2;border-radius:8px;background:var(--eve-card-base,#1c1d22)}',
      '.jstr-view .jstr-link{min-height:0;padding:0;border:0;border-radius:3px;background:none;color:#93c5fd;font-size:12px;text-decoration:underline;cursor:pointer}',
      '.jstr-view .jstr-link:hover:not(:disabled){background:none;color:#dbeafe}',
      '.jstr-quote{margin:8px 0 0;padding:6px 10px;border-left:3px solid #facc15;border-radius:0 6px 6px 0;background:rgba(250,204,21,.07);font-size:12px}',
      '.jstr-card-toggle.sent.waiting{border-color:rgba(96,165,250,.75);background:rgba(59,130,246,.16);color:#bfdbfe;letter-spacing:.02em}',
      '.jstr-card-toggle.sent.waiting:hover{background:rgba(59,130,246,.28);border-color:#60a5fa;color:#eff6ff}',
      '.jstr-card-toggle.sent.ready{border-color:#22c55e;background:rgba(34,197,94,.24);color:#dcfce7;letter-spacing:.02em;box-shadow:0 0 10px rgba(34,197,94,.45)}',
      '.jstr-card-toggle.sent.ready:hover{background:rgba(34,197,94,.36);border-color:#4ade80;color:#fff}',
      '.jstr-card-toggle.requested{letter-spacing:.02em}',
      '.jstr-card-toggle.sent{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.1);color:#86efac}',
      '.jstr-card-toggle.sent:hover{background:rgba(34,197,94,.22);border-color:rgba(34,197,94,.7);color:#dcfce7}',
      '.jstr-card-toggle:focus-visible{outline:2px solid #4c9aff;outline-offset:2px}',
      '.jstr-box{margin-top:8px;padding:10px;border:1px solid var(--eve-line-strong,rgba(255,255,255,.14));border-radius:10px;background:rgba(0,0,0,.28)}',
      '.jstr-view{--jstr-text:var(--eve-text,#e5e7eb);--jstr-muted:var(--eve-muted,#9ca3af);--jstr-line:var(--eve-line-strong,rgba(255,255,255,.14));--jstr-control:var(--eve-control,rgba(255,255,255,.06));position:relative;font:13px/1.45 var(--eve-font,sans-serif);color:var(--jstr-text);color-scheme:dark;text-align:left;cursor:auto}',
      '.jstr-view *{box-sizing:border-box}',
      '.jstr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.jstr-view button{font:inherit;min-height:28px;padding:3px 10px;border-radius:8px;border:1px solid var(--jstr-line);background:var(--jstr-control);color:var(--jstr-text);cursor:pointer;transition:background .12s,border-color .12s}',
      '.jstr-view button:hover:not(:disabled){background:var(--eve-control-hover,rgba(255,255,255,.12))}',
      '.jstr-view button:focus-visible,.jstr-view summary:focus-visible{outline:2px solid #4c9aff;outline-offset:2px}',
      '.jstr-view button:disabled{opacity:.5;cursor:default}',
      '.jstr-view .jstr-primary{width:100%;min-height:34px;background:#2563eb;border-color:#3b82f6;color:#fff;font-weight:700}',
      '.jstr-view .jstr-primary:hover:not(:disabled){background:#1d4ed8}',
      '.jstr-view .jstr-danger{background:#b91c1c;border-color:#ef4444;color:#fff;font-weight:700}',
      '.jstr-view .jstr-danger:hover:not(:disabled){background:#991b1b}',
      '.jstr-view input,.jstr-view select{width:100%;min-height:28px;padding:3px 8px;border-radius:8px;border:1px solid var(--jstr-line);background:#0f1013;color:var(--jstr-text);font:inherit}',
      '.jstr-view input:focus,.jstr-view select:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.22)}',
      '.jstr-id{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.jstr-sn{font:700 16px var(--eve-mono,Consolas,monospace);letter-spacing:.04em}',
      '.jstr-pills{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}',
      '.jstr-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--jstr-line);background:rgba(255,255,255,.05);font-size:11px;font-weight:600;white-space:nowrap}',
      '.jstr-pill.ok{color:#86efac;border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.12)}',
      '.jstr-pill.warn{color:#fcd34d;border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.12)}',
      '.jstr-field{display:block;margin:6px 0}',
      '.jstr-label{display:block;margin-bottom:3px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--jstr-muted)}',
      '.jstr-match{margin:4px 0 6px;font-size:12px}',
      '.jstr-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0;font-size:12px}',
      '.jstr-view .jstr-chip{min-height:22px;padding:0 9px;border-radius:999px;font:12px var(--eve-mono,Consolas,monospace)}',
      '.jstr-view .jstr-chip[aria-pressed="true"]{border-color:#3b82f6;color:#93c5fd;background:rgba(59,130,246,.15)}',
      '.jstr-results{margin-top:4px}',
      '.jstr-view .jstr-result{display:block;width:100%;margin:2px 0;text-align:left}',
      '.jstr-send{margin-top:10px}',
      '.jstr-hint{margin:6px 0 0;font-size:12px;color:var(--jstr-muted)}',
      '.jstr-banner{margin:10px 0 0;padding:8px 10px;border-radius:8px;border:1px solid var(--jstr-line);background:rgba(255,255,255,.04)}',
      '.jstr-banner.ok{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.1)}',
      '.jstr-banner.warn{border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.1)}',
      '.jstr-banner.bad{border-color:rgba(239,68,68,.5);background:rgba(239,68,68,.1)}',
      '.jstr-banner p{margin:4px 0 0}',
      '.jstr-banner-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.jstr-pill.gold{color:#fde68a;border-color:rgba(250,204,21,.55);background:rgba(250,204,21,.12)}',
      '.jstr-next{margin:10px 0 0;padding:8px 10px;border-radius:8px;border:1px solid rgba(250,204,21,.55);background:rgba(250,204,21,.08);color:#fde68a}',
      '.jstr-next>div+div{margin-top:2px;font-size:12px;color:var(--jstr-text)}',
      '.jstr-released{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.08);color:#bbf7d0}',
      '.jstr-released .jstr-actions{margin-top:6px}',
      '.jstr-where{font-size:12px;color:var(--jstr-muted)}',
      '.jstr-status{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0 2px;font-size:12px}',
      '.jstr-steps{list-style:none;margin:6px 0 0;padding:0;counter-reset:jstr-step}',
      '.jstr-step{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:6px;padding-left:27px;counter-increment:jstr-step;color:var(--jstr-text);font-size:12px}',
      '.jstr-step::before{content:counter(jstr-step);position:absolute;left:0;top:3px;box-sizing:border-box;width:19px;height:19px;border-radius:50%;border:1px solid rgba(250,204,21,.6);background:rgba(250,204,21,.14);color:#fde68a;font:700 11px/17px var(--eve-font,sans-serif);text-align:center}',
      '.jstr-step>span{flex:1 1 9em;min-width:0;padding:3px 0;line-height:19px}',
      '.jstr-view .jstr-step>button{flex:none;width:auto;min-height:26px;padding:2px 10px}',
      '.jstr-choice{margin:10px 0 0}',
      '.jstr-option{display:flex;gap:8px;align-items:flex-start;margin:4px 0;padding:6px 8px;border:1px solid var(--jstr-line);border-radius:8px;cursor:pointer}',
      '.jstr-option:hover{border-color:rgba(250,204,21,.55)}',
      '.jstr-option>span{display:flex;flex-direction:column;font-size:12px}',
      '.jstr-view .jstr-option input{width:auto;min-height:0;margin:3px 0 0;flex:none}',
      '.jstr-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
      '.jstr-review{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0;font-size:12px}',
      '.jstr-review dt{color:var(--jstr-muted)}',
      '.jstr-review dd{margin:0;min-width:0;word-break:break-all}',
      '.jstr-more{margin-top:10px;border-top:1px solid var(--jstr-line);padding-top:6px}',
      '.jstr-more>summary{cursor:pointer;color:var(--jstr-muted);font-size:12px;user-select:none}',
      '.jstr-row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}',
      '.jstr-k{width:90px;flex:none;color:var(--jstr-muted);font-size:12px}',
      '.jstr-v{flex:1;min-width:0;word-break:break-all;font-size:12px}',
      '.jstr-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.jstr-muted{color:var(--jstr-muted)}',
      '.jstr-ok{color:#86efac}',
      '.jstr-warn{color:#fcd34d}',
      '.jstr-bad{color:#fca5a5}',
      '.jstr-strong{font-weight:700}',
      '.jstr-step>.jstr-sticker{flex:0 0 auto;min-width:48px;padding:4px 9px;line-height:1.15}',
      '.jstr-cart{display:inline-block;margin-right:6px;color:#f87171;vertical-align:-4px}',
      '.jstr-cart-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
      '.jstr-sticker{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;min-width:48px;padding:4px 9px;border-radius:5px;background:#dc2626;color:#fff;font:700 15px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em;box-shadow:0 1px 0 rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.28)}',
      '.jstr-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:jstr-spin .8s linear infinite;vertical-align:-2px;margin-right:6px}',
      '@keyframes jstr-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.jstr-spin{animation:none;border-right-color:currentColor}.jstr-card-toggle,.jstr-view button{transition:none}.jstr-card-toggle.requested{animation:none;box-shadow:0 0 10px rgba(250,204,21,.4)}.eve-alert-jira.eve-jira-replied{animation:none;box-shadow:0 0 10px rgba(250,204,21,.5)}#jstr-btn.requested{animation:none;box-shadow:0 0 12px rgba(250,204,21,.5)}}'
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById('jstr-style')) {
        return;
      }
      const style = el('style', { id: 'jstr-style' });
      style.textContent = REPAIR_CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    // One repair view renders into `host`: the Jira page panel or the box on an
    // alert card. readTicket() gives { key, link, summary, serial? } (serial
    // wins over the title's) or null when there is no ticket; it is read again
    // on every refresh. onSent() runs when this ticket is recorded as sent.
    function createView(host, readTicket, onSent) {
      let state = null;
      let attempt = 0;
      let authTimer = null;
      let announced = '';
      const choiceName = 'jstr-wf-' + Math.random().toString(36).slice(2, 8);
      host.classList.add('jstr-view');
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', 'Send to repair');
      const live = el('div', { className: 'jstr-sr', role: 'status', 'aria-live': 'polite' });
      const main = el('div', { className: 'jstr-main' });
      host.appendChild(live);
      host.appendChild(main);
      host.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state && state.send.phase === 'confirm') {
          event.preventDefault();
          event.stopPropagation();
          cancelConfirm();
        }
      });

      function announce(message) {
        if (message !== announced) {
          announced = message;
          live.textContent = message;
        }
      }

      // The ticket's saved repair request (newest comment that asks), or null.
      function currentRequest() {
        return state && state.ticket.key ? readRequests()[state.ticket.key] || null : null;
      }

      // Reopening keeps a finished send on screen (unless a newer request asks
      // for another); anything else starts over.
      function refresh() {
        if (state && (state.sending || (state.send.phase === 'sent' && !needsSend(currentRequest(), state.prior)))) {
          return;
        }
        attempt += 1;
        const raw = readTicket();
        if (!raw) {
          state = null;
          main.textContent = '';
          main.appendChild(el('div', { className: 'jstr-banner warn' }, 'No Jira ticket found for this unit yet.'));
          announce('No Jira ticket found for this unit yet.');
          return;
        }
        const parsed = parseTitle(raw.summary);
        state = {
          ticket: { key: raw.key || '', link: raw.link || '', summary: raw.summary || '', parsed: parsed },
          serial: raw.serial || parsed.serial,
          codeIdx: null,
          unit: null,
          pos: null,
          pick: null,
          chosen: null,
          comment: raw.link || '',
          search: '',
          loading: true,
          sending: false,
          send: { phase: 'idle' },
          prior: sentLog()[raw.key] || null,
          lastSend: null,
          waitAuth: false,
          detailsOpen: false,
          focus: ''
        };
        relookup();
      }

      function relookup() {
        state.send = { phase: 'idle' };
        state.waitAuth = false;
        if (!state.serial) {
          state.loading = false;
          render();
          return;
        }
        state.loading = true;
        render();
        const sn = state.serial;
        Promise.all([lookupUnit(sn), lookupPosition(sn)]).then(result => {
          if (!state || sn !== state.serial) {
            return;
          }
          state.unit = result[0];
          state.pos = result[1];
          state.loading = false;
          if (state.unit && state.unit.auth) {
            state.waitAuth = true;
            watchForAuth();
          }
          choose();
          if (state.unit && state.unit.alreadySent) {
            markObserved(sn, 'SFCS lookup');
          }
          render();
        });
      }

      // Both ways a ticket becomes sent (this tool's send; SFCS saying it is
      // already in repair) save through here, with the request it answers and
      // the workflow known then, and refresh the card, its Quick Actions row and
      // the Jira button (onSent).
      function saveSent(key, record, out) {
        const request = currentRequest();
        state.prior = saveRecord(key, {
          ...record,
          forRequest: request ? request.id : '',
          intent: workflowOf(key, request, null)
        });
        // The retest proof starts with this send (out: Collector's OUT right before it).
        if (workflowOf(key, request, state.prior) === 'retest') {
          releaseBegin(key, state.prior, out || null);
        }
        if (onSent) {
          onSent();
        }
      }

      // SFCS answered that the unit is already in its repair queue (sent from
      // here, the SFCS page or by someone else): the sent state, never an error.
      // Saved as seen, with when and where; no sender, send time, request ID or
      // symptom is known, so none is made up, and nothing is posted. A record
      // that already answers the current request is kept as it is.
      function markObserved(sn, source) {
        const key = state.ticket.key;
        const prior = key ? sentLog()[key] : null;
        if (!key || (prior && prior.sn === sn && !needsSend(currentRequest(), prior))) {
          state.prior = prior || null;
          if (onSent) {
            onSent();
          }
        } else {
          log(`Send to repair ${sn} (${key}): SFCS reports it already sent to repair (${source}).`);
          saveSent(key, { sn: sn, observed: true, source: source, at: Date.now() });
        }
        state.send = {
          phase: 'sent',
          observed: true,
          source: source,
          at: state.prior ? state.prior.at : Date.now(),
          pos: state.pos,
          checking: false
        };
      }

      function choose() {
        const list = state.unit && state.unit.data ? state.unit.data.symptomDropdownList : [];
        let codes = state.ticket.parsed.codes;
        if (state.codeIdx !== null && codes[state.codeIdx]) {
          codes = [codes[state.codeIdx]];
        }
        state.pick = pickSymptom(list, codes, getVal('jstr.rotation', 0));
        state.chosen = state.pick.entry;
      }

      function findEntry(code) {
        const list = state.unit && state.unit.data ? state.unit.data.symptomDropdownList || [] : [];
        return list.filter(entry => entry && entry.code === code)[0] || null;
      }

      function readyToSend() {
        return !!(state && !state.loading && !state.sending && state.unit && state.unit.data && state.chosen && String(state.comment || '').trim());
      }

      function isSlt() {
        return !!(state.unit && state.unit.data && String(state.unit.data.routeCode || '').toUpperCase() === 'SLT');
      }

      function pickIsFallback() {
        return !!(state.pick && state.pick.fallback && state.pick.entry && state.chosen && state.chosen.code === state.pick.entry.code);
      }

      // After a sign-in failure: wait for a new sign-in from an SFCS tab, then look up again.
      function watchForAuth() {
        if (authTimer) {
          return;
        }
        const first = getAuth();
        const since = first ? Number(first.at) || 0 : 0;
        authTimer = setInterval(() => {
          if (!state || !state.waitAuth || !host.isConnected) {
            clearInterval(authTimer);
            authTimer = null;
            return;
          }
          const auth = getAuth();
          if (auth && Number(auth.at) > since && !state.sending) {
            clearInterval(authTimer);
            authTimer = null;
            relookup();
          }
        }, TIMING.authPollMs);
      }

      function cancelConfirm() {
        state.send = { phase: 'idle' };
        state.focus = '.jstr-primary';
        render();
      }

      function render() {
        if (!state) {
          return;
        }
        const active = document.activeElement;
        let focusKey = null;
        let selStart = null;
        let selEnd = null;
        if (active && host.contains(active) && active.getAttribute && active.getAttribute('data-k')) {
          focusKey = active.getAttribute('data-k');
          try {
            selStart = active.selectionStart;
            selEnd = active.selectionEnd;
          } catch (error) {}
        }
        main.textContent = '';
        if (state.loading) {
          renderLoading();
        } else if (!state.serial) {
          renderNeedSerial();
        } else if (state.unit && state.unit.auth) {
          renderAuth();
        } else if (state.unit && state.unit.alreadySent) {
          renderAlreadySent();
        } else if (!state.unit || state.unit.error) {
          renderLookupFailed();
        } else {
          renderReady();
        }
        const target = state.focus ? main.querySelector(state.focus) : null;
        state.focus = '';
        if (target) {
          target.focus();
        } else if (focusKey) {
          const field = main.querySelector('[data-k="' + focusKey + '"]');
          if (field) {
            field.focus();
            try {
              if (typeof selStart === 'number') {
                field.setSelectionRange(selStart, selEnd);
              }
            } catch (error) {}
          }
        }
      }

      // Serial, ticket and rack location, then the open request as one status
      // line. The request's own words show while the operator has to pick the
      // workflow from them; otherwise only with Dev on (eve-dev-only).
      function renderId() {
        const id = el('div', { className: 'jstr-id' });
        id.appendChild(el('strong', { className: 'jstr-sn' }, state.serial || 'No serial'));
        // Serial and rack location on one line; the ticket key is already on the card.
        const parsed = state.ticket.parsed;
        if (parsed.rack) {
          id.appendChild(el('span', { className: 'jstr-where' }, parsed.rack + (parsed.loc ? ' \u00b7 ' + parsed.loc : '')));
        }
        main.appendChild(id);
        const request = currentRequest();
        if (request) {
          const unpicked = !workflowOf(state.ticket.key, request, state.prior);
          if (!unpicked && needsSend(request, state.prior) && state.send.phase !== 'sent') {
            const status = el('div', { className: 'jstr-status' });
            status.appendChild(pill('Repair requested', 'gold'));
            status.appendChild(el('span', { className: 'jstr-muted' }, request.author + ' \u00b7 ' + stamp(request.createdAt || request.at)));
            status.appendChild(workflowPill());
            main.appendChild(status);
          }
          const quote = el('blockquote', { className: 'jstr-quote' + (unpicked ? '' : ' eve-dev-only') });
          const intent = intentOf(request);
          quote.appendChild(el('div', { className: 'jstr-strong' }, intent === 'retest'
            ? 'Release for retest: it stays on its rack' + (needsSend(request, state.prior) ? '; send it to the repair queue first so Repair can release it.' : '.')
            : intent === 'physical'
              ? 'Physical transfer: the unit leaves its rack for Repair.'
              : 'Repair request: the comment does not say whether it leaves the rack.'));
          quote.appendChild(el('div', null, '\u201c' + request.excerpt + '\u201d'));
          const by = el('div', { className: 'jstr-muted' }, '\u2014 ' + request.author + ' \u00b7 ' + stamp(request.createdAt || request.at) + ' \u00b7 ');
          const view = el('button', { type: 'button', className: 'jstr-link', title: 'Open this comment in Jira' }, 'View in Jira \u2197');
          view.addEventListener('click', () => openExternal(commentUrl(state.ticket.key, request.id)));
          by.appendChild(view);
          quote.appendChild(by);
          main.appendChild(quote);
        }
      }

      function serialRow(parent) {
        const input = el('input', { type: 'text', 'data-k': 'sn', 'aria-label': 'Serial number', spellcheck: 'false' });
        input.value = state.serial || '';
        input.disabled = !!state.sending;
        input.addEventListener('change', () => {
          const value = input.value.trim().toUpperCase();
          if (value === state.serial) {
            return;
          }
          state.serial = value;
          relookup();
        });
        row(parent, 'Serial', input);
      }

      function renderLoading() {
        renderId();
        const line = el('div', { className: 'jstr-hint' });
        line.appendChild(el('span', { className: 'jstr-spin', 'aria-hidden': 'true' }));
        line.appendChild(document.createTextNode('Looking up ' + state.serial + ' in SFCS\u2026'));
        main.appendChild(line);
        announce('Looking up ' + state.serial + ' in SFCS.');
      }

      function renderNeedSerial() {
        renderId();
        main.appendChild(el('div', { className: 'jstr-banner warn' }, 'No serial found in the ticket title. Type it to continue.'));
        serialRow(main);
        announce('Serial needed.');
      }

      function renderAuth() {
        renderId();
        const box = el('div', { className: 'jstr-banner warn' });
        box.appendChild(el('div', { className: 'jstr-strong' }, state.unit.error));
        box.appendChild(el('p', null, 'Open SFCS in this browser and sign in there. This picks up your sign-in and tries again by itself.'));
        const actions = el('div', { className: 'jstr-actions' });
        const open = el('button', { className: 'jstr-primary', style: 'width:auto' }, 'Open SFCS');
        open.addEventListener('click', () => openExternal(SEND_PAGE));
        const again = el('button', null, 'Try again');
        again.addEventListener('click', relookup);
        actions.appendChild(open);
        actions.appendChild(again);
        box.appendChild(actions);
        if (state.waitAuth) {
          const wait = el('p', { className: 'jstr-muted' });
          wait.appendChild(el('span', { className: 'jstr-spin', 'aria-hidden': 'true' }));
          wait.appendChild(document.createTextNode('Waiting for your SFCS sign-in\u2026'));
          box.appendChild(wait);
        }
        main.appendChild(box);
        announce('SFCS sign-in needed.');
      }

      // SFCS has the unit in its repair queue already: the sent state, what comes
      // next, and a way to look again (once Repair releases it, it can be sent).
      function renderAlreadySent() {
        renderId();
        renderSend();
        const actions = el('div', { className: 'jstr-actions eve-dev-only' });
        const again = el('button', { title: 'Look the unit up in SFCS again' }, 'Check SFCS again');
        again.addEventListener('click', relookup);
        const byHand = el('button', { title: 'Open SFCS Send To Repair' }, 'Open Send To Repair');
        byHand.addEventListener('click', () => openExternal(SEND_PAGE));
        actions.appendChild(again);
        actions.appendChild(byHand);
        main.appendChild(actions);
        announce('Already sent to repair.');
      }

      function renderLookupFailed() {
        renderId();
        const box = el('div', { className: 'jstr-banner bad' });
        box.appendChild(el('div', { className: 'jstr-strong' }, 'SFCS lookup failed'));
        box.appendChild(el('p', null, (state.unit && state.unit.error) || 'no answer'));
        const actions = el('div', { className: 'jstr-actions' });
        const again = el('button', null, 'Try again');
        again.addEventListener('click', relookup);
        actions.appendChild(again);
        box.appendChild(actions);
        main.appendChild(box);
        serialRow(main);
        announce('SFCS lookup failed.');
      }

      function renderReady() {
        const data = state.unit.data;
        const slt = isSlt();
        const posOk = state.pos && !state.pos.error;
        const inRepair = posOk && /repair/i.test(state.pos.label);
        renderId();
        // Lookup facts are Dev-only, except a warning that still matters before the send.
        const sent = state.send.phase === 'sent';
        const pills = el('div', { className: 'jstr-pills' });
        const addPill = (text, kind) => {
          pills.appendChild(pill(text, kind)).classList.toggle('eve-dev-only', kind !== 'warn' || sent);
        };
        addPill(slt ? '\u2713 Route SLT' : 'Route ' + (String(data.routeCode || '') || 'empty') + ' (not SLT)', slt ? 'ok' : 'warn');
        addPill(posOk ? (inRepair ? '\u2713 ' : '') + 'Position: ' + state.pos.label : 'Position unknown', inRepair ? 'ok' : '');
        if (data.rma) {
          addPill('RMA', 'warn');
        }
        pills.classList.toggle('eve-dev-only', !pills.querySelector('.jstr-pill:not(.eve-dev-only)'));
        main.appendChild(pills);
        // Already sent for this request: no symptom pick to offer, only what comes next.
        if (!(state.send.phase === 'idle' && state.prior && !needsSend(currentRequest(), state.prior))) {
          renderSymptom();
        }
        renderSend();
        renderMore();
        announce(state.send.phase === 'idle' ? 'Ready. Review the symptom code, then send to repair.' : 'Send to repair: ' + state.send.phase + '.');
      }

      function renderSymptom() {
        const data = state.unit.data;
        const pk = state.pick;
        const field = el('label', { className: 'jstr-field' });
        field.appendChild(el('span', { className: 'jstr-label' }, 'Symptom code'));
        if (pk && state.chosen) {
          const select = el('select', { 'data-k': 'sel' });
          select.disabled = !!state.sending;
          const seen = {};
          const addOption = entry => {
            if (!entry || seen[entry.code]) {
              return;
            }
            seen[entry.code] = true;
            select.appendChild(el('option', { value: entry.code }, entry.label));
          };
          addOption(state.chosen);
          (pk.alternatives || []).forEach(addOption);
          select.value = state.chosen.code;
          select.addEventListener('change', () => {
            const entry = findEntry(select.value);
            if (entry) {
              state.chosen = entry;
              state.focus = '[data-k="sel"]';
              render();
            }
          });
          field.appendChild(select);
        }
        // Moot once sent: Dev-only then. Before that the match details, title
        // codes and search show without Dev only when the pick needs a look.
        const box = el('div');
        box.classList.toggle('eve-dev-only', state.send.phase === 'sent');
        box.appendChild(field);
        let review = true;
        if (!pk || !state.chosen) {
          box.appendChild(el('div', { className: 'jstr-match jstr-bad' }, 'No symptom entry available. Search the list below.'));
        } else {
          const mine = pk.entry && state.chosen.code === pk.entry.code;
          const kind = !mine ? 'muted' : (pk.fallback ? 'warn' : (pk.score >= 80 ? 'ok' : 'warn'));
          const icon = kind === 'ok' ? '\u2713 ' : (kind === 'warn' ? '\u26a0 ' : '');
          review = kind === 'warn';
          box.appendChild(el('div', { className: 'jstr-match jstr-' + kind + (review ? '' : ' eve-dev-only') }, icon + (mine ? upperFirst(pk.why) : 'Picked by you')));
        }
        const codes = state.ticket.parsed.codes;
        if (codes.length > 1) {
          const chips = el('div', { className: 'jstr-chips' + (review ? '' : ' eve-dev-only') });
          chips.appendChild(el('span', { className: 'jstr-muted' }, 'Codes in the title:'));
          codes.forEach((code, index) => {
            const on = !!(state.pick && state.pick.code && state.pick.code.full === code.full);
            const chip = el('button', { type: 'button', className: 'jstr-chip', 'aria-pressed': String(on) }, code.full);
            chip.addEventListener('click', () => {
              if (state.sending) {
                return;
              }
              state.codeIdx = index;
              choose();
              render();
            });
            chips.appendChild(chip);
          });
          box.appendChild(chips);
        }
        const search = el('input', { type: 'search', className: review ? '' : 'eve-dev-only', 'data-k': 'search', 'aria-label': 'Search the full symptom list', placeholder: 'Search the full list (code or text)', style: 'margin-top:4px' });
        search.value = state.search || '';
        search.disabled = !!state.sending;
        const results = el('div', { className: 'jstr-results' + (review ? '' : ' eve-dev-only') });
        const fill = () => {
          results.textContent = '';
          const query = String(state.search || '').trim().toUpperCase();
          if (query.length < 2) {
            return;
          }
          (data.symptomDropdownList || []).filter(entry => String(entry.label || '').toUpperCase().indexOf(query) !== -1).slice(0, 15).forEach(entry => {
            const choice = el('button', { type: 'button', className: 'jstr-result' }, entry.label);
            choice.addEventListener('click', () => {
              if (state.sending) {
                return;
              }
              state.chosen = entry;
              state.search = '';
              state.focus = '[data-k="sel"]';
              render();
            });
            results.appendChild(choice);
          });
        };
        search.addEventListener('input', () => {
          state.search = search.value;
          fill();
        });
        fill();
        box.appendChild(search);
        box.appendChild(results);
        main.appendChild(box);
      }

      function posLine(s) {
        if (!s.pos) {
          return s.checking ? el('div', { className: 'jstr-hint' }, 'Checking the collector position\u2026') : null;
        }
        if (s.pos.error) {
          return el('div', { className: 'jstr-hint jstr-warn' }, 'Collector position unknown: ' + s.pos.error + (s.checking ? ', checking again\u2026' : ''));
        }
        const inRepair = /repair/i.test(s.pos.label);
        let text = (inRepair ? '\u2713 ' : '') + 'Collector now: ' + s.pos.label + (s.before && s.before !== s.pos.label ? ' (was ' + s.before + ')' : '');
        if (!inRepair && s.checking) {
          text += ', checking again\u2026';
        }
        if (!inRepair && !s.checking && s.phase === 'sent') {
          text += s.observed
            ? '. The collector does not show Repair; check it in SFCS.'
            : '. SFCS said OK, but the collector does not show Repair yet; check it.';
        }
        return el('div', { className: 'jstr-hint ' + (inRepair ? 'jstr-ok' : (s.checking ? '' : 'jstr-warn')) }, text);
      }

      function renderSend() {
        const s = state.send;
        const sendWrap = el('div', { className: 'jstr-send' });
        if (s.phase === 'confirm') {
          renderConfirm(sendWrap, s);
        } else if (s.phase === 'sending') {
          const line = el('div', { className: 'jstr-hint' });
          line.appendChild(el('span', { className: 'jstr-spin', 'aria-hidden': 'true' }));
          line.appendChild(document.createTextNode('Sending ' + state.serial + ' to repair\u2026'));
          sendWrap.appendChild(line);
        } else if (s.phase === 'sent') {
          const banner = el('div', { className: 'jstr-banner ok' });
          const ours = !s.observed || (state.prior && !state.prior.observed);
          const head = el('div', { className: 'jstr-banner-head' });
          head.appendChild(el('span', { className: 'jstr-strong jstr-ok' }, !s.observed
            ? (s.wentThrough
              ? '\u2713 Sent. SFCS gave no clear answer at ' + hhmm(s.at) + ', but the collector shows it in repair.'
              : '\u2713 Sent to repair at ' + hhmm(s.at))
            : ours ? '\u2713 Sent to repair at ' + stamp(state.prior.at) : '\u2713 Already sent to repair'));
          head.appendChild(workflowPill());
          banner.appendChild(head);
          if (s.observed) {
            banner.appendChild(el('div', { className: 'jstr-hint eve-dev-only' }, ours
              ? 'From this tracker; SFCS still has it in the repair queue.'
              : 'Reported by SFCS (' + s.source + ', ' + stamp(s.at) + '). Who sent it, and when, is not known.'));
          }
          // The collector confirming Repair is a Dev detail; still checking, or not Repair, shows.
          const line = posLine(s);
          if (line) {
            line.classList.toggle('eve-dev-only', line.classList.contains('jstr-ok'));
            banner.appendChild(line);
          }
          sendWrap.appendChild(banner);
          renderFollowUps(sendWrap);
        } else if (s.phase === 'idle' && state.prior && !needsSend(currentRequest(), state.prior)) {
          // Already sent for this request (from here, or seen in the SFCS queue): never offered again.
          // What is left is the next step for its workflow: physical transfer, or waiting for the retest release.
          const banner = el('div', { className: 'jstr-banner ok' });
          const head = el('div', { className: 'jstr-banner-head' });
          head.appendChild(el('span', { className: 'jstr-strong jstr-ok' }, state.prior.observed
            ? '\u2713 Already sent to repair'
            : '\u2713 Sent to repair at ' + stamp(state.prior.at)));
          head.appendChild(workflowPill());
          banner.appendChild(head);
          sendWrap.appendChild(banner);
          renderFollowUps(sendWrap);
        } else {
          if (s.phase === 'failed') {
            const banner = el('div', { className: 'jstr-banner bad' });
            banner.appendChild(el('div', { className: 'jstr-strong' }, 'Not sent'));
            banner.appendChild(el('p', null, s.msg));
            if (s.auth) {
              banner.appendChild(el('p', { className: 'jstr-muted' }, 'Open SFCS in this browser (signed in). This refreshes by itself once your sign-in is picked up; then send again.'));
            }
            sendWrap.appendChild(banner);
          } else if (s.phase === 'unknown') {
            const banner = el('div', { className: 'jstr-banner warn' });
            banner.appendChild(el('div', { className: 'jstr-strong' }, 'No clear answer from SFCS (' + s.msg + ')'));
            const line = posLine(s);
            if (line) {
              banner.appendChild(line);
            }
            if (!s.checking) {
              banner.appendChild(el('p', null, 'Not confirmed. Check the unit in SFCS before sending again.'));
            }
            sendWrap.appendChild(banner);
          } else if (state.prior && workflowOf(state.ticket.key, currentRequest(), state.prior) === 'retest' &&
            isReleased(releaseOf(state.ticket.key, state.prior))) {
            // Back from repair and verified by Collector: no "already sent" warning.
            sendWrap.appendChild(releasedBox(state.prior.sn, releaseOf(state.ticket.key, state.prior)));
          } else if (state.prior && state.prior.observed) {
            sendWrap.appendChild(el('div', { className: 'jstr-hint jstr-warn' }, '\u26a0 SFCS reported it already sent to repair at ' + stamp(state.prior.at) + '; it does not now.'));
          } else if (state.prior) {
            sendWrap.appendChild(el('div', { className: 'jstr-hint jstr-warn' }, '\u26a0 Already sent from this tracker at ' + stamp(state.prior.at) + ' (' + (state.prior.label || state.prior.code) + ')' +
              (state.prior.pos ? '; the collector then showed ' + state.prior.pos : '') + '.'));
          }
          if (s.phase === 'idle' && !workflowOf(state.ticket.key, currentRequest(), null)) {
            sendWrap.appendChild(workflowChoice());
          }
          if (s.phase === 'idle' || !(s.phase === 'unknown' && s.checking)) {
            const retry = s.phase === 'failed' || s.phase === 'unknown';
            const send = el('button', { className: retry ? '' : 'jstr-primary', style: 'margin-top:8px;' + (retry ? '' : '') }, retry ? 'Try again' : (state.prior ? 'Send again' : 'Send to repair'));
            send.disabled = !readyToSend();
            send.addEventListener('click', () => {
              if (!readyToSend()) {
                return;
              }
              state.send = { phase: 'confirm', armedAt: Date.now() };
              state.focus = '.jstr-confirm';
              render();
            });
            sendWrap.appendChild(send);
            let hint = '';
            if (!state.chosen) hint = 'Pick a symptom code to continue.';
            else if (!String(state.comment || '').trim()) hint = 'Add a comment (normally the ticket link) under Details.';
            else if (s.phase === 'idle') hint = 'Nothing is sent until you confirm.';
            if (hint) {
              sendWrap.appendChild(el('div', { className: 'jstr-hint' }, hint));
            }
          }
        }
        main.appendChild(sendWrap);
      }

      function renderConfirm(parent, s) {
        const slt = isSlt();
        const box = el('div', { className: 'jstr-banner warn', role: 'group', 'aria-label': 'Confirm send' });
        box.appendChild(el('div', { className: 'jstr-strong' }, 'Send ' + state.serial + ' to repair?'));
        const review = el('dl', { className: 'jstr-review' });
        review.appendChild(el('dt', null, 'Symptom'));
        review.appendChild(el('dd', null, state.chosen ? state.chosen.label : ''));
        review.appendChild(el('dt', { className: 'eve-dev-only' }, 'Comment'));
        review.appendChild(el('dd', { className: 'eve-dev-only' }, String(state.comment || '').trim()));
        review.appendChild(el('dt', null, 'After'));
        review.appendChild(el('dd', null, WORKFLOW_LABEL[workflowOf(state.ticket.key, currentRequest(), null)]));
        box.appendChild(review);
        if (s.note) {
          box.appendChild(el('p', { className: 'jstr-warn' }, s.note));
        }
        if (!slt) {
          box.appendChild(el('p', { className: 'jstr-warn' }, 'Collector route is ' + (String(state.unit.data.routeCode || '') || 'empty') + ', not SLT.'));
        }
        if (pickIsFallback()) {
          box.appendChild(el('p', { className: 'jstr-warn' }, 'This symptom is a most-used fallback: nothing in the list matched the title.'));
        }
        if (state.prior) {
          box.appendChild(el('p', { className: 'jstr-warn' }, state.prior.observed
            ? 'SFCS reported it already sent to repair at ' + stamp(state.prior.at) + '.'
            : 'This tool already sent this ticket at ' + stamp(state.prior.at) + '.'));
        }
        const actions = el('div', { className: 'jstr-actions' });
        const ok = el('button', { className: 'jstr-danger jstr-confirm' }, slt ? 'Confirm send' : 'Send anyway');
        ok.addEventListener('click', () => {
          // A double-click on Send to repair must not also confirm.
          if (Date.now() - (s.armedAt || 0) < 600) {
            return;
          }
          ok.disabled = true;
          doSend(!slt);
        });
        const no = el('button', null, 'Cancel');
        no.addEventListener('click', cancelConfirm);
        actions.appendChild(ok);
        actions.appendChild(no);
        box.appendChild(actions);
        parent.appendChild(box);
      }

      // Small chip with the workflow after the send, for the sent banner.
      function workflowPill() {
        const workflow = workflowOf(state.ticket.key, currentRequest(), state.prior);
        return workflow === 'retest'
          ? pill('Retest path', 'gold')
          : workflow === 'physical' ? pill('Physical transfer', 'gold') : pill('Workflow not specified', 'warn');
      }

      // "What happens after sending?" when the request does not say: the
      // operator's pick, saved for this request comment. It sends nothing and
      // does not change whether Send is allowed.
      function workflowChoice() {
        const request = currentRequest();
        const picked = workflowOf(state.ticket.key, request, state.prior);
        const box = el('div', { className: 'jstr-choice', role: 'radiogroup', 'aria-label': 'What happens after sending?' });
        box.appendChild(el('div', { className: 'jstr-label' }, 'What happens after sending?'));
        [
          ['physical', 'Physical transfer', 'The unit leaves its rack for Repair.'],
          ['retest', 'Stay on rack / release for retest', 'Leave it on its rack; Repair releases it before retesting.']
        ].forEach(([value, title, note]) => {
          const option = el('label', { className: 'jstr-option' });
          const input = el('input', { type: 'radio', name: choiceName, value: value, 'data-k': 'wf-' + value });
          input.checked = picked === value;
          input.disabled = !!state.sending;
          input.addEventListener('change', () => {
            savePick(state.ticket.key, request, value);
            state.focus = '[data-k="wf-' + value + '"]';
            render();
            if (onSent) {
              onSent();
            }
          });
          const text = el('span');
          text.appendChild(el('span', { className: 'jstr-strong' }, title));
          text.appendChild(el('span', { className: 'jstr-muted' }, note));
          option.appendChild(input);
          option.appendChild(text);
          box.appendChild(option);
        });
        return box;
      }

      // The red ticket sticker: the live digits of this ticket's key (MFGS-599951
      // shows 599 over 951), never the prefix and never a made-up number.
      function ticketSticker(key) {
        const digits = (/^[A-Z][A-Z0-9]*-(\d{3,})$/.exec(String(key || '').trim().toUpperCase()) || [])[1] || '';
        if (!digits) {
          return el('span', { className: 'jstr-muted' }, 'No ticket number yet. Open the Jira ticket first.');
        }
        const cut = Math.ceil(digits.length / 2);
        const sticker = el('span', { className: 'jstr-sticker', role: 'img', 'aria-label': 'Red sticker: ' + digits });
        sticker.appendChild(el('span', null, digits.slice(0, cut)));
        sticker.appendChild(el('span', null, digits.slice(cut)));
        return sticker;
      }

      // The workflow's numbered steps, each [text, button?]; the button sits
      // beside its step (under it when the box is narrow). The note is Dev-only.
      function nextStep(title, note, steps, icon) {
        const box = el('div', { className: 'jstr-next' });
        const head = el('div', { className: 'jstr-strong' });
        if (icon) {
          const mark = el('span', { className: 'jstr-cart', 'aria-hidden': 'true' });
          mark.innerHTML = qaIcon(icon, 'jstr-cart-svg');
          head.appendChild(mark);
        }
        head.appendChild(document.createTextNode(title));
        box.appendChild(head);
        box.appendChild(el('div', { className: 'eve-dev-only' }, note));
        const list = el('ol', { className: 'jstr-steps' });
        steps.forEach(([text, button]) => {
          const item = el('li', { className: 'jstr-step' });
          item.appendChild(el('span', null, text));
          if (button) {
            item.appendChild(button);
          }
          list.appendChild(item);
        });
        box.appendChild(list);
        return box;
      }

      // What to do once SFCS has it, by workflow. The SFCS queue says nothing
      // about where the unit physically is, or whether Repair released it.
      function renderFollowUps(parent) {
        const ticket = state.ticket;
        const request = currentRequest();
        const workflow = workflowOf(ticket.key, request, state.prior);
        const sn = state.lastSend ? state.lastSend.sn : state.serial;
        const message = SEND_MESSAGE.replace(/\{serial\}/g, sn);
        const actions = el('div', { className: 'jstr-actions eve-dev-only' });
        if (workflow === 'retest') {
          const proof = releaseOf(ticket.key, state.prior);
          if (isReleased(proof)) {
            parent.appendChild(releasedBox(sn, proof));
          } else {
            const link = el('button', { className: 'jstr-primary', title: 'The ticket title as a link to it, for the Teams repair group' }, 'Copy ticket link');
            link.addEventListener('click', () => copyTicketLink(ticket, sn, link));
            parent.appendChild(nextStep('Awaiting release for retest', 'SFCS queue updated. It does not show when Repair releases it. ' + releaseProgress(proof), [
              ['Leave the server on its rack.'],
              ['Ask Repair to release it before retesting.', link]
            ]));
          }
          if (request && request.id) {
            const view = el('button', { title: 'Open the comment that asked for it' }, 'View Jira comment \u2197');
            view.addEventListener('click', () => openExternal(commentUrl(ticket.key, request.id)));
            actions.appendChild(view);
          }
        } else if (workflow === 'physical') {
          const contact = el('button', { className: 'jstr-primary', title: 'Copies "' + message.replace(/\n/g, ' / ') + '"' }, 'Copy message for ' + REPAIR_CONTACT);
          contact.addEventListener('click', () => copyText(message, contact));
          parent.appendChild(nextStep('Arrange physical transfer', 'SFCS queue updated. The physical move is not confirmed.', [
            ['Message ' + REPAIR_CONTACT + ' that it is coming.', contact],
            ['Apply a red sticker with the ticket number:', ticketSticker(ticket.key)]
          ], 'cart'));
        } else {
          parent.appendChild(workflowChoice());
        }
        const details = el('button', { title: 'Copy what was sent and what came back, for troubleshooting' }, 'Copy details');
        details.addEventListener('click', () => copyText(detailsText(), details));
        actions.appendChild(details);
        parent.appendChild(actions);
      }

      // Everything that rarely needs a change, out of the way: Dev-only unless
      // the send still needs its comment typed in here.
      function renderMore() {
        const data = state.unit.data;
        const needComment = !String(state.comment || '').trim() && state.send.phase !== 'sent';
        const more = el('details', { className: 'jstr-more' + (needComment ? '' : ' eve-dev-only') });
        more.open = state.detailsOpen;
        more.addEventListener('toggle', () => {
          state.detailsOpen = more.open;
        });
        more.appendChild(el('summary', null, 'Details and options'));
        row(more, 'Ticket', state.ticket.key || '(not found)');
        row(more, 'Title', state.ticket.summary || '(not found)');
        if (state.ticket.parsed.rack) {
          row(more, 'Rack in title', state.ticket.parsed.rack);
        }
        row(more, 'Line', String(data.lineNo || ''));
        row(more, 'Asset tag', String(data.assetTag || ''));
        serialRow(more);
        const commentWrap = el('span', { style: 'display:flex;gap:6px;align-items:center' });
        const commentIn = el('input', { type: 'text', 'data-k': 'comment', 'aria-label': 'Comment sent with the repair request' });
        commentIn.value = state.comment;
        commentIn.disabled = !!state.sending;
        commentIn.addEventListener('input', () => {
          state.comment = commentIn.value;
          const send = main.querySelector('.jstr-send > button:not(.jstr-danger)');
          if (send) {
            send.disabled = !readyToSend();
          }
        });
        const commentCopy = el('button', { style: 'flex:none' }, 'Copy');
        commentCopy.addEventListener('click', () => copyText(String(state.comment || ''), commentCopy));
        commentWrap.appendChild(commentIn);
        commentWrap.appendChild(commentCopy);
        row(more, 'Comment', commentWrap);
        row(more, 'Classification', 'left blank', 'jstr-muted');
        const actions = el('div', { className: 'jstr-actions' });
        const byHand = el('button', { title: 'Open SFCS Send To Repair to do it by hand' }, 'Open Send To Repair');
        byHand.addEventListener('click', () => openExternal(SEND_PAGE));
        actions.appendChild(byHand);
        if (state.chosen) {
          const symptom = el('button', { title: 'Copy the symptom entry to paste into the Symptom Code box' }, 'Copy symptom');
          symptom.addEventListener('click', () => copyText(state.chosen.label, symptom));
          actions.appendChild(symptom);
        }
        const serial = el('button', null, 'Copy serial');
        serial.addEventListener('click', () => copyText(state.serial, serial));
        actions.appendChild(serial);
        more.appendChild(actions);
        const auth = getAuth();
        const signIn = el('div', { className: 'jstr-hint' });
        signIn.appendChild(document.createTextNode(auth
          ? 'SFCS sign-in picked up ' + stamp(auth.at) + ', auto-deleted ' + stamp(Number(auth.at) + AUTH_MAX_AGE_MS) + '. '
          : 'No SFCS sign-in picked up yet. '));
        if (auth) {
          const forget = el('button', { title: 'Delete the saved copy of your SFCS sign-in now' }, 'Forget');
          forget.addEventListener('click', () => {
            forgetAuth();
            render();
          });
          signIn.appendChild(forget);
        }
        more.appendChild(signIn);
        main.appendChild(more);
      }

      function detailsText() {
        const s = state.send || {};
        const last = state.lastSend || {};
        return [
          'Send to repair details (' + TRACKER_LABEL + ' v' + SCRIPT_VERSION + ')',
          'ticket: ' + state.ticket.key,
          'serial: ' + (last.sn || state.serial),
          'symptom: ' + (last.label || (state.chosen ? state.chosen.label : '')),
          'comment: ' + (last.comment || state.comment),
          'sent anyway (route not SLT): ' + (last.forced ? 'yes' : 'no'),
          'result: ' + s.phase + (s.observed ? ' (already in the SFCS repair queue; seen by ' + s.source + ')' : '') +
            (s.msg ? ' (' + s.msg + ')' : '') + (s.requestId ? ', SFCS request ' + s.requestId : ''),
          'after sending: ' + WORKFLOW_LABEL[workflowOf(state.ticket.key, currentRequest(), state.prior)],
          'time: ' + (s.at ? new Date(s.at).toString() : ''),
          'position before: ' + (s.before || 'unknown'),
          'position after: ' + (s.pos ? (s.pos.error ? 'unknown (' + s.pos.error + ')' : s.pos.label) : 'not checked'),
          'collector step after: ' + (s.pos && s.pos.raw ? JSON.stringify(s.pos.raw) : '')
        ].join('\n');
      }

      // ---- the send ----

      function doSend(force) {
        if (!state || state.sending || !readyToSend()) {
          return;
        }
        state.sending = true;
        const mine = ++attempt;
        const ticket = state.ticket;
        const sn = state.serial;
        const code = state.chosen.code;
        const comment = String(state.comment || '').trim();
        const wasFallback = pickIsFallback();
        const before = state.pos && !state.pos.error ? state.pos.label : '';
        state.send = { phase: 'sending', before: before };
        render();
        let release = () => {};
        let preOut = null;

        function finish(res, entry) {
          release();
          state.sending = false;
          if (res.kind === 'already') {
            // SFCS turned the send down: the unit is already in its repair queue.
            state.unit = { alreadySent: true, msg: res.msg };
            markObserved(sn, 'SFCS reply to the send');
            render();
            return;
          }
          const s = { phase: res.kind, msg: res.msg || '', requestId: res.requestId || '', at: Date.now(), before: before, pos: null, checking: true, auth: !!res.auth };
          state.send = s;
          log(`Send to repair ${sn} (${ticket.key}): ${res.kind}${res.msg ? ' - ' + res.msg : ''}`);
          if (res.auth) {
            state.waitAuth = true;
            watchForAuth();
          }
          let counted = false;
          const markSent = (posLabel, verified) => {
            if (wasFallback && !counted) {
              counted = true;
              setVal('jstr.rotation', (Number(getVal('jstr.rotation', 0)) || 0) + 1);
            }
            saveSent(ticket.key, {
              sn: sn,
              code: entry ? entry.code : code,
              label: entry ? entry.label : '',
              at: s.at,
              requestId: s.requestId,
              pos: posLabel || '',
              verified: !!verified
            }, preOut);
          };
          if (res.kind === 'sent') {
            markSent('', false);
          }
          render();
          watchPosition(sn, res.kind === 'failed' ? [0] : TIMING.verify.slice(), mine, (position, inRepair, last) => {
            s.pos = position;
            state.pos = position;
            if (inRepair || last) {
              s.checking = false;
            }
            if (inRepair && s.phase === 'unknown') {
              s.phase = 'sent';
              s.wentThrough = true;
              markSent(position.label, true);
            } else if (s.phase === 'sent' && (inRepair || last)) {
              markSent(position && !position.error ? position.label : '', inRepair);
            }
            render();
          });
        }

        // Fresh lookup right before sending, as the page does when the serial is entered.
        const sendNow = () => lookupUnit(sn).then(fresh => {
          if (mine !== attempt) {
            release();
            return;
          }
          if (fresh.alreadySent) {
            // Sent meanwhile (here, on the SFCS page or by someone else): no POST.
            release();
            state.sending = false;
            state.unit = fresh;
            markObserved(sn, 'SFCS check right before sending');
            render();
            return;
          }
          if (fresh.error) {
            finish({ kind: 'failed', auth: !!fresh.auth, msg: 'The lookup right before sending failed (' + fresh.error + ')' }, null);
            return;
          }
          state.unit = fresh;
          const data = fresh.data;
          const entry = (data.symptomDropdownList || []).filter(item => item && item.code === code)[0];
          if (!entry) {
            finish({ kind: 'failed', msg: code + ' is no longer in the symptom list' }, null);
            return;
          }
          state.chosen = entry;
          if (!force && String(data.routeCode || '').toUpperCase() !== 'SLT') {
            release();
            state.sending = false;
            state.send = { phase: 'confirm', armedAt: Date.now(), note: 'The route changed since this was opened.' };
            state.focus = '.jstr-confirm';
            render();
            return;
          }
          state.lastSend = { sn: data.serialNumber, code: entry.code, label: entry.label, comment: comment, forced: !!force };
          // Collector's position first (a few seconds at most): the OUT proof of a retest release.
          outBeforeSend(sn).then(out => {
            preOut = out;
            return postSend(buildPayload(data, entry, comment));
          }).then(res => {
            if (mine === attempt) {
              finish(res, entry);
            } else {
              release();
            }
          });
        });

        // One page sends a unit at a time: another open tracker page sending it
        // now (its claim leased past the send's own time-out) means no send here.
        coordTake(`send|${sn}`, { lease: TIMING.sendTimeoutMs + 60000 }, (won, free) => {
          release = free;
          if (mine !== attempt) {
            release();
            return;
          }
          if (!won) {
            finish({ kind: 'failed', msg: 'Another open tracker page is sending ' + sn + ' to repair right now, so this one did not. Its result shows on this card when it finishes; check SFCS before trying again.' }, null);
            return;
          }
          sendNow();
        });
      }

      function watchPosition(sn, delays, mine, onUpdate) {
        let i = 0;
        const next = () => {
          if (i >= delays.length) {
            return;
          }
          setTimeout(() => {
            if (mine !== attempt) {
              return;
            }
            lookupPosition(sn).then(position => {
              if (mine !== attempt) {
                return;
              }
              i += 1;
              const inRepair = !!(position && !position.error && /repair/i.test(position.label));
              const last = i >= delays.length;
              onUpdate(position, inRepair, last);
              if (!inRepair && !last) {
                next();
              }
            });
          }, delays[i]);
        };
        next();
      }

      // Repaints a finished send (or the idle box of a sent ticket) from the saved
      // records when another page or the release check changed them.
      function redraw() {
        if (state && !state.loading && !state.sending && (state.send.phase === 'sent' || state.send.phase === 'idle')) {
          state.prior = sentLog()[state.ticket.key] || state.prior;
          render();
        }
      }

      return { refresh, redraw };
    }

    // ---- repair requests in Jira comments ----
    // A test engineer asks in a ticket comment for the unit to go to repair:
    // "Please send to Repair to inspect the BF3-to-ROT wipe cable". Only that
    // instruction counts. "REPAIR: please reseat the RETIMER card" asks the
    // repair team to come to the unit; "sent"/"sending to repair" report it;
    // "do not send to repair" says no. Code, log and quote blocks are skipped.
    const REQUEST_RE = /\bsend\s+(?:(?:it|this|that|these|those|the|a|unit|units|server|servers|system|systems|node|nodes|board|back|over|them|please)\s+){0,3}(?:to|into)\s+(?:the\s+)?repair\b/gi;
    // "Repair, please release the server for retest", "release it from repair",
    // "... then release for retest": Repair can only release a unit from the
    // repair queue, so it has to be sent there first.
    const RELEASE_RE = /\brepair\b(?:\s+(?:team|guys|folks))?[\s,:;-]+(?:(?:please|pls|kindly|can you|could you|to)[\s,]+)*release\b|\brelease\b[^.!?\n]{0,40}\bfrom\s+(?:the\s+)?repair\b|\brelease\b[^.!?\n]{0,30}\bfor\s+(?:a\s+)?re-?test(?:ing)?\b/gi;
    const NEGATED_RE = /\b(?:not|never|don[\u2019']?t|didn[\u2019']?t|doesn[\u2019']?t|won[\u2019']?t|shouldn[\u2019']?t|can[\u2019']?t|cannot|no need to|no need for|without|instead of|rather than)\s+(?:[a-z\u2019']+\s+){0,2}$/i;
    // What happens after the send (request.intent). 'retest': a release ask
    // (send-then-release in one comment too) or "leave / keep it on the rack";
    // the unit stays on its rack. 'physical': an explicit move or removal ("pull
    // it out", "physically", "take it to repair"). 'unclear': only "send to
    // repair (to debug / inspect ...)"; the operator says which.
    const KEEP_ON_RACK_RE = /\b(?:(?:leave|keep)\s+(?:(?:it|this|that|them|the\s+(?:unit|server|system|node)s?)\s+)?|stays?\s+)(?:on|in)\s+(?:the\s+|its\s+)?rack\b/gi;
    const PHYSICAL_RE = /\bphysical(?:ly)?\b|\b(?:un|de-?)rack(?:ed)?\b|\b(?:off|out\s+of)\s+(?:the\s+|its\s+)?rack\b|\b(?:pull|take|remove)\s+(?:(?:it|this|that|them|the\s+(?:unit|server|system|node)s?)\s+)?(?:out|off)\b|\b(?:move|bring|carry|walk|take)\s+(?:(?:it|this|that|them|the\s+(?:unit|server|system|node)s?)\s+)?(?:over\s+)?to\s+(?:the\s+)?repair\b/gi;

    // The sentence of the first match of `pattern` that is not negated, or ''.
    function askIn(text, pattern) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (NEGATED_RE.test(text.slice(Math.max(0, match.index - 60), match.index))) {
          continue;
        }
        let from = match.index;
        while (from > 0 && !/[.!?\n]/.test(text[from - 1])) {
          from -= 1;
        }
        let to = match.index + match[0].length;
        while (to < text.length && !/[.!?\n]/.test(text[to])) {
          to += 1;
        }
        const sentence = text.slice(from, to + 1).replace(/\[~([^\]]+)\]/g, '@$1').replace(/\s+/g, ' ').trim();
        return sentence.length > 180 ? sentence.slice(0, 179) + '\u2026' : sentence;
      }
      return '';
    }

    // { kind: 'send' | 'release', intent: 'physical' | 'retest' | 'unclear',
    // excerpt: the sentence that asks, alsoSend: a release ask that also asks
    // to send ("send it to repair, then release it for retest") }, or null. A
    // release anywhere in the comment wins over the send it follows.
    function findRepairRequest(body) {
      const text = String(body || '')
        .replace(/\{(code|noformat|quote)(?::[^}]*)?\}[\s\S]*?\{\1\}/gi, ' ')
        .replace(/^bq\.\s.*$/gim, ' ');
      const release = askIn(text, RELEASE_RE);
      const send = askIn(text, REQUEST_RE);
      if (!release && !send) {
        return null;
      }
      const intent = release || askIn(text, KEEP_ON_RACK_RE)
        ? 'retest'
        : askIn(text, PHYSICAL_RE) ? 'physical' : 'unclear';
      return { kind: release ? 'release' : 'send', intent: intent, excerpt: release || send, alsoSend: !!(release && send) };
    }

    const jiraTimeMs = value => Date.parse(String(value || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0;
    // An edited comment counts from its edit: the newer wording is the current ask.
    const commentTimeMs = comment => Math.max(jiraTimeMs(comment.created), jiraTimeMs(comment.updated));

    // The newest comment that asks for repair, or null.
    function requestIn(comments) {
      const ordered = comments.filter(isRecordObject).sort((a, b) => commentTimeMs(b) - commentTimeMs(a));
      for (const comment of ordered) {
        const found = findRepairRequest(comment.body);
        if (found) {
          const author = isRecordObject(comment.author) ? comment.author : {};
          return {
            id: String(comment.id || ''),
            author: String(author.displayName || author.name || 'Someone').slice(0, 80),
            createdAt: jiraTimeMs(comment.created),
            kind: found.kind,
            intent: found.intent,
            excerpt: found.excerpt,
            alsoSend: found.alsoSend
          };
        }
      }
      return null;
    }
    // ---- end repair request parsing ----

    const REQUEST_FAST_MS = 2 * 60 * 1000;
    const REQUEST_SLOW_MS = 10 * 60 * 1000;
    const REQUEST_FAST_FOR_MS = 2 * 60 * 60 * 1000;
    const REQUESTS_MAX = 300;
    const REPLY_MARK = '\u{1f4ac}';
    const REPLY_ICON_SVG =
      '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';
    const requestCheckedAt = new Map();
    let requestBusy = false;
    let mePromise = null;

    const readRequests = () => readMap('jstr.requests');
    const readPicks = () => readMap('jstr.workflow');
    // A reply seen on any page (jstr.acks, written only by a look) clears its
    // count even if another page's background check saved the thread just before.
    const readThreads = () => {
      const threads = readMap('jstr.threads');
      Object.keys(threads).forEach(key => {
        const thread = threads[key];
        const ack = readEntry('jstr.acks', key);
        const seen = ack ? Number(ack.upTo) || 0 : 0;
        if (thread.count && seen >= (Number(thread.lastAt) || 0)) {
          threads[key] = { ...thread, ackAt: Math.max(Number(thread.ackAt) || 0, seen), count: 0, lastId: '', author: '', excerpt: '' };
        }
      });
      return threads;
    };

    // Saves the ticket's newest request: a newer comment replaces the saved one,
    // an edit of the same comment updates it, an unchanged one writes nothing.
    // True only for a new request comment (worth a toast): none saved before,
    // or another comment at least as new.
    function storeRequest(key, request) {
      const prior = readEntry('jstr.requests', key);
      if (prior && prior.id === request.id && prior.kind === request.kind && prior.intent === request.intent &&
        prior.excerpt === request.excerpt && !!prior.alsoSend === !!request.alsoSend) {
        return false;
      }
      const fresh = !prior || (prior.id !== request.id &&
        (Number(request.createdAt) || 0) >= (Number(prior.createdAt) || 0));
      writeEntry('jstr.requests', key, { ...request, at: Date.now() });
      return fresh;
    }

    // 'physical' | 'retest' | 'unclear', or 'unspecified' for a request saved
    // before intents (a release was always a retest).
    function intentOf(request) {
      if (!request) {
        return '';
      }
      return request.intent || (request.kind === 'release' ? 'retest' : 'unspecified');
    }

    // The workflow after the send: the request's own intent, else the operator's
    // pick for that request, else (no request on record) what the send saved.
    // '' = not specified: never shown as a physical move.
    function workflowOf(key, request, sent) {
      const intent = intentOf(request);
      if (intent === 'physical' || intent === 'retest') {
        return intent;
      }
      const pick = key ? readPicks()[key] : null;
      if (pick && pick.forRequest === (request ? request.id : '') &&
        (pick.workflow === 'physical' || pick.workflow === 'retest')) {
        return pick.workflow;
      }
      return !request && sent && (sent.intent === 'physical' || sent.intent === 'retest') ? sent.intent : '';
    }

    // The operator's answer to "What happens after sending?", for this request comment only.
    function savePick(key, request, workflow) {
      writeEntry('jstr.workflow', key, { workflow: workflow, forRequest: request ? request.id : '', at: Date.now() });
    }

    // Still waiting for its send? Not once a send (or SFCS's "already sent")
    // answered it. A bare release ask for a unit already in the queue is a
    // retest follow-up, never a new send; a newer comment that asks to send
    // (with or without a release) after an old send is a new repair cycle.
    function needsSend(request, sent) {
      if (!request) {
        return false;
      }
      if (!sent) {
        return true;
      }
      if ((sent.forRequest && sent.forRequest === request.id) || (request.kind === 'release' && !request.alsoSend)) {
        return false;
      }
      return (Number(request.createdAt) || Number(request.at) || 0) > (Number(sent.at) || 0);
    }

    const WORKFLOW_LABEL = {
      physical: 'Physical transfer: the unit leaves its rack',
      retest: 'Stays on its rack; Repair releases it for retest',
      '': 'Not specified'
    };

    // Short next step for a sent ticket (card row, Quick Actions).
    function nextStepOf(workflow, sent, key) {
      if (workflow === 'retest') {
        return isReleased(releaseOf(key, sent)) ? 'Released for retest' : 'Awaiting release for retest';
      }
      if (workflow === 'physical') {
        return 'Arrange physical transfer';
      }
      return (sent.observed ? 'Seen in SFCS ' : 'Sent ') + stamp(sent.at);
    }

    // ---- retest release (Collector-verified) ----
    // After a send whose workflow is "stays on its rack, Repair releases it for
    // retest", the card only says Released for retest once Collector has shown
    // this unit OUT, then in repair, then (a later lookup) back at an approved
    // state: the Bulk Start green list, matched whole (never a substring). Each
    // step is one read-only position lookup, saved with when it started in
    // jstr.release/<ticket> and tied to the send it follows (cycle = serial +
    // send time), so a newer send starts the proof again and nothing older
    // carries over. Errors, sign-in pages and empty routes never advance it.
    // The OUT step is looked up right before the send; if Collector cannot show
    // it, the card keeps waiting and Dev says what is missing.
    const RELEASE_KEY = 'jstr.release';
    const RELEASE_WATCH_MAX_MS = 72 * 3600 * 1000;
    const RELEASE_FAST_FOR_MS = 6 * 3600 * 1000;
    const RELEASE_FAST_MS = 60 * 1000;
    const RELEASE_SLOW_MS = 10 * 60 * 1000;
    const RELEASE_OUT_MAX_AGE_MS = 90000;
    const RELEASE_BUSY_MAX_MS = 60000;
    const APPROVED_DEFAULT = ['TEST-SV-HP OUT', 'SLT', 'SLT Queue'];
    const releasePolled = new Map();
    let releaseBusy = false;
    let releaseBusyAt = 0;

    const labelKey = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const isOutLabel = label => /(^| )OUT$/.test(labelKey(label));
    const isRepairLabel = label => /(^| )REPAIR( |$)/.test(labelKey(label));
    const cycleOf = sent => (sent && sent.sn ? sent.sn + '|' + (Number(sent.at) || 0) : '');

    // Same list Bulk Start uses to let a unit start (its saved setting, else its default).
    function approvedLabels() {
      const saved = getVal('eveBulkStartState', null);
      const list = saved && saved.cfg ? saved.cfg.green : null;
      const items = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : APPROVED_DEFAULT;
      return items.map(labelKey).filter(Boolean);
    }

    // The proof saved for this send, or null (none yet, or it belongs to another send).
    function releaseOf(key, sent) {
      const rec = key && sent ? readEntry(RELEASE_KEY, key) : null;
      return rec && rec.cycle && rec.cycle === cycleOf(sent) ? rec : null;
    }

    // All three steps, each from a later lookup than the one before.
    function isReleased(rec) {
      return !!(rec && rec.repair && rec.slt && Number(rec.repair.at) < Number(rec.slt.at) &&
        (!rec.out || Number(rec.out.at) < Number(rec.repair.at)));
    }

    // Starts (or keeps) the proof for this send. out: the Collector lookup made
    // right before the send, kept only if it showed OUT and is the send's own.
    function releaseBegin(key, sent, out) {
      if (!key || !sent || !sent.sn || !(Number(sent.at) > 0)) {
        return;
      }
      const cycle = cycleOf(sent);
      const proof = out && isOutLabel(out.label) && Number(out.at) <= Number(sent.at) &&
        Number(sent.at) - Number(out.at) <= RELEASE_OUT_MAX_AGE_MS
        ? { at: Number(out.at), label: String(out.label) }
        : null;
      const prior = readEntry(RELEASE_KEY, key);
      if (prior && prior.cycle === cycle) {
        if (proof && !prior.out && !prior.repair) {
          writeEntry(RELEASE_KEY, key, { ...prior, out: proof, began: Math.min(Number(prior.began) || proof.at, proof.at) });
        }
        return;
      }
      // A page holding an older send never replaces the proof of a newer one.
      const priorAt = prior ? Number(String(prior.cycle).split('|')[1]) || 0 : 0;
      if (priorAt > Number(sent.at)) {
        return;
      }
      writeEntry(RELEASE_KEY, key, {
        cycle: cycle,
        sn: sent.sn,
        began: proof ? proof.at : Number(sent.at),
        out: proof,
        repair: null,
        slt: null
      });
    }

    // Collector position right before the send: the unit's OUT proof for this
    // send. Never holds the send for long; null when it cannot be read.
    function outBeforeSend(sn) {
      const startedAt = Date.now();
      return Promise.race([
        lookupPosition(sn).then(
          position => (position && !position.error && position.raw ? { at: startedAt, label: position.label } : null),
          () => null
        ),
        new Promise(resolve => setTimeout(() => resolve(null), 4000))
      ]);
    }

    // One position lookup (started at startedAt) for the send `sent`. Moves the
    // proof forward by at most one step, in order; true when it just completed.
    function observeRelease(key, sent, startedAt, position) {
      if (!position || position.error || !position.raw || !position.label) {
        return false;
      }
      const current = sentLog()[key];
      if (!current || cycleOf(current) !== cycleOf(sent)) {
        return false;
      }
      const rec = releaseOf(key, current);
      if (rec && rec.slt) {
        // Already released: keep the latest Collector state (retesting, or back in Repair) for the card.
        const seenAt = Number((rec.now || rec.slt).at) || 0;
        if (startedAt > seenAt) {
          writeEntry(RELEASE_KEY, key, { ...rec, now: { at: startedAt, label: String(position.label) } });
        }
        return false;
      }
      if (!rec) {
        return false;
      }
      const lastAt = Math.max(Number(rec.out && rec.out.at) || 0, Number(rec.repair && rec.repair.at) || 0);
      if (startedAt <= lastAt || startedAt < (Number(rec.began) || 0)) {
        return false;
      }
      const step = { at: startedAt, label: String(position.label) };
      const next = { ...rec };
      if (isRepairLabel(position.label)) {
        if (rec.repair) {
          return false;
        }
        next.repair = step;
      } else if (!rec.repair) {
        // Collector already showed Repair when the send was checked (saved with the send): that is the repair step.
        const sawRepair = !!current.verified && isRepairLabel(current.pos);
        if (sawRepair && startedAt > Number(current.at)) {
          next.repair = { at: Number(current.at), label: String(current.pos) };
          next.slt = step;
          next.now = step;
        } else {
          if (rec.out || !isOutLabel(position.label)) {
            return false;
          }
          next.out = step;
        }
      } else {
        // Seen in Repair, now anywhere else: Repair let it go. An approved state means ready for retest; any
        // other state (a test running, say) means it was released and is already being retested. The OUT
        // before the send only strengthens the proof; a unit sent by another route still counts.
        next.slt = step;
        next.now = step;
      }
      writeEntry(RELEASE_KEY, key, next);
      return !!next.slt;
    }

    // After the release: 'ready' (approved state), 'testing' (any other state) or 'repair' (back in Repair).
    function afterRelease(rec) {
      const label = rec && (rec.now || rec.slt) ? String((rec.now || rec.slt).label) : '';
      if (isRepairLabel(label)) {
        return { kind: 'repair', label: label };
      }
      return { kind: approvedLabels().indexOf(labelKey(label)) >= 0 ? 'ready' : 'testing', label: label };
    }

    // Dev text: what Collector has shown for this send so far.
    function evidenceText(rec) {
      const part = (name, step) => name + ' ' + (step ? step.label + ' ' + stamp(step.at) : 'not seen');
      return rec
        ? part('OUT', rec.out) + ' \u2192 ' + part('Repair', rec.repair) + ' \u2192 ' + part('SLT', rec.slt)
        : 'nothing yet';
    }

    function releaseProgress(rec) {
      const base = 'Collector so far: ' + evidenceText(rec) + '.';
      return rec && rec.repair && !rec.out && !rec.slt
        ? base + ' Check needed: repair was seen without an OUT before it for this send, so a return cannot be verified.'
        : base;
    }

    // The default view once released: a status, one sentence, one action. Opens
    // the operator page as it is (no address parameters, nothing started or
    // ticked there); the serial copy stays beside it for pasting. Evidence: Dev.
    function releasedBox(sn, rec) {
      const box = el('div', { className: 'jstr-next jstr-released' });
      const after = afterRelease(rec);
      box.appendChild(el('div', { className: 'jstr-strong' }, after.kind === 'testing' ? 'Released and retesting' : 'Released for retest'));
      box.appendChild(el('div', null, after.kind === 'testing'
        ? 'Collector now shows ' + after.label + '.'
        : 'Collector verified return to SLT.'));
      const actions = el('div', { className: 'jstr-actions' });
      const open = el('button', { className: 'jstr-primary', title: 'Opens the TestView 1.0 operator page. Nothing starts until you start it there.' }, 'Open TestView 1.0');
      open.addEventListener('click', () => openExternal(TESTVIEW_OPERATOR_URL));
      const copy = el('button', { title: 'Copies ' + sn + ' to paste into the operator page' }, 'Copy serial');
      copy.addEventListener('click', () => copyText(sn, copy));
      actions.appendChild(open);
      actions.appendChild(copy);
      box.appendChild(actions);
      box.appendChild(el('div', { className: 'eve-dev-only' }, 'Collector evidence: ' + evidenceText(rec)));
      return box;
    }

    // Once per confirmed send, from the one page that completed the proof.
    function announceRelease(key, sn) {
      sendDesktopNotification(
        'RELEASED FOR RETEST \u{2705}',
        `Serial #: ${sn}\n${key} \u{b7} Collector verified return to SLT.`,
        null,
        () => revealRequest(key)
      );
    }

    // Repaints the cards of units whose Collector proof or send record changed,
    // whichever page wrote it, so the bar follows with no click (the way a Jira
    // reply does). Cheap: only a changed record repaints.
    const releaseShown = new Map();
    function repaintReleased() {
      const sent = sentLog();
      Object.keys(sent).forEach(key => {
        const rec = releaseOf(key, sent[key]);
        const sig = JSON.stringify([sent[key] && sent[key].at, rec]);
        if (releaseShown.get(key) !== sig) {
          releaseShown.set(key, sig);
          syncCardsFor(key);
        }
      });
    }

    // From the master tick, even with every repair box collapsed: looks up the
    // most overdue unit awaiting release (one lookup at a time; every 3 min for
    // 6 h after the send, then every 10 min, for 72 h). The pages take turns:
    // one lookup per unit per interval across all open pages.
    function pollRelease() {
      repaintReleased();
      const now = Date.now();
      if (releaseBusy && now - releaseBusyAt < RELEASE_BUSY_MAX_MS) {
        return;
      }
      const sent = sentLog();
      const requests = readRequests();
      let pick = null;
      Object.keys(sent).forEach(key => {
        const record = sent[key];
        if (!record || !record.sn || !(Number(record.at) > 0)) {
          return;
        }
        const age = now - Number(record.at);
        const request = requests[key] || null;
        if (age < 0 || age > RELEASE_WATCH_MAX_MS) {
          return;
        }
        if (workflowOf(key, request, record) !== 'retest' || needsSend(request, record)) {
          return;
        }
        const rec = releaseOf(key, record);
        // Released units keep being read for 6 h (retesting, or back in Repair); not-yet-released ones until the watch ends.
        if (rec && rec.slt && now - Number(rec.slt.at) > RELEASE_FAST_FOR_MS) {
          return;
        }
        const bucket = Math.floor(now / (age < RELEASE_FAST_FOR_MS || (rec && rec.slt) ? RELEASE_FAST_MS : RELEASE_SLOW_MS));
        const last = releasePolled.has(key) ? releasePolled.get(key) : -1;
        if (last !== bucket && (!pick || last < pick.last)) {
          pick = { key: key, record: record, bucket: bucket, last: last };
        }
      });
      if (!pick) {
        return;
      }
      const { key, record, bucket } = pick;
      releasePolled.set(key, bucket);
      if (!releaseOf(key, record)) {
        releaseBegin(key, record, null);
      }
      releaseBusy = true;
      releaseBusyAt = now;
      const done = () => {
        releaseBusy = false;
      };
      coordTake(`rel|${key}|${cycleOf(record)}|${bucket}`, { lease: 45000, once: true }, won => {
        if (!won) {
          done();
          return;
        }
        const startedAt = Date.now();
        lookupPosition(record.sn).then(position => {
          done();
          if (observeRelease(key, record, startedAt, position)) {
            coordTake(`released|${key}|${cycleOf(record)}`, { lease: 60000, once: true }, first => {
              if (first) {
                announceRelease(key, record.sn);
              }
            });
          }
          syncCardsFor(key);
        }, done);
      });
    }

    function jiraGet(path) {
      return new Promise(resolve => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          resolve({ status: 0, data: null, html: false });
          return;
        }
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: jiraBaseUrl() + path,
            headers: { Accept: 'application/json' },
            timeout: JIRA_TIMEOUT_MS,
            onload: response => {
              let data = null;
              try {
                data = JSON.parse(response.responseText);
              } catch (error) {
                data = null;
              }
              resolve({ status: Number(response && response.status) || 0, data: data, html: !data && isHtml(response.responseText) });
            },
            onerror: () => resolve({ status: 0, data: null, html: false }),
            onabort: () => resolve({ status: 0, data: null, html: false }),
            ontimeout: () => resolve({ status: 0, data: null, html: false })
          });
        } catch (error) {
          resolve({ status: 0, data: null, html: false });
        }
      });
    }

    // Comments of one ticket with this browser's Jira login: { state, comments }.
    // shortcut: the newest 50 comments only, plenty for these tickets.
    function fetchComments(key) {
      return jiraGet(`/rest/api/2/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=50`).then(reply => {
        if (reply.status === 401 || reply.status === 403 || (reply.status === 200 && reply.html)) {
          return { state: 'auth', comments: [] };
        }
        if (reply.status !== 200 || !reply.data || !Array.isArray(reply.data.comments)) {
          return { state: 'error', comments: [] };
        }
        const list = reply.data.comments.filter(isRecordObject);
        return { state: 'ok', comments: list, total: Math.max(Number(reply.data.total) || 0, list.length) };
      });
    }

    // Oldest-first pages from startAt until the first human comment, for a
    // ticket with more comments than the newest-50 read holds. { state: 'ok' |
    // 'auth' | 'error', first, scanned, done }: done = every comment was seen.
    function fetchFirstHuman(key, startAt, total) {
      const PAGE = 100;
      const MAX_PAGES = 10;
      const step = (at, pages) =>
        jiraGet(`/rest/api/2/issue/${encodeURIComponent(key)}/comment?orderBy=created&startAt=${at}&maxResults=${PAGE}`).then(reply => {
          if (reply.status === 401 || reply.status === 403 || (reply.status === 200 && reply.html)) {
            return { state: 'auth', first: null, scanned: at, done: false };
          }
          if (reply.status !== 200 || !reply.data || !Array.isArray(reply.data.comments)) {
            return { state: 'error', first: null, scanned: at, done: false };
          }
          const page = reply.data.comments.filter(isRecordObject).sort((a, b) => jiraTimeMs(a.created) - jiraTimeMs(b.created));
          const human = page.find(comment => !isBot(comment));
          const size = reply.data.comments.length;
          const end = at + size;
          const all = Math.max(Number(reply.data.total) || 0, total || 0);
          if (human) {
            return { state: 'ok', first: human, scanned: at, done: true };
          }
          if (!size || end >= all) {
            return { state: 'ok', first: null, scanned: end, done: true };
          }
          if (pages + 1 >= MAX_PAGES) {
            return { state: 'ok', first: null, scanned: end, done: false };
          }
          return step(end, pages + 1);
        });
      return step(startAt, 0);
    }

    // The signed-in Jira user, so your own comments never count as a reply.
    function fetchMe() {
      if (!mePromise) {
        mePromise = jiraGet('/rest/api/2/myself').then(reply => {
          const me = reply.status === 200 && isRecordObject(reply.data)
            ? { name: String(reply.data.name || ''), key: String(reply.data.key || '') }
            : null;
          if (!me) {
            mePromise = null;
          }
          return me;
        });
      }
      return mePromise;
    }

    // The ticket on its Comments tab, scrolled to that comment.
    function commentUrl(key, id) {
      const tab = 'page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel';
      return /^\d+$/.test(String(id || ''))
        ? `${jiraIssueUrl(key)}?focusedCommentId=${id}&${tab}#comment-${id}`
        : `${jiraIssueUrl(key)}?${tab}`;
    }

    // TM2 BOT / swebot style comments are not someone replying.
    function isBot(comment) {
      const author = isRecordObject(comment.author) ? comment.author : {};
      if (/bot\b/i.test(`${author.name || ''} ${author.displayName || ''} ${author.key || ''}`) ||
        String(author.accountType || '').toLowerCase() === 'app') {
        return true;
      }
      // A human quoting a bot's output stays a human: quoted text is not read.
      const own = String(comment.body || '')
        .replace(/\{quote\}[\s\S]*?\{quote\}/gi, ' ')
        .replace(/^\s*(bq\.|>).*$/gim, ' ');
      return /\bgenerated by\b[^\n]*\bbot\b/i.test(own);
    }

    function isMine(comment, me) {
      const author = isRecordObject(comment.author) ? comment.author : {};
      return !!me && ((!!me.name && author.name === me.name) || (!!me.key && author.key === me.key));
    }

    function authorOf(comment) {
      const author = isRecordObject(comment.author) ? comment.author : {};
      return String(author.displayName || author.name || 'Someone').slice(0, 80);
    }

    function commentExcerpt(body) {
      const text = String(body || '')
        .replace(/\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/gi, ' [log] ')
        .replace(/\{quote\}[\s\S]*?\{quote\}/gi, ' ')
        .replace(/\[~([^\]]+)\]/g, '@$1')
        .replace(/\s+/g, ' ')
        .trim();
      return text.length > 140 ? text.slice(0, 139) + '\u2026' : text;
    }

    // Replies: comments by someone else after the operator last looked (hover
    // on the chip, a click on it, or the ticket open in Jira). The first look
    // at a ticket counts everything since the failure.
    // found: { resp, first, scanned } from the first-human check (kept as before when absent).
    function trackThread(ticket, comments, me, found) {
      const prior = readThreads()[ticket.key];
      const others = comments
        .filter(comment => !isMine(comment, me) && !isBot(comment))
        .map(comment => ({ comment, at: jiraTimeMs(comment.created) }))
        .filter(item => item.at)
        .sort((a, b) => b.at - a.at);
      const ackAt = prior && prior.ackAt != null ? Number(prior.ackAt) || 0 : ticket.failedAt || Date.now();
      const unread = others.filter(item => item.at > ackAt);
      const first = found && found.first ? found.first : prior && prior.first ? prior.first : null;
      writeEntry('jstr.threads', ticket.key, {
        resp: first ? 'received' : found ? found.resp : prior && prior.resp ? prior.resp : 'checking',
        first: first,
        scanned: found ? found.scanned || 0 : prior && prior.scanned ? prior.scanned : 0,
        ackAt: ackAt,
        lastAt: others.length ? others[0].at : Number(prior && prior.lastAt) || 0,
        count: unread.length,
        lastId: unread.length ? String(unread[0].comment.id || '') : '',
        author: unread.length ? authorOf(unread[0].comment) : '',
        excerpt: unread.length ? commentExcerpt(unread[0].comment.body) : '',
        at: Date.now()
      });
    }

    // Seen: up to the newest comment (newestAt) or up to the last one counted.
    function ackThread(key, newestAt) {
      const thread = readThreads()[key];
      const upTo = Math.max(Number(newestAt) || 0, thread ? Number(thread.lastAt) || 0 : 0);
      if (thread && !thread.count && (Number(thread.ackAt) || 0) >= upTo) {
        return;
      }
      const ack = readEntry('jstr.acks', key);
      writeEntry('jstr.acks', key, { upTo: Math.max(upTo, ack ? Number(ack.upTo) || 0 : 0), at: Date.now() });
      writeEntry('jstr.threads', key, { ...(thread || {}), ackAt: Math.max(upTo, thread ? Number(thread.ackAt) || 0 : 0), lastAt: upTo, count: 0, lastId: '', author: '', excerpt: '', at: Date.now() });
    }

    // Gold glow and speech-bubble badge on the card's Jira chip while it has
    // unread replies; like the green "new ticket" mark, a hover clears it a
    // few seconds later (a click clears it at once).
    function paintReply(alertCard, key, thread) {
      const chip = alertCard ? alertCard.querySelector('.eve-alert-jira') : null;
      if (!chip) {
        return;
      }
      const count = key && thread ? Number(thread.count) || 0 : 0;
      chip.dataset.replyKey = count ? key : '';
      chip.classList.toggle('eve-jira-replied', !!count);
      let badge = chip.querySelector('.eve-jira-reply');
      const text = count
        ? `${count === 1 ? 'New reply' : count + ' new replies'} \u00b7 ${thread.author}: ${thread.excerpt}`
        : '';
      if (count && !badge) {
        badge = el('span', { className: 'eve-jira-reply', role: 'img' });
        badge.innerHTML = REPLY_ICON_SVG;
        chip.appendChild(badge);
      } else if (!count && badge) {
        badge.remove();
      }
      if (badge && count) {
        badge.setAttribute('aria-label', text);
        badge.title = text;
      }
      // Drop this function's own earlier lines (the reply line and its click hint) so a repaint never stacks them.
      const base = chip.title
        .split('\n')
        .filter(line => line.indexOf(REPLY_MARK) !== 0 && line !== 'Click to read it in Jira')
        .join('\n');
      const tip = count ? `${base}\n${REPLY_MARK} ${text}\nClick to read it in Jira` : base;
      if (chip.title !== tip) {
        chip.title = tip;
      }
      if (!chip.__jstrReplyWired) {
        chip.__jstrReplyWired = true;
        const acknowledge = () => {
          const replyKey = chip.dataset.replyKey;
          if (replyKey) {
            ackThread(replyKey, 0);
            paintReply(chip.closest('.eve-alert'), replyKey, readThreads()[replyKey]);
          }
        };
        chip.addEventListener('mouseenter', () => {
          if (chip.dataset.replyKey && !chip.__jstrReplyTimer) {
            chip.__jstrReplyTimer = setTimeout(() => {
              chip.__jstrReplyTimer = 0;
              acknowledge();
            }, JIRA_NEW_FADE_MS);
          }
        });
        // Runs after the chip's own click handler, before the link opens: the
        // newest reply instead of the ticket top.
        chip.addEventListener('click', () => {
          const replyKey = chip.dataset.replyKey;
          const thread = replyKey ? readThreads()[replyKey] : null;
          if (thread && thread.lastId) {
            chip.href = commentUrl(replyKey, thread.lastId);
          }
          acknowledge();
        });
      }
    }

    function pauseForJiraLogin() {
      jiraAuthPausedUntil = Date.now() + JIRA_AUTH_PAUSE_MS;
      setJiraBadge('auth');
    }

    // Background watch, every few seconds from the master tick: repaints the
    // reply marks and repair rows (another tab may have changed them), then
    // checks one ticket, the most overdue failure card with a ticket. Every
    // 2 min while the failure or its last reply is under 2 h old, then every
    // 10 min, for as long as the card is on screen.
    function pollComments() {
      const stores = { threads: readThreads(), requests: readRequests(), sent: sentLog() };
      const now = Date.now();
      const watching = !requestBusy && now >= jiraAuthPausedUntil;
      let next = null;
      let nextOverdue = -1;
      document.querySelectorAll('#eve-alert-body .jstr-card').forEach(card => {
        const parts = cardParts.get(card);
        const ticket = parts ? syncCard(card, parts.eligible, stores) : null;
        if (!ticket || !watching) {
          return;
        }
        const thread = stores.threads[ticket.key];
        const active = Math.max(ticket.failedAt || 0, thread ? Number(thread.lastAt) || 0 : 0);
        const every = now - active < REQUEST_FAST_FOR_MS ? REQUEST_FAST_MS : REQUEST_SLOW_MS;
        // Checked on any page counts: the pages take turns, not double the requests.
        const shared = readEntry('jstr.checked', ticket.key);
        const checkedAt = Math.max(requestCheckedAt.get(ticket.key) || 0, shared ? Number(shared.at) || 0 : 0);
        const overdue = now - checkedAt - every;
        if (overdue >= 0 && overdue > nextOverdue) {
          next = ticket;
          nextOverdue = overdue;
        }
      });
      if (!next) {
        return;
      }
      const ticket = next;
      requestBusy = true;
      requestCheckedAt.set(ticket.key, now);
      writeEntry('jstr.checked', ticket.key, { at: now });
      Promise.all([fetchComments(ticket.key), fetchMe()]).then(([result, me]) => {
        requestBusy = false;
        if (result.state === 'auth') {
          pauseForJiraLogin();
          markResponse(ticket.key, 'auth');
          return;
        }
        if (result.state !== 'ok') {
          markResponse(ticket.key, 'error');
          return;
        }
        // A newer request comment (or an edit of the saved one) replaces the
        // saved request; only a new comment is announced.
        const request = requestIn(result.comments);
        if (request && storeRequest(ticket.key, request)) {
          // One toast per request comment with every page together.
          coordTake(`req|${ticket.key}|${request.id}`, { lease: 60000, once: true }, won => {
            if (won) {
              announceRequest(ticket, request);
            }
          });
        }
        findFirstHuman(ticket.key, result, readThreads()[ticket.key]).then(found => {
          trackThread(ticket, result.comments, me, found);
          syncCardsFor(ticket.key);
        });
      });
    }

    // The chronologically first human comment: from the stored one, else from the
    // read when it holds every comment, else by paging oldest-first (resuming
    // where an earlier check left off). Never "waiting" on an incomplete read.
    function findFirstHuman(key, result, prior) {
      if (prior && prior.first) {
        return Promise.resolve({ resp: 'received', first: prior.first, scanned: prior.scanned || 0 });
      }
      const ordered = result.comments.slice().sort((a, b) => jiraTimeMs(a.created) - jiraTimeMs(b.created));
      if (result.total <= result.comments.length) {
        const human = ordered.find(comment => !isBot(comment));
        return Promise.resolve(human
          ? { resp: 'received', first: firstSummary(human), scanned: result.total }
          : { resp: 'waiting', first: null, scanned: result.total });
      }
      return fetchFirstHuman(key, prior && prior.scanned ? Number(prior.scanned) || 0 : 0, result.total).then(page => {
        if (page.state !== 'ok') {
          return { resp: page.state, first: null, scanned: page.scanned };
        }
        if (page.first) {
          return { resp: 'received', first: firstSummary(page.first), scanned: page.scanned };
        }
        return { resp: page.done ? 'waiting' : 'error', first: null, scanned: page.scanned };
      });
    }

    function firstSummary(comment) {
      return {
        id: String(comment.id || ''),
        author: authorOf(comment),
        at: jiraTimeMs(comment.created),
        excerpt: commentExcerpt(comment.body)
      };
    }

    // A failed check keeps what was known; only the shown status changes.
    function markResponse(key, resp) {
      const prior = readThreads()[key];
      if (prior && prior.first) {
        return;
      }
      writeEntry('jstr.threads', key, { ...(prior || {}), resp: resp, at: Date.now() });
      syncCardsFor(key);
    }

    const RESP_TEXT = {
      checking: 'Checking response\u2026',
      waiting: 'Waiting for response',
      received: 'Response received',
      auth: 'Sign in to check response',
      error: 'Response status unavailable'
    };

    const RESP_SHORT = { checking: '...', waiting: 'Waiting', received: 'Replied', auth: 'Sign in', error: 'No data' };

    // The response status sits bottom right of the card (where the Jira link
    // used to be); the first human comment gets one preview row under it. A
    // ticket being raised is not a person answering.
    function paintResponse(card, ticket, thread) {
      const alert = card.parentNode;
      const chip = alert ? alert.querySelector('.eve-alert-jira') : null;
      const preview = alert ? alert.querySelector(':scope > .jstr-resp-preview') : null;
      if (preview) {
        preview.remove();
      }
      let tag = chip ? chip.querySelector('.eve-jira-resp') : null;
      if (!ticket || !chip) {
        if (tag) {
          tag.remove();
        }
        return;
      }
      const state = thread && thread.first ? 'received' : (thread && RESP_TEXT[thread.resp] ? thread.resp : 'checking');
      if (!tag) {
        tag = el('span', { className: 'eve-jira-resp', role: 'status' });
        chip.insertBefore(tag, chip.firstChild);
      }
      if (tag.dataset.state !== state) {
        tag.dataset.state = state;
      }
      // Short word on the button (the footer is narrow); the full wording is its tooltip.
      setTextIfChanged(tag, RESP_SHORT[state]);
      if (tag.title !== RESP_TEXT[state]) {
        tag.title = RESP_TEXT[state];
      }
      // The first comment stays in the button's tooltip; a repaint never stacks the line.
      const first = state === 'received' ? thread.first : null;
      const base = chip.title
        .split('\n')
        .filter(line => line.indexOf('Response: ') !== 0)
        .join('\n');
      const tip = first ? `${base}\nResponse: ${first.author} \u00b7 ${stamp(first.at)}${first.excerpt ? ': ' + first.excerpt : ''}` : base;
      if (chip.title !== tip) {
        chip.title = tip;
      }
    }

    function syncCardsFor(key) {
      document.querySelectorAll('#eve-alert-body .jstr-card').forEach(card => {
        const parts = cardParts.get(card);
        const ticket = parts && parts.eligible ? parts.readTicket() : null;
        if (ticket && ticket.key === key) {
          syncCard(card, true);
        }
      });
    }

    // One toast per new request comment. A send ask the unit's send already
    // answers needs nothing; a release ask after the send is the retest follow-up.
    function announceRequest(ticket, request) {
      log(`Repair requested for ${ticket.serial} in ${ticket.key} by ${request.author}: "${request.excerpt}"`);
      const release = request.kind === 'release';
      const pending = needsSend(request, sentLog()[ticket.key]);
      if (!pending && !release) {
        return;
      }
      const after = !pending
        ? '\nAlready in the repair queue: leave it on its rack until Repair releases it.'
        : release
          ? '\nSend it to the repair queue first so Repair can release it.'
          : request.intent === 'retest'
            ? '\nIt stays on its rack; Repair releases it for retest.'
            : '';
      sendDesktopNotification(
        release ? 'REPAIR RELEASE REQUESTED \u{1f527}' : 'SEND TO REPAIR REQUESTED \u{1f527}',
        `Serial #: ${ticket.serial}\n${ticket.key} \u{b7} ${request.author}: "${request.excerpt}"` + after,
        null,
        () => {
          openFromNotification(commentUrl(ticket.key, request.id));
          revealRequest(ticket.key);
        }
      );
    }

    // Toast click: bring the card into view with its repair box open.
    function revealRequest(key) {
      try {
        window.focus();
      } catch (error) {}
      document.querySelectorAll('#eve-alert-body .jstr-card').forEach(card => {
        const parts = cardParts.get(card);
        const ticket = parts && !card.hidden ? parts.readTicket() : null;
        if (ticket && ticket.key === key) {
          setAlertsCollapsed(false);
          parts.open();
        }
      });
    }

    // The "Send to repair" row of an alert card: a toggle and, below it, the
    // repair view. Shown (syncCard) only for a failure with a ticket whose
    // comments ask to send it to repair: gold and pulsing until it is sent,
    // then green. Before that nothing is shown.
    const cardParts = new WeakMap();

    function buildCard(readTicket) {
      ensureStyle();
      const card = el('div', { className: 'jstr-card' });
      card.hidden = true;
      const toggle = el('button', { type: 'button', className: 'jstr-card-toggle', 'aria-expanded': 'false' });
      const label = el('span', { className: 'jstr-card-label' }, 'Send to repair');
      const meta = el('span', { className: 'jstr-card-meta' });
      const caret = el('span', { 'aria-hidden': 'true' }, '\u25b8');
      toggle.appendChild(label);
      toggle.appendChild(meta);
      toggle.appendChild(caret);
      const box = el('div', { className: 'jstr-box' });
      box.hidden = true;
      let view = null;
      const close = () => {
        box.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        caret.textContent = '\u25b8';
      };
      const open = () => {
        if (!box.hidden) {
          box.scrollIntoView({ block: 'nearest' });
          return;
        }
        box.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        caret.textContent = '\u25be';
        view = view || createView(box, readTicket, () => syncCard(card, true));
        view.refresh();
        card.scrollIntoView({ block: 'nearest' });
      };
      toggle.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (box.hidden) {
          open();
        } else {
          close();
        }
      });
      // Esc closes the box and returns to the toggle (an open confirmation takes Esc first).
      card.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !box.hidden) {
          event.preventDefault();
          close();
          toggle.focus();
        }
      });
      card.appendChild(toggle);
      card.appendChild(box);
      cardParts.set(card, {
        readTicket,
        toggle,
        label,
        meta,
        open,
        eligible: false,
        redraw: () => {
          if (view) {
            view.redraw();
          }
        }
      });
      return card;
    }

    // eligible: an SLT failure whose chip shows its ticket (the tracker decides).
    // stores: the saved threads / requests / sends, when already read this tick.
    // The row's state also goes on the alert card (data-repair): 'requested'
    // while a send is owed, 'sent' once sent here or seen in the SFCS queue;
    // the Quick Actions tab and row show it. Returns the ticket, or null.
    function syncCard(card, eligible, stores) {
      const parts = cardParts.get(card);
      if (!parts) {
        return null;
      }
      const saved = stores || { threads: readThreads(), requests: readRequests(), sent: sentLog() };
      parts.eligible = eligible;
      const ticket = eligible ? parts.readTicket() : null;
      const alert = card.closest('.eve-alert');
      paintReply(alert, ticket ? ticket.key : '', ticket ? saved.threads[ticket.key] : null);
      paintResponse(card, ticket, ticket ? saved.threads[ticket.key] : null);
      const sent = ticket ? saved.sent[ticket.key] || null : null;
      const request = ticket ? saved.requests[ticket.key] || null : null;
      const pending = needsSend(request, sent);
      const hide = !(sent || request);
      if (card.hidden !== hide) {
        card.hidden = hide;
      }
      const mark = hide ? '' : pending ? 'requested' : 'sent';
      if (card.dataset.state !== mark) {
        card.dataset.state = mark;
      }
      if (alert && (alert.dataset.repair || '') !== mark) {
        alert.dataset.repair = mark;
        syncQuickActionsTab(alert);
      }
      if (hide) {
        return ticket;
      }
      // Three jobs: SEND the unit to repair (gold); once sent, WAIT for Repair to
      // release it for retest (blue, only while Collector shows it in repair);
      // READY FOR RETEST (green) once Collector shows it back at an approved
      // state. A release asked before the send says so: send first.
      const release = !!request && request.kind === 'release';
      const proof = !pending && workflowOf(ticket.key, request, sent) === 'retest' ? releaseOf(ticket.key, sent) : null;
      const released = isReleased(proof);
      const after = released ? afterRelease(proof) : null;
      const testing = !!after && after.kind === 'testing';
      const ready = !!after && after.kind === 'ready';
      const waiting = (!released && !!proof && !!proof.repair) || (!!after && after.kind === 'repair');
      setTextIfChanged(
        parts.label,
        pending
          ? release
            ? 'SEND TO REPAIR FOR RELEASE'
            : 'SEND TO REPAIR'
          : testing
            ? '\u25b6 RETESTING'
            : ready
              ? '\u2713 READY FOR RETEST'
              : waiting
              ? '\u23f3 WAITING FOR RELEASE'
              : '\u2713 SENT TO REPAIR'
      );
      setTextIfChanged(parts.meta, pending
        ? stamp(request.createdAt || request.at)
        : testing
          ? 'now ' + after.label + ' ' + stamp((proof.now || proof.slt).at)
          : ready
            ? 'back in SLT ' + stamp((proof.now || proof.slt).at)
            : waiting
              ? 'in repair ' + stamp(after ? (proof.now || proof.slt).at : proof.repair.at)
            : (sent.observed ? 'seen ' : '') + stamp(sent.at));
      const wait = testing ? 'testing' : ready ? 'ready' : waiting ? 'release' : '';
      if ((card.dataset.wait || '') !== wait) {
        card.dataset.wait = wait;
      }
      parts.toggle.classList.toggle('ready', ready || testing);
      parts.toggle.classList.toggle('waiting', waiting);
      const tip = request ? `${request.author}: "${request.excerpt}"` : '';
      if (parts.toggle.title !== tip) {
        parts.toggle.title = tip;
      }
      parts.toggle.classList.toggle('sent', !pending);
      parts.toggle.classList.toggle('requested', pending);
      const next = pending ? '' : nextStepOf(workflowOf(ticket.key, request, sent), sent, ticket.key);
      if ((card.dataset.next || '') !== next) {
        card.dataset.next = next;
        // An open box repaints with the new state (Released for retest).
        parts.redraw();
      }
      return ticket;
    }

    // ---- Jira ticket page ----

    let panel = null;
    let jiraView = null;

    function openPanel() {
      if (!panel) {
        panel = el('div', { id: 'jstr-panel' });
        const head = el('div', { id: 'jstr-head' });
        head.appendChild(el('b', null, 'Send to repair (SFCS)'));
        head.appendChild(el('span', { className: 'jstr-muted' }, 'v' + SCRIPT_VERSION));
        const close = el('button', { title: 'Close', 'aria-label': 'Close Send to repair' }, 'x');
        close.addEventListener('click', () => {
          panel.style.display = 'none';
        });
        head.appendChild(close);
        const body = el('div', { id: 'jstr-body' });
        panel.appendChild(head);
        panel.appendChild(body);
        panel.addEventListener('keydown', event => {
          if (event.key === 'Escape') {
            panel.style.display = 'none';
          }
        });
        document.body.appendChild(panel);
        jiraView = createView(body, ticketInfo, syncJiraButton);
        syncJiraButton();
      }
      panel.style.display = '';
      jiraView.refresh();
    }

    // The ticket page button follows the card rule: hidden until a comment asks
    // to send the unit to repair (gold, pulsing), green once sent (or seen in
    // the SFCS queue) unless a newer request asks again.
    function syncJiraButton() {
      const button = document.getElementById('jstr-btn');
      if (!button) {
        return;
      }
      const key = ticketInfo().key;
      const request = key ? readRequests()[key] : null;
      const sent = key ? sentLog()[key] : null;
      const pending = needsSend(request, sent);
      const done = !!sent && !pending;
      button.hidden = !(request || sent);
      button.classList.toggle('requested', pending);
      button.classList.toggle('sent', done);
      setTextIfChanged(button, done ? '\u2713 Sent to repair' : 'Send to repair');
      const workflow = done ? workflowOf(key, request, sent) : '';
      button.title = done
        ? (sent.observed ? 'Seen in the SFCS repair queue ' : 'Sent to repair ') + stamp(sent.at) +
          (workflow ? ' \u00b7 ' + nextStepOf(workflow, sent, key) : '')
        : request ? `${request.author}: "${request.excerpt}"` : '';
      const head = panel ? panel.querySelector('#jstr-head b') : null;
      if (head) {
        setTextIfChanged(head, done ? 'Sent to repair (SFCS)' : 'Send to repair (SFCS)');
      }
    }

    function checkJiraPage() {
      const key = ticketInfo().key;
      if (!key || requestBusy || Date.now() < jiraAuthPausedUntil) {
        return;
      }
      requestBusy = true;
      fetchComments(key).then(result => {
        requestBusy = false;
        if (result.state === 'auth') {
          jiraAuthPausedUntil = Date.now() + JIRA_AUTH_PAUSE_MS;
        } else if (result.state === 'ok') {
          const request = requestIn(result.comments);
          if (request) {
            storeRequest(key, request);
          }
          if (!document.hidden) {
            ackThread(key, Math.max(0, ...result.comments.map(comment => jiraTimeMs(comment.created))));
          }
        }
        syncJiraButton();
      });
    }

    function init() {
      if (document.getElementById('jstr-btn')) {
        return;
      }
      ensureStyle();
      const button = el('button', { id: 'jstr-btn' }, 'Send to repair');
      button.hidden = true;
      button.addEventListener('click', openPanel);
      document.body.appendChild(button);
      syncJiraButton();
      checkJiraPage();
      setInterval(checkJiraPage, REQUEST_FAST_MS);
      window.addEventListener('focus', () => {
        jiraAuthPausedUntil = 0;
        checkJiraPage();
      });
    }

    // True when this page belongs to the repair tool (Jira ticket or SFCS), so
    // bootstrap leaves it alone.
    function handlesPage() {
      const host = window.location.hostname;
      if (host !== SFCS_HOST && host !== JIRA_HOST) {
        return false;
      }
      getAuth(); // drops an expired copy
      if (host === SFCS_HOST) {
        hookSfcsPage();
      } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
      return true;
    }

    return {
      handlesPage, buildCard, syncCard, pollComments, pollRelease, findRepairRequest, requestIn, parseTitle, pickSymptom, buildPayload,
      // shared with the bulk start panel
      el, copyText, ensureStyle, getVal, setVal, lookupPosition,
      // records shared by every page
      readMap, readEntry, writeEntry, saveRecord
    };
  })();

  // ===== BULK START (TestView 1 operator page) =====
  // Ported from a teammate's "TestView 1 Bulk Start" v0.4.3 and fitted to this
  // script: the repair tool's panel look, its collector lookup and its SFCS
  // sign-in pick-up. Paste serials, tick Collector and PuTTY per server, then it
  // sends TestView's own two START requests (validate_server, then start_test
  // with force:true, operation PRETEST) one server at a time and confirms each
  // went RUNNING. Only rows with both boxes ticked start, after a confirm box
  // that lists them; Stop at any time; one tab at a time; a reload mid-run marks
  // the in-flight server "check TestView" and never retries it.
  const bulkStart = (() => {
    const STATE_KEY = 'eveBulkStartState';
    const LOCK_KEY = 'eveBulkStartLock';
    const T = { limitMs: 60000, pollMs: 4000, reqMs: 30000, lockMs: 20000 };
    const TAB = 't' + Math.random().toString(36).slice(2, 10);
    const SN_RE = /^[A-Z0-9]{8,16}$/;
    const OPERATOR_RE = /^\/slt\/operator/;
    const COLLECTOR_PAGE = 'https://sfc-fm-p1.hyvesolutions.org/mfg-local-sfcs/collector?path=collector';
    const { el, copyText, getVal, setVal } = repairTool;

    let state = null;
    let run = null;
    let pendingConfirms = 0;
    let panel = null;
    let launcher = null;
    const ui = {};

    const save = () => setVal(STATE_KEY, state);
    const pad = n => (n < 10 ? '0' : '') + n;

    function clock(time) {
      const d = new Date(time);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function stamp(time) {
      const d = new Date(time);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // ---- saved state ----

    // A reload mid-run: whatever was in flight is marked for you to check, never retried.
    const INTERRUPTED = {
      checking: 'page reloaded during the checks; nothing was started for this one',
      starting: 'page reloaded while the start request was out; check TestView before retrying',
      confirming: 'start was sent; page reloaded before RUNNING was confirmed; check TestView'
    };

    function loadState() {
      const saved = getVal(STATE_KEY, null) || {};
      saved.text = saved.text || '';
      saved.putty = saved.putty || '';
      saved.rows = Array.isArray(saved.rows) ? saved.rows : [];
      saved.log = Array.isArray(saved.log) ? saved.log : [];
      // Every fresh load starts at the compact launcher, whatever an old save
      // says. This runs once, in init(); the visibility checks never reset it.
      saved.open = false;
      saved.cfg = saved.cfg || {};
      const cfg = saved.cfg;
      if (!Array.isArray(cfg.green)) cfg.green = ['TEST-SV-HP OUT', 'SLT', 'SLT Queue'];
      if (!Array.isArray(cfg.orange)) cfg.orange = ['SLT IN', 'SLT OUT'];
      if (typeof cfg.recheck !== 'boolean') cfg.recheck = true;
      // Off until you turn it on: the PuTTY box is then ticked from the output.
      if (typeof cfg.autoPutty !== 'boolean') cfg.autoPutty = false;
      // Seconds between one start request and the next, and how old a collector
      // check may be before the start-time check repeats it.
      if (!(Number(cfg.gapSec) >= 0)) cfg.gapSec = 3;
      if (!(Number(cfg.recheckMaxAgeMin) >= 0)) cfg.recheckMaxAgeMin = 0;
      saved.rows.forEach(r => {
        delete r.pushThrough; // a push-through applies to that one batch only
        r.ovNote = null;
        if (r.coll && r.coll.pending) r.coll = null;
        if (!r.res) return;
        if (r.res.kind === 'queued') r.res = null;
        else if (INTERRUPTED[r.res.kind]) r.res = { kind: 'interrupted', msg: INTERRUPTED[r.res.kind], t: Date.now() };
      });
      return saved;
    }

    function addLog(entry) {
      entry.t = Date.now();
      state.log.push(entry);
      if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    }

    // Keeps a copied log free of any sign-in value or long opaque id.
    function redact(text) {
      return String(text)
        .replace(/("?[Aa]uthorization"?\s*[:=]\s*"?)([^"\n,}]+)/g, '$1<redacted>')
        .replace(/\b([Bb]earer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <redacted>')
        .replace(/\beyJ[A-Za-z0-9._-]{16,}/g, '<redacted-jwt>');
    }

    // ---- the pasted list ----

    // One serial per line. Takes "e <serial>" or "ticket <serial>" lines too, and
    // the first serial-looking token on a line pasted from a spreadsheet.
    function parseList(text) {
      const out = { serials: [], invalid: [], dupes: 0 };
      const seen = {};
      String(text || '').split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const tokens = trimmed.toUpperCase().split(/[\s,;]+/).filter(Boolean);
        if (tokens.length > 1 && (tokens[0] === 'E' || tokens[0] === 'TICKET')) tokens.shift();
        const sn = tokens.find(token => SN_RE.test(token) && /\d/.test(token));
        if (!sn) {
          out.invalid.push(trimmed.slice(0, 40));
        } else if (seen[sn]) {
          out.dupes += 1;
        } else {
          seen[sn] = true;
          out.serials.push(sn);
        }
      });
      return out;
    }

    function applyList(text) {
      const parsed = parseList(text);
      const old = {};
      state.rows.forEach(r => {
        old[r.sn] = r;
      });
      state.rows = parsed.serials.map(sn => old[sn] || { sn: sn, col: false, putty: false, res: null });
      state.text = text;
      state.parse = { invalid: parsed.invalid, dupes: parsed.dupes };
      save();
    }

    const eBlock = () => state.rows.map(r => 'e ' + r.sn).join('\n');
    const serialBlock = () => state.rows.map(r => r.sn).join('\n');

    // Reads pasted PuTTY output: the "e <serial>" commands (one per line, or
    // "e A; e B; e C" on one line) and the HOSTNIC / ILOM / ROT status tables.
    // A table belongs to a serial only when it can be shown: the serial is named
    // in it, or one command meets one table, or the batch has as many complete
    // tables as commands (matched in command order). Anything missing, cut off,
    // repeated or out of step is left unmatched and listed in notes.
    function parsePuttyDetails(text) {
      const CMD_RE = /(?:^|[\s$#>;])e\s+([A-Za-z0-9]{8,16})(?=\s*(?:;|$))/g;
      const STATUS_RE = /^\s*(HOSTNIC|ILOM|ROT)\b.*\b(up|down)\s*$/i;
      const TOKEN_RE = /[A-Za-z0-9]{8,16}/g;
      const groups = [];
      let group = null;
      let table = null;
      let pending = new Set();
      String(text || '').split(/\r?\n/).forEach(line => {
        const serials = [];
        let m;
        CMD_RE.lastIndex = 0;
        while ((m = CMD_RE.exec(line))) {
          if (/\d/.test(m[1])) serials.push(m[1].toUpperCase());
        }
        if (serials.length) {
          if (!group || group.hasStatus) {
            group = { serials: [], tables: [], hasStatus: false };
            groups.push(group);
            table = null;
            pending = new Set();
          }
          serials.forEach(sn => group.serials.push(sn));
          return;
        }
        if (!group) return;
        const st = STATUS_RE.exec(line);
        if (st) {
          const key = st[1].toLowerCase();
          group.hasStatus = true;
          if (!table || table.vals[key] || (table.vals.hostnic && table.vals.ilom && table.vals.rot)) {
            table = { vals: {}, mentions: pending };
            pending = new Set();
            group.tables.push(table);
          }
          table.vals[key] = st[2].toLowerCase();
          return;
        }
        const names = (line.toUpperCase().match(TOKEN_RE) || []).filter(token => group.serials.indexOf(token) !== -1);
        const into = table && !(table.vals.hostnic && table.vals.ilom && table.vals.rot) ? table.mentions : pending;
        names.forEach(token => into.add(token));
      });
      const map = {};
      const notes = [];
      const put = (sn, vals, via) => {
        const entry = { hostnic: vals.hostnic, ilom: vals.ilom, rot: vals.rot, via: via };
        entry.ok = entry.ilom === 'up' && entry.rot === 'up';
        const old = map[sn];
        if (old && (old.ilom !== entry.ilom || old.rot !== entry.rot || old.hostnic !== entry.hostnic)) {
          map[sn] = null;
          notes.push(sn + ': two different outputs in the paste, not used');
        } else if (old !== null) {
          map[sn] = entry;
        }
      };
      groups.forEach(g => {
        const sns = g.serials;
        if (sns.some((sn, i) => sns.indexOf(sn) !== i)) {
          notes.push('A serial is repeated in one command group: that group is not used');
          return;
        }
        const tables = g.tables;
        if (!tables.length) {
          notes.push(sns.length + ' command' + (sns.length === 1 ? '' : 's') + ' without a status table: not matched');
          return;
        }
        const complete = t => !!(t.vals.ilom && t.vals.rot);
        const used = {};
        let named = 0;
        tables.forEach(t => {
          const hit = sns.filter(sn => t.mentions.has(sn));
          if (hit.length) named += 1;
          if (hit.length === 1 && complete(t) && !used[hit[0]]) {
            used[hit[0]] = t;
          } else if (hit.length) {
            notes.push('A status table names ' + (hit.length === 1 ? hit[0] + ' twice or cut off' : 'several serials') + ': not used');
          }
        });
        if (named) {
          Object.keys(used).forEach(sn => put(sn, used[sn].vals, 'named'));
          return;
        }
        if (sns.length === 1 && tables.length === 1) {
          if (complete(tables[0])) put(sns[0], tables[0].vals, 'command');
          else notes.push(sns[0] + ': ILOM or ROT line missing, not used');
          return;
        }
        if (sns.length === tables.length && tables.every(complete)) {
          sns.forEach((sn, i) => put(sn, tables[i].vals, 'order'));
          return;
        }
        notes.push(sns.length + ' commands but ' + tables.length + ' status tables' +
          (tables.every(complete) ? '' : ' (some incomplete)') + ': not matched by order');
      });
      Object.keys(map).forEach(sn => {
        if (map[sn] === null) delete map[sn];
      });
      return { map: map, notes: notes };
    }

    const parsePuttyOutput = text => parsePuttyDetails(text).map;

    // ---- TestView requests (same site, so the browser attaches your sign-in) ----

    const startApi = (step, sn) =>
      window.location.origin + '/api/v1/server_level_tests/start/' + step + '/' + encodeURIComponent(sn) + '?operation=PRETEST';

    // The newest run only, no field list: the plainest form of the request TestView answers.
    const statusUrl = sn => window.location.origin + TESTVIEW_API_PATH + '?' +
      new URLSearchParams({ only_latest_slt: 'true', page_num: '1', page_size: '1', server_sn: sn });

    function req(method, url, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller && controller.abort(), T.reqMs);
      const t0 = Date.now();
      const options = {
        method: method,
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
        signal: controller ? controller.signal : undefined
      };
      if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      // fetch is called right here, so the moment a start request leaves is the moment it is timed
      return new Promise(resolve => resolve(fetch(url, options))).then(res => res.text().then(text => {
        clearTimeout(timer);
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (error) {}
        const auth = res.status === 401 || res.status === 403 || (!json && /<html|<!doctype/i.test(text));
        return { status: res.status, body: json, text: text, auth: auth, ms: Date.now() - t0 };
      })).catch(error => {
        clearTimeout(timer);
        const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
        return {
          status: 0,
          error: aborted ? 'no answer in ' + Math.round(T.reqMs / 1000) + ' s' : String((error && error.message) || error),
          ms: Date.now() - t0
        };
      });
    }

    function logReq(sn, step, r) {
      addLog({
        sn: sn,
        step: step,
        http: r.status,
        ms: r.ms,
        code: r.body && r.body.code,
        msg: r.body && r.body.msg ? String(r.body.msg).slice(0, 200) : '',
        error: r.error || '',
        auth: !!r.auth,
        reply: r.text ? String(r.text).slice(0, step === 'status' ? 160 : 400) : ''
      });
    }

    // TestView prints site wall-clock time without an offset.
    function siteTimeToEpoch(text) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ''));
      if (!m) return null;
      const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      const p = {};
      SITE_PARTS_FORMAT.formatToParts(new Date(guess)).forEach(part => {
        p[part.type] = part.value;
      });
      return guess - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess);
    }

    function shortRack(rack) {
      const m = /^TA\.([A-Z]\d+)-EVE(\d+)$/i.exec(String(rack || ''));
      return m ? m[1].toUpperCase() + '-' + m[2] : String(rack || '');
    }

    // ---- collector position (read only, through the repair tool's lookup) ----

    // "TEST-SV-HP-OUT", "TEST-SV-HP OUT" and "test sv hp out" all compare equal.
    const normLabel = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const listOf = value => (Array.isArray(value) ? value : String(value || '').split(','))
      .map(x => String(x).trim())
      .filter(Boolean);
    const signInError = error => /sign-in|authori[sz]ation|token|log ?in/i.test(String(error || ''));

    function tierOf(label) {
      const n = normLabel(label);
      if (listOf(state.cfg.green).some(x => normLabel(x) === n)) return 'green';
      if (listOf(state.cfg.orange).some(x => normLabel(x) === n)) return 'orange';
      return 'red';
    }

    function collectorLookup(sn) {
      const t0 = Date.now();
      return repairTool.lookupPosition(sn).then(found => {
        const out = found.error ? { error: found.error } : { label: found.label, tier: tierOf(found.label) };
        addLog({
          sn: sn,
          step: 'collector',
          ms: Date.now() - t0,
          msg: out.error || out.label + ' (' + out.tier + ')',
          reply: found.raw ? JSON.stringify(found.raw).slice(0, 400) : ''
        });
        return out;
      });
    }

    // Up to 3 lookups at a time. Green ticks Collector on its own; a box ticked
    // that way is cleared again if a later check is not green. Boxes you ticked stay yours.
    const collQueue = [];
    let collActive = 0;

    function checkCollector(rows) {
      rows.forEach(r => {
        if (r.res || collQueue.includes(r.sn)) return;
        r.coll = { pending: true };
        collQueue.push(r.sn);
      });
      render();
      pumpCollector();
    }

    function pumpCollector() {
      while (collActive < 3 && collQueue.length) {
        const sn = collQueue.shift();
        collActive += 1;
        collectorLookup(sn).then(c => {
          collActive -= 1;
          const r = rowOf(sn);
          if (r && !r.res) {
            r.coll = c.error ? { error: c.error, t: Date.now() } : { label: c.label, tier: c.tier, t: Date.now() };
            if (!c.error && c.tier === 'green') {
              if (!r.col) {
                r.col = true;
                r.colAuto = true;
              }
            } else if (r.colAuto) {
              r.col = false;
              r.colAuto = false;
            }
          }
          save();
          render();
          pumpCollector();
        });
      }
    }

    // ---- the run ----

    const rowOf = sn => state.rows.find(r => r.sn === sn) || null;
    const isReady = r => r.col && r.putty && !r.res;
    const collNow = r => (!r.coll ? 'not checked yet' : r.coll.pending ? 'still checking' : r.coll.error || r.coll.label);

    function setRes(r, kind, msg, extra) {
      r.res = Object.assign({ kind: kind, msg: msg || '', t: Date.now() }, extra || {});
      if (r.ovNote && kind !== 'checking' && kind !== 'blocked') r.res.override = r.ovNote;
      save();
      render();
    }

    let lockTimer = null;

    function lockHeldElsewhere() {
      const lock = getVal(LOCK_KEY, null);
      return !!(lock && lock.tab !== TAB && Date.now() - lock.t < T.lockMs);
    }

    function takeLock() {
      const beat = () => setVal(LOCK_KEY, { tab: TAB, t: Date.now() });
      beat();
      lockTimer = setInterval(beat, 5000);
    }

    function dropLock() {
      clearInterval(lockTimer);
      lockTimer = null;
      const lock = getVal(LOCK_KEY, null);
      if (lock && lock.tab === TAB) setVal(LOCK_KEY, null);
    }

    function startRun(pushTargets) {
      if (run) return;
      const targets = pushTargets || state.rows.filter(isReady);
      if (!targets.length) return;
      if (lockHeldElsewhere()) {
        window.alert('A bulk start is already running in another TestView tab. Let it finish or stop it there first.');
        return;
      }
      if (!pushTargets) {
        const skipped = state.rows.filter(r => !r.res && !(r.col && r.putty)).length;
        const forced = state.cfg.recheck
          ? targets.filter(r => r.colManual && !(r.coll && !r.coll.pending && !r.coll.error && r.coll.tier !== 'red'))
          : [];
        const message = 'Start PRETEST on ' + targets.length + ' server' + (targets.length === 1 ? '' : 's') + '?\n\n' +
          targets.map(r => r.sn).join('\n') +
          (forced.length
            ? '\n\nYou ticked Collector for these, so they start even if the collector shows red at start:\n' +
              forced.map(r => r.sn + ' (' + collNow(r) + ')').join('\n')
            : '') +
          (skipped ? '\n\n' + skipped + ' other' + (skipped === 1 ? ' is' : 's are') + ' not confirmed and will not be started.' : '');
        if (!window.confirm(message)) return;
      }
      beginRun(targets);
    }

    function beginRun(targets) {
      takeLock();
      run = { queue: targets.map(r => r.sn), active: 0, prepBusy: false, nextStartAt: 0, stopping: false, startsDone: false, stopReason: '' };
      targets.forEach(r => {
        r.res = { kind: 'queued', msg: 'waiting its turn', t: Date.now() };
      });
      state.lastRun = Date.now();
      save();
      render();
      pump();
    }

    function stopRun(reason) {
      if (!run) return;
      run.stopping = true;
      run.stopReason = reason || 'stopped by you';
      pump();
      render();
    }

    // A pipeline, not a pool: one server's checks at a time, in pasted order, but
    // the next server's checks begin as soon as the previous start request has
    // gone out (or the previous server ended without starting).
    function pump() {
      if (!run) return;
      if (run.stopping && run.queue.length) {
        run.queue.forEach(sn => {
          const r = rowOf(sn);
          if (r && r.res && r.res.kind === 'queued') r.res = { kind: 'stopped', msg: 'not started: ' + run.stopReason, t: Date.now() };
        });
        run.queue = [];
        save();
      }
      if (!run.prepBusy && !run.stopping && run.queue.length) {
        const sn = run.queue.shift();
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (run) {
            run.prepBusy = false;
            pump();
          }
        };
        run.prepBusy = true;
        run.active += 1;
        Promise.resolve(startOne(sn, release)).then(outcome => {
          if (!run) return;
          run.active -= 1;
          if (outcome === 'auth') stopRun('TestView sign-in needed');
          release();
          pump();
        });
      }
      if (!run.queue.length && !run.active && !run.prepBusy) {
        run.startsDone = true;
        finishIfIdle();
      }
    }

    // Each start request waits for its slot: the gap setting after the previous one.
    function waitForStartSlot() {
      const wait = Math.max(0, (run ? run.nextStartAt : 0) - Date.now());
      return new Promise(resolve => setTimeout(resolve, wait));
    }

    // Right before each start the position is looked up again (unless a check
    // younger than the reuse setting exists). A red one is not started, unless
    // you ticked its Collector box yourself or push it through after the batch.
    function startOne(sn, release) {
      const r = rowOf(sn);
      if (!state.cfg.recheck) return startChecked(r, sn, Date.now(), release);
      r.ovNote = null;
      const forced = r.pushThrough ? 'pushed through by you' : r.colManual ? 'you ticked Collector' : '';
      const maxAge = (Number(state.cfg.recheckMaxAgeMin) || 0) * 60000;
      const fresh = r.coll && !r.coll.pending && !r.coll.error && r.coll.label && r.coll.t && Date.now() - r.coll.t < maxAge;
      const after = c => {
        if (c.error) {
          if (!forced) {
            setRes(r, 'blocked', 'collector check failed (' + c.error + '); not started');
            return 'next';
          }
          r.ovNote = forced + ', collector did not answer (' + c.error + ')';
        } else {
          if (!c.reused) r.coll = { label: c.label, tier: c.tier, t: Date.now() };
          if (c.tier === 'red') {
            if (!forced) {
              setRes(r, 'blocked', 'collector shows ' + c.label + '; not started');
              return 'next';
            }
            r.ovNote = forced + ', collector showed ' + c.label;
          }
        }
        return startChecked(r, sn, Date.now(), release);
      };
      if (fresh) return after({ label: r.coll.label, tier: tierOf(r.coll.label), reused: true });
      setRes(r, 'checking', 'collector check\u2026');
      return collectorLookup(sn).then(after);
    }

    function startChecked(r, sn, t0, release) {
      setRes(r, 'checking', 'UUT check\u2026');
      return req('POST', startApi('validate_server', sn), null).then(v => {
        logReq(sn, 'validate', v);
        if (v.auth) {
          setRes(r, 'signed-out', 'TestView sign-in needed; nothing was started for this one');
          return 'auth';
        }
        if (v.error) {
          setRes(r, 'failed', 'UUT check: ' + v.error);
          return 'next';
        }
        const b = v.body;
        if (!b || b.code !== 200) {
          setRes(r, 'failed', (b && b.msg) || 'UUT check answered HTTP ' + v.status);
          return 'next';
        }
        const d = b.data || {};
        if (d.validate_result !== true) {
          setRes(r, 'failed', b.msg || 'UUT check did not pass');
          return 'next';
        }
        if (String(d.test_status || '').toUpperCase() === 'RUNNING') {
          setRes(r, 'skipped', 'TestView says it is already RUNNING; not started');
          return 'next';
        }
        if (d.ask_force === true) {
          setRes(r, 'needs-you', 'TestView would ask whether to force this start (' + (b.msg || 'no message') + '); not started, start it by hand if you want');
          return 'next';
        }
        const check = { check: b.msg || '' };
        setRes(r, 'checking', 'UUT check passed; waiting for its start slot\u2026', check);
        return waitForStartSlot().then(() => {
          if (run && run.stopping) {
            setRes(r, 'stopped', 'not started: ' + run.stopReason, check);
            return 'next';
          }
          setRes(r, 'starting', 'UUT check passed; starting\u2026', check);
          const sentAt = Date.now();
          // the gap counts from the moment this request leaves
          if (run) run.nextStartAt = sentAt + (Number(state.cfg.gapSec) || 0) * 1000;
          const sending = req('POST', startApi('start_test', sn), { force: true });
          release(); // the next server's checks may begin now
          return sending.then(s => {
            logReq(sn, 'start', s);
            if (s.auth) {
              setRes(r, 'signed-out', 'TestView sign-in needed at the start step; check TestView for this one', check);
              return 'auth';
            }
            if (s.error) {
              setRes(r, 'confirming', 'start request got no answer (' + s.error + '); checking whether it started', check);
              confirmRun(r, sn, null, sentAt, t0, true, check.check);
              return 'next';
            }
            const sb = s.body;
            if (!sb || sb.code !== 200) {
              setRes(r, 'failed', 'start: ' + ((sb && sb.msg) || 'HTTP ' + s.status), check);
              return 'next';
            }
            const id = sb.data && sb.data.server_status_id;
            setRes(r, 'confirming', 'start accepted; waiting for RUNNING', Object.assign({ runId: id || null }, check));
            confirmRun(r, sn, id, sentAt, t0, false, check.check);
            return 'next';
          });
        });
      });
    }

    // The run the start created: the same id as the start reply, or the newest
    // PRETEST run for this serial that began after the start was sent.
    function pickItem(body, sn, id, sentAt) {
      const items = body && body.data && Array.isArray(body.data.items) ? body.data.items : [];
      const mine = items.filter(it => String(it.server_sn || '').toUpperCase() === sn);
      const byId = id ? mine.find(it => it.id === id) : null;
      if (byId) return byId;
      mine.sort((a, b) => String(b.started || '').localeCompare(String(a.started || '')));
      const it = mine[0];
      if (!it || String(it.operation || '').toUpperCase() !== 'PRETEST') return null;
      const started = siteTimeToEpoch(it.started);
      return started && started >= sentAt - 120000 ? it : null;
    }

    function confirmRun(r, sn, id, sentAt, t0, uncertain, checkMsg) {
      pendingConfirms += 1;
      const deadline = t0 + T.limitMs;
      const finish = (kind, msg) => {
        pendingConfirms -= 1;
        setRes(r, kind, msg, { check: checkMsg, runId: id || null });
        finishIfIdle();
      };
      const poll = () => req('GET', statusUrl(sn), null).then(v => {
        logReq(sn, 'status', v);
        const item = v.body ? pickItem(v.body, sn, id, sentAt) : null;
        const st = item ? String(item.status || '').toUpperCase() : '';
        if (st === 'RUNNING') {
          const where = item.test_rack
            ? ' in ' + shortRack(item.test_rack) + (item.position !== undefined && item.position !== null ? ' U' + item.position : '')
            : '';
          finish('started', 'RUNNING' + (item.started ? ' since ' + String(item.started).slice(11, 19) : '') + where);
        } else if (/FAIL|SUCC|PASS|ABORT|STOP|CANCEL|ERROR|EXCEED/.test(st)) {
          finish('ended', 'started, but TestView already shows ' + st);
        } else if (Date.now() >= deadline) {
          const secs = Math.round(T.limitMs / 1000);
          finish('timeout', uncertain
            ? 'no answer to the start and no RUNNING within ' + secs + ' s; check TestView'
            : 'start accepted, but not RUNNING within ' + secs + ' s; check TestView');
        } else {
          setTimeout(poll, T.pollMs);
        }
      });
      poll();
    }

    function finishIfIdle() {
      if (!run || !run.startsDone || pendingConfirms > 0) return;
      run = null;
      state.rows.forEach(r => {
        delete r.pushThrough;
        r.ovNote = null;
      });
      dropLock();
      save();
      render();
    }

    function pushThrough(bounced) {
      const ask = 'Push ' + bounced.length + ' bounced server' + (bounced.length === 1 ? '' : 's') +
        ' through?\nThey start even though the collector check stopped them:\n\n' +
        bounced.map(r => r.sn + '  ' + r.res.msg.replace(/; not started$/, '')).join('\n');
      if (!window.confirm(ask)) return;
      bounced.forEach(r => {
        r.pushThrough = true;
        r.res = null;
        r.col = true;
      });
      addLog({ sn: bounced.map(r => r.sn).join(','), step: 'push-through', msg: 'pushed through by you' });
      save();
      startRun(bounced);
    }

    // ---- report ----

    const LABEL = {
      queued: 'waiting', checking: 'checking', starting: 'starting', confirming: 'confirming',
      started: 'STARTED', ended: 'STARTED, ENDED', failed: 'FAILED', skipped: 'NOT STARTED', 'needs-you': 'NOT STARTED',
      timeout: 'TIMED OUT', 'signed-out': 'NOT STARTED', stopped: 'NOT STARTED', interrupted: 'CHECK TESTVIEW', blocked: 'NOT STARTED'
    };
    const KIND_CLASS = {
      started: 'jstr-ok', failed: 'jstr-bad', 'signed-out': 'jstr-bad',
      ended: 'jstr-warn', skipped: 'jstr-warn', 'needs-you': 'jstr-warn', timeout: 'jstr-warn', interrupted: 'jstr-warn', blocked: 'jstr-warn',
      checking: 'eve-bulk-busy', starting: 'eve-bulk-busy', confirming: 'eve-bulk-busy'
    };
    const retryable = r => !!r.res && ['failed', 'timeout', 'signed-out', 'stopped', 'blocked'].includes(r.res.kind);
    const collText = r => (r.coll && !r.coll.pending ? 'collector: ' + (r.coll.error || r.coll.label) : '');

    function rowLine(r) {
      const coll = collText(r);
      if (!r.res) {
        return r.sn + '  NOT STARTED: ' + (r.col && r.putty ? 'not run yet' : 'Collector and PuTTY not both checked') + (coll ? ' | ' + coll : '');
      }
      const line = r.sn + '  ' + (LABEL[r.res.kind] || r.res.kind) + ': ' + r.res.msg;
      if (r.res.override) return line + ' | started anyway: ' + r.res.override;
      return coll && r.res.kind !== 'blocked' ? line + ' | ' + coll : line;
    }

    function counts() {
      const c = { started: 0, failed: 0, timeout: 0, notStarted: 0, check: 0 };
      state.rows.forEach(r => {
        const k = r.res ? r.res.kind : null;
        if (k === 'started' || k === 'ended') c.started += 1;
        else if (k === 'failed') c.failed += 1;
        else if (k === 'timeout') c.timeout += 1;
        else if (k === 'interrupted') c.check += 1;
        else if (!k || ['skipped', 'needs-you', 'stopped', 'signed-out', 'blocked'].includes(k)) c.notStarted += 1;
      });
      return c;
    }

    const countLine = c => 'Started ' + c.started + ' | Failed ' + c.failed + ' | Timed out ' + c.timeout +
      ' | Not started ' + c.notStarted + (c.check ? ' | Check TestView ' + c.check : '');

    function reportText() {
      return ['TestView 1 bulk start (PRETEST), ' + stamp(state.lastRun || Date.now())]
        .concat(state.rows.map(rowLine), countLine(counts()))
        .join('\n');
    }

    function logText() {
      return [TRACKER_LABEL + ' v' + SCRIPT_VERSION + ' bulk start log (sign-in values redacted)'].concat(state.log.map(l =>
        clock(l.t) + ' ' + l.sn + ' ' + l.step +
        (l.http !== undefined ? ' http ' + l.http : '') +
        (l.ms !== undefined ? ' ' + l.ms + 'ms' : '') +
        (l.code !== undefined && l.code !== null ? ' code ' + l.code : '') +
        (l.msg ? ' msg "' + redact(l.msg) + '"' : '') +
        (l.error ? ' error ' + redact(l.error) : '') +
        (l.auth ? ' SIGNED OUT' : '') +
        (l.reply ? '\n    reply ' + redact(l.reply.replace(/\s+/g, ' ')) : '')
      )).join('\n');
    }

    // ---- panel: the slate Bulk start look, three numbered steps ----

    const BULK_CSS = [
      '#eve-bulk-btn{position:fixed;right:18px;top:14px;z-index:2147483000;display:inline-flex;align-items:center;gap:10px;max-width:calc(100vw - 36px);text-align:left;background:linear-gradient(120deg,#1e3a8a 0%,#1e293b 55%,#312e81 100%);background-size:200% 100%;color:#dbeafe;border:1px solid #60a5fa;border-radius:14px;padding:8px 12px;font:13px/1.3 sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45),0 0 0 1px rgba(96,165,250,.25);animation:eve-bulk-sheen 6s ease-in-out infinite}',
      '#eve-bulk-btn:hover{filter:brightness(1.18);color:#fff;border-color:#93c5fd}',
      '.eve-bulk-launch-text{display:flex;flex-direction:column;min-width:0}',
      '.eve-bulk-launch-text b{font-size:13px;color:#fff}',
      '.eve-bulk-launch-text span{font-size:11px;color:#bfdbfe}',
      '#eve-bulk-btn .eve-bulk-chev{flex:0 0 auto;width:14px;height:14px;transform:rotate(90deg);transition:transform .15s}',
      '#eve-bulk-btn[aria-expanded="true"] .eve-bulk-chev{transform:rotate(-90deg)}',
      '@keyframes eve-bulk-sheen{0%,100%{background-position:0 0}50%{background-position:100% 0}}',
      '@media (prefers-reduced-motion:reduce){#eve-bulk-btn{animation:none}#eve-bulk-btn .eve-bulk-chev{transition:none}}',
      '#eve-bulk-btn path,.eve-bulk-mark path,.eve-bulk-go-main path{fill:currentColor}',
      '#eve-bulk-btn[hidden],#eve-bulk-panel[hidden]{display:none}',
      '#eve-bulk-panel{--bulk-surface:#0f1729;--bulk-line:rgba(148,163,184,.16);--bulk-line-strong:rgba(148,163,184,.3);--bulk-muted:#94a3b8;position:fixed;right:18px;top:14px;z-index:2147483001;width:560px;max-width:calc(100vw - 30px);max-height:calc(100vh - 34px);overflow:auto;background:#0b1222;color:#e2e8f0;border:1px solid var(--bulk-line-strong);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.55);font:13px/1.45 sans-serif;color-scheme:dark}',
      '#eve-bulk-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:10px 12px;background:linear-gradient(120deg,#1e3a8a 0%,#1e293b 55%,#312e81 100%);color:#dbeafe;border-bottom:1px solid rgba(96,165,250,.35);border-radius:13px 13px 0 0;cursor:pointer}',
      '#eve-bulk-head .eve-bulk-close .eve-bulk-ico{transform:rotate(-90deg)}',
      '.eve-bulk-mark{display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:10px;background:#2563eb;color:#fff;box-shadow:0 0 0 1px rgba(147,197,253,.25),0 4px 12px rgba(37,99,235,.35)}',
      '.eve-bulk-titles{display:flex;flex:1;flex-direction:column;min-width:0}',
      '.eve-bulk-titles b{font-size:13px;line-height:1.3;color:#fff}',
      '.eve-bulk-titles span{font-size:11px;color:#bfdbfe}',
      '.eve-bulk-ver{flex:none;padding:2px 8px;border:1px solid var(--bulk-line-strong);border-radius:7px;background:#131d33;color:#cbd5e1;font-size:11.5px;font-weight:600}',
      '#eve-bulk-head .eve-bulk-close{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:0;border:1px solid var(--bulk-line-strong);border-radius:8px;background:#131d33;color:#e2e8f0;cursor:pointer;transition:background .15s,border-color .15s}',
      '#eve-bulk-head .eve-bulk-close:hover{background:#1e293b;border-color:#64748b}',
      '#eve-bulk-btn:focus-visible,#eve-bulk-panel button:focus-visible,#eve-bulk-panel summary:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}',
      '#eve-bulk-body.jstr-view{--jstr-line:var(--bulk-line-strong);--jstr-muted:var(--bulk-muted);--jstr-text:#e2e8f0;--jstr-control:#131d33}',
      '#eve-bulk-body{padding:0 16px 14px}',
      '#eve-bulk-body textarea{width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--jstr-line);background:#070d1a;color:var(--jstr-text);font:12px/1.6 var(--eve-mono,Consolas,monospace);resize:vertical}',
      '#eve-bulk-body textarea:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.22)}',
      '#eve-bulk-body input[type=checkbox]{width:auto;min-height:0;margin:0 4px 0 0;vertical-align:-2px;accent-color:#3b82f6}',
      '#eve-bulk-body input[type=number]{width:72px}',
      '.eve-bulk-ico{flex:none;width:15px;height:15px}',
      '#eve-bulk-body button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px;padding:4px 12px;border-radius:8px;border-color:var(--bulk-line-strong);background:#131d33;color:#e2e8f0;font-weight:600;transition:background .15s,border-color .15s,color .15s,transform .15s}',
      '#eve-bulk-body button:hover:not(:disabled){background:#1b2742;border-color:#64748b}',
      '#eve-bulk-body button:active:not(:disabled){transform:translateY(1px)}',
      '#eve-bulk-body .eve-bulk-btn1{background:#1d4ed8;border-color:#3b82f6;color:#fff}',
      '#eve-bulk-body .eve-bulk-btn1:hover:not(:disabled){background:#2563eb;border-color:#60a5fa}',
      '.eve-bulk-sec{padding:14px 0;border-top:1px solid var(--bulk-line)}',
      '.eve-bulk-sec:first-child{border-top:0}',
      '.eve-bulk-sec-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}',
      '.eve-bulk-num{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:50%;border:1.5px solid #3b82f6;background:rgba(37,99,235,.16);color:#bfdbfe;font-size:14px;font-weight:700}',
      '.eve-bulk-sec-titles{display:flex;flex:1 1 180px;flex-direction:column;min-width:0}',
      '.eve-bulk-sec-title{font-size:14.5px;font-weight:700;line-height:1.3;color:#f1f5f9}',
      '.eve-bulk-sec-help{font-size:12px;color:var(--bulk-muted)}',
      '.eve-bulk-sec-actions{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}',
      '.eve-bulk-badge{display:inline-flex;align-items:center;gap:6px;margin-left:auto;padding:4px 10px;border:1px solid rgba(34,197,94,.45);border-radius:8px;background:rgba(34,197,94,.1);color:#86efac;font-size:12px;font-weight:600;white-space:nowrap}',
      '.eve-bulk-badge.eve-bulk-zero{border-color:var(--bulk-line-strong);background:transparent;color:var(--bulk-muted)}',
      '.eve-bulk-code{display:flex;align-items:stretch;border:1px solid var(--bulk-line-strong);border-radius:10px;background:#070d1a;overflow:hidden;transition:border-color .15s,box-shadow .15s}',
      '.eve-bulk-code:focus-within{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.22)}',
      '.eve-bulk-gutter{flex:none;min-width:34px;box-sizing:border-box;padding:8px 8px 8px 6px;border-right:1px solid var(--bulk-line);color:#64748b;font:12px/1.6 var(--eve-mono,Consolas,monospace);text-align:right;white-space:pre;overflow:hidden;user-select:none}',
      '#eve-bulk-body .eve-bulk-code textarea,#eve-bulk-body .eve-bulk-code textarea:focus{flex:1;min-width:0;margin:0;padding:8px 10px;border:0;border-radius:0;background:transparent;box-shadow:none;white-space:pre;overflow-x:auto}',
      '.eve-bulk-drawer,.eve-bulk-settings{margin-top:10px;border:1px solid var(--bulk-line-strong);border-radius:10px;background:var(--bulk-surface)}',
      '.eve-bulk-settings{margin:0 0 10px;border-color:var(--bulk-line)}',
      '.eve-bulk-drawer>summary,.eve-bulk-settings>summary{display:flex;align-items:center;gap:9px;padding:9px 12px;cursor:pointer;list-style:none;font-size:12.5px;color:#cbd5e1;user-select:none}',
      '.eve-bulk-drawer>summary::-webkit-details-marker,.eve-bulk-settings>summary::-webkit-details-marker{display:none}',
      '.eve-bulk-chev{flex:none;width:14px;height:14px;transition:transform .15s}',
      '#eve-bulk-panel details[open]>summary .eve-bulk-chev{transform:rotate(90deg)}',
      '.eve-bulk-settings>summary .eve-bulk-chev{margin-left:auto}',
      '.eve-bulk-drawer-body,.eve-bulk-settings-body{padding:0 12px 12px}',
      '.eve-bulk-counts{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px;padding:8px 12px;border:1px solid var(--bulk-line);border-radius:10px;background:var(--bulk-surface);font-size:12.5px}',
      '.eve-bulk-counts[hidden]{display:none}',
      '.eve-bulk-tally{display:inline-flex;align-items:center;gap:6px;font-weight:600}',
      '.eve-bulk-tally::before{content:"";width:9px;height:9px;border-radius:50%;background:currentColor}',
      '.eve-bulk-tally.green{color:#4ade80}',
      '.eve-bulk-tally.orange{color:#fb923c}',
      '.eve-bulk-tally.red{color:#f87171}',
      '.eve-bulk-sep{width:1px;align-self:stretch;background:var(--bulk-line-strong)}',
      '.eve-bulk-tablewrap{max-height:340px;overflow:auto;border:1px solid var(--bulk-line-strong);border-radius:10px}',
      '.eve-bulk-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.eve-bulk-table th{position:sticky;top:0;z-index:1;padding:7px 10px;border-bottom:1px solid var(--bulk-line-strong);background:#111a2e;color:#cbd5e1;font-weight:600;text-align:left;white-space:nowrap}',
      '.eve-bulk-table td{padding:6px 10px;border-bottom:1px solid var(--bulk-line);vertical-align:middle}',
      '.eve-bulk-table tr:last-child td{border-bottom:0}',
      '.eve-bulk-table tr:hover td{background:rgba(148,163,184,.05)}',
      '.eve-bulk-table label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}',
      '.eve-bulk-table .eve-bulk-sn{font:600 12.5px var(--eve-mono,Consolas,monospace);white-space:nowrap}',
      '.eve-bulk-res{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 8px;border:1px solid transparent;border-radius:999px;line-height:1.5}',
      '.eve-bulk-res::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}',
      '.eve-bulk-res.jstr-bad{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45)}',
      '.eve-bulk-res.jstr-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.4)}',
      '.eve-bulk-res.jstr-warn{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.4)}',
      '.eve-bulk-res.eve-bulk-busy{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.4)}',
      '.eve-bulk-res.jstr-muted{padding-left:0;border:0}',
      '.eve-bulk-res.eve-bulk-ready{color:#cbd5e1}',
      '.eve-bulk-go{margin-top:12px}',
      '#eve-bulk-body .eve-bulk-go-btn{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%;min-height:52px;padding:8px 12px;border-radius:10px}',
      '.eve-bulk-go-main{display:inline-flex;align-items:center;gap:8px;font-size:15px;font-weight:700}',
      '.eve-bulk-go-sub{font-size:11.5px;font-weight:500;opacity:.85}',
      '#eve-bulk-body .eve-bulk-go-btn.jstr-primary{background:#2563eb;border-color:#3b82f6;color:#fff;box-shadow:0 6px 18px rgba(37,99,235,.3)}',
      '#eve-bulk-body .eve-bulk-go-btn.jstr-primary:hover:not(:disabled){background:#1d4ed8;border-color:#60a5fa}',
      '#eve-bulk-body .eve-bulk-go-btn.jstr-primary:disabled{opacity:1;background:#1a2540;border-color:var(--bulk-line-strong);color:#7c8aa5;box-shadow:none}',
      '#eve-bulk-body .eve-bulk-go-btn.jstr-danger{background:#b91c1c;border-color:#ef4444;color:#fff}',
      '#eve-bulk-body .eve-bulk-go-btn.jstr-danger:hover:not(:disabled){background:#991b1b}',
      '#eve-bulk-body .eve-bulk-utils{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.eve-bulk-settings-body .eve-bulk-utils{margin-top:0}',
      '#eve-bulk-body .eve-bulk-utils button{flex:1 1 auto}',
      '.eve-bulk-sub-label{margin:10px 0 6px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--bulk-muted)}',
      '.eve-bulk-sub-label:first-child{margin-top:2px}',
      '.eve-bulk-auto{display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:12px;color:#cbd5e1}',
      '.eve-bulk-summary{margin-top:10px;font-size:12px;color:var(--bulk-muted)}',
      '.eve-bulk-busy{color:#93c5fd}',
      '@media (prefers-reduced-motion:reduce){#eve-bulk-body button,#eve-bulk-head .eve-bulk-close,.eve-bulk-code,.eve-bulk-chev{transition:none}#eve-bulk-body button:active:not(:disabled){transform:none}}'
    ].join('\n');

    // icon: one of the tracker's inline SVG icons (qaIcon). Copy feedback then
    // swaps the label only, so the icon stays.
    function button(text, title, onClick, cls, icon) {
      const node = el('button', { type: 'button', title: title, className: cls || '' }, icon ? null : text);
      let label = null;
      if (icon) {
        node.innerHTML = qaIcon(icon, 'eve-bulk-ico');
        label = el('span', null, text);
        node.appendChild(label);
      }
      node.addEventListener('click', () => onClick(label || node));
      return node;
    }

    // The main button of step 3: what it does, and under it why (or why not).
    function goButton(text, sub, title, onClick, cls, icon) {
      const node = el('button', { type: 'button', title: title, className: 'eve-bulk-go-btn ' + cls });
      const main = el('span', { className: 'eve-bulk-go-main' });
      main.innerHTML = icon ? qaIcon(icon, 'eve-bulk-ico') : '';
      main.appendChild(el('span', null, text));
      node.appendChild(main);
      node.appendChild(el('span', { className: 'eve-bulk-go-sub' }, sub));
      node.addEventListener('click', onClick);
      return node;
    }

    // A numbered step: number, title, one line of help; actions go in .eve-bulk-sec-head.
    function step(num, title, help) {
      const sec = el('section', { className: 'eve-bulk-sec', 'aria-label': 'Step ' + num + ': ' + title });
      const head = el('div', { className: 'eve-bulk-sec-head' });
      head.appendChild(el('span', { className: 'eve-bulk-num', 'aria-hidden': 'true' }, String(num)));
      const titles = el('div', { className: 'eve-bulk-sec-titles' });
      titles.appendChild(el('div', { className: 'eve-bulk-sec-title', role: 'heading', 'aria-level': '3' }, title));
      titles.appendChild(el('div', { className: 'eve-bulk-sec-help' }, help));
      head.appendChild(titles);
      sec.appendChild(head);
      return { sec: sec, head: head };
    }

    // A code textarea with a line-number gutter; the numbers are never in its
    // value, so copying or selecting the text leaves them out.
    function codeBox(area) {
      const box = el('div', { className: 'eve-bulk-code' });
      const gutter = el('div', { className: 'eve-bulk-gutter', 'aria-hidden': 'true' });
      area.setAttribute('wrap', 'off');
      const sync = () => {
        const lines = String(Math.max(1, area.value.split('\n').length));
        if (gutter.dataset.lines !== lines) {
          gutter.dataset.lines = lines;
          gutter.textContent = Array.from({ length: Number(lines) }, (_, i) => i + 1).join('\n');
        }
        gutter.scrollTop = area.scrollTop;
      };
      area.addEventListener('input', sync);
      area.addEventListener('scroll', () => {
        gutter.scrollTop = area.scrollTop;
      });
      box.appendChild(gutter);
      box.appendChild(area);
      sync();
      return { box: box, sync: sync };
    }

    function showPanel() {
      const here = OPERATOR_RE.test(window.location.pathname);
      panel.hidden = !here || !state.open;
      launcher.hidden = !here || state.open;
      launcher.setAttribute('aria-expanded', String(!!state.open));
      launcher.setAttribute('aria-label', state.open
        ? 'Bulk Server start, expanded'
        : 'Bulk Server start, collapsed: start test for several servers at once. Click to expand');
    }

    // Only a person's click / Escape gets here (never the visibility checks), and
    // focus follows: into the panel when it opens, back to the launcher when it closes.
    function setOpen(open) {
      state.open = open;
      save();
      showPanel();
      const target = open ? ui.paste : launcher;
      if (target && !target.hidden) {
        target.focus({ preventScroll: true });
      }
    }

    function buildSettings() {
      const box = el('details', { className: 'eve-bulk-settings' });
      const summary = el('summary');
      summary.innerHTML = qaIcon('gear', 'eve-bulk-ico') + '<span>Settings &amp; tools</span>' + qaIcon('chevron', 'eve-bulk-chev');
      box.appendChild(summary);
      const inner = el('div', { className: 'eve-bulk-settings-body' });
      box.appendChild(inner);
      const field = (labelText, input, after) => {
        const label = el('label', { className: 'jstr-field' });
        label.appendChild(el('span', { className: 'jstr-label' }, labelText));
        label.appendChild(input);
        if (after) label.appendChild(document.createTextNode(' ' + after));
        inner.appendChild(label);
      };
      const tierInput = (key, labelText) => {
        const input = el('input', { type: 'text' });
        input.value = listOf(state.cfg[key]).join(', ');
        input.addEventListener('change', () => {
          state.cfg[key] = listOf(input.value);
          input.value = state.cfg[key].join(', ');
          state.rows.forEach(r => {
            if (r.coll && r.coll.label) r.coll.tier = tierOf(r.coll.label);
          });
          save();
          render();
        });
        field(labelText, input);
      };
      const numInput = (key, labelText, after, min, max) => {
        const input = el('input', { type: 'number', min: String(min), max: String(max) });
        input.value = String(state.cfg[key]);
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (value >= min && value <= max) state.cfg[key] = value;
          input.value = String(state.cfg[key]);
          save();
        });
        field(labelText, input, after);
      };
      inner.appendChild(el('div', { className: 'eve-bulk-sub-label' }, 'Settings'));
      tierInput('green', 'Green: ticks Collector on its own (comma separated)');
      tierInput('orange', 'Orange: left for you to check');
      numInput('gapSec', 'Gap between start requests', 'seconds (each server\'s own checks run alongside)', 0, 60);
      numInput('recheckMaxAgeMin', 'Reuse a collector check younger than', 'minutes instead of repeating it at start (0 = always repeat)', 0, 120);
      const recheck = el('label', { className: 'jstr-field' });
      const recheckBox = el('input', { type: 'checkbox' });
      recheckBox.checked = state.cfg.recheck;
      recheckBox.addEventListener('change', () => {
        state.cfg.recheck = recheckBox.checked;
        save();
        render();
      });
      recheck.appendChild(recheckBox);
      recheck.appendChild(document.createTextNode('Look the position up again right before each start; anything not green or orange is not started'));
      inner.appendChild(recheck);
      inner.appendChild(el('div', { className: 'eve-bulk-sub-label' }, 'Tools'));
      ui.tools = el('div', { className: 'eve-bulk-utils' });
      inner.appendChild(ui.tools);
      return box;
    }

    function buildPanel() {
      repairTool.ensureStyle();
      const style = el('style', { id: 'eve-bulk-style' });
      style.textContent = BULK_CSS;
      (document.head || document.documentElement).appendChild(style);

      launcher = el('button', { type: 'button', id: 'eve-bulk-btn', title: 'Open Bulk Server start' });
      launcher.innerHTML =
        qaIcon('play', 'eve-bulk-ico') +
        '<span class="eve-bulk-launch-text"><b>Bulk Server start</b><span>Start test for several servers at once</span></span>' +
        qaIcon('chevron', 'eve-bulk-chev');
      launcher.addEventListener('click', () => setOpen(true));
      launcher.setAttribute('aria-controls', 'eve-bulk-panel');
      launcher.setAttribute('aria-expanded', 'false');
      launcher.setAttribute('aria-label', 'Bulk Server start, collapsed: start test for several servers at once. Click to expand');
      document.body.appendChild(launcher);

      panel = el('div', { id: 'eve-bulk-panel', role: 'region', 'aria-label': 'Bulk Server start' });
      const head = el('div', { id: 'eve-bulk-head' });
      const mark = el('span', { className: 'eve-bulk-mark', 'aria-hidden': 'true' });
      mark.innerHTML = qaIcon('play', 'eve-bulk-ico');
      head.appendChild(mark);
      const titles = el('div', { className: 'eve-bulk-titles' });
      titles.appendChild(el('b', null, 'Bulk Server start'));
      titles.appendChild(el('span', null, 'Start test for several servers at once'));
      head.appendChild(titles);
      head.appendChild(el('span', { className: 'eve-bulk-ver' }, 'v' + SCRIPT_VERSION));
      const hide = button('', 'Collapse (the Bulk Server start header brings it back)', () => setOpen(false), 'eve-bulk-close', 'chevron');
      hide.setAttribute('aria-label', 'Collapse Bulk Server start');
      head.appendChild(hide);
      // The header is the same collapsible header expanded or collapsed.
      head.addEventListener('click', event => {
        if (!event.target.closest('button')) setOpen(false);
      });
      panel.appendChild(head);
      panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') setOpen(false);
      });

      const body = el('div', { id: 'eve-bulk-body', className: 'jstr-view' });

      const one = step(1, 'Paste serials, one per line', 'Enter server serial numbers below. One per line.');
      ui.count = el('span', { className: 'eve-bulk-badge', role: 'status' });
      one.head.appendChild(ui.count);
      ui.paste = el('textarea', { rows: '4', placeholder: 'one serial per line ("e <serial>" lines work too)', spellcheck: 'false', 'aria-label': 'Serials to start' });
      ui.paste.value = state.text;
      let pasteTimer = null;
      ui.paste.addEventListener('input', () => {
        if (run) return;
        applyList(ui.paste.value);
        render();
        clearTimeout(pasteTimer);
        pasteTimer = setTimeout(() => checkCollector(state.rows.filter(r => !r.coll && !r.res)), 700);
      });
      one.sec.appendChild(codeBox(ui.paste).box);
      ui.info = el('div', { className: 'jstr-hint' });
      one.sec.appendChild(ui.info);
      body.appendChild(one.sec);

      const two = step(2, 'PuTTY', 'Generated e-commands for PuTTY (one per serial).');
      const copies = el('div', { className: 'eve-bulk-sec-actions' });
      copies.appendChild(button('Copy e-commands', 'Copy every line as "e <serial>"; paste the block into PuTTY', node => copyText(eBlock(), node), 'eve-bulk-btn1', 'copy'));
      copies.appendChild(button('Copy serials', 'Copy the cleaned serial list', node => copyText(serialBlock(), node), '', 'doc'));
      two.head.appendChild(copies);
      ui.e = el('textarea', { rows: '3', readonly: 'readonly', spellcheck: 'false', 'aria-label': 'e commands for PuTTY' });
      const eBox = codeBox(ui.e);
      ui.eSync = eBox.sync;
      two.sec.appendChild(eBox.box);
      const output = el('details', { className: 'eve-bulk-drawer' });
      const outputHead = el('summary');
      outputHead.innerHTML = qaIcon('chevron', 'eve-bulk-chev') + qaIcon('doc', 'eve-bulk-ico') + '<span>Paste the PuTTY output to read ILOM / ROT per server</span>';
      output.appendChild(outputHead);
      const outputBody = el('div', { className: 'eve-bulk-drawer-body' });
      ui.putty = el('textarea', { rows: '4', placeholder: '[tester@... ~]$ e <serialA>; e <serialB>\nHOSTNIC ... down\nILOM ... up\nROT ... up\n(one status table per server)', spellcheck: 'false', 'aria-label': 'PuTTY output' });
      ui.putty.value = state.putty;
      ui.putty.addEventListener('input', () => {
        state.putty = ui.putty.value;
        save();
        render();
      });
      outputBody.appendChild(ui.putty);
      const auto = el('label', { className: 'eve-bulk-auto', title: 'Ticks only the PuTTY box, only where the output shows ILOM and ROT up. Never starts a test; Collector, the table and Start stay yours.' });
      ui.autoPutty = el('input', { type: 'checkbox' });
      ui.autoPutty.checked = !!state.cfg.autoPutty;
      ui.autoPutty.addEventListener('change', () => {
        state.cfg.autoPutty = ui.autoPutty.checked;
        save();
        render();
      });
      auto.appendChild(ui.autoPutty);
      auto.appendChild(el('span', null, 'Auto-check PuTTY from output (ILOM and ROT up; never starts a test)'));
      outputBody.appendChild(auto);
      ui.puttyInfo = el('div', { className: 'jstr-line', style: 'margin-top:6px' });
      outputBody.appendChild(ui.puttyInfo);
      output.appendChild(outputBody);
      two.sec.appendChild(output);
      body.appendChild(two.sec);

      const three = step(3, 'Confirm each server, then start', 'Check collector status for each server, confirm, then start the pretest.');
      const collActions = el('div', { className: 'eve-bulk-sec-actions' });
      ui.check = button('Check collector', 'Look up every server not yet run in the collector', () => checkCollector(state.rows.filter(r => !r.res)), '', 'refresh');
      collActions.appendChild(ui.check);
      collActions.appendChild(button('Open collector', 'Open the collector in a new tab (sign in there if lookups say sign-in needed)', () => window.open(COLLECTOR_PAGE, '_blank'), 'eve-bulk-btn1', 'ext'));
      three.head.appendChild(collActions);
      ui.coll = el('div', { className: 'eve-bulk-counts' });
      three.sec.appendChild(ui.coll);
      ui.signIn = el('div', { className: 'jstr-banner warn', style: 'margin:0 0 10px' },
        'Collector sign-in needed: open the collector in this browser and sign in, then come back to this tab. The checks that failed run again on their own.');
      ui.signIn.hidden = true;
      three.sec.appendChild(ui.signIn);
      three.sec.appendChild(buildSettings());
      const tableWrap = el('div', { className: 'eve-bulk-tablewrap' });
      ui.table = el('table', { className: 'eve-bulk-table' });
      tableWrap.appendChild(ui.table);
      three.sec.appendChild(tableWrap);
      ui.go = el('div', { className: 'eve-bulk-go' });
      three.sec.appendChild(ui.go);
      ui.actions = el('div', { className: 'eve-bulk-utils' });
      three.sec.appendChild(ui.actions);
      ui.summary = el('div', { className: 'eve-bulk-summary', role: 'status', 'aria-live': 'polite' });
      three.sec.appendChild(ui.summary);
      body.appendChild(three.sec);
      panel.appendChild(body);
      document.body.appendChild(panel);
      showPanel();
      render();
    }

    function checkAllBox(key, labelText) {
      const th = el('th');
      const label = el('label', { title: 'Tick or clear ' + labelText + ' for every server not yet run' });
      const box = el('input', { type: 'checkbox' });
      const open = state.rows.filter(r => !r.res);
      const on = open.filter(r => r[key]).length;
      box.checked = open.length > 0 && on === open.length;
      box.indeterminate = on > 0 && on < open.length;
      box.disabled = !!run || !open.length;
      box.addEventListener('change', () => {
        open.forEach(r => {
          r[key] = box.checked;
          if (key === 'col') {
            r.colAuto = false;
            r.colManual = box.checked;
          } else {
            r.puttyAuto = false;
            r.puttyManual = true;
          }
        });
        save();
        render();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(labelText));
      th.appendChild(label);
      return th;
    }

    const TIER_HINT = {
      green: ['jstr-ok', '\u2713 ', 'green: ticked on its own'],
      orange: ['jstr-warn', 'check: ', 'orange: check this one yourself'],
      red: ['jstr-bad', '\u2717 ', 'red: needs action before it can start']
    };

    function collHint(r) {
      const c = r.coll;
      if (!c) return null;
      if (c.pending) return el('span', { className: 'eve-bulk-busy' }, 'checking\u2026');
      if (c.error) return el('span', { className: 'jstr-bad', title: c.error }, '? ' + c.error);
      const hint = TIER_HINT[c.tier] || TIER_HINT.red;
      const how = r.colAuto ? ' (ticked by the check)' : r.colManual ? ' (ticked by you: it starts even if the collector shows red at start)' : '';
      return el('span', { className: hint[0], title: hint[2] + how }, hint[1] + c.label);
    }

    function puttyHint(h) {
      if (!h) return null;
      return el('span', {
        className: h.ok ? 'jstr-ok' : 'jstr-bad',
        title: 'ILOM ' + (h.ilom || '?') + ', ROT ' + (h.rot || '?') + ', HOSTNIC ' + (h.hostnic || '?') + ' (pasted output, matched ' +
          (h.via === 'order' ? 'by command order' : h.via === 'named' ? 'by the serial in the table' : 'to its one command') + ')'
      }, h.ok ? '\u2713' : '\u2717 ' + (h.ilom !== 'up' ? 'ILOM ' + (h.ilom || '?') : 'ROT ' + (h.rot || '?')));
    }

    function boxCell(r, key, hint) {
      const td = el('td');
      const name = key === 'col' ? 'Collector' : 'PuTTY';
      const box = el('input', { type: 'checkbox', title: 'I checked this server in ' + (key === 'col' ? 'the collector' : 'PuTTY'), 'aria-label': name + ' checked for ' + r.sn });
      box.checked = !!r[key];
      box.disabled = !!run || !!r.res;
      box.addEventListener('change', () => {
        r[key] = box.checked;
        if (key === 'col') {
          r.colAuto = false;
          r.colManual = box.checked;
        } else {
          r.puttyAuto = false;
          r.puttyManual = true; // your tick or untick beats the output
        }
        save();
        render();
      });
      td.appendChild(box);
      if (hint) td.appendChild(hint);
      return td;
    }

    // Opt-in only: ticks the PuTTY box where ILOM and ROT are up. A row you
    // ticked or unticked yourself is left alone; an auto tick the output no
    // longer backs is taken off again. Starts nothing.
    function autoCheckPutty(putty) {
      let changed = false;
      state.rows.forEach(r => {
        const h = putty[r.sn];
        if (r.puttyAuto && (!state.cfg.autoPutty || !h || !h.ok || r.res)) {
          r.putty = false;
          r.puttyAuto = false;
          changed = true;
        } else if (state.cfg.autoPutty && h && h.ok && !r.res && !r.putty && !r.puttyManual) {
          r.putty = true;
          r.puttyAuto = true;
          changed = true;
        }
      });
      if (changed) save();
    }

    function renderPuttyInfo(putty, notes) {
      ui.puttyInfo.textContent = '';
      ui.autoPutty.checked = !!state.cfg.autoPutty;
      if (!state.putty.trim()) return;
      (notes || []).slice(0, 4).forEach(note => {
        ui.puttyInfo.appendChild(el('div', { className: 'jstr-hint jstr-warn' }, note));
      });
      const found = state.rows.filter(r => putty[r.sn]);
      const good = found.filter(r => putty[r.sn].ok);
      ui.puttyInfo.appendChild(el('span', { className: 'jstr-muted' },
        found.length + ' of ' + state.rows.length + ' found in the output, ' + good.length + ' with ILOM and ROT up'));
      const tick = button('Tick PuTTY for those ' + good.length, 'Tick PuTTY for the servers whose output shows ILOM and ROT up (HOSTNIC either way)', () => {
        good.forEach(r => {
          if (!r.res) r.putty = true;
        });
        save();
        render();
      });
      tick.disabled = !!run || !good.some(r => !r.res && !r.putty);
      ui.puttyInfo.appendChild(tick);
    }

    function renderTable(putty) {
      ui.table.textContent = '';
      const head = el('tr');
      head.appendChild(el('th', null, '#'));
      head.appendChild(el('th', null, 'Serial'));
      head.appendChild(checkAllBox('col', 'Collector'));
      head.appendChild(checkAllBox('putty', 'PuTTY'));
      head.appendChild(el('th', null, 'Result'));
      ui.table.appendChild(head);
      state.rows.forEach((r, i) => {
        const tr = el('tr');
        tr.appendChild(el('td', { className: 'jstr-muted' }, String(i + 1)));
        tr.appendChild(el('td', { className: 'eve-bulk-sn' }, r.sn));
        tr.appendChild(boxCell(r, 'col', collHint(r)));
        tr.appendChild(boxCell(r, 'putty', puttyHint(putty[r.sn])));
        const kind = r.res ? r.res.kind : 'none';
        const ready = !r.res && r.col && r.putty;
        const result = el('td', { title: r.res && r.res.check ? 'UUT check: ' + r.res.check : '' });
        result.appendChild(el('span', { className: 'eve-bulk-res ' + (KIND_CLASS[kind] || 'jstr-muted') + (ready ? ' eve-bulk-ready' : '') },
          r.res ? (LABEL[kind] || kind) + ': ' + r.res.msg : ready ? 'Ready' : 'Not confirmed'));
        tr.appendChild(result);
        ui.table.appendChild(tr);
      });
      if (!state.rows.length) {
        const empty = el('tr');
        empty.appendChild(el('td', { colspan: '5', className: 'jstr-muted' }, 'Paste serials above.'));
        ui.table.appendChild(empty);
      }
    }

    // Collector colours only: a start result never changes them.
    function renderCollectorBar() {
      ui.coll.textContent = '';
      const tally = { green: 0, orange: 0, red: 0, err: 0, pending: 0 };
      state.rows.forEach(r => {
        if (!r.coll) return;
        if (r.coll.pending) tally.pending += 1;
        else if (r.coll.error) tally.err += 1;
        else tally[r.coll.tier] = (tally[r.coll.tier] || 0) + 1;
      });
      ui.check.disabled = !!run || !state.rows.some(r => !r.res);
      ui.coll.hidden = !state.rows.length;
      ['green', 'orange', 'red'].forEach(tier => {
        ui.coll.appendChild(el('span', { className: 'eve-bulk-tally ' + tier }, tally[tier] + ' ' + tier));
      });
      ui.coll.appendChild(el('span', { className: 'eve-bulk-sep', 'aria-hidden': 'true' }));
      ui.coll.appendChild(el('span', { className: 'jstr-muted' }, 'Collector: ' + (tally.green + tally.orange + tally.red) + ' of ' + state.rows.length + ' checked' +
        (tally.pending ? ', ' + tally.pending + ' checking' : '') + (tally.err ? ', ' + tally.err + ' no answer' : '')));
      ui.signIn.hidden = !state.rows.some(r => !r.res && r.coll && signInError(r.coll.error));
    }

    function renderControls() {
      ui.go.textContent = '';
      ui.actions.textContent = '';
      ui.tools.textContent = '';
      const ready = state.rows.filter(isReady).length;
      const open = state.rows.filter(r => !r.res).length;
      if (run) {
        const stop = goButton(run.stopping ? 'Stopping\u2026' : 'Stop',
          run.stopping ? 'Finishing the server in progress' : 'Finishes the server in progress and starts no more',
          'Finish the server in progress and start no more', () => stopRun('stopped by you'), 'jstr-danger');
        stop.disabled = run.stopping;
        ui.go.appendChild(stop);
      } else {
        // One line on why it cannot start yet; the batch is still confirmed before anything starts.
        const why = ready
          ? 'You confirm the batch before anything starts'
          : !state.rows.length
            ? 'Paste serials in step 1 first'
            : !open
              ? 'Every server has a result: Retry or Clear results to start again'
              : 'Tick Collector and PuTTY for each server to start';
        const go = goButton('Start ' + ready + ' of ' + open, why,
          ready ? 'Start PRETEST on the servers with both boxes ticked' : 'Tick Collector and PuTTY for the servers to start',
          () => startRun(), 'jstr-primary', 'play');
        go.disabled = !ready;
        ui.go.appendChild(go);
        const bounced = state.rows.filter(r => r.res && r.res.kind === 'blocked' && r.putty);
        if (bounced.length && state.cfg.recheck) {
          ui.actions.appendChild(button('Push ' + bounced.length + ' bounced through', 'Start the servers the collector check stopped, without stopping them again', () => pushThrough(bounced), '', 'play'));
        }
        const retry = state.rows.filter(retryable).length;
        if (retry) {
          ui.actions.appendChild(button('Retry ' + retry + ' not started', 'Make failed, timed-out and stopped servers startable again (their boxes stay as they were)', () => {
            state.rows.forEach(r => {
              if (retryable(r)) r.res = null;
            });
            save();
            render();
          }, '', 'refresh'));
        }
        if (state.rows.some(r => r.res)) {
          ui.tools.appendChild(button('Clear results', 'Forget every result; servers that already started become startable again', () => {
            if (!window.confirm('Forget all results? Servers that already started would become startable again.')) return;
            state.rows.forEach(r => {
              r.res = null;
            });
            save();
            render();
          }, '', 'trash'));
        }
      }
      ui.tools.appendChild(button('Copy report', 'Copy every serial with its result, ready to paste', node => copyText(reportText(), node), '', 'copy'));
      ui.tools.appendChild(button('Copy failed serials', 'Copy the serials that failed or timed out, one per line', node =>
        copyText(state.rows.filter(r => r.res && (r.res.kind === 'failed' || r.res.kind === 'timeout')).map(r => r.sn).join('\n'), node), '', 'copy'));
      ui.tools.appendChild(button('Copy log', 'Copy every request and reply (no sign-in data) for troubleshooting', node => copyText(logText(), node), '', 'doc'));
      setTextIfChanged(ui.summary, (run ? 'Running: ' + (run.stopping ? 'stopping after the current server. ' : '') : '') + countLine(counts()));
    }

    function render() {
      if (!panel) return;
      const parse = state.parse || {};
      const invalid = parse.invalid || [];
      const n = state.rows.length;
      const badge = n ? n + ' serial' + (n === 1 ? '' : 's') + ' detected' : 'No serials yet';
      if (ui.count.dataset.text !== badge) {
        ui.count.dataset.text = badge;
        ui.count.innerHTML = qaIcon('doc', 'eve-bulk-ico');
        ui.count.appendChild(el('span', null, badge));
        ui.count.classList.toggle('eve-bulk-zero', !n);
      }
      const notes = [];
      if (parse.dupes) notes.push(parse.dupes + ' duplicate' + (parse.dupes === 1 ? '' : 's') + ' removed');
      if (invalid.length) notes.push('not a serial, skipped: ' + invalid.slice(0, 4).join(', ') + (invalid.length > 4 ? ' \u2026' : ''));
      ui.info.textContent = notes.join(' | ');
      ui.info.hidden = !notes.length;
      ui.info.className = 'jstr-hint' + (invalid.length ? ' jstr-warn' : '');
      const commands = eBlock();
      if (ui.e.value !== commands) {
        ui.e.value = commands;
        ui.eSync();
      }
      ui.e.rows = Math.min(10, Math.max(2, state.rows.length));
      ui.paste.disabled = !!run;
      const parsed = parsePuttyDetails(state.putty);
      const putty = parsed.map;
      if (!run) autoCheckPutty(putty);
      renderPuttyInfo(putty, parsed.notes);
      renderTable(putty);
      renderCollectorBar();
      renderControls();
    }

    function init() {
      if (document.getElementById('eve-bulk-panel') || !document.body) return;
      state = loadState();
      if (state.text && !state.parse) {
        const parsed = parseList(state.text);
        state.parse = { invalid: parsed.invalid, dupes: parsed.dupes };
      }
      buildPanel();
      save();
      checkCollector(state.rows.filter(r => !r.coll && !r.res));
      // Back from signing in to the collector in another tab: rerun the checks that needed it.
      window.addEventListener('focus', () => checkCollector(state.rows.filter(r => !r.res && r.coll && signInError(r.coll.error))));
      // TestView is a single-page app: the panel shows only while on the operator page.
      setInterval(showPanel, 2000);
    }

    // True on the TestView 1 operator page, where only this panel runs.
    function handlesPage() {
      if (window.location.origin !== new URL(TESTVIEW_LIST_URL).origin || !OPERATOR_RE.test(window.location.pathname)) {
        return false;
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
      return true;
    }

    return { handlesPage, parseList, parsePuttyOutput, parsePuttyDetails, pickItem };
  })();

  // ===== BOOTSTRAP =====

  function bootstrap() {
    if (repairTool.handlesPage()) return;
    if (bulkStart.handlesPage()) return;
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
      if (document.documentElement && !ON_LIVE_DASHBOARD) {
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