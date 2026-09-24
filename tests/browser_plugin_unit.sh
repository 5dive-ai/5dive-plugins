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

# THE SESSION DAEMON IS OFF BY DEFAULT IN THIS SUITE, AND THE REASON IS NOT
# CONVENIENCE (DIVE-4621). `serve` prefers a warm session whenever the pinned
# playwright-core is resolvable, and whether it is resolvable HERE depends on
# whether somebody has run `npm install` next to the plugin — so without this
# line every serve arm below grades a different product on a developer box than
# in CI, and grades it by handing real playwright a fake `google-chrome` that
# will never speak CDP (a 30s launch timeout per arm, then the fallback). Ambient
# node_modules deciding what runs is the same class DIVE-4524 pinned the driver
# resolution to close.
#
# The T25 arms point this at the real binary explicitly. Every arm before them is
# grading the cold path on purpose.
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
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
# A SERVE LAUNCH MUST STAY UP, identified POSITIVELY: headed (no --headless) and
# sized (--window-size), which is `cmd_serve` and nothing else here — the `shot`
# render passes --window-size too, but headless. Since DIVE-4400 `serve` refuses
# to advertise a chrome that has already exited, so a fake that RETURNS here is a
# browser that DIED, and every restore path graded through this PATH (T16g) would
# be grading the fake's lifetime instead of the product's restore. Matching
# negatively ("no --headless") is what NOT to do: `doctor` runs --version and
# `auth` runs headed in the foreground, and both would then hang forever.
hl=; ws=; for a in "$@"; do case "$a" in --headless) hl=1 ;; --window-size=*) ws=1 ;; esac; done
[[ -n "$ws" && -z "$hl" ]] && exec sleep 300
# DIVE-4794: COUNT THE LOADS, and let a profile park a SEQUENCE of them. A
# single-page app serves the same shell to a live session and a dead one and
# only decides later, so an arm that grades "the probe waited" needs a fake that
# ANSWERS DIFFERENTLY THE SECOND TIME. `.fake-dom.N` is that; `.fake-n` is how
# an arm proves the probe looked more than once (or, for the control, exactly
# once). A profile with no sequence parked behaves exactly as before.
n=0
if [[ -n "${d:-}" && -d "$d" ]]; then
  n=$(cat "$d/.fake-n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/.fake-n"
fi
if [[ -f "${d:-/nonexistent}/.fake-dom.1" ]]; then
  if [[ -f "$d/.fake-dom.$n" ]]; then cat "$d/.fake-dom.$n"; else
    last=$(ls "$d"/.fake-dom.[0-9]* 2>/dev/null | sort -V | tail -1); cat "$last"
  fi
  exit 0
fi
# DIVE-4929: a THROWAWAY profile (the signed-out half of `capture`) has no DOM
# parked in it; FAKE_COLD_DOM names what the fake serves there. Unset, the
# fallback is exactly what it always was.
cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null || cat "${FAKE_COLD_DOM:-/nonexistent}" 2>/dev/null \
  || echo "<html><body>feed</body></html>"
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

# --- fixtures ----------------------------------------------------------------
mkprofile() {  # mkprofile <site> <dom> [seat]
  # THE SEAT IS AN ARGUMENT because a store owned by a seat whose NAME this uid
  # does not have is the only way to tell "recorded the owner" apart from
  # "recorded the caller" without a second uid (T27, DIVE-4664). The directory
  # is still created by, and owned by, this uid at 0700 — which is what `_audit`
  # grades — so the name is the only thing that moves.
  local s="${3:-$SEAT}"
  local d="$FIVEDIVE_BROWSER_PROFILE_ROOT/$s/$1"
  mkdir -p "$d"; chmod 700 "$d"; printf '%s' "$2" > "$d/.fake-dom"
  chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$s"
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
# DIVE-4516 added `adblock` to this set for the same reason `setup` is in it: it
# writes the MACHINE-WIDE chrome policy file, which has no per-user path on Linux,
# so dropping to the seat would turn the verb into a permission refusal.
# DIVE-4943 added `approve` and `approvals`: the owner's yes to an act is a
# ROOT-owned grant file (bin/browser _grant_uid), so dropping to the seat would
# turn the owner's yes into the agent's — the one thing that verb must not be.
t  'T2c7 ...but setup, adblock and the owner'"'"'s approve stay root'"'"'s' 'yes' "$(grep -A6 'if \[\[ \$EUID -eq 0 && -n "\${SUDO_USER:-}"' "$ROOT/plugins/browser/bin/browser" | grep -q 'setup|adblock|approve|approvals|-h|--help|help|"") ;;' && echo yes || echo no)"
t  'T2c8 ...and no OTHER verb joined them' '4' "$(grep -A6 'if \[\[ \$EUID -eq 0 && -n "\${SUDO_USER:-}"' "$ROOT/plugins/browser/bin/browser" | grep -oP '^\s+\K[a-z|]+(?=\|-h\|--help)' | tr '|' '\n' | grep -c .)"

# DIVE-4813 — WHICH SEAT ROOT BECOMES. An admin agent asked to open a site the
# box had connected under `claude` and was told to run `sudo -u claude 5dive
# browser serve <site>` — a runas the 5dive admin grant does not contain, so the
# agent handed the shell command back to a human (lodar, wavy-mesa, 2026-09-22).
# Root is the one lever that seat holds and the DIVE-4348 drop above spent it
# re-execing as the seat that cannot read the profile. Now, for `serve` on a site
# the box offers and the caller has no store for, root becomes the OWNER.
#
# WHY THESE ARMS DRIVE A FUNCTION AND NOT THE ENTRYPOINT. The drop is gated on
# $EUID, and `_seat`'s own comment at the top of this file says it: a fake `id
# -u` cannot move $EUID. An arm written against the inline block would therefore
# grade the real thing only where the runner happens to be root — green-by-
# blankness on a developer box, live in CI, and nobody can tell which from the
# output. So the decision is a function taking the caller as an ARGUMENT, and
# `_drop-target` is the hidden verb that reaches it. Same answer at any uid.
#
# THE LOAD-BEARING ARMS ARE THE CONTROLS. This change turns a behaviour ON, so
# "the brokered case picks the owner" is the cheap half — a function that
# returned $BOX_SEAT unconditionally passes it. Every arm below it names a case
# that must still pick the CALLER, and the mutants at the end delete one guard
# each and prove the matching control goes red.
DT="$TMP/droptarget"
mkdir -p "$DT/profiles/claude/boxsite" "$DT/profiles/agent-yak" "$DT/sessions/claude"
: > "$DT/sessions/claude/boxsite.offered"
dt() {  # dt <caller> <argv...> -> the seat root would become
  env FIVEDIVE_BROWSER_PROFILE_ROOT="$DT/profiles" \
      FIVEDIVE_BROWSER_SESSION_ROOT="$DT/sessions" \
      FIVEDIVE_BROWSER_BOX_SEAT=claude \
      "${DTB:-$BROWSER}" _drop-target "$@"
}
t  'T2c9 a brokered serve makes root become the seat that OWNS the session' \
   'claude' "$(dt agent-yak serve boxsite)"
# The reason the row exists: the advice the agent used to get names a runas the
# admin sudoers class does not grant, so it could only be executed by a human.
tn 'T2c9a ...and the refusal it replaces no longer sends a brokered seat to sudo -u for serve' \
   'Start one on the owning seat:  sudo -u' "$(cat "$ROOT/plugins/browser/bin/browser")"
tc 'T2c9b ...the brokered refusal names a verb the seat can run itself' \
   'sudo 5dive browser serve $1' "$(cat "$ROOT/plugins/browser/bin/browser")"

# --- the controls. Each names a case that must still resolve to the CALLER ---
mkdir -p "$DT/profiles/agent-yak/boxsite"
t  'T2c10 CONTROL a seat with its OWN login for the site keeps using it' \
   'agent-yak' "$(dt agent-yak serve boxsite)"
rmdir "$DT/profiles/agent-yak/boxsite"
t  'T2c11 CONTROL --stop is never carried out on the owner behalf' \
   'agent-yak' "$(dt agent-yak serve boxsite --stop)"
t  'T2c11a ...whichever side of the site name it is written on' \
   'agent-yak' "$(dt agent-yak serve --stop boxsite)"
t  'T2c12 CONTROL a site the box does not OFFER is not brokered' \
   'agent-yak' "$(dt agent-yak serve neveroffered)"
t  'T2c13 CONTROL no other verb is carried out on the owner behalf' \
   'agent-yak agent-yak agent-yak agent-yak' \
   "$(echo "$(dt agent-yak shot boxsite https://x.test/) $(dt agent-yak auth boxsite) $(dt agent-yak snapshot boxsite) $(dt agent-yak forget boxsite)")"
t  'T2c14 CONTROL serve with no site named resolves to the caller' \
   'agent-yak' "$(dt agent-yak serve)"
# The target is a CONSTANT, never the caller's argv: a site name shaped like a
# seat must not become the seat root becomes.
t  'T2c15 CONTROL the site name cannot steer which seat root becomes' \
   'agent-yak' "$(dt agent-yak serve root)"
t  'T2c16 CONTROL the caller is returned unchanged when it IS the box seat' \
   'claude' "$(dt claude serve boxsite)"
# The drop exists to open the OWNER's store, and it records who asked. A caller
# that could set either env var could re-point the first or forge the second.
tc 'T2c17 the on-behalf drop scrubs the caller store override' \
   'unset FIVEDIVE_BROWSER_SEAT' "$(cat "$ROOT/plugins/browser/bin/browser")"
tc 'T2c18 ...and names the asking seat in the audit row it cannot forge' \
   'export FIVEDIVE_BROWSER_ON_BEHALF_OF="${SUDO_USER}"' "$(cat "$ROOT/plugins/browser/bin/browser")"

# --- the mutants. One guard deleted each; the named control must go RED -------
# A mutation arm that cannot prove its own edit LANDED is an arm that passes on a
# typo, so each one greps the mutant for the change before it grades anything —
# and reports a broken edit as MUTATION-NOT-APPLIED / MUTATION-BROKE-SYNTAX
# rather than as a survived property, which is the shape that passes silently.
# The markers are LINE-EXACT where the condition alone is not unique: the
# offer-marker test also appears in _resolve_site, and a marker matching two
# sites cannot say which one the sed moved.
mutdt() {  # mutdt <sed-expr> <marker-that-must-be-GONE>
  local m="$DT/mut-browser"
  sed "$1" "$BROWSER" > "$m"; chmod +x "$m"
  if grep -qF -e "$2" "$m"; then echo "MUTATION-NOT-APPLIED"; return 0; fi
  bash -n "$m" 2>/dev/null || { echo "MUTATION-BROKE-SYNTAX"; return 0; }
  DTB="$m" dt "${@:3}"
}
t  'T2c19 MUTANT dropping the own-store guard breaks T2c10' 'claude' \
   "$(mkdir -p "$DT/profiles/agent-yak/boxsite"
      mutdt '/\[\[ ! -d "$PROFILE_ROOT\/$caller\/$site" \]\]/d' \
            '! -d "$PROFILE_ROOT/$caller/$site"' agent-yak serve boxsite
      rmdir "$DT/profiles/agent-yak/boxsite")"
t  'T2c20 MUTANT dropping the offer-marker guard breaks T2c12' 'claude' \
   "$(mutdt 's|&& \[\[ -f "$(_rv_offer "$BOX_SEAT" "$site")" \]\]; then|; then|' \
            '&& [[ -f "$(_rv_offer "$BOX_SEAT" "$site")" ]]; then' agent-yak serve neveroffered)"
t  'T2c21 MUTANT dropping the --stop guard breaks T2c11' 'claude' \
   "$(mutdt 's|if (( ! stop )) \&\& \[\[ -n "$site" \]\]|if [[ -n "$site" ]]|' \
            'if (( ! stop )) && [[ -n "$site" ]]' agent-yak serve boxsite --stop)"
t  'T2c22 MUTANT dropping the serve-only guard breaks T2c13' 'claude' \
   "$(mutdt 's|if \[\[ "${1:-}" == serve \]\]; then|if true; then|' \
            'if [[ "${1:-}" == serve ]]; then' agent-yak shot boxsite https://x.test/)"

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
REALCHOWN="$(command -v chown)"
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

# ---- DIVE-4730: a unix account is not a seat --------------------------------
# `setup` mints a per-seat timer that OUTLIVES the account. On box 10 one fired
# every six hours from 2026-09-16 for `agent-mp`, a de-registered account whose
# unix user survived — failing on every fire into a journal nobody reads, with
# no tile anywhere because the dashboard lists the REGISTRY, not /etc/passwd.
# These arms drive the real cmd_setup with a real registry file, because the
# thing under test is a refusal BEFORE the store is made and a grep cannot see
# which side of `mkdir` a guard sits on.
REG4730="$TMP/agents-4730.json"
# FIVEDIVE_BROWSER_SEAT, not SUDO_USER: `_seat()` reads the SHELL's $EUID, which
# the fake `id -u` cannot move, so under a non-root runner the SUDO_USER branch
# is never taken and every arm below would silently grade the real seat.
setup_run_as() {  # setup_run_as <seat> [registry]
  run env PATH="$SETUPBIN:$PATH" FIVEDIVE_BROWSER_SEAT="$1" \
      FIVEDIVE_AGENT_REGISTRY="${2-$REG4730}" \
      FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/setup-store" \
      FIVEDIVE_BROWSER_SYSTEMD_DIR="$SDIR" \
      FIVEDIVE_BROWSER_SYSTEMCTL=systemctl \
      SYSTEMCTL_LOG="$SYSTEMCTL_LOG" SYSTEMCTL_RC=0 \
      "$BROWSER" setup
}
printf '{"agents":{"%s":{"type":"claude","isolation":"sandboxed"}}}\n' "${SEAT#agent-}" > "$REG4730"

# The orphan. `id -u` must succeed for it or setup refuses one step earlier and
# the arm grades the wrong guard — so the fake `id` answers for this one name.
cat > "$SETUPBIN/id" <<ID
#!/usr/bin/env bash
[[ "\$*" == "-u" ]] && { echo 0; exit 0; }
[[ "\$*" == "-u agent-dive4730ghost" ]] && { echo 4730; exit 0; }
[[ "\$*" == "-u dive4730operator" ]] && { echo 4731; exit 0; }
exec "$REALID" "\$@"
ID
chmod +x "$SETUPBIN/id"
# ...and `chown`, for the same two fabricated names. The first cut of the
# non-agent arm below named a REAL account (`claude`): it exists on a 5dive box
# and on no CI runner, so the arm died at setup's "is this a real uid" check
# with 64 and graded nothing. A fabricated name makes the arm say what it means
# — the registry guard does not govern a non-`agent-*` account — on any runner,
# but nothing can chown a store to a uid that does not exist, so the two calls
# that would are answered here. Every other path still reaches the real chown.
cat > "$SETUPBIN/chown" <<CH
#!/usr/bin/env bash
[[ "\$*" == *dive4730operator* || "\$*" == *dive4730ghost* ]] && exit 0
exec "$REALCHOWN" "\$@"
CH
chmod +x "$SETUPBIN/chown"

: > "$SYSTEMCTL_LOG"; rm -rf "$SDIR" "$TMP/setup-store"
setup_run_as agent-dive4730ghost
t  'T2c9 an agent-* account absent from the registry is refused' 64 "$RC"
tc 'T2c9 ...and told it is an orphan, not a seat'  'NO entry in this box'"'"'s agent registry' "$ERR"
tc 'T2c9 ...and pointed at the reap, not at a workaround' '--category=registry --fix' "$ERR"
# THE MUTANT THE MESSAGE CANNOT CATCH: move the guard below the store/timer
# work, or drop the `die`. Both leave the sentence in the file and the artifacts
# on the box, and only these two arms see it.
t  'T2c9 ...and NO timer is enabled for it'  '' "$(grep -F 'dive4730ghost' "$SYSTEMCTL_LOG" || true)"
t  'T2c9 ...and NO profile store is made for it' 'no' \
   "$([[ -d "$TMP/setup-store/agent-dive4730ghost" ]] && echo yes || echo no)"

# POSITIVE CONTROL, or "refuses everything" would pass every arm above: the seat
# that IS in the registry still sets up, timer and all.
: > "$SYSTEMCTL_LOG"; rm -rf "$SDIR" "$TMP/setup-store"
setup_run_as "$SEAT"
t  'T2c9 a REGISTERED seat still sets up'  0 "$RC"
tc 'T2c9 ...and still gets its timer'      "enable --now 5dive-browser-probe@$SEAT.timer" "$(cat "$SYSTEMCTL_LOG")"

# FAILS OPEN on a registry it could not read. A dev box, or a box that never ran
# `agent create`, is not evidence that this account was de-registered — and a
# guard that refused there would take setup out on every one of them.
: > "$SYSTEMCTL_LOG"; rm -rf "$SDIR" "$TMP/setup-store"
setup_run_as agent-dive4730ghost "$TMP/no-such-registry.json"
t  'T2c9 an unreadable registry fails OPEN, it does not refuse on "we could not check"' 0 "$RC"

# A non-`agent-*` seat is not a registry row and never was — refusing one would
# break the ordinary operator case to fix a fleet one. The name is fabricated
# and absent from $REG4730 on purpose: absent-from-the-registry is exactly the
# condition that refuses an `agent-*` account one arm above, so this arm is the
# discriminator for the `agent-*` half of the guard, not a second run of it.
: > "$SYSTEMCTL_LOG"; rm -rf "$SDIR" "$TMP/setup-store"
setup_run_as dive4730operator
t  'T2c9 a non-agent-* account is not governed by the registry and is not refused' 0 "$RC"
tn 'T2c9 ...and not by the orphan message either' 'NO entry in this box' "$ERR"

# And the override, for the one-off the message names.
: > "$SYSTEMCTL_LOG"; rm -rf "$SDIR" "$TMP/setup-store"
run env PATH="$SETUPBIN:$PATH" FIVEDIVE_BROWSER_SEAT=agent-dive4730ghost \
    FIVEDIVE_BROWSER_ALLOW_UNREGISTERED_SEAT=1 \
    FIVEDIVE_AGENT_REGISTRY="$REG4730" \
    FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/setup-store" \
    FIVEDIVE_BROWSER_SYSTEMD_DIR="$SDIR" FIVEDIVE_BROWSER_SYSTEMCTL=systemctl \
    SYSTEMCTL_LOG="$SYSTEMCTL_LOG" "$BROWSER" setup
t  'T2c9 the documented override actually overrides' 0 "$RC"

cat > "$SETUPBIN/id" <<ID
#!/usr/bin/env bash
[[ "\$*" == "-u" ]] && { echo 0; exit 0; }
exec "$REALID" "\$@"
ID
chmod +x "$SETUPBIN/id"
rm -f "$SETUPBIN/chown"
rm -rf "$SDIR" "$TMP/setup-store"

# A site name becomes a directory name.
for bad in ../etc "a/b" "" "UPPER"; do
  run "$BROWSER" auth "$bad"
  t "T2d refuses site name '$bad'" 64 "$RC"
done
# ...and the positive control, or "refuses everything" would pass T2d.
run "$BROWSER" auth x
tn 'T2e a VALID name is not refused as a name' 'not a usable profile name' "$ERR"
# ...AND STOP WHAT THAT AUTH STARTED. There is no DISPLAY here, which is the
# normal case on a managed box, so `auth` takes the server-mode path and STARTS A
# SERVE for x. Before DIVE-4400 the serve was a lie -- the fake chrome exited at
# once and `_serve_running` read false -- so the leak was invisible and every
# later arm on x probed as if nothing were serving. Now the serve is real, and a
# served profile answers `status` with "UNKNOWN (served on :N)" by design. Left
# standing it would silently convert T4c and T11d, the two positive controls for
# `authenticated`, into assertions about a leak.
run "$BROWSER" serve x --stop >/dev/null 2>&1 || true

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
#
# THE FIXTURE IS A PACKAGE, NOT A FILE (DIVE-4588). It used to copy
# bin/driver-playwright alone, which worked only while the driver required
# nothing but node builtins — the moment it gained a sibling (lib/aria.cjs, the
# ref layer) the copy died MODULE_NOT_FOUND and five arms about PLAYWRIGHT
# resolution went red for a reason that had nothing to do with playwright. That
# is a fixture grading its own construction. The driver is still asserted
# byte-identical below; what is copied alongside it is the rest of its own
# package, which is what a real install has.
_mkpkg() {  # _mkpkg <dir> — a plugin tree with no node_modules anywhere in it
  mkdir -p "$1/bin"
  cp "$ROOT/plugins/browser/bin/driver-playwright" "$1/bin/driver-playwright"
  cp -r "$ROOT/plugins/browser/lib" "$1/lib"
}
PWABSENT="$TMP/pw-absent"; _mkpkg "$PWABSENT"
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
ANC="$TMP/anc"; mkdir -p "$ANC/node_modules/playwright-core"; _mkpkg "$ANC/pkg"
printf '{ "name": "playwright-core", "version": "0.0.0-ancestor", "main": "index.js" }\n' \
  > "$ANC/node_modules/playwright-core/package.json"
printf 'exports.chromium = { launchPersistentContext: async () => { throw new Error("ancestor stub ran"); } };\n' \
  > "$ANC/node_modules/playwright-core/index.js"
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

# T9f — the other UNKNOWN: a browser that IS present and cannot fetch THE PAGE.
# Same asymmetry, and it is a separate branch in the code from "no browser at
# all". The stub launches perfectly well for about:blank and fails only on an
# http(s) url, which is what a network blip, a slow site or a redirect loop looks
# like — and is NOT what a broken browser looks like (T9g). Before DIVE-4587 this
# arm ran against a chrome that exited 1 for EVERYTHING, so it graded the two
# conditions as one and the quiet exit read as correct for both.
BROKENBIN="$TMP/brokenbin"; mkdir -p "$BROKENBIN"
cat > "$BROKENBIN/google-chrome" <<'PAGEFAIL'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in http://*|https://*) exit 1 ;; esac; done
echo "<html><head></head><body></body></html>"
PAGEFAIL
chmod +x "$BROKENBIN/google-chrome"
t 'T9f (anchor) the stub is a page failure, not a launch failure: about:blank works' 0 \
  "$(PATH="$BROKENBIN:$PATH" google-chrome --headless --dump-dom about:blank >/dev/null 2>&1; echo $?)"
t 'T9f (anchor) ...and a real page does not' 1 \
  "$(PATH="$BROKENBIN:$PATH" google-chrome --headless --dump-dom https://x.test/ >/dev/null 2>&1; echo $?)"
mkprofile brokenprobe "$LIVE_DOM" >/dev/null
mkadapter brokenprobe "file://$TMP/artifact.html" 'PUBLISHED'
rm -f "$TMP/driver-plan.json"
run env PATH="$BROKENBIN:$PATH" "$BROWSER" run brokenprobe publish --body=hi
t 'T9f a probe that failed to load refuses at the action' 75 "$RC"
t 'T9f ...without invoking the driver' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
run env PATH="$BROKENBIN:$PATH" "$BROWSER" status brokenprobe
t  'T9f ...and stays quiet at the scheduler' 0 "$RC"
tc 'T9f ...naming the page-only failure without calling the browser dead' \
   'chrome did not load the page' "$OUT"

# ===================== T9g/T9h/T9i DIVE-4587: the browser that cannot start ====
#
# A CUSTOMER BOX RAN FOR MONTHS WITH THE PLUGIN COMPLETELY DEAD AND READ HEALTHY
# (teal-fox, 2026-09-16). Every seat but the first aborted every Chrome launch —
# rc 133, zero bytes — because Chrome keeps its crashpad database under
# $XDG_CONFIG_HOME/google-chrome/Crash Reports whatever --user-data-dir says, 5dive
# exports ONE shared XDG_CONFIG_HOME to every seat, and Chrome creates that
# directory 0700, so the first seat to run it owns it forever. `status` printed a
# quiet UNKNOWN and exited 0; the probe timer exited 0; `doctor` said nothing.
#
# Two properties are graded, and neither is graded by the other:
#   T9g/T9i  the product cannot report healthy while the browser will not start.
#   T9h      the product no longer hands the shared variable to Chrome at all.
DEADBIN="$TMP/deadbin"; mkdir -p "$DEADBIN"
cat > "$DEADBIN/google-chrome" <<'DEADC'
#!/usr/bin/env bash
# The real abort, verbatim: the message goes to stderr, stdout is empty, rc 133.
echo "chrome_crashpad_handler: --database is required" >&2
exit 133
DEADC
chmod +x "$DEADBIN/google-chrome"
mkprofile deadbrowser "$LIVE_DOM" >/dev/null
mkadapter deadbrowser "file://$TMP/artifact.html" 'PUBLISHED'
# Stamp it authenticated first, the way a box gets into this state: the profile
# WAS live, and then the browser stopped starting. The stale stamp is precisely
# what must not be repeated back as a current verdict.
printf '2026-09-01T00:00:00Z authenticated\n' > "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/deadbrowser/.5dive-liveness"

run env PATH="$DEADBIN:$PATH" "$BROWSER" status deadbrowser
t  'T9g status EXITS NON-ZERO when the browser will not start' 69 "$RC"
tn 'T9g ...and never prints a healthy line for the session' 'authenticated' "$OUT"
tc 'T9g ...it names the box, not the session' 'cannot start a browser' "$OUT"
tc 'T9g ...and reports what the browser actually said' '133' "$OUT"
tn 'T9g ...without sending a person to log in again for a fault login cannot fix' \
   '5dive browser auth <site>' "$ERR"
t  'T9g ...and the stale stamp is NOT overwritten — the last real verdict is still the record' \
   '2026-09-01T00:00:00Z authenticated' \
   "$(cat "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/deadbrowser/.5dive-liveness")"
run env PATH="$DEADBIN:$PATH" "$BROWSER" run deadbrowser publish --body=hi
t  'T9g ...and an action refuses as a box fault, not as a cold session' 69 "$RC"

# T9i the SCHEDULED probe is the only thing systemd and `doctor` can see. It must
# fail on a dead browser and must NOT fail on the steady state of a cold profile.
run env PATH="$DEADBIN:$PATH" "$BROWSER" probe-all
t 'T9i probe-all FAILS THE TIMER when the browser will not start' 69 "$RC"
COLDONLY="$TMP/coldonly-profiles"
mkdir -p "$COLDONLY/$SEAT/coldonly"; chmod 700 "$COLDONLY/$SEAT" "$COLDONLY/$SEAT/coldonly"
printf '%s' "$DEAD_DOM" > "$COLDONLY/$SEAT/coldonly/.fake-dom"
mkadapter coldonly "file://$TMP/artifact.html" 'PUBLISHED'
run env FIVEDIVE_BROWSER_PROFILE_ROOT="$COLDONLY" "$BROWSER" probe-all
tc 'T9i (control) ...the control profile really is logged out, not unreadable' 'session expired' "$OUT"
t  'T9i (control) ...and a logged-out profile still exits 0 — that is the steady state, not a failed run' 0 "$RC"

# --- T9h the fix itself: the shared XDG_CONFIG_HOME never reaches Chrome ------
#
# THE MUTANT IS A CHROME THAT BEHAVES LIKE THE REAL ONE: it puts its crashpad
# database under $XDG_CONFIG_HOME regardless of --user-data-dir, and aborts 133
# when it cannot create it. Pointed at a directory owned by ANOTHER UID, that is
# the customer's box exactly.
XDGBIN="$TMP/xdgbin"; mkdir -p "$XDGBIN"
cat > "$XDGBIN/google-chrome" <<'XDGC'
#!/usr/bin/env bash
# Faithful to the defect: --user-data-dir and --crash-dumps-dir are irrelevant,
# both were tested on the box. The crash dir follows XDG_CONFIG_HOME alone.
printf '%s\n' "${XDG_CONFIG_HOME-<unset>}" > "$XDGSEEN"
if [[ -n "${XDG_CONFIG_HOME:-}" ]] && ! mkdir -p "$XDG_CONFIG_HOME/google-chrome/Crash Reports" 2>/dev/null; then
  echo "chrome_crashpad_handler: --database is required" >&2
  exit 133
fi
for a in "$@"; do case "$a" in --user-data-dir=*) d="${a#*=}" ;; esac; done
cat "${d:-/nonexistent}/.fake-dom" 2>/dev/null || echo "<html><body>feed</body></html>"
XDGC
chmod +x "$XDGBIN/google-chrome"

# A directory owned by another uid that this seat cannot write. Found, not made:
# creating one needs a second uid we do not have. If the suite is ever run as
# root there is no such directory and the arm would be vacuous — so the control
# below is a hard FAIL rather than a skip, because a green that grades nothing is
# the failure mode this whole file is arranged against.
FOREIGN=""
for c in /usr /etc /opt /; do
  [[ -d "$c" ]] || continue
  [[ "$(stat -c %u "$c" 2>/dev/null)" == "$(id -u)" ]] && continue
  mkdir "$c/.5dive-4587-writetest.$$" 2>/dev/null && { rmdir "$c/.5dive-4587-writetest.$$"; continue; }
  FOREIGN="$c"; break
done
t 'T9h (control) found a directory owned by another uid that this seat cannot write into' \
  'yes' "$([[ -n "$FOREIGN" ]] && echo yes || echo no)"
if [[ -n "$FOREIGN" ]]; then
  # THE MUTANT IS REAL: driven directly, with the variable set, this chrome dies
  # exactly the way the customer's did. Without this anchor a green below is also
  # what a stub that never aborts would produce.
  XDGSEEN="$TMP/xdg-anchor.txt" XDG_CONFIG_HOME="$FOREIGN" "$XDGBIN/google-chrome" \
    --headless --dump-dom about:blank >/dev/null 2>"$TMP/xdg-anchor.err"; XRC=$?
  t  'T9h (anchor) the stub chrome really aborts 133 under a foreign XDG_CONFIG_HOME' 133 "$XRC"
  tc 'T9h (anchor) ...with the crashpad message' 'database is required' "$(cat "$TMP/xdg-anchor.err")"

  mkprofile xdgsite "$LIVE_DOM" >/dev/null
  mkadapter xdgsite "file://$TMP/artifact.html" 'PUBLISHED'
  run env PATH="$XDGBIN:$PATH" XDG_CONFIG_HOME="$FOREIGN" XDGSEEN="$TMP/xdg-seen.txt" \
      "$BROWSER" status xdgsite
  t  'T9h status SUCCEEDS with XDG_CONFIG_HOME pointed at another uid'"'"'s directory' 0 "$RC"
  tc 'T9h ...and actually classified the session' 'authenticated' "$OUT"
  t  'T9h ...because the variable was removed from the environment Chrome was launched in' \
     '<unset>' "$(cat "$TMP/xdg-seen.txt" 2>/dev/null)"
fi

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

# --- T10u serve PRINTS SUCCESS FOR A CHROME THAT NEVER STARTED (DIVE-4400) ----
#
# Measured on our canary 2026-09-13: `serve` printed "serving linkedin.com on
# :375", left no chrome at all, and `ls`, the stack row and a `sudo -n browser
# ls` all read ready — while the dashboard's Connect press, which calls `viewer`
# directly, came back 502. Chrome died in its first millisecond (a system library
# upgraded under a 15-week-old kernel) and its stderr went to /dev/null.
#
# THE FAKE Xvfb HERE RECORDS ITS OWN PID, because "no display was left behind" is
# the second half of the defect and it cannot be read off the product's pidfile —
# a correct failure DELETES that file. `exec` keeps the pid, so the number the
# script wrote is the number that is sleeping.
DEADBIN="$TMP/deadbin"; mkdir -p "$DEADBIN"
cat > "$DEADBIN/Xvfb" <<XVFBD
#!/usr/bin/env bash
d="\${1#:}"
: > "$TMP/x11/X\$d"
echo \$\$ > "$ARGV/Xvfb-dead.pid"
exec sleep 300
XVFBD
chmod +x "$DEADBIN/Xvfb"
cp "$SBIN/x11vnc" "$SBIN/websockify" "$DEADBIN/"

# CONTROL FIRST, on the same rig: a chrome that stays up must still serve, and
# must leave its Xvfb ALIVE. Without this the arm below passes on a rig where
# nothing ever starts, and "the display was reaped" would be a statement about
# the fake rather than about the product.
cat > "$DEADBIN/google-chrome" <<'LIVEC'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --headless) exec sleep 0 ;; esac; done
exec sleep 300
LIVEC
chmod +x "$DEADBIN/google-chrome"
mkprofile livechrome "$LIVE_DOM" >/dev/null
rm -f "$ARGV/Xvfb-dead.pid"
run env PATH="$DEADBIN:$SRVBIN:$PATH" DISPLAY= "$BROWSER" serve livechrome
t  'T10u (control) a chrome that stays up still serves' 0 "$RC"
t  'T10u (control) ...and its Xvfb is left RUNNING' 'live'    "$(p=$(cat "$ARGV/Xvfb-dead.pid" 2>/dev/null); [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && echo live || echo dead)"
env PATH="$DEADBIN:$SRVBIN:$PATH" "$BROWSER" serve livechrome --stop >/dev/null 2>&1 || true

# Now the defect: present, executable, and gone before the first frame.
cat > "$DEADBIN/google-chrome" <<'DEADC'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --headless) exec sleep 0 ;; esac; done
echo "Trace/breakpoint trap (core dumped)" >&2
echo "chrome_crashpad_handler: --database is required" >&2
exit 133
DEADC
chmod +x "$DEADBIN/google-chrome"
mkprofile deadchrome "$LIVE_DOM" >/dev/null
DDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/deadchrome"
rm -f "$ARGV/Xvfb-dead.pid"
run env PATH="$DEADBIN:$SRVBIN:$PATH" DISPLAY= "$BROWSER" serve deadchrome
t  'T10u A CHROME THAT DIES INSTANTLY IS NOT REPORTED AS SERVING' 69 "$RC"
tn 'T10u ...serve does not print success' 'serving deadchrome on :' "$OUT"
tc 'T10u ...it hands back CHROMES OWN STDERR, which used to go to /dev/null' \
   'Trace/breakpoint trap' "$ERR"
tc 'T10u ...including the second line, so the cause is not truncated to one word' \
   'crashpad_handler' "$ERR"
t  'T10u ...and writes NO pidfile, so ls/viewer/status cannot read it as live' 'no' \
   "$([[ -f "$DDIR/.5dive-serve" ]] && echo yes || echo no)"
t  'T10u ...and REAPS THE Xvfb it started, leaving no orphan display' 'dead' \
   "$(p=$(cat "$ARGV/Xvfb-dead.pid" 2>/dev/null); [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && echo live || echo dead)"
# The customer-facing consequence, driven end to end: the dashboard press calls
# `viewer` and nothing else, so this is the exact call that returned 502.
run env PATH="$DEADBIN:$SRVBIN:$PATH" "$BROWSER" viewer deadchrome --bind=sess-A --ttl=120
t  'T10u ...and the dashboards own call still refuses rather than minting a dead link' 69 "$RC"

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
# A SERVE LAUNCH MUST STAY UP: headed and sized, which is `cmd_serve` and not the
# headless render above.
# T15d2/T15e grade that a screenshot PUTS THE CUSTOMER'S BROWSER BACK, and since
# DIVE-4400 `serve` writes no pidfile for a chrome that has already exited — so a
# fake that exits here is a chrome that died, and those arms would assert the
# fake's lifetime instead of the restore.
hl=; ws=; for a in "$@"; do case "$a" in --headless) hl=1 ;; --window-size=*) ws=1 ;; esac; done
[[ -n "$ws" && -z "$hl" ]] && exec sleep 300
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

# No adapter -> the GENERIC check (DIVE-4943 scope 2). This used to be a flat
# UNKNOWN refusal, which is why 10 of the 13 sites a customer could connect could
# never be read. A no-adapter page now proceeds UNLESS it is visibly a sign-in
# form — and says every time that no adapter confirmed the login. The guard's
# intent is unchanged and graded by the second half: a sign-in page (DEAD_DOM,
# a form posting to /login) still renders nothing.
printf '%s' "$LIVE_DOM" > "$SHOTDIR/.fake-dom"
mv "$FIVEDIVE_BROWSER_ADAPTER_DIR/shot.example.com.json" "$TMP/adapter.bak"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/c2.png"
t  'T15b no adapter, no sign-in form: renders' 0 "$RC"
tc 'T15b ...saying no adapter confirmed the login' 'no adapter confirmed' "$ERR"
printf '%s' "$DEAD_DOM" > "$SHOTDIR/.fake-dom"
run env PATH="$SHOTPATH" SHOTARGV="$SHOTARGV" "$BROWSER" shot shot.example.com \
    "https://shot.example.com/t" --out="$SHOTOUT/c3.png"
t  'T15b no adapter, a sign-in form: still refuses' 75 "$RC"
t  'T15b ...writing nothing' 'no' "$([[ -e "$SHOTOUT/c3.png" ]] && echo yes || echo no)"
printf '%s' "$LIVE_DOM" > "$SHOTDIR/.fake-dom"
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
let markWalks = 0;   // DIVE-4674: how many times the ref layer has asked THIS process
const page = {
  setDefaultTimeout: (t) => rec({ call: 'setDefaultTimeout', t }),
  goto: async (url, o) => rec({ call: 'goto', url }),
  fill: async (sel, val) => {
    rec({ call: 'fill', sel, val });
    // PWPREEMPT_FILE: a PERSON arrives mid-run. Writing the lease file from
    // inside a step is the only way to put the preemption exactly where it
    // hurts — between two steps of a publish that is already under way. A test
    // that preempted before the run would grade the acquire, not the recheck.
    if (process.env.PWPREEMPT_FILE) {
      fs.writeFileSync(process.env.PWPREEMPT_FILE,
        'token=belongs-to-the-person-at-the-viewer\nholder=someone\nholder_pid=1\nkind=human\n');
    }
  },
  click: async (sel) => {
    rec({ call: 'click', sel });
    if (process.env.PWFAIL) throw new Error('stub: the step failed');
  },
  waitForSelector: async (sel) => rec({ call: 'waitForSelector', sel }),
  waitForTimeout: async (ms) => rec({ call: 'waitForTimeout', ms }),
  // DIVE-4588. The ref layer runs its walk with page.evaluate, so the tape has
  // to carry it. PWWALK parks the answer the walk would have produced in a real
  // page; the arms then grade what the DRIVER does with it, which is the half
  // that lives in our code. The walk itself is graded directly against a DOM
  // shim in T23a — a stub cannot grade a function it is standing in for.
  evaluate: async (fn, arg) => {
    // DIVE-4943: the owner-approval guard reads the live element's label through
    // evaluate. PWLABEL parks what the page would have said.
    if (arg && arg.riskOf) { rec({ call: 'label', sel: arg.sel, op: arg.op }); return process.env.PWLABEL || ''; }
    const mark = (arg && arg.mark) || null;
    if (mark) markWalks++;
    rec({ call: 'evaluate', fnlen: String(fn).length, mark, walkN: mark ? markWalks : null,
          interactiveOnly: !!(arg && arg.interactiveOnly), snapshot: !!(arg && arg.snapshot) });
    // PWWALK_MISS=<n> (DIVE-4674) — A REF THAT IS NOT THERE YET, which is a shape
    // no other fixture here can produce: the first <n> mark-walks find nothing
    // and the (n+1)th finds it. Every existing arm sees a page whose answer never
    // changes, so "resolved once" and "resolved on the fourth look" are the same
    // tape to them; that is exactly why a ref `wait_for` that never waited was
    // invisible to this suite. Inert unless the variable is set.
    if (mark && process.env.PWWALK_MISS) {
      if (markWalks <= Number(process.env.PWWALK_MISS)) {
        return { nodes: [{ role: 'textbox', name: 'Something Else', ref: 'textbox/Something Else' }],
                 marker: null };
      }
      return { nodes: [], marker: 'late-1' };
    }
    if (process.env.PWWALK) return JSON.parse(fs.readFileSync(process.env.PWWALK, 'utf8'));
    return { nodes: [], marker: null };
  },
  // DIVE-4653. The snapshot takes its picture through the page that is already
  // open, so the tape has to carry the call — an arm that could not see it could
  // not tell "same tab" from "a second browser nobody noticed".
  screenshot: async (o) => {
    rec({ call: 'screenshot', path: (o && o.path) || null, fullPage: !!(o && o.fullPage) });
    if (o && o.path) fs.writeFileSync(o.path, process.env.PWSHOT || 'stub-png');
  },
  selectOption: async (sel, val) => rec({ call: 'selectOption', sel, val }),
  // DIVE-4943: `act` re-reads the page as the steps left it.
  url: () => process.env.PWURL || 'https://stub.test/after',
  title: async () => process.env.PWTITLE || 'stub after',
  content: async () => process.env.PWHTML || '<html><body>stub after</body></html>',
  setInputFiles: async (sel, p) => rec({ call: 'setInputFiles', sel, path: p }),
  press: async (sel, key) => rec({ call: 'press', sel, key }),
};
exports.chromium = {
  launchPersistentContext: async (profile, opts) => {
    // xdg: DIVE-4587 — what the child would inherit. '<unset>' is the fix working.
    rec({ call: 'launch', profile, args: opts.args, executablePath: opts.executablePath, headless: opts.headless, xdg: process.env.XDG_CONFIG_HOME === undefined ? '<unset>' : process.env.XDG_CONFIG_HOME });
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
# T16b/DIVE-4587 — the driver is reached by a path in an environment variable, so
# it does not get to assume its parent unset the shared XDG_CONFIG_HOME. Driven
# DIRECTLY here, with the variable set, exactly as a caller that is not
# bin/browser would leave it.
: > "$PWREC"
printf '{"profile":"%s","steps":[{"op":"goto","url":"https://x.test/"}],"args":{}}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true \
      XDG_CONFIG_HOME=/nonexistent-shared-config "$DRV" >/dev/null 2>&1
t  'T16b the driver drops the shared XDG_CONFIG_HOME before opening a browser' '<unset>' \
   "$(jq -rs '[.[]|select(.call=="launch")|.xdg]|first' "$PWREC")"
t  'T16b (control) ...and that launch really was recorded' '1' \
   "$(jq -rs '[.[]|select(.call=="launch")]|length' "$PWREC")"
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

# --- T9x: the per-site adblock off switch (DIVE-4516) -------------------------
#
# ONE extension is allowed in an agent profile (uBlock Origin Lite, pinned by
# managed policy) and some sites break under filtering. These arms grade the verb
# that turns it off for one site. The policy dir and the state dir are redirected
# into $TMP; the root check is satisfied by a fake `id` on PATH, because the real
# property under test is WHAT GETS WRITTEN, and a suite that needed root to grade
# it would be a suite nobody runs.
echo "== T9x adblock (DIVE-4516)"
ADB="$TMP/adb"; mkdir -p "$ADB/state" "$ADB/policies" "$ADB/bin"
cat > "$ADB/bin/id" <<'SH'
#!/bin/sh
[ "$1" = -u ] && [ $# -eq 1 ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
SH
chmod +x "$ADB/bin/id"
POLF="$ADB/policies/5dive-browser.json"
UBOL=bjnapnkpiihibhjaehecmpbpeejnloib
adb()     { run env STATE_DIR="$ADB/state" CHROME_POLICY_DIR="$ADB/policies" bash "$BROWSER" adblock "$@"; }
adb_root(){ run env PATH="$ADB/bin:$PATH" STATE_DIR="$ADB/state" CHROME_POLICY_DIR="$ADB/policies" bash "$BROWSER" adblock "$@"; }
# What the nightly converger renders (scripts/inc/browser-stack.sh). Seeded here so
# the arms grade the PATCH, not a file this verb invented.
seed_policy() {
  jq -n --arg id "$UBOL" '{ "ExtensionInstallBlocklist": ["*"], "ExtensionInstallAllowlist": [$id],
      "ExtensionInstallForcelist": [($id + ";https://api.5dive.com/ext/ubol/updates.xml")],
      "ExtensionSettings": { ($id): {"installation_mode":"force_installed","update_url":"https://api.5dive.com/ext/ubol/updates.xml"} } }' > "$POLF"
}

# A box with no pinned uBOL must SAY there is nothing being filtered. "adblock is
# off for nothing" on a box with no extension is the reassuring half of a lie.
adb status
tc 'T90 status on a box with no policy file says the policy is ABSENT' 'ABSENT' "$OUT"
tc 'T90b ...and spells out that nothing is being filtered or blocked' 'nothing is being filtered' "$OUT"

# The file is machine-wide and root-owned; a seat that could edit it could turn
# filtering off for a site and then be shown a page it was never meant to trust.
adb off example.com
t  'T91 a non-root caller is refused' '77' "$RC"
tc 'T91b ...and is told the one command that works' 'sudo 5dive browser adblock off example.com' "$ERR"
adb_root off 'not a host/../..'
t  'T92 a site name that is not a host is refused' '64' "$RC"
adb_root frobnicate example.com
t  'T92b an unknown subcommand is refused' '64' "$RC"
adb_root off
t  'T92c `off` with no site is refused rather than applied to everything' '64' "$RC"

# The off list is recorded even with no policy file to patch — the box may get the
# extension tonight, and a setting that silently evaporated would come back ON.
rm -f "$POLF"
adb_root off news.example.com
t  'T93 with no policy file on the box the verb still succeeds' '0' "$RC"
tc 'T93b ...and says the setting applies when the extension arrives' 'applies the moment' "$OUT"
t  'T93c ...and the off list records it' 'news.example.com' "$(grep -v '^#' "$ADB/state/browser/ubol/adblock-off" | tr -d '[:space:]')"

# The patch: ONE key, and both host patterns. `*://*.example.com` does not match
# `example.com`, so a wildcard-only off switch reports success and leaves the apex
# — the host the seat typed — still filtered.
seed_policy
adb_root off news.example.com
t  'T94 the live policy file is patched with BOTH the apex and the wildcard' '*://news.example.com,*://*.news.example.com' \
   "$(jq -r --arg id "$UBOL" '.ExtensionSettings[$id].runtime_blocked_hosts | join(",")' "$POLF")"
t  'T94b ...and the blocklist that keeps every other extension out is untouched' '["*"]' "$(jq -c '.ExtensionInstallBlocklist' "$POLF")"
t  'T94c ...and so is the force-install entry' "$UBOL;https://api.5dive.com/ext/ubol/updates.xml" "$(jq -r '.ExtensionInstallForcelist[0]' "$POLF")"
tc 'T94d ...and the caller is told a running `serve` may not pick it up (only fresh launches were measured)' 'may need `serve news.example.com --stop`' "$OUT"

adb_root off shop.example.org
t  'T95 a second site is added, not replaced' '*://news.example.com,*://*.news.example.com,*://shop.example.org,*://*.shop.example.org' \
   "$(jq -r --arg id "$UBOL" '.ExtensionSettings[$id].runtime_blocked_hosts | join(",")' "$POLF")"
adb status
tc 'T95b ...and status lists both' 'news.example.com, shop.example.org' "$OUT"

adb_root on news.example.com
t  'T96 `on` removes just that site' '*://shop.example.org,*://*.shop.example.org' \
   "$(jq -r --arg id "$UBOL" '.ExtensionSettings[$id].runtime_blocked_hosts | join(",")' "$POLF")"
adb_root on shop.example.org
t  'T96b ...and the last one removed DELETES the key rather than leaving an empty array' 'false' \
   "$(jq -r --arg id "$UBOL" '.ExtensionSettings[$id] | has("runtime_blocked_hosts")' "$POLF")"
t  'T96c ...and the extension is still force-installed (turning filtering back on is not uninstalling it)' 'force_installed' \
   "$(jq -r --arg id "$UBOL" '.ExtensionSettings[$id].installation_mode' "$POLF")"

# The list, not the policy file, is the source of truth: the root converge
# re-renders that file nightly, and a site turned off at 14:00 that lived only
# there would be silently re-filtered at 03:00.
adb_root off apex.example.net
grep -q 'SOURCE OF TRUTH' "$ADB/state/browser/ubol/adblock-off" \
  && { PASS=$((PASS+1)); } || { FAIL=$((FAIL+1)); printf 'FAIL: T97 the off list does not say it is the source of truth\n'; }
t  'T97b the off list survives as the record the nightly converge re-renders from' 'apex.example.net' \
   "$(grep -v '^#' "$ADB/state/browser/ubol/adblock-off" | tr -d '[:space:]')"
# =============================================== T22 DIVE-4588: the per-site lease
#
# WHAT THESE ARMS ARE MUTANTS OF. A shared browser is a shared LOGIN, and two
# callers in one profile do not present as a collision — they present as "the
# site is flaky", which is answered with a retry instead of a lock.
#
#   T22a  a second caller being let in, or being queued SILENTLY. Refusal has to
#         name the holder, the purpose and the expiry, or the operator's only
#         move is to wait and guess.
#   T22b  a CORPSE holding a site forever. The row names this one explicitly:
#         arm it with a caller that dies without releasing.
#   T22c  the other corpse — a live pid past its TTL.
#   T22d  a forced release handing a live holder's browser to a second caller.
#   T22e  THE DANGEROUS ONE, and the reason the token is re-read before every
#         step: a person redeems a viewer mid-publish and the agent keeps typing
#         into the session they are logging in with. Acquiring once and never
#         looking again is a lease that protects keystroke one.
#   T22f  ...and its control, or T22e would pass on a run that never works.
#   T22g  the agent's own cleanup deleting the PERSON's lease on the way out —
#         preemption undone by the tidy-up path, which hands the browser to the
#         next agent in the queue while somebody is still typing in it.
#   T22h  a read being exempt. Separate tabs of one profile share cookies and
#         drafts; a lease that covered only writes would cover the cheap half.

LEASESITE=leasehost.test
LDIR="$(mkprofile "$LEASESITE" "$LIVE_DOM")"
mkadapter "$LEASESITE" "file://$TMP/artifact.html" 'PUBLISHED'
printf 'PUBLISHED\n' > "$TMP/artifact.html"

# A live holder: a real process this harness owns, so kill -0 is a true answer
# rather than a guess about somebody else's pid.
sleep 300 & HOLDER=$!
mklease() {  # mklease <kind> <pid> <expires-in-seconds> [purpose]
  mkdir -p "$LDIR/.5dive-lease"
  printf 'token=held-by-someone-else\nholder=otherseat\nholder_pid=%s\nkind=%s\npurpose=%s\nacquired_at=%s\nexpires_at=%s\n' \
    "$2" "$1" "${4:-compose}" "$(date -u +%s)" "$(( $(date -u +%s) + $3 ))" > "$LDIR/.5dive-lease/meta"
}
rmlease() { rm -rf "${LDIR:?}/.5dive-lease" "${LDIR:?}/.5dive-lease.q" "${LDIR:?}/.5dive-lease.reap"; }

# --- T22a a second caller is REFUSED, and told who has it ---------------------
mkdriver 0
mklease agent "$HOLDER" 600 compose
run "$BROWSER" run "$LEASESITE" publish --body=hi
t  'T22a a second caller for a leased site is refused' 69 "$RC"
tc 'T22a ...naming the holder'  'held by otherseat' "$ERR"
tc 'T22a ...naming the purpose' '(compose)'         "$ERR"
tc 'T22a ...naming when it frees' 'until'           "$ERR"
tc 'T22a ...and saying why it is not just queued silently' 'read as site flakiness' "$ERR"
t  'T22a ...and the executor never ran' 'no' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"

run "$BROWSER" lease "$LEASESITE" --status
tc 'T22a `lease --status` answers who holds it' 'held by otherseat' "$OUT"

# --- T22b THE ROW'S NAMED ARM: a caller that dies without releasing -----------
# A pid that is gone. The lease file is intact, unexpired and looks perfectly
# healthy — the ONLY thing wrong with it is that nobody is behind it.
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
mklease agent "$HOLDER" 600 compose
run "$BROWSER" lease "$LEASESITE" --status
tc 'T22b a lease whose holder died reads as free' 'free:' "$OUT"
rm -f "$TMP/driver-plan.json"
run "$BROWSER" run "$LEASESITE" publish --body=hi
t  'T22b ...and the next caller gets the browser' 0 "$RC"
t  'T22b ...having actually executed' 'yes' "$([[ -f "$TMP/driver-plan.json" ]] && echo yes || echo no)"
t  'T22b ...and it released what it took' 'no' \
   "$([[ -d "$LDIR/.5dive-lease" ]] && echo yes || echo no)"

# --- T22c the other corpse: alive, but past its TTL ---------------------------
sleep 300 & HOLDER2=$!
mklease agent "$HOLDER2" -60 compose
run "$BROWSER" lease "$LEASESITE" --status
tc 'T22c a live holder past its expiry reads as free' 'free:' "$OUT"
rmlease

# --- T22d a forced release is refused while the holder is alive ---------------
mklease agent "$HOLDER2" 600 compose
run "$BROWSER" lease "$LEASESITE" --release
t  'T22d --release refuses a LIVE holder' 77 "$RC"
tc 'T22d ...saying a forced release is what puts two callers in one browser' \
   'a forced release puts one there' "$ERR"
t  'T22d ...and the lease is still there' 'yes' "$([[ -d "$LDIR/.5dive-lease" ]] && echo yes || echo no)"
kill "$HOLDER2" 2>/dev/null; wait "$HOLDER2" 2>/dev/null
run "$BROWSER" lease "$LEASESITE" --release
t  'T22d ...but a stale one releases' 0 "$RC"
t  'T22d ...and is gone' 'no' "$([[ -d "$LDIR/.5dive-lease" ]] && echo yes || echo no)"

# --- T22e PREEMPTION MID-RUN: the agent's next step fails closed --------------
# The stub flips the lease file during step 2 (fill) — a person redeeming a
# viewer while a publish is three steps in. The publish has FOUR steps here
# (goto, fill, click, wait_for), so there is something after the preemption that
# must not happen.
unset FIVEDIVE_BROWSER_DRIVER
mkadapter "$LEASESITE" "file://$TMP/artifact.html" 'PUBLISHED' wait_for
: > "$PWREC"
LEASEMETA_SPY="$TMP/lease-spy"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" \
    PWPREEMPT_FILE="$LDIR/.5dive-lease/meta" \
    "$BROWSER" run "$LEASESITE" publish --body=hi
t  'T22e the click AFTER the preemption never ran' '' "$(pwcalls click)"
t  'T22e (control) the steps BEFORE it did run' 'yes' \
   "$([[ -n "$(pwcalls fill)" ]] && echo yes || echo no)"
tc 'T22e ...and the reason names a person, not a bug' \
   'TAKEN by someone else' "$ERR"
tc 'T22e ...refusing to type into a session somebody else is using' \
   'somebody else is using' "$ERR"
# AND IT IS NOT "NOTHING RAN". Two steps already executed, so the out-of-band
# re-read is the verdict — reporting nothing-ran about a half-run action is the
# shape that double-posts on retry.
tn 'T22e ...and it does NOT claim nothing was published' 'nothing was published' "$ERR"
tc 'T22e ...the out-of-band re-read is still what decides' 'verified:' "$OUT"
# --- T22g the agent's cleanup leaves the PERSON's lease alone -----------------
t  'T22g the preempting holder still holds it after the agent exits' 'belongs-to-the-person-at-the-viewer' \
   "$(sed -n 's/^token=//p' "$LDIR/.5dive-lease/meta" 2>/dev/null)"
rmlease

# --- T22f the control: the SAME run, lease intact, completes ------------------
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" \
    "$BROWSER" run "$LEASESITE" publish --body=hi
t  'T22f (control) with the lease intact every step runs' 'yes' \
   "$([[ -n "$(pwcalls click)" ]] && echo yes || echo no)"
t  'T22f ...including the one after the fill' 'yes' \
   "$([[ -n "$(pwcalls waitForSelector)" ]] && echo yes || echo no)"
t  'T22f ...and the run is green' 0 "$RC"

# --- T22h a READ takes the lease too ------------------------------------------
sleep 300 & HOLDER3=$!
mklease agent "$HOLDER3" 600 'reading the inbox'
run env READARGV="$TMP/read-argv" READ_HTML="$TMP/read.html" "$BROWSER" \
    shot "$LEASESITE" "https://$LEASESITE/x" --out="$TMP/leased.png"
t  'T22h a render under someone else\047s lease is refused' 69 "$RC"
tc 'T22h ...naming the holder' 'held by otherseat' "$ERR"
t  'T22h ...and nothing was rendered' 'no' "$([[ -e "$TMP/leased.png" ]] && echo yes || echo no)"
kill "$HOLDER3" 2>/dev/null; wait "$HOLDER3" 2>/dev/null
rmlease

# ======================================= T23 DIVE-4588: `tree` and re-derivable refs
#
# THE PROBLEM THIS GRADES. claude-luca's hour on one connect-inbox-send task was
# "mostly guessing selectors and fighting the wizard by trial and error, four
# rounds at a minute each" against `tr.zA`, `.yX .yP`, `input[name=subjectbox]`.
# His own ranking put this ABOVE the warm browser: a warm browser makes a
# guessing loop faster, it does not end it.
#
#   T23a  THE WALK ITSELF, against a DOM. Everything below it goes through a stub
#         that stands in for the browser, and a stub cannot grade the function it
#         is standing in for — so the ref assignment, the name resolution and the
#         #n disambiguation are graded here, directly, or they are not graded.
#   T23b  `tree` printing something that is not addressable. A tree an agent
#         cannot quote back is a prettier version of the guessing.
#   T23c  ONE WALK, NOT TWO. `tree` enumerates and `run` resolves; two
#         implementations would drift, and the failure mode of drift is a ref
#         that `tree` printed resolving to a DIFFERENT element inside a real
#         account.
#   T23d  a ref reaching the page as a literal selector. `ref=button/Send` handed
#         to page.click as a CSS string matches nothing and reads as a broken site.
#   T23e  a ref that matches nothing being best-efforted, and — the half that
#         matters — being reported as a step that RAN.
#   T23f  a tree of the SIGN-IN page. It is a perfectly well-formed tree, with a
#         role and a name for every field, and an agent would quote its refs into
#         an adapter and wonder for an hour why they never match.
#   T23g  the acceptance the row actually names: an adapter that writes ZERO CSS
#         selectors by hand runs end to end.

# --- T23a the walk, graded against a DOM -------------------------------------
# A shim, not jsdom: this suite must not grow a dependency to grade 200 lines of
# DOM walking. It implements exactly the surface pageWalk touches, and the arms
# below would notice if it implemented it wrongly, because the expected refs are
# written out by hand from the markup.
cat > "$TMP/walk-test.js" <<'WALK'
const { pageWalk, INTERACTIVE } = require(process.env.ARIA);
// --- the shim ---------------------------------------------------------------
class El {
  constructor(tag, attrs = {}, text = '', kids = []) {
    this.tagName = tag.toUpperCase(); this._a = attrs; this._t = text; this.kids = kids;
    kids.forEach(k => { k.parent = this; });
  }
  get id() { return this._a.id || ''; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._a, n) ? this._a[n] : null; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this._a, n); }
  setAttribute(n, v) { this._a[n] = v; }
  get textContent() { return this._t + this.kids.map(k => k.textContent).join(''); }
  closest(sel) { let n = this; const tag = sel.toUpperCase();
    while (n) { if (n.tagName === tag) return n; n = n.parent; } return null; }
  get ownerDocument() { return doc; }
}
function flatten(el, out = []) { out.push(el); el.kids.forEach(k => flatten(k, out)); return out; }
const body = new El('body', {}, '', [
  new El('a', { href: '/inbox' }, 'Inbox'),
  new El('a', { href: '/inbox2' }, 'Inbox'),
  new El('label', { for: 'to' }, 'To'),
  new El('input', { id: 'to', type: 'text' }),
  new El('input', { type: 'text', placeholder: 'Subject' }),
  new El('button', { 'aria-label': 'Send' }, 'ignored because aria-label wins'),
  new El('input', { type: 'hidden', name: 'csrf' }),
  new El('button', { hidden: '' }, 'Delete forever'),
  new El('div', { role: 'button', 'aria-hidden': 'true' }, 'Archive'),
  new El('span', {}, 'just text'),
]);
const all = flatten(body).slice(1);
const doc = {
  getElementById: (id) => all.find(e => e.id === id) || null,
  querySelector: (sel) => { const m = /^label\[for="(.*)"\]$/.exec(sel);
    return m ? all.find(e => e.tagName === 'LABEL' && e.getAttribute('for') === m[1]) || null : null; },
  defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
};
global.document = { querySelectorAll: () => all };
global.CSS = { escape: (s) => s };
const mode = process.argv[2];
const r = pageWalk({ interactiveOnly: mode === 'interactive', interactiveRoles: INTERACTIVE,
                     mark: process.argv[3] || null });
console.log(JSON.stringify({ refs: r.nodes.map(n => n.ref), marker: r.marker,
                             marked: all.filter(e => e.getAttribute('data-5dive-ref')).length }));
WALK
ARIA="$ROOT/plugins/browser/lib/aria.cjs"
WALKREFS="$(ARIA="$ARIA" node "$TMP/walk-test.js" all | jq -r '.refs|join(" ")')"
tc 'T23a a labelled field is addressed by its LABEL, not its name attribute' 'textbox/To' "$WALKREFS"
tc 'T23a a placeholder is an accessible name when nothing better exists' 'textbox/Subject' "$WALKREFS"
tc 'T23a aria-label outranks the element text' 'button/Send' "$WALKREFS"
tn 'T23a ...so the overridden text is NOT the ref' 'ignored because' "$WALKREFS"
# THE DISAMBIGUATION, both directions. An ordinal that is not needed breaks when
# an unrelated copy appears; one that IS needed and missing is an ambiguous ref.
tc 'T23a two identical links get ordinals' 'link/Inbox#1 link/Inbox#2' "$WALKREFS"
tn 'T23a ...and a unique node does NOT get one' 'button/Send#' "$WALKREFS"
tn 'T23a a hidden input is not offered as addressable' 'csrf' "$WALKREFS"
tn 'T23a an element the page declares hidden is not offered' 'Delete forever' "$WALKREFS"
tn 'T23a an aria-hidden node is not offered' 'Archive' "$WALKREFS"
tn 'T23a a plain span is not a node' 'just text' "$WALKREFS"
t  'T23a --interactive drops the non-actionable roles' 'no' \
   "$(ARIA="$ARIA" node "$TMP/walk-test.js" interactive | jq -r '.refs|join(" ")' | grep -q 'label/' && echo yes || echo no)"
# MARKING IS THE SAME WALK. One element, and exactly one.
MARKED="$(ARIA="$ARIA" node "$TMP/walk-test.js" all 'link/Inbox#2')"
t  'T23a marking a ref stamps exactly one element' '1' "$(jq -r '.marked' <<<"$MARKED")"
t  'T23a ...and reports the marker the selector is built from' 'yes' \
   "$(jq -r '.marker' <<<"$MARKED" | grep -q '^r[0-9]' && echo yes || echo no)"
t  'T23a a ref that matches nothing marks NOTHING' '0' \
   "$(ARIA="$ARIA" node "$TMP/walk-test.js" all 'button/Nope' | jq -r '.marked')"

# --- the canned walk the stub hands back for the plumbing arms ---------------
TREESITE=treehost.test
TDIR="$(mkprofile "$TREESITE" "$LIVE_DOM")"
mkadapter "$TREESITE" "file://$TMP/artifact.html" 'PUBLISHED'
WALKJSON="$TMP/walk.json"
cat > "$WALKJSON" <<'WJ'
{ "nodes": [ {"ref":"textbox/To","role":"textbox","name":"To","tag":"input"},
             {"ref":"button/Send","role":"button","name":"Send","tag":"button"} ],
  "marker": "r7" }
WJ

# --- T23b `tree` prints refs a caller can quote back --------------------------
unset FIVEDIVE_BROWSER_DRIVER
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" tree "$TREESITE" "https://$TREESITE/inbox"
t  'T23b tree is green' 0 "$RC"
tc 'T23b ...and prints a quotable ref'    'ref=button/Send' "$OUT"
tc 'T23b ...with the role and the name'   'textbox' "$OUT"
tc 'T23b ...and says a ref survives a reload' 'still works after a reload' "$ERR"
tc 'T23b it navigated to the url it was asked for' "$TREESITE/inbox" "$(pwcalls goto)"
# NEVER NETWORK IDLE: a live web app long-polls and never idles — that is what
# makes `read` hang for 150s on a real Gmail. A bounded settle, or nothing.
t  'T23b ...and settles on a bounded timer rather than network idle' 'yes' \
   "$([[ -n "$(pwcalls waitForTimeout)" ]] && echo yes || echo no)"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" tree "$TREESITE" "https://$TREESITE/inbox" --json
t  'T23b --json is machine-readable' 'button/Send' "$(jq -r '.nodes[1].ref' <<<"$OUT")"

# --- T23c ONE WALK, TWO MODES -------------------------------------------------
: > "$PWREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" tree "$TREESITE" "https://$TREESITE/inbox" >/dev/null 2>&1
TREEFN="$(jq -r 'select(.call=="evaluate")|.fnlen' "$PWREC" | head -1)"
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$TREESITE.json" <<JSON
{ "site": "$TREESITE",
  "probe": { "url": "https://$TREESITE/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"https://$TREESITE/compose"},
                 {"op":"fill","selector":"ref=textbox/To","value":"{body}"},
                 {"op":"click","selector":"ref=button/Send"} ],
      "verify": { "url": "file://$TMP/artifact.html", "expect": "PUBLISHED" } } } }
JSON
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" run "$TREESITE" publish --body=hi
RUNFN="$(jq -r 'select(.call=="evaluate")|.fnlen' "$PWREC" | head -1)"
t  'T23c tree and run resolve refs with the SAME walk' "$TREEFN" "$RUNFN"
t  'T23c (anchor) the walk really ran in both' 'yes' \
   "$([[ -n "$TREEFN" && "$TREEFN" != null ]] && echo yes || echo no)"
t  'T23c ...and only the resolve pass asks it to mark' 'button/Send' \
   "$(jq -r 'select(.call=="evaluate" and .mark!=null)|.mark' "$PWREC" | tail -1)"

# --- T23d a ref is RESOLVED, never handed to the page as a selector ----------
t  'T23d the ref never reaches the page as a literal selector' '' \
   "$(jq -r 'select(.call=="click")|.sel' "$PWREC" | grep '^ref=' || true)"
t  'T23d ...it reaches it as the marker the walk stamped' '[data-5dive-ref="r7"]' \
   "$(jq -r 'select(.call=="click")|.sel' "$PWREC" | tail -1)"
t  'T23d ...and a plain CSS selector is passed through untouched' 0 "$RC"

# --- T23e a ref that matches nothing is a REFUSAL, and nothing ran ------------
cat > "$TMP/walk-miss.json" <<'WJ'
{ "nodes": [ {"ref":"button/Discard","role":"button","name":"Discard","tag":"button"} ],
  "marker": null }
WJ
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$TREESITE.json" <<JSON
{ "site": "$TREESITE",
  "probe": { "url": "https://$TREESITE/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"click","selector":"ref=button/Send"} ],
      "verify": { "url": "file://$TMP/artifact.html", "expect": "PUBLISHED" } } } }
JSON
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$TMP/walk-miss.json" \
    "$BROWSER" run "$TREESITE" publish --body=hi
t  'T23e a ref that matches nothing does not click anything' '' "$(pwcalls click)"
tc 'T23e ...and says the PAGE is not the one tree described' 'not the one' "$ERR"
tc 'T23e ...offering the refs that ARE there' 'ref=button/Discard' "$ERR"
# THE HALF THAT MATTERS. It was step one, so nothing ran — and a run that never
# started must not reach the out-of-band re-read, or whatever is already at the
# verify URL is reported as this run's success.
t  'T23e ...and a miss on step one is NOTHING RAN, not a failed publish' 69 "$RC"
tn 'T23e ...so the pre-existing artifact is NOT reported as verified' 'verified:' "$OUT"

# --- T23f a tree of the SIGN-IN page is refused -------------------------------
printf '%s' "$DEAD_DOM" > "$TDIR/.fake-dom"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" tree "$TREESITE" "https://$TREESITE/inbox"
t  'T23f tree refuses a logged-out profile' 75 "$RC"
tn 'T23f ...and hands back no refs to quote into an adapter' 'ref=' "$OUT"
printf '%s' "$LIVE_DOM" > "$TDIR/.fake-dom"

# --- T23g THE ROW'S ACCEPTANCE: an action with ZERO hand-written CSS ----------
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$TREESITE.json" <<JSON
{ "site": "$TREESITE",
  "probe": { "url": "https://$TREESITE/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "compose": {
      "steps": [ {"op":"goto","url":"https://$TREESITE/inbox"},
                 {"op":"wait_for","selector":"ref=button/Send"},
                 {"op":"fill","selector":"ref=textbox/To","value":"{to}"},
                 {"op":"click","selector":"ref=button/Send"} ],
      "verify": { "url": "file://$TMP/artifact.html", "expect": "PUBLISHED" } } } }
JSON
: > "$PWREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$WALKJSON" \
    "$BROWSER" run "$TREESITE" compose --to=someone@example.com
t  'T23g an adapter with no CSS selector at all runs end to end' 0 "$RC"
t  'T23g (anchor) it really wrote nothing but refs' '0' \
   "$(jq -r '.actions.compose.steps[]|select(.selector!=null)|.selector' \
       "$FIVEDIVE_BROWSER_ADAPTER_DIR/$TREESITE.json" | grep -cv '^ref=' || true)"
t  'T23g ...and every ref reached the page as a resolved marker' '0' \
   "$(jq -r 'select(.sel!=null)|.sel' "$PWREC" | grep -c '^ref=' || true)"
tc 'T23g ...with the caller argument still substituted as a VALUE' 'someone@example.com' \
   "$(pwcalls fill)"

# ====================================== T24 DIVE-4588: idle eviction of served browsers
#
# WHAT THIS IS A MUTANT OF. `serve` has never had an end: a browser started once
# lives until somebody stops it by hand or the box reboots. Each one is ~300-500 MB
# of resident Chrome plus an X display, and on a 37-seat box that is not a leak in
# the usual sense — every one of them was legitimately asked for. It is an
# unbounded accumulation of legitimate requests.
#
# The three arms that matter are the ones that must NOT evict, because an
# eviction sweep that is merely aggressive is worse than none: it takes the
# browser away from a person mid-login, or out from under a caller mid-publish,
# and both present as the site being broken.

EVSITE=evicthost.test
EDIR="$(mkprofile "$EVSITE" "$LIVE_DOM")"
# A served browser, faked at the pidfile: _serve_running asks only whether the
# two pids are alive, so two sleeps this harness owns are a truthful fixture and
# need no Xvfb.
mkserve() {  # mkserve <dir> <last_used-epoch|-> [extra]
  local d="$1" last="$2"
  # THE REDIRECTS ARE LOAD-BEARING. This function is called as `$(mkserve ...)`,
  # and a command substitution waits for EOF on the pipe, not for the child to
  # exit — a backgrounded job that inherits stdout holds that pipe open for its
  # whole life. Without `>/dev/null` the caller blocks for the full `sleep`, and
  # by the time the arm runs its assertion the two pids it planted are DEAD, so
  # `_serve_running` skips the profile and `evict` prints "0 browser(s) evicted"
  # for every arm — the fixture's own shape destroying the fixture, silently and
  # in the passing direction for anything that asserts an absence.
  sleep 300 >/dev/null 2>&1 & local xp=$!
  sleep 300 >/dev/null 2>&1 & local cp=$!
  printf 'display=999\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' "$xp" "$cp" "$(date -u +%s)" \
    > "$d/.5dive-serve"
  [[ "$last" == - ]] || printf 'last_used=%s\n' "$last" >> "$d/.5dive-serve"
  printf '%s %s\n' "$xp" "$cp"
}
SERVEPIDS="$(mkserve "$EDIR" "$(( $(date -u +%s) - 4000 ))")"

# --- T24a an idle browser is evicted, and the LOGIN is not ------------------
run "$BROWSER" evict --idle=1800
tc 'T24a an idle served browser is evicted' 'evicted: idle' "$OUT"
t  'T24a ...and the profile directory is untouched' 'yes' "$([[ -d "$EDIR" ]] && echo yes || echo no)"
t  'T24a ...as is its cookie jar and everything else in it' 'yes' \
   "$([[ -f "$EDIR/.fake-dom" ]] && echo yes || echo no)"
tc 'T24a ...and the message says the next command brings it back' 'the profile is untouched' "$OUT"
t  'T24a ...the serve really is stopped' 'no' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"

# --- T24b a browser used recently is KEPT ------------------------------------
SERVEPIDS="$(mkserve "$EDIR" "$(date -u +%s)")"
run "$BROWSER" evict --idle=1800
tc 'T24b a browser used just now is kept' 'kept: used' "$OUT"
t  'T24b ...and is still serving' 'yes' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"

# --- T24c A PERSON IN IT IS NEVER EVICTED ------------------------------------
# Logging in involves long pauses staring at a phone for a code, so "idle" and
# "nobody is there" are different facts. This is the arm that keeps the sweep
# from being the thing that breaks the login it exists to make affordable.
sleep 300 & VNCPID=$!
printf 'vnc_pid=%s\nws_pid=%s\nport=6080\nvnc_port=5900\n' "$VNCPID" "$VNCPID" > "$EDIR/.5dive-viewer"
printf 'display=999\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\nlast_used=%s\n' \
  $SERVEPIDS "$(date -u +%s)" "$(( $(date -u +%s) - 99999 ))" > "$EDIR/.5dive-serve"
run "$BROWSER" evict --idle=60
tc 'T24c a browser with a PERSON in it is never evicted, however idle' 'kept: a person is in it' "$OUT"
t  'T24c ...and is still serving' 'yes' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"
rm -f "$EDIR/.5dive-viewer"; kill "$VNCPID" 2>/dev/null; wait "$VNCPID" 2>/dev/null

# --- T24d A CALLER MID-ACTION IS NEVER EVICTED -------------------------------
sleep 300 & LHOLD=$!
mkdir -p "$EDIR/.5dive-lease"
printf 'token=t\nholder=otherseat\nholder_pid=%s\nkind=agent\npurpose=publish\nacquired_at=%s\nexpires_at=%s\n' \
  "$LHOLD" "$(date -u +%s)" "$(( $(date -u +%s) + 600 ))" > "$EDIR/.5dive-lease/meta"
run "$BROWSER" evict --idle=60
tc 'T24d a browser under a live lease is never evicted' 'kept: busy: held by otherseat' "$OUT"
t  'T24d ...and is still serving' 'yes' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"
kill "$LHOLD" 2>/dev/null; wait "$LHOLD" 2>/dev/null
rm -rf "${EDIR:?}/.5dive-lease"

# --- T24e a serve that has NEVER been used is not "idle since the epoch" ------
# A missing last_used read as 0 would evict a browser on the first sweep —
# including the one a person is about to be handed a viewer onto.
printf 'display=999\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\n' $SERVEPIDS "$(date -u +%s)" \
  > "$EDIR/.5dive-serve"
run "$BROWSER" evict --idle=1800
tc 'T24e a browser started but never used falls back to when it started' 'kept: used' "$OUT"
t  'T24e ...and is still serving' 'yes' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"

# --- T24f --dry-run tells you and changes nothing ----------------------------
printf 'display=999\nxvfb_pid=%s\nchrome_pid=%s\nstarted_at=%s\nlast_used=%s\n' \
  $SERVEPIDS "$(date -u +%s)" "$(( $(date -u +%s) - 4000 ))" > "$EDIR/.5dive-serve"
run "$BROWSER" evict --idle=1800 --dry-run
tc 'T24f --dry-run names what it would evict' 'WOULD evict' "$OUT"
t  'T24f ...and evicts nothing' 'yes' "$([[ -f "$EDIR/.5dive-serve" ]] && echo yes || echo no)"

# --- T24g holding the lease STAMPS the clock the sweep reads -----------------
# Without this the sweep grades a number nobody writes, and every browser looks
# idle from the moment it starts.
STAMP0="$(sed -n 's/^last_used=//p' "$EDIR/.5dive-serve")"
mkdriver 0
mkadapter "$EVSITE" "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" run "$EVSITE" publish --body=hi
STAMP1="$(sed -n 's/^last_used=//p' "$EDIR/.5dive-serve" 2>/dev/null)"
# `run` cycles the serve, so the pidfile it leaves is a NEW one; what the arm
# grades is that a caller taking the browser moved the clock forward at all.
t  'T24g taking the browser stamps the idle clock' 'newer' \
   "$([[ -n "$STAMP1" && "$STAMP1" -gt "$STAMP0" ]] && echo newer || echo "stale:$STAMP0->$STAMP1")"
for p in $SERVEPIDS; do kill "$p" 2>/dev/null; done
rm -f "$EDIR/.5dive-serve"

# --- T24h the sweep rides the schedule that already exists -------------------
tc 'T24h the scheduled probe runs the idle sweep' 'cmd_evict' \
   "$(sed -n '/^cmd_probe_all/,/^}/p' "$BROWSER")"
tc 'T24h ...and it can be turned off on a box that wants its browsers resident' \
   'FIVEDIVE_BROWSER_EVICT_ON_PROBE' "$(sed -n '/^cmd_probe_all/,/^}/p' "$BROWSER")"

# ============================== T25 DIVE-4621: the session daemon (scope (a)) ==
#
# WHAT THESE GRADE. `serve` used to be an Xvfb and an abandoned Chrome, and every
# command that needed the profile stopped it, launched its own, and started it
# again — four launches for an action that is three clicks. A daemon holds ONE
# persistent context and answers over a unix socket in the 0700 profile. Each arm
# below is a mutant of the specific way that goes wrong:
#
#   the socket becomes a port       -> T25f: a debug port is REFUSED.
#   a warm serve gets cycled anyway -> T25c: the daemon pid must SURVIVE a `run`.
#   the lease is read once          -> T25d: preempt between two steps of a publish.
#   "ready" means "bash got a pid"  -> T25b: a daemon that never comes up must not
#                                      be advertised, must not take the browser
#                                      down with it, and must say why.
#   the daemon dies mid-request     -> T25h: a closed socket is NOT a clean run.
#
# The daemon loads playwright the way the driver does, so it is graded through a
# recording stub on NODE_PATH — with the two methods a long-lived context needs
# that a one-shot driver never asked for: a page that can be closed, and a
# document it can hand back.
DAEMONBIN="$ROOT/plugins/browser/bin/session-daemon"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$DAEMONBIN"
DSTUB="$TMP/dpw"; mkdir -p "$DSTUB/node_modules/playwright-core"
printf '{ "name": "playwright-core", "version": "0.0.0-daemon-stub", "main": "index.js" }\n' \
  > "$DSTUB/node_modules/playwright-core/package.json"
cat > "$DSTUB/node_modules/playwright-core/index.js" <<'DPWJS'
const fs = require('fs');
const rec = (o) => fs.appendFileSync(process.env.PWREC, JSON.stringify(o) + '\n');
let markWalks = 0;   // DIVE-4674, see the driver stub
const mkpage = (kind) => ({
  setDefaultTimeout: (t) => rec({ call: 'setDefaultTimeout', t, kind }),
  // DPWGOTO_MS: a page that takes real time to load, so two requests can
  // overlap in the daemon (DIVE-4927, T27m). Unset, a goto is instant as before.
  goto: async (url) => { rec({ call: 'goto', url, kind });
    if (process.env.DPWGOTO_MS) await new Promise((r) => setTimeout(r, Number(process.env.DPWGOTO_MS))); },
  content: async () => { rec({ call: 'content', kind }); return fs.readFileSync(process.env.DPWDOM, 'utf8'); },
  fill: async (sel, val) => {
    rec({ call: 'fill', sel, val, kind });
    if (process.env.PWPREEMPT_FILE) {
      fs.writeFileSync(process.env.PWPREEMPT_FILE,
        'token=belongs-to-the-person-at-the-viewer\nholder=someone\nholder_pid=1\nkind=human\n');
    }
  },
  click: async (sel) => { rec({ call: 'click', sel, kind }); if (process.env.PWFAIL) throw new Error('stub: the step failed'); },
  waitForSelector: async (sel) => rec({ call: 'waitForSelector', sel, kind }),
  waitForTimeout: async (ms) => rec({ call: 'waitForTimeout', ms, kind }),
  // DIVE-4943: `act` re-reads the page the steps left, and the owner-approval
  // guard reads the live label. The daemon's env is fixed at `serve` time, so the
  // label an arm wants is read from a FILE per call (DPWLABEL), not from env.
  url: () => 'https://warm.test/after',
  title: async () => 'warm after',
  evaluate: async (fn, arg) => {
    if (arg && arg.riskOf) {
      rec({ call: 'label', kind });
      try { return fs.readFileSync(process.env.DPWLABEL, 'utf8').trim(); } catch (e) { return ''; }
    }
    const mark = (arg && arg.mark) || null;
    if (mark) markWalks++;
    rec({ call: 'evaluate', kind, mark, walkN: mark ? markWalks : null, snapshot: !!(arg && arg.snapshot) });
    // PWWALK_MISS: the same not-there-yet page the driver stub can produce
    // (DIVE-4674). The warm loop is a SECOND copy of the step loop, so it needs
    // the same fixture or half the product stays ungraded.
    if (mark && process.env.PWWALK_MISS) {
      if (markWalks <= Number(process.env.PWWALK_MISS)) {
        return { nodes: [{ role: 'textbox', name: 'Something Else', ref: 'textbox/Something Else' }],
                 marker: null };
      }
      return { nodes: [], marker: 'late-1' };
    }
    if (arg && arg.snapshot && process.env.DPWSNAP) return JSON.parse(fs.readFileSync(process.env.DPWSNAP, 'utf8'));
    return { nodes: [], marker: null };
  },
  screenshot: async (o) => {
    rec({ call: 'screenshot', path: (o && o.path) || null, fullPage: !!(o && o.fullPage), kind });
    // A PATHLESS screenshot returns the BYTES, which is the shape the render op
    // uses: a brokered caller is handed the image over the socket and writes it
    // itself, because a daemon writing a caller-chosen path writes it as the
    // profile's owner (DIVE-4664).
    if (o && o.path) { fs.writeFileSync(o.path, process.env.PWSHOT || 'stub-png'); return; }
    return Buffer.from(process.env.PWSHOT || 'stub-png');
  },
  setViewportSize: async (v) => rec({ call: 'setViewportSize', w: v && v.width, h: v && v.height, kind }),
  selectOption: async (sel, val) => rec({ call: 'selectOption', sel, val, kind }),
  setInputFiles: async (sel, p) => rec({ call: 'setInputFiles', sel, path: p, kind }),
  press: async (sel, key) => rec({ call: 'press', sel, key, kind }),
  close: async () => rec({ call: 'pageclose', kind }),
});
const first = mkpage('first');
exports.chromium = {
  launchPersistentContext: async (profile, opts) => {
    rec({ call: 'launch', profile, args: opts.args, headless: opts.headless,
          xdg: process.env.XDG_CONFIG_HOME === undefined ? '<unset>' : process.env.XDG_CONFIG_HOME });
    if (process.env.DPWNOLAUNCH) throw new Error('stub: this box cannot open the profile');
    return { pages: () => [first], newPage: async () => mkpage('extra'), close: async () => rec({ call: 'close' }) };
  },
};
DPWJS
# WHEREVER THIS BOX'S `serve` PUTS THE SOCKET. Since DIVE-4664 that is the broker
# rendezvous when setup has made one (this suite has run setup) and the 0700
# profile otherwise, so the arms below name it once here rather than each pinning
# a path — a pinned path grades the path instead of the property.
WSOCK_ANY() { local p; p="$(dkv "$WDIR/.5dive-serve" sock)"; printf '%s\n' "${p:-$WDIR/.5dive-session.sock}"; }
WSOCK_RV="$TMP/browser-sessions/$SEAT/warm.test.sock"
DPWDOM="$TMP/dpw.dom"; printf '%s' "$LIVE_DOM" > "$DPWDOM"
DREC="$TMP/dpw-record.jsonl"; : > "$DREC"
# The daemon runs in ITS OWN process with its own environment, so the stub has to
# reach it through `serve`'s environment and not through the arm's.
dserve() {  # dserve <site> [extra env assignments...]
  local site="$1"; shift
  run env PATH="$SPATH" DISPLAY= NODE_PATH="$DSTUB/node_modules" PWREC="$DREC" DPWDOM="$DPWDOM" \
      "$@" "$BROWSER" serve "$site"
}
dwarm() {  # dwarm <verb...> — a command that should find the warm session
  run env PATH="$SPATH" NODE_PATH="$DSTUB/node_modules" PWREC="$DREC" DPWDOM="$DPWDOM" "$@"
}
dkv() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }
launches() { jq -rs '[.[]|select(.call=="launch")]|length' "$DREC"; }

mkprofile warm.test "$LIVE_DOM" >/dev/null
WDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/warm.test"
mkadapter warm.test "file://$TMP/artifact.html" 'PUBLISHED'

# --- T25a `serve` holds the session in a daemon -------------------------------
dserve warm.test
t  'T25a serve starts and reports a warm session' 0 "$RC"
tc 'T25a ...and says the browser now outlives the command' 'warm session' "$OUT"
WPID="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25a ...the pidfile names the daemon' 'yes' "$([[ -n "$WPID" ]] && echo yes || echo no)"
t  'T25a ...the daemon is alive' 'yes' "$(kill -0 "${WPID:-0}" 2>/dev/null && echo yes || echo no)"
# WHERE THE SOCKET LIVES IS DIVE-4664'S BUSINESS NOW, and it has two answers, so
# this arm follows the product (the pidfile names it) instead of pinning one of
# them: the 0700 profile on a box with no broker rendezvous, the rendezvous where
# `setup` has made one. It is a SOCKET and never a port in both. This suite has
# run `setup`, so it has a rendezvous; T25a2 is the other shape.
WSOCK="$(dkv "$WDIR/.5dive-serve" sock)"
t  'T25a ...and the session is reached by a SOCKET, not a port' 'socket' \
   "$(stat -c '%F' "$WSOCK" 2>/dev/null)"
t  'T25a ...at a filesystem path, where the MODE is the access control' 'yes' \
   "$([[ "$WSOCK" == /* ]] && echo yes || echo no)"
t  'T25a ...group-reachable in the rendezvous, because that IS the broker (DIVE-4664)' '770' \
   "$(stat -c '%a' "$WSOCK" 2>/dev/null)"
t  'T25a ...and it LEFT the 0700 profile rather than being duplicated into it' 'no' \
   "$([[ -e "$WDIR/.5dive-session.sock" ]] && echo yes || echo no)"

# --- T25a2 a box with NO rendezvous keeps the old one-seat socket -------------
# The broker is additive (DIVE-4664). A box that has not re-run `setup`, or one
# whose rendezvous could not be made, must still get a warm session — just one
# that only its owner can reach, which is exactly what it had before.
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
dserve warm.test FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/no-rendezvous-here"
t  'T25a2 serve still holds a warm session with no rendezvous on the box' 0 "$RC"
tn 'T25a2 ...and does not claim to broker one' 'brokered at' "$OUT"
t  'T25a2 ...the socket goes back inside the 0700 profile' 'socket' \
   "$(stat -c '%F' "$WDIR/.5dive-session.sock" 2>/dev/null)"
t  'T25a2 ...created 0700 — one seat, exactly as before' '700' \
   "$(stat -c '%a' "$WDIR/.5dive-session.sock" 2>/dev/null)"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
dserve warm.test
WPID="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25a ...the context was opened headed, in THIS profile' "false $WDIR" \
   "$(jq -rs '[.[]|select(.call=="launch")]|last|"\(.headless) \(.profile)"' "$DREC")"
t  'T25a ...with the shared XDG_CONFIG_HOME unset under it (DIVE-4587)' '<unset>' \
   "$(jq -rs '[.[]|select(.call=="launch")]|last|.xdg' "$DREC")"

# --- T25b a daemon that will not come up must not be advertised ---------------
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
dserve warm.test DPWNOLAUNCH=1
t  'T25b serve still SERVES when the daemon cannot start' 0 "$RC"
tn 'T25b ...and does not claim a warm session' 'warm session' "$OUT"
tc 'T25b ...it says every command will pay a cold launch' 'no warm session' "$ERR"
tc 'T25b ...and carries the daemon own reason' 'cannot open the profile' "$ERR"
t  'T25b ...no daemon is left recorded' '' "$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25b ...and no stale socket is left behind, in either place it could be' 'no no' \
   "$([[ -S "$WDIR/.5dive-session.sock" ]] && echo yes || echo no) $([[ -S "$WSOCK_RV" ]] && echo yes || echo no)"
t  'T25b ...the browser IS up anyway — losing the speed must not lose the session' 'yes' \
   "$([[ -n "$(dkv "$WDIR/.5dive-serve" chrome_pid)" ]] && echo yes || echo no)"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1

# --- T25c a `run` on a warm session does not cycle the browser ----------------
dserve warm.test
WPID="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
LB="$(launches)"
CB="$(jq -rs '[.[]|select(.call=="close")]|length' "$DREC")"
dwarm "$BROWSER" run warm.test publish --body=hello
t  'T25c a run through the warm session succeeds' 0 "$RC"
tc 'T25c ...and the verdict is still the out-of-band re-read' 'verified: publish is live' "$OUT"
t  'T25c ...the SAME daemon is still holding the browser afterwards' "$WPID" \
   "$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25c ...it was never stopped and restarted' 'yes' \
   "$(kill -0 "${WPID:-0}" 2>/dev/null && echo yes || echo no)"
# THE POINT OF THE WHOLE ROW, as a number: not one new browser was launched.
t  'T25c ...and NOT ONE Chrome was launched to do it' "$LB" "$(launches)"
t  'T25c ...the steps reached the page, in order' 'goto fill click' \
   "$(jq -rs '[.[]|select(.kind=="first")|select(.call|IN("goto","fill","click"))|.call]|join(" ")' "$DREC")"
t  'T25c ...with the caller argument substituted as a VALUE' 'hello' \
   "$(jq -rs '[.[]|select(.call=="fill")|.val]|last' "$DREC")"
t  'T25c ...and the session was NOT closed when the command finished' "$CB" \
   "$(jq -rs '[.[]|select(.call=="close")]|length' "$DREC")"

# --- T25d the DAEMON re-reads the lease before every step ---------------------
# The token now travels in the REQUEST, because the daemon outlives every caller
# and serves callers holding different tokens. The mutant is a daemon that trusts
# the token it was handed at connect: a person redeems a viewer at step 2 of a
# publish and the machine types through them.
# THE ENV OF THE COMMAND IS NOT THE ENV OF THE DAEMON, and that is the whole
# shape of this row: the stub runs INSIDE a process started by an earlier
# `serve`, so PWPREEMPT_FILE on the `run` command line reaches nothing at all and
# the arm would pass green having injected no preemption. Arm it at the serve.
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
dserve warm.test PWPREEMPT_FILE="$WDIR/.5dive-lease/meta"
t  'T25d (anchor) the preempting session really is the one holding the browser' 'yes' \
   "$([[ -n "$(dkv "$WDIR/.5dive-serve" daemon_pid)" ]] && echo yes || echo no)"
CLICKS_BEFORE="$(jq -rs '[.[]|select(.call=="click")]|length' "$DREC")"
dwarm "$BROWSER" run warm.test publish --body=hello
tc 'T25d a person taking the lease mid-run stops the run' 'TAKEN by someone else' "$ERR"
t  'T25d ...the step AFTER the preemption never ran' "$CLICKS_BEFORE" \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$DREC")"
tn 'T25d ...and it is NOT reported as nothing-ran' 'nothing was published' "$ERR"
# AND THE EXIT STATUS IS STILL THE RE-READ'S, NOT THE EXECUTOR'S. This arm was
# written expecting a red and the product was right: an action interrupted at
# step 3 of 3 may well have published, the artifact IS live at its permalink, and
# reporting failure there is precisely the lie that double-posts on a retry. The
# executor's refusal is evidence; the out-of-band re-read is the verdict.
t  'T25d ...and the verdict is the ARTIFACT, not the interrupted executor' 0 "$RC"
tc 'T25d ...which is what it says' 'verified: publish is live' "$OUT"
# THE OTHER DIRECTION, or the arm above grades nothing: with no artifact at the
# permalink, the same interrupted run must read NOT VERIFIED.
mkadapter warm.test "file://$TMP/never-published.html" 'PUBLISHED'
CLICKS_BEFORE="$(jq -rs '[.[]|select(.call=="click")]|length' "$DREC")"
dwarm "$BROWSER" run warm.test publish --body=hello
t  'T25d (control) preempted, and nothing at the permalink, reads NOT VERIFIED' 1 "$RC"
tc 'T25d (control) ...and warns against a blind retry' 'Do NOT retry blind' "$ERR"
t  'T25d (control) ...having still stopped before the click' "$CLICKS_BEFORE" \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$DREC")"
mkadapter warm.test "file://$TMP/artifact.html" 'PUBLISHED'
rm -rf "$WDIR/.5dive-lease"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
dserve warm.test

# --- T25e `tree` enumerates out of the warm session ---------------------------
LB="$(launches)"
dwarm "$BROWSER" tree warm.test https://warm.test/compose --json
t  'T25e tree runs against the warm session' 0 "$RC"
t  'T25e ...launching nothing' "$LB" "$(launches)"
tc 'T25e ...and still prints the ref tree' '"url":"https://warm.test/compose"' "$OUT"

# --- T25f the face is a socket and a debug PORT is refused --------------------
run env NODE_PATH="$DSTUB/node_modules" PWREC="$DREC" DPWDOM="$DPWDOM" \
    FIVEDIVE_BROWSER_CHROME=/bin/true FIVEDIVE_BROWSER_CHROME_ARGS=--remote-debugging-port=9222 \
    "$DAEMONBIN" serve "$WDIR" "$TMP/t25f.sock"
t  'T25f a debug PORT is refused before anything opens' 70 "$RC"
tc 'T25f ...naming what it would give away' 'full control of the browser' "$ERR"
t  'T25f ...and no socket was created' 'no' "$([[ -S "$TMP/t25f.sock" ]] && echo yes || echo no)"
t  'T25f (control) the shipped launch names no debug flag at all' '0' \
   "$(jq -rs '[.[]|select(.call=="launch")|.args[]?|select(startswith("--remote-debugging"))]|length' "$DREC")"

# --- T25g `status` can finally read a SERVED profile --------------------------
# Before this row a served profile answered "UNKNOWN (served on :N)" — Chrome
# allows one instance per --user-data-dir, and both fixes on the table needed a
# port. The daemon is the third shape: a process that outlives the command,
# reached over a 0700 socket.
dwarm "$BROWSER" status warm.test
tc 'T25g a served profile now reads through the daemon' 'authenticated' "$OUT"
tn 'T25g ...instead of the served non-answer' 'served on' "$OUT"
t  'T25g ...in its OWN tab, so nobody at the viewer is navigated away' 'extra' \
   "$(jq -rs '[.[]|select(.call=="content")]|last|.kind' "$DREC")"
t  'T25g ...and that tab is closed again' 'extra' \
   "$(jq -rs '[.[]|select(.call=="pageclose")]|last|.kind' "$DREC")"
# CONTROL: the refusal is still there where there is no daemon to ask.
mkprofile cold.test "$LIVE_DOM" >/dev/null
CDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/cold.test"
( umask 077; printf 'display=999\nxvfb_pid=%s\nchrome_pid=%s\n' "$$" "$$" > "$CDIR/.5dive-serve" )
run env PATH="$SPATH" "$BROWSER" status cold.test
tc 'T25g (control) with no daemon, a served profile still refuses to guess' 'served on :999' "$OUT"
rm -f "$CDIR/.5dive-serve"

# --- T25h a daemon that dies MID-REQUEST is not a clean run -------------------
# The mutant is node default behaviour: the connection closes, the client exits
# 0, and bin/browser goes on to re-read a verify URL that already existed — a
# publish nobody performed, reported green, with a receipt. This is graded
# against a socket that ACCEPTS and then dies, which is the only way to enter the
# window: a daemon that is already gone is a connect error, a different path.
cat > "$TMP/t25h-server.js" <<'T25H'
const net = require('net');
net.createServer((c) => { c.on('data', () => { c.destroy(); process.exit(1); }); })
   .listen(process.argv[2]);
T25H
node "$TMP/t25h-server.js" "$TMP/t25h.sock" &
T25HPID=$!
for _ in $(seq 1 50); do [[ -S "$TMP/t25h.sock" ]] && break; sleep 0.1; done
run env FIVEDIVE_BROWSER_CHROME=/bin/true "$DAEMONBIN" call "$TMP/t25h.sock" <<< '{"op":"plan","steps":[{"op":"goto","url":"https://warm.test/x"}],"args":{}}'
t  'T25h a session that dies mid-request does not exit 0' 'nonzero' \
   "$([[ "$RC" == 0 ]] && echo zero || echo nonzero)"
tc 'T25h ...it says the browser holding the profile is gone' 'is gone' "$ERR"
tc 'T25h ...and does not claim nothing happened' 'already ran are still real' "$ERR"
kill "$T25HPID" 2>/dev/null
# AND THE OTHER HALF: a daemon that is simply GONE is not a failure at all — the
# cold path is still there, and a command must take it rather than refuse.
WPID="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
kill -9 "$WPID" 2>/dev/null
rm -f "$WDIR/.5dive-session.sock" "$WSOCK_RV"
# NOT $SPATH HERE. That PATH's fake chrome answers a --headless probe with an
# empty document (it exists to be a SERVE, not a probe), so the cold fallback
# would refuse on liveness and the arm would grade the fake instead of the
# fallback. The suite's own probe-answering chrome is on the default PATH.
run env NODE_PATH="$DSTUB/node_modules" PWREC="$DREC" DPWDOM="$DPWDOM" \
    "$BROWSER" run warm.test publish --body=hello
t  'T25h a dead daemon falls back to the cold path rather than refusing' 0 "$RC"
tc 'T25h ...and the run still happened' 'verified: publish is live' "$OUT"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1

# --- T25i `serve --stop` takes the daemon and the socket with it --------------
dserve warm.test
WPID="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
run env PATH="$SPATH" "$BROWSER" serve warm.test --stop
t  'T25i stop returns cleanly' 0 "$RC"
t  'T25i ...the daemon is gone' 'gone' \
   "$(kill -0 "${WPID:-0}" 2>/dev/null && echo alive || echo gone)"
t  'T25i ...the socket is gone with it, wherever serve had put it' 'no' \
   "$([[ -S "$(WSOCK_ANY)" || -S "$WDIR/.5dive-session.sock" || -S "$WSOCK_RV" ]] && echo yes || echo no)"
# THE GRACEFUL PATH IS THE ROUTE, NOT THE BACKSTOP: closing the context is how
# Chrome writes the profile out, and the profile holding the login is the durable
# half. A SIGKILL mid-write corrupts exactly that.
tc 'T25i ...and it was ASKED to go before it was killed' 'shutdown' \
   "$(sed -n '/^cmd_serve/,/^}/p' "$BROWSER")"
tc 'T25i ...the profile is still reported as the durable half' 'profile is untouched' "$OUT"

# --- T25j a second caller mid-request waits a BOUNDED time, then is refused ----
# DIVE-4927 replaced the on-the-spot refusal with a bounded wait; the behaviour
# is graded in T27m. What stays here is the refusal's shape once the bound runs out.
tc 'T25j a busy session still refuses once the wait is spent' 'still busy with' \
   "$(cat "$DAEMONBIN")"
tc 'T25j ...and says nothing ran, so no artifact is re-read as evidence' 'Nothing ran' \
   "$(cat "$DAEMONBIN")"

# --- T25k `shot` on a WARM profile: down, render, and a LIVE daemon back ------
# ITERATION 2, AND IT IS A COMPOSITION ARM ON PURPOSE. Every other T25 arm
# reaches the daemon because the arm puts the stub on NODE_PATH; every `shot` and
# `read` arm in this suite therefore runs with the daemon effectively pinned off,
# so the one path a served customer actually takes on a render — take the daemon
# DOWN, drive a second chrome at the profile it was holding, bring a daemon BACK
# — was reasoned about and never executed. The pieces each have an arm (T25i:
# `--stop` closes and unlinks; T25a: a restart comes back warm) and that is
# exactly the shape that hides a composition defect: Chrome allows one instance
# per --user-data-dir, so a render that starts while the daemon's Chrome still
# owns the profile is a do-nothing launch, and `cmd_serve --stop`'s SIGTERM
# backstop is the only thing between the two.
#
# THE THREE THINGS IT ASSERTS, and none of them is "the code says so":
#   asked to go   -> the stub records a context close. A SIGKILL records nothing,
#                    and the profile is written out by the close.
#   it rendered   -> rc 0 and a non-empty PNG of the url asked for.
#   warm again    -> a NEW pid, alive, and a socket that ANSWERS a ping. A pidfile
#                    with a dead pid in it is what "restored" looks like when the
#                    restore only half worked.
# This PATH has to do three jobs in one arm: a headed chrome that stays up (the
# serve), a headless one that honours --screenshot (the render) — both are
# SHOTBIN — and a fake Xvfb, which is SBIN.
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
KPATH="$SHOTBIN:$SBIN:$PATH"
KREC="$TMP/dpw-shot.jsonl"; : > "$KREC"
kenv() { env PATH="$KPATH" DISPLAY= SHOTARGV="$TMP/k-argv.txt" \
             NODE_PATH="$DSTUB/node_modules" PWREC="$KREC" DPWDOM="$DPWDOM" "$@"; }
# THE SOCKET PATH IS READ FROM THE PIDFILE AT CALL TIME, not pinned: since
# DIVE-4664 `serve` puts it in the broker rendezvous where the box has one, and
# an arm that pins the old path grades the path instead of the liveness.
kping() { kenv "$DAEMONBIN" call "$(dkv "$WDIR/.5dive-serve" sock)" <<< '{"op":"ping"}'; }

run kenv "$BROWSER" serve warm.test
KPID1="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25k (anchor) the profile really is held by a live daemon first' 'warm' \
   "$([[ -n "$KPID1" ]] && kill -0 "$KPID1" 2>/dev/null && kping >/dev/null 2>&1 && echo warm || echo cold)"
KCLOSES="$(jq -rs '[.[]|select(.call=="close")]|length' "$KREC")"

rm -f "$SHOTOUT/k.png"
run kenv "$BROWSER" shot warm.test "https://warm.test/p" --out="$SHOTOUT/k.png"
t  'T25k a shot on a served-and-WARM profile renders' 0 "$RC"
t  'T25k ...and the PNG exists and is non-empty' 'yes' \
   "$([[ -s "$SHOTOUT/k.png" ]] && echo yes || echo no)"
tc 'T25k ...of the URL asked for' 'https://warm.test/p' "$(cat "$SHOTOUT/k.png" 2>/dev/null)"
t  'T25k ...the daemon was ASKED to close its context, not just killed' 'closed' \
   "$([[ "$(jq -rs '[.[]|select(.call=="close")]|length' "$KREC")" -gt "$KCLOSES" ]] && echo closed || echo killed-only)"
t  'T25k ...the daemon that was holding the profile is gone' 'gone' \
   "$(kill -0 "${KPID1:-0}" 2>/dev/null && echo alive || echo gone)"
KPID2="$(dkv "$WDIR/.5dive-serve" daemon_pid)"
t  'T25k ...a NEW daemon is recorded afterwards' 'new' \
   "$([[ -n "$KPID2" && "$KPID2" != "$KPID1" ]] && echo new || echo "none:$KPID2")"
t  'T25k ...it is ALIVE, not just a pid in a file' 'alive' \
   "$(kill -0 "${KPID2:-0}" 2>/dev/null && echo alive || echo dead)"
t  'T25k ...and its socket ANSWERS — the profile is warm again, not just served' 'pong' \
   "$(kping 2>/dev/null | tr -d '\n')"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1

# ============= T26 DIVE-4653: one snapshot per decision, not one verb per field
#
# WHAT IS GRADED HERE, and it is two claims, not one.
#
# (1) THE COUNT. The three reads an agent makes before it acts — refs, document,
#     picture — cost three browser cycles and three loads of the same URL today,
#     one per verb. `snapshot` costs one of each. The arms count the tape rather
#     than the clock: a wall-clock number is a fact about this runner, a call
#     count is a fact about the design, and the upstream measurement this row
#     lifts (1092 protocol calls where 101 do the work) is a count too.
#
# (2) THE INSTANT, which is the half that survives a fast box. Three cycles are
#     three different page instants, so the refs, the Markdown and the PNG in one
#     artifact directory can disagree with each other and nothing in them says
#     so. These arms prove the three outputs come from ONE evaluate of ONE tab:
#     the document hashed in page.meta.json is the document the refs were walked
#     out of, and the PNG was taken through the same page object with no second
#     navigation.
#
# The mutants that would pass a weaker suite: a `snapshot` that simply CALLS tree
# then read then shot internally (T26b, T26c), one that re-navigates for the PNG
# (T26d), one that writes evidence from a capture that failed (T26g), and one
# that reaches the page by a second, laxer walk of its own (T26c).
#
# THE COLD ARMS RUN ON A COLD PROFILE, and saying so is not housekeeping: an
# earlier section leaves shot.example.com SERVED, and a served profile is exactly
# the case where `snapshot` goes through the daemon instead of the driver — so
# without this stop the arms below would grade the warm path while claiming to
# grade the cold one, and their tape would be empty. The warm path has its own
# arms (T26i) with its own tape.
env PATH="$READPATH" "$BROWSER" serve shot.example.com --stop >/dev/null 2>&1
# AND THE SHIPPED DRIVER IS WHAT RUNS. An earlier section left `mkdriver`'s stub
# exported, and that stub exits 0 having written nothing — which is precisely the
# shape `snapshot` refuses ("the capture produced no document"), so every arm
# below would red on a correct product and blame the wrong file. T16a does the
# same unset for the same reason.
unset FIVEDIVE_BROWSER_DRIVER
SNAPWALK="$TMP/snap-walk.json"
SNAPOUT="$TMP/snap-evidence"
jq -n --arg html "$(cat "$READHTML")" '{
  nodes: [ {ref:"link/Next signal", role:"link", name:"Next signal", tag:"a"},
           {ref:"heading/Signal Article", role:"heading", name:"Signal Article", tag:"h1"} ],
  marker: null,
  title: "Signal Article",
  url: "https://shot.example.com/article/1",
  html: $html
}' > "$SNAPWALK"

SNAPARGV="$TMP/snap-argv.txt"
snapenv() { env PATH="$READPATH" READARGV="$SNAPARGV" READ_HTML="$READHTML" \
                NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$SNAPWALK" "$@"; }
pwn() { jq -rs "[.[]|select(.call==\"$1\")]|length" "$PWREC"; }

: > "$PWREC"; : > "$SNAPARGV"; rm -rf "$SNAPOUT"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$SNAPOUT"
t  'T26a snapshot exits zero for the authenticated page' 0 "$RC"
t  'T26a ...and leaves ONE artifact directory holding all four outputs' 'yes' \
   "$([[ -s "$SNAPOUT/page.md" && -s "$SNAPOUT/page.html" && -s "$SNAPOUT/page.meta.json" && -s "$SNAPOUT/tree.json" && -s "$SNAPOUT/page.png" ]] && echo yes || echo no)"
t  'T26a ...each one seat-private' '600 600 600 600 600' \
   "$(stat -c %a "$SNAPOUT/page.html" "$SNAPOUT/page.md" "$SNAPOUT/page.meta.json" "$SNAPOUT/tree.json" "$SNAPOUT/page.png" | tr '\n' ' ' | sed 's/ $//')"
tc 'T26a the document went through the pinned extractor' 'useful authenticated article content' "$(cat "$SNAPOUT/page.md")"
t  'T26a the refs are addressable' 'link/Next signal' "$(jq -r '.nodes[0].ref' "$SNAPOUT/tree.json")"
t  'T26a ...and the payload names the URL the page SETTLED on' 'https://shot.example.com/article/1' \
   "$(jq -r '.url' "$SNAPOUT/tree.json")"

# --- T26b THE COUNT: one cycle, one load -------------------------------------
t  'T26b one browser was launched for the whole decision' '1' "$(pwn launch)"
t  'T26b ...the page was loaded exactly ONCE' '1' "$(pwn goto)"
t  'T26b ...and the page was read exactly ONCE' '1' "$(pwn evaluate)"
t  'T26b ...that read was the atomic one, not the plain walk' 'true' \
   "$(jq -rs '[.[]|select(.call=="evaluate")|.snapshot]|first' "$PWREC")"
t  'T26b the browser was closed again — no session left held' '1' "$(pwn close)"
# THE CONTROL, and without it the four numbers above are unattributable: the same
# decision, taken the way it is taken today. `tree` is the same playwright tape;
# `read` and `shot` drive chrome directly, so their loads are counted off the
# chrome argv log. Three cycles, three loads of the same URL, three page instants.
CTLARGV="$TMP/snap-ctl-argv.txt"
ctlenv() { env PATH="$READPATH" READARGV="$CTLARGV" READ_HTML="$READHTML" \
               NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$SNAPWALK" "$@"; }
: > "$PWREC"; : > "$CTLARGV"; rm -rf "$TMP/snap-ctl-read" "$TMP/snap-ctl.png"
ctlenv "$BROWSER" tree shot.example.com "https://shot.example.com/article/1" >/dev/null 2>&1
ctlenv "$BROWSER" read shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-ctl-read" >/dev/null 2>&1
ctlenv "$BROWSER" shot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-ctl.png" >/dev/null 2>&1
CTL_CYCLES=$(( $(pwn launch) + $(grep -c -- '--user-data-dir' "$CTLARGV" 2>/dev/null || echo 0) ))
CTL_TARGET=$(( $(pwn goto) + $(grep -c -- 'article/1' "$CTLARGV" 2>/dev/null || echo 0) ))
t  'T26b (control) the three verbs it replaces open THREE browser cycles, before probes' 'yes' \
   "$([[ "$CTL_CYCLES" -ge 3 ]] && echo yes || echo "no:$CTL_CYCLES")"
t  'T26b (control) ...and load the SAME url three times, at three different instants' 'yes' \
   "$([[ "$CTL_TARGET" -ge 3 ]] && echo yes || echo "no:$CTL_TARGET")"

# --- T26c ONE WALK: the refs and the document are the same observation --------
# The mutant this stops is the cheap implementation of this whole verb — a
# `snapshot` that shells out to tree, then to read, and staples the outputs
# together. It would pass T26a completely.
t  'T26c the bytes hashed in the metadata ARE the page.html that shipped' \
   "$(sha256sum "$SNAPOUT/page.html" | cut -d' ' -f1)" "$(jq -r .sha256 "$SNAPOUT/page.meta.json")"
t  'T26c the metadata names the capture honestly, and not as a dump-dom' 'snapshot' \
   "$(jq -r .capture "$SNAPOUT/page.meta.json")"
t  'T26c no --dump-dom chrome ran for this capture at all' 'none' \
   "$(grep -c -- '--dump-dom.*article/1' "$SNAPARGV" 2>/dev/null | sed 's/^0$/none/')"
t  'T26c ...and no --screenshot chrome ran for it either' 'none' \
   "$(grep -c -- '--screenshot' "$SNAPARGV" 2>/dev/null | sed 's/^0$/none/')"
t  'T26c the derivation is the one `read` uses — same extractor pin' '0.19.3' \
   "$(jq -r .defuddle_version "$SNAPOUT/page.meta.json")"

# --- T26d the PNG is the SAME TAB, not a second visit ------------------------
: > "$PWREC"; rm -rf "$TMP/snap-shot2"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-shot2"
t  'T26d the screenshot was taken through the page already open' '1' "$(pwn screenshot)"
t  'T26d ...with NO second navigation to take it' '1' "$(pwn goto)"
t  'T26d ...and it landed where the artifact directory says' 'yes' \
   "$([[ -s "$TMP/snap-shot2/page.png" ]] && echo yes || echo no)"
: > "$PWREC"; rm -rf "$TMP/snap-noshot"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-noshot" --no-shot
t  'T26d --no-shot takes no picture at all' '0' "$(pwn screenshot)"
t  'T26d ...and ships no PNG next to the rest' 'no' \
   "$([[ -e "$TMP/snap-noshot/page.png" ]] && echo yes || echo no)"
t  'T26d ...while the document and the refs are still there' 'yes' \
   "$([[ -s "$TMP/snap-noshot/page.md" && -s "$TMP/snap-noshot/tree.json" ]] && echo yes || echo no)"

# --- T26e a snapshot is still a READ of a logged-in profile -------------------
# Every guard the other render verbs earned applies here, and they are re-graded
# rather than assumed: this verb reaches the profile by its own road.
printf '%s' "$DEAD_DOM" > "$SHOTDIR/.fake-dom"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-loggedout"
t  'T26e a logged-out snapshot refuses' 75 "$RC"
t  'T26e ...and writes nothing, not even an empty directory' 'no' \
   "$([[ -e "$TMP/snap-loggedout" ]] && echo yes || echo no)"
printf '%s' "$LIVE_DOM" > "$SHOTDIR/.fake-dom"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$SHOTDIR/snapderived"
t  'T26e an output beneath the browser profile is refused' 77 "$RC"
t  'T26e ...and nothing is left in the profile' 'no' \
   "$([[ -e "$SHOTDIR/snapderived" ]] && echo yes || echo no)"
run snapenv "$BROWSER" snapshot shot.example.com "https://other.example.com/article/1" --out="$TMP/snap-crosssite"
t  'T26e a url outside the profile'"'"'s site is refused' 64 "$RC"
: > "$PWREC"
run snapenv "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-json" --json
t  'T26f --json prints one object a caller can act on' 'yes' \
   "$(jq -e '.title == "Signal Article" and (.nodes|length) == 2 and (.artifacts|type=="string")' <<<"$OUT" >/dev/null && echo yes || echo no)"

# --- T26g A CAPTURE THAT FAILED WRITES NO EVIDENCE ---------------------------
# The shape this file has refused since T15: an artifact directory is read as an
# observation of the page, so a partial one is worse than none. Driven with a
# walk fixture that returns an EMPTY document, which is what a capture that never
# reached the page looks like from here.
printf '{"nodes":[],"marker":null,"title":"","url":"https://shot.example.com/article/1","html":""}' > "$TMP/snap-empty.json"
rm -rf "$TMP/snap-fail"
run env PATH="$READPATH" READARGV="$READARGV" READ_HTML="$READHTML" \
        NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$TMP/snap-empty.json" \
        "$BROWSER" snapshot shot.example.com "https://shot.example.com/article/1" --out="$TMP/snap-fail"
t  'T26g an empty capture is a refusal, not an empty evidence set' 69 "$RC"
t  'T26g ...and no page.md was written for a page nobody read' 'no' \
   "$([[ -e "$TMP/snap-fail/page.md" ]] && echo yes || echo no)"
# THE DRIVER'S OWN GUARD, driven directly: a relative path for the document is a
# refusal BEFORE the browser opens, so a caller that got it wrong does not learn
# about it by finding a file in whatever directory the daemon happened to be in.
: > "$PWREC"
printf '{"profile":"%s","mode":"snapshot","url":"https://x.test/","html":"page.html"}' \
  "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/x" | \
  env NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" FIVEDIVE_BROWSER_CHROME=/bin/true \
      "$DRV" >/dev/null 2>"$TMP/t26g.err"; RC=$?
t  'T26g the driver refuses a relative document path' 70 "$RC"
t  'T26g ...before opening a browser to find out' '0' "$(pwn launch)"

run env PATH="$READPATH" "$BROWSER" --help
tc 'T26h --help lists snapshot' '5dive browser snapshot' "$OUT"
tc 'T26h README documents the one-cycle read' 'browser snapshot' "$(cat "$ROOT/plugins/browser/README.md")"
tc 'T26h the agent-facing doc tells an agent to reach for it first' 'browser snapshot' \
   "$(cat "$ROOT/plugins/browser/AGENTS.md")"

# --- T26i THE WARM PATH: the daemon got the render op it did not have ---------
# DIVE-4621 shipped the session daemon with probe/tree/plan and said so in its
# own header: `shot` and `read` keep cycling a cold chrome because the daemon has
# no way to hand back a document or a picture. `snapshot` is that op. Graded
# through the daemon stub, on the served warm.test profile, counting the tape the
# same way: one navigation and one read INSIDE the browser already holding the
# profile, and no launch at all.
DSNAP="$TMP/dpw-snap.json"
jq -n --arg html "$LIVE_DOM" '{nodes:[{ref:"button/Compose", role:"button", name:"Compose", tag:"button"}],
  marker:null, title:"Warm Page", url:"https://warm.test/p", html:$html}' > "$DSNAP"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1
DREC2="$TMP/dpw-snap.jsonl"; : > "$DREC2"
run env PATH="$SPATH" DISPLAY= NODE_PATH="$DSTUB/node_modules" PWREC="$DREC2" DPWDOM="$DPWDOM" \
    DPWSNAP="$DSNAP" "$BROWSER" serve warm.test
t  'T26i (anchor) the profile is held by a warm daemon first' 0 "$RC"
DLAUNCH_BEFORE="$(jq -rs '[.[]|select(.call=="launch")]|length' "$DREC2")"
rm -rf "$TMP/snap-warm"
run env PATH="$SPATH" NODE_PATH="$DSTUB/node_modules" PWREC="$DREC2" DPWDOM="$DPWDOM" DPWSNAP="$DSNAP" \
    "$BROWSER" snapshot warm.test "https://warm.test/p" --out="$TMP/snap-warm"
t  'T26i a snapshot on a warm profile succeeds' 0 "$RC"
t  'T26i ...and opened NO new browser to do it' "$DLAUNCH_BEFORE" \
   "$(jq -rs '[.[]|select(.call=="launch")]|length' "$DREC2")"
t  'T26i ...it read the page atomically, in the browser that was already open' 'true' \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .snapshot==true)|.snapshot]|last' "$DREC2")"
t  'T26i ...and took the picture through that same tab' 'yes' \
   "$(jq -rs '[.[]|select(.call=="screenshot")]|length>0' "$DREC2" | sed 's/true/yes/;s/false/no/')"
t  'T26i the warm capture leaves the same evidence set as the cold one' 'yes' \
   "$([[ -s "$TMP/snap-warm/page.md" && -s "$TMP/snap-warm/tree.json" && -s "$TMP/snap-warm/page.html" && -s "$TMP/snap-warm/page.png" ]] && echo yes || echo no)"
t  'T26i ...with the refs the warm walk found' 'button/Compose' \
   "$(jq -r '.nodes[0].ref' "$TMP/snap-warm/tree.json")"
t  'T26i ...and the daemon is STILL holding the profile afterwards' 'alive' \
   "$(kill -0 "$(dkv "$WDIR/.5dive-serve" daemon_pid)" 2>/dev/null && echo alive || echo gone)"
env PATH="$SPATH" "$BROWSER" serve warm.test --stop >/dev/null 2>&1

# ========== T27 DIVE-4664: a site login is per BOX, and it is BROKERED ========
#
# WHAT THESE GRADE, and the measurement that forced the row: on exact-swallow the
# store held 15 seats and 14 of them were EMPTY, so every agent seat was logged
# out of every site a human had connected and each one that needed a site was
# another human login. The fix is NOT a shared directory — anything that can READ
# a profile can replay the session — it is a BROKER: the store stays 0700 to the
# shelld seat, the session daemon's socket moves to a rendezvous the box's agent
# seats can reach, and a seat with no login of its own acts through it.
#
# Each arm is a mutant of the specific way that goes wrong:
#   the store becomes group-readable   -> T27a: the profile dir is still 0700.
#   the socket stays in the 0700 dir   -> T27a: it is in the rendezvous, 0770.
#   the broker never engages           -> T27b: a second seat reads AUTHENTICATED
#                                        and acts, launching no chrome of its own.
#   per-seat stops being the opt-in    -> T27c: a seat's OWN login wins.
#   "no daemon" reads as "no login"    -> T27e: two conditions, two sentences.
#   the log records only the owner     -> T27f: on_behalf_of is the KERNEL'S
#                                        answer, and a request cannot sign it.
#   _seat believes SUDO_USER           -> T27g: euid is the seat.
#   shot/read stay chrome-only         -> T27i: they render through the daemon.
# THE BOX SEAT CARRIES A NAME THIS UID DOES NOT, and that is load-bearing rather
# than tidiness. With BOXSEAT="$SEAT" the two halves of acceptance 3 — `holder`
# (the seat that OWNS the profile) and `on_behalf_of` (the seat that ASKED, read
# by the kernel) — are the same shell expansion twice, so the pair cannot tell
# "records the caller" from "records only the owner": the one-line mutant that
# drops FIVEDIVE_BROWSER_ON_BEHALF_OF out of `_audit_row` survives the whole
# suite. Naming the owner separately makes the two arms measure two things.
# It costs no root and no second uid: the store is still created by THIS uid and
# stays 0700, so `_audit` passes on it — the same mechanism T27j's control arm
# grades. What a NAME cannot do is skip that audit, which is T27j's subject.
BOXSEAT="agent-box.test"                    # the OWNING seat; not this uid's name
OTHER="agent-brokered.test"                 # a brokered seat, also not this uid
RVROOT="$TMP/browser-sessions"              # the sibling of $TMP/profiles
export FIVEDIVE_BROWSER_BOX_SEAT="$BOXSEAT"

# The rendezvous as `setup` builds it (that path is root's; this is the shape it
# produces, and T27a asserts the product still agrees with it).
mkdir -p "$RVROOT/$BOXSEAT"; chmod 711 "$RVROOT"; chmod 750 "$RVROOT/$BOXSEAT"

DREC3="$TMP/dpw-record-4664.jsonl"; : > "$DREC3"
BOXDOM="$TMP/box.dom"; printf '%s' "$LIVE_DOM" > "$BOXDOM"
# The page-side walk `snapshot` runs (T27k). The stub answers a snapshot
# evaluate from this file, and it is the DAEMON that evaluates — so it has to be
# in the environment `bserve` starts, not the caller's.
BOXSNAP="$TMP/box-snap.json"
jq -n --arg html "$LIVE_DOM" '{nodes:[{ref:"button/Compose", role:"button", name:"Compose", tag:"button"}],
  marker:null, title:"Box Page", url:"https://box.test/feed", html:$html}' > "$BOXSNAP"
bserve() {  # the OWNER serves, out of the OWNER's store
  # The daemon is a child of this serve and inherits its environment, so the
  # re-entered `bin/browser` the broker uses for leases and audit rows resolves
  # `_seat` to the OWNER — which is exactly what `holder` has to be.
  run env PATH="$SPATH" DISPLAY= NODE_PATH="$DSTUB/node_modules" PWREC="$DREC3" DPWDOM="$BOXDOM" \
      DPWSNAP="$BOXSNAP" FIVEDIVE_BROWSER_SEAT="$BOXSEAT" "$@" "$BROWSER" serve box.test
}
bstop() { env PATH="$SPATH" FIVEDIVE_BROWSER_SEAT="$BOXSEAT" "$BROWSER" serve box.test --stop; }
# A SECOND SEAT, with no store of its own. NOT $SPATH: that PATH's chrome is the
# one built to be a SERVE and it answers a --headless probe with an empty
# document, so a seat falling back to a COLD read there would grade the fake
# rather than the product. The ambient PATH's fake answers probes, which is what
# T27c (a seat's own login wins) actually needs.
bother() {
  run env NODE_PATH="$DSTUB/node_modules" PWREC="$DREC3" DPWDOM="$BOXDOM" \
      FIVEDIVE_BROWSER_SEAT="$OTHER" "$@"
}
blaunches() { jq -rs '[.[]|select(.call=="launch")]|length' "$DREC3"; }

mkprofile box.test "$LIVE_DOM" "$BOXSEAT" >/dev/null
BDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$BOXSEAT/box.test"
mkadapter box.test "file://$TMP/artifact.html" 'PUBLISHED'
BSOCK="$RVROOT/$BOXSEAT/box.test.sock"

# --- T27a the socket leaves the 0700 store, and the store does NOT open up -----
bserve
t  'T27a the owner serves' 0 "$RC"
tc 'T27a ...and says the session is brokered for the rest of the box' 'brokered at' "$OUT"
t  'T27a ...the socket is in the rendezvous, not in the profile' 'socket' "$(stat -c '%F' "$BSOCK" 2>/dev/null)"
t  'T27a ...and NOT in the 0700 profile directory' 'no' \
   "$([[ -e "$BDIR/.5dive-session.sock" ]] && echo yes || echo no)"
t  'T27a ...group-reachable (0770), because the group IS the access control there' '770' \
   "$(stat -c '%a' "$BSOCK" 2>/dev/null)"
t  'T27a ...the credential itself is UNCHANGED: the profile is still 0700' '700' \
   "$(stat -c '%a' "$BDIR" 2>/dev/null)"
t  'T27a ...the rendezvous root is traverse-not-list, so no uid outside can find an owner' '711' \
   "$(stat -c '%a' "$RVROOT" 2>/dev/null)"
t  'T27a ...and the box advertises the site in a marker, not by letting anyone stat the store' '640' \
   "$(stat -c '%a' "$RVROOT/$BOXSEAT/box.test.offered" 2>/dev/null)"
t  'T27a ...the daemon reports itself as a broker' 'broker=yes' \
   "$(grep -o 'broker=[a-z]*' "$BDIR/.5dive-session.ready" 2>/dev/null | head -1)"

# --- T27b ACCEPTANCE 1: a second seat, one login, zero second login -----------
BL_BEFORE="$(blaunches)"
bother "$BROWSER" status box.test
t  'T27b a second seat reads the box session' 0 "$RC"
tc 'T27b ...as AUTHENTICATED — not "no profile", not UNKNOWN' 'authenticated' "$OUT"
tc 'T27b ...and says whose login it is using' 'the box login' "$OUT"
t  'T27b ...without launching a browser of its own' "$BL_BEFORE" "$(blaunches)"
t  'T27b ...and it never made a store of its own' 'no' \
   "$([[ -d "$FIVEDIVE_BROWSER_PROFILE_ROOT/$OTHER" ]] && echo yes || echo no)"

bother "$BROWSER" tree box.test https://box.test/compose --json
t  'T27b ...`tree` works through the broker' 0 "$RC"
t  'T27b ...and returns the page it enumerated' 'https://box.test/compose' "$(jq -r '.url' <<<"$OUT" 2>/dev/null)"

bother "$BROWSER" run box.test publish --body=brokered
t  'T27b ...`run` acts in the box browser' 0 "$RC"
tc 'T27b ...and the verdict is still the out-of-band re-read' 'verified: publish is live' "$OUT"
t  'T27b ...STILL not one chrome of its own, for any of the three' "$BL_BEFORE" "$(blaunches)"
t  'T27b ...the browser was never stopped and restarted to serve it' 'alive' \
   "$(kill -0 "$(dkv "$BDIR/.5dive-serve" daemon_pid)" 2>/dev/null && echo alive || echo gone)"

# --- T27c ACCEPTANCE 5: the seat's OWN login wins ----------------------------
#
# Per-seat survives as the private opt-in. The mutant is a resolution that
# reaches for the box store first, which would silently act in somebody else's
# session for a seat that deliberately made its own.
OWNDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$OTHER/box.test"
mkdir -p "$OWNDIR"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$OTHER" "$OWNDIR"
printf '%s' "$LIVE_DOM" > "$OWNDIR/.fake-dom"
BL2="$(blaunches)"
bother "$BROWSER" status box.test
t  'T27c a seat with its own login for the site reads it' 0 "$RC"
tn 'T27c ...and is NOT using the box login' 'the box login' "$OUT"
tc 'T27c ...it reads authenticated out of its own profile' 'authenticated' "$OUT"
t  'T27c ...which means it launched a chrome of its own, not the daemon' "$BL2" "$(blaunches)"
rm -rf "$FIVEDIVE_BROWSER_PROFILE_ROOT/$OTHER"

# --- T27d ACCEPTANCE 2 (control): what the other seat still CANNOT do ---------
# The box SEAT is a distinct name here, but there is only one uid in this suite,
# so these two arms grade the mode and the ownership of the store — not that a
# different human's uid is locked out. That is the arm below, and it needs root.
t  'T27d the profile stays owned by one uid alone' "$(id -u)" "$(stat -c '%u' "$BDIR")"
t  'T27d ...at 0700, so a cookie file in it is unreadable to any other uid' '700' "$(stat -c '%a' "$BDIR")"
t  'T27d ...the per-owner rendezvous grants the group read+traverse and others none' '750' \
   "$(stat -c '%a' "$RVROOT/$BOXSEAT" 2>/dev/null)"
t  'T27d ...and the socket grants others nothing either' '0' \
   "$(( $(stat -c '%a' "$BSOCK" 2>/dev/null || echo 770) % 10 ))"
# THE REAL CONTROL NEEDS A REAL SECOND UID, and that needs root. Where this suite
# has it, run it; where it does not, SAY SO on its own line rather than leaving a
# silent gap — a control that is quietly absent reads exactly like a control that
# passed.
if [[ "$(id -u)" == 0 ]] && id -u nobody >/dev/null 2>&1; then
  t 'T27d (real uid) a uid outside the owner cannot read the profile' 'denied' \
    "$(runuser -u nobody -- cat "$BDIR/.fake-dom" >/dev/null 2>&1 && echo read || echo denied)"
  t 'T27d (real uid) ...and cannot connect to the brokered socket either' 'denied' \
    "$(runuser -u nobody -- "$DAEMONBIN" call "$BSOCK" <<<'{"op":"ping"}' >/dev/null 2>&1 && echo connected || echo denied)"
else
  printf 'NOTE: T27d real-uid control not run (needs root + a second unprivileged user); the mode/owner arms above are what ran.\n'
fi

# --- T27e SCOPE (b): "no daemon" and "no login" are different sentences -------
bstop >/dev/null 2>&1
bother "$BROWSER" status box.test
t  'T27e a brokered site with nothing serving it refuses' 69 "$RC"
tc 'T27e ...naming the seat whose login it is' "'$BOXSEAT' seat" "$ERR"
tc 'T27e ...saying WHY this seat cannot just open it' 'mode 0700' "$ERR"
tc 'T27e ...and what to do about it' "serve box.test" "$ERR"
tn 'T27e ...and it does NOT send anybody to log in again' 'browser auth box.test' "$ERR"
# THE OTHER SILENCE, through a verb that ACTS. `status` on a site nobody has is
# an empty enumeration, not a refusal; `tree` is the shape that has to choose
# between the two sentences.
bother "$BROWSER" tree never-connected.test https://never-connected.test/x
tc 'T27e a site the box has NO login for gets the other sentence' 'no profile for never-connected.test' "$ERR"
tc 'T27e ...which is the one that DOES send you to log in' 'browser auth never-connected.test' "$ERR"

# --- T27f ACCEPTANCE 3: the row names who asked, and the caller cannot sign it -
bserve >/dev/null 2>&1
bother "$BROWSER" run box.test publish --body=attributed
t  'T27f a brokered run succeeds' 0 "$RC"
MYSEAT="$(id -un)"
t  'T27f ...and the audit row names the CALLING uid, resolved by the kernel' "$MYSEAT" \
   "$(jq -rs 'map(select(.event=="plan"))|last|.on_behalf_of' "$BDIR/.5dive-audit.jsonl" 2>/dev/null)"
t  'T27f ...alongside the seat that owns the profile' "$BOXSEAT" \
   "$(jq -rs 'map(select(.event=="plan"))|last|.holder' "$BDIR/.5dive-audit.jsonl" 2>/dev/null)"
t  'T27f ...and the lease it took carried the same pair' "$BOXSEAT $MYSEAT" \
   "$(jq -rs 'map(select(.event=="lease-acquire"))|last|"\(.holder) \(.on_behalf_of)"' "$BDIR/.5dive-audit.jsonl" 2>/dev/null)"
# THE TWO NAMES ARE DIFFERENT STRINGS, and the arms above are worth nothing if
# they stop being — a fixture that lets the owner and the caller share one name
# passes identically whether the product records the caller or only the owner.
# So grade the fixture here, next to the arms that depend on it.
tn 'T27f (fixture) the owner and the caller are not the same name, or the pair above measures nothing' \
   "$MYSEAT" "$BOXSEAT"
# THE FORGERY ARM. The value is now measured; this is the other half of the
# property — that a REQUEST cannot CHOOSE the name. `on_behalf_of` is the
# kernel's answer about the connected peer, so a daemon that trusted the field
# instead would write `somebody-else` here.
env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" \
  <<<'{"op":"lease","act":"acquire","purpose":"forged","on_behalf_of":"somebody-else","holder":"somebody-else"}' \
  >"$TMP/forge.tok" 2>/dev/null
t  'T27f a request that signs somebody else name does not get to' "$MYSEAT" \
   "$(jq -rs 'map(select(.event=="lease-acquire"))|last|.on_behalf_of' "$BDIR/.5dive-audit.jsonl" 2>/dev/null)"
tn 'T27f ...the name it asked for appears nowhere in the record' 'somebody-else' \
   "$(cat "$BDIR/.5dive-audit.jsonl" "$BDIR/.5dive-lease/meta" 2>/dev/null)"
t  'T27f ...and the lease meta carries the calling seat too' "$MYSEAT" \
   "$(sed -n 's/^on_behalf_of=//p' "$BDIR/.5dive-lease/meta" 2>/dev/null | head -1)"
t  'T27f ...beside the owner, which is the name "who has the browser?" used to answer with alone' "$BOXSEAT" \
   "$(sed -n 's/^holder=//p' "$BDIR/.5dive-lease/meta" 2>/dev/null | head -1)"
rm -rf "$BDIR/.5dive-lease"

# --- T27g SCOPE (e): the seat is the EFFECTIVE uid, not SUDO_USER ------------
#
# `sudo -u <seat> 5dive browser …` sets euid to <seat> and SUDO_USER to the
# CALLER. The old `${SUDO_USER:-…}` answered with the caller and then looked for
# the caller's store while running as somebody else — the trap that forced an
# `env SUDO_USER=` spoof into DIVE-4662's hand test.
# A site ONLY this uid's own store holds. Not box.test: that belongs to the box
# seat now, and `ls` advertises the box's offers to every seat — so finding it
# would prove the offers section works, not that `_seat` ignored SUDO_USER.
mkprofile t27g-own.test "$LIVE_DOM" >/dev/null
run env PATH="$SPATH" SUDO_USER=a-caller-who-is-not-this-uid "$BROWSER" ls
t  'T27g a non-root caller with SUDO_USER set is still ITSELF' 0 "$RC"
tc 'T27g ...and reads its own store, not the store of the name in SUDO_USER' 't27g-own.test' "$OUT"
rm -rf "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/t27g-own.test"

# --- T27h ACCEPTANCE 4: the memory number ships with its rig -----------------
t  'T27h the per-site memory rig is in the tree' 'yes' \
   "$([[ -x "$ROOT/tests/browser_box_login_bench.sh" ]] && echo yes || echo no)"
tc 'T27h ...and it measures a per-SITE delta, not a per-seat one' 'per-site' \
   "$(head -45 "$ROOT/tests/browser_box_login_bench.sh" 2>/dev/null)"
run bash "$ROOT/tests/browser_box_login_bench.sh" --self-test
t  'T27h ...its plumbing is exercised without a real browser' 0 "$RC"
tc 'T27h ...and it refuses rather than inventing a number' 'refuses' "$OUT"

# --- T27i SCOPE (d): shot and read render THROUGH the daemon ----------------
BL3="$(blaunches)"
bother "$BROWSER" shot box.test https://box.test/feed --out="$TMP/brokered.png" --dom="$TMP/brokered.html"
t  'T27i a brokered shot renders' 0 "$RC"
t  'T27i ...and the PNG came back as BYTES this seat wrote itself' 'stub-png' \
   "$(cat "$TMP/brokered.png" 2>/dev/null)"
t  'T27i ...the daemon was never asked to write a caller-chosen path' 'null' \
   "$(jq -rs '[.[]|select(.call=="screenshot")]|last|.path' "$DREC3" 2>/dev/null)"
t  'T27i ...the DOM is the SAME page instant, not a second load' 'yes' \
   "$([[ -s "$TMP/brokered.html" ]] && echo yes || echo no)"
t  'T27i ...and no chrome was launched for it' "$BL3" "$(blaunches)"
bother "$BROWSER" read box.test https://box.test/feed --out="$TMP/brokeread"
t  'T27i a brokered read captures the page' 0 "$RC"
t  'T27i ...with the whole evidence triple' 'yes' \
   "$([[ -s "$TMP/brokeread/page.html" && -s "$TMP/brokeread/page.md" && -s "$TMP/brokeread/page.meta.json" ]] && echo yes || echo no)"
t  'T27i ...and the metadata says what actually rendered it' 'session-daemon' \
   "$(jq -r '.capture' "$TMP/brokeread/page.meta.json" 2>/dev/null)"
t  'T27i ...still not one chrome of its own' "$BL3" "$(blaunches)"

# --- T27k DIVE-4794: a brokered `snapshot` cannot hand the owner a path -------
#
# THE DEFECT, measured on a box 2026-09-21. `snapshot` staged its artifacts in a
# mktemp directory 0700 to the CALLER and named that path in the request. The
# daemon runs as the profile's OWNER, so it could not write there, and every
# brokered snapshot died on `EACCES: permission denied, open
# '/tmp/5dive-browser-read.XXXX/page.html'` — the verb the skill tells an agent
# to reach for first, dark for every seat that does not own the login, while
# `status` and `tree` (whose data comes back over the socket) worked.
#
# WHY THE ARM GRADES THE REQUEST AND NOT THE ERROR. Both seats here are the same
# uid — the suite has no second one — so the owner CAN write the caller's
# staging directory and the EACCES cannot be reproduced by permissions. What can
# be graded is the thing that caused it: whether a caller-chosen absolute path
# is in the request at all. The recorder below is a `session-daemon` wrapper that
# tees each request to a file before exec'ing the real one, so the arm reads the
# exact bytes the daemon received.
REQREC="$TMP/brokered-requests.jsonl"; : > "$REQREC"
cat > "$TMP/daemon-recorder" <<REC
#!/usr/bin/env bash
if [[ "\$1" == call ]]; then
  tmp=\$(mktemp); cat > "\$tmp"; cat "\$tmp" >> "$REQREC"
  exec "$DAEMONBIN" "\$@" < "\$tmp"
fi
exec "$DAEMONBIN" "\$@"
REC
chmod +x "$TMP/daemon-recorder"
bother env FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/daemon-recorder" \
    "$BROWSER" snapshot box.test https://box.test/feed --out="$TMP/brokesnap"
t  'T27k a brokered snapshot captures the page' 0 "$RC"
t  'T27k ...and the document is on disk, written by the seat that owns the directory' 'yes' \
   "$([[ -s "$TMP/brokesnap/page.html" ]] && echo yes || echo no)"
t  'T27k ...and it is the DOCUMENT, not an empty file the caller made' 'yes' \
   "$(grep -q 'id="feed"' "$TMP/brokesnap/page.html" 2>/dev/null && echo yes || echo no)"
t  'T27k ...with the refs beside it, from the same look' 'button/Compose' \
   "$(jq -r '.nodes[0].ref' "$TMP/brokesnap/tree.json" 2>/dev/null)"
t  'T27k ...the daemon was asked for BYTES' 'true' \
   "$(jq -rs '[.[]|select(.op=="snapshot")]|last|.inline' "$REQREC" 2>/dev/null)"
t  'T27k ...and was never handed a path in the caller-owned staging directory' 'null' \
   "$(jq -rs '[.[]|select(.op=="snapshot")]|last|.html' "$REQREC" 2>/dev/null)"
t  'T27k ...the screenshot is not a caller-chosen path either' 'no-path' \
   "$(jq -rs '[.[]|select(.op=="snapshot")]|last|.shot|if type=="string" then . else "no-path" end' "$REQREC" 2>/dev/null)"
t  'T27k (control) the OWNER still gets the cheap path-writing shape' 'false' \
   "$(env PATH="$SPATH" NODE_PATH="$DSTUB/node_modules" PWREC="$DREC3" DPWDOM="$BOXDOM" DPWSNAP="$BOXSNAP" \
        FIVEDIVE_BROWSER_SEAT="$BOXSEAT" FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/daemon-recorder" \
        "$BROWSER" snapshot box.test https://box.test/feed --out="$TMP/ownersnap" >/dev/null 2>&1; \
      jq -rs '[.[]|select(.op=="snapshot")]|last|.inline' "$REQREC" 2>/dev/null)"
bstop >/dev/null 2>&1

# --- T27m DIVE-4927: a brokered lease is HELD, and a leased caller is not refused
#
# THE DEFECT, measured on exact-swallow 2026-09-24: a second seat's brokered
# `read` and `run` against the box's github.com login were refused with "whoever
# sent this did not hold [the lease]", while `lease --status` read FREE. Two
# faults, one arm each, and a control for each:
#   the lease was anchored to the `_broker-lease` child the daemon spawns, which
#   exits at once — so it was dead on arrival, and `kill -0` from the owner on a
#   caller's pid is EPERM anyway, which read as dead too;
#   the daemon refused ANY request that arrived while another ran, including a
#   leased caller's request landing inside an unleased `status` probe.
bserve >/dev/null 2>&1
sleep 60 & ANCHOR_PID=$!
TOK="$(env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" \
  <<<"{\"op\":\"lease\",\"act\":\"acquire\",\"purpose\":\"t27m\",\"anchor\":$ANCHOR_PID}" 2>/dev/null)"
t  'T27m a brokered caller takes the lease' 'yes' "$([[ -n "$TOK" ]] && echo yes || echo no)"
run env PATH="$SPATH" FIVEDIVE_BROWSER_SEAT="$BOXSEAT" "$BROWSER" lease box.test --status
tc 'T27m ...and the OWNER sees it held, while the caller lives' 'busy: held by' "$OUT"
tc 'T27m ...naming the seat that asked' "on behalf of $(id -un)" "$OUT"
t  'T27m ...anchored to the caller process, not the broker child that wrote it' "$ANCHOR_PID" \
   "$(grep '^holder_pid=' "$BDIR/.5dive-lease/meta" 2>/dev/null | cut -d= -f2)"
kill "$ANCHOR_PID" 2>/dev/null; wait "$ANCHOR_PID" 2>/dev/null
run env PATH="$SPATH" FIVEDIVE_BROWSER_SEAT="$BOXSEAT" "$BROWSER" lease box.test --status
tc 'T27m (control) ...and free again once the caller is gone, with nobody releasing it' 'free' "$OUT"
rm -rf "$BDIR/.5dive-lease"
# The anchor is the KERNEL's to vouch for: a pid of another uid is refused.
if [[ "$(id -u)" != 0 ]]; then
  run env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" <<<'{"op":"lease","act":"acquire","purpose":"t27m","anchor":1}'
  t  'T27m an anchor that is not the calling seat process is refused' 77 "$RC"
  tc 'T27m ...saying why' 'not a process of the calling seat' "$ERR"
  t  'T27m ...and no lease was written' 'no' "$([[ -e "$BDIR/.5dive-lease/meta" ]] && echo yes || echo no)"
else
  printf 'NOTE: T27m foreign-anchor arm not run (as root every pid is this uid'"'"'s to vouch for).\n'
fi
# THE SEAT'S OWN VERB CARRIES ITS OWN PID. Recorded through the T27k wrapper.
: > "$REQREC"
bother env FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/daemon-recorder" "$BROWSER" run box.test publish --body=anchored
t  'T27m a brokered run still succeeds' 0 "$RC"
t  'T27m ...and its acquire named an anchor pid' 'yes' \
   "$(jq -rs '[.[]|select(.op=="lease" and .act=="acquire")]|last|.anchor|type=="number"' "$REQREC" 2>/dev/null | sed 's/true/yes/;s/false/no/')"
bstop >/dev/null 2>&1

# A LEASED caller's request landing inside an UNLEASED probe waits its turn.
bserve DPWGOTO_MS=1500 >/dev/null 2>&1
env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" <<<'{"op":"probe","url":"https://box.test/"}' >/dev/null 2>&1 &
PROBE_PID=$!
sleep 0.4
bother "$BROWSER" run box.test publish --body=queued
t  'T27m a brokered run that lands inside a status probe is not refused' 0 "$RC"
tc 'T27m ...it ran once the probe finished' 'verified: publish is live' "$OUT"
tn 'T27m ...and was not told it skipped a lease it held' 'did not hold' "$ERR"
wait "$PROBE_PID" 2>/dev/null
bstop >/dev/null 2>&1
# CONTROL: the wait is BOUNDED, and a refusal past it names what is in flight.
bserve DPWGOTO_MS=1500 FIVEDIVE_BROWSER_BUSY_WAIT_MS=200 >/dev/null 2>&1
env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" <<<'{"op":"probe","url":"https://box.test/"}' >/dev/null 2>&1 &
PROBE_PID=$!
sleep 0.4
run env PATH="$SPATH" "$DAEMONBIN" call "$BSOCK" <<<'{"op":"probe","url":"https://box.test/"}'
t  'T27m (control) past the bound the second request is refused' 70 "$RC"
tc 'T27m (control) ...naming the op in flight' "still busy with a 'probe' request" "$ERR"
wait "$PROBE_PID" 2>/dev/null
bstop >/dev/null 2>&1

# --- T27j the seat override grants NOTHING, which is why it can exist ---------
#
# WHY THIS ARM IS HERE AND NOT A COMMENT. DIVE-4662's hand-test rig spoofed the
# seat with `env SUDO_USER=` under a sudo grant, and the row said in as many
# words: do not ship that. FIVEDIVE_BROWSER_SEAT is a different thing wearing a
# similar shape, and "different" has to be demonstrated rather than asserted:
#   - it chooses which STORE this process looks in, and nothing else;
#   - every directory is still opened by this uid, so `_audit` refuses anything
#     this uid does not own or that is not 0700 — the override does not skip it;
#   - the only shape it can reach is the BROKERED one, which is access a member
#     of the rendezvous group already has;
#   - and it cannot touch attribution: `on_behalf_of` is SO_PEERCRED, read by
#     the daemon from the connection, which no environment of the caller's
#     reaches.
# The rig it replaced chose who you ACTED AS while holding somebody else's
# privilege. This one cannot, and that is the whole difference.
SQUAT="$FIVEDIVE_BROWSER_PROFILE_ROOT/agent-squatter.test"
mkdir -p "$SQUAT/box.test"; chmod 700 "$SQUAT"; chmod 755 "$SQUAT/box.test"
run env FIVEDIVE_BROWSER_SEAT=agent-squatter.test "$BROWSER" status box.test
t  'T27j claiming a seat does not skip the store audit' 77 "$RC"
tc 'T27j ...it is refused on the mode, exactly as an unclaimed store would be' 'refusing' "$ERR"
tn 'T27j ...and nothing was read out of that profile' 'authenticated' "$OUT"
t  'T27j (control) the same store at 0700 is usable, so the arm above graded the AUDIT' 'authenticated' \
   "$(chmod 700 "$SQUAT/box.test"; printf '%s' "$LIVE_DOM" > "$SQUAT/box.test/.fake-dom"; \
      env FIVEDIVE_BROWSER_SEAT=agent-squatter.test "$BROWSER" status box.test 2>/dev/null \
      | grep -o authenticated | head -1)"
rm -rf "$SQUAT"

# ================================================== T28 a ref that is not there YET
#
# THE DEFECT (DIVE-4674). Both step loops resolved every selector through a
# ONE-SHOT `aria.resolveSelector` before the switch. A CSS `wait_for` then polled
# for the whole step timeout inside page.waitForSelector; a ref `wait_for` — the
# same instruction, written the way this plugin tells agents to write it — probed
# for 0 ms and threw. And `run` had no settle after `goto` at all, while `tree`
# and `snapshot` both waited 1200 ms, so `run` looked at a page roughly fifty
# milliseconds after domcontentloaded and truthfully reported that the element
# `tree` had just listed was not there.
#
# WHY THE SUITE COULD NOT SEE IT. Every fixture above answers the walk the same
# way every time, so "resolved once" and "resolved on the fourth look" leave a
# byte-identical tape. PWWALK_MISS (both stubs) is the missing shape: a page that
# answers "no" N times and then "yes".
#
# THE LOOP EXISTS TWICE — bin/driver-playwright (cold) and bin/session-daemon
# (warm) — so T28f grades the second one through a REAL daemon rather than
# trusting that the same patch was applied to both.

_mkwaitpkg() {  # _mkwaitpkg <dir> — a plugin tree with its own lib, mutable per arm
  mkdir -p "$1/bin"
  cp "$ROOT/plugins/browser/bin/driver-playwright" "$1/bin/driver-playwright"
  cp -r "$ROOT/plugins/browser/lib" "$1/lib"
}
# An adapter whose SECOND step is a ref wait_for, then a plain click. The ref is
# the shape agents are told to use and the shape the old code could not wait for.
mkrefadapter() {  # mkrefadapter <site> <verify-url> <expect>
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$1.json" <<JSON
{ "site": "$1",
  "probe": { "url": "https://$1.test/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"https://$1.test/compose"},
                 {"op":"wait_for","selector":"ref=textbox/Add a comment"},
                 {"op":"click","selector":"#pub"} ],
      "verify": { "url": "$2", "expect": "$3" } } } }
JSON
}
WAITREC="$TMP/t27-record.jsonl"
# THE DRIVER IS GRADED DIRECTLY wherever an exit code is the claim. `run` through
# bin/browser re-reads the verify URL OUT OF BAND when a step fails, and every
# fixture in this file verifies against the one $TMP/artifact.html an early arm
# wrote 'PUBLISHED' into — so an rc of 0 from the front door is equally true of a
# tree where the step never ran. The step loop's own rc is not.
DRVPLAN() { jq -nc --arg p "$1" --argjson st "$2" '{profile:$p, steps:$st, args:{}}'; }
LATEDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/late.test"
mkprofile late.test "$LIVE_DOM" >/dev/null
mkrefadapter late.test "file://$TMP/artifact.html" 'PUBLISHED'
unset FIVEDIVE_BROWSER_DRIVER

# --- T28a a ref wait_for WAITS, and succeeds once the element arrives ---------
: > "$WAITREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=3 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 \
    "$BROWSER" run late.test publish
t  'T28a the whole command path completes (NOT the grade: see the re-read note above)' 0 "$RC"
WALKS="$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")"
t  'T28a ...because the ref layer looked more than once' 'yes' \
   "$([[ "${WALKS:-0}" -ge 4 ]] && echo yes || echo no)"
t  'T28a ...and every look asked for the SAME ref' 'textbox/Add a comment' \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)|.mark]|unique|join(",")' "$WAITREC")"
t  'T28a ...then handed the resolved marker to waitForSelector, as before' \
   '[data-5dive-ref="late-1"]' \
   "$(jq -rs '[.[]|select(.call=="waitForSelector")|.sel]|last' "$WAITREC")"
t  'T28a ...and the step AFTER it ran, so the action completed' 'click' \
   "$(jq -rs '[.[]|select(.call=="click")|.call]|last' "$WAITREC")"
# The same plan at the DRIVER, where no re-read can paper over a failed step.
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=3 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$DRV" <<<"$(DRVPLAN "$LATEDIR" '[{"op":"wait_for","selector":"ref=textbox/Add a comment"},{"op":"click","selector":"#pub"}]')" \
    >/dev/null 2>&1; RC28A=$?
t  'T28a THE GRADE: the driver itself exits 0 on a late ref' 0 "$RC28A"
t  'T28a ...and the click really ran, on the tape, not on a re-read' 1 \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$WAITREC")"

# --- T28b beyond the timeout it is still a refusal, with the SAME message -----
# The exit codes are the contract bin/browser keys on, so they are graded at the
# driver, where they are decided, rather than through the out-of-band re-read.
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=99999 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=400 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$DRV" <<<"$(DRVPLAN "$LATEDIR" '[{"op":"wait_for","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>"$TMP/t27b.err"; RC27B=$?
t  'T28b a ref wait_for that never arrives, as step ONE, still exits 70' 70 "$RC27B"
tc 'T28b ...with the refMiss message unchanged, not a "timed out"' \
   'matches nothing on this page' "$(cat "$TMP/t27b.err")"
tc 'T28b ...and still naming what IS on the page, which is the hint an operator reads' \
   'Refs of that role on this page' "$(cat "$TMP/t27b.err")"
t  'T28b ...having polled rather than probed once' 'yes' \
   "$([[ "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")" -ge 2 ]] && echo yes || echo no)"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=99999 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=400 FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$DRV" <<<"$(DRVPLAN "$LATEDIR" '[{"op":"goto","url":"https://late.test/c"},{"op":"wait_for","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>"$TMP/t27b2.err"; RC27B2=$?
t  'T28b ...and exits 1, not 70, once a step has already run' 1 "$RC27B2"

# --- T28c MUTANT: put the one-shot resolve back, and T28a must go red ---------
# Non-vacuous in BOTH directions: the unmutated copy of the same package is run
# first, so a red below is the mutation and not the fixture.
MUTPKG="$TMP/t27-mutant"; _mkwaitpkg "$MUTPKG"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=3 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$MUTPKG/bin/driver-playwright" \
    <<<"$(DRVPLAN "$LATEDIR" '[{"op":"wait_for","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>&1; RC27C0=$?
t  'T28c (anchor) the UNMUTATED copy of the package resolves the late ref' 0 "$RC27C0"
# The mutation: wait_for stops being the op that waits — exactly the pre-fix tree.
perl -0pi -e "s/if \(step\.op === 'wait_for'\) return resolveRefWithin\(page, sel, \{ timeoutMs, pollMs \}\);/\/* MUTANT (DIVE-4674): the one-shot resolve, restored *\//" \
  "$MUTPKG/lib/aria.cjs"
t  'T28c (anchor) the mutation really landed in the copy' 'yes' \
   "$(grep -q 'MUTANT (DIVE-4674)' "$MUTPKG/lib/aria.cjs" && echo yes || echo no)"
t  'T28c (anchor) ...and the shipped lib is untouched' 'yes' \
   "$(grep -q 'MUTANT (DIVE-4674)' "$ROOT/plugins/browser/lib/aria.cjs" && echo no || echo yes)"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=3 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$MUTPKG/bin/driver-playwright" \
    <<<"$(DRVPLAN "$LATEDIR" '[{"op":"wait_for","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>"$TMP/t27c.err"; RC27C=$?
t  'T28c MUTANT: with the one-shot resolve back, the late ref is a refusal' 70 "$RC27C"
t  'T28c ...and it looked exactly ONCE, which is the whole defect' 1 \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")"

# --- T28d `run` settles after goto, the way tree and snapshot always did ------
: > "$WAITREC"
mkadapter settle.test "file://$TMP/artifact.html" 'PUBLISHED'
mkprofile settle.test "$LIVE_DOM" >/dev/null
run env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" \
    "$BROWSER" run settle.test publish --page-settle=777 --body=hi
t  'T28d a run with --page-settle succeeds' 0 "$RC"
t  'T28d ...and the goto is followed by a settle of exactly that many ms' '777' \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout")|.ms]|last' "$WAITREC")"
: > "$WAITREC"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" \
    "$BROWSER" run settle.test publish --page-settle=0 --body=hi
t  'T28d ...and --page-settle=0 waits NOT AT ALL, rather than waiting zero' 0 \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout")]|length' "$WAITREC")"
run env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" \
    "$BROWSER" run settle.test publish --page-settle=abc --body=hi
t  'T28d a --page-settle that is not milliseconds is refused here, not three processes away' 64 "$RC"
tc 'T28d ...naming what it wanted' 'takes milliseconds' "$ERR"
# The flag carries a DASH so it can never be mistaken for an adapter argument:
# a placeholder name is [a-zA-Z0-9_]+, and {body} above proves adapter args still
# arrive intact alongside it.
t  'T28d ...and an adapter argument on the same line still reached the page' 'hi' \
   "$(jq -rs '[.[]|select(.call=="fill")|.val]|last' "$WAITREC")"

# --- T28e/f the WARM half: the settle rides in the REQUEST, and the loop polls -
#
# BOTH HALVES ARE GRADED THROUGH A REAL session-daemon, not through the source.
# The daemon is a second copy of the step loop in a long-lived process that was
# started before this command line existed — which is why an environment variable
# set by bin/browser reaches the cold driver and nothing else, and why
# `snapshot --settle` worked cold and was silently dropped on a served profile.
# A text arm would pass on a tree where the knob is parsed and then thrown away.
mkprofile latewarm.test "$LIVE_DOM" >/dev/null
mkrefadapter latewarm.test "file://$TMP/artifact.html" 'PUBLISHED'
: > "$DREC"
# PROBE_SETTLE is pinned to a value nothing else here uses. `run` on a warm
# profile asks the daemon for a liveness probe FIRST, and probeRequest has a
# settle of its own (800 ms by default) — so an arm that just read the tape's
# waits would grade the probe and call it the run's settle. Measured: it did.
dserve latewarm.test PWWALK_MISS=3 FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_PROBE_SETTLE_MS=11
t  'T28f (precondition) the warm session is up' 0 "$RC"
LAUNCH_BEFORE="$(launches)"
dwarm "$BROWSER" run latewarm.test publish
t  'T28f a ref wait_for inside the WARM loop waits too' 0 "$RC"
t  'T28f ...the daemon looked more than once' 'yes' \
   "$([[ "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$DREC")" -ge 4 ]] && echo yes || echo no)"
t  'T28f ...and it resolved to the marker, then waited on it' '[data-5dive-ref="late-1"]' \
   "$(jq -rs '[.[]|select(.call=="waitForSelector")|.sel]|last' "$DREC")"
t  'T28f ...without launching a browser to do any of it' "$LAUNCH_BEFORE" "$(launches)"

# The knob has to REACH that process. Each arm asks for a settle no default could
# produce and reads back what the warm page was actually told to wait.
: > "$DREC"
dwarm "$BROWSER" tree latewarm.test "https://latewarm.test/x" --settle=4321 >/dev/null 2>&1
t  'T28e tree --settle reaches the WARM session' '4321' \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout" and .ms!=11)|.ms]|last' "$DREC")"
: > "$DREC"
dwarm "$BROWSER" snapshot latewarm.test "https://latewarm.test/x" --out="$TMP/t27-snap" --settle=4322 >/dev/null 2>&1
t  'T28e snapshot --settle reaches it too — it was parsed and dropped before' '4322' \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout" and .ms!=11)|.ms]|last' "$DREC")"
: > "$DREC"
dwarm "$BROWSER" run latewarm.test publish --page-settle=4323 >/dev/null 2>&1
t  'T28e run --page-settle reaches it, and settles after the goto' '4323' \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout" and .ms!=11)|.ms]|last' "$DREC")"
: > "$DREC"
dwarm "$BROWSER" run latewarm.test publish --page-settle=0 >/dev/null 2>&1
t  'T28e ...and a warm run with --page-settle=0 waits not at all' 0 \
   "$(jq -rs '[.[]|select(.call=="waitForTimeout" and .ms!=11)]|length' "$DREC")"
t  'T28e (anchor) ...and the 11ms the filter drops really is the liveness probe' 'yes' \
   "$([[ "$(jq -rs '[.[]|select(.call=="waitForTimeout" and .ms==11)]|length' "$DREC")" -ge 1 ]] && echo yes || echo no)"
env PATH="$SPATH" "$BROWSER" serve latewarm.test --stop >/dev/null 2>&1

# --- T28g ONLY wait_for waits — the asymmetry is graded, not just asserted ----
#
# The row allowed either choice for fill/click/press/select/upload and asked for
# the one taken to be STATED AND GRADED. A sentence in lib/aria.cjs is not a
# grade: an edit that hands every op the poll — a `click` hovering for the whole
# step timeout inside somebody's live account, the exact harm this change argues
# against — reds nothing unless an arm counts the looks. Measured: with the
# asymmetry deleted from the shipped lib, the whole suite still passed except
# T28c's mutation-plumbing anchors, which are about the perl edit and not about
# behaviour at all.
#
# PWWALK_MISS=1 is the smallest page that can tell the two apart: a one-shot
# resolve looks ONCE and refuses, a polling one looks twice and proceeds. The
# step timeout is left long on purpose, so a poll would have every chance.
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=1 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$DRV" <<<"$(DRVPLAN "$LATEDIR" '[{"op":"click","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>"$TMP/t28g.err"; RC28G=$?
t  'T28g a ref click does not wait: it refuses on the page it was given' 70 "$RC28G"
t  'T28g ...having looked EXACTLY ONCE, which is what the one-shot resolve means' 1 \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")"
tc 'T28g ...with the same refMiss text, not a timeout' 'matches nothing on this page' \
   "$(cat "$TMP/t28g.err")"
t  'T28g ...and nothing was clicked on the way out' 0 \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$WAITREC")"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=1 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$DRV" <<<"$(DRVPLAN "$LATEDIR" '[{"op":"fill","selector":"ref=textbox/Add a comment","value":"hi"}]')" \
    >/dev/null 2>&1; RC28G2=$?
t  'T28g a ref fill does not wait either' 70 "$RC28G2"
t  'T28g ...one look, and nothing typed into a page that was not the one described' 1 \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")"
t  'T28g ...and no fill reached the page' 0 \
   "$(jq -rs '[.[]|select(.call=="fill")]|length' "$WAITREC")"

# MUTANT, in its own copy of the package: delete the asymmetry so every op polls.
# This is the regression the arms above exist to catch, and it must flip them —
# on BEHAVIOUR (the click now succeeds after a second look), not on plumbing.
SYMPKG="$TMP/t28-sym-mutant"; _mkwaitpkg "$SYMPKG"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=1 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$SYMPKG/bin/driver-playwright" \
    <<<"$(DRVPLAN "$LATEDIR" '[{"op":"click","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>&1; RC28H0=$?
t  'T28h (anchor) the UNMUTATED copy refuses the ref click, exactly as shipped' 70 "$RC28H0"
perl -0pi -e "s/  if \(step\.op === 'wait_for'\) return resolveRefWithin\(page, sel, \{ timeoutMs, pollMs \}\);\n  return resolveRef\(page, sel\);/  \/* MUTANT-SYM (DIVE-4674): every op polls, the asymmetry deleted *\/\n  return resolveRefWithin(page, sel, { timeoutMs, pollMs });/" \
  "$SYMPKG/lib/aria.cjs"
t  'T28h (anchor) the mutation really landed in the copy' 'yes' \
   "$(grep -q 'MUTANT-SYM (DIVE-4674)' "$SYMPKG/lib/aria.cjs" && echo yes || echo no)"
t  'T28h (anchor) ...and the shipped lib still only gives the poll to wait_for' 'yes' \
   "$(grep -q "if (step.op === 'wait_for') return resolveRefWithin" "$ROOT/plugins/browser/lib/aria.cjs" && echo yes || echo no)"
: > "$WAITREC"
env NODE_PATH="$PWROOT/node_modules" PWREC="$WAITREC" PWWALK_MISS=1 \
    FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_CHROME=/bin/true \
    "$SYMPKG/bin/driver-playwright" \
    <<<"$(DRVPLAN "$LATEDIR" '[{"op":"click","selector":"ref=textbox/Add a comment"}]')" \
    >/dev/null 2>&1; RC28H=$?
t  'T28h MUTANT: with every op polling, the ref click stops refusing' 0 "$RC28H"
t  'T28h ...because it looked a SECOND time — the count is the whole difference' 2 \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$WAITREC")"
t  'T28h ...and the click it should never have reached went through' 1 \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$WAITREC")"

# --- T28i the WARM loop holds the same asymmetry ------------------------------
# The daemon is the second copy of the step loop, so the choice has to be graded
# there too or half the product is ungraded. Its walk counter lives in a process
# that outlives the command, so this is the FIRST ref walk of a FRESH session.
mkprofile clickwarm.test "$LIVE_DOM" >/dev/null
cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/clickwarm.test.json" <<'JSON'
{ "site": "clickwarm.test",
  "probe": { "url": "https://clickwarm.test/feed", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"https://clickwarm.test/compose"},
                 {"op":"click","selector":"ref=textbox/Add a comment"} ],
      "verify": { "url": "https://clickwarm.test/feed", "expect": "posts" } } } }
JSON
dserve clickwarm.test PWWALK_MISS=1 FIVEDIVE_BROWSER_STEP_TIMEOUT=8000 FIVEDIVE_BROWSER_PROBE_SETTLE_MS=11
t  'T28i (precondition) the warm session is up' 0 "$RC"
: > "$DREC"
dwarm "$BROWSER" run clickwarm.test publish >/dev/null 2>&1
t  'T28i the WARM loop does not wait for a ref click either: exactly one look' 1 \
   "$(jq -rs '[.[]|select(.call=="evaluate" and .mark!=null)]|length' "$DREC")"
t  'T28i ...and no click reached the warm page' 0 \
   "$(jq -rs '[.[]|select(.call=="click")]|length' "$DREC")"
env PATH="$SPATH" "$BROWSER" serve clickwarm.test --stop >/dev/null 2>&1


# ============ T29 DIVE-4794: a probe that reads the shell cannot classify an SPA
#
# THE DEFECT, measured on a box 2026-09-21. Telegram Web ships ONE static shell
# for both login states — `has-auth-pages` on <body> in the bytes the server
# sends — and removes it in JavaScript once its own network init decides it is
# logged in. The probe dumped the DOM at domcontentloaded plus a fixed settle,
# which is before that decision, so a LIVE session and a DEAD one were identical
# in every field a marker could read. An adapter written against the shell then
# stamped `expired` on a live login and every acting verb refused; the fail-open
# alternative (mark on the sign-in CONTENT) read `authenticated` on a cold
# expired profile. No regex separates two identical documents — the missing
# thing was the WAIT, and something POSITIVE to wait for.
#
# The mutants these arms exist to kill:
#   drop the retry loop        -> T29a: the page that decides late reads UNKNOWN.
#   wait, but keep inferring   -> T29c: a page that never speaks reads
#                                 `authenticated` by elimination, which is the
#                                 fail-open shape flagged on the row.
#   wait on EVERY adapter      -> T29f: the server-rendered control pays a second
#                                 load it does not need.
#   test logged-in first       -> T29d/T29e: a dead session, and a challenge,
#                                 both classified as a live login.
SHELL_DOM='<html><body class="animation-level-2 has-auth-pages rounded-sections"><div id="auth-pages"></div></body></html>'
CHATLIST_DOM='<html><body class="animation-level-2"><div class="chatlist custom-scroll"><div class="chatlist-chat">a chat</div></div></body></html>'
SIGNIN_DOM='<html><body class="has-auth-pages"><div id="auth-pages"><div class="page-signQR">Log in to Telegram by QR Code</div></div></body></html>'
spa_adapter() {  # spa_adapter <site> [--no-positive]
  local pos='"logged_in_when_dom_matches": "class=\"[^\"]*chatlist",'
  [[ "${2:-}" == --no-positive ]] && pos=''
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$1.json" <<JSON
{ "site": "$1",
  "probe": { "url": "https://$1/k/",
             $pos
             "logged_out_when_dom_matches": "(page-signQR|auth-qr-form)" },
  "actions": {} }
JSON
}
spaprobe() { run env FIVEDIVE_BROWSER_PROBE_WAIT_MS=1500 FIVEDIVE_BROWSER_PROBE_POLL_MS=300 "$BROWSER" status "$1"; }
loads() { cat "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$1/.fake-n" 2>/dev/null || echo 0; }

# --- T29a the page that has not decided yet is waited for ---------------------
SPAD="$(mkprofile spa.test "$SHELL_DOM")"
printf '%s' "$SHELL_DOM"    > "$SPAD/.fake-dom.1"
printf '%s' "$CHATLIST_DOM" > "$SPAD/.fake-dom.2"
spa_adapter spa.test
spaprobe spa.test
tc 'T29a a session whose page decides after the first look reads AUTHENTICATED' 'authenticated' "$OUT"
t  'T29a ...quietly, because a live session is not an alert' 0 "$RC"
t  'T29a ...and the only reason it could was that the probe looked AGAIN' 2 "$(loads spa.test)"

# --- T29b ...and the verdict is the LIVENESS FILE's too, not just the print ---
t  'T29b the tile remembers a live session, not the shell it saw first' 'authenticated' \
   "$(awk '{print $2}' "$SPAD/.5dive-liveness" 2>/dev/null | tail -1)"

# --- T29c a page that never says anything is UNKNOWN, NEVER authenticated -----
SILD="$(mkprofile spasilent.test "$SHELL_DOM")"
printf '%s' "$SHELL_DOM" > "$SILD/.fake-dom.1"
printf '%s' "$SHELL_DOM" > "$SILD/.fake-dom.2"
spa_adapter spasilent.test
spaprobe spasilent.test
tc 'T29c a page that never shows either marker is UNKNOWN' 'UNKNOWN' "$OUT"
tn 'T29c ...and is NOT called authenticated by elimination' 'authenticated' "$OUT"
t  'T29c ...quietly: a state we cannot read must not page a person' 0 "$RC"
t  'T29c ...it really did spend the budget looking' 'waited' \
   "$([[ "$(loads spasilent.test)" -ge 2 ]] && echo waited || echo "looked once")"
run env FIVEDIVE_BROWSER_PROBE_WAIT_MS=900 FIVEDIVE_BROWSER_PROBE_POLL_MS=300 \
    "$BROWSER" shot spasilent.test https://spasilent.test/k/ --out="$TMP/spasilent.png"
tn 'T29c ...and the fail-closed half holds: `shot` refuses on UNKNOWN' 0 "$RC"
t  'T29c ...writing no evidence at all' 'no' \
   "$([[ -e "$TMP/spasilent.png" ]] && echo yes || echo no)"

# --- T29d the logged-out marker still outranks the positive one ---------------
DEADD="$(mkprofile spadead.test "$SIGNIN_DOM")"
spa_adapter spadead.test
spaprobe spadead.test
tc 'T29d a rendered sign-in page is expired, and it names a person' 'session expired' "$OUT"
t  'T29d ...loudly, with the status a caller can branch on, not a quiet 0' 75 "$RC"
BOTHD="$(mkprofile spaboth.test "$SIGNIN_DOM$CHATLIST_DOM")"
spa_adapter spaboth.test
spaprobe spaboth.test
tc 'T29d ...and a document carrying BOTH markers is read as the dead one' 'session expired' "$OUT"

# --- T29e a challenge is still classified first -------------------------------
CHD="$(mkprofile spachal.test "<html><body><div class=\"g-recaptcha\"></div><div class=\"chatlist\">x</div></body></html>")"
spa_adapter spachal.test
spaprobe spachal.test
tc 'T29e a challenge page is a challenge even when the chatlist is behind it' 'CHALLENGE' "$OUT"

# --- T29f (CONTROL) an adapter with no positive marker is UNCHANGED -----------
# The wait is not free — it is another whole chrome launch — and this is the arm
# that keeps it off every server-rendered adapter we already ship.
LEGD="$(mkprofile legacy4794.test "$LIVE_DOM")"
printf '%s' "$LIVE_DOM" > "$LEGD/.fake-dom.1"
printf '%s' "$DEAD_DOM" > "$LEGD/.fake-dom.2"
spa_adapter legacy4794.test --no-positive
spaprobe legacy4794.test
tc 'T29f (control) a site that classifies on the negative alone still reads authenticated' 'authenticated' "$OUT"
t  'T29f (control) ...in exactly ONE load: no adapter pays for a wait it cannot use' 1 "$(loads legacy4794.test)"

# --- T29g the shipped Telegram adapter, graded against both documents ---------
# The markers are a public surface and this is the only place they are checked
# against the two renders they were read off. Both halves matter, and in
# opposite directions: a positive marker that matches the SHELL manufactures the
# exact lie `shot` and `run` exist to refuse.
TGA="$ROOT/plugins/browser/adapters/web.telegram.org.json"
run jq -e . "$TGA";                                            t 'T29g the adapter is valid JSON' 0 "$RC"
t  'T29g it probes the K app, not the bare host' 'https://web.telegram.org/k/' "$(jq -r '.probe.url' "$TGA")"
TGIN="$(jq -r '.probe.logged_in_when_dom_matches' "$TGA")"
TGOUT="$(jq -r '.probe.logged_out_when_dom_matches' "$TGA")"
t  'T29g it names what a LOGGED-IN page looks like' 'yes' "$([[ -n "$TGIN" && "$TGIN" != null ]] && echo yes || echo no)"
t  'T29g the logged-in marker matches the settled chatlist' 'match' \
   "$(grep -qiE "$TGIN" <<<"$CHATLIST_DOM" && echo match || echo miss)"
t  'T29g ...and does NOT match the static shell both states ship' 'miss' \
   "$(grep -qiE "$TGIN" <<<"$SHELL_DOM" && echo match || echo miss)"
t  'T29g the logged-out marker matches the rendered sign-in page' 'match' \
   "$(grep -qiE "$TGOUT" <<<"$SIGNIN_DOM" && echo match || echo miss)"
t  'T29g ...and does NOT match a live chatlist' 'miss' \
   "$(grep -qiE "$TGOUT" <<<"$CHATLIST_DOM" && echo match || echo miss)"
t  'T29g NEITHER marker keys on the shell, which is the whole defect' 'miss miss' \
   "$(grep -qiE "$TGOUT" <<<"$SHELL_DOM" && printf match || printf miss; printf ' '; \
      grep -qiE "$TGIN" <<<"$SHELL_DOM" && printf match || printf miss)"
t  'T29g the unmeasured half is NAMED in the file, not silently shipped' 'yes' \
   "$(jq -r '._comment' "$TGA" | grep -qi 'UNVERIFIED\|half-measured' && echo yes || echo no)"

# ============ T30 DIVE-4794: the client half exited before stdout was flushed
#
# THE DEFECT, measured on a box 2026-09-21: a brokered `read` of a real page
# came back as `jq: parse error: Unfinished string at EOF`. `callMode` wrote the
# payload to stdout and then called `process.exit(rc)` on the `end` frame —
# stdout is a PIPE for every caller (bin/browser runs it inside `$( … )`), a
# pipe write past the OS buffer is queued rather than done, and `process.exit`
# drops what is queued. So a capture that SUCCEEDED arrived truncated, and the
# verb died on it. Invisible to every arm whose payload fits in the buffer,
# which is why this one is deliberately two megabytes.
BIGSOCK="$TMP/big.sock"
cat > "$TMP/bigserve.js" <<'JS'
const net = require('net'), fs = require('fs');
const sock = process.argv[2], n = Number(process.argv[3]);
try { fs.unlinkSync(sock); } catch (e) {}
const srv = net.createServer((c) => {
  c.once('data', () => {
    c.write(JSON.stringify({ t: 'out', data: 'x'.repeat(n) + '\n' }) + '\n');
    c.write(JSON.stringify({ t: 'end', rc: 0 }) + '\n');
  });
});
srv.listen(sock, () => process.stdout.write('ready\n'));
setTimeout(() => process.exit(0), 30000);
JS
node "$TMP/bigserve.js" "$BIGSOCK" 2000000 >"$TMP/bigserve.out" 2>&1 &
BIGPID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -S "$BIGSOCK" ]] && break; sleep 0.2; done
BIGBYTES="$("$DAEMONBIN" call "$BIGSOCK" <<<'{"op":"ping"}' | wc -c)"
t  'T30a a two-megabyte payload arrives WHOLE through the client half' 2000001 "$BIGBYTES"
BIGRC=0; "$DAEMONBIN" call "$BIGSOCK" <<<'{"op":"ping"}' >/dev/null || BIGRC=$?
t  'T30a ...and the daemon-s own exit code still comes back' 0 "$BIGRC"
kill "$BIGPID" 2>/dev/null; rm -f "$BIGSOCK"


# ============ T29 DIVE-4791: `served` (what is up) and `forget` (the way out) ==
#
# WHAT THESE ARE MUTANTS OF. Until this row a customer could start a browser from
# the dashboard and then had NO control over it: the only Stop lived inside the
# handover block and vanished on the next render, and there was no way at all to
# log the box out of a site. Two verbs answer that, and the arms that matter are
# the ones that must NOT delete — a profile is a credential and this delete is
# the only irreversible act in the plugin.

FGSITE=forgethost.test
FGDIR="$(mkprofile "$FGSITE" "$LIVE_DOM")"

# --- T29a `served` names a running browser, and only a running one ------------
run "$BROWSER" served
tn 'T29a a profile that is not being served is not in `served`' "$FGSITE" "$OUT"
t  'T29a ...and asking is not an error' 0 "$RC"
FGPIDS="$(mkserve "$FGDIR" "$(date -u +%s)")"
run "$BROWSER" served
tc 'T29a a served profile is named' "$FGSITE" "$OUT"
t  'T29a ...as the bare site name, which is the whole parse contract' "$FGSITE" "$OUT"

# --- T29a2 THE `ls` LINE FORMAT IS UNCHANGED, which is why `served` exists -----
# The dashboard parses `ls` as "<site>  <iso> <state>". Had the served marker
# been appended there, every served site would have read as never-probed on the
# API running today — a false "Not checked yet" on a site that is fine.
printf '2026-09-21T10:00:00Z authenticated\n' > "$FGDIR/.5dive-liveness"
run "$BROWSER" ls
# THIS SITE'S LINE, not the whole listing: `ls` also prints the box-offer block,
# which says "not being served" about somebody else's profile. An arm that reads
# the whole output would grade that sentence instead of this row's contract.
FGLINE="$(printf '%s\n' "$OUT" | awk -v s="$FGSITE" '$1==s {print; exit}')"
tc 'T29a2 ls still prints the stamp verbatim after the site' \
   '2026-09-21T10:00:00Z authenticated' "$FGLINE"
tn 'T29a2 ...and says nothing about serving in that line' 'served' "$FGLINE"
t  'T29a2 ...so the line still parses as "<site>  <iso> <state>", which is what the API reads' 'parses' \
   "$(printf '%s' "$FGLINE" | grep -qE "^[[:space:]]+$FGSITE[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z [a-z-]+$" && echo parses || echo "drifted:$FGLINE")"

# --- T29b A PERSON IN THE VIEWER IS NEVER FORGOTTEN ---------------------------
# The dangerous arm, and the reason it is first: this refusal is the difference
# between "the login broke" and "the login is gone".
sleep 300 & FGVNC=$!
printf 'vnc_pid=%s\nws_pid=%s\nport=6080\nvnc_port=5900\n' "$FGVNC" "$FGVNC" > "$FGDIR/.5dive-viewer"
run "$BROWSER" forget "$FGSITE"
t  'T29b forgetting a profile with a person in it is refused' 69 "$RC"
tc 'T29b ...and says how to get out of it' 'viewer-revoke' "$ERR"
t  'T29b ...and the profile is still there' 'yes' "$([[ -d "$FGDIR" ]] && echo yes || echo no)"
t  'T29b ...cookie jar and all' 'yes' "$([[ -f "$FGDIR/.fake-dom" ]] && echo yes || echo no)"
rm -f "$FGDIR/.5dive-viewer"; kill "$FGVNC" 2>/dev/null; wait "$FGVNC" 2>/dev/null

# --- T29c A CALLER MID-ACTION IS NEVER FORGOTTEN ------------------------------
sleep 300 & FGHOLD=$!
mkdir -p "$FGDIR/.5dive-lease"
printf 'token=t\nholder=otherseat\nholder_pid=%s\nkind=agent\npurpose=publish\nacquired_at=%s\nexpires_at=%s\n' \
  "$FGHOLD" "$(date -u +%s)" "$(( $(date -u +%s) + 600 ))" > "$FGDIR/.5dive-lease/meta"
run "$BROWSER" forget "$FGSITE"
t  'T29c forgetting a browser under a live lease is refused' 69 "$RC"
tc 'T29c ...and names who holds it' 'held by otherseat' "$ERR"
t  'T29c ...and the profile is still there' 'yes' "$([[ -d "$FGDIR" ]] && echo yes || echo no)"
kill "$FGHOLD" 2>/dev/null; wait "$FGHOLD" 2>/dev/null
rm -rf "${FGDIR:?}/.5dive-lease"

# --- T29d the delete itself: the browser stops AND the credential goes --------
# `serve --stop` alone leaves the cookie jar on disk, which is the session
# replayable by anything that can read the directory. "Log the box out" is the
# directory going away; anything less is the feature not existing.
run "$BROWSER" forget "$FGSITE"
t  'T29d forget exits 0' 0 "$RC"
t  'T29d ...the profile directory is gone' 'no' "$([[ -d "$FGDIR" ]] && echo yes || echo no)"
tc 'T29d ...and it says the login is gone' 'connect again' "$OUT"
run "$BROWSER" ls
tn 'T29d ...so `ls` no longer lists it' "$FGSITE" "$OUT"
run "$BROWSER" served
tn 'T29d ...and neither does `served`' "$FGSITE" "$OUT"
for p in $FGPIDS; do kill "$p" 2>/dev/null; done

# --- T29e the audit line SURVIVES the delete it records -----------------------
# _audit_row appends to <profile>/.5dive-audit.jsonl, and this verb deletes that
# directory. An audit trail destroyed by the event it records is not one.
t 'T29e forget records itself in the seat store, not in the directory it removed' 'yes' \
  "$(grep -q '"event":"forget"' "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/.5dive-audit.jsonl" 2>/dev/null && echo yes || echo no)"
tc 'T29e ...and the line names the site' "$FGSITE" \
   "$(cat "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/.5dive-audit.jsonl" 2>/dev/null)"

# --- T29f a site that is not here is a refusal, not a silent success ----------
run "$BROWSER" forget neverhere.test
t  'T29f forgetting a profile that does not exist is refused' 69 "$RC"
run "$BROWSER" forget 'not a site'
t  'T29f an unusable profile name is a usage error, not a path' 64 "$RC"
run "$BROWSER" forget
t  'T29f forget with no site names the site it wants' 64 "$RC"
tc 'T29f ...by example' '5dive browser forget' "$ERR"

# --- T29g the box offer goes with it (DIVE-4664) ------------------------------
# A stale `.offered` tells every other seat "you use it, you do not log in
# again" about a profile that no longer exists.
OFSITE=offerhost.test
OFDIR="$(mkprofile "$OFSITE" "$LIVE_DOM")"
# The plugin derives SESSION_ROOT from the profile root's parent when the env
# does not name one, and this harness does not name one.
SESSROOT="${FIVEDIVE_BROWSER_PROFILE_ROOT%/*}/browser-sessions"
mkdir -p "$SESSROOT/$SEAT"
printf 'site=%s\nowner=%s\n' "$OFSITE" "$SEAT" > "$SESSROOT/$SEAT/$OFSITE.offered"
run "$BROWSER" forget "$OFSITE"
t 'T29g forget exits 0' 0 "$RC"
t 'T29g ...and the box offer for it is withdrawn' 'no' \
  "$([[ -f "$SESSROOT/$SEAT/$OFSITE.offered" ]] && echo yes || echo no)"

# --- T29h the verbs are reachable, and documented -----------------------------
tc 'T29h forget is dispatched' 'forget) shift; cmd_forget' "$(cat "$BROWSER")"
tc 'T29h served is dispatched' 'served) shift; cmd_served' "$(cat "$BROWSER")"
run bash "$BROWSER" --help
tc 'T29h --help tells a person forget deletes the login' 'forget <site>' "$OUT$ERR"
tc 'T29h ...and that it is the box logging out' 'LOG THE BOX OUT' "$OUT$ERR"

# --- T30 capture: both halves of a login check, on disk (DIVE-4929) ---------
# `5dive reflex login-marker` (5dive CLI, DIVE-4928) drafts a site's login check
# from a signed-out and a signed-in render of its probe page. This verb makes the
# two files. Its load-bearing properties: the halves really are different
# profiles, the files are the owner's alone, and a brokered seat cannot use it to
# pull the signed-in page of a site that no verdict has cleared for reading.
CAPSITE=capture.test
CAPIN='<html><head><title>Inbox</title></head><body><nav id="account-menu">me</nav></body></html>'
CAPOUT='<html><head><title>Sign in</title></head><body><form action="/session"><input name="login"></form></body></html>'
CAPDIR="$(mkprofile "$CAPSITE" "$CAPIN")"
export FAKE_COLD_DOM="$TMP/cap-cold.html"; printf '%s' "$CAPOUT" > "$FAKE_COLD_DOM"
CAPO="$TMP/cap-out-1"
run "$BROWSER" capture "$CAPSITE" --url=https://capture.test/settings --out="$CAPO"
t  'T30a capture exits 0' 0 "$RC"
t  'T30a the signed-out half is the THROWAWAY profile render' "$CAPOUT" "$(cat "$CAPO/signed-out.html" 2>/dev/null)"
t  'T30a the signed-in half is THIS login'"'"'s profile render' "$CAPIN" "$(cat "$CAPO/signed-in.html" 2>/dev/null)"
t  'T30a a second signed-out render, also from a throwaway profile' "$CAPOUT" "$(cat "$CAPO/signed-out-2.html" 2>/dev/null)"
t  'T30a all three files are 0600' '600 600 600' "$(stat -c %a "$CAPO/signed-out.html" "$CAPO/signed-out-2.html" "$CAPO/signed-in.html" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
t  'T30a the directory is 0700' 700 "$(stat -c %a "$CAPO" 2>/dev/null)"
tc 'T30a it prints the reflex command that reads all three files' "reflex login-marker $CAPSITE --url=https://capture.test/settings --logged-out=$CAPO/signed-out.html --logged-out=$CAPO/signed-out-2.html --logged-in=$CAPO/signed-in.html" "$OUT"
tc 'T30a the capture is an audit row on the profile' '"event":"capture"' "$(cat "$CAPDIR/.5dive-audit.jsonl" 2>/dev/null)"
t  'T30a no adapter was written' no "$([[ -e "$FIVEDIVE_BROWSER_ADAPTER_DIR/$CAPSITE.json" ]] && echo yes || echo no)"
tn 'T30a no adapter, so no --compare' '--compare=' "$OUT"
# The default --url is the probe URL, and a site WITH an adapter gets --compare.
mkadapter "$CAPSITE" "file://$TMP/artifact.html" 'PUBLISHED'
run "$BROWSER" capture "$CAPSITE" --out="$TMP/cap-out-2"
t  'T30b with no --url, the adapter'"'"'s probe URL is captured' 0 "$RC"
tc 'T30b ...and named in the command' '--url=https://capture.test.test/feed' "$OUT"
tc 'T30b an existing adapter is offered as the hand marker to compare' "--compare=$FIVEDIVE_BROWSER_ADAPTER_DIR/$CAPSITE.json" "$OUT"
rm -f "$FIVEDIVE_BROWSER_ADAPTER_DIR/$CAPSITE.json"
# A capture never overwrites.
run "$BROWSER" capture "$CAPSITE" --url=https://capture.test/settings --out="$CAPO"
t  'T30c a non-empty --out is refused' 64 "$RC"
t  'T30c ...and the earlier capture is untouched' "$CAPIN" "$(cat "$CAPO/signed-in.html" 2>/dev/null)"
# A profile that is not logged in renders the same page twice. Say so.
IDSITE=capture-same.test
mkprofile "$IDSITE" "$CAPOUT" >/dev/null
run "$BROWSER" capture "$IDSITE" --url=https://capture-same.test/ --out="$TMP/cap-out-3"
t  'T30d identical renders still exit 0 (the files are what they are)' 0 "$RC"
tc 'T30d ...with a warning that the profile may not be logged in' 'may not be logged in' "$ERR"
# The real case is NOT byte-identical: a sign-in page carries a fresh token per
# render. Same title, different bytes, must still warn.
TSITE=capture-title.test
mkprofile "$TSITE" '<html><head><title>Sign in</title></head><body><input name="tok" value="zz"></body></html>' >/dev/null
run "$BROWSER" capture "$TSITE" --url=https://capture-title.test/ --out="$TMP/cap-out-5"
tc 'T30d same page title with different bytes still warns (per-render tokens)' 'may not be logged in' "$ERR"
run "$BROWSER" capture nosuchprofile.test --out="$TMP/cap-out-4"
t  'T30e no profile for the site: refused' 69 "$RC"
run "$BROWSER" capture 'not a site'
t  'T30e an unusable name is a usage error' 64 "$RC"
# THE BROKERED REFUSAL. A seat using the box login must not get a file of the
# owner's signed-in page for a site nothing has cleared for reading.
BRKSITE=capture-box.test
mkprofile "$BRKSITE" "$CAPIN" "$BOXSEAT" >/dev/null
printf 'site=%s\nowner=%s\n' "$BRKSITE" "$BOXSEAT" > "$RVROOT/$BOXSEAT/$BRKSITE.offered"
capbrk() {  # <browser bin> -> rc; the capture a brokered seat attempts
  local o="$TMP/cap-brk-$RANDOM"
  env FIVEDIVE_BROWSER_SEAT="$OTHER" "$1" capture "$BRKSITE" --url=https://capture-box.test/ --out="$o" >/dev/null 2>"$TMP/.capbrk.e"
  local rc=$?
  [[ -e "$o/signed-in.html" ]] && return 99
  return "$rc"
}
capbrk "$BROWSER"; BRC=$?
t  'T30f a brokered seat is refused (77) and gets no file' 77 "$BRC"
tc 'T30f ...and is told the owner runs it' "sudo -u $BOXSEAT 5dive browser capture" "$(cat "$TMP/.capbrk.e")"
CAPMUT="$TMP/browser-capture-mutant"
sed 's|_open_site "$site" --no-broker capture "|_open_site "$site" "" capture "|' "$BROWSER" > "$CAPMUT"; chmod +x "$CAPMUT"
cp "$ROOT/plugins/browser/bin/session-daemon" "$TMP/session-daemon" 2>/dev/null || true
t  'T30f mutant applied' yes "$(cmp -s "$CAPMUT" "$BROWSER" && echo no || echo yes)"
capbrk "$CAPMUT"; MRC=$?
t  'T30f MUTANT (broker refusal dropped): the brokered capture is NOT refused' yes "$([[ "$MRC" != 77 ]] && echo yes || echo no)"
unset FAKE_COLD_DOM
tc 'T30g capture is dispatched' 'capture) shift; cmd_capture' "$(cat "$BROWSER")"
run bash "$BROWSER" --help
tc 'T30g --help names it' 'capture <site>' "$OUT$ERR"

# ============ T31 DIVE-4943: act anywhere, zero sites connected, the owner's four
#
# The row's five claims, each with the mutant that would pass a weaker suite:
#   T31a  a box with NO profiles reads and acts on a public page (scope 5). The
#         mutant is today's product: every page verb needs a connected <site>.
#   T31b  a connected site with no adapter proceeds, and says nobody confirmed the
#         login (scope 2)...
#   T31c  ...but a page that is visibly a sign-in form is still refused. Mutant:
#         the generic check never armed -> the old blanket UNKNOWN refusal.
#   T31d  two accounts on one site: never guessed, and the named one is used (6).
#   T31e  pay/publish/send/delete stop BEFORE the click and name the ask; the
#         owner's yes is bound to those steps, expires, and is spent once (3).
#         Mutant: the executor's guard removed -> the order is placed.
#   T31f  act's own refusals: no upload, no walking a login to another host.
#   T31g  the label table, graded directly.
unset FIVEDIVE_BROWSER_DRIVER
P31="$TMP/p31/profiles"; mkdir -p "$P31/$SEAT"; chmod 711 "$P31"; chmod 700 "$P31/$SEAT"
A31="$TMP/p31/approvals"
# Every ref in these arms resolves: the walk finds its element. What the arms grade
# is what act does AFTER the page answered, not the walk (T23 grades that).
W31="$TMP/p31/walk.json"; printf '{"nodes":[],"marker":"m-31"}' > "$W31"
actenv() { env FIVEDIVE_BROWSER_PROFILE_ROOT="$P31" FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/p31/sessions" \
               FIVEDIVE_BROWSER_APPROVAL_DIR="$A31" FIVEDIVE_BROWSER_RUN_SETTLE_MS=0 \
               NODE_PATH="$PWROOT/node_modules" PWREC="$PWREC" PWWALK="$W31" "$@"; }
STAR='[{"op":"click","selector":"ref=button/Star"}]'

# --- T31a zero connected sites: read + act on a public page -------------------
: > "$PWREC"
run actenv "$BROWSER" act "https://public-web.test/repo" --steps="$STAR" --out="$TMP/act31a"
t  'T31a act on a public page exits 0 on a box with no profiles' 0 "$RC"
t  'T31a ...it ran in the public profile, not a login' "$P31/$SEAT/_public" \
   "$(jq -rs '[.[]|select(.call=="launch")|.profile]|first' "$PWREC")"
t  'T31a ...the steps reached the page: the goto, then the click' 'goto click' \
   "$(jq -rs '[.[]|select(.call|IN("goto","click"))|.call]|join(" ")' "$PWREC")"
t  'T31a ...and the page after the steps was re-read to disk' 'yes' \
   "$([[ -s "$TMP/act31a/page.html" && -s "$TMP/act31a/after.json" ]] && echo yes || echo no)"
tc 'T31a ...with no --expect it says nothing re-graded it' 'Nothing re-graded it' "$OUT"
run actenv env PATH="$READPATH" READARGV="$TMP/r31-argv" READ_HTML="$READHTML" "$BROWSER" \
    read "https://public-web.test/article/1" --out="$TMP/read31a"
t  'T31a read of a public page exits 0 on the same box' 0 "$RC"
tc 'T31a ...and extracted the page' 'useful authenticated article content' "$(cat "$TMP/read31a/page.md" 2>/dev/null)"
run actenv "$BROWSER" ls
tn 'T31a the public profile is not listed as a connected site' '_public' "$OUT"
# the mutant: a <site> is required again (the dispatcher's URL route removed)
MUT31="$TMP/browser-noroute"
sed 's|^  read\|links\|shot\|snapshot\|tree\|act)$|  __never_routed__)|' "$BROWSER" > "$MUT31"; chmod +x "$MUT31"
t  'T31a mutant applied' yes "$(cmp -s "$MUT31" "$BROWSER" && echo no || echo yes)"
run actenv "$MUT31" act "https://public-web.test/repo" --steps="$STAR"
t  'T31a MUTANT (no URL route): the zero-site box cannot act' yes "$([[ "$RC" != 0 ]] && echo yes || echo no)"

# --- T31b/c a connected site with no adapter ----------------------------------
d=$(FIVEDIVE_BROWSER_PROFILE_ROOT="$P31" mkprofile noadapter.test "$LIVE_DOM")
: > "$PWREC"
run actenv "$BROWSER" act "https://noadapter.test/x" --steps="$STAR" --out="$TMP/act31b"
t  'T31b a live no-adapter login proceeds' 0 "$RC"
t  'T31b ...in that login, not the public profile' "$d" "$(jq -rs '[.[]|select(.call=="launch")|.profile]|first' "$PWREC")"
tc 'T31b ...and says no adapter confirmed the login' 'no adapter confirmed the noadapter.test login' "$ERR"
FIVEDIVE_BROWSER_PROFILE_ROOT="$P31" mkprofile signin.test \
  '<html><body><form action="/x"><input type="password" name="p"></form></body></html>' >/dev/null
: > "$PWREC"
run actenv "$BROWSER" act "https://signin.test/x" --steps="$STAR"
t  'T31c a no-adapter page that is a sign-in form is refused (75)' 75 "$RC"
t  'T31c ...before anything touched the page' 0 "$(jq -rs '[.[]|select(.call=="click")]|length' "$PWREC")"
MUT31G="$TMP/browser-nogeneric"
sed 's|state=$(_PROBE_GENERIC=1 _probe|state=$(_probe|' "$BROWSER" > "$MUT31G"; chmod +x "$MUT31G"
t  'T31c mutant applied' yes "$(cmp -s "$MUT31G" "$BROWSER" && echo no || echo yes)"
run actenv "$MUT31G" act "https://noadapter.test/x" --steps="$STAR"
t  'T31c MUTANT (no generic check): the LIVE no-adapter login is refused again' 75 "$RC"
# the render itself is re-checked: the site's front page was fine, the page asked for is a sign-in
: > "$PWREC"
run actenv env PWURL="https://noadapter.test/login?next=/x" "$BROWSER" act "https://noadapter.test/x" --steps="$STAR"
t  'T31c a page that ENDS on a sign-in URL is refused after the fact' 75 "$RC"
tc 'T31c ...naming the redirect' 'redirected to a sign-in' "$ERR"

# --- T31d several accounts on one site ----------------------------------------
dw=$(FIVEDIVE_BROWSER_PROFILE_ROOT="$P31" mkprofile gh.test_work "$LIVE_DOM")
FIVEDIVE_BROWSER_PROFILE_ROOT="$P31" mkprofile gh.test_personal "$LIVE_DOM" >/dev/null
: > "$PWREC"
run actenv "$BROWSER" act "https://gh.test/repo" --steps="$STAR"
t  'T31d two accounts for one host: refused, never guessed' 64 "$RC"
tc 'T31d ...naming both' 'gh.test_personal gh.test_work' "$ERR"
t  'T31d ...and nothing was launched' 0 "$(jq -rs '[.[]|select(.call=="launch")]|length' "$PWREC")"
run actenv "$BROWSER" act gh.test_work "https://gh.test/repo" --steps="$STAR"
t  'T31d the named account acts' 0 "$RC"
t  'T31d ...in its own profile' "$dw" "$(jq -rs '[.[]|select(.call=="launch")|.profile]|first' "$PWREC")"
run actenv "$BROWSER" act gh.test_work "https://other.test/repo" --steps="$STAR"
t  'T31d an account is still scoped to its site' 64 "$RC"

# --- T31e the owner's four -----------------------------------------------------
ORDER='[{"op":"click","selector":"ref=button/Place your order"}]'
: > "$PWREC"
run actenv env PWLABEL="Place your order" "$BROWSER" act "https://shop.test/cart" --steps="$ORDER" --out="$TMP/act31e"
t  'T31e placing an order stops with 73' 73 "$RC"
t  'T31e ...BEFORE the click reached the page' 0 "$(jq -rs '[.[]|select(.call=="click")]|length' "$PWREC")"
tc 'T31e ...naming the class and the button' 'pay or place an order ("Place your order' "$ERR"
tc 'T31e ...and the ask, with the approve command' 'sudo 5dive browser approve' "$ERR"
t  'T31e ...with a screenshot of the page before it' yes "$([[ -s "$TMP/act31e/page.png" ]] && echo yes || echo no)"
AID=$(sed -n 's/.*browser approve \([^ ]*\) .*/\1/p' <<<"$ERR" | head -1)
t  'T31e ...and a recorded ask' yes "$([[ -n "$AID" && -f "$A31/$AID.json" ]] && echo yes || echo no)"
run actenv env PWLABEL="Place your order" "$BROWSER" act "https://shop.test/cart" --steps="$ORDER" --approved="$AID"
t  'T31e an ask nobody answered is still refused' 73 "$RC"
run actenv "$BROWSER" approve "$AID"
t  'T31e a non-owner cannot approve' 77 "$RC"
run actenv env FIVEDIVE_BROWSER_GRANT_UID="$(id -u)" "$BROWSER" approve "$AID"
t  'T31e the owner approves' 0 "$RC"
tc 'T31e ...seeing what they approve' 'Place your order' "$OUT"
run actenv env PWLABEL="Place your order" FIVEDIVE_BROWSER_GRANT_UID="$(id -u)" "$BROWSER" act "https://shop.test/cart" \
    --steps='[{"op":"click","selector":"ref=button/Place your order"},{"op":"click","selector":"#more"}]' --approved="$AID"
t  'T31e a yes does not cover different steps' 73 "$RC"
tc 'T31e ...and says so' 'different steps' "$ERR"
: > "$PWREC"
run actenv env PWLABEL="Place your order" FIVEDIVE_BROWSER_GRANT_UID="$(id -u)" "$BROWSER" act "https://shop.test/cart" --steps="$ORDER" --approved="$AID"
t  'T31e the approved steps run' 0 "$RC"
t  'T31e ...and the click happens' 1 "$(jq -rs '[.[]|select(.call=="click")]|length' "$PWREC")"
run actenv env PWLABEL="Place your order" FIVEDIVE_BROWSER_GRANT_UID="$(id -u)" "$BROWSER" act "https://shop.test/cart" --steps="$ORDER" --approved="$AID"
t  'T31e a yes is spent by one run' 73 "$RC"
run actenv "$BROWSER" act "https://x-web.test/home" --steps='[{"op":"press","selector":"ref=textbox/Post text","key":"Control+Enter"}]'
t  'T31e Ctrl+Enter in a composer is a send, and stops' 73 "$RC"
run actenv env PWLABEL="Delete repository" "$BROWSER" act "https://gh2.test/settings" --steps='[{"op":"click","selector":"#danger"}]'
t  'T31e a CSS selector does not hide a delete: the LIVE label is read' 73 "$RC"
run actenv env PWLABEL="Star" "$BROWSER" act "https://gh2.test/repo" --steps='[{"op":"click","selector":"#star"}]'
t  'T31e (control) a harmless click is not stopped' 0 "$RC"
# the mutant: the executor's guard removed -> the order is placed
MUT31E="$TMP/mut31e"; rm -rf "$MUT31E"; cp -r "$ROOT/browser" "$MUT31E"
sed -i 's|if (plan.guard \&\& !plan.approved) {|if (false) {|' "$MUT31E/bin/driver-playwright"
t  'T31e mutant applied' yes "$(cmp -s "$MUT31E/bin/driver-playwright" "$ROOT/plugins/browser/bin/driver-playwright" && echo no || echo yes)"
: > "$PWREC"
run actenv env PWLABEL="Place your order" "$MUT31E/bin/browser" act "https://shop.test/cart" --steps="$ORDER"
t  'T31e MUTANT (guard removed): the order is placed without asking' '0 1' \
   "$RC $(jq -rs '[.[]|select(.call=="click")]|length' "$PWREC")"
# the warm session enforces the same rule, from the same shared function
t  'T31e the session daemon checks the same guard' yes \
   "$(grep -q 'aria.stepRisk(page, s, sel)' "$ROOT/plugins/browser/bin/session-daemon" && echo yes || echo no)"

# --- T31f act's own refusals ---------------------------------------------------
run actenv "$BROWSER" act "https://public-web.test/" --steps='[{"op":"upload","selector":"#f","path":"/etc/passwd"}]'
t  'T31f upload is not an act step' 64 "$RC"
run actenv "$BROWSER" act noadapter.test "https://noadapter.test/" --steps='[{"op":"goto","url":"https://evil.test/"}]'
t  'T31f a goto cannot walk a login to another host' 64 "$RC"
run actenv "$BROWSER" act "https://public-web.test/" --steps='not json'
t  'T31f steps must be a JSON array' 64 "$RC"
: > "$PWREC"
run actenv "$BROWSER" act "https://public-web.test/" --steps='[{"op":"fill","selector":"#q","value":"literal {braces} stay"}]'
t  'T31f the agent'"'"'s text is typed as given, braces and all' 'literal {braces} stay' \
   "$(jq -rs '[.[]|select(.call=="fill")|.val]|first' "$PWREC")"

# --- T31g the label table ------------------------------------------------------
t  'T31g labels classify' 'pay publish null send delete null null null' \
   "$(node -e '
     const a=require(process.argv[1]);
     console.log(["Place your order","Post","Posts","Send","Delete repository","Add to cart","Star","Search"]
       .map(x=>a.classifyLabel(x)).map(String).join(" "));' "$ROOT/plugins/browser/lib/aria.cjs")"
tc 'T31g act is dispatched' 'act)   shift; cmd_act' "$(cat "$BROWSER")"
run bash "$BROWSER" --help
tc 'T31g --help names act' 'browser act' "$OUT$ERR"

# --- T31h the warm session enforces the same stop -------------------------------
# The served browser is a SECOND copy of the step loop (session-daemon), so the
# guard is graded there too, through the real daemon over its socket.
mkprofile warmact.test "$LIVE_DOM" >/dev/null
DPWLABEL="$TMP/dpw.label"; printf 'Send' > "$DPWLABEL"
dserve warmact.test DPWLABEL="$DPWLABEL"
t  'T31h a warm session is up for the act arms' 0 "$RC"
LB31="$(launches)"; : > "$TMP/.drec-mark"; DREC_LINES=$(wc -l < "$DREC")
dwarm "$BROWSER" act warmact.test "https://warmact.test/inbox" --steps='[{"op":"click","selector":"#send"}]' --out="$TMP/act31h"
t  'T31h the warm session stops a send (73)' 73 "$RC"
t  'T31h ...before the click' 0 "$(tail -n +$((DREC_LINES+1)) "$DREC" | jq -rs '[.[]|select(.call=="click")]|length')"
t  'T31h ...in the browser that was already up (no launch)' "$LB31" "$(launches)"
tc 'T31h ...and names the ask' 'sudo 5dive browser approve' "$ERR"
printf 'Star' > "$DPWLABEL"; DREC_LINES=$(wc -l < "$DREC")
dwarm "$BROWSER" act warmact.test --steps='[{"op":"click","selector":"#star"}]' --out="$TMP/act31h2" --expect='feed'
t  'T31h (control) a harmless click with NO url continues on the held page and verifies' 0 "$RC"
# The login probe opens its OWN tab (kind "extra") and may navigate there; the
# held page is kind "first", and that is the one that must not be reloaded.
t  'T31h ...the click reached the held page, and the held page was not reloaded' '1 0' \
   "$(tail -n +$((DREC_LINES+1)) "$DREC" | jq -rs '[([.[]|select(.call=="click")]|length), ([.[]|select(.call=="goto" and .kind=="first")]|length)]|join(" ")')"
t  'T31h ...and the re-read came back over the socket' 'yes' \
   "$([[ -s "$TMP/act31h2/page.html" ]] && grep -q feed "$TMP/act31h2/page.html" && echo yes || echo no)"
env PATH="$SPATH" "$BROWSER" serve warmact.test --stop >/dev/null 2>&1

# --- TR28 THE DEPRECATION NOTICE: in the REGISTRY MANIFEST, and there only -----
# (Labelled T28 until DIVE-4927. The upstream harness this file mirrors took
# T28 for the late-ref wait, so the registry-only arms are TR28 now.)
#
# WHY THIS BLOCK EXISTS, AND WHY ITS SUBJECT MOVED (DIVE-4691 -> DIVE-4835).
# DIVE-4691 turned this registry entry into a deprecation stub and shipped the
# notice as a `_deprecated()` line inside `bin/browser`; `grep -ri deprecat
# tests/` came back empty when it did, so TR28 was written to hold that line in
# place against the next edit to the case statement. It then did its job:
# DIVE-4835 deleted the line and CI, not a reviewer, is what said so.
#
# THE DELETION IS KEPT, AND THIS IS THE CONTRACT THAT REPLACED IT.
# `plugins/browser/` is a byte-for-byte MIRROR of 5dive-ai/5dive-browser now,
# because the box converger's version floor is a min() over the two copies and a
# release that lands in only one reaches nobody (wiki:
# a-forked-plugin-makes-the-converger-floor-a-min-over-both-copies). A line that
# exists in this copy and not upstream turns every future port from a COPY into a
# MERGE, and a merge is where a missing hunk hides: DIVE-4835 found this copy
# three fixes behind precisely because DIVE-4797 had aligned the version NUMBER
# around such a divergence by hand instead of the bytes.
#
# So the notice lives in `.claude-plugin/marketplace.json` at this repo's ROOT —
# outside the mirrored directory, the one file a port cannot overwrite, and the
# text a box actually reads when it resolves `browser@5dive-plugins`.
# THE COST, written down because it is real and it is a trade, not a win: an
# operator who runs `5dive browser --help` on a box keyed to this copy no longer
# sees the migrate-away line at runtime.
#
# The old runtime line is still the STRING these arms grade — as the thing that
# must not come back INSIDE the mirror — and TR28c puts it back in a throwaway
# copy of the tree so that every "it is not there" below is measured by a probe
# shown to find it when it is. With the line deleted outright, "not found" is
# also what a broken grep, a misspelled pattern and a binary that never ran all
# return; an absence proved by a detector that cannot detect is not an absence.
OLDNOTICE='browser@5dive-plugins is deprecated; it ships from 5dive-ai/5dive-browser now'
NOTICEPAT='is deprecated; it ships from'
MARKET="$ROOT/.claude-plugin/marketplace.json"
MIRROR="$ROOT/plugins/browser"
_bentry()       { jq -r '.plugins[]|select(.name=="browser")|.description' "$MARKET"; }
_notice_files() { grep -RIl -- "$NOTICEPAT" "$1" 2>/dev/null | wc -l | tr -d '[:space:]'; }
mkprofile deprnotice.test "$LIVE_DOM" >/dev/null

# --- TR28a the notice IS in the registry manifest, and it is what goes red -----
# Three things a stranded box needs, and they are graded separately because a
# notice that says only "deprecated" leaves an operator with nowhere to go: that
# this copy is deprecated, where the plugin ships from now, and that migrating is
# REMOVE-then-ADD (the CLI refuses two plugins claiming the `browser` verb, so a
# reader who adds first is simply refused — TRAP C on the row).
tc 'TR28a the marketplace entry marks this copy deprecated' 'DEPRECATED' "$(_bentry)"
tc 'TR28a ...and names where the plugin ships from now' \
   '5dive plugin add 5dive-ai/5dive-browser' "$(_bentry)"
tc 'TR28a ...and the remove that has to come first' \
   'plugin remove browser@5dive-plugins' "$(_bentry)"
# Control: these read THIS entry, not the file. Another plugin in the same
# manifest must come back unmarked, or the three arms above would pass on a
# notice attached to anything at all.
t 'TR28a (control) no other entry in the manifest is marked deprecated' '0' \
  "$(jq -r '[.plugins[]|select(.name!="browser" and (.description|test("DEPRECATED")))]|length' "$MARKET")"

# --- TR28b the notice sits where a PORT CANNOT OVERWRITE IT --------------------
# This is the structural half and the whole reason it moved. The next port is
# `rsync -a --delete <upstream>/browser/ plugins/browser/`; everything inside
# that destination is replaced wholesale by a tree that has never heard of this
# registry. The file carrying the notice must therefore sit OUTSIDE the directory
# the marketplace entry points at.
SRCDIR="$ROOT/$(jq -r '.plugins[]|select(.name=="browser")|.source' "$MARKET" | sed 's|^\./||')"
t 'TR28b (control) the entry source really is the mirrored directory' 'yes' \
  "$([[ "$SRCDIR" -ef "$MIRROR" ]] && echo yes || echo no)"
t 'TR28b the notice lives outside it, where a port cannot reach' 'yes' \
  "$([[ "$MARKET" != "$SRCDIR"/* ]] && echo yes || echo no)"
t 'TR28b and no copy of the old runtime notice survives inside the mirror' '0' \
  "$(_notice_files "$MIRROR")"

# --- TR28c THE MUTANT: the same probes against a tree that DOES carry the line --
# The deleted line, put back in a throwaway copy of the mirror and printed on
# BOTH streams, so one mutant controls both directions. Every arm here is a
# control for a negative in TR28b/TR28d: if any of these fails to see the line, the
# corresponding "it is absent" arm is measuring nothing.
MUT="$TMP/mirror-mutant"
rm -rf "$MUT"; cp -a "$MIRROR" "$MUT"
python3 - "$MUT/bin/browser" "$OLDNOTICE" <<'PY'
import sys
path, line = sys.argv[1], sys.argv[2]
src = open(path).read().split('\n')
i = src.index('set -uo pipefail')      # the first statement, ahead of any dispatch
src[i + 1:i + 1] = ["echo '%s' >&2" % line, "echo '%s'" % line]
open(path, 'w').write('\n'.join(src))
PY
t  'TR28c (control) the mutant tree was built and is runnable' 'yes' \
   "$([[ -x "$MUT/bin/browser" ]] && echo yes || echo no)"
t  'TR28c (control) the file detector FINDS the line when a tree carries it' '1' \
   "$(_notice_files "$MUT")"
run bash "$MUT/bin/browser" ls
tc 'TR28c (control) ...and running the mutant puts it on stderr' "$OLDNOTICE" "$ERR"
tc 'TR28c (control) ...and on stdout, so the stdout arms below can see one too' \
   "$OLDNOTICE" "$OUT"

# --- TR28d no verb of the SHIPPED script carries it, on either stream ----------
# The two human verbs are graded alongside the parsed ones now: `--help` and
# `status` are where the line used to print, so they are where a re-added
# divergence shows up first. Each negative keeps its control proving the verb
# dispatched and spoke — an absence measured on a command that never ran grades
# nothing, which is the other way this block could have gone vacuous.
run bash "$BROWSER" --help
t  'TR28d --help still exits 0' 0 "$RC"
tn 'TR28d --help carries no notice on stderr' "$NOTICEPAT" "$ERR"
tn 'TR28d ...nor on the stdout a person pipes' "$NOTICEPAT" "$OUT"
tc 'TR28d (control) ...while the usage itself DID come out on stdout' '5dive browser' "$OUT"

run bash "$BROWSER" status deprnotice.test
tn 'TR28d status carries none on stderr' "$NOTICEPAT" "$ERR"
tn 'TR28d ...and none on its stdout' "$NOTICEPAT" "$OUT"
tc 'TR28d (control) ...and status really ran, all the way through the probe' \
   'deprnotice.test' "$OUT"

for _v in tree read snapshot run shot; do
  run bash "$BROWSER" "$_v"
  tn "TR28d $_v: none on the stdout a caller parses" "$NOTICEPAT" "$OUT"
  tn "TR28d $_v: none on its stderr either, which scripts read too" "$NOTICEPAT" "$ERR"
  tc "TR28d (control) $_v: ...and it really dispatched and spoke for itself" \
     "usage: 5dive browser $_v" "$ERR"
done
unset _v

# `ls` is the one parsed verb that SUCCEEDS with no arguments, so it grades the
# stdout case with a stream that actually has content in it rather than an empty
# one — an absence proved on no output is not an absence.
run bash "$BROWSER" ls
t  'TR28d ls: exits 0' 0 "$RC"
tc 'TR28d (control) ls: ...and it listed the store, so this stdout is real' \
   'deprnotice.test' "$OUT"
tn 'TR28d ls: no notice in that listing' "$NOTICEPAT" "$OUT"
tn 'TR28d ls: none on its stderr either' "$NOTICEPAT" "$ERR"
rm -rf "$MUT"


printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
