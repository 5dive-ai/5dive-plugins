#!/usr/bin/env bash
# DIVE-9063 — `5dive desktop`, end to end through its spool, with no PC.
#
# The PC's half (the 5dive desktop app polling over the exec tunnel) is played by
# this script calling the app verbs `_poll`, `_result` and `_stopped` itself, the
# way the app does: JSON in on stdin, JSON out. The agent's half is the real
# `snapshot`/`act`, run in the background and waited on.
#
# No root, no network: the spool and the owner's policy file live in a temp dir,
# and the app-uid / policy-owner test seams point at this uid (both are honoured
# only without root). Run: bash tests/desktop_spool_unit.sh
# shellcheck disable=SC2016,SC2001  # jq programs and bash -c bodies are single-quoted on purpose
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/desktop"
BIN="$PLUGIN/bin/desktop"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/       /' <<<"$2"; }
check() { local name="$1"; shift; if "$@" >/dev/null; then ok "$name"; else bad "$name"; fi; }

unset SUDO_USER FIVEDIVE_JSON_MODE
export FIVEDIVE_DESKTOP_SPOOL="$W/spool"
FIVEDIVE_DESKTOP_APP_UID="$(id -u)"; export FIVEDIVE_DESKTOP_APP_UID
export FIVEDIVE_BROWSER_APPROVAL_POLICY="$W/policy.json"
FIVEDIVE_BROWSER_GRANT_UID="$(id -u)"; export FIVEDIVE_BROWSER_GRANT_UID
D() { bash "$BIN" "$@"; }
PC=0b8f7c4e-1111-4222-8333-944455556666
SNAP='{"version":"2.6","ok":true,"command":"snapshot","data":{"app":"Notepad","snapshot_id":"s1","tree":{"role":"window","name":"PRIVATE-SCREEN-MARKER","children":[{"role":"button","name":"Send","ref_id":"@s1:e3"}]}}}'
SECRET_TEXT='hello PRIVATE-TYPED-MARKER'

poll() { D _poll --computer="$PC" --name=OFFICE-PC --wait="${1:-5}" --json; }
result() { local id="$1" body="$2"; printf '%s' "$body" | D _result --id="$id" --json; }
# Wait (up to 5 s) until a background agent has written its request.
queued() { local _; for _ in $(seq 50); do compgen -G "$W/spool/queue/*.json" >/dev/null && return 0; sleep 0.1; done; return 1; }

echo "== M  the manifest, the verb, the registry"
check "plugin.json names the desktop verb" jq -e '.name == "desktop" and .fivedive.contract == "1" and (.fivedive.verbs | any(.name == "desktop")) and (.fivedive.capabilities | index("verb")) and (.fivedive.capabilities | index("skill"))' "$PLUGIN/.claude-plugin/plugin.json"
check "bin/desktop is executable" test -x "$BIN"
check "the marketplace lists desktop at ./plugins/desktop" jq -e '.plugins | any(.name == "desktop" and .source == "./plugins/desktop")' "$ROOT/.claude-plugin/marketplace.json"
check "the use-desktop skill is there" test -s "$PLUGIN/skills/use-desktop/SKILL.md"

echo "== N  no computer has ever checked in"
st=$(D status --json)
check "status: connected false, computer null" jq -e '.connected == false and .computer == null and .enabled == true' <<<"$st"
t0=$(date +%s); D snapshot >/dev/null 2>"$W/err"; rc=$?; t1=$(date +%s)
check "snapshot exits 69 (got $rc)" test "$rc" -eq 69
check "…in under 3 s" test $((t1 - t0)) -lt 3
check "…and says to turn the switch on" grep -q 'Let my agent use this computer' "$W/err"

echo "== P  the app verbs are the app's"
FIVEDIVE_DESKTOP_APP_UID=99999 D _poll --computer="$PC" --wait=0 >/dev/null 2>&1; rc=$?
check "_poll from a non-app uid exits 77 (got $rc)" test "$rc" -eq 77
SUDO_USER=agent-x D _poll --computer="$PC" --wait=0 >/dev/null 2>&1; rc=$?
check "_poll with an agent seat's sudo exits 77 (got $rc)" test "$rc" -eq 77

echo "== C  the PC checks in"
out=$(poll 0)
check "an empty poll answers {jobs:[],cancel:[]}" jq -e '.jobs == [] and .cancel == []' <<<"$out"
st=$(D status --json)
check "status: connected, named, last_seen" jq -e --arg pc "$PC" '.connected == true and .computer.id == $pc and .computer.name == "OFFICE-PC" and (.computer.last_seen | test("Z$"))' <<<"$st"
check "spool modes: queue/results/cancel 1733, claimed 0700, log 0644" \
  test "$(stat -c %a "$W/spool/queue") $(stat -c %a "$W/spool/results") $(stat -c %a "$W/spool/cancel") $(stat -c %a "$W/spool/claimed") $(stat -c %a "$W/spool/log.jsonl")" = "1733 1733 1733 700 644"

echo "== S  snapshot: agent → spool → PC → agent"
D snapshot --app=Notepad --interactive >"$W/s.out" 2>"$W/s.err" & ap=$!
queued
qf=$(compgen -G "$W/spool/queue/*.json" | head -1)
check "the request is 0600" test "$(stat -c %a "$qf")" = 600
out=$(poll 5)
id=$(jq -r '.jobs[0].id // ""' <<<"$out")
check "_poll hands out the snapshot job, once" jq -e --arg me "$(id -un)" '(.jobs | length) == 1 and .jobs[0].op == "snapshot" and .jobs[0].app == "Notepad" and .jobs[0].interactive == true and .jobs[0].agent == $me and .jobs[0].snapshot_argv == ["snapshot","--app","Notepad","-i","--compact"] and (.jobs[0] | has("uid") | not)' <<<"$out"
check "a second poll does not hand it out again" jq -e '.jobs == []' <<<"$(poll 0)"
r=$(result "$id" "$(jq -cn --argjson s "$SNAP" '{ok:true, op:"snapshot", snapshot:$s}')")
check "_result says delivered" jq -e '.delivered == true' <<<"$r"
wait "$ap"; rc=$?
check "the agent exits 0 (got $rc)" test "$rc" -eq 0
check "…and prints the snapshot with its refs" grep -q '@s1:e3' "$W/s.out"
check "the result file is gone after the read" test -z "$(compgen -G "$W/spool/results/*.json")"
check "nothing left claimed" test -z "$(compgen -G "$W/spool/claimed/*")"

echo "== A  act: typed text goes to the PC on stdin, the log keeps its length"
steps=$(jq -cn --arg t "$SECRET_TEXT" '[{"do":"type","ref":"@s1:e2","text":$t},{"do":"press","keys":"ctrl+s"},{"do":"click","ref":"@s1:e3","kind":"send"}]')
D act --app=Notepad --steps="$steps" --json >"$W/a.out" 2>"$W/a.err" & ap=$!
queued
out=$(poll 5)
id=$(jq -r '.jobs[0].id // ""' <<<"$out")
check "the act job carries the agent-desktop argv for each step" jq -e --arg t "$SECRET_TEXT" '.jobs[0].op == "act" and .jobs[0].steps[0].argv == ["type","@s1:e2","--stdin"] and .jobs[0].steps[0].stdin == $t and .jobs[0].steps[1].argv == ["press","ctrl+s"] and .jobs[0].steps[2].argv == ["click","@s1:e3"] and .jobs[0].steps[2].kind == "send"' <<<"$out"
check "typed text is not on any argv" jq -e --arg t "$SECRET_TEXT" '[.jobs[0].steps[].argv[]] | index($t) == null' <<<"$out"
result "$id" "$(jq -cn --argjson s "$SNAP" '{ok:true, op:"act", snapshot:$s, steps:[{ok:true},{ok:true},{ok:true}]}')" >/dev/null
wait "$ap"; rc=$?
check "the agent exits 0 (got $rc)" test "$rc" -eq 0
check "--json carries ok, steps and the fresh snapshot" jq -e '.ok == true and (.steps | length) == 3 and .snapshot.data.snapshot_id == "s1"' "$W/a.out"
last=$(tail -n 1 "$W/spool/log.jsonl")
check "the log line: agent, computer, op, app, steps do/ref/kind, outcome" jq -e --arg me "$(id -un)" '.agent == $me and .computer == "OFFICE-PC" and .op == "act" and .app == "Notepad" and .outcome == "ok" and .steps[0].do == "type" and .steps[0].ref == "@s1:e2" and .steps[2].kind == "send" and .steps[1].keys == "ctrl+s"' <<<"$last"
check "…typed text redacted to its length" jq -e --arg t "$SECRET_TEXT" '.steps[0].text_len == ($t | length) and (.steps[0] | has("text") | not)' <<<"$last"
check "the log holds no typed text and no screen content" bash -c '! grep -q -e PRIVATE-TYPED-MARKER -e PRIVATE-SCREEN-MARKER "$1"' _ "$W/spool/log.jsonl"
check "the spool holds no typed text or screen content after the job" bash -c '! grep -rq -e PRIVATE-TYPED-MARKER -e PRIVATE-SCREEN-MARKER "$1"' _ "$W/spool"
D log >"$W/log.out"; check "log prints the act with the text length" grep -q "(${#SECRET_TEXT} chars)" "$W/log.out"
check "log --json is an array" jq -e 'type == "array" and length >= 2' <<<"$(D log --json --limit=5)"

echo "== O  the owner's policy (the browser's file)"
printf '{"pay":"ask","publish":"ask","send":"ask","delete":"ask"}\n' >"$W/policy.json"
D act --steps='[{"do":"click","ref":"@s1:e3","kind":"send"}]' >/dev/null 2>"$W/p.err"; rc=$?
check "careful + kind=send exits 73 (got $rc)" test "$rc" -eq 73
check "…in the browser's words" grep -q "STOPPED before step 1 — it would send a message" "$W/p.err"
check "…and nothing was queued" test -z "$(compgen -G "$W/spool/queue/*")"
D act --steps='[{"do":"click","ref":"@s1:e3","kind":"post"}]' >/dev/null 2>&1; rc=$?
check "careful + kind=post (the browser's publish) exits 73 (got $rc)" test "$rc" -eq 73
D act --steps='[{"do":"click","ref":"@s1:e3","kind":"send"}]' --json >"$W/p.json" 2>/dev/null
check "--json on a stop: {ok:false, code:73, stop}" jq -e '.ok == false and .code == 73 and .stop.kind == "send"' "$W/p.json"
# A request written into the spool by hand, past the CLI, is held by root at claim.
printf '%s\n' '{"id":"hand-1","op":"act","app":"","steps":[{"do":"click","ref":"@s1:e3","kind":"send"}]}' >"$W/spool/queue/hand-1.json"; chmod 600 "$W/spool/queue/hand-1.json"
out=$(poll 0)
check "root re-reads the policy at claim: the hand-written send is not handed out" jq -e '.jobs == []' <<<"$out"
check "…and its writer is answered needs_owner" jq -e '.error == "needs_owner" and .stop.kind == "send"' "$W/spool/results/hand-1.json"
rm -f "$W/spool/results/hand-1.json"
# A symlink is no policy (the browser's rule): the defaults apply, and pay asks.
rm -f "$W/policy.json"; printf '{"pay":"allow"}\n' >"$W/yolo.json"; ln -s "$W/yolo.json" "$W/policy.json"
D act --steps='[{"do":"click","ref":"@s1:e3","kind":"pay"}]' >/dev/null 2>&1; rc=$?
check "a symlinked policy is no policy: pay still asks, 73 (got $rc)" test "$rc" -eq 73
D act --steps='[{"do":"click","ref":"@s1:e3","kind":"shop"}]' >/dev/null 2>&1; rc=$?
check "an unknown kind is a usage error (got $rc)" test "$rc" -eq 64
D act --steps='[{"do":"rm","ref":"@s1:e3"}]' >/dev/null 2>&1; rc=$?
check "an unknown do is a usage error (got $rc)" test "$rc" -eq 64
D act --steps='[{"do":"click","ref":"Send button"}]' >/dev/null 2>&1; rc=$?
check "a made-up ref is a usage error (got $rc)" test "$rc" -eq 64
check "…and none of them queued anything" test -z "$(compgen -G "$W/spool/queue/*")"

echo "== X  Stop by the owner"
D snapshot --app=Notepad >/dev/null 2>"$W/x.err" & ap=$!
queued
out=$(poll 5); id=$(jq -r '.jobs[0].id // ""' <<<"$out")
st=$(D _stopped --computer="$PC" --json)
check "_stopped names the claimed job" jq -e --arg id "$id" '.ok == true and (.stopped | index($id))' <<<"$st"
wait "$ap"; rc=$?
check "the waiting agent exits 75 (got $rc)" test "$rc" -eq 75
check "…and is told not to retry on its own" grep -q 'pressed Stop' "$W/x.err"
check "a late _result for it is ignored" jq -e '.delivered == false' <<<"$(result "$id" '{"ok":true}')"
D snapshot >/dev/null 2>&1 & ap=$!
queued
D _stopped --computer="$PC" --json >/dev/null
wait "$ap"; rc=$?
check "a queued (unclaimed) job is stopped too: exit 75 (got $rc)" test "$rc" -eq 75
check "the log says stopped" test "$(grep -c '"outcome":"stopped"' "$W/spool/log.jsonl")" -ge 2

echo "== T  the PC does not answer"
poll 0 >/dev/null
D snapshot --timeout=2 >/dev/null 2>&1; rc=$?
check "an unclaimed job times out with 124 (got $rc)" test "$rc" -eq 124
check "…and is taken back out of the queue" test -z "$(compgen -G "$W/spool/queue/*")"
D snapshot --timeout=2 >/dev/null 2>&1 & ap=$!
queued
out=$(poll 5); id=$(jq -r '.jobs[0].id // ""' <<<"$out")
wait "$ap"; rc=$?
check "a claimed job the PC never answers: 124 (got $rc)" test "$rc" -eq 124
out=$(poll 0)
check "the next poll tells the PC to cancel it" jq -e --arg id "$id" '.cancel == [$id]' <<<"$out"
check "the log says cancelled" grep -q '"outcome":"cancelled"' "$W/spool/log.jsonl"

echo "== B  an answer over 64 KB"
D snapshot >/dev/null 2>"$W/b.err" & ap=$!
queued
out=$(poll 5); id=$(jq -r '.jobs[0].id // ""' <<<"$out")
big=$(head -c 70000 /dev/zero | tr '\0' a)
printf '{"ok":true,"snapshot":"%s"}' "$big" | D _result --id="$id" --json >/dev/null 2>&1; rc=$?
check "_result refuses it (got $rc)" test "$rc" -eq 64
wait "$ap"; rc=$?
check "…and the agent gets a failure, not a hang: exit 1 (got $rc)" test "$rc" -eq 1

echo "== F  a step the PC ran and that failed"
D act --steps='[{"do":"click","ref":"@s1:e9"}]' >"$W/f.out" 2>&1 & ap=$!
queued
out=$(poll 5); id=$(jq -r '.jobs[0].id // ""' <<<"$out")
result "$id" '{"ok":false,"op":"act","steps":[{"ok":false,"error":"STALE_REF"}],"error":"STALE_REF"}' >/dev/null
wait "$ap"; rc=$?
check "exit 1 (got $rc) and the step's error is printed" bash -c '[[ $1 -eq 1 ]] && grep -q "step 1: FAILED — STALE_REF" "$2"' _ "$rc" "$W/f.out"

echo "== L  the PC went quiet (no poll in 30 s)"
jq -c '.last_seen_at -= 31' "$W/spool/computers/$PC.json" >"$W/c" && cat "$W/c" >"$W/spool/computers/$PC.json"
st=$(D status --json)
check "status: not connected, last computer still named" jq -e '.connected == false and .computer.name == "OFFICE-PC"' <<<"$st"
t0=$(date +%s); D snapshot >/dev/null 2>&1; rc=$?; t1=$(date +%s)
check "snapshot exits 69 (got $rc) in under 3 s" bash -c '[[ $1 -eq 69 && $2 -lt 3 ]]' _ "$rc" $((t1 - t0))

echo "== W  the box's own switch"
poll 0 >/dev/null
D off >/dev/null
check "off: status enabled false, connected false" jq -e '.enabled == false and .connected == false' <<<"$(D status --json)"
D snapshot >/dev/null 2>&1; rc=$?
check "off: snapshot exits 69 (got $rc)" test "$rc" -eq 69
SUDO_USER=agent-x D on >/dev/null 2>&1; rc=$?
check "an agent seat cannot turn it back on (got $rc)" test "$rc" -eq 77
D on >/dev/null
check "on: enabled again" jq -e '.enabled == true' <<<"$(D status --json)"

echo
echo "desktop spool: $PASS passed, $FAIL failed"
(( FAIL == 0 ))
