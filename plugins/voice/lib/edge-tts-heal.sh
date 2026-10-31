#!/usr/bin/env bash
# edge-tts-heal — upgrade edge-tts in the voice venv, at most once an hour, so
# a box heals itself when Microsoft rotates the free voice's client token
# (DIVE-7409). Installed to /usr/local/lib/5dive/edge-tts-heal; 5dive-speak runs
# it (through `sudo -n` when the caller is a seat that cannot write the venv)
# after edge-tts has failed, and retries the reply only on exit 0.
#
# WHY NOT WAIT FOR THE NIGHTLY. The nightly upgrade (5dive-setup-voice tts,
# DIVE-6436) leaves every spoken reply failing from the rotation until 03:00,
# and a self-hosted box with auto-update off never runs it: it kept its
# install-day edge-tts until someone reinstalled. This runs on the failure
# itself, on any box that has the voice engine.
#
# It takes no arguments on purpose: the sudoers line that lets every seat run
# it allows exactly this command with no arguments, so a seat can make it
# upgrade one package from PyPI and nothing else.
#
# Exit: 0 edge-tts changed version (now or in the last few minutes, by another
# caller): try again · 1 nothing changed (already the newest, or pip failed)
# · 75 already tried within the hour · 2 no edge-tts venv on this box.
set -uo pipefail

VENV="${VOICE_VENV:-/home/claude/.venv}"
STATE="${VOICE_HEAL_STATE:-${STATE_DIR:-/var/lib/5dive}/voice/edge-tts-heal}"
REQ="${EDGE_TTS_REQ:-edge-tts>=7.3.1}"
EVERY="${VOICE_HEAL_EVERY:-3600}"   # seconds between upgrade attempts
FRESH=300                           # an upgrade this recent counts for every caller

[[ -x "$VENV/bin/edge-tts" && -x "$VENV/bin/pip" ]] || exit 2
mkdir -p "$(dirname "$STATE")" 2>/dev/null || true

# One caller upgrades; the rest wait for it and then read its result, so a
# burst of failing replies across seats costs one pip run, not one per reply.
exec 9>>"$STATE.lock" || exit 1
flock -w 300 9 || exit 1

now=$(date +%s)
last=0 changed=0
# The stamp: "<epoch of the last attempt> <1 if it changed the version>".
[[ -r "$STATE" ]] && read -r last changed < "$STATE" 2>/dev/null
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < EVERY )); then
  (( changed == 1 && now - last < FRESH )) && exit 0
  exit 75
fi
printf '%s 0\n' "$now" > "$STATE"

ver() { "$VENV/bin/pip" show edge-tts 2>/dev/null | sed -n 's/^Version: *//p'; }

# Run pip as the venv's owner, never as root: a root pip would leave root-owned
# files that the owner's next pip cannot replace.
owner=$(stat -c %U "$VENV")
pip=("$VENV/bin/pip")
[[ $EUID -eq 0 && "$owner" != root ]] && pip=(runuser -u "$owner" -- "$VENV/bin/pip")

before=$(ver)
if ! timeout 120 "${pip[@]}" install --quiet --disable-pip-version-check --upgrade "$REQ" >&2; then
  echo "edge-tts-heal: could not upgrade edge-tts (${before:-unknown} kept)" >&2
  exit 1
fi
after=$(ver)
[[ -d /usr/local/bin && -w /usr/local/bin ]] && ln -sf "$VENV/bin/edge-tts" /usr/local/bin/edge-tts 2>/dev/null
logger -t edge-tts-heal "edge-tts ${before:-unknown} -> ${after:-unknown}" 2>/dev/null || true
if [[ -n "$after" && "$before" != "$after" ]]; then
  printf '%s 1\n' "$now" > "$STATE"
  echo "edge-tts-heal: upgraded edge-tts ${before:-unknown} -> $after" >&2
  exit 0
fi
echo "edge-tts-heal: edge-tts ${after:-unknown} is already the newest" >&2
exit 1
