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
with uiautomator and taps and typing go through `input`; both ship inside Android. Nothing is
installed on the phone and nothing comes from Google Play.

Setup, once: `sudo 5dive phone setup` installs adb on the server, then the owner asks their agent
to "connect my phone" and follows `5dive phone guide` (Developer options, Tailscale, Wireless
debugging, one pairing code). After connecting, the plugin moves the phone to adb's fixed port
5555, so a dropped connection comes back without the owner.

**A restart resets it.** The fixed port and Wireless debugging are both off after the phone
reboots. Every command then exits 69 and gives the agent the words to send the owner: turn
Wireless debugging on and tell me the new port. Reconnecting needs no new code, provided
"Disable adb authorization timeout" is on (the guide says so).

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

## Limits in 0.1

- Typing is ASCII only (adb's `input text`); Cyrillic, emoji and accents need an on-phone
  keyboard app, not in this version.
- A browser page on the phone reads unreliably (Chrome drops its page tree between reads): use
  `5dive browser` on the server for websites.
- A locked phone cannot be driven: set the spare phone's screen lock to None or Swipe.
- iPhone is not supported (it needs a Mac with Xcode).
