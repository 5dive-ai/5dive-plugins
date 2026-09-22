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
