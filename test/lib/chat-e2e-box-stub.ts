// DIVE-6876: a stand-in for the root verb `5dive _chat_e2e` (built on DIVE-6878),
// enforcing the contract in docs/chat-e2e.md. The real verb keeps the box key in
// /etc/5dive/chat-e2e/box.jwk (root 0600); this one keeps it, and the device
// list, in a test dir.
//
// In-process: makeBoxStub(dir).call(req). As a process (DASHBOARD_E2E_ARGV):
// `bun chat-e2e-box-stub.ts <dir>`, request JSON on stdin, answer on stdout.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as E from '../../plugins/dashboard/e2e.ts'

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const
const dec = new TextDecoder()

export async function initBox(dir: string, devices: Record<string, string>): Promise<string> {
  const kp = await E.newIdentity(true)
  writeFileSync(join(dir, 'box.jwk'), JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)))
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({ n: 0, devices }))
  return E.exportPublic(kp.publicKey)
}

export function makeBoxStub(dir: string) {
  const roster = () => JSON.parse(readFileSync(join(dir, 'roster.json'), 'utf8')) as { n: number; devices: Record<string, string> }
  const priv = () => crypto.subtle.importKey('jwk', JSON.parse(readFileSync(join(dir, 'box.jwk'), 'utf8')), P256, false, ['deriveBits'])
  const recipients = async () =>
    Promise.all(Object.entries(roster().devices).map(async ([id, raw]) => ({ id, pub: await E.importPublic(raw) })))
  const sealOut = async (conv: string, m: string, plaintext: Uint8Array | string) =>
    E.seal({ senderId: 'box', senderPriv: await priv(), recipients: await recipients(), conv, msgId: m, dir: 'out', plaintext })

  async function call(req: any): Promise<Record<string, unknown>> {
    // DIVE-7440: as the rail: on answers, off is exit 4 (E_NOT_FOUND).
    if (req.op === 'state') {
      if (!existsSync(join(dir, 'box.jwk'))) throw Object.assign(new Error('encrypted chat is not on on this server.'), { exit: 4 })
      return { on: true }
    }
    const conv = String(req.conv ?? '')
    if (req.op === 'open') {
      const env = req.env as E.Envelope
      const isFile = req.kind === 'file'
      if (isFile !== env.h.m.includes('#')) throw new Error(`a ${isFile ? 'file' : 'message'} id must ${isFile ? '' : 'not '}carry #`)
      const raw = roster().devices[env.h.s]
      if (!raw) throw new Error(`sender ${env.h.s} is not an approved device`)
      const pt = await E.open({ env, myId: 'box', myPriv: await priv(), senderPub: await E.importPublic(raw), expect: { conv, dir: 'in' } })
      if (!isFile) {
        let inner: any = null
        try { inner = JSON.parse(dec.decode(pt)) } catch {}
        if (inner?.t === 'approve' || inner?.t === 'revoke' || inner?.t === 'sync') {
          // DIVE-7520, as root: a command names the exact revision and applies
          // once; a retry of the one that made the current list answers it again.
          const appliedFile = join(dir, 'applied.json')
          const applied: Record<string, number> = existsSync(appliedFile) ? JSON.parse(readFileSync(appliedFile, 'utf8')) : {}
          const id = `${env.h.s}\u0000${env.h.m}`
          let r = roster()
          const answer = async () => ({ sender: env.h.s, m: env.h.m, roster: await sealOut(conv, `roster-${r.n}`, JSON.stringify({ t: 'roster', n: r.n, devices: Object.entries(r.devices).map(([i, pub]) => ({ id: i, pub })) })) })
          if (inner.t === 'sync') return answer()
          if (id in applied) { if (applied[id] === r.n) return answer(); throw new Error('already applied') }
          if (inner.rev !== r.n) throw new Error(`the device list changed (it is at ${r.n})`)
          if (inner.t === 'approve') r.devices[String(inner.device)] = String(inner.pub)
          else delete r.devices[String(inner.device)]
          r.n++
          writeFileSync(join(dir, 'roster.json'), JSON.stringify(r))
          applied[id] = r.n
          writeFileSync(appliedFile, JSON.stringify(applied))
          return answer()
        }
      }
      return { sender: env.h.s, m: env.h.m, pt: E.b64u(pt) }
    }
    if (req.op === 'seal') {
      const m = String(req.m ?? '')
      if (!m || m.includes('#') || m.startsWith('roster-')) throw new Error('a seat may not use that message id')
      // Root writes the type: a seat can never make a body read as a device list.
      const inner = req.status ? { t: 'status', label: String(req.status.label ?? '') } : { ...req.msg, t: 'msg' }
      return { env: await sealOut(conv, m, JSON.stringify(inner)) }
    }
    if (req.op === 'seal-file') {
      const m = String(req.m ?? '')
      if (!/#f\d+$/.test(m)) throw new Error('a file id must end in #f<n>')
      return { env: await sealOut(conv, m, E.unb64u(String(req.data ?? ''))) }
    }
    throw new Error(`unknown op ${req.op}`)
  }
  return { call, roster }
}

if (import.meta.main) {
  const req = JSON.parse(await new Response(Bun.stdin.stream()).text())
  try {
    process.stdout.write(JSON.stringify(await makeBoxStub(process.argv[2]).call(req)))
  } catch (err) {
    process.stderr.write(String(err instanceof Error ? err.message : err))
    process.exit((err as { exit?: number })?.exit ?? 2)
  }
}
