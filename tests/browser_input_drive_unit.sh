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
#   L  LIVE, when this machine has Xvfb and Chrome (GitHub's ubuntu runner does):
#      the real daemon, real plain Chrome, real XTEST input.
#        L1 the page sees navigator.webdriver === false
#        L2 Chrome's command line carries no --remote-debugging / --enable-automation
#        L3 a click and typed text arrive as isTrusted events, non-ASCII included
#        L4 `screen` returns a PNG of the whole display
#        L5 an open handoff refuses agent input; closing it restores it
#        L6 DOM ops are refused by name
#        L7 shutdown takes Chrome with it
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
REAL_DAEMON="$ROOT/plugins/browser/bin/session-daemon"
X11LIB="$ROOT/plugins/browser/lib/x11.cjs"
REAL_XVFB="$(command -v Xvfb || true)"
REAL_CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"

# SHORT PATHS. A unix socket path is capped at 108 bytes; a long mktemp root
# makes the daemon bind a truncated name and every arm below read "not live".
TMP="$(mktemp -d /tmp/d5287.XXXXXX)"
_KILL=()
trap 'rc=$?; for p in "${_KILL[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0; SKIP=0
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi
}
yn() { if "$@"; then echo yes; else echo no; fi; }

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
    if (req.op === 'shutdown') { end(0); srv.close(); try { fs.unlinkSync(sock); } catch (e) {} process.exit(0); }
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
  if ! grep -q '^ready' "$TMP/l.ready"; then
    arm 'L0 the live input daemon came up' ready "$(grep -v -i dbus "$TMP/l.err" | tail -2 | tr '\n' ' ')"
  else
    t=""; for i in $(seq 1 60); do t=$(lc '{"op":"title"}' 2>/dev/null | jq -r .title); [[ "$t" == ready:* ]] && break; sleep 0.25; done
    arm 'L1 the page sees navigator.webdriver === false' 'ready:wd=false' "$t"
    cpid=$(pgrep -f -- "--user-data-dir=$LP" | head -1)
    cmd=$(tr '\0' ' ' < "/proc/$cpid/cmdline" 2>/dev/null)
    arm 'L2 Chrome runs with no --remote-debugging and no --enable-automation' 'yes no' \
      "$(yn test -n "$cmd") $(yn grep -qE -- '--remote-debugging|--enable-automation' <<<"$cmd")"
    lc '{"op":"input","steps":[{"op":"click","x":640,"y":500},{"op":"type","value":"héllo ✓"}],"settle":300}' > "$TMP/l.in" 2>"$TMP/l.inerr"; rc=$?
    arm 'L3 a click and typed text arrive as isTrusted input, non-ASCII included' '0 typed:héllo ✓:click=true:key=true' \
      "$rc $(jq -r .title "$TMP/l.in" 2>/dev/null)"
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
    lc '{"op":"shutdown"}' >/dev/null 2>&1
    for i in $(seq 1 100); do kill -0 "$LD" 2>/dev/null || break; sleep 0.05; done
    chrome_up() { pgrep -f -- "--user-data-dir=$LP" >/dev/null; }
    for i in $(seq 1 100); do chrome_up || break; sleep 0.05; done
    arm 'L7 shutdown takes the daemon and Chrome with it' 'no no' \
      "$(yn kill -0 "$LD" 2>/dev/null) $(yn chrome_up)"
  fi
fi

printf '\n%d pass, %d fail, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
(( FAIL == 0 ))
