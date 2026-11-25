# hosted

Commands that only work on a server 5dive built, because they talk to 5dive's
own servers as that server (its box token in `/etc/5dive/connectord.env`).

| command | what it does |
|---|---|
| `5dive partner hire <pack> [--as=<name>]` | on a partner's server: a client's agent hires a colleague from the partner's catalogue. No root. |

5dive's install and upgrade add this plugin on every server 5dive built, in the
same run (`install.sh`, `_hosted_plugin_ensure`). A self-hosted server is never
given it; there, use `5dive hire`.

Moved out of the core CLI in DIVE-9324. `bin/partner` carries core's
`src/cmd_partner.sh` verbatim; `tests/hosted_partner_unit.sh` pins it.
