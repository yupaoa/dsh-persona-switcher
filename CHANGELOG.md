# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 人设按钮未绑定时显示「人设」，绑定后显示名称（无名称时显示 id）；随当前对话、恢复的绑定
  及 `/role` 修改同步。长名称省略并提供完整名称提示，读取失败保留上次确认的名称。
- 输入框底部新增「人设」按钮，独立注册在原生 `conversation.input.left` 列表槽，排在
  `dsh-meme` 表情按钮后、模型选择器前，不替换其他插件控件。支持名称 / id / 描述搜索、
  当前角色标记、键盘操作、失败重试与空库提示；通过既有 `/role` 命令切换当前对话。
- 菜单「添加人设」直接打开原设置页的角色库新增表单；保留未完成的编辑。
  新角色默认填入首个未使用的 `char001`、`char002`……，允许修改；保存新角色前重新检查 ID 冲突。
- 增加真实 React / 浏览器回归测试和原生 SlotCore 共存检查，覆盖会话隔离、草稿保留、
  设置页 CRUD、卸载清理、窄窗口布局及错误恢复。

### Fixed

- 当前生效角色明确为 `null` 时，不再错误地用旧记忆中的角色标记选中状态。

## [0.3.1] - 2026-10-21

### Added

- **`/role` 可以从菜单点选了。** 输入框打出 `/` 后的命令列表里点 **role**，会弹出角色选择器：
  顶部搜索框（按 label 与 detail 做不区分大小写的子串匹配，所以角色名、id、描述片段都能搜到），
  当前生效的角色带勾并标「当前」，第一行固定是 `none`（回到部署人设），点一下就执行
  `/role <id>`。列表每次打开都向宿主重读角色库，设置页里新增/删除的角色立刻出现或消失。
- **实现方式是装饰宿主命令，不是替换它。** 客户端走 `commandUi.decorate()`：`/role list`、
  `/role <id>`、`/role default <id>`、`/role none` 仍然原样落到宿主 handler（目录行、描述、参数
  提示、生命周期日志都不变），只有「裸 /role」这一种触发改由弹窗回答——总览仍可用 `/role list`
  查看。点选本身就是一次宿主命令执行，所以切换的角色变更提示、`sessions.json` 记忆写入和转录里
  的命令节点全部照旧，浏览器侧没有复制任何切换逻辑。
- **`GET /session` 多返回一个 `liveRoleId`。** `roleId` 仍是「记忆里的选择」，`liveRoleId` 是
  「此刻绑定的角色」——两者可能不同（例如会话继承配置的 `defaultRole` 时，记忆里什么都没有）。
  列表的勾读后者，所以默认角色、`/role` 切换、`/role none` 三种状态都显示正确。
- **弹窗只在真正执行后才关闭。** 宿主「收了命令但没匹配上」（`value.matched === false`）时，
  选择器不会静默关闭假装切好了，而是保留列表和搜索词、把原因显示出来，回车即可重试；
  判断用 `=== false` 而非 `!== true`，所以旧宿主返回结构里没有 `matched` 字段时不会被误判成失败。

## [0.3.0] - 2026-10-18

### Added

- **Replacing a role's mascot now turns a card instead of hard-cutting.** A `/role` switch (or an artwork
  replacement from the settings page) used to swap the `<img>` `src` the instant the client noticed it — one
  frame of the old art, then the new one, with nothing in between. The mascot now keeps the OLD artwork on
  screen as the front face of a card and turns the NEW one into view as the back face: the card rotates 180°
  about its own vertical mid-line over ~1s, eased in-out so it moves fastest through the edge-on 90°, where
  the axis reads as the picture's own centre. The card stays flat throughout — no lift, no shadow. Detection
  is untouched: the `/revision` counter still notices a switch in about a quarter of a second and the turn
  starts then — this is a presentation layer over it, not a change to it.
- **The turn is self-healing and never gets stuck.** The new artwork is decoded BEFORE the turn starts (so the
  back face is never an empty box), the turn commits on the card's own `animationend`, and a fallback timer
  commits it `FLIP_TOTAL_MS + 200ms` after the newest back face is set — a hidden tab pausing CSS animations
  can no longer leave the mascot mid-turn showing two half-faded faces. A URL that will not decode skips the
  turn and settles directly, letting the settled image's own `onError` drop a truly broken role. Switches that
  arrive mid-turn retarget the back face (latest wins); a superseded preload never commits.
- **Only a REPLACEMENT turns.** A first appearance (nothing → art) and an unbind (art → nothing) keep the plain
  opacity fade the wrapper already had — there is no card to turn when nothing is on screen. Under
  `prefers-reduced-motion` the swap happens in place, same as the hover growth: the feedback survives, the 1s
  turn does not (Chromium infers this from Windows' own animation setting, so "reduce" is not rare — see the
  0.2.1 note on the hover lesson). A new settings control overrides that reading per-plugin, described next.
- **A per-plugin animation switch: 跟随系统 / 始终开 / 始终关 (System / Always / Never).** The reduced-motion
  reading above is a system-wide accessibility preference, and a machine whose Windows animation switch is off
  (Chromium then reports `prefers-reduced-motion: reduce`) would lose the turn with no way to keep it short of
  flipping a global setting. The mascot card on the settings page now carries a three-way choice stored under
  `dsh-persona-switcher:mascot-motion`: `always` turns even under system reduce, `never` swaps in place even
  where the system allows animation, and the default `system` follows the OS exactly as before. A corrupt or
  hand-edited value folds back onto `system` — it can never force a choice in either direction.
- **None of it costs the coexistence rules.** No CSS `filter` anywhere (nor any shadow — the turn is a plain
  rotation), the turn
  animates a new inner stage/card/face layer so the wrapper's `transform: scale()` stays the size multiplier and
  the drag maths never sees it, the faces are `pointer-events: none` so they never eat the drag, and hovering
  keeps growing the settled artwork exactly as before — but never a face mid-turn, where a hover scale would
  fight the rotation.

### Changed

- **The mascot client checks ask a different question about a switch.** A replacement is on screen (as the back
  face) before the turn commits, so the switch-detection polls now ask "is this art painted by any face"
  (`paintsSrc`) rather than "is it the first `<img>`" — the old question conflated detection latency with the
  animation. The flip itself is verified by a new section (the pure `planFlip` state machine, a first show
  rendering no card, a replacement rendering front=old/back=new with the box already sized to the incoming art,
  the `animationend` commit, the fallback-timer commit, and reduced motion swapping in place) plus stylesheet
  assertions pinning the axis, the duration, and the absence of `filter`.

## [0.2.1] - 2026-10-16

### Added

- **The mascot now follows `/role` immediately.** Switching a role used to change the artwork only after you
  left the session and came back, because the client read the bound role once, when the on-screen session
  changed. It now asks a new counter endpoint, `GET /persona-switcher/revision` — one integer, no disk read —
  every 250 ms, and re-reads the role only when the number moves. A switch therefore reaches the screen in
  about a quarter of a second. The endpoint is described under Fixed below.
- **The mascot reacts to the pointer.** Hovering the artwork scales it to `1.06` over a 120 ms ease — a small
  confirmation that it is interactive, on the image only, never on the dragged box.

### Fixed

- **A configuration value can no longer take the Web GUI down.** `routePrefix` was normalized but never validated,
  so `""` or `"/"` registered a PREFIX route with an empty path. The Host matches a prefix route with
  `pathname.startsWith(prefix + '/')`, which an empty prefix satisfies for every URL the app does not otherwise
  claim — this plugin then answered `404` for the frontend's own assets and shadowed the SPA fallback, and a second
  plugin registering the same path would have failed. An unusable prefix is now refused (one path segment, or
  nothing is mounted) with a warning saying so.
- **`mascot.image` URLs now follow the mounted prefix instead of a hardcoded one.** The route was mounted at the
  configured prefix while every artwork URL was built as `/persona-switcher/...`, so any other prefix served every
  thumbnail as a 404. Both the host half and the client half are pinned to the same default by a test, so the two
  cannot drift apart silently again.
- **The session memory is written atomically on Windows.** `save()` claimed "temp file plus rename", but `rename`
  does not replace an existing file on Windows (typically EPERM/EACCES, more often while a scanner or an editor
  holds it) and the temp name was a fixed `${file}.tmp` shared by concurrent writers. Two sessions switching at
  nearly the same moment could therefore lose the write, surfacing as `Role switch failed` or "could not be
  remembered" with the persona already installed. The destination is removed first, the temp name is unique, the
  file is cleaned up on failure, and writes are serialized.
- **The artwork map is written atomically as well, and its writers are serialized.** It was written straight to the
  map file: two concurrent imports truncated the same path, so one of them returned `200` for an entry that was
  gone — and a torn file degrades to "empty map", which would hide every role's mascot at once.
- **`GET /role` and `DELETE /role` wait for the first library scan.** Both used the synchronous lookup while every
  other role route used the async one, so a request landing before the initial scan reported a role that IS on
  disk as unknown.
- **Destructive routes re-validate a role id before it is joined onto a path.** The catalogue is built from files a
  person can place by hand and `DELETE /role` removes RECURSIVELY, so a role file declaring `id: ../..` aimed that
  removal outside the role library. Such an id is now dropped while the library is scanned, and the delete and
  artwork-pruning paths refuse anything that is not a single path segment.
- **`GET /mascot-file/<name>` validates the RESOLVED path, not the string.** `..%2F..%2Fsessions.json` passed the
  string test; it was only harmless because no layer decoded the request and the extension map rejected `.json`.
  The guard now survives any future decoding.
- **A hand-edited box is normalized or reported, never silently dropped.** `"9999x9999"` (out of range) used to
  read as "this role has no artwork" with no warning at all, which is indistinguishable from a missing file; a
  padded `"0080x0120"` is now normalized to `80x120` rather than discarded.
- **A blank `DSH_HOME` no longer scatters data next to the app.** `??` only guards null/undefined, so `DSH_HOME=''`
  made every path relative to the working directory.
- **The request wrapper contains every failure.** A route that throws now answers `500` JSON instead of relying on
  the Host's own catch (which answers a bodiless `400`), and no request can be left hanging. The wrapper is driven
  directly with a throwing handler in the tests, because no route is reachable in a state that throws.
- **The mascot's role read backs off when the Host stops answering.** A failed read was collapsed into "the answer
  is null", so the retry branch was unreachable: a Host that went away while the fast cadence was live was asked
  four times a second, indefinitely. Failures are now reported as failures, the cadence is read from a ref rather
  than a captured value (so an old Host really does slow down), and a hidden tab is slow for the session read too.
- **Each artwork import no longer adds a permanent poll loop.** Every `CHANGED_EVENT` broadcast started a second
  `/roles` chain while the previous timer was still pending, and the orphaned timer was unreachable from cleanup —
  ten imports meant ten concurrent loops. A broadcast now cancels the queued read first, and only one chain exists.
- **A `visibilitychange` no longer doubles the revision poll.** The timer id was left in place while its callback
  awaited a response, so returning to the tab armed a second chain that grew with every hide/show.
- **The master switch reacts to its own in-window broadcast.** Its listeners guarded on `event.key`, which a
  `CustomEvent` does not have, so the plugin's own event was rejected as "a storage event for another key" and a
  second settings surface kept a stale toggle until the page was reloaded.
- **The settings screen cannot be taken down by a hand-edited role file.** A role with no `name` threw
  `editing.name.trim()` during render, and a non-array `/roles` response would have thrown in `roles.map`. Both
  are guarded now, like the mascot half already was.
- **The mascot no longer disappears when its host effect is run twice.** Symptom on a real machine: no mascot at
  all, no error anywhere, settings page perfectly fine. The dock element was created and then removed. Cause: the
  disposer returned by `installMascot` deleted the dock node, so a second install (a reload, a re-apply, any host
  that re-runs effects) created a NEW React root on the SAME node while the first root's deferred unmount was still
  queued — and that stale teardown then removed the shared node.
  The dock and its root are now owned by the MODULE: an install reuses them, and disposal unmounts the CONTENT
  without removing the node. A synchronous render failure still cleans both up.
  This slipped through because nothing in the suite ran the built bundle through install → dispose → install, and
  the first guard written for it checked "does `getElementById` know the id" — which a detaching `removeChild`
  leaves true, so the guard proved nothing until it was rewritten to test `parentNode`.
  `scripts/simulate-client.mjs` now applies `lib/client.js` the way the host does and asserts the dock survives
  that cycle; `scripts/verify-mascot-client.mjs` asserts the disposer empties the dock but keeps the node.

- **The artwork read keeps retrying after a failure, instead of stopping for good.** The `/roles` poll set its
  next timer AFTER the `await`, so a single failed read (a restarting host, a transient error) ended the loop
  permanently — it could only come back if the on-screen session changed. The visible symptom would have been
  "I imported artwork for this role and the mascot never appeared". The loop now reschedules from its outcome
  (5 s after success, 8 s after a failure), ignores a second read while one is in flight, and stops on unmount.
  `scripts/verify-mascot-client.mjs` fails the artwork read once and asserts both the retry and that the backoff
  is not a hot loop.

- **The mascot now follows a `/role` switch immediately, without re-entering the conversation.** `/role <id>`
  rebinds a session inside the Host process and broadcasts nothing to the browser, so the client can only ask.
  It now asks a new counter endpoint, `GET /persona-switcher/revision` — one integer, no disk read — every
  250 ms, and re-reads the role only when the number MOVES. The counter is bumped in exactly the two places the
  mascot draws from: a session's role binding (the `/role` path, `/role none` included) and the artwork map
  (import, clear, or a hand-edited `mascot-map.json`). A switch therefore reaches the screen in about a quarter
  of a second, and the previous behaviour — read the role once, when the seat changed — is gone. Only a CHANGE
  republishes, so an identical answer every cycle neither re-renders the mascot nor restarts the artwork's fade.
  Nothing is scheduled while the tab is hidden.
- **A host without the counter endpoint still works.** An older build answers 404, which the client treats as a
  normal outcome rather than an error: it falls back to re-reading the role every 1.5 s (backing off to 8 s when
  a read fails) and still catches a live switch within a few seconds. No configuration, no version negotiation.
- **The mascot grows slightly under the pointer.** The artwork uses `transform: scale(1.06)` on a 120 ms
  ease, so the pointer gets a small, immediate confirmation that the mascot is interactive. The growth stays on
  the IMAGE, never on the dragged box, so the box keeps the size the drag gave it, the position maths never sees
  the growth, and the element does not move. `scripts/verify-mascot-client.mjs` pins the value, the animation,
  and "the growth is not on the box".
- **Reduced motion no longer switches the growth OFF.** The `prefers-reduced-motion: reduce` branch also set
  `transform: none` on the hover rule, which cancelled the effect entirely for every such user. `reduce` is not
  the rare case it sounds like: Chromium infers it from Windows' own animation setting, so a machine with
  "show animations" off reported `reduce` and the mascot never responded to the pointer at all. Living proof from
  the real page: `matchMedia('(prefers-reduced-motion: reduce)').matches` was `true` and the artwork's computed
  `transform` stayed `none` even while `matches(':hover')` was `true`. The branch now only drops the 120 ms
  easing (the growth becomes instant) and never the growth itself — which is also all the image does.
  `scripts/verify-mascot-client.mjs` asserts both halves, so the cancellation cannot come back.

  Found on a real machine (DSH 0.2.0-rc.2 + Windows desktop, 2026-10-16) after 0.2.0 was installed; the host side
  was already correct (`GET /session?session=` returned the new role), so the first fix was client-only. The
  counter endpoint was added afterwards, once polling the role itself proved too coarse to feel instant.

  `scripts/verify-mascot-client.mjs` covers both paths: a switch that changes only the host's answer, with the
  seat untouched, must change the artwork and the accessible label; with a counter it must land within one
  counter cycle, and without one it must still land. `scripts/verify-mascot.mjs` covers the bump itself by
  running the real `/role` handler: a switch moves the revision, `/role none` moves it, re-applying the role
  already bound does NOT, an unknown role does not, and reading the counter touches no file.

## [0.2.0] - 2026-10-16

### Added

- **A per-role mascot on screen.** Import artwork for a role from the settings page (角色库 → 导入立绘) and
  the role of the session you are looking at shows up as a draggable mascot in the interface. It is shown
  only when all three conditions hold: a session screen is on screen, that session has a role (not `none`),
  and that role has artwork bound. A role without artwork shows nothing at all — no placeholder, no gap.
  The image is stored under `<DSH_HOME>/persona-switcher/mascot/<roleId>-<stamp>.<ext>` with the map in
  `mascot-map.json` beside it, never under the role directory, so a role's prose and its artwork stay
  independent files. Uploads are limited to png/jpeg/webp, 1 MB decoded and 4096 px per side; three versions
  per role are kept and older ones pruned.
- **A master switch, a size slider and a position reset** in 常规 → 屏幕吉祥物. The switch's only effect is
  mascot visibility — with it off the mascot is not mounted at all, so it sends no requests and costs no
  decode. The size is a 0.5×–2.5× multiplier that scales the artwork without changing its proportions, and
  "回到默认位置" sends the mascot back to its corner. The switch and the size are client-side values, stored in
  `localStorage` under this plugin's own namespace, and the settings page and the mascot stay in step through
  a broadcast (`persona-switcher:mascot-shown` / `:mascot-size-changed` / `:mascot-pos-reset`) so the switch
  takes effect on screen immediately, without a reload.
- **`GET /persona-switcher/session?session=`** answers "which role is this session bound to" (with an explicit
  `roleId: null` when it is none), and `GET /persona-switcher/roles` now carries `mascot: { image, box } | null`
  per role, so the settings page and the on-screen mascot read one source of truth for "who has artwork, and
  how big is it".
- `scripts/verify-mascot-client.mjs`: 114 checks over the mascot and the settings-side controls, run by
  `npm test` with no browser. The components are driven through a purpose-built hooks host (React's own hook
  state is not reachable from a test in a stubbed DOM), and the mount wiring is checked against a real React
  root. It has already earned its keep — see the three fixes below, all of which it found.

### Fixed

- **A blank session id is no longer treated as a seat.** A seat whose id was `''` or whitespace reached
  `GET /session?session=`, which the Host can only answer with a 404, so the mascot stayed permanently blank
  on a screen that did have a role. A non-string or blank id now means "no seat on screen".
- **A role whose artwork box is unreadable counts as having no artwork.** `mascot-map.json` is a file a human
  can hand-edit, and the client used to fall back to a default width for a broken `box`, which rendered the
  artwork at the wrong size instead of leaving the role unbound. The client re-validates the `WxH` spelling:
  strictly what the Host publishes, nothing else.
- **A mascot the user has placed is never moved by anything but the user.** The resting position was re-read
  from `localStorage` whenever the artwork width changed, so importing new artwork (or a size change) yanked a
  mascot the user had just dragged back to the last persisted spot. The position is now read once, when the
  mascot mounts; after a drop, only a drop or an explicit reset moves it.
- **Disposing the plugin no longer unmounts the mascot's React root mid-render.** `root.unmount()` called
  synchronously during React's own commit is refused by React ("Attempted to synchronously unmount a root
  while React was already rendering") and leaves the root half-torn, which a plugin reload or disable could
  hit. The teardown is deferred by one task instead.

### Changed

- The client bundle now keeps `react-dom/client` external (the desktop runtime registers it), and the mascot
  mounts through `createRoot` rather than the deprecated `react-dom` root export.

### Notes

- Coexists with other on-screen plugins: distinct dock and stylesheet ids, a distinct `localStorage`
  namespace, its own z-index band, no CSS `filter`, no `keydown`/`contextmenu` handlers, and no
  registration into `sidebarRight` — the seat snapshot is read, never written.

## [0.1.9] - 2026-10-13

### Fixed

- **A role no longer deletes the deployment's own identity line.** A persona was installed as a per-agent
  `deployment:persona-prefix` prompt section — the same name and order as the deployment's own registration —
  which *shadows* it for that session. That section carries the deployment's `personaPrefix`
  (`You are a coding agent powered by the {{model}} model.`), so every switched session lost the line and the
  model could no longer say which model it was running on; only `/role none`, which disposes the override,
  brought it back. A role now registers this plugin's own section, `persona-switcher:persona`, at order 137 —
  after the deployment persona prefix (`DEPLOYMENT_PERSONA_PREFIX`, 0) and before the first-party guidance
  (`PLAN_POLICY`, 500) — so the deployment prefix stays in force for every session and a switch *adds* persona
  prose after it instead of replacing it. `/role none` now means an empty persona rather than an empty
  identity: nothing is registered for the session, and the deployment's line is still there. `role_probe`'s
  report, the README, the diagram and the guards follow suit, and `npm run verify` now fails the build if the
  deployment persona prefix is registered from here again.

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
