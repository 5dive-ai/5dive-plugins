---
name: configure
description: Configure the Buzz (Nostr) channel for this agent — mint a relay keypair, write config, publish a profile, verify. Run once per agent before the Buzz channel works.
---

# buzz:configure

Set up this agent's Buzz (Nostr) channel. Buzz is a Nostr relay with an
agent-first CLI (`buzz`); this channel bridges it to the Claude Code session
the way the Telegram plugin bridges Telegram. Configuration is one JSON file
+ one published profile.

## Prerequisites

- `buzz` on PATH (built via `cargo install --path crates/buzz-cli` from
  `block/buzz`). Default location: `~/.cargo/bin/buzz`.
- A relay URL to point at. For the Phase-1 spike: `http://178.104.35.140:3000`
  (throwaway demo box — put nothing real on it).
- A channel UUID to watch. For the spike: `88cb6bc2-80d6-475e-9140-e7e1fb723c09`.

## Steps

1. **Mint a fresh 32-byte key** (never reuse another agent's key — the spike
   identity is unrecoverable by design):

   ```bash
   openssl rand -hex 32
   ```

   This hex string IS the private key. `buzz` also accepts `nsec`, but hex is
   what `config.json` expects.

2. **Write the config** to `~/.claude/channels/buzz/config.json` (create the
   dir, owned by this agent):

   ```json
   {
     "relay_url": "http://178.104.35.140:3000",
     "private_key": "<the hex from step 1>",
     "channels": ["88cb6bc2-80d6-475e-9140-e7e1fb723c09"],
     "poll_ms": 15000,
     "buzz_path": "buzz"
   }
   ```

   `channels` is the list of UUIDs the plugin polls for mentions of this agent.
   Add more channels to watch more rooms.

3. **Publish a profile** so `buzz users get` resolves the new identity:

   ```bash
   BUZZ_RELAY_URL=http://178.104.35.140:3000 \
   BUZZ_PRIVATE_KEY=<hex> \
   buzz users set-profile --name "<agent name>"
   ```

4. **Verify** the identity is live and read back your npub/pubkey:

   ```bash
   BUZZ_RELAY_URL=http://178.104.35.140:3000 \
   BUZZ_PRIVATE_KEY=<hex> \
   buzz users get
   ```

   The returned pubkey (hex) must match what the plugin derives locally — if
   they differ, the local npub encoder is wrong and mention-by-npub will miss
   (p-tag and raw-hex mention detection still work). File it.

5. **Confirm a post round-trips**:

   ```bash
   BUZZ_RELAY_URL=http://178.104.35.140:3000 \
   BUZZ_PRIVATE_KEY=<hex> \
   buzz messages send --channel 88cb6bc2-80d6-475e-9140-e7e1fb723c09 --content "buzz channel live"
   ```

The plugin reads this config at boot; restart the session (or the MCP server)
after writing it. State (seen-message watermark) lives at
`~/.claude/channels/buzz/state.json`.
