# 5dive app channel for OpenClaw

`@5dive/openclaw-channel` lets you talk to an OpenClaw agent from the
[5dive](https://5dive.ai) web and mobile chat.

Maintained by 5dive, in [5dive-ai/5dive-plugins](https://github.com/5dive-ai/5dive-plugins)
(`plugins/dashboard/openclaw-channel`). Report problems there, not to OpenClaw.

## How it works

On a 5dive box, a small bridge (`plugins/dashboard/server.ts`) receives every
chat message and leaves it as a JSON file in a local spool folder. This
channel reads the folder, gives each message to the agent as a direct message
from the box's owner, and writes the agent's answer back. The bridge sends
the answer to the chat.

```
<spool>/inbox/<id>.json              bridge -> channel (one message per file)
<spool>/outbox/dashboard/<id>.json   channel -> bridge (one reply per file)
```

Both sides write a temporary name first and then rename it, so nobody reads
half a file. The folder is mode 0700 for the agent's own user, so there is no
token and no network listener: only that user can put a message in it.

- Messages are taken oldest first. Each file is deleted before the agent sees
  it, so a restart never answers the same message twice.
- Every message comes from one sender, `5dive-app`, in one chat, `dashboard`.
- An uploaded file reaches the agent as its path on the box
  (`[Attached file: /path]`, `[Voice note: /path]`).
- After a voice note, the next reply is marked so the bridge speaks it.
- Files the agent attaches (absolute local paths) are sent to the chat.

This is the same contract as the 5dive Hermes plugin
(`plugins/dashboard/hermes/adapter.py`).

## Setup

You only need this on a 5dive box; the bridge creates the spool. Then:

```bash
openclaw plugins install @5dive/openclaw-channel
```

and either set an environment variable for the gateway:

| Variable                   | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `FIVEDIVE_SPOOL_DIR`       | The spool folder (required). On a 5dive OpenClaw seat it is `~/.openclaw/channels/5dive`. |
| `FIVEDIVE_ALLOWED_USERS`   | Comma-separated senders allowed in. Default: `5dive-app`.  |
| `FIVEDIVE_ALLOW_ALL_USERS` | `true` to allow every sender in the spool.                 |

or put the same in the OpenClaw config (the environment wins):

```json5
{
  channels: {
    fivedive: {
      spoolDir: "/home/<seat>/.openclaw/channels/5dive",
      allowFrom: ["5dive-app"],   // default
      dmPolicy: "allowlist",      // default
      pollMs: 500                 // default
    }
  }
}
```

Run only one reader per spool. Before you turn this channel on for a seat,
turn off the older one-turn-per-message bridge (`openclawdispatch.ts`), which
reads the same inbox.

## Not included yet

- The web chat's reply word cap (the Hermes plugin and `openclawdispatch.ts`
  ask the agent to shorten a long answer). Here a long answer goes as written,
  cut only at 16,000 characters.
- Typing indicators: the bridge shows the chat's own "working" state.

## Develop

```bash
bun test src/spool.test.ts                       # spool and poll loop, no OpenClaw needed
npm install && npx tsc -p tsconfig.json --noEmit # typecheck against openclaw 2026.11.1
npm run build                                    # dist/ for publishing
```

Built against the OpenClaw 2026.11.1 plugin SDK (`openclaw.compat.pluginApi`).
