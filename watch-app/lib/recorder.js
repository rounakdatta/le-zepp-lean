// Records one short mic clip with the Zepp OS Recorder and hands back its bytes.
//
// Written around what developers found on real watches (zepp-health discussion #556):
// - `device:os.mic` must be in app.json permissions, or start() throws PERMISSION DENIED
//   (the permission is not in the docs).
// - Some firmware exposes only setFormat/start/stop: no events, no getStatus. So we time
//   the take ourselves instead of waiting for a START event.
// - The file is raw Opus packets (opus_demo framing), not Ogg; the server decodes it.
// - A take started soon after the previous stop(), or a very short take, can leave a
//   0-byte file and lock the mic until the watch restarts. Callers keep takes >= 4 s and
//   spaced apart; a 0-byte result is reported as 'empty_recording'.
// - `done` is called exactly once, whatever happens. On a T-Rex 3 (firmware 6.4.16.3) a take
//   that never reported back left the app "Listening…" for good.
// - One recorder for the app's life (`microphone()`, shared with live.js). The watch hands
//   out one at a time: a second create() returns undefined until the first is garbage
//   collected, and on a T-Rex 3 every take after the first failed that way.
import { create, id, codec } from '@zos/media'
import { statSync, readFileSync, rmSync } from '@zos/fs'

const SETTLE_POLL_MS = 100
const SETTLE_MAX_MS = 2500
// After STOP, the size is read this often until five reads in a row agree (100 ms without a
// write: a shorter wait could fall between two writes of the last packets, and a take short of
// them is timed late by them all). Read once, 30 ms after STOP, it still moved on 9 takes in 10,
// and the take then waited ~310 ms for the polling below (T-Rex 3, 11 Oct 2026).
const STOP_POLL_MS = 25
const STOP_STABLE_READS = 5

let mic = null
let onStop = null // the take waiting for the recorder's STOP event

export function microphone() {
  if (!mic) {
    mic = create(id.RECORDER) || null
    try {
      // STOP comes ~5 ms after stop() on a T-Rex 3: the file is finished long before the
      // ~0.3 s that watching its size takes. Firmware without events falls back on that.
      if (mic) mic.addEventListener(mic.event.STOP, () => {
        const f = onStop
        onStop = null
        if (f) f()
      })
    } catch (e) {
      // no events here: the size check decides
    }
  }
  return mic
}

// After a failure: the next take asks the system for a recorder again.
export function forgetMicrophone() {
  mic = null
}

export function recordClip(durationMs, done, log) {
  const say = log || function () {}
  const name = 'clip-' + Date.now() + '.opus'
  let recorder = null
  let finished = false
  const finish = (result) => {
    if (finished) return
    finished = true
    onStop = null
    if (result.error && result.error !== 'empty_recording') forgetMicrophone()
    say(result.error ? 'take failed: ' + result.error + (result.message ? ' ' + result.message : '') : 'take recorded: ' + result.bytes + ' bytes')
    done(result)
  }
  try {
    recorder = microphone()
    if (!recorder) throw new Error('the system gave no recorder')
    recorder.setFormat(codec.OPUS, { target_file: 'data://' + name })
  } catch (e) {
    finish({ error: 'recorder_unavailable', message: String(e) })
    return
  }

  const callAt = Date.now()
  try {
    recorder.start()
  } catch (e) {
    finish({ error: 'recorder_start_failed', message: String(e) })
    return
  }
  const startedAt = Date.now()
  say('take started')

  setTimeout(() => {
    const stoppedAt = Date.now()
    let settled = false
    const done = (size, settleMs) => {
      if (settled) return
      settled = true
      const timing = { startedAt, stoppedAt, startCallMs: startedAt - callAt, settleMs }
      try {
        const buffer = size ? readFileSync({ path: name }) : null
        remove(name)
        if (!size) finish({ error: 'empty_recording', ...timing })
        else if (!buffer) finish({ error: 'read_failed', ...timing })
        else finish({ buffer, bytes: size, ...timing })
      } catch (e) {
        finish({ error: 'read_failed', message: String(e), ...timing })
      }
    }
    // Whichever is first: the STOP event (then the size, read every 25 ms until it holds),
    // or the size holding still.
    onStop = () => {
      let last = sizeOf(name)
      let same = 1
      const poll = () => {
        if (settled) return
        const size = sizeOf(name)
        same = size > 0 && size === last ? same + 1 : 1
        last = size
        if (same >= STOP_STABLE_READS) {
          done(size, Date.now() - stoppedAt)
          return
        }
        setTimeout(poll, STOP_POLL_MS)
      }
      setTimeout(poll, STOP_POLL_MS)
    }
    try {
      recorder.stop()
    } catch (e) {
      // the file may still be usable; the size check below decides
    }
    waitForStableSize(name, done, () => settled)
  }, durationMs)
}

function sizeOf(name) {
  try {
    const stat = statSync({ path: name })
    return stat ? stat.size : 0
  } catch (e) {
    return 0
  }
}

// The recorder finishes writing after stop() returns; wait until the size stops changing.
function waitForStableSize(name, callback, over) {
  const began = Date.now()
  let last = -1
  let stableChecks = 0
  const check = () => {
    if (over && over()) return // finished another way (the STOP event)
    let size = 0
    try {
      const stat = statSync({ path: name })
      size = stat ? stat.size : 0
    } catch (e) {
      // not there (yet): size 0
    }
    stableChecks = size > 0 && size === last ? stableChecks + 1 : 0
    last = size
    const waited = Date.now() - began
    if (stableChecks >= 2 || waited > SETTLE_MAX_MS) {
      callback(size, waited)
      return
    }
    setTimeout(check, SETTLE_POLL_MS)
  }
  setTimeout(check, SETTLE_POLL_MS)
}

function remove(name) {
  try {
    rmSync({ path: name })
  } catch (e) {
    // leftover clips are harmless; each take uses a new file name
  }
}
