/**
 * Behavior-equivalent shim of `@deepseek-ai/dsh-client-ui-primitives` for the
 * simulation harness only.
 *
 * The npm rc package does not declare its transitive dependencies, so Node
 * cannot load it directly (missing `clsx`, `dsh-util-*`, and the CSS-module
 * imports). This shim mirrors the official semantics extracted from the
 * primitives source (SettingsFormModel, settingsTextField, shell/field/actions
 * shapes) so the simulation exercises the persona-switcher client against the
 * real contract without a DOM or the package's bundle.
 *
 * The render-only components (SettingsForm, SettingsValueField, Switch,
 * Button) are exported as identity markers; the simulation never renders.
 */
const emptyModule = {}

function settingsTextField(field) {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    }
  }
}

/** A bare snapshot store holding one object, replaced by callers. */
const createSnapshotStore = (initial) => {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** Official SettingsFormModel semantics (source-verified). */
class SettingsFormModel {
  scope
  specs
  secretSpecs
  staged = new Map()
  listeners = new Set()
  baseline
  unsubscribe
  saving = false
  failed = false

  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
    })
  }

  bind(project) {
    const store = createSnapshotStore(project())
    this.listeners.add(() => {
      store.set(project())
    })
    return store
  }

  shell() {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === void 0 && item.op === void 0),
      saving: this.saving,
      failed: this.failed
    }
  }

  field(field) {
    const staged = this.staged.get(field)
    if (this.secretSpecs.has(field)) {
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    const spec = this.spec(field)
    if (staged === void 0) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false
      }
    }
    const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === void 0 }
  }

  actions() {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false })
      },
      resetField: (field) => {
        this.stage(field, {
          text: this.spec(field).format(this.baseValue(field)),
          clear: true
        })
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = void 0
        this.failed = false
        this.publish()
      }
    }
  }

  async save() {
    const plan = this.plan()
    if (
      !plan.length ||
      this.saving ||
      !this.scope.getSnapshot().writable ||
      plan.some((item) => item.run === void 0 && item.op === void 0)
    ) {
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap((item) => (item.op === void 0 ? [] : [item.op]))
      let landed = !ops.length || (await this.scope.mutate(ops, this.baseline?.revision))
      if (!landed) {
        this.failed = true
        return
      }
      for (const item of plan) if (item.run) landed = (await item.run()) && landed
      if (landed) {
        this.staged.clear()
        this.baseline = void 0
      }
      this.failed = !landed
    } catch (_error) {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  dispose() {
    this.unsubscribe()
    this.listeners.clear()
  }

  plan() {
    const plan = []
    for (const [field, staged] of this.staged) {
      const secret = this.secretSpecs.get(field)
      if (secret !== void 0) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: 'unset', path: [field] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === void 0) plan.push({ field })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [field] } })
      else plan.push({ field, op: { op: 'set', path: [field], value: write.value } })
    }
    return plan
  }

  stage(field, edit) {
    this.baseline ??= this.scope.getSnapshot()
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  spec(field) {
    const spec = this.specs.get(field)
    if (spec === void 0) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  snapshotOf() {
    return this.scope.getSnapshot()
  }

  sectionValue(field) {
    return this.snapshotOf().value?.[field]
  }

  baseValue(field) {
    return this.snapshotOf().base?.[field]
  }

  userLayer() {
    return this.snapshotOf().user
  }

  stored(field) {
    const user = this.userLayer()
    return user !== void 0 && Object.hasOwn(user, field)
  }

  publish() {
    for (const listener of this.listeners) listener()
  }
}

export { emptyModule as Button, emptyModule as SettingsForm, SettingsFormModel, emptyModule as SettingsValueField, emptyModule as Switch, settingsTextField }