# Lion King rack layout and follow-up reference

**EVE SLT+JBOG TRACKER 2.0.1** implements the faster-source adapter and physical
rack map. This replaces the old "next-stage" proposal; it is a current layout
reference and a list of remaining evidence limits, not an unimplemented plan.
Runtime: `EVE SLT+JBOG TRACKER.user.js`. Source contracts:
[LION_KING_SOURCE_NOTES.md](LION_KING_SOURCE_NOTES.md).

## Exact physical rows, left to right

Do not sort this list. Row 1 is **B6**, row 2 is **B7**, row 3 is **E2/E4/BL**,
regardless of barcode prefix. The user corrected the initial top-to-bottom
interpretation: these are left-to-right sequences. B6/B7 belong visually
together and share horizontal scrolling; E2/E4/BL scrolls independently.

| Position | B6 | B7 | E2/E4/BL |
| ---: | --- | --- | --- |
| 1 | TA.B6-EVE03 | TA.B7-EVE02 | TA.E2-EVE04 |
| 2 | TA.B6-EVE02 | TA.B6-EVE05 | TA.E4-EVE06 |
| 3 | TA.B6-EVE01 | TA.B7-EVE01 | TA.E2-EVE06 |
| 4 | TA.B6-EVE04 | TA.B7-EVE03 | TA.E4-EVE01 |
| 5 | TA.B7-EVE05 | TA.B7-EVE04 | TA.BL-EVE03 |
| 6 | | | TA.E4-EVE05 |
| 7 | | | TA.E2-EVE03 |
| 8 | | | TA.E4-EVE04 |
| 9 | | | TA.E2-EVE02 |
| 10 | | | TA.E2-EVE05 |
| 11 | | | TA.E4-EVE02 |

`LION_RACK_ROWS` is the default authority. `restoreLionRackScanOrder` repairs
older layouts once using layoutRevision 2 without moving barcode-keyed scans.
Board version 1 and workRevision 1 remain storage compatibility values.

## Slot identity and workflow

Each rack has four slots. Stored indices remain 0 Top middle, 1 Bottom middle,
2 Left middle, 3 Right middle. Render the physical cross:

```text
        top
 left         right
       bottom
```

Click a slot, scan one JBOG serial, Enter saves. Source/API lookup hydrates
relevant information and a verified partner. Source row sorting, list ordinal
or retest cannot move hardware. Manual area-only assignment is available in
Dev mode when no rack scan exists; physical placement takes priority. Conflicting
node placements stay Unassigned until corrected.

Occupied slots show compact state/timestamps, Jira and TestView buttons and ×
for immediate removal. The remove handler must compare the clicked serial to
current storage before clearing a slot. Edit layout allows rack reorder/move,
new racks, drag to an empty slot, JSON backup and restore. GM storage shares
assignments across this userscript's origins in one browser installation;
other PCs/operators need explicit backup/restore.

## Visibility and layout rules

Only whole B6/B7/E2/E4/BL/Unassigned groups have Enabled controls. Off is collapsed
and notification-muted; the chevron and switch are the same saved state. All
rows start off on first install/one-time migration, then preserve user choices.
No individual rack or slot should have its own visibility/notification switch.

Group background accents: B6 blue, B7 teal/green, E2/E4/BL purple. Running/pretest
cards use medium light green with light text, PASS dark green, TEST FAIL red,
PRETEST FAIL darker red. Controls sit next to each row label; avoid a tall global
control strip. Main tracker remains compact, with advanced details behind Dev.

One horizontal bar moves B6 and B7 together; E2/E4/BL uses its own. The map hides
tracker/JIRAlerts while open. On window resize, fit to current viewport, including
when the window grows again. Save open state rather than temporary pixel sizes.

## Follow-up evidence limits

Ramses native running/failure DOM and MPY CSV are implemented. The historical
403 cloud access restriction does not validate production refresh/session or
speed. TestView direct API validates exact serial/operation/Started and by-ID
identity; its failure banner does not guess a run. Lion Jira opens serial query
results ordered updated DESC, keeping older tickets from silently winning.

Future source changes should supply sanitized current headings/rows/API field
shapes and clearly distinguish exact attempt outcomes from membership evidence.
Never collect credentials. See [TESTING.md](TESTING.md) for operator scenarios
and [LION_KING_QA.md](LION_KING_QA.md) for what was actually exercised.
