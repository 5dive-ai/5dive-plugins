# phone

Your agent uses apps on a spare Android phone: TikTok, Instagram, your own app's test build,
anything a person would tap through by hand.

```
5dive phone snapshot --interactive     # the screen as controls: [e3] button "Send"  ⚠ send
5dive phone act --steps='[{"op":"type","ref":"e5","text":"On my way"},{"op":"tap","ref":"button/Send"}]'
5dive phone screenshot
5dive phone act --steps='[…]' --record=morning-post   # keep those steps as a routine
5dive phone replay morning-post                       # run it again, no model
```

## How it reaches the phone

adb, Android's own debugging bridge, over the phone's Tailscale address. The screen is read
with uiautomator and taps and typing go through `input`; both ship inside Android. Nothing of
ours is installed on the phone; Tailscale is the only app it needs.

Text in any language, emoji and line breaks are pasted: `lib/type.dex` (4 KB, our own code,
source in `android/`) is copied to the phone's temp folder for that one step, puts the text on
the clipboard, a Paste key types it, then the clipboard is emptied and the file deleted. It is
not an app: no icon, no permission prompt, nothing left behind. Plain English text still goes
through `input` and copies nothing.

Setup, once: `sudo 5dive phone setup` installs adb on the server, then the owner asks their agent
to "connect my phone" and follows `5dive phone guide` (Developer options, Tailscale, Wireless
debugging, one pairing code). After connecting, the plugin moves the phone to adb's fixed port
5555, so a dropped connection comes back without the owner.

**A restart turns Wireless debugging off.** The owner switches it back on, and the agent's next
command finds the new port by itself (it tries the phone's ports, then pins 5555 again), so
nobody reads a port off the screen. Until then every command exits 69 with the words to send
the owner. Reconnecting needs no new code, provided "Disable adb authorization timeout" is on
(the guide says so).

## The owner's rules

The same policy file as `5dive browser` (`sudo 5dive browser approvals policy set careful`, or
`sudo 5dive phone approvals policy set careful`). A tap on Send, Post, Pay/Buy or Delete
(read off the control's own label or id, in English, Russian, German, Spanish and French) and
any step the agent labels with `"kind"`:

- standard (default): paying stops; sending, posting and deleting run and are logged;
- careful: all four stop; yolo: none do.

A stop exits 73 before any step runs, writes the ask where browser asks live, and hands it to
`5dive owner-ask`, so the owner gets the same Approve button in Telegram as for a browser ask.
`sudo 5dive browser approve <id>` grants it; the grant fits only those exact steps on that
phone, for 30 minutes, once.

## Routines: shown once, repeated with no model

`act --record=<name>` keeps the steps that run as a routine in `~/.5dive/phone/routines/<name>.json`
(0600):

- each control **by name** (`button/Share`), not by its snapshot number, so a renumbered screen
  still finds it; when two controls share a name, the point plus the words that must be there;
- the app each step ran on, which is the checkpoint (steps before the first `open` keep none: they
  only lead to the start);
- **never the text typed into a sign-in box** (a password, PIN or code box, or any box on a screen
  with a password box). Those steps are marked `secret` and `replay --values='["…"]'` gives the
  text at each run. It is not logged either.

**The save asks the owner**, the same way a stop does: an ask in the browser's format, the owner's
Approve button, or `sudo 5dive browser approve <id>`. The grant is bound to the hash of the name and
the exact steps, and is kept (one yes approves the routine, not one run). Re-recording the name, or
editing the file by hand, changes the hash: it does not run until the owner says yes again.
Within an approved routine its own Send, Post, Pay or Delete steps run under that yes, even under
careful. The owner saw each one, kind included, in the ask.

`replay <name>` runs the steps in one call. There is no model in it: it is this script, adb and
python3, so cron can run it (`0 8 * * * 5dive phone replay morning-post --wake-on-stop`).
Before every step it checks:

1. the phone shows the app the step was recorded on;
2. the control it taps or types into is on the screen, by name (or the words at that point);
3. a tap would not now pay, post, send or delete when the recorded step did not.

A failed check **stops** the replay (exit 65): nothing after that step runs, and it prints the
step, what was wrong, a screenshot and one line to send the owner. `--wake-on-stop` also wakes the
seat's agent with that line, for a run nobody is watching. v1 never repairs a routine on its own:
a scheduled run that changes itself is a run nobody approved. `routine ls` shows each routine's
state (approved, waiting, changed, declined) and its last run; `routine show`, `routine forget`.

Every step goes to the seat's `~/.5dive/phone/actions.jsonl` (0600). Screenshots stay in
`~/.5dive/phone/shots` (0700).

Websites go through the agent's own browser, `5dive browser` on the server: the phone is for
apps. (Chrome on the phone also drops its page tree between screen reads.)

## Limits

- After a restart the owner turns Wireless debugging back on (Android switches it off on every
  restart). The port is found without them.
- A locked phone cannot be driven: set the spare phone's screen lock to None or Swipe. Opening
  a PIN lock would mean handing the agent the phone's PIN; a spare phone does not need one.
- iPhone is not supported (it needs a Mac with Xcode).
