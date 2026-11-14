#!/usr/bin/env bash
# DIVE-8435 — the merge verb reads the CI checks at the head itself, for a
# SEAT-graded row too, and merges nothing while any is pending or red.
#
# THE DEFECT. `_merge_do` ran its disposition probe for CI-graded rows only; a
# seat-graded row merged at once on the premise "its grader read CI already".
# On 2026-11-13, 4 of the 10 merges 5dive-bot made on lodar/5dive-api and
# lodar/5dive-frontend landed ~12 s after a quinn PASS over a PR check that was
# still running (api#756, fe#1186, fe#1187) or already red (fe#1180): three red
# mains in one day. Those repos are private and get no branch protection, so the
# merge verb is the only gate there is.
#
# WHAT IS EXECUTED HERE.
#   P*  `_merge_checks_decide` (pure) and `_MERGE_ROLLUP_JQ` over rollup fixtures.
#   G*  `_merge_do_checks_gate` over a stubbed `_gate_gh` — the refusal itself.
#   M*  the REAL `cmd_task_merge_do` body, run as a copy with only its root check
#       and the bot-credential path swapped (a harness is not root), over a real
#       seat-graded row: pending -> nothing merged, red -> nothing merged, both
#       name the check; green -> merges. `_merge_do_at_github` is stubbed to a
#       ledger, so "merged nothing" is a ledger that stayed empty, not a grep.
#   T*  the merge tick's read on a repo with NO required checks (gh errors on
#       `--required` there): it now reads the rollup instead of skipping forever.
. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
set -uo pipefail
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=src
TMP="$(mktemp -d /tmp/merge-do-checks-gate.XXXXXX)"
for f in header.sh lib/gh_config.sh lib/error_codes.sh lib/output.sh lib/validation.sh \
         lib/agent_setup.sh lib/state.sh lib/audit.sh lib/registry.sh \
         lib/tasks_db.sh lib/actor.sh cmd_task.sh cmd_org.sh cmd_agent.sh \
         cmd_heartbeat.sh; do
  # shellcheck source=/dev/null
  source "$SRC/$f"
done
mkdir -p "$TMP/bin" "$TMP/home"; export PATH="$TMP/bin:$PATH" HOME="$TMP/home"
# shellcheck source=tests/lib/isolate_read_tokens.sh
. tests/lib/isolate_read_tokens.sh
isolate_read_tokens "$TMP/bin" || exit 1
STATE_DIR="$TMP"; TASKS_DIR="$STATE_DIR/tasks"; TASKS_DB="$TASKS_DIR/tasks.db"
AUDIT_LOG="$TMP/audit.log"; JSON_MODE=1
mkdir -p "$TASKS_DIR"
export FIVEDIVE_PROD_TASKS_DB="$TASKS_DB"
set +e
PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }
tasks_db_init

SHA=34649c103056bc082d2d13c6692fa733fcc0ae07
OTHER=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CR() { printf '{"__typename":"CheckRun","name":"%s","status":"%s","conclusion":"%s","startedAt":"%s"}' "$1" "$2" "$3" "${4:-2026-11-13T05:00:00Z}"; }
SC() { printf '{"__typename":"StatusContext","context":"%s","state":"%s","startedAt":"%s"}' "$1" "$2" "${3:-2026-11-13T05:00:00Z}"; }
roll() { local IFS=,; printf '{"headRefOid":"%s","statusCheckRollup":[%s]}' "$1" "${*:2}"; }
buckets() { jq -c "$_MERGE_ROLLUP_JQ" <<<"$1"; }

# --- P: the classification ----------------------------------------------------
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR src-tests COMPLETED SUCCESS)" "$(CR lint COMPLETED SKIPPED)" "$(CR docs COMPLETED NEUTRAL)")")")
[[ "$d" == green ]] && ok_t "P1 success + skipped + neutral is green" || bad_t "P1" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR src-tests IN_PROGRESS '')" "$(CR lint COMPLETED SUCCESS)")")")
[[ "$d" == "pending:src-tests" ]] && ok_t "P2 a running check is pending and named (api#756's shape)" || bad_t "P2" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR app-tests QUEUED '')")")")
[[ "$d" == "pending:app-tests" ]] && ok_t "P3 a queued check is pending" || bad_t "P3" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR app-tests COMPLETED FAILURE)" "$(CR lint COMPLETED SUCCESS)")")")
[[ "$d" == "red:app-tests" ]] && ok_t "P4 a failed check is red and named (fe#1180's shape)" || bad_t "P4" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR a COMPLETED FAILURE)" "$(CR b IN_PROGRESS '')")")")
[[ "$d" == "red:a" ]] && ok_t "P5 red outranks pending (waiting cannot make it mergeable)" || bad_t "P5" "$d"
for c in CANCELLED TIMED_OUT ACTION_REQUIRED STARTUP_FAILURE STALE; do
  d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR t COMPLETED "$c")")")")
  [[ "$d" == "red:t" ]] && ok_t "P6 conclusion $c is not green" || bad_t "P6 $c" "$d"
done
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(SC vercel PENDING)")")")
[[ "$d" == "pending:vercel" ]] && ok_t "P7 a pending status context is pending" || bad_t "P7" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(SC ci/legacy ERROR)")")")
[[ "$d" == "red:ci/legacy" ]] && ok_t "P8 an errored status context is red" || bad_t "P8" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR t COMPLETED FAILURE 2026-11-13T05:00:00Z)" "$(CR t COMPLETED SUCCESS 2026-11-13T05:10:00Z)")")")
[[ "$d" == green ]] && ok_t "P9 a re-run that went green is read at its latest run" || bad_t "P9" "$d"
d=$(_merge_checks_decide "$(buckets "$(roll "$SHA" "$(CR t COMPLETED SUCCESS 2026-11-13T05:00:00Z)" "$(CR t IN_PROGRESS '' 2026-11-13T05:10:00Z)")")")
[[ "$d" == "pending:t" ]] && ok_t "P10 an older green does not answer for a re-run still going" || bad_t "P10" "$d"
d=$(_merge_checks_decide '[]')
[[ "$d" == green ]] && ok_t "P11 a head with no checks at all is green (nothing to read)" || bad_t "P11" "$d"
d=$(_merge_checks_decide 'not json'); d2=$(_merge_checks_decide '')
[[ "$d" == unreadable && "$d2" == unreadable ]] && ok_t "P12 an unparseable or empty read is unreadable, never green" || bad_t "P12" "$d / $d2"

# --- G: the gate over a stubbed read -------------------------------------------
VIEWS="$TMP/views"; mkdir -p "$VIEWS"
CALLS="$TMP/calls"; : >"$CALLS"
_gate_gh_token() { printf ''; }
_gate_gh() {   # <tok> <secs> pr view|checks <url> ...
  local n="${5##*/}"
  printf '%s %s\n' "$4" "$n" >>"$CALLS"
  case "$4" in
    view)
      if [[ "$*" == *statusCheckRollup* ]]; then cat "$VIEWS/$n.roll" 2>/dev/null
      else cat "$VIEWS/$n.view" 2>/dev/null; fi ;;
    checks) [[ -f "$VIEWS/$n.req" ]] && cat "$VIEWS/$n.req" || return 1 ;;
  esac
}
API=https://github.com/lodar/5dive-api/pull
roll "$SHA" "$(CR src-tests IN_PROGRESS '')" "$(CR lint COMPLETED SUCCESS)" >"$VIEWS/756.roll"
roll "$SHA" "$(CR app-tests COMPLETED FAILURE)"                            >"$VIEWS/1180.roll"
roll "$SHA" "$(CR src-tests COMPLETED SUCCESS)" "$(CR lint COMPLETED SKIPPED)" >"$VIEWS/759.roll"
roll "$OTHER" "$(CR src-tests COMPLETED SUCCESS)"                          >"$VIEWS/770.roll"
: >"$VIEWS/771.roll"
roll "$OTHER" "$(CR plugin-tests COMPLETED FAILURE)"                       >"$VIEWS/772.roll"

out=$(_merge_do_checks_gate DIVE-8333 "$API/756" "$SHA"); rc=$?
[[ $rc -ne 0 && "$out" == *"NOTHING MERGED"* && "$out" == *src-tests* && "$out" == *"still running"* && "$out" == *"NOT bounced"* ]] \
  && ok_t "G1 pending: refused, names src-tests, says the row is parked not bounced" || bad_t "G1" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-8382 "$API/1180" "$SHA"); rc=$?
[[ $rc -ne 0 && "$out" == *"NOTHING MERGED"* && "$out" == *app-tests* && "$out" == *RED* ]] \
  && ok_t "G2 red: refused, names app-tests" || bad_t "G2" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-1 "$API/759" "$SHA"); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && ok_t "G3 green at the graded head passes, silently" || bad_t "G3" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-1 "$API/759" "${SHA:0:12}"); rc=$?
[[ $rc -eq 0 ]] && ok_t "G4 an abbreviated graded sha still matches the head" || bad_t "G4" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-1 "$API/770" "$SHA"); rc=$?
[[ $rc -ne 0 && "$out" == *"not the graded sha"* ]] && ok_t "G5 a moved head is refused even when its own checks are green" || bad_t "G5" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-1 "$API/771" "$SHA"); rc=$?
[[ $rc -ne 0 && "$out" == *"could not be read"* ]] && ok_t "G6 an unreadable rollup refuses (fails closed)" || bad_t "G6" "rc=$rc $out"
out=$(_merge_do_checks_gate DIVE-1 "$API/759" "$SHA" "$API/772"); rc=$?
[[ $rc -ne 0 && "$out" == *"$API/772"* && "$out" == *plugin-tests* ]] \
  && ok_t "G7 a red COMPANION refuses (read at its own head), named" || bad_t "G7" "rc=$rc $out"

# --- M: the real _merge_do body over a seat-graded row ---------------------------
mk_row() {   # <pr-url> -> ident ; graded PASS by a SEAT, at $SHA
  local id
  id=$(db "INSERT INTO tasks (title, priority, assignee, created_by, kind, status,
                         maker_agent, verifier, graded_by, graded_verdict, graded_at, graded_verdict_at,
                         handoff_delivered_at, iteration, max_iterations, delivery_ref, result)
      VALUES ('graded row', 'high', 'fixture-grader', 'main', 'standard', 'todo',
              'fixture-maker', 'fixture-grader', 'fixture-grader', 'pass', datetime('now','-1 hours'), datetime('now','-1 hours'),
              datetime('now','-2 hours'), 1, 3, $(sqlq "$1"), 'PASS at head.
graded-sha: $SHA');
      SELECT last_insert_rowid();")
  db "SELECT ident FROM tasks WHERE id=$id;"
}
LEDGER="$TMP/merged"; : >"$LEDGER"
BOT="$TMP/github-bot.env"; printf 'GH_BOT_TOKEN=fixture-bot\n' >"$BOT"
_gate_uid_to_agent() { printf 'fixture-grader'; }
_merge_landed_read() { return 1; }
_merge_do_at_github() { printf '%s|%s|%s\n' "$1" "$2" "$6" >>"$LEDGER"; printf '_merge_do: disposition=merged\n' >&2; return 0; }
# The real body, with the two things a harness cannot be swapped: root, and the
# root-owned credential path. Nothing else is edited — a mutation anywhere else
# in the function is graded by the arms below.
body=$(declare -f cmd_task_merge_do)
[[ "$body" == *'[[ $EUID -eq 0 ]]'* ]] || bad_t "M0 the root check is where this harness expects it" "shape changed"
body="${body//'[[ $EUID -eq 0 ]]'/'[[ 0 -eq 0 ]]'}"
body="${body//'$_GH_BOT_ENV'/'$_T_BOT_ENV'}"
body="${body//'"$_GH_BOT_ENV"'/'"$_T_BOT_ENV"'}"
body="${body/cmd_task_merge_do/_t_merge_do}"
eval "$body"
_T_BOT_ENV="$BOT"
run_mdo() { printf '%s\0' "$1" | SUDO_UID=4242 _t_merge_do 2>&1; }

for case_ in "756:pending:src-tests" "1180:red:app-tests"; do
  n="${case_%%:*}"; rest="${case_#*:}"; kind="${rest%%:*}"; chk="${rest#*:}"
  ident=$(mk_row "$API/$n"); : >"$LEDGER"
  before=$(db "SELECT status||'|'||COALESCE(graded_verdict,'')||'|'||COALESCE(handoff_rejected_at,'-')||'|'||COALESCE(iteration,0) FROM tasks WHERE ident=$(sqlq "$ident");")
  out=$( (run_mdo "$ident") ); rc=$?
  after=$(db "SELECT status||'|'||COALESCE(graded_verdict,'')||'|'||COALESCE(handoff_rejected_at,'-')||'|'||COALESCE(iteration,0) FROM tasks WHERE ident=$(sqlq "$ident");")
  [[ $rc -ne 0 && ! -s "$LEDGER" && "$out" == *"$chk"* && "$out" == *"NOTHING MERGED"* ]] \
    && ok_t "M1 $kind check at a seat-graded head: _merge_do merges NOTHING and names $chk" \
    || bad_t "M1 $kind" "rc=$rc ledger=$(cat "$LEDGER") out=$out"
  [[ "$before" == "$after" ]] && ok_t "M2 $kind: the row is not bounced (grade, status, iteration untouched)" \
    || bad_t "M2 $kind" "$before -> $after"
done
ident=$(mk_row "$API/759"); : >"$LEDGER"
out=$( (run_mdo "$ident") ); rc=$?
[[ $rc -eq 0 && "$(cat "$LEDGER")" == "$ident|$API/759|$SHA" ]] \
  && ok_t "M3 a green head on a seat-graded row still merges, pinned to the graded sha" \
  || bad_t "M3" "rc=$rc ledger=$(cat "$LEDGER") out=$out"
# The landed short-circuit stays AHEAD of the gate: a PR the maintainer already
# merged (over a red check, even) records its landing, it is not refused here.
ident=$(mk_row "$API/1180"); : >"$LEDGER"
_merge_landed_read() { printf '%s|%s\n' "$SHA" 2026-11-13T12:45:52Z; }
out=$( (run_mdo "$ident") ); rc=$?
[[ $rc -eq 0 && ! -s "$LEDGER" && "$out" == *already-merged* ]] \
  && ok_t "M4 an already-merged PR is recorded, not refused by the checks gate (DIVE-549 stays fixed)" \
  || bad_t "M4" "rc=$rc out=$out"
_merge_landed_read() { return 1; }

# --- T: the merge tick on a repo with no required checks -------------------------
US=$'\x1f'
view() { printf '%s%s%s%s%s%shttps://github.com/lodar/5dive-api/pull/%s%sOPEN%s%s%s%s' \
           MERGEABLE "$US" "$2" "$US" "$SHA" "$US" "$1" "$US" "$US" "fix(api): x" "$US" "src/routes/x.ts" >"$VIEWS/$1.view"; }
view 756 UNSTABLE; view 759 CLEAN; view 1180 UNSTABLE
rec=$(_merge_tick_read "$API/759"); rc=$?
IFS=$'\x1f' read -r _ _ _ _ _ _ red pending _ <<<"$rec"
[[ $rc -eq 0 && -z "$red" && "$pending" == 0 ]] \
  && ok_t "T1 no required checks (gh errors on --required): the tick reads the rollup, green" \
  || bad_t "T1" "rc=$rc red=$red pending=$pending"
rec=$(_merge_tick_read "$API/756"); IFS=$'\x1f' read -r _ _ _ _ _ _ red pending _ <<<"$rec"
[[ "$pending" == 1 && -z "$red" ]] && ok_t "T2 ...a running check reads pending (the tick waits)" || bad_t "T2" "red=$red pending=$pending"
rec=$(_merge_tick_read "$API/1180"); IFS=$'\x1f' read -r _ _ _ _ _ _ red pending _ <<<"$rec"
[[ "$red" == app-tests ]] && ok_t "T3 ...a failed check reads red, named (the tick bounces it to the maker)" || bad_t "T3" "red=$red"
printf '[{"name":"req","bucket":"pass"}]' >"$VIEWS/759.req"
: >"$CALLS"; rec=$(_merge_tick_read "$API/759"); IFS=$'\x1f' read -r _ _ _ _ _ _ red pending _ <<<"$rec"
[[ -z "$red" && "$pending" == 0 && "$(grep -c '^view 759$' "$CALLS")" == 1 ]] \
  && ok_t "T4 a repo WITH required checks keeps the required read and makes no rollup read" \
  || bad_t "T4" "red=$red pending=$pending calls=$(tr '\n' ' ' <"$CALLS")"
rm -f "$VIEWS/759.req" "$VIEWS/759.roll"
_merge_tick_read "$API/759" >/dev/null; rc=$?
[[ $rc -ne 0 ]] && ok_t "T5 neither read answers: the tick's read fails (skip), never green" || bad_t "T5" "rc=$rc"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
