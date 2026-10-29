# Composer persona picker validation

Validated on 2026-10-28 against the installed DSH **0.2.1-rc.3** source and
installed **dsh-meme 0.1.64**, plus the locked SDK **0.2.0-rc.2** SlotCore.

## Native integration

- `dsh-client-ui-conversation/lib/client.js` declares `conversation.input.left`
  as a session-scoped **list**, after `conversation.input.permission` and before
  the trailing model controls. Persona contributes its own `persona-switcher-picker`
  cell at order 10. `dsh-meme/client.js` contributes `meme-picker` at order 5.
  Neither plugin's registration, DOM nor styles are replaced.
- `dsh-api-session-controller/lib/client.js` exposes `session.command(line)` and
  returns admission success plus `value.matched`. Both picker entry points reuse
  the existing `/role` dispatch. Host binding, persisted session state, prompt
  registration, default roles and command capabilities are unchanged.
- `dsh-client-ui-settings-general/lib/client.js` registers `sidebar.settings`
  with a shared store whose `create()` returns the existing `shellInstance`.
  `shellInstance.actions.openSection(id)` both selects the section and opens the
  dialog. The plugin checks this shape at click time; an unsupported shell yields
  a localized manual navigation instruction. No DOM click emulation is used.
- New-role IDs are suggested from the library; a fresh read before saving rejects
  an ID already present. This is a UI conflict check, not a server-side atomic
  create-only guarantee against simultaneous writes by multiple clients.
- The composer cell is optional per browser. The settings page writes
  `dsh-persona-switcher:composer-shown` to `localStorage`; the plugin disposes the
  `conversation.input.left` cell when it is off and re-registers it when it is on.
  A same-page broadcast and the native `storage` event keep every window in sync.
  This only hides the entry point: `/role` and the bound persona are untouched.
- The button reads the live binding on mount and after a selection; unbound means
  "Persona", otherwise it shows the role name or ID. A 1.5-second `/revision` poll
  detects command-driven changes without fetching persona prose every tick. Full
  reads every 15 seconds and on window focus also pick up renamed role files;
  hosts without the counter and transient failures retry after 5 seconds. Hidden
  documents skip requests, and unmount cancels pending results and timers.

## Checks

- `npm run build`, `npm run verify`, `npm test` (all existing host, persistence,
  startup binding, role notice and mascot suites, plus composer wiring / ID checks).
- `npm run test:browser` using headless Edge: runs **the built client bundle**
  with React and actual SDK SlotCore. Local fixtures stand in for DSH services,
  permission/meme/model controls and the settings form primitives.
- Browser assertions: additive slot ordering and disposal without disturbing the
  meme entry; settings toggle unmounts / remounts the cell, survives reload and
  follows another tab's `storage` event; name / ID search; live `null` precedence; separate conversation
  dispatch; unchanged unsent draft; late-response cancellation on session changes;
  failure / retry; empty library; focus, arrows, Tab and Escape support; settings
  section navigation; original editor save and immediate list refresh; editable
  unused IDs (including gaps and IDs above 999); menu bounds at 1100px and 480px.
- Label assertions: restored binding before opening the menu; name and ID fallback;
  per-session labels; rejected selection and read failure do not overwrite the
  confirmed label; command-driven changes while closed; clearing to "Persona";
  long-name truncation with the full tooltip.

The fixture is an isolated regression environment, not a full desktop end-to-end
test. The installed DSH profile was not modified or restarted, and no real
conversation, model request, platform message or device interaction was used.
Compatibility with other DSH versions relies on the same slot / session contracts;
the settings shortcut has the explicit fallback above.
