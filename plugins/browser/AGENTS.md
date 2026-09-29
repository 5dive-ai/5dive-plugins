<!-- 5dive:browser:begin -->
# Browser — logging a human into a site, and using the session afterwards

*(This section is installed by the 5dive `browser` plugin. It is the same workflow the
Claude skill `connect-site` carries, written for any harness — codex, grok, pi, opencode,
qwen, agy — because a plugin is a capability, not a channel. Reprint or re-install it with
`5dive browser doc` / `5dive browser doc --append=<file>`.)*

You cannot log a person in. You put a real browser on the box, mint a one-time link to it,
hand that link to the human on whatever channel you are paired to, and wait. Their login
lands in a profile that outlives the viewer, and your later `run` calls reuse it.

## THE RULE THAT COSTS THE MOST WHEN BROKEN

**The viewer link belongs to the human and is spent by the first successful GET.** Never
open it, curl it, fetch it, preview it or "check that it works" — verifying a one-time
ticket destroys it, and the human then gets a dead page. To find out what happened to a
link you handed over, read the box journal instead:

    sudo journalctl -u shelld -n 200 --no-pager \
      | grep -E 'viewer_bind|viewer_redeemed|viewer_denied|viewer_ws_connected'

`viewer_bind` = minted (that was you). `viewer_redeemed` + `viewer_ws_connected` = the human
is in. `viewer_denied` carries a `reason` and that reason is the diagnosis. Nothing at all =
they have not clicked yet. The only other safe probe is a deliberately WRONG nonce: a
refusal spends nothing.

**A chat preview is a visit.** Hand the viewer URL over only as non-unfurling code, with
"Copy-paste this one-time link into your browser. Do not paste it back into chat." Telegram
agents use the reply tool's MarkdownV2 code span; the Telegram transport enforces the same
rule. Other chat adapters must use their equivalent code formatting. A web dashboard may
offer copy-only text or a copy button, but must not prefetch the URL.

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
   or `CHALLENGE` still needs a person. `UNKNOWN (no adapter …)` means step 1 is incomplete.
   When reflex is configured, the box drafts that login check itself (DIVE-4997). Once the line
   says a check is waiting, tell the owner to approve it: `sudo 5dive browser adapters pending`,
   then `adapters approve <site>`. Never approve one yourself; an agent seat's sudo is refused.
   Another `UNKNOWN` names a browser/box read failure and is not permission to act. Only after
   `authenticated` may an agent use `run`, `snapshot`, `shot`, `read`, or `links` for that site.

The view is ephemeral; the login profile is durable. Revoke promptly: a live viewer is a
keyboard attached to the person's account.
<!-- 5dive:connect-site-flow:end -->

## You can use the browser with NOTHING connected

Give any page verb a URL instead of a site and it picks the profile itself: the host's one
connected login, or the **public profile** (nothing logged in) when there is none. So on a
fresh box `5dive browser snapshot https://example.com/ --interactive` just works. Connecting a
site is only for pages where it must be the owner — their inbox, their cart, their repo.

If the owner has two accounts on one site (`github.com_work`, `github.com_personal`), a URL
alone is refused and the refusal names both. **Ask the owner which one, never guess**, then
name it: `5dive browser act github.com_work <url> --steps=…`.

## Acting: `act`, on refs, and the four things you must ask about first

```bash
5dive browser snapshot <url> --interactive          # read the refs
5dive browser act <url> --steps='[{"op":"click","selector":"ref=button/Star"}]'
5dive browser act <url> --steps='[{"op":"fill","selector":"ref=textbox/Title","value":"Bug: …"},
                                  {"op":"click","selector":"ref=button/Save draft"}]' --expect='Draft saved'
```

Steps are `goto fill type click wait_for select press`, run in order, in one tab. Use `type`
for search boxes and autocompletes that react to keystrokes, and `fill` for plain inputs: `fill`
sets the value in one event with no key presses, so a suggestion list that opens on typing never
opens. `type` clears the field and types the value key by key, `delay_ms` apart (default 50, at
most 1000). A line break in its value is refused — typed, it is the Enter key; press Enter as its
own step:

```bash
5dive browser act <url> --steps='[{"op":"type","selector":"ref=textbox/Where to?","value":"Lisbon"},
                                  {"op":"wait_for","selector":"text=Lisbon, Portugal"},
                                  {"op":"click","selector":"text=Lisbon, Portugal"}]'
```

Without a URL, `act` continues on the page a served browser is holding. `--expect=<regex>` is
graded against the page as the steps left it, re-read for up to 5 s (`--expect-wait=<ms>`) so a
toast that lands after the click counts, and it matches the text on screen as well as the
document. Without it the command only says the steps ran — look at the `page.png` it writes
before you tell anyone it worked. `act` also writes `tree.json` and `page.md` of the page it
left, so you do not need a second `snapshot` to read the refs there.

**A step that fails fails the run, whatever --expect matched** — the page before your steps may
already carry the text. The failure names the step: `act: step 2 (click ref=button/Decline)
failed: ref=button/Decline matches nothing on this page — the run is NOT verified, whatever
--expect matched.` and `--json` carries it as `failed_step: {index, op, selector, error}`.
Steps before it may have run; look at `page.png` before you retry.

**A redirect is said.** After every goto, `act` and `run` compare where the page landed with the
URL you gave; a changed path, or most of your query dropped, prints
`redirected: <asked> → <landed> (<why>)`. If nothing but a goto had run, the cold browser stops
there and your whole step list runs once in the served browser — the line ends
`; retrying once in the served browser`, and that run's result is the one you get. After a click
or a fill it is never replayed: read `page.png` and decide. `log in first: 5dive browser auth
<site>` means reflex read the page as a login wall — ask the owner to connect the site.

**Paying, posting, sending and deleting follow the owner's policy.** The default is standard
(DIVE-5148): posting, sending and deleting run — `act` says `ALLOWED (default standard)` and logs
each one, with what it sent and a screenshot, for the owner — while **paying stops for the owner's
approval**. Under the owner's `careful`
(`sudo 5dive browser approvals policy set careful`, theirs to set, never yours), `act` stops in
front of any of the four (read off the live page, whatever selector you used; Ctrl/Cmd+Enter
counts as send, and so does a plain Enter in a composer with no form around it, which is how a chat
box sends) and exits **73** with the ask and a screenshot. Relay the ask to the owner with the screenshot. Only on their explicit yes is it approved (`sudo 5dive browser approve <id>`, which
the owner or their dashboard runs); then re-run the SAME act with `--approved=<id>`. A yes
covers exactly those steps, once, for 30 minutes. Do not rephrase the steps to get around the
stop — a button renamed is still an order placed.

## Sending a Gmail message: `run google.com send`

```bash
5dive browser run google.com send --to=<addr> --subject='<subject>' --body='<text>'
```

One command. It opens compose with To and Subject filled, types the body, and sends (the default,
standard: `send` is allowed, and logged). Under `careful` it stops in front of Send with exit **73** and an ask, as `act`
does. Relay it: the owner's `approve` shows the `--to`,
`--subject` and `--body` they are saying yes to. On their yes, re-run the SAME command with the
SAME arguments plus `--approved-id=<id>` — a different subject is a different ask. It then sends
and reads the Sent folder back in the same login (`verify.in_session`); only
`verified: send is live at …#sent` means it went. **NOT VERIFIED means open Sent and look before
anything else — never send it again blind.** Exit 75 before anything ran means the google.com
login check did not read `authenticated` (logged out, it reads the Google sign-in page): tell the
owner, and connect the site with them by the shipped flow above.

The ask shows what the step will act on (recipients, subject and first line of a mail; payee and
amount; the post's text; the item deleted). Relay THAT to the owner, not the button's name. If
it says the page showed none of it, say so and send the screenshot. **Never approve an ask
yourself:** `sudo 5dive browser approve` from your seat is refused, and trying to get around that
is exactly what it exists to stop. `5dive browser approvals policy` shows the owner's standing
answer per kind and its `mode` (`standard`, `yolo`, `careful` or `custom`). A kind set to `allow`
(publish, send and delete under `standard`, the default; all four under `yolo`) runs without
stopping, and it is still logged for them to read.

## Working the page: ONE snapshot per decision

```bash
5dive browser snapshot <site> <url>        # refs + text + PNG, one browser cycle
5dive browser run <site> <action> --key=value   # then act, quoting a ref as the selector
```

**Reach for `snapshot` first, not for three commands.** `tree`, `read` and `shot` each open
their own browser and load the page again, so taking all three — which is what deciding
actually needs — costs three cycles and three loads. `snapshot` is one cycle: `tree.json`
(the refs you quote into `run`), `page.md` (what the page says), `page.html` and a
`page.png` of the same tab, all in one artifact directory.

They are also **one page instant**, which the three separate commands are not: a ref printed
by `tree` can be gone from the DOM `read` captured seconds later, and nothing in the two
files says so. Use `tree`, `read` or `shot` when one field really is all you want.

**Never guess a selector.** A ref is `ref=<role>/<accessible name>[#n]` and is re-derived from
the page every time, so it survives a reload — an obfuscated class name does not.

**A ref that is not there yet is not a missing ref.** `tree`, `snapshot` and `run` wait 1200 ms
after load before looking (`--settle=<ms>`, and `--page-settle=<ms>` on `run`, whose other
`--key=value` arguments belong to the adapter). If a ref shows up at a higher settle and not at the
default, the page is slow, not wrong — measured on a GitHub issue page: 54 nodes at the default, 76
at `--settle=6000`. Raise the settle to orient; for an element that is genuinely late put a
`wait_for` step in the adapter, which now polls for the whole step timeout on a `ref=` selector just
as it always did on a CSS one. The settle is paid on every run; a `wait_for` costs only what the
page takes.

**A ref that matches nothing is retried once, on the element reflex picks at confidence 0.9 or
more.** With reflex configured on the box, `act` and `run` hand the page's interactive refs and
what the step is for to `5dive reflex pick-ref`, and retry that one step on its pick. Without
reflex, or when it errors, the retry goes to the ONE element of the same role whose name matches
yours ignoring case, contains it, or is contained in it; two such elements, and there is no retry.
Say what a step is for in an optional `"intent"` field
(`{"op":"click","selector":"ref=button/Decline","intent":"reject the cookie banner"}`); without
it the intent is the ref's role and name. The output says what happened:
`step 2: ref=button/Decline matched nothing; reflex picked ref=button/Decline all (conf 0.99); retried: ok`.
A step that pays, posts, sends or deletes is never retargeted: it fails as before and the failure
names the suggestion — if it is right, send the step again with that ref, and the owner's policy
reads it as usual. One retry per step, and only for a `ref=`: a CSS selector still times out.

**A web app answers with a loading screen first. Wait for the real page.** `snapshot`, `read`
and `act` take `--wait-for=<target>` — a CSS selector, `ref=<role>/<name>`, or `text=<words>` —
and capture once the page shows it:

```bash
5dive browser snapshot https://mail.google.com/mail/u/0/#inbox --interactive --wait-for='[role=main]'
```

**Exit 76 means the capture is NOT the page:** a known loading screen (Gmail's splash is one;
the output says `LOADING SCREEN`), or a `--wait-for` that never appeared. `page.meta.json` and
`page.md` say `partial: true`. Do not read refs or text out of it and do not report it as the
page; run it again with a `--wait-for` the loaded page has. 76 is not 75: the login is fine,
so do not ask anyone to log in, and do not re-run an `act`'s steps — they already ran.
Only *not honoured* (a served browser running an old daemon) asks for a restart
(`serve <site> --stop`, then `serve <site>`). `did not appear within <ms>` is a timeout, and *was
not answered* is a capture with no verdict on `--wait-for`; restarting changes neither.
`read` stops at 30 s of real time on a page that never goes quiet and marks what it got
`partial: true`.

## What will actually go wrong

- **No server-mode stack on the box.** chromium / Xvfb / x11vnc / websockify are installed
  box-level as root; a seat cannot install them. The refusal names what is missing and the
  DEGRADED health row names the re-install command. Report it; do not improvise an install.
- **A site login is per BOX, and you reach it through a broker.** The profile itself is still
  one seat's, mode 0700, and never repaired — you cannot open it and must not try. What you
  get instead is a conversation with the browser that is already holding it: if the box has a
  login for the site and something is serving it, `status`, `tree`, `run`, `shot` and `read`
  all just work from your seat, with **no second human login**. Your own login for a site, if
  you made one, wins over the box's. If nothing is serving it the refusal says exactly that
  and names the seat to start it — that is not "log in again".
- **Every brokered request is attributed to YOU.** The daemon reads the calling seat from the
  kernel, so the lease and the audit row say `holder=claude on_behalf_of=<your seat>`. You
  cannot set that field and should not try to.
- **Some sites block datacenter IPs at login.** "Request blocked by network security" is the
  site's policy meeting a VM's IP, not our bug. Tell the human: some sites block server IPs;
  `5dive browser proxy set <url>` sends this box's browser through your own proxy. Use only a
  proxy URL they give you. Box logins follow the `claude` seat's setting. Switching the proxy
  mid-session can end a site's login (the site sees a new IP).
- **A challenge is classified before a logged-out state**, because a challenge page still
  carries the login form's markup. Trust the label instead of re-reading the HTML.
- **Sessions die on the site's schedule.** A scheduled check skips a served profile and probes
  only after the browser stops; probing the held profile returns `UNKNOWN`.

## Stuck on a captcha: ask the owner to clear it, then carry on (DIVE-5200)

A CAPTCHA, a "verify you are human" or a "Just a moment…" check is a hard stop. You never
solve it and never look for a way round it. But you do not give up the task either: ask the
person, wait, and finish the job yourself.

```bash
5dive browser connect-request <site> --challenge --url=<the page you were stopped on> \
  --reason="<one line: what you were doing>"
```

`<site>` is the host (`futuretools.io`), even if you were browsing with nothing connected.
A page verb that hits a check prints this exact command for you. Your paired owner gets
"I'm stuck on a captcha on <site>" with an **Open <site>** button; their tap opens the box
browser on that page and sends them a one-time link as code, from root, never through you.
They clear the check and tap **Done**. Done closes their view and **hands the same browser
back to you, on that page**, so the check stays cleared for you.

After the `[browser challenge] … tapped Done` message, carry on **without asking again**:

1. First check what already happened. If the step you were on may have gone through,
   read the result (the listing, the sent folder, the confirmation page) before you redo it.
   Nothing is sent twice.
2. Re-read the page you were stopped on (`5dive browser snapshot <url>`). It goes through
   the browser profile the owner just used.
3. Clear: continue from that step. Still a check: say so once and stop.

Do not poll while you wait. Do not open the link. A flat block with nothing to click
("access denied", a 403 from a server IP) is not a check a person can clear; see
"Blocked from a server IP".

## The line this capability does not cross

Persistent **human-authenticated** sessions: a person logs in by hand, once, and the agent
is granted permission to operate the session — never the credentials.
**This is not anti-bot bypassing.** A CAPTCHA, a 2FA prompt or an "unusual activity"
interstitial is a hard stop that asks for a person: surface it, never attempt it. Ask them with `connect-request <site> --challenge`, then carry on after their Done. Never ask
for a password, never accept one, never export cookies out of a profile.
<!-- 5dive:browser:end -->
