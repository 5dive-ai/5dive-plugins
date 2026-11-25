#!/usr/bin/env bash
# plugins/phone is 5dive-ai/5dive-phone's phone/, byte for byte. Contract, usage and env: tests/plugin_mirror.sh.
exec bash "$(dirname "$0")/plugin_mirror.sh" phone "$@"
