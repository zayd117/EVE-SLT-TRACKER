# Combined tracker implementation status

**Current:** EVE SLT+JBOG TRACKER **2.0.1**, canonical file
`EVE_SLT_JBOG_TRACKER.user.js`. This replaces the initial v1.1.x discovery plan;
collector-only source selection, UI-typed UUT navigation and "nothing published"
statements from that plan are historical, not current instructions.

## Delivered scope

| Requirement | Current implementation |
| --- | --- |
| One install, correct source mode | `bootstrap` dispatches SLT, collector Lion, Ramses JBOG or TestView helper. Unsupported Ramses dashboard types stay idle. |
| Preserve SLT | Existing rack/detail confirmation, TestView fallback, Jira timing and isolated saved state remain. |
| Collector Lion monitoring | Validated five-column parser; exact run identity; malformed rows quarantined; quiet baseline; tracked completion events. |
| Ramses monitoring | Native running table, failed-board membership episodes, automatic current MPY passed CSV; no guessed backend API. |
| Separate failure phases | TEST_FAILURE vs PRETEST_FAILURE, separate alert filters/counts; quiet failed-state migration. |
| Durable event delivery | Audit before claims/completed baselines; pending retry on storage failure; cross-tab dedupe/locks where supported. |
| Physical location | Click rack slot, scan serial, Enter saves; explicit ordered 21-rack registry; verified partner hydration; conflicts remain Unassigned. |
| Compact map | Physical cross slots with times/Jira/TestView/×; B6 blue, B7 green, E2/E4/BL purple; shared B6/B7 horizontal scroll. |
| Area controls | B6, B7, E2/E4/BL, Unassigned Enabled flags; row arrow/show/notifications synchronized, default off; no per-rack toggle. |
| Readable normal panel | Rack Map action, core row controls/refresh/shift; advanced source/Jira/registry details behind Dev checkbox. |
| Resize recovery | Viewport-relative map fit and resize handling; map-open state persisted without temporary pixel dimensions. |
| Correct Lion navigation | Direct validated UUT API/run lookup; PRETEST operation preserved; Jira serial search sorted updated DESC. |
| Existing operator tools | Copy/search, saved cards, shift TXT/CSV, area-only assignment, rack JSON backup/restore and edit layout. |

## Constraints for future changes

- Preserve SLT `eveRackTracker*`, Lion `lionKingTracker*` and shared
  `eveLionRackBoardV1` keys. Display version 2.0.1 is not a storage-schema version.
- Physical row membership/order is explicit, not inferred from rack prefix,
  list ordinal or source sort. Keep slot 0 top / 1 bottom / 2 left / 3 right.
- Missing rows, FPY, idle time and ETA never establish PASS. Failed-board
  membership cannot claim an exact run ID/Started. First observations and
  migrations must not replay history as fresh notifications.
- Hidden rows remain monitored/logged; one row flag controls expansion,
  visuals and surfaced notifications. Do not add child rack switches.
- Keep real browser sessions, bounded requests/state and validated identities;
  do not store credentials or type into the Lion TestView query form.
- User instructions override generic repository rules. The current work keeps
  2.0.1 at the user's request; prior SUBMIT/version-bump prose is not a new
  approval requirement for an explicitly authorized merge.

## Where to continue

Read [../AGENTS.md](../AGENTS.md) for the short edit handoff,
[CODE_NOTES.md](CODE_NOTES.md) for function ownership and invariants,
[LION_KING_SOURCE_NOTES.md](LION_KING_SOURCE_NOTES.md) for contracts/evidence,
[LION_KING_NEXT_STAGE.md](LION_KING_NEXT_STAGE.md) for the physical layout,
and [LION_KING_QA.md](LION_KING_QA.md) / [TESTING.md](TESTING.md) for validation
scope. Do not rerun a whole-repository discovery to recover these decisions.
Signed-in live-site checks remain distinct from synthetic or source review.
