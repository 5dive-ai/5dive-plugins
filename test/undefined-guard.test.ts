// DIVE-1674: the telegram plugin must NEVER deliver a bare 'undefined'/empty
// payload to the user (lodar: "dev sends me undefined via telegram plugin").
// The fix guards defensively at every send choke point. This locks the
// directly-testable one — the hooks Bot-API client sendMessage(chatId, text) —
// by mocking global fetch and asserting the network call is SKIPPED for
// null/empty/'undefined' text and made for real text. The transport-layer
// middleware guard (bot.api.config.use) across all forks is exercised
// indirectly by the full suite staying green; see server.ts.
//
// DIVE-3454: this file binds its OWN TELEGRAM_STATE_DIR. sendMessage grew a
// second gate in DIVE-3445 — it refuses any chat id absent from access.json's
// allowlist — and this file sends to a fake id. Left inheriting the seat's
// state dir, the arms below therefore depend on whether the machine running
// them is PAIRED: green on CI and on a fresh seat (no access.json → empty list
// → fail open), red on every agent seat that has one. That is the wrong way
// round — the failure CI cannot see gets written off as "my machine", and a
// real regression in this arm gets written off with it.
//
// The binding is not a mock: the allowlist read (telegram.ts allowedChatIdsFresh)
// resolves TELEGRAM_STATE_DIR on every call, so pointing it at an empty dir is
// the same code path a fresh seat takes. The third arm below is the control
// that keeps the binding honest — it seeds an access.json under the bound dir
// and asserts the refusal, which can only pass if the env var is being read.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sendMessage } from '../plugins/telegram/hooks/lib/telegram'

const origFetch = globalThis.fetch
const origToken = process.env.TELEGRAM_BOT_TOKEN
const origStateDir = process.env.TELEGRAM_STATE_DIR

// Empty: no access.json, so the allowlist is empty and sends fail open —
// the state a machine with no pairing is in, made explicit instead of assumed.
let unpairedDir: string
// Holds an access.json listing SOME OTHER chat, for the refusal control.
let pairedDir: string

beforeAll(() => {
  unpairedDir = mkdtempSync(join(tmpdir(), 'dive3454-unpaired-'))
  pairedDir = mkdtempSync(join(tmpdir(), 'dive3454-paired-'))
  // Reserved fake ids only (RFC-5737 spirit): never a real chat.
  writeFileSync(
    join(pairedDir, 'access.json'),
    JSON.stringify({ allowFrom: ['1234567890'], groups: {} }),
  )
})

afterAll(() => {
  rmSync(unpairedDir, { recursive: true, force: true })
  rmSync(pairedDir, { recursive: true, force: true })
})

// Set per-test and restored immediately, so no other test FILE can observe the
// override — paths.ts freezes STATE_DIR at module load (DIVE-3452), and a
// process-wide override left standing would decide that frozen value for
// whichever file loads it next.
beforeEach(() => {
  process.env.TELEGRAM_STATE_DIR = unpairedDir
})

afterEach(() => {
  globalThis.fetch = origFetch
  if (origToken == null) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = origToken
  if (origStateDir == null) delete process.env.TELEGRAM_STATE_DIR
  else process.env.TELEGRAM_STATE_DIR = origStateDir
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

  // DIVE-3454 control. Proves the two arms above are green because THIS file
  // chose an unpaired state dir, not because the host happened to be unpaired:
  // if TELEGRAM_STATE_DIR were being ignored, a runner with no access.json
  // (CI, exactly the machine that could not see the original failure) would
  // fail open here and send.
  test('binds its own state dir: an allowlist that omits the chat refuses the send', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token'
    process.env.TELEGRAM_STATE_DIR = pairedDir
    const calls = stubFetch()
    await sendMessage('123', 'hello')
    expect(calls.length).toBe(0)
  })
})
