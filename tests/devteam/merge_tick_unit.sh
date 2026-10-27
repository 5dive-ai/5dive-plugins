#!/usr/bin/env bash
# DIVE-7120 — the MERGE TICK: a graded, green, clean pull request merges on the
# heartbeat with no seat turn, and a conflict or a red required check goes back
# to the MAKER, never to the merge seat.
#
# WHAT THIS GRADES. Section A drives the pure decider `_merge_tick_decide` from
# fixtures, one arm per rule. Section B runs the real `_merge_tick_sweep` on a
# throwaway tasks.db with the REAL `cmd_task_reject` and the real landing record;
# only the GitHub leaves are stubbed (`_gate_gh` for the reads, `_merge_do_at_github`
# for the merge, `_merge_landed_read`, `_merge_bot_token`). Section C reads the
# heartbeat's source for the one wiring fact a unit cannot execute: the tick runs
# before the forge poll.
#
# The rules, and the arm that grades each:
#   merge                           A1, B1
#   conflict -> maker               A2, B2
#   red required check -> maker     A3, B3
#   schema path never merges        A4, B4
#   pending gate never merges       A5, B5
#   only the tick may claim the merge-conflict bounce, not an env var   B8
#   task done on a graded->merge row points at merge-landed          D1, D2
#
# MUTANTS, driven by hand (the arms each killed; reproduce, don't trust):
#   M1  decide's gate-pending line deleted                  killed A5, A5b, B5, B6a
#   M2  decide's schema test made `if false`                killed A4, A4b, B4, B4a, B6a
#   M3  decide's red line deleted                           killed A3, B3
#   M4  reject's printenv guard deleted (core status.sh)    killed B8
#   M5  sweep merges with '' instead of the graded sha      killed B1a
#   M6  the --merge-conflict flag dropped from the bounce   killed B2b
#
# Run: bash tests/devteam_core_harnesses.sh --core=<5dive checkout> merge_tick_unit
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=src
TMP="$(mktemp -d /tmp/merge-tick.XXXXXX)"

# shellcheck disable=SC1090
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

STATE_DIR="$TMP"
TASKS_DIR="$STATE_DIR/tasks"
TASKS_DB="$TASKS_DIR/tasks.db"
AUDIT_LOG="$TMP/audit.log"
JSON_MODE=1
mkdir -p "$TASKS_DIR"
export FIVEDIVE_PROD_TASKS_DB="$TASKS_DB"
set +e
tasks_db_init

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

SHA=8a1b2c3d4e5f60718293a4b5c6d7e8f901234567
OTHER=1111111111111111111111111111111111111111
AT=2026-10-27T11:30:00Z
US=$'\x1f'

# --- section A: the pure decider ---------------------------------------------
# decide <repo> <title> <files> <mergeable> <state> <head> <graded> <prstate> <gate> <red> <pending> <seen>
dec() { _merge_tick_decide "$@"; }
G=(MERGEABLE CLEAN "$SHA" "$SHA" OPEN 0 "" 0 1)   # mergeable state head graded prstate gate red pending seen
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" "${G[@]}")
[[ "$d" == merge ]] && ok_t "A1 green, clean, graded head, allowlisted repo, no gate -> merge" || bad_t A1 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" CONFLICTING DIRTY "$SHA" "$SHA" OPEN 0 "" 0 1)
[[ "$d" == reject:conflict ]] && ok_t "A2 a conflicting branch -> reject:conflict (the maker's move)" || bad_t A2 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE DIRTY "$SHA" "$SHA" OPEN 0 "" 0 1)
[[ "$d" == reject:conflict ]] && ok_t "A2b DIRTY alone is a conflict too" || bad_t A2b "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE BLOCKED "$SHA" "$SHA" OPEN 0 "test,core-pristine (5)" 0 1)
[[ "$d" == "reject:red:test,core-pristine (5)" ]] && ok_t "A3 a red required check at the graded head -> reject naming the check" || bad_t A3 "$d"
d=$(dec lodar/5dive-api "fix(x): y" $'src/routes/a.ts\nsrc/lib/schema.ts' "${G[@]}")
[[ "$d" == skip:schema-path ]] && ok_t "A4 a 5dive-api PR touching src/lib/schema.ts NEVER merges, however green" || bad_t A4 "$d"
d=$(dec lodar/5dive-api "fix(x): y" $'drizzle/0042.sql' "${G[@]}")
[[ "$d" == skip:schema-path ]] && ok_t "A4b ...nor one carrying a migration" || bad_t A4b "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE CLEAN "$SHA" "$SHA" OPEN 1 "" 0 1)
[[ "$d" == skip:gate-pending ]] && ok_t "A5 a pending gate NEVER merges, however green" || bad_t A5 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" CONFLICTING DIRTY "$SHA" "$SHA" OPEN 1 "" 0 1)
[[ "$d" == skip:gate-pending ]] && ok_t "A5b ...and is not bounced either: the gate is a person's, the tick does not act over it" || bad_t A5b "$d"
d=$(dec someone/else "fix(x): y" "a.ts" "${G[@]}")
[[ "$d" == skip:repo-not-on-allowlist ]] && ok_t "A6 a repo off the allowlist is left to the merge seat" || bad_t A6 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE CLEAN "$OTHER" "$SHA" OPEN 0 "" 0 1)
[[ "$d" == skip:head-is-not-the-graded-sha ]] && ok_t "A7 a head that moved since the grade is not merged and not bounced" || bad_t A7 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE CLEAN "$SHA" "${SHA:0:8}" OPEN 0 "" 0 1)
[[ "$d" == merge ]] && ok_t "A7b ...an abbreviated graded sha still matches its head (prefix, as DIVE-2656)" || bad_t A7b "$d"
d=$(dec 5dive-ai/5dive "Pixel gets codex" "src/cmd_compose.sh" "${G[@]}")
[[ "$d" == skip:title-not-conventional ]] && ok_t "A8 5dive-ai/5dive with a non-conventional title is left (the nightly cut refuses it)" || bad_t A8 "$d"
d=$(dec 5dive-ai/5dive "fix(compose): pixel on codex" "src/cmd_compose.sh" "${G[@]}")
[[ "$d" == merge ]] && ok_t "A8b ...and merges with a conventional one" || bad_t A8b "$d"
d=$(dec lodar/5dive-api "fix(x): y" "src/routes/a.ts" MERGEABLE BLOCKED "$SHA" "$SHA" OPEN 0 "" 1 1)
[[ "$d" == skip:required-checks-pending ]] && ok_t "A9 required checks still running -> wait, next tick asks again" || bad_t A9 "$d"
d=$(dec lodar/5dive-frontend "fix(x): y" "app/page.tsx" MERGEABLE CLEAN "$SHA" "$SHA" OPEN 0 "" 0 0)
[[ "$d" == skip:user-facing-surface-unseen ]] && ok_t "A10 a page no grading seat looked at stays with the merge seat (a surface does not merge unseen)" || bad_t A10 "$d"
d=$(dec lodar/5dive-frontend "fix(x): y" "app/page.tsx" "${G[@]}")
[[ "$d" == merge ]] && ok_t "A10b ...and merges once its grader was a seat that looked" || bad_t A10b "$d"
d=$(dec lodar/5dive-api "fix(x): y" "a.ts" UNKNOWN UNKNOWN "$SHA" "$SHA" MERGED 0 "" 0 1)
[[ "$d" == merged ]] && ok_t "A11 already merged -> nothing here (the forge poll records it)" || bad_t A11 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "a.ts" UNKNOWN UNKNOWN "$SHA" "$SHA" OPEN 0 "" 0 1)
[[ "$d" == skip:mergeable-UNKNOWN ]] && ok_t "A12 mergeability still computing -> skip, never merge" || bad_t A12 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "a.ts" MERGEABLE BLOCKED "$SHA" "$SHA" OPEN 0 "" 0 1)
[[ "$d" == skip:merge-state-BLOCKED ]] && ok_t "A13 BLOCKED with nothing red or pending (a required review) -> skip" || bad_t A13 "$d"
d=$(dec 5dive-ai/5dive "fix(x): y" $'install.sh' "${G[@]}")
[[ "$d" == skip:codeowners-path ]] && ok_t "A14 install.sh / CODEOWNERS / workflows stay a person's look" || bad_t A14 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "a.ts" MERGEABLE CLEAN "$SHA" "" OPEN 0 "" 0 1)
[[ "$d" == skip:no-graded-sha ]] && ok_t "A15 no graded sha stated -> skip (there is nothing to pin the merge to)" || bad_t A15 "$d"
d=$(dec lodar/5dive-api "fix(x): y" "" "${G[@]}")
[[ "$d" == skip:file-list-unreadable ]] && ok_t "A16 an empty file list is unreadable, not empty -> skip" || bad_t A16 "$d"

# --- section B: the sweep, on a real store -----------------------------------
VIEWS="$TMP/views"; mkdir -p "$VIEWS"
MERGES="$TMP/merges"; : >"$MERGES"
HB_LOG="$TMP/hb.log"; : >"$HB_LOG"
_hb_log() { printf '%s\n' "$*" >>"$HB_LOG"; }
audit_log() { return 0; }
cmd_send() { return 0; }
_task_agent_channel() { return 1; }
_merge_tick_is_root() { return 0; }
_merge_bot_token() { printf 'bot-token'; }
_merge_landed_read() { printf '%s|%s\n' "$SHA" "$AT"; }
_merge_do_at_github() {   # <ident> <pr> <actor> <tok> <cfg> <graded>
  printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$6" >>"$MERGES"
  printf '%s merged by %s\n' "$2" "$3" >&2
  return 0
}
# The read stub: the pull request's number picks its fixture, and `pr view` and
# `pr checks` answer from different files, as GitHub does.
_gate_gh() {   # <tok> <secs> pr view|checks <url> ...
  local n="${5##*/}"
  case "$4" in
    view)   cat "$VIEWS/$n.view" 2>/dev/null ;;
    checks) cat "$VIEWS/$n.checks" 2>/dev/null ;;
  esac
}
fixture() {   # <n> <repo> <mergeable> <state> <head> <title> <files> <checks-json>
  printf '%s%s%s%s%s%shttps://github.com/%s/pull/%s%sOPEN%s%s%s%s' \
    "$3" "$US" "$4" "$US" "$5" "$US" "$2" "$1" "$US" "$US" "$6" "$US" "$7" >"$VIEWS/$1.view"
  printf '%s' "$8" >"$VIEWS/$1.checks"
}
GREEN='[{"name":"test","bucket":"pass"},{"name":"title","bucket":"pass"}]'
RED='[{"name":"test","bucket":"fail"},{"name":"title","bucket":"pass"}]'
mk_row() {   # <n> <repo> [need_type need_answered_at] -> id
  db "INSERT INTO tasks (title, priority, assignee, created_by, kind, status,
                         maker_agent, verifier, graded_by, graded_verdict, graded_at, graded_verdict_at,
                         handoff_delivered_at, iteration, max_iterations,
                         delivery_ref, merge_owner, result, need_type, need_answered_at)
      VALUES ('graded row $1', 'high', 'fixture-grader', 'main', 'standard', 'todo',
              'dev', 'fixture-grader', 'fixture-grader', 'pass', datetime('now','-1 hours'), datetime('now','-1 hours'),
              datetime('now','-2 hours'), 2, 3,
              'https://github.com/$2/pull/$1', 'ops',
              'PASS at head.
graded-sha: $SHA', $( [[ -n "${3:-}" ]] && printf "'%s'" "$3" || printf NULL ), $( [[ -n "${4:-}" ]] && printf "'%s'" "$4" || printf NULL ));
      SELECT last_insert_rowid();"
}
snap() { db "SELECT COALESCE(assignee,'-')||' '||status||' '||COALESCE(iteration,0)||' '||COALESCE(handoff_rejected_at,'-')||' '||COALESCE(merge_landed_by,'-')||' '||COALESCE(merge_owner,'-')||' '||length(COALESCE(result,'')) FROM tasks WHERE id=$1;"; }
in_tfv() { db "SELECT CASE WHEN (${_TASKS_TFV_SQL}) THEN 1 ELSE 0 END FROM tasks WHERE id=$1;"; }

fixture 901 lodar/5dive-api MERGEABLE CLEAN "$SHA" "fix(api): a" "src/routes/a.ts" "$GREEN"
fixture 902 lodar/5dive-api CONFLICTING DIRTY "$SHA" "fix(api): b" "src/routes/b.ts" "$GREEN"
fixture 903 lodar/5dive-api MERGEABLE BLOCKED "$SHA" "fix(api): c" "src/routes/c.ts" "$RED"
fixture 904 lodar/5dive-api MERGEABLE CLEAN "$SHA" "fix(api): d" $'src/routes/d.ts\nsrc/lib/schema.ts' "$GREEN"
fixture 905 lodar/5dive-api MERGEABLE CLEAN "$SHA" "fix(api): e" "src/routes/e.ts" "$GREEN"
id1=$(mk_row 901 lodar/5dive-api)
id2=$(mk_row 902 lodar/5dive-api)
id3=$(mk_row 903 lodar/5dive-api)
id4=$(mk_row 904 lodar/5dive-api)
id5=$(mk_row 905 lodar/5dive-api decision "")
for i in $id1 $id2 $id3 $id4 $id5; do [[ "$(in_tfv "$i")" == 1 ]] || bad_t "fixture row $i is not in graded->merge" ""; done
b4=$(snap "$id4"); b5=$(snap "$id5")

# B6 first: a dry run reads and decides and writes nothing.
before_all=$(db "SELECT group_concat(id||':'||status||':'||COALESCE(assignee,'')||':'||COALESCE(handoff_rejected_at,'')||':'||COALESCE(merge_landed_by,''),';') FROM tasks;")
dry=$(_merge_tick_sweep --dry-run)
after_all=$(db "SELECT group_concat(id||':'||status||':'||COALESCE(assignee,'')||':'||COALESCE(handoff_rejected_at,'')||':'||COALESCE(merge_landed_by,''),';') FROM tasks;")
[[ "$before_all" == "$after_all" && ! -s "$MERGES" ]] \
  && ok_t "B6 --dry-run writes nothing and merges nothing" || bad_t B6 "before=$before_all after=$after_all merges=$(cat "$MERGES")"
grep -qE $'\tmerge\t.*/pull/901$' <<<"$dry" && grep -qE $'\treject:conflict\t' <<<"$dry" \
  && grep -qE $'\tskip:schema-path\t' <<<"$dry" && grep -qE $'\tskip:gate-pending\t' <<<"$dry" \
  && ok_t "B6a ...and prints one decision per graded row" || bad_t B6a "$dry"

_merge_tick_sweep

# B1 — merge
[[ "$(grep -c '/pull/901|' "$MERGES")" == 1 ]] \
  && ok_t "B1 the green, clean row is MERGED, once, with no seat turn" || bad_t B1 "$(cat "$MERGES")"
grep -q "/pull/901|merge-tick|$SHA\$" "$MERGES" \
  && ok_t "B1a ...pinned to the graded sha, as the merge-tick actor" || bad_t B1a "$(cat "$MERGES")"
[[ "$(db "SELECT COALESCE(merge_landed_by,'') FROM tasks WHERE id=$id1;")" == merge-tick && "$(in_tfv "$id1")" == 0 ]] \
  && ok_t "B1b ...the landing is recorded and the row has LEFT graded->merge" || bad_t B1b "$(snap "$id1")"
[[ "$(db "SELECT status FROM tasks WHERE id=$id1;")" != done ]] \
  && ok_t "B1c ...and it is NOT closed: the close stays a seat's (DIVE-4520)" || bad_t B1c "$(snap "$id1")"

# B2 — conflict to the maker
read -r a2 s2 it2 rj2 _ <<<"$(snap "$id2")"
[[ "$a2" == dev && "$rj2" != - ]] \
  && ok_t "B2 the conflicting row is REJECTED to its maker (dev), not to the merge seat" || bad_t B2 "$(snap "$id2")"
[[ "$it2" == 2 ]] \
  && ok_t "B2a ...as a merge-conflict bounce that does not spend an iteration (DIVE-6753)" || bad_t B2a "iteration=$it2"
r2=$(db "SELECT result FROM tasks WHERE id=$id2;")
grep -q 'merge-tick rejected for a MERGE CONFLICT' <<<"$r2" && grep -q 'FINDING:' <<<"$r2" && grep -q 'FIX:' <<<"$r2" && grep -q 'VERIFY:' <<<"$r2" \
  && ok_t "B2b ...with FINDING / FIX / VERIFY, signed by the merge tick" || bad_t B2b "$(tail -3 <<<"$r2")"
! grep -q '/pull/902|' "$MERGES" && ok_t "B2c ...and nothing was merged" || bad_t B2c "$(cat "$MERGES")"

# B3 — red to the maker
read -r a3 s3 it3 rj3 _ <<<"$(snap "$id3")"
r3=$(db "SELECT result FROM tasks WHERE id=$id3;")
[[ "$a3" == dev && "$rj3" != - ]] && grep -q 'RED at that head: test' <<<"$r3" \
  && ok_t "B3 the red-check row is REJECTED to its maker, naming the red check" || bad_t B3 "$(snap "$id3") / $(tail -2 <<<"$r3")"
! grep -q '/pull/903|' "$MERGES" && ok_t "B3a ...and nothing was merged" || bad_t B3a "$(cat "$MERGES")"

# B4 / B5 — never
[[ "$(snap "$id4")" == "$b4" ]] && ! grep -q '/pull/904|' "$MERGES" \
  && ok_t "B4 the schema row is left exactly as it was: not merged, not bounced" || bad_t B4 "before=$b4 after=$(snap "$id4")"
[[ "$(snap "$id5")" == "$b5" ]] && ! grep -q '/pull/905|' "$MERGES" \
  && ok_t "B5 the row with a pending gate is left exactly as it was: not merged, not bounced" || bad_t B5 "before=$b5 after=$(snap "$id5")"
grep -q 'DIVE-.* left to the merge seat: schema-path' "$HB_LOG" \
  && ok_t "B4a ...and the tick log says why, once" || bad_t B4a "$(cat "$HB_LOG")"
n_before=$(grep -c 'schema-path' "$HB_LOG")
_merge_tick_sweep
[[ "$(grep -c 'schema-path' "$HB_LOG")" == "$n_before" ]] \
  && ok_t "B4b ...and not again on the next tick (a standing skip is not news)" || bad_t B4b "$(grep schema-path "$HB_LOG")"
[[ "$(grep -c '/pull/901|' "$MERGES")" == 1 ]] \
  && ok_t "B1d a second tick does not merge the landed row again" || bad_t B1d "$(cat "$MERGES")"

# B7 — the read failing is a skip
db "DELETE FROM tasks;"; : >"$MERGES"
fixture 906 lodar/5dive-api MERGEABLE CLEAN "$SHA" "fix(api): f" "a.ts" ""
id6=$(mk_row 906 lodar/5dive-api); b6=$(snap "$id6")
_merge_tick_sweep
[[ "$(snap "$id6")" == "$b6" && ! -s "$MERGES" ]] \
  && ok_t "B7 an unreadable required-checks answer is not green: nothing merged, nothing written" || bad_t B7 "$(snap "$id6")"

# B8 — the bounce's actor cannot be claimed from the environment
db "DELETE FROM tasks;"
id8=$(mk_row 908 lodar/5dive-api); b8=$(snap "$id8")
out8=$( export _TASK_MERGE_TICK_ACTOR=merge-tick
        cmd_task_reject "DIVE-$id8" --merge-conflict \
          --feedback="FINDING: x FIX: merge main VERIFY: mergeable" 2>&1 )
[[ "$(snap "$id8")" == "$b8" ]] && grep -q 'reject-merge-conflict-not-merger\|neither owe this merge' <<<"$out8" \
  && ok_t "B8 an EXPORTED _TASK_MERGE_TICK_ACTOR does not make a caller the merger: refused, nothing written" \
  || bad_t B8 "$(snap "$id8") / $(tail -2 <<<"$out8")"

# B9 — no maker to bounce to
db "DELETE FROM tasks;"
fixture 909 lodar/5dive-api CONFLICTING DIRTY "$SHA" "fix(api): g" "a.ts" "$GREEN"
id9=$(mk_row 909 lodar/5dive-api)
db "UPDATE tasks SET maker_agent=NULL, verifier=NULL, graded_by='dev' WHERE id=$id9;"
b9=$(snap "$id9")
_merge_tick_sweep
[[ "$(snap "$id9")" == "$b9" ]] && grep -q 'conflict-but-no-maker' "$HB_LOG" \
  && ok_t "B9 a conflicting row with no maker stays with the merge seat, and says why" || bad_t B9 "$(snap "$id9") / $(tail -2 "$HB_LOG")"

# --- section D: `task done` on a graded->merge row points at merge-landed ----
# main closed two hand-merged rows with `task done` (2026-10-27) instead of
# merge-landed. The refusal must name merge-landed FIRST, before any verb that
# re-delivers, and write nothing.
db "DELETE FROM tasks;"
idD=$(mk_row 960 lodar/5dive-api); db "UPDATE tasks SET assignee='dev' WHERE id=$idD;"
bD=$(snap "$idD")
outD=$( set +e; cmd_task_done "DIVE-$idD" --result="merged by hand at the graded sha" 2>&1 ); rcD=$?
msgD=$(grep -m1 -o 'is graded PASS and waiting on a MERGE.*' <<<"$outD")
pre_ml="${msgD%%task merge-landed DIVE-$idD*}"
(( rcD != 0 )) && [[ "$(snap "$idD")" == "$bD" ]] \
  && ok_t "D1 \`task done\` on a graded->merge row refuses and writes nothing (no re-delivery)" || bad_t D1 "rc=$rcD $(snap "$idD")"
[[ -n "$msgD" && "$pre_ml" != "$msgD" && "$pre_ml" != *force-redeliver* && "$pre_ml" != *"task merge DIVE-"* ]] \
  && ok_t "D2 ...and the first verb it names is \`task merge-landed DIVE-$idD\`, ahead of the re-delivering escape" \
  || bad_t D2 "$msgD"

# --- section C: the heartbeat wiring ----------------------------------------
hb="$SRC/cmd_heartbeat.sh"
l_tick=$(grep -n '^  _hb_merge_tick_sweep ||' "$hb" | head -1 | cut -d: -f1)
l_forge=$(grep -n '^  _hb_forge_merge_sweep ||' "$hb" | head -1 | cut -d: -f1)
[[ -n "$l_tick" && -n "$l_forge" ]] && (( l_tick < l_forge )) \
  && ok_t "C1 the heartbeat runs the merge tick, before the forge poll records landings" || bad_t C1 "tick=$l_tick forge=$l_forge"
called=0; _merge_tick_sweep() { called=1; }
_hb_merge_tick_sweep
[[ "$called" == 1 ]] && ok_t "C2 _hb_merge_tick_sweep calls the plugin's pass" || bad_t C2 ""
unset -f _merge_tick_sweep
_hb_merge_tick_sweep; rc=$?
[[ "$rc" == 0 ]] && ok_t "C3 ...and is a no-op on a box without the plugin" || bad_t C3 "rc=$rc"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
