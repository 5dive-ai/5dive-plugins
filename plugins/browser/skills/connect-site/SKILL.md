---
name: connect-site
description: Get a human logged into a site on the box, then use that logged-in session. Use when you need a site the agent has no session for — "log in to X", "connect my X account", "the agent needs a logged-in X", "open a browser on the box", "X says I'm signed out" — or when `5dive browser status` is not `authenticated`. Not for fetching a public page (use a normal fetch) and not for anything a site's API already does.
---

# connect-site — use the bound dashboard handoff, then stop and check

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

<!-- 5dive:connect-site-flow:begin -->
## The shipped flow

The supported customer handoff starts from **Connected sites in the 5dive dashboard**. Do
not substitute the raw `viewer` command: it mints only one half of the relay credential.

1. **Make the site classifiable before login.** `status` can say `authenticated` only when
   an adapter supplies `probe.url` and `probe.logged_out_when_dom_matches`. Browser commands
   redeemed by the shipped relay run as seat `claude`, not as the agent asking for the login.
   A custom adapter for that relay seat belongs at
   `/var/lib/5dive/browser-profiles/claude/.adapters/<site>.json`; shipped adapters are the
   fallback in the dispatched plugin's `adapters/` directory. The seat-local path supersedes
   the old instruction to edit the package directory, which `plugin upgrade` replaces.
2. **Use the dashboard's Connect action.** The control plane runs `serve` and `viewer` under
   the relay's `claude` seat, registers the opaque bind through the authenticated
   `/shell/browser-viewer-bind` endpoint, and prefixes the box's HTTPS host. `viewer` itself
   does **not** register that bind; the bind is mandatory. The command prints only a path such as
   `/browser/viewer/<site>/<nonce>`, not a usable absolute URL. An ordinary agent seat has
   neither the relay seat nor the connectord token, so it must not hand raw CLI output to a
   person: the click will be refused as `no live bind`.
3. **Hand over the dashboard's absolute URL unopened, as non-unfurling code.** Say: “Copy-paste
   this one-time link into your browser. Do not paste it back into chat.” It must begin with
   `https://<box-host>/browser/viewer/…`. Never open, curl, fetch, preview, or log it. The
   ticket is spent by the first successful GET and expires quickly.
4. **Wait for the person to finish the login in that viewer.** Diagnose progress from the
   shelld journal, never by visiting the link. `viewer_redeemed` plus `viewer_ws_connected`
   means the person is in; `viewer_denied` supplies the reason.
5. **End the view before checking the login.** The dashboard/control-plane completion action
   (or an authorised operator acting as the relay seat) must perform this order:

   ```bash
   5dive browser viewer-revoke <site>
   5dive browser serve <site> --stop
   5dive browser status <site>
   ```

   Never poll `status` while `serve` is still running. Chromium holds the profile lock, so a
   second probe returns `UNKNOWN (served on :N …)` and cannot confirm the login. Stopping the
   browser preserves the profile and the login.
6. **Read the terminal result.** `authenticated` makes the profile usable. `session expired`
   or `CHALLENGE` still needs a person. `UNKNOWN (no adapter …)` means step 1 is incomplete;
   another `UNKNOWN` names a browser/box read failure and is not permission to act. Only after
   `authenticated` may an agent use `run`, `shot`, `read`, or `links` for that site.

The view is ephemeral; the login profile is durable. Revoke promptly: a live viewer is a
keyboard attached to the person's account.
<!-- 5dive:connect-site-flow:end -->

## What will actually go wrong

- **`serve` fails closed on a box without the stack.** Server mode needs chromium, Xvfb,
  x11vnc and websockify, installed box-level as root (`browser-stack.sh`) — a seat cannot
  install them. The refusal names what is missing, and the box's DEGRADED health row names
  the re-install command. Report that to the human; do not improvise an install.
- **Profiles are per-seat, mode 0700, and never repaired.** Another seat's login is not
  yours to use, and a profile with wrong ownership is refused rather than fixed. The shipped
  relay currently redeems the `claude` seat, so a different seat must use the dashboard flow
  rather than minting a ticket against its own unreachable profile.
- **Some sites block datacenter IPs at login** ("your request has been blocked",
  "suspicious network"). That is the site's anti-bot policy meeting a VM's IP — it is not
  our bug, there is no flag for it, and the honest answer to the human is that this site
  cannot be logged into from the box. Say so and stop.
- **A challenge is classified BEFORE a logged-out state**, because a challenge page still
  carries the login markup. Trust the label; do not re-derive it from the HTML.
- **Sessions die on the site's schedule, not ours.** A scheduled check must skip a profile
  while it is served, then probe it once the browser is stopped; otherwise the profile lock
  produces `UNKNOWN` instead of a liveness verdict.

## The line this capability does not cross

This is **persistent human-authenticated sessions** — a person logs in, once, by hand, and
the agent is granted permission to operate the session, never the credentials. It is not
anti-bot bypassing. A CAPTCHA, a 2FA prompt or an "unusual activity" interstitial is a
**hard stop that asks for a person**: surface it, do not attempt it, do not look for a way
around it. Never ask the human for a password, never accept one, never write one down, and
never export cookies out of a profile.
