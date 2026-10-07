## What does this PR change?

<!-- One or two sentences. Link the issue it closes, if any: "Closes #12". -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] UI / styling
- [ ] Documentation
- [ ] Build, tooling or CI

## Checklist

- [ ] I ran `npm run build` and committed the updated `lib/client.js` together with my `src/client/index.jsx` change.
- [ ] `npm run verify` passes (module id equals package name; the bundle patch provides the row).
- [ ] `npm test` passes.
- [ ] I did **not** add an `insert:` row for this plugin to any profile's `cordis.patch.yml`.
- [ ] I did **not** rename the `persona-switcher` settings section id, the config key, or any existing config field.
- [ ] I added a `CHANGELOG.md` entry under `## [Unreleased]` if user-visible behaviour changed.
- [ ] I tested against a real DSH install (version: `______`), not only the simulation.

## Notes for the reviewer

<!-- Anything surprising, any trade-off you had to make, anything you are unsure about. -->
