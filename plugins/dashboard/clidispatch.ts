// plugins/dashboard/clidispatch.ts — the web chat for a Pi or OpenCode seat (DIVE-7348).
//
// Neither runtime spawns an MCP server for a channel, and on a Telegram seat
// the Telegram bridge is the seat's main process, so there is no pane to type
// into. Both have a one-shot scripted front door instead, and THIS module plays
// the dispatcher with it, the way openclawdispatch.ts does for OpenClaw: one
// headless turn per web-chat message, always in the same web-chat session, so
// the chat is one conversation.
//
//   pi:       `pi -p --session-dir <spool>/pi-sessions --continue`, the message
//             on stdin, the answer (the last assistant message's text) on
//             stdout; a failed turn exits 1 with the reason on stderr.
//   opencode: `opencode run --format json [--session <id>]`, the message on
//             stdin; JSON events on stdout (`text` parts, `tool_use`, `error`).
//             A failed model call still exits 0, so the events decide. The
//             session id from the first turn is kept in <spool>/opencode-session.
//
// Measured live on 2026-11-06 with pi 1.5.0 and opencode 1.19.5 (an OpenRouter
// key): a second turn remembered the first, opencode ran a tool and answered
// after it. pi 0.80.6 has the same flags and reads stdin the same way.
//
// The message rides stdin, never argv (any user on the box can read argv in
// `ps`). A turn that fails ends in a short notice in the chat, never silence.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { routeOf, writeOutbox, type InboxMessage, type Route } from './grokdispatch.ts'
import { cutItPrompt, replyTooLong, REPLY_CUT_TRIES } from './replycap.ts'

export type CliRuntime = 'pi' | 'opencode'
export const LABEL: Record<CliRuntime, string> = { pi: 'Pi', opencode: 'OpenCode' }

export const CLI_HEADER = '[5dive web chat: a person typed this in the 5dive app. Your final answer is sent back to that chat as you write it.]'
export const VOICE_HINT = '[It was spoken: answer in one to three short sentences with no lists, links or code; your answer is spoken back.]'

export const noAnswerText = (rt: CliRuntime) => `${LABEL[rt]} worked on your message but did not write an answer. Try asking again.`
export const failedText = (rt: CliRuntime) => `${LABEL[rt]} could not answer just now. Try again in a minute.`
export const tooSlowText = (rt: CliRuntime) => `${LABEL[rt]} took too long on this one and stopped. Try a smaller ask.`
export const notInstalledText = (rt: CliRuntime) => `${LABEL[rt]} is not installed on this computer, so it cannot answer.`
/** A failure whose reason we could read: the reason is the useful part (no credits, bad key, unknown model). */
export const failedWithReason = (rt: CliRuntime, reason: string) => `${LABEL[rt]} could not answer: ${reason}`

/** What one web-chat message becomes as a turn. */
export function promptFor(msg: InboxMessage): string {
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  const path = typeof msg.image_path === 'string' && msg.image_path.startsWith('/') ? msg.image_path : ''
  const parts = [CLI_HEADER]
  if (msg.route?.voice === true) parts.push(VOICE_HINT)
  if (text) parts.push(text)
  if (path) parts.push(/\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i.test(path) ? `[Voice note: ${path}]` : `[Attached file: ${path}]`)
  return parts.join('\n')
}

export type TurnResult =
  | { kind: 'reply'; text: string }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string }

/**
 * A provider's error, cut to something a person can read in the chat: no
 * colour codes, no "Error:" prefix, no links or JSON, one sentence, short.
 * Empty when nothing readable is left.
 */
export function plainReason(raw: string): string {
  let s = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
  s = lines.length ? lines[lines.length - 1] : ''
  // "403: {"message":"Key limit exceeded …"}" — take the message out of a JSON tail.
  const j = s.indexOf('{')
  if (j >= 0) {
    try {
      const o = JSON.parse(s.slice(j)) as Record<string, unknown>
      const m = typeof o.message === 'string' ? o.message
        : typeof (o.error as Record<string, unknown> | undefined)?.message === 'string' ? String((o.error as Record<string, unknown>).message) : ''
      if (m) s = m
    } catch {}
  }
  s = s.replace(/^(error|err)\s*:\s*/i, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const stop = s.search(/[.!?](\s|$)/)
  if (stop > 0) s = s.slice(0, stop + 1)
  s = s.replace(/[\s,;:]+$/, '')
  if (s.length > 160) s = s.slice(0, 157).replace(/\s+\S*$/, '') + '…'
  return s.length >= 4 ? s : ''
}

/** `pi -p`: the answer is stdout; a failed turn exits non-zero with the reason on stderr. */
export function parsePiTurn(stdout: string, stderr: string, code: number | null): TurnResult {
  if (code !== 0) return { kind: 'failed', reason: plainReason(stderr) }
  const text = stdout.trim()
  return text ? { kind: 'reply', text } : { kind: 'empty' }
}

export type OpencodeTurn = TurnResult & { sessionId?: string }

/**
 * `opencode run --format json`: one JSON event per line. The answer is the
 * text written after the last tool call (text before a tool call is the model
 * saying what it is about to do); with no text after it, every text part.
 * A failed model call is an `error` event and still exits 0.
 */
export function parseOpencodeTurn(stdout: string, stderr: string, code: number | null): OpencodeTurn {
  let sessionId: string | undefined
  const texts: string[] = []
  let afterTool: string[] = []
  let sawTool = false
  const errors: string[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let ev: Record<string, unknown>
    try { ev = JSON.parse(t) } catch { continue }
    if (typeof ev.sessionID === 'string' && ev.sessionID) sessionId = ev.sessionID
    const part = (ev.part ?? {}) as Record<string, unknown>
    if (ev.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim())
      afterTool.push(part.text.trim())
    } else if (ev.type === 'tool_use') {
      sawTool = true
      afterTool = []
    } else if (ev.type === 'error') {
      const e = (ev.error ?? {}) as Record<string, unknown>
      const d = (e.data ?? {}) as Record<string, unknown>
      const m = typeof d.message === 'string' ? d.message : typeof e.message === 'string' ? e.message : typeof e.name === 'string' ? e.name : ''
      if (m) errors.push(m)
    }
  }
  const chosen = sawTool && afterTool.length ? afterTool : texts
  const base = { ...(sessionId ? { sessionId } : {}) }
  if (chosen.length) return { ...base, kind: 'reply', text: chosen.join('\n\n') }
  if (errors.length) return { ...base, kind: 'failed', reason: plainReason(errors[0]) }
  if (code !== 0) return { ...base, kind: 'failed', reason: plainReason(stderr) }
  return { ...base, kind: 'empty' }
}

export type Proc = { stdout: string; stderr: string; code: number | null; timedOut: boolean; missing: boolean }
export type Spawner = (bin: string, args: string[], input: string, o: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<Proc>

/** Runs one CLI turn with the message on stdin, killed past its deadline. */
export const spawnTurn: Spawner = (bin, args, input, o) => new Promise(resolve => {
  let stdout = '', stderr = '', timedOut = false, done = false
  const finish = (p: Proc) => { if (!done) { done = true; resolve(p) } }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, args, { cwd: existsSync(o.cwd) ? o.cwd : undefined, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    finish({ stdout: '', stderr: String(err), code: null, timedOut: false, missing: /ENOENT/.test(String(err)) })
    return
  }
  const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM') } catch {}; setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000).unref?.() }, o.timeoutMs)
  child.stdout?.on('data', d => { if (stdout.length < 16 * 1024 * 1024) stdout += d })
  child.stderr?.on('data', d => { if (stderr.length < 1024 * 1024) stderr += d })
  child.on('error', err => { clearTimeout(timer); finish({ stdout, stderr: stderr + String(err), code: null, timedOut, missing: (err as NodeJS.ErrnoException).code === 'ENOENT' }) })
  child.on('close', code => { clearTimeout(timer); finish({ stdout, stderr, code, timedOut, missing: false }) })
  child.stdin?.on('error', () => {})
  child.stdin?.end(input)
})

/** The turn limit in seconds: a whole number from 60 to 7200, else 600. */
export function cliTurnTimeoutS(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 60 && n <= 7200 ? n : 600
}

// OpenCode asks before it reads outside the project, loops on a tool or reads
// a .env, and nobody answers a web-chat turn's prompt (it auto-rejects). The
// seat's pane gets this same posture from 5dive-agent-start (DIVE-5624).
export const OPENCODE_PERMISSION = '{"external_directory":"allow","doom_loop":"allow","read":"allow"}'

/**
 * The environment a turn runs in. The CLI's own directory leads PATH (pi is a
 * node script: `node` sits beside it in the nvm bin it links into). OpenCode
 * must read the seat's own ~/.config/opencode, so the box-wide
 * XDG_CONFIG_HOME redirect is dropped, as the seat's pane drops it (DIVE-5620).
 */
export function turnEnv(rt: CliRuntime, bin: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base }
  let dir = ''
  try { dir = dirname(realpathSync(bin)) } catch { dir = dirname(bin) }
  const path = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(p => p && p !== dir)
  env.PATH = [dir, ...path].join(delimiter)
  if (rt === 'opencode') {
    delete env.XDG_CONFIG_HOME
    if (!env.OPENCODE_PERMISSION) env.OPENCODE_PERMISSION = OPENCODE_PERMISSION
  }
  return env
}

export type RunTurn = (prompt: string) => Promise<TurnResult & { timedOut?: boolean; missing?: boolean }>

export type CliTurnOptions = {
  runtime: CliRuntime
  bin: string
  stateDir: string        // the spool: pi's sessions and opencode's session id live here
  cwd: string             // the seat's work folder
  timeoutS?: number
  spawner?: Spawner
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}

/** One turn of the seat's CLI in the web-chat session. */
export function cliTurn(o: CliTurnOptions): RunTurn {
  const run = o.spawner ?? spawnTurn
  const timeoutMs = (o.timeoutS ?? 600) * 1000
  const env = turnEnv(o.runtime, o.bin, o.env)
  const log = o.log ?? (() => {})
  mkdirSync(o.stateDir, { recursive: true, mode: 0o700 })
  if (o.runtime === 'pi') {
    const sessions = join(o.stateDir, 'pi-sessions')
    return async prompt => {
      mkdirSync(sessions, { recursive: true, mode: 0o700 })
      const p = await run(o.bin, ['-p', '--session-dir', sessions, '--continue'], prompt, { cwd: o.cwd, env, timeoutMs })
      return { ...parsePiTurn(p.stdout, p.stderr, p.code), timedOut: p.timedOut, missing: p.missing }
    }
  }
  const idFile = join(o.stateDir, 'opencode-session')
  const readId = () => { try { const s = readFileSync(idFile, 'utf8').trim(); return /^[A-Za-z0-9_-]{4,200}$/.test(s) ? s : '' } catch { return '' } }
  return async prompt => {
    for (let fresh = false; ; fresh = true) {
      const id = fresh ? '' : readId()
      const args = ['run', '--format', 'json', ...(id ? ['--session', id] : ['--title', '5dive web chat'])]
      const p = await run(o.bin, args, prompt, { cwd: o.cwd, env, timeoutMs })
      const turn = parseOpencodeTurn(p.stdout, p.stderr, p.code)
      // The kept session is gone (deleted from the TUI, a wiped data dir): start a new one, once.
      if (id && !fresh && turn.kind === 'failed' && /session not found/i.test(`${p.stderr}\n${p.stdout}`)) {
        log(`dashboard opencode: web chat session ${id} is gone; starting a new one`)
        try { unlinkSync(idFile) } catch {}
        continue
      }
      if (turn.sessionId && turn.sessionId !== id) {
        try { writeFileSync(idFile, turn.sessionId + '\n', { mode: 0o600 }) } catch (err) { log(`dashboard opencode: could not keep the session id: ${err}`) }
      }
      const { sessionId: _s, ...rest } = turn
      return { ...rest, timedOut: p.timedOut, missing: p.missing }
    }
  }
}

export type CliDispatcherOptions = {
  runtime: CliRuntime
  inboxDir: string
  outboxDir: string
  run: RunTurn
  log?: (line: string) => void
}

export function startCliDispatcher(o: CliDispatcherOptions): { stop(): void; idle(): Promise<void> } {
  const rt = o.runtime
  const log = o.log ?? (line => process.stderr.write(line + '\n'))
  let seq = 0
  const reply = (route: Route, text: string) => {
    writeOutbox(o.outboxDir, { ...route, text, kind: 'message' }, `${Date.now()}-${process.pid}-${rt}-${seq++}`)
  }
  mkdirSync(o.inboxDir, { recursive: true, mode: 0o700 })

  // DIVE-7811: an answer over the word cap goes back to the model in the same
  // session, and the rewrite is what the chat gets. A rewrite that fails, or
  // comes back empty, leaves the last answer to go as written: never silence.
  const cutToSize = async (id: string, first: string) => {
    let best = first
    for (let n = 1; n <= REPLY_CUT_TRIES; n++) {
      const refusal = replyTooLong(best)
      if (!refusal) break
      log(`dashboard ${rt}: ${id} reply over the word cap; asking for a rewrite (${n})`)
      const again = await o.run(`${CLI_HEADER}\n${cutItPrompt(refusal)}`)
      if (again.kind !== 'reply') break
      best = again.text
    }
    return best
  }

  const answer = async (msg: InboxMessage) => {
    const id = String(msg.id ?? '?')
    const route = routeOf(msg)
    const notice = (text: string) => reply({ source: 'dashboard', chat_id: route.chat_id }, text)
    const turn = await o.run(promptFor(msg))
    if (turn.kind === 'reply') {
      reply(route, await cutToSize(id, turn.text))
      log(`dashboard ${rt}: answered ${id} (${turn.text.length} chars)`)
      return
    }
    if (turn.missing) { notice(notInstalledText(rt)); log(`dashboard ${rt}: ${id}: the ${rt} binary is missing`); return }
    if (turn.timedOut) { notice(tooSlowText(rt)); log(`dashboard ${rt}: ${id} ran past the turn limit`); return }
    if (turn.kind === 'empty') { notice(noAnswerText(rt)); log(`dashboard ${rt}: ${id} ended with no answer`); return }
    notice(turn.reason ? failedWithReason(rt, turn.reason) : failedText(rt))
    log(`dashboard ${rt}: ${id} failed: ${turn.reason || '(no reason given)'}`)
  }

  // One turn at a time, in arrival order: they share one session.
  let chain = Promise.resolve()
  const seen = new Set<string>()
  const ingest = (name: string) => {
    if (!name.endsWith('.json') || name.startsWith('.') || seen.has(name)) return
    const full = join(o.inboxDir, name)
    let msg: InboxMessage
    try { msg = JSON.parse(readFileSync(full, 'utf8')) } catch { return }   // mid-rename, or already taken
    seen.add(name)
    try { unlinkSync(full) } catch {}
    chain = chain.then(() => answer(msg)).catch(err => {
      log(`dashboard ${rt}: turn failed: ${err}`)
      try { reply({ source: 'dashboard', chat_id: routeOf(msg).chat_id }, failedText(rt)) } catch {}
    }).finally(() => seen.delete(name))
  }
  const drain = () => { try { for (const n of readdirSync(o.inboxDir).sort()) ingest(n) } catch {} }
  drain()
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(o.inboxDir, (_e, n) => { if (n) ingest(String(n)) })
    watcher.on('error', err => log(`dashboard ${rt}: inbox watch error: ${err}`))
  } catch (err) { log(`dashboard ${rt}: inbox watch failed: ${err}`) }
  const sweep = setInterval(drain, 1_000)
  sweep.unref?.()
  log(`dashboard ${rt}: web chat bridge up (inbox ${o.inboxDir})`)
  return { stop() { clearInterval(sweep); watcher?.close() }, idle: () => chain }
}
