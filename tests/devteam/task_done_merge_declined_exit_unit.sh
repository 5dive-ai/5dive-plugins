#!/usr/bin/env bash
# DIVE-7779 — A PRIMARY CLOSED UNMERGED ON PURPOSE HAS AN EXIT.
#
# Measured on DIVE-7754 (2026-11-05): its PR was closed unmerged because the work
# missed its bar, `task merge-declined` was recorded against it and the close was
# approved, and still no seat could close the row. `unbind-pr` refuses a primary,
# the done gate never read the decline, re-pointing only moved the refusal to
# done-before-pr-merged (state=CLOSED), `--force-merge-gate` does not reach that
# branch, and an empty delivery_ref fell back to the body's `Branch:` line.
#
# THE EXIT: a decline recorded against the CURRENT binding + `--no-pr` + the PR
# MEASURED CLOSED. Then the binding, its iteration and the `Branch:` line are not
# checked. The arms below prove the exit (X1) and that it did not make the gate
# weaker anywhere else (N1-N7), and two mutation arms (M1, M2) revert one piece of
# the change each and must go RED.
#
# Run through the runner, which grades a CLI tree:
#   bash tests/devteam_core_harnesses.sh --core=<5dive checkout> task_done_merge_declined_exit_unit
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
export FIVE_GATE_NO_ANON=1
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=src
TMP="$(mktemp -d /tmp/dive7779.XXXXXX)"

# --- a gh that answers from env fixtures -------------------------------------
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf 'ARGS=%s\n' "$*" >>"$GH_ARGS_LOG"
if [[ "$1" == "auth" && "$2" == "token" ]]; then printf 'tok\n'; exit 0; fi
a=("$@"); expr='.'; i=0; json_fields=""
while [[ $i -lt ${#a[@]} ]]; do
  case "${a[$i]}" in
    -q|--jq)  expr="${a[$((i+1))]}"; i=$((i+2)) ;;
    --json)   json_fields="${a[$((i+1))]}"; i=$((i+2)) ;;
    *)        i=$((i+1)) ;;
  esac
done
key() { printf '%s' "${1//[^A-Za-z0-9]/_}"; }
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  fx="GH_STUB_PR_$(key "$3")"; v="${!fx:-}"
  [[ -n "$v" ]] || exit 1
  # STATE|MERGEDAT|HEAD
  IFS='|' read -r st ma hd <<<"$v"
  printf '{"state":"%s","mergedAt":%s,"headRefName":"%s"}' "$st" \
    "$( [[ -n "$ma" ]] && printf '"%s"' "$ma" || printf 'null' )" "$hd" | jq -r "$expr"; exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then printf '[]' | jq -r "$expr" 2>/dev/null; exit 0; fi
if [[ "$1" == "api" ]]; then
  case "$2" in
    */commits\?*) printf '[{"commit":{"message":"chore: unrelated"}}]' | jq -r "$expr" 2>/dev/null; exit 0 ;;
  esac
  exit 1
fi
exit 0
STUB
chmod +x "$TMP/bin/gh"
printf '#!/usr/bin/env bash\nexit 1\n' > "$TMP/bin/sudo"; chmod +x "$TMP/bin/sudo"
export PATH="$TMP/bin:$PATH"
export GH_ARGS_LOG="$TMP/gh.args"; : >"$GH_ARGS_LOG"

load_tree() { # <status.sh to use> — source the tree, with one status.sh swapped in
  for f in header.sh lib/error_codes.sh lib/output.sh lib/validation.sh \
           lib/agent_setup.sh lib/state.sh lib/broker.sh lib/audit.sh lib/gh_config.sh \
           lib/registry.sh lib/tasks_db.sh lib/actor.sh cmd_push.sh \
           cmd_task.sh; do
    # shellcheck source=/dev/null
    source "$SRC/$f"
  done
  # shellcheck source=/dev/null
  source "$1"
  STATE_DIR="$TMP"; TASKS_DIR="$STATE_DIR/tasks"; TASKS_DB="$TASKS_DIR/tasks.db"
  JSON_MODE=0; mkdir -p "$TASKS_DIR"; set +e
  tasks_db_init
  task_need_notify() { :; }
  _task_close_notify() { :; }
  audit_log() { :; }
  _task_store_audit_log() { printf '%s\n' "$*" >>"$AUDIT_CALLS"; return 0; }
}
AUDIT_CALLS="$TMP/audit.calls"; : >"$AUDIT_CALLS"
export GH_STUB_AUTH_TOKEN="tok"
export FIVE_GATE_REPOS="5dive-ai/5dive-browser"
load_tree "$SRC/task/status.sh"

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

PR="https://github.com/5dive-ai/5dive-browser/pull/135"
OTHER="https://github.com/5dive-ai/5dive-browser/pull/136"
PRK="GH_STUB_PR_${PR//[^A-Za-z0-9]/_}"
# The declined PR's head branch is named <ident>-show-proof, so the result-text
# branch scan (which extracts <ident>-<slug>) really sees it: that is the shape of
# DIVE-7754, whose result names dive-7754-show-proof.
hd()  { printf '%s-show-proof' "$(printf '%s' "$1" | tr 'A-Z' 'a-z')"; }
res() { printf 'No code ships: PR #135 closed unmerged (missed the bar); branch %s kept for later.' "$(hd "$1")"; }
# The same result without a PR number: for arms that must not be caught by the
# cited-open-PR check instead of the one under test.
res_nopr() { printf 'No code ships: the PR closed unmerged (missed the bar); branch %s kept.' "$(hd "$1")"; }
pr_is() { export "$PRK=$1||$(hd "$2")"; }   # pr_is <STATE> <ident>

# seed <ident> <declined-ref or ''> [stale=1]
# The DIVE-7754 shape: bound PR, `Branch:` line in the body, the loop moved on
# past the binding's iteration, the decline recorded by ops.
seed() {
  local id="$1" dref="$2" stale="${3:-1}" bi=2
  [[ "$stale" == "1" ]] && bi=1
  db "DELETE FROM tasks WHERE ident='$id';
      INSERT INTO tasks (ident, title, body, status, created_by, assignee, delivery_ref,
                         iteration, delivery_ref_iteration,
                         merge_declined_at, merge_declined_by, merge_declined_ref, merge_declined_reason)
        VALUES ('$id','t',$(sqlq "Repo: 5dive-ai/5dive-browser
Branch: $(hd "$id")"),'in_progress','main','main',$(sqlq "$PR"), 2, $bi,
                $( [[ -n "$dref" ]] && printf "datetime('now'),'ops',%s,'missed the bar'" "$(sqlq "$dref")" || printf 'NULL,NULL,NULL,NULL' ));"
}
statusof() { db "SELECT status FROM tasks WHERE ident='$1';"; }
run_done() { : >"$AUDIT_CALLS"; OUT=$(cmd_task_done "$@" 2>&1); RC=$?; }

# ── X1. the DIVE-7754 shape closes ────────────────────────────────────────────
pr_is CLOSED MDX-1
seed MDX-1 "$PR"
run_done MDX-1 --no-pr --result="$(res MDX-1)"
[[ $RC -eq 0 && "$(statusof MDX-1)" == "done" ]] \
  && ok_t "X1 CLOSED primary + decline on the current binding + --no-pr CLOSES (stale binding, Branch: line and a result naming the head branch all present)" \
  || bad_t "X1 the declined primary must close" "rc=$RC status=$(statusof MDX-1) out=${OUT:0:600}"
grep -q 'task.done-merge-declined' "$AUDIT_CALLS" \
  && ok_t "X1b ...and it is AUDITED as task.done-merge-declined, naming the ref" \
  || bad_t "X1b audit row" "$(cat "$AUDIT_CALLS")"
grep -q 'force-merge-gate' "$AUDIT_CALLS" \
  && bad_t "X1c must not record as a bypassed safety check" "$(cat "$AUDIT_CALLS")" \
  || ok_t "X1c ...and NOT as task.force-merge-gate"
[[ "$OUT" == *"DIVE-7779"* && "$OUT" == *"DECLINED"* ]] \
  && ok_t "X1d the closer is told why the binding was not checked" \
  || bad_t "X1d warning" "${OUT:0:400}"
grep -q -- "--head $(hd MDX-1)" "$GH_ARGS_LOG" \
  && bad_t "X1e the declined head must not be checked for a landing" "$(grep -- '--head' "$GH_ARGS_LOG")" \
  || ok_t "X1e ...and the declined head branch was never queried for a landing"

# ── N1. the same row WITHOUT a decline still refuses ─────────────────────────
seed MDX-2 "" 0
run_done MDX-2 --no-pr --result="$(res MDX-2)"
[[ $RC -ne 0 && "$(statusof MDX-2)" != "done" && "$OUT" == *"state=CLOSED"* ]] \
  && ok_t "N1 no decline recorded: still REFUSES done-before-pr-merged (state=CLOSED)" \
  || bad_t "N1 no decline must refuse" "rc=$RC status=$(statusof MDX-2) out=${OUT:0:400}"
seed MDX-21 "" 1
run_done MDX-21 --no-pr --result="$(res MDX-21)"
[[ $RC -ne 0 && "$(statusof MDX-21)" != "done" ]] \
  && ok_t "N1b ...and with the stale binding, still refuses (stale-binding check untouched)" \
  || bad_t "N1b" "rc=$RC out=${OUT:0:300}"

# ── N2. an OPEN primary with a decline still refuses ─────────────────────────
pr_is OPEN MDX-3
seed MDX-3 "$PR" 0
run_done MDX-3 --no-pr --result="$(res_nopr MDX-3)"
[[ $RC -ne 0 && "$(statusof MDX-3)" != "done" && "$OUT" == *"state=OPEN"* ]] \
  && ok_t "N2 OPEN primary + decline + --no-pr: still REFUSES (it can still merge)" \
  || bad_t "N2 OPEN must refuse" "rc=$RC status=$(statusof MDX-3) out=${OUT:0:400}"

# ── N3. without --no-pr the decline alone does not close ─────────────────────
pr_is CLOSED MDX-4
seed MDX-4 "$PR" 0
run_done MDX-4 --result="$(res MDX-4)"
[[ $RC -ne 0 && "$(statusof MDX-4)" != "done" ]] \
  && ok_t "N3 decline + CLOSED but NO --no-pr: still refuses (the closer must make the claim)" \
  || bad_t "N3 needs --no-pr" "rc=$RC out=${OUT:0:300}"

# ── N4. a decline of a DIFFERENT ref is not this binding's decline ───────────
pr_is CLOSED MDX-5
seed MDX-5 "$OTHER" 0
run_done MDX-5 --no-pr --result="$(res MDX-5)"
[[ $RC -ne 0 && "$(statusof MDX-5)" != "done" ]] \
  && ok_t "N4 decline recorded against another PR: still refuses" \
  || bad_t "N4 decline must match delivery_ref" "rc=$RC out=${OUT:0:300}"

# ── N5. state unreadable is not CLOSED ───────────────────────────────────────
unset "$PRK"
seed MDX-6 "$PR" 0
run_done MDX-6 --no-pr --result="$(res MDX-6)"
[[ $RC -ne 0 && "$(statusof MDX-6)" != "done" ]] \
  && ok_t "N5 decline + --no-pr but the PR state could not be read: still refuses" \
  || bad_t "N5 unread state must refuse" "rc=$RC out=${OUT:0:300}"

# ── N6. a DIFFERENT unlanded branch named in the result still refuses ─────────
pr_is CLOSED MDX-7
seed MDX-7 "$PR"
run_done MDX-7 --no-pr --result="$(res MDX-7) Also see MDX-7-other-work."
[[ $RC -ne 0 && "$(statusof MDX-7)" != "done" && "$OUT" == *"mdx-7-other-work"* ]] \
  && ok_t "N6 only the declined branch is dropped: another unlanded branch in the result still refuses" \
  || bad_t "N6 other branch must still be checked" "rc=$RC out=${OUT:0:400}"

# ── N7. a MERGED primary is unaffected (closes on the normal gate) ───────────
export "$PRK=MERGED|2026-11-05T10:00:00Z|$(hd MDX-8)"
seed MDX-8 "" 0
run_done MDX-8 --result="shipped"
grep -q 'task.done-merge-declined' "$AUDIT_CALLS" \
  && bad_t "N7 a merged close must not take the decline exit" "$(cat "$AUDIT_CALLS")" \
  || ok_t "N7 a MERGED primary does not take the decline exit (rc=$RC on the normal gate)"

# ── M. mutation arms: revert one piece, the property must go RED ─────────────
mut() { # <out> <perl-expr> -> number of changed lines
  cp "$SRC/task/status.sh" "$1"; perl -0pi -e "$2" "$1"; diff "$SRC/task/status.sh" "$1" | grep -c '^>'
}
# M1: the result-text scan no longer drops the declined head -> X1 must refuse,
# and the refusal must name that branch (not some other gate).
n=$(mut "$TMP/m1.sh" 's/if \[\[ -n "\$\{_md_skip:-\}" && -n "\$_br_cands" \]\]; then/if false; then/')
( source "$TMP/m1.sh"; set +e; pr_is CLOSED MDX-91; seed MDX-91 "$PR"
  OUT=$(cmd_task_done MDX-91 --no-pr --result="$(res MDX-91)" 2>&1); rc=$?
  [[ $rc -ne 0 && "$(statusof MDX-91)" != "done" && "$OUT" == *"$(hd MDX-91)"* ]] ) \
  && ok_t "M1 RED as expected: without the branch filter the X1 row refuses ($n line changed)" \
  || bad_t "M1 mutation must red" "changed=$n — the filter is not what X1 rests on"
# M2: the exit accepts any non-MERGED state -> N2 (OPEN) would close.
n=$(mut "$TMP/m2.sh" 's/if \[\[ "\$_md_state" == "CLOSED" \]\]; then/if [[ "\$_md_state" != "MERGED" ]]; then/')
( source "$TMP/m2.sh"; set +e; pr_is OPEN MDX-92; seed MDX-92 "$PR" 0
  OUT=$(cmd_task_done MDX-92 --no-pr --result="$(res_nopr MDX-92)" 2>&1)
  [[ "$(statusof MDX-92)" == "done" ]] ) \
  && ok_t "M2 RED as expected: without the CLOSED test an OPEN declined primary closes ($n line changed)" \
  || bad_t "M2 mutation must red" "changed=$n — N2 is not grading the CLOSED test"

printf -- '-----\n'
printf 'task_done_merge_declined_exit: %d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
exit 0
