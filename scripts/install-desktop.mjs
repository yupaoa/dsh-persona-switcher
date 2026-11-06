/**
 * install-desktop.mjs — put THIS build into the DSH desktop profile.
 *
 * Why this exists: a `file:` install is a COPY, not a link, so re-running the
 * build alone leaves the profile on the previous version. That bit us once —
 * `lib/client.js` was refreshed while `lib/index.js` was not, so the plugin
 * looked half-upgraded and the mascot simply never appeared. One command that
 * does both is cheaper than remembering.
 *
 * It shells out to the pnpm that ships with the DSH runtime (the profile has no
 * `pnpm` on PATH), and relaxes pnpm's minimum-release-age policy FOR THIS COMMAND
 * ONLY — the profile's own pnpm-lock.yaml contains entries newer than the cutoff,
 * which a plain `pnpm add` refuses to verify. No config file is modified.
 *
 * Usage:  node scripts/install-desktop.mjs [profile-name]
 *         (default profile: desktop)
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const profileName = process.argv[2] ?? 'desktop'

const home = process.env.USERPROFILE ?? process.env.HOME
if (home === undefined) {
  console.error('install-desktop: cannot find the home directory')
  process.exit(1)
}
const profileDir = join(home, '.dsh', 'profiles', profileName)
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`install-desktop: no profile at ${profileDir}`)
  process.exit(1)
}

/** Locate the runtime pnpm that ships with DSH. */
const pnpmEntry = join(
  home,
  '.dsh',
  'dsh-runtimes',
  'dsh-primary-runtime',
  'dependencies',
  'pnpm',
  'bin',
  'pnpm.mjs'
)
if (!existsSync(pnpmEntry)) {
  console.error('install-desktop: the DSH runtime pnpm was not found; install it by hand:')
  console.error(`  cd ${profileDir}`)
  console.error(`  pnpm add file:${packageRoot}`)
  process.exit(1)
}
const node = process.execPath

// pnpm is a Node script, so it runs with the Node that runs this file.
const spec = `file:${packageRoot.replace(/\\/g, '/')}`
console.log(`install-desktop: profile = ${profileDir}`)
console.log(`install-desktop: spec    = ${spec}`)
const result = spawnSync(
  node,
  [pnpmEntry, 'add', spec, '--dir', profileDir, '--config.minimumReleaseAge=0', '--ignore-scripts', '--prefer-offline'],
  { stdio: 'inherit' }
)
if (result.status !== 0) {
  console.error('install-desktop: pnpm failed')
  process.exit(result.status ?? 1)
}

const installedRoot = join(profileDir, 'node_modules', 'dsh-persona-switcher')

/**
 * Copy this build over the installed one, file by file.
 *
 * `pnpm add file:…` is NOT enough to update a directory dependency: the
 * lockfile records `specifier: file:…` / `version: file:…`, both unchanged by a
 * rebuild, so pnpm concludes the dependency is already current and links
 * nothing. Measured on a real profile (2026-10-16): pnpm reported "Done", the
 * installed `lib/` directory's mtime was fresh, and not one file inside it had
 * changed — `package.json` still 0.2.0 while the build was 0.2.1. The run
 * before that had silently left `lib/client.js` updated and `lib/index.js`
 * stale, which is what made the plugin look half-upgraded.
 *
 * So both halves happen here: pnpm keeps the profile's dependency graph
 * consistent, and this copy guarantees the CONTENT is this build. A build
 * directory is small (a few hundred KB), so there is nothing to be clever about.
 */
const SKIP = new Set(['.git', 'node_modules', '.ps-backup', 'generate'])
let copied = 0
const sync = (fromDir, toDir) => {
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.ps-backup')) continue
    const from = join(fromDir, entry.name)
    const to = join(toDir, entry.name)
    if (entry.isDirectory()) {
      sync(from, to)
      continue
    }
    if (!entry.isFile()) continue
    try {
      copyFileSync(from, to)
    } catch (error) {
      // Windows refuses to overwrite a read-only destination, and a file that
      // came out of an attachments directory (or a read-only checkout) carries
      // that bit along. Clearing it on the installed copy and retrying once is
      // what `attrib -r` would do by hand.
      if (error?.code !== 'EPERM') throw error
      chmodSync(to, 0o666)
      copyFileSync(from, to)
    }
    copied += 1
  }
}

console.log(`install-desktop: syncing ${packageRoot}`)
console.log(`install-desktop:       -> ${installedRoot}`)
sync(packageRoot, installedRoot)

/** Compare one installed file against the build it came from. */
const verify = (name) => {
  const expected = readFileSync(join(packageRoot, name))
  const actual = readFileSync(join(installedRoot, name))
  return expected.equals(actual)
}

const version = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')).version
const built = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
console.log(`install-desktop: copied ${copied} file(s)`)
console.log(`install-desktop: installed ${version}; this build is ${built}`)

// The profile's OWN manifest carries a version for the plugin page and for the
// install guard (`tools/verify-install.mjs`), and pnpm writes the specifier, not
// the version, for a directory dependency. Keep it honest.
const profileManifestPath = join(profileDir, 'package.json')
const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const declared = profileManifest.dependencies?.['dsh-persona-switcher']
if (declared !== undefined && declared.startsWith('file:')) {
  if (profileManifest.dependencies['dsh-persona-switcher'] !== spec) {
    profileManifest.dependencies['dsh-persona-switcher'] = spec
    writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')
    console.log(`install-desktop: profile dependency pinned to ${spec}`)
  }
}

const mismatched = ['package.json', 'lib/index.js', 'lib/client.js', 'lib/persona-binding.js', 'lib/session-state.js'].filter(
  (name) => !verify(name)
)
if (version !== built || mismatched.length > 0) {
  console.error(`install-desktop: the profile is NOT on this build${mismatched.length === 0 ? '' : ` (differs: ${mismatched.join(', ')})`}`)
  process.exit(1)
}
console.log('install-desktop: PASS — restart DSH completely for the host half to load')
