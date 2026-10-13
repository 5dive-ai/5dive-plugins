// DIVE-6121 — the usage-wall move must reach a STANDARD seat.
//
// stopfailure-notify used to ask for the move with `sudo -n 5dive agent
// rotation rotate <self> --cooldown-current=<reset>`. A standard seat's grant
// is scoped and never held that verb, so the sudo was refused and the hook fell
// through to "wait for the reset". Measured 2026-10-13 01:13Z: a chat seat with
// rotation ON, walled on one account while its pool held one at 4%, sat silent
// on Telegram until 03:00Z.
//
// The CLI now carries the move on a self-scoped rail: a seat may run
// `5dive agent rotation rotate <itself> --wall=<reset>` as its OWN uid, and the
// CLI crosses its exact-path grant root-side. The wall form only moves to an
// account with measured headroom, parks the walled one until its reset, and
// does not chain a second move inside 30 minutes.
//
// SUDO IS THE FALLBACK, NEVER THE FIRST TRY (the cliexec.ts rule): the bare
// binary first; the legacy sudo form only when the bare call did not answer at
// all (a CLI that predates `--wall`, or a box where the rail is absent). A bare
// call that ANSWERED — moved or declined — is final: a declined wall move (no
// headroom, or the chain guard) must never be retried on a path without either.
//
// Takes its exec function as a parameter so the suite drives the real strategy.

export type Run = (cmd: string, args: string[], timeoutMs: number) => { stdout?: string | null }

export type RotateVerdict =
  | { kind: 'rotated'; from: string; to: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'failed' }

function parse(stdout: string | null | undefined): any {
  try {
    return JSON.parse((stdout || '').trim())
  } catch {
    return null
  }
}

function verdictOf(j: any): RotateVerdict | null {
  if (!j?.ok || !j.data) return null
  if (j.data.rotated && j.data.to) return { kind: 'rotated', from: String(j.data.from ?? '?'), to: String(j.data.to) }
  if (j.data.rotated === false) return { kind: 'declined', reason: String(j.data.reason ?? 'no eligible account') }
  return null
}

export function wallRotate(agent: string, resetEpoch: number, run: Run, timeoutMs = 8000): RotateVerdict {
  const bare = verdictOf(
    parse(run('5dive', ['--json', 'agent', 'rotation', 'rotate', agent, `--wall=${resetEpoch}`], timeoutMs).stdout),
  )
  if (bare) return bare
  const legacy = verdictOf(
    parse(
      run('sudo', ['-n', '5dive', '--json', 'agent', 'rotation', 'rotate', agent, `--cooldown-current=${resetEpoch}`], timeoutMs)
        .stdout,
    ),
  )
  return legacy ?? { kind: 'failed' }
}

// `agent rotation get` is a read and needs no root; the sudo form is only a
// fallback for a CLI old enough to have required it.
export function readActiveAccount(agent: string, run: Run, timeoutMs = 3500): string | null {
  for (const [cmd, args] of [
    ['5dive', ['--json', 'agent', 'rotation', 'get', agent]],
    ['sudo', ['-n', '5dive', '--json', 'agent', 'rotation', 'get', agent]],
  ] as const) {
    const j = parse(run(cmd, [...args], timeoutMs).stdout)
    if (j?.ok) return String(j.data?.active ?? '') || null
  }
  return null
}
