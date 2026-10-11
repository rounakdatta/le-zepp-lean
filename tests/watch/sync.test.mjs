// Tests for the watch's pure timing logic. Run from the repo root: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as sync from '../../watch-app/lib/sync.js'
import * as clock from '../../watch-app/lib/clock.js'

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

test('msUntilNextLine and lineProgress', () => {
  assert.equal(sync.msUntilNextLine(LINES, 0, 15000), 1560)
  assert.equal(sync.msUntilNextLine(LINES, 3, 31000), null)
  assert.equal(sync.lineProgress(LINES, 2, 27160 + 1400, 200000), 0.5)
  assert.equal(sync.lineProgress(LINES, -1, 5000, 200000), 0)
  assert.equal(sync.lineProgress(LINES, 3, 999999, 200000), 1)
})

test('end to end: the server offset drives the displayed line', () => {
  // Real numbers from the local server test: a clip starting 151,052.9 ms into
  // "Blinding Lights"; the line starting at 150,270 ms is being sung.
  const lines = [[144330, 'I said, "Ooh, I\'m blinded by the lights'], [150270, 'I said, "Ooh, I\'m blinded by the lights'], [156330, 'No, I can\'t sleep until I feel your touch"']]
  const startedAt = 50_000
  const c = clock.createClock()
  clock.addMatch(c, startedAt, 151_052.9)
  const lead = 150
  // 5 s of recording + ~3 s of round trip later, we should be on the third line.
  const now = startedAt + 8_000
  const idx = sync.lineIndexAt(lines, clock.songAt(c, now) + lead)
  assert.equal(idx, 2)
  // And the switch into that line was scheduled for exactly when it starts (minus the lead).
  const before = startedAt + (156_330 - 151_052.9) - lead - 1
  assert.equal(sync.lineIndexAt(lines, clock.songAt(c, before) + lead), 1)
})

test('a word sung just before the next line still lights before the line changes', () => {
  // "one two three" with "three" starting 200 ms before the next line: with the next line
  // shown 300 ms early, "three" used to be skipped entirely.
  const lines = [[1000, 'one two three', [1000, 1400, 2800], 3000], [3000, 'four five', [3000, 3400], 4000]]
  const d = sync.displayAt(lines, 2800, 300, 40)
  assert.equal(d.line, 0, 'still on the first line')
  assert.equal(d.word, 2, 'with "three" lit')
  // and the next line comes in time for its first word
  const e = sync.displayAt(lines, 3000 - 40, 300, 40)
  assert.equal(e.line, 1)
  assert.equal(e.word, 0)
})
