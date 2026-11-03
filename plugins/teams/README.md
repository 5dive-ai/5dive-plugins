# @5dive/teams-plugin

Microsoft Teams channel for Claude Code. Each agent is its own contact in the customer's Microsoft 365 tenant, the way each agent is its own Telegram bot (DIVE-7658).

```
Teams ──HTTPS──▶ box Caddy (teams-<agent>.<box domain>) ──▶ 127.0.0.1:<port>/api/messages  (server.ts)
server.ts ──HTTPS──▶ Bot Connector serviceUrl (Microsoft) ──▶ Teams
```

No 5dive server is on the path. Refused on a local-only (offline) box.

- **Setup**: `sudo 5dive agent teams connect|status|disconnect <agent>` (`bin/teams`). The IT steps are in [docs/IT-GUIDE.md](docs/IT-GUIDE.md).
- **Config**: `~/.claude/channels/teams/config.json` (0600, the agent's): `app_id`, `tenant_id`, `app_password`, `port`, `public_url`, `allowed_users`.
- **Session contract**: the same as Telegram. Inbound is `<channel source="teams" chat_id … user user_id ts>`, with `file_path` for a received file and `via="button"` for a tap. Outbound is `reply` (text, `files`) and `edit_message`. A trailing numbered list (2-8 lines, each under 90 characters) becomes Adaptive Card buttons.
- **Logs**: `~/.claude/channels/teams/messages.log` (one metadata line per message, never its text) and `lifecycle.log`.

## Security

- Every request: Bot Framework JWT (RS256, Microsoft's published keys, the key must endorse `msteams`), issuer, audience = this bot, expiry, and the token's `serviceurl` claim must equal the activity's (`auth.ts`).
- Then: the tenant must be the customer's, the chat must be 1:1, and an optional `allowed_users` list (`activity.ts`).
- The bot token is only ever sent to Microsoft's Bot Framework hosts; file uploads only to SharePoint/OneDrive; downloads only from those, after a private-address check (`hosts.ts`).
- A reply goes only to a chat that has written to the agent.

## Not yet

- Group chats and channels.
- The typed fallback the Telegram and dashboard plugins have for seats where Claude Code refuses channels (API-billed seats). A Claude Team/Enterprise org also needs channels allowed by its admin.
- Other harnesses (Codex, Hermes, OpenClaw...). OpenClaw has its own `@openclaw/msteams`.

## Credits

The service-URL and file-host allowlists, the file-consent card flow and the card-submit reading are ported from OpenClaw's `extensions/msteams` (MIT). See the repository's NOTICE.

Built on Microsoft's REST protocol directly (`jose` for the signature) rather than `@microsoft/teams.apps`: that SDK brings its own HTTP app and lifecycle (express), while this plugin is one MCP process that must start and stop with the agent's session, and stay small enough to ship in the offline mirror.
