// DIVE-7559: where the dashboard adapter finds the control plane.
//
// /etc/5dive/api-base (root 0644, one URL) is the box-wide answer: a
// local-only box (DIVE-7556) points it at its own office chat server, and every
// 5dive component that talks to the control plane reads the same file. It is a
// FILE and not an env var because sudo resets the environment, so the root rail
// could never see FIVE_API_BASE, and root owning the file is what a standard
// seat cannot forge.
//
// Order: DASHBOARD_API_BASE (an explicit override, previews and tests, as
// before) > /etc/5dive/api-base > https://api.5dive.com. A missing, empty or
// unreadable file, or one that does not hold an http(s) URL, is ignored, so a
// box without the file behaves exactly as it did before this row.

import { readFileSync } from 'fs'

export const API_BASE_FILE_DEFAULT = '/etc/5dive/api-base'
export const API_BASE_DEFAULT = 'https://api.5dive.com'

export function readApiBaseFile(path: string): string | null {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return null }
  const line = raw.split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('#'))
  if (!line || !/^https?:\/\/[^\s/?#]+(\/[^\s]*)?$/i.test(line)) return null
  return line
}

export function resolveApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.DASHBOARD_API_BASE_FILE || API_BASE_FILE_DEFAULT
  const base = env.DASHBOARD_API_BASE ?? readApiBaseFile(file) ?? API_BASE_DEFAULT
  return base.replace(/\/+$/, '')
}
