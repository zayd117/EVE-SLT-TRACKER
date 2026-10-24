# EVE SLT+JBOG TRACKER

> **Current script: EVE SLT TRACKER 3.1.2.** Install
> [EVE_SLT_TRACKER.user.js](<EVE_SLT_TRACKER.user.js>)
> ([install link](https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_TRACKER.user.js)).
> It covers EVE SLT racks, the TestView live dashboard, Jira, Send to Repair via
> SFCS and Bulk PRETEST; Lion King, Ramses and JBOG monitoring were removed. It
> uses the same browser storage keys. Disable the older "EVE SLT+JBOG TRACKER"
> copy in Tampermonkey so only one runs. What changed: [CHANGELOG-3.1.2.md](<CHANGELOG-3.1.2.md>).
> It was checked on a mock board only, not on the live sites. The sections below
> describe the legacy 2.0.2 script, kept in the repository unchanged with its tests.

**Version 2.0.2** · One Tampermonkey userscript for EVE SLT, the Lion King
collector and the Ramses JBOG dashboard. It selects its source from the page
being viewed and uses the browser's existing Jira and TestView logins.

Installable source: [EVE_SLT_JBOG_TRACKER.user.js](<EVE_SLT_JBOG_TRACKER.user.js>).
Users need only Tampermonkey and this file; Node and the repository tooling
are for development.

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/) for Edge, Chrome or Firefox.
2. Open the [userscript install link](https://raw.githubusercontent.com/zayd117/EVE-SLT-TRACKER/main/EVE_SLT_JBOG_TRACKER.user.js) and choose **Install** or **Update**.
3. Open or reload one of the supported pages below. Allow Jira and TestView
   connections when Tampermonkey requests them.

If the link shows code, open **Tampermonkey Dashboard → Utilities → Import
from URL**, paste the install link and choose **Install**. Automatic opening
of the installer depends on Tampermonkey being enabled and having site access.

Keep one enabled copy. If the renamed script installs beside an older copy,
disable the older copy in the Tampermonkey Dashboard. Existing storage keys
are preserved, including saved rack assignments and SLT state.

This update is **2.0.2**. Tampermonkey normally offers it as an automatic
update; otherwise open the install link or replace the editor contents with
the complete file.
The filename uses underscores for a simple install URL; the displayed name
remains **EVE SLT+JBOG TRACKER**. The previous filename is retained as an
identical compatibility copy for existing update URLs.

## Supported pages

| Page | What the tracker reads |
|---|---|
| EVE `/out/out.eveslt.php` | Rack-cell changes, confirmed against the server detail page |
| Lion King `/out/out.evelionking_all.php` | Tail/head node, Started and status rows |
| [Ramses JBOG dashboard](http://hyve-cmd101-ramses.hyvesolutions.org:8001/?dashboard=jbog) | Live running/PRETEST tables, failed board and available passed-result data |
| TestView `/slt/list` and `/uut/gpu_jbog_test/list` | Click handoffs to the appropriate test details |

Leave the source page open to monitor it. Each source uses its own settings,
observations, cards and logs; switching pages does not monitor a closed tab.

## Everyday use

The normal Lion King panel shows section controls, a prominent **Rack Map**
button, auto refresh and shift selection. Technical settings, source details,
monitoring diagnostics and synthetic notification tools are behind **Dev**.

- Enable only the areas you work on: **B6**, **B7**, **E2/E4/BL** or **Unassigned**.
- Each Lion King **Enabled** control combines visibility and notifications.
  Turning an area off collapses/hides it and silences its alerts. The arrow
  and switch represent the same saved state; individual racks have no toggle.
- Areas start **off** on first use of the row-control migration. Later choices
  are saved. **Enable all / Disable all** applies to the current Lion source.
- EVE SLT retains its separate **Show** and **Notifs** section controls.
- Click a card's serial to copy it, its **Jira** button for Jira, or the card
  body/**TestView** button for test details. The card's **×** dismisses the card;
  it does not delete its shift-log entry.

### Rack Map

1. Open **Rack Map**. It stays closed until you open it.
2. Enable a physical row, click its rack slot and scan the node serial.
3. The tracker saves the location and looks up available status, timing and
   linked test information. It does not require manual ticket or test IDs.
4. To find something later, scan into the box in the title bar (it is focused
   when the map opens). A rack barcode such as `TA.B6-EVE03` scrolls to and
   highlights that rack and lists how many of its servers are running, passed
   or failed; a tail or head serial highlights its rack slot. Each rack header
   also shows small count chips, with a colored underline for a failure or a
   location conflict. A rack in a disabled row shows no status; enable the
   row to see it (scanning the rack's own barcode turns its row on).
5. Racks of rows **B6** and **B7** are mapped by fixture. The script carries
   the fixture installed at each position (top, right, left, bottom), and the
   JBOG on a fixture is read from TestView test records, so a tester scans
   nothing. A mapped position shows its fixture serial and one state:
   **Occupied** (a JBOG is testing on it), **Waiting for new** (nothing is
   testing now; the last unit is history, not proof it is still plugged in),
   **Empty** (TestView has no test record for the fixture) or **No fixture**
   (the list leaves the position empty). Scanning a mapped rack lists all four
   positions with their fixture and state and looks the fixtures up at once;
   scanning a fixture serial finds its position. E2/E4/BL has no built-in
   fixtures yet.
6. Changing a fixture needs **Dev** (the board's **...** menu; it is per tab
   and off by default, so everyday testers cannot change the map). With Dev on,
   **Fixture setup** replaces, adds, moves or removes a fixture, marks a slot
   under maintenance and backs up the fixture list. A change stays on that PC
   until **Reset to built-in**; the scan box then also accepts a fixture serial
   and asks when it cannot tell a fixture from a JBOG.

Physical slots use the rack's cross layout:

```text
       top
left         right
      bottom
```

Each occupied slot has **Jira** and **TestView** buttons, compact timing
information and a small **×** to remove that assignment immediately. Empty
slots offer **Scan**. Removal clears the saved slot assignment, not source
records, Jira tickets or test results.

**B6** has a blue group background, **B7** green and **E2/E4/BL** purple.
B6 and B7 stay next to each other and use one horizontal scrollbar; E2/E4/BL
scrolls separately. Physical row membership and left-to-right order are fixed
by the supplied rack registry, even when a rack's barcode includes another
row name. The map fits the viewport again after the browser window changes
size. While it is open, the tracker and alert windows are hidden; **Back to
tracker** restores them.

| Mini-card color | Meaning |
|---|---|
| Medium light green with light text | Running test or PRETEST |
| Dark green | Passed |
| Red | Test fail |
| Darker red | PRETEST fail |
| Neutral | No current usable status |

Test fails and PRETEST fails have separate labels, counts and alert filters.
PRETEST is not treated as a completed GPU test.

### Jira and TestView links

**Lion King Jira** buttons open the serial's query results with
`ORDER BY updated DESC`, including when a ticket key is already cached.
A cached ticket is a search anchor, so a click still shows other, newer
matching issues. With no key, the Jira issue-search page opens. Jira lookup
uses the existing browser login and never creates or changes a ticket.

**EVE SLT Jira** retains its failure-specific ticket lookup, pending-ticket
states and PuTTY instructions when a ticket has not appeared. The tracker
checks TestView before prompting for a ticket while a server is re-testing.

**Lion King TestView** first queries the UUT API for the selected serial and
operation. When a card has a Started value, the matching run must have that
start time. The candidate is verified through `/api/v1/uut_status/view/<id>/by_id`
before `/uut/detail/<id>` opens. PRETEST maps to `GPU_JBOG_TEST_PRETEST`;
GPU tests map to `GPU_JBOG_TEST`. Failed lookup or verification leaves a list
fallback for manual selection rather than guessing a record ID or run.

## Detection and logs

- EVE SLT colors identify a possible transition; the detail page confirms the
  phase and result. SYS_DEKIT is diagnostic, not a hardware failure.
- The Lion collector establishes a quiet baseline for completed rows, then
  alerts on an observed RUNNING-to-PASS/FAIL change for the same tail/head
  serials and Started value. Loading fragments and saved snapshots do not
  establish new results.
- Ramses watches native table updates and reads the dashboard's available
  passed-result CSV data automatically. A result download or manual import
  is not required. It keeps running PRETEST, failed-board observations and
  validated GPU passes separate; a disappeared row alone is not a pass.
- The Ramses failed board tracks new entries after its baseline. It does not
  supply test Started or Finished times, but its **Idle Time** column dates an
  entry: one that is new to the saved state and idle for more than 15 minutes
  settles quietly (no card, no desktop notification), which stops a long-closed
  tab from replaying old failures. A fresher entry alerts with its time taken
  as now minus Idle Time, and an unreadable Idle Time alerts as before. Passed
  records use validated source Finished times.
- Hidden areas continue contributing audit observations/logs, but their
  cards and desktop notifications are suppressed. Polling can miss a run
  that starts and finishes entirely between usable observations.
- Malformed or conflicting rows are excluded with diagnostics; valid rows
  continue monitoring. A missing or entirely unusable source retains saved
  observations rather than inventing completion.
- The latest **50 alert cards** are retained. Shift-log exports can include
  older recorded events whose cards have aged out. Logs are bounded; export
  the shift you need rather than using browser storage as a permanent archive.
- **Log shift: Auto** uses the Day, Swing or Graveyard window, including the
  hour before the shift. TXT and CSV exports use Fremont/Pacific time.

Completed history defaults to **24 hours**, with 48 hours and All in Dev.
Active runs have no age limit. History changes affect display, not results.
Recent valid pass durations provide advisory ETAs; an ETA never marks a run
complete. The collector samples by Started time, while Ramses samples by
Finished time, over the latest 24 hours.

## Troubleshooting

| Symptom | Action |
|---|---|
| No Lion rows or alerts | Enable the relevant area; defaults are off. |
| Cards but no desktop notifications | Check the area setting, browser notification permission and Windows Do not disturb. |
| Jira lookup unavailable | Log into Jira in the same browser; the serial search remains available. |
| TestView stays on the list | Log into TestView and select the run manually if its identity could not be verified. |
| Loading or saved-data indication | Wait for a usable live source; saved rows are a dated display copy. |
| Rejected rows, BLIND or stale data | Enable Dev and use **Copy source diagnostics**. Preserve the source and error details when reporting the issue. |
| Storage error | Export the available shift log and free browser storage. Pending completions retry instead of acknowledging an unsaved log. |
| Another copy is already running | Disable the duplicate userscript. |
| Window returns at the wrong size | Update to the current file; Rack Map now refits the browser viewport on resize. |

The tracker uses browser wake mechanisms where available, but a sleeping PC
cannot monitor. Edge's **Never put these sites to sleep** setting can help
with background tabs. An HTTP page may not support every wake mechanism.

Report bugs through [GitHub issues](https://github.com/zayd117/EVE-SLT-TRACKER/issues)
with version, source page, expected/actual behavior and Dev diagnostics. The
console prefix is `[EVE SLT+JBOG TRACKER]`.

## Privacy and scope

The script reads monitoring pages and uses the existing Jira/TestView browser
sessions. It makes no ticket, test or inventory edits and asks for no password
or API key. It adjusts the page's display locally, saves settings/assignments,
and can export logs. No analytics or telemetry are sent. Browser storage and
exports can contain node serials and test details; share only the information
needed for a bug report. The script itself lists the fixture serials of rows
B6 and B7 (owner's decision, 2026-10-13); no ticket, credential or test result
is stored in it.

## Development and AI handoff

Start with [AGENTS.md](AGENTS.md) or [CLAUDE.md](CLAUDE.md) for the current
architecture, editing constraints and a targeted source map. Read only the
relevant source section and deeper notes for the requested change.

| File | Purpose |
|---|---|
| [EVE_SLT_JBOG_TRACKER.user.js](<EVE_SLT_JBOG_TRACKER.user.js>) | The single installable userscript |
| [CHANGELOG.md](CHANGELOG.md) | Current 2.0.2 changes and historical releases |
| [docs/CODE_NOTES.md](docs/CODE_NOTES.md) | Detailed implementation and storage rationale |
| [docs/TESTING.md](docs/TESTING.md) | Test commands, fixtures, coverage and manual checks |
| [docs/LION_KING_QA.md](docs/LION_KING_QA.md) | Historical test evidence and current validation limits |
| [docs/LION_KING_SOURCE_NOTES.md](docs/LION_KING_SOURCE_NOTES.md) | Source contracts and evidence boundaries |
| [docs/LION_KING_NEXT_STAGE.md](docs/LION_KING_NEXT_STAGE.md) | Follow-up work and physical rack registry |
| `tests/`, `scripts/`, `package.json` | Development-only tests and helpers |

`main` supplies the userscript install/update URL. A merge is not a release
tag or evidence that live internal pages have been tested. Fixture-suite
results for the current version are recorded in
[docs/LION_KING_QA.md](docs/LION_KING_QA.md).

MIT. See [LICENSE](LICENSE).
