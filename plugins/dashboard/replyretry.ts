// DIVE-7713 (#1550): a reply the control plane answers 429 or 5xx is retried,
// not lost. A self-hosted box's nine agents filled one 60/min bucket and eight
// replies failed in a morning with "control plane returned 429".
//
// Which answers are safe to send again:
// - 429 and 503 are refused before the route stores anything (the rate limit,
//   the auth DB-blip) — always retried.
// - any other 5xx, or a dropped connection, can arrive AFTER the row was stored
//   (a proxy giving up on a slow call). Retried only when the reply carries a
//   `reply_key`: the control plane answers a repeat of a stored key with the
//   stored row, so the chat never shows the reply twice. The relay's positional
//   ops cannot carry a key, so through the relay only 429/503 are retried.
// The same body goes every time: an encrypted reply is sealed ONCE, before.

export const REPLY_RETRY_BUDGET_MS = 120_000
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

export function retryableReplyStatus(status: number, keyed: boolean): boolean {
  if (status === 429 || status === 503) return true
  return keyed && status >= 500 && status <= 599
}

/** Retry-After (seconds or an HTTP date) in ms, else the backoff step for this attempt. */
export function replyRetryDelayMs(attempt: number, retryAfter: string | null, now: number): number {
  const fallback = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  if (!retryAfter) return fallback
  const s = Number(retryAfter.trim())
  if (Number.isFinite(s) && s >= 0) return Math.max(250, s * 1000)
  const at = Date.parse(retryAfter)
  return Number.isFinite(at) ? Math.max(250, at - now) : fallback
}

export async function sendReplyWithRetry(
  send: () => Promise<Response>,
  opts: {
    keyed: boolean
    budgetMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    onRetry?: (why: string, waitMs: number, attempt: number) => void
  },
): Promise<Response> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = now() + (opts.budgetMs ?? REPLY_RETRY_BUDGET_MS)
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await send()
    } catch (err) {
      // A dropped connection may have been stored: only a keyed reply goes again.
      const wait = replyRetryDelayMs(attempt, null, now())
      if (!opts.keyed || now() + wait > deadline) throw err
      opts.onRetry?.(String(err).slice(0, 120), wait, attempt + 1)
      await sleep(wait)
      continue
    }
    if (res.ok || !retryableReplyStatus(res.status, opts.keyed)) return res
    const wait = replyRetryDelayMs(attempt, res.headers.get('retry-after'), now())
    if (now() + wait > deadline) return res
    void res.text().catch(() => '')
    opts.onRetry?.(String(res.status), wait, attempt + 1)
    await sleep(wait)
  }
}
