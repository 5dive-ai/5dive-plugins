# hosted

Commands that only work on a server 5dive built, because they talk to 5dive's
own servers as that server (its box token in `/etc/5dive/connectord.env`).

| command | what it does |
|---|---|
| `5dive partner hire <pack> [--as=<name>]` | on a partner's server: a client's agent hires a colleague from the partner's catalogue. No root. |
| `5dive first-job …` | the owner's first job at hire: the agent answers it, the reply waits in Telegram, it shows as a done task, the API is told. Root; the 5dive API and running units reach it through core's `5dive agent first-job` / `agent _first_job_run`, which forward here. |
| `5dive handover status` | the pre-sale handover: what the owner told 5dive before buying goes to their first hire once. Core's heartbeat runs `handover _tick` (root) until it is done. |
| `5dive team update <team> [--allow-downgrade]` | a premium team bought from 5dive to its newest version: asks 5dive for the buyer's newest signed file and hands it to core's `5dive team import`, which checks and applies it. Root. Core's `team update` forwards to this plugin's `premium-team update`. |
| `lib/push-notify.sh` | not a command: the phone push an agent's hooks send when it fails. 5dive's install copies it, root-owned, to `/usr/local/lib/5dive/push-notify.sh`, the path the agents' sudoers grants name. |

5dive's install and upgrade add this plugin on every server 5dive built, in the
same run (`install.sh`, `_hosted_plugin_ensure`), and on any server with a box
token that holds a premium team. Any other self-hosted server is never given it;
there, use `5dive hire`.

Moved out of the core CLI in DIVE-9324. `bin/partner` carries core's
`src/cmd_partner.sh` verbatim; `tests/hosted_partner_unit.sh` pins it.

`lib/push-notify.sh` is the CLI's `hooks/push-notify.sh` at the same commit, carried
verbatim (DIVE-9327); `tests/hosted_push_notify_unit.sh` pins it.

`bin/first-job` is the CLI's `src/cmd_agent_first_job.sh` at 5dive-ai/5dive 2edbe6f9 with one
function replaced: the done task is filed through core's `5dive task record-done`, not by SQL
(DIVE-9328); `tests/hosted_first_job_unit.sh` pins the rest.

`bin/handover` is the handover half of the CLI's `src/cmd_helper.sh` (DIVE-9329); the old
helper seat's welcome was retired, not moved. `tests/hosted_handover_unit.sh` pins it.

`bin/premium-team` is the CLI's `_team_premium_update_online` (`src/cmd_team_pack.sh`, DIVE-9116)
with core's `cmd_team import` called as `5dive team import` (DIVE-9330). `tools/premium-team-build.sh`
is the CLI's `packaging/premium-team/build.sh` (the reference producer of premium team files;
5dive's API makes the real ones with a port of it), with only its header updated.
`tests/hosted_premium_team_unit.sh` pins both.
