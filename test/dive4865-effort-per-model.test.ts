// DIVE-4865: /effort over Telegram must write the PER-MODEL effort key.
//
// THE DEFECT. applyEffort did `patchSettings({ effortLevel: level })` — the
// top-level key only. Claude Code >= 2.1.280 treats a user-settings top-level
// effortLevel as legacy, applied to older models only; claude-opus-5-5 reads
// `modelSettings.claude-opus-5-5.effortLevel` and otherwise runs its default,
// medium. After the 5dive CLI's upgrade heal (DIVE-4863, 5dive-ai/5dive#1104)
// fills the per-model keys from the top-level value, those keys SHADOW any later
// top-level-only write — so on a healed seat /effort changed nothing on disk
// that CC reads. The reader had the same blind spot: the picker ✓ followed the
// top-level key, not what the seat runs.
//
// WHAT IS GRADED. server.ts cannot be imported (it long-polls Telegram), so the
// write and the read are pure functions in settingsfile.ts, exercised here
// against real files; the wiring is graded as text, with mutants that put the
// legacy writer / reader back and require the arms to go red.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  patchEffortFile, patchSettingsFile, effectiveEffort, effortModelIds, canonicalModel,
  withEffort, perModelEffort,
} from '../plugins/telegram/settingsfile'
import { EFFORT_LEVELS } from '../plugins/telegram/commands'

const SERVER = join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts')
const src = () => readFileSync(SERVER, 'utf8')
function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

// What `5dive models --json` returns on a v0.49 host (applyModelAliases input).
const CATALOGUE = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5-1',
  haiku: 'claude-haiku-4-5-20251001',
}
const IDS = Object.values(CATALOGUE)
// The per-model schema read from the CC 2.1.280 binary (DIVE-4863).
const PER_MODEL_ENUM = ['low', 'medium', 'high', 'xhigh']

function withFile<T>(content: unknown, fn: (f: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'dive4865-'))
  try {
    const f = join(dir, 'settings.json')
    if (content !== undefined) writeFileSync(f, JSON.stringify(content))
    return fn(f)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

// A seat after the DIVE-4863 heal: both keys, same value.
const HEALED = {
  model: 'opus',
  effortLevel: 'high',
  modelSettings: Object.fromEntries(IDS.map(id => [id, { effortLevel: 'high' }])),
}

describe('the writer sets both keys', () => {
  test('every catalogue id gets the per-model key, and the top-level key is set too', () => {
    withFile({ model: 'opus', effortLevel: 'high' }, f => {
      patchEffortFile(f, 'low', CATALOGUE, true)
      const back = read(f)
      expect(back.effortLevel).toBe('low')
      for (const id of IDS) expect(back.modelSettings[id].effortLevel).toBe('low')
    })
  })
  test('a seat healed by DIVE-4863 actually changes effort after /effort', () => {
    withFile(HEALED, f => {
      expect(effectiveEffort(read(f), CATALOGUE)).toBe('high')
      patchEffortFile(f, 'medium', CATALOGUE, true)
      expect(effectiveEffort(read(f), CATALOGUE)).toBe('medium')
      expect(read(f).modelSettings['claude-opus-5-5'].effortLevel).toBe('medium')
    })
  })
  test('max is stored per model as xhigh (per-model max is dropped silently by CC)', () => {
    withFile({ model: 'opus' }, f => {
      patchEffortFile(f, 'max', CATALOGUE, true)
      const back = read(f)
      expect(back.effortLevel).toBe('max')
      for (const id of IDS) expect(back.modelSettings[id].effortLevel).toBe('xhigh')
    })
  })
  test('every level the picker offers lands per model as a value the CC schema keeps', () => {
    for (const level of EFFORT_LEVELS) expect(PER_MODEL_ENUM).toContain(perModelEffort(level))
  })
  test("the seat's own model is keyed when the catalogue does not list it", () => {
    withFile({ model: 'claude-opus-5[1m]' }, f => {
      patchEffortFile(f, 'high', CATALOGUE, true)
      expect(read(f).modelSettings['claude-opus-5'].effortLevel).toBe('high')
      expect(effectiveEffort(read(f), CATALOGUE)).toBe('high')
    })
  })
  test('other per-model fields and other top-level keys are kept', () => {
    withFile({ model: 'opus', theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', other: 1 } } }, f => {
      patchEffortFile(f, 'low', CATALOGUE, true)
      const back = read(f)
      expect(back.theme).toBe('dark')
      expect(back.modelSettings['claude-opus-5-5']).toEqual({ effortLevel: 'low', other: 1 })
    })
  })
  test('written 0600 via tmp + rename, no tmp left behind', () => {
    withFile({ model: 'opus' }, f => {
      patchEffortFile(f, 'low', CATALOGUE, true)
      expect(statSync(f).mode & 0o777).toBe(0o600)
      expect(existsSync(f + '.tmp')).toBe(false)
    })
  })
  test('user file missing or corrupt throws (the caller surfaces it)', () => {
    withFile(undefined, f => expect(() => patchEffortFile(f, 'low', CATALOGUE, true)).toThrow())
    withFile(undefined, f => {
      writeFileSync(f, '{not json')
      expect(() => patchEffortFile(f, 'low', CATALOGUE, true)).toThrow()
    })
  })
})

describe('project layers: refresh what is there, add nothing', () => {
  test('a missing project file is fine and stays missing', () => {
    withFile(undefined, f => {
      patchEffortFile(f, 'low', CATALOGUE, false)
      expect(existsSync(f)).toBe(false)
    })
  })
  test('a stale per-model key there is refreshed (it would shadow the user write)', () => {
    withFile({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } }, f => {
      patchEffortFile(f, 'low', CATALOGUE, false)
      const back = read(f)
      expect(back.modelSettings).toEqual({ 'claude-opus-5-5': { effortLevel: 'low' } })
      expect('effortLevel' in back).toBe(false)
    })
  })
  test('a stale top-level key there is refreshed, no modelSettings is added', () => {
    withFile({ effortLevel: 'high' }, f => {
      patchEffortFile(f, 'low', CATALOGUE, false)
      expect(read(f)).toEqual({ effortLevel: 'low' })
    })
  })
  test('a project file with neither key is not rewritten', () => {
    withFile({ permissions: {} }, f => {
      const before = readFileSync(f, 'utf8')
      patchEffortFile(f, 'low', CATALOGUE, false)
      expect(readFileSync(f, 'utf8')).toBe(before)
    })
  })
})

describe('the reader prefers the per-model key', () => {
  test('per-model wins over a disagreeing top-level key', () => {
    const s = { model: 'opus', effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } }
    expect(effectiveEffort(s, CATALOGUE)).toBe('low')
  })
  test('the model argument (the running --model) picks the key', () => {
    const s = { model: 'opus', effortLevel: 'high', modelSettings: { 'claude-sonnet-5': { effortLevel: 'low' } } }
    expect(effectiveEffort(s, CATALOGUE, 'claude-sonnet-5')).toBe('low')
    expect(effectiveEffort(s, CATALOGUE)).toBe('high')
  })
  test('falls back to the top-level key when there is no per-model one', () => {
    expect(effectiveEffort({ model: 'opus', effortLevel: 'xhigh' }, CATALOGUE)).toBe('xhigh')
    expect(effectiveEffort({ effortLevel: 'xhigh' }, CATALOGUE)).toBe('xhigh')
    expect(effectiveEffort({}, CATALOGUE)).toBeUndefined()
  })
  test('canonicalisation: [1m] dropped, alias resolved, full id passes through', () => {
    expect(canonicalModel('opus[1m]', CATALOGUE)).toBe('claude-opus-5-5')
    expect(canonicalModel('claude-sonnet-5', CATALOGUE)).toBe('claude-sonnet-5')
    expect(canonicalModel(undefined, CATALOGUE)).toBeUndefined()
    expect(effortModelIds(CATALOGUE, 'vendor/model')).toEqual([...IDS].sort())
  })
})

describe('server.ts wiring', () => {
  test('applyEffort writes through patchEffort, not a top-level-only patch', () => {
    const b = fnBody(src(), 'applyEffort')
    expect(b).toContain('patchEffort(level)')
    expect(b).not.toMatch(/patchSettings\(\{\s*effortLevel/)
  })
  test('patchEffort covers the user file (adding) and both project layers (refresh only)', () => {
    const b = fnBody(src(), 'patchEffort')
    expect(b).toContain("patchEffortFile(join(homedir(), '.claude', 'settings.json'), level, MODEL_ALIASES, /*addNewKeys*/ true)")
    expect(b).toContain("patchEffortFile(join(cwd, '.claude', 'settings.local.json'), level, MODEL_ALIASES, /*addNewKeys*/ false)")
    expect(b).toContain("patchEffortFile(join(cwd, '.claude', 'settings.json'), level, MODEL_ALIASES, /*addNewKeys*/ false)")
  })
  test('readClaudeModelAndEffort reads the effective (per-model first) level', () => {
    const b = fnBody(src(), 'readClaudeModelAndEffort')
    expect(b).toContain('effectiveEffort(settings, MODEL_ALIASES, model)')
    expect(b).not.toMatch(/effort = settings\.effortLevel/)
  })
})

// ------------------------------------------------ MUTANTS: the legacy shapes
describe('MUTANT: the legacy top-level-only writer', () => {
  const legacy = (f: string, level: string) => patchSettingsFile(f, { effortLevel: level }, true)
  test('on a healed seat it leaves the effective level unchanged — the defect', () => {
    withFile(HEALED, f => {
      legacy(f, 'medium')
      expect(effectiveEffort(read(f), CATALOGUE)).toBe('high')
    })
  })
  const mutated = () => src().replace('    patchEffort(level)\n', '    patchSettings({ effortLevel: level })\n')
  test('the source mutation changes the file', () => {
    expect(mutated()).not.toBe(src())
  })
  test('with it back, the wiring arm is RED', () => {
    const b = fnBody(mutated(), 'applyEffort')
    expect(b).not.toContain('patchEffort(level)')
    expect(b).toMatch(/patchSettings\(\{\s*effortLevel/)
  })
})

describe('MUTANT: per-model max written verbatim', () => {
  test('CC would drop it — the schema arm is RED against it', () => {
    const verbatim = withEffort({}, 'max', IDS)
    const bad = { ...verbatim, modelSettings: Object.fromEntries(IDS.map(id => [id, { effortLevel: 'max' }])) }
    for (const id of IDS) expect(PER_MODEL_ENUM).not.toContain((bad.modelSettings as any)[id].effortLevel)
    for (const id of IDS) expect(PER_MODEL_ENUM).toContain((verbatim.modelSettings as any)[id].effortLevel)
  })
})

describe('MUTANT: the legacy top-level reader', () => {
  const mutated = () => src().replace(
    'if (!effort) effort = effectiveEffort(settings, MODEL_ALIASES, model)',
    "if (!effort && typeof settings.effortLevel === 'string') effort = settings.effortLevel",
  )
  test('the source mutation changes the file', () => {
    expect(mutated()).not.toBe(src())
  })
  test('with it back, the reader arm is RED', () => {
    expect(fnBody(mutated(), 'readClaudeModelAndEffort')).not.toContain('effectiveEffort(settings, MODEL_ALIASES, model)')
  })
})
