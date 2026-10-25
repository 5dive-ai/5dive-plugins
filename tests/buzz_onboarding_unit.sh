#!/usr/bin/env bash
# DIVE-6934 — `agent buzz enable`'s onboarding arms, moved from core's
# tests/buzz_channel_wiring_unit.sh section 9 when the verbs left core. The
# channel's wiring sites (valid_channel, marketplace routing, managed settings)
# stay graded in core; this grades the verb the plugin now ships.
#
# Run: bash tests/buzz_onboarding_unit.sh   (no root, no network)
set -uo pipefail
trap 'rc=$?; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=plugins/buzz/cli
# shellcheck source=/dev/null
source "$SRC/prelude.sh"
# shellcheck source=/dev/null
source "$SRC/binaries.sh"
PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

# --- 9. the onboarding command exists and is BUNDLED ------------------------
# A cli/ file that bin/buzz does not source is dead code that greps green.
BZ=$SRC/cmd_agent_buzz.sh
[[ -f "$BZ" ]] \
  && ok_t "cli/cmd_agent_buzz.sh exists" \
  || bad_t "cli/cmd_agent_buzz.sh exists" "the CLI half of buzz onboarding is missing"
# DIVE-6934: the verb is bin/buzz, which sources this file.
grep -qE '\bcmd_agent_buzz\b' plugins/buzz/bin/buzz \
  && ok_t "bin/buzz sources cli/cmd_agent_buzz.sh" \
  || bad_t "bin/buzz sources cli/cmd_agent_buzz.sh" \
           "the file is present but never sourced — \`5dive agent buzz\` would be 'command not found' in the plugin verb"
grep -qE 'cmd_agent_buzz "\$@"' plugins/buzz/bin/buzz \
  && ok_t "bin/buzz dispatches \`agent buzz\`" \
  || bad_t "bin/buzz dispatches \`agent buzz\`" "the verb is unreachable"

# Behavioural arms on the enable path. No agent user, no network, no root: probe
# the two refusals that must fire BEFORE anything is minted or written.
if [[ -f "$BZ" ]]; then
  # shellcheck source=/dev/null
  source "$BZ" 2>/dev/null
  out=$(cmd_agent_buzz enable 2>&1); rc=$?
  [[ "$rc" != "0" && "$out" == *"usage: 5dive agent buzz enable"* ]] \
    && ok_t "enable with no agent name refuses with usage" \
    || bad_t "enable with no agent name refuses with usage" "rc=$rc out=$out"
  out=$(cmd_agent_buzz frobnicate 2>&1); rc=$?
  [[ "$rc" != "0" && "$out" == *"unknown buzz verb"* ]] \
    && ok_t "an unknown buzz verb is refused by name" \
    || bad_t "an unknown buzz verb is refused by name" "rc=$rc out=$out"
  # The relay refusal is the load-bearing one: guessing a relay is how you get a
  # channel that reports success and connects to nothing.
  grep -q 'no relay chosen' "$BZ" \
    && ok_t "enable refuses rather than guessing a relay URL" \
    || bad_t "enable refuses rather than guessing a relay URL" \
             "a defaulted relay reproduces the exact defect this row fixes"
  # The key must be minted once, not on every run — a silent rotation reads to a
  # paired handset as the agent having left the room.
  grep -q 'rotate' "$BZ" && grep -q 'Reusing the existing buzz identity' "$BZ" \
    && ok_t "enable reuses an existing identity unless --rotate-key" \
    || bad_t "enable reuses an existing identity unless --rotate-key" \
             "a re-run would rotate the key underneath a paired handset"
  # 0600, owned by the agent: the private key is the agent's alone.
  grep -q '0o600' "$BZ" \
    && ok_t "the minted config is written 0600" \
    || bad_t "the minted config is written 0600" "an agent's private key must not be group/world readable"

  # The writer, RUN — not grepped. It is factored to take a runas user so this
  # arm needs no agent user, no root and no relay: pass our own name, the sudo
  # hop is skipped, and the file it produces is graded against the contract in
  # plugins/buzz/server.ts (private_key must match /^[0-9a-f]{64}$/ or the plugin
  # refuses to derive a pubkey and the channel is silently dead).
  #
  # DIVE-3565 — THIS ARM USED TO ENSHRINE THE DEFECT. It asserted
  # `.channels == ["general","ops"]` and called that "the five-field contract",
  # while server.ts:38 declares `channels: string[] // channel UUIDs to watch`
  # and hands each entry to `buzz messages get --channel`. So the arm was green
  # on a config the reader answers `invalid UUID: general` to, every tick,
  # forever. The contract is SIX fields now and the split is the whole point:
  # `.channel_names` carries what the operator typed, `.channels` carries only
  # ids the relay confirmed — empty until `buzz join` resolves them, because an
  # empty watch list is honest and a name in it is a lie.
  if command -v python3 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    TD=$(mktemp -d)
    FAKE_KEY=$(printf 'a%.0s' {1..64})
    _buzz_write_config "$(id -un)" "$TD/buzz" "https://relay.example.com" \
      "$FAKE_KEY" "general, ops" 9000 /usr/local/bin/buzz >/dev/null 2>&1
    W="$TD/buzz/config.json"
    if [[ -f "$W" ]] && jq -e . "$W" >/dev/null 2>&1; then
      ok_t "_buzz_write_config writes parseable JSON"
      jq -e '.relay_url == "https://relay.example.com"
             and (.private_key | test("^[0-9a-fA-F]{64}$"))
             and .channel_names == ["general","ops"]
             and .channels == []
             and .poll_ms == 9000
             and .buzz_path == "/usr/local/bin/buzz"' "$W" >/dev/null 2>&1 \
        && ok_t "the written config matches the plugin's contract (names and ids are DIFFERENT fields)" \
        || bad_t "the written config matches the plugin's contract (names and ids are DIFFERENT fields)" "got: $(cat "$W")"
      # The mutation that put us here: a NAME in the field the poller reads.
      jq -e '(.channels | map(select(. == "general" or . == "ops")) | length) == 0' "$W" >/dev/null 2>&1 \
        && ok_t "no channel NAME ever lands in .channels (the field the poller reads as a UUID)" \
        || bad_t "no channel NAME ever lands in .channels" \
                 "server.ts polls each entry with \`messages get --channel\`; a name there is 'invalid UUID' on every tick, silently (DIVE-3565)"
      # poll_ms must be a NUMBER: server.ts does Number(cfg.poll_ms) on the env
      # path but reads the file value straight, so a quoted "9000" is a config
      # the plugin loads and mis-schedules.
      [[ "$(jq -r '.poll_ms | type' "$W")" == "number" ]] \
        && ok_t "poll_ms is written as a number, not a string" \
        || bad_t "poll_ms is written as a number, not a string" "type=$(jq -r '.poll_ms | type' "$W")"
      [[ "$(stat -c '%a' "$W")" == "600" ]] \
        && ok_t "the written config is mode 600 on disk" \
        || bad_t "the written config is mode 600 on disk" "mode=$(stat -c '%a' "$W")"
    else
      bad_t "_buzz_write_config writes parseable JSON" "no readable config at $W"
    fi
    rm -rf "$TD"

    # --- the key must never become an ARGV element (ops, DIVE-3509 push gate) --
    # The first shape passed it as `env KEY=<hex> …`. /proc/<pid>/cmdline is
    # world-readable (no hidepid on our boxes), so every other agent user could
    # read a freshly minted private key for the width of the write; environ is
    # 0400 and would have been fine, argv is not.
    #
    # Graded BEHAVIOURALLY, not by grep: shadow `env` with a stub that records
    # the argv it was handed and then execs the real one, so this asserts what
    # the process actually receives rather than what the source appears to say.
    TD=$(mktemp -d)
    mkdir -p "$TD/bin"
    cat >"$TD/bin/env" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$ARGV_LOG"
exec /usr/bin/env "$@"
STUB
    chmod +x "$TD/bin/env"
    SECRET=$(printf 'b%.0s' {1..64})
    ARGV_LOG="$TD/argv.txt"; : >"$ARGV_LOG"
    ( export ARGV_LOG PATH="$TD/bin:$PATH"
      _buzz_write_config "$(id -un)" "$TD/buzz" "https://relay.example.com" \
        "$SECRET" general 15000 buzz >/dev/null 2>&1 )
    if [[ -s "$ARGV_LOG" ]]; then
      ok_t "CONTROL: the argv-recording stub actually fired"
      if grep -q "$SECRET" "$ARGV_LOG"; then
        bad_t "the private key never appears in argv" \
              "the minted key is a command-line argument — readable from /proc/<pid>/cmdline by every user on the box"
      else
        ok_t "the private key never appears in argv (it travels on stdin)"
      fi
      # And the key really did arrive: a leak-free call that also wrote nothing
      # would pass the arm above for the wrong reason.
      [[ "$(jq -r '.private_key' "$TD/buzz/config.json" 2>/dev/null)" == "$SECRET" ]] \
        && ok_t "POSITIVE CONTROL: the key still reached the config via stdin" \
        || bad_t "POSITIVE CONTROL: the key still reached the config via stdin" \
                 "no-leak is trivially true if the write never happened"
    else
      bad_t "CONTROL: the argv-recording stub actually fired" \
            "nothing recorded — the arm below would pass without observing anything"
    fi
    rm -rf "$TD"
  else
    printf 'SKIP - _buzz_write_config run arms (need python3 + jq)\n'
  fi
fi


printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
