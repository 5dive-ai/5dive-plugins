import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A thread's rollout is <sessions>/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
 * (codex 0.153.3). Found once per thread, newest day first, then only stat'ed:
 * the dispatcher asks at boot and at every turn boundary (DIVE-5918). Not
 * found → null, and the caller resumes as before rather than guess.
 */
export function rolloutSizer(sessionsDir: string): (threadId: string) => number | null {
  const paths = new Map<string, string>()
  const find = (threadId: string): string | null => {
    const suffix = `-${threadId}.jsonl`
    const walk = (dir: string, depth: number): string | null => {
      let names: string[]
      try { names = readdirSync(dir).sort().reverse() } catch { return null }
      for (const name of names) {
        if (depth === 3) {
          if (name.startsWith('rollout-') && name.endsWith(suffix)) return join(dir, name)
          continue
        }
        const hit = walk(join(dir, name), depth + 1)
        if (hit) return hit
      }
      return null
    }
    return walk(sessionsDir, 0)
  }
  return threadId => {
    const path = paths.get(threadId) ?? find(threadId)
    if (!path) return null
    try {
      const size = statSync(path).size
      paths.set(threadId, path)
      return size
    } catch {
      paths.delete(threadId)
      return null
    }
  }
}
