// DIVE-5419: liveness after the ack is the BRIDGE's job, not the model's.
//
// THE BURN (main, 2026-10-02, session b80088fe): 46 tool calls, 4 of them
// edit_message progress edits forced by the silence watchdog, one forced Stop
// turn to react to an "ok", and 24 watchdog injections left in context. Each
// forced call re-reads the whole conversation (~110k prompt tokens late in the
// session), so ~1 call in 10 went to "still here". Cause: the "typing…" loop
// stopped at the first reply — the ack — and the watchdog re-fired every 5
// calls / 60s after it, so the model filled the gap by hand.
//
// The done-when on the row, scripted here: one inbound, an ack, ~10 tool calls
// over ~3 minutes →
//   (A) the model receives NO watchdog injection after its ack;
//   (B) "typing…" runs until the turn ends, not until the first reply;
//   (C) ≥1 server-driven status edit lands on the ack, and comes back off at
//       turn end — so nothing pushes the model toward edit_message;
//   (D) a bare "ok" never forces a Stop turn;
//   (E) the step label never carries command text, paths or secrets (DIVE-4123).
// On today's main (0.5.85) arms A1, B1-B3, C* (no ackstatus.ts) and D1 are red.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { decideNag } from '../plugins/telegram/hooks/lib/silence-decision'
import type { SilenceState } from '../plugins/telegram/hooks/lib/types'
import { createAckStatus, statusLine, STATUS_THROTTLE_MS, FALLBACK_LABEL } from '../plugins/telegram/ackstatus'
import { labelFor, sanitizeLabel } from '../plugins/telegram/hooks/lib/status-label'
import { analyzeTurn, isBareAck } from '../plugins/telegram/hooks/lib/transcript'
import type { TranscriptEntry } from '../plugins/telegram/hooks/lib/types'

const ROOT = join(import.meta.dir, '..', 'plugins', 'telegram')
const SERVER = readFileSync(join(ROOT, 'server.ts'), 'utf8')
const TG = 'mcp__plugin_telegram_telegram__'
const CHAT = '1234567890'
const FIRST_FIRE = 60

// ── (A) the watchdog: one nudge for a missing ack, none after it ─────────────

// Drive the watchdog's decision exactly as the hook does: one decideNag per
// tool call, stamping lastReminderAt when it fires. Returns the call indexes
// that would have injected a reminder.
function runSession(opts: { ackAt: number | null; calls: number[] }): number[] {
  const T0 = 100_000
  let state: SilenceState = { lastInboundAt: T0, toolCallsSinceReply: 0 }
  const fired: number[] = []
  opts.calls.forEach((dt, i) => {
    const now = T0 + dt
    if (opts.ackAt !== null && dt >= opts.ackAt && !state.lastReplyAt) {
      state = { ...state, lastReplyAt: T0 + opts.ackAt, lastContactAt: T0 + opts.ackAt, toolCallsSinceReply: 0 }
    }
    const calls = (state.toolCallsSinceReply ?? 0) + 1
    const d = decideNag(state, now, FIRST_FIRE, calls)
    if (d.shouldFire) fired.push(i)
    state = { ...state, toolCallsSinceReply: calls, lastReminderAt: d.shouldFire ? now : state.lastReminderAt }
  })
  return fired
}
// ~10 tool calls over ~3 minutes.
const TEN_CALLS_3MIN = [5, 25, 40, 55, 75, 95, 120, 140, 160, 185]

describe('(A) the watchdog fires once for a missing ack, never after one', () => {
  test('A1 THE ROW: ack at 10s, then 10 calls over 3 min → zero injections', () => {
    expect(runSession({ ackAt: 10, calls: TEN_CALLS_3MIN })).toEqual([])
  })

  test('A2 no ack at all → exactly ONE injection, once past 60s', () => {
    const fired = runSession({ ackAt: null, calls: TEN_CALLS_3MIN })
    expect(fired.length).toBe(1)
    expect(TEN_CALLS_3MIN[fired[0]]).toBeGreaterThan(FIRST_FIRE)
  })

  test('A3 a late ack (90s) → one injection before it, none after', () => {
    const fired = runSession({ ackAt: 90, calls: TEN_CALLS_3MIN })
    expect(fired.length).toBe(1)
    expect(TEN_CALLS_3MIN[fired[0]]).toBeLessThan(90)
  })

  test('A4 the call COUNT alone never fires (old rule: >=5 calls inside 60s)', () => {
    expect(runSession({ ackAt: null, calls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toEqual([])
  })

  test('A5 contact from BEFORE the inbound is not its ack', () => {
    const d = decideNag({ lastInboundAt: 1000, lastContactAt: 500, lastReplyAt: 500 }, 1000 + 61, FIRST_FIRE, 1)
    expect(d.shouldFire).toBe(true)
    expect(d.sinceInbound).toBe(61)
  })

  test('A6 the injected text points at the bridge, not at edit_message progress', () => {
    const hook = readFileSync(join(ROOT, 'hooks', 'silence-watchdog.ts'), 'utf8')
    expect(hook).toContain('do not spend edit_message on progress')
    expect(hook).not.toContain('Edit your last reply')
  })
})

// ── (B) "typing…" runs for the whole turn ──────────────────────────────────

describe('(B) the typing loop ends with the turn, not with the first reply', () => {
  const caseBody = (name: string): string => {
    const start = SERVER.indexOf(`case '${name}': {`)
    expect(start).toBeGreaterThan(-1)
    return SERVER.slice(start, SERVER.indexOf("      case '", start + 10))
  }
  const fnBody = (name: string): string => {
    const start = SERVER.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    return SERVER.slice(start, SERVER.indexOf('\n}\n', start))
  }

  test('B1 THE ROW: the reply tool no longer stops the loop', () => {
    expect(caseBody('reply')).not.toContain('stopTypingLoop(')
  })

  test('B2 the ceiling is a crash guard well above a long turn (>= 30 min)', () => {
    const m = /const TYPING_CEILING_MS = ([\d_ *]+)/.exec(SERVER)
    expect(m).not.toBeNull()
    const ms = Function(`return ${m![1].replace(/_/g, '')}`)() as number
    expect(ms).toBeGreaterThanOrEqual(30 * 60 * 1000)
  })

  test('B3 the tick drives the status, and a stopped loop takes it back off', () => {
    expect(fnBody('startTypingLoop')).toContain('ackStatus.tick(chat_id)')
    expect(fnBody('stopTypingLoop')).toContain('ackStatus.endTurn(chat_id)')
  })

  test('B4 the turn-end signal still stops it (DIVE-146 path kept)', () => {
    expect(fnBody('startTypingLoop')).toContain('statSync(TYPING_STOP_FILE).mtimeMs > startedAt')
  })

  test('B5 a stale ceiling timer cannot stop a LATER loop for the same chat', () => {
    expect(fnBody('startTypingLoop')).toContain('typingLoops.get(chat_id) === handle')
  })

  test('B6 the reply hands its last text chunk to ackStatus, and opens a loop if none runs', () => {
    const body = caseBody('reply')
    expect(body).toContain('ackStatus.noteReply(')
    expect(body).toContain('startTypingLoop(chat_id, { quiet: true })')
  })

  test('B7 a model edit waits out the server\'s own edit and re-bases the ack', () => {
    const body = caseBody('edit_message')
    expect(body).toContain('await ackStatus.beforeEdit(chat_id)')
    expect(body).toContain('ackStatus.afterEdit(chat_id, message_id, finalText, editParseMode)')
    expect(body).toContain('ackStatus.afterEdit(chat_id, message_id, null)')
  })
})

// ── (C) the server-driven status line ──────────────────────────────────────

type Edit = { at: number; messageId: number; text: string; parseMode?: string }
function harness(labels: Array<{ at: number; label: string }> = []) {
  let clock = 1_000_000
  const edits: Edit[] = []
  const pending: Array<() => void> = []
  let holdEdits = false
  const ack = createAckStatus({
    now: () => clock,
    readLabel: () => {
      const seen = labels.filter((l) => l.at <= clock)
      return seen.length ? seen[seen.length - 1] : null
    },
    edit: (_chat, messageId, text, parseMode) => {
      edits.push({ at: clock, messageId, text, parseMode })
      if (!holdEdits) return Promise.resolve(true)
      return new Promise((r) => pending.push(() => r(true)))
    },
  })
  return {
    ack,
    edits,
    get now() { return clock },
    advance(ms: number) { clock += ms },
    hold() { holdEdits = true },
    release() { holdEdits = false; while (pending.length) pending.shift()!() },
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('(C) the ack carries a hook-driven status until the turn ends', () => {
  test('C1 THE ROW: ack at 10s, ticks every 4s for 3 min → >=1 status edit, spaced >= 30s, cleared at the end', async () => {
    const t0 = 1_000_000 // harness clock start
    const h2 = harness([
      { at: t0 + 15_000, label: 'Running the unit tests' },
      { at: t0 + 90_000, label: 'Reading files' },
    ])
    h2.ack.beginTurn(CHAT)
    h2.advance(10_000)
    const ackAt = h2.now
    h2.ack.noteReply(CHAT, 77, 'On it — checking the login flow.')
    for (let t = 0; t < 180_000; t += 4_000) {
      h2.advance(4_000)
      await h2.ack.tick(CHAT)
    }
    const statusEdits = h2.edits.filter((e) => e.text.includes('⏳'))
    expect(statusEdits.length).toBeGreaterThanOrEqual(1)
    expect(statusEdits.every((e) => e.messageId === 77)).toBe(true)
    expect(statusEdits[0].text.startsWith('On it — checking the login flow.\n\n⏳ ')).toBe(true)
    expect(statusEdits.some((e) => e.text.includes('Running the unit tests'))).toBe(true)
    for (let i = 1; i < statusEdits.length; i++) {
      expect(statusEdits[i].at - statusEdits[i - 1].at).toBeGreaterThanOrEqual(STATUS_THROTTLE_MS)
    }
    // Nothing in the first 30s after the ack.
    expect(statusEdits[0].at - ackAt).toBeGreaterThanOrEqual(STATUS_THROTTLE_MS)
    await h2.ack.endTurn(CHAT)
    const last = h2.edits[h2.edits.length - 1]
    expect(last.text).toBe('On it — checking the login flow.')
  })

  test('C2 no ack yet → no edit at all (the watchdog owns that gap)', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    for (let i = 0; i < 30; i++) { h.advance(4_000); await h.ack.tick(CHAT) }
    expect(h.edits).toEqual([])
  })

  test('C3 a label from a previous turn is not reused — the fallback shows', async () => {
    const h = harness([{ at: 1, label: 'Old step' }])
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, 'ack')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT)
    expect(h.edits.length).toBe(1)
    expect(h.edits[0].text).toContain(FALLBACK_LABEL)
    expect(h.edits[0].text).not.toContain('Old step')
  })

  test('C4 an unchanged line is not re-sent (minute granularity caps a long think)', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.advance(65_000)
    h.ack.noteReply(CHAT, 5, 'ack')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT) // 95s → "1m"
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT) // 125s → "2m", changed
    h.advance(1_000)
    await h.ack.tick(CHAT) // throttled
    const status = h.edits.filter((e) => e.text.includes('⏳'))
    expect(status.length).toBe(2)
    expect(new Set(status.map((e) => e.text)).size).toBe(2)
  })

  test('C5 a newer reply becomes the ack; the older one gets its line back off', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, 'first')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT)
    h.ack.noteReply(CHAT, 6, 'second')
    await flush()
    expect(h.edits.map((e) => [e.messageId, e.text.includes('⏳')])).toEqual([[5, true], [5, false]])
    expect(h.edits[1].text).toBe('first')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT)
    expect(h.edits[2].messageId).toBe(6)
  })

  test('C6 a message with buttons is never a target (an edit would strip them)', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, 'Ship it?', undefined, true)
    for (let i = 0; i < 20; i++) { h.advance(4_000); await h.ack.tick(CHAT) }
    expect(h.edits).toEqual([])
  })

  test('C7 the model\'s own edit re-bases the ack and waits out an in-flight status edit', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, 'ack')
    h.advance(STATUS_THROTTLE_MS)
    h.hold()
    void h.ack.tick(CHAT)
    let modelEditStarted = false
    const before = h.ack.beforeEdit(CHAT).then(() => { modelEditStarted = true })
    await flush()
    expect(modelEditStarted).toBe(false) // still waiting on the server's edit
    h.release()
    await before
    expect(modelEditStarted).toBe(true)
    // While the model edit is held, ticks stay off.
    h.advance(STATUS_THROTTLE_MS)
    expect(h.ack.tick(CHAT)).toBeNull()
    h.ack.afterEdit(CHAT, 5, 'ack\n\n→ found the cause')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT)
    const last = h.edits[h.edits.length - 1]
    expect(last.text.startsWith('ack\n\n→ found the cause\n\n⏳ ')).toBe(true)
  })

  test('C8 turn end while a status edit is in flight still restores — after it lands', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, 'ack')
    h.advance(STATUS_THROTTLE_MS)
    h.hold()
    void h.ack.tick(CHAT)
    const ended = h.ack.endTurn(CHAT)
    h.release()
    await ended
    expect(h.edits.map((e) => e.text)).toEqual([expect.stringContaining('⏳'), 'ack'])
  })

  test('C9 MarkdownV2 acks get an escaped status line', async () => {
    const h = harness()
    h.ack.beginTurn(CHAT)
    h.ack.noteReply(CHAT, 5, '*On it*', 'MarkdownV2')
    h.advance(STATUS_THROTTLE_MS)
    await h.ack.tick(CHAT)
    expect(h.edits[0].parseMode).toBe('MarkdownV2')
    expect(h.edits[0].text).toMatch(/^\*On it\*\n\n⏳ Working · \d+s$/)
    expect(statusLine('a.b', 0)).toBe('⏳ a.b · 0s')
  })

  test('C10 a reply outside any turn is ignored (no state, no edits)', async () => {
    const h = harness()
    h.ack.noteReply(CHAT, 5, 'ack')
    h.advance(STATUS_THROTTLE_MS * 3)
    expect(h.ack.tick(CHAT)).toBeNull()
    expect(h.edits).toEqual([])
  })

  test('C11 lite gets "typing…" only — no status edits on a client\'s chat', () => {
    const start = SERVER.indexOf("case 'reply': {")
    const body = SERVER.slice(start, SERVER.indexOf("      case '", start + 10))
    expect(body).toMatch(/if \(!LITE\) ackStatus\.noteReply\(/)
  })
})

// ── (D) the Stop hook ──────────────────────────────────────────────────────

const HOOK = join(ROOT, 'hooks', 'stop-reply-check.ts')
const inbound = (body: string, extra = '') =>
  ({
    type: 'user',
    message: { content: `<channel source="plugin:telegram:telegram" chat_id="${CHAT}" message_id="50" user="lodar"${extra}>${body}</channel>` },
  }) as unknown as TranscriptEntry

let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''
let apiBase = ''

function runHook(entries: TranscriptEntry[]): { code: number; sent: string[]; stdout: string } {
  const transcript = join(home, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcript, stop_hook_active: false }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      TELEGRAM_STATE_DIR: join(home, 'state'),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TMUX: '',
    },
    timeout: 20000,
  })
  const sent = readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { port?: number; text?: string })
    .filter((c) => c.port === undefined)
    .map((c) => c.text ?? '')
  return { code: r.status ?? -1, sent, stdout: r.stdout ?? '' }
}

describe('(D) the Stop hook', () => {
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dive5419-'))
    mkdirSync(join(home, 'state'), { recursive: true })
    stubLog = join(home, 'stub.jsonl')
    writeFileSync(stubLog, '')
    stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
      env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: 'ok' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 200; i++) {
      const first = readFileSync(stubLog, 'utf8').split('\n')[0]
      if (first) {
        const port = (JSON.parse(first) as { port?: number }).port
        if (port) { apiBase = `http://127.0.0.1:${port}`; break }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!apiBase) throw new Error('telegram stub never bound a port')
  })
  afterEach(() => {
    stub?.kill()
    stub = null
    apiBase = ''
    try { rmSync(home, { recursive: true, force: true }) } catch { /* noop */ }
  })

  test('D1 THE ROW: a bare "ok" with nothing back does NOT force a turn', () => {
    const r = runHook([inbound('ok')])
    expect(r.stdout).not.toContain('"block"')
    expect(r.sent).toEqual([])
  })

  test('D2 control: a real request with nothing back still blocks the Stop', () => {
    const r = runHook([inbound('please fix the login page')])
    expect(r.stdout).toContain('"block"')
  })

  test('D3 the turn-end signal fires on EVERY Stop, even one with no inbound', () => {
    const stopFile = join(home, 'state', 'typing-stop')
    const r = runHook([{ type: 'user', message: { content: 'hello from the terminal' } } as unknown as TranscriptEntry])
    expect(r.code).toBe(0)
    expect(existsSync(stopFile)).toBe(true)
    expect(Date.now() - statSync(stopFile).mtimeMs).toBeLessThan(30_000)
  })

  test('D4 the signal comes before the hook\'s first exit', () => {
    const src = readFileSync(HOOK, 'utf8')
    expect(src.indexOf('signalTurnEnded()\n')).toBeGreaterThan(-1)
    expect(src.indexOf('signalTurnEnded()\n')).toBeLessThan(src.indexOf('process.exit('))
  })
})

describe('(D) what counts as a bare acknowledgement', () => {
  test.each(['ok', 'OK.', 'okay!', 'thanks', 'thank you', 'ok thanks', 'got it', '👍', 'cool', 'k'])('%p is bare', (t) => {
    expect(isBareAck(t)).toBe(true)
  })
  test.each(['yes', 'no', 'do it', 'ok do it', 'ok, and also check the logs', 'thanks — now ship it', 'why?', ''])('%p is NOT bare', (t) => {
    expect(isBareAck(t)).toBe(false)
  })
  test('a photo or a button tap is never bare, whatever its text', () => {
    expect(analyzeTurn([inbound('ok', ' image_path="/tmp/x.jpg"')], TG).lastInboundBareAck).toBe(false)
    expect(analyzeTurn([inbound('ok', ' via="button" answers_message_id="9"')], TG).lastInboundBareAck).toBe(false)
    expect(analyzeTurn([inbound('ok')], TG).lastInboundBareAck).toBe(true)
  })
})

// ── (E) the step label never leaks (DIVE-4123) ─────────────────────────────

describe('(E) the step label', () => {
  test('E1 a Bash description is shown, a missing one falls back', () => {
    expect(labelFor('Bash', { description: 'Run the unit tests', command: 'bun test x' }, TG)).toBe('Run the unit tests')
    expect(labelFor('Bash', { command: 'cat ~/.ssh/id_ed25519' }, TG)).toBe('Running a command')
  })

  test('E2 paths, URLs, flags, assignments and token-shaped runs are dropped', () => {
    expect(sanitizeLabel('Read /etc/shadow and ~/.env')).toBe('Read and')
    expect(sanitizeLabel('Fetch https://x.y/z?a=b')).toBe('Fetch')
    expect(sanitizeLabel('Run with --force KEY=abc')).toBe('Run with')
    expect(sanitizeLabel('Check sk_live_abcdefghijklmnopqrstuvwxyz123')).toBe('Check')
    expect(sanitizeLabel('Ping user@example.com')).toBe('Ping')
    expect(sanitizeLabel('/usr/bin/env')).toBeNull()
  })

  test('E3 long descriptions are capped; newlines flattened', () => {
    const l = sanitizeLabel('word '.repeat(40) + '\nsecond line')!
    expect(l.length).toBeLessThanOrEqual(48)
    expect(l).not.toContain('\n')
  })

  test('E4 every other tool maps to a fixed phrase — its input is never read', () => {
    expect(labelFor('Read', { file_path: '/home/x/secret.txt' }, TG)).toBe('Reading files')
    expect(labelFor('Edit', { file_path: '/a', old_string: 'pw', new_string: 'x' }, TG)).toBe('Editing files')
    expect(labelFor('Grep', { pattern: 'password' }, TG)).toBe('Searching files')
    expect(labelFor('mcp__github__create_pr', { title: 'x' }, TG)).toBe('Using a tool')
    expect(labelFor('SomethingNew', { description: 'leak' }, TG)).toBe('Working')
  })

  test('E5 a Telegram tool writes no label (it moves the ack itself)', () => {
    expect(labelFor(`${TG}reply`, { text: 'hi' }, TG)).toBeNull()
  })

  test('E6 the hook is registered on PreToolUse for every tool, and only writes a file', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const pre = hooks.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>
    const entry = pre.find((e) => e.hooks.some((h) => h.command.endsWith('/hooks/status-label.ts')))
    expect(entry).toBeDefined()
    expect(entry!.matcher).toBeUndefined()
    const src = readFileSync(join(ROOT, 'hooks', 'status-label.ts'), 'utf8')
    expect(src).not.toMatch(/fetch\(|sendMessage|editMessageText|emitPostToolContext|permissionDecision/)
  })

  test('E7 the server re-caps whatever it reads from the label file', () => {
    expect(SERVER).toContain('label: j.label.slice(0, 60)')
  })
})
