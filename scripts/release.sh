#!/usr/bin/env bash
#
# Cut a release.
#
#   ./scripts/release.sh patch "Fix flap protection swallowing swaps"
#   ./scripts/release.sh minor "Add stuck-server detection"
#   ./scripts/release.sh major "Rewrite state model"
#
# Bumps the userscript header/fallback and package metadata together,
# prepends a CHANGELOG
# entry, commits, tags and pushes. The release workflow picks up the tag
# and publishes a GitHub Release.

set -euo pipefail

SCRIPT="EVE_SLT_JBOG_TRACKER.user.js"
LEGACY_SCRIPT="EVE SLT+JBOG TRACKER.user.js"
CHANGELOG="CHANGELOG.md"

LEVEL="${1:-}"
MESSAGE="${2:-}"

if [[ -z "$LEVEL" || -z "$MESSAGE" ]]; then
    echo "usage: $0 <major|minor|patch> \"<summary>\"" >&2
    exit 2
fi

if [[ ! "$LEVEL" =~ ^(major|minor|patch)$ ]]; then
    echo "error: level must be major, minor or patch" >&2
    exit 2
fi

# Refuse to release from a dirty tree or a non-main branch: the whole
# point is that main == what users download.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$BRANCH" != "main" ]]; then
    echo "error: releases are cut from main (you are on $BRANCH)" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is dirty. Commit or stash first." >&2
    exit 1
fi

CURRENT="$(grep -oP '^// @version\s+\K\S+' "$SCRIPT")"

if [[ ! "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "error: @version '$CURRENT' is not X.Y.Z" >&2
    exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

case "$LEVEL" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
esac

NEXT="${MAJOR}.${MINOR}.${PATCH}"

echo "  $CURRENT  ->  $NEXT"
echo "  $MESSAGE"
echo

read -r -p "Proceed? [y/N] " REPLY
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }

# --- bump all current version fields ----------------------------------
# The fallback spans lines; a line-oriented substitution would miss it.
# Dependency resolutions stay put.
node --input-type=module - "$SCRIPT" "$NEXT" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [, , scriptPath, version] = process.argv;
const source = readFileSync(scriptPath, 'utf8');
const header = /^\/\/ @version[ \t]+\S+[ \t]*$/m;
const fallback = /(GM_info\.script\.version\s*:\s*)'[^']*'/;
if (!header.test(source) || !fallback.test(source)) {
    throw new Error('Missing userscript header or SCRIPT_VERSION fallback; no version fields changed.');
}
writeFileSync(scriptPath, source
    .replace(header, '// @version      ' + version)
    .replace(fallback, (_match, prefix) => prefix + "'" + version + "'"));
for (const file of ['package.json', 'package-lock.json']) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.version = version;
    if (data.packages?.['']) data.packages[''].version = version;
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
JS

cp -- "$SCRIPT" "$LEGACY_SCRIPT"

node --check "$SCRIPT"
node scripts/validate-header.mjs "$SCRIPT"

# --- prepend the changelog entry ---------------------------------------
TODAY="$(date +%Y-%m-%d)"

if [[ ! -f "$CHANGELOG" ]]; then
    printf '# Changelog\n\n' > "$CHANGELOG"
fi

TMP="$(mktemp)"
{
    head -n 1 "$CHANGELOG"
    printf '\n## [%s] - %s\n\n- %s\n' "$NEXT" "$TODAY" "$MESSAGE"
    tail -n +2 "$CHANGELOG"
} > "$TMP"
mv "$TMP" "$CHANGELOG"

# --- commit, tag, push -------------------------------------------------
git add "$SCRIPT" "$LEGACY_SCRIPT" "$CHANGELOG" package.json package-lock.json
git commit -m "release: v${NEXT}

${MESSAGE}"

git tag -a "v${NEXT}" -m "v${NEXT} - ${MESSAGE}"

git push origin main
git push origin "v${NEXT}"

echo
echo "Released v${NEXT}."
echo "Users will be offered the update on their next Tampermonkey check."
