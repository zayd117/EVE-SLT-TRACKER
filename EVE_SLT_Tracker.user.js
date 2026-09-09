// ==UserScript==
// @name         EVE SLT Tracker
// @namespace    https://github.com/zayd117/EVE-SLT-TRACKER
// @version      0.9.2
// @description  Monitors an EVE SLT rack page for server test-result colour changes and raises in-page + desktop alerts.
// @author       Zay Davidson
// @homepageURL  https://github.com/zayd117/EVE-SLT-TRACKER
// @supportURL   https://github.com/zayd117/EVE-SLT-TRACKER/issues
// @match        *://*/out/out.eveslt.php*
// @run-at       document-start
// @noframes
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_info
// @updateURL    https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_Tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_Tracker.user.js
// ==/UserScript==

// ================================================================
// DISTRIBUTION NOTES
// ================================================================
//
// @updateURL / @downloadURL are what make auto-update work.
// Tampermonkey polls that raw URL and offers users an update
// whenever @version here is GREATER than the version they have
// installed. Never edit this file without bumping @version, or the
// change ships to nobody and nothing tells you so.
//
// Release with:  ./scripts/release.sh patch "what changed"
//
// @match is deliberately host-agnostic so this file can live in a
// public repo without naming an internal hostname. If you fork it
// privately, narrow it to the real host.
//
// ================================================================

(function () {
    'use strict';

    // ============================================================
    // EVE SLT TRACKER
    // by Zay Davidson
    // ============================================================
    //
    //  Zay Davidson
    //
    //  >> FOUND A BUG? OPEN AN ISSUE:
    //     https://github.com/zayd117/EVE-SLT-TRACKER/issues <<
    //
    //     When reporting a bug please include: the script version
    //     (shown in the console banner on load), what you expected,
    //     what actually happened, and any red text from the browser
    //     console (F12 -> Console). Every log line the tracker
    //     prints is prefixed with "[EVE Tracker]".
    //
    // ============================================================
    // WHAT THIS SCRIPT DOES
    // ============================================================
    //
    // Watches the EVE SLT rack page for server cells changing
    // color, and raises an alert when a color change represents a
    // real test result. Only these three transitions are tracked;
    // everything else is deliberately ignored:
    //
    // \u{1f537} Light Blue  -> \u{1f534} Red          PRE-TEST FAIL \u{274c}
    // \u{1f7e2} Light Green -> \u{1f534} Red          TEST FAIL \u{274c}
    // \u{1f7e2} Light Green -> \u{1f7e2} Dark Green   TEST PASS \u{2705}
    //
    // Each alert appears in two places:
    //   1. An in-page card in the Alerts menu (click the serial to
    //      copy it). These survive page refreshes.
    //   2. A Windows desktop toast via GM_notification.
    //
    // Real (non-test) alerts are also written to a permanent log
    // that can be saved to .txt or .csv from the Alerts menu.
    //
    // ============================================================
    // HOW STATE SURVIVES THE AUTO-REFRESH
    // ============================================================
    //
    //   sessionStorage  previousStates  last known color/serial/phase
    //                                   of every rack slot
    //   sessionStorage  activeAlerts    undismissed alert cards
    //   sessionStorage  recentAlerts    flap-protection cooldowns
    //   localStorage    alertLog        permanent audit log
    //
    // ============================================================
    // v0.9.1 CHANGE LOG
    // ============================================================
    //
    // TIER 1 - silent monitoring failures
    //   * Soft refresh could permanently kill auto-refresh. The
    //     early "already in flight" return skipped the callback that
    //     reschedules the timer, and there was no fetch timeout, so a
    //     hung request pinned softRefreshInFlight for the life of the
    //     tab. Now: AbortController with a hard 15s cap, the
    //     reschedule callback runs on EVERY exit path, and a watchdog
    //     force-restarts auto refresh if it goes overdue.
    //   * "Notifs" off no longer stops audit logging. Recording and
    //     surfacing are now separate steps; the per-section watch
    //     flag suppresses the card and toast only. The exported log
    //     is a complete record again.
    //   * The test-phase hint can no longer CREATE an alert, only
    //     re-label an already-tracked TEST_FAILURE as a pre-test
    //     fail. Previously any "X -> red" fired when the hint said
    //     pretest, including transitions the spec ignores.
    //   * The phase hint no longer reads cell text/class/id. On a
    //     page called Server Level Test the word "test" is
    //     everywhere. It now reads only explicit data- attributes.
    //   * Flap protection keys on the SERIAL as well as the slot, so
    //     a replacement server that genuinely fails the same way
    //     inside the cooldown is no longer suppressed. The cooldown
    //     map is persisted, so a hard reload cannot re-arm it.
    //   * @run-at document-start, so the page's own meta refresh is
    //     stripped before the browser commits it.
    //
    // TIER 2 - performance
    //   * scan() and applyVisibility() were O(headers x rows) - eight
    //     EVE columns in one table meant eight full row walks. Both
    //     now group headers by table and walk each table's rows once.
    //   * normalizeColor() checks the legacy bgcolor attribute before
    //     falling back to getComputedStyle(), which forces a style
    //     recalc per cell per scan.
    //   * The phase hint is cached on the cell node.
    //   * Header lookups are cached and invalidated on real DOM
    //     change, instead of being recomputed three times per cycle.
    //   * The alert log is held in memory and written debounced,
    //     instead of a full parse/stringify of up to 2000 entries on
    //     every single alert.
    //   * The MutationObserver is suppressed around the tracker's own
    //     writes, and now inspects addedNodes/removedNodes rather
    //     than only mutation.target - appending the alert container,
    //     the download link and the copy textarea each used to
    //     trigger a full re-scan.
    //   * buildSectionControls() diffs the section set instead of
    //     rebuilding every checkbox on every mutation tick.
    //
    // TIER 3 - operational
    //   * One version string, sourced from GM_info.
    //   * @noframes, @run-at, @updateURL/@downloadURL placeholders.
    //   * Debug snapshot/compare only run in Developer Mode.
    //   * Repeated soft-refresh failures disable it for THIS SESSION
    //     only, instead of writing the disable to localStorage
    //     permanently.
    //
    // TIER 4 - contained bugs
    //   * Dismissing a card re-applies the active filter.
    //   * Debug/test cards are evicted before real ones when the
    //     stored-alert cap is hit.
    //   * Toast clicks use GM_openInTab (window.open from a
    //     notification callback is not a user gesture and gets
    //     popup-blocked).
    //   * The console diagnostic is exposed on unsafeWindow so it is
    //     actually reachable from F12.
    //   * typeof guard on GM_info (the old guard threw a
    //     ReferenceError inside an error handler).
    //   * detailUrl is protocol-checked before being opened; ts is
    //     coerced with Number() before being interpolated.
    //   * CSV date/time columns are derived from the ISO timestamp so
    //     they sort correctly in Excel on any machine.
    //   * Clear-log confirm counts the same entries the exports do.
    //   * The serial copy button is only rendered when there is a
    //     serial to copy.
    //
    // TIER 5 - cleanup
    //   * Removed getNotificationContent() and updateRefreshStatus()
    //     (pure indirection). Merged the two debug-detection helpers.
    //   * padOrTrim() keeps log tables aligned. Table rule width is
    //     derived, not a magic 68.
    //   * The full chronological dump is capped so the .txt does not
    //     print every entry twice at high volume.
    //   * Panel dragging uses Pointer Events (works on touch, and the
    //     move/up listeners only exist during a drag).
    //   * initialize() has an error boundary.
    //
    // NOT INCLUDED (deliberate - these are new features, not fixes):
    //   dwell-time tracking, stuck-server detection, serial history,
    //   shift-boundary reports, failure-rate thresholds.
    //
    // ============================================================
    // IMPORTANT:
    // Company credentials are NOT stored in this script.
    // The tracker uses your already-authenticated EVE browser session.
    // ============================================================


    // ============================================================
    // VERSION - single source of truth
    // ============================================================

    const SCRIPT_VERSION =
        (
            typeof GM_info !== 'undefined' &&
            GM_info &&
            GM_info.script &&
            GM_info.script.version
        )
            ? GM_info.script.version
            : '0.9.1';

    const LOG_PREFIX = '[EVE Tracker]';


    // ============================================================
    // STORAGE KEYS
    // ============================================================

    const SETTINGS_KEY        = 'eveRackTrackerSettings';
    const PREV_STATES_KEY     = 'eveRackTrackerPreviousStates';
    const ACTIVE_ALERTS_KEY   = 'eveRackTrackerActiveAlerts';
    const RECENT_ALERTS_KEY   = 'eveRackTrackerRecentAlerts';
    const ALERT_LOG_KEY       = 'eveRackTrackerAlertLog';
    const ALERTS_COLLAPSED_KEY = 'eveRackTrackerAlertsCollapsed';
    const PANEL_POSITION_KEY  = 'eveRackTrackerPanelPosition';
    const MENU_STATE_KEY      = 'eveRackTrackerMenuState';
    const DEBUG_SNAPSHOT_KEY  = 'eveRackTrackerDebugSnapshot';


    // ============================================================
    // TUNABLES
    // ============================================================

    const MAX_LOG_ENTRIES           = 2000;
    const MAX_STORED_ALERTS         = 50;
    const ALERT_COOLDOWN_MS         = 60000;
    const MAX_RECENT_ALERT_KEYS     = 500;
    const SOFT_REFRESH_TIMEOUT_MS   = 15000;
    const MAX_SOFT_REFRESH_FAILURES = 3;
    const LOG_WRITE_DEBOUNCE_MS     = 2000;
    const OBSERVER_DEBOUNCE_MS      = 250;

    // Above this many entries the .txt report omits the full
    // chronological dump, because every entry already appears once in
    // its category table and printing it twice doubles the file.
    const MAX_CHRONOLOGICAL_ENTRIES = 500;

    const EVE_HEADER_PATTERN = /^TA\.([^-]+)-EVE(\d+)/i;


    // ============================================================
    // SETTINGS
    // ============================================================

    const defaultSettings = {

        // Per-section flags, keyed by section name (A7, B2, ...).
        // { show, watch }. There is no global show/watch flag.
        //
        // NOTE: "watch" controls whether an alert is SURFACED (card +
        // desktop toast). It does not control whether the transition
        // is recorded in the permanent audit log - that always
        // happens, so the log can never develop silent holes.
        sections: {},

        autoRefresh: true,

        // true  = re-fetch the page and swap content in place.
        // false = classic full location.reload().
        softRefresh: true,

        refreshIntervalSeconds: 60,

        // 0 = desktop toast never auto-closes.
        notificationTimeoutSeconds: 0,

        // DEBUG/test visibility modifier. Never suppresses real alerts.
        showDebug: true,

        // Gate for the developer page, the debug snapshot/compare
        // machinery, and the diagnostic tools.
        developerMode: false

    };


    // ============================================================
    // RUNTIME STATE
    // ============================================================

    let settings         = null;   // loaded in initialize()
    let previousStates   = new Map();
    let recentAlerts     = new Map();

    let scanTimer        = null;
    let autoRefreshTimer = null;
    let autoRefreshDueAt = null;

    let softRefreshInFlight = false;
    let softRefreshFailures = 0;

    // Session-only. Repeated failures must NOT write a permanent
    // disable into localStorage - the user would never get soft
    // refresh back without knowing to re-tick the box.
    let softRefreshDisabledForSession = false;

    let pageObserver = null;
    let observerSuppressDepth = 0;

    let alertFilter = 'all';
    let alertSearch = '';

    const sessionCounts = {
        TEST_SUCCESS: 0,
        TEST_FAILURE: 0,
        PRETEST_FAILURE: 0
    };


    function log(...args)  { console.log(LOG_PREFIX, ...args); }
    function warn(...args) { console.warn(LOG_PREFIX, ...args); }
    function fail(...args) { console.error(LOG_PREFIX, ...args); }

    // Developer-only logging. Keeps production consoles readable.
    function devLog(...args) {
        if (settings && settings.developerMode) {
            console.log(LOG_PREFIX + '[DEV]', ...args);
        }
    }


    function softRefreshEnabled() {
        return settings.softRefresh && !softRefreshDisabledForSession;
    }


    // ------------------------------------------------------------
    // Only http(s) URLs are ever opened. detailUrl round-trips
    // through sessionStorage, which the page's own scripts can write,
    // so a "javascript:" value would otherwise execute on click.
    // ------------------------------------------------------------

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


    // Toast callbacks are NOT a user gesture, so window.open() from
    // one gets popup-blocked. GM_openInTab is the privileged path.

    function openFromNotification(url) {

        const target = safeUrl(url);

        if (!target) {
            return;
        }

        if (typeof GM_openInTab === 'function') {
            GM_openInTab(target, { active: true, insert: true });
            return;
        }

        // Best effort. May be blocked - hence the grant above.
        window.open(target, '_blank', 'noopener,noreferrer');

    }


    // ============================================================
    // LOAD / SAVE SETTINGS
    // ============================================================

    function loadSettings() {

        try {

            const saved = localStorage.getItem(SETTINGS_KEY);

            if (saved) {

                const parsed = JSON.parse(saved);

                // Migrate the old global visibility flag.
                if (
                    typeof parsed.showDebug !== 'boolean' &&
                    typeof parsed.hideTestResults === 'boolean'
                ) {
                    parsed.showDebug = !parsed.hideTestResults;
                }

                delete parsed.hideTestResults;

                if (typeof parsed.developerMode !== 'boolean') {
                    parsed.developerMode = defaultSettings.developerMode;
                }

                const merged = { ...defaultSettings, ...parsed };

                // Shallow spread would replace this wholesale; make
                // sure it is always a usable object.
                if (
                    !merged.sections ||
                    typeof merged.sections !== 'object'
                ) {
                    merged.sections = {};
                }

                return merged;

            }

        } catch (error) {
            warn('Settings load error:', error);
        }

        return { ...defaultSettings, sections: {} };

    }


    function saveSettings() {

        try {
            localStorage.setItem(
                SETTINGS_KEY,
                JSON.stringify(settings)
            );
        } catch (error) {
            warn('Settings save error:', error);
        }

    }


    function getSectionSettings(section) {

        if (!settings.sections[section]) {

            settings.sections[section] = { show: true, watch: true };

            // Persist immediately. Previously a newly-discovered
            // section lived only in memory until some unrelated
            // action happened to save, so storage and runtime drifted.
            saveSettings();

        }

        return settings.sections[section];

    }


    // ============================================================
    // BASELINE STATE (previousStates)
    // ============================================================

    function loadPreviousStates() {

        try {

            const saved = sessionStorage.getItem(PREV_STATES_KEY);

            if (saved) {
                return new Map(Object.entries(JSON.parse(saved)));
            }

        } catch (error) {
            warn('Previous state load error:', error);
        }

        return new Map();

    }


    function savePreviousStates() {

        try {
            sessionStorage.setItem(
                PREV_STATES_KEY,
                JSON.stringify(Object.fromEntries(previousStates))
            );
        } catch (error) {
            warn('Previous state save error:', error);
        }

    }


    // ============================================================
    // OUR OWN UI ELEMENTS
    // ============================================================
    //
    // Everything the tracker injects lives under one of these IDs.
    // Used by the MutationObserver (to ignore self-inflicted
    // mutations) and by the soft refresh (to know what must survive).
    // ============================================================

    const OWN_UI_IDS = [
        'eve-tracker-panel',
        'eve-alert-container'
    ];


    function isOwnUiNode(node) {

        const element =
            (node && node.nodeType === 1)
                ? node
                : (node ? node.parentElement : null);

        if (!element || !element.closest) {
            return false;
        }

        return OWN_UI_IDS.some(id => element.closest('#' + id));

    }


    // ============================================================
    // OBSERVER SUPPRESSION
    // ============================================================
    //
    // applyVisibility() writes style.display on PAGE cells, which the
    // observer watches. Previously that re-triggered the observer,
    // which called applyVisibility() again; the loop only settled
    // because the values happened to stabilise. Wrapping the tracker's
    // own page writes makes that structural instead of accidental.
    // ============================================================

    function withoutObserver(fn) {

        observerSuppressDepth += 1;

        try {
            return fn();
        } finally {

            // Discard anything queued by our own writes. takeRecords()
            // is synchronous, so this runs before the observer's
            // microtask would have fired.
            if (pageObserver) {
                pageObserver.takeRecords();
            }

            observerSuppressDepth -= 1;

        }

    }


    // ============================================================
    // EVE TABLE / HEADER DISCOVERY  (cached)
    // ============================================================
    //
    // Returns one entry per TABLE, each carrying the EVE headers it
    // contains. scan() and applyVisibility() can then walk a table's
    // rows ONCE and loop the header columns inside, instead of
    // re-walking every row once per header - eight EVE columns in one
    // table previously meant eight full row walks.
    //
    // The result is cached and invalidated whenever the page actually
    // changes, so a cycle no longer runs querySelectorAll('th') three
    // times over.
    // ============================================================

    let cachedGroups = null;


    function invalidateHeaderCache() {
        cachedGroups = null;
    }


    function getEveTableGroups(root) {

        const scanRoot = root || document;

        if (!root && cachedGroups) {
            return cachedGroups;
        }

        const byTable = new Map();

        scanRoot.querySelectorAll('th').forEach(th => {

            const match =
                th.textContent.trim().match(EVE_HEADER_PATTERN);

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

        const groups = [...byTable.values()];

        if (!root) {
            cachedGroups = groups;
        }

        return groups;

    }


    // Flat header list, for the places that genuinely want every
    // header regardless of which table it sits in.

    function getEveHeaders(root) {

        const headers = [];

        getEveTableGroups(root).forEach(group => {
            group.headers.forEach(header => headers.push(header));
        });

        return headers;

    }


    // ============================================================
    // META REFRESH
    // ============================================================
    //
    // A <meta http-equiv="refresh"> makes the browser navigate on the
    // SERVER's schedule, which resets the tracker and races the soft
    // refresh. Chromium commits it at PARSE time, so removing the node
    // from DOMContentLoaded is too late - hence @run-at document-start
    // plus the early observer in bootstrap() at the bottom of the file.
    // ============================================================

    function stripMetaRefresh(root) {

        let removed = 0;

        root.querySelectorAll('meta[http-equiv]').forEach(meta => {

            if (
                (meta.getAttribute('http-equiv') || '')
                    .toLowerCase() === 'refresh'
            ) {
                meta.remove();
                removed += 1;
            }

        });

        return removed;

    }


    // ============================================================
    // AUTO REFRESH
    // ============================================================

    function startAutoRefresh() {

        if (
            !settings.autoRefresh ||
            !settings.refreshIntervalSeconds ||
            settings.refreshIntervalSeconds <= 0
        ) {

            log('Auto refresh: OFF');

            autoRefreshDueAt = null;

            updateRefreshCountdown();

            return;

        }

        const seconds = Number(settings.refreshIntervalSeconds);

        log(`Auto refresh: ON (${seconds}s)`);

        autoRefreshDueAt = Date.now() + (seconds * 1000);

        updateRefreshCountdown();

        autoRefreshTimer = setTimeout(() => {

            autoRefreshTimer = null;

            if (softRefreshEnabled()) {

                // performSoftRefresh() guarantees the callback runs on
                // every exit path, including the early "already in
                // flight" return. Nothing here reschedules on its own,
                // so a missed callback used to kill auto refresh for
                // the life of the tab.
                performSoftRefresh(restartAutoRefresh);

            } else {

                savePreviousStates();

                debugSnapshotBeforeRefresh('auto-refresh');

                flushAlertLog();

                location.reload();

            }

        }, seconds * 1000);

    }


    function restartAutoRefresh() {

        if (autoRefreshTimer) {
            clearTimeout(autoRefreshTimer);
            autoRefreshTimer = null;
        }

        autoRefreshDueAt = null;

        startAutoRefresh();

    }


    // ============================================================
    // AUTO REFRESH WATCHDOG
    // ============================================================
    //
    // Backstop for the whole refresh path. If the due time slides far
    // enough into the past that no plausible in-flight request could
    // still be running, something swallowed the reschedule - force it
    // back to life rather than sitting on stale data showing
    // "refreshing..." forever.
    // ============================================================

    function autoRefreshWatchdog() {

        if (!settings.autoRefresh || !autoRefreshDueAt) {
            return;
        }

        const overdueMs = Date.now() - autoRefreshDueAt;

        const graceMs =
            Math.max(
                30000,
                Number(settings.refreshIntervalSeconds || 60) * 1000
            ) + SOFT_REFRESH_TIMEOUT_MS;

        if (overdueMs <= graceMs) {
            return;
        }

        warn(
            `WATCHDOG: auto refresh is ${Math.round(overdueMs / 1000)}s ` +
            'overdue. Clearing the in-flight flag and rescheduling. If ' +
            'this repeats, the network path to the page is the problem.'
        );

        softRefreshInFlight = false;

        restartAutoRefresh();

    }


    // ============================================================
    // LIVE REFRESH COUNTDOWN
    // ============================================================

    function updateRefreshCountdown() {

        const badge  = document.getElementById('eve-refresh-badge');
        const status = document.getElementById('eve-refresh-status');

        if (!badge && !status) {
            return;
        }

        if (!settings.autoRefresh || !autoRefreshDueAt) {

            if (badge) {
                badge.textContent = 'OFF';
                badge.className = 'eve-summary-badge eve-badge-off';
            }

            if (status) {
                status.textContent = 'OFF';
            }

            return;

        }

        const remaining =
            Math.max(
                0,
                Math.ceil((autoRefreshDueAt - Date.now()) / 1000)
            );

        const label =
            remaining >= 60
                ? `${Math.floor(remaining / 60)}m ` +
                  `${String(remaining % 60).padStart(2, '0')}s`
                : `${remaining}s`;

        if (badge) {

            badge.textContent =
                remaining > 0
                    ? `ON \u{b7} ${label}`
                    : 'refreshing\u{2026}';

            badge.className =
                'eve-summary-badge ' +
                (remaining <= 5 ? 'eve-badge-soon' : 'eve-badge-on');

        }

        if (status) {

            status.textContent =
                remaining > 0
                    ? `ON \u{2022} Every ${settings.refreshIntervalSeconds}s \u{2022} ` +
                      `next refresh in ${label}`
                    : 'Refreshing now\u{2026}';

        }

    }


    // ============================================================
    // SOFT REFRESH
    // ============================================================
    //
    // Re-fetches the SAME url in the background and swaps in only the
    // page's own tables, leaving every tracker widget untouched:
    // panel position and collapse states survive, alert cards are
    // never rebuilt, previousStates stays live in memory, no flash.
    //
    // If anything looks wrong (network error, timeout, login redirect,
    // markup with no EVE headers) it falls back to a hard reload so
    // the tracker can never silently sit on stale data.
    //
    // CRITICAL CONTRACT: onDone() runs on EVERY exit path. It is the
    // only thing that reschedules the auto-refresh timer.
    // ============================================================

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

            // Still reschedule. Returning without this used to leave
            // the auto-refresh timer permanently unscheduled.
            warn(
                'Soft refresh skipped - one is already in flight. ' +
                'Rescheduling the next cycle anyway.'
            );

            finish();

            return;

        }

        softRefreshInFlight = true;

        // Snapshot first: if this ends in a hard-reload fallback the
        // state must already be persisted.
        savePreviousStates();

        const controller = new AbortController();

        // Without this a hung socket (VPN drop, stalled proxy) pins
        // softRefreshInFlight for the life of the tab.
        const abortTimer =
            setTimeout(
                () => controller.abort(),
                SOFT_REFRESH_TIMEOUT_MS
            );

        try {

            const response =
                await fetch(window.location.href, {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    redirect: 'follow',
                    signal: controller.signal
                });

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status} ${response.statusText}`
                );
            }

            // A redirect to a login/SSO page is the classic silent
            // failure: status 200, completely wrong content.
            if (
                response.redirected &&
                response.url.split('?')[0] !==
                    window.location.href.split('?')[0]
            ) {
                throw new Error(
                    `redirected to ${response.url} ` +
                    '(session likely expired)'
                );
            }

            const html = await response.text();

            const doc =
                new DOMParser().parseFromString(html, 'text/html');

            stripMetaRefresh(doc);

            const newGroups = getEveTableGroups(doc);

            // Sanity check: swapping in a login page would make the
            // tracker think every server vanished.
            if (!newGroups.length) {
                throw new Error(
                    'no EVE tables in fetched page (session expired, ' +
                    'or the table is rendered by page JavaScript ' +
                    'rather than the server)'
                );
            }

            const swapped =
                swapEveTables(newGroups.map(g => g.table), doc);

            softRefreshFailures = 0;

            log(
                `Soft refresh OK \u{2014} ${swapped} table(s) updated, ` +
                `${previousStates.size} states tracked. Panel position ` +
                'and alerts preserved.'
            );

            finish();

        } catch (error) {

            softRefreshFailures += 1;

            const reason =
                (error && error.name === 'AbortError')
                    ? `timed out after ${SOFT_REFRESH_TIMEOUT_MS / 1000}s`
                    : (error && error.message ? error.message : error);

            warn(
                'Soft refresh failed ' +
                `(${softRefreshFailures}/${MAX_SOFT_REFRESH_FAILURES}):`,
                reason
            );

            if (softRefreshFailures >= MAX_SOFT_REFRESH_FAILURES) {

                // SESSION ONLY. The old build called saveSettings()
                // here, which wrote the disable to localStorage and
                // meant the user silently never got soft refresh back.
                softRefreshDisabledForSession = true;

                warn(
                    'Soft refresh disabled for THIS SESSION after ' +
                    'repeated failures - using full page reloads. It ' +
                    'is re-enabled automatically the next time the tab ' +
                    'is opened; your saved setting is unchanged.'
                );

            }

            debugSnapshotBeforeRefresh('soft-refresh-fallback');

            flushAlertLog();

            finish();

            location.reload();

        } finally {

            clearTimeout(abortTimer);

            softRefreshInFlight = false;

        }

    }


    // ------------------------------------------------------------
    // Replace ONLY the EVE tables. Cheaper than swapping the whole
    // body, preserves scroll position, and cannot disturb anything the
    // tracker injected. Falls back to swapping the page-owned body
    // children if the table count no longer matches.
    // ------------------------------------------------------------

    function swapEveTables(newTables, doc) {

        if (pageObserver) {
            pageObserver.disconnect();
        }

        // The live cache is about to be invalidated by the swap.
        invalidateHeaderCache();

        const liveTables = getEveTableGroups().map(g => g.table);

        let swapped = 0;

        if (
            liveTables.length &&
            liveTables.length === newTables.length
        ) {

            liveTables.forEach((liveTable, index) => {

                liveTable.replaceWith(
                    document.importNode(newTables[index], true)
                );

                swapped += 1;

            });

        } else {

            swapped =
                swapPageBody(
                    doc ||
                    (newTables[0] ? newTables[0].ownerDocument : null)
                );

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

            // Scripts imported this way never execute, so importing
            // them only bloats the DOM.
            if (node.tagName === 'SCRIPT') {
                return;
            }

            document.body.insertBefore(
                document.importNode(node, true),
                firstOwn
            );

            inserted += 1;

        });

        return inserted;

    }


    // Reconnect the observer and run the pipeline it would have run.
    // Headers are resolved ONCE here and handed to all three
    // consumers, instead of each recomputing them.

    function afterSwap() {

        observePage();

        const groups = getEveTableGroups();

        buildSectionControls(groups);

        applyVisibility(groups);

        scan(groups);

    }


    // ============================================================
    // PAGE MUTATION OBSERVER
    // ============================================================

    function isRelevantMutation(mutation) {

        if (observerSuppressDepth > 0) {
            return false;
        }

        // childList mutations that add or remove tracker nodes report
        // mutation.target as document.body, which is NOT own UI. The
        // old target-only check therefore treated appending the alert
        // container, the export download link and the copy textarea as
        // real page changes and ran a full re-scan for each.
        if (mutation.type === 'childList') {

            const touched = [
                ...mutation.addedNodes,
                ...mutation.removedNodes
            ];

            if (
                touched.length &&
                touched.every(node => isOwnUiNode(node))
            ) {
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

                // The page changed for real, so any cached header
                // layout is suspect.
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


    // ============================================================
    // NOTIFICATION TIMEOUT (ms)
    // ============================================================
    //
    // GM_notification's "timeout" is the time in ms after which the
    // toast auto-closes. A literal 0 reads as "close after 0ms",
    // i.e. create and destroy in the same tick, which looks exactly
    // like "no toast appeared". The correct way to say "never
    // auto-close" is to OMIT the key entirely.
    // ============================================================

    function getNotificationTimeoutMs() {

        const seconds = Number(settings.notificationTimeoutSeconds);

        if (!seconds || seconds <= 0 || Number.isNaN(seconds)) {
            return 0;
        }

        return seconds * 1000;

    }


    // ============================================================
    // CENTRAL DESKTOP NOTIFICATION SENDER
    // ============================================================
    //
    // One payload builder for every call site.
    //
    //  * "timeout" is added ONLY when it is a real positive duration.
    //  * A unique "tag" per toast detaches its lifetime from the page,
    //    so an unread toast survives the auto-refresh and a new alert
    //    never silently replaces an older one.
    //  * If the embedded icon is rejected, the send is retried
    //    text-only rather than losing the alert entirely.
    // ============================================================

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
            silent: false
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

        // ondone fires when the toast closes for any reason. Closing
        // within a few ms means it was killed instantly rather than
        // shown - the signature of a zero/near-zero timeout.
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
                timeout:
                    timeoutMs > 0
                        ? `${timeoutMs}ms`
                        : 'omitted (never auto-close)',
                image: imageUrl ? 'included' : 'none'
            });

            return true;

        } catch (error) {

            fail(
                'GM_notification() threw with image included. Retrying ' +
                'as text-only:',
                error
            );

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
                    'Text-only fallback ALSO threw. The notification ' +
                    'system itself is unavailable:',
                    fallbackError
                );

                return false;

            }

        }

    }


    // ============================================================
    // NOTIFICATION ICONS (embedded, no external dependency)
    // ============================================================
    //
    //   FAIL / PRE-TEST FAIL -> solid red square, white X
    //   PASS                 -> solid green square, white check
    //
    // 256x256 PNG data URIs, so nothing needs hosting and they work
    // even with no outbound access from the intranet.
    // ============================================================

    const ICON_FAIL =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAEqElEQVR42u3dXW6TOxhG0S/vpDr/uzKq9A4hhEr/HXuvPQB0Yj/LFIkTbs+X1G0cgQCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQANB7errfAXBn6fUfeZ7jzvT2d+S88xx3pnf9LnrYeY4703t/hjzpPMed6QMndsx5jjvTx87qjPMcd6YPn9IB5znuTJ85n93Pc9yZPnkyW5/nuDN9/kz2Pc9xZ/qS09j0PMed6avOYcfzHHdm/Q/7qwHgznY6yR3Pc9xZ1sD3feqNznPcWdPAd3/eXc5z3FnQwM980i3Oc9xZzcBPfsbHP89xZykDP//pHvw8x511DKz6XI98nuPOIgbWfqKHPc9xZwUDyz/Lr9sNgP1O7QwD1r/xj0AMWH/9D8EMWH8aAAPWXwfAgPXXATBg/XUADFh/HQAD1l8HwID11wEwYP11AAxYfx0AA9ZfB8CA9dcBlA1YPwBdA9YPQNeA9QPQNWD9AHQNWD8AXQPWD0DXgPUD0DVg/QB0DVg/AF0D1g9A14D1A9A1YP0AdA1YPwBdA9YPQNeA9QPQNWD9AHQNWD8AXQPWD0DXgPUD0DVg/Qu7PV/1yv9SfHz99d8BLCC+fgDSO7B+ALprsH4AupuwfgC6y7B+ALr7sH4AuiuxfgC6W7F+ALqLsX4AuruxfgC667F+ALobsn4AukuyfgC6e7J+ALqrsn4AutuyfgC6C7N+ALo7s34AumuzfgC6m7N+ALrLs34AlvUI3ygR/1YLACyPAQDym2MAgPraGACgvjMGAKgvjAEA6ttiAID6qhgAoL4nBgCoL4kBAOobYgCA+noYAKC+GwYAqC+GAQDqW2EAgPpKGACgvg8GAKgvgwEA6ptgAID6GhgAoL4DBsb61/4HLP9Oh7iBsf7l62cAgPrbzwAA9Z98GACg/nM/AwDU/9TLAADd9TMAQH39DABQXz8DANTXzwAA9fUzAEB9/QwAUF8/AwDU188AAPX1MwBAff0MAFBfPwMA1NfPAAD19TMAQH39DABQXz8DAPhOBwbCAKyfgS4A62egC8D6GegCsH4GugCsn4EuAOtnoAvA+hnoArB+BroArJ+BLgDrZ6ALwPoZ6AKwfgbSAOJ/z4wBPwJ1/6ax1wSAZWd33vq9JhsDuGL/t6HXBIBl53j2+r0mGwO4At844jUBYNmZdtbvNdkYwHXotw56TQBYdr7N9XtNNgZwHfTN414TAJadtfV7TSZ7c9bvNbkO+GKsTf/9Oa8JAMtuzvq9JkcBuLb6N6i9JgAsuznr95ocC+C/92H9XpPDAbxyK9bvNUkA+OfdWL/XJATgrxuyfq9JDsDve7J+r8nr3Z7dsN7Q0/1+5GsCgNKNIxAAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASANKfvQD31x9TuxYslwAAAABJRU5ErkJggg==';

    const ICON_PASS =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAEZUlEQVR42u3c3ZHTShhFUcyTicPk6Ql08uCVACiq5key+uu9dgAwI53VslXce7s/Hz+kaj9dAgEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAAkAKT/9+ftHQCl17+rAQD00bN/SwO3+/PhNutTn3x+vf32BBAYAKi68m0MAKAv7nsPAwDo68vewAAA+tampxvwFkjHrHnoqyFPAB1zlg99FACgVQgBoPHbHWcAAB282lkGALD+9xF/5kl5C2T9J7b+qyFPAOtPfy0GwPrTBgBQ2gAAFpk2AID1pw14C2T9r26pV0OeANaffhQAYP3pHwYA609/CgJAvgPI8Z9cPwDWXw8A6+8e/wBYf3r9AFh/ev0AWH96/QAovX4AHP/1ALD+7vEPgPWn1w+A9afXD4D1p9cPgPWn1w+A0usHwPFfDwDr7x7/AFh/ev0AWH96/QBYf3r9AFh/ev0AqB4Ajv/u8Q+A9afXD4D1p9cPgPWn1w+A9afXD4D1p9cPgPXXA0Dd4x8Ax396/TsDGP35wfoBOGBAQw1YPwCHDWicAesH4Fvr+XdAgwx47QPAKesZMawFf8jtj/99ADg7rb8L4CPrX1yIj/4AnD6dZQ1YPwAvms6CBqz/2m7356P2oX+de2z9ngAX7GaR2fniDsBlu7l8fF56AnDxbhzA1j8MwOGTvcqAj/4AdA9s61+qAW+Bzl7MKxdg/Z4Ayy3mZaP0rQOA7jS99gFg6cWc+tdZPwADFtP5iGL9SwO4cIhn/NW++K7cWm+BFtnKgROxfk+AeVs56iexfgC6n7+99ARg8OG0xz84dfxP+gi0jQHrB8BzwFUFIGnAF18Admvuf3dv/SMBLHjbJv6fV6x/8BNgnAEvPQHoGvDaB4DuXbR+AEL3cv2POta/FYDFDfjiC0DXgPUD0M1rHwAcb64PAO6xKwOAO+2aAOB+uxoAuOuuAwDuvSsAgAUIAAb84gDI+gGwBr8vADbhNwXAMvyOANiHAGDArwaAoVg/AOZi/QDI+gGwG+sHwHqsHwAbEgBNA+gC0B2T9QPQnZT1A9AdlvUD0J2X9QMgAZA8ZR3/AHSnZv0AdAdn/QB0Z2f9AHTHZ/0AdA1YPwCeAwKAOgGQmqP1A9A1YP0AdA1YPwBdA9YPgOeAAEga4AqArgHrB6BrwPoBoEgA9OZr/QB0DVg/AJ4DAiBpgBkAugasH4CuAesHoGvA+gFgQwAYugBIGaACgK4B6wega8D6p3e7Px+ugjwBJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAEgEsgACQApF5/ASm83YWSRjGVAAAAAElFTkSuQmCC';


    function getTransitionIcon(transition) {

        if (transition === 'TEST_SUCCESS') {
            return ICON_PASS;
        }

        // TEST_FAILURE and PRETEST_FAILURE both use the red X.
        return ICON_FAIL;

    }


    // ============================================================
    // SHARED NOTIFICATION FORMAT
    // ============================================================
    //
    // ONE canonical format, used everywhere a notification is built:
    // the in-page card, the desktop toast, real transitions and debug
    // test buttons alike. No exceptions.
    //
    // Title:   TEST FAIL \u{274c} / TEST PASS \u{2705} / PRE-TEST FAIL \u{274c}
    //
    // Body:
    //   Serial #: XXXXX
    //   \u{1f4cd} Section \u{2022} EVE## \u{2022} U#
    //   Testing \u{1f7e2}. . . \u{25ba} Test FAIL \u{274c}
    // ============================================================

    function getStatusLine(transition) {

        if (transition === 'TEST_SUCCESS') {
            return 'Testing \u{1f7e2}. . . \u{25ba} Test PASS \u{2705}';
        }

        if (transition === 'TEST_FAILURE') {
            return 'Testing \u{1f7e2}. . . \u{25ba} Test FAIL \u{274c}';
        }

        if (transition === 'PRETEST_FAILURE') {
            return 'Pre-Testing \u{1f537}. . . \u{25ba} Pre-Test FAIL \u{274c}';
        }

        return '';

    }


    function getTransitionTitle(transition) {

        if (transition === 'TEST_SUCCESS') {
            return 'TEST PASS \u{2705}';
        }

        if (transition === 'TEST_FAILURE') {
            return 'TEST FAIL \u{274c}';
        }

        if (transition === 'PRETEST_FAILURE') {
            return 'PRE-TEST FAIL \u{274c}';
        }

        return '';

    }


    function buildNotificationBody(info, transition) {

        return [
            `Serial #: ${info.serial}`,
            `\u{1f4cd} ${info.section} \u{2022} ${info.eve} \u{2022} ${info.unit}`,
            getStatusLine(transition)
        ].join('\n');

    }


    // ============================================================
    // NOTIFICATION PERMISSION CHECK
    // ============================================================
    //
    // IMPORTANT: GM_notification does NOT use the page-level
    // Notification API. Notification.permission for THIS PAGE has no
    // bearing on whether a toast appears. What actually controls it:
    //
    //   1. Tampermonkey's own extension permissions
    //      (edge://extensions -> Tampermonkey).
    //   2. Edge's notification permission for the EXTENSION, not the
    //      eveslt.php site (edge://settings/content/notifications).
    //   3. Windows notification settings for Edge itself
    //      (Settings -> System -> Notifications), plus Focus Assist /
    //      Do Not Disturb, which swallow toasts with no error anywhere.
    // ============================================================

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
                `Page-level Notification.permission: ` +
                `${Notification.permission} (informational only).`
            );

        } catch (error) {
            warn('Page-level notification permission check failed:', error);
        }

    }


    // ============================================================
    // NOTIFICATION SELF-TEST
    // ============================================================
    //
    // Fires five toasts, each isolating ONE variable, ~2s apart.
    // Whichever ones appear tell you exactly what is broken.
    //
    //   1 BASELINE  plain ASCII, no image, no timeout, no tag
    //                -> if THIS fails, nothing about this script is at
    //                   fault: the extension or OS is blocking every
    //                   toast. Fix permissions, not code.
    //   2 TIMEOUT0  same as 1 but with a literal timeout: 0
    //   3 EMOJI     unicode title and body, no image
    //   4 IMAGE     baseline plus the embedded base64 icon
    //   5 FULL      exactly what a real alert sends
    // ============================================================

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
                typeof Notification !== 'undefined'
                    ? Notification.permission
                    : 'API unavailable',
            secureContext: window.isSecureContext,
            userAgent: navigator.userAgent
        });

        log(
            'Watch your desktop for the next ~10 seconds and note ' +
            'WHICH of the 5 toasts appear.'
        );

        const tests = [

            {
                n: 1,
                label: 'BASELINE (ascii, no image, no timeout, no tag)',
                run: () => GM_notification({
                    title: 'EVE Test 1 BASELINE',
                    text: 'Plain ASCII only. No image. No timeout.',
                    silent: false
                })
            },

            {
                n: 2,
                label: 'TIMEOUT ZERO',
                run: () => GM_notification({
                    title: 'EVE Test 2 TIMEOUT-0',
                    text: 'Same as test 1 but timeout is 0.',
                    timeout: 0,
                    silent: false
                })
            },

            {
                n: 3,
                label: 'EMOJI (unicode title and body, no image)',
                run: () => GM_notification({
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
                run: () => GM_notification({
                    title: 'EVE Test 4 IMAGE',
                    text: 'ASCII text plus the embedded PNG icon.',
                    image: ICON_FAIL,
                    silent: false
                })
            },

            {
                n: 5,
                label: 'FULL (identical to a real live alert)',
                run: () => sendDesktopNotification(
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

        setTimeout(() => {

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

        }, tests.length * 2000 + 1000);

    }


    // Expose on unsafeWindow. With "@grant" set, the script runs in a
    // sandbox, so a plain window.x assignment is NOT reachable from
    // the F12 console - which is exactly where this is meant to be run.

    try {

        const consoleTarget =
            (typeof unsafeWindow !== 'undefined')
                ? unsafeWindow
                : window;

        consoleTarget.eveNotifyDiagnostic = runNotificationDiagnostic;

    } catch (error) {
        warn('Could not expose the diagnostic on window:', error);
    }


    // ============================================================
    // NORMALIZE COLOR
    // ============================================================
    //
    // Order matters for cost. Inline style is free. The legacy
    // bgcolor attribute is free and is what old PHP pages actually
    // emit. getComputedStyle() forces a style recalc, so it is the
    // last resort - previously it ran for every cell on every scan
    // whenever no inline style was present.
    // ============================================================

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

        const attribute =
            canonicalColor(element.getAttribute('bgcolor'));

        if (attribute) {
            return attribute;
        }

        return canonicalColor(
            getComputedStyle(element).backgroundColor
        );

    }


    // ============================================================
    // TEST PHASE HINT
    // ============================================================
    //
    // The hint is ADVISORY. Color is the only thing that can create an
    // alert; the hint may only re-label one.
    //
    // It reads explicit data- attributes ONLY. The previous version
    // concatenated textContent + title + class + id + every data-
    // attribute and matched /\btest\b/i against the lot. On a page
    // called Server Level Test the word "test" is everywhere, so the
    // hint fired constantly and (combined with the old override) turned
    // ordinary red transitions into pre-test fails.
    //
    // Result is cached on the cell node. Soft refresh replaces those
    // nodes wholesale, so the cache invalidates itself.
    // ============================================================

    const PHASE_ATTRIBUTES = [
        'data-phase',
        'data-test-phase',
        'data-teststate',
        'data-test-state',
        'data-status'
    ];


    function getTestPhaseHint(cell) {

        if (!cell) {
            return '';
        }

        if (cell.__evePhaseHint !== undefined) {
            return cell.__evePhaseHint;
        }

        let hint = '';

        for (const name of PHASE_ATTRIBUTES) {

            const raw = cell.getAttribute(name);

            if (!raw) {
                continue;
            }

            const value = raw.toLowerCase();

            if (/pre[\s_-]*test/.test(value)) {
                hint = 'pretest';
                break;
            }

            if (/\btest(?:ing)?\b/.test(value)) {
                hint = 'test';
                break;
            }

        }

        cell.__evePhaseHint = hint;

        return hint;

    }


    // ============================================================
    // VALID TRANSITIONS
    // ============================================================
    //
    // These three color pairs are the ONLY thing that raises an alert:
    //
    //   lightblue  -> red        PRE-TEST FAIL
    //   lightgreen -> red        TEST FAIL
    //   lightgreen -> darkgreen  TEST PASS
    //
    // The phase hint cannot add a fourth. It can only re-label a
    // TEST_FAILURE as a PRETEST_FAILURE when the markup explicitly
    // says the server was in pre-test - which covers the real case
    // where a pre-test red follows a light-green render.
    //
    // The previous version checked the phase FIRST and returned
    // PRETEST_FAILURE for any "X -> red", including darkgreen -> red
    // and blank -> red, which the spec deliberately ignores.
    // ============================================================

    function getTransitionType(oldColor, newColor, oldPhase, newPhase) {

        let transition = null;

        if (oldColor === 'lightblue' && newColor === 'red') {
            transition = 'PRETEST_FAILURE';
        } else if (oldColor === 'lightgreen' && newColor === 'red') {
            transition = 'TEST_FAILURE';
        } else if (oldColor === 'lightgreen' && newColor === 'darkgreen') {
            transition = 'TEST_SUCCESS';
        }

        if (!transition) {
            return null;
        }

        if (
            transition === 'TEST_FAILURE' &&
            (oldPhase === 'pretest' || newPhase === 'pretest')
        ) {
            return 'PRETEST_FAILURE';
        }

        return transition;

    }


    // ============================================================
    // READ SERVER INFORMATION
    // ============================================================

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
            phase: getTestPhaseHint(cell),

            // The cell links to its unique server-detail page.
            // Persisted with the alert so the card can open the exact
            // server that generated the result, even after a refresh.
            detailUrl: safeUrl(anchor.href),

            cell: cell
        };

    }


    // ============================================================
    // FLAP PROTECTION
    // ============================================================
    //
    // A cell oscillating between colors would alert and log on every
    // flip. The same SLOT + SERIAL reporting the same transition
    // within the cooldown is ignored.
    //
    // The serial is part of the key on purpose. Keying on the slot
    // alone meant that pulling a server and racking a replacement that
    // genuinely failed the same way inside 60s was suppressed - the
    // flap guard silently swallowed a real failure.
    //
    // Persisted, because a hard reload used to wipe the in-memory map
    // and re-arm every cooldown.
    // ============================================================

    function loadRecentAlerts() {

        try {

            const saved = sessionStorage.getItem(RECENT_ALERTS_KEY);

            if (saved) {

                const parsed = JSON.parse(saved);
                const now = Date.now();
                const map = new Map();

                Object.entries(parsed).forEach(([sig, time]) => {
                    if (now - time < ALERT_COOLDOWN_MS) {
                        map.set(sig, time);
                    }
                });

                return map;

            }

        } catch (error) {
            warn('Flap-protection load error:', error);
        }

        return new Map();

    }


    function saveRecentAlerts() {

        try {
            sessionStorage.setItem(
                RECENT_ALERTS_KEY,
                JSON.stringify(Object.fromEntries(recentAlerts))
            );
        } catch (error) {
            // Non-fatal: worst case a flap slips through after reload.
        }

    }


    function isDuplicateAlert(key, serial, transition) {

        const signature = `${key}|${serial}|${transition}`;

        const last = recentAlerts.get(signature);

        const now = Date.now();

        if (last && (now - last) < ALERT_COOLDOWN_MS) {

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
                if ((now - time) > ALERT_COOLDOWN_MS) {
                    recentAlerts.delete(sig);
                }
            });

        }

        saveRecentAlerts();

        return false;

    }


    // ============================================================
    // SCAN PAGE
    // ============================================================
    //
    // Walks each EVE table's rows ONCE and loops that table's header
    // columns inside. The old shape was
    //
    //     headers.forEach(h => h.closest('table')
    //         .querySelectorAll('tbody tr').forEach(...))
    //
    // which re-walked every row once per header - eight EVE columns in
    // one table meant eight complete row walks, each doing a
    // getComputedStyle() and an attribute sweep per cell.
    // ============================================================

    function scan(groupsIn) {

        const groups = groupsIn || getEveTableGroups();

        // Tracks whether this scan observed any change, so idle scans
        // skip the sessionStorage write entirely.
        let statesDirty = false;

        // Every slot key seen this pass. Anything in previousStates
        // that is NOT here has vanished and gets pruned below.
        const seenKeys = new Set();

        let headerCount = 0;

        groups.forEach(group => {

            const headers = group.headers;

            headerCount += headers.length;

            group.table.querySelectorAll('tbody tr').forEach(row => {

                const cells = row.children;

                if (!cells.length) {
                    return;
                }

                // First cell = U#
                const unit = cells[0].textContent.trim();

                if (!/^U\d+$/i.test(unit)) {
                    return;
                }

                headers.forEach(header => {

                    const serverCell = cells[header.column];

                    if (!serverCell) {
                        return;
                    }

                    const info =
                        getServerInfo(
                            serverCell,
                            header.section,
                            header.eve,
                            unit
                        );

                    if (!info) {
                        return;
                    }

                    processSlot(header, unit, info, seenKeys, () => {
                        statesDirty = true;
                    });

                });

            });

        });

        // ----------------------------------------------------
        // PRUNE VANISHED SLOTS
        // ----------------------------------------------------
        //
        // Only prune when headers were actually found. If the page is
        // mid-swap or failed to load, headerCount is 0 and wiping every
        // baseline would cause a storm of false "baseline" entries on
        // the next good scan.

        if (headerCount && previousStates.size) {

            let pruned = 0;

            previousStates.forEach((value, key) => {
                if (!seenKeys.has(key)) {
                    previousStates.delete(key);
                    pruned += 1;
                }
            });

            if (pruned) {
                statesDirty = true;
                devLog(
                    `Pruned ${pruned} slot(s) no longer present on the page.`
                );
            }

        }

        if (statesDirty) {
            savePreviousStates();
        }

        const lastScanEl = document.getElementById('eve-last-scan');

        if (lastScanEl) {
            lastScanEl.textContent =
                `Last scan: ${new Date().toLocaleTimeString()} ` +
                `(${headerCount} headers, ${previousStates.size} states)`;
        }

        updateSessionSummary();

    }


    // ------------------------------------------------------------
    // One rack slot, one scan pass. Split out of scan() so the nesting
    // stays readable now that rows are the outer loop.
    // ------------------------------------------------------------

    function processSlot(header, unit, info, seenKeys, markDirty) {

        const key = `${header.section}|${header.eve}|${unit}`;

        seenKeys.add(key);

        const oldState = previousStates.get(key);

        const newState = {
            color: info.color,
            serial: info.serial,
            phase: info.phase || ''
        };

        const colorChanged =
            oldState && oldState.color !== info.color;

        const serialChanged =
            oldState && oldState.serial !== info.serial;

        const phaseChanged =
            oldState && (oldState.phase || '') !== (info.phase || '');

        if (!oldState || colorChanged || serialChanged || phaseChanged) {

            markDirty();

            devLog(
                `${key} \u{2192} color:${info.color} serial:${info.serial}` +
                (
                    oldState
                        ? ` (was ${oldState.color}/${oldState.serial})`
                        : ' (baseline)'
                )
            );

        }

        previousStates.set(key, newState);

        // ----------------------------------------------------
        // FIRST SIGHTING = BASELINE ONLY
        // ----------------------------------------------------

        if (!oldState) {
            return;
        }

        // ----------------------------------------------------
        // DIFFERENT SERVER IN THE SLOT
        // ----------------------------------------------------
        //
        // The state key is a RACK SLOT, not a server. If the serial
        // changed, a different physical machine is now in this slot and
        // any color difference is between two unrelated servers.
        //
        // Without this guard, pulling a passing server (lightgreen) and
        // racking one that is already red produced a "TEST FAIL"
        // against the NEW server's serial - a machine that never
        // failed - and wrote that into the permanent audit log.

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

        const transition =
            getTransitionType(
                oldState.color,
                info.color,
                oldState.phase || '',
                info.phase || ''
            );

        if (!transition) {
            return;
        }

        if (isDuplicateAlert(key, info.serial, transition)) {
            return;
        }

        // ----------------------------------------------------
        // RECORD, THEN SURFACE
        // ----------------------------------------------------
        //
        // Recording is unconditional. The per-section "Notifs" flag
        // suppresses the card and the desktop toast ONLY.
        //
        // Previously logRealAlert() lived inside notify(), which sat
        // behind this same watch check - so muting a noisy section
        // silently stopped it being recorded and the exported log
        // developed invisible holes.

        recordTransition(info, transition);

        const sectionSettings = getSectionSettings(header.section);

        if (!sectionSettings.watch) {

            log(
                `${key} ${transition} recorded to the log but not ` +
                `surfaced \u{2014} "Notifs" is off for section ` +
                `${header.section}.`
            );

            return;

        }

        surfaceAlert(info, transition);

    }


    // ============================================================
    // RECORD A TRANSITION (log + session counters)
    // ============================================================

    function recordTransition(info, transition) {

        logRealAlert(info, transition);

        if (sessionCounts[transition] !== undefined) {
            sessionCounts[transition] += 1;
        }

        updateSessionSummary();

    }


    // ============================================================
    // SURFACE AN ALERT (in-page card + desktop toast)
    // ============================================================

    function surfaceAlert(info, transition) {

        const title = getTransitionTitle(transition);

        createPersistentAlert(title, info, transition);

        sendDesktopNotification(
            title,
            buildNotificationBody(info, transition),
            getTransitionIcon(transition),
            info && info.detailUrl
                ? () => openFromNotification(info.detailUrl)
                : null
        );

    }


    // ============================================================
    // SESSION SUMMARY
    // ============================================================

    function updateSessionSummary() {

        const el = document.getElementById('eve-session-summary');

        if (!el) {
            return;
        }

        const total =
            sessionCounts.TEST_SUCCESS +
            sessionCounts.TEST_FAILURE +
            sessionCounts.PRETEST_FAILURE;

        el.textContent =
            total
                ? 'This session: ' +
                  `${sessionCounts.TEST_FAILURE} fail \u{b7} ` +
                  `${sessionCounts.PRETEST_FAILURE} pre-test fail \u{b7} ` +
                  `${sessionCounts.TEST_SUCCESS} pass`
                : 'This session: no alerts yet';

    }


    // ============================================================
    // DEBUG: PERSISTENCE TESTER  (Developer Mode only)
    // ============================================================
    //
    // Snapshots previousStates before a refresh, then compares against
    // what loads back afterwards.
    //
    // Gated on developerMode. The old build ran this on EVERY unload -
    // including a tech clicking a server-detail link - serialising all
    // of previousStates to sessionStorage each time and dumping a
    // PASS/FAIL block to the console on every load.
    // ============================================================

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

            sessionStorage.setItem(
                DEBUG_SNAPSHOT_KEY,
                JSON.stringify(snapshot)
            );

            devLog(
                `Snapshot taken before refresh (${reason}). ` +
                `${snapshot.count} states saved.`
            );

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
                devLog(
                    'No pre-refresh snapshot found (fresh session, or no ' +
                    'test was run).'
                );
                return;
            }

            const snapshot = JSON.parse(raw);

            const beforeKeys = Object.keys(snapshot.data);

            const missing =
                beforeKeys.filter(k => !previousStates.has(k));

            const changed = beforeKeys.filter(k => {

                const before = snapshot.data[k];
                const after = previousStates.get(k);

                return (
                    after &&
                    (
                        after.color !== before.color ||
                        after.serial !== before.serial
                    )
                );

            });

            devLog('===== PERSISTENCE TEST RESULT =====');
            devLog(`Snapshot reason: ${snapshot.reason}`);
            devLog(
                `Before: ${beforeKeys.length} states | ` +
                `After: ${previousStates.size} states`
            );

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


    // ============================================================
    // RANDOM TEST DATA
    // ============================================================

    function randomTestServerInfo() {

        const sections = ['B1', 'B2', 'B3', 'B4', 'B5'];

        const eveNumbers = [
            'EVE01', 'EVE02', 'EVE03', 'EVE04',
            'EVE05', 'EVE06', 'EVE07', 'EVE08'
        ];

        const uNumber =
            String(Math.floor(Math.random() * 42) + 1).padStart(2, '0');

        // Prefixed so a test serial can NEVER be mistaken for a real
        // one, on screen or in a notification.
        const serial =
            'DEBUG #' + String(Math.floor(Math.random() * 9000) + 8231000);

        return {
            serial: serial,
            section: sections[Math.floor(Math.random() * sections.length)],
            eve: eveNumbers[Math.floor(Math.random() * eveNumbers.length)],
            unit: `U${uNumber}`,
            serverType: 'E62CSTANDARDCNIC',
            detailUrl: ''
        };

    }


    // ============================================================
    // TEST NOTIFICATION  (debug buttons only)
    // ============================================================
    //
    // Never touches the audit log or the session counters - it does not
    // go through recordTransition().
    // ============================================================

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

        if (settings.showDebug) {

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


    // ============================================================
    // REAL-ALERT AUDIT LOG
    // ============================================================
    //
    // Separate from the dismissable alert cards. A permanent record of
    // every REAL transition the scanner detected - test/debug
    // notifications are excluded by construction, so the log is a
    // trustworthy account of actual server events.
    //
    // Held in memory and written DEBOUNCED. The old build did a full
    // load -> parse -> push -> stringify -> write of the entire array
    // for every single alert; at 2000 entries that is a several-
    // hundred-KB synchronous main-thread stall per alert, which
    // visibly hitches the browser during a burst.
    //
    // localStorage (not sessionStorage) so it survives closing the tab
    // and spans shifts. Only ever cleared explicitly by the user.
    // ============================================================

    let alertLogCache = null;
    let logWriteTimer = null;
    let logWritePending = false;


    function loadAlertLogFromStorage() {

        try {

            const saved = localStorage.getItem(ALERT_LOG_KEY);

            if (saved) {

                const parsed = JSON.parse(saved);

                if (Array.isArray(parsed)) {
                    return parsed;
                }

            }

        } catch (error) {
            warn('Alert log load error:', error);
        }

        return [];

    }


    function getAlertLog() {

        if (!alertLogCache) {
            alertLogCache = loadAlertLogFromStorage();
        }

        return alertLogCache;

    }


    function flushAlertLog() {

        if (logWriteTimer) {
            clearTimeout(logWriteTimer);
            logWriteTimer = null;
        }

        if (!logWritePending || !alertLogCache) {
            return;
        }

        try {

            localStorage.setItem(
                ALERT_LOG_KEY,
                JSON.stringify(alertLogCache)
            );

            logWritePending = false;

        } catch (error) {

            // Almost always a quota error. Surface it loudly - silently
            // losing audit entries is the failure mode that matters.
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

        while (logEntries.length > MAX_LOG_ENTRIES) {
            logEntries.shift();
        }

        scheduleLogWrite();

    }


    // ------------------------------------------------------------
    // Defensive filter for debug/test data. One function for both the
    // scan-time info object and the stored alert record - they were
    // two near-identical helpers before.
    // ------------------------------------------------------------

    function isDebugData(candidate) {

        if (!candidate) {
            return false;
        }

        if (candidate.debug === true) {
            return true;
        }

        const serial   = String(candidate.serial || '').toUpperCase();
        const section  = String(candidate.section || '').toUpperCase();
        const location = String(candidate.location || '').toUpperCase();
        const title    = String(candidate.title || '').toUpperCase();

        return (
            section === 'DEBUG' ||
            serial.startsWith('DEBUG') ||
            location.includes('DEBUG') ||
            title.includes('DEBUG')
        );

    }


    function logRealAlert(info, transition) {

        if (isDebugData(info)) {
            devLog(
                'Debug/test transition \u{2014} not written to the alert ' +
                'log (real servers only).'
            );
            return;
        }

        const now = new Date();

        appendAlertLog({
            iso: now.toISOString(),
            date: now.toLocaleDateString(),
            time: now.toLocaleTimeString(),
            result: getTransitionTitle(transition),
            transition: transition,
            serial: info.serial,
            section: info.section,
            eve: info.eve,
            unit: info.unit,
            serverType: info.serverType || ''
        });

    }


    // Log entries with all debug/test activity removed. Every export
    // path AND the clear-log confirmation use this, so the counts the
    // user sees always agree with the file they get.

    function loadRealAlertLog() {
        return getAlertLog().filter(entry => !isDebugData(entry));
    }


    // ============================================================
    // LOG FORMATTING HELPERS
    // ============================================================

    function formatDuration(ms) {

        const totalMinutes = Math.max(0, Math.floor(ms / 60000));

        const days    = Math.floor(totalMinutes / 1440);
        const hours   = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;

        if (days) {
            return `${days}d ${hours}h`;
        }

        if (hours) {
            return `${hours}h ${minutes}m`;
        }

        return `${minutes}m`;

    }


    // Pads AND truncates. padRight() alone let one long serial or a
    // verbose locale time string break every subsequent column.

    function padOrTrim(text, width) {

        const value = String(text === undefined || text === null ? '' : text);

        if (value.length === width) {
            return value;
        }

        if (value.length > width) {
            return width > 1
                ? value.slice(0, width - 1) + '\u{2026}'
                : value.slice(0, width);
        }

        return value + ' '.repeat(width - value.length);

    }


    // ISO-derived, locale-independent. Stored date/time are locale
    // strings, which sort as text and differ machine-to-machine.

    function isoDateParts(iso) {

        if (!iso) {
            return { date: '', time: '' };
        }

        const match =
            String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);

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


    const LOG_CATEGORIES = [
        { transition: 'PRETEST_FAILURE', heading: 'PRE-TEST FAILS' },
        { transition: 'TEST_FAILURE',    heading: 'TEST FAILS' },
        { transition: 'TEST_SUCCESS',    heading: 'TEST PASSES' }
    ];

    // Column widths drive the rule width, instead of a magic number
    // that did not match either the rule or the columns.
    const LOG_COLUMNS = [
        { label: '#',        width: 5  },
        { label: 'DATE',     width: 12 },
        { label: 'TIME',     width: 11 },
        { label: 'SERIAL',   width: 22 },
        { label: 'LOCATION', width: 24 }
    ];

    const LOG_TABLE_WIDTH =
        LOG_COLUMNS.reduce((sum, column) => sum + column.width, 0);

    const LOG_RULE = '='.repeat(LOG_TABLE_WIDTH + 2);
    const LOG_THIN = '-'.repeat(LOG_TABLE_WIDTH);


    function buildLogTable(entries, lines) {

        lines.push(
            '  ' +
            LOG_COLUMNS
                .map(column => padOrTrim(column.label, column.width))
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


    // ============================================================
    // .TXT REPORT
    // ============================================================

    function buildAlertLogText() {

        const logEntries = loadRealAlertLog();

        const lines = [];

        lines.push(LOG_RULE);
        lines.push('EVE SLT TRACKER \u{2014} ALERT LOG');
        lines.push('by Zay Davidson');
        lines.push(`Tracker version: ${SCRIPT_VERSION}`);
        lines.push(LOG_RULE);
        lines.push('');

        lines.push(`Exported:      ${new Date().toLocaleString()}`);

        if (logEntries.length) {

            const first = new Date(logEntries[0].iso);
            const last  = new Date(logEntries[logEntries.length - 1].iso);

            lines.push(`First alert:   ${first.toLocaleString()}`);
            lines.push(`Last alert:    ${last.toLocaleString()}`);
            lines.push(`Time span:     ${formatDuration(last - first)}`);

        }

        lines.push(`Total alerts:  ${logEntries.length}`);
        lines.push('');
        lines.push('Note: debug/test notifications are NOT recorded here.');
        lines.push('      Every entry is a real detected transition.');
        lines.push('      Section "Notifs" being off does NOT affect this');
        lines.push('      log - muted sections are still recorded.');
        lines.push('');

        if (!logEntries.length) {

            lines.push(LOG_RULE);
            lines.push('No alerts have been recorded yet.');
            lines.push(LOG_RULE);
            lines.push(
                'Report bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues'
            );

            return lines.join('\n');

        }

        // ----- SUMMARY ------------------------------------------

        const grouped = {};

        LOG_CATEGORIES.forEach(category => {
            grouped[category.transition] =
                logEntries.filter(
                    entry => entry.transition === category.transition
                );
        });

        const known = LOG_CATEGORIES.map(c => c.transition);

        const other =
            logEntries.filter(
                entry => known.indexOf(entry.transition) === -1
            );

        lines.push(LOG_RULE);
        lines.push('SUMMARY');
        lines.push(LOG_RULE);

        LOG_CATEGORIES.forEach(category => {

            const count = grouped[category.transition].length;

            const share =
                logEntries.length
                    ? Math.round((count / logEntries.length) * 100)
                    : 0;

            lines.push(
                '  ' +
                padOrTrim(category.heading, 20) +
                padOrTrim(count, 8) +
                `${share}%`
            );

        });

        if (other.length) {
            lines.push(
                '  ' + padOrTrim('OTHER', 20) + padOrTrim(other.length, 8)
            );
        }

        lines.push('');

        // ----- BREAKDOWN BY LOCATION ----------------------------

        const bySection = {};

        logEntries.forEach(entry => {
            bySection[entry.section] = (bySection[entry.section] || 0) + 1;
        });

        const sectionNames = Object.keys(bySection).sort();

        if (sectionNames.length > 1) {

            lines.push(LOG_RULE);
            lines.push('ALERTS BY SECTION');
            lines.push(LOG_RULE);

            sectionNames.forEach(section => {
                lines.push('  ' + padOrTrim(section, 20) + bySection[section]);
            });

            lines.push('');

        }

        // ----- ONE SECTION PER CATEGORY -------------------------

        LOG_CATEGORIES.forEach(category => {

            const entries = grouped[category.transition];

            lines.push(LOG_RULE);
            lines.push(`${category.heading} (${entries.length})`);
            lines.push(LOG_RULE);

            if (!entries.length) {
                lines.push('  None recorded.');
            } else {
                buildLogTable(entries, lines);
            }

            lines.push('');

        });

        if (other.length) {
            lines.push(LOG_RULE);
            lines.push(`OTHER (${other.length})`);
            lines.push(LOG_RULE);
            buildLogTable(other, lines);
            lines.push('');
        }

        // ----- FULL CHRONOLOGICAL RECORD ------------------------
        //
        // Every entry already appears once in its category table, so
        // this section is a second copy of the whole log. Capped, since
        // at 2000 entries it doubled the file for no extra information.

        lines.push(LOG_RULE);
        lines.push(`FULL CHRONOLOGICAL RECORD (${logEntries.length})`);
        lines.push(LOG_RULE);

        if (logEntries.length > MAX_CHRONOLOGICAL_ENTRIES) {

            lines.push(
                `  Omitted: ${logEntries.length} entries exceeds the ` +
                `${MAX_CHRONOLOGICAL_ENTRIES}-entry cap for this section.`
            );
            lines.push(
                '  Every entry appears above in its category table, and'
            );
            lines.push(
                '  the .csv export contains the full chronological data.'
            );

        } else {

            logEntries.forEach((entry, index) => {

                lines.push(
                    `[${index + 1}] ${entry.date} ${entry.time} \u{2014} ` +
                    `${entry.result}`
                );

                lines.push(`      Serial #: ${entry.serial}`);

                lines.push(
                    `      Location: ${entry.section} \u{2022} ` +
                    `${entry.eve} \u{2022} ${entry.unit}`
                );

                if (entry.serverType) {
                    lines.push(`      Type:     ${entry.serverType}`);
                }

                lines.push(`      ISO:      ${entry.iso}`);
                lines.push('');

            });

        }

        lines.push('');
        lines.push(LOG_RULE);
        lines.push(
            'Report bugs: https://github.com/zayd117/EVE-SLT-TRACKER/issues'
        );
        lines.push(LOG_RULE);

        return lines.join('\n');

    }


    // ============================================================
    // .CSV EXPORT
    // ============================================================

    function csvEscape(value) {

        const text =
            String(value === undefined || value === null ? '' : value);

        return /[",\n\r]/.test(text)
            ? '"' + text.replace(/"/g, '""') + '"'
            : text;

    }


    function buildAlertLogCsv() {

        const logEntries = loadRealAlertLog();

        const rows = [];

        rows.push([
            'Date',
            'Time',
            'ISO Timestamp',
            'Result',
            'Category',
            'Serial',
            'Section',
            'EVE',
            'Unit',
            'Server Type'
        ].join(','));

        const categoryNames = {
            PRETEST_FAILURE: 'PRE-TEST FAIL',
            TEST_FAILURE: 'TEST FAIL',
            TEST_SUCCESS: 'TEST PASS'
        };

        logEntries.forEach(entry => {

            // ISO-derived so Excel sorts these correctly and the file
            // is identical regardless of the exporting machine's locale.
            const parts = isoDateParts(entry.iso);

            rows.push([
                parts.date,
                parts.time,
                entry.iso,
                entry.result,
                categoryNames[entry.transition] || entry.transition,
                entry.serial,
                entry.section,
                entry.eve,
                entry.unit,
                entry.serverType || ''
            ].map(csvEscape).join(','));

        });

        return rows.join('\r\n');

    }


    // ============================================================
    // DOWNLOAD / EXPORT / CLEAR
    // ============================================================

    function downloadFile(content, extension, mimeType) {

        try {

            const blob = new Blob([content], { type: mimeType });

            const url = URL.createObjectURL(blob);

            const stamp =
                new Date()
                    .toISOString()
                    .replace(/[:.]/g, '-')
                    .slice(0, 19);

            const link = document.createElement('a');

            link.href = url;
            link.download = `eve-slt-tracker-log-${stamp}.${extension}`;

            // Wrapped: appending to body is a childList mutation on
            // document.body, which the observer used to treat as a real
            // page change and answer with a full re-scan.
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


    function exportAlertLog() {

        flushAlertLog();

        const count = loadRealAlertLog().length;

        if (
            downloadFile(
                buildAlertLogText(),
                'txt',
                'text/plain;charset=utf-8'
            )
        ) {
            log(`Exported alert log as .txt (${count} real entries).`);
        }

    }


    function exportAlertLogCsv() {

        flushAlertLog();

        const count = loadRealAlertLog().length;

        if (
            downloadFile(
                buildAlertLogCsv(),
                'csv',
                'text/csv;charset=utf-8'
            )
        ) {
            log(`Exported alert log as .csv (${count} real entries).`);
        }

    }


    function clearAlertLog() {

        // Counted the same way the exports count, so the number in the
        // confirmation always matches the file the user just saved.
        const count = loadRealAlertLog().length;

        const total = getAlertLog().length;

        if (!total) {
            log('Alert log is already empty.');
            return;
        }

        const extra =
            total > count
                ? `\n(${total - count} debug/test entr(y/ies) from an ` +
                  'older build will also be removed.)'
                : '';

        const confirmed = window.confirm(
            `Permanently delete all ${count} logged alert(s)?${extra}\n\n` +
            'This cannot be undone. Export the log first if you need to ' +
            'keep a record.'
        );

        if (!confirmed) {
            return;
        }

        try {

            alertLogCache = [];
            logWritePending = false;

            if (logWriteTimer) {
                clearTimeout(logWriteTimer);
                logWriteTimer = null;
            }

            localStorage.removeItem(ALERT_LOG_KEY);

            log(`Alert log cleared (${total} entries removed).`);

        } catch (error) {
            fail('Could not clear the alert log:', error);
        }

    }


    // ============================================================
    // COPY SERIAL TO CLIPBOARD
    // ============================================================
    //
    // Triggered by an actual click, which satisfies the browser's
    // transient-user-activation requirement. Falls back to a hidden
    // textarea + execCommand where navigator.clipboard is unavailable
    // (locked-down builds, or a non-secure-context intranet page).
    // ============================================================

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


    // ============================================================
    // RELATIVE TIME LABELS
    // ============================================================

    function formatRelativeTime(ts) {

        if (!ts) {
            return '';
        }

        const seconds =
            Math.max(0, Math.floor((Date.now() - ts) / 1000));

        let relative;

        if (seconds < 10) {
            relative = 'just now';
        } else if (seconds < 60) {
            relative = `${seconds}s ago`;
        } else if (seconds < 3600) {
            relative = `${Math.floor(seconds / 60)}m ago`;
        } else if (seconds < 86400) {

            const hours = Math.floor(seconds / 3600);
            const mins  = Math.floor((seconds % 3600) / 60);

            relative = mins ? `${hours}h ${mins}m ago` : `${hours}h ago`;

        } else {
            relative = `${Math.floor(seconds / 86400)}d ago`;
        }

        return `\u{1f552} ${relative} \u{b7} ${new Date(ts).toLocaleTimeString()}`;

    }


    function refreshRelativeTimes() {

        document
            .querySelectorAll('.eve-alert-time[data-ts]')
            .forEach(el => {

                const ts = Number(el.dataset.ts);

                if (ts) {
                    el.textContent = formatRelativeTime(ts);
                }

            });

    }


    // ============================================================
    // ESCAPE HTML
    // ============================================================
    //
    // Regex map rather than creating a throwaway DOM element per call
    // (4 per card, 50 cards on restore).
    // ============================================================

    const HTML_ESCAPES = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };


    function escapeHtml(text) {

        return String(text === undefined || text === null ? '' : text)
            .replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

    }


    // ============================================================
    // ALERT PERSISTENCE ACROSS REFRESHES
    // ============================================================
    //
    // In-page cards are plain DOM nodes, so a hard reload would destroy
    // them - meaning any alert not read within the auto-refresh window
    // vanished unseen. Every alert is written to sessionStorage on
    // creation and re-rendered on load. An alert only leaves storage
    // when the user explicitly dismisses it.
    //
    // sessionStorage (not localStorage) so alerts are scoped to this
    // tab and do not resurrect days later in an unrelated window.
    // ============================================================

    function loadActiveAlerts() {

        try {

            const saved = sessionStorage.getItem(ACTIVE_ALERTS_KEY);

            if (saved) {

                const parsed = JSON.parse(saved);

                if (Array.isArray(parsed)) {
                    return parsed;
                }

            }

        } catch (error) {
            warn('Active alert load error:', error);
        }

        return [];

    }


    function saveActiveAlerts(alerts) {

        try {
            sessionStorage.setItem(
                ACTIVE_ALERTS_KEY,
                JSON.stringify(alerts)
            );
        } catch (error) {
            warn('Active alert save error:', error);
        }

    }


    function storeAlert(record) {

        const alerts = loadActiveAlerts();

        alerts.push(record);

        // Evict DEBUG/test records first. The old blind shift() meant
        // that pressing the test buttons a few times could push real,
        // undismissed alerts out of storage entirely.
        while (alerts.length > MAX_STORED_ALERTS) {

            const debugIndex = alerts.findIndex(a => isDebugData(a));

            alerts.splice(debugIndex === -1 ? 0 : debugIndex, 1);

        }

        saveActiveAlerts(alerts);

    }


    function removeStoredAlert(alertId) {

        saveActiveAlerts(
            loadActiveAlerts().filter(record => record.id !== alertId)
        );

    }


    function clearStoredAlerts() {
        saveActiveAlerts([]);
    }


    function restorePersistedAlerts() {

        const alerts = loadActiveAlerts();

        if (!alerts.length) {
            return;
        }

        // Oldest first; renderAlertElement inserts at the top, so the
        // newest ends up on top.
        alerts.forEach(record => renderAlertElement(record, false));

        log(
            `Restored ${alerts.length} alert(s) that survived the page refresh.`
        );

    }


    // ============================================================
    // CREATE PERSISTENT IN-PAGE ALERT
    // ============================================================

    function createPersistentAlert(title, info, transition) {

        const record = {

            id:
                `alert-${Date.now()}-` +
                Math.random().toString(36).slice(2, 8),

            title: title,

            transition: transition,

            // Persisted so the DEBUG visibility modifier still works
            // after a page refresh.
            debug: isDebugData(info),

            // Kept separately so the card can offer one-click copy of
            // just the serial.
            serial: (info && info.serial) ? info.serial : '',

            // Direct link to the exact server-detail page. DEBUG/test
            // records have no URL and stay non-navigating.
            detailUrl: (info && info.detailUrl) ? safeUrl(info.detailUrl) : '',

            location:
                info
                    ? `${info.section} \u{2022} ${info.eve} \u{2022} ${info.unit}`
                    : '',

            statusLine: getStatusLine(transition),

            ts: Date.now()

        };

        renderAlertElement(record, true);

    }


    // ============================================================
    // RENDER ONE ALERT CARD
    // ============================================================
    //
    // Shared by brand-new alerts and by alerts restored after a
    // refresh, so both paths produce an identical card.
    // ============================================================

    const ALERT_CLASS_BY_TRANSITION = {
        TEST_SUCCESS: 'eve-success',
        TEST_FAILURE: 'eve-failure',
        PRETEST_FAILURE: 'eve-pretest'
    };


    function renderAlertElement(record, shouldStore) {

        const container = getAlertContainer();

        const alert = document.createElement('div');

        const alertClass =
            ALERT_CLASS_BY_TRANSITION[record.transition] || 'eve-failure';

        alert.className = `eve-alert ${alertClass}`;

        // Re-validated on render, not just on creation - the record
        // round-trips through sessionStorage, which the page's own
        // scripts can write.
        const detailUrl = safeUrl(record.detailUrl);

        if (detailUrl) {
            alert.classList.add('eve-alert-clickable');
            alert.title =
                'Click anywhere on this alert to open Server Detail';
        }

        alert.dataset.alertId = record.id;

        // Used by the filter buttons and the search box.
        alert.dataset.transition = record.transition || '';

        alert.dataset.debug = isDebugData(record) ? '1' : '0';

        alert.dataset.search =
            `${record.serial || ''} ${record.location || ''}`;

        // Number() so a poisoned stored value cannot break out of the
        // attribute - this was the one unescaped interpolation here.
        const ts = Number(record.ts) || 0;

        const serialBlock =
            record.serial
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

            <div
                class="eve-alert-time"
                data-ts="${ts}"
            >
                ${escapeHtml(formatRelativeTime(ts))}
            </div>

        `;

        // ----------------------------------------------------
        // CLICK ALERT BODY -> OPEN SERVER DETAIL
        // ----------------------------------------------------
        //
        // The serial area is copy-only and the X is dismiss-only.
        // Every other click on a real alert opens its server-detail
        // page. DEBUG/test alerts have no URL and do nothing.

        if (detailUrl) {

            alert.addEventListener('click', event => {

                if (
                    event.target.closest('.eve-alert-serial') ||
                    event.target.closest('.eve-alert-close')
                ) {
                    return;
                }

                openExternal(detailUrl);

            });

        }

        alert
            .querySelector('.eve-alert-close')
            .addEventListener('click', () => {

                // Dismissing is the ONLY thing that removes an alert
                // from storage - a refresh must not.
                removeStoredAlert(record.id);

                alert.remove();

                // Both, in this order. The old close handler called
                // only updateDismissAllButton(), which overwrote the
                // "(visible/total)" count with the unfiltered total and
                // left the active filter unapplied.
                refreshAlertChrome();

            });

        const serialButton = alert.querySelector('button.eve-alert-serial');

        if (serialButton && record.serial) {

            serialButton.addEventListener(
                'click',
                () => copySerialToClipboard(record.serial, serialButton)
            );

        }

        // Newest alert on TOP so the most recent result is the first
        // thing visible without scrolling.
        container.insertBefore(alert, container.firstChild);

        if (shouldStore) {
            storeAlert(record);
        }

        refreshAlertChrome();

    }


    // ============================================================
    // ALERT CONTAINER
    // ============================================================

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
                    \u{1f514} Alerts
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
                            data-filter="all">All</button>

                    <button class="eve-filter-btn eve-filter-category"
                            data-filter="TEST_FAILURE">Fails</button>

                    <button class="eve-filter-btn eve-filter-category"
                            data-filter="PRETEST_FAILURE">Pre-test</button>

                    <button class="eve-filter-btn eve-filter-category"
                            data-filter="TEST_SUCCESS">Passes</button>

                    <button class="eve-filter-btn eve-debug-visibility-toggle"
                            id="eve-alert-visibility-toggle"
                            type="button"
                            title="Hide DEBUG/test alerts from every category filter and suppress DEBUG/test desktop toasts">
                        \u{1f441} Show DEBUG
                    </button>

                </div>

                <input
                    type="search"
                    id="eve-alert-search"
                    placeholder="Search serial or location\u{2026}"
                >

            </div>

            <div id="eve-alert-body"></div>

        `;

        // Appending to document.body is a childList mutation whose
        // target is document.body, not our own UI - so without this
        // wrapper it read as a real page change and triggered a scan.
        withoutObserver(() => document.body.appendChild(container));

        const body = document.getElementById('eve-alert-body');

        // ----------------------------------------------------
        // COLLAPSE / EXPAND
        // ----------------------------------------------------

        const caret = document.getElementById('eve-alert-caret');

        document
            .getElementById('eve-alert-toggle')
            .addEventListener('click', () => {

                const collapsed =
                    container.classList.toggle('eve-alerts-collapsed');

                if (caret) {
                    caret.textContent = collapsed ? '\u{25b8}' : '\u{25be}';
                }

                try {
                    sessionStorage.setItem(
                        ALERTS_COLLAPSED_KEY,
                        collapsed ? '1' : '0'
                    );
                } catch (error) {
                    // Non-fatal: collapse state just will not persist.
                }

            });

        try {

            if (sessionStorage.getItem(ALERTS_COLLAPSED_KEY) === '1') {

                container.classList.add('eve-alerts-collapsed');

                if (caret) {
                    caret.textContent = '\u{25b8}';
                }

            }

        } catch (error) {
            // Non-fatal.
        }

        // ----------------------------------------------------
        // DISMISS ALL
        // ----------------------------------------------------

        document
            .getElementById('eve-alert-dismiss-all')
            .addEventListener('click', () => {

                clearStoredAlerts();

                body
                    .querySelectorAll('.eve-alert')
                    .forEach(node => node.remove());

                refreshAlertChrome();

                log(
                    'All alerts dismissed and cleared from storage. ' +
                    '(The exportable log is NOT affected.)'
                );

            });

        // ----------------------------------------------------
        // EXPORTS
        // ----------------------------------------------------

        document
            .getElementById('eve-alert-export')
            .addEventListener('click', exportAlertLog);

        document
            .getElementById('eve-alert-export-csv')
            .addEventListener('click', exportAlertLogCsv);

        // ----------------------------------------------------
        // FILTER + SEARCH
        // ----------------------------------------------------

        container
            .querySelectorAll('.eve-filter-category')
            .forEach(button => {

                button.addEventListener('click', () => {

                    container
                        .querySelectorAll('.eve-filter-category')
                        .forEach(other =>
                            other.classList.remove('eve-filter-active')
                        );

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

        }

        // ----------------------------------------------------
        // DEBUG VISIBILITY MODIFIER
        // ----------------------------------------------------

        const visibilityToggle =
            document.getElementById('eve-alert-visibility-toggle');

        if (visibilityToggle) {

            const updateVisibilityToggle = () => {

                visibilityToggle.textContent =
                    settings.showDebug
                        ? '\u{1f441} Hide DEBUG'
                        : '\u{1f441} Show DEBUG';

                visibilityToggle.classList.toggle(
                    'eve-debug-hidden',
                    !settings.showDebug
                );

                visibilityToggle.title =
                    settings.showDebug
                        ? 'Hide DEBUG/test alerts from every category filter and suppress DEBUG/test desktop toasts'
                        : 'Show DEBUG/test alerts in every category filter and resume DEBUG/test desktop toasts';

            };

            updateVisibilityToggle();

            visibilityToggle.addEventListener('click', () => {

                settings.showDebug = !settings.showDebug;

                saveSettings();

                updateVisibilityToggle();

                applyAlertFilter();

                log(
                    'DEBUG/test visibility/toasts ' +
                    (settings.showDebug ? 'VISIBLE.' : 'HIDDEN.')
                );

            });

        }

        return body;

    }


    // ============================================================
    // ALERT FILTER + SEARCH
    // ============================================================
    //
    // Hides cards that do not match, rather than removing them, so
    // filtering never destroys an alert or its stored copy.
    // ============================================================

    function applyAlertFilter() {

        const body = document.getElementById('eve-alert-body');

        if (!body) {
            return;
        }

        const cards = body.querySelectorAll('.eve-alert');

        let visible = 0;

        cards.forEach(card => {

            const matchesType =
                alertFilter === 'all' ||
                card.dataset.transition === alertFilter;

            const matchesSearch =
                !alertSearch ||
                (card.dataset.search || '')
                    .toLowerCase()
                    .indexOf(alertSearch) !== -1;

            const matchesDebugVisibility =
                settings.showDebug || card.dataset.debug !== '1';

            const show =
                matchesType && matchesSearch && matchesDebugVisibility;

            card.style.display = show ? '' : 'none';

            if (show) {
                visible += 1;
            }

        });

        const countEl = document.getElementById('eve-alert-count');

        if (countEl) {
            countEl.textContent =
                visible === cards.length
                    ? `(${cards.length})`
                    : `(${visible}/${cards.length})`;
        }

    }


    // ============================================================
    // ALERT CONTAINER VISIBILITY
    // ============================================================
    //
    // Renamed from updateDismissAllButton(), which never touched the
    // dismiss-all button - it toggled the whole container.
    //
    // Always paired with applyAlertFilter() via refreshAlertChrome(),
    // because the two both write the count element and calling only
    // one of them left the display inconsistent.
    // ============================================================

    function updateAlertContainerVisibility() {

        const container = document.getElementById('eve-alert-container');
        const body = document.getElementById('eve-alert-body');

        if (!container || !body) {
            return;
        }

        const count = body.querySelectorAll('.eve-alert').length;

        // Hide the whole menu when there is nothing to show, so it
        // takes no screen space until an alert actually fires.
        container.style.display = count > 0 ? 'block' : 'none';

        const dismissAll =
            document.getElementById('eve-alert-dismiss-all');

        if (dismissAll) {
            // What the original comment always claimed it did.
            dismissAll.style.display = count > 1 ? '' : 'none';
        }

    }


    function refreshAlertChrome() {

        updateAlertContainerVisibility();

        applyAlertFilter();

    }


    // ============================================================
    // SAFE BUTTON WIRING
    // ============================================================
    //
    // Wraps getElementById + addEventListener so a missing button
    // (stale UI, ID typo, script not actually reloaded) logs loudly
    // instead of silently doing nothing.
    // ============================================================

    function wireButton(id, handler) {

        const el = document.getElementById(id);

        if (!el) {

            // typeof guard: the old "GM_info && GM_info.script" threw a
            // ReferenceError inside this very error handler when the
            // identifier was undeclared.
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


    // ============================================================
    // PANEL POSITION PERSISTENCE
    // ============================================================

    function savePanelPosition(panel) {

        try {

            if (!panel) {
                return;
            }

            localStorage.setItem(
                PANEL_POSITION_KEY,
                JSON.stringify({
                    left: panel.style.left,
                    top: panel.style.top,
                    collapsed:
                        panel.classList.contains('eve-tracker-collapsed')
                })
            );

        } catch (error) {
            // Non-fatal - position just will not persist.
        }

    }


    function clampToViewport(panel, left, top) {

        const margin = 10;

        const maxLeft =
            Math.max(margin, window.innerWidth - panel.offsetWidth - margin);

        const maxTop =
            Math.max(margin, window.innerHeight - panel.offsetHeight - margin);

        return {
            left: Math.max(margin, Math.min(left, maxLeft)),
            top: Math.max(margin, Math.min(top, maxTop))
        };

    }


    function restorePanelPosition(panel, body, collapseButton) {

        try {

            const saved = localStorage.getItem(PANEL_POSITION_KEY);

            if (!saved) {
                return;
            }

            const pos = JSON.parse(saved);

            if (pos.left && pos.top) {

                // Clamp, in case the window is now smaller than it was
                // when the position was saved - otherwise the panel is
                // stranded off-screen with no way to drag it back.
                const clamped =
                    clampToViewport(
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

        } catch (error) {
            // Non-fatal.
        }

    }


    // ============================================================
    // COLLAPSIBLE MENU STATE PERSISTENCE
    // ============================================================

    function setupMenuStatePersistence(panel) {

        if (!panel) {
            return;
        }

        let open = {};

        try {
            open = JSON.parse(localStorage.getItem(MENU_STATE_KEY) || '{}');
        } catch (error) {
            open = {};
        }

        panel
            .querySelectorAll('details.eve-collapse')
            .forEach((details, index) => {

                const key = 'menu' + index;

                if (open[key]) {
                    details.open = true;
                }

                details.addEventListener('toggle', () => {

                    try {

                        const current =
                            JSON.parse(
                                localStorage.getItem(MENU_STATE_KEY) || '{}'
                            );

                        current[key] = details.open;

                        localStorage.setItem(
                            MENU_STATE_KEY,
                            JSON.stringify(current)
                        );

                    } catch (error) {
                        // Non-fatal.
                    }

                });

            });

    }


    // ============================================================
    // TRACKER WINDOW UX  (drag / collapse / snap)
    // ============================================================
    //
    // Pointer Events instead of mouse events: works on touch screens
    // as well as a mouse, and the move/up listeners only exist while a
    // drag is actually in progress. The old build kept a document-level
    // mousemove handler alive for the whole session that early-returned
    // on every mouse move page-wide.
    // ============================================================

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

        // Everything except the title becomes the body.
        const body = document.createElement('div');

        body.className = 'eve-tracker-body';

        while (title.nextSibling) {
            body.appendChild(title.nextSibling);
        }

        panel.appendChild(body);

        restorePanelPosition(panel, body, collapseButton);

        collapseButton.addEventListener('click', event => {

            event.stopPropagation();

            const collapsed =
                panel.classList.toggle('eve-tracker-collapsed');

            body.style.display = collapsed ? 'none' : '';

            collapseButton.textContent = collapsed ? '\u{ff0b}' : '\u{2212}';

            collapseButton.title =
                collapsed
                    ? 'Expand EVE SLT Tracker'
                    : 'Collapse EVE SLT Tracker';

            savePanelPosition(panel);

        });

        let dragState = null;

        function onPointerMove(event) {

            if (!dragState) {
                return;
            }

            const maxLeft =
                Math.max(0, window.innerWidth - panel.offsetWidth);

            const maxTop =
                Math.max(0, window.innerHeight - panel.offsetHeight);

            panel.style.left =
                `${Math.min(Math.max(0, event.clientX - dragState.offsetX), maxLeft)}px`;

            panel.style.top =
                `${Math.min(Math.max(0, event.clientY - dragState.offsetY), maxTop)}px`;

        }

        function onPointerUp() {

            if (!dragState) {
                return;
            }

            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);

            dragState = null;

            const margin = 10;
            const snapDistance = 35;
            const rect = panel.getBoundingClientRect();

            const maxLeft =
                Math.max(margin, window.innerWidth - rect.width - margin);

            const maxTop =
                Math.max(margin, window.innerHeight - rect.height - margin);

            let left = rect.left;
            let top = rect.top;

            const nearLeft = left <= snapDistance;
            const nearRight =
                window.innerWidth - rect.right <= snapDistance;
            const nearTop = top <= snapDistance;
            const nearBottom =
                window.innerHeight - rect.bottom <= snapDistance;

            // Snap to a page corner when released nearby.
            if (nearLeft && nearTop) {
                left = margin; top = margin;
            } else if (nearRight && nearTop) {
                left = maxLeft; top = margin;
            } else if (nearLeft && nearBottom) {
                left = margin; top = maxTop;
            } else if (nearRight && nearBottom) {
                left = maxLeft; top = maxTop;
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

        // Keep the tracker inside the viewport if the browser resizes.
        window.addEventListener('resize', () => {

            const rect = panel.getBoundingClientRect();

            const clamped = clampToViewport(panel, rect.left, rect.top);

            panel.style.left = `${clamped.left}px`;
            panel.style.top = `${clamped.top}px`;
            panel.style.right = 'auto';

        });

    }


    // ============================================================
    // TRACKER UI
    // ============================================================

    function createUI() {

        if (document.getElementById('eve-tracker-panel')) {
            return;
        }

        const panel = document.createElement('div');

        panel.id = 'eve-tracker-panel';
        panel.classList.add('eve-tracker-window');

        panel.innerHTML = `

            <div class="eve-panel-title">

                EVE SLT Tracker

            </div>

            <div class="eve-byline">

                by Zay Davidson

            </div>

            <div id="eve-ui-page-main"
                 class="eve-ui-page eve-ui-page-active">

                <div class="eve-section-title">

                    Tracker Controls

                </div>

                <div class="eve-buttons">

                    <button id="eve-show-all">
                        Show All
                    </button>

                    <button id="eve-hide-all">
                        Hide All
                    </button>

                    <button id="eve-watch-all">
                        Notifs All
                    </button>

                    <button id="eve-watch-none">
                        Notifs None
                    </button>

                </div>

                <div id="eve-section-list"></div>

                <div class="eve-session-row">

                    <span
                        class="eve-refresh-status"
                        id="eve-session-summary"
                    >This session: no alerts yet</span>

                </div>

                <details class="eve-collapse eve-collapse-outer">

                    <summary class="eve-collapse-title">
                        \u{1f504} Auto Refresh
                        <span
                            class="eve-summary-badge"
                            id="eve-refresh-badge"
                        ></span>
                    </summary>

                    <div class="eve-collapse-body">

                        <div class="eve-refresh-controls">

                            <label class="eve-refresh-toggle">

                                <input
                                    type="checkbox"
                                    id="eve-auto-refresh"
                                >

                                <span>
                                    Auto Refresh
                                </span>

                            </label>

                            <label class="eve-refresh-interval">

                                Every

                                <select id="eve-refresh-interval">

                                    <option value="30">30 seconds</option>
                                    <option value="60">60 seconds</option>
                                    <option value="120">2 minutes</option>
                                    <option value="300">5 minutes</option>
                                    <option value="600">10 minutes</option>

                                </select>

                            </label>

                        </div>

                        <div class="eve-refresh-status"
                             id="eve-refresh-status">
                        </div>

                        <div class="eve-refresh-status"
                             id="eve-last-scan">
                        </div>

                        <label class="eve-refresh-toggle">

                            <input
                                type="checkbox"
                                id="eve-soft-refresh"
                            >

                            <span>
                                Soft refresh (keeps position &amp; alerts)
                            </span>

                        </label>

                        <div class="eve-debug-hint">

                            Soft refresh reloads the data in the
                            background instead of reloading the whole
                            page, so the tracker window stays where you
                            put it. Falls back to a full reload
                            automatically if it fails.

                        </div>

                    </div>

                </details>

            </div>

            <!-- =====================================================
                 DEVELOPER / DEBUG PAGE
                 Hidden unless Developer Mode is enabled.
                 ===================================================== -->

            <div id="eve-ui-page-debug"
                 class="eve-ui-page"
                 hidden>

                <div class="eve-page-heading">

                    Developer / Diagnostics

                </div>

                <details
                    id="eve-debug-tools"
                    class="eve-collapse eve-collapse-outer"
                    open
                >

                    <summary class="eve-collapse-title">
                        \u{1f6e0} Debug Tools
                    </summary>

                    <div class="eve-collapse-body">

                        <details class="eve-collapse" open>

                            <summary class="eve-collapse-title">
                                Debug / Test Notifications
                            </summary>

                            <div class="eve-collapse-body">

                                <div class="eve-buttons">

                                    <button id="eve-debug-success">
                                        \u{1f7e2} Test Success
                                    </button>

                                    <button id="eve-debug-failure">
                                        \u{274c} Test Failure
                                    </button>

                                    <button id="eve-debug-pretest">
                                        \u{1f537} Test Pre-Test Failure
                                    </button>

                                    <button id="eve-debug-persistence">
                                        \u{1f4be} Refresh &amp; Compare (Persistence Test)
                                    </button>

                                    <button id="eve-debug-notify-diagnostic">
                                        \u{1f6a8} Diagnose Desktop Toasts (5 tests)
                                    </button>

                                    <button id="eve-debug-health">
                                        \u{1fa7a} Health Check
                                    </button>

                                    <button id="eve-clear-log">
                                        \u{1f5d1} Clear Alert Log
                                    </button>

                                </div>

                                <div class="eve-debug-hint">

                                    Clearing the log permanently deletes
                                    the saved alert history. Export it
                                    first if you need the record.

                                </div>

                                <div class="eve-debug-hint">

                                    Desktop notification duration: 0 = stays until you
                                    close it manually. Any other number = seconds before
                                    it auto-dismisses.

                                </div>

                                <div class="eve-buttons">

                                    <label for="eve-notification-timeout"
                                           style="display:flex;align-items:center;gap:6px;">
                                        Auto-close after (seconds, 0 = never):
                                        <input type="number"
                                               id="eve-notification-timeout"
                                               min="0"
                                               step="1"
                                               style="width:70px;">
                                    </label>

                                </div>

                            </div>

                        </details>

                    </div>

                </details>

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

        withoutObserver(() => document.body.appendChild(panel));

        setupTrackerWindowUX(panel);

        setupMenuStatePersistence(panel);

        buildSectionControls();

        // ========================================================
        // AUTO REFRESH CONTROLS
        // ========================================================

        const autoRefreshCheckbox =
            document.getElementById('eve-auto-refresh');

        const refreshInterval =
            document.getElementById('eve-refresh-interval');

        autoRefreshCheckbox.checked = settings.autoRefresh;

        refreshInterval.value = String(settings.refreshIntervalSeconds);

        autoRefreshCheckbox.addEventListener('change', () => {

            settings.autoRefresh = autoRefreshCheckbox.checked;

            saveSettings();

            // Apply immediately - cancels any pending reload if turned
            // off, reschedules if turned on.
            restartAutoRefresh();

        });

        refreshInterval.addEventListener('change', () => {

            settings.refreshIntervalSeconds =
                Number(refreshInterval.value);

            saveSettings();

            restartAutoRefresh();

        });

        updateRefreshCountdown();

        // ========================================================
        // SOFT REFRESH TOGGLE
        // ========================================================

        const softRefreshCheckbox =
            document.getElementById('eve-soft-refresh');

        if (softRefreshCheckbox) {

            softRefreshCheckbox.checked = settings.softRefresh;

            softRefreshCheckbox.addEventListener('change', () => {

                settings.softRefresh = softRefreshCheckbox.checked;

                // A deliberate re-tick clears the session-level
                // failure lockout too.
                if (settings.softRefresh) {
                    softRefreshDisabledForSession = false;
                    softRefreshFailures = 0;
                }

                saveSettings();

                log(
                    'Soft refresh ' +
                    (
                        settings.softRefresh
                            ? 'ENABLED \u{2014} page content swaps in ' +
                              'place, tracker position preserved.'
                            : 'DISABLED \u{2014} using full page reloads.'
                    )
                );

            });

        }

        // ========================================================
        // NOTIFICATION TIMEOUT CONTROL
        // ========================================================

        const notificationTimeoutInput =
            document.getElementById('eve-notification-timeout');

        if (notificationTimeoutInput) {

            notificationTimeoutInput.value =
                String(settings.notificationTimeoutSeconds);

            notificationTimeoutInput.addEventListener('change', () => {

                const value = Number(notificationTimeoutInput.value);

                settings.notificationTimeoutSeconds =
                    (!Number.isNaN(value) && value >= 0) ? value : 0;

                notificationTimeoutInput.value =
                    String(settings.notificationTimeoutSeconds);

                saveSettings();

                log(
                    'Notification auto-close set to ' +
                    `${settings.notificationTimeoutSeconds} seconds ` +
                    '(0 = never auto-closes).'
                );

            });

        }

        // ========================================================
        // BULK SECTION CONTROLS
        // ========================================================

        wireButton('eve-show-all',    () => setAllSections('show', true));
        wireButton('eve-hide-all',    () => setAllSections('show', false));
        wireButton('eve-watch-all',   () => setAllSections('watch', true));
        wireButton('eve-watch-none',  () => setAllSections('watch', false));

        // ========================================================
        // DEVELOPER MODE / TWO-PAGE UI
        // ========================================================
        //
        // Page 0 = normal tracker UI (default)
        // Page 1 = developer / diagnostics UI
        //
        // Turning Developer Mode off always returns to page 0 and hides
        // the developer page and navigation entirely.
        // ========================================================

        const developerModeCheckbox =
            document.getElementById('eve-developer-mode');

        const mainPage  = document.getElementById('eve-ui-page-main');
        const debugPage = document.getElementById('eve-ui-page-debug');
        const debugTools = document.getElementById('eve-debug-tools');

        const pageNavigation =
            document.getElementById('eve-page-navigation');

        const pageDots =
            pageNavigation
                ? pageNavigation.querySelectorAll('.eve-page-dot')
                : [];

        let developerPage = 0;

        function showDeveloperPage(pageIndex) {

            developerPage =
                settings.developerMode && pageIndex === 1 ? 1 : 0;

            if (mainPage) {
                mainPage.hidden = developerPage !== 0;
                mainPage.classList.toggle(
                    'eve-ui-page-active',
                    developerPage === 0
                );
            }

            if (debugPage) {

                const showDebugPage =
                    developerPage === 1 && settings.developerMode;

                debugPage.hidden = !showDebugPage;

                debugPage.classList.toggle(
                    'eve-ui-page-active',
                    showDebugPage
                );

            }

            pageDots.forEach((dot, index) => {

                const active =
                    index === developerPage && settings.developerMode;

                dot.classList.toggle('eve-page-dot-active', active);

                dot.setAttribute('aria-current', active ? 'page' : 'false');

            });

        }

        function applyDeveloperModeUI() {

            const enabled = !!settings.developerMode;

            if (developerModeCheckbox) {
                developerModeCheckbox.checked = enabled;
            }

            if (pageNavigation) {

                // Always reserve the navigation area so the normal UI
                // keeps a stable layout; only the dots are rendered
                // when Developer Mode is on.
                pageNavigation.hidden = false;

                pageNavigation.classList.toggle(
                    'eve-dev-nav-disabled',
                    !enabled
                );

                pageNavigation.setAttribute(
                    'aria-hidden',
                    enabled ? 'false' : 'true'
                );

            }

            pageDots.forEach(dot => {
                dot.hidden = !enabled;
                dot.tabIndex = enabled ? 0 : -1;
            });

            if (debugTools) {
                debugTools.hidden = !enabled;
            }

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

                // Enabling always starts on the normal page.
                developerPage = 0;

                applyDeveloperModeUI();

                log(
                    'Developer Mode ' +
                    (
                        settings.developerMode
                            ? 'ENABLED. Developer page available.'
                            : 'DISABLED. Developer page hidden.'
                    )
                );

            });

        }

        applyDeveloperModeUI();

        // ========================================================
        // DEBUG BUTTONS
        // ========================================================

        wireButton('eve-debug-success', () => sendTestNotification('success'));
        wireButton('eve-debug-failure', () => sendTestNotification('failure'));
        wireButton('eve-debug-pretest', () => sendTestNotification('pretest'));

        wireButton('eve-debug-notify-diagnostic', () => {

            log('Open this console and watch your desktop for ~10 seconds.');

            runNotificationDiagnostic();

        });

        wireButton('eve-debug-persistence', () => {

            savePreviousStates();

            debugSnapshotBeforeRefresh('manual-button');

            flushAlertLog();

            log('Reloading page now to test persistence...');

            location.reload();

        });

        wireButton('eve-debug-health', () => logHealthReport());

        wireButton('eve-clear-log', () => clearAlertLog());

        updateSessionSummary();

    }


    // ============================================================
    // HEALTH REPORT
    // ============================================================
    //
    // Everything that used to be scattered across the console (or
    // invisible entirely) in one place, so "is the tracker actually
    // working?" has a single answer.
    // ============================================================

    function logHealthReport() {

        const overdueMs =
            autoRefreshDueAt ? Date.now() - autoRefreshDueAt : null;

        let storageBytes = 0;

        try {
            storageBytes =
                (localStorage.getItem(ALERT_LOG_KEY) || '').length;
        } catch (error) {
            storageBytes = -1;
        }

        console.log(
            '%c' + LOG_PREFIX + ' HEALTH REPORT',
            'font-weight:bold;font-size:14px;'
        );

        console.table({
            version:            SCRIPT_VERSION,
            autoRefresh:        settings.autoRefresh ? 'ON' : 'OFF',
            intervalSeconds:    settings.refreshIntervalSeconds,
            nextRefreshInSec:
                autoRefreshDueAt
                    ? Math.round((autoRefreshDueAt - Date.now()) / 1000)
                    : 'n/a',
            overdueSeconds:
                overdueMs === null ? 'n/a' : Math.round(overdueMs / 1000),
            softRefreshSetting: settings.softRefresh ? 'ON' : 'OFF',
            softRefreshActive:  softRefreshEnabled() ? 'YES' : 'NO (session lockout)',
            softRefreshInFlight: softRefreshInFlight,
            softRefreshFailures: softRefreshFailures,
            trackedSlots:       previousStates.size,
            eveTables:          getEveTableGroups().length,
            eveHeaders:         getEveHeaders().length,
            activeAlertCards:   loadActiveAlerts().length,
            auditLogEntries:    loadRealAlertLog().length,
            auditLogBytes:      storageBytes,
            logWritePending:    logWritePending,
            cooldownsHeld:      recentAlerts.size,
            GM_notification:    typeof GM_notification,
            GM_openInTab:       typeof GM_openInTab
        });

    }


    // ============================================================
    // BUILD SECTION CONTROLS
    // ============================================================
    //
    // Diffs the section set. The old build did list.innerHTML = '' and
    // rebuilt every checkbox on every mutation tick (~4x/second during
    // page activity), which thrashes layout and can destroy a checkbox
    // the user is mid-click on. The set is unchanged almost always, so
    // the common path is now just syncing checked states.
    // ============================================================

    let renderedSectionSignature = null;


    function buildSectionControls(groups) {

        const list = document.getElementById('eve-section-list');

        if (!list) {
            return;
        }

        const sections =
            [
                ...new Set(
                    (groups || getEveTableGroups())
                        .flatMap(group => group.headers)
                        .map(header => header.section)
                )
            ];

        const signature = sections.join('|');

        if (signature === renderedSectionSignature) {

            // Same sections - just make sure the checkboxes agree with
            // the settings (e.g. after Show All / Notifs None).
            sections.forEach(section => {

                const row =
                    list.querySelector(
                        `.eve-section-row[data-section="${CSS.escape(section)}"]`
                    );

                if (!row) {
                    return;
                }

                const sectionSettings = getSectionSettings(section);

                row.querySelector('.eve-show-checkbox').checked =
                    sectionSettings.show;

                row.querySelector('.eve-watch-checkbox').checked =
                    sectionSettings.watch;

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

                <span class="eve-section-name">

                    ${escapeHtml(section)}

                </span>

                <label>

                    <input
                        type="checkbox"
                        class="eve-show-checkbox"
                    >

                    Show

                </label>

                <label>

                    <input
                        type="checkbox"
                        class="eve-watch-checkbox"
                    >

                    Notifs

                </label>

            `;

            const showCheckbox = row.querySelector('.eve-show-checkbox');
            const watchCheckbox = row.querySelector('.eve-watch-checkbox');

            showCheckbox.checked = sectionSettings.show;
            watchCheckbox.checked = sectionSettings.watch;

            showCheckbox.addEventListener('change', () => {

                sectionSettings.show = showCheckbox.checked;

                saveSettings();

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

    }


    // ============================================================
    // SET ALL SECTIONS
    // ============================================================

    function setAllSections(property, value) {

        const groups = getEveTableGroups();

        [
            ...new Set(
                groups
                    .flatMap(group => group.headers)
                    .map(header => header.section)
            )
        ].forEach(section => {
            getSectionSettings(section)[property] = value;
        });

        saveSettings();

        buildSectionControls(groups);

        applyVisibility(groups);

    }


    // ============================================================
    // APPLY VISIBILITY
    // ============================================================
    //
    // Same O(rows) restructure as scan(): each table's rows are walked
    // once and the header columns looped inside, instead of re-walking
    // every row once per header.
    //
    // Wrapped in withoutObserver() because it writes style.display on
    // PAGE cells, which the observer watches - previously that fed
    // straight back into another applyVisibility().
    // ============================================================

    function applyVisibility(groupsIn) {

        const groups = groupsIn || getEveTableGroups();

        withoutObserver(() => {

            groups.forEach(group => {

                const visibility =
                    group.headers.map(header => {

                        const visible =
                            getSectionSettings(header.section).show;

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

    // ============================================================
    // CSS
    // ============================================================

    function injectCSS() {

        const style = document.createElement('style');

        style.textContent = `
            /* =====================================================
               TRACKER PANEL
               ===================================================== */

            /* =====================================================
               DRAGGABLE / COLLAPSIBLE TRACKER WINDOW
               ===================================================== */

            #eve-tracker-panel.eve-tracker-window {
                min-width: 300px;
                max-width: 520px;
            }

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
                border: 1px solid #666;
                border-radius: 5px;
                background: #444;
                color: white;
                font-size: 18px;
                font-weight: bold;
                line-height: 22px;
                cursor: pointer;
            }

            #eve-tracker-panel .eve-collapse-btn:hover {
                background: #666;
            }

            #eve-tracker-panel.eve-tracker-collapsed {
                min-width: 220px;
                width: auto;
            }

            #eve-tracker-panel {
                position: fixed;
                top: 10px;
                right: 10px;
                width: 340px;
                max-height: 90vh;
                overflow-y: auto;
                z-index: 2147483646;
                background: #222;
                color: white;
                border: 2px solid #555;
                border-radius: 8px;
                padding: 12px;
                font-family: Arial, Helvetica, sans-serif;
                font-size: 13px;
                box-shadow: 0 4px 15px
                    rgba(0, 0, 0, .5);
            }

            .eve-panel-title {
                font-size: 19px;
                font-weight: bold;
                margin-bottom: 7px;
            }

            /* Status badge shown on a collapsed summary line, so
               the section's state is readable without expanding. */

            .eve-summary-badge {
                font-size: 10px;
                font-weight: bold;
                padding: 2px 6px;
                border-radius: 3px;
                margin-left: 6px;
                vertical-align: middle;
            }

            .eve-badge-on {
                background: #087f23;
                color: #fff;
            }

            .eve-badge-off {
                background: #7a2020;
                color: #fff;
            }

            /* Final few seconds before a reload \u{2014} warns you that
               the page is about to change under you. */

            .eve-badge-soon {
                background: #b06a00;
                color: #fff;
            }

            /* =====================================================
               ALERTS TOOLBAR \u{2014} FILTER + SEARCH
               ===================================================== */

            #eve-alert-toolbar {
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 7px 10px;
                background: #232323;
                border-bottom: 1px solid #444;
            }

            .eve-alerts-collapsed #eve-alert-toolbar {
                display: none;
            }

            #eve-alert-filters {
                display: flex;
                gap: 4px;
                flex-wrap: wrap;
            }

            .eve-filter-btn {
                background: #333;
                color: #ccc;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 3px 9px;
                font-size: 11px;
                font-weight: bold;
                cursor: pointer;
            }

            .eve-filter-btn:hover {
                background: #414141;
            }

            .eve-filter-btn.eve-filter-active {
                background: #0d6efd;
                border-color: #0d6efd;
                color: #fff;
            }

            /* DEBUG visibility is a modifier, never a category tab. */

            .eve-debug-visibility-toggle {
                margin-left: 2px;
            }

            .eve-debug-visibility-toggle.eve-debug-hidden {
                background: #555;
                border-color: #777;
                color: #fff;
            }

            #eve-alert-search {
                width: 100%;
                box-sizing: border-box;
                background: #1b1b1b;
                color: #eee;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 4px 7px;
                font-size: 12px;
            }

            /* =====================================================
               SESSION SUMMARY
               ===================================================== */

            .eve-session-row {
                margin: 8px 0 4px;
            }

            /* Small byline directly under the panel title. */

            .eve-byline {
                font-size: 10px;
                color: #999;
                margin-top: -4px;
                margin-bottom: 6px;
            }

            /* Contact footer \u{2014} sits at the very bottom of the
               panel, deliberately small so it takes minimal space. */

            .eve-credit {
                font-size: 10px;
                color: #999;
                line-height: 1.4;
                margin-top: 12px;
                padding-top: 6px;
                border-top: 1px solid #444;
                word-break: break-word;
            }

            .eve-section-title {
                font-weight: bold;
                border-bottom: 1px solid #555;
                padding-bottom: 5px;
                margin-top: 10px;
                margin-bottom: 7px;
            }

            .eve-buttons {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin-bottom: 8px;
            }

            .eve-buttons button {
                cursor: pointer;
                padding: 5px 8px;
                border: 1px solid #777;
                border-radius: 4px;
                background: #333;
                color: white;
            }

            .eve-buttons button:hover {
                background: #555;
            }

            .eve-refresh-controls {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 6px 0;
                flex-wrap: wrap;
            }

            .eve-refresh-toggle {
                display: flex;
                align-items: center;
                gap: 5px;
                cursor: pointer;
                font-weight: bold;
            }

            .eve-refresh-interval {
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .eve-refresh-interval select {
                padding: 3px 5px;
                border: 1px solid #777;
                border-radius: 4px;
                background: #333;
                color: white;
            }

            .eve-refresh-status {
                font-size: 11px;
                color: #aaa;
                margin-bottom: 5px;
            }

            /* =====================================================
               TWO-PAGE UI / SUBTLE DEVELOPER MODE
               ===================================================== */

            .eve-ui-page {
                width: 100%;
            }

            .eve-ui-page[hidden] {
                display: none !important;
            }

            .eve-page-heading {
                font-size: 12px;
                font-weight: bold;
                color: #aaa;
                padding: 2px 4px 6px;
                border-bottom: 1px solid #444;
                margin-bottom: 4px;
                letter-spacing: 0.2px;
            }

            .eve-page-navigation {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                /* Always reserve this small amount of space. When
                   Developer Mode is OFF, the dots are hidden and this
                   becomes a subtle empty placeholder so the main UI
                   does not shift when Dev is toggled. */
                height: 16px;
                margin-top: 4px;
                user-select: none;
            }

            .eve-page-navigation[hidden] {
                display: flex !important;
            }

            .eve-page-navigation.eve-dev-nav-disabled .eve-page-dot {
                display: none !important;
                visibility: hidden;
                pointer-events: none;
            }

            .eve-page-dot[hidden] {
                display: none !important;
                visibility: hidden;
                pointer-events: none;
            }

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

            .eve-page-dot:hover {
                opacity: 1;
                background: #888;
            }

            .eve-page-dot.eve-page-dot-active {
                width: 7px;
                height: 7px;
                min-width: 7px;
                min-height: 7px;
                background: #bbb;
                opacity: 1;
            }

            .eve-credit {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                margin-top: 2px;
            }

            .eve-credit-contact {
                min-width: 0;
                flex: 1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* Intentionally tiny/subtle. This is not a normal user
               setting; it is simply the entry point to the developer
               page for people who need the under-the-hood tools. */

            .eve-developer-footer-toggle {
                display: inline-flex;
                align-items: center;
                gap: 2px;
                flex: 0 0 auto;
                color: #666;
                font-size: 8px;
                font-weight: normal;
                cursor: pointer;
                user-select: none;
                opacity: 0.45;
                transition: opacity 0.15s ease;
            }

            .eve-developer-footer-toggle:hover {
                opacity: 0.9;
                color: #aaa;
            }

            .eve-developer-footer-toggle input {
                width: 10px;
                height: 10px;
                margin: 0;
                padding: 0;
                cursor: pointer;
                accent-color: #777;
            }

            .eve-developer-footer-toggle span {
                line-height: 1;
            }

            /* =====================================================
               COLLAPSIBLE DEBUG MENUS
               ===================================================== */

            .eve-collapse {
                margin-top: 10px;
            }

            .eve-collapse-outer {
                border-top: 1px solid #444;
                padding-top: 8px;
            }

            .eve-collapse-title {
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
                color: #ddd;
                padding: 6px 4px;
                border-radius: 4px;
                list-style: none;
                user-select: none;
            }

            .eve-collapse-title::-webkit-details-marker {
                display: none;
            }

            .eve-collapse-title::before {
                content: '\u{25b8} ';
                display: inline-block;
                width: 14px;
            }

            .eve-collapse[open] > .eve-collapse-title::before {
                content: '\u{25be} ';
            }

            .eve-collapse-title:hover {
                background: #333;
            }

            .eve-collapse-body {
                padding-left: 8px;
            }

            .eve-debug-hint {
                font-size: 11px;
                color: #999;
                margin-bottom: 6px;
                line-height: 1.4;
            }

            .eve-section-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 0;
            }

            .eve-section-name {
                font-weight: bold;
                width: 45px;
            }

            .eve-section-row label {
                cursor: pointer;
            }

            .eve-section-row input {
                cursor: pointer;
            }

            /* =====================================================
               PERSISTENT ALERT CONTAINER
               ===================================================== */

            #eve-alert-container {
                position: fixed;
                top: 10px;
                left: 10px;
                width: 430px;
                max-width: calc(100vw - 20px);
                z-index: 2147483647;
                display: none;
                background: #1b1b1b;
                border: 2px solid #555;
                border-radius: 8px;
                font-family: Arial, Helvetica, sans-serif;
            }

            #eve-alert-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                background: #2a2a2a;
                border-radius: 6px 6px 0 0;
                color: white;
                font-size: 15px;
                font-weight: bold;
            }

            #eve-alert-toggle {
                cursor: pointer;
                user-select: none;
                flex: 1;
            }

            #eve-alert-caret {
                display: inline-block;
                width: 14px;
            }

            #eve-alert-count {
                opacity: .8;
                font-weight: normal;
            }

            #eve-alert-header-actions {
                display: flex;
                gap: 6px;
            }

            #eve-alert-header-actions button {
                background: #3a3a3a;
                color: white;
                border: 1px solid #666;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
                font-weight: bold;
                cursor: pointer;
            }

            #eve-alert-header-actions button:hover {
                background: #4a4a4a;
            }

            #eve-alert-body {
                max-height: calc(100vh - 90px);
                overflow-y: auto;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .eve-alerts-collapsed #eve-alert-body {
                display: none;
            }

            .eve-alerts-collapsed #eve-alert-header {
                border-radius: 6px;
            }

            /* =====================================================
               ALERT
               ===================================================== */

            .eve-alert {
                position: relative;
                border-radius: 6px;
                padding: 8px 10px;
                color: white;
                font-family: Arial, Helvetica, sans-serif;
                box-shadow: 0 3px 12px
                    rgba(0, 0, 0, .5);
                border: 1px solid rgba(255, 255, 255, .65);
            }

            .eve-alert-clickable {
                cursor: pointer;
            }

            .eve-alert-clickable:hover {
                filter: brightness(1.08);
            }

            /* =====================================================
               SUCCESS
               ===================================================== */

            .eve-success {
                background: #087f23;
            }

            /* =====================================================
               FAILURE
               ===================================================== */

            .eve-failure {
                background: #b00000;
            }

            /* =====================================================
               PRE-TEST FAILURE
               ===================================================== */

            .eve-pretest {
                background: #8b0000;
            }

            /* =====================================================
               ALERT HEADER
               ===================================================== */

            .eve-alert-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 16px;
                font-weight: bold;
                margin-bottom: 6px;
            }

            /* =====================================================
               CLOSE BUTTON
               ===================================================== */

            .eve-alert-close {
                border: none;
                background: transparent;
                color: white;
                font-size: 20px;
                font-weight: bold;
                line-height: 16px;
                cursor: pointer;
                padding: 0 2px;
            }

            .eve-alert-close:hover {
                opacity: .7;
            }

            /* =====================================================
               MESSAGE
               ===================================================== */

            /* =====================================================
               CLICK-TO-COPY SERIAL
               ===================================================== */

            .eve-alert-serial {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                width: 100%;
                background: rgba(0, 0, 0, .28);
                border: 1px solid rgba(255, 255, 255, .3);
                border-radius: 4px;
                color: white;
                font-family: Consolas, "Courier New", monospace;
                font-size: 15px;
                font-weight: bold;
                padding: 5px 8px;
                margin-bottom: 5px;
                cursor: pointer;
                text-align: left;
            }

            .eve-alert-serial:hover {
                background: rgba(0, 0, 0, .45);
                border-color: rgba(255, 255, 255, .6);
            }

            .eve-alert-serial-value {
                word-break: break-all;
            }

            .eve-alert-copy-hint {
                font-size: 11px;
                opacity: .75;
                white-space: nowrap;
                font-family: Arial, Helvetica, sans-serif;
            }

            .eve-alert-serial.eve-copied {
                background: rgba(255, 255, 255, .25);
            }

            .eve-alert-serial.eve-copy-failed {
                background: rgba(0, 0, 0, .6);
            }

            /* =====================================================
               LOCATION + STATUS ROWS
               ===================================================== */

            .eve-alert-loc {
                font-size: 13px;
                font-weight: bold;
                margin-bottom: 3px;
            }

            .eve-alert-status {
                font-size: 13px;
                font-weight: bold;
                margin-bottom: 5px;
            }

            /* =====================================================
               ALERT TIMESTAMP
               ===================================================== */

            .eve-alert-time {
                font-size: 14px;
                font-weight: bold;
                opacity: .95;
                padding-top: 4px;
                border-top: 1px solid rgba(255, 255, 255, .2);
            }


        `;

        document.head.appendChild(style);

    }


    // ============================================================
    // INITIALIZE
    // ============================================================

    function initialize() {

        // Everything below runs inside an error boundary. A throw here
        // previously left a half-built UI and a silently dead tracker,
        // which for a monitoring tool is the worst failure mode.
        try {

            settings = loadSettings();

            previousStates = loadPreviousStates();

            recentAlerts = loadRecentAlerts();

            // Late second pass. The real work is done at
            // document-start in bootstrap() below - by DOMContentLoaded
            // the browser has usually already committed a meta refresh,
            // which is why the old build's single call here did not
            // reliably stop the page reloading on the server's timer.
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

            injectCSS();

            createUI();

            // Bring back any alerts that were still undismissed when
            // this page last unloaded. After injectCSS() so the
            // restored cards are styled, and before scan() so newly
            // detected alerts stack above them.
            restorePersistedAlerts();

            const groups = getEveTableGroups();

            applyVisibility(groups);

            scan(groups);

            startMasterTick();

            observePage();

            window.addEventListener('beforeunload', () => {

                savePreviousStates();

                saveRecentAlerts();

                // Anything recorded since the last debounced write
                // must not be lost on navigation.
                flushAlertLog();

                debugSnapshotBeforeRefresh('manual-refresh');

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


    // ------------------------------------------------------------
    // A dead tracker must be visibly dead. Console-only failure means
    // a tech watches a panel that is not watching anything.
    // ------------------------------------------------------------

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

        } catch (bannerError) {
            // Nothing further we can do.
        }

    }


    // ============================================================
    // MASTER TICK
    // ============================================================
    //
    // One timer with counters instead of three intervals.
    //
    // scan() does not need to run every second: the MutationObserver
    // fires on any real page change, and a soft refresh scans
    // immediately after swapping content. The interval is only a
    // safety net for changes neither catches.
    // ============================================================

    function startMasterTick() {

        const SCAN_TICKS     = 4;   // scan() every 4s
        const RELATIVE_TICKS = 15;  // relative labels every 15s
        const WATCHDOG_TICKS = 10;  // refresh watchdog every 10s

        let tick = 0;

        setInterval(() => {

            tick += 1;

            updateRefreshCountdown();

            if (tick % SCAN_TICKS === 0) {
                scan();
            }

            if (tick % RELATIVE_TICKS === 0) {
                refreshRelativeTimes();
            }

            if (tick % WATCHDOG_TICKS === 0) {
                autoRefreshWatchdog();
            }

        }, 1000);

    }


    // ============================================================
    // BOOTSTRAP
    // ============================================================
    //
    // Runs at document-start. Two jobs:
    //
    //   1. Kill the page's own <meta http-equiv="refresh"> BEFORE the
    //      browser commits it. Chromium schedules a meta refresh at
    //      parse time, so removing the node from DOMContentLoaded is
    //      too late - the page still reloads on the server's timer,
    //      resetting the tracker and racing the soft refresh. The
    //      observer below catches the tag the instant it is parsed.
    //
    //   2. Hand off to initialize() once the DOM is ready.
    //
    // NOTE: settings are not loaded yet at this point, so nothing here
    // may touch `settings`.
    // ============================================================

    function bootstrap() {

        let earlyObserver = null;

        try {

            if (document.documentElement) {

                stripMetaRefresh(document);

                earlyObserver = new MutationObserver(() => {

                    if (stripMetaRefresh(document)) {
                        console.warn(
                            LOG_PREFIX +
                            ' Stripped a page-level meta refresh tag at ' +
                            'parse time.'
                        );
                    }

                });

                earlyObserver.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                });

            }

        } catch (error) {
            console.warn(
                LOG_PREFIX + ' Early meta-refresh guard failed:',
                error
            );
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
