#!/usr/bin/env bash
# DIVE-7863 isolated unit harness for the review-loop block of `proof publish`
# (`_proof_review_build`, the REVIEWPY python in src/cmd_proof.sh). Builds a
# fixture task board (lifecycle_events + tasks) and drives the builder in a temp
# status checkout — no git, no network, no live board. Asserts:
#   - each task counts ONCE, on the day of its LAST task.done, inside the window
#     of whole days before the publish date (today's done is outside),
#   - reviewed = graded or rejected; first try = reviewed, never sent back,
#   - a merge conflict after a PASS is NOT a send-back,
#   - an unreviewed task counts in shipped only,
#   - every window day is present, zero days included,
#   - one category per send-back, and the categories sum to the send-backs,
#   - a send-back with no preserved finding is "other", never a guess,
#   - NEGATIVE CONTROL: a finding that carries a task title and an ident comes
#     out ONLY as its category — neither string is anywhere in the file.
# Run (from a 5dive tree with src/cmd_proof.sh): bash tests/proof_review_unit.sh
set -uo pipefail
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
cd "$(dirname "$0")/.."

SRC=src/cmd_proof.sh
[[ -f "$SRC" ]] || SRC=../plugins/devteam/core/cmd_proof.sh   # run in place from the plugins repo
TMP="$(mktemp -d /tmp/proof-review.XXXXXX)"
awk "/python3 <<'REVIEWPY'/{f=1;next} f&&/^REVIEWPY\$/{f=0} f" "$SRC" > "$TMP/review.py"
[[ -s "$TMP/review.py" ]] || { echo "FAIL - could not extract the REVIEWPY block from $SRC"; exit 1; }

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

DB="$TMP/tasks.db"
python3 - "$DB" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE lifecycle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  kind TEXT NOT NULL, ident TEXT, actor TEXT NOT NULL DEFAULT 'x', idem_key TEXT, detail TEXT);
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, ident TEXT, title TEXT, body TEXT, result TEXT);
""")
ev = lambda ts, kind, ident, detail=None: db.execute(
    "INSERT INTO lifecycle_events (ts, kind, ident, detail) VALUES (?,?,?,?)", (ts, kind, ident, detail))
task = lambda ident, title, body="", result="": db.execute(
    "INSERT INTO tasks (ident, title, body, result) VALUES (?,?,?,?)", (ident, title, body, result))
REJ = "rejected by quinn at iteration {}/2, bounced back to maker dev; prior_result=superseded"
# A: reviewed, passed first time, shipped 11-01
ev("2026-11-01 10:00:00", "task.graded", "FX-1", "verdict=pass"); ev("2026-11-01 11:00:00", "task.done", "FX-1")
task("FX-1", "Alpha")
# B: sent back twice (tests, then a finding that carries a title + ident), shipped 11-02
ev("2026-11-02 08:00:00", "task.rejected", "FX-2", REJ.format(1))
ev("2026-11-02 09:00:00", "task.rejected", "FX-2", REJ.format(2))
ev("2026-11-02 10:00:00", "task.graded", "FX-2", "verdict=pass"); ev("2026-11-02 12:00:00", "task.done", "FX-2")
task("FX-2", "Zebra Moonshot Pricing",
     body="ASK: x\n❌ quinn rejected (iteration 1): FINDING: the harness exits 1, tests fail. FIX: y\n"
          "❌ quinn rejected (iteration 2): FINDING: the page leaks the row title 'Zebra Moonshot Pricing' and DIVE-9999 to the public file. FIX: z\n")
# C: merge conflict after a PASS only -> first try, NOT a send-back; shipped 11-02
ev("2026-11-02 07:00:00", "task.graded", "FX-3", "verdict=pass")
ev("2026-11-02 07:30:00", "task.rejected", "FX-3", "rejected by quinn at iteration 1/2, bounced back to maker dev for a merge conflict after a PASS (not counted toward the cap)")
ev("2026-11-02 08:30:00", "task.done", "FX-3"); task("FX-3", "Gamma")
# D: never reviewed (small change) -> shipped only
ev("2026-11-03 09:00:00", "task.done", "FX-4"); task("FX-4", "Delta")
# E: sent back, but no preserved finding on the row -> "other"
ev("2026-11-03 10:00:00", "task.rejected", "FX-5", REJ.format(1))
ev("2026-11-03 11:00:00", "task.done", "FX-5"); task("FX-5", "Echo")
# F: done twice; the LAST done (11-05) is the day it counts on
ev("2026-10-20 09:00:00", "task.graded", "FX-6", "verdict=pass"); ev("2026-10-20 10:00:00", "task.done", "FX-6")
ev("2026-11-05 10:00:00", "task.done", "FX-6"); task("FX-6", "Foxtrot")
# G: done on the publish date itself -> outside the window
ev("2026-11-07 01:00:00", "task.graded", "FX-7", "verdict=pass"); ev("2026-11-07 01:30:00", "task.done", "FX-7")
task("FX-7", "Golf")
# H: done before the window -> outside
ev("2026-10-01 09:00:00", "task.graded", "FX-8", "verdict=pass"); ev("2026-10-01 10:00:00", "task.done", "FX-8")
task("FX-8", "Hotel")
db.commit()
PY

W="$TMP/w"; mkdir -p "$W"
( cd "$W" && REVIEW_DB="$DB" TODAY=2026-11-07 NOW_ISO=2026-11-07T02:00:00Z WINDOW_DAYS=30 \
    METHODOLOGY_URL=https://example.test/m python3 "$TMP/review.py" ); RC=$?
[[ $RC -eq 0 && -f "$W/verifier.json" ]] && ok_t "builder exits 0 and writes verifier.json" \
  || { bad_t "builder run" "rc=$RC"; exit 1; }

check() { # <label> <python expr over d, true = pass>
  if python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if ($2) else 1)" "$W/verifier.json"; then
    ok_t "$1"; else bad_t "$1" "expr: $2"; fi
}
check "window is the 30 whole days before the publish date" \
  "d['window']['from']=='2026-10-08' and d['window']['to']=='2026-11-06' and len(d['days'])==30"
check "zero days are present (bad and empty days included)" \
  "[x['date'] for x in d['days']][0]=='2026-10-08' and all(x['reviewed']==0 for x in d['days'] if x['date']=='2026-11-04')"
check "shipped counts every task done in the window, reviewed or not (A,B,C,D,E,F = 6)" "d['totals']['shipped']==6"
check "reviewed = graded or rejected (A,B,C,E,F = 5; D unreviewed)" "d['totals']['reviewed']==5"
check "merge conflict after a PASS is not a send-back (C is first try)" \
  "d['totals']['firstTry']==3 and d['totals']['sentBack']==2"
check "send-backs count each real bounce (B twice, E once = 3)" "d['totals']['sendBacks']==3"
check "a task counts once, on its LAST done day (F on 11-05, not 10-20)" \
  "[x for x in d['days'] if x['date']=='2026-11-05'][0]['firstTry']==1 and [x for x in d['days'] if x['date']=='2026-10-20'][0]['reviewed']==0"
check "per-day split: 11-02 has B sent back and C first try" \
  "[x for x in d['days'] if x['date']=='2026-11-02'][0]=={'date':'2026-11-02','reviewed':2,'firstTry':1,'sentBack':1}"
check "daily rows sum to the totals" \
  "sum(x['reviewed'] for x in d['days'])==d['totals']['reviewed'] and sum(x['sentBack'] for x in d['days'])==d['totals']['sentBack']"
check "category counts sum to the send-backs" \
  "sum(c['count'] for c in d['reasons']['categories'])==d['totals']['sendBacks']==d['reasons']['total']"
check "classified by rule: B1 tests, B2 safety, E (no finding) other" \
  "{c['key']:c['count'] for c in d['reasons']['categories']}=={'conflict':0,'safety':1,'writing':0,'tests':1,'proof':0,'ask':0,'other':1}"

# NEGATIVE CONTROL: the title and the ident inside B's finding must not travel.
for needle in "Zebra" "Moonshot" "DIVE-" "FX-" "FINDING:" "harness exits"; do
  if grep -qF -- "$needle" "$W/verifier.json"; then bad_t "no '$needle' in the published file" "$(grep -nF -- "$needle" "$W/verifier.json" | head -2)"
  else ok_t "no '$needle' in the published file"; fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
