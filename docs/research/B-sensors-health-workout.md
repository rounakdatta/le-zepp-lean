# B: Sensors, Health Data and Workouts on the Amazfit T-Rex 3 (Zepp OS)

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Research date: 2026-09-28. Scope: every `@zos/sensor` class plus the other health, workout and sensor-like APIs, Workout Extensions, background sensor access, community findings and open-source apps.

Evidence tags used throughout:

- **[V]**: verified from official material: the docs source (`zeppos-docs`, last commit 2026-07-17), the Chinese translation (`i18n/zh-cn`, which often fixes English copy-paste errors), the official samples, the official `@zeppos/device-types` typings (3.0.0 and 4.0.0), or Zepp's own device registry used by the Zeus CLI.
- **[C]**: community report, such as a GitHub discussion in `zepp-health/zeppos-forum`, an open-source repo, a review or a news article. Links are given inline.
- **[I]**: my inference, not verified.

Local paths below are relative to `scratchpad/src/zeppos-docs/` unless stated otherwise. Docs pages are cited by path, for example `docs/reference/device-app-api/newAPI/sensor/HeartRate.mdx`.

---

## 0. TL;DR: decision-relevant findings

1. **The T-Rex 3's API_LEVEL has probably increased to 4.4.**
   - The docs device list (`docs/reference/related-resources/device-list.mdx`, and the live site checked today) still says **T-Rex 3: API_LEVEL 4.0 / Zepp OS 4.5**.
   - Zepp's own device registry that the Zeus CLI downloads says otherwise: `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json`, fetched 2026-09-28. For deviceSource 8716544, 8716545 and 8716547 it lists `os: {name: "ZeppOS", version: "6.0", apiLevel: "4.4", apiLevelLimitMax: "4.4"}` and `capabilities: ["gps","magnetometer","gyroscope","accelerometer","altimeter"]` **[V: official tooling metadata]**.
   - Zepp OS 6 reached the T-Rex 3 from 2026-07-22 (firmware 6.2.104.6), followed by 6.3.13.5 (August) and 6.3.25.7 (2026-09-03) **[C: [gadgetsandwearables](https://gadgetsandwearables.com/2026/07/22/amazfit-t-rex-3-pro-ultra-2-zepp-os-6-update/), [6.3.25.7](https://gadgetsandwearables.com/2026/09/03/amazfit-t-rex-3-pro-ultra-2-update-6-3-25-7/), [os.zepp.com compatibility](https://os.zepp.com/compatibility-zepp-os-6)]**.
   - **Consequence:** on an updated watch, the API_LEVEL 4.2 sensor features are *probably* available. These are `Workout.getUserHrZoneSettings()`, `Workout.getWorkoutTrackNavInfo()` and `getDeviceInfo().uuid`.
   - **Action:** confirm in Zepp App → Developer Mode → device info (`docs/guides/tools/zepp-app.mdx`, "Query the device API LEVEL") before relying on them. The docs define no API_LEVEL 4.4 sensor additions; the only API_LEVEL 4.3 item is in `media/Player`.
2. **The raw IMU is available only in the foreground.**
   - `Accelerometer` and `Gyroscope` (API_LEVEL 3.0) give x/y/z in cm/s² and deg/s, with only three qualitative rate modes (`FREQ_MODE_LOW|NORMAL|HIGH`). **No Hz values are published anywhere** **[V]**.
   - Samples carry no timestamps.
   - Community measurements show bursty delivery: roughly a 500 ms gap followed by about 10 callbacks 4–12 ms apart (Balance, 2023). `FREQ_MODE_HIGH` changed nothing at the time **[C: [#282](https://github.com/orgs/zepp-health/discussions/282)]**.
   - The IMU is **blocked in App Service**, together with Geolocation **[V]**.
   - A Mini Program is killed about 10 s after the screen turns off unless you keep the screen lit **[V]**.
   - Verdict: good enough for coarse rep counting and gesture detection in a visible foreground page or a focused Workout Extension. Not suitable for high-rate or precisely timed motion analysis.
3. **Heart rate: live bpm only.**
   - `HeartRate.onCurrentChange` starts continuous optical measurement and gives bpm "at a certain frequency" (rate undocumented) **[V]**.
   - **There is no RR/beat-to-beat, HRV or raw PPG API** on the watch **[V: absent from docs and from the 4.0.0 typings]**.
   - RR intervals are only obtainable from an **external BLE chest strap** via BLE central (foreground only) **[I]**.
4. **Historical data is shallow.**
   - HR: today only (per-minute array).
   - Stress: 7 days.
   - SpO2: 24 hourly values plus `getLastFewHour(h)`.
   - PAI: 7 days.
   - Sleep: **last night only**. No earlier nights, which staff acknowledged in 2024 **[C: [#371](https://github.com/orgs/zepp-health/discussions/371)]**.
   - Body temperature: today in 5-minute buckets.
   - Steps, calories and distance: today's totals only.
   - `Workout.getHistory()`: only `{startTime, duration}` per workout. No sport type, distance, HR or GPS track.
5. **Advanced metrics.**
   - VO2max, 7-day training load and full recovery time: readable (`Workout.getStatus()`, API_LEVEL 3.0).
   - HR zones: API_LEVEL 4.2.
   - Training effect: can only be *displayed* inside a Workout Extension via the `SPORT_DATA` widget.
   - Readiness: display-only on watch faces.
   - HRV, BioCharge/HybridCharge and respiration: **no API**.
6. **Workout Extension: supported on the T-Rex 3, but read-only and with a focus-dependent lifecycle.**
   - Plugins run inside the system Workout app; the user can add up to 4 extension pages per workout (T-Rex 3 manual).
   - They can **read** 15 live metric types (`getSportData`) and **display** about 200 system metrics (`SPORT_DATA`).
   - **Callbacks and timers pause whenever the extension page is not focused**, and the system does not tell the extension which sport is running.
   - Extensions **cannot write anything into the recorded workout**: no custom fields and nothing like FIT developer fields. A feature request was opened 2026-09-01 **[C: [#555](https://github.com/orgs/zepp-health/discussions/555)]**.
   - Extensions cannot start, stop or lap the workout.
   - Phone messaging from an extension is **unreliable or broken on T-Rex 3 Pro firmware 6.3.13.5** per [#554](https://github.com/orgs/zepp-health/discussions/554), despite an official sample.
7. **You cannot save your own workout into Zepp's health data.** There is no workout-write API; the only health write is `addHealthData({weight, bmi})`.
   - There is no documented way to start a specific system sport (`launchApp(SYSTEM_APP_SPORT)` only opens the Workout app).
   - Sync to Strava or Apple Health happens only for workouts recorded by Zepp's own Workout app.
8. **Background (App Service) access.**
   - Low-power health sensors are readable **[V]**.
   - Cadence is driven by `Time.onPerMinute()`, by `createSysTimer` (API_LEVEL 4.0) or by `@zos/alarm` and system events.
   - A community test found a barometer poll every 5 s to be the fastest stable interval (500 ms crashed the service) **[C: [#535](https://github.com/orgs/zepp-health/discussions/535)]**.
   - No IMU, GPS or BLE central in the background.
9. **The barometer is practically useless for fast altitude work.**
   - `onChange` fires about once every 80 s **[C: [#539](https://github.com/orgs/zepp-health/discussions/539)]**.
   - The getters return cached values, and there is no `setFreqMode` for the barometer.
   - During a workout, `getSportData('altitude')` gives about 1 Hz at 1 m resolution.
   - On the T-Rex 3 the barometer also cannot measure water depth **[C: [#563](https://github.com/orgs/zepp-health/discussions/563)]**.

---

## 1. Platform context and freshness

| Item | Official docs | Other official source or reality | Tag |
|---|---|---|---|
| T-Rex 3 API_LEVEL | 4.0 (`device-list.mdx`, live site) | Zeus device registry: **4.4**, Zepp OS **6.0** | [V] both; registry is newer |
| T-Rex 3 Zepp OS | 4.5 | Zepp OS 6 rollout from 2026-07-22 (6.2.104.6 → 6.3.13.5 → 6.3.25.7) | [C] news |
| Feature support window | – | Extended to **Sept 2027** ([gadgetsandwearables, 2026-02-04](https://gadgetsandwearables.com/2026/02/04/amazfit-t-rex-3-firmware-extension/)) | [C] |
| Device JS runtime on Zepp OS 6 | – | `jsrt-4.5.0-release.2-405` reported on a T-Rex 3 ([#564](https://github.com/orgs/zepp-health/discussions/564)) | [C] |
| Workout Extension support | T-Rex 3 explicitly listed (`docs/guides/workout-extension/intro.mdx`) | requires API_LEVEL ≥ 3.6 | [V] |
| Sensor hardware | – | registry capabilities: gps, magnetometer, gyroscope, accelerometer, altimeter. [DC Rainmaker](https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html): optical HR with SpO2, HRV and skin temperature; multiband GNSS; barometer; compass; gyroscope | [V]/[C] |

**How API_LEVEL works** (`docs/guides/framework/device/compatibility.md`) **[V]**: an app declares `runtime.apiVersion.minVersion`. The store only installs it on firmware whose API_LEVEL is at least that value, and firmware is backward compatible. The recommendation for this project **[I]** is to target `minVersion: "4.0"` and feature-detect 4.2 methods at runtime, for example `typeof workout.getUserHrZoneSettings === 'function'` inside try/catch. Only raise `minVersion` after confirming the watch's API level.

---

## 2. Permission codes (sensor, health and workout)

Declare these in `app.json` → `"permissions": [...]` (`docs/guides/framework/device/permission.md`). The install-time consent dialog shows them to the user **[V]**.

| Permission | Unlocks | Tag |
|---|---|---|
| `data:user.hd.heart_rate` | `HeartRate` | [V] |
| `data:user.hd.spo2` | `BloodOxygen` | [V] |
| `data:user.hd.stress` | `Stress` | [V] |
| `data:user.hd.sleep` | `Sleep` | [V] |
| `data:user.hd.body_temp` | `BodyTemperature` | [V] |
| `data:user.hd.step` | `Step` | [V] |
| `data:user.hd.calorie` | `Calorie` | [V] |
| `data:user.hd.distance` | `Distance` | [V] |
| `data:user.hd.stand` | `Stand` | [V] |
| `data:user.hd.fat_burning` | `FatBurning` | [V] |
| `data:user.hd.pai` | `Pai` | [V] |
| `data:user.hd.workout` | `Workout` sensor **and** `getSportData` (`@zos/app-access`) | [V] |
| `device:os.accelerometer` | `Accelerometer` | [V] |
| `device:os.gyroscope` | `Gyroscope` | [V] |
| `device:os.compass` | `Compass` | [V] |
| `device:os.barometer` | `Barometer` | [V] |
| `device:os.geolocation` | `Geolocation` | [V] |
| `data:user.info` | `@zos/user getProfile` (age, height, weight, gender) | [V] |
| `data:user.health` | `@zos/user addHealthData` (write weight and BMI) | [V] |
| `device:os.bg_service` | continuous App Service (also needs a runtime `requestPermission`) | [V] |
| `event:os.health.sleep_status`, `event:os.health.heart_rate_abnl`, `event:os.helath.stress_remind` (sic, spelled "helath" in the docs), `event:os.health.wear_status`, `event:os.system.sleep_mode` | system events that wake an App Service | [V] (`docs/guides/framework/device/system-event.md`) |
| none | `Battery`, `Wear`, `Screen`, `Time`, `Vibrator`, `Buzzer`, `SystemSounds`, `WorldClock` | [V] |

Caveats:

- The permission guide says "the production version of the firmware does not include the dynamic privileges section" **[V]**. However, [#539](https://github.com/orgs/zepp-health/discussions/539) (Balance 2, API_LEVEL 4.2) reports that the **barometer was completely silent until `device:os.barometer` was also granted at runtime via `requestPermission`** **[C]**.
- Since API_LEVEL 4.0, the user can also disable location for Mini Programs; check `Geolocation.getEnabled()` **[V]**.
- Recommended practice **[I]**: call `queryPermission` for every sensor permission and `requestPermission` for anything not yet granted.

---

## 3. Master table: every class in `@zos/sensor`, plus related APIs

Source: `docs/reference/device-app-api/newAPI/sensor/*.mdx` (27 files), cross-checked against `@zeppos/device-types` 3.0.0 and 4.0.0 typings (the 4.0.0 copy is in `scratchpad/research/types4/`). **No undocumented methods were found in the typings** **[V]**.

Column meanings: "Min API" is the minimum API_LEVEL; "App Service" is whether the class works in a background App Service; "T-Rex 3 (4.0 / 4.4)" is availability under the documented and the registry API level.

| Class | Min API | Permission | What it gives | Realtime or history | Events | Rate control | App Service | T-Rex 3 (4.0 / 4.4) |
|---|---|---|---|---|---|---|---|---|
| `Accelerometer` | 3.0 | `device:os.accelerometer` | x, y, z in cm/s² | realtime stream | `onChange`/`offChange`, `start`/`stop` | `setFreqMode`/`getFreqMode` LOW/NORMAL/HIGH | **NO** (high-power) | ✅/✅ |
| `Gyroscope` | 3.0 | `device:os.gyroscope` | x, y, z in deg/s, right-hand rule | realtime | same | same | **NO** | ✅/✅ |
| `Compass` | 3.0 | `device:os.compass` | 8-point direction, angle 0–360 or `'INVALID'`, calibration status | realtime | `onChange`, `start`/`stop` | `setFreqMode` **since 4.0** | not listed as high-power; unverified **[I]** | ✅/✅ |
| `Barometer` | 2.1 | `device:os.barometer` | air pressure (hPa), altitude (m) | realtime (cached, slow) | `onChange` (fires rarely **[C]**) | **none** | allowed (community polled it **[C]**) | ✅/✅ |
| `Geolocation` | 2.1 | `device:os.geolocation` | lat/lon (WGS-84, DD or DMS), fix status A/V, GNSS/satellite info, positioning-mode setting, user location toggle | realtime | `onChange`, `onGnssChange` (3.0), `onEnableChange` (4.0) | none | **NO** | ✅/✅ |
| `HeartRate` | 2.0 | `data:user.hd.heart_rate` | continuous bpm, last bpm, today per-minute, resting HR, daily max, AFib records | realtime + today | `onCurrentChange`/`onLastChange` (2.1), `onRestingChange` (3.0) | none | YES (non-high-power) | ✅/✅ |
| `BloodOxygen` | 2.0 | `data:user.hd.spo2` | spot SpO2 with `retCode`, 24 hourly values, last N hours | spot + 24 h | `onChange`; `start`/`stop` (2.1) | none | YES **[V]** (as non-high-power) | ✅/✅ |
| `Stress` | 2.0 | `data:user.hd.stress` | current value, per-minute today, hourly today, 7 daily, 7×24 hourly | realtime + 7 days | `onChange` | none | YES | ✅/✅ |
| `Sleep` | 2.0 | `data:user.hd.sleep` | score, deep minutes, start/end, total, stages, naps (3.0), sleeping now (3.0) | last sleep only | none (use the system event) | `updateInfo()` | YES | ✅/✅ |
| `BodyTemperature` | 3.0 | `data:user.hd.body_temp` | latest skin temperature, 288 five-minute buckets for today | today | none | none | YES | ✅/✅ |
| `Step` | 2.0 | `data:user.hd.step` | today's steps and goal | today total | `onChange` | none | YES | ✅/✅ |
| `Calorie` | 2.0 | `data:user.hd.calorie` | kcal today and goal | today | `onChange` | none | YES | ✅/✅ |
| `Distance` | 2.0 | `data:user.hd.distance` | distance today (unit undocumented; metres per [C]) | today | `onChange` | none | YES | ✅/✅ |
| `Stand` | 2.0 | `data:user.hd.stand` | standing hours and goal | today | `onChange` | none | YES | ✅/✅ |
| `FatBurning` | 2.0 | `data:user.hd.fat_burning` | fat-burn minutes and goal | today | `onChange` | none | YES | ✅/✅ |
| `Pai` | 2.0 | `data:user.hd.pai` | total PAI, today, last 7 days | 7 days | none | none | YES | ✅/✅ |
| `Workout` | 3.0 | `data:user.hd.workout` | VO2max, training load, full recovery time; workout history; HR zones (**4.2**); route navigation info (**4.2**) | status + history | none | none | YES | ✅ except 4.2 methods / likely ✅ all |
| `Wear` | 2.0 | none | 0 not worn, 1 worn, 2 in motion, 3 unsure | realtime | `onChange` | none | YES | ✅/✅ |
| `Screen` | 3.0 | none | on/off status, AOD, ambient light in lux (3.6) | realtime | `onChange(status)` | none | YES | ✅/✅ (light sensor presence unverified **[I]**) |
| `Battery` | 2.0 | none | battery 0–100 % | realtime | `onChange` | none | YES | ✅/✅ |
| `Time` | 2.0 | none | clock, 12/24 h, lunar calendar, festivals | – | `onPerMinute`/`onPerDay` (2.1), `onSunrise`/`onSunset`/`onPhoneTimeSetting` (3.0), `onPerHourEnd` (3.6) | – | YES (the main background tick) | ✅/✅ |
| `Vibrator` | 2.0 | none | haptic scenes; scene arrays and `getType` (3.6) | – | – | – | YES [I] | ✅/✅ |
| `Buzzer` | 3.6 | none | system beep types, strength | – | – | – | ? | ✅ (check `getDeviceInfo().hasBuzzer`, API_LEVEL 4.0) |
| `SystemSounds` | 3.6 | none | built-in system tones | – | – | – | ? | ✅ |
| `Weather` | 2.0 | none | **deprecated** (discussion #83) | – | – | – | – | avoid |
| `WorldClock` | 3.0 | none | configured world clocks | – | – | – | – | ✅ |
| `checkSensor(Ctor)` | 3.0 | – | whether a sensor exists on this device (boolean) | – | – | – | – | ✅ |

Related non-`@zos/sensor` APIs:

| API | Min API | Permission | Purpose | Tag |
|---|---|---|---|---|
| `getSportData({type}, cb)` in `@zos/app-access` | 3.6 | `data:user.hd.workout` | live metrics of the **running system workout** (15 types) | [V] |
| `widget.SPORT_DATA` with `sport_data.*` and `edit_widget_group_type.SPORTS` in `@zos/ui` | 3.6 | – | the system draws about 200 live workout metrics inside an extension | [V] |
| `DataWidget({...})` (global) | 3.6 | – | Workout Extension page constructor | [V] |
| `getProfile()` in `@zos/user` | 2.0 | `data:user.info` | age, height, weight, gender, nickname, region | [V] |
| `addHealthData({weight, bmi})` in `@zos/user` | 3.0 | `data:user.health` | **the only health write**: weight in grams, BMI × 100 | [V] |
| `launchApp({appId: SYSTEM_APP_*, native: true})` in `@zos/router` | 3.0 | – | open system apps: SPORT, SPORT_HISTORY, SPORT_STATUS, HR, SLEEP, SPO2, PRESSURE (stress), PAI, READINESS, BREATH, MEASUREMENT, ZEPP_COACH, ALTIMETER, COMPASS, THERMOMETER and others | [V] |
| System events (App Service) | 3.0 | event name in `permissions` | sleep state change, abnormal HR, stress reminder, wear state, sleep-mode toggle | [V] |
| `createSysTimer`/`stopTimer` in `@zos/timer` | **4.0** | – | system timer that works in App Service and with the screen off | [V] |
| Watch face `data_type.*` with `IMG_LEVEL`, `TEXT_IMG` and similar | watch face API | – | *display* HEART, STRESS, SPO2, TRAINING_LOAD, VO2MAX, RECOVERY_TIME, READINESS, ALTITUDE and more; `IMG_CLICK` can jump to OUTDOOR_RUNNING, WALKING, OUTDOOR_CYCLING, FREE_TRAINING, POOL_SWIMMING, OPEN_WATER_SWIMMING | [V] (`docs/watchface/api/hmUI/widget/data_type.mdx`) |

---

## 4. Per-sensor details, caveats and doc errata

### 4.1 HeartRate (`sensor/HeartRate.mdx`) [V]

Methods:

- `getCurrent(): number`: meaningful **only inside `onCurrentChange`**.
- `onCurrentChange(cb)` / `offCurrentChange(cb)` (2.1): registering **starts continuous HR measurement**; unregistering stops it.
- `getLast(): number`: latest single or automatic-monitoring value.
  - The English doc says continuous results are *not* counted.
  - The Chinese doc and the v1 `HEART` doc say continuous measurement **also** updates `last`, so trust ZH and v1 **[V: conflicting docs]**.
- `onLastChange(cb)` / `offLastChange(cb)` (2.1).
- `getToday(): number[]`: per-minute values since 00:00, up to 1440 entries. A community capability map reports that unmeasured minutes read 0 on the device **[C: [RogueMeso map](https://github.com/SaintedRogue/RogueMeso/blob/HEAD/zepp-beacon/docs/api-capability-map.md)]**. How dense it is depends on the user's all-day HR monitoring interval **[I]**.
- `getDailySummary(): {maximum: {hr_value, time}}` (3.0).
- `getResting(): number`; `onRestingChange` / `offRestingChange` (3.0; starts a resting-HR measurement).
- `getAFibRecord(): Array<{flag 0 normal / 1 high alert / 2 low alert / 3 AFib, val, maxValue, minValue, time (UTC s), duration (s)}>` (3.0). Whether T-Rex 3 firmware fills this is unknown **[I]**.

Answers to the key questions:

- **Update rate:** undocumented. The ZH doc says "以一定频率更新" ("updates at a certain frequency"). Expect about 1 Hz **[I]**; measure it.
- **RR intervals, HRV, raw PPG:** **no API** on the watch **[V: absent from docs and from the 4.0.0 typings]**.
  - The old partner REST API had a "sensorData" archive with ACC and PPG files (behaviour tagging, 2017). It is cloud-side, business-only and legacy (`scratchpad/src/rest-api/api-sensor-doc.html`, updated 2017) **[V]**. Staff: "our rest-api is currently open for business cooperation only" **[C: [#194](https://github.com/orgs/zepp-health/discussions/194)]**.
  - Workaround **[I]**: connect a standard BLE HR strap (service 0x180D, characteristic 0x2A37, whose payload carries RR intervals in 1/1024 s units when flag bit 4 is set) through BLE central. This works in a foreground page only; BLE central is not allowed in App Service ([#559](https://github.com/orgs/zepp-health/discussions/559), docs). The official `easy-ble` example `scratchpad/src/easy-ble/examples/ble-master-metric-parse/pages/main.js` already subscribes to 0x2A37 but only decodes bpm.
- **In the simulator** `onChange`/`onCurrentChange` may not fire **[C: #182]**.

### 4.2 BloodOxygen (`sensor/BloodOxygen.mdx`) [V]

- `getCurrent(): {value, time, retCode}`. `retCode` values: 0 invalid, 1 still measuring, **2 success**, 3 failed, 4 not worn, 5 timeout, 6 bad wear, 7 bad signal, 8 low value, 9 high value, 10 invalid.
- `start()` / `stop()` (2.1): trigger a spot measurement. Call `stop()` first, then `start()`, and listen with `onChange`.
- `getLastDay(): number[24]`: hourly averages for the past 24 h. Which index is the most recent is undocumented.
- `getLastFewHour(hour): Array<{spo2, time (UTC s)}>` (3.0): chronological. The maximum `hour` is undocumented.
- No weekly history.

### 4.3 Stress (`sensor/Stress.mdx`) [V]

- `getCurrent(): {value, time}` and `onChange`.
- 3.0 history:
  - `getToday()`: per-minute, up to 1440.
  - `getTodayByHour()`: 24 values.
  - `getLastWeek()`: 7 values, **index 0 = six days ago, index 6 = today**.
  - `getLastWeekByHour()`: 168 entries of `{second (UTC), stress}`, where `stress` 0 means invalid.
- Caveats **[C: [#253](https://github.com/orgs/zepp-health/discussions/253)]**: `getCurrent()` returned 0 or 255 and `onChange` never fired on a GTR 4; staff confirmed a bug in 2023. Test it on the T-Rex 3. Stress monitoring must be enabled in the watch's health settings.

### 4.4 Sleep (`sensor/Sleep.mdx`) [V]

- `updateInfo()`: forces a refresh (the system otherwise refreshes every 30 min).
- `getInfo(): {score, deepTime, startTime, endTime, totalTime}`: start and end are minutes from 00:00 of "the day". Semantics across midnight are undocumented **[C: RogueMeso]**.
- `getStage(): Array<{model, start, stop}>`. Constants come from `getStageConstantObj(): {WAKE_STAGE, REM_STAGE, LIGHT_STAGE, DEEP_STAGE}`. The English doc mislabels `REM_STAGE` as "Deep sleep time"; ZH says "REM 阶段" (REM stage).
- `getSleepingStatus(): 0 | 1` (3.0); `getNap(): Array<{length, start, stop}>` (3.0).
- **Only the latest sleep.** There is no API for previous nights; staff said in Sept 2024 that it was "being worked on" **[C: [#371](https://github.com/orgs/zepp-health/discussions/371)]**, and it is still absent from the Sept 2026 docs **[V]**. Workaround: log each night yourself, for example from an App Service woken by `event:os.health.sleep_status` or run daily.
- Accuracy: a T-Rex 3 user reports over-detection of "awake" (10 times a night); staff are investigating **[C: [#531](https://github.com/orgs/zepp-health/discussions/531)]**.

### 4.5 BodyTemperature (`sensor/BodyTemperature.mdx`) [V]

- `getCurrent(): {current (°C), time}`. The English doc's result table is a copy-paste of Sleep text; ZH gives "current = temperature, time = last measurement time".
- `getToday(): number[288]`: 5-minute averages in °C; `-1000` means no measurement.

### 4.6 Step, Calorie, Distance, Stand, FatBurning [V]

- `getCurrent()`, plus `getTarget()` on Step, Calorie, Stand and FatBurning, plus `onChange`/`offChange`.
- **Today's totals only**: no hourly breakdown and no history.
- `Distance` unit is undocumented (metres empirically **[C]**).

### 4.7 Pai [V]

- `getTotal()`: 7-day rolling PAI.
- `getToday()`.
- `getLastWeek(): number[7]`, where **index 0 = today** (the opposite order to Stress).

### 4.8 Accelerometer and Gyroscope (`sensor/Accelerometer.mdx`, `sensor/Gyroscope.mdx`) [V]

- `start()`, `stop()`, `getCurrent(): {x, y, z}`, `onChange(cb)`, `offChange(cb)`, `setFreqMode(FREQ_MODE_LOW | FREQ_MODE_NORMAL | FREQ_MODE_HIGH)`, `getFreqMode()`.
- Units: accelerometer **cm/s²**; gyroscope **deg/s**.
- Axes: x and y are parallel to the screen; z is perpendicular, positive pointing out of the screen.
- Samples have **no timestamp field**. The docs say the `onChange` callback takes no arguments, but the official sample `zeppos-samples/application/3.0/3.0-feature/pages/acc.js` reads `cb_info.x` from a callback argument. Use `getCurrent()` to be safe.

Answers to the key questions:

- **Hz per mode:** not published anywhere; the docs are qualitative only **[V]**. Every community project says "measure it" ([Dofek](https://github.com/Asherlc/dofek/blob/HEAD/packages/zepp/README.md), [fall-detection](https://github.com/katatsu12/fall-detection)).
- **Delivery pattern:** on a Balance (Dec 2023), callback gaps followed a cycle of about 500 ms, then 12 ms, then about eight 4 ms gaps, then the cycle repeated. That suggests batched FIFO delivery of roughly 10 samples every ~0.5 s (about 18–20 Hz effective, **[I]** from that cadence), and `FREQ_MODE_HIGH` had no visible effect **[C: [#282](https://github.com/orgs/zepp-health/discussions/282)]**. Staff said they would investigate; firmware may have changed since.
- **Actual unit and resolution (inference from logged T-Rex Ultra data in [#370](https://github.com/orgs/zepp-health/discussions/370)) [I]:**
  - Every logged value is an exact integer multiple of 0.244140625 = 1000/4096. Examples: x = 198.486328125 = 813 × 0.244140625; z = 976.318359375 = 3999 × 0.244140625.
  - The magnitude at rest is about 998–1015.
  - So the values behave like **milli-g at 4096 counts/g**, meaning about 0.24 mg resolution and likely a ±8 g range for a 16-bit sensor. They do not behave like true cm/s², which would give about 981 at rest.
  - For rep counting this 2 % scale difference is irrelevant. For physics, calibrate against gravity.
- **Screen off:** the page is destroyed after the screen turns off, and then the app exits **[C: #370]**. The docs say the system quits a Mini Program about 10 s after screen-off (`display/setWakeUpRelaunch.mdx`) **[V]**. To keep sampling you must keep the screen on (see §11.1), which costs battery.
  - A staff-suggested workaround: an **API_LEVEL 3.0 watch face** can use `Accelerometer` and `Gyroscope` and keeps executing in AOD **[C: #370, silver-zepp]**. Watch faces are covered by another agent.
- **Inside a Workout Extension:** works while the extension is focused. A T-Rex 3 Pro developer ran an accelerometer fall-detection pipeline (impact, then stillness, then alert) that "works perfectly during cycling and hiking workouts" **[C: [#554](https://github.com/orgs/zepp-health/discussions/554)]**.
- **Good enough for rep counting and motion analysis?** **[I]**
  - Rep counting of gym movements (0.2–1.5 Hz fundamental frequency), jump counting and gesture or wrist-orientation detection: **yes**, at about 15–25 Hz with ~0.5 s latency, in a foreground page or focused extension.
  - Barbell velocity or VBT, tremor, stroke micro-analysis, or anything that needs precise inter-sample timing or more than 50 Hz: **no**. Rates are unknown, delivery is jittery, there are no timestamps, and QuickJS processing is limited (one app reported out-of-memory reboots on long recordings **[C: [HAMGIS README](https://github.com/HaohanHe/HAMGIS)]**).
  - Note that the **system's own strength-training mode already counts sets and reps**, and an extension can display those counts (`SPORT_DATA` `COUNT_CUR_FITNESS`, `OTHER_ACTIONNAME`, `OTHER_SECTION_ORDER`) **[V]** / [C: #555].

### 4.9 Barometer (`sensor/Barometer.mdx`) [V]

- `getAirPressure()` (hPa), `getAltitude()` (m), `onChange` / `offChange`. **No `start` and no `setFreqMode`** (typings 4.0.0 confirm this).
- Measured behaviour **[C]**:
  - Balance 2, API_LEVEL 4.2: `onChange` fires about **once every 80 s** (12 events in 1000 s). Polling the getters at 4 Hz returns the same cached value. Altitude standard deviation is about 0.25 m ([#539](https://github.com/orgs/zepp-health/discussions/539)).
  - Balance, API_LEVEL 3.7: integer hPa (about 8.4 m steps), refresh every ~10 s or more, `onChange` never fired.
  - Balance 3, API_LEVEL 4.4: fractional hPa, but the refresh is still tens of seconds, even during a native Hiking workout ([#525](https://github.com/orgs/zepp-health/discussions/525), [#526](https://github.com/orgs/zepp-health/discussions/526)).
  - In an App Service polled with `createSysTimer`, 5 s was the fastest stable interval (500 ms destabilised the service), and altitude changes took at least 10 s to show ([#535](https://github.com/orgs/zepp-health/discussions/535)).
  - Staff: "we will conduct a detailed evaluation" (July 2026). One developer gave up and sold the watch ([#508](https://github.com/orgs/zepp-health/discussions/508)).
- **Inside a workout:** `getSportData({type:'altitude'})` gives 1 m resolution at about 1 Hz. The unit and rate of `vertical_speed` are undocumented [C: #525].
- **Water depth: not measurable** with this API on the T-Rex 3 (a 10 m dive read about 0.2 m). A freediving extension can only *display* depth via `SPORT_DATA` `sport_data.DEPTH`, `DEPTH_MAX` and related items under subType 196/197 **[C: [#563](https://github.com/orgs/zepp-health/discussions/563)]**.
- `Geolocation` exposes **no altitude**, so the barometer and `getSportData` are the only altitude sources.

### 4.10 Compass (`sensor/Compass.mdx`) [V]

- `start()`, `stop()`, `getStatus(): boolean` (calibrated or not), `getDirection()` (N/NE/E/SE/S/SW/W/NW for the 12 o'clock direction), `getDirectionAngle(): 0–360 | 'INVALID'` (clockwise from north; `'INVALID'` if uncalibrated), `onChange` / `offChange`.
- **API_LEVEL 4.0:** `setFreqMode` / `getFreqMode` (LOW/NORMAL/HIGH, Hz undocumented). This is available on the T-Rex 3.
- The official sample (`3.0-feature/pages/compass.js`) tells users to calibrate in the system Compass app. It also reads the undocumented property `compass.calibration_status`.
- Whether the heading is true or magnetic north is undocumented **[I]**.

### 4.11 Geolocation (`sensor/Geolocation.mdx`) [V]

Methods:

- `start()`, `stop()`.
- `getStatus(): 'A' | 'V'` ('A' = positioning, 'V' = invalid).
- `getLatitude({format:'DD'|'DMS'})`, `getLongitude(...)`: WGS-84, a number (DD) or `{direction, degrees, minutes, seconds}` (DMS).
- `onChange` / `offChange`.
- `getSetting(): {mode}` (3.0): the *system* positioning mode. 0 Accuracy, 1 Automatic, 2 Balance, 3 Power Saving, 4 Super Power Saving, 5 Custom. Read-only; an app cannot set it.
- `onGnssChange(cb(info))` / `offGnssChange` (3.0). `info` contains `agps_inject_time` (ms), `top4_cn_val` (signal strength), `is_dualband`, `nb_valid_satellite`, `nb_used_satellite`, `elapsed_time` (time to fix, s) and `satellite_data[]`. Each `satellite_data` entry has `{gnss_id 0 GPS / 1 BDS / 2 GLONASS / 3 GALILEO / 4 QZSS / 5 IRNSS, sub_top4_cn_val, nb_valid_satellite, gsv_data[≤32]: {id, elevation, azimuth, snr} (3.6)}`.
- `getEnabled()`, `onEnableChange` / `offEnableChange` (4.0): whether the user allows location for Mini Programs.

Missing entirely: **speed, course or bearing, altitude, horizontal accuracy (HDOP or metres), per-fix timestamp.** Compute speed from successive fixes yourself, or use `getSportData('speed')` in a workout (staff advice in [#292](https://github.com/orgs/zepp-health/discussions/292)).

- **Fix rate:** undocumented; probably about 1 Hz **[I]**, so measure it.
- **Accuracy:** in system workouts the T-Rex 3's multiband GNSS tested well (running and mountain cycling), with wobbly open-water swimming **[C: DC Rainmaker]**. Mini Program fixes probably use the same receiver under the current system mode **[I]**.
- **Background:** **not available in App Service** **[V]**. Staff confirmed that background GPS calls are not allowed ([#281](https://github.com/orgs/zepp-health/discussions/281), [#447](https://github.com/orgs/zepp-health/discussions/447)) **[C]**.
- **Relation to the system workout GPS:** nothing is documented. A community Workout Extension (YeRun Trail) calls `Geolocation` from inside the extension during a workout and projects the position onto a route **[C: [YeRun-Trail](https://github.com/1445688048/YeRun-Trail)]**. With API_LEVEL 4.2, `Workout.getWorkoutTrackNavInfo()` exposes the system's own route-navigation state (off-course flag, off-course distance and angle, remaining distance, next turn).
- **Power:** no numbers for Mini Programs. Amazfit claims 42–180 h of GPS depending on mode **[C: DCR]**. In a Mini Program the screen that must stay on is probably the larger cost **[I]**.
- **Maps:** there is no map API ("currently no open map interface", staff 2023 [C: #281]). Community apps draw their own canvas maps ([HAMGIS](https://github.com/HaohanHe/HAMGIS)).

### 4.12 Workout sensor (`sensor/Workout.mdx`) [V]

- `getStatus(): {vo2Max, trainingLoad, fullRecoveryTime}` (3.0). The English doc wrongly says "Get altitude value in meters"; ZH says "获取运动状态" ("get workout status"). The official sample guards with `if (status)`.
- `getHistory(): Array<{startTime, duration (s)}>` (3.0). The unit of `startTime` is undocumented (Dofek treats it as epoch seconds **[C]**). How many entries or how far back is undocumented. **No sport type, distance, calories, HR or track.**
- `getUserHrZoneSettings(): {type 0 = heart-rate reserve / 1 = max HR, rest, range[6]}` (**4.2**). The 6 values are zone boundaries: warm-up/relax, fat-burn, cardio, endurance, anaerobic, and max HR (names from ZH; the English "Ligit" is a typo). Example: `{"type":1,"rest":70,"range":[90,108,126,144,162,181]}`.
- `getWorkoutTrackNavInfo(): {update, isYaw, yawAngle, yawDistance (m), remainDistance (m), turnDistance (m), turnType 1–9} | undefined` (**4.2**; returns `undefined` when not navigating).

### 4.13 Wear, Screen, Battery, Time and the output "sensors" [V]

- `Wear.getStatus()`: 0 not worn, 1 worn, 2 in motion, 3 unsure. Also system event `event:os.health.wear_status`.
- `Screen.getStatus()`: 1 on, 2 off. `getAodMode()` (the docs say boolean, the typings say number). `getLight()` in lux (3.6).
- `Time`: `onPerMinute` is the practical background tick for App Service.
- `Vibrator.start({mode})` scenes: `VIBRATOR_SCENE_SHORT_LIGHT/MIDDLE/STRONG` (20 ms), `DURATION` (600 ms), `DURATION_LONG` (1 s), `STRONG_REMINDER`, `NOTIFICATION`, `CALL`/`TIMER` (continuous; call `stop()` yourself). Since 3.6, `start([{type, duration}])` accepts a sequence built from `getType()` scene constants. A haptic variometer running as a Workout Extension exists **[C: #526]**, so haptics work inside extensions.

### 4.14 Doc errata worth knowing [V]

Mostly English docs; the ZH translations usually fix them.

- `getSportData.mdx` description is copy-pasted from `setWakeUpRelaunch`. ZH: "获取运动实时数据" ("get real-time workout data").
- The `pace` example shows `avg_pace` keys. Community code reads `d.pace || d.avg_pace`, and notes that some firmware returns `duration` as plain seconds instead of "h:mm:ss" **[C: [RunDeck metrics.js](https://github.com/andrejd1/rundeck/blob/HEAD/data-widget/common/metrics.js)]**.
- `checkSensor` result text mentions "auto-brightness"; it actually returns whether the sensor is available.
- `Workout.getHistory` is described as "duration of the workout record"; it returns a list.
- `Accelerometer` and `Compass` examples call `offChange()` without the callback.
- `Vibrator` example passes a constant to `setMode` instead of `{mode}`.
- `Stress.getToday` shows a `StressInfo` table but returns `number[]`.

---

## 5. Key questions: answers

| Question | Answer | Tag |
|---|---|---|
| Max raw accelerometer or gyroscope rate? Batching? Precision? | No published Hz; only LOW, NORMAL and HIGH. Bursty batched delivery observed (about 0.5 s gaps, roughly 18–20 Hz effective on a 2023 Balance). No timestamps. Resolution about 0.24 mg (4096 counts/g); docs say cm/s², data behaves like mg. Gyroscope in deg/s. | [V] modes; [C] rate; [I] unit |
| Good enough for rep counting? | Yes for coarse reps and gestures in the foreground; no for precise kinematics. The system strength mode already counts reps. | [I] |
| Real-time HR in our app? | Yes: `onCurrentChange` starts continuous optical HR in a page or extension. Rate undocumented (probably about 1 Hz). | [V]/[I] |
| RR intervals, HRV, raw PPG? | **No** from the watch sensor. Only via an external BLE strap (foreground). | [V]/[I] |
| Historical HR, sleep, stress, SpO2, steps? | HR: today per minute. Sleep: last night (stages and score). Stress: 7 days hourly. SpO2: 24 h hourly plus last N hours with timestamps. PAI: 7 days. Temperature: today (5 min). Steps, calories, distance: today's total. Nothing older, and no sleep history. | [V] |
| VO2max, training load, recovery, readiness, BioCharge, HR zones? | VO2max, 7-day training load and full recovery time via `Workout.getStatus()` (3.0). HR zones via `getUserHrZoneSettings` (4.2). Aerobic/anaerobic TE and live training load are display-only via `SPORT_DATA`. Readiness is display-only via watch face `data_type.READINESS`, or `launchApp(SYSTEM_APP_READINESS)`. BioCharge, HybridCharge and HRV: none. | [V] |
| GPS fix rate, accuracy info, altitude, satellites, power, background, relation to workout GPS? | Rate undocumented (probably 1 Hz). No accuracy figure, only A/V status plus rich satellite info (count, CN0, dual-band, per-satellite SNR, elevation and azimuth). No altitude or speed. Foreground only. Mode follows the system setting (read-only). Usable inside a Workout Extension; route-navigation state at 4.2. | [V]/[C]/[I] |
| Barometer and altitude? | Slow and cached (about 80 s events); no rate control; use `getSportData('altitude')` (~1 Hz) during workouts. | [C] |
| Compass frequency (4.0)? | `Compass.setFreqMode` / `getFreqMode` exist from API_LEVEL 4.0, so they work on the T-Rex 3. Hz undocumented. | [V] |

---

## 6. Workout Extension: deep dive

Sources: `docs/guides/workout-extension/{intro,quick-start,distribute}.mdx`, their ZH versions, `docs/reference/device-app-api/newAPI/global/DataWidget.mdx`, `.../ui/widget/SPORT_DATA.mdx`, `.../app-access/getSportData.mdx`, and samples in `zeppos-samples/workout-extensions/3.5/*`.

### 6.1 What it is [V]

- A plugin that adds **data pages inside the system "Workout" app**, drawn with the normal JS widget API. It is a Zepp OS 3.5 feature that requires **API_LEVEL ≥ 3.6**.
- Officially listed devices: T-Rex 3, Cheetah Pro, Cheetah (Round and Square), T-Rex Ultra and Falcon (`intro.mdx`). The 2024 competition page listed only the Cheetah/Ultra/Falcon devices ([competition](https://developer.zepp.com/os-post/workout-extension-competition)).
- The T-Rex 3 user manual allows **"up to 4 pages of workout extensions"** and up to 10 data or chart pages per workout **[V: [T-Rex 3 manual PDF](https://support.amazfit.com/en/amazfit_t-rex_3/files/user-manual.pdf.pdf)]**.
- **Several extensions can run at once** (the configuration is multi-select) **[V]**.
- It is a separate application with its **own appId**, created, submitted and reviewed separately.

### 6.2 app.json [V]

Official samples use `"extType": "workout"` in the `app` block. The pinned-bar toggle is `window.isPinned` (defined in ZH):

- `isPinned: 0` shows the floating battery and time bar (68 px tall on a 480 px round screen).
- `isPinned: 1` hides it, so the extension gets the full screen.

```json
{
  "configVersion": "v3",
  "app": { "appId": 0, "appName": "My Ext", "appType": "app", "extType": "workout",
           "version": { "code": 1, "name": "1.0.0" }, "icon": "icon.png", "vender": "me" },
  "permissions": ["data:user.hd.workout", "data:user.hd.heart_rate", "device:os.accelerometer"],
  "runtime": { "apiVersion": { "compatible": "3.6", "target": "4.0", "minVersion": "3.6" } },
  "targets": { "common": {
    "module": {
      "data-widget": { "widgets": [ {
        "path": "data-widget/index", "name": "My Ext", "icon": "icon.png",
        "window": { "isPinned": 1 },
        "runtime": { "ability": [ { "type": 1, "subType": [52, 49, 24] } ] }
      } ] }
    },
    "platforms": [ { "st": "r" } ], "designWidth": 480 } }
}
```

- `widgets` is capped at **1 per appId** ("multiple may be supported later").
- `ability.type` must be `1`.
- `subType` is a list of sport ids; `[]` means all sports. Relevant ids: 1 Outdoor Running, 2 Treadmill, 3 Walking, 4 Outdoor Cycling, 5 Free Training, 8 Indoor Riding, 10 Mountaineering, 11 Trail Running, 15 Hiking, 21 Jump Rope, 23 Rowing Machine, **24 Indoor Fitness, 49 HIIT, 50 Core, 52 Strength Training**, 53 Stretching, 60 Yoga, 130 Cross-training, 196/197 Freediving, 203 Ultra Marathon. The full table is in `quick-start.mdx`.
- Community packages also include `page` (normal app-list pages), `app-side` and `setting` modules in the same extension package ([RunDeck app.json](https://github.com/andrejd1/rundeck/blob/HEAD/app.json), [YeRun Trail](https://github.com/1445688048/YeRun-Trail)) **[C]**. However, [#554](https://github.com/orgs/zepp-health/discussions/554) reports that "registering a Side Service together with a data-widget module fails to build" on their setup, so treat this as untested for us.

### 6.3 Lifecycle [V]

`DataWidget({ state, onInit, build, onResume, onPause, onDestroy })`, one call per file.

- When the user adds the plugin, `app.js onCreate` runs, then the widget's `onInit` and `build`. The app then enters **"Pause"**.
- **`onResume` fires when the page gains focus and `onPause` when it loses focus.**
- In Pause, **context is kept but registered callbacks are not delivered and timers are suspended.**
- The native workout keeps running while your page is paused, but *your* code does not see it.
- This is the biggest practical limitation **[C]**:
  - "It stops all communication with the BLE device and SportData metrics" ([#433](https://github.com/orgs/zepp-health/discussions/433)).
  - You cannot collect data across the whole workout unless your page stays focused ([#535](https://github.com/orgs/zepp-health/discussions/535), Dofek README).
  - Staff (June 2025) said improvements were planned; nothing new appears in the docs.
- The simulator shows extensions in the app list. **On a real watch they appear only inside Workout** **[V]**.

### 6.4 What real-time data it can read [V]

**Readable as numbers:** `getSportData({type}, cb)`. The callback receives `{code, data}`; `data` is a JSON **string** holding an array of `{<type>: "<string value>", name}`. Types:

- `speed`, `avg_speed`, `pace`, `avg_pace`, `distance`, `duration`, `calories`
- `cadence`, `avg_cadence`
- `altitude`, `total_up_altitude`, `vertical_speed`
- `total_count`, `downhill_count`, `total_downhill_distance`

Values are strings in display units (for example distance "9.99" presumably km, pace "5'38''"). Community behaviour notes **[C]**:

- Each call is a one-shot IPC; poll it yourself, for example with a 1 Hz `setInterval` (RunDeck).
- An undocumented `power` type is probed by RunDeck.
- There is a strange `state_error` field that is the only way to infer paused state (#433).

Also readable: your own sensors while focused, namely `HeartRate.onCurrentChange`, `Accelerometer`, `Gyroscope`, `Geolocation`, `Compass`, `Vibrator` and `Time` (community extensions use all of these **[C]**).

**Display-only:** `createWidget(widget.SPORT_DATA, {edit_id, category: edit_widget_group_type.SPORTS, default_type: sport_data.X, x, y, w, h, text_*, sub_text_*, rect_visible, line_color, mock_data})`. The system renders the value and **JS cannot read it**. There are about 200 items, including:

- HR: `HR`, `HR_AVG`, `HR_INTERVAL` (zone), `HR_MAX_PERCENT`, `HR_RESERVED_PERCENT`, per-segment HR.
- Pace and distance: `PACE*`, `DISTANCE_*`.
- Stride and cadence: `STRIDE*` (cadence, stride length).
- `SPEED*`, `ALTITUDE*`, `SLOPE*`.
- Power: `DEVICE_POWER*` (3 s, 10 s and 30 s power from a BLE power meter), `DEVICE_CADENCE*`.
- Strength and sets: `COUNT_CUR_FITNESS`, `OTHER_ACTIONNAME`, `OTHER_SECTION_ORDER`, `DURATION_CUR_GROUP`.
- Training: `OTHER_AEROBIC_TE`, `OTHER_ANAEROBIC_TE`, `OTHER_TRAIN_LOAD`.
- Swim: `SWIM_*` (SWOLF, strokes).
- Diving: `DEPTH*`, `DURATION_CUR_DIVING`.
- Charts: `CHART_HR`, `CHART_PACE`, `CHART_ALTITUDE` and others.
- `TEMP*`, `PRESSURE*`.

**Not exposed at all** **[C: RunDeck README]**: GAP (grade-adjusted pace), vertical oscillation, ground contact time, planned or structured workout steps, native auto-laps, and the current sport type or subType (#433).

### 6.5 UI constraints [V]

- Single page with no scrolling. No `SCROLL_LIST`, `VIEW_CONTAINER`, `PAGE_INDICATOR` or `SCROLL_BAR`.
- **No swipe, no gesture listening and no button response.** `CLICK` events on widgets are supported.
- The drawing area is the screen itself (480×480 on the T-Rex 3).
- Conflict: RunDeck registers `onKey` for `KEY_SHORTCUT` (the lap key) from within the DataWidget and returns `false` so the native lap still happens **[C]**. That contradicts "no button response", so verify on a device.

### 6.6 BLE, network and storage

- **BLE central (external sensors):** officially a "core value" (for example cadence sensors) **[V: intro]**. A community prototype streamed metrics to Engo HUD glasses from an extension (Bip 6), but the connection stops whenever the page is unfocused **[C: #433]**.
- **Network or phone:**
  - The docs intro says extensions "will be able to" sync to the cloud **[V]**, and the 2024 competition said network was "not yet open" **[V/C]**.
  - The official sample `running-pace-master-with-side-service` uses ZML `BasePage` and `this.request()` to a Side Service **[V: sample]**.
  - **But [#554](https://github.com/orgs/zepp-health/discussions/554) (T-Rex 3 Pro, firmware 6.3.13.5, Aug 2026) reports that `this.request()`, `sendAppMessage` and `peerSocket` are "NOT A FUNCTION" in a DataWidget, that ZML BasePage is unavailable, that a Side Service combined with data-widget fails to build, and that the official sample is "not functional"** **[C]**.
  - RunDeck (Sept 2026) still ships `this.request()` inside its DataWidget, wrapped in try/catch **[C]**.
  - **Treat phone messaging from the extension as broken until proven on your watch.** The robust pattern is for a normal app page (same appId) to do the phone sync and write a local file or LocalStorage entry, which the extension reads (YeRun Trail's pattern) **[C/I]**.
- **Storage:** LocalStorage and `@zos/fs` are used by community extensions (RunDeck, YeRun) **[C]**. No doc restriction **[V]**.

### 6.7 How the user adds it [V]

1. In the Zepp App: Device → App Store → Workout Extensions module → install. [Amazfit support](https://support.amazfit.com/en/amazfit_t-rex_3/docs/HMqMdjg5voGtAGxetYmcgevvnbd).
2. On the watch: choose the workout → Settings → More → Data Page → Add Page → tick the extension.

Adding it is per sport type: supporting all subTypes does not add the page to every workout automatically **[C: Dofek audit]**. During development, preview via developer mode or bridge like any Mini Program, then add it inside Workout **[V]**.

### 6.8 Distribution and review [V]

`distribute.mdx`:

- Separate registration and appId. The category is automatically "Workout Extension".
- The name must differ from your Mini Program's name (for example "Go Pro Extension").
- The store icon is 240×240 PNG, and **the store overlays a logo at the top of the icon**, so keep the top clear.
- Screenshots are 360×360 transparent PNGs.
- A privacy statement and the called permissions must be declared.
- Review takes 1–5 working days.

### 6.9 Can it write into the recorded workout? **No.** [V by absence] / [C]

- No API exists to add fields, labels, laps, markers or FIT developer fields, or to modify the record the system is building. There is nothing like Garmin Connect IQ `FitContributor`.
- A Sept 2026 feature request spells this out: "There is no API, in either direction, for an extension to write a value back onto the workout record" ([#555](https://github.com/orgs/zepp-health/discussions/555)).
- The extension cannot start, pause, stop or lap the workout either ([#433](https://github.com/orgs/zepp-health/discussions/433)). Detecting the physical lap key via `onKey` and returning `false` lets the native lap proceed while your code observes it [C: RunDeck].
- Any extension-collected data can only live in your own storage or pipeline.

---

## 7. Own workouts, controlling the system workout, and past workouts

| Question | Answer | Tag |
|---|---|---|
| Can a third-party app record its **own** workout into Zepp health data (so it counts toward Zepp stats, PAI and VO2max, or syncs to Strava or Apple Health)? | **No.** No workout-write API on the watch. The only health write is `addHealthData({weight (g), bmi (×100)})` (3.0). Staff (2022): creating new workout types is "not supported" ([#12](https://github.com/orgs/zepp-health/discussions/12)). Workout templates cannot be pushed either ([#494](https://github.com/orgs/zepp-health/discussions/494), unanswered, Feb–Jul 2026). The official partner REST API only has GET endpoints for activities, sleep, heart rates, sports list and `sportDetail`, plus `POST /notifications`, and is business-only (`rest-api/api-doc.html`, updated 2020). | [V]/[C] |
| Then how do I get my own workout to Strava? | Record it yourself in a foreground Mini Program (GPS, HR, IMU), store it on the watch, transfer it to the phone (Side Service or `TransferFile`), and upload to Strava's API from the Side Service. The data never enters Zepp or Apple Health through Zepp. The phone-connectivity agent covers the plumbing. | [I] |
| Start or control the system workout, or launch a specific sport? | `launchApp({appId: SYSTEM_APP_SPORT, native: true})` opens the Workout app. `SYSTEM_APP_SPORT_HISTORY` and `SYSTEM_APP_SPORT_STATUS` also exist (3.0). **No documented parameter selects or auto-starts a sport**; this was asked in [#525](https://github.com/orgs/zepp-health/discussions/525) without an answer. No start, pause or stop API. Watch faces can use `IMG_CLICK` with `data_type.OUTDOOR_RUNNING`, `WALKING`, `OUTDOOR_CYCLING`, `FREE_TRAINING`, `POOL_SWIMMING` or `OPEN_WATER_SWIMMING` to jump to a sport. On Zepp OS 6 the user can map the shortcut key to a workout (a system setting, not an API). | [V]/[C] |
| Read the list of past workouts? | `Workout.getHistory()` returns only `{startTime, duration}` per workout; depth is undocumented. No type, distance, HR, route or laps. Richer history requires cloud access (partner REST `sports` and `sportDetail`, business-only), the Zepp app's own exports, or Gadgetbridge on Android, which fetches T-Rex 3 workouts with GPX, HRV and sleep stages ([Gadgetbridge Zepp OS](https://gadgetbridge.org/basics/topics/zeppos/)). | [V]/[C] |
| Read the *current* running workout's live data? | Yes, via `getSportData` (Workout Extension context, 3.6). Whether it works from a normal Mini Program while a workout runs in the background is **undocumented or untested**. | [V]/[I] |

---

## 8. Background sensor access (the sensor side of App Service)

`docs/guides/framework/device/app-service.md` **[V]**:

| In App Service | Availability |
|---|---|
| `Accelerometer`, `Geolocation`, `Gyroscope` ("high power") | **NO** |
| Other `@zos/sensor` classes ("such as HeartRate") | YES |
| `setTimeout`/`setInterval` | **NO**. Use `Time.onPerMinute()`, `createSysTimer` (4.0) or `@zos/alarm`. |
| `@zos/ble` `mst*` (BLE central) | **NO** [V]. For watch faces, [#559](https://github.com/orgs/zepp-health/discussions/559) has one developer saying they are blocked too and another saying they work (disputed [C]) |
| `@zos/fs` writes | only while the screen is off or in AOD |
| `@zos/ui` | NO |

Cadence options:

- **Single execution**, woken by `@zos/alarm`, a notification action or a **system event**: **600 ms execution budget** **[V]**.
  - Health-relevant events: `event:os.health.sleep_status`, `event:os.health.heart_rate_abnl` (the system's high/low HR alert), `event:os.helath.stress_remind`, `event:os.health.wear_status`, `event:os.system.sleep_mode`.
- **Continuous**: needs `device:os.bg_service` plus runtime approval. Only **one** continuous service runs system-wide, and the user picks when there is a conflict.
  - `reload: true` (4.0) restarts it after reboot, power-mode, language and app updates **[V]**.
  - Ticks come from `Time.onPerMinute` (1/min) **[V]** or `createSysTimer(periodic, ms, cb)` (4.0) **[V]**.
  - Community: polling every 5 s is stable, 500 ms destabilised the service ([#535](https://github.com/orgs/zepp-health/discussions/535)) **[C]**.
  - Minute-level HR, SpO2, body temperature and workout-history logging each minute is the Dofek design ([Dofek README](https://github.com/Asherlc/dofek/blob/HEAD/packages/zepp/README.md)) **[C]** (design-level; its hardware audit is pending).
- **Unverified [I]:**
  - Whether `HeartRate.onCurrentChange` (continuous optical HR) is honoured in the background. Documented as available, but battery and system policy may throttle it; a community HR-alert service uses it ([ASU project](https://github.com/MyAlyce/ASU_OD_detection_project/blob/HEAD/client/app/app-service/hrMonitor.js)).
  - Whether `Compass` works in the background.
  - Reading `getLast()` or `getToday()` each minute is the safe low-power pattern.

---

## 9. Community findings and open-source apps

### 9.1 GitHub discussions (the forum is active; staff reply within days)

| # | Date | Topic | Finding |
|---|---|---|---|
| [282](https://github.com/orgs/zepp-health/discussions/282) | 2023-12 | Accelerometer rate | Bursty 500/12/4 ms gaps; `FREQ_MODE_HIGH` no effect (Balance) |
| [370](https://github.com/orgs/zepp-health/discussions/370) | 2024-09 | IMU with screen off | Page and app destroyed after screen-off (T-Rex Ultra); AOD 3.0 watch face workaround; raw log values |
| [396](https://github.com/orgs/zepp-health/discussions/396) | 2024-12 | Keep display on (HR-zone app, T-Rex 2) | `pauseDropWristScreenOff({duration:0})`, `pausePalmScreenOff({duration:0})`, `setWakeUpRelaunch({relaunch:true})`, `setPageBrightTime` |
| [433](https://github.com/orgs/zepp-health/discussions/433) | 2025-06 | Workout Extension + BLE HUD | Limited `getSportData`, no power or segments, no status or sport type, pause kills BLE, no start/stop API |
| [525](https://github.com/orgs/zepp-health/discussions/525)/[526](https://github.com/orgs/zepp-health/discussions/526)/[535](https://github.com/orgs/zepp-health/discussions/535)/[539](https://github.com/orgs/zepp-health/discussions/539)/[508](https://github.com/orgs/zepp-health/discussions/508) | 2026-05..08 | Barometer | Slow and cached; no `setFreqMode`; 5 s App Service poll; runtime permission needed; `getSportData` altitude ~1 Hz |
| [554](https://github.com/orgs/zepp-health/discussions/554) | 2026-08 | Extension ↔ phone | Messaging and Side Service not available in DataWidget on T-Rex 3 Pro 6.3.13.5; accelerometer fall detection in an extension works |
| [555](https://github.com/orgs/zepp-health/discussions/555) | 2026-09 | Write to workout | No write path from extensions (feature request) |
| [559](https://github.com/orgs/zepp-health/discussions/559) | 2026-09 | BLE central in background | Not possible (App Service or watch face); foreground page only |
| [563](https://github.com/orgs/zepp-health/discussions/563) | 2026-09 | Depth on T-Rex 3 | Barometer can't do water depth; `SPORT_DATA` DEPTH display-only |
| [564](https://github.com/orgs/zepp-health/discussions/564) | 2026-09 | T-Rex 3 on Zepp OS 6 | `Music` sensor regression; confirms T-Rex 3 on Zepp OS 6, runtime jsrt-4.5.0 |
| [371](https://github.com/orgs/zepp-health/discussions/371) | 2024-09 | Sleep history | Previous nights unavailable |
| [253](https://github.com/orgs/zepp-health/discussions/253) | 2023-10 | Stress sensor | 0 or 255 values, `onChange` not firing (GTR 4) |
| [281](https://github.com/orgs/zepp-health/discussions/281)/[447](https://github.com/orgs/zepp-health/discussions/447) | 2023/2025 | GPS in background | Not allowed |
| [531](https://github.com/orgs/zepp-health/discussions/531) | 2026-07 | T-Rex 3 sleep | Over-detects awake periods |

### 9.2 Open-source apps using these APIs

- **[Asherlc/dofek](https://github.com/Asherlc/dofek)** (`packages/zepp`, active Sept 2026): targets the T-Rex 3 and T-Rex 3 Pro.
  - A foreground raw IMU recorder (auto-detects the gyroscope with `checkSensor`, measures delivered Hz, uses a binary format, `TransferFile` and ZML chunks).
  - An App Service that logs minute-level HR, SpO2 and temperature plus workout history.
  - A separate Workout Extension that captures `getSportData`, HR and IMU while focused.
  - Its [capture audit](https://github.com/Asherlc/dofek/blob/HEAD/docs/zepp-capture-audit.md) lists the physical-watch tests as *not yet performed*.
  - It is the best reference architecture for data-logging ideas.
- **[andrejd1/rundeck](https://github.com/andrejd1/rundeck)** (Sept 2026): a paid running dashboard Workout Extension.
  - Uses `getSportData` polling, `HeartRate` and `Workout.getUserHrZoneSettings` (4.2), with a fallback.
  - Overlays `SPORT_DATA` widgets for the fields JS cannot read.
  - Implements its own laps via `onKey` and a Polar.sh licence through the Side Service.
  - Its README documents which metrics are native-only.
- **[1445688048/YeRun-Trail](https://github.com/1445688048/YeRun-Trail)**: a trail-race checkpoint planner.
  - The phone parses GPX; the watch page pulls a race package over BLE into a local file.
  - The Workout Extension reads that file and uses `Geolocation` plus `getSportData` for checkpoint progress.
- **[HaohanHe/HAMGIS](https://github.com/HaohanHe/HAMGIS)**: a field GIS and area-measurement app. Uses GNSS (`onGnssChange`, satellite view), a barometer, a canvas mini-map and CSV/GeoJSON export. Warns about out-of-memory crashes on long timed sampling.
- **[katatsu12/fall-detection](https://github.com/katatsu12/fall-detection)**: a foreground accelerometer fall detector (Amazfit Active).
- **[mohansella/zepp-hr-zone](https://github.com/mohansella/zepp-hr-zone)**: a fat-burn HR-zone vibration app (T-Rex 2) using keep-awake tricks.
- **[gabera/altimeter-zeppos](https://github.com/gabera/altimeter-zeppos)**: a barometric altimeter; abandoned because of barometer rate limits.
- **[66Bunz/zeppos-we-default-speed-in-knots](https://github.com/66Bunz/zeppos-we-default-speed-in-knots)**: a minimal extension. **[JMontes84/Enduro-Time-Tracker](https://github.com/JMontes84/Enduro-Time-Tracker)**: a Mini Program plus extension.
- Libraries and samples:
  - `zeppos-samples/application/3.0/3.0-feature` (acc, gyro, compass, GPS, HR, SpO2, stress, sleep, workout, bgService pages) [V].
  - `zeppos-samples/workout-extensions/3.5/*` [V].
  - `zml/examples/syncData` (HR sync) [V].
  - [mahmoudbahaa/zeppos-cross-api](https://github.com/mahmoudbahaa/zeppos-cross-api) (cross-API-version sensor wrappers) [C].

---

## 10. Possible and NOT possible for fitness and health use cases

### Possible (on the T-Rex 3)

- Live HR display, HR-zone alerts with haptics or beeps, and live HR logging in a **foreground** page. Keep the screen on via the display APIs.
- A **Workout Extension** (sits on top of a native, fully recorded and synced workout) that:
  - shows custom layouts, combining its own graphics with any `SPORT_DATA` field;
  - computes derived metrics from `getSportData` plus HR (lap or target logic, pace or HR targets, custom zone bars);
  - gives haptic cues;
  - reads the accelerometer or gyroscope while focused (fall detection, custom movement cues);
  - reads GPS while focused (checkpoint or route progress);
  - reads the system's route-navigation state (4.2).
- Strength-training companion: display the system's set and rep count plus the exercise name via `SPORT_DATA`, alongside your own UI, logged to local storage.
- Coarse **rep, jump or gesture counting** from the accelerometer and gyroscope in a foreground app or focused extension.
- Recording **your own GPS tracks**: lat/lon, derived speed, satellite quality in a foreground app, exported to the phone or cloud by your own pipeline.
- Daily health dashboards:
  - today's per-minute HR, resting HR, daily max HR;
  - 7-day stress, including hourly;
  - last-24 h SpO2 and on-demand spot SpO2;
  - last night's sleep score and stages, naps;
  - today's skin temperature;
  - PAI (7 days), steps, calories, distance, stand hours and fat-burn minutes against goals;
  - VO2max, training load, full recovery time;
  - HR zones (4.2).
- Background minute-level logging of low-power metrics (HR last value, SpO2, stress, temperature, steps) with `Time.onPerMinute` or `createSysTimer`, to build **your own long-term history**, including nightly sleep snapshots.
- Reacting to system events: abnormal HR alert, sleep-state change, wear on or off, stress reminder (single 600 ms execution).
- Writing weight and BMI into Zepp (`addHealthData`).
- Opening system health apps (Workout, History, Workout Status, HR, Sleep, SpO2, Readiness, Breathe and others) from your app.
- Using external BLE sensors (HR strap with RR intervals for HRV, power, cadence, trainers) in a foreground page; inside an extension only while focused. BLE central (API_LEVEL 3.0 `mst*`) support on the T-Rex 3 specifically was **not verified here**; see the connectivity research. In 2024 staff said BLE central worked "only on the Balance" (#292) **[C]**.

### NOT possible (or not supported)

- Raw PPG, beat-to-beat or RR intervals, or HRV values from the watch's optical sensor.
- Reading readiness, BioCharge/HybridCharge, HRV, respiration rate or training effect as numbers. Readiness and training effect are display-only (watch face or `SPORT_DATA`).
- History older than the API windows: previous nights' sleep, HR before today, steps by day or hour, detailed past workouts (type, distance, HR, route).
- High-rate, timestamped or guaranteed-rate IMU; configurable Hz.
- IMU, GPS or BLE central in the **background**, or while your app is not on screen. Mini Programs die about 10 s after screen-off unless kept awake.
- A fast barometer or variometer. Numeric water depth.
- Writing to the recorded workout: custom fields, labels, laps, FIT developer fields. Creating new sport types or templates. Starting, pausing, stopping or lapping the workout programmatically. Launching a specific sport (documented).
- Saving your own recorded workout into Zepp so that it syncs to Strava, Apple Health or Google Fit through Zepp, or counts toward Zepp's PAI, VO2max and training load.
- Continuous extension logic across the whole workout. It pauses when its page isn't focused. The extension also cannot learn the current sport type.
- Reliable phone or network messaging from inside a Workout Extension (currently reported broken on T-Rex 3 Pro firmware 6.3.13.5).
- Speed, heading, accuracy or altitude directly from `Geolocation`.

---

## 11. Code patterns

### 11.1 Continuous HR in a foreground page, kept alive [V APIs]

```js
// page/hr.js  (app.json permissions: ["data:user.hd.heart_rate"])
import { HeartRate } from '@zos/sensor'
import { setPageBrightTime, pauseDropWristScreenOff, pausePalmScreenOff,
         setWakeUpRelaunch } from '@zos/display'

const hr = new HeartRate()
const log = []
const onHr = () => {
  const bpm = hr.getCurrent()            // only meaningful inside onCurrentChange
  if (bpm > 0) log.push([Date.now(), bpm])
}

Page({
  onInit() {
    setPageBrightTime({ brightTime: 60 * 60 * 1000 }) // resets when the page is destroyed
    pauseDropWristScreenOff({ duration: 0 })          // 0 = until reset
    pausePalmScreenOff({ duration: 0 })
    setWakeUpRelaunch({ relaunch: true })             // reopen this page on wake (default: exit ~10 s after screen off)
    hr.onCurrentChange(onHr)                          // starts continuous measurement
  },
  onDestroy() { hr.offCurrentChange(onHr) },          // stops it
})
```

### 11.2 IMU capture with measured rate [V APIs]

```js
// permissions: ["device:os.accelerometer", "device:os.gyroscope"]
import { Accelerometer, Gyroscope, FREQ_MODE_HIGH, checkSensor } from '@zos/sensor'

const acc = new Accelerometer()
const gyro = checkSensor(Gyroscope) ? new Gyroscope() : null
let n = 0, t0 = 0
const onAcc = () => {
  const { x, y, z } = acc.getCurrent()     // docs: cm/s^2; at rest |a| ≈ 1000 (see §4.8)
  const t = Date.now()                     // delivery time, not sample time (batched)
  if (!t0) t0 = t
  if (++n % 200 === 0) console.log('acc Hz≈', (n * 1000) / (t - t0))
  // push into a ring buffer / Float32Array; flush to @zos/fs in chunks
}
acc.setFreqMode(FREQ_MODE_HIGH)
acc.onChange(onAcc)
acc.start()
if (gyro) { gyro.setFreqMode(FREQ_MODE_HIGH); gyro.onChange(() => gyro.getCurrent()); gyro.start() }
// cleanup: acc.offChange(onAcc); acc.stop(); gyro && gyro.stop()
```

### 11.3 GPS with GNSS quality [V APIs]

```js
// permissions: ["device:os.geolocation"]
import { Geolocation } from '@zos/sensor'
const geo = new Geolocation()
if (typeof geo.getEnabled === 'function' && !geo.getEnabled()) { /* user disabled location for Mini Programs (4.0) */ }
const onLoc = () => {
  if (geo.getStatus() !== 'A') return                 // 'V' = no valid fix
  const lat = geo.getLatitude({ format: 'DD' })
  const lon = geo.getLongitude({ format: 'DD' })
  // derive speed/bearing yourself from successive fixes
}
const onGnss = (info) => { /* info.nb_used_satellite, info.is_dualband, info.top4_cn_val, info.satellite_data[].gsv_data */ }
geo.start(); geo.onChange(onLoc); geo.onGnssChange(onGnss)
// cleanup: geo.offChange(onLoc); geo.offGnssChange(onGnss); geo.stop()
```

### 11.4 Health snapshot, usable in a page or App Service [V APIs]

```js
import { HeartRate, Sleep, Stress, BloodOxygen, Pai, BodyTemperature, Workout } from '@zos/sensor'
const hr = new HeartRate()
const minuteHr = hr.getToday()                    // index = minute since local 00:00; 0 = no reading
const restingHr = hr.getResting()
const sleep = new Sleep(); sleep.updateInfo()
const { score, deepTime, startTime, endTime, totalTime } = sleep.getInfo()
const S = sleep.getStageConstantObj(); const stages = sleep.getStage()   // [{model,start,stop}] minutes from 00:00
const stressWeekHourly = new Stress().getLastWeekByHour()                  // 168 × {second, stress}
const spo2Recent = new BloodOxygen().getLastFewHour(6)                     // [{spo2, time}]
const pai = new Pai(); const paiWeek = pai.getLastWeek()                   // index 0 = today
const skinTemp = new BodyTemperature().getToday()                          // 288 × °C, -1000 = none
const wk = new Workout()
const status = wk.getStatus()                                              // {vo2Max, trainingLoad, fullRecoveryTime} or falsy
const history = wk.getHistory()                                            // [{startTime, duration}]
let zones = null
try { if (typeof wk.getUserHrZoneSettings === 'function') zones = wk.getUserHrZoneSettings() } catch (e) {} // 4.2+
```

### 11.5 Background minute logger (App Service) [V APIs]

```js
// app.json: "permissions": ["device:os.bg_service","data:user.hd.heart_rate", ...],
//           "module": { "app-service": { "services": ["app-service/logger"] } }
// Start it from a page after queryPermission/requestPermission(['device:os.bg_service']) via
// @zos/app-service start({ file: 'app-service/logger', reload: true, complete_func })
// (the reference doc names the option `file`; the 3.0 sample uses `url`).
import { Time, HeartRate } from '@zos/sensor'
// import { createSysTimer, stopTimer } from '@zos/timer'   // API 4.0 alternative to onPerMinute
const time = new Time(), hr = new HeartRate()
AppService({
  onInit() {
    time.onPerMinute(() => {
      const bpm = hr.getLast()
      // append to a buffer; @zos/fs writes are only guaranteed while screen off / AOD
    })
  },
  onDestroy() {},
})
```

### 11.6 Workout Extension page [V APIs, pattern from official samples]

```js
// data-widget/index.js
import { createWidget, widget, prop, sport_data, edit_widget_group_type } from '@zos/ui'
import { getSportData } from '@zos/app-access'
import { HeartRate } from '@zos/sensor'

DataWidget({
  state: { timer: null, bpm: null },
  build() {
    // System-rendered metric (readable by the user, NOT by JS):
    createWidget(widget.SPORT_DATA, {
      edit_id: 1, category: edit_widget_group_type.SPORTS, default_type: sport_data.COUNT_CUR_FITNESS,
      x: 40, y: 90, w: 400, h: 130, text_size: 72, text_color: 0xffffff,
      sub_text_visible: true, sub_text_size: 24, sub_text_color: 0x999999,
    })
    this.label = createWidget(widget.TEXT, { x: 40, y: 260, w: 400, h: 60, color: 0xffffff, text_size: 36, text: '' })
    this.hr = new HeartRate()
    this.hr.onCurrentChange(() => { this.state.bpm = this.hr.getCurrent() })
    this.state.timer = setInterval(() => {                 // suspended automatically while unfocused
      getSportData({ type: 'duration' }, ({ code, data }) => {
        if (code !== 0) return
        const [{ duration }] = JSON.parse(data)            // string, e.g. "1:15:15" (some firmware: seconds)
        this.label.setProperty(prop.TEXT, `${duration}  ${this.state.bpm || '--'} bpm`)
      })
    }, 1000)
  },
  onResume() { /* page focused again: refresh immediately */ },
  onPause() { /* losing focus: callbacks and timers pause */ },
  onDestroy() { clearInterval(this.state.timer); this.hr.offCurrentChange() },
})
```

### 11.7 Open the system Workout app [V]

```js
import { launchApp, SYSTEM_APP_SPORT } from '@zos/router'
launchApp({ appId: SYSTEM_APP_SPORT, native: true })   // opens Workout; cannot preselect or start a sport
```

---

## 12. Verify on the real watch (suggested first-week test plan)

1. **API level**: in Zepp App developer mode, read the device API_LEVEL (expect 4.4 on Zepp OS 6). Probe `Workout.getUserHrZoneSettings` and `getWorkoutTrackNavInfo`.
2. **IMU rates**: count `onChange` calls over 60 s for each FREQ mode, for both accelerometer and gyroscope. Record the gap histogram to see the batching.
3. **HR rate**: count `onCurrentChange` callbacks per minute at rest and while moving. Check `getLast` against `getCurrent`.
4. **GPS rate and time to first fix**: count `onChange` events and log `onGnssChange` (`is_dualband`, satellites used) under each system GPS mode.
5. **Barometer**: confirm runtime permission need and event rate. Compare `getSportData('altitude')` during a hike workout.
6. **Workout Extension**:
   - confirm `getSportData` update cadence, and whether it also works from a normal Mini Program during a workout;
   - test `this.request()` / messaging inside a DataWidget on your firmware;
   - test `onKey` in the extension;
   - test IMU and GPS inside the extension;
   - check behaviour with the screen off or in AOD, and across focus changes.
7. **App Service**: whether `HeartRate.onCurrentChange` runs in the background and at what battery cost; `Compass` in the background; the stable `createSysTimer` minimum period.
8. **Stress** `getCurrent` and `onChange` sanity (known bug on older devices); `getAFibRecord` content; `Distance` unit; `Workout.getHistory` depth and the unit of `startTime`.

---

## 13. Sources

**Official, local** (`scratchpad/src/`):

- Sensor docs: `zeppos-docs/docs/reference/device-app-api/newAPI/sensor/*.mdx`
- Chinese docs: `zeppos-docs/i18n/zh-cn/docusaurus-plugin-content-docs/current/reference/device-app-api/newAPI/sensor/*.mdx`
- Other API references: `.../newAPI/app-access/getSportData.mdx`, `.../ui/widget/SPORT_DATA.mdx`, `.../global/DataWidget.mdx`, `.../user/{addHealthData,getProfile}.mdx`, `.../router/{launchApp,checkSystemApp}.mdx`, `.../timer/createSysTimer.mdx`, `.../app-service/start.mdx`, `.../app/{queryPermission,requestPermission}.mdx`, `.../display/{setWakeUpRelaunch,setPageBrightTime,pauseDropWristScreenOff}.mdx`
- Guides: `zeppos-docs/docs/guides/workout-extension/*`, `docs/guides/framework/device/{app-service,system-event,permission,compatibility}.md`, `docs/guides/version-info/new-features-{30,35,40,42}.md`
- Device list and watch face data types: `docs/reference/related-resources/device-list.mdx`, `docs/watchface/api/hmUI/widget/{data_type,IMG_CLICK}.mdx`
- Versioned docs: `versioned_docs/version-1.0/.../hmSensor/sensorId/HEART.mdx`
- Samples: `zeppos-samples/application/3.0/3.0-feature/*`, `zeppos-samples/workout-extensions/3.5/*`, `zeppos-samples/application/2.0/{showcase,post-health-data}`
- Typings: `@zeppos/device-types` 3.0.0 (`easy-draw/draw-example/node_modules/...`) and 4.0.0 (`scratchpad/research/types4/`)
- Partner REST API: `rest-api/api-doc.html`, `rest-api/api-sensor-doc.html`
- BLE example: `easy-ble/examples/ble-master-metric-parse`

**Official, web:**

- Zeus device registry: https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json (URL taken from the `@zeppos/zeus-cli@1.9.3` package)
- Device list: https://docs.zepp.com/docs/reference/related-resources/device-list/
- Zepp OS 6 compatibility: https://os.zepp.com/compatibility-zepp-os-6
- T-Rex 3 manual: https://support.amazfit.com/en/amazfit_t-rex_3/files/user-manual.pdf.pdf
- Installing extensions: https://support.amazfit.com/en/amazfit_t-rex_3/docs/HMqMdjg5voGtAGxetYmcgevvnbd
- Workout Extension competition: https://developer.zepp.com/os-post/workout-extension-competition

**Community:**

- GitHub discussions: [#12](https://github.com/orgs/zepp-health/discussions/12), [#16](https://github.com/orgs/zepp-health/discussions/16), [#194](https://github.com/orgs/zepp-health/discussions/194), [#253](https://github.com/orgs/zepp-health/discussions/253), [#281](https://github.com/orgs/zepp-health/discussions/281), [#282](https://github.com/orgs/zepp-health/discussions/282), [#292](https://github.com/orgs/zepp-health/discussions/292), [#338](https://github.com/orgs/zepp-health/discussions/338), [#370](https://github.com/orgs/zepp-health/discussions/370), [#371](https://github.com/orgs/zepp-health/discussions/371), [#396](https://github.com/orgs/zepp-health/discussions/396), [#433](https://github.com/orgs/zepp-health/discussions/433), [#447](https://github.com/orgs/zepp-health/discussions/447), [#494](https://github.com/orgs/zepp-health/discussions/494), [#508](https://github.com/orgs/zepp-health/discussions/508), [#525](https://github.com/orgs/zepp-health/discussions/525), [#526](https://github.com/orgs/zepp-health/discussions/526), [#531](https://github.com/orgs/zepp-health/discussions/531), [#535](https://github.com/orgs/zepp-health/discussions/535), [#539](https://github.com/orgs/zepp-health/discussions/539), [#554](https://github.com/orgs/zepp-health/discussions/554), [#555](https://github.com/orgs/zepp-health/discussions/555), [#559](https://github.com/orgs/zepp-health/discussions/559), [#563](https://github.com/orgs/zepp-health/discussions/563), [#564](https://github.com/orgs/zepp-health/discussions/564)
- Repos: [Dofek](https://github.com/Asherlc/dofek), [RunDeck](https://github.com/andrejd1/rundeck), [YeRun Trail](https://github.com/1445688048/YeRun-Trail), [HAMGIS](https://github.com/HaohanHe/HAMGIS), [fall-detection](https://github.com/katatsu12/fall-detection), [RogueMeso capability map](https://github.com/SaintedRogue/RogueMeso/blob/HEAD/zepp-beacon/docs/api-capability-map.md)
- Reviews, tools and news: [DC Rainmaker T-Rex 3 review](https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html), [Gadgetbridge Zepp OS](https://gadgetbridge.org/basics/topics/zeppos/), gadgetsandwearables firmware articles (links in §1)
