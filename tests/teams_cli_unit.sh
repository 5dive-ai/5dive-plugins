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

mkdir -p "$W/home/agent-max/.claude" "$W/conn" "$W/pk" "$W/tmp"
cat >"$W/5dive" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$1 $2" in
  "agent info")
    [[ "$3" == max ]] || exit 4
    printf '{"ok":true,"data":{"name":"max","type":"%s","channels":"%s"}}\n' "${STUB_TYPE:-claude}" "$(cat "$STUB_CHANNELS")" ;;
  "agent config") echo "${5#channels=}" >"$STUB_CHANNELS" ;;
  # The match comes FIRST and more lines follow, as on a real box: a reader
  # that stops at the first hit leaves the rest to SIGPIPE, which pipefail
  # reads as "not routed" (the live re-run of connect hit exactly that).
  "route ls") [[ -f "$STUB_ROUTED" ]] && { echo "teams-max 39999 root"; sleep 0.3; echo "teams-zed 39998 root"; } ;;
  "route add") touch "$STUB_ROUTED" ;;
  "route rm") rm -f "$STUB_ROUTED" ;;
  "browser serve") [[ -n "${STUB_NOPROFILE:-}" && ! -e "$STUB_NOPROFILE" && "$*" == *--login* ]] && { echo "browser: no profile for $3" >&2; exit 4; } ;;
  "browser auth") [[ -n "${STUB_NOPROFILE:-}" ]] && touch "$STUB_NOPROFILE" ;;
  # DIVE-7831: the value arrives on stdin only, as `secret write` takes it.
  "secret write") v=$(cat); printf 'TEAMS_APP_PASSWORD=%s\n' "$v" >"$STUB_CONN/${4#--connector=}.env" ;;
esac
exit 0
STUB
chmod +x "$W/5dive"

# DIVE-7831: Microsoft's teams CLI, systemd-run and systemctl, faked. The fake
# CLI is signed in when $W/ms-in exists; its sideloading answers come from
# $W/ms-side ("tenant user", default "true true"). It records each call, and the
# mode of the --env file it was handed (the secret's file must be 0600).
cat >"$W/msteams" <<'MS'
#!/usr/bin/env bash
[[ "$1" == --disable-auto-update ]] && shift
echo "$*" >>"$MS_LOG"
case "$1" in
  --version) echo 3.0.4 ;;
  status)
    if [[ -e "$MS_DIR/ms-in" ]]; then
      read -r t u < <(cat "$MS_DIR/ms-side" 2>/dev/null || echo "true true")
      printf '{"loggedIn":true,"username":"admin@firm.example","tenantId":"%s","tdp":{"connected":true,"sideloading":{"tenant":%s,"user":%s}}}\n' "$MS_TEN" "$t" "$u"
    else echo '{"loggedIn":false,"username":null,"tdp":null}'; fi ;;
  app)
    # DIVE-8022: the libsecret warning comes on every call on a box with no
    # keyring. $MS_DIR/ms-fail picks how a failure is told: json = the CLI's own
    # {ok:false} on stdout (its --json handler); stderr = a crash outside it,
    # message then suggestion, in color; warn = the warnings and nothing else.
    if [[ -s "$MS_DIR/ms-fail" ]]; then
      printf '\e[33mWarning: libsecret not found — token cache will be stored unencrypted.\nInstall it for secure storage: sudo apt install libsecret-1-dev\e[39m\n' >&2
      case "$(cat "$MS_DIR/ms-fail")" in
        json) printf '{\n  "ok": false,\n  "error": {\n    "code": "NOT_FOUND_AAD",\n    "message": "AAD app not yet available in Graph API.",\n    "suggestion": "Try again shortly."\n  }\n}\n' ;;
        stderr) printf '\e[31mFailed to get TDP token.\e[39m\nTry `teams login` again.\n' >&2 ;;
      esac
      exit 1
    fi
    # DIVE-8022: the icon files are gone once the call returns; keep a copy to grade.
    env=""; while (($#)); do
      case "$1" in
        --env) env="$2" ;;
        --color-icon) cp "$2" "$MS_DIR/got-color.png" ;;
        --outline-icon) cp "$2" "$MS_DIR/got-outline.png" ;;
      esac; shift; done
    rm -f "$env"  # the worst case: a fresh file made under the caller's umask
    printf 'CLIENT_ID=%s\nCLIENT_SECRET=ms-s3cr3t~value\nTENANT_ID=%s\n' "$MS_APP" "$MS_TEN" >"$env"
    stat -c %a "$env" >"$MS_DIR/envmode"
    printf '{"appName":"x","teamsAppId":"t-app-1","botId":"%s","installLink":"https://teams.microsoft.com/l/app/t-app-1?tenantId=%s","credentialsFile":"%s"}\n' "$MS_APP" "$MS_TEN" "$env" ;;
esac
MS
cat >"$W/systemd-run" <<'SR'
#!/usr/bin/env bash
echo "$*" >>"$MS_LOG"
touch "$MS_DIR/active"
printf '%s\n' "${MS_URL:-https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A40001}" >"${@: -1}"
SR
cat >"$W/systemctl" <<'SC'
#!/usr/bin/env bash
case "$1" in is-active) [[ -e "$MS_DIR/active" ]] ;; stop) rm -f "$MS_DIR/active" ;; esac
SC
chmod +x "$W/msteams" "$W/systemd-run" "$W/systemctl"
mkdir -p "$W/mshome"

run() {
  env STUB_LOG="$W/log" STUB_CONN="$W/conn" STUB_NOPROFILE="${STUB_NOPROFILE:-}" \
    MS_LOG="$W/mslog" MS_DIR="$W" MS_APP="$APP" MS_TEN="$TEN" MS_URL="${MS_URL:-}" \
    TEAMS_MSCLI_BIN="$W/msteams" TEAMS_MSCLI_HOME="$W/mshome" TEAMS_MSCLI_DIST="$W/dist" \
    TEAMS_SYSTEMD_RUN="$W/systemd-run" TEAMS_SYSTEMCTL="$W/systemctl" TEAMS_SIGNIN_WAIT=2 \
    STUB_LOG="$W/log" STUB_CHANNELS="$W/channels" STUB_ROUTED="$W/routed" STUB_TYPE="${STUB_TYPE:-claude}" \
    TEAMS_5DIVE_BIN="$W/5dive" TEAMS_CONNECTORS_DIR="$W/conn" TEAMS_PROVISIONING="$W/prov.env" \
    FIVE_LOCAL_ONLY_FILE="$W/local-only" TEAMS_PACKAGES_DIR="$W/pk" AGENT_HOME_ROOT="$W/home" \
    TMPDIR="$W/tmp" TEAMS_AGENT_USER="$ME" FIVEDIVE_JSON_MODE="${JSON:-0}" bash "$BIN" "$@" 2>&1
}
reset() { : >"$W/log"; echo telegram >"$W/channels"; rm -f "$W/routed" "$W/local-only" "$W/local-only.allow" "$W/conn/"* "$W/home/agent-max/.claude/channels/teams/"* 2>/dev/null; echo 'FIVE_DOMAIN=box.example.com' >"$W/prov.env"; }

echo "teams CLI"

reset; touch "$W/local-only"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 10 && "$out" == *"Teams goes through Microsoft's cloud, so it is shut on this offline server"* && "$out" == *"local-only allow teams"* && $(wc -l <<<"$out") -eq 1 ]] \
  && ok "offline server: connect refuses with one line naming IT's switch" || bad "offline refusal (rc=$rc)" "$out"

# DIVE-7658: the firm's IT opened Teams alone → connect goes past the refusal.
reset; touch "$W/local-only"; echo teams > "$W/local-only.allow"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -ne 10 && "$out" != *"shut on this offline server"* ]] \
  && ok "offline server with Teams allowed: connect is not refused" || bad "allow teams (rc=$rc)" "$out"
reset; touch "$W/local-only"; echo other > "$W/local-only.allow"
out=$(run agent connect max --app-id=$APP --tenant-id=$TEN); rc=$?
[[ $rc -eq 10 ]] && ok "an allow file without teams still refuses" || bad "allow other (rc=$rc)" "$out"

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

# ─── DIVE-7831: --microsoft ───
msreset() { reset; rm -f "$W/ms-in" "$W/ms-side" "$W/ms-fail" "$W/active" "$W/envmode" "$W/np" "$W/mshome/"* "$W/got-"*.png "$W/home/agent-max/.claude/avatar.png"; : >"$W/mslog"; }
cfg="$W/home/agent-max/.claude/channels/teams/config.json"

msreset
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && jq -e '.data.state == "sign_in" and .data.site == "login.microsoftonline.com"' <<<"$out" >/dev/null \
  && ok "microsoft, signed out: --json says sign_in and names the browser site" || bad "sign_in json (rc=$rc)" "$out"
grep -q "unit=5dive-teams-signin.*ms-signin.mjs $W/dist $W/mshome/signin.url" "$W/mslog" \
  && ok "the sign-in runs as its own timed unit, writing its page to a file" || bad "signin unit" "$(cat "$W/mslog")"
grep -q -- "RuntimeMaxSec=900" "$W/mslog" && grep -q -- "UMask=0077" "$W/mslog" \
  && ok "the sign-in unit is capped at 15 minutes and writes nothing readable by others" || bad "unit limits" "$(cat "$W/mslog")"
grep -qF "browser serve login.microsoftonline.com --login --url=https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" "$W/log" \
  && ok "Microsoft's page opens in the box's own browser, plain Chrome, on that site" || bad "serve" "$(cat "$W/log")"
! grep -q "app create" "$W/mslog" && [[ ! -e "$cfg" ]] && ok "nothing is made before the sign-in" || bad "made too early" "$(cat "$W/mslog")"

: >"$W/log"; : >"$W/mslog"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && ! grep -q "unit=" "$W/mslog" && ! grep -q -- "--stop" "$W/log" && grep -q -- "browser serve login.microsoftonline.com --login" "$W/log" \
  && ok "asking again while the sign-in waits reuses it (no new sign-in, the open page kept)" || bad "reuse (rc=$rc)" "$(cat "$W/log" "$W/mslog")"

msreset
out=$(run agent connect max --microsoft); rc=$?
[[ $rc -eq 6 && "$out" == *"Sign in with Microsoft"* && "$out" == *"browser viewer login.microsoftonline.com --bind=local"* ]] \
  && ok "without --json: exit 6 and how to see the page at a terminal" || bad "sign_in words (rc=$rc)" "$out"

msreset; STUB_NOPROFILE="$W/np"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
STUB_NOPROFILE=""
[[ $rc -eq 0 ]] && grep -q "browser auth login.microsoftonline.com" "$W/log" && [[ "$(grep -c -- 'serve login.microsoftonline.com --login --url=' "$W/log")" == 2 ]] \
  && ok "no browser profile yet: makes one, then opens the sign-in page" || bad "no profile (rc=$rc)" "$(cat "$W/log")"

msreset; MS_URL="https://evil.example/login"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
MS_URL=""
[[ $rc -eq 3 ]] && ! grep -q "browser serve" "$W/log" && ok "a page that is not Microsoft's sign-in is never opened" || bad "url check (rc=$rc)" "$out"

msreset; touch "$W/ms-in"; echo "false true" >"$W/ms-side"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && jq -e '.data.state == "blocked" and .data.reason == "custom_apps_off" and (.data.message | test("Org-wide app settings"))' <<<"$out" >/dev/null \
  && ! grep -q "app create" "$W/mslog" && ok "custom apps off for the firm: stops before making anything, names the switch" || bad "tenant blocked (rc=$rc)" "$out"
msreset; touch "$W/ms-in"; echo "true false" >"$W/ms-side"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
jq -e '.data.state == "blocked" and (.data.message | test("Setup policies"))' <<<"$out" >/dev/null && ! grep -q "app create" "$W/mslog" \
  && ok "custom apps off for the user: stops, names the policy" || bad "user blocked (rc=$rc)" "$out"

msreset; touch "$W/ms-in" "$W/active"; echo "https://login.microsoftonline.com/x" >"$W/mshome/signin.url"
out=$(JSON=1 run agent connect max --microsoft --role=Paralegal); rc=$?
[[ $rc -eq 0 ]] && jq -e --arg t "$TEN" '.data.state == "ready" and .data.name == "Max" and .data.install_link == "https://teams.microsoft.com/l/app/t-app-1?tenantId=\($t)"' <<<"$(tail -1 <<<"$out")" >/dev/null \
  && ok "signed in: ready, with the Add to Teams link" || bad "ready (rc=$rc)" "$out"
grep -qF "app create --name Max --endpoint https://teams-max.box.example.com/api/messages --env $W/mshome/app-" "$W/mslog" \
  && ok "the bot is made with the agent's name and its own address on this box" || bad "app create args" "$(cat "$W/mslog")"
! grep -q -- "-icon" "$W/mslog" && [[ ! -e "$W/got-color.png" ]] \
  && ok "an agent with no face: no icons are sent, Teams shows its own tile" || bad "no-face icons" "$(cat "$W/mslog")"
[[ "$(cat "$W/envmode" 2>/dev/null)" == 600 ]] && ok "Microsoft's secret file is 0600 while it exists" || bad "env mode" "$(cat "$W/envmode" 2>&1)"
! ls "$W/mshome"/app-*.env >/dev/null 2>&1 && [[ ! -e "$W/mshome/made-max.json" ]] && ok "the secret file and the made-record are gone after" || bad "leftovers" "$(ls -la "$W/mshome")"
jq -e --arg a $APP --arg t $TEN '.app_id == $a and .tenant_id == $t and .app_password == "ms-s3cr3t~value" and .install_link and .teams_app_id == "t-app-1" and .public_url == "https://teams-max.box.example.com/api/messages"' "$cfg" >/dev/null \
  && [[ "$(stat -c %a "$cfg")" == 600 ]] && ok "the agent's config has the made bot, its secret and link, still 0600" || bad "config" "$(ls -l "$cfg"; cat "$cfg")"
[[ "$(cat "$W/channels")" == "telegram,teams" ]] && grep -qE "^route add teams-max" "$W/log" && ok "then connects as before: route and channel" || bad "connect steps" "$(cat "$W/log")"
grep -q "browser viewer-revoke login.microsoftonline.com" "$W/log" && [[ ! -e "$W/mshome/signin.url" && ! -e "$W/active" ]] \
  && ok "signed in: the sign-in view is closed and the waiting sign-in stopped" || bad "close" "$(cat "$W/log")"
# The box's browser held the owner's Microsoft session; every agent may use the box's browser logins.
grep -q "browser forget login.microsoftonline.com" "$W/log" && [[ "$(grep -n "viewer-revoke login" "$W/log" | cut -d: -f1)" -lt "$(grep -n "browser forget login" "$W/log" | cut -d: -f1)" ]] \
  && ok "signed in: the box's browser is signed out of Microsoft again, after the view is closed" || bad "forget" "$(cat "$W/log")"
[[ "$out" != *s3cr3t* ]] && ! grep -q s3cr3t "$W/log" "$W/mslog" && ok "the secret is never printed or passed as an argument" || bad "secret leaked" "$out"
grep -q '^TEAMS_APP_PASSWORD=ms-s3cr3t~value$' "$W/conn/teams-max.env" && ok "the secret went through secret write, on stdin" || bad "secret write" "$(cat "$W/conn/teams-max.env" 2>&1)"

: >"$W/mslog"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && jq -e '.data.state == "ready" and (.data.install_link | test("t-app-1"))' <<<"$out" >/dev/null && ! grep -q "app create" "$W/mslog" \
  && ok "asking again: the same link, no second bot" || bad "rerun (rc=$rc)" "$out"
out=$(JSON=1 run agent status max)
jq -e '.data.install_link | test("t-app-1")' <<<"$out" >/dev/null && ok "status --json carries the Add to Teams link" || bad "status link" "$out"

# A run that made the bot and died before connecting does not make a second one.
msreset; touch "$W/ms-in"; echo 'TEAMS_APP_PASSWORD=ms-s3cr3t~value' >"$W/conn/teams-max.env"
printf '{"install_link":"https://teams.microsoft.com/l/app/t-old","teams_app_id":"t-old","bot_id":"%s","app_id":"%s","tenant_id":"%s"}\n' $APP $APP $TEN >"$W/mshome/made-max.json"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && ! grep -q "app create" "$W/mslog" && jq -e '.data.install_link | test("t-old")' <<<"$(tail -1 <<<"$out")" >/dev/null \
  && ok "a bot made by a run that died is finished, not made twice" || bad "resume (rc=$rc)" "$out"

msreset; touch "$W/ms-in"; echo 'TEAMS_APP_PASSWORD=x' >"$W/conn/teams-max.env"; run agent connect max --app-id=$APP --tenant-id=$TEN >/dev/null; : >"$W/mslog"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 3 && "$out" == *"through your IT's own bot"* ]] && ! grep -q "app create" "$W/mslog" \
  && ok "an agent already on its IT's bot is not switched silently" || bad "it-path guard (rc=$rc)" "$out"

# DIVE-8022: a failed make shows Microsoft's reason, never the CLI's libsecret hint.
msreset; touch "$W/ms-in"; echo json >"$W/ms-fail"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -ne 0 && "$out" == *"Microsoft did not make the bot: AAD app not yet available in Graph API."* && "$out" != *libsecret* ]] \
  && ok "a failed make shows Microsoft's own reason (its --json error), not the libsecret warning" || bad "json why (rc=$rc)" "$out"
log="$W/mshome/last-error.log"
[[ "$(stat -c %a "$log" 2>/dev/null)" == 600 ]] && grep -q "NOT_FOUND_AAD" "$log" && grep -q "Try again shortly" "$log" && grep -q "libsecret" "$log" \
  && ok "the whole answer is kept in a 0600 log beside the CLI's login" || bad "error log" "$(ls -l "$log" 2>&1; cat "$log" 2>&1)"
! ls "$W/mshome"/app-*.env >/dev/null 2>&1 && [[ ! -e "$cfg" ]] && ok "a failed make leaves no secret file and connects nothing" || bad "fail leftovers" "$(ls -la "$W/mshome")"
msreset; touch "$W/ms-in"; echo stderr >"$W/ms-fail"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -ne 0 && "$out" == *"Microsoft did not make the bot: Failed to get TDP token."* && "$out" != *libsecret* && "$out" != *$'\e'* ]] \
  && ok "a crash told on stderr: the real line, without the warnings or color codes" || bad "stderr why (rc=$rc)" "$out"
msreset; touch "$W/ms-in"; echo warn >"$W/ms-fail"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -ne 0 && "$out" == *"Microsoft did not make the bot: no answer"* && "$out" != *libsecret* ]] \
  && ok "only warnings: says no answer rather than sending anyone to apt" || bad "warn-only (rc=$rc)" "$out"

# DIVE-8022 (lodar 11:38Z «can we add avatars?»): the bot gets the agent's face.
# png <file>: width height colour-type, read from the PNG header.
pnghdr() { python3 -I -c 'import struct,sys; b=open(sys.argv[1],"rb").read(26); print(*struct.unpack(">IIxB", b[16:26])) if b[:8]==b"\x89PNG\r\n\x1a\n" else print("notpng")' "$1" 2>/dev/null; }
# A 300x200 RGB face whose rows use all five PNG filters, as real avatars do.
python3 -I - "$W/home/agent-max/.claude/avatar.png" <<'PY'
import struct, sys, zlib
w, h = 300, 200
rows = [bytes(((x * 7 + y) & 255, (y * 3) & 255, (x ^ y) & 255)[c] for x in range(w) for c in range(3)) for y in range(h)]
def enc(f, cur, prev):
    out = bytearray([f])
    for i, v in enumerate(cur):
        a = cur[i - 3] if i >= 3 else 0; b = prev[i]; c = prev[i - 3] if i >= 3 else 0
        p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        pr = (0, a, b, (a + b) >> 1, a if pa <= pb and pa <= pc else b if pb <= pc else c)[f]
        out.append((v - pr) & 255)
    return out
raw, prev = bytearray(), bytes(w * 3)
for y, r in enumerate(rows):
    raw += enc(y % 5, r, prev); prev = r
ch = lambda k, d: struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(bytes(raw))) + ch(b"IEND", b""))
PY
cp "$W/home/agent-max/.claude/avatar.png" "$W/face.png"
msreset; touch "$W/ms-in"; cp "$W/face.png" "$W/home/agent-max/.claude/avatar.png"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && grep -qE "app create .*--color-icon [^ ]+/color\.png --outline-icon [^ ]+/outline\.png" "$W/mslog" \
  && [[ "$(pnghdr "$W/got-color.png")" == "192 192 6" && "$(pnghdr "$W/got-outline.png")" == "32 32 6" ]] \
  && ok "an agent with a face: the bot is made with it (192x192) and a 32x32 outline with transparency" \
  || bad "face icons (rc=$rc)" "$(cat "$W/mslog"; pnghdr "$W/got-color.png"; pnghdr "$W/got-outline.png")"
[[ -z "$(find "$W/tmp" -name '*.png')" ]] && ok "the icon files are not left behind" || bad "icon leftovers" "$(find "$W/tmp")"
# Boxes have no Pillow: the standard-library reader must give the same picture.
python3 -I - "$ROOT/plugins/teams/cli" "$W/face.png" <<'PY' && ok "no Pillow: the face is read by the standard library, every PNG filter decoded exactly" || bad "stdlib face"
import sys; sys.modules["PIL"] = None; sys.path.insert(0, sys.argv[1]); import package
w, h, rows = package.png_pixels(open(sys.argv[2], "rb").read())
want = lambda x, y: ((x * 7 + y) & 255, (y * 3) & 255, (x ^ y) & 255, 255)
assert (w, h) == (300, 200) and all(rows[y][x] == want(x, y) for y in range(h) for x in range(w))
face = package.face_icon(sys.argv[2]); assert face and face[16:26] == bytes.fromhex("000000c0000000c00806")
PY
msreset; touch "$W/ms-in"; printf 'not a png' >"$W/home/agent-max/.claude/avatar.png"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && ! grep -q -- "-icon" "$W/mslog" && ok "an unreadable face: the bot is still made, with Teams' own tile" || bad "bad face (rc=$rc)" "$out"
msreset; touch "$W/ms-in"; ln -s "$W/face.png" "$W/home/agent-max/.claude/avatar.png"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 0 ]] && ! grep -q -- "-icon" "$W/mslog" && ok "a face that is a link elsewhere is not followed by root" || bad "symlink face (rc=$rc)" "$(cat "$W/mslog")"

msreset; rm -f "$W/prov.env"
out=$(JSON=1 run agent connect max --microsoft); rc=$?
[[ $rc -eq 3 && "$out" == *"no public name"* ]] && ! grep -q "unit=" "$W/mslog" && ok "no public name: refuses before any sign-in" || bad "no domain (rc=$rc)" "$out"
msreset
out=$(run agent connect max --microsoft --app-id=$APP); rc=$?
[[ $rc -eq 2 ]] && ok "--microsoft with --app-id is a usage error" || bad "flag mix (rc=$rc)" "$out"
msreset; touch "$W/local-only"
out=$(run agent connect max --microsoft); rc=$?
[[ $rc -eq 10 ]] && ok "--microsoft on an offline server is refused like connect" || bad "offline ms (rc=$rc)" "$out"

echo "teams CLI: $PASS pass, $FAIL fail"
(( FAIL == 0 ))
