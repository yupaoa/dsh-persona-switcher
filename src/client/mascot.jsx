import { createElement as h, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * The persona mascot, browser half: the on-screen companion that shows the
 * current session's role artwork while a session is on screen.
 *
 * It lives under its own React root portalled onto `<body>` (the same shape the
 * wallpaper engine's pull-cord uses), so it is independent of the settings view
 * and floats above the conversation without occupying a slot.
 *
 * Coexistence with `dsh-plugin-wallpaper-engine` is a requirement, not a
 * nice-to-have — both plugins are expected on screen at once. Everything that
 * could collide is therefore namespaced or deliberately avoided:
 *
 *   - own dock id `#dsh-persona-switcher-mascot-dock` (theirs is
 *     `#dsh-wallpaper-engine-rope-dock`), own style id, own `localStorage`
 *     namespace (`dsh-persona-switcher:*` vs `dsh-wallpaper-engine:*`);
 *   - mascot `z-index: 995` against their rope's `996` and their repo panel's
 *     `995`: the rope keeps the higher layer and never loses a pointer to us;
 *   - `sidebarRight` is only ever READ (for its `mounted` snapshot); we never
 *     register a seat or call their controller, so the right column and their
 *     sidebar tab are untouched;
 *   - no CSS `filter`, ever: a permanent drop-shadow on a fixed element over
 *     the wallpaper forces a filter layer Chromium re-rasterises on repaint and
 *     can flash white — the rope's header comment records that lesson, and a
 *     mascot is the same kind of fixed element;
 *   - no global `keydown` handler (the rope owns Esc to close its drawer), no
 *     `contextmenu` handler (right-click keeps reaching the native menu), no
 *     pointer listeners outside our own box.
 *
 * Display rule (four conditions, all required): the master switch is on, a
 * session seat is on screen, that session has a role (not `none`), and the role
 * has usable artwork. `mascotArtOf` on the host side is the single source of
 * truth for "usable": this file only ever asks whether `mascot` is `null`.
 */

/** Own dock id — distinct from the wallpaper engine's rope dock. */
const DOCK_ID = 'dsh-persona-switcher-mascot-dock'
/** Own style id — distinct from the settings page's `persona-switcher-settings-style`. */
const STYLE_ID = 'persona-switcher-mascot-style'
/** URL prefix of the role library API (`src/client/index.jsx` owns the base too). */
const API_BASE = '/persona-switcher'
/** Master switch, owned by the settings page and read here (client-side preference). */
const SHOWN_KEY = 'dsh-persona-switcher:mascot-shown'
/** Resting position, `{ x, y }` in viewport pixels, top-left of the artwork box. */
const POS_KEY = 'dsh-persona-switcher:mascot-pos'
/** Artwork size multiplier. The host keeps ownership of a role's REAL pixel size. */
const SIZE_KEY = 'dsh-persona-switcher:mascot-size'
/**
 * Animation preference for the role-switch turn: 'system' (default — honour the
 * OS `prefers-reduced-motion`), 'always' (turn even under reduce), or 'never'
 * (swap in place even when the OS allows animation). A per-plugin override, so a
 * machine whose OS animation setting is off can still see the turn without
 * changing a system-wide accessibility switch.
 */
const MOTION_KEY = 'dsh-persona-switcher:mascot-motion'
/** The three animation-preference values, in the order the settings page shows them. */
const MOTION_VALUES = ['system', 'always', 'never']
/** Smallest and largest multiplier the settings page offers. */
const SIZE_MIN = 0.5
const SIZE_MAX = 2.5
/** Cross-window / cross-component broadcast for the master switch. */
const SHOWN_EVENT = 'persona-switcher:mascot-shown'
/** Broadcast after the settings page imports or clears artwork. */
const CHANGED_EVENT = 'persona-switcher:changed'
/** Broadcast when another part of the page changes the size or resets the spot. */
const SIZE_EVENT = 'persona-switcher:mascot-size-changed'
/** Broadcast when the animation preference changes (settings surface to settings surface). */
const MOTION_EVENT = 'persona-switcher:mascot-motion-changed'
const POS_EVENT = 'persona-switcher:mascot-pos-reset'
/** Gap kept between the mascot and every viewport edge, in px. */
const EDGE = 8
/** Default artwork width in px, used until the role reports its own box. */
const DEFAULT_WIDTH = 140
/** How often to re-ask the host "who is this session" and "who has artwork", in ms. */
const POLL_MS = 5000
/**
 * How often to re-ask "which role is this session bound to", in ms, when the
 * host has no counter endpoint.
 *
 * `/role <id>` rebinds the session WITHOUT changing the seat, so a re-read is the
 * only way the mascot can notice a live switch. A host that publishes the
 * revision counter is polled much faster than this (see `REVISION_POLL_MS`);
 * this is the fallback cycle for a host too old to have one.
 */
const SESSION_POLL_MS = 1500
/**
 * How often to ask "has anything I draw changed", in ms.
 *
 * `/role <id>` rebinds a session inside the HOST process and broadcasts nothing
 * to the browser, so there is no signal to listen for — polling is the only way
 * a client can notice. Polling the role itself this often would drag the role's
 * whole prose along every time, so this asks a counter endpoint instead
 * (`GET /revision`: one integer, no disk read) and re-reads the role only when
 * the number moves. That is what makes a switch look instant.
 */
const REVISION_POLL_MS = 250
/** Backoff after a failed role read, in ms. */
const SESSION_RETRY_MS = 8000
/**
 * The cycle used when `/revision` is missing (a 404 from an older host) or
 * unreadable. A normal outcome, not an error: the mascot then re-reads its role
 * on the slow cycle and still catches a live switch within a few seconds.
 */
const REVISION_SLOW_MS = 1500
/** How often to re-probe for a `sidebarRight` service that is not up yet, in ms. */
const PROBE_MS = 250
/** How long to keep probing before falling back to "no seat", in ms (~1 min). */
const PROBE_FOR_MS = 60000

/** `true` while the standalone client module runs (no DOM ⇒ nothing to mount). */
const hasDom = () => typeof document !== 'undefined' && document.body !== null

/** Clamp `v` into `[lo, hi]`, tolerating an inverted range on a tiny viewport. */
const clamp = (v, lo, hi) => Math.min(Math.max(lo, hi), Math.max(lo, v))

/** Read the master switch. Default is ON, and a corrupt value stays ON. */
const readShown = () => {
  try {
    return window.localStorage.getItem(SHOWN_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Read the persisted resting position. A corrupt or non-finite value is
 * treated as "never dragged" (`null`) rather than thrown away silently wrong.
 */
const readPos = () => {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (raw === null || raw === '') return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

/** Persist the resting position; a blocked/full storage must never break the drag. */
const writePos = (pos) => {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }))
  } catch {
    /* ignore */
  }
}

/**
 * Forget the resting position, which is what "reset" means: the next mount (and
 * the running mascot, once it is told) goes back to its corner. A blocked
 * storage is ignored — the broadcast still moves the mascot on screen.
 */
const clearPos = () => {
  try {
    window.localStorage.removeItem(POS_KEY)
  } catch {
    /* ignore */
  }
}

/** Clamp any input (a slider value, a stored string) into the allowed range. */
const clampSize = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 1
  return Math.round(clamp(number, SIZE_MIN, SIZE_MAX) * 100) / 100
}

/** Read the size multiplier. A missing or corrupt value means 1×. */
const readSize = () => {
  try {
    const raw = window.localStorage.getItem(SIZE_KEY)
    return raw === null || raw === '' ? 1 : clampSize(raw)
  } catch {
    return 1
  }
}

/** Persist the size multiplier, clamped. Returns what was stored. */
const writeSize = (value) => {
  const size = clampSize(value)
  try {
    window.localStorage.setItem(SIZE_KEY, String(size))
  } catch {
    /* ignore */
  }
  return size
}

/**
 * Fold any stored value onto one of the three animation preferences. Anything
 * that is not 'always' or 'never' means "follow the system" — a corrupt or
 * hand-edited value must never be able to force an animation on or off.
 * @param value - the raw stored (or handed-in) value.
 * @returns 'system' | 'always' | 'never'.
 */
const normalizeMotion = (value) => (value === 'always' || value === 'never' ? value : 'system')

/** Read the animation preference. A missing, blocked or corrupt value means 'system'. */
const readMotion = () => {
  try {
    return normalizeMotion(window.localStorage.getItem(MOTION_KEY))
  } catch {
    return 'system'
  }
}

/** Persist the animation preference, normalized. Returns what was stored. */
const writeMotion = (value) => {
  const motion = normalizeMotion(value)
  try {
    window.localStorage.setItem(MOTION_KEY, motion)
  } catch {
    /* ignore */
  }
  return motion
}

/** Tell every listener (this page's other components, other windows) what changed. */
const broadcast = (name) => {
  try {
    window.dispatchEvent(new CustomEvent(name))
  } catch {
    /* a host without CustomEvent keeps working through the storage event */
  }
}

/** Subscribe to one broadcast, tolerating a host without `addEventListener`. */
const onBroadcast = (name, listener) => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  window.addEventListener(name, listener)
  return () => window.removeEventListener(name, listener)
}

/** Viewport size, with fallbacks for the pre-layout first frame. */
const viewport = () => ({
  w: window.innerWidth || 1280,
  h: window.innerHeight || 800
})

/**
 * Keep a `WxH` pixel box fully inside the viewport, `EDGE` px away from every
 * edge. This is a soft clamp only: there is no snap to any edge, by design —
 * wherever the user drops the mascot is where it stays.
 */
const fitToViewport = (pos, box) => {
  const { w, h } = viewport()
  const size = box ?? { w: DEFAULT_WIDTH, h: DEFAULT_WIDTH * 1.3 }
  return {
    x: clamp(Math.round(pos.x), EDGE, Math.max(EDGE, w - size.w - EDGE)),
    y: clamp(Math.round(pos.y), EDGE, Math.max(EDGE, h - size.h - EDGE))
  }
}

/** First-run resting spot: vertically parked on the right, clear of the rope's top edge. */
const defaultPos = (box) => {
  const { w, h } = viewport()
  const size = box ?? { w: DEFAULT_WIDTH, h: DEFAULT_WIDTH * 1.3 }
  return fitToViewport({ x: w - size.w - 24, y: Math.round(h * 0.62) }, size)
}

/** Current size of the rendered artwork box, or the fallback when not painted yet. */
const boxOf = (node) => {
  if (node !== null && node.offsetWidth > 0 && node.offsetHeight > 0) {
    return { w: node.offsetWidth, h: node.offsetHeight }
  }
  return null
}

/**
 * Box size for the position maths: the painted box when there is one — it
 * already includes the size multiplier, because the multiplier is CSS on the
 * wrapper — and the declared width times the multiplier otherwise.
 */
const boxSize = (nodeRef, width, size = 1) => boxOf(nodeRef.current) ?? estimatedBox(width, size)

/** The same, for a node the caller already holds. */
const boxSizeOf = (node, width, size = 1) => boxOf(node) ?? estimatedBox(width, size)

/**
 * The box before the browser has laid it out. The image fills the wrapper's
 * width and keeps its ratio, so the height is the declared ratio — 1.3 is the
 * first-frame guess `styles` uses, and it is corrected on the next commit.
 */
const estimatedBox = (width, size) => ({ w: width * size, h: Math.round(width * size * 1.3) })

/**
 * The position the mascot should take from storage: the remembered one clamped
 * to the viewport, or the default corner. Shared by the first mount and the
 * explicit reset, so "reset" cannot drift away from "never dragged".
 *
 * @param box - the box the position must fit, already including the size.
 */
const positionFromStorage = (box) => {
  const stored = readPos()
  return stored === null ? defaultPos(box) : fitToViewport(stored, box)
}

/**
 * Minimal API call.
 *
 * Returns `{ ok, value }` rather than the payload alone, because "the host
 * answered null" and "the request never arrived" are different facts and the
 * poll cadence depends on telling them apart: a failed read has to back off,
 * while a valid empty answer must keep the normal cycle. Collapsing both to
 * `null` — as this did — made every backoff branch unreachable.
 *
 * A mascot is decoration, so nothing here throws: an outage degrades to "read
 * failed", which the callers handle.
 *
 * @param path - endpoint path without the base prefix.
 * @param signal - abort signal for the owning effect.
 * @returns `{ ok, value }` where `value` is null unless the host answered JSON.
 */
const api = async (path, signal) => {
  try {
    const response = await fetch(`${API_BASE}${path}`, { signal })
    // A non-2xx is a real answer about this endpoint (an old host's 404 on
    // /revision, say), so it is reported as a successful read with no value:
    // the caller must NOT treat it as an outage and back off forever.
    if (!response.ok) return { ok: true, value: null }
    return { ok: true, value: await response.json() }
  } catch {
    return { ok: false, value: null }
  }
}

/**
 * The role's usable artwork, or `null` when this client cannot show it.
 *
 * The host is the sole judge of what "bound" means, so a non-null `mascot` is
 * taken at face value — except for the box. That one is re-validated here on
 * purpose: the size comes from `mascot-map.json`, which is a file a human can
 * hand-edit, and a broken box must make the role count as unbound rather than
 * silently render at some fallback width. A `WxH` string is the only accepted
 * spelling, and it is what decides the rendered size.
 */
const artOf = (roles, roleId) => {
  if (typeof roleId !== 'string' || roleId === '') return null
  const role = roles.find((item) => item?.id === roleId)
  const mascot = role?.mascot
  if (mascot === null || mascot === undefined) return null
  if (typeof mascot.image !== 'string' || mascot.image === '') return null
  const match = /^(\d+)x(\d+)$/.exec(String(mascot.box ?? ''))
  if (match === null) return null
  const width = Number(match[1])
  if (!Number.isFinite(width) || width <= 0) return null
  // The natural rendered height at that width: the box is `width x height`, so
  // painted `width`px wide it is `height`px tall. The flip's card box needs it
  // (its two faces are absolutely positioned and contribute no height of their
  // own); everything else still keys on `width` alone.
  const height = Number(match[2])
  return {
    role: roleId,
    label: typeof role.name === 'string' && role.name !== '' ? role.name : roleId,
    src: mascot.image,
    width,
    height
  }
}

/**
 * The flip transition, browser half: replacing one artwork with another looks
 * like turning a card over — the old art is the FRONT face, the new art the BACK
 * face (pre-rotated 180deg), and the card turns ~1s about its vertical centre
 * axis, eased in-out so it moves fastest through the edge-on 90deg. The card
 * stays flat on the table: no lift, no shadow, and (as everywhere in this file)
 * no CSS `filter` — whose permanent layer over the wallpaper is the white-flash
 * lesson recorded at the top.
 *
 * This is a PRESENTATION layer over detection, which is unchanged: the
 * `/revision` counter still notices a `/role` switch, and this code only decides
 * how the swap is shown. It runs for a REPLACEMENT only (old and new both on
 * screen); a first appearance or an unbind keeps the plain opacity fade the
 * wrapper already had.
 */
/** Total run time of the flip keyframes, in ms. The JS commit falls back to this. */
const FLIP_TOTAL_MS = 1000
/** Grace past the keyframes before the JS commits the flip on its own. */
const FLIP_COMMIT_MARGIN_MS = 200

/**
 * Decide how the next frame paints the artwork. Pure, so the state machine is
 * verified without a browser:
 *
 *   - target gone         -> drop everything (the wrapper's fade hides it);
 *   - nothing shown yet   -> show the target directly (a first appearance);
 *   - same artwork        -> adopt it (a new label, or two roles sharing one URL),
 *                            with no animation;
 *   - reduced motion      -> swap in place. The swap SURVIVES, the 1s turn does
 *                            not — the same stance the hover growth takes: keep
 *                            the feedback, drop the easing;
 *   - a real replacement  -> keep the old art as the FRONT face and flip the new
 *                            art in as the BACK face.
 *
 * @param target - the artwork the session now wants, or null.
 * @param displayed - the artwork currently settled on screen, or null.
 * @param reduced - whether the user asked for reduced motion.
 * @returns `{ displayed, flip }` for the next frame.
 */
const planFlip = (target, displayed, reduced) => {
  if (target === null) return { displayed: null, flip: null }
  if (displayed === null) return { displayed: target, flip: null }
  if (displayed.src === target.src) return { displayed: target, flip: null }
  if (reduced) return { displayed: target, flip: null }
  return { displayed, flip: { to: target } }
}

/**
 * Should a replacement swap in place instead of turning?
 *
 * The plugin's own animation preference (MOTION_KEY) wins when it has one:
 * 'always' turns even under the OS's reduced-motion — a machine whose Windows
 * animation switch is off need not lose the turn — and 'never' swaps in place
 * even where the OS allows animation. The default, 'system', follows
 * `prefers-reduced-motion`; an absent matchMedia reads as "no reduce".
 * @returns whether the turn should be skipped.
 */
const reducedMotion = () => {
  const motion = readMotion()
  if (motion === 'always') return false
  if (motion === 'never') return true
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * Decode an artwork URL before it becomes the BACK face, so the turn never
 * reveals an empty box. Resolves `true` once the bytes are decoded, `false` when
 * the URL will not decode — the caller then skips the card turn and settles on
 * the target directly, letting the settled image's own `onError` drop a truly
 * broken role. A host without `Image` (the simulation harness) resolves `true`
 * immediately, so the flip path is what the headless checks exercise.
 *
 * @param src - the artwork URL to warm.
 * @returns a promise resolving to whether the artwork decoded.
 */
const preloadArtwork = (src) =>
  new Promise((resolve) => {
    if (typeof Image !== 'function') {
      resolve(true)
      return
    }
    const probe = new Image()
    probe.onload = () => resolve(true)
    probe.onerror = () => resolve(false)
    probe.src = src
  })

/**
 * Follow a snapshot-like value (`getSnapshot` / `subscribe`). Absent, partial or
 * non-observable values all collapse to `undefined` — "there is no seat on
 * screen", which is a normal state, not an error.
 * @returns the current value plus an unsubscribe function.
 */
const followSnapshot = (snapshot, listener) => {
  if (snapshot === null || typeof snapshot !== 'object') return { value: undefined, stop: null }
  let value
  try {
    value = typeof snapshot.getSnapshot === 'function' ? snapshot.getSnapshot() : undefined
  } catch {
    value = undefined
  }
  // The listener reads `current.value`, never the initial `value`: a snapshot
  // that fires synchronously on subscribe must not be seen as a stale read.
  const current = { value }
  let stop = null
  try {
    if (typeof snapshot.subscribe === 'function') {
      const off = snapshot.subscribe(() => {
        try {
          current.value = typeof snapshot.getSnapshot === 'function' ? snapshot.getSnapshot() : undefined
        } catch {
          current.value = undefined
        }
        listener()
      })
      if (typeof off === 'function') stop = off
    }
  } catch {
    stop = null
  }
  return { value, current, stop }
}

/** Does this service look like the host's `sidebarRight` (with a `mounted` snapshot)? */
const isSeatService = (service) =>
  service !== null &&
  typeof service === 'object' &&
  service.mounted !== null &&
  typeof service.mounted === 'object'

/**
 * Normalise a `mounted` reading to a session id or `undefined`.
 *
 * `undefined` is the documented "no seat on screen" reading, but the snapshot
 * lives in the shell and an empty string has to mean the same thing here: the
 * value is interpolated straight into `/session?session=<id>`, so a blank id
 * would be a request that can only 404 — and, worse, one that keeps the mascot
 * permanently blank instead of simply absent. Anything that is not a non-empty
 * string is "no seat".
 */
const seatIdOf = (value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const STYLE_TEXT = `
#${DOCK_ID} { display: contents; }
.ps-mascot {
  position: fixed;
  left: 0;
  top: 0;
  /* The size multiplier lives on the wrapper, so the artwork keeps its own
     aspect ratio and the drag can still measure the painted box. */
  transform: scale(var(--ps-scale, 1));
  transform-origin: top left;
  z-index: 995;                 /* below the wallpaper engine's rope (996) */
  box-sizing: border-box;
  cursor: grab;
  opacity: 0;
  pointer-events: none;         /* hidden ⇒ never in the hit-test path */
  touch-action: none;           /* keep the pointer stream unbroken while dragging */
  user-select: none;
  -webkit-user-select: none;
  /* A hidden mascot must not cost a compositing layer or an image decode: the
     dock is display:contents, so the artwork box is still in layout. */
  visibility: hidden;
  transition: opacity 150ms cubic-bezier(0.16, 1, 0.3, 1);
}
.ps-mascot.is-shown {
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
}
.ps-mascot.is-dragging {
  cursor: grabbing;
  transition: none;             /* follow the pointer 1:1 while the hand is down */
}
.ps-mascot__art {
  display: block;
  width: 100%;
  height: auto;
  pointer-events: none;         /* the box owns the drag, the image never eats it */
  transform-origin: center;
  /* Hover growth, matched to the wallpaper engine's rope art (.we-rope__art):
     the same 1.06 on the same 120ms/ease timing. The growth is on the IMAGE, so
     the box keeps the size it was dragged to — the drag maths never sees it, and
     the element stays exactly where the user put it. */
  transition: transform 120ms ease;
}
.ps-mascot:hover .ps-mascot__art {
  transform: scale(1.06);
}
/* ── The flip: a card with a face on each side, turned on its vertical axis ──
   Only present while .is-flipping is on the box, i.e. for the ~1s a role is
   being replaced. The stage owns the perspective; the card owns the turn; the
   two faces are the OLD art (front) and the NEW art (back). Both faces hide
   their back side (backface-visibility), so as the card turns past 90deg the
   front vanishes and the pre-rotated back swings into view — the paper-flip.
   object-fit: contain lets a predecessor of a different aspect letterbox into
   the new box instead of stretching. The card stays flat throughout: no lift,
   no shadow, and (per the coexistence rule at the top of this file) no filter.
   Reduced motion never reaches here: planFlip settles the swap in place, so no
   card is rendered at all (the effect survives, the 1s turn does not). */
.ps-mascot__stage {
  position: relative;
  width: 100%;
  /* The height is set inline from the incoming art's box, so the card has real
     bounds to turn within instead of collapsing to zero. */
  perspective: 700px;             /* depth for the turn; larger = gentler */
  pointer-events: none;           /* the box keeps the drag through the turn */
}
.ps-mascot__card {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;   /* the faces stay in the card's 3D space */
  transform-origin: center center; /* the vertical mid-line: the flip axis */
  animation: ps-flip 1000ms both;
}
.ps-mascot__face {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;            /* never stretch a differently-shaped face */
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  pointer-events: none;           /* the faces never eat the drag */
}
.ps-mascot__face--front {
  transform: rotateY(0deg);
}
.ps-mascot__face--back {
  transform: rotateY(180deg);     /* pre-turned, so it faces out as the card lands */
}
/* The turn, and nothing else: the card rotates about its vertical mid-line from
   face-on to face-on, eased in-out so it moves fastest through the edge-on 90deg
   (where the axis reads as the image's own centre). The card stays flat on the
   table throughout — no lift, no shadow. */
@keyframes ps-flip {
  0% {
    transform: rotateY(0deg);
    animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1);
  }
  100% {
    transform: rotateY(180deg);
  }
}
/* A user who asked for reduced motion gets the SAME hover growth, applied
   instantly instead of animated. An earlier version cancelled the transform
   here, which silently removed the effect for every such user — and "reduce"
   is not rare: Chromium infers it from Windows' own animation setting, so a
   machine with "show animations" off reported reduce and the mascot stopped
   responding to the pointer entirely. Growing a little is the feedback; the
   120ms of easing is the part that is optional. */
@media (prefers-reduced-motion: reduce) {
  .ps-mascot { transition: none; }
  .ps-mascot__art { transition: none; }
}
`

/**
 * Install the mascot stylesheet once. Guarded for the simulation harness (no
 * DOM) and idempotent across bundle re-execution; the rules are static, so
 * there is nothing to uninstall on dispose.
 */
const installStyle = () => {
  if (!hasDom() || document.head === null) return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
}

/**
 * The mascot itself: resolves the on-screen session's role, fetches its artwork
 * and keeps it draggable. Mounted only while the master switch is on, so every
 * effect here is also the definition of "the switch is off ⇒ no requests".
 * @param props - the host context (`ctx`) and the bound dictionary.
 */
const PersonaMascot = (props) => {
  const { ctx, t } = props
  const [seat, setSeat] = useState(undefined)
  const [session, setSession] = useState(null)
  const [roles, setRoles] = useState([])
  const [size, setSize] = useState(() => readSize())
  /**
   * The last revision the host published.
   *
   * Non-null only after a counter answer moved, so this is both the trigger for
   * a role re-read and the record of what the host last reported. It renders
   * nothing: it exists to re-run the role effect.
   */
  const [revision, setRevision] = useState(null)
  /**
   * `true` while the host answers the revision counter.
   *
   * Reported for diagnostics (and asserted in the harness) so "the mascot is
   * slow because this host has no counter" is distinguishable from "the mascot
   * is slow".
   */
  const [fast, setFast] = useState(false)
  /** Last value published to `fast`, so a no-op poll does not re-render. */
  const fastRef = useRef(false)
  const reportFast = (value) => {
    if (fastRef.current === value) return
    fastRef.current = value
    setFast(value)
  }
  const nodeRef = useRef(null)
  const dragRef = useRef(null)
  /**
   * The role re-read cycle: fast when the host publishes a counter, slow when it
   * does not, and slow while this window is hidden.
   *
   * Read through the ref, not the state variable: the poll effect is not re-run
   * when `fast` changes, so a captured `fast` would keep a stale cadence — an
   * old host's slow answer would arrive but the loop would carry on at full
   * speed, and a downed host could never be backed off at all.
   */
  const pollMs = () => {
    if (document.visibilityState === 'hidden') return REVISION_SLOW_MS
    return fastRef.current ? REVISION_POLL_MS : REVISION_SLOW_MS
  }

  // Condition b: a session seat is on screen. The service may not be registered
  // yet at boot (the wallpaper engine polls for the same reason), so a missing
  // service probes briefly; a present service reporting `undefined` means "no
  // seat on screen" and is taken at face value.
  useEffect(() => {
    let cancelled = false
    let stop = null
    let timer = null
    const start = Date.now()
    const arm = () => {
      if (cancelled) return
      const service = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null
      if (service === undefined || service === null) {
        // A service that is not up yet is normal at boot, but giving up for the
        // rest of the app's life is not: past the eager window this settles into
        // a slow probe, so a late registration still gets a mascot.
        const delay = Date.now() - start < PROBE_FOR_MS ? PROBE_MS : POLL_MS
        timer = window.setTimeout(arm, delay)
        return
      }
      if (!isSeatService(service)) {
        // The service exists but does not report a seat yet — a different state
        // from "there is no seat". Keep watching rather than stopping here.
        setSeat(undefined)
        timer = window.setTimeout(arm, PROBE_MS)
        return
      }
      const followed = followSnapshot(service.mounted, () => {
        if (cancelled) return
        // A seat change is also the hysteresis trigger: `session` is cleared so
        // the previous artwork fades out before the new one appears.
        setSession(null)
        setSeat(seatIdOf(followed.current.value))
      })
      stop = followed.stop
      // `followed.current`, not `followed.value`: the subscription may already
      // have fired, and the later value would then be the stale one.
      setSeat(seatIdOf(followed.current.value))
    }
    arm()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (stop !== null) {
        try {
          stop()
        } catch {
          /* ignore */
        }
      }
    }
  }, [ctx])

  // Condition c: that session's role.
  //
  // Polled, not read once. `/role <id>` changes the binding in the middle of a
  // live session without changing the seat, so a read that only happened when the
  // seat changed left the mascot showing the OLD role until the user left and
  // re-entered the conversation.
  //
  // The cadence depends on the host: a host with the revision counter is polled
  // every 250ms and this read follows a counter change immediately (`revision` is
  // a dependency), while an older host without one falls back to a 1.5s cycle.
  //
  // This also covers the reverse: `/role none` makes it stop, and a role whose
  // artwork the host no longer knows about stops with it.
  useEffect(() => {
    if (seat === undefined || seat === null) {
      setSession(null)
      return undefined
    }
    const controller = new AbortController()
    let cancelled = false
    let timer = null
    let reported
    // The first answer after this effect (re)starts must be published even when
    // it is `null`. A revision bump restarts the effect, and a local cache that
    // began at `null` made `/role none` look like "no change": the old artwork
    // stayed until the seat changed. Later identical answers are still ignored,
    // so a steady role does not restart the artwork's fade every cycle.
    let first = true
    /** `true` once a read has failed, so the cycle backs off instead of hammering. */
    let failing = false
    const load = async () => {
      const read = await api(`/session?session=${encodeURIComponent(String(seat))}`, controller.signal)
      if (cancelled || controller.signal.aborted) return
      failing = !read.ok
      const payload = read.ok ? read.value : null
      // `liveRoleId` is the role in force; `roleId` is the remembered choice.
      // They can disagree (a session inheriting the configured default has no
      // memory, and a failed memory write can leave a stale id behind), so the
      // mascot draws the live one. An older host has only `roleId`; an explicit
      // `liveRoleId: null` must not fall back to the memory.
      const roleId =
        payload === null ? null : Object.hasOwn(payload, 'liveRoleId') ? payload.liveRoleId : payload.roleId
      const next = typeof roleId === 'string' && roleId !== '' ? roleId : null
      // Only a CHANGE republishes: an identical answer every cycle must not
      // re-render the mascot (and must not restart the artwork's fade). The
      // first answer is always published, including `null` — see `first`.
      if (first || next !== reported) {
        first = false
        reported = next
        setSession(next)
      }
    }
    const arm = (delay) => {
      timer = window.setTimeout(async () => {
        // The id has fired, so it must not be treated as a live timer any more:
        // leaving it there is what let `visibilitychange` and this callback both
        // schedule the next tick, silently doubling the chain.
        timer = null
        if (cancelled) return
        await load()
        if (cancelled) return
        // `failing` is set by the read itself, so the backoff is reachable. The
        // cadence is read from the ref, not from a captured `fast`, so a host
        // that turns out to be an old one slows down without waiting for a
        // revision change that a downed host could never send.
        arm(failing ? SESSION_RETRY_MS : pollMs())
      }, delay)
    }
    // Read immediately when the seat appears — arriving in a session must not
    // wait for a poll cycle — then keep asking on the current cycle.
    void load()
    arm(pollMs())
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      controller.abort()
    }
  }, [seat, revision])

  // The fast question: "has anything I draw changed?"
  //
  // Nothing is broadcast when a session is rebound, so this counter is how a
  // `/role` switch reaches the browser at all. It publishes state only when the
  // number MOVES, which re-runs the role read above through its dependency — so
  // a switch is picked up in one poll cycle rather than one role cycle.
  //
  // A 404 means the host predates this endpoint. That is a normal answer, not a
  // failure: the cadence drops to the slow one and the mascot keeps working.
  useEffect(() => {
    let cancelled = false
    let timer = null
    let last = null
    /** True only while a read is actually running. */
    let inFlight = false
    // A hidden window is not being looked at, so it does not need quarter-second
    // answers: it falls back to the slow cycle (and asks once on the way back,
    // so returning to the window is still immediate).
    const cadence = () => (document.visibilityState === 'hidden' ? REVISION_SLOW_MS : REVISION_POLL_MS)
    const ask = async () => {
      inFlight = true
      try {
        const read = await api('/revision', undefined)
        if (cancelled) return false
        // An unanswered read backs off; a 404 is an ANSWER (this host predates
        // the endpoint) and only means the slow cycle, never a retry storm.
        if (!read.ok) return false
        const next = read.value === null ? null : Number(read.value.revision)
        if (!Number.isFinite(next)) {
          reportFast(false)
          return true
        }
        reportFast(true)
        if (last !== null && next !== last) setRevision(next)
        last = next
        return true
      } finally {
        inFlight = false
      }
    }
    const arm = (delay) => {
      timer = window.setTimeout(async () => {
        // Null it the moment it fires, so a pending timer is never mistaken for
        // a spent one.
        timer = null
        if (cancelled) return
        const ok = await ask()
        if (cancelled) return
        // Exactly one chain: by now `timer` is null either way, so this is the
        // only place a new tick is scheduled from the timer path.
        if (timer === null) arm(ok ? cadence() : REVISION_SLOW_MS)
      }, delay)
    }
    arm(cadence())
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      // A read already in flight will schedule the next tick itself, so arming
      // here would start a SECOND chain — that is what permanently doubled the
      // poll rate after a hide/show. Otherwise, ask at once.
      if (inFlight) return
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      arm(0)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Condition d: which roles have artwork. Re-read while a seat is on screen
  // (catches a role switch made from the settings page, another window, or the
  // command line) and eagerly on the settings page's change broadcast.
  useEffect(() => {
    if (seat === undefined || seat === null || session === null) return undefined
    const controller = new AbortController()
    let timer = null
    let cancelled = false
    /** One read at a time: a broadcast and a timer must not stack up. */
    let inFlight = false
    const load = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      let ok = false
      try {
        const read = await api('/roles', controller.signal)
        if (cancelled || controller.signal.aborted) return
        ok = read.ok
        const payload = read.ok ? read.value : null
        if (payload !== null && Array.isArray(payload.roles)) setRoles(payload.roles)
      } finally {
        inFlight = false
      }
      if (cancelled) return
      // A failed read keeps the artwork it already has and retries on the slow
      // cycle. It MUST still schedule the next attempt: the old version set its
      // timer after the await, so one failed fetch stopped this loop for good
      // and a role whose artwork was imported from the settings page never
      // appeared. Re-arming here also keeps exactly ONE chain alive.
      timer = window.setTimeout(() => void load(), ok ? POLL_MS : SESSION_RETRY_MS)
    }
    /** A broadcast starts a fresh read and cancels the one the timer had queued. */
    const onChanged = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      void load()
    }
    void load()
    window.addEventListener(CHANGED_EVENT, onChanged)
    return () => {
      cancelled = true
      window.removeEventListener(CHANGED_EVENT, onChanged)
      if (timer !== null) window.clearTimeout(timer)
      controller.abort()
    }
  }, [seat, session])

  // Condition a, second reader: the settings page owns this switch; here it is
  // only re-read on its broadcast or when another window changes the value.
  useEffect(() => {
    const onStored = (event) => {
      // A `storage` event carries `key`; this plugin's own CustomEvent does not.
      // Requiring `undefined` here as well is what keeps the in-window broadcast
      // working — the guard used to reject it, so a second settings surface kept
      // a stale toggle until the page reloaded.
      if (event.key !== undefined && event.key !== null && event.key !== SHOWN_KEY) return
      props.onShown(readShown())
    }
    window.addEventListener('storage', onStored)
    window.addEventListener(SHOWN_EVENT, onStored)
    return () => {
      window.removeEventListener('storage', onStored)
      window.removeEventListener(SHOWN_EVENT, onStored)
    }
  }, [props])

  const art = session === null ? null : artOf(roles, session)

  // ── The flip transition ─────────────────────────────────────────────────
  // `displayed` is the artwork painted on screen: the settled single image, or
  // the FRONT face while a card turn runs. `flip` is the incoming BACK face
  // during a turn, else null. They are split from `art` (the host's current want)
  // so a replacement can keep showing the OLD art while the new one decodes and
  // turns, instead of hard-swapping `src`. Refs mirror both so the commit path —
  // an animationend, a fallback timer — reads the live value rather than the one
  // captured when it was created.
  const [displayed, setDisplayed] = useState(null)
  const [flip, setFlip] = useState(null)
  const displayedRef = useRef(null)
  const flipRef = useRef(null)
  /** Bumps on every target change so a superseded preload cannot commit. */
  const flipGen = useRef(0)

  /** Paint one artwork as the settled image and end any turn. */
  const settle = (next) => {
    displayedRef.current = next
    flipRef.current = null
    setDisplayed(next)
    setFlip(null)
  }
  /** Land a running turn on its BACK face (the newest target). */
  const commitFlip = () => {
    const current = flipRef.current
    if (current === null) return
    settle(current.to)
  }

  // The stable identity the transition effect keys on. `art` is a fresh object
  // every render (artOf builds it), so depending on it would re-run per frame;
  // the source URL is what actually changes when a role or its artwork is
  // swapped. Two roles sharing one URL therefore read as "no change" — correct:
  // the pixels on screen are identical.
  const targetKey = art === null ? null : art.src

  /**
   * What the box is sized to and (when settled) what src is painted.
   *
   * During a turn it is the INCOMING art (the box already has the new width, so
   * the width switch happens under the cover of the rotation). When settled it is
   * the displayed art. On the one render where the host has just named a role but
   * the transition effect has not settled it yet, it falls back to `art` so the
   * mascot never paints an empty frame.
   *
   * `art` (the host's current want) is what drives VISIBILITY, so clearing a role
   * still hides the mascot in the same render it did before the flip existed.
   */
  const visible = art !== null
  const painting = flip !== null ? flip.to : displayed !== null ? displayed : art
  const width = visible ? painting.width : DEFAULT_WIDTH

  useEffect(() => {
    const gen = ++flipGen.current
    const plan = planFlip(art, displayedRef.current, reducedMotion())
    if (plan.flip === null) {
      settle(plan.displayed)
      return undefined
    }
    // Decode the new artwork first so the turn never reveals an empty box. A
    // failed decode skips the turn and settles on the target, letting the
    // settled image's own onError drop a truly broken role.
    let cancelled = false
    void preloadArtwork(plan.flip.to.src).then((ok) => {
      if (cancelled || flipGen.current !== gen) return
      if (!ok) {
        settle(art)
        return
      }
      displayedRef.current = plan.displayed
      flipRef.current = plan.flip
      setDisplayed(plan.displayed)
      setFlip(plan.flip)
    })
    return () => {
      cancelled = true
    }
  }, [targetKey])

  // The commit normally comes from the card's own animationend. This fallback
  // guarantees the turn lands even where that event never fires (a hidden tab
  // pausing CSS animations, say): the mascot must never be stuck mid-turn showing
  // two half-faded faces. It re-arms whenever the BACK face changes, so a turn
  // retargeted to a newer role still commits that newest one.
  useEffect(() => {
    if (flip === null) return undefined
    const timer = window.setTimeout(() => commitFlip(), FLIP_TOTAL_MS + FLIP_COMMIT_MARGIN_MS)
    return () => window.clearTimeout(timer)
  }, [flip])

  // The resting position is owned by React; the drag writes it imperatively
  // between commits so a pointer move never enters the render path. Only a drop
  // writes it back to storage — a resize re-clamp is a display constraint, not
  // an instruction, so it never persists.
  //
  // It is read from storage ONCE, here. Re-reading it whenever something
  // unrelated changed (the artwork width, say) would yank a mascot the user had
  // just placed back to the last persisted spot, which is the one thing this
  // component must never do. `dragged` marks the point after which only the user
  // (or an explicit reset) moves it.
  const dragged = useRef(false)
  const [pos, setPos] = useState(() => positionFromStorage(estimatedBox(width, readSize())))

  useEffect(() => {
    const node = nodeRef.current
    if (pos === null || node === null) return
    node.style.left = `${pos.x}px`
    node.style.top = `${pos.y}px`
  }, [pos])

  // The first frame cannot measure the artwork (it is not in the DOM yet), so
  // once the real box is known an untouched position is re-clamped against it —
  // otherwise a tall artwork could sit with its bottom below the viewport.
  useEffect(() => {
    if (dragged.current) return
    setPos((current) => (current === null ? current : fitToViewport(current, boxSize(nodeRef, width, size))))
  }, [width, size])

  // Size and reset are decided in ANOTHER component (the settings page, same
  // bundle), which talks to this one through the broadcasts below. The storage
  // event covers the same change made from a second window, where no event of
  // ours crosses. Both the switch and the size are plain reads, so a listener
  // only has to force a re-read.
  useEffect(() => onBroadcast(SIZE_EVENT, () => setSize(readSize())), [])

  useEffect(() => {
    const reset = () => {
      dragged.current = false
      setPos(positionFromStorage(boxSize(nodeRef, width, size)))
    }
    const off = onBroadcast(POS_EVENT, reset)
    const onStored = (event) => {
      if (event.key !== null && event.key !== POS_KEY) return
      reset()
    }
    window.addEventListener('storage', onStored)
    return () => {
      off()
      window.removeEventListener('storage', onStored)
    }
  }, [width, size])

  // A resize re-clamps what is on screen, in memory only: hiding the clamp from
  // storage is deliberate, so a window that briefly shrinks and grows back
  // leaves the mascot where the user dragged it.
  useEffect(() => {
    const onResize = () => {
      // Never re-clamp a mascot the hand is currently holding: committing a
      // position mid-drag would teleport it away from the pointer.
      if (dragRef.current !== null) return
      setPos((current) => (current === null ? current : fitToViewport(current, boxSize(nodeRef, width, size))))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [width, size])

  const onPointerDown = (event) => {
    const node = nodeRef.current
    if (node === null || dragRef.current !== null) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (pos === null) return
    try {
      node.setPointerCapture(event.pointerId)
    } catch {
      /* ignore: capture is an optimisation, the move handler still guards on id */
    }
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: pos.x,
      baseY: pos.y,
      moved: false
    }
    node.classList.add('is-dragging')
    event.preventDefault()
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    const node = nodeRef.current
    if (drag === null || node === null || drag.id !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && dx * dx + dy * dy < 9) return // 3px dead zone: jitter is not a drag
    drag.moved = true
    const next = fitToViewport({ x: drag.baseX + dx, y: drag.baseY + dy }, boxSizeOf(node, width, size))
    node.style.left = `${next.x}px`
    node.style.top = `${next.y}px`
  }

  /** End a drag. `persist` is false only for a cancelled pointer. */
  const endDrag = (event, persist) => {
    const drag = dragRef.current
    const node = nodeRef.current
    if (drag === null || drag.id !== event.pointerId) return
    dragRef.current = null
    if (node === null) return
    node.classList.remove('is-dragging')
    try {
      node.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    const moved = drag.moved && persist
    const target = moved
      ? { x: drag.baseX + (event.clientX - drag.startX), y: drag.baseY + (event.clientY - drag.startY) }
      : { x: drag.baseX, y: drag.baseY }
    const next = fitToViewport(target, boxSizeOf(node, width, size))
    // Written imperatively as well as through state: when the clamped result
    // equals the last committed value React skips the style diff, and the box
    // would stay wherever the hand left it.
    node.style.left = `${next.x}px`
    node.style.top = `${next.y}px`
    setPos(next)
    if (persist) writePos(next)
    // From here on the position belongs to the user: no re-clamp on a width
    // change, and no re-read from storage.
    if (moved) dragged.current = true
  }

  const onPointerUp = (event) => endDrag(event, true)
  const onPointerCancel = (event) => endDrag(event, false)

  // The card's own turn finished (or a face's did not): land the newest target.
  // Guarding on target===currentTarget keeps a child's stray animationend from
  // committing a turn that is still running.
  const onFlipEnd = (event) => {
    if (event.target != null && event.currentTarget != null && event.target !== event.currentTarget) return
    commitFlip()
  }

  const artNode = !visible
    ? null
    : flip !== null
      ? h(
          'div',
          { className: 'ps-mascot__stage', style: { height: `${flip.to.height}px` } },
          h(
            'div',
            { className: 'ps-mascot__card', onAnimationEnd: onFlipEnd },
            // Front face: the art already on screen. `object-fit: contain` lets a
            // predecessor of another ratio letterbox into the new box instead of
            // stretching. Both faces are inert so they never eat the drag.
            h('img', {
              className: 'ps-mascot__face ps-mascot__face--front',
              src: displayed.src,
              alt: '',
              draggable: false,
              decoding: 'async'
            }),
            // Back face: the incoming art, pre-rotated so it faces the viewer as
            // the card lands.
            h('img', {
              className: 'ps-mascot__face ps-mascot__face--back',
              src: flip.to.src,
              alt: '',
              draggable: false,
              decoding: 'async'
            })
          )
        )
      : h('img', {
          className: 'ps-mascot__art',
          src: painting.src,
          alt: '',
          draggable: false,
          decoding: 'async',
          onError: () => {
            // A URL that fails to decode must not leave a ghost box behind:
            // dropping the role from the local table makes `artOf` return null.
            setRoles((current) => current.filter((item) => item?.id !== painting.role))
          }
        })

  const className = !visible
    ? 'ps-mascot'
    : flip !== null
      ? 'ps-mascot is-shown is-flipping'
      : 'ps-mascot is-shown'

  return h(
    'div',
    {
      ref: nodeRef,
      className,
      style: { width: `${width}px`, '--ps-scale': String(size) },
      role: 'img',
      'aria-label': visible ? `${t('mascotAria')}: ${art.label}` : t('mascotAria'),
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu: undefined
    },
    artNode
  )
}

/**
 * The master switch gate. Keeping the switch outside `PersonaMascot` is what
 * makes "off" mean "silent": switching the gate off unmounts the mascot, and
 * its effects are the only thing that would ever ask the host anything.
 * @param props - the host context (`ctx`), the bound dictionary and the switch reader.
 */
const MascotGate = (props) => {
  const [shown, setShown] = useState(() => readShown())
  const { onShown } = props
  useEffect(() => {
    onShown(shown)
  }, [shown, onShown])
  // The switch can be flipped from the settings page (or a second window), so
  // the gate listens as well: with the switch off this component would otherwise
  // never mount, and the user would have to reload the app to get it back.
  useEffect(() => {
    const reread = () => setShown(readShown())
    const off = onBroadcast(SHOWN_EVENT, reread)
    const onStored = (event) => {
      if (event.key !== null && event.key !== SHOWN_KEY) return
      reread()
    }
    window.addEventListener('storage', onStored)
    return () => {
      off()
      window.removeEventListener('storage', onStored)
    }
  }, [])
  if (!shown) return null
  return h(PersonaMascot, { ...props, shown, onShown: setShown })
}

/**
 * The live mascot root, kept at module scope so a re-apply REUSES it.
 *
 * This is not an optimisation, it is a correctness fix. The host calls the
 * plugin's effect, and it may call it again (a reload, a re-apply, any host
 * that re-runs effects). The first version removed the dock on disposal, so the
 * second install created a NEW React root on the SAME node while the first
 * root's deferred unmount was still queued — and that deferred teardown then
 * deleted the shared node. The mascot vanished with no error anywhere: the dock
 * was gone, no exception was ever reported, and the settings page was fine,
 * which is exactly how it was reported from a real machine.
 *
 * So: the dock belongs to the module, not to one install. Install mounts into it
 * (or re-renders into the root that is already there), and disposal only unmounts
 * the CONTENT — it never removes the node.
 */
let liveHost = null
let liveRoot = null

/**
 * Install the mascot under its own React root on `<body>`, reusing the dock and
 * the root across installs.
 *
 * The host is feature-detected (`react-dom` without `createRoot`, or a missing
 * `body`) so a minimal host or a mock stays safe: nothing is created and
 * nothing throws. Failure to render is contained — a mascot must never be able
 * to take the app down.
 *
 * @param ctx - the browser plugin context.
 * @param t - the bound dictionary.
 * @returns a disposer that unmounts the mascot but leaves its dock in place, or
 *   `undefined` when the host offers no DOM to mount into.
 */
export const installMascot = (ctx, t) => {
  if (!hasDom()) return undefined
  if (typeof createRoot !== 'function') return undefined
  if (typeof ctx?.effect !== 'function') return undefined

  // Reuse the dock even if something outside this module removed it from the
  // document: the node React is mounting into must stay the node that is on
  // screen, and a stale `liveRoot` must not be handed a new container.
  let host = liveHost
  if (host === null || host.parentNode === null) {
    host = document.getElementById(DOCK_ID)
    if (host === null) {
      host = document.createElement('div')
      host.id = DOCK_ID
    }
    if (host.parentNode === null) document.body.appendChild(host)
    liveHost = host
    // The dock changed identity, so the old root (if any) is attached to a node
    // that is no longer on screen. Drop the reference; a new root is created
    // below. Re-mounting the old one here would mean two roots on the same node,
    // which React refuses mid-render.
    liveRoot = null
  }

  const root = liveRoot ?? createRoot(host)
  try {
    root.render(h(MascotGate, { ctx, t, onShown: () => {} }))
  } catch (error) {
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn('persona-switcher: mascot failed to mount', error)
    }
    // A render that threw synchronously is a broken mount, not a disposable one:
    // leave nothing behind. `unmountLater` is what makes this safe to do here.
    liveHost = null
    liveRoot = null
    unmountLater(root, host)
    return undefined
  }
  liveRoot = root

  installStyle()

  // Content only. The node stays, with the root still attached, so the next
  // install re-renders into it instead of racing an unmount of it.
  return () => {
    if (liveRoot === root) liveRoot = null
    root?.unmount?.()
  }
}

/**
 * Tear the mascot's root down, one task later.
 *
 * `root.unmount()` cannot run while React is rendering: when this plugin's
 * disposal races the mascot's own first commit, React refuses the synchronous
 * unmount ("Attempted to synchronously unmount a root while React was already
 * rendering") and leaves the root half-torn. A MACROTASK is what defers past it
 * — React's own work loop runs in microtasks, so `queueMicrotask` lands in the
 * middle of the very commit this is trying to avoid.
 *
 * @param root - the root to unmount.
 * @param host - the dock node to remove once the root is gone.
 */
const unmountLater = (root, host) => {
  const drop = () => {
    try {
      root?.unmount()
    } catch {
      /* already gone */
    }
    if (host.parentNode !== null) host.parentNode.removeChild(host)
  }
  const schedule = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
    ? (fn) => window.setTimeout(fn, 0)
    : (fn) => fn()
  schedule(drop)
}

/**
 * The settings page (same bundle, `src/client/index.jsx`) edits the mascot
 * through these: the master switch and the size are plain client-side values the
 * two components pass by broadcast, so the keys and the event names live here
 * instead of being spelled out on both sides.
 */
export {
  CHANGED_EVENT,
  MOTION_EVENT,
  MOTION_KEY,
  MOTION_VALUES,
  POS_EVENT,
  POS_KEY,
  SHOWN_EVENT,
  SHOWN_KEY,
  SIZE_EVENT,
  SIZE_KEY,
  SIZE_MAX,
  SIZE_MIN,
  broadcast,
  clearPos,
  clampSize,
  readMotion,
  readShown,
  readSize,
  writeMotion,
  writeSize
}

/**
 * Test surface for `scripts/verify-mascot-client.mjs`: the pure layout, data and
 * snapshot helpers, verified without a browser. The components and the mount
 * wiring are verified through them plus a server render, so nothing here is
 * reachable only from tests.
 */
export const mascotInternals = {
  artOf,
  boxOf,
  boxSizeOf,
  clamp,
  clampSize,
  clearPos,
  defaultPos,
  estimatedBox,
  fitToViewport,
  followSnapshot,
  isSeatService,
  positionFromStorage,
  readPos,
  readSize,
  seatIdOf,
  viewport,
  writePos,
  writeSize,
  normalizeMotion,
  readMotion,
  writeMotion,
  MOTION_KEY,
  planFlip,
  reducedMotion,
  FLIP_TOTAL_MS,
  FLIP_COMMIT_MARGIN_MS,
  REVISION_POLL_MS,
  REVISION_SLOW_MS,
  MascotGate,
  PersonaMascot
}
