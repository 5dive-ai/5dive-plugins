#!/usr/bin/env bash
# DIVE-9330: a premium team's update (`5dive team update <team>`, DIVE-9116) and
# the producer of premium team files (DIVE-9109) moved here from the 5dive CLI
# (src/cmd_team_pack.sh `_team_premium_update_online`, packaging/premium-team/
# build.sh) with their arms (the CLI's premium_team_update_unit.sh O1 and
# premium_team_unit.sh B1/B2). Core keeps the forward (5dive
# tests/team_update_forward_unit.sh) and the verify side.
#
#   O1a-O1f  `premium-team update`: 204 says up to date and asks with the installed
#            version; 403 says the subscription ended; 200 hands the file it got
#            to core's `team import` (with --allow-downgrade and --json passed
#            on) and leaves no download; a team that is not premium is refused;
#            the bearer rides stdin, never argv.
#   O2a-O2d  root only; an offline box is told to import by hand; no box token
#            is refused; a bare `update --json` answers E_USAGE with the usage
#            line, never "unknown team subcommand" (the API's partner probe
#            reads only that as a missing verb).
#   B1-B2    the producer: one .gz of manifest, signature and team; the buyer on
#            the signed label AND inside the team; the ceremony's PUBLIC file as
#            --trust; the signature verifies with the certified key and the
#            payload's sha256 matches the label (what core's verifier checks); it
#            refuses a key the certificate does not approve, a certificate for
#            another kind, and a gzip that is not a team.
#   W1-W2    wiring: the manifest declares premium-team (0.5.0); no core
#            internals are called.
#   NC1      NEGATIVE CONTROL: an update that applies a 403 answer is CAUGHT by O1b.
# Run: bash tests/hosted_premium_team_unit.sh   (no root, no network)
set -uo pipefail
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.." || exit 2
for t in openssl jq sha256sum base64; do command -v "$t" >/dev/null || { echo "SKIP: $t not installed"; exit 0; }; done
TMP="$(mktemp -d "${TMPDIR:-/tmp}/hosted-premium-team.XXXXXX")"
BIN=plugins/hosted/bin/premium-team
BUILD=plugins/hosted/tools/premium-team-build.sh
PJ=plugins/hosted/.claude-plugin/plugin.json

pass=0; fail=0
ok_t()  { pass=$((pass+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { fail=$((fail+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }
eq_t()  { if [[ "$2" == "$3" ]]; then ok_t "$1"; else bad_t "$1" "expected [$2], got [$3]"; fi; }

# ============ O. update ======================================================
# Stubs on PATH: curl serves CURL_CODE (a file on 200), recording argv and stdin;
# `5dive` (FIVEDIVE_SELF_BIN) records its argv and the file it was handed.
mkdir -p "$TMP/bin" "$TMP/state/premium-teams" "$TMP/tmpd"
printf 'premium file bytes\n' >"$TMP/served.gz"
cat >"$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$T/curl.argv"; cat >>"$T/curl.stdin"
o="" prev=""; for a in "$@"; do [[ "$prev" == -o ]] && o="$a"; prev="$a"; done
[[ "$CURL_CODE" == 200 && -n "$o" ]] && cp "$T/served.gz" "$o"
printf '%s' "$CURL_CODE"
SH
cat >"$TMP/bin/5dive" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$T/5dive.argv"; [[ -f "${3:-}" ]] && cp "$3" "$T/imported.gz"; exit "${IMPORT_RC:-0}"
SH
chmod +x "$TMP/bin/curl" "$TMP/bin/5dive"
printf '{"team":"research","version":"1.0.0","buyer":{"account":"acct-42","name":"Acme Research"}}\n' >"$TMP/state/premium-teams/research.json"
printf 'CONNECTORD_TOKEN="tok-SECRET"\n' >"$TMP/connectord.env"
: >"$TMP/curl.argv"; : >"$TMP/curl.stdin"; : >"$TMP/5dive.argv"

# up <argv…> — the verb's update with root granted (sourced, require_root stubbed).
# PT_SRC picks the script (a mutant), PT_ROOT=0 keeps the real root check.
up() {
  ( export T="$TMP" PATH="$TMP/bin:$PATH" TMPDIR="$TMP/tmpd" CURL_CODE="${CURL_CODE:-204}"
    export STATE_DIR="$TMP/state" FIVE_CONNECTORD_ENV="${PT_ENV:-$TMP/connectord.env}" FIVE_API_BASE_FILE="$TMP/none" \
      FIVE_API_BASE=https://api.example.test FIVE_LOCAL_ONLY_FILE="${PT_LOCAL:-$TMP/no-local-only}" FIVEDIVE_SELF_BIN="$TMP/bin/5dive"
    unset CONNECTORD_TOKEN
    # shellcheck source=/dev/null
    source "${PT_SRC:-$BIN}"
    [[ "${PT_ROOT:-1}" == 1 ]] && require_root() { :; }
    cmd_premium_team_update "$@" ) >"$TMP/out" 2>"$TMP/err"; RC=$?
  OUT=$(cat "$TMP/out"); ERR=$(cat "$TMP/err")
}

CURL_CODE=204 up research
(( RC == 0 )) && [[ "$OUT" == *'up to date (1.0.0)'* ]] && grep -q 'https://api.example.test/server/premium-teams/research/latest?have=1.0.0' "$TMP/curl.argv" \
  && ok_t 'O1a 204: says up to date, and asked with the installed version' || bad_t 'O1a 204' "rc=$RC $OUT $ERR $(cat "$TMP/curl.argv")"
o1b() { CURL_CODE=403 up research; (( RC == 10 )) && [[ "$ERR" == *'subscription to premium team research has ended'* ]] && [[ ! -s "$TMP/5dive.argv" ]]; }
o1b && ok_t 'O1b 403: the subscription ended, the team keeps working, nothing imported' || bad_t 'O1b 403' "rc=$RC $ERR"
CURL_CODE=200 JSON_MODE=1 up research --allow-downgrade
(( RC == 0 )) && [[ "$(head -1 "$TMP/5dive.argv")" =~ ^team\ import\ $TMP/tmpd/[^\ ]+\.gz\ --allow-downgrade\ --json$ ]] \
  && cmp -s "$TMP/served.gz" "$TMP/imported.gz" \
  && ok_t "O1c 200: the file it got goes to core's 'team import', --allow-downgrade and --json passed on" \
  || bad_t 'O1c 200' "rc=$RC argv=$(cat "$TMP/5dive.argv") $ERR"
: >"$TMP/5dive.argv"; CURL_CODE=200 IMPORT_RC=4 up research
eq_t "O1c2 core's import refusal is the verb's exit code" 4 "$RC"
CURL_CODE=204 up nosuch
(( RC == 5 )) && [[ "$ERR" == *'not a premium team on this server'* ]] && ok_t 'O1d a team that is not premium is refused' || bad_t 'O1d' "rc=$RC $ERR"
! grep -q 'tok-SECRET' "$TMP/curl.argv" && grep -q 'Authorization: Bearer tok-SECRET' "$TMP/curl.stdin" \
  && ok_t 'O1e the bearer goes on stdin, never argv' || bad_t 'O1e bearer' "$(cat "$TMP/curl.argv")"
eq_t 'O1f no download is left behind' '' "$(find "$TMP/tmpd" -mindepth 1 2>/dev/null | head -3)"

if (( EUID == 0 )); then ok_t 'O2a SKIPPED as root: the not-root refusal cannot be observed here'
else
  PT_ROOT=0 up research; (( RC == 10 )) && [[ "$ERR" == *'must run as root'* ]] && ok_t 'O2a not root: E_PERMISSION' || bad_t 'O2a root' "rc=$RC $ERR"
fi
: >"$TMP/local-only"; : >"$TMP/curl.argv"; PT_LOCAL="$TMP/local-only" up research
(( RC == 4 )) && [[ "$ERR" == *'works offline'*'5dive team import <file>'* && ! -s "$TMP/curl.argv" ]] \
  && ok_t 'O2b an offline box asks nothing and is told to import the file by hand' || bad_t 'O2b offline' "rc=$RC $ERR"
PT_ENV="$TMP/none.env" up research
(( RC == 10 )) && [[ "$ERR" == *'no 5dive sign-in'* ]] && ok_t 'O2c no box token: refused, with the offline way' || bad_t 'O2c token' "rc=$RC $ERR"
( export STATE_DIR="$TMP/state"; bash "$BIN" update --json ) >"$TMP/out" 2>"$TMP/err"; RC=$?
code=$(jq -r .error.code <"$TMP/out" 2>/dev/null); msg=$(jq -r .error.message <"$TMP/out" 2>/dev/null)
[[ $RC -eq 2 && "$code" == 2 && "$msg" == 'usage: 5dive team update <team> [--allow-downgrade]' ]] \
  && ok_t "O2d bare 'update --json': E_USAGE with the usage line (the API's probe reads it as present)" || bad_t 'O2d probe' "rc=$RC out=$(cat "$TMP/out")"

# ============ B. the producer ================================================
K="$TMP/k"; mkdir -p "$K"
key(){ openssl genpkey -algorithm ed25519 -out "$K/$1.pem" 2>/dev/null; openssl pkey -in "$K/$1.pem" -pubout -out "$K/$1.pub" 2>/dev/null; }
kid(){ openssl pkey -pubin -in "$K/$1.pub" -outform DER 2>/dev/null | sha256sum | awk '{print $1}'; }
sign(){ openssl pkeyutl -sign -inkey "$K/$1.pem" -rawin -in "$2" -out "$3"; }
trustdir(){ # <out-dir> <key> <kind>
  local d="$1"; mkdir -p "$d"
  jq -cjn --arg k "$3" --arg id "$(kid "$2")" --rawfile p "$K/$2.pub" --argjson n $(( $(date +%s) + 86400 )) \
    '{format:1, kind:$k, key_id:$id, pubkey:$p, not_after:$n}' >"$d/team-key.json"; sign root "$d/team-key.json" "$d/team-key.sig"
  jq -cjn '{format:1, kind:"5dive-revocations", serial:1, revoked:[]}' >"$d/revoked.json"; sign root "$d/revoked.json" "$d/revoked.sig"; }
for n in root team office; do key "$n"; done
trustdir "$TMP/t-good" team 5dive-team-key
trustdir "$TMP/t-office" office 5dive-office-app-key
B="$TMP/bundle"; mkdir -p "$B/packs"
printf '{"kind":"5dive-team","format":1,"team":"research","memory":false,"agents":["boss"]}\n' >"$B/manifest.json"
printf 'version: 2\nname: research\nagents:\n  boss:\n    type: claude\n    pack_file: packs/boss.tar.gz\n' >"$B/team.5dive.yaml"
d=$(mktemp -d); printf '{"packFormat":1,"name":"boss"}\n' >"$d/manifest.json"; tar -czf "$B/packs/boss.tar.gz" -C "$d" manifest.json; rm -rf "$d"
tar -czf "$TMP/research.team.tar.gz" -C "$B" manifest.json team.5dive.yaml packs
mk() { # <out> <trust> <key>
  bash "$BUILD" --bundle="$TMP/research.team.tar.gz" --key="$K/$3.pem" --trust="$2" \
    --buyer-account=acct-42 --buyer-name="Acme Research" --version=1.0.0 -o "$1" >/dev/null 2>"$1.err"
}
mk "$TMP/good.gz" "$TMP/t-good" team; eq_t 'B1 the producer makes a file' 0 "$?"
eq_t 'B1b one .gz: manifest, signature, team' 'manifest.json manifest.sig payload/team.tar.gz ' \
  "$(tar -tzf "$TMP/good.gz" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')"
eq_t 'B1c the signed label names the team, version and buyer' 'research 1.0.0 acct-42 Acme Research' \
  "$(tar -xzOf "$TMP/good.gz" manifest.json | jq -r '"\(.team) \(.version) \(.buyer.account) \(.buyer.name)"')"
eq_t 'B1d the team inside carries the buyer too' 'acct-42 Acme Research' \
  "$(tar -xzOf "$TMP/good.gz" payload/team.tar.gz | tar -xzOf - manifest.json | jq -r '"\(.licensed_to.account) \(.licensed_to.name)"')"
V="$TMP/v"; mkdir -p "$V"; tar -xzf "$TMP/good.gz" -C "$V"
openssl pkeyutl -verify -pubin -inkey "$K/team.pub" -rawin -in "$V/manifest.json" -sigfile "$V/manifest.sig" >/dev/null 2>&1 \
  && [[ "$(jq -r '.files["payload/team.tar.gz"]' "$V/manifest.json")" == "$(sha256sum <"$V/payload/team.tar.gz" | cut -d' ' -f1)" ]] \
  && ok_t "B1e the signature verifies with the certified team key and the payload's sha256 matches the label" || bad_t 'B1e signature/sha' ""
jq -n --arg a "$(base64 -w0 <"$TMP/t-good/team-key.json")" --arg b "$(base64 -w0 <"$TMP/t-good/team-key.sig")" \
      --arg c "$(base64 -w0 <"$TMP/t-good/revoked.json")" --arg d "$(base64 -w0 <"$TMP/t-good/revoked.sig")" \
  '{root_pubkey_pem:"x", root_fingerprint:"y", team_key_json_b64:$a, team_key_sig_b64:$b, revoked_json_b64:$c, revoked_sig_b64:$d}' >"$TMP/pub-team.json"
mk "$TMP/b1f.gz" "$TMP/pub-team.json" team; rc=$?
eq_t "B1f the ceremony's PUBLIC team file is taken as --trust, giving the same certificate" "0 $(tar -xzOf "$TMP/good.gz" manifest.json | jq -r .trust.team_key)" \
  "$rc $(tar -xzOf "$TMP/b1f.gz" manifest.json 2>/dev/null | jq -r .trust.team_key)"
mk "$TMP/b2a.gz" "$TMP/t-good" office; rc=$?
(( rc != 0 )) && grep -q 'not the key the certificate' "$TMP/b2a.gz.err" && [[ ! -e "$TMP/b2a.gz" ]] \
  && ok_t 'B2a a key the certificate does not approve is refused' || bad_t 'B2a' "rc=$rc $(cat "$TMP/b2a.gz.err")"
mk "$TMP/b2b.gz" "$TMP/t-office" office; rc=$?
(( rc != 0 )) && grep -q 'not for a premium team key' "$TMP/b2b.gz.err" && ok_t 'B2b a certificate for another kind of key is refused' || bad_t 'B2b' "rc=$rc $(cat "$TMP/b2b.gz.err")"
bash "$BUILD" --bundle="$B/packs/boss.tar.gz" --key="$K/team.pem" --trust="$TMP/t-good" --buyer-account=a --version=1.0.0 -o "$TMP/b2c.gz" >/dev/null 2>"$TMP/b2c.err"; rc=$?
(( rc != 0 )) && grep -q 'not a team bundle' "$TMP/b2c.err" && ok_t 'B2c one agent pack is not taken for a team' || bad_t 'B2c' "rc=$rc $(cat "$TMP/b2c.err")"

# ============ W. wiring ======================================================
[[ "$(jq -r '.version' "$PJ")" == 0.5.0 && "$(jq -r '[.fivedive.verbs[].name] | index("premium-team") != null' "$PJ")" == true && -x "$BIN" && -x "$BUILD" ]] \
  && ok_t 'W1 plugin.json 0.5.0 declares premium-team; the verb and the producer are executable' || bad_t 'W1 manifest' "$(jq -c '.version, [.fivedive.verbs[].name]' "$PJ")"
! grep -vE '^[[:space:]]*#' "$BIN" | grep -nE '\b(cmd_team|_box_token|five_api_base|local_only_on|lazy_need|_team_premium_[a-z_]+)\b' \
  && ok_t "W2 no core internals are called (core is reached as '5dive team import')" || bad_t 'W2 core internals' ""

# ============ NC1 ============================================================
sed 's/^    402|403) /    402|403|999) /; s/^    200) ;;$/    200|403) ;;/' "$BIN" >"$TMP/mutant"
if cmp -s "$BIN" "$TMP/mutant"; then bad_t 'NC1 mutation did not apply' ""
else
  : >"$TMP/5dive.argv"
  PT_SRC="$TMP/mutant" o1b && bad_t 'NC1 an update that applies a 403 passes O1b — the arm cannot go red' "" \
    || ok_t 'NC1 an update that applies a 403 answer is CAUGHT by O1b'
fi

printf '\nTESTS pass=%s fail=%s\n' "$pass" "$fail"
(( fail == 0 ))
