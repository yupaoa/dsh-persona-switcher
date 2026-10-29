/**
 * The `/role` picker: a bare-invocation popup hung on the Host's own `/role`
 * command.
 *
 * The command itself stays where it is. `/role list`, `/role <id>`,
 * `/role default <id>` and `/role none` still reach the Host handler with their
 * arguments; only the bare `/role` — the line whose whole meaning is "show me
 * the roles" — is answered by this popup instead of a wall of text. That is what
 * `commandUi.decorate()` exists for: a contribution under the same name would be
 * refused by ui-commands ("host-name collision fails loudly"), and a decoration
 * keeps the Host's catalog row, description, argument claim and lifecycle log.
 *
 * Two decisions worth knowing:
 *
 *   - the list is read from the Host on every open, because the library is
 *     edited on the settings page (and on disk) between openings;
 *   - a pick runs the Host command through the session's own command seam, so
 *     the switch keeps its announcements, its per-session memory write and the
 *     transcript's command node instead of being re-implemented in the browser.
 */

/** The reserved id that means "stop using a role". */
const NONE_ID = 'none'

/**
 * Describe one role row for the picker.
 * @param role - the role as the library reports it.
 * @param current - whether this role is the one in force.
 * @param t - the dictionary lookup.
 * @returns the row's secondary text.
 */
const describeRole = (role, current, t) => {
  const description = typeof role.description === 'string' && role.description !== '' ? ` — ${role.description}` : ''
  return `${role.id}${description}${current ? ` · ${t('rolePickCurrent')}` : ''}`
}

/**
 * Ask the Host which role this session carries right now.
 *
 * The binding is a live value, not the session's memory: a session that
 * inherited the configured default carries a role its memory never recorded, and
 * the tick has to follow the role in force. The read is cosmetic, so a Host that
 * cannot answer (an older build, a route that is not mounted) leaves the list
 * usable and simply ticks nothing.
 *
 * @param sessionId - the browser session's id.
 * @param api - the role-library API caller.
 * @returns the role id in force, or null for the deployment persona.
 */
const loadLiveRole = async (sessionId, api, strict = false) => {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    const payload = await api('GET', `/session?session=${encodeURIComponent(sessionId)}`)
    const live = payload && Object.hasOwn(payload, 'liveRoleId') ? payload.liveRoleId : payload?.roleId
    return typeof live === 'string' && live !== '' ? live : null
  } catch (error) {
    if (strict) throw error
    return null
  }
}

/** Read the authoritative label without letting a transient failure mean "none". */
export const loadRoleLabel = async (sessionId, api) => {
  const id = await loadLiveRole(sessionId, api, true)
  if (id === null) return null
  const payload = await api('GET', `/role?id=${encodeURIComponent(id)}`)
  const name = payload?.role?.name
  return typeof name === 'string' && name.trim() !== '' ? name : id
}

/**
 * Build the option rows one opening shows.
 * @param session - the session the popup is open for.
 * @param deps - `{ api, t }`.
 * @returns `none` first, then the library in its own order.
 */
export const loadOptions = async (session, { api, t }) => {
  const live = await loadLiveRole(session?.sessionId, api)
  const payload = await api('GET', '/roles')
  const catalogue = Array.isArray(payload?.roles) ? payload.roles : []
  return [
    {
      id: NONE_ID,
      label: t('rolePickNone'),
      detail: `${t('rolePickNoneHint')}${live === null ? ` · ${t('rolePickCurrent')}` : ''}`,
      active: live === null
    },
    ...catalogue
      .filter((role) => role.id !== NONE_ID)
      .map((role) => ({
        id: role.id,
        // The role's display name is what a human recognises; the id stays in
        // the detail line so typing either one finds the row.
        label: typeof role.name === 'string' && role.name.trim() !== '' ? role.name : role.id,
        detail: describeRole(role, role.id === live, t),
        active: role.id === live
      }))
  ]
}

/**
 * Run the picked role through the session's command seam.
 * @param option - the picked row.
 * @param session - the popup's session.
 * @param deps - `{ sessions }`.
 */
export const selectRole = async (option, session, { sessions }) => {
  const sessionId = session?.sessionId
  const face = sessions?.binding?.(sessionId)?.session ?? session
  if (typeof face?.command !== 'function') {
    throw new Error('this session cannot run commands, so a role cannot be switched from here')
  }
  const result = await face.command(`/role ${option.id}`)
  // A handler outcome renders as an ordinary command node in the transcript, so
  // only an admission failure (an unknown or malformed line) is a picker error.
  if (result?.ok === false) {
    throw new Error(result.error?.message ?? `the /role command failed: ${option.id}`)
  }
  // `ok` alone is not enough: the shell can take the line and still match
  // nothing (`value.matched === false`), in which case no switch happened at
  // all. Closing the popup on that would read as success, so it is a failure.
  if (result?.value?.matched === false) {
    const reason = typeof result.value.text === 'string' ? result.value.text : 'the command was not matched'
    throw new Error(`${reason}: /role ${option.id}`)
  }
}

/**
 * Build the decoration spec.
 * @param deps - `{ api, t, sessions }`.
 * @returns the spec `commandUi.decorate()` takes.
 */
export const createRolePickerSpec = ({ api, t, sessions }) => ({
  name: 'role',
  // A session always has a role answer (possibly "none"), so the popup is never
  // unavailable; an empty library still offers the way back to the deployment
  // persona, which is exactly the state the empty text explains.
  available: () => true,
  ui: {
    kind: 'popupSelect',
    // Substring matches the label AND the detail line, so an id or a fragment of
    // the description finds its role; fuzzy-label would only see the name.
    searchMode: 'substring',
    searchLabels: () => ({
      placeholder: t('rolePickSearch'),
      empty: t('rolePickEmpty'),
      noResults: t('rolePickNoMatch')
    }),
    options: (session) => loadOptions(session, { api, t }),
    onSelect: (option, session) => selectRole(option, session, { sessions })
  }
})

/**
 * Hang the picker on the Host's `/role` command.
 *
 * `ctx.inject` (not the package-level `inject`) so a Host without the command
 * shell simply keeps the plugin inert instead of refusing to load it.
 *
 * @param ctx - the browser plugin context.
 * @param deps - `{ api, t }`.
 */
export const installRolePicker = (ctx, { api, t }) => {
  ctx.inject(['commandUi', 'sessions'], (scope) => {
    const commandUi = scope.get('commandUi')
    const sessions = scope.get('sessions')
    if (commandUi === undefined) return
    scope.effect(
      () => commandUi.decorate(createRolePickerSpec({ api, t, sessions })),
      'persona-switcher: /role picker'
    )
  })
}
