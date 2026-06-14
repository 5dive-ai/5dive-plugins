# DIVE-380 — `/login`: self-serve coding-CLI auth from chat

**Epic:** DIVE-378 (Telegram plugins 0.5.0 self-serve onboarding) · **Owner:** dev · **Status:** design (no code until blessed + lodar has seen it)

## Goal

Let a paired operator authenticate their agent's coding-CLI (Claude/Codex/etc.)
entirely from the agent's Telegram DM — no shell, no dashboard, no BotFather.
`/login` drives the OAuth device-code flow the pair-test harness already runs.

**Non-goals:** rebuilding any auth logic (we wrap the existing CLI), group-chat
use (DM-only), antigravity (v2 — see matrix), managed-bot creation (that's DIVE-379).

## Reuse — do NOT rebuild

All auth work is the existing on-box CLI (`5dive-cli/src/cmd_auth.sh`):

| step | command | returns |
|------|---------|---------|
| start | `5dive agent auth start <type> --json` | `{sessionId, type, state:"pending_url"}` |
| poll  | `5dive agent auth poll <sid> --json` | `{state, url, code, error, ...}` |
| submit| `5dive agent auth submit <sid> --code=<code> --json` | `{state:"submitted"}` |
| cancel| `5dive agent auth cancel <sid> --json` | terminal `expired` |

States: `pending_url → awaiting_code → ok | error | expired`. Session TTL 1h.
`submit` is **only** for `claude` (+ antigravity, v2); the others self-poll.

Telegram side reuses: `COMMAND_REGISTRY` (commands.ts), the `bot.command`
dispatcher + `dmCommandGate` + `read5diveJson` helper, and the
`callback_query:data` router (server.ts) for the arming button.

## Type matrix

| type | v1? | code step | `/login` UX |
|------|-----|-----------|-------------|
| claude | ✅ | **yes** — user pastes callback code | url+code DM → arm → capture code → submit → poll ok |
| codex | ✅ | no (self-polls OpenAI) | url+code DM → poll until ok |
| hermes | ✅ | no (self-polls) | url+code DM → poll until ok |
| openclaw | ✅ | no (self-polls) | url+code DM → poll until ok |
| grok | ✅ | no (self-polls x.ai) | url+code DM → poll until ok |
| antigravity | ❌ **v2** | n/a — Google inline-paste TUI, no displayed code | needs its own UX |

`/login` **auto-detects** the agent's own CLI type (one CLI per box) — one-tap,
no type argument. (Fallback: if detection is ambiguous, a type picker; expected
to never trigger in practice.)

## Flow

**Self-pollers (codex/hermes/openclaw/grok):**
1. `/login` → `auth start <type>` → `sessionId`.
2. Poll to `awaiting_code`; DM the **url + code**: "Open this, sign in & approve."
3. Keep polling (see **Polling & timeouts**) → on `ok` DM "✅ Authenticated." On
   `error`/`expired` DM the reason + "try `/login` again."

**Claude (callback-code flow):**
1–2 as above, but the DM also shows an inline button **"✅ I approved — send the code"**.
3. Tapping the button **arms** capture for this sender (pending-state, below).
4. The operator's **next DM text** is consumed as the code — validated, fed to
   `auth submit --code`, then poll to `ok` → "✅ Authenticated."

## Pending-state lifecycle (the one new mechanism)

A small in-memory `Map<senderId, ArmedLogin>` (no existing pattern intercepts a
follow-up DM as command input; pairing is file-based, not message-based):

```
ArmedLogin = { sessionId, type, chatId, expiresAt }   // expiresAt = now + 5min
```

- **Arm:** button tap (`callback_data: "login:arm:<sid>"`) sets the entry. One arm
  per sender — a fresh `/login` (or re-tap) **replaces** any prior entry.
- **Consume:** in the inbound-text path, BEFORE forwarding to the agent, check for
  an armed entry for this sender:
  - expired → drop entry, ignore (message flows to agent as normal).
  - present → treat text as the code: **regex-validate** (per-type code shape).
    - valid → `auth submit`, disarm, reply progress; poll to terminal.
    - invalid → reply a hint ("that doesn't look like the code — paste just the
      code, or tap cancel"), **keep armed** until TTL so a typo is recoverable.
- **Disarm:** on successful submit, on terminal `error/expired`, on TTL, or via a
  **"✕ Cancel"** button (`login:cancel:<sid>` → also `auth cancel`).

## Polling & timeouts

All polling is bounded by the **1h session TTL** (`expiresAt` on the auth
session) — never an unbounded loop:

- Poll `auth poll <sid>` on a **backoff** (e.g. ~2s → 5s → 10s, cap ~15s) until a
  terminal state or the session's `expiresAt`.
- On `expired` (or our own deadline hit): DM a clear timeout — "⏱️ Login timed
  out — tap `/login` to start over." — and disarm any armed capture for the sid.
- The armed-capture **5min TTL** is independent and shorter than the session TTL:
  the operator must send the code within 5min of arming, but the underlying
  session stays valid up to 1h, so a fresh `/login` re-arms cleanly.

## Security guardrails (per main)

- **TTL 5 min** on the armed state — stale arm auto-expires, stops consuming msgs.
- **One arm per sender**; fresh `/login` replaces it; explicit cancel/disarm.
- **Regex-validate** the code before submit, using a **tight per-type pattern**
  (e.g. codex `[0-9A-Z]{4}-[0-9A-Z]{5}`, grok `[0-9A-Z]{4}-[0-9A-Z]{4}`, claude
  the URL-safe-base64 callback shape) anchored `^…$` — so a normal DM sent inside
  the 5min window is very unlikely to be mistaken for a code. On mismatch reject
  with a hint, don't silently swallow. A valid-shaped-but-wrong code just fails
  `auth submit` cleanly (no harm).
- The code is **never forwarded to the agent, never echoed back, redacted from
  logs.** DM-only (`scope:'paired'`) + paired-operator allowlist (`allowFrom`).
- Only the agent's own paired operator can `/login` (it's that agent's bot + DM).

## Release gate

OAuth-touching → **pair-test before ship** on a fresh box across the v1 matrix:
**claude / codex / hermes / openclaw / grok** (grok = distinct provider, verify
on fresh box). Antigravity not tested (v2). Versions ride main's **0.5.0**
lockstep release; I leave fork versions untouched.

## Process / sequence

1. This one-pager → main locks it → main brings design to lodar (design-before-ship).
2. dev builds (claude base; grok-base generator forks; codex/opencode hand-forks).
3. **Prod-auth-surface diffs to main before push.**
4. Pair-test matrix green → main folds into 0.5.0 release.
