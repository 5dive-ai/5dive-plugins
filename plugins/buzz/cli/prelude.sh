# shellcheck shell=bash
# The buzz verbs' prelude (DIVE-6934). Sourced by bin/buzz before the carried
# modules in this directory.
#
# WHY THIS FILE EXISTS. Until DIVE-6934 the buzz verbs (`5dive buzz …`,
# `5dive agent buzz …`) lived in the core CLI as six sourced modules. They moved
# here so the core stops carrying a channel almost nobody runs (lodar 2026-10-25:
# "can be a plugin?"). A plugin verb is an EXECUTABLE that core execs, not a
# sourced fragment, so nothing core defines is in scope: `fail`, `ok`, `warn`,
# the `E_*` codes and the registry helpers have to be re-established. That is
# what this file is — the same move council made (5dive-ai/5dive-council,
# council/src/prelude.sh), copied in shape.
#
# The modules beside this file are core's src/cmd_buzz.sh and
# src/cmd_agent_buzz*.sh at 5dive-ai/5dive 497ec15a, carried verbatim apart from
# the sites marked `PLUGIN DIVERGENCE`.
#
# WHAT IS RE-ESTABLISHED HERE, AND THE ONE SEAM IT LEAVES.
#
#   core internal                     ->  here
#   fail / ok / warn / step / E_*     ->  same contract, same exit numbers
#   registry_read / _checked / write  ->  the same file ($STATE_DIR/agents.json),
#                                         same atomic tmp+mv, same 0640 root:claude
#   with_registry_lock                ->  the same flock on $STATE_DIR/registry.lock,
#                                         EXPORTING IN_REGISTRY_LOCK=1 so a core
#                                         child we call while holding it does not
#                                         wait on our own lock
#   cmd_config                        ->  5dive agent config
#   install_channel_for_agent         ->  nothing: `agent config set channels=`
#                                         installs the channel (see below)
#   mark_reported                     ->  no-op (core's auto bug-report flag)
#
# The registry FILE is the seam: the verbs read agents and record buzz pubkeys in
# it exactly as they did in core, so a box wired before the move answers
# `whois` the same after it. If core ever moves the registry, these verbs say
# "no agent named …" instead of writing somewhere wrong.

STATE_DIR="${STATE_DIR:-/var/lib/5dive}"
REGISTRY="${REGISTRY:-${STATE_DIR}/agents.json}"
REGISTRY_LOCK="${REGISTRY_LOCK:-${STATE_DIR}/registry.lock}"
REGISTRY_LOCK_WAIT_DEFAULT=300
BUZZ_5DIVE_BIN="${BUZZ_5DIVE_BIN:-/usr/local/bin/5dive}"

# Error codes: values identical to core's src/lib/error_codes.sh, so a script
# that keys on a buzz verb's exit status reads the same number it always did.
readonly E_OK=0
readonly E_GENERIC=1
readonly E_USAGE=2
readonly E_VALIDATION=3
readonly E_NOT_FOUND=4
readonly E_CONFLICT=5
readonly E_AUTH_REQUIRED=6
readonly E_NOT_INSTALLED=7
readonly E_NOT_RUNNING=8
readonly E_PERMISSION=10
readonly E_TIMEOUT=11

# Core strips a global --json before it dispatches and forwards the mode here.
JSON_MODE="${FIVEDIVE_JSON_MODE:-${JSON_MODE:-0}}"

_err_class_for() {
  case "$1" in
    2) echo usage ;; 3) echo validation ;; 4) echo not_found ;; 5) echo conflict ;;
    6) echo auth_required ;; 7) echo not_installed ;; 8) echo not_running ;;
    10) echo permission ;; 11) echo timeout ;; *) echo generic ;;
  esac
}

fail() {
  local code="$1"; shift
  if (( JSON_MODE )); then
    jq -cn --argjson c "$code" --arg cl "$(_err_class_for "$code")" --arg m "$*" \
      '{ok:false, error:{code:$c, class:$cl, message:$m}}'
  fi
  echo "error: $*" >&2
  exit "$code"
}
warn() { echo "warn: $*" >&2; }
step() { echo "==> $*" >&2; }
mark_reported() { :; }

ok() {
  local prose="${1:-}"; shift || true
  if (( JSON_MODE )); then
    local expr="${1:-}"
    [[ $# -gt 0 ]] && shift
    [[ -z "$expr" ]] && expr='{}'
    jq -cn "$@" "{ok:true, data: ($expr)}"
  else
    [[ -n "$prose" ]] && echo "OK — $prose"
  fi
  return 0
}

require_root() {
  [[ $EUID -eq 0 ]] || fail "$E_PERMISSION" "must run as root — try: sudo 5dive ${*:-buzz}"
}

# Core's ensure_state also CREATES the state tree. A plugin has no business
# initialising a box, so this only checks that core already did.
ensure_state() {
  require_root
  [[ -f "$REGISTRY" ]] \
    || fail "$E_NOT_FOUND" "no agent registry at $REGISTRY — this box has no 5dive agents yet"
}

registry_read() {
  [[ -f "$REGISTRY" ]] && cat "$REGISTRY" || echo '{"agents":{}}'
}

registry_read_checked() {
  [[ -e "$REGISTRY" ]] || return 3
  local body
  body="$(cat "$REGISTRY" 2>/dev/null)" || return 4
  printf '%s' "$body" | jq -e . >/dev/null 2>&1 || return 5
  printf '%s\n' "$body"
}

registry_write() {
  local tmp
  tmp=$(mktemp "${REGISTRY}.XXXXXX")
  cat > "$tmp"
  chown root:claude "$tmp"
  chmod 640 "$tmp"
  mv "$tmp" "$REGISTRY"
}

with_registry_lock() {
  local fn="$1"; shift
  if [[ "${IN_REGISTRY_LOCK:-0}" == "1" ]]; then
    "$fn" "$@"
    return
  fi
  ensure_state
  local wait="${FIVEDIVE_REGISTRY_LOCK_WAIT:-$REGISTRY_LOCK_WAIT_DEFAULT}"
  [[ "$wait" =~ ^[0-9]+$ ]] || wait="$REGISTRY_LOCK_WAIT_DEFAULT"
  (
    if ! flock -x -w "$wait" 200; then
      fail "$E_TIMEOUT" "the agent registry is locked by another 5dive command and was not released in ${wait}s. Nothing was changed."
    fi
    export IN_REGISTRY_LOCK=1
    "$fn" "$@"
  ) 200>"$REGISTRY_LOCK"
}

channel_in_list() {
  local needle="$1" IFS=',' c
  for c in $2; do
    [[ "$c" == "$needle" ]] && return 0
  done
  return 1
}

valid_sender_label() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{0,31}$ ]]
}

a2a_needs_scoped() {
  local target="$1"
  [[ $EUID -eq 0 ]] && return 1
  sudo -n -u "agent-${target}" true 2>/dev/null && return 1
  return 0
}

# `agent buzz enable` used to call core's install_channel_for_agent and then
# `agent config set channels=…,buzz`. The second already installs the channel for
# an agent that did not have it (core's _config_install_channel), so through the
# CLI the first is a no-op. The one thing lost is re-installing the channel on an
# agent that already lists buzz; `5dive doctor` names a seat whose plugin is
# missing.
install_channel_for_agent() { :; }

cmd_config() { "$BUZZ_5DIVE_BIN" agent config "$@"; }

# One NDJSON line per mutating verb into core's audit log, the way council does
# it. Best-effort: an audit sink that is down must not fail the verb.
buzz_audit() {
  local cmd="$1"; shift
  local line
  line="$(jq -cn --arg ts "$(date -Iseconds)" --arg u "${SUDO_USER:-${USER:-root}}" \
    --arg c "$cmd" --args '{ts:$ts, user:$u, cmd:$c, args:$ARGS.positional, via:"buzz-plugin"}' \
    -- "$@" 2>/dev/null)" || return 0
  [[ $EUID -eq 0 ]] || return 0
  printf '%s\n' "$line" | "$BUZZ_5DIVE_BIN" _audit_append >/dev/null 2>&1 || true
  return 0
}
