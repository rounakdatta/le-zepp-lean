// Stand-ins for the Zepp OS APIs the watch page uses besides drawing (that is zos-ui.mjs):
// enough for watch-app/page/home to load and run under Node. Inert, except the microphone,
// which records nothing but says how it was used.

// @zos/interaction
export const KEY_UP = 1
export const KEY_DOWN = 2
export const KEY_SELECT = 3
export const KEY_EVENT_CLICK = 1
export const KEY_EVENT_LONG_PRESS = 2
export function onKey() {}
export function offKey() {}
export function showToast() {}

// @zos/display
export function setPageBrightTime() {}
export function resetPageBrightTime() {}
export function pauseDropWristScreenOff() {}
export function resetDropWristScreenOff() {}

// @zos/sensor
export const VIBRATOR_SCENE_SHORT_STRONG = 1
export class Vibrator {
  start() {}
  stop() {}
}

// @zos/ble: the phone link, up unless a test says otherwise
export const ble = { up: true }
export function connectStatus() {
  return ble.up
}

// @zos/settings
export function getSystemInfo() {
  return { minAPI: '5.0', firmwareVersion: 'test' }
}

// @zeppos/zml/base-page
export function BasePage(page) {
  return page
}

// @zos/media: one recorder, as on the watch. `overlaps` counts start() while it records.
// `stopEventMs`: STOP fires this long after stop() (null: this firmware sends no events).
export const mic = { starts: 0, overlaps: 0, on: false, stopEventMs: null, stoppedAt: 0 }
export const id = { RECORDER: 'recorder' }
export const codec = { OPUS: 'opus' }
export function create() {
  const listeners = {}
  return {
    event: { START: 'start', STOP: 'stop' },
    setFormat() {},
    addEventListener(type, fn) {
      listeners[type] = fn
    },
    start() {
      if (mic.on) mic.overlaps += 1
      mic.on = true
      mic.starts += 1
    },
    stop() {
      mic.on = false
      mic.stoppedAt = Date.now()
      if (mic.stopEventMs !== null && listeners.stop) setTimeout(listeners.stop, mic.stopEventMs)
    },
  }
}

// @zos/fs: a recording is `files.take` (null: it comes back empty), there only once the
// recorder has stopped, as on a T-Rex 3; with `flushMs`, its last 30% written out over that
// long after stop(), smoothly or (`flushStepMs`) in steps that far apart
export const files = { take: null, flushMs: 0, flushStepMs: 0 }
export const O_RDONLY = 0
export function statSync() {
  if (mic.on || !files.take) return { size: 0 }
  const since = Date.now() - mic.stoppedAt
  if (since >= files.flushMs) return { size: files.take.byteLength }
  const written = files.flushStepMs ? Math.floor(since / files.flushStepMs) * files.flushStepMs : since
  return { size: Math.floor(files.take.byteLength * (0.7 + (0.3 * written) / files.flushMs)) }
}
export function readFileSync() {
  return mic.on ? null : files.take
}
export function writeFileSync() {}
export function rmSync() {}
export function readdirSync() {
  return []
}
export function openSync() {
  return -1
}
export function readSync() {
  return 0
}
export function closeSync() {}
