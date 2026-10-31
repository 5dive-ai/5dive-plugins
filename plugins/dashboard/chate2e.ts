// DIVE-6876: end-to-end encrypted web chat, the box side (protocol: e2e.ts,
// contract: docs/chat-e2e.md).
//
// When /etc/5dive/chat-e2e/ exists, every message body the API carries for this
// box is an envelope (e2e.ts) and the API holds only ciphertext:
//   * inbound  is opened before the session sees it; a plaintext message, an
//              envelope that does not open, or one already seen (same sender
//              and message id) is refused and never reaches the session;
//   * outbound (a reply, a voice note, question buttons, the "working: …"
//              line) is sealed to every approved device; a reply that cannot
//              be sealed is not sent at all, never sent in the clear;
//   * files    travel as sealed blobs under a meaningless name; the real name
//              rides inside the message;
//   * roster   an approved device's "approve"/"revoke" message is applied by
//              root, which answers with the new device list sealed to every
//              device, for this side to post.
//
// This seat never reads the box key or the device list. Every open and seal is
// one call to the root verb (`5dive _chat_e2e`, request JSON on stdin, answer
// JSON on stdout), which takes sender keys only from its own list and writes
// the message type itself, so a seat cannot make a body a device would read as
// a device list.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'
import { basename, join } from 'path'
import { b64u, unb64u, type Envelope } from './e2e.ts'
import { isOwnUpload } from './chatonly.ts'
import type { ChatQuestion } from './hooks/lib/dashboard-chat.ts'

export const E2E_DIR_DEFAULT = '/etc/5dive/chat-e2e'
export const E2E_ARGV_DEFAULT = ['sudo', '-n', '/usr/local/bin/5dive', '_chat_e2e']
// What the person sees, once per chat per window, when the box refused a message.
export const E2E_REFUSED_TEXT = 'A message reached this server without encryption, so it was not passed to the agent. Send it again from the 5dive app.'
const REFUSED_NOTICE_MS = 10 * 60_000
const SEEN_KEEP_MS = 30 * 24 * 60 * 60_000
const SEEN_MAX = 20_000
const FILES_MAX = 10

/** On when the box has the dir; read on every use, so turning it on needs no restart. */
export function isE2E(dir: string): boolean {
  try { return statSync(dir).isDirectory() } catch { return false }
}

/** An envelope's shape, or null: anything else is plaintext to this side. */
export function parseEnvelope(raw: unknown): Envelope | null {
  let e: any
  try { e = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
  const h = e?.h
  if (!h || typeof h !== 'object') return null
  if (typeof h.v !== 'number' || typeof h.t !== 'number') return null
  for (const f of ['s', 'c', 'm', 'd', 'salt']) if (typeof h[f] !== 'string') return null
  if (typeof e.iv !== 'string' || typeof e.ct !== 'string' || !e.k || typeof e.k !== 'object') return null
  return e as Envelope
}

export type BoxCall = (req: Record<string, unknown>) => Promise<Record<string, unknown>>

/** The root verb over sudo. A refusal (non-zero exit or an `error` field) throws. */
export function rootBoxCall(argv: string[], timeoutMs = 60_000): BoxCall {
  return async req => {
    const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    try {
      proc.stdin.write(JSON.stringify(req))
      await proc.stdin.end()
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`chat-e2e ${String(req.op)} failed (exit ${code}): ${(err || out).trim().slice(0, 300)}`)
      const res = JSON.parse(out) as Record<string, unknown>
      if (typeof res?.error === 'string') throw new Error(`chat-e2e ${String(req.op)} refused: ${res.error}`)
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}

export type Admitted =
  | { kind: 'deliver'; text: string; files: string[]; key: string }
  | { kind: 'roster'; body: string; key: string }
  | { kind: 'refuse'; why: string }
  | { kind: 'replay'; why: string }

export type ChatE2EOpts = {
  call: BoxCall
  /** This seat's dashboard state dir: the replay record and opened files live here. */
  stateDir: string
  agent: string
  uploadsDir: string
  /** Puts an upload the message names on disk (server.ts: ensureInboundFile). */
  fetchFile: (path: string) => Promise<void>
  now?: () => number
}

const sealedEnv = (res: Record<string, unknown>, what: string): string => {
  const env = parseEnvelope(res.env)
  if (!env) throw new Error(`chat-e2e ${what}: the root verb answered no envelope`)
  return JSON.stringify(env)
}

/** A file's name as the person gave it: the outbox prefix (`<agent>-<ms>-`) off, no path. */
export function displayName(path: string, agent: string): string {
  const b = basename(path)
  const m = b.match(new RegExp(`^${agent.replace(/[^a-z0-9-]/g, '')}-\\d+-(.+)$`))
  return m ? m[1] : b
}

function safeName(name: unknown): string {
  const n = (typeof name === 'string' ? basename(name) : '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  return n || 'file'
}

export function makeChatE2E(o: ChatE2EOpts) {
  const now = o.now ?? Date.now
  const seenFile = join(o.stateDir, 'e2e-seen.json')
  const filesDir = join(o.stateDir, 'e2e-files')
  const refusedAt = new Map<string, number>()

  const loadSeen = (): Record<string, number> => {
    try { return JSON.parse(readFileSync(seenFile, 'utf8')) ?? {} } catch { return {} }
  }

  async function openFile(f: any, i: number, parent: Envelope, sender: string, conv: string): Promise<string> {
    const path = f?.path
    if (!isOwnUpload(o.agent, o.uploadsDir, path)) throw new Error(`file ${i + 1} is not an upload of this agent`)
    await o.fetchFile(path)
    const env = parseEnvelope(readFileSync(path, 'utf8'))
    // The blob is bound to this message: its id is the parent's plus `#f<i>`,
    // from the same sender, so a blob from another message cannot be swapped in.
    if (!env || env.h.m !== `${parent.h.m}#f${i}` || env.h.s !== sender || env.h.c !== conv) {
      throw new Error(`file ${i + 1} is not this message's file`)
    }
    const r = await o.call({ op: 'open', kind: 'file', conv, env })
    if (r.sender !== sender || typeof r.pt !== 'string') throw new Error(`file ${i + 1} did not open`)
    mkdirSync(filesDir, { recursive: true, mode: 0o700 })
    const dest = join(filesDir, `${randomBytes(6).toString('hex')}-${safeName(f?.name)}`)
    writeFileSync(dest, unb64u(r.pt), { mode: 0o600 })
    try { unlinkSync(path) } catch {}
    return dest
  }

  return {
    /** Open one inbound body. Nothing is recorded: call delivered() once the session has it. */
    async admit(text: string, conv: string): Promise<Admitted> {
      const env = parseEnvelope(text)
      if (!env) return { kind: 'refuse', why: 'a plaintext message into an encrypted chat' }
      if (env.h.c !== conv) return { kind: 'refuse', why: 'an envelope for another conversation' }
      if (env.h.d !== 'in' || env.h.m.includes('#')) return { kind: 'refuse', why: 'an envelope that is not an inbound message' }
      const key = `${env.h.s}\u0000${env.h.m}`
      if (loadSeen()[key]) return { kind: 'replay', why: `message ${env.h.m} from ${env.h.s} was already delivered` }
      let r: Record<string, unknown>
      try {
        r = await o.call({ op: 'open', kind: 'msg', conv, env })
      } catch (err) {
        return { kind: 'refuse', why: `an envelope that did not open (${String(err).slice(0, 160)})` }
      }
      if (r.sender !== env.h.s) return { kind: 'refuse', why: 'an envelope whose sender did not check out' }
      if (r.roster !== undefined) {
        try { return { kind: 'roster', body: sealedEnv({ env: r.roster }, 'roster'), key } } catch (err) {
          return { kind: 'refuse', why: String(err) }
        }
      }
      let inner: any
      try { inner = JSON.parse(new TextDecoder().decode(unb64u(String(r.pt)))) } catch { inner = null }
      if (inner?.t !== 'msg' || typeof inner.text !== 'string') return { kind: 'refuse', why: 'an envelope with no message inside' }
      const files: string[] = []
      let body = inner.text
      const list: unknown[] = Array.isArray(inner.files) ? inner.files.slice(0, FILES_MAX) : []
      for (let i = 0; i < list.length; i++) {
        try {
          files.push(await openFile(list[i], i, env, env.h.s, conv))
        } catch (err) {
          body += `\n[a file in this message could not be opened: ${String(err instanceof Error ? err.message : err).slice(0, 120)}]`
        }
      }
      if (!body.trim() && files.length === 0) return { kind: 'refuse', why: 'an empty message' }
      return { kind: 'deliver', text: body, files, key }
    },

    /** Record a delivered message, so the relay offering it again is dropped. */
    delivered(key: string): void {
      const seen = loadSeen()
      const t = now()
      seen[key] = t
      const keep = Object.entries(seen).filter(([, at]) => t - at < SEEN_KEEP_MS).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX)
      try {
        mkdirSync(o.stateDir, { recursive: true, mode: 0o700 })
        writeFileSync(`${seenFile}.tmp`, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 })
        renameSync(`${seenFile}.tmp`, seenFile)
      } catch {}
    },

    /** True once per chat per window: whether to tell the person a message was refused. */
    noticeDue(conv: string): boolean {
      const last = refusedAt.get(conv) ?? 0
      if (now() - last < REFUSED_NOTICE_MS) return false
      refusedAt.set(conv, now())
      return true
    },

    /**
     * Seal a reply. Each file becomes a sealed blob next to it in `outboxDir`
     * (the plaintext copies there are removed); the body is one envelope.
     */
    async sealReply(conv: string, text: string, files: string[], question: ChatQuestion | null, outboxDir: string): Promise<{ body: string; files: string[] }> {
      const m = `b-${randomUUID()}`
      const inner: Array<{ path: string; name: string; size: number }> = []
      const blobs: string[] = []
      try {
        for (let i = 0; i < files.length; i++) {
          const bytes = readFileSync(files[i])
          const r = await o.call({ op: 'seal-file', conv, m: `${m}#f${i}`, data: b64u(bytes) })
          const blob = join(outboxDir, `${o.agent}-${now()}-${i}-${randomBytes(6).toString('hex')}.e2e`)
          writeFileSync(blob, sealedEnv(r, 'seal-file'), { mode: 0o664 })
          blobs.push(blob)
          inner.push({ path: blob, name: displayName(files[i], o.agent), size: bytes.byteLength })
        }
        const r = await o.call({ op: 'seal', conv, m, msg: { text, ...(inner.length ? { files: inner } : {}), ...(question ? { question } : {}) } })
        return { body: sealedEnv(r, 'seal'), files: blobs }
      } catch (err) {
        for (const b of blobs) { try { unlinkSync(b) } catch {} }
        throw err
      }
    },

    /** The "working: …" line, sealed. */
    async sealStatus(conv: string, label: string): Promise<string> {
      return sealedEnv(await o.call({ op: 'seal', conv, m: `s-${randomUUID()}`, status: { label } }), 'seal')
    },
  }
}

export type ChatE2E = ReturnType<typeof makeChatE2E>

/** Remove plaintext copies a sealed reply no longer needs (only ever inside the outbox). */
export function dropPlainCopies(paths: string[], outboxDir: string): void {
  for (const p of new Set(paths)) {
    if (p.startsWith(`${outboxDir}/`) && existsSync(p)) { try { unlinkSync(p) } catch {} }
  }
}
