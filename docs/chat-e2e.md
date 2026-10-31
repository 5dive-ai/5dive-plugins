# Encrypted web chat on a self-hosted server (protocol v1)

DIVE-6875 designed it; DIVE-6876 lands the box side in the `dashboard` plugin.
The relay (our API and its database) carries only ciphertext for a server where
`/etc/5dive/chat-e2e/` exists. Self-hosted (chat-only) servers only.

| Piece | Where | Row |
| --- | --- | --- |
| Envelope (seal, open, pairing proof, fingerprint) | `plugins/dashboard/e2e.ts` (the app keeps a byte-identical copy) | 6876 |
| Box side: open inbound, seal outbound, refuse plaintext, drop replays, post device lists | `plugins/dashboard/chate2e.ts`, wired in `server.ts` | 6876 |
| Root verb `5dive _chat_e2e`, box key, device list, `chat devices`, link-script secret | 5dive CLI | 6878 |
| Device-key directory, envelope pass-through, plaintext refused, generic push text | 5dive-api | 6877 |
| Browser key, seal/open in the chat, approval screen, fingerprints | 5dive-frontend | 6879 |

## Envelope

ECDH P-256 static keys (box, and one per browser or phone), HKDF-SHA256,
AES-256-GCM, WebCrypto only. One random content key per message encrypts the
body; it is wrapped once per recipient under
`HKDF(ECDH(sender, recipient), salt, "5dive-chat-e2e-v1 wrap|<from>|<to>|<conv>")`.

```
{ h: { v: 1, s: <sender id>, c: <conversation>, m: <message id>, d: "in"|"out", t: <ms>, salt },
  iv, ct,                        // AES-GCM(body), AAD = canonical header
  k: { <recipient id>: { iv, w } } }  // AES-GCM(content key), AAD = header + SHA-256(ct)
```

- `c` is the chat id the box already uses (`dashboard`, or the chat's own id).
- `d` is `in` for anything a device sends the box and `out` for anything the box sends.
- The wrap binds the body hash, so a co-recipient who knows the content key cannot
  swap the body under the others' wraps (`E6` in the envelope test).
- A reader takes the sender's key from its OWN list, never from the envelope or the API.

## What is inside

The body of every message is an envelope; the API sees `metadata.e2e = {v:1}`.
The plaintext inside a body envelope is JSON with a type the sender cannot choose
freely (below):

| `t` | From | Fields |
| --- | --- | --- |
| `msg` | device or box | `text`, `files?: [{path, name, size}]`, `question?: {id, options}` |
| `status` | box | `label` (the "working: …" line) |
| `approve` / `revoke` | device | `device`, `pub` (approve only) |
| `roster` | box (root only) | `n`, `devices: [{id, pub}]` |

- **Files** travel as their own envelopes under a meaningless name (`*.e2e` on the
  way out). The message id of a file envelope is the parent's plus `#f<index>`,
  from the same sender in the same conversation; a reader takes a file only from
  the message that names it. `name` is the real file name.
- **Voice notes** are files. Hands-free listening is OFF in an encrypted chat: its
  transcript goes back to the API in the clear.
- **Question buttons** ride inside `msg`. A tap comes back as a normal `msg` whose
  text is the label.
- **Outside the encryption:** agent names, times, sizes, whether the agent is
  working, @mention targets.

## The box side (this plugin)

- **Inbound** (`/pending` and the drop dir): the body must parse as an envelope for
  this chat, inbound direction, with no `#` in its id. It is opened by the root
  verb. Refused and never shown to the session: plaintext, anything that does not
  open, an unknown sender. A refused message is acked (the API stops offering it),
  written to `lifecycle.log`, and the person gets one sealed notice per chat per 10
  minutes.
- **Replays:** a delivered `(sender, message id)` is recorded in
  `~/.claude/channels/dashboard/e2e-seen.json` (30 days, 20 000 entries) only AFTER
  the session has it, so a failed push is still offered again. The same message
  again is acked and dropped.
- **Outbound:** every reply (the reply tool, voice notes, outbox notices, Codex and
  Grok replies, the refusal notice) is sealed to every approved device. A reply that
  cannot be sealed fails and nothing is sent. Plaintext copies in the outbox are
  removed once sealed. The "working" step is sealed; if that fails, the chat shows
  plain "working" without the step.
- **Device lists:** an `approve` or `revoke` from an approved device is applied by
  root, which answers with the new list sealed to every device; this side posts it.

## The root verb (`5dive _chat_e2e`, built on DIVE-6878)

The seat never reads the box key or the device list. It runs
`sudo -n /usr/local/bin/5dive _chat_e2e` with one JSON request on stdin and reads
one JSON answer on stdout; exit non-zero (message on stderr) or `{"error": …}` is a
refusal. `DASHBOARD_E2E_ARGV` is the test seam; `test/lib/chat-e2e-box-stub.ts` is
the stand-in the tests run, and the reference for the real verb.

| Request | Answer | Root must |
| --- | --- | --- |
| `{op:"open", kind:"msg", conv, env}` | `{sender, m, pt}` (base64url) | take the sender key from its list; open with `conv`, direction `in`; refuse an id with `#`. If `pt` is `approve`/`revoke`, apply it and answer `{sender, m, roster: <env>}` instead, sealed to every device on the NEW list, id `roster-<n>`. |
| `{op:"open", kind:"file", conv, env}` | `{sender, m, pt}` | refuse an id without `#`; never apply a device-list change. |
| `{op:"seal", conv, m, msg:{text, files?, question?}}` | `{env}` | write `t:"msg"` itself (a seat's `t` is ignored); refuse an id with `#` or starting `roster-`; seal to every approved device. |
| `{op:"seal", conv, m, status:{label}}` | `{env}` | write `t:"status"`. |
| `{op:"seal-file", conv, m, data}` | `{env}` | require an id ending `#f<n>`; seal the raw bytes. |

The relay (`5dive _dashboard_relay`) needs two new ops for a standard seat:
`event-e2e <chat> <envelope> <files…>` and `status-e2e <chat> <0|1> [<envelope>]`.
A relay without them refuses, and the reply fails rather than going out in the clear.
The relay's `put` must accept the `*.e2e` blobs in the outbox.

## Size

A file envelope is JSON with the bytes in base64url, about 4/3 of the file, and the
chat's file cap (20 MB) applies to the envelope: about 14 MB of file.

## Known v1 limits (for the outside review)

- Static-static keys: no forward secrecy. A stolen box key reads the ciphertext the
  relay kept. No healing after a compromise.
- The web app is served by us; a changed app could leak a browser key.
- Chats from before the switch-on stay readable to us until deleted.
- The agent still sends the conversation to its AI provider.
