#!/usr/bin/env bash
# DIVE-6935/6938 — plugins/devteam/core/ is read INTO the 5dive CLI (its
# src/lib/devteam.sh), inside the CLI's own process. So the files must parse,
# must be exactly the nine modules that loader knows, must not declare a
# column-0 array without -g (it would bind as a local of the loader function),
# and must match core/SOURCE. Since DIVE-6938 the core keeps no copy: these
# files are the code, and SOURCE is their manifest.
#
#   bash tests/devteam_core_unit.sh            grade
#   bash tests/devteam_core_unit.sh --rehash   rewrite SOURCE's sha lines after an edit
#                                              (then bump version in plugin.json)
set -uo pipefail
cd "$(dirname "$0")/.."
D=plugins/devteam
FILES="cmd_deploy.sh cmd_gh.sh cmd_proof.sh cmd_push.sh lib/gh_config.sh task/delivery.sh task/gate_evidence.sh task/grader_pool.sh task/grader_process.sh"

if [[ "${1:-}" == --rehash ]]; then
  {
    grep -E '^(#|from )' "$D/core/SOURCE"
    for f in $FILES; do echo "$(sha256sum < "$D/core/$f" | cut -d' ' -f1)  $f"; done
  } > "$D/core/SOURCE.new" && mv "$D/core/SOURCE.new" "$D/core/SOURCE"
  echo "rehashed core/SOURCE — bump version in $D/.claude-plugin/plugin.json"
  exit 0
fi

PASS=0; FAIL=0
t() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }

have=$(cd "$D/core" && find . -name '*.sh' | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')
t "T1 core/ holds exactly the modules the CLI's loader reads" "$FILES" "$have"
for f in $FILES; do
  bash -n "$D/core/$f" 2>/dev/null; t "T2 $f parses" 0 "$?"
  n=$(grep -cE '^declare -[aA]+ ' "$D/core/$f")
  t "T3 $f has no column-0 declare without -g" 0 "$n"
  want=$(awk -v f="$f" '$2 == f { print $1 }' "$D/core/SOURCE")
  t "T4 $f matches core/SOURCE" "$want" "$(sha256sum < "$D/core/$f" | cut -d' ' -f1)"
done
t "T5 SOURCE names the 5dive commit they moved from" 1 "$(grep -cE '^from 5dive-ai/5dive@[0-9a-f]{40}$' "$D/core/SOURCE")"
t "T6 the manifest declares exactly the core capability" '["core"]' "$(jq -c '.fivedive.capabilities' "$D/.claude-plugin/plugin.json")"
# The verbs (proof gh push deploy and their root halves) are RESERVED by the core
# and handed only to this exact plugin; a plugin verb is an exec'd bin/, which
# this plugin has none of. Declaring them would be refused at install as builtins.
t "T7 and declares no verbs (the core reserves them for this plugin)" "null" "$(jq -c '.fivedive.verbs' "$D/.claude-plugin/plugin.json")"
t "T8 the marketplace lists it" "./plugins/devteam" "$(jq -r '.plugins[] | select(.name=="devteam") | .source' .claude-plugin/marketplace.json)"
# DIVE-6938: the pace half of grader_pool.sh stays in the core (src/lib/pace.sh),
# so a copy that still defines it would put an older pace over the core's.
t "T9 grader_pool.sh carries no _pace_ function (the pace is the core's)" 0 \
  "$(grep -cE '^_pace_[A-Za-z0-9_]*\(\)' "$D/core/task/grader_pool.sh")"
t "T10 nor the meter the core keeps beside it" 0 \
  "$(grep -cE '^_grader_(pct|reading_expired|reading_pair|account_reading_json|account_reading|account_of)\(\)' "$D/core/task/grader_pool.sh")"
# The loader stubs every `^name() {` it finds; a python `print()` line inside a
# heredoc must not read as one (src/lib/devteam.sh requires the brace).
n=$(grep -ohE '^[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{' $(for f in $FILES; do echo "$D/core/$f"; done) | sed 's/().*//' | sort | uniq -d | wc -l)
t "T11 no function is defined by two modules" 0 "$n"

# Moved from 5dive's usage_enumeration_completeness_unit.sh T3d (DIVE-6938):
# `proof scorecard` dispatches, so the proof usage string must name it.
t "T12 the proof usage string names every proof subverb, scorecard included" 1 \
  "$(grep -c 'publish|on|off|status|scorecard|tick' "$D/core/cmd_proof.sh" | awk '{print ($1 > 0)}')"

# Negative controls: a mutated copy must fail T4's comparison, and a pace
# function pasted back must fail T9.
tmp=$(mktemp); cp "$D/core/cmd_gh.sh" "$tmp"; echo '# drift' >> "$tmp"
want=$(awk '$2 == "cmd_gh.sh" { print $1 }' "$D/core/SOURCE")
[[ "$(sha256sum < "$tmp" | cut -d' ' -f1)" != "$want" ]]; t "T0a a one-line edit is caught by the SOURCE check" 0 "$?"
cp "$D/core/task/grader_pool.sh" "$tmp"; printf '_pace_band() { :; }\n' >> "$tmp"
t "T0b a pace function pasted back is caught by T9's count" 1 "$(grep -cE '^_pace_[A-Za-z0-9_]*\(\)' "$tmp")"
rm -f "$tmp"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
