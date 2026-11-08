/**
 * The few things both halves of this client need and neither owns.
 *
 * There used to be two copies of each: `API_BASE` was spelled out in the settings
 * page ("src/client/index.jsx owns the base too", said the other copy) and the
 * stylesheet installer existed twice, byte for byte, once per surface. A base
 * that drifts between the page and the mascot is a silent 404 on one of them, and
 * the installer is subtle enough (hot reload keeps the DOM but not the CSS) that
 * two copies will eventually disagree about one of its three branches.
 *
 * Nothing here decides anything about roles — it is transport and `<style>` only.
 * @module dsh-persona-switcher/client-shared
 */

/** URL prefix of the role library API. One spelling, both surfaces. */
export const API_BASE = '/persona-switcher'

/** Whether there is a DOM to touch (the simulation harness has none). */
export const hasDom = () => typeof document !== 'undefined' && document !== null

/**
 * Install a stylesheet once, and refresh it when the build changed it.
 *
 * Three branches, all load-bearing: no DOM (a test harness) is a no-op; an
 * existing element with a stale `textContent` is refreshed, because a
 * hot-reloaded client keeps the old `#id` element but re-runs this module, and an
 * early return would leave the previous build's rules in force; otherwise the
 * element is created and appended.
 *
 * @param id - the `<style>` element id (each surface owns its own).
 * @param text - the stylesheet text.
 */
export const installStyleOnce = (id, text) => {
  if (!hasDom() || document.head === null) return
  const existing = document.getElementById(id)
  if (existing !== null) {
    if (existing.textContent !== text) existing.textContent = text
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = text
  document.head.appendChild(style)
}
