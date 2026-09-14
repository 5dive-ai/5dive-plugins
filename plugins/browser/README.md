# browser — persistent human-authenticated browser sessions

**What this is, in the words the decision landed on (lodar, 2026-09-07): persistent
human-authenticated browser sessions.** It is *not* anti-bot bypassing. A CAPTCHA, a 2FA prompt or
an "unusual activity" interstitial is a **hard stop that asks for a person** — the executor never
attempts to solve one. That is a decision, not a limitation, and the second framing invites legal
and reputational exposure the actual design avoids. Use the first one in docs, marketing and the
plugin description.

`5dive browser` is a **general capability, not a distribution product.** We do not curate a
platform list and we do not choose per-site API-vs-browser paths; the user does. Adapters are
therefore a **public surface**, and "how does a user add a site" is a core design question rather
than a detail.

```
5dive browser setup                 # once, as root: create the profile store
5dive browser auth <site>           # a browser opens; you log in yourself
5dive browser status                # per-site auth state; run this on a SCHEDULE
5dive browser ls                    # profiles, and when each was last seen alive
5dive browser run <site> <action> [--key=value ...]
```

## Server mode: the browser lives on the box, you reach it through a one-time link

On a managed 5dive VM there is no display and there never will be one. `auth` used to refuse
there, and the only route past that refusal was `ssh -X` + `apt install chromium` + a hand-written
JSON file — which is not a product a customer can use.

So the browser runs **on the box**, on a persistent Xvfb display owned by the seat, and a person
reaches it through a viewer that is handed out as a **one-time, expiring, session-bound** ticket:

```
5dive browser serve <site>                                   # persistent Chrome on its own Xvfb
5dive browser serve <site> --stop                            # stop the browser; the profile survives
5dive browser viewer <site> --bind=<session> [--ttl=600]     # mint a one-time link
5dive browser viewer-redeem <site> --nonce=- --session=<id>  # the relay's gate; consumes the link
5dive browser viewer-revoke <site>                           # kill the view, keep the login
```

A successful `viewer-redeem` prints the two things the relay needs, and prints them exactly once:

```
target=127.0.0.1:6080
password=<the VNC credential x11vnc was started with>
```

The password is emitted **here and nowhere else**. `x11vnc` runs with `-passwdfile` inside the
seat's `0700` profile directory — the one place the relay is deliberately unable to read — so a
target without the password is a port that prompts for a secret nobody has. It rides the redemption
because the redemption already has exactly the right lifetime: one use, one bound session, consumed
in the same breath. The `-timeout` `x11vnc` is started with **is the ticket's TTL**, not a constant:
a VNC server that gives up before its own link expires hands the customer a spent link and a dead
port.

Same length is not yet the same window, so both are measured from **one clock, stamped before
`x11vnc` starts**. `-timeout` is a length counted from launch; `expires_at` is an instant, and it
used to be stamped after the bridge-readiness wait — up to `VIEWER_BRIDGE_WAIT_S` later. On a slow
bridge that made the ticket outlive the viewer it names, and the last seconds of the advertised
window were the dead-port failure again, reached from the other end. The other available fix —
padding `-timeout` by the wait — was rejected on purpose: it leaves a VNC server accepting a client
after its own ticket has expired, which is a live credential with no authorization left behind it.
The ticket may advertise no more life than the server was given, never more.

`auth` on a display-less box starts server mode instead of dead-ending. A box that does not have
the server-mode packages still refuses — and names which ones it lacks, rather than half-starting.

### What protects the session while the viewer is open

A viewer onto a logged-in profile is not a screenshot; it is the credential with a keyboard
attached. Five properties, each of which fails closed:

1. **Nothing listens off-box.** `Xvfb -nolisten tcp`, `x11vnc -localhost -once`, the bridge on
   `127.0.0.1`. Redemption returns a loopback target; the customer arrives through the box's
   already-authenticated relay, never through a port we opened.
2. **The ticket is a nonce we do not keep.** 32 bytes of urandom, stored only as its SHA-256 — the
   same rule the human-gate nonces use, for the same reason. The raw value exists once, in the line
   printed to whoever asked.
3. **It is single-use, and the replay branch is a PURE refusal.** A TTL cannot close a replay inside
   its own window; consuming the ticket can. The spent-state check runs *before* the nonce compare,
   so a used ticket is not an oracle — which also puts it ahead of everything that establishes who
   is calling, so it computes, refuses, and touches nothing. A teardown on that branch would let one
   call that names only the site kill a customer's live viewer. Reaping the view belongs to
   `x11vnc -once`/`-timeout` and to the expiry branch, where the fact is about the ticket rather
   than a claim about the caller.
4. **It is bound to the session that asked.** `--bind` is mandatory; there is no implicit unbound
   ticket, because an unbound one is a bearer credential for a live logged-in account.
   `--bind=local` is the named escape for a hand-run on the box. A refused redemption from the
   wrong session does not spend the ticket for the right one — and neither does a redemption that
   finds the viewer's credential gone: it refuses, leaves the ticket open, and the same link works
   once a viewer is running again.
5. **The nonce never enters argv.** `/proc/<pid>/cmdline` is readable by other seats, so
   `viewer-redeem` takes the nonce on **stdin** and refuses `--nonce=<value>` outright.
6. **It is never minted onto a port that is not accepting yet.** The display server and the
   websocket bridge start in the background, so "the mint returned" and "the port is bound" are
   different moments — and the relay redeems the link the instant it gets it. `viewer` waits for
   both loopback ports to be listening before it prints a link, and refuses (issuing no link at
   all) if either never comes up. A one-time link onto a dead port costs the customer their single
   redemption; no link costs them a retry. The wait reads `/proc/net/tcp` rather than connecting,
   because connecting would itself spend the one client `x11vnc -once` admits.

**Killing the viewer does not kill the browser.** The profile is the durable half; the view onto it
is the ephemeral half. `viewer-revoke` ends the view and the session stays logged in.

## `<site>` is the host

`linkedin.com`, `reddit.com` — the name the dashboard passes, and the name the profile directory
takes. A name containing a dot is used verbatim as the host. A bare label (`linkedin`) is a
*different* profile and its URL is guessed as `<label>.com`; that guess is a convenience, not the
contract. An adapter's `probe.url` outranks both.

## Driving this from an agent seat

The commands are easy; the ORCHESTRATION is where a seat burns the customer's one-time link,
and every mistake there is silent. The workflow ships with the plugin, twice, from one source:

- **Claude seats** — the skill `skills/connect-site/SKILL.md`, which fires on "log in to
  &lt;site&gt;", "the agent needs a logged-in &lt;site&gt;", "open a browser on the box".
- **Every other harness** (codex, grok, pi, opencode, qwen, agy) — the same text as a plain
  file, `AGENTS.md`, printed by `5dive browser doc` and installed into a seat's instruction
  file by `5dive browser doc --append=<file>`. The block is marker-fenced, so re-running it
  after an upgrade REPLACES the section instead of stacking a second, divergent copy. A
  Claude-only skill teaches half the fleet; a plugin is a capability, not a channel.

The one rule worth repeating here: **the viewer link belongs to the human and is spent by the
first successful GET.** An agent that opens it "to check" has denied the person it was minted
for. Diagnose a handed-over link from the box journal
(`journalctl -u shelld | grep -E 'viewer_bind|viewer_redeemed|viewer_denied|viewer_ws_connected'`),
or with a deliberately bad nonce — never by visiting it.

That includes chat previewers. Send the URL as non-unfurling code and tell the human to
copy-paste it into their browser, never back into chat. All six Telegram adapters enforce
this at the Bot API boundary; another chat adapter must provide the equivalent guarantee.

## The auth model

`5dive browser auth <site>` opens a browser profile dedicated to that site and you log in
**manually, once**. No cookie export, no password handed to an agent. The agent is granted
permission to **operate the session**, not the credentials. Three reasons that is strictly better
than a cookie export:

1. **Blast radius is one site.** A cookie jar is your whole logged-in life; a profile is one account.
2. **It survives.** Cookies expire and the export is dead; a live profile re-auths in place.
3. **No password ever enters our process** — the difference between "we had a breach" and "we had a
   breach and it did not matter."

## A profile directory IS a credential

Anything that can read the directory can replay the session, regardless of the permission model
layered above it in our own code. On a box with ~18 seats that needs OS-level isolation, so the
store is:

```
/var/lib/5dive/browser-profiles/          root, 0711   traverse, do not list
                              /<seat>/    that seat,  0700
                                     /<site>/         0700
```

`0711` on the parent means a seat reaches its own subtree and can enumerate nobody else's. It also
means a seat cannot create its own directory there, which is why `setup` is a root act — the
alternative is a world-writable parent, and on one of those a hostile seat pre-creates another
seat's directory name, owns it, and every profile that seat later authenticates lands somewhere it
can read. Every command re-audits owner and mode and **fails closed**; it never repairs them.

## Sessions die, and that is the steady state

Sites invalidate sessions on their own schedule, throw device checks, re-prompt 2FA and
interstitial on "unusual activity". A profile that worked Monday is logged out Thursday, and
without a scheduled probe the agent finds out **mid-publish**. So:

- `5dive browser status` is a cheap liveness probe **on a schedule, not at publish time**. One
  page load a day is worth more than any adapter. It reports `authenticated`, `session expired —
  human action required`, `CHALLENGE — human action required`, or `UNKNOWN` when the probe could
  not read the page at all (no browser on the box, a load that failed).
- **`authenticated` requires an adapter, and with no adapter the answer is `UNKNOWN`.** The only
  evidence for a login is the adapter's `logged_out_when_dom_matches` failing to match. Without
  one that test is skipped, so anything that merely LOADED used to be stamped `authenticated` —
  including a profile nobody had ever logged into, which is what the dashboard's Connected-sites
  tile then showed. A challenge is still named without an adapter (that marker has a default), so
  the one classification that does work with no adapter is not lost.
- **A served profile is not probed.** Chrome allows one instance per profile directory, so a probe
  launched at a profile `serve` is holding is handed off to the running browser and returns an
  empty document. `status` says `UNKNOWN (served on :N …)` and leaves the last real verdict
  standing rather than reporting a load failure that did not happen. Probing *through* the served
  browser needs a CDP endpoint, and a loopback debugging port on a logged-in profile is reachable
  by every seat on the box — the credential the 0700 store exists to protect, handed over with no
  file permission needed. Not a trade `status` gets to make.
- **`UNKNOWN` is deliberately asymmetric, and both halves are load-bearing.** `status` stays
  QUIET on it and exits 0 — a network blip must not page a person, or the signal becomes noise.
  `run` **refuses** on it, because the action is the irreversible half and an unverified session
  is as likely to be a challenge page as a healthy one. `run` proceeds only on `authenticated`:
  a positive list, so a state the classifier has no name for cannot fall through to the driver.
- A **challenge is classified before a logged-out state**, because a challenge page usually still
  carries the login form's markup. Get that order wrong and you send someone to re-authenticate a
  session that is fine, which teaches them the signal is noise.
- A cold profile **pings a human**, naming the site, with a one-command fix. Only a person at a
  browser can clear it.
- Adapters **fail closed** on an unexpected logged-out state: never retry, never improvise a login,
  never fall through to a generic "click the blue button".

## `browser shot` — reading a page as yourself

`serve` and the viewer get a human's **login** into a profile. `shot` is the first thing that
**uses** one:

```
5dive browser shot <site> <url> [--out=<png>] [--dom=<file>] [--size=WxH|--full] [--wait=<ms>]
```

It renders that URL inside the profile and writes a PNG — what *you* would see, logged in — plus
the DOM on request. No adapter action, no step vocabulary, nothing written to the site: it is a
**read**, which is why it ships ahead of the executor. Two consumers it exists for:

- **A logged-in page of our own product.** A grader or a merger cannot open one, so "the PR carries
  a rendered screenshot and someone has LOOKED at it" costs a human tap every single time.
- **A read session on a site that shows a logged-out visitor nothing useful** — an x.com or
  reddit.com thread. The shot plus the DOM *is* the read.

**It refuses unless the session probes `authenticated`** — the same positive list `run` uses, for a
sharper reason. The failure here is not a crash: it is a PNG **of the sign-in page**, handed over as
the artifact. That is evidence-shaped, and the person reading it cannot tell it from the real thing.
So `session expired`, `CHALLENGE` and every flavour of `UNKNOWN` all write no file at all. With no
adapter the probe cannot tell logged-in from logged-out, so that is a refusal too — and shipping a
*guessed* `logged_out_when_dom_matches` to unblock a site would be worse than shipping none, since a
marker that never matches stamps every logged-out page `authenticated`. One adapter per site,
written by someone who looked at that site's logged-out page.

**The served browser is stopped for the render, and put back.** Chrome allows one instance per
profile directory, so a render launched at a profile `serve` is holding comes back empty. The other
way past that wall is CDP on a loopback debugging port — and that port is reachable by **every seat
on this box**, handing them full control of the logged-in browser with no file permission needed,
which would make the profile's 0700 mode decorative. `shot` opens **no socket at all**: it stops the
serve, renders headless, and restarts the serve, including when the render fails. The login is in
the profile directory, not in the process, so it survives. The one case it will not cycle is a
**live viewer** — that is a person at a keyboard, probably part-way through the login the viewer
exists for, and a screenshot does not get to take that away.

**The `--out` path is cleared before the render, and an empty result is a refusal.** A PNG that is
not of the page you asked for is the same lie as the sign-in page — a grader cannot tell yesterday's
dashboard from today's — and the ordinary way to produce one is to re-render to a path that already
holds an earlier image: if chrome then writes nothing, a check for "is there a file" says yes. So
the destination is emptied first, and a render that leaves it empty writes nothing and exits
non-zero. If the old file cannot be removed, `shot` refuses rather than render into it. (`--dom=`
needs no equivalent — the redirect truncates before chrome starts.)

**The URL must be a page of that site** (the profile's host, or a subdomain of it — `app.<product>`
behind the login is the point). A profile is a credential scoped by its own name; pointed at an
unrelated host it renders a logged-out page that reads as a bug in this command.

`--full` is a **tall viewport**, which is the most headless Chrome's screenshot can honestly
promise — it does not scroll-stitch a page.

**The boundary on whose account this is.** A profile here is a *throwaway or role* account, never a
person's personal login — with exactly one exception, stated so it is not quietly widened: the
owner's own box, running the owner's own login, to their own product. That is a person granting a
machine they own a session to a service they own. It is not a template for anyone else's account,
and it is not a reason to log a 5dive box into a third party's personal profile.

## Adapters are data, and the vocabulary is fixed

An adapter is a JSON file named `<site>.json`, and it is looked for in two places, most-local
first:

1. **`/var/lib/5dive/browser-profiles/<seat>/.adapters/`** — the seat's own, next to the profiles
   it describes. **Write yours here.** It is already root-created and 0700-audited, and nothing in
   a package upgrade touches it.
2. **the plugin's own `adapters/`** — what 5dive ships, a read-only fallback. A seat file of the
   same name wins, which is how you correct a shipped adapter and have the correction stick.

`FIVEDIVE_BROWSER_ADAPTER_DIR` overrides both and is then the only directory searched.

**Why two and not one.** It was one — the package's `adapters/` — and that directory is replaced
wholesale by `5dive plugin upgrade browser@5dive-plugins`. Measured 2026-09-14: a hand-written
`adapters/reddit.com.json` was there before the upgrade and gone after it, and `status reddit.com`
went `authenticated` → `UNKNOWN (no adapter)` with nothing else changed. An adapter is your own
data about your own site; an upgrade that eats it silently un-classifies a live session.

Its steps come from a closed vocabulary —
`goto fill click wait_for select upload press` — and a step outside it is a **load-time refusal**.
There is no `eval`, no `script` and no free-text instruction step, because any of those would make
the adapter a program the executor merely hosts. The LLM decides *what* to distribute, where, and
whether it is worth doing; the **adapter** decides where to click, what to fill, how to publish.
Freeform browser reasoning on a publish action is how a half-written draft reaches a real account.

## Verification is out-of-band or it is not verification

Every action must declare `verify.url` and `verify.expect`, and `run` checks that **before it
executes a single step**. After the driver finishes, `run` re-reads the artifact **from a different
path** — the permalink, fetched outside the browser session — and its exit status is that read, not
the driver's. A DOM assertion on the page you just acted on catches neither failure that matters:

- posted the wrong thing (draft, truncated, wrong account) and reported success;
- published fine but reported failure — so the retry double-posts.

## The executor

`5dive browser run <site> <action> [--key=value ...]` ships with one, `bin/driver-playwright`, and
uses it unless `FIVEDIVE_BROWSER_DRIVER` names another (the Browser Hand shape — extension + local
relay — is still a valid backend). One executor, not six: each candidate runtime carries its own
site adapters on someone else's maintenance schedule, so six dependencies is six adapter surfaces
that rot.

**It drives YOUR profile, over a pipe.** The driver opens a persistent context at the seat's own
0700 profile directory — the one a person logged into by hand — and speaks CDP over
`--remote-debugging-pipe`, the child process's own file descriptors. **No listening socket exists.**
A loopback `--remote-debugging-port` would be reachable by every seat on the box, and CDP is full
control of the browser holding the session: a seat that could never open the profile directory
would get the session anyway, with no file permission needed, and the directory's 0700 mode would
be decorative. A `--remote-debugging-*` argument arriving by configuration is a refusal, not a
launch. This is the same claim `shot` makes, for the same reason.

**It is not a fallback to a throwaway browser.** The earlier refusal here said Playwright was the
wrong tool for running an adapter; that was about a Playwright that launches its own fresh browser,
which would throw the hand-logged-in profile away and make the whole design pointless. The driver
has no launch path that is not this profile directory.

**A served browser is cycled around the run** — stopped, driven, started again — because Chrome
allows one instance per profile directory and a second one hands its work to the running instance
and exits with an empty document. The login lives in the directory, not in the process. A **live
viewer** is the exception: that is a person at a keyboard part-way through the login the viewer
exists for, so it is a refusal rather than a cycle.

**Exit 70 means nothing ran.** `run`'s verdict is an out-of-band re-read of the artifact, which is
the right grade for an action that executed and the wrong one for an action that never started —
for an adapter whose verify URL is an existing page, an executor that is not installed on this box
would otherwise report SUCCESS for a publish nobody performed. Every refusal the driver raises
before its first step exits 70 and `run` then refuses instead of re-reading. After the first step a
failure is exit 1 and the re-read governs, because "published fine but reported failure" is real
and a blind retry on it double-posts.

**"Before the first step" is not "before the launch."** The browser opening is not a step. A
browser that opens and then cannot hand over a page has run nothing, so that is exit 70 too — the
driver counts steps rather than trusting a place in the file, and a step counts from the moment its
`await` is entered, not from when it returns: a `goto` that throws may already have navigated and a
`click` may already have posted, and calling *that* "nothing ran" would suppress the re-read on an
action that half happened.

**Playwright is pinned.** `plugins/browser/package.json` names an exact `playwright-core` version,
no caret: the driver speaks CDP to a Chrome holding a human's live session, and a silent minor bump
changes the launch arguments under a credential. Install it with
`npm install --prefix plugins/browser`; without it, `run` refuses and says so.

**And it is pinned by LOCATION as well as by version.** A bare `require('playwright-core')` searches
`node_modules` in every ancestor directory of the driver, so unpacking the plugin somewhere that
happens to sit under one hands this process — the one that opens a directory full of live sessions —
a library nobody chose. The driver looks in exactly two places, in order: the directories `NODE_PATH`
names, if any, then `plugins/browser/node_modules`. There is no ancestor walk, so "not installed"
is a fact about those two places rather than about where the plugin was unpacked.

## Not shipped yet, and named so nobody assumes it

- **The customer-facing FLOW.** Server mode and the viewer above are built, but they ship **dark**:
  reachable by hand on a box that has the packages, wired to no button. The dashboard tile and the
  relay that gates on `viewer-redeem` are DIVE-4239; the provisioning that installs
  chromium/xvfb/x11vnc/websockify is DIVE-4238; and no human has yet logged into a real site
  through a real viewer on a managed box. Until that end-to-end arm runs, the flow is not shipped —
  a tile that promises a login nobody has driven is the failure DIVE-3590 named.
- **RELAY mode** — an outbound relay to Chrome on the user's own laptop. It must target a
  **dedicated profile on that desktop, never the user's default**; reaching the default discards
  the entire reason profile-per-site is the design, turning an adapter bug into their bank and
  their email. Do not ship it unscoped.
