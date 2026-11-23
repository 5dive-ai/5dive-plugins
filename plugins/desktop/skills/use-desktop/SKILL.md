---
name: use-desktop
description: Do something in an app on the owner's own Windows PC — open an app, read what a window shows, click a button, type into a field, save a file, fill a form in a desktop program. Use for "on my computer …", "open Excel/Outlook/Notepad and …", "click … in <app> on my PC", or anything that lives in a desktop app and not on a website. Not for websites (use the browser) and not for files on this server.
---

# use-desktop — snapshot, act by ref, check; the owner can Stop you any time

`5dive desktop <verb>` reaches the owner's Windows PC through the 5dive desktop app. The PC
runs each step with agent-desktop (UI Automation): it reads the app's controls, never a
screenshot. **Start with the verb.** Do not run `--help` or `status` first. A `snapshot` that
cannot reach the PC says so at once (exit 69).

The owner turns this on in the 5dive app on their PC ("Let my agent use this computer"). While
a job runs, the PC shows "Agent is using your computer" with a **Stop** button.

## The loop: ONE snapshot per decision

```bash
5dive desktop snapshot --app=Notepad --interactive    # the app's controls, each with a ref
5dive desktop act --app=Notepad --steps='[{"do":"type","ref":"@s8f3k2p9:e2","text":"Meeting notes"},
                                          {"do":"press","keys":"ctrl+s"}]'
```

1. **Snapshot** with `--app=<name>` and `--interactive`. Pick refs from what it printed. No
   `--app` reads the window in front.
2. **Act** on those refs. `--steps` is a JSON array, run in order, one call. Each step is one
   `do` (below). **A ref is copied whole from the snapshot**, like `@s8f3k2p9:e2`. A short `@e2`
   is refused on the PC. Refs belong to the snapshot that printed them.
3. **Check** with the fresh snapshot the act prints at the end. Find the proof there: the text
   you typed, the saved title, the new window. Snapshot again only if the act's snapshot does
   not show the control you need.

**Never guess a ref.** Not from an older snapshot, not from a pattern, not one you think should
be there. If the PC answers `STALE_REF` or `AMBIGUOUS_TARGET`, the window changed: take a new
snapshot and use its refs.

## Steps (`do` → what runs on the PC)

| step | runs on the PC |
|---|---|
| `{"do":"click","ref":R}` | `agent-desktop click R` |
| `{"do":"double-click","ref":R}` | `agent-desktop --headed double-click R` |
| `{"do":"right-click","ref":R}` | `agent-desktop --headed right-click R` |
| `{"do":"type","ref":R,"text":T}` | `agent-desktop --headed type R --stdin` (T on stdin) |
| `{"do":"set-value","ref":R,"text":T}` | `agent-desktop set-value R --stdin` |
| `{"do":"clear","ref":R}` | `agent-desktop clear R` |
| `{"do":"focus","ref":R}` | `agent-desktop --headed focus R` |
| `{"do":"select","ref":R,"text":OPTION}` | `agent-desktop select R OPTION` |
| `toggle`, `check`, `uncheck`, `expand`, `collapse`, `scroll-to` with a `ref` | `agent-desktop <do> R` |
| `{"do":"scroll","ref":R,"direction":"down","amount":3}` | `agent-desktop scroll R --direction down --amount 3` |
| `{"do":"press","keys":"ctrl+s"}` (optional `"app"`) | `agent-desktop press ctrl+s` (with an app: `--headed press ctrl+s --app A`) |
| `{"do":"launch","app":"notepad"}` | `agent-desktop launch notepad` |
| `{"do":"close-app","app":A}` | `agent-desktop close-app A` |
| `{"do":"focus-window","app":A}` | `agent-desktop focus-window --app A` |
| `{"do":"wait","ms":1000}` | `agent-desktop wait 1000` (up to 30000) |

`type` adds text where the cursor is. `set-value` replaces the field's whole value. Use `wait` only
when a window needs a moment to open.

## Paying, posting, sending and deleting are the owner's call

On the PC there is no page for the box to read, so **you say what a step does**: a step that
pays, posts, sends or deletes carries `"kind":"pay"`, `"post"`, `"send"` or `"delete"`. Clicking
Send in Outlook is `send`. Clicking Pay or Place order is `pay`. Publishing or posting is
`post`. Deleting a file, a mail or a record is `delete`. The owner's policy is the browser's
(`5dive browser approvals policy`). The default, **standard**, stops `pay`. **careful** stops
all four.

A stopped step exits **73** and **nothing runs**: no step of that act reaches the PC. Ask the
owner in plain words what you are about to do, in which app, and to whom. On a yes, they do that
step themselves on their PC. With no chat to the owner, put it on your row as ONE ask:
`5dive task need <row> --type=approval --ask="…"`. **Never leave out `kind`, and never rename
a step to get past a stop.** A Send button is a send whatever you call it.

## When it stops

- **69, no computer connected**: the PC is off, the app is closed, or the owner has not turned on
  "Let my agent use this computer". Tell the owner that in one line. Do not retry in a loop.
- **75, the owner pressed Stop**: the job was interrupted and may have run in part. **Do not retry
  on your own.** Tell the owner where you stopped and ask before you go on.
- **124, timed out**: the PC did not answer in time (default 60 s, `--timeout=<s>`). Snapshot
  first to see what happened before you act again.
- **1, a step failed on the PC**: the act prints each step's result and agent-desktop's error.
  Read it, snapshot again, then act.

## What the owner sees

`5dive desktop log` is the owner's record: which agent, which app, which controls, and the
outcome. It never holds what was on the screen, and typed text only as its length. Keep it that
way in your own reports: say what you did, never paste the screen's contents unless the job
asks for them.
