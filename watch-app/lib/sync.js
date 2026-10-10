// Pure lyrics timing: which line and word to show at a song position, and when that next
// changes. No Zepp APIs here, so it runs unchanged under Node for tests.
//
// The song clock itself (matches, pauses, speed) lives in clock.js; this module only maps a
// song position to what should be on screen.

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

// When line i takes over the screen. Normally lineLeadMs before it is sung, so it can be
// read ahead. But if the line before it has word timings and its last word comes late, the
// switch waits until that word has been lit for HOLD_LAST_WORD_MS: with a fixed 300 ms lead,
// a word sung less than ~260 ms before the next line was never lit at all. The wait never
// costs the new line its own first word (it still lights wordLeadMs early).
const HOLD_LAST_WORD_MS = 180

export function lineShownAt(lines, i, lineLeadMs, wordLeadMs) {
  const at = lines[i][0] - lineLeadMs
  const prev = lines[i - 1]
  if (!prev || !prev[2] || !prev[2].length) return at
  const lastLit = prev[2][prev[2].length - 1] - wordLeadMs + HOLD_LAST_WORD_MS
  const latest = lines[i][0] - wordLeadMs - 20
  return Math.max(at, Math.min(lastLit, latest))
}

// What to show at song position posMs: the line index, the highlighted word index (-1: none
// yet) and the ms until either changes (null when nothing is left). A line appears early so it
// can be read before it is sung (see lineShownAt); each word lights wordLeadMs early, just
// enough to cover drawing time.
export function displayAt(lines, posMs, lineLeadMs, wordLeadMs) {
  let li = lineIndexAt(lines, posMs + lineLeadMs)
  while (li >= 0 && posMs < lineShownAt(lines, li, lineLeadMs, wordLeadMs)) li -= 1
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
  if (li + 1 < lines.length) {
    const at = lineShownAt(lines, li + 1, lineLeadMs, wordLeadMs)
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
