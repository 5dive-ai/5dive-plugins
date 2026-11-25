#!/usr/bin/env bash
# TIER: core — DIVE-2681's title-word filing cap, as it runs from the devteam
# plugin (core/task/filing_cap.sh) since DIVE-9262.
#
# These arms are T11/T12 of 5dive's tests/task_verifier_rail_unit.sh, moved here
# unchanged when the cap left the core. The runner puts filing_cap.sh back into
# the core tree (tests/devteam_core_harnesses.sh), so cmd_task.sh reads it like
# the CLI's devteam loader would. The per-agent volume cap is held off with the
# plugin's own default (_task_agent_task_cap_default -> off) so these arms grade
# the ratio cap alone, as they did before.
set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
. "$(dirname "${BASH_SOURCE[0]}")/lib/actor_seam.sh"
SRC=src
TMP="$(mktemp -d /tmp/filing-ratio-cap-unit.XXXXXX)"

for f in header.sh lib/error_codes.sh lib/output.sh lib/validation.sh \
         lib/agent_setup.sh lib/state.sh lib/audit.sh lib/registry.sh \
         lib/tasks_db.sh lib/actor.sh cmd_task.sh cmd_org.sh cmd_project.sh; do
  source "$SRC/$f"
done
# A pre-DIVE-9262 core still defines the classifier in routing.sh and grades its own copy.
declare -F _task_internal_subject_reason >/dev/null 2>&1 || source "$SRC/task/filing_cap.sh"

STATE_DIR="$TMP"
fixture_box_verify_policy always || exit 1
TASKS_DIR="$STATE_DIR/tasks"
TASKS_DB="$TASKS_DIR/tasks.db"
mkdir -p "$TASKS_DIR"
set +e

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }
run()  { local verb="$1"; shift; ( JSON_MODE=1; "cmd_task_$verb" "$@" ) 2>"$TMP"/err; }
jf()   { jq -r "$1" 2>/dev/null; }
has()  { [[ "$1" == *"$2"* ]]; }

JSON_MODE=1
tasks_db_init
db "INSERT INTO agents_org (name, reports_to) VALUES ('boss',NULL),('alice','boss'),('carol','boss');"

# --- T11: THE FILING CAP (DIVE-2681) ----------------------------------------
# Folded into this harness rather than given its own file: it is a second reason
# the SAME rail declines, and it reaches the board through the SAME announced
# skip path T1 covers. A separate harness would re-pay this file's setup to
# assert against the same code (5dive-cli/CLAUDE.md: merge by subject).
#
# The window is fleet-wide over the last 20 standard rows, so these arms build
# their own ratio explicitly instead of inheriting whatever T1-T10 happened to
# leave behind — an assertion that depends on the arms above it is not an
# assertion, it is an ordering.
#
# THE CAP ONLY ENGAGES ON THE PRODUCTION BOARD (2026-08-09), so these arms must
# DECLARE this fixture store to be the board they are testing. Without this line
# every refusal arm below goes vacuously green: the cap would decline to enforce
# against a temp dir and T11d/T11e/T11h would pass because nothing ran, which is
# the "wrong and pleasant ⇒ no check ran" shape. T11m asserts the other side.
export FIVEDIVE_PROD_TASKS_DB="$TASKS_DB"
db "DELETE FROM tasks;"
for i in 1 2 3 4 5 6 7 8 9 10; do
  run add --assignee=alice --priority=medium -- "ship customer feature number ${i}" >/dev/null
done

# T11a: the classifier is a candidate set — assert it on a title, not a vibe.
# DIVE-3245's independent per-filer volume cap was added after these ratio-cap
# arms. Keep it out of this fixture so T11h/T11i continue grading the declared
# ratio-cap escapes instead of tripping a second policy at the same row count.
_task_agent_task_cap_default() { printf off; }
_TASK_FILING_DAILY_CAP=999   # a pre-DIVE-9262 core's constant volume cap, held off the same way
[[ -n "$(_task_internal_subject_reason 'the smoke-gate harness dies on pipefail')" \
   && -z "$(_task_internal_subject_reason 'web push on the dashboard PWA')" ]] \
  && ok_t "T11a classifier hits our own machinery and leaves a product title alone" \
  || bad_t "T11a classifier hits our own machinery and leaves a product title alone" \
           "internal='$(_task_internal_subject_reason 'the smoke-gate harness dies on pipefail')' product='$(_task_internal_subject_reason 'web push on the dashboard PWA')'"

# T11b: UNDER the cap, an internal row is accepted — and books NO grading pass.
# This is the half that moves tokens: the row used to cost a grading round-trip.
int_json=$(run add --assignee=alice --priority=medium -- "the release-cut harness is red")
int_id=$(printf '%s' "$int_json" | jf '.data.id')
[[ -n "$int_id" && "$int_id" != "null" \
   && "$(printf '%s' "$int_json" | jf '.data.verifySkipReason')" == "internal machinery" \
   && -z "$(db "SELECT COALESCE(verifier,'') FROM tasks WHERE id=${int_id};")" ]] \
  && ok_t "T11b an internal row under the cap is accepted and books NO verifier" \
  || bad_t "T11b an internal row under the cap is accepted and books NO verifier" "$int_json"

# T11c: an explicit --verifier still forces grading ON. The skip is a default,
# not a ceiling — same contract T3 asserts for the low-priority skip.
fv_json=$(run add --assignee=alice --priority=medium --verifier=boss -- "the CI job budget-report must be graded")
fv_id=$(printf '%s' "$fv_json" | jf '.data.id')
[[ "$(db "SELECT verifier FROM tasks WHERE id=${fv_id};")" == "boss" ]] \
  && ok_t "T11c --verifier forces grading ON for an internal row" \
  || bad_t "T11c --verifier forces grading ON for an internal row" "$fv_json"

# T11d: OVER the cap, the next internal row is REFUSED at the keystroke.
for i in 1 2 3 4 5; do
  run add --assignee=alice --priority=medium -- "worktree cleanup sweep ${i}" >/dev/null
done
over_out=$(run add --assignee=alice --priority=medium -- "another harness is flaky"); over_rc=$?
(( over_rc != 0 )) && has "$(cat "$TMP"/err)$over_out" "filing cap" \
  && ok_t "T11d over the cap, an internal row is REFUSED" \
  || bad_t "T11d over the cap, an internal row is REFUSED" "rc=$over_rc $over_out $(cat "$TMP"/err)"

# T11e: the refusal NAMES both escapes. A gate that refuses without naming the
# way through is the defect DIVE-1880 fixed one control over.
has "$(cat "$TMP"/err)$over_out" "--already-blocked" \
  && has "$(cat "$TMP"/err)$over_out" "--customer" \
  && ok_t "T11e the refusal names both declared escapes" \
  || bad_t "T11e the refusal names both declared escapes" "$(cat "$TMP"/err)"

# T11f: a CUSTOMER-facing row is never capped, however full the window is.
cust_json=$(run add --assignee=alice --priority=medium -- "dashboard billing page renders a stale plan")
cust_id=$(printf '%s' "$cust_json" | jf '.data.id')
[[ -n "$cust_id" && "$cust_id" != "null" ]] \
  && ok_t "T11f a customer-surface row is unaffected by a full window" \
  || bad_t "T11f a customer-surface row is unaffected by a full window" "$cust_json"

# T11g: --customer overrides a WRONG classification. The product row that named
# this arm is real: "Free OSS web UI: three views (org chart, queue, gates)" is a
# customer surface that matches the scan on two words.
fp_json=$(run add --assignee=alice --priority=medium --customer -- "free OSS web UI: org chart, queue and gates served by the CLI")
fp_id=$(printf '%s' "$fp_json" | jf '.data.id')
[[ -n "$fp_id" && "$fp_id" != "null" \
   && "$(db "SELECT verifier FROM tasks WHERE id=${fp_id};")" == "boss" ]] \
  && ok_t "T11g --customer clears a false positive AND restores its grading" \
  || bad_t "T11g --customer clears a false positive AND restores its grading" "$fp_json"

# T11h: --already-blocked lands the row over the cap AND records why on it.
# An exception that leaves no trace is an opt-out, not an exception.
ab_json=$(run add --assignee=alice --priority=medium --already-blocked="took task done down fleet-wide for 40m" -- "the merge gate harness is wrong")
ab_id=$(printf '%s' "$ab_json" | jf '.data.id')
[[ -n "$ab_id" && "$ab_id" != "null" ]] \
  && has "$(db "SELECT COALESCE(body,'') FROM tasks WHERE id=${ab_id};")" "took task done down fleet-wide" \
  && ok_t "T11h --already-blocked lands over the cap and records the reason in the body" \
  || bad_t "T11h --already-blocked lands over the cap and records the reason in the body" "$ab_json"

# T11i: the fleet kill-switch, so an incident is never gated by a filing rule.
kill_json=$(FIVE_FILING_CAP=0 run add --assignee=alice --priority=medium -- "yet another harness is flaky")
[[ "$(printf '%s' "$kill_json" | jf '.data.id')" != "null" \
   && -n "$(printf '%s' "$kill_json" | jf '.data.id')" ]] \
  && ok_t "T11i FIVE_FILING_CAP=0 disables the refusal fleet-wide" \
  || bad_t "T11i FIVE_FILING_CAP=0 disables the refusal fleet-wide" "$kill_json"

# T11o: HIGH AND URGENT ARE NEVER CAPPED. The window is over the cap right now,
# and T11d proved the identical shape is refused at medium — so these two arms
# change exactly one thing. A quota whose failure mode is eating a serious
# finding is worse than a quota that lets a few through, and the two directions
# do not cost the same.
_t11o_bad=""
for _p in high urgent; do
  _o=$(run add --assignee=alice --priority="$_p" -- "the merge gate harness is red and blocks the cut")
  _oid=$(printf '%s' "$_o" | jf '.data.id')
  [[ -z "$_oid" || "$_oid" == "null" ]] && _t11o_bad+="REFUSED AT ${_p}: ${_o} $(cat "$TMP"/err)"$'\n'
done
[[ -z "$_t11o_bad" ]] \
  && ok_t "T11o high and urgent are never capped, on a title that IS refused at medium" \
  || bad_t "T11o high and urgent are never capped, on a title that IS refused at medium" "$_t11o_bad"

# T11p: A REFUSAL LEAVES THE FINDING SOMEWHERE. The cap used to `fail` and that
# was the whole record — the refused TITLE existed nowhere afterwards, so a cap
# that ate a real finding was indistinguishable from one that never fired. The
# title must be recoverable from policy_refusals, not merely mentioned on a
# terminal that has already scrolled.
_t11p_title="the verifier rail drops a gate silently on every recurring row"
run add --assignee=alice --priority=medium -- "$_t11p_title" >/dev/null 2>&1
_t11p_rows=$(db "SELECT COUNT(*) FROM policy_refusals WHERE policy='filing-cap-internal-machinery';")
_t11p_kept=$(db "SELECT COUNT(*) FROM policy_refusals WHERE policy='filing-cap-internal-machinery' AND detail LIKE '%${_t11p_title}%';")
[[ "$_t11p_rows" -ge 1 && "$_t11p_kept" -ge 1 ]] \
  && ok_t "T11p a refused filing is recorded in policy_refusals WITH its title" \
  || bad_t "T11p a refused filing is recorded in policy_refusals WITH its title" "rows=$_t11p_rows kept=$_t11p_kept"

# T11q: and the refusal still names the priority escape, so the filer learns the
# way through at the moment they are stopped rather than from a doc.
has "$(cat "$TMP"/err)" "--priority=high" \
  && ok_t "T11q the refusal names the priority escape" \
  || bad_t "T11q the refusal names the priority escape" "$(cat "$TMP"/err)"

# T11j: THE ARITY REGRESSION (2026-08-09). The first cut keyed on multi-word
# phrases — "verifier rail", "merge gate", "task add" — while the rows the fleet
# actually files say the same thing in ONE word. Measured over 946 hand-filed
# rows: 15% flagged against a ~67% human read, so the window sat at 3/20 under a
# 5/20 threshold and the cap never fired once in the five days after it went
# live. Each title below was a real MISS. They are the arm, not an example.
# DIVE-6652 narrowed one of them: the bare "gate" is now a compound ("merge
# gate"), because on a customer box a bare gate is the customer's own (T11r).
_t11j_missed=(
  "the merge gate is unsatisfiable once a branch tip moves"
  "the verifier never picks the row back up"
  "PII guard scans no content on a direct push to main"
  "council verify --json double-reports on a RED verdict"
  "the delegated push rail refuses for agent-dev"
  "crontab snapshot wipe misses a PARTIAL loss"
  "unit tests are RED on main since this morning"
  "the nightly digest is dark again"
  "recurring row fires but nobody triages the instance"
  "smoke cannot grade a src/ change"
)
_t11j_bad=""
for _t in "${_t11j_missed[@]}"; do
  [[ -z "$(_task_internal_subject_reason "$_t")" ]] && _t11j_bad+="MISS: ${_t}"$'\n'
done
[[ -z "$_t11j_bad" ]] \
  && ok_t "T11j the widened scan catches the single-word machinery titles the narrow one missed" \
  || bad_t "T11j the widened scan catches the single-word machinery titles the narrow one missed" "$_t11j_bad"

# T11k: THE TWO WORDS THAT STAY OUT, and why they are a test and not a comment.
# "agent" appeared 97 times and "queue" throughout the missed set — and 5dive's
# PRODUCT is agent hosting, so neither token can tell our machinery from the
# thing we sell. Widening until the numbers look good would have swept both in
# and taxed every real product row. A deliberate exclusion needs an assertion or
# the next person tuning this file will "fix" it.
_t11k_bad=""
for _t in "the agent card renders the wrong plan on signup" \
          "customer queue page shows a stale position" \
          "agents list is empty for a fresh account"; do
  [[ -n "$(_task_internal_subject_reason "$_t")" ]] && _t11k_bad+="FALSE POSITIVE: ${_t}"$'\n'
done
[[ -z "$_t11k_bad" ]] \
  && ok_t "T11k 'agent' and 'queue' stay OUT — the product is agent hosting" \
  || bad_t "T11k 'agent' and 'queue' stay OUT — the product is agent hosting" "$_t11k_bad"

# T11l: the word boundaries are load-bearing, not incidental. `board` must not
# eat "dashboard", `hook` must not eat "webhook", `test` must not eat "latest" —
# every one of those is a customer surface, and a scan that swallowed them would
# refuse product work with an internal-machinery reason.
_t11l_bad=""
for _t in "dashboard billing page renders a stale plan" \
          "webhook retries drop the second event" \
          "install the latest release on a fresh box for a customer"; do
  [[ -n "$(_task_internal_subject_reason "$_t")" ]] && _t11l_bad+="BOUNDARY LEAK: ${_t}"$'\n'
done
[[ -z "$_t11l_bad" ]] \
  && ok_t "T11l word boundaries hold: dashboard/webhook/latest are not machinery" \
  || bad_t "T11l word boundaries hold: dashboard/webhook/latest are not machinery" "$_t11l_bad"

# T11m: A FIXTURE STORE IS NOT THE BOARD. The window is over the cap right now
# (T11d proved it refuses), so this arm changes exactly one thing — it stops
# declaring this store to be prod — and the SAME add must land. This is the arm
# that lets 24 other harnesses seed rows called "review gate" without a filing
# policy refusing their setup, and it is why widening the classifier was safe.
_t11m_saved="$FIVEDIVE_PROD_TASKS_DB"
export FIVEDIVE_PROD_TASKS_DB="$TMP/not-the-real-board.db"
nb_json=$(run add --assignee=alice --priority=medium -- "w review gate harness seeds a row over the cap")
nb_id=$(printf '%s' "$nb_json" | jf '.data.id')
[[ -n "$nb_id" && "$nb_id" != "null" ]] \
  && ok_t "T11m the cap does not govern a store that is not the production board" \
  || bad_t "T11m the cap does not govern a store that is not the production board" "$nb_json $(cat "$TMP"/err)"
export FIVEDIVE_PROD_TASKS_DB="$_t11m_saved"

# T11n: and putting the declaration back RESTORES the refusal on the same title.
# Without this pair T11m is indistinguishable from a cap that stopped working.
nb2_out=$(run add --assignee=alice --priority=medium -- "w review gate harness seeds a row over the cap"); nb2_rc=$?
(( nb2_rc != 0 )) && has "$(cat "$TMP"/err)$nb2_out" "filing cap" \
  && ok_t "T11n restoring the prod declaration restores the refusal (T11m was the store, not a broken cap)" \
  || bad_t "T11n restoring the prod declaration restores the refusal (T11m was the store, not a broken cap)" "rc=$nb2_rc $nb2_out $(cat "$TMP"/err)"

# T11r-T11u: DIVE-6652. On teal-fox (a customer box) the cap refused a customer's
# "commit the digest CSS" row on a 6/20 window whose 6 hits were ALL customer
# product rows: gate x3, digest, unit, board. The real machinery count was 0.
# _t11_seed fills the window with plain SQL rows (only titles feed the ratio),
# then each arm files one row through the real `task add`.
_t11_seed() { # <title>... — clears the board, then inserts these titles oldest-first
  db "DELETE FROM tasks;"
  local _s
  for _s in "$@"; do db "INSERT INTO tasks (title, created_by) VALUES ($(sqlq "$_s"), 'alice');"; done
}
_t11_neutral=()
for i in $(seq 1 14); do _t11_neutral+=("acme storefront: product page copy pass ${i}"); done

# T11r (accept 1): the six teal-fox shapes plus 14 neutral rows. Pre-fix this
# reads 6/20 and the digest title makes it 7/21 — refused.
_t11_seed "${_t11_neutral[@]}" \
  "acme news: hold the morning post until the feed-publish gate passes" \
  "acme news: the leak-scan gate blocks the RU edition" \
  "acme news: gate the weekend issue on the editor's sign-off" \
  "acme bonds: weekly bond-digest page adds the yield table" \
  "acme trade: customs unit values in EUR" \
  "acme review: write critic-board-passed into the JSON"
r_json=$(run add --assignee=alice --priority=medium -- "acme.example: commit the 42 digest CSS to acme/news (ru)")
r_id=$(printf '%s' "$r_json" | jf '.data.id')
[[ -n "$r_id" && "$r_id" != "null" ]] \
  && ok_t "T11r a customer's digest row files without --customer on a board of customer gate/digest/unit/board rows" \
  || bad_t "T11r a customer's digest row files without --customer on a board of customer gate/digest/unit/board rows" "$r_json $(cat "$TMP"/err)"

# T11s (accept 2, the negative control): genuine machinery still trips it.
_t11_seed "${_t11_neutral[@]:0:14}" \
  "verifier rail skips the recurring row" "heartbeat drops a wake on a parked row" \
  "harness reds on a fresh store" "verifier rail double-books a grader" \
  "heartbeat tick misses the coordinator" "harness reds under set -e"
s_out=$(run add --assignee=alice --priority=medium -- "heartbeat drops the second wake"); s_rc=$?
(( s_rc != 0 )) && has "$(cat "$TMP"/err)$s_out" "filing cap" \
  && ok_t "T11s a medium machinery row is still refused on a 6/20 machinery board" \
  || bad_t "T11s a medium machinery row is still refused on a 6/20 machinery board" "rc=$s_rc $s_out $(cat "$TMP"/err)"

# T11t (accept 3): rows filed WITH --customer stay in the window but are never a
# hit. Six machinery-sounding customer rows go in through the real verb, so the
# flag has to be stored; pre-fix they counted 6/20 and refused the next filer.
_t11_seed "${_t11_neutral[@]}"
for i in 1 2 3 4 5 6; do
  run add --assignee=alice --priority=medium --customer -- "acme checkout: harness for the cart flow ${i}" >/dev/null
done
read -r t_hits t_win < <(_task_internal_recent_ratio 20)
t_out=$(run add --assignee=alice --priority=medium -- "the release-cut harness is red"); t_rc=$?
[[ "$t_hits $t_win" == "0 20" ]] && (( t_rc == 0 )) \
  && ok_t "T11t --customer rows are stored and never counted as machinery (window 0/20, next internal row files)" \
  || bad_t "T11t --customer rows are stored and never counted as machinery" "window=$t_hits/$t_win rc=$t_rc $(cat "$TMP"/err)"

# T11u: and the same six titles filed WITHOUT the flag are hits — T11t moved on
# the stored flag, not on a classifier that stopped matching them.
_t11_cart=()
for i in 1 2 3 4 5 6; do _t11_cart+=("acme checkout: harness for the cart flow ${i}"); done
_t11_seed "${_t11_neutral[@]}" "${_t11_cart[@]}"
read -r u_hits u_win < <(_task_internal_recent_ratio 20)
[[ "$u_hits $u_win" == "6 20" ]] \
  && ok_t "T11u control: the same titles without --customer count 6/20" \
  || bad_t "T11u control: the same titles without --customer count 6/20" "window=$u_hits/$u_win"

# --- T12: THE CAP PATH SURVIVES `set -e`, which is how it ships -------------
# This harness runs under `set +e` (line ~52) so that arms can assert non-zero
# exits. That is correct for the arms — and it meant T11a-i could not see the
# defect they were supposedly covering: `_task_internal_recent_ratio` printed
# with no trailing newline, the caller's `read` returned 1 at EOF, and under
# src/header.sh's real `set -euo pipefail` `task add` died before any error
# path printed. 32/32 green, and the shipped command was broken for every
# internal title. A test that disables the condition it is testing under is
# not a test of that condition.
#
# So this arm restores the SHIPPING shell options around the call and asserts
# the classifier path returns a value instead of killing the shell.
db "DELETE FROM tasks;"
for i in 1 2 3 4 5 6 7 8; do
  run add --assignee=alice --priority=medium -- "ship customer feature ${i}" >/dev/null
done
sete_out=$( set -euo pipefail
            _task_internal_recent_ratio 20 ) ; sete_rc=$?
[[ $sete_rc -eq 0 && "$sete_out" =~ ^[0-9]+\ [0-9]+$ ]] \
  && ok_t "T12a the ratio helper returns 'N M' under set -euo pipefail (not a silent death)" \
  || bad_t "T12a the ratio helper returns 'N M' under set -euo pipefail (not a silent death)" "rc=$sete_rc out='$sete_out'"

# T12b: the CALLER's read is the site that actually died. Reproduce the exact
# construct under the shipping options, with a positive control on the value.
readback=$( set -euo pipefail
            _h=0; _w=0; read -r _h _w < <(_task_internal_recent_ratio 20) || true
            printf 'h=%s w=%s' "$_h" "$_w" ) ; read_rc=$?
[[ $read_rc -eq 0 && "$readback" == "h=0 w=8" ]] \
  && ok_t "T12b the caller's read survives set -e AND reads the right window (0 internal of 8)" \
  || bad_t "T12b the caller's read survives set -e AND reads the right window (0 internal of 8)" "rc=$read_rc '$readback'"

# T12c: end-to-end — an internal-titled add under the shipping options either
# creates a row or refuses, but ALWAYS says something. Silence is the bug.
e2e_out=$( set -euo pipefail
           JSON_MODE=0; cmd_task_add --assignee=alice --priority=medium -- "the nightly sweep harness is flaky" 2>&1 ) ; e2e_rc=$?
[[ -n "$e2e_out" ]] \
  && ok_t "T12c an internal-titled add under set -e produces OUTPUT, never a silent exit" \
  || bad_t "T12c an internal-titled add under set -e produces OUTPUT, never a silent exit" "rc=$e2e_rc (empty output)"


printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
