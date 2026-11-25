#!/usr/bin/env bash
# DIVE-9327 (step 6d of DIVE-9262): the native-push helper moved here from the
# 5dive CLI (hooks/push-notify.sh) as plugins/hosted/lib/push-notify.sh. The
# CLI's install.sh copies it, root-owned, to /usr/local/lib/5dive/push-notify.sh
# on a box with this plugin: the same path every seat's sudoers grant names.
#
# P1-P3 are the CLI's tests/secrets_posture_unit.sh T7 push-notify arms, moved
# unchanged. P4-P5 pin the request itself (the CLI never had them).
#   P1  token unreadable to this seat -> re-runs itself as root, same args
#   P2  no sudoers grant -> silent no-op, `sudo -l` is the only sudo call
#   P3  no token file (self-hosted box) -> sudo is never asked
#   P4  readable token -> one POST to <api>/server/push/event, the event JSON
#   P5  the API unreachable -> still exit 0 (it must never fail its caller)
#   W1  lib/push-notify.sh is executable and byte-identical to the CLI's
#       hooks/push-notify.sh @ 3a1c941c
#   W2  it re-runs itself through the exact path the sudoers grants name
#   NC1 NEGATIVE CONTROL: a copy that skips the `sudo -l` probe must turn P2 red
# Run: bash tests/hosted_push_notify_unit.sh   (no network; P1-P3 need a
# non-root uid, or root with setpriv)
set -uo pipefail

trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.." || exit 2
TMP="$(mktemp -d "${TMPDIR:-/tmp}/hosted-push-unit.XXXXXX")"
chmod 755 "$TMP"

SRC=plugins/hosted/lib/push-notify.sh
GRANTED=/usr/local/lib/5dive/push-notify.sh
CORE_SHA=ba9a2bc894cfdd89cdbe63fbcbefba9b665d719330d41d9bdbbdadf6e95be508

pass=0; fail=0
ok_t()  { pass=$((pass+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { fail=$((fail+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

# A file only a non-root uid is refused: as root, the arms run as uid 65534.
AS_SEAT=()
(( EUID == 0 )) && command -v setpriv >/dev/null && AS_SEAT=(setpriv --reuid=65534 --regid=65534 --clear-groups)
can_lock() { (( EUID != 0 )) || (( ${#AS_SEAT[@]} )); }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/sudo" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$SUDO_LOG"
[ "$1 $2" = "-n -l" ] && exit "${SUDO_L_RC:-0}"
exit 0
STUB
# The fake curl records its argv one per line; STUB_RC fails it.
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "$@" > "$CURL_LOG"
exit "${STUB_RC:-0}"
STUB
chmod 755 "$TMP/bin" "$TMP/bin/sudo" "$TMP/bin/curl"
export SUDO_LOG="$TMP/sudo.log" CURL_LOG="$TMP/curl.log"
: > "$SUDO_LOG"; chmod 666 "$SUDO_LOG"

# <src> <out>: the helper with its token path pointed into $TMP.
stage() { sed "s#/etc/5dive/connectord.env#$TMP/locked.env#" "$1" > "$2"; chmod 644 "$2"; }
HOOK="$TMP/push-notify.sh"; stage "$SRC" "$HOOK"
seat_env() { env PATH="$TMP/bin:$PATH" SUDO_LOG="$SUDO_LOG" CURL_LOG="$CURL_LOG" "$@"; }

# P2's assertion, reused by NC1: <hook> -> rc 0 iff a seat with no grant only asked `sudo -l`.
no_grant_is_silent() {
  rm -f "$TMP/locked.env"; printf 'CONNECTORD_TOKEN=t\n' > "$TMP/locked.env"; chmod 000 "$TMP/locked.env"
  : > "$SUDO_LOG"; seat_env SUDO_L_RC=1 "${AS_SEAT[@]}" bash "$1" "done" x seat_b; local rc=$?
  [[ $rc -eq 0 && "$(wc -l < "$SUDO_LOG")" == 1 && "$(head -1 "$SUDO_LOG")" == "-n -l $GRANTED done x seat_b" ]]
}

if can_lock; then
  rm -f "$TMP/locked.env"; printf 'CONNECTORD_TOKEN=t\n' > "$TMP/locked.env"; chmod 000 "$TMP/locked.env"
  : > "$SUDO_LOG"; seat_env "${AS_SEAT[@]}" bash "$HOOK" "done" "hi there" seat_b; rc=$?
  [[ $rc -eq 0 && "$(tail -1 "$SUDO_LOG")" == "-n $GRANTED done hi there seat_b" ]] \
    && ok_t "P1 unreadable token -> re-runs as root with the same args" || bad_t "P1 elevate" "rc=$rc $(cat "$SUDO_LOG")"
  no_grant_is_silent "$HOOK" \
    && ok_t "P2 no grant -> silent no-op, only sudo -l asked" || bad_t "P2 no grant" "$(cat "$SUDO_LOG")"
  rm -f "$TMP/locked.env"; : > "$SUDO_LOG"; seat_env "${AS_SEAT[@]}" bash "$HOOK" "done" x seat_b
  [[ ! -s "$SUDO_LOG" ]] && ok_t "P3 no token file (self-hosted box) -> sudo never asked" || bad_t "P3 no token" "$(cat "$SUDO_LOG")"

  # NC1: drop the `sudo -n -l` probe, so a seat with no grant would exec sudo.
  sed 's#&& sudo -n -l /usr/local/lib/5dive/push-notify.sh "$event" "$message" "$agent" >/dev/null 2>\&1#\&\& true#' \
    "$SRC" > "$TMP/mutant.src"
  if cmp -s "$SRC" "$TMP/mutant.src"; then
    bad_t "NC1 control: the mutation did not apply (the probe line changed shape)"
  else
    stage "$TMP/mutant.src" "$TMP/mutant.sh"
    no_grant_is_silent "$TMP/mutant.sh" \
      && bad_t "NC1 control: a copy with no sudo -l probe still passed P2" "$(cat "$SUDO_LOG")" \
      || ok_t "NC1 control: a copy with no sudo -l probe turns P2 red"
  fi
else
  printf 'skip - P1-P3, NC1: running as root without setpriv\n'
fi

# P4-P5 run as whoever we are, with a readable token.
rm -f "$TMP/locked.env"; printf 'CONNECTORD_TOKEN=tok-9327\n' > "$TMP/locked.env"; chmod 600 "$TMP/locked.env"
: > "$CURL_LOG"; : > "$SUDO_LOG"
seat_env FIVE_API_BASE=https://api.test bash "$HOOK" blocked "needs you" seat_b; rc=$?
argv=$(cat "$CURL_LOG")
body=$(awk 'p{print; exit} $0=="--data"{p=1}' "$CURL_LOG")
if [[ $rc -eq 0 && "$argv" == *$'\nhttps://api.test/server/push/event\n'* && "$argv" == *"Authorization: Bearer tok-9327"* \
      && "$(jq -c . <<<"$body" 2>/dev/null)" == '{"event":"blocked","agent":"seat_b","message":"needs you"}' && ! -s "$SUDO_LOG" ]]; then
  ok_t "P4 readable token -> one POST to <api>/server/push/event with the event JSON"
else bad_t "P4 the POST" "rc=$rc argv=$argv"; fi
seat_env FIVE_API_BASE=https://api.test STUB_RC=7 bash "$HOOK" error x seat_b; rc=$?
[[ $rc -eq 0 ]] && ok_t "P5 API unreachable -> still exit 0" || bad_t "P5 never fails its caller" "rc=$rc"

[[ -x "$SRC" && "$(sha256sum < "$SRC" | cut -d' ' -f1)" == "$CORE_SHA" ]] \
  && ok_t "W1 lib/push-notify.sh is executable and is the CLI's hooks/push-notify.sh @ 3a1c941c, byte for byte" \
  || bad_t "W1 carried verbatim" "x=$([[ -x "$SRC" ]] && echo y || echo n) sha=$(sha256sum < "$SRC")"
[[ "$(grep -c "exec sudo -n $GRANTED " "$SRC")" == 1 ]] \
  && ok_t "W2 it re-runs itself through the granted path $GRANTED" || bad_t "W2 granted path" "$(grep -n 'sudo' "$SRC")"

echo
echo "TESTS pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
