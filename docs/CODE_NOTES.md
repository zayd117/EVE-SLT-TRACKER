# Code notes — EVE SLT+JBOG TRACKER 2.0.2

Canonical runtime: `EVE_SLT_JBOG_TRACKER.user.js`, one self-contained Tampermonkey
IIFE. No build output or backend is needed. Use function names below as search
anchors; line numbers and old file names are not stable. For the shortest working
handoff, start with [../AGENTS.md](../AGENTS.md), then open only the relevant
functions. [TESTING.md](TESTING.md) records verification guidance and limits.

## Runtime dispatch and edit map

| Change | Start with these anchors |
| --- | --- |
| Profile dispatch / startup | `bootstrap`, `initialize`, `initializeLionKing`, `IS_LION_RAMSES_PAGE`, `IS_LION_KING_PAGE` |
| SLT discovery / results | `getEveTableGroups`, `scan`, `processSlot`, `getTransitionType`, `confirmPhase`, `parseDetailDocument` |
| Collector Lion rows | `getLionKingSnapshot`, `normalizeLionKingStatus`, `lionStartedAt`, `scanLionKing` |
| Ramses running / failures / passes | `getRamsesSnapshot`, `getRamsesFailedBoard`, `scanRamsesFailedBoard`, `parseRamsesCSV`, `syncRamsesPassedCards` |
| Durable Lion events | `emitLionKingCompletion`, `loadRamsesFailedState`, `loadRamsesPassCardState` |
| Physical map / scan / remove | `LION_RACK_ROWS`, `normalizeLionRackBoard`, `assignLionRackSlot`, `clearLionRackSlot`, `renderLionRackSlot`, `mountLionRackBoard` |
| Row controls / location | `lionAreaForRow`, `lionAreaSettings`, `updateLionAreaEnabled`, `lionRowPreference` |
| Map geometry / scroll | `fitLionRackWindow`, `saveLionRackWindow`, `updateLionRackPairedScroll`, `refreshLionRackBoard` |
| Lion TestView | `lookupLionKingDirect`, `lookupLionKingDetail`, `openLionKingTestView`, `runLionKingTestViewAutoQuery` |
| SLT TestView | `openTestView`, `lookupTestViewDetailId`, `runTestViewAutoQuery`, `submitTestViewQuery` |
| Jira links / cached lookup | `jiraListUrl`, `jiraFoundUrl`, `resolveJiraListUrl`, `syncJiraForCard`, `openLionRackJira`, `openNotificationTarget` |
| Alerts / filters / exports | `renderAlertElement`, `applyAlertFilter`, `buildLionKingLog`, `buildAlertLogText`, `buildAlertLogCsv` |
| Panel / Dev controls / shared CSS | `buildTrackerPanelMarkup`, `wireDeveloperMode`, `injectCSS`, `initializeLionKing` |
| Refresh / sleep / health | `performSoftRefresh`, `refreshLionKing`, `observePage`, `reportHealth`, `startMasterTick`, `wireSleepDetection` |

`bootstrap` selects exactly one path: SLT monitor on `/out/out.eveslt.php`,
Lion monitor on `/out/out.evelionking_all.php` or the Ramses root with
`?dashboard=jbog`, or a TestView handoff helper on its supported list route.
Other Ramses dashboard types stay idle. TestView host validation precedes API
or handoff use; a matching path on another host is insufficient.

## State compatibility

Branding is **EVE SLT+JBOG TRACKER** and metadata/fallback version is **2.0.2**.
That display version is independent of storage schema revisions.

`trackerStorageKey` preserves SLT `eveRackTracker*` keys and selects isolated
`lionKingTracker*` keys for Lion settings, baselines, cards, logs, claims and
window positions. Do not rename these when changing display names or filenames.
Session storage holds baselines/cards/cooldowns and Jira cache; local storage
holds shift audit logs and durable Lion delivery state. Read/write helpers catch
storage errors; shape guards remain the responsibility of each loader.

The physical registry key is `eveLionRackBoardV1`, shared through GM storage
with local-storage fallback. Board schema stays `version: 1`,
`layoutRevision: 2`, `workRevision: 1`; settings use `lionRowWorkRevision: 1`.
GM sharing applies to this browser/userscript installation, not every operator's
PC. Rack backup/restore provides transfer. `lionKingTrackerRackBoardWindow`
now saves only map-open state and `layout: 'viewport-fit-v1'`, not pixel geometry.

Preserve assignment serial/partner pairs and pending delivery intent during
migrations. Corrupt state must not make startup fail. Never store passwords,
authentication cookies, access tokens or API keys; requests reuse browser login.

## SLT rules that must survive shared changes

- Rack identity is section/rack/unit plus serial. A new slot or replacement
  serial establishes a silent baseline. Color alone does not establish phase.
- `getTransitionType` recognizes red after lightblue/lightgreen/**darkgreen**,
  and darkgreen after lightgreen. Do not narrow failures to active green only.
- `parseDetailDocument` / `confirmPhase` determine phase and result from the
  unit's own details and check location agreement. PRETEST, TEST and DEKIT remain
  distinct; DEKIT/debug visibility is gated by Dev mode. A provisional failure
  is not rewritten as a pass because a later detail view shows PASS.
- `processSlot` records real events even when section notifications are muted.
  Flap protection and cross-tab event claims suppress duplicate toasts/logs.
  Confirmation can correct persisted cards and audit records after detection.
- Prune only after a credible scan. Partial or unreadable data must not wipe
  baselines. Health distinguishes unavailable/stale evidence from quiet success.
- `performSoftRefresh` requires fetched collector HTML with real EVE tables,
  same-page redirects and successful status before swapping. `swapEveTables`
  disconnects observation and invalidates header caches; its body fallback keeps
  tracker UI and skips incoming script tags. `afterSwap` restores observation,
  controls and visibility. The watchdog aborts the actual fetch before allowing
  another. Transient network/5xx failures keep the readable old page and retry;
  session/schema failures take the existing persisted full-reload fallback.
  Refresh/resume must not replay history.
- SLT TestView keeps the SLT API/detail routes and its existing UI-query fallback.
  Its API lookup matches the exact server serial; Lion must not enter this path.
- Existing SLT Jira timing/created-window lookup and ticket guidance remain SLT
  behavior. Lion's serial search is separate; do not impose SLT wait/PuTTY rules
  on a JBOG result.

## Lion result authority and event delivery

Collector rows use TailNode + HeadNode + Started as identity. `JBOG_NUM` is a
changing list ordinal, never a physical location or run ID. Full recognized
status/color evidence determines RUNNING/PASS/FAIL; conflicting/unknown evidence
stays unknown. A first terminal observation is a quiet baseline; a previously
observed RUNNING attempt reaching PASS/FAIL can alert. Invalid individual rows
are quarantined while usable rows continue; missing/ambiguous sources retain
prior observations. The local snapshot cache is a labelled display aid, not
fresh completion evidence or a smaller network response.

Ramses has separate authorities:

- Running table: exact supported headers/operations and validated start times.
- Failed board: one current visible `JBOG Failed Test` card, complete rows and
  count agreement. Membership is keyed by serial + operation with durable
  episodes. New membership is evidence of a failed-board entry, **not** an exact
  attempt start or UUT detail ID. Disappearance alone never establishes PASS.
- Passed data: `pollRamsesPassedCSV` automatically reads the current MPY
  `(PASSED JBOGS)` download source without triggering a file download. Supported
  sources are approved data URLs (including base64), same-origin blobs/media.
  Current visible anchors are required; identical duplicates collapse to one,
  distinct sources stay ambiguous. Recheck the source after asynchronous reads.

`parseRamsesCSV` requires `uut_sn`, `Start Time`, `Finish Time`, `PASSED`,
`Attempt`, `FPY_Stat`, bounded valid fields and consistent duplicate runs.
**PASSED=1** establishes PASS. FPY can say Fail/Retest on a passed run and is not
its outcome. Invalid/conflicting CSV preserves the last validated data.
Timestamp precision is retained; a minute-resolution CSV cannot silently bind
to a different attempt. PASS duration is finish minus start, not FPY or idle.

Failures use `TEST_FAILURE` versus `PRETEST_FAILURE`; PRETEST is recognized as
`PRETEST` or `GPU_JBOG_TEST_PRETEST`. Titles, filters and counts remain separate.
Failed-board state accepts v1/v2; v1→v2 quietly baselines existing PRETEST members
while retaining GPU episodes and pending events. This prevents an upgrade flood.
Initial MPY history can supply quiet cards/logs; subsequent validated new passes
follow saved delivery intent. Do not describe all historical PASS cards as
fresh notifications.

`emitLionKingCompletion` must persist/confirm the audit record **before** its
claim or completed baseline. Storage failures leave intent pending for retry.
Web Locks serialize deliveries across tabs where supported. Claims and audit
matching prevent repeat events. Hidden/muted areas continue observation and
logging; their row `watch` state controls surfacing cards/toasts.

## Physical rack map and compact UX

The authoritative row order is `LION_RACK_ROWS` (5/5/11 racks); physical row
membership takes precedence over barcode prefix. B6 contains `TA.B7-EVE05`;
B7 contains `TA.B6-EVE05`. Never sort racks or infer row membership by prefix.
[LION_KING_NEXT_STAGE.md](LION_KING_NEXT_STAGE.md) lists the exact order.

The zero-based slot identity is 0 top, 1 bottom, 2 left, 3 right. Render the
physical cross as top / left+right / bottom; keep these identities during layout
edits, drag/drop or compact CSS changes. Click a slot, scan one serial, Enter
saves. Lookup can fill a verified partner and source info; conflicting node
placements stay Unassigned. A source sort/retest never moves scanned hardware.

Only B6, B7, E2/E4/BL and Unassigned are enableable. No rack/slot has its own
live toggle. `lionAreaSettings` couples show/watch, and the row arrow and Enabled
switch edit that same persisted flag. Default/migrated rows start off once;
later user choices persist. Off means collapsed/hidden and notifications muted.
Legacy child work preferences can remain in storage but do not drive visibility.

B6 uses blue, B7 teal/green, E2/E4/BL purple. Running/pretest mini cards use a
medium light green (`#4a7858`) with light text; PASS uses dark green, TEST FAIL
red, PRETEST FAIL darker red. Mini cards include timestamps and Jira/TestView
buttons. Running ETA is advisory and cannot establish completion.

Occupied slots have a small ×. `clearLionRackSlot` rereads the registry and
checks `expectedSerial`; a stale rendered remove action cannot clear a newer
assignment. It clears the selected serial/partner and same-slot drawer state.
Link/remove clicks must stop propagation before generic slot selection/drag.

B6/B7 share one horizontal control; E2/E4/BL has independent scroll. Map open
hides tracker/alerts and Back restores them. The map starts closed: only a saved
`open: true` in `lionKingTrackerRackBoardWindow` (written by `saveLionRackWindow`
when the user opens it) reopens it on load.
`locateLionRack` (title-bar scan box, Enter submits, input always cleared) finds
a rack by `lionRackBarcode` or a slot by tail/head serial in `lionRackBoard.slots`,
refuses a disabled row with a message instead of enabling it (row Enabled also
controls notifications), and highlights with a transient `is-found` class.
`lionRackSlotState` is the single state source for slot cards, `lionRackRollup`
header chips (fail, check, run, pass order) and the scan summary; disabled rows
render no chips. Main Lion controls stay compact;
Jira/source/history/registry diagnostics remain behind Dev mode.
`fitLionRackWindow` reapplies viewport-relative width/height and margins on
resize. Never save a temporary smaller browser size as permanent map geometry.

## Navigation, timestamps and integration limits

Lion Jira clicks use `jiraListUrl(serial, 'updated', key)` and
`ORDER BY updated DESC`, not a bare cached issue URL. A validated known key
allows `/browse/<key>?jql=...`; otherwise use `/issues/?jql=...`. Cached keys are
context, not proof that the ticket is the newest. Keep the serial in the query.
Rack, drawer, card and toast surfaces must preserve this search behavior.

Lion TestView resolves the supported UUT list API, selects exact `uut_sn`,
operation and optional Started, then validates the candidate through `by_id`
before opening `/uut/detail/<id>`. A `fixture_sn` match alone is insufficient.
PRETEST must use `GPU_JBOG_TEST_PRETEST`; main tests use `GPU_JBOG_TEST`.
For a card with Started, bounded API history searches that exact attempt; no
Started allows the latest uniquely identifiable matching run. No guessed ID,
SLT endpoint, typing or auto-clicking Query is used by the Lion helper. Failure
leaves a helpful list-page banner. Respect user takeover and reserve a blank
popup before async lookup to avoid losing the original click gesture.

`siteTimeToMs` / `lionStartedAt` interpret source wall times in
`America/Los_Angeles` including date-specific DST; host timezone is not source
timezone. Alert source finish time and detection time are separate. Shift logs
follow Pacific shift windows (including midnight-spanning shifts), not UTC dates.
Real events survive mute settings; synthetic debug events never enter the audit.

Use `safeUrl` for persisted/opened links, `escapeHtml` for markup and `csvEscape`
for exported fields. UI nodes are excluded from source discovery/observation.
Bound caches, cards and records; avoid new per-card polling that multiplies
requests. Live authentication, Windows notifications and real native dashboard
refresh still require the operator's signed-in browser; documentation is not a
claim that those checks ran in the cloud environment.

## Keep-awake behavior

`startTicker` prefers a one-second Worker tick and falls back once to a page
interval if unavailable/blocked/silent. Shared Web Lock is a best-effort
anti-suspension measure; screen Wake Lock applies only while visible and is
reacquired after visibility/resume. HTTP/insecure pages can lack these APIs.
These mechanisms cannot make a sleeping PC execute JavaScript.

`writeHeartbeat`, freeze/resume/discard handling and tick-gap detection preserve
baselines/logs and catch up quietly. `noteWake` triggers source refresh where
appropriate without an extra user banner/toast; do not add wake notifications
that confuse resumed monitoring with a new result. Dev status reports actual
lock/ticker/sleep state rather than claiming the browser cannot suspend a tab.

The earlier verbose design notes are recoverable in Git history (historical
SLT baseline `74c86ef`); current anchors and code take precedence over old
release prose. Do not restore obsolete transition lists or collector-only
Lion plans from that history.
