// plugins/dashboard/openclawdispatch.ts — the web chat for an OpenClaw seat (DIVE-7349).
//
// An OpenClaw seat with a channel runs `openclaw gateway run` in its pane, and
// the gateway is what answers: it owns the sessions, the model and the tools.
// `openclaw agent` is its scripted front door — one turn through the running
// gateway, the reply printed as JSON (`{ status, runId, result: { payloads } }`,
// read from openclaw 2026.10.9's agent-via-gateway) — so on an OpenClaw seat the dashboard
// server runs in its Codex adapter shape (messages land in the dispatcher inbox,
// answers leave through the dispatcher outbox, which already speaks a voice
// note's answer) and THIS module plays the dispatcher: one `openclaw agent`
// turn per web-chat message, always in the same gateway session, so the chat is
// one conversation. A native OpenClaw channel would replace this module and
// keep the same spool; that is the upstream half of the row.
//
// A turn that fails ends in a short notice in the chat, never in silence.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { routeOf, writeOutbox, type InboxMessage, type Route } from './grokdispatch.ts'

export const OPENCLAW_HEADER = '[5dive web chat. Your answer here goes back to this chat as you write it.]'
export const VOICE_HINT = '[It was spoken: answer in one to three short sentences with no lists, links or code; your answer is spoken back.]'
export const NO_ANSWER_TEXT = 'OpenClaw worked on your message but did not write an answer. Try asking again.'
export const FAILED_TEXT = 'OpenClaw could not answer just now. Try again in a minute.'
export const NOT_RUNNING_TEXT = 'OpenClaw is not running on this computer right now, so it cannot answer. Try again in a minute.'

// The one gateway session the web chat talks in (`agent:<default agent>:5dive-webchat`).
export const SESSION_KEY = '5dive-webchat'

/** What one web-chat message becomes as an OpenClaw turn. */
export function promptFor(msg: InboxMessage): string {
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  const path = typeof msg.image_path === 'string' && msg.image_path.startsWith('/') ? msg.image_path : ''
  const parts = [OPENCLAW_HEADER]
  if (msg.route?.voice === true) parts.push(VOICE_HINT)
  if (text) parts.push(text)
  if (path) parts.push(/\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i.test(path) ? `[Voice note: ${path}]` : `[Attached file: ${path}]`)
  return parts.join('\n')
}

export type TurnResult =
  | { kind: 'reply'; text: string; files: string[] }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string; accepted: boolean }

function payloadsOf(o: unknown, depth = 0): unknown[] | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (Array.isArray(r.payloads)) return r.payloads
  if (depth < 3) {
    for (const k of ['result', 'reply', 'data']) {
      const p = payloadsOf(r[k], depth + 1)
      if (p) return p
    }
  }
  return null
}

/**
 * Reads `openclaw agent --json` stdout. The reply is `payloads[]` (text plus
 * any media), at the top or under `result`; a failure is `ok: false` with
 * `error.message`, and carries `runId` once the gateway accepted the turn.
 */
export function parseTurn(stdout: string, code: number | null): TurnResult {
  let o: Record<string, unknown> | null = null
  const trimmed = stdout.trim()
  try { o = JSON.parse(trimmed.slice(trimmed.indexOf('{'))) } catch {}
  if (!o) return { kind: 'failed', reason: code === 0 ? 'unreadable output' : `exit ${code}`, accepted: false }
  const err = o.error as Record<string, unknown> | undefined
  const status = typeof o.status === 'string' ? o.status : ''
  if (o.ok === false || (status && status !== 'ok' && status !== 'completed')) {
    const reason = typeof err?.message === 'string' ? err.message : status || 'error'
    return { kind: 'failed', reason, accepted: typeof o.runId === 'string' }
  }
  const texts: string[] = []
  const files: string[] = []
  for (const p of payloadsOf(o) ?? []) {
    if (!p || typeof p !== 'object') continue
    const r = p as Record<string, unknown>
    if (r.isReasoning === true || r.kind === 'reasoning') continue
    if (typeof r.text === 'string' && r.text.trim()) texts.push(r.text.trim())
    for (const m of [r.mediaUrl, ...(Array.isArray(r.mediaUrls) ? r.mediaUrls : [])]) {
      if (typeof m === 'string' && m.startsWith('/') && existsSync(m) && !files.includes(m)) files.push(m)
    }
  }
  if (!texts.length && typeof o.final === 'string' && o.final.trim()) texts.push(o.final.trim())
  if (!texts.length && !files.length) return { kind: 'empty' }
  return { kind: 'reply', text: texts.join('\n\n') || 'Here is the file.', files }
}

export type RunTurn = (prompt: string) => Promise<{ stdout: string; stderr: string; code: number | null }>

/**
 * Runs one turn through the seat's gateway with `openclaw agent`. The message
 * rides a 0600 file in the seat's own spool, never argv (any user on the box
 * can read argv in `ps`); the gateway-backed `agent` opens --message-file as a
 * path, so `-` for stdin is not an option there.
 */
export function openclawTurn(bin: string, turnDir: string, timeoutS = 600): RunTurn {
  let n = 0
  return prompt => new Promise(resolve => {
    mkdirSync(turnDir, { recursive: true, mode: 0o700 })
    const file = join(turnDir, `turn-${process.pid}-${n++}.txt`)
    try { writeFileSync(file, prompt, { mode: 0o600 }) } catch (err) {
      resolve({ stdout: '', stderr: `could not write the turn file: ${err}`, code: null })
      return
    }
    execFile(bin, ['agent', '--session-key', SESSION_KEY, '--message-file', file, '--json', '--timeout', String(timeoutS)], {
      maxBuffer: 16 * 1024 * 1024,
      // Backstop past the turn's own deadline, so a gateway that never answers cannot wedge the queue.
      timeout: (timeoutS + 60) * 1000,
    }, (err, stdout, stderr) => {
      try { unlinkSync(file) } catch {}
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
    })
  })
}

export type OpenclawDispatcherOptions = {
  inboxDir: string
  outboxDir: string
  run: RunTurn
  log?: (line: string) => void
  // A turn refused before the gateway took it (still booting, restarting) is retried this often.
  retries?: number
  retryMs?: number
}

const NOT_RUNNING = /ECONNREFUSED|gateway (is )?not running|could not connect|connect failed|gateway closed|no gateway/i

export function startOpenclawDispatcher(o: OpenclawDispatcherOptions): { stop(): void; idle(): Promise<void> } {
  const log = o.log ?? (line => process.stderr.write(line + '\n'))
  const retries = o.retries ?? 3
  const retryMs = o.retryMs ?? 10_000
  let seq = 0
  const reply = (route: Route, text: string, files: string[] = []) => {
    writeOutbox(o.outboxDir, { ...route, text, kind: 'message', ...(files.length ? { files } : {}) }, `${Date.now()}-${process.pid}-openclaw-${seq++}`)
  }
  mkdirSync(o.inboxDir, { recursive: true, mode: 0o700 })

  const answer = async (msg: InboxMessage) => {
    const route = routeOf(msg)
    const prompt = promptFor(msg)
    for (let attempt = 0; ; attempt++) {
      const { stdout, stderr, code } = await o.run(prompt)
      const turn = parseTurn(stdout, code)
      if (turn.kind === 'reply') {
        reply(route, turn.text, turn.files)
        log(`dashboard openclaw: answered ${String(msg.id ?? '?')} (${turn.text.length} chars, ${turn.files.length} files)`)
        return
      }
      if (turn.kind === 'empty') {
        reply({ source: 'dashboard', chat_id: route.chat_id }, NO_ANSWER_TEXT)
        log(`dashboard openclaw: ${String(msg.id ?? '?')} ended with no answer`)
        return
      }
      const notRunning = NOT_RUNNING.test(`${turn.reason}\n${stderr}`)
      // Only a turn the gateway never accepted is safe to send again.
      if (!turn.accepted && attempt < retries) {
        log(`dashboard openclaw: ${String(msg.id ?? '?')} not taken (${turn.reason.slice(0, 160)}); retrying in ${Math.round(retryMs / 1000)}s`)
        await new Promise(r => setTimeout(r, retryMs))
        continue
      }
      reply({ source: 'dashboard', chat_id: route.chat_id }, notRunning ? NOT_RUNNING_TEXT : FAILED_TEXT)
      log(`dashboard openclaw: ${String(msg.id ?? '?')} failed: ${turn.reason.slice(0, 300)} ${stderr.trim().split('\n').pop()?.slice(0, 300) ?? ''}`)
      return
    }
  }

  // One turn at a time, in arrival order: they share one gateway session.
  let chain = Promise.resolve()
  const seen = new Set<string>()
  const ingest = (name: string) => {
    if (!name.endsWith('.json') || name.startsWith('.') || seen.has(name)) return
    const full = join(o.inboxDir, name)
    let msg: InboxMessage
    try { msg = JSON.parse(readFileSync(full, 'utf8')) } catch { return }   // mid-rename, or already taken
    seen.add(name)
    try { unlinkSync(full) } catch {}
    chain = chain.then(() => answer(msg)).catch(err => log(`dashboard openclaw: turn failed: ${err}`))
      .finally(() => seen.delete(name))
  }
  const drain = () => { try { for (const n of readdirSync(o.inboxDir).sort()) ingest(n) } catch {} }
  drain()
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(o.inboxDir, (_e, n) => { if (n) ingest(String(n)) })
    // A watch error is not fatal: the sweep below still reads the inbox.
    watcher.on('error', err => log(`dashboard openclaw: inbox watch error: ${err}`))
  } catch (err) { log(`dashboard openclaw: inbox watch failed: ${err}`) }
  const sweep = setInterval(drain, 1_000)
  sweep.unref?.()
  log(`dashboard openclaw: web chat bridge up (inbox ${o.inboxDir})`)
  return { stop() { clearInterval(sweep); watcher?.close() }, idle: () => chain }
}
