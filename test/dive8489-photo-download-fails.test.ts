// DIVE-8489 (box report 994): a photo whose download failed reached the agent as
// a bare "(photo)" with no image_path and no file id, so it was lost silently.
// fetchPhoto now returns the photo as an attachment (file id + reason) on any
// failure; handleInbound turns that into attachment_file_id + attachment_error.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fetchPhoto, photoErrorText, type PhotoDeps } from '../plugins/telegram/photofetch'

const TOKEN = '123456:SECRET-token_value'
const best = { file_id: 'FILE-ID-1', file_unique_id: 'U1', file_size: 4242 }

function deps(over: Partial<PhotoDeps> = {}): PhotoDeps & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    getFile: async () => ({ file_path: 'photos/file_7.jpg' }),
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) }),
    token: TOKEN,
    inboxDir: '/inbox',
    mkdir: () => {},
    write: (p) => { writes.push(p) },
    now: () => 1000,
    ...over,
  }
}

function expectAttachment(got: Awaited<ReturnType<typeof fetchPhoto>>, reason: string) {
  expect('path' in got).toBe(false)
  if (!('error' in got)) throw new Error('expected a failure')
  expect(got.attachment).toEqual({ kind: 'photo', file_id: 'FILE-ID-1', size: 4242 })
  expect(got.error.startsWith('photo download failed: ')).toBe(true)
  expect(got.error).toContain(reason)
}

describe('DIVE-8489 a photo whose download fails still reaches the agent', () => {
  test('happy path: a saved file, image_path only (no attachment)', async () => {
    const d = deps()
    const got = await fetchPhoto(best, d)
    expect(got).toEqual({ path: '/inbox/1000-U1.jpg' })
    expect(d.writes).toEqual(['/inbox/1000-U1.jpg'])
  })

  test('getFile throws → attachment with the file id and the reason', async () => {
    const got = await fetchPhoto(best, deps({ getFile: async () => { throw new Error('Network request for getFile failed') } }))
    expectAttachment(got, 'Network request for getFile failed')
  })

  test('getFile gives no file path → attachment, not a silent undefined', async () => {
    expectAttachment(await fetchPhoto(best, deps({ getFile: async () => ({}) })), 'no file path')
  })

  test('the write throws (disk full / unwritable inbox) → attachment', async () => {
    const d = deps({ write: () => { throw new Error('ENOSPC: no space left on device') } })
    expectAttachment(await fetchPhoto(best, d), 'ENOSPC')
  })

  test('a non-200 download is a failure, never saved as a .jpg', async () => {
    const d = deps({ fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(9) }) })
    expectAttachment(await fetchPhoto(best, d), 'HTTP 404')
    expect(d.writes).toEqual([])
  })

  test('the reason never carries the bot token, even when cut short', async () => {
    const url = `https://api.telegram.org/file/bot${TOKEN}/photos/file_7.jpg`
    const got = await fetchPhoto(best, deps({ fetch: async () => { throw new Error(`fetch failed for ${url} ${'x'.repeat(200)}`) } }))
    if (!('error' in got)) throw new Error('expected a failure')
    expect(got.error).not.toContain('SECRET')
    expect(got.error).not.toContain('123456')
  })

  test('the reason is one short meta-safe line', () => {
    const t = photoErrorText(new Error('a\nb<c>"d";[e]' + 'z'.repeat(500)))
    expect(t).not.toMatch(/[\n<>"\[\];]/)
    expect(t.length).toBeLessThanOrEqual('photo download failed: '.length + 120)
  })
})

describe('DIVE-8489 server.ts wiring', () => {
  const server = readFileSync(join(import.meta.dir, '..', 'plugins', 'telegram', 'server.ts'), 'utf8')
  test('the photo handler uses fetchPhoto', () => {
    const handler = server.slice(server.indexOf("bot.on('message:photo'"), server.indexOf("bot.on('message:document'"))
    expect(handler).toContain('fetchPhoto(best,')
  })
  test('a failed photo becomes the attachment, and the reason rides in meta, not content', () => {
    expect(server).toContain("if (photo && 'error' in photo) attachment ??= photo.attachment")
    expect(server).toContain('...(attachmentError ? { attachment_error: attachmentError } : {}),')
    expect(server).not.toMatch(/content[^\n]*attachmentError/)
  })
})
