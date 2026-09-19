#!/usr/bin/env bash
# DIVE-4397 — the telegram plugin's 5dive reads must not spawn sudo on a scoped seat.
#
# WHAT THIS SUITE IS ARRANGED AROUND. The defect was not "a call failed" — the
# call failing was harmless. The defect was that a DENIED call was repeated once
# a minute forever, and sudo mails root on each one: 83,898 messages / 66 MB on
# a customer's disk across 15 releases. So a test that only proved "the reader
# still returns JSON" would grade none of it. Every arm below is a MUTANT of the
# specific behaviour that generated that mail:
#
#   T1 unprivileged-first  -> a seat where the bare binary works must spawn sudo
#                             ZERO times. The mutant is sudo-first (today's ship).
#   T3 the sticky latch    -> after ONE denial, 20 further reads spawn sudo zero
#                             more times. This is the arm that is literally the
#                             83,898. The mutant is a runner that retries.
#   T5 latch only on sudo  -> a non-zero exit from 5dive ITSELF must NOT latch.
#      refusals               The mutant is an over-eager latch, which would
#                             silently strip root from admin seats that need it.
#   T7 the sudoers word    -> sudo is still handed the bare word `5dive`. The
#                             mutant is the "tidier" absolute path, which turns
#                             every existing NOPASSWD rule on a shipped box into
#                             a denial — i.e. it would CAUSE this bug at scale.
#
# Driven against the real plugins/telegram/cliexec.ts through bun, with exec and
# clock injected. No sudo, no 5dive and no Telegram are touched.
set -uo pipefail
trap 'rc=$?; rm -rf "${TMP:-}"; echo "HARNESS-RC=$rc"' EXIT
cd "$(dirname "$0")/.."
ROOT="$PWD"
printf 'grading tree: %s @ %s\n' "$PWD" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >&2

PASS=0; FAIL=0
t()  { if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected: %s\n   got:      %s\n' "$1" "$2" "$3"; fi; }
tc() { if [[ "$3" == *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }
tn() { if [[ "$3" != *"$2"* ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL: %s\n   expected NOT to contain: %s\n   got: %s\n' "$1" "$2" "$3"; fi; }

TMP="$(mktemp -d)"

# ---------------------------------------------------------------- driver ----
cat > "$TMP/drive.ts" <<'TSEOF'
import { createFiveRunner, createFailureBreaker, isSudoDenial } from '__CLIEXEC__'

const out: string[] = []
const say = (k: string, v: unknown) => out.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)

type Call = { file: string; args: string[] }
function mk(handler: (c: Call) => Promise<{ stdout: string; stderr: string }>) {
  const calls: Call[] = []
  const denials: string[] = []
  const runner = createFiveRunner({
    execFile: async (file, args) => { calls.push({ file, args }); return handler({ file, args }) },
    sudoBin: '/usr/bin/sudo',
    fiveBin: '/usr/local/bin/5dive',
    onSudoDenied: (args, stderr) => denials.push(`${args.join(' ')}|${stderr}`),
  })
  return { runner, calls, denials, sudoCalls: () => calls.filter((c) => c.file === '/usr/bin/sudo') }
}
const fail = (stderr: string, stdout = '') => { const e: any = new Error('Command failed'); e.stderr = stderr; e.stdout = stdout; throw e }
const DENIAL = 'sudo: a password is required'
const NOTALLOWED = "Sorry, user agent-anton is not allowed to execute '/usr/local/bin/5dive task inbox --json' as root on box-cx43."
const accept = (s: string) => { try { const j = JSON.parse(s); return !(j && j.ok === false) } catch { return false } }

// T1 — scoped seat, bare binary works: sudo must never be spawned.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? { stdout: '{"ok":true,"data":{"inbox":[]}}', stderr: '' } : fail(NOTALLOWED)))
  const r = await h.runner.run(['task', 'inbox', '--json'], {}, accept)
  say('T1_ok', r.ok); say('T1_via', r.via); say('T1_sudo_spawns', h.sudoCalls().length)
  say('T1_plain_file', h.calls[0]!.file); say('T1_plain_args', h.calls[0]!.args.join(' '))
}

// T2 — bare binary missing for this uid: sudo is the fallback and still works.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('ENOENT') : { stdout: '{"ok":true,"data":1}', stderr: '' }))
  const r = await h.runner.run(['agent', 'list', '--json'], {}, accept)
  say('T2_ok', r.ok); say('T2_via', r.via); say('T2_sudo_spawns', h.sudoCalls().length); say('T2_denied', h.runner.sudoDenied())
}

// T3 — THE ROW. One denial, then 20 more timer ticks: sudo spawns exactly once.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('ENOENT') : fail(NOTALLOWED)))
  for (let i = 0; i < 21; i++) await h.runner.run(['task', 'coordinator', '--json'], {}, accept)
  say('T3_sudo_spawns', h.sudoCalls().length)
  say('T3_plain_spawns', h.calls.filter((c) => c.file === '/usr/local/bin/5dive').length)
  say('T3_denied', h.runner.sudoDenied())
  say('T3_denial_notices', h.denials.length)
  say('T3_notice', h.denials[0] ?? '')
}

// T3b — the same, for the `a password is required` shape.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('ENOENT') : fail(DENIAL)))
  for (let i = 0; i < 10; i++) await h.runner.run(['task', 'inbox', '--json'], {}, accept)
  say('T3b_sudo_spawns', h.sudoCalls().length)
}

// T4 — bare binary runs but the CLI says ok:false: escalate to sudo, take its answer.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? { stdout: '{"ok":false,"error":"permission"}', stderr: '' } : { stdout: '{"ok":true,"data":"root"}', stderr: '' }))
  const r = await h.runner.run(['usage', '--json'], {}, accept)
  say('T4_via', r.via); say('T4_stdout', r.stdout); say('T4_sudo_spawns', h.sudoCalls().length)
}

// T5 — 5dive itself exits non-zero under sudo. The GRANT is fine: must not latch.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('ENOENT') : fail('5dive: no such task')))
  await h.runner.run(['task', 'show', '9', '--json'], {}, accept)
  await h.runner.run(['task', 'show', '9', '--json'], {}, accept)
  say('T5_denied', h.runner.sudoDenied()); say('T5_sudo_spawns', h.sudoCalls().length)
}

// T6 — DIVE-125 salvage: a complete envelope on a non-zero exit is still returned.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('boom') : fail('warn', '{"ok":true,"data":"salvaged"}')))
  const r = await h.runner.run(['digest', 'status', '--json'], {}, accept)
  say('T6_stdout', r.stdout)
}

// T7 — sudo is handed the BARE WORD 5dive, not the absolute path: existing
// sudoers rules on shipped boxes match the command as written today.
{
  const h = mk(async (c) => (c.file === '/usr/local/bin/5dive' ? fail('ENOENT') : { stdout: '{"ok":true}', stderr: '' }))
  await h.runner.run(['org', 'tree', '--json'], {}, accept)
  say('T7_sudo_args', h.sudoCalls()[0]!.args.join(' '))
}

// T8 — denial classifier: sudo refusals latch, product errors do not.
say('T8_notallowed', isSudoDenial({ stderr: NOTALLOWED }))
say('T8_password', isSudoDenial({ stderr: DENIAL }))
say('T8_notsudoers', isSudoDenial({ stderr: 'agent-x is not in the sudoers file.  This incident will be reported.' }))
say('T8_product', isSudoDenial({ stderr: '5dive: unknown subcommand' }))
say('T8_enoent', isSudoDenial({ message: "spawn 5dive ENOENT" }))

// T9 — the failure breaker: silent under threshold, one line at it, hourly, resets.
{
  const lines: string[] = []
  let now = 0
  const b = createFailureBreaker({ threshold: 5, intervalMs: 3_600_000, now: () => now, log: (m) => lines.push(m), label: '5dive-read' })
  for (let i = 0; i < 4; i++) b.fail('x')
  say('T9_under', lines.length)
  b.fail('task inbox --json')
  say('T9_at', lines.length); say('T9_line', lines[0] ?? '')
  for (let i = 0; i < 50; i++) b.fail('x')
  say('T9_ratelimited', lines.length)
  now = 3_600_001
  b.fail('x')
  say('T9_after_hour', lines.length)
  b.ok()
  say('T9_streak_reset', b.streak())
  for (let i = 0; i < 5; i++) b.fail('y')
  say('T9_fresh_outage_loud', lines.length)
}

console.log(out.join('\n'))
TSEOF
sed -i "s#__CLIEXEC__#$ROOT/plugins/telegram/cliexec.ts#" "$TMP/drive.ts"

O="$(cd "$ROOT" && bun "$TMP/drive.ts" 2>&1)"
g() { printf '%s\n' "$O" | grep -m1 "^$1=" | cut -d= -f2-; }

t  'T1 unprivileged-first succeeds'              'true'  "$(g T1_ok)"
t  'T1 answer came from the bare binary'         'plain' "$(g T1_via)"
t  'T1 SUDO IS NEVER SPAWNED on a working seat'  '0'     "$(g T1_sudo_spawns)"
t  'T1 first spawn is the bare binary'           '/usr/local/bin/5dive' "$(g T1_plain_file)"
t  'T1 args reach it unchanged'                  'task inbox --json'    "$(g T1_plain_args)"

t  'T2 falls back to sudo when bare binary fails' 'true' "$(g T2_ok)"
t  'T2 answer came from sudo'                     'sudo' "$(g T2_via)"
t  'T2 sudo spawned once'                         '1'    "$(g T2_sudo_spawns)"
t  'T2 a WORKING sudo does not latch'             'false' "$(g T2_denied)"

t  'T3 21 ticks after a denial spawn sudo ONCE'   '1'  "$(g T3_sudo_spawns)"
t  'T3 the unprivileged attempt still runs each tick' '21' "$(g T3_plain_spawns)"
t  'T3 latch is set'                              'true' "$(g T3_denied)"
t  'T3 the denial is surfaced exactly once'       '1'  "$(g T3_denial_notices)"
tc 'T3 the notice names the command'              'task coordinator --json' "$(g T3_notice)"
t  'T3b password-required shape latches too'      '1'  "$(g T3b_sudo_spawns)"

t  'T4 ok:false escalates to sudo'                'sudo' "$(g T4_via)"
tc 'T4 sudo answer is the one returned'           '"data":"root"' "$(g T4_stdout)"
t  'T4 sudo spawned once'                         '1'  "$(g T4_sudo_spawns)"

t  'T5 a 5dive product error does NOT latch'      'false' "$(g T5_denied)"
t  'T5 so sudo is still tried on the next call'   '2'  "$(g T5_sudo_spawns)"

tc 'T6 DIVE-125 salvage survives'                 'salvaged' "$(g T6_stdout)"

t  'T7 sudo still gets the bare word 5dive'       '-n 5dive org tree --json' "$(g T7_sudo_args)"
tn 'T7 sudo does NOT get an absolute path'        '/usr/local/bin/5dive'     "$(g T7_sudo_args)"

t  'T8 not-allowed is a denial'                   'true'  "$(g T8_notallowed)"
t  'T8 password-required is a denial'             'true'  "$(g T8_password)"
t  'T8 not-in-sudoers is a denial'                'true'  "$(g T8_notsudoers)"
t  'T8 a 5dive usage error is NOT a denial'       'false' "$(g T8_product)"
t  'T8 ENOENT is NOT a denial'                    'false' "$(g T8_enoent)"

t  'T9 silent under threshold'                    '0' "$(g T9_under)"
t  'T9 one line at threshold'                     '1' "$(g T9_at)"
tc 'T9 the line names the last command'           'task inbox --json' "$(g T9_line)"
t  'T9 rate-limited to one an hour'               '1' "$(g T9_ratelimited)"
t  'T9 speaks again after the hour'               '2' "$(g T9_after_hour)"
t  'T9 success resets the streak'                 '0' "$(g T9_streak_reset)"
t  'T9 a fresh outage is loud on its first streak' '3' "$(g T9_fresh_outage_loud)"

# --- T10: the product itself, not just the module ---------------------------
S="$ROOT/plugins/telegram/server.ts"
tn 'T10 no unconditional sudo on the 60s inbox read'       "execFileP(SUDO, ['-n', '5dive', 'task', 'inbox'" "$(cat "$S")"
tn 'T10 no unconditional sudo on the task-ls read'         "execFileP(SUDO, ['-n', '5dive', 'task', 'ls'"    "$(cat "$S")"
tn 'T10 no unconditional sudo on the heartbeat read'       "execFileP(SUDO, ['-n', '5dive', 'heartbeat', 'ls'" "$(cat "$S")"
tn 'T10 no unconditional sudo on the org-tree read'        "execFileP(SUDO, ['-n', '5dive', 'org', 'tree'"   "$(cat "$S")"
tc 'T10 the shared reader routes through the runner'       'fiveRunner().run(args' "$(cat "$S")"
TNA_ADAPTER=$(sed -n '/const tnaM = TNA_RE.exec(data)/,/const info = describeTapError(err)/p' "$S")
tn 'T10 gate tap does not sudo the broad task surface'      "execFileP(SUDO, ['-n', '5dive', '--json', 'task', 'answer'" "$TNA_ADAPTER"
tn 'T10 inbox clear does not sudo the broad task surface'   "['-n', '5dive', 'task', 'clear-recs'" "$(cat "$S")"
tc 'T10 gate tap carries paired-human channel proof'        'extraArgs.push(`--channel-proof=${senderId}`)' "$(cat "$S")"
tc 'T10 mutating taps use the narrow write helper'          'await write5diveJson(' "$(cat "$S")"
tc 'T10 write helper accepts refusal envelopes in place'    'const acceptEnvelope = (stdout: string)' "$(cat "$S")"

# --- T11: the FIVE FORKS carry the same 60s banner timer and the same reader ---
# telegram-{grok,codex,agy,pi,opencode} each poll `task coordinator` / `task
# inbox` every 60s through their own run5dive. They ship to the same customers,
# so a fix that stopped at plugins/telegram would have left the mail stream
# running in five of the six shipped telegram plugins.
for FORK in telegram-grok telegram-codex telegram-agy telegram-pi telegram-opencode; do
  F="$ROOT/plugins/$FORK/server.ts"
  SRC="$(cat "$F")"
  # the exact shipped shape: run5dive's ONE unconditional sudo spawn. The
  # replacement helper legitimately still contains a `sudo` spawn (the fallback),
  # so the arm must name the unconditional call, not the word sudo.
  tn "T11 $FORK: run5dive no longer spawns sudo unconditionally" \
     "require('child_process').execFile('sudo', ['-n', '5dive', ...args], { timeout }," "$SRC"
  tc "T11 $FORK: its reads go through the unprivileged-first helper" \
     'exec5dive(args, timeout,' "$SRC"
  tc "T11 $FORK: it tries the bare binary first"       "cp.execFile('5dive', args, opts" "$SRC"
  tc "T11 $FORK: sudo is still handed the bare word"   "['-n', '5dive', ...args]" "$SRC"
  tc "T11 $FORK: the denial is sticky for the process" 'SUDO_DENIED_5DIVE = true' "$SRC"
  tc "T11 $FORK: and it is said out loud once"         '[5dive] sudo refused this seat' "$SRC"
  tn "T11 $FORK: the /status version read needs no root" \
     "execText('sudo', ['-n', '5dive', '--version'])" "$SRC"
  # the reason this is worth a test and not a comment: every fork still has a
  # 60s timer on that reader, which is the thing that multiplied one denial into
  # 83,898 of them.
  tc "T11 $FORK: still on the 60s banner timer (so the fix must hold)" \
     'reconcileNeedsBanner(), 60_000' "$SRC"
done

printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
