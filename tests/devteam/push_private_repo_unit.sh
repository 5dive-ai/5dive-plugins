#!/usr/bin/env bash
# TIER: core — no network, no root; git, openssl and the task DB run for real, GitHub is stubbed. Measured 4s on the 5dive host.
# DIVE-9177. An APPROVED `5dive push` to a PRIVATE repo refused with "author check
# COULD NOT RUN": root's _push_do ran the author and PII scans BEFORE it minted the
# App token, and their range bound fetched the target's main with root's own git
# credential — none, for a private repo. Any tree without a cached origin/main
# (DIVE-9106's was a `git init`, because no seat can clone that repo) could not push.
# Second case: a repo created EMPTY has no main even with a credential; that is a
# measured state (every commit is new), not an unknown one.
#
# This drives cmd_push_do END TO END, as root sees it, with GitHub replaced by:
#   - a `git` function that serves https://github.com/acme/<repo>.git from a local
#     bare repo ONLY when an App Authorization header rides along (exactly like a
#     private repo), and logs which token each network call carried;
#   - a `curl` function that answers the installation lookup and mints "tok-read"
#     for a contents:read body and "tok-write" for anything else.
# The order mutant (scans moved back before the mint) is run in-file: it must red.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/grading_tree.sh" \
  || printf 'grading tree: UNRESOLVED (tests/lib/grading_tree.sh not reachable; no tree named)\n' >&2
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
SRC=src
TMP="$(mktemp -d /tmp/push-private.XXXXXX)"

# shellcheck disable=SC1090
for f in header.sh lib/error_codes.sh lib/output.sh lib/validation.sh \
         lib/agent_setup.sh lib/state.sh lib/broker.sh lib/audit.sh \
         lib/registry.sh lib/tasks_db.sh lib/actor.sh cmd_task.sh cmd_push.sh; do
  source "$SRC/$f"
done
set +e
STATE_DIR="$TMP"; TASKS_DIR="$STATE_DIR/tasks"; TASKS_DB="$TASKS_DIR/tasks.db"
GATE_PROOF_KEY="$STATE_DIR/gate-proof.key"; GATE_PROOF_ENFORCE="$STATE_DIR/gate-proof.enforce"
JSON_MODE=0
mkdir -p "$TASKS_DIR"; printf '%064d\n' 9177 > "$GATE_PROOF_KEY"
tasks_db_init

PASS=0; FAIL=0
ok_t()  { PASS=$((PASS+1)); printf 'ok   - %s\n' "$1"; }
bad_t() { FAIL=$((FAIL+1)); printf 'FAIL - %s\n   %s\n' "$1" "${2:-}"; }

AUTHOR='Ada Lovelace <ada@example.com>'

# Hermetic PII payload (same posture as push_unit.sh): the denylist holds only the
# sha256 of a reserved fake, so the scan runs for real and finds nothing.
export PII_GUARD_HOME="$TMP/pii-guard"; mkdir -p "$PII_GUARD_HOME"
cp scripts/pii-scan.sh "$PII_GUARD_HOME/pii-scan.sh"
printf '%s\n' "$(printf '%s' 'planted-pii@example.com' | sha256sum | cut -d' ' -f1)" > "$PII_GUARD_HOME/pii-denylist.txt"

# A throwaway App: real key so the JWT is really signed, fake ids.
openssl genrsa -out "$TMP/app.pem" 2048 >/dev/null 2>&1
cat > "$TMP/app.env" <<EOF
GITHUB_APP_ID=1
GITHUB_APP_INSTALLATION_ID=42
GITHUB_APP_PRIVATE_KEY_FILE=$TMP/app.pem
GITHUB_APP_COMMIT_AUTHOR='$AUTHOR'
EOF
export GITHUB_APP_ENV="$TMP/app.env"

seed_task() {   # <ident> <branch> — a cleared, signed approval gate
  local id sig
  db "INSERT INTO tasks(ident,project_key,title,status,assignee,kind,body,
         need_type,need_answered_at,need_answer,need_answered_by,need_answered_uid)
      VALUES($(sqlq "$1"),'dive',$(sqlq "t-$1"),'in_progress','dev','standard',
             $(sqlq "Branch: $2"),'approval','2026-11-24 00:00:00','approve','human:test',1000);"
  id=$(db "SELECT id FROM tasks WHERE ident=$(sqlq "$1");")
  sig=$(_gate_closure_sign "$id" approval approve human:test "2026-11-24 00:00:00" 1000)
  db "UPDATE tasks SET need_answer_sig=$(sqlq "$sig") WHERE id=${id};"
}

G0() { command git -c user.name=t -c user.email=t@example.com "$@"; }

# --- fixtures -------------------------------------------------------------------
# PRIVATE: a remote with history on main. The work tree shares that history but has
# NO origin remote and NO refs/remotes/origin/main — the DIVE-9106 shape. main's
# history carries a commit by someone else: a range widened to the whole branch
# would report it, so the author scan passes only on a real bound.
G0 init -q --bare -b main "$TMP/private.git"
G0 init -q -b main "$TMP/seed"
G0 -C "$TMP/seed" commit -q --allow-empty -m base --author="$AUTHOR"
G0 -C "$TMP/seed" commit -q --allow-empty -m old --author='Old Hand <old@example.com>'
G0 -C "$TMP/seed" push -q "$TMP/private.git" main
G0 init -q -b main "$TMP/work"
G0 -C "$TMP/work" fetch -q "$TMP/private.git" main
G0 -C "$TMP/work" checkout -q -b feature FETCH_HEAD
printf 'kit\n' > "$TMP/work/kit.md"; G0 -C "$TMP/work" add kit.md
G0 -C "$TMP/work" commit -q -m "add kit" --author="$AUTHOR"
rm -f "$TMP/work/.git/FETCH_HEAD"
# EMPTY: a bare remote with no refs at all; the work tree is a plain `git init`.
G0 init -q --bare -b main "$TMP/empty.git"
G0 init -q -b main "$TMP/work2"
G0 -C "$TMP/work2" checkout -q -b first-kit
printf 'kit\n' > "$TMP/work2/kit.md"; G0 -C "$TMP/work2" add kit.md
G0 -C "$TMP/work2" commit -q -m "first kit" --author="$AUTHOR"

# --- the GitHub stand-ins ---------------------------------------------------------
GITLOG="$TMP/git.log"; CURLLOG="$TMP/curl.log"
_tok_of() {   # decode "Authorization: Basic b64(x-access-token:T)" -> T
  local h="${1#Authorization: Basic }"; printf '%s' "$h" | base64 -d 2>/dev/null | sed 's/^x-access-token://'
}
git() {
  local -a a=("$@"); local i hdr="" sub="" url_i=-1
  [[ "${GIT_CONFIG_KEY_0:-}" == http.https://github.com/.extraheader ]] && hdr="${GIT_CONFIG_VALUE_0:-}"
  for i in "${!a[@]}"; do
    case "${a[$i]}" in
      http.https://github.com/.extraheader=*) hdr="${a[$i]#*=}" ;;
      fetch|push|ls-remote) [[ -z "$sub" ]] && sub="${a[$i]}" ;;
      https://github.com/acme/*) url_i=$i ;;
    esac
  done
  if [[ $url_i -ge 0 ]]; then
    printf '%s tok=%s\n' "$sub" "$(_tok_of "$hdr")" >> "$GITLOG"
    if [[ "$hdr" != "Authorization: Basic "* ]]; then
      echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
      return 128
    fi
    a[$url_i]="file://$TMP/$(basename "${a[$url_i]}")"
  fi
  command git "${a[@]}"
}
curl() {
  local x url="" data="" prev=""
  for x in "$@"; do [[ "$prev" == -d ]] && data="$x"; prev="$x"; [[ "$x" == https://* ]] && url="$x"; done
  case "$url" in
    */installation) echo '{"id":42}' ;;
    */access_tokens)
      printf '%s\n' "$data" >> "$CURLLOG"
      if grep -q '"contents":"read"' <<<"$data"; then echo '{"token":"tok-read"}'; else echo '{"token":"tok-write"}'; fi ;;
    *) return 22 ;;
  esac
}
id() { if [[ "${1:-}" == -u ]]; then echo 0; else command id "$@"; fi; }

push_do() {   # <ident> <repopath> <branch> <url>
  : > "$GITLOG"; : > "$CURLLOG"
  ( _push_do_stdin_write "$1" "$2" "$3" "$4" | cmd_push_do ) 2>&1
}

# --- 1. the private repo lands ---------------------------------------------------
seed_task DIVE-91 feature
out=$(push_do DIVE-91 "$TMP/work" feature https://github.com/acme/private.git); rc=$?
{ [[ $rc -eq 0 ]] && grep -q "pushed feature@" <<<"$out"; } \
  && ok_t "private repo, tree with no cached origin/main: the approved push LANDS" \
  || bad_t "private repo push lands" "rc=$rc :: $out"
[[ "$(G0 -C "$TMP/private.git" rev-parse refs/heads/feature 2>/dev/null)" == "$(G0 -C "$TMP/work" rev-parse feature)" ]] \
  && ok_t "…and the remote really holds the branch at the pushed sha" \
  || bad_t "remote holds the branch" "$(G0 -C "$TMP/private.git" show-ref)"
grep -q '^fetch tok=tok-read$' "$GITLOG" \
  && ok_t "the scans' fetch carried the READ token (the bound came from a fresh fetch)" \
  || bad_t "scan fetch carried the read token" "$(cat "$GITLOG")"
{ grep -q '^push tok=tok-write$' "$GITLOG" && ! grep -q '^push tok=tok-read' "$GITLOG"; } \
  && ok_t "the push carried the WRITE token, never the read one" \
  || bad_t "push carried the write token" "$(cat "$GITLOG")"
grep -q 'tok=$' "$GITLOG" \
  && bad_t "every network git call carried a token" "$(cat "$GITLOG")" \
  || ok_t "no network git call went out without a token"
{ [[ "$(sed -n 1p "$CURLLOG")" == *'"contents":"read"'* ]] && [[ "$(sed -n 2p "$CURLLOG")" == *'"contents":"write"'* ]]; } \
  && ok_t "mint order: contents:read first, then contents:write" \
  || bad_t "mint order read then write" "$(cat "$CURLLOG")"
grep -q '"workflows"' "$CURLLOG" \
  && bad_t "no workflow files -> no workflows:write (the probe measured instead of guessing)" "$(cat "$CURLLOG")" \
  || ok_t "no workflow files -> no workflows:write (the probe measured instead of guessing)"
grep -q 'COULD NOT RUN\|CACHED' <<<"$out" \
  && bad_t "neither scan fell back to a cached bound or refused" "$out" \
  || ok_t "neither scan fell back to a cached bound or refused"
grep -q 'remote-was-empty' <<<"$out" \
  && bad_t "a repo with history is not reported empty" "$out" \
  || ok_t "a repo with history is not reported empty"

# --- 2. fail closed: a fetch that fails WITH the token still refuses ---------------
seed_task DIVE-92 feature
mv "$TMP/private.git" "$TMP/private.gone"
out=$(push_do DIVE-92 "$TMP/work" feature https://github.com/acme/private.git); rc=$?
{ [[ $rc -ne 0 ]] && grep -q "author check COULD NOT RUN" <<<"$out" && ! grep -q '^push ' "$GITLOG"; } \
  && ok_t "a fetch that fails WITH the token still refuses, and nothing is pushed" \
  || bad_t "authenticated fetch failure refuses" "rc=$rc :: $out :: $(cat "$GITLOG")"
mv "$TMP/private.gone" "$TMP/private.git"

# --- 3. an EMPTY repo: measured whole-branch range, named as such -------------------
seed_task DIVE-93 first-kit
out=$(push_do DIVE-93 "$TMP/work2" first-kit https://github.com/acme/empty.git); rc=$?
{ [[ $rc -eq 0 ]] && [[ "$(G0 -C "$TMP/empty.git" rev-parse refs/heads/first-kit 2>/dev/null)" == "$(G0 -C "$TMP/work2" rev-parse first-kit)" ]]; } \
  && ok_t "empty repo: the approved push lands" \
  || bad_t "empty repo push lands" "rc=$rc :: $out"
grep -q 'remote-was-empty' <<<"$out" \
  && ok_t "…and root names it: remote-was-empty (the token cmd_push reads to skip the PR)" \
  || bad_t "empty repo is named" "$out"
G0 -C "$TMP/empty.git" update-ref -d refs/heads/first-kit
_PUSH_FETCH_AUTH=""
_push_range_base "$TMP/work2" "file://$TMP/empty.git" first-kit
[[ "$_PUSH_RB_KIND" == empty && -z "$_PUSH_RB_BASE" ]] \
  && ok_t "_push_range_base: a remote with no refs is kind=empty (measured), not none" \
  || bad_t "range base empty kind" "kind=$_PUSH_RB_KIND base=$_PUSH_RB_BASE"
_push_range_base "$TMP/work2" https://github.com/acme/empty.git first-kit
[[ "$_PUSH_RB_KIND" == none ]] \
  && ok_t "…but WITHOUT the token the same private repo is none: a failed ls-remote is never 'empty'" \
  || bad_t "unauthenticated empty probe is none" "kind=$_PUSH_RB_KIND"
( _push_author_scan "$TMP/work2" "file://$TMP/empty.git" first-kit "$AUTHOR" "" authoritative; echo "bound=$_PUSH_AUTHOR_SCAN_BOUND" ) > "$TMP/o" 2>&1
grep -q 'bound=empty' "$TMP/o" \
  && ok_t "author scan reports its bound as 'empty', not 'fresh'" \
  || bad_t "author scan bound empty" "$(cat "$TMP/o")"

# --- 4. cmd_push skips --open-pr after a push into an empty repo -------------------
# The caller sees root's answer only on stdout; a sudo stand-in plays root's
# empty-repo success line, and the PR leg must NOT be reached.
( cd "$TMP/work2"
  sudo() { local a; for a in "$@"; do [[ "$a" == _push_do ]] && { cat >/dev/null; echo "OK — pushed first-kit@abc → acme/empty (delegated, repo-scoped token, author enforced, gate cleared, remote-was-empty: acme/empty had no branches, so GitHub makes 'first-kit' its default branch)"; return 0; }; done; return 1; }
  _push_open_pr() { echo "PR-LEG-REACHED"; return 0; }
  GITHUB_APP_ENV="$TMP/none" cmd_push DIVE-93 --repo=https://github.com/acme/empty.git --open-pr ) > "$TMP/o" 2>&1
{ ! grep -q PR-LEG-REACHED "$TMP/o" && grep -q "NO pull request opened" "$TMP/o"; } \
  && ok_t "--open-pr after an empty-repo push: no PR attempted, and the line says why" \
  || bad_t "empty-repo --open-pr skip" "$(cat "$TMP/o")"
( cd "$TMP/work"
  sudo() { local a; for a in "$@"; do [[ "$a" == _push_do ]] && { cat >/dev/null; echo "OK — pushed feature@abc → acme/private (delegated)"; return 0; }; done; return 1; }
  _push_open_pr() { echo "PR-LEG-REACHED"; return 0; }
  GITHUB_APP_ENV="$TMP/none" cmd_push DIVE-91 --repo=https://github.com/acme/private.git --open-pr ) > "$TMP/o" 2>&1
grep -q PR-LEG-REACHED "$TMP/o" \
  && ok_t "control: a normal push still reaches the PR leg" \
  || bad_t "control PR leg reached" "$(cat "$TMP/o")"
# The copy of root's answer goes through `tee`; a FAILED root push must still fail
# the verb (pipefail), and must not reach the PR leg.
( cd "$TMP/work"
  sudo() { local a; for a in "$@"; do [[ "$a" == _push_do ]] && { cat >/dev/null; echo "refused"; return 1; }; done; return 1; }
  _push_open_pr() { echo "PR-LEG-REACHED"; return 0; }
  GITHUB_APP_ENV="$TMP/none" cmd_push DIVE-91 --repo=https://github.com/acme/private.git --open-pr ) > "$TMP/o" 2>&1; rc=$?
{ [[ $rc -ne 0 ]] && grep -q "delegated push failed" "$TMP/o" && ! grep -q PR-LEG-REACHED "$TMP/o"; } \
  && ok_t "a failed root push still fails the verb through the tee, and no PR is tried" \
  || bad_t "failed root push fails the verb" "rc=$rc :: $(cat "$TMP/o")"

# --- 5. MUTANT: scans back before the mint -> red ----------------------------------
# Rebuild cmd_push_do with the two scan calls hoisted above the JWT, i.e. the
# pre-9177 order, and re-run arm 1. It must refuse; if it lands, arm 1 grades nothing.
mut=$(declare -f cmd_push_do | python3 -c '
import sys; s=sys.stdin.read()
a="_push_author_scan \"$repopath\" \"$repourl\" \"$branch\" \"$author\" \"the caller'"'"'s resolved target\" authoritative;"
p="_push_pii_scan \"$repopath\" \"$repourl\" \"$branch\" authoritative;"
k="local now iat exp header payload unsigned sig jwt;"
if not (a in s and p in s and k in s): sys.exit(1)
s=s.replace(a,"",1).replace(p,"",1)
s=s.replace(k,"local author; author=$(_push_expected_author); "+a+" "+p+" "+k,1)
print(s)')
if [[ -n "$mut" ]]; then
  seed_task DIVE-94 feature
  G0 -C "$TMP/private.git" update-ref -d refs/heads/feature
  out=$( eval "$mut"; push_do DIVE-94 "$TMP/work" feature https://github.com/acme/private.git ); rc=$?
  { [[ $rc -ne 0 ]] && grep -q "COULD NOT RUN" <<<"$out"; } \
    && ok_t "MUTANT (scans before the mint) reds: the private push refuses COULD NOT RUN" \
    || bad_t "MUTANT reds" "rc=$rc :: $out"
else
  bad_t "MUTANT could be built" "declare -f cmd_push_do did not match the rewrite anchors"
fi

printf '\n%s arms: %s pass, %s fail\n' "$((PASS+FAIL))" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
