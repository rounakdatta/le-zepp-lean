// The watch page itself (watch-app/page/home), driven the way the watch would drive it:
// Zepp OS is the stand-ins in tests/render, the phone's relay is a function, time is mocked.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('../render/hooks.mjs', import.meta.url)
const ui = await import('../render/zos-ui.mjs')
const { errors } = await import('../render/zos-utils.mjs')
const { mic } = await import('../render/zos-stubs.mjs')

const SONG = { title: 'Wonderwall', artist: 'Oasis', durationMs: 258_000, speed: 1, songId: 'wonderwall' }
const SYNCED = { ok: true, song: { id: 'wonderwall' }, lyrics: { version: 'v1', kind: 'synced', lines: [[500, 'Today is gonna be the day', null, null]] }, words: { status: 'ready' } }

// Promise callbacks (the relay's answers) run between timer ticks, as on the watch.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

async function run(ms) {
  for (let t = 0; t < ms; t += 100) {
    mock.timers.tick(100)
    await settle()
  }
}

// A fresh page, opened, its requests answered by `relay(method, params)`. Nothing it does may
// throw (its handlers would swallow it: see guard() in the page).
async function openPage(t, relay) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  errors.length = 0
  Object.assign(mic, { starts: 0, overlaps: 0, on: false })
  t.after(() => {
    mock.timers.reset()
    assert.deepEqual(errors, [])
  })
  let page = null
  globalThis.Page = (p) => {
    page = p
  }
  await import(`../../watch-app/page/home/index.js?${Math.random()}`)
  page.request = (msg) => relay(msg.method, msg.params)
  const first = ui.widgets.length
  page.onInit()
  page.build()
  await settle()
  page.screen = () =>
    ui.widgets
      .slice(first)
      .filter((w) => w.type === 'TEXT' && w.props.visible !== false && w.props.text)
      .map((w) => w.props.text)
  return page
}

const phoneIdle = () => Promise.resolve({ version: -1, title: '' })

test('a song on the phone whose lyrics turn out not to exist says so, instead of "Loading lyrics…" for good', async (t) => {
  const page = await openPage(t, (method) =>
    method === 'lyrics'
      ? Promise.resolve({ ok: true, song: { id: 'wonderwall' }, lyrics: { version: 'n1', kind: 'none', lines: [] }, words: { status: 'unavailable' } })
      : phoneIdle(),
  )
  page.onCall({ method: 'phone', params: { ...SONG, version: 4, playing: true, positionMs: 1000 } })
  assert.ok(page.screen().includes('Loading lyrics…'), 'loading, at first')
  await settle()
  assert.ok(!page.screen().includes('Loading lyrics…'), page.screen().join(' | '))
  assert.ok(page.screen().includes('No synced lyrics for this song'))
})

test('a minute paused on the phone, the mic comes back on by itself, with no word from the phone', async (t) => {
  let reachable = true
  const page = await openPage(t, (method) =>
    method === 'lyrics' ? Promise.resolve(SYNCED) : reachable ? phoneIdle() : Promise.reject({ code: 2 }),
  )
  page.onCall({ method: 'phone', params: { ...SONG, version: 4, playing: true, positionMs: 1000 } })
  await settle()
  page.onCall({ method: 'phone', params: { ...SONG, version: 5, playing: false, positionMs: 3000 } })
  await settle()
  const starts = mic.starts
  assert.equal(mic.on, false, 'the mic is off while the phone is the clock')
  reachable = false // and the phone's link drops: nothing more comes from it
  await run(75_000)
  assert.ok(mic.starts > starts, 'listening to the room again')
  assert.ok(page.screen().includes('Listening…'))
})

test('leaving earphones mode never starts the mic over a take still recording', async (t) => {
  const page = await openPage(t, (method) => (method === 'lyrics' ? Promise.resolve(SYNCED) : phoneIdle()))
  // the recording isn't readable while it is made: the page goes on to takes
  for (let ms = 0; ms < 20_000 && !(mic.starts >= 2 && mic.on); ms += 100) await run(100)
  assert.ok(mic.starts >= 2 && mic.on, 'a take is recording')
  page.onCall({ method: 'phone', params: { ...SONG, version: 4, playing: true, positionMs: 1000 } })
  await settle()
  page.onCall({ method: 'phone', params: { version: 5, title: '', playing: false, positionMs: 0 } }) // the player is gone
  await settle()
  await run(12_000) // that take ends (5 s, and up to 2.5 s to see it came back empty), the next starts
  assert.equal(mic.overlaps, 0, 'the one recorder was never started twice')
  assert.ok(mic.starts >= 3, 'and the takes carry on')
})

test('the phone taking over and letting go while the opening probe winds down never starts the mic twice', async (t) => {
  const page = await openPage(t, (method) => (method === 'lyrics' ? Promise.resolve(SYNCED) : phoneIdle()))
  await run(4700) // the probe has given up on reading while recording, and waits for its file to settle
  page.onCall({ method: 'phone', params: { ...SONG, version: 4, playing: true, positionMs: 1000 } })
  await run(500)
  page.onCall({ method: 'phone', params: { version: 5, title: '', playing: false, positionMs: 0 } }) // the player closed
  await run(12_000)
  assert.equal(mic.overlaps, 0, 'the one recorder was never started twice')
  assert.ok(mic.on || mic.starts >= 3, 'and listening carries on')
})
