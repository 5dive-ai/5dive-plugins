#!/usr/bin/env bash
# phone plugin harness (DIVE-9064): `5dive phone` against a fake adb.
# What it pins: the screen reads as refs, a Send/Pay/Delete tap is checked against
# the owner's policy BEFORE any step runs, a grant is bound to the exact steps and
# spent once, the policy file counts only when the granting uid owns it, and a
# phone that stopped answering says what to ask the owner.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHONE="$ROOT/plugins/phone/bin/phone"
UI="$ROOT/plugins/phone/lib/ui.py"
FIX="$ROOT/tests/fixtures/phone"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0 fail=0
ok()  { pass=$((pass+1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf 'FAIL %s\n' "$1"; [[ -n "${2:-}" ]] && printf '     %s\n' "$2" | head -20; return 0; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

export FIVEDIVE_PHONE_ADB="$FIX/fake-adb" FAKE_ADB_UI="$FIX/chat.xml" FAKE_ADB_LOG="$T/input.log" FAKE_ADB_CALLS="$T/calls.log"
export FIVEDIVE_PHONE_HOME="$T/home" FIVEDIVE_PHONE_APPROVAL_DIR="$T/approvals" FIVEDIVE_PHONE_APPROVAL_POLICY="$T/policy.json"
export FIVEDIVE_PHONE_GRANT_UID="$(id -u)" FIVEDIVE_PHONE_STEP_GAP=0 FIVEDIVE_PHONE_OPEN_WAIT=0
# No `5dive` on PATH: the owner-ask relay is not reachable here, so the fallback text shows.
mkdir -p "$T/bin"; for b in bash jq python3 sha256sum timeout stat head od tr cut sed grep awk sort tail cat mkdir chmod mv rm date sleep seq id getent mktemp basename dirname printf env ls wc; do
  p="$(command -v "$b")" && ln -sf "$p" "$T/bin/$b"; done
export PATH="$T/bin"
policy() { printf '%s\n' "$1" > "$T/policy.json"; }
reset_log() { : > "$T/input.log"; }

# ---- classification ----
for c in "send:Send" "send:com.app:id/btn_send" "send:sendButton" "send:Отправить" "pay:Buy now" "pay:Place order" \
         "delete:Delete chat" "publish:Post" ":Posts" ":Reply" ":Share" ":Allow" \
         "pay:Send money" "pay:Send payment" "pay:Send \$50" "pay:Send 12,50 €" "pay:Request money" "pay:Withdraw" \
         "send:Send message"; do
  want="${c%%:*}" label="${c#*:}"
  got="$(python3 "$UI" classify "$label")"
  check "classify \"$label\" -> ${want:-nothing}" [ "$got" == "$want" ]
done

# ---- connect ----
out="$("$PHONE" connect 192.0.2.7:41235 --pair=192.0.2.7:37011 --code=123456 2>&1)"; rc=$?
check "connect pairs, then pins the fixed port 5555" [ $rc -eq 0 -a "$(cat "$T/home/device")" == "192.0.2.7:5555" ]
check "connect names the phone" grep -q 'connected: Pixel Test, Android 14' <<<"$out"
out="$("$PHONE" connect 192.0.2.7:41235 --pair=192.0.2.7:37011 --code=999999 2>&1)"; rc=$?
check "a wrong pairing code fails and asks for fresh ones" bash -c '[ "$1" -ne 0 ] && grep -q fresh <<<"$2"' _ "$rc" "$out"
out="$(FAKE_ADB_STATE=offline "$PHONE" snapshot 2>&1)"; rc=$?
check "a phone that stopped answering exits 69" [ $rc -eq 69 ]
check "  and says what to ask the owner (Wireless debugging, new port)" grep -q 'Wireless debugging' <<<"$out"
out="$(FAKE_ADB_STATE=unauthorized "$PHONE" snapshot 2>&1)"; rc=$?
check "an unallowed server asks the owner to tap Allow" grep -q 'tap Allow' <<<"$out"

# ---- snapshot ----
snap="$("$PHONE" snapshot)"
check "snapshot names the app" grep -q '^app: com.example.chat' <<<"$snap"
check "the Send button is a ref flagged send" grep -qE '^\[e[0-9]+\] button "Send"  ⚠ send$' <<<"$snap"
check "an unlabelled button reads its id: delete chat, flagged delete" grep -qE 'button "delete chat"  ⚠ delete' <<<"$snap"
check "the text box shows its name and what is in it" grep -qE 'textbox "entry" = "Message"' <<<"$snap"
check "a row borrowing \"send you notifications\" is NOT flagged" bash -c '! grep -E "notifications.*⚠" <<<"$1"' _ "$snap"
check "a Posts tab is not a post" bash -c '! grep -E "Posts.*⚠" <<<"$1"' _ "$snap"
send_full="$(grep -oE '^\[e[0-9]+\] button "Send"' <<<"$snap" | grep -oE 'e[0-9]+')"
snap_i="$("$PHONE" snapshot --interactive)"
send_i="$(grep -oE '^\[e[0-9]+\] button "Send"' <<<"$snap_i" | grep -oE 'e[0-9]+')"
check "--interactive hides text but keeps the same refs" [ -n "$send_full" -a "$send_full" == "$send_i" ]
check "--interactive hides plain text" bash -c '! grep -q "free for lunch" <<<"$1"' _ "$snap_i"
entry="$(grep -oE '^\[e[0-9]+\] textbox' <<<"$snap" | grep -oE 'e[0-9]+')"

STEPS="[{\"op\":\"type\",\"ref\":\"$entry\",\"text\":\"hello Ada\"},{\"op\":\"tap\",\"ref\":\"$send_full\"}]"

# ---- standard: send runs and is logged ----
rm -f "$T/policy.json"; reset_log
out="$("$PHONE" act --steps="$STEPS" 2>&1)"; rc=$?
check "standard: a send runs (exit 0)" [ $rc -eq 0 ]
check "  types with %s for spaces" grep -q "input text 'hello%sAda'" "$T/input.log"
check "  taps the Send button's centre" grep -q 'input tap 990 2160' "$T/input.log"
check "  says it was allowed by the default" grep -q 'ALLOWED (default standard): send' <<<"$out"
check "  logs the tap with kind send" bash -c 'tail -1 "$1" | jq -e ".op == \"tap\" and .kind == \"send\" and .allowed_by == \"default standard\"" >/dev/null' _ "$T/home/actions.jsonl"
check "  the log is private (0600)" [ "$(stat -c %a "$T/home/actions.jsonl")" == 600 ]

# ---- careful: send stops before ANY step ----
policy '{"pay":"ask","publish":"ask","send":"ask","delete":"ask"}'; reset_log
out="$("$PHONE" act --steps="$STEPS" 2>&1)"; rc=$?
check "careful: a send stops with exit 73" [ $rc -eq 73 ]
check "  nothing was typed or tapped (the stop comes first)" [ ! -s "$T/input.log" ]
req="$(ls "$T/approvals"/*.json 2>/dev/null | head -1)"
check "  the ask is written in the browser's format" bash -c 'jq -e ".class == \"send\" and .label == \"Send\" and .payload.text == \"hello Ada\" and (.hash | length) == 64 and .source == \"phone\"" "$1" >/dev/null' _ "$req"
check "  the ask names the approve command" grep -q 'sudo 5dive browser approve' <<<"$out"
check "  with no relay it says how to put it on the row" grep -q -- '--browser-ask=' <<<"$out"
id="$(basename "$req" .json)"
check "  the ask id is <seat>-<12 hex>" bash -c '[[ "$1" =~ ^[a-z0-9._-]+-[0-9a-f]{12}$ ]]' _ "$id"

grant() { jq -n --arg id "$1" --arg h "$2" --argjson exp "$3" '{id:$id, hash:$h, expires_at:$exp, approved_by:"owner"}' > "$T/approvals/$1.granted"; }
h="$(jq -r .hash "$req")"
grant "$id" "$h" $(( $(date +%s) - 5 ))
out="$("$PHONE" act --steps="$STEPS" --approved="$id" 2>&1)"; rc=$?
check "an expired grant is refused (73)" bash -c '[ "$1" -eq 73 ] && grep -q expired <<<"$2"' _ "$rc" "$out"
grant "$id" "$h" $(( $(date +%s) + 600 ))
out="$("$PHONE" act --steps="[{\"op\":\"tap\",\"ref\":\"$send_full\"}]" --approved="$id" 2>&1)"; rc=$?
check "a grant for other steps is refused (73)" bash -c '[ "$1" -eq 73 ] && grep -q "different steps" <<<"$2"' _ "$rc" "$out"
reset_log
out="$("$PHONE" act --steps="$STEPS" --approved="$id" 2>&1)"; rc=$?
check "the exact approved steps run, Send tapped" bash -c '[ "$1" -eq 0 ] && grep -q "input tap 990 2160" "$2"' _ "$rc" "$T/input.log"
check "  the grant is spent" [ ! -e "$T/approvals/$id.granted" ]
check "  the log says who allowed it" bash -c 'tail -1 "$1" | jq -e ".allowed_by == \"approved $2\"" >/dev/null' _ "$T/home/actions.jsonl" "$id"
out="$("$PHONE" act --steps="$STEPS" --approved="$id" 2>&1)"; rc=$?
check "  and cannot be used twice (73)" [ $rc -eq 73 ]

# ---- by name, by position, by label ----
reset_log
out="$("$PHONE" act --steps='[{"op":"tap","ref":"button/Send"}]' 2>&1)"; rc=$?
check "careful: a name ref button/Send stops too" bash -c '[ "$1" -eq 73 ] && [ ! -s "$2" ]' _ "$rc" "$T/input.log"
reset_log
out="$("$PHONE" act --steps='[{"op":"key","key":"back"},{"op":"tap","x":990,"y":2160}]' 2>&1)"; rc=$?
check "careful: a tap by position on Send stops at run time, no tap sent" bash -c '[ "$1" -eq 73 ] && ! grep -q "input tap" "$2"' _ "$rc" "$T/input.log"
reset_log
out="$("$PHONE" act --steps='[{"op":"key","key":"enter","kind":"send"}]' 2>&1)"; rc=$?
check "careful: a step the agent labels send stops" bash -c '[ "$1" -eq 73 ] && [ ! -s "$2" ]' _ "$rc" "$T/input.log"
reset_log
out="$("$PHONE" act --steps="[{\"op\":\"type\",\"ref\":\"$entry\",\"text\":\"draft only\"}]" 2>&1)"; rc=$?
check "careful: typing alone does not stop" bash -c '[ "$1" -eq 0 ] && grep -q "draft%sonly" "$2"' _ "$rc" "$T/input.log"
out="$("$PHONE" act --steps='[{"op":"tap","ref":"button/Nowhere"}]' 2>&1)"; rc=$?
check "a name ref that is not on screen says so" bash -c '[ "$1" -eq 2 ] && grep -q "no button \"Nowhere\"" <<<"$2"' _ "$rc" "$out"

# ---- the policy file counts only when the granting uid owns it ----
policy '{"pay":"ask","publish":"ask","send":"ask","delete":"ask"}'
check "careful reads as careful" [ "$("$PHONE" approvals policy --json | jq -r .mode)" == careful ]
if [[ "$(id -u)" != 0 ]]; then
  out="$(FIVEDIVE_PHONE_GRANT_UID=0 "$PHONE" approvals policy --json)"
  check "a policy file the granting uid does not own is ignored (standard)" [ "$(jq -r .mode <<<"$out")" == standard ]
fi
: > "$T/policy.json"
check "an empty policy file is the default, not an error" [ "$("$PHONE" approvals policy --json | jq -r .mode)" == standard ]

# ---- standard: a money button is a payment and asks; a plain Send still runs ----
rm -f "$T/policy.json"
for b in "Send money" "Send payment"; do
  reset_log
  out="$(FAKE_ADB_UI="$FIX/wallet.xml" "$PHONE" act --steps="[{\"op\":\"type\",\"text\":\"50\"},{\"op\":\"tap\",\"ref\":\"button/$b\"}]" 2>&1)"; rc=$?
  check "standard: button/$b stops with exit 73, nothing typed" bash -c '[ "$1" -eq 73 ] && [ ! -s "$2" ]' _ "$rc" "$T/input.log"
done
wsnap="$(FAKE_ADB_UI="$FIX/wallet.xml" "$PHONE" snapshot)"
check "the wallet's Send money button is flagged pay" grep -qE '^\[e[0-9]+\] button "Send money"  ⚠ pay$' <<<"$wsnap"
check "  and its plain Send button is flagged send" grep -qE '^\[e[0-9]+\] button "Send"  ⚠ send$' <<<"$wsnap"
wref="$(grep -oE '^\[e[0-9]+\] button "Send money"' <<<"$wsnap" | grep -oE 'e[0-9]+')"
reset_log
out="$(FAKE_ADB_UI="$FIX/wallet.xml" "$PHONE" act --steps="[{\"op\":\"tap\",\"ref\":\"$wref\"}]" 2>&1)"; rc=$?
check "standard: a snapshot ref on Send money stops too (73), no tap" bash -c '[ "$1" -eq 73 ] && [ ! -s "$2" ]' _ "$rc" "$T/input.log"
reset_log
out="$(FAKE_ADB_UI="$FIX/wallet.xml" "$PHONE" act --steps='[{"op":"tap","x":280,"y":460}]' 2>&1)"; rc=$?
check "standard: a tap by position on Send money stops at run time, no tap" bash -c '[ "$1" -eq 73 ] && ! grep -q "input tap" "$2"' _ "$rc" "$T/input.log"
reset_log
out="$("$PHONE" act --steps='[{"op":"tap","ref":"button/Send"}]' 2>&1)"; rc=$?
check "standard: plain button/Send still runs (exit 0, tapped)" bash -c '[ "$1" -eq 0 ] && grep -q "input tap 990 2160" "$2"' _ "$rc" "$T/input.log"

# ---- refusals and the rest ----
out="$("$PHONE" act --steps='[{"op":"type","text":"héllo"}]' 2>&1)"; rc=$?
check "non-ASCII text is refused with exit 2" [ $rc -eq 2 ]
out="$("$PHONE" act --steps='[{"op":"type","text":"a\nb"}]' 2>&1)"; rc=$?
check "a line break in text is refused (Enter is its own step)" [ $rc -eq 2 ]
out="$("$PHONE" act --steps='[{"op":"fly"}]' 2>&1)"; rc=$?
check "an unknown op is refused" [ $rc -eq 2 ]
reset_log
out="$("$PHONE" act --steps='[{"op":"open","app":"com.example.chat"}]' 2>&1)"; rc=$?
check "open app starts its launcher activity" bash -c '[ "$1" -eq 0 ] && grep -q "am start -n com.example.chat/.Main" "$2"' _ "$rc" "$T/input.log"
out="$("$PHONE" act --steps='[{"op":"open","app":"com.nope"}]' 2>&1)"; rc=$?
check "open of an app that is not there fails clearly" bash -c '[ "$1" -ne 0 ] && grep -q "not installed" <<<"$2"' _ "$rc" "$out"
out="$("$PHONE" act --steps='[{"op":"wait","ms":1}]' --expect='free for lunch' 2>&1)"; rc=$?
check "--expect passes on text the screen shows" [ $rc -eq 0 ]
out="$("$PHONE" act --steps='[{"op":"wait","ms":1}]' --expect='never here' 2>&1)"; rc=$?
check "--expect fails on text it does not" [ $rc -eq 1 ]
check "the screenshot is a PNG kept private" bash -c 'f="$("$1" screenshot)" && [ "$(head -c 4 "$f" | od -An -tx1 | tr -d " ")" == 89504e47 ] && [ "$(stat -c %a "$f")" == 600 ]' _ "$PHONE"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
