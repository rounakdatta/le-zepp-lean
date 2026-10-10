// The song clock: matches in, song position out, through pauses, skips and wrong-speed turntables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as clock from '../../watch-app/lib/clock.js'

const near = (actual, expected, tol = 1e-6, what = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what} ${actual} is not within ${tol} of ${expected}`)

test('before any match the position is unknown, after one it follows the watch', () => {
  const c = clock.createClock()
  assert.equal(clock.songAt(c, 1000), null)
  assert.equal(clock.addMatch(c, 1_000_000, 143_987.7).kind, 'first')
  near(clock.songAt(c, 1_000_000), 143_987.7)
  near(clock.songAt(c, 1_010_000), 153_987.7)
  near(clock.songAt(c, 1_010_000, 100), 154_087.7) // the UP nudge shows lyrics 0.1 s earlier
})

test('a turntable running 1% fast is followed from the first match', () => {
  const c = clock.createClock()
  clock.setRatePrior(c, 0.0097) // Shazam's timeskew for a 1% fast copy, measured
  clock.addMatch(c, 0, 60_000)
  // a minute later the song is 60.58 s further on, not 60 s: within 20 ms, not 580 ms
  near(clock.songAt(c, 60_000), 120_582, 20)
})

test('digital playback keeps rate 1: Shazam skew noise is ignored', () => {
  const c = clock.createClock()
  clock.setRatePrior(c, -0.00025) // measured on a perfectly normal copy
  clock.addMatch(c, 0, 0)
  near(clock.songAt(c, 60_000), 60_000)
})

test('the speed is measured from matches spread over time', () => {
  const c = clock.createClock()
  const rate = 0.995 // 0.5% slow, and Shazam said nothing
  const noise = [12, -18, 7, -9, 15, -4]
  // the watch re-syncs about every 30 s; each match is a few tens of ms noisy
  ;[0, 10_000, 40_000, 70_000, 100_000, 130_000].forEach((t, i) => {
    const r = clock.addMatch(c, t, 10_000 + rate * t + noise[i])
    assert.notEqual(r.kind, 'jump', `match ${i}`)
  })
  near(c.rate, rate, 0.0005, 'rate')
  // at the next re-sync, 30 s on, the lyrics are still within 40 ms (unmeasured: 150 ms)
  near(clock.songAt(c, 160_000), 10_000 + rate * 160_000, 40, 'position')
})

test('a pause freezes the song where it stopped; a resume carries on from there', () => {
  const c = clock.createClock()
  clock.addMatch(c, 1000, 0)
  assert.equal(clock.songAt(c, 6000), 5000)
  clock.pause(c, 6000)
  assert.equal(clock.songAt(c, 9000), 5000)
  assert.equal(clock.isPaused(c), true)
  clock.resume(c, 10_000)
  assert.equal(clock.songAt(c, 10_000), 5000)
  assert.equal(clock.songAt(c, 12_000), 7000)
})

test('the watch notices a stop late; the clock still freezes at the packet it stopped on', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 30_000)
  // the music stopped at watch time 10,000; the detector is sure 300 ms later
  clock.pause(c, 10_000)
  assert.equal(clock.songAt(c, 10_300), 40_000)
  // and noticed the music back 240 ms after it really resumed at 20,000
  clock.resume(c, 20_000)
  assert.equal(clock.songAt(c, 20_240), 40_240)
})

test('a match recorded before a pause still lines up after the resume', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  clock.pause(c, 5000)
  clock.resume(c, 9000)
  // audio from watch time 2000 (before the pause) answered late: song position 2000
  assert.equal(clock.addMatch(c, 2000, 2000).kind, 'refine')
  assert.equal(clock.songAt(c, 10_000), 6000)
})

test('one wild match restarts the clock: the music was skipped', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 50_000)
  const r = clock.addMatch(c, 10_000, 120_000)
  assert.equal(r.kind, 'jump')
  assert.equal(clock.songAt(c, 10_000), 120_000)
})

test('one match 300 ms off is not believed; a second that agrees is', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  assert.equal(clock.addMatch(c, 10_000, 10_300).kind, 'suspect')
  assert.equal(clock.songAt(c, 10_000), 10_000) // unchanged by the odd one out
  assert.equal(clock.addMatch(c, 20_000, 20_310).kind, 'jump')
  near(clock.songAt(c, 20_000), 20_310, 10)
})

test('one bad match among good ones does not tilt the clock', () => {
  const c = clock.createClock()
  ;[0, 30, -20, 180, 10, -15].forEach((err, i) => clock.addMatch(c, i * 15_000, i * 15_000 + err))
  near(c.rate, 1, 0.002, 'rate')
  near(clock.songAt(c, 90_000), 90_000, 30, 'position 15 s after the last match')
})

test('watchTimeFor converts a song time into a timer deadline at the measured speed', () => {
  const c = clock.createClock()
  clock.setRatePrior(c, 0.02)
  clock.addMatch(c, 0, 0)
  near(clock.watchTimeFor(c, 10_200, 0), 10_000, 1e-6)
})

test('reset forgets the song', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 1000)
  clock.pause(c, 10)
  clock.reset(c)
  assert.equal(clock.songAt(c, 100), null)
  assert.equal(clock.isPaused(c), false)
})

test('the first match after a pause corrects the pause, and earlier matches move with it', () => {
  const c = clock.createClock()
  ;[0, 30_000, 60_000].forEach((t) => clock.addMatch(c, t, 10_000 + t))
  // the music stopped at 70,000 but the watch saw it at 70,100; it came back at 80,000, seen at 80,150
  clock.pause(c, 70_100)
  clock.resume(c, 80_150)
  // the clock now runs 50 ms behind: it thinks the pause lasted 10,050 ms, not 10,000
  near(clock.songAt(c, 90_000), 89_950, 1e-6)
  // the resume check: audio from 81,000 was at song 81,000
  const r = clock.addMatch(c, 81_000, 81_000)
  assert.equal(r.kind, 'refine')
  near(clock.songAt(c, 90_000), 90_000, 1, 'right at once, not after three more matches')
  // and the next match agrees with all of them
  assert.equal(clock.addMatch(c, 110_000, 110_000).kind, 'refine')
  near(clock.songAt(c, 120_000), 120_000, 1)
})

test('after a pause, a match 600 ms off is believed at once: the music moved while paused', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  clock.pause(c, 10_000)
  clock.resume(c, 20_000)
  const r = clock.addMatch(c, 21_000, 11_600)
  assert.equal(r.kind, 'jump')
  near(clock.songAt(c, 21_000), 11_600, 1)
})

// ---- review findings (2026-10-10) ----

test('a long pause stays counted after many short ones', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  clock.pause(c, 10_000)
  clock.resume(c, 70_000) // a minute's pause
  let t = 80_000
  for (let i = 0; i < 14; i++) {
    clock.pause(c, t)
    clock.resume(c, t + 100)
    t += 1000
  }
  // played 10 s before the long pause, then (t - 70,000) minus 14 x 100 ms of short pauses
  near(clock.songAt(c, t), 10_000 + (t - 70_000) - 1400, 1e-6)
})

test('a late answer about audio from before a pause does not use up the pause correction', () => {
  const c = clock.createClock()
  ;[0, 30_000, 60_000].forEach((t) => clock.addMatch(c, t, 10_000 + t))
  clock.pause(c, 70_100)
  clock.resume(c, 80_150)
  clock.addMatch(c, 65_000, 75_000) // answered late: audio from before the pause
  clock.addMatch(c, 81_000, 81_000) // the resume check
  near(clock.songAt(c, 90_000), 90_000, 1, 'the resume check still corrected the pause')
})

test('resuming at or before the pause start does not erase the pause', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  clock.pause(c, 10_000)
  clock.resume(c, 9_000)
  assert.equal(clock.isPaused(c), true)
  assert.equal(clock.songAt(c, 20_000), 10_000)
})

test('a pause dated before the last resume starts at that resume instead', () => {
  const c = clock.createClock()
  clock.addMatch(c, 0, 0)
  clock.pause(c, 10_000)
  clock.resume(c, 20_000)
  clock.pause(c, 15_000) // stale: that time is already cut out
  assert.equal(clock.songAt(c, 30_000), 10_000, 'frozen where the music was at the last resume')
})
