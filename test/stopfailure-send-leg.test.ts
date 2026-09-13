// DIVE-4401 — driven coverage of the send/route LEG of stopfailure-notify.
//
// The row's symptom is "the Team usage wall was silent on Telegram". The
// classification half was not the defect: on the measured 2026-09-13 04:20Z
// wall both seats decided to SEND (the recovery helper's spawn is gated on the
// same `shouldSend`, and both helpers ran and parked to 09:00 UTC). Everything
// after that decision was unrecorded — `sendMessage` returned void, `fetch`
// resolves on a 4xx, and a network throw was swallowed by a bare `catch {}` —
// so "the bot never sent it", "the bot sent it to a forum topic nobody was
// reading" and "Telegram rejected it" were indistinguishable from both ends.
//
// These arms execute the real hook against a LOCAL Bot API stub (TELEGRAM_API_BASE)
// and assert what was actually transmitted: how many calls, to which chat, into
// which topic, and what the hook logged when a send was refused.
//
// Both routing fixtures are the measured shapes:
//   • main   — a telegram DM 11 minutes before the wall → getCallerChat resolves → DM.
//   • olivia — an autonomous turn, no inbound → getGroupTopics → the agent's own
//              forum topic, NOT the operator's DM.
// Routing is asserted, not changed: a Team wall must land exactly where a
// Pro/Max wall lands.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')

const OPERATOR_DM = '1234567890'
const GROUP = '-1009876543210'
const TOPIC = '1417'

// The measured Claude Team wall copy (2026-09-13 04:31 UTC, both seats).
const TEAM_MSG =
  "Usage limit reached again after you continued · continuing automatically at 9am | " +
  "You've hit your org's monthly spend limit · ask your admin to raise it at " +
  'claude.ai/admin-settings/usage · your session limit resets 9am (UTC)'
// The pre-existing Pro/Max copy, for the routing-parity arm.
const PROMAX_MSG = 'Claude usage limit reached · your limit resets 9am (UTC)'

type Call = { chatId: string; threadId?: string; text: string }

let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog: string

// Start the out-of-process Bot API stub and wait for it to report its port.
// Async and out-of-process because the hook is driven with spawnSync (see
// test/helpers/telegram-stub.ts).
async function startStub(mode: 'ok' | 'reject-all' | 'reject-first' = 'ok', env: Record<string, string> = {}) {
  stubLog = join(home, `stub-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: mode, ...env },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) {
      const port = (JSON.parse(first) as { port?: number }).port
      if (port) return `http://127.0.0.1:${port}`
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('telegram stub never bound a port')
}

// Every line after the port line is one transmitted sendMessage.
function calls(): Call[] {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Call & { port?: number })
    .filter(c => c.port === undefined)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sf-sendleg-'))
})
afterEach(() => {
  stub?.kill()
  stub = null
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

// access.json in the isolated HOME: one paired DM plus one group with a topic —
// the shape both measured seats actually carry.
function writeAccess(opts: { group?: boolean } = {}) {
  const dir = join(home, '.claude', 'channels', 'telegram')
  mkdirSync(dir, { recursive: true })
  const access: Record<string, unknown> = { dmPolicy: 'pairing', allowFrom: [OPERATOR_DM] }
  if (opts.group !== false) {
    access.groups = { [GROUP]: { requireMention: false, allowFrom: [OPERATOR_DM], message_thread_id: Number(TOPIC) } }
  }
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
}

// caller: a telegram inbound in the transcript (the main shape).
// autonomous: no inbound at all (the olivia shape) — getCallerChat returns null.
function writeTranscript(kind: 'caller' | 'autonomous'): string {
  const p = join(home, `transcript-${kind}.jsonl`)
  const line =
    kind === 'caller'
      ? JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `<channel source="plugin:telegram:telegram" chat_id="${OPERATOR_DM}" message_id="1" user="op">status?</channel>`,
          },
        })
      : JSON.stringify({ type: 'user', message: { role: 'user', content: 'heartbeat: continue the queue' } })
  writeFileSync(p, line + '\n')
  return p
}

function fireHook(message: string, transcript: string, apiBase: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      message,
      reason: 'usage_limit',
      stopReason: 'rate_limit',
      transcript_path: transcript,
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TELEGRAM_BOT_TOKEN: '000:FAKE', TELEGRAM_API_BASE: apiBase, TMUX: '' },
    timeout: 20000,
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('DIVE-4401 send/route leg', () => {
  const T = 30000

  test('a Team wall on a caller turn reaches the operator DM, once, and says so', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(OPERATOR_DM)
    expect(c[0].threadId).toBeUndefined()
    expect(c[0].text).toMatch(/Usage limit hit/)
    expect(r.stderr).toContain(`route=caller targets=${OPERATOR_DM}`)
    expect(r.stderr).toContain(`send ${OPERATOR_DM}: ok`)
  }, T)

  // Deliverables 2 and 5: the Team copy must route where the Pro/Max copy
  // routes. Same transcript shape, same access config, different wall text.
  test('Team and Pro/Max walls route identically', async () => {
    const base = await startStub()
    writeAccess()
    const team = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    const teamCall = calls()[0]
    // A fresh HOME so the episode dedup stamp cannot suppress the second fire;
    // the stub (and its log) stay put, so both transmissions are on one tape.
    home = mkdtempSync(join(tmpdir(), 'sf-sendleg-'))
    writeAccess()
    const pro = fireHook(PROMAX_MSG, writeTranscript('caller'), base)
    expect(team.code).toBe(0)
    expect(pro.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(2)
    expect(c[1].chatId).toBe(teamCall.chatId)
    expect(c[1].threadId).toBe(teamCall.threadId)
    expect(pro.stderr).toContain('route=caller')
  }, T)

  // The negative control the verifier asked for: getCallerChat EMPTY. This is
  // the olivia shape and it explains the operator's silence — the notice went
  // to the agent's own forum topic, the documented autonomous-turn behaviour,
  // not the DM he was watching. Pinned so a future routing change is deliberate.
  test('an autonomous turn routes to the bound group topic, not the DM', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(GROUP)
    expect(c[0].threadId).toBe(TOPIC)
    expect(c.some(x => x.chatId === OPERATOR_DM)).toBe(false)
    expect(r.stderr).toContain(`route=group-topics targets=${GROUP}:${TOPIC}`)
  }, T)

  test('five repeats of one wall episode send exactly once', async () => {
    const base = await startStub()
    writeAccess()
    const transcript = writeTranscript('caller')
    let sends = 0
    let suppress = 0
    for (let i = 0; i < 5; i++) {
      const r = fireHook(TEAM_MSG, transcript, base)
      expect(r.code).toBe(0)
      if (/ratelimit dedup: SEND/.test(r.stderr)) sends++
      if (/ratelimit dedup: suppress/.test(r.stderr)) suppress++
    }
    expect(sends).toBe(1)
    expect(suppress).toBe(4)
    // The decision AND the transmission: four suppressions must also mean four
    // messages that never went out, which the old void return could not prove.
    expect(calls().length).toBe(1)
  }, T)

  test('a rejected send is reported with status and reason, not swallowed', async () => {
    const base = await startStub('reject-all')
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`REJECTED ${GROUP}:${TOPIC} — http 400 — message thread not found`)
    expect(r.stderr).toContain(`send ${GROUP}:${TOPIC}: FAILED`)
  }, T)

  test('when every routed send fails the notice falls back to the paired DM', async () => {
    const base = await startStub('reject-first')
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(2)
    expect(c[1].chatId).toBe(OPERATOR_DM)
    expect(c[1].threadId).toBeUndefined()
    expect(c[1].text).toMatch(/Usage limit hit/)
    expect(r.stderr).toContain(`falling back to ${OPERATOR_DM}`)
    expect(r.stderr).toContain(`fallback send ${OPERATOR_DM}: ok`)
  }, T)

  // The fallback must not become a fan-out: a delivered notice stays where it
  // was routed.
  test('a successful routed send never fans out to the other paired chats', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)
    expect(r.stderr).not.toContain('falling back')
  }, T)

  // No paired chat left to try: the hook must say the notice was lost rather
  // than exit 0 looking successful.
  test('a total failure with nowhere to fall back to is stated explicitly', async () => {
    const base = await startStub('reject-all', { STUB_STATUS: '403', STUB_DESC: 'bot was blocked by the user' })
    writeAccess({ group: false })
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)
    expect(r.stderr).toContain('http 403 — bot was blocked by the user')
    expect(r.stderr).toContain('no other paired chat to fall back to')
  }, T)
})
