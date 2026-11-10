#!/usr/bin/env bash
# plugins/browser IS 5dive-ai/5dive-browser's browser/, byte for byte (DIVE-8050).
#
# WHY THIS FILE EXISTS. The registry copy was synced byte-for-byte on 10-02
# (DIVE-5389) and then took four hand ports. Three of them never reached
# 5dive-browser, and 87 upstream commits never reached here: `act` upload
# (DIVE-7237) and the rc-133 crash fix (DIVE-7432) among them, while the app's
# one-click install still names this copy. The same lag was fixed once before
# (DIVE-5386). Each sync was a merge of hand-kept harness copies, so nobody did it.
#
# THE CONTRACT NOW:
#   check   plugins/browser's git tree equals browser/ at some commit on
#           5dive-browser main (or, on a PR, at the head of the same-named
#           5dive-browser branch, whose merge must come first). A hand edit here
#           matches nothing and is red: the fix goes upstream first, then `sync`.
#           Being behind main is a warning that names the gap, not a red: a red
#           on every unrelated PR here would teach people to ignore it.
#   run     5dive-browser's OWN harnesses, from the matched commit, with its
#           browser/ replaced by a copy of this tree. No hand-kept copies to
#           drift: the harness is the one that graded the bytes upstream.
#   sync    rsync browser/ from a 5dive-browser ref (default origin/main) into
#           plugins/browser. The whole port is this one command.
#
# usage: bash tests/browser_mirror.sh check
#        bash tests/browser_mirror.sh run [--npm] <harness.sh>...
#        bash tests/browser_mirror.sh sync [<ref>]
# env:   BROWSER_UPSTREAM_DIR  a 5dive-browser clone to use (cloned if absent)
#        BROWSER_MIRROR_BRANCH a same-named upstream branch also accepted by check
#        BROWSER_UPSTREAM_URL  default https://github.com/5dive-ai/5dive-browser.git
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR_REL=plugins/browser
URL="${BROWSER_UPSTREAM_URL:-https://github.com/5dive-ai/5dive-browser.git}"
WORK="$(mktemp -d)"; trap 'rm -rf -- "$WORK"' EXIT
UP="${BROWSER_UPSTREAM_DIR:-$WORK/5dive-browser}"
BRANCH="${BROWSER_MIRROR_BRANCH:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'browser-mirror: %s\n' "$*" >&2; exit 1; }

upstream() {  # a full-history clone with origin/main and, when named, the branch
  if [[ ! -d "$UP/.git" ]]; then
    git clone -q --no-checkout "$URL" "$UP" || die "cannot clone $URL"
  else
    git -C "$UP" fetch -q origin '+refs/heads/main:refs/remotes/origin/main' || die "cannot fetch $URL main"
  fi
  if [[ -n "$BRANCH" ]]; then
    git -C "$UP" fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" 2>/dev/null || BRANCH=""
  fi
}

mirror_tree() {  # the git tree of plugins/browser as it is on disk, committed or not
  local idx="$WORK/index"
  GIT_INDEX_FILE="$idx" git -C "$ROOT" read-tree HEAD \
    && GIT_INDEX_FILE="$idx" git -C "$ROOT" add -A -- "$MIRROR_REL" \
    && GIT_INDEX_FILE="$idx" git -C "$ROOT" write-tree --prefix="$MIRROR_REL/"
}

version_at() { git -C "$UP" show "$1:browser/.claude-plugin/plugin.json" 2>/dev/null | jq -r .version; }

# MATCH (the upstream commit), BEHIND (browser commits on main after it), SRC
match() {
  local want c n=0; want="$(mirror_tree)" || die "cannot read the tree of $MIRROR_REL"
  MATCH="" BEHIND=0 SRC=""
  while read -r c; do
    if [[ "$(git -C "$UP" rev-parse -q --verify "$c:browser" 2>/dev/null)" == "$want" ]]; then
      MATCH="$c" BEHIND="$n" SRC=main; return 0
    fi
    n=$((n + 1))
  done < <(git -C "$UP" log --format=%H origin/main -- browser)
  if [[ -n "$BRANCH" && "$(git -C "$UP" rev-parse -q --verify "origin/$BRANCH:browser" 2>/dev/null)" == "$want" ]]; then
    MATCH="$(git -C "$UP" rev-parse "origin/$BRANCH")" SRC="branch $BRANCH"; return 0
  fi
  return 1
}

cmd_check() {
  upstream
  local mv; mv="$(jq -r .version "$ROOT/$MIRROR_REL/.claude-plugin/plugin.json")"
  if ! match; then
    say "FAIL: $MIRROR_REL ($mv) is not byte-for-byte any 5dive-browser main commit${BRANCH:+ nor branch $BRANCH}."
    say "      A change to the browser lands in 5dive-ai/5dive-browser first; then: bash tests/browser_mirror.sh sync"
    say "      What differs from main:"
    git -C "$UP" archive origin/main browser | tar -x -C "$WORK"
    diff -rq "$WORK/browser" "$ROOT/$MIRROR_REL" | sed 's/^/        /' | head -40
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::error title=browser mirror::%s is not a 5dive-browser commit; sync it from upstream, never hand-edit it\n' "$MIRROR_REL"
    return 1
  fi
  local mainv; mainv="$(version_at origin/main)"
  if [[ "$SRC" != main ]]; then
    say "OK (pending): $MIRROR_REL $mv == 5dive-browser ${MATCH:0:7} on $SRC, not on main yet. Merge 5dive-browser first."
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::warning title=browser mirror::matches 5dive-browser %s, which is not on main yet: merge that PR first\n' "$SRC"
  elif (( BEHIND > 0 )); then
    say "OK (behind): $MIRROR_REL $mv == 5dive-browser ${MATCH:0:7}; main is $BEHIND browser commit(s) ahead, at $mainv. Sync: bash tests/browser_mirror.sh sync"
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::warning title=browser mirror behind::%s is %s, 5dive-browser main is %s (%s commits). Run: bash tests/browser_mirror.sh sync\n' "$MIRROR_REL" "$mv" "$mainv" "$BEHIND"
  else
    say "OK: $MIRROR_REL $mv == 5dive-browser main ${MATCH:0:7}"
  fi
  return 0
}

cmd_run() {
  local npm=0; [[ "${1:-}" == --npm ]] && { npm=1; shift; }
  (( $# )) || die "run needs at least one harness name (a file in 5dive-browser's tests/)"
  upstream
  match || die "$MIRROR_REL matches no 5dive-browser commit; run 'check' for the difference"
  local tree="$WORK/tree"
  git -C "$UP" worktree add -q --detach "$tree" "$MATCH" || die "cannot check out 5dive-browser ${MATCH:0:7}"
  rm -rf -- "$tree/browser"
  cp -a "$ROOT/$MIRROR_REL" "$tree/browser"
  rm -rf -- "$tree/browser/node_modules"
  if (( npm )); then
    npm install --prefix "$tree/browser" --no-audit --no-fund >/dev/null || die "npm install in the copied tree failed"
  fi
  say "harnesses from 5dive-browser ${MATCH:0:7} ($SRC), browser/ = this repo's $MIRROR_REL"
  local h rc=0
  for h in "$@"; do
    [[ -f "$tree/tests/$h" ]] || { say "MISSING: tests/$h at ${MATCH:0:7}"; rc=1; continue; }
    say "=== $h"
    ( cd "$tree" && bash "tests/$h" ) || { say "RED: $h"; rc=1; }
  done
  git -C "$UP" worktree remove --force "$tree" >/dev/null 2>&1 || :
  return "$rc"
}

cmd_sync() {
  local ref="${1:-origin/main}"
  upstream
  git -C "$UP" rev-parse -q --verify "$ref^{commit}" >/dev/null || ref="origin/$ref"
  git -C "$UP" archive "$ref" browser | tar -x -C "$WORK" || die "cannot read browser/ at $ref"
  rsync -a --delete --exclude=/node_modules "$WORK/browser/" "$ROOT/$MIRROR_REL/" || die "rsync failed"
  say "synced $MIRROR_REL to 5dive-browser $(git -C "$UP" rev-parse --short "$ref") ($(version_at "$ref"))."
  say "Add a CHANGES.md line naming the version, then: bash tests/browser_mirror.sh check"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  run)   shift; cmd_run "$@" ;;
  sync)  shift; cmd_sync "$@" ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
