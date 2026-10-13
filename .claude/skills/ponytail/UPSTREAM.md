# Upstream

Verbatim copy of `skills/ponytail/SKILL.md` and `LICENSE` from
https://github.com/DietrichGebert/ponytail (MIT), plugin v5.2.0, fetched
2026-10-13 from `main`. Do not edit `SKILL.md` here; refresh it from upstream
instead so the diff stays readable.

Only the skill prompt is vendored. The upstream plugin's session hooks and
`/ponytail-*` slash commands are not part of this copy; install the plugin
locally if you want them:

    /plugin marketplace add DietrichGebert/ponytail
    /plugin install ponytail@ponytail

Cloud sessions do not install plugins declared in `.claude/settings.json`, but
they do load `.claude/skills/`, which is why the skill is committed here.

To remove: delete `.claude/skills/ponytail/`.
