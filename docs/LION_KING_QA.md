# EVE SLT+JBOG TRACKER 2.0.1: validation status

Installable file: `EVE_SLT_JBOG_TRACKER.user.js`. Current version: **2.0.1**.
The current integration includes the combined source, rack map, Jira serial
search fix, revised development tooling and documentation. **No tests, syntax
checks, browser checks or verification commands were run for this integration,**
following the user's instruction. Editing tests is not evidence they passed.

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
