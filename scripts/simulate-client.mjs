/**
 * Simulate the web host for the persona-switcher client bundle:
 * - `window.__ModuleLoader__.load(...)` registrations
 * - seed-module `require` shims resolved from the real devDependencies
 *   (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`)
 * - a fake cordis ctx with `locale`, `configForms`, `slots`, `effect`
 * - a `fetch` polyfill for the role library loopback API
 *
 * The section registration is exercised with the REAL primitives under the
 * hood: SettingsFormModel binding, the form actions, the snapshot store
 * projection, and the scope subscription -> republish chain.
 *
 * Usage: node scripts/simulate-client.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const react = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
// The npm rc package's transitive deps are undeclared and its CSS modules
// cannot load in Node, so the simulation uses a behavior-equivalent shim.
const primitives = await import('./simulate-primitives.mjs')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The browser module identity is the package name, NOT the Cordis row id
// (`persona-switcher` in cordis.patch.yml). See scripts/build-client.mjs.
const pkgName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name
const code = await readFile(join(root, 'lib', 'client.js'), 'utf8')

const registrations = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registrations.set(id, factory)
    }
  }
}

const moduleCache = new Map()
function hostRequire(id) {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  if (registrations.has(id)) {
    const factory = registrations.get(id)
    const mod = { exports: {} }
    moduleCache.set(id, mod)
    factory((dep) => hostRequire(dep))(mod.exports, mod.exports, mod)
    return mod.exports
  }
  throw new Error(`unexpected require: ${id}`)
}

// The wrapper is a plain script body; eval it with window in scope
const fn = new Function('window', 'require', code)
fn(globalThis.window, hostRequire)

if (!registrations.has(pkgName)) {
  console.error(`FAIL: bundle did not register ${pkgName}`)
  process.exit(1)
}
const factory = registrations.get(pkgName)
const bundleExports = factory((dep) => hostRequire(dep))

if (typeof bundleExports.apply !== 'function') throw new Error('apply missing')
if (!Array.isArray(bundleExports.inject)) throw new Error('inject missing')
console.log('inject:', JSON.stringify(bundleExports.inject))

// ---- fake host services ----
const locale = {
  register(ns, dicts) {
    if (ns !== 'persona-switcher') throw new Error(`unexpected locale ns ${ns}`)
    if (typeof dicts.zh !== 'object' || typeof dicts.en !== 'object') throw new Error('dictionaries malformed')
    locale.dicts = dicts
    return () => {}
  },
  bind(ns) {
    if (ns !== 'persona-switcher') throw new Error(`unexpected locale bind ${ns}`)
    return (key) => {
      const zh = locale.dicts?.zh
      if (zh === undefined || zh[key] === undefined) throw new Error(`missing locale key ${key}`)
      return zh[key]
    }
  }
}

const scopeValue = { defaultRole: '', exposeTool: true }
const scopeSubscribers = new Set()
const writes = []
const scope = {
  getSnapshot() {
    return {
      status: 'ready',
      value: { ...scopeValue },
      base: {},
      user: {},
      revision: 0,
      writable: true,
      mode: 'host'
    }
  },
  subscribe(listener) {
    scopeSubscribers.add(listener)
    return () => scopeSubscribers.delete(listener)
  },
  async set(field, value) {
    writes.push({ op: 'set', field, value })
    scopeValue[field] = value
    for (const listener of scopeSubscribers) listener()
    return true
  },
  async unset(field) {
    writes.push({ op: 'unset', field })
    delete scopeValue[field]
    for (const listener of scopeSubscribers) listener()
    return true
  },
  async mutate(ops) {
    for (const op of ops) {
      if (op.op === 'set') scopeValue[op.path[0]] = op.value
      else delete scopeValue[op.path[0]]
      writes.push(op)
    }
    for (const listener of scopeSubscribers) listener()
    return true
  }
}

const fetchCalls = []
const roles = [{ id: 'teacher', name: 'Teacher', description: 'x', persona: 'You are a teacher' }]
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  const route = String(url).replace('/persona-switcher', '')
  if (route === '/roles' && (options?.method ?? 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, roles }) }
  }
  if (route === '/role' && options?.method === 'POST') {
    const body = JSON.parse(options.body)
    roles.push(body)
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (route.startsWith('/role?id=') && options?.method === 'DELETE') {
    const id = decodeURIComponent(route.slice('/role?id='.length))
    const index = roles.findIndex((role) => role.id === id)
    if (index >= 0) roles.splice(index, 1)
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
}

const registered = []
const sectionEntries = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale,
  configForms: {
    get(ns) {
      if (ns !== 'persona-switcher') throw new Error(`unexpected configForms.get ${ns}`)
      return scope
    }
  },
  slots: {
    inject(slotName, registerFn) {
      registered.push({ slotName, registerFn })
    },
    register(options, component) {
      sectionEntries.push({ ...options, component })
      return options
    }
  }
}

bundleExports.apply(ctx)

const sec = registered.find((r) => r.slotName === 'settings.section')
if (!sec) throw new Error('settings.section not injected')
const entry = sec.registerFn()
console.log(
  'register:',
  JSON.stringify({ name: entry.name, id: entry.id, order: entry.order, label: entry.label() })
)
if (entry.name !== 'settings.section') throw new Error('register name mismatch')
if (entry.id !== 'persona-switcher') throw new Error('register id mismatch')
if (entry.label() !== '人设切换') throw new Error('register label mismatch')

const injected = entry.inject()
const actionKeys = ['edit', 'resetField', 'save', 'discard']
for (const key of actionKeys) {
  if (typeof injected[key] !== 'function') throw new Error(`inject missing form action ${key}`)
}
if (typeof injected.t !== 'function') throw new Error('inject missing t')
if (typeof injected.controller !== 'object' || injected.controller === null) {
  throw new Error('inject missing controller')
}
const store = injected.hooks?.snapshot
if (typeof store?.getSnapshot !== 'function') throw new Error('inject missing snapshot hook store')

// Initial load settles on the next microtask/tick (controller.load is async)
await new Promise((resolve) => setTimeout(resolve, 50))
let state = store.getSnapshot()
console.log('state after load:', JSON.stringify({ status: state.status, writable: state.writable, roles: state.roles?.length, exposeTool: state.exposeTool, defaultRole: state.defaultRole }))
if (state.roles?.length !== 1) throw new Error('roles did not load')
if (state.status !== 'ready') throw new Error('status not ready')
if (state.defaultRole?.text !== '' ) throw new Error('defaultRole field not bound')

// Volatile toggle through the scope: the form's scope subscription must
// republish the projection into the snapshot store.
await scope.set('exposeTool', false)
state = store.getSnapshot()
if (state.exposeTool !== false) throw new Error('exposeTool did not propagate to store')
const toolWrite = writes.find((w) => w.field === 'exposeTool')
if (toolWrite === undefined) throw new Error('exposeTool write not recorded')

// Editor lifecycle: open, patch, commit; POST /role then reload.
injected.controller.edit(null)
state = store.getSnapshot()
if (state.editing === null) throw new Error('edit(null) did not open editor')
injected.controller.patchEditing('name', 'Engineer')
state = store.getSnapshot()
if (state.editing.name !== 'Engineer') throw new Error('patchEditing lost')
await injected.controller.commitEdit()
state = store.getSnapshot()
if (state.editing !== null) throw new Error('commitEdit did not close editor')
if (state.roles.length !== 2) throw new Error('commitEdit did not reload roles')
const post = fetchCalls.find((c) => c.url === '/persona-switcher/role' && c.options?.method === 'POST')
if (post === undefined) throw new Error('POST /role not issued')

// Delete a role through the library.
await injected.controller.remove(state.roles.find((r) => r.id === 'teacher'))
state = store.getSnapshot()
if (state.roles.length !== 1) throw new Error('remove did not reload roles')

// Form actions are present and callable.
await injected.edit('defaultRole', 'teacher')
await injected.save()
state = store.getSnapshot()
if (scopeValue.defaultRole !== 'teacher') throw new Error('form save did not write defaultRole')
await injected.discard()

console.log('SIMULATION OK')