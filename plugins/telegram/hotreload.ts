// DIVE-7085: a telegram fix installed on a box goes live on a BUSY seat within a
// minute, without restarting its session. Claude Code starts this bridge once, so
// a refresh that installs telegram/<new>/ under a live seat leaves the bridge on
// the old code until its next restart — which DIVE-3172/DIVE-5547 deliberately
// defer while the seat is busy, and the seat the owner talks to is nearly always
// busy. lodar 2026-10-27: DIVE-7061's button fix sat installed for hours while
// main kept sending choices without buttons.
//
// What reloads: pure, import-free modules only (tna.ts: the choice/Yes-No button
// detection and the tap resolution). The bridge polls the seat's own
// installed_plugins.json; when it names a sibling version dir, the module is
// imported from there, checked against the running one's export shape and a
// probe, and swapped in. Anything that fails keeps the old copy live and says so
// on stderr — the bridge never goes deaf. MCP instructions, tools and handlers
// still take a restart. Import-safe (no I/O at load), like tna.ts.
import { readFileSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'

export const HOT_RELOAD_POLL_MS = 60_000

export interface HotModuleOpts<M extends object> {
  file: string                 // module file name inside a version dir, e.g. 'tna.ts'
  boot: M                      // the copy this process started with
  runningDir: string           // this bridge's version dir (import.meta.dir)
  probe?: (m: M) => void       // throws if the candidate is unusable
  log?: (line: string) => void
  disabled?: boolean           // TELEGRAM_HOT_RELOAD=0: ops escape hatch / negative control
  importer?: (path: string) => Promise<unknown>
}

export interface HotModule<M extends object> {
  readonly live: M
  readonly liveDir: string
  check(): Promise<boolean>    // true when it swapped
  start(intervalMs?: number): void
}

// <cfg>/plugins/cache/<marketplace>/<plugin>/<version> → <cfg>/plugins/installed_plugins.json.
// null when the bridge does not run from a plugin cache (fork seeds, dev runs).
export function installedFileFor(runningDir: string): string | null {
  const cache = dirname(dirname(dirname(runningDir)))
  if (basename(cache) !== 'cache') return null
  return join(dirname(cache), 'installed_plugins.json')
}

// The installPath the record names for THIS plugin: the entry whose install dir
// is a sibling of the running one. Never a path outside the plugin's own cache dir.
export function installedPathFor(record: unknown, runningDir: string): string | null {
  const plugins = (record as { plugins?: Record<string, unknown> } | null)?.plugins
  if (!plugins || typeof plugins !== 'object') return null
  const parent = dirname(runningDir)
  for (const entries of Object.values(plugins)) {
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      const p = (e as { installPath?: unknown })?.installPath
      if (typeof p === 'string' && dirname(p) === parent && basename(p) !== '') return p
    }
  }
  return null
}

// Every export the running copy has must exist in the candidate with the same type.
export function shapeMismatch(boot: object, cand: object): string | null {
  for (const [k, v] of Object.entries(boot)) {
    if (!(k in cand)) return `missing export ${k}`
    const c = (cand as Record<string, unknown>)[k]
    if (typeof c !== typeof v) return `export ${k} is ${typeof c}, running copy has ${typeof v}`
  }
  return null
}

export function createHotModule<M extends object>(o: HotModuleOpts<M>): HotModule<M> {
  const log = o.log ?? (line => process.stderr.write(`telegram channel: ${line}\n`))
  const importer = o.importer ?? (p => import(p))
  const installedFile = installedFileFor(o.runningDir)
  let live = o.boot
  let liveDir = o.runningDir
  let seenMtime = -1
  let failedDir = ''
  let busy = false

  async function check(): Promise<boolean> {
    if (o.disabled || !installedFile || busy) return false
    let mtime: number
    try { mtime = statSync(installedFile).mtimeMs } catch { return false }
    if (mtime === seenMtime) return false
    busy = true
    try {
      let target: string | null = null
      try { target = installedPathFor(JSON.parse(readFileSync(installedFile, 'utf8')), o.runningDir) } catch {
        return false // mid-write: retry on the next tick, mtime unrecorded
      }
      seenMtime = mtime
      if (!target || target === liveDir || target === failedDir) return false
      const from = basename(target)
      try {
        const cand = await importer(join(target, o.file)) as M
        const bad = shapeMismatch(o.boot, cand)
        if (bad) throw new Error(bad)
        o.probe?.(cand)
        live = cand
        liveDir = target
        failedDir = ''
        log(`hot reload: ${o.file} now from ${from} (process started on ${basename(o.runningDir)})`)
        return true
      } catch (err) {
        failedDir = target
        log(`hot reload: ${o.file} from ${from} FAILED, still serving ${basename(liveDir)}: ${err instanceof Error ? err.message : err}`)
        return false
      }
    } finally {
      busy = false
    }
  }

  return {
    get live() { return live },
    get liveDir() { return liveDir },
    check,
    start(intervalMs = HOT_RELOAD_POLL_MS) {
      if (o.disabled || !installedFile) return
      const t = setInterval(() => { void check() }, intervalMs)
      t.unref?.()
    },
  }
}
