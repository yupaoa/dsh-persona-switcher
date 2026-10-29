/** Per-browser preference for the composer persona picker. */
export const COMPOSER_KEY = 'dsh-persona-switcher:composer-shown'
/** Broadcast when another surface (or another tab) flips the preference. */
export const COMPOSER_EVENT = 'persona-switcher:composer-changed'

/** Whether the composer picker should be mounted. Unset means on. */
export const readComposerShown = () => {
  try {
    return globalThis.window?.localStorage?.getItem(COMPOSER_KEY) !== '0'
  } catch {
    return true
  }
}

/** Persist the choice and tell every mounted surface about it. */
export const writeComposerShown = (value) => {
  const shown = value === true
  try {
    globalThis.window?.localStorage?.setItem(COMPOSER_KEY, shown ? '1' : '0')
  } catch {
    /* a blocked storage still gets the in-page broadcast below */
  }
  try {
    globalThis.window?.dispatchEvent?.(new Event(COMPOSER_EVENT))
  } catch {
    /* a host without Event still re-reads the key on the next mount */
  }
  return shown
}
