# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/yupaoa/dsh-persona-switcher/releases/tag/v0.1.0
