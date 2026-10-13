# EVE SLT+JBOG TRACKER 2.0.2: validation status

Installable file: `EVE_SLT_JBOG_TRACKER.user.js`. Current version: **2.0.2**.
2.0.2 adds the first-load Rack Map fix, a scan-to-find box, per-rack status
chips, fixture-based rack mapping for rows B6/B7 (with the Dev box) and the
failed-board idle rule on top of the 2.0.1 integration, and is the first
version with recorded test results. Those results come from synthetic fixtures
only.

## 2.0.2 executed checks

Cloud container, 2026-10-13, Node 22.22, Playwright 1.56.1, Chromium 141.0.7390.37.

| Check | Result |
|---|---|
| `npm run check` (syntax, header, `@version`) | pass; four deliberate "@match any host" warnings |
| Plain-ASCII check of the userscript | 0 non-ASCII lines |
| Version check against `main` (`scripts/check-version-bump.mjs`) | OK: 2.0.1 -> 2.0.2 |
| `npm test` on the final tree (10 static, 18 unit, 284 browser; 35 tests are new: 19 fixture, 11 fixture-defaults, 4 failed-board idle rule, 1 shipped-map shape) | 312 run, 312 passed, 0 failed |
| The 277 earlier tests against the new script, before they were updated | 265 passed, 12 failed: 10 Ramses tests (their helper's default idle time of 24 minutes now settles silently) and 1 rack-scan test (the summary now lists fixtures) are deliberate behavior changes; the 12th was the credentials test, which only failed because that copy had no `.git` |
| CI on the pull request, first run on the fixture commit | 311 of 312 passed; the one failure was a race in a new test (focus asserted before the panel's toggle event), fixed in `2186826`. Later runs are in the PR |
| Quick mutation check of the new rules (idle rule x4, `mapRevision`, Dev lock, "Waiting for new" word, rack scan turning its row on, dotted rack barcode, duplicate fixture), selected tests only | 10 killed, 0 survived (two mutants were corrected before counting: one did not change behavior, one ran the wrong test) |
| Ramses mutation runner (`node tests/lionking-ramses.mutation.mjs`, now 12 mutants including 2 for the idle rule) | 11 killed, 1 survived, 0 not tested of 12. The survivor is the known gap: an absent running row is manufactured into a PASS result |
| Collector, direct TestView, controls and resilience mutation runners | not rerun on this tree |
| Earlier in 2.0.2, before the fixture work: `main` at 58b6cbc, same browser suites | 248 run, 208 passed, 40 failed |
| Earlier in 2.0.2: browser suites with only the first-load Rack Map fix | 248 run, 241 passed, 7 failed (the 7 were fixed) |
| Earlier in 2.0.2: Lion mutation runners (each started separately because the first one exits non-zero when anything is not tested) | 27 killed, 1 survived, 5 not tested of 33 mutants |
| Earlier in 2.0.2: new rack-scan tests against four deliberate bugs (first-load default, worst-state order, partner serial lookup, disabled-row check) | 4 of 4 caught |

The 40 failures on `main` were mostly one bug: with no saved window state the
Rack Map opened on first load and hid the tracker panel. The other failures were
test or harness drift, not product defects: storage re-seeded in every new tab,
an out-of-date export filename, a Dev-only control tested while hidden, an
over-broad file-input selector, and Ctrl/Shift/middle-click tests that asserted
where Chromium lands a fixture-routed new tab.

Earlier mutation detail (before the fixture work; only the Ramses runner was
rerun since, see the table): collector 7 killed, 3 not tested; direct TestView 4 killed;
controls 3 killed, 1 not tested; resilience 4 killed, 1 not tested; Ramses 9
killed, 1 survived. Four not-tested mutants name source lines that were
reformatted before 2.0.1 ("expected one source anchor, found 0"; they are stale
on `main` too) and one timed out (`spawnSync ETIMEDOUT`, "Lion storage overwrites
the original SLT namespace"). The survivor is "an absent running row is
manufactured into a PASS result": the Ramses suite passes with that bug, a gap
in an existing test. It was not measurable before, because the Ramses runner's
baseline times out on `main` (0 of 10 mutants tested there) while the Rack Map
covers the page. The legacy SLT mutation runner (`npm run test:mutation`) was not
run; this change does not touch SLT code.

Not verified: real signed-in TestView, Jira or Ramses pages, a real handheld
scanner (assumed to end each scan with Enter), Tampermonkey on Windows, and
desktop toasts. Before and after screenshots use the synthetic fixture page.
Specific to the fixture map and the idle rule:

- The TestView lookups (`fixture_sn` filter, the status word of a running test,
  paging, whether a fixture serial can also appear as a head node) are only
  tested against a synthetic server. A wrong assumption shows as Empty or
  Waiting for new where a JBOG is testing.
- The failed board's Idle Time is assumed to be the time since the JBOG landed
  on it (read from its `0h24m` / `1d3h20m` format). If a real new failure does
  not alert, the cell text is the first thing to check.
- A pass that finished while the tab was closed can still notify on load; the
  idle rule covers failures only.
- E2/E4/BL has no built-in fixtures yet, and the registry is shared between tabs
  through Tampermonkey storage (stubbed in the tests, not run on Windows).

## Current manual coverage needed

Use [TESTING.md](TESTING.md) for commands and a focused checklist. Signed-in
validation should cover:

- Ramses running/PRETEST/failed boards and the current MPY passed CSV source;
  native updates, stale/hidden/replaced downloads, duplicate/conflicting
  sources and timezone/Finished semantics.
- Separate TEST and PRETEST failures, quiet initial/migration baseline,
  changed failed-board episodes, durable logging and multiple tabs.
- Every row initially disabled, saved Enabled state, synchronized arrow,
  row visibility/notifications, and absence of individual rack toggles.
- Click-slot/scan, preserved registry order, companion lookup, quick remove,
  Jira/TestView buttons, timestamp meaning and readable colors at 100% zoom.
- Shared B6/B7 scroll, independent E2/E4/BL scroll, map/tracker exclusivity,
  browser shrink/restore and viewport fit.
- Jira serial searches ordered updated DESC with a cached key, no key,
  modifier clicks and notification clicks, using the existing login.
- TestView exact serial/operation/Started matching, PRETEST detail navigation,
  by-ID verification, login errors and manual list fallback.
- Rack Map closed on a clean first load with the tracker panel visible, and
  remembered open/closed state after a reload.
- Scan-to-find with the real handheld scanner (Enter-terminated): rack barcode,
  tail and head serial, an unknown scan and a rack in a disabled row; header
  chips and the failure underline.
- Fixture map on rows B6/B7: scan each rack and compare every position's fixture
  and state with the physical rack; swap a fixture through Fixture setup (Dev)
  and Reset to built-in; confirm Dev is off for an ordinary tester.
- Failed-board idle rule: reload a tab that was closed while old failures sat on
  the board (silent), then a genuinely new failure (alerts, dated about now).
- Real Tampermonkey/Windows desktop notifications and background-tab recovery.

## Historical fixture evidence

The figures below were recorded in earlier local-development notes. They
have not been rerun or independently reverified during the 2.0.1 integration.
Those older builds predate the current map, Ramses adapter, direct TestView
resolver and row-only controls. They must not be cited as a passing 2.0.1 gate.

| Historical build / run | Recorded outcome |
|---|---|
| Original SLT baseline, Chromium 151 | 139 tests: 136 passed, 3 popup-fixture failures |
| Local 1.1.0 combined suite | 201 tests: 198 passed, same 3 failures |
| Local 1.1.0 Lion collector/UUT suites | 62/62 passed |
| Local 1.1.1 combined suite before final display edits | 218 tests: 215 passed, same 3 failures |
| Local 1.1.1 added Lion/UUT/loading/control tests | 79/79 passed |
| Final local 1.1.1 loading/control follow-up | 17/17 passed |
| Local 1.1.1 Lion targeted mutations | 17 killed, 0 survived, 0 untested |
| Legacy SLT targeted mutations | 70 killed, 0 survived, 4 untested due to a failing cell-click baseline |

Historical Ctrl/Shift/middle-click failures navigated to browser error pages
instead of the routed detail fixture; an already failing baseline cannot kill
a mutant. These records describe partial evidence, not a fully green release.
Earlier screenshots used synthetic data and are not signed-in production QA.

## Access and source limits

Earlier cloud attempts to inspect internal pages and download the pinned
browser returned proxy HTTP 403. That history does not establish current
access. Source contracts now implemented from subsequent supplied evidence
are documented in [LION_KING_SOURCE_NOTES.md](LION_KING_SOURCE_NOTES.md);
neither screenshots nor an implementation prove live compatibility. Do not
store credentials, private production captures or real result exports in this
public repository.

Start future edits with [../AGENTS.md](../AGENTS.md), then read only the relevant
source anchors and tests. Record newly executed checks with their actual result
and build; do not carry forward these historical counts as current evidence.
