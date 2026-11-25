# phone

Your agent uses apps on a spare Android phone: WhatsApp Business, Instagram, a bank app,
anything that exists only on a phone.

```
5dive phone snapshot --interactive     # the screen as controls: [e3] button "Send"  ⚠ send
5dive phone act --steps='[{"op":"type","ref":"e5","text":"On my way"},{"op":"tap","ref":"button/Send"}]'
5dive phone screenshot
```

## How it reaches the phone

adb, Android's own debugging bridge, over the phone's Tailscale address. The screen is read
with uiautomator and taps and typing go through `input`; both ship inside Android. No app is
installed on the phone and nothing comes from Google Play.

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
