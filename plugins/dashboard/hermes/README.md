# 5dive app chat for Hermes

Talk to your Hermes agent from the [5dive](https://5dive.ai) app, on the web
and on your phone. Type or send a voice note; the agent answers in the same
chat.

## How it works

On a 5dive box, the 5dive bridge receives every message you type in the app
and leaves it in a local folder. This plugin hands each message to the Hermes
gateway and writes the agent's answer back to the same folder, and the bridge
sends it to the app.

- No network listener and no token: the folder is private to the agent's own
  user (mode 0700).
- One sender only: the bridge writes as `5dive-app`, and the plugin pins
  `FIVEDIVE_ALLOWED_USERS` to it.
- Voice notes arrive as text (the bridge transcribes them on the box); a
  voice note gets a short spoken-style answer.
- Files and images go both ways.

## Setup

5dive sets this up for you when you turn on the app chat for a Hermes agent
(`5dive agent config <name> set channels=dashboard`). By hand:

```bash
hermes plugins install fivedive        # or link this folder into ~/.hermes/plugins/fivedive
hermes plugins enable fivedive
```

and in `~/.hermes/.env`:

```
FIVEDIVE_SPOOL_DIR=/home/<you>/.hermes/channels/5dive
FIVEDIVE_ALLOWED_USERS=5dive-app
```

Then restart the gateway (`hermes gateway restart`).

| Variable | Needed | What it is |
| --- | --- | --- |
| `FIVEDIVE_SPOOL_DIR` | yes | the folder the 5dive bridge reads and writes (`inbox/`, `outbox/dashboard/`) |
| `FIVEDIVE_ALLOWED_USERS` | recommended | allowed senders; the bridge sends as `5dive-app` |
| `FIVEDIVE_ALLOW_ALL_USERS` | no | `true` lets every sender in the folder through |
| `FIVEDIVE_REPLY_MAX_WORDS` | no | word cap on one answer (default 70; a longer one goes back to the agent to shorten; `0` turns it off) |
| `FIVEDIVE_HOME_CHANNEL` | no | where cron results go; the app chat is `dashboard` |

Needs Hermes 0.19.0 or newer.

## What it touches

- Reads and writes only its spool folder, plus the upload files the 5dive
  bridge names in a message (on the same box).
- Checks the folder every half second while the gateway runs.
- No network calls, no listener, no shell commands, no stored credentials,
  no telemetry.

## Maintainer

5dive ([5dive-ai/5dive-plugins](https://github.com/5dive-ai/5dive-plugins)),
Apache-2.0. Issues: https://github.com/5dive-ai/5dive-plugins/issues
