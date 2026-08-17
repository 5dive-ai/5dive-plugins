#!/usr/bin/env bash
# publish-profile.sh — give every 5dive agent a FACE on the Buzz relay.
#
# Buzz renders an agent from its kind:0 profile. `buzz:configure` step 3
# publishes a name and nothing else, so `picture` is absent on every identity
# and the room is a wall of blank circles. This publishes the missing field.
#
#   ./publish-profile.sh --all               # every seat that has a buzz config
#   ./publish-profile.sh dev don             # named seats
#   ./publish-profile.sh --all --dry-run     # resolve + probe, publish nothing
#
# Avatar resolution, first URL that actually answers 200 wins:
#   1. character-packs  packs/<persona>/avatar.png   — the persona's card art
#   2. openagent        faces/<persona>.png
#   3. this plugin      marks/<agent type>.png       — the type mark fallback
#   4. this plugin      marks/agent.png
#
# The probe is on the URL, not on a local file: what has to resolve is what the
# CLIENT will fetch. A tier whose repo has not merged yet simply falls through.
#
# kind:0 is a REPLACING event — publishing only `--avatar` would erase the name
# and about text that are already there, so both are read back and re-sent.
#
# Every publish is verified by READING THE PROFILE BACK and asserting `picture`
# is the URL we sent. `set-profile` answers `accepted:true` on writes that are
# not subsequently readable (measured on presence, DIVE-3507), so an accepted
# write is not evidence of a rendered avatar.
set -uo pipefail

PACK_URL='https://raw.githubusercontent.com/5dive-ai/character-packs/main/packs/%s/avatar.png'
FACE_URL='https://raw.githubusercontent.com/5dive-ai/openagent/main/faces/%s.png'
# Overridable so the mark tier can be positive-controlled against a pushed
# branch before it merges — an unreachable tier is silently skipped, so
# "the mark fallback works" needs a run where the mark is what actually landed.
MARK_URL="${BUZZ_MARK_URL:-https://raw.githubusercontent.com/5dive-ai/5dive-plugins/main/plugins/buzz/marks/%s.png}"

DRY_RUN=0
SEATS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --all)     SEATS+=(--all) ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*)        echo "unknown flag: $arg" >&2; exit 1 ;;
    *)         SEATS+=("$arg") ;;
  esac
done
[ ${#SEATS[@]} -gt 0 ] || { echo "usage: $0 [--all|<agent>...] [--dry-run]" >&2; exit 1; }

# Seat name -> buzz config path. The `claude` seat lives outside the agent-* tree.
config_path() {
  case "$1" in
    claude) echo "/home/claude/.claude/channels/buzz/config.json" ;;
    *)      echo "/home/agent-$1/.claude/channels/buzz/config.json" ;;
  esac
}

if [ "${SEATS[0]}" = "--all" ]; then
  SEATS=()
  for cfg in /home/agent-*/.claude/channels/buzz/config.json /home/claude/.claude/channels/buzz/config.json; do
    [ -e "$cfg" ] || continue
    seat=${cfg#/home/}; seat=${seat%%/.claude/*}; seat=${seat#agent-}
    SEATS+=("$seat")
  done
fi

# Runtime type per seat, for the mark fallback. A seat missing from the roster
# is not an error — it gets the generic mark.
TYPES=$(sudo 5dive agent list --json 2>/dev/null | python3 -c "
import json, sys
try:
    rows = json.load(sys.stdin)['data']
except Exception:
    rows = []
for a in rows:
    print(a.get('name', ''), a.get('type', 'agent'))
" 2>/dev/null)

type_of() { echo "$TYPES" | awk -v n="$1" '$1==n{print $2; f=1} END{if(!f)print "agent"}' | head -1; }

# "Lil bro" -> lilbro, "Marcus-2" -> marcus. A clone shares its origin's art.
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g; s/[0-9]*$//'
}

url_ok() { [ "$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>/dev/null)" = "200" ]; }

fail=0 published=0 skipped=0

for seat in "${SEATS[@]}"; do
  cfg=$(config_path "$seat")
  raw=$(sudo cat "$cfg" 2>/dev/null) || { echo "SKIP  $seat — no buzz config at $cfg"; skipped=$((skipped+1)); continue; }
  relay=$(echo "$raw" | python3 -c 'import json,sys; print(json.load(sys.stdin)["relay_url"])' 2>/dev/null)
  key=$(echo "$raw"   | python3 -c 'import json,sys; print(json.load(sys.stdin)["private_key"])' 2>/dev/null)
  [ -n "$relay" ] && [ -n "$key" ] || { echo "SKIP  $seat — unreadable config"; skipped=$((skipped+1)); continue; }

  export BUZZ_RELAY_URL="$relay" BUZZ_PRIVATE_KEY="$key"

  # One field per line — a display_name with a space ("Lil bro") must not split.
  fields=$(buzz users get 2>/dev/null | python3 -c "
import json, sys
try:
    p = json.load(sys.stdin)[0]
except Exception:
    p = {}
for k in ('pubkey', 'display_name', 'about'):
    print(str(p.get(k, '') or '').replace('\n', ' '))
" 2>/dev/null)
  pubkey=$(sed -n 1p <<<"$fields")
  name=$(sed -n 2p <<<"$fields")
  about=$(sed -n 3p <<<"$fields")
  [ -n "$name" ] || name="$seat"

  persona=$(slugify "$name")
  [ -n "$persona" ] || persona=$(slugify "$seat")
  type=$(type_of "$seat")

  url=""; tier=""
  for candidate in \
      "pack:$(printf "$PACK_URL" "$persona")" \
      "face:$(printf "$FACE_URL" "$persona")" \
      "mark:$(printf "$MARK_URL" "$type")" \
      "mark:$(printf "$MARK_URL" agent)"; do
    if url_ok "${candidate#*:}"; then tier="${candidate%%:*}"; url="${candidate#*:}"; break; fi
  done

  if [ -z "$url" ]; then
    echo "FAIL  $seat — no avatar URL resolves (persona=$persona type=$type); the mark fallback is unreachable"
    fail=$((fail+1)); continue
  fi

  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY   $seat ($name) <- $tier $url"
    continue
  fi

  out=$(buzz users set-profile --name "$name" --about "$about" --avatar "$url" 2>&1)
  if ! echo "$out" | grep -q '"accepted":true'; then
    echo "FAIL  $seat — set-profile rejected: $(echo "$out" | head -c 200)"
    fail=$((fail+1)); continue
  fi

  # The assertion the row exists for: read it back, do not trust accepted:true.
  got=$(buzz users get ${pubkey:+--pubkey "$pubkey"} 2>/dev/null | python3 -c '
import json,sys
try: print(json.load(sys.stdin)[0].get("picture",""))
except Exception: print("")' 2>/dev/null)
  if [ "$got" = "$url" ]; then
    echo "OK    $seat ($name) <- $tier $url"
    published=$((published+1))
  else
    echo "FAIL  $seat — write accepted but read-back picture is '${got:-<empty>}', expected $url"
    fail=$((fail+1))
  fi
done

echo "---"
echo "published=$published skipped=$skipped failed=$fail"
[ "$fail" -eq 0 ]
