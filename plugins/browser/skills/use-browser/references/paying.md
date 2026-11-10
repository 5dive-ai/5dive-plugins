# Paying, posting, sending and deleting: the full rule

Part of the use-browser skill. Read it when an act stops with exit 73, or before a step that pays, posts, sends or deletes.

**The owner's default is standard** (DIVE-5148): `act` runs post, send and delete steps without
stopping, says `ALLOWED (default standard)`, and logs each one for the owner with what it sent and
a screenshot — but a **pay step stops and asks them** (exit 73), because a post or a delete can be
undone and money cannot. `5dive browser approvals policy` shows the policy and its `mode`
(`standard`, `yolo`, `careful` or `custom`). Changing it is the owner's, not yours:
`sudo 5dive browser approvals policy set careful` puts the stop on all four,
`set yolo` takes it off all four, `set standard` is this default,
`set <kind>=ask|allow` changes one kind, and from your seat all of them are refused.

Where a kind is `ask` (`pay` by default; the owner chose `careful`, or that kind), `act` stops in front of any such
button (read off the live page, whatever selector you used; Ctrl/Cmd+Enter counts as send, and so
does a plain Enter in a composer with no form around it, which is how a chat box sends) and
exits **73** with the ask, a screenshot and an approval id.

- Relay the ask to the owner **with the screenshot**, in plain words: what will be bought,
  posted, sent or deleted, and where.
- Relay the ask's payload (who it goes to, what it says, the amount, the item), not the button's
  name. If the ask says the page showed none, say that and send the screenshot.
- Only on their explicit yes is it approved: `sudo 5dive browser approve <id>`, which the owner
  or their dashboard runs, or their Approve button on Telegram — not you (from a seat it is
  refused). Then re-run the SAME act with `--approved=<id>`. A yes covers exactly those steps,
  once, for 30 minutes.
- **Do not rephrase the steps to get around the stop.** A button renamed is still an order
  placed. The check reads literal button labels, so a purchase behind a button labelled
  "Continue" is not caught by it — under `careful` that one is on you: if a step will pay, post,
  send or delete, ask first even when `act` does not stop you.

- Clicking into a text field never stops, whatever the field holds (an email subject reading
  "Complete your order" is not an order). **If an act stops halfway through an edit**, check that
  what you opened for editing is still live: Shopify turns a live email back into a draft the
  moment you press Edit, so a stop there leaves the owner's email switched off.
