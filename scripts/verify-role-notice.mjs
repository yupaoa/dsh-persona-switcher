#!/usr/bin/env node
/**
 * Behavioural guard for the role-change notice.
 *
 * WHY: DSH's model route reports `systemPromptUpdate: 'in-history'`, so a
 * switched persona arrives as an *additional* system node while the
 * transcript's own earlier assistant replies keep demonstrating the role that
 * was left behind. The notice is the in-band statement that resolves that
 * conflict in favour of the persona in force, so it has to cover **every**
 * transition, not only role-to-role ones: `/role none` dismisses a role on
 * purpose, and a model that is never told keeps answering in the dismissed
 * role's voice. The inverse mistake — announcing rebinds that changed nothing
 * the session can read — is guarded here too, because that would put a bogus
 * "role change" message in front of every resumed session.
 *
 * HOW: `lib/index.js` cannot be imported as-is here, because it imports
 * `@deepseek-ai/dsh-tools` — an optional peer this repository does not install.
 * The module is imported from a temporary copy beside it whose single import
 * line points at an inline stub, so everything else is the shipped source. The
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
import { createSessionState } from '../lib/session-state.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
/** The section a role's persona registers. */
const PERSONA_SECTION = 'deployment:persona-prefix'
/** The message-source form the injected notice carries. */
const NOTICE_FORM = 'role-change'
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
        'update scripts/verify-role-notice.mjs'
    )
  }
  const stub = `data:text/javascript;base64,${Buffer.from('export const defineTool = (spec) => spec\n').toString('base64')}`
  const copy = join(libDir, 'tmp-verify-role-notice.mjs')
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
      if (sections.has(input.name)) {
        throw new Error(`prompt section "${input.name}" is already registered in this scope`)
      }
      sections.set(input.name, input.text)
      registered.push(input.text)
      return () => {
        registered.splice(registered.indexOf(input.text), 1)
        sections.delete(input.name)
      }
    },
    getSectionOrder: () => 0
  }
}

/** A stand-in for one agent. */
const fakeAgent = (sessionId) => {
  const prompt = scopedPrompt()
  return {
    session: { id: sessionId },
    depth: 0,
    prompt,
    ctx: { get: (name) => (name === 'systemPrompt' ? prompt : undefined) }
  }
}

/** A stand-in for the plugin host surface `apply()` drives. */
const fakeHost = () => {
  const listeners = new Map()
  const app = {
    listeners,
    warns: [],
    infos: [],
    commands: [],
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
          let step = value.next()
          while (step.done !== true) step = value.next()
        }
        return () => {}
      },
      inject(names, run) {
        if (names.includes('agents')) run({ agents: { list: () => [] } })
      },
      commands: {
        register: (definition) => {
          app.commands.push(definition)
          return () => {}
        },
        view: () => new Map(),
        execute: async () => ({ kind: 'text', text: '' })
      },
      systemPrompt: { section: () => () => {} },
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

const host = await loadHost()

/**
 * Load the row over a fresh temp home and a two-role library.
 * @param options - the seed entries and the config additions.
 * @returns the paths and the fake host the row was applied to.
 */
const scenario = async ({ seed = {}, config = {} } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-notice-'))
  tempDirs.push(dir)
  const rolesDir = join(dir, 'roles')
  await mkdir(join(rolesDir, ROLE_ID), { recursive: true })
  await writeFile(join(rolesDir, ROLE_ID, 'ROLE.md'), roleFile(ROLE_ID, ROLE_PERSONA))
  await writeFile(join(rolesDir, `${PLAIN_ID}.md`), roleFile(PLAIN_ID, PLAIN_PERSONA))
  process.env.DSH_HOME = dir
  const stateFile = join(dir, 'persona-switcher', 'sessions.json')
  const seeded = createSessionState({ file: stateFile, warn: () => {} })
  for (const [sessionId, role] of Object.entries(seed)) await seeded.set(sessionId, role)
  const app = fakeHost()
  host.apply(app.ctx, { rolesDir, exposeTool: false, announceRoleChange: true, ...config })
  await settle(() => app.infos.some((line) => line.includes('role library')), 'the load-time library scan')
  return { dir, rolesDir, stateFile, app }
}

/** Run one `/role` line the way the harness would, and return the command result. */
const runCommand = async (app, agent, rawInput) => {
  const command = app.commands.find((definition) => definition.name === 'role')
  assert.ok(command !== undefined, 'the /role command must be registered')
  return command.handler({ agent, rawInput })
}

/** Drive one model step and return the notices it injects. */
const step = async (app, agent) => {
  const decision = { kind: 'continue', messages: [] }
  const returned = await app.fire('agent/pre-step', { agent, messages: [], step: 2 }, async () => decision)
  return returned.messages.filter((message) => message.source?.form === NOTICE_FORM)
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

await check('/role none announces the switch back to the deployment persona', async () => {
  const { app } = await scenario({ seed: { 'session-none': ROLE_ID } })
  const agent = fakeAgent('session-none')
  await app.fire('agent/created', { agent })
  const result = await runCommand(app, agent, 'none')
  assert.equal(result.kind, 'success', `expected the command to succeed, got ${JSON.stringify(result)}`)
  assert.equal(agent.prompt.sections.size, 0, 'the dismissed role must leave the session prompt')
  const notices = await step(app, agent)
  assert.equal(notices.length, 1, `expected exactly one notice, got ${JSON.stringify(notices.map((n) => n.source))}`)
  const [notice] = notices
  assert.equal(notice.source.from, ROLE_ID, 'the notice must name the role that was left')
  assert.equal(notice.source.to, '', 'the destination is the deployment persona, an empty role id')
  const text = notice.content.map((block) => block.text ?? '').join('')
  assert.ok(text.includes(ROLE_ID), `the notice must name the dismissed role: ${text}`)
  assert.ok(
    text.includes('deployment persona'),
    `the notice must state which persona is in force now: ${text}`
  )
  assert.ok(text.includes('<system-reminder>'), `the notice must stay a system reminder: ${text}`)
  // The notice is one-shot: a second step must not repeat it.
  assert.deepEqual(await step(app, agent), [], 'the notice must not be re-injected on the next step')
})

await check('a switch from the deployment persona onto a role is announced too', async () => {
  const { app } = await scenario()
  const agent = fakeAgent('session-plain')
  await app.fire('agent/created', { agent })
  assert.equal(agent.prompt.sections.size, 0, 'a session with no seed and no default carries no role')
  const result = await runCommand(app, agent, PLAIN_ID)
  assert.equal(result.kind, 'success', `expected the command to succeed, got ${JSON.stringify(result)}`)
  const notices = await step(app, agent)
  assert.equal(notices.length, 1, `expected exactly one notice, got ${JSON.stringify(notices.map((n) => n.source))}`)
  assert.equal(notices[0].source.from, '', 'the side left behind is the deployment persona')
  assert.equal(notices[0].source.to, PLAIN_ID, 'the notice must name the role now in force')
})

await check('a role-to-role switch keeps its notice, naming both roles', async () => {
  const { app } = await scenario({ seed: { 'session-swap': ROLE_ID } })
  const agent = fakeAgent('session-swap')
  await app.fire('agent/created', { agent })
  const result = await runCommand(app, agent, PLAIN_ID)
  assert.equal(result.kind, 'success', `expected the command to succeed, got ${JSON.stringify(result)}`)
  const notices = await step(app, agent)
  assert.equal(notices.length, 1, `expected exactly one notice, got ${JSON.stringify(notices.map((n) => n.source))}`)
  assert.equal(notices[0].source.from, ROLE_ID, 'the notice must name the role that was left')
  assert.equal(notices[0].source.to, PLAIN_ID, 'the notice must name the role now in force')
  const text = notices[0].content.map((block) => block.text ?? '').join('')
  assert.ok(text.includes(ROLE_ID) && text.includes(PLAIN_ID), `both roles must be named: ${text}`)
})

await check('/role none on a session that carries no role announces nothing', async () => {
  const { app } = await scenario()
  const agent = fakeAgent('session-already-plain')
  await app.fire('agent/created', { agent })
  const result = await runCommand(app, agent, 'none')
  assert.equal(result.kind, 'success', `expected the command to succeed, got ${JSON.stringify(result)}`)
  assert.deepEqual(await step(app, agent), [], 'a no-op opt-out must not claim a role change')
})

await check('announceRoleChange: false keeps every transition silent', async () => {
  const { app } = await scenario({ seed: { 'session-quiet': ROLE_ID }, config: { announceRoleChange: false } })
  const agent = fakeAgent('session-quiet')
  await app.fire('agent/created', { agent })
  await runCommand(app, agent, 'none')
  assert.equal(agent.prompt.sections.size, 0, 'the switch itself must still happen')
  assert.deepEqual(await step(app, agent), [], 'the opt-out must suppress the notice')
})

await check('a resumed session restored onto the same role injects no notice', async () => {
  const { app } = await scenario({ seed: { 'session-resumed': ROLE_ID } })
  const agent = fakeAgent('session-resumed')
  await app.fire('agent/created', { agent })
  assert.equal(agent.prompt.sections.get(PERSONA_SECTION), ROLE_PERSONA, 'the persona is restored')
  assert.deepEqual(await step(app, agent), [], 'restoring what the session already had is not a role change')
})

await check('a remembered role that vanished from the library announces the hand-over', async () => {
  const { app } = await scenario({
    seed: { 'session-ghost': 'ghost-role' },
    config: { defaultRole: ROLE_ID }
  })
  const agent = fakeAgent('session-ghost')
  await app.fire('agent/created', { agent })
  const notices = await step(app, agent)
  assert.equal(notices.length, 1, `expected exactly one notice, got ${JSON.stringify(notices.map((n) => n.source))}`)
  assert.equal(notices[0].source.from, 'ghost-role', 'the notice must name the role that is gone')
  assert.equal(notices[0].source.to, ROLE_ID, 'the notice must name the role that took over')
})

if (problems.length > 0) {
  console.error(`verify-role-notice: ${problems.length} check(s) failed`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('verify-role-notice: all 7 checks hold')
