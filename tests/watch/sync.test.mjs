// Tests for the watch's pure timing logic. Run from the repo root: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sync from '../../watch-app/lib/sync.js'

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)

const LINES = [
  [13130, 'Yeah'],
  [16560, ''],
  [27160, "I've been tryna call"],
  [29960, "I've been on my own for long enough"],
]

test('lineIndexAt finds the line being sung', () => {
  assert.equal(sync.lineIndexAt(LINES, 0), -1)
  assert.equal(sync.lineIndexAt(LINES, 13129), -1)
  assert.equal(sync.lineIndexAt(LINES, 13130), 0)
  assert.equal(sync.lineIndexAt(LINES, 20000), 1)
  assert.equal(sync.lineIndexAt(LINES, 29960), 3)
  assert.equal(sync.lineIndexAt(LINES, 999999), 3)
  assert.equal(sync.lineIndexAt([], 5000), -1)
})

test('song position follows the watch clock from one recognition', () => {
  // Watch time 1_000_000: clip starts; the server says that was 143,987.7 ms into the song.
  const clock = sync.addEstimate(sync.createClock(), 1_000_000 - 143_987.7)
  near(sync.positionAt(clock, 1_000_000), 143_987.7)
  near(sync.positionAt(clock, 1_010_000), 153_987.7)
  near(sync.positionAt(clock, 1_010_000, 100), 154_087.7) // UP nudge shows lyrics 0.1 s earlier
})

test('estimates are combined by median, and a jump restarts the clock', () => {
  const clock = sync.createClock()
  sync.addEstimate(clock, 5000)
  sync.addEstimate(clock, 5040)
  sync.addEstimate(clock, 4990)
  assert.equal(clock.start, 5000)
  sync.addEstimate(clock, 5400) // small wobble: median of the last five
  assert.equal(clock.start, 5020)
  sync.addEstimate(clock, 9000) // music paused or skipped: start over
  assert.deepEqual(clock.samples, [9000])
  assert.equal(clock.start, 9000)
})

test('msUntilNextLine and lineProgress', () => {
  assert.equal(sync.msUntilNextLine(LINES, 0, 15000), 1560)
  assert.equal(sync.msUntilNextLine(LINES, 3, 31000), null)
  assert.equal(sync.lineProgress(LINES, 2, 27160 + 1400, 200000), 0.5)
  assert.equal(sync.lineProgress(LINES, -1, 5000, 200000), 0)
  assert.equal(sync.lineProgress(LINES, 3, 999999, 200000), 1)
})

test('clip start anchors on stop() when the decoded length is plausible', () => {
  // start() returned at 1000, stop() at 6000, but only 4800 ms of audio came back:
  // the mic took ~200 ms to start capturing, so the clip really began at 1200.
  assert.deepEqual(sync.clipStartMs(1000, 6000, 4800), { at: 1200, anchor: 'stop', latencyMs: 200 })
  // Implausible decode length (e.g. a truncated file): fall back to the start() time.
  assert.equal(sync.clipStartMs(1000, 6000, 1000).anchor, 'start')
  assert.equal(sync.clipStartMs(1000, 6000, undefined).anchor, 'start')
})

test('end to end: the server offset drives the displayed line', () => {
  // Real numbers from the local server test: a clip starting 151,052.9 ms into
  // "Blinding Lights"; the line starting at 150,270 ms is being sung.
  const lines = [[144330, 'I said, "Ooh, I\'m blinded by the lights'], [150270, 'I said, "Ooh, I\'m blinded by the lights'], [156330, 'No, I can\'t sleep until I feel your touch"']]
  const startedAt = 50_000
  const clock = sync.addEstimate(sync.createClock(), startedAt - 151_052.9)
  const lead = 150
  // 5 s of recording + ~3 s of round trip later, we should be on the third line.
  const now = startedAt + 8_000
  const idx = sync.lineIndexAt(lines, sync.positionAt(clock, now) + lead)
  assert.equal(idx, 2)
  // And the switch into that line was scheduled for exactly when it starts (minus the lead).
  const before = startedAt + (156_330 - 151_052.9) - lead - 1
  assert.equal(sync.lineIndexAt(lines, sync.positionAt(clock, before) + lead), 1)
})
