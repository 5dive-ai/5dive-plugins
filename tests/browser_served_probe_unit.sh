#!/usr/bin/env bash
# DIVE-5388 — the Connected-sites panel says what a person reading the page would say.
#
# Measured on chill-gorge (2026-10-02): reddit.com and openalternative.co read
# `challenge` ("Needs you") while their served browsers were signed in — Reddit's
# "prove your humanity" and Cloudflare Turnstile meet the HEADLESS probe, not the
# real Chrome the session lives in; probe-all skipped every served profile, so the
# stamps aged for a day; and 7 of 13 connected sites had no adapter, so no check.
#
# Driven through the real bin/browser, with a FAKE google-chrome (prints the
# profile's .fake-dom) and a FAKE session daemon (answers probe / title /
# title_probe from files; the client half is the REAL daemon's `call`).
#
#   S  served sites are checked through the browser that holds them
#   C  a bot check that meets the headless probe is not "Needs you"
#   G  the generic check for a site with no adapter
#   I  input mode: the probe page's title, in a tab of its own, only when nobody drives
#   L  lib/generic-login.cjs on its own
#
# NEGATIVE CONTROL: FIVEDIVE_TEST_BROWSER=<1.29.2 bin/browser> turns S1, C1, G1,
# G2 and I1 red (it skips served profiles, stamps `challenge` and `unknown`).
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="${FIVEDIVE_TEST_BROWSER:-$ROOT/plugins/browser/bin/browser}"
REAL_DAEMON="$ROOT/plugins/browser/bin/session-daemon"
GL="$ROOT/plugins/browser/lib/generic-login.cjs"

TMP="$(mktemp -d)"
_KILL=()
trap 'rc=$?; for p in "${_KILL[@]}"; do kill -KILL "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi
}
yn() { if "$@"; then echo yes; else echo no; fi; }

export FIVEDIVE_BROWSER_TMP_ROOT="$TMP/tmproot"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"; mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/rv"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/fake-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"; mkdir -p "$FIVEDIVE_BROWSER_X11_DIR"
SEAT="$(id -un)"
mkdir -p "$TMP/profiles/$SEAT" "$TMP/rv/$SEAT"; chmod 711 "$TMP/profiles"; chmod 700 "$TMP/profiles/$SEAT"

# --- the fake chrome: the profile's .fake-dom, one-shot, headless -------------
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
[[ "${1:-}" == --version ]] && { echo 'Google Chrome 153.0.8010.36'; exit 0; }
ud=""; last=""
for a in "$@"; do case "$a" in --user-data-dir=*) ud="${a#*=}" ;; esac; last="$a"; done
echo "$last" >> "${URLLOG:-/dev/null}"
[[ "$last" == about:blank ]] && { echo '<html></html>'; exit 0; }
cat "${ud%/}/.fake-dom" 2>/dev/null
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"
export URLLOG="$TMP/urls.log"

# --- the fake daemon: serve answers from <profile>/.fake-*; call is the real one -
DREC="$TMP/daemon.rec"; : > "$DREC"
cat > "$TMP/fake-daemon" <<DAEMON
#!/usr/bin/env node
'use strict';
const fs = require('fs'), net = require('net'), path = require('path');
const [, , mode, a1, a2] = process.argv;
if (mode === 'call') { const r = require('child_process').spawnSync('$REAL_DAEMON', ['call', a1], { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status); }
// listen <profile> <sock> [input]
const profile = a1, sock = a2, input = process.argv[5] === 'input';
const rd = (f, d) => { try { return fs.readFileSync(path.join(profile, f), 'utf8'); } catch (e) { return d; } };
const srv = net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl));
    fs.appendFileSync('$DREC', JSON.stringify({ site: path.basename(profile), ...req }) + '\n');
    const send = (o) => c.write(JSON.stringify(o) + '\n');
    const end = (rc) => { send({ t: 'end', rc }); c.end(); };
    const out = (o) => send({ t: 'out', data: JSON.stringify(o) + '\n' });
    if (req.op === 'ping') { send({ t: 'out', data: 'pong\n' }); return end(0); }
    if (!input && req.op === 'probe') {
      const furl = rd('.fake-final-url', '');
      if (req.report_url && furl) send({ t: 'log', line: '5dive-probe-final-url: ' + furl.trim() });
      send({ t: 'out', data: rd('.fake-served-dom', '<html></html>') + '\n' }); return end(0);
    }
    if (input && req.op === 'title') {
      out({ drive: 'input', title: rd('.fake-title-now', 'Whatever Was Left'), handoff: rd('.fake-handoff', '') === '1', viewer: rd('.fake-viewer', '') === '1' });
      return end(0);
    }
    if (input && req.op === 'title_probe' && rd('.fake-old-daemon', '') !== '1') {
      out({ drive: 'input', navigated: true, url_requested: req.url, title: rd('.fake-title', '') }); return end(0);
    }
    send({ t: 'err', msg: "unknown op '" + req.op + "'" }); end(70);
  });
});
try { fs.unlinkSync(sock); } catch (e) {}
srv.listen(sock, () => process.stdout.write('ready\n'));
DAEMON
chmod +x "$TMP/fake-daemon"

mkprofile() {  # mkprofile <site> <dom>
  local d="$TMP/profiles/$SEAT/$1"
  mkdir -p "$d"; chmod 700 "$d"; printf '%s' "$2" > "$d/.fake-dom"; echo "$d"
}
# serve_fake <site> [input] — a serve record naming a live display and a live
# daemon listening on the profile's socket. No Xvfb, no Chrome: only what
# _serve_running and _daemon_live read.
serve_fake() {
  local d="$TMP/profiles/$SEAT/$1" mode="${2:-}"
  sleep 600 & local xp=$!; _KILL+=("$xp")
  "$TMP/fake-daemon" listen "$d" "$d/.5dive-session.sock" "$mode" > "$TMP/d.$1.out" 2>&1 & local dp=$!; _KILL+=("$dp")
  for _ in $(seq 50); do [[ -S "$d/.5dive-session.sock" ]] && break; sleep 0.1; done
  ( umask 077; printf 'display=150\nxvfb_pid=%s\ndaemon_pid=%s\nsock=%s\nstarted_at=%s\n%s' \
      "$xp" "$dp" "$d/.5dive-session.sock" "$(date -u +%s)" "${mode:+drive=input
}" > "$d/.5dive-serve" )
}
stamp() { cut -d' ' -f2- "$TMP/profiles/$SEAT/$1/.5dive-liveness" 2>/dev/null || echo none; }
stampdate() { cut -d' ' -f1 "$TMP/profiles/$SEAT/$1/.5dive-liveness" 2>/dev/null || echo none; }
seen() { cat "$TMP/profiles/$SEAT/$1/.5dive-signed-in" 2>/dev/null || echo none; }
reqs() { jq -r -s --arg op "$1" --arg s "$2" '[.[] | select(.op==$op and .site==$s)] | length' "$DREC"; }

CHAL_DOM='<html><head><title>Just a moment...</title></head><body><div class="cf-challenge">Verify you are human</div></body></html>'
FEED='<html><body><header><nav><a href="/">Home</a><a href="/me" aria-label="Your profile">me</a></nav></header><main>feed</main></body></html>'
SIGNEDOUT='<html><body><header><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav><a class="btn" href="/login">Log in</a><a href="/signup">Sign up</a></header><main>welcome</main></body></html>'

# ------------------------------------------------------------- S: served sites
# An adapter (reddit-shaped: a /login/ probe url and a username-field marker).
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/srv.test.json" <<'J'
{"probe":{"url":"https://srv.test/login/","logged_out_when_dom_matches":"name=[\"']?username","challenge_when_dom_matches":"(cf-challenge|prove your humanity)"}}
J
mkprofile srv.test "$CHAL_DOM" >/dev/null
printf '%s' '<html><body><div id="feed">posts</div></body></html>' > "$TMP/profiles/$SEAT/srv.test/.fake-served-dom"
serve_fake srv.test
: > "$URLLOG"
out=$("$BROWSER" probe-all 2>&1); rc=$?
arm 'S1 probe-all on a served profile with a session daemon stamps it (not "skipped: served")' authenticated "$(stamp srv.test)"
arm 'S1 ...through that browser: the daemon was asked to probe' 1 "$(reqs probe srv.test)"
arm 'S1 ...and no second Chrome was launched at the held profile' no "$(yn grep -q 'srv.test' "$URLLOG")"
arm 'S1 ...and the sweep exits 0' 0 "$rc"
arm 'S2 a signed-in read in the served browser is remembered, through what' served "$(seen srv.test | cut -d' ' -f2)"
arm 'S3 the warm probe asks the daemon where the page landed' true "$(jq -r -s '[.[] | select(.op=="probe")] | last | .report_url' "$DREC")"

# ------------------------------------------------- C: the check's own bot check
# Stop the serve: the next probe is the cold headless one, which meets the check.
SEENAT=$(seen srv.test | cut -d' ' -f1)
rm -f "$TMP/profiles/$SEAT/srv.test/.5dive-serve"
out=$("$BROWSER" status srv.test 2>&1); rc=$?
arm 'C1 a headless challenge on a login last read signed in when served -> unverifiable, never challenge' unverifiable "$(stamp srv.test)"
arm 'C1 ...dated by the last signed-in read, which is what the tile shows' "$SEENAT" "$(stampdate srv.test)"
arm 'C1 ...quiet: it does not ask a person (rc 0)' 0 "$rc"
arm 'C1 ...and says why' yes "$(yn grep -q 'met a bot check' <<<"$out")"
arm 'C1 ...and keeps the signed-in record' served "$(seen srv.test | cut -d' ' -f2)"

# A challenge in the SERVED browser is the real thing.
printf '%s' "$CHAL_DOM" > "$TMP/profiles/$SEAT/srv.test/.fake-served-dom"
serve_fake srv.test
out=$("$BROWSER" status srv.test 2>&1); rc=$?
arm 'C2 a challenge seen in the served browser itself -> challenge (Needs you)' challenge "$(stamp srv.test)"
arm 'C2 ...exits cold' 75 "$rc"
arm 'C2 ...and forgets the signed-in read, so the next headless one is not excused' none "$(seen srv.test)"
rm -f "$TMP/profiles/$SEAT/srv.test/.5dive-serve"
"$BROWSER" status srv.test >/dev/null 2>&1
arm 'C3 a headless challenge with no served signed-in read stays challenge' challenge "$(stamp srv.test)"

# A HEADLESS signed-in read does not excuse a headless challenge: only the
# owner's own browser can say the check was about the probe.
mkprofile hl.test '<html><body><div id="feed">posts</div></body></html>' >/dev/null
cp "$FIVEDIVE_BROWSER_ADAPTER_DIR/srv.test.json" "$FIVEDIVE_BROWSER_ADAPTER_DIR/hl.test.json"
"$BROWSER" status hl.test >/dev/null 2>&1
arm 'C4 a headless signed-in read is remembered as headless' headless "$(seen hl.test | cut -d' ' -f2)"
printf '%s' "$CHAL_DOM" > "$TMP/profiles/$SEAT/hl.test/.fake-dom"
"$BROWSER" status hl.test >/dev/null 2>&1
arm 'C4 ...and a later headless challenge is still challenge' challenge "$(stamp hl.test)"

# -------------------------------------------------- G: no adapter, generic check
mkprofile gout.test "$SIGNEDOUT" >/dev/null
mkprofile gin.test "$FEED" >/dev/null
mkprofile gnone.test '<html><body><div id="root"></div></body></html>' >/dev/null
mkprofile gchal.test "$CHAL_DOM<header><nav><a href=/>Home</a></nav></header>" >/dev/null
mkprofile gpw.test '<html><body><form action="/x"><input type="password" name="p"></form></body></html>' >/dev/null
out=$("$BROWSER" status gout.test 2>&1); rc=$?
arm 'G1 no adapter, a "Log in" control in the header -> expired' expired "$(stamp gout.test)"
arm 'G1 ...exits cold and names the generic check' "75 yes" "$rc $(yn grep -q 'generic check' <<<"$out")"
out=$("$BROWSER" status gin.test 2>&1); rc=$?
arm 'G2 no adapter, a header with controls and no sign-in -> authenticated' authenticated "$(stamp gin.test)"
arm 'G2 ...saying it was the generic check' yes "$(yn grep -q 'authenticated (generic check' <<<"$out")"
"$BROWSER" status gnone.test >/dev/null 2>&1
arm 'G3 no adapter, nothing decidable (no header) -> unknown, never certified' unknown "$(stamp gnone.test)"
"$BROWSER" status gchal.test >/dev/null 2>&1
arm 'G4 a Turnstile page is challenge, never authenticated (its header has no sign-in)' challenge "$(stamp gchal.test)"
"$BROWSER" status gpw.test >/dev/null 2>&1
arm 'G5 a password form with no header -> expired' expired "$(stamp gpw.test)"
# Served, no adapter, and the page landed on a sign-in path.
mkprofile gredir.test "$FEED" >/dev/null
printf '%s' "$FEED" > "$TMP/profiles/$SEAT/gredir.test/.fake-served-dom"
printf 'https://gredir.test/login?next=%%2F' > "$TMP/profiles/$SEAT/gredir.test/.fake-final-url"
serve_fake gredir.test
"$BROWSER" status gredir.test >/dev/null 2>&1
arm 'G6 served, no adapter, the page redirected to /login -> expired' expired "$(stamp gredir.test)"
# The page verbs' gate keeps its narrower reading: a header "Log in" is not its refusal.
arm 'G7 a header-only sign-in does not change the page gate (it has no password form)' \
  'no' "$(yn grep -q 'type=.password' <<<"$SIGNEDOUT")"

# --------------------------------------------- I: input mode, a title in a new tab
mkinput() {  # mkinput <site> <title>
  mkprofile "$1" '<html></html>' >/dev/null
  printf '%s' "$2" > "$TMP/profiles/$SEAT/$1/.fake-title"
  serve_fake "$1" input
}
mkinput iout.test 'Log in to Iout'
out=$("$BROWSER" status iout.test 2>&1); rc=$?
arm 'I1 input served, the probe page loads titled "Log in to …" -> expired' expired "$(stamp iout.test)"
arm 'I1 ...asked the daemon for a title_probe of the probe url' 'https://iout.test/' \
  "$(jq -r -s '[.[] | select(.op=="title_probe" and .site=="iout.test")] | last | .url' "$DREC")"
arm 'I1 ...exits cold' 75 "$rc"
mkinput ichal.test 'Just a moment...'
"$BROWSER" status ichal.test >/dev/null 2>&1; rc=$?
arm 'I2 a challenge title in the owner'"'"'s own browser -> challenge (Needs you)' "challenge 75" "$(stamp ichal.test) $rc"
mkinput iun.test 'Iun - Home'
"$BROWSER" status iun.test >/dev/null 2>&1; rc=$?
arm 'I3 an undecidable title, never seen signed in -> unknown, rc 0' "unknown 0" "$(stamp iun.test) $rc"
printf '2026-10-02T06:43:00Z served\n' > "$TMP/profiles/$SEAT/iun.test/.5dive-signed-in"
out=$("$BROWSER" status iun.test 2>&1); rc=$?
arm 'I4 an undecidable title, last seen signed in -> unverifiable dated by that read' \
  "unverifiable 2026-10-02T06:43:00Z 0" "$(stamp iun.test) $(stampdate iun.test) $rc"
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/iin.test.json" <<'J'
{"probe":{"url":"https://iin.test/settings","logged_in_when_title_matches":"^Settings"}}
J
mkinput iin.test 'Settings · Iin'
"$BROWSER" status iin.test >/dev/null 2>&1
arm 'I5 an adapter'"'"'s signed-in title -> authenticated, remembered as input' "authenticated input" \
  "$(stamp iin.test) $(seen iin.test | cut -d' ' -f2)"
# A /login/ probe url: the generic sign-in title is NOT used (a signed-in visitor sees those words too).
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/ilogin.test.json" <<'J'
{"probe":{"url":"https://ilogin.test/login/","logged_out_when_dom_matches":"name=username"}}
J
mkinput ilogin.test 'Log In | Ilogin'
"$BROWSER" status ilogin.test >/dev/null 2>&1
arm 'I6 a probe url that is itself a sign-in page: its title is not read as signed out' unknown "$(stamp ilogin.test)"

# Nobody's window is moved: viewer, handoff, a lease, or an old daemon.
for why in viewer handoff; do
  s="i$why.test"; mkinput "$s" 'Log in to X'
  printf 'authenticated-from-before' > "$TMP/profiles/$SEAT/$s/.5dive-liveness"
  printf '1' > "$TMP/profiles/$SEAT/$s/.fake-$why"
  out=$("$BROWSER" status "$s" 2>&1); rc=$?
  arm "I7 a $why in progress: no title_probe is sent" 0 "$(reqs title_probe "$s")"
  arm "I7 ...the last verdict stands, and it says why it did not look" "authenticated-from-before yes 0" \
    "$(cat "$TMP/profiles/$SEAT/$s/.5dive-liveness") $(yn grep -q 'not checked now' <<<"$out") $rc"
done
mkinput ilease.test 'Log in to X'
printf 'authenticated-from-before' > "$TMP/profiles/$SEAT/ilease.test/.5dive-liveness"
sleep 600 & LP=$!; _KILL+=("$LP")
mkdir -p "$TMP/profiles/$SEAT/ilease.test/.5dive-lease"
printf 'token=abc\nholder_pid=%s\nexpires_at=%s\nkind=agent\npurpose=x\n' "$LP" "$(( $(date -u +%s) + 600 ))" \
  > "$TMP/profiles/$SEAT/ilease.test/.5dive-lease/meta"
"$BROWSER" status ilease.test >/dev/null 2>&1
arm 'I8 an agent holding the lease: no title_probe, the stamp stands' "0 authenticated-from-before" \
  "$(reqs title_probe ilease.test) $(cat "$TMP/profiles/$SEAT/ilease.test/.5dive-liveness")"
mkinput iold.test 'Log in to X'
printf '1' > "$TMP/profiles/$SEAT/iold.test/.fake-old-daemon"
out=$("$BROWSER" status iold.test 2>&1); rc=$?
arm 'I9 a daemon from before title_probe: unconfirmed, nothing stamped, rc 0' "none 0" "$(stamp iold.test) $rc"
# probe-all reaches input-served profiles too.
rm -f "$TMP/profiles/$SEAT/iout.test/.5dive-liveness"
"$BROWSER" probe-all >/dev/null 2>&1
arm 'I10 probe-all stamps an input-served profile' expired "$(stamp iout.test)"

# ------------------------------------------------------- L: the classifier alone
gl() { printf '%s' "$1" > "$TMP/gl.html"; node "$GL" "$TMP/gl.html" | head -1; }
arm 'L1 "Log in" in a script string is not a control' in \
  "$(gl '<script>var h="<header><a>Log in</a></header>"</script><header><a href=/>Home</a></header>')"
arm 'L2 a hidden sign-in control is not read' in "$(gl '<header><a href=/>Home</a><a hidden>Sign in</a><button style="display:none">Log in</button></header>')"
arm 'L3 "Sign up for our newsletter" is not a sign-in control' in "$(gl '<header><a href=/>Home</a><a>Sign up for our newsletter</a></header>')"
arm 'L4 "Log out" is not a sign-in control' in "$(gl '<nav><button>Log out</button></nav>')"
arm 'L5 an icon button named by aria-label' out "$(gl '<header><a href=/x aria-label="Sign in"><svg></svg></a></header>')"
arm 'L6 role=banner with a role=button "登录 | 注册" (juejin.cn)' out "$(gl '<div role="banner"><div role="button">登录 | 注册</div></div>')"
arm 'L7 a "Log in" outside any header is not decidable by itself' none "$(gl '<main><a>Log in</a></main>')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
