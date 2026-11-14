# Telegram Web: read flags, not messages

Part of the use-browser skill. Read it when the owner lets you check his Telegram
(web.telegram.org/k) but limits what you may read: "never read muted chats", "only tell me
who wrote", "check it is my account first".

Use **read-only acts** only: every step is `eval` (a `goto` or `wait_for` before it is fine).
Such an act prints the scripts' answers and nothing else: no page.md, page.html, tree.json or
page.png, no "what changed". Any other step (a click, a scroll by `press`) makes it a normal act
that saves the whole page, and on the chat list that is every chat's last message.

**Read from Telegram Web K's source (morethanwords/tweb), not yet measured on a live
session.** If an answer below comes back `null` or refused, say so to the owner and stop;
do not fall back to reading the page.

## 1. Whose account is this (before anything else)

```bash
5dive browser act https://web.telegram.org/k/ --steps='[{"op":"wait_for","selector":".chatlist"},{"op":"eval","expr":"[rootScope.myId, ((apiManagerProxy.mirrors.peers[rootScope.myId]||{}).username || (((apiManagerProxy.mirrors.peers[rootScope.myId]||{}).usernames||[])[0]||{}).username || null)]"}]'
```

Prints `[<your user id>, "<username>"]`. These are plain properties of the app's own objects
(tweb mounts `rootScope` and `apiManagerProxy` on `window`), so the read-only check lets them
through. `appUsersManager.getSelf()` is refused, and that is correct: it asks the app's worker,
which counts as a side effect. Username `null` means the account has none: compare the id. Not
the owner's account → stop and tell him; read nothing else.

## 2. Which chats are muted

```bash
5dive browser act --steps='[{"op":"eval","expr":"[...document.querySelectorAll(\".chatlist-chat[data-peer-id]:not([data-thread-id])\")].map(e=>({id:e.dataset.peerId, muted:e.classList.contains(\"backwards\")?\"unknown\":e.classList.contains(\"is-muted\")}))"}]'
```

(no URL: it reads the tab the first act left open). Prints `[{"id":"…","muted":true|false|"unknown"}, …]`.

- `is-muted` on the row = muted. `is-muted` with `backwards` = the row is being unmuted right
  now: `"unknown"`.
- **Only rows on screen are listed** (the list draws rows as they scroll in). Rows below the
  fold are not in the answer at all: they are unknown, never "not muted".
- **A row is drawn first and gets its muted flag a moment later** (the app loads the chat's
  state, then sets the flag). A row read in that moment says `false` even when it is muted. So
  read twice, about 3 s apart, and trust a row only when it is in BOTH reads with the SAME
  answer. A row that is new in the second read, or changed between them, is `"unknown"`.
- Treat `"unknown"` as muted, as the owner asked.

## 3. Reading one allowed chat

A normal act (a click on the row) saves the whole page, and the chat list beside the chat is in
it, muted previews included. So open the chat by its id in a read-only act too, and read only
its messages:

```bash
5dive browser act 'https://web.telegram.org/k/#<id>' --steps='[{"op":"wait_for","selector":".bubbles .bubble"},{"op":"eval","expr":"[...document.querySelectorAll(\".bubbles .bubble .message\")].slice(-20).map(e=>e.innerText)"}]'
```

Only for an id that read `false` in both reads above; never for `true` or `"unknown"`.

## 4. On a schedule

Nothing extra: the served browser keeps the sign-in between runs, and the box's scheduler
(`crontab`) runs these acts every 10 minutes.
