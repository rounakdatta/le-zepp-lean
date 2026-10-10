// Pure timing logic: maps the watch clock to a position in the song. No Zepp APIs here,
// so it runs unchanged under Node for tests.
//
// Every recognition says "the clip you recorded started at song position offsetMs".
// With the watch time at which that clip started, that gives one estimate of when the
// song was at 0 ms, in watch time:  songStart = clipStartWatchMs - offsetMs.
// The song position at any moment is then simply  now - songStart.

// Two estimates further apart than this mean the music jumped (paused, seeked, restarted).
export const JUMP_MS = 1500

// While paused, `pausedAt` holds the watch time the music stopped, and the position stays
// frozen there. Resuming shifts the song start (and every past estimate) by the pause length.
export function createClock() {
  return { start: null, samples: [], pausedAt: null }
}

export function addEstimate(clock, songStartMs, jumpMs = JUMP_MS) {
  if (clock.start === null || Math.abs(songStartMs - clock.start) > jumpMs) {
    clock.samples = [songStartMs]
  } else {
    clock.samples = clock.samples.concat([songStartMs]).slice(-5)
  }
  clock.start = median(clock.samples)
  return clock
}

export function positionAt(clock, nowMs, adjustMs) {
  const at = clock.pausedAt === null ? nowMs : clock.pausedAt
  return at - clock.start + (adjustMs || 0)
}

export function pauseClock(clock, atWatchMs) {
  if (clock.pausedAt === null) clock.pausedAt = atWatchMs
  return clock
}

export function resumeClock(clock, atWatchMs) {
  if (clock.pausedAt === null) return clock
  const paused = Math.max(0, atWatchMs - clock.pausedAt)
  clock.samples = clock.samples.map((s) => s + paused)
  clock.start += paused
  clock.pausedAt = null
  return clock
}

export function isPaused(clock) {
  return clock.pausedAt !== null
}

export function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// lines: [[startMs, text], ...] sorted by startMs. Returns the index of the line being
// sung at posMs, or -1 before the first line.
export function lineIndexAt(lines, posMs) {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid][0] <= posMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// Milliseconds until the line after `idx` starts, or null when `idx` is the last line.
export function msUntilNextLine(lines, idx, posMs) {
  const next = lines[idx + 1]
  return next ? Math.max(0, next[0] - posMs) : null
}

// Index of the word being sung (last word whose start has passed), or -1 before the first.
export function wordIndexAt(wordStarts, posMs) {
  if (!wordStarts) return -1
  let found = -1
  for (let i = 0; i < wordStarts.length && wordStarts[i] <= posMs; i++) found = i
  return found
}

// Milliseconds until the next word or line change, whichever comes first (null: nothing left).
export function msUntilNextChange(lines, idx, posMs) {
  let next = null
  const line = lines[idx]
  const words = line && line[2]
  if (words) {
    for (let i = 0; i < words.length; i++) {
      if (words[i] > posMs) {
        next = words[i]
        break
      }
    }
  }
  const nextLine = lines[idx + 1]
  if (nextLine && (next === null || nextLine[0] < next)) next = nextLine[0]
  return next === null ? null : Math.max(0, next - posMs)
}

// What to show at song position posMs. The line appears lineLeadMs early so it can be read
// before it is sung; each word lights up wordLeadMs early, just enough to cover drawing time.
// Returns the line index, the highlighted word index (-1: none yet) and the ms until either
// changes (null when nothing is left).
export function displayAt(lines, posMs, lineLeadMs, wordLeadMs) {
  const li = lineIndexAt(lines, posMs + lineLeadMs)
  const words = li >= 0 ? lines[li][2] : null
  let wi = -1
  let next = null
  if (words) {
    for (let i = 0; i < words.length; i++) {
      const at = words[i] - wordLeadMs
      if (at <= posMs) {
        wi = i
      } else {
        next = at
        break
      }
    }
  }
  const nextLine = lines[li + 1]
  if (nextLine) {
    const at = nextLine[0] - lineLeadMs
    if (next === null || at < next) next = at
  }
  return { line: li, word: wi, waitMs: next === null ? null : Math.max(0, next - posMs) }
}

// Words of a lyric line, split exactly like the server does (Python str.split()).
export function splitWords(text) {
  const trimmed = (text || '').trim()
  return trimmed ? trimmed.split(/\s+/) : []
}

// How far through the current line we are (0..1), for the bar under the line.
export function lineProgress(lines, idx, posMs, songEndMs) {
  if (idx < 0 || !lines.length) return 0
  const start = lines[idx][0]
  const end = lines[idx + 1] ? lines[idx + 1][0] : songEndMs || start + 4000
  return Math.min(1, Math.max(0, (posMs - start) / Math.max(1, end - start)))
}

// Where in watch time the clip really started. Capture tends to begin a little after
// start() returns (the mic has to spin up), but ends promptly at stop(). So when the server
// tells us how much audio was actually decoded, anchor on the stop time instead.
export function clipStartMs(startedAt, stoppedAt, decodedMs) {
  if (!decodedMs) return { at: startedAt, anchor: 'start', latencyMs: null }
  const byStop = stoppedAt - decodedMs
  const latency = byStop - startedAt
  if (latency > -300 && latency < 1500) return { at: byStop, anchor: 'stop', latencyMs: latency }
  return { at: startedAt, anchor: 'start', latencyMs: latency }
}
