#!/usr/bin/env bash
# DIVE-5190 — Chrome's temp files must not outlive the Chrome that made them.
#
# A customer box (2026-09-29) had 3.0G in /tmp of `.com.google.Chrome.*` files
# and `scoped_dir*` directories: Chrome writes them into $TMPDIR and removes them
# only on a clean close, and this plugin ends most of its browsers with a kill.
# bin/browser now gives every launch its own TMPDIR under a root it owns, named
# <pid>.<starttime>, removes it on exit, and reaps the ones whose owner is dead.
#
# Driven through the real bin/browser as a subprocess, with a FAKE google-chrome
# first on PATH that litters $TMPDIR exactly the way the real one does. The
# test's notion of "the system /tmp" is $SYSTMP, handed to the plugin as TMPDIR —
# so a Chrome that still writes there is a Chrome the fix did not reach.
#
#   A1 a launch leaves nothing in the system tmp, and no per-launch dir after a
#      normal exit
#   A2 a per-launch dir whose owner was SIGKILLed is reaped by the next launch
#   A3 a per-launch dir whose owner is ALIVE survives the next launch's reap
#   A4 a live pid with a different starttime is a recycled pid: reaped
#   A5 a verb that sets and clears its own EXIT trap (`shot`) still cleans up,
#      and (A5b) so does one that dies while its own trap is set
#   A6 a detached session daemon owns its OWN dir, keyed on its pid, which the
#      short-lived parent does not delete and the next launch reaps once it dies
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"

TMP="$(mktemp -d)"
_KILL=()
trap 'rc=$?; for p in "${_KILL[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi
}
yn() { if "$@"; then echo yes; else echo no; fi; }
starttime() { local s; read -r s < "/proc/$1/stat" || return 1; s="${s##*) }"; local -a f; read -ra f <<<"$s"; echo "${f[19]}"; }

SYSTMP="$TMP/systmp"; mkdir -p "$SYSTMP"
export FIVEDIVE_BROWSER_TMP_ROOT="$TMP/tmproot"
export TMPDIR="$SYSTMP"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"; mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/no-rendezvous"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"; mkdir -p "$FIVEDIVE_BROWSER_X11_DIR"
SEEN="$TMP/seen"; : > "$SEEN"
export SEEN

# --- the fake chrome: litters $TMPDIR like the real one, records where --------
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
[[ "${1:-}" == --version ]] && { echo 'Google Chrome 153.0.8010.36'; exit 0; }
printf '%s\n' "${TMPDIR:-/tmp}" >> "$SEEN"
t="${TMPDIR:-/tmp}"
f=$(mktemp "$t/.com.google.Chrome.XXXXXX") && head -c 4096 /dev/zero > "$f"
mkdir -p "$t/scoped_dir$$_1" && : > "$t/scoped_dir$$_1/blob"
[[ -n "${FAKE_NOPNG:-}" ]] || for a in "$@"; do case "$a" in --screenshot=*) printf 'PNG' > "${a#*=}" ;; esac; done
echo '<html><body><div id="feed">posts</div></body></html>'
CHROME
cat > "$FAKEBIN/Xvfb" <<XVFB
#!/usr/bin/env bash
: > "$TMP/x11/X\${1#:}"
exec sleep 300
XVFB
chmod +x "$FAKEBIN/google-chrome" "$FAKEBIN/Xvfb"
export PATH="$FAKEBIN:$PATH"

SEAT="$(id -un)"
mkprofile() {
  local d="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$1"
  mkdir -p "$d"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT" "$d"
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$1.json" <<JSON
{ "site": "$1", "probe": { "url": "https://$1/feed", "logged_out_when_dom_matches": "action=\"/login\"" } }
JSON
}
mkprofile tmp.test
perlaunch() { find "$FIVEDIVE_BROWSER_TMP_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '; }
# A dir laid out like the product lays one out, owned by <pid> with <start>.
mkowned() {  # mkowned <pid> <starttime> -> path
  local d="$FIVEDIVE_BROWSER_TMP_ROOT/$1.$2"
  mkdir -p "$d/scoped_dir1_1"; : > "$d/.com.google.Chrome.abc123"; echo "$d"
}

# --- A1 a normal launch --------------------------------------------------------
: > "$SEEN"
"$BROWSER" status tmp.test >/dev/null 2>&1; rc=$?
arm 'A1 (control) the fake chrome actually ran' yes "$(yn test -s "$SEEN")"
arm 'A1 (control) status read the fake page as authenticated' 0 "$rc"
arm 'A1 Chrome was handed a per-launch TMPDIR under the plugin root, never the system tmp' yes \
  "$(yn grep -qE "^$FIVEDIVE_BROWSER_TMP_ROOT/[0-9]+\.[0-9]+\$" "$SEEN")"
arm 'A1 nothing Chrome wrote is left in the system tmp' '' "$(ls -A "$SYSTMP")"
arm 'A1 no per-launch dir is left after a normal exit' 0 "$(perlaunch)"

# --- A2 an owner that was SIGKILLed -------------------------------------------
sleep 300 & vp=$!; vs=$(starttime "$vp")
dead="$(mkowned "$vp" "$vs")"
kill -9 "$vp"; wait "$vp" 2>/dev/null
arm 'A2 (control) the owner is really dead' no "$(yn kill -0 "$vp" 2>/dev/null)"
"$BROWSER" status tmp.test >/dev/null 2>&1
arm 'A2 a dead owner'"'"'s per-launch dir is reaped at the next launch' no "$(yn test -e "$dead")"

# --- A3 an owner that is alive -------------------------------------------------
sleep 300 & lp=$!; _KILL+=("$lp"); ls=$(starttime "$lp")
live="$(mkowned "$lp" "$ls")"
"$BROWSER" status tmp.test >/dev/null 2>&1
arm 'A3 a live owner'"'"'s per-launch dir survives the next launch' yes \
  "$(yn test -e "$live/.com.google.Chrome.abc123")"

# --- A4 pid reuse ------------------------------------------------------------
reused="$(mkowned "$lp" "$(( ls + 1 ))")"
"$BROWSER" status tmp.test >/dev/null 2>&1
arm 'A4 (control) the recorded pid is alive' yes "$(yn kill -0 "$lp")"
arm 'A4 a live pid with the wrong starttime is a recycled pid, and its dir is reaped' no "$(yn test -e "$reused")"
arm 'A4 ...while the same pid'"'"'s real dir stays' yes "$(yn test -e "$live")"
kill "$lp" 2>/dev/null; wait "$lp" 2>/dev/null
rm -rf "$live"

# --- A5 a verb with its own EXIT trap (set, then `trap - EXIT`) -------------
: > "$SEEN"
"$BROWSER" shot tmp.test "https://tmp.test/x" --out="$TMP/a.png" >/dev/null 2>&1; rc=$?
arm 'A5 (control) shot rendered through the fake chrome' '0 yes' "$rc $(yn test -s "$TMP/a.png")"
arm 'A5 ...with a per-launch TMPDIR' yes "$(yn grep -qE "^$FIVEDIVE_BROWSER_TMP_ROOT/[0-9]+\." "$SEEN")"
arm 'A5 a verb that sets and clears its own EXIT trap still removes its dir' 0 "$(perlaunch)"
arm 'A5 ...and the system tmp is still empty' '' "$(ls -A "$SYSTMP")"
# ...and when it DIES while its own trap is set (`die` after the render fails):
# the shim must have appended our cleanup to the verb's trap, not replaced it.
FAKE_NOPNG=1 "$BROWSER" shot tmp.test "https://tmp.test/x" --out="$TMP/b.png" >/dev/null 2>&1; rc=$?
arm 'A5b (control) a render with no image dies with 69' 69 "$rc"
arm 'A5b a verb that dies inside its own EXIT trap still removes its dir' 0 "$(perlaunch)"

# --- A6 the detached session daemon owns its own dir -----------------------
DREC="$TMP/daemon.rec"
cat > "$TMP/session-daemon" <<DAEMON
#!/usr/bin/env bash
if [[ "\$1" == serve ]]; then
  printf '%s %s\n' "\$\$" "\${TMPDIR:-}" > "$DREC"
  mkdir -p "\$TMPDIR/scoped_dir\$\$_1"; : > "\$TMPDIR/.com.google.Chrome.dmn"
  echo "ready sock=\$3 pid=\$\$ broker=no"
  exec sleep 300
fi
exit 1
DAEMON
chmod +x "$TMP/session-daemon"
FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/session-daemon" DISPLAY= "$BROWSER" serve tmp.test >/dev/null 2>&1; rc=$?
dpid="$(sed -n 's/^daemon_pid=//p' "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/tmp.test/.5dive-serve" 2>/dev/null)"
xpid="$(sed -n 's/^xvfb_pid=//p' "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/tmp.test/.5dive-serve" 2>/dev/null)"
[[ -n "$dpid" ]] && _KILL+=("$dpid"); [[ -n "$xpid" ]] && _KILL+=("$xpid")
read -r rpid rdir < "$DREC" 2>/dev/null || { rpid=""; rdir=""; }
arm 'A6 (control) serve started the daemon' '0 yes' "$rc $(yn test -n "$dpid")"
arm 'A6 the daemon'"'"'s TMPDIR is named for the DAEMON'"'"'s own pid and start, not the parent'"'"'s' \
  "$FIVEDIVE_BROWSER_TMP_ROOT/$dpid.$(starttime "$dpid" 2>/dev/null)" "$rdir"
arm 'A6 ...and outlives the serve command that started it' yes "$(yn test -e "$rdir/.com.google.Chrome.dmn")"
"$BROWSER" status tmp.test >/dev/null 2>&1
arm 'A6 ...and survives the next launch'"'"'s reap while the daemon is alive' yes "$(yn test -e "$rdir/.com.google.Chrome.dmn")"
kill -9 "$dpid" "$xpid" 2>/dev/null
for _ in $(seq 50); do kill -0 "$dpid" 2>/dev/null || break; sleep 0.05; done
rm -f "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/tmp.test/.5dive-serve"
"$BROWSER" status tmp.test >/dev/null 2>&1
arm 'A6 once the daemon is killed, the next launch reaps its dir' no "$(yn test -e "${rdir:-/nonexistent-5190}")"
arm 'A6 ...leaving nothing behind' 0 "$(perlaunch)"
arm 'A6 ...and the system tmp is still empty' '' "$(ls -A "$SYSTMP")"

printf '\n%s passed, %s failed (%s arms)\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
[[ "$FAIL" -eq 0 ]]
