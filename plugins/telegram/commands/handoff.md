---
description: Write a structured session carryover so a fresh session resumes without losing context
---

# /handoff — context carryover

The current session's context window is filling up. Capture everything a **fresh
session** would need so the user can start clean without losing the thread, then
tell them to start over.

## Write the carryover

Write a single handoff file into your memory directory (the same
`.../memory/` folder your other memories live in), named
`handoff_session_<YYYY-MM-DD>.md` (use today's date; if one already exists,
overwrite it with the current state). Frontmatter:

```markdown
---
name: handoff_session_<YYYY-MM-DD>
description: "SESSION HANDOFF (<date> <time> UTC) — read FIRST on fresh start, then delete once caught up"
metadata:
  type: project
---
```

Body — be concrete and specific, not generic. Include:

- **Goal / what we're doing** — the active task(s) and why, in 1-2 lines.
- **State right now** — what's done, what's in flight, what's verified vs not.
  Name exact files, commands, task IDs, commit SHAs, versions.
- **Open threads** — every loose end, numbered, with enough detail to resume
  blind. Include anything blocked on the user.
- **Next step** — the single most concrete thing to do first on resume.
- **Channel** — if paired over Telegram, note the chat_id so the new session
  knows how to reply.

End the body with a line telling the next session to **delete this file and its
`MEMORY.md` pointer once it has caught up** (it is a one-shot carryover, not a
permanent memory).

Then add a one-line pointer to `MEMORY.md` (`- [SESSION HANDOFF <date>](handoff_session_<date>.md) — READ FIRST if fresh`).

## Then tell the user

Confirm over their channel (Telegram reply if paired) in one short message:
the handoff is saved, and they can **start a fresh session (`/clear` or a new
run) whenever** — the next session auto-loads the carryover from memory and
picks up where this one left off. Do not start a new session yourself; leave
that to the user.
