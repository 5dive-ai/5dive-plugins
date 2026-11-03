#!/usr/bin/env bash
# DIVE-7658 — `5dive agent teams connect|status|disconnect`, against a stubbed
# 5dive. Runs as root (connect writes another user's 0600 file and refuses
# anyone else), so: sudo bash tests/teams_cli_unit.sh
#
# The stub records every core call it gets, so each arm grades what connect
# ASKED core to do (route, channel, secret link), not just what it printed.
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/plugins/teams/bin/teams"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/       /' <<<"$2"; }

APP=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
TEN=11111111-2222-3333-4444-555555555555
ME="${SUDO_USER:-root}"

mkdir -p "$W/home/agent-max/.claude" "$W/conn" "$W/pk"
cat >"$W/5dive" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$1 $2" in
  "agent info")
    [[ "$3" == max ]] || exit 4
    printf '{"ok":true,"data":{"name":"max","type":"%s","channels":"%s"}}\n' "${STUB_TYPE:-claude}" "$(cat "$STUB_CHANNELS")" ;;
  "agent config") echo "${5#channels=}" >"$STUB_CHANNELS" ;;
  "route ls") [[ -f "$STUB_ROUTED" ]] && echo "teams-max 39999 root" ;;
  "route add") touch "$STUB_ROUTED" ;;
  "route rm") rm -f "$STUB_ROUTED" ;;
esac
exit 0
STUB
chmod +x "$W/5dive"

run() {
  env STUB_LOG="$W/log" STUB_CHANNELS="$W/channels" STUB_ROUTED="$W/routed" STUB_TYPE="${STUB_TYPE:-claude}" \
    TEAMS_5DIVE_BIN="$W/5dive" TEAMS_CONNECTORS_DIR="$W/conn" TEAMS_PROVISIONING="$W/prov.env" \
    FIVE_LOCAL_ONLY_FILE="$W/local-only" TEAMS_PACKAGES_DIR="$W/pk" AGENT_HOME_ROOT="$W/home" \
    TEAMS_AGENT_USER="$ME" FIVEDIVE_JSON_MODE="${JSON:-0}" bash "$BIN" "$@" 2>&1
}
reset() { : >"$W/log"; echo telegram >"$W/channels"; rm -f "$W/routed" "$W/local-only" "$W/conn/"* "$W/home/agent-max/.claude/channels/teams/"* 2>/dev/null; echo 'FIVE_DOMAIN=box.example.com' >"$W/prov.env"; }

echo "teams CLI"

reset; touch "$W/local-only"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 10 && "$out" == *"Teams goes through Microsoft's cloud, so it is off on a fully offline server"* && $(wc -l <<<"$out") -eq 1 ]] \
  && ok "offline server: connect refuses with one line" || bad "offline refusal (rc=$rc)" "$out"

reset
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN --secret=hunter2); rc=$?
[[ $rc -eq 3 && "$out" == *"never an argument"* ]] && ok "the secret as an argument is refused" || bad "secret flag (rc=$rc)" "$out"

reset
out=$(run agent connect max --app-id=nope --tenant-id=$TEN); rc=$?
[[ $rc -eq 3 ]] && ok "a bad app id is refused" || bad "bad app id (rc=$rc)" "$out"

reset; STUB_TYPE=codex
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 3 && "$out" == *"Claude Code agents"* ]] && ok "non-Claude agents are refused for now" || bad "codex refusal (rc=$rc)" "$out"
STUB_TYPE=claude

reset
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 6 && "$out" == *"secret write TEAMS_APP_PASSWORD --connector=teams-max"* ]] \
  && ok "no secret yet: stops and names the safe way in" || bad "no-secret stop (rc=$rc)" "$out"

reset
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN --task=DIVE-1); rc=$?
grep -q -- "task need DIVE-1 --type=secret --secret-key=TEAMS_APP_PASSWORD --connector=teams-max" "$W/log" && [[ $rc -eq 6 ]] \
  && ok "--task opens a one-time secret link on that task" || bad "secret link (rc=$rc)" "$(cat "$W/log"; echo "$out")"

reset; echo 'TEAMS_APP_PASSWORD=s3cr3t-value' >"$W/conn/teams-max.env"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN --role="Paralegal"); rc=$?
cfg="$W/home/agent-max/.claude/channels/teams/config.json"
[[ $rc -eq 0 ]] && ok "connect succeeds with the secret in place" || bad "connect (rc=$rc)" "$out"
[[ "$(stat -c %a "$cfg" 2>/dev/null)" == 600 && "$(stat -c %U "$cfg")" == "$ME" ]] && ok "config is 0600 and the agent's" || bad "config mode/owner" "$(ls -l "$cfg" 2>&1)"
jq -e --arg a $APP --arg t $TEN '.app_id == $a and .tenant_id == $t and .app_password == "s3cr3t-value" and (.port | type == "number") and .public_url == "https://teams-max.box.example.com/api/messages"' "$cfg" >/dev/null \
  && ok "config carries the ids, the secret, a port and the box's own endpoint" || bad "config fields" "$(cat "$cfg")"
grep -qE "^route add teams-max --port=[0-9]+$" "$W/log" && ok "the endpoint is published on the box's own domain (no 5dive relay)" || bad "route add" "$(cat "$W/log")"
[[ "$(cat "$W/channels")" == "telegram,teams" ]] && ok "the channel is added beside the existing one" || bad "channels" "$(cat "$W/channels")"
[[ "$out" != *s3cr3t* ]] && ! grep -q s3cr3t "$W/log" && ok "the secret is never printed or passed to core" || bad "secret leaked" "$out"
unzip -p "$W/pk/max-teams-app.zip" manifest.json 2>/dev/null | jq -e --arg a $APP '.bots[0].botId == $a and .name.short == "Max" and .description.short == "Paralegal" and .validDomains == ["teams-max.box.example.com"]' >/dev/null \
  && ok "the app package names the bot, the agent and its role" || bad "package manifest" "$(unzip -l "$W/pk/max-teams-app.zip" 2>&1)"

: >"$W/log"
out=$(run agent connect max); rc=$?
[[ $rc -eq 0 ]] && ! grep -q "route add" "$W/log" && [[ "$(cat "$W/channels")" == "telegram,teams" ]] \
  && ok "re-running connect keeps its ids, route and channel (idempotent)" || bad "rerun (rc=$rc)" "$(cat "$W/log"; echo "$out")"

out=$(JSON=1 run agent status max); rc=$?
jq -e '.data.connected == true and .data.channels == "telegram,teams"' <<<"$out" >/dev/null && ok "status --json reports connected" || bad "status" "$out"

reset; rm -f "$W/prov.env"; echo 'TEAMS_APP_PASSWORD=x' >"$W/conn/teams-max.env"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 0 && "$out" == *"Forward the public address to this server"* ]] && ! grep -q "route add" "$W/log" \
  && ok "self-hosted, no domain: prints exactly what to forward" || bad "self-hosted (rc=$rc)" "$out"
out=$(run agent connect max --endpoint=https://bots.firm.example/max); rc=$?
jq -e '.public_url == "https://bots.firm.example/max/api/messages"' "$cfg" >/dev/null && ok "--endpoint names the office's own address" || bad "endpoint" "$(cat "$cfg")"

echo 'FIVE_DOMAIN=box.example.com' >"$W/prov.env"; touch "$W/routed"; : >"$W/log"
out=$(run agent disconnect max); rc=$?
[[ $rc -eq 0 && ! -e "$cfg" && ! -e "$W/conn/teams-max.env" && "$(cat "$W/channels")" == "telegram" ]] && grep -q "route rm teams-max" "$W/log" \
  && ok "disconnect removes the channel, the route, the settings and the secret" || bad "disconnect (rc=$rc)" "$(cat "$W/log"; echo "$out")"

echo "teams CLI: $PASS pass, $FAIL fail"
(( FAIL == 0 ))
