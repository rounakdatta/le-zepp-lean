// The watch's SILK loudness reader must agree packet-for-packet with the Python reference
// (server/scripts/silk_levels.py). Run from the repo root: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { silkLevel } from '../../watch-app/lib/silk.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/silk-packets.json', import.meta.url)))

test('gain and VAD match the reference on synthetic watch-style packets', () => {
  fixture.packets.forEach((b64, i) => {
    const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
    const got = silkLevel(bytes, 0, bytes.length)
    const want = fixture.expected[i]
    assert.deepEqual(got && [got.gain, got.vad], want, `packet ${i}`)
  })
})

test('works on a packet inside a larger buffer (as read from the recording file)', () => {
  const b = Buffer.from(fixture.packets[40], 'base64')
  const buf = new Uint8Array(b.length + 20)
  buf.set(b, 9)
  const got = silkLevel(buf, 9, 9 + b.length)
  assert.deepEqual([got.gain, got.vad], fixture.expected[40])
})

test('non-SILK or multi-frame packets are skipped', () => {
  assert.equal(silkLevel(Uint8Array.from([0xfc, 1, 2, 3]), 0, 4), null) // CELT config
  assert.equal(silkLevel(Uint8Array.from([0x5b, 1, 2, 3]), 0, 4), null) // SILK but code 3
})

// Local-only: real T-Rex 3 recordings (not in git) cross-checked against the Python reference.
const REAL = '/tmp/lzl-real-silk-expected.json'
test('matches the reference on real watch recordings', { skip: !existsSync(REAL) && 'no local captures' }, () => {
  const expected = JSON.parse(readFileSync(REAL))
  let packets = 0
  for (const [file, levels] of Object.entries(expected)) {
    const path = new URL('../../server/' + file, import.meta.url)
    if (!existsSync(path)) continue
    const data = readFileSync(path)
    let pos = 0
    let i = 0
    while (pos + 8 <= data.length) {
      const len = data.readUInt32BE(pos)
      const got = silkLevel(data, pos + 8, pos + 8 + len)
      assert.deepEqual(got && [got.gain, got.vad], levels[i], `${file} packet ${i}`)
      pos += 8 + len
      i += 1
      packets += 1
    }
  }
  assert.ok(packets > 500, `checked ${packets} packets`)
})
