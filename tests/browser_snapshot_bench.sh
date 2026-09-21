#!/usr/bin/env bash
# DIVE-4653 — THE RIG THAT PRODUCES THE PER-DECISION NUMBER.
#
# WHAT IT MEASURES, in one sentence: the same decision, taken the way an agent
# takes it today (`tree` + `read` + `shot`) and the way this row makes available
# (`snapshot`), on the same page, in the same shape, on the same box.
#
# WHY THE ARMS ARE THREE VERBS AND NOT ONE. The unit here is a DECISION, not a
# command. An agent about to act needs what it can click, what the page says and
# what it looks like; each of those is its own command and each command is its
# own browser cycle, so the honest before-arm is all three. Timing `tree` against
# `snapshot` would compare one field against four and flatter this change.
#
# BOTH ARMS RUN IN THE SAME SHAPE, and that is the trap this repo has already
# fallen into once: a before-arm whose teardown re-enters the code under test
# stops being a before-arm
# (community/wiki/a-before-arm-whose-teardown-calls-the-code-under-test-stops-being-a-before-arm.md).
# So each shape below is set up once and BOTH arms are timed inside it.
#
# WHAT IT IS NOT. The page is a local static file, so this is the per-decision
# cost with the page cost near zero — an UPPER BOUND on the ratio for this task
# shape, not a constant. A real application spends more time in the page and less
# in the launch, and the honest claim from that is "fewer cycles", which the unit
# suite grades deterministically (T26b) and this rig cannot. It is also not a CI
# lane: it needs a real google-chrome and the pinned playwright-core, and it
# refuses rather than quietly measuring a fake.
#
#   tests/browser_snapshot_bench.sh [iterations]        (default 3)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
ITER="${1:-3}"
# THE SITE IS THE HOST ON PURPOSE. A profile is a credential scoped to the site
# it is named for, and every render verb refuses a URL outside it — so a local
# page can only be benchmarked by a profile named for the local host.
SITE=127.0.0.1

command -v google-chrome >/dev/null 2>&1 || { echo "no google-chrome on this box — this rig measures a real browser or nothing" >&2; exit 69; }
command -v node >/dev/null 2>&1 || { echo "no node" >&2; exit 69; }
command -v python3 >/dev/null 2>&1 || { echo "no python3 (it serves the static page)" >&2; exit 69; }
command -v Xvfb >/dev/null 2>&1 || { echo "no Xvfb — serve needs a display" >&2; exit 69; }
PWVER=$(node -e 'process.stdout.write(require("'"$ROOT"'/plugins/browser/node_modules/playwright-core/package.json").version)' 2>/dev/null) \
  || { echo "playwright-core is not installed next to the plugin (npm install in plugins/browser) — the warm shape cannot exist without it" >&2; exit 69; }

TMP="$(mktemp -d)"
SITEDIR="$TMP/site"; mkdir -p "$SITEDIR"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"
SEATDIR="$FIVEDIVE_BROWSER_PROFILE_ROOT/$(id -un)"
mkdir -p "$SEATDIR/$SITE" "$FIVEDIVE_BROWSER_ADAPTER_DIR"
chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT" "$SEATDIR" "$SEATDIR/$SITE"

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

# The page carries no login form, so the profile probes authenticated, and it
# carries enough article text and enough addressable nodes for the extractor and
# the walk to have real work to do.
cat > "$SITEDIR/feed.html" <<'H'
<html><body><div id="feed">posts</div></body></html>
H
cat > "$SITEDIR/page.html" <<'H'
<!doctype html><html><head><title>Bench Article</title></head><body>
<nav><a href="/nav">Nav</a></nav>
<article><h1>Bench Article</h1>
<p>A paragraph with enough words in it that the pinned extractor has a real document to work on rather than an empty shell, repeated below so the walk and the extraction both cost something.</p>
<p>A second paragraph, for the same reason, with a <a href="/next">link</a> in it.</p>
<form><input name="q" placeholder="Search"><button id="go">Go</button>
<button id="send">Send</button><button id="save">Save</button></form>
</article><footer>Footer</footer></body></html>
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
PAGE="$BASE/page.html"

cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$SITE.json" <<JSON
{ "site": "$SITE",
  "probe": { "url": "$BASE/feed.html", "logged_out_when_dom_matches": "action=\"/login\"" },
  "actions": {} }
JSON

now_ms() { date +%s%3N; }
median() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:int((a[NR/2]+a[NR/2+1])/2)}'; }

# A FAILED ARM IS PRINTED, NEVER AVERAGED. A verb that refused is fast for the
# wrong reason, and a rig that quietly includes one is worse than no rig.
timed() {  # timed <label> <verb...>
  local label="$1"; shift
  local t0 t1 rc
  t0=$(now_ms)
  "$@" >/dev/null 2>"$TMP/arm.err"; rc=$?
  t1=$(now_ms)
  if (( rc != 0 )); then
    printf 'FAILED %s (rc=%s) after %s ms:\n' "$label" "$rc" "$((t1-t0))" >&2
    sed 's/^/    /' "$TMP/arm.err" >&2
    return 1
  fi
  echo $((t1-t0))
}

three_verbs() {  # the decision as it is taken today: three commands, three cycles
  local a b c
  a=$(timed tree "$BROWSER" tree "$SITE" "$PAGE" --json) || return 1
  b=$(timed read "$BROWSER" read "$SITE" "$PAGE" --out="$TMP/arm-read") || return 1
  c=$(timed shot "$BROWSER" shot "$SITE" "$PAGE" --out="$TMP/arm-shot.png") || return 1
  rm -rf "$TMP/arm-read" "$TMP/arm-shot.png"
  echo $((a+b+c))
}

one_snapshot() {
  local m
  m=$(timed snapshot "$BROWSER" snapshot "$SITE" "$PAGE" --out="$TMP/arm-snap" --json) || return 1
  rm -rf "$TMP/arm-snap"
  echo "$m"
}

arm() {  # arm <label> <fn>
  local label="$1" fn="$2"; local -a ms=(); local m i
  for i in $(seq 1 "$ITER"); do
    m=$("$fn") || { echo "$label: ABORTED — see the error above"; return 1; }
    ms+=("$m")
  done
  MEDIAN=$(median "${ms[@]}")
  printf '  %-26s %s median=%s ms\n' "$label" "$(printf '%s ' "${ms[@]}")" "$MEDIAN"
}

printf 'rig: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'chrome: %s | playwright-core: %s | page: local static on %s | iterations: %s\n\n' \
  "$(google-chrome --version 2>/dev/null)" "$PWVER" "$BASE" "$ITER"

printf 'SHAPE 1 — nothing served (no browser is being held at all)\n'
arm 'tree + read + shot' three_verbs || exit 1
COLD_THREE="$MEDIAN"
arm 'snapshot'           one_snapshot || exit 1
COLD_SNAP="$MEDIAN"

printf '\nSHAPE 2 — served, warm daemon holding the profile\n'
"$BROWSER" serve "$SITE" >/dev/null 2>&1 || { echo "serve failed" >&2; exit 69; }
grep -q '^daemon_pid=[0-9]' "$SEATDIR/$SITE/.5dive-serve" || {
  echo "the warm shape did not get a daemon — this run would compare cold with cold" >&2; exit 69; }
arm 'tree + read + shot' three_verbs || exit 1
WARM_THREE="$MEDIAN"
arm 'snapshot'           one_snapshot || exit 1
WARM_SNAP="$MEDIAN"
"$BROWSER" serve "$SITE" --stop >/dev/null 2>&1

printf '\nnothing served : three verbs / snapshot = %s\n' \
  "$(awk -v a="$COLD_THREE" -v b="$COLD_SNAP" 'BEGIN{printf "%.1fx", a/b}')"
printf 'warm daemon    : three verbs / snapshot = %s\n' \
  "$(awk -v a="$WARM_THREE" -v b="$WARM_SNAP" 'BEGIN{printf "%.1fx", a/b}')"
printf '\nQuote a RANGE from several runs and say what the box was doing: the cold arms are\nlaunch-bound and therefore load-bound, and the spread falls on one side only.\n'
