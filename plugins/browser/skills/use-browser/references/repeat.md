# Doing a flow again: record, replay, --delta

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

**Re-snapshotting the same page?** Add `--delta` after the first full snapshot: it prints only
the refs and text that changed since your last snapshot of that site, and does not write
`page.png` when under 1% of it moved (the picture you have is current). A new page, or a change
bigger than the page, comes back full.

