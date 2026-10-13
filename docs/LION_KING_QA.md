# EVE SLT+JBOG TRACKER 2.0.2: validation status

Installable file: `EVE_SLT_JBOG_TRACKER.user.js`. Current version: **2.0.2**.
2.0.2 adds the first-load Rack Map fix, a scan-to-find box and per-rack status
chips on top of the 2.0.1 integration, and is the first version with recorded
test results. Those results come from synthetic fixtures only.

## 2.0.2 executed checks

Cloud container, 2026-10-13, Node 22.22, Playwright 1.56.1, Chromium 141.0.7390.37.

| Check | Result |
|---|---|
| `npm run check` (syntax, header, `@version`) | pass; four deliberate "@match any host" warnings |
| Plain-ASCII check of the userscript | 0 non-ASCII lines |
| `npm test` (9 static, 18 unit, 250 browser tests, including 2 new rack-scan tests) | 277 run, 277 passed, 0 failed |
| Same browser suites on `main` at 58b6cbc, before this change | 248 run, 208 passed, 40 failed |
| Browser suites with only the first-load Rack Map fix | 248 run, 241 passed, 7 failed (the 7 are fixed in 2.0.2) |
| Lion mutation runners (`npm run test:lionking:mutation`, each runner started separately because the first one exits non-zero when anything is not tested) | 27 killed, 1 survived, 5 not tested of 33 mutants |
| New tests against four deliberate bugs (first-load default, worst-state order, partner serial lookup, disabled-row check) | 4 of 4 caught |

The 40 failures on `main` were mostly one bug: with no saved window state the
Rack Map opened on first load and hid the tracker panel. The other failures were
test or harness drift, not product defects: storage re-seeded in every new tab,
an out-of-date export filename, a Dev-only control tested while hidden, an
over-broad file-input selector, and Ctrl/Shift/middle-click tests that asserted
where Chromium lands a fixture-routed new tab.

Mutation detail: collector 7 killed, 3 not tested; direct TestView 4 killed;
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
