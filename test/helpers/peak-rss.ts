// DIVE-7434: preloaded into a hook under test (`bun --preload`). On exit it
// writes the process's own peak RSS (VmHWM, KB) to $PEAK_RSS_FILE — measured
// in the hook itself, because the rusage a spawner gets back is not per child.
import { readFileSync, writeFileSync } from 'node:fs'

process.on('exit', () => {
  const out = process.env.PEAK_RSS_FILE
  if (!out) return
  const kb = /VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? ''
  writeFileSync(out, kb)
})
