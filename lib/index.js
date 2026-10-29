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
 * Applying a role registers a prompt section of this plugin's own —
 * `persona-switcher:persona`, placed right after the deployment persona prefix
 * — through *that agent's* context. The section is scoped to that one agent, so
 * the model reads the role's prose while every other prompt input, tool,
 * command, skill and model route stays exactly as it was, and the deployment's
 * own persona prefix (`You are a coding agent powered by the {{model}} model.`)
 * is left untouched: switching a role adds prose beside that line, never
 * instead of it. `/role none` therefore leaves an empty persona, not an empty
 * identity.
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
 * The old persona does not linger in the prompt: the prompt registry assembles
 * per model step and emits `system-prompt/change`, so the superseded persona
 * text is replaced in the next request's system prompt rather than accumulating
 * beside it. That alone does not move the model off the old voice, because its
 * own earlier turns keep demonstrating it, so `announceRoleChange` (on by
 * default) also injects a short in-band notice naming both sides.
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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute as isAbsolutePath, join, relative as relativePath, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPersonaBindings } from './persona-binding.js'
import { NO_ROLE, createSessionState, planRestore } from './session-state.js'

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
  /** Whether to inject a short in-band notice naming both sides of a role
   * change, so the model stops speaking in the superseded persona.
   *
   * On by default, because swapping the prompt is necessary but not sufficient.
   * Measured on a session that switched whale-girl -> amiya: the next step's
   * system prompt already carried only the new persona (zero occurrences of the
   * old persona prose), and the reply still came back in the old voice — the
   * transcript's own earlier assistant turns anchor the style harder than a
   * system prefix does. The notice is the in-band contradiction that resolves
   * that conflict in favour of the current role. Turn it off only where the
   * prompt swap alone is trusted and the extra message is unwanted weight. */
  announceRoleChange: z.boolean().default(true),
  /** URL prefix under which the role library API is served. */
  routePrefix: z.string().default('/persona-switcher')
})

/** The section name carrying the role catalogue in the prompt. */
const NOTE_SECTION = 'persona-switcher:catalogue'
/** Section order: right after the deployment persona suffix (10200). */
const NOTE_ORDER = 10300
/** Source kind stamped on the injected role-change notice. */
const NOTICE_SOURCE = 'persona-switcher'
/** Largest mascot artwork accepted on upload, in decoded bytes. */
const MASCOT_MAX_BYTES = 1024 * 1024
/** Largest mascot upload body, in JSON bytes (base64 inflates by ~4/3). */
const MASCOT_MAX_BODY_BYTES = 2 * 1024 * 1024
/** Uploads per role, oldest pruned first. */
const MASCOT_MAX_VERSIONS = 3
/** Artwork narrower or shorter than this is not artwork. */
const MASCOT_MIN_EDGE = 8
/** Artwork larger than this on either edge is refused, keeping layout sane. */
const MASCOT_MAX_EDGE = 4096
/** Media type by file extension, for the bytes this plugin writes itself. */
const MASCOT_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp']
])

/**
 * Resolve the DSH home directory.
 * @returns an absolute directory path.
 */
function dshHome() {
  // `??` only guards null/undefined: an empty DSH_HOME would sail through and make
  // every path relative to the process's working directory, scattering
  // `persona-switcher/` inside the app install. A blank value means "not set".
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/**
 * Resolve the role library directory.
 * @param config - the resolved row configuration.
 * @returns an absolute directory path.
 */
function resolveRolesDir(config) {
  if (typeof config.rolesDir === 'string' && config.rolesDir.trim() !== '') return config.rolesDir.trim()
  return join(dshHome(), 'roles')
}

/**
 * Resolve the durable session-state file.
 *
 * It lives beside the library rather than inside it, so scanning the library
 * never has to skip a file that is not a role.
 * @returns an absolute file path.
 */
function resolveStateFile() {
  return join(dshHome(), 'persona-switcher', 'sessions.json')
}

/**
 * Resolve the mascot artwork directory.
 *
 * It lives inside this plugin's own data directory, beside the session memory,
 * and deliberately NOT inside the role library: `scanRoles` treats every entry
 * of that directory as a candidate role file, so artwork stored there would be
 * scanned on every catalogue refresh. One role keeps at most a few files —
 * `<roleId>-<stamp>.<ext>`, pruned oldest first — and `mascot-map.json` names
 * the newest one per role.
 *
 * @returns an absolute directory path.
 */
function resolveMascotDir() {
  return join(dshHome(), 'persona-switcher', 'mascot')
}

/**
 * Resolve the role -> artwork map file.
 * @returns an absolute file path.
 */
function resolveMascotMapFile() {
  return join(dshHome(), 'persona-switcher', 'mascot-map.json')
}

/**
 * Is this string usable as ONE path segment?
 *
 * Role ids and stored file names both travel into `join(...)`, and both can
 * originate from a file a person can edit or from a request. A separator or a
 * parent reference must never get that far: `id: ../..` in a stray role file
 * once reached a `rm(..., { recursive: true })` aimed at the role library.
 *
 * @param value - the candidate segment.
 * @returns true when it is safe to join onto a directory.
 */
function isSafeSegment(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || trimmed !== value) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (trimmed.includes('..')) return false
  // A Windows drive-relative or stream name is not a single segment either.
  if (trimmed.includes(':')) return false
  if (/[\u0000-\u001f]/.test(trimmed)) return false
  return true
}

/**
 * Resolve a path inside a directory, refusing anything that escapes it.
 *
 * The string checks above are the first line; this is the second, so the guard
 * survives any future change that starts decoding a request path earlier.
 *
 * @param base - the directory the path must stay inside.
 * @param segment - the single segment to resolve.
 * @returns the absolute path, or undefined when it would leave `base`.
 */
function resolveInside(base, segment) {
  if (!isSafeSegment(segment)) return undefined
  const root = resolve(base)
  const target = resolve(root, segment)
  const relative = relativePath(root, target)
  if (relative === '' || relative.startsWith('..') || isAbsolutePath(relative)) return undefined
  return target
}

/**
 * Module-level warning sink.
 *
 * `mascotEntryOf` runs while the map is being read, which happens from inside
 * `apply` but OUTSIDE its scope — the row's own `logger` binding does not reach a
 * top-level function. Reporting a dropped map entry needs a sink that does.
 */
let mascotLogger = console

/**
 * Read one mascot artwork entry from a parsed map.
 * @param map - the parsed map file.
 * @param id - the role id.
 * @returns the entry, or undefined when this role has no usable one.
 */
function mascotEntryOf(map, id) {
  if (typeof map !== 'object' || map === null) return undefined
  if (!isSafeSegment(id)) return undefined
  const entry = map[id]
  if (typeof entry !== 'object' || entry === null) return undefined
  const image = typeof entry.image === 'string' ? entry.image.trim() : ''
  if (image === '') return undefined
  // The map is a file on disk, so it is not trusted more than the request body:
  // every accepted name is one this plugin wrote (a single path segment), so a
  // separator or a parent reference means the file was edited by hand and the
  // entry is dropped rather than resolved against the artwork directory.
  if (!isSafeSegment(image)) return undefined
  // `image` is copied rather than handed out by reference: the map is held in
  // memory and every reply is built from it, so a caller that mutated what it
  // received — a route assembling a response, say — would silently change the
  // map for every later request in the same process.
  //
  // The box is normalized here, at the one place a map entry becomes a value the
  // rest of the plugin uses. A hand-edited `"box": "9999x9999"` (or `"0008x8"`,
  // which the pattern accepts) would otherwise be dropped silently further down
  // and read as "this role has no artwork" — indistinguishable from a missing
  // file, which is exactly the kind of edit that must not look ignored.
  const box = mascotBoxText(entry.box)
  if (box === undefined) {
    mascotLogger.warn(
      `[persona-switcher] mascot-map.json entry "${id}" has unusable box ${JSON.stringify(entry.box)}; ` +
        `expected WxH within ${MASCOT_MIN_EDGE}..${MASCOT_MAX_EDGE} — that role shows no mascot`
    )
    return undefined
  }
  return { image, box }
}

/**
 * Normalize one `WxH` box string.
 * @param box - the candidate value.
 * @returns the canonical `WxH` text, or undefined when unusable.
 */
function mascotBoxText(box) {
  if (typeof box !== 'string') return undefined
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(box.trim())
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < MASCOT_MIN_EDGE || height < MASCOT_MIN_EDGE) return undefined
  if (width > MASCOT_MAX_EDGE || height > MASCOT_MAX_EDGE) return undefined
  return `${width}x${height}`
}

/**
 * The artwork bound to one role, or null.
 *
 * This is the single source of truth for "does this role have a mascot": the
 * settings-page thumbnail and the on-screen mascot both read it, so the two can
 * never disagree. An entry whose box is missing or malformed counts as unbound
 * rather than as a mascot of unknown size — the same rule the client applies,
 * decided here once.
 *
 * @param map - the parsed map file.
 * @param id - the role id.
 * @returns `{ image, box }` with a usable route URL, or null.
 */
function mascotArtOf(map, id) {
  const entry = mascotEntryOf(map, id)
  if (entry === undefined) return null
  return { image: mascotUrlOf(entry.image), box: entry.box }
}

/**
 * Build the URL one artwork file is served under.
 *
 * The file name is a path segment of its own rather than an argument of
 * `/mascot`, because that route's `role` query answers a different question.
 * Keeping them apart means the read path has exactly one shape to match and no
 * route can be reached by accident.
 *
 * The prefix is the one the routes were actually MOUNTED under, never a literal:
 * `routePrefix` is configuration, and a build that answered `mascot.image` with
 * a hardcoded `/persona-switcher/...` served every thumbnail as a 404 the moment
 * anybody changed it.
 *
 * @param file - the stored file name (already validated).
 * @returns the URL path, relative to the deployment origin.
 */
function mascotUrlOf(file) {
  return `${routePrefixOf()}mascot-file/${file}`
}

/** The mounted route prefix, normalized to `/<name>` with no trailing slash. */
let mountedPrefix = '/persona-switcher'

/**
 * Normalize a configured route prefix, or reject it.
 *
 * An empty or `/` prefix is refused rather than trimmed to nothing. The Host's
 * webserver matches a prefix route with `pathname.startsWith(prefix + '/')`, so
 * an empty prefix makes this plugin's handler run for EVERY request the app does
 * not otherwise claim — every asset, every SPA route — answering 404 JSON and
 * shadowing the app's own fallback. One bad config value must not be able to do
 * that, so an unusable prefix means "mount nothing" and a warning.
 *
 * @param raw - the configured prefix.
 * @returns the normalized prefix, or undefined when it must not be mounted.
 */
function normalizeRoutePrefix(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return undefined
  const withSlash = text.startsWith('/') ? text : `/${text}`
  const trimmed = withSlash.replace(/\/+$/, '')
  // `/` alone trims to '', which is the empty-prefix case above.
  if (trimmed === '') return undefined
  // One segment: the plugin owns a namespace, not a subtree of the app.
  if (trimmed.slice(1).includes('/')) return undefined
  return trimmed
}

/** The mounted prefix with its trailing slash, for building URLs. */
function routePrefixOf() {
  return `${mountedPrefix}/`
}

/**
 * Identify the media type of image bytes by their magic number.
 *
 * The upload's own `data:` prefix is not trusted on its own: the type is taken
 * from the bytes, so a file whose extension says `png` while its content says
 * otherwise is still stored and served as what it actually is.
 *
 * @param bytes - the decoded upload.
 * @returns the media type and extension, or undefined when it is not an image
 * this plugin accepts.
 */
function mascotImageOf(bytes) {
  if (bytes.length < 12) return undefined
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { type: 'image/png', ext: 'png' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: 'image/jpeg', ext: 'jpg' }
  }
  if (
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { type: 'image/webp', ext: 'webp' }
  }
  return undefined
}

/**
 * Decode one `data:image/...;base64,...` upload.
 * @param value - the request field.
 * @returns the bytes and their identified type, or undefined when unusable.
 */
function decodeMascotUpload(value) {
  if (typeof value !== 'string') return undefined
  const match = /^data:([\w.+-]+\/[\w.+-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (match === null) return undefined
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.length > MASCOT_MAX_BYTES) return undefined
  const image = mascotImageOf(bytes)
  if (image === undefined) return undefined
  return { bytes, type: image.type, ext: image.ext }
}

/**
 * Delete the artwork files of one role, keeping at most `keep` of the newest.
 *
 * Uploads never overwrite: each one writes a new stamped file, so the browser
 * can cache artwork by URL forever. That leaves the previous files behind, and
 * they are removed here — newest first — so one role costs a bounded amount of
 * disk instead of growing with every re-import.
 *
 * @param id - the role id.
 * @param keep - how many files to keep, newest first.
 * @param bound - one file name that must survive, or ''.
 */
async function pruneMascotFiles(id, keep, bound = '') {
  // The prefix match below decides what gets DELETED, so the id must be one
  // segment: an id of `..` would match every `..-*.png` in the artwork
  // directory, and a separator would reach outside it. Both are reachable from a
  // hand-written role file, so this is a guard, not a formality.
  const prefix = `${id}-`
  if (!isSafeSegment(id) || !isSafeSegment(prefix)) return
  let entries
  try {
    entries = await readdir(resolveMascotDir(), { withFileTypes: true })
  } catch {
    return
  }
  const mine = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.startsWith(prefix)) continue
    const ext = (entry.name.split('.').pop() ?? '').toLowerCase()
    if (!MASCOT_TYPES.has(ext)) continue
    const target = resolveInside(resolveMascotDir(), entry.name)
    if (target === undefined) continue
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) continue
    mine.push({ name: entry.name, at: info.mtimeMs, path: target })
  }
  mine.sort((a, b) => b.at - a.at)
  const doomed = []
  let kept = bound === '' ? 0 : 1
  for (const file of mine) {
    if (file.name === bound) continue
    if (kept < keep) {
      kept += 1
      continue
    }
    doomed.push(file.path)
  }
  for (const target of doomed) {
    await rm(target, { force: true })
  }
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
 * Either side may be the deployment persona (`null`), which is a real state
 * rather than a gap: `/role none` dismisses a role on purpose. That direction
 * needs the notice at least as much as a role-to-role switch does, because the
 * conversation's own earlier replies keep demonstrating the discarded persona.
 *
 * @param from - the role id that was in force, or null for the deployment persona.
 * @param to - the role id now in force, or null for the deployment persona.
 * @returns the notice text, or '' when the persona did not actually change.
 */
function formatNotice(from, to) {
  if (from === to) return ''
  const closing = 'Your next reply already belongs to the persona named here, not to the discarded one.'
  if (to === null) {
    return [
      '<system-reminder>',
      `Role change: this session switched from role "${from}" back to the deployment persona — no role is bound to it any more.`,
      '',
      `The persona, the tone and the verbal habits of role "${from}" are superseded and no longer apply.`,
      'Do not keep imitating the earlier replies of this conversation: they were written as that role, and they are not a style guide.',
      closing,
      '</system-reminder>'
    ].join('\n')
  }
  if (from === null) {
    return [
      '<system-reminder>',
      `Role change: this session switched from the deployment persona to role "${to}".`,
      '',
      'The persona and speaking style in force until now are superseded and no longer apply.',
      'Whatever the earlier system text in this conversation said about your identity, follow the current role.',
      closing,
      '</system-reminder>'
    ].join('\n')
  }
  return [
    '<system-reminder>',
    `Role change: this session switched from role "${from}" to role "${to}".`,
    '',
    "The previous role's persona and speaking style are superseded and no longer apply.",
    'Whatever the earlier system text in this conversation said about your identity, follow the current role.',
    closing,
    '</system-reminder>'
  ].join('\n')
}

/**
 * Register the role library and the prompt catalogue.
 * @param ctx - the row's context (host plane).
 * @param config - the resolved row configuration.
 */
export function apply(ctx, config) {  const dir = resolveRolesDir(config)
  const logger = ctx.logger ?? console
  // Point the module-level sink at this row's logger, so a map entry dropped
  // during the load below is reported through the same channel as everything else.
  mascotLogger = logger
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
   * Durable memory of per-session role choices.
   *
   * A binding lives in one agent scope, and the harness tears that scope down
   * with the agent: without this file a DSH restart would silently drop every
   * switch. The choice is recorded on every switch and re-applied on the
   * session's next model step, which is what makes a persona survive a restart.
   */
  const state = createSessionState({
    file: resolveStateFile(),
    warn: (message) => logger.warn(`[persona-switcher] ${message}`)
  })
  /** Resolves once the memory has been read; the restore step awaits it. */
  const stateReady = state.load().catch((error) => {
    logger.warn(`[persona-switcher] session state could not be read: ${String(error)}`)
  })

  /**
   * Role id -> artwork, as last read from `mascot-map.json`.
   *
   * Held in memory like the role catalogue: the file is read once at load and
   * rewritten whenever an upload or a clear changes it, so serving artwork
   * never touches the map file.
   */
  let mascotMap = {}
  /** Identity of the map file as it was last read: `mtimeMs:size`, or ''. */
  let mascotMapStamp = ''

  /**
   * A counter for "something the mascot cares about has changed".
   *
   * The browser cannot be TOLD about a change: `/role` rebinding a session
   * happens inside this process and nothing is broadcast to the web client, so
   * the on-screen mascot has no signal to listen for. Polling is therefore the
   * only option — and polling `GET /session` on a short cycle would drag the
   * role's full prose along every time. This counter is what makes a fast poll
   * cheap: the browser asks for one number, and only fetches the role when the
   * number moves.
   *
   * Bumped in exactly two places, the two things the mascot draws from: a
   * session's role binding, and the artwork map.
   */
  let revision = 1
  const bumpRevision = () => {
    revision += 1
  }

  /**
   * Read the artwork map from disk.
   *
   * A missing file is the normal state — no role has a mascot yet — so it is
   * not a warning. A malformed one is reported and treated as empty, which
   * hides every mascot until the next successful upload rather than failing a
   * request.
   */
  const reloadMascotMap = async () => {
    const file = resolveMascotMapFile()
    const previous = mascotMap
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn(`[persona-switcher] mascot map ${file} is unreadable: ${String(error)}`)
      }
      mascotMap = {}
      mascotMapStamp = ''
      return JSON.stringify(previous) !== '{}'
    }
    try {
      const parsed = JSON.parse(text)
      mascotMap = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      logger.warn(`[persona-switcher] mascot map ${file} is not JSON: ${String(error)}`)
      mascotMap = {}
    }
    const info = await stat(file).catch(() => undefined)
    mascotMapStamp = info === undefined ? '' : `${info.mtimeMs}:${info.size}`
    // "Did the value change" is answered by comparing content, not by the stamp:
    // a reader that refreshes the stamp itself would otherwise make the next
    // comparison match and hide a hand edit — "I changed the file and nothing
    // happened", the one failure this file must not have.
    return JSON.stringify(previous) !== JSON.stringify(mascotMap)
  }

  /**
   * Re-read the map when the file changed underneath this process.
   *
   * The map is held in memory so serving artwork never touches it, but it is
   * also a plain JSON file a person can edit — to bind artwork by hand, or to
   * unbind one whose box no longer fits. Without this check such an edit would
   * be invisible until a restart, which reads as the edit having been ignored.
   * The comparison is one `stat`, so the common path stays cheap; a stat that
   * fails treats the file as absent, which is the right answer either way.
   */
  const refreshMascotMap = async () => {
    const info = await stat(resolveMascotMapFile()).catch(() => undefined)
    const stamp = info === undefined ? '' : `${info.mtimeMs}:${info.size}`
    if (stamp === mascotMapStamp) return
    // A hand-edited map changes what the mascot should draw, and it reaches this
    // process through the file rather than through an upload. A content change
    // is what the browser has to hear about; a touch is not.
    if (await reloadMascotMap()) bumpRevision()
  }

  /**
   * Store the artwork map so a reader never sees a half-written file, and so
   * two writers cannot clobber each other.
   *
   * The previous version wrote straight to the map file. Two concurrent writes
   * (two tabs importing artwork, an import racing a clear) truncated the same
   * path, and the loser's `200` response was a lie: its entry was gone. A torn
   * file is worse still — the loader degrades a broken map to "empty", so every
   * role would lose its mascot at once. Writes are therefore serialized on one
   * chain and land through a unique temp file + rename, and the destination is
   * removed first because Windows `rename` does not replace an existing file.
   */
  let mapWrite = Promise.resolve()
  const persistMascotMap = () => {
    mapWrite = mapWrite.then(async () => {
      const file = resolveMascotMapFile()
      const temporary = `${file}.${randomUUID()}.tmp`
      await mkdir(dirname(file), { recursive: true })
      try {
        await writeFile(temporary, `${JSON.stringify(mascotMap, null, 2)}\n`, 'utf8')
        await rm(file, { force: true })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      // Importing or clearing artwork changes what the mascot draws.
      bumpRevision()
    })
    return mapWrite
  }

  /** The artwork bound to one role, or null. Single source of truth. */
  const mascotFor = (id) => mascotArtOf(mascotMap, id)

  /** Resolves once the artwork map has been read. */
  const mascotReady = reloadMascotMap()

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

  /** Roles are published by the first successful scan; see `roleFor`. */
  let libraryScanned = false
  /** Resolves once that first scan has settled, however it went. */
  let libraryReady = Promise.resolve()

  const findRole = (id) => catalogue.find((role) => role.id === id)

  /**
   * Look a role up, waiting out the initial scan when it is still running.
   *
   * The library is scanned asynchronously while the row loads, so for a moment
   * after start-up the catalogue is legitimately empty. A symptom of that — a
   * role that is on disk reported as unknown — is indistinguishable from a real
   * miss at the call site, and it was reachable in practice: an HTTP request that
   * arrives before the scan finishes is told "unknown role" for a role the
   * library holds. Reads paper over it by rescanning; the write routes have no
   * such step, so they wait for the first scan when it is still in flight.
   *
   * @param id - the role id.
   * @returns the role, or undefined when the library has no such role.
   */
  const roleFor = async (id) => {
    const first = findRole(id)
    if (first !== undefined || libraryScanned) return first
    await libraryReady
    return findRole(id)
  }

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
   * Read a JSON request body.
   *
   * @param req - the raw request.
   * @param limit - the byte ceiling; 1 MiB by default. Artwork uploads carry
   * base64 in a JSON field, so they raise it rather than switching to a
   * multipart parser this plugin has no other use for.
   * @returns the parsed body, or undefined when unreadable.
   */
  const readBody = (req, limit = 1024 * 1024) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > limit) return resolve(undefined)
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
    if (res.writableEnded === true) return
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
      // The map is re-read on every catalogue request rather than compared by
      // timestamp: file timestamps are coarse enough that an edit made in the
      // same millisecond as the previous read goes unnoticed, and "I changed the
      // file and nothing happened" is the one failure this file must not have.
      // It is a few hundred bytes on the path that already rescans the library.
      await reloadMascotMap()
      sendJson(res, 200, {
        ok: true,
        // Each row carries its artwork in the same response, so the browser
        // learns "who has a mascot, and how big is it" in one request instead of
        // probing every role. `null` is the whole contract: the client never
        // parses a file name or decides whether a box is usable by itself.
        roles: catalogue.map((role) => ({ ...role, mascot: mascotFor(role.id) })),
        warnings: [],
        // Sessions, not roles, carry a binding now; report how many are live so
        // the client can tell "role library loaded" from "role in force".
        sessionsWithRole: bindings.size
      })
      return
    }

    if (tail === 'role' && method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      // `roleFor`, not `findRole`: a read that lands while the first library
      // scan is still running must wait for it, or it reports a role that IS on
      // disk as unknown. Every other route taking a role id already did this.
      const role = await roleFor(id)
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
      const role = await roleFor(id)
      if (role === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown role "${id}"` })
        return
      }
      // The catalogue is built from files a person can place by hand, and this
      // route DELETES RECURSIVELY. A role file declaring `id: ../..` would
      // otherwise aim that removal at the role library's parent. A catalogue id
      // is therefore re-validated here before it is ever joined onto a path.
      if (!isSafeSegment(id)) {
        logger.warn(`[persona-switcher] refusing to delete role ${JSON.stringify(id)}: unusable id`)
        sendJson(res, 400, { ok: false, error: 'that role id cannot be used as a path' })
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

    /* MASCOT-ROUTES */
    if (tail === 'revision' && method === 'GET') {
      // The cheap question the on-screen mascot polls: "has anything I draw
      // changed?" One integer, no disk read, no await. It exists because a
      // `/role` switch cannot be pushed to the browser (nothing is broadcast),
      // and polling the role itself would carry the role's whole prose on every
      // cycle. A 404 here is how an older build of this plugin is detected: the
      // browser then falls back to its slow poll.
      sendJson(res, 200, { ok: true, revision })
      return
    }

    if (tail === 'session' && method === 'GET') {
      const id = url.searchParams.get('session') ?? ''
      await stateReady
      await mascotReady
      // Both "switched back to the deployment persona" (`NO_ROLE`) and "this
      // plugin remembers nothing about that session" read as no role, which is
      // exactly the display rule: a mascot needs a role, not merely a session.
      // The explicit `?? null` matters: `JSON.stringify` drops `undefined`
      // values, so a bare `state.get(...)` would answer `{}` here and the
      // browser would read `undefined` where it expects `null`.
      const roleId = id === '' ? null : (state.get(id) ?? null)
      // Two different questions, kept apart on purpose. `roleId` is the memory
      // (what outlives the agent); `liveRoleId` is the role in force right now,
      // which is what the browser's `/role` picker ticks. They can disagree — a
      // session that inherited the configured default carries a role its memory
      // never recorded — so the picker reads the binding, not the memory.
      const liveRoleId = bindings.roleIdOfSession(id) ?? null
      sendJson(res, 200, { ok: true, roleId, liveRoleId })
      return
    }

    if (tail === 'mascot' && method === 'POST') {
      const id = url.searchParams.get('role') ?? ''
      const role = await roleFor(id)
      if (role === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown role "${id}"` })
        return
      }
      const body = await readBody(req, MASCOT_MAX_BODY_BYTES)
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid or oversized JSON body' })
        return
      }
      const image = decodeMascotUpload(body.image)
      if (image === undefined) {
        sendJson(res, 400, { ok: false, error: 'the artwork must be a png, jpeg or webp data URL within the size limit' })
        return
      }
      const box = mascotBoxText(body.box)
      if (box === undefined) {
        sendJson(res, 400, { ok: false, error: `box must be "WxH" within ${MASCOT_MIN_EDGE}..${MASCOT_MAX_EDGE}` })
        return
      }
      try {
        await mascotReady
        const stamp = randomUUID().replace(/-/g, '').slice(0, 12)
        const file = `${id}-${stamp}.${image.ext}`
        const mascotDir = resolveMascotDir()
        await mkdir(mascotDir, { recursive: true })
        await writeFile(join(mascotDir, file), image.bytes)
        mascotMap[id] = { image: file, box }
        await persistMascotMap()
        await pruneMascotFiles(id, MASCOT_MAX_VERSIONS - 1, file)
        sendJson(res, 200, { ok: true, mascot: mascotFor(id) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `artwork write failed: ${error?.message ?? String(error)}` })
      }
      return
    }

    if (tail.startsWith('mascot-file/') && method === 'GET') {
      const name = tail.slice('mascot-file/'.length)
      // The name travels straight into a path, so it is checked here even though
      // every name this plugin writes is a single segment: a hand-edited map must
      // not be able to turn a read into a file read anywhere on disk. The check
      // is on the RESOLVED path, not the string — a string test only holds as long
      // as nothing upstream decodes the request, which is a coincidence to rely on.
      const target = resolveInside(resolveMascotDir(), name)
      if (target === undefined) {
        sendJson(res, 404, { ok: false, error: 'unknown artwork' })
        return
      }
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      const type = MASCOT_TYPES.get(ext)
      if (type === undefined) {
        sendJson(res, 404, { ok: false, error: 'unknown artwork' })
        return
      }
      try {
        const body = await readFile(target)
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(body.length),
          // The stored name carries a fresh stamp per upload, so the entity tag
          // can be derived from it: the same URL always answers the same bytes,
          // and different bytes always arrive under a different URL.
          etag: `"${name}"`,
          'cache-control': 'private, max-age=31536000, immutable'
        })
        res.end(body)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          // The map named a file that is gone: report the miss as a miss, since
          // the browser will simply keep showing nothing.
          sendJson(res, 404, { ok: false, error: 'unknown artwork' })
          return
        }
        sendJson(res, 500, { ok: false, error: `artwork read failed: ${error?.message ?? String(error)}` })
      }
      return
    }

    if (tail === 'mascot' && method === 'DELETE') {
      const id = url.searchParams.get('role') ?? ''
      await mascotReady
      const role = await roleFor(id)
      if (role === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown role "${id}"` })
        return
      }
      try {
        delete mascotMap[id]
        await persistMascotMap()
        await pruneMascotFiles(id, 0)
        sendJson(res, 200, { ok: true, cleared: id })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: `clear failed: ${error?.message ?? String(error)}` })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: `unknown endpoint ${method} ${tail}` })
  }

  /**
   * Serve one request through `handleRequest`, containing every failure.
   *
   * Split out from the route registration so it can be tested against a fault:
   * no route below is reachable in a state that throws, which is exactly why
   * "the wrapper catches" needs its own seam. A decoration must never be able to
   * take the Host down, and a request must never be left hanging.
   *
   * @param req - the raw request.
   * @param res - the raw response.
   * @param run - the request handler (injectable for the fault test).
   * @param log - a warning sink (injectable for the fault test).
   */
  const serveRequest = (req, res, run = handleRequest, log = logger, prefix = mountedPrefix) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      void Promise.resolve()
        .then(() => run(req, res, url, prefix))
        .catch((error) => {
          const reason = error?.message ?? String(error)
          log.warn(`[persona-switcher] request failed: ${reason}`)
          sendJson(res, 500, { ok: false, error: 'request failed' })
        })
    } catch (error) {
      const reason = error?.message ?? String(error)
      log.warn(`[persona-switcher] request could not be parsed: ${reason}`)
      sendJson(res, 500, { ok: false, error: 'request failed' })
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined) return
    scoped.effect(() => {
      const normalized = normalizeRoutePrefix(config.routePrefix)
      if (normalized === undefined) {
        // Refused on purpose: mounting at '' would make this plugin answer for
        // every unclaimed URL in the app. Nothing is registered, so the plugin
        // is inert and the app keeps its own routes.
        logger.warn(
          `[persona-switcher] routePrefix ${JSON.stringify(config.routePrefix)} is not a usable ` +
            'prefix (it must be one path segment, e.g. "/persona-switcher"); no routes were mounted'
        )
        return () => {}
      }
      mountedPrefix = normalized
      const dispose = webServer.register({
        kind: 'prefix',
        path: normalized,
        handler: (req, res) => serveRequest(req, res)
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
   * Render one session's remembered choice for a human.
   *
   * `null` is not "nothing": it is the deployment persona, chosen on purpose
   * with `/role none` — the one value a configured default role may not touch.
   */
  const describeRemembered = (remembered) => {
    if (remembered === undefined) return '(nothing remembered)'
    return remembered === NO_ROLE ? '(deployment persona, chosen with /role none)' : remembered
  }

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
   * Queue the role-change notice for one session's next model step.
   *
   * Every path that changes the persona in force for a live session goes
   * through here, `/role none` included: a session that goes *back* to the
   * deployment persona is exactly the case the notice exists for, because the
   * model's own earlier replies still demonstrate the role that was just
   * dismissed. Automatic rebinds that change nothing the session can read — the
   * same role reinstalled after a restart, or a configured default role applied
   * to a session that never chose one — deliberately stay silent.
   *
   * @param agent - the owning agent.
   * @param from - the role id that was in force, or null for the deployment persona.
   * @param to - the role id now in force, or null for the deployment persona.
   */
  const announceSwitch = (agent, from, to) => {
    if (!config.announceRoleChange) return
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const text = formatNotice(from, to)
    if (text !== '') {
      pendingNotices.set(sessionId, { from: from ?? '', to: to ?? '', text })
    }
  }

  /**
   * Switch one agent onto a role, or back to the deployment persona.
   *
   * Only the agent's persona input changes: the role's prose is registered as
   * this plugin's own agent-scoped `persona-switcher:persona` section, which
   * sits beside the deployment persona prefix rather than replacing it, so the
   * deployment's own identity line survives every switch. The session's
   * composition — and with it its tools, commands, skills and model route — is
   * never touched, so a switch cannot cost a session anything it already had.
   *
   * Binding is silent: every caller decides whether this particular change is
   * worth a notice, with `announceSwitch`.
   *
   * @param agent - the owning agent.
   * @param roleId - the requested role id.
   * @returns a small result describing what happened, including why the choice
   * could not be remembered when writing the session state failed.
   */
  const switchTo = async (agent, roleId) => {
    const role = findRole(roleId)
    if (role === undefined) {
      throw new Error(
        `unknown role "${roleId}"; available: ${catalogue.map((r) => r.id).join(', ') || '(none)'}`
      )
    }
    const { changed, from } = bindings.install(agent, role)
    // What the on-screen mascot draws changed, and this is the moment it happens
    // (the memory write below is durability, not the display). Bumping here is
    // what lets the browser notice a `/role` switch within its fast poll.
    if (changed) bumpRevision()
    // The binding is what the model sees now; the memory is what outlives this
    // agent. A switch writes both, and a memory that cannot be written is
    // reported instead of being passed off as durable.
    let rememberError
    try {
      await state.set(agent.session.id, role.id)
    } catch (error) {
      rememberError = error?.message ?? String(error)
      logger.warn(`[persona-switcher] role "${role.id}" is bound but could not be remembered: ${rememberError}`)
    }
    return { role: role.id, changed, from, rememberError }
  }

  /**
   * Re-apply one session's role before a model step.
   *
   * Runs before the first step of every root agent, including the agent the
   * harness builds after a restart — that is what makes a switch durable. It
   * never throws: a session whose role cannot be restored still gets its step,
   * on the deployment persona, with the complaint in the log.
   *
   * @param agent - the owning agent.
   */
  const restoreRole = async (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    try {
      await stateReady
      const bound = bindings.roleOf(agent)
      const remembered = state.get(sessionId)
      const fallback = defaultRoleOn()
      // Only the unbound case reads the library, so a session that already
      // carries its persona never pays for a scan.
      if (bound === undefined && (remembered !== undefined || fallback !== '')) await sync()
      const plan = planRestore({
        bound,
        remembered,
        fallback,
        has: (id) => catalogue.some((role) => role.id === id)
      })
      if (plan.action === 'persist') {
        await state.set(sessionId, plan.role)
        return
      }
      if (plan.action === 'forget' || plan.action === 'forget-and-bind') {
        await state.remove(sessionId)
        logger.warn(
          `[persona-switcher] remembered role "${remembered}" is no longer in ${dir}; ` +
            (plan.action === 'forget-and-bind'
              ? `role "${plan.role}" takes over for this session`
              : 'this session runs on the deployment persona')
        )
      }
      if (plan.action === 'bind' || plan.action === 'forget-and-bind') {
        await switchTo(agent, plan.role)
        // Two rebinds look alike here and must not be treated alike. Restoring
        // the role this session already carried (or applying the configured
        // default to a session that never chose one) changes nothing the model
        // can read, so it stays silent. A remembered role that vanished from the
        // library and handed the session to another one *is* a persona change
        // for this conversation, so it is announced — naming the role that is
        // gone, which is the side the model's own earlier replies demonstrate.
        if (plan.action === 'forget-and-bind') announceSwitch(agent, remembered, plan.role)
      }
      // A session that runs no role must still say so positively. Without this
      // section the model reads the role catalogue as a set of candidate
      // identities and can answer as one of them (measured: `/role none` came
      // back as whale-girl). This also covers a restart, when the in-memory
      // binding table is empty but the memory says "deployment persona".
      if (bindings.roleOf(agent) === undefined) bindings.ensureNone(agent)
    } catch (error) {
      logger.warn(`[persona-switcher] the session role could not be restored: ${String(error)}`)
    }
  }

  /**
   * Whether an agent is a root session.
   *
   * A delegated child inherits its parent's prompt and has its own scope, so
   * binding one there would fight the parent's identity.
   * @param agent - the candidate agent.
   * @returns true when the agent owns a root session.
   */
  const isRootAgent = (agent) => !(typeof agent?.depth === 'number' && agent.depth > 0)

  /**
   * Re-apply one session's remembered role while its agent is being created.
   *
   * This is the seam that reaches the *first* step. The harness assembles a
   * step's prompt before it runs `agent/pre-step`, so a role installed there is
   * one step late — after a restart the first reply of a resumed session ran on
   * the deployment persona. `agent/created` listeners are awaited inside the
   * creation transaction, before the harness releases the input queued for that
   * agent, so binding here lands in step one.
   *
   * A creation listener must not fail: a throwing listener rolls the whole
   * creation transaction back. This one is therefore total — `restoreRole`
   * already swallows its own errors, and the await is guarded again here so no
   * future edit inside it can turn a role problem into a session that cannot be
   * created.
   *
   * @param agent - the agent being created.
   */
  const restoreRoleAtCreation = async (agent) => {
    if (!isRootAgent(agent)) return
    try {
      await restoreRole(agent)
    } catch (error) {
      logger.warn(`[persona-switcher] the session role could not be restored at creation: ${String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => restoreRoleAtCreation(agent), { global: true })

  // Agents that are already live when this row loads — a hot reload, or a
  // session resumed before the row did — get the same treatment.
  ctx.inject(['agents'], (scoped) => {
    for (const agent of scoped.agents.list()) void restoreRoleAtCreation(agent)
  })

  ctx.effect(() => {
    libraryReady = (async () => {
      try {
        await sync()
      } catch (error) {
        logger.warn(`[persona-switcher] role library scan failed: ${String(error)}`)
      } finally {
        // Settled either way: a library that could not be read is a real answer,
        // and requests must not wait on it forever.
        libraryScanned = true
      }
    })()
  }, 'persona-switcher.library')

  const handleRoleCommand = async (invocation) => {
    const agent = invocation.agent
    if (agent === undefined) return { kind: 'error', text: 'The role command requires a session.' }

    const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const newline = raw.indexOf('\n')
    const headLine = newline < 0 ? raw : raw.slice(0, newline)
    const [verb, ...rest] = headLine.split(/\s+/).filter((word) => word !== '')

    await sync()
    await stateReady
    if (catalogue.length === 0) {
      return { kind: 'error', text: `The role library at ${dir} holds no roles yet.` }
    }

    const currentRole = () => bindings.roleOf(agent)
    const defaultId = defaultRoleOn() === '' ? null : defaultRoleOn()
    const rememberedId = () => state.get(agent.session.id)

    const overview = () => {
      const current = currentRole()
      const lines = [
        `current session role: ${current ?? '(none bound — this session runs on the deployment persona)'}`,
        `remembered for this session: ${describeRemembered(rememberedId())}`,
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
        // `clear` reports `{ changed, from }` like `install` does.
        const cleared = bindings.clear(agent)
        if (cleared.changed) bumpRevision()
        let memoryNote = ''
        try {
          // An opt-out is written, not erased: "this session wants the
          // deployment persona" is a decision of its own, and erasing it would
          // let the configured `defaultRole` claim the session again on its very
          // next model step.
          await state.set(agent.session.id, NO_ROLE)
        } catch (error) {
          const reason = error?.message ?? String(error)
          memoryNote = `\nNote: the choice could not be stored (${reason}); the deployment persona may not survive a restart.`
          logger.warn(`[persona-switcher] the deployment-persona choice could not be remembered: ${reason}`)
        }
        // Dismissing a role is a persona change like any other, and the one the
        // transcript argues hardest against: its earlier replies still speak in
        // the role's voice. It gets the same in-band notice.
        if (cleared.changed) announceSwitch(agent, cleared.from, null)
        return {
          kind: 'success',
          text:
            (cleared.changed
              ? `Role "${cleared.from}" removed; this session runs on the deployment persona again.`
              : 'This session already runs on the deployment persona.') +
            memoryNote +
            `\n\n${overview()}`
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
      // `/role <id>` is a deliberate persona change, so it is announced from
      // whichever side the session came — including the deployment persona,
      // which is the `from` side whenever the session carried no role.
      if (result.changed) announceSwitch(agent, result.from ?? null, target.id)
      const headline = result.changed
        ? `Switched this session from "${result.from ?? '(none)'}" to "${target.id}" (${target.name}).`
        : `This session already runs as "${target.id}" (${target.name}).`
      const memory =
        result.rememberError === undefined
          ? ''
          : `\nThis choice could not be stored (${result.rememberError}); it will be gone after a restart.`
      return { kind: 'success', text: `${headline}${memory}\n\n${overview()}` }
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
  // 1. Role restoration. The library is scanned lazily and a role is installed
  //    as this agent's scoped persona section before this step: the one the
  //    session used before a restart (from its durable memory), or the
  //    configured default for a session that never chose one. A role that an
  //    older build bound in memory only is written here too, so an upgrade
  //    keeps the persona a running session already had. A session that chose the
  //    deployment persona with `/role none` is left alone: the memory records
  //    that decision, so the default cannot reclaim the session.
  //    The harness assembles a step's prompt *before* this hook runs, so the
  //    seam that reaches a session's first step is `agent/created` above; this
  //    one keeps every step after it reconciled.
  // 2. The role-change notice. It is injected through `decision.messages`, the
  //    same channel `dsh-tool-skill` and `dsh-agent-instructions` use, so it is
  //    an ordinary durable user message in the log rather than forged state.
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages }, next) => {
      // Root sessions only — the same guard the creation seam uses.
      if (isRootAgent(agent)) await restoreRole(agent)

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
          await stateReady
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
            `remembered for this session: ${describeRemembered(state.get(session.id))}`,
            `session state: ${state.size} entr${state.size === 1 ? 'y' : 'ies'} in ${state.file}`,
            'deployment persona prefix in force: yes (this plugin never shadows it)',
            `role persona section: ${
              bound === undefined ? '(none — the persona is empty)' : `persona-switcher:persona (${bound})`
            }`,
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

  // A seam for the verification harness, not a public API: no route is reachable
  // in a state that throws, so "the request wrapper contains every failure" can
  // only be tested by handing it a handler that does. The prefix normalizer is
  // here for the same reason — an empty prefix must never be mounted, and that is
  // only checkable by calling it. The Host ignores whatever `apply` returns.
  return { serveRequest, normalizeRoutePrefix }
}