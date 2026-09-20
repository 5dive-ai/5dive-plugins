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

## What will actually go wrong

- **No server-mode stack on the box.** chromium / Xvfb / x11vnc / websockify are installed
  box-level as root; a seat cannot install them. The refusal names what is missing and the
  DEGRADED health row names the re-install command. Report it; do not improvise an install.
- **Profiles are per-seat and mode 0700, and are never repaired.** Another seat's login is
  not yours to use; a profile with the wrong owner is refused, not fixed. The shipped relay
  currently redeems the `claude` seat, so other seats use the dashboard flow.
- **Some sites block datacenter IPs at login.** "Request blocked by network security" is the
  site's anti-bot policy meeting a VM's IP — not our bug, no flag for it. Tell the human the
  site cannot be logged into from the box, and stop.
- **A challenge is classified before a logged-out state**, because a challenge page still
  carries the login form's markup. Trust the label instead of re-reading the HTML.
- **Sessions die on the site's schedule.** A scheduled check skips a served profile and probes
  only after the browser stops; probing the held profile returns `UNKNOWN`.

## The line this capability does not cross

Persistent **human-authenticated** sessions: a person logs in by hand, once, and the agent
is granted permission to operate the session — never the credentials.
**This is not anti-bot bypassing.** A CAPTCHA, a 2FA prompt or an "unusual activity"
interstitial is a hard stop that asks for a person: surface it, never attempt it. Never ask
for a password, never accept one, never export cookies out of a profile.
<!-- 5dive:browser:end -->
