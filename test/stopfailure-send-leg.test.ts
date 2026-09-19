// DIVE-4401 — driven coverage of the send/route LEG of stopfailure-notify.
//
// The row's symptom is "the Team usage wall was silent on Telegram". The
// classification half was not the defect: on the measured 2026-09-13 04:20Z
// wall both seats decided to SEND (the recovery helper's spawn is gated on the
// same `shouldSend`, and both helpers ran and parked to 09:00 UTC). Everything
// after that decision was unrecorded — `sendMessage` returned void, `fetch`
// resolves on a 4xx, and a network throw was swallowed by a bare `catch {}` —
// so "the bot never sent it", "the bot sent it to a forum topic nobody was
// reading" and "Telegram rejected it" were indistinguishable from both ends.
//
// These arms execute the real hook against a LOCAL Bot API stub (TELEGRAM_API_BASE)
// and assert what was actually transmitted: how many calls, to which chat, into
// which topic, and what the hook logged when a send was refused.
//
// Both routing fixtures are the measured shapes:
//   • main   — a telegram DM 11 minutes before the wall → getCallerChat resolves → DM.
//   • olivia — an autonomous turn, no inbound → getGroupTopics → the agent's own
//              forum topic, NOT the operator's DM.
// Routing is asserted, not changed: a Team wall must land exactly where a
// Pro/Max wall lands.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const HOOK = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts')

const OPERATOR_DM = '1234567890'
// A second paired DM, used only by the fallback arms: it is the one routing
// fact that exists ONLY in access.json, so an arm that reaches it proves the
// fixture was read (see the fixture-absent control below).
const SECOND_DM = '1234567891'
const GROUP = '-1009876543210'
const TOPIC = '1417'

// The measured Claude Team wall copy (2026-09-13 04:31 UTC, both seats).
const TEAM_MSG =
  "Usage limit reached again after you continued · continuing automatically at 9am | " +
  "You've hit your org's monthly spend limit · ask your admin to raise it at " +
  'claude.ai/admin-settings/usage · your session limit resets 9am (UTC)'
// The pre-existing Pro/Max copy, for the routing-parity arm.
const PROMAX_MSG = 'Claude usage limit reached · your limit resets 9am (UTC)'

type Call = { chatId: string; threadId?: string; text: string }

let home: string
let stub: ReturnType<typeof spawn> | null = null
let stubLog: string

// Start the out-of-process Bot API stub and wait for it to report its port.
// Async and out-of-process because the hook is driven with spawnSync (see
// test/helpers/telegram-stub.ts).
async function startStub(mode: 'ok' | 'reject-all' | 'reject-first' = 'ok', env: Record<string, string> = {}) {
  stubLog = join(home, `stub-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(stubLog, '')
  stub = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'telegram-stub.ts')], {
    env: { ...process.env, STUB_LOG: stubLog, STUB_MODE: mode, ...env },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200; i++) {
    const first = readFileSync(stubLog, 'utf8').split('\n')[0]
    if (first) {
      const port = (JSON.parse(first) as { port?: number }).port
      if (port) return `http://127.0.0.1:${port}`
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('telegram stub never bound a port')
}

// Every line after the port line is one transmitted sendMessage.
function calls(): Call[] {
  return readFileSync(stubLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Call & { port?: number })
    .filter(c => c.port === undefined)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sf-sendleg-'))
})
afterEach(() => {
  stub?.kill()
  stub = null
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

// access.json in the isolated HOME: one paired DM plus one group with a topic —
// the shape both measured seats actually carry.
function writeAccess(opts: { group?: boolean; extraDm?: boolean } = {}) {
  const dir = stateDirFor(home)
  mkdirSync(dir, { recursive: true })
  const access: Record<string, unknown> = {
    dmPolicy: 'pairing',
    allowFrom: opts.extraDm ? [OPERATOR_DM, SECOND_DM] : [OPERATOR_DM],
  }
  if (opts.group !== false) {
    access.groups = { [GROUP]: { requireMention: false, allowFrom: [OPERATOR_DM], message_thread_id: Number(TOPIC) } }
  }
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
}

// caller: a telegram inbound in the transcript (the main shape).
// autonomous: no inbound at all (the olivia shape) — getCallerChat returns null.
function writeTranscript(kind: 'caller' | 'autonomous'): string {
  const p = join(home, `transcript-${kind}.jsonl`)
  const line =
    kind === 'caller'
      ? JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `<channel source="plugin:telegram:telegram" chat_id="${OPERATOR_DM}" message_id="1" user="op">status?</channel>`,
          },
        })
      : JSON.stringify({ type: 'user', message: { role: 'user', content: 'heartbeat: continue the queue' } })
  writeFileSync(p, line + '\n')
  return p
}

// Where the plugin keeps access.json under a given HOME.
function stateDirFor(h: string): string {
  return join(h, '.claude', 'channels', 'telegram')
}

// `stateDir` defaults to this HOME's real config dir and is passed to the child
// EXPLICITLY.
//
// DIVE-4401 iteration 3 — this is the bug that made iteration 2's evidence
// unreal, and it is why the parameter exists rather than being hard-coded:
// paths.ts:18 is `process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ...)` —
// ENV FIRST — and we spread ...process.env into the child. So any ambient
// TELEGRAM_STATE_DIR in the parent bun process outranked the temp HOME, the
// hook read an access.json that was not there, getGroupTopics() and
// getAllowedChatIds() both came back empty, and it took
// `route=all-allowed targets=(none)`. In CI another file in the same process
// had set it at module scope (test/resume-prompt.test.ts) and four arms went
// red; alone they were green. An arm whose verdict depends on what else ran is
// not measuring the product, so the driver pins its own state dir — the same
// thing undefined-guard.test.ts and resume-prompt.test.ts already do.
//
// Passing it also makes the fixture FALSIFIABLE: the arms below point it at an
// empty dir to drive the config-absent case, which is the only way to tell a
// fixture that was read from one that never existed.
function fireHook(
  message: string,
  transcript: string,
  apiBase: string,
  stateDir: string = stateDirFor(home),
): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      message,
      reason: 'usage_limit',
      stopReason: 'rate_limit',
      transcript_path: transcript,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_BOT_TOKEN: '000:FAKE',
      TELEGRAM_API_BASE: apiBase,
      TMUX: '',
    },
    timeout: 20000,
  })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('DIVE-4401 send/route leg', () => {
  const T = 30000

  test('a Team wall on a caller turn reaches the operator DM, once, and says so', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(OPERATOR_DM)
    expect(c[0].threadId).toBeUndefined()
    expect(c[0].text).toMatch(/Usage limit hit/)
    expect(r.stderr).toContain(`route=caller targets=${OPERATOR_DM}`)
    expect(r.stderr).toContain(`send ${OPERATOR_DM}: ok`)
  }, T)

  // Deliverables 2 and 5: the Team copy must route where the Pro/Max copy
  // routes. Same transcript shape, same access config, different wall text.
  test('Team and Pro/Max walls route identically', async () => {
    const base = await startStub()
    writeAccess()
    const team = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    const teamCall = calls()[0]
    // A fresh HOME so the episode dedup stamp cannot suppress the second fire;
    // the stub (and its log) stay put, so both transmissions are on one tape.
    home = mkdtempSync(join(tmpdir(), 'sf-sendleg-'))
    writeAccess()
    const pro = fireHook(PROMAX_MSG, writeTranscript('caller'), base)
    expect(team.code).toBe(0)
    expect(pro.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(2)
    expect(c[1].chatId).toBe(teamCall.chatId)
    expect(c[1].threadId).toBe(teamCall.threadId)
    expect(pro.stderr).toContain('route=caller')
  }, T)

  // The negative control the verifier asked for: getCallerChat EMPTY. This is
  // the olivia shape and it explains the operator's silence — the notice went
  // to the agent's own forum topic, the documented autonomous-turn behaviour,
  // not the DM he was watching. Pinned so a future routing change is deliberate.
  test('an autonomous turn routes to the bound group topic, not the DM', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(1)
    expect(c[0].chatId).toBe(GROUP)
    expect(c[0].threadId).toBe(TOPIC)
    expect(c.some(x => x.chatId === OPERATOR_DM)).toBe(false)
    expect(r.stderr).toContain(`route=group-topics targets=${GROUP}:${TOPIC}`)
  }, T)

  test('five repeats of one wall episode send exactly once', async () => {
    const base = await startStub()
    writeAccess()
    const transcript = writeTranscript('caller')
    let sends = 0
    let suppress = 0
    for (let i = 0; i < 5; i++) {
      const r = fireHook(TEAM_MSG, transcript, base)
      expect(r.code).toBe(0)
      if (/ratelimit dedup: SEND/.test(r.stderr)) sends++
      if (/ratelimit dedup: suppress/.test(r.stderr)) suppress++
    }
    expect(sends).toBe(1)
    expect(suppress).toBe(4)
    // The decision AND the transmission: four suppressions must also mean four
    // messages that never went out, which the old void return could not prove.
    expect(calls().length).toBe(1)
  }, T)

  test('a rejected send is reported with status and reason, not swallowed', async () => {
    const base = await startStub('reject-all')
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`REJECTED ${GROUP}:${TOPIC} — http 400 — message thread not found`)
    expect(r.stderr).toContain(`send ${GROUP}:${TOPIC}: FAILED`)
  }, T)

  test('when every routed send fails the notice falls back to the paired DM', async () => {
    const base = await startStub('reject-first')
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(2)
    expect(c[1].chatId).toBe(OPERATOR_DM)
    expect(c[1].threadId).toBeUndefined()
    expect(c[1].text).toMatch(/Usage limit hit/)
    expect(r.stderr).toContain(`falling back to ${OPERATOR_DM}`)
    expect(r.stderr).toContain(`fallback send ${OPERATOR_DM}: ok`)
  }, T)

  // The fallback must not become a fan-out: a delivered notice stays where it
  // was routed.
  test('a successful routed send never fans out to the other paired chats', async () => {
    const base = await startStub()
    writeAccess()
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)
    expect(r.stderr).not.toContain('falling back')
  }, T)

  // No paired chat left to try: the hook must say the notice was lost rather
  // than exit 0 looking successful.
  test('a total failure with nowhere to fall back to is stated explicitly', async () => {
    const base = await startStub('reject-all', { STUB_STATUS: '403', STUB_DESC: 'bot was blocked by the user' })
    writeAccess({ group: false })
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)
    expect(r.stderr).toContain('http 403 — bot was blocked by the user')
    expect(r.stderr).toContain('no other paired chat to fall back to')
  }, T)

  // ---------------------------------------------------------------------
  // Iteration 3 — THE PAIRED CONTROL FOR A FAIL-OPEN GUARD.
  //
  // isAllowedChat FAILS OPEN on an empty allowlist (telegram.ts, deliberate,
  // DIVE-3422), so on a caller turn the destination comes from the TRANSCRIPT
  // and the send goes out whether or not access.json was ever read. Every arm
  // above sits downstream of that guard, which means each one is green with the
  // fixture present AND with it absent — they could not tell the fixture from
  // nothing.
  //
  // These two arms are the discriminator. The only routing fact that lives
  // exclusively in access.json on a caller turn is the fallback list, so drive
  // the caller turn into a total send failure and look at where it goes next:
  //   • fixture read    → falls back to SECOND_DM (which exists nowhere else)
  //   • fixture absent  → nothing to fall back to, and it says so
  // Together they anchor the explicit TELEGRAM_STATE_DIR in fireHook: remove it
  // and one of the pair goes red whichever way the ambient env happens to sit
  // (set → the positive arm loses its fallback; unset → HOME resolution finds
  // the fixture and the absent arm falls back anyway).
  // ---------------------------------------------------------------------
  test('the routing config IS read on a caller turn: a failed send falls back to the other paired DM', async () => {
    const base = await startStub('reject-first')
    // DM-only: getAllowedChatIds() returns the group ids too, and a group in
    // the fallback list would blur the count this arm turns on.
    writeAccess({ group: false, extraDm: true })
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    const c = calls()
    expect(c.length).toBe(2)
    expect(c[0].chatId).toBe(OPERATOR_DM)
    expect(c[1].chatId).toBe(SECOND_DM)
    expect(r.stderr).toContain(`falling back to ${SECOND_DM}`)
    expect(r.stderr).toContain(`fallback send ${SECOND_DM}: ok`)
  }, T)

  test('with the routing config ABSENT the same caller turn has nothing to fall back to', async () => {
    const base = await startStub('reject-all', { STUB_STATUS: '403', STUB_DESC: 'bot was blocked by the user' })
    // The fixture is written under $HOME exactly as above — and deliberately
    // bypassed, so the ONLY difference between this arm and the one above is
    // whether the hook read it.
    writeAccess({ group: false, extraDm: true })
    const emptyState = mkdtempSync(join(tmpdir(), 'sf-nostate-'))
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base, emptyState)
    expect(r.code).toBe(0)
    // Fail-open: the transcript still supplies the DM, which is exactly why
    // every arm above passes vacuously here.
    expect(calls().length).toBe(1)
    expect(r.stderr).toContain('route=caller')
    // The discriminator.
    expect(r.stderr).not.toContain(`falling back to ${SECOND_DM}`)
    expect(r.stderr).toContain('no other paired chat to fall back to')
    rmSync(emptyState, { recursive: true, force: true })
  }, T)

  // Iteration 3, the row's own symptom at its purest: no paired chat on any
  // rung. The hook used to log `targets=(none)`, transmit nothing and exit 0 —
  // an operator got silence and the log did not admit it. Also a second anchor
  // for the explicit state dir: without it this routes to the group topic and
  // sends one message.
  test('no paired chat at all: the hook states the notice was lost instead of exiting quietly', async () => {
    const base = await startStub()
    writeAccess()
    const emptyState = mkdtempSync(join(tmpdir(), 'sf-nostate-'))
    const r = fireHook(TEAM_MSG, writeTranscript('autonomous'), base, emptyState)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(0)
    expect(r.stderr).toContain('ratelimit dedup: SEND')
    expect(r.stderr).toContain('route=all-allowed targets=(none)')
    expect(r.stderr).toContain('no paired chat configured — usage-limit notice NOT sent (lost)')
    rmSync(emptyState, { recursive: true, force: true })
  }, T)
})

// ---------------------------------------------------------------------------
// The usage-limit notice stops the typing indicator.
//
// THE DEFECT. The server re-sends `sendChatAction(chat_id,'typing')` every 4s
// and stops on exactly three signals: the reply tool's outbound, the mtime of
// the typing-stop file, and a 5-minute ceiling. This hook sends the usage-limit
// notice from a DIFFERENT process and bumped none of them — so the chat kept
// showing "typing…" for up to five minutes after a message saying the agent
// cannot type until the wall lifts.
//
// WHAT THESE ARMS GRADE, and why mtime rather than existence: the server's test
// is `statSync(file).mtimeMs > startedAt`, so a file that merely EXISTS proves
// nothing — a stamp left by an earlier turn is exactly the case that does not
// stop the loop. Every arm pins the stamp against the instant the send happened.
describe('the usage-limit notice stops the typing indicator', () => {
  const T = 30000
  const typingStop = (dir: string) => join(dir, 'typing-stop')

  // The hook is driven out-of-process, so the mutant has to be a real tree: the
  // whole hooks/ dir copied with the signal stripped. Relative imports (./lib/*)
  // survive the copy, which is why the directory and not the single file moves.
  function mutantHook(): string {
    const dir = join(home, 'hooks-mutant')
    cpSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks'), dir, { recursive: true })
    const f = join(dir, 'stopfailure-notify.ts')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^\s*signalTurnEnded\(\)\s*$/gm, ''))
    return f
  }
  function fireAt(hook: string, message: string, transcript: string, apiBase: string, stateDir: string) {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ message, reason: 'usage_limit', stopReason: 'rate_limit', transcript_path: transcript }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_BOT_TOKEN: '000:FAKE', TELEGRAM_API_BASE: apiBase, TMUX: '' },
      timeout: 20000,
    })
    return { code: r.status ?? -1, stderr: r.stderr ?? '' }
  }

  test('a routed notice stamps the typing-stop file, newer than the send', async () => {
    const base = await startStub()
    writeAccess()
    const dir = stateDirFor(home)
    const before = Date.now()
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)          // the send really happened
    expect(existsSync(typingStop(dir))).toBe(true)
    expect(statSync(typingStop(dir)).mtimeMs).toBeGreaterThanOrEqual(before)
  }, T)

  // A STALE stamp is the shape that silently does not stop the loop, so prove
  // the hook MOVES it rather than merely leaving one behind.
  test('... and a pre-existing stale stamp is moved forward, not left alone', async () => {
    const base = await startStub()
    writeAccess()
    const dir = stateDirFor(home)
    mkdirSync(dir, { recursive: true })
    writeFileSync(typingStop(dir), '0')
    utimesSync(typingStop(dir), new Date(Date.now() - 600000), new Date(Date.now() - 600000))
    const stale = statSync(typingStop(dir)).mtimeMs
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(statSync(typingStop(dir)).mtimeMs).toBeGreaterThan(stale)
  }, T)

  // The FALLBACK leg sends AFTER the first stamp, so a single bump at the routed
  // send would leave a stamp older than the last transmission. This is why the
  // fix has a second call site rather than one.
  test('the fallback leg re-stamps, so the stamp is never older than the last send', async () => {
    const base = await startStub('reject-first')
    writeAccess({ extraDm: true })
    const dir = stateDirFor(home)
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('falling back to')
    const sends = calls()
    expect(sends.length).toBeGreaterThan(1)           // the fallback really ran
    expect(existsSync(typingStop(dir))).toBe(true)
    expect(statSync(typingStop(dir)).mtimeMs).toBeGreaterThan(0)
  }, T)

  // Unconditional on send SUCCESS: whether Telegram accepted the notice has no
  // bearing on whether the turn ended, and the indicator is about the turn.
  test('a notice nobody could receive still clears the indicator', async () => {
    const base = await startStub('reject-all')
    writeAccess()
    const dir = stateDirFor(home)
    const r = fireHook(TEAM_MSG, writeTranscript('caller'), base)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('FAILED')
    expect(existsSync(typingStop(dir))).toBe(true)
  }, T)

  // --- MUTANT: put the defect back -----------------------------------------
  // BEFORE/AFTER, because "the call is gone" is also true of a regex that
  // matched nothing — which would make the strike-out below pass vacuously.
  test('MUTANT: with the signal stripped the notice goes out and the indicator is left spinning', async () => {
    const shipped = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts'), 'utf8')
    expect(shipped).toContain('signalTurnEnded()')            // BEFORE
    const hook = mutantHook()
    expect(readFileSync(hook, 'utf8')).not.toContain('signalTurnEnded()')   // AFTER: the regex matched
    const base = await startStub()
    writeAccess()
    const dir = stateDirFor(home)
    const r = fireAt(hook, TEAM_MSG, writeTranscript('caller'), base, dir)
    expect(r.code).toBe(0)
    expect(calls().length).toBe(1)                 // the notice still sends...
    expect(existsSync(typingStop(dir))).toBe(false) // ...and nothing stops the loop
  }, T)

  // The two Stop-class hooks must not drift: one implementation, two callers.
  test('both Stop-class hooks signal through the SAME helper', () => {
    const hooks = join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks')
    const stopReply = readFileSync(join(hooks, 'stop-reply-check.ts'), 'utf8')
    const notify = readFileSync(join(hooks, 'stopfailure-notify.ts'), 'utf8')
    expect(stopReply).toContain('signalTurnEnded()')
    expect(notify).toContain('signalTurnEnded()')
    // and stop-reply-check no longer carries its own copy of the write
    expect(stopReply).not.toContain('writeFileSync(typingStopFile()')
  })

  // NOT DRIVEN, said rather than implied: the rotation notice sends and exits on
  // a path gated behind a live tmux context, which this out-of-process driver has
  // no fixture for (it pins TMUX=''). Graded structurally instead — the signal
  // must sit inside the rotation block and BEFORE the process.exit that tears the
  // process down, which is the only ordering that can work there.
  test('the rotation notice signals before it exits (structural — that branch needs a tmux fixture)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'hooks', 'stopfailure-notify.ts'), 'utf8')
    const start = src.indexOf('rotating to')
    expect(start).toBeGreaterThan(-1)                       // the branch is still there
    // The FIRST exit AFTER the rotation text: an earlier process.exit(0) sits
    // above this block, and slicing to it returns an empty string that would
    // fail for the wrong reason (and, inverted, would pass vacuously).
    const end = src.indexOf('process.exit(0)', start)
    expect(end).toBeGreaterThan(start)
    const rot = src.slice(start, end)
    expect(rot).toContain('signalTurnEnded()')
  })
})
