---
name: use-browser
description: Do something on a website in a real browser on the box — click, type, fill a form, search, check a page, add to a cart, star a repo, draft a reply. Use for "go to <site> and …", "buy/book/fill/submit/check … on <site>", "open <url> and …", or anything a normal fetch cannot do (JavaScript pages, clicks, forms, logged-in pages). Works with NOTHING connected; connecting a site (the connect-site skill) is only for pages where it must be the owner's account.
---

# use-browser — snapshot, act by ref, verify; the owner says yes to pay/post/send/delete

`5dive browser` drives a real Chrome on this box. Give any page verb a **URL** and it picks
the profile itself: the host's one connected login, or the **public profile** (nothing logged
in) when there is none. A box with zero connected sites can still browse and act on any public
page. Connecting a site is only for the owner's own accounts — their inbox, their cart, their
repo — and that is the `connect-site` skill, not this one.

## The loop: ONE snapshot per decision

```bash
5dive browser snapshot <url> --interactive     # the refs you can act on
5dive browser act <url> --steps='[{"op":"click","selector":"ref=button/Star"}]'
5dive browser act <url> --steps='[{"op":"fill","selector":"ref=textbox/Title","value":"Bug: …"},
                                  {"op":"click","selector":"ref=button/Save draft"}]' --expect='Draft saved'
```

1. **Snapshot** the page with `--interactive` and pick refs from what it printed. Never invent a
   ref; a page you have not snapshotted is a page you are guessing about. A web app (Gmail) shows
   a loading screen first: add `--wait-for='[role=main]'` (or `text=<words>` the loaded page
   has). **Exit 76 is not the page** — a loading screen or a `--wait-for` that never came; run it
   again with a `--wait-for`, and do not ask anyone to log in.
2. **Act** on those refs. Steps are `goto fill click wait_for select press`, run in order, in
   one tab under one lease. Without a URL, `act` continues on the page a served browser holds.
3. **Verify.** `--expect=<regex>` grades the page as the steps left it, re-read for up to 5 s so
   a toast counts. Without it, `act` only says the steps ran — open the `page.png` it wrote
   before you tell anyone it worked.

`read`, `links` and `shot` take a URL the same way when you only need the text, the links or a
picture of a page.

## Pages that need the owner's login

A page verb refuses a page that is visibly a sign-in form or a challenge, and never hands one
back as evidence. On a site with no adapter it proceeds otherwise, and says that no adapter
confirmed the login. If you hit the sign-in refusal on a page that must be the owner's account,
switch to the `connect-site` skill. Never type the owner's password yourself, and never try to
get past a CAPTCHA or other challenge.

**Blocked from a server IP** ("Request blocked by network security", "suspicious network"):
some sites block server IPs; `5dive browser proxy set <url>` sends this box's browser through
your own proxy. That is the owner's proxy and the owner's call — tell them, and use only a URL
they give you. Switching the proxy mid-session can end a site's login (the site sees a new IP).

**Two accounts on one site** (`github.com_work`, `github.com_personal`): a URL alone is refused
and the refusal names both. **Ask the owner which one, never guess**, then name it:
`5dive browser act github.com_work <url> --steps=…`.

## Paying, posting, sending and deleting are the owner's call

`act` stops in front of any such button (read off the live page, whatever selector you used;
Ctrl/Cmd+Enter counts as send) and exits **73** with the ask, a screenshot and an approval id.

- Relay the ask to the owner **with the screenshot**, in plain words: what will be bought,
  posted, sent or deleted, and where.
- Only on their explicit yes is it approved: `sudo 5dive browser approve <id>`, which the owner
  or their dashboard runs — not you. Then re-run the SAME act with `--approved=<id>`. A yes covers
  exactly those steps, once, for 30 minutes.
- **Do not rephrase the steps to get around the stop.** A button renamed is still an order
  placed. The check reads literal button labels, so a purchase behind a button labelled
  "Continue" is not caught by it — that one is on you: if a step will pay, post, send or delete,
  ask first even when `act` does not stop you.
