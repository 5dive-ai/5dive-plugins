#!/usr/bin/env bash
# 5dive-transcribe — turn a voice file into text.
#
# TWO BACKENDS, ONE OUTPUT CONTRACT (DIVE-4439):
#   local       (default) POST to the warm whisper-service on :8765. Audio never
#               leaves the box.
#   openrouter  POST to OpenRouter's /audio/transcriptions. More accurate, costs
#               about $0.00006 for a 20s note — AND THE AUDIO LEAVES THE BOX.
# Switch with:  sudo 5dive voice backend local|openrouter
# Hearing alone: sudo 5dive voice config set stt_backend local|openrouter
#
# WHEN LOCAL HEARING FAILS (DIVE-5398). A box that already SPEAKS on OpenRouter
# (backend=openrouter, hearing split off with stt_backend=local — the 5dive box
# default) hears that one note on OpenRouter instead, and says so on stderr.
# Its reply text already goes there, so the audio following it moves no new
# kind of data off the box, and a note the user already sent is not dropped.
# A box whose `backend` is local keeps the one-way rule in voice-backend.sh:
# it never reaches the network, whatever key sits on disk. If nothing can hear
# the note, stderr tells the calling agent to ask the user to type: the owner of
# a Mini App box has no shell, so a sudo hint relayed to them is a dead end.
#
# stdout is identical either way: the transcript, one line, nothing else. That
# is load-bearing — every agent on the box already parses it, and a backend
# switch that changed the output shape would be a rewrite disguised as a flag.
#
# faster-whisper runs as user `claude` (whisper-service.service) and can't read
# /home/agent-<name>/.claude/channels/telegram/inbox/*.oga (mode 0700 home), so
# the file is staged under /tmp first. Wrapping cp + curl behind a single binary
# lets agents pre-allow Bash(5dive-transcribe:*) — without it every voice
# message would prompt the user.
#
# Usage:
#   5dive-transcribe <path>            # plain text on stdout
#   5dive-transcribe --json <path>     # full backend JSON response
#   5dive-transcribe --backend=<b> ... # override for one call (testing)
set -uo pipefail

# shellcheck source=/dev/null
. /usr/local/lib/5dive/voice-backend.sh

JSON_OUT=0
BACKEND_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUT=1; shift ;;
    --backend=*) BACKEND_OVERRIDE="${1#*=}"; shift ;;
    --) shift; break ;;
    -*) echo "usage: 5dive-transcribe [--json] [--backend=local|openrouter] <audio-path>" >&2; exit 2 ;;
    *) break ;;
  esac
done

SRC="${1:-}"
[[ -n "$SRC" && -f "$SRC" ]] \
  || { echo "usage: 5dive-transcribe [--json] [--backend=local|openrouter] <audio-path>" >&2; exit 2; }

BACKEND="${BACKEND_OVERRIDE:-$(voice_effective_stt_backend)}"
# The warm whisper-service. Overridable so the offline harness can run its own
# fake beside a real service that already holds :8765.
WHISPER_URL="${VOICE_WHISPER_URL:-http://127.0.0.1:8765}"
# Why local hearing failed, in one line; set by transcribe_local.
LOCAL_FAIL=""

transcribe_openrouter() {
  voice_require_cmd ffmpeg || return 1
  voice_require_cmd jq || return 1
  local model wav resp
  model=$(voice_stt_model)
  wav="$(mktemp --suffix=.wav /tmp/5dive-transcribe.XXXXXX)"
  # Mono 16-bit 16 kHz PCM: what every model on the endpoint accepts, and the
  # ONLY thing meta/muse-voice-transcribe-1.0 accepts. Converting unconditionally
  # is cheaper than branching per model and keeps Telegram's OGG/Opus working.
  if ! ffmpeg -hide_banner -loglevel error -y -i "$SRC" -ac 1 -ar 16000 -sample_fmt s16 "$wav" </dev/null; then
    rm -f "$wav"; echo "5dive voice: ffmpeg could not decode $SRC" >&2; return 1
  fi
  resp=$(voice_openrouter_curl /audio/transcriptions \
    -F "model=${model}" -F "response_format=json" -F "file=@${wav};type=audio/wav") || { rm -f "$wav"; return 1; }
  rm -f "$wav"
  if (( JSON_OUT )); then printf '%s\n' "$resp"
  else printf '%s' "$resp" | jq -r '.text // empty'; fi
}

transcribe_local() {
  voice_require_cmd jq || { LOCAL_FAIL="jq is missing"; return 1; }
  local ext staged payload resp code
  ext="${SRC##*.}"; [[ "$ext" == "$SRC" ]] && ext="bin"
  staged="$(mktemp --suffix=".${ext}" /tmp/5dive-transcribe.XXXXXX)"
  chmod 644 "$staged"
  cp -- "$SRC" "$staged" || { rm -f "$staged"; LOCAL_FAIL="could not stage the file for whisper-service"; return 1; }
  payload=$(jq -nc --arg p "$staged" '{path:$p}')
  # No -f: a 500 carries the service's own reason in its JSON body, and curl -f
  # throws that away, which is how a dependency break read as "500" and nothing
  # more (DIVE-5398).
  resp=$(curl -sS --max-time 120 -w '\n%{http_code}' \
    -H "Content-Type: application/json" \
    -X POST "${WHISPER_URL}/transcribe" \
    --data "$payload" 2>/dev/null) || { rm -f "$staged"; LOCAL_FAIL="whisper-service did not answer"; return 1; }
  rm -f "$staged"
  code="${resp##*$'\n'}"; resp="${resp%$'\n'*}"
  if [[ "$code" != 2* ]]; then
    LOCAL_FAIL="whisper-service answered HTTP ${code}: $(printf '%s' "$resp" | jq -r '.error // empty' 2>/dev/null | head -c 300)"
    return 1
  fi
  if (( JSON_OUT )); then printf '%s\n' "$resp"
  else printf '%s' "$resp" | jq -r .text; fi
}

# hearing_failed [<reason>] — nothing could hear the note. The second line is
# addressed to the agent that called us, because it is the one that relays it.
hearing_failed() {
  echo "5dive voice: could not hear this voice note${1:+ (${1})}." >&2
  echo "5dive voice: ask the user to type their message instead. Do not ask them to run a command or restart anything." >&2
  exit 1
}

# may_fall_back — local hearing failed: may this note go to OpenRouter? Only on
# a box that already speaks there, with a key, and never on a call that forced
# --backend=local (that is someone testing the local engine on purpose).
may_fall_back() {
  [[ -z "$BACKEND_OVERRIDE" ]] || return 1
  [[ "$(voice_backend_configured)" == openrouter ]] || return 1
  voice_openrouter_key >/dev/null 2>&1
}

case "$BACKEND" in
  openrouter) transcribe_openrouter || hearing_failed ;;
  local)
    transcribe_local && exit 0
    may_fall_back || hearing_failed "$LOCAL_FAIL"
    echo "5dive voice: local hearing failed (${LOCAL_FAIL}); heard this note on OpenRouter instead." >&2
    transcribe_openrouter || hearing_failed "$LOCAL_FAIL; OpenRouter failed too"
    ;;
  *)          echo "5dive voice: unknown backend '$BACKEND'" >&2; exit 2 ;;
esac
