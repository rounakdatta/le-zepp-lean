# A — Zepp OS Device App on the Amazfit T-Rex 3: runtime, UI and system APIs

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Research date: 2026-09-28. Scope: the **watch-side** Mini Program ("Device App"): lifecycle, JS runtime, UI, interaction, screen control, storage, misc system modules, performance limits. Sensors/health/workouts, phone connectivity/BLE, app types/background services/watch faces and toolchain/distribution belong to sibling reports and are only touched for context.

## How to read this report

Every claim carries an evidence tag:

| Tag | Meaning |
|---|---|
| **[DOC]** | Official Zepp OS developer docs (local clone, path given relative to `D:`) |
| **[OFF]** | Other official Zepp artifact: sample code (`S:`), official libraries (ZML, easy-*), `@zeppos/device-types@4.0.0` typings, the `@zeppos/zpm@3.4.2` build tool shipped with Zeus CLI 1.9.3, the Zeus device registry, the T-Rex 3 user manual, or a reply from Zepp staff on the official forum |
| **[COMM]** | Community report (forum users, third-party repos that test on a real T-Rex 3, reviews) |
| **[INF]** | My inference; not verified on a device |

Path prefixes:

- `D:` = `scratchpad/src/zeppos-docs/` (docs clone, snapshot commit `c08725b`, 2026-07-17)
- `S:` = `scratchpad/src/zeppos-samples/`
- `T:` = `scratchpad/pkgs/device-types-4/package/dist/index.d.ts` (`@zeppos/device-types@4.0.0`, published 2026-06-17, fetched with `npm pack`)
- `Z:` = `scratchpad/pkgs/zpm/package/` (`@zeppos/zpm@3.4.2`, the build engine behind `zeus build`)
- `C:` = `scratchpad/community/` (saved copies of community sources)

Availability column used in tables:

| Mark | Meaning on T-Rex 3 |
|---|---|
| ✅ | Available (API_LEVEL ≤ 4.0, so present on every firmware the watch has shipped with since the 4.x line) |
| ✅⁶ | Available **only on Zepp OS 6 firmware** (API_LEVEL 4.4). Covers everything documented at 4.1–4.3 |
| ⚠️ | Present, but with a documented or reported caveat |
| ❌ | Not available or not applicable |

---

## 0. The T-Rex 3 as a Device-App target

### 0.1 Current platform facts

| Item | Value | Evidence |
|---|---|---|
| OS / API_LEVEL (current firmware) | **Zepp OS 6.0, API_LEVEL 4.4** (`apiLevelLimitMin` 1.0, `apiLevelLimitMax` 4.4) for deviceSource 8716544 (China), 8716545, 8716547 | [OFF] Zeus device registry `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json` (saved as `C:zeus-devices.json`, entries 38–40); [COMM] measured `getSystemInfo().minAPI === '4.4'` on firmware 6.2.104.6 (`C:` water-reminders `06-device-matrix.md`) |
| Official device list | **Out of date**: still says API_LEVEL 4.0 / Zepp OS 4.5 | [DOC] `D:docs/reference/related-resources/device-list.mdx` (also live on docs.zepp.com) |
| Firmware history | Zepp OS 4.5 (Apr 2025) → Zepp OS 5 (Dec 2025 update) → Zepp OS 6 (6.2.104.6 from 2026-07-21, then 6.3.25.7 in Sep 2026) | [OFF] Amazfit blog "T-Rex 3: December 2025 Software Updates"; [COMM] gadgetsandwearables.com 2026-09-03; water-reminders repo |
| Device JS runtime build string | `jsrt-4.5.0-release.2-405` (Zepp OS 6, productId 133) | [COMM] forum discussion #564 (2026-09-12) |
| Screen | Round **480 × 480**; watch-face preview 324 × 324; registry `iconSize: 124` (presumably the launcher icon size); AMOLED panel | [OFF] registry (`screen.size`, `previewSize`, `iconSize`); [DOC] device list; [COMM] reviews for AMOLED |
| Physical keys | **4** (UP, DOWN on the left; SELECT, BACK on the right), **no digital crown** | [DOC] `D:docs/reference/related-resources/physical-keys.mdx` + image `D:static/img/docs/guides/related-resources/4key.png`; [OFF] T-Rex 3 manual |
| Touch | Yes (touchscreen can be auto-locked during workouts, unlock with UP/DOWN) | [OFF] T-Rex 3 manual (`C:trex3-manual.txt`) |
| Audio out | **No speaker.** Has a **buzzer** (alarms, find-watch). Music/voice playback needs Bluetooth headphones | [OFF] manual ("Music player… you need to connect Bluetooth headphones", "Buzzer Intensity", "Settings > Sound and vibration > Buzzer"); [COMM] Tech Advisor / OutdoorGearLab reviews |
| Microphone | Yes (`voice: true`; offline voice assistant) | [OFF] registry; [COMM] reviews |
| Other hardware flags | NFC (8716544/8716545 only), capabilities `gps, magnetometer, gyroscope, accelerometer, altimeter` | [OFF] registry |
| SecondaryWidget | Not supported | [DOC] device list |
| Workout Extension | Supported | [DOC] `D:docs/guides/version-info/new-features-35.md` |

**Decision point.** Anything documented at API_LEVEL ≤ 4.0 works on every T-Rex 3 in the field. Things documented at 4.1–4.3 (custom keyboard, `Player.seek()`/`seekTo()`, `getDeviceInfo().uuid`, Workout nav/HR-zone APIs) exist only on Zepp OS 6 firmware. The docs describe **no 4.4-specific API** [DOC]. Two ways to handle it:

1. Set `runtime.apiVersion.minVersion` to `"4.0"` and feature-detect 4.2+ calls at runtime (widest reach).
2. Set `minVersion` to `"4.4"` if the watch is known to be updated (simplest code; the app then will not install on older firmware).

Compare API levels as `major.minor` integers, not as floats (the docs define `3.1 > 3.0 > 2.98 > 2.1`) [DOC] `D:docs/guides/framework/device/compatibility.md`:

```js
import { getSystemInfo } from '@zos/settings'   // API 2.1, no permission needed

function apiAtLeast(want) {                       // want: '4.2'
  const have = (getSystemInfo().minAPI || '2.0').split('.').map(Number)
  const need = want.split('.').map(Number)
  return have[0] !== need[0] ? have[0] > need[0] : (have[1] || 0) >= (need[1] || 0)
}
// Also probe the function itself: docs have listed APIs that are missing on real
// firmware (stringToBuffer, see §2.4).
const canSeek = apiAtLeast('4.2')
```

### 0.2 Documentation reliability warnings

- The official device list lags firmware (above) [OFF][COMM].
- `js-support.md` says Promise and timers are unsupported; both work (§2.3) [OFF][COMM].
- The docs' `llms.txt` index (`D:static/llms.txt`) lists APIs that do not exist anywhere else in the docs or typings (for example `@zos/app` `setScreenKeep`/`gotoPage`, `@zos/interaction` `vibrate`). **Do not use it as a source** [INF from cross-checking against `T:`].
- `guides/version-info/` has summaries for 2.1, 3.0, 3.5, 4.0, 4.2 only; 3.6/4.1/4.3/4.4 changes are only visible on individual API pages [DOC][COMM].

---

## 1. App structure and lifecycle

### 1.1 Anatomy of a Device App

A Mini Program is `app.json` + `app.js` + page files, plus optional `app-side/` (Side Service on the phone), `setting/` (Settings App on the phone), `app-service/` (background service), `app-widget/` (Shortcut Card), `secondary-widget/` (not on T-Rex 3), `data-widget/` (Workout Extension or custom keyboard) [DOC] `D:docs/guides/architecture/folder-structure.mdx`, `D:docs/reference/app-json.mdx`. Every page must be listed in `targets.<key>.module.page.pages`; the first entry is the launch page [DOC] `D:docs/reference/app-json.mdx`, `D:docs/guides/framework/device/page.mdx`.

Resources live in `assets/<targetKey>.<qualifier>/` (for example `assets/default.r/` for round screens in v3 config); `assets/raw/` is copied verbatim into the on-watch `/assets` directory [DOC] `D:docs/guides/framework/device/screen-adaption.md`, `D:docs/guides/framework/device/fs.md`. Images placed outside the target folder are not found [COMM] forum #438.

### 1.2 `App()` — the application instance

| API | Signature / notes | Min API | T-Rex 3 |
|---|---|---|---|
| `App({ globalData, onCreate(params), onDestroy() })` | Called exactly once in `app.js`. `onCreate` cannot draw UI (no page loaded yet). `params` is the string passed by `launchApp`/`setLaunchAppTimeout` | 2.0 | ✅ |
| `getApp()` | Returns the instance; state is at `getApp()._options.globalData` | 2.0 | ✅ |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/global/App.mdx`, `getApp.mdx`, `D:docs/guides/framework/device/life-cycle.md`.

### 1.3 `Page()` — a screen

| Hook | Behaviour | Min API |
|---|---|---|
| `state` | Object mounted on the page instance | 2.0 |
| `onInit(params)` | Runs once per page load; `params` is the string from `push`/`replace` (objects are JSON-stringified for you) | 2.0 |
| `build()` | Runs after `onInit`; draw UI here | 2.0 |
| `onDestroy()` | Page is destroyed (also on every `push` away from it) | 2.0 |
| `getCurrentPage()` | Returns the page instance (`._options.state`) | 2.0 |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/global/Page.mdx`, `getCurrentPage.mdx`; the typings list exactly these four hooks [OFF] `T:` (namespace `Page`). There is **no `onShow`/`onHide`/`onResume`/`onPause` for Pages**. Only SecondaryWidget, AppWidget (Shortcut Card) and DataWidget have `onResume`/`onPause` [DOC] `D:docs/reference/device-app-api/newAPI/global/AppWidget.mdx`, `DataWidget.mdx`. An official sample declares `onHide` on a Page (`S:application/3.0/3.0-feature/pages/canvas.js`), but nothing documents that it is called [INF: treat as a no-op].

**Order of events** [DOC] `D:docs/guides/framework/device/router.md`:

| Action | Sequence |
|---|---|
| A `push` → B | A `onDestroy` → B `onInit` → B `build` |
| B `back` → A | B `onDestroy` → A `onInit` → A `build` (A is rebuilt from scratch) |

Consequences: page-local memory never survives navigation; persist in `onDestroy` or keep state in `globalData`/storage [DOC][COMM].

### 1.4 Router (`@zos/router`)

| API | Purpose | Min API | T-Rex 3 |
|---|---|---|---|
| `push({ url, params })` | Go to a page in this app; `back()` returns | 2.0 | ✅ |
| `replace({ url, params })` | Replace the current page | 2.0 | ✅ |
| `back()` | Close the current page and return to the previous one. **No return value can be passed back** (use `globalData`/`sessionStorage`) | 2.0 | ✅ |
| `exit()` | Leave the app, go to the **app list** | 2.0 | ✅ |
| `home()` | Leave the app, go to the **watch face** | 2.0 | ✅ |
| `launchApp({ appId, url, params, native })` | Open **another Mini Program** (its appId + page path) or, with `native: true` and a `SYSTEM_APP_*` constant, a **system app** (native since 3.0) | 2.0 / 3.0 | ✅ |
| `checkSystemApp({ appId })` | Check whether a system app supports being jumped to | 3.0 | ✅ |
| `getAppIdByName(name)` | Fuzzy-match an installed Mini Program by English name, returns its appId | 3.6 | ✅ |
| `setLaunchAppTimeout({ appId, url, utc \| delay, params })` / `clearLaunchAppTimeout` | Schedule the system to launch a Mini Program later (`utc` since 2.0, `delay` since 3.0) | 2.0 | ✅ |

System app constants include `SYSTEM_APP_STATUS, _HR, _SPORT, _WEATHER, _ALARM, _CAMERA, _MUSIC, _STOPWATCH, _COUNTDOWN, _FINE_PHONE, _CARD, _SETTING, _SPORT_HISTORY, _COMPASS, _PAI, _WORLD_CLOCK, _PRESSURE, _SPORT_STATUS, _CALENDAR, _SLEEP, _SPO2, _PHONE, _BREATH, _POMODORO, _ALEAX, _TODO_LIST, _ALTIMETER, _VOICE_MEMO, _SUN_AND_MOON, _MEASUREMENT, _ZEPP_COACH, _CLUB_CARD, _BODY_COMPOSITION, _READINESS` plus China-only payment apps [DOC] `D:docs/reference/device-app-api/newAPI/router/launchApp.mdx`. Which exist on a given T-Rex 3 depends on region/firmware; call `checkSystemApp` first [INF].

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/router/*.mdx`.

**Page-stack limits.** None are documented anywhere in current, v2 or v1 docs (EN and ZH) [DOC, searched]. Because `push` destroys the previous page, the router only keeps a history of URLs, not live pages [INF].

### 1.5 Cross-page communication

Officially recommended [DOC] `D:docs/guides/best-practice/cross-page-communications.mdx`:

1. `push`/`replace` `params` (one-way; parse `JSON.parse(params)` in `onInit`).
2. `getApp()._options.globalData` (both directions; lives as long as the app process).
3. `sessionStorage` from `@zos/storage` (cleared when the app exits).

Plus `LocalStorage`/`@zos/fs` for anything that must survive exit (§5), and `EventBus` from `@zos/utils` for pub/sub inside one page's lifetime [DOC].

### 1.6 What happens when the screen turns off

- "By default, the system will off the screen in one page of the Mini Program, and the system will **exit the Mini Program after 10s**, and enter the dial page when the watch is woken up again." `setWakeUpRelaunch({ relaunch: true })` makes the app reopen on wake [DOC] `D:docs/reference/device-app-api/newAPI/display/setWakeUpRelaunch.mdx`.
- "The app cannot run in AOD mode" [COMM] forum #518 (experienced developer), consistent with the doc above.
- An incoming full-screen notification or alarm can interrupt the app; autosave state periodically [COMM] forum #342 (reported on a Zepp OS 1 app).
- Keep-awake recipe in §4.6.

### 1.7 Lifecycle pitfalls (mostly community, measured on real hardware)

| Pitfall | Evidence |
|---|---|
| Errors thrown in lifecycle hooks are **not caught by the framework** → silent blank screen. Wrap each hook in `try/catch` and log `e.stack` line by line (logs are truncated) | [DOC] `D:docs/guides/best-practice/error-catch.mdx` |
| `setInterval` callbacks must also be wrapped; one throw kills the timer | [COMM] water-reminders P-13 (`C:wr-pitfalls.md`) |
| **Any `export` statement in an entry file** (page, `app.js`, app-service) → black screen with `TypeError: not an object` at `defineProperty`; entry files are evaluated inside a `with(context)` wrapper without `exports` | [COMM] P-25, T-Rex 3 / Zepp OS 6 |
| Reassigning `this.state = {...}` is silently dropped; mutate in place (`this.state.x = …`) or use module-level variables | [COMM] P-27 |
| The page's scrollable height is fixed when `build()` returns; widgets created later (e.g. in `setTimeout`) are unreachable by scrolling | [COMM] P-30 |
| `onInit(params)` receives `undefined` (not `''`) when opened from the launcher | [COMM] P-31 |
| ZML's `BasePage` runs its own mixins before your `onInit`, without `try/catch`; if they throw, your `onInit` never runs while `build()` still does | [COMM] P-31 (not reproduced on T-Rex 3 / Zepp OS 6) |
| MOVE_IN/MOVE_OUT touch events only work on BUTTON | [OFF] Zepp staff, forum #294 |

**Skeleton that avoids these traps:**

```js
// page/home/index.page.js — entry file: imports only, never `export`
import { createWidget, widget, align, event } from '@zos/ui'
import { push } from '@zos/router'
import { log } from '@zos/utils'

const logger = log.getLogger('home')
const guard = (tag, fn) => function (...a) {
  try { return fn.apply(this, a) } catch (e) {
    logger.error(tag, String(e))
    e && e.stack && e.stack.split('\n').forEach((l) => logger.error(l))
  }
}

let model = null            // module-level state: rebuilt on every page load

Page({
  state: {},                // mutate in place only
  onInit: guard('onInit', function (params) {
    const p = params ? JSON.parse(params) : {}   // undefined from the launcher
    model = { id: p.id || 0 }
  }),
  build: guard('build', function () {
    const t = createWidget(widget.TEXT, {
      x: 40, y: 200, w: 400, h: 80, text: 'Hello T-Rex 3',
      text_size: 36, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })
    t.addEventListener(event.CLICK_UP, () => push({ url: 'page/detail/index.page', params: { id: 7 } }))
  }),
  onDestroy: guard('onDestroy', function () { /* persist `model` here */ }),
})
```

---

## 2. JavaScript runtime

### 2.1 Engine and build pipeline

| Fact | Evidence |
|---|---|
| The engine is **QuickJS**. `app.json` `runtime.type`: `0` QuickJS-js loader (`.js`), `1` C interpreter (`.c`), `2` QuickJS-bytecode loader (`.bin`) | [DOC] `D:docs/reference/app-json.mdx`; simulator logs print `quickjs-libc SBEngine` [COMM] forum #342 |
| `zeus build` runs `@zeppos/zpm`: **rollup** + `@rollup/plugin-node-resolve` + `@rollup/plugin-commonjs` + **esbuild with `target: "ES2020"`**, output `cjs`, with every `@zos/*` import left external (resolved by the runtime) | [OFF] `Z:lib/0.node.js` (function building `App/Page/AppService/AppWidget/SecondaryWidget/DataWidget` entries) |
| It then compiles to **QuickJS bytecode** using a bundled `qjsc` reporting "QuickJS Compiler version **2020-07-05**" ("js to bin" default since Zeus CLI 1.1.8) | [OFF] `strings Z:bin/qjsc_darwin_arm64`; [DOC] `D:docs/guides/tools/cli/release-note.md` |
| PNG assets are converted at build time (`png2tga` in zpm) | [OFF] `Z:bin/png2tga.node.js` |
| The app store may **re-build your upload server-side** (zpm 3.2.13-beta) and ship **plain JS instead of bytecode** (2.47× more code to parse at launch), T-Rex 3 included | [COMM] forum #568 (2026-09-22) |
| npm libraries whose `package.json` lacks `"zeppos": true` build with a warning: "compatibility not guaranteed" | [OFF] `Z:lib/0.node.js`; [DOC] `D:docs/guides/tools/npm/index.mdx` |

**What this means** [INF]: source may use ES2021+ *syntax* (esbuild lowers it to ES2020), but *built-ins* come from a mid-2020 QuickJS plus whatever Zepp added. esbuild does not polyfill APIs.

### 2.2 Security restrictions

`eval` and `new Function(...)` are blocked (except `new Function('return this')`) [DOC] `D:docs/guides/framework/device/js-support.md`. Dynamic `import()` is not supported [COMM] forum #443 (silver-zepp). No code download-and-execute is possible [INF].

### 2.3 Language feature matrix

| Feature | Status on device | Evidence |
|---|---|---|
| ES2015–ES2020 syntax (classes, arrow functions, destructuring, spread, template literals, `let/const`, optional chaining `?.`, nullish `??`, exponent) | ✅ | [DOC] "ES6 language features are supported"; esbuild target ES2020 [OFF]; officially recommended libs ship `?.`, `??` and private `#fields` in their dist code, which the build accepts/lowers (`scratchpad/src/easy-media/npm+src/dist/sound-player.js`) [OFF] |
| ES2021+ syntax (logical assignment `??=`, numeric separators, class fields/private methods) | ✅ via esbuild lowering | [OFF] zpm config; QuickJS 2020-07-05 predates logical assignment (added 2020-09-06, bellard.org changelog) [INF] |
| **Promise** | ✅ in practice (docs say "not supported" — stale) | [DOC] says unsupported; [OFF] ZML's API-3.0 build uses native `globalThis.Promise` and only polyfills with `es6-promise` for API 1.0/2.0 (`scratchpad/src/zml/src/shared/promise-3.0.js`, `rollup.config.mjs`); official 4.0 sample chains `.then()` on device (`S:application/4.0/todo-list/page/home/index.page.js`); [COMM] `typeof Promise === 'function'` on T-Rex 3 / API 4.4 |
| **async / await** | ❌ **do not use** | [OFF] Zepp staff (MyoungXUE, 2025-11-25): "currently it does not support async/await syntax"; [COMM] user report: app freezes when awaiting (forum #473). esbuild at ES2020 does not lower async functions [OFF] |
| Generator functions | ❌ per docs, untested | [DOC] js-support.md |
| Timers (`setTimeout`, `setInterval`, `clear*`) | ✅ in pages; ❌ inside App Service | [DOC] `D:docs/reference/device-app-api/newAPI/global/setTimeout.mdx` (2.0); `D:docs/guides/framework/device/app-service.md` (not available in services) |
| `String.prototype.replaceAll`, `Promise.any`, `AggregateError`, BigInt | ✅ likely (present in QuickJS 2020-07-05) | [INF] from the QuickJS changelog |
| `Intl.*`, locale-aware `toLocaleString` options | ❌ likely (QuickJS has no Intl) | [INF] — use `@zos/settings`/`@zos/i18n` and format by hand |
| `Array.prototype.at`, `Object.hasOwn`, `findLast`, `structuredClone`, `WeakRef` | ❓ probably missing (newer than the engine) | [INF] — feature-detect before use |

Pattern that works (Promise chains, no `await`):

```js
// ZML request/response returns a Promise on device (API 3.0+)
this.request({ method: 'GET_DATA', params: { day: 1 } })
  .then(({ result }) => this.render(result))
  .catch((e) => showToast({ content: 'Sync failed' }))
```

### 2.4 Globals available on the watch

| Global | Notes | Min API | Evidence |
|---|---|---|---|
| `App`, `Page`, `AppService`, `AppWidget`, `SecondaryWidget`, `DataWidget`, `getApp`, `getCurrentPage` | Framework constructors | 2.0 (DataWidget 3.6) | [DOC], [OFF] `T:` |
| `setTimeout` (default delay 1 ms), `clearTimeout`, `setInterval`, `clearInterval` | Not in App Service | 2.0 | [DOC] `D:docs/reference/device-app-api/newAPI/global/*.mdx` |
| `console.log` | Each line length-limited and truncated; `@zos/utils` `log` recommended for Device Apps | 2.0 | [DOC] `global/console.mdx`, `D:docs/guides/best-practice/debug.mdx` |
| `Buffer` | Node.js-style Buffer (`from`, `toString('base64'/'hex'/'utf8')`, `read/write*Int*`); ZML uses it for all string↔binary work | 2.0 | [DOC] `global/Buffer.mdx`; [OFF] `T:` declares `class Buffer extends Uint8Array`; `scratchpad/src/zml/src/shared/data.js` |
| `globalThis`, `JSON`, `Math`, `Date`, typed arrays, `DataView`, `Map`/`Set`/`WeakMap`, `Symbol`, `Proxy`, `Reflect` | Standard QuickJS built-ins | — | [INF]; ZML relies on `globalThis` [OFF] |
| `String.prototype.toPixel()` | Undocumented helper used by the official 4.0 sample (`"10vw".toPixel()`, `"8".toPixel()`) | 4.0 | [OFF] `S:application/4.0/4.0-feature/page/index.r.layout.js`; typings expose a related `pixel(express, refer_width)` [OFF] `T:` |
| `fetch`, `XMLHttpRequest`, `WebSocket`, `TextEncoder/TextDecoder`, `atob/btoa`, `crypto.getRandomValues`, `queueMicrotask`, `requestAnimationFrame`, `localStorage` (web) | ❌ none on the watch | [INF] (no mention in docs or typings; networking goes through the phone Side Service) |

String/ArrayBuffer conversion: `@zos/utils` `bufferToString`/`stringToBuffer` are documented at 4.0 [DOC], **but `stringToBuffer` was reported missing on a T-Rex 3 at API 4.4** [COMM] P-24. Use `Buffer` and slice by `byteOffset`/`byteLength`:

```js
const toAB = (str) => { const b = Buffer.from(str, 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
const fromAB = (ab) => Buffer.from(ab).toString('utf8')
```

### 2.5 Module system

- **Static ESM `import` only.** `@zos/*` modules are resolved by the runtime; relative imports and `node_modules` code are bundled into each entry file (every page is its own bundle, so shared code is duplicated per page) [OFF] `Z:` rollup config; [INF] on duplication (consistent with per-page bundle sizes in forum #568).
- Layout files per screen shape: `import { STYLE } from 'zosLoader:./index.[pf].layout.js'` → resolved at build to `index.r.layout.js` on round devices [DOC] `D:docs/guides/framework/device/screen-adaption.md`.
- Both `import * as hmUI from '@zos/ui'` (official samples) and named imports work [OFF] `S:application/4.0/hello-world/page/gt/home/index.page.js`.
- **Never mix API 1.0 globals** (`hmUI.widget…` without importing, `hmSensor`, `hmFS`, `hmApp`) into an API 2.0+ app: black screen [COMM] forum #448.

### 2.6 Can ordinary npm packages be used?

- Official rule: packages "can only use ES2015 syntax and Zepp OS JS API, and do not support environment APIs such as Node.js and browsers", and should declare `"zeppos": true` [DOC] `D:docs/guides/tools/npm/index.mdx`. (The ES2015 limit looks older than the current ES2020 build target [INF].)
- Pure-JS math/algorithm libraries generally bundle, but:
  - Anything touching Node built-ins, the DOM, `fetch`, `eval` or a lot of RAM (the forum example is `xml2js`) fails; move such work to the phone [COMM] forum #329 (silver-zepp).
  - UMD/AMD-wrapped CommonJS libs (example: `suncalc`) broke after `back()` (imported functions became `undefined`) until the wrapper was replaced with `export default` [COMM/OFF] forum #443, confirmed as a build-tool limitation by silver-zepp.
- Official helper libraries: `@zeppos/zml` (messaging, request/response, file transfer; needs API ≥ 3.0, latest ≥ 3.6), `@silver-zepp/easy-storage`, `easy-media`, `easy-ble`, `easy-draw`, `vis-log`, `polyglot` [DOC] `D:docs/guides/tools/npm/officially-recommended.mdx`; [OFF] `scratchpad/src/zml/docs/known-issues.md`.

### 2.7 TypeScript

- `zeus build` does **not** compile TypeScript: zpm's esbuild plugin only includes `/\.js?$/` [OFF] `Z:lib/0.node.js`.
- Types for editor hints and `checkJs`: `@zeppos/device-types` (latest **4.0.0**) with the `jsconfig.json` + `global.d.ts` scaffold used by every official sample [OFF] `S:application/4.0/hello-world/jsconfig.json`, `T:`.
- Options: (a) JS + JSDoc + `checkJs` (zero build friction); (b) author in TS and pre-compile to JS (tsc/esbuild, `target: es2020`, no `async`) into the project before `zeus build`; (c) the community `zepp-ts` build tool [COMM] `scratchpad/src/awesome-zeppos/README.md`. Options (b)/(c) are [INF]; the toolchain report covers them in depth.

---

## 3. UI

### 3.1 Model and common widget API (`@zos/ui`)

- **Retained-mode widget tree with absolute pixel coordinates** (`x, y, w, h`; origin top-left of the 480 × 480 bounding square) [DOC] `D:docs/guides/framework/device/page.mdx`. Children of `GROUP`/`VIEW_CONTAINER` use coordinates relative to the container [DOC].
- On round screens the **entire area is drawable**; there is no system status bar (square devices have a 64 px one, hence `setStatusBarVisible`/`updateStatusBarTitle` are square-only) [DOC] `D:docs/guides/best-practice/multi-screen-adaption.mdx`.

| API | Notes | Min API |
|---|---|---|
| `createWidget(widget.X, opts)` / `group.createWidget(...)` / `viewContainer.createWidget(...)` | Returns a widget object. 4.0 adds `parent` and `layout` options for Flex | 2.0 (`parent`/`layout` 4.0) |
| `deleteWidget(w)`; `redraw()` | `redraw` if the view does not refresh after a delete | 2.0 |
| `w.setProperty(prop.X, v)` / `w.getProperty(prop.X)`; `prop.MORE` sets many at once | `prop.VISIBLE` can only be set on its own; `prop.DATASET` holds custom data; some widgets do not support `getProperty` | 2.0 |
| **Getter/setter**: `w.text = 'x'`, `w.color = 0xff0000`, `w.x` | Per-widget support table in each widget page | **4.0** ✅ |
| `w.addEventListener(event.CLICK_DOWN \| CLICK_UP \| MOVE \| MOVE_IN \| MOVE_OUT, cb)` / `removeEventListener` | `cb(info)` has `info.x/info.y`. Typings also declare `event.SELECT` (undocumented) | 2.0 |
| `w.setEnable(false)` | Lets touches pass through to widgets below | 2.0 |
| `w.setAlpha(0..255)` | Opacity for widgets without an `alpha` prop | 2.1 |
| `w.getId()`, `w.getType()` | — | 2.0 |
| `getTextLayout(text, { text_size, text_width, wrapped, rows_max })` | Measure text without rendering; returns `{ width, height, rows, result, text }` (`rows_max` 3.0) | 2.0 |
| `getImageInfo(path)` | Width/height of an image in `/assets` | 2.0 |
| `getRtlLayout()` / `relayoutRtl()` | RTL support (Hebrew/Arabic) | 2.0 |
| `createDialog`, `showToast` (`@zos/ui` flavour takes `{ text }`) | See §4.5 | 2.0 |
| `updateLayout()`, `setLayoutParent`, `addLayoutChild`, `removeLayoutChild`, `updateLayoutStyle`, `openInspector()` | Flex layout tree ops (§3.8) | 4.0 ✅ |
| `createKeyboard()` / `deleteKeyboard()` / `keyboard.*` | §3.10 | 4.0 / 4.2 |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/ui/*.mdx`; [OFF] `T:` (`IHmUIEventType`, `IHmUIExtensionFunction`).

### 3.2 Every documented widget

All 30 pages in `D:docs/reference/device-app-api/newAPI/ui/widget/`, plus the `STATE_BUTTON` child widget [DOC]:

| # | Widget (`widget.` constant) | Purpose | Min API | T-Rex 3 | Notes |
|---|---|---|---|---|---|
| 1 | `ARC` | Arc/ring progress: `radius`, `start_angle`, `end_angle` (0° = 3 o'clock), `line_width`, `color` | 2.0 | ✅ | Ends are rounded by default, no flat-cap option [COMM] P-23 |
| 2 | `BUTTON` | Text/image/colour button with pressed state, `click_func`, `longpress_func` (700 ms) | 2.0 | ✅ | `font`, `text_w` since 3.6; `w/h: -1` auto-sizes to `normal_src`; `setProperty` must re-pass `x,y,w,h` |
| 3 | `CANVAS` | Immediate-mode drawing surface | 3.0 | ✅ | §3.4 |
| 4 | `CHECKBOX_GROUP` | Multi-select group whose options are `STATE_BUTTON`s | 2.0 | ✅ | Must call `prop.INIT`; colour mode (`use_color`, `select_color`, `fill_width/height`) 4.0 |
| 5 | `CIRCLE` | Filled circle with alpha | 2.0 | ✅ | — |
| 6 | `CYCLE_IMAGE_TEXT_LIST` | Endlessly looping list, image + text per item, click and focus callbacks | 2.0 | ✅ | `prop.ITEM_MORE`, `ITEM_REFRESH`, `LIST_TOP` |
| 7 | `CYCLE_LIST` | Endlessly looping list of images | 2.0 | ✅ | — |
| 8 | `DIALOG` | Text + OK/Cancel pop-up | 2.0 | ⚠️ | Officially discontinued; use `createModal` |
| 9 | `FILL_RECT` | Solid rectangle (`radius`, `angle`) | 2.0 | ✅ | `alpha` 3.0; rotated draw-area props (`pos_x/y`, `rect_width/height`) 4.0 |
| 10 | `GRADIENT_POLYLINE` (page title "POLYLINE"; docs constant `GRADKIENT_POLYLINE` [sic], typings `POLYLINE`) | Line chart: `addLine({ data, count, color_from, color_to, curve_style })`, `clear()` | 2.0 (gradient/curve 2.1) | ✅ | Max height 150 px on a 480 screen; memory-hungry; one colour per line [DOC][OFF] |
| 11 | `GROUP` | Groups widgets for shared show/hide and events (bigger hit area) | 2.0 | ✅ | Relative coords; **cannot be nested**; not usable in Shortcut Cards/SecondaryWidget |
| 12 | `HISTOGRAM` | Bar chart with axis lines and labels, `prop.UPDATE_DATA` | 2.0 | ✅ | Per-bar colour/alpha arrays in 3.5 |
| 13 | `IMG` | Image with rotation (`angle`, `center_x/y`), `pos_x/y` offset, `alpha`, `auto_scale` | 2.0 | ✅ | 24/32-bit PNG recommended (§3.7) |
| 14 | `IMG_ANIM` | Frame animation from numbered image files | 2.0 | ✅ | `anim_path/prefix/ext/fps/size`, `repeat_count` (0 = forever), START/PAUSE/RESUME/STOP |
| 15 | `KEYBOARD` | App-drawn key grid (single ASCII char or image per key) with `click_func(kb, id, value)` | 3.0 | ✅ | Not the system IME; `prop.ADD_KEY/DEL_KEY/KEY_PARA/TEXT_STYLE/TEXT` |
| 16 | `PAGE_INDICATOR` | Page dots for Swiper-mode pages | 2.1 | ✅ | Vertical (3.0), colour mode (4.0). On T-Rex 3 the colour mode did not draw round dots; image dots did [COMM] OQ-44 |
| 17 | `PAGE_SCROLLBAR` | System-managed scrollbar (whole page or a `VIEW_CONTAINER` target); arc-shaped on round screens | 3.0 | ✅ | Create it after all content widgets (page height is fixed at end of `build`) [COMM] |
| 18 | `PICK_DATE` | Date/time wheel picker | 2.0 | ⚠️ | Deprecated after 3.6 in favour of `TIME_PICKER` |
| 19 | `PICKER` (`widget.WIDGET_PICKER`) | Generic multi-column wheel picker (≤ 5 columns, looping, units, fonts) | 3.0 | ✅ | `prop.TITLE/SUBTITLE/UPDATE_DATA/CUR_COLUMN`; design rule: ≤ 5 single-digit columns |
| 20 | `QRCODE` | QR code on a white background | 2.0 | ✅ | `bg_radius` 2.1 |
| 21 | `RADIO_GROUP` | Single-select group of `STATE_BUTTON`s | 2.0 | ✅ | Must call `prop.INIT`; colour mode 4.0 |
| 22 | `SCROLL_LIST` | Templated, data-bound list (text/image views per item type), per-item horizontal drag (swipe-to-delete), `UPDATE_DATA/UPDATE_ITEM/DELETE_ITEM` | 2.0 | ✅ | 4.0 adds `snap_type`, **`item_common_focus` (key-mode focus)**, `item_key_focus_change_func`, `enable_scroll_bar`, `view_index`. No custom fonts [OFF] staff, forum #367 |
| 23 | `SLIDE_SWITCH` | Image-based on/off switch | 2.0 | ✅ | `prop.CHECKED` |
| 24 | `SPORT_DATA` | Live workout metric field | 3.6 | ✅ (Workout Extension only) | See sensors/app-types reports |
| 25 | `STROKE_RECT` | Outlined rectangle | 2.0 | ✅ | Rotated draw area 4.0 |
| 26 | `SYSTEM_KEYBOARD` (`createKeyboard()`) | System input method: numeric, character, emoji, voice | **4.0** | ✅ | §3.10 |
| 27 | `TEXT` | Text: size, colour, alignment, wrapping, spacing, custom font, `text_i18n`, **arc layout** (`start_angle`, `end_angle`, `mode`, `radius`) | 2.0 | ✅ | Arc props have no level stated and are absent from the v2 docs [DOC] — probe on device |
| 28 | `TIME_PICKER` (docs `widget.WIDGET_TIME_PICKER`, typings `TIME_PICKER`) | Full-screen time or date picker | 3.6 | ✅ | `prop.YEAR/MONTH/DAY/HOUR/MINUTE` |
| 29 | `VIEW_CONTAINER` | Scrollable/stackable container: `scroll_enable`, `pos_x/y`, `z_index`, `modal`, `bounce` (3.0), `page` (3.0, for Swiper pages), `scroll_frame_func`/`scroll_complete_func` | 2.0 | ✅ | "In Zepp OS v3, you can create up to **7**" [DOC]; `horizontal: true` for horizontal scroll (4.0, in typings, recommended by silver-zepp in forum #489) |
| 30 | `VIRTUAL_CONTAINER` | Root node of a Flex layout | **4.0** | ✅ | §3.8 |
| + | `STATE_BUTTON` | Option inside CHECKBOX/RADIO groups | 2.0 | ✅ | Colour props 4.0 |

Also declared in the 4.0 typings but **not documented for Device Apps** (mostly watch-face widgets): `ARC_PROGRESS, BUTTON_GROUP, GROUP_VIEW, IMG_ARC_PROGRESS, IMG_GROUP, IMG_LEVEL, IMG_POINTER, IMG_PROGRESS, LINE_PROGRESS, TEXT_IMG, VARIANT_BUTTON, WIDGET_DELEGATE` [OFF] `T:` (`PublicWidgetType`, `IHmUIWidgetType`). Treat as unsupported unless proven on the watch [INF].

There is **no progress-bar widget**; build progress from `ARC` or `FILL_RECT` [COMM] water-reminders `C:wr-ui.md`.

### 3.3 Round-list and navigation building blocks

| Need | Use |
|---|---|
| Long vertical list with templates | `SCROLL_LIST` (system-rendered, data-bound; better than hundreds of widgets [INF]) |
| Full-screen paged views | `setScrollMode({ mode: SCROLL_MODE_SWIPER \| SCROLL_MODE_SWIPER_HORIZONTAL, options: { height \| width, count, modeParams: { on_page } } })` + `PAGE_INDICATOR` + one `VIEW_CONTAINER` per page |
| Free-scrolling tall page | Default `SCROLL_MODE_FREE`; widgets placed below y = 480 extend the page; `scrollTo({ y, animConfig })` (animation 3.6), `getScrollTop()`, `setScrollLock({ lock })`, bounce control via `modeParams.bounce` (3.6) |
| Swiper helpers | `swipeToIndex({ index })`, `getSwiperIndex()` (1-based) |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/page/*.mdx`. All `@zos/page` APIs are 2.0 except horizontal swiper (2.1), `modeParams` (3.0), `animConfig`/`bounce` (3.6) — all ✅.

### 3.4 CANVAS

Capabilities [DOC] `D:docs/reference/device-app-api/newAPI/ui/widget/CANVAS.mdx`:

- `setPaint({ color, line_width })`, `drawPixel`, `drawLine`, `strokeRect`/`drawRect` (x1,y1,x2,y2), `strokeCircle`/`drawCircle`, `strokeEllipse`/`drawEllipse`, `strokeArc`/`drawArc` (0° = 3 o'clock), `strokePoly`/`drawPoly` (`data_array` of points), `drawText({ x, y, text, text_size, color })`, `drawImage({ x, y, w, h, image, alpha })`, `clear({ x, y, w, h })`, `addEventListener` (CLICK_DOWN/UP/MOVE).
- "The canvas is stacked vertically, **up to three layers** can be stacked."
- Undocumented extras: `transform({ sx, sy, rotation })`, per-draw `alpha`, `cntr_coord_style` in the typings [OFF] `T:` (`CanvasWidget`); `drawFill(...)` used in an official sample [OFF] `S:application/3.0/3.0-feature/pages/canvas.js`.

Limits and patterns:

- A canvas seems limited to about screen width, and a page to about **three canvases** [COMM] forum #493 (SashaCX75), consistent with the three-layer rule [DOC].
- No path API (bezier/quadratic), no gradients, no clipping, no blend modes, no pixel read-back/`getImageData`, no off-screen buffers [DOC by absence].
- Animation = `clear` + redraw on `setInterval`; the official sample redraws at 10 fps (100 ms) [OFF] `S:…/canvas.js`. Prefer moving widgets (widget animation) over redrawing large canvas areas [INF].

```js
import { createWidget, widget, event } from '@zos/ui'
const cv = createWidget(widget.CANVAS, { x: 0, y: 0, w: 480, h: 480 })
cv.setPaint({ color: 0x0986d4, line_width: 14 })
cv.strokeArc({ center_x: 240, center_y: 240, radius_x: 223, radius_y: 223, start_angle: -90, end_angle: 180, color: 0x0986d4 })
cv.drawText({ x: 180, y: 210, text: '72%', text_size: 48, color: 0xffffff })
cv.addEventListener(event.CLICK_UP, (info) => { /* info.x, info.y */ })
```

### 3.5 Animation

| Mechanism | Details | Min API | T-Rex 3 |
|---|---|---|---|
| Widget property animation | `w.setProperty(prop.ANIM, { anim_steps: [{ anim_prop: prop.X \| Y \| W \| H \| ALPHA, anim_from, anim_to, anim_rate: 'linear'\|'easein'\|'easeout'\|'easeinout'\|'bounce', anim_duration, anim_offset }], anim_fps (default 25), anim_repeat (-1 = forever), anim_auto_start, anim_auto_destroy, anim_frame_func, anim_complete_func })` → returns an id; control with `prop.ANIM_STATUS` (START/STOP/PAUSE/RESUME) | 2.0 (`anim_repeat_func` 3.6) | ✅ |
| Frame animation | `IMG_ANIM` | 2.0 | ✅ |
| Scroll animation | `scrollTo({ y, animConfig })` | 3.6 | ✅ |
| Manual | Timers + `setProperty`/getter-setter or CANVAS redraw | 2.0 | ✅ |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/ui/widgetAnimations.mdx`. Only position, size and alpha animate — no rotation/scale/colour tweening (rotate an `IMG` by stepping `angle` yourself) [DOC by absence; INF]. Design guidance: keep animations short and simple on wearables [DOC] `D:docs/designs/visual/animations.md`. Community library `zeppos-fx` adds easing helpers [COMM].

### 3.6 Text and fonts

- `TEXT` options: `text`, `text_size`, `color`, `align_h` (`align.LEFT/RIGHT/CENTER_H`), `align_v` (`TOP/BOTTOM/CENTER_V`), `text_style` (`text_style.WRAP` \| `ELLIPSIS` (single line …) \| `NONE` (marquee, the default)); typings also have `CHAR_WRAP`; `line_space`, `char_space`, `font`, `text_i18n` (`'en-US'` key required) [DOC] `…/widget/TEXT.mdx`; [OFF] `T:`.
- **Curved text** for round screens: `start_angle`, `end_angle`, `mode` (0 inner / 1 outer), `radius` [DOC].
- **Custom fonts**: `.ttf` referenced by path — official sample uses `font: 'raw/custom.ttf'` with the file in `assets/raw/` [OFF] `S:application/2.0/showcase/page/ui/widget/text.js`. Supported by `TEXT` (2.0), `BUTTON` (3.6), `PICKER` `font_name` (3.0); **not** `SCROLL_LIST` [OFF] staff, forum #367. Community reported glyphs missing (only characters shown on first render get cached) until a reboot [COMM] forum #147, #443.
- System font is **Noto Sans** (Regular/Medium); **Zepp OS Number** / **Number Condensed** (Regular/Bold) are the system number fonts, downloadable as TTF to bundle yourself [DOC] `D:docs/designs/visual/font.md`, `D:docs/designs/download.md`.
- Type scale for a 480 round screen: Caption2 **24**, Caption1 **28**, Subheadline **32**, Body **36**, Title **40**. **Avoid text smaller than 24 px.** Line height = font size + 10 (v2 docs); current docs give 116% (Latin), 125% (CJK), 132% (tall scripts), 100% for the number fonts [DOC] `D:versioned_docs/version-v2/designs/visual/font.md`, `D:docs/designs/visual/font.md`.
- Official T-Rex 3 apps measured from screenshots: headline number ≈ 100 px, title ≈ 36, list rows ≈ 36, secondary ≈ 28, chart labels ≈ 20 [COMM] water-reminders `08-official-app-metrics.md`.
- i18n: `.po` files in `page/i18n/<lang>.po` + `getText(key)` (§6.4).

### 3.7 Images and assets

- **Format**: use 24- or 32-bit PNG (RGB/RGBA) [DOC] `…/widget/IMG.mdx`. The build converts PNG to the watch's native TGA-based format (`png2tga` in zpm) [OFF] `Z:bin/`. JPG/GIF/SVG/WebP are never mentioned [INF: unsupported].
- **Scaling**: at build time assets are scaled by `device width / designWidth`. On the T-Rex 3 (480 wide, designWidth 480) the factor is 1 [DOC] `D:docs/guides/framework/device/screen-adaption.md`.
- **Runtime images**: "The Device App can not show png images"; a PNG downloaded at runtime must be converted by the phone Side Service `image.convert({ filePath })` (3.0) before transfer and display from `data://` [DOC] `D:docs/reference/side-service-api/image-convert.mdx`, `D:docs/guides/version-info/new-features-30.md`.
- **Paths**: widget `src` is relative to the on-watch `/assets` root; `assets://` and `data://` prefixes since 3.0 [DOC] `D:docs/guides/framework/device/fs.md`.
- **Helpers**: `getImageInfo(path)` (2.0), `assets('img')(file, isRtl)` → `img/file@rtl.png` for RTL variants (2.0) [DOC].
- **Rotation quirks**: pixel-level differences between simulator and hardware (odd vs even widths), and images rotated by 90/180/270° blur fine patterns [COMM] forum #414.
- App icon: the registry lists `iconSize: 124` for T-Rex 3 [OFF] (presumably the launcher size [INF]); the store needs a 240 × 240 PNG with a 2 px transparent margin [DOC] `D:docs/distribute/index.md`, `D:docs/designs/self-checklist.md`.

### 3.8 Layout: absolute, containers and Flex (4.0)

**Absolute + containers (2.0+)**: the default. Use `GROUP` for shared visibility/events and `VIEW_CONTAINER` for scrolling regions or layers [DOC] `D:docs/guides/best-practice/widget-group.mdx`.

**Flex layout (API 4.0, ✅)** [DOC] `D:docs/guides/framework/device/layout.md`, `…/widget/VIRTUAL_CONTAINER.mdx`:

- Root is a `VIRTUAL_CONTAINER` with a `layout` object; children get `parent: root` (or `setLayoutParent`) plus their own `layout`.
- Units: `px`, `%` (parent-relative), `vw`, `vh`, `vmin`, `vmax` (decimals allowed to 0.001).
- Properties: `width/height` (`auto` for text), `min-/max-width/height`, `padding-*`, `row-gap`/`column-gap`, `left/top/right/bottom`, `align` ("center bottom"), `display: flex` (**grid not supported yet**), `flex-flow` (`row`, `column`, `-reverse`, `wrap`…), `justify-content` (start/end/center/space-between/around/evenly), `align-items`, `align-content`, `flex-grow`, `font-size`, `corner-radius`, `line-clamp`, and `tags` (`update`, `unscaled`, `scale-with-dpi`, `scale-with-width`, `scale-with-height`, `ignore-layout`, `newtrack`).
- Tree ops: `addLayoutChild(child, index)`, `removeLayoutChild(child)` (then also `deleteWidget`), `updateLayoutStyle(style)`, then call **`updateLayout()`** to re-render. `openInspector().draw({ line_color, line_width, border_mode })` outlines boxes in the simulator.
- Layout-capable widgets: SCROLL_LIST, VIEW_CONTAINER, GROUP, CHECKBOX/RADIO groups, SLIDE_SWITCH, KEYBOARD, CANVAS, CIRCLE, ARC, FILL_RECT, STROKE_RECT, CYCLE lists, BUTTON, TEXT, STATE_BUTTON, IMG, IMG_ANIM, WIDGET_PICKER, HISTOGRAM, PAGE_INDICATOR.
- Doc inconsistency: examples use `margin-top` and `background-color`, which are not in the property table [DOC].
- A community user saw Flex render correctly in the simulator but not on a device (unanswered) [COMM] forum #506 — verify layouts on the T-Rex 3 early.

```js
import { createWidget, widget, align } from '@zos/ui'
const root = createWidget(widget.VIRTUAL_CONTAINER, {
  layout: { x: '0', y: '0', width: '100vw', height: '100vh', display: 'flex',
            'flex-flow': 'column', 'justify-content': 'center', 'align-items': 'center', 'row-gap': '16' },
})
createWidget(widget.TEXT, { parent: root, text: 'Ready', color: 0xffffff, align_h: align.CENTER_H,
  layout: { width: '70%', height: 'auto', 'font-size': '40' } })
createWidget(widget.BUTTON, { parent: root, text: 'Start', normal_color: 0x0986d4, press_color: 0x055e8b,
  layout: { width: '50%', height: '80px', 'corner-radius': '40' }, click_func: () => {} })
```

### 3.9 Designing for the 480 × 480 round screen

**Adaptation mechanics** [DOC] `D:docs/guides/framework/device/screen-adaption.md`, `D:docs/guides/best-practice/multi-screen-adaption.mdx`:

- `app.json` (v3): platforms `[{ "st": "r" }]` (round), `designWidth` 480 (the default for round). The 4.2 samples write `{ "st": "r", "dw": 480 }` [OFF].
- `px(n)` = `Math.ceil(n / designWidth × deviceWidth)`. On the T-Rex 3 it is the identity function, so wrong or missing `px()` calls never show up — they only bite on the 466 px T-Rex 3 Pro 44 mm [DOC][COMM] P-21. Do not wrap values that already come from `getDeviceInfo()`.
- Per-shape layout files `*.r.layout.js` imported via `zosLoader:`.

**Geometry** (computed [INF]): the inscribed square is 339 × 339 starting at 70.3 px. Visible width of a horizontal band at distance *y* from the top:

| y (top of row) | 20 | 40 | 60 | 80 | 100 | 120 | 160 | 200 | 240 |
|---|---|---|---|---|---|---|---|---|---|
| visible width (px) | 192 | 265 | 318 | 358 | 390 | 416 | 453 | 473 | 480 |

**Official rules that matter here** [DOC unless noted]:

- Keep a 2 px safe margin; the top and bottom centre are reserved for status dots and the offline-voice indicator — put nothing important there (`D:docs/designs/specifications/safe-area.md`).
- Round screens centre-align titles and body text; list titles sit at the top of the list (`D:docs/designs/template/content-layout.md`, `template/list.md`).
- **Right swipe = back** is a system convention; avoid conflicting gestures (`D:docs/designs/self-checklist.md`, manual "Swipe from left to right: returns to the upper-level page").
- List spacing 8 px; cards 16 px apart and never taller than one screen (`self-checklist.md`).
- Tapped state: −28.6 % brightness; disabled: −50 % (`D:docs/designs/visual/color.md`). Contrast ≥ 4.5:1 (≥ 3:1 for large text) (`D:docs/designs/accessibility/contrast-ratio.md`).
- Colour tokens: page background `#000000`, key colour `#0986D4`, item background white 20 % (= `#333333` on black), subtitle white 70 %, secondary white 50 % [COMM] `C:wr-ui.md` (from the design library). A black background also suits the AMOLED panel [INF].

**Measured on official T-Rex 3 apps** [COMM] `08-official-app-metrics.md`: progress rings sit 10–16 px from the bezel with 14–16 px stroke; list side margins are 50–61 px (not the 70 px inscribed square); charts use 30 px margins; primary actions are **round buttons 71–88 px wide at the bottom centre** (centre y ≈ 366–419).

### 3.10 Text input

| Option | What you get | Min API | T-Rex 3 |
|---|---|---|---|
| **`SYSTEM_KEYBOARD`**: `createKeyboard({ inputType, onComplete(kb, { data }), onCancel, text })`, `deleteKeyboard()` | The system IME: `inputType.NUM`, `CHAR`, `EMOJI`, `VOICE` (full-screen). `onClick` and `selection` quick replies are "not available yet" | **4.0** | ✅ (VOICE needs the mic — `voice: true` — and region support; check with `keyboard.checkVoiceInputAvailable()` on 4.2+) |
| **Custom keyboard** (`inputType.JSKB` + `keyboard` API: `setContentRect`, `inputText`, `backspace`, `clearInput`, `sendFnKey`, `inputBuffer`, `switchInputType`, `isEnabled`, `isSelected`, `gotoSettings`) | Ship your own IME as a DataWidget that the user enables in Settings → Preferences → Keyboard (one custom keyboard at a time). Needs `minVersion` 4.2 and permission `device:os.input.method`. The keyboard widget cannot scroll, use VIEW_CONTAINER/SCROLL_LIST, talk to the phone or use BLE | **4.2** | ✅⁶ |
| `KEYBOARD` widget | App-drawn key grid for PINs/numbers | 3.0 | ✅ |
| `PICKER` / `TIME_PICKER` / `SLIDE_SWITCH` / radio/checkbox | Structured input without typing | 2.0–3.6 | ✅ |
| Phone-side Settings App (`TextInput`) | Type on the phone, sync via `settingsStorage` + Side Service | — | ✅ (see connectivity report) |

Sources: [DOC] `…/ui/widget/SYSTEM_KEYBOARD.mdx`, `…/ui/keyboard.mdx`, `D:docs/guides/keyboard/intro.mdx`, `quick-start.mdx`; [OFF] `S:application/4.2/simple-keyboard/app.json`, `page/index.js`. The built-in character keyboard covers English, French, German, Italian, Portuguese and Spanish plus symbols/emoji [DOC] `keyboard/intro.mdx`.

```js
import { createKeyboard, deleteKeyboard, inputType } from '@zos/ui'
createKeyboard({
  inputType: inputType.CHAR, text: '',
  onComplete: (_, result) => { deleteKeyboard(); save(result.data) },
  onCancel: () => deleteKeyboard(),            // right swipe or BACK
})
```

---

## 4. Interaction

### 4.1 Physical keys on the T-Rex 3

| Position | Name / constant | System default (from the T-Rex 3 manual and the 4-key design table) |
|---|---|---|
| Upper left | UP / `KEY_UP` | Watch face: Control Center. In apps: previous page / scroll up / +1. Hold: fast scroll. Long press is a user-assignable shortcut |
| Lower left | DOWN / `KEY_DOWN` | Watch face: Shortcut Cards. In apps: next page / scroll down / −1. Long press is a user-assignable shortcut |
| Upper right | SELECT / `KEY_SELECT` | Watch face: workout list (configurable). In apps: confirm / open the focused item. Press and long press are user-assignable shortcuts |
| Lower right | BACK / `KEY_BACK` | Watch face: app list. In apps: back one level. **Hold 5 s: power/restart menu** |

Sources: [DOC] `D:docs/reference/related-resources/physical-keys.mdx` + `4key.png`; `D:docs/designs/interaction/physical-buttons.md`; [OFF] T-Rex 3 manual `C:trex3-manual.txt` ("Press the upper right button-SELECT…", "Press the lower right button-BACK…", "Press and hold the BACK button for 5 sec…", "Press buttons for quick start-up… Long press SEL, Press SEL, Long press UP, Long press DOWN"). The generic design table attributes the 5 s power hold to SELECT; the T-Rex 3 manual says BACK — trust the manual for this device. `KEY_HOME` and `KEY_SHORTCUT` do not exist on 4-key watches. Users can bind an app to a shortcut button; whether third-party Mini Programs appear in that list is unverified [INF].

**API** — `onKey({ callback: (key, keyEvent) => boolean })` / `offKey()` (2.0, ✅) [DOC] `…/interaction/onKey.mdx`:

- Events: `KEY_EVENT_CLICK`, `KEY_EVENT_LONG_PRESS`, `KEY_EVENT_DOUBLE_CLICK`, `KEY_EVENT_PRESS`, `KEY_EVENT_RELEASE`. One click fires **PRESS → RELEASE → CLICK** [DOC, ZH version only] `D:i18n/zh-cn/.../interaction/onKey.mdx`.
- Return `true` to skip the system's default action.
- **Only one handler** per app; registering again replaces it. Handlers only live while the app runs.
- The English doc (and the English comment in the typings) wrongly labels `KEY_DOWN` as "SHORTCUT KEY"; the Chinese doc and the Chinese typing comment say DOWN [DOC][OFF].
- Measured values on a T-Rex 3: `KEY_SELECT = 13`, `KEY_EVENT_CLICK = 1` [COMM] water-reminders.

**Can apps really intercept taps?** Conflicting evidence:

- The design spec says JS apps **cannot** intercept single taps, only 1 s and 5 s long presses [DOC] `D:docs/designs/interaction/physical-buttons.md`.
- In practice `onKey` receives clicks on all four keys, and community apps map UP/DOWN/SELECT/**BACK** clicks with `return true` (padel score apps) [COMM] `trystan2k/padelbuddy` `page/game.js`; water-reminders OQ-18 (T-Rex 3). Whether the default action is always suppressed is still an open question (OQ-31).
- The 5 s BACK hold (power menu) is certainly not interceptable [INF].

Recommendation: use SELECT/UP/DOWN clicks freely, leave BACK as "back" (or intercept it only on game-like screens with an on-screen exit), test on the watch [INF].

Device detection: `getDeviceInfo().keyNumber === 4`, `keyType` like `sport_40` (4 buttons, no crown, workout mode) [DOC] `D:docs/designs/interaction/definition.md`, `…/device/getDeviceInfo.mdx`. Simulator keyboard: Enter = SELECT, Delete = BACK, ↑/↓ = UP/DOWN [DOC] `D:docs/guides/tools/simulator/index.md`.

**Key-driven navigation without custom code**: pages scroll with UP/DOWN by default (manual; design table). `SCROLL_LIST` with `item_common_focus: true` (4.0) shows a system focus highlight moved by UP/DOWN and activated by SELECT; the official 4.0 sample turns it on when `keyType` contains `sport` or `keyNumber === 4` [OFF] `S:application/4.0/4.0-feature/page/index.js`, `index.r.layout.js`. Typings also expose `item_key_focus_change_func`, `focus_over_func`, `system_focus_style`, `system_focus_width` [OFF] `T:`.

```js
import { onKey, offKey, KEY_UP, KEY_DOWN, KEY_SELECT, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS } from '@zos/interaction'
onKey({ callback: (key, ev) => {
  if (ev === KEY_EVENT_CLICK && key === KEY_SELECT) { lap(); return true }
  if (ev === KEY_EVENT_LONG_PRESS && key === KEY_SELECT) { openMenu(); return true }
  if (ev === KEY_EVENT_CLICK && (key === KEY_UP || key === KEY_DOWN)) { step(key === KEY_UP ? 1 : -1); return true }
  return false                                   // BACK and everything else: system default
} })
// in onDestroy: offKey()
```

### 4.2 Touch and gestures

| API | Notes | Min API | T-Rex 3 |
|---|---|---|---|
| Widget events `CLICK_DOWN`, `CLICK_UP`, `MOVE` | With `info.x/y`; use `GROUP` to enlarge hit areas | 2.0 | ✅ |
| `MOVE_IN`, `MOVE_OUT` | Only implemented on `BUTTON` | 2.0 | ⚠️ [OFF] staff, forum #294 |
| `onGesture({ callback: (e) => boolean })` / `offGesture()` | `GESTURE_UP/DOWN/LEFT/RIGHT`; return `true` to block the default (e.g. the right-swipe exit); one handler per app | 2.0 | ✅ |
| `BUTTON.longpress_func` | 700 ms | 2.0 | ✅ |

Horizontal scrollers (`VIEW_CONTAINER horizontal`, horizontal Swiper) fight the system right-swipe-back; intercept `GESTURE_RIGHT` with `onGesture` and give the user BACK as an exit [COMM] forum #489, #518; water-reminders OQ-42. Pinch/multi-touch, force touch and raw touch streams are not exposed [DOC by absence].

### 4.3 Wrist motion

`onWristMotion({ callback: ({ type, motion }) => {} })` (3.0, ✅): motion `WRIST_MOTION_LIFT`, `WRIST_MOTION_LOWER`, `WRIST_MOTION_FLIP`; `type` 0 = palm cover, 3 = wrist event (3.6) [DOC] `…/interaction/onWristMotion.mdx`. It only fires while your app runs, and the app is killed about 10 s after the screen turns off (§1.6) [INF]. A true raise-to-wake hook for apps is not available [OFF] staff answer about watch faces, forum #76.

### 4.4 Vibration, buzzer, sounds

| API | Details | Min API | T-Rex 3 |
|---|---|---|---|
| `Vibrator` (`@zos/sensor`): `start(opt?)`, `stop()`, `setMode(mode)`, `getConfig()` | Modes: `VIBRATOR_SCENE_SHORT_LIGHT / SHORT_MIDDLE / SHORT_STRONG` (20 ms), `DURATION` (600 ms), `DURATION_LONG` (1000 ms), `STRONG_REMINDER` (4 pulses in 1.2 s), `NOTIFICATION` (2 short), `CALL` and `TIMER` (continuous until `stop()`) | 2.0 | ✅ |
| `Vibrator.start([{ type, duration }, …])` + `getType()` | Scene sequences: `GENTLE_SHORT, STRONG_SHORT, STANDARD_CROWN, STRONG_CROWN, SPULSE_CROWN, DIPULSE_CROWN, KEYCODE_CLICK, URGENT, CONTINUOUS, PAUSE` | 3.6 | ✅ |
| `Buzzer`: `isEnabled()`, `getSourceType()`, `getStrength()` (0–2), `start(type, repeatCount)`, `stop()` | Types `ALARM, REMIND_1, REMIND_2, OPERATE, SUCCESS, FAILURE`; only plays if Settings → Sound & vibration → Buzzer scene → Other is on | 3.6 | ✅ (T-Rex 3 has a buzzer) |
| `SystemSounds`: `getEnabled()`, `getSourceType()`, `start(type, repeat)`, `stop()` | System ringtones `ALARM, MESSAGE, REGULAR, ACHIEVE, CAMERA, ABN_HIGH, ABN_LOW, SOS` | 3.6 | ⚠️ no speaker; expect `getEnabled()` false or no sound [INF] |
| `notify({ vibrate: 0..5 })` | Notification vibration patterns (linear motors only) | 3.0 | ✅ |

Sources: [DOC] `…/sensor/Vibrator.mdx`, `Buzzer.mdx`, `SystemSounds.mdx`, `…/notification/notify.mdx`; [OFF] manual (buzzer settings path matches the API). Reported pitfalls: on some devices mode constants do not match their descriptions; call `stop()` before `setMode()`/`start()`; staff hinted that numeric modes 1–30 may replace constants later [OFF] staff + [COMM] forum #239, #283. Test the feel on the watch.

```js
import { Vibrator, VIBRATOR_SCENE_SHORT_STRONG } from '@zos/sensor'
const vib = new Vibrator()
function buzz() { vib.stop(); vib.setMode(VIBRATOR_SCENE_SHORT_STRONG); vib.start() }
```

### 4.5 Toasts, modals, dialogs

| API | Details | Min API | T-Rex 3 |
|---|---|---|---|
| `showToast({ content })` (`@zos/interaction`) | Lightweight message; design spec: disappears after 3 s. `@zos/ui` also has `showToast({ text })` with `\n` line breaks | 2.0 | ✅ |
| `createModal({ content \| title, subtitle, text, src, textColor, textAlpha, okButton, cancelButton, capsuleButton: [...], autoHide, show, onClick: ({ type }) })` → `modal.show(bool)` | `type` is `MODAL_CONFIRM`, `MODAL_CANCEL`, or 10+ for capsule buttons | 2.0 (styles 3.6) | ✅ |
| `createDialog({ title, show, auto_hide, click_listener: ({ type }) })` (`@zos/ui`) | `type` 0 cancel / 1 confirm. Use `auto_hide: false` if the callback navigates | 2.0 | ✅ |
| `DIALOG` widget | Discontinued | 2.0 | ⚠️ |

Sources: [DOC] `…/interaction/showToast.mdx`, `createModal.mdx`, `…/ui/createDialog.mdx`, `D:docs/designs/template/pop-up-windows.md` (toast 3 s; global alert ≥ 2 s; ≤ 4 capsule buttons). Modals only exist while the app is in the foreground; background alerts need `@zos/notification` [DOC] `D:docs/guides/framework/device/system-notification.md`.

### 4.6 Screen control (`@zos/display`, `Screen` sensor)

| API | Behaviour | Min API | T-Rex 3 |
|---|---|---|---|
| `setPageBrightTime({ brightTime })` / `resetPageBrightTime()` | Keep the screen on for this page (1000 – 2147483000 ms, default 10000); resets when the page is destroyed | 2.0 | ✅ |
| `pauseDropWristScreenOff({ duration })` / `resetDropWristScreenOff()` | Ignore wrist-down screen-off (ms, default 30000, 0 = until reset) | 2.1 | ✅ |
| `pausePalmScreenOff({ duration })` / `resetPalmScreenOff()` | Ignore palm-cover screen-off | 2.1 | ✅ |
| `setWakeUpRelaunch({ relaunch: true })` | Reopen the app on wake instead of the watch face (the app exits ~10 s after screen-off) | 2.0 | ✅ |
| `setScreenOff()` | Turn the screen off now | 2.0 | ✅ |
| `getBrightness()` / `setBrightness({ brightness: 0..100 })` / `get/setAutoBrightness` | Manual brightness only works with auto brightness off; restore it when leaving | 2.0 | ✅ |
| `getSettings()` | `{ screen: { status, duration }, wrist: {…}, standby: { style, model, startTime, endTime } }` (standby = AOD settings) | 3.0 | ✅ |
| `Screen` sensor: `getStatus()` (1 on / 2 off), `getAodMode()`, `onChange/offChange` | — | 3.0 | ✅ |
| `Screen.getLight()` | Ambient light in lux | 3.6 | ✅ |
| `getScene()` (`@zos/app`) | `SCENE_APP`, `SCENE_WATCHFACE`, `SCENE_SETTINGS`, `SCENE_AOD` | 2.0 | ✅ |
| `getSystemMode()` (`@zos/settings`) | `DND`, `sleep`, `theater`, `systemLock`, `lowTemperature`, `powerSaving`, `ultraPowerSaving`, `button` (button mode), `accessibleSwitch` | 3.0 | ✅ |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/display/*.mdx`, `…/sensor/Screen.mdx`, `…/app/getScene.mdx`, `…/settings/getSystemMode.mdx`.

**AOD**: a Mini Program page is not drawn in always-on mode; AOD shows the watch face's AOD layer and the app exits ~10 s after the screen goes off [COMM] forum #518 + [DOC] setWakeUpRelaunch. There is no API to draw your own AOD from an app [DOC by absence].

**Keep-awake recipe** (pattern used by community apps; battery cost is real) [COMM] forum #396, #410; `trystan2k/padelbuddy` `utils/platform-adapters.js`:

```js
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff,
         pausePalmScreenOff, resetPalmScreenOff, setWakeUpRelaunch } from '@zos/display'
function keepAwake(on) {
  if (on) { setPageBrightTime({ brightTime: 10 * 60 * 1000 }); pauseDropWristScreenOff({ duration: 0 });
            pausePalmScreenOff({ duration: 0 }); setWakeUpRelaunch({ relaunch: true }) }
  else    { resetPageBrightTime(); resetDropWristScreenOff(); resetPalmScreenOff(); setWakeUpRelaunch({ relaunch: false }) }
}
```

---

## 5. Storage

### 5.1 What exists

| Store | Module / class | Persistence | Min API | Permission | T-Rex 3 |
|---|---|---|---|---|---|
| JSON key-value (singleton) | `@zos/storage` `localStorage` | Until uninstall | 2.0 | `device:os.local_storage` | ✅ |
| JSON key-value (instance, optional custom file) | `new LocalStorage(path?)` | Until uninstall; instance caches the whole file in RAM | 3.0 | `device:os.local_storage` | ✅ |
| In-memory session key-value | `sessionStorage` / `new SessionStorage()` | Cleared on app exit | 2.0 | — | ✅ |
| Typed scalars (system properties) | `new TypedStorage(scope?)`: `get/putBool/Int/Int64/Double/String`, `has`, `remove`, `clear` | Persistent | 3.0 per docs | not stated | ⚠️ (not in the 4.0.0 typings; used by a community app targeting T-Rex 3 at 4.4 [COMM]) |
| Publish to other apps | `ShareLocalStorage(path?)`, `ShareTypedStorage(scope?)` | Persistent | 3.0 per docs | `device:os.local_storage` | ⚠️ newly documented, not in typings — probe |
| Read another app's data | `@zos/share-storage`: `LocalStorage(appId, path?)` (`getItem`, `isExisted`), `TypedStorage(appId, scope?)`, `FileSystem(appId)` (read-only `openSync/readSync/readFileSync/statSync/closeSync`) | — | 3.0 per docs | — | ⚠️ probe |
| Files | `@zos/fs` (sync only) | Until uninstall | 2.0 | none stated | ✅ |
| Phone-side settings | `settingsStorage` (Settings App / Side Service only; strings) | On phone | — | — | Not readable on the watch; relay through the Side Service |

Sources: [DOC] `D:docs/reference/device-app-api/newAPI/storage/*.mdx`, `…/share-storage/*.mdx`, `…/fs/*.mdx`; [OFF] `T:` (`@zos/storage` exports only `localStorage, LocalStorage, sessionStorage, SessionStorage`; no `@zos/share-storage` module); [COMM] `C:wr-storage-settings.md`.

### 5.2 File system (`@zos/fs`)

- Two roots: read-only `/assets` (your package; `openAssetsSync`, `statAssetsSync`) and a private read-write `/data` per app (everything else). Since 3.0, absolute paths `assets://…` and `data://…` [DOC] `D:docs/guides/framework/device/fs.md`.
- API (all 2.0, ✅): `openSync({ path, flag, options: { appId } })` (flags `O_RDONLY, O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_EXCL, O_TRUNC`; `appId` opens another app's `/data`, 3.0), `readSync/writeSync({ fd, buffer, options: { offset, length, position } })`, `closeSync`, `readFileSync({ path, options: { encoding } })` (string or ArrayBuffer), `writeFileSync({ path, data, options })` (overwrites), `statSync` (`{ size }` only), `readdirSync`, `mkdirSync`, `rmSync`, `renameSync` [DOC].
- **Everything is synchronous** and blocks the UI thread; large reads/writes freeze the UI [COMM] easy-storage README.
- No quotas or file-size limits are documented; `getDiskInfo()` returns device-wide totals only [DOC] `…/device/getDiskInfo.mdx`; [COMM] OQ-09.
- App Service may only **write** files while the screen is off or in AOD [DOC] `D:docs/guides/framework/device/app-service.md`.

### 5.3 Measured and reported storage pitfalls

| Pitfall | Evidence |
|---|---|
| **JS memory is small**: reading a ~200 KB file in one go threw "out of memory" on a GTR 4; read in chunks or split files | [OFF] Zepp staff, forum #49 |
| `LocalStorage` reads the whole file into RAM and `setItem` rewrites the whole file, **non-atomically**; while writing, other readers see it **empty**. Measured transient empty reads: 27 % of page reads, 67 % while BLE messages arrive (T-Rex 3). Writing back a value read during that window destroys data | [COMM] water-reminders P-17, P-28, P-29 |
| `getItem(key, default)` has returned `undefined` instead of the default | [COMM] P-17 |
| Page and App Service each hold their own in-memory copy; the last writer wins | [COMM] storage notes |
| Appending a 29-byte line with `writeSync` took ~17 ms on a T-Rex 3 | [COMM] OQ-29 |
| `Buffer.from(str).buffer` may be a larger pool buffer (Node); slice by `byteOffset/byteLength` before `writeSync` | [COMM] P-32 |
| The official 3.0 Calories sample replaced `@zos/storage` with its own `@zos/fs` JSON store (`statSync` first, `try/catch` on parse) | [OFF] `S:application/3.0/calories/utils/storage.js` |

### 5.4 Recommended persistence patterns [INF, built on the evidence above]

1. **Small settings/state** (< a few KB): one `LocalStorage` instance held for the app's lifetime; the in-memory object is the source of truth; write on meaningful change and in `onDestroy`; never read-modify-write a counter from storage.
2. **Growing logs/history**: append-only JSON-lines files via `openSync(…, O_RDWR | O_CREAT | O_APPEND)` + `writeSync`, one file per day/week, compacted at startup. Read big files in chunks.
3. **Critical config**: two slots with a version number (write the other slot, then flip a pointer), so a torn write never loses the last good copy.
4. **Autosave** every 1–5 minutes on screens users stay on (notifications and the 10 s screen-off exit can kill the page) [COMM] forum #342.
5. `@silver-zepp/easy-storage` (official list) wraps these: `EasyStorage` (single JSON blob), `EasyFlashStorage` (one file per key), `EasyTempStorage` (RAM), `EasyTSDB` (time-series, sharded), `AsyncStorage`/`EasyStorageAsync` (queued/chunked to avoid UI freezes), static `Storage` helpers [OFF] `scratchpad/src/easy-storage/README.md`.

```js
import { openSync, readSync, closeSync, statSync, O_RDONLY } from '@zos/fs'
// Chunked read: avoids one huge allocation (the OOM trap)
function readLines(path, onLine, chunk = 4096) {
  const st = statSync({ path }); if (!st) return
  const fd = openSync({ path, flag: O_RDONLY }); const buf = new ArrayBuffer(chunk); let rest = ''
  for (let pos = 0; pos < st.size; pos += chunk) {
    const n = readSync({ fd, buffer: buf, options: { position: pos, length: Math.min(chunk, st.size - pos) } })
    const parts = (rest + Buffer.from(buf, 0, n).toString('utf8')).split('\n'); rest = parts.pop()
    parts.forEach((l) => l && onLine(JSON.parse(l)))
  }
  if (rest) onLine(JSON.parse(rest)); closeSync(fd)
}
```

(Splitting a UTF-8 buffer at chunk edges can cut a multi-byte character in half; keep log lines ASCII or buffer the tail bytes [INF].)

---

## 6. Other watch-side modules

### 6.1 `@zos/device`

| API | Returns | Min API | T-Rex 3 |
|---|---|---|---|
| `getDeviceInfo()` (permission `data:os.device.info`) | `width`, `height`, `screenShape` (`SCREEN_SHAPE_ROUND/SQUARE`), `deviceName`, `keyNumber`, `deviceSource`, `keyType`, `deviceColor` | 2.0 | ✅ |
| … `uuid` (32-byte device identifier) | — | 4.2 | ✅⁶ (useful as a 4.2 feature probe) |
| `getDiskInfo()` | `total`, `free`, `app`, `watchface`, `music`, `system` (bytes) | 2.0 | ✅ |

`getDeviceInfo()` does not return the API level; use `getSystemInfo().minAPI` [DOC][COMM]. Sources: [DOC] `…/device/*.mdx`.

### 6.2 `@zos/user`

- `getProfile()` (permission `data:user.info`, 2.0, ✅): `age`, `height`, `weight` (0 if unset), `gender` (`GENDER_MALE/FEMALE/UNSPECIFIED`), `nickName`, `region` (ISO code of the account) [DOC] `…/user/getProfile.mdx`.
- `addHealthData({ weight /* g */, bmi /* ×100 */ })` (permission `data:user.health`, 3.0, ✅) — writes body data [DOC].
- Nothing else about the user (no email, no user id, no contacts, no calendar) is exposed [DOC by absence].

### 6.3 `@zos/settings` (read-only system settings)

`getLanguage()` (numeric code, mapping in `D:docs/reference/related-resources/language-list.mdx`), `getDateFormat()`, `getTimeFormat()` (2.1), `getDistanceUnit()`, `getWeightUnit()`, `getTemperatureUnit()` (2.1), `getSleepTarget()`, `getWeightTarget()`, `getSystemInfo()` → `{ osVersion, firmwareVersion, minAPI }` (2.1), `getSystemMode()` (3.0) — all ✅ [DOC] `…/settings/*.mdx`. There is no API to change system settings besides the display ones in §4.6 [DOC by absence].

### 6.4 i18n

- `page/i18n/<lang>.po` files (`msgid`/`msgstr`) + `getText(key)` from `@zos/i18n` (2.0, ✅); app-name translations in `app.json` `i18n` [DOC] `D:docs/guides/best-practice/i18n.mdx`. The build compiles `.po` into `assets/raw/locale/*.btxt` [COMM].
- Per-widget `text_i18n` on `TEXT` [DOC]; RTL via `getRtlLayout()`/`relayoutRtl()` and `assets()` `@rtl` images [DOC].
- Behaviour when the watch language has no `.po` file is undocumented; keep an English fallback in code [COMM] flashcards-trex3 notes. `.po` files belong to one module: a Shortcut Card did not pick up the page's `.po` [COMM] OQ-47.
- Official helper `@silver-zepp/polyglot` (spreadsheet-driven translations, runtime language switching) [OFF] `scratchpad/src/polyglot/README.md`.

### 6.5 Timers

| API | Notes | Min API | T-Rex 3 |
|---|---|---|---|
| Global `setTimeout` / `setInterval` | Page-scope only; stop running when the app exits (and on screen-off shortly after) | 2.0 | ✅ |
| `@zos/timer` `createSysTimer(periodic, periodMs, cb, arg)` / `stopTimer(id)` | "System-level timer that can be registered in device app services and runs regardless of watch screen state" | **4.0** | ✅ |
| `Time` sensor `onPerMinute`, `onPerDay` (2.1), `onPerHourEnd` (3.6), `onSunrise/onSunset` (3.0) | Wall-clock events | 2.1+ | ✅ |

Sources: [DOC] `…/global/setTimeout.mdx`, `…/timer/*.mdx`, `…/sensor/Time.mdx`. Background scheduling (alarms, App Service) is covered by the app-types report.

### 6.6 `@zos/utils`

`px()`, `assets()`, `log` (`getLogger(name)` → `log/warn/debug/error/info`), `EventBus` (`on/off/emit/once/clear/count`) — 2.0, ✅; `bufferToString`/`stringToBuffer` — documented 4.0, `stringToBuffer` reported missing at 4.4 [DOC] `…/utils/*.mdx`; [COMM] P-24.

### 6.7 `@zos/crypto`

Documented at API 3.0 [DOC] `…/crypto/*.mdx` (recently added pages):

- `createCrypto(alg.MD5 | SHA_1 | SHA_256 | HMACMD5 | HMAC_SHA_1 | HMAC_SHA_256, opts)` → `encrypt(data)` or streaming `start/update/finish` → `{ md_content, length }`.
- `createCrypto(alg.AES_CBC, { key_bit_length: 128, key_encrypt, private_key })` → `createChiper()` (sic), `encrypt/decrypt` (input a multiple of 16 bytes).
- `createCrypto(alg.CRC16 | CRC32)`; `createCrypto(alg.ECDSA, { ecp_dp_mode: SECP192K1 | SECP224K1 | SECP256K1 })` sign/verify (digest MD5/HMACMD5 only).
- `encryptKey(data)` — AES with the hardware PUF key.

⚠️ Not present in the 4.0.0 typings; probe before relying on it. There is no documented secure random-number API [DOC by absence; INF].

### 6.8 `@zos/app`

| API | Purpose | Min API | T-Rex 3 |
|---|---|---|---|
| `getPackageInfo()` | Fields from your `app.json` | 2.0 | ✅ |
| `getPackageInfoById({ appId })` | Another installed app's info | 4.0 | ✅ |
| `getScene()` | See §4.6 | 2.0 | ✅ |
| `queryPermission` / `requestPermission` | Runtime permissions (needed for continuously running App Services) | 3.0 | ✅ |
| `emitCustomSystemEvent({ eventName: 'event:customize.x', eventParam })` | Wake your App Service | 3.0 | ✅ |
| **`getPerformance('memory', 'perf')`** | `memory.system {used,total}`, `memory.app[] {appid, used, peak, modules[] {file, used, peak}}`, `memory.leaking[]`; `perf.modules[] {file, evalTime, createTime, initTime, buildTime}` | **4.0** | ✅ |

Sources: [DOC] `…/app/*.mdx`; [OFF] `T:`. `getPerformance` is the only way to learn real memory ceilings on the T-Rex 3 — run it early:

```js
import { getPerformance } from '@zos/app'
import { log } from '@zos/utils'
const p = getPerformance('memory', 'perf')
log.getLogger('perf').log(JSON.stringify({ sys: p.memory && p.memory.system, app: p.memory && p.memory.app }))
```

### 6.9 `@zos/app-access`

`getSportData({ type }, cb)` (3.6, permission `data:user.hd.workout`): live workout values (`speed, avg_speed, pace, avg_pace, distance, duration, calories, cadence, avg_cadence, altitude, total_up_altitude, total_count, vertical_speed, downhill_count, total_downhill_distance`) as JSON strings — intended for Workout Extensions; see the sensors report [DOC] `…/app-access/getSportData.mdx`.

### 6.10 `@zos/media` (Player / Recorder)

| API | Details | Min API | T-Rex 3 |
|---|---|---|---|
| `create(id.PLAYER)`: `setSource(source.FILE, { file })` → `prepare()` → PREPARE event → `start()`; `pause/resume/stop`, `getDuration`, `get/setVolume` (0–100), `getTitle/getArtist/getMediaInfo`, `getStatus`, events PREPARE/COMPLETE/PLAY/STOP/PAUSE/PROGRESS | **MP3**, plus OPUS files recorded by the Recorder. Paths are relative to `assets` unless `data://` | 3.0 | ⚠️ **no speaker**: needs Bluetooth headphones like the built-in music player [OFF manual]; whether JS playback is routed to BT headphones is unverified [INF] |
| `Player.seek(percent)` | Seek by percentage; state diagram in the 4.2 notes | 4.2 | ✅⁶ |
| `Player.seekTo(seconds)` | Seek by seconds | 4.3 | ✅⁶ |
| `create(id.RECORDER)`: `setFormat(codec.OPUS, { target_file: 'data://x.opus' })`, `start`, `stop`, `getStatus`, events START/STOP | OPUS, 16 kHz, mono, 16-bit | 3.0 | ⚠️ mic present (`voice: true`) → likely works [INF]; reported bugs: watch froze on exit (GTR 4), mic locked system-wide until reboot (Balance) [COMM] forum #301, #556 |

Sources: [DOC] `…/media/create.mdx`, `Player.mdx`, `Recorder.mdx`, `D:docs/guides/faq/opus-to-mp3.md`, `new-features-42.md`. The simulator did not support media in 2024 [COMM] forum #301. `@silver-zepp/easy-media` wraps both and has `isSpeakerAvailable(cb)` to probe audio output [OFF] `scratchpad/src/easy-media/README.md`. No permission code is documented for media [DOC].

### 6.11 System events and notifications (context only)

- System events (`event:os.health.sleep_status`, `…heart_rate_abnl`, `…stress_remind`, `…wear_status`, `event:os.system.sleep_mode`, sun/moon rise/set) wake an **App Service**, not a page; each event name is also a permission (3.0) [DOC] `D:docs/guides/framework/device/system-event.md`.
- `@zos/notification` `notify({ title, content, actions: [{ text, file, param }], vibrate })`, `cancel`, `getAllNotifications` (3.0, `device:os.notification`) can be called from pages or services [DOC]. Point actions at a **page**, not an App Service: services cannot write files while the screen is on, so service actions appear to do nothing [COMM] P-15. Only `actions[0]` shows on the card view [COMM] P-14.
- Details belong to the app-types/background report.

### 6.12 Known Zepp OS 6 regression

On a T-Rex 3 with Zepp OS 6, the `Music` sensor (phone music control) returns `32` for every call and `checkAvailable()`/`start()` **crash the watch** (it worked before the update) [COMM] forum #564, 2026-09-12. Flagged here because it is a watch-side crash; see the sensors report.

---

## 7. Performance limits and pitfalls

| Area | What is known | Evidence |
|---|---|---|
| **RAM ceiling** | Not documented anywhere. Staff: "the device has a limit on the total amount of memory JS can run on"; a 200 KB file read at once OOMs (GTR 4). Measure on the T-Rex 3 with `getPerformance('memory')` | [OFF] forum #49; [DOC] getPerformance |
| **Code size / startup** | No documented package limit. One store app has ~424 KB of bytecode across six bundles (≈ 1 MB as JS); the store served T-Rex 3 (among 26 devices) a server-rebuilt package with plain JS instead of bytecode (2.47× larger, slower to parse). Each page is a separate bundle | [COMM] forum #568; [OFF] zpm |
| Startup hot spots | On a T-Rex 3 app the cost was data work (8 whole-file storage reads + 54 fs calls + 2 sensor reads), not 40 `createWidget` calls; create all widgets in `build()` and defer data work | [COMM] P-30 |
| Widget limits | ≤ 7 `VIEW_CONTAINER`s (v3); canvases stack ≤ 3 layers (≈ 3 canvases, each ≤ screen width); POLYLINE ≤ 150 px tall, memory-heavy, and too many polylines stop rendering; `GROUP` cannot nest; `SCROLL_LIST` has no custom font | [DOC]; [COMM] forum #493; [OFF] forum #367 |
| Single thread | No workers; long loops freeze the UI and key/touch handling. Chunk work with `setTimeout(…, 0)` between slices; offload heavy work (parsing, big data) to the phone Side Service | [INF]; [COMM] forum #329 |
| Storage I/O | Synchronous and slow for big files; whole-file JSON rewrites | [COMM] easy-storage, P-17 |
| Background | Pages die ~10 s after screen-off; App Service single runs are capped at **600 ms** and cannot use timers/UI/high-power sensors | [DOC] setWakeUpRelaunch, app-service.md |
| Logging | Lines are truncated; on-device logs only via the Zepp App developer mode; no breakpoints | [DOC] debug.mdx, error-catch.mdx |
| Simulator ≠ device | Media unsupported in the simulator; Flex, image rotation and fonts can differ; always verify on the watch | [COMM] forum #301, #414, #506, #443 |
| Fonts | Custom TTF glyph caching can drop characters until reboot | [COMM] forum #147 |
| Vibration | Constants behave differently per device/firmware | [COMM/OFF] forum #239, #283 |
| Battery | Keeping the screen on (and high brightness) is the biggest drain | [COMM] forum #396 |

Rules of thumb [INF]: keep each page bundle small (hundreds of KB of JS at most); avoid large in-memory arrays (store history on disk, aggregate incrementally); prefer `SCROLL_LIST` and widget reuse (`setProperty`/getter-setter) over delete-and-recreate; cap animation at ~10–25 fps; test memory with `getPerformance` on every milestone.

---

## 8. NOT possible on the watch side (T-Rex 3)

Hard "no" (by documentation, official code or official answer):

1. **No `async/await`** in device code (staff answer); no generators per docs. Use Promise chains.
2. **No `eval`/`new Function`**, no dynamic `import()`, no downloading and running code.
3. **No direct networking**: no `fetch`, XHR, WebSocket, sockets, Wi-Fi APIs. All internet traffic goes through the phone Side Service.
4. **No Node.js or browser APIs**: no DOM, `window`, `TextEncoder`, `atob`, web `localStorage`, `Intl` (likely), workers.
5. **No native TypeScript** in the Zeus build (pre-compile yourself).
6. **No running while the screen is off or in AOD**: pages exit ~10 s after screen-off; apps cannot draw AOD. Only App Service (600 ms single runs or a user-approved continuous service), alarms and notifications continue.
7. **No persistent live page stack**: `push` destroys the current page; `back()` cannot return values.
8. **No SecondaryWidget** on the T-Rex 3.
9. **No speaker**: no loud audio playback; `SystemSounds` likely silent; audio needs BT headphones (unverified for JS). The buzzer and vibration motor are the alert channels.
10. **No digital crown**: `onDigitalCrown` and swiper `crown_enable` are irrelevant; there is no `KEY_HOME`/`KEY_SHORTCUT`.
11. **Cannot override** the BACK 5 s power menu or other system-level key combos (screenshot SEL + DOWN); single-tap interception is officially disallowed by the design spec even though `onKey` delivers taps (verify).
12. **No arbitrary system control**: no changing settings beyond display brightness/screen timeout; can open only the listed system apps; cannot control other Mini Programs beyond launching them and reading their shared storage.
13. **No PNG decoding at runtime**: downloaded images must be converted on the phone first; no JPEG/SVG/GIF.
14. **Drawing limits**: no vector paths/beziers, gradients (except POLYLINE fill), clipping, pixel read-back or off-screen canvases; ≤ 3 canvas layers; only x/y/w/h/alpha are animatable.
15. **No custom fonts in `SCROLL_LIST`**; no font-family selection of system fonts (bundle TTFs instead).
16. **No multi-touch/pinch**, pressure data or raw touch streams; `MOVE_IN/MOVE_OUT` only on `BUTTON`.
17. **No documented storage quotas, atomic writes, transactions, flush or fsync**; no async file I/O.
18. **No user identity** beyond `getProfile()` fields (nickname, age, height, weight, gender, region); device `uuid` only on 4.2+.
19. **No 4.2+ features on older firmware**: custom keyboard, `Player.seek`/`seekTo`, device `uuid` require the Zepp OS 6 update (API 4.4).

Things that *are* possible but often assumed not to be: Promise-based code, Flex layout (4.0), property getters/setters (4.0), the system keyboard including voice (4.0), curved text, canvas drawing (3.0), MP3/OPUS playback and OPUS recording (hardware-dependent), crypto digests/AES/ECDSA (3.0), system-level timers in services (`createSysTimer`, 4.0), launching system apps, and reading another Mini Program's shared data (3.0).

---

## Appendix A — API_LEVEL quick matrix for this report's scope

| Level | Watch-side capabilities introduced (non-exhaustive) | T-Rex 3 |
|---|---|---|
| 2.0 | App/Page/router, all basic widgets, widget animation, `@zos/interaction` keys/gestures/toast/modal, `@zos/display` brightness/keep-on, `@zos/fs`, `localStorage`/`sessionStorage`, `@zos/utils`, `@zos/i18n`, `getProfile`, `getDeviceInfo`, Vibrator, `launchApp` (Mini Programs) | ✅ |
| 2.1 | PAGE_INDICATOR, horizontal swiper, `setAlpha`, wrist/palm screen-off pause, `getSystemInfo`, `getTimeFormat`, `Time.onPerMinute` | ✅ |
| 3.0 | CANVAS, KEYBOARD, PICKER, PAGE_SCROLLBAR, `data://`/`assets://`, `LocalStorage` class, media, `onWristMotion`, `Screen` sensor, `getSettings`, `getSystemMode`, system-app launch, notifications, crypto, share-storage (per docs), App Service | ✅ |
| 3.5/3.6 | `createModal` styles, BUTTON fonts, scroll animation/bounce, TIME_PICKER, Buzzer, SystemSounds, Vibrator scenes, `getAppIdByName`, `getSportData`, SPORT_DATA, DataWidget | ✅ |
| 4.0 | Flex layout (`VIRTUAL_CONTAINER`), getter/setter, SYSTEM_KEYBOARD, SCROLL_LIST key focus/snap/scrollbar, colour check/radio/indicator, `getPerformance`, `getPackageInfoById`, `createSysTimer`, `bufferToString`/`stringToBuffer`, `VIEW_CONTAINER.horizontal` (typings) | ✅ |
| 4.2 | Custom keyboard (`keyboard` API, `inputType.JSKB`), `Player.seek`, `getDeviceInfo().uuid`, Workout nav/HR zones | ✅⁶ |
| 4.3 | `Player.seekTo` | ✅⁶ |
| 4.4 | Current T-Rex 3 level; no documented 4.4-only APIs | ✅⁶ |

## Appendix B — Key sources

Official docs (local): `D:docs/guides/framework/device/*`, `D:docs/guides/best-practice/*`, `D:docs/reference/device-app-api/newAPI/**`, `D:docs/designs/**`, `D:docs/reference/related-resources/{device-list,physical-keys}.mdx`, `D:versioned_docs/version-v2/designs/visual/font.md`, `D:i18n/zh-cn/...` (extra detail on key events).

Official code/artifacts: `S:application/{2.0,3.0,4.0,4.2}/*`; `scratchpad/src/zml` (Promise/timer/Buffer shims per API level); `scratchpad/src/easy-{storage,media,draw}`; `@zeppos/device-types@4.0.0` (`T:`); `@zeppos/zpm@3.4.2` (`Z:`: rollup/esbuild ES2020, qjsc 2020-07-05, png2tga); Zeus device registry `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json`; T-Rex 3 manual `https://support.amazfit.com/en/amazfit_t-rex_3/files/user-manual.pdf.pdf`; Zepp staff replies in `github.com/zepp-health/zeppos-forum` discussions #49, #239, #283, #294, #367, #473.

Community: zeppos-forum discussions #147, #301, #329, #342, #396, #410, #414, #437, #438, #443, #448, #489, #493, #506, #518, #556, #564, #568; `github.com/Nieole/water-reminders` (real-device T-Rex 3 / Zepp OS 6 notes, saved in `C:wr-*.md`); `github.com/trystan2k/padelbuddy`; `github.com/kassiohenrique977-blip/flashcards-trex3`; reviews (Tech Advisor, OutdoorGearLab, DC Rainmaker); news (gadgetsandwearables.com 2026-04-29, 2026-09-03; Amazfit blog Dec 2025).
