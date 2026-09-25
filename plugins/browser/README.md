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
5dive browser probe-all             # scheduled sweep; served profiles are skipped
5dive browser ls                    # profiles, and when each was last seen alive
5dive browser run <site> <action> [--key=value ...] [--approved-id=<id>]
5dive browser tree <site> <url> [--settle=<ms>]   # refs; --settle also on snapshot,
                                                  # --page-settle on run
5dive browser act <url> --steps=<json> [--expect=<regex>] [--approved=<id>]
5dive browser snapshot <url> --wait-for='[role=main]'   # capture when the page shows it;
                                                  # also on read and act (exit 76: not ready)
sudo 5dive browser approve <id> [--deny]          # the owner's yes to a pay/post/send/delete
```

## The browser works with nothing connected, and it acts (DIVE-4943)

Every page verb (`read links shot snapshot tree act`) takes a **URL in place of `<site>`** and
resolves the profile once, in `_route_site`: the host's one connected login; the **public profile**
`_public` when the host has none (per seat, nothing logged in, no login probe, never listed as a
connected site); a refusal naming the accounts when there are several (`github.com_work`,
`github.com_personal` — a profile is `<site>_<label>`, and which account acts is the owner's call).

`act` runs agent-written steps in the fixed vocabulary (`goto fill click wait_for select press`)
through the same executors, lease and login gate as `run`, and grades `--expect` against the page
as the steps left it. **Paying, publishing, sending and deleting stop before the step** (exit 73):
the executor reads the live element's label (`lib/aria.cjs` `stepRisk`, shared by both step loops),
records the ask with a screenshot, and waits for `sudo 5dive browser approve <id>`, a root-owned
grant bound to the exact steps, good once for 30 minutes. It catches the literal buttons, not
intent: an order behind a button labelled "Continue" is not caught.

`run` stops the same way where the adapter's action says **`"guard": true`** (DIVE-4984): a
recipe is a reviewed file, but when its arguments choose the recipient and the words — a mail —
sending is still the owner's call. The ask records the `--key=value` arguments and `approve` shows
them; the yes is bound to that action with those arguments, and is spent with
`run … --approved-id=<id>` (a dashed flag, so it can never be an adapter's `{placeholder}`). An
action without `guard` keeps the contract it had.

A connected site with **no adapter** is no longer refused outright by the page gate: it proceeds
unless the page is visibly a sign-in (password field, a form posting to a login path, a sign-in URL
after redirects) or a challenge, and says every time that no adapter confirmed the login.

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

/var/lib/5dive/browser-sessions/          root, 0711   traverse, do not list
                              /<seat>/    seat:group, 0750   the broker rendezvous
                                     /<site>.sock     0770   the session daemon's face
                                     /<site>.offered  0640   "this seat has a login here"
```

`0711` on the parent means a seat reaches its own subtree and can enumerate nobody else's. It also
means a seat cannot create its own directory there, which is why `setup` is a root act — the
alternative is a world-writable parent, and on one of those a hostile seat pre-creates another
seat's directory name, owns it, and every profile that seat later authenticates lands somewhere it
can read. Every command re-audits owner and mode and **fails closed**; it never repairs them.

## A site login is per BOX, and it is brokered

A store like the one above is per SEAT, and that had a cost nobody had priced. Measured on one box
2026-09-20: fifteen seats, **fourteen of them with empty stores** — every agent seat logged out of
every site a human had connected, and each seat that needed a site was another human login. With
~18 seats and one shared site that is also up to eighteen Chromes at ~300–500 MB, so the number of
seats that can hold a live session at once was bounded by RAM rather than by anything about the work.

The fix is **not** a shared directory. Anything that can read a profile can replay the session, so
group-reading the store is handing out the credential, not tuning a permission. Instead:

1. **The store does not move.** Its owner is the shelld seat (`claude`), where every existing login
   already lives — no migration, and the directory stays 0700 to one uid.
2. **Other seats reach it through a BROKER.** The session daemon's unix socket moves out of the
   0700 directory into the rendezvous above, where every agent seat in the box's group can connect
   to it. They never open the profile; they ask the process that already has it. Still never a TCP
   port, for the reason the daemon has always refused one.
3. **Own store first, then the box store.** A seat that made its own private login for a site keeps
   using it. Per-seat survives as the opt-in it always was.
4. **Every request is attributed.** The daemon reads `SO_PEERCRED` off the connection, so the lease
   and every audit row carry `holder=claude on_behalf_of=<the calling seat>` — the kernel's answer
   about who is asking, not a name the request supplied. Where the caller cannot be named, the
   rendezvous socket is not opened at all and the session stays one-seat, as before.

A seat with no login of its own and nothing serving the box's gets a refusal that says so and names
the seat to start it — never "no profile", which is the sentence that sends somebody to do a second
human login they did not need.

**Sandboxed seats are outside this by construction.** `5dive agent create` puts admin and standard
seats in the `claude` group and deliberately leaves sandboxed ones out, so a sandboxed agent cannot
reach the rendezvous. That is its isolation working, not a gap.

## Sessions die, and that is the steady state

Sites invalidate sessions on their own schedule, throw device checks, re-prompt 2FA and
interstitial on "unusual activity". A profile that worked Monday is logged out Thursday, and
without a scheduled probe the agent finds out **mid-publish**. So:

- `sudo 5dive browser setup` installs and enables a **per-seat systemd timer** which runs
  `probe-all` on a six-hourly calendar (`OnCalendar=*-*-* 00/6:00:00`, plus a randomized delay of
  up to 30m so a fleet does not probe in lockstep). It is a CALENDAR schedule and not an interval
  on purpose: `Persistent=true` only has an effect on a calendar timer (systemd.timer(5)), and
  that is what makes a window missed while the box was down run once when it comes back. Systemd,
  rather than cron, also keeps the seat identity explicit (`5dive-browser-probe@<seat>.timer`) and
  puts each sweep in the journal. Re-running setup reconciles and re-enables the same units.
- `probe-all` attempts every eligible profile, but prints `skipped: served` and leaves the
  liveness stamp untouched when a profile is open in server mode. Holding the profile makes a
  second Chrome probe invalid; the next timer run, or the dashboard's close-view action, checks it
  after the served browser stops.

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
- **A SINGLE-PAGE APP NEEDS A POSITIVE MARKER, AND THE PROBE WAITS FOR IT** (DIVE-4794). Telegram
  Web serves ONE static shell for both states — `has-auth-pages` is in the bytes the server sends —
  and removes it in JavaScript after its own network init decides it is logged in. Dumped at
  domcontentloaded plus a fixed settle, a live session and a dead one are the same document, so a
  marker written against the shell stamped `expired` on a live login and every acting verb refused.
  Two changes, and they only work as a pair:
  - an adapter may name `probe.logged_in_when_dom_matches` — what a LOGGED-IN page looks like;
  - where it does, the probe keeps looking (up to `FIVEDIVE_BROWSER_PROBE_WAIT_MS`, default 8000,
    returning the instant either marker appears) and a page that shows NEITHER is `UNKNOWN`, never
    `authenticated` by elimination. That is the fail-closed half: `run` and `shot` still refuse.

  An adapter with no positive marker is untouched — one look, classified on the negative alone —
  because without something to terminate on, waiting only adds a chrome launch to reach the same
  answer.
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
- A hand-written adapter under an installed plugin directory is not durable configuration:
  upgrading or reinstalling the plugin can replace that directory. Keep custom adapter source in
  version control and restore/publish it after an upgrade.

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

### `browser snapshot` — one cycle, one page instant, everything a decision needs

```
5dive browser snapshot <site> <url> [--out=<dir>] [--interactive] [--json] [--no-shot] [--full] [--settle=<ms>] [--wait-for=<target>]
```

Before an agent acts on a page it reads the same three things: **what it can click** (`tree`),
**what the page says** (`read`), and **what it looks like** (`shot`). Each of those is a separate
command, and each command here is a browser cycle — probe the session, open a browser at the
profile, load the URL, do one thing, close. Three cycles and three loads of the same page, for one
decision. `snapshot` is those three reads as **one** cycle: one navigation, one page-side walk that
returns the refs *and* the document, and one screenshot of that same tab.

The count is the point, and it is the shape jev-ultrafast measured upstream (1092 protocol calls on
a task whose work is 101): the cost is not the work, it is asking for it in pieces.

**The second half is correctness, and it is the half a fast box does not fix.** Three cycles are
three different page instants. A ref `tree` printed can be gone from the DOM `read` captured four
seconds later; the PNG can show a consent overlay neither of them saw. Those files land in one
directory looking like one observation of one page, and nothing in them says otherwise. Here they
come from one tab at one instant, so the artifact directory is honest by construction.

The artifacts, 0600 in a 0700 directory chosen exactly as `read` chooses one:

| file | what it is |
| --- | --- |
| `tree.json` | the addressable nodes: `ref=<role>/<name>[#n]`, quotable straight into `run` |
| `page.md` | the extracted article, from the **same pinned Defuddle bundle** `read` uses |
| `page.html` | the document both of the above came from, hashed in `page.meta.json` |
| `page.meta.json` | URLs, metadata, links, images, word count, versions, SHA-256 — `capture` reads `snapshot` |
| `page.png` | the same tab at the same instant (`--no-shot` skips it; `--full` is a tall viewport) |

**On a served profile it runs inside the warm browser** (DIVE-4621's daemon) — no launch, no stop,
no restart, and a person at a viewer is not disturbed. This is the render op that daemon did not
have, which is why `shot` and `read` still cycle a cold chrome of their own; `snapshot` does not
retrofit them, and they remain the right verbs when one field is all you want.

Every guard the other render verbs carry applies unchanged: the site boundary, the 0700 profile
audit, the live-viewer refusal, the positive authenticated-session probe, the per-site lease, and
the rule that an output directory is never the profile or beneath it. A capture that came back
empty writes **no** evidence at all.

### `browser read` — Markdown and provenance from the authenticated page

```
5dive browser read <site> <url> [--out=<dir>] [--json] [--wait=<ms>] [--wait-for=<target>]
5dive browser links <site> <url> [--out=<dir>] [--wait=<ms>] [--wait-for=<target>]
```

`read` reuses `shot`'s site boundary, private profile audit, live-viewer refusal and positive
authenticated-session probe. It then makes one Chrome `--dump-dom` capture and writes a private
evidence triple: `page.html` is the exact captured bytes, `page.md` is the extracted article with
YAML frontmatter, and `page.meta.json` carries the URLs, article metadata, links, images,
schema.org data, word count, capture/browser/extractor versions, and the SHA-256 of `page.html`.
With no `--out`, the directory is created mode 0700 beneath the seat's private artifact root;
each artifact is 0600. An explicit directory must meet that same ownership and mode contract, and
can never be the live profile or a directory beneath it. A logged-out refusal creates nothing.

`--json` prints the metadata plus Markdown as one object. `links` is the same one-capture read and
the same evidence triple, but prints only the extracted article's absolute link objects. It is not
a second crawler path.

The phrase **DOM capture** has a precise limit here: Chrome's `--dump-dom` is a post-script serialized DOM.
It is not the server's original response bytes, not a network archive, and not a
SingleFile snapshot with its subresources embedded. That stronger preservation belongs to a later
*archive* verb; describing this artifact as one would overstate what can be reconstructed. (The
`snapshot` verb below is a different thing again and makes no archival claim: it is one atomic READ
of a live page, and its `page.html` is the same kind of post-script DOM this paragraph is about.)

Extraction is a reviewed, vendored bundle pinned to Defuddle 0.19.3 and linkedom 0.18.13. Nothing
is resolved from npm at install or run time. Linkedom supplies Defuddle's documented Node DOM shape
for the already-rendered document; a full browser emulation such as jsdom adds no fidelity after
Chrome has done the scripting. Like `shot`, this path opens no CDP/debug socket.

**The boundary on whose account this is.** A profile here is a *throwaway or role* account, never a
person's personal login — with exactly one exception, stated so it is not quietly widened: the
owner's own box, running the owner's own login, to their own product. That is a person granting a
machine they own a session to a service they own. It is not a template for anyone else's account,
and it is not a reason to log a 5dive box into a third party's personal profile.

### The settle — a floor on when anyone looks, not a fix for a late element

```
5dive browser tree     <site> <url> [--settle=<ms>]
5dive browser snapshot <site> <url> [--settle=<ms>]
5dive browser run      <site> <action> [--page-settle=<ms>] [--key=value ...]
```

`tree`, `snapshot` and `run` all wait after `domcontentloaded` before anything looks at the page,
because a live application is still assembling itself there. The default is **1200 ms**
(`FIVEDIVE_BROWSER_TREE_SETTLE_MS`, and `FIVEDIVE_BROWSER_RUN_SETTLE_MS` for `run`, which falls back
to it). It is deliberately **never** `waitUntil: 'networkidle'`: a web app that long-polls never
idles, and waiting for one is what made a `read` hang for 150 seconds on a real box.

The number is worth setting, and here is a measurement rather than an opinion. On a GitHub issue
page, 2026-09-20: the default `tree` returned **54 nodes and no textbox**; `--settle=6000` returned
**76**, including `textbox/Add a comment` and `button/Comment`. An adapter quoting the refs from the
second tree is quoting refs the first one could not see.

**On `run` the flag is `--page-settle`, and the dash is the reason.** Every other `--key=value` on a
`run` command line is an *adapter argument*, so `--settle` there would be indistinguishable from an
adapter with a `{settle}` placeholder — the same collision `--lease-wait` exists to avoid. A
placeholder name is `[a-zA-Z0-9_]+`, so a flag carrying a dash can never be mistaken for one.

**A settle is a floor, not a fix.** It says how long the page is given before anyone looks; it does
not make a slow element arrive. An element that is genuinely late is `wait_for`'s job — and a
`wait_for` on a `ref=` now waits for the whole step timeout, polling the page, exactly as a
`wait_for` on a CSS selector always did. Raising the settle to cover a late element buys the delay
on **every** run of that adapter; a `wait_for` costs only as long as the page actually takes.

### Ready, not settled: `--wait-for`, loading screens, `read`'s cap, `--expect`'s window (DIVE-4983)

```
5dive browser snapshot <url> --interactive --wait-for='[role=main]'
5dive browser read     <site> <url> --wait-for='text=Inbox'
5dive browser act      <url> --steps=<json> --expect='Message sent' [--expect-wait=<ms>] [--wait-for=<target>]
```

A settle is a guess at how long a page takes, and on a web app it is the wrong guess. Measured on a
Gmail inbox, 2026-09-25: `snapshot --interactive` returned the loading splash (4 nodes: help links
and "Try reloading the page") with exit 0; `read` was still running when `timeout 200` killed it;
and `act --expect='Message sent'` printed NOT VERIFIED on a mail that was in the Sent folder,
because its one re-read came before the toast.

- **`--wait-for=<target>` on `snapshot`, `read` and `act`.** The capture is taken once the page
  shows the target, bounded by the step timeout (`FIVEDIVE_BROWSER_STEP_TIMEOUT`, 30 s); the settle
  runs after it. A target is a CSS selector, `ref=<role>/<name>` as `snapshot` prints it, or
  `text=<words>`; a bare word that matches no element (`Compose`) is also looked for as visible
  text. On `act` it is the re-read after the last step that waits. `read --wait-for` renders
  through the executor or the warm session, since a `--dump-dom` cannot wait for an element
  (`capture` in `page.meta.json` says which). A target that never appears is **exit 76**, and what
  was captured still ships, marked `partial: true`.
- **A known loading screen is named, never exit 0.** One table in `bin/browser`,
  `LOADING_SCREENS`, one line per screen: a name, the host, a sentence in the document, and a
  ceiling on interactive nodes. Gmail's splash is the first row. A match prints `LOADING SCREEN`,
  writes `loading_screen` and `partial: true` into `page.meta.json` and `page.md`, keeps the
  evidence (the PNG is how a person sees what the agent got) and exits **76**. The node ceiling is
  what separates the splash from the loaded app, which keeps the same sentence in a hidden element.
- **`read` never waits past a wall clock.** `--wait` is Chrome's *virtual* time, which does not
  advance while a request is pending, so on a page that long-polls it never runs out. Chrome is
  now told to stop loading at `FIVEDIVE_BROWSER_READ_CAP_MS` (default 30000) real milliseconds and
  dump what it has, and that capture is `partial: true`. A Chrome that does not stop is killed a
  few seconds later and `read` exits 76 with nothing written, rather than hanging.
- **`--expect` is re-read for a window.** After the last step, `act` reads the page again until
  `--expect` matches or `--expect-wait` ms pass (default 5000, `FIVEDIVE_BROWSER_EXPECT_WAIT_MS`),
  against the document **and** the text a person sees, toasts and `aria-live` regions included. The
  read that matched is the one that ships, so `page.png` shows the toast. `--expect-wait=0` is the
  old single read. The verdict is still `grep -iE` in `bin/browser`; the executor's poll is only an
  early exit, so a pattern JavaScript reads differently costs the window, never a wrong answer.
- **`act` leaves what `snapshot` leaves:** `tree.json` (`--interactive` narrows it), `page.md` and
  `page.meta.json`, beside `page.html`, `page.png` and `after.json`, all from the page the steps left.

**76 is not 75.** 75 means the session is cold and a person has to log in again. 76 means the
session is fine and the page was not ready: wait for it. Do not re-authenticate, and do not re-run
an `act`'s steps. A browser served before this release runs the old daemon, which ignores
`--wait-for`; that is reported as *not honoured* (76), never as met. `serve <site> --stop` and
`serve <site>` again picks up the new one.

## Adapters are data, and the vocabulary is fixed

An adapter is a JSON file named `<site>.json`, and it is looked for in two places, most-local
first:

1. **`/var/lib/5dive/browser-profiles/<seat>/.adapters/`** — the seat's own, next to the profiles
   it describes. **Write yours here.** It is already root-created and 0700-audited, and nothing in
   a package upgrade touches it.
2. **the plugin's own `adapters/`** — what 5dive ships, a read-only fallback. A seat file of the
   same name wins, which is how you correct a shipped adapter and have the correction stick.

`FIVEDIVE_BROWSER_ADAPTER_DIR` overrides both and is then the only directory searched.

**Shipped adapters, and what was measured for each.** A `logged_out_when_dom_matches` is read off
the site's RENDERED logged-out page with the plugin's own probe command — never off a plain fetch,
which for every site below returns a shell without the form. Each file's `_comment` says where and
when.

| site | probe url | marker | measured |
|---|---|---|---|
| `reddit.com` | `/login/` | `name="username"` | logged-out form in a real browser |
| `x.com` | `/i/flow/login` | `name="username_or_email"` | logged-out form, three renders (8s, 25s, Playwright 15s); the logged-in half is unmeasured because no x.com profile exists — that gap fails SAFE (a false "expired" asks a person; never a false "authenticated") |
| `github.com` | `/settings/profile` | `action="/session"` | BOTH halves: 3 matches on the sign-in page logged out, 0 on "Your profile" logged in |
| `google.com` | none | none | **the login check is not measured**, so there is no probe: `status google.com` reads UNKNOWN and `run google.com send` refuses (75) before a step, which is the fail-closed half. Measure it with `capture google.com` and reflex (below), and put the probe in the seat's `.adapters/google.com.json`. The `send` action's steps and its Sent-folder verify were measured on a live Gmail on 2026-09-25 (see the file's `_comment`) |
| `web.telegram.org` | `/k/` | out: `(page-signQR\|auth-qr-form\|…)`, **in:** `class="[^"]*chatlist` | the POSITIVE marker on both halves (9 matches on the settled live session, 0 on the shell and on a logged-out render); the logged-out marker matched 0 on the live session but its logged-out render was never observed — the K app does not paint sign-in inside the probe's window on a fresh profile. That gap fails SAFE only because of the positive marker: neither matching is `UNKNOWN`, not a login |

Every shipped adapter but one has `"actions": {}`: they classify a session, and the actions a
site's owner wants are theirs to write in their seat's `.adapters/`. The one is google.com's
`send` (DIVE-4984):

```bash
5dive browser run google.com send --to=<addr> --subject='<subject>' --body='<text>'
# -> exit 73 and an approval id; the owner: sudo 5dive browser approve <id>
5dive browser run google.com send --to=<addr> --subject='<subject>' --body='<text>' --approved-id=<id>
# -> verified: send is live at https://mail.google.com/mail/u/0/#sent (re-read in this profile)
```

It opens full-screen compose with To and Subject in the URL (Gmail drops a `body=` parameter, so
the body is typed), stops in front of Send until the owner's yes (`guard: true`), waits for
Gmail's "Message sent" before letting the browser go, and is verified by the Sent folder, read in
the same profile, on its newest row — never by the toast.

**Why two and not one.** It was one — the package's `adapters/` — and that directory is replaced
wholesale by `5dive plugin upgrade browser@5dive-browser`. Measured 2026-09-14: a hand-written
`adapters/reddit.com.json` was there before the upgrade and gone after it, and `status reddit.com`
went `authenticated` → `UNKNOWN (no adapter)` with nothing else changed. An adapter is your own
data about your own site; an upgrade that eats it silently un-classifies a live session.

**Drafting a login check for a new site: `capture`, then reflex (DIVE-4929).** Measuring a
marker used to mean running headless chrome by hand, once per half. Now it is one command from the
login's owner:

```
5dive browser capture linkedin.com --url=https://www.linkedin.com/feed/
sudo 5dive reflex login-marker linkedin.com --url=… --logged-out=…/signed-out.html \
     --logged-out=…/signed-out-2.html --logged-in=…/signed-in.html
```

- **What `capture` saves.** It saves the probe page three times, as 0600 files in a 0700 directory
  under the owner's home: twice signed OUT (two throwaway profiles, the probe's own command) and
  once signed IN (this login, or the served session). It classifies nothing and writes no
  adapter.
- **Why two signed-out renders.** A sign-in page carries tokens that change on every render, such
  as GitHub's `required_field_<hex>` honeypot fields. Only a token that both renders share can be
  a marker.
- **Who may run it.** A brokered seat is refused. The signed-in page is the account's own, and a
  capture exists for exactly the sites no probe verdict has cleared for reading.
- **What the second command does.** It is the 5dive CLI's shadow proposer. The code lists
  candidate markers and keeps only those that match every signed-out render and never the signed-in
  one. The reflex model picks one. Nothing is written: a person copies a proposal into
  `.adapters/` after reading it. With `--compare=<this site's adapter>` it scores the pick against a
  hand-written marker.

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

**Where the artifact is not public, the re-read is in the session (DIVE-4984).** The default
re-read is a plain fetch with no cookies, which is right for a permalink anybody can open and
wrong for a Sent folder: fetched from outside the login it is the sign-in page, so every Gmail
send read NOT VERIFIED. An action's verify can say so:

| field | what it does |
|---|---|
| `verify.in_session: true` | re-read `verify.url` through the executor that acted — the warm session when one holds the profile, the one-shot driver otherwise — in the same profile, still under the lease. Still a fresh load of a different URL, never the page the steps left. The window is `--expect`'s: `FIVEDIVE_BROWSER_EXPECT_WAIT_MS` (5000) |
| `verify.wait_for` | wait for this before reading (the `--wait-for` grammar: CSS, `ref=`, `text=`) |
| `verify.scope` | grade only the FIRST element that matches (the newest row of a list), so an older artifact with the same name further down cannot pass for the new one; nothing matching is NOT VERIFIED |

`wait_for` and `scope` need a page, so either one without `in_session` is refused when the
adapter loads. Arguments go in as what they are: into any `url` (a step's or the verify's)
URL-encoded, so a subject with `&`, `#` or a space stays one parameter, and into `verify.expect`
regex-escaped, so "Q3 (draft)" matches itself. A `fill` value is typed exactly as given.

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

**Playwright is pinned.** The plugin's `package.json` (`browser/package.json` in this repo) names an exact `playwright-core` version,
no caret: the driver speaks CDP to a Chrome holding a human's live session, and a silent minor bump
changes the launch arguments under a credential. Install it with
`npm install --prefix <the plugin directory>`; without it, `run` refuses and says so.

On a managed 5dive box nobody types that command. The nightly browser-stack converger
(`/usr/local/bin/5dive-browser-stack-install`, shipped by 5dive-api) reads the pin out of this
`package.json`, installs it as root into the enabled package directory with `--ignore-scripts`, and
does so again after every `plugin upgrade` replaces that directory — until then its status file reads
`executor=absent` and its health row says `run` will refuse. A box the converger has not reached yet
is exactly a box where `run` refuses honestly (exit 70, nothing re-read), never one where it runs a
throwaway browser (DIVE-4538).

**And it is pinned by LOCATION as well as by version.** A bare `require('playwright-core')` searches
`node_modules` in every ancestor directory of the driver, so unpacking the plugin somewhere that
happens to sit under one hands this process — the one that opens a directory full of live sessions —
a library nobody chose. The driver looks in exactly two places, in order: the directories `NODE_PATH`
names, if any, then the plugin directory's own `node_modules`. There is no ancestor walk, so "not installed"
is a fact about those two places rather than about where the plugin was unpacked.

## Ad filtering, and the one site where you turn it off

Agent Chrome profiles on a managed box carry exactly ONE extension — uBlock Origin
Lite, pinned to a version we pack and host ourselves — and the same Chrome managed
policy that installs it blocks every other extension from being added, including by
a human sitting at the one-time viewer. Cookie walls, ad iframes and consent
overlays are what an agent clicks by accident, and what makes a `shot`/`read` DOM
several times larger than the article it was asked to read.

Some sites break under filtering. That is what this is for:

```
5dive browser adblock status              # is it on, and which sites is it off for
sudo 5dive browser adblock off example.com   # this site breaks — stop filtering it
sudo 5dive browser adblock on  example.com   # filter it again
```

Three things worth knowing before you use it:

- **It is root, and not by preference.** Chrome policy on Linux is machine-level
  only — `/etc/opt/chrome/policies/managed` — and there is no per-user policy path,
  so the file belongs to root the way the profile store's parent does.
- **It is total for that host.** The mechanism is
  `ExtensionSettings.<id>.runtime_blocked_hosts`, measured on Chrome 153: it stops
  the network-level filtering AND the extension's content script on that host.
  There is no "filter a bit less" setting.
- **`shot` and `read` pick it up on their next render; a browser already running
  under `serve` may not.** Only fresh launches were measured. If you need it to
  take effect inside a live session, `serve <site> --stop` first.

The off list lives at `/var/lib/5dive/browser/ubol/adblock-off` and IS the source of
truth: the nightly root converge re-renders the policy file from it, so a host you
remove from that list comes back filtered.

## Limits: sites that block datacenter IPs

A box is a datacenter IP, and some sites refuse those outright ("Request blocked by network
security", "suspicious network"), at login or on every page. The fix is the customer's own
proxy — any residential proxy that gives you a URL:

```
5dive browser proxy set http://user:pass@host:port   # or: … proxy set -  (reads stdin)
5dive browser proxy show                             # password masked
5dive browser proxy clear                            # go out directly again
```

- **Per seat, and it is a credential.** One line, 0600, at `<profile root>/<seat>/.5dive-proxy`
  inside the seat's 0700 directory. It is never logged, never echoed back (`show` masks the
  password), and never in `status`. `proxy set -` keeps it out of shell history and `ps`.
- **Both browsers use it.** The served browser (`serve`, the session daemon) and a cold run
  (`run`, `act`, `tree`, `snapshot` with no browser up) hand it to Playwright's launch as
  `proxy: {server, username, password}`. That is the reason it is not a Chrome flag: Chrome's
  `--proxy-server` cannot carry a username and password, and every paid proxy uses them. With
  nothing set, no `proxy` key is passed at all — the launch is exactly what it was before. A
  setting that cannot be read refuses the launch, and a proxied `serve` whose daemon will not
  start refuses rather than falling back to plain Chrome from the box's own IP.
- **A browser already running keeps its route.** `set` and `clear` name the served browsers
  still on the old one and do not restart them (a person may be mid-login in the viewer, or an
  agent mid-publish). `serve <site> --stop` moves one; the next command starts it again.
- **Switching the proxy mid-session can end a site's login** — the site sees a new IP. Set the
  proxy before connecting a site, not after.
- **Box logins follow the box seat's setting** (`claude`). A site connected for the whole box
  runs in that seat's browser, as that seat, so another seat's `proxy set` does not reach it.
- **HTTP(S) proxies may carry a login; SOCKS ones may not.** Chrome under Playwright refuses
  SOCKS authentication at launch, so `proxy set` refuses it up front. Most providers offer an
  `http://` endpoint too.
- **What still goes out directly:** anything that starts its own plain Chrome rather than the
  Playwright one — the scheduled login check (`probe-all`/`status`) on a site that is not
  served, a cold `read`/`shot`/`capture`, and `auth` on a machine with a display. Keep a
  proxied site served so those go through the one browser that holds the route.

## Shipped, and what is still named so nobody assumes it

- **The customer-facing FLOW is live.** The dashboard's Connected sites tile went to production on
  2026-09-12 (DIVE-4355), and on 2026-09-14 a human logged into real sites through real one-time
  viewers on a managed box, ending `authenticated` (DIVE-4464). The flow is no longer dark and no
  longer wired to no button; the runbook for driving it is `skills/connect-site/SKILL.md` and the
  same fenced workflow in `AGENTS.md`. What the tile promises, someone has now driven end to end.
- **RELAY mode** — an outbound relay to Chrome on the user's own laptop. It must target a
  **dedicated profile on that desktop, never the user's default**; reaching the default discards
  the entire reason profile-per-site is the design, turning an adapter bug into their bank and
  their email. Do not ship it unscoped.
