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
 *   3. The persona route must stay a per-agent prompt section of this plugin's
 *      own, placed after the deployment persona prefix instead of replacing it.
 *      Recomposing an agent preset replaces the agent's whole plugin
 *      composition, so the session loses its tools and commands along with the
 *      old identity (measured while switching: 33 model-facing tools and 10
 *      commands became 7 and 7) — and re-registering the deployment persona
 *      prefix deletes its identity line (`You are a coding agent powered by the
 *      {{model}} model.`) from the system prompt, leaving the model unable to
 *      name the model it runs on. This rule keeps both defects from returning
 *      through a refactor.
 *   4. A switch must be durable. The binding lives in one agent scope and dies
 *      with it, so the choice is mirrored into `lib/session-state.js`'s file and
 *      re-applied on the session's pre-step. Both halves must stay wired.
 *   5. The plugin inventory must be able to read this plugin's display text. The
 *      row renders from `locale/en.json` and `locale/zh.json`, which the host
 *      resolves through the package's `exports` map without activating the
 *      plugin, and falls back to `package.json`'s `name`/`description`
 *      **silently** when that lookup fails. Exporting `./locale/*.json` and
 *      shipping `locale/` is what keeps the row reading `人设切换` instead of
 *      the package name.
 *
 * It also keeps the publish payload honest: `lib/` must be listed file by file
 * so stale backups (for example `lib/client.js.bak-*`) can never be published,
 * and every module the host entry imports relatively must actually be in that
 * payload — 0.4.4 and 0.4.5 shipped a tarball without `lib/atomic-file.js`,
 * which made the plugin unloadable for everyone who installed from npm while
 * local directory installs kept working.
 *
 * Exits non-zero on the first class of problem found.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
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
  // These checks are about code, not prose: the module's header comment names
  // both the deployment section (to say it is never registered from here) and
  // the section-order API (to say it is not consulted), so block comments are
  // stripped before anything is matched.
  const binderCode = binder.replace(/\/\*[\s\S]*?\*\//g, '')
  const sectionName = /export const PERSONA_SECTION = '([^']+)'/.exec(binderCode)?.[1]
  if (sectionName === undefined) {
    problems.push('lib/persona-binding.js does not export PERSONA_SECTION as a single-quoted literal (hard rule 3)')
  } else if (sectionName === 'deployment:persona-prefix') {
    problems.push(
      'lib/persona-binding.js registers the deployment persona prefix itself: that scoped registration ' +
        'shadows it and deletes the harness identity line from the system prompt (hard rule 3) — register ' +
        "this plugin's own section beside it instead"
    )
  } else if (sectionName !== 'persona-switcher:persona') {
    problems.push(
      `lib/persona-binding.js registers prompt section ${JSON.stringify(sectionName)}, expected ` +
        '"persona-switcher:persona" (hard rule 3)'
    )
  }
  const order = /export const PERSONA_ORDER = (\d+)/.exec(binderCode)?.[1]
  if (order === undefined) {
    problems.push(
      'lib/persona-binding.js does not export PERSONA_ORDER as a number literal (hard rule 3): the placement ' +
        'is a raw order value, because this section has no name in the harness section-order table'
    )
  } else if (Number(order) <= 0 || Number(order) >= 500) {
    problems.push(
      `lib/persona-binding.js places the role section at ${order}: it must come after the deployment persona ` +
        'prefix (0) and before the first-party guidance (PLAN_POLICY, 500) (hard rule 3)'
    )
  }
  if (/getSectionOrder\s*\(/.test(binderCode)) {
    problems.push(
      'lib/persona-binding.js consults the section-order table (getSectionOrder); this section has no name ' +
        'in it (hard rule 3)'
    )
  }
  if (!binderCode.includes('prompt.section(')) {
    problems.push('lib/persona-binding.js does not register a prompt section (hard rule 3)')
  }
}
if (problems.length === 0 && host !== null && binder !== null) {
  notes.push(
    'roles are bound as a per-agent prompt section beside the deployment persona prefix, which is never ' +
      'shadowed; the agent preset is never recomposed'
  )
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

// ---------------------------------------------------------------- rule 5
// The Settings plugin inventory, the Plugin Manager card and the bundle details
// render this plugin's display text without activating it: the host resolves
// `<name>/locale/en.json` through the package's `exports` map and reads `meta`
// from `en.json`, then from the file next to it for every other language. A
// missing subpath is reported nowhere — the row falls back to `package.json`,
// which is exactly how this plugin lost its title once.
const exportMap = pkg.exports ?? {}
for (const subpath of ['./locale/*.json', './package.json']) {
  if (exportMap[subpath] !== subpath) {
    problems.push(
      `package.json "exports" must map ${JSON.stringify(subpath)} to itself (hard rule 5): the ` +
        'plugin inventory resolves the locale files through the exports map and, with no ' +
        'diagnostic at all, falls back to the package name and description when it cannot'
    )
  }
}
const locales = {}
for (const language of ['en', 'zh']) {
  const source = await read(`locale/${language}.json`)
  if (source === null) continue
  try {
    locales[language] = JSON.parse(source)
  } catch (error) {
    problems.push(`locale/${language}.json is not valid JSON: ${error.message}`)
  }
}
for (const [language, parsed] of Object.entries(locales)) {
  for (const field of ['title', 'description']) {
    const value = parsed?.meta?.[field]
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(
        `locale/${language}.json has no usable meta.${field} (hard rule 5): the inventory would ` +
          'fall back to package.json for that field'
      )
    }
  }
}
if (Object.keys(locales).length === 2 && problems.length === 0) {
  notes.push(`the plugin inventory can read this plugin's own title (${locales.zh.meta.title})`)
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
  'lib/atomic-file.js',
  'cordis.patch.yml'
]) {
  if (!files.includes(entry)) problems.push(`package.json "files" must list ${entry}`)
}
if (!files.some((entry) => entry === 'locale' || entry === 'locale/' || entry.startsWith('locale/'))) {
  problems.push(
    'package.json "files" must ship the locale/ directory (hard rule 5): without it the ' +
      'published tarball has no display text and the row shows the package name'
  )
}
if (files.includes('lib')) {
  problems.push(
    'package.json "files" lists the whole lib/ directory; list lib/index.js and lib/client.js ' +
      'explicitly so stale backups are never published'
  )
}

// ------------------------------------------------- payload completeness
// A relative import that the payload does not ship fails at load time with
// ERR_MODULE_NOT_FOUND, and the Host reports that only as a row that never
// mounted: the settings section, the composer entry and the mascot all vanish
// with no message anywhere. 0.4.4 and 0.4.5 shipped exactly that —
// `lib/atomic-file.js` lived in the repository but was missing from `files`, so
// every tarball install was broken while every directory install kept working,
// which is why this survived `npm test` and the browser regression. Walk the
// host entry's relative imports and require each resolved file in the payload.
const payload = new Set(['package.json'])
const expand = async (rel) => {
  const info = await stat(join(root, rel)).catch(() => null)
  if (info === null) {
    problems.push(`package.json "files" lists ${rel}, which does not exist on disk`)
    return
  }
  if (!info.isDirectory()) {
    payload.add(rel)
    return
  }
  for (const dirent of await readdir(join(root, rel), { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue
    await expand(posix.join(rel, dirent.name))
  }
}
for (const entry of files) await expand(entry.replace(/^\.\//, '').replace(/\/+$/, ''))

const relativeImports = (source) =>
  [...source.matchAll(/\b(?:from|import|require)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)].map((match) => match[1])

const walked = new Set()
const walkImports = async (rel) => {
  if (walked.has(rel)) return
  walked.add(rel)
  const source = await read(rel)
  if (source === null) return
  for (const spec of relativeImports(source)) {
    const resolved = posix.normalize(posix.join(posix.dirname(rel), spec))
    if (!payload.has(resolved)) {
      problems.push(
        `${rel} imports ${spec}, but the publish payload does not ship ${resolved}: a tarball install ` +
          'fails to load the row with ERR_MODULE_NOT_FOUND and every UI surface disappears without a ' +
          'message — add it to package.json "files"'
      )
      continue
    }
    await walkImports(resolved)
  }
}
for (const entry of ['lib/index.js', 'lib/client.js']) {
  if (payload.has(entry)) await walkImports(entry)
}
if (problems.length === 0) {
  notes.push(`the publish payload ships every module the host entry imports (${walked.size} entry files walked)`)
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
