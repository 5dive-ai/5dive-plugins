// Portable reset-epoch extractor. The previous bash version relied on
// GNU `date -d "9pm UTC" +%s` which doesn't exist on macOS/BSD. JS Date
// parsing is cross-platform but only accepts ISO-ish input — so we
// re-implement the "<HH(:MM)?>(am|pm)? (<TZ>)?" parse explicitly.
//
// Bumps to "tomorrow" when the parsed clock time is in the past today —
// matches the bash logic. Returns null on any input we can't parse.
//
// DIVE-7748: a weekly wall names a DATE (`resets Nov 9, 5am (Europe/Nicosia)`).
// That form is read as a date, tried before any clock: the clock path alone took
// it as the next 5am, and the walled account left cooldown ~4 days early.
//
// Every parser takes an optional `nowMs` so a test can pin the clock; callers
// omit it and get Date.now().

const CLOCK_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i
// 24-hour "HH:MM" fallback when there's no am/pm (e.g. "resets at 21:00 UTC").
const CLOCK24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/
const TZ_RE = /\(([A-Za-z_]+\/[A-Za-z_]+|UTC|GMT)\)/
// DIVE-7748: the weekly wall's dated reset, `resets Nov 9, 5am` / `resets Oct 9,
// 4:30pm` / `resets Nov 9 at 17:00`. Same shape as the CLI's _HB_RESET_TIME_RE
// dated arm (DIVE-5837), plus a 24h clock.
const DATED_RE =
  /\bresets?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?(?:(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?|([01]?\d|2[0-3]):([0-5]\d)\b)/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// No weekly or session wall resets more than 7 days out. A date further ahead
// than this is a stale or quoted line (last year's banner read as next year's),
// not this wall's reset: it reads as unknown, never as a months-long park.
const DATED_MAX_AHEAD_S = 8 * 86400

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

export function parseResetEpoch(text: string, nowMs: number = Date.now()): number | null {
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
  return parseResetFromText(text, nowMs)
}

export function parseResetFromText(text: string, nowMs: number = Date.now()): number | null {
  // A dated reset (the weekly wall) is the most precise reading and wins
  // whenever the text carries one. A date that does not land within the bound
  // is unknown: falling through to the clock would read it as the next 5am,
  // the very bug DIVE-7748 fixed.
  if (DATED_RE.test(text)) return parseDated(text, nowMs)
  // Absolute clock time (am/pm preferred, else 24h) wins when present; it's
  // the canonical Anthropic format. Relative duration is the fallback.
  const abs = parseClock(text, nowMs)
  if (abs !== null) return abs
  return parseRelativeDuration(text, nowMs)
}

// `resets Nov 9, 5am (TZ)` → that instant. The year is not printed, so it is the
// one of last, this or next year (in the reset's zone) nearest to now: a `resets
// Jan 2` read on Dec 30 lands next year. A reset already past, or more than
// DATED_MAX_AHEAD_S ahead, is not a wall in force → null (the caller's fallback).
function parseDated(text: string, nowMs: number): number | null {
  const m = DATED_RE.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
  const day = parseInt(m[2], 10)
  let hour24: number
  let minute: number
  if (m[3] !== undefined) {
    const hour12 = parseInt(m[3], 10)
    minute = m[4] ? parseInt(m[4], 10) : 0
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null
    hour24 = (hour12 % 12) + (m[5].toLowerCase() === 'p' ? 12 : 0)
  } else {
    hour24 = parseInt(m[6], 10)
    minute = parseInt(m[7], 10)
  }
  if (month < 1 || day < 1 || day > 31) return null

  const tzName = resolveTz(text)
  const nowSec = Math.floor(nowMs / 1000)
  const year = ymdInTz(new Date(nowMs), tzName)?.[0]
  if (year === undefined) return null
  let best: number | null = null
  for (const y of [year - 1, year, year + 1]) {
    const e = epochAtYmd(y, month, day, hour24, minute, tzName)
    // A day the month does not have (`Feb 30`) rolls into the next month; skip it.
    if (e === null || ymdInTz(new Date(e * 1000), tzName)?.[2] !== day) continue
    if (best === null || Math.abs(e - nowSec) < Math.abs(best - nowSec)) best = e
  }
  if (best === null || best <= nowSec || best - nowSec > DATED_MAX_AHEAD_S) return null
  return best
}

function parseClock(text: string, nowMs: number): number | null {
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
  const now = new Date(nowMs)
  const epoch = epochAtTz(now, hour24, minute, tzName)
  if (epoch === null) return null

  // Bump tomorrow if the parsed time is already in the past.
  const nowSec = Math.floor(nowMs / 1000)
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
function parseRelativeDuration(text: string, nowMs: number): number | null {
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
  return Math.floor(nowMs / 1000) + total
}

// Compute epoch (seconds) for "today at <hour>:<minute>" in the given IANA
// timezone: the TZ-local Y/M/D of the reference day, then epochAtYmd.
function epochAtTz(referenceDay: Date, hour: number, minute: number, tzName?: string): number | null {
  const ymd = ymdInTz(referenceDay, tzName)
  if (!ymd) return null
  return epochAtYmd(ymd[0], ymd[1], ymd[2], hour, minute, tzName)
}

// The Y/M/D (month 1-12) the given instant shows in the zone; no zone → system
// local time. Null on a zone Intl does not know.
function ymdInTz(at: Date, tzName?: string): [number, number, number] | null {
  if (!tzName) return [at.getFullYear(), at.getMonth() + 1, at.getDate()]
  try {
    // 'sv-SE' formats as ISO-ish "YYYY-MM-DD".
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tzName,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const [y, m, d] = fmt.format(at).split('-').map(s => parseInt(s, 10))
    return [y, m, d]
  } catch {
    return null
  }
}

// Epoch (seconds) for the wall-clock "Y-M-D hour:minute" in the zone (month
// 1-12). TZ-aware Date construction in JS without third-party libs is genuinely
// this annoying: build the UTC instant with those digits, read the zone's full
// date and time at it, and shift by the difference (the zone's offset).
//
// DIVE-7748: the offset is read from the full date, not the clock alone. From
// hour:minute only, 11pm in UTC+2 showed 01:00 at the candidate, a +22h "drift",
// and the reset landed a day late.
function epochAtYmd(y: number, m: number, d: number, hour: number, minute: number, tzName?: string): number | null {
  // No TZ → use system local time.
  if (!tzName) return Math.floor(new Date(y, m - 1, d, hour, minute, 0, 0).getTime() / 1000)
  try {
    const want = Date.UTC(y, m - 1, d, hour, minute, 0)
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    const shownAt = (t: number): number => {
      const p: Record<string, number> = {}
      for (const part of fmt.formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10)
      return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, 0)
    }
    // Twice: the second pass settles a candidate that crossed a DST change.
    let candidate = want
    for (let i = 0; i < 2; i++) {
      const drift = want - shownAt(candidate)
      if (drift === 0) break
      candidate += drift
    }
    return Math.floor(candidate / 1000)
  } catch {
    return null
  }
}
