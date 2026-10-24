# EVE SLT+JBOG TRACKER

Current script: **EVE SLT TRACKER 3.1.2**, `EVE_SLT_TRACKER.user.js` (notes in
`CHANGELOG-3.1.2.md`; mock-board checks only). The legacy **2.0.2**
`EVE_SLT_JBOG_TRACKER.user.js`, its compatibility copy and the tests below
are kept unchanged; AGENTS.md describes that legacy script.

Read [AGENTS.md](AGENTS.md) first. It is the shared ChatGPT/Codex/Claude
handoff: current architecture, constraints, behavior invariants and a
function-level change map. Read only the source and deeper notes relevant
to the requested edit; do not reload the full repository for each task.

Before any coding task (write, fix, refactor, review), invoke the `ponytail`
skill (`.claude/skills/ponytail/SKILL.md`). This file, AGENTS.md and the
user's current instructions win where they conflict with it.

Use [docs/TESTING.md](docs/TESTING.md) for coverage/commands and
[docs/LION_KING_QA.md](docs/LION_KING_QA.md) for evidence and limits.
Follow the user's current instructions; an explicit merge request authorizes
publishing to `main`. Run the relevant tests after a change and report actual
results. Preserve the existing browser storage keys.
