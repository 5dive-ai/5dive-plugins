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
  attachedNames,
  candidatePaths,
  isDenied,
  AUTO_ATTACH_MAX,
  AUTO_ATTACH_EXTS,
  AUTO_PHOTO_EXTS,
} from '../plugins/telegram/autoattach'

let HOME: string
let ROOT: string
/** A SECOND seat's home, to prove the denylist is not rooted at the running seat. */
let OTHER_HOME: string
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
  OTHER_HOME = join(base, 'home-other-seat')
  mkdirSync(HOME, { recursive: true })
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(OTHER_HOME, { recursive: true })
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
  touch(join(HOME, '.claude.json'))
  touch(join(OTHER_HOME, '.claude', 'channels', 'telegram', 'access.json'))
  touch(join(OTHER_HOME, '.claude.json'))
  touch(join(OTHER_HOME, '.ssh', 'config'))
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
    // The human's message says nothing: the file itself is right below it.
    expect(autoAttachFooter(p)).toBe('')
    // The name is not lost, it moved to the readers that cannot see a file.
    expect(attachedNames(p)).toBe('attached: report.md')
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

  // The two arms quinn's verify pass proved were missing at 2dd2f33. Both files
  // exist, are readable by the running seat, and end in an eligible extension —
  // only the denylist stands between them and the chat.
  test('~/.claude.json — a SIBLING of ~/.claude, which no directory rule reaches', () => {
    const p = plan('your config is at ~/.claude.json')
    expect(p.attach).toEqual([])
    expect(autoAttachFooter(p)).toBe('')
    expect(isDenied(join(HOME, '.claude.json'), HOME)).toBe(true)
    // …and by its absolute path, and in any other seat's home.
    expect(plan(`see ${join(HOME, '.claude.json')}`).attach).toEqual([])
    expect(plan(`see ${join(OTHER_HOME, '.claude.json')}`).attach).toEqual([])
  })

  test("ANOTHER seat's /home/<x>/.claude/channels/telegram/access.json", () => {
    // Seat homes on this host are mutually readable (that file is mode 0644 and
    // holds the paired human's chat ids), so a homedir()-rooted prefix is not a
    // denylist — it is a denylist for one seat.
    const theirs = join(OTHER_HOME, '.claude', 'channels', 'telegram', 'access.json')
    const p = plan(`their token lives in ${theirs}`)
    expect(p.attach).toEqual([])
    expect(autoAttachFooter(p)).toBe('')
    expect(isDenied(theirs, HOME)).toBe(true)
    expect(isDenied(join(OTHER_HOME, '.claude', 'settings.json'), HOME)).toBe(true)
    expect(isDenied(join(OTHER_HOME, '.ssh', 'config'), HOME)).toBe(true)
    // The segment rule holds for a tree that is nobody's home at all.
    expect(isDenied('/srv/backup/home/agent-main/.claude/settings.json', HOME)).toBe(true)
  })

  // quinn's third verify pass: /var/log/5dive/agent-audit.log is 0640
  // root:claude (every seat reads it through the `claude` group), 20 MB — under
  // the send cap — and it logs command ARGUMENTS, which on this box include
  // cleartext telegram bot tokens. This arm names the REAL file, so it only
  // passes because the rule denies it, not because the path is fictional.
  test('/var/log/5dive/agent-audit.log — the real, readable, under-cap audit log', () => {
    const real = '/var/log/5dive/agent-audit.log'
    const p = plan(`the audit trail is in ${real}`)
    expect(p.attach).toEqual([])
    expect(p.overflow).toBe(0)
    expect(autoAttachFooter(p)).toBe('')
    expect(isDenied(real, HOME)).toBe(true)
    expect(isDenied('/var/log/auth.log', HOME)).toBe(true)
  })

  // The structural half of the fix: three iterations each found one more place
  // the enumeration missed, so eligibility is now an ALLOWLIST of roots. A
  // sensitive directory nobody thought to name is ineligible for being outside
  // them, with no entry required.
  test('anything outside the attachable roots is ineligible without being named', () => {
    for (const outside of [
      '/etc/hosts.json',
      '/etc/nginx/sites-enabled/default.json',
      '/var/lib/postgresql/dump.csv',
      '/var/log/5dive/agent-audit.log',
      '/usr/share/doc/readme.txt',
      '/opt/vendor/config.yaml',
      '/proc/self/environ.txt',
      '/boot/grub/grub.csv',
    ]) {
      expect(isDenied(outside, HOME)).toBe(true)
    }
  })

  test('positive control: the allowlist did not swallow the feature', () => {
    // Homes, scratch dirs and the working tree stay eligible — this is the arm
    // that would fail if the roots were drawn too tight.
    expect(isDenied(join(HOME, 'notes', 'summary.md'), HOME)).toBe(false)
    expect(isDenied('/home/agent-x/report.md', HOME)).toBe(false)
    expect(isDenied('/tmp/report.md', HOME)).toBe(false)
    expect(isDenied('/var/tmp/report.md', HOME)).toBe(false)
    expect(isDenied(join(process.cwd(), 'plugins', 'telegram', 'README.md'), HOME)).toBe(false)
    // and end to end, not just through the predicate
    expect(plan(`wrote it to ${P('report.md')}`).attach).toEqual([P('report.md')])
  })
})

describe("lodar's cap: five tops, then say how many were skipped", () => {
  test('three named .md paths → three documents', () => {
    const p = plan([P('report.md'), P('second.md'), P('third.md')].join(' and '))
    expect(p.attach.length).toBe(3)
    expect(p.overflow).toBe(0)
    expect(autoAttachFooter(p)).toBe('')
    expect(attachedNames(p)).toBe('attached: report.md, second.md, third.md')
  })
  test('seven named paths → five documents and the footer says +2', () => {
    const names = ['report', 'second', 'third', 'four', 'five', 'six', 'seven']
    const p = plan(names.map(n => P(`${n}.md`)).join(' '))
    expect(p.attach.length).toBe(AUTO_ATTACH_MAX)
    expect(p.attach).toEqual(names.slice(0, 5).map(n => P(`${n}.md`)))
    expect(p.overflow).toBe(2)
    // Exactly the overflow line now — no 'attached:' above it.
    expect(autoAttachFooter(p)).toBe('+2 more files named; ask for one by name')
    expect(attachedNames(p)).toBe('attached: report.md, second.md, third.md, four.md, five.md')
  })
})

describe('explicit files= wins and is never doubled', () => {
  test('a path already in files= is not auto-attached again', () => {
    const p = plan(`the report is at ${P('report.md')}`, [P('report.md')])
    expect(p.attach).toEqual([])
    expect(autoAttachFooter(p)).toBe('')
    expect(attachedNames(p)).toBe('')
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
    // The rolling log records the footer-bearing text PLUS the names the
    // human's message no longer carries — `recent_messages` reads it back as
    // text and cannot see an attachment.
    expect(s).toContain('const loggedText = autoNames ?')
    expect(s).toContain('text: loggedText,')
    expect(s).not.toContain('text: stripped,')
    // assertSendable stays as the second net over the channel state dir.
    expect(s).toContain('assertSendable(f)')
  })
})

// The DIVE-4280 footer said 'attached: <name>' in the message the human reads.
// The attachment lands directly underneath it, so that line told them what they
// could already see. It is gone from the text and kept everywhere the file is
// NOT visible: the tool result and the rolling log.
describe('the attached names leave the human text and stay in the record', () => {
  test('attachedNames: one file, three files, none', () => {
    expect(attachedNames(plan(`wrote the report to ${P('report.md')}`)))
      .toBe('attached: report.md')
    expect(attachedNames(plan([P('report.md'), P('second.md'), P('third.md')].join(' and '))))
      .toBe('attached: report.md, second.md, third.md')
    expect(attachedNames(plan('nothing here'))).toBe('')
  })

  test('the two halves are disjoint: a name is never in both', () => {
    const p = plan([P('report.md'), P('second.md')].join(' '))
    expect(autoAttachFooter(p)).not.toContain('report.md')
    expect(attachedNames(p)).toContain('report.md')
    // and what the attachment cannot say stays with the human
    const over = plan(['report', 'second', 'third', 'four', 'five', 'six']
      .map(n => P(`${n}.md`)).join(' '))
    expect(autoAttachFooter(over)).toBe('+1 more files named; ask for one by name')
    expect(autoAttachFooter(over)).not.toContain('attached:')
  })

  test('a too-large file is still the human\'s business', () => {
    const p = planAutoAttach(`the capture is ${P('huge.mp4')}`, {
      home: HOME,
      probe: (x) => ({ real: x, size: 80 * 1024 * 1024 }),
    })
    expect(autoAttachFooter(p)).toBe('too large to send: huge.mp4')
    expect(attachedNames(p)).toBe('')
  })
})

describe('server wiring: where the names went instead', () => {
  const src = Bun.file(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'))

  test('the reply tool result carries them', async () => {
    const s = await src.text()
    expect(s).toContain('const autoNames = attachedNames(autoPlan)')
    expect(s).toContain('const result = autoNames ? `${sentLine} · ${autoNames}` : sentLine')
    // and the text the human gets is built from the footer ALONE
    expect(s).toContain('const stripped = autoFooter')
    expect(s).not.toContain('${strippedRaw}\n\n${parseMode ? mdv2(autoNames)')
  })

  test('the edit_message result carries them too', async () => {
    const s = await src.text()
    expect(s).toContain('const editNames = attachedNames(editPlan)')
    expect(s).toContain('editNames ? `${editedLine} · ${editNames}` : editedLine')
  })

  test('the reply tool description no longer promises a line in the message', async () => {
    const s = await src.text()
    expect(s).toContain('names the attached files in the tool result')
    expect(s).not.toContain("appends an \\'attached: <name>\\' line")
  })
})

// MUTANT. Put the line back into the human-facing footer, in the shipped source,
// and require the '' arm above to go red on it. This is the defect this PR
// removes, so an arm that stays green on the mutant is grading nothing.
describe('MUTANT: the attached line pushed back into the human footer', () => {
  test('reds the arms that pin the new contract, and the mutation really applied', async () => {
    const srcPath = join(import.meta.dir, '..', 'plugins', 'telegram', 'autoattach.ts')
    const src = await Bun.file(srcPath).text()
    const anchor = 'export function autoAttachFooter(plan: AutoAttachPlan): string {\n'
      + '  const lines: string[] = []\n'
    // NON-VACUITY: without this, a stale anchor makes the 'mutant' a byte copy
    // of the shipped function, and every assertion below passes for no reason.
    expect(src).toContain(anchor)
    const mutated = src.replace(anchor, anchor
      + '  if (plan.attach.length) {\n'
      + '    lines.push(`attached: ${plan.attach.map(p => basename(p)).join(\', \')}`)\n'
      + '  }\n')
    expect(mutated).not.toBe(src)

    const dir = mkdtempSync(join(tmpdir(), 'dive4280-mutant-'))
    try {
      const file = join(dir, 'autoattach.mutant.ts')
      writeFileSync(file, mutated)
      const mut = await import(file)
      const p = plan(`wrote the report to ${P('report.md')}`)
      // BEFORE — what main ships today, and what the human complained about.
      expect(mut.autoAttachFooter(p)).toBe('attached: report.md')
      // AFTER — the same call on the shipped function. The arm at the top of
      // this file asserts exactly this, so it IS red against the mutant.
      expect(autoAttachFooter(p)).toBe('')
      // and the mutant leaves the names in both places, which is the shape the
      // change exists to end.
      expect(mut.autoAttachFooter(p)).toContain('attached:')
      expect(attachedNames(p)).toBe('attached: report.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
