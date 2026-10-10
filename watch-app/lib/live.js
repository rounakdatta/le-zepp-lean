// One continuous recording, read while it is still being written, so the watch can follow
// the music packet by packet (60 ms each) instead of in separate 5-second takes.
//
// Whether the recorder makes its file visible while recording is not documented, so this
// checks: if bytes appear before stop(), we are "progressive" and stay live; if nothing
// appears within PROBE_MS, the recording is stopped and handed back as an ordinary take.
//
// Packet timing: packet k covers watch time [origin + 60k, origin + 60(k+1)). `origin` is
// estimated from when packets become readable: at any poll, packet `count` hasn't been
// written yet, so origin <= now - 60 * count. The tightest of those bounds is the estimate.
import { create, id, codec } from '@zos/media'
import { statSync, openSync, readSync, closeSync, rmSync, readdirSync, O_RDONLY } from '@zos/fs'
import { createPacketStream, feed } from './stream'
import { silkLevel } from './silk'

export const PACKET_MS = 60
const POLL_MS = 100
const PROBE_MS = 4500
const SETTLE_POLL_MS = 150
const SETTLE_MAX_MS = 2500

// handlers: onPacket(index, gain, bytes) · onLive() · onTake(take) · onError(code, message)
export function startLive(handlers) {
  removeOldRecordings()
  const name = 'live-' + Date.now() + '.opus'
  let recorder
  try {
    recorder = create(id.RECORDER)
    recorder.setFormat(codec.OPUS, { target_file: 'data://' + name })
  } catch (e) {
    handlers.onError('recorder_unavailable', String(e))
    return null
  }
  const callAt = Date.now()
  try {
    recorder.start()
  } catch (e) {
    handlers.onError('recorder_start_failed', String(e))
    return null
  }

  const live = {
    name,
    recorder,
    startedAt: Date.now(),
    startCallMs: Date.now() - callAt,
    stream: createPacketStream(140),
    read: 0,
    origin: Infinity,
    progressive: false,
    growths: 0,
    firstGrowthMs: null,
    probe: [], // first polls: [ms since start, file size] (sent to the server as diagnostics)
    timer: null,
    stopped: false,
  }

  live.timer = setInterval(() => {
    try {
      poll(live, handlers)
    } catch (e) {
      handlers.onError('live_poll_failed', String(e))
    }
  }, POLL_MS)
  return live
}

function poll(live, handlers) {
  if (live.stopped) return
  const now = Date.now()
  const stat = statSync({ path: live.name })
  const size = stat ? stat.size : 0
  if (live.probe.length < 30) live.probe.push([now - live.startedAt, size])

  if (size > live.read) {
    const chunk = readRange(live.name, live.read, size)
    if (chunk) {
      live.read += chunk.length
      live.growths += 1
      if (live.firstGrowthMs === null) live.firstGrowthMs = now - live.startedAt
      feed(live.stream, chunk, (bytes, index) => {
        const level = silkLevel(bytes, 0, bytes.length)
        handlers.onPacket(index, level ? level.gain : null, bytes)
      })
      live.origin = Math.min(live.origin, now - PACKET_MS * live.stream.count)
    }
  }

  if (!live.progressive && live.growths >= 2) {
    live.progressive = true
    handlers.onLive(live)
  }
  if (!live.progressive && now - live.startedAt > PROBE_MS) {
    // The file only fills in at the end on this firmware: finish it as a normal take.
    stopTimer(live)
    const stoppedAt = Date.now()
    try {
      live.recorder.stop()
    } catch (e) {
      // the size check below decides whether anything usable was written
    }
    waitForStableSize(live.name, (finalSize, settleMs) => {
      const buffer = finalSize ? readRange(live.name, 0, finalSize) : null
      remove(live.name)
      handlers.onTake({
        buffer: buffer ? buffer.slice().buffer : null, // exact-length copy
        bytes: finalSize,
        startedAt: live.startedAt,
        stoppedAt,
        startCallMs: live.startCallMs,
        settleMs,
        probe: live.probe,
      })
    })
  }
}

// Watch time at which packet `index` started.
export function packetTime(live, index) {
  return live.origin + PACKET_MS * index
}

export function stopLive(live) {
  if (!live || live.stopped) return
  stopTimer(live)
  try {
    live.recorder.stop()
  } catch (e) {
    // already stopped
  }
  remove(live.name)
}

function stopTimer(live) {
  live.stopped = true
  if (live.timer) clearInterval(live.timer)
  live.timer = null
}

function readRange(name, from, to) {
  if (to <= from) return null
  const fd = openSync({ path: name, flag: O_RDONLY })
  if (fd === undefined || fd === null || fd < 0) return null
  try {
    const buffer = new ArrayBuffer(to - from)
    const n = readSync({ fd, buffer, options: { position: from, length: to - from } })
    return n > 0 ? new Uint8Array(buffer, 0, n) : null
  } finally {
    closeSync({ fd })
  }
}

function waitForStableSize(name, callback) {
  const began = Date.now()
  let last = -1
  let stable = 0
  const check = () => {
    const stat = statSync({ path: name })
    const size = stat ? stat.size : 0
    stable = size > 0 && size === last ? stable + 1 : 0
    last = size
    if (stable >= 2 || Date.now() - began > SETTLE_MAX_MS) {
      callback(size, Date.now() - began)
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
    // leftovers are cleaned up on the next start
  }
}

function removeOldRecordings() {
  try {
    const names = readdirSync({ path: 'data://' }) || readdirSync({ path: '' }) || []
    names.filter((n) => /^(live|clip)-\d+\.opus$/.test(n)).forEach(remove)
  } catch (e) {
    // not fatal
  }
}
