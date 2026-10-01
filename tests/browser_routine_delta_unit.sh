#!/usr/bin/env bash
# DIVE-5335 — routines (act --record, replay) and delta snapshots.
#
# Driven through the REAL bin/browser and the REAL driver-playwright, with the
# same recording playwright-core stub browser_plugin_unit.sh uses (extracted from
# that file at run time, so the two suites cannot grade two different stubs) and
# a fake google-chrome. No Chrome, no network: the live numbers are
# tests/browser_routine_bench.sh, a separate CI job.
#
#   R1  act --record keeps the steps and NEVER the typed value (a numbered slot)
#   R2  replay runs every step from the cache: no snapshot walk, the supplied
#       value reaches the field, 0 model calls; the wrong number of values is 64
#   R3  self-heal: a renamed button is re-picked, the routine is rewritten, and
#       the next replay finds it at once (re-pick count 0)
#   R4  a miss nothing can re-pick stops the replay, names the act and the
#       re-record command, and leaves the routine as it was
#   R5  an act that failed is not recorded; routine ls/show/forget --from
#   R6  input mode refuses --record by name; --help and the skill document both
#   D1  lib/delta.cjs: the PNG decoder round-trips all five filter types,
#       pixelChange measures the share that moved, multiset text, fallback
#   D2  snapshot --delta through bin/browser: the first is full and says why,
#       the second prints only the change, drops an unchanged page.png, and
#       --json carries the delta and not the node list
#   M*  mutants: value stripping removed, write-back removed, baseline frozen
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2

TMP="$(mktemp -d)"
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
PASS=0; FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"; else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"; else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"; else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
run() { local o="$TMP/.o" e="$TMP/.e"; "$@" >"$o" 2>"$e"; RC=$?; OUT=$(cat "$o"); ERR=$(cat "$e"); return 0; }
# A mutant is a whole copy of the plugin with bin/browser edited: the script finds
# its driver and lib/ beside itself, so a lone copied script grades a missing
# executor, not the mutation.
mutant() {  # mutant <name> <sed-expr> -> path of the mutant bin/browser
  rm -rf "$TMP/mut-$1"; cp -r "$ROOT/plugins/browser" "$TMP/mut-$1"
  sed "$2" "$BROWSER" > "$TMP/mut-$1/bin/browser"; chmod +x "$TMP/mut-$1/bin/browser"
  printf '%s\n' "$TMP/mut-$1/bin/browser"
}

SEAT="$(id -un)"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"; mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/sessions"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_APPROVAL_DIR="$TMP/approvals" FIVEDIVE_BROWSER_APPROVAL_POLICY="$TMP/policy.json"
export FIVEDIVE_BROWSER_GRANT_UID="$(id -u)" FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 FIVEDIVE_BROWSER_TREE_SETTLE_MS=0
export FIVEDIVE_BROWSER_EXPECT_WAIT_MS=0
mkdir -p "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
chmod 711 "$FIVEDIVE_BROWSER_PROFILE_ROOT"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"

FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\n[[ "${1:-}" == --version ]] && { echo "Google Chrome 153"; exit 0; }\necho "<html><body>public</body></html>"\n' > "$FAKEBIN/google-chrome"
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

# --- THE STUB, from the main suite -------------------------------------------
PWROOT="$TMP/pw"; mkdir -p "$PWROOT/node_modules/playwright-core"
printf '{ "name": "playwright-core", "version": "0.0.0-stub", "main": "index.js" }\n' > "$PWROOT/node_modules/playwright-core/package.json"
sed -n "/^cat > \"\$PWROOT\/node_modules\/playwright-core\/index.js\" <<'PWJS'$/,/^PWJS$/p" tests/browser_plugin_unit.sh \
  | sed '1d;$d' \
  | sed "s#fs.writeFileSync(o.path, process.env.PWSHOT || 'stub-png')#fs.writeFileSync(o.path, process.env.PWSHOT_FILE ? fs.readFileSync(process.env.PWSHOT_FILE) : (process.env.PWSHOT || 'stub-png'))#" \
  > "$PWROOT/node_modules/playwright-core/index.js"
t  'S0 (anchor) the stub was extracted from the main suite' yes \
   "$(grep -q 'launchPersistentContext' "$PWROOT/node_modules/playwright-core/index.js" && echo yes || echo no)"
t  'S0 (anchor) ...with the binary-screenshot hook' yes \
   "$(grep -q 'PWSHOT_FILE' "$PWROOT/node_modules/playwright-core/index.js" && echo yes || echo no)"
export NODE_PATH="$PWROOT/node_modules"
export PWREC="$TMP/pw.jsonl"; : > "$PWREC"

# A page that knows its own refs (the stub's PWREFS): a mark walk finds exactly
# the node it names, so a renamed button misses and its new name resolves.
REFS="$TMP/refs.json"
setrefs() { printf '{"nodes":[%s]}' "$1" > "$REFS"; }
setrefs '{"role":"searchbox","name":"Search","ref":"searchbox/Search"},{"role":"button","name":"Go","ref":"button/Go"}'
export PWREFS="$REFS"

SITEURL="https://wiki.test/start"
SECRET="hunter2-typed-text"
STEPS='[{"op":"fill","selector":"ref=searchbox/Search","value":"'"$SECRET"'"},{"op":"click","selector":"ref=button/Go"}]'
RDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/.routines/wiki.test"
RFILE="$RDIR/daily.json"

# ============================================================= R1 record
run "$BROWSER" act "$SITEURL" --steps="$STEPS" --record=daily --out="$TMP/a1"
t  'R1 act --record exits 0' 0 "$RC"
tc 'R1 ...and says what it recorded' 'recorded into routine daily (wiki.test): now 1 act(s), 1 value slot(s)' "$ERR"
t  'R1 the routine is a file under the seat, 0600' 600 "$(stat -c %a "$RFILE" 2>/dev/null)"
tn 'R1 THE TYPED VALUE IS NOT IN THE FILE' "$SECRET" "$(cat "$RFILE" 2>/dev/null)"
t  'R1 ...it is slot 1 of the fill step' 1 "$(jq -r '.acts[0].steps[0].slot' "$RFILE" 2>/dev/null)"
t  'R1 the steps keep how to FIND each element' 'ref=searchbox/Search ref=button/Go' \
   "$(jq -r '[.acts[0].steps[].selector] | join(" ")' "$RFILE" 2>/dev/null)"
t  'R1 the act starts from its URL' "$SITEURL" "$(jq -r '.acts[0].url' "$RFILE" 2>/dev/null)"
# a second act with a URL is a second act; an --expect is kept as its post-condition
run "$BROWSER" act "https://wiki.test/article" --steps='[{"op":"click","selector":"ref=button/Go"}]' --expect='stub after' --record=daily --out="$TMP/a2"
t  'R1 a second recorded act exits 0' 0 "$RC"
t  'R1 ...and is act 2, with its --expect' '2 stub after' "$(jq -r '"\(.acts|length) \(.acts[1].expect)"' "$RFILE" 2>/dev/null)"

# ============================================================= R2 replay
: > "$PWREC"
run "$BROWSER" replay wiki.test daily --values='["Ada Lovelace"]' --json
t  'R2 replay exits 0' 0 "$RC"
t  'R2 ...replayed both acts' 'replayed 2' "$(jq -r '"\(.verdict) \(.acts)"' <<<"$OUT" 2>/dev/null)"
t  'R2 ...with 0 model calls and 0 re-picks' '0 0' "$(jq -r '"\(.model_calls) \(.repicked)"' <<<"$OUT" 2>/dev/null)"
t  'R2 the supplied value reached the field' 'Ada Lovelace' "$(jq -rs '[.[]|select(.call=="fill")|.val]|first' "$PWREC")"
t  'R2 the steps ran in order: goto fill click goto click' 'goto fill click goto click' \
   "$(jq -rs '[.[]|select(.call|IN("goto","fill","click"))|.call]|join(" ")' "$PWREC")"
t  'R2 NO snapshot walk ran (nothing for a model to read)' 0 "$(jq -rs '[.[]|select(.call=="evaluate" and .snapshot)]|length' "$PWREC")"
t  'R2 the routine counts the replay' 1 "$(jq -r '.replays' "$RFILE" 2>/dev/null)"
run "$BROWSER" replay wiki.test daily
t  'R2 the wrong number of values is a usage error' 64 "$RC"
tc 'R2 ...naming the slot it needs' '1=fill ref=searchbox/Search' "$ERR"
run "$BROWSER" replay wiki.test nosuch
t  'R2 an unknown routine is 64' 64 "$RC"
tc 'R2 ...and names the ones recorded for the site' 'daily' "$ERR"
run "$BROWSER" replay wiki.test daily --values='["x"]'
tc 'R2 plain output names the model calls' '0 model call(s) — every step from the cache' "$OUT"

# ============================================================= R3 self-heal
# The site renamed its button. A unique name match re-picks it (reflex is off
# here: FIVEDIVE_BROWSER_CLI is absent), the replay succeeds, and the routine is
# rewritten so the next replay pays nothing.
setrefs '{"role":"searchbox","name":"Search","ref":"searchbox/Search"},{"role":"button","name":"Go now","ref":"button/Go now"}'
cp "$RFILE" "$TMP/routine-before-heal.json"
run "$BROWSER" replay wiki.test daily --values='["x"]' --json
t  'R3 a renamed button: replay still exits 0' 0 "$RC"
t  'R3 ...two steps were re-picked (one per act)' 2 "$(jq -r '.repicked' <<<"$OUT" 2>/dev/null)"
t  'R3 ...and the routine now holds the new ref' 'ref=button/Go now ref=button/Go now' \
   "$(jq -r '[.acts[].steps[] | select(.op=="click") | .selector] | join(" ")' "$RFILE" 2>/dev/null)"
run "$BROWSER" replay wiki.test daily --values='["x"]' --json
t  'R3 the NEXT replay finds it at once: 0 re-picks' '0 0' "$(jq -r '"\(.rc // 0) \(.repicked)"' <<<"$OUT" 2>/dev/null)"
# MUTANT: no write-back. Every replay pays the re-pick again.
MUTW="$(mutant writeback 's|&& jq -c --argjson i "$((k - 1))" --argjson s "$fixed" '"'"'.acts\[$i\].steps = $s'"'"' "$file" > "$tmp"|\&\& cp "$file" "$tmp"|')"
t  'M1 mutant applied' yes "$(cmp -s "$MUTW" "$BROWSER" && echo no || echo yes)"
cp "$TMP/routine-before-heal.json" "$RFILE"
run "$MUTW" replay wiki.test daily --values='["x"]' --json
run "$MUTW" replay wiki.test daily --values='["x"]' --json
t  'M1 MUTANT (no write-back): the second replay re-picks again' 2 "$(jq -r '.repicked' <<<"$OUT" 2>/dev/null)"
cp "$TMP/routine-before-heal.json" "$RFILE"

# ============================================================= R4 a miss
setrefs '{"role":"searchbox","name":"Search","ref":"searchbox/Search"},{"role":"link","name":"Elsewhere","ref":"link/Elsewhere"}'
run "$BROWSER" replay wiki.test daily --values='["x"]'
t  'R4 a step nothing can re-pick fails the replay (exit 1)' 1 "$RC"
tc 'R4 ...it names the act it missed on' 'MISSED at act 1' "$ERR"
tc 'R4 ...and the re-record command' 'routine forget wiki.test daily --from=1' "$ERR"
t  'R4 the routine is unchanged by a miss' "$(jq -c .acts "$TMP/routine-before-heal.json")" "$(jq -c .acts "$RFILE" 2>/dev/null)"
setrefs '{"role":"searchbox","name":"Search","ref":"searchbox/Search"},{"role":"button","name":"Go","ref":"button/Go"}'

# ============================================================= R5 failures, ls/show/forget
run env PWFAIL=1 "$BROWSER" act "$SITEURL" --steps='[{"op":"click","selector":"ref=button/Go"}]' --record=broken
t  'R5 a failed act exits 1' 1 "$RC"
tc 'R5 ...and is NOT recorded' 'NOT recorded into routine broken' "$ERR"
t  'R5 ...no file' no "$([[ -e "$RDIR/broken.json" ]] && echo yes || echo no)"
run "$BROWSER" act "$SITEURL" --steps='[{"op":"click","selector":"ref=button/Go"}]' --record='Bad Name'
t  'R5 a routine name with spaces is 64' 64 "$RC"
run "$BROWSER" routine ls
tc 'R5 routine ls lists it' 'wiki.test  daily  — 2 act(s), 3 step(s), 1 value slot(s)' "$OUT"
run "$BROWSER" routine show wiki.test daily
tc 'R5 routine show prints the steps and the slot' 'fill ref=searchbox/Search  <- value 1' "$OUT"
tn 'R5 ...and never a value' "$SECRET" "$OUT"
run "$BROWSER" routine forget wiki.test daily --from=2
t  'R5 forget --from=2 keeps act 1 only' 1 "$(jq '.acts | length' "$RFILE" 2>/dev/null)"
run "$BROWSER" routine forget wiki.test daily
t  'R5 forget removes it' no "$([[ -e "$RFILE" ]] && echo yes || echo no)"

# MUTANT: the value stripping removed — the typed text lands in the file.
MUTV="$(mutant values 's#.out += \[(\$s | del(.value)) + {slot:\$k}\]#.out += [$s + {slot:$k}]#')"
t  'M2 mutant applied' yes "$(cmp -s "$MUTV" "$BROWSER" && echo no || echo yes)"
run "$MUTV" act "$SITEURL" --steps="$STEPS" --record=leaky
t  'M2 MUTANT (values kept): the arm above WOULD see the secret' yes \
   "$(grep -q "$SECRET" "$RDIR/leaky.json" 2>/dev/null && echo yes || echo no)"
rm -f "$RDIR/leaky.json"

# ============================================================= R6 input mode, docs
printf '{"site":"tiktok.test","drive":"input"}' > "$FIVEDIVE_BROWSER_ADAPTER_DIR/tiktok.test.json"
run "$BROWSER" act tiktok.test --steps='[{"op":"click","x":1,"y":1}]' --record=feed
t  'R6 input mode refuses --record' 64 "$RC"
tc 'R6 ...by name' 'nothing to record' "$ERR"
run "$BROWSER" --help
tc 'R6 --help names replay' 'browser replay <site> <name>' "$OUT$ERR"
tc 'R6 --help names --delta' 'snapshot <url> --delta' "$OUT$ERR"
SKILL="$(cat plugins/browser/skills/use-browser/SKILL.md)"
tc 'R6 the skill teaches --record' '--record=' "$SKILL"
tc 'R6 the skill teaches replay' '5dive browser replay' "$SKILL"
tc 'R6 the skill teaches --delta' '--delta' "$SKILL"

# ============================================================= D1 lib/delta.cjs
D1=$(node - "$ROOT/plugins/browser/lib/delta.cjs" <<'NODE'
const zlib = require('zlib');
const d = require(process.argv[2]);
// A PNG encoder that uses every filter type, row by row, so the decoder's
// reconstruction of each is graded against pixels we know.
function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(t, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function encode(w, h, px, bpp) {
  const stride = w * bpp, rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) for (let c = 0; c < bpp; c++) cur[x * bpp + c] = px[(y * w + x) * 4 + c];
    const f = y % 5, out = Buffer.alloc(stride + 1); out[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i + 1] = (cur[i] - p) & 0xff;
    }
    rows.push(out); prev = cur;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const W = 100, H = 100, px = Buffer.alloc(W * H * 4);
let s = 7; for (let i = 0; i < px.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; px[i] = i % 4 === 3 ? 255 : s & 0xff; }
const out = [];
for (const bpp of [3, 4]) {
  const dec = d.decodePng(encode(W, H, px, bpp));
  out.push(`roundtrip${bpp}=${dec.px.equals(px)}`);
}
const a = encode(W, H, px, 4), px2 = Buffer.from(px);
for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) px2[(y * W + x) * 4] = (px2[(y * W + x) * 4] + 128) & 0xff;
out.push(`same=${d.pixelChange(a, a)}`, `block=${d.pixelChange(a, encode(W, H, px2, 4))}`);
const md = d.multisetDiff(['a', 'b', 'b', 'c'], ['b', 'c', 'd']);
out.push(`ms=+${md.added.join(',')}/-${md.removed.join(',')}`);
out.push(`fm=${d.textLines('---\ncaptured: 1\nhash: x\n---\n\nhello\n\nworld \n').join('|')}`);
console.log(out.join(' '));
NODE
)
tc 'D1 the decoder round-trips RGB through all five filters' 'roundtrip3=true' "$D1"
tc 'D1 ...and RGBA' 'roundtrip4=true' "$D1"
tc 'D1 the same picture changed 0' 'same=0' "$D1"
tc 'D1 a 10x10 block of 100x100 is 1%' 'block=0.01' "$D1"
tc 'D1 text is a multiset: one b of two went, d came' 'ms=+d/-a,b' "$D1"
tc 'D1 page.md front matter is not page text' 'fm=hello|world' "$D1"

# ============================================================= D2 snapshot --delta
# Two PNGs from the same encoder: the second differs in a 5x5 corner (well under
# 1%), and a third differs in half the picture.
node - "$TMP" <<'NODE'
const zlib = require('zlib'), fs = require('fs'), dir = process.argv[2];
function crc32(b) { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(t, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(t, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); }
function png(fillFn) { const W = 200, H = 100, rows = [];
  for (let y = 0; y < H; y++) { const r = Buffer.alloc(W * 3 + 1); for (let x = 0; x < W; x++) { const v = fillFn(x, y); r[1 + x * 3] = v; r[2 + x * 3] = v; r[3 + x * 3] = v; } rows.push(r); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]); }
fs.writeFileSync(`${dir}/p-a.png`, png(() => 200));
fs.writeFileSync(`${dir}/p-small.png`, png((x, y) => (x < 5 && y < 5 ? 0 : 200)));   // 25 of 20000 px
fs.writeFileSync(`${dir}/p-big.png`, png((x) => (x < 100 ? 0 : 200)));              // half
NODE
LONGTEXT=""; for i in $(seq 1 40); do LONGTEXT+="<p>Paragraph $i of the article says something long enough to matter.</p>"; done
W1="$TMP/walk1.json"; W2="$TMP/walk2.json"
NODES='{"role":"searchbox","name":"Search","ref":"searchbox/Search"},{"role":"button","name":"Go","ref":"button/Go"}'
for i in $(seq 1 20); do NODES+=',{"role":"link","name":"Link '"$i"'","ref":"link/Link '"$i"'"}'; done
printf '{"nodes":[%s],"marker":null,"title":"Wiki","url":"https://wiki.test/page","html":"<html><body><main>%s</main></body></html>"}' "$NODES" "$LONGTEXT" > "$W1"
printf '{"nodes":[%s,{"role":"button","name":"Undo","ref":"button/Undo"}],"marker":null,"title":"Wiki","url":"https://wiki.test/page","html":"<html><body><main>%s<p>Saved.</p></main></body></html>"}' "$NODES" "$LONGTEXT" > "$W2"
snap() { run env -u PWREFS PWWALK="$1" PWSHOT_FILE="$2" "$BROWSER" snapshot https://wiki.test/page --interactive "${@:3}"; }
BASE="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/.read-artifacts/.delta/wiki.test"
snap "$W1" "$TMP/p-a.png" --delta --out="$TMP/s1"
t  'D2 the first snapshot exits 0' 0 "$RC"
tc 'D2 ...is full, and says why' 'this is your first snapshot of wiki.test' "$OUT"
t  'D2 ...and is the baseline now' yes "$([[ -s "$BASE/tree.json" && -s "$BASE/page.md" && -s "$BASE/page.png" ]] && echo yes || echo no)"
snap "$W2" "$TMP/p-small.png" --delta --out="$TMP/s2"
t  'D2 the second snapshot --delta exits 0' 0 "$RC"
tc 'D2 ...prints a DELTA' 'DELTA from your snapshot' "$OUT"
tc 'D2 ...with the new ref' '+ ref=button/Undo' "$OUT"
tc 'D2 ...and the new text' '+ Saved.' "$OUT"
tn 'D2 ...and not the refs that did not change' 'ref=link/Link 7' "$OUT"
t  'D2 page.png is NOT written when under 1% of it changed' no "$([[ -e "$TMP/s2/page.png" ]] && echo yes || echo no)"
tc 'D2 ...and the output says the picture is current' 'the picture you have is current' "$OUT"
t  'D2 the full capture is still on disk for when the delta is not enough' yes "$([[ -s "$TMP/s2/tree.json" && -s "$TMP/s2/page.md" ]] && echo yes || echo no)"
snap "$W2" "$TMP/p-big.png" --delta --out="$TMP/s3"
t  'D2 a picture that changed by half IS written' yes "$([[ -s "$TMP/s3/page.png" ]] && echo yes || echo no)"
tc 'D2 ...and the text is unchanged' 'text: unchanged' "$OUT"
snap "$W2" "$TMP/p-big.png" --delta --json --out="$TMP/s4"
t  'D2 --json carries the delta and drops the node list' 'true null' "$(jq -r '"\(.delta.applied) \(.nodes)"' <<<"$OUT" 2>/dev/null)"
snap "$W1" "$TMP/p-a.png" --out="$TMP/s5"
tn 'D2 without --delta a snapshot is the full one' 'DELTA' "$OUT"
FIVEDIVE_BROWSER_DELTA_TTL=0 snap "$W2" "$TMP/p-a.png" --delta --out="$TMP/s6"
sleep 1; FIVEDIVE_BROWSER_DELTA_TTL=0 snap "$W2" "$TMP/p-a.png" --delta --out="$TMP/s6b"
tc 'D2 an old baseline is a new sitting: full' 'min old' "$OUT"
# A different page: everything is new, so the delta would be longer than the page.
W3="$TMP/walk3.json"
printf '{"nodes":[{"role":"link","name":"Other","ref":"link/Other"}],"marker":null,"title":"Other","url":"https://wiki.test/other","html":"<html><body><main><p>A different page entirely, with its own words.</p></main></body></html>"}' > "$W3"
snap "$W3" "$TMP/p-big.png" --delta --out="$TMP/s7"
tc 'D2 a delta longer than the page falls back to full' 'full snapshot: the change is' "$OUT"
# MUTANT: the baseline never moves — the next delta reads against a stale page.
MUTB="$(mutant baseline 's#if \[\[ -s "$out/$f" \]\]; then install -m 00600#if [[ -s "$base/$f" ]]; then :; elif [[ -s "$out/$f" ]]; then install -m 00600#')"
t  'M3 mutant applied' yes "$(cmp -s "$MUTB" "$BROWSER" && echo no || echo yes)"
rm -rf "$BASE"
run env -u PWREFS PWWALK="$W1" PWSHOT_FILE="$TMP/p-a.png" "$MUTB" snapshot https://wiki.test/page --interactive --out="$TMP/m1"
run env -u PWREFS PWWALK="$W2" PWSHOT_FILE="$TMP/p-a.png" "$MUTB" snapshot https://wiki.test/page --interactive --out="$TMP/m2"
run env -u PWREFS PWWALK="$W2" PWSHOT_FILE="$TMP/p-a.png" "$MUTB" snapshot https://wiki.test/page --interactive --delta --out="$TMP/m3"
tc 'M3 MUTANT (frozen baseline): an unchanged page reads as changed' '+ ref=button/Undo' "$OUT"
rm -rf "$BASE"
run env -u PWREFS PWWALK="$W1" PWSHOT_FILE="$TMP/p-a.png" "$BROWSER" snapshot https://wiki.test/page --interactive --out="$TMP/n1"
run env -u PWREFS PWWALK="$W2" PWSHOT_FILE="$TMP/p-a.png" "$BROWSER" snapshot https://wiki.test/page --interactive --out="$TMP/n2"
run env -u PWREFS PWWALK="$W2" PWSHOT_FILE="$TMP/p-a.png" "$BROWSER" snapshot https://wiki.test/page --interactive --delta --out="$TMP/n3"
tc 'M3 (control) the real baseline moved: refs unchanged' 'refs: unchanged' "$OUT"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
