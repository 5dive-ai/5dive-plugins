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

## The flow

    5dive browser serve <site>                                 # 1. persistent Chrome on its own Xvfb
    5dive browser viewer <site> --bind=<session> [--ttl=600]   # 2. mint the ONE-TIME link (printed once)
    #                                                            3. hand the link to the human, UNOPENED
    5dive browser status <site>                                # 4. poll until `authenticated`
    5dive browser viewer-revoke <site>                         # 5. close the view; the login survives
    5dive browser run <site> <action> [--key=value ...]        # 6. only once status says authenticated
    5dive browser shot <site> <url> [--out=<png>] [--dom=<f>]  # 6b. READ a page as the logged-in user

1. `serve` is idempotent per site and fails closed on a box without the server-mode stack.
2. `viewer` prints the link once and keeps only a SHA-256 of the nonce; lose it and you
   re-mint. `--bind=<session>` is mandatory (an unbound ticket is a bearer credential for a
   live account); `--bind=local` is the named escape for a hand-run on the box. Mint it when
   the human is actually there — the TTL is short on purpose.
3. Send it on the channel you are already on as non-unfurling code, with the two facts that
   change their behaviour: one-time, and expiring. Tell the human to copy-paste it into a
   browser and never back into chat. Never write the link into a task, a PR, a commit, a log
   or a wiki page — while unspent it is a live credential.
4. `status` is the only honest confirmation; poll every ~15–30s, not tighter (each probe is
   a real page load). `authenticated` = done. `session expired` / `CHALLENGE` = a person is
   still needed. `UNKNOWN` = the probe could not read the page at all — it is not a failure
   to report and not permission to act (`status` exits 0 quietly, `run` refuses on it).
5. Revoke as soon as they are in. A live viewer is a keyboard attached to their account.
6b. `shot` renders a page INSIDE the profile and writes a PNG (and the DOM, with `--dom=`).
   It is a read, not an action, so it needs no adapter ACTION — but it does need the site's
   adapter to exist, because with none `status` cannot tell logged-in from logged-out and
   `shot` refuses rather than hand you a screenshot of the sign-in page. That PNG is the
   failure worth naming: it is evidence-shaped, and whoever reads it cannot tell. The URL
   must be a page of that site (or a subdomain). If the browser is being `serve`d, `shot`
   stops it for the render and starts it again — unless a person is inside the viewer right
   now, which is a refusal, not a wait.

## What will actually go wrong

- **No server-mode stack on the box.** chromium / Xvfb / x11vnc / websockify are installed
  box-level as root; a seat cannot install them. The refusal names what is missing and the
  DEGRADED health row names the re-install command. Report it; do not improvise an install.
- **Profiles are per-seat and mode 0700, and are never repaired.** Another seat's login is
  not yours to use; a profile with the wrong owner is refused, not fixed.
- **Some sites block datacenter IPs at login.** "Request blocked by network security" is the
  site's anti-bot policy meeting a VM's IP — not our bug, no flag for it. Tell the human the
  site cannot be logged into from the box, and stop.
- **A challenge is classified before a logged-out state**, because a challenge page still
  carries the login form's markup. Trust the label instead of re-reading the HTML.
- **Sessions die on the site's schedule.** Run `status` on a schedule, not at publish time.

## The line this capability does not cross

Persistent **human-authenticated** sessions: a person logs in by hand, once, and the agent
is granted permission to operate the session — never the credentials.
**This is not anti-bot bypassing.** A CAPTCHA, a 2FA prompt or an "unusual activity"
interstitial is a hard stop that asks for a person: surface it, never attempt it. Never ask
for a password, never accept one, never export cookies out of a profile.
<!-- 5dive:browser:end -->
