// DIVE-8138: a dashboard process must not outlive the agent it serves.
//
// Server 589: agent "claudey" left the box on 11-06 09:46, and one of its
// dashboard processes kept long-polling `agent=claudey` for three days — 560k
// polls a day — and acked new messages to the dead name, so the API showed them
// as collected. Nothing in the process ever asked whether its agent still
// existed: the lifecycle watchdog only watches the parent and stdin, and a
// process that is not a child of the seat's unit (a supervisor's, a tmux
// server's, one an older `agent rm` never stopped) has both.
//
// The test is the one fact the box keeps for every seat: the unix account.
// `agent rm` deletes `agent-<name>`, and a recycled uid maps to a new name.
// So: if at boot this uid's passwd name WAS `$USER`, and later it is not (no
// entry, or another name), the seat is gone and this process stops.
//
// False positives would silence a healthy chat, so the guard is conservative:
//   - it arms only when the boot read proves this process IS that seat (a test
//     that fakes `USER=agent-dev` under another uid never arms it);
//   - an unreadable passwd is "unknown", never "gone";
//   - "gone" needs `strikes` consecutive reads, so one read that raced a
//     passwd rewrite (useradd/deluser write a temp file and rename) cannot fire.

/** The name passwd gives `uid`, or null when no entry has it. */
export function passwdName(passwd: string, uid: number): string | null {
  for (const line of passwd.split('\n')) {
    const f = line.split(':')
    if (f.length >= 3 && f[2] === String(uid) && f[0]) return f[0]
  }
  return null
}

export type SeatGuardOpts = {
  /** `$USER` — the seat this process was started for. */
  user: string
  uid: number
  /** The passwd text, or null when it cannot be read. */
  read: () => string | null
  strikes?: number
}

export type SeatCheck = 'ok' | 'unknown' | 'gone'

export function makeSeatGuard(o: SeatGuardOpts): { armed: boolean; check: () => SeatCheck; seen: () => string | null } {
  const need = Math.max(1, o.strikes ?? 2)
  const boot = o.read()
  const armed = boot !== null && passwdName(boot, o.uid) === o.user
  let strikes = 0
  let last: string | null = o.user
  return {
    armed,
    seen: () => last,
    check: () => {
      if (!armed) return 'unknown'
      const text = o.read()
      if (text === null) return 'unknown'
      last = passwdName(text, o.uid)
      if (last === o.user) { strikes = 0; return 'ok' }
      strikes++
      return strikes >= need ? 'gone' : 'unknown'
    },
  }
}
