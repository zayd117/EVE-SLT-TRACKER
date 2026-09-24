# EVE SLT Tracker

A Tampermonkey userscript that watches an EVE SLT rack page for server cells
changing colour and raises an alert when a colour change is a real test result.
Each result is confirmed on the server's own detail page, shown as an in-page
card and a Windows desktop toast, linked to its Jira ticket, and written to a
per-shift audit log that exports to `.txt` or `.csv`.

| Rack colour change | Alert |
|---|---|
| Light blue, light green or dark green -> Red | **Fail** - pre-test or test, read from the detail page |
| Light green -> Dark green | **Pass** |

Colour only says *that* a result happened. Whether it was a pre-test or a test,
and whether it passed, comes from the server's detail page. SYS_DEKIT runs are
recorded as diagnostics, never as failures.

**What you get**

- **JIRAlerts** window: one card per result, newest on top, filter chips with
  counts, search by serial, location or Jira key. Cards older than 45 min dim.
- **Jira** button on every card. Fail cards find the ticket raised for that
  failure (the Jira bot usually takes 5-10 min) and show its key and status.
  With no ticket, one click gives the two useful searches. Passes never get a
  ticket, so pass cards just say **PASSED (no ticket)**.
- **Card click opens TestView**: click anywhere else on a card to go straight
  to that serial's latest SLT test-detail page in TestView. If the test cannot
  be found, the TestView SLT list opens with the serial searched instead.
- **Section counts**: live test / fail / pass numbers beside each section you
  have switched on.
- **Per-shift log, automatic**: the log follows the shift you are in (Day,
  Swing or Graveyard) - nothing to pick. Exports cover that shift from 60 min
  before it starts to 60 min after it ends, and its log is kept until the
  same shift starts again (hover **Log shift** for the exact times). Picking a
  shift overrides Auto until the next shift change.
- **Keeps working**: soft refresh in the background, survives network blips,
  detects when the browser put the tab to sleep and catches up.
- **More than one tab is fine**: each result is logged and notified once, by
  whichever tab sees it first; every tab still shows the card. Drag the
  JIRAlerts window by any empty part of its title bar.
- **Exports**: the **...** button on the JIRAlerts title bar has Export shift
  log (.txt), Export for Excel (.csv) and Dismiss all cards. Export times are
  Fremont time (PDT/PST) and show when each result happened.

---

## Install

1. Install **Tampermonkey** ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) / [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/))
2. **[Click here to install the tracker](../../raw/main/EVE_SLT_Tracker.user.js)**
3. Tampermonkey opens an install page - click **Install**
4. Open the EVE SLT rack page. The tracker panel appears in the top-right.
5. In the panel, check **Log shift** is set to your shift.

### Updates

Tampermonkey checks this repo for a new version automatically (by default once a
day, and on browser start) and offers an update whenever `@version` goes up.
A change published under the same version number is **not** offered - reinstall
from step 2 to get it.

To check immediately: Tampermonkey icon -> **Dashboard** -> **Utilities** ->
**Check for userscript updates**.

To see which version you are running: Tampermonkey **Dashboard**, or open the
browser console (F12) on the rack page and look for the `[EVE Tracker]` banner.

### Keep the tab awake

Edge "Sleeping tabs" (and Chrome "Memory Saver") pause background tabs, and a
paused tab cannot alert anyone. The tracker detects this and catches up when it
wakes, but only the browser can stop it happening:

- **Edge:** `edge://settings/system` -> **Performance** -> **Never put these
  sites to sleep** -> **Add** the EVE site. No admin rights needed.
- **For every PC at once:** ask IT to set the Edge policy
  `SleepingTabsBlockedForUrls` to the EVE host.
- **Laptops:** Windows Settings -> System -> Power -> set sleep to **Never**
  while plugged in. If the PC sleeps, nothing in the browser runs.

---

## Configuration

Two things are set per deployment, in the header of `EVE_SLT_Tracker.user.js`:

| Directive | What to set |
|---|---|
| `@match` | The URL pattern of your EVE SLT rack page |
| `@updateURL` / `@downloadURL` | The raw URL of this file in your fork |

Everything else is set in the panel and saved per browser profile:

| Setting | Where |
|---|---|
| Auto-refresh interval (30 s / 20 s / 10 s) | Main panel |
| Log shift (Day / Swing / Graveyard) | Main panel |
| Show and Notifs per rack section | Main panel |
| Developer mode (DEBUG cards, diagnostics) | Tiny **Dev** checkbox, panel footer |
| Toast auto-close, toast click target, Jira URL | Visible with **Dev** on |

---

## Reporting a bug

Open an [issue](../../issues/new/choose). The bug report form asks for:

1. The tracker version (console banner or Tampermonkey dashboard)
2. What you expected
3. What actually happened
4. Any red text from the browser console (F12 -> Console)

Every line the tracker prints starts with `[EVE Tracker]`, so you can filter
the console on that string. If it says *"Another copy of EVE SLT Tracker ... is
already running in this tab"*, the script is installed twice: remove the extra
one in the Tampermonkey Dashboard. With **Dev** on, the panel also shows three
**Refresh diagnostics** lines (refresh status, last scan, keep-awake) - paste
those too.

---

## Documentation

| File | What is in it |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Every change, per version |
| [docs/CODE_NOTES.md](docs/CODE_NOTES.md) | Why the code is the way it is. Each `// ===== SECTION =====` marker in the script has a matching heading here. |
| [docs/TESTING.md](docs/TESTING.md) | How the script is tested: architecture overview, code-to-test map, commands, what still needs a human. |
| [docs/reviews/](docs/reviews/) | Code reviews |

The script itself carries no change notes or long comments - they live here, so
the file users install stays small.

---

## Development

```bash
git clone https://github.com/zayd117/EVE-SLT-TRACKER.git
cd EVE-SLT-TRACKER

# syntax check + header check
npm run check

# full test suite: the real script in headless Chromium against fixture
# pages (needs Node 20+; first time: npm ci && npx playwright install chromium)
npm test

# cut a release: bumps @version, updates CHANGELOG, tags, pushes
./scripts/release.sh patch "Fix flap protection swallowing swapped-server failures"
```

When you change code, update the matching section of `docs/CODE_NOTES.md` in
the same commit, and add or update tests (see [docs/TESTING.md](docs/TESTING.md)).

### Repository layout

```text
EVE_SLT_Tracker.user.js        the userscript (what users install)
CHANGELOG.md                   change history
docs/CODE_NOTES.md             design notes, one heading per script section
docs/TESTING.md                testing guide and code-to-test map
docs/reviews/                  code reviews
tests/                         automated tests (node:test + Playwright; dev only)
package.json                   dev-only test tooling (nothing ships to users)
CLAUDE.md                      working rules for AI-assisted changes
scripts/release.sh             cut a release
scripts/validate-header.mjs    checks the ==UserScript== header
scripts/check-version-bump.mjs fails a PR that changes the script without a bump
.github/workflows/ci.yml       runs the checks on every push and PR
.github/workflows/release.yml  publishes a GitHub Release for each v* tag
.github/ISSUE_TEMPLATE/        bug report form
```

### Branch model

- `main` is the release channel. Whatever is on `main` is what users download.
- Work on a branch, open a PR, merge. CI flags a PR that changes the script
  without bumping `@version`, that fails the syntax, header or plain-ASCII
  checks, or that fails the test suite.
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

Nothing leaves your browser except these requests, all made with sessions you
are already logged in to:

- the rack page itself, re-fetched on each refresh;
- a server's detail page on the same site, once per detected result, to read
  its phase and pass/fail;
- Jira's search API at `jira.synnex.com`, with your existing Jira login, to find
  the ticket for a serial. Only the serial number is sent.
- TestView's own SLT list API, on the TestView site, when you click a card, to
  find that serial's test id. It is sent with your existing TestView login
  (the browser adds the cookie; the script never reads it). Only the serial
  number is sent.

No credentials are stored. There are no analytics and no telemetry. All state
lives in your own browser: `localStorage` (settings, audit log, panel position)
and `sessionStorage` (rack baselines, undismissed alerts, flap cooldowns, Jira
lookup cache). The serial of a clicked card is handed to the TestView tab
through Tampermonkey storage and deleted as soon as that tab reads it (it
expires after 2 minutes regardless). Exported `.txt` / `.csv` files are written locally by your
browser.

---

## Licence

MIT. See [LICENSE](LICENSE).
