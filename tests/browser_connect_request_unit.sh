#!/usr/bin/env bash
# DIVE-4992 — `5dive browser connect-request` and its privileged half `_connect`.
#
# The agent asks; the OWNER'S TAP is the authorisation; the box binds. The arms
# are the row's ACCEPT, each one a way the property could be lost:
#   tap -> bind -> URL      the owner's tap registers the bind and yields the link
#   no tap -> no bind       a request by itself never reaches the relay
#   forged / other-user     a made-up code, another person's tap, another seat's
#                           relay, a replay and an expired button are all refused,
#                           and a refused tap does NOT burn the owner's button
#   Done                    revoke -> stop -> probe, in that order
# The Telegram API and shelld are one loopback stub server; the browser verbs the
# relay seat would run are a fake that logs what it was asked. Run unprivileged:
# the test seams are honoured only without root (arm S1 grades that they are).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
TMP=$(mktemp -d)
SRV_PID=""
trap 'rc=$?; [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null; rm -rf "$TMP"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }

command -v jq >/dev/null && command -v python3 >/dev/null && command -v curl >/dev/null \
  || { echo "SKIP: needs jq, python3 and curl"; exit 1; }

# ---- the stub: Telegram Bot API + shelld's bind endpoint, one loopback server --
cat >"$TMP/stub.py" <<'PY'
import http.server, json, os, sys, urllib.parse
LOG = sys.argv[1]; CTL = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        body = self.rfile.read(n).decode()
        rec = {'path': self.path, 'auth': self.headers.get('authorization', ''), 'body': body}
        if self.path.startswith('/bot'):
            rec['form'] = {k: v[0] for k, v in urllib.parse.parse_qs(body).items()}
        with open(LOG, 'a') as f: f.write(json.dumps(rec) + '\n')
        status = 200
        if self.path == '/shell/browser-viewer-bind' and os.path.exists(CTL + '.bind500'): status = 500
        if self.path.startswith('/bot') and os.path.exists(CTL + '.tgfail'):
            out = {'ok': False}
        else:
            out = {'ok': True, 'result': {'message_id': 7}}
        b = json.dumps(out).encode()
        self.send_response(status); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
s = http.server.HTTPServer(('127.0.0.1', 0), H)
open(CTL + '.port', 'w').write(str(s.server_port))
s.serve_forever()
PY
python3 "$TMP/stub.py" "$TMP/stub.log" "$TMP/ctl" & SRV_PID=$!
for _ in $(seq 50); do [[ -s "$TMP/ctl.port" ]] && break; sleep 0.1; done
PORT=$(cat "$TMP/ctl.port")

# ---- the relay seat's browser verbs, faked -----------------------------------
cat >"$TMP/fake-browser" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_LOG"
case "$1" in
  serve)
    if [[ -f "$FAKE_CTL.noprofile" && ! -f "$FAKE_CTL.authed" ]]; then
      echo "browser: no profile for $2 — 5dive browser auth $2" >&2; exit 69
    fi ;;
  auth) : >"$FAKE_CTL.authed" ;;
  viewer)
    [[ -f "$FAKE_CTL.badpath" ]] && { echo "not-a-path"; echo "one-time, expires 2099-01-01T00:00:00Z, bound to session x." >&2; exit 0; }
    printf '/browser/viewer/%s/%s\n' "$2" "$(printf 'a%.0s' $(seq 64))"
    echo "one-time, expires 2099-01-01T00:00:00Z, bound to session ${3#--bind=}. Redeeming it consumes it." >&2 ;;
  status) echo "$2: authenticated"; ;;
esac
exit 0
SH
chmod +x "$TMP/fake-browser"

ME=$(id -un)
OWNER=111222333
mkdir -p "$TMP/home/.claude/channels/telegram" "$TMP/connectors" "$TMP/req"
printf '{"dmPolicy":"allowlist","allowFrom":["%s"],"groups":{}}\n' "$OWNER" >"$TMP/home/.claude/channels/telegram/access.json"
printf 'TELEGRAM_BOT_TOKEN=123:SECRETBOTTOKEN\n' >"$TMP/connectors/telegram-${ME#agent-}.env"
printf 'CONNECTORD_TOKEN=connectord-secret-token-0123456789\n' >"$TMP/connectord.env"
printf 'FIVE_DOMAIN=box.example.5dive.ai\n' >"$TMP/provisioning.env"

export FIVEDIVE_BROWSER_CONNECT_DIR="$TMP/req"
export FIVEDIVE_CONNECTOR_DIR="$TMP/connectors"
export FIVEDIVE_BROWSER_CONNECT_HOME="$TMP/home"
export FIVEDIVE_CONNECTORD_ENV="$TMP/connectord.env"
export FIVEDIVE_PROVISIONING_ENV="$TMP/provisioning.env"
export FIVEDIVE_SHELLD_URL="http://127.0.0.1:$PORT"
export FIVEDIVE_TELEGRAM_API="http://127.0.0.1:$PORT"
export FIVEDIVE_BROWSER_CONNECT_SELF="$TMP/fake-browser"
export FIVEDIVE_BROWSER_CONNECT_PRIV="$BROWSER"
export FAKE_LOG="$TMP/fake.log" FAKE_CTL="$TMP/ctl"

priv() { printf '%s\0' "$@" | "$BROWSER" _connect; }
reset() { : >"$TMP/stub.log"; : >"$FAKE_LOG"; rm -f "$TMP"/ctl.{noprofile,authed,bind500,tgfail,badpath}; }
binds() { grep -c '"/shell/browser-viewer-bind"' "$TMP/stub.log" 2>/dev/null || true; }
last_code() { jq -r 'select(.path|test("sendMessage")) | .form.reply_markup' "$TMP/stub.log" | tail -1 | jq -r '.inline_keyboard[0][0].callback_data' | sed 's/^bconn://'; }

# ---- R: the request -----------------------------------------------------------
reset
out=$("$BROWSER" connect-request booking.com --reason="to search hotels for you" 2>&1); rc=$?
t  "R1 connect-request exits 0" 0 "$rc"
tc "R1 it says nothing is bound until the tap" "Nothing is bound until they tap" "$out"
msg=$(jq -c 'select(.path|test("sendMessage"))' "$TMP/stub.log")
t  "R2 exactly one message, to the paired owner" "$OWNER" "$(jq -r '.form.chat_id' <<<"$msg")"
t  "R2 through the seat's own bot token" "/bot123:SECRETBOTTOKEN/sendMessage" "$(jq -r '.path' <<<"$msg")"
tc "R3 the message names the site and the reason" "log in to booking.com" "$(jq -r '.form.text' <<<"$msg")"
tc "R3 ... and the reason" "Why: to search hotels for you" "$(jq -r '.form.text' <<<"$msg")"
t  "R4 one button, labelled Connect <site>" "Connect booking.com" "$(jq -r '.form.reply_markup' <<<"$msg" | jq -r '.inline_keyboard[0][0].text')"
CODE=$(last_code)
[[ "$CODE" =~ ^[0-9a-f]{48}$ ]]; t "R5 the button carries a 48-hex code" 0 $?
t  "R5 callback_data fits Telegram's 64-byte cap" 1 "$(( ${#CODE} + 6 <= 64 ))"
tn "R6 the code is never printed to the asking seat" "$CODE" "$out"
t  "R7 only the code's hash is stored" "" "$(grep -rl "$CODE" "$TMP/req" 2>/dev/null)"
t  "R7 ... under its sha256" 1 "$(ls "$TMP/req" | grep -cx "$(printf '%s' "$CODE" | sha256sum | cut -d' ' -f1)")"
t  "R8 NO TAP -> NO BIND: the request alone never reaches the relay" 0 "$(binds)"
t  "R8 ... and starts no browser" "" "$(cat "$FAKE_LOG")"

# ---- F: forged and foreign taps -----------------------------------------------
out=$(priv tap "$(printf 'f%.0s' $(seq 48))" "$OWNER" 2>&1); rc=$?
t  "F1 a made-up code is refused" 77 "$rc"
tc "F1 ... as not live" "not live" "$out"
out=$(priv tap "$CODE" 999999 2>&1); rc=$?
t  "F2 another person's tap is refused" 77 "$rc"
tc "F2 ... as not the paired owner" "only this seat's paired owner" "$out"
out=$(priv tap "$CODE" "-100$OWNER" 2>&1); rc=$?
t  "F3 a group chat id is not an owner" 77 "$rc"
out=$(priv tap "${CODE:0:40}" "$OWNER" 2>&1); rc=$?
t  "F4 a truncated code is refused" 77 "$rc"
t  "F5 no refused tap bound anything" 0 "$(binds)"
t  "F5 ... or started a browser" "" "$(cat "$FAKE_LOG")"
# a relay through ANOTHER seat: the stored request names a seat that is not us
f="$TMP/req/$(printf '%s' "$CODE" | sha256sum | cut -d' ' -f1)"
cp "$f" "$TMP/saved"; sed -i "s/^seat=.*/seat=agent-someone-else/" "$f"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "F6 a tap relayed by a different seat is refused" 77 "$rc"
tc "F6 ... as another seat's button" "another seat's bot" "$out"
cp "$TMP/saved" "$f"

# ---- T: the owner's tap ---------------------------------------------------------
reset
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "T1 the owner's tap succeeds (refused taps did not burn it)" 0 "$rc"
t  "T2 serve then viewer, as the relay would" "serve booking.com|viewer" "$(head -2 "$FAKE_LOG" | cut -d' ' -f1,2 | tr '\n' '|' | sed 's/|$//' | sed 's/^serve booking.com|viewer.*/serve booking.com|viewer/')"
bindrec=$(jq -c 'select(.path=="/shell/browser-viewer-bind")' "$TMP/stub.log")
t  "T3 exactly one bind registered" 1 "$(binds)"
t  "T3 ... with the connectord token" "Bearer connectord-secret-token-0123456789" "$(jq -r '.auth' <<<"$bindrec")"
vbind=$(grep '^viewer' "$FAKE_LOG" | sed -n 's/.*--bind=\([^ ]*\).*/\1/p')
t  "T3 ... for the same bind the viewer was minted with" "$vbind" "$(jq -r '.body' <<<"$bindrec" | jq -r '.bind')"
t  "T3 ... and the ticket's own expiry" "$(date -u -d 2099-01-01T00:00:00Z +%s)" "$(jq -r '.body' <<<"$bindrec" | jq -r '.expiresAt')"
[[ "$vbind" =~ ^[0-9a-f]{32}$ ]]; t "T3 the bind is 128 random bits" 0 $?
tc "T4 the URL is the box host plus the viewer path" "url=https://box.example.5dive.ai/browser/viewer/booking.com/" "$out"
tn "T4 the bind never reaches the URL" "$vbind" "$(grep '^url=' <<<"$out")"
DONE=$(sed -n 's/^done=//p' <<<"$out")
[[ "$DONE" =~ ^[0-9a-f]{48}$ ]]; t "T5 a Done code comes back for the second button" 0 $?
tn "T6 the connectord token is never printed" "connectord-secret" "$out"
tn "T6 ... nor on the process table (it went on curl's stdin)" "connectord-secret" "$(grep -n 'Bearer \$token\|Bearer ${token}' "$BROWSER" | grep -v 'printf' || true)"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "T7 a second tap on the same button is refused" 77 "$rc"
t  "T7 ... and binds nothing more" 1 "$(binds)"

# ---- D: Done --------------------------------------------------------------------
reset
out=$(priv done "$DONE" 999999 2>&1); rc=$?
t  "D1 another person cannot press Done" 77 "$rc"
out=$(priv done "$CODE" "$OWNER" 2>&1); rc=$?
t  "D2 a Connect code is not a Done code" 77 "$rc"
out=$(priv done "$DONE" "$OWNER" 2>&1); rc=$?
t  "D3 the owner's Done succeeds" 0 "$rc"
t  "D4 revoke -> stop -> probe, in that order" "viewer-revoke booking.com|serve booking.com --stop|status booking.com" "$(tr '\n' '|' <"$FAKE_LOG" | sed 's/|$//')"
tc "D5 the verdict comes back" "status=booking.com: authenticated" "$out"
out=$(priv done "$DONE" "$OWNER" 2>&1); rc=$?
t  "D6 Done is one-shot too" 77 "$rc"

# ---- E: failure paths never hand over a link --------------------------------------
reset
"$BROWSER" connect-request booking.com >/dev/null 2>&1; CODE=$(last_code)
: >"$TMP/stub.log"; : >"$TMP/ctl.bind500"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "E1 relay refuses the bind -> the tap fails" 69 "$rc"
tn "E1 ... and no URL is printed" "url=" "$out"
tc "E1 ... and the ticket is revoked" "viewer-revoke booking.com" "$(cat "$FAKE_LOG")"
reset
"$BROWSER" connect-request booking.com >/dev/null 2>&1; CODE=$(last_code); : >"$TMP/ctl.badpath"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "E2 an unusable viewer path is refused" 69 "$rc"
t  "E2 ... before any bind" 0 "$(binds)"
reset
"$BROWSER" connect-request booking.com >/dev/null 2>&1; CODE=$(last_code); : >"$TMP/ctl.noprofile"; : >"$FAKE_LOG"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "E3 a site with no profile is auth'd, then served" "serve|auth|serve|viewer" "$(cut -d' ' -f1 <"$FAKE_LOG" | tr '\n' '|' | sed 's/|$//')"
t  "E3 ... and the tap still succeeds" 0 "$rc"
reset
"$BROWSER" connect-request booking.com >/dev/null 2>&1; CODE=$(last_code)
f="$TMP/req/$(printf '%s' "$CODE" | sha256sum | cut -d' ' -f1)"; sed -i 's/^expires_at=.*/expires_at=1/' "$f"
out=$(priv tap "$CODE" "$OWNER" 2>&1); rc=$?
t  "E4 an expired button is refused" 77 "$rc"
t  "E4 ... and binds nothing" 0 "$(binds)"

# ---- Q: who can be asked -----------------------------------------------------------
reset; rm -rf "$TMP/req"/*; : >"$TMP/ctl.tgfail"
out=$("$BROWSER" connect-request booking.com 2>&1); rc=$?
t  "Q1 Telegram refusing the message is a failure, not a silent success" 69 "$rc"
t  "Q1 ... and leaves no live request behind" 0 "$(ls "$TMP/req" | wc -l | tr -d ' ')"
reset; rm -rf "$TMP/req"/*
mv "$TMP/home/.claude" "$TMP/home/.codex"
out=$("$BROWSER" connect-request booking.com 2>&1); rc=$?
t  "Q2 a bridge without the tap handler is refused up front" 69 "$rc"
tc "Q2 ... pointing at the dashboard" "Connected sites" "$out"
t  "Q2 ... and sends no dead button" 0 "$(grep -c sendMessage "$TMP/stub.log")"
mv "$TMP/home/.codex" "$TMP/home/.claude"
printf '{"allowFrom":[]}\n' >"$TMP/home/.claude/channels/telegram/access.json"
out=$("$BROWSER" connect-request booking.com 2>&1); rc=$?
t  "Q3 no paired owner -> refused" 69 "$rc"
printf '{"dmPolicy":"allowlist","allowFrom":["%s"],"groups":{}}\n' "$OWNER" >"$TMP/home/.claude/channels/telegram/access.json"
out=$("$BROWSER" connect-request _public 2>&1); rc=$?
t  "Q4 the public profile is not something to log in to" 64 "$rc"
out=$("$BROWSER" connect-request '../etc' 2>&1); rc=$?
t  "Q4 a traversing site name is refused" 64 "$rc"
out=$("$BROWSER" connect-request booking.com --reason="$(printf 'a\nb\033[31m%.0s' $(seq 100))" 2>&1)
txt=$(jq -r 'select(.path|test("sendMessage")) | .form.text' "$TMP/stub.log" | tail -1)
tn "Q5 control characters are stripped from the reason" $'\033' "$txt"
t  "Q5 the reason is capped" 1 "$(( $(sed -n 's/^Why: //p' <<<"$txt" | wc -c) <= 201 ))"

# ---- S: the seams are not a door under root -------------------------------------------
seam_block=$(awk '/^if \[\[ \$EUID -ne 0 \]\]; then$/{p=1} p{print} p&&/^fi$/{exit}' "$BROWSER")
for v in FIVEDIVE_BROWSER_CONNECT_DIR FIVEDIVE_CONNECTOR_DIR FIVEDIVE_CONNECTORD_ENV FIVEDIVE_PROVISIONING_ENV FIVEDIVE_SHELLD_URL FIVEDIVE_TELEGRAM_API FIVEDIVE_BROWSER_CONNECT_SELF FIVEDIVE_BROWSER_CONNECT_PRIV; do
  t "S1 $v is read only inside the non-root block" "$(grep -c "$v" "$BROWSER")" "$(grep -c "$v" <<<"$seam_block")"
done
t  "S2 _connect stays root under sudo (not dropped to the seat)" 1 "$(grep -c 'setup|adblock|approve|approvals|adapters|_connect|' "$BROWSER")"
tc "S3 the bot token rides curl's stdin, not argv" "| curl -sS --connect-timeout 5 --max-time 15 --config -" "$(grep -A1 'printf .url = ' "$BROWSER")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
