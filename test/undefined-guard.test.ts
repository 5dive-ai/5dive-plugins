// DIVE-1674: the telegram plugin must NEVER deliver a bare 'undefined'/empty
// payload to the user (lodar: "dev sends me undefined via telegram plugin").
// The fix guards defensively at every send choke point. This locks the
// directly-testable one — the hooks Bot-API client sendMessage(chatId, text) —
// by mocking global fetch and asserting the network call is SKIPPED for
// null/empty/'undefined' text and made for real text. The transport-layer
// middleware guard (bot.api.config.use) across all forks is exercised
// indirectly by the full suite staying green; see server.ts.
import { describe, test, expect, afterEach } from 'bun:test'
import { sendMessage } from '../plugins/telegram/hooks/lib/telegram'

const origFetch = globalThis.fetch
const origToken = process.env.TELEGRAM_BOT_TOKEN

afterEach(() => {
  globalThis.fetch = origFetch
  if (origToken == null) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = origToken
})

function stubFetch() {
  const calls: string[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(init?.body ?? ''))
    return { ok: true, status: 200, text: async () => '' } as any
  }) as any
  return calls
}

describe('DIVE-1674 sendMessage undefined guard', () => {
  test('skips the network send for undefined/null/empty/"undefined" text', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    const badInputs = [undefined as any, null as any, '', '   ', 'undefined', '  undefined  ']
    for (const bad of badInputs) {
      const calls = stubFetch()
      await sendMessage('123', bad)
      expect(calls.length).toBe(0)
    }
  })

  test('sends real text through (including text that merely contains "undefined")', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    for (const good of ['hello', 'the value is undefined here', 'undefined!']) {
      const calls = stubFetch()
      await sendMessage('123', good)
      expect(calls.length).toBe(1)
      expect(calls[0]).toContain('text=')
    }
  })
})
