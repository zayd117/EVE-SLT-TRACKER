# Changelog

All notable changes to this project are documented here.
Versions follow [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

Tampermonkey offers an update to installed users whenever `@version` in the
userscript header increases, so every entry below corresponds to a version
that was actually shipped.

## [0.9.1] - 2026-09-09

### Fixed - silent monitoring failures

- Soft refresh could permanently stop auto-refresh. The "already in flight"
  early return skipped the callback that reschedules the timer, and the fetch
  had no timeout, so a hung request stalled refreshing for the life of the tab.
  Added an `AbortController` with a 15s cap, a completion callback that runs on
  every exit path, and a watchdog that force-restarts an overdue refresh.
- Turning a section's "Notifs" off also stopped it being written to the audit
  log, leaving invisible holes in the exported record. Recording and surfacing
  are now separate; the flag suppresses only the card and the desktop toast.
- The test-phase hint could create alerts for colour transitions the spec
  ignores. It can now only re-label an already-tracked test fail as a pre-test
  fail.
- The phase hint no longer reads cell text, class or id, only explicit `data-`
  attributes. On a page called Server Level Test the word "test" appears
  everywhere and the hint fired constantly.
- Flap protection now keys on the serial as well as the rack slot, so a
  replacement server that genuinely fails the same way inside the cooldown is
  no longer suppressed. The cooldown map is persisted so a reload cannot re-arm
  it.
- Added `@run-at document-start` so the page's own meta refresh is stripped
  before the browser commits it.

### Changed - performance

- `scan()` and `applyVisibility()` walk each table's rows once and loop the
  header columns inside, instead of re-walking every row once per header.
- `normalizeColor()` checks the legacy `bgcolor` attribute before falling back
  to `getComputedStyle()`.
- Phase hints are cached on the cell node; header lookups are cached and
  invalidated on real DOM change.
- The audit log is held in memory and written debounced, rather than a full
  parse and stringify of the whole array on every alert.
- The mutation observer is suppressed around the tracker's own writes and
  inspects added/removed nodes rather than only the mutation target.
- Section controls diff the section set instead of rebuilding every checkbox on
  every mutation tick.

### Changed - operational

- One version string, sourced from `GM_info`.
- Added `@noframes`, `@updateURL` and `@downloadURL`.
- Debug snapshot and comparison only run in Developer Mode.
- Repeated soft-refresh failures disable it for the session only, instead of
  writing a permanent disable to `localStorage`.
- Added a Health Check button that dumps the tracker's internal state.

### Fixed - other

- Dismissing a card re-applies the active filter.
- Debug/test cards are evicted before real ones at the storage cap.
- Toast clicks use `GM_openInTab` (a `window.open` from a notification callback
  is not a user gesture and gets popup-blocked).
- The console diagnostic is exposed on `unsafeWindow` so it is reachable from
  F12.
- `detailUrl` is protocol-checked before being opened.
- CSV date and time columns are derived from the ISO timestamp so they sort
  correctly in Excel regardless of machine locale.

## [0.9.0] - initial

- First tracked release.
