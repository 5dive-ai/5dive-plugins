#!/usr/bin/env bash
# DIVE-4997 — reflex drafts a site's login check, the owner approves it.
#
#   5dive browser propose <site>            capture + `5dive reflex login-marker`, stored PENDING
#   sudo 5dive browser adapters pending     the pick AND every candidate, with counts
#   sudo 5dive browser adapters approve     re-counted on the stored renders, written to .adapters/
#   sudo 5dive browser adapters reject
#   5dive browser adapters drift            re-measure every adapter, flag one that decayed
#
# The row's ACCEPT, one block each:
#   A  no adapter + configured reflex -> a pending proposal, nothing in .adapters/
#   B  approve -> an .adapters/ file with the chosen marker, which the probe then uses
#   C  no signed-in render -> approve refused
#   D  a challenge render -> refusal (either half, at propose and at approve)
# plus drift (the row's step 4), the owner rules, and two mutants that prove the
# refusal arms can go red. Chrome is a fake that serves a parked DOM per profile;
# reflex is a fake CLI whose candidates really do match the fixtures, so every
# count approve re-takes is a real grep. Arm R runs the REAL 5dive CLI's
# login-marker (heuristic backend, no model call) when one is installed.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
PKG_ADAPTERS="$ROOT/plugins/browser/adapters"
TMP=$(mktemp -d)
trap 'rc=$?; rm -rf "$TMP"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
run() { local o="$TMP/.o" e="$TMP/.e"; "$@" >"$o" 2>"$e"; RC=$?; OUT=$(cat "$o"); ERR=$(cat "$e"); return 0; }

command -v jq >/dev/null || { echo "SKIP: needs jq"; exit 1; }

SEAT="$(id -un)"; ME_UID="$(id -u)"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
unset FIVEDIVE_BROWSER_ADAPTER_DIR            # the real search path: <seat>/.adapters, then the package
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_PROPOSE_DELAY_S=0
export FIVEDIVE_BROWSER_GRANT_UID="$ME_UID"   # the harness has one uid and no root
SEATDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
PEND="$SEATDIR/.adapters-pending"
ADS="$SEATDIR/.adapters"
mkdir -p "$SEATDIR"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT" "$SEATDIR"
PKG_BEFORE=$(ls "$PKG_ADAPTERS" | sort | tr '\n' ' ')

# --- fake chrome: the profile's parked DOM, or FAKE_COLD_DOM for a throwaway ---
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --version) echo "Chromium 140.0 fake"; exit 0 ;; --user-data-dir=*) d="${a#*=}" ;; esac; done
if [[ -n "${d:-}" && -d "$d" ]]; then n=$(cat "$d/.fake-n" 2>/dev/null || echo 0); echo $((n+1)) > "$d/.fake-n"; fi
cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null || cat "${FAKE_COLD_DOM:-/nonexistent}" 2>/dev/null || echo "<html><body>feed</body></html>"
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

# --- fake reflex: status, and login-marker candidates that match the fixtures --
cat > "$TMP/fake-5dive" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_RFX_LOG"
[[ "$1" == reflex ]] || exit 64
case "$2" in
  status) if [[ -f "$FAKE_RFX_CTL.off" ]]; then echo '{"configured":false,"key":"unset"}'; else echo '{"configured":true,"key":"set","model":"fake/model"}'; fi ;;
  login-marker)
    spa=0; for a in "$@"; do [[ "$a" == --spa ]] && spa=1; done
    [[ -f "$FAKE_RFX_CTL.fail" ]] && { echo "error: the signed-out render is a challenge page (captcha or verification), not a sign-in page. Nothing was proposed." >&2; exit 65; }
    out='[{"key":"m1","marker":"action=[\"'"'"']?/session","score":15,"out":1,"in":0},{"key":"m2","marker":"name=[\"'"'"']?login","score":14,"out":1,"in":0}]'
    [[ -f "$FAKE_RFX_CTL.nocand" || -f "$FAKE_RFX_CTL.spa" ]] && out='[]'
    ins='[{"key":"m1","marker":"id=[\"'"'"']?account-menu","score":2,"out":0,"in":1}]'
    [[ -f "$FAKE_RFX_CTL.nocand" ]] && ins='[]'
    pick=m1; [[ "$out" == '[]' ]] && pick=none
    ipick=m1; [[ "$ins" == '[]' ]] && ipick=none
    jq -nc --argjson o "$out" --argjson i "$ins" --arg p "$pick" --arg ip "$ipick" --argjson spa "$spa" '
      {site:"x", mode:"shadow", written:false, backend:"fake", model:"fake/model", signed_in_render:true, signed_out_renders:2,
       logged_out:{candidates:$o, choice:$p, confidence:(if $p == "none" then null else 0.42 end), error:(if ($o|length) == 0 then "no_candidates" else null end)},
       logged_in:(if $spa == 1 then {candidates:$i, choice:$ip, confidence:0.2, error:null} else null end)}' ;;
  *) exit 64 ;;
esac
SH
chmod +x "$TMP/fake-5dive"
export FIVEDIVE_BROWSER_CLI="$TMP/fake-5dive" FAKE_RFX_LOG="$TMP/rfx.log" FAKE_RFX_CTL="$TMP/rfx"

SIGNED_IN='<html><head><title>Inbox</title></head><body><nav id="account-menu">me</nav><div id="feed">posts</div></body></html>'
SIGNED_OUT='<html><head><title>Sign in</title></head><body><form action="/session"><input name="login"><input type="password"></form></body></html>'
CHALLENGE='<html><head><title>Sign in</title></head><body><form action="/session"></form><div class="g-recaptcha"></div></body></html>'
export FAKE_COLD_DOM="$TMP/cold.html"; printf '%s' "$SIGNED_OUT" > "$FAKE_COLD_DOM"

mkprofile() {  # <site> <dom>
  local d="$SEATDIR/$1"; mkdir -p "$d"; chmod 700 "$d"; printf '%s' "$2" > "$d/.fake-dom"; echo "$d"
}
reset_site() { rm -rf "$PEND" "$ADS" "$SEATDIR/$1" "$TMP"/rfx.*; : > "$FAKE_RFX_LOG"; }

# ============================================================ A  propose -> pending
S=newsite.test
mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S" --url=https://newsite.test/home
t  'A1 propose exits 0' 0 "$RC"
t  'A1 a proposal is PENDING in the seat'"'"'s .adapters-pending/' yes "$(yn test -f "$PEND/$S.json")"
t  'A1 ...and nothing was written to .adapters/' no "$(yn test -e "$ADS/$S.json")"
t  'A1 ...nor to the plugin'"'"'s own adapters/' "$PKG_BEFORE" "$(ls "$PKG_ADAPTERS" | sort | tr '\n' ' ')"
t  'A1 the pending directory is 0700' 700 "$(stat -c %a "$PEND" 2>/dev/null)"
t  'A1 the proposal is 0600' 600 "$(stat -c %a "$PEND/$S.json" 2>/dev/null)"
t  'A1 its renders are kept for approve to re-count' yes "$(yn test -s "$PEND/$S.renders/signed-in.html")"
t  'A1 the proposal carries the signed-in render fact' true "$(jq -r .signed_in_render "$PEND/$S.json" 2>/dev/null)"
tc 'A1 reflex was handed both signed-out renders and the signed-in one' "--logged-out=$PEND/$S.renders/signed-out.html --logged-out=$PEND/$S.renders/signed-out-2.html --logged-in=$PEND/$S.renders/signed-in.html" "$(cat "$FAKE_RFX_LOG")"
tn 'A1 no --spa when the signed-out half has candidates' '--spa' "$(cat "$FAKE_RFX_LOG")"
tc 'A2 the owner sees the pick' 'reflex picked m1 at confidence 0.42' "$OUT"
tc 'A2 ...and EVERY candidate with its counts (m2 too)' 'm2' "$OUT"
tc 'A2 ...with both halves counted' '(signed out 1, signed in 0)' "$OUT"
tc 'A2 ...and how to approve it' 'sudo 5dive browser adapters approve newsite.test' "$OUT"
run "$BROWSER" adapters pending --json
t  'A3 adapters pending --json lists it' "$S" "$(jq -r '.[0].site' <<<"$OUT" 2>/dev/null)"
t  'A3 ...with the full candidate list' 2 "$(jq -r '.[0].reflex.logged_out.candidates | length' <<<"$OUT" 2>/dev/null)"
run "$BROWSER" propose "$S"
t  'A4 a second propose while one is pending is refused' 64 "$RC"
run "$BROWSER" status "$S"
tc 'A5 the status line tells whoever reads it a check is waiting' 'waiting for the owner' "$OUT"
tc 'A5 ...and it is still UNKNOWN until the owner approves' 'UNKNOWN (no adapter' "$OUT"

# A6 the PROBE starts one on its own, in the background, for a login with no adapter
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
FIVEDIVE_BROWSER_AUTO_PROPOSE=1 run "$BROWSER" status "$S"
t  'A6 status still answers at once (rc 0, UNKNOWN)' 0 "$RC"
for _ in $(seq 100); do [[ -f "$PEND/$S.json" ]] && break; sleep 0.1; done
t  'A6 ...and a proposal lands PENDING without anyone typing propose' yes "$(yn test -f "$PEND/$S.json")"
t  'A6 ...and still nothing in .adapters/' no "$(yn test -e "$ADS/$S.json")"
: > "$FAKE_RFX_LOG"; rm -f "$PEND/$S.json"
FIVEDIVE_BROWSER_AUTO_PROPOSE=1 run "$BROWSER" status "$S"; sleep 1
t  'A6 a site attempted recently is not proposed again (the retry window)' '' "$(grep login-marker "$FAKE_RFX_LOG")"

# A6b under probe-all (the systemd timer) it is drafted INLINE: a background child
# would die with the oneshot unit's cgroup the moment the probe exits.
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
FIVEDIVE_BROWSER_AUTO_PROPOSE=1 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0 run "$BROWSER" probe-all
t  'A6b probe-all returns with the proposal ALREADY pending (no wait)' yes "$(yn test -f "$PEND/$S.json")"
tc 'A6b ...and says so' 'waiting for the owner: sudo 5dive browser adapters pending' "$OUT"
t  'A6b ...and still nothing in .adapters/' no "$(yn test -e "$ADS/$S.json")"
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null; : > "$TMP/rfx.off"
FIVEDIVE_BROWSER_AUTO_PROPOSE=1 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0 run "$BROWSER" probe-all
tc 'A6b a refusal under probe-all is printed, not silent' 'no login check proposed: reflex is not configured' "$OUT"
t  'A6b ...and is not a red timer' 0 "$RC"
rm -f "$TMP/rfx.off"

# A7 reflex not configured: nothing to ask, nothing stored
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null; : > "$TMP/rfx.off"
run "$BROWSER" propose "$S"
t  'A7 configured:false is refused (69)' 69 "$RC"
tc 'A7 ...and it names where the owner turns reflex on' 'Company → Settings → Reflex' "$ERR"
t  'A7 ...and nothing is pending' no "$(yn test -e "$PEND/$S.json")"
t  'A7 ...and login-marker was never asked' '' "$(grep login-marker "$FAKE_RFX_LOG")"
rm -f "$TMP/rfx.off"

# A8 a site WITH an adapter is not proposed for (drift is its check)
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
mkdir -p "$ADS"; chmod 700 "$ADS"; printf '{"site":"%s","probe":{"url":"https://%s/","logged_out_when_dom_matches":"action=\\"/session"}}' "$S" "$S" > "$ADS/$S.json"
run "$BROWSER" propose "$S"
t  'A8 a site that already has an adapter is refused' 64 "$RC"
tc 'A8 ...and pointed at drift' 'adapters drift' "$ERR"

# A9 no candidate on either half is a refusal, not an empty proposal
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null; : > "$TMP/rfx.nocand"
run "$BROWSER" propose "$S"
t  'A9 no candidates -> refused (69)' 69 "$RC"
t  'A9 ...nothing pending' no "$(yn test -e "$PEND/$S.json")"
t  'A9 ...and the renders are gone' no "$(yn test -e "$PEND/$S.renders")"
t  'A9 --spa was tried before giving up (the signed-out half was empty)' 2 "$(grep -c login-marker "$FAKE_RFX_LOG")"
rm -f "$TMP/rfx.nocand"

# A10 a profile that is not logged in has no signed-in half
reset_site "$S"; mkprofile "$S" "$SIGNED_OUT" >/dev/null
run "$BROWSER" propose "$S"
t  'A10 identical renders (not logged in) -> refused (75)' 75 "$RC"
t  'A10 ...reflex never asked' '' "$(grep login-marker "$FAKE_RFX_LOG")"

# A11 a brokered seat cannot propose: it would capture the owner's signed-in page
tc 'A11 propose opens its site with --no-broker' '_open_site "$site" --no-broker propose' "$(cat "$BROWSER")"

# ============================================================ B  approve -> .adapters/ -> probe
reset_site "$S"; SD=$(mkprofile "$S" "$SIGNED_IN")
run "$BROWSER" propose "$S" --url=https://newsite.test/home
run "$BROWSER" adapters approve "$S"
t  'B1 approve exits 0' 0 "$RC"
t  'B1 the adapter is in the seat'"'"'s .adapters/' yes "$(yn test -f "$ADS/$S.json")"
t  'B1 ...with reflex'"'"'s pick as the signed-out marker' "action=[\"']?/session" "$(jq -r .probe.logged_out_when_dom_matches "$ADS/$S.json" 2>/dev/null)"
t  'B1 ...and the probe URL the renders were of' https://newsite.test/home "$(jq -r .probe.url "$ADS/$S.json" 2>/dev/null)"
tc 'B1 the _comment says reflex proposed it' 'PROPOSED BY REFLEX' "$(jq -r ._comment "$ADS/$S.json" 2>/dev/null)"
tc 'B1 ...who approved it' "APPROVED by $SEAT" "$(jq -r ._comment "$ADS/$S.json" 2>/dev/null)"
tc 'B1 ...and the counts on each half' '1 and 1 matches signed out, 0 signed in' "$(jq -r ._comment "$ADS/$S.json" 2>/dev/null)"
t  'B1 ...and when' yes "$(yn jq -e '._reflex.approved_at | test("^20[0-9-]+T")' "$ADS/$S.json")"
t  'B1 the package adapters/ is untouched' "$PKG_BEFORE" "$(ls "$PKG_ADAPTERS" | sort | tr '\n' ' ')"
t  'B1 the proposal is gone' no "$(yn test -e "$PEND/$S.json")"
t  'B1 ...and so are its renders (the signed-in one is the account'"'"'s page)' no "$(yn test -e "$PEND/$S.renders")"
run "$BROWSER" status "$S"
tc 'B2 the probe USES it: the live login reads authenticated' 'authenticated' "$OUT"
tn 'B2 ...not UNKNOWN any more' 'UNKNOWN' "$OUT"
printf '%s' "$SIGNED_OUT" > "$SD/.fake-dom"
run "$BROWSER" status "$S"
tc 'B2 ...and the same login signed out reads expired' 'session expired' "$OUT"
printf '%s' "$SIGNED_IN" > "$SD/.fake-dom"
run "$BROWSER" adapters approve "$S"
t  'B3 approve with nothing pending is refused' 64 "$RC"

# B4 the owner picks ANOTHER candidate than reflex did
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
run "$BROWSER" adapters approve "$S" --marker=m2
t  'B4 --marker=m2 exits 0' 0 "$RC"
t  'B4 ...and writes the candidate the owner chose' "name=[\"']?login" "$(jq -r .probe.logged_out_when_dom_matches "$ADS/$S.json" 2>/dev/null)"
tc 'B4 ...recording that reflex picked something else' 'reflex picked m1' "$(jq -r ._comment "$ADS/$S.json" 2>/dev/null)"

# B5 a signed-in marker (--spa) for a single-page app
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null; : > "$TMP/rfx.spa"
run "$BROWSER" propose "$S"
t  'B5 an SPA proposal (no signed-out candidates) is pending' 0 "$RC"
tc 'B5 ...drafted with --spa' '--spa' "$(cat "$FAKE_RFX_LOG")"
run "$BROWSER" adapters approve "$S"
t  'B5 approve writes the POSITIVE marker' "id=[\"']?account-menu" "$(jq -r .probe.logged_in_when_dom_matches "$ADS/$S.json" 2>/dev/null)"
t  'B5 ...and no signed-out marker it never had' null "$(jq -r .probe.logged_out_when_dom_matches "$ADS/$S.json" 2>/dev/null)"
run "$BROWSER" status "$S"
tc 'B5 the probe reads the live SPA login as authenticated' 'authenticated' "$OUT"
rm -f "$TMP/rfx.spa"

# B6 approve never overwrites, and never writes the package directory
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
mkdir -p "$ADS"; chmod 700 "$ADS"; echo '{"hand":"written"}' > "$ADS/$S.json"
run "$BROWSER" adapters approve "$S"
t  'B6 an existing .adapters/ file is not overwritten' 64 "$RC"
t  'B6 ...its bytes are unchanged' '{"hand":"written"}' "$(cat "$ADS/$S.json")"
rm -f "$ADS/$S.json"
FIVEDIVE_BROWSER_ADAPTER_DIR="$PKG_ADAPTERS" run "$BROWSER" adapters approve "$S"
t  'B6 an adapter dir pointed at the package is refused (77)' 77 "$RC"
t  'B6 ...and the package is untouched' "$PKG_BEFORE" "$(ls "$PKG_ADAPTERS" | sort | tr '\n' ' ')"

# B7 the owner, and only the owner
FIVEDIVE_BROWSER_GRANT_UID=0 run "$BROWSER" adapters approve "$S"
t  'B7 a non-owner uid cannot approve (77)' 77 "$RC"
SUDO_USER=agent-sneaky run "$BROWSER" adapters approve "$S"
t  'B7 an agent seat'"'"'s sudo cannot approve, even its own (77)' 77 "$RC"
t  'B7 ...nothing was written by either' no "$(yn test -e "$ADS/$S.json")"

# B8 approve re-counts: a proposal whose marker no longer separates the halves is refused
jq '.reflex.logged_out.candidates[0].marker = "Inbox|Sign in"' "$PEND/$S.json" > "$TMP/p" && cat "$TMP/p" > "$PEND/$S.json"
run "$BROWSER" adapters approve "$S"
t  'B8 a marker that also matches the signed-in render is refused (77)' 77 "$RC"
tc 'B8 ...naming the counts approve re-took' 'signed in 1' "$ERR"
t  'B8 ...and nothing was written' no "$(yn test -e "$ADS/$S.json")"
run "$BROWSER" adapters approve "$S" --marker=m9
t  'B8 a key that is not a candidate is refused' 64 "$RC"

# reject
run "$BROWSER" adapters reject "$S"
t  'R1 reject exits 0' 0 "$RC"
t  'R1 ...the proposal and its renders are gone' no "$(yn test -e "$PEND/$S.json" -o -e "$PEND/$S.renders")"
: > "$FAKE_RFX_LOG"
FIVEDIVE_BROWSER_AUTO_PROPOSE=1 FIVEDIVE_BROWSER_PROPOSE_RETRY_S=0 run "$BROWSER" status "$S"; sleep 1
t  'R1 a rejected site is not proposed again on its own, even past the retry window' '' "$(grep login-marker "$FAKE_RFX_LOG")"

# ============================================================ C  no signed-in render
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
jq '.signed_in_render = false' "$PEND/$S.json" > "$TMP/p" && cat "$TMP/p" > "$PEND/$S.json"
run "$BROWSER" adapters approve "$S"
t  'C1 a proposal built without a signed-in render cannot be approved (77)' 77 "$RC"
tc 'C1 ...and says why' 'not built with a signed-in render' "$ERR"
t  'C1 ...nothing written' no "$(yn test -e "$ADS/$S.json")"
jq '.signed_in_render = true' "$PEND/$S.json" > "$TMP/p" && cat "$TMP/p" > "$PEND/$S.json"
rm -f "$PEND/$S.renders/signed-in.html"
run "$BROWSER" adapters approve "$S"
t  'C2 the flag says true but the signed-in render is gone -> refused (77)' 77 "$RC"
t  'C2 ...nothing written' no "$(yn test -e "$ADS/$S.json")"
run "$BROWSER" adapters pending
tc 'C3 pending still lists it for the owner to reject' "$S" "$OUT"

# ============================================================ D  challenge renders
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
printf '%s' "$CHALLENGE" > "$FAKE_COLD_DOM"
run "$BROWSER" propose "$S"
t  'D1 a challenge on the signed-out half is refused (69)' 69 "$RC"
tc 'D1 ...named as a challenge' 'challenge page' "$ERR"
t  'D1 ...nothing pending, renders gone' no "$(yn test -e "$PEND/$S.json" -o -e "$PEND/$S.renders")"
t  'D1 ...and reflex was never asked' '' "$(grep login-marker "$FAKE_RFX_LOG")"
printf '%s' "$SIGNED_OUT" > "$FAKE_COLD_DOM"
reset_site "$S"; mkprofile "$S" '<html><head><title>Verify you are human</title></head><body>hold on</body></html>' >/dev/null
run "$BROWSER" propose "$S"
t  'D2 a challenge on the SIGNED-IN half (by its title) is refused too' 69 "$RC"
tc 'D2 ...and the owner is told to clear it in the viewer' 'Clear it in the viewer' "$ERR"
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null; : > "$TMP/rfx.fail"
run "$BROWSER" propose "$S"
t  'D3 reflex'"'"'s own challenge refusal stays a refusal' 69 "$RC"
tc 'D3 ...and its reason is passed on' 'challenge page' "$ERR"
t  'D3 ...nothing pending' no "$(yn test -e "$PEND/$S.json")"
rm -f "$TMP/rfx.fail"
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
printf '%s' "$CHALLENGE" > "$PEND/$S.renders/signed-out-2.html"
run "$BROWSER" adapters approve "$S"
t  'D4 approve re-checks: a challenge render in a proposal is refused (77)' 77 "$RC"
t  'D4 ...nothing written' no "$(yn test -e "$ADS/$S.json")"

# ============================================================ drift
DS=drift.test
reset_site "$S"; DD=$(mkprofile "$DS" '<html><head><title>Chats</title></head><body><div class="tabs-tab chatlist-container"><ul class="chatlist">x</ul></div></body></html>')
mkdir -p "$ADS"; chmod 700 "$ADS"
# The shipped Telegram shape (DIVE-4931): the signed-in marker also matches the static shell.
printf '%s' '<html><head><title>Telegram</title></head><body><div class="tabs-tab chatlist-container"></div><div id="auth-pages"></div></body></html>' > "$FAKE_COLD_DOM"
jq -n --arg s "$DS" '{site:$s, probe:{url:"https://drift.test/k/", logged_out_when_dom_matches:"id=\"auth-pages", logged_in_when_dom_matches:"class=\"[^\"]*chatlist"}, actions:{}}' > "$ADS/$DS.json"
run "$BROWSER" adapters drift
t  'X1 a decayed marker exits 1' 1 "$RC"
tc 'X1 ...flagged DRIFTED' 'DRIFTED' "$OUT"
tc 'X1 ...saying what it would misread' 'a signed-out profile reads as signed in' "$OUT"
t  'X1 ...and written where a surface can read it' drifted "$(jq -r '.sites[0].verdict' "$SEATDIR/.5dive-drift.json" 2>/dev/null)"
t  'X1 the renders it counted are deleted' '' "$(ls -A "$PEND" 2>/dev/null | grep '^\.drift' )"
jq -n --arg s "$DS" '{site:$s, probe:{url:"https://drift.test/k/", logged_out_when_dom_matches:"id=\"auth-pages", logged_in_when_dom_matches:"class=\"([^\"]* )?chatlist[ \"]"}, actions:{}}' > "$ADS/$DS.json"
run "$BROWSER" adapters drift "$DS" --json
t  'X2 control: the corrected marker is ok and exits 0' 0 "$RC"
t  'X2 ...verdict ok' ok "$(jq -r '.sites[0].verdict' <<<"$OUT" 2>/dev/null)"
t  'X2 ...with its counts on both halves' '[0,0] 1' "$(jq -c '.sites[0].logged_in | "\(.signed_out) \(.signed_in)"' -r <<<"$OUT" 2>/dev/null)"
# probe-all runs it on its own clock, once a day
jq -n --arg s "$DS" '{site:$s, probe:{url:"https://drift.test/k/", logged_out_when_dom_matches:"id=\"auth-pages", logged_in_when_dom_matches:"class=\"[^\"]*chatlist"}, actions:{}}' > "$ADS/$DS.json"
rm -f "$SEATDIR/.5dive-drift.json"
FIVEDIVE_BROWSER_DRIFT_ON_PROBE=1 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0 run "$BROWSER" probe-all
tc 'X3 probe-all re-measures and prints the drift' 'DRIFTED' "$OUT"
t  'X3 ...and a drift is not a red timer' 0 "$RC"
n0=$(cat "$DD/.fake-n")
FIVEDIVE_BROWSER_DRIFT_ON_PROBE=1 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0 run "$BROWSER" probe-all
t  'X3 a second probe-all the same day does not capture again (one probe load only)' $((n0+1)) "$(cat "$DD/.fake-n")"
printf '%s' "$SIGNED_OUT" > "$FAKE_COLD_DOM"
rm -rf "$SEATDIR/$DS" "$ADS/$DS.json"

# ============================================================ dispatch and docs
run bash "$BROWSER" --help
tc 'H1 --help documents propose' '5dive browser propose <site>' "$OUT$ERR"
tc 'H1 --help documents the owner'"'"'s approve' 'sudo 5dive browser adapters approve <site>' "$OUT$ERR"
tc 'H1 --help documents drift' '5dive browser adapters drift' "$OUT$ERR"
tc 'H2 root keeps adapters (approve reads every seat and writes as that seat)' 'setup|adblock|approve|approvals|adapters|_connect' "$(cat "$BROWSER")"
tc 'H2 ...but drift drops to the seat, because it captures' '_v1=adapters-drift' "$(cat "$BROWSER")"

# ============================================================ mutants: the refusal arms can go red
MUT="$TMP/mut"; mkdir -p "$MUT/bin" "$MUT/adapters"
mutant() {  # <name> <python replace: old> <new>
  python3 - "$BROWSER" "$MUT/bin/browser" "$2" "$3" <<'PY'
import sys; s=open(sys.argv[1]).read(); old=sys.argv[3]
assert s.count(old)==1, "mutant anchor not found exactly once: "+old
open(sys.argv[2],'w').write(s.replace(old, sys.argv[4]))
PY
  chmod +x "$MUT/bin/browser"
}
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
jq '.signed_in_render = false' "$PEND/$S.json" > "$TMP/p" && cat "$TMP/p" > "$PEND/$S.json"
mutant no-signed-in-check '[[ "$(jq -r '"'"'.signed_in_render'"'"' "$pf")" == true && -f "$si"' '[[ -f "$si"'
run "$MUT/bin/browser" adapters approve "$S"
t  'M1 mutant without the signed-in-render refusal WRITES (so C1 can go red)' 0 "$RC"
rm -rf "$ADS"
reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
run "$BROWSER" propose "$S"
jq '.reflex.logged_out.candidates[0].marker = "Inbox|Sign in"' "$PEND/$S.json" > "$TMP/p" && cat "$TMP/p" > "$PEND/$S.json"
mutant no-recount '(( c1 >= 1 && c2 >= 1 && ci == 0 )) ||' 'true ||'
run "$MUT/bin/browser" adapters approve "$S"
t  'M2 mutant without the re-count WRITES the bad marker (so B8 can go red)' 0 "$RC"
rm -rf "$ADS"

# ============================================================ R  the REAL login-marker, when installed
REAL="$(command -v 5dive 2>/dev/null || true)"
# (a pipe would report the CLI's usage exit under pipefail, not grep's match)
if [[ -n "$REAL" ]] && grep -q 'usage: 5dive reflex login-marker' <<<"$("$REAL" reflex login-marker 2>&1)"; then
  reset_site "$S"; mkprofile "$S" "$SIGNED_IN" >/dev/null
  FIVEDIVE_REFLEX_RECEIPTS=0 FIVEDIVE_BROWSER_CLI="$REAL" FIVEDIVE_BROWSER_REFLEX_BACKEND=fake:first run "$BROWSER" propose "$S" --url=https://newsite.test/home
  if (( RC == 0 )); then
    t  'R2 the real CLI'"'"'s candidates, verified on both halves, land pending' yes "$(yn test -f "$PEND/$S.json")"
    t  'R2 ...every candidate has 0 matches on the signed-in render' 0 "$(jq '[.reflex.logged_out.candidates[] | select(.in != 0)] | length' "$PEND/$S.json")"
    run "$BROWSER" adapters approve "$S"
    t  'R2 ...its heuristic pick approves' 0 "$RC"
    run "$BROWSER" status "$S"
    tc 'R2 ...and the probe reads the live login with it' 'authenticated' "$OUT"
  else
    tc 'R2 the real CLI is present but reflex is not configured here' 'not configured' "$ERR"
  fi
else
  echo "note: R2 skipped — no 5dive CLI with reflex login-marker on this machine"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
