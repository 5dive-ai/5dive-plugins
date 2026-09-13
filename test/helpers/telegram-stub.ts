#!/usr/bin/env -S bun
// DIVE-4401: a local stand-in for the Telegram Bot API, run as its OWN PROCESS.
//
// Out-of-process is load-bearing: the hook is driven with spawnSync, which
// blocks the test's event loop, so an in-process Bun.serve can never answer the
// hook's fetch — every arm would time out and "prove" nothing about delivery.
//
// Records each sendMessage as one JSON line in $STUB_LOG (first line is
// `{"port":N}` once bound) and answers per $STUB_MODE:
//   ok           — 200 {ok:true} for everything
//   reject-all   — $STUB_STATUS (default 400) + $STUB_DESC for everything
//   reject-first — the first call is rejected, the rest accepted
import { appendFileSync } from 'fs'

const log = process.env.STUB_LOG ?? '/dev/null'
const mode = process.env.STUB_MODE ?? 'ok'
const status = Number(process.env.STUB_STATUS ?? '400')
const desc = process.env.STUB_DESC ?? 'message thread not found'

let n = 0
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = new URLSearchParams(await req.text())
    n++
    appendFileSync(
      log,
      JSON.stringify({
        chatId: body.get('chat_id') ?? '',
        threadId: body.get('message_thread_id') ?? undefined,
        text: body.get('text') ?? '',
      }) + '\n',
    )
    const reject = mode === 'reject-all' || (mode === 'reject-first' && n === 1)
    return reject
      ? new Response(JSON.stringify({ ok: false, error_code: status, description: desc }), { status })
      : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  },
})
appendFileSync(log, JSON.stringify({ port: server.port }) + '\n')
