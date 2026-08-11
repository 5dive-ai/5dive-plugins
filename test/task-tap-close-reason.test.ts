// Tripwire for DIVE-3206: the /task_<id> ✅ Done and ⚠️ Confirm cancel taps must
// carry a --result, and a fork must READ the CLI's verdict.
//
// What broke: the taps ran `5dive task done|cancel <id>` bare. The CLI refuses a
// first close that would leave the result column permanently blank (DIVE-2773) and
// says so explicitly — "No flag bypasses this" — so every tap failed. On the
// baseline the handler's `catch` swallowed the refusal and showed a generic
// "open the dashboard", naming neither cause nor fix. On the forks it was worse:
// run5dive RESOLVES rather than rejects on a --json refusal (DIVE-2623), so the
// handler never reached its catch and reported "✅ Marked done" for a close that
// had not happened.
//
// Static-parse only, like parity.test.ts — importing a server long-polls Telegram.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const BASELINE = 'telegram'
const FORKS = ['telegram-codex', 'telegram-grok', 'telegram-agy', 'telegram-opencode', 'telegram-pi'] as const
const ALL = [BASELINE, ...FORKS] as const

const read = (plugin: string) => readFileSync(join(PLUGINS, plugin, 'server.ts'), 'utf8')

// The invocation line for a close verb, wherever it is spelled — execFileP array
// on the baseline, run5dive array on the forks.
function closeCall(src: string, verb: 'done' | 'cancel'): string {
  const m = new RegExp(`^.*'task', '${verb}', taskId.*$`, 'm').exec(src)
  return m?.[0] ?? ''
}

describe('DIVE-3206: task close taps carry a reason', () => {
  for (const plugin of ALL) {
    const src = read(plugin)

    for (const verb of ['done', 'cancel'] as const) {
      test(`${plugin}: the ${verb} tap passes --result`, () => {
        const call = closeCall(src, verb)
        expect(call).not.toBe('')
        expect(call).toContain('--result=')
        expect(call).toContain(`tapResult('${verb}'`)
      })
    }

    test(`${plugin}: the reason is attributed and is not a placeholder`, () => {
      expect(src).toContain('function tapResult(')
      const body = /function tapResult\([\s\S]*?\n}/.exec(src)?.[0] ?? ''
      expect(body).toContain('${senderId}')
      // The CLI names 'n/a' as the thing that satisfies a non-empty check while
      // recording nothing. Writing one here would pass the CLI and defeat it.
      expect(body.toLowerCase()).not.toContain('n/a')
    })

    test(`${plugin}: a failed tap reports the refusal, not a generic dashboard nudge`, () => {
      expect(src).toContain('function tapFailText(')
      for (const prefix of ["Couldn't mark done", "Couldn't cancel"]) {
        expect(src).toContain(`tapFailText("${prefix}", e)`)
        // the bare form is what hid the cause
        expect(src).not.toContain(`text: "${prefix} — open the dashboard." }`)
      }
    })
  }

  // Forks only: run5dive resolves on a CLI refusal, so a try/catch alone is not a
  // check. Without an explicit .ok read the tap reports a success that never was.
  for (const fork of FORKS) {
    test(`${fork}: reads the CLI verdict rather than assuming success`, () => {
      const src = read(fork)
      for (const verb of ['done', 'cancel'] as const) {
        const idx = src.indexOf(closeCall(src, verb))
        expect(idx).toBeGreaterThan(-1)
        // the guard sits immediately after the call
        expect(src.slice(idx, idx + 400)).toContain('if (!r.ok) throw new Error(')
      }
    })
  }
})
