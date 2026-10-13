# Testing EVE SLT+JBOG TRACKER

Current install: [`EVE_SLT_JBOG_TRACKER.user.js`](../EVE_SLT_JBOG_TRACKER.user.js), version **2.0.1**.
Read [AGENTS.md](../AGENTS.md) before investigating a failure; use
[CODE_NOTES.md](CODE_NOTES.md) to locate the relevant function. Historical Lion
QA notes describe earlier revisions, not evidence that this version passed.

## Status and execution policy

This integration updates fixtures, tooling paths and documentation to the
combined tracker. No local suites, mutation runners, syntax checks, lint or
browser checks were executed for this update, per the user's instruction.
Do not claim 2.0.1 is tested or copy earlier pass counts into a release report.
Keep this version at 2.0.1 unless the user authorizes a later release.

The commands below are a reference for a future authorized test run. A source
read is not a test result. Tests run against synthetic pages and APIs; they
cannot establish that an internal production service or login still works.

## Tooling and commands

Node 20+ and Playwright 1.56.1 are declared in package.json. CI uses Node 20 for
metadata and Node 22 for browser suites. The repository's push/PR workflow runs
its checks and fixture suite; the tag workflow publishes the userscript asset.
Mutation runs are separate from CI.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:static
npm run test:unit
npm run test:browser
npm run test:mutation
npm run test:lionking
npm run test:lionking:mutation
npm run test:ramses
npm run test:ramses:mutation
```

`test:browser` and `test:lionking` include collector, loading, controls,
resilience, direct TestView and Ramses suites. The Lion mutation command includes
collector, direct TestView, controls/loading, resilience and Ramses runners.
Use one suite when it addresses the change:

```sh
node --test --test-concurrency=1 tests/lionking-controls.test.mjs
node --test --test-concurrency=1 tests/lionking-ramses.test.mjs
node tests/lionking-ramses.mutation.mjs
EVE_CHROMIUM=/usr/bin/chromium npm run test:lionking
EVE_SCRIPT="/tmp/candidate.user.js" node --test tests/lionking-controls.test.mjs
```

The canonical install filename is ASCII without spaces or `+`. `EVE_SCRIPT`
selects an immutable candidate copy for the harness. Mutation runners read the
canonical source, create temporary copies and leave the checkout unchanged.
A failed original baseline, invalid mutant or missing source anchor is
**not tested**, never a killed mutant. Update exact anchors and selected test
names when changing the matching function or test.

## Harness contract

`tests/harness/userscript.mjs` injects the real userscript at document start in
an isolated Chromium world. The sandbox window is a proxy, so it catches the
historic `MouseEvent({view: window})` failure. GM storage, requests, notifications
and navigation are recorded. `tests/harness/server.mjs` routes requests to local
fixtures; unexpected requests are retained in `server.unrouted`. There are no
real Jira/TestView credentials and no changes to production services.

`instrument()` exposes selected functions as `__eve` in an in-memory copy.
Update `HOOK_NAMES` only when a named internal function changes. Its terminal
`bootstrap();` anchor must remain unique. `tests/harness/lion.mjs` explicitly
seeds enabled Lion rows and Dev controls for completion/source fixtures.
That fixture opt-in does not change the installed default: all four Lion groups
start disabled. Controls tests exercise the unseeded default and migration.

Tests model both collector (`out.evelionking_all.php`) and Streamlit Ramses
(`?dashboard=jbog`) profiles. SLT settings and state use the existing
`eveRackTracker...` keys; Lion uses `lionKingTracker...`. The physical board is
shared under `eveLionRackBoardV1`. Branding/filename changes must not rename
these keys or erase saved assignments.

## Suites by behavior

| Files | Main contracts |
| --- | --- |
| `static.test.mjs` | Syntax, metadata/grants/hosts, ASCII distribution, matching header/fallback/package/changelog version, current AI guides/function anchors, credentials and sandbox-window guard |
| `logic.test.mjs` | Transition/phase parsing, dates/time, Jira response parsing, URL/escaping, shifts and dedupe helpers |
| `rack.test.mjs`, `cellclick.test.mjs`, `dedupe.test.mjs` | SLT baseline/transitions, swaps/retests, independent tabs/copies, click targets, no duplicate audit/toast |
| `testview.test.mjs` | Existing SLT list/API handoff and controlled form behavior; SLT uses a separate API from JBOGs |
| `jira.test.mjs`, `jiraux.test.mjs` | SLT ticket/pending/login/pass states, badges/acknowledgement, retest status, no-ticket instructions, removed-slot/copy behavior |
| `ui.test.mjs`, `keepawake.test.mjs`, `stability.test.mjs` | Panel/filter/Dev controls, refresh recovery, wake resources, bounded state and malformed storage |
| `timezone.test.mjs`, `shiftlog.test.mjs` | Pacific source/display times, browser timezone independence, shift boundaries, CSV/text exports and rollover |
| `lionking.test.mjs` | Five-column collector, exact status/color/date evidence, pairing/run identity, display history, quiet baselines, observed completions, averages, source refresh and profile isolation |
| `lionking-loading.test.mjs` | Early controls during streamed parsing, no partial baselines or events, saved RUNNING preservation, completed-source BLIND health |
| `lionking-controls.test.mjs` | B6/B7/E2-E4-BL/Unassigned default off, linked visibility/notification preference, row arrow/Enabled sync, no per-rack toggles, bulk controls, normalized/conflicting assignments, audit while disabled, Dev synthetic cards |
| `lionking-resilience.test.mjs` | Row quarantine, conflicting duplicates, valid completions beside bad rows, last-good stale display cache, origin/schema/text safety and recovery |
| `lionking-ramses.test.mjs` | Native running/failed boards, PRETEST states and separate PRETEST_FAILURE alerts, failed-membership episodes, passed-result CSV/MPY discovery and silent historical PASS cards, ambiguous/stale-source safety, serial Jira queries ordered by updated DESC |
| `lionking-testview.test.mjs` | Direct UUT API resolution with serial/operation/Started and by-ID validation; authenticated-origin retry; useful fallback; no SN typing/Query clicks |
| `mutation.mjs`, `lionking*.mutation.mjs` | Targeted faults with immutable candidates and exact original baselines; mutation results require the selected original tests to pass first |

## Changes that deserve focused coverage

| Change | Start with |
| --- | --- |
| SLT phase/result logic | `logic`, `rack`, `dedupe`, `jira` |
| Jira URL/cache/click behavior | `jira`, `jiraux`; `lionking-ramses` for JBOG latest-serial queries |
| Lion parser/identity/history | `lionking`, `lionking-resilience`, collector mutation runner |
| Early bootstrap or cached view | `lionking-loading`, `lionking-resilience`, controls/resilience mutation runners |
| Ramses evidence/source discovery | `lionking-ramses` and its mutation runner |
| Row enabling, layout or assignments | `lionking-controls`, `lionking-ramses`, then the manual rack-map checks below |
| JBOG TestView operation/attempt | `lionking-testview` and its mutation runner |
| Time/shift/export | `timezone`, `shiftlog`, `logic` |
| Header/name/path/version | `static`; check package scripts and both workflow SCRIPT variables |

Broaden a future authorized run when a focused failure, changed shared helper
or uncovered behavior warrants it. Do not run the entire suite repeatedly for
an unrelated documentation edit.

## Manual production checks still needed

These require a signed-in browser and the real page. Record the actual result
and revision; do not infer success from fixtures.

- At 100% zoom, open Rack Map from Tracker Controls. The map fills the viewport
  and hides tracker/alerts; Back restores them. Resize down and restore the
  browser: the map must fill the current viewport again.
- Every row starts off on new/migrated preferences. One row-level Enabled
  switch and its arrow both open/close that row and enable/mute its alerts.
  Individual racks have no Enabled switch. Other rows remain independent.
- B6 and B7 stay adjacent: B6 blue, B7 green; E2/E4/BL purple. One horizontal
  scrollbar moves B6 and B7 together; E2/E4/BL scrolls independently.
- Verify physical left-to-right rack order against [LION_KING_NEXT_STAGE.md](LION_KING_NEXT_STAGE.md),
  including the B7-prefixed rack physically in B6 and B6-prefixed rack in B7.
  Slots retain top / left-right / bottom arrangement and compact timestamps.
- Click a slot, scan one serial and confirm source/API details populate without
  manual rack/position entry. Jira/TestView buttons stay near that slot. Its
  small × clears serial and partner immediately; a stale remove click cannot
  clear a new assignment. Reload and another tab retain shared assignments.
- Running/PRETEST boxes use readable light text on the medium green background;
  passed boxes are dark green, GPU failures red, PRETEST failures darker red.
- Jira opens the serial query sorted by `updated DESC`, even with an old known
  issue key. No-key/auth fallback retains serial and query order. Jira reads
  existing browser login; no token is embedded. SLT's existing failure-window
  and direct-ticket behavior is a separate contract.
- GPU failures and PRETEST failures have separate filters/counts. Upgrade a
  saved failed-board v1 state quietly; its existing PRETEST entries must not
  flood alerts. A newly observed PRETEST membership alerts as PRETEST_FAILURE,
  with no invented Started time.
- TestView goes to a validated numeric detail ID for the requested serial,
  operation and attempt. PRETEST requests use GPU_JBOG_TEST_PRETEST. With an
  expired login or no valid result, retain a useful signed-in-origin retry or
  fallback; do not type into the SN input or click Query.
- Streamlit/collector response structure, timezone, login expiry, native refresh
  and current MPY payload selection must match actual production behavior.
  Removing a running row or merely displaying Online cannot prove PASS.
- Only main controls, Rack Map, groups, auto refresh and log shift remain visible
  outside Dev mode. Jira/source/diagnostic/area-only details require Dev.

## Release contract

The integration stays **2.0.1** by explicit user request. Header, fallback,
package metadata and top changelog entry must agree. Tampermonkey normally
requires a greater version to offer an automatic update; a same-version
integration may need manual reinstall. Do not bump it during cleanup.

For a later authorized release, `scripts/release.sh patch "summary"` requires
clean `main`, updates all version fields and changelog, checks metadata, commits,
tags and pushes. It is a publishing action, not a routine docs command. The
PR guard compares versions using Git argument arrays rather than a shell command.
Current workflows publish `EVE_SLT_JBOG_TRACKER.user.js`; update/download URLs
use that same simple filename. The old `EVE SLT+JBOG TRACKER.user.js` path is
an identical compatibility copy, synchronized by the release helper; keep it
in sync after runtime edits. Keep old storage names for migration.
