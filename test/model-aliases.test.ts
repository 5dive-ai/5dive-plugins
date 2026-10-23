// DIVE-1883 — the /model picker must not drift from the CLI's model catalogue.
//
// History this guards: MODEL_ALIASES was a hand-maintained copy of the same
// map the CLI keeps for agent-create. Both drifted, and they drifted apart —
// the plugin pinned opus to claude-opus-4-7 while the CLI pinned 4.8, so
// `/model opus` over Telegram and `5dive compose` handed you different models.
// `fable` existed in neither create path at all.
//
// server.ts is NOT imported here (it long-polls Telegram on import), which is
// why the merge lives in commands.ts as a pure function.
import { expect, test, describe, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_ALIASES, applyModelAliases } from '../plugins/telegram/commands'

const BAKED = { ...MODEL_ALIASES }
const restore = () => {
  for (const k of Object.keys(MODEL_ALIASES)) delete MODEL_ALIASES[k]
  Object.assign(MODEL_ALIASES, BAKED)
}
afterEach(restore)

describe('baked fallback map', () => {
  // DIVE-6788: the fallback carries no model ids. A baked id rots — this map
  // sat on claude-sonnet-5 / claude-haiku-4-5 after the 5.5 releases. Each
  // family maps to its own bare alias, which Claude Code resolves itself.
  // (DIVE-506's worry, a bare alias stripped from settings.json, no longer
  // applies to these values: /model writes the bare alias whatever the map
  // holds (DIVE-4860), and the values only key per-model effort, which CC
  // canonicalises through its own alias table.)
  test('every alias maps to itself — no model id is baked in', () => {
    for (const [alias, id] of Object.entries(BAKED)) {
      expect(id).toBe(alias)
      expect(id).not.toMatch(/^claude-/)
    }
  })

  test('the four families are selectable, in picker order', () => {
    expect(Object.keys(BAKED)).toEqual(['opus', 'sonnet', 'fable', 'haiku'])
  })

  test('commands.ts names no claude-* id outside comments', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'commands.ts'), 'utf8')
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(code).not.toMatch(/claude-(opus|sonnet|haiku|fable)-[0-9]/)
  })
})

describe('applyModelAliases', () => {
  test('replaces the map from a CLI payload', () => {
    expect(applyModelAliases({ opus: 'claude-opus-9', sonnet: 'claude-sonnet-9' })).toBe(true)
    expect(MODEL_ALIASES.opus).toBe('claude-opus-9')
    // Replaced, not merged on top: an alias the CLI dropped must not linger.
    expect(MODEL_ALIASES.fable).toBeUndefined()
  })

  test('adds a family the plugin does not know about', () => {
    applyModelAliases({ opus: 'claude-opus-5', quartz: 'claude-quartz-1' })
    expect(MODEL_ALIASES.quartz).toBe('claude-quartz-1')
  })

  test('fails closed — defaults survive a bad or missing payload', () => {
    for (const bad of [null, undefined, {}, [], 'nope', 42]) {
      expect(applyModelAliases(bad)).toBe(false)
      expect(MODEL_ALIASES).toEqual(BAKED)
    }
  })

  test('drops non-string rows instead of poisoning the picker', () => {
    expect(applyModelAliases({ opus: 'claude-opus-5', sonnet: null, fable: 7 })).toBe(true)
    expect(MODEL_ALIASES).toEqual({ opus: 'claude-opus-5' })
  })
})
