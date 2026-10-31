// DIVE-7427: Antigravity has no Notification event, so 5dive-agent-start wires
// the error relay on Stop. agy's Stop payload carries `terminationReason` (and
// `error` when the turn died on one) next to `lastUserInput`, the owner's last
// message. The relay must post only a real failure: the old relay JSON-dumped
// any payload it could not read and tested it against ERROR_RE, so an ordinary
// end of turn after "fix the failing test" went to the chat as an error.
//
// Each arm spawns the generated hook the way agy runs it (stdin JSON → stdout
// JSON), with fetch stubbed by a preload that records every Telegram send.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dive7427-'))
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['42'] }))
  writeFileSync(join(dir, 'stub.ts'), `
import { appendFileSync } from 'node:fs'
globalThis.fetch = (async (_url: string, init: any) => {
  appendFileSync(${JSON.stringify(join(dir, 'sent.jsonl'))}, init.body + '\\n')
  return new Response('{"ok":true}')
}) as any
`)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function relay(payload: unknown, plugin = 'telegram-agy') {
  const r = spawnSync('bun', ['--preload', join(dir, 'stub.ts'), join(PLUGINS, plugin, 'hooks', 'notification-relay.ts')], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH ?? '', HOME: dir, TELEGRAM_STATE_DIR: dir },
    encoding: 'utf8',
  })
  const file = join(dir, 'sent.jsonl')
  const sent = existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l).text as string)
    : []
  return { stdout: r.stdout, status: r.status, sent }
}

const stop = (over: Record<string, unknown>) => ({
  conversationId: 'c1', executionNum: 1, fullyIdle: true, modelName: 'auto',
  lastUserInput: 'fix the failing unit test, it errors on timeout', ...over,
})

describe('agy Stop payload', () => {
  test('a normal end of turn is not relayed, even when the owner wrote "failing"', () => {
    const r = relay(stop({ terminationReason: 'NO_TOOL_CALL' }))
    expect(r.status).toBe(0)
    expect(r.sent).toEqual([])
    expect(JSON.parse(r.stdout)).toEqual({ continue: true })
  })

  test('a canceled turn is not relayed', () => {
    expect(relay(stop({ terminationReason: 'USER_CANCELED' })).sent).toEqual([])
  })

  test('a turn that died on an error relays the error text, not the payload', () => {
    const r = relay(stop({ terminationReason: 'ERROR', error: 'Individual quota reached. Resets in 3h' }))
    expect(r.sent).toEqual(['⚠️ agy: Individual quota reached. Resets in 3h'])
    expect(r.sent[0]).not.toContain('fix the failing')
  })

  test('a hit limit with no error text is relayed by its reason', () => {
    expect(relay(stop({ terminationReason: 'MAX_INVOCATIONS' })).sent).toEqual(['⚠️ agy: turn stopped: MAX_INVOCATIONS'])
  })

  test('an ERROR stop with an empty error still relays', () => {
    expect(relay(stop({ terminationReason: 'ERROR', error: '' })).sent).toEqual(['⚠️ agy: turn stopped: ERROR'])
  })
})

describe('Notification-shaped payloads keep working', () => {
  for (const plugin of ['telegram-agy', 'telegram-grok']) {
    test(`${plugin}: an error notification is relayed`, () => {
      expect(relay({ message: 'rate limit hit' }, plugin).sent.length).toBe(1)
    })
    test(`${plugin}: a plain notification is not`, () => {
      expect(relay({ message: 'waiting for your input' }, plugin).sent).toEqual([])
    })
  }
})
