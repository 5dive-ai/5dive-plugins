#!/usr/bin/env bash
# voice-backend.sh — the ONE definition of "which backend is voice using, and
# can it actually run?", sourced by /usr/local/bin/5dive-transcribe and
# /usr/local/bin/5dive-speak. Installed to /usr/local/lib/5dive/voice-backend.sh.
#
# It lives in one file on purpose. 5dive-setup-voice already carries the lesson
# one layer down ("a guard restated in three places is a guard that silently
# goes missing from one"), and the fallback rule below is exactly that shape:
# hearing and speaking read the same config through the same accessors.
#
# DIVE-5189: they may now run on DIFFERENT backends, but only when the config
# says so in its own key: `stt_backend` moves hearing alone (a 5dive box hears
# on local whisper and speaks on OpenRouter). Without that key hearing follows
# `backend`, exactly as before, so no existing box changes.
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
VOICE_DEFAULT_PERSONA_TTS_MODEL="${VOICE_DEFAULT_PERSONA_TTS_MODEL:-google/gemini-3.8-flash-lite-tts}"
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

# voice_stt_backend_configured — where HEARING was told to run: `stt_backend`
# when the config sets it, else whatever `backend` says (DIVE-5189).
voice_stt_backend_configured() {
  case "$(voice_config_get stt_backend)" in
    local) printf 'local\n' ;;
    openrouter) printf 'openrouter\n' ;;
    *) voice_backend_configured ;;
  esac
}

voice_stt_model() { voice_config_get stt_model "$VOICE_DEFAULT_STT_MODEL"; }
voice_tts_model() { voice_config_get tts_model "$VOICE_DEFAULT_TTS_MODEL"; }
voice_tts_voice() { voice_config_get tts_voice "$VOICE_DEFAULT_TTS_VOICE"; }
voice_persona_tts_model() { voice_config_get persona_tts_model "$VOICE_DEFAULT_PERSONA_TTS_MODEL"; }

# DIVE-5869: two opt-in knobs for LOCAL hearing. Left unset, whisper detects the
# language on every note and decodes with beam 5, which is what every box does
# today. An owner whose notes are always in one language can pin it, and can
# trade a little accuracy for speed with greedy decoding (beam 1). A 20 s
# Russian note took ~5.2 s on the defaults and ~3.4 s pinned and greedy.
#
# voice_stt_language — the language code hearing is pinned to, or nothing
# (auto-detect). `auto` and anything that is not a 2–3 letter code read as unset.
voice_stt_language() {
  local l; l=$(voice_config_get stt_language)
  [[ "$l" =~ ^[a-z]{2,3}$ ]] && printf '%s\n' "$l"
  return 0
}
# voice_stt_fast — 1 when greedy decoding is on, else 0.
voice_stt_fast() {
  [[ "$(voice_config_get stt_fast)" == 1 ]] && printf '1\n' || printf '0\n'
}

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

# DIVE-5443: on the free (local) backend each agent speaks in its OWN Microsoft
# voice. Until now every agent on a box spoke en-US-AriaNeural, so a male agent
# sounded female and two agents sounded the same.
#
# THE TABLE. Each of the 30 Gemini prebuilt voices an OpenAgent pack can carry
# in voice.audio.base gets one fixed edge voice of the SAME gender, closest to
# Google's one-word descriptor, and no two Gemini voices share an edge voice.
# Genders are Google's own (Cloud TTS Chirp 3 HD list, read 2026-10-03: 14
# female, 16 male), not guessed from the names. The edge names were read off
# `edge-tts --list-voices` the same day. Aria is deliberately absent: it stays
# the "nothing resolved" voice, so hearing Aria means the pick did not run.
# Columns: gemini-base gender(F|M) edge-voice descriptor.
VOICE_EDGE_TABLE='Zephyr F en-PH-RosaNeural bright
Puck M en-US-RogerNeural upbeat
Charon M en-US-ChristopherNeural informative
Kore F en-GB-SoniaNeural firm
Fenrir M en-US-GuyNeural excitable
Leda F en-US-AvaNeural youthful
Orus M en-GB-RyanNeural firm
Aoede F en-AU-NatashaNeural breezy
Callirrhoe F en-CA-ClaraNeural easy-going
Autonoe F en-GB-LibbyNeural bright
Enceladus M en-IE-ConnorNeural breathy
Iapetus M en-CA-LiamNeural clear
Umbriel M en-AU-WilliamMultilingualNeural easy-going
Algieba M en-US-AndrewNeural smooth
Despina F en-US-EmmaNeural smooth
Erinome F en-IE-EmilyNeural clear
Algenib M en-ZA-LukeNeural gravelly
Rasalgethi M en-GB-ThomasNeural informative
Laomedeia F en-NZ-MollyNeural upbeat
Achernar F en-US-MichelleNeural soft
Alnilam M en-US-SteffanNeural firm
Schedar M en-US-EricNeural even
Gacrux F en-ZA-LeahNeural mature
Pulcherrima F en-IN-NeerjaNeural forward
Achird M en-US-BrianNeural friendly
Zubenelgenubi M en-NZ-MitchellNeural casual
Vindemiatrix F en-SG-LunaNeural gentle
Sadachbia M en-SG-WayneNeural lively
Sadaltager M en-IN-PrabhatNeural knowledgeable
Sulafat F en-US-JennyNeural warm'
# Edge voices are per-locale and Russian and Ukrainian have one voice per
# gender, so agents there share by gender; that is the pool, not a bug.
VOICE_EDGE_RU_F=ru-RU-SvetlanaNeural; VOICE_EDGE_RU_M=ru-RU-DmitryNeural
VOICE_EDGE_UK_F=uk-UA-PolinaNeural;   VOICE_EDGE_UK_M=uk-UA-OstapNeural
# Who is on this box, for the no-repeat rule. Overridable so the offline battery
# can stage a box; a seat's tools run as the seat, so `id -un` is the caller.
VOICE_PASSWD_FILE="${VOICE_PASSWD_FILE:-}"

# voice_edge_for_base <gemini-base> — "<edge-voice> <F|M>" from the table, rc 1
# for a name the table does not hold (another provider's voice, a typo, "unset").
voice_edge_for_base() {
  local want="${1,,}" g gen e _
  while read -r g gen e _; do
    [[ "${g,,}" == "$want" ]] && { printf '%s %s\n' "$e" "$gen"; return 0; }
  done <<<"$VOICE_EDGE_TABLE"
  return 1
}

# voice_edge_locale <text> — en|ru|uk from the reply itself: whichever script
# carries more letters. A client who writes Russian gets replies in Russian, and an
# English voice reading Cyrillic is worse than any voice reading its own
# language. і ї є ґ exist in Ukrainian and not in Russian.
voice_edge_locale() {
  local t="$1" cyr lat
  # Every letter in U+0400-U+04FF has exactly one UTF-8 lead byte in D0-D3, so
  # counting those bytes counts Cyrillic letters, in any locale and any grep.
  cyr=$(printf '%s' "$t" | LC_ALL=C tr -cd '\320-\323' | wc -c)
  lat=$(printf '%s' "$t" | LC_ALL=C tr -cd 'A-Za-z' | wc -c)
  if (( cyr == 0 || cyr < lat )); then printf 'en\n'
  elif [[ "$t" == *і* || "$t" == *ї* || "$t" == *є* || "$t" == *ґ* || "$t" == *І* || "$t" == *Ї* || "$t" == *Є* || "$t" == *Ґ* ]]; then printf 'uk\n'
  else printf 'ru\n'; fi
}

# voice_box_seats — "<name> <persona-file>" for every agent seat on the box, in
# uid order, which is creation order: a NEW agent never moves an older agent's
# voice. Seats are `claude` and `agent-*` with a login uid.
voice_box_seats() {
  { if [[ -n "$VOICE_PASSWD_FILE" ]]; then cat "$VOICE_PASSWD_FILE"; else getent passwd; fi; } 2>/dev/null \
    | awk -F: '($1 == "claude" || $1 ~ /^agent-/) && $3 >= 1000 { print $3, $1, $6 "/.claude/persona.yaml" }' \
    | sort -n -k1,1 | cut -d' ' -f2-
}

# voice_persona_bases — reads "<name> <persona-file>" lines, prints "<name>
# <base>" for each seat whose persona carries a plain voice.audio.base. One
# python start for the whole box; an unreadable home is simply absent.
voice_persona_bases() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -c '
import re, sys
try:
    import yaml
except Exception:
    sys.exit(0)
for line in sys.stdin:
    name, _, path = line.rstrip("\n").partition(" ")
    try:
        with open(path) as f:
            d = yaml.safe_load(f) or {}
        base = ((d.get("voice") or {}).get("audio") or {}).get("base")
    except Exception:
        continue
    if isinstance(base, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", base.strip()):
        print(name, base.strip())
' 2>/dev/null
}

# voice_agent_edge_voice <text> — the calling agent's own edge voice, on stdout.
#   1. its pack's voice.audio.base, through the table (same character, same
#      gender as on OpenRouter);
#   2. otherwise a stable hash of its unix name into the table's 30 voices,
#      stepping past any voice another seat on this box already holds: first
#      every persona seat's table voice, then each older seat's own pick. Two
#      agents share a voice only when the box has more seats than the pool.
# The locale is picked from the text, keeping the gender. rc 1 = nothing
# resolved, and the caller falls back to the box default.
voice_agent_edge_voice() {
  local text="$1" me pick="" persona e gen name base path h i k n
  me="${VOICE_AGENT_NAME:-$(id -un 2>/dev/null)}"
  if persona=$(voice_persona_audio); then pick=$(voice_edge_for_base "${persona%%$'\n'*}") || pick=""; fi
  if [[ -z "$pick" && -n "$me" ]]; then
    local -a pool=() gens=() order=()
    local -A held=() persona_of=()
    while read -r base gen e _; do pool+=("$e"); gens+=("$gen"); done <<<"$VOICE_EDGE_TABLE"
    n=${#pool[@]}
    local seats; seats=$(voice_box_seats)
    while read -r name path; do [[ -n "$name" ]] && order+=("$name"); done <<<"$seats"
    while read -r name base; do
      [[ -n "$name" && "$name" != "$me" ]] || continue
      e=$(voice_edge_for_base "$base") || continue
      for ((i = 0; i < n; i++)); do [[ "${pool[$i]}" == "${e%% *}" ]] && held[$i]=1; done
      persona_of[$name]=1
    done < <(printf '%s\n' "$seats" | voice_persona_bases)
    [[ " ${order[*]} " == *" $me "* ]] || order+=("$me")
    for name in "${order[@]}"; do
      [[ -n "${persona_of[$name]:-}" ]] && continue
      h=$(printf '%s' "$name" | cksum); h=${h%% *}; i=$((h % n)); k=0
      while [[ -n "${held[$i]:-}" ]] && (( k < n )); do i=$(((i + 1) % n)); k=$((k + 1)); done
      (( k < n )) || i=$((h % n))
      held[$i]=1
      [[ "$name" == "$me" ]] && { pick="${pool[$i]} ${gens[$i]}"; break; }
    done
  fi
  [[ -n "$pick" ]] || return 1
  e="${pick%% *}"; gen="${pick##* }"
  case "$(voice_edge_locale "$text")" in
    ru) [[ "$gen" == M ]] && e=$VOICE_EDGE_RU_M || e=$VOICE_EDGE_RU_F ;;
    uk) [[ "$gen" == M ]] && e=$VOICE_EDGE_UK_M || e=$VOICE_EDGE_UK_F ;;
  esac
  printf '%s\n' "$e"
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
# voice_effective_backend is SPEAKING's (and `backend`'s); hearing asks
# voice_effective_stt_backend, which applies the same rule to its own key.
voice_effective_backend() { voice_effective_from "$(voice_backend_configured)"; }
voice_effective_stt_backend() { voice_effective_from "$(voice_stt_backend_configured)"; }

voice_effective_from() {
  local want="$1"
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
