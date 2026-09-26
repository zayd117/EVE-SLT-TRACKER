# Working on EVE SLT Tracker

Single-file Tampermonkey userscript: `EVE_SLT_Tracker.user.js`. Users
auto-update from `main` via `@updateURL`, so whatever reaches `main` ships.

Read first: `docs/TESTING.md` (architecture, code-to-test map, commands) and
the matching section of `docs/CODE_NOTES.md` for any code you touch.

## Rules

- Do not commit, push, tag or open a PR until the user says **SUBMIT**.
- Any change to the script: bump `@version` (and the `SCRIPT_VERSION`
  fallback), add a `CHANGELOG.md` entry, keep the file pure ASCII.
- Public repo: never add credentials, tokens, cookies, real serials/Jira
  keys, or new internal hostnames without asking the user.
- Tests and docs only (no script change): no version bump needed.

## Every change

Understand -> impact analysis (map in docs/TESTING.md) -> write/extend tests
(failing regression test first for bugs) -> implement -> `npm test` ->
diagnose and fix failures -> `npm run test:mutation` for risky logic ->
update CODE_NOTES / TESTING.md -> report evidence, and state plainly what
could not be verified (real site, real Tampermonkey, visuals).

## Commands

- `npm ci` then `npm test` (~4 min, headless Chromium via Playwright)
- `npm run check` (syntax + header)
- `npm run test:mutation` (~45 min, every mutant must be KILLED)
