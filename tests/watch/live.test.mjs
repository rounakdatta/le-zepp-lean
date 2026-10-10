// Pause/resume detection, the growing-file packet reader, and the pausable song clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import * as activity from '../../watch-app/lib/activity.js'
import { createPacketStream, feed, windowBytes } from '../../watch-app/lib/stream.js'
import { silkLevel } from '../../watch-app/lib/silk.js'
import * as sync from '../../watch-app/lib/sync.js'

function run(gains) {
  const a = activity.createActivity()
  const events = []
  gains.forEach((g, i) => {
    const e = activity.pushLevel(a, g, i)
    if (e) events.push(e)
  })
  return { a, events }
}

test('a stop in the music is reported at the first quiet packet, 240 ms later', () => {
  const gains = [28, 30, 27, 31, 29, 16, 15, 17, 16, 15, 16]
  const { events } = run(gains)
  assert.deepEqual(events, [{ type: 'pause', packet: 5 }])
})

test('short dips inside music are not pauses', () => {
  const { events } = run([28, 19, 18, 29, 30, 17, 19, 31, 28, 18, 18, 27])
  assert.deepEqual(events, [])
})

test('music coming back is reported at its first loud packet', () => {
  const gains = [29, 28, 16, 16, 16, 16, 17, 16, 30, 31, 29, 28, 30]
  const { events } = run(gains)
  assert.deepEqual(events, [{ type: 'pause', packet: 2 }, { type: 'resume', packet: 8 }])
})

test('after a rejected resume the same noise level no longer resumes', () => {
  const a = activity.createActivity()
  ;[16, 16, 16, 16].forEach((g, i) => activity.pushLevel(a, g, i))
  let e = null
  ;[24, 24, 24, 24].forEach((g, i) => (e = activity.pushLevel(a, g, 4 + i) || e))
  assert.equal(e.type, 'resume')
  activity.rejectResume(a, 24)
  e = null
  ;[24, 24, 24, 24, 24].forEach((g, i) => (e = activity.pushLevel(a, g, 8 + i) || e))
  assert.equal(e, null)
  ;[30, 31, 30, 32].forEach((g, i) => (e = activity.pushLevel(a, g, 13 + i) || e))
  assert.equal(e.type, 'resume')
})

// Local-only: replay the real watch recordings (not in git) through the detector.
const CAPTURES = new URL('../../server/captures/', import.meta.url)
test('real recordings: no false pauses inside music', { skip: !existsSync(CAPTURES) && 'no local captures' }, () => {
  let musicClips = 0
  for (const name of readdirSync(CAPTURES).filter((n) => n.endsWith('.json'))) {
    const meta = JSON.parse(readFileSync(new URL(name, CAPTURES)))
    if (!meta.ok || (meta.client || {}).source === 'fake_watch') continue
    const data = readFileSync(new URL(name.replace('.json', '.zepp.opus'), CAPTURES))
    const gains = []
    for (let pos = 0; pos + 8 <= data.length; ) {
      const len = data.readUInt32BE(pos)
      gains.push(silkLevel(data, pos + 8, pos + 8 + len).gain)
      pos += 8 + len
    }
    const { events } = run(gains)
    assert.deepEqual(events.filter((e) => e.type === 'pause'), [], `${name} had a false pause`)
    musicClips += 1
  }
  assert.ok(musicClips >= 3)
})

test('packet stream handles arbitrary chunking and re-frames windows', () => {
  const packets = [Uint8Array.from([0x5b, 1, 2]), Uint8Array.from([0x58, 9]), Uint8Array.from([0x58, 7, 7, 7, 7])]
  const file = []
  packets.forEach((p) => file.push(0, 0, 0, p.length, 0, 0, 0, 0, ...p))
  const bytes = Uint8Array.from(file)
  for (const cut of [1, 3, 8, 9, 10, 15, 20]) {
    const s = createPacketStream()
    const seen = []
    feed(s, bytes.slice(0, cut), (p, i) => seen.push([i, Array.from(p)]))
    feed(s, bytes.slice(cut), (p, i) => seen.push([i, Array.from(p)]))
    assert.deepEqual(seen, packets.map((p, i) => [i, Array.from(p)]), `cut at ${cut}`)
    const w = windowBytes(s, 1, 3)
    assert.equal(w.first, 1)
    assert.equal(w.packets, 2)
    assert.deepEqual(Array.from(w.bytes), file.slice(8 + 3))
  }
})

test('packet stream stops on bytes that are not the recorder framing', () => {
  const s = createPacketStream()
  feed(s, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 1]), () => assert.fail('no packets expected'))
  assert.equal(s.broken, true)
})

test('pausing freezes the song position; resuming shifts the song start by the pause', () => {
  const clock = sync.addEstimate(sync.createClock(), 1000)
  assert.equal(sync.positionAt(clock, 6000), 5000)
  sync.pauseClock(clock, 6000)
  assert.equal(sync.positionAt(clock, 9000), 5000)
  assert.equal(sync.isPaused(clock), true)
  sync.resumeClock(clock, 10000)
  assert.equal(sync.positionAt(clock, 10000), 5000)
  assert.equal(sync.positionAt(clock, 12000), 7000)
  assert.deepEqual(clock.samples, [5000])
  // a re-sync after the resume agrees with the shifted start
  sync.addEstimate(clock, 5010)
  assert.equal(clock.start, 5005)
})

test('word index and next-change timing within a line', () => {
  const lines = [[1000, 'Today is gonna be', [1000, 1400, 1700, 2100]], [3000, 'the day', [3000, 3300]]]
  assert.equal(sync.wordIndexAt(lines[0][2], 1500), 1)
  assert.equal(sync.wordIndexAt(lines[0][2], 999), -1)
  assert.equal(sync.msUntilNextChange(lines, 0, 1500), 200)
  assert.equal(sync.msUntilNextChange(lines, 0, 2500), 500)
  assert.equal(sync.msUntilNextChange(lines, 1, 3400), null)
  assert.deepEqual(sync.splitWords('  Today  is\tgonna '), ['Today', 'is', 'gonna'])
  assert.deepEqual(sync.splitWords(''), [])
})

test('lines appear early, words light up on time, and the next change is scheduled exactly', () => {
  const lines = [[1000, 'Today is gonna be', [1000, 1400, 1700, 2100]], [3000, 'the day', [3000, 3300]]]
  // 250 ms before the line: it is already shown (300 ms lead), but no word is lit yet
  assert.deepEqual(sync.displayAt(lines, 750, 300, 40), { line: 0, word: -1, waitMs: 210 })
  // 40 ms before "Today" is sung it lights up
  assert.deepEqual(sync.displayAt(lines, 960, 300, 40), { line: 0, word: 0, waitMs: 400 })
  // late in the line: the next change is the next line appearing 300 ms early
  assert.deepEqual(sync.displayAt(lines, 2500, 300, 40), { line: 0, word: 3, waitMs: 200 })
  assert.deepEqual(sync.displayAt(lines, 2700, 300, 40), { line: 1, word: -1, waitMs: 260 })
  assert.deepEqual(sync.displayAt(lines, 3400, 300, 40), { line: 1, word: 1, waitMs: null })
  // before anything: no line, waiting for the first one
  assert.deepEqual(sync.displayAt(lines, 0, 300, 40), { line: -1, word: -1, waitMs: 700 })
})
