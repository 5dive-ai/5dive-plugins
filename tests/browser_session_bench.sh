#!/usr/bin/env bash
# DIVE-4621 acceptance 4 — THE RIG THAT PRODUCES THE WALL-CLOCK NUMBER.
#
# WHY THIS FILE EXISTS AT ALL. The row claims a per-command speedup from holding
# one browser open, and a magnitude in a CHANGES.md is a customer-facing number.
# A number whose instrument does not ship cannot be checked by anyone: a grader
# who writes their own rig produces a SECOND number, not a check of the first.
# This row has already been bitten by exactly that — an earlier measurement said
# 1.2x for this same change because its before arm restarted the browser through
# the code under test, and the catch came from re-reading the arm rather than
# from anything repeatable
# (community/wiki/a-before-arm-whose-teardown-calls-the-code-under-test-stops-being-a-before-arm.md).
#
# THE PIN THAT ARM LOST, and the reason it is an `export` here and not a prefix
# on the timed command: `run` restores the serve it stopped by calling
# `cmd_serve` IN ITS OWN PROCESS. A `FIVEDIVE_BROWSER_NO_DAEMON=1 browser run`
# passes the opt-out to the run and to its restore — but the SERVE that set the
# shape up ran without it, so the "before" arm was measuring a warm session after
# its first iteration. The opt-out is exported across the whole before arm, serve
# included, so every iteration of it is the same shape.
#
# WHAT IT IS NOT: a benchmark of a real web application. The page is a local
# static file, so this is the launch cost with the page cost near zero — an UPPER
# BOUND on the ratio for this task shape, not a constant. A real app spends more
# time in the page and less in the launch. It is also not a CI lane: it needs a
# real google-chrome and the pinned playwright-core, and it refuses rather than
# quietly measuring a fake.
#
# READING IT: the two cold shapes are LAUNCH-bound and therefore load-bound — on
# a busy box their medians roughly double while the warm median does not move at
# all (measured 2026-09-20: served-no-daemon 4047 -> 8656 ms, warm 1290 -> 1350
# ms, so the ratio ran 3.1x to 6.4x on the same tree). Quote a range from several
# runs, never one number from one run, and say what the box was doing.
#
#   tests/browser_session_bench.sh [iterations]        (default 3)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
ITER="${1:-3}"
SITE=bench.test

command -v google-chrome >/dev/null 2>&1 || { echo "no google-chrome on this box — this rig measures a real browser or nothing" >&2; exit 69; }
command -v node >/dev/null 2>&1 || { echo "no node" >&2; exit 69; }
command -v python3 >/dev/null 2>&1 || { echo "no python3 (it serves the static page)" >&2; exit 69; }
command -v Xvfb >/dev/null 2>&1 || { echo "no Xvfb — `serve` needs a display" >&2; exit 69; }
PWVER=$(node -e 'process.stdout.write(require("'"$ROOT"'/plugins/browser/node_modules/playwright-core/package.json").version)' 2>/dev/null) \
  || { echo "playwright-core is not installed next to the plugin (npm install in plugins/browser) — the warm shape cannot exist without it" >&2; exit 69; }

TMP="$(mktemp -d)"
SITEDIR="$TMP/site"; mkdir -p "$SITEDIR"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"
SEATDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$(id -un)"
mkdir -p "$SEATDIR/$SITE" "$FIVEDIVE_BROWSER_ADAPTER_DIR"
chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT" "$SEATDIR" "$SEATDIR/$SITE"

# Only the Xvfb THIS rig started, and proved twice: same uid, and not running
# before we began. Another seat's Xvfb on this box is somebody's live browser.
_XVFB_BEFORE=" $(pgrep -u "$(id -u)" -x Xvfb 2>/dev/null | tr '\n' ' ')"
cleanup() {
  FIVEDIVE_BROWSER_NO_DAEMON= "$BROWSER" serve "$SITE" --stop >/dev/null 2>&1
  [[ -n "${HTTPPID:-}" ]] && kill "$HTTPPID" 2>/dev/null
  local p n
  for p in $(pgrep -u "$(id -u)" -x Xvfb 2>/dev/null); do
    [[ "$_XVFB_BEFORE" == *" $p "* ]] && continue
    n=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | sed -n 's/.*Xvfb :\([0-9][0-9]*\).*/\1/p')
    kill "$p" 2>/dev/null
    [[ -n "$n" && -O "/tmp/.X11-unix/X$n" ]] && rm -f "/tmp/.X11-unix/X$n"
    [[ -n "$n" && -O "/tmp/.X$n-lock" ]] && rm -f "/tmp/.X$n-lock"
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# THE PAGE. `feed` is what the liveness probe reads — it carries no login form,
# so the profile probes authenticated. `artifact` is what the OUT-OF-BAND verify
# re-reads: it is static, so every shape gets the same verdict and the number is
# a wall clock and not a publish. `compose` is the three steps.
cat > "$SITEDIR/feed.html" <<'H'
<html><body><div id="feed">posts</div></body></html>
H
cat > "$SITEDIR/artifact.html" <<'H'
<html><body>PUBLISHED</body></html>
H
cat > "$SITEDIR/compose.html" <<'H'
<html><body><input id="e" name="e"><button id="pub">publish</button></body></html>
H

PORT=0
for try in $(seq 1 40); do
  P=$(( 20000 + RANDOM % 20000 ))
  (exec 3<>"/dev/tcp/127.0.0.1/$P") 2>/dev/null && continue
  PORT=$P; break
done
(( PORT )) || { echo "no free port" >&2; exit 69; }
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITEDIR" >/dev/null 2>&1 &
HTTPPID=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 0.1; done
BASE="http://127.0.0.1:$PORT"

cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$SITE.json" <<JSON
{ "site": "$SITE",
  "probe": { "url": "$BASE/feed.html", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": { "publish": {
      "steps": [ {"op":"goto","url":"$BASE/compose.html"},
                 {"op":"fill","selector":"#e","value":"{body}"},
                 {"op":"click","selector":"#pub"} ],
      "verify": { "url": "$BASE/artifact.html", "expect": "PUBLISHED" } } } }
JSON

now_ms() { date +%s%3N; }
median() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}'; }

# One timed `run`: goto + fill + click, then the out-of-band re-read. Anything
# that did not exit 0 is printed rather than averaged away — a failed run is
# fast for the wrong reason, and a rig that silently includes one is worse than
# no rig.
timed_run() {
  local t0 t1 rc
  t0=$(now_ms)
  "$BROWSER" run "$SITE" publish --body=hello >/dev/null 2>"$TMP/run.err"; rc=$?
  t1=$(now_ms)
  if (( rc != 0 )); then
    printf 'FAILED (rc=%s) after %s ms:\n' "$rc" "$((t1-t0))" >&2
    sed 's/^/    /' "$TMP/run.err" >&2
    return 1
  fi
  echo $((t1-t0))
}

shape() {  # shape <label> ; stdin-free, prints "<label>: a b c  median=N"
  local label="$1"; shift
  local -a ms=(); local m i
  for i in $(seq 1 "$ITER"); do
    m=$(timed_run) || { echo "$label: ABORTED — see the error above" ; return 1; }
    ms+=("$m")
  done
  MEDIAN=$(median "${ms[@]}")
  printf '%-28s %s  median=%s ms\n' "$label" "$(printf '%s ' "${ms[@]}")" "$MEDIAN"
}

printf 'rig: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'chrome: %s | playwright-core: %s | page: local static on %s | iterations: %s\n\n' \
  "$(google-chrome --version 2>/dev/null)" "$PWVER" "$BASE" "$ITER"

# ---- shape 1: SERVED, NO DAEMON — the shape a customer was in before this row.
# The export covers the serve as well as every run. See the header.
export FIVEDIVE_BROWSER_NO_DAEMON=1
"$BROWSER" serve "$SITE" >/dev/null 2>&1 || { echo "serve (no daemon) failed" >&2; exit 69; }
shape 'served, no daemon' || exit 1
COLD_SERVED="$MEDIAN"
"$BROWSER" serve "$SITE" --stop >/dev/null 2>&1

# ---- shape 2: NOTHING SERVED — no browser is being held at all.
shape 'nothing served' || exit 1
COLD_BARE="$MEDIAN"
unset FIVEDIVE_BROWSER_NO_DAEMON

# ---- shape 3: WARM — the daemon holds the context and the run attaches.
"$BROWSER" serve "$SITE" >/dev/null 2>&1 || { echo "serve (daemon) failed" >&2; exit 69; }
grep -q '^daemon_pid=[0-9]' "$SEATDIR/$SITE/.5dive-serve" || {
  echo "the warm shape did not get a daemon — this run would compare cold with cold" >&2; exit 69; }
shape 'warm session' || exit 1
WARM="$MEDIAN"
"$BROWSER" serve "$SITE" --stop >/dev/null 2>&1

printf '\nserved-no-daemon / warm : %s\n' "$(awk -v a="$COLD_SERVED" -v b="$WARM" 'BEGIN{printf "%.1fx", a/b}')"
printf 'nothing-served  / warm : %s\n' "$(awk -v a="$COLD_BARE" -v b="$WARM" 'BEGIN{printf "%.1fx", a/b}')"
