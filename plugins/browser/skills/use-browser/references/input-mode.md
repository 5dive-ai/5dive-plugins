# Input mode: sites driven by screen, keyboard and mouse

Part of the use-browser skill. Read it when a verb says "INPUT mode", or the site is tiktok.com or amazon.co.jp.

Some sites will not render for a browser under automation control. For those, the site's
adapter says `"drive": "input"`, and the browser is **plain Chrome, driven the way a person
drives it**: you read the screen and act through a real keyboard and mouse. There is no
automation channel, so to the page it is indistinguishable from the owner's own window.
tiktok.com and amazon.co.jp are such sites. A box can also make input mode the **default** for every
logged-in site (`5dive browser config` shows it; root sets `drive=input`), and then this is how
you work on all of them, unless a site's adapter says `"drive": "cdp"`. The verbs tell you when a
site is in input mode: `read`, `tree` or `run` refused "INPUT mode" means use the screen.

```bash
5dive browser shot tiktok.com https://www.tiktok.com/@someone   # a PNG of the live window (1280x800) + its title
5dive browser shot tiktok.com                                     # the window as it is now, no navigation
5dive browser act tiktok.com --steps='[{"op":"click","x":922,"y":674},
                                       {"op":"type","value":"hello"},{"op":"press","key":"Enter"}]'
```

1. **Look first.** Every decision starts from a `shot` (or the `page.png` the last `act` left).
   The coordinates are pixels of that PNG. The address bar is in the picture, so you can see
   which page you are on.
2. **Act in small steps**: `click{x,y[,button,count]}`, `move{x,y}`, `type{value}` (into
   whatever has focus), `press{key}` (`Enter`, `Tab`, `Escape`, `PageDown`, `ctrl+l`, …),
   `paste{value}` or `paste{path}` (puts text in whole, through the clipboard: use it for code,
   a long text or anything with quotes, because a code editor changes text typed key by key),
   `scroll{dy}` (wheel notches, + is down), `goto{url}` (typed into the address bar),
   `wait{ms}`, `upload{x,y,path}` (clicks the upload control at x,y, types the file's absolute
   path into the browser's file chooser and checks it closed; if the chooser will not take it,
   the file is dropped on x,y instead), `drop{x,y,path}` (drags the file onto x,y: a drop area
   or the upload control, no chooser). Then read the `page.png` it wrote before the next act. A click that opens a new
   page ends that act: type into the new page in the next one, after you have seen it. A click
   on a spot another window covers, or keys that cannot reach the browser, fail the step (exit
   1) with nothing sent past it. Read the error and the screenshot; do not repeat the same step
   blind.
3. **There is no DOM here.** `tree`, `read`, `links`, adapter `run` actions and `selector`/`ref`
   steps are refused, by name. Do not ask for them; use the screen.
4. **Say what a step does when it matters.** Nothing here can read a button's label, so a step
   that pays, publishes, sends or deletes must carry `"kind":"pay"` (or `publish`, `send`,
   `delete`). The owner's policy applies to what you declare: a kind they set to `ask` (pay, by
   default) stops with exit 73 before anything runs. Never leave the kind off to get past that.
   An undeclared purchase is still a purchase.

**Clear sign-in checks yourself first** (DIVE-7881): a code from the site's mail (open the
box's mailbox in this browser) or the owner's saved `.2fa`, a tick box, a slider you can drag,
a "Just a moment…" you can wait out. **Hand the window to the owner when a person is truly
needed**: a check still there after a few tries, a code sent to their phone, a check the owner
gated (`5dive browser gate`), or a judgement call that is theirs:

```bash
5dive browser handoff tiktok.com --reason="solve the slider puzzle"   # they get a Connect button
5dive browser handoff tiktok.com --wait                               # returns when they are done
```

They open the **same window** you were driving. Your input is refused while they have it, and
when they tap Done you carry on from the page they left. Take a `shot` before your next act.
A challenge whose title says so stops the rest of an act's steps by itself, so nothing is typed into
it: exit 76 with how to try it, or exit 75 when the owner gated robot checks on that site. TikTok's
puzzle does not change the title, so you see it only in a screenshot: try it, and hand the window
over if it stays.

A site's own **error page** is different: the stop says the site **refused this read** (still exit
75), and there is no handoff, because a person has nothing on it to clear. Amazon's
「ご迷惑をおかけしています！」 is one. Don't hand it over and don't retry in a loop: tell your owner
Amazon refused the read, and use another source for that page or try again later.

On Amazon, `snapshot <url>` usually does not stop there: when the browser is refused, it reads
the same page over plain HTTP through your route, signed out, and exits 0 with a `page.md` you
can read (`read_by: http` in `page.meta.json`). The login in the browser is not used, so cart,
orders and anything signed-in still need the screen. Only the stop above means neither worked.

A page that **did not finish loading** (exit 76) was not read: its title was still its address
when the wait ran out. The screenshot shows how far it got. Try once more a minute later; if it
still does not load, say so rather than reading the screenshot as the page.

## One window for the box's logins

The box's logins share one browser (Shopify, CJ, Facebook…). When you use a site, that browser
switches to the way the site needs: input mode for CJ, the normal browser for Shopify. A verb
that says it re-served the browser did that; carry on. It will not switch while the owner is in
the window or another agent is mid-step: wait and try again, with `--wait` on an input verb.
`status` never switches it. If the window is stuck or in the wrong mode, restart it yourself:

```bash
5dive browser serve cjdropshipping.com --restart
```

Never ask the owner to stop or restart a window.

## A key the site only lets you copy

Some sites show a new API key masked, with only a Copy button (cjdropshipping.com). Click Copy
with an `act`, take a `shot` to see it took, then:

```bash
5dive browser clipboard cjdropshipping.com --to-secret=CJ_API_KEY      # saved, never shown
```

It saves the window's clipboard in the box's secret store under that name and clears the
clipboard. It never prints the key: never read the key off the screen, type it into chat or a
file, or use any other way to get it out. Empty clipboard: press Copy again.

## From real jobs in input mode

- **Input mode: Chrome's "Restore pages?" bubble can cover the header's sign-in link or avatar.** Close it and take a new `shot` before you judge signed in or out, and check the URL bar in the screenshot shows the page you meant.
- **Input mode: check typed text in the screenshot before you press Enter.** A field can refuse focus or drop characters. After two misses on the same field, try one other way in, then stop. Never send a partial message.
- **Input mode: re-shoot before you click by coordinates.** A cookie banner, a dialog or a name that wraps to two lines moves everything below it, so coordinates from an earlier screenshot miss.
- **Input mode: a `shot` shows only the first screen (1280x800).** Before you say a list, feed or inbox has nothing new, or count what is on it, `scroll{dy}` (or press `PageDown`) and read the new `page.png`, or say which part you did not reach.
- **Input mode: a first `shot` can catch the page still loading** (a spinner, grey boxes, an empty list). `wait{ms}` a few seconds and shoot again before you read it or judge signed in.
- **Input mode: text read off a `shot` is approximate.** A quote or name copied from the picture can differ from the page. Check it against the page text, or mark it approximate where you record it.
