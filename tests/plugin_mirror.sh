#!/usr/bin/env bash
# plugins/<p> IS 5dive-ai/5dive-<p>'s <p>/, byte for byte. One script for every
# plugin that has its own repo: browser (DIVE-8050), phone (DIVE-9230). Called as
# tests/<p>_mirror.sh, a two-line wrapper that names the plugin.
#
# WHY THIS FILE EXISTS. The browser registry copy was synced byte-for-byte on 10-02
# (DIVE-5389) and then took four hand ports. Three of them never reached
# 5dive-browser, and 87 upstream commits never reached here: `act` upload
# (DIVE-7237) and the rc-133 crash fix (DIVE-7432) among them, while the app's
# one-click install still names this copy. The same lag was fixed once before
# (DIVE-5386). Each sync was a merge of hand-kept harness copies, so nobody did it.
#
# THE CONTRACT NOW:
#   check   plugins/<p>'s git tree equals <p>/ at some commit on 5dive-<p> main
#           (or, on a PR, at the head of the same-named 5dive-<p> branch, whose
#           merge must come first). A hand edit here matches nothing and is red:
#           the fix goes upstream first, then `sync`. Being behind main is a
#           warning that names the gap, not a red: a red on every unrelated PR
#           here would teach people to ignore it.
#   run     5dive-<p>'s OWN harnesses, from the matched commit, with its <p>/
#           replaced by a copy of this tree. No hand-kept copies to drift: the
#           harness is the one that graded the bytes upstream.
#   sync    rsync <p>/ from a 5dive-<p> ref (default origin/main) into
#           plugins/<p>. The whole port is this one command.
#
# usage: bash tests/<p>_mirror.sh check
#        bash tests/<p>_mirror.sh run [--npm] <harness.sh>...
#        bash tests/<p>_mirror.sh sync [<ref>]
#        (the same as: bash tests/plugin_mirror.sh <p> check|run|sync ...)
# env:   <P>_UPSTREAM_DIR  a 5dive-<p> clone to use (cloned if absent)
#        <P>_MIRROR_BRANCH a same-named upstream branch also accepted by check
#        <P>_UPSTREAM_URL  default https://github.com/5dive-ai/5dive-<p>.git
#        <P> is the plugin name in capitals: BROWSER_UPSTREAM_DIR, PHONE_MIRROR_BRANCH.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
P="${1:-}"; shift || :
[[ "$P" =~ ^[a-z][a-z0-9-]*$ && -d "$ROOT/plugins/$P" ]] || { sed -n '2,33p' "$0"; exit 2; }
REPO="5dive-$P" PU="$(printf '%s' "$P" | tr 'a-z-' 'A-Z_')"
MIRROR_REL="plugins/$P"
_env() { local v="${PU}_$1"; printf '%s' "${!v:-}"; }
URL="$(_env UPSTREAM_URL)"; URL="${URL:-https://github.com/5dive-ai/$REPO.git}"
WORK="$(mktemp -d)"; trap 'rm -rf -- "$WORK"' EXIT
UP="$(_env UPSTREAM_DIR)"; UP="${UP:-$WORK/$REPO}"
BRANCH="$(_env MIRROR_BRANCH)"

say() { printf '%s\n' "$*"; }
die() { printf '%s-mirror: %s\n' "$P" "$*" >&2; exit 1; }

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

mirror_tree() {  # the git tree of plugins/<p> as it is on disk, committed or not
  local idx="$WORK/index"
  GIT_INDEX_FILE="$idx" git -C "$ROOT" read-tree HEAD \
    && GIT_INDEX_FILE="$idx" git -C "$ROOT" add -A -- "$MIRROR_REL" \
    && GIT_INDEX_FILE="$idx" git -C "$ROOT" write-tree --prefix="$MIRROR_REL/"
}

version_at() { git -C "$UP" show "$1:$P/.claude-plugin/plugin.json" 2>/dev/null | jq -r .version; }

# MATCH (the upstream commit), BEHIND (<p> commits on main after it), SRC
match() {
  local want c n=0; want="$(mirror_tree)" || die "cannot read the tree of $MIRROR_REL"
  MATCH="" BEHIND=0 SRC=""
  while read -r c; do
    if [[ "$(git -C "$UP" rev-parse -q --verify "$c:$P" 2>/dev/null)" == "$want" ]]; then
      MATCH="$c" BEHIND="$n" SRC=main; return 0
    fi
    n=$((n + 1))
  done < <(git -C "$UP" log --format=%H origin/main -- "$P")
  if [[ -n "$BRANCH" && "$(git -C "$UP" rev-parse -q --verify "origin/$BRANCH:$P" 2>/dev/null)" == "$want" ]]; then
    MATCH="$(git -C "$UP" rev-parse "origin/$BRANCH")" SRC="branch $BRANCH"; return 0
  fi
  return 1
}

cmd_check() {
  upstream
  local mv; mv="$(jq -r .version "$ROOT/$MIRROR_REL/.claude-plugin/plugin.json")"
  if ! match; then
    say "FAIL: $MIRROR_REL ($mv) is not byte-for-byte any $REPO main commit${BRANCH:+ nor branch $BRANCH}."
    say "      A change to $P lands in 5dive-ai/$REPO first; then: bash tests/${P}_mirror.sh sync"
    say "      What differs from main:"
    git -C "$UP" archive origin/main "$P" | tar -x -C "$WORK"
    diff -rq "$WORK/$P" "$ROOT/$MIRROR_REL" | sed 's/^/        /' | head -40
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::error title=%s mirror::%s is not a %s commit; sync it from upstream, never hand-edit it\n' "$P" "$MIRROR_REL" "$REPO"
    return 1
  fi
  local mainv; mainv="$(version_at origin/main)"
  if [[ "$SRC" != main ]]; then
    say "OK (pending): $MIRROR_REL $mv == $REPO ${MATCH:0:7} on $SRC, not on main yet. Merge $REPO first."
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::warning title=%s mirror::matches %s %s, which is not on main yet: merge that PR first\n' "$P" "$REPO" "$SRC"
  elif (( BEHIND > 0 )); then
    say "OK (behind): $MIRROR_REL $mv == $REPO ${MATCH:0:7}; main is $BEHIND $P commit(s) ahead, at $mainv. Sync: bash tests/${P}_mirror.sh sync"
    [[ -n "${GITHUB_ACTIONS:-}" ]] && printf '::warning title=%s mirror behind::%s is %s, %s main is %s (%s commits). Run: bash tests/%s_mirror.sh sync\n' "$P" "$MIRROR_REL" "$mv" "$REPO" "$mainv" "$BEHIND" "$P"
  else
    say "OK: $MIRROR_REL $mv == $REPO main ${MATCH:0:7}"
  fi
  return 0
}

cmd_run() {
  local npm=0; [[ "${1:-}" == --npm ]] && { npm=1; shift; }
  (( $# )) || die "run needs at least one harness name (a file in $REPO's tests/)"
  upstream
  match || die "$MIRROR_REL matches no $REPO commit; run 'check' for the difference"
  local tree="$WORK/tree"
  git -C "$UP" worktree add -q --detach "$tree" "$MATCH" || die "cannot check out $REPO ${MATCH:0:7}"
  rm -rf -- "$tree/$P"
  cp -a "$ROOT/$MIRROR_REL" "$tree/$P"
  rm -rf -- "$tree/$P/node_modules"
  if (( npm )); then
    npm install --prefix "$tree/$P" --no-audit --no-fund >/dev/null || die "npm install in the copied tree failed"
  fi
  say "harnesses from $REPO ${MATCH:0:7} ($SRC), $P/ = this repo's $MIRROR_REL"
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
  git -C "$UP" archive "$ref" "$P" | tar -x -C "$WORK" || die "cannot read $P/ at $ref"
  rsync -a --delete --exclude=/node_modules "$WORK/$P/" "$ROOT/$MIRROR_REL/" || die "rsync failed"
  say "synced $MIRROR_REL to $REPO $(git -C "$UP" rev-parse --short "$ref") ($(version_at "$ref"))."
  say "Add a CHANGES.md line naming the version, then: bash tests/${P}_mirror.sh check"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  run)   shift; cmd_run "$@" ;;
  sync)  shift; cmd_sync "$@" ;;
  *) sed -n '2,33p' "$0"; exit 2 ;;
esac
