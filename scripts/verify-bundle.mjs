#!/usr/bin/env node
/**
 * Invariant guard for this plugin's two hard rules and its publish payload.
 *
 * Run with `npm run verify` (CI does the same on every push and PR).
 *
 *   1. The browser module id inside `lib/client.js` must equal the resolved
 *      package name from `package.json` — NOT the Cordis row id
 *      `persona-switcher` from `cordis.patch.yml`. The host keys browser module
 *      identity by the manifest package name; a mismatch is fatal, producing
 *      `web boot: N entry did not activate` and a failed app start.
 *   2. The host row must have exactly one source: this package's own
 *      `dsh.bundle.patch`. Two active loader sources resolving to the same
 *      package name fail to compose.
 *   3. The persona route must stay a per-agent prompt section. Recomposing an
 *      agent preset replaces the agent's whole plugin composition, so the
 *      session loses its tools and commands along with the old identity
 *      (measured while switching: 33 model-facing tools and 10 commands became
 *      7 and 7). This rule keeps that defect from returning through a refactor.
 *   4. A switch must be durable. The binding lives in one agent scope and dies
 *      with it, so the choice is mirrored into `lib/session-state.js`'s file and
 *      re-applied on the session's pre-step. Both halves must stay wired.
 *
 * It also keeps the publish payload honest: `lib/` must be listed file by file
 * so stale backups (for example `lib/client.js.bak-*`) can never be published.
 *
 * Exits non-zero on the first class of problem found.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const notes = []

const read = async (rel) => {
  try {
    return await readFile(join(root, rel), 'utf8')
  } catch (error) {
    problems.push(`cannot read ${rel}: ${error.message}`)
    return null
  }
}

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const ROW_ID = 'persona-switcher'

// ---------------------------------------------------------------- rule 1
const bundle = await read('lib/client.js')
if (bundle !== null) {
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*")/.exec(bundle)
  if (!match) {
    problems.push(
      'lib/client.js does not open with window.__ModuleLoader__.load({ id, factory }) ' +
        '— rebuild with `npm run build`'
    )
  } else {
    const id = JSON.parse(match[1])
    if (id === pkg.name) {
      notes.push(`bundle module id = package name (${id})`)
    } else if (id === ROW_ID) {
      problems.push(
        `bundle module id is the Cordis row id ${JSON.stringify(ROW_ID)}; it must be the ` +
          `package name ${JSON.stringify(pkg.name)} (hard rule 1) — the app will fail to boot`
      )
    } else {
      problems.push(
        `bundle module id ${JSON.stringify(id)} !== package name ${JSON.stringify(pkg.name)} ` +
          '(hard rule 1)'
      )
    }
  }

  if (!bundle.includes('persona-switcher-settings-style')) {
    problems.push('lib/client.js does not contain the settings stylesheet id — stale or truncated build?')
  }
}

// ---------------------------------------------------------------- rule 2
const patch = await read('cordis.patch.yml')
if (patch !== null) {
  const inserts = patch.match(/^\s*-\s*insert:\s*$/gm) ?? []
  if (inserts.length !== 1) {
    problems.push(
      `cordis.patch.yml must contain exactly one "- insert:" block, found ${inserts.length}`
    )
  }
  const namePattern = new RegExp(`name:\\s*['"]${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`)
  if (!namePattern.test(patch)) {
    problems.push(`cordis.patch.yml does not provide a row named ${JSON.stringify(pkg.name)} (hard rule 2)`)
  }
  if (!new RegExp(`id:\\s*${ROW_ID}\\b`).test(patch)) {
    problems.push(`cordis.patch.yml does not declare the row id ${JSON.stringify(ROW_ID)}`)
  }
  const declared = pkg.dsh?.bundle?.patch
  if (declared !== './cordis.patch.yml') {
    problems.push(`package.json dsh.bundle.patch is ${JSON.stringify(declared)}, expected "./cordis.patch.yml"`)
  } else {
    notes.push('bundle patch provided by this package only (cordis.patch.yml)')
  }
}

// ---------------------------------------------------------------- rule 3
// The persona route must be a per-agent prompt section, never a preset
// recomposition — see the header comment.
const host = await read('lib/index.js')
if (host !== null) {
  if (/\.\s*recompose\s*\(/.test(host)) {
    problems.push(
      'lib/index.js calls recompose(); a role must be a per-agent prompt section ' +
        '(lib/persona-binding.js) because recomposition also replaces the tools (hard rule 3)'
    )
  }
  if (/agentPresets\s*\.\s*(register|select|recompose)\s*\(/.test(host)) {
    problems.push(
      'lib/index.js registers with, selects through, or recomposes the agent-preset registry ' +
        '(hard rule 3)'
    )
  }
  if (!host.includes("from './persona-binding.js'")) {
    problems.push('lib/index.js does not import the persona binding module (hard rule 3)')
  }
}

const binder = await read('lib/persona-binding.js')
if (binder !== null) {
  for (const needle of ['deployment:persona-prefix', 'DEPLOYMENT_PERSONA_PREFIX']) {
    if (!binder.includes(needle)) {
      problems.push(
        `lib/persona-binding.js does not mention ${needle}: the per-agent override must register ` +
          'the same section name and order the global deployment persona uses (hard rule 3)'
      )
    }
  }
  if (!binder.includes('prompt.section(')) {
    problems.push('lib/persona-binding.js does not register a prompt section (hard rule 3)')
  }
}
if (problems.length === 0 && host !== null && binder !== null) {
  notes.push('roles are bound as a per-agent prompt section; the agent preset is never recomposed')
}

// ---------------------------------------------------------------- rule 4
// A switch must survive a restart. The binding lives in one agent scope, which
// the harness tears the scope down with, so the choice is mirrored into a state
// file and re-applied when the agent is created — and again on every model step,
// which is the seam that reconciles a session after the first step. Dropping any
// of those would bring back a defect this rule exists for: a persona that is
// silently gone after DSH restarts, or one that only reaches a resumed session's
// second reply.
const memory = await read('lib/session-state.js')
if (memory !== null) {
  for (const needle of ['export function createSessionState', 'export function planRestore']) {
    if (!memory.includes(needle)) {
      problems.push(`lib/session-state.js does not export ${needle.replace('export function ', '')}`)
    }
  }
}
if (host !== null) {
  if (!host.includes("from './session-state.js'")) {
    problems.push(
      'lib/index.js does not import the durable session state (hard rule 4): a switch would only ' +
        'live as long as the agent scope, so a restart would drop it'
    )
  }
  for (const needle of ['restoreRole(', 'planRestore(', 'state.set(', 'state.remove(', 'NO_ROLE']) {
    if (!host.includes(needle)) {
      problems.push(`lib/index.js does not call ${needle} (hard rule 4): the session state is not wired`)
    }
  }
  if (!host.includes('agent/pre-step')) {
    problems.push('lib/index.js does not hook agent/pre-step (hard rule 4): nothing would re-apply a role')
  }
  if (!host.includes("'agent/created'")) {
    problems.push(
      "lib/index.js does not hook 'agent/created' (hard rule 4): the harness assembles a step's prompt " +
        'before agent/pre-step runs, so the first reply of a resumed session would run on the deployment persona'
    )
  }
  if (!host.includes('agents.list()')) {
    problems.push(
      'lib/index.js does not sweep the live agents (hard rule 4): a session whose agent predates this ' +
        'row would stay on the deployment persona'
    )
  }
}
if (problems.length === 0 && host !== null && memory !== null) {
  notes.push('a role switch is mirrored to a state file and re-applied at agent creation and on every pre-step')
}

// --------------------------------------------------------- publish payload
if (pkg.dsh?.client?.platform !== 'web') {
  problems.push(`package.json dsh.client.platform is ${JSON.stringify(pkg.dsh?.client?.platform)}, expected "web"`)
}
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of [
  'lib/index.js',
  'lib/client.js',
  'lib/persona-binding.js',
  'lib/session-state.js',
  'cordis.patch.yml'
]) {
  if (!files.includes(entry)) problems.push(`package.json "files" must list ${entry}`)
}
if (files.includes('lib')) {
  problems.push(
    'package.json "files" lists the whole lib/ directory; list lib/index.js and lib/client.js ' +
      'explicitly so stale backups are never published'
  )
}
if (pkg.scripts?.prepublishOnly === undefined) {
  problems.push('package.json has no prepublishOnly script; the published bundle could be stale')
}
if (!/^https:\/\/registry\.npmjs\.org\/?$/.test(pkg.publishConfig?.registry ?? '')) {
  problems.push(
    `package.json publishConfig.registry is ${JSON.stringify(pkg.publishConfig?.registry)}; ` +
      'pin https://registry.npmjs.org/ so a mirror registry cannot swallow the publish'
  )
}

// ------------------------------------------------------------------ report
for (const note of notes) console.log(`ok   ${note}`)
for (const problem of problems) console.error(`FAIL ${problem}`)
if (problems.length > 0) {
  console.error(`\nverify-bundle: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`verify-bundle: all invariants hold for ${pkg.name}@${pkg.version}`)
