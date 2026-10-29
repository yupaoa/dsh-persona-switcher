// Isolated browser fixture: real shipped plugin bundle + React; no live DSH data.
import React, { useSyncExternalStore } from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as JSXRuntime from 'react/jsx-runtime'
import * as modelPrimitives from '../simulate-primitives.mjs'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { nextRoleId, openRoleLibrary } from '../../src/client/composer-picker.jsx'

const h = React.createElement
const entries = new Map()
const core = new SlotCore()
core.register({ name: 'root', children: {
  'sidebar.settings': { kind: 'single', scope: 'root' },
  'conversation.input.left': { kind: 'list', scope: 'session' }
} }, () => null)
core.register({ name: 'conversation.input.left', id: 'meme-picker', order: 5 }, () => null)
const disposers = []
const dictionaries = {}
const fixtures = window.fixtures = {
  roles: [
    { id: 'char001', name: '小鲸', description: '温柔助手', persona: 'Gentle assistant' },
    { id: 'char003', name: '', description: 'No display name', persona: 'Another assistant' }
  ],
  live: { a: 'char001', b: null },
  commands: [],
  revision: 0,
  failSession: false,
  fail: false,
  slow: 0,
  rejected: false,
  session: 'a',
  settingsId: null
}
window.fetch = async (url, init) => {
  if (fixtures.slow) await new Promise((resolve) => setTimeout(resolve, fixtures.slow))
  const path = new URL(url, location.href)
  let payload
  if (path.pathname.endsWith('/roles')) {
    if (fixtures.fail) return { ok: false, status: 503, json: async () => ({ error: 'Library offline' }) }
    payload = { roles: fixtures.roles }
  } else if (path.pathname.endsWith('/session')) {
    if (fixtures.failSession) return { ok: false, status: 503, json: async () => ({ error: 'Session offline' }) }
    payload = { liveRoleId: fixtures.live[path.searchParams.get('session')], roleId: 'char001' }
  } else if (path.pathname.endsWith('/revision')) {
    payload = { revision: fixtures.revision }
  } else if (path.pathname.endsWith('/role') && init?.method === 'GET') {
    payload = { role: fixtures.roles.find((role) => role.id === path.searchParams.get('id')) }
  } else if (path.pathname.endsWith('/role') && init?.method === 'POST') {
    const role = JSON.parse(init.body)
    fixtures.roles.push(role)
    payload = { role }
  } else payload = {}
  return { ok: true, status: 200, json: async () => payload }
}
const sessions = {
  binding: (sessionId) => ({ session: { command: async (line) => {
    fixtures.commands.push({ sessionId, line })
    if (fixtures.rejected) return { ok: false, error: { message: 'Session unavailable' } }
    fixtures.live[sessionId] = line === '/role none' ? null : line.slice(6)
    fixtures.revision += 1
    return { ok: true, value: { matched: true } }
  } } })
}
const configScope = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
  subscribe: () => () => {}
}
const settingsRoot = ReactDOMClient.createRoot(document.querySelector('#settings'))
function SettingsView() {
  const entry = entries.get('settings.section')
  const injected = entry.options.inject()
  return h(entry.Component, {
    ...injected,
    useSnapshot: (select) => select(useSyncExternalStore(injected.hooks.snapshot.subscribe, injected.hooks.snapshot.getSnapshot))
  })
}
const actions = { openSection: (id) => {
  fixtures.settingsId = id
  document.querySelector('#settings').hidden = false
  settingsRoot.render(h(SettingsView))
} }
const shellInstance = { actions }
core.register({ name: 'sidebar.settings', store: { create: () => shellInstance }, children: {
  'settings.section': { kind: 'list', scope: 'root' }
} }, () => null)
const slots = {
  entriesOfSlot: (name) => core.entriesOfSlot(name),
  inject: (_, register) => register(),
  register: (options, Component) => {
    const dispose = core.register(options, Component)
    disposers.push(dispose)
    entries.set(options.name, { options, Component })
    return dispose
  }
}
const ctx = {
  locale: {
    register: (_, dict) => { Object.assign(dictionaries, dict.zh); return () => {} },
    bind: () => (key) => dictionaries[key] ?? key
  },
  effect: (run) => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) },
  configForms: { get: () => configScope },
  slots,
  inject: (names, run) => {
    const services = { sessions, slots, commandUi: { decorate: () => () => {} } }
    if (names.every((name) => services[name])) run({ get: (key) => services[key], effect: ctx.effect })
  },
  get: () => undefined
}
const primitives = {
  ...modelPrimitives,
  Button: ({ children, size, variant, ...props }) => h('button', props, children),
  SettingsForm: ({ children }) => h('div', null, children),
  SettingsValueField: () => null,
  Switch: () => null
}
window.__ModuleLoader__ = { load: ({ factory }) => {
  const deps = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
    'react/jsx-runtime': JSXRuntime, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const plugin = factory((id) => deps[id])
  plugin.apply(ctx)
} }
const root = ReactDOMClient.createRoot(document.querySelector('#persona'))
fixtures.render = (sessionId) => {
  fixtures.session = sessionId
  const entry = entries.get('conversation.input.left')
  root.render(h(entry.Component, entry.options.inject(sessionId)))
}
fixtures.dispose = () => { root.unmount(); settingsRoot.unmount(); disposers.reverse().forEach((dispose) => dispose()) }
fixtures.slotIds = () => core.entriesOfSlot('conversation.input.left').map((entry) => entry.options.id)
fixtures.nextRoleId = nextRoleId
fixtures.unavailableSettings = () => openRoleLibrary({}, {}, (key) => key).catch((e) => e.message)
