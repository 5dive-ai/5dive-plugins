// DIVE-4397 — SUDO IS THE FALLBACK, NEVER THE FIRST TRY.
//
// WHAT THIS FILE IS FOR. Every 5dive read in server.ts used to spawn
// `sudo -n 5dive …` unconditionally. On a seat whose sudoers grant is SCOPED
// (the standard agent: _deliver/_capture/_audit_append only) that call is
// denied — and a denial is not free. sudo MAILS ROOT about it. The needs-banner
// reconciler runs on a 60s timer, so each scoped seat generated one root mail a
// minute, forever, and the `catch` in the reader swallowed the rejection so
// nothing on our side ever said a word.
//
// Measured on a customer box (`5dive-teal-fox-cx43`, reported from outside the
// company twice): /var/mail/claude at 66 MB / 83,898 messages, oldest
// 2026-08-05, 640 in one day, 12 scoped seats and every one a source. Live from
// telegram plugin 0.5.36 through 0.5.51 — 15 releases, 39 days.
//
// THE FIX IS NOT MORE SUDO. Widening a seat's grant to silence a poll is an
// access change made to quiet a log, and the access would outlive the need.
// Instead:
//
//   1. UNPRIVILEGED FIRST. `task coordinator`, `task inbox`, `task ls`,
//      `task show`, `heartbeat ls`, `org tree`, `agent list`, `models` are
//      READS. They need no root. Run the bare binary as the seat's own uid; on
//      a scoped seat that path succeeds and sudo is never spawned, so no mail
//      is ever generated. (`refreshModelAliases` already did exactly this
//      one-off under DIVE-1883 — this generalises it to every read.)
//   2. SUDO ONLY AS FALLBACK, AND ONLY UNTIL IT IS DENIED ONCE. A denial is
//      sticky for the life of the process: after the first `not allowed to
//      execute` / `not in the sudoers file` / `a password is required`, this
//      runner never spawns sudo again. That turns an unbounded mail stream into
//      at most ONE message per process start even on a host where the
//      unprivileged path also fails.
//   3. SAY IT OUT LOUD. The latch and the failure breaker both surface one
//      rate-limited line. A swallowed catch on a 60s timer is precisely how
//      this stayed invisible for 39 days; nothing here may be silent again.
//
// Kept in its own module because server.ts long-polls Telegram on import and so
// cannot be imported by a unit test (same reason commands.ts holds the model
// alias merge). Everything below takes its exec function and its clock as
// parameters, so the suite drives the real strategy with a fake sudo.

export type ExecResult = { stdout: string; stderr: string }
export type ExecFn = (file: string, args: string[], opts?: unknown) => Promise<ExecResult>

// sudo's own refusals, as printed to stderr by `sudo -n`. These are the ones
// that mail root; a non-zero exit from 5dive ITSELF is a product error and must
// NOT latch (the grant is fine, the command failed).
const SUDO_DENIAL_RE =
  /(is not allowed to execute|not in the sudoers file|a password is required|sudo: no password was provided|no tty present|a terminal is required|sorry, try again)/i

export function isSudoDenial(e: unknown): boolean {
  const err = e as { stderr?: unknown; message?: unknown }
  return SUDO_DENIAL_RE.test(`${String(err?.stderr ?? '')}\n${String(err?.message ?? '')}`)
}

// Salvage stdout off a rejected exec (DIVE-125: the CLI can print a complete
// JSON envelope and still exit non-zero).
export function stdoutOf(e: unknown): string {
  return String((e as { stdout?: unknown } | undefined)?.stdout ?? '')
}

export type RunOutcome = {
  ok: boolean
  stdout: string
  /** which attempt produced `stdout` — 'none' when neither ran or both threw */
  via: 'plain' | 'sudo' | 'none'
  /** whether sudo was spawned at all on this call */
  sudoSpawned: boolean
  error?: unknown
}

export type FiveRunner = {
  run(args: string[], opts?: unknown, accept?: (stdout: string) => boolean): Promise<RunOutcome>
  /** true once sudo has refused us; no further sudo spawn will happen */
  sudoDenied(): boolean
}

export type FiveRunnerOpts = {
  execFile: ExecFn
  sudoBin: string
  /** absolute path to the bare binary, used for the unprivileged attempt */
  fiveBin: string
  /**
   * The word handed to sudo. Deliberately the bare name '5dive' and NOT
   * `fiveBin`: existing sudoers rules on shipped boxes match the command as
   * written today, and rewriting it to an absolute path would turn a working
   * grant into a denial on every one of them.
   */
  sudoArg?: string
  onSudoDenied?: (args: string[], stderr: string) => void
}

export function createFiveRunner(o: FiveRunnerOpts): FiveRunner {
  const sudoArg = o.sudoArg ?? '5dive'
  let denied = false
  return {
    sudoDenied: () => denied,
    async run(args, opts, accept) {
      let plainErr: unknown
      try {
        const { stdout } = await o.execFile(o.fiveBin, args, opts)
        if (!accept || accept(stdout)) return { ok: true, stdout, via: 'plain', sudoSpawned: false }
        // Ran fine but the CLI said it could not do it as this uid (ok:false).
        // That is the one case worth escalating — fall through to sudo.
        plainErr = new Error('unprivileged 5dive returned a non-ok envelope')
        ;(plainErr as { stdout?: string }).stdout = stdout
      } catch (e) {
        plainErr = e
      }
      if (denied) {
        // Sudo has already refused us once. Spawning it again buys nothing and
        // costs one more root mail, which is the entire defect.
        return { ok: false, stdout: stdoutOf(plainErr), via: 'none', sudoSpawned: false, error: plainErr }
      }
      try {
        const { stdout } = await o.execFile(o.sudoBin, ['-n', sudoArg, ...args], opts)
        if (!accept || accept(stdout)) return { ok: true, stdout, via: 'sudo', sudoSpawned: true }
        return { ok: false, stdout, via: 'sudo', sudoSpawned: true, error: plainErr }
      } catch (e) {
        if (isSudoDenial(e)) {
          denied = true
          o.onSudoDenied?.(args, String((e as { stderr?: unknown })?.stderr ?? ''))
        }
        const salvaged = stdoutOf(e) || stdoutOf(plainErr)
        return { ok: false, stdout: salvaged, via: salvaged ? 'sudo' : 'none', sudoSpawned: true, error: e }
      }
    },
  }
}

// A run of consecutive failures on a background timer is the shape that hid
// DIVE-4397 for 39 days. Count them, and after `threshold` in a row say so —
// once per `intervalMs`, reset the moment anything succeeds, so a fresh outage
// is loud on its first streak instead of waiting out a window from the last.
export type FailureBreaker = {
  ok(): void
  fail(detail: string): void
  streak(): number
}

export function createFailureBreaker(o: {
  threshold: number
  intervalMs: number
  now: () => number
  log: (msg: string) => void
  label: string
}): FailureBreaker {
  let streak = 0
  // null, not 0: an injected or monotonic clock can legitimately read 0, and a
  // 0-sentinel would then treat "already logged" as "never logged" and print on
  // every single tick — which is the same unbounded-output shape this row exists
  // to remove, just in our log instead of their mail.
  let loggedAt: number | null = null
  return {
    streak: () => streak,
    ok() {
      streak = 0
      loggedAt = null
    },
    fail(detail: string) {
      streak++
      if (streak < o.threshold) return
      const now = o.now()
      if (loggedAt !== null && now - loggedAt < o.intervalMs) return
      loggedAt = now
      o.log(
        `[${o.label}] ${streak} consecutive 5dive read failures — the surface fed by these reads ` +
          `is stale or blank and nothing else reports it. Last: ${detail}`,
      )
    },
  }
}
