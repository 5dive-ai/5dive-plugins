#!/usr/bin/env bash
# 5dive-speak — turn text into a Telegram-ready OGG/Opus voice reply.
#
# THIS WRAPPER EXISTS BECAUSE THE "LOCAL" HALF WAS NEVER LOCAL (DIVE-4439).
# Until now agents were told, in projects/CLAUDE.md, to "use edge-tts with
# ffmpeg". edge-tts is an UNOFFICIAL client for Microsoft Edge's ONLINE neural
# voices: every reply's text already left the box, and the client breaks
# whenever Microsoft rotates its token scheme. So there was no backend to
# choose between — there was one undeclared network call. Both backends now go
# through one wrapper that says which is which:
#
#   local       edge-tts (free; reply TEXT goes to Microsoft — see above)
#   openrouter  OpenRouter /audio/speech (paid, official, ~$0.0045 per 300-char
#               reply; reply TEXT goes to OpenRouter and its upstream)
#
# Neither keeps text on the box. That is the honest statement, and it is why
# the README wording changed rather than the default.
#
# Usage:
#   5dive-speak "some text"                 # prints the .ogg path on stdout
#   5dive-speak --out=reply.ogg "some text"
#   printf '%s' "$long" | 5dive-speak -     # read the text from stdin
#   5dive-speak --voice=<v> ... --backend=local|openrouter
set -uo pipefail

# shellcheck source=/dev/null
. /usr/local/lib/5dive/voice-backend.sh

OUT=""
VOICE_OVERRIDE=""
BACKEND_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out=*)     OUT="${1#*=}"; shift ;;
    --voice=*)   VOICE_OVERRIDE="${1#*=}"; shift ;;
    --backend=*) BACKEND_OVERRIDE="${1#*=}"; shift ;;
    -h|--help)
      sed -n '/^# Usage:/,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//; $d'; exit 0 ;;
    --) shift; break ;;
    -) break ;;
    -*) echo "usage: 5dive-speak [--out=<file.ogg>] [--voice=<v>] [--backend=local|openrouter] <text>|-" >&2; exit 2 ;;
    *) break ;;
  esac
done

TEXT="${1:-}"
if [[ "$TEXT" == "-" || -z "$TEXT" ]]; then TEXT="$(cat)"; fi
[[ -n "${TEXT//[[:space:]]/}" ]] \
  || { echo "usage: 5dive-speak [--out=<file.ogg>] <text>|-" >&2; exit 2; }

[[ -n "$OUT" ]] || OUT="$(mktemp --suffix=.ogg /tmp/5dive-speak.XXXXXX)"
BACKEND="${BACKEND_OVERRIDE:-$(voice_effective_backend)}"

voice_require_cmd ffmpeg || exit 1

# Telegram plays a voice message only as OGG/Opus; anything else arrives as a
# file attachment with a paperclip. Both backends emit MP3, so the conversion is
# the shared tail, not a per-backend detail.
to_ogg() {  # to_ogg <src-mp3>
  ffmpeg -hide_banner -loglevel error -y -i "$1" -c:a libopus -b:a 32k -ar 48000 -ac 1 "$OUT" </dev/null
}

speak_local() {
  local voice mp3
  voice="${VOICE_OVERRIDE:-$(voice_config_get edge_voice "$VOICE_DEFAULT_EDGE_VOICE")}"
  voice_require_cmd edge-tts || return 1
  mp3="$(mktemp --suffix=.mp3 /tmp/5dive-speak.XXXXXX)"
  if ! edge-tts --voice "$voice" --text "$TEXT" --write-media "$mp3" >/dev/null 2>&1; then
    rm -f "$mp3"
    echo "5dive voice: edge-tts failed. It is an unofficial client for Microsoft's online voices and breaks when Microsoft rotates its tokens; 'sudo 5dive voice backend openrouter' is the supported path." >&2
    return 1
  fi
  to_ogg "$mp3"; local rc=$?; rm -f "$mp3"; return $rc
}

speak_openrouter() {
  local model voice mp3
  model=$(voice_tts_model); voice="${VOICE_OVERRIDE:-$(voice_tts_voice)}"
  voice_require_cmd jq || return 1
  mp3="$(mktemp --suffix=.mp3 /tmp/5dive-speak.XXXXXX)"
  if ! VOICE_OR_ERRFILE="$mp3" voice_openrouter_curl /audio/speech \
        -H "Content-Type: application/json" \
        --data "$(jq -nc --arg m "$model" --arg i "$TEXT" --arg v "$voice" \
                    '{model:$m, input:$i, voice:$v, response_format:"mp3"}')" \
        --output "$mp3" >/dev/null; then
    rm -f "$mp3"; return 1
  fi
  to_ogg "$mp3"; local rc=$?; rm -f "$mp3"; return $rc
}

case "$BACKEND" in
  openrouter) speak_openrouter || exit 1 ;;
  local)      speak_local || exit 1 ;;
  *)          echo "5dive voice: unknown backend '$BACKEND'" >&2; exit 2 ;;
esac

printf '%s\n' "$OUT"
