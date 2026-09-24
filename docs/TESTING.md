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
npm test                                # everything, ~40 s
npm run check                           # syntax + header only, ~1 s
npm run test:static                     # file-level checks, no browser
npm run test:unit                       # pure logic, one browser page
npm run test:browser                    # rack / TestView / Jira workflows
npm run test:mutation                   # proves the suite catches bugs, ~3 min
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
| `tests/testview.test.mjs` | Lookup -> detail redirect; newest test wins; GM handoff after a dropped hash; stale handoff ignored; list fallback (one Query with the SN, hash stripped); empty result = filtered; API error fallback; origin guard; idle without a serial; harness reproduces the `view: window` crash | ~15 s |
| `tests/jira.test.mjs` | Card Jira button: ticket found (key shown, serial queried), pending, login needed (401) | ~8 s |
| `tests/mutation.mjs` | Plants 11 real bugs one at a time; each must make its suite fail | ~3 min |

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
| FLAP PROTECTION | sessionStorage cooldown map | alert storms or swallowed alerts | `logic` (isDuplicateAlert), `rack` (flap) |
| PHASE CONFIRMATION | detail page HTML, fetch, cache | wrong PASS/FAIL/phase on cards and log | `logic` (parseDetailDocument, resolve), `rack` (PRE-TEST override) |
| SURFACE AN ALERT / RENDER CARD / RECONCILE | GM_notification, card DOM, click handlers | missing toast/card, wrong title, click opens wrong page | `rack` |
| ALERT PERSISTENCE | sessionStorage | cards lost or duplicated on refresh | `rack` (reload) |
| SOFT REFRESH / swapPageBody / observer | fetch of rack page, our UI nodes | monitoring silently stops, UI wiped | `rack` (soft refresh) |
| REAL-ALERT AUDIT LOG, .TXT, .CSV | localStorage, shift windows | lost entries, CSV injection, wrong shift | `logic` (csv, shift), `rack` (log entries) |
| JIRA | GM_xmlhttpRequest, jira search API, card button | wrong ticket, crash on auth/error | `logic` (parseJiraResponse), `jira` |
| TESTVIEW | GM storage handoff, TestView API + list page | wrong test opened, serial leaked to another site, no query | `testview`, `rack` (card/toast click) |
| Settings (LOAD / SAVE, sections) | localStorage | Notifs/visibility ignored | `rack` (Notifs off) |
| CSS / UI layout, drag/snap, exports download | DOM only | visual regressions | manual (see below) |

When in doubt, run `npm test` - it is only ~40 s.

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

Known risk found while building the tests: on TestView the list fallback's
second try uses `form.requestSubmit()`. On a form that does not cancel native
submission this reloads the page. The real antd form cancels it, so this has
not happened in the field; the fixture mirrors antd.

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
- New behaviour worth protecting? Add a mutant to `tests/mutation.mjs`.
