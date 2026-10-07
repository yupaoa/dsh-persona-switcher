#!/usr/bin/env node
/**
 * Behavioural guard for the per-session persona binding.
 *
 * Run with `npm test` (CI runs the same on every push and PR).
 *
 * A role is applied by registering the deployment persona prefix section —
 * same name, same order — through the *agent's own* prompt registry, which
 * shadows the global deployment persona for that one session and changes
 * nothing else. The properties that matter cannot be checked by reading the
 * source, so they are checked here against fake registries:
 *
 *   - registration is routed through the agent's registry, not a global one;
 *     the fake host registry throws exactly like the real one does when a
 *     section name is already registered globally;
 *   - replacing a role disposes the superseded registration first, because one
 *     scope refuses a duplicate name: switching twice must neither throw nor
 *     leave two personas in the prompt;
 *   - a refused replacement restores the superseded persona instead of leaving
 *     the session with no persona at all;
 *   - the binding table never consults the agent-preset registry (the fake
 *     context throws on that lookup, so a reappearance fails loudly).
 *
 * Exits non-zero when any check fails.
 */
import assert from 'node:assert/strict'
import { PERSONA_ORDER, PERSONA_SECTION, createPersonaBindings } from '../lib/persona-binding.js'

const ROLE_A = { id: 'whale-girl', name: '鲸鱼娘', description: '', persona: '你是DeepSeek鲸鱼娘，温柔高效。' }
const ROLE_B = { id: 'plain', name: 'Plain', description: '', persona: 'You are a plain assistant.' }

/** A stand-in for one agent-scoped prompt registry. */
const scopedPrompt = () => {
  const sections = new Map()
  const registered = []
  let refuse = null
  let refusals = 0
  return {
    sections,
    registered,
    /**
     * Make the next `times` calls to `section()` fail, like a registry that
     * refuses (the real one refuses a duplicate name inside one scope).
     */
    refuseNext(message, times = 1) {
      refuse = message
      refusals = times
    },
    section(input) {
      if (refusals > 0) {
        refusals -= 1
        if (refusals === 0) refuse = null
        throw new Error(refuse)
      }
      assert.equal(input.name, PERSONA_SECTION, 'a role must register the deployment persona section name')
      assert.equal(typeof input.order, 'number', 'a role must place its section at the registry order')
      if (sections.has(input.name)) {
        throw new Error(`prompt section "${input.name}" is already registered in this scope`)
      }
      sections.set(input.name, input.text)
      registered.push(input.text)
      let live = true
      return () => {
        if (!live) return
        live = false
        sections.delete(input.name)
      }
    },
    getSectionOrder(name) {
      assert.equal(name, PERSONA_ORDER, `unexpected order name ${name}`)
      return 0
    }
  }
}

/** A stand-in for a registry that is only reachable globally, which refuses. */
const globalPrompt = () => {
  const calls = []
  return {
    calls,
    section(input) {
      calls.push(input)
      throw new Error(
        `prompt section "${input.name}" is already registered (for a per-agent override, register ` +
          "through that agent's `agent.ctx` instead)"
      )
    },
    getSectionOrder() {
      return 0
    }
  }
}

/** A stand-in for one agent whose context exposes a scoped registry. */
const agentWith = (prompt, id = 'session-1') => ({
  session: { id },
  ctx: {
    get(name) {
      if (name === 'agentPresets') {
        throw new Error('the persona binding must never consult the agent-preset registry')
      }
      return name === 'systemPrompt' ? prompt : undefined
    }
  }
})

const problems = []
const check = (label, run) => {
  try {
    run()
    console.log(`ok   ${label}`)
  } catch (error) {
    problems.push(`${label}: ${error?.message ?? String(error)}`)
    console.error(`FAIL ${label}: ${error?.message ?? String(error)}`)
  }
}

check('a role is registered as the agent-scoped deployment persona section', () => {
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings()
  assert.equal(bindings.roleOf(agent), undefined, 'a fresh session carries no role')
  const result = bindings.install(agent, ROLE_A)
  assert.deepEqual(result, { changed: true, from: undefined })
  assert.equal(prompt.sections.get(PERSONA_SECTION), ROLE_A.persona, 'the persona text must be the section text')
  assert.deepEqual(prompt.registered, [ROLE_A.persona], 'exactly one registration')
  assert.equal(bindings.roleOf(agent), ROLE_A.id)
  assert.equal(bindings.size, 1)
})

check('re-applying the role in force is a no-op', () => {
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings()
  bindings.install(agent, ROLE_A)
  const again = bindings.install(agent, ROLE_A)
  assert.deepEqual(again, { changed: false, from: ROLE_A.id })
  assert.deepEqual(prompt.registered, [ROLE_A.persona], 'a no-op must not register a second section')
  assert.equal(prompt.sections.size, 1)
})

check('switching replaces the persona without stacking or throwing', () => {
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings()
  bindings.install(agent, ROLE_A)
  const result = bindings.install(agent, ROLE_B)
  assert.deepEqual(result, { changed: true, from: ROLE_A.id })
  assert.equal(prompt.sections.size, 1, 'one scope holds one persona section at a time')
  assert.equal(prompt.sections.get(PERSONA_SECTION), ROLE_B.persona)
  assert.deepEqual(prompt.registered, [ROLE_A.persona, ROLE_B.persona])
  assert.equal(bindings.roleOf(agent), ROLE_B.id)
})

check('clearing a role returns the session to the deployment persona', () => {
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings()
  bindings.install(agent, ROLE_A)
  const cleared = bindings.clear(agent)
  assert.deepEqual(cleared, { changed: true, from: ROLE_A.id })
  assert.equal(prompt.sections.size, 0, 'the section must be gone from the prompt')
  assert.equal(bindings.roleOf(agent), undefined)
  assert.equal(bindings.size, 0)
  assert.deepEqual(bindings.clear(agent), { changed: false, from: undefined }, 'clearing twice is harmless')
})

check('sessions are bound independently', () => {
  const first = scopedPrompt()
  const second = scopedPrompt()
  const bindings = createPersonaBindings()
  bindings.install(agentWith(first, 'session-1'), ROLE_A)
  bindings.install(agentWith(second, 'session-2'), ROLE_B)
  assert.equal(first.sections.get(PERSONA_SECTION), ROLE_A.persona)
  assert.equal(second.sections.get(PERSONA_SECTION), ROLE_B.persona)
  assert.equal(bindings.size, 2)
})

check('a session with no scoped registry is refused, not recomposed', () => {
  const bindings = createPersonaBindings()
  const agent = { session: { id: 'session-1' }, ctx: { get: () => undefined } }
  assert.throws(() => bindings.install(agent, ROLE_A), /no agent-scoped prompt registry/)
  assert.equal(bindings.roleOf(agent), undefined)
  assert.equal(bindings.size, 0)
})

check('a registry that refuses the section leaves the session untouched', () => {
  const prompt = globalPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings()
  assert.throws(() => bindings.install(agent, ROLE_A), /refused the per-session persona/)
  assert.equal(prompt.calls.length, 1, 'the attempt is visible, the failure is reported')
  assert.equal(bindings.roleOf(agent), undefined)
  assert.equal(bindings.size, 0)
})

check('a refused replacement restores the persona that was in force', () => {
  const complaints = []
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings({ warn: (message) => complaints.push(message) })
  bindings.install(agent, ROLE_A)
  prompt.refuseNext('section registry is unhappy')
  assert.throws(() => bindings.install(agent, ROLE_B), /refused the per-session persona/)
  assert.equal(bindings.roleOf(agent), ROLE_A.id, 'the superseded role must come back')
  assert.equal(prompt.sections.get(PERSONA_SECTION), ROLE_A.persona)
  assert.equal(prompt.sections.size, 1)
  assert.equal(complaints.length, 0, 'a restore that worked needs no complaint')
})

check('a replacement whose restore also fails drops the binding and says so', () => {
  const complaints = []
  const prompt = scopedPrompt()
  const agent = agentWith(prompt)
  const bindings = createPersonaBindings({ warn: (message) => complaints.push(message) })
  bindings.install(agent, ROLE_A)
  prompt.refuseNext('the registry is unavailable', 2)
  assert.throws(() => bindings.install(agent, ROLE_B), /refused the per-session persona/)
  assert.equal(bindings.roleOf(agent), undefined, 'a role that could not be restored is not claimed')
  assert.equal(bindings.size, 0)
  assert.equal(prompt.sections.size, 0, 'a discarded persona must not outlive the role it belonged to')
  assert.equal(complaints.length, 1)
  assert.match(complaints[0], /could not restore role "whale-girl"/)
})

check('a session without an id cannot be bound', () => {
  const bindings = createPersonaBindings()
  assert.throws(() => bindings.install({ ctx: {} }, ROLE_A), /no id/)
})

if (problems.length > 0) {
  console.error(`\nverify-host-binding: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log('verify-host-binding: all persona-binding invariants hold')
