#!/usr/bin/env bash
# DIVE-7183 — a root-only buzz verb run without sudo re-runs itself through
# `sudo -n`, in the form the caller typed (`agent buzz …`), when the seat holds the
# grant; otherwise it names the admin colleague who can. A fake sudo
# (FIVEDIVE_SUDO) answers the `-n -l` probe from FAKE_GRANT and records what a real
# re-run would have run. FIVEDIVE_PLUGIN_DIR marks the copy core dispatched, the
# only one that re-runs. Non-root arms; as root the check passes on its own.
#
#   bash tests/buzz_root_reexec_unit.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUZZ="$ROOT/plugins/buzz/bin/buzz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
t() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; else FAIL=$((FAIL+1)); printf 'FAIL - %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
yn() { if grep -qF -- "$1"; then echo yes; else echo no; fi; }

if (( EUID == 0 )); then printf 'note: running as root — these arms need a non-root caller (CI runs as one)\n'; exit 0; fi

cat > "$TMP/sudo" <<'S'
#!/usr/bin/env bash
if [[ "$1" == -n && "$2" == -l ]]; then shift 2; printf 'PROBE %s\n' "$*" >>"$FAKE_LOG"; [[ "${FAKE_GRANT:-0}" == 1 ]]; exit; fi
if [[ "$1" == -n ]]; then shift; printf 'EXEC %s\n' "$*" >>"$FAKE_LOG"; echo REEXECED; exit 0; fi
exit 9
S
cat > "$TMP/cli" <<'S'
#!/usr/bin/env bash
[[ "$*" == "agent list --json" ]] || exit 3
printf '%s\n' "${FAKE_AGENTS:-{\"data\":[]}}"
S
chmod 755 "$TMP/sudo" "$TMP/cli"
AGENTS='{"data":[{"name":"a","active":"failed","sudo":{"impliedIsolation":"admin"}},{"name":"c","active":"active","sudo":{"impliedIsolation":"admin"}},{"name":"d","active":"active","sudo":{"impliedIsolation":"beyond-admin"}}]}'

run() { local g="$1" pd="$2"; shift 2; : >"$TMP/log"
  ( export FAKE_LOG="$TMP/log" FAKE_GRANT="$g" FIVEDIVE_SUDO="$TMP/sudo" FIVEDIVE_BIN=/opt/5dive \
      FIVEDIVE_BUZZ_CLI="$TMP/cli" FAKE_AGENTS="${AGENTS_FOR:-}" HOME="$TMP" STATE_DIR="$TMP/state"
    [[ -n "$pd" ]] && export FIVEDIVE_PLUGIN_DIR="$pd"
    "$BUZZ" "$@" ) </dev/null >"$TMP/out" 2>"$TMP/err"; printf '%s' "$?"; }
PD="$ROOT/plugins/buzz"

rc=$(run 1 "$PD" binaries)
t "E: 'buzz binaries' granted -> exec sudo -n /opt/5dive buzz binaries (rc 0)" "0 yes yes" \
  "$rc $(yn 'PROBE /opt/5dive buzz binaries' <"$TMP/log") $(yn 'EXEC /opt/5dive buzz binaries' <"$TMP/log")"
rc=$(run 1 "$PD" agent enable luna --no-join)
t "E: core's 'buzz agent enable' re-runs as typed: agent buzz enable (rc 0)" "0 yes" \
  "$rc $(yn 'EXEC /opt/5dive agent buzz enable luna --no-join' <"$TMP/log")"
rc=$(FIVEDIVE_JSON_MODE=1 run 1 "$PD" binaries)
t "E: --json (forwarded by core as FIVEDIVE_JSON_MODE) rides the re-run" yes "$(yn 'EXEC /opt/5dive --json buzz binaries' <"$TMP/log")"

rc=$(run 1 "" binaries)
t "B: run directly (no FIVEDIVE_PLUGIN_DIR) -> refused, no probe" "10 0" "$rc $(wc -l <"$TMP/log" | tr -d ' ')"

rc=$(printf 'x' | ( export FAKE_LOG="$TMP/log" FAKE_GRANT=1 FIVEDIVE_SUDO="$TMP/sudo" FIVEDIVE_BIN=/opt/5dive FIVEDIVE_PLUGIN_DIR="$PD" HOME="$TMP" STATE_DIR="$TMP/state"
  : >"$TMP/log"; "$BUZZ" agent inbound --pubkey=abc --message-file=- >"$TMP/out" 2>"$TMP/err"; printf '%s' "$?" ))
t "I: a '-' input from a pipe is not re-run blind (rc 10)" "10 no yes" "$rc $(yn EXEC <"$TMP/log") $(yn 'reads its input from stdin' <"$TMP/err")"

rc=$(AGENTS_FOR="$AGENTS" run 0 "$PD" agent enable luna)
e=$(cat "$TMP/err")
t "N: no grant -> rc 10, no re-run" "10 no" "$rc $(yn EXEC <"$TMP/log")"
t "N: names only RUNNING admin seats, the lead first" yes "$(yn 'who has it (d, c)' <<<"$e")"
t "N: with a ready agent send line, in the typed form" yes "$(yn 'Please run: sudo 5dive agent buzz enable luna' <<<"$e")"
t "N: never 'try: sudo', and the owner is not handed a command" "no yes" "$(yn 'try: sudo' <<<"$e") $(yn 'Do not ask your owner to run anything' <<<"$e")"

# The registry lock runs the verb in a subshell: the check there must refuse, not exec.
: >"$TMP/log"
o=$(FAKE_LOG="$TMP/log" FAKE_GRANT=1 FIVEDIVE_SUDO="$TMP/sudo" FIVEDIVE_PLUGIN_DIR="$PD" FIVEDIVE_BUZZ_CLI="$TMP/cli" \
    bash -c 'source "$1"; BUZZ_PLUGIN_ROOT="$2"; BUZZ_ARGV=(buzz binaries); BUZZ_SUDO="$FIVEDIVE_SUDO"; ( require_root ); echo "RC=$?"' _ "$ROOT/plugins/buzz/cli/prelude.sh" "$PD" 2>&1)
t "L: inside a subshell the check refuses instead of re-running" "yes no" "$(yn RC=10 <<<"$o") $(yn EXEC <"$TMP/log")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
