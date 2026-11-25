// DIVE-9253: a chat-only agent's reply sends text only.
//
// The agent has no built-in tools, but the reply tool's `files` array copies ANY
// absolute path into the outbox and serves it. A prompt-injected agent could
// send its own sign-in file that way. The process arms drive the REAL server
// through the root-relay stand-in: with the lock on, a reply that names the
// seat's credentials file sends the text and nothing else; with the lock off,
// the same call DOES copy the file out, which proves the arm can see a leak.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatOnlyAgentArgs, chatOnlyAgentMode, chatOnlyAgentReplyTool, CHAT_ONLY_AGENT_DIR_DEFAULT } from '../plugins/dashboard/chatonlyagent.ts'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000
const SECRET = 'sk-ant-oat01-CHAT_ONLY_AGENT-TEST-SECRET'

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('chatonlyagent.ts', () => {
  test('env or marker turns it on; neither leaves it off', () => {
    const none = () => false
    expect(chatOnlyAgentMode({}, 'webchat', none)).toBe(false)
    expect(chatOnlyAgentMode({ DASHBOARD_CHAT_ONLY_AGENT: '1' }, 'webchat', none)).toBe(true)
    expect(chatOnlyAgentMode({ DASHBOARD_CHAT_ONLY_AGENT: '0' }, 'webchat', none)).toBe(false)
    const seen: string[] = []
    const marker = (p: string) => { seen.push(p); return p === `${CHAT_ONLY_AGENT_DIR_DEFAULT}/webchat` }
    expect(chatOnlyAgentMode({}, 'webchat', marker)).toBe(true)
    expect(chatOnlyAgentMode({}, 'theo', marker)).toBe(false)
    expect(chatOnlyAgentMode({}, '', marker)).toBe(false)
  })

  test('the markers are not the chat-only BOX file', () => {
    // /etc/5dive/chat-only is a file meaning "this whole box is chat-only"
    // (chatonly.ts, existsSync): a marker directory there would switch it on.
    expect(CHAT_ONLY_AGENT_DIR_DEFAULT).toBe('/etc/5dive/chat-only-agents')
  })

  test('an env of 0 cannot turn off a marker', () => {
    expect(chatOnlyAgentMode({ DASHBOARD_CHAT_ONLY_AGENT: '0' }, 'webchat', () => true)).toBe(true)
  })

  test('the tool offers chat_id and text only', () => {
    const t = chatOnlyAgentReplyTool()
    expect(t.name).toBe('reply')
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(['chat_id', 'text'])
    expect(JSON.stringify(t)).not.toMatch(/absolute|path/i)
  })

  test('files, voice and anything else are dropped', () => {
    const out = chatOnlyAgentArgs({ chat_id: 'c', text: 't', files: ['/x'], voice: true, part: { n: 1 } } as any)
    expect(out).toEqual({ chat_id: 'c', text: 't' })
  })
})

function writeRelay(dir: string): string {
  const file = join(dir, 'relay.ts')
  writeFileSync(file, `
import { appendFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const raw = await new Response(Bun.stdin.stream()).text()
const op = raw.split('\\0').slice(0, -1)
appendFileSync(dir + '/ops.log', JSON.stringify(op) + '\\n')
if (op[0] === 'ping') process.stdout.write('200\\n{"ok":true}')
else if (op[0] === 'pending') process.stdout.write('200\\n{"pending":[]}')
else if (op[0] === 'ack') process.stdout.write('200\\n{"ok":true,"acked":0}')
else if (op[0] === 'event') process.stdout.write('200\\n{"id":41}')
else { process.stderr.write('unknown op\\n'); process.exit(1) }
`)
  return file
}

function ops(dir: string): string[][] {
  const p = join(dir, 'ops.log')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function startAdapter(dir: string, env: Record<string, string>) {
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, 'CONNECTORD_TOKEN=never-read-by-the-seat\n')
  chmodSync(envFile, 0o000)
  mkdirSync(join(dir, 'outbox'), { recursive: true })
  const results: Record<number, any> = {}
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: join(dir, 'state'),
      DASHBOARD_API_BASE: 'http://127.0.0.1:9',
      DASHBOARD_OUTBOX: join(dir, 'outbox'),
      DASHBOARD_SPEAK: join(dir, 'speak-absent'),
      DASHBOARD_CHAT_ONLY_AGENT_DIR: join(dir, 'chat-only-agents'),
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      DASHBOARD_CHAT_ONLY_AGENT: undefined as unknown as string,
      DASHBOARD_RELAY_ARGV: JSON.stringify(['bun', writeRelay(dir)]),
      USER: 'agent-webchat',
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const send = (m: unknown) => { proc.stdin.write(JSON.stringify(m) + '\n'); proc.stdin.flush() }
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'coa-test', version: '0' } } })
  let init: any = null
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) { init = msg.result; send({ jsonrpc: '2.0', method: 'notifications/initialized' }) }
          if (typeof msg.id === 'number' && msg.id >= 2) results[msg.id] = msg.result ?? msg.error
        } catch {}
      }
    }
  })()
  return { proc, results, send, init: () => init }
}

/** Leaked = the secret's bytes sit in a served outbox file, or a relay event names a path. */
function leaked(dir: string, creds: string): boolean {
  const outbox = join(dir, 'outbox')
  const inOutbox = readdirSync(outbox).some(f => readFileSync(join(outbox, f), 'utf8').includes(SECRET))
  const inEvent = ops(dir).some(o => o[0] === 'event' && o.slice(3).length > 0)
  return inOutbox || inEvent || ops(dir).some(o => o.includes(creds))
}

async function attachArm(env: Record<string, string>, marker: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-coa-'))
  const creds = join(dir, 'home', '.claude', '.credentials.json')
  mkdirSync(join(dir, 'home', '.claude'), { recursive: true })
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }))
  mkdirSync(join(dir, 'chat-only-agents'), { recursive: true })
  if (marker) writeFileSync(join(dir, 'chat-only-agents', 'webchat'), '')
  const a = startAdapter(dir, env)
  try {
    expect(await waitFor(() => ops(dir).some(o => o[0] === 'pending'), BOOT_MS + 8_000)).toBe(true)
    a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    a.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'reply', arguments: { chat_id: '33', text: 'Here you go.', files: [creds], voice: true } } })
    expect(await waitFor(() => a.results[3] !== undefined, 10_000)).toBe(true)
    return {
      tools: a.results[2]?.tools as any[],
      instructions: String(a.init()?.instructions ?? ''),
      events: ops(dir).filter(o => o[0] === 'event'),
      leak: leaked(dir, creds),
    }
  } finally {
    a.proc.kill()
    await a.proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('server.ts for a chat-only agent', () => {
  test('lock on (env): the credentials file never leaves; the text does', async () => {
    const r = await attachArm({ DASHBOARD_CHAT_ONLY_AGENT: '1' }, false)
    expect(r.leak).toBe(false)
    expect(r.events).toEqual([['event', '33', 'Here you go.']])
    expect(Object.keys(r.tools[0].inputSchema.properties).sort()).toEqual(['chat_id', 'text'])
    expect(r.instructions).not.toContain('Read that path')
    expect(r.instructions).not.toContain('files array')
  }, 30_000)

  test('lock on (marker only, env says 0): still nothing leaves', async () => {
    const r = await attachArm({ DASHBOARD_CHAT_ONLY_AGENT: '0' }, true)
    expect(r.leak).toBe(false)
    expect(r.events).toEqual([['event', '33', 'Here you go.']])
  }, 30_000)

  test('lock off: the same call DOES copy the file out, so this arm can see a leak', async () => {
    const r = await attachArm({}, false)
    expect(r.leak).toBe(true)
    expect(Object.keys(r.tools[0].inputSchema.properties)).toContain('files')
  }, 30_000)
})
