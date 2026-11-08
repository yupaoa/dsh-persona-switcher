/**
 * Replace a file so that the destination is never missing.
 *
 * Why this is its own module: both the session state and the artwork map used to
 * replace their file with "`rm(destination)` then `rename(temp, destination)`",
 * because Windows `rename` refuses to replace an existing file. That sequence is
 * not a replacement, it is a delete followed by a rename, and it opens a window
 * in which the destination does not exist. A rename that then fails — a virus
 * scanner or an editor holding the file, precisely what the retry below is for —
 * leaves it missing permanently, and both loaders read a missing file as "nothing
 * was ever stored": every role loses its artwork or its remembered persona.
 *
 * The order here is therefore inverted: the destination is only ever touched by a
 * `rename` (which either replaces it or fails without changing it), and a copy is
 * the fallback for the Windows cases where rename is blocked but writing is not.
 * There is no step that deletes the destination.
 *
 * @module dsh-persona-switcher/atomic-file
 */
import { randomUUID } from 'node:crypto'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'

/** Errors that a second attempt (or the copy fallback) can plausibly get past. */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** How many times the rename is attempted before falling back to a copy. */
const ATTEMPTS = 3

/** Backoff between attempts, in ms; grows linearly so a held handle can be let go. */
const BACKOFF_MS = 20

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Write `data` to `file`, replacing it, without ever leaving `file` absent.
 *
 * The temporary file lands next to the destination, so the final `rename` stays
 * on one volume (a cross-volume rename is a copy plus a delete, which is not
 * atomic at all). The temporary is always cleaned up, including on failure.
 *
 * @param file - the destination path.
 * @param data - the text to write.
 * @param deps - test seams; every one defaults to the real thing.
 * @param deps.writeFile - writes the temporary file.
 * @param deps.rename - replaces the destination atomically.
 * @param deps.copyFile - the fallback used when `rename` is blocked.
 * @param deps.rm - removes the temporary.
 * @param deps.delay - waits between attempts.
 * @param deps.attempts - how many rename attempts to make.
 * @returns when the destination holds the new bytes.
 */
export async function writeFileAtomic(file, data, deps = {}) {
  const write = deps.writeFile ?? writeFile
  const move = deps.rename ?? rename
  const copy = deps.copyFile ?? copyFile
  const remove = deps.rm ?? rm
  const delay = deps.delay ?? sleep
  const attempts = deps.attempts ?? ATTEMPTS

  const temporary = `${file}.${randomUUID()}.tmp`
  await write(temporary, data, 'utf8')

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await move(temporary, file)
      return
    } catch (error) {
      lastError = error
      if (!RETRYABLE.has(error?.code)) break
      if (attempt < attempts) await delay(attempt * BACKOFF_MS)
    }
  }

  // The destination still holds the previous content: a failed rename changes
  // nothing. Copy over it so a blocked rename degrades to a replacement instead
  // of a deletion. A torn copy is a smaller loss than a vanished state file —
  // and it only happens on the path that would otherwise have no file at all.
  try {
    await copy(temporary, file)
  } catch (copyError) {
    await remove(temporary, { force: true }).catch(() => {})
    throw lastError ?? copyError
  }
  await remove(temporary, { force: true }).catch(() => {})
}
