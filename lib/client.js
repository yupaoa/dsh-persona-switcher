window.__ModuleLoader__.load({
	id: "dsh-persona-switcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "persona-switcher";
var CONFIG_KEY = "persona-switcher";
var API_BASE = "/persona-switcher";
var inject = ["slots", "locale", "configForms"];
var emptyRole = () => ({ id: "", name: "", description: "", persona: "" });
var ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
var api = async (method, path, body) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === void 0 ? void 0 : { "content-type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload;
};
var PersonaSwitcherCardController = class {
  /**
   * @param scope - the shared configuration form for this card's namespace.
   * @param t - the bound dictionary.
   */
  constructor(scope, t) {
    __publicField(this, "scope");
    __publicField(this, "t");
    __publicField(this, "form");
    /** The section's snapshot store, rebuilt by the form on every publish. */
    __publicField(this, "store");
    /** Role library state, projected into the store snapshot. */
    __publicField(this, "status", "loading");
    __publicField(this, "error", null);
    __publicField(this, "roles", []);
    __publicField(this, "editing", null);
    /** `true` while the editor stages a brand-new role (id still editable). */
    __publicField(this, "editingNew", false);
    __publicField(this, "busy", false);
    /** Which tab of the page is showing: `general` | `library`. */
    __publicField(this, "tab", "general");
    /** Role id waiting for a delete confirmation, or `null`. */
    __publicField(this, "confirming", null);
    /** Latest load wins; an older response never overwrites a newer one. */
    __publicField(this, "generation", 0);
    this.scope = scope;
    this.t = t;
    this.form = new import_dsh_client_ui_primitives.SettingsFormModel(scope, [(0, import_dsh_client_ui_primitives.settingsTextField)("defaultRole")]);
    this.store = this.form.bind(() => this.projection());
    void this.load();
  }
  /** Build the section's state from the form's field reads and the library. */
  projection() {
    return {
      ...this.form.shell(),
      defaultRole: this.form.field("defaultRole"),
      exposeTool: this.scope.getSnapshot().value?.exposeTool ?? true,
      status: this.status,
      error: this.error,
      roles: this.roles,
      editing: this.editing === null ? null : { ...this.editing },
      editingNew: this.editingNew,
      busy: this.busy,
      tab: this.tab,
      confirming: this.confirming
    };
  }
  /** Switch the visible page tab and drop any pending delete confirmation. */
  setTab(tab) {
    if (tab !== "general" && tab !== "library") return;
    this.tab = tab;
    this.confirming = null;
    this.form.publish();
  }
  /** Ask the row for a delete confirmation before `remove` runs. */
  setConfirming(id) {
    this.confirming = id;
    this.form.publish();
  }
  /** Back out of a pending delete confirmation. */
  cancelConfirm() {
    this.confirming = null;
    this.form.publish();
  }
  /** Update one staged editor field and republish the section snapshot. */
  patchEditing(field, value) {
    if (this.editing === null) return;
    this.editing = { ...this.editing, [field]: value };
    this.form.publish();
  }
  /**
   * Refresh the role library. A failed refresh keeps the last good rows and
   * surfaces the error text.
   */
  async load() {
    const generation = ++this.generation;
    this.status = "loading";
    this.error = null;
    this.confirming = null;
    this.form.publish();
    try {
      const payload = await api("GET", "/roles");
      if (generation !== this.generation) return;
      this.status = "ready";
      this.roles = payload.roles ?? [];
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = "error";
      this.error = error.message;
    }
    this.form.publish();
  }
  /** Begin editing a role; `null` prepares a new-role row. */
  edit(role) {
    this.editing = role === null ? emptyRole() : { ...role };
    this.editingNew = role === null;
    this.tab = "library";
    this.confirming = null;
    this.form.publish();
  }
  /** Drop the editor without writing. */
  cancelEdit() {
    this.editing = null;
    this.editingNew = false;
    this.form.publish();
  }
  /** Write the staged editor row through the role library. */
  async commitEdit() {
    if (this.editing === null) return;
    this.busy = true;
    this.error = null;
    this.form.publish();
    try {
      await api("POST", "/role", this.editing);
      this.editing = null;
      this.editingNew = false;
      await this.load();
    } catch (error) {
      this.error = error.message;
      this.form.publish();
    } finally {
      this.busy = false;
      this.form.publish();
    }
  }
  /** Delete a role through the role library. */
  async remove(role) {
    this.busy = true;
    this.error = null;
    this.confirming = null;
    this.form.publish();
    try {
      await api("DELETE", `/role?id=${encodeURIComponent(role.id)}`);
      await this.load();
    } catch (error) {
      this.error = error.message;
      this.form.publish();
    } finally {
      this.busy = false;
      this.form.publish();
    }
  }
  /** Toggle the role_probe tool exposure through the volatile settings field. */
  async setExposeTool(value) {
    this.busy = true;
    this.error = null;
    this.form.publish();
    try {
      await this.scope.set("exposeTool", value);
    } catch (error) {
      this.error = error.message;
      this.form.publish();
    } finally {
      this.busy = false;
      this.form.publish();
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
    };
  }
  /** Release subscriptions and queued writes. */
  dispose() {
    this.generation += 1;
    return this.form.dispose();
  }
};
var formLabels = (t) => ({
  unavailable: t("unavailable"),
  readOnly: t("readOnly"),
  saveFailed: t("saveFailed"),
  save: t("save"),
  saving: t("saving")
});
var initialOf = (role) => {
  const source = String(role.name || role.id || "").trim();
  return source.length === 0 ? "?" : source[0].toUpperCase();
};
var STYLE_ID = "persona-switcher-settings-style";
var STYLE_TEXT = `
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

/* \u2500\u2500 Header: title + role count, one-liner left, scope meta right \u2500\u2500 */
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

/* \u2500\u2500 Segmented tab bar with a sliding pill \u2500\u2500 */
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

/* \u2500\u2500 Panels: fade + settle on tab switch \u2500\u2500 */
.dsh-panel.ps-page .ps-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: ps-panel-in 180ms var(--ps-ease);
}
@keyframes ps-panel-in {
  from { opacity: 0; transform: translateY(4px); }
}

/* \u2500\u2500 Cards \u2500\u2500 */
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

/* \u2500\u2500 Label-left / control-right rows \u2500\u2500 */
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

/* \u2500\u2500 Role rows \u2500\u2500 */
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

/* \u2500\u2500 Empty & loading states \u2500\u2500 */
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

/* \u2500\u2500 Error banner \u2500\u2500 */
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

/* \u2500\u2500 Editor fields \u2500\u2500 */
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

/* \u2500\u2500 Host chrome we adopt: the form's save footer sits at the card bottom,
   right-aligned; the failed note stays left. \u2500\u2500 */
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
`;
var installStyle = () => {
  if (typeof document === "undefined" || document.head === null) return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
};
var PS_ICON_VIEWBOX = "0 0 16 16";
var PS_ICON_PARTS = [
  ["path", { d: "M3.4 6.2V4.8a1.7 1.7 0 0 1 1.7-1.7h5.8a1.7 1.7 0 0 1 1.7 1.7v1.4c0 4-2.15 7.2-4.6 7.2S3.4 10.2 3.4 6.2Z" }],
  ["circle", { cx: "6.15", cy: "7.35", r: "0.75", fill: "currentColor", stroke: "none" }],
  ["circle", { cx: "9.85", cy: "7.35", r: "0.75", fill: "currentColor", stroke: "none" }],
  ["path", { d: "M6.2 10.1q1.8 1.6 3.6 0" }]
];
var psIconSvgString = (size) => {
  const attrs = `viewBox="${PS_ICON_VIEWBOX}" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"`;
  const inner = PS_ICON_PARTS.map(
    ([tag, props]) => `<${tag} ${Object.keys(props).map((key) => `${key}="${props[key]}"`).join(" ")}/>`
  ).join("");
  return `<svg ${attrs}>${inner}</svg>`;
};
var installPersonaNavIcon = (t) => {
  if (typeof document === "undefined" || document.body === null) return null;
  if (typeof MutationObserver !== "function") return null;
  const patched = /* @__PURE__ */ new WeakSet();
  const patchIn = (root) => {
    if (!root || typeof root.querySelectorAll !== "function") return;
    let buttons = [];
    try {
      buttons = root.querySelectorAll("nav button");
    } catch {
      return;
    }
    const want = t("nav");
    for (const btn of buttons) {
      try {
        if (patched.has(btn)) continue;
        if ((btn.textContent || "").trim() !== want) continue;
        const iconEl = btn.firstElementChild;
        if (!iconEl || iconEl === btn.lastElementChild && btn.childElementCount < 2) continue;
        if (iconEl.getAttribute("data-ps-nav-icon") === "1") {
          patched.add(btn);
          continue;
        }
        const rawClass = iconEl.className;
        const span = document.createElement("span");
        span.className = typeof rawClass === "string" ? rawClass : iconEl.getAttribute("class") || "";
        span.setAttribute("data-ps-nav-icon", "1");
        span.innerHTML = psIconSvgString(16);
        btn.replaceChild(span, iconEl);
        patched.add(btn);
      } catch {
      }
    }
  };
  patchIn(document.body);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node && node.nodeType === 1) patchIn(node);
      }
    }
  });
  try {
    observer.observe(document.body, { childList: true });
  } catch {
    return null;
  }
  return () => {
    try {
      observer.disconnect();
    } catch {
    }
  };
};
var PersonaSwitcherSection = (props) => {
  const { controller, t, useSnapshot } = props;
  if (controller === void 0 || useSnapshot === void 0 || t === void 0) return null;
  const state = useSnapshot((value) => value);
  const { roles, editing, busy, error, exposeTool, tab, confirming, status, editingNew } = state;
  const onEditField = (field) => (event) => controller.patchEditing(field, event.target.value);
  const tabs = [
    { value: "general", id: "ps-tab-general", panel: "ps-panel-general", label: t("tabGeneral") },
    { value: "library", id: "ps-tab-library", panel: "ps-panel-library", label: t("tabLibrary") }
  ];
  const onTabKeyDown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "general" ? "library" : "general";
    controller.setTab(next);
    document.getElementById(next === "general" ? "ps-tab-general" : "ps-tab-library")?.focus();
  };
  const idText = editing === null ? "" : editing.id;
  const idInvalid = editingNew && !ID_PATTERN.test(idText);
  const nameInvalid = editing === null || editing.name.trim() === "";
  const roleLibrary = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "ps-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-card__head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("library") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("libraryHint") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => controller.edit(null), children: t("add") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-card__body ps-card__body--flush", children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "ps-error", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", children: "\u26A0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: error })
      ] }),
      status === "loading" && roles.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-skel-list", "aria-hidden": "true", children: [0, 1, 2].map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-skel", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-skel__avatar" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ps-skel__lines", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {})
          ] })
        ] }, row)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-sr", role: "status", children: t("loading") })
      ] }),
      roles.map((role) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-role", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-role__avatar", "aria-hidden": "true", children: initialOf(role) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-role__text", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-role__name", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: role.name }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "ps-role__id", children: role.id })
          ] }),
          role.description ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-role__desc", children: role.description }) : null
        ] }),
        confirming === role.id ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-role__actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-confirm", children: t("confirmDelete") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Button,
            {
              size: "sm",
              variant: "outline",
              className: "ps-danger-btn",
              disabled: busy,
              onClick: () => controller.remove(role),
              children: t("delete")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => controller.cancelConfirm(), children: t("cancel") })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-role__actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", disabled: busy, onClick: () => controller.edit(role), children: t("edit") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Button,
            {
              size: "sm",
              className: "ps-danger-btn",
              disabled: busy,
              onClick: () => controller.setConfirming(role.id),
              children: t("delete")
            }
          )
        ] })
      ] }, role.id)),
      status === "ready" && roles.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-empty", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-empty__icon", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "path",
            {
              d: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z",
              fill: "currentColor"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z", fill: "currentColor", opacity: "0.65" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ps-empty__title", children: t("rolesEmpty") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ps-empty__hint", children: t("rolesEmptyHint") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", size: "sm", disabled: busy, onClick: () => controller.edit(null), children: t("add") })
      ] })
    ] })
  ] });
  const editor = editing === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "ps-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-card__head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: editingNew ? t("addTitle") : t("editTitle") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("editorHint") })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-card__body", children: [
      error !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "ps-error", role: "alert", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { "aria-hidden": "true", children: "\u26A0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: error })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-fields", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "ps-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-field__label", children: t("fieldId") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              className: idInvalid ? "ps-input is-invalid" : "ps-input",
              value: editing.id,
              disabled: !editingNew || busy,
              placeholder: "whale-girl",
              onChange: onEditField("id")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: idInvalid ? "ps-field__hint is-error" : "ps-field__hint", children: idInvalid && editing.id !== "" ? t("invalidRole") : t("fieldIdHint") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "ps-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-field__label", children: t("fieldName") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              className: nameInvalid ? "ps-input is-invalid" : "ps-input",
              value: editing.name,
              disabled: busy,
              onChange: onEditField("name")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "ps-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-field__label", children: t("fieldDescription") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              className: "ps-input",
              value: editing.description,
              disabled: busy,
              onChange: onEditField("description")
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "ps-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-field__label", children: t("fieldPersona") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              className: "ps-textarea",
              value: editing.persona,
              disabled: busy,
              onChange: onEditField("persona")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-field__hint", children: t("fieldPersonaHint") })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-card__foot", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_dsh_client_ui_primitives.Button,
        {
          variant: "primary",
          disabled: busy || idInvalid || nameInvalid,
          onClick: () => controller.commitEdit(),
          children: busy ? t("saving") : t("save")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { disabled: busy, onClick: () => controller.cancelEdit(), children: t("cancel") })
    ] })
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-panel ps-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "ps-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-head__titlerow", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "ps-head__title", children: t("nav") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-head__count", title: t("countRoles"), children: roles.length })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ps-head__sub", children: t("subtitle") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "ps-head__meta", children: t("pageMeta") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-tabs", role: "tablist", "aria-label": t("nav"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "span",
        {
          className: tab === "library" ? "ps-tabs__pill is-second" : "ps-tabs__pill",
          "aria-hidden": "true"
        }
      ),
      tabs.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          className: "ps-tab",
          role: "tab",
          id: item.id,
          "aria-selected": tab === item.value,
          "aria-controls": item.panel,
          tabIndex: tab === item.value ? 0 : -1,
          onClick: () => controller.setTab(item.value),
          onKeyDown: onTabKeyDown,
          children: item.label
        },
        item.value
      ))
    ] }),
    tab === "general" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-panel", role: "tabpanel", id: "ps-panel-general", "aria-labelledby": "ps-tab-general", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "ps-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-card__head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("defaultRole") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("defaultRoleHint") })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-card__body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-form", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.SettingsForm,
          {
            labels: formLabels(t),
            state,
            onSave: props.save,
            onDiscard: props.discard,
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              import_dsh_client_ui_primitives.SettingsValueField,
              {
                id: "persona-switcher-default-role",
                label: t("fieldDefaultRole"),
                placeholder: "whale-girl",
                overriddenLabel: t("overridden"),
                resetLabel: t("reset"),
                invalidLabel: t("invalidRole"),
                disabled: !state.writable,
                ...state.defaultRole,
                onEdit: (text) => props.edit("defaultRole", text),
                onReset: () => props.resetField("defaultRole")
              }
            )
          }
        ) }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "ps-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-card__head", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("toolCard") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("exposeToolHint") })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-card__body", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ps-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-row__text", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "ps-row__label", children: t("exposeTool") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Switch,
            {
              checked: exposeTool,
              label: t("exposeTool"),
              disabled: !state.writable || busy,
              onChange: (value) => controller.setExposeTool(value)
            }
          )
        ] }) })
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "ps-panel", role: "tabpanel", id: "ps-panel-library", "aria-labelledby": "ps-tab-library", children: editor ?? roleLibrary })
  ] });
};
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "persona-switcher: dictionaries");
  installStyle();
  ctx.effect(() => installPersonaNavIcon(t) || void 0, "persona-switcher: nav icon");
  const card = new PersonaSwitcherCardController(ctx.configForms.get(CONFIG_KEY), t);
  ctx.effect(
    () => () => {
      card.dispose();
    },
    "persona-switcher: form subscription"
  );
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "persona-switcher",
        order: 15,
        label: () => t("nav"),
        inject: () => card.inject()
      },
      PersonaSwitcherSection
    )
  );
}
var zh = {
  nav: "\u4EBA\u8BBE\u5207\u6362",
  subtitle: "\u65B0\u4F1A\u8BDD\u7684\u9ED8\u8BA4\u4EBA\u8BBE\uFF0C\u4EE5\u53CA\u53EF\u5207\u6362\u89D2\u8272\u7684\u96C6\u4E2D\u7BA1\u7406\u3002",
  pageMeta: "\u9ED8\u8BA4\u4EBA\u8BBE \xB7 \u89D2\u8272\u5E93 \xB7 role_probe \u5DE5\u5177",
  countRoles: "\u89D2\u8272\u6570",
  tabGeneral: "\u5E38\u89C4",
  tabLibrary: "\u89D2\u8272\u5E93",
  defaultRole: "\u9ED8\u8BA4\u89D2\u8272",
  defaultRoleHint: "\u65B0\u4F1A\u8BDD\u5728\u672A\u6307\u5B9A\u89D2\u8272\u65F6\u7ED1\u5B9A\u7684\u4EBA\u8BBE\u3002\u7559\u7A7A\u5219\u4F7F\u7528\u90E8\u7F72\u9ED8\u8BA4\u503C\u3002",
  fieldDefaultRole: "\u89D2\u8272 id",
  toolCard: "\u6A21\u578B\u5DE5\u5177",
  exposeTool: "\u66B4\u9732 role_probe \u5DE5\u5177",
  exposeToolHint: "\u5F00\u542F\u540E\uFF0C\u6A21\u578B\u53EF\u901A\u8FC7 role_probe \u67E5\u770B\u5F53\u524D\u7ED1\u5B9A\u89D2\u8272\u3001\u53EF\u7528\u89D2\u8272\u5217\u8868\u4E0E\u5DF2\u6CE8\u518C\u6307\u4EE4\uFF1B\u5173\u95ED\u540E\u8BE5\u5DE5\u5177\u4E0D\u518D\u63D0\u4F9B\u3002",
  library: "\u89D2\u8272\u5E93",
  libraryHint: "\u89D2\u8272\u4FDD\u5B58\u5728\u670D\u52A1\u7AEF roles-dir \u6307\u5411\u7684\u76EE\u5F55\uFF1B\u6B64\u5904\u7F16\u8F91\u7ACB\u5373\u751F\u6548\u3002",
  loading: "\u6B63\u5728\u8BFB\u53D6\u89D2\u8272\u5E93\u2026",
  rolesEmpty: "\u8FD8\u6CA1\u6709\u89D2\u8272",
  rolesEmptyHint: "\u65B0\u589E\u7B2C\u4E00\u4E2A\u89D2\u8272\uFF0C\u4E4B\u540E\u5C31\u80FD\u7528 /role \u5728\u4F1A\u8BDD\u4E2D\u5207\u6362\u3002",
  confirmDelete: "\u786E\u8BA4\u5220\u9664\uFF1F",
  edit: "\u7F16\u8F91",
  delete: "\u5220\u9664",
  add: "\u65B0\u589E\u89D2\u8272",
  addTitle: "\u65B0\u589E\u89D2\u8272",
  editTitle: "\u7F16\u8F91\u89D2\u8272",
  editorHint: "\u4FDD\u5B58\u540E\u7ACB\u5373\u5199\u5165\u670D\u52A1\u7AEF\u89D2\u8272\u76EE\u5F55\u5E76\u5BF9\u65B0\u4F1A\u8BDD\u751F\u6548\u3002",
  fieldId: "id",
  fieldIdHint: "\u5C0F\u5199\u5B57\u6BCD / \u6570\u5B57 / \u8FDE\u5B57\u7B26\uFF1B\u521B\u5EFA\u540E\u4E0D\u53EF\u4FEE\u6539\u3002",
  fieldName: "\u540D\u79F0",
  fieldDescription: "\u63CF\u8FF0",
  fieldPersona: "\u4EBA\u8BBE",
  fieldPersonaHint: "\u5199\u5165\u65B0\u4F1A\u8BDD\u7684\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF08system prompt\uFF09\u3002",
  invalidRole: "\u65E0\u6548\u7684\u89D2\u8272 id",
  save: "\u4FDD\u5B58",
  cancel: "\u53D6\u6D88",
  unavailable: "\u8BBE\u7F6E\u5F53\u524D\u4E0D\u53EF\u7528",
  readOnly: "\u53EA\u8BFB",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  overridden: "\u5DF2\u7531\u90E8\u7F72\u914D\u7F6E\u8986\u76D6",
  reset: "\u91CD\u7F6E"
};
var en = {
  nav: "Persona Switcher",
  subtitle: "The default persona for new sessions, plus one place for every switchable role.",
  pageMeta: "Default persona \xB7 role library \xB7 role_probe tool",
  countRoles: "Roles",
  tabGeneral: "General",
  tabLibrary: "Role library",
  defaultRole: "Default role",
  defaultRoleHint: "Persona bound to new sessions that do not pick a role. Empty keeps the deployment default.",
  fieldDefaultRole: "Role id",
  toolCard: "Model tooling",
  exposeTool: "Expose the role_probe tool",
  exposeToolHint: "When on, the model can read the bound role, the available roles and the registered commands through role_probe; when off the tool is not provided.",
  library: "Role library",
  libraryHint: "Roles live under the server roles-dir; edits apply immediately.",
  loading: "Loading the role library\u2026",
  rolesEmpty: "No roles yet",
  rolesEmptyHint: "Add the first role, then switch it per session with /role.",
  confirmDelete: "Delete?",
  edit: "Edit",
  delete: "Delete",
  add: "Add role",
  addTitle: "Add role",
  editTitle: "Edit role",
  editorHint: "Saving writes the role straight to the server directory; new sessions pick it up.",
  fieldId: "id",
  fieldIdHint: "Lowercase letters, digits and hyphens; fixed once created.",
  fieldName: "Name",
  fieldDescription: "Description",
  fieldPersona: "Persona",
  fieldPersonaHint: "The system prompt injected into new sessions.",
  invalidRole: "Invalid role id",
  save: "Save",
  cancel: "Cancel",
  unavailable: "Settings are unavailable right now",
  readOnly: "Read only",
  saveFailed: "Save failed",
  saving: "Saving\u2026",
  overridden: "Overridden by the deployment",
  reset: "Reset"
};

		return module.exports;
	},
});
