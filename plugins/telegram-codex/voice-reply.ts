// DIVE-6579: a Codex dispatcher seat answers a voice note by voice.
//
// The model on a dispatcher seat never sees a reply tool: the dispatcher takes
// its final text and writes it to the outbox. So a voice note was answered in
// text only, unless the model happened to run 5dive-speak and attach the OGG.
// The bridge marks a voice note's route `voice: true`, the dispatcher echoes
// the route on every outbox file, and the bridge speaks the answer itself:
// the text first, then the note. Text in, text out.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { promisify } from 'node:util'

const VOICE_FILE_EXTS = new Set(['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.wav'])

/**
 * An outbox reply the bridge voices: its route came from a voice note (or a
 * harness set `voice: true`), it is the turn's answer (never commentary sent
 * silently, an error or a control line), and it carries no voice note already.
 */
export function voicesReply(obj: { voice?: unknown; kind?: unknown; notify?: unknown }, files: string[]): boolean {
  if (obj.voice !== true || obj.notify === false) return false
  if (obj.kind !== undefined && obj.kind !== 'message') return false
  return !files.some(f => VOICE_FILE_EXTS.has(extname(f).toLowerCase()))
}

export type Speak = (bin: string, args: string[], timeoutMs: number) => Promise<string>
const execSpeak: Speak = async (bin, args, timeoutMs) => (await promisify(execFile)(bin, args, { timeout: timeoutMs })).stdout

/** The OGG 5dive-speak made for `text`, or null when the owner switched voice replies off (exit 3). Throws on any other failure. */
export async function speakToFile(text: string, bin: string, run: Speak = execSpeak): Promise<string | null> {
  let stdout: string
  try {
    stdout = await run(bin, ['--', text], 90_000)
  } catch (err) {
    if ((err as { code?: unknown }).code === 3) return null
    const e = err as { stderr?: unknown; message?: unknown }
    throw new Error(String(e.stderr || e.message || err).trim().split('\n').pop())
  }
  const ogg = stdout.trim().split('\n').pop() ?? ''
  if (!ogg.startsWith('/') || !existsSync(ogg)) throw new Error('5dive-speak made no file')
  return ogg
}
