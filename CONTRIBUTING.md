# Contributing

Thanks for taking the time to help. This is a small plugin; the fastest route to
a merged PR is a small, focused diff plus the local checks below.

## Development setup

```bash
git clone https://github.com/yupaoa/dsh-persona-switcher.git
cd dsh-persona-switcher
npm install
```

Requirements: Node.js 22.19+ or 24+, and a DSH installation to test against
(`>= 0.2.0-rc.1`).

## Layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | Host-side plugin: role library loading, preset registration, `/role` command, settings HTTP routes. Hand-written. |
| `src/client/index.jsx` | **Source** of the browser (settings page) half: controller, projection, React view, stylesheet, nav icon patch. |
| `lib/client.js` | **Build artifact** of `src/client/index.jsx`. Committed on purpose — do not hand-edit. |
| `scripts/build-client.mjs` | Bundles `src/client/index.jsx` into `lib/client.js` with esbuild. Reads the module id from `package.json`. |
| `scripts/simulate-client.mjs` | Loads the built bundle against a stub host and asserts registration, slot injection and CRUD behaviour. |
| `scripts/simulate-primitives.mjs` | Dependency-free stub of `@deepseek-ai/dsh-client-ui-primitives`, so the simulation runs without a DSH install. |
| `scripts/verify-bundle.mjs` | Guards the invariants in "Hard rules" below. |
| `cordis.patch.yml` | The bundle patch that provides the single host-plane row. |

## The edit → verify loop

```bash
# 1. rebuild the browser half after ANY change to src/client/index.jsx
npm run build

# 2. invariants: module id must equal the package name, patch must provide the row
npm run verify

# 3. behaviour: registration, slot injection, role CRUD
npm test

# 4. real app: replace the installed copy and restart DSH
```

`lib/client.js` is committed, and CI rebuilds it and fails if the result differs
from what is committed. **Always run `npm run build` and commit the updated
`lib/client.js` together with your `src/client/index.jsx` change.**

### Installing your working copy into DSH

```bash
dsh plugin add --profile desktop file:/absolute/path/to/dsh-persona-switcher
```

`file:` installs are **copies**, not symlinks. Editing the source again does not
update the installed copy, and re-running `dsh plugin add` on an already
installed dependency reports "up to date" without re-copying. To pick up new
files:

```bash
dsh plugin remove --profile desktop dsh-persona-switcher
dsh plugin add    --profile desktop file:/absolute/path/to/dsh-persona-switcher
```

Then **restart the DSH app** — the client bundle is loaded at boot, so a plain
page reload is not always enough.

## Hard rules

These two invariants are not style preferences; breaking either one takes the
whole web UI down (`web boot: N entry did not activate`, or a failed composite).

1. **The browser module id must equal the resolved package name.**
   `lib/client.js` starts with
   `window.__ModuleLoader__.load({ id: "<name>", ... })`, where `<name>` must be
   `package.json`'s `name` — **not** the row id `persona-switcher` from
   `cordis.patch.yml`. The host keys browser module identity by the resolved
   manifest package name. `scripts/build-client.mjs` reads the name from
   `package.json` and `scripts/verify-bundle.mjs` enforces the match, so this
   should be impossible to break by accident — please don't work around either
   one.
2. **The host row has exactly one source.** It comes from this package's own
   `dsh.bundle.patch` (`cordis.patch.yml`). Never add an `insert:` row for this
   plugin to a profile's own `cordis.patch.yml`; two active loader sources
   resolving to the same package name fail to compose.

Additionally, the settings section id `persona-switcher` is part of the host
contract (it backs the route prefix and the config key). Renaming it silently
breaks existing user configs — don't.

## Adding UI

`src/client/index.jsx` only uses primitives that are known to exist in the
installed `@deepseek-ai/dsh-client-ui-primitives`: `Button`, `SettingsForm`,
`SettingsFormModel`, `SettingsValueField`, `Switch` and `settingsTextField`.
The host injects its own copy of that package, which may be older than the one
you have installed, so a newly added primitive can work locally and break for
users. If you need something new, either keep it inside this bundle or check
what the shipped host version exports first.

Styling goes into the `STYLE_TEXT` stylesheet in the same file. Every selector
is anchored to `.dsh-panel.ps-page` and every class is `ps-`prefixed so the
plugin cannot leak styles into the host UI. Theme values are read from the host
CSS variables with fallbacks — use those rather than hard-coded colours.

## Pull requests

- One topic per PR.
- `npm run build`, `npm run verify` and `npm test` must pass (CI runs all three
  plus a `lib/client.js` staleness check).
- If you touch user-visible behaviour, add a `CHANGELOG.md` entry under
  `## [Unreleased]`.
- Also make sure `cordis.patch.yml` and configuration keys stay
  backward-compatible; if they cannot, say so in the PR description.

## Reporting issues

Use the issue templates. For anything security-related, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
