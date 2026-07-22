---
name: notify-user
description: Telegram comms playbook — when and how to reply, ack long work, present choices, and delegate to other agents. Use whenever you're paired to a Telegram chat and need to talk back to the user.
---

# notify-user — Telegram comms playbook

You're paired with a Telegram chat via this plugin's bot. The user reads only
what reaches the chat — transcript text never gets to them. Every inbound
Telegram message MUST get a `reply` before the turn ends, even if it's just
"Done."

## Cadence

- **Inbound → ack <5s.** Send a short "on it" reply before starting any
  non-trivial work. The Telegram-paired user has no other signal that you
  received the message.
- **Long work → edit only if you're still the latest message.** Use
  `edit_message` for progress updates so the user's phone doesn't buzz on
  every tick — but only if your previous reply is still the newest message
  in the chat. If a fresher message exists (a new inbound from the user, or
  another reply you sent in between), the older message will be missed in
  scrollback; send a new `reply` instead.
- **Editing keeps a sticky header.** The server auto-prepends the original
  reply's text on every `edit_message`, so the task ack stays visible while
  the status below it changes. Pass ONLY the new status as the `text` arg —
  don't re-include the original ack, or it'll be doubled (the server tries
  to detect and strip echoed headers, but it's best to just send the delta).
- **Done or blocked → new reply.** A fresh `reply` triggers push
  notification; an edit does not.
- **Silence ceiling: ~60s.** Beyond that the user starts assuming the
  bridge broke. Send a short edit or new reply (per the latest-message
  rule above) even mid-work if a substantive reply is still >60s away.

## Hard rules

- **Reply via the MCP tool, not transcript.** Plain assistant text is
  invisible to the Telegram user. The Stop hook will auto-relay missed
  text as a safety net — treat that fallback as a hard error signal, not
  something to rely on.
- **No `AskUserQuestion` or `ExitPlanMode`.** Their pickers render only
  in a local terminal; the plugin's PreToolUse hook denies them in
  telegram-paired sessions. Inline the question or plan into a normal
  reply and wait for the next inbound.

## Attaching files

If your reply references or links a local file — a `.md` note, log,
screenshot, generated asset, or a path you'd otherwise paste — **attach it
via the `reply` tool's `files=` param** (an array of absolute paths). Never
send a bare path or filename: the paired user has **no terminal or
filesystem access**, so a path is a dead link — the file itself is the
deliverable. Images send as inline photos, other types as documents (≤50MB
each). Two caveats: don't attach secrets, and don't attach a file you
haven't read (attaching distributes it).

## Presenting choices

Use Telegram inline-keyboard buttons, not a numbered list. The `reply`
MCP tool sends text and file attachments (see above) but **not** inline
keyboards — for buttons, hit the Bot API directly:

```bash
CHAT_ID=$(jq -r '.allowFrom[0]' ~/.claude/channels/telegram/access.json)
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="Pick one:" \
  --data-urlencode reply_markup='{"inline_keyboard":[[{"text":"Option A","callback_data":"a"},{"text":"Option B","callback_data":"b"}]]}'
```

`TELEGRAM_BOT_TOKEN` is in the systemd unit's env; `CHAT_ID` is the first
entry of `allowFrom` in `access.json`.

## Delegating to another agent

When the user asks you to consult another 5dive agent whose bot is
already in this chat, pass the chat context so that agent replies
**directly via its own bot** — don't relay through yours. Use
`5dive agent send <name> "<msg>" --from=<your-name>` (or `agent ask` for
sync) and include `chat_id`, the requesting user's handle, and an
explicit instruction to post in that chat itself. Attribution is
cleaner and the chat reads more naturally.

If the target bot is **not** in the chat, fall back to relaying and tell
the user the bot isn't a member so they can add it.

## Asking the human (gates)

When you're blocked on a human decision/approval, file a gate with `5dive task
need` (it DMs the owner automatically) instead of hand-rolling a message:

- Keep the **ask to ONE crisp question + ~1 line of essential context**. Heavy
  detail (tradeoffs, background) goes in the task **body**, not the ask — the
  body shows on the dashboard and in `5dive task show`.
- **Always surface your recommendation up front** with `--recommend="<option>"`.
  The alert then leads with `✅ Recommended: <X>` and ⭐-marks/seats that option's
  tap button first. For a decision, `--recommend` must match one of `--options`.

```bash
5dive task need DIVE-123 --type=decision \
  --options="ship as channel|keep as plugin" \
  --recommend="ship as channel" \
  --ask="Ship the X integration as a first-class channel? (recommended — see body for tradeoffs)"
```
