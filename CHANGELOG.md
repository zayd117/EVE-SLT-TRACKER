# Changelog

All notable changes to this project are documented here.
Versions follow [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

Tampermonkey offers an update to installed users whenever `@version` in the
userscript header increases, so every entry below corresponds to a version
that was actually shipped. The script itself carries no change notes; they
all live here.

## [1.0.1] - 2026-09-25

First stable release. Monitoring stays read-only: nothing on the EVE /
SLT pages, in TestView or in Jira is changed by the tracker. (1.0.0 was
prepared but never published; everything it contained ships here, together
with the fixes from the 1.0.1 stability review.)

### Added
- **New-ticket badge.** When a failure card's Jira chip goes from "No ticket
  yet" / "Ticket pending" to a real ticket, the chip glows and pulses green
  and a small green **!** appears on it. It stays until you hover the chip,
  then fades 3 seconds after the hover starts - and it is remembered, so a page reload
  neither drops it before you have seen it nor brings it back after. It
  only fires on that real change - never on a rescan, a
  refresh, a repaint, the same ticket again, or a ticket that already
  existed when the card appeared.
- **Copy Jira link.** A small copy control next to the chip copies the
  ticket's full link (e.g. https://jira.synnex.com/browse/MFGS-123456, the
  same link the chip opens) and shows "copied". It exists only once a real
  ticket is found; the chip still opens the ticket, and copying opens
  nothing.

### Changed
- **Sleeping tabs: no more banner, tip or "was asleep" notification.** The
  tracker keeps its own tab awake: it holds a Web Lock (Chromium does not
  freeze a page holding one), runs its clock in a Worker (not throttled in
  the background) and, while its tab is on screen, holds a Screen Wake Lock
  so the display and PC do not go to sleep. If the browser still puts the
  tab to sleep, it catches up the moment the tab wakes, silently. (A
  userscript cannot add the site to Edge's "Always keep these sites active"
  list itself; see README.)
- **Log shift, Auto:** a new session now gets the shift whose log window
  (60 min before the shift starts) opened most recently, so early arrivals
  get the incoming shift: 9:40 PM is Graveyard (was Swing), 6:00 AM is Day
  (was Graveyard). An open session still keeps its shift until its window
  ends. Logs already written are not touched.
- Pre-test failure with no ticket reads **No ticket (create one)** from 15
  minutes after the failure (was 20), with a subtle yellow light tracing the
  chip's outline until you hover it (it then fades 10 seconds later). It
  fires once per failure: a page reload does not bring it back once seen.
  On a card older than 45 minutes the rest of the card dims as usual but
  that chip stays bright while its outline shows. Nothing is created from
  the tracker; clicking still searches Jira as before.
- **Raise a missing ticket:** the page a failure's Jira chip opens (test or
  pre-test fail) says in plain text "If there is no ticket by <time>, please
  open PuTTY and create one with: **ticket <serial>**" (15 minutes after the
  failure, giving the Jira bot its chance). From 15 minutes it becomes a
  highlighted box: "It has been more than 15 minutes and no ticket has been
  created. Please make one in PuTTY: **ticket <serial>**". Both have a Copy
  button; an open page switches by itself. The no-ticket tooltip says the same.
  Before prompting, the tracker asks TestView 2.0 for the serial's latest
  status: while it is **RUNNING** (every step, power off included) PuTTY
  refuses a ticket, so the page, tooltip and pre-test chip ("No ticket
  (re-testing)", no gold) say it is being re-tested instead; once TestView
  shows it finished, the box says "…, the server is not running, and no
  ticket has been created". If TestView cannot be
  reached, the prompt shows as before. While it is running, the page links
  straight to that run in TestView 2.0. New header line
  `@connect testview-eve-fmt.hyvesolutions.org` for this lookup.
- **Cards whose server has left its slot** (pulled, swapped for another
  serial, or the cell is empty) are struck through and dashed; the serial box shows
  **Removed from rack** in place of copy (hover it for what is there now)
  and copying is off - Jira and TestView still work instead of
  looking live. A retest of the same serial is not "removed". Cards for rack
  columns this page does not show are left alone.
- Old (45 min+) cards now dim under a darkening layer instead of a filter,
  so a chip that still needs attention can stay bright above it; the look
  is the same (40% darker, desaturated; full brightness on hover).

### Fixed
- **A damaged saved card stopped the tracker from starting.** One bad
  entry in the tab's saved cards (for example `null`) made startup fail
  with "FAILED TO START", and because that data survives a reload the tab
  stayed unmonitored until it was closed. Bad entries in the saved cards
  and the shift log are now skipped, and a card that cannot be shown is
  skipped instead of stopping the tracker.
- **One failing step no longer stalls the others.** The once-a-second loop
  runs the scan, refresh watchdog, re-confirmation and shift rollover in
  turn; an error in one (for example the scan, on unexpected page markup)
  skipped the rest, so the shift rollover could stop for as long as the
  error lasted. Each step now runs on its own; a failing step is reported
  once in the console and again when it recovers.
- The TestView status cache (used before suggesting a PuTTY ticket) is
  capped at 200 serials, like the other caches, so a tab left open for
  days does not keep growing it.

### Docs
- README rewritten for new testers: shorter sections, a table of what each
  Jira chip means, when notifications do and do not fire, a
  troubleshooting table, and advanced details moved to the end. Out-of-date
  steps removed (picking your log shift by hand at install; two
  overlapping "keep awake" sections) and the privacy section now lists the
  TestView status check.

### Tests
- New suites tests/jiraux.test.mjs (badge, copy control, pre-test label) and
  tests/keepawake.test.mjs (no sleep UI, keep-awake locks, silent catch-up);
  shift boundary cases in tests/logic.test.mjs.
- New tests/stability.test.mjs: corrupt, wrong-shaped and unwritable
  storage; 40 soft refreshes without growth in listeners, observers,
  timers, UI or state; repeated reloads with exactly one tracker; a step
  that keeps throwing; the TestView cache bound.

## [0.9.12] - 2026-09-24

### Changed
- **Red cells on the rack page open TestView.** Clicking a failed (red)
  server cell - its link or anywhere in the cell - now opens that serial in
  TestView, exactly like clicking its alert card (same destination, same
  test-detail lookup), instead of the old server detail page. Other colours,
  other tables and the Unit column are untouched. Ctrl/Cmd+click, Shift+click
  and middle click still do what the browser normally does with the cell's
  link, so the old detail page stays one Ctrl+click away. One listener for
  the whole page: nothing is added to the table and nothing is re-attached
  after a refresh.
- Card Jira chip reads **JIRA - 123456** instead of **MFGS-123456**, so it is
  clear the click opens Jira. Label only: the tooltip, link and search still
  use the real key.

### Tests
- New suite tests/cellclick.test.mjs (9 tests); Jira chip label in
  tests/jira.test.mjs.

## [0.9.11] - 2026-09-24

### Fixed
- **Duplicate log entries and toasts for one event** ("SN -> FAIL" twice).
  Root cause: every running copy of the tracker processed every transition
  on its own, and the audit log is shared between tabs. Two tabs on the same
  rack page - or the script installed twice - each logged and toasted the
  same event. Now:
  - one tracker per tab: a second installed copy stays idle and says so in
    the console (remove it in the Tampermonkey Dashboard);
  - across tabs, each real event is claimed by the first tab that sees it;
    other tabs still show the card but do not log it or toast it again.
  A later event for the same serial (FAIL, retest, FAIL again; or FAIL then
  PASS) is still processed normally - events are matched, not serials.
- A new event now always reads the server's detail page fresh; within 2 min
  of a previous result for the same serial it could reuse that result (a PASS
  logged as FAIL).
- The 45 s re-check no longer starts a second detail-page confirmation for a
  card whose first one is still loading (could send "CORRECTED" twice).
- JIRAlerts panel no longer creeps 1-2 px down/right on every drag.
- Shift log could be wiped while a shift was still running. Each shift's
  log window starts 60 min early and ends 60 min late, so neighbouring
  windows overlap; old entries were cleared at the *selected* shift's
  window, so a browser left on **Day** cleared everything before 5:00 AM -
  the Graveyard crew's log, mid-shift. Now an entry is only cleared once no
  shift's most recent window covers it: each shift's log is kept until that
  shift's next window opens (Graveyard: 9:00 PM the next evening). Nothing
  is cleared at 6:30 or 7:30 AM, and changing the Log shift setting never
  clears anything.
- The Log shift tooltip was misleading ("cleared when the next one starts").
  It now says Auto or Manual, the exact window and when its log is
  cleared, e.g. Graveyard: "9:00 PM - 7:30 AM ... kept until 9:00 PM".
- Log exports (.txt and .csv) now always show Fremont, CA time - PDT or PST
  by date - whatever timezone the PC is set to. The table date/time columns
  printed raw UTC (a 10 PM - 6:30 AM shift exported as 05:18 - 09:55). The
  .txt header times name the zone; each entry's raw `ISO:` line stays UTC.

### Changed
- **Log shift is automatic.** The new default, **Auto**, follows the shift
  you are in: the shift running when the session starts (the one that started
  most recently where two overlap), kept until its window ends (60 min after
  the shift), then the shift running at that moment. An open tab goes
  Graveyard -> Day at 7:30 AM, Day -> Swing at 3:30 PM, Swing -> Graveyard at
  1:15 AM. Picking a shift in the dropdown still works but only until the
  next shift change, then it returns to Auto, so a shared PC is never left on
  the wrong shift. A shift picked in an older version becomes Auto once.
- Log exports show when a result actually **happened**: the Finished time
  from the server's detail page (Test Status table, Fremont time), not when
  the tracker noticed it. The detection time is kept (`Detected:` line in the
  .txt, `Detected At` column in the .csv; new `Time Source` column). If the
  detail page has no usable Finished time - blank, later than detection, or
  more than a day older - the detection time is used, as before.
- JIRAlerts header: the whole empty area between the title and the
  TXT / CSV / X buttons now drags the panel (it was a thin strip), and a drag
  can start on the title too. A click on the title still folds / unfolds; the
  buttons are unaffected; the header looks exactly the same.
- JIRAlerts title bar: TXT, CSV and X All moved into one small **...** menu
  at the right of the title bar, so almost the whole bar is free to drag
  the window. The menu has **Export shift log (.txt)**, **Export for Excel
  (.csv)** and **Dismiss all cards** (still two clicks: the second says
  "Click again to dismiss all"; shown with 2+ cards). It closes on an outside
  click, Escape, a drag or after an export, opens upward near the bottom of
  the screen, works when the window is folded, and works from the keyboard
  (Enter / arrows / Escape).
- PASSED cards show **PASSED (no ticket)** in the Jira area. Passes never get
  a Jira ticket, so nothing asks Jira about them, the label is not a link, and
  a PASS toast click opens TestView instead of Jira. FAIL and pre-test FAIL
  keep the existing Jira behaviour.

### Tests
- New suites: tests/ui.test.mjs (JIRAlerts header) and
  tests/dedupe.test.mjs (one event -> one log/toast, later events still
  processed); tests/timezone.test.mjs (exports in Pacific time on PCs set to
  UTC, Tokyo or Los Angeles, across the DST change; event time from the
  detail page Finished column, with fallbacks); PASSED cases in
  tests/jira.test.mjs. Harness can now open a
  second tab and a second installed copy.

## [0.9.10] - 2026-09-24

### Fixed
- TestView list fallback: pressing Query (a click, or `form.requestSubmit()`
  on the second try) can no longer reload the TestView page. On a form that
  does not cancel native submission, the browser used to navigate away,
  losing the typed SN and the query. The page's own submit handling still
  runs; only the browser's navigation is cancelled, and only for that one
  press. The real TestView (Ant Design) form already cancels it, so this was
  a latent risk, not a reported failure.

### Tests
- Automated test suite (`npm test`, 53 tests) and CI test job, added after
  0.9.9; two new regression tests cover this fix. See docs/TESTING.md.

## [0.9.9] - 2026-09-23

### Changed
- Clicking an alert card (anywhere but the serial, close or Jira button) now
  opens the card's server in TestView instead of the Server Detail page. The
  script looks up the serial's latest SLT test through TestView's own list API
  and goes straight to its test-detail page (`/slt/testdetail/<id>`). If no
  test is found or the lookup fails, it falls back to the TestView SLT list
  with the serial typed into the SN search and Query pressed.
  Cards without a serial still open Server Detail.
- The "Toast click opens" setting option "Server detail" is now
  "TestView search" and opens the same TestView query. Saved settings carry
  over unchanged.
- The script now also runs on the TestView `/slt/list` page, only to perform
  that lookup / auto-query. New grants: `GM_setValue`, `GM_getValue`,
  `GM_deleteValue` (hand the serial to the TestView tab).

### Security
- The TestView helper acts only on the TestView site itself; the host-agnostic
  `@match` would otherwise let an unrelated `/slt/list` page receive a clicked
  serial.

### Fixed
- `@name` no longer carries a stale version number (was "v0.9.7").
- The version fallback used when `GM_info` is unavailable was still 0.9.7.
- Stale version references: docs/CODE_NOTES.md header and the bug-report
  template placeholder now say 0.9.9.

### Documentation
- README: card click / TestView behaviour and the TestView API request in the
  Privacy section.
- docs/CODE_NOTES.md: new TESTVIEW section, including why the first builds of
  this feature failed (see "What finally fixed it").

## [0.9.8] - 2026-09-22

### Changed
- Moved all code comments (JS, CSS, HTML) out of the userscript into
  [docs/CODE_NOTES.md](docs/CODE_NOTES.md), one heading per
  `// ===== SECTION =====` marker. The script itself carries only code, a
  4-line banner, and one-line section markers. No behavior change: identical
  syntax tree, 135 automated checks pass, UI pixel-identical.
- Fixed repo layout so CI, the release workflow, and the bug report form
  actually run: workflows moved to `.github/workflows/`, the issue template
  to `.github/ISSUE_TEMPLATE/`, and helper scripts to `scripts/`.

## [0.9.7] - 2026-09-22

Several rounds of changes were made under this one version number, so
Tampermonkey does not offer this build as an update: install it by hand
(Tampermonkey Dashboard -> the script -> paste, or reinstall from the raw file).
Code-level reasoning for everything below is in
[docs/CODE_NOTES.md](docs/CODE_NOTES.md).

### Added - Jira

- A **Jira** button on every alert card (bottom-right). With a ticket known it
  opens `/browse/<KEY>` on its own, never the list of every ticket that ever
  mentioned the serial.
- FAIL / PRE-TEST FAIL cards look their ticket up in the background through
  `GM_xmlhttpRequest` using the browser's own Jira login - no credentials are
  stored or sent anywhere else. The card shows the key and a status-colour dot.
  Two requests at a time, one result each, cached in `sessionStorage` so a
  refresh does not repeat them. Not logged in -> lookups pause and resume when
  the tab regains focus.
- A fail card's ticket is the one raised **for that failure** (newest created
  since it), never the previous failure's. The company Jira bot usually raises
  it 5-10 min after the fail:
  - for 20 min the card says **Ticket pending** (**No ticket yet** on a pre-test
    fail) and checks every 30 s from minute 4 to 12, every minute otherwise; a
    card click opens a tab that switches to the ticket once raised; a toast
    click opens it by itself once raised;
  - after 20 min the card says **No ticket** and keeps checking every 5 min for
    2 h in case one comes late.
- **No-ticket page.** Whenever a failure has no ticket of its own, the tab a
  card click opens shows the serial, the fail time and exactly two buttons:
  - **Most recently updated** - `text ~ "<SN>" ORDER BY updated DESC`
  - **Most recently created** - `text ~ "<SN>" ORDER BY created DESC, updated DESC`

  Both open as `/browse/<KEY>?jql=...` on the serial's latest existing ticket
  (Jira shows it beside the list), or `/issues/?jql=...` when none is known.
  The buttons are dim at rest, brighten on hover and dip back to dim for a
  moment when clicked. The page is only redrawn when its text changes, so a
  background check can never swallow a click.
- Clicking a desktop toast opens the Jira ticket by default. With no ticket it
  opens "most recently updated"; the card-link fallback and the not-logged-in
  path open "most recently created".
- The alert search also matches the ticket key.
- Jira settings (toast click target, Jira URL) are visible only with **Dev**
  checked.

### Added - alert log per shift

- **Log shift** picker on the main panel: Day 6:00 AM-2:30 PM, Swing 3:30 PM-
  12:15 AM, Graveyard 10:00 PM-6:30 AM. Guessed from the clock on first run and
  saved.
- The log covers one run of that shift plus 1 h before and 1 h after. TXT/CSV
  exports and the clear-log count cover exactly that window, so shifts never mix
  in a file. The previous shift is cleared when the next one's window opens
  (9:00 PM for Graveyard), so the log never holds much more than a day.
- Changing the shift clears nothing; entries outside the new window just stop
  appearing in exports.
- Export file names carry the shift, e.g.
  `eve-slt-tracker-log-2026-09-21-graveyard-03-12-44.txt`.

### Added - panel and cards

- **Section counts.** While a section's Show switch is on, its row shows live
  `N test` / `N fail` / `N pass` pills from the rack colours. Pre-test and test
  both count as testing (hover for the split). The fail pill is the only place
  pre-test fails and test fails are counted together; everything else keeps
  them apart. Zero counts are dimmed.
- Cards older than **45 min** are dimmed so new ones stand out; hovering brings
  one back to full brightness. Visual only.
- Refresh row: pulsing live dot, interval dropdown, decimal countdown
  (`26.4s`), progress bar and a Refresh-now button. Collapsing the panel keeps
  the countdown visible in its title.
- Filter chips show live counts (All / Fails / Pre-test / Passes).
- A new alert re-opens the alerts window if it was collapsed (only when the new
  card is visible). Reloads keep the collapsed state.
- Developer page: **Pre-test fail** test button (replaces Persistence test).

### Added - keep awake

- Edge Sleeping tabs and Chrome Memory Saver freeze or unload background tabs.
  The tracker now holds a Web Lock (Chromium will not freeze a page holding one;
  https pages only), drives its 1 s tick from a Worker so a hidden tab's timers
  are not cut to once a minute, fires any overdue refresh the throttled timer
  missed, and detects sleep (`document.wasDiscarded`, freeze/resume, tick gaps).
  On wake it refreshes at once, shows a banner with the browser setting to
  change and a **Copy site** button, and sends a toast for naps of a minute or
  more (at most one per 10 min). Baselines survive in `sessionStorage`, so
  changes made while asleep are still caught - late.
- Only the browser's own exclusion list reliably prevents sleep: Edge
  `edge://settings/system` -> Performance -> **Never put these sites to sleep**,
  or the `SleepingTabsBlockedForUrls` policy.

### Changed

- Auto refresh and soft refresh are always on. Interval 30 s by default and can
  only go faster (20 s / 10 s); a stored 60 s+ value from an older build resets
  to 30 s. Old on/off switches in settings are ignored and dropped on load.
- Alerts window renamed **JIRAlerts** (title and the summary toast).
- The Show/Hide DEBUG button is gone. The **Dev** checkbox is the only switch:
  Dev on shows DEBUG/test and SYS_DEKIT cards, Dev off hides them (still logged
  and exported). Stored `showDebug` / `hideTestResults` values are dropped.
- The batch summary toast names test fails and pre-test fails separately
  (`2 TEST FAIL · 1 PRE-TEST FAIL ❌ (+1 pass)`) instead of adding them up.
- Alert cards restyled: dark card with a coloured edge and status dot. TEST PASS
  mint, TEST FAIL light red, PRE-TEST FAIL dark red, PRE-TEST PASS teal. Panel
  and alerts window restyled to match; sections shown as a card with Show /
  Notifs switches; Developer page and Jira settings are flat cards.
- `X All` needs a second click within 3 s. Esc clears the search. Column
  headers explain themselves on hover.
- The shift rollover toast reads "NEW GRAVEYARD SHIFT LOG" (etc.) and no longer
  uses the red failure X.
- **Script slimmed.** Every comment and the in-file changelog moved to
  [docs/CODE_NOTES.md](docs/CODE_NOTES.md) and this file; the script keeps a
  short banner and one-line section markers, and is formatted with Prettier
  (2-space indent). 11,773 -> 6,903 lines, 432 KB -> 224 KB. Verified to be the
  same program (identical syntax tree, 135 automated checks, pixel-identical
  UI).

### Fixed

- **The log was wiped at midnight** - the first half of the graveyard shift
  disappeared mid-shift. Replaced by the per-shift log above.
- **A network blip stopped the tracker silently.** Every failed soft refresh
  reloaded the page; during an outage the reload lands on the browser's own
  error page, where the script cannot run. Network errors, timeouts and HTTP
  5xx/408/429 now keep the page (stale), set health to DEGRADED with one toast,
  and retry every cycle. Session problems still reload so the login page shows
  (401/403, login redirect, and a cross-host SSO redirect - told apart from an
  outage by an opaque HEAD probe).
- **Several EVE tabs erased each other's log entries.** Each tab wrote its whole
  copy over the shared log. Writes now merge with storage, a clear or rollover
  in one tab sticks in all, and export / clear-log include every tab's entries.
- **CSV formula injection.** Cells starting with `=` `+` `-` `@` now get a
  leading apostrophe.
- **Unbounded cards.** At most 200 cards on screen (oldest leave first);
  storage and the log are unchanged.
- **Jira lookups could jam.** An aborted request never settled and held its
  queue slot; `onabort` is now handled.
- "Soft refresh OK" is a Dev-only console line (it printed every cycle).

### Removed

- Dead code: `softRefreshDisabledForSession`, `softRefreshFailures`,
  `MAX_SOFT_REFRESH_FAILURES`, `softRefreshEnabled()` (the "disable after 3
  failures" branch could never be reached), `setupMenuStatePersistence()`,
  `MENU_STATE_KEY`, and the unused `.eve-byline` / `.eve-refresh-toggle` CSS.

## [0.9.6]

Structural pass - no intended behaviour change.

### Fixed

- `updateAlertCard()` skipped `applyAlertFilter()` whenever the phase note came
  back empty, after already rewriting the card's class and flags. A card that
  only became a SYS_DEKIT on confirmation picked up the diagnostic flag but was
  never re-filtered, so it stayed on screen as whatever colour first called it.
  An emptied note is now removed rather than left showing stale text.
- `phaseConfirmCache` had no eviction (its TTL was only checked on read), so one
  entry per url|serial accumulated for the life of the tab. It now has a cap and
  a TTL sweep.

### Changed - consolidated

- `bindSetting()` replaces five hand-written control bindings.
- `createUI()` (585 lines, six jobs) split into `buildTrackerPanelMarkup()`,
  `wireTrackerSettings()`, `wireDeveloperMode()` and `wireDebugButtons()`.
- `applyCardState()` replaces two independent derivations of a card's class and
  flags, so a card built before confirmation and one corrected after it cannot
  drift.
- `chaseStaleConfirmations()` backs both the master-tick retry and the
  on-restore re-check.
- `setTextIfChanged()` / `setClassIfChanged()` stop the once-a-second countdown
  rewriting unchanged DOM.
- `TRANSITIONS` is the single source of truth for the category taxonomy (title,
  status line, icon, CSS class, .txt heading, .csv name, diagnostic flag).
- `writeLogEntryResult()`, `readJSON()` / `writeJSON()`, `exportLog(kind)` and
  `persistBeforeUnload()` replace duplicated code.

### Removed

- `getEveHeaders()` (no callers), `getTestPhaseHint()` and `PHASE_ATTRIBUTES`
  (read attributes the page never emits), `recordTransition()` (a pass-through),
  `clampAlertPanelToViewport()` (duplicate of `clampToViewport()`), and a
  duplicate `.eve-credit` CSS rule.

### Not changed, on purpose

- The two window-drag implementations (they differ in six documented ways), the
  four retry mechanisms, `reconcileAlertPhase()`'s unverified branch, `scan()`'s
  prune guard and `performSoftRefresh()`'s `onDone()` contract.

### Verified

- Against v0.9.5 in jsdom: .txt and .csv exports byte-identical; PRE-TEST FAIL,
  TEST FAIL and SYS_DEKIT paths produce the same transition, label, card count,
  toast count and fetch count; every settings control stores the same value.

## [0.9.2] - [0.9.5]

Not recorded in this file at the time. From the code notes: v0.9.4 took the
PRE-TEST vs TEST phase from each server's detail page instead of guessing it
from cell colour; v0.9.5 read the result from the detail page's Pass column,
mapped the SLT operation to TEST, added SYS_DEKIT as a diagnostic (never a
failure), re-checked restored cards whose phase or result was never confirmed,
and only escalated slot disagreements that look like a column-mapping fault.

## [0.9.1] - 2026-09-09

### Fixed - silent monitoring failures

- Soft refresh could permanently stop auto-refresh. The "already in flight"
  early return skipped the callback that reschedules the timer, and the fetch
  had no timeout, so a hung request stalled refreshing for the life of the tab.
  Added an `AbortController` with a 15s cap, a completion callback that runs on
  every exit path, and a watchdog that force-restarts an overdue refresh.
- Turning a section's "Notifs" off also stopped it being written to the audit
  log, leaving invisible holes in the exported record. Recording and surfacing
  are now separate; the flag suppresses only the card and the desktop toast.
- The test-phase hint could create alerts for colour transitions the spec
  ignores. It can now only re-label an already-tracked test fail as a pre-test
  fail.
- The phase hint no longer reads cell text, class or id, only explicit `data-`
  attributes. On a page called Server Level Test the word "test" appears
  everywhere and the hint fired constantly.
- Flap protection now keys on the serial as well as the rack slot, so a
  replacement server that genuinely fails the same way inside the cooldown is
  no longer suppressed. The cooldown map is persisted so a reload cannot re-arm
  it.
- Added `@run-at document-start` so the page's own meta refresh is stripped
  before the browser commits it.

### Changed - performance

- `scan()` and `applyVisibility()` walk each table's rows once and loop the
  header columns inside, instead of re-walking every row once per header.
- `normalizeColor()` checks the legacy `bgcolor` attribute before falling back
  to `getComputedStyle()`.
- Phase hints are cached on the cell node; header lookups are cached and
  invalidated on real DOM change.
- The audit log is held in memory and written debounced, rather than a full
  parse and stringify of the whole array on every alert.
- The mutation observer is suppressed around the tracker's own writes and
  inspects added/removed nodes rather than only the mutation target.
- Section controls diff the section set instead of rebuilding every checkbox on
  every mutation tick.

### Changed - operational

- One version string, sourced from `GM_info`.
- Added `@noframes`, `@updateURL` and `@downloadURL`.
- Debug snapshot and comparison only run in Developer Mode.
- Repeated soft-refresh failures disable it for the session only, instead of
  writing a permanent disable to `localStorage`.
- Added a Health Check button that dumps the tracker's internal state.

### Fixed - other

- Dismissing a card re-applies the active filter.
- Debug/test cards are evicted before real ones at the storage cap.
- Toast clicks use `GM_openInTab` (a `window.open` from a notification callback
  is not a user gesture and gets popup-blocked).
- The console diagnostic is exposed on `unsafeWindow` so it is reachable from
  F12.
- `detailUrl` is protocol-checked before being opened.
- CSV date and time columns are derived from the ISO timestamp so they sort
  correctly in Excel regardless of machine locale.

## [0.9.0] - initial

- First tracked release.
