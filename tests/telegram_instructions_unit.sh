#!/usr/bin/env bash
# DIVE-4481 — the channel instructions must carry the human-messaging rules.
#
# WHY THIS IS AN ARM AND NOT JUST PROSE IN A DIFF. The rules ship to a customer
# TWICE, by two independent paths: the per-box CLAUDE.md template (5dive-api) and
# this MCP instructions block. That redundancy is deliberate — a seat can be
# paired from a box whose CLAUDE.md was customised, or from a host that never
# took the template at all — and redundancy is exactly the kind of thing a later
# "de-duplicate the prompt" pass deletes without noticing, because deleting it
# breaks nothing that any other test in this repo reads.
#
# So each arm is scoped to the `instructions:` ARRAY that is handed to
# `new Server(...)`, not to the file. Text that drifts out of that array into a
# comment, a dead constant or a tool description reads as present to a grep over
# server.ts and is never sent to a model. Arm M is the negative control: strip
# the rule sentences out of the extracted block and every arm must go red.
#
# Offline. No bun deps, no Telegram, no network.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SRC=plugins/telegram/server.ts
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok()  { echo "  ok   — $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL — $1"; FAIL=$((FAIL+1)); }

# The block the MCP server actually sends: from `instructions: [` to the
# `].join(...)` that terminates it.
awk '/^    instructions: \[$/{p=1;next} p&&/^    \]\.join/{exit} p{print}' "$SRC" > "$WORK/block"
if [[ ! -s "$WORK/block" ]]; then
  echo "  FAIL — could not extract the instructions array from $SRC"; exit 1
fi
echo "== extracted the shipped instructions array ($(wc -l < "$WORK/block") lines)"

# Every arm runs against a file, so the mutant can be graded by the same code.
grade() {                     # grade <file> <label> -> non-zero if any check failed
  local f="$1" label="$2" localfail=0
  check() { grep -qi -- "$2" "$f" && ok "$label: $1" || { bad "$label: $1"; localfail=1; }; }
  check "answer first — the conclusion leads"        'conclusion in line one'
  check "no narrating the work before doing it"      'no narrating what you are about to do'
  check "the send gate names its three kinds"        'three kinds of message'
  check "…and what is NOT a message"                 'half-findings'
  check "the ~60-word cap"                           'roughly 60 words'
  check "counted in WORDS, not lines"                'COUNTED IN WORDS'
  check "…with the reason a line cap fails"          'they read on a phone'
  check "detail is displaced, not just forbidden"    'not the message'
  check "over ~30s: acknowledge, then EDIT"          'edit_message that same message'
  return $localfail
}

echo "== the rules are in the block that is sent to the model"
grade "$WORK/block" "shipped"

echo "== the rules are not merely somewhere in the file"
# The array is joined with '\n' and handed to the Server constructor. If that
# wiring goes, the block is a dead literal no matter how good its text is.
grep -q "^    \].join('\\\\n')," "$SRC" \
  && ok "the array is joined and passed to new Server(...)" \
  || bad "the instructions array is no longer joined into the server's instructions"

echo "== arm M (negative control): strip the rules and the arms must red"
grep -v 'conclusion in line one' "$WORK/block" | grep -v 'COUNTED IN WORDS' > "$WORK/mutant"
if cmp -s "$WORK/block" "$WORK/mutant"; then
  bad "the mutation changed nothing — the arms above grade nothing"
else
  # Subshell: the mutant's own bad/ok calls must not touch this run's counters.
  if ! ( grade "$WORK/mutant" "mutant" ) >/dev/null 2>&1; then
    ok "a stripped instructions block fails — the arms are load-bearing"
  else
    bad "a stripped instructions block still passes — the arms grade nothing"
  fi
fi

echo
echo "== $PASS passed, $FAIL failed"
(( FAIL == 0 )) || exit 1
(( PASS >= 11 )) || { echo "ARM COUNT TOO LOW ($PASS) — arms were skipped, not passed"; exit 1; }
echo "ALL GREEN"
