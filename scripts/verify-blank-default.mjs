#!/usr/bin/env node
/**
 * Behavioural guard for how an empty session answers "which role am I?".
 *
 * WHY: `agent/created` is the seam that reaches a session's first prompt, but it
 * only fires once the session starts talking. A session created and left empty has
 * no agent, no binding and no memory of its own, so `GET /session` — the read the
 * `/role` picker, the composer button and the mascot use — used to answer "no
 * role", and a brand-new session looked like the deployment persona until its
 * first message.
 *
 * The answer is NOT recorded at creation. Copying the default into the session's
 * memory pins that session to whatever the default was the moment it appeared, so
 * changing the default and then asking a blank session gives back the old role —
 * the memory outlives the setting it was copied from. The route therefore reads
 * the default **live**, and the moment the session speaks, its own role (recorded
 * then) takes over.
 *
 * The other half of the rule is that the default must never reclaim a session that
 * already knows what it is: a remembered role wins, `/role none` (`null`) wins,
 * and a live binding wins because it is the role the model is speaking in.
 *
 * HOW: `lib/index.js` cannot be imported as-is here, because it imports
 * `@deepseek-ai/dsh-tools` — an optional peer this repository does not install.
 * The module is imported from a temporary copy beside it whose single import line
 * points at an inline stub, so everything else is the shipped source: the code
 * under test, its relative imports and the real session-state module.
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
const ROLE_ID = 'whale-girl'
const ROLE_PERSONA = '你是DeepSeek鲸鱼娘，温柔高效的鲸御姐。'
const PLAIN_ID = 'plain-helper'
const PLAIN_PERSONA = '你是一个简洁的助手。'
const PERSONA_SECTION = 'persona-switcher:persona'
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
        'update scripts/verify-blank-default.mjs'
    )
  }
  const stub = `data:text/javascript;base64,${Buffer.from('export const defineTool = (spec) => spec\n').toString('base64')}`
  const copy = join(libDir, 'tmp-verify-blank-default.mjs')
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

/** A stand-in for the plugin host surface `apply()` drives. */
const fakeHost = (liveAgents = []) => {
  const listeners = new Map()
  const app = {
    listeners,
    warns: [],
    infos: [],
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
        return () => {
          if (typeof value === 'function') value()
        }
      },
      inject(names, run) {
        if (names.includes('agents')) run({ agents: { list: () => liveAgents } })
      },
      commands: { register: () => () => {}, view: () => new Map(), execute: async () => ({ kind: 'text', text: '' }) },
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
    if (await predicate()) return
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

/** A stand-in for one agent's scoped prompt registry. */
const scopedPrompt = () => {
  const sections = new Map()
  return {
    sections,
    section(input) {
      if (sections.has(input.name)) throw new Error(`prompt section "${input.name}" is already registered`)
      sections.set(input.name, input.text)
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

/** A stand-in for one root agent whose session log holds `seq` events. */
const fakeAgent = (sessionId, { seq } = {}) => {
  const prompt = scopedPrompt()
  return {
    session: { id: sessionId, seq },
    depth: 0,
    prompt,
    ctx: { get: (name) => (name === 'systemPrompt' ? prompt : undefined) }
  }
}

/** Ask the row's own `GET /session` (or `/revision`) route. */
const ask = async (surface, path, label = path) => {
  const captured = []
  const res = {
    writableEnded: false,
    writeHead(status, headers) {
      captured.push({ status, headers })
    },
    end(body) {
      this.writableEnded = true
      captured.push({ body })
    }
  }
  surface.serveRequest({ url: `/persona-switcher/${path}`, method: 'GET' }, res, undefined, {
    info: () => {},
    warn: () => {}
  })
  // The route awaits its own reads, so the answer lands later.
  await settle(() => captured.some((entry) => entry.body !== undefined), label)
  return JSON.parse(String(captured.find((entry) => entry.body !== undefined).body))
}

const askSession = (surface, sessionId) =>
  ask(surface, `session?session=${encodeURIComponent(sessionId)}`, `GET /session for ${sessionId}`)

const host = await loadHost()

/**
 * Load the row over a fresh temp home and a two-role library.
 * @param options - the seed entries and the config additions.
 * @returns the paths, the fake host and the `apply()` surface.
 */
const scenario = async ({ seed = {}, config = {}, liveAgents = [] } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-blank-default-'))
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
  const surface = host.apply(app.ctx, { rolesDir, exposeTool: false, ...config })
  await settle(
    // The scan line, not the mount line: "mounted; role library resolved to" is
    // logged at the end of `apply()`, before the asynchronous scan has reported.
    () => app.infos.some((line) => line.includes('role(s)')),
    'the load-time library scan'
  )
  return { dir, rolesDir, stateFile, app, surface }
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

await check('an empty session answers the configured default', async () => {
  const { surface } = await scenario({ config: { defaultRole: ROLE_ID } })
  const answer = await askSession(surface, 'session-blank')
  assert.equal(answer.liveRoleId, ROLE_ID, 'a blank session must answer with the default')
  assert.equal(answer.roleId, null, 'and its memory must stay empty — the answer is not recorded')
})

await check('changing the default changes that answer at once', async () => {
  let live = ROLE_ID
  const { app, surface } = await scenario({ config: { defaultRole: { get: () => live } } })
  assert.equal((await askSession(surface, 'session-blank')).liveRoleId, ROLE_ID)
  live = PLAIN_ID
  assert.equal(
    (await askSession(surface, 'session-blank')).liveRoleId,
    PLAIN_ID,
    'an empty session must follow the default in force, not the one it first saw'
  )
  await app.fire('loader/volatile-update', [['defaultRole']])
})

await check('the settings edit tells the browser to ask again', async () => {
  const { app, surface } = await scenario({ config: { defaultRole: ROLE_ID } })
  const before = (await ask(surface, 'revision')).revision
  await app.fire('loader/volatile-update', [['defaultRole']])
  const after = (await ask(surface, 'revision')).revision
  assert.ok(after > before, `the revision must move so a drawn session re-reads: ${before} -> ${after}`)
})

await check('a session that remembered a role keeps it', async () => {
  const { surface } = await scenario({ seed: { 'session-known': PLAIN_ID }, config: { defaultRole: ROLE_ID } })
  const answer = await askSession(surface, 'session-known')
  assert.equal(answer.liveRoleId, PLAIN_ID, 'a remembered role outranks the default')
  assert.equal(answer.roleId, PLAIN_ID)
})

await check('/role none still answers none', async () => {
  const { surface } = await scenario({ seed: { 'session-opted-out': null }, config: { defaultRole: ROLE_ID } })
  const answer = await askSession(surface, 'session-opted-out')
  assert.equal(answer.liveRoleId, null, 'an explicit opt-out must never be reclaimed by the default')
  assert.equal(answer.roleId, null)
})

await check('a live binding outranks the default', async () => {
  let live = ROLE_ID
  const { app, surface } = await scenario({ config: { defaultRole: { get: () => live } } })
  const agent = fakeAgent('session-bound')
  await app.fire('agent/created', { agent })
  assert.equal((await askSession(surface, 'session-bound')).liveRoleId, ROLE_ID)
  live = PLAIN_ID
  const answer = await askSession(surface, 'session-bound')
  assert.equal(answer.liveRoleId, ROLE_ID, 'the role a live agent speaks in is not a default to be replaced')
})

await check('no configured default answers the deployment persona', async () => {
  const { surface } = await scenario({ config: { defaultRole: '' } })
  assert.equal((await askSession(surface, 'session-blank')).liveRoleId, null)
})

await check('a default that names no role answers nothing', async () => {
  const { surface } = await scenario({ config: { defaultRole: 'no-such-role' } })
  const answer = await askSession(surface, 'session-blank')
  assert.equal(answer.liveRoleId, null, 'a phantom id must not reach the picker or the mascot')
})

await check('reading a session never writes it down', async () => {
  const { surface, stateFile } = await scenario({ config: { defaultRole: ROLE_ID } })
  await askSession(surface, 'session-blank')
  await askSession(surface, 'session-blank')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-blank'), undefined, 'the answer must not be pinned onto the session')
})

await check('a blank session opened under an old default takes the current one', async () => {
  // Opening a session also creates its agent, and that agent binds and records a
  // role — so a blank session keeps the default it was opened under unless the
  // blank case outranks its own memory and its own binding.
  let live = ROLE_ID
  const liveAgents = []
  const { app, stateFile } = await scenario({
    seed: { 'session-blank-agent': ROLE_ID },
    config: { defaultRole: { get: () => live } },
    liveAgents
  })
  const agent = fakeAgent('session-blank-agent', { seq: 1 })
  liveAgents.push(agent)
  await app.fire('agent/created', { agent })
  live = PLAIN_ID
  await app.fire('loader/volatile-update', [['defaultRole']])
  // The handler is fire-and-forget on purpose (a settings write must not wait on a
  // session), so the settled memory arrives a turn later.
  await settle(async () => (await readMemory(stateFile)).get('session-blank-agent') === PLAIN_ID, 'the blank session to follow the new default')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-blank-agent'), PLAIN_ID, 'an empty session follows the default in force now')
  const persona = agent.prompt.sections.get(PERSONA_SECTION)
  assert.ok(
    typeof persona === 'string' && persona.includes(PLAIN_PERSONA),
    `the new role must be what it speaks in next: ${persona}`
  )
})

await check('a session that has spoken is not rewritten by a default change', async () => {
  let live = ROLE_ID
  const { app, stateFile } = await scenario({ seed: { 'session-spoken': ROLE_ID }, config: { defaultRole: { get: () => live } } })
  const agent = fakeAgent('session-spoken', { seq: 24 })
  await app.fire('agent/created', { agent })
  live = PLAIN_ID
  await app.fire('loader/volatile-update', [['defaultRole']])
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-spoken'), ROLE_ID, 'a conversation keeps the role it was talking in')
})

await check('the first step still binds the default', async () => {
  const { app, stateFile } = await scenario({ config: { defaultRole: ROLE_ID } })
  const agent = fakeAgent('session-first-step', { seq: 1 })
  await app.fire('agent/created', { agent })
  const persona = agent.prompt.sections.get(PERSONA_SECTION)
  assert.ok(
    typeof persona === 'string' && persona.includes(ROLE_PERSONA),
    `the default must be what the first step speaks in: ${persona}`
  )
  await settle(async () => (await readMemory(stateFile)).get('session-first-step') === ROLE_ID, 'the first step to record it')
})

await check('opening an empty session marks its role as inherited, not chosen', async () => {
  // The browser asks `/session` as soon as the conversation is on screen, often
  // before any agent exists. The marker is what lets the route answer the current
  // default for a session whose memory still holds the default of the day — while
  // leaving that stored role exactly where it is.
  const { app, surface, stateFile } = await scenario({
    seed: { 'session-inherited': ROLE_ID },
    config: { defaultRole: PLAIN_ID }
  })
  await app.fire('session/created', { id: 'session-inherited', seq: 1 })
  await settle(async () => (await readMemory(stateFile)).isBlank('session-inherited'), 'the empty-session marker')
  const answer = await askSession(surface, 'session-inherited')
  assert.equal(answer.liveRoleId, PLAIN_ID, 'an empty session follows the default in force')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-inherited'), ROLE_ID, 'and its stored role is left untouched')
})

await check('a session that has spoken is never marked as empty', async () => {
  const { app, surface, stateFile } = await scenario({
    seed: { 'session-used': ROLE_ID },
    config: { defaultRole: PLAIN_ID }
  })
  await app.fire('session/created', { id: 'session-used', seq: 40 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal((await readMemory(stateFile)).isBlank('session-used'), false, 'a spoken session keeps its own role')
  assert.equal((await askSession(surface, 'session-used')).liveRoleId, ROLE_ID, 'and answers with it')
})

await check('/role none is never reclaimed, even while empty', async () => {
  const { app, surface, stateFile } = await scenario({ seed: { 'session-none': null }, config: { defaultRole: ROLE_ID } })
  await app.fire('session/created', { id: 'session-none', seq: 1 })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal((await readMemory(stateFile)).isBlank('session-none'), false, 'an opt-out is a decision, not a gap')
  assert.equal((await askSession(surface, 'session-none')).liveRoleId, null, 'so it answers none')
})

await check('an empty session that starts talking drops the marker', async () => {
  const { app, stateFile } = await scenario({ seed: { 'session-will-talk': ROLE_ID }, config: { defaultRole: PLAIN_ID } })
  await app.fire('session/created', { id: 'session-will-talk', seq: 1 })
  await settle(async () => (await readMemory(stateFile)).isBlank('session-will-talk'), 'the marker to appear')
  const agent = fakeAgent('session-will-talk', { seq: 1 })
  await app.fire('agent/created', { agent })
  await settle(async () => (await readMemory(stateFile)).isBlank('session-will-talk') === false, 'the marker to clear')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-will-talk'), PLAIN_ID, 'from then on it speaks in the default in force')
})

await check('a session whose log is still empty answers the default, not its pinned role', async () => {
  // Nothing announces a conversation that is merely being displayed, so the store on
  // disk is the only witness: one event in the log is the session's own header, which
  // is exactly what a session nobody has talked in holds.
  const { zstdCompressSync } = await import('node:zlib')
  const { surface, dir } = await scenario({ seed: { 'session-log-blank': ROLE_ID }, config: { defaultRole: PLAIN_ID } })
  const sessionDir = join(dir, 'sessions', '--D-work--', 'session-log-blank')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}\n')))
  const answer = await askSession(surface, 'session-log-blank')
  assert.equal(answer.liveRoleId, PLAIN_ID, 'an untouched session follows the default in force')
})

await check('a session with an actual conversation keeps its own role', async () => {
  const { zstdCompressSync } = await import('node:zlib')
  const { surface, dir } = await scenario({ seed: { 'session-log-used': ROLE_ID }, config: { defaultRole: PLAIN_ID } })
  const sessionDir = join(dir, 'sessions', '--D-work--', 'session-log-used')
  await mkdir(sessionDir, { recursive: true })
  const log = ['{"type":"session"}', '{"type":"message","role":"user"}', '{"type":"message","role":"assistant"}']
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(log.join('\n') + '\n')))
  const answer = await askSession(surface, 'session-log-used')
  assert.equal(answer.liveRoleId, ROLE_ID, 'a conversation is the role it was having')
})

await check('an unreadable log keeps the role instead of guessing', async () => {
  const { surface, dir } = await scenario({ seed: { 'session-log-broken': ROLE_ID }, config: { defaultRole: PLAIN_ID } })
  const sessionDir = join(dir, 'sessions', '--D-work--', 'session-log-broken')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'))
  const answer = await askSession(surface, 'session-log-broken')
  assert.equal(answer.liveRoleId, ROLE_ID, 'unknown must never be read as "empty"')
})

await check('a bound role does not outrank a session with no conversation', async () => {
  // The shape that kept failing in the field: opening an empty session creates its
  // agent, the agent binds the default *of that moment* and records it, and the
  // binding then outranked every later reading — so the label stayed on the role the
  // session was opened under even though nothing had been said in it.
  const { zstdCompressSync } = await import('node:zlib')
  const { app, surface, dir } = await scenario({ config: { defaultRole: ROLE_ID } })
  const sessionId = 'session-bound-blank'
  const sessionDir = join(dir, 'sessions', '--D-work--', `session-${sessionId}`)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}\n')))
  // `seq: 3` is deliberate: the host counts the header and will not let the log
  // alone prove emptiness, which is exactly when the binding used to win.
  const agent = fakeAgent(sessionId, { seq: 3 })
  await app.fire('agent/created', { agent })
  assert.equal(agent.prompt.sections.get(PERSONA_SECTION).includes(ROLE_PERSONA), true, 'the agent starts on the default')
  const answer = await askSession(surface, sessionId)
  assert.equal(answer.liveRoleId, ROLE_ID, 'an empty session answers the default even with a binding on it')
})

await check('a blank session with no configured default runs the deployment persona', async () => {
  // The label already answered "none" here, but the prompt kept the inherited binding:
  // the picker and the model disagreed about the same session.
  const { zstdCompressSync } = await import('node:zlib')
  const { app, surface, stateFile, dir } = await scenario({
    seed: { 'session-no-default': ROLE_ID },
    config: { defaultRole: '' }
  })
  // The label needs the same evidence the prompt has: the log still holding nothing
  // but the session header. Without it the route cannot tell an empty session from a
  // quiet one and (correctly) keeps the recorded role.
  const sessionDir = join(dir, 'sessions', '--D-work--', 'session-no-default')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from('{"type":"session"}\n')))
  const agent = fakeAgent('session-no-default', { seq: 1 })
  await app.fire('agent/created', { agent })
  const persona = agent.prompt.sections.get(PERSONA_SECTION) ?? ''
  assert.equal(persona.includes(ROLE_PERSONA), false, `the old role must not stay in the prompt: ${persona}`)
  assert.equal((await askSession(surface, 'session-no-default')).liveRoleId, null, 'and the label agrees')
  const memory = await readMemory(stateFile)
  assert.equal(memory.get('session-no-default'), ROLE_ID, 'an empty session keeps its record for the next default')
})

await check('a marker is turned into a decision once that session has spoken', async () => {
  // Otherwise a conversation that has been running on the deployment persona would be
  // reclaimed by whatever default is configured later.
  const { zstdCompressSync } = await import('node:zlib')
  let live = ROLE_ID
  const { app, surface, stateFile, dir } = await scenario({
    seed: { 'session-spoke-none': ROLE_ID },
    config: { defaultRole: { get: () => live } }
  })
  const sessionDir = join(dir, 'sessions', '--D-work--', 'session-spoke-none')
  const log = (lines) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), log(['{"type":"session"}']))
  assert.equal((await askSession(surface, 'session-spoke-none')).liveRoleId, ROLE_ID, 'empty, so the default answers')
  await settle(async () => (await readMemory(stateFile)).isBlank('session-spoke-none'), 'the marker the route writes')

  live = ''
  await writeFile(
    join(sessionDir, 'session.v4.jsonl.zstd'),
    log(['{"type":"session"}', '{"type":"message"}', '{"type":"message"}'])
  )
  const agent = fakeAgent('session-spoke-none', { seq: 9 })
  await app.fire('agent/created', { agent })
  assert.equal(
    (agent.prompt.sections.get(PERSONA_SECTION) ?? '').includes(ROLE_PERSONA),
    false,
    'it now speaks the deployment persona'
  )
  await settle(async () => (await readMemory(stateFile)).get('session-spoke-none') === null, 'the opt-out to be recorded')
  const memory = await readMemory(stateFile)
  assert.equal(memory.isBlank('session-spoke-none'), false, 'and the marker is gone, so no later default claims it')
})

if (problems.length > 0) {
  console.error(`\nverify-blank-default: ${problems.length} check(s) failed`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-blank-default: all 22 checks hold`)

