# E — Toolchain, Dev Workflow, Project Config, Distribution & T‑Rex 3 Platform Status

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Research date: 2026‑09‑28. Host: macOS 26.4 (Darwin 25.4, arm64), fish shell, nix; Homebrew Node v26.9.0 / npm 11.19.1 already present.

Local sources used (scratchpad `src/`): `zeppos-docs` (HEAD c08725b, 2026‑07‑17), `zeppos-samples` (HEAD 7cee748, 2026‑01‑13), `visual-logger`, `awesome-zeppos`, `create-zos` (empty repo), plus the npm tarballs of `@zeppos/zeus-cli@1.9.3`, `@zeppos/zpm@3.4.2`, `@zeppos/device-types@4.0.0`, `create-zos@1.0.8`, and the Zepp OS Simulator 2.1.2 macOS‑arm64 DMG (inspected read-only, not installed).

All experiments ran inside the scratchpad with `HOME` pointed at `scratchpad/exp/home`, so nothing was written to the real `~/.zepp`. Nothing was logged in, previewed or uploaded.

**Evidence labels used throughout**

| Tag | Meaning |
|---|---|
| **[V‑doc]** | Stated in the official docs (local clone) |
| **[V‑code]** | Read directly in Zepp's shipped tool code (zeus‑cli / zpm / simulator bundle) |
| **[V‑exp]** | Reproduced in my own scratchpad experiment |
| **[V‑data]** | Read from Zepp's live, public CDN JSON (device registry, simulator catalogue) |
| **[C]** | Community report (GitHub forum, news site, Gadgetbridge). Not confirmed by Zepp |
| **[I]** | My inference |

---

## 0. TL;DR: the decisions that matter

1. **The T‑Rex 3 is now on Zepp OS 6 at API_LEVEL 4.4. The docs table saying 4.0 / 4.5 is out of date.**
   - Zepp's own build registry says so for all three deviceSources: `os.version "6.0"`, `apiLevel "4.4"`, `apiLevelLimitMax "4.4"` [V‑data].
   - os.zepp.com lists the T‑Rex 3 as Zepp OS 6-compatible, and news reports date the rollout to 22 July 2026 (firmware 6.2.104.6, then 6.3.13.5 and 6.3.25.7) [C].
   - `zeus build` with `minVersion: "4.4"` still packages the T‑Rex 3. `4.5` fails with "no matching target devices" [V‑exp].
   - **Check your own watch** before relying on 4.2+ APIs (§1.4).
2. **Toolchain works on this Mac today, with one big gotcha.**
   - Zeus CLI 1.9.3 + zpm 3.4.2 build real `.zab` packages on Node 26 / Apple Silicon in about 3 s [V‑exp].
   - **But `npx @zeppos/zeus-cli` and a normal project-local `npm i -D` both crash** with `Cannot find module 'zeppos-app-utils'` [V‑exp]. Use either:
     - a global install, or
     - a project-local install with `install-strategy=nested` (verified; nix-friendly).
3. **A simulator exists, but it lags the watch.**
   - Simulator 2.1.2 has a native Apple Silicon DMG, notarized by ZEPP, INC., and needs no tun/tap [V‑code/V‑doc].
   - Its **T‑Rex 3 image stops at API 4.0 / Zepp OS 4.0** (v1.0.2, April 2025) [V‑data].
   - The nearest newer 480×480, 4-key images are **T‑Rex Ultra 2 (API 4.3)** and **T‑Rex 3 Pro 48 mm (API 4.2, public)**.
   - No public round image at API 4.4 exists. An app with `minVersion 4.4` therefore probably can't be tested in any public round simulator [I].
4. **Real-device installs always go through Zepp's cloud and a Zepp account.**
   - `zeus preview` uploads the build to Zepp and prints a QR code valid for **7 days**. You scan it in the Zepp phone app's Developer Mode [V‑code/V‑doc].
   - The CLI login accepts **only email + password** Zepp accounts [V‑doc, C].
   - A publicly documented install path without the Zepp account or cloud doesn't exist. Gadgetbridge can sideload `.zab` files, but it **can't run the phone-side (side-service / settings) code** [C].
5. **Private personal use is fine; no publishing needed.**
   - A preview install stays on the watch. I found no report or official statement of preview-installed apps expiring. One undocumented field, `packageInfo.expiredTime = 172800` (48 h), is baked into every package, meaning unknown [V‑code/I].
   - Publishing is free: review takes 1–5 working days [V‑doc]; recent real cases took 2–8 days [C].
   - **Paid store listings are only open to certified corporate developers in Mainland China.** Everyone else can use in-app schemes such as KiezelPay [V‑doc].
6. **Privacy and packaging surprises:**
   - (a) `zeus build` (production) embeds an `.ip-package` containing **your project's source files and any other non-dot file in the project folder**. `.gitignore` is ignored. It gets uploaded when you submit [V‑exp/V‑code].
   - (b) The store **rebuilds** packages server-side for most devices, T‑Rex 3 included: plain JS instead of bytecode, built with an older zpm [C, #568]. Test the store build.
   - (c) The CLI sends usage telemetry on every command [V‑code].
   - `zeus prune --ip` strips the sources from the package [V‑exp].
7. **TypeScript isn't compiled by zeus.** Importing a `.ts` file fails the build [V‑exp]. Use JS with JSDoc and `@zeppos/device-types@4.0.0` type checking, which works [V‑exp], or a community wrapper (zeusx / zepp‑ts).

---

## 1. T‑Rex 3 platform status

### 1.1 Firmware / Zepp OS history (2024–2026)

| When | Event | Evidence |
|---|---|---|
| 2024‑09‑06 | T‑Rex 3 launches on Zepp OS 4.0. First simulator image v1.0.0 reports API 3.6 | device registry `releaseDate` [V‑data]; emulatorList [V‑data]; docs added T‑Rex 3 on 2024‑09‑14 (commit 8bd0df4c) [V‑doc] |
| 2025‑03‑27 | Docs add an API_LEVEL column: T‑Rex 3 = API 4.0 / OS 4.0. Simulator image v1.0.2 (API 4.0) published 2025‑04‑08 | docs commit a7cbd60d [V‑doc]; emulatorList [V‑data] |
| 2025‑04 | Firmware 3.5.7.1 observed in the field | Gadgetbridge issue #4721 [C] |
| 2025‑11‑04 | Docs bump T‑Rex 3 to Zepp OS 4.5; API column stays 4.0 (still the current docs text) | docs commit 169f1af1 [V‑doc] |
| Dec 2025 | **Zepp OS 5** (fw 4.1.5.1). Also adds on-watch screenshots (SEL + DOWN) | Amazfit US blog "T‑Rex 3: December 2025 Software Updates"; thewearify; notebookcheck [C] |
| 2026‑02‑04 | Software support window extended from Sept 2026 to **Sept 2027** (per Zepp support page listing) | gadgetsandwearables [C] |
| 2026‑02‑05 | fw 4.4.2.3 (indoor cycling) | gadgetsandwearables [C] |
| 2026‑04‑29 | fw 4.8.3.5 (rowing, running metrics) | gadgetsandwearables [C] |
| 2026‑06‑24 | Large update (BioCharge becomes HybridCharge, HYROX, navigation) | gadgetsandwearables [C] |
| **2026‑07‑22** | **Zepp OS 6** (fw 6.2.104.6, 24.59 MB) for T‑Rex 3, T‑Rex 3 Pro and T‑Rex Ultra 2. os.zepp.com lists T‑Rex 3 as Zepp OS 6-compatible | gadgetsandwearables 2026‑07‑22 [C]; https://os.zepp.com/compatibility-zepp-os-6 (official consumer page) |
| 2026‑08‑19 | fw 6.3.13.5 | gadgetsandwearables [C] |
| 2026‑09‑03 | fw 6.3.25.7 (16.5 MB) | gadgetsandwearables [C] |

API level versus Zepp OS generation, inferred from Zepp's own registry and simulator catalogue across devices:

| Zepp OS | API_LEVEL |
|---|---|
| 4.0 | 3.6 or 4.0 |
| 4.5 | 4.0 |
| 5.0 | 4.2 or 4.3 |
| 6.0 | 4.4 (e.g. the Bip Max simulator image is "os 6.0 / api 4.4") |

**So the T‑Rex 3 has moved from 4.0 to 4.4** [V‑data + C].

- One oddity: the registry's `updateTime` for T‑Rex 3 is 2025‑07‑10, which predates Zepp OS 6. Treat the registry value as the toolchain's ceiling and confirm on the watch [I].
- `zeus create` still only offers API 1.0 / 2.0 / 3.0 / 3.5 / 4.0 templates. Anything above 4.0 you set by hand in `app.json` [V‑code].

### 1.2 What API 4.1 → 4.4 adds, and where the docs stop

These are only the docs' own statements. Other agents cover the API surface.

- **4.2:**
  - custom keyboards (`@zos/ui` keyboard, `inputType.JSKB`)
  - `media` Player `seek()` plus new events
  - Workout `getWorkoutTrackNavInfo` and `getUserHrZoneSettings`
  - `getDeviceInfo().uuid`

  [V‑doc new-features-42.md]
- **4.3:** one Player item (`Player.mdx` "Start from API_LEVEL 4.3") [V‑doc].
- **4.4:** nothing documented yet. The docs have no 4.3/4.4 feature pages [V‑doc].

### 1.3 T‑Rex 3 hardware facts that matter to developers

| Item | T‑Rex 3 | Source |
|---|---|---|
| Display | 1.5" AMOLED, **480×480 round**, 322 ppi, up to 2000 nits, Gorilla Glass | us.amazfit.com product page |
| Keys | **4 physical keys: UP, DOWN, SELECT, BACK. No crown**; mouse wheel emulates a crown in the simulator | device-list and physical-keys docs [V‑doc] |
| Sensors | BioTracker 6.0 PPG (5PD + 2LED; HR and SpO₂), accelerometer, gyroscope, geomagnetic (compass), barometric altimeter, ambient light, temperature | product page; registry `capabilities: gps, magnetometer, gyroscope, accelerometer, altimeter` [V‑data] |
| GNSS | Dual-band, 6 systems | product page |
| Radios | BLE 5.2, **Wi‑Fi 2.4 GHz** (no public Wi‑Fi API found in the docs; apps reach the internet via the phone side service [I]), NFC on some variants | product page; registry `nfc` per deviceSource [V‑data] |
| Audio | **Microphone yes (Zepp Flow voice); no speaker**, only buzzer and vibration | the5krunner / G&W spec sheets [C]; registry `voice: true` [V‑data] |
| Storage | Up to 26 GB usable for maps, music, mini programs and data | spec sheets [C] |
| Battery | 700 mAh; up to 27 days typical, 13 days heavy, 42 h accurate GPS, 180 h max GPS | product page |
| Water | 10 ATM; freediving certified (EN13319) | product page |
| SoC family | "ZPS" SOC. One `.zpk` serves T‑Rex 3, Balance 2/3/Ultra, T‑Rex 3 Pro 48, Ultra 2, Active Max and Cheetah 2 Ultra (all ZPS 480×480) | registry `chip` [V‑data]; my build output [V‑exp] |
| deviceSource | `8716544` Matterhorn (CN, NFC, A2322) · `8716545` MatterhornWN (global, NFC, A2322) · `8716547` MatterhornW (global, no NFC, A2323) | registry [V‑data] |
| Phone OS | Android 7.0+, iOS 14.0+, Zepp app | product page |
| Not supported | SecondaryWidget | device list [V‑doc] |

**T‑Rex 3 Pro differences** (launched Sept 2025, $399.99 vs $279.99) [C]:

- Grade‑5 titanium bezel and buttons, sapphire glass.
- LED flashlight (white, red, SOS).
- **Speaker**: Bluetooth calls, voice prompts; audio playback is meaningful on the Pro only [I].
- 44 mm size (466×466) in addition to 48 mm (480×480).
- Same ZPS platform and, today, the same API 4.4 [V‑data].
- For developers: the Pro 48 mm is the closest simulator stand-in for the T‑Rex 3 (§3.3).

**Zepp Flow (voice assistant):** no developer hooks, intents or APIs appear anywhere in the docs repo (grep) or the Zepp OS 4 press release [V‑doc/C]. Gadgetbridge lists Zepp Flow as unsupported [C].

### 1.4 How to check your own watch's firmware and API level

1. **Watch:** Settings → About (labels vary) shows the firmware number. `6.x.x.x` means the Zepp OS 6 generation [I from the history above].
2. **Zepp app:** Profile → Amazfit T‑Rex 3 → system/firmware update page shows the current version and any pending update. Update first.
3. **Zepp app Developer Mode → "Device information"** button shows the device **API_LEVEL** [V‑doc zepp-app.mdx "Query the device API LEVEL"].
4. **On-watch probe (most precise).** Install the tiny app in §7 (probe page in §7.2). It prints `getSystemInfo()` fields `osVersion`, `firmwareVersion` and `minAPI` (the API_LEVEL), via `@zos/settings`, API 2.1+ [V‑doc]. It builds [V‑exp]; I haven't run it on hardware.
5. Cross-check against the toolchain's view in `~/.zepp/.zeus_devices` (written on the first build) or https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json.

---

## 2. Toolchain inventory and versions (as of 2026‑09‑28)

| Component | Version / status | Notes |
|---|---|---|
| Node.js | Docs: "LTS", with an fnm example installing Node 24 [V‑doc] | The CLI doc still says ≥14, but `ora@9` in zeus-cli needs **≥20** [V‑data npm engines]. **Node 26.9 works** [V‑exp] |
| `@zeppos/zeus-cli` | **1.9.3** (2026‑07‑23); `beta` tag 1.6.7‑beta4 | 23 stable releases and 2 betas from Dec 2024 to Jul 2026; about monthly [V‑data npm] |
| `@zeppos/zpm` (build engine inside zeus) | **3.4.2** (2026‑07‑08) | rollup 3 + esbuild 0.25 + sharp 0.33 + native `qjsc_darwin_arm64` (QuickJS bytecode compiler) [V‑code] |
| `@zeppos/device-types` | **4.0.0** (2026‑06‑17) | Scaffolds still pin `^3.0.0` [V‑exp]. Declares 20 device modules (`@zos/*`); **no side-service or settings typings**, no `@zos/media` [V‑exp] |
| `@zeppos/zml` | 0.0.43 (2026‑01‑08) | Official messaging/request helper library |
| Whole `@zeppos` npm org | 6 packages: zeus-cli, zpm, device-types, zml, zmt, form-data | [V‑data npm org listing] |
| Zepp OS Simulator | **2.1.2** (2026‑07‑17): macOS arm64 DMG 109.7 MB, macOS 14+ | sha256 `a773f4f8bc7411418c80999241dba5824f4303eb438b0b411976d11aa479e592` (my download). Electron + QEMU; Developer ID "ZEPP, INC. (77F23LKNLN)", notarized, Gatekeeper-accepted [V‑code] |
| VS Code extension "Zepp OS Dev Tools" | **Deprecated**, unmaintained | [V‑doc]; staff confirmed Sept 2026 [C #547] |
| Zepp Studio | Web IDE on developer.zepp.com; login required. Can generate preview QR codes | Absent from the current docs repo (legacy docs only) [C #552] |
| `create-zos` (npm) | 1.0.8 (2024‑05‑21), oclif CLI by a Zepp engineer; GitHub repo empty | Templates bare / vanilla / vanilla‑zml / mvp‑zml / watchface / workout; `module add/remove` subcommands. **Bundles a Yeoman `generator-zos` that can break `zeus create`** (§10 pitfall 4) [V‑code] |
| Community | `zeusx` 0.8.1 (Dec 2024, adds TS/JSX via babel and rollup), `zepp-ts`, `@silver-zepp/vis-log` 1.5.3, easy-storage/ble/media | [V‑data npm] |

Docs freshness warning: CLI release notes stop at 1.2.2 (2022), simulator notes at 1.2.1 (2023) and the revision history at 2023 [V‑doc]. Treat npm, the device registry and the simulator catalogue as the source of truth.

---

## 3. Setup and workflow

### 3.1 Installing Zeus CLI on this Mac (tested)

| Method | Result |
|---|---|
| `npx -y @zeppos/zeus-cli@1.9.3 …` | ❌ `Error: Cannot find module 'zeppos-app-utils'` [V‑exp] |
| Plain project-local `npm i -D @zeppos/zeus-cli` (hoisted) | ❌ same error [V‑exp] |
| Global install (`npm i -g`, or `-g --prefix <dir>`) | ✅ `zeus v1.9.3, zpm v3.4.2` [V‑exp] |
| Project-local with `.npmrc` → `install-strategy=nested`, then `npm i -D @zeppos/zeus-cli@1.9.3` | ✅ works through npm scripts / `npx zeus`. Costs about 206 MB of node_modules [V‑exp] |

- **Root cause [V‑code]:**
  - zeus-cli resolves its private `zeppos-app-utils` via `module-alias`.
  - `module-alias` reads `_moduleAliases` from the package.json **two levels above its own folder**.
  - When npm hoists `module-alias`, that becomes your project's (or npx's) package.json, which has no alias.
  - (Community reports of the same error go back to 2024, forum #350 [C].)
- npm 11.19 prints `install-scripts … not yet covered by allowScripts` for esbuild, sharp and core-js. The build still works because the prebuilt `@esbuild/darwin-arm64` and `@img/sharp-darwin-arm64` optional deps are used [V‑exp]. The warning is harmless.
- This Mac's global npm prefix is `~/.npm-packages`. It contains no Yeoman generators, so the `zeus create` crash in §10 won't trigger today [V‑exp].

### 3.2 Zeus CLI command reference (1.9.3)

The docs list create, dev, preview, build, login, config, bridge and status. The tool itself adds **`init`, `prune`, `cache`, `logout`** [V‑code, `zeus --help`].

| Command | What it does | Needs login? |
|---|---|---|
| `zeus create <name>` / `zeus init` | Scaffold from bundled templates (no network needed for templates). Flags: `--appType app\|watchface\|workout_extension` (**lowercase**), `--APILevel 1.0\|2.0\|3.0\|3.5\|4.0`, `--template Empty\|Hello_World\|Todo List\|Fetch Api\|Showcase\|Calories`, `--withAppSide`, `--withSettings`, `--shape r\|s\|b`. Then it runs `npm install`. Somewhere between 1.8.2 and 1.9.3 the old `--OSVersion v4` flag became `--APILevel 4.0`, with lowercase aliases added (npm diff) | No |
| `zeus dev [-t "<Device Name>"]` | Build in development mode and push to the running simulator at 127.0.0.1:7650; watches files | No |
| `zeus build [-t …] [-s] [--legacy-zpk-name]` | Production `.zab` into `dist/`; includes the `.ip-package` (§8.3) | No |
| `zeus preview [-t "Amazfit T-Rex 3"] [-s]` | Preview build, **upload to Zepp cloud**, QR code valid **7 days** (hard-coded). `-t` takes the device name from the registry; `-s` multi-select | **Yes** |
| `zeus bridge` | REPL: `connect`, `install`, `uninstall [appid]`, `screenshot`, `exit`. Talks to the phone or simulator through Zepp's cloud relay (`/developerbridge/client/relay`) | **Yes (same account on both ends)** |
| `zeus prune [--ip]` | Removes the `.ip-package` (sources) from the zab in `dist/` | No |
| `zeus login` / `logout` / `status` | Browser login at user.zepp.com (**email and password only**; fails headless/Docker [C #528]); `status` shows login and simulator host/port | – |
| `zeus config set\|get\|delete\|list` | Local config | No |
| `zeus cache` | Clean or refresh the device cache | No |

- **Files it writes:**
  - `~/.zepp/.zeus` (session, token, config)
  - `~/.zepp/.zeus_devices` (device registry cache, refreshed every **3 days** from the CDN; the first build prints "Updating devices…")
  - `~/.zepp/.zeus_version`

  [V‑code/V‑exp]. The simulator also uses `~/.zepp/userData_cache/…` [V‑code].
- **Network:**
  - `devices.json` / `devices.beta.json` from upload-cdn.zepp.com; a fetch failure exits the process, so the first build needs internet [V‑code]
  - `…/custom/tools/app-dial/upload` and `/download/<code>` for preview (region host from login; e.g. EU is `api-mifit-de2.zepp.com` [C #550])
  - telemetry (below)
- **Telemetry [V‑code]:**
  - Sent on every invocation (`ZEPP_CLI_V`), plus build, dev and bridge events.
  - Destination: `https://api-analytics.zepp.com/api/v5/server/collect`.
  - Payload: random UUID, OS platform/release/arch, Node version.
  - Best effort (300 ms timeout). No opt-out found.

### 3.3 Simulator: status, device images, limits

- **Install:** download the DMG (docs → Simulator Download), drag to /Applications, launch.
  - v2 **doesn't need tun/tap or Tunnelblick or sudo**. The `setup.md` page with Tunnelblick instructions is for v1 only [V‑doc].
  - If you ever upgrade from v1, delete `~/.zepp` [V‑doc FAQ].
- **Architecture:** an Electron UI plus `qemu-system-arm` running real watch firmware images [V‑code `firmware/start_qemu.sh`, `qemu_mac/`]. Device images (about 120–190 MB each) are downloaded in-app from `https://upload-cdn.huami.com/zeppos/simulator/download/emulatorList.json` [V‑code/V‑data].
- **Visibility rule (2.1.2) [V‑code]:** an image is listed if all of these hold:
  - `!hide`
  - `support ≤ app version`
  - `limit ≤ your account limit` (default 1, including when not logged in), **or** your test "platformCode" appears in `platform`.

  The test code is entered through the hidden click target described in the "Get test simulator" FAQ [V‑doc].
- **Relevant images today [V‑data, 2026‑09‑28]:**

| Image | Res | Keys | OS / API | Default-visible? |
|---|---|---|---|---|
| **T‑Rex 3 v1.0.2** (2025‑04‑08) | 480×480 | 4 | 4.0 / **4.0** | ✅ |
| T‑Rex 3 v1.0.1 / v1.0.0 | 480×480 | 4 | 4.0 / 3.6 | ✅ |
| **T‑Rex Ultra 2 v1.0.0** (upd. 2026‑08‑20) | 480×480 | 4 | 5.0 / **4.3** | ✅ |
| T‑Rex 3 Pro (48 mm) v1.0.0 / v1.1.0 | 480×480 | 4 | 5.0 / 4.2 | ✅ |
| T‑Rex 3 Pro (48 mm) v1.1.4–v1.1.7 | 480×480 | 4 | 5.0 / 4.3 | ❌ (`limit: 3`) |
| T‑Rex 3 Pro (44 mm) v1.0.0 | 466×466 | 4 | 5.0 / 4.2 | ✅ |
| Bip Max v1.0.0 | 432×514 **square** | 2 | 6.0 / 4.4 | ✅ |
| Balance 3, Balance Ultra, Cheetah 2 Ultra | – | – | – | **absent from the catalogue** |

  So **no public round image at API 4.4** exists, and the T‑Rex 3 image is two API levels behind the watch.
- **Keyboard mapping [V‑doc]:**

| Watch | Mac keyboard |
|---|---|
| HOME | `fn` + `←` |
| SHORTCUT | `fn` + `→` |
| SELECT | Enter |
| BACK | Delete |
| UP / DOWN | ↑ / ↓ |
| Crown | Mouse wheel (the T‑Rex 3 has no crown) |

- **Panels [V‑doc]:** Apps, Sensors (mock values), Display, User (mock user settings), Console (device-app logs with level and text filters), a Settings-App window with its own console, a Side Service log window, a screenshot button and a Bridge toggle (needs login).
- **Known gaps:**
  - Side-service and settings runtimes are **loaded from the web** (`https://zepp-os.zepp.com/frameworks/v4.0.0.4/side-service.html`, `…/app-settings/v1.0.1/index.html`) [V‑code]. Blocked networks, regions or ISPs break the side service in the simulator; community workarounds are a VPN or restarting in the right order [C #478, open as of Aug 2026].
  - A Workout Extension shows in the simulator's app list, whereas on the watch you add it from inside the Workout app [V‑doc].
  - Not documented, likely unsupported [I]: BLE peripherals, real GNSS tracks, NFC, the Zepp Flow microphone path, vibration feel, and true battery or performance behaviour. `openInspector()` (API 4.0) draws layout boxes in the simulator [V‑doc].
- `zeus dev` needs the Simulator running **and** the Device Simulator window open for the target model. `zeus status` shows `simulator host 127.0.0.1, port 7650` [V‑exp/V‑doc].

### 3.4 Real watch: Zepp app Developer Mode, QR preview, bridge

- **Enable:** Zepp app → Profile → Settings → About → tap the Zepp icon 7 times. Turn off under Profile → Settings → remove Developer Mode [V‑doc].
  - The CLI docs place the entry at "Profile → Bound Devices page → scroll to bottom → Developer Mode" [V‑doc].
  - The docs don't distinguish iOS from Android. Preview installs from iOS 26.6 with Zepp 10.7.x are reported working [C #520, #550].
- **Developer Mode features [V‑doc]:** Scan (QR install), watch screenshot, real-device logs for Device App and Side Service (Settings-App logs aren't available), Bridge toggle, Device information (API_LEVEL).
- **QR flow:**
  1. `zeus login` (browser)
  2. `zeus preview -t "Amazfit T-Rex 3"`
  3. Scan within 7 days.

  Common errors:
  - "Download failed, error code: null" usually means the QR was built for a different model, or the wrong watch is selected in the Zepp app [C #552 staff reply, #403].
  - Installs fail while the watch is syncing or downloading an OTA ("transmission channel occupied") [V‑doc].
  - The Zepp app **10.8.0** reportedly broke QR installs (Aug 2026) [C #552].
- **Accounts:**
  - CLI and simulator login need an **email/password** Zepp account. If you signed up with Google or Apple, bind an email and set a password via "Forgot password" [V‑doc third-party-login FAQ].
  - **Bridge** needs the *same* account in CLI and phone. A Google-login phone account silently fails with "No connectable online App or Simulator" [C #552].
  - **Preview QR codes work for other accounts too**: developers share them with testers [C #520, #552].
- **Bridge:** Zepp app ≥ 6.9.0 and CLI ≥ 1.1.0 [V‑doc]. Then `zeus bridge` → `connect` → `install` / `uninstall` / `screenshot` [V‑code].

### 3.5 Debugging and logging

- No breakpoints and no source maps: logging is the tool. The docs advise wrapping lifecycle code in try/catch [V‑doc debug.mdx, error-catch.mdx].
  - Device app: `import { log } from '@zos/utils'; const l = log.getLogger('x')`
  - Side service and settings: `console.log`
- **Where logs show up:**
  - Simulator: Console panel, Settings-App console, Side Service window.
  - Real device: Zepp app Developer Mode → tap the mini program → start log capture [V‑doc].
  - Gadgetbridge can also fetch watch-app logs [C].
- **VisLog** (`@silver-zepp/vis-log` 1.5.3; needs `@zeppos/zml` for relaying):
  - on-screen logs on the watch
  - since 1.5.0, it relays **app-side and settings logs to the watch**, which fills the "no Settings-App logs on real device" gap [V‑doc README]
- Screenshots for store listings: SEL + DOWN on the watch (fw Dec 2025+) [C], Zepp app Developer Mode screenshot [V‑doc], or `zeus bridge` → `screenshot` [V‑code].

### 3.6 TypeScript and editor support

- zeus/zpm **does not compile `.ts`**. Importing `utils/greet.ts` fails with `SyntaxError: Unexpected token (1:7)` and the build aborts [V‑exp].
- **Modern JS syntax passes the build** [V‑exp]: private and static class fields, generators, async/await, `?.`, `??`, BigInt, spread. It compiles to QuickJS bytecode.
  - On-device runtime behaviour wasn't tested.
  - The docs page "JavaScript Support" still says Promise, generators and timers are unsupported. That looks inherited from 1.0; verify on the watch [I].
  - `eval` and `new Function` are not allowed [V‑doc].
- **Recommended editor setup (verified with `tsc --checkJs`, no errors) [V‑exp]:**
  1. `npm i -D @zeppos/device-types@^4.0.0`
  2. Keep the scaffold's `jsconfig.json` (`checkJs: true`).
  3. In `global.d.ts`:
     ```ts
     /// <reference path="node_modules/@zeppos/device-types/dist/index.d.ts" />
     // zeus/zpm virtual import used for per-screen layout files
     declare module "zosLoader:*"
     ```
- If you want real TS: `zeusx` (babel + @rollup/plugin-typescript; last published Dec 2024) or `zepp-ts` (community) [V‑data/C]. Or run `tsc`/`esbuild` into a JS source tree before `zeus build` [I].

---

## 4. Local experiment log (all in `scratchpad/exp/`, HOME sandboxed)

| # | Experiment | Result |
|---|---|---|
| 1 | `node -v` / `npm -v` | v26.9.0 / 11.19.1 (Homebrew) |
| 2 | `npm view @zeppos/zeus-cli` | 1.9.3 (2026‑07‑23); zpm 3.4.2; device-types 4.0.0 |
| 3 | npx and hoisted local install | ❌ `zeppos-app-utils` missing (§3.1) |
| 4 | Prefix-global install (`npm i -g --prefix exp/npm-prefix`) | ✅ 774 packages, about 12 s |
| 5 | Build of official `application/4.0/todo-list` (page + app-side + settings; `st r` + `st s`) | ✅ about 3.8 s → `dist/20001-Todo_List-1.0.0-<ts>.zab` **181,089 B**: 4 zpk (round 480 ZPS 33,989 B · round 466 ZPS 33,505 · square 390×450 · square 432×514) + `.ip-package` 45,349 + manifest |
| 6 | 480×480 zpk anatomy | `device.zip` (26.7 KB): `app.bin` and `page/…/index.page.bin` (**QuickJS bytecode**, `runtime.type: 2`), PNGs converted to TGA, `assets/raw/locale/*.btxt`. `app-side.zip` (8 KB): bundled `app-side.js`, `setting.js`. Build `app.json` lists **29 round-480 ZPS deviceSources incl. 8716544/5/7** plus `largeAppIcon 248` and `packageInfo {mode, timeStamp, expiredTime:172800, zpm}` |
| 7 | `zeus create trex-empty --appType app --APILevel 4.0 --template Empty --withAppSide --withSettings --shape r` | ✅ non-interactive. `configVersion v3`, random local `appId` (27963), `platforms:[{st:"r",dw:480}]`, device-types **^3.0.0**. Build 34,971 B → **`zeus prune --ip` → 13,988 B** |
| 8 | Target by `deviceSource` only | Builds, but prints `error 'zosLoader:./index.[pf].layout.js' … could not be resolved`: the page import is broken. Assets are read from `assets/<targetKey>/`, not `<key>.r` |
| 9 | deviceSource and `st` combined | Same `[pf]` failure; `st` ignored for naming |
| 10 | Target **key** `"trex3.r"` with deviceSource platforms | ✅ `[pf]` resolves to `r` (undocumented quirk; zpm uses the text after the first "." of the internal target name) |
| 11 | `{"st":"r","sr":"w480","dw":480}` + `index.w480-r.layout.js` + `assets/default.w480-r/` | ✅ **single 480×480 ZPS zpk** (T‑Rex 3 included): the clean "480-round only" option |
| 12 | `minVersion` 4.2 / 4.4 / 4.5 | 4.2: T‑Rex 3 included. **4.4: T‑Rex 3 included** (Balance 2 / Active Max / Balance 2 XT dropped). 4.5: **"no matching target devices"** |
| 13 | Workout Extension scaffold (`--appType workout_extension --template Empty`) | ✅ `app.extType:"workout"`, `data-widget`, `minVersion 3.6`. Build 46,523 B with 6 zpk (NXP 416/454/480, APOLLO 360, ZPS 480/466). The template leaves a stray zh-CN name "跑步配速大师" |
| 14 | `.ts` import | ❌ build fails (§3.6) |
| 15 | Modern syntax | ✅ builds |
| 16 | `@zeppos/device-types@4.0.0` + `tsc --checkJs` | ✅ passes with the `declare module "zosLoader:*"` shim |
| 17 | Project-local pinned zeus (`.npmrc install-strategy=nested`) + `npm run build` | ✅ about 2.6 s |
| 18 | `.ip-package` contents | Zip of project **sources**: every non-dot file except `**/dist/**`, `**/node_modules/**`, lockfiles, `*.zip/rar/7z`, some media, `.DS_Store`. **`.gitignore` is not honored.** A `notes-private.txt` got included. Added only in **production** mode (`mode === "production"`), so `zeus preview` uploads don't carry it [V‑exp/V‑code] |
| 19 | Simulator DMG (read-only mount) | Electron + QEMU, notarized, emulator catalogue URL and remote side-service runtime found; filter logic read (§3.3). Detached |
| 20 | Recommended project (§7) | ✅ 27,154 B zab (round 480 and 466 zpk). `device.zip` 7.8 KB, `app-side.zip` 1.3 KB |

Snapshots: `exp/devices.json` (Zeus registry, 101 entries), `exp/sim/emulatorList.json`, `exp/forum/*.json` (GitHub forum threads).

---

## 5. Folder structure and packaging model

- **Project layout** [V‑doc folder-structure.mdx, V‑exp]:

  ```
  app.js                     // App({ onCreate, onDestroy, globalData })
  app.json
  page/<name>/index.js       // Page({...}); import layout via 'zosLoader:./index.[pf].layout.js'
  page/<name>/index.r.layout.js      // or index.w480-r.layout.js with sr
  page/i18n/<lang>.po
  app-side/index.js          // AppSideService({...}); runs in the Zepp phone app
  app-side/i18n/<lang>.po
  setting/index.js           // AppSettingsPage({ build(props){...} }); phone UI
  setting/i18n/<lang>.po
  app-service/*.js           // AppService({...}) background (needs permission)
  data-widget/*/index.js     // DataWidget({...}) Workout Extension
  assets/<targetKey>.<qualifier>/icon.png (+ images, fonts)
  ```
- **Assets directory rule:**
  - `assets/<targetKey>.<qualifier>`, where qualifier is `r`/`s`/`b`, or `w<width>-<st>` when `sr` is used.
  - In deviceSource mode it's plain `assets/<targetKey>`.
  - Images are **auto-scaled at build** from `designWidth`/`dw` to each device width: `Math.ceil(w × deviceWidth / designWidth)` [V‑doc].
  - The icon is resized to the device `iconSize` (**124 px** on T‑Rex 3) and kept at 248 as `largeAppIcon` [V‑exp/V‑data].
- **Package model:** `.zab` (upload/distribution bundle) contains `manifest.json` + one `.zpk` per {screenType, resolution, cpuPlatform} (+ `.ip-package` in production). Each `.zpk` contains `device.zip` + `app-side.zip` [V‑exp].
- `px()` from `@zos/utils` scales design pixels to the device (`Math.ceil(x/designWidth × DEVICE_WIDTH)`). **Don't** wrap real sizes from `getDeviceInfo()` [V‑doc]. On the T‑Rex 3 (480 wide) with designWidth 480 it's the identity.

---

## 6. `app.json` in depth: targeting the T‑Rex 3

### 6.1 Top-level fields

- **Required:** `configVersion` (use `"v3"`; v1 is deprecated), `app`, `runtime`, `permissions`, `targets`, `i18n`, `defaultLanguage` [V‑doc].
- **Optional:** `debug` [V‑doc].

### 6.2 `app`

| Field | Rule |
|---|---|
| `appId` | Number. **Must equal the ID the Developer Console assigns** before you publish; the scaffold's random ID is local-only. The published package's appId must match the console page [V‑doc] |
| `appName` | String |
| `appType` | `"app"`, or `"watchface"` |
| `version` | `{ code: <int, strictly increasing>, name: "x.y.z" }` |
| `icon` | Path relative to the assets folder |
| `vender` | Sic. Developer name |
| `description` | String |
| `venderId`, `cover` | Optional |
| `extType: "workout"` | **Undocumented in app-json.mdx but required for Workout Extensions** (all official samples and the zeus template) [V‑exp] |
| `_pikeCompatibled` | Bip Max only [V‑doc] |

### 6.3 `runtime.apiVersion` (and the recommendation)

- **Schema:** zpm's schema **requires all three**: `compatible`, `target`, `minVersion` [V‑code].
- **What zpm uses:**
  - Only `minVersion` affects the build. It chooses which devices get a `.zpk` (those whose registry `apiLevelLimitMax ≥ minVersion`) and drives code wrapping.
  - It's truncated to `X.Y` [V‑code/V‑exp].
  - `compatible` and `target` are only validated. The docs' own example uses `target` > `minVersion` (1.0.1 vs 1.0.0) [V‑doc].
  - On the watch, the firmware refuses an install when device API_LEVEL < `minVersion` [V‑doc, wording garbled]. The simulator runs real firmware, so expect the same there (not verified) [I].
- **Recommendation for a personal T‑Rex 3 app:**

| Profile | `apiVersion` | Use when |
|---|---|---|
| **Default (recommended)** | `{"compatible":"4.0","target":"4.4","minVersion":"4.0"}` | You want the public **T‑Rex 3 simulator image (API 4.0)** plus T‑Rex Ultra 2 (4.3) for fast iteration, and installability on T‑Rex 3s that haven't updated to Zepp OS 6. Guard 4.2+ calls at runtime, e.g. `getSystemInfo().minAPI >= '4.2'` (compare numerically) or `typeof fn === 'function'` [I] |
| Strict 4.4 | `{"compatible":"4.4","target":"4.4","minVersion":"4.4"}` | Your watch reports **API_LEVEL 4.4** (§1.4) and you use 4.2+ APIs (e.g. custom keyboard, workout nav info, HR zones) everywhere. Cost: probably no public round simulator image can run it (none is ≥ 4.4) [I], so you test on the watch |
| Workout Extension | `{"compatible":"3.6","target":"3.6","minVersion":"3.6"}` (template default) | The docs require ≥ 3.6 [V‑doc]. Raise it only if you need newer APIs |

### 6.4 `targets` and `platforms`: the two targeting modes

| Mode | Platform entry | T‑Rex 3 effect | `[pf]` layouts | Assets dir |
|---|---|---|---|---|
| **Screen-type (v3, recommended by docs and Zepp staff [C #550])** | `{"st":"r","dw":480}` | All round devices with API ≥ minVersion (T‑Rex 3 included) | ✅ `index.r.layout.js` | `assets/<key>.r` |
| Screen-type + resolution | `{"st":"r","sr":"w480","dw":480}` | **Only 480×480 round** (T‑Rex 3 class) | ✅ `index.w480-r.layout.js` | `assets/<key>.w480-r` |
| deviceSource | `{"name":"trex3","deviceSource":8716545}` ×3 | Exactly the T‑Rex 3 | ❌ unless the target key contains `.r` (quirk) | `assets/<key>` |

- `dw` (per-platform design width) is used by official samples and injected by the build, but isn't in the app-json.mdx field table [V‑exp/V‑doc screen-adaption].
- Without `designWidth`/`dw`, the baselines default to 480 round, 390 square and 194 band [V‑doc].

### 6.5 Modules on the T‑Rex 3

| Module | Key | Notes |
|---|---|---|
| Device app pages | `page: { pages: [...] }` | Required for `appType:"app"`. The first page is the entry. Mutually exclusive with `shortcut` [V‑doc] |
| Side service (phone) | `app-side: { path }` | [V‑doc] |
| Settings app (phone) | `setting: { path }` | [V‑doc] |
| Background service | `app-service: { services: ["app-service/x"] }` | Plus permission `device:os.bg_service` to start or stop it [V‑doc] |
| System-event listener | `app-event: { path: "app-service/x" }` | Plus `event:os.*` permissions [V‑doc] |
| Shortcut card | `app-widget: { widgets:[{path,icon,name,runtime:{type:"js"}}] }` | [V‑doc] |
| SecondaryWidget | `secondary-widget` | **Not supported on T‑Rex 3** [V‑doc] |
| Workout Extension | `data-widget: { widgets:[{path,name,icon,window:{isPinned:1},runtime:{ability:[{type:1,subType:[]}]}}] }` | Max 1 widget per appId. `subType []` = all sports. Needs `app.extType:"workout"`. Can include `app-side` [V‑doc/V‑exp] |

### 6.6 Permissions (declare in `permissions`; asked at install and declared at store submission)

| Code | Unlocks |
|---|---|
| `data:os.device.info` | `getDeviceInfo` |
| `device:os.local_storage` | `@zos/storage` localStorage / ShareLocalStorage |
| `device:os.bg_service` | `@zos/app-service` start/stop/exit/getAll, AppService |
| `device:os.notification` | `@zos/notification` |
| `device:os.alarm` | `@zos/alarm` |
| `device:os.geolocation` | GPS sensor |
| `device:os.compass`, `device:os.barometer`, `device:os.accelerometer`, `device:os.gyroscope` | Sensors |
| `device:os.ble` | BLE (used by samples and easy-ble) |
| `device:os.input.method` | Keyboards (4.2 samples) |
| `data:user.info` | `getProfile` |
| `data:user.health` | `addHealthData` |
| `data:user.hd.{heart_rate, spo2, stress, sleep, step, stand, pai, fat_burning, distance, calorie, body_temp, workout}` | Health sensors; `workout` also covers `getSportData` |
| `event:os.health.sleep_status`, `event:os.health.heart_rate_abnl`, `event:os.helath.stress_remind` (sic in docs), `event:os.health.wear_status`, `event:os.system.sleep_mode`, `event:os.weather.{sun_rise,sun_set,moon_rise,moon_set}`, plus in the 4.0 sample `event:os.bp.{high,low,expires}`, `event:os.system.{power_saving,theater_mode,no_disturb}`, `event:customize.<name>` | System events |

- Sources: per-API "permission code" lines in docs [V‑doc], plus samples [V‑exp].
- The docs note that production firmware "does not include the dynamic privileges section" (runtime prompts) [V‑doc].

### 6.7 i18n and icons

- **i18n:**
  - `i18n.<code>.appName` in app.json. For Workout Extensions it's `i18n.<code>["data-widget"].widgets[].name`.
  - Per-module `i18n/<code>.po` files (`msgid` / `msgstr`), read via `getText` (device) or `gettext` (side/settings).
  - 35 codes: ar‑EG, ca‑ES, cs‑CZ, da‑DK, de‑DE, el‑GR, en‑US, es‑ES, fi‑FI, fr‑FR, hi‑IN, hu‑HU, id‑ID, it‑IT, iw‑IL, ja‑JP, ko‑KR, ms‑MY, nb‑NO, nl‑NL, pl‑PL, pt‑BR, pt‑PT, ro‑RO, ru‑RU, sk‑SK, sr‑RS, sv‑SE, th‑TH, tr‑TR, uk‑UA, vi‑VN, zh‑CN, zh‑TW.
  - Set `defaultLanguage` [V‑doc].
- **Watch icon:**
  - **248×248 PNG**, a perfect circle, 240 px content plus a 4 px transparent margin.
  - No pure-black or near-black backdrop.
  - No transparency inside the circle.

  [V‑doc icon-faq, designs/visual/icons]. All templates ship 248×248 [V‑exp].
- **Store icon:** 240×240 PNG, circular, with a transparent surround.
- **Store screenshots:** 360×360 PNG on a transparent background, 3 or more [V‑doc distribute].

---

## 7. Ready-to-use minimal T‑Rex 3 project (device app + side service + settings)

Built and verified: `scratchpad/exp/create/trex-recommended`, 27 KB zab [V‑exp].

### 7.1 `app.json`

```json
{
  "configVersion": "v3",
  "app": {
    "appId": 27963,
    "appName": "TRex Probe",
    "appType": "app",
    "version": { "code": 1, "name": "0.1.0" },
    "icon": "icon.png",
    "vender": "rounak",
    "description": "Personal T-Rex 3 app skeleton: device app + side service + settings"
  },
  "permissions": ["data:os.device.info", "device:os.local_storage"],
  "runtime": {
    "apiVersion": { "compatible": "4.0", "target": "4.4", "minVersion": "4.0" }
  },
  "targets": {
    "trex": {
      "module": {
        "page": { "pages": ["page/home/index"] },
        "app-side": { "path": "app-side/index" },
        "setting": { "path": "setting/index" }
      },
      "platforms": [{ "st": "r", "dw": 480 }],
      "designWidth": 480
    }
  },
  "i18n": { "en-US": { "appName": "TRex Probe" } },
  "defaultLanguage": "en-US",
  "debug": false
}
```

- Put `icon.png` (248×248) in `assets/trex.r/`.
- **Before publishing:** replace `appId` with the console-assigned ID.
- **To build only the 480×480 package:** use `"platforms":[{"st":"r","sr":"w480","dw":480}]`, rename the layout to `index.w480-r.layout.js`, and the assets dir to `assets/trex.w480-r/` [V‑exp].
- **For Zepp OS 6 only:** set all three apiVersion values to `"4.4"` (§6.3).

### 7.2 `page/home/index.js`: an on-watch firmware / API probe

```js
import { createWidget, widget } from '@zos/ui'
import { getSystemInfo } from '@zos/settings'
import { getDeviceInfo } from '@zos/device'
import { log } from '@zos/utils'
import { TITLE_STYLE, INFO_STYLE } from 'zosLoader:./index.[pf].layout.js'

const logger = log.getLogger('trex-probe')

Page({
  build() {
    const { osVersion, firmwareVersion, minAPI } = getSystemInfo()          // API 2.1+
    const { deviceSource, width, height, keyNumber } = getDeviceInfo()      // needs data:os.device.info
    const lines = [`OS ${osVersion}`, `FW ${firmwareVersion}`, `API_LEVEL ${minAPI}`,
                   `src ${deviceSource} ${width}x${height} keys ${keyNumber}`]
    logger.log(lines.join(' | '))
    createWidget(widget.TEXT, { ...TITLE_STYLE, text: 'T-Rex probe' })
    createWidget(widget.TEXT, { ...INFO_STYLE, text: lines.join('\n') })
  }
})
```

### 7.3 `page/home/index.r.layout.js`

```js
import { align, text_style } from '@zos/ui'
import { px } from '@zos/utils'
export const TITLE_STYLE = { x: px(40), y: px(90), w: px(400), h: px(50), color: 0xffffff,
  text_size: px(36), align_h: align.CENTER_H, align_v: align.CENTER_V }
export const INFO_STYLE = { x: px(60), y: px(160), w: px(360), h: px(220), color: 0xcccccc,
  text_size: px(28), align_h: align.CENTER_H, align_v: align.TOP, text_style: text_style.WRAP }
```

### 7.4 `app-side/index.js` and `setting/index.js`

```js
// app-side/index.js: runs inside the Zepp phone app
AppSideService({
  onInit() {
    console.log('side service init; note =', settings.settingsStorage.getItem('note'))
    settings.settingsStorage.addListener('change', ({ key, newValue }) => console.log('setting changed', key, newValue))
  },
  onRun() {},
  onDestroy() {}
})
```

```js
// setting/index.js: Settings App UI in the Zepp phone app
AppSettingsPage({
  build(props) {
    return View({ style: { padding: '12px' } }, [
      Text({ paragraph: true }, 'TRex Probe settings (runs inside the Zepp phone app)'),
      TextInput({ label: 'Note', settingsKey: 'note', onChange: (v) => props.settingsStorage.setItem('note', v) })
    ])
  }
})
```

Plus the scaffold's `app.js`, the `global.d.ts` shim (§3.6) and `package.json` with `"devDependencies": {"@zeppos/device-types": "^4.0.0"}`.

---

## 8. Distribution

### 8.1 Developer registration and the console

- **Account:** a Zepp account (register or log in at user.zepp.com universal login), then **Zepp Developer Console https://console.zepp.com** ("Zepp Open Platform"). Use email/password: third-party logins don't work in the CLI or simulator [V‑doc].
  - No individual-vs-company verification step is documented for free apps.
  - "Certified corporate developer" status only matters for paid listings (§8.4).
- **Create App:** enter a name → an **appId is assigned** → put it in `app.json` [V‑doc].
- **Submission form [V‑doc]:**
  - country / region
  - category (fixed to "Workout Extension" for those)
  - ZAB upload (appId must match)
  - supported devices (auto-detected from the ZAB; **Zepp may auto-adapt and distribute your app to new devices later**)
  - version (auto)
  - languages (name, short and long description, preview images)
  - 360×360 screenshots
  - 240×240 icon
  - **privacy statement (required)**
  - permissions used
  - whether the package includes third-party SDKs (name and purpose)
- **Review:** "generally 1–5 working days". If rejected, Edit and resubmit. Updates go through "Version Upgrade" [V‑doc].
  - Community timelines: submitted 2026‑09‑19, published 2026‑09‑21 [C #568]; submitted 2026‑07‑07, approved 2026‑07‑15 [C #530].
- **Store behaviour to know:**
  - **No direct install links** for store apps; discovery is store search, and one dev saw a search-indexing hiccup after approval [C #530].
  - **The store serves re-built packages to most devices**, T‑Rex 3 included: plain `.js` instead of `.bin`, `packageInfo.mode:"cloud"`, zpm 3.2.13‑beta, widget names overwritten with the store name. A dev linked this to black-screen bugs [C #568, 2026‑09‑22, unresolved]. Install your own app from the store once it's live and retest.
  - Dev (preview) installs can show the app or widget name as **"NULL"** in system lists; this goes away after store publication [C #532].
- **Workout Extension differences [V‑doc]:**
  - The store overlays a logo on the icon, so keep its top area clear.
  - The category is automatic.
  - The name can't duplicate one of your mini program names (e.g. "Go Pro" → "Go Pro Extension").
  - It's a separate appId.

### 8.2 The `.ip-package` ("intermediate product") and what gets uploaded

- **Contents:** a production `zeus build` adds `.ip-package`, a zip of your **project sources**.
  - Only hard-coded patterns are excluded: dot-files and dot-dirs, `dist/`, `node_modules/`, lockfiles, archives, some media, `.DS_Store`.
  - `.gitignore` isn't used [V‑code/V‑exp].
- **The build's notice:** by including it, you authorize Zepp to rebuild and distribute your package to other devices with the same CPU architecture and resolution.
- **Opting out:** `zeus prune --ip` removes it, "but then you'll have to manually provide a build for each device type" [V‑exp console text].
- **Practical:**
  - Keep private notes, keys and scratch files out of the project root, or name them as dotfiles.
  - Preview uploads (mode "preview") don't include it [V‑code].

### 8.3 Private / personal use (no store)

- `zeus preview` → QR → install. The QR is valid **7 days**, and other people's Zepp accounts can scan it (community practice for testers) [V‑code/C].
- **Persistence:** I found no official statement and no community report of preview installs expiring. Developers run them long-term [C, absence of reports].
  - Each build embeds `packageInfo.expiredTime: 172800` (48 h) next to the build timestamp, in production *and* preview modes, with no documentation [V‑code/V‑exp]. Treat this as an open question: watch whether your install survives more than 48 h, reboots and firmware updates [I].
  - A factory reset or re-pair removes it; keep your build pipeline handy [I].
- `zeus bridge` → `install` is an alternative (same account on both ends) [V‑doc].
- **Test groups:** the docs' "join test group" only unlocks **test simulator images** via a 10-digit code. I found no TestFlight-like beta channel for apps [V‑doc]. The Discord "beta program" channels were Zepp OS betas for existing developers [C].

### 8.4 Monetization

- **Official paid listings: only certified corporate developers in Mainland China** [V‑doc paid-app FAQ].
  - Listings can then appear in overseas stores. Tiers: $1.99 / $2.99 / $3.99.
  - The developer nets about 55% (100% − 15% Zepp − 30% Apple/Google).
  - Outside Mainland China, individuals can't sell paid apps or watchfaces through the official channel.
- **In-app purchase:** allowed via "reasonable" schemes like **KiezelPay** or QR-code donation/reward, **explained at submission** [V‑doc].
  - KiezelPay is actively used in 2026 store apps (a `page/kpay/` page in #568; purchases in #530) [C].
  - npm `kpay-amazfit` 2.0.4 was last published 2023 [V‑data].

---

## 9. Alternatives and risks

- **Gadgetbridge:**
  - Lists the T‑Rex 3 as **"Unknown support"** (the T‑Rex 3 Pro is "Highly supported").
  - Can **install apps (.zip / .zab) and watchfaces** on Zepp OS devices, with experimental app management.
  - Still needs an **initial pairing with the Zepp app** to extract the auth key.
  - **Side-app JavaScript (side service, settings, fetch) isn't supported in releases**: issue #3266 has been open since 2023; last activity 2026‑03‑21; work lives in branches only.
  - Zepp Flow, maps and others are listed unsupported. BLE LE uploads are capped at about 2 MB (map zips; BT Classic is optional).

  [C: gadgetbridge.org Amazfit and Zepp OS pages; Codeberg #3266, #4721]. Upshot: device-only apps can be sideloaded without Zepp's cloud after the initial pairing; phone-dependent apps can't [I].
- **Account and ToS constraints:**
  - The CLI, simulator login, preview and bridge all tie you to Zepp's cloud and account (email/password).
  - Builds carry telemetry; production builds carry sources; the store may rebuild your code.

  [V‑code/C]
- **Platform lifetime:** T‑Rex 3 software support runs until Sept 2027, per a Zepp support page change, with no press release [C].
- **Tooling health:** Zeus CLI and zpm are updated about monthly [V‑data]. Docs, release notes and the device table lag. Simulator images lag firmware (T‑Rex 3 image at API 4.0) [V‑data]. Staff respond on the GitHub forum and Discord (`https://t.zepp.com/t/b6e70`, "myoungxue") [C].

---

## 10. Day‑1 setup checklist (this Mac, fish, nix)

1. **Watch:**
   - In the Zepp app, update the T‑Rex 3 to the latest firmware (expect 6.3.x).
   - Note the firmware number.
   - Enable Developer Mode: Profile → Settings → About → tap the Zepp icon 7 times.
   - Use Developer Mode → **Device information** to read the **API_LEVEL** (expect 4.4).
2. **Account:**
   - Make sure the Zepp account the phone uses has **email + password**. For a Google/Apple signup, bind an email and use "Forgot password" to set one.
   - Use the same account for `zeus login` (required for bridge).
3. **Node:** the Homebrew Node 26.9 works. For reproducibility, optionally pin LTS in the project, e.g. `nix shell nixpkgs#nodejs_24` or a flake devShell with `nodejs_24` [I].
4. **Zeus CLI.** Pick one:
   - **A: global, into your existing npm prefix `~/.npm-packages`**
     ```fish
     npm i -g @zeppos/zeus-cli@1.9.3
     fish_add_path ~/.npm-packages/bin     # if not already on PATH
     zeus -v                                # expect zeus v1.9.3, zpm v3.4.2
     ```
   - **B: pinned per project (verified)**
     ```fish
     echo 'install-strategy=nested' > .npmrc
     npm i -D @zeppos/zeus-cli@1.9.3 @zeppos/device-types@^4.0.0
     npx zeus -v
     ```
   - Don't use `npx @zeppos/zeus-cli` or a hoisted `npm i -D`: both crash (§3.1).
5. **Simulator:**
   ```fish
   curl -LO https://upload-cdn.zepp.com/zepp-applet-and-wechat-applet/20260717/simulator-2.1.2-macos-arm64.dmg
   shasum -a 256 simulator-2.1.2-macos-arm64.dmg   # a773f4f8…e592 (what I got)
   open simulator-2.1.2-macos-arm64.dmg            # drag simulator.app to /Applications
   ```
   - Launch it and download **"T‑Rex 3 v1.0.2"** (API 4.0) plus **"T‑Rex Ultra 2 v1.0.0"** (API 4.3, 480×480, 4 keys).
   - Select a model and click "Device Simulator".
   - Skip the v1 Tunnelblick instructions.
   - The side service needs internet (a remote runtime).
6. **Scaffold:**
   ```fish
   zeus create my-trex-app --appType app --APILevel 4.0 --template Empty --withAppSide --withSettings --shape r
   cd my-trex-app
   npm i -D @zeppos/device-types@^4.0.0
   ```
   - Then edit `app.json` per §7.1 (apiVersion, permissions, target key and assets folder name).
   - Add the `declare module "zosLoader:*"` shim to `global.d.ts`.
7. **Iterate:** `zeus dev -t "Amazfit T-Rex 3"` with the T‑Rex 3 Device Simulator open. Check logs in the simulator Console. Optionally add `@silver-zepp/vis-log` + `@zeppos/zml`.
8. **Watch install:**
   - `zeus login` (a browser opens)
   - `zeus preview -t "Amazfit T-Rex 3"`
   - Zepp app → Developer Mode → **Scan** (within 7 days).
   - If you see "Download failed, error code: null": check the selected watch and model, wait for syncs or OTAs to finish, and avoid Zepp app 10.8.0 if affected.
9. **Probe:** install the §7 probe to record OS / FW / API_LEVEL from the watch itself. Decide `minVersion 4.0` vs `4.4` (§6.3).
10. **Before sharing or publishing:**
    - `zeus build`
    - Decide on `zeus prune --ip`.
    - Keep secrets out of the project folder.
    - Get a real appId in console.zepp.com.
    - Prepare the privacy statement, 240 px icon and 360 px screenshots.

---

## 11. Toolchain pitfalls (quick list)

1. **The docs' device table is stale** (T‑Rex 3 at API 4.0). Real: 4.4 on Zepp OS 6. CLI and simulator release notes stop in 2022/2023.
2. **`npx` or a hoisted local install of zeus-cli → `Cannot find module 'zeppos-app-utils'`.** Use a global install or `install-strategy=nested`.
3. **`zeus create` → `TypeError: Cannot read properties of undefined (reading 'push')`** when *any* globally installed Yeoman generator exposes `:app`/`:all`. zeus calls `yeoman-environment.lookup()` and pushes into `watchfaceTemplateChoices['3.0'…'4.0']`, which don't exist [V‑code].
   - Likely triggers: `create-zos` / `generator-zos`, `generator-code` [I].
   - Community reports on M-series Macs (#350, #544) [C].
   - Fix: remove global generators, or patch `watchfaceTemplateChoices` to include all levels [C #544].
4. `--appType` must be lowercase (`app`, `watchface`, `workout_extension`). Uppercase or other values fall back to interactive prompts, which crash with stdin closed. Use `--APILevel 4.0`, not the old `--OSVersion v4`.
5. Scaffolds pin `@zeppos/device-types ^3.0.0`. Bump to `^4.0.0`.
6. The scaffold's `appId` is random. Replace it with the console ID before publishing.
7. Using `deviceSource` platforms breaks `zosLoader:…[pf]…` imports (the build still "succeeds") and changes the assets folder naming. Prefer `st` / `sr`.
8. No TypeScript compilation. `.ts` imports fail the build.
9. `.ip-package` = your source code, and it ignores `.gitignore`. Stray files get uploaded on submission. Use `zeus prune --ip` or dotfiles.
10. The store may rebuild your package (JS instead of bytecode, older zpm) and show different behaviour. Retest the store build [C].
11. QR codes expire after 7 days. The model must match the connected watch. Syncs or OTAs block installs. Zepp 10.8.0 QR bug [C].
12. Google/Apple Zepp logins can't use the CLI or simulator. Bridge needs identical accounts [V‑doc/C].
13. The first build and every 3 days need internet (device registry). No network and no cache means a failed build [V‑code].
14. The simulator's T‑Rex 3 image is API 4.0. No public round API 4.4 image. The side service in the simulator depends on remote Zepp runtimes (VPN or region issues) [V‑data/C].
15. `minVersion` above every device's API ("4.5") gives "no matching target devices". `zeus dev/preview` says "API Level version is too high…" [V‑exp/V‑code].
16. The Workout Extension template leaves a stray zh-CN widget name and needs `extType:"workout"`. You add it from the Workout app on the watch, not the app list [V‑exp/V‑doc].
17. Telemetry on every CLI command, no opt-out found [V‑code].
18. The VS Code extension is deprecated. Use device-types for IntelliSense [V‑doc/C].
19. Docs say Node ≥ 14. Reality is ≥ 20 (ora 9). Node 26 works, 24 LTS is recommended.
20. The Settings-App real-device logs aren't available in the Zepp app. Use VisLog 1.5 relaying [V‑doc].

---

## 12. Open questions (not resolved here)

- Whether preview-installed apps really persist indefinitely, and what `packageInfo.expiredTime: 172800` does.
- Whether the simulator refuses apps whose `minVersion` exceeds the image's API level. Very likely, but untested.
- On-device runtime support for Promise, async, generators and timers on API 4.4 (the build accepts them; the docs say no).
- The exact new APIs in API 4.3 / 4.4 (the docs haven't caught up).
- Whether the Zepp app 10.x redesign moved the Developer Mode entry. The docs path is from pre-10.

---

## 13. Sources

- **Local docs (zeppos-docs HEAD c08725b):**
  - `docs/guides/quick-start/*`, `docs/guides/tools/cli/index.md` and `release-note.md`, `docs/guides/tools/simulator/{download,setup,index,release-note}.md`
  - `docs/guides/tools/zepp-app.mdx`, `docs/guides/faq/*` (developer-bridge-mode, env-setup, preview-error, simulator-faq, icon-faq, join-test-group, paid-app, third-party-login)
  - `docs/guides/tools/npm/*`, `docs/guides/tools/vscode-extension/*`
  - `docs/reference/app-json.mdx`, `docs/guides/framework/device/{screen-adaption,compatibility,permission,app-service,system-event,js-support}.md`
  - `docs/guides/architecture/folder-structure.mdx`, `docs/guides/best-practice/{code-adaptations-for-new-devices,multi-screen-adaption,debug,error-catch,i18n}.mdx`
  - `docs/guides/workout-extension/*`, `docs/distribute/index.md`, `docs/reference/related-resources/{device-list,physical-keys,language-list}.mdx`
  - `docs/guides/version-info/new-features-4{0,2}.md`
  - `docs/reference/device-app-api/newAPI/settings/getSystemInfo.mdx`, `…/device/getDeviceInfo.mdx`, `…/ui/openInspector.mdx`
  - `docs/designs/visual/icons.md`
- **Docs history (GitHub API):** commits 8bd0df4c, a7cbd60d, 46787caf, 169f1af1, 03e3e8ed of `device-list.mdx`.
- **Samples:** `zeppos-samples/application/4.0/*`, `…/4.2/*`, `workout-extensions/3.5/*`. **Visual logger:** `visual-logger/README.md`. **Community list:** `awesome-zeppos/README.md`.
- **npm registry:** `@zeppos/*` (org listing), `create-zos`, `zeusx`, `kpay-amazfit`, `ora@9` engines.
- **Zepp CDN data (fetched 2026‑09‑28):** https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json · https://upload-cdn.huami.com/zeppos/simulator/download/emulatorList.json
- **Consumer and official pages:** https://os.zepp.com/compatibility-zepp-os-6 · https://us.amazfit.com/products/amazfit-t-rex-3 · https://us.amazfit.com/blogs/product-update/t-rex-3-december-2025-software-updates · https://www.zepp.com/press-release/zepp-health-introduces-zepp-os-4-redefining-wearable-intelligence-by-integrating-openais-gpt-4o-into-its-amazfit-smartwatches · https://developer.zepp.com/os/develop-studio · https://developer.zepp.com/os/activity-hackathon-2024
- **News:**
  - https://gadgetsandwearables.com/2026/07/22/amazfit-t-rex-3-pro-ultra-2-zepp-os-6-update/
  - https://gadgetsandwearables.com/2026/06/06/zepp-os-6-rollout-schedule/
  - https://gadgetsandwearables.com/2026/08/19/amazfit-t-rex-3-update-6-3-13-5/
  - https://gadgetsandwearables.com/2026/09/03/amazfit-t-rex-3-pro-ultra-2-update-6-3-25-7/
  - https://gadgetsandwearables.com/2026/02/04/amazfit-t-rex-3-firmware-extension/
  - https://thewearify.com/amazfit-t-rex-3-receives-zepp-os-5-0-update/
  - https://the5krunner.com/specs/amazfit/t-rex-3/
  - https://the5krunner.com/2026/06/07/amazfit-roadmap-q3-2026/
  - https://gadgetsandwearables.com/2025/09/06/amazfit-t-rex-3-pro-vs-t-rex-3/
- **Community forum (github.com/orgs/zepp-health/discussions; repo zeppos-forum):** #306, #350, #403, #475, #478, #519, #520, #528, #530, #532, #544, #547, #550, #552, #568.
- **Gadgetbridge:** https://gadgetbridge.org/gadgets/wearables/amazfit/ · https://gadgetbridge.org/basics/topics/zeppos/ · https://codeberg.org/Freeyourgadget/Gadgetbridge/issues/3266 · https://codeberg.org/Freeyourgadget/Gadgetbridge/issues/4721
