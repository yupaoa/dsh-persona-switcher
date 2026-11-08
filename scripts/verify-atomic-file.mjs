#!/usr/bin/env node
/**
 * Behavioural guard for `lib/atomic-file.js`, the one replacement-write helper
 * the state file and the artwork map both use.
 *
 * Why this file exists: both of those files used to write through
 * "`rm(destination)` then `rename(temp, destination)`", because Windows `rename`
 * refuses to replace an existing file. That sequence has a window in which the
 * destination simply does not exist, and a rename that then fails (a virus
 * scanner or an editor holding the file, the exact case the retry is for) leaves
 * it missing for good — the loader then reads "no file" as "nothing was ever
 * bound" and every role loses its memory or its artwork.
 *
 * The properties checked here are the ones a reader of the helper cannot confirm:
 *
 *   1. A replacement is a replacement: the destination holds the new bytes and
 *      no temporary is left behind.
 *   2. A rename that keeps failing falls back to a copy, so the destination is
 *      still updated rather than deleted.
 *   3. When the copy fallback fails too, the error surfaces AND the previous
 *      destination is untouched — the failure mode must be "old content", never
 *      "no content".
 *   4. A transient rename failure is retried, and the copy fallback is not
 *      reached for it.
 *
 * Exits non-zero on the first class of problem found.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeFileAtomic } from '../lib/atomic-file.js'

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

const errno = (code) => Object.assign(new Error(code), { code })
const quiet = async () => {}
/** No sleeping in a test run: the helper's delay is injectable for this. */
const noDelay = async () => {}

const cases = await mkdtemp(join(tmpdir(), 'persona-switcher-atomic-'))
let caseNo = 0
const freshDir = async () => {
  caseNo += 1
  const dir = join(cases, `case-${caseNo}`)
  await writeFile(join(cases, '.keep'), '', 'utf8').catch(quiet)
  await rm(dir, { recursive: true, force: true })
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }))
  return dir
}
const leftovers = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'))

await check('a replacement lands the new bytes and leaves no temporary', async () => {
  const dir = await freshDir()
  const file = join(dir, 'state.json')
  await writeFile(file, 'old', 'utf8')

  await writeFileAtomic(file, 'new', { delay: noDelay })

  assert.equal(await readFile(file, 'utf8'), 'new')
  assert.deepEqual(await leftovers(dir), [], 'no *.tmp may survive a successful write')
})

await check('creating a new file leaves no temporary behind', async () => {
  const dir = await freshDir()
  const file = join(dir, 'state.json')

  await writeFileAtomic(file, 'first', { delay: noDelay })

  assert.equal(await readFile(file, 'utf8'), 'first')
  assert.deepEqual(await leftovers(dir), [])
})

await check('a rename that keeps failing falls back to a copy', async () => {
  const dir = await freshDir()
  const file = join(dir, 'state.json')
  await writeFile(file, 'old', 'utf8')

  await writeFileAtomic(file, 'new', {
    rename: async () => {
      throw errno('EPERM')
    },
    delay: noDelay
  })

  assert.equal(await readFile(file, 'utf8'), 'new', 'the copy fallback must still replace the file')
  assert.deepEqual(await leftovers(dir), [])
})

await check('a transient rename failure is retried and never reaches the copy fallback', async () => {
  const dir = await freshDir()
  const file = join(dir, 'state.json')
  await writeFile(file, 'old', 'utf8')

  let attempts = 0
  await writeFileAtomic(file, 'new', {
    rename: async (...args) => {
      attempts += 1
      if (attempts === 1) throw errno('EBUSY')
      const { rename } = await import('node:fs/promises')
      return rename(...args)
    },
    copyFile: async () => {
      throw new Error('the copy fallback must not be reached for a transient failure')
    },
    delay: noDelay
  })

  assert.equal(attempts, 2, 'the retry must make a second rename attempt')
  assert.equal(await readFile(file, 'utf8'), 'new')
  assert.deepEqual(await leftovers(dir), [])
})

await check('when the copy fallback fails too, the previous file survives', async () => {
  const dir = await freshDir()
  const file = join(dir, 'state.json')
  await writeFile(file, 'old', 'utf8')

  await assert.rejects(
    writeFileAtomic(file, 'new', {
      rename: async () => {
        throw errno('EPERM')
      },
      copyFile: async () => {
        throw errno('EACCES')
      },
      delay: noDelay
    }),
    'the failure must surface'
  )

  assert.equal(await readFile(file, 'utf8'), 'old', 'a failed replacement must leave the old content in place')
  assert.deepEqual(await leftovers(dir), [], 'a failed write must not leave a temporary behind')
})

await rm(cases, { recursive: true, force: true })

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`FAIL ${problem}`)
  console.error(`\nverify-atomic-file: ${problems.length} of ${checks.length} checks failed`)
  process.exit(1)
}

console.log(`\nverify-atomic-file: all ${checks.length} checks hold`)
