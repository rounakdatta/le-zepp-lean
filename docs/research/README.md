# Zepp OS on the Amazfit T-Rex 3: platform research

Research date: 2026-09-28. This is the summary of six detailed reports in this folder (listed at the end). It covers how Zepp OS apps are built, and what can and cannot be built on the Amazfit T-Rex 3.

**Confidence markers** used below:

- ✅ Verified in official docs, official code or Zepp's own device registry.
- ⚠️ Possible with caveats, or reported by the community but not verified by us.
- ❌ Not possible.

Nothing here has been tested on your watch yet. The [week-1 checklist](#9-verify-on-your-watch-in-week-1) lists what to confirm first.

---

## 1. TL;DR

1. **Your watch is newer than the docs say.**
   - Zepp's own device registry, the one the build tool downloads, lists the T-Rex 3 at **Zepp OS 6.0 / API_LEVEL 4.4**.
   - The docs' device table still says 4.0 / Zepp OS 4.5.
   - On updated firmware (6.2.104.6 from 2026-07-22, 6.3.25.7 from 2026-09-03), everything documented up to API 4.2/4.3 should be available; confirm on your watch. That includes the custom keyboard, HR-zone and route-navigation APIs, and a device UUID.
   - The T-Rex 3 gets software support until September 2027.
2. **Apps are JavaScript** (a QuickJS engine, roughly ES2020) and come in three parts:
   - a **Device App** on the watch;
   - an optional **Side Service** running inside the Zepp phone app, which is the only place with internet access;
   - an optional **Settings App**, a phone-side configuration UI shown inside Zepp.
3. **The watch has no internet of its own.** It has Wi-Fi hardware, but apps can't use it. Every network call goes watch → Bluetooth → Zepp app on the phone → `fetch()`. The phone cannot push to the watch unless the watch app started the conversation.
4. **Foreground apps are powerful but short-lived.**
   - An app is killed about 10 s after the screen turns off, unless you keep the screen on, which costs battery.
   - Apps cannot draw on the always-on display (AOD).
5. **Background work is tightly limited.** Background services cannot:
   - draw UI or use normal timers;
   - use GPS, the accelerometer or the gyroscope;
   - talk to external Bluetooth devices.

   Only **one** store app can hold a continuous background service on the whole watch. The dependable pattern is a scheduled wake-up (an alarm) that gets **600 ms** of work per run.
6. **Workout Extensions are the fitness sweet spot.** They are your own custom data pages inside the built-in Workout app, and native recording, GPS and Strava sync keep working.
   - They can read about 15 live metrics, draw about 200 system metrics, use haptics, and read GPS and motion sensors while their page is on screen.
   - They pause when their page isn't on screen.
   - They cannot write anything into the recorded workout.
   - Talking to the phone from inside one is reported broken on current T-Rex 3 Pro firmware. Other developers still ship it, so test it on your watch.
7. **Bluetooth to external hardware works from a foreground page.**
   - The watch acts as a BLE central (GATT client) to things like an ESP32 or a chest strap.
   - It is one device at a time, with small packets (plan for ≤ 20 bytes).
   - The watch cannot advertise or act as a peripheral, and nothing Bluetooth works in the background.
8. **Sensor ceilings.**
   - Live heart rate: yes.
   - Beat-to-beat intervals, HRV or raw optical sensor data: no.
   - Accelerometer and gyroscope: about 20–25 Hz effective, with no timestamps, foreground only.
   - Barometer: updates only every 10–80 s.
   - GPS: latitude and longitude only (no speed, altitude or accuracy), foreground only.
   - History: shallow, from "today only" to 7 days depending on the metric.
9. **Your data cannot enter Zepp's health or workout records.**
   - No workout-write API, no custom fields in workout files, and no public cloud API.
   - To get your own data to Strava or elsewhere, send it yourself through the phone.
   - To get external-sensor data into native workouts, have the hardware speak a **standard Bluetooth sensor profile** (heart rate, cadence, power, and so on) that the watch pairs with natively.
10. **Other hard no's:**
    - reading phone notifications;
    - tiles in Control Center, or complications on other watch faces;
    - starting or stopping native workouts from code;
    - a speaker (the T-Rex 3 has only a buzzer and vibration motor);
    - paid store listings outside mainland China (use external license keys instead).
11. **The toolchain works on this Mac.** Zeus CLI 1.9.3 builds real packages here, and the simulator is native on Apple Silicon.
    - Install Zeus globally or with `install-strategy=nested`, because `npx` crashes.
    - Installing on the watch goes through Zepp's cloud (a QR code) and needs an email/password Zepp account.
    - Personal use needs no store listing.

---

## 2. The T-Rex 3 as a development target

| Item | Value | Confidence |
|---|---|---|
| Codename / deviceSource | "Matterhorn". `8716545`, `8716547` (global), `8716544` (Mainland China) | ✅ registry |
| OS / API level | Zepp OS 6.0 / API_LEVEL **4.4** on current firmware; the docs table's 4.0 is stale | ✅ registry, and ⚠️ measured by one community developer (`getSystemInfo().minAPI === '4.4'` on 6.2.104.6) |
| Screen | 480 × 480 round AMOLED, touch; icon size 124 px | ✅ |
| Buttons | 4: UP and DOWN on the left, SELECT and BACK on the right. **No crown** | ✅ |
| Sensors | Dual-band GNSS, optical HR (plus SpO₂ and skin temperature), accelerometer, gyroscope, compass, barometer, ambient light | ✅ registry / product page |
| Audio | **Microphone yes, speaker no.** Buzzer and vibration motor. Music needs Bluetooth headphones | ✅ manual |
| Radios | BLE 5.2 (no ANT+); Wi-Fi 2.4 GHz for the system only; NFC on some variants, not exposed to apps | ✅ |
| App surfaces | App list, Shortcut Cards (DOWN button; measured card size 400 × 240), notifications, your own watch faces, Workout Extensions. **No SecondaryWidget** | ✅ docs; ⚠️ card size measured by the community on Zepp OS 6 |
| JS runtime | QuickJS; build output ES2020 compiled to bytecode. `Promise` works; **async/await does not** | ✅ build tool; ⚠️ staff forum answer |

---

## 3. How a Zepp OS app is put together

```
┌─────────────── Watch (Zepp OS) ───────────────┐          ┌──────────── Phone: Zepp app ────────────┐
│ Device App: App() + Page()s   (foreground UI) │   BLE    │ Side Service (JS worker, no UI)         │  HTTPS
│ App Service                   (background)    │◄────────►│   fetch · download · image convert      │◄──────► Internet / LAN
│ Shortcut Card (AppWidget)                     │  (ZML    │   settingsStorage ◄──┐                  │
│ Workout Extension (DataWidget, inside Workout)│  request/│ Settings App (configuration UI in Zepp) │
│ Watch face (separate package type)            │  response)└────────────────────────────────────────┘
│        │ BLE central (foreground only)        │
└────────┼──────────────────────────────────────┘
         ▼
  Your hardware / BLE sensors (ESP32, nRF, chest strap, …)
```

| Part | Runs on | What it's for | Key limits |
|---|---|---|---|
| **Device App** (pages) | Watch | The app UI: widgets, canvas, sensors, storage, BLE central | Killed about 10 s after screen-off unless kept awake; no AOD drawing |
| **App Service** | Watch, background | Periodic or event-driven work | 600 ms per wake (single-execution), or one continuous service system-wide; no UI, timers, GPS, motion sensors or BLE central |
| **Shortcut Card** | Watch | A glanceable card in the DOWN-button list | Click-only; refreshes when shown |
| **Workout Extension** | Watch, inside the Workout app | Custom live data pages during native workouts | One page, no scrolling, pauses when not focused, read-only |
| **Watch face** | Watch | JS or no-code face; can read sensors and your app's shared files | No phone link or BLE; no background work |
| **Side Service** | Phone (inside Zepp) | Internet, heavy computation, file download/convert, OAuth token use | Starts on demand; dies about 10 min after going idle; only lives while the Zepp app lives |
| **Settings App** | Phone (inside Zepp) | Config UI built from fixed components (Toggle, TextInput, Select, Slider, Auth/OAuth, …) | No custom HTML; runs only while open |

Messaging uses the **ZML** library (`@zeppos/zml`):

- The watch calls `this.request()` → the phone handles it in `onRequest`.
- The phone calls `this.call()` → the watch handles it in `onCall`, but only after the watch has connected first.
- Messages are split into 3.6 KB frames. Default timeouts are 60 s per request and 5 s for the handshake. There is no retry, so build an outbox and use short timeouts.

Details: [C-connectivity.md](C-connectivity.md) §3–5.

---

## 4. What you can and can't build, by area

### 4.1 UI and interaction ([A](A-device-runtime-ui.md))

| Capability | Status |
|---|---|
| 30 widgets: text (including curved text), image, button, arc, lists (`SCROLL_LIST` with button focus), pickers, charts (histogram and polyline), QR code, page swiper, modals, toasts | ✅ |
| CANVAS drawing: lines, arcs, polygons, text, images; up to 3 layers. No paths, gradients or clipping | ✅ within limits |
| Flex layout (`VIRTUAL_CONTAINER`) and property getters/setters (API 4.0) | ✅ (verify Flex on the device; one report says it renders differently) |
| Animation of x/y/w/h/alpha, frame animation, scroll animation | ✅ (no rotation or colour tweening) |
| Physical keys through `onKey`: UP, DOWN and SELECT clicks and long-presses; BACK only with care | ⚠️ The docs say single taps can't be intercepted, but apps do it; verify. The 5 s BACK power menu can't be overridden |
| System keyboard: numbers, characters, emoji, **voice** (API 4.0) | ✅ (voice depends on region) |
| Custom keyboard (input method) as your own app (API 4.2) | ✅ on Zepp OS 6 firmware |
| Vibration patterns and sequences; buzzer | ✅ |
| Keep the screen on and relaunch on wake | ✅ (battery cost) |
| Speaker audio or TTS; drawing on AOD; multi-touch or pinch | ❌ |

### 4.2 Sensors and health data ([B](B-sensors-health-workout.md))

| Capability | Status |
|---|---|
| Live heart rate (bpm) while your page is open | ✅ (rate undocumented, probably about 1 Hz) |
| **RR intervals, HRV, raw optical sensor data** | ❌ (only via an external BLE chest strap, foreground only) |
| Accelerometer and gyroscope | ⚠️ Foreground only; LOW/NORMAL/HIGH modes with no stated rate. Observed as batches at about 20–25 Hz effective, no timestamps. Fine for coarse rep, gesture or fall detection; not for precise kinematics |
| GPS | ⚠️ Latitude/longitude, fix status and rich satellite info only. No speed, heading, altitude or accuracy figure. Foreground only |
| Barometer / altitude | ⚠️ Cached values that update only every 10–80 s. During a workout, `getSportData('altitude')` gives about 1 Hz. Variometers and skydiving altimeters don't work |
| Compass heading with a selectable rate (API 4.0) | ✅ |
| History: HR today (per minute), stress 7 days, SpO₂ last 24 h, PAI 7 days, **sleep last night only**, skin temperature today, steps/calories/distance today | ✅ shallow; build your own history by logging |
| VO₂max, training load, recovery time | ✅ readable |
| HR zones (API 4.2) | ✅ on Zepp OS 6 firmware |
| Readiness, training effect, BioCharge/HybridCharge, HRV score | ❌ as numbers. Readiness and training effect can only be *displayed* (in a watch face or extension) |
| Write weight/BMI into Zepp | ✅ (the only health write) |
| Numeric water depth | ❌ |

### 4.3 Workouts ([B §6–7](B-sensors-health-workout.md))

| Capability | Status |
|---|---|
| **Workout Extension**: a custom page inside a native workout, configured per sport type. The user adds it under the workout's settings. Up to 4 extension pages per workout | ✅ T-Rex 3 is officially supported |
| Read live workout metrics as numbers (15 types: speed, pace, distance, duration, calories, cadence, altitude, ascent, …) | ✅ |
| Display about 200 system-drawn metrics (HR zone, power, training effect, charts, strength set/rep counts, …) | ✅ (JS can't read them) |
| Extension keeps running when its page isn't focused | ❌ (callbacks and timers pause) |
| Extension talks to the phone (Side Service) | ⚠️ Reported broken on T-Rex 3 Pro firmware 6.3.13.5 (forum #554). Other 2026 apps ship it untested. Plan to sync from the main app instead |
| Write custom fields, laps or labels into the recorded workout (like Garmin's FIT developer fields) | ❌ |
| Start, stop, lap or pick a sport programmatically | ❌ (you can only open the Workout app) |
| Save your *own* recorded workout into Zepp, so it syncs to Strava or Apple Health through Zepp | ❌ (upload it yourself via the phone, e.g. with the Strava API) |
| Read past workouts | ⚠️ Start time and duration only |

### 4.4 Background, scheduling and alerts ([D](D-app-types-background.md))

| Capability | Status |
|---|---|
| Scheduled reminders that survive reboot: an alarm wakes a service, which posts a notification (up to 3 buttons) | ✅ (verified on a T-Rex 3 by the community) |
| An alarm that opens a full-screen page at a set time | ✅ |
| React to system events: wear on/off, sleep state, abnormal HR, sunrise/sunset | ✅ (600 ms of work per event) |
| Minute-level background logging of low-power metrics (HR, SpO₂, stress, steps, battery) | ✅ via the heartbeat-alarm pattern, or a continuous service with `createSysTimer` (API 4.0) |
| Continuous background service | ⚠️ Needs user consent, and only **one store app on the whole watch** can hold it. Reports of services dying overnight; the alarm pattern is more robust |
| Background sync to the cloud | ⚠️ Best effort. Needs the background slot, plus the Zepp app alive on the phone |
| Background GPS, motion sensors, BLE central, UI | ❌ |
| Read phone notifications, SMS or calls | ❌ |
| Control Center tiles, status icons, complications on other faces, SecondaryWidget | ❌ |
| Your own watch face showing your app's data (through shared files or storage) | ✅ (refreshes while visible) |

### 4.5 Phone, internet and cloud ([C](C-connectivity.md))

| Capability | Status |
|---|---|
| Call any HTTPS or LAN HTTP API through the phone (weather, Home Assistant, your backend, Strava) | ✅ (self-signed HTTPS is rejected) |
| OAuth sign-in (Google, Strava, Spotify, …) in the Settings App | ✅ (redirect URI `https://zepp-os.zepp.com/app-settings/redirect.html`; PKCE is `plain`) |
| Move files both ways (routes, images, logs); download files and convert images on the phone | ✅ (speed unmeasured) |
| Configuration UI on the phone synced to the watch | ✅ |
| Phone or server pushing to the watch while the app is closed | ❌ (no push channel; ordinary phone notifications mirrored by Zepp are the workaround) |
| WebSockets, long-polling, streaming | ❌ (fetches are reported cut after about 10 s of silence) |
| Your own phone app talking to the watch app | ⚠️ Only indirectly: the Side Service polls a local HTTP server in your Android app (the EUC Planet pattern). Not realistic on iOS |
| Watch uses its own Wi-Fi | ❌ |
| Self-serve Zepp cloud API for your health data | ❌ (partner-only; Health Connect and Apple Health exports are the route) |

### 4.6 External hardware over Bluetooth ([C §7](C-connectivity.md), [F §4.2](F-community-prior-art.md))

| Capability | Status |
|---|---|
| Watch as GATT client to your own peripheral (ESP32 or nRF): scan, connect, read/write, notifications | ✅ foreground page only. Proven with an ESP32 example, a Libre 2 CGM, a smart scale, cameras, and 25 Hz IMU streaming to a PC |
| Standard BLE sensors recorded natively in workouts (HR strap, cycling cadence/power, Stryd, FTMS trainers) | ✅ system feature, no code needed |
| Several peripherals at once, BLE indications, reliable bonding or encryption | ❌ / ⚠️ fragile (one badly sequenced call rebooted a watch) |
| BLE in the background or inside a watch face | ❌ (inside a Workout Extension only while its page is on screen) |
| Watch as BLE peripheral or advertiser | ❌ (staff: "no plan") |
| Phone-free link to a PC or Raspberry Pi | ✅ (the PC runs a GATT server; the watch connects to it as a central) |
| BLE in the simulator | ❌ (real device only) |

---

## 5. Hard constraints to design around (ranked)

1. **Session-shaped apps win.** Anything that needs continuous sensing must run while the app is on screen, or inside a workout. Plan the user experience around "open it, do the thing, close it". Keep the screen on during sessions, save state on every change, and use alarm wake-ups for periodic jobs.
2. **The phone is the only way out.** The Zepp app must be alive on the phone.
   - Links are request/response at a few KB/s, with a practical polling rate of 1–4 Hz.
   - There is no push, and fetches are reported cut at about 10 s.
   - Design offline-first: an outbox on the watch, idempotent uploads, and batch sync when the app opens.
3. **Hardware must be a BLE peripheral that the watch talks to from a foreground page.**
   - Use one device at a time with no bonding (do authentication at the app layer).
   - Keep frames ≤ 20 bytes and add reconnect with backoff.
   - Develop on the real watch only, since the simulator has no BLE.
4. **Workout Extensions are overlays, not engines.** Use them for live screens inside native workouts. Do logic and logging in the main app, and sync from there.
5. **Your data can't enter Zepp's records.** Own the data path (phone → your backend or Strava), or emulate standard BLE sensor profiles so the watch records the data natively.
6. **Sensor fidelity is limited**:
   - no HRV/RR or raw optical data;
   - a slow barometer;
   - motion sensors and GPS in the foreground only;
   - no speaker.

   Reject ideas that depend on these, or bring your own sensor over BLE.
7. **The docs and toolchain lag the firmware.** The docs say API 4.0 while the watch runs 4.4, and OS updates cause regressions (Zepp OS 6 broke music control on the T-Rex 3). Detect the API level and feature-test APIs at runtime, pin tool versions, and re-test after firmware updates.
8. **The JS runtime is small.**
   - No `async/await`, `eval`, `fetch`, `TextEncoder` or `Intl`.
   - The memory ceiling is undocumented (a 200 KB file read has run out of memory on another model), and file I/O is synchronous.
   - `LocalStorage` returned empty reads 27–67% of the time on a T-Rex 3, so use files with a single writer.
   - Any `export` in an entry file gives a black screen.

---

## 6. Proven patterns and whom to copy

| Pattern | Use it for | Reference implementation |
|---|---|---|
| **Foreground session app**: keep the screen awake plus relaunch on wake | Interval/HIIT timers, HR-zone coaching, rep/score counters, IMU capture | `mohansella/zepp-hr-zone`, `trystan2k/padelbuddy`, `katatsu12/fall-detection` |
| **Workout Extension overlay** | Custom running, strength or trail screens inside native workouts | `andrejd1/rundeck` (the best map of what extensions can read), `PreciselyWrong/Liftosaur-ZeppOs-Companion` (strength app plus extension, offline-first sync), `1445688048/YeRun-Trail` (GPX checkpoints) |
| **Heartbeat alarm to a 600 ms service to a notification** | Reminders, periodic checks, background logging | `SashaCX75/Weather-service`, `Nieole/water-reminders` (T-Rex 3 / Zepp OS 6 field notes) |
| **Watch → ZML → Side Service → HTTPS** | Cloud sync, APIs, OAuth | `zepp-health/zml`, `zeppos-samples/application/4.0/fetch-api`, `melianmiko/ZeppOS-Tasks` (OAuth) |
| **Watch as BLE central to a custom peripheral** | Controlling or reading your own hardware | `zepp-health/easy-ble` (plus its ESP32 firmware), `JovannMC/ZeppSlime` (25 Hz IMU streaming), `3125589/yunmai-zeppos` |
| **Phone-hosted hardware**: Android app ↔ device, Side Service polls `http://127.0.0.1` | Hardware your phone already talks to | `eried/eucplanet` (tested on a T-Rex 3) |
| **Standard BLE profile emulation** | Getting external data *into* native workouts and Strava | T-Rex 3 native accessory support (HR, CSC, CPS, RSC, FTMS) |
| **Companion app writes files, watch face reads them** | Your data on your own watch face | `silver-zepp/zeppos-autogui` (watch face ↔ app comms example) |

---

## 7. Quick idea-fit guide

| If the idea needs… | Verdict | Architecture |
|---|---|---|
| A custom screen during runs, rides or hikes | 🟢 Great fit | Workout Extension (+ main app for settings/sync) |
| Gym logging, sets/reps, rest timers | 🟢 Great fit | Foreground app (+ optional extension inside Strength Training) |
| Interval, HIIT or Tabata guidance with haptics | 🟢 Great fit | Foreground app or Workout Extension |
| Talking to a custom ESP32/nRF gadget while you look at the watch | 🟢 Good fit | Foreground page as BLE central |
| Pulling data from an API or your server | 🟢 Good fit | ZML → Side Service `fetch` |
| Reminders or nudges | 🟢 Good fit | Alarm → service → notification |
| All-day background logging of HR, stress and similar | 🟡 Possible | Heartbeat alarm or one continuous service; your own storage |
| Coarse motion or rep detection from the wrist | 🟡 Possible | Foreground page; about 20 Hz, test first |
| Your own GPS track recorder | 🟡 Possible | Foreground, screen on; export yourself (Zepp won't record it) |
| HRV biofeedback | 🟡 Only with a chest strap | Strap RR intervals via BLE, foreground |
| Live streaming of watch data to a server | 🟡 Limited | A few Hz of small messages through the phone |
| Anything always-on in the background with GPS or motion sensors | 🔴 No | — |
| Server-initiated push to the watch app | 🔴 No | Workaround: a phone notification |
| Writing into Zepp or Strava via Zepp's own sync, or custom fields in workouts | 🔴 No | Own upload path, or standard BLE profiles |
| Variometer, dive computer, fast altimeter | 🔴 No | — |
| Reading phone notifications, or voice output | 🔴 No | — |

---

## 8. Toolchain, workflow and distribution ([E](E-toolchain-distribution.md))

### 8.1 Setup on this Mac

Verified by building real packages here, with `HOME` sandboxed.

- **Node:** the Homebrew Node 26.9 works; Zeus needs Node ≥ 20.
- **Zeus CLI 1.9.3** (build engine zpm 3.4.2) builds a `.zab` in about 3 s. Install it globally (`npm i -g @zeppos/zeus-cli@1.9.3`), or per project with an `.npmrc` containing `install-strategy=nested`.
  - **`npx @zeppos/zeus-cli` and a normal local install both crash** with `Cannot find module 'zeppos-app-utils'`.
- **Commands:** `zeus create`, `dev` (simulator with live reload), `build`, `preview` (QR install on the watch), `bridge` (install, uninstall, screenshot, logs), `prune`, `login`/`status`.
- **Simulator 2.1.2:** a native Apple Silicon DMG.
  - Its **T-Rex 3 image stops at API 4.0**.
  - **T-Rex Ultra 2 (API 4.3)**, with the same 480×480 screen and 4 keys, is the closest stand-in. There is no public round image at 4.4.
  - No BLE, no real GNSS. The side service is flaky there because it loads Zepp's runtime from their CDN.
- **Real watch:**
  1. Zepp app → Profile → Settings → About → tap the Zepp icon 7 times to enable Developer Mode.
  2. `zeus login`. This needs an **email/password** Zepp account; Google or Apple sign-in doesn't work.
  3. `zeus preview -t "Amazfit T-Rex 3"`.
  4. Scan the QR code in Developer Mode. It's valid for 7 days, and it always goes through Zepp's cloud.
  - Developer Mode also shows device logs, takes screenshots and reports the watch's API level.
- **Language:** JavaScript only. Zeus does **not** compile TypeScript. Use JSDoc plus `@zeppos/device-types@4.0.0` with `checkJs` (verified, with a one-line `declare module "zosLoader:*"` shim), or pre-compile TypeScript yourself. Scaffolds pin device-types ^3, so bump it.
- **Debugging:** there are no breakpoints. Use `@zos/utils` `log`, the simulator console, Developer Mode device logs, and VisLog for on-screen logs (it also relays phone-side logs).

### 8.2 `app.json` essentials for the T-Rex 3

```json
"runtime": { "apiVersion": { "compatible": "4.0", "target": "4.4", "minVersion": "4.0" } },
"targets": { "trex": {
  "module": { "page": { "pages": ["page/home/index"] },
              "app-side": { "path": "app-side/index" }, "setting": { "path": "setting/index" } },
  "platforms": [{ "st": "r", "dw": 480 }], "designWidth": 480 } }
```

- **`minVersion` 4.0 is the recommended default.** It keeps the API-4.0 simulator usable. Guard 4.2+ calls at runtime with `getSystemInfo().minAPI` or `typeof fn === 'function'`.
  - Switch to strict `4.4` only once your watch reports 4.4 and you need 4.2+ APIs everywhere; you'll then test on the watch.
  - Workout Extensions use `minVersion` 3.6 plus `app.extType: "workout"` and a `data-widget` module.
- **Targeting:** `{"st":"r","dw":480}` covers all round watches; add `"sr":"w480"` for only 480×480 builds. **Don't target by `deviceSource`**, because it silently breaks per-screen layout imports.
- **Other rules:**
  - Declare every permission you use (see [B §2](B-sensors-health-workout.md) and [E §6.6](E-toolchain-distribution.md)).
  - The icon is a 248×248 circular PNG.
  - Before publishing, replace the random scaffold `appId` with the ID the console assigns.

### 8.3 Distribution

- **Personal use needs no store listing.** A preview install stays on the watch; no reports of expiry were found. Packages do carry an undocumented 48 h `expiredTime` field, so keep an eye on it.
- **Store:** console.zepp.com → create the app (this assigns the appId) → upload the `.zab` → provide a privacy statement, a 240 px icon and 360 px screenshots → review.
  - Review takes 1–5 working days officially; 2–15 days have been observed.
  - Listing is free. Discovery is through search only; there are no install links.
- **Paid apps:** only certified Mainland-China companies can sell through the store. Everyone else uses external licence keys (RunDeck uses Polar.sh) or KiezelPay (reportedly unmaintained).
- **Gotchas:**
  - A production `zeus build` **embeds every non-dot file in the project folder** (your sources, notes, anything) inside the package, and ignores `.gitignore`. Use `zeus prune --ip`, and **keep the watch app in its own subfolder of this repo**.
  - The store **rebuilds** packages for the T-Rex 3 (plain JS, older toolchain), so re-test the store version.
  - The CLI sends telemetry on every command, with no opt-out.
- **Gadgetbridge** can sideload device-only apps without Zepp's cloud, after an initial Zepp pairing. It cannot run the Side Service or Settings App, so no internet features.

---

## 9. Verify on your watch in week 1

Each report ends with a test plan; these are the items that decide architecture:

1. **API level and firmware:** log `getSystemInfo()` (expect `minAPI` 4.4 and a 6.x firmware), or check Zepp app → Developer mode → device info.
2. **Workout Extension → phone:** does `this.request()` work inside a DataWidget on your firmware (#554)? Also whether `onKey` works in an extension, and whether GPS and motion sensors work there.
3. **Sensor rates:** accelerometer and gyroscope callbacks per second in each mode (and the gap pattern); HR callbacks per minute; GPS fix rate and time to first fix.
4. **Keep-awake:** a 60-minute foreground session (screen on, relaunch on wake): battery cost and survival.
5. **Phone link:** ZML round-trip latency for small and 30 KB messages. Whether the Side Service survives with the phone locked and the Zepp app in the background on **your phone OS**.
6. **Background:** the heartbeat alarm, service budget and notifications; continuous service plus `createSysTimer` over hours; whether services run with AOD off.
7. **BLE (if hardware is involved):** connect to an ESP32 test peripheral; measure the largest notification size (MTU); check whether write-without-response exists (`typeof`); run connect/disconnect cycles while the phone link is active.
8. **Storage:** `getPerformance('memory')` headroom; file append speed; avoid `LocalStorage` for anything that gets read, changed and written back.

---

## 10. Detailed reports

| Report | Scope |
|---|---|
| [A-device-runtime-ui.md](A-device-runtime-ui.md) | Watch-side runtime: lifecycle, JS engine, all widgets, layout, keys, haptics, display control, storage, memory limits, a list of what's impossible |
| [B-sensors-health-workout.md](B-sensors-health-workout.md) | Every sensor class, permission strings, history depth, IMU and GPS reality, Workout Extension deep dive, code patterns |
| [C-connectivity.md](C-connectivity.md) | ZML messaging internals, Side Service lifecycle (read from Zepp's runtime code), fetch, Settings App and OAuth, BLE central, cloud APIs |
| [D-app-types-background.md](D-app-types-background.md) | Every shippable artifact type, App Service and alarms, notifications, watch faces, a "what runs when" matrix |
| [E-toolchain-distribution.md](E-toolchain-distribution.md) | Zeus CLI, simulator, developer mode, app.json for the T-Rex 3, the build experiment, store publishing |
| [F-community-prior-art.md](F-community-prior-art.md) | Open-source prior art, store apps, developer pain points, comparison with Garmin and Wear OS, ecosystem health |

**Paths inside the reports.**

- `scratchpad/src/<repo>/…` means a clone of `github.com/zepp-health/<repo>`, such as `zeppos-docs` (the Docusaurus source of docs.zepp.com), `zeppos-samples`, `zml` or `easy-ble`. Re-clone them to follow a citation.
- Other `scratchpad/…` paths (`research/`, `runtime/`, `npm/`, `pkgs/`, `community/`) were temporary working copies that were not kept.
- Evidence tags differ slightly between reports, and each report explains its own tags at the top.

**Key live sources.**

- Zepp's device registry: `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json`.
- Docs: https://docs.zepp.com (also `https://docs.zepp.com/llms.txt`, but see report A §0.2 on its errors).
- Developer forum: https://github.com/orgs/zepp-health/discussions.
