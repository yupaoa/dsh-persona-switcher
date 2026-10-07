import {
  Button,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  settingsTextField
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The persona switcher's settings page, browser half: the role library over
 * the `persona-switcher` namespace the Host serves. The page registers into
 * the Settings page's `settings.section` slot while the Host serves that
 * namespace, so a deployment that exposes no persona-switcher settings shows
 * no trace of it.
 *
 * Layout follows the host's design language (segmented tabs, token-driven
 * cards, label-left/control-right rows — the same vocabulary the wallpaper
 * engine page uses): structure and styles live in this file, colors resolve
 * through the `--dsw-alias-*` theme tokens with local fallbacks, so the page
 * follows light/dark automatically. Only primitives proven in this host
 * (Button/SettingsForm/SettingsValueField/Switch) are used; the tab bar and
 * cards are hand-rolled to avoid depending on newer primitive exports.
 */

/** Dictionary namespace owned by this plugin. */
const NS = 'persona-switcher'
/** Settings entry this page edits; matches the Host-side row id. */
const CONFIG_KEY = 'persona-switcher'
/** URL prefix of the role library API. */
const API_BASE = '/persona-switcher'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/** A role row as the role library reports it. */
const emptyRole = () => ({ id: '', name: '', description: '', persona: '' })

/** Role ids: lowercase letters, digits, hyphens (leading alnum). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/**
 * Call the role library API.
 * @param method - the HTTP method.
 * @param path - the endpoint path (without the base prefix).
 * @param body - optional JSON body.
 * @returns the parsed JSON response.
 */
const api = async (method, path, body) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
  return payload
}

/**
 * The persona switcher's settings page controller (one per settings surface):
 * the role library over the loopback API plus the volatile `exposeTool` toggle.
 * The `defaultRole` field itself is edited through the form the scope carries.
 */
class PersonaSwitcherCardController {
  scope
  t
  form
  /** The section's snapshot store, rebuilt by the form on every publish. */
  store
  /** Role library state, projected into the store snapshot. */
  status = 'loading'
  error = null
  roles = []
  editing = null
  /** `true` while the editor stages a brand-new role (id still editable). */
  editingNew = false
  busy = false
  /** Which tab of the page is showing: `general` | `library`. */
  tab = 'general'
  /** Role id waiting for a delete confirmation, or `null`. */
  confirming = null
  /** Latest load wins; an older response never overwrites a newer one. */
  generation = 0

  /**
   * @param scope - the shared configuration form for this card's namespace.
   * @param t - the bound dictionary.
   */
  constructor(scope, t) {
    this.scope = scope
    this.t = t
    this.form = new SettingsFormModel(scope, [settingsTextField('defaultRole')])
    this.store = this.form.bind(() => this.projection())
    void this.load()
  }

  /** Build the section's state from the form's field reads and the library. */
  projection() {
    return {
      ...this.form.shell(),
      defaultRole: this.form.field('defaultRole'),
      exposeTool: this.scope.getSnapshot().value?.exposeTool ?? true,
      status: this.status,
      error: this.error,
      roles: this.roles,
      editing: this.editing === null ? null : { ...this.editing },
      editingNew: this.editingNew,
      busy: this.busy,
      tab: this.tab,
      confirming: this.confirming
    }
  }

  /** Switch the visible page tab and drop any pending delete confirmation. */
  setTab(tab) {
    if (tab !== 'general' && tab !== 'library') return
    this.tab = tab
    this.confirming = null
    this.form.publish()
  }

  /** Ask the row for a delete confirmation before `remove` runs. */
  setConfirming(id) {
    this.confirming = id
    this.form.publish()
  }

  /** Back out of a pending delete confirmation. */
  cancelConfirm() {
    this.confirming = null
    this.form.publish()
  }

  /** Update one staged editor field and republish the section snapshot. */
  patchEditing(field, value) {
    if (this.editing === null) return
    this.editing = { ...this.editing, [field]: value }
    this.form.publish()
  }

  /**
   * Refresh the role library. A failed refresh keeps the last good rows and
   * surfaces the error text.
   */
  async load() {
    const generation = ++this.generation
    this.status = 'loading'
    this.error = null
    this.confirming = null
    this.form.publish()
    try {
      const payload = await api('GET', '/roles')
      if (generation !== this.generation) return
      this.status = 'ready'
      this.roles = payload.roles ?? []
    } catch (error) {
      if (generation !== this.generation) return
      this.status = 'error'
      this.error = error.message
    }
    this.form.publish()
  }

  /** Begin editing a role; `null` prepares a new-role row. */
  edit(role) {
    this.editing = role === null ? emptyRole() : { ...role }
    this.editingNew = role === null
    this.tab = 'library'
    this.confirming = null
    this.form.publish()
  }

  /** Drop the editor without writing. */
  cancelEdit() {
    this.editing = null
    this.editingNew = false
    this.form.publish()
  }

  /** Write the staged editor row through the role library. */
  async commitEdit() {
    if (this.editing === null) return
    this.busy = true
    this.error = null
    this.form.publish()
    try {
      await api('POST', '/role', this.editing)
      this.editing = null
      this.editingNew = false
      await this.load()
    } catch (error) {
      this.error = error.message
      this.form.publish()
    } finally {
      this.busy = false
      this.form.publish()
    }
  }

  /** Delete a role through the role library. */
  async remove(role) {
    this.busy = true
    this.error = null
    this.confirming = null
    this.form.publish()
    try {
      await api('DELETE', `/role?id=${encodeURIComponent(role.id)}`)
      await this.load()
    } catch (error) {
      this.error = error.message
      this.form.publish()
    } finally {
      this.busy = false
      this.form.publish()
    }
  }

  /** Toggle the role_probe tool exposure through the volatile settings field. */
  async setExposeTool(value) {
    this.busy = true
    this.error = null
    this.form.publish()
    try {
      await this.scope.set('exposeTool', value)
    } catch (error) {
      this.error = error.message
      this.form.publish()
    } finally {
      this.busy = false
      this.form.publish()
    }
  }

  /**
   * Build the face the section's slot registration injects.
   * @returns the snapshot hook, the form actions, and the shared controller.
   */
  inject() {
    return {
      controller: this,
      hooks: { snapshot: this.store },
      t: this.t,
      ...this.form.actions()
    }
  }

  /** Release subscriptions and queued writes. */
  dispose() {
    this.generation += 1
    return this.form.dispose()
  }
}

/** Labels the SettingsForm chrome needs. */
const formLabels = (t) => ({
  unavailable: t('unavailable'),
  readOnly: t('readOnly'),
  saveFailed: t('saveFailed'),
  save: t('save'),
  saving: t('saving')
})

/** Leading glyph of the role's avatar chip. */
const initialOf = (role) => {
  const source = String(role.name || role.id || '').trim()
  return source.length === 0 ? '?' : source[0].toUpperCase()
}

/* ── Page styles ──────────────────────────────────────────────────────────
 * Injected once into <head>; every color resolves through the host's
 * `--dsw-alias-*` theme tokens first, with local fallbacks, so the page
 * tracks light/dark themes. Class names are `ps-` prefixed: no global rules,
 * only descendants of the page root plus two host-chrome tweaks scoped to
 * this page (`.ps-form` footer, danger buttons inside `.ps-card`).
 */
const STYLE_ID = 'persona-switcher-settings-style'
const STYLE_TEXT = `
.dsh-panel.ps-page {
  --ps-surface: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.10));
  --ps-surface-2: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16));
  --ps-raised: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.16));
  --ps-base: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.16));
  --ps-border: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.26));
  --ps-border-soft: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.16));
  --ps-ink: var(--dsw-alias-label-primary, inherit);
  --ps-ink-2: var(--dsw-alias-label-secondary, rgba(128, 128, 128, 0.92));
  --ps-ink-3: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.72));
  --ps-accent: var(--dsw-alias-brand-primary, #3b82f6);
  --ps-hover: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  --ps-danger: #e5484d;
  --ps-radius: 14px;
  --ps-radius-sm: 9px;
  --ps-ease: cubic-bezier(0.16, 1, 0.3, 1);

  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  color: var(--ps-ink);
  font-family: var(--dsw-font-family, inherit);
}

/* ── Header: title + role count, one-liner left, scope meta right ── */
.dsh-panel.ps-page .ps-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.dsh-panel.ps-page .ps-head__titlerow {
  display: flex;
  align-items: center;
  gap: 9px;
}
.dsh-panel.ps-page .ps-head__title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--ps-ink);
}
.dsh-panel.ps-page .ps-head__count {
  min-width: 24px;
  height: 21px;
  padding: 0 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ps-ink-2);
  background: var(--ps-surface-2);
  border: 1px solid var(--ps-border-soft);
}
.dsh-panel.ps-page .ps-head__sub {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ps-ink-3);
}
.dsh-panel.ps-page .ps-head__meta {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  text-align: right;
  color: var(--ps-ink-3);
}

/* ── Segmented tab bar with a sliding pill ── */
.dsh-panel.ps-page .ps-tabs {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 11px;
  background: var(--ps-surface);
  border: 1px solid var(--ps-border);
  overflow: hidden;
}
.dsh-panel.ps-page .ps-tabs__pill {
  position: absolute;
  top: 3px;
  left: 3px;
  bottom: 3px;
  width: calc((100% - 6px) / 2);
  border-radius: 8px;
  background: var(--ps-raised);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.10);
  transition: transform 220ms var(--ps-ease);
  will-change: transform;
}
.dsh-panel.ps-page .ps-tabs__pill.is-second {
  transform: translateX(100%);
}
.dsh-panel.ps-page .ps-tab {
  position: relative;
  z-index: 1;
  height: 30px;
  border: 0;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  color: var(--ps-ink-3);
  transition: color 140ms var(--ps-ease);
}
.dsh-panel.ps-page .ps-tab:hover {
  color: var(--ps-ink);
}
.dsh-panel.ps-page .ps-tab[aria-selected='true'] {
  color: var(--ps-ink);
  font-weight: 650;
}
.dsh-panel.ps-page .ps-tab:focus-visible {
  outline: 2px solid var(--ps-accent);
  outline-offset: -2px;
}

/* ── Panels: fade + settle on tab switch ── */
.dsh-panel.ps-page .ps-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: ps-panel-in 180ms var(--ps-ease);
}
@keyframes ps-panel-in {
  from { opacity: 0; transform: translateY(4px); }
}

/* ── Cards ── */
.dsh-panel.ps-page .ps-card {
  background: var(--ps-surface);
  border: 1px solid var(--ps-border);
  border-radius: var(--ps-radius);
  overflow: hidden;
}
.dsh-panel.ps-page .ps-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px 0;
}
.dsh-panel.ps-page .ps-card__head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--ps-ink);
}
.dsh-panel.ps-page .ps-card__head p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ps-ink-3);
}
.dsh-panel.ps-page .ps-card__body {
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
}
.dsh-panel.ps-page .ps-card__body--flush {
  padding: 6px 8px 8px;
}
.dsh-panel.ps-page .ps-card__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 16px;
}

/* ── Label-left / control-right rows ── */
.dsh-panel.ps-page .ps-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 36px;
  padding: 5px 0;
}
.dsh-panel.ps-page .ps-row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-panel.ps-page .ps-row__label {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--ps-ink);
}
.dsh-panel.ps-page .ps-row__hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ps-ink-3);
}

/* ── Role rows ── */
.dsh-panel.ps-page .ps-role {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 10px;
  transition: background-color 140ms var(--ps-ease);
}
.dsh-panel.ps-page .ps-role:hover {
  background: var(--ps-hover);
}
.dsh-panel.ps-page .ps-role + .ps-role {
  border-top: 1px solid var(--ps-border-soft);
}
.dsh-panel.ps-page .ps-role__avatar {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14.5px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  background: linear-gradient(135deg, var(--ps-accent), #7c5cff);
  user-select: none;
}
.dsh-panel.ps-page .ps-role__text {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-panel.ps-page .ps-role__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ps-ink);
}
.dsh-panel.ps-page .ps-role__name > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-panel.ps-page .ps-role__id {
  flex: 0 0 auto;
  font-family: var(--dsl-terminal-font, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--ps-ink-3);
  background: var(--ps-surface-2);
  border: 1px solid var(--ps-border-soft);
  padding: 1px 6px;
  border-radius: 6px;
}
.dsh-panel.ps-page .ps-role__desc {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ps-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-panel.ps-page .ps-role__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-panel.ps-page .ps-confirm {
  font-size: 12px;
  color: var(--ps-danger);
}
/* Danger affordance for delete buttons, scoped so the host ghost style wins
   only where we ask for it (two classes beat the module's single class). */
.dsh-panel.ps-page .ps-card .ps-danger-btn {
  color: var(--ps-danger);
}
.dsh-panel.ps-page .ps-card .ps-danger-btn:hover:not(:disabled) {
  background: rgba(229, 72, 77, 0.14);
}

/* ── Empty & loading states ── */
.dsh-panel.ps-page .ps-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 34px 16px 30px;
  text-align: center;
}
.dsh-panel.ps-page .ps-empty__icon {
  width: 46px;
  height: 46px;
  border-radius: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ps-accent);
  background: var(--ps-surface-2);
  border: 1px solid var(--ps-border-soft);
}
.dsh-panel.ps-page .ps-empty__title {
  margin: 6px 0 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ps-ink-2);
}
.dsh-panel.ps-page .ps-empty__hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ps-ink-3);
}
.dsh-panel.ps-page .ps-skel-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-panel.ps-page .ps-skel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
}
.dsh-panel.ps-page .ps-skel__avatar {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: var(--ps-surface-2);
}
.dsh-panel.ps-page .ps-skel__lines {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.dsh-panel.ps-page .ps-skel__lines i {
  display: block;
  height: 11px;
  border-radius: 7px;
  background: var(--ps-surface-2);
}
.dsh-panel.ps-page .ps-skel__lines i:first-child { width: 34%; }
.dsh-panel.ps-page .ps-skel__lines i:last-child { width: 58%; }
.dsh-panel.ps-page .ps-skel,
.dsh-panel.ps-page .ps-skel__avatar,
.dsh-panel.ps-page .ps-skel__lines i {
  position: relative;
  overflow: hidden;
}
.dsh-panel.ps-page .ps-skel::after,
.dsh-panel.ps-page .ps-skel__avatar::after,
.dsh-panel.ps-page .ps-skel__lines i::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.14), transparent);
  animation: ps-shimmer 1.5s infinite;
}
@keyframes ps-shimmer {
  100% { transform: translateX(100%); }
}
.dsh-panel.ps-page .ps-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── Error banner ── */
.dsh-panel.ps-page .ps-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 8px;
  padding: 8px 12px;
  border-radius: var(--ps-radius-sm);
  font-size: 12.5px;
  line-height: 1.5;
  color: #ff8589;
  background: rgba(229, 72, 77, 0.12);
  border: 1px solid rgba(229, 72, 77, 0.36);
}

/* ── Editor fields ── */
.dsh-panel.ps-page .ps-fields {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.dsh-panel.ps-page .ps-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
}
.dsh-panel.ps-page .ps-field__label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ps-ink-2);
}
.dsh-panel.ps-page .ps-input,
.dsh-panel.ps-page .ps-textarea {
  width: 100%;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ps-ink);
  background: var(--ps-base);
  border: 1px solid var(--ps-border);
  border-radius: var(--ps-radius-sm);
  padding: 7px 10px;
  outline: none;
  transition: border-color 140ms var(--ps-ease), box-shadow 140ms var(--ps-ease);
}
.dsh-panel.ps-page .ps-textarea {
  min-height: 150px;
  resize: vertical;
  line-height: 1.6;
}
.dsh-panel.ps-page .ps-input:focus,
.dsh-panel.ps-page .ps-textarea:focus {
  border-color: var(--ps-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ps-accent) 24%, transparent);
}
.dsh-panel.ps-page .ps-input:disabled,
.dsh-panel.ps-page .ps-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dsh-panel.ps-page .ps-input.is-invalid,
.dsh-panel.ps-page .ps-textarea.is-invalid {
  border-color: var(--ps-danger);
}
.dsh-panel.ps-page .ps-field__hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ps-ink-3);
}
.dsh-panel.ps-page .ps-field__hint.is-error {
  color: var(--ps-danger);
}

/* ── Host chrome we adopt: the form's save footer sits at the card bottom,
   right-aligned; the failed note stays left. ── */
.dsh-panel.ps-page .ps-form > div > div:last-child {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ps-border-soft);
}
.dsh-panel.ps-page .ps-form > div > div:last-child > p {
  margin: 0 auto 0 0;
  font-size: 12px;
  color: var(--ps-danger);
}

@media (prefers-reduced-motion: reduce) {
  .dsh-panel.ps-page .ps-panel { animation: none; }
  .dsh-panel.ps-page .ps-tabs__pill { transition: none; }
  .dsh-panel.ps-page .ps-skel::after,
  .dsh-panel.ps-page .ps-skel__avatar::after,
  .dsh-panel.ps-page .ps-skel__lines i::after { animation: none; }
}
`

/**
 * Install the page stylesheet once. Guarded for the simulation harness (no
 * DOM) and idempotent across bundle re-execution; the rules are static, so
 * there is nothing to uninstall on dispose.
 */
const installStyle = () => {
  if (typeof document === 'undefined' || document.head === null) return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
}

/* ── Settings-nav icon ────────────────────────────────────────────────────
 * The shell's settings nav hard-codes `navIcon(id)` and hands unknown
 * sections the fallback gear (persona-switcher collides with 通用设置), so,
 * like the wallpaper engine does, the icon is patched into the DOM: find the
 * nav button whose label text equals ours, then swap its first element child
 * for a span carrying the same class (inheriting the shell's layout) and our
 * SVG. Geometry is one table; the string renderer walks it.
 *
 * Design: a theater mask (flat top, U chin, two dot eyes, a smile) on the
 * 16px grid — the plugin's own face, unique in a sidebar of glyphs. Stroke
 * 1.4 matches the official OutlineMedium weight at 16px (thinner reads
 * weak, fatter reads blurry).
 *
 * Failure semantics: structure changed / button not found ⇒ keep the official
 * gear; never throw, never retry. Returns a disposer, or null when not armed.
 */
const PS_ICON_VIEWBOX = '0 0 16 16'
const PS_ICON_PARTS = [
  ['path', { d: 'M3.4 6.2V4.8a1.7 1.7 0 0 1 1.7-1.7h5.8a1.7 1.7 0 0 1 1.7 1.7v1.4c0 4-2.15 7.2-4.6 7.2S3.4 10.2 3.4 6.2Z' }],
  ['circle', { cx: '6.15', cy: '7.35', r: '0.75', fill: 'currentColor', stroke: 'none' }],
  ['circle', { cx: '9.85', cy: '7.35', r: '0.75', fill: 'currentColor', stroke: 'none' }],
  ['path', { d: 'M6.2 10.1q1.8 1.6 3.6 0' }]
]

/** String version of the icon, for the DOM patch's innerHTML. */
const psIconSvgString = (size) => {
  const attrs =
    `viewBox="${PS_ICON_VIEWBOX}" width="${size}" height="${size}" fill="none" stroke="currentColor"` +
    ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
  const inner = PS_ICON_PARTS.map(
    ([tag, props]) =>
      `<${tag} ${Object.keys(props)
        .map((key) => `${key}="${props[key]}"`)
        .join(' ')}/>`
  ).join('')
  return `<svg ${attrs}>${inner}</svg>`
}

/**
 * Patch our icon into the settings nav. The nav is a body portal, so a
 * childList observer on `document.body` sees it mount; the WeakSet keeps the
 * pass idempotent, and the `data-ps-nav-icon` marker survives React
 * re-renders that keep the button node.
 * @param t - the bound dictionary (label read fresh, so it tracks locale).
 * @returns the disposer, or null when the DOM is unavailable.
 */
const installPersonaNavIcon = (t) => {
  if (typeof document === 'undefined' || document.body === null) return null
  if (typeof MutationObserver !== 'function') return null
  const patched = new WeakSet()
  const patchIn = (root) => {
    if (!root || typeof root.querySelectorAll !== 'function') return
    let buttons = []
    try {
      buttons = root.querySelectorAll('nav button')
    } catch {
      return
    }
    const want = t('nav')
    for (const btn of buttons) {
      try {
        if (patched.has(btn)) continue
        if ((btn.textContent || '').trim() !== want) continue
        const iconEl = btn.firstElementChild
        // Unexpected structure (no separate icon element) ⇒ keep the gear.
        if (!iconEl || (iconEl === btn.lastElementChild && btn.childElementCount < 2)) continue
        // Already ours (re-run after a re-render) ⇒ register, don't restack.
        if (iconEl.getAttribute('data-ps-nav-icon') === '1') {
          patched.add(btn)
          continue
        }
        // Copy the live class of THAT element (hash names drift per build)
        // so the span inherits the shell's size/flex constraints. SVG
        // elements expose className as SVGAnimatedString — read `class`.
        const rawClass = iconEl.className
        const span = document.createElement('span')
        span.className =
          typeof rawClass === 'string' ? rawClass : iconEl.getAttribute('class') || ''
        span.setAttribute('data-ps-nav-icon', '1')
        span.innerHTML = psIconSvgString(16)
        btn.replaceChild(span, iconEl)
        patched.add(btn)
      } catch {
        // One odd button must not affect the others.
      }
    }
  }
  // Dialog may already be open (bundle re-execution): patch the current DOM.
  patchIn(document.body)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node && node.nodeType === 1) patchIn(node)
      }
    }
  })
  try {
    observer.observe(document.body, { childList: true })
  } catch {
    return null
  }
  return () => {
    try {
      observer.disconnect()
    } catch {
      /* ignore */
    }
  }
}

/**
 * The settings page section: a header, a two-tab switch, and either the
 * general preferences or the role library with its editor.
 * @param props - the slot-delivered injected dependencies.
 * @returns the section element.
 */
const PersonaSwitcherSection = (props) => {
  const { controller, t, useSnapshot } = props
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot((value) => value)
  const { roles, editing, busy, error, exposeTool, tab, confirming, status, editingNew } = state

  const onEditField = (field) => (event) => controller.patchEditing(field, event.target.value)

  const tabs = [
    { value: 'general', id: 'ps-tab-general', panel: 'ps-panel-general', label: t('tabGeneral') },
    { value: 'library', id: 'ps-tab-library', panel: 'ps-panel-library', label: t('tabLibrary') }
  ]

  const onTabKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = tab === 'general' ? 'library' : 'general'
    controller.setTab(next)
    document.getElementById(next === 'general' ? 'ps-tab-general' : 'ps-tab-library')?.focus()
  }

  const idText = editing === null ? '' : editing.id
  const idInvalid = editingNew && !ID_PATTERN.test(idText)
  const nameInvalid = editing === null || editing.name.trim() === ''

  const roleLibrary = (
    <section className="ps-card">
      <div className="ps-card__head">
        <div>
          <h3>{t('library')}</h3>
          <p>{t('libraryHint')}</p>
        </div>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => controller.edit(null)}>
          {t('add')}
        </Button>
      </div>
      <div className="ps-card__body ps-card__body--flush">
        {error !== null && (
          <p className="ps-error" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </p>
        )}
        {status === 'loading' && roles.length === 0 && (
          <>
            <div className="ps-skel-list" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <div className="ps-skel" key={row}>
                  <span className="ps-skel__avatar" />
                  <span className="ps-skel__lines">
                    <i />
                    <i />
                  </span>
                </div>
              ))}
            </div>
            <span className="ps-sr" role="status">
              {t('loading')}
            </span>
          </>
        )}
        {roles.map((role) => (
          <div className="ps-role" key={role.id}>
            <span className="ps-role__avatar" aria-hidden="true">
              {initialOf(role)}
            </span>
            <div className="ps-role__text">
              <div className="ps-role__name">
                <span>{role.name}</span>
                <code className="ps-role__id">{role.id}</code>
              </div>
              {role.description ? <div className="ps-role__desc">{role.description}</div> : null}
            </div>
            {confirming === role.id ? (
              <div className="ps-role__actions">
                <span className="ps-confirm">{t('confirmDelete')}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ps-danger-btn"
                  disabled={busy}
                  onClick={() => controller.remove(role)}
                >
                  {t('delete')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => controller.cancelConfirm()}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <div className="ps-role__actions">
                <Button size="sm" disabled={busy} onClick={() => controller.edit(role)}>
                  {t('edit')}
                </Button>
                <Button
                  size="sm"
                  className="ps-danger-btn"
                  disabled={busy}
                  onClick={() => controller.setConfirming(role.id)}
                >
                  {t('delete')}
                </Button>
              </div>
            )}
          </div>
        ))}
        {status === 'ready' && roles.length === 0 && (
          <div className="ps-empty">
            <span className="ps-empty__icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z"
                  fill="currentColor"
                />
                <path d="M18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z" fill="currentColor" opacity="0.65" />
              </svg>
            </span>
            <p className="ps-empty__title">{t('rolesEmpty')}</p>
            <p className="ps-empty__hint">{t('rolesEmptyHint')}</p>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => controller.edit(null)}>
              {t('add')}
            </Button>
          </div>
        )}
      </div>
    </section>
  )

  const editor =
    editing === null ? null : (
      <section className="ps-card">
        <div className="ps-card__head">
          <div>
            <h3>{editingNew ? t('addTitle') : t('editTitle')}</h3>
            <p>{t('editorHint')}</p>
          </div>
        </div>
        <div className="ps-card__body">
          {error !== null && (
            <p className="ps-error" role="alert">
              <span aria-hidden="true">⚠</span>
              <span>{error}</span>
            </p>
          )}
          <div className="ps-fields">
            <label className="ps-field">
              <span className="ps-field__label">{t('fieldId')}</span>
              <input
                className={idInvalid ? 'ps-input is-invalid' : 'ps-input'}
                value={editing.id}
                disabled={!editingNew || busy}
                placeholder="whale-girl"
                onChange={onEditField('id')}
              />
              <span className={idInvalid ? 'ps-field__hint is-error' : 'ps-field__hint'}>
                {idInvalid && editing.id !== '' ? t('invalidRole') : t('fieldIdHint')}
              </span>
            </label>
            <label className="ps-field">
              <span className="ps-field__label">{t('fieldName')}</span>
              <input
                className={nameInvalid ? 'ps-input is-invalid' : 'ps-input'}
                value={editing.name}
                disabled={busy}
                onChange={onEditField('name')}
              />
            </label>
            <label className="ps-field">
              <span className="ps-field__label">{t('fieldDescription')}</span>
              <input
                className="ps-input"
                value={editing.description}
                disabled={busy}
                onChange={onEditField('description')}
              />
            </label>
            <label className="ps-field">
              <span className="ps-field__label">{t('fieldPersona')}</span>
              <textarea
                className="ps-textarea"
                value={editing.persona}
                disabled={busy}
                onChange={onEditField('persona')}
              />
              <span className="ps-field__hint">{t('fieldPersonaHint')}</span>
            </label>
          </div>
        </div>
        <div className="ps-card__foot">
          <Button
            variant="primary"
            disabled={busy || idInvalid || nameInvalid}
            onClick={() => controller.commitEdit()}
          >
            {busy ? t('saving') : t('save')}
          </Button>
          <Button disabled={busy} onClick={() => controller.cancelEdit()}>
            {t('cancel')}
          </Button>
        </div>
      </section>
    )

  return (
    <div className="dsh-panel ps-page">
      <header className="ps-head">
        <div>
          <div className="ps-head__titlerow">
            <h2 className="ps-head__title">{t('nav')}</h2>
            <span className="ps-head__count" title={t('countRoles')}>
              {roles.length}
            </span>
          </div>
          <p className="ps-head__sub">{t('subtitle')}</p>
        </div>
        <p className="ps-head__meta">{t('pageMeta')}</p>
      </header>

      <div className="ps-tabs" role="tablist" aria-label={t('nav')}>
        <span
          className={tab === 'library' ? 'ps-tabs__pill is-second' : 'ps-tabs__pill'}
          aria-hidden="true"
        />
        {tabs.map((item) => (
          <button
            key={item.value}
            type="button"
            className="ps-tab"
            role="tab"
            id={item.id}
            aria-selected={tab === item.value}
            aria-controls={item.panel}
            tabIndex={tab === item.value ? 0 : -1}
            onClick={() => controller.setTab(item.value)}
            onKeyDown={onTabKeyDown}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'general' ? (
        <div className="ps-panel" role="tabpanel" id="ps-panel-general" aria-labelledby="ps-tab-general">
          <section className="ps-card">
            <div className="ps-card__head">
              <div>
                <h3>{t('defaultRole')}</h3>
                <p>{t('defaultRoleHint')}</p>
              </div>
            </div>
            <div className="ps-card__body">
              <div className="ps-form">
                <SettingsForm
                  labels={formLabels(t)}
                  state={state}
                  onSave={props.save}
                  onDiscard={props.discard}
                >
                  <SettingsValueField
                    id="persona-switcher-default-role"
                    label={t('fieldDefaultRole')}
                    placeholder="whale-girl"
                    overriddenLabel={t('overridden')}
                    resetLabel={t('reset')}
                    invalidLabel={t('invalidRole')}
                    disabled={!state.writable}
                    {...state.defaultRole}
                    onEdit={(text) => props.edit('defaultRole', text)}
                    onReset={() => props.resetField('defaultRole')}
                  />
                </SettingsForm>
              </div>
            </div>
          </section>

          <section className="ps-card">
            <div className="ps-card__head">
              <div>
                <h3>{t('toolCard')}</h3>
                <p>{t('exposeToolHint')}</p>
              </div>
            </div>
            <div className="ps-card__body">
              <div className="ps-row">
                <div className="ps-row__text">
                  <span className="ps-row__label">{t('exposeTool')}</span>
                </div>
                <Switch
                  checked={exposeTool}
                  label={t('exposeTool')}
                  disabled={!state.writable || busy}
                  onChange={(value) => controller.setExposeTool(value)}
                />
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="ps-panel" role="tabpanel" id="ps-panel-library" aria-labelledby="ps-tab-library">
          {editor ?? roleLibrary}
        </div>
      )}
    </div>
  )
}

/**
 * Mount the persona switcher's settings page while the Host serves its
 * namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'persona-switcher: dictionaries')
  installStyle()
  ctx.effect(() => installPersonaNavIcon(t) || undefined, 'persona-switcher: nav icon')
  const card = new PersonaSwitcherCardController(ctx.configForms.get(CONFIG_KEY), t)
  ctx.effect(
    () => () => {
      card.dispose()
    },
    'persona-switcher: form subscription'
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'persona-switcher',
        order: 15,
        label: () => t('nav'),
        inject: () => card.inject()
      },
      PersonaSwitcherSection
    )
  )
}

const zh = {
  nav: '人设切换',
  subtitle: '新会话的默认人设，以及可切换角色的集中管理。',
  pageMeta: '默认人设 · 角色库 · role_probe 工具',
  countRoles: '角色数',
  tabGeneral: '常规',
  tabLibrary: '角色库',
  defaultRole: '默认角色',
  defaultRoleHint: '新会话在未指定角色时绑定的人设。留空则使用部署默认值。',
  fieldDefaultRole: '角色 id',
  toolCard: '模型工具',
  exposeTool: '暴露 role_probe 工具',
  exposeToolHint:
    '开启后，模型可通过 role_probe 查看当前绑定角色、可用角色列表与已注册指令；关闭后该工具不再提供。',
  library: '角色库',
  libraryHint: '角色保存在服务端 roles-dir 指向的目录；此处编辑立即生效。',
  loading: '正在读取角色库…',
  rolesEmpty: '还没有角色',
  rolesEmptyHint: '新增第一个角色，之后就能用 /role 在会话中切换。',
  confirmDelete: '确认删除？',
  edit: '编辑',
  delete: '删除',
  add: '新增角色',
  addTitle: '新增角色',
  editTitle: '编辑角色',
  editorHint: '保存后立即写入服务端角色目录并对新会话生效。',
  fieldId: 'id',
  fieldIdHint: '小写字母 / 数字 / 连字符；创建后不可修改。',
  fieldName: '名称',
  fieldDescription: '描述',
  fieldPersona: '人设',
  fieldPersonaHint: '写入新会话的系统提示词（system prompt）。',
  invalidRole: '无效的角色 id',
  save: '保存',
  cancel: '取消',
  unavailable: '设置当前不可用',
  readOnly: '只读',
  saveFailed: '保存失败',
  saving: '保存中…',
  overridden: '已由部署配置覆盖',
  reset: '重置'
}

const en = {
  nav: 'Persona Switcher',
  subtitle: 'The default persona for new sessions, plus one place for every switchable role.',
  pageMeta: 'Default persona · role library · role_probe tool',
  countRoles: 'Roles',
  tabGeneral: 'General',
  tabLibrary: 'Role library',
  defaultRole: 'Default role',
  defaultRoleHint: 'Persona bound to new sessions that do not pick a role. Empty keeps the deployment default.',
  fieldDefaultRole: 'Role id',
  toolCard: 'Model tooling',
  exposeTool: 'Expose the role_probe tool',
  exposeToolHint:
    'When on, the model can read the bound role, the available roles and the registered commands through role_probe; when off the tool is not provided.',
  library: 'Role library',
  libraryHint: 'Roles live under the server roles-dir; edits apply immediately.',
  loading: 'Loading the role library…',
  rolesEmpty: 'No roles yet',
  rolesEmptyHint: 'Add the first role, then switch it per session with /role.',
  confirmDelete: 'Delete?',
  edit: 'Edit',
  delete: 'Delete',
  add: 'Add role',
  addTitle: 'Add role',
  editTitle: 'Edit role',
  editorHint: 'Saving writes the role straight to the server directory; new sessions pick it up.',
  fieldId: 'id',
  fieldIdHint: 'Lowercase letters, digits and hyphens; fixed once created.',
  fieldName: 'Name',
  fieldDescription: 'Description',
  fieldPersona: 'Persona',
  fieldPersonaHint: 'The system prompt injected into new sessions.',
  invalidRole: 'Invalid role id',
  save: 'Save',
  cancel: 'Cancel',
  unavailable: 'Settings are unavailable right now',
  readOnly: 'Read only',
  saveFailed: 'Save failed',
  saving: 'Saving…',
  overridden: 'Overridden by the deployment',
  reset: 'Reset'
}
