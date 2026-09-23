#!/usr/bin/env bash
# voice-backend.sh — the ONE definition of "which backend is voice using, and
# can it actually run?", sourced by /usr/local/bin/5dive-transcribe and
# /usr/local/bin/5dive-speak. Installed to /usr/local/lib/5dive/voice-backend.sh.
#
# It lives in one file on purpose. 5dive-setup-voice already carries the lesson
# one layer down ("a guard restated in three places is a guard that silently
# goes missing from one"), and the fallback rule below is exactly that shape:
# hearing and speaking must agree about where the audio goes, or a box ends up
# transcribing locally while narrating to a vendor.
#
# NOTHING SECRET IS WRITTEN HERE. The config file records a choice; the key
# stays in /etc/5dive/connectors, root-owned, group-readable, as every other
# provider key on the box already is.

VOICE_STATE_DIR="${VOICE_STATE_DIR:-${STATE_DIR:-/var/lib/5dive}/voice}"
VOICE_CONFIG="${VOICE_CONFIG:-$VOICE_STATE_DIR/config}"
VOICE_CONNECTORS_DIR="${VOICE_CONNECTORS_DIR:-/etc/5dive/connectors}"
VOICE_OPENROUTER_BASE="${VOICE_OPENROUTER_BASE:-https://openrouter.ai/api/v1}"

# Defaults chosen on the 2026-09-13 measurement in the DIVE-4439 body:
# whisper-large-v3-turbo is $0.011/hr, 99+ languages incl. Russian, 12% WER.
# Muse is more accurate in English and does NOT validate Russian/Ukrainian, so
# it is selectable, never the default.
VOICE_DEFAULT_STT_MODEL="${VOICE_DEFAULT_STT_MODEL:-openai/whisper-large-v3-turbo}"
VOICE_DEFAULT_TTS_MODEL="${VOICE_DEFAULT_TTS_MODEL:-microsoft/mai-voice-2-flash}"
VOICE_DEFAULT_TTS_VOICE="${VOICE_DEFAULT_TTS_VOICE:-alloy}"
VOICE_DEFAULT_EDGE_VOICE="${VOICE_DEFAULT_EDGE_VOICE:-en-US-AriaNeural}"

# voice_config_get <key> [<default>] — reads one key=value line. Never sourced:
# this file is root-written but a `.` of a config file is still an eval, and the
# format has no need for one.
voice_config_get() {
  local key="$1" def="${2:-}" val=""
  if [[ -r "$VOICE_CONFIG" ]]; then
    val=$(grep -m1 "^${key}=" "$VOICE_CONFIG" 2>/dev/null | cut -d= -f2-)
  fi
  printf '%s\n' "${val:-$def}"
}

# voice_backend_configured — what the box was TOLD to use (local|openrouter).
voice_backend_configured() {
  local b; b=$(voice_config_get backend local)
  case "$b" in openrouter) printf 'openrouter\n' ;; *) printf 'local\n' ;; esac
}

voice_stt_model() { voice_config_get stt_model "$VOICE_DEFAULT_STT_MODEL"; }
voice_tts_model() { voice_config_get tts_model "$VOICE_DEFAULT_TTS_MODEL"; }
voice_tts_voice() { voice_config_get tts_voice "$VOICE_DEFAULT_TTS_VOICE"; }

# voice_openrouter_key — the box's existing OpenRouter credential. No new secret
# store (DIVE-4439 scope line). Canonical name is openrouter.env (the shape
# 5dive-write-connector enforces); the bare `openrouter` file predates that
# helper and is still what some boxes hold, so both are read, newest convention
# first. Parsing mirrors scripts/test-vm.sh: a named var if present, else the
# first sk- token in the file.
voice_openrouter_key() {
  local f k
  for f in "$VOICE_CONNECTORS_DIR/openrouter.env" "$VOICE_CONNECTORS_DIR/openrouter"; do
    [[ -r "$f" ]] || continue
    k=$(grep -m1 -E '^(OPENROUTER_API_KEY|OPENROUTER_KEY)=' "$f" 2>/dev/null | cut -d= -f2-)
    k="${k%\"}"; k="${k#\"}"; k="${k%\'}"; k="${k#\'}"
    [[ -z "$k" ]] && k=$(grep -oE 'sk-[A-Za-z0-9_-]{20,}' "$f" 2>/dev/null | head -1)
    if [[ -n "$k" ]]; then printf '%s\n' "$k"; return 0; fi
  done
  return 1
}

voice_key_fix_line() {
  printf 'no OpenRouter key on this box. Fix:\n  sudo 5dive-write-connector openrouter.env <<< "OPENROUTER_API_KEY=sk-or-..."\n'
}

# voice_effective_backend — what will ACTUALLY run, on stdout; any reason it
# differs from the configured value on stderr.
#
# THE FALLBACK IS DELIBERATE AND IT IS ONE-WAY. A box configured for openrouter
# whose key has been revoked keeps hearing and speaking locally with a warning,
# because the alternative is dropping a message the user already sent. It never
# falls the other way: a box configured `local` never reaches the network, so a
# missing local engine is an error, not a silent upgrade to a paid vendor.
voice_effective_backend() {
  local want; want=$(voice_backend_configured)
  if [[ "$want" != openrouter ]]; then printf 'local\n'; return 0; fi
  if voice_openrouter_key >/dev/null 2>&1; then printf 'openrouter\n'; return 0; fi
  printf '5dive voice: backend=openrouter but %s' "$(voice_key_fix_line)" >&2
  printf '5dive voice: falling back to the local engine for this call.\n' >&2
  printf 'local\n'
}

voice_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { printf '5dive voice: %s is required (%s)\n' "$1" "${2:-run: sudo 5dive-setup-voice}" >&2; return 1; }
}

# voice_openrouter_curl <path> <curl-args...> — POSTs to OpenRouter with the box
# key, and turns a non-2xx into a readable one-liner instead of curl's exit 22.
voice_openrouter_curl() {
  local path="$1"; shift
  local key body code
  key=$(voice_openrouter_key) || { printf '5dive voice: %s' "$(voice_key_fix_line)" >&2; return 1; }
  # The key goes on curl's STDIN as a --config header line, never on argv:
  # /proc is world-readable on a box where every agent seat is its own unix
  # user, so an argv -H would publish the key to all of them for the length of
  # every transcription and every spoken reply. Same idiom, and the same reason,
  # as the fleet report in scripts/update.sh. The other two headers are not
  # secret and stay on argv where they are readable in a ps line.
  body=$(printf 'header = "Authorization: Bearer %s"\n' "$key" \
    | curl --config - -sS --max-time 180 -w '\n%{http_code}' \
    -H "HTTP-Referer: https://5dive.ai" \
    -H "X-Title: 5dive voice" \
    -X POST "${VOICE_OPENROUTER_BASE}${path}" "$@") || return 1
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [[ "$code" != 2* ]]; then
    # With --output (the /audio/speech path) the error JSON landed in the output
    # file, not in $body, so the caller names it via VOICE_OR_ERRFILE and we read
    # it back. Without this an auth failure on TTS reports an empty reason.
    [[ -z "$body" && -n "${VOICE_OR_ERRFILE:-}" && -r "${VOICE_OR_ERRFILE}" ]] \
      && body=$(head -c 400 "$VOICE_OR_ERRFILE")
    printf '5dive voice: OpenRouter %s returned HTTP %s: %s\n' "$path" "$code" "$(printf '%s' "$body" | head -c 400)" >&2
    return 1
  fi
  printf '%s' "$body"
}
