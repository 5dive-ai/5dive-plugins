// DIVE-8146: the 5dive chat packages for Pi (`@5dive/pi-chat`) and OpenCode
// (`@5dive/opencode-chat`), and the stand-down that keeps the box's own
// headless reader (clidispatch.ts) off the inbox while a package reads it.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promptFor as bridgePrompt, readerActive, startCliDispatcher } from '../plugins/dashboard/clidispatch.ts'
import * as spool from '../plugins/dashboard/pi-chat/src/spool.ts'
import { answerText, isOneShot } from '../plugins/dashboard/opencode-chat/src/answer.ts'
import { assistantText } from '../plugins/dashboard/pi-chat/extensions/5dive-chat.ts'

const DASH = join(import.meta.dir, '..', 'plugins', 'dashboard')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dive8146-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d }
const drop = (dir: string, name: string, body: unknown) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `.${name}.tmp`), JSON.stringify(body))
  renameSync(join(dir, `.${name}.tmp`), join(dir, `${name}.json`))
}
const outbox = (dir: string) => { try { return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))) } catch { return [] } }

describe('one spool module in both packages', () => {
  test('the two copies are byte for byte the same', () => {
    expect(readFileSync(join(DASH, 'opencode-chat', 'src', 'spool.ts'), 'utf8')).toBe(readFileSync(join(DASH, 'pi-chat', 'src', 'spool.ts'), 'utf8'))
  })

  test('a turn reads the same text the bridge itself would send (text, voice, upload)', () => {
    for (const raw of [
      { id: 'a', text: ' hi ', route: { source: 'dashboard', chat_id: 'dashboard' } },
      { id: 'b', text: 'say it', route: { source: 'dashboard', chat_id: 'dashboard', voice: true } },
      { id: 'c', text: '', image_path: '/tmp/x.png', route: { source: 'dashboard', chat_id: 'c2' } },
      { id: 'd', text: 'note', image_path: '/tmp/n.ogg', route: { source: 'dashboard', chat_id: 'dashboard' } },
    ]) {
      expect(spool.promptFor(spool.parseMessage(raw, 'x')!)).toBe(bridgePrompt(raw as never))
    }
  })

  test('takes messages oldest first, removes them, drops junk, leaves temp files', () => {
    const s = tmp()
    spool.ensureSpool(s)
    const inbox = spool.inboxDir(s)
    drop(inbox, '2-1-0', { id: 'second', text: 'two', route: { source: 'dashboard', chat_id: 'dashboard' } })
    drop(inbox, '1-1-0', { id: 'first', text: 'one', route: { source: 'dashboard', chat_id: 'dashboard', voice: true } })
    drop(inbox, '3-1-0', { text: 'not ours', route: { source: 'telegram' } })
    writeFileSync(join(inbox, '4-1-0.json'), '{half')
    writeFileSync(join(inbox, '.5-1-0.tmp'), '{}')
    const got = spool.takeInbox(s)
    expect(got.map(m => m.id)).toEqual(['first', 'second'])
    expect(got[0].route).toEqual({ source: 'dashboard', chat_id: 'dashboard', voice: true })
    expect(readdirSync(inbox)).toEqual(['.5-1-0.tmp'])
    expect(spool.takeInbox(s)).toEqual([])
  })

  test('a reply lands whole in the outbox the bridge sends from, route echoed', () => {
    const s = tmp()
    spool.writeReply(s, { source: 'dashboard', chat_id: 'dashboard', voice: true }, 'hello', 'pi')
    expect(outbox(spool.outboxDir(s))).toEqual([{ source: 'dashboard', chat_id: 'dashboard', voice: true, text: 'hello', kind: 'message' }])
    expect(readdirSync(spool.outboxDir(s)).some(n => n.startsWith('.'))).toBe(false)
  })

  test('the spool is FIVEDIVE_SPOOL_DIR, else where the bridge keeps it for that runtime', () => {
    expect(spool.spoolDir('pi', { FIVEDIVE_SPOOL_DIR: '/x/y' }, '/h')).toBe('/x/y')
    expect(spool.spoolDir('pi', {}, '/h')).toBe('/h/.pi/channels/5dive')
    expect(spool.spoolDir('opencode', { FIVEDIVE_SPOOL_DIR: ' ' }, '/h')).toBe('/h/.opencode/channels/5dive')
    // the same defaults server.ts uses for a pi / opencode seat
    const server = readFileSync(join(DASH, 'server.ts'), 'utf8')
    expect(server).toContain("PI ? join(homedir(), '.pi', 'channels', '5dive')")
    expect(server).toContain("OPENCODE ? join(homedir(), '.opencode', 'channels', '5dive')")
  })

  test('release drops only our own mark', () => {
    const s = tmp()
    spool.claimReader(s, 'pi', 4242)
    spool.releaseReader(s, 4343)
    expect(existsSync(spool.readerFile(s))).toBe(true)
    spool.releaseReader(s, 4242)
    expect(existsSync(spool.readerFile(s))).toBe(false)
  })
})

describe('reply text', () => {
  test('pi: the text blocks of an assistant message; tool calls and thinking are not text', () => {
    expect(assistantText({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: ' 51 ' }, { type: 'toolCall' }] } as never)).toBe('51')
    expect(assistantText({ role: 'user', content: [{ type: 'text', text: 'hi' }] } as never)).toBe('')
    expect(assistantText({ role: 'assistant', content: [{ type: 'toolCall' }] } as never)).toBe('')
  })

  test('opencode: the text after the last tool call, else every text part; synthetic parts never', () => {
    expect(answerText([{ type: 'text', text: 'let me look' }, { type: 'tool' }, { type: 'text', text: 'it is 51' }])).toBe('it is 51')
    expect(answerText([{ type: 'text', text: 'a' }, { type: 'step-finish' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
    expect(answerText([{ type: 'text', text: 'only' }, { type: 'tool' }])).toBe('only')
    expect(answerText([{ type: 'text', text: 'x', synthetic: true }])).toBe('')
  })

  test('opencode: `opencode run` is a one-shot turn and never reads the chat; serve and the TUI do', () => {
    expect(isOneShot(['/bin/opencode', 'run', '--format', 'json'])).toBe(true)
    expect(isOneShot(['bun', '/$bunfs/root/opencode', 'run'])).toBe(true)
    expect(isOneShot(['/bin/opencode', 'serve', '--port', '1'])).toBe(false)
    expect(isOneShot(['/bin/opencode'])).toBe(false)
  })

  test('opencode: the plugin module exports only the plugin (OpenCode starts every export)', async () => {
    const src = readFileSync(join(DASH, 'opencode-chat', 'index.ts'), 'utf8')
    expect(src.match(/^export /gm)).toEqual(['export '])
    expect(src).toContain('export const FivediveChat: Plugin')
  })
})

describe('the box reader stands down while a package reads (DIVE-8146)', () => {
  // A live process whose program is named `pi`: a symlink to sleep.
  const liveNamed = (name: string) => {
    const d = tmp()
    symlinkSync('/bin/sleep', join(d, name))
    const p = spawn(join(d, name), ['30'], { stdio: 'ignore' })
    cleanups.push(() => { try { p.kill('SIGKILL') } catch {} })
    return p.pid!
  }

  test('only a live process of that runtime holds the inbox', () => {
    const s = tmp()
    expect(readerActive(s, 'pi')).toBe(false)                         // no mark
    const pi = liveNamed('pi')
    spool.claimReader(s, 'pi', pi)
    expect(readerActive(s, 'pi')).toBe(true)
    expect(readerActive(s, 'opencode')).toBe(false)                   // marked for the other runtime
    const other = liveNamed('sleepy')
    spool.claimReader(s, 'pi', other)
    expect(readerActive(s, 'pi')).toBe(false)                         // a reused pid, another program
    spool.claimReader(s, 'pi', 2 ** 22 + 7)
    expect(readerActive(s, 'pi')).toBe(false)                         // dead pid (above pid_max)
    writeFileSync(spool.readerFile(s), '{nope')
    expect(readerActive(s, 'pi')).toBe(false)                         // unreadable mark
    const oc = liveNamed('opencode')
    spool.claimReader(s, 'opencode', oc)
    expect(readerActive(s, 'opencode')).toBe(true)
  })

  test('the dispatcher leaves the inbox alone while stood down, and answers once it is not', async () => {
    const s = tmp()
    const inbox = join(s, 'inbox'), out = join(s, 'outbox', 'dashboard')
    let off = true
    let turns = 0
    const d = startCliDispatcher({ runtime: 'pi', inboxDir: inbox, outboxDir: out, log: () => {}, standDown: () => off,
      run: async () => { turns++; return { kind: 'reply', text: 'from the bridge' } } })
    cleanups.push(() => d.stop())
    drop(inbox, '1-1-0', { id: 'm1', text: 'hi', route: { source: 'dashboard', chat_id: 'dashboard' } })
    await Bun.sleep(1300)
    expect(turns).toBe(0)
    expect(readdirSync(inbox)).toEqual(['1-1-0.json'])                // left for the package
    off = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && outbox(out).length === 0) await Bun.sleep(25)
    await d.idle()
    expect(turns).toBe(1)
    expect(outbox(out).map(r => r.text)).toEqual(['from the bridge'])
  })

  test('server.ts wires the stand-down to the seat spool', () => {
    expect(readFileSync(join(DASH, 'server.ts'), 'utf8')).toContain('standDown: () => readerActive(DISPATCHER_STATE_DIR, runtime)')
  })
})
