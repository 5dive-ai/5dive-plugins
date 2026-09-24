#!/usr/bin/env bash
# plugins/telegram-codex/release.sh — canary, promote and roll back the Codex
# channel bridge on ONE box (DIVE-3969, P10).
#
#   release.sh status                 live and previous versions
#   release.sh check   <tree>         preflight a tree against this box's Codex
#                                     and saved state; starts nothing
#   release.sh promote <tree>         check, then make <tree> live; the old live
#                                     tree is kept as the rollback target
#   release.sh rollback               swap live and previous back (run it again
#                                     to roll forward)
#
# The live tree is $LIB_DIR/telegram-codex (default /usr/local/lib/5dive), the
# path 5dive-agent-start launches. <tree> must already have its dependencies
# (`bun install --production` inside it). Nothing here restarts a seat: the
# running dispatcher keeps the code it booted with until `5dive agent restart`.
#
# Run `check` as the seat user (sudo -u agent-<name> -H ...) so the saved state
# it reads is that seat's. promote/rollback write $LIB_DIR and need root.
set -euo pipefail

LIB_DIR="${LIB_DIR:-/usr/local/lib/5dive}"
BUN="${BUN:-bun}"
LIVE="$LIB_DIR/telegram-codex"
PREV="$LIVE.prev"

die() { printf 'release.sh: %s\n' "$*" >&2; exit 1; }

version_of() {
  local v
  v=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$1/package.json" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  printf '%s' "${v:-none}"
}

check_tree() {
  local tree="$1"
  [[ -f "$tree/dispatcher.ts" && -f "$tree/package.json" ]] \
    || die "$tree is not a telegram-codex tree (no dispatcher.ts/package.json)"
  # A tree from before 0.5.20 does not know --check and would START a real
  # dispatcher (app-server plus a Telegram poller on whatever token is in the
  # environment). Measured once, by accident, on the build that wrote this.
  grep -q -- "'--check'" "$tree/dispatcher.ts" \
    || { printf 'release.sh: %s (%s) predates --check; no preflight available\n' "$tree" "$(version_of "$tree")" >&2; return 2; }
  "$BUN" "$tree/dispatcher.ts" --check
}

cmd="${1:-}"
case "$cmd" in
  status)
    printf 'live %s (%s)\n' "$(version_of "$LIVE")" "$LIVE"
    printf 'prev %s (%s)\n' "$(version_of "$PREV")" "$PREV"
    ;;
  check)
    [[ -n "${2:-}" ]] || die "usage: release.sh check <tree>"
    check_tree "$2"
    ;;
  promote)
    [[ -n "${2:-}" ]] || die "usage: release.sh promote <tree>"
    cand=$(cd "$2" && pwd)
    [[ "$cand" != "$LIVE" ]] || die "the candidate is already the live tree"
    check_tree "$cand" >/dev/null || die "preflight refused $cand — nothing was changed"
    # Copy first, swap second: the only window in which the live path is
    # missing is between two renames on one filesystem.
    rm -rf "$LIVE.next"
    cp -a "$cand" "$LIVE.next"
    if [[ -d "$LIVE" ]]; then
      rm -rf "$PREV"
      mv "$LIVE" "$PREV"
    fi
    mv "$LIVE.next" "$LIVE"
    printf 'promoted %s -> live (previous %s kept at %s)\n' "$(version_of "$LIVE")" "$(version_of "$PREV")" "$PREV"
    printf 'next: sudo 5dive agent restart <codex seat>, one seat first; rollback: %s rollback\n' "$0"
    ;;
  rollback)
    [[ -d "$PREV" ]] || die "no previous tree at $PREV — nothing to roll back to"
    rm -rf "$LIVE.next"
    mv "$PREV" "$LIVE.next"
    [[ -d "$LIVE" ]] && mv "$LIVE" "$PREV"
    mv "$LIVE.next" "$LIVE"
    printf 'rolled back: live %s, previous %s\n' "$(version_of "$LIVE")" "$(version_of "$PREV")"
    # Report, never block: a rollback is how you get OUT of a bad state.
    rc=0; check_tree "$LIVE" >/dev/null || rc=$?
    [[ $rc -eq 1 ]] && printf 'warning: the restored tree fails its own preflight — see: %s check %s\n' "$0" "$LIVE" >&2
    printf 'next: sudo 5dive agent restart <codex seat>\n'
    ;;
  *)
    die "usage: release.sh status | check <tree> | promote <tree> | rollback"
    ;;
esac
