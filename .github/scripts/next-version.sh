#!/usr/bin/env bash
#
# Works out the version the next release should carry, from the gitmoji of the commits that
# landed since the last `vX.Y.Z` tag. This repository uses gitmoji, not Conventional Commits
# (see CONTRIBUTING.md), so the emoji is the only machine-readable intent a commit carries —
# and it is one the house style already enforces on every PR title.
#
# Two properties are worth understanding before changing anything here:
#
#   * The base is the last tag, never `package.json`. Bumping relative to the current version
#     would inflate it once per merge — five patch merges between releases would ship 0.3.5
#     for one release's worth of work. Bumping relative to the tag makes the answer a pure
#     function of "what has landed since the last release", so the version on `main` is always
#     the version the next release will carry, and re-running is a no-op instead of a bump.
#   * A commit with no recognised gitmoji contributes nothing. That is what makes the merge
#     commits (`Merge pull request #1 from …`) harmless, and it is why `--explain` lists every
#     commit it skipped: a silent zero and an honest zero look the same from the outside.
#
# Level per emoji. The variation selector (U+FE0F) is stripped before matching, because `♻️`
# and `♻` are the same intent and both occur in the wild.
#
#   major   💥                                     breaking change
#   minor   ✨ 🏗️                                   new feature, architecture change
#   patch   🐛 🚑 🩹 ♻️ 🎨 💄 🔥 🔧 📦 ➕ ➖ ⬆️ ⬇️ 🚨 ⚡ 🌐 🔒 🥅 🗃️ 🖼️ 🚸 🏷️
#   none    📝 ✅ 👷 💚 🔖 💡 📸 🙈 🔀            nothing a user could install
#
# While the major is 0, a detected 💥 yields a *minor* — the usual pre-1.0 reading of semver,
# and the alternative is that one emoji silently declares 1.0.0. Going to 1.0.0 stays a
# deliberate act: `--level major --explicit` (what `workflow_dispatch` sends).
#
# Two markers in a commit message override the emoji, and both are permanent rather than
# per-run: the range is recomputed from the tag every time, so a marker that only affected the
# run that first saw it would be quietly undone by the next merge.
#
#   [skip bump] / [no bump]        this commit contributes nothing
#   [bump patch|minor|major]       this commit contributes exactly that
#
# The override is not decoration. Replaying the mapping over this repository's own history,
# every range but one reproduced the version that was released by hand; 0.3.0 came out as
# 0.2.3, because the Pokédex search and the compact-card queue row — two features — landed
# inside squash commits subjected `🎨 Make the panel readable…` and `🐛 Keep wild Pokémon
# appearing…`. The emoji described the largest part of the change, not the shippable new thing
# inside it. That is the standing cost of deriving semver from gitmoji, and `[bump minor]` in
# the PR body is the cheap way to pay it when it happens.
#
# Usage:
#   next-version.sh [--explain] [--since <ref>] [--until <ref>] [--current <version>]
#                   [--level <major|minor|patch>] [--explicit]
#
# `--since`/`--until`/`--current` exist so the decision can be replayed over history without
# checking anything out — `--since v0.2.2 --until v0.3.0^ --current 0.2.2` answers "what would
# this have set when the last PR before 0.3.0 merged?", which is how the mapping was checked
# against the four releases that already exist.
#
# Prints machine-readable `key=value` lines on stdout (feed it straight into $GITHUB_OUTPUT);
# `--explain` writes the per-commit reasoning to stderr, so both can be captured separately.
#
# `tagged=` says whether `v<next>` already exists, and it is not decoration: it is how the
# release gate in bump.yml stays correct when the notes arrive *after* the bump. A 🐛 merge
# with an empty changelog leaves 0.3.1 on `main` untagged; the next merge may be 📝-only, so
# `bump=no` — but 0.3.1 is still unreleased, and if the notes are there by then it must go
# out. The question the gate asks is "is this version tagged yet", never "did I just move it".

set -euo pipefail

EXPLAIN=0
SINCE=''
UNTIL='HEAD'
CURRENT_OVERRIDE=''
FORCED_LEVEL=''
EXPLICIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --explain) EXPLAIN=1 ;;
    --since) SINCE="${2:-}"; shift ;;
    --until) UNTIL="${2:-}"; shift ;;
    --current) CURRENT_OVERRIDE="${2:-}"; shift ;;
    --level) FORCED_LEVEL="${2:-}"; shift ;;
    --explicit) EXPLICIT=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;$d'; exit 0 ;;
    *) echo "next-version.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

log() { [ "$EXPLAIN" -eq 1 ] && printf '%s\n' "$*" >&2 || true; }

# The first whitespace-delimited token of the subject, minus the variation selector. Written
# with byte escapes rather than $'️' so it also runs on the bash 3.2 that ships on macOS.
level_of() {
  local subject="$1" token
  token="${subject#"${subject%%[![:space:]]*}"}"
  token="${token%% *}"
  token="${token//$'\xef\xb8\x8f'/}"
  case "$token" in
    '💥'|':boom:') echo major ;;
    '✨'|':sparkles:'|'🏗'|':building_construction:') echo minor ;;
    '🐛'|':bug:'|'🚑'|':ambulance:'|'🩹'|':adhesive_bandage:'|'♻'|':recycle:'|'🎨'|':art:'|\
    '💄'|':lipstick:'|'🔥'|':fire:'|'🔧'|':wrench:'|'📦'|':package:'|'➕'|':heavy_plus_sign:'|\
    '➖'|':heavy_minus_sign:'|'⬆'|':arrow_up:'|'⬇'|':arrow_down:'|'🚨'|':rotating_light:'|\
    '⚡'|':zap:'|'🌐'|':globe_with_meridians:'|'🔒'|':lock:'|'🥅'|':goal_net:'|\
    '🗃'|':card_file_box:'|'🖼'|':frame_photo:'|'🚸'|':children_crossing:'|'🏷'|':label:') echo patch ;;
    *) echo none ;;
  esac
}

rank_of() {
  case "$1" in
    major) echo 3 ;;
    minor) echo 2 ;;
    patch) echo 1 ;;
    *) echo 0 ;;
  esac
}

# Never lowers a component, and never crosses 0.x → 1.0.0 on a guess (see the header).
apply_bump() {
  local base="$1" level="$2" major minor patch
  IFS=. read -r major minor patch <<EOF
$base
EOF
  case "$level" in
    major)
      if [ "$major" -eq 0 ] && [ "$EXPLICIT" -eq 0 ]; then
        minor=$((minor + 1)); patch=0
      else
        major=$((major + 1)); minor=0; patch=0
      fi
      ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
  esac
  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

# Returns 0 when $1 is strictly greater than $2.
version_gt() {
  local a="$1" b="$2" a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<EOF
$a
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$b
EOF
  [ "$a1" -ne "$b1" ] && { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -gt "$b3" ]
}

CURRENT="${CURRENT_OVERRIDE:-$(node -p "require('./package.json').version")}"

LAST_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "$UNTIL" 2>/dev/null || true)"
RANGE_START="${SINCE:-$LAST_TAG}"

if [ -n "$RANGE_START" ]; then
  BASE="${RANGE_START#v}"
  RANGE="$RANGE_START..$UNTIL"
else
  # No tag yet: there is nothing to measure from but the manifest itself.
  BASE="$CURRENT"
  RANGE="$UNTIL"
fi

case "$BASE" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    # A `--since` that is not a version tag (a SHA, `HEAD~40`) can still be classified; it just
    # cannot say what the number would become, so fall back to the manifest for the arithmetic.
    log "base '$BASE' is not a version — measuring the level only, from $CURRENT"
    BASE="$CURRENT"
    ;;
esac

LEVEL=none
if [ -n "$FORCED_LEVEL" ]; then
  LEVEL="$FORCED_LEVEL"
  log "level forced to $LEVEL"
else
  log "range $RANGE (base $BASE, package.json $CURRENT)"
  log ''
  # Resolved before the loop, and fatally: a range git cannot parse (a tag that was never
  # pushed, a shallow checkout with no history) makes `git rev-list` fail *inside* the `for`
  # list, where the loop simply runs zero times and the run reports a confident `level=none`.
  # A missing tag and a quiet week must not look the same.
  if ! COMMITS="$(git rev-list "$RANGE")"; then
    echo "next-version.sh: cannot resolve the commit range '$RANGE'" >&2
    exit 1
  fi
  for sha in $COMMITS; do
    subject="$(git log -1 --format=%s "$sha")"
    message="$(git log -1 --format=%B "$sha")"
    commit_level="$(level_of "$subject")"
    marker=''
    case "$message" in
      *'[skip bump]'*|*'[no bump]'*) commit_level='none'; marker='  <- [skip bump]' ;;
      *'[bump major]'*) commit_level='major'; marker='  <- [bump major]' ;;
      *'[bump minor]'*) commit_level='minor'; marker='  <- [bump minor]' ;;
      *'[bump patch]'*) commit_level='patch'; marker='  <- [bump patch]' ;;
    esac
    log "$(printf '  %-6s %s  %s%s' "$commit_level" "${sha:0:7}" "$subject" "$marker")"
    if [ "$(rank_of "$commit_level")" -gt "$(rank_of "$LEVEL")" ]; then
      LEVEL="$commit_level"
    fi
  done
  log ''
fi

NEXT="$(apply_bump "$BASE" "$LEVEL")"

# Two reasons not to write: nothing shippable landed, or someone already moved the manifest
# past what the commits justify (a hand bump, or a release commit that has not been tagged).
# Lowering a version that is already published is worse than skipping a bump.
BUMP=yes
if [ "$LEVEL" = none ]; then
  BUMP=no
  NEXT="$CURRENT"
elif ! version_gt "$NEXT" "$CURRENT"; then
  log "computed $NEXT is not ahead of package.json $CURRENT — leaving it alone"
  BUMP=no
  NEXT="$CURRENT"
fi

TAGGED=no
if git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null; then
  TAGGED=yes
fi

log "=> level=$LEVEL current=$CURRENT next=$NEXT bump=$BUMP tagged=$TAGGED"

printf 'level=%s\n' "$LEVEL"
printf 'base=%s\n' "$BASE"
printf 'current=%s\n' "$CURRENT"
printf 'next=%s\n' "$NEXT"
printf 'bump=%s\n' "$BUMP"
printf 'tagged=%s\n' "$TAGGED"
