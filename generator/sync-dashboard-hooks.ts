#!/usr/bin/env bun
// DIVE-6714: copy the Telegram hook files listed in
// plugins/dashboard/hooks/SHARED.txt into the dashboard plugin, byte for byte.
//   bun generator/sync-dashboard-hooks.ts          write the copies
//   bun generator/sync-dashboard-hooks.ts --check  exit 1 naming any drift
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', 'plugins')
const FROM = join(ROOT, 'telegram', 'hooks')
const TO = join(ROOT, 'dashboard', 'hooks')

export function sharedFiles(): string[] {
  return readFileSync(join(TO, 'SHARED.txt'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

export function drift(): string[] {
  return sharedFiles().filter(f => {
    const dst = join(TO, f)
    return !existsSync(dst) || !readFileSync(join(FROM, f)).equals(readFileSync(dst))
  })
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const d = drift()
    if (d.length) {
      console.error(`dashboard hooks drifted from telegram: ${d.join(', ')}\nrun: bun generator/sync-dashboard-hooks.ts`)
      process.exit(1)
    }
    console.log(`dashboard hooks: ${sharedFiles().length} shared files identical`)
  } else {
    for (const f of sharedFiles()) {
      mkdirSync(dirname(join(TO, f)), { recursive: true })
      copyFileSync(join(FROM, f), join(TO, f))
    }
    console.log(`dashboard hooks: copied ${sharedFiles().length} files`)
  }
}
