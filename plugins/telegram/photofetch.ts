// DIVE-8489 (box report 994): a photo whose download failed reached the agent
// as a bare "(photo)" — no image_path, and no file id to retry with, so the
// owner's photo was lost and nobody was told. Now a failure still hands the
// agent the photo as an attachment (file id + a short reason in meta), so it can
// call download_attachment, which retries getFile and surfaces the real error.

export type PhotoSize = { file_id: string; file_unique_id: string; file_size?: number }

export type PhotoAttachment = { kind: 'photo'; file_id: string; size?: number }

export type PhotoFetched =
  | { path: string }
  | { error: string; attachment: PhotoAttachment }

export type PhotoDeps = {
  getFile: (fileId: string) => Promise<{ file_path?: string }>
  fetch: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>
  token: string
  inboxDir: string
  mkdir: (dir: string) => void
  write: (path: string, buf: Buffer) => void
  now?: () => number
}

const ERROR_MAX = 120

// The reason rides in meta (never content: content is forgeable by the sender),
// so it is flattened to one short line with no tag delimiters.
// A fetch error can carry the download URL, which holds the bot token: it is
// cut out before anything is trimmed, so a half token never leaks either.
export function photoErrorText(err: unknown, token?: string): string {
  let raw = err instanceof Error ? err.message : String(err)
  if (token) raw = raw.split(token).join('<token>')
  const flat = raw.replace(/[<>\[\]\r\n;"]/g, ' ').replace(/\s+/g, ' ').trim()
  return `photo download failed: ${flat.slice(0, ERROR_MAX)}`
}

export async function fetchPhoto(best: PhotoSize, deps: PhotoDeps): Promise<PhotoFetched> {
  try {
    const file = await deps.getFile(best.file_id)
    if (!file.file_path) throw new Error('Telegram returned no file path')
    const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`
    const res = await deps.fetch(url)
    // A non-200 body (an error page) is a failure, never a .jpg.
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = file.file_path.split('.').pop() || 'jpg'
    const path = `${deps.inboxDir}/${(deps.now ?? Date.now)()}-${best.file_unique_id}.${ext}`
    deps.mkdir(deps.inboxDir)
    deps.write(path, buf)
    return { path }
  } catch (err) {
    const error = photoErrorText(err, deps.token)
    return {
      error,
      attachment: {
        kind: 'photo',
        file_id: best.file_id,
        ...(best.file_size != null ? { size: best.file_size } : {}),
      },
    }
  }
}
