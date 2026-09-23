#!/usr/bin/env bash
# 5dive-transcribe — turn a voice file into text.
#
# TWO BACKENDS, ONE OUTPUT CONTRACT (DIVE-4439):
#   local       (default) POST to the warm whisper-service on :8765. Audio never
#               leaves the box.
#   openrouter  POST to OpenRouter's /audio/transcriptions. More accurate, costs
#               about $0.00006 for a 20s note — AND THE AUDIO LEAVES THE BOX.
# Switch with:  sudo 5dive voice backend local|openrouter
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

BACKEND="${BACKEND_OVERRIDE:-$(voice_effective_backend)}"

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
  voice_require_cmd jq || return 1
  local ext staged payload resp
  ext="${SRC##*.}"; [[ "$ext" == "$SRC" ]] && ext="bin"
  staged="$(mktemp --suffix=".${ext}" /tmp/5dive-transcribe.XXXXXX)"
  chmod 644 "$staged"
  cp -- "$SRC" "$staged" || { rm -f "$staged"; return 1; }
  payload=$(jq -nc --arg p "$staged" '{path:$p}')
  resp=$(curl -fsS --max-time 120 \
    -H "Content-Type: application/json" \
    -X POST http://127.0.0.1:8765/transcribe \
    --data "$payload") || { rm -f "$staged"; echo "5dive voice: whisper-service on :8765 did not answer (sudo systemctl status whisper-service)" >&2; return 1; }
  rm -f "$staged"
  if (( JSON_OUT )); then printf '%s\n' "$resp"
  else printf '%s' "$resp" | jq -r .text; fi
}

case "$BACKEND" in
  openrouter) transcribe_openrouter ;;
  local)      transcribe_local ;;
  *)          echo "5dive voice: unknown backend '$BACKEND'" >&2; exit 2 ;;
esac
