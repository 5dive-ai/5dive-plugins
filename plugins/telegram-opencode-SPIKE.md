# telegram-opencode feasibility spike (DIVE-11)

**Date:** 2026-06-01 · **Verdict:** FEASIBLE, and materially cleaner than the
codex/grok/agy pattern. **Recommendation: build it — but do NOT fork the codex
MCP server. opencode warrants a different, simpler bridge architecture.**

opencode v1.15.13, installed via the dance 5dive already ships
(`TYPE_BIN[opencode]`, `TYPE_CHANNELS[opencode]=0`). Free `opencode/*` models
work with zero auth setup; bring-your-own is `OPENAI_API_KEY` (already wired in
`5dive-cli/src/header.sh`).

## What was proven (live, on this host)

1. **Headless server is real.** `opencode serve --port N` boots a stable HTTP
   server. `GET /doc` returns a full OpenAPI 3.1 spec — **131 routes**.
2. **One-shot also works.** `opencode run "<msg>" -m <model> --format json`
   emits structured JSON events (`step_start`, `text`, …) and exits 0. Session
   id is returned for `-s/--session` continuation.
3. **Full HTTP round-trip, end-to-end:**
   - `POST /session` → `ses_…`
   - `GET /event` → **SSE push stream** (this is the headline)
   - `POST /session/{id}/message` with `{model:{providerID,modelID}, parts:[{type:text,text}]}`
   - the assistant reply (`ROUNDTRIP_OK`) streamed back over `/event` as
     `message.part.delta` tokens, ending in `session.idle`.

## Why this is cleaner than codex/grok/agy

The codex-family bridge exists *because* those runtimes have no push channel —
hence the `wait_for_message` blocking MCP loop, the tmux `send-keys` re-arm
watchdog, pane-scraping for stall causes, and a file-IPC permission bridge.
**opencode has none of those constraints.** The `/event` SSE stream gives us
everything those hacks simulate, as first-class API:

| codex/grok/agy hack | opencode native equivalent |
|---|---|
| `wait_for_message` blocking MCP tool | persistent server; we POST prompts, no blocking idle loop |
| re-arm watchdog (tmux send-keys) | `server.heartbeat` events on `/event` (built-in liveness) |
| Stop hook + `last-reply`/`last-inbound` mtime heuristics | `session.idle` event = real turn-complete signal |
| `newestTurnMtimeMs()` pane/transcript stat | streaming `message.part.delta` = live progress |
| file-IPC permission bridge (`req-*.json` watch) | `GET /permission` + `POST /session/{id}/permissions/{id}` |
| (no equivalent) | `GET /question` + `/question/{id}/reply|reject` |
| `/stop` → tmux C-c | `POST /session/{id}/abort` |

Confirmed present in the live `/event` stream: `server.connected`,
`server.heartbeat`, `message.part.delta`, `message.updated`, `session.status`,
`session.idle`. Permission/question routes exist in the OpenAPI spec (no perms
were triggered by the trivial prompt, so 0 fired — but the endpoints are there).

## Recommended fork pattern

**A long-running relay process, not a fork of the codex MCP server.** Shape:

1. One `opencode serve` per agent (systemd-managed pane, like the others), bound
   to a local port. Set `OPENCODE_SERVER_PASSWORD` (the spike logged a warning
   that it's unsecured by default — must set it).
2. The bridge process holds **one** subscription to `GET /event` and relays:
   - `message.part.delta` / `message.updated` (assistant role) → Telegram
     (stream or coalesce to a final reply; `session.idle` marks turn end).
   - `permission` / `question` events → Telegram inline buttons → POST the reply
     back. This is the codex permission-bridge feature, but trivial here.
3. Inbound Telegram message → `POST /session/{id}/message` (or `prompt_async`).
   Keep a chat→session map (reuse `-s`/session id for continuity).
4. `/stop` → `POST /session/{id}/abort`. `/restart` → bounce the serve unit.

**Reuse from the existing forks:** the Telegram access-control layer, chunking,
pairing flow, `/tasks /task /org /agents /status` command handlers, the grammy
bot scaffold. **Drop entirely:** `wait_for_message`, the re-arm watchdog, the
stall/pane-scraper, the Stop/silence hooks, the file-IPC permission bridge.

Net: telegram-opencode is **smaller** than the codex forks, not larger, and is
the first runtime that can do true streaming + a clean permission UX. It does
NOT fit the DIVE-9 generator (that templatizes the wait_for_message family);
it's a distinct, simpler sibling.

## Open items before/at build time

- Auth: confirm `OPENAI_API_KEY` (bring-your-own) and the bundled-free path both
  work under the agent systemd unit (spike ran free models as agent-dev).
- `prompt_async` vs sync `message`: pick async + event-stream for responsiveness.
- Server lifecycle: who owns the `serve` process and its port (5dive provisioning
  vs the bridge spawning it); collision/retry on port.
- `OPENCODE_SERVER_PASSWORD` seeding + the basic-auth user/pass on requests.
- mDNS is off by default (good — keep it off; bind 127.0.0.1).
