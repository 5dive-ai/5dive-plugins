#!/usr/bin/env bash
# DIVE-4021 — `5dive browser`: profile-per-site auth and a deterministic executor.
#
# WHAT THIS SUITE IS ARRANGED AROUND. The row names three structural gaps, and a
# test that only proved "the happy path prints something" would grade none of
# them. So every arm below is a MUTANT of the specific defect the design exists
# to prevent, driven through the real bin/browser as a subprocess:
#
#   gap 1 sessions die   -> T4x: a cold profile FAILS CLOSED. The mutant is an
#                           executor that finds out mid-publish and improvises.
#   gap 2 verification   -> T5x: exit status follows the OUT-OF-BAND re-read and
#                           NOT the driver. Two mutants, and the second is the
#                           dangerous one: driver-red + artifact-live must exit 0,
#                           because a "failure" there is what double-posts on retry.
#   gap 3 profiles ARE   -> T2x: a directory this seat does not own, or that is
#         credentials       group-readable, is refused rather than repaired.
#
# There is no chrome on a CI runner and this suite must not need one, so the
# probe is driven by putting a FAKE `google-chrome` first on PATH. That is not a
# test hook in the product — bin/browser has no probe override to set, and could
# not, because a way to declare a profile live without looking is the one backdoor
# this design cannot afford. The fake is exercising the real _probe.
set -uo pipefail
# DIVE-4202: this harness moved here with the plugin it grades. It used to live
# in 5dive-ai/5dive (tests/browser_plugin_unit.sh) and read `plugins/browser` out
# of the CLI's own repo; the plugin is published from HERE now, so the test that
# reds when the plugin breaks lives with it. grading_tree.sh did not come along —
# it is a 5dive-repo helper — so the tree is named by git directly.
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"

PASS=0; FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }

# DIVE-4446 iteration 2 — two readers for the doc/skill prose arms below. Both
# flatten the markdown first: an arm that depends on where the author's editor
# wrapped a sentence grades the wrapping, not the rule.
# _forbidden_spend_verbs prints which of the ways of spending a one-time ticket
# the text forbids, read out of the prose rather than matched as a fixed
# sentence: the skill says "do not open it, do not curl it" and the doc says
# "Never open it, curl it, fetch it", and an arm pinned to either wording grades
# the author's line-wrapping instead of the rule.
_forbidden_spend_verbs() {
  python3 - "$1" <<'PY'
import re,sys
t=re.sub(r'\s+',' ',open(sys.argv[1]).read())
obj=r'(?:it|the (?:viewer |one-time )?(?:link|url|ticket))'
out=[]
for v in ('open','curl','fetch','preview'):
    for m in re.finditer(v+r'\s+'+obj+r'\b',t,re.I):
        head=t[:m.start()]
        cut=max(head.rfind('.'),head.rfind('- '))
        if re.search(r"(?:never|do not|don't|must not)",head[cut+1:],re.I):
            out.append(v); break
print(' '.join(sorted(out)) or 'none')
PY
}
# _instructs_spend prints the first instruction-shaped phrasing of "request the
# one-time link in order to check it" that is NOT inside a prohibition, or the
# string none. It is a CLASS check: the arm must not be walkable by a reword.
_instructs_spend() {
  python3 - "$1" <<'PY'
import re,sys
t=re.sub(r'\s+',' ',open(sys.argv[1]).read())
verb=r'(?:open|GET|curl|fetch|preview|visit|load|click|hit|request|browse to)'
obj=r'(?:it|the (?:viewer |one-time )?(?:link|url|ticket))'
pat=re.compile(verb+r'\s+'+obj+r'\b[^.]{0,60}?(?:to |and )(?:verify|check|test|confirm|make sure|see)',re.I)
bad=[m.group(0) for m in pat.finditer(t)
     if not re.search(r"(?:never|do not|don't|must not|no seat)[^.]{0,100}$", t[:m.start()], re.I)]
print(bad[0] if bad else 'none')
PY
}

TMP="$(mktemp -d)"
OUT=""; ERR=""; RC=0
run() { local o="$TMP/.o" e="$TMP/.e"; "$@" >"$o" 2>"$e"; RC=$?; OUT=$(cat "$o"); ERR=$(cat "$e"); return 0; }

SEAT="$(id -un)"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"
mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"

# --- fake chrome, and the DOM it serves is switchable per site ---------------
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
# Serves whatever DOM the arm parked for this profile. Ignores every flag; the
# point is only that _probe gets a document back and greps it.
for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#*=}" ;; esac; done
cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null || echo "<html><body>feed</body></html>"
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

# --- fixtures ----------------------------------------------------------------
mkprofile() {  # mkprofile <site> <dom>
  local d="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$1"
  mkdir -p "$d"; chmod 700 "$d"; printf '%s' "$2" > "$d/.fake-dom"
  chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
  echo "$d"
}
LIVE_DOM='<html><body><div id="feed">posts</div></body></html>'
DEAD_DOM='<html><body><form action="/login"><input name="pw"></form></body></html>'
# A challenge page usually still carries the login form's markup. That overlap is
# the whole reason T8 exists: classify this as "expired" and the operator is told
# to re-authenticate a session that is fine.
CHALLENGE_DOM='<html><body><form action="/login"></form><div class="g-recaptcha"></div></body></html>'

mkadapter() {  # mkadapter <site> <verify-url> <expect> [extra-step-op]
  local extra=""
  [[ -n "${4:-}" ]] && extra=",{\"op\":\"$4\",\"selector\":\"x\"}"
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$1.json" <<JSON
{ "site": "$1",
  "probe": { "url": "https://$1.test/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"https://$1.test/compose"},
                 {"op":"fill","selector":"#e","value":"{body}"},
                 {"op":"click","selector":"#pub"}$extra ],
      "verify": { "url": "$2", "expect": "$3" } } } }
JSON
}
mkdriver() {  # mkdriver <exit-code>
  cat > "$TMP/driver" <<DRV
#!/usr/bin/env bash
cat > "$TMP/driver-plan.json"
exit $1
DRV
  chmod +x "$TMP/driver"; export FIVEDIVE_BROWSER_DRIVER="$TMP/driver"
}

# ============================================================== T1 the manifest
M="$ROOT/plugins/browser/.claude-plugin/plugin.json"
run jq -e . "$M";                                              t 'T1a manifest is valid JSON' 0 "$RC"
t 'T1b declares contract 1'      '1'       "$(jq -r '.fivedive.contract' "$M")"
t 'T1c declares the verb capability' 'true' "$(jq -r '.fivedive.capabilities|index("verb")!=null' "$M")"
t 'T1d the verb is named browser' 'browser' "$(jq -r '.fivedive.verbs[0].name' "$M")"
# The dispatcher resolves <plugin>/bin/<verb> and refuses a non-executable file,
# so a declared verb whose file is not +x installs and can never run.
t 'T1e bin/<verb> exists and is executable, or the verb is inert' 'yes' \
  "$([[ -x "$ROOT/plugins/browser/bin/browser" ]] && echo yes || echo no)"
t 'T1f the registry marketplace lists it' 'browser' \
  "$(jq -r '.plugins[]|select(.name=="browser")|.name' "$ROOT/.claude-plugin/marketplace.json")"
# DIVE-4202 replaced T1g's subject. It used to grade that each file was
# enumerated in the CLI installer's flat per-file fetch list; the CLI stages no
# plugins any more, and `plugin add` resolves this plugin by CLONING this repo.
# So the way a file goes missing on a real box is now exactly one thing: it is
# not COMMITTED here. Grade that, against git, not against a list.
for f in plugins/browser/.claude-plugin/plugin.json plugins/browser/README.md plugins/browser/bin/browser plugins/browser/adapters/example.json; do
  t "T1g $f is committed, so a clone of this repo carries it" "yes" \
    "$(git -C "$ROOT" ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo yes || echo no)"
done
# Negative control: T1g must be able to say no. A path that is deliberately not
# in the repo has to come back "no", or the arm is asserting that git works.
t 'T1g-control a file that is NOT committed reads as missing' "no" \
  "$(git -C "$ROOT" ls-files --error-unmatch plugins/browser/NOT-A-REAL-FILE >/dev/null 2>&1 && echo yes || echo no)"
# The marketplace `source` must point at the directory that actually exists, or
# `plugin add browser` clones this repo and then resolves to nothing.
t 'T1g2 the marketplace source resolves to a real directory in this repo' "yes" \
  "$([[ -d "$ROOT/$(jq -r '.plugins[]|select(.name=="browser")|.source' "$ROOT/.claude-plugin/marketplace.json" | sed 's|^\./||')" ]] && echo yes || echo no)"
run bash "$ROOT/plugins/browser/bin/browser" --help;           t 'T1h --help exits 0' 0 "$RC"
# DIVE-4118: `plugin add` resolves a VERSION-PINNED cache path, so a fix ships by
# being INSTALLABLE, not by being merged (the DIVE-4123 lesson, one repo over).
# Server mode is new surface on this plugin; a box already holding the version
# that shipped without it has no way to tell unless the number moves.
t 'T1i the shipped script declares the viewer verbs' 'yes' \
  "$(grep -q 'viewer-redeem)' "$ROOT/plugins/browser/bin/browser" && echo yes || echo no)"
t 'T1i ...so the manifest is no longer the version that shipped without them' 'yes' \
  "$([[ "$(jq -r .version "$ROOT/plugins/browser/.claude-plugin/plugin.json")" != "1.0.0" ]] && echo yes || echo no)"

# ========================================= T2 a profile directory IS a credential
run "$BROWSER" ls
t  'T2a no store at all is not a crash' 69 "$RC"
tc 'T2a ...it names the one command that fixes it' '5dive browser setup' "$ERR"

mkprofile x "$LIVE_DOM" >/dev/null
run "$BROWSER" ls;                                             t 'T2b a sane store lists' 0 "$RC"
tc 'T2b ...naming the site'  'x' "$OUT"

# THE MUTANT: group/other-readable seat dir. Anything that can READ the directory
# can replay the session, so this must refuse — and must NOT quietly chmod it,
# because a silent repair means the window it was open in is never noticed.
chmod 750 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
run "$BROWSER" ls
t  'T2c a group-readable seat dir is refused' 77 "$RC"
tc 'T2c ...naming the mode'                  '750' "$ERR"
t  'T2c ...and is NOT silently repaired'     '750' "$(stat -c '%a' "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT")"
chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"

# DIVE-4348: /var/lib/5dive is 2750 on every box, a directory made under it inherits
# setgid, and a 4-digit `chmod 700` PRESERVES that bit on a directory (GNU chmod) —
# so setup left every seat store 2700 and _audit refused with exit 77 on every box.
mkdir -p "$TMP/sgid-parent"; chmod 2755 "$TMP/sgid-parent"; mkdir -p "$TMP/sgid-parent/seat"; chmod 700 "$TMP/sgid-parent/seat"
t  'T2c2 CONTROL: a 4-digit chmod keeps an inherited setgid bit' '2700' "$(stat -c '%a' "$TMP/sgid-parent/seat")"
chmod 00700 "$TMP/sgid-parent/seat"
t  'T2c3 the 5-digit form clears it' '700' "$(stat -c '%a' "$TMP/sgid-parent/seat")"
t  'T2c4 setup creates the seat store with the 5-digit form' 'yes' "$(grep -q 'chmod 00700 "\$PROFILE_ROOT/\$seat"' "$ROOT/plugins/browser/bin/browser" && echo yes || echo no)"
t  'T2c5 ...and the store root too' 'yes' "$(grep -q 'chmod 00711 "\$PROFILE_ROOT"' "$ROOT/plugins/browser/bin/browser" && echo yes || echo no)"
# DIVE-4348: the dashboard's only path is shelld -> `sudo -n 5dive browser …` (root,
# SUDO_USER=claude); as root every verb but setup refused. Root drops to the seat.
t  'T2c6 a root caller with SUDO_USER re-executes as the seat before touching a store' 'yes' "$(grep -q 'exec runuser -u "\$_drop" -- "\$0" "\$@"' "$ROOT/plugins/browser/bin/browser" && echo yes || echo no)"
t  'T2c7 ...but setup stays root'"'"'s' 'yes' "$(grep -A2 'if \[\[ \$EUID -eq 0 && -n "\${SUDO_USER:-}"' "$ROOT/plugins/browser/bin/browser" | grep -q 'setup|-h|--help|help|"") ;;' && echo yes || echo no)"

# DIVE-4519: setup owns the schedule instead of leaving "run this on a
# schedule" as prose. These arms kill a non-persistent timer and a root service
# that cannot read the seat-owned 0700 profile store.
t  'T2c8 setup installs a persistent six-hour probe timer' 'yes' \
  "$(grep -q 'OnUnitActiveSec=6h' "$BROWSER" && grep -q 'Persistent=true' "$BROWSER" && echo yes || echo no)"
t  'T2c8 ...running as the timer instance seat' 'yes' \
  "$(grep -q 'User=%i' "$BROWSER" && echo yes || echo no)"
t  'T2c8 ...and invokes the fleet sweep, not bare status' 'yes' \
  "$(grep -q 'ExecStart=.*browser probe-all' "$BROWSER" && echo yes || echo no)"

# A site name becomes a directory name.
for bad in ../etc "a/b" "" "UPPER"; do
  run "$BROWSER" auth "$bad"
  t "T2d refuses site name '$bad'" 64 "$RC"
done
# ...and the positive control, or "refuses everything" would pass T2d.
run "$BROWSER" auth x
tn 'T2e a VALID name is not refused as a name' 'not a usable profile name' "$ERR"

# setup is a root act because the alternative is a world-writable parent a
# hostile seat can squat.
run "$BROWSER" setup
t  'T2f setup as non-root is refused' 77 "$RC"
tc 'T2f ...naming the sudo form'      'sudo 5dive browser setup' "$ERR"

# ================================================= T3 adapters are data, not code
mkdriver 0
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'
printf 'PUBLISHED' > "$TMP/artifact.html"

# THE MUTANT the fixed vocabulary exists for: a step that is a program.
python3 - "$FIVEDIVE_BROWSER_ADAPTER_DIR/x.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['actions']['publish']['steps'].append({"op":"eval","script":"require('child_process')"})
json.dump(d,open(p,'w'))
PY
run "$BROWSER" run x publish --body=hi
t  'T3a a step outside the vocabulary is refused' 64 "$RC"
tc 'T3a ...naming the offending op'               'eval' "$ERR"
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'

# An action with no out-of-band verify is refused BEFORE a step runs — an
# unverifiable action must not be half-executed and then found unverifiable.
rm -f "$TMP/driver-plan.json"
python3 - "$FIVEDIVE_BROWSER_ADAPTER_DIR/x.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); del d['actions']['publish']['verify']; json.dump(d,open(p,'w'))
PY
run "$BROWSER" run x publish --body=hi
t  'T3b an action with no verify block is refused'  64 "$RC"
tc 'T3b ...saying why in the operator words'        'grade its own homework' "$ERR"
t  'T3b ...and NOT after running the steps'         'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'

run "$BROWSER" run x nosuchaction --body=hi
t 'T3c an undefined action is refused' 64 "$RC"

# ========================================== T4 gap 1: a cold session fails CLOSED
mkprofile dead "$DEAD_DOM" >/dev/null
mkadapter dead "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$TMP/driver-plan.json"
run "$BROWSER" run dead publish --body=hi
t  'T4a a logged-out profile refuses to run' 75 "$RC"
tc 'T4a ...naming the human-only fix'        '5dive browser auth dead' "$ERR"
t  'T4a ...and the driver was never invoked' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
tc 'T4a ...and does not retry or improvise'  'no retry, no login attempt' "$ERR"

run "$BROWSER" status dead
t  'T4b --status reports a dead profile as cold' 75 "$RC"
tc 'T4b ...in the words the adopted design names' 'session expired — human action required' "$OUT"
run "$BROWSER" auth --status dead
t  'T4b2 auth --status is still an alias, so neither name is a dead link' 75 "$RC"
run "$BROWSER" status x
t  'T4c ...and a live one as live' 0 "$RC"
tc 'T4c ...positive control'       'authenticated' "$OUT"

# ================== T5 gap 2: the verdict is the out-of-band read, not the driver
# MUTANT 1 — driver green, artifact absent. "Posted a draft and reported success."
mkdriver 0
mkadapter x "file://$TMP/missing.html" 'PUBLISHED'
run "$BROWSER" run x publish --body=hi
t  'T5a driver-green + artifact-absent must NOT report success' 1 "$RC"
tc 'T5a ...and says the re-read is what failed' 'NOT VERIFIED' "$ERR"
tc 'T5a ...and warns against a blind retry'     'double-posts' "$ERR"

# MUTANT 2, and this is the dangerous one. Driver RED, artifact LIVE: the publish
# worked and the driver lied. Reporting failure here is what double-posts on the
# retry, so the out-of-band read has to overrule a red driver too. A verdict that
# only overrules green is not out-of-band verification, it is a second opinion
# nobody asked for.
mkdriver 3
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" run x publish --body=hi
t  'T5b driver-RED + artifact-live reports SUCCESS' 0 "$RC"
tc 'T5b ...naming the URL it re-read'               "$TMP/artifact.html" "$OUT"

# The happy path, or T5a/T5b could both pass on a `run` that never verifies.
mkdriver 0
run "$BROWSER" run x publish --body=hi
t 'T5c driver-green + artifact-live is success' 0 "$RC"

# The verify URL interpolates the caller's args, which is how a permalink is
# addressed at all. Substituted as a jq VALUE — it never reaches a shell.
printf 'slug-42 is live' > "$TMP/slug-42.html"
mkadapter x "file://$TMP/{slug}.html" '{slug}'
run "$BROWSER" run x publish --slug=slug-42
t  'T5d verify.url and .expect interpolate named args' 0 "$RC"
tc 'T5d ...against the interpolated permalink' 'slug-42.html' "$OUT"

# The plan handed to the driver carries the profile path and the args, and the
# driver is fed on STDIN — argv never carries user text.
t 'T5e the driver receives the profile' "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" \
  "$(jq -r '.profile' "$TMP/driver-plan.json")"
t 'T5f the driver receives the args'    'slug-42' "$(jq -r '.args.slug' "$TMP/driver-plan.json")"

# ============================================ T6 no executor is a refusal, not a fallback
unset FIVEDIVE_BROWSER_DRIVER
run "$BROWSER" run x publish --slug=slug-42
t  'T6a no driver refuses' 69 "$RC"
tc 'T6a ...rather than silently falling back to an automated browser' 'Browser Hand' "$ERR"

# ======================= T8 a security challenge is a HARD STOP, never a bypass
# Decided 2026-09-07: "if a platform presents a security challenge, the executor
# stops and requests human action rather than attempting to bypass it." The mutant
# is not "it tries to solve it" — nothing here could — it is that a challenge gets
# classified as an expired session, which sends a human to re-authenticate a
# session that is fine and teaches them the signal is noise.
mkprofile chal "$CHALLENGE_DOM" >/dev/null
mkadapter chal "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" status chal
t  'T8a a challenge is its own state, not "expired"' 75 "$RC"
tc 'T8a ...named as a challenge'                     'CHALLENGE' "$OUT"
tn 'T8a ...and NOT reported as an expired session'   'session expired' "$OUT"
mkdriver 0
rm -f "$TMP/driver-plan.json"
run "$BROWSER" run chal publish --body=hi
t  'T8b run stops on a challenge'          75 "$RC"
t  'T8b ...without invoking the driver'    'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
tc 'T8b ...saying it is a decision, not a limitation' 'does not attempt to solve' "$ERR"
# The framing lodar closed: this is persistent human-authenticated sessions. The
# anti-bot wording is the one that was ruled out for docs, marketing AND the
# plugin description, so grade the shipped strings rather than trusting a review.
for f in "$ROOT/plugins/browser/.claude-plugin/plugin.json" "$ROOT/plugins/browser/README.md" "$ROOT/.claude-plugin/marketplace.json"; do
  tn "T8c $(basename "$f") does not sell anti-bot evasion" 'fingerprint' "$(cat "$f")"
done
tc 'T8d the manifest uses the adopted framing' 'human-authenticated'   "$(jq -r '.description' "$ROOT/plugins/browser/.claude-plugin/plugin.json")"

# ===================== T9 the classifier must work in the size regime PRODUCTION has
# WHY THIS BLOCK EXISTS, and it is the lesson not the arm: every fixture above is
# a one-line DOM, so the whole suite lived below the old 200KB capture cap and
# graded a regime real pages never enter. Sixty-six green arms and ten killed
# mutants all agreed, and the classifier still reported UNKNOWN for every real
# page — and UNKNOWN fell through to the driver. The discriminating input was
# never a new assertion; it was an EXISTING assertion at a realistic size.
#
# On the size: it has to be well past the cap, not cap+1. A document a little
# over the cap often still fits the reader's last block plus the 64KB pipe
# buffer, so the writer never takes SIGPIPE and the bug does not fire — at
# 250KB it is a coin flip. 1MB is past every buffer on the path, so the arm is
# deterministic. A "cap+1" arm here would have been flaky, which is worse than
# absent because it teaches the suite to be ignored.
PAD="$(head -c 1000000 /dev/zero | tr '\0' 'x')"

# T9a — the SAME logged-out markup as T4a, only large. T4a is its negative control:
# identical verdict at 40 lines, so a difference here is size and nothing else.
mkprofile bigdead "$DEAD_DOM<!-- $PAD -->" >/dev/null
mkadapter bigdead "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" status bigdead
t  'T9a a logged-out profile over the old cap is still read as expired' 75 "$RC"
tc 'T9a ...and not discarded as unreadable' 'session expired — human action required' "$OUT"
tn 'T9a ...so the healthy path is not the one nobody sees' 'UNKNOWN' "$OUT"

mkdriver 0
rm -f "$TMP/driver-plan.json"
run "$BROWSER" run bigdead publish --body=hi
t 'T9b ...and run still fails closed at that size' 75 "$RC"
t 'T9b ...without invoking the driver' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"

# T9c — a marker PAST the cap. Independent of the exit-status half: a truncating
# capture cannot see it even with the status fixed, and a challenge banner is as
# likely to sit late in a large document as early. The mutant is the worst verdict
# this file can produce: a challenged session reported as authenticated.
mkprofile latechal "<html><body><div id=\"feed\">posts</div><!-- $PAD --><div class=\"g-recaptcha\"></div></body></html>" >/dev/null
mkadapter latechal "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" status latechal
t  'T9c a challenge marker past the old cap is still found' 75 "$RC"
tc 'T9c ...classified as a challenge'                       'CHALLENGE' "$OUT"
tn 'T9c ...and NOT as a live session'                       'authenticated' "$OUT"

# T9d/e — UNKNOWN is ASYMMETRIC, and both halves are the finding. Quiet at the
# scheduler (body item: a network blip must not page a human) and FATAL at the
# action (an unverified session is as likely to be a challenge page as a healthy
# one, and the action is the irreversible half). A `!= CHALLENGE && != expired`
# pair satisfies neither: it publishes on every state it has no name for.
#
# Chrome is absent here BY CONSTRUCTION — a bin dir holding only the commands
# bin/browser uses — not by hoping the runner has none. The T9d0 positive control
# is the point: a stripped PATH that broke `jq` would fail these arms for the
# wrong reason and read exactly like a pass.
NOCHROME="$TMP/nochrome"; mkdir -p "$NOCHROME"
for c in bash basename cat chmod curl date dirname env grep head id jq mkdir mktemp rm stat; do
  p="$(command -v "$c" 2>/dev/null)" && ln -sf "$p" "$NOCHROME/$c"
done
t 'T9d0 positive control: the stripped PATH still resolves jq, so a failure below means no chrome' \
  'yes' "$(PATH="$NOCHROME" command -v jq >/dev/null 2>&1 && echo yes || echo no)"
t 'T9d0 ...and resolves no browser at all' 'none' \
  "$(PATH="$NOCHROME" bash -c 'for c in google-chrome chromium chromium-browser google-chrome-stable; do command -v $c >/dev/null 2>&1 && { echo found; exit; }; done; echo none')"

mkprofile nochrome "$LIVE_DOM" >/dev/null
mkadapter nochrome "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$TMP/driver-plan.json"
run env PATH="$NOCHROME" "$BROWSER" run nochrome publish --body=hi
t  'T9d run on a box with no browser REFUSES rather than publishing unchecked' 75 "$RC"
t  'T9d ...and the driver was never invoked' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
tc 'T9d ...saying it will not act on a session it did not verify' 'did not verify' "$ERR"

run env PATH="$NOCHROME" "$BROWSER" status nochrome
t  'T9e status on the same box stays QUIET — a probe that did not load must not page a person' 0 "$RC"
tc 'T9e ...while still naming what it could not do' 'UNKNOWN' "$OUT"

# T9f — the other UNKNOWN: a browser that IS present and fails. Same asymmetry,
# and it is a separate branch in the code from "no browser at all".
BROKENBIN="$TMP/brokenbin"; mkdir -p "$BROKENBIN"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BROKENBIN/google-chrome"; chmod +x "$BROKENBIN/google-chrome"
mkprofile brokenprobe "$LIVE_DOM" >/dev/null
mkadapter brokenprobe "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$TMP/driver-plan.json"
run env PATH="$BROKENBIN:$PATH" "$BROWSER" run brokenprobe publish --body=hi
t 'T9f a probe that failed to load refuses at the action' 75 "$RC"
t 'T9f ...without invoking the driver' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
run env PATH="$BROKENBIN:$PATH" "$BROWSER" status brokenprobe
t 'T9f ...and stays quiet at the scheduler' 0 "$RC"

# ============================================ T7 the shipped example adapter is real
EX="$ROOT/plugins/browser/adapters/example.json"
run jq -e . "$EX";                                       t 'T7a the shipped adapter is valid JSON' 0 "$RC"
t 'T7b ...declares a verify for every action' '' \
  "$(jq -r '[.actions|to_entries[]|select((.value.verify.url and .value.verify.expect)|not)|.key]|join(",")' "$EX")"
t 'T7c ...and uses only the fixed vocabulary' '' \
  "$(jq -r '["goto","fill","click","wait_for","select","upload","press"] as $ok
            | [.actions[].steps[].op|select(. as $o|($ok|index($o))|not)]|unique|join(",")' "$EX")"
# The probe greps the DUMPED DOM, so a marker naming the address bar is a marker
# that never matches — the field name and the code have to agree.
t 'T7d ...and its probe marker is the one bin/browser reads' 'yes' \
  "$(jq -e '.probe.logged_out_when_dom_matches' "$EX" >/dev/null && echo yes || echo no)"


# ================================== T10 server mode + the one-time viewer (DIVE-4118)
#
# The viewer is a live keyboard on a logged-in profile, so every arm here is a
# MUTANT of a way that keyboard gets handed to the wrong person:
#
#   T10b  the ticket file keeps the raw nonce  -> a stolen box is a stolen session
#   T10e  a leaked URL is replayable           -> a TTL alone never closes this
#   T10f  the URL works past its expiry
#   T10g  the URL works in a DIFFERENT session -> pasted-link theft
#   T10h  the nonce is accepted from argv      -> /proc/<pid>/cmdline is not a vault
#   T10i  a wrong nonce is accepted
#   T10j  revoke leaves the ticket redeemable
#   T10c  a box missing the packages half-starts instead of saying so
#   T10k  a viewer is minted with no session binding at all
#   T10m  x11vnc/websockify/Xvfb are started with a flag that opens the box
#   T10n  the VNC server dies before the ticket it was minted for expires
#   T10o  a spent ticket still tells an attacker whether a nonce was right
#   T10p  a ticket outlives the browser it views, and redeems onto a dead port
#   T10q  a REPLAY kills the live viewer -> a hoisted refusal that is not pure
#   T10r  a missing VNC credential SPENDS the customer's one-time link
#   T10s  a link is issued onto a bridge that has not bound its port yet
#   T10t  the ticket advertises life the VNC server was never given
#
# There is no X server on a CI runner, so Xvfb/x11vnc/websockify are FAKES on
# PATH. They are not product hooks: liveness is still the real PID check in
# _serve_running, and redemption is the real sha256 compare. The only override is
# the X socket DIRECTORY, which is a path — pointing it somewhere else cannot make
# a dead display read as live.
#
# AND THE FAKES RECORD THEIR ARGV. The first version of them ran `exec sleep 300`
# and threw "$@" away, which quietly deleted a whole test surface: the property
# this design LEADS with — nothing listens off-box — lives entirely in the flags
# we pass these three programs, so with argv discarded, dropping -localhost, or
# binding websockify to 0.0.0.0, or dropping -nolisten tcp changed nothing any arm
# could see (measured: 125/0 for each). A fake that ignores argv cannot grade a
# flag. These write "$*" to a file the T10m arms below assert on, so the flags are
# MEASURED here and not merely unverified against the real programs.
SBIN="$TMP/sbin"; mkdir -p "$SBIN"
ARGV="$TMP/argv"; mkdir -p "$ARGV"
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"; mkdir -p "$FIVEDIVE_BROWSER_X11_DIR"
cat > "$SBIN/Xvfb" <<XVFB
#!/usr/bin/env bash
printf '%s\\n' "\$*" > "$ARGV/Xvfb.argv"
d="\${1#:}"
: > "$TMP/x11/X\$d"
exec sleep 300
XVFB
# AND THEY BIND THE PORT THEY WERE GIVEN. A fake that records its flags and
# listens on nothing is a bridge that is never up, which is indistinguishable
# from a bridge that is merely slow — and the difference between those two is the
# arm T10s exists to be. `exec` keeps the recorded pid the listening pid, so the
# product's own liveness bookkeeping stays honest.
listen_forever='import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(1); time.sleep(300)'
cat > "$SBIN/x11vnc" <<VNC
#!/usr/bin/env bash
printf '%s\\n' "\$*" > "$ARGV/x11vnc.argv"
# AND WHEN it started, because -timeout is a length measured from HERE while the
# ticket's expires_at is a wall-clock instant. Comparing the two needs this origin;
# without it T10t could only re-read the same number the product wrote.
date -u +%s > "$ARGV/x11vnc.start"
port=""; while (( \$# )); do [[ "\$1" == -rfbport ]] && port="\$2"; shift; done
exec python3 -c '$listen_forever' "\$port"
VNC
cat > "$SBIN/websockify" <<WS
#!/usr/bin/env bash
printf '%s\\n' "\$*" > "$ARGV/websockify.argv"
exec python3 -c '$listen_forever' "\${1##*:}"
WS
chmod +x "$SBIN/Xvfb" "$SBIN/x11vnc" "$SBIN/websockify"

# THE FAKES ARE STARTED IN THE BACKGROUND BY THE PRODUCT, so a capture read the
# instant the command returns can be missing for a reason that has nothing to do
# with the flag under test. That matters most for `tn`: "expected NOT to contain"
# passes on an EMPTY file exactly as it passes on a correct one, so an unlucky
# read turns a security arm into a green no-op. Every read below therefore waits,
# bounded, for a NON-EMPTY capture; every capture is cleared before the mint that
# should rewrite it (a stale one from the previous mint is the same lie with a
# later timestamp); and every `tn` over a capture is paired with a control arm
# that asserts the capture is not empty.
_reset_argv() { local n; for n in "$@"; do rm -f "$ARGV/$n.argv" "$ARGV/$n.start"; done; }
_wait_argv() {  # _wait_argv <prog> -> echoes its recorded argv, or nothing
  local f="$ARGV/$1.argv" i=0
  while (( i < 200 )); do [[ -s "$f" ]] && { cat "$f"; return 0; }; sleep 0.05; i=$(( i + 1 )); done
  return 1
}
nonempty() { [[ -n "$1" ]] && echo yes || echo no; }
# Reads /proc, never connects: connecting to the bridge would spend the -once
# admission this whole design hands to the customer.
port_state() {
  local hex; hex=$(printf '%04X' "$1")
  awk -v pat="$hex" '$4=="0A" && $2 ~ (":" pat "$") {f=1} END{exit !f}' /proc/net/tcp \
    && echo listening || echo dead
}

# The fake chrome above exits immediately (it cats a DOM). Server mode needs a
# chrome that STAYS UP, because "is the browser still serving" is a live PID.
SRVBIN="$TMP/srvbin"; mkdir -p "$SRVBIN"
cat > "$SRVBIN/google-chrome" <<'SRVC'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --headless) exec sleep 0 ;; esac; done
exec sleep 300
SRVC
chmod +x "$SRVBIN/google-chrome"
SPATH="$SRVBIN:$SBIN:$PATH"

mkprofile viewsite "$LIVE_DOM" >/dev/null
VDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/viewsite"

# Is the customer still looking at their viewer? Read it the only way that cannot
# lie: the PIDs the product recorded, probed with kill -0. "The command exited 77"
# says nothing about whether it killed something on the way out.
vnc_state() {
  local f="$VDIR/.5dive-viewer" p
  [[ -f "$f" ]] || { echo dead; return; }
  for p in $(sed -n 's/^vnc_pid=//p' "$f") $(sed -n 's/^ws_pid=//p' "$f"); do
    [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null || { echo dead; return; }
  done
  echo live
}

# --- T10a a display-less box SERVES instead of refusing -----------------------
run env PATH="$SPATH" DISPLAY= "$BROWSER" serve viewsite
t  'T10a serve starts on a box with no display' 0 "$RC"
tc 'T10a ...and says which display it took' 'serving viewsite on :' "$OUT"
t  'T10a ...and records a live browser' '0' "$(env PATH="$SPATH" bash -c '
     f='"$VDIR"'/.5dive-serve; kill -0 "$(sed -n s/^chrome_pid=//p "$f")" 2>/dev/null && echo 0 || echo 1')"
run env PATH="$SPATH" DISPLAY= "$BROWSER" serve viewsite
tc 'T10a ...and a second serve REUSES it, never a second chrome on one profile' \
   'already serving' "$OUT"

# 4021 refused here. That refusal is what made the product need ssh -X.
run env PATH="$SPATH" DISPLAY= "$BROWSER" auth viewsite
t  'T10a auth on a display-less box no longer dead-ends' 0 "$RC"
tn 'T10a ...and does not tell a paying customer to forward an X display' 'Forward one' "$ERR"

# --- T10b the ticket is a hash, never the nonce ------------------------------
_reset_argv x11vnc websockify
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10b viewer mints' 0 "$RC"
NONCE="${OUT##*/}"
tc 'T10b ...printing a path with the nonce in it' '/browser/viewer/viewsite/' "$OUT"
t  'T10b ...a 64-hex nonce' 64 "${#NONCE}"
t  'T10b THE TICKET FILE DOES NOT CONTAIN THE RAW NONCE' 'absent' \
   "$(grep -qF "$NONCE" "$VDIR/.5dive-viewer.ticket" && echo present || echo absent)"
tc 'T10b ...it contains its sha256' "$(printf '%s' "$NONCE" | sha256sum | cut -d' ' -f1)" \
   "$(cat "$VDIR/.5dive-viewer.ticket")"
t  'T10b ...and the ticket is 0600' '600' "$(stat -c '%a' "$VDIR/.5dive-viewer.ticket")"

# --- T10d/T10e it redeems ONCE ------------------------------------------------
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10d the right nonce in the right session redeems' 0 "$RC"
tc 'T10d ...handing the relay a LOOPBACK target and nothing routable' 'target=127.0.0.1:' "$OUT"
tn 'T10d ...never a routable one' '0.0.0.0' "$OUT"
# x11vnc is started with -passwdfile inside the 0700 profile dir, which is the one
# place DIVE-4021's isolation stops the relay from reading. If redemption does not
# emit the password, the relay gets a port that prompts for a secret nobody has —
# a viewer that provably cannot be entered, in a PR whose whole point is the login.
REDEEMED_PW="$(sed -n 's/^password=//p' <<<"$OUT")"
t  'T10d THE VIEWER PASSWORD IS EMITTED WITH THE TARGET, not stranded in the profile dir' \
   'yes' "$([[ -n "$REDEEMED_PW" ]] && echo yes || echo no)"
t  'T10d ...and it is the password x11vnc was actually started with' 'match' \
   "$([[ "$REDEEMED_PW" == "$(cat "$VDIR/.5dive-viewer.pw" 2>/dev/null)" ]] && echo match || echo differs)"
VNC_ARGV_D="$(_wait_argv x11vnc)"
t  'T10d (control) x11vnc recorded its argv, so the two arms below are graded' \
   'yes' "$(nonempty "$VNC_ARGV_D")"
tc 'T10d ...which x11vnc was handed as a FILE, never in argv' '-passwdfile' "$VNC_ARGV_D"
tn 'T10d ...so the password itself never reaches /proc/<pid>/cmdline' \
   "$REDEEMED_PW" "$VNC_ARGV_D"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10e A REPLAY OF THE SAME LINK IS REFUSED' 77 "$RC"
tc 'T10e ...saying so in words a customer can act on' 'already been used' "$ERR"

# --- T10f expiry --------------------------------------------------------------
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=60
NONCE2="${OUT##*/}"
python3 - "$VDIR/.5dive-viewer.ticket" <<'EXPIRE'
import sys,re,time
p=sys.argv[1]; s=open(p).read()
open(p,'w').write(re.sub(r'^expires_at=.*$','expires_at=%d'%(time.time()-1),s,flags=re.M))
EXPIRE
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE2' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10f AN EXPIRED LINK IS REFUSED even with the right nonce' 77 "$RC"
tc 'T10f ...and says the browser session itself survived' 'untouched' "$ERR"

# --- T10g the binding ---------------------------------------------------------
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
NONCE3="${OUT##*/}"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE3' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-B"
t  'T10g A VALID LINK IN A DIFFERENT SESSION IS REFUSED' 77 "$RC"
tc 'T10g ...naming the reason, because this is the pasted-link case' 'different dashboard session' "$ERR"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE3' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10g ...and the failed attempt did NOT consume it for the rightful session' 0 "$RC"

# --- T10h the nonce never goes in argv ---------------------------------------
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
NONCE4="${OUT##*/}"
# stdin from /dev/null on purpose: a MUTANT that accepts the argv nonce falls
# through to the stdin read, and an arm that hangs on a regression is an arm that
# hangs CI instead of failing it.
run env PATH="$SPATH" bash -c "'$BROWSER' viewer-redeem viewsite '--nonce=$NONCE4' --session=sess-A < /dev/null"
t  'T10h A NONCE PASSED IN ARGV IS REFUSED, not quietly accepted' 64 "$RC"
tc 'T10h ...naming why' '/proc/<pid>/cmdline' "$ERR"

# --- T10i a wrong nonce -------------------------------------------------------
run env PATH="$SPATH" bash -c "printf '%s' 'deadbeef' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10i a wrong nonce is refused' 77 "$RC"
tn 'T10i ...without leaking the real one' "$NONCE4" "$ERR$OUT"

# --- T10j revoke --------------------------------------------------------------
run env PATH="$SPATH" "$BROWSER" viewer-revoke viewsite
t  'T10j revoke exits 0' 0 "$RC"
tc 'T10j ...and says the login SURVIVES the view dying' 'stays logged in' "$OUT"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE4' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10j A REVOKED LINK IS DEAD' 77 "$RC"

# --- T10k binding is mandatory ------------------------------------------------
run env PATH="$SPATH" "$BROWSER" viewer viewsite --ttl=600
t  'T10k AN UNBOUND TICKET CANNOT BE MINTED AT ALL' 64 "$RC"
tc 'T10k ...and the escape is explicit, never implicit' '--bind=local' "$ERR"
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=99999
t  'T10k a ttl past the re-auth window is refused' 64 "$RC"

# --- T10m NOTHING LISTENS OFF-BOX, measured on the argv the fakes recorded -----
# This is the property the README and the design note LEAD with, and until the
# fakes recorded argv it was graded by zero arms. Each assertion below is the
# mutant it kills: drop -localhost and x11vnc answers every seat on the box;
# bind websockify to 0.0.0.0 and the bridge is reachable from the internet; drop
# -nolisten tcp and the X display itself is an unauthenticated remote keyboard.
_reset_argv x11vnc websockify
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=900
t  'T10m viewer mints (fixture for the argv arms)' 0 "$RC"
NONCE5="${OUT##*/}"
VNC_ARGV="$(_wait_argv x11vnc)"; WS_ARGV="$(_wait_argv websockify)"; X_ARGV="$(_wait_argv Xvfb)"
t  'T10m (control) x11vnc recorded its argv'     'yes' "$(nonempty "$VNC_ARGV")"
t  'T10m (control) websockify recorded its argv' 'yes' "$(nonempty "$WS_ARGV")"
t  'T10m (control) Xvfb recorded its argv'       'yes' "$(nonempty "$X_ARGV")"
tc 'T10m x11vnc IS BOUND TO LOOPBACK'                 '-localhost'   "$VNC_ARGV"
tc 'T10m ...and accepts exactly one client'           '-once'        "$VNC_ARGV"
tc 'T10m the websocket bridge LISTENS ON 127.0.0.1'   '127.0.0.1:'   "$WS_ARGV"
tn 'T10m ...and never on every interface'             '0.0.0.0'      "$WS_ARGV"
tc 'T10m ...bridging to a loopback VNC port, not a routable one' '127.0.0.1:' "${WS_ARGV#* }"
tc 'T10m THE X DISPLAY REFUSES TCP ENTIRELY'          '-nolisten tcp' "$X_ARGV"

# --- T10n the VNC timeout IS the ticket TTL -----------------------------------
# x11vnc -timeout n exits unless a client connects inside the first n seconds. A
# hardcoded 30 meant the viewer was dead half a minute into a ticket that
# advertises 60-3600s, while redemption still exited 0 and SPENT the ticket: the
# customer gets a used-up link and a port with nothing behind it. The window the
# ticket promises and the window x11vnc honours must be one number.
tc 'T10n x11vnc is given the TICKET TTL, not a constant shorter than the minimum' \
   '-timeout 900' "$VNC_ARGV"
_reset_argv x11vnc
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=60
VNC_ARGV_N="$(_wait_argv x11vnc)"
t  'T10n (control) the second mint recorded a FRESH argv, not the one before it' \
   'yes' "$(nonempty "$VNC_ARGV_N")"
tc 'T10n ...and it TRACKS the ttl rather than matching one value by luck' \
   '-timeout 60' "$VNC_ARGV_N"

# --- T10o a spent ticket is not an oracle ------------------------------------
# The design note claims the spent-state check runs BEFORE the nonce compare. Move
# the compare first and every other arm still passes (measured 125/0): the only
# thing that changes is WHICH refusal a used ticket gives to a WRONG nonce — and
# that difference is exactly the oracle. A dead ticket must not grade guesses.
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
NONCE6="${OUT##*/}"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE6' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10o (fixture) the ticket is spent' 0 "$RC"
run env PATH="$SPATH" bash -c "printf '%s' 'deadbeef' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10o a WRONG nonce on a SPENT ticket is refused' 77 "$RC"
tc 'T10o ...for being spent, so it cannot answer "was that the right nonce"' \
   'already been used' "$ERR"
tn 'T10o ...and never grades the guess' 'not valid for' "$ERR"

# --- T10p stopping the browser takes the ticket with it -----------------------
# A ticket that outlives its viewer redeems 0 onto a dead port — the same
# customer-facing failure as the timeout bug, arriving by a different door.
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
NONCE7="${OUT##*/}"
run env PATH="$SPATH" DISPLAY= "$BROWSER" serve viewsite --stop
t  'T10p serve --stop exits 0' 0 "$RC"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE7' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10p A TICKET DOES NOT SURVIVE THE BROWSER IT VIEWS' 77 "$RC"
t  'T10p ...and the VNC password is not left behind in the profile' 'no' \
   "$([[ -f "$VDIR/.5dive-viewer.pw" ]] && echo yes || echo no)"
t  'T10p ...while the PROFILE ITSELF survives — the durable half' 'yes' \
   "$([[ -d "$VDIR" ]] && echo yes || echo no)"
env PATH="$SPATH" DISPLAY= "$BROWSER" serve viewsite >/dev/null 2>&1 || true

# --- T10q A REPLAY DOES NOT KILL THE LIVE VIEWER ------------------------------
# The spent-state check is hoisted above the session binding and the nonce compare
# for a LEAK reason (T10o). That hoist also puts it ahead of everything that
# establishes the caller is anyone at all, so any side effect attached to it fires
# for a call carrying NO valid nonce and NO valid session — naming the site is the
# entire cost of entry. When that side effect was _viewer_stop, one such call
# killed the customer's LIVE viewer and deleted its credential: exactly the denial
# the binding exists to prevent (design note §4, "a wrong-session attempt does not
# spend the ticket for the rightful one"). The likeliest trigger was never an
# attacker but the customer's own phone reloading the viewer URL mid-login. A
# refusal hoisted for a leak reason must be PURE: compute, die, touch nothing.
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10q viewer mints onto the live browser' 0 "$RC"
NONCE8="${OUT##*/}"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE8' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10q the customer redeems it legitimately' 0 "$RC"
t  'T10q ...and the viewer they are now looking at is LIVE' 'live' "$(vnc_state)"
run env PATH="$SPATH" bash -c "printf '%s' 'totally-wrong-nonce' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-EVIL"
t  'T10q a replay with a WRONG nonce AND a WRONG session is refused' 77 "$RC"
t  'T10q ...AND THE CUSTOMER IS STILL LOOKING AT THEIR VIEWER' 'live' "$(vnc_state)"
t  'T10q ...and its credential was not deleted out from under them' 'yes' \
   "$([[ -s "$VDIR/.5dive-viewer.pw" ]] && echo yes || echo no)"
tc 'T10q ...and the refusal SAYS the session survived, so the customer waits instead of re-logging in' \
   'untouched' "$ERR"

# --- T10r a viewer with no credential REFUSES WITHOUT SPENDING THE TICKET -----
# Redemption reads the VNC password BEFORE it consumes the ticket, so a viewer
# whose credential is gone cannot burn the customer's one-time link merely to
# report that it is gone. The die string PROMISES "The ticket was NOT spent" —
# until these arms nothing checked the promise was kept: moving the consume ahead
# of the read passed all 147 other arms, the same unmeasured-claim shape as T10m.
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10r viewer mints' 0 "$RC"
NONCE9="${OUT##*/}"
PW_SAVED="$(cat "$VDIR/.5dive-viewer.pw")"
rm -f "$VDIR/.5dive-viewer.pw"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE9' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10r a redemption onto a viewer with no credential is refused' 69 "$RC"
tc 'T10r ...because a target without its password is a port nobody can enter' 'credential is gone' "$ERR"
t  'T10r THE TICKET IS STILL OPEN — the refusal did not spend it' 'state=open' \
   "$(grep '^state=' "$VDIR/.5dive-viewer.ticket")"
# An EMPTY credential file is the same customer outcome through a different door.
( umask 077; : > "$VDIR/.5dive-viewer.pw" )
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE9' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10r an EMPTY credential file is refused too' 69 "$RC"
t  'T10r ...and also leaves the ticket open' 'state=open' \
   "$(grep '^state=' "$VDIR/.5dive-viewer.ticket")"
# ...and "not spent" only means anything if the SAME link still works afterwards.
( umask 077; printf '%s\n' "$PW_SAVED" > "$VDIR/.5dive-viewer.pw" )
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE9' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10r AND THE SAME NONCE REDEEMS AFTERWARDS' 0 "$RC"
tc 'T10r ...handing over the credential it could not find a moment ago' "password=$PW_SAVED" "$OUT"

# --- T10s A LINK IS NEVER ISSUED ONTO A BRIDGE THAT IS NOT LISTENING YET ------
# The mint starts x11vnc and websockify in the BACKGROUND and returns. "Started"
# and "accepting" are two different moments, and the product's own shape is a
# one-time link handed to a relay that redeems it AT ONCE — dashboard mints,
# relay redeems, customer's phone connects. Redeem inside that window and the
# relay is handed 127.0.0.1:<port> with nothing behind it: a blank viewer and a
# SPENT link, the same customer-facing failure as the old hardcoded -timeout,
# reached by a race instead of by a constant. These arms read /proc rather than
# connecting, because connecting is itself the single admission x11vnc -once
# gives the customer.
_reset_argv x11vnc websockify
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10s viewer mints' 0 "$RC"
NONCE10="${OUT##*/}"
PORT10="$(sed -n 's/^port=//p' "$VDIR/.5dive-viewer.ticket")"
t  'T10s (control) the ticket names a bridge port' 'yes' "$(nonempty "$PORT10")"
t  'T10s BY THE TIME THE LINK EXISTS, THE BRIDGE IS ALREADY ACCEPTING' \
   'listening' "$(port_state "$PORT10")"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE10' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10s a relay that redeems the INSTANT it gets the link is served' 0 "$RC"
TGT10="$(sed -n 's/^target=127.0.0.1://p' <<<"$OUT")"
t  'T10s ...and the target it was handed has something on it' 'listening' "$(port_state "$TGT10")"

# The mutant: a bridge that never binds. Without the wait, this mints a ticket
# and exits 0 onto a dead port — the failure above, made permanent.
NOBIND="$TMP/nobind"; mkdir -p "$NOBIND"
cat > "$NOBIND/websockify" <<WS
#!/usr/bin/env bash
printf '%s\\n' "\$*" > "$ARGV/websockify.argv"
exec sleep 300
WS
chmod +x "$NOBIND/websockify"
# An OPEN ticket is left standing on purpose: the failing mint kills the viewer
# that ticket points at, so it must take the ticket with it. Otherwise the
# customer holds a live one-time link to a viewer that no longer exists — the
# dead-port failure again, now reached by a mint that FAILED.
_reset_argv x11vnc websockify
run env PATH="$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10s (fixture) an OPEN ticket stands before the failing mint' 'state=open' \
   "$(grep '^state=' "$VDIR/.5dive-viewer.ticket")"
NONCE11="${OUT##*/}"
_reset_argv websockify
run env PATH="$NOBIND:$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=600
t  'T10s A BRIDGE THAT NEVER BINDS ISSUES NO LINK AT ALL' 69 "$RC"
t  'T10s (control) it really was started, it just never listened' 'yes' \
   "$(nonempty "$(_wait_argv websockify)")"
tn 'T10s ...so there is no nonce for a relay to redeem' '/browser/viewer/' "$OUT"
tc 'T10s ...and the refusal names what did not come up' 'never started listening' "$ERR"
t  'T10s ...no ticket is left OPEN onto the dead port' 'no' \
   "$(grep -q '^state=open' "$VDIR/.5dive-viewer.ticket" && echo yes || echo no)"
t  'T10s ...the half-started viewer was reaped, not left running' 'dead' "$(vnc_state)"
t  'T10s ...its credential did not survive the failed mint' 'no' \
   "$([[ -f "$VDIR/.5dive-viewer.pw" ]] && echo yes || echo no)"
run env PATH="$SPATH" bash -c "printf '%s' '$NONCE11' | '$BROWSER' viewer-redeem viewsite --nonce=- --session=sess-A"
t  'T10s ...AND THE TICKET THAT WAS STANDING BEFORE IT DIED WITH THE VIEWER' 77 "$RC"
t  'T10s ...and the BROWSER survives, because a failed view is not a lost login' '0' \
   "$(env PATH="$SPATH" bash -c '
        f='"$VDIR"'/.5dive-serve; kill -0 "$(sed -n s/^chrome_pid=//p "$f")" 2>/dev/null && echo 0 || echo 1')"

# --- T10t THE TICKET NEVER ADVERTISES MORE LIFE THAN THE VNC SERVER WAS GIVEN --
# `x11vnc -timeout <n>` is a LENGTH, counted from the moment x11vnc starts. The
# ticket's expires_at is an INSTANT, and it was stamped AFTER the bridge wait —
# bounded at VIEWER_BRIDGE_WAIT_S — so on a slow bridge the ticket outlived the
# viewer it names by up to that much. On a 60s ttl that is 17% of the advertised
# life, and those last seconds are the iteration-1 failure arriving by a different
# road: redemption succeeds, spends the customer's one link, and hands over a port
# whose x11vnc has already exited. Two clocks, one length. The arm is the
# DIFFERENCE between them, so it needs a bridge slow enough for them to diverge —
# against an instant bridge this property is untestable, which is why the drift
# control below is an arm and not a comment.
SLOWBIN="$TMP/slowbridge"; mkdir -p "$SLOWBIN"
cat > "$SLOWBIN/websockify" <<WS
#!/usr/bin/env bash
printf '%s\\n' "\$*" > "$ARGV/websockify.argv"
sleep 3
exec python3 -c '$listen_forever' "\${1##*:}"
WS
chmod +x "$SLOWBIN/websockify"
_reset_argv x11vnc websockify
TTL10T=60
run env PATH="$SLOWBIN:$SPATH" "$BROWSER" viewer viewsite --bind=sess-A --ttl=$TTL10T
t  'T10t a viewer mints even though the bridge took its time coming up' 0 "$RC"
XSTART="$(cat "$ARGV/x11vnc.start" 2>/dev/null)"
EXP10T="$(sed -n 's/^expires_at=//p' "$VDIR/.5dive-viewer.ticket")"
t  'T10t (control) x11vnc recorded WHEN it started' 'yes' "$(nonempty "$XSTART")"
t  'T10t (control) the ticket carries an expiry to compare it against' 'yes' "$(nonempty "$EXP10T")"
t  'T10t (control) THE BRIDGE REALLY WAS SLOW, so the two clocks had room to drift' 'yes' \
   "$([[ $(( $(date -u +%s) - ${XSTART:-0} )) -ge 2 ]] && echo yes || echo no)"
t  'T10t THE TICKET DIES NO LATER THAN THE VNC SERVER IT POINTS AT' 'yes' \
   "$([[ $(( ${EXP10T:-0} - ${XSTART:-0} )) -le $TTL10T ]] && echo yes || echo no)"
t  'T10t ...and no shorter, so the customer keeps the window they were promised' 'yes' \
   "$([[ $(( ${EXP10T:-0} - ${XSTART:-0} )) -ge $(( TTL10T - 2 )) ]] && echo yes || echo no)"
tc 'T10t ...and the VNC server was given that same length, not a padded one' \
   "-timeout $TTL10T" "$(_wait_argv x11vnc)"
# The viewer this arm left standing is reaped so the next section starts clean.
run env PATH="$SPATH" "$BROWSER" viewer-revoke viewsite

# --- T10c a box without the packages says so, and starts nothing --------------
mkprofile barebox "$LIVE_DOM" >/dev/null
# This host HAS Xvfb, so "a bare box" has to be constructed rather than assumed:
# a PATH of everything except the three server-mode packages. Trimming PATH to
# /usr/bin silently passed this arm against a box that had them.
MINBIN="$TMP/minbin"; mkdir -p "$MINBIN"
for b in /usr/bin/* /bin/*; do
  case "${b##*/}" in Xvfb|x11vnc|websockify|chrom*|google-chrome*) continue ;; esac
  [[ -x "$b" ]] && ln -sf "$b" "$MINBIN/${b##*/}" 2>/dev/null
done
t 'T10c ...(control) the bare-box PATH really has no Xvfb' 'no' \
  "$(PATH="$FAKEBIN:$MINBIN" command -v Xvfb >/dev/null 2>&1 && echo yes || echo no)"
run env PATH="$FAKEBIN:$MINBIN" "$BROWSER" serve barebox
t  'T10c serve on a box with no Xvfb fails closed' 69 "$RC"
tc 'T10c ...naming what is missing' 'Xvfb' "$ERR"
t  'T10c ...and leaves no half-started state behind' 'no' \
   "$([[ -f "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/barebox/.5dive-serve" ]] && echo yes || echo no)"
tc 'T10c ...refusing on the PRECONDITION, not on a launch that then failed' \
   'cannot run a server-mode browser' "$ERR"
# The missing-Xvfb arm alone does NOT grade the precondition: with it deleted,
# Xvfb-not-on-PATH still dies at the "did not start" check with the same exit
# status and the same word in the message. A box that has Xvfb and NO chromium
# is the case that separates them — without the precondition the chrome launch
# runs with an empty binary name and a pidfile is written for a browser that was
# never started, which is exactly "the tile says connected and nothing is there".
mkprofile nochrome "$LIVE_DOM" >/dev/null
run env PATH="$MINBIN:$SBIN" "$BROWSER" serve nochrome
t  'T10c2 a box with a display server but no chromium fails closed' 69 "$RC"
tc 'T10c2 ...naming chromium' 'chromium' "$ERR"
t  'T10c2 ...and writes NO pidfile for a browser that never started' 'no' \
   "$([[ -f "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/nochrome/.5dive-serve" ]] && echo yes || echo no)"

# --- T10l a profile this seat cannot own is refused BEFORE any of this --------
BADV="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/loosev"; mkdir -p "$BADV"; chmod 755 "$BADV"
run env PATH="$SPATH" "$BROWSER" serve loosev
t  'T10l a group-readable profile is refused by serve, not repaired' 77 "$RC"
run env PATH="$SPATH" "$BROWSER" viewer loosev --bind=sess-A
t  'T10l ...and by viewer' 77 "$RC"
chmod 700 "$BADV"

env PATH="$SPATH" "$BROWSER" serve viewsite --stop >/dev/null 2>&1 || true

# =========== T11/T12/T13 the Connected-sites tile shows a state a customer can trust (DIVE-4426)
#
# The tile on production reads exactly what `status`/`ls` print, so every arm here
# is a MUTANT of a way that tile lies to the person who just logged in. All three
# were OBSERVED on exact-swallow 2026-09-13, in the order a customer meets them.
#
# The fixtures below need no adapter, so they must not reuse the shared PATH fake
# from the top of the file for the URL arms — that one ignores argv, and the URL
# IS the defect in T12. A recording fake is used there instead, and its negative
# control (T12b) is the same fake on a bare name.
export PATH="$FAKEBIN:$PATH"

# --- T11 no adapter means no verdict -----------------------------------------
# `authenticated` is a CLAIM about a login. The only thing that can support it is
# the adapter's logged-out marker, and with no adapter the logged-out test is
# skipped entirely — so before this row every page that merely LOADED was stamped
# `authenticated`, including profiles nobody had ever logged into. The mutant is
# not a wrong string; it is a tile that says "connected" about an empty profile.
mkprofile noadapter "$LIVE_DOM" >/dev/null
rm -f "$FIVEDIVE_BROWSER_ADAPTER_DIR/noadapter.json"
run "$BROWSER" status noadapter
t  'T11a status on a site with no adapter stays quiet at the scheduler' 0 "$RC"
tn 'T11a ...and NEVER claims a login it cannot see' 'authenticated' "$OUT"
tc 'T11a ...naming what it could not tell'          'UNKNOWN' "$OUT"
tc 'T11a ...and what would fix it'                  'no adapter' "$OUT"

run "$BROWSER" ls
tn 'T11b ...and the stamp the tile reads is not "authenticated" either' 'noadapter             authenticated' "$OUT"
tc 'T11b ...it is the honest state'                                     'unknown' "$OUT"

# T11c — the fix must not blind the one classification that DOES work with no
# adapter. The challenge marker has a built-in default, so a challenge page is
# nameable without an adapter, and collapsing the whole no-adapter path to UNKNOWN
# would throw that away: the customer sitting in front of a CAPTCHA would be told
# "we cannot tell" instead of "go clear this".
mkprofile noadapterchal "$CHALLENGE_DOM" >/dev/null
rm -f "$FIVEDIVE_BROWSER_ADAPTER_DIR/noadapterchal.json"
run "$BROWSER" status noadapterchal
t  'T11c a challenge is still named with no adapter' 75 "$RC"
tc 'T11c ...as a challenge'                          'CHALLENGE' "$OUT"

# T11d — the positive control for the whole block: an adapter WITH a marker still
# reaches `authenticated`. Without this, T11a passes on a build that simply never
# says the word, which is a different and equally broken product.
t 'T11d positive control: with an adapter, a live profile is still authenticated' 'authenticated' \
  "$(run "$BROWSER" status x; printf '%s' "$OUT" | grep -o authenticated | head -1)"

# --- T12 a dotted profile name is a HOST, not a label to suffix ---------------
# `_site_url` guessed `https://<name>.com/`. The dashboard contract (GET
# /server/browser/sites, the tile's button, the seeded profiles) uses `reddit.com`
# — so serve opened `https://reddit.com.com/`, a parked domain that 302'd the
# customer's viewer onto a random subreddit instead of a login page, and status
# probed the same wrong host. The URL is not observable from status output, so
# this fake RECORDS the address it was handed.
URLBIN="$TMP/urlbin"; mkdir -p "$URLBIN"
cat > "$URLBIN/google-chrome" <<'UCHROME'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in --user-data-dir=*) d="${a#*=}" ;; -*) ;; *) u="$a" ;; esac
done
printf '%s\n' "${u:-NONE}" >> "$URLLOG"
cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null || echo "<html><body>feed</body></html>"
UCHROME
chmod +x "$URLBIN/google-chrome"
export URLLOG="$TMP/urls.txt"

mkprofile reddit.com "$LIVE_DOM" >/dev/null
rm -f "$FIVEDIVE_BROWSER_ADAPTER_DIR/reddit.com.json" "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" status reddit.com
t  'T12a a dotted name is probed as the host it names' 'https://reddit.com/' "$(head -1 "$URLLOG")"
tn 'T12a ...and never as <name>.com.com'               '.com.com' "$(cat "$URLLOG")"

# T12b — the negative control, and it is what keeps T12a from being "strip a
# suffix": a bare label has no host in it and still gets the guess it always had.
mkprofile bareword "$LIVE_DOM" >/dev/null
rm -f "$FIVEDIVE_BROWSER_ADAPTER_DIR/bareword.json" "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" status bareword
t 'T12b a bare label still gets the .com guess' 'https://bareword.com/' "$(head -1 "$URLLOG")"

# T12c — an adapter's declared probe.url outranks both guesses. mkadapter writes
# https://<site>.test/feed, which neither branch above could produce.
mkprofile dotted.site "$LIVE_DOM" >/dev/null
mkadapter dotted.site "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" status dotted.site
t 'T12c the adapter probe.url outranks the guess' 'https://dotted.site.test/feed' "$(head -1 "$URLLOG")"

# --- T13 a served profile cannot be probed by a SECOND browser ----------------
# Chrome enforces one instance per user-data-dir (SingletonLock). The probe's
# --headless --dump-dom hands its URL to the running instance and exits with an
# empty document, which read as "UNKNOWN (probe did not load)" — a blank verdict
# during EXACTLY the window in which the customer has just logged in through the
# viewer. The mutant this arm kills: a second Chrome launched at all.
mkprofile served "$LIVE_DOM" >/dev/null
SERVEDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/served"
printf '%s' 'authenticated-from-before' > "$SERVEDIR/.5dive-liveness"
sleep 300 & SXPID=$!
sleep 300 & SCPID=$!
( umask 077; printf 'display=137\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$SXPID" "$SCPID" "$(date -u +%s)" > "$SERVEDIR/.5dive-serve" )
rm -f "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" status served
t  'T13a status on a served profile launches NO second browser' 'none' \
   "$([[ -s "$URLLOG" ]] && cat "$URLLOG" || echo none)"
t  'T13a ...and stays quiet at the scheduler'  0 "$RC"
tc 'T13a ...naming the display that holds it'  ':137' "$OUT"
tc 'T13a ...and saying why it cannot look'     'cannot open a profile' "$OUT"
tn 'T13a ...never claiming a login it did not check' 'authenticated (checked' "$OUT"

# T13b — the served branch must not OVERWRITE the last real verdict. The liveness
# stamp is the tile's memory; replacing "authenticated at 09:19Z" with "served"
# would lose the only true thing we knew about this profile in order to report a
# transient condition.
t 'T13b ...and leaves the last real verdict standing' 'authenticated-from-before' \
  "$(cat "$SERVEDIR/.5dive-liveness")"

# T13c — the negative control: the SAME profile with the serve pidfile gone is
# probed normally. Without it, T13a passes on a build that never probes anything.
rm -f "$SERVEDIR/.5dive-serve" "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" status served
t 'T13c ...while an unserved profile is probed as usual' 'https://served.com/' "$(head -1 "$URLLOG")"
kill "$SXPID" "$SCPID" 2>/dev/null

# T13d — one served and one ordinary profile in the SAME sweep. This prevents
# both easy false greens: probing a profile whose browser is holding it, and
# aborting the whole sweep after encountering that profile.
printf '%s' 'authenticated-from-before' > "$SERVEDIR/.5dive-liveness"
sleep 300 & SXPID=$!
sleep 300 & SCPID=$!
( umask 077; printf 'display=138\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$SXPID" "$SCPID" "$(date -u +%s)" > "$SERVEDIR/.5dive-serve" )
mkprofile scheduled.example "$LIVE_DOM" >/dev/null
mkadapter scheduled.example "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/scheduled.example/.5dive-liveness" "$URLLOG"
run env PATH="$URLBIN:$PATH" URLLOG="$URLLOG" "$BROWSER" probe-all
t  'T13d probe-all finishes after checking every eligible profile' 0 "$RC"
tc 'T13d ...names the profile it skipped because it is served' 'served               skipped: served' "$OUT"
t  'T13d ...does not launch Chrome against the served profile' 'no' \
   "$([[ -s "$URLLOG" ]] && grep -q 'https://served.com/' "$URLLOG" && echo yes || echo no)"
t  'T13d ...does probe an unserved profile in the same sweep' 'yes' \
   "$([[ -s "$URLLOG" ]] && grep -q 'https://scheduled.example.test/feed' "$URLLOG" && echo yes || echo no)"
t  'T13d ...leaves the served profile stamp untouched' 'authenticated-from-before' \
   "$(cat "$SERVEDIR/.5dive-liveness")"
tc 'T13d ...and stamps the eligible profile' 'authenticated' \
   "$(cat "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/scheduled.example/.5dive-liveness")"
rm -f "$SERVEDIR/.5dive-serve"
kill "$SXPID" "$SCPID" 2>/dev/null

# --- T14 DIVE-4446: the workflow doc, and the half of the fleet that is not Claude
# WHY THESE ARE MUTANT-SHAPED. "A skill file exists" grades nothing: the failure
# this row exists to prevent is an agent that runs every command correctly and
# still burns the customer's one-time link, or a codex seat that never sees the
# rule at all because it shipped only as a Claude skill. So each arm below is the
# specific defect: an undeclared skill capability (the plugin installs, the skill
# is silently never registered — contract §2), a doc that dropped the rule, and a
# naive `cat >>` appender that stacks a second, divergent copy on every upgrade.
SKILL="$ROOT/plugins/browser/skills/connect-site/SKILL.md"
DOCF="$ROOT/plugins/browser/AGENTS.md"
MANIFEST="$ROOT/plugins/browser/.claude-plugin/plugin.json"

t  'T14a the connect-site skill ships with the plugin' 'yes' \
   "$([[ -f "$SKILL" ]] && echo yes || echo no)"
SKILLTXT="$(cat "$SKILL" 2>/dev/null)"
tc 'T14a ...with frontmatter naming it' 'name: connect-site' "$SKILLTXT"
# The description is the whole trigger surface: a skill that does not fire is a
# skill that does not exist.
tc 'T14a ...firing on "log in to <site>"' 'log in to' "$SKILLTXT"
tc 'T14a ...firing on a seat that needs a logged-in account' 'logged-in' "$SKILLTXT"
tc 'T14a ...and on the box-browser phrasing' 'open a browser on the box' "$SKILLTXT"

# The rule the row is named after, in BOTH texts.
for pair in "skill:$SKILL" "doc:$DOCF"; do
  W="${pair%%:*}"; F="${pair#*:}"; TXT="$(cat "$F" 2>/dev/null)"
  tc "T14b the $W carries the link-is-the-human's rule" 'spent by the first successful GET' "$TXT"
  tc "T14b ...the $W says to diagnose from the journal" 'journalctl -u shelld' "$TXT"
  tc "T14b ...naming the redeem events ($W)" 'viewer_redeemed' "$TXT"
  tc "T14b ...naming the denial event ($W)" 'viewer_denied' "$TXT"
  tc "T14b ...the $W has the full flow, ending in revoke" 'viewer-revoke' "$TXT"
  tc "T14b ...the $W says --bind is mandatory" 'mandatory' "$TXT"
  tc "T14b ...the $W keeps the not-anti-bot line" 'anti-bot bypassing' "$TXT"
  # DIVE-4446 iteration 2: anchored on the RULE, not on one phrasing. The old arm
  # grepped the single literal 'open the link to verify', so a reword to 'curl the
  # link to check' passed it. Two arms now: the prohibition must still ENUMERATE
  # the ways of spending the ticket, and no instructing phrasing of
  # <request> the link <to verify> may survive anywhere unnegated.
  VERBS="$(_forbidden_spend_verbs "$F")"
  tc "T14b ...the $W forbids OPENING the link ($W)" 'open' "$VERBS"
  tc "T14b ...and forbids CURLing it ($W)" 'curl' "$VERBS"
  t  "T14b ...enumerating at least three ways of spending it, not one ($W)" 'yes' \
     "$([[ $(wc -w <<<"$VERBS") -ge 3 ]] && echo yes || echo no)"
  t  "T14b ...and no unnegated 'spend the link to check it' instruction survives ($W)" \
     'none' "$(_instructs_spend "$F")"
done

# A skills/ dir with no 'skill' capability installs clean and registers NOTHING
# (cmd_plugin.sh warns and moves on) — the silent half-ship this arm forbids.
t  'T14c the manifest declares the skill capability, or the skill is never registered' 'yes' \
   "$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("yes" if "skill" in d["fivedive"]["capabilities"] else "no")' "$MANIFEST" 2>/dev/null)"

# --- the harness-agnostic path: `doc` prints, `--append` installs -------------
run env PATH="$SPATH" "$BROWSER" doc
t  'T14d doc prints the workflow for a non-Claude seat' 0 "$RC"
tc 'T14d ...and it is the same text the plugin ships' 'spent by the first successful GET' "$OUT"

SEATDOC="$TMP/seat/AGENTS.md"; mkdir -p "$TMP/seat"
printf '# my seat\nkeep this line\n' > "$SEATDOC"
run env PATH="$SPATH" "$BROWSER" doc --append="$SEATDOC"
t  'T14e append into a seat instruction file succeeds' 0 "$RC"
tc 'T14e ...and does not eat what was already there' 'keep this line' "$(cat "$SEATDOC")"
tc 'T14e ...the rule is now in the seat file' 'spent by the first successful GET' "$(cat "$SEATDOC")"

# The mutant: `cat >> $target` passes every arm above and fails this one.
run env PATH="$SPATH" "$BROWSER" doc --append="$SEATDOC"
t  'T14f a second install is idempotent — exactly one fenced block' 1 \
   "$(grep -c '5dive:browser:begin' "$SEATDOC")"
t  'T14f ...and exactly one closing marker' 1 "$(grep -c '5dive:browser:end' "$SEATDOC")"
t  'T14f ...the seat text survives the rewrite' 1 "$(grep -c 'keep this line' "$SEATDOC")"

# An upgraded plugin must REPLACE the block, not leave two rules disagreeing.
NEWDOC="$TMP/newdoc.md"
{ echo '<!-- 5dive:browser:begin -->'; echo 'RULE-V2 the link is still the human'"'"'s'; echo '<!-- 5dive:browser:end -->'; } > "$NEWDOC"
run env PATH="$SPATH" FIVEDIVE_BROWSER_DOC="$NEWDOC" "$BROWSER" doc --append="$SEATDOC"
t  'T14g an upgrade replaces the old block' 1 "$(grep -c 'RULE-V2' "$SEATDOC")"
t  'T14g ...leaving no stale copy of the old one' 0 \
   "$(grep -c 'spent by the first successful GET' "$SEATDOC")"
t  'T14g ...still exactly one fence' 1 "$(grep -c '5dive:browser:begin' "$SEATDOC")"

run env PATH="$SPATH" "$BROWSER" doc --append="$TMP/nodir/AGENTS.md"
t  'T14h append refuses a path whose directory does not exist' 64 "$RC"
t  'T14h ...and creates nothing' 'no' \
   "$([[ -e "$TMP/nodir" ]] && echo yes || echo no)"
run env PATH="$SPATH" FIVEDIVE_BROWSER_DOC="$TMP/gone.md" "$BROWSER" doc
t  'T14i a plugin install missing its doc fails closed rather than printing nothing' 69 "$RC"

# --- T14j DIVE-4446 iteration 2: a BROKEN FENCE IS A REFUSAL ------------------
# The defect this arm exists for, measured on iteration 1: a target carrying a
# BEGIN with no END made the awk skip to end-of-input, so `cat $tmp > $target`
# wrote a file with every one of the seat's trailing lines gone — and printed
# "refreshed the browser section in <file>", rc 0. The file class here is
# hand-edited by definition (AGENTS.md, CLAUDE.md), and half a marker pair is the
# normal shape of a bad hand-edit, so this is not an exotic input. The arm asserts
# the three things that make it safe rather than merely different: non-zero rc,
# the file BYTE-IDENTICAL, and a receipt that NAMES the missing marker — that last
# one because the failure mode was a success message, and an operator who is told
# "done" does not go looking.
BROKEN="$TMP/seat/broken.md"
_mkbroken() { printf 'KEEP ME ABOVE\n%s\nstale\nKEEP ME BELOW\nAND MY OTHER SECTION\n' "$1" > "$BROKEN"; }

_mkbroken '<!-- 5dive:browser:begin -->'
cp "$BROKEN" "$BROKEN.before"
run env PATH="$SPATH" "$BROWSER" doc --append="$BROKEN"
t  'T14j a BEGIN with no END is refused, not rewritten' 64 "$RC"
t  'T14j ...and the file is byte-identical to before' 'same' \
   "$(cmp -s "$BROKEN" "$BROKEN.before" && echo same || echo CHANGED)"
tc 'T14j ...the refusal names the missing END marker' '5dive:browser:end' "$ERR"
tc 'T14j ...and names the file it refused to touch' "$BROKEN" "$ERR"
tn 'T14j ...and does NOT claim it refreshed anything' 'refreshed' "$OUT$ERR"
t  'T14j ...the seat text below the marker is still there' 2 \
   "$(grep -cE 'KEEP ME BELOW|AND MY OTHER SECTION' "$BROKEN")"

# The symmetric hand-edit: the END survived and the BEGIN was deleted. The old
# code took the append branch and silently dropped the orphan END line.
printf 'KEEP ME ABOVE\n<!-- 5dive:browser:end -->\nKEEP ME BELOW\n' > "$BROKEN"
cp "$BROKEN" "$BROKEN.before"
run env PATH="$SPATH" "$BROWSER" doc --append="$BROKEN"
t  'T14j an END with no BEGIN is refused too' 64 "$RC"
t  'T14j ...and that file is byte-identical as well' 'same' \
   "$(cmp -s "$BROKEN" "$BROKEN.before" && echo same || echo CHANGED)"
tc 'T14j ...naming the missing BEGIN marker' '5dive:browser:begin' "$ERR"

# Inverted pair: both markers present, END first. The awk would have eaten
# everything after BEGIN.
printf 'A\n<!-- 5dive:browser:end -->\nB\n<!-- 5dive:browser:begin -->\nKEEP ME LAST\n' > "$BROKEN"
cp "$BROKEN" "$BROKEN.before"
run env PATH="$SPATH" "$BROWSER" doc --append="$BROKEN"
t  'T14j an inverted marker pair is refused' 64 "$RC"
t  'T14j ...byte-identical' 'same' \
   "$(cmp -s "$BROKEN" "$BROKEN.before" && echo same || echo CHANGED)"
tc 'T14j ...and says which way round they are' 'inverted' "$ERR"

# Two fences: replacing "the" block is undefined, and the old awk emitted the doc
# twice.
{ echo '<!-- 5dive:browser:begin -->'; echo x; echo '<!-- 5dive:browser:end -->'
  echo mid
  echo '<!-- 5dive:browser:begin -->'; echo y; echo '<!-- 5dive:browser:end -->'; } > "$BROKEN"
cp "$BROKEN" "$BROKEN.before"
run env PATH="$SPATH" "$BROWSER" doc --append="$BROKEN"
t  'T14j two fences in one file are refused rather than guessed at' 64 "$RC"
t  'T14j ...byte-identical' 'same' \
   "$(cmp -s "$BROKEN" "$BROKEN.before" && echo same || echo CHANGED)"

# And the guard must not have cost us the good path: a well-formed pair with the
# seat's text on BOTH sides still refreshes in place.
GOOD="$TMP/seat/good.md"
{ echo 'ABOVE'; echo '<!-- 5dive:browser:begin -->'; echo 'old'
  echo '<!-- 5dive:browser:end -->'; echo 'BELOW'; } > "$GOOD"
run env PATH="$SPATH" "$BROWSER" doc --append="$GOOD"
t  'T14k a well-formed fence still refreshes' 0 "$RC"
t  'T14k ...text above survives' 1 "$(grep -c '^ABOVE$' "$GOOD")"
t  'T14k ...text below survives' 1 "$(grep -c '^BELOW$' "$GOOD")"
t  'T14k ...the stale body is gone' 0 "$(grep -c '^old$' "$GOOD")"
t  'T14k ...and there is still exactly one fence' 1 \
   "$(grep -c '5dive:browser:begin' "$GOOD")"

# === T15 DIVE-4488: `shot` — the act half, verb one ==========================
#
# The defect each arm kills, in one line each, because "it printed a path" grades
# nothing:
#   T15a/b  a PNG of the SIGN-IN PAGE handed back as the artifact. That is the
#           dangerous failure: it is not a crash, it is evidence-shaped and a
#           grader cannot tell it from the real thing. Positive list only.
#   T15c    a CDP port reintroduced to avoid the serve cycle — it would hand every
#           seat on the box full control of a logged-in profile, which no file
#           mode can take back. Measured on the argv, not on the comment.
#   T15d    a screenshot that stops a customer's browser WHILE A PERSON is logged
#           into it through the viewer.
#   T15e    a serve that a failed render leaves stopped.
#   T15f    one profile's name vouching for another site's page (a logged-out
#           render that reads as a bug in the feature).
#   T15g    an empty/absent PNG reported as a screenshot.
#   T15j    (iteration 2) a STALE PNG from an earlier render reported as this
#           one. T15g only grades the half where --out starts empty; `-s` is
#           true for the old file, so a chrome that writes nothing passes the
#           guard and the caller is handed yesterday's page under today's URL.
#
# The fake chrome here records FULL argv and, unlike the probe fakes, honours
# --screenshot by writing a file — otherwise every arm would red on T15g's check
# and none of the others would ever run.
SHOTBIN="$TMP/shotbin"; mkdir -p "$SHOTBIN"
cat > "$SHOTBIN/google-chrome" <<'SCHROME'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHOTARGV"
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) d="${a#*=}" ;;
    --screenshot=*) shot="${a#*=}" ;;
    --dump-dom) dump=1 ;;
    -*) ;;
    *) u="$a" ;;
  esac
done
[[ -n "${shot:-}" ]] && { [[ -n "${SHOT_CHROME_FAIL:-}" ]] || printf 'PNG %s\n' "${u:-}" > "$shot"; }
[[ -n "${dump:-}" || -z "${shot:-}" ]] && cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null
# FAIL is scoped to the RENDER invocation: the probe that runs first uses the
# same binary, and a fake that failed both would red at liveness and never reach
# the render at all — the arm would then grade nothing it claims to.
[[ -n "${SHOT_CHROME_FAIL:-}" && -n "${shot:-}" ]] && exit 3
exit 0
SCHROME
chmod +x "$SHOTBIN/google-chrome"
export SHOTARGV="$TMP/shot-argv.txt"
SHOTPATH="$SHOTBIN:$PATH"
SHOTOUT="$TMP/shots"; mkdir -p "$SHOTOUT"

# An adapter is what makes a verdict possible at all (T11): with none, _probe says
# UNKNOWN and shot must refuse. Both states are exercised below on the same site.
mkadapter shot.example.com "https://shot.example.com/x" "x"
SHOTDIR="$(mkprofile shot.example.com "$LIVE_DOM")"

# --- T15a the happy path ------------------------------------------------------
rm -f "$SHOTARGV"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/thread/1" --out="$SHOTOUT/a.png" --dom="$SHOTOUT/a.html"
t  'T15a a logged-in profile renders' 0 "$RC"
t  'T15a ...and the PNG exists and is non-empty' 'yes' \
   "$([[ -s "$SHOTOUT/a.png" ]] && echo yes || echo no)"
tc 'T15a ...of the URL asked for' 'https://shot.example.com/thread/1' "$(cat "$SHOTOUT/a.png")"
t  'T15a ...and the DOM was dumped too' 'yes' \
   "$([[ -s "$SHOTOUT/a.html" ]] && echo yes || echo no)"
tc 'T15a ...carrying the page body, which IS the read for a thread' 'posts' "$(cat "$SHOTOUT/a.html")"
tc 'T15a ...and the render ran inside the seat profile' "--user-data-dir=$SHOTDIR" "$(cat "$SHOTARGV")"

# --- T15b THE MUTANT: logged out must not render ------------------------------
# The row's own mutant. A build that drops the liveness gate passes every other
# arm here and fails only this one.
printf '%s' "$DEAD_DOM" > "$SHOTDIR/.fake-dom"
rm -f "$SHOTARGV" "$SHOTOUT/b.png"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/thread/1" --out="$SHOTOUT/b.png"
t  'T15b a logged-OUT profile REFUSES' 75 "$RC"
t  'T15b ...and writes no PNG at all' 'no' \
   "$([[ -e "$SHOTOUT/b.png" ]] && echo yes || echo no)"
tc 'T15b ...saying a sign-in screenshot is the lie, not the error' 'sign-in page' "$ERR"

printf '%s' "$CHALLENGE_DOM" > "$SHOTDIR/.fake-dom"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/c1.png"
t  'T15b a CHALLENGE refuses too' 75 "$RC"
t  'T15b ...writing nothing' 'no' "$([[ -e "$SHOTOUT/c1.png" ]] && echo yes || echo no)"

# No adapter -> UNKNOWN -> refusal. Not a special case: a guessed marker would
# stamp every logged-out page `authenticated`, which is T15b with our signature.
printf '%s' "$LIVE_DOM" > "$SHOTDIR/.fake-dom"
mv "$FIVEDIVE_BROWSER_ADAPTER_DIR/shot.example.com.json" "$TMP/adapter.bak"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/c2.png"
t  'T15b UNKNOWN (no adapter) refuses rather than rendering blind' 75 "$RC"
t  'T15b ...writing nothing' 'no' "$([[ -e "$SHOTOUT/c2.png" ]] && echo yes || echo no)"
mv "$TMP/adapter.bak" "$FIVEDIVE_BROWSER_ADAPTER_DIR/shot.example.com.json"

# --- T15c NO DEBUG PORT. This is the security claim, measured ------------------
rm -f "$SHOTARGV"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/d.png"
t  'T15c (control) the render recorded argv' 'yes' \
   "$([[ -s "$SHOTARGV" ]] && echo yes || echo no)"
tn 'T15c the render OPENS NO DEBUG PORT for another seat to take the session' \
   '--remote-debugging' "$(cat "$SHOTARGV")"
tc 'T15c ...and it is headless' '--headless' "$(cat "$SHOTARGV")"

# --- T15d a person inside the viewer is not evicted for a screenshot -----------
sleep 300 & VXPID=$!
sleep 300 & VCPID=$!
sleep 300 & VVNC=$!
( umask 077; printf 'display=311\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$VXPID" "$VCPID" "$(date -u +%s)" > "$SHOTDIR/.5dive-serve" )
( umask 077; printf 'vnc_pid=%s\nws_pid=%s\nport=1\nvnc_port=2\n' "$VVNC" "$VVNC" \
    > "$SHOTDIR/.5dive-viewer" )
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/e.png"
t  'T15d a LIVE VIEWER blocks the render instead of taking the human session away' 69 "$RC"
tc 'T15d ...and says why'  'being viewed by a person' "$ERR"
t  'T15d ...the serve pidfile is untouched'  'yes' \
   "$([[ -f "$SHOTDIR/.5dive-serve" ]] && echo yes || echo no)"
t  'T15d ...and the browser was NOT killed' 'alive' \
   "$(kill -0 "$VCPID" 2>/dev/null && echo alive || echo dead)"
kill "$VVNC" 2>/dev/null; wait "$VVNC" 2>/dev/null

# --- T15d2 a serve with NOBODY in it is cycled, and put back -------------------
# The vnc pid is dead now, so the viewer is not live: this is nobody's session.
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/f.png"
t  'T15d2 a served profile with no viewer renders' 0 "$RC"
t  'T15d2 ...the old browser was stopped' 'dead' \
   "$(kill -0 "$VCPID" 2>/dev/null && echo alive || echo dead)"
t  'T15d2 ...and a serve was put back, not left stopped' 'yes' \
   "$([[ -f "$SHOTDIR/.5dive-serve" ]] && echo yes || echo no)"
run env PATH="$SHOTPATH" "$BROWSER" serve shot.example.com --stop
kill "$VXPID" 2>/dev/null

# --- T15e a FAILED render still puts the serve back ---------------------------
# The mutant: restoring only on the success path. `die` exits, so a render that
# fails would leave the customer's browser stopped by a screenshot.
sleep 300 & FXPID=$!
sleep 300 & FCPID=$!
( umask 077; printf 'display=312\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$FXPID" "$FCPID" "$(date -u +%s)" > "$SHOTDIR/.5dive-serve" )
rm -f "$SHOTOUT/g.png"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" SHOT_CHROME_FAIL=1 "$BROWSER" \
    shot shot.example.com "https://shot.example.com/t" --out="$SHOTOUT/g.png"
t  'T15e a render that fails is a refusal, not a half-written PNG' 69 "$RC"
t  'T15e ...and the serve it stopped is back' 'yes' \
   "$([[ -f "$SHOTDIR/.5dive-serve" ]] && echo yes || echo no)"
run env PATH="$SHOTPATH" "$BROWSER" serve shot.example.com --stop
kill "$FXPID" "$FCPID" 2>/dev/null

# --- T15f the profile's name does not vouch for another site ------------------
rm -f "$SHOTARGV"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://elsewhere.test/page" --out="$SHOTOUT/h.png"
t  'T15f a URL on another host is refused' 64 "$RC"
tc 'T15f ...naming the host it saw' 'elsewhere.test' "$ERR"
t  'T15f ...and NO browser was launched to find out' 'none' \
   "$([[ -s "$SHOTARGV" ]] && cat "$SHOTARGV" || echo none)"
# A SUBDOMAIN is the point of consumer 1 (app.<product>.com behind the login).
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://app.shot.example.com/dash" --out="$SHOTOUT/i.png"
t  'T15f (control) a SUBDOMAIN of the profile site renders' 0 "$RC"
# Neither is a scheme we render.
run env PATH="$SHOTPATH" "$BROWSER" shot shot.example.com "file:///etc/passwd"
t  'T15f file:// is not a page of a site' 64 "$RC"
run env PATH="$SHOTPATH" "$BROWSER" shot shot.example.com "chrome://version"
t  'T15f chrome:// either' 64 "$RC"

# --- T15g an empty PNG is never reported as a screenshot ----------------------
# chrome exits 0 and writes nothing: the shape a "success" check on exit status
# alone would wave through.
cat > "$SHOTBIN/google-chrome" <<'SEMPTY'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHOTARGV"
for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#*=}" ;; --screenshot=*) shot="${a#*=}" ;; esac; done
[[ -n "${shot:-}" ]] && : > "$shot"
[[ -z "${shot:-}" ]] && cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null
exit 0
SEMPTY
chmod +x "$SHOTBIN/google-chrome"
rm -f "$SHOTOUT/j.png"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/j.png"
t  'T15g a zero-byte render is a failure, not a screenshot' 69 "$RC"
t  'T15g ...and the empty file is removed, never handed over' 'no' \
   "$([[ -e "$SHOTOUT/j.png" ]] && echo yes || echo no)"

# --- T15j a STALE PNG is never reported as this render ------------------------
# The other half of T15g's shape, and the one the first guard missed: chrome
# exits 0 and writes nothing while a file from an EARLIER render is already at
# --out. `-s "$out"` is true for that file, so the render guard passed and
# `shot` printed success over an image of a different page — the same lie as the
# sign-in PNG, and reached by the ordinary use: a grader re-rendering to the
# same path after a change.
#
# This stub accepts --screenshot and leaves it strictly alone.
cat > "$SHOTBIN/google-chrome" <<'SNOWRITE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHOTARGV"
for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#*=}" ;; --screenshot=*) shot="${a#*=}" ;; esac; done
[[ -z "${shot:-}" ]] && cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null
exit 0
SNOWRITE
chmod +x "$SHOTBIN/google-chrome"

# ANCHOR, and without it this arm grades nothing: prove the stub really is a
# non-writer by driving it DIRECTLY at a file with known bytes. If the stub
# wrote (or the fixture were empty), the arms below would pass for the wrong
# reason — the refusal would be T15g's zero-byte case wearing a new label.
STALEBYTES='PNG https://shot.example.com/YESTERDAY'
printf '%s\n' "$STALEBYTES" > "$TMP/stale-anchor.png"
env SHOTARGV="$TMP/stale-anchor-argv.txt" "$SHOTBIN/google-chrome" \
    --headless --screenshot="$TMP/stale-anchor.png" "https://shot.example.com/t" >/dev/null 2>&1
t  'T15j (anchor) the stub does not write --screenshot' "$STALEBYTES" \
   "$(cat "$TMP/stale-anchor.png")"

printf '%s\n' "$STALEBYTES" > "$SHOTOUT/stale.png"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/today" --out="$SHOTOUT/stale.png"
t  'T15j a render that wrote nothing over a stale file is a failure' 69 "$RC"
tn 'T15j ...and success is NOT reported over the old image' 'rendered' "$OUT"
t  'T15j ...and yesterday'"'"'s image is not left at --out to be picked up' 'no' \
   "$([[ -e "$SHOTOUT/stale.png" ]] && echo yes || echo no)"

# CONTROL — the fixture is non-degenerate: with a chrome that DOES write, the
# very same pre-existing file is replaced and the render succeeds. Without this,
# "refuse whenever --out exists" would pass every arm above.
cat > "$SHOTBIN/google-chrome" <<'SCHROME2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SHOTARGV"
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) d="${a#*=}" ;;
    --screenshot=*) shot="${a#*=}" ;;
    --dump-dom) dump=1 ;;
    -*) ;;
    *) u="$a" ;;
  esac
done
[[ -n "${shot:-}" ]] && printf 'PNG %s\n' "${u:-}" > "$shot"
[[ -n "${dump:-}" || -z "${shot:-}" ]] && cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null
exit 0
SCHROME2
chmod +x "$SHOTBIN/google-chrome"
printf '%s\n' "$STALEBYTES" > "$SHOTOUT/stale2.png"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/today" --out="$SHOTOUT/stale2.png"
t  'T15j (control) a real render over a stale file still succeeds' 0 "$RC"
t  'T15j (control) ...and the bytes at --out are THIS render, not the old one' \
   'PNG https://shot.example.com/today' "$(cat "$SHOTOUT/stale2.png")"

# --- T15h flags are validated before anything is launched ---------------------
run env PATH="$SHOTPATH" "$BROWSER" shot shot.example.com
t 'T15h a missing url is a usage error' 64 "$RC"
run env PATH="$SHOTPATH" "$BROWSER" shot shot.example.com "https://shot.example.com/t" --size=huge
t 'T15h --size must be WxH' 64 "$RC"
run env PATH="$SHOTPATH" "$BROWSER" shot ../escape "https://shot.example.com/t"
t 'T15h a traversing profile name is refused' 64 "$RC"

# --- T15i the verb is reachable and documented --------------------------------
run env PATH="$SHOTPATH" "$BROWSER" --help
tc 'T15i --help lists shot' '5dive browser shot' "$OUT"
tc 'T15i README documents it' 'browser shot' "$(cat "$ROOT/plugins/browser/README.md")"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
