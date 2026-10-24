# 3.1.2 (from 3.1.1)
- Version: @version and SCRIPT_VERSION fallback 3.1.2 (nothing else touched: storage keys, URLs, permissions).
- Quick Actions: tray back to 300 px wide, four rows compacted (row 32 px min, smaller icon/sub text/gaps) so all four fit with no overflow; tray is shorter than the card and centered with top/bottom inset. Rail width unchanged open/closed.
- HYVE open drawer: left gutter cut (drawer padding 12 -> 4 px on the tab side, 8 px on the far side, width 316 -> 308), 2-3-2 hexagon logic untouched.
- Refresh countdown (#eve-refresh-mini) in the folded header now shows only with Developer mode on (existing eve-developer-enabled class); the timer keeps running.
- HYVE tab: tracker expanded + drawer closed = vertical rail with "HYVE Quick Links" label (no click needed); folded + closed = icon-only at header height; open drawer unchanged.
- Checked in headless Chromium on the mock board: no errors; four QA rows, no overflow; folded tab 23 px vs header 25 px (dock border); countdown hidden/shown by Dev class; label shows only when expanded. Not run on the real site; 100% size not measured.

## Final handoff pass (same 3.1.2, UNTESTED: nothing was run, not even a syntax check)
- ETA: line 1 `[#] testing / Next Server pass ETA in 2 hr 35 mins - 10:16pm`, line 2 `SN [serial]    location B3  EVE11  U15` (new etaInText; never "hr / mins").
- Quick Actions: the card's tab is hidden while the drawer is open and the drawer slides out from the card edge with its rail leading (WAAPI transform + clip-path), so no second tab appears. Open/closed geometry untouched.
- Card: reply-status chip ("Waiting for response" etc.) now on the status row (former Jira slot); the Jira button is in the footer (former chip slot, bottom right).
- Tracker controls: Show All / Hide All / All Notifs / No Notifs are blue only for a true aggregate (syncBulkButtons, runs on every row change); mixed = all neutral; brief pressed feedback added.
- HYVE: only the open-drawer header row now matches the folded EVE header height (HYVE opening with the tracker folded already worked). The straight-seam "pot and handle" look was not otherwise changed or checked.
- Previous file kept in before-final-handoff/.

## Collapsed header + Quick Actions animation (same 3.1.2)
- placeHyveDock (flush/folded branch): the icon-only cap now takes the folded tracker's whole border box (top and height) instead of its title row, so cap and bar share top and bottom.
- openQuickActions / closeQuickActions (+ new endQuickActionsClose, qaClosing): the card's tab stays hidden while the drawer is open or folding back; the drawer slides out of and back into the card edge with its rail leading, so only one tab is ever visible. Final closed/open geometry untouched. CSS: `.eve-qa-closing` hides the tab like `[data-qa-open]`.
- Checked once in headless Chromium on the mock board: no errors; tab hidden mid-open and mid-close, visible again when closed; folded cap 10.0-53.1 px vs bar 10.0-53.2 px. Not run on the real site; only the folded + left-docked case was measured.

## Copy-link spacing + PuTTY note (same 3.1.2; syntax check only, not run)
- Jira copy chip: shows a bare check for 1.5 s (fixed 28 px chip) instead of "Link copied", and the card footer no longer wraps, so the row keeps its spacing.
- Quick Actions Create Ticket (PuTTY): the "Copied ... Paste it in PuTTY..." note under the tray is gone on success (the row's own Copied flash stays); the failure note and the paste-helper button are unchanged.

## Closing animation + ETA highlight (same 3.1.2)
- closeQuickActions: the fold-back now shrinks the tray's width (left edge fixed on the card edge, rail leading, overflow hidden via `.eve-qa-folding`) instead of sliding it under a clip-path, which could lag the transform and let the rows cross the card. Opening animation untouched; left/float placements close instantly as before.
- ETA line 1: the time left ("53 mins") is teal bold, the clock time ("12:39am") amber bold.
- Checked once in headless Chromium (mid-close frame: tray starts at the card edge, nothing over the card; no errors). Not run on the real site.

## Send vs wait for release (same 3.1.2; syntax check only, not run)
- Card repair row (repairTool syncCard): SEND TO REPAIR (gold, pulsing) = send the unit; SEND TO REPAIR FIRST + "release asked hh:mm" = release asked before the send; WAITING FOR RELEASE (blue, "sent hh:mm") = sent, Repair still has to release it for retest; SENT TO REPAIR (green) unchanged. New card.dataset.wait and `.jstr-card-toggle.sent.waiting` style.
- Quick Actions Send to Repair row shows "Waiting for Release" in the same state.

## Folded tracker + HYVE open: one seam (same 3.1.2)
- placeHyveDock: whenever the tracker is folded (cap or open drawer) the dock's top and header-row height are the folded bar's own border box (the open drawer was sitting ~12 px lower, on the title row), and the bar's two dock-side corners are squared (eve-dock-flush-left/right now for compact in general).
- Checked once in headless Chromium: panel 10.0-53.2 px, dock top 10.0, drawer header row level with the bar, no errors. Not run on the real site; left-docked case only.

## Green Bank link (same 3.1.2; syntax check only)
- GREEN_BANK_URL is now http://hyve-k8s-ramses-minion001.hyvesolutions.org:31808/loginout/in/?next=/#/rackintesting/ (was https, an assumption).

## Dock top alignment, expanded tracker (same 3.1.2)
- placeHyveDock: in seam mode (expanded tracker) the dock (labelled rail and open drawer) now starts at the panel's top edge, and its header row spans panel top to the title row's bottom line, instead of starting at the title row (~9 px low).
- Tested in headless Chromium, all four states (expanded/folded x closed/open), no errors: dock top = panel top (10.0 px) in every state; folded states unchanged. Left-docked only; not run on the real site. The open drawer's bottom is not forced to the panel's bottom.

## Jira chip tooltip spam (same 3.1.2; syntax check only)
- paintReply (repairTool): the "Click to read it in Jira" hint was appended on every repaint because only the reply line was stripped before re-adding; both lines are now stripped, so it shows once.

## Fold-stretch fix (2026-10-24)
- placeHyveDock: when the tracker is folded the HYVE cap height is measured from the title row plus the panel's bottom padding and border (foldedBar), not the panel's live height, which stays tall while the body folds away and stretched the dock. Checked in headless Chromium on the mock board (fold, open/close links in folded and expanded states); real site not run.

## Less wordy repair row (2026-10-24)
- syncCard: pending release ask now reads SEND TO REPAIR FOR RELEASE; right side shows only the time (no "release asked"/"requested").
- paintResponse: the Jira comment preview row under the footer is gone; the text stays in the response chip's tooltip.
- Mock-board Chromium check of the release-request card; real site not run.

## HYVE links close animation (2026-10-24)
- addProfileNavigation: closing the links drawer now shrinks it toward its tab over 180 ms (width, height, tab height together; contents clipped, not reflowed) while placeHyveDock keeps the dock glued to the tracker each frame. Before, the dock snapped from the open drawer to the taller closed rail, which read as growing. Opening is unchanged; reduced-motion skips the animation.
- CSS: `#eve-hyve-dock[data-closing] .eve-hyve-drawer > *`.
- Chromium (mock board): dock height only decreases during close, expanded and folded; seam gap to the tracker stays 0; no errors. Real site not run.

## Tight links drawer, status on the Jira button, footer fade (2026-10-24)
- HYVE drawer (open, seam mode): the tab is only the header-height square in the outer corner and the drawer runs under it (margin -30px, head margin 26px), so the honeycomb spans the whole dock; dock is 30 px narrower, bottom padding 12. HYVE_DOCK_OPEN_WIDTH 348 -> 318. Close animation also animates the drawer margin.
- paintResponse: the separate response chip and preview row are gone. The Jira button gets a short status word first (Waiting / Replied / ... / Sign in / No data); full wording is the word's tooltip, first comment is a "Response:" line in the button tooltip. CSS `.eve-jira-resp`; blue dot hidden when the word is shown; footer chip tightened so the time stays on one line.
- foldTrackerBody: only the first 4 rows stagger in; page dots and the GitHub footer ride with the body (they were the last to fade, ~280-450 ms).
- Chromium (mock board): drawer and four dock states aligned, close shrink still monotonic and glued, footer opacity reaches 1 with the body (~300 ms); real site not run.

## Collector-driven release label, spacing, name (2026-10-24)
- syncCard: after a retest-path send the bar follows the Collector proof (same releaseOf/isReleased used by the Released-for-retest box): SENT TO REPAIR until Collector shows repair, WAITING FOR RELEASE (blue, "in repair hh:mm") while it is in repair, READY FOR RETEST (green, "back in SLT hh:mm") once it is back at a Bulk Start approved state. data-wait='ready', toggle class `ready`; Quick Actions row says Ready for Retest. pollRelease repaints the cards after every lookup, not only at completion.
- Footer: the empty page-dot band is gone without Developer mode (footer margin 8px), first row margin-top 6px.
- HYVE drawer: 10 px on all four sides of the honeycomb (outline included), drawer 316 px, HYVE_DOCK_OPEN_WIDTH 326.
- Author name "by Zay Davidson" is bold (.eve-title-by).
- Chromium (mock board): spacing measured 9.9/10/10/9.9; dock states aligned; send flow SENT -> WAITING; a seeded complete proof shows READY FOR RETEST. The poll step from OUT to SLT over real time was not run end to end (the harness reloads the page after ~30 s); real site not run.

## Fold/expand snapping (2026-10-24)
- Cause 1: the body's first-row margin collapsed through the body once the fold ended (the body is clipped, so not collapsed, while it animates), so Tracker Controls and the footer jumped up 4px at the end. `.eve-tracker-body { display: flow-root }` keeps the same layout throughout.
- Cause 2: the title row's bottom padding/margin/border changed instantly when the class toggled, so the panel jumped ~12px at the start. Those now ease over 220 ms (border keeps its width, colour fades).
- placeHyveDock foldedBar leaves out the easing title padding so the open drawer's header height stays steady during the fold.
- Chromium (mock board): per-frame trace of title, Tracker Controls, footer and panel height is continuous (the 4px end jump is gone, the footer opacity follows the body); dock states aligned. Real site not run.

## Fold closes the links (2026-10-24)
- addProfileNavigation: after the tracker's minus button folds the tracker, an open HYVE drawer closes too (same shrink animation). Unfolding never opens it, and the two keep independent open/closed states otherwise (links can still be opened while the tracker is folded).
- Chromium (mock board): all combinations checked, no errors; real site not run.

## Hexagon hover sway (2026-10-24)
- addProfileNavigation + `.eve-quick-cell:hover .eve-quick-face`: the lifted hexagon also leans toward the cursor (up to 3 px and 2 degrees, eased by the existing .15 s transition) through --hx/--hy/--hr set on pointermove and cleared on pointerleave. Look, lift, glow and click targets unchanged; off for reduced motion and touch.
- Chromium (mock board): centre = the old lift exactly, off-centre shifts and tilts, resets on leave, link unchanged, no errors; real site not run.

## No resend, serial + location on one line (2026-10-24)
- renderSend / renderReady: when a send is already on record for the open request (from this tracker or seen in the SFCS queue) and nothing newer asks for another, the box no longer offers "Send again" or the symptom pick. It shows "Sent to repair at ..." (or "Already sent to repair") with the workflow pill and the existing next steps: physical transfer, or Awaiting release for retest (Released for retest once Collector proves it). A newer request that asks for a send still gets the Send button.
- renderId: serial and rack location share one line; the MFGS ticket key text is removed (the card already shows it).
- Chromium (mock board, seeded sent record): retest and physical both show only the next steps, no send button, no errors. Real site not run.

## Collector decides released (2026-10-24)
- isReleased / observeRelease: the proof no longer needs an OUT lookup from before the send. Repair then an approved Bulk Start state is enough, and a send whose check already saw Repair (sent.pos, verified) counts as the repair step, so a unit that Collector now shows at an approved state flips to READY FOR RETEST at the next poll (every 3 min for 6 h after the send, then 10 min). While Collector shows Repair it stays WAITING FOR RELEASE. An OUT lookup still strengthens the proof when present. releaseProgress only warns about a missing OUT while unresolved.
- Chromium (mock board, seeded sent record): collector in Repair -> WAITING FOR RELEASE; collector at SLT -> READY FOR RETEST within one poll; no errors. Real site not run.

## Retesting state (2026-10-24)
- observeRelease: once Collector has shown Repair for the send (or the send's own check saw it), any later non-Repair position means Repair let it go: approved state -> READY FOR RETEST, any other state (a test running) -> RETESTING (green, "now <label> hh:mm"). Back in Repair -> WAITING FOR RELEASE again. Before, only an approved label counted, so a unit that was released and already testing stayed on WAITING FOR RELEASE.
- pollRelease keeps reading a released unit every 3 min for 6 h so READY -> RETESTING (or back to Repair) follows Collector; the "Released for retest" desktop alert still fires once.
- afterRelease(), releasedBox ("Released and retesting"), Quick Actions row "Retesting".
- Chromium (mock board, seeded sent record): Repair -> WAITING, SLT -> READY, SLT IN and WIP -> RETESTING; no errors. Real site not run.

## Live release / retesting refresh
- The repair bar (waiting, ready, retesting) now repaints on its own, with no click on the card. Before, only the page that won the Collector lookup repainted; every other open page kept the old bar until you opened the card. Every page now checks the stored send and Collector records every 10 s and repaints a changed unit.
- Collector is read for each sent unit about once a minute (was every 3 min) during the first 6 h.
- Checked on the mock board only, two pages sharing storage: RETESTING showed on both in 10-13 s and READY FOR RETEST in 16-20 s after the mock Collector changed, with no click. Real site not run.
