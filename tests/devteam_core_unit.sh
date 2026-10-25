#!/usr/bin/env bash
# DIVE-6935 — plugins/devteam/core/ is read INTO the 5dive CLI (its
# src/lib/devteam.sh), inside the CLI's own module loader. So the files must
# parse, must be exactly the eight modules that loader knows, must not declare a
# column-0 array without -g (it would bind as a local of the loader function),
# and must match core/SOURCE, which names the core commit they are copies of.
#
#   bash tests/devteam_core_unit.sh                     grade
#   bash tests/devteam_core_unit.sh --refresh=<5dive>   recopy from a 5dive checkout's
#                                                       origin/main and rewrite SOURCE
set -uo pipefail
cd "$(dirname "$0")/.."
D=plugins/devteam
FILES="cmd_deploy.sh cmd_gh.sh cmd_proof.sh cmd_push.sh task/delivery.sh task/gate_evidence.sh task/grader_pool.sh task/grader_process.sh"

if [[ "${1:-}" == --refresh=* ]]; then
  src="${1#--refresh=}"
  sha=$(git -C "$src" rev-parse origin/main) || exit 1
  for f in $FILES; do git -C "$src" show "origin/main:src/$f" > "$D/core/$f" || exit 1; done
  {
    sed -n '1,3p' "$D/core/SOURCE"
    echo "from 5dive-ai/5dive@$sha"
    for f in $FILES; do echo "$(sha256sum < "$D/core/$f" | cut -d' ' -f1)  $f"; done
  } > "$D/core/SOURCE.new" && mv "$D/core/SOURCE.new" "$D/core/SOURCE"
  echo "refreshed from 5dive-ai/5dive@$sha — bump version in $D/.claude-plugin/plugin.json"
  exit 0
fi

PASS=0; FAIL=0
t() { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }

have=$(cd "$D/core" && find . -name '*.sh' | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')
t "T1 core/ holds exactly the modules the CLI's loader overlays" "$FILES" "$have"
for f in $FILES; do
  bash -n "$D/core/$f" 2>/dev/null; t "T2 $f parses" 0 "$?"
  n=$(grep -cE '^declare -[aA]+ ' "$D/core/$f")
  t "T3 $f has no column-0 declare without -g" 0 "$n"
  want=$(awk -v f="$f" '$2 == f { print $1 }' "$D/core/SOURCE")
  t "T4 $f matches core/SOURCE" "$want" "$(sha256sum < "$D/core/$f" | cut -d' ' -f1)"
done
t "T5 SOURCE names the 5dive commit" 1 "$(grep -cE '^from 5dive-ai/5dive@[0-9a-f]{40}$' "$D/core/SOURCE")"
t "T6 the manifest declares exactly the core capability" '["core"]' "$(jq -c '.fivedive.capabilities' "$D/.claude-plugin/plugin.json")"
t "T7 and declares no verbs (it adds none until phase 2)" "null" "$(jq -c '.fivedive.verbs' "$D/.claude-plugin/plugin.json")"
t "T8 the marketplace lists it" "./plugins/devteam" "$(jq -r '.plugins[] | select(.name=="devteam") | .source' .claude-plugin/marketplace.json)"

# Negative control: a mutated copy must fail T4's comparison.
tmp=$(mktemp); cp "$D/core/cmd_gh.sh" "$tmp"; echo '# drift' >> "$tmp"
want=$(awk '$2 == "cmd_gh.sh" { print $1 }' "$D/core/SOURCE")
[[ "$(sha256sum < "$tmp" | cut -d' ' -f1)" != "$want" ]]; t "T0 a one-line edit is caught by the SOURCE check" 0 "$?"
rm -f "$tmp"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
