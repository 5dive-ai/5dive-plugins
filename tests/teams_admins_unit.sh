#!/usr/bin/env bash
# DIVE-7976 — `5dive agent teams admins`: who is an admin on this box. Runs as
# root (the roles file is root's), so: sudo bash tests/teams_admins_unit.sh
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0" >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/plugins/teams/bin/teams"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; chmod 755 "$W"
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/       /' <<<"$2"; }
export FIVEDIVE_ROLES_FILE="$W/roles.json" TEAMS_5DIVE_BIN=/bin/true
run() { bash "$BIN" agent admins "$@" 2>&1; }
A=0b6a1f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b

out=$(run); [[ $? -eq 0 && "$out" == *"No admins yet"* ]] && ok "no file: nobody is an admin, and it says so" || bad "empty list" "$out"
out=$(run add "${A^^}"); rc=$?
[[ $rc -eq 0 ]] && jq -e --arg k "teams:$A" '.admins == [$k] and .check == "on"' "$W/roles.json" >/dev/null \
  && ok "add stores teams:<id>, lowercased" || bad "add (rc=$rc)" "$out"
[[ "$(stat -c '%a %U' "$W/roles.json")" == "644 root" ]] && ok "the file is root's, readable by the agents (0644)" || bad "mode $(stat -c '%a %U' "$W/roles.json")"
run add "$A" >/dev/null; [[ $(jq '.admins | length' "$W/roles.json") -eq 1 ]] && ok "adding twice keeps one entry" || bad "dup"
out=$(run add telegram:1234567890); jq -e '.admins | index("telegram:1234567890")' "$W/roles.json" >/dev/null && ok "a Telegram id is keyed telegram:<id>" || bad "telegram" "$out"
out=$(run add 'I am admin'); rc=$?; [[ $rc -eq 3 ]] && ok "a non-id is refused" || bad "bad id (rc=$rc)" "$out"
out=$(run list); [[ "$out" == *"teams:$A"* && "$out" == *"member"* ]] && ok "list names the admins and says the rest are members" || bad "list" "$out"
out=$(run members-may delete,send); [[ $(jq -c .members_may "$W/roles.json") == '["delete","send"]' ]] && ok "members-may widens named kinds" || bad "widen" "$out"
out=$(run members-may wire); [[ $? -eq 3 ]] && ok "an unknown kind is refused" || bad "kind" "$out"
run members-may none >/dev/null; [[ $(jq -c .members_may "$W/roles.json") == '[]' ]] && ok "members-may none narrows back" || bad "none"
run check off >/dev/null; [[ $(jq -r .check "$W/roles.json") == off ]] && [[ "$(run)" == *"Roles are off"* ]] && ok "check off is stored and shown" || bad "off"
run check on >/dev/null; [[ $(jq -r .check "$W/roles.json") == on ]] && ok "check on" || bad "on"
out=$(run remove "$A"); jq -e --arg k "teams:$A" '.admins | index($k) | not' "$W/roles.json" >/dev/null && ok "remove makes them a member" || bad "remove" "$out"
out=$(run remove "$A"); [[ $? -eq 4 ]] && ok "removing a non-admin is not-found" || bad "remove twice" "$out"
cp "$BIN" "$W/teams-bin"; chmod 755 "$W/teams-bin"   # the checkout may sit in a home nobody cannot enter
out=$(setpriv --reuid=65534 --regid=65534 --clear-groups env FIVEDIVE_ROLES_FILE="$W/roles.json" bash "$W/teams-bin" agent admins add "$A" 2>&1); rc=$?
[[ $rc -eq 10 ]] && ! jq -e --arg k "teams:$A" '.admins | index($k)' "$W/roles.json" >/dev/null && ok "a non-root user (an agent) cannot make anyone admin" || bad "non-root (rc=$rc)" "$out"
out=$(setpriv --reuid=65534 --regid=65534 --clear-groups env FIVEDIVE_ROLES_FILE="$W/roles.json" bash "$W/teams-bin" agent admins 2>&1); [[ $? -eq 0 ]] && ok "anyone may read the list" || bad "non-root read" "$out"
echo '{broken' >"$W/roles.json"; out=$(run add "$A"); rc=$?
[[ $rc -eq 3 && "$(cat "$W/roles.json")" == '{broken' ]] && ok "a broken file is refused, not overwritten" || bad "broken (rc=$rc)" "$out"
echo "teams admins: $PASS pass, $FAIL fail"
(( FAIL == 0 ))
