#!/usr/bin/env node
/**
 * Browser-half checks for the persona mascot.
 *
 * Run with `npm test` (CI runs the same). Everything here is verified WITHOUT a
 * browser and without a build step: `src/client/mascot.jsx` is imported directly
 * into Node, a minimal DOM is stubbed onto the globals, and the shipped code
 * runs for real. Nothing is re-implemented here, so the assertions are about the
 * component that ships, not a transcription of it:
 *
 *   - the four display conditions, including the master switch's "off means
 *     silent" rule (no dock, and not a single request), which is the whole point
 *     of the switch living outside the mascot;
 *   - the host contract the mascot consumes: `/session` answering
 *     `{ roleId: null }` for "no role", `/roles` answering `mascot: null` for
 *     "no artwork", and the `WxH` box being the only spelling that counts;
 *   - drag behaviour: 3px dead zone, soft clamp with no snap, and localStorage
 *     written exactly once, on drop;
 *   - coexistence with `dsh-plugin-wallpaper-engine`: our own dock id, our own
 *     `localStorage` namespace, `z-index: 995` under their rope's 996, and no
 *     CSS `filter` (their header comment records the white-flash failure).
 *
 * The components are driven by the small hook host below rather than by
 * `react-dom`'s concurrent renderer. That is a deliberate choice: `createRoot` +
 * `act` in a stubbed DOM fights React 18's scheduler ("Should not already be
 * working", plus updates leaking between roots), and the interesting logic here
 * is effects and event handlers, not the commit phase. The hook host implements
 * the same rules React does — state keyed by call order, dependency-array
 * comparison, cleanups before re-runs and on unmount — and `installMascot` is
 * still exercised against the real `createRoot`, so the wiring claim ("nothing
 * happens without a real host") is checked rather than assumed.
 *
 * Exits non-zero when any check fails.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import React from 'react'

/* ── Import the client source ────────────────────────────────────────────
 * Node has no `.jsx` loader, and its loader is asynchronous while
 * `registerHooks`'s is not — so the source is read here and handed to the hook
 * through the options, and the translation itself is a pure function in
 * `jsx-to-esm.mjs` (which refuses to translate real JSX rather than half-doing
 * it). The browser half is built by esbuild and never goes through this path.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MASCOT_PATH = join(root, 'src', 'client', 'mascot.jsx')
const mascotSource = await readFile(MASCOT_PATH, 'utf8')
const { jsxToEsm, jsxRefusal } = await import('./jsx-to-esm.mjs')

const refusal = jsxRefusal(mascotSource)
if (refusal !== null) {
  console.error(`src/client/mascot.jsx uses ${refusal}; the headless harness cannot translate it`)
  process.exit(1)
}
const translated = jsxToEsm(mascotSource)

registerHooks({
  load(url, context, nextLoad) {
    if (url !== pathToFileURL(MASCOT_PATH).href) return nextLoad(url, context)
    return { format: 'module', shortCircuit: true, source: translated }
  }
})

const require = createRequire(import.meta.url)
const ReactDOM = require('react-dom/client')
const reactExportsPath = require.resolve('react')
const reactExportsUrl = pathToFileURL(reactExportsPath).href
const realReact = require('react')

/* ── Intercept `react` for the client module ─────────────────────────────
 * The hook host cannot patch React after the fact: Node's CJS interop hands an
 * ESM importer a SNAPSHOT of the named exports (`import { useState } from
 * 'react'` keeps the function it was linked to; replacing `exports.useState`
 * afterwards changes nothing — measured, not assumed). So the interception
 * happens at load time instead: the client module's `react` specifier is
 * resolved to this generated module, which re-exports the real React for
 * everything else and forwards the three hooks the host drives.
 *
 * `react-dom/client` is untouched and needs no patching: only the client module
 * imports `react` directly, and the shim's own re-export uses the absolute URL
 * so node_modules resolution cannot send it anywhere else.
 */
const shimUrl = 'dsh-react-hook-shim:react'
const shimSource = `export * from ${JSON.stringify(reactExportsUrl)}
const host = () => globalThis.__dshHookHost
const fallback = globalThis.__dshReactFallback
export const useState = (initial) => (host() ? host().useState(initial) : fallback.useState(initial))
export const useEffect = (factory, deps) => (host() ? host().useEffect(factory, deps) : fallback.useEffect(factory, deps))
export const useRef = (initial) => (host() ? host().useRef(initial) : fallback.useRef(initial))
`
const interceptReact = !reactExportsPath.includes('dsh-react-hook-shim')
if (interceptReact) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'react') return nextResolve(specifier, context)
      if (context.parentURL === shimUrl) return { url: reactExportsUrl, format: 'commonjs', shortCircuit: true }
      return { url: shimUrl, format: 'module', shortCircuit: true }
    },
    load(url, context, nextLoad) {
      if (url !== shimUrl) return nextLoad(url, context)
      return { format: 'module', shortCircuit: true, source: shimSource }
    }
  })
}
// `createElement` and everything else the client uses still come from real React.
const clientReact = realReact
/**
 * What the shim uses when no hook host is driving.
 *
 * The interception above is by SPECIFIER, so it also catches the real ReactDOM
 * root that §2 mounts — that root must run the component with React's own hooks
 * (it did, before this file existed). Only the hook host's mounts are redirected,
 * and `__dshHookHost` is set exactly while one of those is rendering.
 */
globalThis.__dshReactFallback = {
  useState: realReact.useState,
  useEffect: realReact.useEffect,
  useRef: realReact.useRef
}


/* ── Minimal DOM ─────────────────────────────────────────────────────────
 * Only what the mascot touches: element creation/removal, a mutable style
 * object (the drag writes left/top through it), classList, offsetWidth /
 * offsetHeight (the drag reads its live box), pointer capture and events.
 */
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
    this.defaultPrevented = false
  }
  preventDefault() {
    this.defaultPrevented = true
  }
  stopPropagation() {}
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.nodeType = 1
    this.parentNode = null
    this.childNodes = []
    // React writes a style object onto this, and it reaches for `setProperty`
    // whenever a value is a custom property (`--ps-scale`, the mascot's size).
    this.style = {
      setProperty(name, value) {
        this[name] = String(value)
      },
      removeProperty(name) {
        delete this[name]
      }
    }
    this.attributes = {}
    this.listeners = new Map()
    this.offsetWidth = 0
    this.offsetHeight = 0
    this.classList = {
      add: (name) => {
        const set = new Set(this.className.split(' ').filter(Boolean))
        set.add(name)
        this.className = [...set].join(' ')
      },
      remove: (name) => {
        const set = new Set(this.className.split(' ').filter(Boolean))
        set.delete(name)
        this.className = [...set].join(' ')
      },
      contains: (name) => this.className.split(' ').includes(name)
    }
    this._className = ''
  }
  get className() {
    return this._className
  }
  set className(value) {
    this._className = String(value ?? '')
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
  }
  getAttribute(name) {
    return this.attributes[name] ?? null
  }
  hasAttribute(name) {
    return name in this.attributes
  }
  removeAttribute(name) {
    delete this.attributes[name]
    if (name === 'id') delete this.id
  }
  contains(node) {
    if (node === this) return true
    return this.childNodes.some((child) => child.contains?.(node) === true)
  }
  appendChild(child) {
    child.parentNode = this
    this.childNodes.push(child)
    if (child.id) documentStub.registry.set(child.id, child)
    return child
  }
  insertBefore(child, before) {
    const at = before === null || before === undefined ? -1 : this.childNodes.indexOf(before)
    child.parentNode = this
    if (at < 0) this.childNodes.push(child)
    else this.childNodes.splice(at, 0, child)
    if (child.id) documentStub.registry.set(child.id, child)
    return child
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parentNode = null
    if (child.id) documentStub.registry.delete(child.id)
    return child
  }
  addEventListener(type, handler) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler)
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const documentStub = {
  body: new FakeElement('body'),
  head: new FakeElement('head'),
  registry: new Map(),
  /**
   * A DOM node per mounted element, reused across re-renders.
   *
   * React creates a node once and mutates it afterwards, so a stub that minted a
   * fresh node on every `createElement` would hand the component a different
   * object each render — and effects that WRITE the node (the drag writes
   * `style.left/top` straight to it) would appear to do nothing. Keyed by tag
   * plus class, which is unique enough for the two elements in this component.
   */
  mounted: new Map(),
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => documentStub.registry.get(id) ?? null,
  /**
   * Document-level listeners and the page's visibility, because the mascot's
   * fast poll backs off while the tab is hidden. A stub that swallowed these
   * would leave that branch untested — and, worse, would hide a component that
   * forgot to stop polling in a background tab.
   */
  visibilityState: 'visible',
  listeners: new Map(),
  addEventListener: (name, listener) => {
    if (!documentStub.listeners.has(name)) documentStub.listeners.set(name, new Set())
    documentStub.listeners.get(name).add(listener)
  },
  removeEventListener: (name, listener) => {
    documentStub.listeners.get(name)?.delete(listener)
  },
  dispatchEvent: (event) => {
    for (const listener of [...(documentStub.listeners.get(event.type) ?? [])]) listener(event)
    return true
  }
}
/** Map a React element onto a stable node, creating it on first sight. */
const nodeFor = (element, into = documentStub.mounted) => {
  const key = `${element.type}.${element.props?.className ?? ''}`
  if (!into.has(key)) into.set(key, documentStub.createElement(element.type))
  const node = into.get(key)
  node.className = String(element.props?.className ?? '')
  return node
}
documentStub.documentElement = new FakeElement('html')
// React reaches the document through the container it is given, so every
// element must answer `ownerDocument`.
Object.defineProperty(FakeElement.prototype, 'ownerDocument', {
  configurable: true,
  get() {
    return documentStub
  }
})

/* ── Storage and timers ─────────────────────────────────────────────────
 * The component's timers live in their own id space (negative ids, which real
 * timer ids never are). Handing React the same `clearTimeout` would let a
 * component cleanup cancel React's pending scheduler callback.
 */
const storage = new Map()
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
}

let componentTimerSeq = 0
const componentTimers = new Map()
const componentSetTimeout = (handler, delay) => {
  const id = -(++componentTimerSeq)
  componentTimers.set(id, setTimeout(handler, delay))
  return id
}
const componentClearTimeout = (id) => {
  if (!componentTimers.has(id)) return
  clearTimeout(componentTimers.get(id))
  componentTimers.delete(id)
}

const windowListeners = new Map()
/** Toggle for the `prefers-reduced-motion` query the mascot's flip consults. */
const reducedMotion = { matches: false }
const windowStub = {
  innerWidth: 1280,
  innerHeight: 800,
  localStorage: localStorageStub,
  // A real listener registry: the settings page and the mascot talk to each
  // other through window events, so a stub that swallows them would hide the
  // whole cross-component path.
  addEventListener: (name, listener) => {
    if (!windowListeners.has(name)) windowListeners.set(name, new Set())
    windowListeners.get(name).add(listener)
  },
  removeEventListener: (name, listener) => {
    windowListeners.get(name)?.delete(listener)
  },
  dispatchEvent: (event) => {
    for (const listener of [...(windowListeners.get(event.type) ?? [])]) listener(event)
    return true
  },
  setTimeout: componentSetTimeout,
  clearTimeout: componentClearTimeout,
  document: documentStub,
  // The mascot asks this to decide whether a replacement turns or swaps in
  // place. A real browser answers from the OS animation setting; here a test
  // flips it. Absent matchMedia must read as "no reduce" (the default), so the
  // stub starts false and only the reduce query ever answers true.
  matchMedia: (query) => ({ matches: reducedMotion.matches && String(query).includes('prefers-reduced-motion') })
}
documentStub.defaultView = windowStub
/**
 * The DOM classes React's commit phase tests with `instanceof` while restoring
 * selection (`getActiveElementDeep`). A stub DOM has no reason to define them
 * until React asks, and an undefined right-hand side is a hard crash rather than
 * a false negative — so they exist, and they match nothing.
 */
for (const name of ['HTMLIFrameElement', 'HTMLElement', 'Element', 'Node', 'Document', 'Window']) {
  windowStub[name] = class {}
}

globalThis.document = documentStub
globalThis.window = windowStub
globalThis.localStorage = localStorageStub
// Tells React it is running under a test harness, so `createRoot` commits its
// work synchronously instead of parking it with the scheduler for a later task.
// Without it the first commit lands after this harness has moved on (and takes
// a path that probes `window.HTMLIFrameElement`, which a stub DOM has no reason
// to define). The mascot's content is exercised by the hook host below; this is
// only here so the mount wiring checks are deterministic.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/**
 * Drop React's "update not wrapped in act" notices for the REAL root that §2
 * mounts.
 *
 * That root is driven by the same live handshake as the app (seat snapshot,
 * `/session`, `/roles`), so its updates arrive on the fetch's schedule and
 * cannot be wrapped — and §3 onward already proves what it would render, through
 * the hook host, where every update is observed. Wrapping that root in `act`
 * instead is what produced React 18's "Should not already be working" in this
 * harness. Every other warning still reaches the console: silencing these
 * notices must not hide a genuine render error.
 */
const reactError = console.error
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return
  reactError(...args)
}
windowStub.__psProbe = false
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }

/* ── Hook host ──────────────────────────────────────────────────────────
 * Runs a function component with React-compatible hook semantics, so the
 * component's own `useState`/`useEffect`/`useRef` calls behave as they do in the
 * app. Effects run synchronously after each render, which is what keeps the
 * display and drag assertions below readable.
 */

const depsChanged = (a, b) =>
  a === undefined || b === undefined || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))

/**
 * Every mount gets its own host entry, and `globalThis.__dshHookHost` points at
 * the entry of the mount that is CURRENTLY active. That indirection is the whole
 * point: an earlier mount's pending fetch resolves during a later mount's window
 * and its setter would otherwise write into — and re-render — a component it has
 * nothing to do with. With per-entry hosts the late write lands harmlessly in
 * its own (already replaced) slots.
 */
const hookHost = { entries: [] }
const activeHost = () => hookHost.entries[0] ?? { slots: [], cursor: 0, queued: [], cleanups: new Map(), rerender: null }
let mountSeq = 0

const runHooks = {
  useState(initial) {
    const host = activeHost()
    const at = host.cursor++
    if (host.slots.length <= at) host.slots[at] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = host.slots[at]
    return [
      slot.value,
      (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        if (activeHost() === host) host.rerender?.()
      }
    ]
  },
  useEffect(factory, deps) {
    const host = activeHost()
    const at = host.cursor++
    if (host.slots.length <= at) host.slots[at] = { deps: undefined }
    const slot = host.slots[at]
    const changed = depsChanged(slot.deps, deps)
    if (!changed) return
    slot.deps = deps
    host.queued.push({ at, factory })
  },
  useRef(initial) {
    const host = activeHost()
    const at = host.cursor++
    if (host.slots.length <= at) host.slots[at] = { value: { current: initial } }
    return host.slots[at].value
  }
}

/* ── Render helper: drives a component through the intercepted hooks ─── */
/**
 * Run one function component with React-compatible semantics: state keyed by
 * hook call order, dependency-array comparison, cleanups before a re-run and on
 * unmount, and effects flushed synchronously after each render.
 *
 * @param component - the function component to run.
 * @param props - the props to run it with.
 */
const renderComponent = (component, props) => {
  const host = {
    mountId: ++mountSeq,
    component,
    props,
    slots: [],
    cursor: 0,
    cleanups: new Map(),
    queued: [],
    draining: false,
    scheduled: false,
    // Per-mount DOM nodes: two live mascots must not share one node, or their
    // re-renders would overwrite each other's `style.left`.
    nodes: new Map(),
    rerender: null
  }
  hookHost.entries.unshift(host)
  globalThis.__dshHookHost = runHooks

  const render = () => {
    if (host.component !== component) return null
    // Re-render until nothing is scheduled any more. Returning inside the loop
    // matters: an earlier version returned the FIRST pass's element while a
    // scheduled re-render had already produced a newer one, so the hook slots
    // read as up to date and the element tree stayed one render behind — a state
    // that is impossible in React and cost a long hunt to see.
    let element = null
    let pass = 0
    do {
      host.scheduled = false
      host.cursor = 0
      host.queued = []
      element = component(props)
      // Wire the ref the way React does, BEFORE effects run — an effect that
      // measures or writes the node must see it. `props.ref` is stripped by
      // createElement, so the object lives on the element itself.
      if (element !== null && element.ref !== null && typeof element.ref === 'object') {
        element.ref.current = nodeFor(element, host.nodes)
      }
      // Drain in a re-entrancy-safe loop. A state update fired by one effect (the
      // session fetch resolving, say) used to re-render here synchronously, which
      // cleared `queued` halfway through and silently dropped the effects that had
      // not run yet — and re-ran the ones that had. React commits effects one
      // pass deep; this reproduces that.
      host.draining = true
      try {
        for (let index = 0; index < host.queued.length; index += 1) {
          const { at, factory } = host.queued[index]
          const previousCleanup = host.cleanups.get(at)
          if (typeof previousCleanup === 'function') previousCleanup()
          const cleanup = factory()
          if (typeof cleanup === 'function') host.cleanups.set(at, cleanup)
          else host.cleanups.delete(at)
        }
      } finally {
        host.draining = false
      }
      pass += 1
    } while (host.scheduled && pass < 50)
    // The last pass is what the caller sees. Assigning here is the only place
    // `host.element` is published, so the element tree can never stay one
    // render behind the hook slots.
    host.element = element
    return element
  }

  host.rerender = () => {
    if (activeHost() !== host) return
    if (host.draining) {
      host.scheduled = true
      return
    }
    render()
  }
  host.element = render()
  return {
    get element() {
      return host.element
    },
    /**
     * A one-line view of the latest render's hook slots. Assertions below are
     * about what the user sees (the element tree); this exists so a failed
     * assertion can be diagnosed from the log instead of by re-running.
     */
    dump: () => host.slots.map((slot) => JSON.stringify(slot.value ?? slot.deps ?? null)).join(' | '),
    /** Re-run the component, as React would after a state update or a notify. */
    render,
    /** Unmount: run every cleanup, exactly like React does. */
    unmount() {
      for (const cleanup of host.cleanups.values()) {
        if (typeof cleanup === 'function') cleanup()
      }
      host.cleanups.clear()
      host.component = null
      host.rerender = null
      const at = hookHost.entries.indexOf(host)
      if (at >= 0) hookHost.entries.splice(at, 1)
      // Hand the client's hooks back to React: with no host entry active, the
      // shim falls through to the real implementation (a real renderer, a later
      // mount, anything that is not this harness).
      if (hookHost.entries.length === 0) globalThis.__dshHookHost = undefined
    }
  }
}

/* ── Check harness ───────────────────────────────────────────────────── */
let passed = 0
const failures = []
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1
    return true
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}
const settle = (ms = 40) => sleep(ms)
const poll = async (label, predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return check(label, true)
    await settle(15)
  }
  return check(label, false, `not observed within ${timeoutMs}ms`)
}

/**
 * The same wait, on the REAL clock.
 *
 * The component's timers are stubbed so a test can let a 5s artwork poll fire
 * instantly — but a check about a 250ms poll interval has to outlast real time,
 * because the fake queue only knows the delays tests have registered. Sections
 * 10 and 11 use this one.
 */
const realPoll = async (label, predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return check(label, true)
    await settle(20)
  }
  return check(label, false, `not observed within ${timeoutMs}ms`)
}

/* ── Fetch stub: records every request, serves canned host responses ─── */
class FakeAbortError extends Error {}
const requests = []
let sessionAnswer = { ok: true, roleId: null }
/** Artificial latency for `/session`, so a test can pin down a restart race. */
let sessionDelayMs = 0
let rolesAnswer = { ok: true, roles: [] }
/**
 * The revision counter's answer, or `null` for "this host predates the
 * endpoint" — the two cases the mascot has to tell apart.
 *
 * It is a getter so a test can bump it with `bumpRevision()` and have every
 * later poll see the new value, exactly as the host does.
 */
let revisionAnswer = null
/** When true, the `/roles` read answers 500 — a transient host failure. */
let rolesShouldFail = false
/** When true, every request rejects outright — a host that is not listening. */
let hostDown = false
const revisionReads = { count: 0 }
const bumpRevision = () => {
  revisionAnswer = { ok: true, revision: (revisionAnswer?.revision ?? 0) + 1 }
}
/** Treat the host as one without a counter endpoint (a 404). */
const noRevisionEndpoint = () => {
  revisionAnswer = null
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  requests.push(target)
  if (options.signal?.aborted) throw new FakeAbortError('aborted')
  if (hostDown) throw new TypeError('fetch failed')
  if (target.includes('/revision')) {
    revisionReads.count += 1
    if (revisionAnswer === null) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unknown endpoint' }) }
    }
    return { ok: true, status: 200, json: async () => revisionAnswer }
  }
  if (target.includes('/roles') && rolesShouldFail) {
    // A transient host failure, for the "does the loop keep trying" check.
    return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
  }
  const payload = target.includes('/session') ? sessionAnswer : rolesAnswer
  if (target.includes('/session') && sessionDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sessionDelayMs))
    if (options.signal?.aborted) throw new FakeAbortError('aborted')
  }
  return { ok: true, status: 200, json: async () => payload }
}
const countOf = (needle) => requests.filter((url) => url.includes(needle)).length
const resetRequests = () => {
  requests.length = 0
  revisionReads.count = 0
}

/* ── Tree helpers (walk the real element objects React.createElement made) ── */
const findNodes = (element, tag) => {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node.type === 'string' && node.type.toUpperCase() === tag.toUpperCase()) found.push(node)
    walk(node.props?.children)
  }
  walk(element)
  return found
}
const layerOf = (element) => findNodes(element, 'div')[0]
const imageOf = (element) => findNodes(element, 'img')[0]

/**
 * Does any painted `<img>` carry this substring in its `src`?
 *
 * A role REPLACEMENT is shown by turning a card whose front face is the old art
 * and back face the new one, so for ~1s the new art is on screen but is NOT the
 * first `<img>` in the tree. A poll that only looked at `imageOf` would miss it
 * and wait for the turn to commit — conflating detection latency with the
 * animation. This asks the honest question: is that art visible right now,
 * by whichever face is showing it?
 *
 * @param element - the mascot root element.
 * @param needle - the substring to look for in a painted src.
 */
const paintsSrc = (element, needle) =>
  findNodes(element, 'img').some((node) => String(node.props?.src ?? '').includes(needle))

/**
 * Is the mascot invisible right now?
 *
 * The outer box stays mounted on purpose: it carries the cross-fade (`opacity`)
 * and the dragged position, so hiding is a class change rather than an unmount.
 * "Not shown" therefore means "no artwork image and the box is not marked
 * shown" — which the stylesheet turns into `opacity: 0` plus `pointer-events:
 * none`, i.e. nothing on screen and nothing in the hit-test path.
 */
const hiddenMascot = (element) => {
  const layer = layerOf(element)
  if (layer === undefined) return true
  return imageOf(element) === undefined && !layer.props.className.includes('is-shown')
}
/** Is the mascot on screen right now? */
const shownMascot = (element) => {
  const layer = layerOf(element)
  return layer !== undefined && layer.props.className.includes('is-shown') && imageOf(element) !== undefined
}

/** Fire one of the element's React props the way the browser would. */
const fire = (element, prop, init) => {
  const handler = element?.props?.[prop]
  if (typeof handler !== 'function') return false
  handler(new FakeEvent(prop.slice(2).toLowerCase(), init))
  return true
}

const mascot = await import(pathToFileURL(MASCOT_PATH).href)
const {
  installMascot,
  readShown,
  readSize,
  writeSize,
  clampSize,
  readMotion,
  writeMotion,
  mascotInternals: {
    artOf,
    clearPos,
    defaultPos,
    fitToViewport,
    followSnapshot,
    isSeatService,
    normalizeMotion,
    planFlip,
    positionFromStorage,
    reducedMotion: motionReducer,
    seatIdOf,
    clamp,
    MascotGate,
    PersonaMascot,
    FLIP_TOTAL_MS,
    FLIP_COMMIT_MARGIN_MS
  }
} = mascot

const SHOWN_KEY = mascot.SHOWN_KEY
const POS_KEY = mascot.POS_KEY
const SIZE_KEY = mascot.SIZE_KEY
const MOTION_KEY = mascot.MOTION_KEY
const MOTION_VALUES = mascot.MOTION_VALUES
const SIZE_MIN = mascot.SIZE_MIN
const SIZE_MAX = mascot.SIZE_MAX
const CHANGED_EVENT = mascot.CHANGED_EVENT
const SHOWN_EVENT = mascot.SHOWN_EVENT
const SIZE_EVENT = mascot.SIZE_EVENT
const MOTION_EVENT = mascot.MOTION_EVENT
const REVISION_POLL_MS = mascot.mascotInternals.REVISION_POLL_MS
const REVISION_SLOW_MS = mascot.mascotInternals.REVISION_SLOW_MS
// The client's API prefix and the host's default `routePrefix` are two copies of
// one fact — the bundle cannot read the host's config — so they are pinned
// together here. Changing the host default without changing the client would make
// every request 404, and the host half has a matching check that the artwork URL
// follows the prefix it actually mounted at.
const API_BASE_UNDER_TEST = '/persona-switcher'
const POS_EVENT = mascot.POS_EVENT
const IDENTITY = (key) => key

/** A `sidebarRight` double: `mounted` behaves like the host's snapshot. */
const mkSeat = (initial) => {
  let value = initial
  const listeners = new Set()
  return {
    service: {
      mounted: {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    },
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size
  }
}
const mkCtx = (seatService) => ({ get: (name) => (name === 'sidebarRight' ? seatService : undefined), effect: () => () => {} })

/** The seat the visible-state block drives; one identity for its whole life. */
const visibleSeat = mkSeat('session-a')
const visibleCtx = mkCtx(visibleSeat.service)

/* ── 1. Master switch ─────────────────────────────────────────────────── */
check('the hook shim owns the client module hooks, not React itself', typeof globalThis.__dshHookHost === 'undefined' || globalThis.__dshHookHost === runHooks)
check('switch defaults to on when storage is empty', readShown() === true, `got ${readShown()}`)
localStorageStub.setItem(SHOWN_KEY, '0')
check('switch reads the stored off value', readShown() === false)
localStorageStub.setItem(SHOWN_KEY, 'garbage')
check('a corrupt switch value stays on (never silently hides)', readShown() === true)
localStorageStub.removeItem(SHOWN_KEY)
check(
  'own storage keys, namespaced away from the wallpaper engine',
  SHOWN_KEY.startsWith('dsh-persona-switcher:') && POS_KEY.startsWith('dsh-persona-switcher:') && MOTION_KEY.startsWith('dsh-persona-switcher:'),
  `${SHOWN_KEY} / ${POS_KEY} / ${MOTION_KEY}`
)
check(
  'no key or event name collides with the wallpaper engine',
  [SHOWN_KEY, POS_KEY, MOTION_KEY, CHANGED_EVENT, SHOWN_EVENT, MOTION_EVENT].every((name) => !name.includes('wallpaper')),
  [SHOWN_KEY, POS_KEY, MOTION_KEY, CHANGED_EVENT, SHOWN_EVENT, MOTION_EVENT].join(' ')
)

/* ── 1b. The animation preference (system / always / never) ──────────────
 * The plugin-level override that lets a machine whose OS animation switch is
 * off still see the turn — and lets anyone silence it where the OS allows it.
 * The system reading (matchMedia) is only consulted for 'system'.
 */
{
  check('the animation preference defaults to following the system', readMotion() === 'system', readMotion())
  check('always and never are the two overrides', normalizeMotion('always') === 'always' && normalizeMotion('never') === 'never')
  check('anything else folds onto system (a corrupt value never forces a choice)', normalizeMotion('garbage') === 'system' && normalizeMotion(null) === 'system' && normalizeMotion('') === 'system')
  check('writeMotion normalizes what it stores', writeMotion('always') === 'always' && writeMotion('nonsense') === 'system')
  check('a stored preference is read back', (storage.set(MOTION_KEY, 'never'), readMotion() === 'never'))

  // The decision itself, against both system readings. The stub's matchMedia
  // answers from `reducedMotion.matches` for the reduce query only.
  storage.delete(MOTION_KEY)
  reducedMotion.matches = false
  check("system allows animation + 'system' ⇒ turn", motionReducer() === false)
  reducedMotion.matches = true
  check('system reduce + system ⇒ no turn', motionReducer() === true)
  storage.set(MOTION_KEY, 'always')
  reducedMotion.matches = true
  check("'always' overrides system reduce ⇒ turn anyway", motionReducer() === false)
  storage.set(MOTION_KEY, 'never')
  reducedMotion.matches = false
  check("'never' overrides system allow ⇒ no turn", motionReducer() === true)
  storage.delete(MOTION_KEY)
  reducedMotion.matches = false
}
{
  // Requests must go to the prefix the host actually mounts. The bundle cannot
  // read the host's config, so these are two copies of one fact and they are
  // pinned together here; the host half asserts its own side (the artwork URL is
  // built from the prefix it mounted at).
  const clientSource = readFileSync(new URL('../src/client/mascot.jsx', import.meta.url), 'utf8')
  const declared = /const API_BASE = '([^']+)'/.exec(clientSource)?.[1]
  check('the client asks the prefix the host mounts by default', declared === API_BASE_UNDER_TEST, String(declared))
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const hostDefault = /routePrefix: z\.string\(\)\.default\('([^']+)'\)/.exec(hostSource)?.[1]
  check('and that prefix is the host schema default', hostDefault === declared, `${hostDefault} vs ${declared}`)
}

/* ── 2. Mount wiring (the real createRoot path) ───────────────────────── */
{
  resetRequests()
  const dispose = installMascot(mkCtx(mkSeat('session-a').service), IDENTITY)
  if (typeof dispose !== 'function') {
    console.error('installMascot refused to mount; the remaining checks need it')
    process.exit(1)
  }
  const dock = documentStub.getElementById('dsh-persona-switcher-mascot-dock')
  check('installMascot creates its own dock on <body>', dock !== null && dock.parentNode === documentStub.body)
  check('dock id is distinct from the rope dock', dock !== null && dock.id !== 'dsh-wallpaper-engine-rope-dock')
  const styleNode = documentStub.getElementById('persona-switcher-mascot-style')
  const styleText = styleNode === null ? '' : styleNode.textContent
  check('stylesheet installed under its own id', styleNode !== null)
  check('mascot paints at z-index 995 (below the rope 996)', /z-index:\s*995/.test(styleText))
  check('no CSS filter anywhere in the mascot stylesheet', !/filter\s*:/.test(styleText))
  // The flip: the turn is a keyframe on the card and faces hide their back side.
  // The card stays flat — no lift (translateZ), no shadow (box-shadow), and no
  // filter anywhere (the white-flash rule above still holds stylesheet-wide).
  check('the flip has a keyframe turn', /@keyframes\s+ps-flip/.test(styleText))
  check('the turn is driven by rotateY (the vertical axis)', /rotateY\(180deg\)/.test(styleText))
  check('faces hide their back side so only the facing one paints', /backface-visibility:\s*hidden/.test(styleText))
  check('the incoming face is pre-rotated to face the viewer on landing', /\.ps-mascot__face--back\s*\{\s*transform:\s*rotateY\(180deg\)/.test(styleText))
  check('the card stays flat: no lift, no shadow, no filter', !/translateZ/.test(styleText) && !/box-shadow\s*:/.test(styleText) && !/filter\s*:/.test(styleText))
  check('the turn is exactly the ~1s the design called for', /animation:\s*ps-flip 1000ms/.test(styleText))
  check('the dock itself is display:contents (no layout box of its own)', /display:\s*contents/.test(styleText))
  check('hidden mascot keeps pointer-events:none', /pointer-events:\s*none/.test(styleText))
  check('touch-action:none keeps the pointer stream unbroken', /touch-action:\s*none/.test(styleText))
  check('the artwork image never eats the drag', /\.ps-mascot__art[\s\S]{0,260}pointer-events:\s*none/.test(styleText))
  check('image keeps its aspect ratio inside the box', /height:\s*auto/.test(styleText))
  check('the hidden mascot contributes nothing to the hit-test', /pointer-events:\s*none/.test(styleText))
  // The hover growth, pinned to the wallpaper engine's rope so the two mascots
  // behave the same on screen and neither number can drift unnoticed. The
  // growth is on the IMAGE, so the box keeps the size the drag gave it.
  check(
    'hover grows the artwork like the rope does (1.06)',
    /\.ps-mascot:hover \.ps-mascot__art\s*\{\s*transform:\s*scale\(1\.06\)/.test(styleText)
  )
  check('the hover growth is animated, not instantaneous', /transition:\s*transform 120ms/.test(styleText))
  check(
    'the growth is on the image, never on the dragged box',
    !/\.ps-mascot:hover\s*\{[^}]*transform:\s*scale/.test(styleText)
  )
  // The reduced-motion branch must NOT cancel the growth. It exists to drop the
  // 120ms of easing, not the feedback itself — cancelling it removed the effect
  // for every user whose system reports reduce, which is how this shipped broken
  // once (found on a real machine: prefers-reduced-motion: reduce was matching,
  // so the artwork never grew). NOTE: this file is a template literal, so no
  // backticks may appear in these comments.
  {
    const block = styleText.slice(styleText.indexOf('prefers-reduced-motion'))
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'))
    check('the reduced-motion branch still exists', block.length > 0)
    check('reduced motion does not cancel the hover growth', !/transform:\s*none/.test(body), body.trim())
    check('reduced motion does drop the easing', /transition:\s*none/.test(body))
  }
  // The real renderer (not the hook host) has to paint something into the dock,
  // or "installMascot creates a dock" would be true of an empty div.
  await poll('the real React root paints into the dock', () => dock.childNodes.length > 0, 3000)
  dispose()
  // The teardown is deferred on purpose — React refuses a synchronous unmount
  // while it is rendering, so the plugin's disposal cannot unmount inline.
  await settle(20)
  // The dock NODE deliberately stays: the module keeps it (and its root), and the
  // next install re-renders into it. Deleting it here is what made a re-applied
  // effect mount a second root onto a node a stale unmount was about to remove —
  // the mascot then vanished with no error anywhere. Its CONTENT must be gone.
  check('disposer empties the dock', dock.childNodes.length === 0, `${dock.childNodes.length} child node(s) left`)
  check('disposer keeps the dock node for reuse', documentStub.getElementById('dsh-persona-switcher-mascot-dock') === dock)
  check('disposer leaves the settings stylesheet alone', documentStub.getElementById('persona-switcher-settings-style') === null)
}

/* ── 2b. The mount is skippable (a host without a DOM or without a context) ── */
{
  const before = documentStub.getElementById('dsh-persona-switcher-mascot-dock')
  check('the dock from the previous install is the one still on the page', before !== null)
  check('installMascot needs a ctx.effect', installMascot({}, IDENTITY) === undefined)
  const bare = installMascot({ effect: () => () => {} }, IDENTITY)
  check('a ctx without get() still mounts (sidebarRight is optional)', typeof bare === 'function')
  bare()
  await settle(20)
  check('that install reused the same dock node', documentStub.getElementById('dsh-persona-switcher-mascot-dock') === before)
}

/* ── 3. Silent states: switch off, no role, no artwork, no seat ───────── */
{
  localStorageStub.setItem(SHOWN_KEY, '0')
  resetRequests()
  const seat = mkSeat('session-a')
  const gate = renderComponent(MascotGate, { ctx: mkCtx(seat.service), t: IDENTITY, onShown: () => {} })
  await settle(60)
  check('switch off renders nothing at all', gate.element === null)
  check('switch off sends zero requests', requests.length === 0, requests.join(', '))
  check('switch off never subscribes to the seat snapshot', seat.listenerCount() === 0)
  gate.unmount()
  localStorageStub.removeItem(SHOWN_KEY)
}

{
  resetRequests()
  sessionAnswer = { ok: true, roleId: null }
  rolesAnswer = { ok: true, roles: [{ id: 'session-a', name: 'A', mascot: null }] }
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-a').service), t: IDENTITY, onShown: () => {} })
  await poll('a seat on screen ⇒ /session is asked', () => countOf('/session') > 0)
  check(
    'session is queried by the seat id the host handed over',
    requests.some((url) => url.includes('/session?session=session-a')),
    requests.join(', ')
  )
  view.render()
  check('roleId null ⇒ nothing is shown (not even a placeholder)', hiddenMascot(view.element))
  view.unmount()
}

{
  resetRequests()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = { ok: true, roles: [{ id: 'amiya', name: '阿米娅', mascot: null }] }
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-a').service), t: IDENTITY, onShown: () => {} })
  await poll('a role is asked about its artwork through /roles', () => {
    view.render()
    return layerOf(view.element) !== undefined && countOf('/roles') > 0
  })
  check('roles are fetched once the session has a role', countOf('/roles') > 0, requests.join(', '))
  check('role without artwork ⇒ nothing is shown', hiddenMascot(view.element))
  view.unmount()
}

{
  resetRequests()
  sessionAnswer = { ok: true }
  rolesAnswer = { ok: true, roles: [{ id: 'amiya', name: '阿米娅', mascot: { image: '/x.png', box: '64x64' } }] }
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-a').service), t: IDENTITY, onShown: () => {} })
  await poll('the session query resolves', () => {
    view.render()
    return countOf('/session') > 0
  })
  await settle(40)
  view.render()
  check('a missing roleId key is treated exactly like null', imageOf(view.element) === undefined)
  check('a missing roleId key never triggers the artwork query', countOf('/roles') === 0, requests.join(', '))
  view.unmount()
}

{
  resetRequests()
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat(undefined).service), t: IDENTITY, onShown: () => {} })
  await settle(80)
  view.render()
  check('no seat on screen ⇒ not a single request', requests.length === 0, requests.join(', '))
  check('no seat on screen ⇒ nothing is shown', hiddenMascot(view.element))
  view.unmount()
}

{
  // Some shells report "no seat" as a blank id rather than `undefined`. It has to
  // mean the same thing: querying `/session?session=` can only 404, and a mascot
  // that stays blank forever is worse than one that is simply absent.
  resetRequests()
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('   ').service), t: IDENTITY, onShown: () => {} })
  await settle(80)
  view.render()
  check('a blank seat id is read as "no seat", not queried', requests.length === 0, requests.join(', '))
  check('a blank seat id shows nothing', hiddenMascot(view.element))
  view.unmount()
}

{
  const returned = installMascot({ effect: () => () => {}, logger: { warn: (...args) => console.error('[mount-warn]', ...args) } }, IDENTITY)
  check('a ctx without get() still mounts (sidebarRight is optional)', typeof returned === 'function')
  returned()
  await settle(20)
}

/* ── 4. Visible state, dragging, hysteresis ───────────────────────────── */
{
  resetRequests()
  // One seat and one `ctx` for the whole block: the component's seat effect
  // depends on the context identity, so a fresh object per render would re-arm
  // the subscription every time and keep clearing the session (which is correct
  // for a replaced service, and fatal for a test that fabricates one per call).
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = {
    ok: true,
    roles: [
      { id: 'amiya', name: '阿米娅', mascot: { image: '/persona-switcher/mascot-file/amiya-abc.png', box: '512x768' } },
      { id: 'whale-girl', name: '鲸鱼娘', mascot: null }
    ]
  }
  const view = renderComponent(PersonaMascot, { ctx: visibleCtx, t: IDENTITY, onShown: () => {} })
  await poll('all four conditions met ⇒ artwork appears', () => {
    view.render()
    return shownMascot(view.element)
  }, 8000)

  let layer = layerOf(view.element)
  let image = imageOf(view.element)
  check('mascot box carries the is-shown class', layer !== undefined && layer.props.className.includes('is-shown'), layer?.props?.className)
  check('box width follows the role artwork box (512x768 ⇒ 512px)', layer?.props?.style?.width === '512px', layer?.props?.style?.width)
  check('exactly one <img> is rendered', image !== undefined)
  check('image src is the host-reported URL', image?.props?.src === '/persona-switcher/mascot-file/amiya-abc.png', image?.props?.src)
  check('image is decorative for assistive tech', image?.props?.alt === '')
  check(
    'the box is announced as the current role mascot',
    layer?.props?.role === 'img' && String(layer?.props?.['aria-label'] ?? '').includes('mascotAria')
  )
  check('roles come from the plugin namespace', requests.some((url) => url.includes('/persona-switcher/roles')), requests.join(', '))
  check('the mascot does not touch the settings stylesheet', documentStub.getElementById('persona-switcher-settings-style') === null)

  /* 4a. Hysteresis — a seat change drops the old role before the new one is known. */
  resetRequests()
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  visibleSeat.set('session-b')
  view.render()
  check('seat change stops showing the previous artwork immediately', imageOf(view.element) === undefined, layerOf(view.element)?.className)
  check('seat change asks the NEW session for its role', requests.some((url) => url.includes('session-b')), requests.join(', '))
  check('the previous session role is never reused for the new seat', !requests.some((url) => url.includes('session-a')))

  /* 4b. Back to a role with artwork, then drag it. */
  sessionAnswer = { ok: true, roleId: 'amiya' }
  visibleSeat.set('session-a')
  view.render()
  await poll('artwork returns for the restored seat', () => {
    view.render()
    return shownMascot(view.element)
  }, 8000)
  layer = layerOf(view.element)
  image = imageOf(view.element)
  check('artwork is back for the restored seat', image !== undefined)

  // The drag is about one node, so it gets its own mount: a second mascot bound
  // to the SAME node would fight over `style.left` on every re-render, and the
  // two would look like they were cancelling each other out.
  //
  // The soft clamp is deliberately out of the picture here: it is real behaviour
  // (checked in §7) and would mask the thing these checks are about, namely that
  // the box goes exactly where it is dropped. A small box, a big viewport, and a
  // mid-screen start do that — and storage is written BEFORE the mount, because
  // the position is read once, when the component mounts.
  storage.set(POS_KEY, JSON.stringify({ x: 700, y: 400 }))
  windowStub.innerWidth = 1920
  windowStub.innerHeight = 1080
  const parked = renderComponent(PersonaMascot, { ctx: visibleCtx, t: IDENTITY, onShown: () => {} })
  await poll('the mascot mounts for the drag checks', () => {
    parked.render()
    return imageOf(parked.element) !== undefined
  }, 8000)
  layer = layerOf(parked.element)
  const parkedNode = layer.ref.current
  parkedNode.offsetWidth = 64
  parkedNode.offsetHeight = 64
  parked.render()
  layer = layerOf(parked.element)
  const start = { x: parkedNode.style.left, y: parkedNode.style.top }
  check('a stored resting position is read once, on mount', start.x === '700px' && start.y === '400px', `${start.x} / ${start.y}`)

  fire(layer, 'onPointerDown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 })
  check('pointerdown marks the box as dragging', parkedNode.className.includes('is-dragging'))
  fire(layer, 'onPointerMove', { pointerId: 1, clientX: 102, clientY: 102 })
  check(
    '2px of jitter stays inside the 3px dead zone (no drag)',
    parkedNode.style.left === start.x && parkedNode.style.top === start.y,
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )
  check('jitter alone stores nothing', storage.get(POS_KEY) === JSON.stringify({ x: 700, y: 400 }))
  fire(layer, 'onPointerMove', { pointerId: 1, clientX: 140, clientY: 160 })
  check(
    'past the dead zone the box follows the pointer exactly (no easing, no ratio)',
    parkedNode.style.left === '740px' && parkedNode.style.top === '460px',
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )
  const moved = { x: parkedNode.style.left, y: parkedNode.style.top }
  fire(layer, 'onPointerMove', { pointerId: 99, clientX: 900, clientY: 900 })
  check('a foreign pointer id is ignored', parkedNode.style.left === moved.x && parkedNode.style.top === moved.y)
  fire(layer, 'onPointerUp', { pointerId: 1, clientX: 140, clientY: 160 })
  check('pointerup ends the drag state', !parkedNode.className.includes('is-dragging'))
  check(
    'the stored position is exactly where the hand let go (no snap to any edge)',
    storage.get(POS_KEY) === JSON.stringify({ x: 740, y: 460 }),
    storage.get(POS_KEY)
  )
  // Let React commit the dropped position before the next gesture, the way it
  // does in the browser; otherwise the click below starts from the pre-drop
  // position that is still in the DOM node.
  parked.render()
  layer = layerOf(parked.element)
  check(
    'the drop survives the render that commits it',
    parkedNode.style.left === '740px' && parkedNode.style.top === '460px',
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )

  /* 4c. A click inside the dead zone leaves the resting spot where it is. */
  const hold = { x: parkedNode.style.left, y: parkedNode.style.top }
  fire(layer, 'onPointerDown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 })
  fire(layer, 'onPointerUp', { pointerId: 2, clientX: 301, clientY: 301 })
  check(
    'a click does not move the box',
    parkedNode.style.left === hold.x && parkedNode.style.top === hold.y,
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )
  check('a click re-persists the unchanged resting spot', storage.get(POS_KEY) === JSON.stringify({ x: 740, y: 460 }), storage.get(POS_KEY))

  /* 4d. After a drop the position belongs to the user: nothing else may move it. */
  parked.render()
  layer = layerOf(parked.element)
  check(
    'a later re-render leaves a dropped position alone',
    parkedNode.style.left === '740px' && parkedNode.style.top === '460px',
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )
  parkedNode.offsetWidth = 512
  parkedNode.offsetHeight = 768
  parked.render()
  layer = layerOf(parked.element)
  check(
    'a wider artwork does not drag a placed mascot back to storage',
    parkedNode.style.left === '740px' && parkedNode.style.top === '460px',
    `${parkedNode.style.left} / ${parkedNode.style.top}`
  )
  fire(layer, 'onPointerDown', { pointerId: 3, pointerType: 'mouse', button: 2, clientX: 300, clientY: 300 })
  check('right-click does not start a drag (the native menu stays reachable)', !parkedNode.className.includes('is-dragging'))
  check('the mascot installs no context-menu handler', layer.props.onContextMenu === undefined)
  parked.unmount()
  windowStub.innerWidth = 1280
  windowStub.innerHeight = 800

  /* 4e. An undecodable URL must not leave a ghost box behind. */
  check('the image exposes an onError handler', typeof image?.props?.onError === 'function')
  image?.props?.onError?.()
  view.render()
  check('an undecodable artwork URL removes the mascot', imageOf(view.element) === undefined)

  view.unmount()
  windowStub.innerWidth = 1280
  windowStub.innerHeight = 800
  localStorageStub.removeItem(POS_KEY)

  /* 4f. A shrink re-clamps in memory and never rewrites storage. */
  {
    const stored = JSON.stringify({ x: 900, y: 600 })
    localStorageStub.setItem(POS_KEY, stored)
    windowStub.innerWidth = 600
    windowStub.innerHeight = 500
    const resized = renderComponent(PersonaMascot, { ctx: visibleCtx, t: IDENTITY, onShown: () => {} })
    await settle(20)
    resized.render()
    check(
      'a shrink never rewrites the stored position',
      localStorageStub.getItem(POS_KEY) === stored,
      `${stored} ⇒ ${localStorageStub.getItem(POS_KEY)}`
    )
    resized.unmount()
    windowStub.innerWidth = 1280
    windowStub.innerHeight = 800
  }
}

/* ── 5. Data contract (pure) ──────────────────────────────────────────── */
const roles = [
  { id: 'amiya', name: '阿米娅', mascot: { image: '/a.png', box: '512x768' } },
  { id: 'no-name', mascot: { image: '/b.png', box: '64x64' } },
  { id: 'no-art', name: 'X', mascot: null },
  { id: 'bad-box', name: 'Y', mascot: { image: '/c.png', box: 'wide' } },
  { id: 'empty-image', name: 'Z', mascot: { image: '', box: '64x64' } },
  { id: 'odd-box', name: 'W', mascot: { image: '/d.png', box: '00064x64' } }
]
check('artwork resolves for a bound role', artOf(roles, 'amiya')?.src === '/a.png')
check('the label falls back to the role id when unnamed', artOf(roles, 'no-name')?.label === 'no-name')
check('mascot:null means no artwork', artOf(roles, 'no-art') === null)
check('an unparsable box means no artwork (the host is the only judge)', artOf(roles, 'bad-box') === null, JSON.stringify(artOf(roles, 'bad-box')))
check('an empty image means no artwork', artOf(roles, 'empty-image') === null)
check('an unknown role id means no artwork', artOf(roles, 'ghost') === null)
check('a non-string roleId means no artwork', artOf(roles, null) === null)
check('box width drives the rendered size', artOf(roles, 'no-name')?.width === 64)
check('a leading-zero box still parses', artOf(roles, 'odd-box')?.width === 64)

/* ── 6. Snapshot following ────────────────────────────────────────────── */
{
  let value = 's1'
  const listeners = new Set()
  const snapshot = {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  let hits = 0
  const followed = followSnapshot(snapshot, () => {
    hits += 1
  })
  check('followSnapshot reads the initial value', followed.value === 's1')
  value = 's2'
  for (const listener of listeners) listener()
  check('followSnapshot reports changes through the listener', hits === 1)
  check('followSnapshot re-reads on notify, not on the captured value', followed.current.value === 's2')
  followed.stop()
  check('followSnapshot unsubscribes', listeners.size === 0)

  let reads = 0
  const flaky = {
    getSnapshot: () => {
      reads += 1
      if (reads > 1) throw new Error('boom')
      return 'first'
    },
    subscribe: (listener) => {
      flaky.listener = listener
      return () => {}
    }
  }
  const guarded = followSnapshot(flaky, () => {})
  flaky.listener()
  check('a failing re-read degrades to undefined instead of throwing', guarded.current.value === undefined)

  const missing = followSnapshot(undefined, () => {})
  check('an absent snapshot reads as undefined, without throwing', missing.value === undefined && missing.stop === null)
  const partial = followSnapshot({}, () => {})
  check('a snapshot without getSnapshot degrades to undefined', partial.value === undefined)
  check(
    'a hostile snapshot never throws',
    followSnapshot(
      {
        getSnapshot: () => {
          throw new Error('boom')
        }
      },
      () => {}
    ).value === undefined
  )
  check('a seat service is recognised by its mounted snapshot', isSeatService({ mounted: {} }) === true)
  check('a service without mounted is not a seat service', isSeatService({ openTab: () => {} }) === false)
  check('null is not a seat service', isSeatService(null) === false)
}

/* ── 7. Geometry ──────────────────────────────────────────────────────── */
check('clamp keeps the box EDGE px inside the left/top edge', clamp(-500, 8, 100) === 8)
const clamped = fitToViewport({ x: 5000, y: 5000 }, { w: 512, h: 768 })
check(
  'clamp keeps the box inside the bottom-right corner',
  clamped.x === 1280 - 512 - 8 && clamped.y === 800 - 768 - 8,
  JSON.stringify(clamped)
)
// Mid-screen means middle of the ALLOWED range: a 768px-tall box in an 800px
// viewport can only sit between y=8 and y=24, so "no snap" has to be checked
// with a box that actually has room to be off-centre.
const dropped = fitToViewport({ x: 321, y: 234 }, { w: 140, h: 182 })
check('a mid-screen drop is kept verbatim (no edge snap)', dropped.x === 321 && dropped.y === 234, JSON.stringify(dropped))
const oversized = fitToViewport({ x: 900, y: 900 }, { w: 4000, h: 4000 })
check(
  'an oversized box degrades to the corner instead of a negative span',
  oversized.x === 8 && oversized.y === 8,
  JSON.stringify(oversized)
)

/* ── 8. Size multiplier and the position reset (settings page ↔ mascot) ── */
{
  check('a missing size multiplier means 1×', readSize() === 1)
  storage.set(SIZE_KEY, '1.75')
  check('a stored size multiplier is read back', readSize() === 1.75)
  storage.set(SIZE_KEY, '9')
  check('an oversized multiplier is clamped to the maximum', readSize() === SIZE_MAX, String(readSize()))
  storage.set(SIZE_KEY, '0.1')
  check('an undersized multiplier is clamped to the minimum', readSize() === SIZE_MIN, String(readSize()))
  storage.set(SIZE_KEY, 'nonsense')
  check('a corrupt multiplier falls back to 1×', readSize() === 1)
  storage.delete(SIZE_KEY)

  check('writeSize stores what it clamped', writeSize(1.4) === 1.4 && storage.get(SIZE_KEY) === '1.4', storage.get(SIZE_KEY))
  check('writeSize never stores a zero or negative multiplier', writeSize(-3) === 1, String(writeSize(-3)))
  storage.delete(SIZE_KEY)

  // The size is CSS on the wrapper, so the drag can still measure the box and
  // the artwork keeps its own aspect ratio.
  storage.set(SIZE_KEY, '2')
  storage.set(SHOWN_KEY, '1')
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = {
    ok: true,
    roles: [{ id: 'amiya', name: '阿米娅', mascot: { image: '/persona-switcher/mascot-file/amiya-abc.png', box: '512x768' } }]
  }
  const scaled = renderComponent(PersonaMascot, { ctx: visibleCtx, t: IDENTITY, onShown: () => {} })
  await poll('the mascot mounts for the size checks', () => {
    scaled.render()
    return imageOf(scaled.element) !== undefined
  }, 8000)
  let scaledLayer = layerOf(scaled.element)
  check('the size reaches the wrapper as a CSS multiplier', scaledLayer.props.style['--ps-scale'] === '2', JSON.stringify(scaledLayer.props.style))

  // What the settings slider does: store, then broadcast.
  storage.set(SIZE_KEY, '0.75')
  windowStub.dispatchEvent(new FakeEvent(SIZE_EVENT))
  scaled.render()
  scaledLayer = layerOf(scaled.element)
  check('a size broadcast is picked up without a reload', scaledLayer.props.style['--ps-scale'] === '0.75', JSON.stringify(scaledLayer.props.style))

  // Put the mascot somewhere the reset must move it away from, then do exactly
  // what the settings button does: forget the stored spot and broadcast.
  const base = scaledLayer.ref.current
  base.offsetWidth = 400
  base.offsetHeight = 600
  storage.set(POS_KEY, JSON.stringify({ x: 123, y: 55 }))
  clearPos()
  windowStub.dispatchEvent(new FakeEvent(POS_EVENT))
  scaled.render()
  check(
    'an explicit reset forgets the stored spot',
    !storage.has(POS_KEY) && base.style.left !== '123px',
    `${base.style.left} / ${storage.get(POS_KEY)}`
  )
  const fresh = defaultPos({ w: 400, h: 600 })
  check(
    'and lands on the default corner for the current box',
    base.style.left === `${fresh.x}px` && base.style.top === `${fresh.y}px`,
    `${base.style.left} / ${base.style.top} vs ${JSON.stringify(fresh)}`
  )
  scaled.unmount()
  storage.delete(SIZE_KEY)
  storage.delete(POS_KEY)
}

/* ── 9. The master switch flips live, from the settings page ────────────── */
{
  localStorageStub.removeItem(SHOWN_KEY)
  const seat = mkSeat('session-a')
  const gate = renderComponent(MascotGate, { ctx: mkCtx(seat.service), t: IDENTITY, onShown: () => {} })
  check('the gate starts on', gate.element !== null)
  // The settings switch writes the key and broadcasts; the gate is a SEPARATE
  // mount (its own root on screen), so nothing re-renders it but that event.
  storage.set(SHOWN_KEY, '0')
  windowStub.dispatchEvent(new FakeEvent(SHOWN_EVENT))
  gate.render()
  check('flipping the switch off hides the mascot without a reload', gate.element === null)
  storage.set(SHOWN_KEY, '1')
  windowStub.dispatchEvent(new FakeEvent(SHOWN_EVENT))
  gate.render()
  check('flipping it back on brings it back', gate.element !== null)
  gate.unmount()
  localStorageStub.removeItem(SHOWN_KEY)
}

/* ── 10. A live /role switch reaches the mascot WITHOUT re-entering ─────── */
// Sections 10 and 11 wait on the real clock: the thing under test IS a poll
// interval, and the fake timer queue (built for the 5s artwork poll) cannot
// express "fires in 250ms". Each view is unmounted when it is done, so a dead
// mount's own slow poll cannot drift into the next section's observations.
const realSleep = sleep
{
  // The reported bug: `/role amiya` inside a session left the mascot showing the
  // previous role until the user left and re-entered the conversation, because
  // the role was only read when the SEAT changed. A seat does not change when a
  // session is rebound, so the role has to be re-read on its own cycle.
  storage.delete(SHOWN_KEY)
  noRevisionEndpoint()
  resetRequests()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = {
    ok: true,
    roles: [
      { id: 'amiya', name: '阿米娅', mascot: { image: '/persona-switcher/mascot-file/amiya-abc.png', box: '512x768' } },
      { id: 'whale-girl', name: '鲸鱼娘', mascot: { image: '/persona-switcher/mascot-file/whale-def.png', box: '400x600' } }
    ]
  }
  const seat = mkSeat('session-live')
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(seat.service), t: IDENTITY, onShown: () => {} })
  await realPoll('the mascot shows the role the session starts on', () => {
    view.render()
    return imageOf(view.element)?.props?.src?.includes('amiya-abc') === true
  }, 8000)
  check('the starting role is the one on screen', imageOf(view.element).props.src.includes('amiya-abc'))
  const before = countOf('/session')

  // Now the user switches role in the SAME session: only the answer changes,
  // exactly as the host does it (the seat never moves). The replacement is shown
  // by turning a card, so the new art is on screen (as the back face) before the
  // turn commits to it — `paintsSrc` asks the honest question.
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll('a switch is picked up without re-entering the session', () => {
    view.render()
    return paintsSrc(view.element, 'whale-def')
  }, 9000)
  check('the artwork follows the new role', paintsSrc(view.element, 'whale-def'))
  check('the accessible label follows too', String(layerOf(view.element).props['aria-label']).includes('鲸鱼娘'))
  check('picking it up meant asking the host again', countOf('/session') > before, `${before} -> ${countOf('/session')}`)

  // And the other direction: /role none must take it away just as promptly.
  sessionAnswer = { ok: true, roleId: null }
  await realPoll('clearing the role takes the mascot away', () => {
    view.render()
    return hiddenMascot(view.element)
  }, 9000)
  check('nothing keeps showing after /role none', imageOf(view.element) === undefined)
  view.unmount()
}

/* ── 11. The revision counter: what makes a switch look instant ─────────── */
{
  const fastRole = (id, src) => ({ id, name: id, mascot: { image: src, box: '512x768' } })
  storage.delete(SHOWN_KEY)
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = {
    ok: true,
    roles: [fastRole('amiya', '/persona-switcher/mascot-file/a.png'), fastRole('whale-girl', '/persona-switcher/mascot-file/w.png')]
  }

  // (a) A host WITH the counter: a live switch must be picked up within a poll
  // cycle, i.e. almost immediately — NOT after the 1.5s role cycle.
  revisionReads.count = 0
  bumpRevision()
  resetRequests()
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-fast').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the fast mascot mounts', () => {
    view.render()
    return imageOf(view.element)?.props?.src?.includes('/a.png') === true
  }, 8000)
  check('the fast mascot mounts', imageOf(view.element)?.props?.src?.includes('/a.png') === true)
  await realPoll('the revision counter is being polled', () => revisionReads.count > 0, 4000)
  const beforeCount = countOf('/session')
  const startedAt = Date.now()
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  bumpRevision()
  await realPoll('one counter cycle is enough to follow a switch', () => {
    view.render()
    return paintsSrc(view.element, '/w.png')
  }, 4000)
  const took = Date.now() - startedAt
  check('the switch landed on a counter cycle, not a slow role cycle', took < REVISION_SLOW_MS, `${took}ms`)
  check('and it cost one extra role read', countOf('/session') === beforeCount + 1, `${beforeCount} -> ${countOf('/session')}`)
  check('the counter is polled several times a second', revisionReads.count >= 2, String(revisionReads.count))

  // A FAILED artwork read must not end the loop. The loop used to set its next
  // timer after the await, so one 500 stopped it for good and a role whose
  // artwork was imported from the settings page never appeared until the seat
  // changed. The loop must keep trying on the slow cycle.
  rolesShouldFail = true
  const readsBeforeFailure = countOf('/roles')
  await realSleep(700)
  const readsAfterFailure = countOf('/roles')
  rolesShouldFail = false
  await realPoll('the artwork read keeps retrying after a failure', () => countOf('/roles') > readsAfterFailure, 12000)
  check('a failing artwork read still schedules the next attempt', countOf('/roles') > readsAfterFailure, `${readsBeforeFailure} -> ${readsAfterFailure} -> ${countOf('/roles')}`)
  check('the retry is on the slow cycle, not a hot loop', readsAfterFailure - readsBeforeFailure <= 1, `${readsAfterFailure - readsBeforeFailure} extra read(s) in 700ms`)

  // A hidden tab backs off — the mascot is not being looked at — and coming back
  // asks at once, so returning to the window is still instant.
  const hiddenBefore = revisionReads.count
  documentStub.visibilityState = 'hidden'
  await realSleep(700)
  const hiddenGrew = revisionReads.count - hiddenBefore
  check('a hidden tab stops the fast poll', hiddenGrew <= 1, `${hiddenGrew} reads in 700ms`)
  documentStub.visibilityState = 'visible'
  documentStub.dispatchEvent(new FakeEvent('visibilitychange'))
  await realSleep(120)
  check('coming back to the tab asks again immediately', revisionReads.count > hiddenBefore + hiddenGrew, String(revisionReads.count))
  view.unmount()

  // `/role none` on a counter host must clear on the SAME counter cycle. The
  // role effect restarts on a revision bump, and its local "reported" cache used
  // to start at null; a null answer then looked like "no change", leaving the
  // previous artwork on screen until the seat changed.
  sessionAnswer = { ok: true, roleId: 'amiya', liveRoleId: 'amiya' }
  sessionDelayMs = 600
  bumpRevision()
  resetRequests()
  const noneView = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-none').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the none-test mascot shows amiya first', () => {
    noneView.render()
    return imageOf(noneView.element)?.props?.src?.includes('/a.png') === true
  }, 4000)
  sessionAnswer = { ok: true, roleId: null, liveRoleId: null }
  bumpRevision()
  await realPoll('clearing a role clears the mascot on the counter cycle', () => {
    noneView.render()
    return hiddenMascot(noneView.element)
  }, 4000)
  check('a counter-driven /role none does not keep the old artwork', imageOf(noneView.element) === undefined)
  sessionDelayMs = 0

  // The host distinguishes the remembered choice (`roleId`) from the role in
  // force (`liveRoleId`). The mascot draws the latter: a session that inherited
  // the configured default has no memory but does have a live role, and a stale
  // memory must not outvote a live `/role none`.
  sessionAnswer = { ok: true, roleId: null, liveRoleId: 'amiya' }
  bumpRevision()
  await realPoll('a role inherited from the default shows its artwork', () => {
    noneView.render()
    return imageOf(noneView.element)?.props?.src?.includes('/a.png') === true
  }, 4000)
  check('liveRoleId is enough even when roleId is null', imageOf(noneView.element)?.props?.src?.includes('/a.png') === true)
  sessionAnswer = { ok: true, roleId: 'amiya', liveRoleId: null }
  bumpRevision()
  await realPoll('a live none wins over a stale remembered role', () => {
    noneView.render()
    return hiddenMascot(noneView.element)
  }, 4000)
  check('a stale roleId cannot keep artwork after the live role is gone', imageOf(noneView.element) === undefined)
  noneView.unmount()

  // (b) A host WITHOUT the counter (a 404): the mascot must keep working, just
  // on the slow cycle. This is the supported older-host path.
  // The session starts on the amiya role again: part (a) left the shared
  // answer on whale-girl, and this check waits for a.png, so it has to be
  // looking at a session bound to amiya or it waits forever.
  sessionAnswer = { ok: true, roleId: 'amiya' }
  resetRequests()
  const slow = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-slow').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the slow mascot mounts on a host without the counter', () => {
    slow.render()
    return imageOf(slow.element)?.props?.src?.includes('/a.png') === true
  }, 8000)
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll('a switch still arrives without the counter', () => {
    slow.render()
    return paintsSrc(slow.element, '/w.png')
  }, 9000)
  check('the fallback path follows the switch too', paintsSrc(slow.element, '/w.png'))
  slow.unmount()
}

/* ── 12. A host that is not answering must not be hammered ─────────────── */
// The role read used to swallow every failure into `null`, so its backoff branch
// was unreachable: a host that started failing while the fast cadence was live
// was asked for the session four times a second, indefinitely — and because the
// cadence came from a captured `fast`, the slow fallback could not engage either.
//
// The read has to be driven by the counter to land on the fast cycle at all: with
// a 404 on /revision this mascot is on the 1500ms fallback, and "it asked twice
// in two seconds" would be true either way. So the counter is published here and
// bumped, exactly as a live host does, and the assertion only counts once the
// fast cycle has actually been observed.
{
  bumpRevision()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = { ok: true, roles: [{ id: 'amiya', name: 'amiya', mascot: { image: '/persona-switcher/mascot-file/a.png', box: '512x768' } }] }
  resetRequests()
  const view = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-down').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the mascot mounts before the host goes away', () => {
    view.render()
    return imageOf(view.element)?.props?.src?.includes('/a.png') === true
  }, 8000)

  // Drive the counter once, exactly as a `/role` switch does: the role effect
  // re-runs with the fast cadence and keeps asking on its own from there.
  resetRequests()
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  bumpRevision()
  await realPoll('the counter puts the role read on the fast cycle', () => countOf('/session') >= 3, 6000)
  const fastObserved = countOf('/session') >= 3
  sessionAnswer = { ok: true, roleId: 'amiya' }

  hostDown = true
  // "It only asked once" is also what a torn-down loop looks like, so first prove
  // the chain is alive: this one attempt is the failure that triggers the backoff,
  // and it happens immediately.
  const aliveBefore = countOf('/session')
  await realPoll('the role read is still retrying during the outage', () => countOf('/session') > aliveBefore, 2000)
  const stillAlive = countOf('/session') > aliveBefore
  // Measure a fresh window AFTER that first failure. The healthy loop is now on
  // its 8s retry cycle, so it makes no further attempt here; a loop that ignored
  // the failure would still be on the 250ms cycle and make ~10.
  const attemptsBefore = countOf('/session')
  await realSleep(2500)
  const attemptsDuring = countOf('/session') - attemptsBefore
  hostDown = false
  check(
    'a dead host is backed off, not hammered',
    fastObserved && stillAlive && attemptsDuring === 0,
    `fast=${fastObserved}, alive=${stillAlive}, ${attemptsDuring} retr(ies) in the 2500ms after the first failure`
  )

  // And it must recover on its own, without a seat change. The failed read left
  // the loop on the 8s retry cycle, which is inside this timeout.
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  rolesAnswer = { ok: true, roles: [{ id: 'whale-girl', name: 'whale-girl', mascot: { image: '/persona-switcher/mascot-file/w.png', box: '512x768' } }] }
  await realPoll('the mascot resumes once the host answers again', () => {
    view.render()
    return paintsSrc(view.element, '/w.png')
  }, 12000)
  check('the polling recovered by itself', paintsSrc(view.element, '/w.png'))
  view.unmount()
}

/* ── 13. The master switch must react to its own in-window broadcast ───── */
// The settings page flips the switch, stores it and fires a CustomEvent. The
// mascot's listener guarded on `event.key`, which a CustomEvent does not have,
// so the guard passed it through as "a storage event for another key" and the
// in-window switch was ignored until the page was reloaded.
{
  storage.delete(SHOWN_KEY)
  noRevisionEndpoint()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = { ok: true, roles: [{ id: 'amiya', name: 'amiya', mascot: { image: '/persona-switcher/mascot-file/a.png', box: '512x768' } }] }
  resetRequests()
  const view = renderComponent(MascotGate, { ctx: mkCtx(mkSeat('session-switch').service), t: IDENTITY, onShown: () => {} })
  check('the gate is open to start with', view.element !== null)

  // What the settings page does when the user turns the mascot off: write the
  // key, then broadcast. The gate is a SEPARATE mount, so the event is the only
  // thing that can tell it.
  storage.set(SHOWN_KEY, '0')
  windowStub.dispatchEvent(new FakeEvent(SHOWN_EVENT))
  view.render()
  check('a CustomEvent from this window turns it off (no key guard rejects it)', view.element === null)

  storage.set(SHOWN_KEY, '1')
  windowStub.dispatchEvent(new FakeEvent(SHOWN_EVENT))
  view.render()
  check('and the same event turns it back on', view.element !== null)
  view.unmount()
  storage.delete(SHOWN_KEY)
}

/* ── 14. The flip transition: a replacement turns a card, a first show does not ── */
// Detection is already covered above (a switch reaches the mascot fast). This
// section is about the PRESENTATION of that switch: instead of hard-swapping the
// `src`, the old art stays on screen as the FRONT face while the new art turns
// into view as the BACK face, and the turn commits to the new art. A first
// appearance (nothing → art) and an unbind (art → nothing) keep the plain fade;
// only a REPLACEMENT turns.
{
  // The role table for this whole section: BOTH roles, always, exactly as a live
  // app holds them (`/roles` is polled and stays resident). A `/role` switch then
  // moves `art` from one to the other with no frame where the role is unknown —
  // and a turn needs a settled front face to turn FROM.
  const flipRoles = () => ({
    ok: true,
    roles: [
      { id: 'amiya', name: '阿米娅', mascot: { image: '/persona-switcher/mascot-file/a.png', box: '512x768' } },
      { id: 'whale-girl', name: '鲸鱼娘', mascot: { image: '/persona-switcher/mascot-file/w.png', box: '400x600' } }
    ]
  })
  /** The first div whose class list contains `cls`. */
  const divWithClass = (element, cls) =>
    findNodes(element, 'div').find((node) => String(node.props?.className ?? '').split(' ').includes(cls))
  /** All imgs whose class list contains `cls`, in tree order. */
  const imgsWithClass = (element, cls) =>
    findNodes(element, 'img').filter((node) => String(node.props?.className ?? '').split(' ').includes(cls))

  /* 14a. The pure state machine: every branch, no DOM. */
  const amiya = { role: 'amiya', label: '阿米娅', src: '/a.png', width: 512, height: 768 }
  const whale = { role: 'whale-girl', label: '鲸鱼娘', src: '/w.png', width: 400, height: 600 }
  check('a first show settles the target directly (no turn)', (() => {
    const plan = planFlip(amiya, null, false)
    return plan.flip === null && plan.displayed === amiya
  })())
  check('an unbind drops everything (the wrapper fade hides it)', (() => {
    const plan = planFlip(null, amiya, false)
    return plan.flip === null && plan.displayed === null
  })())
  check('the same artwork is adopted without a turn', (() => {
    const plan = planFlip({ ...amiya, label: 'A2' }, amiya, false)
    return plan.flip === null && plan.displayed.label === 'A2'
  })())
  check('reduced motion swaps a replacement in place (turn is dropped)', (() => {
    const plan = planFlip(whale, amiya, true)
    return plan.flip === null && plan.displayed === whale
  })())
  check('a replacement turns: old stays front, new becomes the back', (() => {
    const plan = planFlip(whale, amiya, false)
    return plan.displayed === amiya && plan.flip?.to === whale
  })())

  /* 14b. A first appearance is NOT a turn: one settled image, no card. */
  // Both roles stay in the table for the whole section, exactly as they are in a
  // live app (`/roles` is polled and re-read on every change). A `/role` switch
  // therefore moves `art` amiya→whale with no frame where the role is unknown —
  // which is the only way a turn has something to turn FROM. Loading the target
  // role late would drop through `art === null`, clear the shown art, and settle
  // the replacement directly (a safe degrade, but not the path under test here).
  storage.delete(SHOWN_KEY)
  reducedMotion.matches = false
  noRevisionEndpoint()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = flipRoles()
  resetRequests()
  const first = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-flip').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the first artwork appears', () => {
    first.render()
    return paintsSrc(first.element, '/a.png')
  }, 8000)
  first.render()
  check('a first show renders exactly one settled image', imgsWithClass(first.element, 'ps-mascot__art').length === 1)
  check('and no flip card at all', divWithClass(first.element, 'ps-mascot__card') === undefined)
  check('and the box is not marked flipping', !String(layerOf(first.element).props.className).includes('is-flipping'))

  /* 14c. A replacement turns: two faces, old front, new back, box sized to new. */
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll('the replacement starts a turn', () => {
    first.render()
    return divWithClass(first.element, 'ps-mascot__card') !== undefined
  }, 9000)
  first.render()
  const front = imgsWithClass(first.element, 'ps-mascot__face--front')
  const back = imgsWithClass(first.element, 'ps-mascot__face--back')
  check('the turn shows a front face (the OLD art)', front.length === 1 && front[0].props.src.includes('/a.png'), front[0]?.props?.src)
  check('the turn shows a back face (the NEW art)', back.length === 1 && back[0].props.src.includes('/w.png'), back[0]?.props?.src)
  check('the settled single image is gone during the turn', imgsWithClass(first.element, 'ps-mascot__art').length === 0)
  check('the box carries the flipping marker', String(layerOf(first.element).props.className).includes('is-flipping'))
  check('the box is sized to the INCOMING art (400px, not 512px)', layerOf(first.element).props.style.width === '400px', layerOf(first.element).props.style.width)
  check('the stage is as tall as the incoming art box', divWithClass(first.element, 'ps-mascot__stage')?.props?.style?.height === '600px', divWithClass(first.element, 'ps-mascot__stage')?.props?.style?.height)

  /* 14d. The turn commits on animationend. */
  const card = divWithClass(first.element, 'ps-mascot__card')
  check('the card listens for the turn to end', typeof card?.props?.onAnimationEnd === 'function')
  fire(card, 'onAnimationEnd', { target: card, currentTarget: card })
  first.render()
  check('animationend lands the turn on the new art', imgsWithClass(first.element, 'ps-mascot__art')[0]?.props?.src?.includes('/w.png') === true, imgsWithClass(first.element, 'ps-mascot__art')[0]?.props?.src)
  check('the card is gone after the commit', divWithClass(first.element, 'ps-mascot__card') === undefined)
  check('the box leaves the flipping state', !String(layerOf(first.element).props.className).includes('is-flipping'))

  /* 14e. A turn that loses its animationend still commits (fallback timer). */
  rolesAnswer = flipRoles()
  sessionAnswer = { ok: true, roleId: 'amiya' }
  await realPoll('the reverse turn starts', () => {
    first.render()
    return divWithClass(first.element, 'ps-mascot__card') !== undefined
  }, 9000)
  // Do NOT fire animationend this time. The JS fallback must land the turn on its
  // own, so the mascot can never be stuck mid-turn showing two half-faded faces.
  await realSleep(FLIP_TOTAL_MS + FLIP_COMMIT_MARGIN_MS + 200)
  first.render()
  check('the fallback timer commits the turn without animationend', imgsWithClass(first.element, 'ps-mascot__art')[0]?.props?.src?.includes('/a.png') === true, imgsWithClass(first.element, 'ps-mascot__art')[0]?.props?.src)
  check('and the card is cleaned up', divWithClass(first.element, 'ps-mascot__card') === undefined)
  first.unmount()

  /* 14f. Reduced motion: the same replacement swaps in place, no card. */
  reducedMotion.matches = true
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = flipRoles()
  const reduce = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-reduce').service), t: IDENTITY, onShown: () => {} })
  await realPoll('the reduce-mode mascot shows the first art', () => {
    reduce.render()
    return paintsSrc(reduce.element, '/a.png')
  }, 8000)
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll('a replacement under reduce swaps in place', () => {
    reduce.render()
    return paintsSrc(reduce.element, '/w.png')
  }, 9000)
  reduce.render()
  check('reduce never renders a flip card', divWithClass(reduce.element, 'ps-mascot__card') === undefined)
  check('reduce paints the new art as the single settled image', imgsWithClass(reduce.element, 'ps-mascot__art')[0]?.props?.src?.includes('/w.png') === true)
  check('and the box is never marked flipping', !String(layerOf(reduce.element).props.className).includes('is-flipping'))
  reducedMotion.matches = false
  reduce.unmount()

  /* 14g. The plugin's animation preference overrides the system reading. */
  // The exact machine this feature exists for: the OS reports reduce (a Windows
  // animation switch that is off) but the plugin preference says 'always' — the
  // turn must run. And the mirror: system allows animation, preference says
  // 'never' — the swap must be in place.
  storage.set(MOTION_KEY, 'always')
  reducedMotion.matches = true
  sessionAnswer = { ok: true, roleId: 'amiya' }
  rolesAnswer = flipRoles()
  const forced = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-forced').service), t: IDENTITY, onShown: () => {} })
  await realPoll("'always' mounts the first art under system reduce", () => {
    forced.render()
    return paintsSrc(forced.element, '/a.png')
  }, 8000)
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll("'always' turns even though the system reports reduce", () => {
    forced.render()
    return divWithClass(forced.element, 'ps-mascot__card') !== undefined
  }, 9000)
  forced.render()
  check('the override renders a real two-face card under reduce', imgsWithClass(forced.element, 'ps-mascot__face--back').length === 1)
  forced.unmount()

  storage.set(MOTION_KEY, 'never')
  reducedMotion.matches = false
  sessionAnswer = { ok: true, roleId: 'amiya' }
  const silenced = renderComponent(PersonaMascot, { ctx: mkCtx(mkSeat('session-silenced').service), t: IDENTITY, onShown: () => {} })
  await realPoll("'never' mounts the first art with the system allowing animation", () => {
    silenced.render()
    return paintsSrc(silenced.element, '/a.png')
  }, 8000)
  sessionAnswer = { ok: true, roleId: 'whale-girl' }
  await realPoll("'never' swaps in place even though the system allows animation", () => {
    silenced.render()
    return paintsSrc(silenced.element, '/w.png')
  }, 9000)
  silenced.render()
  check("'never' renders no card where the system allows animation", divWithClass(silenced.element, 'ps-mascot__card') === undefined)
  silenced.unmount()
  storage.delete(MOTION_KEY)
  reducedMotion.matches = false
}

console.log(failures.length === 0 ? `mascot client OK (${passed} checks)` : `mascot client FAILED (${passed} passed)`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)