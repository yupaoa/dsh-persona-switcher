import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadOptions, loadRoleLabel, selectRole } from './role-picker.js'

/** First unused suggestion; the settings editor still lets the user change it. */
export const nextRoleId = (roles) => {
  const used = new Set(roles.map((role) => role.id))
  let n = 1
  while (used.has(`char${String(n).padStart(3, '0')}`)) n += 1
  return `char${String(n).padStart(3, '0')}`
}

/**
 * DSH 0.2.x keeps settings navigation in the sidebar.settings shared store.
 * Its create() returns the shell's existing instance. Never call an exclusive
 * store factory or replace a slot: other plugins own their own entries.
 * Probe at click time so unload/reload cannot leave a stale navigation target.
 */
export const openRoleLibrary = async (slots, card, t) => {
  const entries = slots.entriesOfSlot?.('sidebar.settings') ?? slots.entries?.('sidebar.settings') ?? []
  const store = entries[0]?.store
  const actions = typeof store === 'object' && store !== null ? store.create?.()?.actions : undefined
  if (typeof actions?.openSection !== 'function') throw new Error(t('composerSettingsUnavailable'))
  actions.openSection('persona-switcher')
  card.setTab('library')
  // Preserve an unfinished edit if the user returns from the composer.
  if (card.editing !== null) return
  await card.load()
  if (card.status === 'ready' && card.editing === null) card.edit(null)
}

const STYLE = `
.ps-composer-trigger{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary,#667085);background:transparent;border:0;border-radius:8px;min-height:30px;max-width:min(160px,25vw);overflow:hidden;text-overflow:ellipsis;padding:4px 8px;white-space:nowrap;cursor:pointer;flex:none}
.ps-composer-trigger:hover,.ps-composer-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#eef1f6)}
.ps-composer-trigger:focus-visible,.ps-composer-popup button:focus-visible,.ps-composer-popup input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c78ff);outline-offset:2px}
.ps-composer-popup{position:fixed;z-index:999;box-sizing:border-box;width:min(320px,calc(100vw - 16px));max-height:calc(100vh - 24px);overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l1,#d0d5dd);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#20242c);box-shadow:0 8px 28px #0002;font:13px/1.5 system-ui,sans-serif}
.ps-composer-popup input{box-sizing:border-box;width:100%;font:inherit;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,#d0d5dd);border-radius:7px;background:transparent;color:inherit;margin-bottom:6px}
.ps-composer-popup button{box-sizing:border-box;width:100%;font:inherit;text-align:left;background:transparent;color:inherit;border:0;border-radius:7px;padding:7px 9px;cursor:pointer;overflow-wrap:anywhere}
.ps-composer-popup button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f6)}
.ps-composer-popup button:disabled{opacity:.5;cursor:wait}
.ps-composer-popup small{display:block;color:var(--dsw-alias-label-secondary,#667085)}
.ps-composer-popup .ps-composer-add{border-top:1px solid var(--dsw-alias-border-l1,#d0d5dd);margin-top:6px;border-radius:0}
.ps-composer-popup .ps-composer-error{color:var(--dsw-alias-state-error-primary,#c52b35);overflow-wrap:anywhere}
.ps-composer-popup p{margin:8px}
`

/** One mounted instance per composer session, never a global current-session id. */
export function ComposerPicker({ sessionId, api, t, sessions, openLibrary }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [roleLabel, setRoleLabel] = useState(null)
  const [labelRefresh, setLabelRefresh] = useState(0)
  const [position, setPosition] = useState({ left: 8, bottom: 8 })
  const trigger = useRef(null)
  const popup = useRef(null)
  const searchInput = useRef(null)
  const alive = useRef(false)
  const pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let timer
    let lastRevision
    let lastRead = 0
    const refresh = async (force = false) => {
      if (cancelled || inFlight) return
      clearTimeout(timer)
      inFlight = true
      let delay = 1500
      try {
        if (document.visibilityState === 'hidden') return
        // Changes through /role do not emit a client event. The cheap counter
        // avoids fetching persona prose every tick. Periodic full reads also
        // notice renamed role files and support hosts without /revision.
        const revision = await api('GET', '/revision').then((value) => value?.revision, () => undefined)
        if (force || revision === undefined || revision !== lastRevision || Date.now() - lastRead >= 15000) {
          const label = await loadRoleLabel(sessionId, api)
          if (!cancelled) setRoleLabel(label)
          lastRead = Date.now()
          lastRevision = revision
        }
        if (revision === undefined) delay = 5000
      } catch {
        // Keep the last confirmed label during a transient host failure.
        delay = 5000
      } finally {
        inFlight = false
        if (!cancelled) timer = setTimeout(() => void refresh(), delay)
      }
    }
    const onFocus = () => { void refresh(true) }
    void refresh(true)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [sessionId, api, labelRefresh])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSearch('')
    setError('')
    setStatus('loading')
    loadOptions({ sessionId }, { api, t }).then((options) => {
      if (!cancelled) { setRows(options); setStatus('ready') }
    }, (reason) => {
      if (!cancelled) { setError(String(reason.message ?? reason)); setStatus('error') }
    })
    return () => { cancelled = true }
  }, [open, attempt, sessionId, api, t])

  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 16)
      const below = rect.top < 180
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        ...(below ? { top: rect.bottom + 8, maxHeight: Math.max(80, window.innerHeight - rect.bottom - 16) }
          : { bottom: window.innerHeight - rect.top + 8, maxHeight: rect.top - 16 })
      })
    }
    const outside = (event) => {
      if (!popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    place()
    searchInput.current?.focus()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const run = async (action, restoreFocus = true) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      if (alive.current) {
        setOpen(false)
        if (restoreFocus) trigger.current?.focus()
      }
    } catch (reason) {
      if (alive.current) setError(String(reason.message ?? reason))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const query = search.trim().toLocaleLowerCase()
  const filtered = rows.filter((row) => `${row.label} ${row.detail}`.toLocaleLowerCase().includes(query))
  const moveFocus = (event) => {
    // Portal events still bubble through the composer React tree. Keep search
    // typing and Enter away from the host's draft/submission shortcuts.
    event.stopPropagation()
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return
    if (event.target === searchInput.current && ['Home', 'End'].includes(event.key)) return
    const controls = [...popup.current.querySelectorAll('input,button:not(:disabled)')]
    const current = controls.indexOf(document.activeElement)
    let next = current + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = controls.length - 1
    event.preventDefault()
    controls[(next + controls.length) % controls.length]?.focus()
  }
  return <>
    <button type="button" className="ps-composer-trigger" ref={trigger} aria-haspopup="dialog"
      title={roleLabel ?? t('composerPersona')} aria-expanded={open}
      onClick={() => setOpen(!open)}>{roleLabel ?? t('composerPersona')}</button>
    {open && createPortal(<div className="ps-composer-popup" ref={popup} style={position}
      role="dialog" aria-label={t('composerPersona')} onKeyDown={moveFocus}>
      <input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)}
        placeholder={t('rolePickSearch')} aria-label={t('rolePickSearch')} />
      {status === 'loading' && <p role="status">{t('loading')}</p>}
      {error && <p className="ps-composer-error" role="alert">{error}</p>}
      {status === 'error' && <button type="button" onClick={() => setAttempt(attempt + 1)}>{t('composerRetry')}</button>}
      {status === 'ready' && <>
        {filtered.map((row) => <button type="button" key={row.id} disabled={busy}
          aria-pressed={row.active} onClick={() => run(async () => {
            await selectRole(row, { sessionId }, { sessions })
            if (alive.current) setLabelRefresh((value) => value + 1)
          })}>
          {row.active ? '✓ ' : ''}{row.label}<small>{row.detail}</small>
        </button>)}
        {rows.length === 1 && <p>{t('rolePickEmpty')}</p>}
        {filtered.length === 0 && <p>{t('rolePickNoMatch')}</p>}
      </>}
      <button type="button" className="ps-composer-add" disabled={busy}
        onClick={() => run(openLibrary, false)}>＋ {t('composerAdd')}</button>
    </div>, document.body)}
  </>
}

export const installComposerPicker = (ctx, { api, t, card }) => {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => style.parentNode?.removeChild(style)
  }, 'persona-switcher: composer style')
  ctx.inject(['sessions', 'slots'], (scope) => {
    const sessions = scope.get('sessions')
    const slots = scope.get('slots')
    slots.inject('conversation.input.left', () => slots.register({
      name: 'conversation.input.left',
      id: 'persona-switcher-picker',
      order: 10, // dsh-meme is order 5; permission precedes this list, model follows it.
      label: () => t('composerPersona'),
      inject: (sessionId) => ({ sessionId })
    }, ({ sessionId }) => <ComposerPicker key={sessionId} sessionId={sessionId} api={api} t={t}
      sessions={sessions} openLibrary={() => openRoleLibrary(slots, card, t)} />))
  })
}
