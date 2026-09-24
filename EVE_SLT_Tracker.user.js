// ==UserScript==
// @name         EVE SLT Tracker
// @namespace    https://github.com/zayd117/EVE-SLT-TRACKER
// @version      0.9.10
// @description  Monitors an EVE SLT rack page for server test-result colour changes and raises in-page + desktop alerts.
// @author       Zay Davidson
// @homepageURL  https://github.com/zayd117/EVE-SLT-TRACKER
// @supportURL   https://github.com/zayd117/EVE-SLT-TRACKER/issues
// @match        *://*/out/out.eveslt.php*
// @match        *://*/slt/list*
// @run-at       document-start
// @noframes
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      jira.synnex.com
// @updateURL    https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_Tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_Tracker.user.js
// ==/UserScript==

// EVE SLT Tracker - by Zay Davidson
// Docs, changelog and design notes: https://github.com/zayd117/EVE-SLT-TRACKER
// Every "// ===== SECTION =====" marker below has notes in docs/CODE_NOTES.md.
// Bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues

(function () {
  'use strict';

  // ===== VERSION - single source of truth =====
  const SCRIPT_VERSION =
    typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version
      ? GM_info.script.version
      : '0.9.10';
  const LOG_PREFIX = '[EVE Tracker]';

  // ===== STORAGE KEYS =====
  const SETTINGS_KEY = 'eveRackTrackerSettings';
  const PREV_STATES_KEY = 'eveRackTrackerPreviousStates';
  const ACTIVE_ALERTS_KEY = 'eveRackTrackerActiveAlerts';
  const RECENT_ALERTS_KEY = 'eveRackTrackerRecentAlerts';
  const ALERT_LOG_KEY = 'eveRackTrackerAlertLog';
  const LOG_SHIFT_KEY = 'eveRackTrackerAlertLogDay';
  const LOG_CLEARED_KEY = 'eveRackTrackerAlertLogClearedAt';
  const ALERTS_COLLAPSED_KEY = 'eveRackTrackerAlertsCollapsed';
  const PANEL_POSITION_KEY = 'eveRackTrackerPanelPosition';
  const DEBUG_SNAPSHOT_KEY = 'eveRackTrackerDebugSnapshot';
  const ALERT_PANEL_POSITION_KEY = 'eveRackTrackerAlertPanelPosition';
  const JIRA_CACHE_KEY = 'eveRackTrackerJiraCache';
  const HEARTBEAT_KEY = 'eveRackTrackerHeartbeat';

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
  const DEFAULT_REFRESH_SECONDS = 30;

  // ===== SETTINGS =====
  const defaultSettings = {
    sections: {},
    refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
    notificationTimeoutSeconds: 0,
    developerMode: false,
    jiraBaseUrl: 'https://jira.synnex.com',
    notificationClickTarget: 'jira',
    logShift: ''
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
      `EVE TRACKER ${state}`,
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
      showTestViewBanner(`EVE Tracker: typed SN ${serial} but the list did not filter. Press Query.`);
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
          showTestViewBanner(`EVE Tracker: could not auto-fill SN ${serial}. Enter it manually.`);
        }
        return;
      }
      finish();
      submitTestViewQuery(input, serial).catch(error => {
        console.error(LOG_PREFIX + ' TestView: auto-query crashed:', error);
        showTestViewBanner(`EVE Tracker: auto-query failed (${error && error.message}). Press Query.`);
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
  const JIRA_TICKET_LATE_MS = 2 * 60 * 60 * 1000;
  const JIRA_PEAK_POLL_MS = 30 * 1000;
  const JIRA_PENDING_POLL_MS = 60 * 1000;
  const JIRA_LATE_POLL_MS = 5 * 60 * 1000;
  const JIRA_TAB_POLL_MS = 15 * 1000;
  const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
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
    return hit && hit.state === 'found' && JIRA_KEY_PATTERN.test(String(hit.key))
      ? jiraIssueUrl(hit.key)
      : '';
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
      summary: String(fields.summary || '').slice(0, 200),
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

  function paintJiraButton(button, serial, result, loading) {
    const label = button.querySelector('.eve-jira-label');
    const failedAt = Number(button.dataset.failedAt) || 0;
    const pretest = button.dataset.pretest === '1';
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
      text = result.key;
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
        'exists, or to search Jira.';
    } else if (result && result.state === 'noticket') {
      cls += ' eve-jira-noticket';
      text = 'No ticket';
      tip =
        `No Jira ticket was raised in the ${jiraMinutesSince(failedAt)} min ` +
        'since this failure (they usually appear within ' +
        `${JIRA_TICKET_USUAL_MAX} min)` +
        (pretest ? ' \u{2014} common for pre-test fails.' : '.') +
        (jiraStillChecking(failedAt)
          ? ' Still checking every few minutes until ' +
            `${new Date(failedAt + JIRA_TICKET_LATE_MS).toLocaleTimeString()} ` +
            'in case one is raised late.'
          : '') +
        '\nClick to search Jira: most recently updated or most ' +
        'recently created.';
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
  }

  function buildJiraButton(serial, record) {
    const button = document.createElement('a');
    const failedAt = jiraFailedAt(record);
    button.className = 'eve-alert-jira';
    button.target = '_blank';
    button.rel = 'noopener noreferrer';
    button.dataset.failedAt = failedAt ? String(failedAt) : '';
    button.dataset.pretest = jiraIsPretest(record) ? '1' : '';
    button.setAttribute('aria-label', `Open ${serial} in Jira`);
    button.innerHTML =
      '<span class="eve-jira-dot" aria-hidden="true"></span>' +
      '<span class="eve-jira-label">Jira</span>' +
      JIRA_ICON_SVG;
    button.addEventListener('click', event => {
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
    paintJiraButton(button, serial, jiraCardResult(serial, failedAt));
    return button;
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
    '@media (prefers-reduced-motion:reduce){' +
    '.eve-opt,.eve-opt-label,.eve-opt-note{transition:none;}' +
    '.eve-opt:active{transform:none;}}';

  function writeJiraTab(tab, title, lines, links) {
    const list = links || [];
    try {
      const doc = tab.document;
      const signature = JSON.stringify([title, lines, list]);
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

  function writeJiraWaitPage(tab, serial, failedAt, pretest) {
    const expecting = jiraExpecting(failedAt);
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
    ]);
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
      writeJiraWaitPage(tab, serial, failedAt, pretest);
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

  function openNotificationTarget(detailUrl, serial, failedAt, pretest) {
    const target = (settings && settings.notificationClickTarget) || 'jira';
    const wantJira = (target === 'jira' || target === 'both') && !!serial;
    const wantPage = target === 'detail' || target === 'both' || !wantJira;
    const wantTestView = wantPage && !!serial;
    const wantDetail = wantPage && !serial && !!detailUrl;
    if (wantDetail) {
      openFromNotification(detailUrl);
    } else if (wantTestView) {
      openTestView(serial, openFromNotification);
    }
    if (wantJira) {
      return openJiraFromToast(serial, failedAt || 0, !!pretest);
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

  function withLogShift(loaded) {
    if (!SHIFTS[loaded.logShift]) {
      loaded.logShift = guessShift(new Date());
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

  function observePage() {
    if (pageObserver) {
      pageObserver.disconnect();
    }
    pageObserver = new MutationObserver(mutations => {
      if (!mutations.some(isRelevantMutation)) {
        return;
      }
      if (scanTimer) {
        clearTimeout(scanTimer);
      }
      scanTimer = setTimeout(() => {
        scanTimer = null;
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
      serial: info.serial
    };
    const colorChanged = oldState && oldState.color !== info.color;
    const serialChanged = oldState && oldState.serial !== info.serial;
    if (!oldState || colorChanged || serialChanged) {
      markDirty();
      devLog(
        `${key} \u{2192} color:${info.color} serial:${info.serial}` +
          (oldState ? ` (was ${oldState.color}/${oldState.serial})` : ' (baseline)')
      );
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
    const suppressed = isDuplicateAlert(key, info.serial, transition);
    const eventId = logRealAlert(info, transition, !!suppressed);
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
    return confirmPhase(info.detailUrl, info)
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
      record.detailUrl || record.serial
        ? () =>
            openNotificationTarget(
              record.detailUrl,
              record.serial,
              jiraFailedAt(record),
              jiraIsPretest(record)
            )
        : null
    );
  }

  function surfaceAlert(info, transition, eventConfirmation, eventId) {
    const record = createPersistentAlert(getTransitionTitle(transition), info, transition);
    record.eventId = eventId || '';
    linkLogEntryToAlert(eventId, record.id);
    updateStoredAlert(record);
    const confirmation = eventConfirmation
      ? eventConfirmation
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
          item.info && (item.info.detailUrl || item.info.serial)
            ? () =>
                openNotificationTarget(
                  item.info.detailUrl,
                  item.info.serial,
                  jiraFailedAt(item.record),
                  jiraIsPretest(item.record)
                )
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

  function guessShift(date) {
    const now = date.getHours() * 60 + date.getMinutes();
    const ids = Object.keys(SHIFTS);
    const since = id => (now - shiftMinutes(SHIFTS[id].start) + 1440) % 1440;
    const until = id => (shiftMinutes(SHIFTS[id].start) - now + 1440) % 1440;
    const running = ids
      .filter(id => since(id) < shiftLengthMin(SHIFTS[id]))
      .sort((a, b) => since(a) - since(b));
    if (running.length) {
      return running[0];
    }
    return ids.sort((a, b) => until(a) - until(b))[0];
  }

  function currentShiftId() {
    return settings && SHIFTS[settings.logShift] ? settings.logShift : 'graveyard';
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

  function checkLogShiftRollover() {
    const win = currentShiftWindow();
    if (activeLogShift === win.key) {
      return;
    }
    const previous = activeLogShift;
    recordActiveLogShift(win.key);
    const removed = pruneLogBefore(win.opens.getTime());
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
      `EVE TRACKER \u{2014} NEW ${win.shift.label.toUpperCase()} SHIFT LOG`,
      `${count} from the previous shift were cleared.\n` + `Now logging: ${shiftWindowLabel(win)}.`,
      null,
      null
    );
  }

  function onLogShiftChanged() {
    const win = currentShiftWindow();
    recordActiveLogShift(win.key);
    log(
      `Log shift set to ${win.shift.label}. Exports now cover ` +
        `${shiftWindowLabel(win)} (plus ${SHIFT_EARLY_MIN} min ` +
        `before, ${SHIFT_LATE_MIN} min after). Nothing was cleared.`
    );
  }

  function loadAlertLogFromStorage() {
    const parsed = readJSON(localStorage, ALERT_LOG_KEY, null, 'Alert log');
    return Array.isArray(parsed) ? parsed : [];
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
        pass: confirmation.pass
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

  function isoDateParts(iso) {
    if (!iso) {
      return { date: '', time: '' };
    }
    const match = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (match) {
      return { date: match[1], time: match[2] };
    }
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return { date: '', time: '' };
    }
    const isoString = parsed.toISOString();
    return {
      date: isoString.slice(0, 10),
      time: isoString.slice(11, 19)
    };
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
      const parts = isoDateParts(entry.iso);
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
      `Exported:      ${new Date().toLocaleString()}`,
      `Shift:         ${shiftWindowLabel(win)}`,
      `Log window:    ${win.opens.toLocaleString()} \u{2013} ` + `${win.closes.toLocaleString()}`
    );
    if (logEntries.length) {
      const first = new Date(logEntries[0].iso);
      const last = new Date(logEntries[logEntries.length - 1].iso);
      lines.push(
        `First alert:   ${first.toLocaleString()}`,
        `Last alert:    ${last.toLocaleString()}`,
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
        lines.push(
          `[${index + 1}] ${entry.date} ${entry.time} \u{2014} ` + `${entry.result}`,
          `      Serial #: ${entry.serial}`,
          `      Location: ${entry.section} \u{2022} ` + `${entry.eve} \u{2022} ${entry.unit}`
        );
        if (entry.serverType) {
          lines.push(`      Type:     ${entry.serverType}`);
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
        'Notified'
      ].join(',')
    );
    logEntries.forEach(entry => {
      const parts = isoDateParts(entry.iso);
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
          entry.alertId ? 'yes' : 'no'
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
      const now = new Date();
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(part => String(part).padStart(2, '0'))
        .join('-');
      const win = currentShiftWindow();
      const link = document.createElement('a');
      link.href = url;
      link.download =
        `eve-slt-tracker-log-${localDateKey(win.starts)}-${win.id}-` + `${time}.${extension}`;
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

  // ===== COPY SERIAL TO CLIPBOARD =====

  function copySerialToClipboard(serial, buttonEl) {
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
        hint.textContent = '\u{29c9} copy';
        buttonEl.classList.remove('eve-copied', 'eve-copy-failed');
      }, 1500);
    }

    function fallbackCopy() {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = serial;
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
        devLog(`Serial ${serial} copied (fallback method).`);
      } catch (error) {
        showCopied(false);
        fail('Clipboard copy failed:', error);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(serial)
        .then(() => {
          showCopied(true);
          devLog(`Serial ${serial} copied to clipboard.`);
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
    return `\u{1f552} ${relative} \u{b7} ${new Date(ts).toLocaleTimeString()}`;
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
    return Array.isArray(parsed) ? parsed : [];
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
    if (!record || !record.detailUrl || isDebugData(record)) {
      return false;
    }
    return record.phaseSource !== 'confirmed' || record.resultConfirmed !== true;
  }
  const RESULT_RETRY_MAX_ATTEMPTS = 8;

  function reconfirmRecord(record) {
    const attempts = Number(record.resultAttempts) || 0;
    if (attempts >= RESULT_RETRY_MAX_ATTEMPTS) {
      return false;
    }
    record.resultAttempts = attempts + 1;
    updateStoredAlert(record);
    confirmPhase(safeUrl(record.detailUrl), infoFromRecord(record), { live: false, force: true })
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
    alerts.forEach(record => renderAlertElement(record, false));
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
        pass: record.passFlag
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
    const container = getAlertContainer();
    const alert = document.createElement('div');
    const clickable = isCardClickable(record);
    applyCardState(alert, record);
    if (clickable) {
      alert.title = record.serial
        ? 'Click anywhere on this alert to open this serial in TestView'
        : 'Click anywhere on this alert to open Server Detail';
    }
    alert.dataset.alertId = record.id;
    alert.dataset.debug = isDebugData(record) ? '1' : '0';
    alert.dataset.search = `${record.serial || ''} ${record.location || ''}`;
    const ts = Number(record.ts) || 0;
    const phaseNote = buildPhaseNote(record);
    const serialBlock = record.serial
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
      alert.querySelector('.eve-alert-footer').appendChild(buildJiraButton(record.serial, record));
    }
    if (clickable) {
      alert.addEventListener('click', event => {
        if (
          event.target.closest('.eve-alert-serial') ||
          event.target.closest('.eve-alert-close') ||
          event.target.closest('.eve-alert-jira')
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
    if (serialButton && record.serial) {
      serialButton.addEventListener('click', () =>
        copySerialToClipboard(record.serial, serialButton)
      );
    }
    container.insertBefore(alert, container.firstChild);
    while (container.children.length > MAX_RENDERED_ALERTS) {
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
<button id="eve-alert-export"
title="Save real notifications to a .txt report">
\u{1f4be} TXT
</button>
<button id="eve-alert-export-csv"
title="Save real notifications to a .csv for Excel">
\u{1f4ca} CSV
</button>
<button id="eve-alert-dismiss-all"
title="Dismiss all alerts on screen">
\u{2715} All
</button>
</span>
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
    let dismissArmedTimer = null;
    const disarmDismissAll = () => {
      clearTimeout(dismissArmedTimer);
      dismissArmedTimer = null;
      dismissAll.classList.remove('eve-confirm');
      dismissAll.textContent = '\u{2715} All';
    };
    dismissAll.addEventListener('click', () => {
      if (!dismissArmedTimer) {
        dismissAll.classList.add('eve-confirm');
        dismissAll.textContent = '\u{2715} Sure?';
        dismissArmedTimer = setTimeout(disarmDismissAll, 3000);
        return;
      }
      disarmDismissAll();
      clearStoredAlerts();
      body.querySelectorAll('.eve-alert').forEach(node => node.remove());
      refreshAlertChrome();
      log(
        'All alerts dismissed and cleared from storage. ' + '(The exportable log is NOT affected.)'
      );
    });
    document.getElementById('eve-alert-export').addEventListener('click', () => exportLog('txt'));
    document
      .getElementById('eve-alert-export-csv')
      .addEventListener('click', () => exportLog('csv'));
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
      const rect = header.getBoundingClientRect();
      const margin = PANEL_MARGIN;
      return {
        margin,
        width: rect.width,
        height: rect.height,
        maxLeft: Math.max(margin, window.innerWidth - rect.width - margin),
        maxTop: Math.max(margin, window.innerHeight - rect.height - margin)
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
      const rect = header.getBoundingClientRect();
      const bounds = getHeaderViewportBounds();
      const snapDistance = PANEL_SNAP_DISTANCE;
      let left = rect.left;
      let top = rect.top;
      const nearLeft = rect.left <= bounds.margin + snapDistance;
      const nearRight = window.innerWidth - rect.right <= bounds.margin + snapDistance;
      const nearTop = rect.top <= bounds.margin + snapDistance;
      const nearBottom = window.innerHeight - rect.bottom <= bounds.margin + snapDistance;
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
      draggedEnough = false;
    }
    header.addEventListener('pointerdown', event => {
      if (
        event.target.closest('button') ||
        event.target.closest('input') ||
        event.target.closest('a') ||
        event.target.closest('#eve-alert-toggle')
      ) {
        return;
      }
      const rect = header.getBoundingClientRect();
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
      const rect = header.getBoundingClientRect();
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
      if (matchesDebugVisibility) {
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
          collapseButton.title = 'Expand EVE SLT Tracker';
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
    collapseButton.title = 'Collapse EVE SLT Tracker';
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
      collapseButton.title = collapsed ? 'Expand EVE SLT Tracker' : 'Collapse EVE SLT Tracker';
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
<div class="eve-title-name">EVE SLT Tracker</div>
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
<div id="eve-sleep-banner" class="eve-sleep-banner" role="status" hidden>
<span class="eve-sleep-icon" aria-hidden="true">\u{23f0}</span>
<div class="eve-sleep-text">
<div class="eve-sleep-title"></div>
<div class="eve-sleep-when"></div>
<div class="eve-sleep-how"></div>
</div>
<div class="eve-sleep-actions">
<button type="button" class="eve-sleep-close" title="Dismiss" aria-label="Dismiss">\u{d7}</button>
<button type="button" class="eve-sleep-copy" title="Copy this site's address to paste into the browser setting">Copy site</button>
</div>
</div>
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
title="The alert log and TXT/CSV exports cover one occurrence of this shift, plus ${SHIFT_EARLY_MIN} min before and ${SHIFT_LATE_MIN} min after. The previous shift's log is cleared when the next one starts - export before then.">
${Object.keys(SHIFTS)
  .map(
    id =>
      `<option value="${id}">${SHIFTS[id].label} \u{b7} ` +
      `${shiftClock(SHIFTS[id].start)} \u{2013} ` +
      `${shiftClock(SHIFTS[id].end)}</option>`
  )
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
Card Jira buttons open the most recently updated
ticket for the serial, using this browser's Jira
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
    bindSetting('eve-log-shift', 'logShift', {
      coerce: raw => (SHIFTS[raw] ? raw : currentShiftId()),
      writeBack: true,
      after: onLogShiftChanged
    });
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
.eve-sleep-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid rgba(245, 158, 11, .45);
  background: rgba(245, 158, 11, .1);
  font-size: 12px;
  line-height: 1.4;
}
.eve-sleep-banner[hidden] { display: none; }
.eve-sleep-icon { flex: 0 0 auto; font-size: 16px; line-height: 1.2; }
.eve-sleep-text { flex: 1 1 auto; min-width: 0; }
.eve-sleep-title { font-weight: 700; color: #fcd34d; }
.eve-sleep-when { color: var(--eve-muted); }
.eve-sleep-how { margin-top: 3px; color: var(--eve-text); }
.eve-sleep-actions { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.eve-sleep-close {
  padding: 0;
  border: 0;
  background: transparent;
  color: #fcd34d;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.eve-sleep-copy {
  padding: 3px 8px;
  border: 1px solid rgba(245, 158, 11, .5);
  border-radius: 6px;
  background: rgba(245, 158, 11, .15);
  color: #fde68a;
  font-family: var(--eve-font);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.eve-sleep-copy:hover { background: rgba(245, 158, 11, .28); }
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
#eve-alert-toggle { cursor: pointer; user-select: none; flex: 1; }
#eve-alert-caret { display: inline-block; width: 14px; }
#eve-alert-count { color: var(--eve-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
#eve-alert-header-actions { display: flex; gap: 6px; }
#eve-alert-header-actions button {
  background: var(--eve-control);
  color: var(--eve-text);
  border: 1px solid var(--eve-line-strong);
  border-radius: 7px;
  padding: 4px 9px;
  font-family: var(--eve-font);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .12s;
}
#eve-alert-header-actions button:hover { background: var(--eve-control-hover); }
#eve-alert-header-actions button.eve-confirm { background: #b91c1c; border-color: #ef4444; color: #fff; }
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
.eve-alert.eve-alert-aged {
  filter: brightness(.6) saturate(.55);
  transition: filter .25s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.eve-alert.eve-alert-aged:hover { filter: none; }
@media (prefers-reduced-motion: reduce) { .eve-alert.eve-alert-aged { transition: none; }
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
`;
    document.head.appendChild(style);
  }

  // ===== INITIALIZE =====

  function initialize() {
    try {
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
        restartAutoRefresh();
        scan();
      });
      window.addEventListener('pagehide', () => {
        persistBeforeUnload(false);
      });
      log(
        `EVE SLT Tracker v${SCRIPT_VERSION} running\n` +
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
        `EVE SLT Tracker v${SCRIPT_VERSION} FAILED TO START. ` +
        'This page is NOT being monitored. ' +
        `Error: ${error && error.message ? error.message : error}`;
      document.body.appendChild(banner);
    } catch (bannerError) {}
  }

  // ===== KEEP AWAKE + SLEEP DETECTION =====
  const HEARTBEAT_EVERY_TICKS = 5;
  const SLEEP_GAP_MS = 120000;
  const SLEEP_BANNER_MIN_MS = 30000;
  const SLEEP_TOAST_MIN_MS = 60000;
  const SLEEP_TOAST_INTERVAL_MS = 600000;
  const keepAwake = {
    lock: 'not tried',
    ticker: 'not started'
  };
  let lastTickAt = 0;
  let frozenAt = 0;
  let sleepCount = 0;
  let lastSleep = null;
  let lastSleepToastAt = 0;

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

  function sleepFixPath() {
    return /Edg\//.test(navigator.userAgent)
      ? 'Edge Settings \u{203a} System and performance \u{203a} Performance'
      : 'Chrome Settings \u{203a} Performance';
  }

  function noteWake(kind, fromTs, toTs, refresh) {
    const sleptMs = fromTs ? Math.max(0, toTs - fromTs) : 0;
    sleepCount += 1;
    lastSleep = { kind: kind, from: fromTs, to: toTs };
    warn(
      `Tab was ${kind === 'discarded' ? 'put to sleep and unloaded' : 'asleep'}` +
        (sleptMs ? ` for ${formatSleep(sleptMs)}` : '') +
        ' - nothing was tracked meanwhile. Catching up now. Keep this ' +
        `site awake: ${sleepFixPath()} \u{203a} "Always keep these sites active".`
    );
    if (refresh) {
      refreshNow();
    }
    if (!sleptMs ? kind === 'discarded' : sleptMs >= SLEEP_BANNER_MIN_MS) {
      showSleepBanner(sleptMs, fromTs, toTs);
    }
    if (sleptMs >= SLEEP_TOAST_MIN_MS && Date.now() - lastSleepToastAt > SLEEP_TOAST_INTERVAL_MS) {
      lastSleepToastAt = Date.now();
      sendDesktopNotification(
        'EVE TRACKER WAS ASLEEP \u{23f0}',
        `The EVE tab was asleep for ${formatSleep(sleptMs)} - results ` +
          'from that time were caught up late.\n' +
          'Keep it awake: add this site to "Always keep these sites active".',
        ICON_FAIL,
        null
      );
    }
    renderKeepAwakeStatus();
  }

  function showSleepBanner(sleptMs, fromTs, toTs) {
    const banner = document.getElementById('eve-sleep-banner');
    if (!banner) {
      return;
    }
    const time = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    banner.querySelector('.eve-sleep-title').textContent = sleptMs
      ? `Tab was asleep ${formatSleep(sleptMs)}`
      : 'Tab was put to sleep by the browser';
    banner.querySelector('.eve-sleep-when').textContent = sleptMs
      ? `${time(fromTs)} \u{2013} ${time(toTs)} \u{b7} caught up on wake`
      : 'Caught up on wake';
    banner.querySelector('.eve-sleep-how').textContent =
      `Stop it: ${sleepFixPath()} \u{203a} Always keep these sites active \u{203a} Add`;
    banner.hidden = false;
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
      `Keep-awake: lock ${keepAwake.lock} \u{2022} tick ${keepAwake.ticker} ` +
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
    const banner = document.getElementById('eve-sleep-banner');
    if (banner) {
      banner.querySelector('.eve-sleep-close').addEventListener('click', () => {
        banner.hidden = true;
      });
      banner.querySelector('.eve-sleep-copy').addEventListener('click', event => {
        const button = event.currentTarget;
        const site = location.origin;
        const done = ok => {
          button.textContent = ok ? '\u{2713} Copied' : site;
          setTimeout(() => {
            button.textContent = 'Copy site';
          }, 2000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(site).then(
            () => done(true),
            () => done(false)
          );
        } else {
          done(false);
        }
      });
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

  function startMasterTick() {
    const SCAN_TICKS = 4;
    const RELATIVE_TICKS = 15;
    const WATCHDOG_TICKS = 10;
    const RECONFIRM_TICKS = 45;
    const LOG_SHIFT_TICKS = 60;
    let tick = 0;
    startTicker(() => {
      const now = Date.now();
      if (lastTickAt && now - lastTickAt > SLEEP_GAP_MS && !frozenAt) {
        noteWake('paused', lastTickAt, now, true);
      }
      lastTickAt = now;
      if (autoRefreshTimer && autoRefreshDueAt && now > autoRefreshDueAt + 2000) {
        fireAutoRefresh();
      }
      tick += 1;
      updateRefreshCountdown();
      if (tick % HEARTBEAT_EVERY_TICKS === 0) {
        writeHeartbeat(now);
      }
      if (tick % SCAN_TICKS === 0) {
        scan();
      }
      if (tick % RELATIVE_TICKS === 0) {
        refreshRelativeTimes();
      }
      if (tick % WATCHDOG_TICKS === 0) {
        autoRefreshWatchdog();
      }
      if (tick % RECONFIRM_TICKS === 0) {
        retryPendingConfirmations();
      }
      if (tick % LOG_SHIFT_TICKS === 0) {
        checkLogShiftRollover();
      }
    });
  }

  // ===== BOOTSTRAP =====

  function bootstrap() {
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
    const start = () => {
      if (earlyObserver) {
        earlyObserver.disconnect();
        earlyObserver = null;
      }
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
