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
import { create, id, codec } from '@zos/media'
import { statSync, readFileSync, rmSync } from '@zos/fs'

const SETTLE_POLL_MS = 150
const SETTLE_MAX_MS = 2500

export function recordClip(durationMs, done) {
  const name = 'clip-' + Date.now() + '.opus'
  let recorder
  try {
    recorder = create(id.RECORDER)
    recorder.setFormat(codec.OPUS, { target_file: 'data://' + name })
  } catch (e) {
    done({ error: 'recorder_unavailable', message: String(e) })
    return
  }

  const callAt = Date.now()
  try {
    recorder.start()
  } catch (e) {
    done({ error: 'recorder_start_failed', message: String(e) })
    return
  }
  const startedAt = Date.now()

  setTimeout(() => {
    const stoppedAt = Date.now()
    try {
      recorder.stop()
    } catch (e) {
      // the file may still be usable; the size check below decides
    }
    waitForStableSize(name, (size, settleMs) => {
      const timing = { startedAt, stoppedAt, startCallMs: startedAt - callAt, settleMs }
      if (!size) {
        remove(name)
        done({ error: 'empty_recording', ...timing })
        return
      }
      const buffer = readFileSync({ path: name })
      remove(name)
      if (!buffer) {
        done({ error: 'read_failed', ...timing })
        return
      }
      done({ buffer, bytes: size, ...timing })
    })
  }, durationMs)
}

// The recorder finishes writing after stop() returns; wait until the size stops changing.
function waitForStableSize(name, callback) {
  const began = Date.now()
  let last = -1
  let stableChecks = 0
  const check = () => {
    const stat = statSync({ path: name })
    const size = stat ? stat.size : 0
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
