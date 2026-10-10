// The song clock: where in the song we are, at any watch time. Pure logic, no Zepp APIs.
//
// Every recognition says "the audio that started at watch time t was at song position p".
// The clock fits those matches to   p = p0 + rate * (u - u0)   where u is *playing time*:
// watch time with every pause cut out. Working in playing time means a pause needs no
// bookkeeping beyond its start and end, and matches from before a pause stay valid after it.
//
// rate is 1 for digital playback. A turntable can run a percent fast or slow (600 ms a
// minute), so the clock starts from Shazam's speed estimate and then measures it from
// matches spread over time.
//
// Pause and resume times can be in the past: the watch learns that the music stopped a
// few packets after it did, and the clock is told the packet it stopped *at*.

export const JUMP_MS = 1500 // further than this from the prediction: the music skipped (seek, restart)
export const SHIFT_MS = 250 // two matches in a row this far off, and agreeing: a small skip
const MAX_SAMPLES = 6
const MIN_SPAN_FOR_RATE_MS = 30000
const MAX_RATE_ERROR = 0.03
// Shazam's speed estimate is believed only beyond this. On clean audio it wanders by
// +-0.06%; on a quiet simulated room recording it said -0.42% for a perfectly normal copy,
// and the lyrics fell behind by 4 ms every second. A turntable 1% off is still caught at
// once; anything smaller is measured from the matches themselves (fit below).
const SKEW_TRUSTED = 0.006

export function createClock() {
  return {
    samples: [], // [{ u, p }] playing time -> song position
    p0: 0,
    u0: 0,
    rate: 1,
    prior: 1, // rate to assume until matches say otherwise
    pauses: [], // [[startWatchMs, endWatchMs]] finished pauses, oldest first
    pausedBase: 0, // total length of pauses too old to keep one by one (all before anything still asked about)
    pausedAt: null, // watch time the current pause began
    lastPauseEnd: -Infinity, // watch time the latest pause ended
    suspect: null, // last match that disagreed: { u, p, d }
    unmatchedPause: false, // a pause happened since the last match: its length is only an estimate
  }
}

export function isKnown(clock) {
  return clock.samples.length > 0
}

export function isPaused(clock) {
  return clock.pausedAt !== null
}

// Watch time with every pause before `t` removed.
export function playingTime(clock, t) {
  let u = t - clock.pausedBase
  for (let i = 0; i < clock.pauses.length; i++) {
    const a = clock.pauses[i][0]
    const b = clock.pauses[i][1]
    if (t > a) u -= Math.min(t, b) - a
  }
  if (clock.pausedAt !== null && t > clock.pausedAt) u -= t - clock.pausedAt
  return u
}

// Song position (ms) at watch time t, or null before the first match.
export function songAt(clock, t, adjustMs) {
  if (!clock.samples.length) return null
  return clock.p0 + clock.rate * (playingTime(clock, t) - clock.u0) + (adjustMs || 0)
}

// Watch time at which the song reaches songMs, assuming it keeps playing from `now`.
export function watchTimeFor(clock, songMs, now, adjustMs) {
  const pos = songAt(clock, now, adjustMs)
  if (pos === null) return null
  return now + (songMs - pos) / clock.rate
}

// Shazam's timeskew is the playback speed error (+0.01 = 1% fast).
export function setRatePrior(clock, skew) {
  const s = Number(skew) || 0
  clock.prior = Math.abs(s) > SKEW_TRUSTED && Math.abs(s) < MAX_RATE_ERROR ? 1 + s : 1
  if (clock.samples.length) fit(clock)
}

// Add a match: the audio that started at watch time `t` was at song position `p`.
// Returns what it did: 'first' | 'refine' | 'jump' | 'suspect' and how far off it was.
export function addMatch(clock, t, p) {
  const u = playingTime(clock, t)
  if (!clock.samples.length) {
    clock.samples = [{ u, p }]
    clock.rate = clock.prior
    clock.suspect = null
    fit(clock)
    return { kind: 'first', deltaMs: 0 }
  }
  const predicted = clock.p0 + clock.rate * (u - clock.u0)
  const d = p - predicted
  if (Math.abs(d) > JUMP_MS) {
    restart(clock, u, p)
    return { kind: 'jump', deltaMs: d }
  }
  if (clock.unmatchedPause && clock.pausedAt === null && t >= clock.lastPauseEnd) {
    // The first match after a pause. The watch saw the stop and the start a few packets
    // late, each by a different amount, so the pause's length is the least certain number
    // here: put the disagreement there. Every earlier match shifts with it, instead of
    // outvoting this one for the next few minutes.
    clock.unmatchedPause = false
    clock.suspect = null
    clock.samples = clock.samples.map((x) => ({ u: x.u, p: x.p + d })).concat([{ u, p }]).slice(-MAX_SAMPLES)
    fit(clock)
    return { kind: Math.abs(d) > SHIFT_MS ? 'jump' : 'refine', deltaMs: d }
  }
  if (Math.abs(d) > SHIFT_MS) {
    // One odd match is more likely a bad match than a skip; two that agree are a skip.
    const prev = clock.suspect
    if (prev && Math.abs(prev.d - d) < 150) {
      clock.samples = [{ u: prev.u, p: prev.p }, { u, p }]
      clock.suspect = null
      clock.rate = clock.prior
      fit(clock)
      return { kind: 'jump', deltaMs: d }
    }
    clock.suspect = { u, p, d }
    return { kind: 'suspect', deltaMs: d }
  }
  clock.suspect = null
  clock.samples = clock.samples.concat([{ u, p }]).slice(-MAX_SAMPLES)
  fit(clock)
  return { kind: 'refine', deltaMs: d }
}

// A pause can't begin before the last one ended: that time is already cut out once, and
// cutting it again moved the song backwards.
export function pause(clock, t) {
  if (clock.pausedAt === null) {
    clock.pausedAt = Math.max(t, clock.lastPauseEnd)
    clock.unmatchedPause = true
  }
  return clock
}

// Music heard at or before the moment it stopped says nothing about it coming back: ignored.
export function resume(clock, t) {
  if (clock.pausedAt === null || t <= clock.pausedAt) return clock
  clock.pauses.push([clock.pausedAt, t])
  if (clock.pauses.length > 12) {
    // Dropping the oldest pause outright moved the song by its length (a minute's pause
    // after twelve short ones put the lyrics a minute off): keep its length in a total.
    const old = clock.pauses.shift()
    clock.pausedBase += old[1] - old[0]
  }
  clock.pausedAt = null
  clock.lastPauseEnd = t
  return clock
}

// Forget everything about the song (a new song, or the old one ended).
export function reset(clock) {
  const fresh = createClock()
  for (const k in fresh) clock[k] = fresh[k]
  return clock
}

function restart(clock, u, p) {
  clock.samples = [{ u, p }]
  clock.suspect = null
  clock.rate = clock.prior
  fit(clock)
}

// Rate: the median of the slopes between every pair of matches (Theil-Sen), once they span
// 40 s; before that, the prior. Least squares let one 180 ms outlier tilt the line enough to
// put the lyrics 85 ms off ten seconds later. Offset: the median residual, for the same reason.
function fit(clock) {
  const s = clock.samples
  const n = s.length
  const last = s[n - 1]
  clock.u0 = last.u
  let rate = clock.prior
  if (n >= 3 && last.u - s[0].u >= MIN_SPAN_FOR_RATE_MS) {
    const slopes = []
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const du = s[j].u - s[i].u
        if (du >= 10000) slopes.push((s[j].p - s[i].p) / du)
      }
    }
    if (slopes.length) rate = Math.min(1 + MAX_RATE_ERROR, Math.max(1 - MAX_RATE_ERROR, median(slopes)))
  }
  clock.rate = rate
  const residuals = s.map((x) => x.p - rate * (x.u - clock.u0))
  clock.p0 = median(residuals)
}

export function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
