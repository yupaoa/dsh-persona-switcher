/**
 * Per-session persona bindings for dsh-persona-switcher.
 *
 * A role is installed by registering the deployment persona prefix section —
 * the same name, the same order — through the *agent's own* scoped prompt
 * registry. `@deepseek-ai/dsh-system-prompt` documents exactly that as the
 * supported override:
 *
 *   prompt section "deployment:persona-prefix" is already registered
 *   (for a per-agent override, register through that agent's `agent.ctx` instead)
 *
 * A scoped registration belongs to one agent's scope and shadows the global
 * section of the same name for that agent alone, so the model reads the role's
 * prose while every other prompt input, tool, command, skill and model route
 * stays exactly as it was. The harness's own `dsh-subagent` installs a child's
 * persona through the same call.
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

/** Section name shared by the global deployment persona and its per-agent override. */
export const PERSONA_SECTION = 'deployment:persona-prefix'
/** Centrally owned placement of that section in the prompt registry. */
export const PERSONA_ORDER = 'DEPLOYMENT_PERSONA_PREFIX'

/**
 * Resolve the agent-scoped prompt registry that owns one agent's prompt inputs.
 *
 * The registry must be reached *through the agent's context*: a scoped
 * registration is routed by the context it is made from, so the host-plane
 * registry would instead collide with the global deployment persona.
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
 * Register one persona text as the agent-scoped persona prefix section.
 * @param prompt - the agent-scoped prompt registry.
 * @param persona - the persona prose to install.
 * @returns the registry's effect disposer.
 */
function registerPersona(prompt, persona) {
  return prompt.section({
    name: PERSONA_SECTION,
    order: prompt.getSectionOrder(PERSONA_ORDER),
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
  const notify = typeof warn === 'function' ? warn : () => {}

  const sessionIdOf = (agent) => agent?.session?.id

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
      if (previous !== undefined && previous.id === role.id) {
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
      // because one scope refuses a duplicate name.
      if (previous !== undefined) {
        bindings.delete(sessionId)
        try {
          previous.dispose()
        } catch (error) {
          notify(`[persona-switcher] could not dispose role "${previous.id}": ${String(error)}`)
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
    clear(agent) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return { changed: false, from: undefined }
      const bound = bindings.get(sessionId)
      if (bound === undefined) return { changed: false, from: undefined }
      bindings.delete(sessionId)
      try {
        bound.dispose()
      } catch (error) {
        notify(`[persona-switcher] could not dispose role "${bound.id}": ${String(error)}`)
      }
      return { changed: true, from: bound.id }
    },

    /** @returns how many sessions currently carry a role (diagnostics). */
    get size() {
      return bindings.size
    }
  }
}
