# F. Community reality check, prior art and known limitations: Amazfit T-Rex 3 / Zepp OS

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Research date: 2026-09-28. Scope: what people actually build on Zepp OS, where they hit walls, how Zepp OS compares with Garmin Connect IQ and Wear OS, and how healthy the ecosystem is. The official API surface is covered by the other agents. This report focuses on real-world evidence.

## How to read this report

Every claim carries a tag:

- **[V] Verified.** Taken from a primary source I read myself: official docs (the local clone of `zepp-health/zeppos-docs` at commit `c08725b`, 2026-07-17, plus live docs.zepp.com), Zepp's Zeus device registry, official staff statements, or source code in the repos.
- **[C] Community report.** Named developer or user, with the date. I note credibility. "High" means detailed, reproducible, recent, and usually uncontested.
- **[I] Inference.** My own reading of the evidence. Treat it as a hypothesis to test.

Sources and method:
- I pulled all 545 threads of the official developer forum (GitHub Discussions at `github.com/orgs/zepp-health/discussions`, backed by the repo `zepp-health/zeppos-forum`) through the GraphQL API, and read about 110 of them in full, including comments.
- I checked GitHub repo and code search, npm publish history, the Zeus device registry, the Discord invite API, news sites, Garmin and Android docs, and a Hacker News thread.
- **Coverage gap:** Reddit blocks both fetch and search from this environment, and the Discord content is private. Reddit-sourced claims below come second-hand, through news articles that cite Reddit.

---

## 0. TL;DR: what matters for decisions

1. **The T-Rex 3 is now on Zepp OS 6.0 at API_LEVEL 4.4, not the 4.0 / 4.5 shown in the docs device list.** [V: Zeus registry] That unlocks the API 4.2 features: the Keyboard API, `Workout.getWorkoutTrackNavInfo()` with remaining route distance, `getUserHrZoneSettings()`, and device `uuid`. The docs do not describe what 4.3 and 4.4 add. The docs device list is out of date. Check the real API level on your watch at runtime with `getSystemInfo()` and feature-detect before calling anything.
2. **The watch cannot reach the internet by itself, and the phone cannot push to the watch unless the watch started the conversation.**
   - All networking goes through the Side Service, which runs inside the Zepp phone app. The operating system may kill it.
   - Community-measured practical rate: 1 to 4 Hz of polling (EUC Planet on T-Rex 3). Android fetches get dropped at about 10 s in power-saving mode.
   - The T-Rex 3's Wi-Fi hardware is not exposed to apps.
3. **Background work is heavily restricted.** [V: docs]
   - A continuous App Service cannot use `setTimeout`, the accelerometer, gyroscope, GPS, or BLE-central (`mst*`) APIs.
   - Only one continuous App Service can run on the whole watch at a time.
   - The dependable patterns are: keep the screen on, auto-relaunch on wake, and short alarm-triggered jobs.
4. **BLE-central hardware integration works, but only from a foreground page.** [V, C]
   - Proven by EasyBLE with ESP32, direct connection to a FreeStyle Libre 2 CGM, a Yunmai scale, IMU streaming at 25 Hz, and the camera and IoT-accessory mini apps from Zepp's partners.
   - The watch cannot act as a BLE peripheral or advertiser. Pairing and bonding are fragile. There is no BLE in the simulator.
   - One badly sequenced `mstPrepare` call rebooted an Active 3 Premium in August 2026.
   - **Design any custom hardware as an unbonded GATT peripheral.**
5. **Workout Extensions (the T-Rex 3 supports them) are mostly display surfaces.** [V, C]
   - Callbacks and timers pause whenever the extension screen loses focus.
   - No button or gesture handling, and no scrolling.
   - No write-back to the workout record.
   - Access to native metrics is partial: no structured-workout steps, no native auto-laps, and no GAP, vertical oscillation or ground contact time.
   - Talking to the phone from inside an extension was reported broken on the T-Rex 3 Pro in August 2026.
6. **Data you generate does not flow into Zepp's health database or the workout FIT file.** There is no equivalent of Garmin's FIT developer fields, and no public API for writing workouts. [V, C]
   - [I] The workaround: have custom hardware speak a *standard* BLE profile that the watch pairs with natively (heart rate, cycling speed and cadence, power, running speed and cadence, FTMS). Then the watch records the data in native workouts.
7. **Sensor ceilings rule out some fitness ideas.** [C, high]
   - The barometer updates only every 10 to 80 s, so variometers and skydiving altimeters don't work. Two developers abandoned their projects.
   - No raw PPG, HRV or RR intervals.
   - No numeric depth API, even though the T-Rex 3 has a dive sensor.
   - Accelerometer and gyroscope work only in the foreground.
   - The T-Rex 3 has **no speaker**: only buzzer and vibration, or Bluetooth headphones for media.
8. **The ecosystem is small but reviving in 2026.**
   - Discord: about 1,858 members, about 75 online. Forum answer rate is low (in 2026 so far, 9 of 36 Q&A threads were answered).
   - New GitHub repos mentioning "zepp os" roughly tripled from 2025 to 2026, much of it AI-assisted.
   - Tooling is actively maintained (zeus-cli 1.9.x, simulator 2.1.x with native Apple Silicon builds, device-types 4.0.0, docs now ship `llms.txt`).
   - Developer relations, the docs and the store pipeline lag behind.
   - The T-Rex 3 gets software support until **September 2027**.

---

## 1. The T-Rex 3 platform version, and what Zepp OS 6 changed

### 1.1 Evidence

| Source | T-Rex 3 (`deviceSource` 8716544 / 8716545 / 8716547) | Tag |
|---|---|---|
| Docs device list (live page and local clone, 2026-07-17): [device-list](https://docs.zepp.com/docs/reference/related-resources/device-list/) | Latest API_LEVEL **4.0**, Zepp OS **4.5**, SecondaryWidget **NO** | [V], but out of date |
| Zeus CLI device registry: [devices.json](https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json) (fetched 2026-09-28) | `os.version` **"6.0"**, `apiLevel` **"4.4"**, `apiLevelLimitMin` "1.0", `apiLevelLimitMax` "4.4". Codename "Matterhorn", chip vendor "ZPS", `productId` 133. Capabilities: gps, magnetometer, gyroscope, accelerometer, altimeter. `voice: true`, `nfc: true` | [V] |
| Same registry, T-Rex 3 Pro 48 mm | Zepp OS 6.0, API 4.4. The docs say 4.2 / 5.0 | [V] |
| melianmiko's device list JSON: [ZeppOS-DevicesList](https://github.com/melianmiko/ZeppOS-DevicesList) (updated 2026-09-25) | T-Rex 3 `osVersion` 4.4.0, `apiVersion` 4.0.0 | [C], mixed |
| Forum #504 (2026-04-26): [discussion](https://github.com/orgs/zepp-health/discussions/504) | Developer reports "Zepp OS API Level: 4.2, Device: Amazfit T-Rex 3" (after Zepp OS 5) | [C] |
| Forum #564 (2026-09-12): [discussion](https://github.com/orgs/zepp-health/discussions/564) | T-Rex 3 (`productId` 133) on Zepp OS 6. Device JS runtime `jsrt-4.5.0-release.2-405`, phone side runtime `side-4.3.0-release.1-403` | [C], high |

**Firmware timeline for the T-Rex 3** [V: news and vendor posts]:
- Zepp OS 5, reported as software 4.1.5.1: [Notebookcheck](https://www.notebookcheck.net/Amazfit-T-Rex-3-finally-gets-Zepp-OS-5-0-in-new-update.1170814.0.html). Vendor note: [Amazfit Dec 2025](https://us.amazfit.com/blogs/product-update/t-rex-3-december-2025-software-updates).
- 4.3.8.2: the T-Rex 3 joins the T-Rex 3 Pro firmware track (Feb 2026).
- 4.4.2.3 (Feb 2026).
- 4.10.5.1 (June 2026): [G&W](https://gadgetsandwearables.com/2026/06/24/amazfit-balance-t-rex-big-update/).
- **6.2.104.6: Zepp OS 6 (2026-07-22)**: [G&W](https://gadgetsandwearables.com/2026/07/22/amazfit-t-rex-3-pro-ultra-2-zepp-os-6-update/).
- **6.3.25.7 (2026-09-03)**: [G&W](https://gadgetsandwearables.com/2026/09/03/amazfit-t-rex-3-pro-ultra-2-update-6-3-25-7/).

[I] Two things are unclear:
- The `-405` suffix in #564 suggests the runtime build could report 4.5. In the side-service boot log in #478 the suffix is `apiLevelNum` (307 means API 3.7).
- The registry's `updateTime` field doesn't track value changes. The T-Rex 3 entry says 2024-12-16 but already shows OS 6.0.

**Action:** on the physical watch, log `getSystemInfo()` (it returns `minAPI` and the OS version) and set `app.json` `runtime.apiVersion` accordingly.

### 1.2 What API ≥ 4.2 means on the T-Rex 3 [V: docs]

API 4.2 ([new features page](https://docs.zepp.com/docs/guides/version-info/new-features-42/)) adds:
- The Keyboard API, with T9 and simple keyboard samples in [zeppos-samples/application/4.2](https://github.com/zepp-health/zeppos-samples/tree/main/application/4.2).
- `media` Player `seek()`.
- `Workout.getWorkoutTrackNavInfo()`, which returns `remainDistance`, `turnDistance`, `turnType`, `isYaw`/`yawDistance` (off-route).
- `Workout.getUserHrZoneSettings()`.
- `getDeviceInfo().uuid`.

**The docs have no "what's new" page for 4.3 or 4.4.** Only one API page in the whole tree mentions 4.3 (Player). Everything newer than 4.2 is effectively undocumented. [V]

The 2026 documentation work mostly back-filled older capabilities, all tagged API 3.0: crypto (AES/CRC/Digest/ECDSA/PUF), `ShareLocalStorage`, `ShareTypedStorage`, share-storage FileSystem, TypedStorage, and splitting Player and Recorder into separate pages ([PR #97](https://github.com/zepp-health/zeppos-docs/pull/97), 2026-07-17). [V]

The same period also brought TIME_PICKER, VIEW_CONTAINER and screen-adaption updates ([PR #87](https://github.com/zepp-health/zeppos-docs/pull/87), [#94](https://github.com/zepp-health/zeppos-docs/pull/94)) and an AI-oriented `llms.txt` ([PR #93](https://github.com/zepp-health/zeppos-docs/pull/93), live at [docs.zepp.com/llms.txt](https://docs.zepp.com/llms.txt)). [V]

### 1.3 Zepp OS 6: changes, regressions and bugs reported by developers

| Item | Details | Tag |
|---|---|---|
| **`Music` sensor regression on the T-Rex 3** | After the update to Zepp OS 6: `audInit/audPlay/audPause` return `32`, state is always empty, and **`checkAvailable()` and `start()` crash the watch**. It worked on the previous firmware with both iPhone and Android. No response from Zepp yet. [#564](https://github.com/orgs/zepp-health/discussions/564), 2026-09-12 | [C], high (detailed repro) |
| Barometer on Zepp OS 6 (Balance 3, API 4.4) | `getAirPressure()` now returns **fractional hPa** (993.230, about 1 cm of resolution) instead of whole hPa. Refresh is still "once every few tens of seconds". `onChange` never fires. Still no `setFreqMode`. [#526 comment](https://github.com/orgs/zepp-health/discussions/526), 2026-08-30 | [C], high. [I] Probably the same on the T-Rex 3, which runs the same OS 6 generation |
| Workout Extension to phone messaging | On the T-Rex 3 Pro with firmware **6.3.13.5**, `this.request()`/`sendAppMessage()`/`messaging.peerSocket` inside a DataWidget fail with "NOT A FUNCTION". The official sample `running-pace-master-with-side-service` "is not functional on the T-Rex 3 Pro". [#554](https://github.com/orgs/zepp-health/discussions/554), 2026-08-28, no staff reply | [C], medium-high (see the conflicting evidence in §4.4) |
| Store build pipeline | Since 2026-08-24 the Zepp store has served a **re-built** package for 26 devices, the T-Rex 3 included. It was built with `zpm 3.2.13-beta`, discards the js2bin bytecode, and ships plain JS that is 2.47× larger. The same submission reaches 3 newer devices untouched. The developer suspects this causes black-screen launches on the Bip 6 and Active 2. [#568](https://github.com/orgs/zepp-health/discussions/568), 2026-09-22 | [C], high (checksums and URLs given) |
| Tooling lags new OS versions | `zeus create` crashed on macOS 26.5 / M4 Pro because the template map lacked newer API levels. The user patched `watchfaceTemplateChoices` in node_modules to fix it ([#544](https://github.com/orgs/zepp-health/discussions/544), 2026-08). "zeus-cli does not support 5.0 for now" (Bip Max, [#520](https://github.com/orgs/zepp-health/discussions/520)). Watchface templates exist only for API 1.0/2.0, although watchfaces do run on API 3/4 ([#523](https://github.com/orgs/zepp-health/discussions/523), T-Rex 3) | [C] |
| Install failures on OS 6 devices | "Send package to device failed" / "Download failed, error code: null" on the Bip Max (OS 6, API 4.4): [#550](https://github.com/orgs/zepp-health/discussions/550). Root causes found in similar threads: a QR code generated for the wrong device ([#552](https://github.com/orgs/zepp-health/discussions/552), staff answer), or **a phone signed in with Google while zeus uses email and password, which the backend treats as two accounts** ([#552](https://github.com/orgs/zepp-health/discussions/552)). A QR-install bug in Zepp app 10.8.0 is also mentioned there | [C] |
| Background service confusion on OS 6 | On the Bip Max (OS 6) a registered App Service never ran `onInit`, and the watch said "only apps downloaded from the app store can run in background". A community expert says preview installs normally *can* run in the background ([#551](https://github.com/orgs/zepp-health/discussions/551)). Unresolved | [C] |

### 1.4 Zepp OS 6 on the T-Rex 3: what users got

- **Features** [V: news]: Training Calendar and Training Library on the watch, live HybridCharge (replaces BioCharge) in workouts, equipment/gear tracking, a shortcut key that launches a chosen workout, HRV sync to Apple Health, and more notification personalisation (6.2.104.6).
- **Sensors and training** [V: news]: FTMS indoor-trainer support, deeper HYROX analysis with the Helio Strap Pro, music and playlist management from the phone, and "Athlete Defaults" (6.3.25.7).
- **Coming** [V: news]: Strava Live Segments for the T-Rex 3 in November 2026, requiring a paid Strava plan ([the5krunner](https://the5krunner.com/2026/09/23/strava-live-segment-amazfit/)). iOS notification forwarding with actions and replies works **in the EU only**, on iOS 26.5+ ([G&W](https://gadgetsandwearables.com/2026/06/06/ios-notification-forwarding-amazfit/)).
- **Launcher** [V/C]: the T-Rex 3, T-Rex 3 Pro, Ultra 2 and Balance 2 got Zepp OS 6 **without the new "Launcher 2.0"**. They keep the horizontal widgets, because "users missed the horizontal widgets" ([G&W, 2026-08-20](https://gadgetsandwearables.com/2026/08/20/amazfit-zepp-os-6-new-launcher-missing/)). Zepp's [compatibility chart](https://os.zepp.com/compatibility-zepp-os-6) still ticks "New Launcher" for the T-Rex 3. [I] Where third-party entry points live (app list, shortcut cards, widgets) may still move during the project. Keep the app's launch path simple, from the app list.
- **Other user-facing issues on T-Rex 3 firmware** [C]: over-detection of "awake" periods in sleep on a new T-Rex 3 ([#531](https://github.com/orgs/zepp-health/discussions/531), 2026-07). A 2025 battery-drain wave linked to active HR monitoring ([G&W, 2025-01](https://gadgetsandwearables.com/2025/01/20/amazfit-t-rex-3-battery-drain/)). DC Rainmaker, January 2025: power meter pairing works only sometimes, power data doesn't reach Strava, and "most of the software features seem only surface-level finished" ([DCR review](https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html)).

### 1.5 Support window [V]

The T-Rex 3 software support window was **extended to September 2027** (36 months from its September 2024 launch). It now shares a firmware track with the T-Rex 3 Pro, which is supported to September 2028 ([G&W](https://gadgetsandwearables.com/2026/02/04/amazfit-t-rex-3-firmware-extension/), [the5krunner policy table](https://the5krunner.com/2026/02/05/amazfit-update-policy-changes/)). An earlier Notebookcheck headline about "final updates in 2026" is superseded.

### 1.6 T-Rex 3 hardware facts that affect apps

- **No loudspeaker**, only a beeper and vibration. It has a **microphone** (used by Zepp Flow). [C/V: [DCR](https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html), [the5krunner specs](https://the5krunner.com/specs/amazfit/t-rex-3/)] Voice-cue coaching apps therefore need Bluetooth headphones (media playback supports them) or haptics.
- **Wi-Fi 2.4 GHz exists but apps can't use it.** Zepp staff: controlling Wi-Fi through the API is "not yet available" ([#509](https://github.com/orgs/zepp-health/discussions/509)). A user request to run [ZeppOS-HTTP-Buttons over the watch's Wi-Fi](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/10) is still open.
- BLE 5.2, **no ANT+**, about 26 GB usable storage, 64 MB PSRAM (per spec listings; [C]), a 700 mAh battery (up to 27 days), and freediving to 45 m (the depth sensor is **not** exposed numerically; see §4.5).
- 480×480 round screen and 4 physical keys [V: docs]. On the T-Rex 3 the Zeus registry gives `iconSize` 124, against 248 on the Balance 3.

---

## 2. Open-source Zepp OS apps and libraries (prior art)

### 2.1 How big is the open-source scene?

- The official [awesome-zeppos](https://github.com/zepp-health/awesome-zeppos) is small (about 30 entries) and **stale**: last merge 2024-11-07, mostly API 1.0/2.0-era apps. [V]
- GitHub repos created each year (search `"zepp os"` / `zeppos`): 2022: 20/31, 2023: 37/67, 2024: 32/56, 2025: 36/33, **2026 through September: 121/95**. [V: GitHub search API]
  - [I] The 2026 jump coincides with AI-assisted development. Several 2026 repos are agent "skills" and knowledge bases for Zepp OS: [osben/zepp-os-skills](https://github.com/osben/zepp-os-skills), [Fezze/zepp-miniapp-builder](https://github.com/Fezze/zepp-miniapp-builder), [FelipeRicardo5/zeppos-agent-knowledge-base](https://github.com/FelipeRicardo5/zeppos-agent-knowledge-base), [maxiges/ZeppOS-AI-Doc](https://github.com/maxiges/ZeppOS-AI-Doc), [bug-breeder/zeppos-app-template](https://github.com/bug-breeder/zeppos-app-template). Zepp itself added `llms.txt`.
  - It also coincides with the 2025–26 hackathon and new devices.
- Nineteen repos list T-Rex 3 `deviceSource` values explicitly in `app.json`. Most modern apps instead target every round screen with `"platforms":[{"st":"r"}]`, which includes the T-Rex 3. [V: code search]

### 2.2 Category map (selected; **bold** = deep dive in §2.3)

| Category | Projects (last push) |
|---|---|
| Fitness / workout | **Liftosaur companion** (2026-09), **RunDeck** (2026-09, source-available), **YeRun-Trail** (2026-06), [66Bunz knots speed WE](https://github.com/66Bunz/zeppos-we-default-speed-in-knots) (2026-05), [JMontes84/Enduro-Time-Tracker](https://github.com/JMontes84/Enduro-Time-Tracker) (2026-02), [LuizzTrevisan/zepp-workout-rounds-counter](https://github.com/LuizzTrevisan/zepp-workout-rounds-counter) (WE, 2024 hackathon winner), [XiaomaiTX/zeppos-Tabata](https://github.com/XiaomaiTX/zeppos-Tabata) (WE, 2024), [trystan2k/padelbuddy](https://github.com/trystan2k/padelbuddy) (2026-06), [ether-strannik/zeppos-smart-timers](https://github.com/ether-strannik/zeppos-smart-timers) (API 4.0/4.2, 2026-04), [mohansella/zepp-hr-zone](https://github.com/mohansella/zepp-hr-zone) (T-Rex 2, 2024), **gabera/altimeter-zeppos** (abandoned 2026-06) |
| Outdoor / navigation | **YeRun-Trail**, [ring-amazfit/Ring-Map](https://github.com/ring-amazfit/Ring-Map) (turn-by-turn from Android map notifications, 2026-07), [Gared/zeppos-map-creator](https://github.com/Gared/zeppos-map-creator) (offline map builder in Docker, 2026-07), [CuberQAQ/asuka-map](https://github.com/CuberQAQ/asuka-map) (tile map engine, 2025-07), [yoadwo/Swell](https://github.com/yoadwo/Swell) (surf forecast, API 4.2) |
| BLE / hardware-connected | **zepp-health/easy-ble** (+ ESP32 example), **eried/eucplanet** (electric unicycles; T-Rex 3-tested), **JovannMC/ZeppSlime** (IMU to SlimeVR), [3125589/yunmai-zeppos](https://github.com/3125589/yunmai-zeppos) (direct BLE to a Yunmai scale, 2026-07), [HuaweiDonor/zepp-starline](https://github.com/HuaweiDonor/zepp-starline) (car alarm via phone), Libre 2 CGM direct BLE (closed source, [#559](https://github.com/orgs/zepp-health/discussions/559)), Engo 2 HUD workout extension (closed source, [#433](https://github.com/orgs/zepp-health/discussions/433)) |
| Health / data export | [Anduin2017/SleepAgent](https://github.com/Anduin2017/SleepAgent) (periodic metrics POST), **davidepalleschi/zepp2hass** (62★), [bigdigital/zeppos_watchdrip_app](https://github.com/bigdigital/zeppos_watchdrip_app) (xDrip glucose), [adamd9/zeppos3-nightscout](https://github.com/adamd9/zeppos3-nightscout), [szajbergyerek/SmartWatchDataCollector](https://github.com/szajbergyerek/SmartWatchDataCollector) |
| Home automation | **AguacatecHA/HA_Companion** (integration side), [ga2mer/ha-zepp](https://github.com/ga2mer/ha-zepp) (125★, API 1.0), [yardeff/ha-zepp](https://github.com/yardeff/ha-zepp), **giovaboy/ZeppOS-HTTP-Buttons** (40★), [giovaboy/ZeppOS-zhue](https://github.com/giovaboy/ZeppOS-zhue) (Hue, hackathon silver), [LeKovr/hocon-zepp](https://github.com/LeKovr/hocon-zepp) (WiZ lamps) |
| Messaging / AI | [griffi-gh/zepp-fediclient](https://github.com/griffi-gh/zepp-fediclient) (Mastodon), [melianmiko/ZeppOS-AiChat](https://github.com/melianmiko/ZeppOS-AiChat), [rubenalejandrocalderoncorona/chat-ai-zepp](https://github.com/rubenalejandrocalderoncorona/chat-ai-zepp) (mic to backend), [hdsysdev/ZeppClaw](https://github.com/hdsysdev/ZeppClaw) (voice client), [NVCDevelopmentTeam/Zepp-OS-ScreenReader](https://github.com/NVCDevelopmentTeam/Zepp-OS-ScreenReader) |
| Productivity | [melianmiko/ZeppOS-Tasks](https://github.com/melianmiko/ZeppOS-Tasks) (Google Tasks OAuth), [ZoLArk173/Authenticator](https://github.com/ZoLArk173/Authenticator) / [Lisoveliy/totpfit](https://github.com/Lisoveliy/totpfit) (TOTP), [michalowskil/my-checklists](https://github.com/michalowskil/my-checklists), [YellowCat-Code/HabitiSync](https://github.com/YellowCat-Code/HabitiSync), [Tyler-Petrov/wrist-track](https://github.com/Tyler-Petrov/wrist-track) (Toggl) |
| Games | [Berezza98/zepp-pong](https://github.com/Berezza98/zepp-pong), [sirAvent/color-switch](https://github.com/sirAvent/color-switch), [feistylobster123/zepp-doom](https://github.com/feistylobster123/zepp-doom) (raycaster built from a widget pool, no canvas), [lon21/bad-apple-zepp-os](https://github.com/lon21/bad-apple-zepp-os) |
| Libraries / tooling | **zepp-health/zml**, [zepp-health/visual-logger](https://github.com/zepp-health/visual-logger) (on-screen logs; 1.5.0 adds AppSide/Settings logs), [zepp-health/easy-storage](https://github.com/zepp-health/easy-storage) (incl. EasyTSDB), [zepp-health/easy-media](https://github.com/zepp-health/easy-media), [zepp-health/polyglot](https://github.com/zepp-health/polyglot) (i18n), **silver-zepp/zeppos-autogui**, [XiaomaiTX/zeppos-fx](https://github.com/XiaomaiTX/zeppos-fx) (animation), [XiaomaiTX/zeppos-reactive](https://github.com/XiaomaiTX/zeppos-reactive), [CuberQAQ/asuka-ui](https://github.com/CuberQAQ/asuka-ui), [melianmiko/ZeppPlayer](https://github.com/melianmiko/ZeppPlayer) (unofficial emulator; no side service), [melianmiko/zmake](https://github.com/melianmiko/zmake), [melianmiko/zepp_selfhost](https://github.com/melianmiko/zepp_selfhost) (.zab patch/split for self-hosting), [zdunex25/zeppos-aes](https://github.com/zdunex25/zeppos-aes), [silver-zepp/simulator-se](https://github.com/silver-zepp/simulator-se) (patched simulator logs), [silver-zepp/zeppos-simulator-vm](https://github.com/silver-zepp/zeppos-simulator-vm) (ready-made simulator VM) |

(WE = Workout Extension. Note that several "community" libraries, including easy-ble, easy-storage, VisLog, AutoGUI and polyglot, are by **silver-zepp, a Zepp Health software architect** ([G&W](https://gadgetsandwearables.com/2026/07/31/amazfit-watchfm-live-radio-streaming/)), and now live under the `zepp-health` org. They are semi-official. [V])

### 2.3 Deep dives: the 15 most instructive projects

**1. [eried/eucplanet](https://github.com/eried/eucplanet): electric unicycle telemetry (MIT, 25★, pushed 2026-09-28).** Hardware-connected. **Tested on the T-Rex 3** (API 4.0 at the time).
- Architecture (quoted in [docs/AMAZFIT_SETUP.md](https://github.com/eried/eucplanet/blob/main/docs/AMAZFIT_SETUP.md)): *"Zepp OS gives a third-party phone app no way to talk to a watch mini program directly."* The watch page polls. The Side Service fetches `http://127.0.0.1:28193/state` from an Android app (the Zepp app allows cleartext loopback HTTP) and passes the JSON to the watch over BLE. Controls travel back as `POST /control`.
- The phone can't push. One-shot events are queued into the next poll answer.
- Rates: 1, 2 or 4 frames/s. The simulator sustains about 7/s.
- Limitations the author lists against Wear OS and Garmin:
  - no remote auto-start;
  - no whole-page rotation;
  - the Zepp app must stay alive, or the "battery optimisation that kills the Zepp app also stops the dial";
  - `BUTTON.setProperty` is ignored unless it carries x/y/w/h.
- **Reveals:** the reference pattern for *phone-hosted hardware*: the phone app talks to the device, and the watch gets a pull-only display at a few Hz. [C, high]

**2. [zepp-health/easy-ble](https://github.com/zepp-health/easy-ble): BLE central library (npm `@silver-zepp/easy-ble` 1.7.8; repo 2025-06).**
- Wraps `@zos/ble` `mst*` calls: scan, connect, profile generation from a `{service:{char:[desc]}}` map, and a queued read/write/notify layer.
- Includes an **ESP32 peripheral example** and a parser for standard heart-rate (0x180D/0x2A37) and battery (0x180F/0x2A19) data.
- `pair()` is flagged "might ... cause crashes".
- Zepp staff tell developers to use it to avoid lifecycle pitfalls ([#536](https://github.com/orgs/zepp-health/discussions/536)).
- **Reveals:** the watch can be a GATT central to custom hardware, with a page-only lifecycle. [V: README, code]

**3. [andrejd1/rundeck](https://github.com/andrejd1/rundeck): one-screen running dashboard as a Workout Extension (source-available, paid; 2026-09-24).** The most precise public account of what extensions can see:
- Pace, distance, duration, cadence, average pace, total ascent and altitude come from `getSportData`. Power works through an *undocumented* `getSportData("power")`.
- Descent, lap ascent, vertical speed, max speed, stride, steps, %HRmax, training effect, training load and temperature are "values the watch computes but does not hand to extensions". The workaround is to overlay a `SPORT_DATA` widget that draws the value itself.
- **GAP, vertical oscillation and ground contact time are not exposed at all.**
- "Zepp OS gives extensions no access to planned structured workouts."
- "Native auto-laps are not visible to extensions." RunDeck runs its own auto-lap.
- HR zones come from `getUserHrZoneSettings` (4.2+).
- Monetisation: a trial, then a €6 **Polar.sh** license key validated from the Side Service. The author researched Polar.sh, Lemon Squeezy, Gumroad and Paddle in September 2026.
- Build gotcha: `zeus build` compiles *every* `.js` file in the project.
- **Reveals:** the realistic ceiling of workout extensions, and a workable way to monetise. [C, high]

**4. [PreciselyWrong/Liftosaur-ZeppOs-Companion](https://github.com/PreciselyWrong/Liftosaur-ZeppOs-Companion): strength training (MIT; 2026-09-27).**
- Two apps from one codebase: a standalone companion, and **"Lifto Workout", a Workout Extension that runs inside native Strength Training / Free Training**, so native activity recording continues.
- Data path: `Watch UI + durable journal → ZML/BLE → phone Side Service → HTTPS → Liftosaur Cloud`. API keys stay on the phone.
- "Workout Extension callbacks pause when Lifto loses focus... background alert delivery is not confirmed."
- Loading in Strength Training is confirmed at API level 400 on the Active 2.
- **Reveals:** a solid offline-first sync design for gym workouts on the watch. It is the closest prior art to a fitness project like ours. [C, high]

**5. [1445688048/YeRun-Trail](https://github.com/1445688048/YeRun-Trail): trail-race checkpoint planner (2026-06).**
- A Workout Extension with page, app-side and setting modules, targeting API 4.3.
- GPX is downloaded and parsed in the Side Service. Race-plan images are parsed by an LLM (Alibaba Qwen) from the Settings App.
- The race package is pulled to the watch over BLE in **3,600-byte chunks** and saved as a local JSON file.
- The extension overlays GPS position, current and next checkpoint, remaining distance, and delta against plan.
- It bundles an ES6 Promise polyfill.
- **Reveals:** heavy computation belongs on the phone. The extension only shows precomputed data. [C]

**6. [JovannMC/ZeppSlime](https://github.com/JovannMC/ZeppSlime): watch as a SlimeVR IMU tracker (2026-04).**
- Accelerometer and gyroscope with `setFreqMode(1)`, sent every **40 ms (25 Hz)** as BLE writes from the **watch acting as central** to a Tauri desktop app acting as **peripheral**, which relays to SlimeVR over UDP.
- The code comments explain why: *"UDP communication not possible with ZeppOS"*. The watch-as-peripheral design "can only be worked on once zeppos supports ble peripheral mode".
- **Reveals:** a pattern for streaming raw sensor data off the watch, and the absence of peripheral mode. [V: code]

**7. [zepp-health/zml](https://github.com/zepp-health/zml): messaging and HTTP layer (npm 0.0.43, 2026-01).**
- Almost every modern app uses it: `this.request`/`onRequest`, `this.call`/`onCall`, `httpRequest`, `BaseApp/BasePage/BaseSideService`.
- Internals [V: src]: `MESSAGE_SIZE = 3600` bytes, handshake timeout 5 s, request timeout 60 s, side messaging timeout 10 s. Requires API ≥3.0 (≥3.6 since 0.0.28).
- Open issues, all unanswered:
  - "Exceeded maximum queue limit(5)", fixed only by reinstalling the Zepp app ([#9](https://github.com/zepp-health/zml/issues/9));
  - the side service can't `call` until the device has sent a `request` ("similar to browser to server"), and a workaround handshake fails about 50% of the time ([#3](https://github.com/zepp-health/zml/issues/3));
  - `httpRequest` inside an App Service ([#10](https://github.com/zepp-health/zml/issues/10), [#2](https://github.com/zepp-health/zml/issues/2): "hidden usage `AppService(BasePage({}))`" still raised "not a function").
- **Reveals:** messaging works, but is request/response, fragile, and effectively without a maintainer. [V, C]

**8. [SashaCX75/Weather-service](https://github.com/SashaCX75/Weather-service): background weather fetch (2026-07).** The reference **"alarm-driven App Service"** pattern:
- `@zos/alarm` `REPEAT_MINUTE` wakes a short-lived service.
- It fetches through the Side Service, calls `appService.exit()` on every path, and raises notifications.
- A developer said this change made their always-on metrics uploader run "24/7 without interruption" after continuous services kept dying overnight ([#393](https://github.com/orgs/zepp-health/discussions/393)).
- **Reveals:** the dependable way to do periodic background work. [C, high]

**9. [silver-zepp/zeppos-autogui](https://github.com/silver-zepp/zeppos-autogui): fast GUI prototyping, plus two key examples (2026-06).**
- `webserver-data-extraction`: a phone- or PC-side server, optionally through ngrok, as a data sink.
- `zeppos-3.0-wf-app-comms`: a **watchface reading data an app wrote**. Watchfaces can't have a Side Service ([#330](https://github.com/orgs/zepp-health/discussions/330)).
- Zepp now also documents `ShareLocalStorage`/`ShareTypedStorage` (API 3.0) for sharing data between apps and watchfaces.
- **Reveals:** a way to put your data on a watchface, since third-party complications don't exist. [V]

**10. [davidepalleschi/zepp2hass](https://github.com/davidepalleschi/zepp2hass) + [AguacatecHA/HA_Companion](https://github.com/AguacatecHA/HA_Companion) + AmazHA (closed source): Home Assistant.**
- zepp2hass (62★, the most-starred new repo of 2026) is the HACS side. A store watch app POSTs health metrics to an HA webhook about every minute; the integration rate-limits to 30 requests/60 s.
- HA Companion issues show the **"only one background app" wall** in practice: "BIP6 allows me to have only one app with BG updates" ([#6](https://github.com/AguacatecHA/HA_Companion/issues/6), [ha-zepp #31](https://github.com/ga2mer/ha-zepp/issues/31)). They also show fragile health-push setup on a T-Rex 3 ([#8](https://github.com/AguacatecHA/HA_Companion/issues/8)).
- AmazHA: paid one-time unlock, "LAN-first failover" over BLE through the phone, about 4,000 downloads by July 2026 ([HA forum](https://community.home-assistant.io/t/amazha-a-native-amazfit-zepp-os-companion-app-for-home-assistant/1014421)).
- **Reveals:** a real paying niche, and that only one app can hold the background slot. [C]

**11. [giovaboy/ZeppOS-HTTP-Buttons](https://github.com/giovaboy/ZeppOS-HTTP-Buttons): configurable HTTP actions (40★; API target 4.0; 2026-07).**
- Settings App driven.
- Open issues are a list of typical walls: response timeouts ([#17](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/17)), basic auth crashing the watch ([#14](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/14)), long responses blanking a modal ([#9](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/9)), slow start ([#6](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/6)), and a request to use the watch's Wi-Fi ([#10](https://github.com/giovaboy/ZeppOS-HTTP-Buttons/issues/10)).

**12. [Anduin2017/SleepAgent](https://github.com/Anduin2017/SleepAgent): periodic health uploader (App Service + app-side; 2026-02).**
- Frequently forked and cited on the forum.
- A fork found that **calling `sleep.getSleepingStatus()` inside an App Service kills the service when the user falls asleep**. Removing that call fixed it ([#406](https://github.com/orgs/zepp-health/discussions/406), 2025-03).
- **Reveals:** firmware bugs specific to certain sensors in the background. [C, high]

**13. [3125589/yunmai-zeppos](https://github.com/3125589/yunmai-zeppos): Balance app connecting straight to a Yunmai BLE scale (2026-07).**
- A minimal, single-page BLE central app that parses a proprietary protocol.
- Zepp's own "Bluetooth Scale Assistant" and "IoT mini apps" do the same for supported accessories ([os.zepp.com/accessories](https://os.zepp.com/accessories)).
- **Reveals:** direct BLE to consumer devices is realistic from a page.

**14. [gabera/altimeter-zeppos](https://github.com/gabera/altimeter-zeppos): skydiving altimeter, abandoned (2026-06).**
- The author: "three months without a real path forward on faster/forced barometer readings, so I sold my Amazfit and I'm going to try a Garmin" ([#508](https://github.com/orgs/zepp-health/discussions/508), 2026-08-19).
- **Reveals:** barometer-driven apps (variometers, skydiving, fast altitude) are not feasible today. [C, high]

**15. [zepp-health/zeppos-samples](https://github.com/zepp-health/zeppos-samples): the official samples (222★; 2026-01).**
- API 4.0 samples: hello-world, calories, fetch-api, todo-list, 4.0-feature.
- 4.2 keyboards.
- Workout extension samples (3.5): empty, running-data-assistant, running-pace-master, running-pace-master-with-side-service.
- Caveats [C]:
  - several 2025–26 posts report samples not working as-is: the 4.0 todo-list shows a blank screen ([#477](https://github.com/orgs/zepp-health/discussions/477)), and the settings sample shows an empty page ([#470](https://github.com/orgs/zepp-health/discussions/470));
  - the "with-side-service" extension sample doesn't work on the T-Rex 3 Pro ([#554](https://github.com/orgs/zepp-health/discussions/554));
  - a frequent root cause is forgetting `npm i @zeppos/zml` ([#472](https://github.com/orgs/zepp-health/discussions/472)). RunDeck notes that without it "every page opens black on the watch".

Honourable mentions:
- [bigdigital/zeppos_watchdrip_app](https://github.com/bigdigital/zeppos_watchdrip_app): the phone-localhost-server pattern for glucose apps, `http://localhost:29863/info.json` ([#330](https://github.com/orgs/zepp-health/discussions/330)).
- [melianmiko/ZeppOS-Tasks](https://github.com/melianmiko/ZeppOS-Tasks): OAuth in the side service; built at API 1.0 to reach the most devices.
- [mohansella/zepp-hr-zone](https://github.com/mohansella/zepp-hr-zone): keep-screen-on recipe `pauseDropWristScreenOff({duration:0}); pausePalmScreenOff({duration:0}); setWakeUpRelaunch({relaunch:true})` ([#396](https://github.com/orgs/zepp-health/discussions/396)).

---

## 3. Notable Zepp App Store apps (prior art)

Store size: "200+ JS Mini Programs" (Zepp, October 2023, [#261](https://github.com/orgs/zepp-health/discussions/261)), "hundreds" today. No official 2026 count found. Zepp promotes new third-party apps through regular press drops ("Nine new Mini Apps", "Seven new Mini Apps", and so on: [Notebookcheck](https://www.notebookcheck.net/Nine-new-Amazfit-Mini-Apps-now-available-for-smartwatch-users.1253503.0.html), [gsmgotech](https://www.gsmgotech.com/2026/05/zepp-health-drops-five-new-amazfit.html)). [V/C]

| Area | App (developer) | What it shows is possible | Tag |
|---|---|---|---|
| Top charts | **Remotify** (music remote for Spotify) is still #1 in 2026 ([Notebookcheck, 2026](https://www.notebookcheck.net/Amazfit-smartwatches-get-new-heart-rate-related-Mini-App.1229290.0.html)). **Navigation Wear** relays Android Google Maps notifications to the watch through a companion Android app. Other 2024 top-10 entries: Calorie Intake, Water Time, Calculator, AI Chat, Tic-Tac-Toe ([G&W 2024](https://gadgetsandwearables.com/2024/06/24/amazfit-best-apps/)) | Phone-companion apps dominate. The watch is a remote display | [C] |
| Camera / GoPro | **GoPro Camera Control** (launch partner, HERO9+) through Zepp App → Store ([press release](https://www.zepp.com/press-release/gopro-camera-control-to-be-one-of-the-first-new-apps-for-zepp-os-powered-amazfit-smartwatches)). The accessory list adds DJI Osmo Action 4/5 Pro ([accessories](https://os.zepp.com/accessories)). AppMosaic "Camera Remote Watch" needs an Android app ([#421](https://github.com/orgs/zepp-health/discussions/421)). Built-in Camera Remote can't be launched from third-party code on the Bip Max ([#572](https://github.com/orgs/zepp-health/discussions/572)) | BLE central to cameras works | [V/C] |
| BLE health / IoT accessories | Scale Assistant; CORE body temperature; Kinsa; OMRON and iHealth blood pressure; Sonmol peak flow; Moxy/Train.Red SmO₂; Govee thermohygrometer; AUTENS air quality; Sonos control, all through "third-party app" mini apps. **The T-Rex 3 is listed for scales, body temperature, BP, peak flow, HR straps, cycling sensors, power meters, SmO₂, environment sensors and action cameras. FTMS rowing is Pro/Ultra 2 only** ([accessories](https://os.zepp.com/accessories)) | Partners ship BLE-central mini apps for real devices | [V] |
| Native sensors, not apps | HR straps (standard HR profile), cycling speed/cadence/power, **Stryd** running power, FTMS indoor trainers (Sept 2026 firmware). DCR saw pairing reliability problems with a Quarq power meter | Standard profiles get native recording and sync. This is the path into workout files (§6) | [V/C] |
| Home Assistant | HA Companion (Aguacatec; 2024 hackathon bronze; $1.50 premium), AmazHA (paid unlock), HA Switches (IAP about $2–2.50), Zepp2Hass (+ Alternative), WristLink (Tasker), Voice Bridge (voice notes to Claude/HA) ([gsmgotech](https://www.gsmgotech.com/2026/05/zepp-health-drops-five-new-amazfit.html)) | A lively niche. Side-service HTTP to the LAN works | [C] |
| Strength / HIIT / timers | **LiftGo** (templates, sets/reps/weights; "most popular new Mini App" in its drop), Lifto (Liftosaur), SaunaNow (timer + HR), Workout Rounds Counter (WE), Tabata WE, CaliForge (calisthenics, planned paid), Smart Timers | Gym logging works as standalone apps or extensions, but can't write into native workout records ([#555](https://github.com/orgs/zepp-health/discussions/555)) | [C] |
| Running / outdoor | **GRun** (custom running dashboard; 2025 hackathon silver), **Team Trek** (group location "tactical radar"; 2025 gold), **Apnea Tables** (breath-hold training; bronze), **HAMGIS** (GPS surveying, GIS export; gold), RunDeck, Free Compass / Pixel Compass S / Skydiving Helper (WEs from 2024) ([2025 winners](https://developer.zepp.com/os/2025/hackathon-2025-winners), [2024 winners](https://developer.zepp.com/os/hackathon-2024-winners)) | Custom workout screens and GPS tools are the sweet spot | [V] |
| Live tracking / segments | No third-party "live tracking" app found. **Strava Live Segments** arrives as a *first-party* feature (T-Rex 3, November 2026). Komoot is a native integration ([Komoot](https://support.komoot.com/hc/en-us/articles/10449260071450-Connect-Amazfit-to-komoot)) | Partner integrations happen in firmware, not through the mini-app API | [V/I] |
| Media | **WatchFM** (silver-zepp): internet radio *chunked* through the phone, about 5 buffered chunks of 1–2 minutes each, API ≥4.0, round screens only, "minimum volume 1% ... the way to ensure the app is active" ([silverdeveloper](https://silverdeveloper.com/zepp-launches-online-streaming-radio/)) | Bulk file transfer is fine. Real-time audio streaming isn't the model | [C] |

---

## 4. Developer pain points and hard limits

### 4.1 Background execution

- [V] App Service ([docs](https://docs.zepp.com/docs/guides/framework/device/app-service/)):
  - Timers (`setTimeout` and similar) are **not available**.
  - High-power sensors (**accelerometer, geolocation, gyroscope**) are **not available**.
  - `@zos/ble` is available **except APIs starting with `mst`**.
  - File writes only when the screen is off or in AOD.
  - A single-execution service (alarm, notification or system event) is limited to **600 ms**.
  - **Only one continuous App Service can run at a time.** Conflicts prompt the user to choose.
  - A continuous service needs a runtime permission prompt (`device:os.bg_service`).
- [C] In practice, `createSysTimer` in a service was stable at 5 s intervals and unstable at 500 ms ([#535](https://github.com/orgs/zepp-health/discussions/535), 2026-07). Continuous services die overnight when Bluetooth drops ([#393](https://github.com/orgs/zepp-health/discussions/393)) or when sleep APIs are called ([#406](https://github.com/orgs/zepp-health/discussions/406)). The fix is the alarm-driven single-execution pattern (§2.3 #8).
- [V/C] Zepp staff, 2025-06: "The operation of App Service depends on the watch UI, so the AOD mode needs to be turned on. However, the Bip 5 Unity watch does not support AOD yet, so tasks cannot be executed when the screen is off" ([#430](https://github.com/orgs/zepp-health/discussions/430)). [I] Other developers run background services without AOD, so this may be specific to some devices. Test App Service behaviour on the T-Rex 3 with AOD both on and off.
- [C] Foreground pages get destroyed some time after the screen goes off. Keep-alive recipes: `setPageBrightTime`, `pauseDropWristScreenOff`, `pausePalmScreenOff`, `setWakeUpRelaunch` ([#410](https://github.com/orgs/zepp-health/discussions/410), [#396](https://github.com/orgs/zepp-health/discussions/396)). Apps cannot run in AOD ([#518](https://github.com/orgs/zepp-health/discussions/518)). Sampling accelerometer and gyroscope with the screen off is only possible from a **watchface** you run yourself ([#370](https://github.com/orgs/zepp-health/discussions/370), silver-zepp).
- [V] The Sleep as Android team, integrated with Wear OS, Garmin, Pebble, Galaxy, PineTime and Polar, couldn't integrate Zepp. The blocker: "I cannot access the accelerometer from a background service" ([zeppos-docs #88](https://github.com/zepp-health/zeppos-docs/issues/88), 2026-03, no reply).

### 4.2 BLE central (the hardware angle)

- [V] Central role since Zepp OS 3 ([BLE Central guide](https://docs.zepp.com/docs/guides/framework/device/ble-central/)). **Not in App Service** (docs). Per a detailed developer report, it is also **not in watchfaces**: "mst* APIs in both Long Background Services (app-service) and Watch Face is disabled... Mini Program foreground app is required" ([#559](https://github.com/orgs/zepp-health/discussions/559), 2026-09; another developer disagreed about watchfaces).
- [C, high] **Battery numbers:** a Libre 2 CGM streamed from a foreground page costs about **13%/day** at one notification per minute, measured over 5 days. The same developer's "App-as-a-Watch-Face" setup, a foreground mini program left running in place of the watch face, reportedly lasts **7 days** on one charge ([#559](https://github.com/orgs/zepp-health/discussions/559)).
- [C, high] `mstPrepare` lifecycle ambiguity: the docs contradict each other on whether `mstBuildProfile` returns a pointer or a boolean. An Active 3 Premium **rebooted into a recovery screen** after a manual prepare. Staff: "please do not run the manual mstPrepare() path again until we have reviewed" ([#536](https://github.com/orgs/zepp-health/discussions/536), 2026-08).
- [V/C] **No BLE peripheral or advertising** for mini apps. Staff in 2023: "The system has ability to do so, but we currently don't have plan to provide it" ([#159](https://github.com/orgs/zepp-health/discussions/159)). Custom advertising "not supported for the time being" ([#379](https://github.com/orgs/zepp-health/discussions/379), [#307](https://github.com/orgs/zepp-health/discussions/307), [#311](https://github.com/orgs/zepp-health/discussions/311)).
- [V] **No Bluetooth in the simulator.** You must use a real device ([#159](https://github.com/orgs/zepp-health/discussions/159)).
- [C] Pairing: EasyBLE warns `pair()` may crash. The Libre developer did the "encrypted unlock" at the application layer instead ([#559](https://github.com/orgs/zepp-health/discussions/559)).
- [C] BLE inside Workout Extensions stops when the extension loses focus. The Engo 2 HUD developer had to re-implement data screens inside one DataWidget to keep the HUD fed, and called it "very challenging... All of the problems above don't exist on the CIQ platform" ([#433](https://github.com/orgs/zepp-health/discussions/433), 2025-06). Staff promised improvements "in the second half of the year". None are visible yet.

### 4.3 Phone link, Side Service and networking

- [V/C] No direct internet from the watch. Fetch lives in the Side Service, and, as staff confirmed in May 2026, also in the Settings App ([#510](https://github.com/orgs/zepp-health/discussions/510)).
- [C] WebSockets "someone wrote that web sockets work... not checked" ([#477](https://github.com/orgs/zepp-health/discussions/477)). UDP: none (ZeppSlime).
- [C, high] **App-side `fetch` is dropped at about 10 s regardless of `timeout`**. It happens sporadically with the phone locked and every time in Android power-saving mode. This breaks slow LLM backends and forces short polling ([zeppos-samples #88](https://github.com/zepp-health/zeppos-samples/issues/88), 2026-05).
- [C] The phone cannot push unprompted or wake the device app (ZML issue #3; [#551](https://github.com/orgs/zepp-health/discussions/551)). Workarounds:
  - `launchApp` from an App Service woken by an alarm (it turns the display on);
  - a notification the user taps (may be suppressed by DND).
- [C] Side Service lifecycle is undocumented beyond `onInit/onRun/onDestroy` [V]. The Side Service only runs while the Zepp app runs:
  - Android battery optimisation kills it (EUC Planet).
  - iOS suspends background apps ([#125](https://github.com/orgs/zepp-health/discussions/125)).
  - "The app-side isn't running constantly in the background" (SashaCX75, [#551](https://github.com/orgs/zepp-health/discussions/551)).
  - On iOS the "disconnect event [fires] only when BT is switched off" (staff, [#159](https://github.com/orgs/zepp-health/discussions/159)).
- [C] Reliability: "shake timeout" in the simulator that works on the device ([#537](https://github.com/orgs/zepp-health/discussions/537)); side service not loading on a real GTR 4 ([#548](https://github.com/orgs/zepp-health/discussions/548)); watchface-to-side-service BLE connection closing unexpectedly on device ([#569](https://github.com/orgs/zepp-health/discussions/569)); iOS side service dying at launch with a JSON-RPC -32603 error on a T-Rex 3 Pro ([#512](https://github.com/orgs/zepp-health/discussions/512)); no mTLS client certificates ([#420](https://github.com/orgs/zepp-health/discussions/420)).
- [C] A third-party phone app can talk to the watch only through the Side Service polling a **local HTTP server** on the phone (EUC Planet, WatchDrip, Tasker setups; [#386](https://github.com/orgs/zepp-health/discussions/386)). [I] This works on Android. On iOS a background local server in your own app is unreliable, so plan for cloud relays or Android-only features.

### 4.4 Workout Extensions (T-Rex 3 supported)

- [V] Docs ([quick start](https://docs.zepp.com/docs/guides/workout-extension/quick-start/)):
  - When not focused, the extension enters "Pause": "cannot respond to the registered callback function, and the registered timer will pause".
  - Single page. No scrolling, no `SCROLL_LIST`/`VIEW_CONTAINER`/`PAGE_INDICATOR`. **No gesture monitoring, no button response.** Click only.
  - A separate appId and a separate store review.
- [C, high] Data exposure limits: see RunDeck (§2.3 #3). `getSportData` has no workout state, no activity subtype, and no power or segment fields in the documented list ([#433](https://github.com/orgs/zepp-health/discussions/433)). Structured-workout step data is inaccessible (RunDeck).
- [C] No write-back: "no API, in either direction, for an extension to write a value back onto the workout record" ([#555](https://github.com/orgs/zepp-health/discussions/555), 2026-09).
- [C, conflicting] **Phone messaging from an extension.**
  - #554 (T-Rex 3 Pro, 6.3.13.5): `this.request` and friends are "NOT A FUNCTION", and building a side service together with a `data-widget` failed.
  - Yet the official sample and three 2026 projects (RunDeck, Lifto Workout, YeRun-Trail) ship `data-widget` + `app-side` in one package and build fine. RunDeck routes phone pushes through `app.js` and lists "side-service fetch" as "needs on-device verification".
  - [I] The most likely reading: you can package it, but the DataWidget context lacks the ZML plumbing. **Prototype this on the T-Rex 3 in week 1.**
- [C] Hot sensor data during workouts: `getSportData('altitude')` gives about 1 Hz at 1 m resolution, the best vertical source, but only while the extension is visible ([#525](https://github.com/orgs/zepp-health/discussions/525), [#535](https://github.com/orgs/zepp-health/discussions/535)).
- [C] There is no API to start, pause or stop the native workout. `launchApp({appId: SYSTEM_APP_SPORT})` can't preselect a sport ([#525](https://github.com/orgs/zepp-health/discussions/525), [#433](https://github.com/orgs/zepp-health/discussions/433)).

### 4.5 Sensors

- [C, high] **Barometer:**
  - `onChange` fires about once per 80 s (Balance 2, API 4.2, [#539](https://github.com/orgs/zepp-health/discussions/539)).
  - The value refreshes every 10 s or more and was integer hPa (about 8.4 m steps) before OS 6 ([#525](https://github.com/orgs/zepp-health/discussions/525)).
  - OS 6 made the value fractional but no more frequent ([#526](https://github.com/orgs/zepp-health/discussions/526)).
  - Barometer has no `setFreqMode`. Compass has had one since 4.0; accelerometer and gyroscope since 3.0 [V].
  - The permission `device:os.barometer` is required but not in the Barometer docs.
  - Staff: "very valuable request... detailed evaluation" (July 2026). No change yet.
- [C, high] **Depth:** `getAirPressure()` "barely moved past 0.2 m" in a 10 m dive on the T-Rex 3 ([#563](https://github.com/orgs/zepp-health/discussions/563)). Depth is only *displayable* through `SPORT_DATA` `DEPTH`, `DEPTH_AVG` and `DEPTH_MAX` in freediving extensions (subtypes 196/197). A request is open ([#570](https://github.com/orgs/zepp-health/discussions/570)).
- [V] **No raw PPG, HRV or RR intervals** anywhere in the device API reference (grep of the docs tree). The HeartRate sensor exposes bpm, maximum and AFib summaries.
- [V/C] **GPS:** not in the background (staff, [#281](https://github.com/orgs/zepp-health/discussions/281)). `Geolocation` doesn't expose altitude ([#539](https://github.com/orgs/zepp-health/discussions/539)). `onGnssChange` can't be debugged in the simulator ([#365](https://github.com/orgs/zepp-health/discussions/365)).
- [C] **Microphone:** recording is available (Opus, 16 kHz mono, raw packet framing, not Ogg; [FAQ](https://docs.zepp.com/docs/guides/faq/opus-to-mp3/)), but there's no raw waveform access ([#426](https://github.com/orgs/zepp-health/discussions/426)). On the Balance 3.28.x the recorder can lock the microphone system-wide until reboot, Zepp Flow included ([#556](https://github.com/orgs/zepp-health/discussions/556)). The permission `device:os.mic` is undocumented.
- [V] Accelerometer and gyroscope frequency modes are qualitative (LOW/NORMAL/HIGH) with no Hz stated. [C] 25 Hz transmission worked in ZeppSlime.

### 4.6 JavaScript runtime, memory, performance and UI

- [V] ([JS support](https://docs.zepp.com/docs/guides/framework/device/js-support/)) No `eval` and no `new Function`. The doc lists Promise, generators and timers as "not supported". In practice, promises come from bundled polyfills or ZML (YeRun-Trail bundles es6-promise).
- [V] **`async/await` is not supported.** Staff say using it freezes the app ([#473](https://github.com/orgs/zepp-health/discussions/473)). Logs show a QuickJS-based engine (`quickjs-libc SBEngine`).
- [V/C] Memory: no documented heap ceiling.
  - Staff: "The device has a limit on the total amount of memory JS can run on; reading a 200 KB file at once can easily lead to such an error" (GTR 4, [#49](https://github.com/orgs/zepp-health/discussions/49)).
  - `app-service.start` has an "Out Of Memory" result code (4). `getPerformance('memory')` exists from API 4.0.
  - POLYLINE has "high memory consumption, very limited viewport of about 150px" ([officially-recommended npm](https://docs.zepp.com/docs/guides/tools/npm/officially-recommended/)).
  - EasyTSDB defaults to a 500 KB RAM budget. [I] Budget a few hundred KB of live JS data.
- [C] Performance: a 4–5 s launch fixed by removing alarm setup at startup ([#435](https://github.com/orgs/zepp-health/discussions/435)). Store-served JS source instead of bytecode is 2.47× bigger to parse ([#568](https://github.com/orgs/zepp-health/discussions/568)).
- [C] UI:
  - Flex layout arrived in 4.0, but the typings (`@zeppos/device-types` ^3) lacked it until **4.0.0 shipped on 2026-06-17** ([#429](https://github.com/orgs/zepp-health/discussions/429); [V] npm).
  - Layouts render differently in the simulator and on devices ([#506](https://github.com/orgs/zepp-health/discussions/506), [#414](https://github.com/orgs/zepp-health/discussions/414)).
  - `createWidget` returns undefined in some cases ([#496](https://github.com/orgs/zepp-health/discussions/496), [#501](https://github.com/orgs/zepp-health/discussions/501)).
  - Alarms are always full-screen, and so are notifications ("notifications on Zepp OS are currently also designed as full-screen experiences", staff, [#542](https://github.com/orgs/zepp-health/discussions/542)).

### 4.7 Tooling and simulator (macOS in particular)

- [V] Simulator 2.1.0 (March 2026) added **native Apple Silicon** builds (macOS 14+). The latest is 2.1.2 (2026-07-17) ([download page](https://docs.zepp.com/docs/guides/tools/simulator/download/)). zeus-cli releases: 1.9.0 (Apr), 1.9.1 (Jun), 1.9.2 (Jul), 1.9.3 (2026-07-23) [V: npm].
- [C] Recurring simulator problems:
  - side-service code never executes in the simulator. The simulator downloads framework JS from a Zepp CDN (region-blocked in some places; Russia confirmed), and runs intermittently ([#478](https://github.com/orgs/zepp-health/discussions/478), 2025-11 to 2026-08; the 2023 CDN incident is [#272](https://github.com/orgs/zepp-health/discussions/272)). A contributor documented a startup order that raises the success rate.
  - the downloader times out in the simulator ([#412](https://github.com/orgs/zepp-health/discussions/412), [#484](https://github.com/orgs/zepp-health/discussions/484)).
  - no Bluetooth, no `onGnssChange`.
  - the "full" resource/file-IO simulator (Zepp Studio) is no longer downloadable ([zeppos-samples #86](https://github.com/zepp-health/zeppos-samples/issues/86)).
- [C] macOS-specific:
  - `zeus create` crash on macOS 26.5 / M4 Pro ([#544](https://github.com/orgs/zepp-health/discussions/544), August 2026).
  - "getting package failed" on macOS Sequoia, unresolved publicly ([#475](https://github.com/orgs/zepp-health/discussions/475)).
  - an M1 permission issue solved with sudo ([#318](https://github.com/orgs/zepp-health/discussions/318)).
  - the FAQ says: delete `~/.zepp` after upgrading from simulator v1 to v2.
  - an open docs PR titled "Update instructions for MacOS" has sat unmerged since 2025-09 ([PR #82](https://github.com/zepp-health/zeppos-docs/pull/82)).
- [C] Accounts: **the simulator and `zeus bridge` need an email/password Zepp account.** Google or other third-party logins create separate accounts and silently break the bridge ([FAQ](https://docs.zepp.com/docs/guides/faq/third-party-login/), [#552](https://github.com/orgs/zepp-health/discussions/552), [#306](https://github.com/orgs/zepp-health/discussions/306)). Preview QR codes expire after about 7 days ([#403](https://github.com/orgs/zepp-health/discussions/403)).
- [V] The VS Code extension is "no longer being maintained". Staff say use `@zeppos/device-types` ([#547](https://github.com/orgs/zepp-health/discussions/547)). TypeScript: community only ([tytydraco/zepp-ts](https://github.com/tytydraco/zepp-ts)).
- [C] Debugging on a real device: `zeus bridge` streams `console.log`. VisLog draws logs on screen.

### 4.8 Documentation gaps [V]

- The device list is out of date (T-Rex 3 API 4.0 in the docs vs 4.4 in the registry).
- No "what's new" for API 4.3/4.4.
- Release notes are frozen: the simulator page ends at 2023, the CLI page at October 2022.
- The revision history ends in November 2023.
- Side Service lifecycle and iOS behaviour are not documented.
- Permissions such as `device:os.barometer` and `device:os.mic` are missing from the docs ([#539](https://github.com/orgs/zepp-health/discussions/539), [#556](https://github.com/orgs/zepp-health/discussions/556)).
- `mstBuildProfile`/`mstPrepare` contradictions ([#536](https://github.com/orgs/zepp-health/discussions/536)).
- The `@zos/alarm` `time` parameter is in **seconds**, a trap people fall into ([#394](https://github.com/orgs/zepp-health/discussions/394)).
- The Workout Extension "Network Function" promise ([intro](https://docs.zepp.com/docs/guides/workout-extension/intro/)) versus reality (§4.4).
- Staff, back in 2023: "The documentation of Settings App has been a weak point" ([#159](https://github.com/orgs/zepp-health/discussions/159)).

### 4.9 App review, distribution and monetisation

- [V] Review is "generally 1~5 working days" ([distribute](https://docs.zepp.com/docs/distribute/)). [C] Observed:
  - 2 days (Amazla Key, September 2026);
  - about 8 days (AmazHA, July 2026);
  - 15+ days "due to the large number of submissions" (March 2025, [#409](https://github.com/orgs/zepp-health/discussions/409)).
- [C] Store problems:
  - an approved app became unsearchable after an update ([#530](https://github.com/orgs/zepp-health/discussions/530)). "Mini-apps have no direct install link, so store search is the only discovery path."
  - an approved app was invisible on the developer's own watch because a lower API device got filtered out ([#533](https://github.com/orgs/zepp-health/discussions/533), a useful lesson in how `minVersion` affects the device list).
  - re-built packages (§1.3).
  - the watchface upload form fails when the `app.json` id is wrong ([#562](https://github.com/orgs/zepp-health/discussions/562)).
- [V] Paid distribution: **only certified corporate developers in Mainland China** can sell through the store (55% net after fees). External in-app purchase (KiezelPay, QR codes) is allowed if disclosed at submission ([paid-app FAQ](https://docs.zepp.com/docs/guides/faq/paid-app/)).
- [C] KiezelPay told a developer its Amazfit library is "no longer maintained and is offered as-is" ([#553](https://github.com/orgs/zepp-health/discussions/553), August 2026). Paid watchfaces require a Chinese address ([#453](https://github.com/orgs/zepp-health/discussions/453)).
- [C] Working 2026 models: activation or license keys (Polar.sh in RunDeck), trial then one-time unlock (AmazHA, HA Companion), with a **reviewer activation code** in the submission's "Features Descriptions" ([#553](https://github.com/orgs/zepp-health/discussions/553)).
- [C] Sideloading: only through Zepp app Developer Mode (tap the Zepp logo 7 times, then `zeus preview` QR or `zeus bridge`). A `.zab` can't be sideloaded directly (EUC Planet). Gadgetbridge can install `.zab`/`.zip` but offers no app integrations ([Gadgetbridge](https://gadgetbridge.org/basics/topics/zeppos/)).

### 4.10 Firmware bugs worth remembering (examples)

- The Music sensor on the T-Rex 3 with OS 6 ([#564](https://github.com/orgs/zepp-health/discussions/564)).
- Recorder locking the microphone on the Balance ([#556](https://github.com/orgs/zepp-health/discussions/556)).
- A reboot from `mstPrepare` (Active 3 Premium, [#536](https://github.com/orgs/zepp-health/discussions/536)).
- `sleep.getSleepingStatus` killing services ([#406](https://github.com/orgs/zepp-health/discussions/406)).
- A mini app auto-launching repeatedly during sleep with the `event:os.health.sleep_status` permission. Staff confirmed it was a bug ([#277](https://github.com/orgs/zepp-health/discussions/277), 2023).
- Notification-access resets on Samsung/Android, with the Zepp app itself at fault ([#488](https://github.com/orgs/zepp-health/discussions/488)).
- Telegram duplicate notifications ([#325](https://github.com/orgs/zepp-health/discussions/325)).

[I] Pattern: regressions arrive with OS updates, and fixes are slow. Test every OS update on the real watch.

### 4.11 2026 issues and threads the coordinator asked about

- **#554 and #555 are GitHub *Discussions* in the zepp-health org forum** (repo `zepp-health/zeppos-forum`), not zeppos-docs issues:
  - [#554](https://github.com/orgs/zepp-health/discussions/554) (2026-08-28, fall-detection developer, T-Rex 3 Pro 6.3.13.5): allow Workout Extensions (DataWidget) to communicate with the phone, meaning Side Service or direct network. Details in §1.3/§4.4. No staff reply.
  - [#555](https://github.com/orgs/zepp-health/discussions/555) (2026-09-01): write access to workout data from an extension, for example exercise names per set in Strength Training, climbing grades, HIIT movement names, or swim strokes. Proposes `setSportMetaDataFields({segment,key,value})`. No staff reply.
  - Related 2026 threads: [#559](https://github.com/orgs/zepp-health/discussions/559) (BLE master in App Service), [#526](https://github.com/orgs/zepp-health/discussions/526)/[#539](https://github.com/orgs/zepp-health/discussions/539)/[#525](https://github.com/orgs/zepp-health/discussions/525)/[#535](https://github.com/orgs/zepp-health/discussions/535) (barometer and altitude), [#570](https://github.com/orgs/zepp-health/discussions/570) (depth getter), [#560](https://github.com/orgs/zepp-health/discussions/560) (a Hevy-like strength program builder and strength calorie model), [#561](https://github.com/orgs/zepp-health/discussions/561) (adaptive health sampling), [#549](https://github.com/orgs/zepp-health/discussions/549) (a hiking ETA wanting remaining trail distance; note that API 4.2 `getWorkoutTrackNavInfo().remainDistance` already covers this during native navigation [V]).
- **zepp-health/zeppos-docs, real 2026 issues:**
  - [#95](https://github.com/zepp-health/zeppos-docs/issues/95): "zab not found" in Watchface Designer caused by an incompatible device in the API-level device list. Closed the same day.
  - [#88](https://github.com/zepp-health/zeppos-docs/issues/88): Sleep as Android blocked by no background accelerometer. Open, no reply.
  - The rest are staff "Feat revision" PRs (#89–#97), described in §1.2.
- **zeppos-samples 2026:** [#88](https://github.com/zepp-health/zeppos-samples/issues/88) (the 10 s fetch drop), [#87](https://github.com/zepp-health/zeppos-samples/issues/87) (Sleep as Android), [#86](https://github.com/zepp-health/zeppos-samples/issues/86) (full simulator unavailable). All open with no replies. **ZML:** all six issues from 2023–24 remain open.

---

## 5. Comparison with Garmin Connect IQ and Wear OS

| Capability | Zepp OS (T-Rex 3, API 4.4) | Garmin Connect IQ | Wear OS |
|---|---|---|---|
| Language / runtime | JavaScript (QuickJS-like; no async/await; npm bundles) [V] | Monkey C, proprietary; tight per-app-type memory limits | Kotlin/Java, full Android |
| Extend native activities | Workout Extension: a display page that pauses when not focused, no buttons or gestures, partial `getSportData` [V] | **Data fields run inside native activities** and keep running; FIT, auto-pause and auto-lap handled by the activity ([App types](https://developer.garmin.com/connect-iq/connect-iq-basics/app-types/)) | Apps run their own workouts through Health Services `ExerciseClient` ([Health Services](https://developer.android.com/health-and-fitness/health-services)) |
| Write custom metrics into the activity file / cloud | **No** [V/C] | **Yes: FitContributor developer fields**, visible in Garmin Connect (store apps only) ([FitContributor](https://developer.garmin.com/connect-iq/api-docs/Toybox/FitContributor.html)) | Your own app and cloud; Health Connect on the phone |
| Background execution | App Service: no timers, no accelerometer/gyro/GPS, no BLE central, one continuous service device-wide; alarm-driven 600 ms jobs [V] | Background service on temporal events, **≥5 min** intervals, with web requests and BLE ([Background](https://developer.garmin.com/connect-iq/api-docs/Toybox/Background.html)) | Foreground services, WorkManager, `PassiveMonitoringClient` for background health data |
| Networking | Through the Zepp phone app's Side Service only; watch-initiated; about 10 s fetch drops reported; Wi-Fi not exposed [V/C] | `makeWebRequest` through Garmin Connect Mobile; **LTE** or Wi-Fi on some models ([Communications](https://developer.garmin.com/connect-iq/api-docs/Toybox/Communications.html), [LTE](https://www.garmin.com/en-US/blog/developer/adapting-connect-iq-app-to-lte/)) | **Direct Wi-Fi/LTE** plus Bluetooth proxy; Data Layer API to your own phone app (two-way push) |
| Phone companion app talks to the watch app | Not possible directly; poll a local HTTP server through the Side Service [C] | Connect IQ Mobile SDK lets Android/iOS companion apps message CIQ apps (well known, not re-checked in this session) | Data Layer `MessageClient`/`DataClient` |
| BLE to external hardware | Central, foreground page only; no peripheral or advertising; no BLE in the simulator [V/C] | `BluetoothLowEnergy` since CIQ 3.1 for **data fields, widgets, apps and background**; up to 3 profiles ([BLE](https://developer.garmin.com/connect-iq/api-docs/Toybox/BluetoothLowEnergy.html)); ANT generic channels | Full Android BLE: central, and typically peripheral/advertising (a forum user contrasted this with Zepp, [#379](https://github.com/orgs/zepp-health/discussions/379)) |
| High-rate sensors | Accelerometer/gyro foreground only; barometer about 0.01–0.1 Hz; no raw PPG [V/C] | Accelerometer up to **25 Hz** through `registerSensorDataListener` ([Sensor](https://developer.garmin.com/connect-iq/api-docs/Toybox/Sensor.html)); barometer usable for varios (MyVario ecosystem cited in [#526](https://github.com/orgs/zepp-health/discussions/526)) | Health Services batching; raw sensors through `SensorManager` |
| Watch-face complications from third parties | **No** (SecondaryWidget NO on the T-Rex 3; data sharing only by file or ShareStorage workarounds) [V] | **Complications API**: apps publish, faces subscribe ([Complications](https://developer.garmin.com/connect-iq/api-docs/Toybox/Complications.html)) | Complication data sources, Tiles |
| Reading phone notifications | No (`getAllNotifications` returns only your own app's) [V] | Limited | A phone app can capture with `NotificationListenerService` and relay over the Data Layer |
| Paid apps | Store sales for China corporate developers only; external license keys elsewhere [V] | **Garmin Pay in the CIQ Store since 2024-08** ([press](https://www.garmin.com/en-US/newsroom/press-release/wearables-health/garmin-enables-premium-app-purchases-in-the-connect-iq-store-and-unveils-fun-new-watch-faces-and-apps/)) | Google Play billing |

Where **Zepp OS is stronger or easier** ([I], grounded in the sources above):
- Plain JavaScript with npm packages. You also get a *JS runtime on the phone* hosted inside the Zepp app, with fetch, settings storage, file transfer and image conversion, without shipping a phone app of your own.
- A settings UI you render yourself inside the Zepp app.
- BLE central from JS, and mic recording, on inexpensive hardware with 2–4 week battery life and 26 GB storage.
- Quick reviews (days), free listing, and a small store with little competition in niches (HA, gym, outdoor sports).
- Staff are reachable on Discord.
- HN (April 2025) described Amazfit's "extremely open and friendly programming environment" ([HN](https://news.ycombinator.com/item?id=43699591)).

Weaker overall: background work, networking, data integration and sensor fidelity. That is precisely why the Engo HUD, paragliding vario, skydiving altimeter and Sleep as Android developers cite Garmin, Wear OS or CIQ as the benchmark ([#433](https://github.com/orgs/zepp-health/discussions/433), [#526](https://github.com/orgs/zepp-health/discussions/526), [#508](https://github.com/orgs/zepp-health/discussions/508), [zeppos-docs #88](https://github.com/zepp-health/zeppos-docs/issues/88)).

---

## 6. Long-standing feature requests still unmet (status as of September 2026)

| Request | Evidence and history | Status |
|---|---|---|
| Read phone and system notifications / rich notification actions | Only your own notifications are readable [V]. Rich actions requested 2025-08, staff: "we'll evaluate" ([#451](https://github.com/orgs/zepp-health/discussions/451)); the June 2026 "any news?" went unanswered. Actionable iOS notifications arrived **for the system, EU only** | Not available to third parties |
| Phone sensors, state and battery through an API | 2024 request ([#334](https://github.com/orgs/zepp-health/discussions/334)); silver-zepp: "unrealistic"; workaround: Tasker or a local server | Rejected |
| Write workouts or metadata into Zepp; structured workouts through REST | [#494](https://github.com/orgs/zepp-health/discussions/494) (2026-02, most upvoted thread of 2026, no answer), [#555](https://github.com/orgs/zepp-health/discussions/555), [#418](https://github.com/orgs/zepp-health/discussions/418); the REST API is "open for business cooperation only" ([#194](https://github.com/orgs/zepp-health/discussions/194), [#516](https://github.com/orgs/zepp-health/discussions/516)) | Not available. TrainingPeaks and Intervals.icu are *partner* integrations |
| Raw PPG / HRV / RR, high-rate barometer, numeric depth | §4.5; staff "evaluate" (2026-05/07) | Not available |
| BLE central in the background / App Service; BLE peripheral or advertising | [#559](https://github.com/orgs/zepp-health/discussions/559) (2026-09), [#311](https://github.com/orgs/zepp-health/discussions/311) (2024: "considering"), [#379](https://github.com/orgs/zepp-health/discussions/379) | Not available |
| Background accelerometer or GPS | [#370](https://github.com/orgs/zepp-health/discussions/370), [#281](https://github.com/orgs/zepp-health/discussions/281), [zeppos-docs #88](https://github.com/zepp-health/zeppos-docs/issues/88) | Not available |
| Third-party complications / shared data bus | [#460](https://github.com/orgs/zepp-health/discussions/460) (2025-09), [#491](https://github.com/orgs/zepp-health/discussions/491); ShareStorage APIs documented 2026-07 [V] | Partial (file or storage sharing only) |
| NFC (card emulation) | [#424](https://github.com/orgs/zepp-health/discussions/424) (2025-05), staff: "will consider" | Not available |
| Wi-Fi control or direct Wi-Fi networking | [#509](https://github.com/orgs/zepp-health/discussions/509) (2026-05): "not yet available" | Not available |
| Programmatic DND or flight mode | [#278](https://github.com/orgs/zepp-health/discussions/278) (rejected), [#390](https://github.com/orgs/zepp-health/discussions/390); a read-only system-mode getter exists (`getSystemMode`) ([#515](https://github.com/orgs/zepp-health/discussions/515)) | Read-only |
| Banner or non-full-screen alarms and notifications | [#542](https://github.com/orgs/zepp-health/discussions/542) (2026-08), staff: "treat as a feature request" | Not available |
| Start or stop native workouts; launch a specific sport | [#525](https://github.com/orgs/zepp-health/discussions/525), [#433](https://github.com/orgs/zepp-health/discussions/433) | Not available |
| Side Service waking or launching the device app | [#551](https://github.com/orgs/zepp-health/discussions/551), ZML #3 | Not available (alarms and notifications only) |
| Paid store apps outside China | [paid-app FAQ](https://docs.zepp.com/docs/guides/faq/paid-app/), [#453](https://github.com/orgs/zepp-health/discussions/453), [#553](https://github.com/orgs/zepp-health/discussions/553) | Not available |
| Health Connect read, food logging | [#84](https://github.com/orgs/zepp-health/discussions/84) (2023; tied with #494 as the most upvoted thread, at 6), [#483](https://github.com/orgs/zepp-health/discussions/483) | Weight reading only (news) |
| Text-to-speech on the watch | Staff 2023: "no plan" ([#159](https://github.com/orgs/zepp-health/discussions/159)); moot on the T-Rex 3, which has no speaker | Not available |
| Zepp Flow / AI hooks for third-party apps | No mention in docs or `llms.txt` [V] | None |

---

## 7. State of the ecosystem, 2025–2026

| Signal | Data | Reading |
|---|---|---|
| Official forum volume | 27 threads (2022) → **249 (2023)** → 106 (2024) → 78 (2025) → **85 in 2026 through September**, with a rise in July–September (14/19/15) [V] | Past its 2023 peak; picking up again in 2026 |
| Forum responsiveness | 2026: **9 of 36** Q&A threads answered, **32 of 85** threads with zero comments. Staff (MyoungXUE, Xuemuyang, zeppos-hx, silver-zepp) reply to a subset and **redirect people to Discord**. Threads started by staff accounts: 5 (2022), 23 (2023), 4 (2024), 3 (2025), **0 (2026)**. The last Announcement is the hackathon post of 2025-11-14 [V] | Help desk and announcements have moved to Discord |
| Discord | **About 1,858 members, about 75 online** (Discord invite API, 2026-09-28) [V] | Small community |
| GitHub activity | New "zepp os" repos: 36 (2025) → **121 (2026 through September)** [V]; many are AI-agent tooling | Renewed activity, possibly shallow |
| Events and incentives | 2025 Developer Conference (Zoom, 2025-04-15) announced new APIs and a roadmap ([#416](https://github.com/orgs/zepp-health/discussions/416)). **2025 Global Online Hackathon**: 2025-10-22 to 2026-01-15, categories Mini Program / Keyboard / Connectivity / **Pro Sports & Outdoor** / Open Innovation, prizes T-Rex 3 Pro + $150–300 gift cards, "over 50 submissions, the biggest yet" ([rules](https://developer.zepp.com/os/2025/global-online-hackathon), [winners](https://developer.zepp.com/os/2025/hackathon-2025-winners)). The 2024 hackathon drew 60+ developers and 30+ entries, but the Sports & Wellness category got only 2 valid submissions ([2024](https://developer.zepp.com/os/hackathon-2024-winners)) | Zepp keeps investing in contests. Sports is under-served, which is an opportunity |
| Tooling cadence | zeus-cli 1.8.0 (2025-11) → 1.9.3 (2026-07); zpm 3.4.2 (2026-07); simulator 2.1.0–2.1.2 (2026-03 to 07, Apple Silicon); device-types 4.0.0 (2026-06); ZML 0.0.43 (2026-01); EasyBLE npm 1.7.8 (2024-11) [V] | Core tooling is maintained. The libraries are aging |
| Developer portal and blog | developer.zepp.com still shows the 2025 hackathon as live and says "Many buttons have been disabled because we are building something amazing for you". The blog has 1 post in 2025–26 (WatchFM, 2026-07) ([blog list](https://developer.zepp.com/os/blog-list)) [V] | Neglected, or being rebuilt |
| Platform direction | Zepp OS 6 (2026) on 13+ models; API levels 4.3/4.4 on 2026 devices; extended update windows (36+ months) [V] | **No sign of deprecation.** Mini programs keep receiving API growth; the docs lag |
| Company | Zepp Health Q2 2026 revenue $63.5 M (+6.9% YoY); H1 +17.5%; **0.6 M units** in Q2; adjusted operating loss widened to $11.1 M ([Investing.com](https://www.investing.com/news/transcripts/earnings-call-transcript-zepp-health-q2-2026-revenue-rises-7-as-loss-widens-93CH-4885271)) | A small vendor. [I] Expect limited developer-relations capacity |
| Store reach | AmazHA reached about 4,000 downloads in about 6 weeks; one watchface maker claims 150k downloads in 5 months ([#453](https://github.com/orgs/zepp-health/discussions/453)) [C] | Niche apps can find users |

**Verdict [I]:**
- Alive and modestly growing: new OS, new API levels, active tooling, contests, and a 2026 spike in GitHub activity.
- Thinly staffed on developer relations: out-of-date docs, low forum response rate, unanswered library issues, store pipeline glitches.
- Not being deprecated.
- Plan for sparse official help, and treat Discord plus a few power users (SashaCX75, silver-zepp, zdunex25, galulex) as the support channel.

---

## 8. (i) Top 10 real-world constraints to design around (ranked)

1. **No reliable background compute.** Foreground pages die when the screen goes off unless you keep them alive. App Service can't use timers, accelerometer, gyro, GPS or BLE central, and only one runs device-wide. **Design:** session-based UX (the user opens the app for a workout or session); keep the screen on and use `setWakeUpRelaunch`; persist state on every change; use short **alarm-driven jobs** for periodic work (§2.3 #8).
2. **Custom hardware must be a GATT peripheral that the watch talks to from a foreground page.** No watch-side peripheral or advertising; no background BLE; pairing and bonding are fragile; lifecycle bugs can reboot the watch; no simulator BLE. **Design:** no bonding needed, app-layer auth, standard profiles where possible, EasyBLE, real-device testing only, conservative scan/connect/prepare sequencing with timeouts.
3. **Networking goes only through the Side Service in the Zepp phone app.** Watch-initiated request/response, about 3.6 KB chunks, a handful of messages per second in practice, an app-side fetch drop at about 10 s, a Side Service that can be killed on Android or suspended on iOS, and no push or wake. **Design:** offline-first watch app, batch sync on open, retries and idempotency, short polling instead of long requests, a phone-side "inbox" of queued events.
4. **Workout Extensions are display-only and pause when out of focus.** No buttons or gestures, partial metrics, no structured-workout access, uncertain phone messaging (#554). **Design:** use an extension for *glanceable live screens* inside native workouts; do logic and logging in a standalone app; verify extension-to-phone communication on the T-Rex 3 in week 1.
5. **Your data can't enter Zepp's workout or health record** (no FIT developer fields, no write API, REST limited to partners). **Design:** own the data path (side service to your backend or Strava API). [I] For sensor data you want inside native workouts, make the hardware emulate a standard BLE profile the watch pairs with natively (HRS/CSC/CPS/RSC/FTMS, [accessories](https://os.zepp.com/accessories)).
6. **Sensor ceilings.** Barometer 0.01–0.1 Hz; no raw PPG/HRV/RR; no numeric depth; accelerometer and gyro in the foreground only; GPS not in the background; **no speaker on the T-Rex 3**. **Design:** reject ideas that need these, like varios, HRV biofeedback or dive computers, or source the signal from your own external sensor over BLE. Deliver cues by haptics.
7. **Docs, device list and toolchain drift, plus OS-update regressions.** API 4.4 is real but undocumented beyond 4.2; the Music sensor broke in OS 6; the store re-builds packages; the simulator is flaky for side-service, downloader and BLE. **Design:** feature-detect at runtime (`getSystemInfo`, `typeof api === 'function'`), pin zeus/zpm versions, keep an on-device smoke test, re-test after every firmware update, and check the store-served package.
8. **JS runtime and memory limits.** No async/await, polyfilled Promise, no eval, undocumented heap limit (200 KB reads can OOM), bytecode matters for launch time, absolute-layout widgets (flex from 4.0). **Design:** small modules, streaming or chunked file IO, `.then()` style, profile with `getPerformance('memory')`, lean UI; avoid POLYLINE for long tracks.
9. **Distribution and monetisation.** Review takes days to weeks; search-only discovery; paid store listing not possible outside China; KiezelPay unmaintained; reviewer codes required for unlocks; sideloading only through Developer Mode QR. **Design:** plan to ship free or with an external license-key unlock (Polar.sh model); budget two weeks per release cycle; test the `minVersion` and device-filter effects.
10. **Weak phone and OS integration hooks.** Can't read phone notifications or phone state; no third-party complications on the T-Rex 3; alarms and notifications always full-screen; can't start native workouts; the app can't be auto-launched from the phone; the launcher layout is in flux on OS 6. **Design:** users will open the app from the app list; don't build around notifications or complications; use ShareStorage or files if you also ship a watchface.

(Honourable mention: **the device's own reliability**. Sensor pairing and some native features are "surface-level finished" per DC Rainmaker. The support window ends September 2027, which is fine for a personal project.)

---

## 9. (ii) The 10 most useful reference repos

| # | Repo | Why study it |
|---|---|---|
| 1 | [zepp-health/zeppos-samples](https://github.com/zepp-health/zeppos-samples) | Canonical API 4.0/4.2 app samples and all Workout Extension samples (with and without a side service) |
| 2 | [zepp-health/zml](https://github.com/zepp-health/zml) | The messaging and HTTP layer everyone uses. Read `src/shared/message.js` for chunking and timeouts, and the open issues for failure modes |
| 3 | [zepp-health/easy-ble](https://github.com/zepp-health/easy-ble) | BLE central wrapper, ESP32 peripheral example, standard HR and battery parsing. The starting point for custom hardware |
| 4 | [eried/eucplanet](https://github.com/eried/eucplanet) (`amazfit-watch-app/`, `docs/AMAZFIT_SETUP.md`) | Hardware companion tested on the T-Rex 3; watch ↔ side service ↔ loopback HTTP to an Android app; honest limitation list against Wear OS and Garmin |
| 5 | [andrejd1/rundeck](https://github.com/andrejd1/rundeck) (source-available) | The most complete map of what Workout Extensions can read; lap and HR-zone handling; Polar.sh licensing; a headless simulator and test harness |
| 6 | [PreciselyWrong/Liftosaur-ZeppOs-Companion](https://github.com/PreciselyWrong/Liftosaur-ZeppOs-Companion) | Strength training as both a standalone app and an in-workout extension; durable journal and write queue; side-service-only credentials |
| 7 | [JovannMC/ZeppSlime](https://github.com/JovannMC/ZeppSlime) | 25 Hz IMU streaming off the watch as BLE central to a desktop peripheral; explains the no-UDP and no-peripheral constraints |
| 8 | [SashaCX75/Weather-service](https://github.com/SashaCX75/Weather-service) | The robust alarm-driven App Service pattern plus side-service fetch and notifications |
| 9 | [silver-zepp/zeppos-autogui](https://github.com/silver-zepp/zeppos-autogui) | Examples for an external data sink and watchface ↔ app data sharing; fast UI prototyping (with [visual-logger](https://github.com/zepp-health/visual-logger) and [easy-storage](https://github.com/zepp-health/easy-storage) from the same author) |
| 10 | [1445688048/YeRun-Trail](https://github.com/1445688048/YeRun-Trail) | Outdoor Workout Extension targeting API 4.3: GPX parsing in the side service, 3.6 KB chunked sync, route overlay during native workouts |

Runners-up:
- [giovaboy/ZeppOS-HTTP-Buttons](https://github.com/giovaboy/ZeppOS-HTTP-Buttons): Settings-App-driven HTTP.
- [Anduin2017/SleepAgent](https://github.com/Anduin2017/SleepAgent): metrics uploader.
- [davidepalleschi/zepp2hass](https://github.com/davidepalleschi/zepp2hass): HA webhook sink.
- [3125589/yunmai-zeppos](https://github.com/3125589/yunmai-zeppos): minimal direct-BLE app.
- [melianmiko/ZeppOS-Tasks](https://github.com/melianmiko/ZeppOS-Tasks): OAuth.
- [osben/zepp-os-skills](https://github.com/osben/zepp-os-skills) plus [docs.zepp.com/llms.txt](https://docs.zepp.com/llms.txt): AI-assisted development.
- [gabera/altimeter-zeppos](https://github.com/gabera/altimeter-zeppos): a cautionary tale.

---

## Appendix A: Notes for the team

- **Check first on the actual watch:**
  1. `getSystemInfo()` API level (expect 4.4 on 6.x firmware).
  2. Whether a DataWidget can reach the side service.
  3. EasyBLE connection to an ESP32 test peripheral.
  4. Keep-screen-on plus relaunch behaviour during a 60-minute session.
  5. Side-service fetch behaviour with the phone locked, on *your* phone OS.
- **Accounts:** use an email/password Zepp account on both the phone and zeus. Do not use Google sign-in (§4.7).
- **Workspace hygiene (security):** the git remotes of the cloned repos in `scratchpad/src/*/.git/config` embed a GitHub personal access token in the URL. Scrub it with `git remote set-url` and consider rotating the token.
- **Environment aside:** this Claude environment has a `zepp-life` MCP server configured for health and workout queries. That may be a convenient way to read Zepp-cloud data for analysis, separate from the on-watch app.

## Appendix B: Forum threads read in full (for traceability)

All threads are at `https://github.com/orgs/zepp-health/discussions/<n>`:

- **2026:** 572, 570, 569, 568, 564, 563, 559, 556, 555, 554, 553, 552, 551, 550, 549, 548, 547, 545, 544, 542, 539, 537, 536, 535, 534, 533, 530, 528, 526, 525, 523, 520, 518, 516, 515, 512, 510, 509, 508, 506, 504, 503, 502, 494, 491, 488, 485.
- **2025:** 481, 478, 477, 475, 473, 472, 471, 470, 462–451 (selected), 453, 449, 435, 433, 430, 427, 426, 425, 424, 421, 420, 416, 412, 410, 409, 407, 406, 403, 401, 400.
- **2024:** 396, 394, 393, 390, 388, 386, 379, 370, 366, 365, 360, 351, 349, 342, 341, 334, 332, 330, 325, 311, 307, 306, 297, 295.
- **2023 and earlier:** 281, 278, 277, 276, 272, 204, 194, 187, 174, 159, 146, 59, 49, 30, 16, 7.
