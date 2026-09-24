# Code notes

The reasoning behind the code of `EVE_SLT_Tracker.user.js`, moved out of the script so the
script itself stays short. Nothing here runs; it explains why the code is the way it is -
most notes record a real failure seen on the floor and the rule that stops it coming back.

Every `// ===== TITLE =====` marker in the script has a matching heading below. Each note is
labelled with the function, constant or line it belongs to.

> Written for **v0.9.12**. When code changes, update the matching note here in the same commit.

## Contents

- [Overview](#overview)
- [WHAT THIS SCRIPT DOES](#what-this-script-does)
- [HOW STATE SURVIVES THE AUTO-REFRESH](#how-state-survives-the-auto-refresh)
- [VERSION - single source of truth](#version---single-source-of-truth)
- [STORAGE KEYS](#storage-keys)
- [STORAGE I/O](#storage-io)
- [TUNABLES](#tunables)
- [SETTINGS](#settings)
- [RUNTIME STATE](#runtime-state)
- [DETECTION HEALTH](#detection-health)
- [TESTVIEW](#testview)
- [JIRA](#jira)
- [LOAD / SAVE SETTINGS](#load--save-settings)
- [BASELINE STATE (previousStates)](#baseline-state-previousstates)
- [OUR OWN UI ELEMENTS](#our-own-ui-elements)
- [OBSERVER SUPPRESSION](#observer-suppression)
- [EVE TABLE / HEADER DISCOVERY (cached)](#eve-table--header-discovery-cached)
- [META REFRESH](#meta-refresh)
- [AUTO REFRESH](#auto-refresh)
- [AUTO REFRESH WATCHDOG](#auto-refresh-watchdog)
- [LIVE REFRESH COUNTDOWN](#live-refresh-countdown)
- [SOFT REFRESH](#soft-refresh)
- [PAGE MUTATION OBSERVER](#page-mutation-observer)
- [NOTIFICATION TIMEOUT (ms)](#notification-timeout-ms)
- [CENTRAL DESKTOP NOTIFICATION SENDER](#central-desktop-notification-sender)
- [NOTIFICATION ICONS (embedded, no external dependency)](#notification-icons-embedded-no-external-dependency)
- [THE TRANSITION TABLE - ONE SOURCE OF TRUTH](#the-transition-table---one-source-of-truth)
- [SHARED NOTIFICATION FORMAT](#shared-notification-format)
- [NOTIFICATION PERMISSION CHECK](#notification-permission-check)
- [NOTIFICATION SELF-TEST](#notification-self-test)
- [NORMALIZE COLOR](#normalize-color)
- [TEST PHASE HINT - REMOVED](#test-phase-hint---removed)
- [PHASE CONFIRMATION (authoritative, from the detail page)](#phase-confirmation-authoritative-from-the-detail-page)
- [VALID TRANSITIONS](#valid-transitions)
- [READ SERVER INFORMATION](#read-server-information)
- [FLAP PROTECTION](#flap-protection)
- [EVENT CLAIMS (one event -> one log entry + one toast, across tabs)](#event-claims-one-event---one-log-entry--one-toast-across-tabs)
- [SCAN PAGE](#scan-page)
- [SURFACE AN ALERT (in-page card + desktop toast)](#surface-an-alert-in-page-card--desktop-toast)
- [DEBUG: PERSISTENCE TESTER (Developer Mode only)](#debug-persistence-tester-developer-mode-only)
- [RANDOM TEST DATA](#random-test-data)
- [TEST NOTIFICATION (debug buttons only)](#test-notification-debug-buttons-only)
- [REAL-ALERT AUDIT LOG](#real-alert-audit-log)
- [LOG FORMATTING HELPERS](#log-formatting-helpers)
- [.TXT REPORT](#txt-report)
- [.CSV EXPORT](#csv-export)
- [DOWNLOAD / EXPORT / CLEAR](#download--export--clear)
- [COPY SERIAL TO CLIPBOARD](#copy-serial-to-clipboard)
- [RELATIVE TIME LABELS](#relative-time-labels)
- [ESCAPE HTML](#escape-html)
- [ALERT PERSISTENCE ACROSS REFRESHES](#alert-persistence-across-refreshes)
- [CREATE PERSISTENT IN-PAGE ALERT](#create-persistent-in-page-alert)
- [RECONCILE A CARD WITH THE CONFIRMED PHASE](#reconcile-a-card-with-the-confirmed-phase)
- [RENDER ONE ALERT CARD](#render-one-alert-card)
- [ALERT CONTAINER](#alert-container)
- [ALERT WINDOW UX (drag / snap / persistent position)](#alert-window-ux-drag--snap--persistent-position)
- [ALERT FILTER + SEARCH](#alert-filter--search)
- [ALERT CONTAINER VISIBILITY](#alert-container-visibility)
- [SAFE BUTTON WIRING](#safe-button-wiring)
- [PANEL POSITION PERSISTENCE](#panel-position-persistence)
- [TRACKER WINDOW UX (drag / collapse / snap)](#tracker-window-ux-drag--collapse--snap)
- [TRACKER UI](#tracker-ui)
- [BUILD SECTION CONTROLS](#build-section-controls)
- [SET ALL SECTIONS](#set-all-sections)
- [APPLY VISIBILITY](#apply-visibility)
- [CSS](#css)
- [INITIALIZE](#initialize)
- [KEEP AWAKE + SLEEP DETECTION](#keep-awake--sleep-detection)
- [MASTER TICK](#master-tick)
- [BOOTSTRAP](#bootstrap)
- [Styles (CSS)](#styles-css)
- [Panel markup](#panel-markup)

## Overview

EVE SLT Tracker, by Zay Davidson.

**Found a bug?** [Open an issue](https://github.com/zayd117/EVE-SLT-TRACKER/issues). Include the
script version (shown in the console banner on load), what you expected, what actually happened,
and any red text from the browser console (F12 -> Console). Every line the tracker prints starts
with `[EVE Tracker]`.

## WHAT THIS SCRIPT DOES

Watches the EVE SLT rack page for server cells changing color, and raises an alert when a color change represents a real test result. Only these three transitions are tracked; everything else is deliberately ignored:

Colour detects that a RESULT happened. It does NOT tell you which PHASE produced it - a server in pre-test renders light green while it runs. The phase half of every label is read from the server's own detail page. See v0.9.4 notes below.

```text
any active colour -> 🔴 Red         FAIL   (phase confirmed)
light/blue        -> 🟢 Dark Green  PASS   (phase confirmed)
```
Each alert appears in two places:
```text
1. An in-page card in the Alerts menu (click the serial to
   copy it). These survive page refreshes.
2. A Windows desktop toast via GM_notification.
```
Real (non-test) alerts are also written to a permanent log that can be saved to .txt or .csv from the Alerts menu.

## HOW STATE SURVIVES THE AUTO-REFRESH

```text
sessionStorage  previousStates  last known color/serial/phase
                                of every rack slot
sessionStorage  activeAlerts    undismissed alert cards
sessionStorage  recentAlerts    flap-protection cooldowns
localStorage    alertLog        permanent audit log
```
IMPORTANT: Company credentials are NOT stored in this script. The tracker uses your already-authenticated EVE browser session.

## VERSION - single source of truth

_No notes - the code is self-explanatory._

## STORAGE KEYS

**Inline notes**

- `const LOG_SHIFT_KEY       = 'eveRackTrackerAlertLogDay';` - now holds the shift key

## STORAGE I/O

Every persisted value here is JSON in web storage, read and written behind the same try/catch. Only the SHELL is shared - each caller keeps its own migration, shape guard or filter, because those are the parts that are not boilerplate.

label === null means "fail silently". The flap-protection save is deliberately silent: worst case a flap slips through after a reload, and a console warning per failed write would be noise.

**`const PANEL_MARGIN`**

Shared geometry constants. These were re-declared as locals in four and two places respectively.

## TUNABLES

**`const SHIFTS`**

LOG RETENTION - ONE SHIFT

The log is a record of ONE SHIFT on the floor, not an archive and not a calendar day. A calendar day cut the graveyard shift in half at midnight - wiping the first half mid-shift - and mixed two shifts into one export.

Each tester picks their shift in the panel (settings.logShift; guessed from the clock on first run). The shifts overlap, so the clock alone cannot say whose an entry is - hence the setting.

```text
WINDOW     shift start - SHIFT_EARLY_MIN  ->  shift end +
           SHIFT_LATE_MIN, so early arrivals and stay-lates are
           in it. Exports and the clear-log count cover exactly
           this window.
RETENTION  when the next occurrence's window OPENS (e.g. 21:00
           for Graveyard), everything older is cleared. The log
           never holds much more than a day, and is never
           cleared mid-shift - midnight included.
```
Times are local wall-clock times.

**`const MAX_RENDERED_ALERTS`**

Cards on screen. Soft refresh never reloads the page, so without a cap an undismissed tab gains a card per event for as long as it stays open - days, across shifts - and every filter pass, the 15s time-label tick and Jira polling walk all of them. Oldest go first; the alert log keeps every event regardless. (Only the newest MAX\_STORED\_ALERTS ever came back after a reload anyway.)

**`const MAX_CHRONOLOGICAL_ENTRIES`**

Above this many entries the .txt report omits the full chronological dump, because every entry already appears once in its category table and printing it twice doubles the file.

**`const PRUNE_MIN_RATIO`**

Fraction of tracked slots that must be readable before a scan is trusted enough to PRUNE the ones it did not see. Loosening this constant is what re-opens the baseline-wipe bug - measure before you change it.

**`const TOAST_INDIVIDUAL_LIMIT`**

Events per scan cycle above which desktop toasts collapse into a single summary. In-page cards stay 1:1 regardless.

**`const HEALTH_TOAST_MIN_INTERVAL_MS`**

Health toasts are edge-triggered AND rate limited, so a flapping page cannot spam the desktop.

**`const BLIND_SCAN_THRESHOLD`**

Consecutive zero-header scans before declaring BLIND (~12s at the 4s scan cadence). Tolerates a single mid-swap scan.

**`const REFRESH_INTERVAL_OPTIONS`**

Auto refresh is always on. 30s is the slowest allowed - the only choice is to go faster.

## SETTINGS

**`sections:`**

Per-section flags, keyed by section name (A7, B2, ...). { show, watch }. There is no global show/watch flag.

NOTE: "watch" controls whether an alert is SURFACED (card + desktop toast). It does not control whether the transition is recorded in the permanent audit log - that always happens, so the log can never develop silent holes.

**`refreshIntervalSeconds:`**

Auto refresh and soft refresh are ALWAYS on and are not settings. Every cycle soft-refreshes; a full reload happens only when a soft refresh fails. See REFRESH\_INTERVAL\_OPTIONS.

**`notificationTimeoutSeconds:`**

0 = desktop toast never auto-closes.

**`developerMode:`**

Gate for the developer page, the debug snapshot/compare machinery, the diagnostic tools, and DEBUG/test + SYS\_DEKIT card visibility (there is no separate DEBUG switch).

**`jiraBaseUrl:`**

Jira. Uses the browser's existing Jira login; nothing is stored beyond the ticket key/status cache in sessionStorage. FAIL-card ticket lookup is always on - not a setting.

**`notificationClickTarget:`**

What a click on a desktop toast opens: 'jira' | 'detail' | 'both'

**`logShift:`**

Which SHIFTS entry the alert log follows. '' = not chosen yet; loadSettings() fills it from the clock on first run.

## RUNTIME STATE

**`let softRefreshController`**

Hoisted so autoRefreshWatchdog() can ABORT a hung fetch, not merely clear the flag and leave the request running underneath a second call that could swap tables concurrently.

**`let softRefreshFailingSince`**

When soft refreshes started failing for a TRANSIENT reason (network, timeout, 5xx); 0 = the last one worked. While set, the rack page on screen is stale, so scan() must not report health OK.

### `devLog()`

Developer-only logging. Keeps production consoles readable.

**Inline notes**

- `let settings         = null;` - loaded in initialize()

## DETECTION HEALTH

The failure mode that matters for a monitoring tool is not a crash - it is continuing to LOOK healthy while seeing nothing. A DOM change, a partial render or a detached header cache all produce a tracker that counts down to its next refresh, reports no alerts, and is indistinguishable from "everything is passing".

```text
OK        headers found and a plausible number of slots read
DEGRADED  read far fewer slots than tracked, a table was
          refused, slots threw, or the tab is backgrounded
BLIND     no EVE headers at all - the page structure changed
```
Surfaced on the panel title while Developer Mode is enabled. The underlying automatic health state remains available to the tracker, but the visual chip is hidden from normal production use.

**In `reportHealth()`, at `if (quiet) {`**

quiet = chip only. For states the user caused and can see for themselves (backgrounded tab), where a toast is noise.

### `safeUrl()`

Only http(s) URLs are ever opened. detailUrl round-trips through sessionStorage, which the page's own scripts can write, so a "javascript:" value would otherwise execute on click.

### `openFromNotification()`

Toast callbacks are NOT a user gesture, so window.open() from one gets popup-blocked. GM\_openInTab is the privileged path.

**In `openFromNotification()`, at `window.open(target, '_blank', 'noopener,noreferrer');`**

Best effort. May be blocked - hence the grant above.

## TESTVIEW

v0.9.9. A card click (and a toast click when "Toast click opens" is TestView search) opens the card's server in TestView instead of the mfg-collector Server Detail page. The TestView test-detail page (`/slt/testdetail/<id>`) needs a database id the rack page does not have, so the card opens the TestView list page, and the script there looks the id up (lookupTestViewDetailId) and redirects to the detail page. If that fails it queries the list for the serial instead. A card or toast with no serial still opens the old detailUrl.

The same script runs on the TestView list page (`@match *://*/slt/list*`, host-agnostic like the rack `@match`). bootstrap() sees the `/slt/` path, runs only runTestViewAutoQuery() and returns, so none of the tracker starts there.

### `isTestViewOrigin()`

`@match *://*/slt/list*` is host-agnostic, so the script also starts on any other site that happens to have that path. It does nothing there: without this check a stray /slt/list page opened within the handoff TTL would consume the handoff and receive the serial in its API call.

### `openTestView()`

The serial travels two ways: in the URL hash (`#eveSn=...`) and in GM storage (`GM_setValue`, shared by this script across origins). A TestView login redirect can drop the hash; the GM handoff, valid for TESTVIEW\_HANDOFF\_TTL\_MS, still gets the serial through when the user lands on the list page again.

### `readTestViewSerial()`

The hash wins over the handoff. Both are consumed on read (hash stripped with replaceState, handoff deleted) so a reload of the list page does not re-query.

### `lookupTestViewDetailId()`

The list page's own table request: `GET /api/v1/server_level_tests/view?fields=...&only_latest_slt=true&page_num=1&page_size=10&server_sn=<SN>` returns `{code, msg, data: {page_info, items: [{id, server_sn, status, started, ...}]}}`; `items[].id` is the number in `/slt/testdetail/<id>` (field capture, 2026-09-23). The script runs on the TestView origin, so a same-origin fetch carries the user's `access_token` cookie - no token is read or stored by the script. Only an item whose server\_sn equals the serial counts; with several, the newest `started` wins. A non-OK status, a network error, TESTVIEW\_LOOKUP\_TIMEOUT\_MS with no answer, or no match all fall back to startTestViewListQuery(). The redirect uses location.replace so Back does not land on the list page and bounce again (the handoff is consumed on read anyway).

### `findTestViewSnInput()`

TestView is an Ant Design app. The SN field is `<input id="server_sn" class="ant-input">` (seen on the live page); the `.ant-form-item` labelled "SN" and the id / placeholder selectors are fallbacks if that markup changes.

### `typeIntoTestViewInput()`

Types the SN the way a person does, one key at a time: keydown, keypress, the character inserted with execCommand 'insertText' (real input events the React form handles; native value setter + InputEvent as fallback), keyup, TESTVIEW\_KEY\_MS apart. Any old text is deleted first. It ends with change and a real blur(): a mouse click on Query moves focus out of the box first, and a form that saves the field on blur never sees the SN without it.

### `runTestViewAutoQuery()` / `startTestViewListQuery()`

runTestViewAutoQuery() tries the detail lookup first; startTestViewListQuery() is the list fallback. The SPA renders the form after the page loads, so it waits (MutationObserver plus a TESTVIEW\_POLL\_MS poll, capped at TESTVIEW\_WAIT\_MS) for the SN input, then hands off to submitTestViewQuery(). If the input never appears a dismissible red banner tells the user to enter the SN by hand.

### `submitTestViewQuery()`

Field tests: (1) the SN showed in the box and Query ran, but the query went out without the SN; (2) with Query held back until the table loaded, the SN appeared only after the page's own load; (3) SN typed first and Query focused, still unfiltered. In (3) the SN had reached the form (the allowClear icon only shows when the form holds a value), so the Query press itself was lost - most likely pressed while the page was still busy, when an antd Button in its loading state ignores clicks. Each try runs strictly in this order:

1. Wait until the page has been idle for TESTVIEW\_QUIET\_MS without a break (the page can run several loads back to back; a query pressed in the gap between them is overwritten), and only then type the SN, once, slowly (TESTVIEW\_KEY\_MS per key), including the blur.
2. Pause TESTVIEW\_COMMIT\_MS, then wait until the page is idle again: no visible `.ant-spin-spinning` / `.ant-spin-blur` AND the Query button is not disabled / `ant-btn-loading` / aria-busy (up to TESTVIEW\_LOAD\_CAP\_MS - the first list load can be slow).
3. If the box no longer holds the SN, type it again. Otherwise trigger the query (triggerTestViewQuery): a Query click (focus, pointer/mouse down+up, click - for a submit button, click() also fires the form's submit, which the browser marks trusted); on try 2 `form.requestSubmit()` if the field is inside a `<form>`; Enter on the input if there is no Query button.
4. Wait for the table to react (busy, or rows changed), then to go idle, then check every `.ant-table-row` contains the serial (an empty table counts as filtered). If not, next try, at most TESTVIEW\_MAX\_TRIES, then a banner asks the user to press Query.

What finally fixed it (v0.9.9 test builds, compared): the flow was right from the second build on, but every build that dispatched pointer/mouse events built them with `view: window` and crashed in Tampermonkey before Query was pressed (see below). The symptoms - SN in the box, a "query" that did not filter - were the page's own first list load, which runs every time /slt/list opens, and never a query from the script. The first build did not crash (bare click()) but pressed Query 0.4 s after the box appeared, inside that first load. Removing `view` made the click land; waiting for the page to go idle makes it land after the page's own load. An early extra typing pass was only redundant and was removed.

Timing (v0.9.9 final): idle 1 s (TESTVIEW\_QUIET\_MS), type at 40 ms per key, pause 0.7 s (TESTVIEW\_COMMIT\_MS), idle 0.25 s, click - about 2.3 s after the page's own load for a 10-character SN (was about 4.8 s).

**In `clickTestViewButton()`**: no `view: window` in the event init. Inside Tampermonkey `window` is a sandbox proxy, not a real Window, and `new PointerEvent(..., { view: window })` throws "Failed to convert value to 'Window'" (field console, v0.9.9 test build) - the throw killed the flow before Query was pressed. Each synthetic event is also wrapped in try/catch so a missing constructor cannot stop the final click(), and runTestViewAutoQuery() catches any crash, logs it and shows the banner.

**In `triggerTestViewQuery()`** (v0.9.10): the press (pressTestViewQuery) runs inside a one-shot `submit` listener on `window` that preventDefault()s a submit of the SN's own form. A Query click on a submit button, or requestSubmit(), otherwise also performs the browser's native form submission; on a form whose handler does not cancel it, that navigates away and reloads /slt/list, discarding the typed SN and the query. The listener is on `window`, so the page's own submit handlers (on the form or the React root) run first and still see the event; only the navigation is stopped. It is removed right after the synchronous press. Covered by the two `regression: ... native form does not reload the page` tests.

A synthetic Tab or Enter cannot move focus or press a button (browsers ignore untrusted key events for default actions), so "Tab to Query, press Enter" is done as focus + click().

A real keypress stops it at once so it never fights someone typing another SN. Every step logs `[EVE Tracker] TestView: ...` with describeTestViewPage(): SN box value, Query button class, whether it is inside a form, busy state, row count and first row - enough to diagnose a failure from a console paste.

## JIRA

Every alert card gets a Jira button, and a click on a desktop toast opens Jira (configurable). Which ticket:

```text
FAIL / PRE-TEST FAIL -> the ticket raised for THAT failure: the
    newest one CREATED since it. Never the previous failure's,
    which is what "newest ticket" gives right after a fail.
    Two ways it can be missing, and both are normal:
      not raised YET - the company's Jira bot usually raises it
          5-10 min after the failure (sometimes sooner, sometimes
          later). For JIRA_TICKET_EXPECT_MS the card says "Ticket
          pending" ("No ticket yet" for a pre-test fail) and
          checks - every 30 s around the usual time, every minute
          otherwise - and a click waits for it and then opens it.
      never raised  - common for pre-test fails, possible for any.
          After JIRA_TICKET_EXPECT_MS the card says "No ticket";
          it keeps checking every few minutes until
          JIRA_TICKET_LATE_MS in case one turns up late.
    Either way a click shows only two searches (JIRA_LIST_ORDER):
    most recently updated, or most recently created.
    Nothing here raises tickets - it only waits for the bot's.
anything else -> the most recently UPDATED ticket.

ticket known   -> /browse/<KEY>             (that ticket only)
not known yet  -> ask Jira, then /browse/<KEY>
no ticket      -> /browse/<LATEST>?jql=...  (one of the two lists)
cannot ask     -> /issues/?jql=...          (one of the two lists)
```
"Asking" is Jira's REST search via GM\_xmlhttpRequest carrying the browser's own Jira cookies. FAIL cards ask in the background so the key is already on the card. No credentials are stored or sent anywhere. Not logged in -&gt; the button still works, it opens the updated-sorted search instead.

Load on Jira is bounded: failures only, two requests at a time, results cached in sessionStorage so an auto-refresh does not repeat them, and a pause after an auth failure.

**`const JIRA_TICKET_LEAD_MS`**

A failure's own ticket comes from the company's Jira bot - or not at all (common for pre-test fails). The bot usually takes 5-10 min, but it varies either way.

**In `jiraBaseUrl()`, at `return /^https?:\/\/[^\s/]+/i.test(raw) && safeUrl(raw)`**

Absolute http(s) only. "jira.example.com" without a scheme would otherwise resolve RELATIVE to the EVE page.

### `jiraFailedAt()`

Which ticket belongs to a card

### `jiraFailedAt()`

When the failure behind a card happened (the card's time), or 0 for cards that are not a real failure - passes and DEBUG cards keep "most recently updated ticket".

### `jiraIsPretest()`

Pre-test fails often never get a ticket, so they are worded as "no ticket yet" rather than "pending".

### `jiraExpecting()`

Inside the time the bot normally takes to raise the ticket.

### `jiraStillChecking()`

Still worth checking for a late ticket.

### `jiraMinutesSince()`

Whole minutes since the failure (at least 0).

### `jiraUsualText()`

"Tickets usually appear 5-10 min after a fail (sometimes sooner or later) - this one failed 3 min ago."

### `jiraLookupKey()`

Cache/queue key: the serial, plus the failure time for a failure's own ticket.

### `jiraOrderedJql()`

A failure's own ticket is the newest CREATED since the failure (less a small lead, in case the bot beat this page to it). Relative minutes are evaluated by the Jira server, so neither clock skew nor the Jira user's time zone matter. Anything else is the most recently UPDATED ticket.

**`const JIRA_LIST_ORDER`**

The only two lists a tester is offered when a card has no ticket of its own:
```text
updated  every ticket for the serial, latest activity first
created  every ticket for the serial, newest first
```
Deliberately NOT QuickSearch.jspa - that lands in an unsorted list of every ticket that ever mentioned the serial.

### `jiraListUrl()`

With a ticket key, /browse/&lt;KEY&gt;?jql= opens that ticket beside the list. Without one, the plain search.

### `jiraLatestKey()`

The serial's most recently updated ticket, if one is known. Only picks which ticket a list opens on - Jira orders the list itself, so an older cached key is fine here.

### `jiraSearchUrl()`

Fallback when a card's ticket is not known. A failure gets the created-first list - its own ticket is on top once raised. Anything else gets the updated-first list.

### `jiraIssueUrl()`

The ticket on its own - no ?jql=, which would bring the full list of matching tickets along with it.

### `jiraUrlFor()`

The best link for a card right now, without waiting.

### `jiraKnownUrl()`

A ticket that can be opened without asking Jira first. A failure's own ticket never goes stale - it IS that failure's ticket. The latest updated one is trusted for its cache TTL only; after that a newer one may exist.

### `jiraCardResult()`

What a card shows. For a failure with nothing raised yet: 'waiting' while the bot normally takes, 'noticket' after that.

### `jiraWithin()`

null if the answer does not come within `ms`.

### `resolveJiraUrl()`

The best link once Jira has been asked (waits at most JIRA\_RESOLVE\_WAIT\_MS). For a failure with no ticket this is the created-first list; the card button and the toast click wait for the ticket instead.

### `resolveJiraListUrl()`

One of the JIRA\_LIST\_ORDER lists, after asking Jira for the serial's latest ticket if none is cached (waits at most JIRA\_RESOLVE\_WAIT\_MS). For toast clicks, which cannot show a page.

### `loadJiraCache()`

sessionStorage, not localStorage: the cache is only a shortcut and should not outlive the tab. The page's own scripts can write sessionStorage, so entries are shape-checked on load and every value is only ever written with textContent / encodeURIComponent.

**In `jiraIsFresh()`, at `const ttl`**

A failure's "nothing raised yet" is re-asked every poll - the bot may be about to raise it.

### `storeJiraResult()`

Only definite answers are cached. An auth failure or a network error says nothing about the ticket.

### `jiraLookupAvailable()`

Lookup is always on; it only needs the grant.

**In `parseJiraResponse()`, at `if (!data || !Array.isArray(data.issues)) {`**

An SSO redirect ends on a login PAGE served with 200 - HTML, not JSON. That is "not logged in", not "no ticket".

**In `requestJira()`, at `const url`**

One ticket: a failure's own (newest created since it) or the most recently updated. total still reports how many matched.

**In `requestJira()`, at `onabort:`**

Without this an aborted request never settles: its queue slot is never released, and after JIRA\_MAX\_CONCURRENT of them every lookup waits for good.

### `lookupJira()`

failedAt: look for that failure's own ticket (0 = latest updated).

**In `pumpJiraQueue()`, at `const run`**

A queued job can outlive an auth failure discovered by the request ahead of it. Do not send it.

### `setJiraBadge()`

Status badge on the Settings &gt; Jira summary line.

### `jiraTimeText()`

"2026-09-19T05:12:03.000-0700" -&gt; local clock time, or ''.

**In `paintJiraButton()`, at `cls += ' eve-jira-waiting';`**

Not raised yet, inside the time the bot normally takes.

**In `paintJiraButton()`, at `cls += ' eve-jira-noticket';`**

Nothing raised in the time the bot normally takes.

**In `buildJiraButton()`, at `button.addEventListener('click', event => {`**

Plain click on a card whose ticket is not known yet: open the tab NOW (inside the click, so it is not popup-blocked), then send it to the ticket - or, for a failure with no ticket yet, let it wait for one and show the options meanwhile. Ctrl/Shift/middle-click keep normal link behaviour with the best URL right now.

**In `buildJiraButton()`, at `writeJiraTab(tab, 'Jira…', ['Finding the Jira ticket for ${s...`**

Cosmetic only.

**In `buildJiraButton()`, at `const current`**

A card that already says "Ticket pending" / "No ticket" keeps saying it while the tab waits; only a card with nothing known yet shows the lookup running.

**`const JIRA_TAB_CSS`**

Button states for the tab page. Inline styles cannot express :hover / :active, so this goes in a &lt;style&gt; in that tab.
```text
rest    dim
hover   bright (also keyboard focus)
press   quick dip back to dim (50 ms), then eases back to
        bright over 180 ms on release - a visible "click".
```

### `writeJiraTab()`

Text and links for the tab opened on click, while it has no Jira page yet. Links are drawn as buttons (JIRA\_TAB\_CSS); link.note is an optional second line under the label.

**In `writeJiraTab()`, at `const signature`**

The wait page is re-written on every poll. Skip identical content: replacing the buttons between mousedown and mouseup would swallow the click, and would reset hover.

**In `writeJiraTab()`, at `doc.body.textContent =`**

Plain text first; replaced by styled rows if they build.

### `jiraTabIsWaiting()`

Cosmetic only.

### `jiraTabIsWaiting()`

Still the blank tab this script opened: not closed, and not taken somewhere else by the user (a Jira page is cross-origin, so reading its location throws).

### `writeJiraWaitPage()`

The page a tab shows while a failure has no ticket of its own: what failed and when, and the two searches from JIRA\_LIST\_ORDER - nothing else. Both open on the serial's latest existing ticket when one is known; that ticket belongs to an earlier failure and is never presented as this one's.

### `followJiraInTab()`

Sends a tab opened on click to the card's ticket. A failure whose ticket does not exist (yet): the tab offers the two searches and keeps checking - it goes straight to the failure's ticket if one is raised while it is open. Stops if the tab is closed or used for something else.

**In `followJiraInTab()`, at `if (own && own.state === 'auth') {`**

Not logged in: Jira shows its own login first.

**In `followJiraInTab()`, at `if (!askedLatest) {`**

Asked once: the serial's latest ticket is the one the two searches open on.

### `indexJiraKey()`

The card's search text gains the ticket key, so the alert search box finds a card by "MFGS-584283" as well as by serial.

**In `syncJiraForCard()`, at `const failedAt`**

Real failures only: that is where a ticket gets raised. PASS and DEBUG cards keep the button (it still searches) without costing Jira a request.

### `jiraPollDelay()`

How long until a card asks again for its failure's ticket:
```text
every 30 s from a minute before the usual range to two minutes
  after it (4-12 min) - that is when it usually appears,
every minute for the rest of the expected time (0-4, 12-20 min),
every 5 min after that in case it comes late (to 2 h),
then not at all.
```

### `refreshCardTicket()`

Background lookup for a FAIL card's own ticket.

### `onJiraWindowFocus()`

Coming back to this tab after logging in to Jira in another one is the moment to try again - no need to wait out the pause.

### `openNotificationTarget()`

What a desktop-toast click opens. Toast callbacks are not a user gesture, so everything goes through openFromNotification(). 'both' opens the page (TestView) first so the Jira tab ends up in front.

Takes the alert record (v0.9.11; both callers used to repeat the same four derived arguments). A PASS never goes to Jira - passes get no ticket - so its toast opens TestView even when the target is 'jira'.

### `isPassResult()`

TEST PASS / PRE-TEST PASS: not a failure and not a SYS\_DEKIT diagnostic, per the TRANSITIONS table. Passes never get a Jira ticket, so their card shows an inert "PASSED (no ticket)" and nothing asks Jira about them.

### `syncJiraForCard()`

The one owner of a card's Jira button state (buildJiraButton only builds the element; renderAlertElement calls this right after). A pass paints the `passed` state: no href, no lookup, no polling. A card relabelled from PASS to FAIL by the detail page comes back through here and gets the normal live button.

### `openJiraFromToast()`

GM\_openInTab needs no user gesture, so the ticket can be looked up first and opened directly. A toast usually fires BEFORE the bot has raised the failure's ticket - then it opens by itself once it exists. Past the time the bot normally takes, there is no ticket for this failure: the most-recently-updated search opens, and a toast says this failure has no ticket.

**In `openJiraFromToast()`, at `if (own && own.state === 'auth') {`**

Not logged in: Jira shows its own login first.

### `openUpdatedListInstead()`

No ticket for this failure: open the serial's tickets, most recently updated first, and say plainly that none of them is this failure's.

### `openJiraWhenRaised()`

A toast click is not a user gesture, so no tab can be held open while the bot is due. Keep checking and open the ticket the moment it exists (GM\_openInTab needs no gesture) - but only within the time the bot normally takes; a tab popping up an hour later would be a surprise. After that the card keeps watching instead.

**In `openJiraWhenRaised()`, at `if (own && own.state === 'auth') {`**

Not logged in: Jira shows its own login first.

**Inline notes**

- `const JIRA_RESOLVE_WAIT_MS  = 6000;` - click -&gt; lookup -&gt; open, max wait
- `const JIRA_TICKET_LEAD_MS   = 5 * 60 * 1000;` - bot may beat this page to it slightly
- `const JIRA_TICKET_USUAL_MIN = 5;` - usual range, minutes after the fail -
- `const JIRA_TICKET_USUAL_MAX = 10;` - ```text shown to the user, and polled hardest ```
- `const JIRA_TICKET_EXPECT_MS = 20 * 60 * 1000;` - "pending" until this (2x the usual max)
- `const JIRA_TICKET_LATE_MS   = 2 * 60 * 60 * 1000;` - keep checking for a late one until this
- `const JIRA_PEAK_POLL_MS     = 30 * 1000;` - card re-check around the usual time
- `const JIRA_PENDING_POLL_MS  = 60 * 1000;` - card re-check otherwise while expected
- `const JIRA_LATE_POLL_MS     = 5 * 60 * 1000;` - card re-check after that
- `const JIRA_TAB_POLL_MS      = 15 * 1000;` - re-check while someone waits on it
- `let jiraCache           = null;` - Map, loaded lazily
- `const jiraInFlight      = new Map();` - serial key -&gt; Promise
- `cache.delete(id);` - re-insert = most recently used
- `return;` - blocked - fall through to the search link
- `const jiraOpenWhenRaised = new Set();` - lookup keys already waiting

## LOAD / SAVE SETTINGS

**In `loadSettings()`, at `delete parsed.autoRefresh;`**

v0.9.7: these are no longer switchable. Older builds stored them; drop them so they cannot come back. showDebug / hideTestResults: DEBUG visibility now follows Developer Mode alone.

**In `loadSettings()`, at `merged.refreshIntervalSeconds =`**

An older build allowed 60s-10min. Anything outside the allowed set goes back to the 30s default.

**In `loadSettings()`, at `if (!merged.sections ||`**

Shallow spread would replace this wholesale; make sure it is always a usable object.

### `withLogShift()`

`logShiftChoice` is `'auto'` (default) or a shift id; `logShiftOverrideFor` is the Auto occurrence key a hand pick belongs to. Up to 0.9.10 the shift was picked by hand (`logShift`) and stayed picked, so a shared floor PC stayed on whichever shift touched it last. A saved `logShift` is dropped once and the setting becomes Auto; anything unknown also becomes Auto.

**In `getSectionSettings()`, at `saveSettings();`**

Persist immediately. Previously a newly-discovered section lived only in memory until some unrelated action happened to save, so storage and runtime drifted.

## BASELINE STATE (previousStates)

_No notes - the code is self-explanatory._

## OUR OWN UI ELEMENTS

Everything the tracker injects lives under one of these IDs. Used by the MutationObserver (to ignore self-inflicted mutations) and by the soft refresh (to know what must survive).

## OBSERVER SUPPRESSION

applyVisibility() writes style.display on PAGE cells, which the observer watches. Previously that re-triggered the observer, which called applyVisibility() again; the loop only settled because the values happened to stabilise. Wrapping the tracker's own page writes makes that structural instead of accidental.

**In `withoutObserver()`, at `if (pageObserver) {`**

Discard anything queued by our own writes. takeRecords() is synchronous, so this runs before the observer's microtask would have fired.

## EVE TABLE / HEADER DISCOVERY (cached)

Returns one entry per TABLE, each carrying the EVE headers it contains. scan() and applyVisibility() can then walk a table's rows ONCE and loop the header columns inside, instead of re-walking every row once per header - eight EVE columns in one table previously meant eight full row walks.

The result is cached and invalidated whenever the page actually changes, so a cycle no longer runs querySelectorAll('th') three times over.

**In `getEveTableGroups()`, at `if (!root && cachedGroups) {`**

The cache holds live &lt;th&gt;/&lt;table&gt; references. withoutObserver() discards every queued mutation record, including unrelated page changes that detached them - at which point querySelectorAll( 'tbody tr') returns empty while headerCount stays non-zero, which is precisely the input that used to wipe every baseline. Cheap identity check beats rebuilding on every call.

**In `getEveTableGroups()`, at `const groups`**

th.cellIndex is matched against row.children[column]. Any colspan/rowspan breaks that mapping, and the result is not a MISSED alert but a FALSE one - attributed to a real serial and written to the permanent audit log. Refuse the table rather than guess. This is the one place failing CLOSED is right: wrong data is worse than no data.

## META REFRESH

A &lt;meta http-equiv="refresh"&gt; makes the browser navigate on the SERVER's schedule, which resets the tracker and races the soft refresh. Chromium commits it at PARSE time, so removing the node from DOMContentLoaded is too late - hence @run-at document-start plus the early observer in bootstrap() at the bottom of the file.

## AUTO REFRESH

### `startAutoRefresh()`

Always on, always soft. performSoftRefresh() is the only place a full reload can happen, and only as the fail-safe when the soft refresh fails in a way a reload can fix (never for a network outage - see performSoftRefresh()).

**In `startAutoRefresh()`, at `devLog('Auto refresh: next soft refresh in ${seconds}s');`**

Per-cycle, so devLog: at 10s a plain log would be 6 lines a minute of noise.

### `fireAutoRefresh()`

The one place a scheduled refresh fires - from its own timer, or from the master tick when a background tab's timer was throttled past its due time. Clearing autoRefreshTimer first makes a second caller a no-op.

**In `fireAutoRefresh()`, at `performSoftRefresh(restartAutoRefresh);`**

performSoftRefresh() guarantees the callback runs on every exit path, including the early "already in flight" return. Nothing here reschedules on its own, so a missed callback used to kill auto refresh for the life of the tab.

### `refreshNow()`

Manual refresh from the panel: the same soft path as the timer (in-flight guard, hard-reload fail-safe, reschedule on every exit), just without waiting out the countdown.

## AUTO REFRESH WATCHDOG

Backstop for the whole refresh path. If the due time slides far enough into the past that no plausible in-flight request could still be running, something swallowed the reschedule - force it back to life rather than sitting on stale data showing "refreshing..." forever.

**In `autoRefreshWatchdog()`, at `if (softRefreshController) {`**

Clearing the flag without aborting left the fetch running, so a second performSoftRefresh() could swap tables concurrently.

## LIVE REFRESH COUNTDOWN

### `setTextIfChanged()`

updateRefreshCountdown() runs once a SECOND for the life of the tab and used to rewrite textContent and className unconditionally
- including on #eve-refresh-status, which is Dev-only and hidden most of the time. The last written value is kept on the node itself, so replacing the element invalidates the memo for free.

### `setRefreshProgress()`

Fills toward the next refresh. Jumps back (no transition) when a new cycle starts instead of animating backwards.

**In `updateRefreshCountdown()`, at `if (!autoRefreshDueAt) {`**

Only before the first schedule - auto refresh cannot be off.

**In `updateRefreshCountdown()`, at `const remaining`**

Float seconds, one decimal ("26.4s"). Intervals are 30s at most, so the minutes branch only shows for a timer that a background tab starved.

**In `updateRefreshCountdown()`, at `setTextIfChanged(mini, remaining > 0 ? label : '↻');`**

Collapsed-title copy: same time, same colour.

## SOFT REFRESH

Re-fetches the SAME url in the background and swaps in only the page's own tables, leaving every tracker widget untouched: panel position and collapse states survive, alert cards are never rebuilt, previousStates stays live in memory, no flash.

When it fails:
```text
network error, timeout, HTTP 5xx/408/429  -> keep the page,
    health DEGRADED (one toast), retry next cycle. A reload
    during an outage lands on the browser's error page, where
    the script cannot run - the tracker would stop silently.
login redirect, 401/403, no EVE headers    -> hard reload, so
    the login page or the changed page is visible.
```
Either way the tracker never LOOKS healthy on stale data.

CRITICAL CONTRACT: onDone() runs on EVERY exit path. It is the only thing that reschedules the auto-refresh timer.

### `transientRefreshError()`

A fetch that never produced a response (network down, DNS, VPN, abort/timeout) or whose body was cut off. Marked transient: see the catch in performSoftRefresh().

### `rackServerReachable()`

Does the rack server answer at all? no-cors + HEAD: follows any redirect, downloads no body, and resolves whenever a response comes back - rejects only when the network cannot reach it.

**In `performSoftRefresh()`, at `warn('Soft refresh skipped - one is already in flight. ' +`**

Still reschedule. Returning without this used to leave the auto-refresh timer permanently unscheduled.

**In `performSoftRefresh()`, at `savePreviousStates();`**

Snapshot first: if this ends in a hard-reload fallback the state must already be persisted.

**In `performSoftRefresh()`, at `const abortTimer`**

Without this a hung socket (VPN drop, stalled proxy) pins softRefreshInFlight for the life of the tab.

**In `performSoftRefresh()`, at `if (!(error && error.name === 'AbortError') &&`**

A redirect to a login page on ANOTHER host (session expired -&gt; SSO) fails this fetch with the very same TypeError as a network outage. An opaque probe follows that redirect without needing CORS: if the server answers, this was the session, and the reload below shows the login page. Only a real outage is transient.

**In `performSoftRefresh()`, at `httpError.eveTransient =`**

5xx / 408 / 429: the server or a proxy is struggling, and a reload would only show its error page. 4xx (401/403 = session) still reloads so the login shows.

**In `performSoftRefresh()`, at `if (response.redirected &&`**

A redirect to a login/SSO page is the classic silent failure: status 200, completely wrong content.

**In `performSoftRefresh()`, at `if (!newGroups.length) {`**

Sanity check: swapping in a login page would make the tracker think every server vanished.

**In `performSoftRefresh()`, at `if (softRefreshFailingSince) {`**

Cleared BEFORE the swap: the scan that follows it is what reports health OK again, and it will not while this is set.

**In `performSoftRefresh()`, at `devLog('Soft refresh OK — ${swapped} table(s) updated, ' +`**

devLog: this runs every cycle (every 10s at the fastest setting) - see startAutoRefresh().

**In `performSoftRefresh()`, at `if (error && error.eveTransient) {`**

Network down, timed out, or 5xx. A full reload here would navigate to the browser's own error page, where this script does NOT run - the tracker would stop, silently, until someone reloaded by hand. Keep the page on screen (stale, but alive and still scanning), say so, and try again next cycle; the first good refresh clears it.

**In `performSoftRefresh()`, at `warn('Soft refresh failed — full page reload as ' +`**

The fail-safe, for failures a reload can fix or at least make visible (session expired -&gt; login page, page structure changed). The next cycle tries soft refresh again. (The old "3 failures -&gt; hard reloads for the session" counter was unreachable: this reload resets it.)

### `swapEveTables()`

Replace ONLY the EVE tables. Cheaper than swapping the whole body, preserves scroll position, and cannot disturb anything the tracker injected. Falls back to swapping the page-owned body children if the table count no longer matches.

**In `swapEveTables()`, at `invalidateHeaderCache();`**

The live cache is about to be invalidated by the swap.

**In `swapPageBody()`, at `if (node.tagName === 'SCRIPT') {`**

Scripts imported this way never execute, so importing them only bloats the DOM.

### `afterSwap()`

Reconnect the observer and run the pipeline it would have run. Headers are resolved ONCE here and handed to all three consumers, instead of each recomputing them.

**Inline notes**

- `throw transientRefreshError(error);` - body cut off mid-read

## PAGE MUTATION OBSERVER

**In `isRelevantMutation()`, at `if (mutation.type === 'childList') {`**

childList mutations that add or remove tracker nodes report mutation.target as document.body, which is NOT own UI. The old target-only check therefore treated appending the alert container, the export download link and the copy textarea as real page changes and ran a full re-scan for each.

**In `observePage()`, at `invalidateHeaderCache();`**

The page changed for real, so any cached header layout is suspect.


### `touchesTable()`

v0.9.11. Only mutations inside or around a table count as new rack data (`rackDataAt`, the event-claim clock). The observer also fires for any other page change that is not our own UI; letting those move the clock would make a tab's STALE table look freshly seen and turn another tab's already-processed event into a "new" one. `pendingRackChange` carries the fact across the 250 ms debounce so a burst is not lost.
## NOTIFICATION TIMEOUT (ms)

GM\_notification's "timeout" is the time in ms after which the toast auto-closes. A literal 0 reads as "close after 0ms", i.e. create and destroy in the same tick, which looks exactly like "no toast appeared". The correct way to say "never auto-close" is to OMIT the key entirely.

## CENTRAL DESKTOP NOTIFICATION SENDER

One payload builder for every call site.

```text
* "timeout" is added ONLY when it is a real positive duration.
* A unique "tag" per toast detaches its lifetime from the page,
  so an unread toast survives the auto-refresh and a new alert
  never silently replaces an older one.
* If the embedded icon is rejected, the send is retried
  text-only rather than losing the alert entirely.
```

**In `sendDesktopNotification()`, at `silent:`**

Passes are the common case, failures are the actionable one. Making both audible inverts the signal-to-noise ratio and trains the operator to ignore the sound.

**In `sendDesktopNotification()`, at `const sentAt`**

ondone fires when the toast closes for any reason. Closing within a few ms means it was killed instantly rather than shown - the signature of a zero/near-zero timeout.

## NOTIFICATION ICONS (embedded, no external dependency)

```text
FAIL / PRE-TEST FAIL -> solid red square, white X
PASS                 -> solid green square, white check
```
256x256 PNG data URIs, so nothing needs hosting and they work even with no outbound access from the intranet.

## THE TRANSITION TABLE - ONE SOURCE OF TRUTH

Every category used to be re-encoded independently in eight places: getTransitionIcon(), getStatusLine(), getTransitionTitle(), LOG\_CATEGORIES, the .csv categoryNames map, ALERT\_CLASS\_BY\_TRANSITION, isDiagnosticTransition() and the toast-summary counters. Adding SYS\_DEKIT in v0.9.5 meant threading it through all eight by hand, and the toast counters are the one that got missed.

KEY ORDER HERE IS THE ORDER OF THE .txt REPORT SECTIONS. It matches the previous LOG\_CATEGORIES array exactly.

```text
diagnostic  not a hardware result: excluded from the failure
            denominator, never interrupts anyone
failure     counts toward the FAIL half of a toast summary
```

**`DEKIT_FAILURE:`**

SYS\_DEKIT carries the PASS icon even on Pass=0. A diagnostic is not a failure, and the one occasion it reaches the desktop is a RETRACTION of an alert that wrongly called it one.

**In `getTransitionIcon()`, at `return meta ? meta.icon : ICON_FAIL;`**

Unknown transition keeps the old fallback: the red X.

## SHARED NOTIFICATION FORMAT

ONE canonical format, used everywhere a notification is built: the in-page card, the desktop toast, real transitions and debug test buttons alike. No exceptions.

```text
Title:   TEST FAIL ❌ / TEST PASS ✅ / PRE-TEST FAIL ❌
```
Body:
```text
Serial #: XXXXX
📍 Section • EVE## • U#
Testing 🟢. . . ► Test FAIL ❌
```

## NOTIFICATION PERMISSION CHECK

IMPORTANT: GM\_notification does NOT use the page-level Notification API. Notification.permission for THIS PAGE has no bearing on whether a toast appears. What actually controls it:

```text
1. Tampermonkey's own extension permissions
   (edge://extensions -> Tampermonkey).
2. Edge's notification permission for the EXTENSION, not the
   eveslt.php site (edge://settings/content/notifications).
3. Windows notification settings for Edge itself
   (Settings -> System -> Notifications), plus Focus Assist /
   Do Not Disturb, which swallow toasts with no error anywhere.
```

## NOTIFICATION SELF-TEST

Fires five toasts, each isolating ONE variable, ~2s apart. Whichever ones appear tell you exactly what is broken.

```text
1 BASELINE  plain ASCII, no image, no timeout, no tag
             -> if THIS fails, nothing about this script is at
                fault: the extension or OS is blocking every
                toast. Fix permissions, not code.
2 TIMEOUT0  same as 1 but with a literal timeout: 0
3 EMOJI     unicode title and body, no image
4 IMAGE     baseline plus the embedded base64 icon
5 FULL      exactly what a real alert sends
```

**`try {const consoleTarget =`**

Expose on unsafeWindow. With "@grant" set, the script runs in a sandbox, so a plain window.x assignment is NOT reachable from the F12 console - which is exactly where this is meant to be run.

**`consoleTarget.eveNotifyDiagnostic = function () {`**

Gated on Developer Mode at CALL time: page JavaScript can reach anything on unsafeWindow, and this fires five toasts through the extension. Low impact, but no reason to leave it armed on a page the tracker does not control.

## NORMALIZE COLOR

Order matters for cost. Inline style is free. The legacy bgcolor attribute is free and is what old PHP pages actually emit. getComputedStyle() forces a style recalc, so it is the last resort - previously it ran for every cell on every scan whenever no inline style was present.

## TEST PHASE HINT - REMOVED

getTestPhaseHint() read explicit data- attributes ONLY. This page emits legacy bgcolor markup and no data- attributes at all, so it returned '' on every call in production - which is exactly what the v0.9.4 investigation found.

Since v0.9.4 the PHASE half of every label comes from the server's own detail page (parseDetailDocument). Nothing reads the hint any more: its only remaining effect was populating info.phase, which fed previousStates.phase and a phaseChanged dirty flag, i.e. it could change WHEN sessionStorage was written and nothing else. Removed along with both.

NOTE: record.phase / parsed.phase are a DIFFERENT field, set from the detail page, and are untouched.

## PHASE CONFIRMATION (authoritative, from the detail page)

WHY THIS EXISTS

The original design inferred the TEST PHASE from the cell COLOR:

```text
lightblue  -> red        assumed PRE-TEST FAIL
lightgreen -> red        assumed TEST FAIL
```
That premise is false. A server observed going lightgreen -&gt; red on the rack page had, on its own detail page:

```text
taskset:        PRETEST
taskset_status: FAIL
Operation:      PRETEST
```
So a machine in PRE-TEST renders LIGHT GREEN while it is running. Color is a STATUS channel (queued / running / failed / passed), not a PHASE channel. The two were conflated, which means:

```text
* Any pre-test that renders green before failing - i.e. most of
  them, since 5_POWER_ON takes time - was logged as TEST FAIL.
* lightblue -> red only ever caught a pre-test that died before
  it went green.
* The permanent audit log has been recording the wrong CATEGORY,
  which is the failure that actually matters here.
```
Compounding it, the old getTestPhaseHint() read only data- attributes. This page emits legacy bgcolor markup and no data- attributes at all, so info.phase was ALWAYS '' and the re-label branch in getTransitionType() never executed once in production.

THE FIX

Color still DETECTS the event - it is the only per-scan signal available, and it is cheap. But the LABEL now comes from the server's own detail page, which states the phase explicitly. One fetch per detected event, never per scan.

Failing to confirm must not silently produce a confident wrong label, so an unconfirmed alert is marked as such in the card, the toast and the log rather than asserting a phase it did not verify.

**`const TOAST_CONFIRM_WAIT_MS`**

How long flushPendingToasts() will wait for confirmations before sending anyway. A fail toast three seconds late is fine; a fail toast with the wrong phase on it is not.

**`const MAX_PHASE_CACHE_ENTRIES`**

CAP + TTL SWEEP.

This cache used to be unbounded: one entry per url|serial, each holding a full parsed result, for the life of a tab that is meant to stay open all shift on a floor of up to 500 servers. The TTL was only ever consulted on READ, so nothing was ever evicted. Every other collection in this script has an explicit cap - MAX\_LOG\_ENTRIES, MAX\_STORED\_ALERTS, MAX\_RECENT\_ALERT\_KEYS
- and this one did not.

**In `cachePhaseResult()`, at `phaseConfirmCache.delete(cacheKey);`**

Delete first so a refreshed key moves to the END of the Map's insertion order; otherwise oldest-first eviction below could drop an entry that was just re-read.

**In `cachePhaseResult()`, at `while (phaseConfirmCache.size > MAX_PHASE_CACHE_ENTRIES) {`**

Still over cap with nothing expired - a genuine burst. Drop oldest-first; Map iterates in insertion order.

**`const PRETEST_OPERATION_RE`**

Normalize whatever the page calls the phase into PRETEST / TEST. "PRETEST", "Pre-Test", "pre\_test" and "PRE TEST" all appear in the wild depending on which column you read.

**`const PRETEST_OPERATION_RE`**

OPERATION -&gt; PHASE

v0.9.5. The old version matched only /pre-?test/ and /\btest\b/. The Operation column on the real page does NOT contain the word "test" for the regular stage - it says SLT (System Level Test). So every regular-stage row fell through to '' and every card ended up "phase NOT verified - detail page did not state a phase", which is what the field screenshots show.

The page's operation vocabulary is a small closed set with exactly one pre-test value. Anything that is NOT a pre-test operation is, by definition, a post-pre-test stage, so the fallback is TEST rather than ''. Whether the word was RECOGNISED or merely assumed is reported separately (phaseExact) and the literal operation string is kept and displayed, so an operation this script has never seen shows up verbatim on the card instead of being silently discarded.

**`const DEKIT_OPERATION_RE`**

SYS\_DEKIT is neither pre-test nor test. It is a housekeeping / diagnostic pass the factory runs against a server, it routinely finishes with Pass=0, and none of that is a hardware result an operator should be woken up for. Without this it matched the "not a pre-test word, therefore TEST" fallback below and every SYS\_DEKIT row was being reported as a TEST FAIL.

### `isKnownOperationWord()`

Did we RECOGNISE the operation word, or just assume TEST because it was not a pre-test word? Drives phaseExact on the result.

### `normalizePassFlag()`

THE Pass COLUMN IS THE RESULT

Per-row boolean: 1 = that operation passed, 0 = it did not. taskset\_status is empty on PRETEST rows, so it cannot be the primary signal - the boolean can, and is.

Returns 1, 0 or null (column absent / not a boolean).

### `cellText()`

Read the two things the detail page states explicitly:

```text
Server Information -> Server Serial   (identity check)
Test Status        -> Operation / taskset / taskset_status
```
Columns are located BY HEADER NAME, never by fixed index - the detail page is not ours and column order can move.

### `cellText()`

Cell text arrives with newlines and stacked values (the taskcase column holds several task names in one cell), so collapse whitespace rather than comparing raw textContent.

**In `parseDetailDocument()`, at `operation:`**

The literal Operation cell ("PRETEST", "SLT", ...) so the card can show what the page actually said.

**In `parseDetailDocument()`, at `phaseExact:`**

false = phase was ASSUMED from "not a pre-test word".

**In `parseDetailDocument()`, at `pass:`**

1 / 0 / null - the authoritative per-row result.

**In `parseDetailDocument()`, at `running:`**

true = the chosen row has not finished, so its Pass value is not a result yet and must not be read as one.

**In `parseDetailDocument()`, at `resultConfirmed:`**

Independent of `confirmed`: the phase can be known while the result is still pending.

**In `parseDetailDocument()`, at `rackSerialOnPage:`**

Rack Serial / Position from the detail page, used to verify that the slot the tracker READ is the slot this server actually occupies.

**In `parseDetailDocument()`, at `doc.querySelectorAll('tr').forEach(row => {`**

----- identity: Server Serial from the property table -----

**In `parseDetailDocument()`, at `let statusTable`**

----- the Test Status table -----

**In `parseDetailDocument()`, at `const bodyRows`**

----- pick the row -----

Prefer the row whose SN matches the serial we are confirming. Otherwise take the LAST row, which is the most recent attempt.

**In `parseDetailDocument()`, at `const snIndex`**

A server that has been retested has SEVERAL rows for the same SN - the real page shows two PRETEST FAILs 45 minutes apart. Take the row with the LATEST Started, not the last row in document order: nothing guarantees the page sorts ascending, and picking the wrong row means reporting a stale result.

**In `parseDetailDocument()`, at `const started`**

"2026-09-09 21:51:10" sorts correctly as a string.

**In `parseDetailDocument()`, at `const operationCell`**

----- phase: Operation, then taskset as a fallback -----

**In `parseDetailDocument()`, at `result.pass = normalizePassFlag(readColumn('pass'));`**

----- result: the Pass boolean is authoritative -----

Pass is 1 or 0 on EVERY row. taskset\_status is blank on PRETEST rows, so it corroborates but never leads.

**In `parseDetailDocument()`, at `result.running = !result.finished && !statusWord;`**

A row with no Finished timestamp and no status word has not produced a result yet. Its Pass column reads 0 because it has not passed YET, not because it failed - reading that as a failure would invent one.

**In `parseDetailDocument()`, at `result.status = statusWord;`**

No usable Pass column - fall back to the words.

**In `parseDetailDocument()`, at `if (statusWord &&`**

The Pass boolean and taskset\_status disagreeing means one of the two columns is not what this script thinks it is. Say so rather than picking a winner silently.

**In `parseDetailDocument()`, at `result.confirmed = true;`**

Phase is confirmed even when the result is still pending - knowing the server is in SLT is worth having on the card.

### `fetchDetailDocument()`

Fetch + parse one detail page, with a concurrency cap so that a burst of 50 simultaneous failures does not open 50 sockets.

### `normalizeRackSerial()`

Does the detail page agree about WHERE this server is?

The rack page gives us section/eve/unit purely from column arithmetic (th.cellIndex -&gt; row.children[column]). The detail page states Rack Serial and Position independently. If those disagree, the tracker read the WRONG CELL - which is the colspan /column-misalignment failure, caught at runtime against live data instead of by inspecting markup.

### `normalizeRackSerial()`

The rack page header and the detail page's Rack Serial are two different systems printing the same identifier, and they do not agree on zero padding (EVE5 vs EVE05) or on what may trail it. Compare the PARTS, not the strings, or the check reports a mapping fault every time the two spell the same rack differently.

**In `checkLocationAgreement()`, at `if (!info.section || !info.eve || !info.unit) {`**

A restored record with no slot parts cannot be checked. Say "unknown" rather than comparing against "TA.undefined- undefined" and raising a slot-mismatch alarm about nothing.

**In `checkLocationAgreement()`, at `let positionOk`**

Position is a bare number; unit is U05 / U15. Compare numerically so zero padding cannot cause a false alarm.

**`const SLOT_DISAGREEMENT_ESCALATION`**

WHEN IS A SLOT DISAGREEMENT A COLUMN-MAPPING FAULT?

v0.9.5. It used to be: always, on the first one, straight to a DEGRADED desktop toast reading "This page may NOT be monitored".

That is the wrong inference from a sample of one. Column mapping is a property of a TABLE, not of a server: if th.cellIndex were being read against the wrong column, essentially every server in that table would land in the wrong slot, not one. A single disagreement is far more likely to be a machine that moved, a detail page that has been updated since the rack page rendered, or a stale row.

So: count. Escalate only when the evidence actually looks like a mapping fault - several disagreements in one table and not one agreement. A lone disagreement is logged and nothing else.

**In `confirmPhase()`, at `const checkLocation`**

live:false = this is a retroactive re-check of a stored card, not a reading taken just now.

**In `confirmPhase()`, at `const cacheKey`**

Started is not known yet, so cache on identity only and keep the TTL short - a retest must not read a stale confirmation.

**In `confirmPhase()`, at `const force`**

force = a deliberate re-check of a card whose result was pending. Serving it the same cached "pending" answer it is retrying BECAUSE of would make the retry a no-op.

**In `confirmPhase()`, at `if (phaseConfirmFailures >= 3) {`**

Labels silently reverting to colour guesses is exactly the condition that produced the original mislabelling, so it must be visible rather than inferred from the console.

**In `confirmPhase()`, at `if (parsed.serialMatches === false) {`**

A detail page for a DIFFERENT server means the cell's link is wrong, and every label derived from it would be about the wrong machine. Never silently accept that.

**In `confirmPhase()`, at `const location`**

Independent verification that we read the right CELL. The serial matching only proves the LINK is right; this proves the slot arithmetic is right.

Only meaningful for a CONTEMPORANEOUS reading. Re-confirming a card restored from an earlier session compares a slot recorded hours ago against where that server sits now, and a failed server that has since been pulled and re-racked will always "disagree" - correctly, and about nothing.

## VALID TRANSITIONS

These three color pairs are the ONLY thing that raises an alert:

```text
lightblue  -> red        PRE-TEST FAIL
lightgreen -> red        TEST FAIL
lightgreen -> darkgreen  TEST PASS
```
The phase hint cannot add a fourth. It can only re-label a TEST\_FAILURE as a PRETEST\_FAILURE when the markup explicitly says the server was in pre-test - which covers the real case where a pre-test red follows a light-green render.

The previous version checked the phase FIRST and returned PRETEST\_FAILURE for any "X -&gt; red", including darkgreen -&gt; red and blank -&gt; red, which the spec deliberately ignores.

**`const FAILURE_FROM_COLORS`**

Colors that mean "this slot was in an active, pre-result state". A move from any of these to red is a real result.

darkgreen is included deliberately: a server that passed and is then retested and fails goes darkgreen -&gt; red. Missing that failure would be worse than reporting a redundant transition.

### `getTransitionType()`

Color DETECTS the event and supplies a PROVISIONAL label. The phase in that label is a guess and is overwritten by confirmPhase() as soon as the detail page answers.

Provisional phase is the old color's best guess only so that a card can appear instantly; nothing downstream may treat it as authoritative. phaseSource on the record says which it is.

**In `getTransitionType()`, at `if (newColor === 'darkgreen' && oldColor === 'lightgreen') {`**

Pre-test success (lightblue -&gt; darkgreen) is intentionally ignored because it immediately continues into regular test.

**`const TRANSITION_BY_PHASE_RESULT`**

RESOLVE THE FINAL LABEL FROM THE DETAIL PAGE

v0.9.5. The old applyPhaseToTransition() could only swap the PHASE half, and only on a card that was already a FAILURE. That left the RESULT half permanently owned by cell colour, which is the other half of the same bug: the detail page states the result explicitly as a per-operation boolean and was being ignored.

The detail page is authoritative, with ONE deliberate asymmetry:

```text
detail says FAIL  -> always applied. A failure is never lost.
detail says PASS  -> applied only if the colour did not already
                     say FAILURE.
```
The asymmetry exists because the Test Status table can lag the rack colour by a scan or two. If colour has gone red and the newest row still shows the previous operation passing, that row is stale; downgrading a red to a PASS on the strength of it would silently drop a real failure. Upgrading in the other direction costs nothing worse than one card that says FAIL for a few more seconds than it had to.

### `isDiagnosticTransition()`

Diagnostic events are recorded and labelled like anything else. What they never do is interrupt anyone.

**In `isDiagnosticTransition()`, at `return /^DEKIT_/.test(String(transition || ''));`**

An unknown DEKIT\_\* variant is still a diagnostic. Kept as a fallback so a category added to the page but not yet to TRANSITIONS cannot start raising desktop failures.

**In `resolveTransitionFromDetail()`, at `if (parsed.phase === 'DEKIT') {`**

A diagnostic pass is not a hardware result in either direction, so it overrides the colour outright rather than being merged with it. Colour saw the cell go red; the page says that red is SYS\_DEKIT, and SYS\_DEKIT going red is not a failure of anything.

**In `resolveTransitionFromDetail()`, at `if (!parsed.status) {`**

No result on the page yet: keep the colour's result half and correct the phase half only.

**In `resolveTransitionFromDetail()`, at `if (parsed.status === 'PASS' && provisionalIsFailure) {`**

Never let a stale PASS row erase a failure the colour caught.

## READ SERVER INFORMATION

**In `getServerInfo()`, at `detailUrl:`**

The cell links to its unique server-detail page. Persisted with the alert so the card can open the exact server that generated the result, even after a refresh.

## FLAP PROTECTION

A cell oscillating between colors would alert and log on every flip. The same SLOT + SERIAL reporting the same transition within the cooldown is ignored.

The serial is part of the key on purpose. Keying on the slot alone meant that pulling a server and racking a replacement that genuinely failed the same way inside 60s was suppressed - the flap guard silently swallowed a real failure.

Persisted, because a hard reload used to wipe the in-memory map and re-arm every cooldown.

**In `saveRecentAlerts()`, at `writeJSON(sessionStorage,`**

Silent by design: worst case a flap slips through after a reload, which is not worth a console warning per write.

**In `isDuplicateAlert()`, at `if (recentAlerts.size > MAX_RECENT_ALERT_KEYS) {`**

The expiry sweep alone does NOTHING when every key is still live - which is exactly the burst case this cap exists for. Evict oldest-first until it actually holds.

## EVENT CLAIMS (one event -> one log entry + one toast, across tabs)

v0.9.11. ROOT CAUSE OF DUPLICATE LOG ENTRIES AND TOASTS ("SN -> FAIL" twice): every running copy of the tracker processed every transition on its own. Each tab has its own baseline (sessionStorage), its own flap cooldowns and its own toasts, and mints its own eventId - but the audit log is SHARED (localStorage, merged by eventId). So two tabs on the same rack page, or the same tab with the script installed twice, each logged and toasted the same real event: two identical log entries, two identical toasts. Reproduced in tests/dedupe.test.mjs (fails on 0.9.10). Intermittent in the field because it only happens while a second tab (or a second installed copy) is open.

Two separate guards, because the two cases differ:

- Same tab, two installed copies: `claimThisTab()` (INITIALIZE). The DOM is shared, so the first copy marks `<html data-eve-slt-tracker="version">` and later copies stay idle with a console warning naming both versions. Copies older than 0.9.11 do not check the mark - remove them in the Tampermonkey Dashboard.
- Several tabs: a shared claim per event in localStorage (`eveRackTrackerEventClaims`), key `slot|serial|transition`, value `{ at, eventId }`. `at` is the time the rack data that showed the change arrived in the claiming tab (`rackDataAt`).

What counts as THE SAME EVENT (never "the same serial"): a detection matches a claim when this tab's last sighting of the slot's PREVIOUS state (`previousStates[key].seen`) is not newer than the claim. Another tab's copy of the same FAIL was last seen testing BEFORE the first tab claimed it -> same event -> this tab shows the card (a view) but does not log, toast, or write the log entry. After a retest this tab has seen the slot back in testing AFTER the claim, so the next FAIL is a new event and is processed normally; FAIL then PASS is a different transition key anyway. No time window decides this, so a legitimate later event can never be swallowed by it.

`rackDataAt` moves only when rack data actually changes: page load, a soft-refresh swap, or a relevant page mutation. The 4 s re-scans of the same DOM do not move it, so a sighting from a stale page never outranks a claim.

Unknown `seen` (a baseline saved by an older version) never suppresses: the event is processed. Claims are pruned at 12 h and capped at 400 entries.

Residual limit, by design: two tabs whose refreshes complete within the same few milliseconds can both see no claim yet (localStorage is not a lock). Tabs refresh on their own schedules, so this needs a coincidence; a Web Lock would close it at the cost of making detection asynchronous.

Also fixed while tracing duplicate toasts: see `trackConfirmation()` (ALERT PERSISTENCE) and `confirmEvent()`.

### `findEventClaim()`

Returns the claim when this detection is the same event another tab already processed, else null. `seenAt` missing -> null (never suppress on unknown data).

### `recordEventClaim()`

Written for every event this tab logs, flap repeats included (keeps the claim's time current, so another tab's copy of a repeat is also recognised). Prunes old claims on write so the key stays small.

## SCAN PAGE

Walks each EVE table's rows ONCE and loops that table's header columns inside. The old shape was

```text
headers.forEach(h => h.closest('table')
    .querySelectorAll('tbody tr').forEach(...))
```
which re-walked every row once per header - eight EVE columns in one table meant eight complete row walks, each doing a getComputedStyle() and an attribute sweep per cell.

**In `scan()`, at `let statesDirty`**

Tracks whether this scan observed any change, so idle scans skip the sessionStorage write entirely.

**In `scan()`, at `const seenKeys`**

Every slot key seen this pass. Anything in previousStates that is NOT here has vanished and gets pruned below.

**In `scan()`, at `let slotErrors`**

Slots that threw. Fed into the health chip, because a scan that partially failed must not look like a clean one.

**In `scan()`, at `const sectionCounts`**

Live per-section status for the panel (testing/failed/passed).

**In `scan()`, at `const unit`**

First cell = U#

**In `scan()`, at `try {processSlot(header, unit, info, seenKeys, () => {`**

One malformed cell must not abort the remaining slots. The old shape terminated the whole scan, skipped savePreviousStates(), and left in-memory state half-mutated with no UI signal at all.

**In `scan()`, at `if (headerCount && previousStates.size) {`**

PRUNE VANISHED SLOTS

The old guard checked that HEADERS were found. That is NOT the same as slots being READABLE: getServerInfo() returns null for any cell with no &lt;a&gt;, so a maintenance banner, a partial render, a markup tweak or a detached header cache all produced headerCount &gt; 0 with an EMPTY seenKeys - and every tracked baseline was deleted. The next scan then re-baselined the whole rack, discarding every transition in that window, while the panel reported a perfectly healthy scan.

Preserve state and go DEGRADED instead. Never prune on a scan that read implausibly few slots.

**In `scan()`, at `if (!headerCount) {`**

BLIND DETECTION

Zero headers means the page structure changed, the page failed to load, or the table is rendered by page JavaScript. Whatever the cause, nothing is being monitored - and that must not look identical to "no alerts because all is well".

**In `scan()`, at `!softRefreshFailingSince`**

A stale page still scans cleanly - that is not "OK".

**In `scan()`, at `if (headerCount) {`**

A scan that found no headers read nothing - keep the last good counts rather than flash every section to zero.

**In `scan()`, at `flushPendingToasts();`**

Coalesce this cycle's toasts. Must run after the WHOLE pass, so a batch completing produces one summary, not a storm.

**`const STATUS_BY_COLOR`**

SECTION STATUS COUNTS

How many servers in each section are testing / failed / passed, straight from the rack colours on the latest scan. Shown next to the section name while that section's Show switch is on. Counts come from hidden sections too (the cells are still in the page), so turning Show on displays them at once.

Colour is a STATUS channel (see PHASE CONFIRMATION), which is all these counts claim: lightblue and lightgreen are both "testing" (pre-test and test running), red is "failed" in either phase.

The "fail" pill is the ONE place pre-test fails and test fails are counted together - for at-a-glance reading only. Everywhere else (cards, filters, toasts, log, exports) keeps them separate.

### `syncSectionRowShown()`

Rows carry eve-section-shown while Show is on; CSS hides the counts otherwise.

### `processSlot()`

One rack slot, one scan pass. Split out of scan() so the nesting stays readable now that rows are the outer loop.

**In `processSlot()`, at `if (!oldState) {`**

FIRST SIGHTING = BASELINE ONLY

**In `processSlot()`, at `if (serialChanged) {`**

DIFFERENT SERVER IN THE SLOT

The state key is a RACK SLOT, not a server. If the serial changed, a different physical machine is now in this slot and any color difference is between two unrelated servers.

Without this guard, pulling a passing server (lightgreen) and racking one that is already red produced a "TEST FAIL" against the NEW server's serial - a machine that never failed - and wrote that into the permanent audit log.

**In `processSlot()`, at `seen: rackDataAt`**

When this state was last seen, as rack-data time. Updated (and persisted) whenever fresh data re-confirms it, because the event-claim test compares against it. See EVENT CLAIMS.

**In `processSlot()`, at `if (findEventClaim(`**

Another tab already logged and notified this exact event: show the card here (a view, confirmed from the detail page) but never log, toast, or link it to the log entry. The flap map is still updated so a flicker repeat does not become a card either.

**In `processSlot()`, at `const suppressed`**

Dedup gates SURFACING only. It used to return above recordTransition(), which made the "the log can never develop silent holes" claim above FALSE: a genuine second failure of the same slot+serial inside the cooldown was never recorded at all. Repeats now bump a counter on the existing entry, so the log stays truthful without growing once per 4s scan tick.

**In `processSlot()`, at `const eventId`**

LOG, CONFIRM, THEN SURFACE - IN THAT ORDER

The log entry is written first and unconditionally. The per-section "Notifs" flag and the flap guard suppress the CARD and the TOAST, never the record.

Confirmation is attached to the EVENT, not to the card. It used to be started inside surfaceAlert(), which meant a transition in a muted section, or one suppressed as a flap repeat, was written to the permanent log with phaseSource 'color' and then never corrected - the audit trail was only as good as the notification settings. Now the fetch runs for every recorded event, the entry is updated when it answers, and the card (if there is one) is reconciled from that same promise rather than fetching the page twice.

### `confirmEvent()`

Confirm a recorded EVENT. Independent of whether that event is ever shown to anyone.

Returns the promise so surfaceAlert() can reuse it: one fetch per event, log updated first, card reconciled after.

`force: true` (v0.9.11): a NEW event always reads the detail page fresh. The 2 min cache is keyed by serial, so a retest that finishes (or fails pre-test) within 2 min of the previous result was being confirmed with the previous event's answer - e.g. FAIL then PASS logged as FAIL twice. Found by the "FAIL then PASS" test in tests/dedupe.test.mjs.

**In `confirmEvent()`, at `if (isLogEntryResolved(eventId)) {`**

A flap repeat re-points at an entry that is already fully resolved. Re-fetching its detail page every 4s would add nothing and cost a request each time.

## SURFACE AN ALERT (in-page card + desktop toast)

**`let pendingToasts`**

Cards stay strictly 1:1 with transitions - the panel is the complete record. Only the OS-level interrupt is rate limited.

One toast per transition with a unique tag was correct at 10 servers and catastrophic at 500: a batch completing produces hundreds of simultaneous toasts, and the operator's rational response is to mute notifications - at which point monitoring has effectively stopped.

**`const CORRECTION_TOAST_MAX_AGE_MS`**

A card whose label is corrected AFTER its toast has gone out is a silent miss on the desktop: the confirmation fetch is bounded at TOAST\_CONFIRM\_WAIT\_MS and the queue is capped at four parallel requests, so in a burst the toast fires on the colour's provisional label - which for a pre-test failure reads TEST FAIL, because colour cannot tell the two apart. The card then quietly becomes PRE-TEST FAIL and the operator, who is watching the desktop rather than the panel, never sees the distinction.

So: when the label changes after the fact, say so.

### `markToastSent()`

Records what the DESKTOP was told, which is not necessarily what the card says a few seconds later.

**In `notifyLabelCorrection()`, at `if (previousTransition === record.transition) {`**

Only the desktop needs telling. The card has already updated itself in place.

**In `notifyLabelCorrection()`, at `if (!record.ts ||`**

A reload can re-check cards from hours ago. Correcting the label on those is right; interrupting someone about them is not.

**In `notifyLabelCorrection()`, at `if (isDiagnosticTransition(record.transition) && !becameDiagnostic) {`**

Turning out to be a SYS\_DEKIT is the one correction worth sending about a diagnostic: an alert already went out calling it a failure, and leaving that standing sends someone to a rack for nothing. Every other diagnostic transition stays silent.

**In `surfaceAlert()`, at `record.eventId = eventId || '';`**

Both directions of the link. eventId is the stable one; alertId lets the log entry be found from the card.

**In `surfaceAlert()`, at `const confirmation`**

Reuse the EVENT's confirmation rather than starting a second fetch for the same server. The log is updated inside that promise, so by the time the card reconciles the audit entry is already correct.

### `flushPendingToasts()`

Called once at the END of scan(), so a whole refresh cycle's events are weighed together rather than one at a time.

**In `flushPendingToasts()`, at `const confirmations`**

Wait for the detail pages to answer before the toast fires. A fail toast a few seconds late is fine; a fail toast with the WRONG PHASE printed on it is the bug we are fixing. Bounded, so an unreachable detail page cannot hold the toast for ever - it goes out marked unverified instead.

**In `flushPendingToasts()`, at `batch.forEach(item => {`**

Read the FINAL label off the record, not the provisional one captured when the event was queued.

**In `flushPendingToasts()`, at `const diagnostics`**

SYS\_DEKIT is a factory diagnostic, not a hardware result. The card and the log entry both exist; the desktop is left alone. Stamped as already-announced so the correction path below does not later decide the desktop is owed an update about it.

**In `flushPendingToasts()`, at `const failParts`**

Test fails and pre-test fails are named separately, never summed into one "N FAIL" (the section "fail" pill is the only place they are combined).

## DEBUG: PERSISTENCE TESTER (Developer Mode only)

Snapshots previousStates before a refresh, then compares against what loads back afterwards.

Gated on developerMode. The old build ran this on EVERY unload - including a tech clicking a server-detail link - serialising all of previousStates to sessionStorage each time and dumping a PASS/FAIL block to the console on every load.

## RANDOM TEST DATA

**In `randomTestServerInfo()`, at `const serial`**

Prefixed so a test serial can NEVER be mistaken for a real one, on screen or in a notification.

## TEST NOTIFICATION (debug buttons only)

Never touches the audit log or the session counters - it does not go through recordTransition().

**In `sendTestNotification()`, at `if (settings.developerMode) {`**

The test buttons live on the Developer page, so this is always true when one is clicked - kept as a guard, not a setting.

## REAL-ALERT AUDIT LOG

Separate from the dismissable alert cards. A permanent record of every REAL transition the scanner detected - test/debug notifications are excluded by construction, so the log is a trustworthy account of actual server events.

Held in memory and written DEBOUNCED. The old build did a full load -&gt; parse -&gt; push -&gt; stringify -&gt; write of the entire array for every single alert; at 2000 entries that is a several- hundred-KB synchronous main-thread stall per alert, which visibly hitches the browser during a burst.

localStorage (not sessionStorage) so it survives closing the tab and spans shifts. Only ever cleared explicitly by the user.

**`const logDirtyIds`**

SEVERAL EVE TABS, ONE LOG

Every EVE tab writes the SAME localStorage key. Each tab used to write its whole in-memory copy over it, so the last tab to write erased whatever the others had added since it loaded - silent audit loss with two racks open. A write now MERGES with storage (flushAlertLog -&gt; mergeAlertLogWithStorage):
```text
* entries THIS tab added or changed (logDirtyIds) win,
* everything else is taken from storage, so other tabs'
  entries and updates survive and their deletions stick,
* this tab's retention floor (its last shift rollover) and the
  shared clear marker (LOG_CLEARED_KEY) are re-applied, so a
  tab that still holds a pruned or cleared entry cannot write
  it back.
```

### `shiftMinutes()`

WHICH SHIFT DOES A MOMENT BELONG TO?  (see LOG RETENTION)

Local wall-clock time, and entries are placed by their ISO timestamp rather than their rendered `date` string - that one is locale-formatted and cannot be compared reliably.

### `shiftLengthMin()`

Minutes from start to end; an end at or before the start means the shift runs past midnight.

### `shiftClock()`

"22:00" -&gt; "10:00 PM"

### `guessShift()`

First-run default: the running shift that started most recently (23:00 -&gt; Graveyard, not Swing); between shifts, the next one.

### `shiftWindowAt()`

The occurrence of a shift whose window is open at `when` - or, between windows, the most recent one:
```text
opens   start - SHIFT_EARLY_MIN   retention boundary
starts / ends                     the shift itself
closes  end + SHIFT_LATE_MIN      export boundary
key     '<id>@<start date>'       e.g. graveyard@2026-09-21
```
Built from local date parts, so across a DST change the times stay on the wall clock instead of drifting an hour.

**In `shiftWindowAt()`, at `let day`**

Latest opening at or before `at`.

### `shiftWindowLabel()`

"Graveyard shift · Mon 9/21 10:00 PM – Tue 9/22 6:30 AM"

### `isEntryInShiftWindow()`

Inside the window an export covers.

**`let activeLogShift`**

The shift occurrence the in-memory log belongs to. Empty until the first rollover check, which happens at startup.

### `pruneLogBefore()`

Retention: drop everything from before `opensMs` (and anything with no readable timestamp).

**In `pruneLogBefore()`, at `logRetentionFloor = opensMs;`**

Every later merge applies the same floor - see SEVERAL EVE TABS, ONE LOG.

**In `pruneLogBefore()`, at `logWritePending = true;`**

Written immediately rather than through the debounce. A destructive change that is still sitting in a timer when the page reloads leaves storage and memory disagreeing about what the log contains.

## AUTO LOG SHIFT

The user no longer picks a shift. `autoShiftId(now)` keeps the shift the session is in until its window closes (end + SHIFT_LATE_MIN), then takes the shift running at that moment (`guessShift()`: the running shift that started most recently). The occurrence key is stored per browser (LOG_AUTO_SHIFT_KEY) so every tab exports the same window; a stored key that is closed or stale is recomputed. On an open tab that gives Graveyard until 7:30 AM, Day until 3:30 PM, Swing until 1:15 AM - the overlaps (Swing and Graveyard both run 10 PM - 12:15 AM) never flip it mid-shift. A fresh session inside an overlap gets the shift that started most recently (Graveyard at 11 PM); a hand pick covers the rare other case.

### `logShiftOverride()` / `currentShiftId()`

A hand pick applies only while Auto is still on the occurrence it was made in; after that `currentShiftId()` is Auto's.

### `logRetentionFloorAt()`

What a rollover may delete: only entries older than EVERY shift's most recent window (`min` of each shift's `shiftWindowAt(now).opens`). The +/-60 min margins make neighbouring windows overlap (Graveyard 9 PM - 7:30 AM, Day 5 AM - 3:30 PM), so clearing at the selected shift's own `opens` - the rule before 0.9.11 - deleted a neighbour shift mid-run: a browser left on Day wiped the running Graveyard log at 5:00 AM. With this floor each shift's latest log survives until that shift opens again, so switching the dropdown can still export it. Worst-case retention is about a day and a half, bounded by MAX_LOG_ENTRIES.

### `checkLogShiftRollover()`

Called at startup and on the master tick; `now` is a parameter only so tests can simulate a clock. First expires a hand pick whose shift change has passed and refreshes the dropdown. Cheap when nothing has changed: one key comparison. Runs only when TIME moves into the next occurrence of the current shift (Auto's, or the pick's) - never at midnight, never mid-shift, and never because the shift setting was changed (see setLogShiftChoice) - and then clears only below `logRetentionFloorAt()`.

**In `checkLogShiftRollover()`, at `if (!previous) {`**

previous === '' means this ran at startup against a log left over from an earlier session - expected, and not worth interrupting anyone for. A rollover DURING a session is different: entries the operator could see a minute ago are gone, and they get told so.

**In `checkLogShiftRollover()`, at `sendDesktopNotification(`**

No icon: this is routine, and the red X means "failure".

### `logShiftTooltip()` / `updateLogShiftControl()`

The dropdown shows "Auto - <shift> now" or the hand pick, and the tooltip says which (Auto / Manual), the exact window and when its log is cleared. Refreshed on every rollover check and pick; DOM is only written when the text changes. The Auto option names the shift only - with the times it was the widest option and pushed the select over its label. The old static tooltip ("cleared when the next one starts") read as if Graveyard's log went when Day started.

### `setLogShiftChoice()`

A dropdown change. A shift pick is stored with the Auto occurrence it overrides (`logShiftOverrideFor`), so it ends by itself at the next shift change - nobody leaves the next crew on the wrong shift. Picking Auto clears it. Clears NOTHING: a mis-click in a dropdown must not delete a shift's worth of entries; anything outside the new window simply stops appearing in exports.

### `logEntryId()`

Stable identity of an entry across tabs. Entries from builds before eventId existed fall back to their content.

### `markLogEntryChanged()`

Every change to a log entry goes through here rather than straight to scheduleLogWrite(), so the merge knows which copies are this tab's to keep.

### `flushAlertLog()`

sync = also refresh this tab's copy from storage when it has nothing of its own to write - exports and the clear-log count use it so they include entries other tabs added.

**In `flushAlertLog()`, at `fail('Could not write the alert log to localStorage. Entries ' +`**

Dirty ids and the pending flag are kept, so the next write retries these entries. Almost always a quota error. Surface it loudly - silently losing audit entries is the failure mode that matters.

**In `appendAlertLog()`, at `let evicted`**

Silent truncation of something explicitly framed as a PERMANENT audit log is the wrong default. Warn once per session so the user can export before more is lost.

### `isDebugData()`

Defensive filter for debug/test data. One function for both the scan-time info object and the stored alert record - they were two near-identical helpers before.

**In `logRealAlert()`, at `if (suppressed) {`**

A flapping cell inside the cooldown must not append an entry per scan tick - that is unbounded at 4s intervals. Bump the existing record instead. Bounded backward search: a match older than the last 200 entries is not the same flap episode.

**In `logRealAlert()`, at `return candidate.eventId || '';`**

The repeat belongs to the ORIGINAL entry, so the caller confirms against that one.

**In `logRealAlert()`, at `const eventId`**

Stable identity for this event, independent of any card. The old scheme stamped the LAST log entry with the card's id immediately after appending, which only worked because the two calls happened to be adjacent and only for events that produced a card at all.

**In `logRealAlert()`, at `diagnostic:`**

Set on confirmation. Colour alone can never tell that a red cell is a SYS\_DEKIT run.

**In `logRealAlert()`, at `phaseSource:`**

Overwritten by updateLogEntryForAlert() once the detail page answers. 'color' means the phase half of this category is a GUESS and should not be trusted.

### `findLogEntry()`

LOG ENTRY &lt;-&gt; EVENT

### `writeLogEntryResult()`

The audit entry is corrected the moment the detail page answers, whether or not this event was ever surfaced as a card.

### `writeLogEntryResult()`

THE AUDIT ENTRY'S RESULT HALF, WRITTEN FROM ONE PLACE.

Two callers used to write these nine fields by hand: applyConfirmationToLogEntry() (source: a confirmation) and updateLogEntryForAlert() (source: a card record). Two hand-kept copies is the wrong way to hold up "card, stored copy and log entry are corrected together so the three can never disagree". The SOURCES still differ; the PROJECTION no longer does.

`pass` comes in as the 1/0/null boolean and is stored as a string, because that is what the .csv export column expects.

### `loadRealAlertLog()`

Log entries with all debug/test activity removed. Every export path AND the clear-log confirmation use this, so the counts the user sees always agree with the file they get.

**In `loadRealAlertLog()`, at `const win`**

Shift-scoped as well as debug-filtered: exactly the current shift window, so an export never mixes shifts - even taken between a rollover and the next tick, or after the shift setting was changed and older entries are still stored.

## LOG FORMATTING HELPERS

### `padOrTrim()`

Pads AND truncates. padRight() alone let one long serial or a verbose locale time string break every subsequent column.

### `isoDateParts()`

ISO-derived, locale-independent. Stored date/time are locale strings, which sort as text and differ machine-to-machine.

Always Fremont time (`SITE_TIME_ZONE`, America/Los_Angeles: PDT or PST by date) via Intl, whatever the PC's timezone. Before 0.9.11 it sliced the UTC ISO string, so every export printed UTC. `siteDateTime()` is the same for the .txt header lines and names the zone. Shift windows (`shiftWindowAt()`) and on-screen card times still use the PC clock - correct on the site's Pacific PCs.

### `siteTimeToMs()` / `eventTimeFromDetail()` / `entryWhenIso()`

The detail page's Finished column is a Fremont wall-clock string with no zone. `siteTimeToMs()` reads it as America/Los_Angeles: start from the UTC guess and correct by the Pacific offset at that instant (twice, so a guess on the far side of a DST change settles). `eventTimeFromDetail()` only accepts it when plausible for this detection - at most `EVENT_TIME_SKEW_MS` after it (PC / server clock skew) and at most `EVENT_TIME_MAX_AGE_MS` before it - so a server clock in another zone or an older Test Status row can never move an entry by hours; it then falls back to detection time. `writeLogEntryResult()` stores it as `entry.eventIso`; `entry.iso` stays the detection time because shift-window membership, pruning and ordering are keyed on it. Exports print `entryWhenIso()` (event time if known).

**`const LOG_CATEGORIES`**

Derived from TRANSITIONS, in the order that table declares them. SYS\_DEKIT is last and named for what it is: a factory diagnostic that belongs in the record, but not among the hardware results anyone is counting.

**`const LOG_COLUMNS`**

Column widths drive the rule width, instead of a magic number that did not match either the rule or the columns.

## .TXT REPORT

**In `buildAlertLogText()`, at `const grouped`**

----- SUMMARY ------------------------------------------

**In `buildAlertLogText()`, at `const resultEntries`**

Diagnostics are excluded from the denominator. A floor that ran 40 SYS\_DEKIT passes would otherwise report a halved failure rate without anything having changed on the hardware.

**In `buildAlertLogText()`, at `const bySection`**

----- BREAKDOWN BY LOCATION ----------------------------

**In `buildAlertLogText()`, at `LOG_CATEGORIES.forEach(category => {`**

----- ONE SECTION PER CATEGORY -------------------------

**In `buildAlertLogText()`, at `lines.push(LOG_RULE,`**

----- FULL CHRONOLOGICAL RECORD ------------------------

Every entry already appears once in its category table, so this section is a second copy of the whole log. Capped, since at 2000 entries it doubled the file for no extra information.

## .CSV EXPORT

**In `csvEscape()`, at `if (/^[=+\-@\t\r]/.test(text)) {`**

Excel/Sheets run a cell that starts with = + - @ (or a tab / CR) as a formula. Serials, server types and taskcases come from the rack and detail pages, so one crafted value could put a live formula (HYPERLINK, DDE) into the exported sheet. A leading apostrophe makes it plain text. Numeric columns (repeats, pass) never start with these characters.

**In `buildAlertLogCsv()`, at `const parts`**

ISO-derived so Excel sorts these correctly and the file is identical regardless of the exporting machine's locale.

**In `buildAlertLogCsv()`, at `entry.repeats || 0`**

Flap repeats suppressed from the UI but still counted, so the log reflects what actually happened.

**In `buildAlertLogCsv()`, at `entry.diagnostic ? 'diagnostic' : 'result'`**

'confirmed' = phase read off the detail page. 'color'/'unverified' = the phase half is a guess. 'diagnostic' entries are SYS\_DEKIT: recorded for the audit trail, never a hardware pass or fail.

**In `buildAlertLogCsv()`, at `entry.alertId ? 'yes' : 'no'`**

Whether this event ever produced a card/toast. It is recorded either way; this column says which.

## DOWNLOAD / EXPORT / CLEAR

**In `downloadFile()`, at `const now`**

Named for the SHIFT (its start date + name), then the local export time: a 3am graveyard export is filed under the night the shift started, next to the rest of that shift.
```text
eve-slt-tracker-log-2026-09-21-graveyard-03-12-44.txt
```

**In `downloadFile()`, at `withoutObserver(() => {`**

Wrapped: appending to body is a childList mutation on document.body, which the observer used to treat as a real page change and answer with a full re-scan.

**`const LOG_EXPORTS`**

The two exports were the same six statements differing only in the builder, the extension, the MIME type and one word in the log line.

**In `exportLog()`, at `flushAlertLog(true);`**

Anything still sitting in the debounced write must be on disk before the file is built, or the export can be behind the panel. sync: also pull in entries other EVE tabs wrote.

**In `clearAlertLog()`, at `flushAlertLog(true);`**

Counted the same way the exports count, so the number in the confirmation always matches the file the user just saved - other EVE tabs' entries included.

**In `clearAlertLog()`, at `localStorage.setItem(LOG_CLEARED_KEY, String(Date.now()));`**

Shared marker: another EVE tab still holding these entries drops them at its next write instead of writing them back.

## COPY SERIAL TO CLIPBOARD

Triggered by an actual click, which satisfies the browser's transient-user-activation requirement. Falls back to a hidden textarea + execCommand where navigator.clipboard is unavailable (locked-down builds, or a non-secure-context intranet page).

## RELATIVE TIME LABELS

**`const ALERT_AGED_MS`**

AGED CARDS

A card older than this is dimmed so new ones stand out. Purely visual: it stays in every filter, search, count and export, and hovering it brings it back to full brightness.

**`const ALERT_AGED_MS`**

45 min: most tickets are dealt with well inside that, so anything older is rarely the one someone is looking for.

### `refreshRelativeTimes()`

Also where cards cross into "aged" - on the same 15s tick, so no extra timer.

## ESCAPE HTML

Regex map rather than creating a throwaway DOM element per call (4 per card, 50 cards on restore).

## ALERT PERSISTENCE ACROSS REFRESHES

### `trackConfirmation()`

v0.9.11. Marks a card's detail-page confirmation as in flight. The 45 s retry (retryPendingConfirmations) picks up any card whose phase is not confirmed yet - including a brand-new card whose first confirmation is still loading - and ran a second one on a second copy of the record (reloaded from storage). Two confirmations on two copies could each send a "CORRECTED" toast. reconfirmRecord() now skips a card that is already being confirmed.

In-page cards are plain DOM nodes, so a hard reload would destroy them - meaning any alert not read within the auto-refresh window vanished unseen. Every alert is written to sessionStorage on creation and re-rendered on load. An alert only leaves storage when the user explicitly dismisses it.

sessionStorage (not localStorage) so alerts are scoped to this tab and do not resurrect days later in an unrelated window.

**In `storeAlert()`, at `while (alerts.length > MAX_STORED_ALERTS) {`**

Evict DEBUG/test records first. The old blind shift() meant that pressing the test buttons a few times could push real, undismissed alerts out of storage entirely.

### `infoFromRecord()`

Rebuild the object confirmPhase() expects from a stored record. Older records predate the section/eve/unit fields, so fall back to splitting the display location rather than passing undefined into the slot check and tripping a false slot-mismatch alarm.

### `needsReconfirmation()`

WHICH CARDS STILL NEED AN ANSWER?

Two populations, and the second is the one that got missed:

```text
phaseSource !== 'confirmed'
    confirmation never succeeded.

resultConfirmed !== true
    the phase was confirmed but the RESULT was not. Either the
    row was still being written when we read it - the collector
    writes taskset first and fills in Finished / taskset_status
    / Pass a moment later, so a fetch fired seconds after the
    colour flipped sees a half-written row - or the record
    predates this build entirely and has no resultConfirmed
    field, because the build that wrote it had no concept of
    one.
```
The first version of this restore filter tested phaseSource alone, so a card that 0.9.4 had confirmed the PHASE of was treated as finished and skipped for ever, and kept displaying a note assembled from fields that build never wrote.

**`const RESULT_RETRY_MAX_ATTEMPTS`**

A pending result is worth chasing for a few minutes and then letting go. The row either gets written or it does not, and re-fetching a detail page for ever is how a monitor becomes the load problem.

### `chaseStaleConfirmations()`

Called on the master tick. Picks up rows that finished writing after we read them, without waiting for a page reload.

### `chaseStaleConfirmations()`

Filter to the records that still owe an answer and start a re-check on each. Returns how many actually started, which is not the same as how many were stale: reconfirmRecord() refuses past RESULT\_RETRY\_MAX\_ATTEMPTS.

**In `restorePersistedAlerts()`, at `alerts.forEach(record => renderAlertElement(record, false));`**

Oldest first; renderAlertElement inserts at the top, so the newest ends up on top.

**In `restorePersistedAlerts()`, at `const stale`**

RE-CONFIRM WHAT WAS NEVER CONFIRMED

v0.9.5. Confirmation used to happen exactly once, in surfaceAlert(), at the moment the colour changed. A card stored before that succeeded came back out of sessionStorage with its stale phaseSource and its stale reason text and was rendered as-is, for ever. Cards raised by an older build therefore kept saying "phase NOT verified" after an update that fixed the confirmation - the update could not reach them, because nothing ever asked again.

A confirmation is also worth retrying on its own merits: the usual reason it failed is a detail page that was slow or briefly unreachable, and a reload is a free second attempt.

## CREATE PERSISTENT IN-PAGE ALERT

**In `createPersistentAlert()`, at `debug:`**

Persisted so the DEBUG visibility modifier still works after a page refresh.

**In `createPersistentAlert()`, at `serial:`**

Kept separately so the card can offer one-click copy of just the serial.

**In `createPersistentAlert()`, at `detailUrl:`**

Direct link to the exact server-detail page. DEBUG/test records have no URL and stay non-navigating.

**In `createPersistentAlert()`, at `section:`**

Slot parts kept separately, not just baked into the display string, so a card restored from sessionStorage can be re-confirmed against its detail page.

**In `createPersistentAlert()`, at `eventId:`**

Links this card to its permanent log entry.

**In `createPersistentAlert()`, at `notifiedTransition:`**

The label the desktop toast actually carried. Empty until one has been sent.

**In `createPersistentAlert()`, at `phaseSource:`**

```text
'color'     label is a GUESS derived from the cell color
```
'confirmed' label was verified on the detail page 'unverified' confirmation was attempted and failed

**In `createPersistentAlert()`, at `taskset:`**

Evidence from the detail page, kept so the card and the exported log can show WHY a label was assigned.

**In `createPersistentAlert()`, at `operation:`**

Operation cell verbatim ("PRETEST" / "SLT"), the Pass boolean off that same row, and whether that row had produced a result yet.

## RECONCILE A CARD WITH THE CONFIRMED PHASE

The card is created immediately from the color guess so the operator sees something instantly. When the detail page answers, the label is corrected in place - card, stored copy and the permanent log entry all move together, so the three can never disagree about what happened.

### `buildPhaseNote()`

ONE note builder, shared by the freshly rendered card and the repainted one, so a card cannot say different things depending on which code path last touched it.

**In `buildPhaseNote()`, at `const parts`**

Operation, then the phase word it was derived from. Older records have neither, and 'detail page' is the honest label for "this came from there but the field was not recorded".

**In `buildPhaseNote()`, at `if (record.passFlag === 0 && record.taskcase) {`**

The failing taskcase is the whole point of a fail alert - it is the thing that went 0.

**In `buildPhaseNote()`, at `const head`**

undefined = written by a build that had no result field at all, and not yet re-checked. That is not the same claim as "the page gave no result", so do not make it.

**In `reconcileAlertPhase()`, at `record.operation  = confirmation.operation || '';`**

Evidence, so the card and the export can show WHY this label was applied instead of asking anyone to take it on trust.

**In `reconcileAlertPhase()`, at `record.pendingReason =`**

Phase is known, result is not - that is not "unverified", but it is not the whole story either.

**In `reconcileAlertPhase()`, at `if (record.notifiedTransition &&`**

If the desktop was already told the OLD label, correct it there too. notifiedTransition is empty until a toast has actually gone out, so a card relabelled before its toast fires - the common case - produces one toast with the right label, not two.

### `updateAlertCard()`

Repaint an existing card in place rather than tearing it down - a card the user is mid-click on must not vanish.

**In `updateAlertCard()`, at `syncJiraForCard(card, record);`**

A card that only became a failure on confirmation starts its ticket lookup here.

**In `updateAlertCard()`, at `titleEl.textContent = record.title;`**

No provenance glyph on the title. It said the same thing as the note directly below it, could not be hidden with it, and put diagnostic state in the one line an operator reads at a glance.

**In `updateAlertCard()`, at `if (noteEl) {`**

BUG FIX. This used to be a bare `return`, which skipped applyAlertFilter() at the bottom of the function - even though className, data-transition and data-diagnostic had ALREADY been rewritten a few lines above. A card that only became a SYS\_DEKIT on confirmation therefore picked up the flag but was never re-filtered, so with Dev off it stayed visible as whatever colour first called it. That is the exact outcome the comment on the data-diagnostic write says must not happen.

A note that has become empty is also removed rather than left showing stale text.

**In `updateAlertCard()`, at `const timeEl`**

The time now sits inside .eve-alert-footer, which is the direct child to insert before.

### `updateLogEntryForAlert()`

The audit log is the artifact that has to be right. Find this alert's entry by id and correct its category in place.

**In `updateLogEntryForAlert()`, at `const matches`**

eventId is the stable link. alertId is the fallback for entries written before events had ids.

**In `updateLogEntryForAlert()`, at `writeLogEntryResult(entry, {`**

record.title is getTransitionTitle(record.transition), set by reconcileAlertPhase() immediately above this call, so deriving it inside the shared writer is the same value by a shorter route.

## RENDER ONE ALERT CARD

Shared by brand-new alerts and by alerts restored after a refresh, so both paths produce an identical card.

**`const ALERT_CLASS_BY_TRANSITION`**

Derived from TRANSITIONS. Call sites still read ALERT\_CLASS\_BY\_TRANSITION[t] || 'eve-failure', so an unknown transition keeps the old failure styling.

### `applyCardState()`

The four pieces of card state derived from a record's transition, written from one place.

renderAlertElement() (building a new card) and updateAlertCard() (repainting one in place) each derived these independently, so a card built before confirmation and a card corrected after it could drift apart.

**In `applyCardState()`, at `element.className =`**

eve-alert-aged is included here, not only on the 15s tick: this rewrites the whole class list, so leaving it out would un-dim an old card whenever it is repainted.

**In `applyCardState()`, at `element.dataset.diagnostic =`**

Diagnostics ride the same visibility switch as DEBUG data: present, recorded, exported - just not in the operator's way. A card that only became a SYS\_DEKIT on confirmation has to pick the flag up here, or it stays visible as whatever colour first called it.

**In `renderAlertElement()`, at `const detailUrl`**

Re-validated on render, not just on creation - the record round-trips through sessionStorage, which the page's own scripts can write.

**In `renderAlertElement()`, at `applyCardState(alert, record, detailUrl);`**

className, data-transition and data-diagnostic, including the clickable and unverified modifiers. Provenance survives a refresh: a restored card that was never verified must still look unverified.

**In `renderAlertElement()`, at `const ts`**

Number() so a poisoned stored value cannot break out of the attribute - this was the one unescaped interpolation here.

**In `renderAlertElement()`, at `const phaseNote`**

Built once. The template used to call buildPhaseNote() a second time to produce the value it had just tested for.

**In `renderAlertElement()`, at `if (record.serial) {`**

Jira button, bottom-right. Built as a real link so middle- click and Ctrl+click open it in a background tab as usual.

**In `renderAlertElement()`, at `if (detailUrl) {`**

CLICK ALERT BODY -&gt; OPEN SERVER DETAIL

The serial area is copy-only and the X is dismiss-only. Every other click on a real alert opens its server-detail page. DEBUG/test alerts have no URL and do nothing.

**In `renderAlertElement()`, at `removeStoredAlert(record.id);`**

Dismissing is the ONLY thing that removes an alert from storage - a refresh must not.

**In `renderAlertElement()`, at `refreshAlertChrome();`**

Both, in this order. The old close handler called only updateDismissAllButton(), which overwrote the "(visible/total)" count with the unfiltered total and left the active filter unapplied.

**In `renderAlertElement()`, at `container.insertBefore(alert, container.firstChild);`**

Newest alert on TOP so the most recent result is the first thing visible without scrolling.

**In `renderAlertElement()`, at `while (container.children.length > MAX_RENDERED_ALERTS) {`**

Oldest (bottom) cards past the cap leave the screen only - storage and the alert log are untouched. Their Jira polls stop on their own (they check isConnected).

## ALERT CONTAINER

### `setAlertsCollapsed()`

Collapse state of the Alerts window: class, caret and the saved choice move together, whoever changes it.

### `revealNewAlert()`

Non-fatal: collapse state just will not persist.

### `revealNewAlert()`

A NEW alert always opens a collapsed Alerts window - closed, it used to swallow new cards silently. Only when the new card is actually shown: a DEBUG/diagnostic card hidden with Dev off, or one outside the active filter/search, leaves it closed. Cards restored after a reload never come through here, so a reload keeps the window the way the user left it.

**In `getAlertContainer()`, at `withoutObserver(() => document.body.appendChild(container));`**

Appending to document.body is a childList mutation whose target is document.body, not our own UI - so without this wrapper it read as a real page change and triggered a scan.

**In `getAlertContainer()`, at `document .getElementById('eve-alert-toggle')`**

COLLAPSE / EXPAND

**In `getAlertContainer()`, at `const dismissAll`**

Non-fatal.

**In `getAlertContainer()`, at `const dismissAll`**

DISMISS ALL

**In `getAlertContainer()`, at `const dismissAll`**

Two clicks within 3s. One stray click used to wipe every card on screen with no way back.

**In `getAlertContainer()`, at `document.getElementById('eve-alert-export')`**

EXPORTS. Each menu item closes the menu first, then acts.

### `jiraChipText()`

v0.9.12. The found-ticket chip reads "JIRA - <number>": it says where the click goes, and the project prefix (MFGS) meant nothing to most readers. Display only - the tooltip, `href` and `indexJiraKey()` (search) keep the real key.

## RACK CELL CLICK

A failed (red) rack cell opens TestView through `openTestView(serial, openExternal)` - the exact call the alert card makes (`openCardTarget()`), so there is one source of truth for the destination (`buildTestViewUrl()`) and the TestView-side lookup. The serial comes from `getServerInfo()`, the same parser the scan uses; "red" is `normalizeColor()`, the same test that raises a failure alert; "rack cell" is a column under a `TA.<section>-EVE<n>` header of a table `getEveTableGroups()` accepts (cached), so the Unit column, headers and other tables never match.

### `onRackCellClick()` / `rackCellForClick()`

ONE capture-phase `click` listener on `document`, installed once in `initialize()` after `claimThisTab()` (so a second installed copy never adds another). The cells are the page's own markup and a soft refresh replaces whole tables, so per-cell listeners or overlays would have to be rebuilt every 10-30 s (1,640 cells on a large rack) for no gain; the delegated listener costs nothing between clicks (idle heap and node count identical to 0.9.11) and ~0.01 ms per click. Capture phase + `preventDefault()` + `stopPropagation()` on a handled click only, so the page's link (or any handler the page may attach) never also fires. Ctrl/Cmd/Shift/Alt and non-primary buttons are left alone - the browser opens the old detail link as usual. Keyboard Enter on the link is a click too. No cursor/CSS change: the cell's link already shows the pointer.

## ALERT ACTIONS MENU

### `setupAlertMenu()`

TXT / CSV / dismiss-all sit behind one 28 px "..." button (0.9.11) so the title bar is almost all drag area; the buttons used to take a third of it. The menu is `position: fixed` inside the panel: fixed boxes escape the panel's `overflow: hidden` (the panel has no transform), so it is not clipped when the panel is folded to its title bar, and it still inherits the panel's CSS variables. It is placed from the button's rect each time it opens - right-aligned, below, or above when there is no room below - and closes on an outside pointerdown (capture phase, so a header drag closes it too), Escape, Tab, a resize, or any item. Closing always disarms Dismiss all (`onClose`), so an armed confirm can never survive into a later open. The header's drag guard already ignores `button` targets, so the menu button never starts a drag. Keyboard: Enter/Space or ArrowDown opens with focus on the first item (`event.detail === 0` marks a keyboard click); arrows wrap over the visible items.

**In `getAlertContainer()`, at `container .querySelectorAll('.eve-filter-category')`**

FILTER + SEARCH

**In `getAlertContainer()`, at `return body;`**

DEBUG/test and SYS\_DEKIT card visibility follows the Dev checkbox alone - see applyAlertFilter().

## ALERT WINDOW UX (drag / snap / persistent position)

**`const MIN_ALERT_PANEL_HEIGHT`**

FIT THE PANEL TO THE SPACE BELOW IT

The drag handler deliberately clamps only the HEADER to the viewport, so a long alert list never forces a bottom snap. The cost of that choice is that the LIST is unconstrained: drag the panel two thirds of the way down and its body still claims up to a full viewport of height, so the bottom of the list - and the bottom of its scrollbar track - sit below the edge of the screen. Dragging the thumb then runs out of screen before it runs out of track, which is unusable.

Fix the height to what is actually below the panel's own top edge and the scrollbar is always reachable, wherever the panel sits.

**In `restoreAlertPanelPosition()`, at `const clamped`**

clampToViewport() is the SAME function that used to exist a second time as clampAlertPanelToViewport(). Identical maths, identical margin, identical return shape.

**In `setupAlertWindowUX()`, at `header.addEventListener('click', event => {`**

Dragging starts anywhere on the header except its buttons - including the empty space and the title (v0.9.11). The title's fold span used to have `flex: 1`, so it covered all the empty space and only an 8 px gap plus the padding could start a drag. Now the span is only as wide as its text; the layout is otherwise identical (tests/ui.test.mjs re-applies the old rule and compares boxes).

Positions are taken from the PANEL box (the header sits 1 px inside the border; measuring the header made the panel creep 1-2 px per drag). The vertical limit still uses only the title bar's height, so the alert cards below may extend past the viewport without forcing a bottom snap.

This capture listener swallows the click that follows a real drag (so a drag from the title does not fold the panel). onPointerUp clears `draggedEnough` in a setTimeout(0) - AFTER that click is dispatched; clearing it synchronously (as before) made this guard dead code.

**In `positionHeaderFromPointer()`, at `syncAlertPanelHeight(container);`**

Live, not on drop: the list has to stay inside the screen while the panel is still moving.

**In `onPointerUp()`, at `const wasDragged`**

A normal click on the header (including collapse/expand) must NEVER rewrite the saved position or trigger snapping. Only a real drag is allowed to change the panel coordinates.

**In `onPointerUp()`, at `const rect`**

IMPORTANT: snap ONLY from the header rectangle. The body/cards are intentionally ignored, so a long alert list cannot cause a false bottom/right snap.

**In `setupAlertWindowUX()`, at `if (event.target.closest('button') ||`**

Only the empty/label portion of the header starts a drag. Interactive controls (including the Alerts collapse toggle) must never initiate a drag or rewrite the panel coordinates.

**In `setupAlertWindowUX()`, at `document.addEventListener('pointermove', onPointerMove);`**

Do NOT rewrite left/top on pointerdown. Doing so converts a simple click into a coordinate update based on the current rendered rectangle. When the panel changes size (for example collapse/expand), that can introduce small cumulative position shifts even though the user never dragged it. Coordinates are changed only after an actual drag movement.

## ALERT FILTER + SEARCH

Hides cards that do not match, rather than removing them, so filtering never destroys an alert or its stored copy.

**In `applyAlertFilter()`, at `const chips`**

Per-chip counts (ignoring the active filter and the search, so every chip always says how many it WOULD show).

**In `applyAlertFilter()`, at `const allowedTransitions`**

Loop invariants. Both depend only on state that is fixed for the whole call, so they are computed once instead of once per card.

"Passes" covers pre-test passes too, so a confirmed PRE-TEST PASS card cannot vanish from every filter.

**In `applyAlertFilter()`, at `const showDebug`**

The Dev checkbox is the only switch. Dev on: DEBUG/test and SYS\_DEKIT diagnostic cards are shown. Dev off: hidden (still logged and exported).

## ALERT CONTAINER VISIBILITY

Renamed from updateDismissAllButton(), which never touched the dismiss-all button - it toggled the whole container.

Always paired with applyAlertFilter() via refreshAlertChrome(), because the two both write the count element and calling only one of them left the display inconsistent.

**In `updateAlertContainerVisibility()`, at `container.style.display = count > 0 ? 'flex' : 'none';`**

Hide the whole menu when there is nothing to show, so it takes no screen space until an alert actually fires. flex, not block: the container is a flex column so the list can be sized against the space below the panel.

**In `updateAlertContainerVisibility()`, at `dismissAll.style.display = count > 1 ? '' : 'none';`**

What the original comment always claimed it did.

## SAFE BUTTON WIRING

Wraps getElementById + addEventListener so a missing button (stale UI, ID typo, script not actually reloaded) logs loudly instead of silently doing nothing.

### `bindSetting()`

ONE BINDING for a settings-backed control.

Five controls repeated the same seven steps: look the element up, guard it, paint it from `settings`, listen for change, write `settings`, persist, then run a side effect and log. The side effects are the part that genuinely differs, so they stay at the call site as `after`/`message`.

```text
coerce     turn the raw control value into the stored value
writeBack  reflect the coerced value back into the control,
           so a rejected input does not stay on screen
after      the control's own side effect
message    console line, built from the stored value
```

**In `wireButton()`, at `fail('Button #${id} not found — UI may be stale. ' +`**

typeof guard: the old "GM\_info &amp;&amp; GM\_info.script" threw a ReferenceError inside this very error handler when the identifier was undeclared.

## PANEL POSITION PERSISTENCE

**In `savePanelPosition()`, at `writeJSON(localStorage,`**

Silent: non-fatal, the position just will not persist.

**In `restorePanelPosition()`, at `const clamped`**

Clamp, in case the window is now smaller than it was when the position was saved - otherwise the panel is stranded off-screen with no way to drag it back.

## TRACKER WINDOW UX (drag / collapse / snap)

Pointer Events instead of mouse events: works on touch screens as well as a mouse, and the move/up listeners only exist while a drag is actually in progress. The old build kept a document-level mousemove handler alive for the whole session that early-returned on every mouse move page-wide.

**In `setupTrackerWindowUX()`, at `const body`**

Everything except the title becomes the body.

**In `onPointerUp()`, at `if (nearLeft && nearTop) {`**

Snap to a page corner when released nearby.

**In `setupTrackerWindowUX()`, at `window.addEventListener('resize', () => {`**

Keep the tracker inside the viewport if the browser resizes.

## TRACKER UI

### `wireDebugButtons()`

Developer-page buttons. Reachable only with Developer Mode on, but wired unconditionally - the container is what gets hidden.

## BUILD SECTION CONTROLS

Diffs the section set. The old build did list.innerHTML = '' and rebuilt every checkbox on every mutation tick (~4x/second during page activity), which thrashes layout and can destroy a checkbox the user is mid-click on. The set is unchanged almost always, so the common path is now just syncing checked states.

### `buildTrackerPanelMarkup()`

The panel's markup, lifted verbatim out of createUI(). The element ids it declares are what wireTrackerSettings(), wireDeveloperMode() and wireDebugButtons() bind to.

### `wireDeveloperMode()`

DEVELOPER MODE / TWO-PAGE UI

```text
Page 0 = normal tracker UI (default)
Page 1 = developer / diagnostics UI
```
Turning Developer Mode off always returns to page 0 and hides the developer page and navigation entirely.

**In `wireDeveloperMode()`, at `const developerModeCheckbox`**

Page 0 = normal tracker UI (default) Page 1 = developer / diagnostics UI

Turning Developer Mode off always returns to page 0 and hides the developer page and navigation entirely.

**In `applyDeveloperModeUI()`, at `if (document.body) {`**

The alert container is a SEPARATE fixed element, not a child of the tracker panel, so the panel class cannot reach it. Body class does, and toggling it re-hides the confirmation notes instantly with no re-render.

**In `applyDeveloperModeUI()`, at `pageNavigation.hidden = false;`**

Always reserve the navigation area so the normal UI keeps a stable layout; only the dots are rendered when Developer Mode is on.

**In `wireDeveloperMode()`, at `developerPage = 0;`**

Enabling always starts on the normal page.

**In `wireDeveloperMode()`, at `applyAlertFilter();`**

DEBUG visibility depends on Dev mode.

### `wireTrackerSettings()`

Every settings-backed control in the panel. Split out of createUI(), which was doing six unrelated jobs in 585 lines.

**In `wireTrackerSettings()`, at `bindSetting('eve-refresh-interval', 'refreshIntervalSeconds', {`**

Applied immediately - reschedules the pending refresh.

**In `wireTrackerSettings()`, at `bindSetting('eve-log-shift', 'logShift', {`**

Re-points the log at the new shift; clears nothing.

**In `wireTrackerSettings()`, at `bindSetting(`**

writeBack: a rejected value must not stay in the box.

**In `wireTrackerSettings()`, at `bindSetting('eve-jira-base-url', 'jiraBaseUrl', {`**

writeBack: a rejected URL snaps back to the working one.

**In `wireTrackerSettings()`, at `loadJiraCache().clear();`**

Keys from another Jira mean nothing here.

**In `buildSectionControls()`, at `sections.forEach(section => {`**

Same sections - just make sure the checkboxes agree with the settings (e.g. after Show All / No Notifs).

**In `buildSectionControls()`, at `row.innerHTML = '`**

Counts sit beside the name; CSS shows them only while this section's Show switch is on.

**In `buildSectionControls()`, at `renderSectionCounts();`**

New rows start empty; fill them from the last scan now rather than on the next one.

## SET ALL SECTIONS

_No notes - the code is self-explanatory._

## APPLY VISIBILITY

Same O(rows) restructure as scan(): each table's rows are walked once and the header columns looped inside, instead of re-walking every row once per header.

Wrapped in withoutObserver() because it writes style.display on PAGE cells, which the observer watches - previously that fed straight back into another applyVisibility().

## CSS

_No notes - the code is self-explanatory._

## INITIALIZE

### `claimThisTab()`

One tracker per tab (v0.9.11). Two installed copies of the script share this page's DOM, so the first to initialize marks `<html>` and any other copy stays idle - otherwise both scan, log, toast and render every event (see EVENT CLAIMS). The warning names both versions so the extra install can be found and removed.

**In `initialize()`, at `try {settings = loadSettings();`**

Everything below runs inside an error boundary. A throw here previously left a half-built UI and a silently dead tracker, which for a monitoring tool is the worst failure mode.

**In `initialize()`, at `const strippedMeta`**

Late second pass. The real work is done at document-start in bootstrap() below - by DOMContentLoaded the browser has usually already committed a meta refresh, which is why the old build's single call here did not reliably stop the page reloading on the server's timer.

**In `initialize()`, at `checkLogShiftRollover();`**

Before anything reads the log: drop whatever is left from an earlier day so counts, exports and the panel all start the session agreeing.

**In `initialize()`, at `restorePersistedAlerts();`**

Bring back any alerts that were still undismissed when this page last unloaded. After injectCSS() so the restored cards are styled, and before scan() so newly detected alerts stack above them.

**In `initialize()`, at `document.addEventListener('visibilitychange', () => {`**

BACKGROUND TAB THROTTLING

Chromium clamps hidden-tab timers to ~1/min and applies intensive throttling after ~5 minutes. The 1s master tick, the 60s refresh and the watchdog therefore all degrade together - silently. Detection latency collapses from 60s to something unpredictable with no UI signal.

The real fix is "keep the tab visible", which is a documentation problem. The fix for it being INVISIBLE is this.

**In `initialize()`, at `blindScans = 0;`**

Back in the foreground: assume everything is stale.

**In `initialize()`, at `window.addEventListener('pagehide', () => {`**

beforeunload is unreliable on tab discard, mobile and crash. pagehide is the dependable half of the pair.

### `persistBeforeUnload()`

A dead tracker must be visibly dead. Console-only failure means a tech watches a panel that is not watching anything.

### `persistBeforeUnload()`

Everything that must survive a navigation, written from one place. beforeunload and pagehide are BOTH registered deliberately: beforeunload is unreliable on tab discard and crash, pagehide is the dependable half of the pair. They ran the same three calls from two copied bodies.

**In `persistBeforeUnload()`, at `flushAlertLog();`**

Anything recorded since the last debounced write must not be lost on navigation.

**In `showFatalBanner()`, at `const HEARTBEAT_EVERY_TICKS`**

Nothing further we can do.

**Inline notes**

- `true` - quiet: chip only, no toast

## KEEP AWAKE + SLEEP DETECTION

Edge "Sleeping tabs" and Chrome "Memory Saver" put a background tab to sleep: FROZEN (no JavaScript runs at all) or DISCARDED (the page is unloaded - it goes blank and reloads when clicked). While asleep the tracker cannot see anything and no toast can fire. That is a browser decision; the only guaranteed fix is the browser's own "Always keep these sites active" list. What the tracker does about it:

```text
1. Holds a Web Lock. Chromium does not freeze a page that holds
   one (performance_manager freezing opt-out). Secure pages
   (https) only - the API does not exist on plain http.
2. Drives the master tick from a Worker. Page timers in a tab
   hidden 5+ minutes are cut to once a minute; worker timers
   are the usual way around that. Best effort: falls back to
   setInterval if the worker cannot start.
3. Detects sleep - document.wasDiscarded on load, the Page
   Lifecycle freeze/resume events, and gaps in the tick - then
   refreshes immediately and says so, with the exact setting
   that stops it. Baselines live in sessionStorage, which
   survives a discard, so whatever changed while asleep is
   still caught - just late.
```

### `readHeartbeat()`

Non-fatal: only the "asleep since" time is lost.

**In `holdKeepAliveLock()`, at `navigator.locks`**

Shared, so several EVE tabs can all hold it at once. The callback's promise never settles: the lock is held for the life of the page.

### `startTicker()`

Starts onTick once a second from a Worker if possible, otherwise from setInterval. Never both.

**In `startTicker()`, at `setTimeout(() => {`**

A worker that never speaks (CSP, extension sandbox) must not leave the tracker without a tick.

### `noteWake()`

kind: 'discarded' (page was unloaded and reloaded), 'frozen' (resume event), 'paused' (tick gap - timers starved or frozen).

**In `noteWake()`, at `if (!sleptMs ? kind === 'discarded' : sleptMs >= SLEEP_BANNER_MIN_M...`**

Unknown duration (no heartbeat) still gets the banner after a discard: the page going blank is the thing to fix.

**In `wireSleepDetection()`, at `document.addEventListener('freeze', () => {`**

Page Lifecycle API (Chromium). 'freeze' is the last chance to run; 'resume' is the first after.

**In `wireSleepDetection()`, at `if (document.wasDiscarded) {`**

This load IS the wake-up: the page is already fresh, so no refresh - just report it.

### `startCountdownAnimation()`

The 1s tick is too coarse for a decimal countdown. While the tab is visible, animation frames (capped at ~10/s) repaint it; hidden tabs get no frames, and the tick keeps it current.

**Inline notes**

- `const HEARTBEAT_EVERY_TICKS   = 5;` - sessionStorage write cadence
- `const SLEEP_GAP_MS            = 120000;` - tick silence that means "was asleep"
- `const SLEEP_BANNER_MIN_MS     = 30000;` - shorter naps are not worth a banner
- `const SLEEP_TOAST_INTERVAL_MS = 600000;` - at most one sleep toast per 10 min
- `let lastSleep        = null;` - { kind, from, to }
- `try { worker.terminate(); } catch (error) { /* already gone */` - already gone

## MASTER TICK

One timer with counters instead of three intervals.

scan() does not need to run every second: the MutationObserver fires on any real page change, and a soft refresh scans immediately after swapping content. The interval is only a safety net for changes neither catches.

**In `startMasterTick()`, at `if (lastTickAt && now - lastTickAt > SLEEP_GAP_MS && !frozenAt) {`**

A long silence between ticks means the page was frozen or its timers starved. Catch up now rather than wait out the rest of the countdown.

**In `startMasterTick()`, at `if (autoRefreshTimer && autoRefreshDueAt && now > autoRefreshDueAt...`**

A background tab's own refresh timer can be throttled far past its due time; the tick fires it instead.

**Inline notes**

- `const SCAN_TICKS     = 4;` - scan() every 4s
- `const RELATIVE_TICKS = 15;` - relative labels every 15s
- `const WATCHDOG_TICKS = 10;` - refresh watchdog every 10s
- `const RECONFIRM_TICKS = 45;` - chase pending results every 45s
- `const LOG_SHIFT_TICKS = 60;` - log shift rollover check every 60s

## BOOTSTRAP

Runs at document-start. Two jobs:

```text
1. Kill the page's own <meta http-equiv="refresh"> BEFORE the
   browser commits it. Chromium schedules a meta refresh at
   parse time, so removing the node from DOMContentLoaded is
   too late - the page still reloads on the server's timer,
   resetting the tracker and racing the soft refresh. The
   observer below catches the tag the instant it is parsed.

2. Hand off to initialize() once the DOM is ready.
```
NOTE: settings are not loaded yet at this point, so nothing here may touch `settings`.

**In `bootstrap()`, at `let sawMeta`**

stripMetaRefresh() runs querySelectorAll over the WHOLE document. Unfiltered, this fired for every parse mutation on a page of hundreds of table cells - O(mutations x nodes) at exactly the moment the browser is trying to render. &lt;meta&gt; only ever appears in &lt;head&gt;.

## Styles (CSS)

Notes that were inside the stylesheet in `injectCSS()`.

### DRAGGABLE / COLLAPSIBLE TRACKER WINDOW

**`.eve-summary-badge`** - Status badge shown on a collapsed summary line, so the section's state is readable without expanding.

**`.eve-badge-soon`** - Final few seconds before a reload - warns you that the page is about to change under you.

### DETECTION HEALTH CHIP

Visible only while Developer Mode is enabled. It remains in the title row so the developer page and collapsed state use the same header treatment.

**`.eve-health-blind`** - Deliberately the same red as a failure card. If this is showing, nothing is being monitored.

### ALERTS TOOLBAR - FILTER + SEARCH

**`.eve-filter-btn`** - Same height with or without a count.

**`#eve-tracker-panel:not(.eve-developer-enabled) .eve-dev-only`** - Dev-only controls in the panel (refresh diagnostics, Jira settings).

### SESSION SUMMARY

Small byline directly under the panel title.

Contact footer - sits at the very bottom of the panel, deliberately small so it takes minimal space.

**`.eve-credit`** - Merged from two separate .eve-credit rules. The second one (a later flex layout pass) overrode margin-top, so 2px is the value that was actually in effect.

**`.eve-buttons.eve-bulk-buttons`** - Main-page bulk actions: one even row.

**`.eve-refresh-card`** - Auto refresh row: label, countdown, interval, progress.

**`.eve-live-dot`** - Pulses once a second: the timer is alive.

**`#eve-refresh-mini`** - Countdown copy in the title - only while collapsed.

**`#eve-refresh-badge`** - Pushed right; wide enough that "28.4s" never jiggles.

**`#eve-log-shift`** - Log shift row: select pushed right, like the countdown.

**`.eve-sleep-banner`** - Shown after the browser put this tab to sleep.

### DEV GROUPS (Developer page + Dev-only Jira settings)

Flat cards - both areas are already behind the Dev switch, so nothing folds.

### TWO-PAGE UI / SUBTLE DEVELOPER MODE

**`height: 16px; margin-top: 4px; user-select: none; } .eve-page-navigation[hidden]`** - Always reserve this small amount of space. When Developer Mode is OFF, the dots are hidden and this becomes a subtle empty placeholder so the main UI does not shift when Dev is toggled.

**`.eve-developer-footer-toggle`** - Intentionally tiny/subtle. This is not a normal user setting; it is simply the entry point to the developer page for people who need the under-the-hood tools.

**`.eve-developer-footer-toggle input`** - Drawn dark on purpose - no bright native checkbox. Only someone who knows it is there should notice it.

**`.eve-section-card`** - Section list: one card, column headers, a switch per cell.

minmax(0, ...) so wide counts shrink the name column instead of pushing the switches out of line.

**`.eve-section-label`** - Section name + live counts (counts only while Show is on).

**`.eve-stat-testing`** - test #62F5AE, fail red and pass mint (same as the filter- chip counts). Fixed min widths keep the columns aligned down the list.

**`.eve-switch`** - The checkbox itself drawn as a switch - same input, same change events, nothing in the wiring changes.

### PERSISTENT ALERT CONTAINER

**`#eve-alert-container`** - The container is a viewport-bounded flex column: header and toolbar take their natural height, the alert list takes what is left. The list used to carry a hard max-height of calc(100vh - 90px) instead, which assumed the chrome above it was always 90px tall. It is not - the filter row wraps onto a second line on a narrow window - so the list ran past the bottom of the screen and took its scrollbar with it. Dragging the thumb then ran out of screen before it ran out of track.

Starting value only. syncAlertPanelHeight() overwrites this with the space actually below the panel, because the panel is draggable: a viewport-relative cap is measured from the top of the SCREEN, while the list starts at the top of the PANEL. Drag the panel down and the two diverge by exactly the amount that ran off the bottom of the screen.

**`overflow: hidden; z-index: 2147483647; display: none; flex-direction: column; background: #141518; border: 1px solid var(--eve-line-strong); border-radius: 12px; font-family: var(--eve-font); box-shadow: 0 16px 48px rgba(0, 0, 0, .5); } #eve-alert-header, #eve-alert-toolbar`** - Nothing escapes the box even when the panel is dragged somewhere with no room left below it.

Without this a flex item refuses to shrink below its content height, overflow-y never engages, and the list pushes the container past the viewport again.

**`#eve-alert-body::-webkit-scrollbar, #eve-tracker-panel::-webkit-scrollbar`** - One thin dark scrollbar for the alert list and the tracker panel (older Chromium reads these; newer reads the scrollbar-width / scrollbar-color on each element).

### ALERT CARD (v0.9.7)

Dark card, coloured accent edge + status dot. Each result sets --eve-accent / --eve-accent-rgb; everything else on the card derives from those two.

**`.eve-alert.eve-alert-aged`** - Older than 45 min (ALERT\_AGED\_MS): dimmed so new cards stand out. Hover brings it back to full brightness.

### RESULT COLOURS

**`.eve-success`** - TEST PASS mint, TEST FAIL light red / fuchsia, PRE-TEST FAIL dark red. Pre-test FAIL's title and dot use a lighter tone of the same red - #910421 as text would be unreadable on the dark card. Pre-test PASS gets its own hue (teal).

**`.eve-dekit`** - SYS\_DEKIT (diagnostic, not a result): deliberately neither red nor green, and quieter than either.

### PHASE PROVENANCE

A label that could not be verified against the detail page must not look identical to one that was. The dashed edge is the tell.

**`.eve-alert-phase-note`** - Diagnostic detail - built and exported always, rendered only in Developer Mode.

### FOOTER: TIMESTAMP + JIRA

**`.eve-jira-cat-new .eve-jira-dot`** - Ticket status colour (Jira status category).

**`.eve-jira-waiting`** - Failure's ticket not raised yet (the bot is due).

**`.eve-jira-noticket`** - Nothing raised in the time the bot normally takes.

## Panel markup

Notes that were inside the panel HTML in `buildTrackerPanelMarkup()`.

- Auto refresh: always on, so no menu - one row with the countdown and the interval.
- Which shift the alert log and TXT/CSV exports follow.
- Refresh internals: Dev only.
- DEVELOPER / DEBUG PAGE Hidden unless Developer Mode is enabled.
