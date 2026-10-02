#!/usr/bin/env bash
# DIVE-5336 — the owner's authenticator seed: `run` types the current code at a
# 2FA prompt itself, and the seed and the code appear nowhere.
#
#   U  lib/totp.cjs, in node, no browser
#      U1 RFC 6238 appendix B vectors (SHA1, 6 digits)
#      U2 the code goes only to the seed's own host (and its subdomains)
#      U3 a seed file another uid could read is refused, and the refusal does
#         not quote it
#      U4 fill() against a fake page: no seed -> nothing typed; a page on a
#         foreign host -> nothing typed; a promo-code box is not a code box; the
#         one-time-code box gets exactly the RFC code; the result never holds it
#   B  `totp set|status|forget|import` through the real bin/browser
#      B1 set from stdin: 0600 inside the profile, normalised, never echoed
#      B2 an otpauth link with another algorithm, and garbage, are refused and
#         echoed nowhere
#      B3 an otpauth://totp link with the standard parameters is accepted
#      B4 status / forget, and status with no seed names the secret gate to file
#      B5 import is root's
#   R  `run` on a site whose probe says CHALLENGE, with a fake driver
#      R1 seed saved: the code is typed, the re-probe is authenticated, the
#         action runs and verifies, rc 0, and stderr names the field only
#      R2 no seed and no import grant: exactly the old stop (75), no fill
#      R3 typed but the challenge is still there: still the old stop (75)
#      R4 a CAPTCHA (no code field): still the old stop (75)
#      R5 no seed of its own, but the owner pasted one on the secrets link:
#         `run` imports it and clears the prompt with no human step
#   I  `sudo totp import` for real, where this machine has passwordless sudo
#      I1 the seed moves into the caller's profile 0600, and the secrets store
#         keeps every other key and loses this one
#   L  LIVE, where this machine has Chrome and playwright-core (CI installs it):
#      L1 a local site that demands a TOTP code after login: after `totp set`,
#         `run` logs in end to end with no human step and the action verifies
#      L2 the seed and every code the site accepted appear 0 times in run's
#         stdout, stderr and the profile's audit log
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
LIB="$ROOT/plugins/browser/lib/totp.cjs"

TMP="$(mktemp -d /tmp/d5336.XXXXXX)"
_KILL=()
trap 'rc=$?; for p in "${_KILL[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0; SKIP=0
# CI annotations, as browser_input_drive_unit.sh: readable without a GitHub login.
gha() {
  [[ "${GITHUB_ACTIONS:-}" == true ]] || return 0
  local m="$2"; m="${m//'%'/%25}"; m="${m//$'\r'/%0D}"; m="${m//$'\n'/%0A}"
  printf '::error title=%s::%s\n' "${1//[:,]/ }" "$m"
}
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; gha "$1" "expected: $2 got: $3"; fi
}
has() { [[ "$2" == *"$1"* ]] && echo yes || echo no; }
ex() { [[ -e "$1" ]] && echo yes || echo no; }

SEED='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'     # a test seed, nobody's account
SEED_SPACED='jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp'

# ================================================================ U  lib/totp.cjs
arm 'U1 RFC 6238 vectors' 'ok' "$(node -e '
const t=require(process.argv[1]); const s=Buffer.from("12345678901234567890");
const v=[[59,"287082"],[1111111109,"081804"],[1111111111,"050471"],[1234567890,"005924"],[2000000000,"279037"],[20000000000,"353130"]];
const bad=v.filter(([ts,w])=>t.codeAt(s,ts*1000)!==w); console.log(bad.length?JSON.stringify(bad):"ok")' "$LIB")"
arm 'U2 own host and subdomains only' 'true true false false false' "$(node -e '
const t=require(process.argv[1]);
console.log([t.hostAllowed("https://github.com/sessions/two-factor","github.com"),
 t.hostAllowed("https://accounts.google.com/x","google.com"), t.hostAllowed("https://evilgithub.com/","github.com"),
 t.hostAllowed("https://github.com.evil.io/","github.com"), t.hostAllowed("not a url","github.com")].join(" "))' "$LIB")"

P="$TMP/u-profile"; mkdir -p "$P"; chmod 700 "$P"
printf '%s\n' "$SEED" > "$P/.5dive-totp"; chmod 644 "$P/.5dive-totp"
u3="$(node -e 'const t=require(process.argv[1]); try { t.readSeed(process.argv[2]); console.log("read") } catch (e) { console.log(e.message) }' "$LIB" "$P" 2>&1)"
arm 'U3a a group/world-readable seed is refused' 'yes' "$(has 'readable by other users' "$u3")"
arm 'U3b the refusal does not quote the seed' 'no' "$(has "$SEED" "$u3")"
chmod 600 "$P/.5dive-totp"

cat > "$TMP/fakepage.cjs" <<'JS'
// Just enough of a Playwright page for fill(): inputs are {matches, attrs}.
module.exports = function fakePage(url, inputs) {
  const typed = [];
  return {
    typed, _url: url,
    url() { return this._url; },
    async goto(u) { this._url = u; },
    async waitForTimeout() {},
    locator(sel) {
      const hits = inputs.filter(i => i.matches.includes(sel));
      return { count: async () => hits.length, nth: (k) => ({
        isVisible: async () => true, isEditable: async () => true,
        getAttribute: async (a) => hits[k].attrs[a] ?? null,
        fill: async () => {}, press: async (key) => typed.push({ field: hits[k].name, key }),
        pressSequentially: async (v) => typed.push({ field: hits[k].name, value: v }),
      }) };
    },
  };
};
JS
u4="$(node -e '
const t=require(process.argv[1]); const fake=require(process.argv[2]); const prof=process.argv[3];
const now=()=>1234567890*1000+1000;   // 1 s into a window: no wait for the next one
(async () => {
  const promo={name:"promo",matches:[],attrs:{type:"text"}};
  const otp={name:"otp",matches:["input[autocomplete=\"one-time-code\"]"],attrs:{type:"text"}};
  const out={};
  const p0=fake("https://github.com/x",[otp]); out.noseed=await t.fill(p0,"/nonexistent-profile",{base:"github.com",settleMs:0,now}); out.noseedTyped=p0.typed.length;
  const p1=fake("https://evil.example/2fa",[otp]); out.foreign=await t.fill(p1,prof,{base:"github.com",settleMs:0,now}); out.foreignTyped=p1.typed.length;
  const p2=fake("https://github.com/x",[promo]); out.promo=await t.fill(p2,prof,{base:"github.com",settleMs:0,now}); out.promoTyped=p2.typed.length;
  const p3=fake("https://github.com/sessions/two-factor",[promo,otp]); out.ok=await t.fill(p3,prof,{base:"github.com",settleMs:0,now});
  out.okTyped=p3.typed; out.want=t.codeAt(t.base32Decode(process.argv[4]),now());
  console.log(JSON.stringify(out));
})()' "$LIB" "$TMP/fakepage.cjs" "$P" "$SEED")"
arm 'U4a no seed: not filled, nothing typed' 'no-seed 0' "$(jq -r '"\(.noseed.why) \(.noseedTyped)"' <<<"$u4")"
arm 'U4b a foreign host: not filled, nothing typed' 'foreign-host 0' "$(jq -r '"\(.foreign.why) \(.foreignTyped)"' <<<"$u4")"
arm 'U4c a plain promo-code box is not a code box' 'no-field 0' "$(jq -r '"\(.promo.why) \(.promoTyped)"' <<<"$u4")"
arm 'U4d the one-time-code box gets the RFC code, then Enter' 'true otp:yes otp:Enter' \
  "$(jq -r '"\(.ok.filled) \(.okTyped[0].field):\(if .okTyped[0].value == .want then "yes" else "no" end) \(.okTyped[1].field):\(.okTyped[1].key)"' <<<"$u4")"
arm 'U4e the result names the field and never holds the code' 'false' "$(jq -r '.want as $w | .ok | tostring | contains($w)' <<<"$u4")"

# ================================================================ B  the verb
SEAT="$(id -un)"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"; mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/no-rendezvous"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_TMP_ROOT="$TMP/tmproot"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"; mkdir -p "$FIVEDIVE_BROWSER_X11_DIR"
# No arm may reach the real sudo: the import rail is a stub that fails, unless an
# arm parks its own.
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/no-import"; chmod +x "$TMP/no-import"
export FIVEDIVE_BROWSER_TOTP_IMPORT="$TMP/no-import"
mkdir -p "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"; chmod 711 "$FIVEDIVE_BROWSER_PROFILE_ROOT"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
mkprof() { local d="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$1"; mkdir -p "$d"; chmod 700 "$d"; echo "$d"; }

D="$(mkprof x.test)"
out="$(printf '%s\n' "$SEED_SPACED" | "$BROWSER" totp set x.test 2>&1)"; rc=$?
arm 'B1a set from stdin exits 0' '0' "$rc"
arm 'B1b the seed file is 0600 inside the profile' '600' "$(stat -c %a "$D/.5dive-totp" 2>/dev/null)"
arm 'B1c stored normalised (upper case, no spaces)' "$SEED" "$(cat "$D/.5dive-totp" 2>/dev/null)"
arm 'B1d set never echoes the seed' 'no no' "$(has "$SEED" "$out") $(has 'jbsw' "$out")"

D2="$(mkprof y.test)"
out="$(printf 'otpauth://totp/Y:me?secret=%s&algorithm=SHA256&digits=6\n' "$SEED" | "$BROWSER" totp set y.test 2>&1)"; rc=$?
arm 'B2a an otpauth link with SHA256 is refused (64) and not saved' '64 no' "$rc $(ex "$D2/.5dive-totp")"
arm 'B2b ...and the refusal does not echo it' 'no' "$(has "$SEED" "$out")"
out="$(printf 'hunter2-not-a-seed\n' | "$BROWSER" totp set y.test 2>&1)"; rc=$?
arm 'B2c garbage is refused (64), not echoed, not saved' '64 no no' "$rc $(has hunter2 "$out") $(ex "$D2/.5dive-totp")"
out="$(printf 'otpauth://totp/Y:me?issuer=Y&secret=%s&period=30\n' "$SEED" | "$BROWSER" totp set y.test 2>&1)"; rc=$?
arm 'B3 an otpauth://totp link with standard parameters is accepted' "0 $SEED" "$rc $(cat "$D2/.5dive-totp" 2>/dev/null)"

out="$("$BROWSER" totp status x.test 2>&1)"
arm 'B4a status: saved, and no seed in the line' 'yes no' "$(has 'seed is saved' "$out") $(has "$SEED" "$out")"
"$BROWSER" totp forget x.test >/dev/null 2>&1
arm 'B4b forget removes it' 'no' "$(ex "$D/.5dive-totp")"
out="$("$BROWSER" totp status x.test 2>&1)"
arm 'B4c status with no seed names the secret gate that saves one' 'yes yes' \
  "$(has 'no authenticator seed saved' "$out") $(has '--secret-key=TOTP_X_TEST --connector=browser-totp' "$out")"
out="$("$BROWSER" totp import x.test 2>&1)"; rc=$?
if [[ $EUID -ne 0 ]]; then arm "B5 import is root's (77)" '77' "$rc"; else SKIP=$((SKIP+1)); echo 'SKIP: B5 running as root'; fi

# ================================================================ R  run
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
# The fake Chrome serves the profile's challenge page until the fake driver has
# "typed a code" (.fake-cleared), then the logged-in feed.
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
[[ "${1:-}" == --version ]] && { echo 'Google Chrome 153.0.8010.36'; exit 0; }
d=""; for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#*=}" ;; esac; done
[[ "$*" == *--dump-dom* ]] || exit 0
if [[ -n "$d" && -f "$d/.fake-cleared" ]]; then echo '<html><body><div id="feed">posts</div></body></html>'
else cat "$d/.fake-challenge" 2>/dev/null; fi
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

TWOFA_DOM='<html><body><h1>Two-factor authentication</h1><form action="/sessions/two-factor"><input autocomplete="one-time-code" name="app_otp"></form></body></html>'
CAPTCHA_DOM='<html><body><div class="g-recaptcha"></div></body></html>'
# The fake driver: a `totp` plan answers as the real one does (a field, never a
# code) and — unless FAKE_CLEARS=0 — clears the challenge; a step plan publishes.
cat > "$TMP/driver" <<DRV
#!/usr/bin/env bash
plan="\$(cat)"
mode="\$(jq -r '.mode // "steps"' <<<"\$plan")"
echo "\$mode" >> "\$FIVEDIVE_BROWSER_PROFILE/.fake-driver-calls"
if [[ "\$mode" == totp ]]; then
  [[ -f "\$FIVEDIVE_BROWSER_PROFILE/.5dive-totp" ]] || { echo '{"filled":false,"why":"no-seed"}'; exit 0; }
  [[ "\${FAKE_FIELD:-1}" == 1 ]] || { echo '{"filled":false,"why":"no-field"}'; exit 0; }
  [[ "\${FAKE_CLEARS:-1}" == 1 ]] && touch "\$FIVEDIVE_BROWSER_PROFILE/.fake-cleared"
  echo '{"filled":true,"field":"input[autocomplete=\"one-time-code\"]","url":"https://r.test/feed"}'
  exit 0
fi
echo PUBLISHED > "$TMP/artifact.html"
exit 0
DRV
chmod +x "$TMP/driver"; export FIVEDIVE_BROWSER_DRIVER="$TMP/driver"
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/r.test.json" <<JSON
{ "site": "r.test",
  "probe": { "url": "https://r.test/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"https://r.test/compose"}, {"op":"click","selector":"#pub"} ],
      "verify": { "url": "file://$TMP/artifact.html", "expect": "PUBLISHED" } } } }
JSON
rprof() {  # rprof <challenge-dom> [seed]
  rm -rf "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/r.test" "$TMP/artifact.html"
  local d; d="$(mkprof r.test)"; printf '%s' "$1" > "$d/.fake-challenge"
  [[ -n "${2:-}" ]] && { printf '%s\n' "$2" > "$d/.5dive-totp"; chmod 600 "$d/.5dive-totp"; }
  echo "$d"
}

D="$(rprof "$TWOFA_DOM" "$SEED")"
out="$("$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R1a seed saved: run clears the 2FA prompt and publishes (rc 0)' '0' "$rc"
[[ "$rc" == 0 ]] || gha 'R1 run output' "$out"
arm 'R1b the driver was asked for a totp fill, then the steps' 'totp steps' "$(tr '\n' ' ' < "$D/.fake-driver-calls" 2>/dev/null | sed 's/ $//')"
arm 'R1c stderr says a code was typed and names the field' 'yes yes' "$(has 'typed the owner' "$out") $(has 'one-time-code' "$out")"
arm 'R1d the seed is nowhere in the output' 'no' "$(has "$SEED" "$out")"
arm 'R1e the fill is in the audit log, by field' 'yes' "$(grep -q '"event":"totp-fill"' "$D/.5dive-audit.jsonl" 2>/dev/null && echo yes || echo no)"

D="$(rprof "$TWOFA_DOM")"
out="$("$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R2a no seed, no import: the old stop (75)' '75' "$rc"
arm 'R2b ...with the old words, and no driver call at all' 'yes no' "$(has 'presenting a security challenge' "$out") $(ex "$D/.fake-driver-calls")"

D="$(rprof "$TWOFA_DOM" "$SEED")"
out="$(FAKE_CLEARS=0 "$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R3 typed, but the re-probe is still a challenge: the old stop (75), nothing published' '75 no' "$rc $(ex "$TMP/artifact.html")"

D="$(rprof "$CAPTCHA_DOM" "$SEED")"
out="$(FAKE_FIELD=0 "$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R4 a CAPTCHA has no code field: the old stop (75)' '75 yes no' "$rc $(has 'presenting a security challenge' "$out") $(ex "$TMP/artifact.html")"

D="$(rprof "$TWOFA_DOM")"
cat > "$TMP/import-stub" <<STUB
#!/usr/bin/env bash
# What root's import does, minus root: the store's seed -> \`totp set\` as the owner.
echo "\$*" > "$TMP/import-args"
printf '%s\n' "$SEED" | "$BROWSER" totp set "\$1" >/dev/null
STUB
chmod +x "$TMP/import-stub"
out="$(FIVEDIVE_BROWSER_TOTP_IMPORT="$TMP/import-stub" "$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R5a no seed of its own: run imports the pasted one and publishes (rc 0)' '0' "$rc"
arm 'R5b the import was asked for this site, quietly' 'r.test --quiet' "$(cat "$TMP/import-args" 2>/dev/null)"
arm 'R5c the seed is nowhere in the output' 'no' "$(has "$SEED" "$out")"

# The real rail, against a fake sudo: a seat WITHOUT the grant must never run the
# import through sudo — a refused `sudo -n` mails root (DIVE-4397). Only the
# password-free `-l` probe of the exact command may be asked.
mkdir -p "$TMP/sudobin"
cat > "$TMP/sudobin/sudo" <<FAKESUDO
#!/usr/bin/env bash
echo "\$*" >> "$TMP/sudo-log"
if [[ "\$2" == -l ]]; then exit "\${FAKE_GRANT_RC:-1}"; fi
[[ "\${FAKE_GRANT_RC:-1}" == 0 ]] || exit 1
shift; printf '%s\n' "$SEED" | "$BROWSER" totp set "\$5" >/dev/null
FAKESUDO
chmod +x "$TMP/sudobin/sudo"
D="$(rprof "$TWOFA_DOM")"; rm -f "$TMP/sudo-log"
out="$(env -u FIVEDIVE_BROWSER_TOTP_IMPORT PATH="$TMP/sudobin:$PATH" "$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R6a no grant: sudo was asked only the -l probe, never the import' '1 0' \
  "$(grep -c -- '^-n -l /usr/local/bin/5dive browser totp import r.test --quiet$' "$TMP/sudo-log" 2>/dev/null) $(grep -vc -- '^-n -l ' "$TMP/sudo-log" 2>/dev/null)"
arm 'R6b no grant, no seed: the old stop (75), nothing published' '75 no' "$rc $(ex "$TMP/artifact.html")"
D="$(rprof "$TWOFA_DOM")"; rm -f "$TMP/sudo-log"
out="$(FAKE_GRANT_RC=0 env -u FIVEDIVE_BROWSER_TOTP_IMPORT PATH="$TMP/sudobin:$PATH" "$BROWSER" run r.test publish 2>&1)"; rc=$?
arm 'R6c with the grant: probe, then the import through sudo, then publish (rc 0)' '0 -n /usr/local/bin/5dive browser totp import r.test --quiet' \
  "$rc $(grep -v -- '^-n -l ' "$TMP/sudo-log" 2>/dev/null | head -1)"

# ================================================================ I  root import
if [[ $EUID -ne 0 ]] && sudo -n true 2>/dev/null; then
  D="$(mkprof i.test)"
  CON="$TMP/connectors"; sudo mkdir -p "$CON"
  printf 'OTHER_KEY=keep-me\nTOTP_I_TEST=%s\n' "$SEED" | sudo tee "$CON/browser-totp.env" >/dev/null
  sudo chmod 600 "$CON/browser-totp.env"
  out="$(sudo env SUDO_USER="$SEAT" FIVEDIVE_BROWSER_CONNECTORS_DIR="$CON" FIVEDIVE_BROWSER_PROFILE_ROOT="$FIVEDIVE_BROWSER_PROFILE_ROOT" \
          FIVEDIVE_BROWSER_SESSION_ROOT="$FIVEDIVE_BROWSER_SESSION_ROOT" FIVEDIVE_BROWSER_TMP_ROOT="$FIVEDIVE_BROWSER_TMP_ROOT" \
          PATH="$PATH" "$BROWSER" totp import i.test 2>&1)"; rc=$?
  arm 'I1a import exits 0' '0' "$rc"
  [[ "$rc" == 0 ]] || gha 'I1 import output' "$out"
  arm "I1b the seed is in the caller's profile, 0600, owned by the caller" "600 $SEAT $SEED" \
    "$(stat -c '%a %U' "$D/.5dive-totp" 2>/dev/null) $(cat "$D/.5dive-totp" 2>/dev/null)"
  arm 'I1c the store lost this key and kept the other' 'OTHER_KEY=keep-me' "$(sudo cat "$CON/browser-totp.env")"
  arm 'I1d import never echoes the seed' 'no' "$(has "$SEED" "$out")"
  sudo rm -rf "$CON"
else
  SKIP=$((SKIP+1)); echo 'SKIP: I root import — no passwordless sudo here (CI has it)'
fi

# ================================================================ L  LIVE
NOFAKE="${PATH#"$FAKEBIN:"}"
REAL_CHROME="$(PATH="$NOFAKE" command -v google-chrome || PATH="$NOFAKE" command -v chromium || true)"
PW_OK=no; [[ -d "$ROOT/plugins/browser/node_modules/playwright-core" ]] && PW_OK=yes
if [[ -z "$REAL_CHROME" || "$PW_OK" != yes ]]; then
  SKIP=$((SKIP+1)); printf 'SKIP: L live arms — chrome: %s, playwright-core next to the plugin: %s\n' "${REAL_CHROME:-none}" "$PW_OK"
else
  # A site that already has the password (the "half-logged-in" state a 2FA
  # re-prompt is) and demands an authenticator code before anything else. It
  # checks codes with ITS OWN HMAC, not lib/totp.cjs, and records the codes it
  # accepted so L2 can look for them.
  cat > "$TMP/site.cjs" <<'JS'
const http = require('http'), crypto = require('crypto'), fs = require('fs');
const [seedB32, logf] = process.argv.slice(2);
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const b = [];
for (const c of seedB32) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { b.push((val >>> (bits - 8)) & 255); bits -= 8; } }
const key = Buffer.from(b);
const code = (t) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', key).update(m).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };
let published = 0;
http.createServer((req, res) => {
  const authed = /sid=ok/.test(req.headers.cookie || '');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/artifact') { res.end(published ? 'PUBLISHED-' + published : 'nothing yet'); return; }
  if (u.pathname === '/two-factor' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const got = new URLSearchParams(body).get('otp') || '';
      const now = Date.now(); const ok = [now - 30000, now, now + 30000].some(t => code(t) === got);
      if (ok) fs.appendFileSync(logf, got + '\n');
      res.writeHead(302, ok ? { 'set-cookie': 'sid=ok; Path=/; Max-Age=3600', location: '/' } : { location: '/two-factor?bad=1' }); res.end(); });
    return;
  }
  if (!authed) {
    if (u.pathname !== '/two-factor') { res.writeHead(302, { location: '/two-factor' }); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><h1>Two-factor authentication</h1><form method="post" action="/two-factor">' +
      '<input type="text" name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><button>Verify</button></form></body></html>');
    return;
  }
  if (u.pathname === '/publish' && req.method === 'POST') { published++; res.writeHead(302, { location: '/' }); res.end(); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<html><body><div id="feed">signed in</div><form method="post" action="/publish"><button id="pub">Publish</button></form></body></html>');
}).listen(0, 'localhost', function () { console.log(this.address().port); });
JS
  node "$TMP/site.cjs" "$SEED" "$TMP/accepted" > "$TMP/port" & _KILL+=($!)
  for _ in $(seq 50); do [[ -s "$TMP/port" ]] && break; sleep 0.1; done
  PORT="$(cat "$TMP/port")"
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/localhost.json" <<JSON
{ "site": "localhost",
  "probe": { "url": "http://localhost:$PORT/", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"http://localhost:$PORT/"}, {"op":"click","selector":"#pub"} ],
      "verify": { "url": "http://localhost:$PORT/artifact", "expect": "PUBLISHED-1" } } } }
JSON
  D="$(mkprof localhost)"
  printf '%s\n' "$SEED" | "$BROWSER" totp set localhost >/dev/null 2>&1
  out="$(PATH="$NOFAKE" env -u FIVEDIVE_BROWSER_DRIVER "$BROWSER" run localhost publish 2>&1)"; rc=$?
  arm 'L1a a TOTP-gated site: run logs in and publishes with no human step (rc 0)' '0' "$rc"
  [[ "$rc" == 0 ]] || gha 'L1 run output' "$out"
  arm 'L1b the site accepted a code' 'yes' "$([[ -s "$TMP/accepted" ]] && echo yes || echo no)"
  arm 'L1c the out-of-band artifact says published once' 'PUBLISHED-1' "$(curl -s "http://localhost:$PORT/artifact")"
  leaks=0
  for needle in "$SEED" $(cat "$TMP/accepted" 2>/dev/null); do
    [[ "$out" == *"$needle"* ]] && leaks=$((leaks+1))
    grep -qF -- "$needle" "$D/.5dive-audit.jsonl" 2>/dev/null && leaks=$((leaks+1))
  done
  arm 'L2 seed and accepted codes: 0 occurrences in output and audit log' '0' "$leaks"
fi

printf '\n%d pass, %d fail, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
(( FAIL == 0 ))
