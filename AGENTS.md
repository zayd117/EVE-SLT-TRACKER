# EVE SLT+JBOG TRACKER: start here

> The current script is `EVE_SLT_TRACKER.user.js` (3.1.2, see `CHANGELOG-3.1.2.md`).
> This guide describes the legacy 2.0.2 script and its tests, which stay unchanged.

Current legacy version: **2.0.2**. Runtime: **`EVE_SLT_JBOG_TRACKER.user.js`**.
One self-contained Tampermonkey IIFE; no runtime build or npm dependencies.
`main` is the install/update channel. Node/Playwright files are development only.

Read this guide first, then use the task map below to read the relevant
functions and documentation. Do not rescan the whole repository or load all
docs for a small change. Search function names with `rg -n`; line numbers drift.

Before any coding task (write, fix, refactor, review), apply the ponytail
rules in `.claude/skills/ponytail/SKILL.md` (Claude: invoke the `ponytail`
skill). This guide and the user's current instructions win where they conflict.

## Editing and delivery

- Honor the user's current scope and authorization. A request to commit,
  push or merge is sufficient authorization; no special SUBMIT phrase is needed.
  Create release tags only when requested. Preserve unrelated local work.
- For runtime changes, bump both `@version` and the `SCRIPT_VERSION` fallback,
  package metadata and the top CHANGELOG entry together (CI requires an
  increase on pull requests). Docs/tests-only edits need no runtime bump.
- Keep branding **EVE SLT+JBOG TRACKER** in the header, panel, logs and current
  guides. The canonical filename is `EVE_SLT_JBOG_TRACKER.user.js`; keep install,
  update and download URLs free of spaces and encoded `+` characters.
- `EVE SLT+JBOG TRACKER.user.js` is a compatibility copy for already-installed
  update URLs. Edit the canonical file, then copy it to that legacy path.
  Both files must remain identical; the release helper synchronizes them.
- Keep the distributed JS plain ASCII; use JS Unicode escapes for UI symbols.
  Preserve existing storage keys, DOM IDs, locks and migration revisions.
  The displayed release version is separate from persisted schema versions.
- Do not add credentials, real unit/ticket data or production exports to Git.
  Fixture identities are synthetic. Inspection helpers are developer tools,
  not runtime dependencies or commands to run during an ordinary code edit.
  One owner-approved exception (zay, 2026-10-13): the real fixture serials of
  rows B6/B7 ship in `LION_DEFAULT_FIXTURES`. Tests still use synthetic serials
  only (`tests/harness/fixtures.mjs` swaps the table). Add no other real data.
- 2.0.1 shipped without test execution at the user's request. 2.0.2 ran the
  fixture suites; actual results are in `docs/LION_KING_QA.md`. Follow
  `docs/TESTING.md` for coverage and report unrun checks plainly.
- Update this guide and the affected deeper notes when a contract changes.
  Document behavior, invariants and entry points instead of chat transcripts.

## Profiles and contracts

| Profile | Source / result evidence |
|---|---|
| SLT | `/out/out.eveslt.php`; colors trigger a candidate, detail page confirms phase/result |
| Lion collector | `/out/out.evelionking_all.php`; same tail/head/Started observed RUNNING then PASS/FAIL |
| Lion Ramses | dashboard `?dashboard=jbog`; running/PRETEST tables, failed-board episodes, validated MPY passed CSV |
| TestView helper | `/slt/list` or `/uut/gpu_jbog_test/list`; navigation handoffs, not tracker sources |

- Never infer completion from disappearance, elapsed time, ETA, row number,
  cache content or a partially loaded table. Keep usable observations through
  source failure; quarantine malformed/conflicting identities.
- SLT SYS_DEKIT is diagnostic. Detail-confirmed SLT PRETEST and TEST failure
  handling must remain separate; retain failure-specific Jira behavior.
- Ramses failed-board entries carry no test Started/Finished. Preserve their
  operation; PRETEST maps to `GPU_JBOG_TEST_PRETEST`. Existing membership is
  baselined quietly, including v1-to-v2 PRETEST migration. An entry new to the
  saved state whose Idle Time is over 15 min (`LION_FAILURE_FRESH_MS`,
  `lionIdleMs`) settles silently: no card, no notification. A fresher one alerts
  with `ts = now - idle` (`timeSource: 'source-idle'`); an unreadable idle time
  alerts as before. The log `iso` stays the detection time (the log merge
  filters on it). Idle Time = time since the JBOG landed on the board is an
  unverified assumption. Passes are unchanged.
- Fixture mapping: a rack position is anchored by its fixtures
  (`LION_DEFAULT_FIXTURES`, shipped; a per-PC override lives in
  `eveLionRackFixtureRegistryV1`); the JBOG on it is resolved from TestView
  records into `eveLionRackOccupancyV1`, tied to the slot `rev`. Only an active
  test or an operator confirmation fills a slot; history, an outage or a
  timeout never clears one. Slot words: Occupied / Waiting for new / Empty /
  No fixture. Changing fixtures needs the Dev box (`eveLionRackDevV1`, per-tab
  sessionStorage). A saved registry without `LION_FIXTURE_MAP_REVISION` is
  ignored once on mapped racks. E2/E4/BL has no built-in fixtures yet.
- Persist the audit record before event claims/acknowledgment. Storage failure
  retries the same event. Claims and locks deduplicate across tabs.
- Lion defaults: B6, B7, E2/E4/BL and Unassigned are off on one-time migration.
  Row Enabled couples visibility, expansion and notifications; later choices
  persist. No individual rack/slot enable controls. Muted areas still log.
- Locations come from scanned assignments. Registry row membership/order is
  explicit: do not sort by barcode or move TA.B7-EVE05 out of B6 / TA.B6-EVE05
  out of B7. Slot indices remain 0 top, 1 bottom, 2 left, 3 right.
- Rack mini cards use top / left-right / bottom; B6 blue, B7 green, E2 purple.
  B6/B7 share horizontal scroll, E2 scrolls independently. Map refits viewport
  on browser resize; opening it hides tracker/alerts until return.
- Lion Jira always opens serial JQL ordered `updated DESC`, even with a cached
  key. API/cache lookup can label a ticket but must not bypass that search.
- Lion TestView resolves exact serial/operation, plus Started when available,
  then verifies the candidate by ID. Never guess IDs or substitute a newer
  run. GPU and PRETEST operations stay distinct; failure leaves a list fallback.

## Targeted change map

| Change | Runtime anchors | Read next |
|---|---|---|
| Startup/profile/loading | `bootstrap`, `initialize`, `initializeLionKing`, `IS_LION_KING_PAGE` | CODE_NOTES: startup / source profiles |
| SLT detection/refresh | `scan`, `confirmPhase`, `performSoftRefresh`, `withoutObserver` | CODE_NOTES: SLT / refresh; TESTING suite map |
| Lion source/result parsing | `getLionKingSnapshot`, `getRamsesSnapshot`, `getRamsesFailedBoard`, `parseRamsesCSV`, `pollRamsesPassedCSV` | LION_KING_SOURCE_NOTES |
| Lion events/persistence | `scanLionKing`, `scanRamsesFailedBoard`, `syncRamsesPassedCards`, `emitLionKingCompletion` | CODE_NOTES: Lion event state |
| Rack assignment/map/resize | `LION_RACK_ROWS`, `assignLionRackSlot`, `clearLionRackSlot`, `renderLionRackSlot`, `refreshLionRackBoard`, `fitLionRackWindow` | CODE_NOTES: rack board |
| Rack scan-to-find / header status chips | `locateLionRack`, `lionRackRollup`, `lionRackSlotState`, `mountLionRackBoard` | CODE_NOTES: rack board; lionking-rackscan test |
| Fixture map / Dev gate / per-PC override | `LION_DEFAULT_FIXTURES`, `normalizeLionFixtureRegistry`, `lionSlotIdentities`, `lionRackSlotView`, `lionFixtureState`, `resolveLionSlot`, `setLionFixture`, `lionDevLocked`, `lionRouteScan`, `renderLionFixtureSetup` | CODE_NOTES: fixture mapping; lionking-fixtures / fixture-defaults tests |
| Failed-board alert time / idle rule | `scanRamsesFailedBoard`, `lionIdleMs`, `emitLionKingCompletion`, `updateLionRackSeenTimes` | CODE_NOTES: Lion event state; lionking-ramses tests |
| Row enable/area location | `lionAreaSettings`, `lionRowPreference`, `setLionKingAreas`, `renderLionRackWorkControls`, `lionAreaForRow` | CODE_NOTES: work controls |
| Jira navigation/cards | `jiraListUrl`, `jiraFoundUrl`, `resolveJiraUrl`, `syncJiraForCard`, `openLionRackJira` | CODE_NOTES: Jira; jira/jiraux tests |
| TestView navigation | `lookupLionKingDirect`, `lookupLionKingDetail`, `openLionKingTestView`, `openTestView` | SOURCE_NOTES; testview / lionking-testview tests |
| Alerts/filters/timestamps | `renderAlertElement`, `applyAlertFilter`, `refreshRelativeTimes`, `lionRackTimestampMarkup` | CODE_NOTES: UI; ui tests |
| Shift/export/dedup/wake | `appendAlertLog`, `flushAlertLog`, `checkLogShiftRollover`, `buildLionKingLog`, `startMasterTick` | CODE_NOTES; shiftlog/dedupe/keepawake tests |

Docs paths above are under `docs/`. `README.md` is the user guide;
`docs/TESTING.md` maps fixtures and commands; `docs/LION_KING_QA.md` separates
historical evidence from current unverified behavior. Planning files describe
implemented decisions and remaining work, not additional startup requirements.

## Local commands (when checks are authorized)

Node 20+; `npm ci`; `npx playwright install chromium` once, or set
`EVE_CHROMIUM` to an installed browser. `npm run check`, `npm test`,
`npm run test:lionking` and targeted mutation commands are described in
`docs/TESTING.md`. Internal signed-in pages and Windows/Tampermonkey behavior
require manual validation; fixture tests cannot prove those work.
