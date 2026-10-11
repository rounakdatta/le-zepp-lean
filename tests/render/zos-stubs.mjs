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

// @zos/settings
export function getSystemInfo() {
  return { minAPI: '5.0', firmwareVersion: 'test' }
}

// @zeppos/zml/base-page
export function BasePage(page) {
  return page
}

// @zos/media: one recorder, as on the watch. `overlaps` counts start() while it records.
export const mic = { starts: 0, overlaps: 0, on: false }
export const id = { RECORDER: 'recorder' }
export const codec = { OPUS: 'opus' }
export function create() {
  return {
    event: { START: 'start', STOP: 'stop' },
    setFormat() {},
    addEventListener() {},
    start() {
      if (mic.on) mic.overlaps += 1
      mic.on = true
      mic.starts += 1
    },
    stop() {
      mic.on = false
    },
  }
}

// @zos/fs: no files ever appear (so every recording comes back empty)
export const O_RDONLY = 0
export function statSync() {
  return { size: 0 }
}
export function readFileSync() {
  return null
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
