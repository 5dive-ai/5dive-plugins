#!/usr/bin/env bash
# The registry-only arms for browser@5dive-plugins (DIVE-8050; before that, TR28
# inside the hand-kept copy of browser_plugin_unit.sh, DIVE-4691 -> DIVE-4835).
#
# plugins/browser is a byte-for-byte mirror of 5dive-ai/5dive-browser
# (tests/browser_mirror.sh check), and 5dive-browser's own harnesses grade it
# (tests/browser_mirror.sh run). What only THIS repo can get wrong is graded here:
# the marketplace entry, and that no registry-only text sneaks back INSIDE the
# mirrored directory, where the next sync would silently delete it.
#
#   R1  the marketplace entry marks this copy deprecated, names where the plugin
#       ships from, and the remove that has to come first; no other entry is marked
#   R2  the entry's source IS the mirrored directory, and the notice lives outside it
#   R3  no copy of the old runtime notice survives inside the mirror; the detector
#       is shown to find it in a mutant copy that carries it, and the mutant prints it
#   R4  --help and the bare verbs of the real bin/browser print no notice
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
MIRROR="$ROOT/plugins/browser"
BROWSER="$MIRROR/bin/browser"
MARKET="$ROOT/.claude-plugin/marketplace.json"
TMP="$(mktemp -d)"; trap 'rc=$?; rm -rf "$TMP"; echo "HARNESS-RC=$rc"' EXIT
PASS=0 FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n' "$1" "$2"; fi; }
run() { OUT="$("$@" 2>"$TMP/err")"; RC=$?; ERR="$(cat "$TMP/err")"; }

OLDNOTICE='browser@5dive-plugins is deprecated; it ships from 5dive-ai/5dive-browser now'
NOTICEPAT='is deprecated; it ships from'
_bentry()       { jq -r '.plugins[]|select(.name=="browser")|.description' "$MARKET"; }
_notice_files() { grep -RIl -- "$NOTICEPAT" "$1" 2>/dev/null | wc -l | tr -d '[:space:]'; }

# R1
tc 'R1 the marketplace entry marks this copy deprecated' 'DEPRECATED' "$(_bentry)"
tc 'R1 ...and names where the plugin ships from now' '5dive plugin add 5dive-ai/5dive-browser' "$(_bentry)"
tc 'R1 ...and the remove that has to come first' 'plugin remove browser@5dive-plugins' "$(_bentry)"
t  'R1 (control) no other entry in the manifest is marked deprecated' '0' \
   "$(jq -r '[.plugins[]|select(.name!="browser" and (.description|test("DEPRECATED")))]|length' "$MARKET")"

# R2
SRCDIR="$ROOT/$(jq -r '.plugins[]|select(.name=="browser")|.source' "$MARKET" | sed 's|^\./||')"
t 'R2 (control) the entry source really is the mirrored directory' 'yes' "$([[ "$SRCDIR" -ef "$MIRROR" ]] && echo yes || echo no)"
t 'R2 the notice lives outside it, where a sync cannot reach' 'yes' "$([[ "$MARKET" != "$SRCDIR"/* ]] && echo yes || echo no)"
t 'R2 the manifest name is browser' 'browser' "$(jq -r .name "$MIRROR/.claude-plugin/plugin.json")"

# R3
t 'R3 no copy of the old runtime notice survives inside the mirror' '0' "$(_notice_files "$MIRROR")"
MUT="$TMP/mirror-mutant"; cp -a "$MIRROR" "$MUT"
python3 - "$MUT/bin/browser" "$OLDNOTICE" <<'PY'
import sys
path, line = sys.argv[1], sys.argv[2]
src = open(path).read().split('\n')
i = src.index('set -uo pipefail')      # the first statement, ahead of any dispatch
src[i + 1:i + 1] = ["echo '%s' >&2" % line, "echo '%s'" % line]
open(path, 'w').write('\n'.join(src))
PY
t  'R3 (control) the file detector FINDS the line when a tree carries it' '1' "$(_notice_files "$MUT")"
run bash "$MUT/bin/browser" --help
tc 'R3 (control) ...and running the mutant puts it on stderr' "$OLDNOTICE" "$ERR"
tc 'R3 (control) ...and on stdout, so the stdout arms below can see one too' "$OLDNOTICE" "$OUT"

# R4
run bash "$BROWSER" --help
t  'R4 --help exits 0' 0 "$RC"
tn 'R4 --help carries no notice on stderr' "$NOTICEPAT" "$ERR"
tn 'R4 ...nor on stdout' "$NOTICEPAT" "$OUT"
tc 'R4 (control) ...while the usage itself DID come out on stdout' '5dive browser' "$OUT"
for _v in tree read snapshot run shot; do
  run bash "$BROWSER" "$_v"
  tn "R4 $_v: none on stdout" "$NOTICEPAT" "$OUT"
  tn "R4 $_v: none on stderr" "$NOTICEPAT" "$ERR"
  tc "R4 (control) $_v: it really dispatched and spoke for itself" "usage: 5dive browser $_v" "$ERR"
done

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
