---
name: connect-site
description: Get a human logged into a site on the box, then use that logged-in session. Use when you need a site the agent has no session for — "log in to X", "connect my X account", "the agent needs a logged-in X", "open a browser on the box", "X says I'm signed out" — or when `5dive browser status` is not `authenticated`. Not for fetching a public page (use a normal fetch) and not for anything a site's API already does.
---

# connect-site — serve, hand over the link, poll to authed

You cannot log a person in. What you CAN do is put a real browser on the box, mint a
one-time link to it, hand that link to the human over whatever channel you are paired to,
and wait. The login they perform lands in a profile that **outlives the viewer** and that
your later `run` calls reuse.

The commands are easy. The orchestration is where seats get it wrong, and every mistake
here is **silent** — nothing errors, the human just never gets in.

## THE RULE THAT COSTS THE MOST WHEN BROKEN

**The viewer link is the HUMAN'S, and it is spent by the first successful GET.** Do not
open it, do not curl it, do not "just check that it works", do not paste it into a fetch
tool, do not preview it. A one-time ticket verified by you is a ticket denied to them —
they get a dead page and you get a bug report about the wrong thing. (This is not
hypothetical: a lead seat did exactly this on 2026-09-13 while debugging.)

**To check a link you already handed over, read the box journal, never the link:**

```bash
sudo journalctl -u shelld -n 200 --no-pager \
  | grep -E 'viewer_bind|viewer_redeemed|viewer_denied|viewer_ws_connected'
```

- `viewer_bind` — the link was minted (yours).
- `viewer_redeemed` + `viewer_ws_connected` — the human is in. Stop worrying.
- `viewer_denied` with a `reason` — that reason is your whole diagnosis (`no live bind`,
  `redeem refused`, malformed, wrong session).
- nothing at all — they have not clicked yet. Wait, or re-mint after the TTL.

The other safe probe is a **deliberately bad nonce**: a refusal is a pure refusal and
spends nothing. A good nonce is the customer's only redemption.

## The flow

```bash
5dive browser serve <site>                                 # 1. persistent Chrome on its own Xvfb
5dive browser viewer <site> --bind=<session> [--ttl=600]   # 2. mint ONE-TIME link (prints it once)
#                                                            3. HAND THE LINK TO THE HUMAN, unopened
5dive browser status <site>                                # 4. poll until `authenticated`
5dive browser viewer-revoke <site>                         # 5. close the view; the login survives
```

1. **`serve`** starts the browser and its display. It is idempotent per site.
2. **`viewer`** prints the link exactly once — it stores only a SHA-256 of the nonce, so a
   link you lose is gone and you re-mint. `--bind=<session>` is **mandatory** (an unbound
   ticket would be a bearer credential for a live account); `--bind=local` is the named
   escape for a hand-run on the box. Default TTL is short on purpose — mint it *when the
   human is actually there*, not an hour ahead.
3. **Hand it over on the channel you are already on**, with the two facts that change their
   behaviour: it is **one-time** and it **expires**. A chat previewer spends the link before
   the human sees it, so it must never be emitted as a detected bare URL. On Telegram, call
   `reply` with `format: 'markdownv2'`, put the link inside a MarkdownV2 code span, and say:
   "Copy-paste this one-time link into your browser. Do not paste it back into chat." The
   Telegram plugins also enforce that rule at their Bot API boundary. On any other chat
   surface, use its non-unfurling code formatting and the same copy-paste warning. A browser
   dashboard may expose copy-only text or a copy button; it must not fetch the URL itself.
   Do not put the link in a task body, a PR, a commit, a log line or a wiki page: it is a live
   credential for as long as it is unspent.
4. **`status <site>`** is the only honest confirmation. Poll it every ~15–30s while they are
   logging in (not tighter — each probe is a real page load). Terminal states:
   - `authenticated` — done. The profile is now reusable by `5dive browser run`.
   - `session expired` / `CHALLENGE` — a person is still needed; say what the page asks for.
   - `UNKNOWN` — the probe could not read the page at all. This is **not** a failure to
     report and **not** permission to act: `status` stays quiet and exits 0, and `run`
     refuses on it. Re-probe; if it stays UNKNOWN, the browser or the box stack is the
     problem, not the login.
5. **`viewer-revoke`** ends the view as soon as they are in. The login is the durable half;
   the view onto it is the ephemeral half and it is a keyboard attached to their account.
   Leaving it open is the only part of this flow that gets *worse* with time.

Then, and only then, the profile is usable:

- `5dive browser run <site> <action> [--key=value ...]` — act, deterministically, via an adapter.
- `5dive browser shot <site> <url> [--out=<png>] [--dom=<file>]` — **read**: render a page inside
  the logged-in profile and get a PNG of what the human would see, plus the DOM on request. This
  is how a grader sees a page that lives behind the login, and how you read a thread on a site
  that shows a logged-out visitor nothing.

  `shot` renders **only** when `status` says `authenticated`. Every other state — including
  `UNKNOWN` because the site has no adapter — writes no file. The reason is specific: a
  screenshot of the **sign-in page** is evidence-shaped, and the person you hand it to cannot
  tell it from the real page. The URL must belong to that site (a subdomain is fine). A served
  browser is stopped for the render and started again; a viewer with a **person inside it right
  now** is a refusal, because a screenshot does not get to end someone's login.

## What will actually go wrong

- **`serve` fails closed on a box without the stack.** Server mode needs chromium, Xvfb,
  x11vnc and websockify, installed box-level as root (`browser-stack.sh`) — a seat cannot
  install them. The refusal names what is missing, and the box's DEGRADED health row names
  the re-install command. Report that to the human; do not improvise an install.
- **Profiles are per-seat, mode 0700, and never repaired.** Another seat's login is not
  yours to use, and a profile with wrong ownership is refused rather than fixed. If you
  need the session, you serve it under YOUR seat and the human logs in again.
- **Some sites block datacenter IPs at login** ("your request has been blocked",
  "suspicious network"). That is the site's anti-bot policy meeting a VM's IP — it is not
  our bug, there is no flag for it, and the honest answer to the human is that this site
  cannot be logged into from the box. Say so and stop.
- **A challenge is classified BEFORE a logged-out state**, because a challenge page still
  carries the login markup. Trust the label; do not re-derive it from the HTML.
- **Sessions die on the site's schedule, not ours.** Run `status` on a schedule, not at
  publish time — otherwise you discover the logout mid-action.
- **Setup installs that schedule.** `sudo 5dive browser setup` enables a per-seat systemd timer
  which runs `5dive browser probe-all` about every six hours. The sweep prints `skipped: served`
  and leaves the existing liveness stamp untouched for a profile whose browser is open; close the
  view/browser before asking for an immediate check.
- **Back up hand-written adapters outside the installed plugin.** An upgrade can replace the
  plugin directory; unpublished adapter files there are not durable configuration.

## The line this capability does not cross

This is **persistent human-authenticated sessions** — a person logs in, once, by hand, and
the agent is granted permission to operate the session, never the credentials. It is not
anti-bot bypassing. A CAPTCHA, a 2FA prompt or an "unusual activity" interstitial is a
**hard stop that asks for a person**: surface it, do not attempt it, do not look for a way
around it. Never ask the human for a password, never accept one, never write one down, and
never export cookies out of a profile.
