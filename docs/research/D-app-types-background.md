# D — App types, background execution, notifications/alarms & watch faces on the Amazfit T-Rex 3

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Research agent D · 2026-09-28 · scope: what you can ship on Zepp OS, where it shows up on a T-Rex 3, what can run in the background (and when), alarms, notifications, watch faces.

---

## 0. How to read this report

**Evidence tags** (used on every claim that matters):

- **[A]** = verified from official Zepp sources: the docs source, official samples, official libraries, published type packages, Zepp's device registry, or the T-Rex 3 manual.
- **[B]** = community report: GitHub repos, discussions, news. The URL is given.
- **[C]** = my inference. Treat it as a hypothesis to test on the watch.

**Path shorthands** (all local clones live under `scratchpad/`):

| Shorthand | Expands to | Notes |
| --- | --- | --- |
| `DOCS/` | `src/zeppos-docs/docs/` | single commit `c08725b`, dated 2026-07-17 |
| `ZH/` | `src/zeppos-docs/i18n/zh-cn/docusaurus-plugin-content-docs/current/` | Chinese docs |
| `SAMPLES/` | `src/zeppos-samples/` | |
| `ZML/` | `src/zml/` | `@zeppos/zml` 0.0.41 |
| `TYPES4/` | `research/types4/package/dist/index.d.ts` | `@zeppos/device-types` 4.0.0, published 2026-06-17 on npm |
| `COMM/` | `research/community/` | local copies of community repos I read |

### 0.1 Freshness correction: the T-Rex 3 is on Zepp OS 6.0 at API_LEVEL 4.4

- **The docs table is out of date.** `DOCS/reference/related-resources/device-list.mdx` (and the live page, checked 2026-09-28) still lists the T-Rex 3 as API_LEVEL 4.0 / Zepp OS 4.5.
- **Zepp's own device registry says 6.0 / 4.4 [A].** The Zeus CLI registry at `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json` lists deviceSource `8716544`, `8716545` and `8716547` ("Matterhorn"). Each shows `os.version: "6.0"`, `apiLevel: "4.4"` and `apiLevelLimitMax: "4.4"`. A copy is saved at `research/zeus-devices.json`.
- **News confirms the rollout [B].** Zepp OS 5.0 reached the T-Rex 3 as firmware 4.1.5.1 in November 2025, then 4.1.6.9 ([thewearify](https://thewearify.com/amazfit-t-rex-3-receives-zepp-os-5-0-update/)). Zepp OS 6 started rolling out on 2026-07-22 as firmware 6.2.104.6 ([gadgetsandwearables](https://gadgetsandwearables.com/2026/07/22/amazfit-t-rex-3-pro-ultra-2-zepp-os-6-update/); [os.zepp.com compatibility](https://os.zepp.com/compatibility-zepp-os-6)).
- **Measured on a real watch [B].** One T-Rex 3 on firmware 6.2.104.6 returned `getSystemInfo().minAPI` = `4.4` ([Nieole/water-reminders, device matrix](https://github.com/Nieole/water-reminders/blob/HEAD/docs/zepp-os/06-device-matrix.md)).
- **Consequence.** On updated firmware, features documented at API_LEVEL 4.1–4.3 are **available**; in this report they are labelled "needs Zepp OS 6 firmware". An example is the 4.2 custom keyboard. The docs describe no 4.4-specific APIs; the only API marked above 4.2 is one `media/Player` method at 4.3 (`DOCS/reference/device-app-api/newAPI/media/Player.mdx`).
- **Launcher 2.0 is not on the T-Rex 3.** Zepp OS 6 also brought a new launcher, "Launcher 2.0", which folds the horizontal widgets into Shortcut Cards. The T-Rex 3 received Zepp OS 6 without it ([gadgetsandwearables 2026-08-20](https://gadgetsandwearables.com/2026/08/20/amazfit-zepp-os-6-new-launcher-missing/); [os.zepp.com launcher post](https://os.zepp.com/news/redesigning-the-launcher-around-what-matters-most)) [B].
- **Check your own watch.** `import { getSystemInfo } from '@zos/settings'` returns `minAPI`. Alternatively, open Zepp App → Developer mode → Device information (`DOCS/guides/tools/zepp-app.mdx`) [A].

### 0.2 The ten hardest facts (TL;DR)

1. **The background model is event-driven.** There is no always-running process.
   - The recommended mode is the *single-execution* App Service. An alarm, a notification button, or a system event wakes it; it gets **600 ms**; then it exits.
   - An always-on (*continuous*) service exists, but it needs the `device:os.bg_service` permission and a runtime user-consent dialog.
   - **Only one app downloaded from the app store can run in the background at a time, across the whole watch.** [A]
2. **App Services cannot use UI, `setTimeout`/`setInterval`, Accelerometer, Gyroscope, Geolocation (GPS), or BLE-central (`mst*`) APIs.** [A]
   - **They can** use low-power sensors (heart rate, steps, calories, battery, wear, sleep, stress…), notifications, BLE messaging to the phone, file reads, and the time sensor.
   - **They can only write files while the screen is off or in AOD.** [A]
3. **API_LEVEL 4.0 adds `@zos/timer` `createSysTimer()`**: a millisecond timer designed for app services that "runs regardless of watch screen state". It is available on the T-Rex 3. [A] No community on-device report yet [C].
4. **A notification is the only way a background service can reach the user.** [A]
   - It supports title, content, a vibration pattern (0–5), and action buttons that open a page or wake a service. [A]
   - In practice: max **3** buttons; only `actions[0]` shows in the card view; taps on a service action arrive in the **undocumented `onEvent`** hook. [B]
   - Alternatively, an alarm can launch a full-screen **page** at a set time. [A]
5. **Alarms (`@zos/alarm`, API 3.0)** survive reboot with `store: true` and can repeat every N minutes, hours, days, weeks, months or years, on chosen weekdays, or within a start–end window. [A]
   - Measured on a T-Rex 3: the first fire lands exactly 60 s after registration, and a service run takes **46–111 ms**. [B]
   - The per-app alarm limit is undocumented. [A]
6. **Your app cannot read phone notifications or other apps' notifications.** There is no such API on the watch or in the phone-side Side Service. [A] The notification center keeps the latest 20 alerts and is wiped on reboot, per the T-Rex 3 manual. [A]
7. **Shortcut Cards (`AppWidget`) work on the T-Rex 3.** They are reached with the DOWN button or a swipe up. [A: manual]
   - On a Zepp OS 6 T-Rex 3 the card measured `{ w: 400, h: 240, margin: 40, radius: 36 }`. [B]
   - **SecondaryWidget (horizontal widget pages) is unavailable** per the docs. Nothing suggests Zepp OS 6 changed that; Launcher 2.0 even removes horizontal widgets. [A/B]
8. **A foreground Mini Program page is exited about 10 s after the screen turns off** unless you keep the screen lit. [A] Long-running high-power sensing (GPS, accelerometer) is therefore foreground-only (or inside Workout Extensions) and costs battery.
9. **Watch faces are JavaScript too.** They can read sensors, respond to taps and have AOD layers, and can be built with no code in Watchface Maker.
   - They **cannot use the Side Service or BLE** [B: Zepp ambassador].
   - To show your own data, a companion Mini Program writes a file and the watch face reads it by `appId`. [A: `@zos/share-storage` (new in docs); B: `hmFS.open(..., {appid})`]
10. **Workout Extensions cannot talk to the phone on current firmware.** Side Service messaging reportedly fails inside them on a T-Rex 3 Pro (fw 6.3.13.5); this contradicts an official sample ([discussion #554](https://github.com/orgs/zepp-health/discussions/554), 2026-08-28) [B].

---

## 1. Everything you can ship, and where it appears on a T-Rex 3

### 1.1 Shippable artifact types

All of these live in one `.zab` package described by `app.json` (`DOCS/reference/app-json.mdx`). Everything except watch faces is a Mini Program (`appType: "app"`); a watch face is `appType: "watchface"`.

| Artifact | JS constructor | Where to configure | Min API_LEVEL | Updated T-Rex 3 | Where it appears | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| **Device App** (pages) | `App()` in `app.js`, `Page()` per page | `module.page.pages` (first page = entry) | 2.0 (this doc set targets 3.0+) | ✅ | App List (BACK button or swipe right-to-left); launched by alarms, notifications, cards, and possibly Shortcut Buttons | [A] `app-json.mdx`, `guides/framework/device/app.md` |
| **App Service** (background, no UI) | `AppService()` | `module.app-service.services: [...]`, several allowed | 3.0 | ✅ | Invisible; appears only as notifications, or in the "Background App Management" dialog when services conflict | [A] `guides/framework/device/app-service.md` |
| **System-event handler** (an App Service) | `AppService()` | `module.app-event.path` (exactly **one** service) plus one `event:*` permission per event | 3.0 | ✅ | Invisible | [A] `guides/framework/device/system-event.md` |
| **Shortcut Card** | `AppWidget()` | `module.app-widget.widgets[]` | 2.0 | ✅ (verified on Zepp OS 6 [B]) | Vertical card list (DOWN button or swipe up) | [A] `guides/framework/device/secondary-widget.md`; [B] water-reminders |
| **Secondary Widget** (full-screen horizontal page) | `SecondaryWidget()` | `module.secondary-widget.widgets[]`; preview image required when API_LEVEL > 3.0 | 2.0 | ❌ "SecondaryWidget support: NO" | n/a on T-Rex 3 | [A] `device-list.mdx`; [B] Launcher 2.0 drops horizontal widgets |
| **Workout Extension** | `DataWidget()` | `app.extType: "workout"`; `module.data-widget.widgets[]` with `runtime.ability: [{type: 1}]`; `minVersion` 3.6 | 3.6 | ✅ (the T-Rex 3 is named as a supported device) | Data pages inside the system **Workout** app, added per workout | [A] `guides/workout-extension/*`, `SAMPLES/workout-extensions/3.5/*/app.json` |
| **Custom keyboard** | `DataWidget()` | `module.data-widget.widgets[]` with `runtime.ability: [{type: 2, name: 'zh-CN'}]`; permission `device:os.input.method`; `minVersion` 4.2 | **4.2** | ✅ **needs Zepp OS 6 firmware** (4.4) | Settings → Preferences → Keyboard (only one custom keyboard active at a time); also listed in the App List | [A] `guides/keyboard/intro.mdx`, `SAMPLES/application/4.2/simple-keyboard/app.json` |
| **Watch face** | `WatchFace()` | `appType: "watchface"`; `module.watchface: { path, main, editable, lockscreen, photoscreen }` | any | ✅ | Watch-face picker (long-press the face); AOD | [A] `watchface/*`, `SAMPLES/watchface/3.0/timer` |
| **Side Service** (runs on the phone) | `AppSideService()` | `module.app-side.path` | 2.0 | ✅ (runs in the Zepp App) | Invisible; BLE bridge plus `fetch` | [A] `guides/architecture/arc.mdx` |
| **Settings App** (runs on the phone) | `AppSettingsPage()` | `module.setting.path` | 2.0 | ✅ | Zepp App → device → the app's settings | [A] `arc.mdx` |
| **Jump-only shortcut** | none | `module.shortcut: { scheme:'dapp', appLangType, appId, path, params }`; cannot coexist with `page` | "v2" | ? (legacy, undocumented behaviour) | An App List icon that opens another JS app or a native app | [A] `app-json.mdx` (stub only) |
| `watch-widget` ("watchface component module") | ? | `module.watch-widget.widgets` | "v2" | ? | Undocumented: a table stub only, no samples | [A] `app-json.mdx` |

**Rules that apply to cards and widgets:**

- A Mini Program may contain up to **5 Widgets plus Shortcut Cards in total** [A] (`secondary-widget.md`).
- A Workout Extension package may also contain an `app-side`; the official sample does ([A] `SAMPLES/workout-extensions/3.5/running-pace-master-with-side-service/app.json`). It is reported non-functional on current T-Rex-class firmware [B] (#554).

**Cross-app building blocks** (not artifacts themselves, but they widen what artifacts can do):

- **Share storage.** A publisher app uses `@zos/storage` `ShareLocalStorage` / `ShareTypedStorage`; a consumer reads through `@zos/share-storage` `LocalStorage(appId, path)`, `TypedStorage(appId, scope)` or `FileSystem(appId)`, all read-only. [A] (`DOCS/reference/device-app-api/newAPI/storage/Share*.mdx`, `share-storage/*.mdx`)
  - The docs label all of these "API_LEVEL 3.0", but they are **new in the docs**.
  - They are absent from `@zeppos/device-types` 4.0.0 (June 2026) and from the generated `static/llms*.txt`.
  - The `ShareTypedStorage` example literally uses scope `'watchface-data'`.
  - **[C] Probe on the device before relying on them.**
- **Other apps' metadata.** `@zos/app` `getPackageInfoById({appId})` (4.0) [A].
- **Launching.** `@zos/router` `launchApp({appId, url, params})` (2.0) opens another Mini Program; `launchApp({appId: SYSTEM_APP_*, native: true})` (3.0) opens a system app. `checkSystemApp()` (3.0) checks support; `getAppIdByName()` (3.6) looks up an id [A] (`router/*.mdx`).

### 1.2 The T-Rex 3's UI surfaces, and which ones third parties can use

The map comes from the T-Rex 3 manual (text extracted to `COMM/trex3-manual.txt` from [the user manual](https://support.amazfit.com/en/amazfit_t-rex_3/files/user-manual.pdf.pdf)) and the 4-button design spec (`DOCS/designs/interaction/physical-buttons.md`) [A]. The manual predates Zepp OS 6. Because the T-Rex 3 did **not** get Launcher 2.0, I assume this navigation still holds [C]; the button assignments come from the design spec.

| From the watch face | Opens | Third-party content? |
| --- | --- | --- |
| **UP** button / swipe down | Control Center (flashlight, DND, sleep mode, AOD, … editable, but system tiles only) | ❌ [A: manual lists only system tiles] |
| **DOWN** button / swipe up | **Shortcut Cards** (vertical list) | ✅ your `AppWidget` cards; users add them on the watch or in Zepp App → Shortcut Cards [A] |
| swipe left-to-right | Notification Center (latest 20; cleared on reboot) | ✅ your `notify()` notifications appear here [A] |
| **BACK** button / swipe right-to-left | App List | ✅ your Mini Programs [A] |
| **SELECT** | Workout list (the default is changeable) | ✅ Workout Extensions, inside a workout [A] |
| Long-press the face | Watch-face picker, and editing of "compilations" (editable components) | ✅ your watch faces [A] |
| Settings → Preferences → **Shortcut Buttons** (long-press SEL, press SEL, long-press UP, long-press DOWN) | A user-chosen app | ⚠️ Whether installed third-party Mini Programs can be chosen is **unverified** [C] |
| Status dots on the face | Low battery, DND, sleep, theater, stopwatch, countdown, music, workout, charging | ❌ system-only [A: manual] |
| Morning Updates | Daily summary | ❌ system-only [A: manual] |

Two consequences:

- **There is no third-party complication API that injects into other people's watch faces** [C, based on the absence of any API].
- **Shortcut Cards are the only glance surface you can use besides your own watch face.**

---

## 2. App Service deep dive (API_LEVEL 3.0, some parts 4.0)

Sources: `DOCS/guides/framework/device/app-service.md` (English and `ZH/` versions are identical in substance) [A]; the API reference in `DOCS/reference/device-app-api/newAPI/app-service/*.mdx` and `global/AppService.mdx` [A]; samples `SAMPLES/application/3.0/3.0-feature` and `…/3.0/notification` [A].

### 2.1 Two modes

| | Single execution ("short service") | Continuous running ("long service") |
| --- | --- | --- |
| **Started by** | `@zos/alarm` firing; tapping a `@zos/notification` action button; a system event (or a custom event via `emitCustomSystemEvent`) | `start()` from `@zos/app-service`, called from a **Device App page** |
| **Lifetime** | "exiting … as soon as the execution of the relevant code is completed" [A] | Keeps running after you leave the app UI, **and after a device reboot** [A]; stops only on `exit()`, `stop()`, or "when system-related restrictions are triggered" [A] |
| **Time limit** | **600 ms** per execution [A]. Measured on a T-Rex 3 at 46–111 ms for a typical read-and-notify [B] | None documented |
| **Permission** | "There is no permission limit for waking up a single execution" [A]; you still need the permission for each API used (`device:os.alarm`, `device:os.notification`, `event:*`). A community reminders app on a Balance 2 ships with **no** `bg_service` permission [B] (see [Custom-Reminders app.json](https://github.com/Tyomich4736/Custom-Reminders-Zepp-OS-App)) | `device:os.bg_service` in `app.json` **plus** a runtime request via `queryPermission` / `requestPermission` [A]. The watch shows a dialog, "Enable Background Running Alerts — To allow the application to run in the background…", with ✕/✓ buttons [A: `static/img/docs/guides/version_info/enable_service.jpg`] |
| **Concurrency** | n/a | "Only one instance of the App Service can run at a time." On conflict, a "Background App Management" dialog says: "**Only 1 apps downloaded from the app store can run in the background**", with a toggle per app [A: `service_manage.jpg`]. `start()` error code `7` means "number of services has reached the system limit" [A] |
| **Official advice** | "consumes less system resources and is more recommended" [A] | Use sparingly [A] |

**Note on permissions:** `DOCS/guides/framework/device/permission.md` (a Zepp OS 2.0-era page) says "The production version of the firmware does not include the dynamic privileges section". That contradicts the App Service page, which requires `requestPermission`. The official 3.0 sample and `zml` both implement the query-and-request flow (`SAMPLES/application/3.0/3.0-feature/pages/bgService.js`, `ZML/src/core/device/permission/permission.js`) [A]. Test it on the device [C].

### 2.2 `app.json`

```json
{
  "configVersion": "v3",
  "permissions": [
    "device:os.bg_service",          // needed for start/stop/exit/getAllAppServices (continuous mode)
    "device:os.alarm",
    "device:os.notification",
    "event:os.health.wear_status"    // one entry per system event you listen to
  ],
  "targets": {
    "default": {
      "module": {
        "page":        { "pages": ["page/index"] },
        "app-service": { "services": ["app-service/tick", "app-service/logger"] },
        "app-event":   { "path": "app-service/tick" }        // must be one of the services above
      },
      "platforms": [{ "st": "r", "dw": 480 }]
    }
  }
}
```

[A] `app-service.md`, `system-event.md`. [B] One docs page shows `app-service` as `{ "path": "…" }`; the guide shows `{ "services": [...] }`. **The `services` array is the form confirmed working on a T-Rex 3** (water-reminders pitfall P-02).

### 2.3 Lifecycle and the service API

```js
// app-service/logger.js — each service file calls AppService() exactly once [A]
import { exit } from '@zos/app-service'
AppService({
  state: {},                 // [A] per-instance state object
  onInit(params) {},         // [A] start()/alarm/event: params is a URI-query-style string
  onEvent(params) {},        // [A: official samples only] [B] notification-action launches land here, NOT in onInit
  onDestroy() {},            // [A]
})
```

**Facts about the hooks:**

- `onEvent` is **not** in the `AppService` reference table. The official samples use it (`SAMPLES/application/3.0/3.0-feature/app-service/time_service.js`; the AutoGUI watch-face example) [A].
- A T-Rex 3 developer reports: "alarm wake-ups go through `onInit(params)`, notification-action launches go through `onEvent(e)`; implementing only `onInit` fails silently" [B] (water-reminders P-15).
- **Page ↔ service entry points:** alarm → `onInit`; notification action → `onEvent`; `start()` → `onInit` with `param`. `zml` calls `start()` again on an already-running service to push new parameters (`_a=running`, see `ZML/src/core/device/app-service/BgService.js`). My guess is that this arrives via `onEvent` [C].
- `app.js` `App({...onCreate})` also runs in the service's process. The alarm docs say `param` is "passed to the app.js lifecycle onCreate" [A], and the zml pattern needs `getApp()` inside services [A: `ZML/src/core/device/base-page.js`] [C].
- **Never `export` anything from a service, page or `app.js` entry file.** On a T-Rex 3 this causes a black screen with no logs [B] (P-25).
- **Wrap lifecycle hooks in `try/catch`.** Errors thrown there are not caught by the framework [B] (P-13).

**Controlling a service from a page** (`@zos/app-service`, API 3.0, permission `device:os.bg_service`) [A]:

| Function | Signature (per docs) | Notes |
| --- | --- | --- |
| `start` | `start({ file, param?, complete_func, reload? })` → number (0 = OK) | `reload` (**4.0**, default `true`): "persist and automatically restart following system running state changes … system restart, power saving mode entry/exit, system language changes, Mini Program updates". Error codes: 1 param, 2 state, 3 no permission, 4 out of memory, 5 not supported, 6 prohibited, 7 service limit reached, 255 unknown |
| `stop` | `stop({ file, complete_func })` | Asynchronous; the result arrives in the callback |
| `getAllAppServices` | `() → string[]` | Running services **of this app** |
| `exit` | `exit()` | Call from inside the service; does not affect the foreground page |

⚠️ **`file` vs `url`.**

- The docs and both `@zeppos/device-types` 3.0.0 and 4.0.0 (`TYPES4/`) name the property **`file`**.
- The official sample (`pages/bgService.js`) and the official `zml` library (`BgService.js`) pass **`url`**.
- [C] Pass both keys with the same value until you have tested on the device.

### 2.4 What an App Service may call (official table) plus annotations

| Module / API | Allowed? [A] | Notes |
| --- | --- | --- |
| `setTimeout` / `setInterval` (global timers) | **NO** | Use `@zos/timer` `createSysTimer` (**4.0**, "can be registered in device app services and runs regardless of watch screen state") [A], `Time.onPerMinute` / `onPerDay` (2.1) / `onPerHourEnd` (3.6) [A], or alarms |
| `@zos/ui` (all) | **NO** | No UI whatsoever. "The only way to interact with the user's view is the `@zos/notification` System Notification API" [A] |
| `@zos/sensor` Accelerometer, Geolocation, Gyroscope | **NO** | Confirmed in practice: a fall-detection project removed its background probe on 2026-09-24 because the accelerometer is unavailable in services [B] ([katatsu12/fall-detection](https://github.com/katatsu12/fall-detection)) |
| `@zos/sensor` other sensors (HeartRate, Step, Calorie, Battery, Wear, Sleep, Stress, BloodOxygen, Time, Weather…) | **YES** | Compass and Barometer are not named as high-power, so by the table's own rule they are allowed [C]. `Vibrator` sits in `@zos/sensor` and is presumably allowed [C]; the documented way to vibrate from a service is `notify({vibrate})` |
| `@zos/app-service` (all) | YES | |
| `@zos/notification` (all) | YES | |
| `@zos/app`, `@zos/settings`, `@zos/display`, `@zos/device`, `@zos/user` | YES, `get*` methods only | e.g. `getProfile()`, `getSystemInfo()` |
| `@zos/media` audio playback | YES | T-Rex 3 audio hardware: see agent B/A. The registry marks `voice: true` [A] |
| `@zos/ble` | YES except `mst*` | Messaging to your Side Service is allowed; **BLE central (talking to external devices) is not** |
| `@zos/fs` | YES, but "**File writing related APIs can only be used when the screen is off or in AOD display mode**" | Reads are unrestricted [A]. A T-Rex 3 developer saw a notification action routed to a service do nothing, with no error, because the screen is lit when the user taps [B] (P-15) |
| Not listed: `@zos/storage`, `@zos/alarm`, `@zos/router`, `@zos/interaction`, `@zos/i18n` | undefined | The official 3.0 notification sample calls `getText` inside a service (`SAMPLES/application/3.0/notification/app-service/index.js`) [A], so i18n probably works [C]. Whether a service can call `alarm.set()` is **unverified** [B]. An old staging draft ([docs-testing "next" background-service](https://docs-testing.zepp.com/docs/next/guides/framework/device/background-service/)) claims `showToast`, `@zos/router`, `@zos/alarm` and the full `@zos/sensor` work in services; it contradicts the published docs, so treat it as obsolete [B] |

### 2.5 When a service actually runs, and when it dies

- **Continuous services survive exiting the app UI and a device reboot** [A]. With `reload: true` (the 4.0 default) they also auto-restart after power-saving mode toggles, language changes, or app updates [A].
- **An alarm-woken single-execution service does *not* run while your app's page is in the foreground; it resumes right after the screen turns off** (T-Rex 3, Zepp OS 6) [B] (P-18).
  - Design your page to do the service's job while it is open.
  - Make the page settle its state in `onDestroy`.
- **Sleep mode can stop background work.** The SleepAgent project on a GTR 4 warns: "NEVER enter sleep mode for your watch… the app will stop working when the watch is in sleep mode" [B] ([Anduin2017/SleepAgent](https://github.com/Anduin2017/SleepAgent/blob/master/README.md)).
- **DND, Sleep and Theater modes** suppress phone notifications on the watch [A: Amazfit support]. Their effect on local `notify()` calls is undocumented [C: test].
- **Battery Saver mode** disables health monitoring (HR, SpO2, stress) [A: [Amazfit support](https://support.amazfit.com/en/amazfit_t-rex_3/docs/PLixdvlm4oZv2CxTTLAcs4eAnig)]. Its effect on Mini Programs is undocumented. With `reload: true` a service should restart on entering or exiting power saving [A]; whether it is *allowed to run* during Battery Saver is unknown [C].
- **Battery cost has not been measured** by anyone I found. The official line is only that single-execution mode "consumes less system resources". One T-Rex 3 project wakes every 10 minutes (144 times a day) and still lists power as an open question [B] (OQ-20).

### 2.6 Phone connectivity from a service

- **What the docs allow:** `@zos/ble` non-`mst` APIs [A].
- **What works in practice:** in a continuous service, **wrap the service with zml**: `AppService(BasePage({...}))`, with `App(BaseApp({...}))` in `app.js` and zml ≥ 0.0.23. Then `this.request()` / `this.httpRequest()` go through the Side Service. One community member ran this reliably for 2+ months on a Balance (ZOS 3.0) [B] ([discussion #270](https://github.com/orgs/zepp-health/discussions/270); [#351](https://github.com/orgs/zepp-health/discussions/351)).
  - A Bip 5 Unity user reported requests that never completed [B] (#351).
  - A Zepp ambassador said in Nov 2023 that device timers "require UI"; `createSysTimer` in 4.0 is presumably the fix [B/C].
- **A single-execution service's 600 ms budget is too short for a BLE plus HTTP round trip** [C]. Periodic sync therefore means a continuous service (with the one-background-app limit) or deferring the sync until the user opens the app.
- **The Zepp App must be alive on the phone.** Android needs battery-optimisation allow-listing [A: manual].

### 2.7 Storage pitfalls in background designs (community, T-Rex 3)

- `@zos/storage` `LocalStorage` (API 3.0, `device:os.local_storage`) loads the whole file and writes it back non-atomically.
  - One developer measured **transient empty reads**: 27% on a page, 67% while BLE messages were arriving.
  - Read-modify-write therefore silently destroys data [B] (P-17).
  - Page and service share the default `LocalStorage` file [B].
- **Recommended pattern** [B]:
  - Use `@zos/fs` double-slot files or append-only logs.
  - Allow **one writer** (the page).
  - Keep the service read-only.
  - The official 3.0 calories sample itself moved persistence to `@zos/fs` [B cites it].

### 2.8 System events (wake-up source #2)

Source: `DOCS/guides/framework/device/system-event.md` [A]. All are API_LEVEL 3.0. Each event name must also be declared in `permissions`.

| Event | Meaning | Extra params |
| --- | --- | --- |
| `event:os.health.sleep_status` | Sleep state changed | – |
| `event:os.health.heart_rate_abnl` | Abnormal heart rate | – |
| `event:os.helath.stress_remind` | Stress-relief reminder (the "helath" typo is in the docs; use the string as written, [B]) | – |
| `event:os.health.wear_status` | Wear state changed | – |
| `event:os.system.sleep_mode` | Sleep mode on/off | `status=enter\|exit` |
| `event:os.weather.sun_rise` / `sun_set` / `moon_rise` / `moon_set` | Astronomy | – |

- **Undocumented events.** Official samples also *declare* `event:os.bp.high/low/expires`, `event:os.system.power_saving`, `event:os.system.theater_mode` and `event:os.system.no_disturb` (`SAMPLES/application/3.0/3.0-feature/app.json`, `4.0/4.0-feature/app.json`) [A]. The staging draft lists `event:os.health.spo2_low` [B]. None of these are documented; probe them [C].
- **Delivery.** The event wakes the `app-event.path` service, whose `onInit(options)` receives a query string such as `event=event:os.system.sleep_mode&status=enter`. The docs' own examples differ on whether the `event=` prefix is present, so parse both forms [A/B].
- **Custom events.** `emitCustomSystemEvent({ eventName: 'event:customize.<x>', eventParam })` (`@zos/app`, 3.0) lets a page wake that service on demand [A]. The sample also declares `event:customize.test` in `permissions` [A].

### 2.9 Code patterns

**Pattern 1: "heartbeat" (single execution, the most robust). Verified on a T-Rex 3 with Zepp OS 6 [B].**

```js
// page: register once; self-heal on every open. getAllAlarms() returns ONLY this app's alarm ids
// (no config), so the list itself is the source of truth (orphans otherwise accumulate) [B]
import { set, cancel, getAllAlarms, REPEAT_MINUTE } from '@zos/alarm'
const GRID_MIN = 10
const ids = getAllAlarms() || []
if (ids.length !== 1) {
  ids.forEach((id) => { try { cancel(id) } catch (e) {} })
  set({
    url: 'app-service/tick',      // may also be a page path, e.g. 'page/index' [A]
    delay: GRID_MIN * 60,         // seconds; `time` (UTC seconds) takes priority [A]
    repeat_type: REPEAT_MINUTE,
    repeat_period: GRID_MIN,      // = period in minutes (measured) [B]
    param: 'src=hb',              // arrives in service onInit(params) [B]
    store: true,                  // survives reboot (verified) [A/B]
  })
}
```

```js
// app-service/tick.js — must finish within 600 ms; read-only; exits
import { notify } from '@zos/notification'
import { exit } from '@zos/app-service'
import { readFileSync } from '@zos/fs'
AppService({
  onInit(params) {
    try {
      const snap = JSON.parse(readFileSync({ path: 'snap.json', options: { encoding: 'utf8' } }) || 'null')
      if (snap && shouldRemind(snap, Date.now())) {
        notify({
          title: 'Time to drink', content: `${snap.drunk}/${snap.goal} ml`, vibrate: 2,
          actions: [                                   // max 3; card view shows only [0] [B]
            { text: 'Drank 250', file: 'page/index', param: 'drink=250' }, // → page onInit(param)
            { text: 'Later',     file: 'page/index', param: 'snooze=15' },
          ],
        })
      }
    } catch (e) { /* log */ }
    exit()
  },
})
```

**Pattern 2: a fixed weekly schedule** (Balance 2, Zepp OS 4–5 [B], [Custom-Reminders](https://github.com/Tyomich4736/Custom-Reminders-Zepp-OS-App/blob/HEAD/utils/alarm.js)):

```js
import { set, REPEAT_WEEK, WEEK_MON, WEEK_WED } from '@zos/alarm'
set({ url: 'app-service/reminder', time: nextUtcSeconds, store: true,
      repeat_type: REPEAT_WEEK, week_days: WEEK_MON | WEEK_WED, param: 'id=42' })
// `time` is absolute UTC seconds: convert from local wall-clock yourself (Time sensor getHours/getDay are local)
```

**Pattern 3: a continuous logger** (API 4.0; the combination is my inference [C], each API is [A]):

```js
// page
import { queryPermission, requestPermission } from '@zos/app'
import { start } from '@zos/app-service'
const P = ['device:os.bg_service']
function go() {
  const S = 'app-service/logger'
  const r = start({ file: S, url: S, param: 'mode=log', reload: true,
                    complete_func: ({ result }) => { /* true = started */ } })
  // r === 7 → another store app already owns the single background slot
}
const [st] = queryPermission({ permissions: P })       // 0 no, 1 unknown, 2 granted
if (st === 2) go(); else requestPermission({ permissions: P, callback: ([res]) => res === 2 && go() })
```

```js
// app-service/logger.js
import { createSysTimer, stopTimer } from '@zos/timer'   // 4.0
import { HeartRate, Time } from '@zos/sensor'
import { exit } from '@zos/app-service'
const hr = new HeartRate(); const time = new Time(); let buf = []; let t = 0
AppService({
  onInit() {
    t = createSysTimer(true, 5 * 60 * 1000, () => { buf.push([Date.now(), hr.getLast()]) })
    time.onPerMinute(() => { /* flush buf to fs; writes only succeed with screen off/AOD [A] */ })
  },
  onEvent(p) { if (p && p.indexOf('action=exit') >= 0) { stopTimer(t); exit() } },
  onDestroy() { stopTimer(t) },
})
```

**Pattern 4: a system-event reactor**

```js
// app-service/tick.js (also app-event.path)
AppService({ onInit(opt) {
  const q = parse(opt)                      // parse 'event=...&status=...' AND bare 'event:os...' forms
  const ev = q.event || opt
  if (ev === 'event:os.health.wear_status') { /* read Wear sensor now; don't write while screen on */ }
}})
```

---

## 3. Alarms (`@zos/alarm`, API 3.0, permission `device:os.alarm`)

Source: `DOCS/reference/device-app-api/newAPI/alarm/{set,cancel,getAllAlarms}.mdx` (EN and ZH) and `TYPES4/` [A].

### 3.1 `set(option) → id` (0 means failure; ids stay the same across reboot for stored alarms)

| Field | Meaning |
| --- | --- |
| `appid` | Target Mini Program; defaults to your own app (so you can also schedule another app) |
| `url` (**required**) | Page **or** App Service file to wake |
| `time` | UTC timestamp in **seconds**; takes priority over `delay` |
| `delay` | Seconds from now (one of `time` / `delay` is required) |
| `param` | String passed to `app.js` `onCreate`; for services it reaches `onInit(params)` [B] |
| `store` | Default `false`; `true` keeps the alarm through reboot |
| `repeat_type` | `REPEAT_ONCE`, `REPEAT_MINUTE`, `REPEAT_HOUR`, `REPEAT_DAY`, `REPEAT_WEEK`, `REPEAT_MONTH`, `REPEAT_YEAR` |
| `repeat_period`, `repeat_duration` | For MINUTE/HOUR/DAY: "N units per period, fire M times". The docs' example: every 21 days = `REPEAT_DAY`, `repeat_period: 20`, `repeat_duration: 1`. Measured on a T-Rex 3: with `REPEAT_MINUTE`, `repeat_period` equals the period in minutes [B] |
| `week_days` | Bitmask of `WEEK_MON` … `WEEK_SUN` (for `REPEAT_WEEK`) |
| `start_time`, `end_time` | UTC seconds; repeats only fire inside this **single** window (no gaps, no per-weekday windows [B]) |

`cancel(id | {id})` also removes persistence. `getAllAlarms()` returns the ids for this app only [A]. The old 3.0.0 type package names these `file:` and `getAlarmList()`; the docs and types 4.0.0 name them `url:` and `getAllAlarms()`. **Use `url`** [A]. (The official `3.0/notification` sample uses `date:` and `alarmMgr.ONCE`, which look like bugs [A/C].)

### 3.2 What an alarm can launch

- **An App Service (single execution).** Invisible: it notifies, or does nothing [A].
- **A page.** This launches your Mini Program full-screen at that time ("Support for persistent timers to wake up pages of Mini Program") [A].
  - Trade-off noted by a T-Rex 3 developer: the page is a forced full-screen interruption, and if the user swipes it away it is gone; it does not stay in the notification center [B] (water-reminders ADR-0005 / notification notes).
  - A page can vibrate continuously (`VIBRATOR_SCENE_TIMER` / `VIBRATOR_SCENE_CALL` need a manual `stop()`) and use the buzzer (`Buzzer`, 3.6) [A].
- **An older mechanism: `@zos/router` `setLaunchAppTimeout({appId, url, utc(ms) | delay(ms, 3.0), params})`** (API 2.0). It launches a page at a time; `clearLaunchAppTimeout(id)` cancels it [A]. Zepp's ambassador recommended it for alarm apps before 3.0 [B] ([#313](https://github.com/orgs/zepp-health/discussions/313)). Reboot persistence is not documented [C].

### 3.3 Precision, limits and gotchas

- **Precision.** Undocumented [A]. Measured: the first fire lands exactly 60 s after `delay: 60` [B]. Long-run jitter, time-zone changes, DST and manual clock changes are all untested [B]. Granularity is 1 minute for `REPEAT_MINUTE` [C].
- **Maximum count per app.** Undocumented [A]. (The system Alarm app caps the *user's* alarms at 10 [A: [support page](https://support.amazfit.com/en/amazfit_t-rex_3/docs/WMK7dYbphoN2ucxzUT8cedsQnJf)]; that limit is unrelated.)
- **Orphan alarms.** If you store the alarm id and lose it, you create duplicates: one developer reached three alarms (two orphans) within 5–10 minutes. `store: true` alarms may also survive an uninstall/reinstall. Use `getAllAlarms()` as the source of truth [B].
- **Heartbeat granularity.** Reminder times snap to your heartbeat grid; a 10-minute grid means up to 10 minutes of delay [B].

---

## 4. Notifications (`@zos/notification`, API 3.0, permission `device:os.notification`)

Sources: `DOCS/guides/framework/device/system-notification.md`, `DOCS/reference/device-app-api/newAPI/notification/*.mdx`, and `SAMPLES/application/3.0/{notification,3.0-feature}` [A].

### 4.1 Posting local notifications: yes

```js
import { notify, cancel, getAllNotifications } from '@zos/notification'
const id = notify({                 // returns 0 on failure, else the notification id
  title: 'Title', content: 'Body',
  vibrate: 0,                       // 0 default, 1 beep, 2 birdsong, 3 drumbeat, 4 gentle, 5 buzz/urgent; "only effective for linear motors" [A]
  actions: [                        // required; [] = no buttons (used by the official sample and community apps) [A/B]
    { text: 'Open', file: 'page/index', param: 'from=notif' },         // opens a page (guide: "open the Mini Program page") [A]
    { text: 'Stop', file: 'app-service/svc', param: 'action=exit' },   // wakes a service → onEvent(param) [A sample][B]
  ],
})
getAllNotifications()                // ids from THIS app still in the notification center
cancel(id) / cancel([id1, id2])
```

- **Posting context.** Both pages and services can post [A].
- **Rendering is fixed.** Only title, content, vibrate and action texts/targets can be customised [B]. The docs screenshot shows the app icon, title, "now", the content, and pill-shaped buttons [A: `notification_demo.jpg`].
- **Button limits (T-Rex 3):** at most **3 actions**; the compact card shows only `actions[0]`, while the full view shows all three [B] (OQ-21, P-14).
- **Actions that need to persist data should target a page, not a service.** The screen is lit when the user taps, so a service cannot write files [A rule][B experience].
- **Retention.** The center keeps the latest 20 alerts; they are cleared automatically on reboot [A: T-Rex 3 manual]. Auto-dismiss, stacking and rate limits are all untested [B].
- `vibrate: 6` appears in one official sample but is undocumented [A].

### 4.2 Reading notifications: not possible

- The watch API has only `notify`, `cancel`, and `getAllNotifications`, and those cover **your own** notifications [A].
- The Side Service (phone) APIs are `messaging`, `fetch`, `settingsStorage`, `download-file`, `image-convert` and `transfer-file`. None reads phone notifications [A] (`DOCS/reference/side-service-api/`).
- **So there is no way to read, intercept, or reply to phone notifications or other apps' notifications** [A]. The system itself can reply to some messages via the system keyboard (region- and device-dependent) [A: `guides/keyboard/intro.mdx`], but third-party apps cannot hook into that flow [C].

---

## 5. Watch faces

Sources: `DOCS/watchface/*` (the hmUI/hmSensor/hmFS/hmSetting/timer API), `DOCS/guides/tools/watchface/*` (Watchface Maker), `DOCS/distribute/watchface.md`, `SAMPLES/watchface/{1.0,3.0}` [A].

### 5.1 Two ways to build one

| Path | What it is | Can do | Can't do |
| --- | --- | --- | --- |
| **Watchface Maker** ([watchface.zepp.com](https://watchface.zepp.com)) | Visual no-code web tool; export a ZAB; install by QR code; submit via Zepp Console | Backgrounds, digital and pointer time, date/week, data fields (steps, HR, calories, weather, battery…), image progress, **editable components**, AOD, tap "jump hot zones" | Custom logic, or reading your app's data |

Watchface Maker notes [A] (`release-note.md`):

- It is still maintained: v4.9.0 (June 2026) added 11 data fields (HybridCharge, lactate threshold, sleep, altitude, recovery time, HRV, floors, moonrise/moonset, monthly runs).
- v4.9.1 (2026-07-15) added HRV, HybridCharge, Altitude and Sleep Duration to editable components.

| Path | What it is | Can do | Can't do |
| --- | --- | --- | --- |
| **JS project** (`zeus create`, `appType: "watchface"`) | `WatchFace({ onInit, build, onDestroy })`; mostly the `hm*` API. The 3.0 sample also imports `@zos/ui`, `@zos/app`, `@zos/utils` | Everything in 5.2–5.6 | No Side Service or BLE (5.5); no phone-side settings page (use on-watch edit groups) [B: novvember] |

`app.json` watchface module (from the 3.0 sample) [A]:

```json
"module": { "watchface": { "path": "watchface/round/index", "main": 1, "editable": 1, "lockscreen": 1 } }
```

Other flags: `photoscreen` (photo watch face).

### 5.2 Widgets and data

- **Widgets** [A] (`DOCS/watchface/api/hmUI/widget/`): IMG, TEXT, TEXT_IMG, ARC, ARC_PROGRESS, CIRCLE, FILL_RECT, STROKE_RECT, IMG_PROGRESS, IMG_LEVEL, IMG_POINTER, IMG_ANIM, IMG_STATUS, IMG_TIME, IMG_DATE, IMG_WEEK, TIME_POINTER, DATE_POINTER, BUTTON, IMG_CLICK, `GRADKIENT_POLYLINE` (the docs' spelling), `WIDGET_DELEGATE`, and the edit widgets (`WATCHFACE_EDIT_GROUP` / `_MASK` / `_FG_MASK` / `_BG` / `_POINTER`).
- **`hmUI.data_type` bindings.** The firmware updates these automatically, so no JS is needed [A] (`data_type.mdx`):
  - Activity: BATTERY, STEP(+_TARGET), CAL(+_TARGET), HEART, PAI_DAILY/WEEKLY, DISTANCE, STAND(+_TARGET), FAT_BURNING(+_TARGET), STRESS, SPO2, FLOOR.
  - Weather and astronomy: WEATHER_CURRENT/LOW/HIGH, UVI, AQI (China only), HUMIDITY, SUN_CURRENT/RISE/SET, WIND, MOON.
  - Environment: ALTIMETER (pressure), ALTITUDE.
  - Timers and alarms: ALARM_CLOCK, COUNT_DOWN, STOP_WATCH.
  - Health and training: SLEEP, TRAINING_LOAD, VO2MAX, RECOVERY_TIME, MONTH_RUN_TIMES/DISTANCE, READINESS.
  - `IMG_CLICK`-only launch targets: OUTDOOR_RUNNING, WALKING, OUTDOOR_CYCLING, FREE_TRAINING, POOL_SWIMMING, OPEN_WATER_SWIMMING, PHN, BREATH_TRAIN.
- **Sensors from JS** [A] (`hmSensor.createSensor(hmSensor.id.X)`): TIME, BATTERY, HEART (last/current/today + events), STEP, CALORIE, DISTANCE, PAI, SPO2, STRESS, SLEEP, STAND, WEATHER, WEAR, VIBRATE, MUSIC, WORLD_CLOCK, BODY_TEMP, FAT_BURRING (sic).
  - High-power sensors (GPS, accelerometer) are not part of the watch-face API [A: absence] [C].
- **Storage** [A]: `hmFS` (own files, plus `SysProSet*/Get*` system properties that are cleared on reboot); `hmSetting` (screen type, brightness, user data, and so on); `timer.createTimer(delay, repeat, cb)`.

### 5.3 Editable components ("compilations")

- `WATCHFACE_EDIT_GROUP` lets the user pick a data type per slot. Read the choice with `getProperty(hmUI.prop.CURRENT_TYPE)` [A].
- Custom edit types use ids `0x186a0` and up, with localized titles [A].
- The same mechanism provides editable backgrounds and editable pointers [A].
- In Watchface Maker, the "Editable Component" tutorial came out in July 2026 [A].

### 5.4 AOD (Always-On Display)

- The T-Rex 3 AOD can follow the watch face's own AOD style (Settings → Display → Always On Display) [A: manual].
- In code, give each widget a `show_level`: `hmUI.show_level.ONLY_NORMAL | ONAL_AOD` (keep the API's spelling) or `ONLY_EDIT`. Detect AOD with `hmSetting.getScreenType() === hmSetting.screen_type.AOD`, or `@zos/app` `getScene() === SCENE_AOD` [A].
- Design rules [A] (`watchface/specification.md`): at most **10% of pixels lit**, a black background, white hands, **no second hand**, and minimal movement between the normal and AOD layouts.
- The AOD refresh cadence and whether JS timers run during AOD are not documented [A: absence]. Community practice: refresh on `WIDGET_DELEGATE` `resume_call`, and use a separate timer path for AOD [B].

### 5.5 Interactivity, lifecycle, and your own data

- **Taps.** `widget.addEventListener(hmUI.event.CLICK_UP, fn)`, `BUTTON` `click_func`, and `IMG_CLICK` with `type: hmUI.data_type.X` (jumps to that system function) [A].
- **Launching apps.** Community watch faces call `hmApp.startApp({ appid: 1, url: 'SportListScreen', native: true })` to open native screens [B]. `@zos/router` `launchApp({appId, url})` should open *your* Mini Program [C: no doc says this works from a watch face; `getScene()` includes `SCENE_WATCHFACE`, so `@zos/app` runs there].
- **Lifecycle.** `WIDGET_DELEGATE` `resume_call` fires when the face (re)appears; `pause_call` fires when the user swipes to cards, notifications or the app list, or opens an app [A]. [C] JS work only runs while the face is visible (normal or AOD).
- **Showing your app's or phone data on your watch face:**
  - "The watch faces don't support Side Service" (Zepp ambassador silver-zepp) [B] ([discussion #330](https://github.com/orgs/zepp-health/discussions/330)).
  - Approved pattern: a **companion Mini Program** fetches or computes the data and writes a file; the watch face polls and reads it by appId [B] ([silver-zepp example](https://github.com/silver-zepp/zeppos-autogui/tree/main/other-autogui-examples/zeppos-3.0-wf-app-comms), copy in `COMM/wfcomms/`):
    ```js
    // watch face (legacy API). Reads the companion app's /data file read-only
    const fh = hmFS.open('glucose.txt', hmFS.O_RDONLY, { appid: 77777 })   // 3rd arg undocumented [B]
    const buf = new ArrayBuffer(1024); hmFS.read(fh, buf, 0, 1024); hmFS.close(fh)
    timer.createTimer(1000, 30 * 1000, () => { /* re-read every 30 s while visible */ })
    ```
  - The documented successor [A, new in docs]: `import { FileSystem, LocalStorage, TypedStorage } from '@zos/share-storage'`, then `new FileSystem(appId).readFileSync({ path, options: { encoding: 'utf8' } })`. The app publishes with `ShareTypedStorage('watchface-data')` / `ShareLocalStorage(path)`.
  - Freshness is bounded by how often the app or its service writes, and a service can only write while the screen is off or in AOD [A]. Expect minutes of lag, not seconds [C].
- **What a watch face cannot do** [C unless marked]: post notifications, set alarms, run in the background, use BLE or the Side Service [B], or appear inside Control Center.
- **Size limits.** Package size is undocumented; Watchface Maker reports "Watchface is too big" when there are too many progress images [A].

### 5.6 Distribution

Watchface Maker projects appear in Zepp Console → Application Services → Watchface. Upload the ZAB, pick countries, category and language, then submit. Review takes **1–5 working days** [A] (`distribute/watchface.md`).

---

## 6. "What runs when" matrix

Legend: ✅ yes · ❌ no · ⚠️ restricted · ? undocumented. Tags as in §0.

| Capability | **Foreground page** | **App Service: single execution** | **App Service: continuous** | **Shortcut Card** (`AppWidget`) | **Workout Extension** (`DataWidget`) | **Watch face** |
| --- | --- | --- | --- | --- | --- | --- |
| Draw UI | ✅ [A] | ❌ [A] | ❌ [A] | ✅ inside the card only; no scrolling/stacking widgets; no GROUP [A] | ✅ one page, screen-sized, no scrolling [A] | ✅ watch-face widget set; AOD layer [A] |
| Input | touch, keys (`onKey`) [A] | none (can be targeted by notification buttons) [A] | none [A] | **click only**; no swipes, gestures or keys [A][B] | **click only**; no gestures or buttons [A] | taps, edit mode [A] |
| Low-power sensors (HR, steps, calories, battery, wear, sleep, stress, time) | ✅ [A] | ✅ [A] | ✅ [A] | ✅ (official sample reads Calorie) [A] | ✅ plus workout data (`getSportData`, `SPORT_DATA`, 3.6) [A] | ✅ `hmSensor` + `data_type` [A] |
| High-power sensors (GPS, accelerometer, gyroscope) | ✅ with permission [A] | ❌ [A][B] | ❌ [A] | ? [C: avoid] | workout GPS data via the system [A] (see agent B) | ❌ [C] |
| Vibration | ✅ `Vibrator` [A] | ✅ via `notify({vibrate})` [A]; `Vibrator` probably [C] | same as single execution [A/C] | ? | ? | `hmSensor.id.VIBRATE` exists [A] |
| BLE ↔ Side Service (phone) | ✅ (zml / MessageBuilder) [A] | ⚠️ API allowed [A]; 600 ms makes it impractical [C] | ✅ [A]; `AppService(BasePage)` + zml ≥ 0.0.23 [B] | ❌ "cannot display real-time data through Bluetooth"; set up BLE in the Page [A] | ❌ **reported broken** on T-Rex 3 Pro fw 6.3.13.5 (`this.request` "not a function") [B #554], despite the official sample [A] | ❌ [B] |
| BLE central (external devices, `mst*`) | ✅ [A] | ❌ [A] | ❌ [A] | ? [C: no] | ? (agent C) | ❌ [C] |
| File read / write | ✅ / ✅ [A] | ✅ / ⚠️ screen off or AOD only [A] | ✅ / ⚠️ screen off or AOD only [A] | ✅ read (write not documented) [A] | ✅ [C] | ✅ own `hmFS`; read another app's files [A/B] |
| `setTimeout` / `setInterval` | ✅ (2.0; confirmed on T-Rex 3 [B]) | ❌ [A] | ❌ → `createSysTimer` (4.0) [A] | ⚠️ suspended in Pause state [A] | ⚠️ paused in Pause state [A] | `timer.createTimer` while visible [A] |
| `Time.onPerMinute` / `onPerDay` / `onPerHourEnd` | ✅ [A] | n/a (exits) | ✅ (official example) [A] | ⚠️ [A: Pause] | ⚠️ | `hmSensor` TIME [A] |
| Set alarms | ✅ [A] | ? unverified [B] | ? | ? | ? | ❌ [C] |
| Post notifications | ✅ [A] | ✅ [A] | ✅ [A] | ? [C] | ? [C] | ❌ [C] |
| Launch pages / apps | ✅ `push`/`replace`/`launchApp`/`home`/`exit` [A] | ❌ (router not allowed; use a notification) [A] | ❌ [A] | ✅ `router.push` with params [A] | ? | `IMG_CLICK`; `hmApp.startApp` [A/B] |
| **When it runs** | While the user has it open; **exits about 10 s after screen-off by default**. `setPageBrightTime` / `pauseDropWristScreenOff` keep it alive; `setWakeUpRelaunch(true)` reopens it on wake [A] | When an alarm fires, a notification button is tapped, or a system/custom event occurs. **Not while your page is in the foreground** [B] | From `start()` until `exit()`/`stop()` or a system limit; survives app exit and reboot; `reload` restarts it after power-saving/language/app-update changes [A]; may stop in Sleep Mode [B] | `onInit`/`build` when added; `onResume` on focus; **Pause** on blur (callbacks and timers frozen) [A] | Inside the Workout app during a workout; Pause when not focused [A] | While displayed (resume/pause via `WIDGET_DELEGATE`) and in AOD [A] |
| **Hard limits** | Battery | **600 ms** [A] | Needs `bg_service` + user consent; **one store app in the background, system-wide** [A] | 5 widgets/cards per app; height 20–60% of screen [A] | API ≥ 3.6 [A] | No Side Service [B] |

Side Service and Settings App (both on the phone, for context): they run inside the Zepp App, which must be kept alive on the phone (Android allow-list) [A: manual]. The Side Service lifecycle and its wake/alive rules are undocumented [B] (water-reminders OQ-37/38).

---

## 7. Community findings

| Finding | Device / OS | Source |
| --- | --- | --- |
| API_LEVEL 4.4 measured via `getSystemInfo().minAPI` on Zepp OS 6 (6.2.104.6); official docs are behind the firmware | T-Rex 3 | [B] [Nieole/water-reminders device matrix](https://github.com/Nieole/water-reminders/blob/HEAD/docs/zepp-os/06-device-matrix.md) (consistent with the Zeus registry [A]) |
| A `REPEAT_MINUTE` + `store:true` heartbeat is reliable; first fire exactly 60 s; survives reboot; `param` reaches `onInit`; service run 46–111 ms | T-Rex 3 / OS 6 | [B] [alarm notes](https://github.com/Nieole/water-reminders/blob/HEAD/docs/zepp-os/05-api-notes/alarm.md), [ADR-0004](https://github.com/Nieole/water-reminders/blob/HEAD/docs/adr/0004-heartbeat-scheduling.md) |
| An alarm-woken service does not run while the page is in the foreground; notification actions pointing at a service fail silently when they need writes; `onEvent` vs `onInit`; max 3 actions, only `actions[0]` in the card view | T-Rex 3 / OS 6 | [B] [pitfalls](https://github.com/Nieole/water-reminders/blob/HEAD/docs/zepp-os/07-pitfalls.md) P-14/15/18 |
| `LocalStorage` transient empty reads of 27–67%; move to fs double-slot files; single writer | T-Rex 3 / OS 6 | [B] pitfalls P-17/28/29 |
| `Promise` and `setTimeout` exist in pages despite `js-support.md`; `stringToBuffer` (documented at 4.0) is missing on 4.4; the deprecated `Weather` still works | T-Rex 3 / OS 6 | [B] pitfalls P-19/24/11 |
| Shortcut Card works; `getAppWidgetSize()` → `{w:400,h:240,margin:40,radius:36}`; no preview image needed; card background `#333333` | T-Rex 3 / OS 6 | [B] [widget-cards notes](https://github.com/Nieole/water-reminders/blob/HEAD/docs/zepp-os/05-api-notes/widget-cards.md) |
| Accelerometer is unavailable in App Services, so fall detection is foreground-only: `setPageBrightTime` plus dimming, and an alarm "dead-man's switch" that relaunches the page within 90 s | Active (3.6) etc., 2026-09 | [B] [katatsu12/fall-detection](https://github.com/katatsu12/fall-detection) |
| Sensor logging every 5 minutes from a background service to an HTTP server; stops in watch Sleep Mode | GTR 4 | [B] [SleepAgent](https://github.com/Anduin2017/SleepAgent/blob/master/README.md) |
| `AppService(BasePage(...))` + zml ≥ 0.0.23 makes `httpRequest` from a service work (2+ months stable); an ambassador noted timers need UI (pre-4.0) | Balance / ZOS 3.0 | [B] [#270](https://github.com/orgs/zepp-health/discussions/270), [#351](https://github.com/orgs/zepp-health/discussions/351) |
| Weekly reminders via `REPEAT_WEEK` alarm → service → `notify`; no `bg_service` permission | Balance 2 / OS 4–5 | [B] [Custom-Reminders](https://github.com/Tyomich4736/Custom-Reminders-Zepp-OS-App) |
| Watch faces can't use the Side Service; use a companion app file read by appId | Balance / 3.0 | [B] [#330](https://github.com/orgs/zepp-health/discussions/330) |
| Side Service messaging unavailable inside Workout Extensions; an app-side alongside a data-widget fails to build; official sample non-functional; no staff reply | T-Rex 3 Pro fw 6.3.13.5 | [B] [#554](https://github.com/orgs/zepp-health/discussions/554) (2026-08-28) |
| The T-Rex 3 got Zepp OS 6 *without* Launcher 2.0; Launcher 2.0 moves widgets into Shortcut Cards | T-Rex 3 family | [B] [gadgetsandwearables](https://gadgetsandwearables.com/2026/08/20/amazfit-zepp-os-6-new-launcher-missing/), [os.zepp.com](https://os.zepp.com/news/redesigning-the-launcher-around-what-matters-most) |
| System timers drift ("significant time discrepancy") | older | [B] [XiaomaiTX/zeppos-timer](https://github.com/XiaomaiTX/zeppos-timer) |

---

## 8. Background and always-on use cases on the T-Rex 3: possible vs NOT possible

### ✅ Possible (and how)

1. **Scheduled reminders that survive reboot**, with a vibration pattern and 0–3 buttons: one-off, every N minutes/hours/days, specific weekdays, monthly or yearly. Use `@zos/alarm` (`store:true`) → single-execution service → `notify()` [A]; verified on a T-Rex 3 [B].
2. **Adaptive reminders** (the next reminder depends on what the user did). Use one fixed heartbeat alarm with a pure read-only check in the service; the page does all writes [B, T-Rex 3].
3. **A full-screen alert UI at a precise time.** Point the alarm `url` at a **page** (or use `setLaunchAppTimeout`); it can vibrate continuously and use the buzzer [A].
4. **Reacting to system state:** wear on/off, sleep status, sleep-mode enter/exit, sunrise/sunset/moonrise/moonset, abnormal heart rate, stress reminder. Use an `app-event` service [A]. Custom events from your own page use `emitCustomSystemEvent` [A].
5. **Low-rate background sampling of low-power metrics** (HR last/current, steps, calories, battery, stress, SpO2 value, sleep data, weather). Use the heartbeat (≥ 1 min grid, 600 ms each) or a **continuous service** with `Time.onPerMinute` / `createSysTimer` (4.0). Persist while the screen is off or in AOD [A]; 5-minute logging proven on a GTR 4 [B].
6. **Background sync to the phone or cloud.** Use a continuous service with zml `BasePage` → Side Service → `fetch`. This needs user consent, your app holding the single background slot, and the Zepp App alive on the phone [A/B]. Fallback: sync when the user opens the app.
7. **Glance surfaces:**
   - A **Shortcut Card** showing the app's latest state, refreshed on focus (`onResume`) [A/B].
   - **Your own watch face** showing the app's data by reading its files or shared storage [A-new/B].
   - Both can deep-link into the app with params [A].
8. **Near-real-time foreground monitoring with high-power sensors** (GPS, accelerometer, gyroscope, BLE-central peripherals). Keep a page alive with `setPageBrightTime` / `pauseDropWristScreenOff`, optionally dimmed, plus a watchdog alarm that relaunches it. This costs a lot of battery [A/B].
9. **In-workout features** (GPS pace, HR zones, custom data pages) via a **Workout Extension** [A]. Phone connectivity inside it is currently broken [B]. See agent B for depth.
10. **A custom system keyboard** (4.2) **on Zepp OS 6 firmware** [A: keyboard docs + registry API 4.4].

### ❌ NOT possible (or not realistically)

1. **Background GPS / accelerometer / gyroscope.** No background location logging, step-cadence analysis from raw motion, or fall detection while the app is closed. The exceptions are the foreground page and the Workout Extension inside a workout [A][B].
2. **Background BLE central.** You cannot poll external BLE sensors (cadence, CGM, and so on) while the app is closed [A].
3. **Any UI from the background.** No overlays or pop-ups other than notifications, and no pushing of updates into cards or watch faces from a service. Cards refresh only when focused; watch faces only while visible [A].
4. **Timers in single-execution services and anything over 600 ms per wake.** This includes BLE and HTTP round trips from an alarm-woken service [A][C].
5. **Two store apps holding continuous services at once.** The user is asked to choose; your always-on service can be switched off by another app's request [A].
6. **Reading, intercepting, or replying to phone notifications, SMS, calls, or other apps' notifications** [A].
7. **Adding third-party tiles to Control Center**, status dots, Morning Updates, or complications on other people's watch faces [A/C].
8. **SecondaryWidget (horizontal widget pages) on the T-Rex 3**, per the docs. There is no sign Zepp OS 6 enables it; the new launcher goes the other way [A/B].
9. **Watch faces talking to the phone** (no Side Service or BLE), posting notifications, or setting alarms [B/C].
10. **File writes from a service while the screen is on** (for example, handling a notification tap inside a service) [A].
11. **Keeping a normal page alive after screen-off without keeping the screen lit.** Default: exit after about 10 s [A].
12. **Phone connectivity from inside a Workout Extension** on current firmware [B #554].
13. **Guaranteed precise timing.** Alarm precision and jitter are undocumented; long-run drift and time-zone/DST behaviour are untested; system timers are reported to drift [A/B].

---

## 9. To verify on our own T-Rex 3 (probe checklist)

1. `getSystemInfo()`: confirm `minAPI === '4.4'` and `osVersion` 6.x on the target watch.
2. `start()` with `file` vs `url`, `requestPermission(['device:os.bg_service'])`: does the consent dialog appear? What error code does a second store app's service get?
3. `createSysTimer` inside a continuous service with the screen off for hours: does it fire on time, and does it drain the battery?
4. Can a service call `@zos/alarm` `set()`, `Vibrator`, `@zos/storage`, or `@zos/i18n`? What happens to file writes attempted while the screen is on (silent failure or an exception)?
5. `@zos/share-storage` / `ShareTypedStorage` on 4.4, and reading them from a JS watch face.
6. Are local `notify()` notifications silenced by DND, Sleep and Theater modes? How long do they persist?
7. Does each undocumented event actually fire: `event:os.system.power_saving`, `…theater_mode`, `…no_disturb`, `event:os.health.spo2_low`?
8. Shortcut Buttons (Settings → Preferences): can an installed Mini Program be assigned?
9. Alarm behaviour after a time-zone change and a DST change; the maximum number of alarms per app.
10. Does a continuous service survive Sleep Mode and Battery Saver (with `reload: true`)?

---

## 10. Sources

**Official (local):**

- Guides: `DOCS/guides/framework/device/{app-service,system-event,system-notification,secondary-widget,permission,fs,life-cycle,compatibility,js-support,ble-central}.md`, `DOCS/guides/architecture/arc.mdx`, `DOCS/guides/workout-extension/{intro,quick-start}.mdx`, `DOCS/guides/keyboard/intro.mdx`, `DOCS/guides/version-info/new-features-{30,35,40,42}.md`, `DOCS/guides/tools/watchface/*`, `DOCS/guides/faq/watchface-maker.md`, `DOCS/distribute/watchface.md`.
- Device API reference, `DOCS/reference/device-app-api/newAPI/`:
  - `app-service/*`, `global/{AppService,AppWidget,SecondaryWidget,DataWidget,setTimeout}.mdx`
  - `alarm/*`, `notification/*`, `timer/*`
  - `app/{emitCustomSystemEvent,queryPermission,requestPermission,getScene,getPackageInfoById}.mdx`
  - `router/{launchApp,setLaunchAppTimeout,checkSystemApp,getAppIdByName,home}.mdx`
  - `display/{setWakeUpRelaunch,setPageBrightTime,pauseDropWristScreenOff}.mdx`
  - `storage/*`, `share-storage/*`
  - `sensor/{Time,Vibrator,Buzzer,HeartRate,Wear}.mdx`, `ui/{getAppWidgetSize,setAppWidgetSize}.mdx`, `app-access/getSportData.mdx`
- Other reference: `DOCS/reference/{app-json.mdx,related-resources/device-list.mdx}`, `DOCS/reference/side-service-api/`.
- Watch face and design: `DOCS/watchface/**`, `DOCS/designs/{interaction/physical-buttons.md,customization/shortcut-cards.md}`.
- Screenshots: `src/zeppos-docs/static/img/docs/guides/version_info/{enable_service,service_manage,notification_demo}.jpg`.
- Samples: `SAMPLES/application/3.0/{3.0-feature,notification}`, `SAMPLES/application/4.0/4.0-feature`, `SAMPLES/application/2.0/calories`, `SAMPLES/application/4.2/simple-keyboard`, `SAMPLES/workout-extensions/3.5/*`, `SAMPLES/watchface/3.0/timer`.
- Libraries and types: `ZML/src/core/device/{app-service/BgService.js,permission/permission.js,base-page.js,messaging/page-plugin.js}`; `@zeppos/device-types` 3.0.0 (`src/easy-draw/draw-example/node_modules/@zeppos/device-types/dist/index.d.ts`) and 4.0.0 (`TYPES4/`).

**Official (web):**

- [Zeus device registry](https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json) (copy at `research/zeus-devices.json`); [live device list](https://docs.zepp.com/docs/reference/related-resources/device-list/); [Zepp OS 6 compatibility](https://os.zepp.com/compatibility-zepp-os-6); [Launcher redesign](https://os.zepp.com/news/redesigning-the-launcher-around-what-matters-most).
- T-Rex 3 support: [user manual PDF](https://support.amazfit.com/en/amazfit_t-rex_3/files/user-manual.pdf.pdf) (text at `COMM/trex3-manual.txt`); [alarms](https://support.amazfit.com/en/amazfit_t-rex_3/docs/WMK7dYbphoN2ucxzUT8cedsQnJf); [battery saver](https://support.amazfit.com/en/amazfit_t-rex_3/docs/PLixdvlm4oZv2CxTTLAcs4eAnig); [npm @zeppos/device-types](https://registry.npmjs.org/@zeppos/device-types).

**Community:**

- Repositories: [Nieole/water-reminders](https://github.com/Nieole/water-reminders) (copies in `COMM/wr/`); [Tyomich4736/Custom-Reminders-Zepp-OS-App](https://github.com/Tyomich4736/Custom-Reminders-Zepp-OS-App) (`COMM/cr/`); [katatsu12/fall-detection](https://github.com/katatsu12/fall-detection); [Anduin2017/SleepAgent](https://github.com/Anduin2017/SleepAgent/blob/master/README.md); [silver-zepp AutoGUI wf↔app comms](https://github.com/silver-zepp/zeppos-autogui/tree/main/other-autogui-examples/zeppos-3.0-wf-app-comms) (`COMM/wfcomms/`); [novvember/amazfit-watchfaces](https://github.com/novvember/amazfit-watchfaces) (`COMM/nov/`); [XiaomaiTX/zeppos-timer](https://github.com/XiaomaiTX/zeppos-timer).
- zepp-health discussions: [#270](https://github.com/orgs/zepp-health/discussions/270), [#313](https://github.com/orgs/zepp-health/discussions/313), [#330](https://github.com/orgs/zepp-health/discussions/330), [#351](https://github.com/orgs/zepp-health/discussions/351), [#554](https://github.com/orgs/zepp-health/discussions/554).
- Staging docs (obsolete draft): [docs-testing background-service](https://docs-testing.zepp.com/docs/next/guides/framework/device/background-service/).
- News: [thewearify, OS 5.0 on T-Rex 3](https://thewearify.com/amazfit-t-rex-3-receives-zepp-os-5-0-update/); [gadgetsandwearables, OS 6 on T-Rex 3](https://gadgetsandwearables.com/2026/07/22/amazfit-t-rex-3-pro-ultra-2-zepp-os-6-update/); [gadgetsandwearables, launcher missing](https://gadgetsandwearables.com/2026/08/20/amazfit-zepp-os-6-new-launcher-missing/).
