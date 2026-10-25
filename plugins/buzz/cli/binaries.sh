# shellcheck shell=bash
# DIVE-6934 — the buzz relay binaries (`buzz`, `buzz-pair`) come with this plugin.
#
# Until DIVE-6934 core's install.sh downloaded both on EVERY install and every
# `--upgrade` (DIVE-3554), on every box, for a channel almost no box runs. The
# download is now this plugin's job: `5dive buzz binaries` stages them, and the
# verbs that need one stage it on first use. They land INSIDE the installed
# plugin ($FIVEDIVE_PLUGIN_DIR/libexec), so `5dive plugin remove buzz` removes
# them with the plugin.
#
# Carried from core install.sh's stage_buzz_binaries (5dive-ai/5dive 497ec15a)
# with the same release tag and the same pinned SHA256SUMS digest. Differences:
# the destination (libexec here, not /usr/local/bin), and a failure is an exit
# code the caller can act on rather than an installer warning.
#
# A box that already has /usr/local/bin/buzz from an older install keeps it:
# the resolvers in cmd_agent_buzz.sh / cmd_agent_buzz_pair.sh still find it.

BUZZ_CLI_TAG="${BUZZ_CLI_TAG:-cli-v0.1.2}"
BUZZ_SUMS_SHA256="${BUZZ_SUMS_SHA256:-124425c0961df092622cd0225e90b453b885cbe83758e829d0399b02b5f02155}"

# The installed plugin's directory. Core exports FIVEDIVE_PLUGIN_DIR as the
# enabled POINTER ($STATE_DIR/plugins/enabled/buzz@<mkt>), which survives an
# upgrade — so the path a seat's config.json records stays valid across one.
_buzz_plugin_dir() {
  if [[ -n "${FIVEDIVE_PLUGIN_DIR:-}" ]]; then
    printf '%s\n' "$FIVEDIVE_PLUGIN_DIR"
  else
    printf '%s\n' "$BUZZ_PLUGIN_ROOT"
  fi
}
_buzz_libexec() { printf '%s/libexec\n' "$(_buzz_plugin_dir)"; }

# _buzz_stage_binaries — rc 0 when both binaries are present and verified.
_buzz_stage_binaries() {
  local base tmp sums rc=0 arch dir
  arch="$(uname -m 2>/dev/null || echo unknown)"
  if [[ "$arch" != "x86_64" ]]; then
    warn "buzz binaries not staged — the $BUZZ_CLI_TAG release ships x86_64 builds only and this box is $arch."
    return "$E_NOT_INSTALLED"
  fi
  dir="$(_buzz_libexec)"
  mkdir -p "$dir" || { warn "cannot create $dir"; return "$E_GENERIC"; }
  chmod 755 "$dir" 2>/dev/null || true
  base="${BUZZ_REL_BASE:-https://github.com/${GH_ORG:-5dive-ai}/buzz/releases/download/$BUZZ_CLI_TAG}"

  tmp="$(mktemp -d)" || return "$E_GENERIC"
  if ! curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
    warn "could not fetch $base/SHA256SUMS — buzz binaries not staged."
    rm -rf "$tmp"; return "$E_GENERIC"
  fi
  sums="$(sha256sum "$tmp/SHA256SUMS" | awk '{print $1}')"
  if [[ "$sums" != "$BUZZ_SUMS_SHA256" ]]; then
    warn "buzz SHA256SUMS for $BUZZ_CLI_TAG does not match the pinned digest (want ${BUZZ_SUMS_SHA256:0:16}…, got ${sums:0:16}…) — refusing to install unverified relay binaries. Nothing was changed."
    rm -rf "$tmp"; return "$E_VALIDATION"
  fi

  local bin want got dst bin_tmp
  for bin in buzz buzz-pair; do
    dst="$dir/$bin"
    want="$(awk -v b="$bin" '$2 == b || $2 == "*" b {print $1; exit}' "$tmp/SHA256SUMS")"
    if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
      warn "$BUZZ_CLI_TAG SHA256SUMS names no sha256 for '$bin' — not installed."
      rc="$E_VALIDATION"; continue
    fi
    if [[ -x "$dst" ]] && [[ "$(sha256sum "$dst" | awk '{print $1}')" == "$want" ]]; then
      step "$bin already at $BUZZ_CLI_TAG (sha256 verified)"
      continue
    fi
    bin_tmp="$(mktemp "${dir}/.${bin}.XXXXXX")" || { rc="$E_GENERIC"; continue; }
    if ! curl -fsSL "$base/$bin" -o "$bin_tmp" 2>/dev/null; then
      rm -f "$bin_tmp"
      warn "failed to download $bin from $base — not installed."
      rc="$E_GENERIC"; continue
    fi
    got="$(sha256sum "$bin_tmp" | awk '{print $1}')"
    if [[ "$want" != "$got" ]]; then
      rm -f "$bin_tmp"
      warn "$bin checksum mismatch (want ${want:0:16}…, got ${got:0:16}…) — refusing to install."
      rc="$E_VALIDATION"; continue
    fi
    chmod 755 "$bin_tmp"
    mv -f "$bin_tmp" "$dst"
    step "$bin → $dst ($BUZZ_CLI_TAG, sha256 verified)"
  done
  rm -rf "$tmp"
  return "$rc"
}

# _buzz_ensure_binary <buzz|buzz-pair> — stage on first use, quietly when present.
# Only root can write into the plugin; anyone else gets the resolver's answer.
_buzz_ensure_binary() {
  local bin="$1"
  [[ -x "$(_buzz_libexec)/$bin" ]] && return 0
  [[ $EUID -eq 0 ]] || return 0
  [[ "${BUZZ_NO_AUTO_STAGE:-0}" == "1" ]] && return 0
  _buzz_stage_binaries >&2 || true
}

# cmd: 5dive buzz binaries
_buzz_binaries() {
  case "${1:-}" in
    ""|stage) : ;;
    -h|--help) fail "$E_USAGE" "usage: 5dive buzz binaries   # download buzz + buzz-pair into the plugin (sha256-pinned)" ;;
    *) fail "$E_USAGE" "unknown argument: $1" ;;
  esac
  require_root "buzz binaries"
  local rc=0
  _buzz_stage_binaries || rc=$?
  (( rc == 0 )) || fail "$rc" "buzz binaries are not fully staged in $(_buzz_libexec) — see the warnings above"
  ok "buzz binaries staged in $(_buzz_libexec)" '{dir:$d, tag:$t}' --arg d "$(_buzz_libexec)" --arg t "$BUZZ_CLI_TAG"
}
