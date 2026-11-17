// DIVE-8610: an office box moved its AI server to another model and every agent
// kept asking for the old one. The server answered 404, Claude Code drew
// "There's an issue with the selected model (…)", and the web chat showed
// "Working…" with no line at all: the dashboard StopFailure hook had no class
// for a refused model and left it alone. These pin the class (each live text,
// plus negative controls), then drive the REAL dashboard hook.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { classifyFailure, MODEL_NOTICE } from '../plugins/telegram/hooks/lib/failure.ts'
import { noticeText } from '../plugins/dashboard/hooks/lib/dashboard-chat.ts'

const DASH_HOOK = join(import.meta.dir, '..', 'plugins', 'dashboard', 'hooks', 'stopfailure-notify.ts')

// Claude Code's own line, and what Ollama / vLLM / an Anthropic-shape server send.
const CC_LINE = "There's an issue with the selected model (claude-haiku-4-5). It may not exist or you may not have access to it. Run /model to pick a different model."
const OLLAMA_404 = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model \\"claude-haiku-4-5\\" not found, try pulling it first"}}'
const VLLM_404 = 'The model `qwen-a:7b` does not exist.'

const classify = (payload: Record<string, unknown>, pane = '') => classifyFailure(payload, JSON.stringify(payload), pane)

describe('DIVE-8610 classifyFailure: a refused model is its own kind', () => {
  test("Claude Code's selected-model line, in the payload", () => {
    const k = classify({ error: 'invalid_request', message: CC_LINE })
    expect(k.isModelRefused).toBe(true)
    expect(k.isTransientApiError).toBe(false)
    expect(k.isRateLimit).toBe(false)
  })

  test("Ollama's 404 not_found_error, in the payload", () => {
    expect(classify({ message: OLLAMA_404 }).isModelRefused).toBe(true)
  })

  test("vLLM's does-not-exist line, in the payload", () => {
    expect(classify({ message: VLLM_404 }).isModelRefused).toBe(true)
  })

  test("the selected-model line only on the pane (Claude Code's ⎿ status line)", () => {
    expect(classify({ message: 'turn failed' }, `> hi\n  ⎿  ${CC_LINE}\n`).isModelRefused).toBe(true)
  })

  test('negative control: model words in pane prose, or a quoted line, are conversation', () => {
    expect(classify({ message: 'turn failed' }, 'The client asked why the model was not found yesterday').isModelRefused).toBe(false)
    expect(classify({ message: 'turn failed' }, `> why did I get "${CC_LINE}"?`).isModelRefused).toBe(false)
  })

  test('negative control: a 402, a usage limit and a 529 keep their own kind', () => {
    const credit = classify({ message: 'API Error: 402 This request requires at least $0.50 in balance' })
    expect(credit.isOutOfCredit).toBe(true)
    expect(credit.isModelRefused).toBe(false)
    const limit = classify({ error: 'rate_limit', message: "You've hit your usage limit · resets 5pm" })
    expect(limit.isRateLimit).toBe(true)
    expect(limit.isModelRefused).toBe(false)
    const blip = classify({ message: 'turn failed' }, 'API Error: 529 Overloaded')
    expect(blip.isTransientApiError).toBe(true)
    expect(blip.isModelRefused).toBe(false)
  })

  test('the notice names no model, no code and no command', () => {
    for (const lang of ['en', 'ru'] as const) {
      expect(MODEL_NOTICE[lang]).not.toMatch(/404|\/model|claude|qwen|\d|sudo|5dive/i)
      expect(noticeText('model', null, 0, lang)).toBe(MODEL_NOTICE[lang])
      expect(noticeText('model', 1, 0, lang, true)).toBe(MODEL_NOTICE[lang])
    }
  })
})

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dive8610-')) })
afterEach(() => { try { rmSync(home, { recursive: true, force: true }) } catch {} })

const dashInbound = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: `<channel source="plugin:dashboard:dashboard" chat_id="dashboard" user="anna" ts="2026-11-17T02:25:00Z">${text}</channel>` },
})

function transcript(entries: unknown[]): string {
  const p = join(home, 'transcript.jsonl')
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return p
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USER: 'agent-assistant', TMUX: '', ...extra }
  for (const k of ['CLAUDE_CONFIG_DIR', 'DASHBOARD_STATE_DIR', 'TELEGRAM_STATE_DIR', 'TELEGRAM_PROFILE', 'ANTHROPIC_BASE_URL']) {
    if (!(k in extra)) delete env[k]
  }
  return env
}

// A pane to drive, so an arm can prove NO resume helper starts.
function withTmux(env: Record<string, string>): Record<string, string> {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = display ] && echo "agent-assistant:0.0"\nexit 0\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  const bun = join(home, 'fake-bun.sh')
  writeFileSync(bun, `#!/bin/sh\necho "$@" >> ${home}/helper.log\n`)
  chmodSync(bun, 0o755)
  return { ...env, TMUX: `${home}/sock,1,0`, PATH: `${bin}:${env.PATH}`, DASHBOARD_RESUME_BUN: bun }
}

function fireDash(payload: Record<string, unknown>, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [DASH_HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 20000 })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

const stateDir = () => join(home, '.claude', 'channels', 'dashboard')
const outbox = () => join(stateDir(), 'notice-outbox')
const notices = () =>
  (existsSync(outbox()) ? readdirSync(outbox()).filter(n => n.endsWith('.json')) : []).map(
    n => JSON.parse(readFileSync(join(outbox(), n), 'utf8')) as { chat_id: string; text: string },
  )
const helperLog = () => (existsSync(join(home, 'helper.log')) ? readFileSync(join(home, 'helper.log'), 'utf8') : '')

describe('DIVE-8610 dashboard hook', () => {
  const T = 30000

  test('the person who wrote gets ONE plain line, the chat stops "Working…", and no resume helper starts', () => {
    const env = withTmux(baseEnv())
    const tp = transcript([dashInbound('Can you draft the engagement letter for the Novak file?')])
    const first = fireDash({ error: 'invalid_request', message: CC_LINE, transcript_path: tp }, env)
    expect(first.code).toBe(0)
    expect(first.stderr).toContain('model dedup: SEND')
    // The agent re-fails on the same message: still one line.
    fireDash({ message: OLLAMA_404, transcript_path: tp }, env)
    const n = notices()
    expect(n.length).toBe(1)
    expect(n[0].chat_id).toBe('dashboard')
    expect(n[0].text).toBe(MODEL_NOTICE.en)
    expect(helperLog()).toBe('')
    expect(existsSync(join(stateDir(), 'turn-ended'))).toBe(true)
  }, T)

  test('a Russian message gets the line in Russian', () => {
    fireDash({ message: CC_LINE, transcript_path: transcript([dashInbound('Подготовь, пожалуйста, договор')]) }, baseEnv())
    expect(notices().map(n => n.text)).toEqual([MODEL_NOTICE.ru])
  }, T)

  test('negative control: a plain stop with no model words still posts nothing', () => {
    const r = fireDash({ message: 'turn failed', transcript_path: transcript([dashInbound('hello')]) }, baseEnv())
    expect(r.stderr).toContain('nothing to do here')
    expect(notices().length).toBe(0)
  }, T)
})
