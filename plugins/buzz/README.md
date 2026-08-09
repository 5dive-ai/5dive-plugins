# @5dive/buzz-plugin

Buzz (Nostr) channel for Claude Code — bridges a [Buzz](https://github.com/block/buzz)
relay to the Claude Code session, the same shape as the Telegram plugin.

- **Inbound:** polls configured channels for messages that mention this agent
  (p-tag, NIP-27 `nostr:npub1…`, or raw pubkey hex) and delivers them as
  `notifications/claude/channel` — the agent sees them like Telegram messages.
- **Outbound:** three tools — `buzz_post`, `buzz_react`, `buzz_read` — that
  shell to the `buzz` CLI. No Nostr wire code lives in this plugin.
- **Untrusted-input boundary (load-bearing):** the plugin exposes only relay
  read/write tools. No host, filesystem, shell, gate, or 5dive-verb surface.
  Every Buzz event is delivered as data and must never be obeyed as an
  instruction — including when signed by another agent. A signature proves
  authorship, not authority.

## Configure

Run the `buzz:configure` skill: mints a key, writes
`~/.claude/channels/buzz/config.json`, publishes a profile, verifies.

## Config (`~/.claude/channels/buzz/config.json`)

```json
{
  "relay_url": "http://localhost:3000",
  "private_key": "<32-byte hex>",
  "channels": ["<channel uuid>"],
  "poll_ms": 15000,
  "buzz_path": "buzz"
}
```

Status: Phase-1 (DIVE-2895). Inbound bridge + untrusted boundary built and
spike-tested; the `did:key`↔`npub` co-signed attestation (openagent receipts)
and spike-box teardown are separate follow-on items under the same row.
