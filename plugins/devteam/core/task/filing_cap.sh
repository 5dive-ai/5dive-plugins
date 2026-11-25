# shellcheck shell=bash
# ── DIVE-9262: the title-word filing cap, 5dive's own, out of the core ────────
#
# Read into the 5dive CLI by src/lib/devteam.sh as an OPTIONAL module: a core
# that knows it reads it when this file is here, an older core ignores it, and
# a core with an older plugin (no file) simply has no word cap. Either order of
# upgrade is safe; the cap fails open.
#
# It left the core because it judged a row by OUR vocabulary. On a customer's
# box that refused the customer's own work ("commit the digest CSS"; "upgrade
# rails" would match too). On 5dive's own boxes it keeps doing what it did:
#   _task_internal_subject_reason  the classifier (core's crud.sh asks
#                                  `declare -F` first, then uses it for the
#                                  refusal below and to skip the grader)
#   _task_internal_recent_ratio    how many of the last N rows match
#   _task_filing_ratio_cap         the 1-in-4 refusal at `task add`
#   _task_agent_task_cap_default   15: the default for the core's
#                                  `agent-task-cap` when the box sets none
#
# The text below moved verbatim from src/task/routing.sh and src/task/crud.sh
# at 5dive-ai/5dive@fbee8c7b; only the wrappers are new.

# THE FILING CAP (DIVE-2681). Two controls over one classifier.
#
# The measured problem: across the 508 rows filed in the 8 days to 2026-08-02,
# 54% concerned our own machinery and 5.5% touched anything a customer sees —
# roughly 10:1. The fleet audits itself because auditing is always available,
# and every internal row costs TWICE, because the DIVE-969 rail then books a
# grading pass against it. The rule has existed as a directive since 2026-08-02
# and did not hold: the agent that wrote it filed 55 rows the next day. A rule
# recalled BY TOPIC cannot fire at a MOMENT, and `task add` is the moment.
#
# So the cap lives here, at the keystroke, and not in anyone's instructions.
#
# THE CLASSIFIER IS A CANDIDATE SET, NEVER AN ACTION SET. A title-keyword scan
# cannot tell a harness row from a product row that happens to say "queue" —
# "Free OSS web UI: three views (org chart, queue, gates)" is a customer
# surface and matches on two words. So every consequence below is (a) announced
# in the output, never silent, and (b) one declared flag away from off:
#   --customer          this touches a customer surface; classifier was wrong
#   --already-blocked=  it IS internal, and it is the stated exception
# A false positive costs one flag. It never costs the row.
# A MISS IS NOT CHEAP — MEASURED 2026-08-09. The first cut of this scan was
# deliberately narrow on the reasoning that "a miss here is cheap and a false hit
# taxes someone's real work". Only the second half of that held. Over the 946
# hand-filed rows of the preceding 14 days the narrow set flagged **15%** where a
# read of the same titles says ~67% are our own machinery, so the gating window
# sat at 3/20 against a 5/20 threshold and the cap **never fired once**. The
# fleet filed 55 rows a day, two of every three about itself, for five days after
# the guard shipped and went live in 0.19.6.
#
# The narrow set failed for one structural reason: it keyed on MULTI-WORD phrases
# ("verifier rail", "merge gate", "task add") while the rows that actually get
# filed say the same things in one word — "gate" (102 occurrences in the missed
# set), "agent" (97), "task" (80), then verifier, guard, rail, council, probe,
# board. The vocabulary was right and the arity was wrong.
#
# So the set below is single-token where our machinery owns the token outright.
# Two words stay OUT on purpose because the product IS agent hosting and they
# cannot discriminate: **agent** and **queue**. Word boundaries do real work
# here — "dashboard" does not match `board`, "webhook" does not match `hook`,
# "latest" does not match `test`. Measured detection after widening: 45%, still
# under the ~67% human read, which is the safe direction for a refusal.
_task_internal_subject_reason() {
  local t="${1,,}"
  # Our own machinery: the task engine, gates, verifier rails, CI, the release
  # cut, harnesses, the board, agent plumbing. Still a candidate set, never an
  # action set — see the two declared escapes above.
  [[ "$t" =~ (^|[^a-z])(harness|harnesses|smoke|full[-_ ]sweep|pipefail|shellcheck|actionlint|lint|verifier|verifiers|rail|rails|task[[:space:]](add|done|need|ls)|taskboard|worktree|worktrees|heartbeat|release[-_ ]cut|version[-_ ]bump|changelog|pre[-_ ]push|guard|guards|council|ci|nightly|budget[-_ ]report|backlog|crontab|recurring|maker|regression|flaky|test|tests)([^a-z]|$) ]] \
    && { printf 'internal machinery'; return 0; }
  # DIVE-6652: gate, board, digest, unit, cron, hook and probe are OURS only in
  # a compound. Bare, they are a customer's own work just as often: on teal-fox
  # all 6 hits in a 20-row window were customer product rows (a feed-publish
  # gate, a leak-scan gate, a bond-digest page, "customs unit values", a
  # `critic-board-passed` key), the real machinery count was 0, and the cap
  # refused a customer's "commit the digest CSS" row. Over our own last 1500
  # rows the compounds keep 272 of the bare set's 332 hits; most of the 60 it
  # drops are product rows too (a LinkedIn hook, a checkout probe, a cron line).
  [[ "$t" =~ (^|[^a-z])((human|merge|push|secret|approval|decision|manual|done|spend|smoke|task|verify|ship)[-_ ]gates?|gates?[-_ ](digest|ping|card|cards|history|rail|rails|tier|routing|answer|evidence|re[-_ ]?nag)|(task|team)[-_ ]board|unit[-_ ]tests?|systemd[-_ ]units?|(git|claude|stop|session[-_ ]?start|pre[-_ ]?commit|pre[-_ ]?tool[-_ ]?use|post[-_ ]?tool[-_ ]?use)[-_ ]hooks?|pretooluse|posttooluse|selfcheck[-_ ]probes?)([^a-z]|$) ]] \
    && { printf 'internal machinery'; return 0; }
  return 0
}

# How many of the last N standard rows read as internal machinery. Counted by
# running the SAME classifier over recent titles rather than storing a column —
# no schema change, and the count can never disagree with the rule that gates
# the next add. Prints "<internal> <total>".
#
# DIVE-6652: a row filed with --customer stays in the window but is never a hit.
# The filer already told us the scan was wrong about it; re-scanning its title
# here made every such row raise the count the NEXT filer is refused on. The
# flag is read back from its task.customer ledger event (task add writes it),
# keyed on ident so the lookup rides lifecycle_events_ident_idx.
_task_internal_recent_ratio() {
  local window="${1:-20}" n=0 hits=0 line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    n=$((n + 1))
    [[ "$line" == C* ]] && continue
    # `if`, not `[[ ]] && ...`: as the LAST command in a loop body a false
    # `&&` list makes the body — and so the loop — exit 1, which `set -e`
    # takes as a failure. Same family as the defect this whole ticket exists
    # to stop generating.
    if [[ -n "$(_task_internal_subject_reason "${line:2}")" ]]; then
      hits=$((hits + 1))
    fi
  done < <(db "SELECT CASE WHEN EXISTS (SELECT 1 FROM lifecycle_events e
                                         WHERE e.ident=t.ident AND e.kind='task.customer')
                           THEN 'C ' ELSE '- ' END || REPLACE(t.title, char(10), ' ')
               FROM tasks t WHERE t.kind='standard' ORDER BY t.id DESC LIMIT ${window};")
  # THE TRAILING NEWLINE IS LOAD-BEARING. `read` returns 1 when it hits EOF
  # without a delimiter, so a bare "%s %s" makes the CALLER's `read` fail, and
  # under src/header.sh's `set -euo pipefail` that killed `task add` outright
  # with no error path reached — the exact silent-death class of DIVE-2604.
  printf '%s %s\n' "$hits" "$n"
}

# The 1-in-4 refusal. The core calls it only for a standard row the classifier
# matched, at low/medium, without --customer or --already-blocked, on the
# production board. FIVE_FILING_CAP=0 turns it off for one run (emergencies).
_task_filing_ratio_cap() { # <title>
  local title="$1"
  [[ "${FIVE_FILING_CAP:-1}" != "0" ]] || return 0
  # `|| true` on the read as well as the newline at the producer: two
  # independent guards, because a filing rule must never be able to take
  # `task add` down. If the read ever comes back empty the cap declines to
  # enforce rather than dying — a control that fails OPEN is the right
  # posture for a quota, and the wrong one for a security check.
  local _hits=0 _win=0; read -r _hits _win < <(_task_internal_recent_ratio 20) || true
  [[ "$_hits" =~ ^[0-9]+$ ]] || _hits=0
  [[ "$_win"  =~ ^[0-9]+$ ]] || _win=0
  # Only enforce once the window is big enough to mean anything — on a fresh
  # board a 1-in-4 rule computed over three rows is noise, not a signal.
  if (( _win >= 8 )) && (( (_hits + 1) * 4 > (_win + 1) )); then
    # A REFUSAL MUST LEAVE THE FINDING SOMEWHERE (lodar, 2026-08-09: "if task
    # is refused where will it be logged if something serious found?"). Until
    # now: nowhere. `fail` printed to the caller's terminal and returned, so a
    # refused row left no record of its own title — the cap could eat a real
    # finding and neither the filer's next session nor anyone auditing the cap
    # could recover what was lost. policy_refuse writes the TITLE into
    # policy_refusals.detail and emits a policy.refused lifecycle event, so
    # `5dive task refusals` and the ledger both hold it. It fails with the same
    # code afterwards, so the refusal itself is unchanged.
    #
    # The ident slot takes the would-be title rather than an ident, because at
    # this point in `task add` the row does not exist and never will — the
    # whole event is "this title was not allowed to become a row". Recording a
    # synthetic ident would be worse than none: it would look like a lookup key.
    policy_refuse "$E_VALIDATION" filing-cap-internal-machinery DIVE-2681 "(unfiled) ${title}" \
      "filing cap: ${_hits} of the last ${_win} rows are already internal machinery — this one would make it $((_hits + 1))/$((_win + 1)), over the 1-in-4 cap.
REFUSED TITLE (recorded in policy_refusals, not lost): ${title}
An internal-machinery finding gets its own ident ONLY if it has ALREADY blocked shipped work. Otherwise it belongs in the body of the row it was found on, or in the team wiki.
  · it is serious                  →  --priority=high (high and urgent are never capped)
  · it already blocked something   →  --already-blocked='<what it blocked>'
  · the scan is wrong, this is a customer surface  →  --customer
  · fleet-wide override (emergencies)  →  FIVE_FILING_CAP=0"
  fi
  return 0
}

# THE NUMBER, AND WHY IT IS THIS NUMBER. Derived from 30 days of the real board
# (low/medium, template-materialized and cli/system excluded), by asking how many
# rows each cap WOULD have refused:
#
#     cap   main  olivia  dev  dev3  everyone else
#      10    327     151   78     3              0
#      12    313     129   47     1              0
#      15    282      97   18     0              0     <- chosen
#      20    227      60    7     0              0
#
# 15 is the smallest cap at which NO filer outside the top three is ever touched.
# Below it the cap starts catching dev3, who is not the problem; above it the
# heavy filers keep more of the headroom that produced 245 cancelled rows out of
# 1092. The median filer's worst rolling-24h in that window is 4.5 and ten of
# fourteen filers never exceed 6, so this leaves the ordinary case untouched by
# more than 2x while binding all three runaway filers — including dev, which is
# the point: a cap its author is exempt from is a suggestion.
#
# NOT `${_TASK_FILING_DAILY_CAP:-15}`. An env-overridable cap IS the bypass flag
# this row forbids, just spelled differently and invisible in the record — and the
# population it exists to slow down is the population that would export it. It is
# a constant, and the harness trips it by seeding real rows rather than by
# lowering the bar, which also means the tests exercise the REAL threshold.
#
# DIVE-9262: since it became the core's owner setting (`agent-task-cap`, off by
# default) this is only the DEFAULT on a box with this plugin. An explicit box
# setting, `off` included, wins over it. A person's row is never capped.
_task_agent_task_cap_default() { printf '15'; }
