#!/usr/bin/env bash
# DIVE-5335 — THE RIG THAT PRODUCES THE RUN-1-VS-RUN-3 NUMBERS, on a real site.
#
# WHAT IT MEASURES. One fixed routine on en.wikipedia.org — search for an
# article, then follow a link out of it — done three times by the real
# bin/browser, real driver, real Chrome and the real site:
#
#   run 1  the way an agent does it with no routine: snapshot the page, pick a
#          ref, act; snapshot the next page, pick a ref, act. Each act carries
#          --record, so run 1 is also the recording.
#   run 2, run 3   `replay`: one call, every step from the cache.
#
# "MODEL CALLS" IS COUNTED, NOT GUESSED, and this is the definition: in an agent
# loop every tool call is preceded by one model turn that chose it, so the model
# calls a run costs are the browser calls it makes (+1 for the turn that reports
# the result, the same in every run and left out). The picks this script makes
# in run 1 (the first searchbox; the link named in LINK) stand in for the
# model's choice — the call they stand in for is what is counted. Re-picks the
# replay had to ask reflex for are counted as model calls too (here: none —
# reflex is not configured on a runner, so a miss would FAIL, not hide).
#
# "TOKENS" is what the agent has to read to make those calls: each command's
# output, plus for a snapshot the refs (tree.json) and the picture (page.png, at
# Claude's image rate: w*h/750 after the API's resize). page.md is left OUT of
# run 1 — it is what an agent reads to understand a page, not to pick a ref —
# so run 1 is UNDER-counted and the ratio is conservative. Text is bytes/4.
#
# THE DELTA TABLE is separate, because this routine never re-reads a page: it is
# the re-read an agent makes to check what a step did — the same URL snapshotted
# twice, full and then --delta — on the two pages of the routine.
#
# It needs a real google-chrome, the pinned playwright-core (npm install in
# browser/) and the network. It refuses rather than measuring a fake. CI runs it
# as its own job; never on the production host.
#
#   tests/browser_routine_bench.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BROWSER="$ROOT/plugins/browser/bin/browser"
command -v google-chrome >/dev/null 2>&1 || { echo "no google-chrome — this rig measures a real browser or nothing" >&2; exit 69; }
command -v node >/dev/null 2>&1 || { echo "no node" >&2; exit 69; }
PWVER=$(node -e 'process.stdout.write(require("'"$ROOT"'/plugins/browser/node_modules/playwright-core/package.json").version)' 2>/dev/null) \
  || { echo "playwright-core is not installed next to the plugin (npm install --prefix plugins/browser)" >&2; exit 69; }

START="https://en.wikipedia.org/wiki/Main_Page"
QUERY="Ada Lovelace"
EXPECT1="Countess of Lovelace"
LINK="Analytical Engine"
EXPECT2="Charles Babbage"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FIVEDIVE_BROWSER_PROFILE_ROOT="$TMP/profiles"
export FIVEDIVE_BROWSER_ADAPTER_DIR="$TMP/adapters"
export FIVEDIVE_BROWSER_SESSION_ROOT="$TMP/sessions"
export FIVEDIVE_BROWSER_SESSION_DAEMON="$TMP/no-session-daemon"
export FIVEDIVE_BROWSER_CLI="$TMP/no-5dive-cli"
export FIVEDIVE_BROWSER_AUTO_PROPOSE=0 FIVEDIVE_BROWSER_DRIFT_ON_PROBE=0 FIVEDIVE_BROWSER_EVICT_ON_PROBE=0
export FIVEDIVE_BROWSER_APPROVAL_DIR="$TMP/approvals" FIVEDIVE_BROWSER_APPROVAL_POLICY="$TMP/policy.json"
SEAT="$(id -un)"
mkdir -p "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT" "$FIVEDIVE_BROWSER_ADAPTER_DIR"
chmod 711 "$FIVEDIVE_BROWSER_PROFILE_ROOT"; chmod 700 "$FIVEDIVE_BROWSER_PROFILE_ROOT/$SEAT"

now_ms() { date +%s%3N; }
# Claude's image cost: fit in 1568 px on the long edge and ~1.15 MP, then w*h/750.
img_tokens() {
  [[ -s "$1" ]] || { echo 0; return; }
  node -e '
    const b = require("fs").readFileSync(process.argv[1]);
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1150000 / (w * h)));
    process.stdout.write(String(Math.ceil((w * s) * (h * s) / 750)));' "$1"
}
txt_tokens() { local n=0 f; for f in "$@"; do [[ -f "$f" ]] && n=$(( n + $(wc -c < "$f") )); done; echo $(( (n + 3) / 4 )); }

CALLS=0; TOKENS=0; WALL=0
cmd() {  # cmd <label> <args...> — one browser call, timed, its output kept
  local label="$1"; shift
  local t0 t1; t0=$(now_ms)
  "$BROWSER" "$@" >"$TMP/out" 2>"$TMP/err"; RC=$?
  t1=$(now_ms)
  CALLS=$((CALLS + 1)); WALL=$((WALL + t1 - t0))
  printf '  %-34s rc=%s %6s ms\n' "$label" "$RC" "$((t1 - t0))" >&2
  if (( RC != 0 )); then sed 's/^/    | /' "$TMP/err" "$TMP/out" | tail -25 >&2; fi
}
snap_cost() {  # <artifacts dir> -> tokens an agent reads to pick a ref (no page.md)
  echo $(( $(txt_tokens "$TMP/out" "$TMP/err" "$1/tree.json") + $(img_tokens "$1/page.png") ))
}
artifacts() { sed -n 's#^  \(/.*\)$#\1#p' "$TMP/out" | tail -1; }

# ------------------------------------------------------------------ run 1
echo "run 1: snapshot, pick, act --record (x2)" >&2
CALLS=0; TOKENS=0; WALL=0
cmd "snapshot $START" snapshot "$START" --interactive
(( RC == 0 )) || { echo "run 1: the start page did not snapshot" >&2; exit 1; }
A="$(artifacts)"; TOKENS=$((TOKENS + $(snap_cost "$A")))
SEARCH=$(jq -r '[.nodes[] | select(.role == "searchbox" or .role == "combobox")][0].ref // empty' "$A/tree.json")
[[ -n "$SEARCH" ]] || { echo "run 1: no searchbox on $START" >&2; jq -c '[.nodes[]|.ref][:40]' "$A/tree.json" >&2; exit 1; }
echo "  picked ref=$SEARCH" >&2
STEPS1=$(jq -nc --arg s "ref=$SEARCH" --arg q "$QUERY" '[{op:"fill",selector:$s,value:$q},{op:"press",selector:$s,key:"Enter"}]')
cmd "act search --record" act "$START" --steps="$STEPS1" --expect="$EXPECT1" --record=lookup --json
TOKENS=$((TOKENS + $(txt_tokens "$TMP/out" "$TMP/err")))
(( RC == 0 )) || { echo "run 1: the search act failed" >&2; exit 1; }
ARTICLE=$(jq -r '.url' "$TMP/out")
cmd "snapshot article" snapshot "$ARTICLE" --interactive
(( RC == 0 )) || exit 1
A="$(artifacts)"; TOKENS=$((TOKENS + $(snap_cost "$A")))
# Case-blind: a link's name is its title attribute first, and Wikipedia titles the
# lead's "Analytical Engine" link with the article's own name, "Analytical engine".
LREF=$(jq -r --arg l "$LINK" '[.nodes[] | select(.role == "link" and ((.name | ascii_downcase) == ($l | ascii_downcase)))][0].ref // empty' "$A/tree.json")
[[ -n "$LREF" ]] || { echo "run 1: no link named $LINK on $ARTICLE; links near that name:" >&2
  jq -r --arg w "${LINK##* }" '[.nodes[] | select(.role == "link" and ((.name | ascii_downcase) | contains($w | ascii_downcase))) | .ref][:15][]' "$A/tree.json" >&2; exit 1; }
echo "  picked ref=$LREF" >&2
cmd "act follow link --record" act "$ARTICLE" --steps="$(jq -nc --arg s "ref=$LREF" '[{op:"click",selector:$s}]')" --expect="$EXPECT2" --record=lookup --json
TOKENS=$((TOKENS + $(txt_tokens "$TMP/out" "$TMP/err")))
(( RC == 0 )) || { echo "run 1: the link act failed" >&2; exit 1; }
R1="$CALLS $TOKENS $WALL"

# ------------------------------------------------------------------ runs 2, 3
replay_run() {
  CALLS=0; TOKENS=0; WALL=0
  cmd "replay lookup" replay en.wikipedia.org lookup --values="$(jq -nc --arg q "$QUERY" '[$q]')" --json
  (( RC == 0 )) || { echo "replay failed" >&2; exit 1; }
  TOKENS=$((TOKENS + $(txt_tokens "$TMP/out" "$TMP/err")))
  local m; m=$(jq -r '.model_calls' "$TMP/out")
  CALLS=$((CALLS + m))
  echo "$CALLS $TOKENS $WALL $(jq -r '.repicked' "$TMP/out")"
}
echo "run 2: replay" >&2; R2=$(replay_run); [[ -n "$R2" ]] || exit 1
echo "run 3: replay" >&2; R3=$(replay_run); [[ -n "$R3" ]] || exit 1

# ------------------------------------------------------------------ delta
echo "delta: the same page snapshotted twice, full then --delta" >&2
DROWS=""
for U in "$START" "$ARTICLE"; do
  cmd "snapshot (full) $U" snapshot "$U" --interactive
  A="$(artifacts)"
  FULL=$(( $(txt_tokens "$TMP/out" "$TMP/err" "$A/tree.json" "$A/page.md") + $(img_tokens "$A/page.png") ))
  cmd "snapshot --delta $U" snapshot "$U" --interactive --delta
  DA="$(artifacts)"
  DJ="$DA/delta.json"
  APPLIED=$(jq -r '.applied // false' "$DJ" 2>/dev/null || echo false)
  # What the agent reads with --delta: what the verb printed (the delta itself),
  # and the picture only if it was written. Fallen back to full: all of it.
  if [[ "$APPLIED" == true ]]; then
    DT=$(( $(txt_tokens "$TMP/out" "$TMP/err") + $(img_tokens "$DA/page.png") ))
  else
    DT=$(( $(txt_tokens "$TMP/out" "$TMP/err" "$DA/tree.json" "$DA/page.md") + $(img_tokens "$DA/page.png") ))
  fi
  DROWS+="| ${U#https://} | $FULL | $DT | $APPLIED | $(jq -r '"+\(.refs.added|length) -\(.refs.removed|length) refs, +\(.text.added|length) -\(.text.removed|length) lines, png \(.png.changed) (\(if .png.write then "written" else "not written" end))"' "$DJ" 2>/dev/null) |"$'\n'
done

read -r C1 T1 W1 <<<"$R1"; read -r C2 T2 W2 P2 <<<"$R2"; read -r C3 T3 W3 P3 <<<"$R3"
pct() { awk -v a="$1" -v b="$2" 'BEGIN{ if (a == 0) print "n/a"; else printf "%.0f%%", (a - b) * 100 / a }'; }
{
  echo "### DIVE-5335 routine bench — en.wikipedia.org, real Chrome"
  echo
  echo "chrome: $(google-chrome --version 2>/dev/null) · playwright-core $PWVER · $(date -u +%FT%TZ)"
  echo
  echo "Routine: search \"$QUERY\" from the Main Page, then follow \"$LINK\". Each act --expect-verified."
  echo
  echo "| run | model calls | tokens read | wall ms | re-picks |"
  echo "|---|---|---|---|---|"
  echo "| 1 (snapshot + act, recording) | $C1 | $T1 | $W1 | – |"
  echo "| 2 (replay) | $C2 | $T2 | $W2 | $P2 |"
  echo "| 3 (replay) | $C3 | $T3 | $W3 | $P3 |"
  echo "| run 1 → run 3 | $(pct "$C1" "$C3") fewer | $(pct "$T1" "$T3") fewer | $(pct "$W1" "$W3") less | |"
  echo
  echo "Delta snapshots — a re-read of the same page (tokens an agent reads):"
  echo
  echo "| page | full snapshot | --delta | applied | what changed |"
  echo "|---|---|---|---|---|"
  printf '%s' "$DROWS"
} | tee "${GITHUB_STEP_SUMMARY:-/dev/null}"
# THE GATE the row sets: run 3 must make measurably fewer model calls than run 1.
(( C3 < C1 )) || { echo "FAIL: run 3 made $C3 model calls, run 1 made $C1" >&2; exit 1; }
