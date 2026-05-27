// Portable reset-epoch extractor. The previous bash version relied on
// GNU `date -d "9pm UTC" +%s` which doesn't exist on macOS/BSD. JS Date
// parsing is cross-platform but only accepts ISO-ish input — so we
// re-implement the "<HH(:MM)?>(am|pm)? (<TZ>)?" parse explicitly.
//
// Bumps to "tomorrow" when the parsed clock time is in the past today —
// matches the bash logic. Returns null on any input we can't parse.

const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i
// 24-hour "HH:MM" fallback when there's no am/pm (e.g. "resets at 21:00 UTC").
const CLOCK24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/
const TZ_RE = /\(([A-Za-z_]+\/[A-Za-z_]+|UTC|GMT)\)/

// Common timezone abbreviations → IANA zones, so epochAtTz resolves them
// DST-correctly via Intl. US-centric, matching the zones Anthropic's limit
// messages use; `CST`/`CDT` mean US Central here, not China.
const TZ_ABBREV: Record<string, string> = {
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  UTC: 'UTC', GMT: 'UTC',
}
const TZ_ABBREV_RE = /\b(PST|PDT|PT|MST|MDT|MT|CST|CDT|CT|EST|EDT|ET|UTC|GMT)\b/

export function parseResetEpoch(text: string): number | null {
  // Numeric epoch passthrough (used for payload.resetsAt). Bash also
  // tolerated ms-precision epochs by dividing by 1000 if >10^10 — keep that.
  if (/^\d+$/.test(text.trim())) {
    let n = parseInt(text.trim(), 10)
    if (n > 1e10) n = Math.floor(n / 1000)
    return n
  }

  // ISO-ish (RFC3339) — let Date handle it.
  const iso = Date.parse(text)
  if (!isNaN(iso)) return Math.floor(iso / 1000)

  // Plain-English: absolute clock ("9pm (TZ)", "21:00 UTC") or relative
  // ("resets in 2h 30m").
  return parseResetFromText(text)
}

export function parseResetFromText(text: string): number | null {
  // Absolute clock time (am/pm preferred, else 24h) wins when present; it's
  // the canonical Anthropic format. Relative duration is the fallback.
  const abs = parseClock(text)
  if (abs !== null) return abs
  return parseRelativeDuration(text)
}

function parseClock(text: string): number | null {
  let hour24: number
  let minute: number
  const ampm = CLOCK_RE.exec(text)
  if (ampm) {
    const hour12 = parseInt(ampm[1], 10)
    minute = ampm[2] ? parseInt(ampm[2], 10) : 0
    if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null
    hour24 = (hour12 % 12) + (ampm[3].toLowerCase() === 'pm' ? 12 : 0)
  } else {
    const h24 = CLOCK24_RE.exec(text)
    if (!h24) return null
    hour24 = parseInt(h24[1], 10)
    minute = parseInt(h24[2], 10)
  }

  const tzName = resolveTz(text)
  const now = new Date()
  const epoch = epochAtTz(now, hour24, minute, tzName)
  if (epoch === null) return null

  // Bump tomorrow if the parsed time is already in the past.
  const nowSec = Math.floor(Date.now() / 1000)
  if (epoch < nowSec) {
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
    return epochAtTz(tomorrow, hour24, minute, tzName)
  }
  return epoch
}

// Resolve a timezone from the text: IANA in parens first, then a bare
// abbreviation. Undefined → epochAtTz falls back to system-local time.
function resolveTz(text: string): string | undefined {
  const paren = TZ_RE.exec(text)?.[1]
  if (paren) return paren === 'GMT' ? 'UTC' : paren
  const abbr = TZ_ABBREV_RE.exec(text)?.[1]
  if (abbr) return TZ_ABBREV[abbr.toUpperCase()]
  return undefined
}

// "resets in 2h", "try again in 90 minutes", "in 2h 30m" → now + delta.
// Sums every h/m/s part after an "in" lead-in; null if none found.
function parseRelativeDuration(text: string): number | null {
  const lead = /\bin\s+((?:\d+\s*(?:h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\s*,?\s*(?:and\s+)?)+)/i.exec(text)
  if (!lead) return null
  let total = 0
  let matched = false
  const partRe = /(\d+)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi
  let p: RegExpExecArray | null
  while ((p = partRe.exec(lead[1])) !== null) {
    const n = parseInt(p[1], 10)
    const unit = p[2][0].toLowerCase()
    if (unit === 'h') total += n * 3600
    else if (unit === 'm') total += n * 60
    else total += n
    matched = true
  }
  if (!matched || total <= 0) return null
  return Math.floor(Date.now() / 1000) + total
}

// Compute epoch (seconds) for "today at <hour>:<minute>" in the given IANA
// timezone. Uses Intl.DateTimeFormat to extract the TZ-local Y/M/D, then
// constructs a UTC date that matches by iterating once (TZ-aware Date
// construction in JS without third-party libs is genuinely this annoying).
function epochAtTz(referenceDay: Date, hour: number, minute: number, tzName?: string): number | null {
  // No TZ → use system local time.
  if (!tzName) {
    const d = new Date(
      referenceDay.getFullYear(),
      referenceDay.getMonth(),
      referenceDay.getDate(),
      hour,
      minute,
      0,
      0,
    )
    return Math.floor(d.getTime() / 1000)
  }
  try {
    // Get the Y/M/D in the target TZ for the reference day. Use 'sv-SE'
    // locale to get ISO-ish "YYYY-MM-DD" formatting.
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tzName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const [y, m, d] = fmt.format(referenceDay).split('-').map(s => parseInt(s, 10))
    // Build a candidate UTC instant for "Y-M-D hour:minute" and compute the
    // offset between that wall-clock and what the TZ shows.
    let candidate = Date.UTC(y, m - 1, d, hour, minute, 0)
    const checkFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tzName,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    })
    // Iterate up to twice: first to apply the base offset, second to handle
    // DST edge transitions. In practice converges immediately.
    for (let i = 0; i < 2; i++) {
      const shown = checkFmt.format(new Date(candidate))
      const [sh, sm] = shown.split(':').map(s => parseInt(s, 10))
      const wantTotal = hour * 60 + minute
      const gotTotal = sh * 60 + sm
      const drift = wantTotal - gotTotal
      if (drift === 0) break
      candidate += drift * 60 * 1000
    }
    return Math.floor(candidate / 1000)
  } catch {
    return null
  }
}
