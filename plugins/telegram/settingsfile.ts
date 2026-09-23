// In-place merge of keys into one Claude Code settings file. Split out of
// server.ts (which long-polls Telegram on import, so no test can import it) so
// the value /model writes can be read back from a real file (DIVE-4860).
//
// addNewKeys=false only refreshes keys already present and tolerates a missing
// file; addNewKeys=true creates the key and throws on a missing/corrupt file so
// the caller can surface the error. Written via tmp + rename, mode 0600.
import { readFileSync, writeFileSync, renameSync } from 'fs'

export function patchSettingsFile(path: string, patch: Record<string, unknown>, addNewKeys: boolean): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err: any) {
    if (!addNewKeys && err?.code === 'ENOENT') return
    throw err
  }
  const obj = JSON.parse(raw) as Record<string, unknown>
  let dirty = false
  for (const [k, v] of Object.entries(patch)) {
    if (addNewKeys || k in obj) {
      obj[k] = v
      dirty = true
    }
  }
  if (!dirty) return
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

// ---------------------------------------------------------------- effort (DIVE-4865)
// From Claude Code 2.1.280 a USER-settings top-level `effortLevel` is legacy: it
// applies only to a fixed list of older models, and claude-opus-5-5 is not on it.
// What CC reads is `modelSettings.<canonical model id>.effortLevel`, the key its
// own `/effort` writes. So /effort writes BOTH — the top-level key for the models
// that still read it, and the per-model key of every catalogue id plus the seat's
// own model — and the reader prefers the per-model key. The 5dive CLI does the
// same since v0.49.1 (5dive-ai/5dive#1104, src/lib/models.sh MODEL_EFFORT_JQ);
// keep the two in step. Once the CLI's upgrade heal has filled the per-model
// keys, a top-level-only write is shadowed by them and changes nothing.
//
// The per-model schema is enum low|medium|high|xhigh with .catch(undefined):
// `max` is session-only and an unknown value is DROPPED SILENTLY (the model then
// runs its default). So `max` is stored per model as `xhigh`.

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

export function perModelEffort(level: string): string {
  return level === 'max' ? 'xhigh' : level
}

/** The id CC keys modelSettings by: a trailing `[1m]`-style suffix dropped and a
 *  family alias resolved through `aliases`. Anything else passes through. */
export function canonicalModel(model: unknown, aliases: Record<string, string>): string | undefined {
  if (typeof model !== 'string' || !model) return undefined
  const bare = model.replace(/\[[^\]]*\]$/, '')
  return aliases[bare] ?? bare
}

/** Ids that get a per-model effortLevel: every catalogue id — so a later /model
 *  switch keeps the level — plus the seat's own canonical model when it is a
 *  claude-* id the catalogue does not list (a seat pinned to an older model). */
export function effortModelIds(aliases: Record<string, string>, model?: unknown): string[] {
  const ids = new Set(Object.values(aliases).filter(v => typeof v === 'string' && v))
  const own = canonicalModel(model, aliases)
  if (own?.startsWith('claude-')) ids.add(own)
  return [...ids].sort()
}

/** Pure: `obj` with the top-level key and every id's per-model key set to
 *  `level` (overwrites — an explicit /effort is the truth). Other per-model
 *  fields are kept. */
export function withEffort(obj: Json, level: string, ids: string[]): Json {
  const ms: Json = isObj(obj.modelSettings) ? { ...obj.modelSettings } : {}
  for (const id of ids) {
    ms[id] = { ...(isObj(ms[id]) ? ms[id] : {}), effortLevel: perModelEffort(level) }
  }
  return { ...obj, effortLevel: level, modelSettings: ms }
}

/** What CC runs: the per-model key for `model` (default: the file's own
 *  `model`), else the legacy top-level key. */
export function effectiveEffort(obj: Json, aliases: Record<string, string>, model?: string): string | undefined {
  const k = canonicalModel(model ?? obj.model, aliases)
  const pm = k && isObj(obj.modelSettings) && isObj(obj.modelSettings[k]) ? obj.modelSettings[k].effortLevel : undefined
  if (typeof pm === 'string') return pm
  return typeof obj.effortLevel === 'string' ? obj.effortLevel : undefined
}

/** Write `level` into one settings file. addNewKeys=true (the user file) sets
 *  both keys for every id in effortModelIds(aliases, <file's model>).
 *  addNewKeys=false (the project layers) refreshes only what is already there —
 *  the top-level key if present, and each per-model effortLevel already set —
 *  because a stale value there shadows the user write, but we never add project
 *  state. Same missing-file / tmp+rename / 0600 contract as patchSettingsFile. */
export function patchEffortFile(path: string, level: string, aliases: Record<string, string>, addNewKeys: boolean): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err: any) {
    if (!addNewKeys && err?.code === 'ENOENT') return
    throw err
  }
  const obj = JSON.parse(raw) as Json
  let next: Json
  if (addNewKeys) {
    next = withEffort(obj, level, effortModelIds(aliases, obj.model))
  } else {
    const present = isObj(obj.modelSettings)
      ? Object.keys(obj.modelSettings).filter(id => isObj((obj.modelSettings as Json)[id]) && ((obj.modelSettings as Json)[id] as Json).effortLevel !== undefined)
      : []
    if (!('effortLevel' in obj) && present.length === 0) return
    next = withEffort(obj, level, present)
    if (!('effortLevel' in obj)) delete next.effortLevel
    if (!isObj(obj.modelSettings)) delete next.modelSettings
  }
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}
