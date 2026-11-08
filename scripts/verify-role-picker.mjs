#!/usr/bin/env node
/**
 * Behavioural guard for `src/client/role-picker.js` — the `/role` popup rows.
 *
 * The picker is pure enough to test directly: `loadOptions` takes an `api` seam
 * and returns the rows, which is exactly where the bug lived.
 *
 * The property that matters: a read that FAILED is not an answer. The live-role
 * read is cosmetic — an older Host, an unmounted route — so the popup must stay
 * usable when it fails. What it must not do is render "no role is current" on top
 * of the `none` row: that is a claim about the session, and it is the one the user
 * would act on by clicking a role that is already in force, or by believing the
 * session had lost its persona.
 *
 * Exits non-zero on the first class of problem found.
 */
import assert from 'node:assert/strict'

import { loadOptions } from '../src/client/role-picker.js'

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

/** The dictionary stand-in: the key IS the text, so assertions can read it. */
const t = (key) => key

const catalogue = [
  { id: 'whale-girl', name: '鲸鱼娘', description: '温柔', mascot: null },
  { id: 'amiya', name: '阿米娅', description: '', mascot: null }
]

/**
 * A Host stand-in.
 * @param live - what `/session` answers, or an Error to make it fail.
 */
const host = (live) => async (method, path) => {
  if (path.startsWith('/session')) {
    if (live instanceof Error) throw live
    return live
  }
  if (path.startsWith('/roles')) return { roles: catalogue }
  throw new Error(`unexpected request: ${method} ${path}`)
}

const session = { sessionId: 'session-1' }
const noneRow = (rows) => rows[0]
const rowOf = (rows, id) => rows.find((row) => row.id === id)

await check('a session that reports no role ticks the none row', async () => {
  const rows = await loadOptions(session, { api: host({ liveRoleId: null }), t })
  assert.equal(noneRow(rows).active, true, 'the deployment persona is in force, so the none row is current')
  assert.equal(rowOf(rows, 'whale-girl').active, false)
})

await check('a session that reports a role ticks that role, not the none row', async () => {
  const rows = await loadOptions(session, { api: host({ liveRoleId: 'whale-girl' }), t })
  assert.equal(noneRow(rows).active, false, 'a bound session must not show the none row as current')
  assert.equal(rowOf(rows, 'whale-girl').active, true)
  assert.equal(rowOf(rows, 'amiya').active, false)
})

await check('a failed session read ticks nothing instead of claiming "none"', async () => {
  const rows = await loadOptions(session, { api: host(new Error('the route is not mounted')), t })
  assert.equal(
    noneRow(rows).active,
    false,
    'a read that failed is not an answer: claiming the none row is current misreports the session'
  )
  assert.equal(
    noneRow(rows).detail.includes('rolePickCurrent'),
    false,
    'and the detail line must not carry the "current" note either'
  )
  assert.equal(rowOf(rows, 'whale-girl').active, false, 'no row may claim to be in force')
  assert.equal(rows.length, 3, 'the list itself stays usable: none, then the library')
})

await check('a role row carries its description and id in the detail line', async () => {
  const rows = await loadOptions(session, { api: host({ liveRoleId: null }), t })
  assert.equal(rowOf(rows, 'whale-girl').detail, 'whale-girl — 温柔')
  assert.equal(rowOf(rows, 'amiya').label, '阿米娅', 'the display name is the label')
})

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`FAIL ${problem}`)
  console.error(`\nverify-role-picker: ${problems.length} of ${checks.length} checks failed`)
  process.exit(1)
}

console.log(`\nverify-role-picker: all ${checks.length} checks hold`)
