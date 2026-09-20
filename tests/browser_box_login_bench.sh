#!/usr/bin/env bash
# DIVE-4664 acceptance 4 — THE RIG THAT PRODUCES THE PER-SITE MEMORY NUMBER.
#
# THE CLAIM IT MEASURES, in one line: on a box whose logins are per BOX and
# brokered, N sites served = N Chromes, WHATEVER THE SEAT COUNT. Before this row
# the store was per seat, so the same N sites across M seats was N*M Chromes at
# ~300-500 MB each — 37 seats and one shared site meant 37 browsers, and the
# number of seats that could hold a live logged-in session at once was bounded by
# RAM rather than by anything about the work.
#
# WHY THE RIG SHIPS WITH THE NUMBER, and it is not politeness: a magnitude in a
# commit message cannot be checked by anybody, and a grader who writes their own
# rig produces a SECOND number rather than a check of the first
# (community/wiki/a-performance-number-is-only-gradeable-if-its-rig-ships-with-it.md).
# DIVE-4621's tests/browser_session_bench.sh is the pattern this follows.
#
# WHAT IT REPORTS, per-site and per-seat, and why both:
#   - the AVAILABLE-RAM delta for each site served (`free` available, MB). That
#     is the honest per-site cost. RSS summed over the chrome tree over-counts
#     badly — shared pages are counted once per process, and DIVE-4662's hand
#     test read 1396 MB of RSS for a ~550 MB available-delta on one site.
#   - the number of chrome processes, which is the STRUCTURAL half. Available RAM
#     moves for reasons that are not us; the process count does not.
#   - then M brokered seats each act on the SAME site, and both numbers are taken
#     again. The claim is that neither moves. A per-seat store would add a whole
#     browser here, and that is the mutant this rig exists to catch.
#
# WHAT IT IS NOT: a benchmark of real sites. The pages are local static files, so
# this is the per-site process cost with the page cost near zero — a LOWER bound
# on what a real site holds in memory, and the right bound for the claim, which
# is about how many browsers exist and not about how fat one gets.
#
# It refuses rather than quietly measuring a fake: no real google-chrome, no
# pinned playwright-core, no Xvfb -> exit 69 and say so.
#
#   tests/browser_box_login_bench.sh [sites] [seats]     (default 2 sites, 3 seats)
#   tests/browser_box_login_bench.sh --self-test         (plumbing only, no browser)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"

SELFTEST=0
[[ "${1:-}" == "--self-test" ]] && { SELFTEST=1; shift; }
SITES="${1:-2}"
SEATS="${2:-3}"
[[ "$SITES" =~ ^[0-9]+$ && "$SEATS" =~ ^[0-9]+$ ]] || { echo "usage: $0 [sites] [seats] | --self-test" >&2; exit 64; }

# Available MB, read the way a person would read it. /proc/meminfo rather than
# `free` output parsing: one field, one name, no locale and no column drift.
avail_mb() { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }
# COUNT THE LINES, do not ask pgrep to count. `pgrep -c` prints 0 AND exits 1
# when nothing matches, so a `|| echo 0` fallback appends a SECOND zero and the
# meter reads "0\n0" — which then fails the numeric check in --self-test.
chrome_procs() { pgrep -u "$(id -u)" -f 'chrome|chromium' 2>/dev/null | wc -l; }

missing() {
  local m=()
  command -v google-chrome >/dev/null 2>&1 || m+=("google-chrome")
  command -v node >/dev/null 2>&1          || m+=("node")
  command -v Xvfb >/dev/null 2>&1          || m+=("Xvfb")
  command -v python3 >/dev/null 2>&1       || m+=("python3 (SO_PEERCRED, and it serves the static pages)")
  node -e 'require("'"$ROOT"'/plugins/browser/node_modules/playwright-core/package.json")' >/dev/null 2>&1 \
    || m+=("playwright-core next to the plugin (npm install --prefix plugins/browser)")
  printf '%s\n' "${m[@]-}"
}

MISS="$(missing | sed '/^$/d')"

if (( SELFTEST )); then
  # THE PLUMBING, WITHOUT A BROWSER. This is what the unit suite can run on any
  # box: that the rig parses its arguments, that its two meters read real
  # numbers, and — the part that matters — that it REFUSES rather than printing
  # a number it did not measure.
  echo "self-test: per-site memory rig (DIVE-4664 acceptance 4)"
  a="$(avail_mb)"; c="$(chrome_procs)"
  [[ "$a" =~ ^[0-9]+$ ]] || { echo "  FAIL: the available-RAM meter read '$a'"; exit 1; }
  [[ "$c" =~ ^[0-9]+$ ]] || { echo "  FAIL: the chrome-process meter read '$c'"; exit 1; }
  echo "  available-RAM meter: ${a} MB"
  echo "  chrome-process meter: ${c}"
  echo "  sites=$SITES seats=$SEATS"
  if [[ -n "$MISS" ]]; then
    echo "  this box is missing: $(tr '\n' ',' <<<"$MISS" | sed 's/,$//')"
    echo "  so a real run refuses (exit 69) rather than reporting a number it did not measure."
  else
    echo "  this box has everything a real run needs, so it would measure rather than refuse."
    echo "  (a box missing any of them refuses — exit 69 — instead of reporting a number it did not measure.)"
  fi
  exit 0
fi

if [[ -n "$MISS" ]]; then
  echo "this rig measures a real browser or nothing. Missing: $(tr '\n' ',' <<<"$MISS" | sed 's/,$//')" >&2
  exit 69
fi

TMP="$(mktemp -d)"
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/browser-sessions"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"
SEAT="$(id -un)"
export FIVEDIVE_BROWSER_BOX_SEAT="$SEAT"
mkdir -p "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT" "$FIVEDIVE_BROWSER_ADAPTER_DIR" \
         "$FIVEDIVE_BROWSER_SESSION_ROOT/$SEAT"
chmod 711 "$FIVEDIVE_BROWSER_PROFILE_ROOT" "$FIVEDIVE_BROWSER_SESSION_ROOT"
chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"
chmod 750 "$FIVEDIVE_BROWSER_SESSION_ROOT/$SEAT"

PAGES="$TMP/pages"; mkdir -p "$PAGES"
printf '<html><body><div id="feed">posts</div></body></html>' > "$PAGES/index.html"
( cd "$PAGES" && exec python3 -m http.server 0 --bind 127.0.0.1 >"$TMP/http.log" 2>&1 ) &
HTTPPID=$!
PORT=""
for _ in $(seq 1 100); do
  PORT=$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$TMP/http.log" | head -1)
  [[ -n "$PORT" ]] && break
  sleep 0.1
done
[[ -n "$PORT" ]] || { echo "the static page server never came up" >&2; kill "$HTTPPID" 2>/dev/null; exit 69; }

SERVED=()
cleanup() {
  local s
  for s in ${SERVED+"${SERVED[@]}"}; do "$BROWSER" serve "$s" --stop >/dev/null 2>&1; done
  kill "$HTTPPID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

printf '\nper-site memory, and what it costs to add a SEAT (DIVE-4664)\n'
printf '  box seat: %s   sites: %s   brokered seats: %s\n\n' "$SEAT" "$SITES" "$SEATS"
printf '  %-14s %14s %14s %10s\n' 'after serving' 'available MB' 'delta MB' 'chromes'

BASE_A="$(avail_mb)"; BASE_C="$(chrome_procs)"
printf '  %-14s %14s %14s %10s\n' '(nothing)' "$BASE_A" '-' "$BASE_C"

PREV_A="$BASE_A"
for i in $(seq 1 "$SITES"); do
  site="bench$i.test"
  cat > "$FIVEDIVE_BROWSER_ADAPTER_DIR/$site.json" <<JSON
{ "site": "$site", "probe": { "url": "http://127.0.0.1:$PORT/", "logged_out_when_dom_matches": "action=\"/login\"" } }
JSON
  mkdir -p "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$site"
  chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT/$site"
  "$BROWSER" serve "$site" >/dev/null 2>&1 || { echo "  serve $site failed — nothing to measure" >&2; exit 69; }
  SERVED+=("$site")
  sleep 2
  a="$(avail_mb)"; c="$(chrome_procs)"
  printf '  %-14s %14s %14s %10s\n' "$site" "$a" "$(( PREV_A - a ))" "$c"
  PREV_A="$a"
done

AFTER_SITES_A="$(avail_mb)"; AFTER_SITES_C="$(chrome_procs)"

# THE SEAT DIMENSION, and it is the whole point of the row. Each of these is a
# seat with NO login of its own, acting on the first site through the broker.
# A per-seat store would add a browser per seat here.
printf '\n  %-14s %14s %14s %10s\n' 'after seat' 'available MB' 'delta MB' 'chromes'
PREV_A="$AFTER_SITES_A"
for j in $(seq 1 "$SEATS"); do
  FIVEDIVE_BROWSER_SEAT="bench-seat-$j.test" "$BROWSER" status bench1.test >/dev/null 2>&1
  a="$(avail_mb)"; c="$(chrome_procs)"
  printf '  %-14s %14s %14s %10s\n' "seat $j" "$a" "$(( PREV_A - a ))" "$c"
  PREV_A="$a"
done

END_C="$(chrome_procs)"
printf '\n  chromes after %s sites: %s      after %s more seats on top: %s\n' \
  "$SITES" "$AFTER_SITES_C" "$SEATS" "$END_C"
if (( END_C == AFTER_SITES_C )); then
  printf '  N sites = N browsers, whatever the seat count. Adding %s seats added %s browsers.\n\n' "$SEATS" "$(( END_C - AFTER_SITES_C ))"
else
  printf '  A SEAT ADDED A BROWSER (%s -> %s). That is the per-seat store, not the box login.\n\n' "$AFTER_SITES_C" "$END_C"
  exit 1
fi
