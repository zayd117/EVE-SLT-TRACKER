# EVE SLT Tracker

A Tampermonkey userscript for the EVE SLT rack page. It watches the rack,
tells you the moment a server **passes or fails**, and links each result to
its Jira ticket and TestView run.

- Works in **Microsoft Edge**, Chrome and Firefox with Tampermonkey.
- Read-only: it never changes anything on the rack page, in TestView or in Jira.
- Nothing to configure for normal use.

---

## What it does

When a server cell on the rack page changes colour, the tracker checks the
server's detail page to confirm what really happened, then:

1. shows a **card** in the **JIRAlerts** window on the page,
2. sends a **Windows desktop notification** (toast),
3. finds the **Jira ticket** for that failure,
4. writes the result to the **shift log**, which you can export.

| Rack colour change | What you get |
|---|---|
| Light blue, light green or dark green -> **Red** | **Fail** card (pre-test or test) |
| Light green -> **Dark green** | **Pass** card |

The colour only says *something* happened. Pre-test vs test, and pass vs
fail, always come from the server's detail page. SYS_DEKIT runs are
recorded as diagnostics, never as failures.

---

## Key features

- **One card per result**, newest on top, with filter chips, counts and a
  search box (serial, location or Jira key).
- **Jira chip on every card** that finds the ticket for you, with a
  **copy link** button once it exists.
- **"Raise a ticket" help**: if no ticket appears within 15 minutes, the
  tracker tells you the exact PuTTY command to send.
- **TestView in one click**: click a card (or a red rack cell) to open that
  server's latest SLT test.
- **Automatic shift log** (Day / Swing / Graveyard) with `.txt` and `.csv`
  export.
- **Live counts** of testing / failed / passed per rack section.
- **Keeps itself running**: background refresh, recovers from network
  blips and from the browser putting the tab to sleep.
- **Safe with several tabs open**: each result is notified and logged once.

---

## Installation

1. Install the **Tampermonkey** extension:
   [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) ·
   [Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) ·
   [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
2. Open the **[tracker install link](../../raw/main/EVE_SLT_Tracker.user.js)**.
3. Tampermonkey shows an install page. Click **Install**.
4. Open (or reload) the EVE SLT rack page.

You should see the **EVE SLT Tracker** panel in the top-right corner of the
rack page. That is all - the default settings are ready to use.

> **If Tampermonkey asks** to allow a connection to **jira.synnex.com** or
> the **TestView** site, choose **Always allow**. Without it the Jira and
> TestView lookups do not work.

---

## How to use it

Leave the rack page open. The tracker does the watching.

**When a result comes in**

- A card appears in **JIRAlerts** and a desktop toast pops up.
- Click the **serial number** on a card to copy it.
- Click the **Jira chip** to open the ticket (or a Jira search).
- Click **anywhere else on the card** to open the server's latest test in
  TestView. If that test cannot be found, the TestView SLT list opens with
  the serial already searched.
- Click **x** to dismiss a card. Dismissing never deletes the shift log.

**On the rack page**

- Click a **red cell** to open that server in TestView.
  **Ctrl+click** still opens the old detail page.

**The JIRAlerts window**

- Drag it by any empty part of its title bar.
- Click the title to collapse or expand it.
- The **...** menu has **Export shift log (.txt)**, **Export for Excel
  (.csv)** and **Dismiss all cards**.

---

## Status and notification behaviour

### Jira chip on a card

| Chip shows | Meaning |
|---|---|
| **JIRA - 123456** | Ticket found. Click to open it. The copy button next to it copies the full link. |
| **Ticket pending** | Test fail, the Jira bot has not raised the ticket yet (usually 5-10 min). The tracker keeps checking. |
| **No ticket yet** | Pre-test fail, no ticket so far. Pre-test fails often never get one. |
| **No ticket (create one)** | Pre-test fail, 15+ minutes and still no ticket. Outlined in yellow until you hover it. |
| **No ticket (re-testing)** | Same, but TestView shows the server testing again, so a ticket cannot be made yet. |
| **No ticket** | Test fail, still no ticket after the bot's usual time. |
| **PASSED (no ticket)** | Passes never get a ticket. |

- **New ticket:** when a ticket appears on a card that was waiting, the chip
  glows green with a small **!** until you hover it.
- **Seen once:** the green glow and the yellow outline each show once per
  failure. They do not come back after a page reload.
- **Removed from rack:** if the server is pulled or swapped out of its slot,
  its card is struck through and tagged **Removed from rack**. It is kept,
  not deleted.
- **Older cards** (45 min+) are dimmed. A yellow-outlined chip stays bright
  until you have seen it.

### Raising a missing ticket

Click the chip of a failure that has no ticket. The page that opens says
what to do:

- **Before 15 minutes:** "If there is no ticket by *time*, please open PuTTY
  and create one with: `ticket <serial>`" (with a **Copy** button).
- **After 15 minutes:** a highlighted box: "It has been more than 15 minutes
  and no ticket has been created. Please make one in PuTTY."
- **Server testing again:** if TestView 2.0 shows the server **RUNNING**,
  PuTTY would refuse the ticket, so the page says so and links to that
  TestView run instead.

### When you get a notification

- You get **one** card and **one** toast per real result.
- **No** alerts on page load, page refresh or reload: the tracker only
  alerts on a change it saw happen.
- The same failure flickering back and forth within a minute alerts once.
- A different server moved into a slot is not an alert.
- With several tracker tabs open, only the first tab to see a result sends
  the toast and logs it. Every tab still shows the card.
- Turning a section's **Notifs** off stops its toasts; its results are still
  logged.

---

## Configuration

Everything is set in the panel and saved in your browser.

| Setting | Where | Default |
|---|---|---|
| Refresh interval (30 s / 20 s / 10 s) | Main panel | 30 s |
| **Log shift** (Auto, or Day / Swing / Graveyard) | Main panel | Auto |
| **Show** and **Notifs** per rack section | Main panel | On |
| Developer mode | Small **Dev** box, bottom of the panel | Off |
| Toast auto-close, toast click target, Jira URL | Visible with **Dev** on | Off (Windows decides) / Jira ticket / jira.synnex.com |

**Log shift, Auto:** the log follows the shift you are in.

- Starting within 60 minutes of a shift counts as that shift
  (9:40 PM is Graveyard, 6:00 AM is Day).
- Exports cover the shift from 60 minutes before it starts to 60 minutes
  after it ends. Hover **Log shift** for the exact times.
- A shift's log is kept until the same shift starts again.
- Picking a shift by hand lasts until the next shift change, then goes back
  to Auto.
- Export times are Fremont time (PDT / PST).

**For a fork only:** the rack page address (`@match`) and the update
address (`@updateURL` / `@downloadURL`) are set in the header of
`EVE_SLT_Tracker.user.js`.

---

## Updating

Updates are automatic. Tampermonkey checks this repository about once a day
and when the browser starts, and installs any newer version.

- **Update now:** Tampermonkey icon -> **Dashboard** -> **Utilities** ->
  **Check for userscript updates**.
- **Which version am I on?** It is shown next to "by Zay Davidson" in the
  panel title, and in the Tampermonkey Dashboard.

Your settings, cards and shift log are kept across updates.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| No panel on the rack page | Check Tampermonkey is on and the script is enabled in the Dashboard, then reload the page. |
| Red banner "FAILED TO START" | Hard-refresh (**Ctrl+Shift+R**). If it stays, report a bug with the error text. |
| Cards appear but no desktop toasts | Check that section's **Notifs** switch. In Windows Settings -> **Notifications**, allow the browser (Edge) to notify, and turn **Do not disturb** off. |
| Jira chip only says "Jira" and its tooltip asks you to log in | Log in to Jira in the same browser, then wait for the next check. |
| Card click does not find the test | Log in to TestView in the same browser. |
| Console says "Another copy ... is already running" | The script is installed twice. Remove the extra one in the Tampermonkey Dashboard. |
| Alerts arrive late when the tab is in the background | See **Keep the page awake** below. |

### Keep the page awake

The tracker keeps its own tab awake, with nothing to set up. It also stops
the screen and PC from sleeping while the tracker tab is on screen. If the
browser still puts the tab to sleep, the tracker catches up as soon as the
tab wakes.

To rule sleeping out completely (optional):

- **Edge:** Settings -> **System and performance** -> **Performance** ->
  **Never put these sites to sleep** -> **Add** the EVE site.
  No admin rights needed. (A userscript cannot change this list itself.)
- **Every PC at once:** ask IT to set the Edge policy
  `SleepingTabsBlockedForUrls` to the EVE site.
- **Laptops:** Windows Settings -> System -> Power -> sleep **Never** while
  plugged in. A sleeping PC runs nothing.

---

## Reporting a bug

Open a **[new issue](../../issues/new/choose)**. The form asks for:

1. the tracker version (panel title or Tampermonkey Dashboard),
2. what you expected,
3. what actually happened,
4. any red text in the browser console (**F12** -> **Console**).

Every tracker message in the console starts with `[EVE Tracker]`, so you
can filter on that. With **Dev** on, the panel also shows three
**Refresh diagnostics** lines - paste those too.

---

## Privacy

The tracker only makes these requests, using logins you already have:

- the **rack page**, re-loaded in the background on each refresh;
- a server's **detail page** (same site), once per result;
- **Jira** search (`jira.synnex.com`), sending only the serial number;
- **TestView** (its own site), sending only the serial number: to find a
  server's test when you click a card, and to check whether a failed server
  is testing again before suggesting a PuTTY ticket.

No passwords or cookies are read or stored. No analytics, no telemetry.
Settings, the shift log and card state stay in your own browser
(`localStorage` / `sessionStorage`). Exports are saved by your browser to
your PC.

---

## Developer information

```bash
git clone https://github.com/zayd117/EVE-SLT-TRACKER.git
cd EVE-SLT-TRACKER
npm ci                       # Node 20+; first time also: npx playwright install chromium
npm run check                # syntax + userscript header
npm test                     # full suite: the real script in headless Chromium
npm run test:mutation        # optional: checks the tests catch real bugs (~45 min)
```

| File | What is in it |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Every change, per version |
| [docs/CODE_NOTES.md](docs/CODE_NOTES.md) | Why the code is the way it is, one heading per `// ===== SECTION =====` in the script |
| [docs/TESTING.md](docs/TESTING.md) | How it is tested, code-to-test map, what still needs a human |
| [docs/reviews/](docs/reviews/) | Code reviews |

The script carries no change notes or long comments; they live in these
files so the installed file stays small.

### Repository layout

```text
EVE_SLT_Tracker.user.js        the userscript (what users install)
CHANGELOG.md                   change history
docs/                          code notes, testing guide, reviews
tests/                         automated tests (node:test + Playwright; dev only)
package.json                   dev-only test tooling (nothing ships to users)
CLAUDE.md                      working rules for AI-assisted changes
scripts/release.sh             cut a release (bump, changelog, tag, push)
scripts/validate-header.mjs    checks the ==UserScript== header
scripts/check-version-bump.mjs fails a PR that changes the script without a bump
.github/workflows/ci.yml       checks and tests on every push and PR
.github/workflows/release.yml  publishes a GitHub Release for each v* tag
.github/ISSUE_TEMPLATE/        bug report form
```

### Releases and branches

- `main` is the release channel: whatever is on `main` is what users get.
- Work on a branch, open a PR, merge. CI fails a PR that changes the script
  without bumping `@version`, breaks the syntax, header or plain-ASCII
  checks, or fails the tests.
- Pushing a `vX.Y.Z` tag that matches `@version` publishes a GitHub Release
  with that version's changelog entry.

### Testing a local copy in Tampermonkey

1. Dashboard -> **Settings** -> **Config mode**: `Advanced`.
2. Allow Tampermonkey **access to file URLs** in the browser's extension settings.
3. Dashboard -> the script -> **Settings** -> set a `file://` update URL
   and the update interval to *Always*.

Reload the rack page to pick up local edits.

---

## Licence

MIT. See [LICENSE](LICENSE).
