---
name: connect-site
description: Get a human logged into a site on the box, then use that logged-in session. Use when you need a site the agent has no session for — "log in to X", "connect my X account", "the agent needs a logged-in X", "open a browser on the box", "X says I'm signed out" — or when `5dive browser status` is not `authenticated`. Not for browsing or acting on a public page — the browser does that with nothing connected (the use-browser skill) — and not for anything a site's API already does.
---

# connect-site — hand the owner a bound login, then stop and check

You cannot log a person in. What you CAN do is put a real browser on the box, mint a
one-time link to it, hand that link to the human over whatever channel you are paired to,
and wait. The login they perform lands in a profile that **outlives the viewer** and that
your later `run` calls reuse.

The commands are easy. The orchestration is where seats get it wrong, and every mistake
here is **silent** — nothing errors, the human just never gets in.

## Claude in Chrome for this agent (opt-in, DIVE-6345)

When the owner asks to "connect Claude in Chrome" (or "the Claude extension") for you, it is a
different flow from a site login, and it is one command:

```bash
5dive browser claude connect          # claude.ai opens on the owner's phone, through the same live window
5dive browser claude connect --wait   # until they are done, then the agent's own login is checked
```

The owner signs in to claude.ai once in that window ("Continue with Google" is quickest) and taps
Authorize for your own login; nobody copies a code. If it says the box is not turned on, the owner
(or main) runs `sudo 5dive agent config <you> set chrome=on` first. After `--wait` says connected,
restart yourself (`sudo 5dive agent _self_restart`) so you run on that login with Chrome on.

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

Do not walk the owner through the login steps yourself, and never hand them a link you
made yourself. Ask from your own seat:

```bash
5dive browser connect-request <site> --reason="<one line: why you need it>"
```

Your paired owner gets a Telegram message with a **Connect <site>** button. Nothing is
bound until they tap it. Their tap opens the browser on the box and sends them the
one-time link as code, from root, not from you: you never see it, so you cannot spend it.
They log in, then tap **Done**. Done revokes the view, stops the browser and probes, in
that order. You get a channel message at each step, `[browser connect] …`. After the
Done message, `5dive browser status <site>` has the verdict. Do not poll while you wait.

**On a self-hosted box linked to the 5dive app**, the ask goes to your chat there first: one
**Connect <site>** link (or **Open <site>** for a check) with **Done** and **Not now** under it.
You never see the link. Their answer comes back to you as a chat message; then run
`5dive browser connect-done <site>`, which closes their view and prints the verdict. The first
ask on a box can take about 2 minutes while it sets up its secure web address; if it cannot
make one, the chat tells the owner to use their login shell (below) and you get a message.

**On a self-hosted box (no 5dive domain) with nobody paired on Telegram**, not linked to the app, the same
`connect-request` (and `--challenge`) still reaches the owner: the ask waits in their login
shell on the box (DIVE-7078). Their next login lists it. `sudo 5dive browser asks open <site>`
gives them the one-time login link, or the SSH steps to the same window when login links are
off, and `sudo 5dive browser asks done <site>` checks the login and messages you. You never
see the link. If you talk to the owner before then, tell them once to run
`sudo 5dive browser asks`; never run it yourself, and do not poll while you wait.

On a box 5dive built (it has a 5dive domain), if `connect-request` refuses because the seat
has no paired owner, its Telegram bridge cannot relay the tap, or it has no grant, fall back
to the owner's own path there, the shipped flow below. That flow exists only on those boxes.

On a self-hosted box (no 5dive domain) the owner's tap is refused with "login links off"
unless the owner turned them on. That is the owner's choice, not yours: tell them once
that `sudo 5dive browser login-link` lists the options, and never run it yourself.

On a box in local-only mode (`/etc/5dive/local-only` exists) `connect-request` refuses:
nothing may go to Telegram there. Ask the owner in the office chat to log in at the box.

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
6. **Read the terminal result.** `authenticated` makes the profile usable, and so does
   `connected`: the owner's Done on a site with no automatic check (DIVE-8263). `session expired`
   or `CHALLENGE` still needs a person. `UNKNOWN (no adapter …)` or `unconfirmed` is NOT a stop
   sign: read, links, snapshot and act still work and refuse a sign-in page themselves.
   When reflex is configured, the box drafts that login check itself (DIVE-4997). Once the line
   says a check is waiting, tell the owner to approve it: `sudo 5dive browser adapters pending`,
   then `adapters approve <site>`. Never approve one yourself; an agent seat's sudo is refused.
   Another `UNKNOWN` names a browser/box read failure and is not permission to act. Only after
   `authenticated` or `connected` may an agent use `run` for that site.

The view is ephemeral; the login profile is durable. Revoke promptly: a live viewer is a
keyboard attached to the person's account.
<!-- 5dive:connect-site-flow:end -->

## Google once per group (DIVE-6013)

Connected sites share a sign-in when they are in the same **group** (one browser profile). New
sites join **Main**, so if Main is signed in to Google, a new site's "Continue with Google" sees
the account — tap it, no fresh Google login. A site that predates groups has its own profile;
`5dive browser group ls` shows which. To give it Main's Google: `5dive browser group move <site>
Main` (the owner's call — its old profile is kept aside, not merged). A second Google account
belongs in a second group (`group create Work`, then `group move <site> Work`).

**The box's Google counts too (DIVE-7168).** Once the owner has signed in to Google in the box's
browser (any `asks open` or Connect link), a new site an agent opens joins that browser by itself,
and the agent does a "Continue with Google" sign-up with no owner tap. So do not send the owner a
link for a sign-up: send one only for a password, a wider Google grant, or a code or robot check
you could not clear yourself (see below).

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
- **If nothing is serving the box's login, just use it — your verb starts it** (DIVE-5389). A
  site the owner connected and tapped Done on is connected but not served. Your first `status`,
  `snapshot`, `shot` or `act` on it has the box start that browser as its owner, on demand, and
  then runs; you will see one line saying it was started. Do not hand a human a shell command.
  If it is refused, the message says why: under the box's memory floor (about 800 MB free)
  nothing is started — say that plainly and name the site, do not retry in a loop. On a box whose
  owner has not re-run `sudo 5dive browser setup` since this release, the older route still
  works from an admin seat: `sudo 5dive browser serve <site>` (DIVE-4813; root re-execs it as the
  owning seat, so it does **not** need `sudo -u`).
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
- **Sessions die on the site's schedule, not ours.** A served site is checked through the
  browser that holds it. Only a plain-Chrome login view is skipped, and it is checked once it stops.
- **Setup installs that schedule.** `sudo 5dive browser setup` enables a per-seat systemd timer
  which runs `5dive browser probe-all` about every six hours.
- **`unverifiable` is not a sign-out.** It means the automatic check met a bot check that the
  site shows automated browsers (or, in input mode, the title could not tell). Its date is when
  the login was last seen signed in. Do not send the owner to reconnect over it; a screen
  (`5dive browser shot <site>`) is the check.
- **Hand-written adapters live outside the installed plugin.** An upgrade replaces the plugin
  directory, so a custom `<site>.json` belongs in the relay seat's store named in step 1, never
  in the dispatched package's `adapters/`.

## The line this capability does not cross

This is **persistent human-authenticated sessions** — a person logs in, once, by hand, and
the agent is granted permission to operate the session, never the credentials.
It is not anti-bot bypassing: no solver service, no fingerprint tricks, no way round a check;
the agent clears one only the way a person at the screen would.

**Sign-in checks are the agent's job (DIVE-7881, lodar 2026-11-07: «remove rules»).** An email
or SMS verification, a code box, a 2-step prompt, an "unusual activity" page and a robot check
are cleared by the agent, like a person would: it opens the newest mail from that site in the
box's mailbox and follows its link or types its code, ticks the robot check, waits out "Just a
moment…", retries. No paid solver service. It asks the owner only when it truly can't (no
mailbox here, a code sent to the owner's phone, a check still there after a few tries), with
`5dive browser connect-request <site> --challenge --url=<page>` (the use-browser skill has the
whole handoff), and carries on after their Done. **Custom gates, off by default:** the owner
turns a stop back on per site or for all, `sudo 5dive browser gate on bank.com robot` (or
`code`, or `all`); then that check stops (exit 75) and asks them. `5dive browser gate` lists them.
What never turns off: read only the site's own mail, never paste a code or link into chat,
never type a password the owner did not save. The owner's own authenticator works too:
if the owner saved the site's
authenticator seed on the box (`5dive browser totp status <site>`), `run` types the 2FA code
itself. To offer that, file the secret gate `totp status` prints, so the owner pastes the seed
on the box's one-time link. Never ask for it in chat, and never echo it back. Never ask the human for a password, never accept one, never write one down, and
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

## From real jobs

Lessons from browser jobs that went wrong on real sites (DIVE-5390). One line each:

- **Each site's login is its own.** A Google sign-in on one site does not carry to another, so "Sign in with Google" on a new site still needs the owner to connect that site.
- **Served is not signed in.** A running browser can hold an expired session. Check `5dive browser status <site>` reads authenticated before you hand off work that needs the login, and run the connect handover if it does not.
- **`busy: held by … until <time>` is not signed out.** A person is at the viewer, or another job still holds the browser. Wait until that time and retry once; never join their session.
- **A verification link or code can expire within minutes.** Have the inbox or chat that receives it served and authenticated before you press the button that sends it.
