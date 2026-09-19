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
//     eligible: any .claude/.ssh/.config/.aws/.gnupg tree on the box (not just
//     the running seat's — seat homes here are mutually readable), the
//     `.claude.json` sibling file, .env, *secret*/*token* names, ssh keys,
//     /etc/5dive, /var/lib/5dive, /var/log. In front of all of it sits an
//     ALLOWLIST of roots a file may live under at all (homes, /tmp, /var/tmp,
//     the cwd), so a sensitive directory nobody listed is ineligible by
//     default. server.ts's assertSendable() is a second, narrower net
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

// `.claude.json` is a sibling FILE of the `.claude` directory, so no directory
// rule reaches it — and it is the worst single file on the box to leak: on a
// paired seat it carries the userID, the machineID, the project list and the
// typed prompt history. Named explicitly. (quinn, DIVE-4280 verify pass.)
const DENY_BASENAME_RE = /(^\.env($|\.)|^\.claude\.json$|secret|token|credential|password|^id_(ed25519|rsa|ecdsa)|\.pem$|\.key$|\.p12$|\.pfx$|^\.netrc$|^\.pgpass$|^authorized_keys$|^known_hosts$)/i

/**
 * Sensitive directory NAMES, denied wherever they appear as a path segment —
 * NOT as a prefix rooted at the running seat's homedir().
 *
 * This host puts every agent seat under /home/agent-<name>/, and those trees
 * are mutually readable: `/home/agent-olivia/.claude/channels/telegram/access.json`
 * is mode 0644 and holds the paired human's chat ids. A homedir()-rooted prefix
 * protected only the seat the plugin happens to run as, so the exact file the
 * row names as must-never-attach sailed through when named by another seat's
 * absolute path. A segment rule denies every seat's tree, and every future one.
 * (quinn, DIVE-4280 verify pass.)
 */
export const DENY_SEGMENTS = new Set(['.claude', '.ssh', '.config', '.aws', '.gnupg'])

/** Absolute directory prefixes that are never auto-attachable. */
export function deniedDirs(_home = homedir()): string[] {
  return [
    '/etc/5dive',
    '/var/lib/5dive',
    // /var/log/5dive/agent-audit.log is 0640 root:claude — readable by every
    // seat through the `claude` group — 20 MB (under the send cap) and it logs
    // command ARGUMENTS, which on this box include cleartext telegram bot
    // tokens. "the audit trail is in /var/log/5dive/agent-audit.log" is an
    // ordinary sentence here. All of /var/log goes, not just the 5dive dir:
    // nothing under it is an artefact an agent wrote for the human, and auth.log
    // and cloud-init logs are the same shape of leak. (quinn, DIVE-4280.)
    '/var/log',
    '/etc/ssh',
    '/root',
  ]
}

/**
 * Roots an auto-attachable file may live under — the ALLOWLIST that stops the
 * enumeration game.
 *
 * Three verify iterations each found one more forbidden place the denylist had
 * not thought of (`.claude.json`, another seat's home, /var/log/5dive). That is
 * a denylist's failure mode, not three unrelated misses: the box has more
 * sensitive directories than anyone can list, and a new one appears whenever
 * something is installed. So the shape is inverted — a file is eligible only
 * when it sits somewhere agents actually WRITE artefacts for the human: a home
 * directory, a scratch dir, or the process's own working tree. Everything else
 * (/etc, /var/lib, /var/log, /proc, /sys, /usr, /opt, /srv, /boot, a mounted
 * backup) is ineligible without needing to be named. The denylist stays in
 * front of it and still carves the credential-shaped files OUT of these roots.
 */
export function allowedRoots(home = homedir()): string[] {
  const roots = ['/home', '/tmp', '/var/tmp', home]
  try { roots.push(process.cwd()) } catch { /* cwd unlinked; roots are enough */ }
  return roots
}

/**
 * True when a path must never be auto-attached. Checked on the RESOLVED path,
 * so a symlink into any .claude tree cannot launder a token out.
 */
export function isDenied(resolved: string, home = homedir()): boolean {
  // Allowlist first: outside the roots agents write artefacts in, nothing is
  // eligible, whether or not this file has thought of it.
  if (!allowedRoots(home).some(r => resolved === r || resolved.startsWith(r + sep))) return true
  for (const seg of resolved.split(sep)) {
    if (DENY_SEGMENTS.has(seg)) return true
  }
  for (const d of deniedDirs()) {
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
 * The names of the files this plan attaches — `attached: a.md, b.md` — or the
 * empty string when it attaches none.
 *
 * DIVE-4280 put this line in the OUTGOING TEXT so the human and the transcript
 * would agree on what was sent. The human half of that never earned its place:
 * the attachment arrives directly under the message, so the phone already shows
 * it. The transcript half is real and is why the line still exists — the tool
 * result and the rolling log are readers that cannot see an attachment.
 */
export function attachedNames(plan: AutoAttachPlan): string {
  if (!plan.attach.length) return ''
  return `attached: ${plan.attach.map(p => basename(p)).join(', ')}`
}

/**
 * The footer line(s) appended to the outgoing text: only what the attachment
 * ITSELF cannot tell the human. Empty string when there is nothing to say.
 *
 * Deliberately not the attached names (those are `attachedNames`, and they go
 * to the readers listed there). A file that was SENT is visible; a file that
 * was named and NOT sent is not, and that is the whole content of both lines
 * below.
 */
export function autoAttachFooter(plan: AutoAttachPlan): string {
  const lines: string[] = []
  if (plan.overflow) {
    lines.push(`+${plan.overflow} more files named; ask for one by name`)
  }
  if (plan.tooLarge.length) {
    lines.push(`too large to send: ${plan.tooLarge.map(p => basename(p)).join(', ')}`)
  }
  return lines.join('\n')
}
