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
# THIS SUITE LEAKS AN X SERVER PER RUN, AND ON A LONG-LIVED BOX THAT IS A RED ON
# AN UNCHANGED TREE (inherited from origin/main; fixed here under DIVE-4524
# because it is what made this row's own arms unverifiable). Several arms let
# bin/browser restore a serve, and a restore starts a REAL Xvfb whenever the fake
# is not on PATH. Nothing ever stopped it, and `_display_free` (bin/browser) keys
# on /tmp/.X11-unix/X<n> EXISTING rather than on a live pid — so every run left
# one more display AND one more socket behind, the serve arms walked further up
# the range each time, and after a few dozen runs the suite hung looking for a
# free display. Invisible in CI, where the runner is fresh.
#
# KILL ONLY OURS, and prove it twice: same uid, and not running before we started.
# Another seat's Xvfb on this box is a live browser someone may be logged into.
_XVFB_BEFORE=" $(pgrep -u "$(id -u)" -x Xvfb 2>/dev/null | tr '\n' ' ')"
_reap_xvfb() {
  local p n
  for p in $(pgrep -u "$(id -u)" -x Xvfb 2>/dev/null); do
    [[ "$_XVFB_BEFORE" == *" $p "* ]] && continue
    n=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | sed -n 's/.*Xvfb :\([0-9][0-9]*\).*/\1/p')
    kill "$p" 2>/dev/null
    # BOTH artefacts, and the lock is the one that bites: removing only the
    # socket leaves a display that `_display_free` reads as FREE and that Xvfb
    # then REFUSES to start on ("server is already active"), so the next run
    # fails with "Xvfb did not start" on an unchanged tree. Measured here.
    [[ -n "$n" && -O "/tmp/.X11-unix/X$n" ]] && rm -f "/tmp/.X11-unix/X$n"
    [[ -n "$n" && -O "/tmp/.X$n-lock" ]] && rm -f "/tmp/.X$n-lock"
  done
}
trap 'rc=$?; _reap_xvfb; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
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
for f in plugins/browser/.claude-plugin/plugin.json plugins/browser/README.md plugins/browser/bin/browser plugins/browser/adapters/example.json \
         plugins/browser/lib/extract.bundle.cjs plugins/browser/lib/extract.src.mjs plugins/browser/lib/pins.json; do
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

# DIVE-4519 iteration 2 — setup owns the schedule, and these arms DRIVE setup.
#
# WHY THE GREPS THEY REPLACE GRADED NOTHING. The first cut of T2c8 matched three
# strings inside _install_probe_timer's heredocs. Two anchored mutants, run at
# the graded sha, both left the suite green: deleting the `_install_probe_timer
# "$seat"` CALL from cmd_setup (the function, and every string it contains, stay
# in the file) and dropping `enable --now` from the systemctl chain (units get
# written and never started). Either one ships a fleet where no box ever probes
# itself — which is the entire "is it automatic?" claim this row answers. A grep
# over a heredoc cannot see a caller and cannot see an argv.
#
# So: run cmd_setup as a subprocess with the seams it already declares —
# FIVEDIVE_BROWSER_SYSTEMD_DIR at a tmp dir, FIVEDIVE_BROWSER_SYSTEMCTL at a
# stub that LOGS ITS ARGV, `id` faked to root, and a stub `5dive` on PATH so
# ExecStart is an exact string rather than whatever this runner happens to have
# installed — then assert on the files that land and the commands that ran.
SETUPBIN="$TMP/setupbin"; mkdir -p "$SETUPBIN"
REALID="$(command -v id)"
cat > "$SETUPBIN/id" <<ID
#!/usr/bin/env bash
# fake root for \`id -u\`, and ONLY for that: \`id -u <user>\` (setup's "is the
# seat a real uid" check) and \`id -un\` must still answer truthfully, or the arm
# grades the stub instead of setup.
[[ "\$*" == "-u" ]] && { echo 0; exit 0; }
exec "$REALID" "\$@"
ID
cat > "$SETUPBIN/systemctl" <<'SCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit "${SYSTEMCTL_RC:-0}"
SCTL
cat > "$SETUPBIN/5dive" <<'FIVE'
#!/usr/bin/env bash
exit 0
FIVE
chmod +x "$SETUPBIN/id" "$SETUPBIN/systemctl" "$SETUPBIN/5dive"

SDIR="$TMP/systemd"
SUNIT="$SDIR/5dive-browser-probe@.service"
STIMER="$SDIR/5dive-browser-probe@.timer"
export SYSTEMCTL_LOG="$TMP/systemctl.log"
: > "$SYSTEMCTL_LOG"
setup_run() {  # setup_run — drive a real cmd_setup into $TMP/setup-store
  run env PATH="$SETUPBIN:$PATH" \
      FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/setup-store" \
      FIVEDIVE_BROWSER_SYSTEMD_DIR="$SDIR" \
      FIVEDIVE_BROWSER_SYSTEMCTL=systemctl \
      SYSTEMCTL_LOG="$SYSTEMCTL_LOG" SYSTEMCTL_RC="${1:-0}" \
      "$BROWSER" setup
}

setup_run
t  'T2c8 setup exits 0'                                  0     "$RC"
tc 'T2c8 ...and still does its original job: the store'  'profile store ready' "$OUT"
t  'T2c8 ...seat store is 0700'                          '700' "$(stat -c '%a' "$TMP/setup-store/$SEAT" 2>/dev/null)"
# THE FIRST MUTANT: delete the _install_probe_timer call from cmd_setup. Nothing
# lands, and these two go red.
t  'T2c8 ...installs the probe service unit'             'yes' "$([[ -f "$SUNIT" ]] && echo yes || echo no)"
t  'T2c8 ...installs the probe timer unit'               'yes' "$([[ -f "$STIMER" ]] && echo yes || echo no)"
# THE SECOND MUTANT: drop `enable --now` from the systemctl chain. The units are
# written, the timer never starts, and only the argv can tell.
tc 'T2c8 ...enables AND starts the timer for THIS seat' "enable --now 5dive-browser-probe@$SEAT.timer" \
   "$(cat "$SYSTEMCTL_LOG")"
tc 'T2c8 ...after reloading the unit files it just wrote' 'daemon-reload' "$(cat "$SYSTEMCTL_LOG")"
# The service must run as the timer's instance seat, not as root: the profile
# store it sweeps is 0700 and owned by the seat.
tc 'T2c8 ...the service runs as the instance seat'        'User=%i' "$(cat "$SUNIT")"
# ExecStart is pinned to an absolute path AND to probe-all: a bare `status` with
# no site would try to probe a served profile and stamp it UNKNOWN.
tc 'T2c8 ...and execs probe-all by absolute path'  "ExecStart=$SETUPBIN/5dive browser probe-all" "$(cat "$SUNIT")"
# DIVE-4519 iteration 2 (b): Persistent= "only has an effect on timers configured
# with OnCalendar=" (systemd.timer(5)). The first cut paired it with OnBootSec=/
# OnUnitActiveSec= only, so the README's "a missed run catches up" was a claim
# about an inert directive. Grade the PAIR, not either half.
t  'T2c8 ...catch-up is real: Persistent= is paired with OnCalendar='  'yes' \
   "$(grep -q '^Persistent=true' "$STIMER" && grep -q '^OnCalendar=' "$STIMER" && echo yes || echo no)"
tn 'T2c8 ...and not with a monotonic trigger that makes it inert' 'OnUnitActiveSec=' "$(cat "$STIMER")"
tc 'T2c8 ...fleet does not probe in lockstep'  'RandomizedDelaySec=' "$(cat "$STIMER")"
# Idempotence: setup is documented as re-runnable. Re-running must not stack
# units, leave staging files behind, or stop re-enabling the timer.
_sum_before="$(cat "$SUNIT" "$STIMER" | md5sum)"
: > "$SYSTEMCTL_LOG"
setup_run
t  'T2c8 a second setup is idempotent: exits 0'   0 "$RC"
t  'T2c8 ...leaves the same two unit files'       "$_sum_before" "$(cat "$SUNIT" "$STIMER" | md5sum)"
t  'T2c8 ...and no half-written staging files'    '2' "$(ls -A "$SDIR" | wc -l)"
tc 'T2c8 ...and re-enables rather than assuming'  "enable --now 5dive-browser-probe@$SEAT.timer" "$(cat "$SYSTEMCTL_LOG")"
# DECLARED-GAP ARM (the verifier's "unverified": a box whose systemd will not
# take the unit). setup must fail LOUDLY — a silent 0 is a box that never probes
# and says it is automatic — while saying the store itself is ready, and must
# leave the store usable so a rerun after the box is fixed needs nothing undone.
rm -rf "$SDIR" "$TMP/setup-store"
setup_run 1
t  'T2c8 a systemd that refuses the timer is not a silent success' 69 "$RC"
tc 'T2c8 ...and the message says the STORE is ready, only the probe is not' \
   'profile store is ready, but the scheduled browser probe could not be enabled' "$ERR"
t  'T2c8 ...the seat store survives the failure, so a rerun is a no-op' '700' \
   "$(stat -c '%a' "$TMP/setup-store/$SEAT" 2>/dev/null)"
setup_run
t  'T2c8 ...and the rerun, once systemd takes it, succeeds' 0 "$RC"
rm -rf "$SDIR" "$TMP/setup-store"

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

# ============================================ T6 an executor that cannot run is a refusal,
# and — the part that matters — it is NOT verified green.
#
# DIVE-4524 made the shipped driver the default, so "no FIVEDIVE_BROWSER_DRIVER"
# is no longer the interesting case; "the executor refused before it ran a step"
# is. The fixture is deliberately loaded against us: the verify URL
# (file://$TMP/slug-42.html) ALREADY HOLDS the expect string, because a permalink
# that exists is the normal case. So a `run` that reaches its out-of-band re-read
# after an executor that never opened a browser reports SUCCESS for a publish
# nobody performed — vacuous green, with a receipt. Exit 70 from the driver is
# the contract that stops it.
#
# AND THE ABSENCE HAS TO BE A FACT, NOT AN ACCIDENT OF WHERE THE CHECKOUT SITS.
# A bare require() walks node_modules up every ancestor, so on a box with a
# /tmp/node_modules/playwright-core (this one has) a worktree under /tmp made
# this arm red — the executor WAS resolvable, just not by anybody's choice.
# DIVE-4524 pinned the driver's resolution to NODE_PATH + its own package dir,
# with no ancestor walk, so the fixture is a byte-identical copy of the shipped
# driver in a directory that has neither. The copy is asserted identical, or this
# arm would grade a file nobody ships.
PWABSENT="$TMP/pw-absent"; mkdir -p "$PWABSENT/bin"
cp "$ROOT/plugins/browser/bin/driver-playwright" "$PWABSENT/bin/driver-playwright"
t  'T6a (control) the fixture driver is the shipped one, byte for byte' 'same' \
   "$(cmp -s "$ROOT/plugins/browser/bin/driver-playwright" "$PWABSENT/bin/driver-playwright" && echo same || echo different)"
env NODE_PATH=/nonexistent-node-modules FIVEDIVE_BROWSER_DRIVER="$PWABSENT/bin/driver-playwright" \
  "$BROWSER" run x publish --slug=slug-42 --body=hi >"$TMP/t6.out" 2>"$TMP/t6.err"; RC=$?
OUT="$(cat "$TMP/t6.out")"; ERR="$(cat "$TMP/t6.err")"
t  'T6a an executor that cannot run at all refuses' 69 "$RC"
tc 'T6a ...naming the reason it cannot: no playwright installed for this seat' \
   'playwright-core is not installed' "$ERR"
tn 'T6a ...and does NOT report the pre-existing artifact as this run'"'"'s success' \
   'verified:' "$OUT"
tc 'T6a ...saying nothing was published and there is nothing to re-read' \
   'nothing was published' "$ERR"
tc 'T6a ...and that it will not treat what is already there as evidence' \
   'was not put there by this run' "$ERR"
# --- T6c an ANCESTOR's node_modules is not this driver's playwright ----------
# THE MUTANT for the pinning above: put a working playwright-core in a parent
# directory of the driver, where Node's default resolution would find it. The
# driver must still refuse — a library that arrives because of where the plugin
# was unpacked is not one anybody pinned, and this process is the one that opens
# a profile full of live sessions.
ANC="$TMP/anc"; mkdir -p "$ANC/node_modules/playwright-core" "$ANC/pkg/bin"
printf '{ "name": "playwright-core", "version": "0.0.0-ancestor", "main": "index.js" }\n' \
  > "$ANC/node_modules/playwright-core/package.json"
printf 'exports.chromium = { launchPersistentContext: async () => { throw new Error("ancestor stub ran"); } };\n' \
  > "$ANC/node_modules/playwright-core/index.js"
cp "$ROOT/plugins/browser/bin/driver-playwright" "$ANC/pkg/bin/driver-playwright"
env -u NODE_PATH FIVEDIVE_BROWSER_DRIVER="$ANC/pkg/bin/driver-playwright" \
  "$BROWSER" run x publish --slug=slug-42 --body=hi >/dev/null 2>"$TMP/t6c.err"; RC=$?
t  'T6c a playwright-core in an ANCESTOR directory is not loaded' 69 "$RC"
tc 'T6c ...it still reports no executor, rather than driving an unpinned one' \
   'playwright-core is not installed' "$(cat "$TMP/t6c.err")"
tn 'T6c ...and the ancestor copy never ran' 'ancestor stub ran' "$(cat "$TMP/t6c.err")"
# CONTROL: that same copy IS loadable — NODE_PATH naming its directory loads it,
# so T6c is "not from an ancestor", not "this stub is broken".
env NODE_PATH="$ANC/node_modules" FIVEDIVE_BROWSER_DRIVER="$ANC/pkg/bin/driver-playwright" \
  "$BROWSER" run x publish --slug=slug-42 --body=hi >/dev/null 2>"$TMP/t6c2.err"; RC=$?
tc 'T6c (control) the same copy loads when NODE_PATH names it' 'ancestor stub ran' \
   "$(cat "$TMP/t6c2.err")"

# CONTROL, or T6a grades a fixture that could never have gone green: the SAME
# adapter and the SAME artifact, with a driver that merely exits non-zero after
# running, is verified green — that is T5b's design and it must still hold.
mkdriver 3
run "$BROWSER" run x publish --slug=slug-42 --body=hi
t  'T6b (control) a driver that RAN and failed is still graded by the re-read' 0 "$RC"
unset FIVEDIVE_BROWSER_DRIVER

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
tn 'T13d ...does not fall through into the served status path' 'cannot open a profile' "$OUT"
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

  # DIVE-4523: the cold follower must not have to invent any of the six steps
  # the live DIVE-4464 run had to add. These are contract strings, not prose
  # decoration: deleting any one recreates a link that is dead, partial, on the
  # wrong seat, or forever UNKNOWN.
  tc "T14b ...starts at the shipped dashboard handoff ($W)" 'Connected sites in the 5dive dashboard' "$TXT"
  tc "T14b ...names the authenticated bind registration ($W)" '/shell/browser-viewer-bind' "$TXT"
  tc "T14b ...says viewer itself does not register the bind ($W)" 'does **not** register that bind' "$TXT"
  tc "T14b ...says stdout is a path, not an absolute URL ($W)" '/browser/viewer/<site>/<nonce>' "$TXT"
  tc "T14b ...requires the box host prefix ($W)" 'https://<box-host>/browser/viewer/' "$TXT"
  tc "T14b ...names the relay seat instead of the caller ($W)" 'run as seat `claude`' "$TXT"
  tc "T14b ...names the upgrade-safe custom-adapter store ($W)" '/browser-profiles/claude/.adapters/<site>.json' "$TXT"
  tc "T14b ...requires the adapter probe contract ($W)" 'probe.logged_out_when_dom_matches' "$TXT"
  tn "T14b ...does not tell another seat to serve its own unreachable profile ($W)" 'under YOUR seat' "$TXT"
  tc "T14b ...forbids polling while Chromium holds the profile ($W)" 'Never poll `status` while `serve` is still running' "$TXT"

  # DIVE-4523 iteration 2: the non-unfurling handoff is DIVE-4493's SHIPPED
  # guard, not doc decoration — a bare URL in a chat message is redeemed by the
  # platform's preview bot seconds before the human taps it. test/viewer-link-
  # unfurl.test.ts asserts these strings in SKILL.md only, so a rewrite that
  # dropped them from the shared fenced block scored 470/0 here and red there.
  # These arms bind the mechanism to BOTH surfaces, in the fenced block.
  tc "T14b ...names the Telegram non-unfurling call ($W)" "format: 'markdownv2'" "$TXT"
  tc "T14b ...puts the link in a MarkdownV2 code span ($W)" 'MarkdownV2 code span' "$TXT"
  tc "T14b ...generalises the rule to other chat surfaces ($W)" 'non-unfurling code formatting' "$TXT"
  tc "T14b ...keeps the copy-paste warning ($W)" 'Copy-paste this one-time link into your browser' "$TXT"
  tc "T14b ...tells the human not to paste it back ($W)" 'Do not paste it back into chat' "$TXT"
  tc "T14b ...forbids recording the live link anywhere durable ($W)" 'a log line or a wiki page' "$TXT"

  REVOKE_LINE=$(grep -nF '5dive browser viewer-revoke <site>' "$F" | tail -1 | cut -d: -f1)
  STOP_LINE=$(grep -nF '5dive browser serve <site> --stop' "$F" | tail -1 | cut -d: -f1)
  STATUS_LINE=$(grep -nF '5dive browser status <site>' "$F" | tail -1 | cut -d: -f1)
  t "T14b ...orders revoke then stop then status ($W)" 'yes' \
    "$([[ -n "$REVOKE_LINE" && -n "$STOP_LINE" && -n "$STATUS_LINE" && "$REVOKE_LINE" -lt "$STOP_LINE" && "$STOP_LINE" -lt "$STATUS_LINE" ]] && echo yes || echo no)"
done

# Both harness surfaces ship one byte-identical fenced workflow. Without this,
# fixing only the Claude skill leaves every AGENTS.md consumer on the old runbook.
SKILLFLOW="$TMP/skill-flow.md"; DOCFLOW="$TMP/doc-flow.md"
awk '/5dive:connect-site-flow:begin/{p=1} p{print} /5dive:connect-site-flow:end/{exit}' "$SKILL" > "$SKILLFLOW"
awk '/5dive:connect-site-flow:begin/{p=1} p{print} /5dive:connect-site-flow:end/{exit}' "$DOCF" > "$DOCFLOW"
t 'T14b the Claude skill and harness-neutral doc share one fenced workflow' 'same' \
  "$(cmp -s "$SKILLFLOW" "$DOCFLOW" && echo same || echo DRIFT)"

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

# === T16 DIVE-4524: `run`'s real executor =============================
#
# WHAT THESE ARMS ARE MUTANTS OF:
#   T16a  the shipped driver not being wired at all — `run` dying "no executor
#         backend" on every box, which is the state this row inherited.
#   T16b  a --remote-debugging-PORT reaching the launch. CDP is full control of
#         the browser holding a human's session, and a loopback port is reachable
#         by every seat on the box — it would hand that session to a seat that
#         could never open the 0700 profile directory. The pipe has nothing to
#         reach. This is T15c's claim for the driver instead of the render.
#   T16c  a throwaway browser. An action that did not run inside the profile a
#         person logged into by hand is not the thing that was asked for.
#   T16d  a step outside the fixed vocabulary being "best-efforted" — and the
#         half that matters, the browser NOT opening before the plan is checked.
#   T16e  an uninterpolated {placeholder} typed into a real account's composer.
#   T16f  the served browser left stopped, or a person evicted from a live viewer.
#
# The executor is graded through a STUB playwright-core on NODE_PATH that records
# what it was asked to do. There is no chrome and no real playwright on a CI
# runner and this suite must not need either; the driver itself is the real one.
PWROOT="$TMP/pw"; mkdir -p "$PWROOT/node_modules/playwright-core"
cat > "$PWROOT/node_modules/playwright-core/package.json" <<'PWPKG'
{ "name": "playwright-core", "version": "0.0.0-stub", "main": "index.js" }
PWPKG
cat > "$PWROOT/node_modules/playwright-core/index.js" <<'PWJS'
// Records every call as JSON lines. It is NOT a mock of Playwright's behaviour —
// it is a tape of what the driver asked for, which is what the arms grade.
const fs = require('fs');
const rec = (o) => fs.appendFileSync(process.env.PWREC, JSON.stringify(o) + '\n');
const page = {
  setDefaultTimeout: (t) => rec({ call: 'setDefaultTimeout', t }),
  goto: async (url, o) => rec({ call: 'goto', url }),
  fill: async (sel, val) => rec({ call: 'fill', sel, val }),
  click: async (sel) => {
    rec({ call: 'click', sel });
    if (process.env.PWFAIL) throw new Error('stub: the step failed');
  },
  waitForSelector: async (sel) => rec({ call: 'waitForSelector', sel }),
  selectOption: async (sel, val) => rec({ call: 'selectOption', sel, val }),
  setInputFiles: async (sel, p) => rec({ call: 'setInputFiles', sel, path: p }),
  press: async (sel, key) => rec({ call: 'press', sel, key }),
};
exports.chromium = {
  launchPersistentContext: async (profile, opts) => {
    rec({ call: 'launch', profile, args: opts.args, executablePath: opts.executablePath, headless: opts.headless });
    // PWNOPAGE: THE BROWSER REALLY OPENS AND THEN CANNOT HAND OVER A PAGE.
    // Every other shape here returns a working page, which is exactly why five
    // anchored mutants missed the window between the launch and step one
    // (DIVE-4524 iteration 1) — no arm could enter it. A stub that cannot fail
    // this way makes the arm below impossible to write, so the shape lives in
    // the tape, not in the arm.
    if (process.env.PWNOPAGE) {
      return {
        pages: () => [],
        newPage: async () => { throw new Error('stub: the browser opened but would not give up a page'); },
        close: async () => rec({ call: 'close' }),
      };
    }
    return { pages: () => [page], newPage: async () => page, close: async () => rec({ call: 'close' }) };
  },
};
PWJS
PWREC="$TMP/pw-record.jsonl"
DRV="$ROOT/plugins/browser/bin/driver-playwright"
pwcalls() { jq -r 'select(.call=="'"$1"'")' "$PWREC" 2>/dev/null; }

# --- T16a the shipped driver is the default, and it is what runs --------------
unset FIVEDIVE_BROWSER_DRIVER
: > "$PWREC"
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" "$BROWSER" run x publish --body=hello
t  'T16a `run` with no FIVEDIVE_BROWSER_DRIVER now EXECUTES instead of refusing' 0 "$RC"
t  'T16a (anchor) the stub really was the playwright that loaded' 'yes' \
   "$([[ -s "$PWREC" ]] && echo yes || echo no)"
tc 'T16a ...and the verdict is still the out-of-band re-read' 'verified: publish is live' "$OUT"
t  'T16a ...the adapter'"'"'s steps reached the page, in order' \
   'goto fill click' "$(jq -rs '[.[]|select(.call|IN("goto","fill","click"))|.call]|join(" ")' "$PWREC")"
t  'T16a ...with the caller'"'"'s argument substituted as a VALUE, not a placeholder' \
   'hello' "$(jq -rs '[.[]|select(.call=="fill")|.val]|first' "$PWREC")"

# --- T16b THE SECURITY CLAIM: over the pipe, never a port ---------------------
t  'T16b the launch OPENS NO DEBUG PORT for another seat to take the session' '' \
   "$(jq -rs '[.[]|select(.call=="launch")|.args[]|select(startswith("--remote-debugging"))]|join(" ")' "$PWREC")"
t  'T16b (control) the launch recorded its argv at all' 'yes' \
   "$([[ -n "$(jq -rs '[.[]|select(.call=="launch")]|length' "$PWREC")" ]] && echo yes || echo no)"
t  'T16b ...and it is headless' 'true' \
   "$(jq -rs '[.[]|select(.call=="launch")|.headless]|first' "$PWREC")"
# THE MUTANT, driven at the driver directly: a port arriving by config must be a
# refusal, not a launch. Without this arm "no port in the default args" is all
# that is graded, and the default args are not where a port would come from.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"goto","url":"https://x.test/"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true \
      FIVEDIVE_BROWSER_CHROME_ARGS=--remote-debugging-port=9222 "$DRV" \
      >"$TMP/t16b.out" 2>"$TMP/t16b.err"; RC=$?
t  'T16b a debug PORT arriving by config is a REFUSAL' 70 "$RC"
tc 'T16b ...naming what a port would hand away' 'every seat on' "$(cat "$TMP/t16b.err")"
t  'T16b ...and NO browser was launched to find out' 'no' \
   "$([[ -s "$PWREC" ]] && echo yes || echo no)"

# --- T16c the profile driven is the seat's own, not a throwaway ---------------
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" "$BROWSER" run x publish --body=hello
t  'T16c the browser is launched AT the seat'"'"'s logged-in profile directory' \
   "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" \
   "$(jq -rs '[.[]|select(.call=="launch")|.profile]|first' "$PWREC")"
t  'T16c ...using the chrome this box resolved, not one the driver picked' \
   "$FAKEBIN/google-chrome" \
   "$(jq -rs '[.[]|select(.call=="launch")|.executablePath]|first' "$PWREC")"
# PLAYWRIGHT TAKES A PATH, NOT A NAME (DIVE-4538). cmd_run used to hand the driver the bare
# word _chrome found — resolvable by bash at every exec, not by Playwright's executablePath —
# and the first real run on a real box died "executable doesn't exist at google-chrome" after
# clearing every refusal. The fixture's fake chrome is a name on PATH, so this arm is the only
# thing that can see the difference here: what the driver was handed must be absolute.
t  'T16c ...and it is an absolute PATH, which is what Playwright takes' 'absolute' \
   "$([[ "$(jq -rs '[.[]|select(.call=="launch")|.executablePath]|first' "$PWREC")" == /* ]] && echo absolute || echo relative)"

# --- T16d the vocabulary is checked BEFORE the browser opens ------------------
# Half an action is the one outcome with no clean recovery, so a bad plan must
# not get as far as a launch. bin/browser refuses these at load time; the arm
# drives the DRIVER, because "validated upstream" is an assumption about a
# process whose path is an environment variable.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"goto","url":"https://x.test/"},{"op":"eval","script":"x"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true "$DRV" \
      >/dev/null 2>"$TMP/t16d.err"; RC=$?
t  'T16d a step outside the fixed vocabulary is refused by the executor too' 70 "$RC"
tc 'T16d ...saying why the vocabulary is the point' 'freeform reasoning' "$(cat "$TMP/t16d.err")"
t  'T16d ...and NOTHING was launched, so no half-action was left behind' 'no' \
   "$([[ -s "$PWREC" ]] && echo yes || echo no)"

# --- T16e an unsubstituted placeholder is never typed into a real account -----
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"fill","selector":"#e","value":"{body}"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true "$DRV" \
      >/dev/null 2>"$TMP/t16e.err"; RC=$?
t  'T16e a {placeholder} with no argument is a refusal' 70 "$RC"
tc 'T16e ...rather than publishing the literal placeholder' 'publishes literal' "$(cat "$TMP/t16e.err")"
t  'T16e ...and no fill reached the page' '' \
   "$(jq -rs '[.[]|select(.call=="fill")|.val]|join(" ")' "$PWREC")"
# CONTROL: the same step with the argument supplied does fill, so T16e is not
# "fill never happens".
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"fill","selector":"#e","value":"{body}"}],"args":{"body":"real text"}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true "$DRV" \
      >/dev/null 2>&1; RC=$?
t  'T16e (control) the same step with its argument fills' 0 "$RC"
t  'T16e (control) ...with the value, not the placeholder' 'real text' \
   "$(jq -rs '[.[]|select(.call=="fill")|.val]|first' "$PWREC")"
# AND IT MUST BE DECIDED BEFORE THE LAUNCH, not when that step is reached. A
# placeholder on step TWO discovered mid-action would exit "nothing ran" after
# step one had run, and bin/browser would then skip the out-of-band re-read on an
# action that half happened — the one outcome with no clean recovery.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"goto","url":"https://x.test/"},{"op":"fill","selector":"#e","value":"{body}"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true "$DRV" \
      >/dev/null 2>&1; RC=$?
t  'T16e a placeholder on a LATER step refuses too' 70 "$RC"
t  'T16e ...and NOTHING was launched, so step one did not run either' 'no' \
   "$([[ -s "$PWREC" ]] && echo yes || echo no)"

# --- T16f a mid-action failure still goes to the out-of-band re-read ----------
# The dangerous half of the design: "failed" and "published" are not exclusive,
# and a red driver that suppressed the re-read is what double-posts on a retry.
# Exit 70 suppresses it; exit 1 must NOT.
: > "$PWREC"
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWFAIL=1 "$BROWSER" run x publish --body=hello
t  'T16f a step that fails mid-action is still graded by the re-read' 0 "$RC"
t  'T16f (control) the failing step really did run' 'true' \
   "$(jq -rs '[.[]|select(.call=="click")]|length>0' "$PWREC")"
tc 'T16f ...and the artifact is reported live' 'verified: publish is live' "$OUT"

# --- T16i "NOTHING RAN" IS NOT "NEVER LAUNCHED" (quinn's QX, DIVE-4524 it.1) --
# THE DEFECT THIS ROW EXISTS TO CLOSE, SURVIVING INSIDE THE CLOSE. T16b/d/e all
# grade refusals raised BEFORE the launch, and iteration 1 guarded exactly those:
# acquiring the page and arming the timeout sat inside the try whose catch set
# exit 1 unconditionally. So a browser that OPENS and then cannot hand over a
# page exited 1 — the "a step failed, re-read the artifact" code — bin/browser
# re-read a verify URL that already existed, and reported a publish nobody
# performed. Vacuous green with a receipt, which is the one outcome `run` is for.
#
# BOTH CONTROLS ARE THE ARM. Without them a green here is also what a stub that
# never launched would produce, and the next stub that returns a working page
# hides the window again.
: > "$PWREC"
mkadapter x "file://$TMP/artifact.html" 'PUBLISHED'
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWNOPAGE=1 "$BROWSER" run x publish --body=hello
t  'T16i (control) the browser really did launch' 'true' \
   "$(jq -rs '[.[]|select(.call=="launch")]|length>0' "$PWREC")"
t  'T16i (control) ...and NOT ONE STEP ran' '' \
   "$(jq -rs '[.[]|select(.call|IN("goto","fill","click","waitForSelector","selectOption","setInputFiles","press"))|.call]|join(" ")' "$PWREC")"
t  'T16i a launch with no page must NOT be graded by the re-read' 69 "$RC"
tn 'T16i ...and it does not claim a publish nobody performed' 'verified: publish is live' "$OUT"
tc 'T16i ...it says nothing ran' 'refused before it ran a single step' "$ERR$OUT"
# AT THE DRIVER, where the exit code is the contract: 70, not 1.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"goto","url":"https://x.test/"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWNOPAGE=1 FIVEDIVE_BROWSER_CHROME=/bin/true \
      "$DRV" >/dev/null 2>"$TMP/t16i.err"; RC=$?
t  'T16i the driver exits 70, not 1, when the launch succeeded but no step ran' 70 "$RC"
tc 'T16i ...naming the window it is in' 'not one step ran' "$(cat "$TMP/t16i.err")"
t  'T16i (control) ...and that launch is on the tape' 'true' \
   "$(jq -rs '[.[]|select(.call=="launch")]|length>0' "$PWREC")"
# THE OTHER SIDE OF THE SAME BOUNDARY, and the reason the counter counts a step
# from when its await is ENTERED and not from when it returns: a goto that throws
# may already have navigated, a click may already have posted, and calling that
# "nothing ran" suppresses the re-read on an action that half happened.
#
# THE FIXTURE IS ONE STEP, AND THAT IS THE WHOLE ARM. A two-step plan whose
# SECOND step throws cannot grade this — the first step has completed, so the
# counter is non-zero wherever in the loop it sits, and a counter moved to the
# wrong end survives. (Measured here: that shape passed the mutant.) With a
# single step that throws, "entered" and "returned" give different answers: 1
# versus 70.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"click","selector":"#go"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWFAIL=1 FIVEDIVE_BROWSER_CHROME=/bin/true \
      "$DRV" >/dev/null 2>/dev/null; RC=$?
t  'T16i the ONLY step entered and threw: exit 1, so the re-read still governs' 1 "$RC"
t  'T16i (control) ...and that step really did reach the page' 'true' \
   "$(jq -rs '[.[]|select(.call=="click")]|length>0' "$PWREC")"

# --- T16g the served browser is cycled around the run, and put back ----------
# A SITE NOTHING ELSE HERE HAS SERVED. `_display_num` is a hash of seat+site, and
# `_display_free` reads $FIVEDIVE_BROWSER_X11_DIR — which this suite points at a
# temp dir the REAL Xvfb never writes to. So a second serve of the same site in
# one run picks the display the first one is still holding, and Xvfb refuses it.
# Grading the cycle on a fresh site keeps this arm about the cycle.
: > "$PWREC"
mkprofile runsrv.test "$LIVE_DOM" >/dev/null
mkadapter runsrv.test "file://$TMP/artifact.html" 'PUBLISHED'
RUNSERVE="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/runsrv.test"
sleep 600 & RUNXPID=$!
sleep 600 & RUNPID=$!
( umask 077; printf 'display=471\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$RUNXPID" "$RUNPID" "$(date -u +%s)" > "$RUNSERVE/.5dive-serve" )
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" "$BROWSER" run runsrv.test publish --body=hello
t  'T16g a served profile is cycled for the run' 0 "$RC"
t  'T16g ...the old browser was stopped' 'dead' \
   "$(kill -0 "$RUNPID" 2>/dev/null && echo alive || echo dead)"
t  'T16g ...and a serve was put back, not left stopped' 'yes' \
   "$([[ -f "$RUNSERVE/.5dive-serve" ]] && echo yes || echo no)"
# A PERSON INSIDE THE VIEWER IS NOT EVICTED FOR A MACHINE.
: > "$PWREC"
sleep 600 & VXPID=$!
sleep 600 & VPID=$!
( umask 077; printf 'display=472\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$VXPID" "$VPID" "$(date -u +%s)" > "$RUNSERVE/.5dive-serve" )
( umask 077; printf 'vnc_pid=%s\nws_pid=%s\nport=1\nvnc_port=2\n' "$VPID" "$VPID" \
    > "$RUNSERVE/.5dive-viewer" )
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" "$BROWSER" run runsrv.test publish --body=hello
t  'T16g a LIVE VIEWER blocks the run instead of taking the human session away' 69 "$RC"
tc 'T16g ...and says why' 'being viewed by a person' "$ERR"
t  'T16g ...and the browser was NOT killed' 'alive' \
   "$(kill -0 "$VPID" 2>/dev/null && echo alive || echo dead)"
t  'T16g ...and nothing was launched' 'no' "$([[ -s "$PWREC" ]] && echo yes || echo no)"
kill "$VPID" "$VXPID" "$RUNXPID" 2>/dev/null
rm -f "$RUNSERVE/.5dive-viewer" "$RUNSERVE/.5dive-serve"

# --- T16h a restore that CANNOT succeed warns; it does not swallow the command -
# THE MUTANT: `cmd_serve "$s" >/dev/null 2>&1 || printf WARNING`, which is what
# this was. `cmd_serve` reports failure by calling `die`, and `die` EXITS — so
# the `||` can never run, the message it would have printed is silenced by the
# redirect, and a run that fully SUCCEEDED exits 69 with no output at all: no
# verify line, no reason, nothing. Attaching a catch to a command that exits does
# not make it catchable. A subshell contains the exit; this arm is the proof.
: > "$PWREC"
mkprofile runwarn.test "$LIVE_DOM" >/dev/null
mkadapter runwarn.test "file://$TMP/artifact.html" 'PUBLISHED'
WARNSERVE="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/runwarn.test"
sleep 600 & WXPID=$!
sleep 600 & WCPID=$!
( umask 077; printf 'display=473\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' \
    "$WXPID" "$WCPID" "$(date -u +%s)" > "$WARNSERVE/.5dive-serve" )
# Make the restart impossible the way bin/browser itself decides: every display
# in the seat's search range already has a socket, so `cmd_serve` dies with "no
# free X display". Same formula as _display_num, so the range is the real one.
X11FULL="$TMP/x11full"; mkdir -p "$X11FULL"
WBASE=$(( 0x$(printf '%s' "$SEAT/runwarn.test" | sha256sum | cut -c1-4) % 400 + 100 ))
for i in $(seq 0 60); do : > "$X11FULL/X$(( WBASE + i ))"; done
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_X11_DIR="$X11FULL" \
    "$BROWSER" run runwarn.test publish --body=hello
t  'T16h a failed restore does not swallow the run'"'"'s own verdict' 0 "$RC"
tc 'T16h ...the out-of-band verdict is still reported' 'verified: publish is live' "$OUT"
tc 'T16h ...and the browser that did not come back is NAMED, not silent' \
   'could not restart the runwarn.test browser' "$ERR"
tc 'T16h ...saying the durable half survived' 'profile is intact' "$ERR"
t  'T16h (control) the run really did execute its steps' 'true' \
   "$(jq -rs '[.[]|select(.call=="click")]|length>0' "$PWREC")"
kill "$WXPID" "$WCPID" 2>/dev/null
rm -f "$WARNSERVE/.5dive-serve"

# === T17 an adapter must survive `plugin upgrade` ============================
#
# THE MUTANT, and it is measured rather than imagined (2026-09-14): `5dive plugin
# upgrade browser@5dive-plugins` replaces the package directory WHOLESALE. A
# hand-written adapters/reddit.com.json was there before and gone after, and
# `status reddit.com` went `authenticated` -> `UNKNOWN (no adapter)` with nothing
# else changed — a live session silently un-classified by an upgrade. So the
# seat's own adapters live next to its profiles, on a path no package upgrade
# touches, and the package directory is a read-only fallback.
ADPOVERRIDE="$FIVEDIVE_BROWSER_ADAPTER_DIR"
unset FIVEDIVE_BROWSER_ADAPTER_DIR
PKGADP="$ROOT/plugins/browser/adapters"
SEATADP="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/.adapters"
mkdir -p "$SEATADP"
mkprofile upgr.test "$LIVE_DOM" >/dev/null
cat > "$SEATADP/upgr.test.json" <<'SADP'
{ "site": "upgr.test",
  "probe": { "url": "https://upgr.test/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": {} }
SADP
run env PATH="$SHOTPATH" "$BROWSER" status upgr.test
t  'T17a an adapter written next to the profiles is found' 0 "$RC"
tc 'T17a ...and classifies the session' 'authenticated' "$OUT"
t  'T17a ...and it is NOT inside the package directory an upgrade replaces' 'no' \
   "$([[ -e "$PKGADP/upgr.test.json" ]] && echo yes || echo no)"
# The dot keeps it out of the glob that enumerates profiles, so the adapter store
# can never be listed or probed as if it were a site.
run env PATH="$SHOTPATH" "$BROWSER" ls
tn 'T17b the adapter store is not enumerated as a profile' '.adapters' "$OUT"
# The package directory is still a fallback, so what 5dive ships works with no
# setup at all — and a seat file of the same name WINS, which is what makes a
# customer's own correction of a shipped adapter stick.
mkprofile nosuchsite.test "$LIVE_DOM" >/dev/null
run env PATH="$SHOTPATH" "$BROWSER" status nosuchsite.test
tc 'T17c a site with no adapter anywhere still says so plainly' 'no adapter' "$OUT$ERR"
tc 'T17c ...and names the SEAT path to write one at, not the package path' \
   "$SEATADP/nosuchsite.test.json" "$OUT$ERR"

export FIVEDIVE_BROWSER_ADAPTER_DIR="$ADPOVERRIDE"

# === T18 --out and --dom must not be the same file ===========================
# The DOM is a second load that runs AFTER the PNG is written and checked, so one
# path means "rendered ... <file>" is printed over a file holding HTML.
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/same.png" --dom="$SHOTOUT/same.png"
t  'T18a one path for both is a usage refusal' 64 "$RC"
tc 'T18a ...saying the report would be over a file holding HTML' 'holding HTML' "$ERR"
t  'T18a ...and nothing was written' 'no' "$([[ -e "$SHOTOUT/same.png" ]] && echo yes || echo no)"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/d1.png" --dom="$SHOTOUT/d1.html"
t  'T18b (control) two paths still render' 0 "$RC"

# === T19 the shipped reddit.com adapter is MEASURED, not guessed =============
# A logged-out marker that never matches stamps every logged-out page
# `authenticated` — the mutant T15b exists to catch, manufactured with our own
# signature on it. So the shipped file is graded against real markup from both
# sides rather than merely being valid JSON.
RADP="$PKGADP/reddit.com.json"
run jq -e . "$RADP"; t 'T19a the shipped reddit adapter is valid JSON' 0 "$RC"
RMARK="$(jq -r '.probe.logged_out_when_dom_matches' "$RADP")"
t  'T19b it declares a probe url on the login path' 'https://www.reddit.com/login/' \
   "$(jq -r '.probe.url' "$RADP")"
t  'T19c the marker MATCHES reddit'"'"'s logged-out login form' 'match' \
   "$(grep -qiE "$RMARK" <<<'<form action="/login/"><input name="username" type="text">' && echo match || echo miss)"
t  'T19c ...and matches the single-quoted attribute spelling too' 'match' \
   "$(grep -qiE "$RMARK" <<<"<input name='username'>" && echo match || echo miss)"
t  'T19d it does NOT match a logged-in reddit page' 'miss' \
   "$(grep -qiE "$RMARK" <<<'<html><body><div id="feed"><shreddit-post>posts</shreddit-post></div></body></html>' && echo match || echo miss)"
# The trap this file documents: the marker cannot be read off a plain fetch. A
# fetch of the same URL returns an app shell WITHOUT the username field, so a
# marker written from one would never match and would stamp every logged-out page
# authenticated. The file has to say so, because the next person will reach for
# curl first.
tc 'T19e the file records that the marker was measured in a browser, not fetched' \
   'MEASURED, NOT GUESSED' "$(cat "$RADP")"
# NOTE (DIVE-4524 merge): this section arrived from main as T16 and is renumbered
# T20 here — DIVE-4524's nine driver arms already occupy T16a..T16i in the section
# above, and two sections sharing an id makes a red arm unattributable.
# ========== T20 one authenticated DOM -> a self-verifying read evidence triple
# This fake serves the profile DOM to the shared login probe and a different,
# content-rich DOM to the requested article. It also exposes the Chrome version
# command because page.meta.json must name both sides of the extraction.
READBIN="$TMP/readbin"; mkdir -p "$READBIN"
READARGV="$TMP/read-argv.txt"; READHTML="$TMP/read-page.html"
cat > "$READHTML" <<'READPAGE'
<!doctype html><html><head><title>Signal Article</title><link rel="canonical" href="/article/1"><meta name="description" content="A useful description"><meta name="author" content="Ada Example"><meta property="article:published_time" content="2026-09-14T08:00:00Z"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Signal Article"}</script></head><body><nav><a href="/nav">Nav noise</a></nav><article><h1>Signal Article</h1><p>This is useful authenticated article content with enough words to extract cleanly and preserve for the agent reader.</p><p><a href="/next?x=1">Next signal</a><img src="/hero.png" alt="Hero"></p></article><footer>Footer noise</footer></body></html>
READPAGE
cat > "$READBIN/google-chrome" <<'RCHROME'
#!/usr/bin/env bash
if [[ "${1:-}" == --version ]]; then printf '%s\n' 'Google Chrome 153.0.8010.36'; exit 0; fi
printf '%s\n' "$*" >> "$READARGV"
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) d="${a#*=}" ;;
    --dump-dom) dump=1 ;;
    -*) ;;
    *) u="$a" ;;
  esac
done
if [[ -n "${dump:-}" && "${u:-}" == *'/article/1' ]]; then
  cat "$READ_HTML"
else
  cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null
fi
RCHROME
chmod +x "$READBIN/google-chrome"
READPATH="$READBIN:$PATH"
READOUT="$TMP/read-evidence"
rm -f "$READARGV"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    read shot.example.com "https://shot.example.com/article/1" --out="$READOUT"
t  'T20a read exits zero for the authenticated page' 0 "$RC"
t  'T20a ...writes all three evidence files' 'yes' \
   "$([[ -s "$READOUT/page.md" && -s "$READOUT/page.html" && -s "$READOUT/page.meta.json" ]] && echo yes || echo no)"
t  'T20a ...keeps the exact dump-dom bytes as page.html' 'yes' \
   "$(cmp -s "$READHTML" "$READOUT/page.html" && echo yes || echo no)"
t  'T20a ...makes the output seat-private' '700' "$(stat -c %a "$READOUT")"
t  'T20a ...and each artifact private' '600 600 600' \
   "$(stat -c %a "$READOUT/page.html" "$READOUT/page.md" "$READOUT/page.meta.json" | tr '\n' ' ' | sed 's/ $//')"
tc 'T20a Markdown carries YAML frontmatter' 'canonical_url: "https://shot.example.com/article/1"' "$(cat "$READOUT/page.md")"
tc 'T20a ...and the extracted article' 'useful authenticated article content' "$(cat "$READOUT/page.md")"
tn 'T20a ...without restoring navigation Defuddle removed' 'Nav noise' "$(cat "$READOUT/page.md")"
tn 'T20a ...or footer noise' 'Footer noise' "$(cat "$READOUT/page.md")"
t  'T20a metadata hashes the exact page.html bytes' \
   "$(sha256sum "$READOUT/page.html" | cut -d' ' -f1)" "$(jq -r .sha256 "$READOUT/page.meta.json")"
t  'T20a metadata names the exact Defuddle pin' '0.19.3' "$(jq -r .defuddle_version "$READOUT/page.meta.json")"
t  'T20a metadata names the actual browser build' 'Google Chrome 153.0.8010.36' "$(jq -r .chrome_version "$READOUT/page.meta.json")"
t  'T20a metadata names the capture honestly' 'dump-dom' "$(jq -r .capture "$READOUT/page.meta.json")"
t  'T20a article links are absolute and structured' 'https://shot.example.com/next?x=1' \
   "$(jq -r '.links[0].href' "$READOUT/page.meta.json")"
t  'T20a article images are absolute and structured' 'https://shot.example.com/hero.png' \
   "$(jq -r '.images[0].src' "$READOUT/page.meta.json")"
t  'T20a schema.org survives as data' 'Article' "$(jq -r '.schema_org[0]["@type"]' "$READOUT/page.meta.json")"
tc 'T20a stdout defaults to the Markdown artifact' 'title: "Signal Article"' "$OUT"
tn 'T20a relative canonical URLs do not leak a Defuddle parse warning' 'Failed to parse URL' "$ERR"

# `--json` is the programmatic twin: metadata and markdown from the same run.
READJSON="$TMP/read-json"; rm -f "$READARGV"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    read shot.example.com "https://shot.example.com/article/1" --out="$READJSON" --json
t  'T20b --json exits zero' 0 "$RC"
t  'T20b ...returns metadata and Markdown in one object' 'yes' \
   "$(jq -e '.canonical_url == "https://shot.example.com/article/1" and (.markdown | contains("authenticated article content")) and .capture == "dump-dom"' <<<"$OUT" >/dev/null && echo yes || echo no)"

# `links` performs the same capture and leaves the same evidence, but stdout is
# links only — no second fetch and no link scrape from nav/footer noise.
READLINKS="$TMP/read-links"; rm -f "$READARGV"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    links shot.example.com "https://shot.example.com/article/1" --out="$READLINKS"
t  'T20c links exits zero' 0 "$RC"
t  'T20c ...prints only the extracted link array' 'yes' \
   "$(jq -e 'type == "array" and length == 1 and .[0].href == "https://shot.example.com/next?x=1"' <<<"$OUT" >/dev/null && echo yes || echo no)"
t  'T20c ...and keeps the full evidence triple from that run' 'yes' \
   "$([[ -s "$READLINKS/page.md" && -s "$READLINKS/page.html" && -s "$READLINKS/page.meta.json" ]] && echo yes || echo no)"
tn 'T20c every read opens NO DEBUG PORT' '--remote-debugging' "$(cat "$READARGV")"
tc 'T20c ...and captures with dump-dom' '--dump-dom' "$(cat "$READARGV")"

# The row's dangerous mutant: a sign-in page is valid HTML and Defuddle can
# produce plausible Markdown from it. Shared preflight must refuse before even
# creating the destination.
printf '%s' "$DEAD_DOM" > "$SHOTDIR/.fake-dom"
READDENY="$TMP/read-logged-out"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    read shot.example.com "https://shot.example.com/article/1" --out="$READDENY"
t  'T20d logged-out read refuses' 75 "$RC"
t  'T20d ...and writes nothing, including no empty output directory' 'no' \
   "$([[ -e "$READDENY" ]] && echo yes || echo no)"
printf '%s' "$LIVE_DOM" > "$SHOTDIR/.fake-dom"

# Default output is discoverable in stderr and private under the seat store,
# but never inside the Chrome profile itself.
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    read shot.example.com "https://shot.example.com/article/1"
DEFAULT_READ="$(sed -n 's/^5dive browser: artifacts: //p' <<<"$ERR")"
t  'T20e default output is a private directory' '700' "$(stat -c %a "$DEFAULT_READ" 2>/dev/null)"
t  'T20e ...outside the live site profile' 'no' \
   "$(case "$(realpath -m "$DEFAULT_READ")/" in "$(realpath -m "$SHOTDIR")/"*) echo yes ;; *) echo no ;; esac)"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" "$BROWSER" \
    read shot.example.com "https://shot.example.com/article/1" --out="$SHOTDIR/derived"
t  'T20e an output beneath the browser profile is refused' 77 "$RC"
t  'T20e ...and no derived directory is left in the profile' 'no' \
   "$([[ -e "$SHOTDIR/derived" ]] && echo yes || echo no)"

run env PATH="$READPATH" "$BROWSER" --help
tc 'T20f --help lists read' '5dive browser read' "$OUT"
tc 'T20f --help lists links' '5dive browser links' "$OUT"
tc 'T20f README explains dump-dom' 'post-script serialized DOM' "$(cat "$ROOT/plugins/browser/README.md")"

# === T20 the shipped x.com adapter is MEASURED, not guessed =================
# Same contract as T19 and the same trap one step worse: x.com's login flow is
# JS-rendered, so a plain fetch has no form at all. Measured on a real box
# (exact-swallow, 2026-09-14, DIVE-4538) with the plugin's OWN probe command and
# again at 25s and under Playwright 1.63 after 15s of real time — all three carry
#   <input autocomplete="username webauthn" ... name="username_or_email">
XADP="$PKGADP/x.com.json"
run jq -e . "$XADP"; t 'T20a the shipped x.com adapter is valid JSON' 0 "$RC"
XMARK="$(jq -r '.probe.logged_out_when_dom_matches' "$XADP")"
t  'T20b it declares the login flow as the probe url' 'https://x.com/i/flow/login' "$(jq -r '.probe.url' "$XADP")"
t  'T20c the marker MATCHES the measured logged-out form' 'match' \
   "$(grep -qiE "$XMARK" <<<'<input autocomplete="username webauthn" inputmode="text" id="jf-input-username_or_email" type="text" value="" name="username_or_email">' && echo match || echo miss)"
t  'T20c ...and the single-quoted spelling' 'match' \
   "$(grep -qiE "$XMARK" <<<"<input name='username_or_email'>" && echo match || echo miss)"
t  'T20d it does NOT match a logged-in timeline' 'miss' \
   "$(grep -qiE "$XMARK" <<<'<html><body><div data-testid="primaryColumn"><article data-testid="tweet">hi</article></div></body></html>' && echo match || echo miss)"
tc 'T20e the file records that the marker was measured in a browser, not fetched' 'MEASURED, NOT GUESSED' "$(cat "$XADP")"
tc 'T20f ...and names the half it could not measure' 'UNMEASURED HALF' "$(cat "$XADP")"

# === T21 the shipped github.com adapter is MEASURED on BOTH halves ==========
GADP="$PKGADP/github.com.json"
run jq -e . "$GADP"; t 'T21a the shipped github.com adapter is valid JSON' 0 "$RC"
GMARK="$(jq -r '.probe.logged_out_when_dom_matches' "$GADP")"
t  'T21b it probes a page that redirects to sign-in when logged out' 'https://github.com/settings/profile' "$(jq -r '.probe.url' "$GADP")"
t  'T21c the marker MATCHES the sign-in form (it posts to /session)' 'match' \
   "$(grep -qiE "$GMARK" <<<'<form action="/session" accept-charset="UTF-8" method="post"><input name="login">' && echo match || echo miss)"
t  'T21d it does NOT match the logged-in settings page' 'miss' \
   "$(grep -qiE "$GMARK" <<<'<title>Your profile</title><meta name="user-login" content="someone"><textarea id="user_profile_bio"></textarea>' && echo match || echo miss)"
tc 'T21e the file records the measurement' 'MEASURED, NOT GUESSED' "$(cat "$GADP")"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
