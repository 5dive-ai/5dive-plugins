// DIVE-4280: the auto-attach decision matrix. A path the agent NAMES in a
// Telegram reply ships as a file even when files= was forgotten — which is
// most of the time, because the paired human has no terminal and the
// "attach every file you name" rule in CLAUDE.md does not transfer.
//
// The arms that matter are the NEGATIVE ones. This runs on text the agent
// wrote without knowing it would be attached, so the denylist (bot token in
// ~/.claude/channels/telegram/access.json, .env, ssh keys) and lodar's 5-file
// cap are the load-bearing parts; a missed attachment is a nuisance, a leaked
// token is not. Pure logic in plugins/telegram/autoattach.ts so no server
// boots (server.ts long-polls Telegram on import).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planAutoAttach,
  autoAttachFooter,
  candidatePaths,
  isDenied,
  AUTO_ATTACH_MAX,
  AUTO_ATTACH_EXTS,
  AUTO_PHOTO_EXTS,
} from '../plugins/telegram/autoattach'

let HOME: string
let ROOT: string
const P = (rel: string) => join(ROOT, rel)

function touch(path: string, bytes = 16): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
  return path
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'dive4280-'))
  HOME = join(base, 'home')
  ROOT = join(base, 'work')
  mkdirSync(HOME, { recursive: true })
  mkdirSync(ROOT, { recursive: true })
  touch(P('report.md'))
  touch(P('second.md'))
  touch(P('third.md'))
  touch(P('four.md'))
  touch(P('five.md'))
  touch(P('six.md'))
  touch(P('seven.md'))
  touch(P('shot.png'))
  touch(P('script.sh'))
  touch(P('notes.md.bak'))
  touch(P('huge.mp4'), 0) // size faked via probe in the size arm
  touch(join(HOME, '.claude', 'channels', 'telegram', 'access.json'))
  touch(join(HOME, '.claude', 'settings.json'))
  touch(P('.env'))
  touch(P('deploy-token.txt'))
  touch(P('id_ed25519'))
  mkdirSync(P('sub'), { recursive: true })
  symlinkSync(join(HOME, '.claude', 'channels', 'telegram', 'access.json'), P('sub/innocent.json'))
})
afterAll(() => {
  try { rmSync(join(HOME, '..'), { recursive: true, force: true }) } catch {}
})

const plan = (text: string, already: string[] = []) =>
  planAutoAttach(text, { home: HOME, already })

describe('positive: a named file is attached without files=', () => {
  test('the acceptance case from the row', () => {
    const p = plan(`wrote the report to ${P('report.md')}`)
    expect(p.attach).toEqual([P('report.md')])
    expect(p.overflow).toBe(0)
    expect(autoAttachFooter(p)).toBe('attached: report.md')
  })
  test('a path in single backticks in prose still counts', () => {
    expect(plan(`see \`${P('report.md')}\` for the numbers`).attach).toEqual([P('report.md')])
  })
  test('trailing sentence punctuation is not part of the path', () => {
    expect(plan(`it is at ${P('report.md')}.`).attach).toEqual([P('report.md')])
    expect(plan(`(${P('report.md')})`).attach).toEqual([P('report.md')])
  })
  test('~/-relative paths resolve against home', () => {
    touch(join(HOME, 'out.md'))
    expect(plan('left it in ~/out.md').attach).toEqual([join(HOME, 'out.md')])
  })
  test('images are routed to the photo transport, not documents', () => {
    expect(plan(`screenshot: ${P('shot.png')}`).attach).toEqual([P('shot.png')])
    expect(AUTO_PHOTO_EXTS.has('.png')).toBe(true)
    expect(AUTO_PHOTO_EXTS.has('.pdf')).toBe(false)
  })
  test('the decided eligible set is documents AND media, and excludes code', () => {
    for (const e of ['.md', '.txt', '.log', '.json', '.csv', '.yaml', '.html', '.pdf',
                     '.png', '.jpg', '.jpeg', '.gif', '.webp',
                     '.mp4', '.mov', '.mp3', '.m4a', '.ogg']) {
      expect(AUTO_ATTACH_EXTS.has(e)).toBe(true)
    }
    for (const e of ['.sh', '.py', '.ts', '.tgz', '.zip', '']) {
      expect(AUTO_ATTACH_EXTS.has(e)).toBe(false)
    }
    expect(plan(`run ${P('script.sh')}`).attach).toEqual([])
    expect(plan(`old copy ${P('notes.md.bak')}`).attach).toEqual([])
  })
})

describe('negative: nothing that is not really a produced artefact', () => {
  test('a missing path attaches nothing', () => {
    expect(plan(`I will write ${P('never-written.md')} next`).attach).toEqual([])
    expect(autoAttachFooter(plan('nothing here'))).toBe('')
  })
  test('a directory is not a file', () => {
    expect(plan(`look in ${P('sub')}`).attach).toEqual([])
  })
  test('an example path inside a fenced block is not attached', () => {
    const text = ['here is the shape:', '```bash', `cat ${P('report.md')}`, '```'].join('\n')
    expect(plan(text).attach).toEqual([])
  })
  test('a tilde-fence variant is stripped too', () => {
    const text = ['example:', '~~~', P('report.md'), '~~~'].join('\n')
    expect(plan(text).attach).toEqual([])
  })
  test('an unterminated fence swallows the rest (fail closed, not open)', () => {
    const text = ['example:', '```', P('report.md')].join('\n')
    expect(plan(text).attach).toEqual([])
  })
  test('the same path twice in one text attaches once', () => {
    const p = plan(`${P('report.md')} — again: ${P('report.md')}`)
    expect(p.attach).toEqual([P('report.md')])
    expect(p.overflow).toBe(0)
  })
})

describe('denylist: credential-shaped paths never auto-attach', () => {
  test('the channel access file that holds the bot token', () => {
    const secret = join(HOME, '.claude', 'channels', 'telegram', 'access.json')
    const p = plan(`the token lives in ${secret}`)
    expect(p.attach).toEqual([])
    expect(autoAttachFooter(p)).toBe('')
  })
  test('anything under ~/.claude, named with ~ or absolute', () => {
    expect(plan('see ~/.claude/settings.json').attach).toEqual([])
    expect(isDenied(join(HOME, '.claude', 'settings.json'), HOME)).toBe(true)
  })
  test('.env, *token*, ssh keys, pem/key', () => {
    expect(plan(`${P('.env')}`).attach).toEqual([])
    expect(plan(`${P('deploy-token.txt')}`).attach).toEqual([])
    expect(plan(`${P('id_ed25519')}`).attach).toEqual([])
    expect(isDenied('/x/prod.pem')).toBe(true)
    expect(isDenied('/x/server.key')).toBe(true)
    expect(isDenied('/x/my-secrets.json')).toBe(true)
  })
  test('host state dirs', () => {
    expect(isDenied('/etc/5dive/config.json')).toBe(true)
    expect(isDenied('/var/lib/5dive/tasks.db')).toBe(true)
  })
  test('a symlink cannot launder a denied file out (checked on the resolved path)', () => {
    expect(plan(`harmless: ${P('sub/innocent.json')}`).attach).toEqual([])
  })
})

describe("lodar's cap: five tops, then say how many were skipped", () => {
  test('three named .md paths → three documents', () => {
    const p = plan([P('report.md'), P('second.md'), P('third.md')].join(' and '))
    expect(p.attach.length).toBe(3)
    expect(p.overflow).toBe(0)
    expect(autoAttachFooter(p)).toBe('attached: report.md, second.md, third.md')
  })
  test('seven named paths → five documents and the footer says +2', () => {
    const names = ['report', 'second', 'third', 'four', 'five', 'six', 'seven']
    const p = plan(names.map(n => P(`${n}.md`)).join(' '))
    expect(p.attach.length).toBe(AUTO_ATTACH_MAX)
    expect(p.attach).toEqual(names.slice(0, 5).map(n => P(`${n}.md`)))
    expect(p.overflow).toBe(2)
    expect(autoAttachFooter(p)).toContain('+2 more files named; ask for one by name')
  })
})

describe('explicit files= wins and is never doubled', () => {
  test('a path already in files= is not auto-attached again', () => {
    const p = plan(`the report is at ${P('report.md')}`, [P('report.md')])
    expect(p.attach).toEqual([])
    expect(autoAttachFooter(p)).toBe('')
  })
  test('files= does not suppress a DIFFERENT named path', () => {
    const p = plan(`${P('report.md')} plus ${P('second.md')}`, [P('report.md')])
    expect(p.attach).toEqual([P('second.md')])
  })
})

describe('size cap', () => {
  test('over Telegram\'s per-file cap → not sent, and the footer says so', () => {
    const p = planAutoAttach(`the capture is ${P('huge.mp4')}`, {
      home: HOME,
      probe: (x) => ({ real: x, size: 80 * 1024 * 1024 }),
    })
    expect(p.attach).toEqual([])
    expect(p.tooLarge).toEqual([P('huge.mp4')])
    expect(autoAttachFooter(p)).toBe('too large to send: huge.mp4')
  })
})

describe('candidatePaths — the scanner itself', () => {
  test('bare ~ and / are not paths', () => {
    expect(candidatePaths('cd ~ then /', HOME)).toEqual([])
  })
  test('order is preserved (the cap takes the FIRST five)', () => {
    expect(candidatePaths('/a/1.md /a/2.md /a/3.md')).toEqual(['/a/1.md', '/a/2.md', '/a/3.md'])
  })
})

describe('server wiring', () => {
  const src = Bun.file(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'))
  test('both send paths plan an auto-attach, and the edit path scans only the new body', async () => {
    const s = await src.text()
    expect(s).toContain("planAutoAttach(text, { already: files })")
    expect(s).toContain('planAutoAttach(body, { already: [...editMemo] })')
    // The footer must be appended AFTER yesNoButtons() has read the original
    // text, or it eats the trailing '?' the keyboards key off.
    expect(s.indexOf('yesNoButtons(text)')).toBeLessThan(s.indexOf('const stripped = autoFooter'))
    // The footer is part of the logical message, so `stripped` (what the
    // rolling log records) is the footer-bearing text.
    expect(s).toContain('text: stripped,')
    // assertSendable stays as the second net over the channel state dir.
    expect(s).toContain('assertSendable(f)')
  })
})
