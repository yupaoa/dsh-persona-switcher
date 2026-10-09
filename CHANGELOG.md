# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-10-09

### Fixed

- **`/role none` now announces the change, like every other persona transition.** The notice was
  wired into the switch path alone, so it covered role-to-role switches and nothing else: the clear
  path dropped the binding and wrote the opt-out without ever queueing a notice, and the notice
  builder itself returned an empty string whenever the `from` side was unknown, which made the
  omission structural rather than accidental. The symptom was precisely what the notice exists to
  prevent — the prompt goes back to the deployment persona while the reply keeps arriving in the
  dismissed role's voice, because this conversation's own earlier assistant turns still demonstrate
  that voice far more concretely than a system prefix establishes the new one. The notice is now
  built from *both* sides of the transition (`null` standing for the deployment persona), and every
  deliberate change queues one: role → role, deployment persona → role, role → `/role none`, and a
  remembered role that vanished from the library handing the session to another one. The cases that
  must stay quiet still do: an automatic rebind that leaves the session's role unchanged (the same
  role restored after a restart, or a configured default applied to a session that never chose one)
  changes nothing the model can read, so announcing it would put a bogus "role change" message in
  front of every resumed session.

### Added

- **`scripts/verify-role-notice.mjs`, a behavioural guard for the notice contract.** Seven checks: the
  `/role none` notice and its one-shot nature, the deployment-persona → role direction, the
  role-to-role notice naming both roles, silence when the session already ran the deployment persona
  (no-op opt-out), silence under `announceRoleChange: false`, silence for a same-role restore, and
  the vanished-role hand-over. Run against the 0.1.7 code it fails exactly three of them, which is what makes
  it a regression guard rather than a description. Wired into `npm test` and `prepublishOnly`.

## [0.1.7] - 2026-10-07

### Changed

- **`announceRoleChange` now defaults to `true`.** The role-change notice used to
  be off by default, on the assumption that replacing the head system node is
  enough: the superseded persona text does leave the prompt, so the model cannot
  read it again. A measured switch shows that assumption is only half right. On a
  session switched from `whale-girl` to `amiya`, the next step's system prompt
  already carried the new persona — zero occurrences of the old persona prose;
  the single hit for the old role's name was the role catalogue listing — and the
  reply still came back in the old role's voice. The transcript's own earlier
  assistant turns demonstrate that voice far more concretely than a system prefix
  establishes the new one, so the model follows the evidence closest to the
  conversation. The notice is the in-band statement that resolves the conflict in
  favour of the current role, which makes it the right default; set
  `announceRoleChange: false` only where the prompt swap alone is trusted and the
  extra message is unwanted weight. A profile that already pinned the old default
  explicitly is unaffected. Verified end-to-end afterwards in a headless profile that pins nothing:
  a real `/role troll-helper` switch produced exactly one notice in the transcript
  (`source: {kind: "persona-switcher", form: "role-change", from: "whale-girl", to: "troll-helper"}`)
  and the next reply came back in the new role's voice.

### Added

- **A "what it touches on disk" boundary section in the README** (Chinese and English). It names the
  four write locations — the session state file, a role's `ROLE.md`, a role directory on delete, and
  the profile patch file that the host writes on the plugin's behalf — plus the read-only surfaces,
  the inbound loopback route and its four endpoints, the fact that the route carries no auth of its
  own, the extra capability `role_probe` holds (its `command` argument executes any registered slash
  command, not just `/role`), and how to tighten or fully undo all of it. The point is that the
  plugin's reach can be audited from the README before someone decides to trust it.

### Fixed

- Removed a duplicated sentence in the middle of the switching walkthrough.

## [0.1.6] - 2026-10-07

### Fixed

- **The plugin inventory now shows this plugin's own title and description.** The
  Settings plugin inventory, the Plugin Manager card and the bundle details read
  that text from `locale/en.json` and `locale/zh.json` without activating the
  plugin, resolving every file through the package's `exports` map
  (`<name>/locale/en.json`). `./locale/*.json` was not an exported subpath, so
  that lookup failed and the row silently fell back to `package.json` `name` and
  `description` — it read `dsh-persona-switcher` with the bilingual npm
  description instead of `人设切换` / `Persona Switcher`. The subpath is exported
  now, so the row reads `人设切换` in Chinese and `Persona Switcher` in English.
  Nothing in the runtime code changed: this release is the manifest plus locale
  data.

### Added

- `scripts/verify-bundle.mjs` hard rule 5: `package.json` must export
  `./locale/*.json` and `./package.json`, both locale files must carry a
  non-empty `meta.title` and `meta.description`, and `files` must ship `locale/`.
  The fallback to `package.json` happens without any diagnostic, so this
  invariant is what turns the same regression into a red build instead of a row
  that quietly shows the package name.

### Changed

- The 0.1.3, 0.1.4 and 0.1.5 headings are dated `2026-10-07`, the day those
  versions were released; they had been dated one day ahead.

## [0.1.5] - 2026-10-07

### Fixed

- **A remembered role is in force from the first step after a restart.** The
  harness assembles a model step's prompt *before* it runs `agent/pre-step`, so a
  role restored on that seam only reached the second reply: the first one after a
  DSH restart still ran on the deployment persona, which made a durable switch
  look half-applied. Roles are now installed from `agent/created` as well — the
  harness awaits those listeners inside the session-creation transaction, before
  it releases the input queued for that agent — so the persona is already in the
  prompt of the very first step. `agent/pre-step` keeps its job: it reconciles
  the session on every later step and still persists a role that an older build
  had bound in memory only.

### Added

- The row also sweeps the agents that are already live when it loads
  (`ctx.agents.list()`), so a session resumed before the plugin loaded is bound
  the same way as one created after.
- `scripts/verify-created-bind.mjs`, run by `npm test`: drives the real
  `lib/index.js` over a fake host and checks the whole creation-time policy — the
  remembered role, the configured default, the `/role none` opt-out, a remembered
  role that left the library, and the delegated-child guard — with no
  `agent/pre-step` involved, that a later step does not churn the prompt section,
  and that the creation listener never rejects (a throwing `agent/created`
  listener rolls the session-creation transaction back).
- `scripts/verify-bundle.mjs` hard rule 4 now also fails when the creation seam
  or the live-agent sweep is removed.

## [0.1.4] - 2026-10-07

### Fixed

- **A role switch now survives a DSH restart.** The persona is registered in the
  session's own prompt scope, and the harness tears that scope down together with
  the agent, so every binding used to be lost when DSH restarted and the affected
  sessions silently fell back to the deployment persona — the switch looked like
  it had never reached the prompt. A switch is now written to
  `~/.dsh/persona-switcher/sessions.json` and re-applied on the session's next
  model step, including after a restart.
- A role that a running session already had before this upgrade is persisted on
  its next model step, so upgrading does not mean typing `/role` again.
- `/role none` (alias `/role off`) finally means what it says. The choice is now
  recorded in the same file as `null` instead of being erased, so it survives a
  restart *and* is no longer overridden by a configured `defaultRole`: any
  unbound session used to be re-bound to the default on its very next model step,
  which made the documented "back to the deployment persona" a one-step illusion.

### Added

- `lib/session-state.js`: a dependency-free store for per-session role choices.
  Writes are atomic (temporary file plus rename), a missing file is an empty
  memory, and an unreadable one is moved to `sessions.json.corrupt` instead of
  being deleted. Entries older than 180 days are dropped on write, because they
  belong to sessions that no longer exist.
- `scripts/verify-session-state.mjs`, run by `npm test`: round-trips a choice
  across processes against a real file and checks the whole restore policy —
  including that a stored role which has left the library is forgotten rather
  than resurrected, and that a role already in force is never replaced by a
  stale entry.
- `scripts/verify-bundle.mjs` hard rule 4: verification fails if either half of
  the durability path (the state module, or its pre-step wiring) is removed.

### Changed

- `/role` lists the choice remembered for the session, spelling out an explicit
  "deployment persona" choice rather than showing it as nothing, and `role_probe`
  reports that choice plus the state file. A switch whose choice could not be
  stored says so in its own output instead of being passed off as durable.

## [0.1.3] - 2026-10-07

### Fixed

- **The role persona now reaches the model.** Applying a role registers the
  deployment persona prefix section (`deployment:persona-prefix`) through the
  agent's own scoped prompt registry, which is the override the registry
  documents for a per-agent persona: the registration belongs to that session's
  scope and shadows the deployment persona for it alone. Until now the persona
  prose only reached sessions that had gone through the old preset route; the
  identity line in the prompt (`- <id>: <name> — <description>`) was the listing,
  not the persona.
- **Switching a role no longer costs the session its tools and commands.** The
  old route asked the agent-preset registry to `recompose()` the session, which
  rebinds the agent's entire plugin composition. Measured while switching: the
  model-facing tool set went from 33 to 7 and the command set from 10 to 7,
  losing `/compact`, `/goal` and `/plan` — the opposite of what this plugin
  promises. Roles are no longer registered as agent presets at all, so nothing
  about a switch can touch tools, commands, skills or model routing.
- A refused switch is now loud and non-destructive: if the registry rejects the
  new persona, the superseded one is restored and the command reports the
  failure instead of leaving the session with no identity.

### Added

- `/role none` (alias `/role off`) reverts the session to the deployment persona.
- `scripts/verify-host-binding.mjs`, run by `npm test`: behavioural checks over
  fake prompt registries covering scoped registration, replacement without
  stacking, two independent sessions, the refusal paths, restore-on-failure, and
  the fact that the agent-preset registry is never consulted.
- `scripts/verify-bundle.mjs` hard rule 3: the package fails verification if
  `lib/index.js` ever calls `recompose()` or registers with, selects through, or
  recomposes the agent-preset registry again.

### Changed

- Roles no longer appear in the harness's agent-preset picker. A persona-only
  entry there was misleading: choosing it looks like a composition change, and
  applying one after a session started was exactly the tool-losing path above.
  Roles live in the role library and in `/role`.
- `defaultRole` is applied as an agent-scoped persona section on the first step
  of a root session instead of by mounting a preset, so a session that was never
  switched and a session switched back with `/role none` both run on the
  deployment persona.
- `role_probe` reports the bound role, whether the deployment persona is still
  in force, the session's composition (as evidence that a switch left it alone),
  the registered commands and the tool list from the last request header.
- The role library API's `GET /persona-switcher/roles` reports `sessionsWithRole`
  instead of preset diagnostics.

## [0.1.2] - 2026-10-07

Packaging-only release: the plugin code is identical to 0.1.1.

### Changed

- `@deepseek-ai/cordis` is declared as `^4.0.4` instead of `~4.0.4`, matching the
  range style used by published DSH plugins and keeping the plugin installable
  when the host moves to a later 4.x line.

## [0.1.1] - 2026-10-07

Packaging-only release: the plugin code is identical to 0.1.0. It exists to
publish through the new CI path and prove it end to end.

### Changed

- npm releases are authenticated with OIDC trusted publishing
  (`permissions: id-token: write`) instead of a long-lived `NPM_TOKEN` secret.
  Provenance is attached automatically and the workflow no longer reads any
  credential from the environment.
- `actions/setup-node` no longer receives `registry-url`, so no `.npmrc`
  containing a token placeholder is generated.

## [0.1.0] - 2026-10-07

First public release.

### Added

- Persona-only role switching: swaps the model's identity and speaking style
  without touching tools, skills, or model selection.
- Role library at `<rolesDir>/<role-id>/ROLE.md` (frontmatter `id` / `name` /
  `description` plus a Markdown persona body). Only persona fields are read;
  capability fields such as `tools`, `denyTools`, `skillsDir` and `model` are
  ignored by design.
- Every role is registered as an ordinary `@deepseek-ai/dsh-agent-preset`
  declaration, so switching goes through the host preset registry.
- `/role`, `/role <id>` and `/role default <id>` slash commands.
- `defaultRole` binding applied to new sessions.
- Settings page (Settings → Persona Switcher) for creating, editing and
  deleting roles, plus a dedicated navigation icon in the settings sidebar.
- `role_probe` diagnostic tool, switchable off with `exposeTool: false`.
- English and Chinese UI strings via the host locale service.
- `scripts/simulate-client.mjs` and `scripts/simulate-primitives.mjs`: a
  dependency-free harness that loads the built client bundle against a stub
  host and asserts registration, slot injection and CRUD behaviour.

### Notes

- The browser module identity of the client bundle must equal the resolved
  package name. `scripts/build-client.mjs` derives it from `package.json`, and
  `scripts/verify-bundle.mjs` fails the build if it ever drifts.

[0.1.4]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.4
[0.1.3]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.3
[0.1.2]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.2
[0.1.1]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.1
[0.1.0]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.0
