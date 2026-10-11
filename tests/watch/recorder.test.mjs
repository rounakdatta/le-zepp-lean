// The recorder (watch-app/lib/recorder.js) against the stand-ins in tests/render, time mocked.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('../render/hooks.mjs', import.meta.url)
const { mic, files } = await import('../render/zos-stubs.mjs')

async function take(t, ms) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  t.after(() => {
    mock.timers.reset()
    Object.assign(mic, { on: false, stopEventMs: null })
    Object.assign(files, { take: null, flushMs: 0, flushStepMs: 0 })
  })
  const { recordClip } = await import(`../../watch-app/lib/recorder.js?${Math.random()}`)
  let result = null
  recordClip(ms, (r) => (result = r))
  for (let k = 0; k < ms / 5 + 1000 && !result; k++) {
    mock.timers.tick(5)
    await Promise.resolve()
  }
  return result
}

test('a take is handed over once its file stops growing after STOP, not ~0.3 s later', async (t) => {
  // as on a T-Rex 3: STOP ~5 ms after stop(), the file still being written for a while after it
  Object.assign(mic, { stopEventMs: 5 })
  Object.assign(files, { take: new ArrayBuffer(5400), flushMs: 60 })
  const r = await take(t, 3000)
  assert.equal(r.bytes, 5400, 'the whole file, not part of it')
  assert.ok(r.settleMs <= 200, `handed over ${r.settleMs} ms after stop()`)
})

test('a file still written in steps after STOP is not handed over between two of them', async (t) => {
  // the last packets appended 60 ms apart: a pause between two writes is not the end
  Object.assign(mic, { stopEventMs: 5 })
  Object.assign(files, { take: new ArrayBuffer(5400), flushMs: 180, flushStepMs: 60 })
  const r = await take(t, 3000)
  assert.equal(r.bytes, 5400, `${r.bytes} of 5400 bytes`)
})

test('without a STOP event the size holding still decides, as before', async (t) => {
  Object.assign(files, { take: new ArrayBuffer(5400), flushMs: 60 })
  const r = await take(t, 3000)
  assert.equal(r.bytes, 5400)
})
