/**
 * dsh-persona-switcher — mid-session persona switching for DeepSeek Harness.
 *
 * The minimal role switch: only the model's persona (identity + speaking
 * style) changes. Tools, skills, model routing, runtime context and the
 * session's own plugin composition are NEVER part of a role here — a role file
 * carries just `id` / `name` / `description` and the persona prose, and nothing
 * else is touched when it is applied.
 *
 * One role = one markdown file under the role library. At load time this row
 * scans that library and keeps the parsed roles in memory; nothing is
 * registered with the agent-preset registry, so roles never appear in the
 * harness's preset picker next to real compositions.
 *
 * Applying a role registers the deployment persona prefix section —
 * `deployment:persona-prefix`, at the registry's own order for it — through
 * *that agent's* context. The prompt registry documents this as the per-agent
 * override of a global section: a scoped registration belongs to one agent's
 * scope and shadows the global section of that name for that agent alone, which
 * is how the harness's own `dsh-subagent` gives a child its persona. The model
 * then reads the role's prose while every other prompt input, tool, command,
 * skill and model route stays exactly as it was.
 *
 * The previous implementation asked the agent-preset registry to `recompose()`
 * the session instead, which rebinds the agent's whole plugin composition: the
 * agent-plane tool set and command set were replaced along with the identity
 * (measured while switching: 33 model-facing tools and 10 commands became 7 and
 * 7, losing `/compact`, `/goal` and `/plan`). Recomposition is therefore not
 * merely unnecessary here, it is the defect this plugin exists to avoid.
 * `lib/persona-binding.js` owns the scoped-section route, and `npm run verify`
 * refuses a recompose call reappearing in this file.
 *
 * The old persona does not linger: the prompt registry assembles per model step
 * and emits `system-prompt/change`, so the superseded persona text is replaced
 * in the next request's system prompt rather than accumulating beside it. Since
 * some routes append a changed prompt in history instead of replacing it,
 * `announceRoleChange` can add a short in-band notice naming both sides.
 *
 * The only diagnostic surface is the `role_probe` tool (skiable with
 * `exposeTool: false`). It reports the session's system-prompt nodes, the
 * current role binding and the last request header's tool list, and can execute
 * a `/role` command line through the real command pipeline so headless/one-shot
 * runs can exercise the command surface that the Web UI normally drives.
 *
 * @module dsh-persona-switcher
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPersonaBindings } from './persona-binding.js'

/** Cordis plugin name. */
export const name = 'persona-switcher'
/** Load after the surfaces this row drives. `settings` and `agentPresets` are
 * read opportunistically with `ctx.get`, so they are not injections — a surface
 * without them keeps every other feature. `agentPresets` is read for diagnostics
 * only: this plugin never registers a preset with it and never recomposes a
 * session through it, because recomposition replaces the agent's tools too. */
export const inject = ['commands', 'systemPrompt', 'tools']

/** Runtime schema for the row. */
export const Config = z.object({
  rolesDir: z.string().default(''),
  /** Role bound to sessions that start without an explicit role. Volatile: the
   * settings page edits it at runtime through the settings surface, so the
   * change applies without a redeploy and overrides the deployment value. */
  defaultRole: z.string().default('').volatile(),
  /** Whether to register the `role_probe` diagnostic tool. Volatile: the
   * settings page flips this at runtime through the settings surface, so the
   * change applies without a redeploy. */
  exposeTool: z.boolean().default(true).volatile(),
  // Off by default on purpose. The prompt registry assembles per model step and
  // the loop replaces the head system node on a role change, so the superseded
  // persona does not reach the model again and the notice would be redundant
  // weight. It stays available for surfaces or routes that append a changed
  // prompt to history instead of replacing it, where the old persona lingers.
  announceRoleChange: z.boolean().default(false),
  /** URL prefix under which the role library API is served. */
  routePrefix: z.string().default('/persona-switcher')
})

/** The section name carrying the role catalogue in the prompt. */
const NOTE_SECTION = 'persona-switcher:catalogue'
/** Section order: right after the deployment persona suffix (10200). */
const NOTE_ORDER = 10300
/** Source kind stamped on the injected role-change notice. */
const NOTICE_SOURCE = 'persona-switcher'

/**
 * Resolve the role library directory.
 * @param config - the resolved row configuration.
 * @returns an absolute directory path.
 */
function resolveRolesDir(config) {
  if (typeof config.rolesDir === 'string' && config.rolesDir.trim() !== '') return config.rolesDir.trim()
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'roles')
}

/**
 * Validate one role id for creation.
 * @param id - the proposed id.
 * @returns an error message, or undefined when the id is usable.
 */
function validateRoleId(id) {
  if (typeof id !== 'string' || id.trim() === '') return 'the role id must not be empty'
  const value = id.trim()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return 'the role id must be lowercase letters, digits, and dashes, starting with a letter or digit'
  }
  if (value.length > 64) return 'at most 64 characters'
  return undefined
}

/**
 * Locate the on-disk role paths for one id.
 *
 * Mirrors the reader in `scanRoles`: a directory entry with a `ROLE.md` wins
 * over a flat `<id>.md` file. Writers always use the bundle directory form.
 *
 * @param dir - the role library directory.
 * @param id - the role id.
 * @returns the candidate paths.
 */
function rolePaths(dir, id) {
  const bundleDir = join(dir, id)
  return {
    bundleDir,
    bundleFile: join(bundleDir, 'ROLE.md'),
    flatFile: join(dir, `${id}.md`)
  }
}

/**
 * Serialize one role back to its markdown file text.
 * @param role - the parsed role.
 * @returns the file text.
 */
function serializeRole(role) {
  return [
    '---',
    `id: ${role.id}`,
    `name: ${role.name}`,
    `description: ${role.description}`,
    '---',
    '',
    role.persona,
    ''
  ].join('\n')
}

/**
 * Split one role file into its YAML-ish frontmatter lines and its body.
 * @param text - the raw file text.
 * @returns the frontmatter block (empty when absent) and the body.
 */
function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { front: '', body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { front: '', body: normalized }
  const after = normalized.indexOf('\n', end + 1)
  return {
    front: normalized.slice(3, end),
    body: after < 0 ? '' : normalized.slice(after + 1)
  }
}

/**
 * Read one scalar from a frontmatter block, unquoting it.
 * @param front - the frontmatter block.
 * @param key - the key to read.
 * @returns the trimmed value, or undefined when absent.
 */
function scalar(front, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(front)
  if (match === null) return undefined
  let value = match[1].trim()
  if (value === '') return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value
}

/**
 * Parse one role file.
 *
 * Only identity fields are read. Anything the full agent-switching plugin
 * understands (`tools`, `denyTools`, `skillsDir`, `includeRuntimeContext`,
 * `model`) is ignored on purpose: this plugin never restricts capabilities.
 *
 * @param text - the raw file text.
 * @param fallbackId - the id derived from the file name.
 * @returns the parsed role, or undefined when it carries no persona prose.
 */
function parseRole(text, fallbackId) {
  const { front, body } = splitFrontmatter(text)
  const persona = body.trim()
  if (persona === '') return undefined
  const id = (scalar(front, 'id') ?? fallbackId).trim()
  if (id === '') return undefined
  return {
    id,
    name: (scalar(front, 'name') ?? id).trim(),
    description: (scalar(front, 'description') ?? '').trim(),
    persona
  }
}

/**
 * Scan the role library.
 * @param dir - the role library directory.
 * @returns the parsed roles in stable id order, plus any warnings.
 */
async function scanRoles(dir) {
  const warnings = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { roles: [], warnings: [`role library ${dir} is unreadable: ${error?.message ?? String(error)}`] }
  }
  const roles = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let file
    let fallbackId
    if (entry.isDirectory()) {
      file = join(dir, entry.name, 'ROLE.md')
      fallbackId = entry.name
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      file = join(dir, entry.name)
      fallbackId = entry.name.replace(/\.md$/i, '')
    } else {
      continue
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (entry.isDirectory()) continue
      warnings.push(`role file ${file} is unreadable: ${error?.message ?? String(error)}`)
      continue
    }
    const role = parseRole(text, fallbackId)
    if (role === undefined) {
      warnings.push(`role file ${file} has no persona body and was skipped`)
      continue
    }
    roles.push(role)
  }
  const seen = new Set()
  return {
    roles: roles.filter((role) => {
      if (seen.has(role.id)) {
        warnings.push(`duplicate role id "${role.id}" was skipped`)
        return false
      }
      seen.add(role.id)
      return true
    }),
    warnings
  }
}

/**
 * Build the explicit role-change notice.
 *
 * DSH's model route reports `systemPromptUpdate: 'in-history'`, so a changed
 * persona is appended as a second system node instead of replacing the first
 * one: the model keeps reading the superseded persona. This notice is the
 * compensating signal — it names both sides of the change so the model can
 * resolve the conflict in favour of the current role.
 *
 * @param from - the previous role id, or undefined when none was bound.
 * @param role - the role now in force.
 * @returns the notice text, or '' when there is nothing to announce.
 */
function formatNotice(from, role) {
  if (from === undefined || from === role) return ''
  return [
    '<system-reminder>',
    `Role change: this session switched from role "${from}" to role "${role}".`,
    '',
    "The previous role's persona and speaking style are superseded and no longer apply.",
    'Whatever the earlier system text in this conversation said about your identity, follow the current role.',
    '</system-reminder>'
  ].join('\n')
}

/**
 * Register the role library and the prompt catalogue.
 * @param ctx - the row's context (host plane).
 * @param config - the resolved row configuration.
 */
export function apply(ctx, config) {
  const dir = resolveRolesDir(config)
  const logger = ctx.logger ?? console
  /** The settings entry id this row's volatile configuration lives under. */
  const configKey = (ctx.fiber?.entry?.id ?? 'persona-switcher').replace(/^include:/, '')
  /**
   * Read the volatile `exposeTool` flag.
   *
   * The host renders `config.exposeTool` as a `Volatile` wrapper when the
   * settings surface is present; without one the schema falls back to a plain
   * boolean. Both shapes are handled.
   */
  const exposeToolOn = () => {
    const value = config.exposeTool
    return typeof value?.get === 'function' ? (value.get() ?? true) : (value ?? true)
  }
  /**
   * Read the volatile `defaultRole` value.
   *
   * The host renders `config.defaultRole` as a `Volatile` wrapper when the
   * settings surface is present; without one the schema falls back to a plain
   * string. Both shapes are handled.
   */
  const defaultRoleOn = () => {
    const value = config.defaultRole
    return typeof value?.get === 'function' ? (value.get() ?? '') : (value ?? '')
  }
  /** Read the volatile settings entry when the host exposes one. */
  const settings = () => ctx.get('settings')
  /** Live roles, in library order. */
  let catalogue = []
  /** Session id -> a role-change notice awaiting the next model step. */
  const pendingNotices = new Map()

  /**
   * Live per-session role bindings.
   *
   * The deployment persona stays in the harness's global prompt registry, so
   * "no binding" is a real state rather than a gap: a session that was never
   * switched, one switched back with `/role none`, and one whose agent scope
   * has ended all read as unbound here, which is exactly what the roster of a
   * deployment with no `defaultRole` should show.
   */
  const bindings = createPersonaBindings({ warn: (message) => logger.warn(message) })

  /**
   * Scan the role library and publish the parsed roles.
   * @returns the catalogue in library order.
   */
  const sync = async () => {
    const { roles, warnings } = await scanRoles(dir)
    for (const warning of warnings) logger.warn(`[persona-switcher] ${warning}`)
    catalogue = roles
    logger.info(
      `[persona-switcher] role library ${dir}: ${catalogue.length} role(s) — ` +
        `${catalogue.map((role) => role.id).join(', ') || '(none)'}`
    )
    return catalogue
  }

  const findRole = (id) => catalogue.find((role) => role.id === id)

  /**
   * Persist the default role for subsequently created sessions.
   *
   * The default is this row's own volatile `defaultRole` field under the
   * `configKey` settings entry, so the settings page edits the same value
   * through the official configuration-form surface. A surface without a
   * config editor keeps the deployment default instead.
   *
   * @param id - the role id to make default.
   * @returns a short human-readable outcome.
   */
  const persistDefault = async (id) => {
    const settings = ctx.get('settings')
    if (settings === undefined) return 'this deployment has no settings surface; default unchanged'
    try {
      await settings.update(configKey, { defaultRole: id }, undefined)
      return `default for new sessions set to "${id}"`
    } catch (error) {
      return `default unchanged (${error?.message ?? String(error)})`
    }
  }

  /**
   * Read a JSON request body, capped at 1 MiB.
   * @param req - the raw request.
   * @returns the parsed body, or undefined when unreadable.
   */
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > 1024 * 1024) return resolve(undefined)
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })

  /**
   * Send one JSON response.
   * @param res - the raw response.
   * @param status - the HTTP status code.
   * @param payload - the JSON payload.
   */
  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(body)
  }

  /**
   * Handle one role-library API request.
   * @param req - the raw request.
   * @param res - the raw response.
   * @param url - the parsed request URL.
   * @param prefix - the registered route prefix.
   */
  const handleRequest = async (req, res, url, prefix) => {
    const pathname = url.pathname
    const tail = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
    const method = (req.method ?? 'GET').toUpperCase()

    if (tail === 'roles' && method === 'GET') {
      await sync()
      sendJson(res, 200, {
        ok: true,
        roles: catalogue,
        warnings: [],
        // Sessions, not roles, carry a binding now; report how many are live so
        // the client can tell "role library loaded" from "role in force".
        sessionsWithRole: bindings.size
      })
      return
    }

    if (tail === 'role' && method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const role = findRole(id)
      if (role === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown role "${id}"` })
        return
      }
      sendJson(res, 200, { ok: true, role })
      return
    }

    if (tail === 'role' && method === 'POST') {
      const body = await readBody(req)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid or oversized JSON body' })
        return
      }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      const invalid = validateRoleId(id)
      if (invalid !== undefined) {
        sendJson(res, 400, { ok: false, error: invalid })
        return
      }
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : id
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      const persona = typeof body.persona === 'string' ? body.persona.trim() : ''
      if (persona === '') {
        sendJson(res, 400, { ok: false, error: 'the role persona must not be empty' })
        return
      }
      try {
        await mkdir(join(dir, id), { recursive: true })
        await writeFile(join(dir, id, 'ROLE.md'), serializeRole({ id, name, description, persona }), 'utf8')
        await rm(join(dir, `${id}.md`), { force: true })
        await sync()
        sendJson(res, 200, { ok: true, role: { id, name, description, persona } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `write failed: ${error?.message ?? String(error)}` })
      }
      return
    }

    if (tail === 'role' && method === 'DELETE') {
      const id = url.searchParams.get('id') ?? ''
      const role = findRole(id)
      if (role === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown role "${id}"` })
        return
      }
      try {
        const paths = rolePaths(dir, id)
        await rm(paths.bundleFile, { force: true })
        await rm(paths.bundleDir, { recursive: true, force: true })
        await rm(paths.flatFile, { force: true })
        await sync()
        // A deleted default leaves this row's volatile default pointing at
        // nothing; clear it so new sessions fall back to the deployment value.
        const settingsSurface = settings()
        if (defaultRoleOn() === id && settingsSurface !== undefined) {
          try {
            await settingsSurface.mutate(configKey, [{ op: 'unset', path: ['defaultRole'] }])
          } catch {
            // The default slot belongs to the settings surface; a failure to
            // clear it is cosmetic, not fatal to the deletion.
          }
        }
        sendJson(res, 200, { ok: true, deleted: id })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `delete failed: ${error?.message ?? String(error)}` })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: `unknown endpoint ${method} ${tail}` })
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined) return
    scoped.effect(() => {
      const prefix = config.routePrefix.startsWith('/') ? config.routePrefix : `/${config.routePrefix}`
      const normalized = prefix.replace(/\/+$/, '')
      const dispose = webServer.register({
        kind: 'prefix',
        path: normalized,
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          void handleRequest(req, res, url, normalized)
        }
      })
      logger.info(`[persona-switcher] role library API mounted at ${normalized}`)
      return dispose
    }, 'persona-switcher.settings-route')
  })

  // This row owns the `configKey` settings entry, so it declares the
  // namespace as host-edited: the settings surface then exposes its volatile
  // fields (defaultRole, exposeTool) as runtime-editable configuration forms
  // instead of rejecting writes to them as overridden.
  ctx.inject(['settings'], (scoped) => {
    scoped.effect(() => {
      scoped.settings.configure({ auto: false }, ctx.fiber)
    }, 'persona-switcher.settings-configure')
  })

  /**
   * Render the role roster for a human.
   * @param currentId - the role in force, when one is bound.
   * @returns a multi-line listing.
   */
  const renderRoster = (currentId) =>
    catalogue
      .map((role) => {
        const marker = role.id === currentId ? '*' : ' '
        const description = role.description === '' ? '' : ` — ${role.description}`
        return `${marker} ${role.id}${description}`
      })
      .join('\n')

  /**
   * Switch one agent onto a role, or back to the deployment persona.
   *
   * Only the agent's persona input changes: the role's prose is registered as
   * the agent-scoped `deployment:persona-prefix` section, which shadows the
   * deployment persona for this one session. The session's composition — and
   * with it its tools, commands, skills and model route — is never touched, so
   * a switch cannot cost a session anything it already had.
   *
   * @param agent - the owning agent.
   * @param roleId - the requested role id.
   * @returns a small result describing what happened.
   */
  const switchTo = async (agent, roleId) => {
    const role = findRole(roleId)
    if (role === undefined) {
      throw new Error(
        `unknown role "${roleId}"; available: ${catalogue.map((r) => r.id).join(', ') || '(none)'}`
      )
    }
    const { changed, from } = bindings.install(agent, role)
    if (changed && config.announceRoleChange) {
      const text = formatNotice(from, role.id)
      if (text !== '') pendingNotices.set(agent.session.id, { from, to: role.id, text })
    }
    return { role: role.id, changed, from }
  }

  ctx.effect(() => {
    void sync().catch((error) => logger.warn(`[persona-switcher] role library scan failed: ${String(error)}`))
  }, 'persona-switcher.library')

  const handleRoleCommand = async (invocation) => {
    const agent = invocation.agent
    if (agent === undefined) return { kind: 'error', text: 'The role command requires a session.' }

    const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const newline = raw.indexOf('\n')
    const headLine = newline < 0 ? raw : raw.slice(0, newline)
    const [verb, ...rest] = headLine.split(/\s+/).filter((word) => word !== '')

    await sync()
    if (catalogue.length === 0) {
      return { kind: 'error', text: `The role library at ${dir} holds no roles yet.` }
    }

    const currentRole = () => bindings.roleOf(agent)
    const defaultId = defaultRoleOn() === '' ? null : defaultRoleOn()

    const overview = () => {
      const current = currentRole()
      const lines = [
        `current session role: ${current ?? '(none bound — this session runs on the deployment persona)'}`,
        `default for new sessions: ${defaultId}`,
        '',
        `roles (${catalogue.length}):`,
        renderRoster(current)
      ]
      return lines.join('\n')
    }

    try {
      if (verb === undefined || verb === '') return { kind: 'success', text: overview() }

      if (verb === 'none' || verb === 'off') {
        const cleared = bindings.clear(agent)
        return {
          kind: 'success',
          text:
            (cleared.changed
              ? `Role "${cleared.from}" removed; this session runs on the deployment persona again.`
              : 'This session already runs on the deployment persona.') + `\n\n${overview()}`
        }
      }

      if (verb === 'list') {
        return { kind: 'success', text: `roles (${catalogue.length}):\n${renderRoster(currentRole())}` }
      }

      if (verb === 'default') {
        const id = rest[0]
        if (id === undefined) return { kind: 'error', text: `Usage: /role default <id>\n\n${renderRoster(defaultId)}` }
        if (findRole(id) === undefined) {
          return { kind: 'error', text: `Unknown role "${id}".\n\n${renderRoster(currentRole())}` }
        }
        const outcome = await persistDefault(id)
        return { kind: 'success', text: outcome }
      }

      const target = findRole(verb)
      if (target === undefined) {
        return { kind: 'error', text: `Unknown role "${verb}".\n\n${renderRoster(currentRole())}` }
      }
      const result = await switchTo(agent, target.id)
      const headline = result.changed
        ? `Switched this session from "${result.from ?? '(none)'}" to "${target.id}" (${target.name}).`
        : `This session already runs as "${target.id}" (${target.name}).`
      return { kind: 'success', text: `${headline}\n\n${overview()}` }
    } catch (error) {
      return { kind: 'error', text: `Role switch failed: ${error?.message ?? String(error)}` }
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'role',
      description:
        'Switch the model persona for this session (only the persona changes), or set the default for new sessions',
      input: { hint: '[<id>|list|default <id>|none]' },
      handler: handleRoleCommand
    })
  }, 'persona-switcher.command')

  // Two responsibilities ride the same pre-step seam, in this order:
  //
  // 1. Default binding. The library is scanned lazily and the default is
  //    installed as this agent's scoped persona section before the first step,
  //    so a new session starts on the configured role without anyone typing
  //    `/role` — and without the harness having to know roles exist.
  // 2. The role-change notice. It is injected through `decision.messages`, the
  //    same channel `dsh-tool-skill` and `dsh-agent-instructions` use, so it is
  //    an ordinary durable user message in the log rather than forged state.
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages }, next) => {
      const defaultRole = defaultRoleOn()
      // Root sessions only: a delegated child inherits its parent's prompt and
      // its own scope, so binding one there would fight the parent's identity.
      const delegated = typeof agent.depth === 'number' && agent.depth > 0
      if (defaultRole !== '' && !delegated && bindings.roleOf(agent) === undefined) {
        try {
          await sync()
          if (catalogue.some((role) => role.id === defaultRole)) {
            await switchTo(agent, defaultRole)
          }
        } catch (error) {
          logger.warn(`[persona-switcher] default role "${defaultRole}" could not be bound: ${String(error)}`)
        }
      }

      const decision = await next()

      const pending = pendingNotices.get(agent.session.id)
      if (pending === undefined) return decision
      pendingNotices.delete(agent.session.id)
      if (decision.kind === 'reject') return decision
      if (decision.messages.some((message) => message.source?.kind === NOTICE_SOURCE)) return decision

      // The notice travels as a user message so it stays a first-class, durable
      // log entry.
      const notice = {
        role: 'user',
        content: [{ type: 'text', text: pending.text }],
        source: { kind: NOTICE_SOURCE, form: 'role-change', from: pending.from ?? '', to: pending.to },
        id: randomUUID()
      }
      const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message))
      return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, notice) }
    },
    { global: true }
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: NOTE_SECTION,
        order: NOTE_ORDER,
        text: () => {
          if (catalogue.length === 0) return ''
          const table = catalogue
            .map((role) => `- ${role.id}: ${role.name}${role.description === '' ? '' : ` — ${role.description}`}`)
            .join('\n')
          return `Available model roles (switch with the /role command):\n${table}`
        }
      }),
    'persona-switcher.catalogue'
  )

  if (exposeToolOn()) {
    ctx.tools.register(
      defineTool({
        name: 'role_probe',
        description:
          'Diagnostic: report the session system-prompt nodes and the current role binding. Pass a slash ' +
          'command line (for example "/role list") to execute it as a human would.',
        parameters: {
          command: { type: 'string', description: 'Optional slash-command line to execute, e.g. "/role list".' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              report: { type: 'string', required: true }
            }
          },
          render: (_args, value) => [{ type: 'text', text: value.report }]
        },
        async execute(args, exec) {
          const session = exec.agent?.session
          if (session === undefined) throw new Error('role_probe requires an owning agent session')
          const nodes = []
          for (const seq of session.surface.nodes) {
            const event = session.eventAt(seq)
            if (event?.type !== 'system/message') continue
            const blocks = event.data?.message?.content ?? []
            const text = blocks.map((block) => (block?.type === 'text' ? (block.text ?? '') : '')).join('')
            nodes.push(`seq ${seq}: ${text.length} chars op=${JSON.stringify(event.surfaceOp)}`)
          }
          const bound = bindings.roleOf(exec.agent)
          // The composition is reported as evidence, not as plumbing: a switch
          // must leave the session's preset exactly where it was.
          let composition
          try {
            composition = JSON.stringify(ctx.get('agentPresets')?.composedPreset?.(exec.agent.ctx) ?? null)
          } catch (error) {
            composition = `unavailable (${error?.message ?? String(error)})`
          }
          const lines = [
            `role bound: ${JSON.stringify(bound ?? null)}`,
            `deployment persona in force: ${bound === undefined ? 'yes' : 'no (shadowed for this session)'}`,
            `default role: ${JSON.stringify(defaultRoleOn() === '' ? null : defaultRoleOn())}`,
            `registered commands: ${JSON.stringify([...ctx.commands.view(exec.agent).keys()].sort())}`,
            `agent composition preset: ${composition}`,
            `surface nodes: ${session.surface.nodes.length}`,
            `system nodes:`,
            ...nodes.map((line) => `  ${line}`),
            `contentGeneration: ${session.surface.contentGeneration}`
          ]

          try {
            // The authoritative answer to "what may the model call" is the
            // request header the loop actually sent, not the registry view:
            // the view is computed for this probe's own reading scope, while
            // the header is what went on the wire. Report the header.
            const header = session.requestHeader?.()
            const sent = (header?.tools ?? []).map((tool) => tool.name).sort()
            lines.push(
              'a role carries no tools; the line below is what this session kept across any switch',
              sent.length > 0
                ? `model-facing tools (${sent.length}) from the last request header: ${JSON.stringify(sent)}`
                : 'model-facing tools: no request/header recorded yet'
            )
          } catch (error) {
            lines.push(`tool report failed: ${error?.message ?? String(error)}`)
          }

          const line = typeof args?.command === 'string' ? args.command.trim() : ''
          if (line !== '') {
            try {
              const controller = new AbortController()
              const settled = await ctx.commands.execute(exec.agent, line, [], controller.signal)
              lines.push(
                '',
                `command ${JSON.stringify(line)}:`,
                settled === undefined
                  ? '  unresolved (unknown name or syntax)'
                  : `  kind=${settled.result.kind}\n  text=${settled.result.text ?? '(none)'}`
              )
            } catch (error) {
              lines.push('', `command ${JSON.stringify(line)} threw: ${error?.message ?? String(error)}`)
            }
          }

          return { report: lines.join('\n') }
        }
      })
    )
  }

  logger.info(`[persona-switcher] mounted; role library resolved to ${dir}`)
}