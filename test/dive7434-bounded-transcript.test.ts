// DIVE-7434 — the hooks read the transcript's TAIL, never the whole file.
//
// Box report 607: stopfailure-notify of both plugins sat 2:56 h at ~350 MB RSS
// each, the seat's cgroup crossed memory.high, every task in it went to D state
// and the Telegram poller died. readEntries parsed the whole session JSONL
// (25.6 MB → 195 MB RSS, measured), and every turn-end and tool hook called it.
//
// These arms drive the REAL hooks against a 60 MB transcript whose last turn
// is longer than the first 1 MB tail window, so the window has to widen to find
// the turn start, and they assert three things: the hook exits well under its
// hooks.json timeout, its peak RSS stays under 120 MB, and it still reads what
// it needs from the tail (the reset time, the turn's text, the a2a envelope).
// Red on the pre-fix tree: each hook peaks at several hundred MB there.

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readEntries, readEntriesFrom, analyzeTurn, findRateLimitText, transcriptSize, TAIL_START_BYTES } from '../plugins/telegram/hooks/lib/transcript.ts'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const TG = (h: string) => join(PLUGINS, 'telegram', 'hooks', h)
const DASH = (h: string) => join(PLUGINS, 'dashboard', 'hooks', h)

const OP = '1234567890'
const TG_PREFIX = 'mcp__plugin_telegram_telegram__'
const MB = 1 << 20
const BIG = 60 * MB
const RSS_CAP_KB = 120 * 1024
const LIMIT_TEXT = "You've hit your limit · resets 9am (UTC)"
const FINAL = 'FINAL-ANSWER-7434'

let fixtures: string
let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog = ''

const line = (e: unknown) => JSON.stringify(e) + '\n'
const inbound = (id: number, text: string) =>
  line({ type: 'user', message: { role: 'user', content: `<channel source="plugin:telegram:telegram" chat_id="${OP}" message_id="${id}" user="op">${text}</channel>` } })
const toolPair = (n: number, pad: string) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'ls' } }] } }) +
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: pad }] } })

// History up to BIG, then the last turn: its opening prompt, ~2.5 MB of tool
// calls (so it starts BEFORE the first tail window) and the given tail.
function build(name: string, opening: string, tail: string): string {
  const p = join(fixtures, name)
  const fd = openSync(p, 'w')
  const pad = 'y'.repeat(8000)
  const old = (i: number) =>
    inbound(i, `old question ${i}`) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } }) +
    toolPair(i, pad) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `r${i}`, name: `${TG_PREFIX}reply`, input: { chat_id: OP, text: 'ok' } }] } })
  let size = 0
  for (let i = 1; size < BIG; i++) size += writeSync(fd, old(i))
  writeSync(fd, opening)
  for (let i = 0; i < 300; i++) writeSync(fd, toolPair(1_000_000 + i, pad))
  writeSync(fd, tail)
  closeSync(fd)
  return p
}

const limitTail = line({
  type: 'assistant',
  error: 'rate_limit',
  isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] },
})
const answerTail = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: FINAL }] } })
const a2aOpening = line({ type: 'user', message: { role: 'user', content: '[5dive-msg from=main id=abc tier=1] run the sweep' } })

let limitPath: string
let answerPath: string
let a2aPath: string

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'dive7434-'))
  limitPath = build('limit.jsonl', inbound(999_999, 'status?'), limitTail)
  answerPath = build('answer.jsonl', inbound(999_999, 'status?'), answerTail)
  a2aPath = build('a2a.jsonl', a2aOpening, answerTail)
})
afterAll(() => rmSync(fixtures, { recursive: true, force: true }))

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dive7434-home-'))
})
afterEach(() => {
  stub?.kill()
  stub = null
  rmSync(home, { recursive: true, force: true })
})

async function startStub(mode: 'ok' | 'hang'): Promise<string> {
  stubLog = join(home, 'stub.jsonl')
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: mode },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) return `http://127.0.0.1:${(JSON.parse(first) as { port: number }).port}`
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('telegram stub never bound a port')
}
const sent = () =>
  readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { port?: number; chatId: string; text: string }).filter(c => c.port === undefined)

function tgState(silence?: object): string {
  const dir = join(home, '.claude', 'channels', 'telegram')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [OP] }))
  if (silence) writeFileSync(join(dir, 'silence.json'), JSON.stringify(silence))
  return dir
}

// Run a hook; return exit code, wall time, peak RSS (KB) and its output.
function run(hook: string, payload: object, env: Record<string, string>, unset: string[] = []) {
  const rssFile = join(home, `rss-${Math.random().toString(36).slice(2)}`)
  const full: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, TMUX: '', PEAK_RSS_FILE: rssFile, ...env }
  for (const k of unset) delete full[k]
  const t0 = Date.now()
  const r = Bun.spawnSync([process.execPath, '--preload', join(import.meta.dir, 'helpers', 'peak-rss.ts'), hook], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: full,
    timeout: 30_000,
  })
  return {
    code: r.exitCode,
    ms: Date.now() - t0,
    rssKb: existsSync(rssFile) ? Number(readFileSync(rssFile, 'utf8')) || Infinity : Infinity,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  }
}

const T = 60_000

describe('DIVE-7434 bounded transcript reads', () => {
  test('readEntries widens past the first window to the turn start, and no further than needed', () => {
    expect(transcriptSize(limitPath)).toBeGreaterThan(BIG)
    const entries = readEntries(limitPath)
    const a = analyzeTurn(entries, TG_PREFIX)
    expect(a.hadInbound).toBe(true)
    expect(a.lastMessageId).toBe('999999')
    expect(a.turnStart).toBeGreaterThan(0) // a window, not the whole file
    expect(entries.length).toBeLessThan(2000)
    expect(findRateLimitText(entries)).toBe(LIMIT_TEXT)
  })

  test('readEntriesFrom returns only what was written after the offset', () => {
    const p = join(home, 'grow.jsonl')
    writeFileSync(p, inbound(1, 'hi'))
    const at = transcriptSize(p)
    expect(readEntriesFrom(p, at)).toEqual([])
    appendFileSync(p, answerTail)
    expect(readEntriesFrom(p, at).map(e => e.type)).toEqual(['assistant'])
    expect(readEntriesFrom(p, at + 10 * MB)).toEqual([]) // replaced/truncated file
  })

  test('a partial first line in the tail window is dropped, not mis-parsed', () => {
    const p = join(home, 'cut.jsonl')
    const filler = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'é'.repeat(TAIL_START_BYTES) }] } })
    writeFileSync(p, filler + inbound(7, 'last'))
    const entries = readEntries(p)
    expect(entries.length).toBeGreaterThan(0)
    expect(analyzeTurn(entries, TG_PREFIX).lastMessageId).toBe('7')
  })

  test('telegram stopfailure-notify: exits fast and small on a 60 MB transcript with a hung Bot API, reset read from the tail', async () => {
    const base = await startStub('hang')
    const r = run(TG('stopfailure-notify.ts'), { message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit', transcript_path: limitPath }, {
      TELEGRAM_STATE_DIR: tgState(),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: base,
    })
    expect(r.ms).toBeLessThan(10_000)
    expect(r.rssKb).toBeLessThan(RSS_CAP_KB)
    expect(r.stderr).toMatch(/reset=\d{10}/)
    expect(r.stderr).toContain(`route=caller targets=${OP}`)
    expect(r.stderr).toContain(`send ${OP}: FAILED`) // the 4 s abort, not a hang
    expect(sent().length).toBeGreaterThan(0)
  }, T)

  test('dashboard stopfailure-notify: same bounds, and the reset epoch reaches the resume helper', () => {
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = display ] && echo "agent-tap:0.0"\nexit 0\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    const fakeBun = join(home, 'fake-bun.sh')
    writeFileSync(fakeBun, `#!/bin/sh\necho "$@" >> ${home}/helper.log\n`)
    chmodSync(fakeBun, 0o755)
    const r = run(DASH('stopfailure-notify.ts'), { message: 'Claude usage limit reached', reason: 'usage_limit', stopReason: 'rate_limit', transcript_path: limitPath }, {
      USER: 'agent-tap',
      TMUX: `${home}/sock,1,0`,
      PATH: `${bin}:${process.env.PATH}`,
      DASHBOARD_RESUME_BUN: fakeBun,
    }, ['DASHBOARD_STATE_DIR', 'CLAUDE_CONFIG_DIR'])
    expect(r.ms).toBeLessThan(10_000)
    expect(r.rssKb).toBeLessThan(RSS_CAP_KB)
    const helper = existsSync(join(home, 'helper.log')) ? readFileSync(join(home, 'helper.log'), 'utf8') : ''
    const epoch = Number(/resume-after-reset\.ts (\d+)/.exec(helper)?.[1] ?? 0)
    expect(epoch).toBeGreaterThan(Math.floor(Date.now() / 1000))
  }, T)

  test('stop-reply-check: bounded, and still relays the answer of a turn longer than the first window', async () => {
    const base = await startStub('ok')
    const r = run(TG('stop-reply-check.ts'), { transcript_path: answerPath, stop_hook_active: false }, {
      TELEGRAM_STATE_DIR: tgState(),
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: base,
    })
    expect(r.ms).toBeLessThan(10_000)
    expect(r.rssKb).toBeLessThan(RSS_CAP_KB)
    const c = sent()
    expect(c.some(m => m.chatId === OP && m.text.includes(FINAL))).toBe(true)
  }, T)

  test('silence-watchdog: bounded, and still sees the a2a envelope that opens a long turn', () => {
    const silence = { lastInboundAt: Math.floor(Date.now() / 1000) - 600 }
    const a2a = run(TG('silence-watchdog.ts'), { transcript_path: a2aPath }, { TELEGRAM_STATE_DIR: tgState(silence) })
    expect(a2a.ms).toBeLessThan(5_000)
    expect(a2a.rssKb).toBeLessThan(RSS_CAP_KB)
    expect(a2a.stdout.trim()).toBe('') // a2a turn: no nag
    // Control: the same silence on a human turn does nag, so the empty output
    // above is the a2a read, not a hook that never got that far.
    const human = run(TG('silence-watchdog.ts'), { transcript_path: answerPath }, { TELEGRAM_STATE_DIR: tgState(silence) })
    expect(human.rssKb).toBeLessThan(RSS_CAP_KB)
    expect(human.stdout.trim()).not.toBe('')
  }, T)
})
