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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Schema version written into the state file. */
export const STATE_VERSION = 1
/** Entries older than this are dropped on write; they belong to dead sessions. */
export const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000

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

  /** Write the file atomically, pruning first. */
  const save = async () => {
    const at = now()
    prune(at)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, serialize(), 'utf8')
    await rename(temporary, file)
  }

  /** Move an unusable file aside so the next write starts from a clean state. */
  const quarantine = async () => {
    try {
      await rename(file, `${file}.corrupt`)
    } catch {
      // Nothing to move, or the move is not permitted: the next write replaces
      // the file anyway, so this is cosmetic.
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
      if (current !== undefined && current.role === wanted) return false
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
