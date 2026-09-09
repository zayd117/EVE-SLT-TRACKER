# EVE SLT Tracker

A Tampermonkey userscript that watches an EVE SLT rack page for server cells
changing colour and raises an alert when a colour change represents a real test
result. Alerts appear as an in-page card and a Windows desktop toast, and every
real transition is written to a permanent audit log that exports to `.txt` or
`.csv`.

Only these three transitions are tracked; everything else is ignored:

| From | To | Result |
|---|---|---|
| Light blue | Red | Pre-test fail |
| Light green | Red | Test fail |
| Light green | Dark green | Test pass |

---

## Install

1. Install **Tampermonkey** ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) / [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/))
2. **[Click here to install the tracker](../../raw/main/EVE_SLT_Tracker.user.js)**
3. Tampermonkey opens an install page — click **Install**
4. Open the EVE SLT rack page. The tracker panel appears in the top-right.

That's it. No copy-pasting.

### Updates

Tampermonkey checks this repo for a new version automatically (by default once a
day, and on browser start). When one is published you get an update prompt.

To check immediately: Tampermonkey icon -> **Dashboard** -> **Utilities** ->
**Check for userscript updates**.

To see which version you are running: Tampermonkey **Dashboard**, or open the
browser console (F12) on the rack page and look for the `[EVE Tracker]` banner.

---

## Configuration

Two things must be set for a given deployment. Both live in the userscript
header at the top of `EVE_SLT_Tracker.user.js`:

| Directive | What to set |
|---|---|
| `@match` | The URL pattern of your EVE SLT rack page |
| `@updateURL` / `@downloadURL` | The raw URL of this file in your fork |

Everything else is configured in the UI and persists per browser profile:
auto-refresh interval, soft vs hard refresh, per-section show/notify flags,
desktop toast duration, and Developer Mode.

---

## Reporting a bug

Open an [issue](../../issues/new/choose). The bug report template asks for the
four things that actually make a report actionable:

1. The tracker version (console banner or Tampermonkey dashboard)
2. What you expected
3. What actually happened
4. Any red text from the browser console (F12 -> Console)

Every line the tracker prints is prefixed with `[EVE Tracker]`, so you can filter
the console on that string.

There is also a **Health Check** button on the Developer page (enable the small
`Dev` checkbox in the panel footer) that dumps a table of the tracker's internal
state to the console. Paste that into the issue.

---

## Development

```bash
git clone <this repo>
cd eve-slt-tracker

# syntax check (matches what CI runs)
node --check EVE_SLT_Tracker.user.js

# cut a release: bumps @version, updates CHANGELOG, tags, pushes
./scripts/release.sh patch "Fix flap protection swallowing swapped-server failures"
```

### Branch model

- `main` is the release channel. Whatever is on `main` is what users download.
- Work on a branch, open a PR, merge. CI blocks a merge that does not bump
  `@version` or that fails the syntax check.
- `./scripts/release.sh` tags the commit; the release workflow then publishes a
  GitHub Release with the changelog entry attached.

### Local testing against Tampermonkey

Tampermonkey can load a script from a local file so you do not have to publish
to test:

1. Dashboard -> **Settings** -> set **Config mode** to `Advanced`
2. Enable **Allow access to file URLs** in the extension's browser settings
3. Dashboard -> your script -> **Settings** tab -> set a `file://` URL as the
   update URL, and set the update interval to *Always*

Reload the rack page to pick up local edits.

---

## Privacy

This script stores nothing off-machine. It has no analytics, no telemetry and no
outbound requests other than re-fetching the page you are already on.

- **Credentials are never stored.** The tracker uses the browser session you are
  already authenticated with.
- All state lives in your own browser: `localStorage` (settings, audit log,
  panel position) and `sessionStorage` (rack baselines, undismissed alerts, flap
  cooldowns).
- The exported `.txt` / `.csv` files are written locally by your browser.

---

## Licence

MIT. See [LICENSE](LICENSE).
