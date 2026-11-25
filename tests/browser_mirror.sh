#!/usr/bin/env bash
# plugins/browser is 5dive-ai/5dive-browser's browser/, byte for byte. Contract, usage and env: tests/plugin_mirror.sh.
exec bash "$(dirname "$0")/plugin_mirror.sh" browser "$@"
