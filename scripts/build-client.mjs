/**
 * Build the web client bundle.
 *
 * Bundles `src/client/index.jsx` with esbuild (browser platform, CJS output;
 * `react`, `react/jsx-runtime`, `react-dom` and
 * `@deepseek-ai/dsh-client-ui-primitives` stay external — the host injects
 * them at runtime) and wraps the result in the
 * `window.__ModuleLoader__.load({ id, factory })` shell the DeepSeek Harness
 * web host expects.
 *
 * The bundle id MUST be the package name, and is read from `package.json` so it
 * can never drift. `@deepseek-ai/dsh-client-modules` resolves every Loader entry
 * to its manifest package name and uses THAT as the browser module identity; the
 * `id:` inside `cordis.patch.yml` is a Cordis row id and is irrelevant here.
 *
 * Registering under any other id is fatal, not merely inert: the combo batch
 * leaves the row unregistered, so the browser retries the row through its own
 * single-resource combo URL, executes this bundle a second time, and the second
 * `register` throws
 * `client-modules: duplicate factory registration ... (bundle executed twice
 * without invalidate?)` — which surfaces as `web boot: N entry did not activate`
 * and a failed app start.
 *
 * The output is committed, and CI rebuilds it and compares byte for byte, so the
 * build must be deterministic and independent of where it was started from:
 *
 *   - `absWorkingDir` and the banner-comment normalisation below keep esbuild
 *     from writing a working-directory-relative entry path into the bundle;
 *   - the esbuild version is pinned exactly in `package.json` (`0.28.2`), since
 *     a different esbuild can emit slightly different glue code.
 *
 * Usage: `node scripts/build-client.mjs`
 */
import { build } from 'esbuild'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = join(root, '.client-bundle.js')
const out = join(root, 'lib', 'client.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const clientId = pkg.name
if (typeof clientId !== 'string' || clientId === '') {
  throw new Error('package.json has no usable "name"')
}

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'client', 'index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  outfile: tmp,
  logLevel: 'info'
})

const raw = await readFile(tmp, 'utf8')
await rm(tmp, { force: true })

// esbuild opens the bundle with a comment naming the entry point, written
// relative to the process working directory. Without this the same source emits
// different bytes depending on where the build ran, which would make the CI
// staleness check (`git diff --exit-code -- lib/client.js`) flap.
const body = raw.replace(/^\/\/ .*[\\/]src[\\/]client[\\/]index\.jsx\s*$/m, '// src/client/index.jsx')

const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(clientId)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t},',
  '});',
  ''
].join('\n')

await writeFile(out, wrapped, 'utf8')
console.log(`built ${out} (${wrapped.length} bytes)`)
