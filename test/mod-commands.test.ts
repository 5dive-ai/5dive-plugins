// The `/task` and `/gate` command surface in the `mod` plugin (DIVE-4693).
//
// What this grades, and why it is the argument-shaping and not the dispatch: the
// commands are a THIN surface over `5dive task …`. There is deliberately no flag
// parsing, no defaulting and no re-implemented guard in the plugin, so the only logic
// that can be wrong here is (a) how a typed argument string becomes an argv, and (b)
// which verbs the surface agrees to dispatch at all. Both are pure and both are below.
//
// The verb allowlist is a RAIL, not a scope note. On this fleet the filing cap is a
// PreToolUse hook on the Bash tool; a verb dispatched through `$.process.run` never
// crosses it. `/task add` would therefore be a way around a guard rather than a
// shortcut to it, so `add` is refused by name and anything unrecognised is refused
// rather than passed through. The arms that pin that are the ones worth reading.
//
// The live end (a session registering the commands, `/task show` returning the row)
// is on DIVE-4693 and cannot run in `bun test`: CI has no Claude Code.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins', 'mod')
const SRC = readFileSync(join(ROOT, 'hooks', 'register.ts'), 'utf8')

const { splitArgs, taskDispatch, gateDispatch, dispatchResult, TASK_VERBS, TASK_VERBS_REFUSED } =
  await import(join(ROOT, 'hooks', 'register.ts'))

describe('mod commands: a typed argument string becomes an argv', () => {
  test('plain words split on whitespace', () => {
    expect(splitArgs('show DIVE-4693')).toEqual(['show', 'DIVE-4693'])
    expect(splitArgs('   ls   --mine  ')).toEqual(['ls', '--mine'])
    expect(splitArgs('')).toEqual([])
  })

  test('a quoted value stays ONE argument, spaces and all', () => {
    // The whole reason this function exists: `$.process.run` takes an argv and runs no
    // shell, so an ask, a result or a body typed with spaces has to survive the split
    // as a single element or the CLI receives a dozen stray arguments.
    expect(splitArgs('done DIVE-1 --result="two sentences here"')).toEqual([
      'done',
      'DIVE-1',
      '--result=two sentences here',
    ])
    expect(splitArgs("ls --q='a b'")).toEqual(['ls', '--q=a b'])
  })

  test('an empty quoted argument is an argument, not nothing', () => {
    // `--result=""` must reach the CLI so the CLI's own done-refuses-blank check is
    // what refuses it. Dropping it here would turn a refusal into a different error.
    expect(splitArgs('done DIVE-1 --result=""')).toEqual(['done', 'DIVE-1', '--result='])
    expect(splitArgs('""')).toEqual([''])
  })

  test('single quotes are literal; double quotes take a backslash escape', () => {
    expect(splitArgs('--ask=\'don\'')).toEqual(['--ask=don'])
    expect(splitArgs('--ask="a \\"quoted\\" word"')).toEqual(['--ask=a "quoted" word'])
    expect(splitArgs("--ask='a \\\" b'")).toEqual(['--ask=a \\" b'])
  })

  test('an unterminated quote answers null rather than guessing', () => {
    expect(splitArgs('done DIVE-1 --result="unfinished')).toBeNull()
    expect(splitArgs("ls --q='x")).toBeNull()
  })
})

describe('mod commands: the /task verb allowlist is a rail', () => {
  test('a scoped verb dispatches to the CLI, arguments untouched', () => {
    expect(taskDispatch('5dive', 'show DIVE-4693')).toEqual({
      argv: ['5dive', 'task', 'show', 'DIVE-4693'],
    })
    expect(taskDispatch('/usr/local/bin/5dive', 'done DIVE-1 --result="it shipped"')).toEqual({
      argv: ['/usr/local/bin/5dive', 'task', 'done', 'DIVE-1', '--result=it shipped'],
    })
  })

  test('every verb the row scoped is served, and nothing else is', () => {
    expect([...TASK_VERBS].sort()).toEqual(
      ['assign', 'deliver', 'done', 'ls', 'reject', 'set-body', 'show'].sort(),
    )
    for (const verb of TASK_VERBS) {
      expect(taskDispatch('5dive', `${verb} DIVE-1`)).toHaveProperty('argv')
    }
  })

  test('`add` is refused BY NAME, with the reason, because a rail is behind it', () => {
    // If this ever starts dispatching, the filing cap stops applying to filing done
    // through the command surface, and nothing else in the system would notice.
    const r = taskDispatch('5dive', 'add "a new row"') as { refuse: string }
    expect(r.argv).toBeUndefined()
    expect(r.refuse).toContain('filing cap')
    expect(r.refuse).toContain('Bash')
    expect(TASK_VERBS_REFUSED.add).toBeDefined()
  })

  test('`need` is pointed at /gate rather than silently dispatched', () => {
    const r = taskDispatch('5dive', 'need DIVE-1 --type=decision') as { refuse: string }
    expect(r.argv).toBeUndefined()
    expect(r.refuse).toContain('/gate')
  })

  test('an unknown verb is refused, never passed through', () => {
    // Fall-through is the failure mode this arm exists for: a surface that forwards
    // whatever it is given is a second CLI with none of the first one's guards.
    for (const verb of ['cancel', 'merge-landed', 'escalate', 'rm', '--help', '-f']) {
      const r = taskDispatch('5dive', `${verb} DIVE-1`) as { refuse: string }
      expect(r.argv).toBeUndefined()
      expect(r.refuse).toContain('Bash')
    }
  })

  test('a bare /task says what it serves instead of running something', () => {
    const r = taskDispatch('5dive', '') as { refuse: string }
    expect(r.argv).toBeUndefined()
    expect(r.refuse).toContain('show')
  })

  test('an unterminated quote runs nothing', () => {
    const r = taskDispatch('5dive', 'done DIVE-1 --result="oops') as { refuse: string }
    expect(r.argv).toBeUndefined()
    expect(r.refuse).toContain('nothing was run')
  })
})

describe('mod commands: /gate is `task need`, and pre-checks nothing', () => {
  test('it dispatches to the CLI verb that owns the gate rules', () => {
    expect(
      gateDispatch('5dive', 'DIVE-1 --type=decision --ask="Ship it or hold it?" --recommend="Ship it"'),
    ).toEqual({
      argv: [
        '5dive',
        'task',
        'need',
        'DIVE-1',
        '--type=decision',
        '--ask=Ship it or hold it?',
        '--recommend=Ship it',
      ],
    })
  })

  test('a gate missing its type or ask is still handed to the CLI', () => {
    // Deliberate: the ask-readability rule and the type/tier defaults are `need.sh`'s.
    // A copy of them here would drift, and a drifted copy refuses gates the CLI would
    // have taken — worse than no check, because the CLI never sees it to say so.
    expect(gateDispatch('5dive', 'DIVE-1')).toEqual({ argv: ['5dive', 'task', 'need', 'DIVE-1'] })
    expect(SRC).not.toMatch(/tier\s*[=:]/)
  })

  test('a bare /gate says what it needs', () => {
    const r = gateDispatch('5dive', '') as { refuse: string }
    expect(r.argv).toBeUndefined()
    expect(r.refuse).toContain('--type=')
  })
})

describe('mod commands: what the person and the model each get back', () => {
  test('the output rides the transcript row and the exit code is stated', () => {
    const out = dispatchResult(['5dive', 'task', 'show', 'DIVE-1'], 0, 'ident = DIVE-1\n', '')
    expect(out.text).toContain('$ 5dive task show DIVE-1')
    expect(out.text).toContain('ident = DIVE-1')
    expect(out.context.join('\n')).toContain('exited 0')
  })

  test('a non-zero exit is legible as a refusal, not as output', () => {
    // A 5dive verb that refuses prints its reason and exits non-zero. "It printed
    // something" and "it worked" are different facts and the model reads both.
    const out = dispatchResult(['5dive', 'task', 'done', 'DIVE-1'], 2, '', 'result is required\n')
    expect(out.text).toContain('(exit 2)')
    expect(out.text).toContain('result is required')
    expect(out.context.join('\n')).toContain('exited 2')
  })

  test('a silent success still says so', () => {
    const out = dispatchResult(['5dive', 'task', 'assign', 'DIVE-1', 'dev'], 0, '', '')
    expect(out.text).toContain('(no output)')
  })
})

describe('mod commands: the surface stays a dispatch', () => {
  test('the CLI is invoked as an argv, never through a shell', () => {
    // No shell means nothing in an ask, a result or a row body can be interpreted as
    // one. The whole module must hold this, not just the happy path.
    expect(SRC).not.toMatch(/\b(sh|bash|zsh)\b\s*,\s*'-c'/)
    expect(SRC).not.toMatch(/'-c'/)
    expect(SRC).toContain('$.process.run(d.argv')
  })

  test('the commands are off unless the seat opts in', () => {
    expect(SRC).toContain("const COMMANDS_FLAG = 'FIVEDIVE_MOD_COMMANDS'")
    expect(SRC).toMatch(/vars\[COMMANDS_FLAG\] \?\? ''\) !== '1'\) return \{ on: false \}/)
  })

  test('the context-cost audit is off by default and is not per turn', () => {
    // It counts with the token-count API. Left on, the instrument would cost the thing
    // DIVE-4693 exists to measure.
    expect(SRC).toContain("const AUDIT_FLAG = 'FIVEDIVE_MOD_CONTEXT_AUDIT'")
    const breakdownCalls = [...SRC.matchAll(/breakdown: 'full'/g)]
    expect(breakdownCalls.length).toBe(1)
    // and the one call site is reached from session.start only
    const turnHooks = SRC.slice(SRC.indexOf("on('turn.start'"))
    expect(turnHooks).not.toContain('contextCost(')
  })
})
