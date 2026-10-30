// DIVE-7349: the web chat on OpenClaw and Hermes seats. The dashboard server
// runs its adapter shape with a local spool: on OpenClaw openclawdispatch.ts
// answers each message with one `openclaw agent` turn, on Hermes the 5dive
// channel plugin (plugins/dashboard/hermes/adapter.py) reads the spool inside
// the Hermes gateway.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FAILED_TEXT, NO_ANSWER_TEXT, NOT_RUNNING_TEXT, OPENCLAW_HEADER, SESSION_KEY, VOICE_HINT,
  parseTurn, promptFor, startOpenclawDispatcher, type RunTurn,
} from '../plugins/dashboard/openclawdispatch.ts'

const DASH = join(import.meta.dir, '..', 'plugins', 'dashboard')
const SERVER = join(DASH, 'server.ts')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

function drop(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body))
  renameSync(join(dir, `.${name}.tmp`), join(dir, `${name}.json`))
}

const readOutbox = (dir: string) => {
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return [] }
}

describe('an OpenClaw turn', () => {
  test('the prompt names the web chat, flags a spoken note and points at an upload', () => {
    expect(promptFor({ text: '  hi there ' })).toBe(`${OPENCLAW_HEADER}\nhi there`)
    const v = promptFor({ text: '[voice note] good morning', route: { voice: true } })
    expect(v).toBe(`${OPENCLAW_HEADER}\n${VOICE_HINT}\n[voice note] good morning`)
    expect(promptFor({ text: 'look', image_path: '/home/claude/chat-uploads/a/p.png' })).toContain('[Attached file: /home/claude/chat-uploads/a/p.png]')
    expect(promptFor({ text: '', image_path: '/x/n.webm' })).toContain('[Voice note: /x/n.webm]')
  })

  test('reads the reply payloads, wherever the envelope puts them', () => {
    expect(parseTurn(JSON.stringify({ payloads: [{ text: 'Hello' }, { text: 'World' }] }), 0)).toEqual({ kind: 'reply', text: 'Hello\n\nWorld', files: [] })
    expect(parseTurn(`gateway noise\n${JSON.stringify({ ok: true, result: { payloads: [{ text: 'nested' }] } })}`, 0)).toMatchObject({ kind: 'reply', text: 'nested' })
    expect(parseTurn(JSON.stringify({ ok: true, status: 'ok', final: 'from final' }), 0)).toMatchObject({ kind: 'reply', text: 'from final' })
    expect(parseTurn(JSON.stringify({ payloads: [{ text: 'thinking', isReasoning: true }] }), 0)).toEqual({ kind: 'empty' })
    expect(parseTurn(JSON.stringify({ payloads: [] }), 0)).toEqual({ kind: 'empty' })
  })

  test('a failure says whether the gateway had taken the turn', () => {
    expect(parseTurn(JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'connect ECONNREFUSED 127.0.0.1:18789' } }), 1))
      .toEqual({ kind: 'failed', reason: 'connect ECONNREFUSED 127.0.0.1:18789', accepted: false })
    expect(parseTurn(JSON.stringify({ ok: false, runId: 'r1', origin: 'gateway', error: { message: 'timeout' } }), 1))
      .toMatchObject({ kind: 'failed', accepted: true })
    expect(parseTurn('', 1)).toMatchObject({ kind: 'failed', accepted: false })
  })
})

describe('the OpenClaw dispatcher', () => {
  function rig(run: RunTurn) {
    const root = mkdtempSync(join(tmpdir(), 'oc-dispatch-'))
    const inbox = join(root, 'inbox')
    const outbox = join(root, 'outbox', 'dashboard')
    const d = startOpenclawDispatcher({ inboxDir: inbox, outboxDir: outbox, run, log: () => {}, retries: 2, retryMs: 20 })
    cleanups.push(() => { d.stop(); rmSync(root, { recursive: true, force: true }) })
    return { inbox, outbox, d }
  }
  const msg = (id: string, text: string, voice = false) => ({ id, text, route: { source: 'dashboard', chat_id: 'dashboard', ...(voice ? { voice: true } : {}) } })

  test('answers in arrival order, one turn at a time, and keeps a voice note spoken', async () => {
    const seen: string[] = []
    let running = 0, overlap = false
    const r = rig(async prompt => {
      running++; if (running > 1) overlap = true
      await Bun.sleep(30)
      seen.push(prompt.split('\n').pop()!)
      running--
      return { stdout: JSON.stringify({ payloads: [{ text: `re: ${prompt.split('\n').pop()}` }] }), stderr: '', code: 0 }
    })
    drop(r.inbox, '1-a', msg('a', 'first'))
    drop(r.inbox, '2-b', msg('b', '[voice note] second', true))
    await waitFor(() => readOutbox(r.outbox).length === 2)
    expect(seen).toEqual(['first', '[voice note] second'])
    expect(overlap).toBe(false)
    const out = readOutbox(r.outbox)
    expect(out[0]).toMatchObject({ source: 'dashboard', chat_id: 'dashboard', text: 're: first' })
    expect(out[0].voice).toBeUndefined()
    expect(out[1]).toMatchObject({ text: 're: [voice note] second', voice: true })
    expect(readdirSync(r.inbox).filter(n => n.endsWith('.json'))).toEqual([])
  })

  test('a turn the gateway never took is retried; one it took is not, and ends in a notice', async () => {
    let calls = 0
    const r = rig(async () => {
      calls++
      return calls === 1
        ? { stdout: JSON.stringify({ ok: false, error: { message: 'connect ECONNREFUSED' } }), stderr: '', code: 1 }
        : { stdout: JSON.stringify({ payloads: [{ text: 'up now' }] }), stderr: '', code: 0 }
    })
    drop(r.inbox, '1', msg('a', 'boot race'))
    await waitFor(() => readOutbox(r.outbox).length === 1)
    expect(calls).toBe(2)
    expect(readOutbox(r.outbox)[0].text).toBe('up now')

    let accepted = 0
    const r2 = rig(async () => { accepted++; return { stdout: JSON.stringify({ ok: false, runId: 'r9', error: { message: 'model error' } }), stderr: '', code: 1 } })
    drop(r2.inbox, '1', msg('b', 'x'))
    await waitFor(() => readOutbox(r2.outbox).length === 1)
    await Bun.sleep(100)
    expect(accepted).toBe(1)
    expect(readOutbox(r2.outbox)[0].text).toBe(FAILED_TEXT)
  })

  test('a gateway that stays down, and a turn with no answer, each end in a plain notice', async () => {
    const r = rig(async () => ({ stdout: '', stderr: 'Error: gateway not running (ECONNREFUSED)', code: 1 }))
    drop(r.inbox, '1', msg('a', 'anyone?', true))
    await waitFor(() => readOutbox(r.outbox).length === 1)
    expect(readOutbox(r.outbox)[0]).toEqual({ source: 'dashboard', chat_id: 'dashboard', text: NOT_RUNNING_TEXT, kind: 'message' })
    const r2 = rig(async () => ({ stdout: JSON.stringify({ payloads: [] }), stderr: '', code: 0 }))
    drop(r2.inbox, '1', msg('b', 'hm'))
    await waitFor(() => readOutbox(r2.outbox).length === 1)
    expect(readOutbox(r2.outbox)[0].text).toBe(NO_ANSWER_TEXT)
  })
})

function fakeApi(pending: any[]) {
  const outbound: any[] = []
  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/server/messages/pending') return Response.json({ pending })
      if (url.pathname === '/server/messages/pending/ack') {
        const body = await req.json() as { ids: number[] }
        pending.splice(0, pending.length, ...pending.filter(m => !body.ids.includes(m.id)))
        return Response.json({ ok: true, acked: body.ids.length })
      }
      if (url.pathname === '/server/messages/event') {
        outbound.push(await req.json())
        return Response.json({ id: 200 + outbound.length })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { api, outbound }
}

function serverEnv(root: string, port: number, extra: Record<string, string>) {
  const sharedOutbox = join(root, 'downloads')
  mkdirSync(sharedOutbox, { recursive: true })
  const speak = join(root, '5dive-speak')
  writeFileSync(speak, `#!/usr/bin/env bash\nout=${JSON.stringify(root)}/speak-$RANDOM.ogg\nprintf 'OggS' > "$out"\necho "$out"\n`)
  chmodSync(speak, 0o755)
  return {
    ...process.env,
    DASHBOARD_DISPATCHER_SWEEP_MS: '200',
    DASHBOARD_INBOX_SWEEP_MS: '200',
    DASHBOARD_STATE_DIR: join(root, '.claude', 'channels', 'dashboard'),
    DASHBOARD_OUTBOX: sharedOutbox,
    DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
    DASHBOARD_SPEAK: speak,
    DASHBOARD_FFMPEG: '/bin/false',
    DASHBOARD_FFPROBE: '/bin/false',
    CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
    HOME: root,
    ...extra,
  }
}

describe('OpenClaw web chat end to end', () => {
  test("a typed message gets OpenClaw's answer through its gateway session", async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-dashboard-'))
    const argvLog = join(root, 'argv.log')
    const oc = join(root, 'openclaw')
    // Stands in for `openclaw agent --json`: echoes the message's last line back as the reply.
    // Shaped like openclaw 2026.10.9's gateway response; the message is read from the --message-file path.
    writeFileSync(oc, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n`
      + `f=""; while [ $# -gt 0 ]; do [ "$1" = --message-file ] && f="$2"; shift; done\n`
      + `stat -c %a "$f" >> ${JSON.stringify(argvLog)}\nmsg=$(tail -n 1 "$f")\n`
      + `printf 'gateway: connected\\n' >&2\nprintf '{"runId":"r1","status":"ok","summary":"completed","result":{"payloads":[{"text":"OpenClaw says: %s"}],"meta":{}}}\\n' "$msg"\n`)
    chmodSync(oc, 0o755)
    const { api, outbound } = fakeApi([{ id: 91, text: 'what is two plus two', from: 'owner', chat_id: 'dashboard' }])
    // The argv flag is what 5dive-agent-start passes.
    const child = Bun.spawn(['bun', SERVER, '--runtime=openclaw'], {
      env: serverEnv(root, api.port, { DASHBOARD_OPENCLAW_BIN: oc, USER: 'agent-ocdash' }),
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'ocdash', body: 'OpenClaw says: what is two plus two', metadata: { chat_id: 'dashboard' } })
    const argv = readFileSync(argvLog, 'utf8')
    expect(argv).toMatch(new RegExp(`agent --session-key ${SESSION_KEY} --message-file \\S+/\\.openclaw/channels/5dive/turns/turn-\\d+-0\\.txt --json`))
    // The message rode a private file, and the file is gone after the turn.
    expect(argv.split('\n')[1]).toBe('600')
    expect(readdirSync(join(root, '.openclaw', 'channels', '5dive', 'turns'))).toEqual([])
    // Started with no MCP parent and stdin closed, the bridge stays up.
    expect(child.exitCode).toBeNull()

    const inbox = join(root, '.claude', 'channels', 'dashboard', 'agent-inbox')
    drop(inbox, 'v', { text: '[voice note] good morning', chat_id: 'dashboard' })
    await waitFor(() => outbound.length === 3)
    expect(outbound[1].body).toBe('OpenClaw says: [voice note] good morning')
    expect(outbound[2].metadata.files[0]).toMatch(/\.ogg$/)
  }, 30_000)
})

describe('Hermes web chat end to end', () => {
  // The adapter file is the one the Hermes gateway loads. Hermes itself is not
  // on the CI runner, so its four base types are stubbed to the shape the
  // adapter uses; the spool reading and writing are the plugin's own code.
  const STUB = `
import sys, types, enum, dataclasses, asyncio, json, os, importlib.util
from typing import Any, List, Optional
cfg = types.ModuleType('gateway.config'); base = types.ModuleType('gateway.platforms.base')
class Platform(str):
    pass
@dataclasses.dataclass
class PlatformConfig:
    enabled: bool = True
    extra: dict = dataclasses.field(default_factory=dict)
class MessageType(enum.Enum):
    TEXT='text'; PHOTO='photo'; VOICE='voice'; DOCUMENT='document'
@dataclasses.dataclass
class SendResult:
    success: bool; message_id: Optional[str] = None; error: Optional[str] = None
@dataclasses.dataclass
class MessageEvent:
    text: str; message_type: Any = None; source: Any = None; message_id: Any = None; raw_message: Any = None
    timestamp: Any = None; media_urls: List[str] = dataclasses.field(default_factory=list); media_types: List[str] = dataclasses.field(default_factory=list)
class BasePlatformAdapter:
    def __init__(self, config, platform): self.config = config; self.platform = platform; self._running = False; self.name = 'fivedive'
    def _mark_connected(self): self._running = True
    def _mark_disconnected(self): self._running = False
    def build_source(self, **kw): return types.SimpleNamespace(**kw)
cfg.Platform = Platform; cfg.PlatformConfig = PlatformConfig
for n in ('MessageType','SendResult','MessageEvent','BasePlatformAdapter'): setattr(base, n, globals()[n])
sys.modules.update({'gateway': types.ModuleType('gateway'), 'gateway.platforms': types.ModuleType('gateway.platforms'), 'gateway.config': cfg, 'gateway.platforms.base': base})
spec = importlib.util.spec_from_file_location('fivedive', sys.argv[1] + '/__init__.py', submodule_search_locations=[sys.argv[1]])
mod = importlib.util.module_from_spec(spec); sys.modules['fivedive'] = mod; spec.loader.exec_module(mod)
from fivedive import adapter as A
registered = {}
mod.register(types.SimpleNamespace(register_platform=lambda **kw: registered.update(kw)))
assert registered['name'] == 'fivedive' and registered['allowed_users_env'] == 'FIVEDIVE_ALLOWED_USERS', registered
ad = registered['adapter_factory'](PlatformConfig(extra=registered['env_enablement_fn']()))
A.POLL_SECONDS = 0.05
async def answer(ev):
    # The gateway's reply path: the agent's answer goes out through send().
    await ad.send(ev.source.chat_id, 'Hermes says: ' + ev.text)
    print('EVENT', json.dumps({'text': ev.text, 'user': ev.source.user_id, 'chat': ev.source.chat_id, 'type': ev.message_type.value, 'media': ev.media_urls}), flush=True)
ad.handle_message = answer
async def main():
    assert await ad.connect()
    await asyncio.sleep(float(sys.argv[2]))
    await ad.disconnect()
asyncio.run(main())
`

  test("a typed message reaches the Hermes plugin and its answer reaches the chat, spoken for a voice note", async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-dashboard-'))
    const spool = join(root, '.hermes', 'channels', '5dive')
    const upload = join(root, 'chat-uploads', 'p.png')
    mkdirSync(join(root, 'chat-uploads'), { recursive: true })
    writeFileSync(upload, 'png')
    const { api, outbound } = fakeApi([{ id: 71, text: 'what is two plus two', from: 'owner', chat_id: 'dashboard' }])
    const child = Bun.spawn(['bun', SERVER, '--runtime=hermes'], {
      env: serverEnv(root, api.port, { USER: 'agent-hermesdash' }),
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    writeFileSync(join(root, 'stub.py'), STUB)
    const py = Bun.spawn(['python3', join(root, 'stub.py'), join(DASH, 'hermes'), '12'], {
      env: { ...process.env, FIVEDIVE_SPOOL_DIR: spool, FIVEDIVE_ALLOWED_USERS: '5dive-app', PYTHONDONTWRITEBYTECODE: '1' },
      stdout: 'pipe', stderr: 'pipe',
    })
    cleanups.push(() => { child.kill(); py.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({ agent: 'hermesdash', body: 'Hermes says: what is two plus two', metadata: { chat_id: 'dashboard' } })
    expect(child.exitCode).toBeNull()

    const inbox = join(root, '.claude', 'channels', 'dashboard', 'agent-inbox')
    drop(inbox, 'v', { text: '[voice note] good morning', chat_id: 'dashboard' })
    await waitFor(() => outbound.length === 3)
    expect(outbound[1].body).toBe('Hermes says: [voice note] good morning')
    expect(outbound[2].metadata.files[0]).toMatch(/\.ogg$/)

    drop(inbox, 'f', { text: 'look at this', chat_id: 'dashboard', image_path: upload })
    await waitFor(() => outbound.length === 4)
    expect(outbound[3].body).toBe('Hermes says: look at this')
    py.kill()
    const events = (await new Response(py.stdout).text()).split('\n').filter(l => l.startsWith('EVENT ')).map(l => JSON.parse(l.slice(6)))
    expect(events[0]).toEqual({ text: 'what is two plus two', user: '5dive-app', chat: 'dashboard', type: 'text', media: [] })
    expect(events[2]).toMatchObject({ type: 'photo', media: [upload] })
  }, 30_000)
})
