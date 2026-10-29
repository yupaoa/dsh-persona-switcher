/**
 * Per-session persona bindings for dsh-persona-switcher.
 *
 * A role is installed as a prompt section this plugin owns —
 * `persona-switcher:persona`, placed immediately after the deployment persona
 * prefix — through the *agent's own* scoped prompt registry, so the role's
 * prose reaches that one session while every other prompt input, tool, command,
 * skill and model route stays exactly as it was. The harness's own
 * `dsh-subagent` installs a child's persona through the same scoped call.
 *
 * It deliberately does NOT re-register the harness's `deployment:persona-prefix`
 * section. That section carries the deployment's own text —
 *
 *   personaPrefix: You are a coding agent powered by the {{model}} model.
 *
 * (the `system-prompt` row's `personaPrefix`, resolved per request) — and
 * shadowing it, which is what this module used to do, deleted that line from
 * the system prompt: the model no longer knew which model it was running on. A
 * separate section leaves the deployment prefix in force for every session,
 * role or no role: a role adds its prose beside the identity line instead of
 * replacing it, and `/role none` replaces the role prose with an explicit
 * no-role section while the identity line stays intact.
 *
 * This module is deliberately independent of the agent-preset registry. Asking
 * the registry to `recompose()` an agent is the one thing this plugin must never
 * do: recomposition rebinds the agent's whole plugin composition, so the
 * agent-plane tool set and command set are replaced along with the identity.
 * (Measured on the previous implementation: 33 model-facing tools and 10
 * commands became 7 and 7, losing `/compact`, `/goal` and `/plan`.)
 *
 * Replacing a persona is an ordered pair: dispose the superseded registration,
 * then register the new one. A second registration of one name inside one scope
 * is a hard error in the registry, and a failed replacement restores the
 * superseded persona instead of leaving the session with none.
 *
 * @module dsh-persona-switcher/persona-binding
 */

/** Section name for the role persona. Namespaced to this plugin, so it can
 * never collide with — or shadow — the deployment's own persona sections. */
export const PERSONA_SECTION = 'persona-switcher:persona'
/**
 * Placement of that section, as a raw order value.
 *
 * The harness's own `SECTION_ORDERS` table fixes the deployment persona prefix
 * at `0` (after `HARNESS_IDENTITY: -1000`) and the first-party guidance from
 * `PLAN_POLICY: 500` onwards, so the role prose belongs in the empty gap
 * between them — right after the identity line, before the harness's guidance.
 * `getSectionOrder` resolves only names from that table, and this placement has
 * none, so the number is passed as it is: `137` is an arbitrary prime inside
 * that gap, chosen so another plugin's raw order is unlikely to land on it.
 */
export const PERSONA_ORDER = 137

/**
 * The section installed while no role is bound.
 *
 * Clearing the role section alone leaves the model with no positive statement
 * of what is in force, while the role catalogue still lists every available
 * persona. Measured on a real `/role none`: the model read the catalogue and
 * announced itself as `whale-girl`, even though that role was not bound. This
 * section makes the current state explicit, so the catalogue stays a menu
 * instead of becoming a set of candidate identities.
 */
export const NONE_PERSONA = `No role is active in this session. The deployment persona is what applies now: the base identity supplied by the deployment, with no additional role. The role list is a menu, not an active identity — do not take a name, tone, form of address, or catchphrase from it unless that role is explicitly bound. Earlier role voices are not in force.`

/**
 * Resolve the agent-scoped prompt registry that owns one agent's prompt inputs.
 *
 * The registry must be reached *through the agent's context*: a scoped
 * registration is routed by the context it is made from, so the host-plane
 * registry would register the role globally, for every session at once.
 *
 * @param agent - the owning agent.
 * @returns the agent-scoped registry, or undefined when this session exposes none.
 */
function scopedPromptOf(agent) {
  const ctx = agent?.ctx
  if (ctx === undefined || ctx === null) return undefined
  const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt
  if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') return undefined
  return prompt
}

/**
 * Register one persona text as this plugin's agent-scoped persona section.
 * @param prompt - the agent-scoped prompt registry.
 * @param persona - the persona prose to install.
 * @returns the registry's effect disposer.
 */
function registerPersona(prompt, persona) {
  return prompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: persona
  })
}

/**
 * Create the per-session binding table.
 *
 * @param options - optional hooks.
 * @param options.warn - diagnostics sink for a disposal or restore that failed;
 *   neither can be reported to the caller without failing a switch that in fact
 *   succeeded, so they are logged instead.
 * @returns the binding table: `roleOf`, `install`, `clear`, and a live `size`.
 */
export function createPersonaBindings({ warn } = {}) {
  /** One live binding per session id: the role id, its prose, and its disposer. */
  const bindings = new Map()
  /** Sessions carrying the explicit no-role section, kept apart from real bindings. */
  const noneBindings = new Map()
  const notify = typeof warn === 'function' ? warn : () => {}

  const sessionIdOf = (agent) => agent?.session?.id

  /**
   * Install the explicit no-role section when the session has no role.
   *
   * This is deliberately separate from {@link install}: `roleOf` and `size`
   * must keep reporting "no role", while the prompt still carries a positive
   * statement that the catalogue is inactive.
   *
   * @param agent - the owning agent.
   * @returns true when a section was installed, false when one was already
   *   present, a role is bound, or the session exposes no scoped registry.
   */
  const ensureNone = (agent) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return false
    if (bindings.has(sessionId) || noneBindings.has(sessionId)) return false
    const prompt = scopedPromptOf(agent)
    if (prompt === undefined) return false
    const dispose = registerPersona(prompt, NONE_PERSONA)
    noneBindings.set(sessionId, { dispose: typeof dispose === 'function' ? dispose : () => {} })
    return true
  }

  return {
    /**
     * Report the role currently bound to one session.
     * @param agent - the owning agent.
     * @returns the bound role id, or undefined when the session runs on the
     *   deployment persona.
     */
    roleOf(agent) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return undefined
      return bindings.get(sessionId)?.id
    },

    /**
     * Report the role currently bound to one session, addressed by id alone.
     *
     * The readings that are not the model — the `/role` picker in the browser
     * and the `/session` route that feeds it — hold a session id rather than an
     * agent, and the table is keyed by exactly that id, so no agent lookup (and
     * no `agents` service) may be needed to answer "which role is in force".
     *
     * @param sessionId - the session id to look up.
     * @returns the bound role id, or undefined when that session runs on the
     *   deployment persona (or the id names no session).
     */
    roleIdOfSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return bindings.get(sessionId)?.id
    },

    /**
     * Install one role's persona on one live session, replacing any earlier
     * binding of that session.
     *
     * Throws — leaving the session on its previous persona — when the session
     * exposes no agent-scoped registry or the registry refuses the section. The
     * failure is loud rather than silent because the alternative (falling back
     * to a preset recomposition) would cost the session its tools.
     *
     * @param agent - the owning agent.
     * @param role - the parsed role to bind.
     * @returns `{ changed, from }`; `changed` is false when the role was already bound.
     */
    install(agent, role) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) {
        throw new Error('this session has no id, so a role cannot be bound to it')
      }
      const previous = bindings.get(sessionId)
      const previousNone = noneBindings.get(sessionId)
      if (previous !== undefined && previous.id === role.id) {
        if (previousNone !== undefined) {
          noneBindings.delete(sessionId)
          try {
            previousNone.dispose()
          } catch (error) {
            notify(`[persona-switcher] could not dispose the no-role section: ${String(error)}`)
          }
        }
        return { changed: false, from: previous.id }
      }
      const prompt = scopedPromptOf(agent)
      if (prompt === undefined) {
        throw new Error(
          'this session exposes no agent-scoped prompt registry, and this plugin never replaces a ' +
            "session's composition to install a persona — role unchanged"
        )
      }

      // Replace, never stack: the superseded registration is disposed first
      // because one scope refuses a duplicate name. The no-role section, when
      // present, is superseded by the role in exactly the same way.
      if (previous !== undefined) {
        bindings.delete(sessionId)
        try {
          previous.dispose()
        } catch (error) {
          notify(`[persona-switcher] could not dispose role "${previous.id}": ${String(error)}`)
        }
      }
      if (previousNone !== undefined) {
        noneBindings.delete(sessionId)
        try {
          previousNone.dispose()
        } catch (error) {
          notify(`[persona-switcher] could not dispose the no-role section: ${String(error)}`)
        }
      }

      let dispose
      try {
        dispose = registerPersona(prompt, role.persona)
      } catch (error) {
        // The registry refused the new persona. A discarded persona must not
        // outlive the role it belonged to, but neither should the session be
        // left with no persona at all, so the superseded one comes back.
        let restored
        if (previous !== undefined) {
          try {
            restored = registerPersona(prompt, previous.persona)
          } catch (restoreError) {
            notify(`[persona-switcher] could not restore role "${previous.id}": ${String(restoreError)}`)
          }
        } else if (previousNone !== undefined) {
          try {
            const restoredNone = registerPersona(prompt, NONE_PERSONA)
            noneBindings.set(sessionId, {
              dispose: typeof restoredNone === 'function' ? restoredNone : () => {}
            })
          } catch (restoreError) {
            notify(`[persona-switcher] could not restore the no-role section: ${String(restoreError)}`)
          }
        }
        if (restored !== undefined) {
          bindings.set(sessionId, {
            id: previous.id,
            persona: previous.persona,
            dispose: typeof restored === 'function' ? restored : () => {}
          })
        }
        throw new Error(
          `the prompt registry refused the per-session persona: ${error?.message ?? String(error)}`,
          { cause: error }
        )
      }

      bindings.set(sessionId, {
        id: role.id,
        persona: role.persona,
        dispose: typeof dispose === 'function' ? dispose : () => {}
      })
      return { changed: true, from: previous?.id }
    },

    /**
     * Revert one session to the deployment persona.
     * @param agent - the owning agent.
     * @returns `{ changed, from }`; `changed` is false when nothing was bound.
     */
    ensureNone,

    clear(agent) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return { changed: false, from: undefined }
      const bound = bindings.get(sessionId)
      if (bound === undefined) {
        try {
          ensureNone(agent)
        } catch (error) {
          notify(`[persona-switcher] could not install the no-role section: ${String(error)}`)
        }
        return { changed: false, from: undefined }
      }
      bindings.delete(sessionId)
      try {
        bound.dispose()
      } catch (error) {
        notify(`[persona-switcher] could not dispose role "${bound.id}": ${String(error)}`)
      }
      try {
        ensureNone(agent)
      } catch (error) {
        notify(`[persona-switcher] could not install the no-role section: ${String(error)}`)
      }
      return { changed: true, from: bound.id }
    },

    /** @returns how many sessions currently carry a role (diagnostics). */
    get size() {
      return bindings.size
    }
  }
}
