/**
 * DIVE-1494 (3): pure renderers for the read-only Council view in Telegram.
 *
 * The `/council` command + the `cl:log|lin|ver` callback taps shell `sudo 5dive
 * council {roster,log,lineage ls,verify} --json` and format the sealed, tamper-
 * evident governance record for chat. Everything here is READ-ONLY — no nonce,
 * no tap-to-mutate (that is the founder-veto tap, DIVE-1546, a separate
 * authenticated path). Keeping the formatting pure + side-effect-free lets it be
 * unit-tested headless (test/council.test.ts), the way tna.ts / option parsing is.
 */

// Short digest for chat (the sealed digests are ~43-char base64url).
export function shortDigest(d: unknown, n = 12): string {
  const s = typeof d === 'string' ? d : ''
  if (!s) return 'none'
  return s.length > n ? `${s.slice(0, n)}…` : s
}

type RosterData = {
  council?: string
  seats?: Array<{ id?: string; lens?: string; chair?: boolean }>
  seatCount?: number
  threshold?: number
  thresholdSpec?: { rule?: string }
  quorum?: number
  veto?: { principal?: string; resolved?: string }
  lineage?: { seq?: number; headDigest?: string; records?: number }
}

// The `/council` header: who sits, the pass rule, the founder-veto holder, and the
// sealed lineage head. Defensive against older CLIs that omit a field.
export function renderRoster(d: RosterData | null | undefined): string {
  if (!d) return '🏛️ Council: not initialized (run `sudo 5dive council init` on a genesis box).'
  const name = d.council || 'council'
  const seats = Array.isArray(d.seats) ? d.seats : []
  const seatIds = seats.map(s => (s?.chair ? `${s.id} (chair)` : s?.id)).filter(Boolean)
  const n = typeof d.seatCount === 'number' ? d.seatCount : seatIds.length
  const rule = d.thresholdSpec?.rule || (typeof d.threshold === 'number' ? `${d.threshold}` : '?')
  const thr = typeof d.threshold === 'number' ? `${rule} (${d.threshold}/${n})` : rule
  const veto = d.veto?.principal || 'none'
  const lh = d.lineage
  const head = lh
    ? `seq ${lh.seq ?? '?'} · ${shortDigest(lh.headDigest)} · ${lh.records ?? '?'} record${lh.records === 1 ? '' : 's'}`
    : 'none'
  return [
    `🏛️ Council: ${name}`,
    `seats (${n}): ${seatIds.length ? seatIds.join(', ') : 'none'}`,
    `threshold: ${thr}${typeof d.quorum === 'number' ? ` · quorum ${d.quorum}` : ''}`,
    `founder veto: ${veto}`,
    `lineage head: ${head}`,
  ].join('\n')
}

type LogEntry = {
  seq?: number
  kind?: string
  stampedAt?: string
  digest?: string
}

// The last N sealed verdicts (genesis + motions + any founder veto), newest first.
export function renderLog(entries: LogEntry[] | null | undefined, limit = 5): string {
  const es = Array.isArray(entries) ? entries : []
  if (!es.length) return '📜 Council log: empty (council not yet initialized).'
  const recent = [...es].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, limit)
  const lines = recent.map(
    e => `seq ${e.seq ?? '?'} · ${e.kind || '?'} · ${e.stampedAt || '?'} · ${shortDigest(e.digest)}`,
  )
  return [`📜 Council log (last ${recent.length})`, ...lines].join('\n')
}

// The hash-chain summary from `lineage ls` — head + length + the seq/kind ladder.
export function renderLineage(entries: LogEntry[] | null | undefined): string {
  const es = Array.isArray(entries) ? entries : []
  if (!es.length) return '🔗 Lineage: empty (council not yet initialized).'
  const sorted = [...es].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
  const head = sorted[0]
  const ladder = sorted.slice(0, 6).map(e => `seq ${e.seq ?? '?'} ${e.kind || '?'}`).join(' ← ')
  return [
    `🔗 Lineage: ${es.length} record${es.length === 1 ? '' : 's'} · head ${shortDigest(head?.digest)}`,
    ladder,
  ].join('\n')
}

type VerifyData = {
  verified?: boolean
  records?: number
  chainOk?: boolean
  resealOk?: boolean
  resealBad?: string
  constitutionOk?: boolean
  chain?: { ok?: boolean; head?: string; length?: number }
}

// `verify` fails closed on any tamper / broken link / drifted constitution. Render the
// green/red verdict plus which leg failed so a RED is actionable in chat.
export function renderVerify(d: VerifyData | null | undefined): string {
  if (!d) return '✅ Council verify: could not read the lineage (fail-closed).'
  if (d.verified) {
    return [
      '✅ Council verify: GREEN',
      `chain ok · reseal ok · constitution ok · ${d.records ?? '?'} record${d.records === 1 ? '' : 's'}`,
      `head ${shortDigest(d.chain?.head)}`,
    ].join('\n')
  }
  const bad: string[] = []
  if (d.chainOk === false) bad.push('chain BROKEN')
  if (d.resealOk === false) bad.push(`reseal FAILED${d.resealBad ? ` (${shortDigest(d.resealBad)})` : ''}`)
  if (d.constitutionOk === false) bad.push('constitution DRIFTED')
  return ['🛑 Council verify: RED (fail-closed)', bad.length ? bad.join(' · ') : 'lineage integrity check failed'].join('\n')
}

// The three read-only tap buttons the `/council` header carries. callback_data is a
// short static verb (no nonce — read-only), well under Telegram's 64-byte cap.
export const COUNCIL_BUTTONS: Array<{ text: string; callback_data: string }> = [
  { text: '📜 Log', callback_data: 'cl:log' },
  { text: '🔗 Lineage', callback_data: 'cl:lin' },
  { text: '✅ Verify', callback_data: 'cl:ver' },
]
