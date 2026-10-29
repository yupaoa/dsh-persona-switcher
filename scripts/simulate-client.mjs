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
const reactDom = await import('react-dom')
const jsxRuntime = await import('react/jsx-runtime')
// The npm rc package's transitive deps are undeclared and its CSS modules
// cannot load in Node, so the simulation uses a behavior-equivalent shim.
const primitives = await import('./simulate-primitives.mjs')

/**
 * The little of `react-dom/client` this simulation needs.
 *
 * The client half mounts the on-screen mascot through a React root of its own,
 * and that path cannot run here — there is no DOM, and this file's job is the
 * settings page (role library, form binding, scope subscription). So the shim
 * records the request and does nothing: enough for `apply(ctx)` to complete and
 * for the mascot to stay invisible, which is exactly what it is on a host with
 * no `sidebarRight` service.
 */
let mountedRoot = null
const reactDomClient = {
  createRoot(container) {
    mountedRoot = { container, rendered: null, unmounted: 0 }
    globalThis.__simulatedRoot = mountedRoot
    return {
      render(element) {
        mountedRoot.rendered = element
      },
      unmount() {
        mountedRoot.unmounted += 1
      }
    }
  }
}
/** A DOM stub just wide enough for `installMascot` to create its dock. */
const fakeNode = (tag) => ({
  tagName: String(tag).toUpperCase(),
  id: '',
  style: {},
  textContent: '',
  childNodes: [],
  parentNode: null,
  appendChild(child) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  },
  removeChild(child) {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parentNode = null
    return child
  }
})
const domNodes = new Map()
globalThis.document = {
  head: fakeNode('head'),
  body: fakeNode('body'),
  createElement: (tag) => fakeNode(tag),
  getElementById(id) {
    return domNodes.get(id) ?? null
  },
  addEventListener() {},
  removeEventListener() {}
}
const nativeCreateElement = globalThis.document.createElement
globalThis.document.createElement = (tag) => {
  const node = nativeCreateElement(tag)
  Object.defineProperty(node, 'id', {
    get: () => node.__id ?? '',
    set: (value) => {
      node.__id = value
      domNodes.set(value, node)
    }
  })
  return node
}

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
  if (id === 'react-dom') return reactDom
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === 'react-dom/client') return reactDomClient
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
/** The role each session carries right now, as the `/session` route reports it. */
const liveRoles = new Map()
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  const route = String(url).replace('/persona-switcher', '')
  if (route === '/roles' && (options?.method ?? 'GET') === 'GET') {
    return { ok: true, status: 200, json: async () => ({ ok: true, roles }) }
  }
  if (route.startsWith('/session?session=') && (options?.method ?? 'GET') === 'GET') {
    const sessionId = decodeURIComponent(route.slice('/session?session='.length))
    const liveRoleId = liveRoles.get(sessionId) ?? null
    return { ok: true, status: 200, json: async () => ({ ok: true, roleId: liveRoleId, liveRoleId }) }
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

/* ── The `/role` picker: what the client registers into the command shell ──
 * The picker is a decoration of the Host's own `/role` command (a contribution
 * with the same name would be refused by ui-commands), so what matters here is
 * the spec handed to `decorate`: its options, its tick, and what a pick runs.
 */
const roleDecorations = []
const commandUi = {
  register() {
    throw new Error('the picker must decorate the Host /role command, not contribute a second command')
  },
  decorate(spec) {
    roleDecorations.push(spec)
    return () => {}
  }
}
/** The `/role` lines the picker asked the session to run. */
const commandCalls = []
/** Queued answers for the next `session.command()` calls; an Error rejects. */
const commandOutcomes = []
const sessions = {
  binding(sessionId) {
    return {
      session: {
        sessionId,
        command: async (line) => {
          commandCalls.push({ sessionId, line })
          const queued = commandOutcomes.shift()
          if (queued instanceof Error) throw queued
          if (queued !== undefined) return queued
          return { ok: true, value: { matched: true } }
        }
      }
    }
  }
}

const registered = []
const sectionEntries = []
/** Disposers handed back by `ctx.effect`, by label, so they can be run. */
const effectDisposers = new Map()
const ctx = {
  effect(fn, label) {
    const stop = fn()
    effectDisposers.set(label, typeof stop === 'function' ? stop : () => {})
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
  },
  inject(names, run) {
    const services = { commandUi, sessions, slots: ctx.slots }
    const missing = names.filter((name) => services[name] === undefined)
    if (missing.length > 0) {
      throw new Error(`the client asked for unavailable services: ${missing.join(', ')}`)
    }
    run({
      get: (name) => services[name],
      effect: (fn) => ctx.effect(fn)
    })
  }
}

bundleExports.apply(ctx)

/* ── The dock must survive a dispose + re-install ──────────────────────────
 * This is the failure that reached a real machine: the mascot disappeared, the
 * dock was gone, no error was reported anywhere, and the settings page was
 * fine. The cause was the mascot effect being run twice — the first disposer
 * removed the dock node, and the second install then mounted a new React root
 * onto a node that the first root's deferred unmount was still queued to tear
 * down. Nothing in this suite ran install -> dispose -> install, so nothing
 * caught it.
 *
 * The deliverable the browser executes is `lib/client.js`, and this file is the
 * one place that applies it the way the host does, so the guard lives here.
 */
{
  const dockId = 'dsh-persona-switcher-mascot-dock'
  // "is it still on the page", NOT "does getElementById know the id": this
  // simulation's removeChild detaches a node but leaves it in the id map, so an
  // id lookup alone reports a removed dock as present and the guard silently
  // proves nothing. The real document behaves the same way for a detached node
  // (getElementById only walks the tree), so parentNode is the honest test.
  const dockOnPage = () => {
    const node = domNodes.get(dockId)
    return node !== undefined && node.parentNode !== null
  }
  if (!dockOnPage()) {
    console.error('FAIL: the mascot dock was never created by apply()')
    process.exit(1)
  }
  const mascotDisposer = effectDisposers.get('persona-switcher: mascot')
  if (typeof mascotDisposer !== 'function') {
    console.error('FAIL: apply() registered no mascot effect')
    process.exit(1)
  }
  try {
    mascotDisposer()
  } catch (error) {
    console.error(`FAIL: the mascot disposer threw: ${error?.message}`)
    process.exit(1)
  }
  if (!dockOnPage()) {
    console.error('FAIL: disposing the mascot removed its dock node (a re-install will then race a dead root)')
    process.exit(1)
  }
  // Install again, exactly as a re-applied effect does.
  bundleExports.apply(ctx)
  if (domNodes.get(dockId) === undefined) {
    console.error('FAIL: a re-install left no dock')
    process.exit(1)
  }
  console.log('mascot dock survives dispose + re-install')
}

/* ── The `/role` picker ────────────────────────────────────────────────────
 * The Host command keeps its catalog row and its argument claim; this bundle
 * only hangs a bare-invocation popup on it. What the browser offers is decided
 * entirely by the decoration spec, so this checks the spec the way
 * ui-commands will call it: options per session, the tick on the role in
 * force, and a pick that runs the Host command rather than switching by side
 * effect.
 */
{
  const fail = (message) => {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
  const spec = roleDecorations.at(-1)
  if (spec === undefined) fail('apply() registered no /role decoration')
  if (spec.name !== 'role') fail(`decoration name mismatch: ${spec.name}`)
  if (spec.ui?.kind !== 'popupSelect') fail(`the /role picker must be a popupSelect, got ${spec.ui?.kind}`)
  const labels = spec.ui.searchLabels?.()
  if (typeof labels?.placeholder !== 'string' || labels.placeholder === '') fail('no search placeholder')
  if (typeof labels.empty !== 'string' || labels.empty === '') fail('no empty-catalogue text')
  if (typeof labels.noResults !== 'string' || labels.noResults === '') fail('no no-match text')
  if (typeof spec.ui.options !== 'function') fail('the picker has no options loader')
  if (typeof spec.ui.onSelect !== 'function') fail('the picker has no selection handler')

  // Nothing bound: "none" is first, ticked, and the library follows it.
  liveRoles.set('s1', null)
  const unbound = await spec.ui.options({ sessionId: 's1' })
  if (unbound.length !== roles.length + 1) fail(`expected ${roles.length + 1} rows, got ${unbound.length}`)
  if (unbound[0].id !== 'none') fail(`the first row must be none, got ${unbound[0]?.id}`)
  if (unbound[0].active !== true) fail('none must be ticked when no role is bound')
  if (!unbound.some((option) => option.id === 'teacher')) fail('the role library is missing from the options')
  if (unbound.filter((option) => option.active === true).length !== 1) fail('exactly one row may be ticked')

  // A role in force is ticked and says so, the way the search-engine picker does.
  liveRoles.set('s1', 'teacher')
  const bound = await spec.ui.options({ sessionId: 's1' })
  const teacher = bound.find((option) => option.id === 'teacher')
  if (teacher === undefined) fail('the bound role vanished from the options')
  if (teacher.active !== true) fail('the role in force must be ticked')
  if (!String(teacher.detail).includes('当前')) fail(`the ticked row must say it is current: ${teacher.detail}`)
  if (bound[0].active !== false) fail('none must not stay ticked once a role is in force')
  if (teacher.label !== 'Teacher') fail(`the label must be the role name, got ${teacher.label}`)

  // A pick runs the Host command, so the switch keeps its announcements and
  // its memory write instead of re-implementing them in the browser.
  await spec.ui.onSelect(teacher, { sessionId: 's1' })
  const picked = commandCalls.at(-1)
  if (picked?.line !== '/role teacher') fail(`a pick must run "/role teacher", ran ${JSON.stringify(picked)}`)
  if (picked?.sessionId !== 's1') fail(`the command must be addressed to the picker's session, got ${picked?.sessionId}`)
  await spec.ui.onSelect(bound[0], { sessionId: 's1' })
  if (commandCalls.at(-1)?.line !== '/role none') fail('picking none must run "/role none"')

  // A refused switch rejects, so the popup can keep itself open and say why.
  commandOutcomes.push({ ok: false, error: { message: 'role library is gone' } })
  let surfaced = null
  try {
    await spec.ui.onSelect(teacher, { sessionId: 's1' })
  } catch (error) {
    surfaced = error
  }
  if (surfaced === null) fail('a failed switch must reject so the popup can report it')
  if (!String(surfaced.message).includes('role library is gone')) {
    fail(`the host's reason must reach the popup, got ${surfaced.message}`)
  }

  // Admitted but NOT matched: the shell took the line and nothing ran. Closing
  // the popup here would look like a successful switch, so it has to reject.
  commandOutcomes.push({ ok: true, value: { matched: false } })
  surfaced = null
  try {
    await spec.ui.onSelect(teacher, { sessionId: 's1' })
  } catch (error) {
    surfaced = error
  }
  if (surfaced === null) fail('an unmatched command must reject instead of closing silently')
  if (!String(surfaced.message).includes('/role teacher')) {
    fail(`the unmatched error must name the line that did not run, got ${surfaced.message}`)
  }

  // An empty library still offers the way back to the deployment persona.
  const seeded = roles.splice(0, roles.length)
  liveRoles.set('s1', null)
  const noneOnly = await spec.ui.options({ sessionId: 's1' })
  if (noneOnly.length !== 1 || noneOnly[0].id !== 'none') fail('an empty library must leave the none row alone')
  roles.push(...seeded)
  console.log('/role picker: decoration, ticks and dispatch ok')
}

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
// The composer adds its own list cell; it must not claim another plugin's cell.
const composer = registered.find((r) => r.slotName === 'conversation.input.left')?.registerFn()
if (composer?.id !== 'persona-switcher-picker' || composer.order <= 5) {
  throw new Error('composer must coexist after dsh-meme in its own slot entry')
}
if (composer.inject('s2').sessionId !== 's2') throw new Error('composer lost its scoped session id')
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
if (state.editing.id !== 'char001') throw new Error('new role must suggest char001')
injected.controller.patchEditing('name', 'Engineer')
state = store.getSnapshot()
if (state.editing.name !== 'Engineer') throw new Error('patchEditing lost')
await injected.controller.commitEdit()
state = store.getSnapshot()
if (state.editing !== null) throw new Error('commitEdit did not close editor')
if (state.roles.length !== 2) throw new Error('commitEdit did not reload roles')
const post = fetchCalls.find((c) => c.url === '/persona-switcher/role' && c.options?.method === 'POST')
if (post === undefined) throw new Error('POST /role not issued')
injected.controller.edit(null)
if (store.getSnapshot().editing.id !== 'char002') throw new Error('suggestion must skip an existing id')
injected.controller.patchEditing('id', 'teacher')
const writesBeforeCollision = fetchCalls.filter((c) => c.options?.method === 'POST').length
await injected.controller.commitEdit()
if (store.getSnapshot().editing?.id !== 'teacher' || !store.getSnapshot().error) {
  throw new Error('duplicate id must keep the editor open and explain the conflict')
}
if (fetchCalls.filter((c) => c.options?.method === 'POST').length !== writesBeforeCollision) {
  throw new Error('creating a duplicate must not overwrite the existing role')
}
injected.controller.cancelEdit()

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

// The mascot rides in this same bundle and mounts its own React root. On a host
// with no `sidebarRight` service it stays invisible, but the dock and the root
// must still be there — a bundle that forgot to install it would pass every
// check above.
if (mountedRoot === null) throw new Error('the mascot never created its root')
if (mountedRoot.container.id !== 'dsh-persona-switcher-mascot-dock') {
  throw new Error(`mascot dock id mismatch: ${mountedRoot.container.id}`)
}
if (mountedRoot.rendered === null) throw new Error('the mascot root rendered nothing')
if (globalThis.document.getElementById('persona-switcher-mascot-style') === null) {
  throw new Error('the mascot stylesheet was not installed')
}
console.log('mascot dock:', mountedRoot.container.id)

console.log('SIMULATION OK')
