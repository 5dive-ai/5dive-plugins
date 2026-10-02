#!/usr/bin/env bash
# DIVE-5287 — the INPUT drive mode: a site that refuses an automated browser is
# served as plain Chrome and driven through the X display (screen + real
# keyboard/mouse), with a same-window handoff to a person.
#
#   U  lib/x11.cjs without a display: the PNG it writes decodes to the pixels it
#      was given, and key names / characters map to the right keysyms.
#   R  bin/browser routing, through the real script with a FAKE session daemon
#      that records every request:
#        R1 the shipped tiktok.com adapter opts into input mode; reddit.com does not
#        R2 `serve` starts the daemon with --input and records drive=input
#        R3 shot / snapshot ask for `screen` (with the lease and the challenge
#           titles) and write the PNG
#        R4 tree / read / links / run refuse by name and send nothing
#        R5 act: a selector is refused; a declared `pay` stops for the owner
#           (73) with nothing sent; a declared `publish` runs under the default
#           policy; a daemon challenge (75) becomes E_COLD with handoff advice
#        R6 handoff opens / reports / closes through `hand`
#        R7 a proxied seat is refused input mode rather than served off-proxy
#        R8 regression: a CDP site is never routed to the input verbs
#        R10 the BOX default (DIVE-5338): `config drive=input` serves an adapter-less
#           site as input; an adapter's "drive": "cdp" still wins; a proxied seat
#           falls back to the automated browser with a note, not a refusal; the
#           setting is root's; `auto` is the shipped default again
#        R11 a person's sign-in survives Done on a daemon-held browser (DIVE-5374):
#           the stop waits for the cookie commit when a viewer was redeemed on this
#           serve — input or warm CDP — within 60 s of the person leaving, and not
#           otherwise; a mutant without it loses it
#   L  LIVE, when this machine has Xvfb and Chrome (GitHub's ubuntu runner does):
#      the real daemon, real plain Chrome, real XTEST input.
#        L1 the page sees navigator.webdriver === false, and the daemon reports
#           the browser holding the keyboard focus
#        L1b the page has RECEIVED pointer input (a handshake) before L3 — L3 is
#           gated on observed readiness, not on the title alone (quinn, iter 1)
#        L2 Chrome's command line carries no --remote-debugging / --enable-automation
#        L1c the browser is the TOPMOST window at the L3 click point
#        L3 a click and typed text arrive as isTrusted events, non-ASCII included.
#           The input is sent ONCE; the arm then waits (bounded) to SEE it, because
#           Chrome retitles the window asynchronously and a loaded runner took
#           longer than the 300ms settle to (DIVE-5342: L5 then read the text L3
#           had "missed"). A red L3 prints the window stack at the click point and
#           saves the screen to $INPUT_HARNESS_ARTIFACTS, so it explains itself.
#        L3m the instrument: the same L3 check on a click point another window
#           covers goes red, and its dump names that window as topmost
#        L4 `screen` returns a PNG of the whole display
#        L5 an open handoff refuses agent input; closing it restores it
#        L6 DOM ops are refused by name
#        L8 a click on a point another window covers fails the step non-zero,
#           and the plan stops there (it used to report rc=0 over a lost click)
#        L9 keyboard focus taken by another window is moved back before typing
#        L7 shutdown takes Chrome with it
#        L10 a FRESH page driven the instant its title appears still gets the
#           text: the daemon holds input until the page is quiet (the CI race)
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
REAL_DAEMON="$ROOT/plugins/browser/bin/session-daemon"
X11LIB="$ROOT/plugins/browser/lib/x11.cjs"
REAL_XVFB="$(command -v Xvfb || true)"
REAL_CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
# INPUT_DRIVE_SKIP_LIVE=1: the R arms only, on a host where real Chrome must not run
# (the production API host). CI leaves it unset and runs the L arms.
[[ -n "${INPUT_DRIVE_SKIP_LIVE:-}" ]] && REAL_XVFB=""

# SHORT PATHS. A unix socket path is capped at 108 bytes; a long mktemp root
# makes the daemon bind a truncated name and every arm below read "not live".
TMP="$(mktemp -d /tmp/d5287.XXXXXX)"
_KILL=()
# CI ANNOTATIONS. A failing arm and the live daemon's stderr are written as
# ::error annotations too: Actions LOGS need a GitHub login to read, check-run
# annotations do not, so a seat with no gh credential can still see which arm
# went red and why (DIVE-5287: a red run nobody at the maker seat could read).
gha() {  # gha <title> <text>
  [[ "${GITHUB_ACTIONS:-}" == true ]] || return 0
  local m="$2"; m="${m//'%'/%25}"; m="${m//$'\r'/%0D}"; m="${m//$'\n'/%0A}"
  printf '::error title=%s::%s\n' "${1//[:,]/ }" "$m"
}
_diag() {
  (( ${FAIL:-0} )) || return 0
  local f; for f in l.err l3.err l.cverr l2.err; do
    [[ -s "$TMP/$f" ]] && gha "input harness: daemon stderr ($f)" "$(grep -v -i dbus "$TMP/$f" | tail -15)"
  done; return 0
}
trap 'rc=$?; _diag; for p in "${_KILL[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0; SKIP=0
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"
    gha "input harness FAIL: ${1:0:80}" "expected: $2"$'\n'"got: $3"; fi
}
yn() { if "$@"; then echo yes; else echo no; fi; }
# Where a red live arm's screen goes. CI sets it and uploads it on failure.
ART="${INPUT_HARNESS_ARTIFACTS:-}"; [[ -n "$ART" ]] && mkdir -p "$ART"

# ---------------------------------------------------------------- U: x11.cjs
out=$(node -e '
const x = require(process.argv[1]); const zlib = require("zlib");
// 2x1 image, ZPixmap LSBFirst BGRX: red, then blue.
const data = Buffer.from([0,0,255,0, 255,0,0,0]);
const png = x.encodePNG(data, 2, 1, 32, 0);
const sig = png.subarray(0, 8).toString("hex");
const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
let o = 8, idat = null, crcOk = true;
while (o < png.length) {
  const len = png.readUInt32BE(o), type = png.subarray(o + 4, o + 8).toString();
  if (x.crc32(png.subarray(o + 4, o + 8 + len)) !== png.readUInt32BE(o + 8 + len)) crcOk = false;
  if (type === "IDAT") idat = png.subarray(o + 8, o + 8 + len);
  o += 12 + len;
}
console.log([sig, w, h, crcOk, zlib.inflateSync(idat).toString("hex"),
  x.keysymOf("Enter").toString(16), x.keysymOf("pagedown").toString(16), x.keysymOf("F5").toString(16),
  x.keysymOf("a").toString(16), x.charKeysym("é").toString(16), x.charKeysym("✓").toString(16),
  String(x.keysymOf("nosuchkey"))].join(" "));
' "$X11LIB" 2>&1)
arm 'U1 the PNG has the signature, the size and valid CRCs' '89504e470d0a1a0a 2 1 true' "$(cut -d' ' -f1-4 <<<"$out")"
arm 'U2 the PNG rows are the given pixels as RGB (BGRX in, filter 0 + RGB out)' '00ff00000000ff' "$(cut -d' ' -f5 <<<"$out")"
arm 'U3 key names map to X keysyms (Enter, PageDown, F5, a)' 'ff0d ff56 ffc2 61' "$(cut -d' ' -f6-9 <<<"$out")"
arm 'U4 Latin-1 is its own keysym, anything else is 0x01000000+codepoint' 'e9 1002713' "$(cut -d' ' -f10-11 <<<"$out")"
arm 'U5 an unknown key name is refused, not guessed' 'null' "$(cut -d' ' -f12 <<<"$out")"

# ------------------------------------------------------ R: routing, fake daemon
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/pr"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/ad"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/rv"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/fake-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_TMP_ROOT="$TMP/tmproot"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_APPROVAL_POLICY="$TMP/no-policy.json"
export FIVEDIVE_BROWSER_CONNECT_PRIV="$TMP/fake-connect"
SEAT="$(id -un)"
mkdir -p "$TMP/pr/$SEAT" "$TMP/ad" "$TMP/x11"; chmod 711 "$TMP/pr"; chmod 700 "$TMP/pr/$SEAT"
mkdir -p "$TMP/rv/$SEAT"   # the rendezvous: where serve publishes the .offered marker
cp "$ROOT/plugins/browser/adapters/tiktok.com.json" "$ROOT/plugins/browser/adapters/reddit.com.json" "$TMP/ad/"
for s in tiktok.com reddit.com; do mkdir -p "$TMP/pr/$SEAT/$s"; chmod 700 "$TMP/pr/$SEAT/$s"; done

arm 'R1 the shipped tiktok.com adapter opts into input mode' input "$(jq -r .drive "$ROOT/plugins/browser/adapters/tiktok.com.json")"
arm 'R1 ...and reddit.com (a CDP site) does not' null "$(jq -r .drive "$ROOT/plugins/browser/adapters/reddit.com.json")"

DREC="$TMP/daemon.rec"; : > "$DREC"
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/Xvfb" <<XVFB
#!/usr/bin/env bash
: > "$TMP/x11/X\${1#:}"
exec sleep 300
XVFB
printf '#!/usr/bin/env bash\necho fake chrome >&2; exit 1\n' > "$FAKEBIN/google-chrome"
cat > "$TMP/fake-connect" <<'CONN'
#!/usr/bin/env bash
tr '\0' ' ' >> "${FAKE_CONNECT_REC:?}"; echo >> "$FAKE_CONNECT_REC"
CONN
export FAKE_CONNECT_REC="$TMP/connect.rec"; : > "$FAKE_CONNECT_REC"
chmod +x "$FAKEBIN/Xvfb" "$FAKEBIN/google-chrome" "$TMP/fake-connect"
# The fake daemon: `serve` listens and answers from canned state; `call` is the
# REAL client, so the wire format under test is the product's.
cat > "$TMP/fake-daemon" <<DAEMON
#!/usr/bin/env node
'use strict';
const fs = require('fs'), net = require('net');
const [, , mode, profile, ...rest] = process.argv;
if (mode === 'call') { const r = require('child_process').spawnSync('$REAL_DAEMON', ['call', profile], { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status); }
const input = rest.includes('--input');
const sock = rest.filter(a => !a.startsWith('--'))[0];
fs.appendFileSync('$TMP/daemon.argv', process.argv.slice(2).join(' ') + '\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
let hand = false;
// CHROME'S COOKIE BATCH (R11, DIVE-5374): what a person signs in with reaches
// Default/Cookies only when the commit timer fires, FAKE_COMMIT_MS after the
// sign-in (the test touches .fake-signin); a shutdown before then loses it.
const commitMs = Number(process.env.FAKE_COMMIT_MS || 0);
if (commitMs) {
  let t0 = 0;
  const iv = setInterval(() => {
    if (!t0 && fs.existsSync(profile + '/.fake-signin')) t0 = Date.now();
    if (t0 && Date.now() - t0 >= commitMs) {
      fs.mkdirSync(profile + '/Default', { recursive: true });
      fs.writeFileSync(profile + '/Default/Cookies', 'user_session\n'); clearInterval(iv);
    }
  }, 50);
}
const srv = net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    fs.appendFileSync('$DREC', JSON.stringify(req) + '\n');
    const send = (o) => c.write(JSON.stringify(o) + '\n');
    const end = (rc) => { send({ t: 'end', rc }); c.end(); };
    const rc = fs.existsSync('$TMP/fake.rc') ? Number(fs.readFileSync('$TMP/fake.rc', 'utf8')) : 0;
    if (req.op === 'ping') { send({ t: 'out', data: 'pong\n' }); return end(0); }
    // The real daemon re-enters bin/browser as the owner for this; the fake hands out a token.
    if (req.op === 'lease') { send({ t: 'out', data: req.act === 'acquire' ? 'fedcba9876543210fedcba9876543210\n' : 'free\n' }); return end(0); }
    // Either mode: a warm (CDP) serve is stopped this way too (R11e).
    if (req.op === 'shutdown') { end(0); srv.close(); try { fs.unlinkSync(sock); } catch (e) {} process.exit(0); }
    if (!input) { send({ t: 'err', msg: "unknown op '" + req.op + "'" }); return end(70); }
    if (req.op === 'title') { send({ t: 'out', data: JSON.stringify({ drive: 'input', title: 'Fake Page', handoff: hand, viewer: false }) + '\n' }); return end(0); }
    if (req.op === 'hand') { if (req.act === 'open') hand = true; if (req.act === 'close') hand = false;
      send({ t: 'out', data: JSON.stringify({ open: hand, viewer: false, title: 'Fake Page' }) + '\n' }); return end(0); }
    if (req.op === 'screen' || req.op === 'input') {
      if (req.op === 'input') for (let i = 0; i < req.steps.length; i++) send({ t: 'log', line: '  step ' + (i + 1) + ' (' + req.steps[i].op + ') ok' });
      send({ t: 'out', data: JSON.stringify({ drive: 'input', title: 'Fake Page', window_title: 'Fake Page - Google Chrome', width: 1280, height: 800, png_b64: PNG, act_report: req.op === 'input' || undefined, steps_run: req.op === 'input' ? req.steps.length : undefined }) + '\n' });
      if (rc === 75) send({ t: 'err', msg: 'CHALLENGE: fake' });
      return end(rc);
    }
    send({ t: 'err', msg: 'refused ' + req.op }); end(70);
  });
});
try { fs.unlinkSync(sock); } catch (e) {}
srv.listen(sock, () => process.stdout.write('ready sock=' + sock + '\n'));
process.on('SIGTERM', () => { try { fs.unlinkSync(sock); } catch (e) {} process.exit(0); });
DAEMON
chmod +x "$TMP/fake-daemon"
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"
OLDPATH="$PATH"; export PATH="$FAKEBIN:$PATH"
reqs() { jq -r -s --arg op "$1" '[.[] | select(.op==$op)] | length' "$DREC"; }
last() { jq -c -s --arg op "$1" '[.[] | select(.op==$op)] | last' "$DREC"; }

o=$("$BROWSER" serve tiktok.com 2>&1); rc=$?
arm 'R2 serve of an input site succeeds' 0 "$rc"
arm 'R2 ...and says it is input mode' yes "$(yn grep -q 'input mode' <<<"$o")"
arm 'R2 the daemon was started with --input' yes "$(yn grep -q -- '--input' "$TMP/daemon.argv")"
arm 'R2 the serve record says drive=input' input "$(sed -n 's/^drive=//p' "$TMP/pr/$SEAT/tiktok.com/.5dive-serve")"
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/tiktok.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/tiktok.com/.5dive-serve")")
arm 'R2 the .offered marker tells brokered seats this site is input mode' input "$(sed -n 's/^drive=//p' "$TMP/rv/$SEAT/tiktok.com.offered")"
o=$("$BROWSER" serve tiktok.com --login 2>&1)
arm 'R2 --login on an input serve keeps the same window (no re-serve)' 'already serving' "$(grep -o 'already serving' <<<"$o")"

cd "$TMP"
o=$("$BROWSER" shot tiktok.com https://www.tiktok.com/profile --out="$TMP/s.png" 2>&1); rc=$?
arm 'R3 shot on an input site exits 0 and writes a PNG' '0 yes' "$rc $(yn test -s "$TMP/s.png")"
arm 'R3 ...asking the daemon for `screen` at that url' 'https://www.tiktok.com/profile' "$(last screen | jq -r .url)"
arm 'R3 ...carrying the lease' yes "$(last screen | jq -r 'if (.token|length) > 10 and (.lease|test("5dive-lease")) then "yes" else "no" end')"
arm 'R3 ...and the adapter'"'"'s challenge titles' yes "$(last screen | jq -r 'if (.challenge|test("captcha")) then "yes" else "no" end')"
o=$("$BROWSER" shot https://www.tiktok.com/@someone --out="$TMP/s2.png" 2>&1); rc=$?
arm 'R3 a URL in place of the site routes to the input verb too' '0 yes' "$rc $(yn test -s "$TMP/s2.png")"
o=$("$BROWSER" snapshot tiktok.com --out="$TMP/snap" --json 2>&1); rc=$?
arm 'R3 snapshot writes page.png + page.meta.json saying there is no DOM' '0 yes yes' \
  "$rc $(yn test -s "$TMP/snap/page.png") $(yn grep -q '"dom": "none' "$TMP/snap/page.meta.json")"
arm 'R3 shot with a foreign url is refused before anything is sent' 64 \
  "$("$BROWSER" shot tiktok.com https://evil.example/ >/dev/null 2>&1; echo $?)"

n0=$(wc -l < "$DREC")
for v in tree read links; do
  o=$("$BROWSER" "$v" tiktok.com https://www.tiktok.com/ 2>&1); rc=$?
  arm "R4 $v on an input site is refused (69) by name" '69 yes' "$rc $(yn grep -q 'INPUT mode' <<<"$o")"
done
o=$("$BROWSER" run tiktok.com post 2>&1); rc=$?
arm 'R4 run on an input site is refused (69) by name' '69 yes' "$rc $(yn grep -q 'INPUT mode' <<<"$o")"
arm 'R4 ...and none of them sent the daemon anything' "$n0" "$(wc -l < "$DREC")"

o=$("$BROWSER" act tiktok.com --steps='[{"op":"click","selector":"ref=button/Post"}]' 2>&1); rc=$?
arm 'R5 act with a selector is refused (64): there is no DOM' '64 yes' "$rc $(yn grep -q 'no DOM' <<<"$o")"
n0=$(reqs input)
o=$("$BROWSER" act tiktok.com --steps='[{"op":"click","x":10,"y":10,"kind":"pay"}]' 2>&1); rc=$?
arm 'R5 a declared pay stops for the owner (73) under the default policy' '73 yes' "$rc $(yn grep -q 'handoff tiktok.com' <<<"$o")"
arm 'R5 ...and nothing reached the browser' "$n0" "$(reqs input)"
o=$("$BROWSER" act tiktok.com --steps='[{"op":"click","x":10,"y":10,"kind":"shop"}]' 2>&1); rc=$?
arm 'R5 an unknown kind is refused (64)' 64 "$rc"
o=$("$BROWSER" act tiktok.com https://www.tiktok.com/upload --steps='[{"op":"type","value":"hi","kind":"publish"},{"op":"press","key":"Enter"}]' --out="$TMP/act" 2>&1); rc=$?
arm 'R5 a declared publish runs under the default policy (allow)' '0 yes' "$rc $(yn test -s "$TMP/act/page.png")"
arm 'R5 ...as goto + the steps, with kind stripped before the daemon' '["goto","type","press"] null' \
  "$(last input | jq -c '[.steps[].op]') $(last input | jq -c '[.steps[] | .kind // empty] | first')"
arm 'R5 ...and the publish is on the audit log' yes "$(yn grep -q 'input-publish' "$TMP/pr/$SEAT/tiktok.com/.5dive-audit.jsonl")"
echo 75 > "$TMP/fake.rc"
o=$("$BROWSER" act tiktok.com --steps='[{"op":"press","key":"Enter"}]' --out="$TMP/act2" 2>&1); rc=$?
rm -f "$TMP/fake.rc"
arm 'R5 a challenge from the daemon is E_COLD (75) with the handoff advice' '75 yes' "$rc $(yn grep -q 'browser handoff tiktok.com' <<<"$o")"

: > "$FAKE_CONNECT_REC"
o=$("$BROWSER" handoff tiktok.com --reason="solve the puzzle" 2>&1); rc=$?
arm 'R6 handoff opens it at the daemon' '0 open' "$rc $(last hand | jq -r .act)"
arm 'R6 ...and asks the owner through the privileged Connect path as a handoff' 'handoff tiktok.com solve the puzzle' "$(head -1 "$FAKE_CONNECT_REC" | sed 's/ *$//')"
arm 'R6 --status reports it open' true "$("$BROWSER" handoff tiktok.com --status 2>/dev/null | jq -r .open)"
o=$("$BROWSER" evict --idle=0 2>&1)
arm 'R6 the idle sweep keeps a window that is handed to the owner' yes "$(yn grep -q 'tiktok.com.*kept: handed to the owner' <<<"$o")"
arm 'R6 ...and it is still served' yes "$(yn grep -qx tiktok.com <<<"$("$BROWSER" served 2>/dev/null)")"
o=$("$BROWSER" handoff tiktok.com --close 2>&1); rc=$?
arm 'R6 --close hands the window back' '0 false' "$rc $("$BROWSER" handoff tiktok.com --status 2>/dev/null | jq -r .open)"
o=$("$BROWSER" handoff tiktok.com --wait=5 2>&1); rc=$?
arm 'R6 --wait returns at once when nothing is handed over' '0 yes' "$rc $(yn grep -q 'agent has the window again' <<<"$o")"
o=$("$BROWSER" handoff reddit.com 2>&1); rc=$?
arm 'R6 handoff on a CDP site is refused: there is no live window to hand over' '69 yes' "$rc $(yn grep -q 'not in input mode' <<<"$o")"

"$BROWSER" serve tiktok.com --stop >/dev/null 2>&1
printf 'http://u:p@example.com:8080\n' > "$TMP/pr/$SEAT/.5dive-proxy"; chmod 600 "$TMP/pr/$SEAT/.5dive-proxy"
n0=$(wc -l < "$TMP/daemon.argv")
o=$("$BROWSER" serve tiktok.com 2>&1); rc=$?
arm 'R7 a proxied seat is refused input mode (69), not served off its proxy' '69 yes' "$rc $(yn grep -q 'proxy' <<<"$o")"
arm 'R7 ...before any browser was started' "$n0" "$(wc -l < "$TMP/daemon.argv")"
rm -f "$TMP/pr/$SEAT/.5dive-proxy"

# R9 — a BROKERED seat (no store of its own, borrowing the box login) routes by
# the .offered marker, and never by asking the daemon.
"$BROWSER" serve tiktok.com >/dev/null 2>&1
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/tiktok.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/tiktok.com/.5dive-serve")")
"$BROWSER" serve reddit.com >/dev/null 2>&1   # a CDP site: the fake answers it as a warm session
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/reddit.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/reddit.com/.5dive-serve")")
brk() { FIVEDIVE_BROWSER_SEAT=agent-borrower FIVEDIVE_BROWSER_BOX_SEAT="$SEAT" "$BROWSER" "$@"; }
if [[ -S "$TMP/rv/$SEAT/tiktok.com.sock" ]]; then
  n0=$(reqs screen)
  o=$(brk shot tiktok.com --out="$TMP/b.png" 2>&1); rc=$?
  arm 'R9 a brokered seat reaches the input verbs through the box socket' "0 yes $((n0 + 1))" "$rc $(yn test -s "$TMP/b.png") $(reqs screen)"
  n0=$(reqs title)
  o=$(brk tree reddit.com https://www.reddit.com/ 2>&1)
  arm 'R9 regression: a brokered verb on a CDP site sends the daemon no title probe' "$n0 no" "$(reqs title) $(yn grep -q 'INPUT mode' <<<"$o")"
else
  SKIP=$((SKIP+1)); printf 'SKIP: R9 — this machine cannot open a broker socket (no SO_PEERCRED via python3)\n'
fi
"$BROWSER" serve reddit.com --stop >/dev/null 2>&1

n0=$(reqs screen)
o=$("$BROWSER" shot reddit.com https://www.reddit.com/ --out="$TMP/r.png" 2>&1)
arm 'R8 regression: shot on reddit.com (CDP) never reaches the input verbs' "$n0 no" \
  "$(reqs screen) $(yn grep -qi 'input mode' <<<"$o")"
o=$("$BROWSER" tree reddit.com https://www.reddit.com/ 2>&1)
arm 'R8 ...nor does tree' no "$(yn grep -q 'INPUT mode' <<<"$o")"

# R10 — THE BOX DEFAULT (DIVE-5338). news.example.com has no adapter at all;
# cdp.example.com has one that says "drive": "cdp".
export FIVEDIVE_BROWSER_DRIVE_DEFAULT_FILE="$TMP/drive-default"
for s in news.example.com cdp.example.com; do mkdir -p "$TMP/pr/$SEAT/$s"; chmod 700 "$TMP/pr/$SEAT/$s"; done
printf '{"site":"cdp.example.com","drive":"cdp"}\n' > "$TMP/ad/cdp.example.com.json"
arm 'R10 nothing set: config reads auto (the shipped default)' 'drive=auto' "$("$BROWSER" config 2>&1 | head -1)"
n0=$(reqs screen)
o=$("$BROWSER" shot news.example.com https://news.example.com/ --out="$TMP/n0.png" 2>&1)
arm 'R10 ...and an adapter-less site is not input mode' "$n0 no" "$(reqs screen) $(yn grep -qi 'input mode' <<<"$o")"
if [[ "$(id -u)" != 0 ]]; then
  o=$("$BROWSER" config drive=input 2>&1); rc=$?
  arm 'R10 a seat cannot set the box default (77), and nothing is written' '77 no' "$rc $(yn test -e "$TMP/drive-default")"
fi
o=$("$BROWSER" config drive=sideways 2>&1); rc=$?
arm 'R10 an unknown drive value is refused (64)' 64 "$rc"
printf '# set by root\ninput\n' > "$TMP/drive-default"   # what `sudo … config drive=input` writes
arm 'R10 config reads it back' 'drive=input' "$("$BROWSER" config 2>&1 | head -1)"
o=$("$BROWSER" serve news.example.com 2>&1); rc=$?
arm 'R10 drive=input serves an adapter-less site as input mode' '0 yes' "$rc $(yn grep -q 'input mode' <<<"$o")"
arm 'R10 ...the daemon was started with --input' yes "$(tail -1 "$TMP/daemon.argv" | grep -q -- '--input' && echo yes || echo no)"
arm 'R10 ...the serve record and the .offered marker say input' 'input input' \
  "$(sed -n 's/^drive=//p' "$TMP/pr/$SEAT/news.example.com/.5dive-serve") $(sed -n 's/^drive=//p' "$TMP/rv/$SEAT/news.example.com.offered")"
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/news.example.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/news.example.com/.5dive-serve")")
n0=$(reqs screen)
o=$("$BROWSER" shot news.example.com https://news.example.com/ --out="$TMP/n1.png" 2>&1); rc=$?
arm 'R10 shot on it takes the input verb' "0 $((n0 + 1))" "$rc $(reqs screen)"
n0=$(wc -l < "$DREC")
o=$("$BROWSER" read news.example.com https://news.example.com/ 2>&1); rc=$?
arm 'R10 read on it is refused by name (69), nothing sent' "69 yes $n0" "$rc $(yn grep -q 'INPUT mode' <<<"$o") $(wc -l < "$DREC")"
"$BROWSER" serve news.example.com --stop >/dev/null 2>&1
n0=$(wc -l < "$TMP/daemon.argv")
o=$("$BROWSER" serve cdp.example.com 2>&1); rc=$?
arm 'R10 an adapter saying "drive": "cdp" wins over the box default' "0 no" "$rc $(tail -n +$((n0 + 1)) "$TMP/daemon.argv" | grep -q -- '--input' && echo yes || echo no)"
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/cdp.example.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/cdp.example.com/.5dive-serve")")
"$BROWSER" serve cdp.example.com --stop >/dev/null 2>&1
printf 'http://u:p@example.com:8080\n' > "$TMP/pr/$SEAT/.5dive-proxy"; chmod 600 "$TMP/pr/$SEAT/.5dive-proxy"
n0=$(wc -l < "$TMP/daemon.argv")
o=$("$BROWSER" serve news.example.com 2>&1); rc=$?
arm 'R10 a proxied seat falls back to the automated browser (0), not refused' "0 no" "$rc $(tail -n +$((n0 + 1)) "$TMP/daemon.argv" | grep -q -- '--input' && echo yes || echo no)"
arm 'R10 ...and says so in ONE note line' 1 "$(grep -c 'defaults to input mode, but this seat has a proxy' <<<"$o")"
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$TMP/pr/$SEAT/news.example.com/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$TMP/pr/$SEAT/news.example.com/.5dive-serve")")
"$BROWSER" serve news.example.com --stop >/dev/null 2>&1
o=$("$BROWSER" serve tiktok.com 2>&1); rc=$?
arm 'R10 ...while an adapter'"'"'s own input is still refused under a proxy (69)' 69 "$rc"
rm -f "$TMP/pr/$SEAT/.5dive-proxy"
printf 'cdp\n' > "$TMP/drive-default"
n0=$(reqs screen)
o=$("$BROWSER" shot news.example.com https://news.example.com/ --out="$TMP/n2.png" 2>&1)
arm 'R10 drive=cdp: the adapter-less site is the automated browser again' "$n0 no" "$(reqs screen) $(yn grep -qi 'input mode' <<<"$o")"
arm 'R10 ...and tiktok.com is still input (its adapter wins)' 0 "$("$BROWSER" serve tiktok.com >/dev/null 2>&1; echo $?)"
rm -f "$TMP/drive-default"
unset FIVEDIVE_BROWSER_DRIVE_DEFAULT_FILE

# R11 — A PERSON'S SIGN-IN SURVIVES DONE ON A DAEMON-HELD BROWSER (DIVE-5374). On an
# input-mode box the viewer attaches to the session daemon's plain Chrome, so the stop
# Done runs has no chrome_pid and no login=1 — and DIVE-5286's cookie-commit wait was
# skipped: chill-gorge lost a github.com sign-in made 7 s before Done (2026-10-02). The
# fake daemon above commits the sign-in FAKE_COMMIT_MS after it and loses it on shutdown.
"$BROWSER" serve tiktok.com --stop >/dev/null 2>&1
R11D="$TMP/pr/$SEAT/tiktok.com"
r11_serve() {  # r11_serve [browser] — a fresh input serve whose commit is 1.5 s after the sign-in
  rm -f "$R11D/.fake-signin" "$R11D/Default/Cookies" "$R11D/.5dive-viewer.admitted"
  FAKE_COMMIT_MS=1500 "${1:-$BROWSER}" serve tiktok.com >/dev/null 2>&1
  _KILL+=("$(sed -n 's/^daemon_pid=//p' "$R11D/.5dive-serve")" "$(sed -n 's/^xvfb_pid=//p' "$R11D/.5dive-serve")")
}
r11_admit() {  # what viewer-redeem writes (graded there, in browser_plugin_unit.sh T10d)
  ( umask 077; printf 'admitted_at=%s\n' "${1:-$(date -u +%s)}" > "$R11D/.5dive-viewer.admitted" )
}
r11_stop() {  # r11_stop [browser] — times the stop into R11MS
  local s; s=$(date +%s%3N)
  "${1:-$BROWSER}" serve tiktok.com --stop >/dev/null 2>&1; R11RC=$?
  R11MS=$(( $(date +%s%3N) - s ))
}
r11_cookie() { cat "$R11D/Default/Cookies" 2>/dev/null; }

r11_serve; r11_admit
arm 'R11a (setup) an input serve with a person admitted to it' 'yes yes' \
  "$(yn grep -q '^drive=input' "$R11D/.5dive-serve") $(yn test -s "$R11D/.5dive-viewer.admitted")"
: > "$R11D/.fake-signin"   # the person signs in; Done comes at once, before the commit
r11_stop
arm 'R11a serve --stop stops' 0 "$R11RC"
arm 'R11a ...and the sign-in is on disk: the stop waited for the commit' 'user_session' "$(r11_cookie)"
arm 'R11a ...and left on the commit, not the 24 s cap' yes "$( (( R11MS < 6000 )) && echo yes || echo "no (${R11MS}ms)")"
arm 'R11a ...and the daemon, its serve record and the admitted marker are gone' 'no no' \
  "$(yn test -e "$R11D/.5dive-serve") $(yn test -e "$R11D/.5dive-viewer.admitted")"

# R11b nobody was let in: an agent's stop of the same browser is not held.
r11_serve; : > "$R11D/.fake-signin"
r11_stop
arm 'R11b with no person admitted the stop is not held' yes "$( (( R11MS < 3000 )) && echo yes || echo "no (${R11MS}ms)")"
arm 'R11b (control) ...and the fake did lose its pending commit on shutdown' '' "$(r11_cookie)"

# R11c a marker from an EARLIER serve does not hold this one.
r11_serve; r11_admit 1; : > "$R11D/.fake-signin"
r11_stop
arm 'R11c a person admitted before this serve started does not hold its stop' yes "$( (( R11MS < 3000 )) && echo yes || echo "no (${R11MS}ms)")"

# R11d nothing pending: the wait is capped, and the stop still stops.
r11_serve; r11_admit
FIVEDIVE_BROWSER_COOKIE_SETTLE=1 r11_stop
arm 'R11d with no commit coming the stop waits out the cap and stops' '0 yes no' \
  "$R11RC $( (( R11MS >= 900 && R11MS < 4000 )) && echo yes || echo "no (${R11MS}ms)") $(yn test -e "$R11D/.5dive-serve")"

# R11e a warm (CDP) serve a person was viewing waits too: the key is the person, not the mode.
"$BROWSER" serve reddit.com --stop >/dev/null 2>&1
R11W="$TMP/pr/$SEAT/reddit.com"; rm -f "$R11W/.fake-signin" "$R11W/Default/Cookies"
FAKE_COMMIT_MS=1500 "$BROWSER" serve reddit.com >/dev/null 2>&1
_KILL+=("$(sed -n 's/^daemon_pid=//p' "$R11W/.5dive-serve")")
( umask 077; printf 'admitted_at=%s\n' "$(date -u +%s)" > "$R11W/.5dive-viewer.admitted" )
arm 'R11e (setup) a warm CDP serve' no "$(yn grep -q '^drive=input' "$R11W/.5dive-serve")"
: > "$R11W/.fake-signin"
"$BROWSER" serve reddit.com --stop >/dev/null 2>&1
arm 'R11e ...and the sign-in a person made in it is on disk after the stop' 'user_session' "$(cat "$R11W/Default/Cookies" 2>/dev/null)"

# R11f a person who left long ago does not hold a later stop (the idle sweep's): the input
# daemon lives for hours, and what they changed before leaving is on disk by now.
r11_serve; : > "$R11D/.fake-signin"
( umask 077; printf 'admitted_at=%s\nleft_at=%s\n' "$(( $(date -u +%s) - 700 ))" "$(( $(date -u +%s) - 600 ))" > "$R11D/.5dive-viewer.admitted" )
sed -i "s/^started_at=.*/started_at=$(( $(date -u +%s) - 800 ))/" "$R11D/.5dive-serve"
r11_stop
arm 'R11f a person who left 10 min ago does not hold the stop' yes "$( (( R11MS < 3000 )) && echo yes || echo "no (${R11MS}ms)")"

# R11g ...but Done after a LONG view does: its revoke takes the view down a second before the stop.
r11_serve
sed -i "s/^started_at=.*/started_at=$(( $(date -u +%s) - 800 ))/" "$R11D/.5dive-serve"
r11_admit "$(( $(date -u +%s) - 700 ))"
sleep 300 & R11V=$!; _KILL+=("$R11V")
( umask 077; printf 'vnc_pid=%s\n' "$R11V" > "$R11D/.5dive-viewer" )
"$BROWSER" viewer-revoke tiktok.com >/dev/null 2>&1
arm 'R11g (setup) the revoke recorded when the person left' yes "$(yn grep -q '^left_at=' "$R11D/.5dive-viewer.admitted")"
: > "$R11D/.fake-signin"
r11_stop
arm 'R11g a sign-in at the end of a 10-minute view is on disk after Done' 'user_session' "$(r11_cookie)"

# R11m MUTANT: the 1.28.0 stop, whose wait keys on login=1 alone — the sign-in is lost.
MUT11="$TMP/mut11"; rm -rf "$MUT11"; cp -r "$ROOT/plugins/browser" "$MUT11"
sed -i 's/^_viewer_admitted_since() {.*/&\n  return 1/' "$MUT11/bin/browser"
arm 'R11m (anchor) the mutation applied' 1 "$(grep -A1 '^_viewer_admitted_since() {' "$MUT11/bin/browser" | grep -c '^  return 1$')"
r11_serve "$MUT11/bin/browser"; r11_admit; : > "$R11D/.fake-signin"
r11_stop "$MUT11/bin/browser"
arm 'R11m the mutant still says it stopped' 0 "$R11RC"
arm 'R11m ...and the sign-in never reached disk — the lost login' '' "$(r11_cookie)"
sleep 2
arm 'R11m (control) ...and the commit it cut off never came' '' "$(r11_cookie)"
export PATH="$OLDPATH"
cd "$ROOT"

# --------------------------------------------------------------- L: live
if [[ -z "$REAL_XVFB" || -z "$REAL_CHROME" ]]; then
  SKIP=$((SKIP+1)); printf 'SKIP: L live arms — this machine has no Xvfb (%s) or no Chrome (%s)\n' "${REAL_XVFB:-none}" "${REAL_CHROME:-none}"
else
  unset FIVEDIVE_BROWSER_X11_DIR
  disp=""
  for n in $(seq 640 700); do [[ -e "/tmp/.X11-unix/X$n" ]] || { disp=$n; break; }; done
  "$REAL_XVFB" ":$disp" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 & _KILL+=("$!")
  for i in $(seq 1 100); do [[ -e "/tmp/.X11-unix/X$disp" ]] && break; sleep 0.05; done
  PAGE="$TMP/page.html"
  cat > "$PAGE" <<'HTML'
<html><head><title>x</title></head><body style="margin:0">
<textarea id=t style="position:fixed;left:0;top:0;width:100vw;height:100vh;font-size:30px"></textarea>
<script>
const t = document.getElementById('t'); let trusted = 'none';
document.title = 'ready:wd=' + navigator.webdriver;
let armed = false;
addEventListener('mousemove', () => { if (!armed && document.title.startsWith('ready:')) { armed = true; document.title = 'armed:wd=' + navigator.webdriver; } });
t.addEventListener('mousedown', (e) => { trusted = String(e.isTrusted); });
t.addEventListener('input', (e) => { document.title = 'typed:' + t.value + ':click=' + trusted + ':key=' + e.isTrusted; });
</script></body></html>
HTML
  LP="$TMP/lp"; mkdir -m 700 "$LP"
  DISPLAY=":$disp" FIVEDIVE_BROWSER_CHROME="$REAL_CHROME" FIVEDIVE_BROWSER_CHROME_ARGS="file://$PAGE" \
    FIVEDIVE_BROWSER_INPUT_FAST=1 "$REAL_DAEMON" serve "$LP" "$LP/s.sock" --input > "$TMP/l.ready" 2> "$TMP/l.err" &
  LD=$!; _KILL+=("$LD")
  for i in $(seq 1 600); do grep -q '^ready' "$TMP/l.ready" 2>/dev/null && break; kill -0 "$LD" 2>/dev/null || break; sleep 0.05; done
  lc() { "$REAL_DAEMON" call "$LP/s.sock" <<<"$1"; }
  # stack <label> <x> <y> — the window stack at a point (tests/x11_stack.cjs);
  # its last line is `top=0x… browser=yes|no`. The screen goes to $ART if set.
  stack() {
    DISPLAY=":$disp" node "$ROOT/tests/x11_stack.cjs" "$1" "$2" "$3" "${cpid:-0}" ${ART:+"$ART/$1.png"} > "$TMP/stack.$1" 2>&1
    tail -1 "$TMP/stack.$1"
  }
  # see_title <sock> <want> — poll the window title until it reads <want> or
  # ~10s pass, and print what it read last. Sends NO input: a lost click or
  # keystroke stays lost, and the arm reading this stays red.
  see_title() {
    local t="" i; for i in $(seq 1 50); do
      t=$("$REAL_DAEMON" call "$1" <<<'{"op":"title"}' 2>/dev/null | jq -r .title)
      [[ "$t" == "$2" ]] && break; sleep 0.2
    done; printf '%s' "$t"
  }
  # drive <label> <x> <y> <text> <want-title> [expect-red] — L3's check: ONE
  # click + type, then wait to see the page's title say it arrived. Sets GOT to
  # "<rc> <title>". When it is not "0 <want>", the window stack at the click
  # point and the screen are dumped (as ::error too, unless red is expected).
  drive() {
    local t0=$SECONDS rc t
    lc "{\"op\":\"input\",\"steps\":[{\"op\":\"click\",\"x\":$2,\"y\":$3},{\"op\":\"type\",\"value\":\"$4\"}],\"settle\":300}" \
      > "$TMP/$1.in" 2>"$TMP/$1.err"; rc=$?
    t=$(jq -r .title "$TMP/$1.in" 2>/dev/null)
    if (( rc == 0 )) && [[ "$t" != "$5" ]]; then
      t=$(see_title "$LP/s.sock" "$5")
      printf '   (%s: the title was not there at the 300ms settle; read after polling, %ss in all)\n' "$1" "$((SECONDS - t0))"
    fi
    GOT="$rc $t"
    [[ "$GOT" == "0 $5" ]] && return 0
    stack "$1" "$2" "$3" >/dev/null
    sed 's/^/   /' "$TMP/stack.$1"
    [[ -n "${6:-}" ]] || gha "input harness: window stack after a red $1" "$(cat "$TMP/stack.$1")"
    return 0
  }
  if ! grep -q '^ready' "$TMP/l.ready"; then
    arm 'L0 the live input daemon came up' ready "$(grep -v -i dbus "$TMP/l.err" | tail -2 | tr '\n' ' ')"
  else
    t=""; for i in $(seq 1 80); do
      t=$(lc '{"op":"title"}' 2>/dev/null | jq -r '"\(.title) focused=\(.focused)"')
      [[ "$t" == "ready:wd=false focused=true" ]] && break; sleep 0.25
    done
    arm 'L1 the page sees navigator.webdriver === false, and the browser holds the keyboard' 'ready:wd=false focused=true' "$t"
    # THE HANDSHAKE (quinn, iteration 1): the title only says the page's script
    # ran. Input readiness is shown by the page RECEIVING input — a pointer move
    # it answers by retitling. Only then is L3 a test of delivery, not of timing.
    t=""; for i in $(seq 1 40); do
      lc "{\"op\":\"input\",\"steps\":[{\"op\":\"move\",\"x\":$((600 + (i % 2) * 40)),\"y\":450}],\"settle\":0}" >/dev/null 2>&1
      t=$(lc '{"op":"title"}' 2>/dev/null | jq -r .title); [[ "$t" == armed:* ]] && break; sleep 0.25
    done
    arm 'L1b the page receives pointer input before L3 is sent (readiness observed, not assumed)' 'armed:wd=false' "$t"
    cpid=$(pgrep -f -- "--user-data-dir=$LP" | head -1)
    # Nothing else may sit where L3 clicks: the display is this harness's own
    # Xvfb, and this says so before L3 rather than after it goes red.
    t=$(stack l1c 640 500)
    arm 'L1c the browser is the topmost window at the L3 click point' 'browser=yes' "${t#* }"
    [[ "${t#* }" == browser=yes ]] || sed 's/^/   /' "$TMP/stack.l1c"
    cmd=$(tr '\0' ' ' < "/proc/$cpid/cmdline" 2>/dev/null)
    arm 'L2 Chrome runs with no --remote-debugging and no --enable-automation' 'yes no' \
      "$(yn test -n "$cmd") $(yn grep -qE -- '--remote-debugging|--enable-automation' <<<"$cmd")"
    drive l3 640 500 'héllo ✓' 'typed:héllo ✓:click=true:key=true'
    arm 'L3 a click and typed text arrive as isTrusted input, non-ASCII included' '0 typed:héllo ✓:click=true:key=true' "$GOT"
    lc '{"op":"screen"}' > "$TMP/l.sc" 2>/dev/null
    jq -r .png_b64 "$TMP/l.sc" | base64 -d > "$TMP/l.png" 2>/dev/null
    arm 'L4 screen returns a PNG of the whole 1280x800 display' '89504e47 1280 800' \
      "$(head -c 4 "$TMP/l.png" | od -An -tx1 | tr -d ' \n') $(od -An -tu4 --endian=big -j16 -N8 "$TMP/l.png" | xargs)"
    lc '{"op":"hand","act":"open","reason":"test"}' >/dev/null 2>&1
    lc '{"op":"input","steps":[{"op":"type","value":"X"}]}' >/dev/null 2>"$TMP/l.h"; rc=$?
    arm 'L5 an open handoff refuses agent input (69), naming the owner' '69 yes' "$rc $(yn grep -q 'owner has this tab' "$TMP/l.h")"
    lc '{"op":"hand","act":"close"}' >/dev/null 2>&1
    lc '{"op":"input","steps":[{"op":"type","value":"!"}],"settle":300}' > "$TMP/l.in2" 2>/dev/null; rc=$?
    arm 'L5 ...and closing it gives the window back' '0 yes' "$rc $(yn grep -q 'héllo ✓!' <<<"$(jq -r .title "$TMP/l.in2")")"
    lc '{"op":"tree","url":"https://example.com/"}' >/dev/null 2>"$TMP/l.t"; rc=$?
    arm 'L6 a DOM op is refused by name (70)' '70 yes' "$rc $(yn grep -q 'INPUT mode' "$TMP/l.t")"
    # A FOREIGN WINDOW over part of Chrome, holding the keyboard focus: what an
    # agent's input meets when anything else is on the display.
    DISPLAY=":$disp" node -e '
      const x11 = require(process.argv[1]);
      (async () => {
        const x = await x11.open(process.env.DISPLAY);
        const wid = x.setup.ridBase | 0x1234, b = Buffer.alloc(32);
        b.writeUInt32LE(wid, 0); b.writeUInt32LE(x.root, 4);
        b.writeInt16LE(400, 8); b.writeInt16LE(300, 10); b.writeUInt16LE(200, 12); b.writeUInt16LE(200, 14);
        b.writeUInt16LE(0, 16); b.writeUInt16LE(1, 18); b.writeUInt32LE(0, 20);
        b.writeUInt32LE(0x2, 24); b.writeUInt32LE(0xff0000, 28);        // CWBackPixel: red
        x.req(1, 0, b, false);                                          // CreateWindow
        const m = Buffer.alloc(4); m.writeUInt32LE(wid, 0); x.req(8, 0, m, false);   // MapWindow
        await x.sync();
        for (let i = 0; i < 50 && !(await x.viewable(wid)); i++) await new Promise(r => setTimeout(r, 20));
        await x.setFocus(wid);
        process.stdout.write("up 0x" + wid.toString(16) + "\n");
        setInterval(() => {}, 1000);
      })().catch(e => { console.error(e.message); process.exit(1); });' "$X11LIB" > "$TMP/l.fw" 2>&1 &
    FW=$!; _KILL+=("$FW")
    for i in $(seq 1 100); do grep -q '^up' "$TMP/l.fw" && break; sleep 0.05; done
    fwid=$(awk '/^up/{print $2}' "$TMP/l.fw")
    # L3m — THE INSTRUMENT. L3's own check, pointed at a point the foreign
    # window covers: it must go red, and its dump must name that window as the
    # one on top. (The daemon refuses the click, so no key is sent: L9 below
    # still starts from 'héllo ✓!'.)
    drive l3m 500 400 M 'typed:héllo ✓!M:click=true:key=true' expect-red
    arm 'L3m mutation: L3 on a click point another window covers goes red, and the dump names that window on top' \
      "red top=${fwid:-?} browser=no" \
      "$([[ "$GOT" == '0 typed:héllo ✓!M:click=true:key=true' ]] && echo green || echo red) $(tail -1 "$TMP/stack.l3m" 2>/dev/null)"
    lc '{"op":"input","steps":[{"op":"click","x":500,"y":400},{"op":"type","value":"Z"}],"settle":300}' > "$TMP/l.cv" 2>"$TMP/l.cverr"; rc=$?
    arm 'L8 a click on a point another window covers fails non-zero, naming it, and the plan stops' '1 yes 1 no' \
      "$rc $(yn grep -q 'covered by a window that is not the browser' "$TMP/l.cverr") $(jq -r .steps_run "$TMP/l.cv" 2>/dev/null) $(yn grep -q 'Z' <<<"$(jq -r .title "$TMP/l.cv" 2>/dev/null)")"
    lc '{"op":"input","steps":[{"op":"type","value":"Q"}],"settle":300}' > "$TMP/l.fq" 2>/dev/null; rc=$?
    arm 'L9 keyboard focus held by another window is moved back to the browser before typing' '0 yes' \
      "$rc $(yn grep -q 'héllo ✓!Q' <<<"$(jq -r .title "$TMP/l.fq" 2>/dev/null)")"
    kill "$FW" 2>/dev/null; wait "$FW" 2>/dev/null
    lc '{"op":"shutdown"}' >/dev/null 2>&1
    for i in $(seq 1 100); do kill -0 "$LD" 2>/dev/null || break; sleep 0.05; done
    chrome_up() { pgrep -f -- "--user-data-dir=$LP" >/dev/null; }
    for i in $(seq 1 100); do chrome_up || break; sleep 0.05; done
    arm 'L7 shutdown takes the daemon and Chrome with it' 'no no' \
      "$(yn kill -0 "$LD" 2>/dev/null) $(yn chrome_up)"

    # L10 — THE CI RACE, head on: a fresh browser, and the click + text sent the
    # moment the title reads ready, with no handshake. Chrome drops input that
    # early (measured: see INPUT_QUIET_MS in the daemon); the daemon must hold
    # it until the page is quiet rather than send it into nothing with rc=0.
    LP2="$TMP/lp2"; mkdir -m 700 "$LP2"
    DISPLAY=":$disp" FIVEDIVE_BROWSER_CHROME="$REAL_CHROME" FIVEDIVE_BROWSER_CHROME_ARGS="file://$PAGE" \
      FIVEDIVE_BROWSER_INPUT_FAST=1 "$REAL_DAEMON" serve "$LP2" "$LP2/s.sock" --input > "$TMP/l2.ready" 2> "$TMP/l2.err" &
    LD2=$!; _KILL+=("$LD2")
    for i in $(seq 1 600); do grep -q '^ready' "$TMP/l2.ready" 2>/dev/null && break; kill -0 "$LD2" 2>/dev/null || break; sleep 0.05; done
    # Polled IN-PROCESS every 10ms and sent on the same tick: a `call` per poll
    # costs a node start (~50ms+), which is longer than the window Chrome drops
    # input in, and would hide the race this arm exists to hold shut.
    node -e '
      const net = require("net"), sock = process.argv[1];
      const ask = (req) => new Promise((resolve) => {
        const c = net.createConnection(sock); let buf = "", outs = [], rc = null;
        c.on("data", (d) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) >= 0) {
          const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
          if (m.t === "out") outs.push(m.data); if (m.t === "end") rc = m.rc; } });
        c.on("close", () => resolve({ rc, out: outs.join("") })); c.on("error", () => resolve({ rc: -1, out: "" }));
        c.write(JSON.stringify(req) + "\n");
      });
      (async () => {
        for (let i = 0; i < 1500; i++) {
          const r = await ask({ op: "title" });
          try { if (JSON.parse(r.out).title.startsWith("ready:")) break; } catch (e) {}
          await new Promise(r => setTimeout(r, 10));
        }
        const r = await ask({ op: "input", steps: [{ op: "click", x: 640, y: 500 }, { op: "type", value: "go" }], settle: 300 });
        process.stdout.write(r.out); process.exit(r.rc === null ? 1 : r.rc);
      })();' "$LP2/s.sock" > "$TMP/l2.in" 2>/dev/null; rc=$?
    # As L3: the input went once; wait to SEE it, never re-send it.
    t=$(jq -r .title "$TMP/l2.in" 2>/dev/null)
    (( rc == 0 )) && [[ "$t" != 'typed:go:click=true:key=true' ]] && t=$(see_title "$LP2/s.sock" 'typed:go:click=true:key=true')
    arm 'L10 a fresh page driven the instant its title appears still gets the click and the text' '0 typed:go:click=true:key=true' \
      "$rc $t"
    "$REAL_DAEMON" call "$LP2/s.sock" <<<'{"op":"shutdown"}' >/dev/null 2>&1
    for i in $(seq 1 100); do kill -0 "$LD2" 2>/dev/null || break; sleep 0.05; done
  fi
fi

printf '\n%d pass, %d fail, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
(( FAIL == 0 ))
