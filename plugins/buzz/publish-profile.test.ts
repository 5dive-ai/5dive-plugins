// DIVE-3507. Grades the load-bearing safety property of publish-profile.sh:
// the avatar tier is chosen by PROBING the URL the client will fetch, a tier
// that does not answer 200 is SKIPPED rather than published as a dead link,
// and an `accepted:true` write is not believed until the profile reads back.
//
// A skip-on-failure is the shape that passes vacuously, so every assertion here
// is stated in BOTH directions: a probe forced to fail must not publish, and a
// probe forced to succeed must publish exactly the tier that answered.
//
// The script shells out to curl/buzz/sudo, so the harness puts stubs for those
// three ahead of them on PATH. Nothing here touches a relay or a real seat.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'publish-profile.sh')

/**
 * Run publish-profile.sh for one fake seat.
 * @param ok200 URL substrings that the stubbed curl answers 200 for; every
 *              other URL answers 404. This IS the probe mutation surface.
 * @param readBack what the stubbed relay returns as `picture` on read-back:
 *                 'echo' replays whatever was written, 'empty' models the
 *                 accepted-but-not-readable relay this row was filed over.
 */
function run(ok200: string[], readBack: 'echo' | 'empty' = 'echo') {
  const dir = mkdtempSync(join(tmpdir(), 'pp-'))
  const bin = join(dir, 'bin')
  const state = join(dir, 'written')
  const calls = join(dir, 'calls')
  spawnSync('mkdir', ['-p', bin])

  const stub = (name: string, body: string) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(p, 0o755)
  }

  // curl -sSL -o /dev/null -w '%{http_code}' <url>: the last arg is the URL.
  stub(
    'curl',
    `url="\${@: -1}"
for pat in ${ok200.map(s => `'${s}'`).join(' ')}; do
  case "$url" in *"$pat"*) echo 200; exit 0 ;; esac
done
echo 404`,
  )

  // sudo: `cat <cfg>` hands back a fake buzz config; `5dive agent list --json`
  // hands back a roster giving the seat a runtime type for the mark tier.
  stub(
    'sudo',
    `case "$1" in
  cat)    echo '{"relay_url":"wss://relay.invalid","private_key":"deadbeef"}' ;;
  5dive)  echo '{"data":[{"name":"testseat","type":"claude"}]}' ;;
  *)      exec "$@" ;;
esac`,
  )

  // buzz: records every set-profile avatar, answers accepted:true always — the
  // point being that accepted:true alone must not satisfy the script.
  stub(
    'buzz',
    `if [ "$1" = users ] && [ "$2" = get ]; then
  pic=""
  if [ "${readBack}" = echo ] && [ -f "${state}" ]; then pic=$(cat "${state}"); fi
  printf '[{"pubkey":"abc123","display_name":"Testseat","about":"a role","picture":"%s"}]' "$pic"
  exit 0
fi
if [ "$1" = users ] && [ "$2" = set-profile ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --avatar ]; then printf '%s' "$2" > "${state}"; printf '%s\\n' "$2" >> "${calls}"; fi
    shift
  done
  echo '{"accepted":true,"event_id":"e1"}'
  exit 0
fi
echo '{}'`,
  )

  const res = spawnSync('bash', [SCRIPT, 'testseat'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  return {
    code: res.status,
    out: `${res.stdout}${res.stderr}`,
    /** Every avatar URL actually handed to the relay. Empty === nothing published. */
    published: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : [],
  }
}

test('no tier answers 200: the seat is reported FAIL and NOTHING is published', () => {
  const r = run([])
  // The direction that matters. A probe that is ignored, or trusted blindly,
  // publishes a dead link here instead of failing.
  expect(r.published).toEqual([])
  expect(r.out).toContain('FAIL  testseat')
  expect(r.out).toContain('published=0')
  expect(r.code).not.toBe(0)
})

test('only the mark tier answers 200: the mark is what gets published', () => {
  const r = run(['/plugins/buzz/marks/'])
  // Non-vacuity for the test above: the same code path, probe flipped, must
  // publish — and must publish the tier that answered, not the first candidate.
  expect(r.published).toHaveLength(1)
  expect(r.published[0]).toContain('/plugins/buzz/marks/claude.png')
  expect(r.out).toContain('OK    testseat')
  expect(r.out).toContain('published=1')
  expect(r.code).toBe(0)
})

test('when several tiers answer 200 the character pack wins over the mark', () => {
  const r = run(['character-packs', '/plugins/buzz/marks/'])
  expect(r.published).toHaveLength(1)
  expect(r.published[0]).toContain('character-packs')
  expect(r.out).toMatch(/OK {4}testseat.*pack /)
})

test('an accepted write whose profile does not read back is a FAIL, not an OK', () => {
  // The relay behaviour this row was filed over: accepted:true, event id, and
  // an empty read. Publishing must not be reported as success on that.
  const r = run(['character-packs'], 'empty')
  expect(r.published).toHaveLength(1) // the write was attempted and accepted
  expect(r.out).toContain('write accepted but read-back picture is')
  expect(r.out).toContain('failed=1')
  expect(r.code).not.toBe(0)
})
