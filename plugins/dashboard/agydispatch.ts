// plugins/dashboard/agydispatch.ts — the web chat for an Antigravity seat (DIVE-7351).
//
// Antigravity (`agy`) has no channel-notification protocol either, and it keeps
// its conversations in a store we cannot read. But unlike Grok it takes MCP
// tools the way its Telegram bridge uses them, so on an agy seat agy spawns
// this server from ~/.gemini/config/mcp_config.json and answers through its
// `reply` tool, like a Claude seat does. What is left for this module is the
// inbound half: it types each web-chat message into agy's pane, and makes sure
// a message agy never answers ends in a visible notice, never in silence.
//
// "Never answers" is read off the pane: while agy works, its pane keeps
// changing; a pane that has held still for idleMs with no reply means agy is
// done or stuck without answering.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { routeOf, writeOutbox, type GrokPane, type InboxMessage, type OutboxReply, type Route } from './grokdispatch.ts'

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** What is typed into agy for one web-chat message. */
export function agyPromptFor(msg: InboxMessage, hears = false): string {
  const route = routeOf(msg)
  const text = typeof msg.text === 'string' ? msg.text.trim() : ''
  const path = typeof msg.image_path === 'string' && msg.image_path.startsWith('/') ? msg.image_path : ''
  const voice = route.voice === true || (!!path && /\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)$/i.test(path))
  const how = voice
    ? `answer with ONE call of the dashboard reply tool, chat_id "${route.chat_id}", voice: true`
    : `answer with the dashboard reply tool, chat_id "${route.chat_id}"`
  const parts = [`[5dive web chat: ${how}. Do not use a Telegram tool for it.]`]
  if (text) parts.push(text)
  if (path) {
    parts.push(voice
      ? `[Voice note: ${path}${hears ? `. Run 5dive-transcribe ${path} to hear it, then answer what it says` : ''}]`
      : `[Attached file: ${path}]`)
  }
  return parts.join('\n')
}

// agy's sign-in waits (strings of agy 1.1.7; live arm to confirm the screen).
export function agySignedOut(pane: string): boolean {
  return pane.includes('Waiting for authentication')
    || (/sign in/i.test(pane) && /google/i.test(pane) && /(browser|url|link)/i.test(pane) && !/reply tool/i.test(pane))
}

export const AGY_NO_ANSWER_TEXT = 'Antigravity worked on your message but did not send an answer. Try asking again.'
export const AGY_SIGNED_OUT_TEXT = 'Antigravity is not signed in on this computer yet, so it cannot answer. Sign it in, then send your message again.'

export type AgyTimings = {
  idleMs: number    // a pane that held still this long with no reply: agy is not answering
  maxMs: number     // no reply this long after the send, however busy the pane looks
}

export const AGY_DEFAULT_TIMINGS: AgyTimings = { idleMs: 180_000, maxMs: 900_000 }

type Waiting = { id: string; route: Route; sentAt: number; changedAt: number }

/**
 * Tracks web-chat messages typed into agy until it replies to their chat.
 * Pure: the caller feeds it pane captures and reply calls and ticks it.
 */
export class AgyWatch {
  private waiting: Waiting[] = []
  private lastPane: string | null = null
  constructor(
    private emit: (r: OutboxReply) => void,
    private now: () => number = Date.now,
    private t: AgyTimings = AGY_DEFAULT_TIMINGS,
  ) {}

  sent(id: string, route: Route): void {
    const now = this.now()
    this.waiting.push({ id, route, sentAt: now, changedAt: now })
  }

  /** agy called the reply tool for chat_id: the oldest message from that chat is answered. */
  replied(chatId: string): void {
    let i = this.waiting.findIndex(w => w.route.chat_id === chatId)
    if (i < 0) i = this.waiting.length ? 0 : -1
    if (i >= 0) this.waiting.splice(i, 1)
  }

  pane(text: string): void {
    const s = squash(text)
    if (this.lastPane !== null && s !== this.lastPane) for (const w of this.waiting) w.changedAt = this.now()
    this.lastPane = s
  }

  busy(): boolean { return this.waiting.length > 0 }

  tick(): void {
    const now = this.now()
    this.waiting = this.waiting.filter(w => {
      if (now - w.changedAt < this.t.idleMs && now - w.sentAt < this.t.maxMs) return true
      this.emit({ ...w.route, text: AGY_NO_ANSWER_TEXT, kind: 'error' })
      return false
    })
  }
}

export type AgyDispatcherOptions = {
  inboxDir: string
  outboxDir: string
  pane: GrokPane
  hears?: () => boolean
  log?: (line: string) => void
  pollMs?: number
  timings?: AgyTimings
}

export function startAgyDispatcher(o: AgyDispatcherOptions): { stop(): void; watch: AgyWatch } {
  const log = o.log ?? (line => process.stderr.write(line + '\n'))
  let seq = 0
  const out = (r: OutboxReply) => {
    writeOutbox(o.outboxDir, r, `${Date.now()}-${process.pid}-agy-${seq++}`)
    log(`dashboard agy: ${r.kind} -> chat ${r.chat_id} (${r.text.length} chars)`)
  }
  const w = new AgyWatch(out, Date.now, o.timings ?? AGY_DEFAULT_TIMINGS)
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
    chain = chain.then(() => send(msg)).catch(err => log(`dashboard agy: send failed: ${err}`))
      .finally(() => seen.delete(name))
  }
  const send = async (msg: InboxMessage) => {
    const route = routeOf(msg)
    let pane = ''
    try { pane = await o.pane.capture() } catch (err) { log(`dashboard agy: pane capture failed: ${err}`) }
    if (agySignedOut(pane)) {
      out({ ...route, text: AGY_SIGNED_OUT_TEXT, kind: 'error' })
      log('dashboard agy: Antigravity is on its sign-in screen; message not typed')
      return
    }
    w.sent(String(msg.id ?? ''), route)
    await o.pane.submit(agyPromptFor(msg, o.hears?.() ?? false))
    log(`dashboard agy: typed ${String(msg.id ?? '?')} into the pane`)
  }

  const drain = () => { try { for (const n of readdirSync(o.inboxDir).sort()) ingest(n) } catch {} }
  drain()
  let watcher: ReturnType<typeof watch> | null = null
  try { watcher = watch(o.inboxDir, (_e, n) => { if (n) ingest(String(n)) }) } catch (err) { log(`dashboard agy: inbox watch failed: ${err}`) }
  const sweep = setInterval(drain, 1_000)
  let capturing = false
  const poll = setInterval(() => {
    if (!w.busy() || capturing) { w.tick(); return }
    capturing = true
    o.pane.capture().then(p => w.pane(p), () => {}).finally(() => { capturing = false; w.tick() })
  }, o.pollMs ?? 2_000)
  sweep.unref?.(); poll.unref?.()
  log(`dashboard agy: web chat bridge up (inbox ${o.inboxDir})`)
  return { watch: w, stop() { clearInterval(sweep); clearInterval(poll); watcher?.close() } }
}
