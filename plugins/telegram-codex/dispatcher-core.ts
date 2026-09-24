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
}

export type DispatcherState = {
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
  load(): DispatcherState | null
  save(state: DispatcherState): void
}

export interface DispatchSink {
  publish(route: DispatchRoute, text: string, meta: { turnId: string; itemId?: string; kind: 'message' | 'error' }): Promise<void>
}

const MAX_SEEN = 512
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

function inputFor(message: DispatchMessage, recovery?: RecoveryContext): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = []
  if (recovery) input.push({ type: 'text', text: recoveryLine(recovery), text_elements: [] })
  input.push({ type: 'text', text: message.text, text_elements: [] })
  if (message.image_path?.startsWith('/')) input.push({ type: 'localImage', path: message.image_path })
  return input
}

/** Keep a quoted snippet short enough to stay one line of context. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
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

  constructor(
    private readonly rpc: RpcPort,
    private readonly store: StateStore,
    private readonly sink: DispatchSink,
    private readonly cwd: string,
    private readonly readConfigured?: ConfiguredModel,
  ) {
    this.state = store.load() ?? { seen: [], pending: [] }
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
      if (!this.state.threadId) {
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

  async submit(message: DispatchMessage): Promise<'started' | 'steered' | 'queued' | 'duplicate'> {
    return this.enqueueSerial(async () => {
      if (this.state.seen.includes(message.id) || this.state.pending.some(m => m.id === message.id)
        || this.state.active?.message.id === message.id) return 'duplicate'

      if (this.state.active) {
        if (this.state.active.routeKey !== routeKey(message.route)) {
          this.state.pending.push(message)
          this.persist()
          return 'queued'
        }
        const result = await this.rpc.request('turn/steer', {
          threadId: this.requireThread(),
          expectedTurnId: this.state.active.turnId,
          clientUserMessageId: message.id,
          input: inputFor(message),
        })
        if (result?.turnId !== this.state.active.turnId) {
          throw new Error('turn/steer did not confirm the active turn')
        }
        this.markSeen(message.id)
        this.persist()
        return 'steered'
      }

      await this.startMessage(message)
      return 'started'
    })
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
        if (params?.turn?.status !== 'completed') {
          const detail = String(params?.turn?.error?.message ?? params?.turn?.status ?? 'unknown app-server error')
          await this.sink.publish(completed.route, `Codex could not complete this turn: ${detail}`, {
            turnId, kind: 'error',
          })
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
    const recovery = this.state.recovery
    const result = await this.rpc.request('turn/start', {
      threadId: this.requireThread(),
      clientUserMessageId: message.id,
      turnTrigger: `5dive:${message.route.source}`,
      input: inputFor(message, recovery),
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
    }
    // Consumed only once the turn it rode on actually exists: a `turn/start`
    // that threw leaves the context in state for the retry.
    if (recovery) this.state.recovery = undefined
    this.markSeen(message.id)
    this.persist()
  }

  private async startNext(): Promise<void> {
    if (this.state.active || this.state.pending.length === 0) return
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
