#!/usr/bin/env node
/**
 * Behavioural guard for the creation-time role seam (`agent/created`).
 *
 * WHY: the harness assembles a model step's prompt *before* it runs
 * `agent/pre-step`, so a role installed only on that seam is one step late —
 * after a DSH restart the first reply of a resumed session ran on the
 * deployment persona. Roles are therefore installed from `agent/created` too:
 * the harness awaits those listeners inside the creation transaction, before it
 * releases the input queued for that agent, so the persona is in force from the
 * session's very first step.
 *
 * HOW: `lib/index.js` cannot be imported as-is here, because it imports
 * `@deepseek-ai/dsh-tools` — an optional peer this repository does not install.
 * The module is imported from a temporary copy beside it whose single import
 * line points at an inline stub, so everything else is the shipped source: the
 * code under test, its relative imports and the real session-state module. The
 * copy is removed as soon as the import resolves.
 *
 * Exits non-zero when any check fails.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NO_ROLE, createSessionState } from '../lib/session-state.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
/** The section the per-agent persona override registers. */
const PERSONA_SECTION = 'deployment:persona-prefix'
const ROLE_ID = 'whale-girl'
const ROLE_PERSONA = '你是DeepSeek鲸鱼娘，温柔高效的鲸御姐。'
const PLAIN_ID = 'plain-helper'
const PLAIN_PERSONA = '你是一个简洁的助手。'
const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover temp directory is not worth failing a test run over
    }
  }
})

/**
 * Import `lib/index.js` with its optional `dsh-tools` peer stubbed inline.
 * @returns the plugin module.
 */
const loadHost = async () => {
  const source = await readFile(join(libDir, 'index.js'), 'utf8')
  const needle = "from '@deepseek-ai/dsh-tools'"
  if (!source.includes(needle)) {
    throw new Error(
      `lib/index.js no longer contains ${needle}, so this guard cannot stub the optional peer — ` +
        'update scripts/verify-created-bind.mjs'
    )
  }
  const stub = `data:text/javascript;base64,${Buffer.from('export const defineTool = (spec) => spec\n').toString('base64')}`
  const copy = join(libDir, 'tmp-verify-created-bind.mjs')
  await writeFile(copy, source.replace(needle, `from '${stub}'`))
  try {
    return await import(pathToFileURL(copy).href)
  } finally {
    rmSync(copy, { force: true })
  }
}

/** The text of one role file, in the format `scanRoles` reads. */
const roleFile = (id, persona, name = id) =>
  ['---', `id: ${id}`, `name: ${name}`, 'description: test fixture', '---', '', persona, ''].join('\n')

/** A stand-in for one agent's scoped prompt registry. */
const scopedPrompt = () => {
  const sections = new Map()
  const registered = []
  return {
    sections,
    registered,
    section(input) {
      assert.equal(input.name, PERSONA_SECTION, 'a role must register the deployment persona section name')
      assert.equal(typeof input.text, 'string', 'a persona section needs text')
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
    getSectionOrder: () => 0
  }
}

/** A stand-in for one agent. */
const fakeAgent = (sessionId, { depth = 0 } = {}) => {
  const prompt = scopedPrompt()
  return {
    session: { id: sessionId },
    depth,
    prompt,
    ctx: {
      get(name) {
        if (name === 'agentPresets') {
          throw new Error('the persona binding must never consult the agent-preset registry')
        }
        return name === 'systemPrompt' ? prompt : undefined
      }
    }
  }
}

/** A stand-in for the plugin host surface `apply()` drives. */
const fakeHost = (liveAgents = []) => {
  const listeners = new Map()
  const app = {
    listeners,
    warns: [],
    infos: [],
    systemSections: [],
    commands: [],
    liveAgents,
    ctx: {
      logger: {
        info: (message) => app.infos.push(String(message)),
        warn: (message) => app.warns.push(String(message)),
        error: (message) => app.warns.push(String(message))
      },
      get: () => undefined,
      on(name, handler) {
        const list = listeners.get(name) ?? []
        list.push(handler)
        listeners.set(name, list)
        return () => {}
      },
      effect(run) {
        const value = run()
        if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
          // a generator effect: drive it so its registration actually happens
          let step = value.next()
          while (step.done !== true) step = value.next()
        }
        return () => {}
      },
      inject(names, run) {
        if (names.includes('agents')) run({ agents: { list: () => liveAgents } })
      },
      commands: {
        register: (definition) => {
          app.commands.push(definition)
          return () => {}
        },
        view: () => new Map(),
        execute: async () => ({ kind: 'text', text: '' })
      },
      systemPrompt: {
        section: (input) => {
          app.systemSections.push(input)
          return () => {}
        }
      },
      tools: { register: () => () => {} }
    }
  }
  app.fire = async (name, ...args) => {
    const list = listeners.get(name)
    assert.ok(list !== undefined && list.length > 0, `no listener is registered for ${name}`)
    let result
    for (const handler of list) result = await handler(...args)
    return result
  }
  return app
}

/** Poll until a predicate holds, so a slow disk cannot make the guard flaky. */
const settle = async (predicate, label) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Read the session memory file back, the way the row itself would. */
const readMemory = async (file) => {
  const memory = createSessionState({ file, warn: () => {} })
  await memory.load()
  return memory
}

const host = await loadHost()

/**
 * Load the row over a fresh temp home and a two-role library.
 * @param options - the seed entries, the config additions and the live agents.
 * @returns the paths and the fake host the row was applied to.
 */
const scenario = async ({ seed = {}, config = {}, liveAgents = [] } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-created-'))
  tempDirs.push(dir)
  const rolesDir = join(dir, 'roles')
  await mkdir(join(rolesDir, ROLE_ID), { recursive: true })
  await writeFile(join(rolesDir, ROLE_ID, 'ROLE.md'), roleFile(ROLE_ID, ROLE_PERSONA))
  await writeFile(join(rolesDir, `${PLAIN_ID}.md`), roleFile(PLAIN_ID, PLAIN_PERSONA))
  process.env.DSH_HOME = dir
  const stateFile = join(dir, 'persona-switcher', 'sessions.json')
  const seeded = createSessionState({ file: stateFile, warn: () => {} })
  for (const [sessionId, role] of Object.entries(seed)) await seeded.set(sessionId, role)
  const app = fakeHost(liveAgents)
  host.apply(app.ctx, { rolesDir, exposeTool: false, ...config })
  await settle(
    () => app.infos.some((line) => line.includes('role library')),
    'the load-time library scan'
  )
  return { dir, rolesDir, stateFile, app }
}

const problems = []
const check = async (label, run) => {
  try {
    await run()
    console.log(`ok   ${label}`)
  } catch (error) {
    problems.push(`${label}: ${error?.message ?? String(error)}`)
    console.error(`FAIL ${label}: ${error?.message ?? String(error)}`)
  }
}

await check("a remembered role is in force before the session's first model step", async () => {
  const { app, stateFile } = await scenario({ seed: { 'session-resumed': ROLE_ID } })
  const agent = fakeAgent('session-resumed')
  await app.fire('agent/created', { agent, source: 'resume' })
  assert.equal(
    agent.prompt.sections.get(PERSONA_SECTION),
    ROLE_PERSONA,
    'the created agent must already carry the remembered persona'
  )
  assert.deepEqual(agent.prompt.registered, [ROLE_PERSONA], 'exactly one persona registration')
  assert.deepEqual(app.warns, [], 'a clean restore logs no complaint')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-resumed'), ROLE_ID, 'the memory still names the role')
})

await check('the creation bind is idempotent and the pre-step reconcile leaves it alone', async () => {
  const { app } = await scenario({ seed: { 'session-resumed': ROLE_ID } })
  const agent = fakeAgent('session-resumed')
  await app.fire('agent/created', { agent, source: 'resume' })
  const decision = { kind: 'continue', messages: [] }
  const returned = await app.fire(
    'agent/pre-step',
    { agent, messages: [], step: 2, signal: undefined },
    async () => decision
  )
  assert.equal(returned, decision, 'the pre-step decision must pass through untouched')
  assert.deepEqual(
    agent.prompt.registered,
    [ROLE_PERSONA],
    'the later step must not churn the prompt section the creation seam already registered'
  )
})

await check("a delegated child keeps its parent's persona", async () => {
  const { app } = await scenario({ seed: { 'session-child': ROLE_ID }, config: { defaultRole: ROLE_ID } })
  const child = fakeAgent('session-child', { depth: 1 })
  await app.fire('agent/created', { agent: child, source: 'subagent' })
  assert.equal(child.prompt.sections.size, 0, 'a child must get no scoped persona of its own')
})

await check('a session that chose the deployment persona is never reclaimed by the default', async () => {
  const { app, stateFile } = await scenario({
    seed: { 'session-opted': NO_ROLE },
    config: { defaultRole: ROLE_ID }
  })
  const agent = fakeAgent('session-opted')
  await app.fire('agent/created', { agent })
  assert.equal(agent.prompt.sections.size, 0, 'the opt-out must survive the default')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-opted'), null, 'the opt-out is still recorded')
})

await check('a brand-new session gets the configured default at creation', async () => {
  const { app } = await scenario({ config: { defaultRole: PLAIN_ID } })
  const agent = fakeAgent('session-fresh')
  await app.fire('agent/created', { agent, source: 'user' })
  assert.equal(agent.prompt.sections.get(PERSONA_SECTION), PLAIN_PERSONA)
})

await check('a remembered role that left the library is forgotten at creation', async () => {
  const { app, stateFile } = await scenario({ seed: { 'session-gone': 'retired-role' } })
  const agent = fakeAgent('session-gone')
  await app.fire('agent/created', { agent })
  assert.equal(agent.prompt.sections.size, 0, 'a role that no longer exists must not be bound')
  assert.ok(
    app.warns.some((line) => line.includes('retired-role')),
    `expected a warning naming the role, got ${JSON.stringify(app.warns)}`
  )
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-gone'), undefined, 'the stale entry must be dropped')
})

await check('the creation listener never rejects, so it cannot roll a session creation back', async () => {
  const { app } = await scenario({ seed: { 'session-poisoned': ROLE_ID } })
  await app.fire('agent/created', {})
  await app.fire('agent/created', { agent: undefined })
  await app.fire('agent/created', { agent: { depth: 0 } })
  await app.fire('agent/created', {
    agent: {
      session: { id: 'session-poisoned' },
      depth: 0,
      ctx: {
        get() {
          throw new Error('a prompt registry that cannot be reached')
        }
      }
    }
  })
  assert.ok(
    app.warns.some((line) => line.includes('could not be restored')),
    `expected a logged complaint instead of a rejection, got ${JSON.stringify(app.warns)}`
  )
})

await check('an agent that was already live when the row loaded is bound too', async () => {
  const live = fakeAgent('session-live')
  const { app } = await scenario({ seed: { 'session-live': ROLE_ID }, liveAgents: [live] })
  await settle(() => live.prompt.sections.has(PERSONA_SECTION), 'the boot sweep to bind a live agent')
  assert.equal(live.prompt.sections.get(PERSONA_SECTION), ROLE_PERSONA)
  assert.ok(app.systemSections.length >= 1, 'the row still publishes its own prompt section')
})

if (problems.length > 0) {
  console.error(`verify-created-bind: ${problems.length} check(s) failed`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('verify-created-bind: all 8 checks hold')
