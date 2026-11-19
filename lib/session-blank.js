/**
 * Answer "has anything been said in this session yet?" from the store on disk.
 *
 * A session that has never been spoken in holds no conversation, and the persona
 * it should show is the configured default — not the role an older build wrote
 * into its memory the moment the session appeared. Nothing in the process can say
 * which sessions are in that state before their agent exists, so the question is
 * answered from the session log itself.
 *
 * The log is one zstd-compressed JSONL file per session, under
 * `<dsh home>/sessions/<workspace group>/session-<id>/session.v4.jsonl.zstd`. A
 * session nobody has talked in holds exactly one record: its own `session` header.
 * That number was measured, not assumed, and it is why "blank" is "one event or
 * fewer" rather than "zero events".
 *
 * Two deliberate properties:
 *
 * - Every failure answers `undefined`, never `false`. "I could not tell" and "there
 *   is a conversation" lead to the same conservative behaviour (keep the role the
 *   session already has), while "it is empty" is only ever reported on evidence.
 * - The answer is cached per file identity (mtime plus size), so a route that is
 *   asked on every render does not decompress the log each time, and a log that
 *   grows invalidates its own entry.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** A session directory is the session id with a `session-` prefix. */
const directoryFor = (sessionId) => `session-${sessionId.replace(/^session-/, '')}`

/** Beyond this a log cannot be a single header record, so it is not worth reading. */
const LARGE_LOG_BYTES = 64 * 1024

/**
 * Create the blankness probe.
 *
 * @param options - the probe options.
 * @param options.root - the store root, normally `<dsh home>/sessions`.
 * @returns an async `(sessionId) => boolean | undefined`.
 */
export function createBlankProbe({ root } = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('the blank probe needs a store root')
  }
  /** Session id -> the log path found for it. The id never moves once written. */
  const located = new Map()
  /** Log path -> the answer for one file identity. */
  const answers = new Map()

  const findLog = async (sessionId) => {
    const remembered = located.get(sessionId)
    if (remembered !== undefined) return remembered
    let groups
    try {
      groups = await readdir(root, { withFileTypes: true })
    } catch {
      // No store at all is not "everything is blank": it is a harness that keeps
      // its sessions somewhere we do not know, so the answer stays unknown.
      return undefined
    }
    const directory = directoryFor(sessionId)
    for (const group of groups) {
      if (!group.isDirectory()) continue
      const candidate = join(root, group.name, directory, 'session.v4.jsonl.zstd')
      try {
        await stat(candidate)
        located.set(sessionId, candidate)
        return candidate
      } catch {
        // Not this workspace; keep looking.
      }
    }
    return undefined
  }

  return async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    try {
      const file = await findLog(sessionId)
      if (file === undefined) return undefined
      const info = await stat(file)
      const stamp = `${info.mtimeMs}:${info.size}`
      const cached = answers.get(file)
      if (cached !== undefined && cached.stamp === stamp) return cached.blank
      // A header-only log measured ~1.7 KB. Anything far larger holds a
      // conversation, and saying so without decompressing keeps a route that is
      // asked on every render off the hot path for long sessions.
      if (info.size > LARGE_LOG_BYTES) {
        answers.set(file, { stamp, blank: false })
        return false
      }
      const text = zstdDecompressSync(await readFile(file)).toString('utf8')
      const blank = text.split(/\r?\n/).filter((line) => line.trim() !== '').length <= 1
      answers.set(file, { stamp, blank })
      return blank
    } catch {
      return undefined
    }
  }
}
