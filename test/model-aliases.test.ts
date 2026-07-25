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
import { MODEL_ALIASES, applyModelAliases } from '../plugins/telegram/commands'

const BAKED = { ...MODEL_ALIASES }
const restore = () => {
  for (const k of Object.keys(MODEL_ALIASES)) delete MODEL_ALIASES[k]
  Object.assign(MODEL_ALIASES, BAKED)
}
afterEach(restore)

describe('baked fallback map', () => {
  test('every alias resolves to a full id, never a bare alias', () => {
    // A bare alias in settings.json is stripped by Claude Code's startup
    // migration on a fresh config dir (DIVE-506), so the map must never hold one.
    for (const [alias, id] of Object.entries(BAKED)) {
      expect(id).not.toBe(alias)
      expect(id.startsWith('claude-')).toBe(true)
    }
  })

  test('fable is selectable', () => {
    expect(BAKED.fable).toBe('claude-fable-5')
  })

  test('opus and sonnet are the current generation', () => {
    expect(BAKED.opus).toBe('claude-opus-5')
    expect(BAKED.sonnet).toBe('claude-sonnet-5')
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
