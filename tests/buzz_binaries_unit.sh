#!/usr/bin/env bash
# DIVE-6934 — the buzz binaries come with the plugin, not with core's install.sh.
#
# Carried from core's tests/install_buzz_binaries_unit.sh (DIVE-3554), retargeted
# at plugins/buzz/cli/binaries.sh: the same pinned tag, the same pinned
# SHA256SUMS digest, the same refusals. What changed is WHERE they land (inside
# the installed plugin, so `plugin remove buzz` removes them) and that a refusal
# is now an rc the verb reports, not an installer warning that must never abort.
#
# Run: bash tests/buzz_binaries_unit.sh   (no root, no network: file:// releases)
set -uo pipefail
trap 'rc=$?; rm -rf "${WORK:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=plugins/buzz/cli
# shellcheck source=/dev/null
source "$SRC/prelude.sh"
# shellcheck source=/dev/null
source "$SRC/binaries.sh"
# shellcheck source=/dev/null
source "$SRC/cmd_agent_buzz.sh"
# shellcheck source=/dev/null
source "$SRC/cmd_agent_buzz_pair.sh"

PASS=0; FAIL=0
ok_t(){ PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t(){ FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }
WORK="$(mktemp -d)"

[[ "$BUZZ_CLI_TAG" =~ ^cli-v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  && ok_t "the release is pinned to an explicit tag ($BUZZ_CLI_TAG)" \
  || bad_t "the release is not pinned to a version tag" "$BUZZ_CLI_TAG"
[[ "$BUZZ_SUMS_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  && ok_t "the SHA256SUMS manifest itself is pinned to a digest" \
  || bad_t "no pinned manifest digest" "$BUZZ_SUMS_SHA256"
# Same pins core's install.sh carried at 497ec15a, so a box moving from core's
# copy to the plugin's gets byte-identical binaries.
[[ "$BUZZ_CLI_TAG" == "cli-v0.1.2" && "$BUZZ_SUMS_SHA256" == 124425c0961df092622cd0225e90b453b885cbe83758e829d0399b02b5f02155 ]] \
  && ok_t "the pins are the ones core's install.sh carried" \
  || bad_t "the pins drifted from core's" "$BUZZ_CLI_TAG $BUZZ_SUMS_SHA256"

mk_release() { local d="$1"; mkdir -p "$d"; printf '%s' "$2" > "$d/buzz"; printf '%s' "$3" > "$d/buzz-pair"; ( cd "$d" && sha256sum buzz buzz-pair > SHA256SUMS ); }
sums_digest() { sha256sum "$1/SHA256SUMS" | awk '{print $1}'; }
stage() { # <plugin-dir> <relbase> <pin> -> prints output, last line RC=<n>
  ( FIVEDIVE_PLUGIN_DIR="$1" BUZZ_REL_BASE="$2" BUZZ_SUMS_SHA256="$3"
    rc=0; _buzz_stage_binaries 2>&1 || rc=$?; echo "RC=$rc" )
}

REL="$WORK/rel"; mk_release "$REL" "BUZZ-v1" "PAIR-v1"
PD="$WORK/plugin1"; mkdir -p "$PD"
out="$(stage "$PD" "file://$REL" "$(sums_digest "$REL")")"
[[ "$(cat "$PD/libexec/buzz" 2>/dev/null)" == BUZZ-v1 && "$(cat "$PD/libexec/buzz-pair" 2>/dev/null)" == PAIR-v1 ]] \
  && ok_t "both binaries land in the plugin's libexec" || bad_t "binaries not staged" "$out"
[[ "$(stat -c %a "$PD/libexec/buzz-pair" 2>/dev/null)" == 755 ]] \
  && ok_t "installed 0755" || bad_t "not 0755" "$(stat -c %a "$PD/libexec/buzz-pair" 2>/dev/null)"
grep -q 'RC=0' <<<"$out" && ok_t "happy path returns 0" || bad_t "happy path rc" "$out"

rm -f "$REL/buzz" "$REL/buzz-pair"
out="$(stage "$PD" "file://$REL" "$(sums_digest "$REL")")"
grep -q 'already at' <<<"$out" && grep -q 'RC=0' <<<"$out" \
  && ok_t "a re-run downloads nothing when both are current" || bad_t "re-run re-downloaded" "$out"
mk_release "$REL" "BUZZ-v1" "PAIR-v1"

BAD="$WORK/bad"; mk_release "$BAD" "BUZZ-v1" "PAIR-v1"; pin_bad="$(sums_digest "$BAD")"
printf 'EVIL' > "$BAD/buzz-pair"
PD2="$WORK/plugin2"; mkdir -p "$PD2/libexec"; printf 'OLD' > "$PD2/libexec/buzz-pair"; chmod 755 "$PD2/libexec/buzz-pair"
out="$(stage "$PD2" "file://$BAD" "$pin_bad")"
[[ "$(cat "$PD2/libexec/buzz-pair")" == OLD ]] && grep -qi 'checksum mismatch' <<<"$out" \
  && ok_t "a payload that fails SHA256SUMS is refused and the existing copy is untouched" || bad_t "tampered payload installed" "$out"
[[ "$(cat "$PD2/libexec/buzz" 2>/dev/null)" == BUZZ-v1 ]] \
  && ok_t "one bad binary does not block the other" || bad_t "one bad binary blocked both" "$out"
grep -q "RC=$E_VALIDATION" <<<"$out" \
  && ok_t "the refusal is an rc the verb reports (E_VALIDATION)" || bad_t "refusal rc" "$out"
compgen -G "$PD2/libexec/.buzz-pair.*" >/dev/null \
  && bad_t "a refused download left a temp file" "$(ls -a "$PD2/libexec")" \
  || ok_t "a refused download leaves no temp file"

SWAP="$WORK/swap"; mk_release "$SWAP" "EVIL-B" "EVIL-P"
PD3="$WORK/plugin3"; mkdir -p "$PD3"
out="$(stage "$PD3" "file://$SWAP" "$BUZZ_SUMS_SHA256")"
[[ ! -e "$PD3/libexec/buzz" && ! -e "$PD3/libexec/buzz-pair" ]] && grep -q 'does not match the pinned digest' <<<"$out" \
  && ok_t "an internally consistent swapped release is refused by the pinned digest" || bad_t "swapped release installed" "$out"

# The resolvers prefer the plugin's copy, and never auto-stage for a non-root
# caller (it cannot write into the plugin).
got=$(FIVEDIVE_PLUGIN_DIR="$PD" _buzz_resolve_binary "$(id -un)")
[[ "$got" == "$PD/libexec/buzz" ]] && ok_t "_buzz_resolve_binary prefers the plugin's buzz" || bad_t "resolver" "$got"
got=$(FIVEDIVE_PLUGIN_DIR="$PD" _buzz_resolve_pair_binary "$(id -un)")
[[ "$got" == "$PD/libexec/buzz-pair" ]] && ok_t "_buzz_resolve_pair_binary prefers the plugin's buzz-pair" || bad_t "pair resolver" "$got"
if [[ $EUID -ne 0 ]]; then
  PD4="$WORK/plugin4"; mkdir -p "$PD4"
  ( FIVEDIVE_PLUGIN_DIR="$PD4" BUZZ_REL_BASE="file://$REL" _buzz_ensure_binary buzz ) >/dev/null 2>&1
  [[ ! -e "$PD4/libexec" ]] && ok_t "a non-root caller never stages" || bad_t "non-root staged" "$(ls -R "$PD4")"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
