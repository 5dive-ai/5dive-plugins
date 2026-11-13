#!/usr/bin/env bash
# DIVE-8315 — `5dive agent email connect|status|disconnect|gate`, against a
# stubbed 5dive. Runs as root (connect writes another user's 0600 file and
# refuses anyone else), so: sudo bash tests/email_cli_unit.sh
#
# The stub records every core call it gets, so each arm grades what connect
# ASKED core to do (channel, secret link), not just what it printed.
# Addresses are @example.com (the fixture rule); the self-hosted domain is
# example.com too.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/plugins/email/bin/email"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/       /' <<<"$2"; }
ME="${SUDO_USER:-root}"
A=max@example.com
AU=$(tr a-z A-Z <<<"$A")

mkdir -p "$W/home/agent-max/.claude" "$W/conn" "$W/etc" "$W/spool"
cat >"$W/5dive" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$1 $2" in
  "agent info") [[ "$3" == max ]] || exit 4
    printf '{"ok":true,"data":{"name":"max","type":"%s","channels":"%s"}}\n' "${STUB_TYPE:-claude}" "$(cat "$STUB_CHANNELS")" ;;
  "agent config") echo "${5#channels=}" >"$STUB_CHANNELS" ;;
esac
exit 0
STUB
chmod +x "$W/5dive"
echo telegram >"$W/channels"
export STUB_LOG="$W/log" STUB_CHANNELS="$W/channels"
export EMAIL_5DIVE_BIN="$W/5dive" EMAIL_CONNECTORS_DIR="$W/conn" AGENT_HOME_ROOT="$W/home" EMAIL_AGENT_USER="$ME"
export EMAIL_MAIL_ETC="$W/etc" EMAIL_MAIL_SPOOL="$W/spool" FIVE_LOCAL_ONLY_FILE="$W/local-only"
CFG="$W/home/agent-max/.claude/channels/email/config.json"
run() { : >"$STUB_LOG"; OUT=$(bash "$BIN" agent "$@" 2>&1); RC=$?; }

echo "connect, a firm mailbox"
run connect max --address=$A --provider=google --password=hunter2
[[ $RC == 3 && "$OUT" == *"never an argument"* && ! -e "$CFG" ]] && ok "C1 a password on the command line is refused, nothing written" || bad "C1 password argv" "$RC $OUT"
run connect max --address=not-an-address --provider=google
[[ $RC == 3 ]] && ok "C2 a bad address is refused" || bad "C2 bad address" "$RC $OUT"
run connect max --address=$A --provider=microsoft
[[ $RC == 3 && "$OUT" == *"Microsoft sign-in"* && ! -e "$CFG" ]] && ok "C2b Microsoft 365 is refused honestly (no password IMAP there since 2022), nothing written" || bad "C2b microsoft" "$RC $OUT"
run connect max --address=$A --provider=google
[[ $RC == 6 && "$OUT" == *"secret write EMAIL_PASSWORD --connector=email-max"* && ! -e "$CFG" ]] && ok "C3 no password on the box yet: refused with the secret-write line" || bad "C3 no secret" "$RC $OUT"
run connect max --address=$A --provider=google --task=DIVE-1
[[ $RC == 6 ]] && grep -qE '^task need DIVE-1 --type=secret --secret-key=EMAIL_PASSWORD --connector=email-max ' "$W/log" \
  && ok "C3b --task opens a one-time secret link for EMAIL_PASSWORD" || bad "C3b secret link" "$RC $OUT $(cat "$W/log")"
printf 'EMAIL_PASSWORD=app-pw-1\n' >"$W/conn/email-max.env"
run connect max --address=$AU --provider=google --name=Max
[[ $RC == 0 && "$(stat -c '%a %U' "$CFG")" == "600 $ME" \
   && "$(jq -c '[.address,.mode,.imap.host,.imap.port,.imap.secure,.smtp.host,.smtp.port,.smtp.secure,.smtp.pass]' "$CFG")" == "[\"$A\",\"imap\",\"imap.gmail.com\",993,true,\"smtp.gmail.com\",465,true,\"app-pw-1\"]" \
   && "$(cat "$W/channels")" == "telegram,email" ]] \
  && ok "C4 connect writes the agent's 0600 config (google preset, address lower-cased) and turns the channel on" || bad "C4 connect" "$RC $OUT $(cat "$CFG" 2>/dev/null)"
[[ "$OUT" != *app-pw-1* ]] && ! grep -q app-pw-1 "$W/log" && ok "C4b the password is never printed or passed to core" || bad "C4b password leak"

echo "the owner's switches"
run gate max off
[[ $RC == 0 && "$(jq -r .approve_new "$CFG")" == false ]] && ok "G1 gate off writes approve_new:false" || bad "G1 gate off" "$RC $OUT"
run cap max 7
run connect max --provider=google
[[ "$(jq -c '[.approve_new,.daily_cap,.address]' "$CFG")" == "[false,7,\"$A\"]" ]] && ok "G2 a re-run of connect keeps the owner's gate, cap and address" || bad "G2 keep" "$(cat "$CFG")"
run gate max on
[[ "$(jq -r .approve_new "$CFG")" == true ]] && ok "G3 gate on again" || bad "G3 gate on"

echo "local-only"
: >"$FIVE_LOCAL_ONLY_FILE"
run connect max --address=$A --provider=google
[[ $RC == 10 && "$OUT" == *"local-only allow email"* ]] && ok "L1 offline: a cloud mailbox is refused, naming the IT switch" || bad "L1 offline cloud" "$RC $OUT"
run connect max --address=$A --imap-host=localhost --smtp-host=localhost
[[ $RC == 0 && "$(jq -r .imap.host "$CFG")" == localhost ]] && ok "L2 offline: a mail server on the office network (here: this box) is allowed" || bad "L2 offline LAN" "$RC $OUT"
echo email >"$W/local-only.allow"
run connect max --address=$A --provider=google
[[ $RC == 0 ]] && ok "L3 IT opened email: the cloud mailbox connects" || bad "L3 allow email" "$RC $OUT"
rm -f "$FIVE_LOCAL_ONLY_FILE" "$W/local-only.allow"

echo "self-hosted"
run connect max --self-hosted
[[ $RC == 4 && "$OUT" == *"server setup --domain="* ]] && ok "S1 no mail server yet: says how to set one up" || bad "S1 no server" "$RC $OUT"
echo '{"domain":"example.com","agents":{}}' >"$W/etc/server.json"
run connect max --self-hosted
PW=$(jq -r .smtp.pass "$CFG"); H=$(printf '%s' "$PW" | sha256sum | cut -d' ' -f1)
[[ $RC == 0 && "$(jq -c '[.address,.mode,.smtp.host,.smtp.port,.approve_new]' "$CFG")" == "[\"$A\",\"local\",\"127.0.0.1\",587,true]" \
   && ${#PW} -ge 24 && "$(jq -r .agents.max.pass_sha256 "$W/etc/server.json")" == "$H" \
   && "$(jq -r .agents.max.maildir "$W/etc/server.json")" == "$W/spool/boxes/max" && -d "$W/spool/boxes/max/new" ]] \
  && ok "S2 self-hosted: max@<domain>, a fresh password whose hash is on the server, its own maildir" || bad "S2 self-hosted" "$RC $OUT $(cat "$CFG")"
[[ "$OUT" != *"$PW"* ]] && ok "S2b the new password is never printed" || bad "S2b printed"

echo "status, disconnect"
OUT=$(FIVEDIVE_JSON_MODE=1 bash "$BIN" agent status max 2>&1)
[[ "$(jq -c '.data | [.connected,.address,.mode,.gate]' <<<"$OUT")" == "[true,\"$A\",\"local\",\"on\"]" ]] && ok "T1 status --json" || bad "T1 status" "$OUT"
run disconnect max
[[ $RC == 0 && ! -e "$CFG" && ! -e "$W/conn/email-max.env" && "$(jq -c '.agents' "$W/etc/server.json")" == '{}' && "$(cat "$W/channels")" == telegram ]] \
  && ok "T2 disconnect: config, password and server entry gone; channel off" || bad "T2 disconnect" "$RC $OUT"

echo "$PASS passed, $FAIL failed"
(( FAIL == 0 ))
