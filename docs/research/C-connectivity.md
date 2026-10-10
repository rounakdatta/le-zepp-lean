# C — Connectivity on Zepp OS for the Amazfit T-Rex 3

> **Provenance:** a detailed research report written on 2026-09-28 by one of six parallel research agents; the summary is in [README.md](README.md).
> Paths like `scratchpad/src/<repo>/…` refer to clones of `github.com/zepp-health/<repo>` (for example `zeppos-docs`, `zeppos-samples`, `zml`, `easy-ble`). Other `scratchpad/…` paths were temporary working files that were not kept. Nothing here was tested on the physical watch unless the text says so.


Watch↔phone messaging, Side Service, Settings App, internet access, BLE Central, and cloud APIs.

Research date: 2026-09-28. Scope: connectivity only. UI/runtime, sensors/workouts, app types and toolchain are covered in the other reports and appear here only for context.

---

## 0. TL;DR: the decisions that matter

1. **The watch has no network API.** The T-Rex 3 does have 2.4 GHz Wi-Fi hardware, but only the system uses it (maps, OTA updates, a music-transfer hotspot). No `@zos/*` module exposes Wi-Fi, HTTP or sockets. All internet traffic for a mini app goes watch →(BLE)→ Zepp phone app → Side Service `fetch()` → internet. **[V]**
2. **The Side Service is a JS worker inside the Zepp phone app, not a daemon you control.** It starts on demand for five reasons. In order of importance:
   - the watch app's handshake (`peerAppLaunched`)
   - the Settings App being opened (`settingsAppLaunched`)
   - a settings change (`settingsChanged`)
   - a file arriving from the watch (`fileTransfer`)
   - a file picked in the Settings App (`inputFile`)

   It is destroyed after about **10 minutes with no activity** (a sweep runs every 60 s). No public API wakes it on a timer, so there is no server-push channel. **[V-code]** (the official framework build, §4.2)
3. **Watch↔phone messaging uses BLE with 3600-byte frames.** ZML splits and reassembles messages in 3518-byte chunks. Defaults: 5 s handshake timeout and 60 s request timeout. There is no app-level ACK or retry beyond request/response. A ZML bug means pending requests are not rejected when BLE drops; they fail only when their timeout fires. **[V-code]**
4. **BLE Central works on the T-Rex 3** (API_LEVEL 3.0+) **in foreground pages only.** The `mst*` APIs are excluded from background App Services **[V-doc]**. In practice you get one peripheral at a time, a small MTU, notifications but no indications, and flaky pairing **[C]**. The watch **cannot** act as a peripheral or advertiser (official statements, 2023 and 2024) **[V-staff]**.
5. **Zepp has no self-serve cloud API for a user's health data.** The Huami/Zepp Open Platform REST API is partner-only (companies, or PhD research). Other routes are the phone health hubs (Health Connect is write-only from Zepp; Apple Health), Strava and similar, or reverse-engineered private APIs. **[V-doc]**/**[C]**
6. **Firmware and API level.** Zepp's own Zeus device registry lists the T-Rex 3 at **Zepp OS 6.0 / API_LEVEL 4.4** (all three deviceSources). The docs device list still says 4.0 / 4.5 and is out of date. **Every connectivity API in this report is API ≤ 4.0**, so connectivity does not depend on the OS 6 update. The one exception is `getDeviceInfo().uuid` (4.2), which needs Zepp OS 6 firmware. **[V-code]**
7. **Workout Extensions (DataWidget) currently cannot use messaging or the Side Service** on current firmware. A developer on a T-Rex 3 Pro (fw 6.3.13.5, Aug 2026) got "NOT A FUNCTION" errors, and the official sample fails there too. **[C]**

Legend used throughout:
- **[V-doc]**: verified in the official docs.
- **[V-code]**: verified by reading official code: ZML, the samples, easy-ble, or the runtime bundles Zepp serves from `zepp-os.zepp.com` (see §15).
- **[V-staff]**: a statement by Zepp staff in official GitHub discussions.
- **[C]**: community report.
- **[I]**: my inference.

---

## 1. Device baseline and API levels

| Item | Value | Source |
|---|---|---|
| Current OS / API_LEVEL | Zepp OS **6.0**, API_LEVEL **4.4** (`apiLevelLimitMax 4.4`) for deviceSources 8716544, 8716545, 8716547 | Zeus registry `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json` (saved as `scratchpad/runtime/devices.json`) **[V-code]** |
| Docs device list | Still shows 4.0 / 4.5 (both the local clone and the live page) | `src/zeppos-docs/docs/reference/related-resources/device-list.mdx`; https://docs.zepp.com/docs/reference/related-resources/device-list/ **[V-doc]**, out of date |
| Firmware history | Zepp OS 4.5 (Apr 2025), then Zepp OS 5 as fw 4.1.5.1 (Nov–Dec 2025), then Zepp OS 6 (fw 6.2.104.6 and 6.3.x, from Jul 2026) | https://thewearify.com/amazfit-t-rex-3-receives-zepp-os-5-0-update/ ; coordinator note **[C]** |
| Radios | "WiFi 2.4GHz, Bluetooth 5.2, BLE" | https://us.amazfit.com/products/amazfit-t-rex-3 **[V vendor spec]** |
| NFC | Registry flags `nfc: true` on 8716544 and 8716545 | devices.json **[V-code]**. There is no NFC module in the device API docs or typings, so it is not usable by apps **[I]** |

**What API 4.1–4.4 adds for connectivity.** Only `@zos/device.getDeviceInfo().uuid`: a 32-byte unique device ID, API 4.2 **[V-doc]**, `src/zeppos-docs/static/llms/@zos-device.md`. It is useful as a server-side device identity and needs Zepp OS 6 firmware. The typings in `@zeppos/device-types` 4.0.0 (published 2026-06-17) contain no new BLE, network or socket APIs. Modules declared: alarm, app, app-access, app-service, ble, device, display, fs, i18n, interaction, notification, page, router, sensor, settings, storage, timer, transfer-file, ui, user, utils **[V-code]** (`scratchpad/npm/dt400/package/dist/index.d.ts`).

**Recommendation.** Set `runtime.apiVersion.minVersion` to `"4.0"` or lower. That covers watches still on older firmware and loses no connectivity features. Check your own watch's level in the Zepp App developer mode under "Device information" (`docs/guides/tools/zepp-app.mdx`) **[V-doc]**.

---

## 2. Architecture

```
┌──────────── Watch (Zepp OS) ────────────┐        ┌─────────── Phone: Zepp App ───────────┐        ┌── Internet / LAN ──┐
│ Device App (pages)                      │  BLE   │ Side Service (JS worker, no UI)        │ HTTP(S)│ your server / APIs  │
│ App Service (background, no UI)         │◄──────►│   messaging.peerSocket ◄── ZML         │───────►│ Home Assistant, ... │
│ Workout Extension (DataWidget)*         │        │   fetch / downloader / image / fs      │        └─────────────────────┘
│   @zos/ble: createConnect/send          │        │   settings.settingsStorage ◄──┐        │
│   @zos/ble/TransferFile                 │        │ Settings App (WebView, React) ─┘        │
│   @zos/ble mst* (BLE Central) ──► peripherals (ESP32, sensors, PC GATT server)          │
└─────────────────────────────────────────┘        └────────────────────────────────────────┘
* messaging currently broken inside Workout Extensions (§7.6)
```

The docs define the parts this way (`src/zeppos-docs/docs/guides/architecture/arc.mdx`) **[V-doc]**:
- **Device App**: runs on the watch.
- **Settings App** (optional): runs inside the Zepp phone app and draws UI through a render function.
- **Side Service** (optional): runs inside the Zepp app and "can communicate with external servers through Fetch API".

Communication relationships:
- **BLE** carries all Device App ↔ Side Service traffic. ZML wraps it: `this.request` (watch) → `onRequest` (side), and `this.call` (side) → `onCall` (watch).
- **settingsStorage** carries all Side Service ↔ Settings App traffic. Setting a key in one place fires `change` in the Side Service or re-runs the Settings App's `build`.
- "Direct communication between 'Device App' and 'Settings App' is not possible and requires a 'Side Service'" **[V-doc]**.
- Undocumented: a direct side ↔ settings channel also exists, `messaging.settingsAppPeerSocket` (§4.6) **[V-code]**.

---

## 3. Watch ↔ phone messaging

### 3.1 Device-side low-level API: `@zos/ble` (API_LEVEL 2.0+, works on T-Rex 3) **[V-doc]**

`src/zeppos-docs/docs/reference/device-app-api/newAPI/ble/*.mdx`

| Function | Signature | Notes |
|---|---|---|
| `createConnect(cb)` | `cb(index?: number, data?: ArrayBuffer, size?: number)` | Registers the receive callback and opens the channel |
| `send(data, size)` | `(ArrayBuffer, number) => void` | No size limit is documented. ZML never sends more than 3600 B per call (§3.3) |
| `connectStatus()` | `() => boolean` | Phone-link status |
| `addListener(cb)` / `removeListener()` | `cb(status: boolean)` | Link up/down events |
| `disConnect()` | | Call in `App.onDestroy` to avoid leaks (`best-practice/bluetooth-communication.mdx`) |

The raw API carries binary only: "Currently, only binary data is supported" **[V-doc]**. Use ZML rather than the raw API.

### 3.2 Side-service Messaging API **[V-doc + V-code]**

`src/zeppos-docs/docs/reference/side-service-api/messaging.mdx`

```js
messaging.peerSocket.addListener('message', (payload /* ArrayBuffer */) => { ... })
messaging.peerSocket.send(buffer /* ArrayBuffer */)
```

The runtime adds details the docs omit (`scratchpad/runtime/decoded_xc.js`) **[V-code]**:
- `peerSocket.MAX_MESSAGE_SIZE = 3584`
- `readyState` takes the values `INIT`, `OPEN` and `CLOSED`
- an internal state machine handles Shake, Data, Heart and Close frames
- when the watch has closed the session, **sends from the side service are rewritten into a Close frame**. The side service cannot push to a watch app that is not running.

### 3.3 ZML (`@zeppos/zml`), the library to use

ZML is at 0.0.43 on npm (2026-01-08); the local clone is 0.0.41.
- It needs API_LEVEL ≥ 3.0, and the latest versions need ≥ 3.6. The T-Rex 3 meets both. `src/zml/README.md`, `src/zml/docs/known-issues.md` **[V-doc]**
- Messaging constants are identical in 0.0.41 and 0.0.43 (`scratchpad/npm/zml43/package/dist/*`) **[V-code]**.

**Wiring**
- Watch `app.js`: `App(BaseApp({...}))`. This creates the message builder and calls `createConnect` on app create.
- Watch pages: `Page(BasePage({...}))`.
- Phone `app-side/index.js`: `AppSideService(BaseSideService({...}))`.

The watch side declares these entries in `app.json` under `targets.*.module`:
- `"page": {"pages": [...]}`
- `"app-side": {"path": "app-side/index"}`
- `"setting": {"path": "setting/index"}`

Source: sample `src/zeppos-samples/application/4.0/fetch-api/app.json` **[V-code]**.

**API** (`src/zml/zml.d.ts`, `src/zml/README.md`) **[V-code]**

| Where | Method | Semantics |
|---|---|---|
| watch page, app, App Service* | `this.request({method, params}, {timeout?})` → `Promise<result>` | RPC to the side's `onRequest(req, res)`; the reply is node-style `res(err, data)` |
| watch | `this.call({method, params})` | Fire-and-forget to the side's `onCall(data)` |
| watch | `this.httpRequest({url, method, headers?, body?, timeout?})` → `{status, statusText, headers, body}` | Proxied: the side's built-in `http.request` handler calls `fetch` |
| watch | `onCall(data)`, `onRequest(req,res)`, `onReceivedFile(file)`, `onBleChanged(status)` hooks | |
| watch | `this.sendFile(path, params)` | TransferFile outbox |
| side | `this.request(...)`, `this.call(...)`, `this.fetch(opts)`, `this.download(url, opts)`, `this.sendFile(path, params)`, `this.convert(opts)` | |
| side | hooks: `onInit`, `onRun`, `onDestroy`, `onRequest`, `onCall`, `onSettingsChange({key,newValue,oldValue})`, `onReceivedFile(file)` | `onSettingsChange` also fires when the launch reason was `settingsChanged` |
| side exports | `settingsLib` (getItem/setItem/removeItem/clear/getAll), `convertLib.convert()` | |

\*For App Services, Zepp staff recommend `AppService(BasePage({ ... this.httpRequest(...) }))` (https://github.com/orgs/zepp-health/discussions/351, Jun 2024) **[V-staff]**.

**Wire format and limits** (`src/zml/src/shared/message.js`) **[V-code]**
- Transport frame: `MESSAGE_SIZE = 3600` bytes, made of a 16-byte header plus a 3584-byte payload. The header carries flag, version, type, port1, port2, appId and extra. The official side-service scheduler uses the same constants (`messageSize 3600`, `messagePayloadSize 3584`) (`scratchpad/runtime/mobile-main-service.js`) **[V-code]**.
- Each frame payload carries a 66-byte "HM protocol" header, so **3518 bytes of user data per chunk** (`HM_MESSAGE_PROTO_PAYLOAD`). The header fields are traceId, spanId, seqId, totalLength, payloadLength, type, opCode, timestamps and content/data types.
- Large messages are split into Continued and Finished chunks and reassembled per `traceId`. `totalLength` is a UInt32 and there is **no hard cap**. The real limit is watch RAM, because reassembly calls `Buffer.concat` on everything in memory **[I]**. Keep messages to tens of KB and use TransferFile for anything bigger.
- Payload types are JSON, text or binary, detected automatically. Plain objects are wrapped as `{jsonrpc: 'hmrpcv1', ...}`.

**Timeouts and error codes** **[V-code]**
- Handshake ("shake") timeout: **5000 ms** (`MessageShakeTimeOut`, `shakeTimeout`).
- Request timeout: **60000 ms** by default. Override it per call: `this.request(data, {timeout: 10000})`.
- Side-side `fetch` default in ZML's http proxy: **10000 ms** (`addBaseURL` sets `timeout: 10000`).
- Error codes (`MessageErrorCode`): `1 SHAKE_TIME_OUT`, `2 BLE_CLOSE`, `3 APP_CLOSE` ("side service is not running"), `4 REQUEST_TIME_OUT`.

**Reconnection behaviour** **[V-code]**
- Every device-side `request()` and `call()` first runs `fork()`, a fresh handshake unless one is pending. After a BLE drop and reconnect, the next request re-establishes the session on its own.
- A request made while BLE is down is rejected at once with code 2 (`errorIfBleDisconnect()` calls `connectStatus()`).
- **Bug, present in both 0.0.41 and 0.0.43:** on a BLE-down event ZML loops `for (const [_, v] of Object.entries(this.handlers))`, but `handlers` is a `Map`. The loop does nothing, so in-flight requests are *not* rejected. They are cleared and reject only when their own timer fires (60 s by default) with code 4. Use shorter `timeout`s.
- The side cannot `call()` the watch until the watch has handshaken (made a `request()`) at least once (ZML issue #3, https://github.com/zepp-health/zml/issues/3) **[C]**. This matches the runtime state machine above **[V-code]**.

**Reliability**
- There is no app-level ACK, retry or resume in ZML. A dropped chunk means the reassembly never completes and the request times out **[V-code]** (reading `Session.checkIfReceiveAllChunks`).
- Design every upload to be idempotent (message IDs), keep an outbox on the watch, and retry **[I]**.

### 3.4 Throughput and latency

- **There are no official numbers.** Measure early on your watch and phone **[I]**.
- About **8 KB/s** was reported for a message-based file-transfer polyfill ("the transfering speed could only reach 8kb/s") (https://github.com/CuberQAQ/zepp-transfer-file-side) **[C]**. Native `TransferFile` is probably faster but has not been measured **[I]**.
- Base64 or hex encoding across the phone's JS↔native bridge makes binary fetches "ugly and very slow" (https://github.com/orgs/zepp-health/discussions/217) **[C]**. The runtime still hex-encodes fetch bodies and responses internally **[V-code]**.
- A native "Exceeded maximum queue limit(5)" error (code −32502) shows up intermittently, even when sending one request at a time; the reporter fixed it by reinstalling the Zepp app (https://github.com/zepp-health/zml/issues/9) **[C]**. The error is not raised in the JS runtime, so it comes from the native host **[V-code, absence]**.
- **Implication:** plan for small request/response RPCs and batching, not high-rate streaming. Streaming raw accelerometer data at tens of Hz to the phone is not realistic **[I]**.

### 3.5 File transfer (`TransferFile`)

Watch side: API_LEVEL 3.0, works on T-Rex 3. Two-way transfer between the Device App and the Side Service.
- Docs: `src/zeppos-docs/docs/reference/device-app-api/newAPI/transfer-file/TransferFile.mdx` and `docs/reference/side-service-api/transfer-file.mdx` **[V-doc]**

**Watch API**
- `import TransferFile from '@zos/ble/TransferFile'; const tf = new TransferFile()`
- Receive: `tf.getInbox().on('NEWFILE' | 'FILE', cb)`, then `getNextFile()`.
- Send: `tf.getOutbox().enqueueFile(path, params)`.
- `FileObject` fields: `{sessionId, fileName, filePath, params, fileSize, readyState, cancel(), on('change'|'progress', cb)}`.
- `readyState` values: `pending | transferring | transferred | error | canceled`.

**Side API**
- The global `transferFile` provides `getOutbox().enqueueFile(path, params)` and `getInbox().getNextFile()`.
- ZML listens on `transferFile.inbox.on('file')` (`src/zml/src/core/common/file-transfer.js`) **[V-code]**.

**Behaviour**
- A file sent from the watch while no side service is running **launches it** with `sideService.launchReasons.fileTransfer = true`; ZML re-emits the file (`file-transfer-plugin.js`, runtime scheduler `LAUNCH_FILE_TRANSFER_CMD`) **[V-code]**. This is one of the few ways a background watch process can reliably wake the phone side, provided the Zepp app itself is alive **[I]**.
- Size limits: none documented. Speed: unknown, see §3.4.

---

## 4. Side Service (phone-side JS)

### 4.1 Runtime and globals **[V-code]**

What was inspected:
- The side-service framework Zepp serves to the Simulator: `https://zepp-os.zepp.com/frameworks/v3.7.0.0/mobile-main-service.js`, a "mobile-main-service v1.1.3, api_level 3.7, build 2024-08-29" (saved as `scratchpad/runtime/mobile-main-service.js`).
- Its embedded worker `framework.worker.js` (decoded to `scratchpad/runtime/decoded_xc.js`, version "1.1.3-307").
- The Simulator loads the side service from that URL (https://github.com/orgs/zepp-health/discussions/478, maintainer comment Dec 2025) **[V-staff]**.
- That the production Zepp app embeds equivalent code is **[I]**.

How your code runs: each side service runs in a dedicated **Web Worker** and is evaluated with `new Function('{Buffer, messaging, sideService, settings, fetch, internal, system, localStorage, Logger, userSettings, HmUtils, fs, fileTransfer, transferFile, dataSource, network, image}', yourCode)(ctx)`. There is exactly one process per appId.

| Global | Documented? | What it is |
|---|---|---|
| `messaging` | yes (`peerSocket`) | `peerSocket` (watch link); **`settingsAppPeerSocket`** (direct side↔Settings channel, undocumented); `notification` |
| `fetch` | yes | See §4.3 |
| `settings.settingsStorage` | yes | See §4.5 |
| `network.downloader` | yes | See §4.4 |
| `image.convert` | yes | See §4.4. Also exposes `image.IMAGE_TYPE` (TGA and RGB565 variants) |
| `transferFile`, `fileTransfer` | yes / partly | See §3.5 |
| `Buffer`, `Logger` | Buffer mentioned ("polyfill") | Node-like Buffer; `Logger.getLogger(name)` |
| `sideService` | **no** | `launchReasons`, `launchArgs`, `appInfo` (your app.json), `version`, `apiLevel` |
| `localStorage` | **no** | Phone-side key/value store, separate from settingsStorage |
| `fs` | **no** | `read`, `readFile` (base64 default), `writeFile`, `remove`, `on('inputFile')` |
| `system` | **no** | `openDeviceAppPage({path, params, index})`, `openSettingsApp`, `closeSettingsApp`, `openAppPage`, `openAppStorePage`, `openSettingsAppForWebApp`, `getSystemInfo`, `getAppDeviceStatus`, `enable/disableAppBack` |
| `internal` | **no** | `internal.fetch()` goes to RPC `app.internal.network.zeppOpenApi` (Zepp's own API); `internal.getUserInfo()` |
| `dataSource`, `userSettings`, `HmUtils` | **no** | Internal |

- Worker globals are **not shadowed**, unlike the Settings sandbox in §5.1, and the framework itself calls `setTimeout`. So `setTimeout` and `setInterval` are available to side-service code **[V-code]**.
- Whether `WebSocket` or `XMLHttpRequest` exist depends on the host JS environment and has **not been verified** on real phones **[I]**. Test with `typeof WebSocket` before relying on it.
- The documented globals page lists only `console.log` (`docs/reference/side-service-api/global.mdx`) **[V-doc]**.
- `eval` and `new Function` are disallowed for app code, except `new Function('return this')` (`docs/guides/framework/app-settings/js-support.md`) **[V-doc]**.

**Caution.** Everything marked "no" above is undocumented. It may be restricted to first-party apps, may be rejected in app review, and may change without notice. Do not build a product on it without testing. `system.openDeviceAppPage` stands out: it sends a BLE "invoke" frame (`appType: "dapp"`) through the scheduler (`onInvokeMessage`, "ble cmd length … > message max length 3600"). In principle the phone side can therefore open a watch-app page **[V-code, untested on hardware]**.

### 4.2 Lifecycle: when does it run? **[V-code]** unless labelled

Launch triggers. The scheduler starts a worker if none exists for the appId:

| `launchReasons.*` | Trigger | Scheduler command |
|---|---|---|
| `peerAppLaunched` | The watch app (or ZML-wrapped App Service) sends a **Shake** frame: its first `request()` or `call()` | `onAppBleDataMessage` → `launchProcess({launchType:'peerAppLaunched', peerAppShakeData})` |
| `settingsAppLaunched` | The user opens your Settings App in Zepp | `message.notification.launch.settingsAppLaunched` |
| `settingsChanged` | settingsStorage changed | `message.notification.launch.settingsChanged` |
| `fileTransfer` | A file arrives from the watch | `message.notification.launch.fileTransfer` |
| `inputFile` | A file is picked with the Settings `FileInput` (§5.4) | `message.notification.launch.settingsAppInputFile` |
| `locationChanged`, `wokenUp` (`launchType "wakeInterval"`) | **No trigger exists in this build** | Enum entries only. There is no API to request periodic wake-ups |

The `launchReasons` enum copies Fitbit's companion API, but only the first five reasons are wired up **[I]**.

**Execution order:** evaluate code → `onInit()` → (on a peer launch, deliver the handshake to `peerSocket`) → `onRun()`. `onDestroy()` runs on teardown.

**Idle teardown:**
- Each process has `_idleTime = 6e5` ms (**10 minutes**).
- A scheduler "interrupt" runs every **60 s** (`6e4`) and destroys processes marked Idle.
- What counts as activity (`activate()`): any RPC from your side code (fetch, storage writes, downloads, invokes); any outbound BLE message; any scheduler→worker delivery (launch events, settings changes).
- So a side service stays alive while it keeps doing work, and dies about 10–11 minutes after it goes quiet.

**Watch app exits:** ZML's `disConnect()` sends Close. The scheduler logs "Try Destroy" and sets `port1 = 0`, but does **not** kill the worker. The worker lingers until the idle sweep, and outbound data is rewritten into Close.

**Phone OS** (iOS vs Android): the side service can only run while the **Zepp app process** is alive. Zepp does not document its behaviour here.
- The AmazHA developer (Aug 2026): "The Zepp app has to stay installed and running in the background, permanently… all the networking goes through it." https://community.home-assistant.io/t/amazha-a-native-amazfit-zepp-os-companion-app-for-home-assistant/1014421?page=3 **[C]**
- iOS generally suspends background apps; a force-quit Zepp app will not be relaunched by BLE traffic; iPhone users are told to enable "Run in background" for the device in Zepp (https://github.com/orgs/zepp-health/discussions/125, community, 2023) **[C]**.
- Android OEM battery optimisation can kill the Zepp app **[C/I]**.
- Treat any background side-service activity as **best effort**.

**Answers to the brief's lifecycle questions**

- **Does it run when the watch app is closed?** Yes, for up to about 10 minutes of inactivity after its last use. It can also be started by Settings App events or file transfers, but any push to the watch fails until the watch app handshakes again **[V-code]**.
- **Can the watch wake it?** Yes. Any ZML `request()`/`call()` from a page or App Service, or a `TransferFile` from the watch, launches it, as long as the Zepp app process is alive **[V-code]**.
- **Can it poll or use timers?**
  - `setTimeout`/`setInterval` are available, and fetch activity keeps the process alive **[V-code]**.
  - Nothing restarts it after the OS or scheduler kills it.
  - Practical rule: let the **watch drive the schedule**, for example an App Service timer calling `request`/`httpRequest` **[I]**.
- **WebSockets?** Not documented or exposed by Zepp; availability in the host is unverified **[I]**.
  - A developer reports the phone's native HTTP client "aborts a request after ~10 s of *silence* from the server" regardless of the timeout setting (https://github.com/giovaboy/ZeppOS-HTTP-Buttons) **[C]**. Long-polling is therefore also out.
- **Can a server push to the watch?** There is no push channel (no FCM/APNs hook, no wake API) **[V-code, absence]**. See the workarounds in §9.3.

### 4.3 `fetch` in the Side Service

The docs (`docs/reference/side-service-api/fetch.mdx`) **[V-doc]** describe:
- `fetch(url)` for a GET, or `fetch({url, method, headers, body})`, all options in one object.
- `res.body` may be a JSON string on some models. Normalise it: `typeof res.body === 'string' ? JSON.parse(res.body) : res.body`.

The runtime supports more (`scratchpad/runtime/decoded_xc.js`, `Zi.fetch`) **[V-code]**:
- **Defaults** `{method: 'GET', headers: {}, timeout: 60000}`. `timeout` (ms) and `query` (an object turned into a query string) are also accepted.
- **Body encoding:**
  - A **string** body defaults to `Content-Type: application/json`. Set the header yourself for text/plain or form data.
  - An **ArrayBuffer** body defaults to `application/octet-stream`.
  - An **object** body is JSON-encoded, or url-encoded if you set `Content-Type: application/x-www-form-urlencoded`.
- **Methods:** passed straight to the native client. PUT, DELETE and PATCH are used by community apps (ZeppOS-HTTP-Buttons) **[C]**.
- **Response:** `{status, headers, body, ok, json(), text(), arrayBuffer()}`.
  - `body` is parsed according to Content-Type: JSON becomes an object, anything else a string.
  - **Binary responses are supported** through `arrayBuffer()`, but they cross the bridge hex-encoded, which is inefficient. For large binaries use `network.downloader` **[V-code + I]**.
- **HTTPS:** yes.
- **Self-signed certificates:** rejected. "Zepp OS does not allow the use of self-signed certificates for making web requests" (HA companion thread, Feb 2025, https://community.home-assistant.io/t/home-assistant-companion-for-amazfit-devices/704586?page=5) **[C]**.
- **Plain HTTP to LAN IPs** (`http://192.168.x.x:8123`) is used by several Home Assistant apps **[C]**. Whether iOS allows it (ATS) is unverified **[I]**.
- **Local phone servers:** Zepp staff suggest "run a server on your phone (or some automation like Tasker…)" for phone-side actions (https://github.com/zepp-health/zeppos-forum/discussions/386, Nov 2024) **[V-staff]**. This means `fetch('http://127.0.0.1:PORT')` from the side service, which is Android-realistic **[I]**.
- **Concurrency:** see the native queue-limit report in §3.4 **[C]**.

### 4.4 Download and image conversion

**Download** (`docs/reference/side-service-api/download-file.mdx`) **[V-doc]**
- Call `network.downloader.downloadFile({url, timeout /*required*/, headers?, filePath?})`. It returns a task with `cancel()`, `onProgress({progress, total, loaded})`, `onSuccess({filePath, tempFilePath, statusCode})`, `onFail({code, message})` and `onComplete()`.
- The default location is `data://download/`.

**Image conversion** (`image-convert.mdx`) **[V-doc]**
- `image.convert({filePath, targetFilePath?})` returns a Promise of `{filePath, targetFilePath, options: {size}}`.
- It converts PNG into the watch's image format; the default output is `${filePath}_converted`.

The canonical 3.0 pipeline is download → convert → `transferFile` → watch `IMG` widget (sample `src/zeppos-samples/application/3.0/download/`) **[V-code]**.

### 4.5 settingsStorage: persistence and sync **[V-doc]**

`docs/reference/side-service-api/settings-storage.mdx`
- `settings.settingsStorage.setItem(key: string, value: string)`, `getItem(key) → string | undefined`, `removeItem`, `clear`, `toObject`, `length`.
- `addListener('change', ({key, newValue, oldValue}) => …)` is side-service only.
- Values are **strings**, so JSON-encode them. Storage is persisted by the Zepp app and shared by the Side Service and Settings App.
- A `setItem` from the side re-runs the Settings App's `build()`.

The watch **cannot read settingsStorage**. The usual patterns:
- The side listens for `change` and `call()`s the watch; this works only while the watch app is connected.
- Or the watch pulls on start with `request('getConfig')` and caches the result in `@zos/storage` localStorage.

A settings change can launch the side service (`settingsChanged`, with `launchArgs = {changeType, key, oldValue, newValue}`) **[V-code]**. The JS side imposes no size limit; any native limit is unknown **[V-code, absence]**.

### 4.6 Other undocumented facts worth knowing **[V-code]**

- `messaging.settingsAppPeerSocket.send(buf)` sends data to the Settings App over `COMMON_SYSTEM_DATA_TRANSFER`. settingsStorage remains the documented route.
- `localStorage` is a phone-side key/value store loaded per process (`Qo.load(...)`).
- **Phone file picker:** `fs.on('inputFile', ({filePath, params}) => …)` fires when a file is picked in the Settings App (§5.4). Combine it with `transferFile` to push the file to the watch.

---

## 5. Settings App (phone-side configuration UI)

### 5.1 Model and sandbox

- Register with `AppSettingsPage({ state, build(props) { return RenderFunc } })`. There is a single `build` lifecycle, re-run whenever settingsStorage changes. Components are functions `(props, children?) => RenderFunc`, and `style` accepts camelCase CSS (`docs/guides/framework/app-settings/register.md`, `ui-intro.md`) **[V-doc]**.
- **Implementation** (`scratchpad/runtime/app-settings.prod.js`, bundle `app-settings.global.1767162754628.prod.js`, built 2025-12-31) **[V-code]**:
  - A hosted web page (`https://zepp-os.zepp.com/app-settings/v1.0.1/index.html`) runs in a WebView and renders your components with **React plus Material-UI-style components**.
  - Your code is loaded through `window.__webview_comms__.getSettingsCode()` and evaluated with `new Function`, after **every window global is shadowed except an allow-list:**
    `Infinity NaN undefined isFinite isNaN parseFloat parseInt encodeURIComponent decodeURIComponent Object Array Boolean Symbol String Number Date RegExp Error RangeError ReferenceError TypeError URIError Promise Map Set fetch Headers Request Response console JSON Math setTimeout clearTimeout setInterval clearInterval Navigator navigator`.
- **Consequences:**
  - No `document`/DOM, no custom HTML or JS UI beyond the component set, and no `localStorage`, `WebSocket` or `XMLHttpRequest` **[V-code]**.
  - The Settings App *does* have the browser's `fetch` and timers **[V-code]**. Because the page origin is `https://zepp-os.zepp.com`, those requests are subject to CORS **[I]**. Prefer doing network work in the Side Service.
  - The Settings App only exists while the user has it open **[I]**.

### 5.2 UI components

Documented components (`docs/reference/app-settings-api/ui/*.mdx`) **[V-doc]**, plus one found in the bundle **[V-code]**:

- **Auth**: OAuth sign-in button and flow. See §5.3.
- **Button**: `label`, `color` (`default|primary|secondary`), `style`, `onClick`.
- **Image**: `src` (URL or base64, required), `alt`, `width`, `height`, `style`.
- **Link**: `source` URL, with child render functions. Rendered as `<a href target="_blank">` **[V-code]**.
- **Section**: grouping container with `title`, `description` and `style`, plus children.
- **Select**: `label`, `title`, `options: [{name, value}]`, `multiple`, `value`, `onChange`. The bundle also accepts `settingsKey` for auto-binding **[V-code]**.
- **Slider**: `label`, `min`, `max`, `step`, `value`, `onChange`, `settingsKey` (auto-binds to settingsStorage).
- **Text**: text block with `align`, `bold`, `italic`, `paragraph` and `style`, plus children.
- **TextImageRow**: list row with `label`, `sublabel`, `icon`, `iconColor`, `rounded`, `iconRight`.
- **TextInput**: `label`, `placeholder`, `value`, `onChange`, `disabled`, `multiline`, `rows`, `bold`, `settingsKey`, `labelStyle`, `subStyle`.
- **Toast**: `message`, `visible`, `duration` (default 2000 ms), `horizontal`, `vertical`, `onClose`. It is an MUI Snackbar **[V-code]**.
- **Toggle**: `label`, `value`, `onChange`, `settingsKey`.
- **View**: a plain `div` container with `style`, `onClick` and children.
- **FileInput** (**undocumented**) **[V-code]**: `btnText` (default "Select File"), `accept`, `onChange`, `onSuccess(filePath)`, `onError`, `params`, `children`. See §5.4.

### 5.3 Auth (OAuth 2.0 authorization-code flow)

Documented props (`ui/auth.mdx`) **[V-doc]**: `title`, `label`, `description`, `authorizeUrl`, `requestTokenUrl`, `clientId`, `clientSecret`, `scope`, `pkce`, `onAccessToken(tokenJson)`, `onReturn(params)`.

Extra props in the live bundle **[V-code]**: `settingsKey` (stores the token JSON in settingsStorage automatically), `oAuthParams` (extra query parameters for the authorize URL), `state`, `requestTokenHeader` (`"basic"` sends HTTP Basic client auth) and `status`.

**Verified flow** (`app-settings.prod.js`, `redirect.prod.js`) **[V-code]**:
1. The tap opens `authorizeUrl?response_type=code&client_id…&redirect_uri=…&state=…&scope=…` plus `oAuthParams`.
   - `redirect_uri` = **`https://zepp-os.zepp.com/app-settings/redirect.html`** in production. For a local or LAN dev host it is `${host}/redirect.html`.
   - `state` defaults to JSON `{callbackUrl: "zepp://auth-return", nonce}`.
   - With `pkce: true` the flow adds `code_challenge_method=plain` and a random `code_challenge`. Note: **plain**, not S256.
2. The Zepp app shows it in an in-app auth WebView (`__webview_comms__.openAuthWebview`).
3. The provider redirects to Zepp's `redirect.html`. That page reads query or fragment parameters and jumps to `zepp://auth-return?...`, which the Zepp app catches and returns to the settings page.
4. If you supplied `onReturn`, you get the raw parameters (e.g. `{code, state}`) and handle the exchange yourself. Otherwise the component checks the nonce and POSTs `client_id`, `client_secret?`, `code`, `grant_type=authorization_code`, `redirect_uri` and `code_verifier?` to `requestTokenUrl` using the WebView's `fetch`. It then calls `onAccessToken(json)`, which is stored under `settingsKey` if one is set.
   - Because the exchange runs in the browser, the token endpoint needs CORS **[I]**.
   - Alternative: use `onReturn`, put the code into settingsStorage, and exchange it in the Side Service with `fetch`, where CORS does not apply **[I]**.
5. Because of the redirect fragment handling, implicit-style returns (`#access_token=…`) also reach `onReturn` **[V-code]**.

**Practical notes**
- Register `https://zepp-os.zepp.com/app-settings/redirect.html` as the redirect URI with your OAuth provider **[V-code]**. Some providers may reject a redirect host you don't own **[I]**.
- `clientSecret` ships inside your app package, so treat it as public and prefer PKCE or public clients **[I]**.
- Refresh tokens: store them and refresh in the Side Service with `fetch` **[I]**.
- Real apps using OAuth: ZeppOS-Tasks (Google Tasks, https://github.com/melianmiko/ZeppOS-Tasks) and ZeppOS-Spotify (awesome-zeppos list, `src/awesome-zeppos/README.md`) **[C]**.

### 5.4 FileInput (undocumented): user files from the phone to the watch **[V-code]**

- The user picks a file in the Settings App. Files **over 20,971,520 bytes (20 MB) are rejected** ("File size exceeds 20MB").
- The file is read as base64, written to `data://temp/temp_<ts>_<rand>` with `__webview_comms__.writeFile`, and then an `inputFile` event is posted.
- The Side Service is launched if needed (`launchReasons.inputFile`) and receives `fs.on('inputFile', {filePath, params})`.
- From there, `transferFile.getOutbox().enqueueFile(filePath)` sends it to the watch.
- Useful for GPX routes, config files and firmware blobs for your hardware **[I]**.

### 5.5 Limits summary

- Only the component set above. No custom HTML or DOM, no persistent background.
- The app runs only while it is open.
- It cannot talk to the watch directly; it must go through the Side Service **[V-doc/V-code]**.

---

## 6. Internet from the watch itself

- **Hardware:** the T-Rex 3 has **Wi-Fi 2.4 GHz** (official spec, https://us.amazfit.com/products/amazfit-t-rex-3) **[V vendor]**.
  - It is used by the system: map downloads over Wi-Fi (DC Rainmaker: "WiFi is required for map downloads", https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html) **[C]**.
  - "OTA Update via Wi-Fi" (vendor spec) **[V vendor]**.
  - Music transfer, where the phone joins a temporary watch Wi-Fi hotspot (Amazfit T-Rex 3 music FAQ, per search result: https://in.amazfit.com/pages/faq/how-can-i-transfer-music-to-my-amazfit-t-rex-3) **[C]**.
- **Software:** there is **no device-side network API** in the official docs (`docs/reference/device-app-api/newAPI/` has no network, http, socket or wifi module) **[V-doc]**, nor in the `@zeppos/device-types` 4.0.0 typings **[V-code]**. ZML's device-side `httpRequest` is only an RPC to the Side Service (`src/zml/src/core/device/messaging/httpRequest.js`) **[V-code]**.
- The 3.5 docs promise a "Network Function" for Workout Extensions ("Smartwatches will be able to use network connections to synchronize data in real time to the cloud") (`docs/guides/version-info/new-features-35.md`) **[V-doc]**. In practice that means ZML → Side Service, and it is currently broken inside extensions (§7.6) **[C]**.
- **Conclusion:** every internet feature needs the paired phone nearby with the Zepp app alive. The only phone-free link is **BLE Central to your own hardware** (§7).

---

## 7. BLE Central (the watch as GATT client)

### 7.1 Availability

- The `mst*` APIs start at **API_LEVEL 3.0**, and the scan `Timeout` option at 3.5, so they are **available on the T-Rex 3** at both 4.0 and 4.4 (`docs/guides/framework/device/ble-central.md`, `new-features-30.md`, `new-features-35.md`) **[V-doc]**.
- Typical targets (per the docs): heart-rate bands, pedometers, sports cameras. The GoPro BLE spec is cited as an example **[V-doc]**.
- Real users:
  - The official GoPro mini-app and extension run on the T-Rex 3 (Zepp App Store listing, per search results) **[C]**.
  - The easy-ble ESP32 demo (`src/easy-ble/examples/ble-master-esp32/`) **[V-code]**.
  - gymsync: a watch uploading to a Linux/Mac GATT daemon, no phone and no Zepp app (https://github.com/kiedanski/gymsync) **[C]**.
- **Foreground only:**
  - The App Service table says `@zos/ble` is usable in the background "Except for APIs whose names begin with `mst`" (`docs/guides/framework/device/app-service.md`) **[V-doc]**.
  - Keep the page awake during sessions with `setPageBrightTime({brightTime})` and `pauseDropWristScreenOff({duration})` from `@zos/display`, as the easy-ble example does **[V-code]**.
- **Permission:** the official BLE samples declare `"device:os.ble"` in `app.json`. It is not documented as required, but add it anyway **[V-code]**.

### 7.2 API surface (`@zos/ble`)

All of these start at API 3.0 **[V-doc]**.

| Group | Functions |
|---|---|
| Scan | `mstStartScan(cb(result), filter?)`. `result = {dev_name, dev_addr: ArrayBuffer(6), rssi, service_uuid_array, service_data_array[{uuid, service_data}]}`. Also seen in practice: `vendor_id`, `vendor_data`, `uuid` **[V-code easy-ble]**. `filter = {device_name, fuzzy_mode, service_uuid, service_data_uuid, manufacturer_id}`; `timeout = {duration (s), on_timeout}` (3.5+). `mstStopScan()` |
| Connect | `mstConnect(macArrayBuffer, cb({connected: 0 ok \| 1 failed \| 2 disconnected, connect_id, dev_addr}))`, `mstDisconnect(connectId)`, `mstPair(connectId)`, `mstGetConnIdByRemoteAddr(mac)` |
| Profile | `mstOnPrepare(cb(profile, status))` (**mandatory**; register it before building), `mstBuildProfile(profileObj)`, `mstPrepare(profile)` (documented as "prepare interface"; the official sample never calls it), `mstGetProfileInstance(name, connectId)`, `mstDestroyProfileInstance(profile)` |
| GATT ops | `mstReadCharacteristic(profile, uuid)`, `mstWriteCharacteristic(profile, uuid, ab, len)`, `mstReadDescriptor(profile, uuid, descUuid)`, `mstWriteDescriptor(profile, uuid, descUuid, ab, len)` |
| Events | `mstOnCharaReadComplete`, `mstOnCharaValueArrived(profile, uuid, data, status)`, `mstOnCharaWriteComplete(profile, uuid, status)`, `mstOnDescValueArrived`, `mstOnDescWriteComplete`, `mstOnCharaNotification(profile, uuid, data, length)`, `mstOnServiceChangeBegin/End` |
| Cleanup | `mstOffAllCb()` → `mstDestroyProfileInstance(profile)` → `mstDisconnect(connectId)`. The official flow says you "MUST unregister all callbacks" (`static/img/docs/guides/version_info/BLE.svg`) |
| Undocumented | `mstWriteCharacteristicWithoutResponse(profile, uuid, ab, len)` and `mstOnDescReadComplete`. Both are used by easy-ble 1.4.0+ **[V-code easy-ble]** and absent from the docs and typings. Feature-detect with `typeof`. |

**Profile object gotchas.** The docs are incomplete. The official sample (`src/zeppos-samples/application/3.0/3.0-feature/libs/ble.js`) **[V-code]** uses extra fields: `{uuid: true, size: 1}` at the services level, and `serv`, **`len2`** at the service level, plus `desc` per characteristic. easy-ble notes: "Tertiary (3rd level) REQUIRES `len2: chara_len` despite docs stating otherwise" **[C]**. Copy the sample's shape, or use easy-ble's `generateProfileObject()`.

### 7.3 Limits and known issues

| Topic | Finding | Label |
|---|---|---|
| Concurrent peripherals | "concurrent connections are currently impossible" (easy-ble changelog by Silver / Zepp Health); design for **one at a time** | **[C]**, Zepp-affiliated |
| MTU | "Due to a relatively small MTU it shouldn't be possible to handle charas bigger than MTU packet" (easy-ble). gymsync defaults to 16-byte payloads ("safe at un-negotiated MTU 23") and notes 96+ works "if the Zepp stack negotiates a higher MTU". There is no MTU API. **Plan for ≤ 20-byte writes and notifications** unless you measure otherwise | **[C]** |
| Notifications | Supported: write `0x0100` to CCCD `2902`, then `mstOnCharaNotification` | **[V-code]** sample |
| Indications | "INDICATE currently not supported (!)" (easy-ble ESP32 firmware comment) | **[C]** |
| Write without response | Not in the docs. easy-ble calls the undocumented `mstWriteCharacteristicWithoutResponse` | **[C/V-code]** |
| Pairing / bonding / encryption | `mstPair` "might not work as expected and could potentially cause crashes"; "encrypted comms are currently impossible" (easy-ble TODO) | **[C]** |
| Scan / connect bugs | Scans can latch ("Spamming SCAN_RSP & SCAN_REQ"); failed connects may report a bogus MAC `70:53:36:8e:0b:c0`; `mstOnPrepare` sometimes never fires; after many connections the watch may refuse new ones (workaround: scan before connecting, or connect to another device first) | **[C]** (`src/easy-ble/easy-ble-npm/dist/ble-master.src.js`) |
| Error codes | The `mstOnPrepare` status maps to `0 Success, -1 Fail, -2 Uninitialized, -3 Timeout, -4 Busy, -5 Invalid State, -6 Invalid Operation, -7 Invalid Parameter, -8 Authentication, -9 System, -10 Missing Attribute` (easy-ble `BX_CORE_CODES`) | **[C]** |
| Coexistence with the phone link | No documented conflict. The dual role (peripheral to the phone plus central to a PC) "is reported to work" (gymsync); the official GoPro app is used while paired | **[C/I]** |
| Background | Not in App Services (§7.1). Workout Extensions: unknown for `mst*`; the GoPro extension suggests it is allowed **[I]** | **[V-doc]/[I]** |
| System sensors | The Workout app natively pairs standard BLE HR, cycling speed/cadence, cycling power, Stryd, FTMS rowers and more (no ANT+). If you only need standard sensor data during workouts, use the built-in support (https://os.zepp.com/accessories) | **[V vendor]** |

### 7.4 Code sketches

**A. Raw API.** Condensed from the official sample; the flow is scan → connect → prepare → notify/write → cleanup.

```js
import * as ble from '@zos/ble'
import { setPageBrightTime } from '@zos/display'

const SVC = '4fafc201-1fb5-459e-8fcc-c5c9c331914b'
const RX  = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'   // write
const TX  = '5a87b4ef-3bfa-76a8-e642-92933c31434f'   // notify
let connId = -1, profilePtr = null

function profileFor(id, macAb) {
  return {
    pair: false, id, profile: 'myesp32', dev: macAb, len: 1,
    list: [{ uuid: true, size: 1, len: 1,
      list: [{ uuid: SVC, permission: 0, serv: 0, len1: 2, len2: 2,   // len2 required in practice
        list: [
          { uuid: RX, permission: 32, desc: 0, len: 0 },
          { uuid: TX, permission: 32, desc: 1, len: 1, list: [{ uuid: '2902', permission: 32 }] },
        ] }] }],
  }
}

Page({
  onInit() { setPageBrightTime({ brightTime: 600000 }) },
  build() {
    ble.mstStartScan((r) => {
      if (r.dev_name !== 'ESP32_BLE_PERIPHERAL') return
      ble.mstStopScan()
      ble.mstConnect(r.dev_addr, (c) => {
        if (c.connected !== 0) return            // 1 = failed, 2 = disconnected -> retry with backoff
        connId = c.connect_id
        ble.mstOnPrepare(({ profile, status }) => {   // mandatory; register before build
          if (status !== 0) return
          profilePtr = profile
          ble.mstWriteDescriptor(profile, TX, '2902', new Uint8Array([1, 0]).buffer, 2) // enable notify
          const cmd = new Uint8Array([0x01, 0x42]).buffer                               // keep <= 20 B
          ble.mstWriteCharacteristic(profile, RX, cmd, cmd.byteLength)
        })
        ble.mstOnCharaNotification(({ uuid, data, length }) => { /* parse ArrayBuffer */ })
        ble.mstOnCharaWriteComplete(({ uuid, status }) => { /* 0 = ok */ })
        ble.mstBuildProfile(profileFor(connId, r.dev_addr))
      })
    }, { device_name: 'ESP32_BLE_PERIPHERAL' })
  },
  onDestroy() {
    ble.mstOffAllCb()
    if (profilePtr) ble.mstDestroyProfileInstance(profilePtr)
    if (connId >= 0) ble.mstDisconnect(connId)
  },
})
```

The object-style callback parameters follow the official sample (`preParam.status`, `cnParam.data`). The docs present them positionally, so log what you actually receive.

**B. easy-ble**, the recommended wrapper: `npm i @silver-zepp/easy-ble`, v1.7.8-e, Nov 2024 **[V-code]**.

```js
import { BLEMaster, ab2str } from '@silver-zepp/easy-ble'
const ble = new BLEMaster()
const services = { [SVC]: { [RX]: [], [TX]: ['2902'] } }

ble.startScan((dev) => {
  if (!ble.get.hasDeviceName('ESP32_BLE_PERIPHERAL')) return
  ble.stopScan()
  ble.connect(dev.dev_addr, (res) => {
    if (!res.connected) return  // statuses: connected | invalid mac | in progress | failed | disconnected
    ble.startListener(ble.generateProfileObject(services), (r) => {
      if (!r.success) return
      ble.on.charaNotification((uuid, data, len) => console.log(uuid, ab2str(data)))
      ble.write.enableCharaNotifications(TX, true)
      ble.write.characteristic(RX, 'cmd_color:FF0000')       // queued, with response
      ble.write.characteristic(RX, new Uint8Array([1]).buffer, true) // undocumented write-without-response
    })
  })
}, { duration: 10000 })
// onDestroy: ble.quit()
```

easy-ble queues read and write operations with a 5 s per-operation timeout, auto-generates the profile, and handles CCCD writes. Matching ESP32 Arduino firmware is in `src/easy-ble/examples/ble-master-esp32/esp32-ble-peripheral/src/main.cpp`: a service with WRITE and WRITE_NR, NOTIFY and READ characteristics **[V-code]**.

### 7.5 Watch as peripheral, and talking to non-Zepp phone apps

- **The watch cannot be a peripheral or advertiser for mini apps.**
  - "The system has ability to do so, but we currently don't have plan to provide it for mini app" (Zepp OS team, May 2023, https://github.com/orgs/zepp-health/discussions/159) **[V-staff]**.
  - "We currently don't support BLE Slave, so you will not be able to craft your own advertisement packets" (silver-zepp, Feb 2024, https://github.com/orgs/zepp-health/discussions/307) **[V-staff]**.
- **A third-party phone app cannot use the Zepp link** (https://github.com/orgs/zepp-health/discussions/366) **[V-staff]**. The Zepp app owns the phone↔watch connection, and Gadgetbridge cannot run side services (below). Two routes remain:
  1. **The watch as central to a GATT server in your phone app.** Android (`BluetoothGattServer` + `BluetoothLeAdvertiser`) or iOS (`CBPeripheralManager`, background-advertising limits apply). This is the gymsync pattern with a phone instead of a PC. It is untested with a phone that is also the Zepp-paired host **[I]**.
  2. **Side Service `fetch` to an HTTP server running in your phone app** (`http://127.0.0.1:PORT`). Staff suggested it for Android automation (discussion #386) **[V-staff]**. A T-Rex 3 project attempts it but is unvalidated (https://github.com/kassiohenrique977-blip/flashcards-trex3) **[C]**. This is realistic on Android and not on iOS, where background servers get suspended **[I]**.

### 7.6 Workout Extensions and connectivity

- The docs pitch Bluetooth and network for extensions (`new-features-35.md`), and there is an official sample `src/zeppos-samples/workout-extensions/3.5/running-pace-master-with-side-service/`. It uses `DataWidget(BasePage({ onInit(){ this.request(...) } }))` together with an `app-side` module **[V-code]**.
- **Reported broken on current firmware.** zeppos-forum Discussion #554 (Aug 28, 2026, T-Rex 3 Pro fw 6.3.13.5) reports **[C]**:
  - `this.request()`, `sendAppMessage()` and `messaging.peerSocket` return "NOT A FUNCTION";
  - "ZML BasePage unavailable in workout-extension context";
  - registering a Side Service alongside a DataWidget "fails during build";
  - the official sample does not work;
  - no staff reply yet.
  - Source: https://github.com/zepp-health/zeppos-forum/discussions/554.
- The T-Rex 3 (non-Pro) is very likely affected the same way, since it runs the same OS 6 generation **[I]**.
- **Workaround [I]:** record in the extension, persist to the app's storage, and sync from the main app page or App Service later.

---

## 8. Background execution, as far as connectivity cares

Other reports cover this in depth.

- **App Service types** (`docs/guides/framework/device/app-service.md`) **[V-doc]**:
  - *Single execution*: triggered by `@zos/alarm`, a notification or a system event. It has a **600 ms** limit, far too short for a phone round trip.
  - *Continuous*: started with `@zos/app-service.start({file, param, complete_func, reload})`; `reload` is 4.0+. It needs `device:os.bg_service` plus user consent via `requestPermission`, and **only one** continuous service runs system-wide.
- **Allowed in App Services:** `@zos/ble` except `mst*`, notifications, non-high-power sensors, and `@zos/fs` writes only when the screen is off or in AOD **[V-doc]**. Global `setTimeout` is **not** available **[V-doc]**. Use `@zos/timer.createSysTimer(periodic, periodMs, cb)` (API 4.0; it "runs regardless of watch screen state") (`static/llms/@zos-timer.md`) **[V-doc]**.
- ZML's API 3.0 build uses an undocumented `@zos/timer.setTimeout` internally (`scratchpad/npm/zml43/package/dist/3.0/...`) **[V-code]**. Background ZML `httpRequest` from timer callbacks has intermittent failures that a watch reboot fixes (https://github.com/zepp-health/zml/issues/10, Amazfit Active, Zepp OS 4) **[C]**.
- **Alarm-driven pages:** an alternative used by ha-zepp. An `@zos/alarm` wakes a *page* (no 600 ms limit), the page POSTs through the Side Service and exits. Open notifications on the watch can block it (https://github.com/ga2mer/ha-zepp) **[C]**.

**Sketch: periodic upload from the watch.** It uses the staff pattern plus API-4.0 timers **[I]** (untested composition).

```js
// app.json: "permissions": ["device:os.bg_service", "data:user.hd.heart_rate"],
//           module: { "app-service": { "services": ["app-service/sync"] }, "app-side": {"path": "app-side/index"} }
import { BasePage } from '@zeppos/zml/base-page'
import { createSysTimer, stopTimer } from '@zos/timer'
import { HeartRate } from '@zos/sensor'
let tid = 0
AppService(BasePage({
  onInit() {
    const hr = new HeartRate()
    tid = createSysTimer(true, 5 * 60 * 1000, () => {
      this.httpRequest({ method: 'POST', url: 'https://example.com/ingest', timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
        body: { id: 'watch-1', hr: hr.getLast(), t: Date.now() } })
        .catch(() => { /* append to an outbox file and retry next tick */ })
    })
  },
  onDestroy() { if (tid) stopTimer(tid) },
}))
// Started from a page: import { start } from '@zos/app-service'; start({ file: 'app-service/sync', complete_func: () => {} })
```

---

## 9. Cloud and server-side access

### 9.1 Zepp/Huami cloud API

- **The Huami Open Platform REST API** is in the repo `src/rest-api/` (HTML docs, last updated 2017–2020) **[V-doc]**.
  - Hosts: `api-open.huami.com`, OAuth on `user.huami.com` / `auth.huami.com`.
  - Endpoints: `/users/-/profile`, `activities`, `sleep`, `heartrates`, `motionInMinute`, `body`, `devices`, `sports`, `sportDetail`, `social`, PAI (`openData/PaiSummary`, `PaiVo2max`), `sensorData`, `events/PaiHealthInfo`, `ecg`.
  - **`POST /notifications`**: server-side push of a notification to the user's device, with title ≤ 7 characters, vibration mode and a cron schedule.
  - OAuth scopes and token lifetimes, per the wiki (https://github.com/zepp-health/rest-api/wiki) **[C/V]**:
    - scopes: `profile, activity, sleep, heartrate, motion, notifyme, sport, sportDetail`;
    - access token 90 days, refresh token 10 years.
  - **Partner-only:** "Corporate users only (not individuals, unless PhD research)". Apply at `https://dev.huami.com` (still online, HTTP 200 on 2026-09-28); review takes 3–7 days; contact datapartner@huami.com.
  - The API hosts still respond (404 at the root) **[V: curl]**.
  - Official discussions state there is no developer-queryable history (https://github.com/orgs/zepp-health/discussions/366: "Zepp does not send historical data to any Zepp servers which developer can then query", community, June 2025) **[C]**.
- **Commercial aggregators:** Terra "manages Zepp API credentials" and "polls Zepp every 5–10 minutes" (https://tryterra.co/integrations/zepp) **[C]**. A partner channel therefore exists; it is not self-serve.
- **Unofficial:**
  - https://github.com/m4ary/zepp-health-cli: `api-mifit-*.zepp.com`, needs an `app_token` captured from the Zepp app with an HTTPS proxy, tokens last about 30 days, with a ToS warning.
  - https://github.com/BenWyxell/ha-zepp-cloud: the same private API.
  - Fragile, and a risk to the account **[C]**.
- **Side-service `internal.fetch`** → `app.internal.network.zeppOpenApi`. It exists in the runtime, is undocumented, and is presumably first-party-only **[V-code]/[I]**.

### 9.2 Health-data export routes

- **Zepp app to third parties:** Strava, Apple Health, Google Fit, Relive and Komoot (DC Rainmaker; Amazfit support) **[C]**.
  - **Health Connect** is **write-only** from Zepp; steps, sleep, heart rate and workouts in most setups (https://wellnessproject.ai/guides/zepp-sync; Notebookcheck via search) **[C]**.
  - "Zepp-specific scores… do not cross over" **[C]**.
  - Exports to Strava lack cycling power (DC Rainmaker) **[C]**.
- **Using those:** read Health Connect on Android or HealthKit on iOS from *your own* phone app and forward to your server (the ROOK approach, https://docs.tryrook.io/data-sources/zepp/) **[C]**. Use the Strava API for workouts.
- **Your own mini app** can read on-watch sensor APIs (mostly the current day, per staff in https://github.com/orgs/zepp-health/discussions/276) and POST through the Side Service. This is the official sample `post-health-data` (Koa + MongoDB server), `src/zeppos-samples/application/2.0/post-health-data/` **[V-code]**.

### 9.3 Server → watch push (workarounds)

- **Side-service polling while the watch app is open**, delivered with `call()`. It needs the watch handshake **[V-code]**.
- **Phone push notifications** (ntfy, Pushover, Telegram and similar) are mirrored to the watch by the Zepp app as ordinary notifications. This works without a custom app but carries text only; one user did the reverse with Pushover (discussion #386) **[C/I]**.
- **The legacy Huami `POST /notifications`** endpoint is partner-only and its current status is unknown **[V-doc/I]**.

---

## 10. Community signals (reliability, real apps)

- **Home Assistant apps work in practice** through the Side Service over REST (AmazHA: T-Rex 3 listed, dual LAN/remote URLs with failover). They also report background-delivery gaps: "sensor updates randomly stop until the watch app is poked" (Jul 2026). Sources: https://community.home-assistant.io/t/amazha-a-native-amazfit-zepp-os-companion-app-for-home-assistant/1014421, https://github.com/Shakila-K/zepp-home-assistant **[C]**.
- **The Simulator's side service** depends on downloading framework JS from `zepp-os.zepp.com`. It is blocked in some regions and needs a strict startup order: open the Simulator → device simulation → `zeus dev` → start the side service on the phone (https://github.com/orgs/zepp-health/discussions/478) **[V-staff/C]**.
- **Emulator vs device** differences in Settings/Side-Service storage have been reported on a Bip Max at API 4.0 with ZML 0.0.43 (https://github.com/zepp-health/zeppos-forum/issues/571, Sep 2026) **[C]**.
- **Gadgetbridge** cannot run side-service JS. A branch exists but is unmerged as of Mar 2026, and "GadgetBridge won't ever have INTERNET permission" (https://codeberg.org/Freeyourgadget/Gadgetbridge/issues/3266). With Gadgetbridge you lose all Side Service, Settings and fetch features; BLE Central still works **[C]**.

---

## 11. Capability table (T-Rex 3)

| Capability | Min API_LEVEL (watch) | T-Rex 3 (API 4.0 old fw / 4.4 current) | Notes |
|---|---|---|---|
| BLE messaging to the Side Service (`@zos/ble`, ZML) | 2.0 (ZML needs 3.0 for all features, 3.6 for the latest) | ✅ / ✅ | Needs the Zepp app alive |
| TransferFile (watch↔phone) | 3.0 | ✅ / ✅ | |
| Side Service fetch / download / image convert | phone-side | ✅ | Capabilities follow the Zepp app version (framework api_level 3.7 seen) |
| Settings App + Auth | phone-side | ✅ | |
| BLE Central `mst*` | 3.0 (scan timeout 3.5) | ✅ foreground only | Not in App Service |
| App Service continuous + `createSysTimer` | 3.0 / 4.0 | ✅ / ✅ | One service system-wide; needs user permission |
| `@zos/alarm` wake | 3.0 | ✅ | |
| `getDeviceInfo().uuid` | 4.2 | ❌ / ✅ (**needs Zepp OS 6 firmware**) | Device identity for servers |
| Messaging inside Workout Extensions | 3.5 sample | ⚠️ reported broken on OS 6 fw (#554) | |
| Direct network or Wi-Fi from the watch | none | ❌ | |
| BLE peripheral / advertising | none | ❌ | Staff: not planned |

---

## 12. What is possible, and what is not

### Possible

| # | Use case | How | Caveats |
|---|---|---|---|
| 1 | Show live internet data on the watch (weather, stocks, HA states) | Watch `request()` → side `fetch()` → reply | Phone nearby, Zepp app alive; poll only while the app is open **[V/I]** |
| 2 | Send watch data to your server | Foreground page or continuous App Service (`createSysTimer`, API 4.0) → ZML `httpRequest` | Background is best effort; queue and retry; idempotent IDs **[V-doc/C/I]** |
| 3 | Control LAN hardware or services (ESP32 HTTP API, Home Assistant) | Side `fetch('http://192.168.x.x/...')` | Plain HTTP works per community; **self-signed HTTPS fails**; iOS ATS unverified **[C/I]** |
| 4 | Control custom BLE hardware (ESP32/nRF) from the watch | BLE Central (`mst*` / easy-ble), foreground page | One device, small MTU, notifications but no indications, flaky pairing **[V-doc/C]** |
| 5 | Phone-free sync to a PC or Raspberry Pi | Watch as central → GATT server daemon (gymsync) | Watch app open during the sync **[C]** |
| 6 | Read standard BLE sensors | Built-in Workout sensor pairing (HR, cadence, power, Stryd…), or your own GATT client | No ANT+ **[V vendor/C]** |
| 7 | Phone/server → watch updates while the app is open | Side polling + `call()` | Needs the watch handshake first **[V-code/C]** |
| 8 | Large files both ways (images, audio, routes, logs) | TransferFile; download + image.convert | Speed unmeasured (a polyfill managed ~8 KB/s) **[V-doc/C]** |
| 9 | OAuth login to third-party APIs (Google, Spotify, Strava…) | Settings `Auth` → token in settingsStorage → side `fetch` | Redirect URI `https://zepp-os.zepp.com/app-settings/redirect.html`; PKCE is `plain`; token exchange may need CORS **[V-code/I]** |
| 10 | User picks a file on the phone and sends it to the watch | Undocumented `FileInput` (≤ 20 MB) → `inputFile` → transferFile | Undocumented; may change **[V-code]** |
| 11 | Offline operation on the watch | Device app, local storage and fs work without a phone; sync later | Design an outbox **[V-doc/I]** |
| 12 | Phone automation from the watch | Side `fetch` → local HTTP server or Tasker on an Android phone | Android only, realistically **[V-staff/I]** |
| 13 | Health data off-device | Your app (watch sensors → server), or Zepp → Health Connect / Apple Health / Strava → your phone app or server | Zepp → Health Connect is write-only; partial data **[C]** |

### NOT possible, or not supported

| # | Use case | Why |
|---|---|---|
| 1 | Watch uses Wi-Fi or LTE directly for HTTP, sockets or MQTT | No device network API, even though the hardware has Wi-Fi **[V-doc]** |
| 2 | Any internet feature without the Zepp phone app | The Side Service lives inside Zepp. Gadgetbridge cannot run side services and has no internet **[V/C]** |
| 3 | Watch as BLE peripheral, beacon or custom advertiser | Officially not supported **[V-staff]** |
| 4 | Your own phone app talking over the Zepp watch link | No SDK; the link belongs to Zepp. Use the §7.5 workarounds **[V-staff/I]** |
| 5 | BLE Central from a background App Service | `mst*` excluded **[V-doc]** |
| 6 | Several BLE peripherals at once; indications; reliable bonding or encrypted GATT | **[C]** |
| 7 | True server push that wakes the watch app | No push or wake API; the side service dies after about 10 minutes idle **[V-code]** |
| 8 | WebSockets / long-polling / SSE as a supported feature | Not documented; ~10 s silence abort reported **[C/I]** |
| 9 | Self-signed-certificate HTTPS endpoints | **[C]** |
| 10 | Side Service as an always-on phone daemon | Idle teardown; phone OS may kill Zepp **[V-code/C]** |
| 11 | Watch ↔ Settings App direct channel | Must go through the Side Service **[V-doc]** |
| 12 | Self-serve official API for a user's Zepp cloud health data | Partner-only **[V-doc]** |
| 13 | Messaging or Side Service inside Workout Extensions (current fw) | Reported broken (#554) **[C]** |
| 14 | Custom HTML, DOM or arbitrary JS UI in the Settings App | Component whitelist; globals shadowed **[V-code]** |
| 15 | High-rate raw sensor streaming to the phone or cloud | BLE + JS bridge overhead **[I]** |

---

## 13. Recommended patterns for a hardware project

1. **Watch ↔ your device, direct over BLE.**
   - Make the watch the central and your board a GATT server.
   - Use a command characteristic (write with response, or feature-detected write-without-response) and a telemetry characteristic (notify).
   - Keep frames ≤ 20 bytes, with a message ID, index and total header (see gymsync's protocol).
   - Keep the page awake and add reconnect with backoff.
   - Remember it is foreground-only.
2. **Watch → phone → cloud.**
   - ZML `request`/`httpRequest` with short `timeout`s (10–15 s), idempotent message IDs, and an outbox in `@zos/fs`.
   - Send in batches. Treat background delivery as best effort.
3. **Cloud or LAN device → watch.**
   - The Side Service polls (setTimeout) while the watch app is open and pushes with `call()`.
   - For alerts while the app is closed, send a phone push notification (ntfy/Pushover) that Zepp mirrors to the watch.
4. **Configuration and auth.** Use Settings App components plus `Auth`. Keep secrets in settingsStorage, and let the Side Service call your API.
5. **Phone-free lab setups.** A PC or Raspberry Pi GATT daemon (gymsync style) as the "gateway" instead of the phone.

---

## 14. Test on the real watch and phone first

1. The API_LEVEL shown in Zepp App developer mode (expect 4.4).
2. ZML round-trip latency for a 100-byte JSON request and for a 30 KB payload. Measure how long a phone BLE dropout takes to surface.
3. Side-service survival with Zepp backgrounded, the screen locked, after 15+ idle minutes, and on your phone OS (iOS vs Android).
4. `typeof setTimeout`, `setInterval`, `WebSocket` and `XMLHttpRequest` inside the side service. Plain `http://` to a LAN IP from your phone.
5. BLE Central against your peripheral:
   - the largest notification length received (MTU);
   - `typeof ble.mstWriteCharacteristicWithoutResponse`;
   - repeated connect/disconnect cycles (the "latched" bug);
   - behaviour while the phone link is active.
6. An App Service with `createSysTimer` and `httpRequest` over several hours; check the success rate.
7. If you need extensions: does messaging work in your extension build? (See #554.)

---

## 15. Sources

**Local, official docs and code.** Paths are relative to `scratchpad/`.
- Docs:
  - `src/zeppos-docs/docs/guides/architecture/arc.mdx`
  - `src/zeppos-docs/docs/guides/framework/side-service/{intro,register}.md`
  - `src/zeppos-docs/docs/guides/framework/app-settings/{intro,register,ui-intro,js-support}.md`
  - `src/zeppos-docs/docs/guides/framework/device/{ble-central,app-service,permission}.md`
  - `src/zeppos-docs/docs/guides/best-practice/bluetooth-communication.mdx`
  - `src/zeppos-docs/docs/guides/version-info/new-features-{30,35,40,42}.md`
  - `src/zeppos-docs/docs/reference/side-service-api/*.mdx`
  - `src/zeppos-docs/docs/reference/app-settings-api/**`
  - `src/zeppos-docs/docs/reference/device-app-api/newAPI/{ble,transfer-file,alarm,app-service,timer}/*`
  - `src/zeppos-docs/static/llms/@zos-{ble,timer,device}.md`
  - `src/zeppos-docs/static/img/docs/guides/version_info/BLE.svg`
- ZML: `src/zml/src/shared/message.js`, `src/zml/src/core/common/message.js`, `src/zml/src/core/{device,side}/**`, `src/zml/zml.d.ts`, `src/zml/README.md`; `npm/zml43/` (0.0.43).
- Samples:
  - `src/zeppos-samples/application/4.0/fetch-api/`
  - `src/zeppos-samples/application/3.0/download/`
  - `src/zeppos-samples/application/3.0/3.0-feature/libs/ble.js`
  - `src/zeppos-samples/application/2.0/post-health-data/`
  - `src/zeppos-samples/workout-extensions/3.5/running-pace-master-with-side-service/`
- easy-ble: `src/easy-ble/README.md`, `src/easy-ble/easy-ble-npm/dist/ble-master.src.js`, `src/easy-ble/examples/ble-master-esp32/`.
- `src/rest-api/*.html` (Huami Open API).
- `src/visual-logger/2.0/dist/vis-side/` (logging from the Side Service and Settings App to the watch over messaging).
- `npm/dt400/` (`@zeppos/device-types` 4.0.0).
- Runtime bundles downloaded from Zepp (read-only analysis):
  - `runtime/mobile-main-service.js` ← `https://zepp-os.zepp.com/frameworks/v3.7.0.0/mobile-main-service.js`
  - `runtime/decoded_xc.js` (the embedded side-service worker)
  - `runtime/app-settings.prod.js` ← `https://zepp-os.zepp.com/app-settings/v1.0.1/app-settings.global.1767162754628.prod.js`
  - `runtime/redirect.prod.js` ← `https://zepp-os.zepp.com/app-settings/redirect.html`
  - `runtime/devices.json` ← `https://upload-cdn.zepp.com/zeppos/devkit/zeus/v1/devices.json`

**Web**
- Zepp official discussions:
  - 125: https://github.com/orgs/zepp-health/discussions/125
  - 159: https://github.com/orgs/zepp-health/discussions/159
  - 217: https://github.com/orgs/zepp-health/discussions/217
  - 276: https://github.com/orgs/zepp-health/discussions/276
  - 307: https://github.com/orgs/zepp-health/discussions/307
  - 351: https://github.com/orgs/zepp-health/discussions/351
  - 366: https://github.com/orgs/zepp-health/discussions/366
  - 478: https://github.com/orgs/zepp-health/discussions/478
- zeppos-forum: https://github.com/zepp-health/zeppos-forum/discussions/554 · https://github.com/zepp-health/zeppos-forum/discussions/386 · https://github.com/zepp-health/zeppos-forum/issues/571
- ZML issues: https://github.com/zepp-health/zml/issues/3 · https://github.com/zepp-health/zml/issues/9 · https://github.com/zepp-health/zml/issues/10
- Gadgetbridge: https://codeberg.org/Freeyourgadget/Gadgetbridge/issues/3266
- Community apps:
  - AmazHA: https://community.home-assistant.io/t/amazha-a-native-amazfit-zepp-os-companion-app-for-home-assistant/1014421
  - HA companion thread: https://community.home-assistant.io/t/home-assistant-companion-for-amazfit-devices/704586?page=5
  - https://github.com/ga2mer/ha-zepp
  - https://github.com/giovaboy/ZeppOS-HTTP-Buttons
  - https://github.com/kiedanski/gymsync
  - https://github.com/CuberQAQ/zepp-transfer-file-side
  - https://github.com/kassiohenrique977-blip/flashcards-trex3
  - https://github.com/melianmiko/ZeppOS-Tasks
- Easy BLE articles: https://silverdeveloper.com/easy-ble-advanced-comms-between-a-zeppos-watch-and-ble-peripherals/ · https://developer.zepp.com/os-post/easy-ble-advanced-comms-between-a-zeppos-watch-and-ble-peripherals
- Hardware and firmware: https://us.amazfit.com/products/amazfit-t-rex-3 · https://www.dcrainmaker.com/2025/01/amazfit-t-rex-3-gps-watch-depth-review.html · https://os.zepp.com/accessories · https://thewearify.com/amazfit-t-rex-3-receives-zepp-os-5-0-update/ · https://docs.zepp.com/docs/reference/related-resources/device-list/
- Cloud: https://github.com/zepp-health/rest-api/wiki · https://tryterra.co/integrations/zepp · https://docs.tryrook.io/data-sources/zepp/ · https://github.com/m4ary/zepp-health-cli · https://github.com/BenWyxell/ha-zepp-cloud · https://wellnessproject.ai/guides/zepp-sync
