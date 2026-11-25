#!/usr/bin/env bash
# DIVE-9329: the pre-sale handover to the first hire (DIVE-8946) moved here from
# the 5dive CLI's src/cmd_helper.sh (`_helper_tick`) with its arms (the CLI's
# tests/helper_seat_unit.sh, section 13). Core keeps only the heartbeat's gate
# (5dive tests/handover_forward_unit.sh).
#
#   H1-H8   the handover: the first hire (earliest, never sysadmin, never a
#           system seat) gets one marked block under its own lines and one
#           notice; a second tick reads and sends nothing; no hire = nothing
#           read and nothing recorded; 404, an API down past its tries and a
#           first hire older than two days are recorded once with nothing sent;
#           no demo AI account = nothing; the bearer rides stdin.
#   O1-O2   the old helper seat (0.138.0-0.140.x): a box that recorded its
#           welcome is done; one with a built seat and no welcome gets the
#           handover in its first hire like any box (the welcome is retired).
#   P1      each agent type's instructions file is core's TYPE_PERSONA_FILE.
#   S1-S2   status for a person and --json.
#   W1-W4   wiring: the manifest declares handover (0.5.0 since DIVE-9330); `_tick` refuses a
#           non-root caller; no core internals are called; the marketplace.
#   NC1     NEGATIVE CONTROL: a tick without the handed-over check is CAUGHT by H2.
# Run: bash tests/hosted_handover_unit.sh   (no root, no network)
set -uo pipefail

trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.." || exit 2
TMP="$(mktemp -d "${TMPDIR:-/tmp}/handover-unit.XXXXXX")"
BIN=plugins/hosted/bin/handover
# shellcheck source=/dev/null
source "$BIN"
set +e

pass=0; fail=0
ok_t()  { pass=$((pass+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { fail=$((fail+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

# --- fakes: the core CLI (for the notice) and curl ---------------------------
FAKE="$TMP/bin"; mkdir -p "$FAKE"
CALLS="$TMP/calls.log"; : >"$CALLS"
cat >"$FAKE/5dive" <<'EOF'
#!/usr/bin/env bash
printf '5dive %s\n' "$*" >>"$CALLS"
EOF
# curl answers FAKE_HTTP with FAKE_BODY written to the -o file; records the URL,
# the argv's bearer (must be none) and the stdin header.
cat >"$FAKE/curl" <<'EOF'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [[ "$prev" == -o ]] && out="$a"; prev="$a"; done
hdr=$(cat)
for a in "$@"; do [[ "$a" == http* ]] && printf 'curl %s\n' "$a" >>"$CALLS"; done
printf 'argv %s\nstdin %s\n' "$*" "$hdr" >"$CURL_SEEN"
[[ -n "$out" ]] && printf '%s' "${FAKE_BODY:-}" >"$out"
printf '%s' "${FAKE_HTTP:-000}"
EOF
chmod +x "$FAKE"/*
export PATH="$FAKE:$PATH" CALLS CURL_SEEN="$TMP/curl-seen"
export FIVEDIVE_SELF_BIN="$FAKE/5dive" CONNECTORD_TOKEN="box-token-fixture" FIVE_API_BASE="https://api.example.test"
export FIVE_API_BASE_FILE="$TMP/no-api-base"
PERSONA_HOME_ROOT="$TMP/home"

fresh() {   # a new box: state dir, registry <agents-json>, optional demo AI account
  STATE_DIR="$TMP/box$1"; AUTH_PROFILES_DIR="$STATE_DIR/auth-profiles"; REGISTRY="$STATE_DIR/agents.json"
  mkdir -p "$STATE_DIR"; rm -rf "$PERSONA_HOME_ROOT"
  printf '{"agents":%s}' "$2" >"$REGISTRY"
  if [[ "${3:-demo}" == demo ]]; then
    mkdir -p "$AUTH_PROFILES_DIR/demo-ai"
    printf 'ANTHROPIC_AUTH_TOKEN=fixture\n' >"$AUTH_PROFILES_DIR/demo-ai/combined.env"
  fi
  : >"$CALLS"
}
n_calls() { grep -c -- "$1" "$CALLS"; }
rec() { cat "$STATE_DIR/helper/handed-over" 2>/dev/null; }
now=$(date -Iseconds); old=$(date -Iseconds -d '-10 days'); earlier=$(date -Iseconds -d '-1 hour')
AGENTS='{"sysadmin":{"type":"claude","createdAt":"'"$old"'"},"helper":{"type":"claude","system":"helper","createdAt":"'"$old"'"},"theo":{"type":"claude","createdAt":"'"$now"'"},"dude":{"type":"codex","createdAt":"'"$earlier"'"}}'
HANDOVER='{"business":"a bakery <!-- x --> in Lyon","suggested":["theo","dude"],"asked_at":"2026-11-21T10:00:00Z"}'
DUDE_MD="$PERSONA_HOME_ROOT/agent-dude/.codex/AGENTS.md"

# ── H1: the handover ─────────────────────────────────────────────────────────
fresh 1 "$AGENTS"
out=$(FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick)
md=$(cat "$DUDE_MD" 2>/dev/null)
{ [[ "$out" == "gave the handover to the first hire dude" && -f "$DUDE_MD" ]] \
  && [[ "$(head -n1 <<<"$md")|$(tail -n1 <<<"$md")" == "$HANDOVER_BEGIN|$HANDOVER_END" ]] \
  && grep -qF 'told 5dive about their business: a bakery !-- x -- in Lyon' <<<"$md" \
  && grep -qF '5dive suggested they hire Theo and Dude.' <<<"$md" \
  && grep -qF 'never ask them what their business does' <<<"$md" \
  && [[ "$(n_calls '_deliver')" == 1 ]] && grep -qF '5dive agent _deliver --system-notice dude 5dive: before buying, your owner told 5dive about their business: a bakery !-- x -- in Lyon. 5dive suggested they hire Theo and Dude.' "$CALLS" \
  && grep -q 'to dude' <<<"$(rec)" && grep -qx 'curl https://api.example.test/helper/handover' "$CALLS"; } \
  && ok_t "H1 the first hire (earliest; not sysadmin, not the helper seat) gets one marked block and one notice; recorded" \
  || bad_t "H1 handover" "out=$out calls=$(cat "$CALLS") md=$md"
# H2: once.
h2() { : >"$CALLS"; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null; [[ "$(n_calls 'curl\|_deliver')" == 0 && "$(grep -cF "$HANDOVER_BEGIN" "$DUDE_MD")" == 1 ]]; }
h2 && ok_t "H2 a second tick reads and sends nothing; the block is not doubled" || bad_t "H2 once" "$(cat "$CALLS")"
# H3: the block goes under the file's own lines; no suggestion, no suggested line.
fresh 3 '{"theo":{"type":"claude","createdAt":"'"$now"'"}}'
mkdir -p "$PERSONA_HOME_ROOT/agent-theo/.claude"; printf '# Theo\nkept line\n' >"$PERSONA_HOME_ROOT/agent-theo/.claude/CLAUDE.md"
FAKE_HTTP=200 FAKE_BODY='{"business":"a bakery","suggested":[]}' _handover_tick >/dev/null
md=$(cat "$PERSONA_HOME_ROOT/agent-theo/.claude/CLAUDE.md")
{ [[ "$(sed -n 1,2p <<<"$md" | paste -sd'|')" == '# Theo|kept line' ]] && grep -qF "$HANDOVER_BEGIN" <<<"$md" \
  && ! grep -q 'suggested they hire' <<<"$md" && ! grep -q 'suggested they hire' "$CALLS"; } \
  && ok_t "H3 the file keeps its own lines first; no suggestion, no suggested line" || bad_t "H3 append" "$md"
# H4: no hire yet.
fresh 4 '{"sysadmin":{"type":"claude"},"helper":{"type":"claude","system":"helper"}}'
FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
[[ "$(n_calls curl)" == 0 && ! -e "$STATE_DIR/helper/handed-over" ]] \
  && ok_t "H4 no hire yet (an unclaimed spare): nothing read, nothing recorded" || bad_t "H4 no hire" "$(cat "$CALLS")"
# H5: 404.
fresh 5 "$AGENTS"; FAKE_HTTP=404 _handover_tick >/dev/null
[[ "$(n_calls '_deliver')" == 0 ]] && grep -q 'nothing' <<<"$(rec)" \
  && ok_t "H5 404 (told 5dive nothing): no notice, recorded once" || bad_t "H5 404" "$(rec)"
# H6: API down.
fresh 6 "$AGENTS"; HANDOVER_TRIES=3
for i in 1 2; do FAKE_HTTP=503 _handover_tick >/dev/null; done; mid=$([[ -e "$STATE_DIR/helper/handed-over" ]] && echo yes || echo no)
FAKE_HTTP=503 _handover_tick >/dev/null; HANDOVER_TRIES=12
[[ "$mid" == no && "$(n_calls '_deliver')" == 0 ]] && grep -q 'gave up' <<<"$(rec)" && [[ ! -e "$STATE_DIR/helper/handover-tries" ]] \
  && ok_t "H6 API down: retried while tries remain, then recorded with nothing sent" || bad_t "H6 retries" "mid=$mid rec=$(rec)"
# H7: an old first hire.
fresh 7 '{"theo":{"type":"claude","createdAt":"'"$old"'"}}'; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
[[ "$(n_calls 'curl\|_deliver')" == 0 ]] && grep -q skipped <<<"$(rec)" \
  && ok_t "H7 a first hire 10 days old: nothing read or sent, recorded as skipped" || bad_t "H7 old hire" "$(rec)"
# H8: not a paid box; the bearer on stdin.
fresh 8 "$AGENTS" none; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null; a=$(n_calls 'curl\|_deliver')
fresh 81 "$AGENTS"; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
{ [[ "$a" == 0 ]] && ! grep -q 'box-token-fixture' <<<"$(sed -n 's/^argv //p' "$CURL_SEEN")" \
  && grep -qx 'stdin Authorization: Bearer box-token-fixture' "$CURL_SEEN"; } \
  && ok_t "H8 no demo AI account: nothing; the bearer rides stdin, never argv" || bad_t "H8" "a=$a $(cat "$CURL_SEEN")"

# ── O: the old helper seat ───────────────────────────────────────────────────
fresh 11 "$AGENTS"; mkdir -p "$STATE_DIR/helper"; date >"$STATE_DIR/helper/built"; date >"$STATE_DIR/helper/welcomed"
FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
[[ "$(n_calls 'curl\|_deliver')" == 0 ]] && ok_t "O1 a box whose old seat welcomed the owner is done" || bad_t "O1 welcomed" "$(cat "$CALLS")"
fresh 12 "$AGENTS"; mkdir -p "$STATE_DIR/helper"; date >"$STATE_DIR/helper/built"
FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
[[ "$(n_calls '_deliver --system-notice dude')" == 1 && -f "$DUDE_MD" ]] && grep -q 'to dude' <<<"$(rec)" \
  && ok_t "O2 a built seat with no welcome: the handover goes to the first hire, the seat is untouched" || bad_t "O2 built" "$(cat "$CALLS")"

# ── P1: instructions paths ───────────────────────────────────────────────────
want='antigravity=.gemini/GEMINI.md claude=.claude/CLAUDE.md codex=.codex/AGENTS.md grok=.claude/CLAUDE.md hermes=.hermes/SOUL.md openclaw=.openclaw/workspace/AGENTS.md opencode=.config/opencode/AGENTS.md pi=.pi/agent/AGENTS.md'
got=$(for k in "${!HANDOVER_PERSONA_FILE[@]}"; do printf '%s=%s\n' "$k" "${HANDOVER_PERSONA_FILE[$k]}"; done | sort | paste -sd' ')
[[ "$got" == "$want" ]] && ok_t "P1 the instructions file per agent type is core's TYPE_PERSONA_FILE (src/header.sh)" || bad_t "P1 map" "$got"

# ── S: status ────────────────────────────────────────────────────────────────
fresh 21 "$AGENTS"; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null
s1=$(STATE_DIR="$STATE_DIR" REGISTRY="$REGISTRY" AUTH_PROFILES_DIR="$AUTH_PROFILES_DIR" "$BIN" status 2>&1)
s2=$(STATE_DIR="$STATE_DIR" REGISTRY="$REGISTRY" AUTH_PROFILES_DIR="$AUTH_PROFILES_DIR" "$BIN" status --json 2>&1)
grep -q '^handover: eligible=true handover=done (.* to dude) welcomed=false helper-seat=mine$' <<<"$s1" \
  && ok_t "S1 status for a person" || bad_t "S1 status" "$s1"
[[ "$(jq -c '[.ok, .data.handover, .data.welcomed, .data.seat]' <<<"$s2" 2>/dev/null)" == '[true,"done",false,"mine"]' ]] \
  && ok_t "S2 status --json" || bad_t "S2 status json" "$s2"

# ── W: wiring ────────────────────────────────────────────────────────────────
PJ=plugins/hosted/.claude-plugin/plugin.json
[[ "$(jq -c '[.fivedive.verbs[].name] | sort' "$PJ")" == '["first-job","handover","partner","premium-team"]' && "$(jq -r .version "$PJ")" == 0.5.0 ]] \
  && ok_t "W1 plugin.json 0.5.0 declares first-job, handover, partner and premium-team" || bad_t "W1 manifest" "$(jq -c '.version, [.fivedive.verbs[].name]' "$PJ")"
out=$(env -u FIVEDIVE_JSON_MODE "$BIN" _tick 2>&1); rc=$?; "$BIN" --help >/dev/null 2>&1; rc_help=$?; "$BIN" bogus >/dev/null 2>&1; rc_bad=$?
{ [[ -x "$BIN" && $rc -eq $E_PERMISSION && $rc_help -eq 0 && $rc_bad -eq $E_USAGE ]] && grep -q 'must run as root (5dive handover _tick)' <<<"$out"; } \
  && ok_t "W2 executed: _tick refuses a non-root caller; --help rc 0; an unknown word is a usage error" || bad_t "W2 entry" "rc=$rc $out help=$rc_help bad=$rc_bad"
! grep -v '^ *#' "$BIN" | grep -qE '\b(lazy_need|registry_read|persona_target|_dash_relay_[a-z_]+|_chat_e2e_[a-z_]+|sudo)\b' \
  && ok_t "W3 the plugin calls no core internals (only the '5dive agent _deliver' verb) and never sudos" || bad_t "W3 core internals" ""
[[ "$(jq -r '.plugins[] | select(.name=="hosted") | .source' .claude-plugin/marketplace.json)" == ./plugins/hosted ]] \
  && ok_t "W4 the marketplace lists hosted at ./plugins/hosted" || bad_t "W4 marketplace entry" ""

# ── NC1: H2 can go red ───────────────────────────────────────────────────────
sed 's/\[\[ -e "\$d\/welcomed" || -e "\$d\/handed-over" \]\] && return 0/:/' "$BIN" >"$TMP/mutant"
if cmp -s "$BIN" "$TMP/mutant"; then bad_t "NC1 mutation did not apply" ""
else
  ( source "$TMP/mutant"; set +e; PERSONA_HOME_ROOT="$TMP/home"
    fresh 31 "$AGENTS"; FAKE_HTTP=200 FAKE_BODY="$HANDOVER" _handover_tick >/dev/null; h2 ) \
    && bad_t "NC1 a tick without the handed-over check passes H2: the check cannot go red" "" \
    || ok_t "NC1 a tick without the handed-over check is CAUGHT by H2 (read and notified again)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
