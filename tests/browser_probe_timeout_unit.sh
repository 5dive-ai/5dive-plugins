#!/usr/bin/env bash
# DIVE-5375 — a status probe's Chrome can never hold a profile forever.
#
# On chill-gorge (2026-10-01 01:52Z) a headless probe Chrome logged "Failed to
# connect to the bus" at start and never exited. --virtual-time-budget bounds page
# time, not a Chrome that wedges outside the page, and the probe had no wall-clock
# cap: the process held linkedin.com's SingletonLock for 28 hours, every later
# probe exited on "SingletonLock: File exists", and the tile read "Not checked yet".
#
# Driven through the real bin/browser with a FAKE google-chrome first on PATH that
# keeps Chrome's one-instance-per-profile rule (a SingletonLock naming a live pid
# refuses the launch, empty document) and, in `hang` mode, never exits.
#
#   T1 a probe whose Chrome never exits returns within N+5s (N = budget + slack)
#      with UNKNOWN — probe timed out, stamped in the liveness file
#   T2 it leaves no live process (the stub and its child) and no SingletonLock
#   T3 the next probe of the same site succeeds
#   T4 a profile held by a headless one-shot Chrome older than the stale age is
#      freed (holder and its child killed) and the probe succeeds
#   T5 a non-headless holder (a viewer's browser) is NEVER touched
#   T6 a young headless holder is not touched
#   T7 a headless holder with a debugging channel (the session daemon's) is not
#      touched
#
# NEGATIVE CONTROL: run with FIVEDIVE_TEST_BROWSER=<pre-fix bin/browser>; T1 hits
# the harness's own outer cap (the probe hangs) and goes red.
set -uo pipefail
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="${FIVEDIVE_TEST_BROWSER:-$ROOT/plugins/browser/bin/browser}"

TMP="$(mktemp -d)"
_KILL=()
trap 'rc=$?; for p in "${_KILL[@]}"; do pkill -KILL -P "$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; done; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT

PASS=0; FAIL=0
arm() {  # arm <name> <expected> <got>
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi
}
yn() { if "$@"; then echo yes; else echo no; fi; }
alive() { [[ -n "$1" && -d "/proc/$1" ]] && [[ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]]; }

export FIVEDIVE_BROWSER_TMP_ROOT="$TMP/tmproot"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"; mkdir -p "$FIVEDIVE_BROWSER_ADAPTER_DIR"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/no-rendezvous"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_X11_DIR="$TMP/x11"; mkdir -p "$FIVEDIVE_BROWSER_X11_DIR"
# N = ceil(8000 ms budget) + 2 s slack = 10 s. Production's slack is 30 s.
export FIVEDIVE_BROWSER_CHROME_SLACK_S=2
N=10
export FIVEDIVE_BROWSER_PROBE_STALE_S=2
export TMP

# --- the fake chrome -------------------------------------------------------------
FAKEBIN="$TMP/bin"; mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/google-chrome" <<'CHROME'
#!/usr/bin/env bash
[[ "${1:-}" == --version ]] && { echo 'Google Chrome 153.0.8010.36'; exit 0; }
ud=""
for a in "$@"; do case "$a" in --user-data-dir=*) ud="${a#*=}" ;; esac; done
ud="${ud%/}"
# Chrome's one-instance rule, as the real one keeps it on Linux.
if t=$(readlink "$ud/SingletonLock" 2>/dev/null); then
  p="${t##*-}"
  if [[ -d "/proc/$p" ]]; then
    echo "[ERROR:process_singleton_posix.cc(358)] Failed to create $ud/SingletonLock: File exists (17)" >&2
    exit 21
  fi
  rm -f "$ud/SingletonLock"
fi
ln -s "$(uname -n)-$$" "$ud/SingletonLock"
if [[ "$(cat "$TMP/mode" 2>/dev/null)" == hang && "$*" != *about:blank* ]]; then
  echo "$$" > "$TMP/hang.pid"
  echo "[ERROR:bus.cc(407)] Failed to connect to the bus" >&2
  sleep 100000 & echo "$!" > "$TMP/hang.child"
  wait
fi
echo '<html><body><div id="feed">posts</div></body></html>'
rm -f "$ud/SingletonLock"
CHROME
chmod +x "$FAKEBIN/google-chrome"
export PATH="$FAKEBIN:$PATH"

SEAT="$(id -un)"
mkprofile() {
  local d="$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$1"
  mkdir -p "$d"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT" "$d"
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$1.json" <<JSON
{ "site": "$1", "probe": { "url": "https://$1/feed", "logged_out_when_dom_matches": "action=\"/login\"" } }
JSON
  echo "$d"
}
D=$(mkprofile probe.test)
# A process that holds $D's lock, with the cmdline we give it: bash -c with a
# compound body, so bash stays the holder (no exec) and has a child to orphan.
holder() {  # holder <args...> -> pid
  bash -c 'sleep 100000; :' google-chrome "$@" >/dev/null 2>&1 &
  local p=$!; _KILL+=("$p")
  rm -f "$D/SingletonLock"; ln -s "$(uname -n)-$p" "$D/SingletonLock"
  echo "$p"
}
probe() {  # probe -> sets OUT RC SECS; the outer 40 s cap is the negative control's
  local t0; t0=$(date +%s)
  OUT=$(timeout -k 2 40 "$BROWSER" status probe.test 2>&1); RC=$?
  SECS=$(( $(date +%s) - t0 ))
}

# --- T0 control: the fake page reads as a login ---------------------------------
echo ok > "$TMP/mode"
probe
arm 'T0 (control) a normal probe reads authenticated' 0 "$RC"

# --- T1/T2 a Chrome that never exits ---------------------------------------------
echo hang > "$TMP/mode"; rm -f "$TMP/hang.pid" "$TMP/hang.child"
probe
hp=$(cat "$TMP/hang.pid" 2>/dev/null); hc=$(cat "$TMP/hang.child" 2>/dev/null)
_KILL+=(${hp:-} ${hc:-})
arm 'T1 (control) the hanging chrome really ran' yes "$(yn test -n "$hp")"
arm "T1 the probe returned within N+5 = $((N + 5))s (took ${SECS}s)" yes "$(yn test "$SECS" -le $((N + 5)))"
arm 'T1 it says the probe timed out' yes "$(yn grep -q 'UNKNOWN (probe timed out' <<<"$OUT")"
arm 'T1 the liveness file records the timeout, not a silent hang' yes \
  "$(yn grep -q 'UNKNOWN — probe timed out' "$D/.5dive-liveness")"
sleep 1
arm 'T2 the hung chrome is gone' no "$(yn alive "$hp")"
arm 'T2 its child is gone too (the whole group was stopped)' no "$(yn alive "$hc")"
arm 'T2 no SingletonLock is left naming the dead pid' no "$(yn test -L "$D/SingletonLock")"

# --- T3 the next probe of the same site ------------------------------------------
echo ok > "$TMP/mode"
probe
arm 'T3 the next probe of the same site succeeds' 0 "$RC"
arm 'T3 and reads authenticated' yes "$(yn grep -qE 'probe.test +authenticated' <<<"$OUT")"

# --- T4 a stale one-shot headless holder (a probe from before the cap) -----------
hp=$(holder --headless --no-sandbox --disable-gpu --user-data-dir="$D/" --virtual-time-budget=8000 --dump-dom https://probe.test/feed)
sleep 0.3; hc=$(pgrep -P "$hp" | head -1)
probe   # young (< 2 s): left alone, the probe reports it cannot load
arm 'T6 a young headless holder is not touched' yes "$(yn alive "$hp")"
arm 'T6 (control) the held profile really refused the launch' yes "$(yn grep -q 'UNKNOWN (chrome did not load the page.*SingletonLock' <<<"$OUT")"
sleep 3
probe
arm 'T4 a stale headless probe holder is killed' no "$(yn alive "$hp")"
arm 'T4 and its child' no "$(yn alive "$hc")"
arm 'T4 the probe then succeeds' 0 "$RC"
arm 'T4 and reads authenticated' yes "$(yn grep -qE 'probe.test +authenticated' <<<"$OUT")"

# --- T5 a viewer's browser (not headless) ----------------------------------------
hp=$(holder --user-data-dir="$D" --no-first-run --no-default-browser-check https://probe.test/feed)
sleep 3
probe
arm 'T5 a non-headless holder is NEVER touched' yes "$(yn alive "$hp")"
arm 'T5 its lock is left in place' yes "$(yn test -L "$D/SingletonLock")"
kill -KILL "$hp" 2>/dev/null; pkill -KILL -P "$hp" 2>/dev/null; rm -f "$D/SingletonLock"

# --- T7 the session daemon's Chrome (headless, but driven over a pipe) ------------
hp=$(holder --headless --remote-debugging-pipe --user-data-dir="$D" about:blank)
sleep 3
probe
arm 'T7 a headless holder with a debugging channel is not touched' yes "$(yn alive "$hp")"
kill -KILL "$hp" 2>/dev/null; pkill -KILL -P "$hp" 2>/dev/null; rm -f "$D/SingletonLock"

printf '\n%s pass, %s fail\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
