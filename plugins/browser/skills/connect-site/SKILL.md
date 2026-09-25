---
name: connect-site
description: Get a human logged into a site on the box, then use that logged-in session. Use when you need a site the agent has no session for — "log in to X", "connect my X account", "the agent needs a logged-in X", "open a browser on the box", "X says I'm signed out" — or when `5dive browser status` is not `authenticated`. Not for browsing or acting on a public page — the browser does that with nothing connected (the use-browser skill) — and not for anything a site's API already does.
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

## When YOU need the owner logged in: ask with a button (DIVE-4992)

Do not walk the owner through the dashboard, and never hand them a link you made
yourself. Ask from your own seat:

```bash
5dive browser connect-request <site> --reason="<one line: why you need it>"
```

Your paired owner gets a Telegram message with a **Connect <site>** button. Nothing is
bound until they tap it. Their tap opens the browser on the box and sends them the
one-time link as code, from root, not from you: you never see it, so you cannot spend it.
They log in, then tap **Done**. Done revokes the view, stops the browser and probes, in
that order. You get a channel message at each step, `[browser connect] …`. After the
Done message, `5dive browser status <site>` has the verdict. Do not poll while you wait.

If `connect-request` refuses because the seat has no paired owner, its Telegram bridge
cannot relay the tap, or it has no grant, fall back to the owner's own path, the shipped
flow below.

<!-- 5dive:connect-site-flow:begin -->
## The shipped flow

The supported customer handoff starts from **Connected sites in the 5dive dashboard**. Do
not substitute the raw `viewer` command: it mints only one half of the relay credential.

1. **Make the site classifiable before login.** `status` can say `authenticated` only when
   an adapter supplies `probe.url` and `probe.logged_out_when_dom_matches`. **If the site is a
   single-page app** — one static shell for both login states, decided in JavaScript — that pair
   is not enough and the adapter must also name `probe.logged_in_when_dom_matches`: the probe then
   waits for one marker or the other instead of classifying a page that has not decided yet, and
   a page showing neither is `UNKNOWN` rather than a guessed login (DIVE-4794). Browser commands
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
3. **Hand over the dashboard's absolute URL unopened, as non-unfurling code.** A chat
   previewer spends the link before the human ever sees it, so it must never be emitted as a
   detected bare URL. On Telegram, call `reply` with `format: 'markdownv2'` and put the link
   inside a MarkdownV2 code span; on any other chat surface, use its
   non-unfurling code formatting. The Telegram plugins enforce it at their Bot API boundary.
   Say:
   "Copy-paste this one-time link into your browser. Do not paste it back into chat." The URL
   must begin with `https://<box-host>/browser/viewer/…`. Never open, curl, fetch, preview,
   or log it — the ticket is spent by the first successful GET and expires quickly. Do not put
   it in a task body, a PR, a commit message, a log line or a wiki page: it is a live
   credential for as long as it is unspent.
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
   `authenticated` may an agent use `run`, `snapshot`, `shot`, `read`, or `links` for that site.

The view is ephemeral; the login profile is durable. Revoke promptly: a live viewer is a
keyboard attached to the person's account.
<!-- 5dive:connect-site-flow:end -->

## What will actually go wrong

- **`serve` fails closed on a box without the stack.** Server mode needs chromium, Xvfb,
  x11vnc and websockify, installed box-level as root (`browser-stack.sh`) — a seat cannot
  install them. The refusal names what is missing, and the box's DEGRADED health row names
  the re-install command. Report that to the human; do not improvise an install.
- **A site login is per BOX and brokered.** The profile stays one seat's, mode 0700, and is
  never repaired — you cannot open another seat's and must not try. But you do not need to:
  where the box has a login and something is serving it, your seat acts through the running
  browser and needs **no second human login**. A login you made yourself wins over the box's.
  The viewer stays the owning seat's act; the relay still redeems `claude`.
- **If nothing is serving the box's login, START IT YOURSELF — do not hand a human a shell
  command** (DIVE-4813). `sudo 5dive browser serve <site>`, from your own seat. Root re-execs
  that as the seat that owns the session, so it does **not** need `sudo -u` — which is the
  point, because `sudo -u <someone>` is a runas no 5dive agent grant contains, and printing it
  for a person to run is the failure this rule exists to stop. Then act normally: `snapshot`,
  `read`, `shot` all go through the running browser. If that `sudo` is itself refused, your
  seat is not admin tier — say so plainly and name the site; do not improvise around it.
- **`serve --stop` is still the owning seat's act**, and so is `lease --release`: they tear down
  a browser other seats and a human viewer may be using, which is not yours to do on their
  behalf. Stop only what your own seat serves.
- **Some sites block datacenter IPs at login** ("your request has been blocked",
  "suspicious network", "Request blocked by network security"). That is the site's policy
  meeting a VM's IP, not our bug. Tell the human: some sites block server IPs;
  `5dive browser proxy set <url>` sends this box's browser through your own proxy. The proxy is
  theirs — use only a URL they give you, never pick a provider. Logins connected for the whole
  box follow the `claude` seat's setting, so set it there. Switching the proxy mid-session can
  end a site's login (the site sees a new IP), so set it before connecting, not after.
- **A challenge is classified BEFORE a logged-out state**, because a challenge page still
  carries the login markup. Trust the label; do not re-derive it from the HTML.
- **Sessions die on the site's schedule, not ours.** A scheduled check must skip a profile
  while it is served, then probe it once the browser is stopped; otherwise the profile lock
  produces `UNKNOWN` instead of a liveness verdict.
- **Setup installs that schedule.** `sudo 5dive browser setup` enables a per-seat systemd timer
  which runs `5dive browser probe-all` about every six hours. The sweep prints `skipped: served`
  and leaves the existing liveness stamp untouched for a profile whose browser is open; close the
  view/browser before asking for an immediate check.
- **Hand-written adapters live outside the installed plugin.** An upgrade replaces the plugin
  directory, so a custom `<site>.json` belongs in the relay seat's store named in step 1, never
  in the dispatched package's `adapters/`.

## The line this capability does not cross

This is **persistent human-authenticated sessions** — a person logs in, once, by hand, and
the agent is granted permission to operate the session, never the credentials. It is not
anti-bot bypassing. A CAPTCHA, a 2FA prompt or an "unusual activity" interstitial is a
**hard stop that asks for a person**: surface it, do not attempt it, do not look for a way
around it. Never ask the human for a password, never accept one, never write one down, and
never export cookies out of a profile.

## When a page looks broken or half-loaded

The agent profile filters ads and cookie walls (uBlock Origin Lite, installed by
Chrome policy and pinned — it is the only extension allowed, and nothing else can
be added). A small number of sites break under that filtering: the page renders
empty, a player never starts, a login form does not submit.

Turn it off for that one site and re-render:

```
sudo 5dive browser adblock off example.com
5dive browser shot example.com https://example.com/...
```

`sudo 5dive browser adblock on example.com` puts it back. `5dive browser adblock
status` says which sites are currently unfiltered. It is off for the whole host
(both `example.com` and its subdomains) — there is no partial setting — and a
browser already running under `serve` may need `serve example.com --stop` before it
picks the change up.
