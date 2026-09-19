#!/usr/bin/env bash
#
# The CHANGELOG is the release gate. `bump.yml` moves the version on every merge, but it only
# tags — and therefore only releases — when `## [Unreleased]` holds something a human wrote.
#
# The reasoning is worth keeping: the entries in this changelog explain *why* a fix mattered
# and quote real measurements ("~430 ms to ~190 ms against ~900 ms cold"), which no commit-log
# generator can produce. So the notes stay hand-written, and the act of writing them becomes
# the release signal — an act the maintainer was going to perform anyway, rather than a second
# ceremony bolted beside it. A release can then never ship with invented notes, and a merge
# that lands with the section empty simply moves the version and waits: the next merge that
# finds notes releases everything that has accumulated since.
#
# Subcommands, all idempotent, all operating on $CHANGELOG_FILE (default CHANGELOG.md):
#
#   has-notes          exit 0 if `## [Unreleased]` holds anything but whitespace, 1 if not
#   open               insert an empty `## [Unreleased]` heading if the file has none
#   stamp <version>    rewrite `## [Unreleased]` as an empty `## [Unreleased]` followed by
#                      `## [<version>] - <date>`, so the notes end up under the version that
#                      is about to be tagged and the next contributor still has a place to
#                      write. This is exactly what the hand-cut releases did (the 0.3.0
#                      release commit changed CHANGELOG.md by one line), plus the re-opening.
#
# The date is HEAD's *author* date, `--date=short`, which carries the author's own timezone.
# UTC would be wrong here often enough to matter: 0.3.0 was released at 00:54 +0200 and is
# dated 2026-09-19 in this file, where UTC would have stamped it 2026-09-18.

set -euo pipefail

FILE="${CHANGELOG_FILE:-CHANGELOG.md}"
HEADING='## [Unreleased]'

die() {
  echo "changelog.sh: $*" >&2
  exit 1
}

[ -f "$FILE" ] || die "no $FILE here"

case "${1:-}" in
  has-notes)
    # Everything between the Unreleased heading and the next `## ` heading. `### Fixed` does
    # not match `^## ` (the third character is a `#`, not a space), so the subsections that
    # make up a real entry are counted as content, which is the whole point.
    if awk '
      /^## \[Unreleased\]/ { inside = 1; next }
      /^## / { if (inside) exit }
      inside && /[^[:space:]]/ { found = 1; exit }
      END { exit(found ? 0 : 1) }
    ' "$FILE"; then
      echo "notes=yes"
    else
      echo "notes=no"
    fi
    ;;

  open)
    if ! grep -q "^$(printf '%s' "$HEADING" | sed 's/[][]/\\&/g')" "$FILE"; then
      awk 'NR == 1 { print; print ""; print "## [Unreleased]"; next } 1' \
        "$FILE" >"$FILE.next" && mv "$FILE.next" "$FILE"
      echo "opened a fresh $HEADING"
    else
      echo "$HEADING is already open"
    fi
    ;;

  stamp)
    VERSION="${2:-}"
    [ -n "$VERSION" ] || die 'stamp needs a version: changelog.sh stamp 0.3.1'
    DATE="${3:-$(git log -1 --format=%ad --date=short HEAD)}"
    # Refusing rather than stamping an empty section: a heading with a date under it and
    # nothing beneath is the exact lie this gate exists to prevent.
    grep -q '^## \[Unreleased\]' "$FILE" || die "no $HEADING in $FILE to stamp"
    awk -v version="$VERSION" -v date="$DATE" '
      !stamped && /^## \[Unreleased\]/ {
        print "## [Unreleased]"
        print ""
        print "## [" version "] - " date
        stamped = 1
        next
      }
      { print }
    ' "$FILE" >"$FILE.next" && mv "$FILE.next" "$FILE"
    echo "stamped ## [$VERSION] - $DATE"
    ;;

  *)
    sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;$d'
    exit 2
    ;;
esac
