# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-10-08

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

[0.1.3]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.3
[0.1.2]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.2
[0.1.1]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.1
[0.1.0]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.0
