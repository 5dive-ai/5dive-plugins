# Doing a flow again: mint a tool, record, replay, --delta

Part of the use-browser skill. Read it when a job repeats a flow (a daily post, a check) or snapshots the same page again.

A flow you will repeat (a daily post, a check, a clicker) costs a snapshot and a decision per
page every time. Record it the first time, then replay it in one call:

```bash
5dive browser act <url> --steps='[…]' --expect='…' --record=daily-post   # each act of run 1
5dive browser replay <site> daily-post --values='["today'"'"'s text"]'     # run 2, 3, …: no snapshots
5dive browser routine ls            # what is recorded; `routine show <site> <name>` for the steps
```

- `--record=<name>` keeps an act's steps **only when it succeeded**, and **never the values you
  typed**: each fill/type/select value becomes a numbered slot that `replay --values` fills in
  order. Add `--expect` when you record, so the replay re-checks each page.
- `replay` runs every act from the cache with no snapshot to read. If the site renamed a button,
  it re-picks it once and rewrites the routine. If it cannot, it stops (exit 1), names the act,
  and tells you to `routine forget <site> <name> --from=<k>` and re-record from there with a
  snapshot. A pay step stops a replay for the owner exactly as it stops an act (exit 73).
- Read the last `page.png` a replay leaves before you report success, as after any act.

## A task with values that change: mint it into a TOOL

A lookup or check that takes different values each time (a price for a product, an article's
facts, an order's status) is worth a TOOL: named inputs in, typed outputs back, and **every agent
on this box** can call it with no snapshot and no model.

1. Do the task once the normal way (snapshot, act) and note what varies and what you read back.
2. Mint it. A `{{name}}` in the URL (percent-encoded) or in a step's value (as typed) is an
   input; each output is a read-only page script. The example is a real run: the tool is saved
   only if every output came back with its type.

```bash
5dive browser mint 'https://en.wikipedia.org/wiki/{{topic}}' wiki-heading \
  --task="Open a Wikipedia article and read its title" \
  --inputs='{"topic":"the article name as in its URL"}' \
  --outputs='{"title":"document.querySelector(\"#firstHeading\").textContent.trim()"}' \
  --example='{"topic":"Grace_Hopper"}'
5dive browser replay en.wikipedia.org wiki-heading --input='{"topic":"Ada_Lovelace"}' --json
5dive browser tools [<site>]          # what is minted here; `tools show <site> <tool>` for its steps
```

- With steps: `--steps='[{"op":"fill","selector":"ref=searchbox/Search","value":"{{query}}"},…]'`,
  or `--from-routine=<routine>` to name a recorded routine's value slots, in order.
- An output is `"<expression>"` (a string) or `{"type":"integer","read":"<expression>"}`; types:
  string, number, integer, boolean, array, object. Read with `textContent`, not `innerText`.
- A tool that posts, sends, buys or changes something is minted with `--write`. A read tool
  that reaches a pay, post, send or delete step stops: it was minted wrong. A write tool that
  stops part-way says `possible_commit`: look at the site before you call it again.
- A site you are signed in to: `mint <site> <tool> --url='…'`. A tool never types a saved login.
- The example's values are not saved. `--private` keeps a tool for your seat only.

**Re-snapshotting the same page?** Add `--delta` after the first full snapshot: it prints only
the refs and text that changed since your last snapshot of that site, and does not write
`page.png` when under 1% of it moved (the picture you have is current). A new page, or a change
bigger than the page, comes back full.

