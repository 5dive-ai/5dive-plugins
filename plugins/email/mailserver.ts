// plugins/email/mailserver.ts — OpenAgent Mail, the box's own mail server
// (DIVE-8315 option B). One small process for a domain or subdomain the firm
// points at this box (mike@ai.firm.com):
//
//   :25   (MX)          takes mail for <agent>@<domain> from anyone, for known
//                       agents only, and drops it into the agent's maildir.
//                       Internet or office LAN alike; works with the internet off.
//   127.0.0.1:587       the agents' own submission port: each agent logs in with
//                       its address and the password `email connect` gave it,
//                       and may send only as itself. Mail to another agent here
//                       is handed over directly; anything else goes out through
//                       the firm's relay when one is set (the default advice:
//                       a new server's own mail often lands in spam), else
//                       straight to the recipient's MX, DKIM-signed.
//
// Nothing here decides who the agent may write to: the channel's send gate
// does that before a mail reaches :587. This server only refuses to be an
// open relay and to let one agent send as another.
//
// Config: /etc/5dive/mail/server.json (root, 0600), written by
// `sudo 5dive agent email server setup` and `… connect --self-hosted`:
//   { domain, hostname, dkim: {selector, key}, relay?: Endpoint,
//     agents: { <name>: { maildir, uid, gid, pass_sha256 } }, max_bytes? }
// Outbound mail that cannot go yet waits in /var/lib/5dive/mail/queue and is
// retried for two days; a final failure lands in the sender's own maildir as a
// plain note, so the agent learns its mail did not arrive.

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, rmSync, chownSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import { hostname as osHost } from 'node:os'
import { SMTPServer } from 'smtp-server'
import nodemailer from 'nodemailer'
import { normAddr, domainOf, type Endpoint } from './mail.ts'

const CONF = process.env.OAMAIL_CONFIG || '/etc/5dive/mail/server.json'
const SPOOL = process.env.OAMAIL_SPOOL || '/var/lib/5dive/mail'
const QUEUE = join(SPOOL, 'queue')
const LOG = join(SPOOL, 'mail.log')
const MX_PORT = Number(process.env.OAMAIL_MX_PORT || 25)
const SUB_PORT = Number(process.env.OAMAIL_SUB_PORT || 587)
const SUB_HOST = process.env.OAMAIL_SUB_HOST || '127.0.0.1'
const RETRY_FOR_MS = 48 * 3600_000
// Run under Node (`node --experimental-strip-types`, Node >= 22.6): Bun 1.3's
// server-side STARTTLS upgrade never completes (measured 2026-11-13: the client
// times out after EHLO/STARTTLS). Under Bun the servers offer no STARTTLS, so
// senders fall back to plain SMTP instead of hanging.
const UNDER_BUN = typeof (globalThis as any).Bun !== 'undefined'
const NO_TLS = UNDER_BUN ? ['STARTTLS'] : []

type AgentBox = { maildir: string; uid: number; gid: number; pass_sha256: string }
type Conf = { domain: string; hostname?: string; dkim?: { selector: string; key: string }; relay?: Endpoint; agents: Record<string, AgentBox>; max_bytes?: number }

function loadConf(): Conf {
  const c = JSON.parse(readFileSync(CONF, 'utf8'))
  if (typeof c.domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.domain)) throw new Error(`${CONF}: domain missing or bad`)
  c.agents = c.agents && typeof c.agents === 'object' ? c.agents : {}
  return c
}
// Read on every connection: `connect` adds an agent without a restart.
let conf = loadConf()
const reload = () => { try { conf = loadConf() } catch (e) { log(`config reload failed, keeping the old one: ${e}`) } }
const maxBytes = () => conf.max_bytes ?? 30 * 1024 * 1024
const helo = () => conf.hostname || osHost()

function log(line: string) {
  try {
    mkdirSync(SPOOL, { recursive: true, mode: 0o700 })
    appendFileSync(LOG, `${new Date().toISOString()}\t${line}\n`, { mode: 0o600 })
  } catch {}
  process.stderr.write(`oamail: ${line}\n`)
}

/** The agent an address belongs to on this box, or null. */
export function localAgent(c: Conf, addr: string | null): string | null {
  if (!addr || domainOf(addr) !== c.domain) return null
  const name = addr.slice(0, addr.lastIndexOf('@'))
  return Object.prototype.hasOwnProperty.call(c.agents, name) ? name : null
}

function dropInMaildir(agent: string, raw: Buffer) {
  const a = conf.agents[agent]
  const tmp = join(a.maildir, 'tmp'), nw = join(a.maildir, 'new')
  for (const d of [a.maildir, tmp, nw, join(a.maildir, 'cur')]) {
    if (!existsSync(d)) { mkdirSync(d, { recursive: true, mode: 0o700 }); chownSync(d, a.uid, a.gid) }
  }
  const name = `${Date.now()}.${randomUUID().slice(0, 12)}.${helo()}`
  writeFileSync(join(tmp, name), raw, { mode: 0o600 })
  chownSync(join(tmp, name), a.uid, a.gid)
  renameSync(join(tmp, name), join(nw, name))
}

function readAll(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let n = 0
    stream.on('data', (b: Buffer) => { n += b.length; if (n <= limit) parts.push(b) })
    stream.on('end', () => (n > limit ? reject(Object.assign(new Error('message too large'), { responseCode: 552 })) : resolve(Buffer.concat(parts))))
    stream.on('error', reject)
  })
}

const stamp = (peer: string, by: string) => Buffer.from(`Received: from ${peer.replace(/[^0-9a-fA-F.:]/g, '')} by ${by} with ESMTP; ${new Date().toUTCString()}\r\n`)

// ── :25, the MX ─────────────────────────────────────────────────────────────
const mx = new SMTPServer({
  name: helo(),
  banner: 'OpenAgent Mail',
  authOptional: true,
  disabledCommands: ['AUTH', ...NO_TLS],
  size: 30 * 1024 * 1024,
  logger: false,
  onConnect(_s, cb) { reload(); cb() },
  onRcptTo(addr, _s, cb) {
    const a = localAgent(conf, normAddr(addr.address))
    if (!a) return cb(Object.assign(new Error('no such mailbox here'), { responseCode: 550 }))
    cb()
  },
  async onData(stream, session, cb) {
    try {
      const raw = Buffer.concat([stamp(session.remoteAddress, helo()), await readAll(stream, maxBytes())])
      const to = session.envelope.rcptTo.map(r => localAgent(conf, normAddr(r.address))).filter(Boolean) as string[]
      for (const a of new Set(to)) dropInMaildir(a, raw)
      log(`in\tfrom=${session.remoteAddress}\tto=${[...new Set(to)].join(',')}\tbytes=${raw.length}`)
      cb()
    } catch (e: any) {
      log(`in refused: ${e?.message ?? e}`)
      cb(e)
    }
  },
})

// ── 127.0.0.1:587, the agents' submission port ──────────────────────────────
function passOk(agent: string, pass: string): boolean {
  const want = Buffer.from(conf.agents[agent]?.pass_sha256 ?? '', 'hex')
  const got = createHash('sha256').update(pass).digest()
  return want.length === 32 && timingSafeEqual(want, got)
}

const sub = new SMTPServer({
  name: helo(),
  banner: 'OpenAgent Mail submission',
  authMethods: ['PLAIN', 'LOGIN'],
  allowInsecureAuth: true, // 127.0.0.1 only
  disabledCommands: ['STARTTLS'], // loopback: nothing to protect on the wire
  size: 30 * 1024 * 1024,
  logger: false,
  onConnect(s, cb) {
    reload()
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(s.remoteAddress)) return cb(new Error('local only'))
    cb()
  },
  onAuth(auth, _s, cb) {
    const a = localAgent(conf, normAddr(auth.username))
    if (!a || !passOk(a, String(auth.password ?? ''))) return cb(new Error('bad login'))
    cb(null, { user: a })
  },
  onMailFrom(addr, s, cb) {
    if (localAgent(conf, normAddr(addr.address)) !== s.user) return cb(Object.assign(new Error('send as yourself only'), { responseCode: 553 }))
    cb()
  },
  async onData(stream, s, cb) {
    try {
      const raw = await readAll(stream, maxBytes())
      const from = normAddr(s.envelope.mailFrom && s.envelope.mailFrom.address)!
      const rcpts = s.envelope.rcptTo.map(r => normAddr(r.address)).filter(Boolean) as string[]
      const local = rcpts.filter(r => localAgent(conf, r))
      for (const r of local) dropInMaildir(localAgent(conf, r)!, Buffer.concat([stamp('127.0.0.1', helo()), raw]))
      const away = rcpts.filter(r => !localAgent(conf, r))
      if (away.length) enqueue({ id: randomUUID(), from, to: away, raw: raw.toString('base64'), first: Date.now(), tries: 0, next: 0 })
      log(`out\tagent=${s.user}\tlocal=${local.length}\tqueued=${away.length}`)
      cb()
      void drain()
    } catch (e: any) {
      cb(e)
    }
  },
})

// ── the outbound queue ──────────────────────────────────────────────────────
type Job = { id: string; from: string; to: string[]; raw: string; first: number; tries: number; next: number; last_error?: string }

function enqueue(j: Job) {
  mkdirSync(QUEUE, { recursive: true, mode: 0o700 })
  writeFileSync(join(QUEUE, `.${j.id}`), JSON.stringify(j), { mode: 0o600 })
  renameSync(join(QUEUE, `.${j.id}`), join(QUEUE, `${j.id}.json`))
}

function dkimOpt() {
  const d = conf.dkim
  if (!d) return undefined
  try {
    return { domainName: conf.domain, keySelector: d.selector, privateKey: readFileSync(d.key, 'utf8') }
  } catch {
    return undefined
  }
}

async function sendVia(t: Parameters<typeof nodemailer.createTransport>[0], j: Job, to: string[]) {
  const tr = nodemailer.createTransport(t as any)
  try {
    await tr.sendMail({ envelope: { from: j.from, to }, raw: Buffer.from(j.raw, 'base64') })
  } finally {
    tr.close()
  }
}

/** Deliver one job: through the relay, or to each recipient domain's MX. Returns recipients still owed. */
async function deliverJob(j: Job): Promise<{ left: string[]; permanent: string[]; error?: string }> {
  const dkim = dkimOpt()
  const r = conf.relay
  if (r) {
    try {
      const loop = r.host === '127.0.0.1' || r.host === 'localhost' || r.host === '::1'
      await sendVia({ host: r.host, port: r.port, secure: r.secure, requireTLS: !r.secure && !loop, ignoreTLS: loop, auth: r.user ? { user: r.user, pass: r.pass } : undefined, name: helo(), dkim, connectionTimeout: 30_000 }, j, j.to)
      return { left: [], permanent: [] }
    } catch (e: any) {
      return (e?.responseCode ?? 0) >= 500 ? { left: [], permanent: j.to, error: String(e?.message ?? e) } : { left: j.to, permanent: [], error: String(e?.message ?? e) }
    }
  }
  const byDomain = new Map<string, string[]>()
  for (const t of j.to) byDomain.set(domainOf(t), [...(byDomain.get(domainOf(t)) ?? []), t])
  const left: string[] = [], permanent: string[] = []
  let error: string | undefined
  for (const [dom, rcpts] of byDomain) {
    let hosts: string[] = []
    try {
      hosts = (await resolveMx(dom)).sort((a, b) => a.priority - b.priority).map(m => m.exchange)
    } catch (e: any) {
      if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') hosts = [dom] // RFC 5321: no MX → the A record
      else { left.push(...rcpts); error = `dns ${dom}: ${e?.code ?? e}`; continue }
    }
    let done = false
    for (const h of hosts) {
      try {
        await sendVia({ host: h, port: 25, secure: false, opportunisticTLS: true, tls: { rejectUnauthorized: false }, name: helo(), dkim, connectionTimeout: 30_000 }, j, rcpts)
        done = true
        break
      } catch (e: any) {
        error = `${h}: ${e?.message ?? e}`
        if ((e?.responseCode ?? 0) >= 500) { permanent.push(...rcpts); done = true; break }
      }
    }
    if (!done) left.push(...rcpts)
  }
  return { left, permanent, error }
}

function bounce(j: Job, rcpts: string[], why: string) {
  const a = localAgent(conf, j.from)
  if (!a) return
  const note = [
    `From: OpenAgent Mail <postmaster@${conf.domain}>`,
    `To: ${j.from}`,
    `Subject: Your mail did not arrive`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${conf.domain}>`,
    'Auto-Submitted: auto-replied',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Your mail to ${rcpts.join(', ')} could not be delivered: ${why.slice(0, 500)}`,
  ].join('\r\n')
  // A bounce is a note for the agent, not a person writing: marked so the
  // channel does not deliver it as a chat; it shows in the server log instead.
  dropInMaildir(a, Buffer.from(note))
}

let draining = false
async function drain() {
  if (draining) return
  draining = true
  try {
    let names: string[] = []
    try { names = readdirSync(QUEUE).filter(n => n.endsWith('.json')) } catch { return }
    for (const n of names) {
      const p = join(QUEUE, n)
      let j: Job
      try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { rmSync(p, { force: true }); continue }
      if (j.next > Date.now()) continue
      const r = await deliverJob(j)
      if (r.permanent.length) { bounce(j, r.permanent, r.error ?? 'refused'); log(`out failed for good\tto=${r.permanent.join(',')}\t${r.error ?? ''}`) }
      if (!r.left.length) { rmSync(p, { force: true }); if (!r.permanent.length) log(`out delivered\tid=${j.id}\tto=${j.to.length}`); continue }
      j.to = r.left
      j.tries++
      j.last_error = r.error
      if (Date.now() - j.first > RETRY_FOR_MS) {
        bounce(j, r.left, `gave up after two days: ${r.error ?? ''}`)
        rmSync(p, { force: true })
        log(`out gave up\tto=${r.left.join(',')}`)
        continue
      }
      j.next = Date.now() + Math.min(60_000 * 2 ** Math.min(j.tries, 6), 3600_000)
      writeFileSync(p, JSON.stringify(j), { mode: 0o600 })
      log(`out retry later\tto=${r.left.join(',')}\t${r.error ?? ''}`)
    }
  } finally {
    draining = false
  }
}

if (/mailserver\.ts$/.test(process.argv[1] ?? '')) {
  mx.on('error', e => log(`mx error: ${e}`))
  sub.on('error', e => log(`submission error: ${e}`))
  mx.listen(MX_PORT, process.env.OAMAIL_MX_HOST || '0.0.0.0', () => log(`MX listening on :${MX_PORT} for @${conf.domain}`))
  sub.listen(SUB_PORT, SUB_HOST, () => log(`submission listening on ${SUB_HOST}:${SUB_PORT}`))
  setInterval(() => void drain(), 60_000)
  void drain()
}
