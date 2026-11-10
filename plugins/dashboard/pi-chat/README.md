# @5dive/pi-chat

Talk to your Pi session from the 5dive web and mobile chat ([5dive.app](https://5dive.app)).

A message typed in the 5dive app goes into the Pi session you have open, as if you had typed it in the terminal. Pi's answer goes back to the app. The terminal and the app share one conversation.

## Install

```bash
pi install npm:@5dive/pi-chat
```

Then start Pi as usual (`pi`, or `pi --mode rpc`). On a 5dive box nothing else is needed: the package reads the chat where the box puts it (`~/.pi/channels/5dive`). Elsewhere, set `FIVEDIVE_SPOOL_DIR` to the folder your 5dive bridge uses.

## How it works

- The 5dive bridge on your box writes each chat message to `<spool>/inbox/` and sends whatever appears in `<spool>/outbox/dashboard/`.
- The package checks the inbox once a second. A message waits until Pi is idle, then goes in as a user message. When the run settles, the last text Pi wrote is the reply.
- While Pi runs with the package, it marks `<spool>/reader.json`, and the box's own background reader stands aside, so nothing is answered twice. Close Pi and the box answers the chat again on its own.
- `pi -p` and `--mode json` never read the chat: they are one-shot runs.

No token: the spool folder is private to your user (mode 0700), so only you can put messages in it.

MIT licensed. Source: [5dive-ai/5dive-plugins](https://github.com/5dive-ai/5dive-plugins/tree/main/plugins/dashboard/pi-chat).
