import { migrateState } from './compat.ts'

export type DispatchSource = 'telegram' | 'dashboard' | 'agent'

export type DispatchRoute = {
  source: DispatchSource
  chat_id: string
  message_thread_id?: string
}

export type DispatchMessage = {
  id: string
  text: string
  route: DispatchRoute
  image_path?: string
  received_at?: string
  /**
   * A control verb instead of a user turn (DIVE-5502). The text is kept so an
   * older dispatcher that does not know the field has something to log, but
   * this one never submits it to the model: "/clear" arriving as a user message
   * burns a turn and resets nothing (the residual 5dive's CLI names on DIVE-4036).
   */
  control?: ControlOp
  /** The level a `set-effort` control asks for; refused on any other verb. */
  effort?: string
}

/**
 * `compact` summarises the live thread in place (the app-server runs it as a
 * turn). `new-session` saves a receipt for the current thread and starts a
 * bounded new one, carrying a one-paragraph handoff into its first turn.
 *
 * `set-effort`, `usage` and `account` never touch the thread, so they run the
 * moment they arrive, even mid-turn: never queued behind the active turn, never
 * steered into it (IMMEDIATE_CONTROLS).
 */
export type ControlOp = 'compact' | 'new-session' | 'set-effort' | 'usage' | 'account'
export const CONTROL_OPS: readonly ControlOp[] = ['compact', 'new-session', 'set-effort', 'usage', 'account']
export const IMMEDIATE_CONTROLS: readonly ControlOp[] = ['set-effort', 'usage', 'account']

/** Codex reasoning-effort levels `set-effort` accepts (codex 0.153.3). */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export function isEffortLevel(level: unknown): level is (typeof EFFORT_LEVELS)[number] {
  return typeof level === 'string' && (EFFORT_LEVELS as readonly string[]).includes(level)
}

/**
 * The provider's own rate-limit report (app-server `account/rateLimits/read`
 * and `account/rateLimits/updated`). Percentages here are OpenAI's numbers; this
 * bridge never derives one from token counts (the codex audit's item 5).
 */
export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export type RateLimitSnapshot = {
  limitId?: string | null
  limitName?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  planType?: string | null
  rateLimitReachedType?: string | null
}
/** The last provider report this dispatcher saw, and when. */
export type RateLimitRecord = { buckets: RateLimitSnapshot[]; at: string; from: 'read' | 'updated' }

/**
 * The thread's token accounting, as `thread/tokenUsage/updated` last reported
 * it. `last*` is ONE model call, the number the audit measured (134-146k input
 * per call at 96% cache). `inContext` is what the next call starts from.
 */
export type ContextUsage = {
  threadId: string
  inContext: number
  window?: number
  lastInput: number
  lastCached: number
  lastOutput: number
  /** Model calls seen on this thread since this dispatcher bound it. */
  calls: number
  /** The thread's running token total: an unchanged total is a replayed
   *  snapshot, not another call. */
  total: number
  at: string
}

/** One sample per model call, for the before/after measurement. */
export type UsageSample = {
  at: string
  threadId: string
  turnId: string
  input: number
  cached: number
  output: number
  reasoning: number
  inContext: number
  window?: number
}

/** What a `new-session` left behind, so the old thread can be found again. */
export type SessionReceipt = {
  threadId: string
  endedAt: string
  reason: string
  calls?: number
  inContext?: number
}

export type DispatcherState = {
  /** DISPATCHER_STATE_SCHEMA (compat.ts). Absent on files written before P10. */
  schema?: number
  threadId?: string
  seen: string[]
  pending: DispatchMessage[]
  active?: { turnId: string; routeKey: string; route: DispatchRoute; message: DispatchMessage }
  /**
   * Set by `markCleanShutdown()` on the way out and cleared by the next
   * `initialize()`. Its ABSENCE is the load-bearing half: a dispatcher that was
   * SIGKILLed, OOM-killed or died with its box never gets to write it, so
   * "restarted" and "crashed" stop being the same sentence to the person in the
   * chat (DIVE-3965).
   */
  cleanExit?: boolean
  /**
   * Carried across the restart and injected into the NEXT real turn, never
   * submitted as a turn of its own — replaying the interrupted message would
   * duplicate work Codex may already have done before it died.
   */
  recovery?: RecoveryContext
  /**
   * What the THREAD is running, as the app-server last reported it — never what
   * config.toml says. The two diverge exactly when a resumed thread keeps the
   * model it was saved with (DIVE-4924), so a reader that wants "which model
   * will answer" must read this, not the seat config.
   */
  threadModel?: ThreadModel
  context?: ContextUsage
  /** Newest last, bounded by MAX_RECEIPTS. */
  sessions?: SessionReceipt[]
  /** Short snippets of the last few user requests: the continuity a new
   *  session carries, without a model call to summarise. */
  recent?: string[]
  /** Rides the next real turn, exactly like `recovery`. */
  handoff?: string
  /** A compaction was requested and its turn has not started yet. */
  compacting?: { message: DispatchMessage; at: string; before?: number }
}

/** A model choice. `effort` is a Codex reasoning effort (`low`, `high`, …). */
export type ModelSelection = { model?: string; effort?: string }

export type ThreadModel = ModelSelection & {
  at: string
  /** Which app-server answer this came from — the proof of the reading. */
  from: 'thread/start' | 'thread/resume' | 'turn/start' | 'thread/settings/updated' | 'model/rerouted'
}

/**
 * Reads the seat's CONFIGURED model at startup. Resolves null when the config
 * cannot be read, and the dispatcher then leaves the thread's own choice alone —
 * the pre-DIVE-4924 behaviour, never a guess.
 */
export type ConfiguredModel = () => Promise<ModelSelection | null>

export type RecoveryContext = {
  /** `thread-lost` is the stronger fact: no earlier conversation is in context. */
  kind: 'interrupted' | 'thread-lost'
  at: string
  detail: string
}

export interface RpcPort {
  request(method: string, params: Record<string, unknown>): Promise<any>
}

export interface StateStore {
  /** The parsed file as found; `migrateState` decides what it is. */
  load(): unknown
  save(state: DispatcherState): void
  /** Move an unreadable state file aside (kept, never deleted). */
  quarantine?(reason: string): void
}

export interface DispatchSink {
  publish(route: DispatchRoute, text: string, meta: { turnId: string; itemId?: string; kind: 'message' | 'error' | 'control' }): Promise<void>
  /** Best-effort; a sink that cannot record a sample must not fail the turn. */
  usage?(sample: UsageSample): void
}

const MAX_SEEN = 512
const MAX_RECEIPTS = 10
const MAX_RECENT = 3
/** A compaction whose turn never started stops holding the queue after this. */
const COMPACT_START_TIMEOUT_MS = 120_000
const ATTACHMENT_LINE = /^\[\[5dive-attachment:(\/[^\]\r\n]+)\]\]$/

export function parseOutboundMessage(raw: string): { text: string; files: string[] } {
  const files: string[] = []
  const lines = raw.split(/\r?\n/).filter(line => {
    const match = line.trim().match(ATTACHMENT_LINE)
    if (!match) return true
    if (files.length < 10 && !files.includes(match[1]!)) files.push(match[1]!)
    return false
  })
  return { text: lines.join('\n').trim(), files }
}

function routeKey(route: DispatchRoute): string {
  return `${route.source}:${route.chat_id}:${route.message_thread_id ?? ''}`
}

/**
 * One short line, not a transcript. It rides the next turn's input so the model
 * learns what it lost without the dispatcher re-sending the lost message.
 */
export function recoveryLine(recovery: RecoveryContext): string {
  return `[5dive recovery] Since your last turn: ${recovery.detail}. Continue from the message below; `
    + 'do not replay the interrupted work unless the user asks for it.'
}

/**
 * The continuity a new session starts with: what the person had been asking,
 * marked as background so the model does not redo it. Snippets, not a
 * transcript: a handoff that re-sends the old context defeats the reset.
 */
export function handoffLine(previousThreadId: string, recent: string[]): string {
  const asks = recent.length ? ` Their most recent requests, oldest first: ${recent.map(r => `"${r}"`).join('; ')}.` : ''
  return `[5dive new session] The owner started a fresh session; the previous thread (${previousThreadId}) is saved.${asks} `
    + 'Treat that as background, not as work to redo; ask if you need more of it.'
}

/** `146k`, `1.2k`, `850` — one width for the chat. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** `5h`, `weekly`, `3d`: a window named by its length, never by its slot. */
export function windowName(mins: number | null | undefined, slot: string): string {
  if (mins == null || !Number.isFinite(mins) || mins <= 0) return slot
  if (mins === 300) return '5h'
  if (mins === 10080) return 'weekly'
  if (mins % 1440 === 0) return `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

function fmtSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m % 60}m`
  return `${m}m`
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `resets 14:05 UTC (in 2h 10m)` today, `resets Tue 6 Oct 09:00 UTC (in 2d 3h)` later. */
export function fmtReset(resetsAtSec: number, now: number): string {
  const at = new Date(resetsAtSec * 1000)
  if (Number.isNaN(at.getTime())) return ''
  const hhmm = at.toISOString().slice(11, 16)
  const today = at.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
  const when = today ? `${hhmm} UTC` : `${DAY[at.getUTCDay()]} ${at.getUTCDate()} ${MON[at.getUTCMonth()]} ${hhmm} UTC`
  const left = at.getTime() - now
  return left > 0 ? `resets ${when} (in ${fmtSpan(left)})` : `reset at ${when}`
}

function planName(plan: unknown): string {
  return typeof plan === 'string' && plan ? plan.replace(/_/g, ' ') : ''
}

function bucketLines(b: RateLimitSnapshot, now: number): string[] {
  const lines: string[] = []
  for (const [slot, w] of [['primary', b.primary], ['secondary', b.secondary]] as const) {
    if (!w || !Number.isFinite(Number(w.usedPercent))) continue
    const reset = w.resetsAt != null ? fmtReset(Number(w.resetsAt), now) : ''
    lines.push(`${windowName(w.windowDurationMins, slot)}: ${Math.round(Number(w.usedPercent))}% used${reset ? ` · ${reset}` : ''}`)
  }
  if (!lines.length) lines.push('no usage windows reported for this account')
  const c = b.credits
  if (c?.unlimited) lines.push('credits: unlimited')
  else if (c?.hasCredits && c.balance) lines.push(`credits: ${c.balance}`)
  if (b.rateLimitReachedType) lines.push(`⚠️ limit reached (${b.rateLimitReachedType.replace(/_/g, ' ')})`)
  return lines
}

function providerLines(buckets: RateLimitSnapshot[], now: number): string[] {
  const lines: string[] = []
  const plan = planName(buckets.find(b => b.planType)?.planType)
  if (plan) lines.push(`plan: ${plan}`)
  for (const b of buckets) {
    if (buckets.length > 1) lines.push(`${b.limitName || b.limitId || 'limit'}:`)
    lines.push(...bucketLines(b, now))
  }
  return lines
}

/** The read's buckets, the backward-compatible single view first. */
export function rateLimitBuckets(read: any): RateLimitSnapshot[] | null {
  const main = read?.rateLimits && typeof read.rateLimits === 'object' ? read.rateLimits as RateLimitSnapshot : undefined
  const out: RateLimitSnapshot[] = main ? [main] : []
  const by = read?.rateLimitsByLimitId
  if (by && typeof by === 'object') {
    for (const b of Object.values(by) as RateLimitSnapshot[]) {
      if (!b || typeof b !== 'object') continue
      if (out.some(o => (o.limitId ?? null) === (b.limitId ?? null))) continue
      out.push(b)
    }
  }
  return out.length ? out : null
}

const AUTH_REQUIRED = /authentication required|not (?:signed|logged) in|unauthori[sz]ed|\b401\b/i

/**
 * The /usage reply. Two blocks that are never mixed: what OpenAI reports about
 * the plan's windows, and this session's token counts. A percentage only ever
 * comes from the provider; token counts stay counts (codex audit, item 5).
 */
export function usageReport(o: {
  buckets?: RateLimitSnapshot[] | null
  error?: string
  cached?: RateLimitRecord
  context?: ContextUsage
  now: number
}): string {
  const lines = ['📊 Usage', '', 'Provider-reported (OpenAI):']
  if (o.buckets?.length) {
    lines.push(...providerLines(o.buckets, o.now))
  } else {
    if (o.error && AUTH_REQUIRED.test(o.error)) {
      lines.push('not available: Codex is not signed in with a ChatGPT plan, so OpenAI reports no plan limits.')
    } else {
      lines.push(`could not read it (${o.error || 'Codex returned no usage windows'}).`)
    }
    if (o.cached?.buckets.length) {
      lines.push(`last report, ${o.cached.at.slice(11, 16)} UTC:`, ...providerLines(o.cached.buckets, o.now))
    }
  }
  lines.push('', 'This session (token counts, not quota):')
  const c = o.context
  if (!c) {
    lines.push('no model call on this session yet')
  } else {
    lines.push(`last call: ${fmtTokens(c.lastInput)} in, ${fmtTokens(c.lastCached)} cached, ${fmtTokens(c.lastOutput)} out`)
    lines.push(`model calls: ${c.calls} · in context ~${fmtTokens(c.inContext)}`)
  }
  return lines.join('\n')
}

/** The /account identity line, from app-server `account/read`. */
export function accountReport(read: any, error?: string): string {
  if (error) return `Codex sign-in: could not read it (${error}).`
  const a = read?.account
  if (a?.type === 'chatgpt') {
    const plan = planName(a.planType)
    return `👤 Codex sign-in: ChatGPT${a.email ? `, ${a.email}` : ''}${plan ? ` (plan: ${plan})` : ''}.`
  }
  if (a?.type === 'apiKey') return '🔑 Codex sign-in: an OpenAI API key (billed per token, no plan limits).'
  if (a?.type === 'amazonBedrock') return '☁️ Codex sign-in: Amazon Bedrock.'
  if (a && typeof a.type === 'string') return `Codex sign-in: ${a.type}.`
  return read?.requiresOpenaiAuth === false
    ? 'Codex sign-in: none needed for this provider.'
    : '⚠️ Codex sign-in: not signed in.'
}

/** Sparse update: a null field is "not in this update", never "cleared". */
function mergeSnapshot(prev: RateLimitSnapshot | undefined, next: RateLimitSnapshot): RateLimitSnapshot {
  const out: RateLimitSnapshot = { ...(prev ?? {}) }
  for (const [k, v] of Object.entries(next ?? {})) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

function inputFor(message: DispatchMessage, recovery?: RecoveryContext, handoff?: string): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  if (recovery) input.push({ type: 'text', text: recoveryLine(recovery), text_elements: [] })
  if (handoff) input.push({ type: 'text', text: handoff, text_elements: [] })
  input.push({ type: 'text', text: message.text, text_elements: [] })
  if (message.image_path?.startsWith('/')) input.push({ type: 'localImage', path: message.image_path })
  return input
}

/** Keep a quoted snippet short enough to stay one line of context. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

function errText(err: unknown): string {
  return String((err as { message?: string })?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown error'
}

function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * The transport-independent part of the Codex channel dispatcher.
 *
 * One source conversation owns a turn. More input from that same source steers
 * the active turn; input from a different source waits for the next turn. This
 * is deliberately stricter than broadcasting one turn to every channel: a
 * Telegram response must never leak into dashboard chat (or vice versa).
 */
export class ChannelDispatcher {
  private state: DispatcherState
  private serial: Promise<unknown> = Promise.resolve()
  private itemText = new Map<string, string>()
  /** The seat config's choice, read once per start: a model switch is a config
   *  write plus a restart, so a restart is exactly when it can change. */
  private configured: ModelSelection = {}
  /** The last provider rate-limit report (in memory; a restart re-reads). */
  private limits?: RateLimitRecord

  constructor(
    private readonly rpc: RpcPort,
    private readonly store: StateStore,
    private readonly sink: DispatchSink,
    private readonly cwd: string,
    private readonly readConfigured?: ConfiguredModel,
  ) {
    const loaded = migrateState<DispatcherState>(store.load())
    this.state = loaded.state
    if (loaded.quarantine) {
      // DIVE-3969: typically a rollback below the bridge that wrote the file.
      // Start clean rather than resume a thread or replay a queue on a misread,
      // and say so on the next turn — the same sentence as any lost thread.
      store.quarantine?.(loaded.quarantine)
      this.state.recovery = {
        kind: 'thread-lost',
        at: new Date().toISOString(),
        detail: `${loaded.quarantine}, so it was set aside and none of the earlier conversation is in context`,
      }
    }
  }

  /** What the seat config asked for at the last start (empty when unreadable). */
  configuredModel(): ModelSelection {
    return { ...this.configured }
  }

  snapshot(): DispatcherState {
    return structuredClone(this.state)
  }

  /**
   * Record that this process is going down on purpose. Called from the shutdown
   * path, synchronously, because an exit is not a place to await anything.
   */
  markCleanShutdown(): void {
    if (this.state.cleanExit) return
    this.state.cleanExit = true
    this.persist()
  }

  async initialize(): Promise<void> {
    await this.enqueueSerial(async () => {
      const interrupted = this.state.active
      const wasClean = this.state.cleanExit === true
      this.state.active = undefined
      this.state.cleanExit = undefined
      // A compaction that never started died with the old app-server; one that
      // did start is the `interrupted` turn above. Either way it is not pending.
      this.state.compacting = undefined
      let threadLost = ''
      this.configured = await this.loadConfigured()
      if (this.state.threadId) {
        try {
          // A resumed thread keeps the model its rollout was saved with, NOT the
          // one config.toml names now (DIVE-4924: the seat said Astra, the
          // thread answered on Sol). So the configured choice is passed as an
          // override — history is kept, the model is the seat's.
          const resumed = await this.rpc.request('thread/resume', {
            threadId: this.state.threadId,
            ...(this.configured.model ? { model: this.configured.model } : {}),
            ...(this.configured.effort ? { config: { model_reasoning_effort: this.configured.effort } } : {}),
          })
          this.recordModel('thread/resume', resumed?.model, resumed?.reasoningEffort)
        } catch (err) {
          // A thread the app-server no longer has is not a fatal condition, but
          // it is not a silent one either: the conversation the person on the
          // other end is still holding in their head no longer exists here.
          threadLost = String((err as { message?: string })?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 120)
            || 'the app-server rejected the resume'
          this.state.threadId = undefined
        }
      }
      if (!this.state.threadId) await this.startThread()

      const facts: string[] = []
      if (interrupted) {
        facts.push(`the turn you were running was cut off before it finished (it was started by: "${snippet(interrupted.message.text)}")`)
      }
      if (threadLost) {
        facts.push(`the previous Codex thread could not be resumed (${threadLost}), so none of the earlier conversation is in context`)
      }
      if (facts.length > 0) {
        this.state.recovery = {
          kind: threadLost ? 'thread-lost' : 'interrupted',
          at: new Date().toISOString(),
          detail: facts.join('; '),
        }
      }
      this.persist()

      if (interrupted) {
        // Exactly once per interrupted turn: `active` is cleared and persisted
        // above, so a second restart before any new work says nothing at all.
        const cause = wasClean
          ? 'The local Codex dispatcher restarted'
          : 'The local Codex dispatcher stopped unexpectedly (crash, kill, or host reboot)'
        await this.sink.publish(
          interrupted.route,
          `${cause} before the previous turn completed. Please resend that message if you still need a response.`,
          { turnId: interrupted.turnId, kind: 'error' },
        )
      }
      await this.startNext()
    })
  }

  /** What OpenAI last reported about the plan's windows, if anything. */
  rateLimits(): RateLimitRecord | undefined {
    return this.limits ? structuredClone(this.limits) : undefined
  }

  async submit(message: DispatchMessage): Promise<'started' | 'steered' | 'queued' | 'duplicate' | 'ran'> {
    if (message.control && IMMEDIATE_CONTROLS.includes(message.control)) return this.runImmediate(message)
    return this.enqueueSerial(async () => {
      if (this.state.seen.includes(message.id) || this.state.pending.some(m => m.id === message.id)
        || this.state.active?.message.id === message.id) return 'duplicate'

      this.expireCompaction()
      // Nothing holds the thread but work is still queued (a lost compaction just
      // timed out, or a start failed): that work goes first, this joins the back.
      if (!this.state.active && !this.state.compacting && this.state.pending.length > 0) {
        this.state.pending.push(message)
        this.persist()
        await this.startNext()
        return this.state.pending.some(m => m.id === message.id) ? 'queued' : 'started'
      }
      // A control verb, or anything arriving while a compaction runs, waits for
      // the turn boundary: a reset cannot steer a turn, and a message steered
      // into a compaction would be summarised away rather than answered.
      if (this.state.active || this.state.compacting) {
        // Order is the contract: "/clear" then "do X" means X belongs to the new
        // session, so nothing steers past a control still waiting in the queue.
        if (message.control || this.state.compacting || this.state.active?.message.control
          || this.state.pending.some(m => m.control)
          || this.state.active!.routeKey !== routeKey(message.route)) {
          this.state.pending.push(message)
          this.persist()
          return 'queued'
        }
        const active = this.state.active!
        const result = await this.rpc.request('turn/steer', {
          threadId: this.requireThread(),
          expectedTurnId: active.turnId,
          clientUserMessageId: message.id,
          input: inputFor(message),
        })
        if (result?.turnId !== active.turnId) {
          throw new Error('turn/steer did not confirm the active turn')
        }
        this.remember(message)
        this.markSeen(message.id)
        this.persist()
        return 'steered'
      }

      await this.startMessage(message)
      if (!this.state.active && !this.state.compacting) await this.startNext()
      return 'started'
    })
  }

  /**
   * A control that does not touch the thread runs now, outside the turn queue:
   * an effort change or a usage read must not wait behind a long turn, and is
   * never steered into it. Only the dedup bookkeeping takes the serial lock, so
   * a slow provider read never holds up the running turn's events.
   */
  private async runImmediate(message: DispatchMessage): Promise<'ran' | 'duplicate'> {
    const dup = await this.enqueueSerial(async () => {
      if (this.state.seen.includes(message.id)) return true
      this.markSeen(message.id)
      this.persist()
      return false
    })
    if (dup) return 'duplicate'
    const route = message.route
    if (message.control === 'set-effort') {
      await this.setEffort(message)
    } else if (message.control === 'usage') {
      let read: any
      let error: string | undefined
      try { read = await this.rpc.request('account/rateLimits/read', {}) } catch (err) { error = errText(err) }
      const buckets = error ? null : rateLimitBuckets(read)
      if (buckets) this.limits = { buckets, at: new Date().toISOString(), from: 'read' }
      const ctx = this.state.context?.threadId === this.state.threadId ? this.state.context : undefined
      await this.sink.publish(route, usageReport({ buckets, error, cached: this.limits, context: ctx, now: Date.now() }),
        { turnId: '', kind: error ? 'error' : 'control' })
    } else {
      let read: any
      let error: string | undefined
      try { read = await this.rpc.request('account/read', {}) } catch (err) { error = errText(err) }
      await this.sink.publish(route, accountReport(read, error), { turnId: '', kind: error ? 'error' : 'control' })
    }
    return 'ran'
  }

  /**
   * Writes `model_reasoning_effort` through the app-server (config.toml, so a
   * restart keeps it) and moves the configured effort the next `turn/start`
   * passes. The running turn keeps the effort it started with.
   */
  private async setEffort(message: DispatchMessage): Promise<void> {
    const route = message.route
    const level = message.effort
    if (!isEffortLevel(level)) {
      await this.sink.publish(route, `Unknown effort "${String(level ?? '')}". Pick one of: ${EFFORT_LEVELS.join(', ')}.`,
        { turnId: '', kind: 'error' })
      return
    }
    const before = this.configured.effort ?? this.state.threadModel?.effort
    let res: any
    try {
      res = await this.rpc.request('config/value/write', { keyPath: 'model_reasoning_effort', value: level, mergeStrategy: 'replace' })
      if (res?.status !== 'ok' && res?.status !== 'okOverridden') throw new Error('Codex did not confirm the config write')
    } catch (err) {
      await this.sink.publish(route, `Could not change effort: ${errText(err)}. Still ${before ?? 'the default'}.`,
        { turnId: '', kind: 'error' })
      return
    }
    this.configured = { ...this.configured, effort: level }
    const running = Boolean(this.state.active && !this.state.active.message.control)
    const effective = res.status === 'okOverridden' ? res.overriddenMetadata?.effectiveValue : undefined
    const override = typeof effective === 'string' && effective !== level
      ? ` Another config layer sets ${effective}, so a restart goes back to it.` : ''
    await this.sink.publish(route, running
      ? `🧠 Effort now ${level}. It applies from the next turn; the running turn keeps ${before ?? 'its effort'}.${override}`
      : `🧠 Effort now ${level}, from the next turn.${override}`, { turnId: '', kind: 'control' })
  }

  /** Control verbs this dispatcher executes; advertised in health. */
  controls(): readonly ControlOp[] {
    return CONTROL_OPS
  }

  private async runControl(message: DispatchMessage): Promise<void> {
    const op = message.control!
    const route = message.route
    this.markSeen(message.id)
    if (op === 'compact') {
      const before = this.state.context?.threadId === this.state.threadId ? this.state.context?.inContext : undefined
      try {
        await this.rpc.request('thread/compact/start', { threadId: this.requireThread() })
      } catch (err) {
        this.persist()
        await this.sink.publish(route, `Could not compact this session: ${errText(err)}`, { turnId: '', kind: 'error' })
        return
      }
      // The app-server runs the compaction as a turn of its own (measured on
      // codex 0.153.3: turn/started → contextCompaction item → turn/completed).
      // `turn/started` adopts it as the active turn so the queue waits for it.
      this.state.compacting = { message, at: new Date().toISOString(), ...(before ? { before } : {}) }
      this.persist()
      return
    }
    if (op !== 'new-session') {
      // Immediate verbs never reach the turn queue (submit runs them at once);
      // one found here is a stray, and is dropped rather than read as a reset.
      this.persist()
      return
    }
    const previous = this.state.threadId
    const usage = this.state.context?.threadId === previous ? this.state.context : undefined
    if (previous) {
      const receipt: SessionReceipt = {
        threadId: previous,
        endedAt: new Date().toISOString(),
        reason: route.source === 'agent' ? 'a new task (5dive)' : `requested from ${route.source}`,
        ...(usage ? { calls: usage.calls, inContext: usage.inContext } : {}),
      }
      this.state.sessions = [...(this.state.sessions ?? []), receipt].slice(-MAX_RECEIPTS)
    }
    try {
      await this.startThread()
    } catch (err) {
      // Keep the old thread rather than strand the seat with none.
      if (previous) {
        this.state.threadId = previous
        this.state.sessions = this.state.sessions?.slice(0, -1)
      }
      this.persist()
      await this.sink.publish(route, `Could not start a new session: ${errText(err)}. Still on the current one.`, { turnId: '', kind: 'error' })
      return
    }
    this.state.context = undefined
    this.state.handoff = previous ? handoffLine(previous, this.state.recent ?? []) : undefined
    this.state.recent = []
    this.persist()
    const was = usage ? ` The previous one carried ~${fmtTokens(usage.inContext)} tokens over ${usage.calls} model call${usage.calls === 1 ? '' : 's'}.` : ''
    const saved = previous ? ` It is saved as ${previous.slice(0, 8)}; your next message starts the new one with a short note of what you last asked.` : ''
    // An agent-sourced reset (a new 5dive task) goes to the dispatcher log only;
    // `publish` drops the agent route before it reaches any chat.
    await this.sink.publish(route, `🆕 Fresh session.${was}${saved}`, { turnId: '', kind: 'control' })
  }

  /** A compaction whose turn never arrived must not hold the queue forever;
   *  the caller drains what queued behind it, in order. */
  private expireCompaction(): void {
    const c = this.state.compacting
    if (!c || this.state.active) return
    if (Date.now() - Date.parse(c.at) <= COMPACT_START_TIMEOUT_MS) return
    this.state.compacting = undefined
    this.persist()
  }

  /**
   * The clock half of `expireCompaction`: called on an interval by the host so
   * a message queued behind a lost compaction (or a failed start) is answered
   * without waiting for another inbound to arrive. A no-op while a turn runs.
   */
  async tick(): Promise<void> {
    await this.enqueueSerial(async () => {
      this.expireCompaction()
      await this.startNext()
    })
  }

  private async startThread(): Promise<void> {
    const started = await this.rpc.request('thread/start', {
      cwd: this.cwd,
      serviceName: '5dive-channel-dispatcher',
      developerInstructions:
        'Messages arrive from 5dive channels. Respond normally in assistant messages; the dispatcher routes those messages back to the originating channel. Do not call wait_for_message or channel reply tools. To attach a local file, include a separate [[5dive-attachment:/absolute/path]] line after a non-empty caption; the dispatcher removes the directive and sends the file only to the originating channel.',
    })
    const id = started?.thread?.id
    if (typeof id !== 'string' || !id) throw new Error('thread/start returned no thread id')
    this.state.threadId = id
    this.recordModel('thread/start', started?.model, started?.reasoningEffort)
  }

  private remember(message: DispatchMessage): void {
    const s = snippet(message.text).replace(/"/g, "'")
    if (!s) return
    this.state.recent = [...(this.state.recent ?? []), s].slice(-MAX_RECENT)
  }

  async notification(method: string, params: any): Promise<void> {
    await this.enqueueSerial(async () => {
      if (method === 'thread/settings/updated' && params?.threadId === this.state.threadId) {
        this.recordModel('thread/settings/updated', params?.threadSettings?.model, params?.threadSettings?.effort)
        this.persist()
        return
      }
      if (method === 'model/rerouted' && params?.threadId === this.state.threadId) {
        // The app-server swapped the model mid-turn; effort is unchanged by it.
        this.recordModel('model/rerouted', params?.toModel, this.state.threadModel?.effort)
        this.persist()
        return
      }
      if (method === 'account/rateLimits/updated' && params?.rateLimits && typeof params.rateLimits === 'object') {
        // Sparse, per bucket: merge into the bucket it names (or the only one).
        const next = params.rateLimits as RateLimitSnapshot
        const buckets = [...(this.limits?.buckets ?? [])]
        const i = buckets.findIndex(b => !next.limitId || !b.limitId || b.limitId === next.limitId)
        if (i >= 0) buckets[i] = mergeSnapshot(buckets[i], next)
        else buckets.push(mergeSnapshot(undefined, next))
        this.limits = { buckets, at: new Date().toISOString(), from: 'updated' }
        return
      }
      if (method === 'thread/tokenUsage/updated' && params?.threadId === this.state.threadId) {
        this.recordUsage(String(params?.turnId ?? ''), params?.tokenUsage)
        return
      }
      if (method === 'turn/started' && params?.threadId === this.state.threadId
        && this.state.compacting && !this.state.active) {
        const turnId = String(params?.turn?.id ?? '')
        if (!turnId) return
        const { message } = this.state.compacting
        this.state.active = { turnId, routeKey: routeKey(message.route), route: message.route, message }
        this.persist()
        return
      }
      if (method === 'item/agentMessage/delta') {
        const key = `${params?.turnId ?? ''}:${params?.itemId ?? ''}`
        this.itemText.set(key, (this.itemText.get(key) ?? '') + String(params?.delta ?? ''))
        return
      }
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const turnId = String(params?.turnId ?? '')
        if (!this.state.active || this.state.active.turnId !== turnId) return
        const itemId = String(params?.item?.id ?? '')
        const key = `${turnId}:${itemId}`
        const text = String(params.item.text ?? this.itemText.get(key) ?? '').trim()
        this.itemText.delete(key)
        if (text) await this.sink.publish(this.state.active.route, text, { turnId, itemId, kind: 'message' })
        return
      }
      if (method === 'turn/completed') {
        const turnId = String(params?.turn?.id ?? '')
        if (!this.state.active || this.state.active.turnId !== turnId) return
        const completed = this.state.active
        this.state.active = undefined
        const compaction = completed.message.control === 'compact' ? this.state.compacting : undefined
        if (compaction) this.state.compacting = undefined
        if (params?.turn?.status !== 'completed') {
          const detail = String(params?.turn?.error?.message ?? params?.turn?.status ?? 'unknown app-server error')
          await this.sink.publish(completed.route, compaction
            ? `Could not compact this session: ${detail}`
            : `Codex could not complete this turn: ${detail}`, {
            turnId, kind: 'error',
          })
        } else if (compaction) {
          const was = compaction.before ? ` It carried ~${fmtTokens(compaction.before)} tokens;` : ''
          await this.sink.publish(completed.route,
            `🗜 Session compacted.${was} the next reply shows the new size in /context.`, { turnId, kind: 'control' })
        }
        for (const key of this.itemText.keys()) {
          if (key.startsWith(`${turnId}:`)) this.itemText.delete(key)
        }
        this.persist()
        await this.startNext()
      }
    })
  }

  private async startMessage(message: DispatchMessage): Promise<void> {
    if (message.control) {
      await this.runControl(message)
      return
    }
    const recovery = this.state.recovery
    const handoff = this.state.handoff
    const result = await this.rpc.request('turn/start', {
      threadId: this.requireThread(),
      clientUserMessageId: message.id,
      turnTrigger: `5dive:${message.route.source}`,
      input: inputFor(message, recovery, handoff),
      // Every turn re-asserts the seat's choice. The resume override already
      // sets it; this makes the TURN the guarantee rather than one handshake.
      ...(this.configured.model ? { model: this.configured.model } : {}),
      ...(this.configured.effort ? { effort: this.configured.effort } : {}),
    })
    const turnId = result?.turn?.id
    if (typeof turnId !== 'string' || !turnId) throw new Error('turn/start returned no turn id')
    this.state.active = { turnId, routeKey: routeKey(message.route), route: message.route, message }
    // An accepted turn override IS the thread's model from here on (measured on
    // codex 0.153.3: the rollout's turn_context follows it even when the resume
    // reported the old one), and the app-server sends no settings event for it.
    if (this.configured.model) {
      this.recordModel('turn/start', this.configured.model, this.configured.effort ?? this.state.threadModel?.effort)
    } else if (this.configured.effort && this.state.threadModel?.model) {
      // An effort-only override (a /effort with no model pinned) is the
      // thread's effort from this turn on, the same way.
      this.recordModel('turn/start', this.state.threadModel.model, this.configured.effort)
    }
    // Consumed only once the turn it rode on actually exists: a `turn/start`
    // that threw leaves the context in state for the retry.
    if (recovery) this.state.recovery = undefined
    if (handoff) this.state.handoff = undefined
    this.remember(message)
    this.markSeen(message.id)
    this.persist()
  }

  private async startNext(): Promise<void> {
    // A control verb runs without leaving a turn behind (a new session), so
    // keep draining until something actually holds the thread.
    while (!this.state.active && !this.state.compacting && this.state.pending.length > 0) {
      const next = this.state.pending.shift()!
      this.persist()
      try {
        await this.startMessage(next)
      } catch (err) {
        this.state.pending.unshift(next)
        this.persist()
        throw err
      }
    }
  }

  private recordUsage(turnId: string, usage: any): void {
    const last = usage?.last
    if (!last || typeof last !== 'object') return
    const threadId = this.state.threadId!
    const prior = this.state.context?.threadId === threadId ? this.state.context : undefined
    const total = count(usage?.total?.totalTokens)
    // One update per model call; a repeat of the same totals (a resume replays
    // the last snapshot) is not another call.
    const isNewCall = !prior || total !== prior.total
    const window = count(usage?.modelContextWindow) || undefined
    const inContext = count(last.totalTokens) || count(last.inputTokens) + count(last.outputTokens)
    this.state.context = {
      threadId,
      inContext,
      ...(window ? { window } : {}),
      lastInput: count(last.inputTokens),
      lastCached: count(last.cachedInputTokens),
      lastOutput: count(last.outputTokens),
      calls: (prior?.calls ?? 0) + (isNewCall ? 1 : 0),
      total,
      at: new Date().toISOString(),
    }
    this.persist()
    if (!isNewCall) return
    try {
      this.sink.usage?.({
        at: this.state.context.at,
        threadId,
        turnId,
        input: count(last.inputTokens),
        cached: count(last.cachedInputTokens),
        output: count(last.outputTokens),
        reasoning: count(last.reasoningOutputTokens),
        inContext,
        ...(window ? { window } : {}),
      })
    } catch {}
  }

  private async loadConfigured(): Promise<ModelSelection> {
    if (!this.readConfigured) return {}
    try {
      const got = await this.readConfigured()
      const out: ModelSelection = {}
      if (typeof got?.model === 'string' && got.model.trim()) out.model = got.model.trim()
      if (typeof got?.effort === 'string' && got.effort.trim()) out.effort = got.effort.trim()
      return out
    } catch {
      return {}
    }
  }

  private recordModel(from: ThreadModel['from'], model: unknown, effort: unknown): void {
    if (typeof model !== 'string' || !model) return
    this.state.threadModel = {
      model,
      ...(typeof effort === 'string' && effort ? { effort } : {}),
      at: new Date().toISOString(),
      from,
    }
  }

  private markSeen(id: string): void {
    this.state.seen.push(id)
    if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN)
  }

  private requireThread(): string {
    if (!this.state.threadId) throw new Error('dispatcher thread is not initialized')
    return this.state.threadId
  }

  private persist(): void {
    this.store.save(this.state)
  }

  private enqueueSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn)
    this.serial = next.then(() => undefined, () => undefined)
    return next
  }
}
