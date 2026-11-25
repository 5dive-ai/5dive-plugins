# hosted

Commands that only work on a server 5dive built, because they talk to 5dive's
own servers as that server (its box token in `/etc/5dive/connectord.env`).

| command | what it does |
|---|---|
| `5dive partner hire <pack> [--as=<name>]` | on a partner's server: a client's agent hires a colleague from the partner's catalogue. No root. |
| `lib/push-notify.sh` | not a command: the phone push an agent's hooks send when it fails. 5dive's install copies it, root-owned, to `/usr/local/lib/5dive/push-notify.sh`, the path the agents' sudoers grants name. |

5dive's install and upgrade add this plugin on every server 5dive built, in the
same run (`install.sh`, `_hosted_plugin_ensure`). A self-hosted server is never
given it; there, use `5dive hire`.

Moved out of the core CLI in DIVE-9324. `bin/partner` carries core's
`src/cmd_partner.sh` verbatim; `tests/hosted_partner_unit.sh` pins it.

`lib/push-notify.sh` is the CLI's `hooks/push-notify.sh` at the same commit, carried
verbatim (DIVE-9327); `tests/hosted_push_notify_unit.sh` pins it.
