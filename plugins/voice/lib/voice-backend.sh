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

# DIVE-5162: an agent speaks in its OWN character's voice. OpenAgent packs carry
# voice.audio {base, style}, and the base names are Gemini TTS's prebuilt voices
# (Charon, Kore, Puck, Sulafat, Achird, ...), which only a Gemini TTS model
# knows — so a persona voice is spoken on this model whatever tts_model says.
# tts_model/tts_voice stay the box default for an agent that carries no voice.
VOICE_DEFAULT_PERSONA_TTS_MODEL="${VOICE_DEFAULT_PERSONA_TTS_MODEL:-google/gemini-3.8-flash-tts}"
# The installed persona of the agent that is CALLING: `agent import` puts it at
# ~/.claude/persona.yaml of the agent's own unix user, and a seat runs its tools
# as that user, so the caller's home is the only lookup there is.
VOICE_PERSONA_FILE="${VOICE_PERSONA_FILE:-${CLAUDE_CONFIG_DIR:-${HOME:-/nonexistent}/.claude}/persona.yaml}"
# The account a partner build seeds its per-box key into (5dive-api
# partner-box.ts SEEDED_ACCOUNT = "openrouter"). Read last, after every
# connector file, so a box that holds a connector key behaves exactly as before.
VOICE_SEEDED_ACCOUNT_ENV="${VOICE_SEEDED_ACCOUNT_ENV:-${STATE_DIR:-/var/lib/5dive}/auth-profiles/openrouter/combined.env}"

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
voice_persona_tts_model() { voice_config_get persona_tts_model "$VOICE_DEFAULT_PERSONA_TTS_MODEL"; }

# voice_tts_format <model> — the response_format a speaking model accepts.
# Gemini TTS answers ONLY raw PCM (16-bit little-endian, 24 kHz, mono) and
# rejects "mp3" with a 400, measured on OpenRouter 2026-09-29. Every other
# model keeps the mp3 it has always been asked for.
voice_tts_format() {
  case "$1" in google/gemini*) printf 'pcm\n' ;; *) printf 'mp3\n' ;; esac
}

# voice_persona_audio — the calling agent's voice.audio, as two lines: the base
# voice name, then the style (one line, may be empty). Returns 1 — and the
# caller uses the box default — when there is no persona, it does not parse, or
# its base is not a plain voice name. Never an error: a pack without a voice is
# the ordinary case, not a fault.
voice_persona_audio() {
  [[ -r "$VOICE_PERSONA_FILE" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  VOICE_PERSONA_FILE="$VOICE_PERSONA_FILE" python3 - 2>/dev/null <<'PY'
import os, re, sys
try:
    import yaml
    with open(os.environ["VOICE_PERSONA_FILE"]) as f:
        d = yaml.safe_load(f) or {}
    a = (d.get("voice") or {}).get("audio") or {}
    base = a.get("base")
    style = a.get("style")
except Exception:
    sys.exit(1)
if not isinstance(base, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", base.strip()):
    sys.exit(1)
print(base.strip())
print(" ".join(style.split())[:500] if isinstance(style, str) else "")
PY
}

# voice_openrouter_key — the box's existing OpenRouter credential. No new secret
# store (DIVE-4439 scope line). Canonical name is openrouter.env (the shape
# 5dive-write-connector enforces); the bare `openrouter` file predates that
# helper and is still what some boxes hold, so both are read, newest convention
# first. Parsing mirrors scripts/test-vm.sh: a named var if present, else the
# first sk- token in the file.
#
# DIVE-5043: voice's OWN key first. `5dive config openrouter-key.voice=-` writes
# openrouter-voice.env, so voice's spend shows under its own key in OpenRouter's
# per-key usage; without it voice uses the box's shared key (openrouter.env).
voice_openrouter_key() {
  local f k
  for f in "$VOICE_CONNECTORS_DIR/openrouter-voice.env" "$VOICE_CONNECTORS_DIR/openrouter.env" "$VOICE_CONNECTORS_DIR/openrouter"; do
    [[ -r "$f" ]] || continue
    k=$(grep -m1 -E '^(OPENROUTER_API_KEY|OPENROUTER_KEY)=' "$f" 2>/dev/null | cut -d= -f2-)
    k="${k%\"}"; k="${k#\"}"; k="${k%\'}"; k="${k#\'}"
    [[ -z "$k" ]] && k=$(grep -oE 'sk-[A-Za-z0-9_-]{20,}' "$f" 2>/dev/null | head -1)
    if [[ -n "$k" ]]; then printf '%s\n' "$k"; return 0; fi
  done
  # DIVE-5162: a partner box has no connector key — its build seeds the box's
  # capped key into the `openrouter` account its agents answer on, and nowhere
  # else, so voice there had no key at all. Read that account's token, and only
  # when the account really points at OpenRouter.
  f="$VOICE_SEEDED_ACCOUNT_ENV"
  if [[ -r "$f" ]] && grep -qE '^ANTHROPIC_BASE_URL=.?https://openrouter\.ai/' "$f" 2>/dev/null; then
    k=$(grep -m1 '^ANTHROPIC_AUTH_TOKEN=' "$f" 2>/dev/null | cut -d= -f2-)
    k="${k%\"}"; k="${k#\"}"; k="${k%\'}"; k="${k#\'}"
    if [[ "$k" =~ ^sk-or-[A-Za-z0-9_-]{8,200}$ ]]; then printf '%s\n' "$k"; return 0; fi
  fi
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
