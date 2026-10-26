#!/usr/bin/env bash
# DIVE-6938 — the harnesses for the devteam modules, run against a 5dive core.
#
# They moved here from 5dive-ai/5dive/tests/ with the files they grade, and they
# are unchanged: each still expects a 5dive tree with src/<module>.sh in it. So
# this builds that tree: a clone of the core, with every plugin module the core
# no longer carries put back at its old path and in its old place in build.sh
# and src/cmd_task.sh. Against a core that still carries them (anything before
# DIVE-6938) nothing is put back and the harnesses grade the core's own copies.
#
#   bash tests/devteam_core_harnesses.sh --core=<5dive checkout> [--ref=<rev>] [--shard=i/n] [name ...]
#
# --core is a local checkout (its committed HEAD, or --ref, is what is graded;
# uncommitted edits are not). Names are harness basenames (push_unit or
# push_unit.sh); none means every harness in tests/devteam/. Prints one line per
# harness and exits non-zero if any failed. --shard=i/n runs every n-th harness
# from the i-th (1-based), for CI. FIVEDIVE_KEEP_TREE=1 keeps the tree.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PC="$REPO/plugins/devteam/core"
HARNESS_DIR="$HERE/devteam"

core="" ref="" shard=""
names=()
for a in "$@"; do
  case "$a" in
    --core=*) core="${a#--core=}" ;;
    --ref=*)  ref="${a#--ref=}" ;;
    --shard=*) shard="${a#--shard=}" ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) names+=("${a%.sh}") ;;
  esac
done
[[ -n "$core" && -d "$core" ]] || { echo "usage: $0 --core=<5dive checkout> [--ref=<rev>] [name ...]" >&2; exit 2; }

TREE="$(mktemp -d)/5dive"
trap '[[ -n "${FIVEDIVE_KEEP_TREE:-}" ]] || rm -rf "$(dirname "$TREE")"' EXIT
git clone --quiet --no-hardlinks "$core" "$TREE" || { echo "FAIL: cannot clone $core" >&2; exit 1; }
if [[ -n "$ref" ]]; then
  git -C "$TREE" checkout --quiet "$ref" || { echo "FAIL: no such ref $ref in $core" >&2; exit 1; }
fi
graded="$(git -C "$TREE" rev-parse HEAD)"

# The modules, in the order the core concatenated them (src/lib/devteam.sh's
# DEVTEAM_MODULES), with where each sat in build.sh.
put_back=()
for f in lib/gh_config.sh task/gate_evidence.sh task/grader_pool.sh task/grader_process.sh \
         task/delivery.sh cmd_proof.sh cmd_push.sh cmd_deploy.sh cmd_gh.sh; do
  if [[ ! -f "$TREE/src/$f" ]]; then
    mkdir -p "$(dirname "$TREE/src/$f")"
    cp "$PC/$f" "$TREE/src/$f"
    put_back+=("$f")
    # The plugin's grader_pool.sh is the grader half; the meter and the pace it
    # calls are the core's src/lib/pace.sh. In the bundle those are autoload
    # stubs; a split-tree harness that sources grader_pool.sh alone (as eleven do)
    # needs this one line to get them, so it is put back with the file.
    if [[ "$f" == task/grader_pool.sh ]]; then
      { printf '%s\n' 'declare -F _grader_pct >/dev/null 2>&1 || . "$(dirname "${BASH_SOURCE[0]}")/../lib/pace.sh"'
        cat "$PC/$f"; } > "$TREE/src/$f"
    fi
  fi
done
if (( ${#put_back[@]} )); then
  python3 - "$TREE" "${put_back[@]}" <<'PY' || { echo "FAIL: could not put the modules back into build.sh" >&2; exit 1; }
import sys
tree, back = sys.argv[1], set(sys.argv[2:])
p = f"{tree}/build.sh"; s = open(p).read()
def insert(anchor, files, before=False):
    global s
    files = [f for f in files if f in back]
    if not files: return
    i = s.index(anchor) + (0 if before else len(anchor))
    s = s[:i] + "".join(f"  src/{f}\n" for f in files) + s[i:]
# gh_config was a CORE file (parsed every run), right after env_overrides;
insert("  src/lib/env_overrides.sh\n", ["lib/gh_config.sh"])
# the task modules sat around the pace, which took grader_pool's slot;
insert("  src/lib/pace.sh\n", ["task/gate_evidence.sh", "task/grader_pool.sh", "task/grader_process.sh", "task/delivery.sh"])
# and the four verbs just before cmd_bug.sh.
insert("  src/cmd_bug.sh\n", ["cmd_proof.sh", "cmd_push.sh", "cmd_deploy.sh", "cmd_gh.sh"], before=True)
open(p, "w").write(s)
# The split tree's loader sourced these two.
p = f"{tree}/src/cmd_task.sh"; s = open(p).read()
anchor = 'declare -F _task_guard_result_over_closed >/dev/null 2>&1 || . "$_task_src_dir/task/status.sh"\n'
if "task/gate_evidence.sh" in back and "task/gate_evidence.sh" not in s:
    s = s.replace(anchor, 'declare -F _gate_tok_note >/dev/null 2>&1 || . "$_task_src_dir/task/gate_evidence.sh"\n' + anchor, 1)
if "task/delivery.sh" in back and "task/delivery.sh" not in s:
    s = s.replace(anchor, anchor + 'declare -F cmd_task_deliver >/dev/null 2>&1 || . "$_task_src_dir/task/delivery.sh"\n', 1)
open(p, "w").write(s)
PY
  git -C "$TREE" add -A
  git -C "$TREE" -c gc.auto=0 -c maintenance.auto=false -c user.name=devteam-harness -c user.email=devteam@example.com \
    commit --quiet -m "devteam harness tree: put back ${put_back[*]}" \
    || { echo "FAIL: could not commit the harness tree" >&2; exit 1; }
fi

# Build the bundle once, before any harness: about a third of these grade ./5dive
# end to end and refuse to run without it. Leaving it to whichever harness happens
# to run ./build.sh first made a shard order-dependent (core CI's DIVE-2525).
( cd "$TREE" && ./build.sh >/dev/null 2>"$TREE.build.err" ) \
  || { echo "FAIL: ./build.sh in the harness tree: $(tail -3 "$TREE.build.err")" >&2; exit 1; }

if (( ${#names[@]} == 0 )); then
  while IFS= read -r h; do names+=("$(basename "$h" .sh)"); done < <(ls "$HARNESS_DIR"/*.sh | sort)
fi
if [[ -n "$shard" ]]; then
  [[ "$shard" =~ ^([0-9]+)/([0-9]+)$ ]] && (( BASH_REMATCH[1] >= 1 && BASH_REMATCH[1] <= BASH_REMATCH[2] )) \
    || { echo "usage: --shard=i/n with 1 <= i <= n" >&2; exit 2; }
  si=${BASH_REMATCH[1]} sn=${BASH_REMATCH[2]}; kept=(); k=0
  for n in "${names[@]}"; do (( k % sn == si - 1 )) && kept+=("$n"); k=$((k + 1)); done
  names=("${kept[@]}")
fi
for n in "${names[@]}"; do
  [[ -f "$HARNESS_DIR/$n.sh" ]] || { echo "FAIL: no harness tests/devteam/$n.sh" >&2; exit 2; }
done
# Every harness goes into the tree, not only this shard's: some drive a sibling
# (digest_window_30d_controls stages and mutates digest_window_30d_unit), and the
# sibling can land in another shard.
cp "$HARNESS_DIR"/*.sh "$TREE/tests/" || { echo "FAIL: could not copy the harnesses into the tree" >&2; exit 1; }

printf 'core %s @ %s; modules put back: %s\n' "$core" "${graded:0:12}" "${put_back[*]:-none (the core still carries them)}"
pass=0; fail=0; failed=()
for n in "${names[@]}"; do
  s=$(date +%s)
  out=$(cd "$TREE" && timeout "${DEVTEAM_HARNESS_TIMEOUT:-900}" bash "tests/$n.sh" 2>&1); rc=$?
  e=$(date +%s)
  if (( rc == 0 )); then
    pass=$((pass + 1)); printf 'ok   %-48s %4ss\n' "$n" "$((e - s))"
  else
    fail=$((fail + 1)); failed+=("$n"); printf 'FAIL %-48s %4ss rc=%s\n' "$n" "$((e - s))" "$rc"
    printf '%s\n' "$out" | tail -n "${DEVTEAM_HARNESS_TAIL:-15}" | sed 's/^/     | /'
  fi
done
printf '%s harnesses: %s passed, %s failed%s\n' "$((pass + fail))" "$pass" "$fail" "${failed[*]:+ (${failed[*]})}"
(( fail == 0 ))
