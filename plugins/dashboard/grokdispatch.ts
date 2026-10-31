// plugins/dashboard/grokdispatch.ts — the web chat for a Grok seat (DIVE-7347).
//
// Grok has no channel-notification protocol (Claude's native push) and no app
// server a dispatcher can own (Codex, DIVE-6579). Its interface is a full-screen
// terminal, and it never paints its answer there (DIVE-7340 measured the pane:
// the question, blank rows, "Worked for 2.3s"). What it does keep is the whole
// conversation in ~/.grok/sessions/<cwd>/<session-id>/updates.jsonl, one ACP
// session update per line; the answer is streamed as `agent_message_chunk`
// records. `5dive agent ask` reads Grok's reply from that file; this reads it
// the same way (findUpdate / chunkText are that reader's two helpers, in TS).
//
// So on a Grok seat the dashboard server runs in its Codex adapter shape (the
// control plane's messages land in a dispatcher inbox, answers leave through
// the dispatcher outbox, which already speaks a voice note's answer) and THIS
// module plays the dispatcher: it types each web-chat message into Grok's pane
// and turns what Grok then writes into outbox replies. No model cooperation is
// needed: Grok answers the way it answers anyone typing at it.
//
// Attribution is by the user turn. Text Grok writes after the user turn that
// carries our message belongs to that message, until another user turn starts
// (a later web-chat message, the Telegram bridge's re-arm kick) or Grok goes
// back to its Telegram wait. A message Grok never takes, or never answers, ends
// in a visible notice in the chat, never in silence.
//
// DIVE-7351: what Grok writes right before a tool call is narration ("I'll
// transcribe the voice note and answer from what it says."), not the answer.
// It is held, and sent only when the turn ends with nothing else to send; and
// only a turn's first message is spoken, so one voice question gets one voice
// note.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, watch, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type GrokUpdate = { kind: string; text: string; raw: string; status?: string }

export type Route = { source: 'dashboard'; chat_id: string; voice?: true }

export type OutboxReply = Route & { text: string; kind: 'message' | 'error'; files?: string[] }

// The ACP update carrying `sessionUpdate`, wherever the line nests it (the
// `agent ask` reader's find_update, same depth bound).
export function findUpdate(o: unknown, depth = 0): Record<string, unknown> | null {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const r = o as Record<string, unknown>
    if (typeof r.sessionUpdate === 'string') return r
    if (depth < 4) {
      for (const v of Object.values(r)) {
        const u = findUpdate(v, depth + 1)
        if (u) return u
      }
    }
  }
  return null
}

export function chunkText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(chunkText).join('')
  if (c && typeof c === 'object') {
    const r = c as Record<string, unknown>
    return (r.type ?? 'text') === 'text' && typeof r.text === 'string' ? r.text : ''
  }
  return ''
}

export function parseUpdateLine(line: string): GrokUpdate | null {
  if (!line.includes('sessionUpdate')) return null
  let u: Record<string, unknown> | null
  try { u = findUpdate(JSON.parse(line)) } catch { return null }   // a cut or half-written line
  if (!u) return null
  return { kind: String(u.sessionUpdate), text: chunkText(u.content), raw: line, ...(typeof u.status === 'string' ? { status: u.status } : {}) }
}

// Grok 1.0.70's own sign-in screen — the same two pairs `agent ask` refuses on
// (src/cmd_agent_runtime.sh _agent_pane_credential_prompt, DIVE-7340).
export function signedOut(pane: string): boolean {
  return (pane.includes('Approve in your browser to finish signing in') && pane.includes('Waiting for approval'))
    || (pane.includes('Sign in to Grok') && pane.includes('Open this URL in your browser to approve'))
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

export const WEB_CHAT_HEADER = '[5dive web chat. Answer in plain text here: it goes back to this chat. Do not use a Telegram tool for it.]'

export type InboxMessage = { id?: string; text?: string; route?: { chat_id?: unknown; voice?: unknown }; image_path?: unknown }

/** What is typed into Grok for one web-chat message, and the part of it that identifies its user turn. */
export function promptFor(msg: InboxMessage, hears = false): { prompt: string; needle: string } {
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  const path = typeof msg.image_path === 'string' && msg.image_path.startsWith('/') ? msg.image_path : ''
  const parts = [WEB_CHAT_HEADER]
  if (text) parts.push(text)
  if (path) {
    parts.push(/\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i.test(path)
      ? `[Voice note: ${path}${hears ? `. Run 5dive-transcribe ${path} to hear it, then answer what it says` : ''}]`
      : `[Attached file: ${path}]`)
  }
  const prompt = parts.join('\n')
  return { prompt, needle: squash(text || path || WEB_CHAT_HEADER).slice(0, 80) }
}

export function routeOf(msg: InboxMessage): Route {
  const chat = typeof msg.route?.chat_id === 'string' && msg.route.chat_id ? msg.route.chat_id : 'dashboard'
  return { source: 'dashboard', chat_id: chat, ...(msg.route?.voice === true ? { voice: true as const } : {}) }
}

export const NOT_TAKEN_TEXT = 'Grok did not pick up your message. It may be busy or stuck. Try again in a minute.'
export const NO_ANSWER_TEXT = 'Grok worked on your message but did not write an answer. Try asking again.'
export const SIGNED_OUT_TEXT = 'Grok is not signed in on this computer yet, so it cannot answer. Sign it in, then send your message again.'

// Telegram-grok types this into the pane to re-arm its listen loop; it is a
// user turn, but never one of ours.
const KICK_PREFIX = 'A Telegram message is waiting'

type Expected = { id: string; needle: string; route: Route; sentAt: number }
// held: narration written before a tool call; tools: tool calls still running.
type Active = { id: string; route: Route; cur: string[]; posted: number; lastAt: number; warned: boolean; held: string; tools: number }

export type TurnTimings = {
  segmentQuietMs: number   // a streamed message with no new chunk for this long is complete
  acceptMs: number         // a typed message whose user turn never shows up is lost
  noAnswerMs: number       // a taken message with no answer text and no activity for this long
  followIdleMs: number     // stop attributing text to a turn this long after its last record
  looseMatchMs: number     // an unrecognised user turn this soon after a send is taken as ours
  heldQuietMs?: number     // held narration is the answer after this long with no tool running and nothing new
}

export const DEFAULT_TIMINGS: TurnTimings = {
  segmentQuietMs: 4_000,
  acceptMs: 120_000,
  noAnswerMs: 180_000,
  followIdleMs: 600_000,
  looseMatchMs: 30_000,
  heldQuietMs: 10_000,
}

/**
 * Turns Grok session updates into web-chat replies. Pure: the caller feeds it
 * updates in file order and ticks it; it emits outbox replies.
 */
export class GrokTurns {
  private expected: Expected[] = []
  private active: Active | null = null
  private userBuf: string[] = []
  constructor(
    private emit: (r: OutboxReply) => void,
    private now: () => number = Date.now,
    private t: TurnTimings = DEFAULT_TIMINGS,
  ) {}

  expect(id: string, needle: string, route: Route): void {
    this.expected.push({ id, needle, route, sentAt: this.now() })
  }

  /** True while a message is waiting for its turn or its turn is being followed. */
  busy(): boolean { return this.expected.length > 0 || this.active !== null }

  feed(u: GrokUpdate): void {
    if (u.kind === 'user_message_chunk') {
      this.userBuf.push(u.text)
      // A user turn is usually one record; match as soon as it carries a needle.
      this.matchUser(false)
      return
    }
    if (this.userBuf.length) this.matchUser(true)
    const a = this.active
    if (!a) return
    a.lastAt = this.now()
    if (u.kind === 'agent_message_chunk') {
      a.cur.push(u.text)
      return
    }
    const listen = u.raw.includes('wait_for_message')
    if (u.kind === 'tool_call' && !listen) {
      this.hold(a)
      if (u.status !== 'completed' && u.status !== 'failed') a.tools++
      return
    }
    if (u.kind === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) a.tools = Math.max(0, a.tools - 1)
    // Any other record (a thought, a hook, a command list) neither ends nor
    // splits a message: the quiet timer sends it, so narration that a hook
    // record separates from its tool call is still held.
    if (!listen) return
    // Grok went back to listen on Telegram: whatever it writes next answers that.
    this.flush(a)
    if (!a.posted) this.release(a)
    if (a.posted > 0) this.finish()
  }

  tick(): void {
    const now = this.now()
    if (this.userBuf.length) this.matchUser(true)
    const a = this.active
    if (a) {
      if (a.cur.length && now - a.lastAt >= this.t.segmentQuietMs) this.flush(a)
      if (a.held && !a.cur.length && !a.tools && now - a.lastAt >= (this.t.heldQuietMs ?? 10_000)) this.release(a)
      if (!a.posted && a.held && now - a.lastAt >= this.t.noAnswerMs) this.release(a)
      if (!a.posted && !a.warned && now - a.lastAt >= this.t.noAnswerMs) {
        a.warned = true
        this.emit({ ...a.route, text: NO_ANSWER_TEXT, kind: 'error' })
      }
      if (now - a.lastAt >= this.t.followIdleMs) this.finish()
    }
    while (this.expected.length && now - this.expected[0]!.sentAt >= this.t.acceptMs) {
      const lost = this.expected.shift()!
      this.emit({ ...lost.route, text: NOT_TAKEN_TEXT, kind: 'error' })
    }
  }

  private matchUser(final: boolean): void {
    const said = squash(this.userBuf.join(''))
    const i = this.expected.findIndex(e => said.includes(e.needle))
    if (i < 0 && !final) return
    this.userBuf = []
    if (i >= 0) {
      // Grok takes messages in order, so any earlier one it skipped is lost.
      for (const lost of this.expected.splice(0, i)) this.emit({ ...lost.route, text: NOT_TAKEN_TEXT, kind: 'error' })
      this.take(this.expected.shift()!)
      return
    }
    // Not ours by text. Grok may store a pasted message differently from how it
    // was typed, so a user turn right after a send is still taken as that send,
    // unless it is the Telegram bridge's re-arm kick.
    const oldest = this.expected[0]
    if (oldest && !said.startsWith(KICK_PREFIX) && this.now() - oldest.sentAt <= this.t.looseMatchMs) {
      this.take(this.expected.shift()!)
      return
    }
    this.finish()   // someone else's turn: what follows is not a web-chat answer
  }

  private take(e: Expected): void {
    this.finish()
    this.active = { id: e.id, route: e.route, cur: [], posted: 0, lastAt: this.now(), warned: false, held: '', tools: 0 }
  }

  // Text before a tool call: kept back, and replaced by the next such text.
  private hold(a: Active): void {
    const text = a.cur.join('').trim()
    a.cur = []
    if (text) a.held = text
  }

  // The turn ended on held text: it was the answer after all.
  private release(a: Active): void {
    const text = a.held
    a.held = ''
    if (text) this.post(a, text)
  }

  private flush(a: Active): void {
    const text = a.cur.join('').trim()
    a.cur = []
    if (!text) return
    a.held = ''   // an answer came, so the narration before it is dropped
    this.post(a, text)
  }

  private post(a: Active, text: string): void {
    // Only the first message of a turn is spoken: one voice note per answer.
    const { voice: _voice, ...plain } = a.route
    this.emit({ ...(a.posted ? plain : a.route), text, kind: 'message' })
    a.posted++
  }

  private finish(): void {
    const a = this.active
    if (!a) return
    this.flush(a)
    if (!a.posted) this.release(a)
    if (!a.posted && !a.warned) this.emit({ ...a.route, text: NO_ANSWER_TEXT, kind: 'error' })
    this.active = null
  }
}

/**
 * Follows every updates.jsonl under a sessions root from where it stood when
 * first seen; a file that appears later is read from its start (Grok opens a
 * new session on the first prompt after a restart).
 */
export class SessionTail {
  private offsets = new Map<string, number>()
  private partial = new Map<string, string>()
  constructor(private root: string) {
    for (const f of this.files()) this.offsets.set(f, this.size(f))
  }

  private files(): string[] {
    const out: string[] = []
    let cwds: string[] = []
    try { cwds = readdirSync(this.root) } catch { return out }
    for (const c of cwds) {
      let ids: string[] = []
      try { ids = readdirSync(join(this.root, c)) } catch { continue }
      for (const id of ids) {
        const f = join(this.root, c, id, 'updates.jsonl')
        if (existsSync(f)) out.push(f)
      }
    }
    return out
  }

  private size(f: string): number {
    try { return statSync(f).size } catch { return 0 }
  }

  /** New complete update lines since the last read. With skip, only moves the offsets. */
  read(skip = false): GrokUpdate[] {
    const out: GrokUpdate[] = []
    for (const f of this.files()) {
      const size = this.size(f)
      const from = this.offsets.get(f) ?? 0
      if (size < from) { this.offsets.set(f, 0); this.partial.delete(f) }   // rewritten
      const start = this.offsets.get(f) ?? 0
      if (size <= start) { this.offsets.set(f, start); continue }
      if (skip) { this.offsets.set(f, size); this.partial.delete(f); continue }
      const len = Math.min(size - start, 4 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      let fd = -1
      try {
        fd = openSync(f, 'r')
        readSync(fd, buf, 0, len, start)
      } catch { continue } finally { if (fd >= 0) closeSync(fd) }
      this.offsets.set(f, start + len)
      const lines = ((this.partial.get(f) ?? '') + buf.toString('utf8')).split('\n')
      this.partial.set(f, lines.pop() ?? '')
      for (const line of lines) {
        const u = parseUpdateLine(line)
        if (u) out.push(u)
      }
    }
    return out
  }
}

export type GrokPane = {
  capture(): Promise<string>
  /** Types the prompt into Grok's input and submits it. */
  submit(prompt: string): Promise<void>
}

/** The pane of this seat's tmux session (`agent-<name>`), the one Grok draws in. */
export function tmuxPane(session: string): GrokPane {
  const run = async (args: string[]) => {
    const p = Bun.spawn(['tmux', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    if (code !== 0) throw new Error(`tmux ${args[0]} failed (exit ${code}): ${(await new Response(p.stderr).text()).trim()}`)
    return out
  }
  return {
    capture: () => run(['capture-pane', '-p', '-t', session]),
    async submit(prompt) {
      // A bracketed paste keeps a multi-line message one message; Enter after
      // it settles, then once more in case the first raced the paste.
      const buf = `5dive-webchat-${process.pid}`
      await run(['set-buffer', '-b', buf, '--', prompt])
      await run(['paste-buffer', '-p', '-d', '-b', buf, '-t', session])
      await Bun.sleep(400)
      await run(['send-keys', '-t', session, 'Enter'])
    },
  }
}

export type GrokDispatcherOptions = {
  inboxDir: string
  outboxDir: string
  sessionsRoot: string
  pane: GrokPane
  hears?: () => boolean
  log?: (line: string) => void
  pollMs?: number
  timings?: TurnTimings
}

/** Writes one reply where the dashboard adapter's outbox reader picks it up. */
export function writeOutbox(dir: string, reply: OutboxReply, seq: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${seq}.tmp`)
  writeFileSync(tmp, JSON.stringify(reply) + '\n', { mode: 0o600 })
  renameSync(tmp, join(dir, `${seq}.json`))
}

export function startGrokDispatcher(o: GrokDispatcherOptions): { stop(): void; turns: GrokTurns } {
  const log = o.log ?? (line => process.stderr.write(line + '\n'))
  let seq = 0
  const turns = new GrokTurns(r => {
    writeOutbox(o.outboxDir, r, `${Date.now()}-${process.pid}-grok-${seq++}`)
    log(`dashboard grok: ${r.kind} -> chat ${r.chat_id} (${r.text.length} chars)`)
  }, Date.now, o.timings ?? DEFAULT_TIMINGS)
  const tail = new SessionTail(o.sessionsRoot)
  mkdirSync(o.inboxDir, { recursive: true, mode: 0o700 })

  let chain = Promise.resolve()
  const seen = new Set<string>()
  const ingest = (name: string) => {
    if (!name.endsWith('.json') || seen.has(name)) return
    const full = join(o.inboxDir, name)
    let msg: InboxMessage
    try { msg = JSON.parse(readFileSync(full, 'utf8')) } catch { return }   // mid-rename, or already taken
    seen.add(name)
    try { unlinkSync(full) } catch {}
    chain = chain.then(() => send(msg)).catch(err => log(`dashboard grok: send failed: ${err}`))
      .finally(() => seen.delete(name))
  }
  const send = async (msg: InboxMessage) => {
    const route = routeOf(msg)
    let pane = ''
    try { pane = await o.pane.capture() } catch (err) { log(`dashboard grok: pane capture failed: ${err}`) }
    if (signedOut(pane)) {
      writeOutbox(o.outboxDir, { ...route, text: SIGNED_OUT_TEXT, kind: 'error' }, `${Date.now()}-${process.pid}-grok-${seq++}`)
      log('dashboard grok: Grok is on its sign-in screen; message not typed')
      return
    }
    // Catch up first, so text Grok wrote before this message is never read as its answer.
    for (const u of tail.read(!turns.busy())) turns.feed(u)
    const { prompt, needle } = promptFor(msg, o.hears?.() ?? false)
    turns.expect(String(msg.id ?? ''), needle, route)
    await o.pane.submit(prompt)
    log(`dashboard grok: typed ${String(msg.id ?? '?')} into the pane`)
  }

  const drain = () => { try { for (const n of readdirSync(o.inboxDir).sort()) ingest(n) } catch {} }
  drain()
  let watcher: ReturnType<typeof watch> | null = null
  try { watcher = watch(o.inboxDir, (_e, n) => { if (n) ingest(String(n)) }) } catch (err) { log(`dashboard grok: inbox watch failed: ${err}`) }
  const sweep = setInterval(drain, 1_000)
  const poll = setInterval(() => {
    for (const u of tail.read(!turns.busy())) turns.feed(u)
    turns.tick()
  }, o.pollMs ?? 400)
  sweep.unref?.(); poll.unref?.()
  log(`dashboard grok: web chat bridge up (inbox ${o.inboxDir}, sessions ${o.sessionsRoot})`)
  return { turns, stop() { clearInterval(sweep); clearInterval(poll); watcher?.close() } }
}
