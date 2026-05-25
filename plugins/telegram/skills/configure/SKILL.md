---
name: configure
description: Set up the Telegram channel — save the bot token and review access policy. Use when the user pastes a Telegram bot token, asks to configure Telegram, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /telegram:configure — Telegram Channel Setup

Writes the bot token to `~/.claude/channels/telegram/.env` and orients the
user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/telegram/.env` for
   `TELEGRAM_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked
   (`123456789:...`).

2. **Access** — read `~/.claude/channels/telegram/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

3. **Channel allowlist** — without this, slash commands and the `reply`
   tool work, but inbound Telegram messages never reach the agent's
   context. The file is platform-specific:

   - **macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
   - **Linux**: `/etc/claude-code/managed-settings.json`
   - **Windows**: `%ProgramData%\ClaudeCode\managed-settings.json`

   Read the file (it may not exist — that's the common case for
   standalone plugin installs). Expected shape:

   ```json
   {
     "allowedChannelPlugins": [
       {"plugin": "telegram", "marketplace": "5dive-plugins"}
     ]
   }
   ```

   Each entry is an **object** `{plugin, marketplace}`, not a string.
   claude rejects strings here with "Expected object, but received
   string" — common mistake.

   Verdict to surface:
   - **File missing**, or `allowedChannelPlugins` missing, or no entry
     has both `plugin=telegram` and `marketplace=5dive-plugins`:

     > ⚠️  Channel auto-injection not enabled — inbound Telegram
     > messages won't reach claude's context yet. One-time setup;
     > run in a separate terminal (you'll be prompted for sudo):
     >
     > ```
     > sudo tee "<path>" >/dev/null <<'EOF'
     > {"allowedChannelPlugins":[{"plugin":"telegram","marketplace":"5dive-plugins"}]}
     > EOF
     > ```
     >
     > Then restart claude.

     Substitute `<path>` for the platform-specific path. If the file
     already exists with other entries (upstream telegram, discord,
     etc.), tell the user to **merge** — don't overwrite. Show them
     the merged JSON to end up with.

   - **Entry present**: one-line green check ("✓ Channel allowlist
     includes telegram@5dive-plugins"). Move on.

4. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram:configure <token>` with the token from
     BotFather."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Telegram. It replies with a code; approve with `/telegram:access pair
     <code>`."*
   - Token set, someone allowed, allowlist missing → *"DMs reach the bot
     but won't surface into claude until you write the channel allowlist
     (one sudo command above). Run that, then restart claude."*
   - Token set, someone allowed, allowlist OK → *"Ready. DM your bot to
     reach the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture Telegram user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/telegram:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/telegram:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their numeric ID
   (have them message @userinfobot), or you can briefly flip to pairing:
   `/telegram:access policy pairing` → they DM → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p ~/.claude/channels/telegram`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/telegram/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram:access` take effect immediately, no restart.
