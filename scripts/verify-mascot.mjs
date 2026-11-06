#!/usr/bin/env node
/**
 * Behavioural guard for the mascot artwork side: the artwork map, the three
 * `/mascot` routes, `GET /session`, and the `mascot` field `GET /roles` carries.
 *
 * Run with `npm test` (CI runs the same on every push and PR).
 *
 * Everything here goes through the row's *real* HTTP surface: `apply()` is
 * mounted on a stub host context that captures the request handler the plugin
 * registers, and that handler is then served by a real `node:http` server in a
 * throwaway `DSH_HOME`. Nothing reimplements the plugin's logic, so a check that
 * passes here is a check against shipped code.
 *
 * The properties that matter are the ones a reader of the source cannot confirm:
 *
 *   1. The map round-trips: an upload is stored, `GET /roles` reports it in the
 *      same response, `GET /mascot` serves exactly the uploaded bytes with the
 *      media type taken from the bytes rather than from the request, and the URL
 *      changes on re-upload so a long cache lifetime is safe.
 *   2. A malformed box disables the mascot rather than half-enabling it: the
 *      client must never receive an entry it cannot lay out. This is the
 *      "bad box counts as unbound" rule, checked by editing the map out of band.
 *   3. `GET /session` answers `roleId: null` — never a missing key — for the
 *      three no-role cases: a session bound to no role, a session that opted out
 *      with `/role none`, and a session nobody has ever heard of.
 *   4. Uploads are refused on their merits: a body that is not an image this
 *      plugin serves, one over the size ceiling, and one whose box is missing or
 *      out of range, all leave the previous artwork untouched.
 *   5. Clearing removes both the map entry and the files, and re-importing the
 *      same role prunes its older files so one role cannot grow without bound.
 *   6. Every read route is side-effect free: asking about a role that has no
 *      artwork never writes a map entry, and never leaks an absolute path.
 *
 * Exits non-zero on the first class of problem found.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { STATE_VERSION } from '../lib/session-state.js'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/**
 * Import `lib/index.js` with its optional `dsh-tools` peer stubbed inline.
 *
 * The peer is optional on purpose — a deployment without the tool surface keeps
 * every other feature — so this repository does not install it. `defineTool` is
 * used purely to declare the `role_probe` tool, which nothing here exercises, so
 * the stand-in returns its spec unchanged and everything else is shipped source.
 *
 * @returns the plugin module.
 */
const loadHost = async () => {
  const source = await readFile(join(libDir, 'index.js'), 'utf8')
  const needle = "from '@deepseek-ai/dsh-tools'"
  if (!source.includes(needle)) {
    throw new Error(
      `lib/index.js no longer contains ${needle}, so this guard cannot stub the optional peer — ` +
        'update scripts/verify-mascot.mjs'
    )
  }
  const stub = `data:text/javascript;base64,${Buffer.from('export const defineTool = (spec) => spec\n').toString('base64')}`
  const copy = join(libDir, 'tmp-verify-mascot.mjs')
  await writeFile(copy, source.replace(needle, `from '${stub}'`))
  try {
    return await import(pathToFileURL(copy).href)
  } finally {
    rmSync(copy, { force: true })
  }
}

const { apply } = await loadHost()

const problems = []
const checks = []

/** Record one check, or the problem it found. */
const check = (name, run) => {
  try {
    run()
    checks.push(name)
  } catch (error) {
    problems.push(`${name}: ${error?.message ?? String(error)}`)
  }
}

/** Run an async check. */
const checkAsync = async (name, run) => {
  try {
    await run()
    checks.push(name)
  } catch (error) {
    problems.push(`${name}: ${error?.message ?? String(error)}`)
  }
}

/**
 * One media type's minimal viable byte sequence.
 *
 * The sizes are far below any real artwork, which is the point: the plugin
 * identifies artwork by its magic number, so a signature with nothing behind it
 * is enough to exercise every path that matters.
 */
const artwork = {
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0x11)
  ]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 0x22)]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16, 0x33)])
}

/** Wrap bytes as the settings page's downsampled `data:` URL. */
const asDataUrl = (bytes, type) => `data:${type};base64,${bytes.toString('base64')}`

const home = await mkdtemp(join(tmpdir(), 'dsh-persona-mascot-'))
// `DSH_HOME` is set before `apply` runs, which is what decides which deployment
// this run touches: the row resolves its role library and its data directory per
// call, so every path below lands in this throwaway directory instead of the
// developer's own `~/.dsh`.
process.env.DSH_HOME = home
const rolesDir = join(home, 'roles')
const mascotDir = join(home, 'persona-switcher', 'mascot')
const mapFile = join(home, 'persona-switcher', 'mascot-map.json')
const stateFile = join(home, 'persona-switcher', 'sessions.json')

/** Write one role into the throwaway library. */
const seedRole = async (id) => {
  await mkdir(join(rolesDir, id), { recursive: true })
  await writeFile(
    join(rolesDir, id, 'ROLE.md'),
    ['---', `id: ${id}`, `name: ${id}`, 'description: seeded', '---', '', `I am ${id}.`, ''].join('\n'),
    'utf8'
  )
}

await seedRole('amiya')
await seedRole('whale-girl')

// One session bound to a role, one that opted out, and one that only ever
// appears in a query string — the three shapes `GET /session` must answer.
await mkdir(join(home, 'persona-switcher'), { recursive: true })
await writeFile(
  stateFile,
  JSON.stringify({
    version: STATE_VERSION,
    sessions: {
      'session-bound': { role: 'amiya', at: Date.now() },
      'session-opted-out': { role: null, at: Date.now() }
    }
  }),
  'utf8'
)

let handler
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
/** Command definitions this row registered, by name. */
const commands = new Map()

/**
 * A fake agent good enough for the real `/role` handler.
 *
 * The handler needs three things from an agent: a session id, an agent-scoped
 * `systemPrompt` registry (the binding refuses to install a persona without one,
 * by design), and nothing else. A registry that records what was registered lets
 * a check confirm the persona actually changed.
 */
const makeAgent = (sessionId) => {
  const sections = new Map()
  const prompt = {
    section: ({ name, text }) => {
      sections.set(name, text)
      return () => sections.delete(name)
    }
  }
  return { agent: { session: { id: sessionId }, ctx: { get: (service) => (service === 'systemPrompt' ? prompt : undefined) } }, sections }
}

/**
 * Run an effect factory the way Cordis does.
 *
 * A factory may be a generator that yields its registrations (`yield
 * ctx.commands.register(...)`) — that is how this row registers `/role`, so a
 * stub that only calls the function would leave the command unregistered and
 * make the revision checks below unable to run the real switch path. Simple
 * factories are still just called.
 */
const driveEffect = (factory) => {
  const result = factory()
  if (result === null || typeof result !== 'object' || typeof result.next !== 'function') return result
  let step = result.next()
  while (step.done !== true) step = result.next(step.value)
  return step.value
}

/**
 * A host context with just enough surface for this row.
 *
 * `inject` answers synchronously, the way Cordis resolves a service that is
 * already present, which is what the row's route registration expects.
 */
const ctx = {
  logger,
  config: { rolesDir, routePrefix: '/persona-switcher', defaultRole: '', exposeTool: true, announceRoleChange: true },
  fiber: { entry: { id: 'persona-switcher' } },
  // An effect runs its factory at once and returns a disposer: with this stub
  // calling the factory, the row's library scan starts exactly as it does on a
  // real deployment, including the race the write routes have to tolerate.
  effect: (factory) => {
    driveEffect(factory)
    return () => {}
  },
  on: () => () => {},
  get: () => undefined,
  // The `/role` command is registered through here, and the revision counter's
  // MAIN bump lives in the switch path — so this guard has to be able to run the
  // real handler rather than pretend the command does not exist.
  commands: {
    register: (definition) => {
      commands.set(definition.name, definition)
      return () => {}
    }
  },
  // The prompt catalogue and the diagnostic tool are declared on surfaces this
  // guard does not exercise; they only have to exist for `apply` to get as far
  // as registering the routes.
  systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
  inject: (names, run) => {
    const scoped = {
      effect: (factory) => {
        driveEffect(factory)
        return () => {}
      },
      get: (service) =>
        service === 'webServer'
          ? {
              register: (surface) => {
                handler = surface.handler
                return () => {}
              }
            }
          : undefined
    }
    // `agents` and `settings` are read opportunistically by the row; a
    // deployment without them keeps every other feature, so their absence here
    // is a supported configuration rather than a gap in the stub.
    if (Array.isArray(names) && names.includes('webServer')) run(scoped)
  }
}

const hostSurface = await apply(ctx, ctx.config)
assert.ok(typeof handler === 'function', 'the row registered no request handler')

const server = createServer((req, res) => {
  handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/** One request, parsed as JSON when the response says so. */
const call = async (method, path, body) => {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
    body: payload
  })
  const type = res.headers.get('content-type') ?? ''
  const value = type.includes('application/json') ? await res.json() : await res.arrayBuffer()
  return { status: res.status, headers: res.headers, value, bytes: Buffer.from(value instanceof ArrayBuffer ? value : []) }
}

/** Read the artwork map as the plugin last wrote it. */
const readMap = async () => JSON.parse(await readFile(mapFile, 'utf8'))

const rolesOf = async () => {
  const { value } = await call('GET', '/persona-switcher/roles')
  return value.roles
}

/**
 * The artwork one role reports, defaulting to null.
 *
 * "The role is absent from the response" and "the role reports `mascot: null`"
 * are the same answer here — the second is the contract — so a missing key is
 * folded into null rather than surfacing as `undefined` and making a passing
 * case look like a failure.
 */
const mascotOf = async (id) => (await rolesOf()).find((role) => role.id === id)?.mascot ?? null

/** The revision the host is currently publishing. */
const revisionNow = async () => {
  const { status, value } = await call('GET', '/persona-switcher/revision')
  if (status !== 200) throw new Error(`/revision answered ${status}`)
  return value.revision
}

/** Run the real `/role` command as the harness would. */
const runRole = async (sessionId, rawInput) => {
  const definition = commands.get('role')
  if (definition === undefined) throw new Error('the plugin registered no /role command')
  return definition.handler({ agent: makeAgent(sessionId).agent, rawInput })
}

/** File names captured from a clean map, for the hand-edit cases below. */
let cleanAmiya = ''
let cleanWhale = ''

try {
  // ---------------------------------------------------------------------------
  // 1. Upload, report, serve
  // ---------------------------------------------------------------------------
  const upload = await call('POST', '/persona-switcher/mascot?role=amiya', {
    image: asDataUrl(artwork.png, 'image/png'),
    box: '256x256'
  })
  await checkAsync('an upload is accepted and reports the artwork it stored', async () => {
    assert.equal(upload.status, 200)
    assert.equal(upload.value.ok, true)
    assert.equal(upload.value.mascot.box, '256x256')
    assert.match(upload.value.mascot.image, /^\/persona-switcher\/mascot-file\/amiya-[0-9a-f]{12}\.png$/)
  })

  await checkAsync('GET /roles carries the artwork in the same response', async () => {
    const mascot = await mascotOf('amiya')
    assert.equal(mascot.box, '256x256')
    assert.equal(mascot.image, upload.value.mascot.image)
  })

  await checkAsync('a role without artwork reports mascot: null', async () => {
    assert.equal(await mascotOf('whale-girl'), null)
  })

  await checkAsync('GET /mascot serves exactly the uploaded bytes', async () => {
    const { status, headers, bytes } = await call('GET', upload.value.mascot.image)
    assert.equal(status, 200)
    assert.equal(headers.get('content-type'), 'image/png')
    assert.equal(bytes.length, artwork.png.length)
    assert.ok(bytes.equals(artwork.png), 'the served bytes differ from the uploaded bytes')
  })

  await checkAsync('the media type comes from the bytes, not from the request', async () => {
    // Same PNG bytes, announced as a JPEG: the stored extension and the served
    // type must both follow the magic number.
    const wrong = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: asDataUrl(artwork.png, 'image/jpeg'),
      box: '64x80'
    })
    assert.equal(wrong.status, 200)
    assert.match(wrong.value.mascot.image, /\.png$/)
    const served = await call('GET', wrong.value.mascot.image)
    assert.equal(served.headers.get('content-type'), 'image/png')
  })

  await checkAsync('etag and cache headers describe the stored file', async () => {
    const scheme = (await mascotOf('amiya')).image
    const { headers } = await call('GET', scheme)
    assert.match(headers.get('etag') ?? '', /^"amiya-[0-9a-f]{12}\.png"$/)
    assert.match(headers.get('cache-control') ?? '', /immutable/)
  })

  await checkAsync('re-importing the same role changes the URL, so the cache cannot go stale', async () => {
    const before = (await mascotOf('amiya')).image
    const again = await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.jpg, 'image/jpeg'),
      box: '512x300'
    })
    assert.equal(again.status, 200)
    assert.notEqual(again.value.mascot.image, before)
    const served = await call('GET', again.value.mascot.image)
    assert.equal(served.headers.get('content-type'), 'image/jpeg')
    assert.ok(served.bytes.equals(artwork.jpg))
  })

  await checkAsync('a WebP is recognised too', async () => {
    const webp = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: asDataUrl(artwork.webp, 'image/webp'),
      box: '100x100'
    })
    assert.equal(webp.status, 200)
    assert.match(webp.value.mascot.image, /\.webp$/)
    // Captured here, after the last upload of this section: those are the files
    // the hand-edit cases below have to name.
    const captured = await readMap()
    cleanAmiya = captured.amiya.image
    cleanWhale = captured['whale-girl'].image
  })

  // ---------------------------------------------------------------------------
  // 2. A box that cannot be laid out disables the mascot
  //
  // Every case below edits `mascot-map.json` behind the plugin's back, so each
  // one writes a complete map of its own rather than spreading whatever the
  // previous case left in the file.
  // ---------------------------------------------------------------------------
  await checkAsync('a malformed box reads as unbound', async () => {
    await writeFile(mapFile, JSON.stringify({ amiya: { image: cleanAmiya, box: '256 by 256' }, 'whale-girl': { image: cleanWhale, box: '90x120' } }), 'utf8')
    assert.equal(await mascotOf('amiya'), null)
    // Still served as bytes: the artwork exists, it is the binding that is off.
    const served = await call('GET', `/persona-switcher/mascot-file/${cleanAmiya}`)
    assert.equal(served.status, 200)
    const other = await mascotOf('whale-girl')
    assert.equal(other?.image.split('/').pop(), cleanWhale, 'a broken entry for one role broke another role')
  })

  await checkAsync('a missing box reads as unbound as well', async () => {
    await writeFile(mapFile, JSON.stringify({ amiya: { image: cleanAmiya } }), 'utf8')
    assert.equal(await mascotOf('amiya'), null)
  })

  await checkAsync('an entry pointing outside the artwork directory is refused', async () => {
    await writeFile(mapFile, JSON.stringify({ amiya: { image: '../../sessions.json', box: '256x256' } }), 'utf8')
    assert.equal(await mascotOf('amiya'), null)
    // And the read path itself refuses to walk out of the artwork directory,
    // which is what makes a hand-edited map harmless rather than only useless.
    const walked = await call('GET', '/persona-switcher/mascot-file/..%2F..%2Fsessions.json')
    assert.equal(walked.status, 404)
    const bare = await call('GET', '/persona-switcher/mascot-file/sessions.json')
    assert.equal(bare.status, 404)
  })

  await checkAsync('an out-of-range box reads as unbound, and a padded one is normalised', async () => {
    // These pass the shape pattern, so the range check is the only thing that
    // catches them. They used to be dropped silently deeper in the read path,
    // where "this role has no mascot" is indistinguishable from a missing file.
    for (const box of ['9999x9999', '7x100', '100x7', '4097x100']) {
      await writeFile(mapFile, JSON.stringify({ amiya: { image: cleanAmiya, box } }), 'utf8')
      assert.equal(await mascotOf('amiya'), null, `box ${box} was accepted`)
    }
    // Padding is not an error: it normalises, and the role keeps its mascot.
    for (const [written, expected] of [['0080x0120', '80x120'], ['0008x8', '8x8']]) {
      await writeFile(mapFile, JSON.stringify({ amiya: { image: cleanAmiya, box: written } }), 'utf8')
      const normalised = await mascotOf('amiya')
      assert.equal(normalised?.box, expected, `box ${written} should normalise to ${expected}`)
    }
  })

  await checkAsync('a role id that is not one path segment is never catalogue-visible or deletable', async () => {
    // The catalogue is built from files a person can place by hand, and the delete
    // route removes RECURSIVELY. A role file declaring `id: ../outside-role` used
    // to aim that removal at the role library's parent. It is now dropped while
    // the library is scanned, so the route cannot even name it — which is the
    // stronger guarantee: check both facts, not just the status code.
    const nested = join(rolesDir, '..', 'outside-role')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'ROLE.md'), '---\nid: ../outside-role\nname: Sneaky\ndescription: x\n---\n\nBody\n', 'utf8')
    const roles = await rolesOf()
    assert.ok(
      !roles.some((role) => String(role.id).includes('..')),
      `the library published a traversal id: ${JSON.stringify(roles.map((role) => role.id))}`
    )
    const { status } = await call('DELETE', '/persona-switcher/role?id=..%2Foutside-role')
    assert.ok(status === 404 || status === 400, `expected a refusal, got ${status}`)
    assert.ok(existsSync(join(nested, 'ROLE.md')), 'the guarded file was deleted anyway')
    // Tidy up through the filesystem rather than the route.
    await rm(nested, { recursive: true, force: true })
  })

  await checkAsync('a hand edit that repairs the map takes effect without a restart', async () => {
    await writeFile(mapFile, JSON.stringify({ amiya: { image: cleanAmiya, box: '300x200' } }), 'utf8')
    const restored = await mascotOf('amiya')
    assert.equal(restored.box, '300x200')
    assert.equal(restored.image, `/persona-switcher/mascot-file/${cleanAmiya}`)
  })

  // ---------------------------------------------------------------------------
  // 3. GET /session never answers a missing key
  // ---------------------------------------------------------------------------
  await checkAsync('a bound session reports its role', async () => {
    const { status, value } = await call('GET', '/persona-switcher/session?session=session-bound')
    assert.equal(status, 200)
    assert.equal(value.roleId, 'amiya')
  })

  await checkAsync('/role none reports roleId: null, not an absent key', async () => {
    const { value } = await call('GET', '/persona-switcher/session?session=session-opted-out')
    assert.ok('roleId' in value, 'roleId is missing from the response, so the client cannot tell "none" from "broken"')
    assert.equal(value.roleId, null)
  })

  await checkAsync('a session nobody remembers reports roleId: null', async () => {
    const { value } = await call('GET', '/persona-switcher/session?session=never-seen')
    assert.ok('roleId' in value)
    assert.equal(value.roleId, null)
  })

  await checkAsync('a session id equal to a known role id is not mistaken for one', async () => {
    const { value } = await call('GET', '/persona-switcher/session?session=amiya')
    assert.equal(value.roleId, null)
  })

  await checkAsync('GET /session is read-only: the state file is unchanged by it', async () => {
    const before = await readFile(stateFile, 'utf8')
    await call('GET', '/persona-switcher/session?session=never-seen')
    await call('GET', '/persona-switcher/session?session=session-bound')
    assert.equal(await readFile(stateFile, 'utf8'), before)
  })

  // ---------------------------------------------------------------------------
  // 4. Refusals leave the previous artwork in place
  // ---------------------------------------------------------------------------
  await checkAsync('an upload that is not a supported image is refused', async () => {
    const before = await mascotOf('whale-girl')
    const text = Buffer.from('this is not an image at all, but it is long enough')
    const { status } = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: asDataUrl(text, 'image/png'),
      box: '64x64'
    })
    assert.equal(status, 400)
    assert.deepEqual(await mascotOf('whale-girl'), before)
  })

  await checkAsync('a data URL that is not base64 image data is refused', async () => {
    const { status } = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: 'https://example.com/mascot.png',
      box: '64x64'
    })
    assert.equal(status, 400)
  })

  await checkAsync('an oversized upload is refused', async () => {
    const huge = Buffer.concat([artwork.png, Buffer.alloc(1100 * 1024, 0x44)])
    const { status } = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: asDataUrl(huge, 'image/png'),
      box: '64x64'
    })
    assert.equal(status, 400)
  })

  await checkAsync('a box outside the accepted range is refused', async () => {
    for (const box of ['0x0', '7x64', '4097x64', '64', '64X64', '64x64x64']) {
      const { status } = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
        image: asDataUrl(artwork.png, 'image/png'),
        box
      })
      assert.equal(status, 400, `box "${box}" was accepted`)
    }
  })

  await checkAsync('an upload for an unknown role is refused', async () => {
    const { status } = await call('POST', '/persona-switcher/mascot?role=ghost', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '64x64'
    })
    assert.equal(status, 404)
  })

  await checkAsync('an upload without a role is refused', async () => {
    const { status } = await call('POST', '/persona-switcher/mascot', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '64x64'
    })
    assert.equal(status, 404)
  })

  // ---------------------------------------------------------------------------
  // 5. Clearing, pruning, and read-only reads
  // ---------------------------------------------------------------------------
  await checkAsync('re-importing prunes older files of that role', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { status } = await call('POST', '/persona-switcher/mascot?role=whale-girl', {
        image: asDataUrl(artwork.webp, 'image/webp'),
        box: '120x90'
      })
      assert.equal(status, 200)
    }
    const bound = (await mascotOf('whale-girl')).image.split('/').pop()
    const mine = (await readdir(mascotDir)).filter((name) => name.startsWith('whale-girl-'))
    // Bounded rather than exact: uploads can share a file timestamp, so which
    // older revisions survive is not part of the contract. What is: the role
    // keeps at most the configured number of files, and the bound artwork is
    // always among them.
    assert.ok(mine.length >= 1 && mine.length <= 3, `expected 1..3 kept files, found ${mine.length}`)
    assert.ok(mine.includes(bound), 'the bound artwork was pruned away')
  })

  await checkAsync('clearing removes the map entry and every file of that role', async () => {
    // The stray edits of section 2 left the map holding nothing: restore a valid
    // entry for both roles through the real route before clearing one of them.
    await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '256x256'
    })
    await call('POST', '/persona-switcher/mascot?role=whale-girl', {
      image: asDataUrl(artwork.webp, 'image/webp'),
      box: '120x90'
    })
    const { status, value } = await call('DELETE', '/persona-switcher/mascot?role=whale-girl')
    assert.equal(status, 200)
    assert.equal(value.cleared, 'whale-girl')
    assert.equal(await mascotOf('whale-girl'), null)
    const mine = (await readdir(mascotDir)).filter((name) => name.startsWith('whale-girl-'))
    assert.equal(mine.length, 0, `clearing left ${mine.join(', ')} behind`)
    // The other role is untouched.
    assert.notEqual(await mascotOf('amiya'), null)
  })

  await checkAsync('a failed map write does not poison every later upload', async () => {
    // A directory on the map path makes `rm(file, { force: true })` refuse, so
    // the write fails after the artwork file itself landed. That failure must
    // stay inside its own attempt: the queue is shared, and a rejection left on
    // it would replay the first error for every upload that follows, until a
    // restart — the one state the map is supposed to survive.
    await rm(mapFile, { force: true })
    await mkdir(join(mapFile, 'occupied'), { recursive: true })
    const failed = await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '256x256'
    })
    assert.equal(failed.status, 500, 'an upload whose map write fails must answer 500')

    await rm(mapFile, { recursive: true, force: true })
    const recovered = await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '256x256'
    })
    assert.equal(recovered.status, 200, 'the next upload must be attempted, not replayed')
    assert.equal((await readMap()).amiya.box, '256x256', 'the recovered upload must reach disk')

    const after = await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.png, 'image/png'),
      box: '200x200'
    })
    assert.equal(after.status, 200, 'the queue must stay healthy afterwards')
    assert.equal((await readMap()).amiya.box, '200x200')
  })

  await checkAsync('a hand-edited map reaches the browser through the revision counter', async () => {
    // The map is a plain JSON file a person may edit by hand. `/roles` is the
    // route that re-reads it, and the revision counter is the only way the
    // browser hears that anything changed — so a reload that changed the content
    // has to move the counter, or the edit is in force on the host and still
    // invisible on screen.
    const map = await readMap()
    assert.notEqual(map.amiya, undefined, 'this check needs a bound role')
    const before = await revisionNow()
    await writeFile(
      mapFile,
      `${JSON.stringify({ ...map, amiya: { ...map.amiya, box: '120x90' } }, null, 2)}\n`,
      'utf8'
    )

    const roles = await rolesOf()
    assert.equal(roles.find((role) => role.id === 'amiya')?.mascot?.box, '120x90', 'the edit must be served')
    const after = await revisionNow()
    assert.ok(after > before, `the revision must move when the map is reloaded (${before} -> ${after})`)
  })

  await checkAsync('reading a role with no artwork writes nothing', async () => {
    const before = await readFile(mapFile, 'utf8')
    const { status } = await call('GET', '/persona-switcher/mascot?role=whale-girl')
    assert.equal(status, 404)
    await call('GET', '/persona-switcher/mascot?role=ghost')
    assert.equal(await readFile(mapFile, 'utf8'), before)
  })

  await checkAsync('an artwork file that vanished is a miss, not a crash', async () => {
    const map = await readMap()
    const file = map.amiya.image
    await rm(join(mascotDir, file), { force: true })
    const { status } = await call('GET', `/persona-switcher/mascot/${file}`)
    assert.equal(status, 404)
    // Repairing it for the checks that follow.
    await writeFile(join(mascotDir, file), artwork.png)
  })

  await checkAsync('every bound entry holds a bare file name, never a path', async () => {
    // The map on disk may legitimately hold a tampered entry by this point —
    // one of the checks above put one there on purpose — so what matters is what
    // the plugin is willing to *serve*: every reported URL must name a single
    // file inside the artwork directory.
    const roles = await rolesOf()
    const bound = roles.filter((role) => role.mascot !== null)
    assert.ok(bound.length > 0, 'no role is bound, so this check proves nothing')
    for (const role of bound) {
      const name = role.mascot.image.split('/').pop() ?? ''
      assert.match(name, /^[a-z0-9-]+\.[a-z]+$/, `${role.id} reports an unusable URL: ${role.mascot.image}`)
      assert.match(role.mascot.box, /^\d+x\d+$/, `${role.id} reports an unusable box`)
      const served = await call('GET', role.mascot.image)
      assert.equal(served.status, 200, `${role.id} reports artwork that is not served`)
    }
  })

  await checkAsync('an unknown endpoint still answers 404', async () => {
    const { status, value } = await call('GET', '/persona-switcher/nope')
    assert.equal(status, 404)
    assert.match(value.error, /unknown endpoint/)
  })

  /* ── The revision counter: how a live `/role` switch reaches the browser ── */
  // Nothing is broadcast to the web client when a session is rebound, so the
  // on-screen mascot polls this counter and only re-reads the role when it moves.
  // If these two bumps are missing, the mascot silently stops following `/role`
  // — the exact bug that shipped in 0.2.0.

  await checkAsync('/revision publishes a number', async () => {
    const revision = await revisionNow()
    assert.equal(typeof revision, 'number')
    assert.ok(Number.isFinite(revision))
  })

  await checkAsync('/role <id> moves the revision (this is the bump that matters)', async () => {
    const before = await revisionNow()
    const result = await runRole('session-revision-one', 'amiya')
    assert.equal(result.kind, 'success', result.text)
    const after = await revisionNow()
    assert.ok(after > before, `revision did not move: ${before} -> ${after}`)
  })

  await checkAsync('/role none moves it too', async () => {
    await runRole('session-revision-two', 'whale-girl')
    const before = await revisionNow()
    const result = await runRole('session-revision-two', 'none')
    assert.equal(result.kind, 'success', result.text)
    assert.ok((await revisionNow()) > before)
  })

  await checkAsync('re-applying the role already bound is not a change, so it does not move', async () => {
    const result = await runRole('session-revision-three', 'amiya')
    assert.equal(result.kind, 'success', result.text)
    const before = await revisionNow()
    await runRole('session-revision-three', 'amiya')
    assert.equal(await revisionNow(), before, 'a no-op switch must not look like a change')
  })

  await checkAsync('an unknown role bumps nothing and answers with the error', async () => {
    const before = await revisionNow()
    const result = await runRole('session-revision-four', 'no-such-role')
    assert.equal(result.kind, 'error')
    assert.equal(await revisionNow(), before)
  })

  await checkAsync('importing artwork moves it', async () => {
    const before = await revisionNow()
    const { status } = await call('POST', '/persona-switcher/mascot?role=amiya', {
      image: asDataUrl(artwork.webp, 'image/webp'),
      box: '20x30'
    })
    assert.equal(status, 200)
    assert.ok((await revisionNow()) > before)
  })

  await checkAsync('clearing artwork moves it', async () => {
    const before = await revisionNow()
    const { status } = await call('DELETE', '/persona-switcher/mascot?role=amiya')
    assert.equal(status, 200)
    assert.ok((await revisionNow()) > before)
  })

  await checkAsync('reading the revision touches no file', async () => {
    // It is polled several times a second by every open window, so it must stay
    // an in-memory answer: the role read is the expensive one, and this exists
    // precisely so that read can be rare.
    const mapBefore = await readFile(mapFile, 'utf8')
    const stateBefore = await readFile(stateFile, 'utf8')
    for (let i = 0; i < 5; i += 1) await revisionNow()
    assert.equal(await readFile(mapFile, 'utf8'), mapBefore)
    assert.equal(await readFile(stateFile, 'utf8'), stateBefore)
  })

  /* ── The request wrapper contains every failure ─────────────────────────── */
  // No route is reachable in a state that throws — every one guards its own work
  // — which is exactly why the outer wrapper needs its own seam. A throw that
  // escapes it would be an unhandled rejection inside the Host process, and a
  // request that gets no answer hangs the caller. Both are unacceptable for a
  // decoration, so the wrapper is driven directly with a handler that throws.

  await checkAsync('a route that throws still answers 500 (never an unhandled rejection)', async () => {
    const serveRequest = hostSurface?.serveRequest
    assert.equal(typeof serveRequest, 'function', 'apply() exposed no serveRequest seam')
    const warnings = []
    const captured = []
    const fakeRes = {
      writableEnded: false,
      writeHead(status, headers) {
        captured.push({ status, headers })
      },
      end(body) {
        this.writableEnded = true
        captured.push({ body })
      }
    }
    serveRequest(
      { url: '/persona-switcher/roles', method: 'GET' },
      fakeRes,
      async () => {
        throw new Error('boom')
      },
      { warn: (line) => warnings.push(line) }
    )
    // The rejection is delivered a microtask later.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(captured[0]?.status, 500, 'the failing route did not answer 500')
    assert.match(String(captured[1]?.body), /request failed/)
    assert.ok(
      warnings.some((line) => line.includes('boom')),
      'the failure was swallowed without a warning'
    )
  })

  await checkAsync('a prefix that would claim the whole app is refused', async () => {
    // One configuration value must not be able to take the Web GUI down. A prefix
    // route matches with `pathname.startsWith(prefix + '/')`, so an empty path
    // matches EVERY request the app does not otherwise claim — this plugin would
    // answer 404 for the frontend's own assets and shadow the SPA fallback.
    const normalize = hostSurface?.normalizeRoutePrefix
    assert.equal(typeof normalize, 'function', 'apply() exposed no normalizeRoutePrefix seam')
    for (const bad of ['', '/', '   ', '//', '///', 'persona/../switcher']) {
      assert.equal(normalize(bad), undefined, `${JSON.stringify(bad)} was accepted as a prefix`)
    }
    assert.equal(normalize('/persona-switcher'), '/persona-switcher')
    assert.equal(normalize('persona-switcher'), '/persona-switcher')
    assert.equal(normalize('/ps/'), '/ps')
  })

  await checkAsync('a refused prefix mounts no routes at all', async () => {
    // The seam above proves the decision; this proves nothing is registered when
    // the decision is "no". A fresh apply with an unusable prefix must leave the
    // web server untouched and say why.
    const warnings = []
    let registrations = 0
    const bare = {
      logger: { info() {}, warn: (line) => warnings.push(String(line)), error() {}, debug() {} },
      config: { ...ctx.config, routePrefix: '' },
      fiber: { entry: { id: 'persona-switcher' } },
      effect: (factory) => {
        driveEffect(factory)
        return () => {}
      },
      on: () => () => {},
      get: () => undefined,
      commands: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      inject: (names, run) => {
        const scoped = {
          effect: (factory) => {
            driveEffect(factory)
            return () => {}
          },
          get: (service) =>
            service === 'webServer'
              ? {
                  register: () => {
                    registrations += 1
                    return () => {}
                  }
                }
              : undefined
        }
        if (Array.isArray(names) && names.includes('webServer')) run(scoped)
      }
    }
    await apply(bare, bare.config)
    assert.equal(registrations, 0, 'an unusable prefix still registered a route')
    assert.ok(
      warnings.some((line) => line.includes('not a usable')),
      `nothing warned about the refused prefix: ${JSON.stringify(warnings)}`
    )
  })

  await checkAsync('an unparsable request URL is contained too', async () => {
    const serveRequest = hostSurface.serveRequest
    const captured = []
    const fakeRes = {
      writableEnded: false,
      writeHead(status) {
        captured.push({ status })
      },
      end() {
        this.writableEnded = true
      }
    }
    // `new URL` throws on this, synchronously, inside the wrapper.
    serveRequest({ url: 'http://[', method: 'GET' }, fakeRes, async () => {}, { warn: () => {} })
    assert.equal(captured[0]?.status, 500, 'a malformed URL did not answer 500')
  })

  await checkAsync('the wrapper never answers a request twice', async () => {
    // `sendJson` bails out on a response that already ended, so a route that
    // answers and THEN throws cannot produce a second writeHead.
    const sendJsonProbe = []
    const fakeRes = {
      writableEnded: false,
      writeHead(status) {
        sendJsonProbe.push(status)
      },
      end() {
        this.writableEnded = true
      }
    }
    hostSurface.serveRequest(
      { url: '/persona-switcher/roles', method: 'GET' },
      fakeRes,
      async (req, res) => {
        res.writeHead(200)
        res.end('ok')
        throw new Error('after the answer')
      },
      { warn: () => {} }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(sendJsonProbe, [200], `answered ${sendJsonProbe.length} time(s)`)
  })
  await checkAsync('the role library bounds the persona and refuses a silent overwrite', async () => {
    const id = 'probe-created'
    const role = { id, name: 'Probe', description: '', persona: 'You are a probe.' }

    const oversized = await call('POST', '/persona-switcher/role', {
      ...role,
      id: 'probe-huge',
      persona: 'x'.repeat(16001)
    })
    assert.equal(oversized.status, 400, 'an unbounded persona must be refused before it is written')
    assert.match(oversized.value?.error ?? '', /too long/, 'the refusal must name the limit')

    const created = await call('POST', '/persona-switcher/role', { ...role, createOnly: true })
    assert.equal(created.status, 200, `a new role must be written, got ${JSON.stringify(created.value)}`)

    const duplicate = await call('POST', '/persona-switcher/role', { ...role, createOnly: true, persona: 'other' })
    assert.equal(duplicate.status, 409, 'a create must not overwrite a role the caller never saw')
    const untouched = (await rolesOf()).find((entry) => entry.id === id)
    assert.equal(untouched?.persona, role.persona, 'the refused write must leave the role as it was')

    const edited = await call('POST', '/persona-switcher/role', { ...role, name: 'Probe 2' })
    assert.equal(edited.status, 200, 'an edit is still allowed to overwrite')
    const landed = (await rolesOf()).find((entry) => entry.id === id)
    assert.equal(landed?.name, 'Probe 2', 'the edit must reach the library')

    const cleaned = await call('DELETE', `/persona-switcher/role?id=${encodeURIComponent(id)}`)
    assert.equal(cleaned.status, 200, 'the probe role must be removable again')
  })
} finally {
  await new Promise((resolve) => server.close(resolve))
  // The throwaway home is only removed when the run is clean, so a failure can
  // be inspected rather than guessed at.
  if (problems.length === 0) await rm(home, { recursive: true, force: true })
}

for (const name of checks) console.log(`ok   ${name}`)
for (const problem of problems) console.error(`FAIL ${problem}`)
if (problems.length > 0) {
  console.error(`\nverify-mascot: ${problems.length} problem(s) in ${home}`)
  process.exit(1)
}
console.log(`verify-mascot: all ${checks.length} checks hold`)
