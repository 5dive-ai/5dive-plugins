// Static regression guard for the idle model-token burn bug (DIVE-1180).
//
// Root cause: the model-facing instruction layer (wait_for_message tool
// description, REARM_KICK_TEXT, AGENTS.md, notify-user/SKILL.md) told the model
// to call wait_for_message "again immediately" on a <telegram timeout=true/>.
// Network polling is cheap, but that instruction makes the MODEL self-loop:
// park -> timeout -> re-call -> park -> ... burning one model turn every cycle
// on an empty inbox, 24/7, with cost growing as context grows.
//
// The fix relies on the server already waking an idle (turn-ended) agent when a
// real inbound lands (enqueueInbound -> kickOnEnqueue, plus the re-arm watchdog
// which skips empty queues — DIVE-165/285). So the correct model instruction is:
// on timeout, END THE TURN; the server re-arms you when a message is queued.
//
// This suite fails if any shipped/generated fork reintroduces recursive-loop
// language in a model-facing surface, so regeneration or a future edit can't
// silently restore the burn. Purely static (no server import — servers long-poll
// Telegram on import).

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy'] as const

// Model-facing surfaces: the tool descriptions + REARM_KICK_TEXT live in
// server.ts; the operator/skill docs the model reads are AGENTS.md and
// notify-user/SKILL.md.
const MODEL_FACING = ['server.ts', 'AGENTS.md', 'skills/notify-user/SKILL.md'] as const

// Recursive-loop instructions that caused the burn. Matched case-insensitively.
// NB: silence-watchdog.ts is intentionally excluded — its "again immediately"
// is a code comment about ping backoff, not a model instruction.
const BANNED = [
  /again immediately/i,
  /idle polling is cheap/i,
  /keep looping/i,
]

function read(plugin: string, file: string): string {
  return readFileSync(join(PLUGINS, plugin, file), 'utf8')
}

describe('DIVE-1180: no recursive re-arm loop in model-facing text', () => {
  for (const fork of FORKS) {
    for (const file of MODEL_FACING) {
      test(`${fork}/${file} has no recursive-loop instruction`, () => {
        const src = read(fork, file)
        for (const pat of BANNED) {
          expect(src).not.toMatch(pat)
        }
      })
    }

    // Positive guard: the fix's "end the turn" instruction must be present, so a
    // deletion of the corrected text (not just a re-add of the old) also trips CI.
    test(`${fork} instructs to END THE TURN on timeout`, () => {
      const server = read(fork, 'server.ts')
      const agents = read(fork, 'AGENTS.md')
      const skill = read(fork, 'skills/notify-user/SKILL.md')
      expect(server).toMatch(/END YOUR TURN/i)
      expect(agents).toMatch(/END YOUR TURN/i)
      expect(skill).toMatch(/END YOUR TURN/i)
    })
  }
})
