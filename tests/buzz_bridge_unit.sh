#!/usr/bin/env bash
# DIVE-3573 unit harness — the buzz BRIDGE: the outbound mirror and the inbound
# router.
#
# WHAT THIS GRADES. One property, from as many directions as it has:
#
#   NOTHING IS PROMOTED OUT OF `untrusted` EXCEPT A MEASURED, UNAMBIGUOUS,
#   NOT-ME, KNOWN-TEAMMATE KEY.
#
# Every other outcome — a stranger, an unreadable registry, two seats holding one
# key, another agent's owner, our own key — must land on untrusted, and the arms
# below check them one at a time because they fail in DIFFERENT directions and a
# router that got any one of them wrong would still pass a single happy-path test.
#
# THE ARM THAT MATTERS MOST is 6c against 6b: a registry we could not READ must
# not answer the same as a key that is genuinely unknown. Both end at `untrusted`
# — that is the safe collapse and it is deliberate — but the REASON must still
# separate them, because "every teammate on this box silently became a stranger"
# and "a stranger messaged us" are the same observation otherwise, and only one of
# them is an outage. That is DIVE-3572's rc split, and this is the caller that has
# to honour it.
#
# THE POSITIVE CONTROLS ARE LOAD-BEARING, not padding. A router that returned
# `untrusted` unconditionally would pass every negative arm on this page; arms 6a
# and 7 are what prove the negatives measure something.
#
# Run: bash tests/buzz_bridge_unit.sh   (no root, no network, no relay, no pane.)
#
# TIER: core — 0.5s measured on the 5dive control plane (agent-dev seat,
# 2026-08-18, slowest of 3: 0.45/0.43/0.41s, re-measured after section 13 added real
# `_buzz_whois` runs against a registry fixture; it is bash and jq, with no openssl and
# no python3 in the hot path). Stated, not defaulted: 0.17% of the 300s PR core
# budget, and it guards the trust decision that decides whether a stranger's text
# reaches a session as an INSTRUCTION. That is the one class where a nightly catch
# is a day of wrong behaviour, not a day of stale information. No demotion argued here per
# [[project_core_tier_is_over_budget_file_new_harnesses_nightly]].
set -uo pipefail

trap 'rc=$?; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=plugins/buzz/cli

# DIVE-6934: the buzz verbs moved out of core into this plugin; the prelude
# re-establishes what they used from core (fail/ok/warn, E_*, the registry).
# shellcheck source=/dev/null
source "$SRC/prelude.sh"
# shellcheck source=/dev/null
source "$SRC/binaries.sh"
# shellcheck source=/dev/null
source "$SRC/cmd_agent_buzz_whois.sh"
# shellcheck source=/dev/null
source "$SRC/cmd_agent_buzz_bridge.sh"
set +e  # header.sh enables set -e; the arms below deliberately probe non-zero rc

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

# --- 1. the file is loaded by the plugin's verb ---------------------------
# DIVE-6934: these verbs left core's bundle for bin/buzz. Same claim as before:
# this file is what the shipped verb runs, so the greps below are not grading
# dead code.
grep -qE '\bcmd_agent_buzz_bridge\b' plugins/buzz/bin/buzz \
  && ok_t "bin/buzz sources cmd_agent_buzz_bridge.sh" \
  || bad_t "bin/buzz sources cmd_agent_buzz_bridge.sh" \
           "present but never sourced — every call site below is 'command not found' in the verb"

# --- 2. the verb is dispatched and documented -------------------------------
grep -qE '^\s+inbound\) shift; _buzz_inbound' "$SRC/cmd_agent_buzz.sh" \
  && ok_t "'agent buzz inbound' is dispatched" \
  || bad_t "'agent buzz inbound' is dispatched" "cmd_agent_buzz has no inbound arm"
grep -q 'buzz inbound --pubkey' plugins/buzz/bin/buzz \
  && ok_t "'agent buzz inbound' appears in the verb's usage" \
  || bad_t "'agent buzz inbound' appears in the verb's usage" "undocumented verb"

# --- 3. it is audited, and it does NOT take the registry lock ---------------
# Both halves matter. Unaudited, the bridge's trust decision leaves no artifact.
# Under with_registry_lock, one inbound chat message would hold the fleet-wide
# lock across a tmux readiness wait (up to 45s) and stall every other seat.
INB_ARM=$(grep -E '^\s+inbound\|pair\)' plugins/buzz/bin/buzz)
grep -q 'buzz_audit "agent buzz"' <<<"$INB_ARM" \
  && ok_t "the inbound arm is audited" \
  || bad_t "the inbound arm is audited" "$INB_ARM"
grep -q 'with_registry_lock' <<<"$INB_ARM" \
  && bad_t "the inbound arm takes NO registry lock" "it holds the fleet lock across a pane readiness wait" \
  || ok_t "the inbound arm takes NO registry lock"

# --- 4. the sudoers grant and capability stay in CORE -----------------------
# A seat calls `sudo 5dive agent buzz inbound`, which core forwards here. The
# grant that makes that call possible is rendered by core's agent create, so its
# arms moved to core's tests/buzz_moved_to_plugin_unit.sh (DIVE-6934).

# --- 5. the containment: no target argument, ever ---------------------------
# The host cannot verify an event signature (deferred past v0.20), so "seat X
# reports a message from teammate Y" is an unverified claim. It is made safe by
# SCOPE: the only pane this verb drives is the caller's own. A target argument
# would hand every seat a way to inject a forged teammate message into a PEER.
grep -q -- '--target' "$SRC/cmd_agent_buzz_bridge.sh" \
  && bad_t "inbound accepts NO target argument" "a --target flag appeared; the containment is gone" \
  || ok_t "inbound accepts NO target argument"
OUT=$(
  (
    require_root() { :; }
    _buzz_inbound --pubkey=deadbeef somebody
  ) 2>&1
)
grep -q 'derived from the caller' <<<"$OUT" \
  && ok_t "a positional target is refused, and the refusal says why" \
  || bad_t "a positional target is refused, and the refusal says why" "$OUT"

# --- 6. the routing table ---------------------------------------------------
# The seam: _buzz_whois is the single reader (DIVE-3572) and _buzz_bridge_a2a_send
# is the rail. Both are replaced so the ROUTING is graded with no registry, no
# pane and no sudo — the arms below are about the decision, not the plumbing.
WORK=$(mktemp -d)
# DIVE-2692: fold the tempdir cleanup into the ONE EXIT trap — bash has a single
# slot, and a plain `rm -rf` trap here REPLACES the HARNESS-RC line set above.
trap 'rc=$?; rm -rf "${WORK:-}"; echo "HARNESS-RC=$rc"' EXIT
BODY="$WORK/body"; printf 'ship it\n' > "$BODY"
SENT_LOG="$WORK/sent"

route_probe() { # <whois-rc> <whois-out> <me>  -> prints the verdict line
  local wrc="$1" wout="$2" me="$3"
  (
    export SUDO_USER="agent-${me}" SUDO_UID="$(id -u)"
    require_root() { :; }
    _buzz_whois() { [[ -n "$wout" ]] && printf '%s\n' "$wout"; return "$wrc"; }
    _buzz_bridge_a2a_send() { printf 'to=%s from=%s file=%s\n' "$1" "$2" "$3" >>"$SENT_LOG"; return 0; }
    _buzz_inbound --pubkey=aa --message-file="$BODY" --channel=general-1 2>&1
  )
}

# 6a. POSITIVE CONTROL — a known teammate goes on the a2a rail.
: > "$SENT_LOG"
V=$(route_probe 0 "olivia agent" dev)
grep -q 'route=a2a' <<<"$V" \
  && ok_t "6a a known teammate key routes to a2a" \
  || bad_t "6a a known teammate key routes to a2a" "$V"
grep -q 'to=dev from=buzz-olivia' "$SENT_LOG" \
  && ok_t "6a it is delivered to the CALLING seat, under from=buzz-<seat>" \
  || bad_t "6a it is delivered to the CALLING seat, under from=buzz-<seat>" "$(cat "$SENT_LOG")"
# from=buzz-<seat>, never a bare seat name: the message came from that seat's KEY
# relayed by this bridge, not from that seat's own a2a process, and per-message
# signature verification is deferred. A reader must be able to tell those apart —
# and a bare name would also collide with the registered-agent namespace the
# peer-forgery guard defends, which would make the guard the thing being worked
# around rather than the thing being respected.
grep -q 'from=olivia ' "$SENT_LOG" \
  && bad_t "6a it never claims the bare seat name" "$(cat "$SENT_LOG")" \
  || ok_t "6a it never claims the bare seat name"

# 6b. a stranger — MEASURED absence.
: > "$SENT_LOG"
V=$(route_probe "$E_NOT_FOUND" "" dev)
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=no-match"* ]] \
  && ok_t "6b an unknown key is untrusted, reason no-match" \
  || bad_t "6b an unknown key is untrusted, reason no-match" "$V"
[[ -s "$SENT_LOG" ]] && bad_t "6b a stranger never reaches the a2a rail" "$(cat "$SENT_LOG")" \
                     || ok_t "6b a stranger never reaches the a2a rail"

# 6c. THE ARM THAT MATTERS — an unreadable registry is NOT a stranger.
: > "$SENT_LOG"
V=$(route_probe "$E_GENERIC" "" dev)
[[ "$V" == *"route=untrusted"* ]] \
  && ok_t "6c an unreadable registry is untrusted (the safe collapse)" \
  || bad_t "6c an unreadable registry is untrusted (the safe collapse)" "$V"
[[ "$V" == *"reason=not-measured"* ]] \
  && ok_t "6c ...and its REASON separates it from a real stranger" \
  || bad_t "6c ...and its REASON separates it from a real stranger" \
           "got '$V' — a box-level fault is now indistinguishable from a stranger, which is a silent fleet-wide demotion of every teammate"

# 6d. two seats, one key.
: > "$SENT_LOG"
V=$(route_probe "$E_CONFLICT" "" dev)
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=ambiguous-key"* ]] \
  && ok_t "6d an ambiguous key is untrusted" \
  || bad_t "6d an ambiguous key is untrusted" "$V"

# 6e. ANOTHER seat's paired owner is a person on this box, not this seat's human.
: > "$SENT_LOG"
V=$(route_probe 0 "olivia owner" dev)
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=foreign-owner"* ]] \
  && ok_t "6e another seat's owner is untrusted, not promoted" \
  || bad_t "6e another seat's owner is untrusted, not promoted" "$V"

# 6f. our OWN key coming back at us.
: > "$SENT_LOG"
V=$(route_probe 0 "dev agent" dev)
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=self-key"* ]] \
  && ok_t "6f our own key is untrusted (config and registry disagree)" \
  || bad_t "6f our own key is untrusted (config and registry disagree)" "$V"
[[ -s "$SENT_LOG" ]] && bad_t "6f our own words are never injected back into our pane" "$(cat "$SENT_LOG")" \
                     || ok_t "6f our own words are never injected back into our pane"

# --- 7. POSITIVE CONTROL — the paired owner, and nothing on the rail --------
: > "$SENT_LOG"
V=$(route_probe 0 "dev owner" dev)
[[ "$V" == *"route=owner"* && "$V" == *"reason=paired-owner"* ]] \
  && ok_t "7 this seat's paired owner routes to owner" \
  || bad_t "7 this seat's paired owner routes to owner" "$V"
[[ -s "$SENT_LOG" ]] \
  && bad_t "7 the owner route delivers NOTHING on the a2a rail (the plugin delivers it as a channel event)" "$(cat "$SENT_LOG")" \
  || ok_t "7 the owner route delivers NOTHING on the a2a rail (the plugin delivers it as a channel event)"

# --- 8. a refused rail is reported, never silently downgraded ---------------
: > "$SENT_LOG"
V=$(
  (
    export SUDO_USER="agent-dev" SUDO_UID="$(id -u)"
    require_root() { :; }
    _buzz_whois() { printf 'olivia agent\n'; return 0; }
    _buzz_bridge_a2a_send() { return 7; }
    _buzz_inbound --pubkey=aa --message-file="$BODY" 2>&1
  )
)
[[ "$V" == *"route=refused"* && "$V" == *"a2a-send-rc=7"* ]] \
  && ok_t "8 a refused a2a send is reported as refused, with the rc" \
  || bad_t "8 a refused a2a send is reported as refused, with the rc" "$V"
[[ "$V" == *"route=untrusted"* ]] \
  && bad_t "8 a refusal is not relabelled untrusted by the host" "$V" \
  || ok_t "8 a refusal is not relabelled untrusted by the host"

# --- 9. the body never travels in argv, and never comes from a foreign file --
OUT=$(
  (
    export SUDO_USER=agent-dev SUDO_UID="$(id -u)"
    require_root() { :; }
    _buzz_inbound --pubkey=aa
  ) 2>&1
)
grep -q 'never travels in argv' <<<"$OUT" \
  && ok_t "9 a missing --message-file is refused, and the refusal says why prose in argv is wrong" \
  || bad_t "9 a missing --message-file is refused, and the refusal says why prose in argv is wrong" "$OUT"
ln -s "$BODY" "$WORK/link"
OUT=$(
  (
    export SUDO_USER=agent-dev SUDO_UID="$(id -u)"
    require_root() { :; }
    _buzz_inbound --pubkey=aa --message-file="$WORK/link"
  ) 2>&1
)
grep -q 'not a symlink' <<<"$OUT" \
  && ok_t "9 a symlinked --message-file is refused" \
  || bad_t "9 a symlinked --message-file is refused" "$OUT"
OUT=$(
  (
    export SUDO_USER=agent-dev SUDO_UID=999999
    require_root() { :; }
    _buzz_inbound --pubkey=aa --message-file="$BODY"
  ) 2>&1
)
grep -q 'owned by the calling seat' <<<"$OUT" \
  && ok_t "9 a --message-file the caller does not own is refused" \
  || bad_t "9 a --message-file the caller does not own is refused" "$OUT"

# --- 10/11. the outbound mirror (a) was NOT carried (DIVE-6934) ------------
# Core called _buzz_mirror_outbound from cmd_send/cmd_ask/cmd_deliver. A plugin
# cannot hook core's send path, so the mirror did not move; this arm keeps it
# from coming back as dead code that reads like a live feature.
grep -q '^_buzz_mirror_outbound()' "$SRC/cmd_agent_buzz_bridge.sh" \
  && bad_t "10 the outbound mirror is not defined in the plugin" "a function nothing calls" \
  || ok_t "10 the outbound mirror is not defined in the plugin"

# --- 12. the plugin's untrusted paragraph is UNCHANGED ----------------------
# The row is explicit: class (d) keeps server.ts's untrusted-input instruction
# verbatim. This harness cannot see the plugins repo, so it grades the CLI's own
# promise instead — that nothing here ever writes an instruction into the body it
# relays. The body is copied with `cat`, never rewritten.
awk '/^_buzz_inbound\(\)/,/^}/' "$SRC/cmd_agent_buzz_bridge.sh" | grep -q 'cat "\$msg_file"' \
  && ok_t "12 the relayed body is copied verbatim, never rewritten" \
  || bad_t "12 the relayed body is copied verbatim, never rewritten" \
           "the bridge edits attacker-chosen text before delivering it"

# --- 13. the REAL reader, against a REAL registry, under --json ------------
# Arms 6 and 7 stub `_buzz_whois` to grade the routing table, so none of them
# touches the one interaction that only exists when the two run together: the
# router asks the reader for its PLAIN "<seat> <role>" line while the router
# itself is in JSON mode for the plugin. A `JSON_MODE=0 _buzz_whois` prefix on a
# FUNCTION call persists in bash after the call returns — it is contained here
# only because the call sits inside a command substitution. That is a property of
# where the call is written, which the next edit can move without noticing, and
# if it broke, `seat` would silently become the first word of a JSON object and
# the bridge would relay under `from=buzz:{"ok":true,...`.
#
# So this arm runs the REAL reader against a REAL registry file, both ways round.
REG=$(mktemp -d); chmod 755 "$REG"
KEY=$(printf 'b%.0s' $(seq 64))
printf '{"agents":{"olivia":{"type":"claude","buzz":{"pubkey":"%s"}},"dev":{"type":"claude"}}}\n' "$KEY" > "$REG/agents.json"
chmod 644 "$REG/agents.json"
printf 'do the thing\n' > "$REG/body"
real_probe() { # <extra-flags…>
  (
    # REGISTRY, not just STATE_DIR: header.sh derives $REGISTRY from $STATE_DIR
    # with a BARE TOP-LEVEL ASSIGNMENT, which is evaluated once when this harness
    # sourced it and is not env-overridable afterwards. Pointing STATE_DIR at the
    # fixture and stopping there reads the LIVE registry and answers no-match —
    # a green-looking arm that graded nothing about this fixture.
    export STATE_DIR="$REG" REGISTRY="$REG/agents.json" SUDO_USER=agent-dev SUDO_UID="$(id -u)"
    require_root() { :; }
    _buzz_bridge_a2a_send() { printf 'to=%s from=%s\n' "$1" "$2" >>"$SENT_LOG"; return 0; }
    _buzz_inbound "$@" --pubkey="$KEY" --message-file="$REG/body" --channel=general 2>&1
  )
}
: > "$SENT_LOG"
V=$(real_probe --json)
jq -e '.ok == true and .data.route == "a2a" and .data.seat == "olivia" and .data.from == "buzz-olivia"' <<<"$V" >/dev/null 2>&1 \
  && ok_t "13 the real reader + the real registry route to a2a under --json" \
  || bad_t "13 the real reader + the real registry route to a2a under --json" "$V"
grep -qx 'to=dev from=buzz-olivia' "$SENT_LOG" \
  && ok_t "13 ...and the rail is handed the calling seat and the relayed label" \
  || bad_t "13 ...and the rail is handed the calling seat and the relayed label" "$(cat "$SENT_LOG")"
: > "$SENT_LOG"
V=$(real_probe)
[[ "$V" == "route=a2a reason=delivered seat=olivia from=buzz-olivia" ]] \
  && ok_t "13 the plain (non --json) verdict is unchanged by the JSON path" \
  || bad_t "13 the plain (non --json) verdict is unchanged by the JSON path" "$V"
# NEGATIVE CONTROL on the same fixture: a different key on a registry that IS
# readable is a MEASURED absence, so the two answers above are not just "this
# harness always says a2a".
: > "$SENT_LOG"
V=$( (export STATE_DIR="$REG" REGISTRY="$REG/agents.json" SUDO_USER=agent-dev SUDO_UID="$(id -u)"
      require_root() { :; }
      _buzz_bridge_a2a_send() { printf 'LEAK\n' >>"$SENT_LOG"; return 0; }
      _buzz_inbound --pubkey="$(printf 'c%.0s' $(seq 64))" --message-file="$REG/body" 2>&1) )
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=no-match"* ]] && [[ ! -s "$SENT_LOG" ]] \
  && ok_t "13 a different key on the SAME readable registry is a measured no-match" \
  || bad_t "13 a different key on the SAME readable registry is a measured no-match" "$V / $(cat "$SENT_LOG")"
rm -rf "$REG"

# --- 14. THE LABEL MUST BE SPELLABLE ON THE RAIL IT RIDES --------------------
# The arm this harness was missing, and its absence is why 40/0 was green while
# class (c) could not deliver on ANY host (quinn, iteration 1). Every arm above
# replaces _buzz_bridge_a2a_send and asserts the composed label is the string we
# expected; none of them asked whether the string is ACCEPTABLE to cmd_send, which
# runs valid_sender_label on every --from unconditionally. So: run the composed
# value through the REAL validator, and keep the old label as the negative control
# so this arm is measuring the validator and not just re-asserting a constant.
valid_sender_label "buzz-olivia" \
  && ok_t "14 the composed provenance label passes the REAL valid_sender_label" \
  || bad_t "14 the composed provenance label passes the REAL valid_sender_label" "buzz-olivia rejected"
valid_sender_label "buzz:olivia" \
  && bad_t "14 NEGATIVE CONTROL: a colon-separated label is rejected by that same validator" "buzz:olivia accepted — the validator is not measuring what this arm claims" \
  || ok_t "14 NEGATIVE CONTROL: a colon-separated label is rejected by that same validator"

# ...and end to end: take the label the ROUTER actually emitted and put THAT
# through the validator. The two checks above grade a constant; this one grades
# the composer, so a future edit to the prefix cannot pass arm 14 by accident.
: > "$SENT_LOG"
V=$(route_probe 0 "olivia agent" dev)
EMITTED=$(sed -n 's/.*from=\([^ ]*\).*/\1/p' "$SENT_LOG" | head -1)
[[ -n "$EMITTED" ]] && valid_sender_label "$EMITTED" \
  && ok_t "14 the label the router EMITTED ($EMITTED) passes the rail's validator" \
  || bad_t "14 the label the router EMITTED passes the rail's validator" "emitted='$EMITTED'"

# A seat name long enough to push `buzz-<seat>` past the validator's 32 chars is
# a MEASURED known teammate whose label cannot be spelled. It must not reach the
# rail (a guaranteed refusal), and it must not vanish either: untrusted, with a
# reason that names the cause rather than an opaque rail rc.
: > "$SENT_LOG"
LONGSEAT=$(printf 'o%.0s' $(seq 32))
V=$(route_probe 0 "$LONGSEAT agent" dev)
[[ "$V" == *"route=untrusted"* && "$V" == *"reason=label-unspellable"* ]] && [[ ! -s "$SENT_LOG" ]] \
  && ok_t "14 an unspellable label fails closed to untrusted and never reaches the rail" \
  || bad_t "14 an unspellable label fails closed to untrusted and never reaches the rail" "$V / $(cat "$SENT_LOG")"

# --- 15. --from MUST SURVIVE THE PATH cmd_send PICKS ------------------------
# cmd_send's scoped branch execs into `agent _deliver`, which carries no --from,
# so a send that took it would arrive labelled as the SEAT ITSELF — the forgery
# the prefix exists to prevent. Root never takes that branch and this verb is
# root-only, so the exposure is latent; graded anyway, in both directions, so it
# does not depend silently on the caller's privilege.
( a2a_needs_scoped() { return 1; }; _buzz_bridge_rail_carries_from dev ) \
  && ok_t "15 the rail is used when the direct path (which carries --from) is available" \
  || bad_t "15 the rail is used when the direct path (which carries --from) is available" "predicate said no"
( a2a_needs_scoped() { return 0; }; _buzz_bridge_rail_carries_from dev ) \
  && bad_t "15 NEGATIVE: the scoped path (which DROPS --from) is refused" "predicate said yes" \
  || ok_t "15 NEGATIVE: the scoped path (which DROPS --from) is refused"
RC=0
( _buzz_bridge_rail_carries_from() { return 1; }; _buzz_bridge_a2a_send dev buzz-olivia /dev/null ) || RC=$?
[[ "$RC" -eq "$E_PERMISSION" ]] \
  && ok_t "15 ...and the send refuses with E_PERMISSION rather than dropping the label" \
  || bad_t "15 ...and the send refuses with E_PERMISSION rather than dropping the label" "rc=$RC"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
