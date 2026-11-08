/**
 * Durable memory for per-session role choices.
 *
 * A binding lives in the prompt registry of one agent scope, and that scope is
 * torn down with the agent. Without this file a DSH restart would silently drop
 * every switch and the affected sessions would quietly fall back to the
 * deployment persona — the persona would look like it "did not reach the
 * prompt" even though the registration itself worked.
 *
 * The store is deliberately small and dependency-free. It is written atomically
 * (temp file plus rename) so a crash cannot leave half a JSON document behind,
 * and it is read tolerantly: a missing file is an empty memory, an unreadable
 * one is quarantined next to itself instead of deleted, because losing a role
 * choice is cheap while destroying a file the user may want to inspect is not.
 *
 * Two kinds of choice live here: the role a session runs as, and — stored as
 * `null` — the decision to run on the deployment persona (`/role none`). The
 * second one has to be *recorded* rather than erased, otherwise the configured
 * `defaultRole` would legitimately claim the session on its next model step and
 * the documented "back to the deployment persona" could never hold.
 *
 * @module dsh-persona-switcher/session-state
 */
import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { writeFileAtomic } from './atomic-file.js'

/** Schema version written into the state file. */
export const STATE_VERSION = 1
/** Entries older than this are dropped on write; they belong to dead sessions. */
export const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000
/**
 * How stale an entry may get before re-selecting the same role rewrites it.
 *
 * Without this, "unchanged means no write" also meant "unchanged means it keeps
 * ageing", and a binding in daily use expired 180 days later while still in use.
 * A day is long enough that the no-op path still costs nothing in practice.
 */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * The remembered value for a session that asked for the deployment persona.
 *
 * Deliberately distinct from "no entry at all": an absent entry means the
 * session never chose, which is exactly when the configured `defaultRole` is
 * allowed to apply. Written as `{"role": null}`.
 */
export const NO_ROLE = null

/**
 * Normalize one stored entry.
 *
 * Three shapes are accepted: the current `{ role, at }` record, the same record
 * with `role: null` (an explicit opt-out), and a bare role string, so a
 * hand-edited or older file still loads.
 *
 * @param value - the raw entry.
 * @param now - the timestamp to fall back on.
 * @returns the normalized entry, or undefined when it carries no choice.
 */
function normalizeEntry(value, now) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : { role: value.trim(), at: now }
  if (value === null || typeof value !== 'object') return undefined
  const role = value.role === NO_ROLE ? NO_ROLE : typeof value.role === 'string' ? value.role.trim() : ''
  if (role === '') return undefined
  const stamp = typeof value.at === 'string' ? Date.parse(value.at) : Number(value.at)
  return { role, at: Number.isFinite(stamp) ? stamp : now }
}

/**
 * Create the session-state store.
 *
 * @param options - the store options.
 * @param options.file - the state file path (required).
 * @param options.warn - sink for recoverable complaints; defaults to silence.
 * @param options.now - clock, injectable for tests.
 * @returns the store.
 */
export function createSessionState({ file, warn = () => {}, now = () => Date.now() } = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('the session state needs a file path')
  }
  /** @type {Map<string, { role: string | null, at: number }>} */
  let sessions = new Map()

  /** Drop entries that can no longer belong to a live session. */
  const prune = (at) => {
    for (const [id, entry] of sessions) {
      // An opt-out (`role: null`) is a decision, not a gap: it is the only thing
      // keeping a configured `defaultRole` from claiming the session on its next
      // model step, so it never expires.
      if (entry.role === NO_ROLE) continue
      if (!Number.isFinite(entry.at) || at - entry.at > STALE_AFTER_MS) sessions.delete(id)
    }
  }

  const serialize = () =>
    `${JSON.stringify(
      {
        version: STATE_VERSION,
        sessions: Object.fromEntries(
          [...sessions.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([id, entry]) => [id, { role: entry.role, at: new Date(entry.at).toISOString() }])
        )
      },
      undefined,
      2
    )}\n`

  /**
   * Write the file so a reader never sees a half-written document.
   *
   * Windows is why this is delicate: `rename` there refuses to replace an
   * existing file (`MoveFileEx` fails with EPERM/EACCES, and more often so while
   * a virus scanner or an editor holds it). The earlier answer — remove the
   * destination, then rename — traded that for a worse failure: when the rename
   * then failed, the file was already gone, and a store that cannot be read is
   * read as "no session ever chose a role". `writeFileAtomic` owns the strategy
   * now (retry the rename, fall back to a copy over the old file, never delete the
   * destination first), which also keeps the temp name unique per write: two
   * sessions switching at once used to share `${file}.tmp` and rename a file the
   * other had already taken.
   *
   * Writes are also serialized: the read-modify-write that precedes this is
   * synchronous, but two overlapping saves could still interleave their renames.
   */
  let writeChain = Promise.resolve()
  const save = () => {
    const attempt = writeChain.then(async () => {
      const at = now()
      prune(at)
      await mkdir(dirname(file), { recursive: true })
      // Never `rm` the destination first: that turns a failed replacement into a
      // deleted state file, and every loader reads "no file" as "no session ever
      // chose". `writeFileAtomic` retries the rename and falls back to a copy.
      await writeFileAtomic(file, serialize())
    })
    // A failure belongs to the attempt that caused it, not to the queue. Chaining
    // the next save onto the rejected promise would replay the first error for
    // every later caller — including the ones whose write would have worked —
    // and the store could never recover without a restart. The tail therefore
    // absorbs the rejection while the caller still receives it.
    writeChain = attempt.catch(() => {})
    return attempt
  }

  /** Move an unusable file aside so the next write starts from a clean state. */
  const quarantine = async () => {
    try {
      await rename(file, `${file}.corrupt`)
    } catch (error) {
      // Nothing to move is not worth a word. Anything else is: the file stays where
      // the next save will overwrite it, so "kept as <file>.corrupt" was a promise
      // the log never kept. A person reading that message would go looking for a
      // copy that does not exist.
      if (error?.code !== 'ENOENT') {
        warn(
          `session state ${file} could not be moved aside to ${file}.corrupt ` +
            `(${error?.code ?? error?.message ?? String(error)}); the next write replaces it`
        )
      }
    }
  }

  return {
    /** The state file path. */
    get file() {
      return file
    },
    /** How many sessions this memory holds. */
    get size() {
      return sessions.size
    },

    /**
     * Read the file into memory.
     *
     * Never throws: an unreadable or malformed file leaves an empty memory and
     * one warning, so a corrupt state can never keep a session from starting.
     *
     * @returns the number of loaded entries.
     */
    async load() {
      sessions = new Map()
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          warn(`session state ${file} is unreadable (${error?.message ?? String(error)}); starting empty`)
        }
        return 0
      }

      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const stored =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.sessions : undefined
      if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
        warn(`session state ${file} holds no session map; starting empty (kept as ${file}.corrupt)`)
        await quarantine()
        return 0
      }

      const at = now()
      for (const [id, value] of Object.entries(stored)) {
        if (typeof id !== 'string' || id.trim() === '') continue
        const entry = normalizeEntry(value, at)
        if (entry !== undefined) sessions.set(id, entry)
      }
      return sessions.size
    },

    /**
     * The role remembered for one session.
     * @param sessionId - the session id.
     * @returns the role id, `null` when the session asked for the deployment
     * persona, or undefined when nothing is remembered.
     */
    get(sessionId) {
      return sessions.get(sessionId)?.role
    },

    /**
     * Remember one session's choice.
     *
     * @param sessionId - the session id.
     * @param role - the role id, or {@link NO_ROLE} for the deployment persona.
     * @returns whether the memory changed (an unchanged value is not rewritten).
     */
    async set(sessionId, role) {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new Error('a session id is required to remember a role')
      }
      const wanted = role === NO_ROLE ? NO_ROLE : typeof role === 'string' ? role.trim() : ''
      if (wanted === '') {
        throw new Error('a role id is required to remember a role')
      }
      const id = sessionId.trim()
      const current = sessions.get(id)
      // Re-selecting the role already in force is the one moment an entry's age
      // can be refreshed without writing on every `/role` call, so an entry in
      // daily use never expires out from under the session it belongs to.
      if (current !== undefined && current.role === wanted && now() - current.at < REFRESH_AFTER_MS) return false
      sessions.set(id, { role: wanted, at: now() })
      await save()
      return true
    },

    /**
     * Forget one session's role.
     * @param sessionId - the session id.
     * @returns whether an entry was dropped.
     */
    async remove(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : ''
      if (id === '' || !sessions.delete(id)) return false
      await save()
      return true
    },

    /**
     * The remembered choices as a plain object, for diagnostics and tests.
     * @returns session id -> role id (`null` for an explicit opt-out).
     */
    snapshot() {
      return Object.fromEntries([...sessions.entries()].map(([id, entry]) => [id, entry.role]))
    }
  }
}

/**
 * Decide what the next model step of one session should do about its role.
 *
 * Pure on purpose: the whole restore policy is testable without a host, and the
 * pre-step hook in `index.js` only dispatches the returned action.
 *
 * - `idle` — nothing to do. This includes a session that explicitly asked for
 *   the deployment persona: that is a decision the configured default must not
 *   override.
 * - `persist` — a role is in force but the memory disagrees; record it (this is
 *   how a switch made by an older version of this plugin survives an upgrade).
 * - `bind` — the memory (or the configured default) names a role to install.
 * - `forget` — the memory names a role that no longer exists in the library.
 * - `forget-and-bind` — same, but a usable fallback takes over.
 *
 * @param input - the decision inputs.
 * @param input.bound - the role in force for this session, when one is bound.
 * @param input.remembered - the role this session's memory holds, when any
 * (`null` for the deployment persona, chosen on purpose).
 * @param input.fallback - the configured default role for new sessions, if any.
 * @param input.has - predicate: does this role id exist in the library?
 * @returns the plan.
 */
export function planRestore({ bound, remembered, fallback, has }) {
  if (typeof has !== 'function') throw new Error('planRestore needs a has() predicate')
  if (bound !== undefined) {
    return remembered === bound ? { action: 'idle' } : { action: 'persist', role: bound }
  }
  if (remembered === NO_ROLE) return { action: 'idle' }

  const held = typeof remembered === 'string' && remembered !== '' ? remembered : undefined
  const known = held !== undefined && has(held)
  const alternative = typeof fallback === 'string' && fallback !== '' && has(fallback) ? fallback : undefined

  if (known) return { action: 'bind', role: held }
  if (held !== undefined && alternative !== undefined) return { action: 'forget-and-bind', role: alternative }
  if (held !== undefined) return { action: 'forget' }
  if (alternative !== undefined) return { action: 'bind', role: alternative }
  return { action: 'idle' }
}
