// ==UserScript==
// @name         EVE SLT Tracker
// @namespace    https://github.com/zayd117/EVE-SLT-TRACKER
// @version      0.9.5
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
// v0.9.5 CHANGE LOG  (status detection - field-reported)
// ================================================================
//
// SYMPTOM
//   Every card read "phase NOT verified - detail page did not state
//   a phase", including cards whose detail page states the phase and
//   the result plainly.
//
// ROOT CAUSE 1: the Operation vocabulary was wrong.
//   normalizePhaseWord() matched /pre-?test/ and /\btest\b/ only. The
//   regular stage is not called "test" on this page - it is called
//   SLT. So the regular-stage row matched nothing, phase came back
//   '', parseDetailDocument() bailed with "did not state a phase",
//   and confirmation "failed" on pages that were perfectly readable.
//   Every label then fell back to the colour guess it was supposed to
//   be correcting.
//
// ROOT CAUSE 2: the result was never taken from the detail page.
//   The page states the result per operation as a boolean in the Pass
//   column - PRETEST/Pass=1 then SLT/Pass=0 means "cleared pre-test,
//   failed the regular test on the taskcase that went 0". The old
//   code read Pass only as a fallback for a missing taskset_status,
//   and applyPhaseToTransition() could then only swap the PRETEST/
//   TEST half of a label it had already decided from cell colour. The
//   result half was owned by colour end to end.
//
// FIXED
//   * Operation is mapped properly: pre-test words -> PRETEST,
//     everything else -> TEST. The literal Operation string is kept
//     and shown on the card, so an operation this script has never
//     seen is displayed rather than discarded.
//   * Pass is the primary result signal, per row, on the row with the
//     latest Started. taskset_status corroborates and wins on a
//     disagreement, which is logged rather than resolved silently.
//   * A row with no Finished and no status is RUNNING. Its Pass reads
//     0 because it has not passed yet; that is no longer read as a
//     failure.
//   * PRETEST_SUCCESS is a real category now. "Pre-test passed, SLT
//     has not reported" is no longer mislabelled TEST PASS.
//   * The detail page can always confirm or upgrade a failure, but a
//     PASS row can never downgrade a red the rack colour caught - the
//     Test Status table can lag colour, and dropping a real failure is
//     the one unacceptable outcome.
//   * Cards show the evidence: operation, Pass=0/1, taskset and the
//     failing taskcase. Exports carry Operation and Pass columns.
//   * Restored cards are re-confirmed on load. Confirmation used to
//     run once, at the moment of the colour change; a card stored
//     before it succeeded came back out of sessionStorage with its
//     stale badge for ever, so a build that fixed confirmation could
//     not reach the cards raised by the build that broke it.
//   * The slot-agreement check no longer runs on those retroactive
//     re-checks - it compares a slot recorded hours ago against where
//     the server sits now, and a failed server that has since been
//     pulled and re-racked always "disagrees", correctly and about
//     nothing.
//   * Re-confirmation is driven by "is this label finished", not
//     "did the phase confirm". A card whose phase confirmed but whose
//     RESULT did not - a half-written Test Status row, or a record
//     from a build that had no result field - is retried on restore
//     and every 45s after, up to 8 attempts.
//   * Confirmation detail on a card is Developer Mode only. It is
//     still built, still stored, still exported - it is just not what
//     an operator reads at a glance. The provenance glyph is off the
//     card title for the same reason.
//   * The alert container is a viewport-bounded flex column, so its
//     scrollbar lives inside the panel instead of running off the
//     bottom of the screen.
//   * LOG FIRST, THEN NOTIFY. The log entry is written before any card
//     or toast exists, and confirmation is attached to the EVENT
//     rather than to the card. Previously the fetch was started inside
//     surfaceAlert(), so an event in a muted section, or one held back
//     by the flap guard, was written to the permanent log as a colour
//     guess and never corrected - the audit trail was only as good as
//     the notification settings. Events now carry an eventId, the log
//     entry is corrected whether or not anyone was told, and a
//     surfaced alert reuses the event's promise instead of fetching
//     the same detail page twice.
//   * SYS_DEKIT IS NOT A TEST RESULT. It is a factory diagnostic that
//     routinely finishes Pass=0, and it was matching the "not a
//     pre-test word, therefore TEST" fallback - so every SYS_DEKIT row
//     was being reported as a TEST FAIL. It is now its own phase with
//     its own two categories, it overrides the colour outright rather
//     than being merged with it, its cards ride the Show DEBUG switch,
//     and it never raises a desktop notification. The one exception is
//     a retraction: if an alert already went out calling it a failure,
//     a follow-up says otherwise, because leaving that standing sends
//     someone to a rack for nothing. Diagnostics are excluded from the
//     denominator in the .txt summary so they cannot dilute the
//     failure rate, and the .csv marks every row result vs diagnostic.
//   * PRE-TEST FAILS REACH THE DESKTOP AS PRE-TEST FAILS. Colour
//     cannot tell a pre-test failure from a test failure, so the toast
//     waits up to TOAST_CONFIRM_WAIT_MS for the detail page. In a burst
//     the fetch queue (4 parallel) blows past that, the toast goes out
//     on the provisional label - TEST FAIL - and the card then quietly
//     corrects itself to PRE-TEST FAIL where only someone watching the
//     panel would see it. Records now remember which label the desktop
//     was actually given, and a later correction sends a CORRECTED
//     toast. Suppressed for cards older than 30 minutes so a reload
//     re-checking yesterday's cards cannot start a toast storm.
//   * The alert panel's height is measured from ITS OWN top, not the
//     viewport's. The drag handler clamps only the header to the
//     screen by design, so a panel dragged down the page still claimed
//     a full viewport of list height and put the bottom of its
//     scrollbar track below the edge of the screen - the thumb ran out
//     of screen before it ran out of track. Height is now recomputed on
//     drag, drop, resize and every list change.
//   * THE LOG IS DAY-SCOPED. Entries from previous days are dropped
//     at startup and on a 60s rollover check, and every export and
//     count is filtered to the current log day regardless. The floor
//     changes daily - which servers are racked, how many, what type -
//     so a nine-day-old entry is not context, it is noise that skews
//     today's counts and eventually evicts real entries against the
//     2000-entry cap. The boundary is the local calendar date and
//     nothing else - an entry stamped 09/10 is a 09/10 entry whether it
//     landed at 00:04 or 23:59.
//   * Rack serials are compared by PARTS, so EVE5 vs EVE05 is no
//     longer a fault, and one disagreement no longer declares the
//     column mapping broken. Mapping faults are per-TABLE and show up
//     as many disagreements and no agreements; that is now what it
//     takes to raise DEGRADED.
//
// ================================================================

// ================================================================
// v0.9.10 CHANGE LOG
// ================================================================
//
// TRACKER COLLAPSE WIDTH FIX
//   * Collapsing the tracker now hides only the contents below the
//     header. The panel keeps the same width in both open and closed
//     states instead of shrinking horizontally.
//
// ================================================================

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
    // Colour detects that a RESULT happened. It does NOT tell you
    // which PHASE produced it - a server in pre-test renders light
    // green while it runs. The phase half of every label is read from
    // the server's own detail page. See v0.9.4 notes below.
    //
    //   any active colour -> \u{1f534} Red         FAIL   (phase confirmed)
    //   light/blue        -> \u{1f7e2} Dark Green  PASS   (phase confirmed)
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
    // v0.9.6 CHANGE LOG
    // ============================================================
    //
    //   * Replaced the desktop FAIL icon with a freshly encoded PNG.
    //   * Removed the unused "This session" summary and all session
    //     counter state/update logic.
    //   * Manual Health Check UI/control is not present; automatic
    //     detection-health reporting remains intact.
    //   * Alert-window drag/snap now uses the HEADER as the only geometry
    //     reference, so a tall alert list cannot trigger edge snapping.
    //   * The alert body is allowed to extend below/off-screen while the
    //     draggable header remains independently positioned.
    //
    // ============================================================

    // ============================================================
    // v0.9.4 CHANGE LOG  (phase mislabelling - field-reported)
    // ============================================================
    //
    // THE BUG
    //
    // Two servers observed going lightgreen -> red were alerted and
    // LOGGED as "TEST FAIL". Both detail pages said otherwise:
    //
    //   2637YW10AE   TA.B2-EVE08 pos 6    taskset PRETEST, status FAIL
    //   2637YW109Q   TA.B5-EVE11 pos 15   taskset PRETEST, status FAIL
    //
    // Both were PRE-TEST fails. The audit log - the one artifact that
    // has to be right - had the wrong category on both.
    //
    // ROOT CAUSE 1: colour does not encode phase.
    //   The original spec assumed lightblue = pre-test and lightgreen =
    //   test. It does not. A machine in PRE-TEST renders LIGHT GREEN
    //   while it runs. Colour is a STATUS channel (queued / running /
    //   failed / passed), not a PHASE channel, and the two were
    //   conflated. Any pre-test that reached green before failing -
    //   i.e. most of them, since 5_POWER_ON takes time - was filed as
    //   a test fail. lightblue -> red only ever caught a pre-test that
    //   died before it went green.
    //
    // ROOT CAUSE 2: the phase hint was dead code.
    //   getTestPhaseHint() reads only data- attributes. This page emits
    //   legacy bgcolor markup and no data- attributes at all, so
    //   info.phase was ALWAYS '' and the re-label branch in
    //   getTransitionType() never executed once in production.
    //
    // THE FIX
    //   * Colour still DETECTS the event - it is the only cheap
    //     per-scan signal. The LABEL now comes from the server's own
    //     detail page (taskset / taskset_status / Operation). One fetch
    //     per detected event, capped at 4 concurrent, short-TTL cached.
    //   * The card appears instantly on the colour guess and is
    //     RE-LABELLED in place when the detail page answers. Card,
    //     stored copy and log entry are corrected together so the three
    //     can never disagree.
    //   * Toasts wait up to TOAST_CONFIRM_WAIT_MS for confirmation. A
    //     fail toast a few seconds late is fine; a fail toast with the
    //     wrong phase on it is the bug being fixed.
    //   * Unconfirmed phases are marked as such (dashed card border,
    //     warning glyph on the toast, phaseSource in the log) instead
    //     of asserting a phase nothing verified.
    //   * Retested servers have SEVERAL Test Status rows for one SN -
    //     the real page shows two PRETEST FAILs 45 minutes apart. The
    //     row with the latest Started is used, not the last row in
    //     document order.
    //   * SLOT VERIFICATION. The detail page states Rack Serial and
    //     Position independently of our column arithmetic, so every
    //     confirmation now cross-checks the slot the tracker THINKS it
    //     read. This catches column misalignment at runtime, against
    //     live data.
    //
    // TRANSITIONS WIDENED (previously silently dropped)
    //   * darkgreen -> red      a retest failure after a pass. This was
    //                           a MISSED FAILURE in every prior build.
    //
    // NOTE ON HISTORIC DATA
    //   Entries logged before this version carry phaseSource 'color'.
    //   Their PASS/FAIL half is reliable; their PRE-TEST vs TEST half
    //   is not. The .txt export now warns about this explicitly.
    //
    // ============================================================
    // v0.9.3 CHANGE LOG  (senior review remediation - P0/P1)
    // ============================================================
    //
    // P0 - SILENT BLINDNESS
    //   * scan() could WIPE EVERY BASELINE. The prune guard checked
    //     that HEADERS were found, which is not the same as slots
    //     being READABLE - getServerInfo() returns null for any cell
    //     with no <a>, so a maintenance banner, a partial render or a
    //     detached header cache produced headerCount > 0 with an empty
    //     seenKeys and every tracked state was deleted. The next scan
    //     re-baselined the whole rack, discarding every transition in
    //     that window, while the panel reported a healthy scan.
    //     Pruning now requires a plausible read (PRUNE_MIN_RATIO);
    //     anything less preserves state and goes DEGRADED.
    //   * DETECTION HEALTH. New always-visible OK/DEGRADED/BLIND chip
    //     in the panel title, plus a rate-limited toast on the
    //     transition edge. A tracker that cannot report its own
    //     blindness is not a monitoring tool.
    //   * TOAST COALESCING. One toast per transition was fine at 10
    //     servers and catastrophic at 500: a batch completing produced
    //     hundreds of simultaneous toasts, and the operator's rational
    //     response is to mute notifications - at which point
    //     monitoring has effectively stopped. Cards stay 1:1; above
    //     TOAST_INDIVIDUAL_LIMIT events per cycle the toasts become
    //     one summary. Passes are now silent, failures audible.
    //   * COLSPAN REFUSAL. th.cellIndex is matched against
    //     row.children[column]; any colspan/rowspan breaks that
    //     mapping and the result is not a MISSED alert but a FALSE one
    //     attributed to a real serial and written to the permanent
    //     log. Affected tables are now refused, loudly.
    //
    // P1 - CORRECTNESS AND RELIABILITY
    //   * Dedup no longer suppresses AUDIT LOG writes, only surfacing.
    //     The "the log can never develop silent holes" claim was false
    //     for a genuine repeat inside the cooldown. Repeats now bump a
    //     counter on the existing entry (bounded search), so the log
    //     is truthful without growing once per 4s scan tick. New
    //     "Repeats" column in the .csv export.
    //   * Stale header cache could hand scan() DETACHED nodes - empty
    //     row walks with a non-zero headerCount, i.e. the exact input
    //     that triggered the baseline wipe. isConnected check added.
    //   * A throw inside processSlot() aborted the remaining slots,
    //     skipped savePreviousStates() and left state half-mutated
    //     with no UI signal. Per-slot error boundary, counted into
    //     the health chip.
    //   * The early meta-refresh observer ran querySelectorAll over
    //     the WHOLE document for every parse mutation - O(mutations x
    //     nodes) during initial render on a page of hundreds of cells.
    //     Now filters addedNodes for META/HEAD and scans head only.
    //   * BACKGROUND TAB THROTTLING is surfaced. Chromium clamps
    //     hidden-tab timers to ~1/min, so the master tick, the refresh
    //     and the watchdog all degrade together - silently. Returning
    //     to the foreground force-restarts refresh and rescans.
    //   * pagehide added alongside beforeunload, which is unreliable
    //     on tab discard and crash.
    //   * The watchdog can now ABORT the in-flight soft refresh
    //     instead of only clearing the flag and leaving the fetch
    //     running underneath a second call.
    //   * MAX_RECENT_ALERT_KEYS is actually enforced - the expiry
    //     sweep alone did nothing when every key was still live,
    //     which is exactly the burst case the cap exists for.
    //   * Audit-log eviction at MAX_LOG_ENTRIES warns once instead of
    //     silently discarding the oldest records.
    //   * The unsafeWindow diagnostic is gated on Developer Mode at
    //     call time - page JS could otherwise fire toasts through the
    //     extension.
    //
    // STILL OPEN (tracked, not fixed here):
    //   * @match is host-agnostic; narrow it before publication.
    //   * @updateURL points at mutable main; pin to a tag and enable
    //     branch protection before a second person installs this.
    //   * randomTestServerInfo() still contains internal-looking
    //     identifiers - sanitize before publishing.
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
            : '0.9.5';

    const LOG_PREFIX = '[EVE Tracker]';


    // ============================================================
    // STORAGE KEYS
    // ============================================================

    const SETTINGS_KEY        = 'eveRackTrackerSettings';
    const PREV_STATES_KEY     = 'eveRackTrackerPreviousStates';
    const ACTIVE_ALERTS_KEY   = 'eveRackTrackerActiveAlerts';
    const RECENT_ALERTS_KEY   = 'eveRackTrackerRecentAlerts';
    const ALERT_LOG_KEY       = 'eveRackTrackerAlertLog';
    const LOG_DAY_KEY         = 'eveRackTrackerAlertLogDay';
    const ALERTS_COLLAPSED_KEY = 'eveRackTrackerAlertsCollapsed';
    const PANEL_POSITION_KEY  = 'eveRackTrackerPanelPosition';
    const MENU_STATE_KEY      = 'eveRackTrackerMenuState';
    const DEBUG_SNAPSHOT_KEY  = 'eveRackTrackerDebugSnapshot';
    const ALERT_PANEL_POSITION_KEY = 'eveRackTrackerAlertPanelPosition';


    // ============================================================
    // TUNABLES
    // ============================================================

    // ------------------------------------------------------------
    // LOG RETENTION - ONE CALENDAR DAY
    //
    // The log is a record of TODAY's floor, not an archive. Which
    // servers are racked, how many, and what they are changes daily, so
    // an entry from nine days ago is not context - it is noise that
    // makes today's counts wrong and eventually pushes real entries out
    // against the entry cap.
    //
    // The boundary is the LOCAL CALENDAR DATE and nothing else. An
    // entry stamped 09/10 belongs to 09/10 whether it landed at 00:04
    // or at 23:59, and shifts do not enter into it. There is no offset
    // to configure, so the date on an entry and the date on the export
    // can never disagree.
    // ------------------------------------------------------------

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

    // Fraction of tracked slots that must be readable before a scan is
    // trusted enough to PRUNE the ones it did not see. Loosening this
    // constant is what re-opens the baseline-wipe bug - measure before
    // you change it.
    const PRUNE_MIN_RATIO = 0.5;

    // Events per scan cycle above which desktop toasts collapse into a
    // single summary. In-page cards stay 1:1 regardless.
    const TOAST_INDIVIDUAL_LIMIT = 3;

    // Health toasts are edge-triggered AND rate limited, so a flapping
    // page cannot spam the desktop.
    const HEALTH_TOAST_MIN_INTERVAL_MS = 300000;

    // Consecutive zero-header scans before declaring BLIND (~12s at the
    // 4s scan cadence). Tolerates a single mid-swap scan.
    const BLIND_SCAN_THRESHOLD = 3;

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

    // Hoisted so autoRefreshWatchdog() can ABORT a hung fetch, not
    // merely clear the flag and leave the request running underneath
    // a second call that could swap tables concurrently.
    let softRefreshController = null;

    // Session-only. Repeated failures must NOT write a permanent
    // disable into localStorage - the user would never get soft
    // refresh back without knowing to re-tick the box.
    let softRefreshDisabledForSession = false;

    let pageObserver = null;
    let observerSuppressDepth = 0;

    let alertFilter = 'all';
    let alertSearch = '';



    function log(...args)  { console.log(LOG_PREFIX, ...args); }
    function warn(...args) { console.warn(LOG_PREFIX, ...args); }
    function fail(...args) { console.error(LOG_PREFIX, ...args); }

    // Developer-only logging. Keeps production consoles readable.
    function devLog(...args) {
        if (settings && settings.developerMode) {
            console.log(LOG_PREFIX + '[DEV]', ...args);
        }
    }


    // ============================================================
    // DETECTION HEALTH
    // ============================================================
    //
    // The failure mode that matters for a monitoring tool is not a
    // crash - it is continuing to LOOK healthy while seeing nothing.
    // A DOM change, a partial render or a detached header cache all
    // produce a tracker that counts down to its next refresh, reports
    // no alerts, and is indistinguishable from "everything is passing".
    //
    //   OK        headers found and a plausible number of slots read
    //   DEGRADED  read far fewer slots than tracked, a table was
    //             refused, slots threw, or the tab is backgrounded
    //   BLIND     no EVE headers at all - the page structure changed
    //
    // Surfaced on the panel title while Developer Mode is enabled.
    // The underlying automatic health state remains available to the
    // tracker, but the visual chip is hidden from normal production use.
    // ============================================================

    let healthState       = 'OK';
    let healthDetail      = '';
    let lastHealthToastAt = 0;
    let blindScans        = 0;


    function reportHealth(state, detail, quiet) {

        const changed = state !== healthState;

        healthState  = state;
        healthDetail = detail || '';

        const chip = document.getElementById('eve-health-chip');

        if (chip) {
            chip.textContent = state;
            chip.className   = 'eve-health-chip eve-health-' + state.toLowerCase();
            chip.title       = healthDetail || 'Detection is healthy.';
        }

        if (!changed) {
            return;
        }

        if (state === 'OK') {
            log('Health: OK \u{2014} detection restored.');
            return;
        }

        fail(`Health: ${state} \u{2014} ${healthDetail}`);

        // quiet = chip only. For states the user caused and can see for
        // themselves (backgrounded tab), where a toast is noise.
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

        // The cache holds live <th>/<table> references. withoutObserver()
        // discards every queued mutation record, including unrelated page
        // changes that detached them - at which point querySelectorAll(
        // 'tbody tr') returns empty while headerCount stays non-zero,
        // which is precisely the input that used to wipe every baseline.
        // Cheap identity check beats rebuilding on every call.
        if (!root && cachedGroups) {

            const first = cachedGroups[0];

            if (!first || first.table.isConnected) {
                return cachedGroups;
            }

            cachedGroups = null;

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

        // th.cellIndex is matched against row.children[column]. Any
        // colspan/rowspan breaks that mapping, and the result is not a
        // MISSED alert but a FALSE one - attributed to a real serial and
        // written to the permanent audit log. Refuse the table rather
        // than guess. This is the one place failing CLOSED is right:
        // wrong data is worse than no data.
        const groups = [];

        byTable.forEach(group => {

            const spanned =
                group.table.querySelector(
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
            'overdue. Aborting any in-flight fetch and rescheduling. If ' +
            'this repeats, the network path to the page is the problem.'
        );

        // Clearing the flag without aborting left the fetch running, so
        // a second performSoftRefresh() could swap tables concurrently.
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

        softRefreshController = controller;

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

            softRefreshController = null;
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

            // Passes are the common case, failures are the actionable
            // one. Making both audible inverts the signal-to-noise
            // ratio and trains the operator to ignore the sound.
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
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAE8UlEQVR42u3dUVIUSRhG0ep/g2wVV4hvPhiGCnR1ZdY9dwNDZ34nBydGeLwfUrdxBAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAr+7t4wMA95Fe/w3OfNyHvvPW7H7m4z70zX/Tbn3m4z70/e8z9z3zcR96yp+yNj3zcR961n9j2PHMx33oiSe53ZmP+9Bzz3CvMx/3oaef3kZnPu5DZ5zbLmc+7kMnndgWZz7uQ+ed1fpnPu5Dp57S4mc+7kNnn8/KZz7uQy84mWXPfNyHXnMma575uA+97DQWPPNxH3rlOax25uM+rP/2/8SdAMTvI/LZ1znzcR9ZA9d+6kXOfNxH08AKn3eFr2HcR9DAOp/08q9knELNwGqf8dqvZ9xHysCan+7Cr2rcR8fAsp/rx+MRBXDhJ68ZsP5FvwViwPrrfwhmwPrTABiw/joABqy/DoAB668DYMD66wAYsP46AAasvw6AAeuvA2DA+usAGLD+OgAGrL8OgAHrrwNgwPrrABiw/joABqy/DoAB668DYMD66wDKBqwfgK4B6wega8D6AegasH4AugasH4CuAesHoGvA+gHoGrB+ALoGrB+ArgHrB6BrwPoB6BqwfgC6BqwfgK4B6wega8D6AegasP4Le7wflcq/Ed760/8GSN2oswLAvTolANyu8wHAHTsZANy0MwHAfTsNANy6cwDA3TsBACzA+gGI78D6AeiuwfoB6G7C+gHoLsP6Aejuw/oB6K7E+gHobsX6AeguxvoB6O7G+gHorsf6AehuyPoB6C7J+gHo7sn6AeiuyvoB6G7L+gHoLsz6ATi9lX/CnJ9+B0B9YQwAUN8WAwDUV8UAAPU9MQBAfUkMAFDfEAMA1NfDAAD13TAAQH0xDABQ3woDANRXwgAA9X0wAEB9GQwAUN8EAwDU18AAAPUdMDDW7wQAcPcMAODWGQDAfTMAgJtmAAB3zAAAbpcBANwrAwC40XNa9me5RQyM9V++fgYAqL/9DABQ/86HAQDq3/czAED9T70MANBdPwMA1NfPAAD19TMAQH39DABQXz8DANTXzwAA9fUzAEB9/QwAUF8/AwDU188AAPX1MwBAff0MAODvdjEQBmD9DHQBWD8DXQDWz0AXgPUz0AVg/Qx0AVg/A10A1s9AF4D1M9AFYP0MdAFYPwNdANbPQBeA9TPQBWD9DHQBWD8DXQDWz0AXgPUz0AVg/T7RtRsYt1JYPwPrfgvk/yrz6S78qsatdNbvxVkUwOFvlnhx4gAOf7fQixMHcPjb5V6cOIDDzxfx4sQBHH7ClBcnDuDI/4xBL04dwBH+KbNeHABOPy/r9+JsAOCI/aYJLw4Ap5+d9XtxNgNwBH7bnBcHgNPP0fq9OBsDOG76G6e9OACcfqbW78W5CYAvnKz1e3FuBeBT52v9XpwbAvjPU7Z+L85tAfzzrK3fi3NzAH85cev34iQA/PHcrd+LEwLw2+lbvxcnB+DXHVi/F+ezPd7dp77U28fHDV4cAJRuHIEAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQvtdPemt/a0HAQ/wAAAAASUVORK5CYII=';

    const ICON_PASS =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAEZUlEQVR42u3c3ZHTShhFUcyTicPk6Ql08uCVACiq5key+uu9dgAwI53VslXce7s/Hz+kaj9dAgEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAAkAKT/9+ftHQCl17+rAQD00bN/SwO3+/PhNutTn3x+vf32BBAYAKi68m0MAKAv7nsPAwDo68vewAAA+tampxvwFkjHrHnoqyFPAB1zlg99FACgVQgBoPHbHWcAAB282lkGALD+9xF/5kl5C2T9J7b+qyFPAOtPfy0GwPrTBgBQ2gAAFpk2AID1pw14C2T9r26pV0OeANaffhQAYP3pHwYA609/CgJAvgPI8Z9cPwDWXw8A6+8e/wBYf3r9AFh/ev0AWH96/QAovX4AHP/1ALD+7vEPgPWn1w+A9afXD4D1p9cPgPWn1w+A0usHwPFfDwDr7x7/AFh/ev0AWH96/QBYf3r9AFh/ev0AqB4Ajv/u8Q+A9afXD4D1p9cPgPWn1w+A9afXD4D1p9cPgPXXA0Dd4x8Ax396/TsDGP35wfoBOGBAQw1YPwCHDWicAesH4Fvr+XdAgwx47QPAKesZMawFf8jtj/99ADg7rb8L4CPrX1yIj/4AnD6dZQ1YPwAvms6CBqz/2m7356P2oX+de2z9ngAX7GaR2fniDsBlu7l8fF56AnDxbhzA1j8MwOGTvcqAj/4AdA9s61+qAW+Bzl7MKxdg/Z4Ayy3mZaP0rQOA7jS99gFg6cWc+tdZPwADFtP5iGL9SwO4cIhn/NW++K7cWm+BFtnKgROxfk+AeVs56iexfgC6n7+99ARg8OG0xz84dfxP+gi0jQHrB8BzwFUFIGnAF18Admvuf3dv/SMBLHjbJv6fV6x/8BNgnAEvPQHoGvDaB4DuXbR+AEL3cv2POta/FYDFDfjiC0DXgPUD0M1rHwAcb64PAO6xKwOAO+2aAOB+uxoAuOuuAwDuvSsAgAUIAAb84gDI+gGwBr8vADbhNwXAMvyOANiHAGDArwaAoVg/AOZi/QDI+gGwG+sHwHqsHwAbEgBNA+gC0B2T9QPQnZT1A9AdlvUD0J2X9QMgAZA8ZR3/AHSnZv0AdAdn/QB0Z2f9AHTHZ/0AdA1YPwCeAwKAOgGQmqP1A9A1YP0AdA1YPwBdA9YPgOeAAEga4AqArgHrB6BrwPoBoEgA9OZr/QB0DVg/AJ4DAiBpgBkAugasH4CuAesHoGvA+gFgQwAYugBIGaACgK4B6wega8D6p3e7Px+ugjwBJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAEgEsgACQApF5/ASm83YWSRjGVAAAAAElFTkSuQmCC';


    function getTransitionIcon(transition) {

        if (
            transition === 'TEST_SUCCESS' ||
            transition === 'PRETEST_SUCCESS'
        ) {
            return ICON_PASS;
        }

        // A diagnostic is not a failure, so it must not carry the red X
        // on the one occasion it does reach the desktop (the retraction
        // of an alert that turned out to be SYS_DEKIT).
        if (isDiagnosticTransition(transition)) {
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

        if (transition === 'PRETEST_SUCCESS') {
            return 'Pre-Testing \u{1f537}. . . \u{25ba} Pre-Test PASS \u{2705}';
        }

        if (transition === 'DEKIT_FAILURE') {
            return 'SYS_DEKIT \u{1f527}. . . \u{25ba} diagnostic, Pass=0';
        }

        if (transition === 'DEKIT_SUCCESS') {
            return 'SYS_DEKIT \u{1f527}. . . \u{25ba} diagnostic, Pass=1';
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

        if (transition === 'PRETEST_SUCCESS') {
            return 'PRE-TEST PASS \u{2705}';
        }

        if (isDiagnosticTransition(transition)) {
            return 'SYS_DEKIT \u{1f527}';
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

        // Gated on Developer Mode at CALL time: page JavaScript can
        // reach anything on unsafeWindow, and this fires five toasts
        // through the extension. Low impact, but no reason to leave
        // it armed on a page the tracker does not control.
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
    // PHASE CONFIRMATION  (authoritative, from the detail page)
    // ============================================================
    //
    // WHY THIS EXISTS
    //
    // The original design inferred the TEST PHASE from the cell COLOR:
    //
    //     lightblue  -> red        assumed PRE-TEST FAIL
    //     lightgreen -> red        assumed TEST FAIL
    //
    // That premise is false. A server observed going lightgreen -> red
    // on the rack page had, on its own detail page:
    //
    //     taskset:        PRETEST
    //     taskset_status: FAIL
    //     Operation:      PRETEST
    //
    // So a machine in PRE-TEST renders LIGHT GREEN while it is running.
    // Color is a STATUS channel (queued / running / failed / passed),
    // not a PHASE channel. The two were conflated, which means:
    //
    //   * Any pre-test that renders green before failing - i.e. most of
    //     them, since 5_POWER_ON takes time - was logged as TEST FAIL.
    //   * lightblue -> red only ever caught a pre-test that died before
    //     it went green.
    //   * The permanent audit log has been recording the wrong CATEGORY,
    //     which is the failure that actually matters here.
    //
    // Compounding it, getTestPhaseHint() reads only data- attributes.
    // This page emits legacy bgcolor markup and no data- attributes at
    // all, so info.phase was ALWAYS '' and the re-label branch in
    // getTransitionType() never executed once in production.
    //
    // THE FIX
    //
    // Color still DETECTS the event - it is the only per-scan signal
    // available, and it is cheap. But the LABEL now comes from the
    // server's own detail page, which states the phase explicitly.
    // One fetch per detected event, never per scan.
    //
    // Failing to confirm must not silently produce a confident wrong
    // label, so an unconfirmed alert is marked as such in the card, the
    // toast and the log rather than asserting a phase it did not verify.
    // ============================================================

    const PHASE_CONFIRM_TIMEOUT_MS    = 10000;
    const PHASE_CONFIRM_MAX_PARALLEL  = 4;
    const PHASE_CONFIRM_CACHE_MS      = 120000;

    // How long flushPendingToasts() will wait for confirmations before
    // sending anyway. A fail toast three seconds late is fine; a fail
    // toast with the wrong phase on it is not.
    const TOAST_CONFIRM_WAIT_MS       = 8000;

    const phaseConfirmCache = new Map();

    let phaseConfirmActive  = 0;
    let phaseConfirmQueue   = [];
    let phaseConfirmFailures = 0;


    // ------------------------------------------------------------
    // Normalize whatever the page calls the phase into PRETEST / TEST.
    // "PRETEST", "Pre-Test", "pre_test" and "PRE TEST" all appear in
    // the wild depending on which column you read.
    // ------------------------------------------------------------

    // ------------------------------------------------------------
    // OPERATION -> PHASE
    //
    // v0.9.5. The old version matched only /pre-?test/ and /\btest\b/.
    // The Operation column on the real page does NOT contain the word
    // "test" for the regular stage - it says SLT (System Level Test).
    // So every regular-stage row fell through to '' and every card
    // ended up "phase NOT verified - detail page did not state a
    // phase", which is what the field screenshots show.
    //
    // The page's operation vocabulary is a small closed set with
    // exactly one pre-test value. Anything that is NOT a pre-test
    // operation is, by definition, a post-pre-test stage, so the
    // fallback is TEST rather than ''. Whether the word was RECOGNISED
    // or merely assumed is reported separately (phaseExact) and the
    // literal operation string is kept and displayed, so an operation
    // this script has never seen shows up verbatim on the card instead
    // of being silently discarded.
    // ------------------------------------------------------------

    const PRETEST_OPERATION_RE = /pre[\s_-]*test|^pt$/;

    const TEST_OPERATION_RE =
        /\bslt\b|\btest(?:ing)?\b|\bburn[\s_-]*in\b|\brun[\s_-]*in\b|\bft\b/;

    // SYS_DEKIT is neither pre-test nor test. It is a housekeeping /
    // diagnostic pass the factory runs against a server, it routinely
    // finishes with Pass=0, and none of that is a hardware result an
    // operator should be woken up for. Without this it matched the
    // "not a pre-test word, therefore TEST" fallback below and every
    // SYS_DEKIT row was being reported as a TEST FAIL.
    const DEKIT_OPERATION_RE = /\bsys[\s_-]*dekit\b|\bdekit\b/;


    function normalizePhaseWord(raw) {

        const value = String(raw || '').trim().toLowerCase();

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


    // Did we RECOGNISE the operation word, or just assume TEST because
    // it was not a pre-test word? Drives phaseExact on the result.

    function isKnownOperationWord(raw) {

        const value = String(raw || '').trim().toLowerCase();

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

        const value = String(raw || '').trim().toLowerCase();

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


    // ------------------------------------------------------------
    // THE Pass COLUMN IS THE RESULT
    //
    // Per-row boolean: 1 = that operation passed, 0 = it did not.
    // taskset_status is empty on PRETEST rows, so it cannot be the
    // primary signal - the boolean can, and is.
    //
    // Returns 1, 0 or null (column absent / not a boolean).
    // ------------------------------------------------------------

    function normalizePassFlag(raw) {

        const value = String(raw || '').trim().toLowerCase();

        if (value === '1' || value === 'true' || value === 'y') {
            return 1;
        }

        if (value === '0' || value === 'false' || value === 'n') {
            return 0;
        }

        return null;

    }


    // ------------------------------------------------------------
    // Read the two things the detail page states explicitly:
    //
    //   Server Information -> Server Serial   (identity check)
    //   Test Status        -> Operation / taskset / taskset_status
    //
    // Columns are located BY HEADER NAME, never by fixed index - the
    // detail page is not ours and column order can move.
    // ------------------------------------------------------------

    // Cell text arrives with newlines and stacked values (the taskcase
    // column holds several task names in one cell), so collapse
    // whitespace rather than comparing raw textContent.

    function cellText(cell) {
        return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
    }


    function parseDetailDocument(doc, serial) {

        const result = {
            confirmed: false,
            phase: '',

            // The literal Operation cell ("PRETEST", "SLT", ...) so the
            // card can show what the page actually said.
            operation: '',

            // false = phase was ASSUMED from "not a pre-test word".
            phaseExact: false,

            status: '',

            // 1 / 0 / null - the authoritative per-row result.
            pass: null,

            // true = the chosen row has not finished, so its Pass value
            // is not a result yet and must not be read as one.
            running: false,

            // Independent of `confirmed`: the phase can be known while
            // the result is still pending.
            resultConfirmed: false,

            taskset: '',
            taskcase: '',
            started: '',
            finished: '',
            serialOnPage: '',
            serialMatches: null,

            // Rack Serial / Position from the detail page, used to
            // verify that the slot the tracker READ is the slot this
            // server actually occupies.
            rackSerialOnPage: '',
            positionOnPage: '',
            locationMatches: null,

            reason: ''
        };

        if (!doc || !doc.body) {
            result.reason = 'empty document';
            return result;
        }

        // ----- identity: Server Serial from the property table -----

        doc.querySelectorAll('tr').forEach(row => {

            const cells = row.children;

            if (cells.length < 2) {
                return;
            }

            const label = cellText(cells[0]).toLowerCase();

            if (
                !result.serialOnPage &&
                (label === 'server serial' || label === 'server asset')
            ) {
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
            result.serialMatches =
                result.serialOnPage.toUpperCase() ===
                String(serial).toUpperCase();
        }

        // ----- the Test Status table -----

        let statusTable = null;
        let columnIndex = null;

        const tables = [...doc.querySelectorAll('table')];

        for (const table of tables) {

            const headerCells =
                [...table.querySelectorAll('th')]
                    .map(th => th.textContent.trim().toLowerCase());

            if (!headerCells.length) {
                continue;
            }

            const hasPhase =
                headerCells.includes('operation') ||
                headerCells.includes('taskset');

            const hasStatus =
                headerCells.includes('taskset_status') ||
                headerCells.includes('pass');

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

        // ----- pick the row -----
        //
        // Prefer the row whose SN matches the serial we are confirming.
        // Otherwise take the LAST row, which is the most recent attempt.

        const bodyRows =
            [...statusTable.querySelectorAll('tr')]
                .filter(row => row.querySelector('td'));

        if (!bodyRows.length) {
            result.reason = 'Test Status table has no data rows';
            return result;
        }

        // A server that has been retested has SEVERAL rows for the same
        // SN - the real page shows two PRETEST FAILs 45 minutes apart.
        // Take the row with the LATEST Started, not the last row in
        // document order: nothing guarantees the page sorts ascending,
        // and picking the wrong row means reporting a stale result.

        const snIndex      = columnIndex.sn;
        const startedIndex = columnIndex.started;

        const wanted = serial ? String(serial).toUpperCase() : '';

        const candidates =
            (snIndex !== undefined && wanted)
                ? bodyRows.filter(row =>
                    cellText(row.children[snIndex]).toUpperCase() === wanted)
                : [];

        const pool = candidates.length ? candidates : bodyRows;

        let chosen = pool[pool.length - 1];

        if (startedIndex !== undefined && pool.length > 1) {

            let best = '';

            pool.forEach(row => {

                // "2026-09-09 21:51:10" sorts correctly as a string.
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

        result.taskset  = readColumn('taskset');
        result.taskcase = readColumn('taskcase');
        result.finished = readColumn('finished');

        // ----- phase: Operation, then taskset as a fallback -----

        const operationCell = readColumn('operation');

        result.operation = operationCell || result.taskset || '';

        result.phase =
            normalizePhaseWord(operationCell) ||
            normalizePhaseWord(result.taskset);

        result.phaseExact =
            isKnownOperationWord(operationCell) ||
            isKnownOperationWord(result.taskset);

        // ----- result: the Pass boolean is authoritative -----
        //
        // Pass is 1 or 0 on EVERY row. taskset_status is blank on
        // PRETEST rows, so it corroborates but never leads.

        result.pass = normalizePassFlag(readColumn('pass'));

        const statusWord = normalizeStatusWord(readColumn('taskset_status'));

        // A row with no Finished timestamp and no status word has not
        // produced a result yet. Its Pass column reads 0 because it has
        // not passed YET, not because it failed - reading that as a
        // failure would invent one.
        result.running = !result.finished && !statusWord;

        if (result.running) {

            result.status = '';
            result.reason = 'that operation is still running';

        } else if (result.pass === 1) {

            result.status = 'PASS';

        } else if (result.pass === 0) {

            result.status = 'FAIL';

        } else {

            // No usable Pass column - fall back to the words.
            result.status = statusWord;

        }

        // The Pass boolean and taskset_status disagreeing means one of
        // the two columns is not what this script thinks it is. Say so
        // rather than picking a winner silently.
        if (
            statusWord &&
            result.status &&
            statusWord !== result.status
        ) {

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

        // Phase is confirmed even when the result is still pending -
        // knowing the server is in SLT is worth having on the card.
        result.confirmed = true;

        if (!result.reason && !result.resultConfirmed) {
            result.reason = 'detail page stated no result for that row';
        }

        return result;

    }


    // ------------------------------------------------------------
    // Fetch + parse one detail page, with a concurrency cap so that a
    // burst of 50 simultaneous failures does not open 50 sockets.
    // ------------------------------------------------------------

    function fetchDetailDocument(url) {

        return new Promise(resolve => {

            const run = async () => {

                phaseConfirmActive += 1;

                const controller = new AbortController();

                const abortTimer =
                    setTimeout(
                        () => controller.abort(),
                        PHASE_CONFIRM_TIMEOUT_MS
                    );

                try {

                    const response =
                        await fetch(url, {
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

                    const html = await response.text();

                    resolve(
                        new DOMParser()
                            .parseFromString(html, 'text/html')
                    );

                } catch (error) {

                    devLog(
                        'Phase confirmation fetch failed:',
                        (error && error.message) ? error.message : error
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


    // ------------------------------------------------------------
    // Does the detail page agree about WHERE this server is?
    //
    // The rack page gives us section/eve/unit purely from column
    // arithmetic (th.cellIndex -> row.children[column]). The detail
    // page states Rack Serial and Position independently. If those
    // disagree, the tracker read the WRONG CELL - which is the colspan
    // /column-misalignment failure, caught at runtime against live data
    // instead of by inspecting markup.
    // ------------------------------------------------------------

    // The rack page header and the detail page's Rack Serial are two
    // different systems printing the same identifier, and they do not
    // agree on zero padding (EVE5 vs EVE05) or on what may trail it.
    // Compare the PARTS, not the strings, or the check reports a
    // mapping fault every time the two spell the same rack differently.

    function normalizeRackSerial(value) {

        const text = String(value || '').trim().toUpperCase();

        const match = text.match(/^TA\.([^-]+)-EVE0*(\d+)/);

        return match
            ? `TA.${match[1]}-EVE${parseInt(match[2], 10)}`
            : text;

    }


    function checkLocationAgreement(parsed, info) {

        if (!parsed.rackSerialOnPage || !info) {
            return null;
        }

        // A restored record with no slot parts cannot be checked. Say
        // "unknown" rather than comparing against "TA.undefined-
        // undefined" and raising a slot-mismatch alarm about nothing.
        if (!info.section || !info.eve || !info.unit) {
            return null;
        }

        const expectedRack = `TA.${info.section}-${info.eve}`;

        const rackOk =
            normalizeRackSerial(parsed.rackSerialOnPage) ===
            normalizeRackSerial(expectedRack);

        // Position is a bare number; unit is U05 / U15. Compare
        // numerically so zero padding cannot cause a false alarm.
        let positionOk = true;

        if (parsed.positionOnPage) {

            const pagePosition = parseInt(parsed.positionOnPage, 10);
            const unitNumber = parseInt(String(info.unit).replace(/\D/g, ''), 10);

            if (
                !Number.isNaN(pagePosition) &&
                !Number.isNaN(unitNumber)
            ) {
                positionOk = pagePosition === unitNumber;
            }

        }

        return {
            ok: rackOk && positionOk,
            expected: `${expectedRack} / U${String(info.unit).replace(/\D/g, '')}`,
            actual: `${parsed.rackSerialOnPage} / position ${parsed.positionOnPage || '?'}`
        };

    }


    // ------------------------------------------------------------
    // WHEN IS A SLOT DISAGREEMENT A COLUMN-MAPPING FAULT?
    //
    // v0.9.5. It used to be: always, on the first one, straight to a
    // DEGRADED desktop toast reading "This page may NOT be monitored".
    //
    // That is the wrong inference from a sample of one. Column mapping
    // is a property of a TABLE, not of a server: if th.cellIndex were
    // being read against the wrong column, essentially every server in
    // that table would land in the wrong slot, not one. A single
    // disagreement is far more likely to be a machine that moved, a
    // detail page that has been updated since the rack page rendered,
    // or a stale row.
    //
    // So: count. Escalate only when the evidence actually looks like a
    // mapping fault - several disagreements in one table and not one
    // agreement. A lone disagreement is logged and nothing else.
    // ------------------------------------------------------------

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

        // live:false = this is a retroactive re-check of a stored card,
        // not a reading taken just now.
        const checkLocation = !options || options.live !== false;

        const url = safeUrl(detailUrl);

        if (!url) {
            return {
                confirmed: false,
                reason: 'no detail URL on this cell'
            };
        }

        // Started is not known yet, so cache on identity only and keep
        // the TTL short - a retest must not read a stale confirmation.
        const cacheKey = `${url}|${serial}`;

        const cached = phaseConfirmCache.get(cacheKey);

        // force = a deliberate re-check of a card whose result was
        // pending. Serving it the same cached "pending" answer it is
        // retrying BECAUSE of would make the retry a no-op.
        const force = !!(options && options.force);

        if (
            !force &&
            cached &&
            (Date.now() - cached.at) < PHASE_CONFIRM_CACHE_MS
        ) {
            return cached.value;
        }

        const doc = await fetchDetailDocument(url);

        if (!doc) {

            phaseConfirmFailures += 1;

            const value = {
                confirmed: false,
                reason: 'detail page unreachable'
            };

            phaseConfirmCache.set(cacheKey, { at: Date.now(), value: value });

            return value;

        }

        const parsed = parseDetailDocument(doc, serial);

        if (parsed.confirmed) {
            phaseConfirmFailures = 0;
        } else {
            phaseConfirmFailures += 1;
        }

        // Labels silently reverting to colour guesses is exactly the
        // condition that produced the original mislabelling, so it must
        // be visible rather than inferred from the console.
        if (phaseConfirmFailures >= 3) {
            reportHealth(
                'DEGRADED',
                'Phase confirmation is failing. PRE-TEST vs TEST labels ' +
                'are falling back to colour guesses and may be wrong.'
            );
        }

        // A detail page for a DIFFERENT server means the cell's link is
        // wrong, and every label derived from it would be about the
        // wrong machine. Never silently accept that.
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

            phaseConfirmCache.set(
                cacheKey,
                { at: Date.now(), value: mismatch }
            );

            return mismatch;

        }

        // Independent verification that we read the right CELL. The
        // serial matching only proves the LINK is right; this proves
        // the slot arithmetic is right.
        //
        // Only meaningful for a CONTEMPORANEOUS reading. Re-confirming
        // a card restored from an earlier session compares a slot
        // recorded hours ago against where that server sits now, and a
        // failed server that has since been pulled and re-racked will
        // always "disagree" - correctly, and about nothing.
        const location =
            checkLocation
                ? checkLocationAgreement(parsed, info)
                : null;

        parsed.locationMatches = location ? location.ok : null;

        if (location && !location.ok) {
            noteSlotDisagreement(serial, info, location);
        } else if (location && location.ok) {
            noteSlotAgreement(info);
        }

        phaseConfirmCache.set(cacheKey, { at: Date.now(), value: parsed });

        return parsed;

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

    // Colors that mean "this slot was in an active, pre-result state".
    // A move from any of these to red is a real result.
    //
    // darkgreen is included deliberately: a server that passed and is
    // then retested and fails goes darkgreen -> red. Missing that failure
    // would be worse than reporting a redundant transition.
    const FAILURE_FROM_COLORS = ['lightblue', 'lightgreen', 'darkgreen'];


    // ------------------------------------------------------------
    // Color DETECTS the event and supplies a PROVISIONAL label. The
    // phase in that label is a guess and is overwritten by
    // confirmPhase() as soon as the detail page answers.
    //
    // Provisional phase is the old color's best guess only so that a
    // card can appear instantly; nothing downstream may treat it as
    // authoritative. phaseSource on the record says which it is.
    // ------------------------------------------------------------

    function getTransitionType(oldColor, newColor) {

        if (
            newColor === 'red' &&
            FAILURE_FROM_COLORS.indexOf(oldColor) !== -1
        ) {
            return oldColor === 'lightblue'
                ? 'PRETEST_FAILURE'
                : 'TEST_FAILURE';
        }

        // Pre-test success (lightblue -> darkgreen) is intentionally
        // ignored because it immediately continues into regular test.
        if (newColor === 'darkgreen' && oldColor === 'lightgreen') {
            return 'TEST_SUCCESS';
        }

        return null;

    }


    // ------------------------------------------------------------
    // RESOLVE THE FINAL LABEL FROM THE DETAIL PAGE
    //
    // v0.9.5. The old applyPhaseToTransition() could only swap the
    // PHASE half, and only on a card that was already a FAILURE. That
    // left the RESULT half permanently owned by cell colour, which is
    // the other half of the same bug: the detail page states the result
    // explicitly as a per-operation boolean and was being ignored.
    //
    // The detail page is authoritative, with ONE deliberate asymmetry:
    //
    //   detail says FAIL  -> always applied. A failure is never lost.
    //   detail says PASS  -> applied only if the colour did not already
    //                        say FAILURE.
    //
    // The asymmetry exists because the Test Status table can lag the
    // rack colour by a scan or two. If colour has gone red and the
    // newest row still shows the previous operation passing, that row
    // is stale; downgrading a red to a PASS on the strength of it would
    // silently drop a real failure. Upgrading in the other direction
    // costs nothing worse than one card that says FAIL for a few more
    // seconds than it had to.
    // ------------------------------------------------------------

    const TRANSITION_BY_PHASE_RESULT = {
        'PRETEST|FAIL': 'PRETEST_FAILURE',
        'PRETEST|PASS': 'PRETEST_SUCCESS',
        'TEST|FAIL':    'TEST_FAILURE',
        'TEST|PASS':    'TEST_SUCCESS',
        'DEKIT|FAIL':   'DEKIT_FAILURE',
        'DEKIT|PASS':   'DEKIT_SUCCESS'
    };


    // Diagnostic events are recorded and labelled like anything else.
    // What they never do is interrupt anyone.

    function isDiagnosticTransition(transition) {
        return /^DEKIT_/.test(String(transition || ''));
    }


    function resolveTransitionFromDetail(transition, parsed) {

        if (!parsed || !parsed.phase) {
            return transition;
        }

        const provisionalIsFailure = /FAILURE$/.test(transition);

        // A diagnostic pass is not a hardware result in either
        // direction, so it overrides the colour outright rather than
        // being merged with it. Colour saw the cell go red; the page
        // says that red is SYS_DEKIT, and SYS_DEKIT going red is not a
        // failure of anything.
        if (parsed.phase === 'DEKIT') {
            return parsed.status === 'PASS'
                ? 'DEKIT_SUCCESS'
                : 'DEKIT_FAILURE';
        }

        // No result on the page yet: keep the colour's result half and
        // correct the phase half only.
        if (!parsed.status) {

            if (!provisionalIsFailure) {
                return transition;
            }

            return parsed.phase === 'PRETEST'
                ? 'PRETEST_FAILURE'
                : 'TEST_FAILURE';

        }

        // Never let a stale PASS row erase a failure the colour caught.
        if (parsed.status === 'PASS' && provisionalIsFailure) {

            return parsed.phase === 'PRETEST'
                ? 'PRETEST_FAILURE'
                : 'TEST_FAILURE';

        }

        return (
            TRANSITION_BY_PHASE_RESULT[`${parsed.phase}|${parsed.status}`] ||
            transition
        );

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

            // The expiry sweep alone does NOTHING when every key is
            // still live - which is exactly the burst case this cap
            // exists for. Evict oldest-first until it actually holds.
            if (recentAlerts.size > MAX_RECENT_ALERT_KEYS) {

                const ordered =
                    [...recentAlerts.entries()]
                        .sort((a, b) => a[1] - b[1]);

                const excess =
                    recentAlerts.size - MAX_RECENT_ALERT_KEYS;

                for (let i = 0; i < excess; i += 1) {
                    recentAlerts.delete(ordered[i][0]);
                }

            }

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

        // Slots that threw. Fed into the health chip, because a scan
        // that partially failed must not look like a clean one.
        let slotErrors = 0;

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

                    // One malformed cell must not abort the remaining
                    // slots. The old shape terminated the whole scan,
                    // skipped savePreviousStates(), and left in-memory
                    // state half-mutated with no UI signal at all.
                    try {

                        processSlot(header, unit, info, seenKeys, () => {
                            statesDirty = true;
                        });

                    } catch (error) {

                        slotErrors += 1;

                        fail(
                            'processSlot threw for ' +
                            `${header.section}|${header.eve}|${unit}:`,
                            error
                        );

                    }

                });

            });

        });

        // ----------------------------------------------------
        // PRUNE VANISHED SLOTS
        // ----------------------------------------------------
        //
        // The old guard checked that HEADERS were found. That is NOT
        // the same as slots being READABLE: getServerInfo() returns
        // null for any cell with no <a>, so a maintenance banner, a
        // partial render, a markup tweak or a detached header cache all
        // produced headerCount > 0 with an EMPTY seenKeys - and every
        // tracked baseline was deleted. The next scan then re-baselined
        // the whole rack, discarding every transition in that window,
        // while the panel reported a perfectly healthy scan.
        //
        // Preserve state and go DEGRADED instead. Never prune on a scan
        // that read implausibly few slots.

        if (headerCount && previousStates.size) {

            const floor =
                Math.max(
                    1,
                    Math.floor(previousStates.size * PRUNE_MIN_RATIO)
                );

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
                    devLog(
                        `Pruned ${pruned} slot(s) no longer present on the page.`
                    );
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

        // ----------------------------------------------------
        // BLIND DETECTION
        // ----------------------------------------------------
        //
        // Zero headers means the page structure changed, the page
        // failed to load, or the table is rendered by page JavaScript.
        // Whatever the cause, nothing is being monitored - and that
        // must not look identical to "no alerts because all is well".

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
                    `${slotErrors} slot(s) threw during this scan. See ` +
                    'the console for the failing keys.'
                );

            } else if (
                healthState !== 'OK' &&
                seenKeys.size &&
                !document.hidden
            ) {
                reportHealth('OK', '');
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


        // Coalesce this cycle's toasts. Must run after the WHOLE pass,
        // so a batch completing produces one summary, not a storm.
        flushPendingToasts();

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
            getTransitionType(oldState.color, info.color);

        if (!transition) {
            return;
        }

        // Dedup gates SURFACING only. It used to return above
        // recordTransition(), which made the "the log can never develop
        // silent holes" claim above FALSE: a genuine second failure of
        // the same slot+serial inside the cooldown was never recorded
        // at all. Repeats now bump a counter on the existing entry, so
        // the log stays truthful without growing once per 4s scan tick.
        const suppressed =
            isDuplicateAlert(key, info.serial, transition);

        // ----------------------------------------------------
        // LOG, CONFIRM, THEN SURFACE - IN THAT ORDER
        // ----------------------------------------------------
        //
        // The log entry is written first and unconditionally. The
        // per-section "Notifs" flag and the flap guard suppress the
        // CARD and the TOAST, never the record.
        //
        // Confirmation is attached to the EVENT, not to the card. It
        // used to be started inside surfaceAlert(), which meant a
        // transition in a muted section, or one suppressed as a flap
        // repeat, was written to the permanent log with
        // phaseSource 'color' and then never corrected - the audit
        // trail was only as good as the notification settings. Now the
        // fetch runs for every recorded event, the entry is updated
        // when it answers, and the card (if there is one) is reconciled
        // from that same promise rather than fetching the page twice.

        const eventId = recordTransition(info, transition, suppressed);

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


    // ============================================================
    // RECORD A TRANSITION (log + session counters)
    // ============================================================

    function recordTransition(info, transition, suppressed) {

        return logRealAlert(info, transition, !!suppressed);

    }


    // ------------------------------------------------------------
    // Confirm a recorded EVENT. Independent of whether that event is
    // ever shown to anyone.
    //
    // Returns the promise so surfaceAlert() can reuse it: one fetch per
    // event, log updated first, card reconciled after.
    // ------------------------------------------------------------

    function confirmEvent(info, transition, eventId) {

        if (!eventId || !info || !info.detailUrl || isDebugData(info)) {
            return null;
        }

        // A flap repeat re-points at an entry that is already fully
        // resolved. Re-fetching its detail page every 4s would add
        // nothing and cost a request each time.
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


    // ============================================================
    // SURFACE AN ALERT (in-page card + desktop toast)
    // ============================================================

    // Cards stay strictly 1:1 with transitions - the panel is the
    // complete record. Only the OS-level interrupt is rate limited.
    //
    // One toast per transition with a unique tag was correct at 10
    // servers and catastrophic at 500: a batch completing produces
    // hundreds of simultaneous toasts, and the operator's rational
    // response is to mute notifications - at which point monitoring
    // has effectively stopped.

    let pendingToasts = [];


    // A card whose label is corrected AFTER its toast has gone out is a
    // silent miss on the desktop: the confirmation fetch is bounded at
    // TOAST_CONFIRM_WAIT_MS and the queue is capped at four parallel
    // requests, so in a burst the toast fires on the colour's
    // provisional label - which for a pre-test failure reads TEST FAIL,
    // because colour cannot tell the two apart. The card then quietly
    // becomes PRE-TEST FAIL and the operator, who is watching the
    // desktop rather than the panel, never sees the distinction.
    //
    // So: when the label changes after the fact, say so.
    const CORRECTION_TOAST_MAX_AGE_MS = 1800000;


    // Records what the DESKTOP was told, which is not necessarily what
    // the card says a few seconds later.

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

        // Only the desktop needs telling. The card has already updated
        // itself in place.
        if (previousTransition === record.transition) {
            return;
        }

        // A reload can re-check cards from hours ago. Correcting the
        // label on those is right; interrupting someone about them is
        // not.
        if (
            !record.ts ||
            (Date.now() - Number(record.ts)) > CORRECTION_TOAST_MAX_AGE_MS
        ) {
            return;
        }

        if (isDebugData(record) && !settings.showDebug) {
            return;
        }

        const becameDiagnostic =
            isDiagnosticTransition(record.transition) &&
            !isDiagnosticTransition(previousTransition);

        // Turning out to be a SYS_DEKIT is the one correction worth
        // sending about a diagnostic: an alert already went out calling
        // it a failure, and leaving that standing sends someone to a
        // rack for nothing. Every other diagnostic transition stays
        // silent.
        if (isDiagnosticTransition(record.transition) && !becameDiagnostic) {
            return;
        }

        const title =
            becameDiagnostic
                ? 'SYS_DEKIT \u{1f527} \u{2014} NOT A FAILURE'
                : `${getTransitionTitle(record.transition)} \u{2014} CORRECTED`;

        const tail =
            becameDiagnostic
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
            record.detailUrl
                ? () => openFromNotification(record.detailUrl)
                : null
        );

    }


    function surfaceAlert(info, transition, eventConfirmation, eventId) {

        const record =
            createPersistentAlert(
                getTransitionTitle(transition),
                info,
                transition
            );

        // Both directions of the link. eventId is the stable one;
        // alertId lets the log entry be found from the card.
        record.eventId = eventId || '';

        linkLogEntryToAlert(eventId, record.id);

        updateStoredAlert(record);

        // Reuse the EVENT's confirmation rather than starting a second
        // fetch for the same server. The log is updated inside that
        // promise, so by the time the card reconciles the audit entry
        // is already correct.
        const confirmation =
            eventConfirmation
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


    // Called once at the END of scan(), so a whole refresh cycle's
    // events are weighed together rather than one at a time.

    async function flushPendingToasts() {

        let batch = pendingToasts;

        pendingToasts = [];

        if (!batch.length) {
            return;
        }

        // Wait for the detail pages to answer before the toast fires.
        // A fail toast a few seconds late is fine; a fail toast with
        // the WRONG PHASE printed on it is the bug we are fixing.
        // Bounded, so an unreachable detail page cannot hold the toast
        // for ever - it goes out marked unverified instead.
        const confirmations =
            batch
                .map(item => item.confirmation)
                .filter(Boolean);

        if (confirmations.length) {

            await Promise.race([
                Promise.allSettled(confirmations),
                new Promise(r => setTimeout(r, TOAST_CONFIRM_WAIT_MS))
            ]);

        }

        // Read the FINAL label off the record, not the provisional one
        // captured when the event was queued.
        batch.forEach(item => {
            item.transition = item.record
                ? item.record.transition
                : item.transition;
        });

        // SYS_DEKIT is a factory diagnostic, not a hardware result. The
        // card and the log entry both exist; the desktop is left alone.
        // Stamped as already-announced so the correction path below
        // does not later decide the desktop is owed an update about it.
        const diagnostics =
            batch.filter(item => isDiagnosticTransition(item.transition));

        diagnostics.forEach(item => {
            markToastSent(item.record, item.transition);
        });

        if (diagnostics.length) {
            devLog(
                `${diagnostics.length} SYS_DEKIT event(s) recorded ` +
                'without a desktop notification.'
            );
        }

        batch =
            batch.filter(item => !isDiagnosticTransition(item.transition));

        if (!batch.length) {
            return;
        }

        if (batch.length <= TOAST_INDIVIDUAL_LIMIT) {

            batch.forEach(item => {

                const unverified =
                    settings.developerMode &&
                    item.record &&
                    item.record.phaseSource === 'unverified';

                sendDesktopNotification(
                    getTransitionTitle(item.transition) +
                        (unverified ? ' \u{26a0}' : ''),
                    buildNotificationBody(item.info, item.transition) +
                        (
                            unverified
                                ? '\n\u{26a0} phase not verified'
                                : ''
                        ),
                    getTransitionIcon(item.transition),
                    (item.info && item.info.detailUrl)
                        ? () => openFromNotification(item.info.detailUrl)
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

        const failures = counts.TEST_FAILURE + counts.PRETEST_FAILURE;

        const passes = counts.TEST_SUCCESS + counts.PRETEST_SUCCESS;

        sendDesktopNotification(
            failures
                ? `${failures} FAIL \u{274c} (+${passes} pass)`
                : `${passes} PASS \u{2705}`,
            `${counts.TEST_FAILURE} test fail \u{2022} ` +
            `${counts.PRETEST_FAILURE} pre-test fail \u{2022} ` +
            `${counts.TEST_SUCCESS} test pass \u{2022} ` +
            `${counts.PRETEST_SUCCESS} pre-test pass\n` +
            'Open the Alerts panel for details.',
            failures ? ICON_FAIL : ICON_PASS,
            null
        );

        batch.forEach(item => markToastSent(item.record, item.transition));

        log(
            `${batch.length} events this cycle \u{2014} sent one summary ` +
            'toast instead of one per event. All cards are in the panel.'
        );

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
            failure: 'TEST_FAILURE'
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


    // ------------------------------------------------------------
    // WHICH LOG DAY DOES A MOMENT BELONG TO?
    //
    // Local, not UTC, and derived from the entry's ISO timestamp rather
    // than its rendered `date` string - that one is locale-formatted
    // and cannot be compared reliably.
    // ------------------------------------------------------------

    function logDayKeyFor(value) {

        const parsed = new Date(value);

        if (Number.isNaN(parsed.getTime())) {
            return '';
        }

        // Calendar date only. The time of day is deliberately not read.
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day   = String(parsed.getDate()).padStart(2, '0');

        return `${parsed.getFullYear()}-${month}-${day}`;

    }


    function currentLogDay() {
        return logDayKeyFor(new Date());
    }


    function entryLogDay(entry) {
        return entry && entry.iso ? logDayKeyFor(entry.iso) : '';
    }


    // The day the in-memory log belongs to. Empty until the first
    // rollover check, which happens at startup.
    let activeLogDay = '';


    function pruneLogToDay(day) {

        const entries = getAlertLog();

        const kept = entries.filter(entry => entryLogDay(entry) === day);

        const removed = entries.length - kept.length;

        if (!removed) {
            return 0;
        }

        alertLogCache = kept;

        // Written immediately rather than through the debounce. A
        // destructive change that is still sitting in a timer when the
        // page reloads leaves storage and memory disagreeing about what
        // the log contains.
        logWritePending = true;

        flushAlertLog();

        return removed;

    }


    // ------------------------------------------------------------
    // Called at startup and on the master tick. Cheap when nothing has
    // changed: one date comparison.
    // ------------------------------------------------------------

    function checkLogDayRollover() {

        const today = currentLogDay();

        if (activeLogDay === today) {
            return;
        }

        const previous = activeLogDay;

        activeLogDay = today;

        try {
            localStorage.setItem(LOG_DAY_KEY, today);
        } catch (error) {
            warn('Could not record the log day:', error);
        }

        const removed = pruneLogToDay(today);

        if (!removed) {
            return;
        }

        // previous === '' means this ran at startup against a log left
        // over from an earlier session - expected, and not worth
        // interrupting anyone for. A rollover DURING a session is
        // different: entries the operator could see a minute ago are
        // gone, and they get told so while an export could still have
        // mattered.
        if (!previous) {

            log(
                `Alert log: discarded ${removed} entr(y/ies) from a ` +
                `previous day. The log tracks ${today} only.`
            );

            return;

        }

        log(
            `Alert log rolled over ${previous} \u{2192} ${today}. ` +
            `${removed} entr(y/ies) from ${previous} were discarded.`
        );

        sendDesktopNotification(
            'EVE TRACKER \u{2014} LOG ROLLED OVER',
            `${removed} entr(y/ies) from ${previous} were cleared.\n` +
            'The log now tracks ' + today + ' only.',
            ICON_FAIL,
            null
        );

    }


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

        // Silent truncation of something explicitly framed as a
        // PERMANENT audit log is the wrong default. Warn once per
        // session so the user can export before more is lost.
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


    function logRealAlert(info, transition, suppressed) {

        if (isDebugData(info)) {
            devLog(
                'Debug/test transition \u{2014} not written to the alert ' +
                'log (real servers only).'
            );
            return '';
        }

        const now = new Date();

        // A flapping cell inside the cooldown must not append an entry
        // per scan tick - that is unbounded at 4s intervals. Bump the
        // existing record instead. Bounded backward search: a match
        // older than the last 200 entries is not the same flap episode.
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

                    scheduleLogWrite();

                    // The repeat belongs to the ORIGINAL entry, so the
                    // caller confirms against that one.
                    return candidate.eventId || '';

                }

            }

            return '';

        }

        // Stable identity for this event, independent of any card. The
        // old scheme stamped the LAST log entry with the card's id
        // immediately after appending, which only worked because the
        // two calls happened to be adjacent and only for events that
        // produced a card at all.
        const eventId =
            `evt-${now.getTime()}-` +
            Math.random().toString(36).slice(2, 8);

        appendAlertLog({
            eventId: eventId,
            iso: now.toISOString(),
            date: now.toLocaleDateString(),
            time: now.toLocaleTimeString(),
            result: getTransitionTitle(transition),
            transition: transition,

            // Set on confirmation. Colour alone can never tell that a
            // red cell is a SYS_DEKIT run.
            diagnostic: false,

            // Overwritten by updateLogEntryForAlert() once the detail
            // page answers. 'color' means the phase half of this
            // category is a GUESS and should not be trusted.
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


    // ------------------------------------------------------------
    // LOG ENTRY <-> EVENT
    // ------------------------------------------------------------

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

        return !!(
            entry &&
            entry.phaseSource === 'confirmed' &&
            entry.resultConfirmed === true
        );

    }


    function linkLogEntryToAlert(eventId, alertId) {

        const entry = findLogEntry(eventId);

        if (!entry) {
            return;
        }

        entry.alertId = alertId;

        scheduleLogWrite();

    }


    // The audit entry is corrected the moment the detail page answers,
    // whether or not this event was ever surfaced as a card.

    function applyConfirmationToLogEntry(eventId, transition, confirmation) {

        const entry = findLogEntry(eventId);

        if (!entry) {
            return;
        }

        if (confirmation && confirmation.confirmed) {

            entry.transition =
                resolveTransitionFromDetail(transition, confirmation);

            entry.result          = getTransitionTitle(entry.transition);
            entry.diagnostic      = isDiagnosticTransition(entry.transition);
            entry.phaseSource     = 'confirmed';
            entry.resultConfirmed = !!confirmation.resultConfirmed;
            entry.operation       = confirmation.operation || '';
            entry.taskset         = confirmation.taskset || '';
            entry.taskcase        = confirmation.taskcase || '';
            entry.pass =
                (confirmation.pass === 0 || confirmation.pass === 1)
                    ? String(confirmation.pass)
                    : '';

        } else {

            entry.phaseSource      = 'unverified';
            entry.resultConfirmed  = false;
            entry.unverifiedReason =
                (confirmation && confirmation.reason) || 'unknown';

        }

        scheduleLogWrite();

    }


    // Log entries with all debug/test activity removed. Every export
    // path AND the clear-log confirmation use this, so the counts the
    // user sees always agree with the file they get.

    function loadRealAlertLog() {

        // Day-scoped as well as debug-filtered, so an export taken
        // between the rollover moment and the next tick still contains
        // exactly one day.
        const today = currentLogDay();

        return getAlertLog().filter(entry =>
            !isDebugData(entry) &&
            entryLogDay(entry) === today
        );

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
        { transition: 'PRETEST_SUCCESS', heading: 'PRE-TEST PASSES' },
        { transition: 'TEST_SUCCESS',    heading: 'TEST PASSES' },

        // Last, and named for what it is. SYS_DEKIT is a factory
        // diagnostic - it belongs in the record, but not among the
        // hardware results anyone is counting.
        {
            transition: 'DEKIT_FAILURE',
            heading: 'SYS_DEKIT \u{2014} DIAGNOSTIC, NOT A RESULT (Pass=0)'
        },
        {
            transition: 'DEKIT_SUCCESS',
            heading: 'SYS_DEKIT \u{2014} DIAGNOSTIC, NOT A RESULT (Pass=1)'
        }
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
        lines.push(`Log day:       ${currentLogDay()}`);

        if (logEntries.length) {

            const first = new Date(logEntries[0].iso);
            const last  = new Date(logEntries[logEntries.length - 1].iso);

            lines.push(`First alert:   ${first.toLocaleString()}`);
            lines.push(`Last alert:    ${last.toLocaleString()}`);
            lines.push(`Time span:     ${formatDuration(last - first)}`);

        }

        lines.push(`Total alerts:  ${logEntries.length}`);
        lines.push('');
        lines.push(
            'This log covers ONE CALENDAR DAY. Every entry stamped'
        );
        lines.push(
            `${currentLogDay()} is here regardless of the time of day it`
        );
        lines.push(
            'was recorded. Entries from any other date are discarded'
        );
        lines.push('automatically.');
        lines.push('');
        const unverified =
            logEntries.filter(
                e => (e.phaseSource || 'color') !== 'confirmed'
            ).length;

        if (unverified) {
            lines.push('');
            lines.push(
                `WARNING: ${unverified} of ${logEntries.length} entries ` +
                'have an UNCONFIRMED phase.'
            );
            lines.push(
                '      The PRE-TEST vs TEST half of those categories was'
            );
            lines.push(
                '      inferred from cell colour, which does not reliably'
            );
            lines.push(
                '      encode phase. Treat them as "fail"/"pass" only.'
            );
        }

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

        // Diagnostics are excluded from the denominator. A floor that
        // ran 40 SYS_DEKIT passes would otherwise report a halved
        // failure rate without anything having changed on the hardware.
        const resultEntries =
            logEntries.filter(entry => !entry.diagnostic);

        LOG_CATEGORIES.forEach(category => {

            const count = grouped[category.transition].length;

            const diagnosticCategory =
                isDiagnosticTransition(category.transition);

            const denominator =
                diagnosticCategory
                    ? logEntries.length
                    : resultEntries.length;

            const share =
                denominator
                    ? Math.round((count / denominator) * 100)
                    : 0;

            lines.push(
                '  ' +
                padOrTrim(category.heading, 46) +
                padOrTrim(count, 8) +
                `${share}%`
            );

        });

        lines.push('');
        lines.push(
            `  Hardware results: ${resultEntries.length}` +
            `  \u{2022}  SYS_DEKIT diagnostics: ` +
            `${logEntries.length - resultEntries.length}`
        );
        lines.push(
            '  Percentages above are of hardware results only, except'
        );
        lines.push('  the SYS_DEKIT rows, which are of all entries.');

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
        ].join(','));

        const categoryNames = {
            PRETEST_FAILURE: 'PRE-TEST FAIL',
            TEST_FAILURE: 'TEST FAIL',
            TEST_SUCCESS: 'TEST PASS',
            PRETEST_SUCCESS: 'PRE-TEST PASS',
            DEKIT_FAILURE: 'SYS_DEKIT (Pass=0)',
            DEKIT_SUCCESS: 'SYS_DEKIT (Pass=1)'
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
                entry.serverType || '',

                // Flap repeats suppressed from the UI but still counted,
                // so the log reflects what actually happened.
                entry.repeats || 0,

                // 'confirmed' = phase read off the detail page.
                // 'color'/'unverified' = the phase half is a guess.
                // 'diagnostic' entries are SYS_DEKIT: recorded for the
                // audit trail, never a hardware pass or fail.
                entry.diagnostic ? 'diagnostic' : 'result',
                entry.phaseSource || 'color',
                entry.resultConfirmed === true ? 'yes' : 'no',
                entry.operation || '',
                entry.pass === undefined ? '' : entry.pass,
                entry.taskset || '',
                entry.taskcase || '',

                // Whether this event ever produced a card/toast. It is
                // recorded either way; this column says which.
                entry.alertId ? 'yes' : 'no'
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

            // Local log day + local wall time. The old UTC ISO stamp
            // put a 3am export under the previous calendar date, which
            // is exactly the confusion a day-scoped log cannot afford.
            const now = new Date();

            const time =
                [now.getHours(), now.getMinutes(), now.getSeconds()]
                    .map(part => String(part).padStart(2, '0'))
                    .join('-');

            const link = document.createElement('a');

            link.href = url;
            link.download =
                `eve-slt-tracker-log-${currentLogDay()}-${time}.${extension}`;

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
            `Permanently delete all ${count} alert(s) logged on ` +
            `${currentLogDay()}?${extra}\n\n` +
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


    // Rebuild the object confirmPhase() expects from a stored record.
    // Older records predate the section/eve/unit fields, so fall back
    // to splitting the display location rather than passing undefined
    // into the slot check and tripping a false slot-mismatch alarm.

    function infoFromRecord(record) {

        const parts =
            String(record.location || '')
                .split('\u{2022}')
                .map(part => part.trim());

        return {
            serial:    record.serial || '',
            detailUrl: record.detailUrl || '',
            section:   record.section || parts[0] || '',
            eve:       record.eve || parts[1] || '',
            unit:      record.unit || parts[2] || ''
        };

    }


    // ------------------------------------------------------------
    // WHICH CARDS STILL NEED AN ANSWER?
    //
    // Two populations, and the second is the one that got missed:
    //
    //   phaseSource !== 'confirmed'
    //       confirmation never succeeded.
    //
    //   resultConfirmed !== true
    //       the phase was confirmed but the RESULT was not. Either the
    //       row was still being written when we read it - the collector
    //       writes taskset first and fills in Finished / taskset_status
    //       / Pass a moment later, so a fetch fired seconds after the
    //       colour flipped sees a half-written row - or the record
    //       predates this build entirely and has no resultConfirmed
    //       field, because the build that wrote it had no concept of
    //       one.
    //
    // The first version of this restore filter tested phaseSource
    // alone, so a card that 0.9.4 had confirmed the PHASE of was
    // treated as finished and skipped for ever, and kept displaying a
    // note assembled from fields that build never wrote.
    // ------------------------------------------------------------

    function needsReconfirmation(record) {

        if (!record || !record.detailUrl || isDebugData(record)) {
            return false;
        }

        return (
            record.phaseSource !== 'confirmed' ||
            record.resultConfirmed !== true
        );

    }


    // A pending result is worth chasing for a few minutes and then
    // letting go. The row either gets written or it does not, and
    // re-fetching a detail page for ever is how a monitor becomes the
    // load problem.

    const RESULT_RETRY_MAX_ATTEMPTS = 8;


    function reconfirmRecord(record) {

        const attempts = Number(record.resultAttempts) || 0;

        if (attempts >= RESULT_RETRY_MAX_ATTEMPTS) {
            return false;
        }

        record.resultAttempts = attempts + 1;

        updateStoredAlert(record);

        confirmPhase(
            safeUrl(record.detailUrl),
            infoFromRecord(record),
            { live: false, force: true }
        )
            .then(result => reconcileAlertPhase(record, result))
            .catch(error => {
                fail('Re-confirmation threw:', error);
                reconcileAlertPhase(record, null);
            });

        return true;

    }


    // Called on the master tick. Picks up rows that finished writing
    // after we read them, without waiting for a page reload.

    function retryPendingConfirmations() {

        const stale = loadActiveAlerts().filter(needsReconfirmation);

        if (!stale.length) {
            return;
        }

        let started = 0;

        stale.forEach(record => {
            if (reconfirmRecord(record)) {
                started += 1;
            }
        });

        if (started) {
            devLog(
                `Re-checking ${started} alert(s) whose result is still ` +
                'pending.'
            );
        }

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

        // ----------------------------------------------------
        // RE-CONFIRM WHAT WAS NEVER CONFIRMED
        // ----------------------------------------------------
        //
        // v0.9.5. Confirmation used to happen exactly once, in
        // surfaceAlert(), at the moment the colour changed. A card
        // stored before that succeeded came back out of sessionStorage
        // with its stale phaseSource and its stale reason text and was
        // rendered as-is, for ever. Cards raised by an older build
        // therefore kept saying "phase NOT verified" after an update
        // that fixed the confirmation - the update could not reach
        // them, because nothing ever asked again.
        //
        // A confirmation is also worth retrying on its own merits: the
        // usual reason it failed is a detail page that was slow or
        // briefly unreachable, and a reload is a free second attempt.

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

            // Slot parts kept separately, not just baked into the
            // display string, so a card restored from sessionStorage
            // can be re-confirmed against its detail page.
            section: info ? info.section : '',
            eve:     info ? info.eve : '',
            unit:    info ? info.unit : '',

            statusLine: getStatusLine(transition),

            // Links this card to its permanent log entry.
            eventId: '',

            // The label the desktop toast actually carried. Empty until
            // one has been sent.
            notifiedTransition: '',

            // 'color'     label is a GUESS derived from the cell color
            // 'confirmed' label was verified on the detail page
            // 'unverified' confirmation was attempted and failed
            phaseSource: 'color',

            // Evidence from the detail page, kept so the card and the
            // exported log can show WHY a label was assigned.
            taskset: '',
            taskcase: '',

            // Operation cell verbatim ("PRETEST" / "SLT"), the Pass
            // boolean off that same row, and whether that row had
            // produced a result yet.
            operation: '',
            passFlag: null,
            resultConfirmed: false,
            phaseExact: false,
            pendingReason: '',

            ts: Date.now()

        };

        renderAlertElement(record, true);

        return record;

    }


    // ============================================================
    // RECONCILE A CARD WITH THE CONFIRMED PHASE
    // ============================================================
    //
    // The card is created immediately from the color guess so the
    // operator sees something instantly. When the detail page answers,
    // the label is corrected in place - card, stored copy and the
    // permanent log entry all move together, so the three can never
    // disagree about what happened.
    // ============================================================

    // ONE note builder, shared by the freshly rendered card and the
    // repainted one, so a card cannot say different things depending on
    // which code path last touched it.

    function buildPhaseNote(record) {

        if (!record) {
            return '';
        }

        if (record.phaseSource === 'unverified') {
            return (
                `\u{26a0} phase NOT verified \u{2014} ` +
                `${record.unverifiedReason || 'unknown'}`
            );
        }

        if (record.phaseSource !== 'confirmed') {
            return '';
        }

        // Operation, then the phase word it was derived from. Older
        // records have neither, and 'detail page' is the honest label
        // for "this came from there but the field was not recorded".
        const parts = [
            record.operation || record.phase || 'detail page'
        ];

        if (record.passFlag === 0 || record.passFlag === 1) {
            parts.push(`Pass=${record.passFlag}`);
        }

        if (record.taskset) {
            parts.push(record.taskset);
        }

        // The failing taskcase is the whole point of a fail alert -
        // it is the thing that went 0.
        if (record.passFlag === 0 && record.taskcase) {
            parts.push(
                record.taskcase.length > 48
                    ? `${record.taskcase.slice(0, 48)}\u{2026}`
                    : record.taskcase
            );
        }

        // undefined = written by a build that had no result field at
        // all, and not yet re-checked. That is not the same claim as
        // "the page gave no result", so do not make it.
        const head =
            record.resultConfirmed === undefined
                ? '\u{2713} phase confirmed'
                : (
                    record.resultConfirmed
                        ? '\u{2713} confirmed'
                        : '\u{23f3} result pending'
                );

        const tail =
            (!record.resultConfirmed && record.pendingReason)
                ? ` \u{2014} ${record.pendingReason}`
                : '';

        return `${head}\u{a0}\u{b7}\u{a0}${parts.join(' \u{b7} ')}${tail}`;

    }


    function reconcileAlertPhase(record, confirmation) {

        if (!record) {
            return;
        }

        const before = record.transition;

        if (confirmation && confirmation.confirmed) {

            record.transition =
                resolveTransitionFromDetail(before, confirmation);

            record.phaseSource = 'confirmed';
            record.taskset     = confirmation.taskset || '';
            record.taskcase    = confirmation.taskcase || '';

            // Evidence, so the card and the export can show WHY this
            // label was applied instead of asking anyone to take it on
            // trust.
            record.operation  = confirmation.operation || '';
            record.phase      = confirmation.phase || '';
            record.passFlag   =
                (confirmation.pass === 0 || confirmation.pass === 1)
                    ? confirmation.pass
                    : null;
            record.resultConfirmed = !!confirmation.resultConfirmed;
            record.phaseExact      = !!confirmation.phaseExact;

            // Phase is known, result is not - that is not "unverified",
            // but it is not the whole story either.
            record.pendingReason =
                confirmation.resultConfirmed
                    ? ''
                    : (confirmation.reason || '');

        } else {

            record.phaseSource = 'unverified';
            record.unverifiedReason =
                (confirmation && confirmation.reason) || 'unknown';

        }

        record.title      = getTransitionTitle(record.transition);
        record.statusLine = getStatusLine(record.transition);

        if (before !== record.transition) {

            log(
                `${record.serial} re-labelled ${before} \u{2192} ` +
                `${record.transition} from the detail page ` +
                `(taskset: ${record.taskset || 'n/a'}).`
            );

            // If the desktop was already told the OLD label, correct it
            // there too. notifiedTransition is empty until a toast has
            // actually gone out, so a card relabelled before its toast
            // fires - the common case - produces one toast with the
            // right label, not two.
            if (
                record.notifiedTransition &&
                record.notifiedTransition !== record.transition
            ) {

                const announced = record.notifiedTransition;

                record.notifiedTransition = record.transition;

                notifyLabelCorrection(record, announced);

            }

        }

        updateAlertCard(record);

        updateStoredAlert(record);

        updateLogEntryForAlert(record);

    }


    // Repaint an existing card in place rather than tearing it down -
    // a card the user is mid-click on must not vanish.

    function updateAlertCard(record) {

        const card =
            document.querySelector(
                `.eve-alert[data-alert-id="${CSS.escape(record.id)}"]`
            );

        if (!card) {
            return;
        }

        const alertClass =
            ALERT_CLASS_BY_TRANSITION[record.transition] || 'eve-failure';

        card.className =
            `eve-alert ${alertClass}` +
            (record.detailUrl ? ' eve-alert-clickable' : '') +
            (record.phaseSource === 'unverified' ? ' eve-alert-unverified' : '');

        card.dataset.transition = record.transition || '';

        // A card that only became a SYS_DEKIT on confirmation has to
        // pick up the flag now, or it stays visible as whatever colour
        // first called it.
        card.dataset.diagnostic =
            isDiagnosticTransition(record.transition) ? '1' : '0';

        const titleEl = card.querySelector('.eve-alert-header span');

        if (titleEl) {
            // No provenance glyph on the title. It said the same thing
            // as the note directly below it, could not be hidden with
            // it, and put diagnostic state in the one line an operator
            // reads at a glance.
            titleEl.textContent = record.title;
        }

        const statusEl = card.querySelector('.eve-alert-status');

        if (statusEl) {
            statusEl.textContent = record.statusLine || '';
        }

        let noteEl = card.querySelector('.eve-alert-phase-note');

        const noteText = buildPhaseNote(record);

        if (!noteText) {
            return;
        }

        if (!noteEl) {

            noteEl = document.createElement('div');
            noteEl.className = 'eve-alert-phase-note';

            const timeEl = card.querySelector('.eve-alert-time');

            if (timeEl) {
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


    // The audit log is the artifact that has to be right. Find this
    // alert's entry by id and correct its category in place.

    function updateLogEntryForAlert(record) {

        const entries = getAlertLog();

        for (let i = entries.length - 1; i >= 0; i -= 1) {

            const entry = entries[i];

            // eventId is the stable link. alertId is the fallback for
            // entries written before events had ids.
            const matches =
                (record.eventId && entry.eventId === record.eventId) ||
                (entry.alertId && entry.alertId === record.id);

            if (!matches) {
                continue;
            }

            entry.transition      = record.transition;
            entry.diagnostic      = isDiagnosticTransition(record.transition);
            entry.result          = record.title;
            entry.phaseSource     = record.phaseSource;
            entry.resultConfirmed = record.resultConfirmed === true;
            entry.taskset         = record.taskset || '';
            entry.taskcase        = record.taskcase || '';
            entry.operation       = record.operation || '';
            entry.pass            =
                (record.passFlag === 0 || record.passFlag === 1)
                    ? String(record.passFlag)
                    : '';

            scheduleLogWrite();

            return;

        }

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
        PRETEST_FAILURE: 'eve-pretest',
        PRETEST_SUCCESS: 'eve-pretest-pass',
        DEKIT_FAILURE: 'eve-dekit',
        DEKIT_SUCCESS: 'eve-dekit'
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

        // Diagnostics ride the same visibility switch as DEBUG data:
        // present, recorded, exported - just not in the operator's way.
        alert.dataset.diagnostic =
            isDiagnosticTransition(record.transition) ? '1' : '0';

        // Provenance survives a refresh: a restored card that was never
        // verified must still look unverified.
        if (record.phaseSource === 'unverified') {
            alert.classList.add('eve-alert-unverified');
        }

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

            ${
                buildPhaseNote(record)
                    ? `<div class="eve-alert-phase-note">${escapeHtml(buildPhaseNote(record))}</div>`
                    : ''
            }

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

        setupAlertWindowUX(container);

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
    // ALERT WINDOW UX  (drag / snap / persistent position)
    // ============================================================

    // ------------------------------------------------------------
    // FIT THE PANEL TO THE SPACE BELOW IT
    //
    // The drag handler deliberately clamps only the HEADER to the
    // viewport, so a long alert list never forces a bottom snap. The
    // cost of that choice is that the LIST is unconstrained: drag the
    // panel two thirds of the way down and its body still claims up to
    // a full viewport of height, so the bottom of the list - and the
    // bottom of its scrollbar track - sit below the edge of the screen.
    // Dragging the thumb then runs out of screen before it runs out of
    // track, which is unusable.
    //
    // Fix the height to what is actually below the panel's own top edge
    // and the scrollbar is always reachable, wherever the panel sits.
    // ------------------------------------------------------------

    const MIN_ALERT_PANEL_HEIGHT = 120;


    function syncAlertPanelHeight(container) {

        const panel =
            container ||
            document.getElementById('eve-alert-container');

        if (!panel) {
            return;
        }

        const top = panel.getBoundingClientRect().top;

        const available = window.innerHeight - top - 10;

        panel.style.maxHeight =
            `${Math.max(MIN_ALERT_PANEL_HEIGHT, available)}px`;

    }


    function saveAlertPanelPosition(container) {

        try {
            if (!container) return;

            localStorage.setItem(
                ALERT_PANEL_POSITION_KEY,
                JSON.stringify({
                    left: container.style.left,
                    top: container.style.top
                })
            );
        } catch (error) {
            // Non-fatal.
        }

    }


    function clampAlertPanelToViewport(container, left, top) {

        const margin = 10;

        const maxLeft = Math.max(
            margin,
            window.innerWidth - container.offsetWidth - margin
        );

        const maxTop = Math.max(
            margin,
            window.innerHeight - container.offsetHeight - margin
        );

        return {
            left: Math.max(margin, Math.min(left, maxLeft)),
            top: Math.max(margin, Math.min(top, maxTop))
        };

    }


    function restoreAlertPanelPosition(container) {

        try {
            const saved = localStorage.getItem(ALERT_PANEL_POSITION_KEY);

            if (!saved) return;

            const pos = JSON.parse(saved);
            const clamped = clampAlertPanelToViewport(
                container,
                Number.parseInt(pos.left, 10) || 10,
                Number.parseInt(pos.top, 10) || 10
            );

            container.style.left = `${clamped.left}px`;
            container.style.top = `${clamped.top}px`;
            container.style.right = 'auto';

            syncAlertPanelHeight(container);

        } catch (error) {
            // Non-fatal.
        }

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

        // Dragging starts on the header only. Snapping and viewport limits
        // are based ONLY on the header rectangle, never on the full alert
        // container. The alert cards below may therefore extend below the
        // viewport without forcing the header to snap to the bottom edge.
        header.addEventListener('click', event => {
            if (!draggedEnough) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            draggedEnough = false;
        }, true);

        function getHeaderViewportBounds() {
            const rect = header.getBoundingClientRect();
            const margin = 10;

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

            // Live, not on drop: the list has to stay inside the screen
            // while the panel is still moving.
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

            // A normal click on the header (including collapse/expand) must
            // NEVER rewrite the saved position or trigger snapping. Only a
            // real drag is allowed to change the panel coordinates.
            const wasDragged = draggedEnough;
            dragState = null;

            if (!wasDragged) {
                return;
            }

            // IMPORTANT: snap ONLY from the header rectangle. The body/cards
            // are intentionally ignored, so a long alert list cannot cause
            // a false bottom/right snap.
            const rect = header.getBoundingClientRect();
            const bounds = getHeaderViewportBounds();
            const snapDistance = 35;

            let left = rect.left;
            let top = rect.top;

            const nearLeft = rect.left <= bounds.margin + snapDistance;
            const nearRight =
                window.innerWidth - rect.right <= bounds.margin + snapDistance;
            const nearTop = rect.top <= bounds.margin + snapDistance;
            const nearBottom =
                window.innerHeight - rect.bottom <= bounds.margin + snapDistance;

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
            // Only the empty/label portion of the header starts a drag.
            // Interactive controls (including the Alerts collapse toggle)
            // must never initiate a drag or rewrite the panel coordinates.
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

            // Do NOT rewrite left/top on pointerdown. Doing so converts a
            // simple click into a coordinate update based on the current
            // rendered rectangle. When the panel changes size (for example
            // collapse/expand), that can introduce small cumulative position
            // shifts even though the user never dragged it. Coordinates are
            // changed only after an actual drag movement.

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);

            event.preventDefault();
        });

        window.addEventListener('resize', () => {
            const rect = header.getBoundingClientRect();
            const bounds = getHeaderViewportBounds();

            const left = Math.max(
                bounds.margin,
                Math.min(rect.left, bounds.maxLeft)
            );

            const top = Math.max(
                bounds.margin,
                Math.min(rect.top, bounds.maxTop)
            );

            container.style.left = `${left}px`;
            container.style.top = `${top}px`;
            container.style.right = 'auto';

            syncAlertPanelHeight(container);

            saveAlertPanelPosition(container);
        });

    }


    // ============================================================
    // ALERT FILTER + SEARCH
    // ============================================================
    //
    // Hides cards that do not match, rather than removing them, so
    // filtering never destroys an alert or its stored copy.
    // ============================================================

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

        cards.forEach(card => {

            // "Passes" covers pre-test passes too, so a confirmed
            // PRE-TEST PASS card cannot vanish from every filter.
            const allowedTransitions =
                FILTER_TRANSITION_GROUPS[alertFilter] || [alertFilter];

            const matchesType =
                alertFilter === 'all' ||
                allowedTransitions.indexOf(card.dataset.transition) !== -1;

            const matchesSearch =
                !alertSearch ||
                (card.dataset.search || '')
                    .toLowerCase()
                    .indexOf(alertSearch) !== -1;

            const matchesDebugVisibility =
                settings.showDebug ||
                (
                    card.dataset.debug !== '1' &&
                    card.dataset.diagnostic !== '1'
                );

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
        // flex, not block: the container is a flex column so the list
        // can be sized against the space below the panel.
        container.style.display = count > 0 ? 'flex' : 'none';

        if (count > 0) {
            syncAlertPanelHeight(container);
        }

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

                <div class="eve-title-info">
                    <div class="eve-title-name">EVE SLT Tracker</div>
                    <div class="eve-title-meta">
                        by Zay Davidson <span class="eve-version">v${SCRIPT_VERSION}</span>
                    </div>
                </div>

                <span id="eve-health-chip"
                      class="eve-health-chip eve-health-ok"
                      title="Detection is healthy.">OK</span>

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
                        All Notifs
                    </button>

                    <button id="eve-watch-none">
                        No Notifs
                    </button>

                </div>

                <div id="eve-section-list"></div>


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

                                    <button id="eve-debug-persistence">
                                        \u{1f4be} Refresh &amp; Compare (Persistence Test)
                                    </button>

                                    <button id="eve-debug-notify-diagnostic">
                                        \u{1f6a8} Diagnose Desktop Toasts (5 tests)
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

            const trackerPanel = document.getElementById('eve-tracker-panel');
            if (trackerPanel) {
                trackerPanel.classList.toggle(
                    'eve-developer-enabled',
                    enabled
                );
            }

            // The alert container is a SEPARATE fixed element, not a
            // child of the tracker panel, so the panel class cannot
            // reach it. Body class does, and toggling it re-hides the
            // confirmation notes instantly with no re-render.
            if (document.body) {
                document.body.classList.toggle('eve-dev-mode', enabled);
            }

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

        wireButton('eve-clear-log', () => clearAlertLog());


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
            // the settings (e.g. after Show All / No Notifs).
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
                width: 340px;
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
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 19px;
                font-weight: bold;
                margin-bottom: 7px;
            }

            .eve-title-info {
                display: flex;
                flex-direction: column;
                min-width: 0;
                flex: 1 1 auto;
            }

            .eve-title-name {
                line-height: 1.05;
            }

            .eve-title-meta {
                margin-top: 3px;
                font-size: 11px;
                font-weight: normal;
                opacity: .72;
                white-space: nowrap;
            }

            .eve-version {
                margin-left: 6px;
                font-weight: bold;
                opacity: 1;
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
               DETECTION HEALTH CHIP
               =====================================================
               Visible only while Developer Mode is enabled. It remains
               in the title row so the developer page and collapsed state
               use the same header treatment. */

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

            #eve-tracker-panel.eve-developer-enabled .eve-health-chip {
                display: inline-block;
            }

            .eve-health-ok {
                background: #087f23;
                color: #fff;
            }

            .eve-health-degraded {
                background: #b06a00;
                color: #fff;
            }

            /* Deliberately the same red as a failure card. If this is
               showing, nothing is being monitored. */

            .eve-health-blind {
                background: #b00000;
                color: #fff;
                animation: eve-health-pulse 1.6s ease-in-out infinite;
            }

            @keyframes eve-health-pulse {
                0%, 100% { opacity: 1; }
                50%      { opacity: .45; }
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

            /* The container is a viewport-bounded flex column: header
               and toolbar take their natural height, the alert list
               takes what is left. The list used to carry a hard
               max-height of calc(100vh - 90px) instead, which assumed
               the chrome above it was always 90px tall. It is not - the
               filter row wraps onto a second line on a narrow window -
               so the list ran past the bottom of the screen and took
               its scrollbar with it. Dragging the thumb then ran out of
               screen before it ran out of track. */

            #eve-alert-container {
                position: fixed;
                top: 10px;
                left: 10px;
                width: 430px;
                max-width: calc(100vw - 20px);

                /* Starting value only. syncAlertPanelHeight() overwrites
                   this with the space actually below the panel, because
                   the panel is draggable: a viewport-relative cap is
                   measured from the top of the SCREEN, while the list
                   starts at the top of the PANEL. Drag the panel down
                   and the two diverge by exactly the amount that ran
                   off the bottom of the screen. */
                max-height: calc(100vh - 20px);

                /* Nothing escapes the box even when the panel is
                   dragged somewhere with no room left below it. */
                overflow: hidden;

                z-index: 2147483647;
                display: none;
                flex-direction: column;
                background: #1b1b1b;
                border: 2px solid #555;
                border-radius: 8px;
                font-family: Arial, Helvetica, sans-serif;
            }

            #eve-alert-header,
            #eve-alert-toolbar {
                flex: 0 0 auto;
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
                flex: 1 1 auto;

                /* Without this a flex item refuses to shrink below its
                   content height, overflow-y never engages, and the
                   list pushes the container past the viewport again. */
                min-height: 0;

                overflow-y: auto;
                overscroll-behavior: contain;
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
               PRE-TEST PASS
               =====================================================
               Green, because it is a pass - but a distinctly darker
               green than a full TEST PASS, because the server has only
               cleared pre-test and its real test has not reported. */

            .eve-pretest-pass {
                background: #055c19;
            }

            /* =====================================================
               SYS_DEKIT  (diagnostic, not a result)
               =====================================================
               Deliberately neither red nor green. A SYS_DEKIT card is
               only visible with DEBUG shown, and when it is, it must
               not read as pass or fail at a glance. */

            .eve-dekit {
                background: #33383f;
                border: 1px solid #5a626c;
            }

            /* =====================================================
               PHASE PROVENANCE
               =====================================================
               An alert whose PRE-TEST vs TEST label could not be
               verified against the detail page must not look identical
               to one that was. The dashed edge is the tell. */

            .eve-alert-unverified {
                border-style: dashed;
                border-color: rgba(255, 255, 255, .9);
            }

            /* Confirmation provenance is diagnostic detail, not
               operator-facing. It is always BUILT (and always written
               to the log and both exports) but only rendered while
               Developer Mode is on. */

            .eve-alert-phase-note {
                display: none;
                font-size: 11px;
                opacity: .9;
                margin-bottom: 4px;
                word-break: break-word;
            }

            body.eve-dev-mode .eve-alert-phase-note {
                display: block;
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

            // Before anything reads the log: drop whatever is left
            // from an earlier day so counts, exports and the panel all
            // start the session agreeing.
            checkLogDayRollover();

            injectCSS();

            if (document.body) {
                document.body.classList.toggle(
                    'eve-dev-mode',
                    !!settings.developerMode
                );
            }

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

            // ------------------------------------------------
            // BACKGROUND TAB THROTTLING
            // ------------------------------------------------
            //
            // Chromium clamps hidden-tab timers to ~1/min and applies
            // intensive throttling after ~5 minutes. The 1s master
            // tick, the 60s refresh and the watchdog therefore all
            // degrade together - silently. Detection latency collapses
            // from 60s to something unpredictable with no UI signal.
            //
            // The real fix is "keep the tab visible", which is a
            // documentation problem. The fix for it being INVISIBLE is
            // this.

            document.addEventListener('visibilitychange', () => {

                if (document.hidden) {

                    reportHealth(
                        'DEGRADED',
                        'Tab is in the background. Browser timer ' +
                        'throttling means detection is delayed. Keep ' +
                        'this tab visible.',
                        true   // quiet: chip only, no toast
                    );

                    flushAlertLog();

                    return;

                }

                // Back in the foreground: assume everything is stale.
                blindScans = 0;

                restartAutoRefresh();

                scan();

            });

            // beforeunload is unreliable on tab discard, mobile and
            // crash. pagehide is the dependable half of the pair.
            window.addEventListener('pagehide', () => {

                savePreviousStates();

                saveRecentAlerts();

                flushAlertLog();

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
        const RECONFIRM_TICKS = 45; // chase pending results every 45s
        const LOG_DAY_TICKS   = 60; // log-day rollover check every 60s

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

            if (tick % RECONFIRM_TICKS === 0) {
                retryPendingConfirmations();
            }

            if (tick % LOG_DAY_TICKS === 0) {
                checkLogDayRollover();
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

                earlyObserver = new MutationObserver(records => {

                    // stripMetaRefresh() runs querySelectorAll over the
                    // WHOLE document. Unfiltered, this fired for every
                    // parse mutation on a page of hundreds of table
                    // cells - O(mutations x nodes) at exactly the moment
                    // the browser is trying to render. <meta> only ever
                    // appears in <head>.
                    let sawMeta = false;

                    for (const record of records) {

                        for (const node of record.addedNodes) {

                            if (
                                node.nodeType === 1 &&
                                (
                                    node.tagName === 'META' ||
                                    node.tagName === 'HEAD'
                                )
                            ) {
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
