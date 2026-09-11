// DIVE-4280: auto-attach a file the agent NAMES in its reply.
//
// The paired human reads Telegram on a phone and has no terminal, so a bare
// path in a reply is a dead link. CLAUDE.md has said "attach every file you
// name" for months and it does not transfer — agents forget `files=` on most
// replies. So the server does it: when reply/edit text names a real, readable,
// document-or-media file, it ships as an attachment even though `files=` was
// never passed. Pure logic lives here so it can be unit-tested without booting
// the server (server.ts long-polls Telegram on import).
//
// Two hard constraints shape it:
//   - lodar, 2026-09-11: "maybe 5 files tops autosend?" — at most FIVE per
//     message, in the order named; beyond that, attach none of the rest and
//     say how many were skipped. A reply naming 100 paths must not dump 100
//     documents on his phone.
//   - the DENYLIST is not optional. This runs on text the agent wrote without
//     knowing it would be sent, so anything credential-shaped must never be
//     eligible: the whole ~/.claude tree (settings, channel access.json with
//     the bot token), .env, *secret*/*token* names, ssh keys, /etc/5dive,
//     /var/lib/5dive. server.ts's assertSendable() is a second, narrower net
//     over the channel state dir; this one is the wide one.

import { statSync, realpathSync } from 'node:fs'
import { basename, extname, isAbsolute, join, sep } from 'node:path'
import { homedir } from 'node:os'

/** Images send as photos (inline preview); everything else as a document. */
export const AUTO_PHOTO_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/**
 * Eligible extensions (lodar, 2026-09-11: "can apply to .jpg .pdf and other
 * files too?" — yes, documents AND media). Deliberately EXCLUDES code and
 * scripts (.sh .py .ts), archives, and extensionless binaries: those are
 * repo contents an agent names while working, not artefacts written for the
 * human to read.
 */
export const AUTO_ATTACH_EXTS = new Set([
  '.md', '.txt', '.log', '.json', '.csv', '.yaml', '.html',
  '.pdf',
  ...AUTO_PHOTO_EXTS,
  '.mp4', '.mov', '.mp3', '.m4a', '.ogg',
])

/** lodar's cap. Beyond this the footer names the count instead of attaching. */
export const AUTO_ATTACH_MAX = 5

/** Telegram's per-file bot cap. */
export const AUTO_ATTACH_MAX_BYTES = 50 * 1024 * 1024

// Fenced code blocks are stripped before scanning: a path inside ``` is
// documentation of a command ("write it to /path/x.md"), not a file this reply
// produced. A path in single backticks in PROSE still counts — that is how
// agents normally cite a file they just wrote.
const FENCE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g

// Absolute (/…) or home-relative (~/…) paths. Stops at whitespace and at the
// quote/bracket/backtick characters that wrap a path in prose.
const PATH_RE = /(?:~|\/)[^\s`'"<>()\[\]{},;]*/g

// Trailing sentence punctuation is not part of the path ("see /tmp/a.md." ).
const TRAILING_JUNK_RE = /[.,;:!?]+$/

const DENY_BASENAME_RE = /(^\.env($|\.)|secret|token|credential|password|^id_(ed25519|rsa|ecdsa)|\.pem$|\.key$|\.p12$|\.pfx$|^\.netrc$|^\.pgpass$|^authorized_keys$|^known_hosts$)/i

/** Directory prefixes that are never auto-attachable. */
export function deniedDirs(home = homedir()): string[] {
  return [
    join(home, '.claude'),
    join(home, '.ssh'),
    join(home, '.config'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    '/etc/5dive',
    '/var/lib/5dive',
    '/etc/ssh',
    '/root',
  ]
}

/**
 * True when a path must never be auto-attached. Checked on the RESOLVED path,
 * so a symlink into ~/.claude cannot launder a token out.
 */
export function isDenied(resolved: string, home = homedir()): boolean {
  for (const d of deniedDirs(home)) {
    if (resolved === d || resolved.startsWith(d + sep)) return true
  }
  return DENY_BASENAME_RE.test(basename(resolved))
}

/** Paths named in prose, in order, with fenced blocks removed and dupes kept. */
export function candidatePaths(text: string, home = homedir()): string[] {
  const prose = text.replace(FENCE_RE, '\n')
  const out: string[] = []
  for (const m of prose.matchAll(PATH_RE)) {
    let p = m[0].replace(TRAILING_JUNK_RE, '')
    if (p === '~' || p === '/') continue
    if (p === '~/' ) continue
    if (p.startsWith('~/')) p = join(home, p.slice(2))
    else if (p === '~') continue
    if (!isAbsolute(p)) continue
    out.push(p)
  }
  return out
}

export type AutoAttachPlan = {
  /** Paths to send, in the order named, at most AUTO_ATTACH_MAX. */
  attach: string[]
  /** Eligible paths dropped by the cap (lodar's "+N more"). */
  overflow: number
  /** Eligible but over Telegram's per-file cap — named in the footer. */
  tooLarge: string[]
}

export type PlanOpts = {
  /** Paths the caller passed explicitly in files= — those win, never doubled. */
  already?: string[]
  home?: string
  /** Injected in tests. Returns resolved path + size, or null if unusable. */
  probe?: (p: string) => { real: string; size: number } | null
}

function defaultProbe(p: string): { real: string; size: number } | null {
  try {
    const real = realpathSync(p)
    const st = statSync(real)
    if (!st.isFile()) return null
    return { real, size: st.size }
  } catch {
    return null
  }
}

/**
 * Decide what an auto-attach should send for one outgoing message.
 *
 * Order of elimination, and each step matters:
 *   extension eligible → exists as a regular readable file → not on the
 *   denylist → not already in files= → not seen earlier in this same text →
 *   under the size cap → within the 5-file cap.
 */
export function planAutoAttach(text: string, opts: PlanOpts = {}): AutoAttachPlan {
  const home = opts.home ?? homedir()
  const probe = opts.probe ?? defaultProbe
  const seen = new Set<string>()
  for (const a of opts.already ?? []) {
    const r = probe(a)
    seen.add(r ? r.real : a)
  }
  const attach: string[] = []
  const tooLarge: string[] = []
  let overflow = 0

  for (const p of candidatePaths(text, home)) {
    if (!AUTO_ATTACH_EXTS.has(extname(p).toLowerCase())) continue
    const r = probe(p)
    if (!r) continue
    if (isDenied(r.real, home)) continue
    if (seen.has(r.real)) continue
    seen.add(r.real)
    if (r.size > AUTO_ATTACH_MAX_BYTES) {
      tooLarge.push(p)
      continue
    }
    if (attach.length >= AUTO_ATTACH_MAX) {
      overflow++
      continue
    }
    attach.push(p)
  }
  return { attach, overflow, tooLarge }
}

/**
 * The footer line(s) appended to the outgoing text, so the human and the
 * transcript agree on what was sent. Empty string when nothing was decided.
 */
export function autoAttachFooter(plan: AutoAttachPlan): string {
  const lines: string[] = []
  if (plan.attach.length) {
    lines.push(`attached: ${plan.attach.map(p => basename(p)).join(', ')}`)
  }
  if (plan.overflow) {
    lines.push(`+${plan.overflow} more files named; ask for one by name`)
  }
  if (plan.tooLarge.length) {
    lines.push(`too large to send: ${plan.tooLarge.map(p => basename(p)).join(', ')}`)
  }
  return lines.join('\n')
}
