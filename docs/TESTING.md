# Testing and QA guide

How this project is verified, what each test protects, and how to use the
tests when changing the script. Keep this file current: a change to the
script that alters behaviour updates the matching row of the
[code-to-test map](#code-to-test-map) in the same commit.

- Architecture and the *why* behind the code: [CODE_NOTES.md](CODE_NOTES.md)
- Release history: [../CHANGELOG.md](../CHANGELOG.md)

---

## Quick start

```bash
npm ci                                  # once: installs Playwright (dev only)
npx playwright install chromium         # once, if no Chromium is available
npm test                                # everything, ~4 min
npm run check                           # syntax + header only, ~1 s
npm run test:static                     # file-level checks, no browser
npm run test:unit                       # pure logic, one browser page
npm run test:browser                    # rack / TestView / Jira / UI / dedupe
npm run test:mutation                   # proves the suite catches bugs, ~45 min
```

Set `EVE_CHROMIUM=/path/to/chrome` to use a specific Chromium binary.
Nothing in `package.json` ships to users; the userscript has no dependencies.

---

## Architecture in one page

One IIFE userscript, two roles chosen in `bootstrap()` by URL path:

```
Rack page (@match */out/out.eveslt.php*)                     TestView (@match */slt/list*)
------------------------------------------------            ------------------------------
INPUT     rack table cells: bgcolor + <a>SERIAL ...</a>      #eveSn= hash or GM handoff
DISCOVER  getEveTableGroups(): <th> "TA.<sec>-EVE<n>"        isTestViewOrigin() guard
DETECT    scan() -> processSlot(): colour vs previousStates  lookupTestViewDetailId()
          getTransitionType(): lightgreen/darkgreen/          (TestView list API)
          lightblue -> red = FAIL, lightgreen -> darkgreen    -> /slt/testdetail/<id>
          = PASS; serial change = re-baseline, no alert       else startTestViewListQuery():
FILTER    isDuplicateAlert() 60 s cooldown; section "Notifs"   type SN, press Query, verify
CONFIRM   confirmPhase(): fetch detail page ->
          parseDetailDocument() -> resolveTransitionFromDetail()
OUTPUT    in-page card (renderAlertElement), desktop toast
          (GM_notification), audit log (localStorage),
          Jira button (GM_xmlhttpRequest -> jira search API)
STATE     sessionStorage: baselines, cards, cooldowns, Jira cache
          localStorage: settings, audit log, panel positions
          GM storage: TestView handoff (2 min TTL)
TIMERS    master tick (Worker, 1 s) -> scan / watchdog / labels;
          soft refresh re-fetches the rack page and swaps the body;
          MutationObserver (250 ms debounce) rescans on DOM change
```

External calls, all with the user's existing browser sessions (no stored
credentials): the rack site (same origin), Jira search API
(`GM_xmlhttpRequest`, `@connect jira.synnex.com`), TestView list API
(same-origin fetch from the TestView page).

---

## How the tests work

`tests/harness/userscript.mjs` loads the **real, unmodified** script into
headless Chromium the way Tampermonkey does:

- in an **isolated JS world** at **document start** (CDP
  `addScriptToEvaluateOnNewDocument` with a world name);
- with `window` wrapped in a **Proxy** - Tampermonkey's sandbox window is not
  a real `Window`, which is what made `new MouseEvent(t, { view: window })`
  throw in the field (v0.9.9). A plain page test does not catch that class of
  bug; this harness does (proven by a test);
- with every `GM_*` API stubbed and recorded (`__gm.notifications`,
  `openedTabs`, `windowOpens`, `xhr`, `store`).

`tests/harness/server.mjs` answers **every** request: fixture rack page
(`RackModel`, stateful so soft refresh can see changes), detail pages, Jira
search API, TestView list page (antd-faithful stand-in) and API. Unrouted
requests get 404 and are recorded; workflow tests assert there were none.

For unit tests the harness appends one line to an in-memory copy of the
script exposing internal functions as `globalThis.__eve.<name>`
(`HOOK_NAMES`). If a hooked function is renamed, the harness fails naming it.

All fixture data is synthetic (serials `2699YW....`). Never put real serials,
Jira keys, tokens or cookies in tests.

---

## Suites

| File | What it proves | Speed |
|---|---|---|
| `tests/static.test.mjs` | Parses; header valid; ASCII; version consistent across `@version`, fallback, CHANGELOG; `@name` has no version; every `GM_*` used is granted and vice versa; every section marker has a CODE_NOTES heading; no `view: window`; no tokens/keys in tracked files; only allow-listed hosts in the script | < 1 s |
| `tests/logic.test.mjs` | Transition table; colour aliases; detail-page authority rules; phase/status/pass words; `parseDetailDocument` (fail, pass, running, newest row, disagreement, serial mismatch, login/empty pages); Jira response states; CSV formula injection; HTML escaping and URL safety; shift windows across midnight; flap cooldown; TestView URL building | ~5 s |
| `tests/rack.test.mjs` | Boot (panel, meta refresh stripped, no alerts on baseline); FAIL / PASS / PRE-TEST detection end to end (card, toast, audit log, detail fetch); non-result colour changes ignored; server swap; flap protection; Notifs-off section; cards survive reload without re-alerting; soft-refresh detection; card click -> TestView + handoff; serial/close clicks do not open TestView; toast click targets (TestView, Jira) | ~20 s |
| `tests/testview.test.mjs` | Lookup -> detail redirect; newest test wins; GM handoff after a dropped hash; stale handoff ignored; list fallback (one Query with the SN, hash stripped); empty result = filtered; API error fallback; Query / requestSubmit never reload a native form; origin guard; idle without a serial; harness reproduces the `view: window` crash | ~25 s |
| `tests/jira.test.mjs` | Card Jira button: ticket found (key shown, serial queried), pending, login needed (401); PASS and pre-test PASS show "PASSED (no ticket)" with no link and no Jira call; PASS toast opens TestView; PASS relabelled FAIL gets the live button; pre-test FAIL unchanged | ~20 s |
| `tests/ui.test.mjs` | JIRAlerts header: title bar is the title plus one small "..." menu button (rest is drag area), empty area and title drag the panel, click still folds; the actions menu opens below (or above near the bottom) inside the viewport, is not clipped when folded, closes on outside click / Escape / drag / export, works from the keyboard; TXT / CSV download, Dismiss all arms then clears and is disarmed by closing, hidden with one card; drags never activate a control, snapping/clamping exact (no creep) | ~25 s |
| `tests/timezone.test.mjs` | Export date/time are Fremont time (PDT/PST, incl. the November DST change) on PCs set to UTC, Asia/Tokyo and America/Los_Angeles; a real detected failure's TXT row, chronological line and CSV columns are Pacific, header names PDT/PST, only the `ISO:` line is UTC; detail-page Finished time parsed as Fremont time and used as the event time, with fallback to detection time when blank, in the future or over a day old | ~25 s |
| `tests/jiraux.test.mjs` | Jira chip: pending -> ticket shows one "new" badge; rescans / soft refreshes / repaints never add or re-add it; first hover starts a 3 s fade (still there at 1.5 s, gone at ~3 s, glow with it); no badge when the ticket existed at first look; no timeout, survives a page reload until hovered, never back after it; gold outline fires once per failure (back after a reload until acknowledged, never after); the no-ticket page: before 15 min one plain, unhighlighted line "If there is no ticket by <time>, please open PuTTY and create one with: ticket <serial>"; from 15 min the gold box "It has been more than 15 minutes and no ticket has been created. Please make one in PuTTY:" with a Copy button (resets after 2 s) and no extra PuTTY text, for test and pre-test fails alike; the plain line's command sits in a small neutral box; matching chip tooltips; TestView 2.0 status (fixture API, real field names): RUNNING -> no ticket prompt, plain "failed and is being re-tested now" line, pre-test chip "No ticket (re-testing)" without gold; finished -> gold box says "the server is not running"; FAILED / no status / not found / API error -> not running or unknown -> prompt as normal; one cached request; the re-testing line links to the running run in TestView 2.0; a card whose server left its slot (swapped / empty) is struck through with one "Removed from rack" tag in the serial box (what is there now in its tooltip) and copying disabled, unmarked when it returns, a retest is not removed, other racks' cards untouched; copy control only for a real ticket, copies the full ticket link, "copied" feedback, one control after repaints, opens nothing (no Jira, no TestView); no copy for pending / no ticket / pass / auth / error; pre-test "No ticket (create one)" with unchanged click target and a yellow tracing outline that fades 10 s after the first hover and never returns on repaint; pre-test switches to "create one" at 15 min (14 min still waiting; test fails still pending); on a 45 min+ card the rest dims (<75% brightness, decoded screenshots) while the gold chip stays >95% until acknowledged, then dims too; hover un-dims; only Jira reads | ~40 s |
| `tests/keepawake.test.mjs` | No sleeping-tab banner, tip or settings buttons (Edge and Chrome); Web Lock, Screen Wake Lock and Worker tick attempted at start; after a sleep an immediate catch-up refresh with no banner and no desktop notification | ~15 s |
| `tests/stability.test.mjs` | Every storage key holding invalid JSON / null / a number / a string / an array / {}: starts (no FAILED TO START, no page errors) and still raises a fail card + toast; wrong-shaped saved values (garbage baselines, null cards, bad log rows, bad settings) likewise; storage whose writes throw (quota) likewise; 40 soft refreshes with results: window/document listeners, MutationObservers, intervals, workers unchanged, pending timeouts, DOM nodes and JS listeners bounded, one panel / alert window / stylesheet, 6 tracked slots; 3 reloads: exactly one panel, observer and Worker each, no alerts or toasts; a tick step that throws every time is logged once, the ticker keeps running and detection resumes (logged recovery); TestView status cache capped at 200 | ~45 s |
| `tests/cellclick.test.mjs` | Red rack cell (link, padding, keyboard Enter) opens the same TestView URL + handoff as the alert card; each serial its own; non-red cells, other tables, the Unit column, headers and modifier / middle clicks are not intercepted; after soft refreshes new red cells work, one open per click, no DOM added | ~25 s |
| `tests/shiftlog.test.mjs` | Log shift on a simulated Fremont clock: Auto is the default; a new session gets the running shift; an open session stays on its shift through the overlaps and moves on when the window ends (Graveyard -> Day 7:30 AM -> Swing 3:30 PM -> Graveyard 1:15 AM); nothing is cleared at 6:30 / 7:30 AM or during the day; a hand pick lasts until the next shift change; Day picked at 4 AM never wipes a running Graveyard; an old hand-picked setting migrates to Auto; tooltip says Auto/Manual, the window and the clear time | ~20 s |
| `tests/dedupe.test.mjs` | One event -> one log entry + one toast with two tabs (either order) or two installed copies; repeated scans; PASS / FAIL / pre-test FAIL once each; a later FAIL after a retest and FAIL-then-PASS still processed (one tab and two tabs); old baselines never suppress; retry never overlaps an in-flight confirmation | ~60 s |
| `tests/mutation.mjs` | Plants real bugs one at a time (74); each must make its suite fail | ~45 min |

A test has **genuinely passed** only if it asserts the behaviour (card text,
toast title, request made, URL reached, value stored) - not merely that code
ran. `npm run test:mutation` is the proof: every mutant must be `KILLED`.

---

## Code-to-test map

`Area -> depends on -> typical change -> what can break -> tests to run`

| Area (CODE_NOTES section) | Depends on / used by | Can break | Run |
|---|---|---|---|
| Header / grants / VERSION | Tampermonkey install + update, `GM_*` calls | updates not offered; API undefined at runtime | `test:static`, then `npm test` |
| EVE TABLE / HEADER DISCOVERY | rack page markup (`TA.x-EVEn` headers, `Un` rows) | nothing detected (BLIND), wrong column | `rack` (all), `logic` |
| NORMALIZE COLOR, VALID TRANSITIONS | scan, section counts, CSV | missed or false alerts | `logic` (transition + colour), `rack` |
| SCAN PAGE / processSlot | baselines, flap, log, confirm, surface | duplicate/missed alerts, swap alerts | `rack` |
| FLAP PROTECTION | sessionStorage cooldown map | alert storms or swallowed alerts | `logic` (isDuplicateAlert), `rack` (flap), `dedupe` |
| EVENT CLAIMS / claimThisTab / previousStates.seen | localStorage claims, rackDataAt, other tabs and installed copies | duplicate log entries and toasts, or a real later event swallowed | `dedupe` (all), then `rack` |
| PHASE CONFIRMATION | detail page HTML, fetch, cache | wrong PASS/FAIL/phase on cards and log | `logic` (parseDetailDocument, resolve), `rack` (PRE-TEST override) |
| SURFACE AN ALERT / RENDER CARD / RECONCILE | GM_notification, card DOM, click handlers, confirmationsInFlight | missing or doubled toast/card, wrong title, click opens wrong page | `rack`, `dedupe`, `jira` |
| ALERT PERSISTENCE | sessionStorage | cards lost or duplicated on refresh; bad saved data stops startup | `rack` (reload), `stability` |
| STORAGE I/O (readJSON / isRecordObject) | every saved key | corrupt or unwritable storage stops the tracker | `stability` |
| MASTER TICK / runTickStep, INITIALIZE, observer, soft refresh lifecycle | Worker ticker, MutationObserver, window listeners | resources piling up over hours; one failing step stalls the rest | `stability`, `keepawake` |
| SOFT REFRESH / swapPageBody / observer | fetch of rack page, our UI nodes | monitoring silently stops, UI wiped | `rack` (soft refresh) |
| REAL-ALERT AUDIT LOG, .TXT, .CSV | localStorage, shift windows | lost entries, CSV injection, wrong shift | `logic` (csv, shift), `rack` (log entries) |
| JIRA (incl. isPassResult, syncJiraForCard, openNotificationTarget) | GM_xmlhttpRequest, jira search API, card button, TRANSITIONS | wrong ticket, crash on auth/error, Jira shown or queried for a pass | `logic` (parseJiraResponse), `jira`, `rack` (toast clicks) |
| TESTVIEW | GM storage handoff, TestView API + list page | wrong test opened, serial leaked to another site, no query | `testview`, `rack` (card/toast click) |
| Settings (LOAD / SAVE, sections) | localStorage | Notifs/visibility ignored | `rack` (Notifs off) |
| ALERT WINDOW UX (drag / snap), JIRAlerts header CSS | panel + header boxes, localStorage position | hard to grab, panel jumps, controls fire on drag | `ui` |
| Other CSS / visual polish | DOM only | visual regressions | manual (see below) |

When in doubt, run `npm test` - it takes about 2 minutes.

---

## Change workflow (every change)

1. **Locate**: find the section(s) in the script and CODE_NOTES.
2. **Trace**: use the map above for what depends on it; grep for callers.
3. **Predict**: which rows of the map can break? Inputs, outputs, storage,
   timers, other roles (rack vs TestView), Tampermonkey sandbox behaviour.
4. **Test first where practical**: add/extend the test that proves the new
   behaviour; for a bug, write the failing regression test before the fix.
5. **Implement** the smallest change.
6. **Run** the targeted suite, then `npm test`. For risky logic changes also
   `npm run test:mutation` (and add a mutant for the new logic).
7. **Diagnose** any failure: new code, wrong test, environment, or an
   existing bug exposed. Fix the real cause; never weaken an assertion to
   get green without writing down why.
8. **Release rules**: script change -> bump `@version` + CHANGELOG entry;
   keep the file ASCII; update CODE_NOTES and this file when behaviour or
   coverage changes.
9. **Report with evidence**: which commands ran and their results, plus what
   could not be verified here (see below).

### Regression tests

Every field bug gets a test that fails on the buggy code and passes on the
fix, named `regression: ...` with a comment saying what happened. They stay
permanently unless a documented reason says otherwise. Current:

- `regression: no view: window in synthetic event init` (static) and
  `regression: harness reproduces the view: window crash` (testview) -
  v0.9.9 TestView Query click crashed under Tampermonkey.
- `regression: Query as a submit button on a native form does not reload the
  page` and `regression: try-2 form.requestSubmit() on a native form does not
  reload the page` (testview) - found while building the suite, fixed in
  0.9.10: pressing Query on a form that does not cancel native submission
  reloaded TestView and lost the query.
- `tests/dedupe.test.mjs` (whole file) - field report fixed in 0.9.11: one
  failure logged and toasted twice. Root cause: two tabs, or two installed
  copies, each processed the same event (shared log, separate toasts). The
  two-tab and two-copy tests fail on 0.9.10. Also covers the stale 2-minute
  detail cache (FAIL then PASS logged as FAIL twice) and the retry overlapping
  an in-flight confirmation.
- `tests/ui.test.mjs` drag tests - 0.9.11: the draggable strip was a thin gap
  (title span had flex: 1), the post-drag click guard was dead code, and the
  panel crept 1-2 px per drag.
- `tests/timezone.test.mjs` (whole file) - field report fixed in 0.9.11:
  exports showed raw UTC times (a 10 PM - 6:30 AM shift as 05:18 - 09:55).
  All four tests fail on 0.9.10.
- `tests/shiftlog.test.mjs` - review of 0.9.11: the log was cleared at the
  selected shift's window, so Day (opens 5:00 AM) wiped a running Graveyard.
  With that rule restored, the Day test fails. Also covers the Auto log
  shift requested in the same review. The event-time tests cover the review
  request to log when a result happened (detail page Finished), not when
  it was noticed.

---

## What the automated tests cannot verify

These need a human on the real site (or explicit acceptance of the risk):

- Real rack page markup and real detail pages changing format. Fixtures copy
  the structure the parser relies on; if the site changes, fixtures must be
  updated from a (sanitised) real page.
- Real TestView: its API response shape and Ant Design form behaviour. The
  fixture mimics what the script depends on (see `testViewListPage`).
- Real Jira (SSO, ticket timing, the bot).
- Tampermonkey itself: install/update flow, real `GM_notification` toasts on
  Windows/Edge, permission prompts.
- Visual layout, drag/snap, file downloads, clipboard.
- Long-running behaviour over hours (tab sleep, memory). The code bounds every
  collection (see CODE_NOTES); tests check correctness, not endurance.


---

## Adding a test

- Pure logic: add the function to `HOOK_NAMES` in
  `tests/harness/userscript.mjs` if needed, then call it from
  `tests/logic.test.mjs` via `__eve.<name>`.
- Rack workflow: `openRack()` + `setSlot()` from `tests/harness/rack.mjs`;
  change `server.rack` for soft-refresh cases; `server.details` for detail
  pages; `server.jira` for tickets.
- TestView: `server.testview.api` / `apiStatus` / `listHtml`.
- Assert on `tm.gm()` for toasts, tabs, `window.open` and GM storage;
  `tm.errors` and `server.unrouted` must stay empty.
- Several observers: `openWithScript(..., { context: other.context })` opens a
  second TAB (shared localStorage, own sessionStorage); `{ copies: 2 }` injects
  the script twice into one tab (worlds `tm`, `tm2`; `tm.gm('tm2')`).
- Seed storage before the script runs: `{ localStorage: {...}, sessionStorage: {...} }`
  (JSON-encoded), or `{ rawLocalStorage, rawSessionStorage }` for values stored
  verbatim (corrupt data).
- `{ prelude: '...' }` runs extra code in the script's world first: count
  timers / listeners / observers, or make an API throw (see `stability`).
- Time: `__eve.resetFlap()` expires the 60 s flap cooldown; `server.detailDelayMs`
  slows detail pages; `__eve.retryPendingConfirmations()` runs the 45 s retry now.
- New behaviour worth protecting? Add a mutant to `tests/mutation.mjs`.
