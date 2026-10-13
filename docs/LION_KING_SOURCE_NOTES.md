# Lion King source evidence and current contracts

Current implementation: **EVE SLT+JBOG TRACKER 2.0.1**,
`EVE SLT+JBOG TRACKER.user.js`. This separates historical observations from the
contracts now implemented. [CODE_NOTES.md](CODE_NOTES.md) maps them to functions;
[LION_KING_QA.md](LION_KING_QA.md) records validation scope. No credentials or
real serial/record IDs are required in fixtures or future captures.

## Collector evidence retained

The user's browser report established `/out/out.evelionking_all.php` with a
five-column historical table. One capture counted 4,062 rows including headers;
that is not active inventory. The later supplied title/headers were
`EVE LionKing GPU_JBOG_TEST` and `JBOG_NUM`, `TailNode_SN`, `HeadNode_SN`,
`Started`, `Status`. Sample statuses were light green with step text; no sampled
per-JBOG detail link established compatibility with SLT server-detail parsing.
No same-origin XHR observed in a short capture does not prove no API exists.

The user confirmed light green RUNNING, green/dark green PASS, red FAIL, and
bare `H:MM` in a PASS cell as elapsed hours/minutes. Exact supported labels may
establish status; conflicting color/label evidence stays UNKNOWN. Loose substring
searches in model/step names do not establish PASS/FAIL. Tail + Head + Started
identify an attempt; JBOG_NUM is a changing ordinal. Start times are interpreted
as Fremont/Pacific wall time. New start means a new attempt, not a hardware move.

The old BLIND screenshot led to per-row quarantine rather than whole-dataset
rejection for one malformed historical row. Strict table/header/readiness
requirements remain. Cached last-good rows are labelled display data; they do
not prove a new result or reduce the collector's downloaded response.

Completed-history display defaults to 24 hours (48/All available); active rows
remain available at any age. History filtering never backfills notifications
or suppresses a tracked old active attempt completing now. Recent valid PASS
samples provide an advisory mean/ETA, not authoritative completion.

## Ramses: now an implemented runtime source

URL: `http://hyve-cmd101-ramses.hyvesolutions.org:8001/?dashboard=jbog`.
Historical cloud requests returned proxy 403/CONNECT denial. That is an access
limit, not a Ramses application error or proof of speed. Later user-provided
markup/workflow evidence enabled the current adapter; earlier notes saying
"no Ramses runtime" are superseded.

The script watches the native Streamlit DOM; it does not fetch a guessed
Ramses API or replace its whole page with collector HTML. Native refresh is
respected. If the native autorefresh component is absent, the implementation
can persist state and reload after its fallback threshold.

| Evidence | Contract and consequence |
| --- | --- |
| Running table | Supported JBOG SN/status/operation/Started headers; exact GPU_JBOG_TEST or PRETEST operation; valid times and identities. |
| JBOG Failed Test card | One visible current card, six required columns (SN, Operation, Current Route, Idle Time, Status, Ticket Number), complete/count-consistent table. |
| MPY (PASSED JBOGS) download | Current visible verified filename/URL; prefer the KPI card; byte-identical duplicate anchors are one source, distinct current sources are ambiguous. |
| Passed CSV columns | `uut_sn`, `Start Time`, `Finish Time`, `PASSED`, `Attempt`, `FPY_Stat`. Only PASSED=1 establishes pass. FPY Fail/Retest is a separate metric. |

Automatic MPY reads support approved data URLs (including base64), same-origin
blob URLs and media paths. No download click or operator CSV import is required
for normal monitoring. Bounds, quoting, timestamps, attempts, duplicates and
in-flight source replacement are checked in the implementation; bad evidence
retains the last validated data. Timestamp precision is explicit because some
exports omit seconds. A conflicting/ambiguous attempt does not produce a pass.

A failed-board membership episode proves a newly listed action-board failure,
not exact Started/Finished or TestView run ID. PRETEST and GPU failures are
separate categories. First membership is quiet; v1→v2 migration quietly adds
existing PRETEST members, preserving main-test episodes and pending delivery.
PASS history can create quiet cards; saved intent distinguishes history from a
new pass notification. Absence from running/failing tables never proves pass.

## Physical location comes from operator scans

Neither collector list ordinals nor Ramses row order provide physical rack
positions. The user explicitly supplied 21 racks in three physical rows:
B6 (5), B7 (5), E2/E4/BL (11). B6 and B7 deliberately contain one barcode with
the opposite prefix. See [LION_KING_NEXT_STAGE.md](LION_KING_NEXT_STAGE.md) for
exact left-to-right order. Assignments remain keyed by rack/slot and serial,
not test result or list order. Conflicting tail/head placements are Unassigned.

Row Enabled controls couple visibility, expansion and notifications, default
off. Individual racks are never enableable. Hidden rows still record valid
results in their audit; they do not surface cards/toasts.

## TestView 2.0 and Jira navigation

The original supplied UUT evidence established `/uut/gpu_jbog_test/list`,
`/uut/detail/<id>` and `/api/v1/uut_status/view/<id>/by_id` with fields including
id, uut_sn, fixture_sn, operation, status, started, finished and duration.
Those early observations alone did not establish a list API response shape.
The current implementation also resolves the UUT list API directly, then
validates the chosen record via by_id. Earlier UI-typing handoff plans are
superseded for Lion; SLT retains its own existing fallback.

Require exact uut_sn (fixture_sn alone is insufficient), canonical operation,
valid numeric ID, and exact Started when supplied. PRETEST uses
GPU_JBOG_TEST_PRETEST; main test uses GPU_JBOG_TEST. Without Started, only a
unique newest matching run is selected. With Started, bounded history seeks
that exact attempt. Failed/ambiguous lookup leaves the UUT list and a banner;
no guessed ID or SLT detail endpoint is used.

Lion Jira buttons open a serial text query with ORDER BY updated DESC. A
validated cached key may supply the split-view `/browse/<key>?jql=...` path;
no key uses `/issues/?jql=...`. A bare ticket link can point at an old attempt
and is not the intended Lion workflow. Browser login supplies all authentication.

## Limits requiring signed-in site observation

Cloud source reads and synthetic fixtures do not prove live cookies, production
markup stability, Pacific timestamps, native Streamlit refresh coverage or
Windows Tampermonkey toast delivery. A complete attempt occurring between
observations can be missed. Failed-board membership has no exact run start;
ambiguous API/CSV matches are deliberately unresolved. Never turn disappearance,
ETA, aggregate totals or an old cached ticket into confirmed completion.
