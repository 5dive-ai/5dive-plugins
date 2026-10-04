// DIVE-5504: Codex approval requests on the dispatcher path, asked on Telegram.
//
// The app-server asks before a command or a file change whenever the seat's
// approval policy says so (the dispatcher never overrides that policy). Until
// 0.5.26 the dispatcher answered every such request with `decline`, so a seat
// on an asking policy could not run a command from the phone at all.
//
// The ask rides the SAME file handshake the PermissionRequest hook uses
// (hooks/request-permission.ts): req-<id>.json in the Telegram state dir's
// permissions/, which server.ts turns into ✅/❌ buttons, and res-<id>.json with
// the tapper's answer. One button UI, one attribution, one expiry rule.
//
// Fail closed: no adapter, no answer within the timeout, or an unreadable
// answer all decline, and the decline names why. Nothing here approves on its
// own.
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** Server requests this module answers. Anything else keeps its old reply. */
export const APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
] as const
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number]
export function isApprovalMethod(method: string): method is ApprovalMethod {
  return (APPROVAL_METHODS as readonly string[]).includes(method)
}

export const APPROVAL_TIMEOUT_MS = Math.max(5_000, Math.min(600_000,
  Number(process.env.CODEX_TG_APPROVAL_TIMEOUT_MS ?? 120_000) || 120_000))

export type Verdict =
  | { behavior: 'allow' | 'deny'; user?: string }
  | { behavior: 'timeout'; seconds: number }
  | { behavior: 'unavailable'; why: string }

/** What the Telegram prompt shows, in the shape server.ts already renders. */
export type ApprovalAsk = {
  tool_name: 'Bash' | 'Edit'
  tool_input: Record<string, unknown>
  cwd?: string
  reason?: string
}

export function approvalAsk(method: ApprovalMethod, params: any): ApprovalAsk {
  const reason = typeof params?.reason === 'string' && params.reason ? params.reason : undefined
  const cwd = typeof params?.cwd === 'string' ? params.cwd : undefined
  if (method === 'item/commandExecution/requestApproval') {
    return { tool_name: 'Bash', tool_input: { command: String(params?.command ?? '(command not shown)') }, cwd, reason }
  }
  if (method === 'execCommandApproval') {
    const cmd = Array.isArray(params?.command) ? params.command.map(String).join(' ') : String(params?.command ?? '')
    return { tool_name: 'Bash', tool_input: { command: cmd || '(command not shown)' }, cwd, reason }
  }
  const files = method === 'applyPatchApproval' && params?.fileChanges && typeof params.fileChanges === 'object'
    ? Object.keys(params.fileChanges).slice(0, 20) : undefined
  const grantRoot = typeof params?.grantRoot === 'string' ? params.grantRoot : undefined
  return {
    tool_name: 'Edit',
    tool_input: { ...(files ? { files } : {}), ...(grantRoot ? { grantRoot } : {}), ...(reason ? { reason } : {}) },
    cwd,
    reason,
  }
}

/** One plain clause for the model and the log: who decided, or why nobody did. */
export function verdictLine(v: Verdict): string {
  if (v.behavior === 'allow') return `approved${v.user ? ` by @${v.user}` : ''} on Telegram`
  if (v.behavior === 'deny') return `denied${v.user ? ` by @${v.user}` : ''} on Telegram`
  if (v.behavior === 'timeout') return `no answer on Telegram within ${v.seconds}s, so it was declined`
  return `declined: ${v.why}`
}

/**
 * The JSON-RPC result for a verdict. v2 requests take `accept`/`decline`; the
 * legacy pair takes `approved` or a `denied` object that carries the reason to
 * the model (codex 0.153.3 schema: ReviewDecision).
 */
export function approvalResult(method: ApprovalMethod, v: Verdict): Record<string, unknown> {
  const allow = v.behavior === 'allow'
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return allow ? { decision: 'approved' } : { decision: { denied: { rejection: verdictLine(v) } } }
  }
  return { decision: allow ? 'accept' : 'decline' }
}

export type AskOptions = {
  permsDir: string
  ask: ApprovalAsk
  /** The chat the turn came from; server.ts falls back to the owner's DM. */
  route?: { chat_id: string; message_thread_id?: string }
  model?: string
  timeoutMs?: number
  pollMs?: number
  id?: string
}

/**
 * Write the request, wait for the tap, clean up. Resolves a Verdict, never
 * rejects: a failure to ask is itself a decline with a reason.
 */
export async function askOnTelegram(o: AskOptions): Promise<Verdict> {
  const id = o.id ?? randomBytes(8).toString('hex')
  const timeoutMs = o.timeoutMs ?? APPROVAL_TIMEOUT_MS
  const pollMs = o.pollMs ?? 500
  const reqPath = join(o.permsDir, `req-${id}.json`)
  const resPath = join(o.permsDir, `res-${id}.json`)
  const tmp = join(o.permsDir, `.req-${id}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify({
      id,
      source: 'dispatcher',
      ...o.ask,
      ...(o.model ? { model: o.model } : {}),
      ...(o.route ? { chat_id: o.route.chat_id, ...(o.route.message_thread_id ? { message_thread_id: o.route.message_thread_id } : {}) } : {}),
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    }, null, 2), { mode: 0o600 })
    // Renamed into place: server.ts reacts to req-*.json and must never parse
    // half a file (a half-parse was a silent deny on the hook path).
    renameSync(tmp, reqPath)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    return { behavior: 'unavailable', why: `could not ask on Telegram (${String((err as Error)?.message ?? err).slice(0, 120)})` }
  }
  const deadline = Date.now() + timeoutMs
  let verdict: Verdict | null = null
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      try {
        const res = JSON.parse(readFileSync(resPath, 'utf8'))
        if (res?.behavior === 'allow' || res?.behavior === 'deny') {
          verdict = { behavior: res.behavior, ...(typeof res.user === 'string' && res.user ? { user: res.user } : {}) }
          break
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  // The request goes first: a tap that lands after this sees no request and is
  // told it expired, instead of answering something nobody is waiting on.
  try { unlinkSync(reqPath) } catch {}
  try { unlinkSync(resPath) } catch {}
  return verdict ?? { behavior: 'timeout', seconds: Math.round(timeoutMs / 1000) }
}
