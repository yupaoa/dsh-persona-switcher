# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting flow instead:
[Security → Report a vulnerability](https://github.com/yupaoa/dsh-persona-switcher/security/advisories/new).

You can expect an initial response within a few days. Please include:

- affected version (`npm ls dsh-persona-switcher` or the installed commit),
- DSH version (`dsh --version`),
- a minimal reproduction,
- the impact you believe it has.

## What this plugin does on your machine

Worth knowing before you install it:

- **It reads and writes files under the role library** (`<rolesDir>`, default
  `$DSH_HOME/roles`): it lists role directories and creates, updates and deletes
  `ROLE.md` files there when you use the settings page. It does not read or
  write anything else.
- **It registers an HTTP route on the DSH loopback server** (prefix
  `/persona-switcher`) for the settings page. The route is served by the host
  on the same loopback interface and port as the rest of the DSH web UI, so it
  inherits the host's authentication. Do not expose the DSH web server to an
  untrusted network.
- **Persona text goes into the system prompt** of your sessions. Anything you
  put in a `ROLE.md` body will be sent to whichever model provider the session
  uses. Don't put secrets or credentials in persona files.
- **No telemetry.** The plugin makes no outbound network requests of its own.

## Supported versions

The latest published `0.x` release receives fixes. Older releases are not
patched.
