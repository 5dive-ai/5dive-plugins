## Unreleased

### Fixed — a resume helper no longer types `continue` at a seat that already answered (DIVE-4628), telegram 0.5.55

At a usage wall the Stop hook spawns `resume-after-reset`, which sleeps until the
reset, types `continue` into the seat's tmux pane, and then watches the transcript
to confirm the agent picked up. It was handed the transcript path when it was
spawned — hours earlier.

A claude session ROTATES to a new `<session-id>.jsonl` (compaction, `/clear`, a
restart). When it does, the keystroke still reaches the LIVE session and wakes the
agent, but the verification polls the frozen old file, which by definition never
changes again. "Did it pick up?" is then permanently no, which reads as "still
limited", so the helper retried on a 300s timer. Measured on one seat 2026-09-19:
seven `continue` injections into an agent that answered every one of them and said
so, each injection a fresh turn with that agent's whole context re-sent.

The transcript is now re-resolved on every poll — the newest session file in the
project dir IS the live session — and a rotation is named in the helper's log. The
retry loop is bounded by ATTEMPTS as well as by time (6, doubling 5m→60m, ~2.3h of
reach against the old 72 injections over 6h), and the Telegram ping now says which
bound ended it. `resume-after-error` takes the same live-transcript resolution; it
was already attempt-bounded, but a rotation there still spent every remaining try
on an agent that had answered.

### Fixed — the `attached:` footer no longer clutters the human's message (DIVE-4280), telegram 0.5.54

Auto-attach appended `attached: report.md` to every reply that carried a file it
found in the text. The file arrives as its own message directly underneath, so on
a phone that line named something already on screen — one more thing to read past
in a chat that is mostly read on a phone.

The outgoing text no longer carries it. The two footer lines that survive are the
ones an attachment cannot say for itself: `+N more files named; ask for one by
name` when the five-file cap bit, and `too large to send: <name>`.

The names are not lost. `attachedNames()` puts them in the `reply` and
`edit_message` tool results (`sent (id: 41) · attached: report.md`) and in the
rolling log record of our own reply, so `recent_messages` still reads back what
was sent — the two readers that have no attachment to look at.

### Added — `5dive browser adblock`: turn ad filtering off for one site (DIVE-4516), browser 1.6.0

Agent Chrome profiles on a managed box now carry exactly one extension — uBlock
Origin Lite, pinned and force-installed by Chrome managed policy — and that same
policy blocks every other extension from being added, including by a human at the
one-time viewer. Some sites break under filtering, so there is a way to turn it off
for one host without turning it off everywhere.

- `5dive browser adblock status` / `sudo 5dive browser adblock off|on <site>`.
- Root, and not by preference: Chrome policy on Linux is machine-level only, with
  no per-user path, so the file belongs to root the way the profile store does.
  `adblock` joins `setup` as the second verb a root caller is NOT dropped out of.
- The mechanism is `ExtensionSettings.<id>.runtime_blocked_hosts`, measured on
  Chrome 153 before it was built on: uBOL Lite filters through declarativeNetRequest
  (the network stack), not through the content-script path that key is documented
  against, and it turned out to stop BOTH. It is total for that host.
- Both `*://host` and `*://*.host` are written. `*://*.example.com` does not match
  `example.com`, so a wildcard-only off switch reports success and leaves the apex —
  the host the seat actually typed — still filtered.
- `/var/lib/5dive/browser/ubol/adblock-off` is the source of truth, not the policy
  file: the nightly root converge re-renders that file, and a host living only there
  would be silently re-filtered at 03:00.
- Only fresh launches were measured, so `shot`/`read` pick a change up on their next
  render and the verb SAYS a live `serve` may need a restart rather than promising it.

### Fixed — a shared `XDG_CONFIG_HOME` made Chrome un-launchable for every seat but the first, and nothing said so (DIVE-4587), browser 1.6.1

Reported from a customer box with ~37 seats (teal-fox, 2026-09-16): every Chrome launch by every seat
but one aborted with `chrome_crashpad_handler: --database is required` and a core dump — rc 133, zero
bytes — so `serve`, `status`, `run`, `shot` and `read` were all dead. Chrome keeps its crashpad
database under `$XDG_CONFIG_HOME/google-chrome/Crash Reports` whatever `--user-data-dir` and
`--crash-dumps-dir` say, and creates it `0700`; 5dive boxes export one shared `XDG_CONFIG_HOME` to
every seat for `gh`/`gcloud`/`aws`, so the first seat to run Chrome owns that directory permanently.
`bin/browser` and `bin/driver-playwright` now drop the variable before launching anything, which gives
each seat its own crash directory under its own home. Dropping the shared export instead was not
available — about twenty other shared configs reach their state through it — and widening the
directory's mode breaks again at the next `0700` subdirectory Chrome creates.

The second half is why it survived for months: `status` printed a quiet `UNKNOWN (probe did not load)`
and exited **0**, the scheduled probe exited 0 without stamping anything, and `doctor` said nothing, so
the box read healthy while the plugin was entirely dead. A probe failure is now classified before it is
reported — the browser is asked for `about:blank` in a throwaway profile — and a browser that will not
start is a loud `BROKEN` state: non-zero from `status`, a refusal at `run` and `shot`, and the one
condition that fails the probe timer. A page that merely did not load stays quiet, as before: a network
blip must not page a person, but a box fault that no amount of re-probing will clear must.

### Fixed — the browser connect-site runbook now follows the shipped bound viewer flow (DIVE-4523), browser 1.5.3

The Claude skill and harness-neutral AGENTS block now carry one byte-identical fenced workflow. It
starts from the dashboard action that registers the relay bind and prefixes the box host, names the
relay's `claude` seat and the upgrade-safe seat-local adapter store, keeps one-time links
non-unfurling, and verifies a login only after revoke → stop → status. The old raw-CLI path could
produce a path with no live bind, target the wrong seat, and poll forever while Chromium held the
profile lock.

The handoff step states DIVE-4493's guard concretely rather than by reference — on Telegram, `reply`
with `format: 'markdownv2'` and the link in a MarkdownV2 code span; elsewhere that surface's
non-unfurling code formatting — and keeps the copy-paste warning and the rule against recording a
live link in a task body, PR, commit, log line or wiki page. `tests/browser_plugin_unit.sh` now
guards those strings in BOTH surfaces, so a rewrite cannot drop them while the bash harness stays
green; previously only `test/viewer-link-unfurl.test.ts` held them, and only for the skill.

`plugins/browser/README.md` no longer says the customer-facing flow ships dark and unlogged-into:
the dashboard tile went to production 2026-09-12 (DIVE-4355) and a human logged into real sites
through real one-time viewers on a managed box 2026-09-14 (DIVE-4464). The RELAY-mode caveat below
it is unchanged and still true.

### Fixed — Telegram previewers spent one-time browser viewer links before the human could use them (DIVE-4493), browser 1.3.1 · telegram 0.5.53 · grok/agy 0.5.21 · codex 0.5.14 · opencode 0.5.12 · pi 0.1.12

All six Telegram adapters now recognize the exact browser-viewer route at their Bot API
`sendMessage`/`editMessageText` boundary. Plain text is sent with a `code` entity, markup output gets
a code span, overlapping URL entities are removed, and previews are disabled. The transport also
adds copy-paste/do-not-return guidance; ordinary URLs and nonce lookalikes are unchanged. The shared
browser workflow carries the same rule for future chat adapters and records that a dashboard may
offer copy-only UI but must never prefetch the credential.

### Added — authenticated browser pages can be read as Markdown with a hash-bound evidence triple (DIVE-4515), browser 1.4.0

`5dive browser read <site> <url>` now reuses the `shot` authentication and profile boundary, then
captures one post-script DOM with Chrome `--dump-dom` and extracts the article through a vendored,
exactly pinned Defuddle 0.19.3 bundle. It writes private `page.md`, `page.html`, and
`page.meta.json` artifacts; the metadata binds the exact DOM bytes by SHA-256 and records URLs,
article fields, links, images, schema.org data, extractor version, Chrome version, and capture
method. `--json` returns metadata plus Markdown, while `browser links` uses the same capture and
prints only the extracted links. Logged-out, cross-site, live-viewer, and profile-directory output
attempts fail before producing evidence, and the read opens no CDP socket.

### Fixed — a failed gate tap said "exited 126 without reporting a reason" while the reason was in hand (DIVE-4445)

When the 5dive CLI dies without reaching an error path, its own backstop
(`_report_silent_exit`, src/lib/output.sh) prints a CONTENTLESS envelope on
stdout — `{"ok":false,"error":{"class":"generic","message":"5dive task exited
126 without reporting a reason. This is a bug in the CLI, not a refusal: …"}}` —
while the actual cause rides on stderr. `describeTapError` preferred any
envelope over stderr, so on 2026-09-13 a tier-2 gate tap on a >128KB row (the
DIVE-4419 incident) told the human "exited 126 without reporting a reason" and
threw away `/usr/bin/jq: Argument list too long`, which was sitting in the same
rejection.

Two orderings were wrong, not one. Skipping the backstop envelope alone would
have landed the same tap in the `/JSON|Unexpected token/` sniff — our OWN command
line contains `--json` — and reported "the CLI answered with something
unreadable", burying the cause a second time. So the stderr-cause branch now
runs ahead of both, and the backstop-with-no-stderr case is answered before the
sniff too.

A genuine refusal envelope still wins over stderr (that is what carries `no such
task: 999999` and `no pending human gate`), and the backstop's prose is still
reported when stderr holds nothing — both pinned as controls. `firstCause()`
skips the backstop's own stderr echo and execFile's `Command failed: <argv>`
preamble, neither of which is a diagnosis. Applied to all six tna.ts copies
(byte-identical by harness rule); 12 new arms, measured red against the pre-fix
classifier.

### Fixed — the telegram plugins polled 5dive through `sudo` every 60s on scoped seats, and sudo mailed root every time: 83,898 messages / 66 MB on a customer's disk (DIVE-4397), telegram 0.5.52 · grok/agy 0.5.20 · codex 0.5.18 · opencode 0.5.11 · pi 0.1.11

Reported from OUTSIDE the company, twice, by an agent on a box that is not ours (`5dive-teal-fox-cx43`):
first on 2026-08-05 against telegram 0.5.36, again on 2026-09-13 against 0.5.51. It survived 15
releases and 39 days. Their numbers, on their disk: `/var/mail/claude` at 66 MB / 83,898 messages,
oldest 2026-08-05, 640 of them in one day, 12 scoped seats on the box and every one a source.

**Mechanism.** Every 5dive read in the plugin spawned `sudo -n 5dive …` unconditionally. A standard
(non-admin) agent's sudoers grant is scoped to `_deliver`/`_capture`/`_audit_append`, so that call is
denied — and sudo mails root about a denial. `reconcileNeedsBanner` runs on a 60-second timer
(`task coordinator`, then `task inbox`), so each scoped seat generated one root mail a minute,
forever, with no backoff and nothing to stop it. The reader's own `catch` swallowed the rejection, so
no component on our side ever reported a thing — it took an outside reader with shell access to see
it. A swallowed catch on a 60s timer is the whole reason this was invisible for 39 days.

**What changed.**

1. **Unprivileged first.** `task coordinator`, `task inbox`, `task ls`, `task show`, `heartbeat ls`,
   `org tree`, `agent list`, `agent info`, `usage`, `models` and `--version` are READS and need no
   root. The bare binary now runs as the seat's own uid first; on a scoped seat that path succeeds
   and sudo is never spawned, so no mail is generated at all. (`refreshModelAliases` had hand-rolled
   exactly this under DIVE-1883; that strategy is now the reader's, and that site is ordinary again.)
   A `{ok:false}` envelope from the unprivileged attempt is the one answer that still escalates.
2. **Sudo is a fallback, and a denial is sticky.** After the first `not allowed to execute` /
   `not in the sudoers file` / `a password is required`, no further sudo is spawned for the life of
   the process. Even where the unprivileged path also fails, an unbounded mail stream becomes at most
   ONE message per process start. A non-zero exit from 5dive *itself* is a product error, not a
   refusal, and deliberately does not latch — otherwise an admin seat would silently lose root.
3. **It says so out loud.** The denial prints one line naming the command, and a run of five
   consecutive read failures prints one line an hour (reset on any success). Silence is what cost 39
   days here.
4. **All six plugins, not one.** `telegram-{grok,codex,agy,pi,opencode}` each carry the same 60s
   banner timer over their own `run5dive`, and ship to the same customers. Fixing only `telegram`
   would have left the mail stream running in five of the six.

**Not fixed by granting sudo,** as the reporter asked and they are right: widening a seat's grant to
silence a poll is an access change made to quiet a log, and the access would outlive the need. Sudo
is still handed the bare word `5dive` and not an absolute path — sudoers rules on shipped boxes match
the command as written today, and "tidying" it to a path would turn every working grant into a denial.

**Existing boxes do not self-heal the mail already written.** The plugin stops adding to it on its
next install; the 66 MB already on that customer's disk is theirs to truncate.

### Fixed — the dashboard's `browser ls` refused on every box, so the Connect-a-site tile could never list sites (DIVE-4348), browser 1.1.1

Two defects in `bin/browser`, both found on the first real box (exact-swallow, 2026-09-12):

1. **A root caller refused every verb but setup.** The dashboard reaches the plugin through shelld's
   whitelist, `sudo -n /usr/local/bin/5dive browser …` — root, with `SUDO_USER=claude`. `_seat`
   resolved that to `claude`, but `_audit` compared the store's owner to `id -u` (0), so `ls`,
   `status`, `serve`, `viewer` and `viewer-redeem` all exited 77 ("owned by uid 1000, not by you
   (uid 0)") and `GET /server/browser/sites` read every box as unavailable. Root now re-executes as
   the seat (`runuser -u $SUDO_USER`) before any store is touched; `setup` stays root's.
2. **Every seat store was created 2700, and the audit wants 700.** `/var/lib/5dive` is 2750 on every
   box, a directory made under it inherits setgid, and GNU `chmod 700` preserves that bit on a
   directory. `setup` now uses the 5-digit form (`chmod 00700` / `00711`), which clears it. An
   existing box heals on its next daily converge (`5dive-browser-stack-install` re-runs setup).


### Added — browser server mode and a one-time re-auth viewer, so a managed box needs no ssh, no apt and no display (DIVE-4118), browser 1.1.0

DIVE-4021 shipped `5dive browser auth` as "open a real Chromium, and REFUSE without a display". On a
managed 5dive VM there is no display and there never will be, so the only route through that refusal
was `ssh -X` plus `apt install chromium` plus a hand-written adapter JSON. lodar, 2026-09-09: *"thats
too difficult for customers. the point was to make it easy to use for our paid customers on our
managed vm"*.

Server mode is the shape 4021's own design named as the DEFAULT and did not ship. The profile's
Chrome now lives on a persistent Xvfb display owned by the seat, and a person reaches it — to log in
the first time, and again when the site kills the session — through a viewer handed out as a one-time
ticket:

```
5dive browser serve <site>                                   # persistent Chrome on its own Xvfb
5dive browser viewer <site> --bind=<session> [--ttl=600]     # mint a one-time link
5dive browser viewer-redeem <site> --nonce=- --session=<id>  # the relay's gate; consumes the link
5dive browser viewer-revoke <site>                           # kill the view, keep the login
```

`auth` on a display-less box no longer dead-ends: it starts server mode and tells you to ask for a
viewer link. The old refusal survives only where it is true — a box without the server-mode packages,
which now says *which* ones it lacks instead of half-starting. The manifest version moves with the
verbs (1.0.0 -> 1.1.0) because `plugin add` resolves a version-pinned cache path: a fix ships by being
installable, not by being merged.

#### The question 4021 left open: what protects the session WHILE the viewer is open

A viewer onto a logged-in profile is not a screenshot. It is the credential with a keyboard attached,
so the answer is five properties and every one of them fails closed.

1. **Nothing listens off-box.** `Xvfb -nolisten tcp`, `x11vnc -localhost -once`, the websocket bridge
   on `127.0.0.1`. Redemption hands the relay a loopback target; the customer arrives through the
   box's already-authenticated relay, never a port we opened.
2. **The ticket is a nonce we do not keep.** 32 bytes of urandom; the file stores only its SHA-256.
   The raw value exists exactly once, in the line we print.
3. **It is single-use, and the replay branch is a pure refusal.** The spent-state check runs *before*
   the nonce compare, so a dead ticket is not an oracle — and that branch touches nothing, so a replay
   carrying a garbage nonce cannot tear down the live viewer it was refused from.
4. **It is bound to the session that asked.** `--bind` is mandatory; `--bind=local` is the named
   escape for a hand-run. A wrong-session redemption is refused and does not spend the ticket for the
   rightful holder.
5. **The nonce never enters argv.** `/proc/<pid>/cmdline` is readable by other seats, so the nonce
   arrives on stdin and `--nonce=<value>` is refused rather than accepted and hoped about.

Killing the viewer does not kill the browser. The profile is the durable half; the view onto it is the
ephemeral half, which is what lets the TTL be minutes.

#### A link is never issued onto a bridge that is not accepting yet, and the ticket never outlives it

The mint starts `x11vnc` and `websockify` in the background, so "started" and "accepting" are two
different moments — and the product's whole shape is a one-time link handed to a relay that redeems it
at once. `viewer` now waits (bounded, `VIEWER_BRIDGE_WAIT_S=10`) for both loopback ports to be
accepting before it writes a ticket or prints a link, and on timeout reaps and refuses: no link at all
costs a retry, a live link onto a dead port costs the customer their single redemption. The readiness
probe READS `/proc/net/tcp` rather than connecting, because connecting would spend the `-once`
admission the customer was promised. The previous ticket is revoked up front, since a mint that dies
halfway has already killed the viewer that ticket pointed at.

Both windows are then measured from **one clock, stamped before `x11vnc` starts**. `-timeout` is a
length counted from launch; `expires_at` is an instant, and it used to be stamped *after* that wait —
so on a slow bridge the ticket advertised up to ten seconds of life the VNC server had never been
given, and the end of the advertised window was the dead-port failure again from the other end. The
alternative fix (padding `-timeout` by the wait) was rejected on purpose: it leaves a VNC server
accepting a client after its own ticket expired, which is a live credential with no authorization
behind it.

#### A profile directory that already exists is GRADED, not laundered

`auth` ran `mkdir -p; chmod 700; _audit`, so on a directory that already existed the `chmod` repaired
a group-readable profile a moment before the audit that exists to catch it — against the README's own
rule that commands never repair. `_ensure_profile_dir` chmods only what it just created.

#### Evidence

`tests/browser_plugin_unit.sh`: **193 arms, 0 failed**, graded by **23 of 23 mutants killed** rather
than by arm count. Every count below was re-derived in THIS repo at this head — the plugin changed
repositories in DIVE-4202, so carrying forward numbers measured in the old one would be a claim about
a tree that no longer exists.

| mutant, i.e. the way the keyboard reaches the wrong person | suite |
| --- | --- |
| the ticket file keeps the raw nonce (compare adjusted so redemption still works: this isolates "the secret is on disk" from "redemption breaks") | 2 failed |
| redemption does not consume the ticket (a leaked link replays) | 5 failed |
| the expiry check is dropped | 2 failed |
| the session binding is not checked (a pasted link works) | 3 failed |
| a nonce in argv is accepted instead of refused | 2 failed |
| an existing profile directory is chmod'ed instead of graded | 2 failed |
| the package precondition is deleted | 4 failed |
| `x11vnc` loses `-localhost` (it answers every seat on the box) | 1 failed |
| `websockify` binds `0.0.0.0` instead of `127.0.0.1` | 1 failed |
| `Xvfb` loses `-nolisten tcp` (the display becomes a remote keyboard) | 1 failed |
| `x11vnc -timeout` goes back to a constant shorter than the minimum TTL | 3 failed |
| `x11vnc -timeout` is a plausible constant (900) instead of derived from the TTL | 2 failed |
| redemption prints the target but withholds the VNC password | 4 failed |
| the nonce compare is moved AHEAD of the spent-state check (the oracle) | 3 failed |
| `serve --stop` leaves the ticket open (it redeems onto a dead port) | 1 failed |
| stopping the viewer leaves its password behind in the profile | 2 failed |
| the replay branch tears the viewer down (a wrong nonce + a wrong session kills a live view) | 2 failed |
| the ticket is consumed BEFORE the credential read that can refuse | 5 failed |
| the bridge-readiness wait is deleted (a link onto a port nothing is bound to) | 8 failed |
| the up-front revoke is dropped (a failed mint leaves the old link live onto a dead viewer) | 2 failed |
| **new:** `expires_at` stamped AFTER the wait (the ticket outlives its own VNC server) | 1 failed |
| **new:** `-timeout` padded by the bridge wait (the VNC server outlives its own ticket) | 3 failed |
| **new:** the manifest version stays at the one that shipped without these verbs | 1 failed |

There is no X server on a CI runner, so `Xvfb`/`x11vnc`/`websockify` are fakes on PATH — liveness is
still the real PID check, redemption is still the real SHA-256 compare, and the only override is the X
socket *directory*, a path, which cannot make a dead display read as live. The fakes RECORD their argv
and BIND the port they are handed: written the first way they `exec sleep 300` and discarded `"$@"`,
which silently deleted the surface carrying the property this design leads with. Captures are cleared
before the mint that should rewrite them and read through a bounded non-empty wait, and every
"does not contain" assertion over a capture is paired with a control that the capture is non-empty —
an empty file contains no mutant string either, which is how "the flag is absent" and "the file is
absent" rendered identically.

#### Not in this change, and owed

The packaging half is not here: `5dive-api scripts/install/apps.sh` does not yet preinstall
chromium/xvfb/x11vnc/websockify or run `5dive plugin add browser` + `browser setup` at provision time
(DIVE-4238), and the dashboard's Connect/Reconnect tile is not built (DIVE-4239). No real `x11vnc` has
been asked to honour these flags and no human has logged into a real site through a real viewer. Server
mode therefore ships **dark** — reachable by hand on a box that has the packages, not wired to a button.

### Fixed — the silence notice DM'd the operator on a seat that was answering elsewhere (DIVE-4123 / #54), telegram 0.5.50

lodar filed 5dive-plugins#54 from a downstream seat on telegram v0.5.49 + dashboard: the plugin DM'd
"nothing has reached this channel for 3 turns" plus ~1200 chars of another channel's transcript,
while that seat was replying correctly on the dashboard. The silent-run analysis was hard-scoped to
telegram — a dashboard inbound left `hadInbound` false and a dashboard reply left `hadSend` false —
so every correctly-answered turn counted as dark and the run reached the 3-turn threshold. Its
destination fell back to the paired human's DM whenever no group topic was configured, which is
every seat.

That code was already deleted by DIVE-3910 in 3cfec88 (call site, `hooks/lib/autonomous-silence.ts`
and its unit file). What was missing is the release: the plugin version stayed at 0.5.49, and an
install resolves a version-pinned cache path, so every 0.5.49 install kept running the leaking
build. 0.5.50 is that bump — the fix ships by being installable.

Asked on the #54 gate whether to preserve the removal or resurrect the notice with sibling-channel
suppression; lodar chose preserve (2026-09-09). `test/dive4123-silence-notice-stays-removed.test.ts`
is the tripwire that keeps it gone across the whole telegram family: no `autonomous-silence` module,
no import or call of the silent-run analysis, no "reached this channel" text, the DIVE-3910
breadcrumb intact, and the shipped version at or above 0.5.50. The agent-side
`hooks/silence-watchdog.ts` is a different mechanism and stays untouched — it nudges the agent in
its own transcript and sends nothing to a user.

### Fixed — dashboard pending retries keep message identity and stop after three failed acknowledgements (DIVE-4125), dashboard 0.4.3

The dashboard pending collector emitted `message_id: "0"` for every control-plane row, so a
redelivery was indistinguishable from a new message and downstream `(chat_id, message_id)` dedup
could not work. It now carries the row's stable id plus a per-attempt delivery timestamp, attempt
number, and redelivery marker.

An acknowledgement failure also used to leave only a transient stderr line and permitted every
later boot, nudge, or sweep to push the same row again. A file-backed per-row retry ledger now
applies exponential backoff, parks a row after three unacknowledged pushes, and records pushes,
ack failures, and parking in `lifecycle.log`. Successful acknowledgements clear their ledger rows.

`test/dashboard-redelivery.test.ts` drives the real plugin against a failing-ack control plane:
three retries share one stable identity but have distinct delivery timestamps, the fourth drain is
parked, a genuinely new row still arrives, and the diagnostic files remain readable. Mutating the
message id back to `"0"` or raising the cap makes the test fail.

### Fixed — pairing a phone rotated the box token and the dashboard chat plugin never re-read it (DIVE-3810), dashboard 0.4.2

`plugins/dashboard/server.ts` read `CONNECTORD_TOKEN` once at module scope and held it for the life
of the process. `/etc/5dive/connectord.env` is rewritten while the agent is running — pairing a phone
does it — and from that instant the plugin held a dead credential for all three control-plane calls:
`GET /server/messages/pending` (collect), `POST /server/messages/pending/ack`, and
`POST /server/messages/event` (the agent's outbound reply). Chat died in BOTH directions and stayed
dead until something restarted the agent.

Measured on glossy-flint 2026-08-29: the env file's mtime was 17:23:20, the plugin had booted at
16:19:54.9, and the on-disk token was good (a hand `curl` with it returned 200). Five messages sent
at 17:30 never reached the transcript and all five stayed `delivered_at IS NULL` — nothing was lost,
nothing was falsely stamped. Buzz on the same box and the same claude process kept working
throughout, because it does not use this token, so the transport was never implicated.
`5dive agent restart` at 17:36:48 drained pending 5 → 0 in fifteen seconds.

The token is now mutable and every call goes through one `authedFetch`, which on a 401/403 re-reads
`/etc/5dive/connectord.env` and retries once — but only if the token actually changed, so a
genuinely revoked credential cannot spin. `authedFetch` is the only `fetch(` and the only
`authorization` header in the file, so no call site can hold a stale credential. The ack path now
checks `res.ok`; it used to print "healed N" after a 401.

**The failure also had no surface.** The single signal was one stderr line inside an MCP stdio
socket, written to no file on the box, while the control plane looked healthy — the messages sit in
`/pending` exactly as an ordinary undelivered queue does. `lifecycle.ts` gains an `auth` event: a
channel whose credential died mid-run is neither started, exited nor crashed, so without an event of
its own that state was recorded as `nothing`, which is what that file exists to refuse. One record
per episode, one on recovery, on disk.

The other seven plugins take the `LifecycleEvent` union widening and its comment and nothing else —
a type-only change with no runtime behaviour, so their versions are deliberately unchanged. All
eight copies of `lifecycle.ts` stay byte-identical.

Graded by `test/dashboard-token-rotation.test.ts`, which drives the real `server.ts` as a subprocess
against a stub control plane that 401s a stale bearer and rotates the token file under the running
process: inbound recovers with no restart, the reply tool recovers too (the mute half), the record
appears exactly once per episode, and all three call sites are asserted to route through the helper.
Deleting the reload+retry reds three of the four arms.

Not covered: whether pairing should rotate this token at all is a control-plane question and is not
in this change; blast radius across the fleet is unmeasured (no prod database access from this
seat), and restarting an agent re-reads the file and remains the safe interim sweep. One residual is
stated in the PR: the `STATE_DIR/.env` loader copies `CONNECTORD_TOKEN` into `process.env` before the
file is read, and an env-set token is deliberately never reloaded. No live box is affected: nothing
in the provision or agent-create path writes `CONNECTORD_TOKEN` into that `.env`, the installer
writes the box token once to `/etc/5dive/connectord.env` and shelld rotates it there, so that branch
is only ever taken by a test or a deliberate off-box run — but a seat that ever acquires a non-empty
`CONNECTORD_TOKEN` in that `.env` is back in the original bug with no signal.

### Fixed — the orphan watchdog is installed in every plugin, and its load-bearing clause could not fire (DIVE-3752), telegram 0.5.49 · buzz 0.1.2 · dashboard 0.4.1

Two defects, one of which was hiding inside the remedy for the other.

**1. The watchdog was compiled once and installed in one plugin.** DIVE-3486 established that
`bun run` does not forward SIGTERM, so an MCP server whose parent chain is severed keeps running.
`plugins/telegram/server.ts` carried the remedy. `plugins/buzz/server.ts` carried none of it — 424
lines ending in a bare `setInterval` with zero `process.on`, zero stdin handler and zero exit path —
and leaked one live poller per restart for six days: 22 reparented processes on one seat, every one
of them healthy and killable with a plain SIGTERM, which is the signature of a missing handler and
not of a hung poll. `plugins/dashboard` had the same gap; `telegram-pi` and `telegram-opencode` had
a `shutdown()` that stops the bot but never calls `process.exit`. All eight plugins that end in a
long-lived timer now install the same `lifecycle.ts`.

**2. `process.ppid !== bootPpid` cannot fire under Bun.** This was the clause the old watchdog
existed for, on the stated grounds that "stdin events don't reliably fire when the parent chain is
severed" — so in exactly the case it covers, neither signal worked. Measured on this host: a
grandchild whose parent was SIGKILLed reported the dead parent's pid every 500ms for six seconds
while `ps` showed its real ppid was 1.

    t=2s    cached=54284  realPpid=54284  bootAlive=true
    t=2.5s  cached=54284  realPpid=1      bootAlive=false   <- parent killed
    t=5.5s  cached=54284  realPpid=1      bootAlive=false

Bun caches `process.ppid` at boot and never refreshes it. Telegram's zero-orphan record came from
its stdin handlers, not from that comparison. The module reads `PPid:` from `/proc/self/status` and
falls back to whether the boot parent is still a process at all; both readings flipped at the
instant of severance above. A regression arm asserts no plugin compares `process.ppid` to a boot
snapshot again.

Graded, not asserted: the end-to-end arm spawns a real grandchild behind a real shell, proves it is
alive and heartbeating (the positive control — "it exited" is satisfied by a process that never
started), then SIGKILLs the parent and requires the child to be gone. With the old clause restored
it sits alive for the full 15-second window and the arm fails; with the `/proc` read it exits in
under a second.

### Fixed — a failed `bun install` ate the channel poller silently, and the launcher had no voice

`"start": "bun install --no-summary && bun server.ts"` in telegram, buzz and dashboard. Measured
under the launcher's own shell (`bun run --shell=bun`): `false && echo X` exits 1 and never echoes;
`false; echo X` echoes and exits 0. So a network-dependent step in front of a channel start is a
deafener, and on 2026-08-26 three seats including the coordinator were deaf for 2h33m with 9 human
gates pending while the only available signal was an ABSENT heartbeat — which cannot say which of
three failures produced it.

The `&&` is now `;`, so the install can still populate a cold cache but can no longer take the
poller with it. `node_modules` is NOT vendored in this repo (it is gitignored), so the install is
kept rather than dropped: deleting it would have broken the first channel start on a fresh box.

The start script now enters through a new `start.ts` that imports node builtins and `lifecycle.ts`
only — so it still loads, and can still write a record, in the one case `server.ts` cannot: when
`server.ts` throws on import because its dependencies are missing. Start, exit and crash records go
to `<state-dir>/lifecycle.log` with the reason, which is what turns "nothing there" into an answer.

The five telegram forks are GENERATED, not hand-maintained: `bun generator/generate.ts --check` is
the second CI step and it rejected the first push, because a new shared module that is not in the
generator's copy set exists in the committed fork and not in the generated one. `lifecycle.ts` joins
`tna.ts` and `banner.ts` in the byte-exact copy set — not name-swept, because the sweep would rewrite
`telegram` inside the module's own comments and break the byte-identity the parity arm asserts, and
because those comments cite `plugins/telegram/server.ts` by path as where the dead clause came from.
A swept copy would claim that history happened in a fork it never happened in.

**Not in this change:** rung-4 `poller-dead` restart (item 4 of DIVE-3752) is in `5dive-cli`'s
recovery ladder, which has no `restart` verb yet, and is filed separately.

### Added — dashboard chat collects on a nudge instead of waiting out its 5-minute timer (DIVE-3574), dashboard release 0.4.0

Dashboard chat showed "queued — this box collects every ~5 min": up to five minutes before the
agent even saw the message. lodar, 2026-08-18: *"really slow and unusable ux"*.

The collector was reachable only on a timer. It now also watches
`~/.claude/channels/dashboard/collect-now/`, where the control plane drops a zero-byte marker via
the box's shelld `POST /shell/collect-now`, and runs its normal collect immediately. Measured on
the box: **nudge -> collect in 260ms**, against the 300000ms fallback timer.

A separate directory from `agent-inbox` on purpose. The nudge carries no payload, so it must never
be mistaken for a message drop-file — the collector stays the single reader and there is no second
delivery path to reconcile. The 5-minute timer is untouched and stays load-bearing: a missed nudge
(box asleep, inotify drop, a runtime that predates the verb) costs the old wait and nothing else.

### Fixed — a nudge could deliver the same message several times over

`drainPending` used to be reachable only from boot and the 5-minute timer, two callers that could
never overlap. A nudge can fire repeatedly while someone types, and two concurrent drains fetch the
SAME pending rows and push each message into the session twice, because the ack only lands after
the notifications are sent. Drains are now serialised, with a single re-run for a nudge that
arrived mid-drain so a message landing after the fetch still does not wait out the timer.

Graded, not asserted: with the guard removed, `test/dashboard-collect-now.test.ts` delivers `first`
four times instead of once. Getting that arm to bite took two corrections — a fast burst is
swallowed by the watcher's own debounce, and a stub that re-reads its queue AFTER the response
delay hands the second drain the state after the first one's ack, which hides the race entirely.


### Fixed — the buzz poller could pile up until every buzz tool hung (DIVE-3486), buzz release 0.1.1

`buzz_read` and `buzz_post` through MCP ran past the client's 120s background threshold and
never returned, on dev3 and on quinn, while the relay answered in 39ms and `/usr/local/bin/buzz`
answered in ~30ms the same minute with the same key and channel. Measured on the graded tree,
the hang is not in the relay, not in the CLI, and not in the tool handlers.

The inbound poller was fire-and-forget under `setInterval`:

    const tick = () => { for (const ch of cfg.channels) void pollChannel(ch, seen) }
    tick(); setInterval(tick, interval)

A tick fired every `interval` whether or not the previous one had finished, and every channel
in a tick launched in parallel. Each poll spawns a `buzz` child holding ~10 descriptors, so one
slow poll compounds without bound. Driven at a compressed cadence against the shipped code, the
server pinned at **248 concurrent children and 1005 open descriptors** (the 1024 `RLIMIT_NOFILE`
soft limit) and the interactive tool calls sharing that process took **15-25s or never
returned** — the reported symptom. With the guard, the same harness at the same cadence holds
at **one child and 17 descriptors**, and calls return in ~0.04s.

The guard drops an overlapping tick rather than queueing it (queueing only defers the pile-up;
each backlogged tick still costs a child process), and runs a cycle's channels in sequence, so
the process holds at most one polling child at any instant no matter how slow the relay gets or
how many channels are watched. It lives in a new pure `plugins/buzz/poller.ts` because repo CI
runs a bare `bun test` with no plugin deps installed — a guard reachable only through
`server.ts` could not execute there at all. `plugins/buzz/poller.test.ts` pins it, carrying an
explicit non-vacuity control that reproduces the old stacking shape against the same instrument.

`plugins/buzz/.claude-plugin/plugin.json` goes 0.1.0 -> 0.1.1 with this fix. The install path is
keyed on that version string, so a merged plugin change that leaves it alone resolves to
already-installed and fetches nothing (8613e47): every hung seat would stay hung, silently, with a
green PR saying otherwise.

### Fixed — /inbox posts one message per gate, not one mesh (DIVE-3279), release 0.5.47

lodar, 2026-08-11: *"need to post it one by one when i call /inbox - not like a messy mesh
list in one message"*.

`buildActionableInbox` returned ONE `{text, keyboard}`: every card concatenated by
`clampList` into a single message under a single merged keyboard. It now returns an ARRAY —
one message per gate, each with its own card and its own ✅ button — and the caller sends
them in order, pinging on the first and silencing the rest.

DIVE-2712 had already made this exact fix on the CLI's PUSH path (`_task_inbox_send`), and
the typed `/inbox` relay path shells that same verb. So the founder saw a clean
one-per-gate stack from the digest DM and a mesh from the slash command **in the same
chat**: the defect was exactly one surface wide — the slash-command PULL path.

Three changes the split required:

* **`gclear` no longer rebuilds the view into the tapped message.** It used to answer a
  clear by editing that message with a freshly-rebuilt FULL inbox, which after the split
  re-meshes every remaining gate into the message the founder just cleared. The split would
  have survived exactly one tap, and every first-render test would still have passed.
* **`clampList` is off this view.** Its job was to fit N cards under 4096 by dropping the
  overflow behind `(+N more)` — so the one view that exists to stop a gate being missed was
  silently dropping gates at exactly the N where that matters.
* **The send loop tolerates failure.** A 429 mid-stack used to abort it, delivering the
  first K gates and no trailer — a partial inbox with nothing saying so. Each send is now
  caught, the run continues, `retry_after` is honoured and bounded, and the trailer reports
  what did not arrive. The trailer alone retries once: nothing else counts it.

The set-level trailer (hard-gate digest note, the DIVE-3224/3228 withheld count, the
bulk-clear affordance) is its own final message — those are statements about the SET, and
hanging them off the last card makes that one gate read as if they were about it.

Note the version bump: it is the DELIVERY, not bookkeeping. The install path is keyed on
this string, so #31 and #32 merged green and could reach nobody until it moved.

### Fixed — /task's "Needs you" stops listing the whole fleet's gates (DIVE-3267)

The other half of DIVE-3224, found by main while grading that merge. `/inbox` was one of
two surfaces:

    const needsYou = tasks.filter((t: any) => t.need_type)

with a comment above it in five of the six forks calling that presence *"a clean 'needs a
human' flag"*. It is not — `need_type` present means **has an unanswered gate**, and a
gate routed to an agent seat is one of those. So "🔔 Needs you" listed every open gate in
the fleet, rendered by `taskRow(t, true)` as act-on-me rows. lodar's complaint named
`/inbox` because that is the command he typed; the same noise was one command over, and
the false premise was written down above the line as the reason not to look.

**The fix partitions on the CLI's own verdict.** 5dive-cli DIVE-3267 exports
`needs_human` on `task ls --json` — the result of the single `human_gate` predicate in
`cmd_task_inbox`, not its inputs. `/task` reads the answer; it does not rebuild the rule,
and must not: that copy is what produced both defects, and the rule has grown a clause
since (DIVE-3228's routed-`access` case).

Deliberately **not** a second call to `task inbox --json` alongside the list call. Two
calls are two snapshots with a window between them — a gate answered in that window lands
a row in neither section or in both — and two round trips for one render.

Two details that carry the change:

- **The negated buckets moved with it.** `need_type` appeared three times in the base
  fork's partition (once positive, twice negated, for "Your tasks" and "Open tasks").
  Changing only the first would have dropped every agent-routed gate out of **all three**
  sections — excluded from "Needs you" by the new predicate and from the others by the
  old one — so a row belonging to an agent would have vanished from the board rather than
  moving sections. A worse bug than the one being fixed, and invisible to any test that
  only checks what "Needs you" now contains.
- **The fallback fails toward showing too much.** On a CLI predating the export the field
  is absent from every row, and the code reverts to the old `need_type` reading rather
  than treating absent as "not human", which would empty the section and hide the
  founder's own gates. The CLI guarantees the field is present and `0` (never omitted) on
  a non-human row, so absent-everywhere is an unambiguous version signal.

**SIX forks, not five** — `telegram-opencode` has no `/inbox` and no
`buildActionableInbox`, so it was correctly outside DIVE-3224's scope and is inside this
one. The counts differing is how the second surface was found: an over-broad grep for
`filter((t: any) => t.need_type)` rather than the precise form DIVE-3224 changed. A grep
scoped exactly to what you fixed cannot show you what you did not.

New `test/task-needs-human.test.ts` (26 arms across the six forks), including an arm
asserting the surviving `need_type` reads are all sourced from `j.data.inbox` — the CLI's
human view — so they narrow within the human set and cannot readmit an agent-routed gate.
Verified by positive control: reverting one fork's negated bucket to `!t.need_type` reds
B1 and the cross-fork shape arm. Suite 658 pass / 0 fail; `generate.ts --check` byte-exact.
Base plugin 0.5.45 -> **0.5.46**.

### Fixed — /inbox shows the founder HIS gates, not the whole fleet's (DIVE-3224)

lodar, 2026-08-11: *"what about 14 gates awaiting you … this still spams my inbox every
time I press /inbox"*, minutes after *"im frustrated some tech asks still go to human
instead of agent main"*. Two complaints, two separate defects, one symptom — this is the
display half.

Measured that morning: **12 gates listed, 3 of them his** (a CODEOWNER click, an npm
token, customer comms). The other 9 were routed to agent seats — dev, dev2, dev3, cli,
main2, quinn — and **each rendered a ✅ apply-the-recommendation button**. So the
surface was not merely noisy: it invited him to answer questions already addressed to
somebody else. DIVE-2093's gate was routed to main2 and still appeared, tappable.

`buildActionableInbox` shelled `5dive task ls --json` and kept every row carrying a
`need_type` — that is "has an unanswered gate", **not "needs a human"**. The CLI has
owned the difference since DIVE-3117 (a gate with `routed_reviewer` waits on an agent
seat) and grew a fourth clause in DIVE-3228 (a routed `access` gate its lead can now
clear). This plugin never called it; it kept its own copy, and the copy predated both.

The old comment is honest about why, and the reason was real: `task inbox --json` —
the view that applies that predicate — did not expose `tier`, which the ✅ button needs
to tell a soft gate from a hard one. CLI DIVE-3224 adds that one field, so `/inbox` now
reads `task inbox --json` and **the local filter is deleted rather than corrected**. A
second copy of a routing rule is what produced this bug.

Two smaller changes fall out of the new source:

- **An absent or unparseable `tier` now reads as 2**, matching the CLI view's own
  fail-safe. Such a gate keeps its card and gets a nonce-buttoned tap through the
  `inbox --send` digest instead of a plugin-minted ✅ it has not proved it may have.
  This is also what happens on a host whose CLI predates the `tier` export: every gate
  routes through the digest — fewer inline buttons, never an unreachable gate.
- **The withheld gates are counted, never listed** (`routed_elsewhere`, mirroring the
  CLI's own text render). Without it a filtered inbox and a fleet with no open gates
  read identically, which is the failure mode this bridge has been burned by before.

Applied to all five lineages (telegram, grok, agy, codex, pi); `generate.ts --check`
byte-exact. New `test/inbox-source.test.ts` locks the source and the fail-safe per
fork — server.ts long-polls on import, so this grades the text, in the style of
parity.test.ts. Base plugin 0.5.44 → **0.5.45** (claude agents load a versioned
marketplace cache; a fork edit deploys on restart).

### Fixed — the ✅ Done / 🚫 Cancel taps close the row again (DIVE-3206)

Reported 2026-08-11: tapping ⚠️ Confirm cancel on a `/task_<id>` card answered
"Couldn't cancel — open the dashboard." The dashboard was never the problem. Both taps
ran `5dive task done|cancel <id>` with **no `--result`**, and the CLI refuses a first
close that would leave the result column permanently blank (DIVE-2773) — a refusal that
says in its own text "No flag bypasses this". Every tap on every bridge had been failing.

Two defects, not one, and the second is the worse:

- **The baseline swallowed the reason.** A bare `catch` replaced the CLI's exact refusal
  with a generic line naming neither the cause nor the fix, and pointing at a surface
  that was working. `tapFailText()` now surfaces the refusal itself, clamped to
  Telegram's 200-char callback answer.
- **The forks reported a success that never happened.** `run5dive()` RESOLVES rather
  than rejects on a `--json` refusal (DIVE-2623), so `await run5dive([...])` inside a
  `try` never reached its `catch`: the tap said "✅ Marked done" while the row stayed
  open. The forks now read `.ok` and throw on a refusal. A try/catch around a call that
  cannot throw is not error handling, it only looks like it.

The reason a tap writes is not manufactured. A button has no text field, so `tapResult()`
records exactly what the tap establishes — a verified human closed this from the task
detail view, attributed to their Telegram id (DIVE-3178) — and states plainly that no
detail was captured. It is deliberately not `n/a`, which the CLI's own refusal text calls
out as the string that satisfies a non-empty check while recording nothing.

`test/task-tap-close-reason.test.ts` is the tripwire: it fails against the pre-fix source
(verified, not assumed) on all four claims, including that no bridge re-introduces the
placeholder reason or the bare dashboard nudge.

### Fixed — a channel-relayed tier-2 tap now NAMES the human who pressed it (DIVE-3178)

Every channel-relayed tier-2 gate clear on the fleet recorded `unattributed:<agent>` —
proven human and unattributable at the same time, which on inspection wears the exact
costume of an agent self-clear. Measured in the wild 2026-08-10 on DIVE-3150: lodar
tapped a tier-2 approval relayed through an agent's bot, `nonce_valid=1 enforce=on`, and
the row came back `unattributed:marketing`. It held a merge and cost him two questions.

The CLI was not the defect. DIVE-3128 shipped `--tap-uid` / `--tap-username` /
`--tap-msg` / `--relay-agent` and v0.19.15 is installed and parsing them. **Nothing sent
them.** So the CLI reached its human stamp holding only its own process identity — an
agent name — correctly refused to write `human:<agent>`, and had nothing to put in its
place. `tap_uid=none` in that audit line was the fix RECEIVING NOTHING.

`tapEvidenceArgs()` now forwards the tap context off Telegram's `callback_query` — an id
and a handle the relaying agent does not author — and the relay names ITSELF separately,
so the carrier lands in `need_answered_relay` instead of being what the `human:` prefix
attaches to. All six telegram bridges pass it. Fields are sanitised on the same grammars
`cmd_agent_teambot.sh` already uses and DROPPED individually when malformed, so a bad
field can neither reach a provenance column nor cost a good neighbour.

The lesson is larger than the row: **a fix spanning two artifacts is not landed when its
PR merges.** Two checks came back true — is the symbol on main, is it in the installed
binary — and both were insufficient, because the half that PRODUCES the data lives in an
artifact with its own release cadence. The question that works: what else has to ship for
this to work, and does it release on the same clock?

## v0.5.42

### Fixed — one CLI-read budget instead of a per-call-site guess, so /account stops flapping on slow boxes (DIVE-3088)

`/account` intermittently rendered "Failed to list accounts". `read5diveJson` gave
`account list --json` a 3000ms budget; on a slow VM that call measured ~3.12s, and on
timeout the child is killed BEFORE it prints — so `e.stdout` is empty and the DIVE-125
salvage-nonzero-exit path has nothing to salvage. Same error string as the bug DIVE-125
fixed, different failure mode.

Raising that one site would have fixed that one box. Measured on healthy hardware,
`agent list --json` (~2.07s, three call sites, all on 3000ms) sits NEARER its budget than
`account list --json` (~1.58s) — so on a box slower still, `agent list` breaches first or
alongside and `/account` keeps flapping.

The defect was the per-call-site number, not the value at any one site: 3000 here, 5000
there, 8000 for `task inbox`, each picked by eye against whatever box the author was on.
There is now a single `CLI_READ_MS = 8000` default — already the house value for the
heaviest reads — and a call site names a budget only when it needs a LARGER one (the auth
flows, which wait on a remote device-code round-trip). The cost of a generous budget falls
only on the failure path; the cost of a tight one falls on every user with a slow box.

The CLI-side fix that removes the ~3.1s itself ships separately (5dive-cli DIVE-3088:
110 → 22 jq spawns in `account list`).

### Fixed — the needs-you banner said nothing while suppressing itself fleet-wide (DIVE-2041)

`reconcileNeedsBanner` pins on ONE agent only, the resolved org coordinator (DIVE-1568);
every other agent unpins any banner it left behind. When `5dive task coordinator` resolves
to `''` — a chart with more than one root and nobody tagged — *every* agent takes the
non-coordinator branch, so the pin is removed from every paired DM and the 60s timer
re-asserts that forever. That was DIVE-2031: 12 pending human gates, no banner anywhere,
for days, with every component reporting success. The outage and the healthy case are the
same code path with a different fleet-wide precondition, which is why nothing local caught
it. It now logs an explicit `[needs-banner] SUPPRESSED FLEET-WIDE` line naming the cause,
the fix and the check — rate-limited to one an hour, and the timer resets when a
coordinator resolves again so a fresh outage is loud on its first tick. The fleet-level
witness is `5dive doctor --category=channels` (CLI side), which computes the resolution
itself rather than asking a bot that may be down.

### Fixed — `summarizeNeeds` counted an answered secret gate as pending (DIVE-2041)

The banner filter keyed on `need_answer` (the answer TEXT) while the CLI and dashboard key
on `need_answered_at`. An answered **secret** gate keeps `need_answer` NULL by design — the
value is the secret and is never written to the row — so a whole gate type read as pending
forever. Harmless through today's only caller, which feeds it `task inbox --json` whose SQL
already excludes answered rows; that made the module's correctness a property of a query
two processes away. Now keyed on `need_answered_at` (with `need_answer` kept as a
belt-and-braces disjunct, which can only ever exclude more). `buildInboxList` in every
server.ts is corrected the same way, so the "mirror buildInboxList EXACTLY" contract is a
mirror again rather than a shared defect.

Bumps 0.5.41 -> 0.5.42.

## v0.5.41

### Fixed — the reply-to-clear handler no longer eats conversation about an open gate (DIVE-2818)

0.5.37 shipped the reply-to-clear handler (below) with typing as the EXPECTED way to answer a
high-stakes gate. Hours later, having used both paths on live gates, lodar said the opposite:
*"but asking user to type is not good ux"*. The row was re-scoped — **tap is primary on every gate,
this typed path is the RECOVERY path** — and that demotion inverts one call in the handler.

While typing was expected, a `DIVE-N <anything>` aimed at an open gate was probably a fumbled
answer, so replying with the exact format was a kindness. Once nobody is expected to type,
`DIVE-2818 whats the holdup` is **conversation**, and 0.5.37 answered it with a format lecture and
never relayed it to the agent. On the human's primary channel, that is a message deleted to service
a gate nobody meant to answer.

`resolveGateReply` now falls through unless the aim is unambiguous — the value agrees with an
allowed answer for at least 3 leading characters, is one typo away from one, or the message is a
`reply_to` the gate's own alert (the condition DIVE-145 already uses). Everything else returns the
new `chatter` resolution and relays as normal chat. No synonym table: `no` still does not resolve to
`denied`, because guessing at meaning on a rail whose whole value is the human's literal words is
the wrong place to be clever.

**Now DM-only.** The block had no chat-type guard, so it also ran in the #5dive supergroup, where
idents are discussed all day. This was strictly worse than doing nothing: `_gate_channel_proof_ok`
matches the chat id against `^[0-9]+$` and a Telegram group id is negative, so a group citation can
never attest — a valid `DIVE-N done` there shelled `task answer`, was refused for a reason the copy
could not explain, and consumed the message on the way. `server.ts` short-circuits on the same
boolean before it spends a `task show` subprocess.

One deliberate exception, stated rather than hidden: a **secret** gate still intercepts on TYPE
rather than on aim. The live risk there is a human having just pasted a credential into permanent
chat history, and saying so immediately is worth more than protecting a conversation we might be
interrupting. The refusal never echoes what they sent.

**No security property moved.** Narrowing *when* we listen loosens nothing about *what* we require:
condition (2) still needs the ident in the human's own words, no value is ever coerced, and nothing
composes that string on their behalf. A message we decline to claim is merely relayed as chat.

Tests: `test/gatereply.test.ts` 21 → 39 arms. The two that were missing are why 0.5.37 shipped
green — the old suite only covered fall-through for CLOSED and MISSING gates, never for an OPEN one,
and had no group arm at all. `GateReplyContext` is a required parameter so a caller that forgets it
fails to compile rather than silently re-enabling the group path. Full suite 446 pass / 0 fail,
`generator --check` byte-exact.

## v0.5.40

### Fixed — a failed gate tap discarded the exception and named the wrong task (DIVE-2846)

The `tna:` tap handler caught its failures with a bare `catch {`. Five plausible
causes were named in a comment and not one of them was kept anywhere: nothing
logged, and the plugin has no journal to fall back on, so when two of lodar's
tier-2 gate taps reported "Couldn't apply" on 2026-08-06 the reason was
unrecoverable after the fact. The fallback also printed `DIVE-<internal id>` —
the callback carries the numeric row id, not the ident, so the message named a
task that either does not exist or, worse, is a different real row (id 2846 is
DIVE-2659). And it asserted the tap had failed without ever checking.

Now, on any tap failure: the exception is classified (timeout / sudo refused /
the CLI's own refusal text / missing binary / unreadable output) and written
both to stderr and to a bounded `tap-failures.jsonl` under the plugin state dir;
the gate is RE-READ, so the human is told whether it applied, is still open, or
could not be confirmed — three different messages, where there used to be one
unproven claim; and the prose names the real ident, falling back to `task #<id>`
rather than minting an ident-shaped string. The numeric id still appears in the
on-box command, which is what `task answer` takes.

Classification, landing and copy are pure functions in `tna.ts` (byte-identical
across base and all five forks, pinned by the tna harness against error shapes
measured off the real CLI); every `server.ts` is the thin adapter, and CI now
fails any plugin whose tap catch does not bind its exception. Bumps 0.5.39 -> 0.5.40.


## v0.5.39

### Fixed — BotFather command menu shrinks after a slow startup (menu-robustness)

At startup each bot registers its BotFather command menu once via `setMyCommands`,
gated on a `read5diveVersion()` probe of `5dive --version` (2s timeout). Under
transient startup load — several agents booting at once — that probe can exceed 2s
and return null, so `botFatherCommands` drops every `paired-5dive`-scoped command
(~15 of them) and the bot registers a permanently reduced menu that never re-runs
until restart. `/help` was unaffected because it re-probes 5dive live on every call,
which is why the menu and `/help` disagreed. Now the startup probe is retried (twice,
3s apart) before concluding 5dive is absent, so a slow boot no longer leaves a
truncated menu stuck. The retry only fires on a miss and only blocks the
fire-and-forget menu registration, not polling.

## v0.5.38

### Fixed — /tasks, /inbox, /needs crash with "stdout maxBuffer length exceeded" (DIVE-2875)

Node's `execFile` caps captured stdout at 1 MiB by default. The host-shared task queue
crossed that as JSON (`5dive task ls --json` is ~1.04 MiB and growing), so every queue-listing
surface — `/tasks`, `/inbox`, `/needs` — threw `stdout maxBuffer length exceeded` and rendered
nothing. The three direct `execFileP` call sites and the shared `read5diveJson` helper all
inherited the default. Raised a module-level `JSON_MAXBUFFER = 16 MiB` and applied it to the
queue-listing reads; 16 MiB is a sane ceiling that forces the CLI to paginate rather than the
plugin to keep lifting the limit.

## v0.5.37

### Added — reply-to-clear: a gate answer the filing agent cannot forge (DIVE-2818)

*(Entry added retroactively in 0.5.40; the 0.5.37 release bumped the manifest only.)*

`--channel-msg` cites the id of the human's OWN message and lets the CLI re-check authorship with
Telegram, which is the one party a filing agent cannot speak for. It shipped, it verified, and it
had **zero callers** — 0 of 94 deployed `tna.ts` emit the flag (DIVE-2799) — so the weak nonce path
was the only reachable one. That is what allowed a real clear to record
`answered_by=human:olivia uid=1011`, the filer's own uid (DIVE-2802).

New `plugins/telegram/gatereply.ts` holds the whole decision matrix as a pure, import-safe module
(server.ts long-polls on import, so a test that imports it boots a bot — the DIVE-369 reason tna.ts
was extracted). A DM of the form `DIVE-N <value>` resolves against the LIVE gate, and is answered by
citing that very message: `--channel-proof` names the verified DM, `--channel-msg` names the
message. No `--human` is passed — the citation is the evidence and the CLI raises `human=1` itself
once it attests; if it does not attest, `task answer` fails closed rather than degrading to the
weaker form. Values are strict per gate type (`approved|denied`, `done`, `provided`, or the gate's
own `need_options`), because condition 5 requires the human's text to CONTAIN the value we pass, so
coercing `approve` to `approved` would buy a refusal they would read as a broken feature.


## v0.5.36

### Fixed — /model picker resolves against the CLI's model catalogue, + fable (DIVE-1883)

`MODEL_ALIASES` was a hand-maintained copy of the same alias→id map the 5dive CLI keeps for
agent-create, and the two had drifted apart: the plugin pinned `opus` to `claude-opus-4-7` while
the CLI pinned `claude-opus-4-8`, so `/model opus` over Telegram and `5dive compose` handed you
different models. Both were stale — `claude-opus-5` appeared in neither.

The CLI now owns a single source of truth (`src/lib/models.sh`, exposed as `5dive models --json`).
At boot the plugin calls `refreshModelAliases()`, which fetches that map and hands it to a new pure
`applyModelAliases()` in `commands.ts` that replaces `MODEL_ALIASES` in place. Every read of the map
happens inside a handler, well after boot, so no call site changed. It tries the bare binary before
`sudo` — `models` reads no state, and a standard agent's sudoers grant is scoped to
`_deliver`/`_capture`/`_audit_append`, so the sudo path alone would strand those agents.

Fail-closed throughout: a missing CLI (upstream host), an older CLI without `models`, or a
malformed payload leaves the baked defaults standing rather than emptying the picker; non-string
rows are dropped individually. An alias the CLI knows and the plugin does not is added, so a newly
mapped family appears in the picker without a plugin release.

The baked defaults are now current and gain `fable` and `haiku`: opus `claude-opus-5`, sonnet
`claude-sonnet-5`, fable `claude-fable-5`, haiku `claude-haiku-4-5-20251001`. `telegram-pi`'s
`/model` help line also stopped advertising `anthropic/claude-sonnet-4-5` as its example.

Tests: `test/model-aliases.test.ts` — 7 cases covering the baked map (full ids only, never a bare
alias, which Claude Code's startup migration strips on a fresh config dir per DIVE-506), replace-not-
merge semantics, unknown-family adoption, fail-closed on null/empty/array/string/number payloads, and
per-row rejection of non-string ids. Full suite 330 pass / 0 fail.

## v0.5.29

### Added — council human-as-seat ballot tap handler (DIVE-1566)

The final sub-task (4/4) of DIVE-1548 human-as-seat voting. When a council seat is held by a human,
the CLI dispatch (DIVE-1564) emits a blind ballot message with Approve/Reject/Abstain buttons whose
`callback_data` is `cvote:<ballot-ref>:<a|r|e>:<nonce>` — the one-time DIVE-916 nonce rides ONLY in
the button (the ballot task body stores just its sha256 digest, the text is blind). This adds the
plugin half that makes those buttons live: a `parseCvoteTap` pure parser in `council.ts` (length +
charset anchored, fits Telegram's 64-byte cap without prefixing since ref≤12 + nonce=32) and a
`callback_query` handler in `server.ts` that mirrors the shipped DIVE-1546 founder-veto tap —
private-chat-only + allowFrom-vetted, shells `sudo 5dive council ballot-tap --ref --vote --nonce`
(the DIVE-1565 bridge, which prefix-accepts the unique open ballot, verifies the nonce against the
stored digest fail-closed, and closes that same CNCL-18 ballot task with the COUNCIL-VOTE line the
convener already polls — no second write path), then edits the message to a nonce-free confirmation
and strips the keyboard so a one-time nonce can't be re-tapped. Fully fail-soft; the raw nonce is
never echoed back. Inert until a `cvote:` button is delivered. Baseline `telegram` only — the
fork-parity port to telegram-{grok,agy,codex,pi} follows the DIVE-1371/1558 pattern (same deferral as
the DIVE-1546 veto tap, which is also baseline-only).

## v0.5.28

### Changed — /inbox renders inline tap-to-clear buttons where the banner points (DIVE-1572)

The DIVE-1568 needs-you banner tells the founder to "tap /inbox to review and clear it," but /inbox
only shelled the DIVE-1499 send-verb to DM a *separate* tap-button digest — the buttons weren't where
the banner pointed. Now /inbox renders an actionable reply IN PLACE: each pending tier<2 gate that has
a recommendation gets a one-tap `✅ <ident>: <rec>` button that applies the rec via the DIVE-1305
`clear-recs --channel-proof` rail (the allowFrom-vetted sender id is the human proof — re-enforced
CLI-side, tier<2 only; no DIVE-916 nonce needed). Tapping clears the gate in place and rebuilds the
list so the button drops. tier-2 hard gates (money/secret/destructive/brand) can't be button-minted
in-plugin (the nonce isn't derivable — the DIVE-950 hole), so those still fire the `--send` nonce
digest, noted inline. Sourced from `task ls --json` (which exposes `tier` + `recommend`, unlike the
`task inbox --json` view). Ported across canonical `telegram` + `telegram-{grok,agy,codex,pi}`.

## v0.5.27

### Changed — scope the needs-you banner to the org coordinator (DIVE-1568)

The DIVE-1503/1558 pinned "needs-you" banner reconciled + pinned in EVERY paired agent's DM (base
plus every fork), so the founder got the SAME open-gate reminder pinned across N DMs. The banner now
pins on exactly ONE agent: the resolved org coordinator. Each `server.ts` `reconcileNeedsBanner`
first resolves the coordinator via the new read-only `5dive task coordinator --json` verb (DIVE-333
`_task_resolve_coordinator`: the sole `role='coordinator'`, else the lone org root, else empty).
Unless the resolved coordinator equals this agent, it never pins and unpins any banner it left
behind; an empty/ambiguous org resolves to nobody (fail-quiet, no bare-box spam); a lookup error
skips the tick so a live pin never flickers. `banner.ts` is untouched (stays byte-identical across
all forks). New `test/banner.test.ts` tripwire asserts the gate is present in base + all 5 forks so
a fork can never silently drop it. Applies to base `telegram` + grok/codex/agy/pi/opencode
(agy regenerated from the grok base). Generalizes to customer boxes: each box's org defines its
coordinator. Requires 5dive CLI >= 0.11.35 (the `task coordinator` verb).

## v0.5.26

### Added — needs-you banner fork parity + relay-mode decision (DIVE-1558)

Propagated the DIVE-1503 pinned "needs-you" banner from canonical `telegram` to every poll-based
fork: `telegram-grok` (the generator BASE, hand-edited), `telegram-agy` (regenerated), and
`telegram-codex` / `telegram-pi` / `telegram-opencode` (hand-edited). Each imports
`plugins/telegram/banner.ts` byte-identical (the `test/banner.test.ts` fork-parity tripwire now arms
across all five) and runs the same 60s reconcile in `server.ts`, adapted to each fork's helpers
(`read5diveInfo` host-gate, `run5dive` inbox read, grammy `bot.api` pin/edit/unpin). The generator
now copies `banner.ts` verbatim (added to `COPY_FILES`, exempt from token subs like `tna.ts`) so
codex/agy can never drift; `banner.ts`'s self-reference comment was reworded off the literal
`telegram-grok` token so the generator's stray-token lint stays clean.

Relay mode (SEND_ONLY): decided (with Marcus) to keep the banner OFF under one shared team-bot — a
proactive per-agent timer would pin N banners into the one owner DM (DIVE-249), and relay users
already have the on-demand `/inbox` digest. So the fork banner is gated `!SEND_ONLY` exactly like v1
(pi is polling-only in its lineage, so it arms unconditionally). A listener-aggregated single
consolidated pin is tracked as a follow-up only if relay users report missed gates.

Versions: telegram 0.5.26, grok/codex/agy 0.5.13, pi 0.1.4, opencode 0.5.6.

## v0.5.25

### Added — pinned self-updating "needs-you" banner: a pending gate can never scroll out of sight (DIVE-1503)

The bot now keeps ONE pinned message per paired DM that always reflects the current human-gate
backlog: it pins the banner when the first gate opens, edits it in place as gates open and clear
(`N gate(s) need you, oldest <age> old. Tap /inbox to review and clear them.`), and unpins it at
zero (editing the old message to "All caught up"). A pinned message survives scroll, so a gate can
no longer fall off the bottom of the chat unseen — the 3rd recurrence of that class after DIVE-1428
/ DIVE-1489.

A slow reconcile (60s) reads `5dive task inbox --json`, mirrors buildInboxList's pending filter,
and drives a pure state machine in `plugins/telegram/banner.ts` (`summarizeNeeds` / `reconcileBanner`
/ `formatNeedsBanner`). It is 5dive-only and armed in personal-bot/polled mode (the SEND_ONLY
shared-team-bot banner, with its per-agent dedup, rides with the fork follow-up). Edits
fire only when the backlog size, the oldest gate, or its coarse age label changes — no per-tick edit
storm (the DIVE-1107 lesson) — and a read error never unpins a live backlog. Per-DM `{messageId,
fingerprint}` is persisted in `needs-banner.json`; a user-deleted pin is detected and re-sent next tick.

banner.ts is pure + import-safe (server.ts long-polls on import), unit-tested end-to-end in
`test/banner.test.ts` with a present-only fork-parity tripwire. Canonical `telegram` only this pass;
fork propagation (grok base → generator regen codex/agy → hand-edit pi/opencode) is the split
follow-up.

## v0.5.24

### Added — founder-veto TAP handler: authenticated one-tap veto from the founder's DM (DIVE-1494 #2, plugin half)

The callback router now handles a `veto:<receiptPrefix>:<nonce>` tap — the authenticated
founder-veto button that pairs with the council-source rail B (`_council_veto_ping` →
`_tg_veto_offer`, 5dive-cli). The one-time nonce rides ONLY in the tapped `callback_data`
(the council source never prints it to chat) and the button is delivered founder-chat-only;
tapping shells `sudo 5dive council veto exercise --receipt=<prefix> --nonce=<nonce>`. The
NONCE is the authentication (the CLI refuses an unauthenticated exercise, and only the
founder ever received it); defense in depth adds the router's `allowFrom` gate plus a
private-chat requirement (a veto button must never live in a group). The nonce is never
echoed back — on success the message is edited to a nonce-free confirmation and the keyboard
stripped so a one-time nonce can't be re-tapped. Fully fail-soft (a closed window / already-
resolved / bad nonce acks softly).

Telegram caps `callback_data` at 64 bytes; a full base64url sealed digest (43) + nonce (32)
is 81, so the button carries a unique receipt PREFIX (the CLI resolves it, fail-closed on
miss/ambiguity). Pure parse logic in `plugins/telegram/council.ts` (`parseVetoTap` / `VETO_RE`),
unit-tested in `test/council.test.ts` (rejects malformed/truncated/non-hex payloads, confirms
the read-only `cl:*` verbs are never mistaken for a veto, asserts the prefix form fits 64 bytes).
Baseline-first (claude plugin); the forks track it in a follow-up parity port.

## v0.5.23

### Added — /council: read-only Council view over the sealed governance record (DIVE-1494 #3)

`/council` renders the Council roster (seats + chair, the pass threshold + quorum,
the founder-veto holder, and the sealed lineage head) and carries three tappable
buttons for the tamper-evident record: 📜 Log (recent sealed verdicts), 🔗 Lineage
(the hash-chain summary), and ✅ Verify (the integrity check, green or fail-closed
with the failing leg named). Sourced read-only via `sudo 5dive council
{roster,log,lineage ls,verify} --json`. Everything here is READ-ONLY: the buttons
carry a static verb in `callback_data` with no nonce and no mutation. The
authenticated founder-veto TAP (which must carry a one-time nonce inside the
callback) is a separate path, DIVE-1546.

Pure formatting lives in `plugins/telegram/council.ts`, unit-tested headless in
`test/council.test.ts` (12 cases, incl. a read-only-safety assertion that no
button `callback_data` can carry a long-hex nonce, and that the resolved veto
recipient id never renders). Baseline-first (claude plugin), like `/digest`; the
wait_for_message forks track it in a follow-up parity port.

## v0.5.19

### Added — /inbox lists pending human gates, with one-reply quick-clear (DIVE-1334 / DIVE-1356)

`/inbox` renders one compact card per PENDING human gate from `5dive task inbox`
so the paired human never misses one: ident, type, the ⭐ recommendation, options,
an ask snippet, and a tappable `/task_<id>` deep link. Empty inbox reads
`No pending gates 🎉`. Sourced read-only via `sudo 5dive task inbox --json`,
`paired-5dive`-scoped so it hides and no-ops on non-5dive hosts.

Ships together with the DIVE-1305 channel-proof bulk-clear handler (now unblocked:
clear-recs is live in CLI 0.9.23): replying "go with recs" / "approve all" in the
paired DM applies each tier<2 gate's `--recommend`, and "approve DIVE-N" clears one.
The paired-DM sender IS the human proof (re-verified against access.json via
`--channel-proof`). Tier-2 hard gates (money/secret/destructive/brand) keep their
per-gate Approve/Deny button tap.

## v0.5.18

### Fixed — auto-resume prompt gates its "reply to the latest message" clause on a real unanswered inbound (DIVE-1332)

The three Telegram resume paths (usage-limit reset, transient API error, account
rotation) all typed the hardcoded string "continue and reply to the latest
message" into claude on recovery, even when the interrupted turn was autonomous
work with NO pending DM. With no message to answer, the model escalated hunting
for a referent — the phantom-prompt bug diagnosed in DIVE-1316, which hit
community and olivia on 2026-07-16 (driven by the blind-resume retry loop,
independent of heartbeat interval).

- New shared `resumePrompt()` helper (`hooks/lib/resume-prompt.ts`) reads the
  silence state the plugin already tracks: it returns "continue and reply to the
  latest message" only when `lastInboundAt > lastReplyAt` (a genuine unanswered
  message), else a bare "continue".
- Applied at all three sites: `resume-after-reset.ts`, `resume-after-error.ts`,
  and `stopfailure-notify.ts` (the `resume-next` marker line 2).
- Covered by `test/resume-prompt.test.ts` (empty inbox, already-replied, equal
  stamps, and genuine-unanswered cases). Claude-Code-only hooks — forks
  unaffected; generator parity stays green.

### Fixed — telegram taps record human provenance on every gate type, not just hard gates (DIVE-1115)

A Telegram button tap on a `decision` (and `manual`) gate recorded a bare AGENT
name in `need_answered_by` instead of `human:<actor>`. The tap handler only
appended `--human` when the gate was `approval`/`secret`/`manual`, so decision
taps fell through with no provenance mark. Two consequences: (1) the digest's
zero-human KPI counts only `human:*` provenance, so real human taps (e.g. lodar
answering a tier-2 gate) were INVISIBLE — undercounting human touches and
overstating autonomy on the public badge; (2) tier-2 answers were unprovable as
human.

- Every verified-human tap now marks `--human`. `allowFrom` has already vetted
  the tapper as an allow-listed human upstream, so the gate type is irrelevant to
  provenance. `--human-proof` (the per-gate nonce) still rides along only for
  hard gates that mint one.
- Extracted the decision into a pure `tapEvidenceArgs()` in `tna.ts` (shared,
  byte-identical across base + grok/codex/agy) and covered it in the tna harness.
- Caught a latent drift: `telegram-agy` still gated `--human` on
  approval/secret/manual and would have kept recording bare-agent decision taps.

Historical `need_answered_by` rows are left intact (audit trail). Affected idents
observed pre-fix: OSS-16 (task 1152), DIVE-1099.

## v0.5.16

### Fixed — resume-helper spawn storm: gate the spawn (not just the DM) per episode (DIVE-1107)

agent-marketing spammed ~100 "Usage limit reset — agent resumed." banners into
its topic in ~20 min. One claude process, NO systemd respawn: a BYO/OpenRouter
profile whose limit isn't tagged `error==='rate_limit'` made the resume helper's
`resumedSince()` false-positive, so it declared a resume, fired the Phase-4
banner, released the resume.lock, and exited. claude was still limited, re-stopped
immediately, and the re-fired StopFailure hook re-acquired the FREED lock and
spawned another helper -> another banner. The resume.lock only serializes
CONCURRENT helpers; it never stopped this rapid SEQUENTIAL re-trigger. The
per-episode `claimNotify` dedup already capped the DM to one, but the helper
SPAWN was ungated.

- Gate the helper spawn on the same `shouldSend` per-episode stamp as the DM
  (30-min sliding window, exit- and concurrency-independent). One episode now
  yields one recovery chain + one banner. When suppressed, the lock we acquired
  is released so it can't block the next genuine episode. Anthropic-limit agents
  are unaffected — they get a real reset epoch and wait parked on the menu, so
  the spawn gate is never exercised; only no-epoch BYO false-resume loops were
  storming. Tradeoff: a second genuine limit within the window is not
  auto-resumed and stays parked until the window clears.
- Prune `resume-*.log` on spawn (`pruneOldResumeLogs`, 3-day retention). The dir
  was never pruned and had grown unbounded fleet-wide (community 10k+, main 7k+).
- Base plugin only; forks share this hook path via generator parity. Regression
  coverage in `hooks/lib/notify-dedup.test.ts` (rapid re-trigger -> 1 send;
  new-episode-after-window -> re-send; log prune keeps recent).

# Changes from upstream

Tracks the diff between `plugins/telegram/` and upstream
`anthropics/claude-plugins-official/external_plugins/telegram/`.

## v0.5.15

### Changed — /tasks pins the calling agent's own tasks on top

`/tasks` now renders three sections top-to-bottom: **⭐ Your tasks** (the calling
agent's own unblocked, non-gated rows), then **🔔 Needs you** (human-gated), then
the open list. Previously an agent's own queued/active tasks were scattered
mid-list and easy to lose (e.g. main's two queued tasks). `buildTaskList`
partitions into three disjoint buckets keyed off `taskAssignedToMe` +
`status !== 'blocked'`; blocked-mine rows stay in the open list.

## v0.5.11

### Fixed — transient-API-error DM storm: dedup every StopFailure kind, not just usage limits (DIVE-902)
_(commit 0198c81's message mislabels this DIVE-901; the tracking task is DIVE-902.)_

A sustained transient API error (Overloaded / "temporarily limiting requests")
under the systemd respawn loop fired ~550 identical "Transient API throttle …"
DMs at one user in a ~4-minute window. Two independent respawn-storm vectors:

1. **Opening DM sent unconditionally.** The DIVE-122 respawn-surviving notify
   stamp gated ONLY the usage-limit path; the transient-error and generic-stop
   paths re-DMed on every respawn. Now every DM path claims a helper-independent
   stamp keyed by episode KIND (`ratelimit` | `transient` | `stop`), so any one
   kind's storm collapses to one DM per cooldown window while a genuinely
   different kind still notifies.
2. **Non-exclusive stale-lock reclaim.** `tryAcquireResumeLock`'s stale-reclaim
   used a plain `'w'` open, so a thundering herd of queued StopFailures all
   passed the staleness check and all re-created the lock → all spawned a resume
   helper (observed: 520 helpers, each firing an end-ping). Reclaim is now
   unlink-then-`O_EXCL`, single-winner.

Base plugin only — the grok/codex/agy forks use the `notify-stop.ts` path and
carry no `stopfailure-notify.ts`/resume-helper code, so no fork port. Regression
coverage added in `test/stopfailure-hook.smoke.test.ts` (transient storm → 1
SEND; distinct kinds each SEND).

## v0.5.2

### Added — Escalate button on the `/task_<id>` detail view (DIVE-449)
The single-task detail (`/task_<id>`) now carries an inline 🔺 Escalate button
for open tasks. A tap runs `5dive task escalate` (semantics A, Mark's call):
flag for attention — bump priority a tier (cap urgent) + ping the owning agent
and the paired human. Mirrors the `tna:` tap-to-answer flow: re-gated sender,
fail-soft, the button drops after one tap (re-open `/task_<id>` to go high →
urgent). Ported across base + all forks (grok/codex/agy via generator parity,
opencode hand-fork SSE arch). Lockstep version bump 0.5.1 → 0.5.2.

## v0.4.79

### Added — Claude Fable 5 in the /model picker (DIVE-212)
`fable` (→ `claude-fable-5`) is now a selectable tier in `/model`, alongside
opus and sonnet. Opt-in only — no agent's configured model changes. The picker
keyboard, callback router, and write path are all generic over `MODEL_ALIASES`,
so the one-line alias addition lights up the button automatically.

## v0.4.78

### Added — per-topic gating for team groups (DIVE-159)
`GroupPolicy.message_thread_id`: when a group access entry is bound to a forum
topic, the agent only responds IN that topic and drops messages from other
topics / the General channel. Lets one agent's bot live in a multi-agent team
group (topic per agent) and speak only in its own lane, replying without an
@mention.

## v0.4.75

### Changed — carryover nudge: "Clear now" + "Remember & clear" (DIVE-180)

- The context carry-over nudge now offers three full-width buttons instead of the
  vague "Carry over / Not yet": **Clear now** (`/clear` immediately, no save — lose
  this session's context), **Remember & clear** (save a structured carryover, then
  `/clear`), and **Not yet** (dismiss).
- "Remember & clear" chains the reset safely: after dispatching
  `/telegram:carryover`, the server waits for the carryover file to actually land
  in memory (`newestCarryoverMtime`), then for the turn to settle (pane stable),
  and only THEN sends `/clear`. The fresh session auto-reloads the carryover from
  memory, so continuity holds without a heavier full restart (Mark's call: light
  `/clear` over restart). Bounded + best-effort: if the save never lands we leave
  the context alone.

## v0.4.74

### Changed — /task hidden from menu + /agents status dots

- `/task` is now `hidden: true` in the command registry — removed from the
  BotFather featured menu (the bare verb read confusingly next to `/tasks`). The
  command still works fully: `/task add <title>` creates as before; only the menu
  entry is gone. Parity golden baseline menu updated to match.
- `/agents` now shows each agent's status as a round color dot instead of the
  word — 🟢 active / ⚪ otherwise — for a faster scan.

## v0.4.73

### Added — ToS warning on the auto-rotate menu

- The `/account` rotation submenu body now appends an experimental / use-at-
  your-own-risk warning: rotating between Anthropic accounts on a usage limit
  may conflict with Anthropic's usage terms, and the user is responsible for
  complying with their account provider's terms. Mirrors the same copy added to
  the dashboard Auto-rotate toggle (app repo). Shifts compliance responsibility
  to the operator for an OSS CLI feature.

## v0.4.72

### Fixed — access.json read errors no longer wipe the allowlist (DIVE-159)

- `readAccessFile` treated EVERY non-ENOENT error as corrupt JSON: it renamed
  the file aside (`.corrupt-<ts>`) and fell back to EMPTY access, which silently
  denies every chat ("not allowlisted"). A filesystem READ error (EACCES from a
  root-owned edit, a mid-write rename race, a transient IO hiccup) is NOT
  corruption — the allowlist is valid, just momentarily unreadable.
- Now: ENOENT → fresh default (unchanged); an fs read error (has an errno code)
  → preserve the file and THROW a clear "cannot read access.json (CODE) — check
  ownership/permissions" instead of empty-denying; only a genuine JSON parse
  error (no errno) moves the file aside. Prevents data loss + the misleading
  "not allowlisted" on a permissions glitch.
- Surfaced by the team-bot dogfood: a `sudo` root edit of an agent's access.json
  made it unreadable to the agent user → wiped allowlist → dead sends. Fix the
  edit path (use `5dive agent telegram-access set`) AND harden the reader.

## v0.4.71

### Added — team-bot send-only mode + relay-in inbound (DIVE-159)

- Opt-in team-bot membership: with `TELEGRAM_SEND_ONLY=1` the plugin sends via a
  shared team-bot token (its own topic via `message_thread_id`) but NEVER polls
  getUpdates — the single team-bot listener is the sole consumer of that token, so
  N agents can share one bot without fighting over Telegram's one-getUpdates-per-
  token slot (a second poller = 409 = dead channel).
- Structural no-poll guard: in send-only mode `bot.start()` is never invoked, and
  the PID-slot takeover + `checkApprovals` are skipped (listener-only concerns).
- Inbound arrives as atomic JSON file-drops in `<state>/relay-in/` (dir-poll,
  oldest-first, id-dedup, ack-by-delete), emitted to the agent as the standard
  `<channel … message_thread_id=…>` notification — reusing the existing deliver
  path. Replies go back into the agent's own topic via the team token.
- Fully opt-in: with `TELEGRAM_SEND_ONLY` unset, behavior is byte-for-byte the old
  per-agent bot — provisioning never requires a team token.

## v0.4.70

### Added — bot-to-bot loop + rate guards (DIVE-162)

- Mandatory backend safety layer before any cross-box auto-reply ships. Bot API
  10.0 lets bots see and reply to each other; two auto-replying bots in one group
  would otherwise ping-pong forever, and a chatty mesh blows Telegram's
  ~20-msg/min/group cap.
- `gate()` now branches on `from.is_bot` **before** the normal allowlist/pairing
  path, so a bot sender can never trigger a pairing code or a DM auto-reply.
- New `botToBot` access config (`enabled`, `allowFrom`, `maxPerMin`,
  `dedupeWindowMs`). **Default-deny**: with no config, every bot-sender message is
  dropped. When enabled, a bot must still be allowlisted for its chat, and passes
  only within dedupe (identical chat+sender+text inside the window = loop echo)
  and a per-group rolling-minute rate cap (default 12/min, the circuit breaker).
- Guard logic lives in a pure, dependency-free `botguard.ts` so it's unit-tested
  without booting the long-polling server (`test/botguard.test.ts`, incl.
  ping-pong simulations). Forks (codex/grok/agy) can adopt it when cross-box
  auto-reply lands there.

## v0.4.67

### Added — reply to a button-less gate alert to answer it (DIVE-145)

- A `🙋 [DIVE-N] needs you` alert for a **manual** gate carries no tap buttons
  (only decision/approval do), so answering used to mean a dashboard trip. Now
  replying to the alert in Telegram with the answer text clears the gate: the
  inbound handler detects a reply whose replied-to message is one of our own
  gate alerts, extracts `DIVE-N`, and runs `5dive task answer DIVE-N --value=<reply>`,
  then the CLI pings the owning agent to resume (same path as the `tna:` buttons).
- **Carve-out:** `secret` gates are **never** answerable over chat — the raw
  value would persist in Telegram history and we deliberately never store
  secrets in the task db. A reply to a secret gate gets redirected to the
  out-of-band `5dive task answer DIVE-N` (no `--value`) flow instead.
- Source of truth is the **live** gate (re-read via `task show`), never the
  alert text, so a dashboard/CLI answer landing between alert and reply can't
  double-answer. decision/approval replies are nudged toward their buttons.
  Fully fail-soft: any miss replies a one-line nudge and never leaks the reply
  into the agent's chat stream.

## v0.4.66

### Fixed — /account "Failed to list accounts" when the CLI exits nonzero (DIVE-125)

- The `/account` menu read `5dive account list --json` (and agent-list /
  usage / rotation) via raw `execFileP`, which **rejects on any nonzero exit
  and discards stdout**. On some boxes a stray stderr warning flips the CLI's
  exit code even though it wrote a valid `{ok,data}` envelope to stdout — so the
  plugin threw the good data away and surfaced "Failed to list accounts. Try:
  sudo 5dive account list", despite the CLI working. The four readers now go
  through a shared `read5diveJson()` helper that **parses stdout regardless of
  exit code** (the envelope's `ok` flag is the real success signal), giving up
  only when there's no valid JSON — matching the tolerant `run5dive()` the
  codex/grok/agy variants already use.

## v0.4.40

### Added — auto-resume on transient API errors

- **`hooks/resume-after-error.ts`** — new detached recovery helper for
  transient API failures (Overloaded / 5xx). When claude exhausts its built-in
  retries on an overloaded response it aborts the turn and drops to an idle
  prompt; the `while true; claude; done` agent loop only restarts on process
  *exit*, so the still-running-but-idle session used to sit there until a human
  nudged it. `stopfailure-notify.ts` now detects these (distinct from a usage
  limit) and forks this helper to type `continue` with growing backoff
  (`20/45/90/150s`, 4 tries), verifying via the transcript that claude actually
  picked back up. Shares the per-agent resume lock with the rate-limit flow so
  only one helper drives the pane at a time.

### Fixed — StopFailure notify fanned out to all chats on autonomous turns

- On a turn with no Telegram inbound (cron / long-running background agent),
  the StopFailure notifier fell back to *every* allowed chat — both paired DMs
  and the supergroup's General channel — instead of the agent's bound forum
  topic. Added `getGroupTopics()` (access.ts) and switched the autonomous-turn
  fallback to route into the configured group topic(s) (`message_thread_id`),
  so an agent's failure alert lands in its own thread. Falls back to all chats
  only when no group is configured.

## v0.1.1

### Added — bot slash commands

- **`/help`** — full command listing (replaces upstream's two-line version).
- **`/status`** — pairing line **plus** session health for paired senders:
  uptime, model, last activity, cwd, claude version (read from
  `~/.claude/sessions/<pid>.json`), plugin version, and the host's
  `5dive` CLI version when the binary is on PATH. Pairing-only output
  preserved for un-paired senders.
- **`/stop`** — interrupt the agent's current task. Sends `C-c` to the tmux
  pane the running claude session lives in.
- **`/restart`** — `SIGTERM` claude; systemd's respawn loop brings it back
  within ~2s. Useful when claude is stuck.
- **`/agents`** — list sibling agents on the same host via
  `sudo -n 5dive agent list --json`. Marks "← you" against the agent owning
  the bot. Requires the agent user to have passwordless sudo for 5dive (the
  default on 5dive-managed hosts).
- **`/tasks`**, **`/task add <title>`**, **`/org`** — drive the host-shared
  task queue + agent org chart via `sudo -n 5dive task|org … --json`.
  `paired-5dive`-scoped (hidden + no-op on upstream-only hosts). Task titles
  are passed after `--` and `created_by` is the sender's Telegram @handle.
- **Forum-topic capture on inbound + reply** — inbound `<channel>` meta now
  carries `message_thread_id` when a message comes from a non-General topic
  in a supergroup (e.g. a "#5dive" thread). The `reply` tool accepts a
  matching `message_thread_id` arg that's passed through to Telegram's
  sendMessage/sendPhoto/sendDocument, so replies land in the same topic
  instead of falling back to the supergroup's General channel.
- All slash commands are registered via `setMyCommands` so Telegram surfaces
  them in the autocomplete menu.

### Added — v0.1.0 carried over

- Bundled lifecycle hooks (`hooks/pretool-question.sh`, `hooks/stop-reply-check.sh`)
  declared via `hooks/hooks.json` — eliminates the need for `5dive-cli` to
  patch hooks into `settings.json` externally.

### Deferred

- `stop-failure-telegram.sh` — coupled to `/usr/local/lib/5dive/resume-after-reset.sh`.
- Multi-agent routing (1 bot ↔ N agents).
- CLI-agnostic plugin variants (codex / opencode / etc.).
- `/route`, `/spawn`, `/quiet`, `/verbose`, `/usage` — slash command shortlist
  for v2.

### Notes

The "channels" feature (the system-reminder injection on inbound messages)
is gated by claude's internal channel allowlist. For our fork to work as a
channel surface, the host needs `/etc/claude-code/managed-settings.json`
with an `allowedChannelPlugins` entry for `telegram@5dive-plugins`. Without
it the plugin still loads as a regular MCP server (tools callable, but no
auto-injection of inbound messages). 5dive-managed hosts get this
allowlist via the 5dive-cli installer; standalone OSS users currently need
to write the managed-settings file themselves.
