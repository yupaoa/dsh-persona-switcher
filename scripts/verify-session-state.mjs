#!/usr/bin/env node
/**
 * Behavioural guard for the durable session state.
 *
 * Run with `npm test` (CI does the same on every push, PR and release).
 *
 * The state file is what makes a role switch survive a DSH restart: a binding
 * lives in one agent's prompt scope, and the harness tears that scope down with
 * the agent. Two things therefore have to hold, and both are checked here
 * against a real file in a temporary directory:
 *
 *   1. The store round-trips a choice across processes, writes atomically, does
 *      not rewrite an unchanged value, keeps its retention window, and treats a
 *      missing file as empty while quarantining a corrupt one instead of
 *      deleting it.
 *   2. The restore policy (`planRestore`) resolves every combination of "bound
 *      now", "remembered", "configured default" and "still in the library" —
 *      including the two dangerous ones: a stale entry must never resurrect a
 *      deleted role, and a role in force must never be silently replaced.
 *   3. A deliberate opt-out (`/role none`, stored as `null`) is a decision and
 *      not a gap: it must survive a restart *and* a configured `defaultRole`,
 *      which the pre-step would otherwise apply to any session without a memory.
 *
 * Exits non-zero on the first class of problem found.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NO_ROLE,
  STALE_AFTER_MS,
  STATE_VERSION,
  createSessionState,
  planRestore
} from '../lib/session-state.js'

const problems = []
const checks = []

const check = async (name, fn) => {
  checks.push(name)
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    problems.push(`${name}: ${error?.message ?? String(error)}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'persona-switcher-state-'))
const file = join(dir, 'persona-switcher', 'sessions.json')
const write = (value) => writeFile(file, value, 'utf8')
const read = async () => JSON.parse(await readFile(file, 'utf8'))

// ------------------------------------------------------- the durable store
const warnings = []
const state = createSessionState({ file, warn: (message) => warnings.push(message) })

await check('a missing state file loads as an empty memory', async () => {
  assert.equal(await state.load(), 0)
  assert.deepEqual(warnings, [], 'a first run must not warn')
  assert.equal(state.get('session-1'), undefined)
})

await check('a choice is written to disk and read back by the next process', async () => {
  assert.equal(await state.set('session-1', 'whale-girl'), true)
  const raw = await read()
  assert.equal(raw.version, STATE_VERSION)
  assert.equal(raw.sessions['session-1'].role, 'whale-girl')
  assert.ok(
    Number.isFinite(Date.parse(raw.sessions['session-1'].at)),
    'the entry must carry a readable timestamp'
  )

  const restarted = createSessionState({ file })
  assert.equal(await restarted.load(), 1, 'a restart must see the stored choice')
  assert.equal(restarted.get('session-1'), 'whale-girl')
})

await check('re-remembering the same role does not rewrite the file', async () => {
  const before = await readFile(file, 'utf8')
  assert.equal(await state.set('session-1', 'whale-girl'), false)
  assert.equal(await readFile(file, 'utf8'), before)
})

await check('no temporary file survives a write', async () => {
  assert.deepEqual(await readdir(join(dir, 'persona-switcher')), ['sessions.json'])
})

await check('a failed write does not poison every later save', async () => {
  // A directory sitting on the destination path makes the atomic write fail at
  // `rm(file, { force: true })`. That failure must belong to this one attempt:
  // the queue is shared, so a rejection left on it would fail every later save
  // with the first error and the store could never recover in-process.
  const trapped = join(dir, 'trapped', 'sessions.json')
  await mkdir(join(trapped, 'occupied'), { recursive: true })
  const store = createSessionState({ file: trapped })
  await assert.rejects(store.set('session-a', 'whale-girl'), 'a save onto a directory must fail')

  await rm(trapped, { recursive: true, force: true })
  assert.equal(await store.set('session-b', 'whale-girl'), true, 'the next save must be attempted')
  const raw = JSON.parse(await readFile(trapped, 'utf8'))
  assert.equal(raw.sessions['session-b'].role, 'whale-girl', 'the recovered save must reach disk')

  // And it stays healthy afterwards, including the no-op path.
  assert.equal(await store.set('session-b', 'whale-girl'), false)
  assert.equal(await store.remove('session-b'), true)
  const after = JSON.parse(await readFile(trapped, 'utf8')).sessions
  assert.equal(after['session-b'], undefined, 'the removal must reach disk too')
})

await check('clearing a session drops it from the file', async () => {
  assert.equal(await state.remove('session-1'), true)
  assert.equal(state.get('session-1'), undefined)
  assert.equal(await state.remove('session-1'), false, 'clearing twice must not write again')
  assert.deepEqual((await read()).sessions, {})
})

await check('an explicit opt-out is stored, not erased', async () => {
  assert.equal(await state.set('session-opt', NO_ROLE), true)
  const raw = await read()
  assert.equal(raw.sessions['session-opt'].role, null, 'the opt-out is stored as a null role')
  assert.ok(
    Number.isFinite(Date.parse(raw.sessions['session-opt'].at)),
    'an opt-out carries a timestamp like any other choice'
  )

  const restarted = createSessionState({ file })
  assert.equal(await restarted.load(), 1)
  assert.notEqual(restarted.get('session-opt'), undefined, 'an opt-out is a decision, not an absent entry')
  assert.equal(restarted.get('session-opt'), NO_ROLE)
  assert.deepEqual(restarted.snapshot(), { 'session-opt': null })

  assert.equal(await state.remove('session-opt'), true)
  assert.deepEqual((await read()).sessions, {})
})

await check('a corrupt state file is quarantined, never deleted', async () => {
  await write('{ not json')
  const complaints = []
  const broken = createSessionState({ file, warn: (message) => complaints.push(message) })
  assert.equal(await broken.load(), 0)
  assert.equal(complaints.length, 1)
  assert.match(complaints[0], /no session map/)
  assert.equal(await readFile(`${file}.corrupt`, 'utf8'), '{ not json')
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
})

await check('a quarantine that cannot move the file says so', async () => {
  // Keeping the bad file matters: a person can still read it and repair the entry.
  // The move used to fail silently, so "quarantined" and "left in place and then
  // overwritten by the next save" looked identical from outside.
  await write('{ not json')
  await rm(`${file}.corrupt`, { force: true })
  await mkdir(join(`${file}.corrupt`, 'occupied'), { recursive: true })
  const complaints = []
  const broken = createSessionState({ file, warn: (message) => complaints.push(message) })
  assert.equal(await broken.load(), 0)
  assert.ok(
    complaints.some((message) => /could not be moved aside/.test(message)),
    `the failed quarantine must be reported, got: ${JSON.stringify(complaints)}`
  )
  await rm(`${file}.corrupt`, { recursive: true, force: true })
})

await check('a sessions list is treated as malformed', async () => {
  await write(JSON.stringify({ version: STATE_VERSION, sessions: [] }))
  const complaints = []
  const broken = createSessionState({ file, warn: (message) => complaints.push(message) })
  assert.equal(await broken.load(), 0)
  assert.equal(complaints.length, 1)
})

await check('a bare string entry still loads, junk entries are dropped', async () => {
  await write(
    JSON.stringify({
      version: STATE_VERSION,
      sessions: {
        legacy: 'plain',
        'session-2': { role: 'whale-girl' },
        explicit: { role: null },
        empty: { role: '' },
        nullish: null,
        numeric: 7,
        '': { role: 'ignored' }
      }
    })
  )
  const store = createSessionState({ file })
  assert.equal(await store.load(), 3)
  assert.deepEqual(store.snapshot(), { legacy: 'plain', 'session-2': 'whale-girl', explicit: null })
})

await check('entries older than the retention window are dropped on the next write', async () => {
  const clock = Date.parse('2026-06-01T00:00:00Z')
  const stale = new Date(clock - STALE_AFTER_MS - 86_400_000).toISOString()
  const live = new Date(clock - 86_400_000).toISOString()
  await write(
    JSON.stringify({
      version: STATE_VERSION,
      sessions: { dead: { role: 'whale-girl', at: stale }, live: { role: 'plain', at: live } }
    })
  )
  const store = createSessionState({ file, now: () => clock })
  assert.equal(await store.load(), 2, 'a read keeps both; the file is only rewritten on demand')
  assert.equal(await store.set('new', 'whale-girl'), true)
  assert.deepEqual(store.snapshot(), { live: 'plain', new: 'whale-girl' })
  assert.deepEqual(Object.keys((await read()).sessions).sort(), ['live', 'new'])
})

await check('a deliberate opt-out is never aged out', async () => {
  // `/role none` is a decision, not a gap: the entry is what keeps the configured
  // `defaultRole` from claiming the session again on its next model step. Ageing
  // it out of the retention window silently re-handed the session to the default.
  const clock = Date.parse('2026-06-01T00:00:00Z')
  const stale = new Date(clock - STALE_AFTER_MS - 86_400_000).toISOString()
  await write(
    JSON.stringify({
      version: STATE_VERSION,
      sessions: { opted: { role: null, at: stale }, forgotten: { role: 'whale-girl', at: stale } }
    })
  )
  const store = createSessionState({ file, now: () => clock })
  assert.equal(await store.load(), 2)
  assert.equal(await store.set('fresh', 'plain'), true)
  assert.deepEqual(
    Object.keys((await read()).sessions).sort(),
    ['fresh', 'opted'],
    'the opt-out must outlive the window; the stale binding may not'
  )
})

await check('re-using a role refreshes an entry close to expiring', async () => {
  // The other half of the same problem: `set` treated an unchanged value as "no
  // write", so an entry in daily use still aged out from under the session.
  const clock = Date.parse('2026-06-01T00:00:00Z')
  const nearExpiry = new Date(clock - STALE_AFTER_MS + 86_400_000).toISOString()
  await write(JSON.stringify({ version: STATE_VERSION, sessions: { kept: { role: 'plain', at: nearExpiry } } }))
  const store = createSessionState({ file, now: () => clock })
  await store.load()
  assert.equal(
    await store.set('kept', 'plain'),
    true,
    'a re-selection must be recorded, or an entry in daily use expires under the session'
  )
  assert.equal(Date.parse((await read()).sessions.kept.at), clock, 'the timestamp must move to the re-selection')
})

await check('the store refuses to be built without a file', () => {
  assert.throws(() => createSessionState({}), /file path/)
  assert.throws(() => createSessionState({ file: '  ' }), /file path/)
})

await check('remembering needs both a session id and a role', async () => {
  const store = createSessionState({ file })
  await store.load()
  const before = store.size
  await assert.rejects(store.set('', 'whale-girl'), /session id/)
  await assert.rejects(store.set('   ', 'whale-girl'), /session id/)
  await assert.rejects(store.set('session-3', '   '), /role id/)
  assert.equal(store.size, before, 'a refused write must not change the memory')
  assert.equal(store.get('session-3'), undefined)
})

// ------------------------------------------------------- the restore policy
const library = new Set(['whale-girl', 'plain'])
const has = (id) => library.has(id)

const cases = [
  ['a role in force that the memory agrees with needs nothing', { bound: 'whale-girl', remembered: 'whale-girl' }, { action: 'idle' }],
  ['a role in force that the memory lacks is persisted', { bound: 'whale-girl' }, { action: 'persist', role: 'whale-girl' }],
  ['a role in force wins over a disagreeing memory', { bound: 'plain', remembered: 'whale-girl' }, { action: 'persist', role: 'plain' }],
  ['the remembered role is re-bound after a restart', { remembered: 'whale-girl' }, { action: 'bind', role: 'whale-girl' }],
  ['the configured default binds a session that never chose', { fallback: 'plain' }, { action: 'bind', role: 'plain' }],
  ['the remembered role wins over the default', { remembered: 'whale-girl', fallback: 'plain' }, { action: 'bind', role: 'whale-girl' }],
  ['a remembered role that left the library is forgotten', { remembered: 'ghost' }, { action: 'forget' }],
  ['a remembered role that left the library falls back to the default', { remembered: 'ghost', fallback: 'plain' }, { action: 'forget-and-bind', role: 'plain' }],
  ['a forgotten role with no usable default leaves the deployment persona in force', { remembered: 'ghost', fallback: 'ghost' }, { action: 'forget' }],
  ['a default that left the library is ignored', { fallback: 'ghost' }, { action: 'idle' }],
  ['an empty memory with no default is idle', {}, { action: 'idle' }],
  ['an opt-out is a decision, so the default must not claim the session', { remembered: NO_ROLE, fallback: 'plain' }, { action: 'idle' }],
  ['an opt-out with no default is idle too', { remembered: NO_ROLE }, { action: 'idle' }],
  ['a role bound after an opt-out is persisted', { bound: 'whale-girl', remembered: NO_ROLE }, { action: 'persist', role: 'whale-girl' }]
]
for (const [name, input, expected] of cases) {
  await check(name, () => {
    assert.deepEqual(planRestore({ ...input, has }), expected)
  })
}

await check('the policy consults the library instead of guessing', () => {
  assert.throws(() => planRestore({}), /has\(\) predicate/)
})

// ------------------------------------------------------------------ report
await rm(dir, { recursive: true, force: true })
for (const problem of problems) console.error(`FAIL ${problem}`)
if (problems.length > 0) {
  console.error(`\nverify-session-state: ${problems.length} of ${checks.length} check(s) failed`)
  process.exit(1)
}
console.log(`verify-session-state: all ${checks.length} checks hold`)
