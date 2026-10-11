// Replays a recorded-looking listening session through the watch's real session logic,
// against a running server, in simulated time, and measures what the person would see.
//
//   node tests/sim/simulate.mjs --stream /tmp/stream.json --server http://127.0.0.1:8790
//
// The stream comes from server/scripts/sim_stream.py: SILK packets as the watch's
// recorder would write them while a song plays, stops, resumes and skips, with the true
// song position of each packet. What is modelled here, because it can't be measured
// without the watch:
//   - the recorder's file becomes readable in bursts (--flush-ms), polled every 100 ms
//     (lib/live.js), and packet times are estimated the way live.js does;
//   - the phone link: --ble-kbps of payload each way plus --base-ms per request.
//   - or, with --takes, a recorder that only hands over a recording when it stops (a T-Rex 3
//     on firmware 6.4.16.3): takes back to back, as page/home/index.js records them, each
//     losing its first --take-start-ms to the mic starting, handed over --settle-ms after
//     stop() and read in --read-ms (its packets, then the request on its way); the next starts
//     --take-gap-ms after stop(), or once the take is read if that is later.
// The server is real: Shazam, the reference audio, fast re-sync and word timings.
import { readFileSync } from 'node:fs'
import * as session from '../../watch-app/lib/session.js'
import * as clock from '../../watch-app/lib/clock.js'
import * as sync from '../../watch-app/lib/sync.js'
import { silkLevel } from '../../watch-app/lib/silk.js'
import { createPacketStream, feed, windowBytes } from '../../watch-app/lib/stream.js'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? acc.concat([[a.slice(2), all[i + 1]]]) : acc), []),
)
const STREAM = JSON.parse(readFileSync(args.stream))
const SERVER = args.server || 'http://127.0.0.1:8790'
const FLUSH_MS = Number(args['flush-ms'] || 240)
const POLL_MS = 100
const BLE_BYTES_PER_MS = Number(args['ble-kbps'] || 4) // KB/s == bytes/ms
const BASE_MS = Number(args['base-ms'] || 700)
const T0 = 1_000_000 // watch time when recording starts
const TAKES = args.takes !== undefined
const TAKE_START_MS = Number(args['take-start-ms'] || 320)
const SETTLE_MS = Number(args['settle-ms'] || 105) // STOP (~5 ms), then the size read every 25 ms until it holds
const READ_MS = Number(args['read-ms'] || 600) // T-Rex 3, 11 Oct 2026: 0.1-0.6 s for the packets, ~0.5 s more until the request left
const TAKE_GAP_MS = Math.max(Number(args['take-gap-ms'] || 650), SETTLE_MS + READ_MS) // stop -> next start
const LINE_LEAD = 300
const WORD_LEAD = 40

const packets = STREAM.packets.map((b) => Uint8Array.from(Buffer.from(b, 'base64')))
const truth = STREAM.truth
const songOf = STREAM.song || truth.map((x) => (x === null ? null : 'only'))
const s = session.createSession()
const stream = createPacketStream(400)
const events = [] // [time, fn]
const log = []
let origin = Infinity
let visible = 0
let lines = null

// Simulated-time event queue, kept sorted (binary insertion; ties keep insertion order).
function at(t, fn) {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid][0] <= t) lo = mid + 1
    else hi = mid
  }
  events.splice(lo, 0, [t, fn])
}

function truthAt(t) {
  const i = Math.floor((t - T0) / 60)
  if (i < 0 || i >= truth.length || truth[i] === null) return null
  const next = truth[i + 1]
  const rate = next !== undefined && next !== null && Math.abs(next - truth[i] - 60) < 30 ? (next - truth[i]) / 60 : 1
  return truth[i] + ((t - T0) - i * 60) * rate
}

// Packets [from, to] framed as the recorder writes them.
function framedBytes(from, to) {
  const parts = []
  for (let i = from; i <= to; i++) {
    const p = packets[i]
    const framed = new Uint8Array(8 + p.length)
    framed[3] = p.length & 255
    framed[2] = (p.length >> 8) & 255
    framed.set(p, 8)
    parts.push(framed)
  }
  return Buffer.concat(parts)
}

async function send(req, now) {
  let body
  let path
  if (req.kind === 'identify') {
    const w = TAKES ? { bytes: framedBytes(req.from, req.to), packets: req.to - req.from + 1 } : windowBytes(stream, req.from, req.to + 1)
    body = { audio: Buffer.from(w.bytes).toString('base64'), clipMs: w.packets * 60, purpose: req.purpose, song: req.song,
      expectMs: req.expectMs === null ? null : Math.round(req.expectMs), known: req.known, client: { source: 'simulate' } }
    path = '/identify'
  } else {
    body = { song: req.song, known: req.known }
    path = '/lyrics'
  }
  const payload = JSON.stringify(body)
  const started = Date.now()
  const res = await fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).then((r) => r.json())
  const serverMs = Date.now() - started
  const answer = JSON.stringify(res)
  const trip = BASE_MS + payload.length / BLE_BYTES_PER_MS + serverMs + answer.length / BLE_BYTES_PER_MS
  const tr = req.startAt !== null && req.startAt !== undefined ? truthAt(req.startAt) : null
  const matchErr = res.ok && res.match && tr !== null ? Math.round(res.match.offsetMs - tr) : null
  log.push({ t: now, type: 'request', purpose: req.purpose, kind: req.kind, bytes: payload.length, tripMs: Math.round(trip), method: res.match && res.match.method, ok: res.ok, reason: res.reason, matchErr })
  at(now + trip, () => {
    session.onResponse(s, req, res, now + trip)
    drain(now + trip)
  })
}

const pending = []
function drain(now) {
  for (const e of session.takeEvents(s)) {
    log.push({ t: now, type: e.type, packet: e.packet, deltaMs: e.deltaMs, at: e.at, r: e.r, lagMs: e.lagMs })
    if (e.type === 'song' || e.type === 'lyrics') lines = s.song ? s.song.lines : null
  }
  const next = session.decide(s, now)
  if (next) pending.push([next, now])
}

const total = packets.length
// Takes mode: what page/home/index.js does with each finished take.
function takeMs(now) {
  const kind = session.takeKind(s, now, 2000)
  return kind === 'find' ? 3500 : kind === 'place' ? 3000 : 2000
}
let takes = 0
function startTake(start) {
  if (start > T0 + total * 60) return
  const len = takeMs(start)
  const stop = start + len
  takes += 1
  at(stop + SETTLE_MS + READ_MS, () => {
    const first = Math.max(0, Math.ceil((start + TAKE_START_MS - T0) / 60))
    const last = Math.min(total - 1, Math.floor((stop - T0) / 60) - 1)
    const now = stop + SETTLE_MS + READ_MS
    for (let i = first; i <= last; i++) {
      const level = silkLevel(packets[i], 0, packets[i].length)
      if (level) session.onPacket(s, i, level.gain, T0 + i * 60, now)
    }
    if (args['trace-takes']) {
      let g = 0
      for (let i = first; i <= last; i++) { const l = silkLevel(packets[i], 0, packets[i].length); g += l ? l.gain : 0 }
      log.push({ t: now, type: 'take', first, last, gain: Math.round(g / Math.max(1, last - first + 1)) })
    }
    if (last >= first) {
      const req = session.takeRequest(s, first, last, T0 + first * 60, now)
      if (req) pending.push([req, now])
    }
    drain(now)
  })
  at(stop + TAKE_GAP_MS, () => startTake(stop + TAKE_GAP_MS))
}
if (TAKES) {
  s.mode = 'takes'
  startTake(T0)
}

// packet readability: written in bursts every FLUSH_MS, seen at the next 100 ms poll
for (let poll = T0 + POLL_MS; !TAKES && poll <= T0 + total * 60 + 2000; poll += POLL_MS) {
  at(poll, () => {
    const readableUpTo = Math.min(total, Math.floor(Math.floor((poll - T0) / FLUSH_MS) * FLUSH_MS / 60))
    while (visible < readableUpTo) {
      const p = packets[visible]
      const framed = new Uint8Array(8 + p.length)
      framed[3] = p.length & 255
      framed[2] = (p.length >> 8) & 255
      framed.set(p, 8)
      feed(stream, framed, () => {})
      visible += 1
    }
    if (visible) origin = Math.min(origin, poll - 60 * visible)
  })
}
// feed the session as packets become visible (separate pass keeps origin up to date first)
let fed = 0
for (let poll = T0 + POLL_MS; !TAKES && poll <= T0 + total * 60 + 2000; poll += POLL_MS) {
  at(poll + 0.5, () => {
    while (fed < visible) {
      const level = silkLevel(packets[fed], 0, packets[fed].length)
      if (level) {
        const req = session.onPacket(s, fed, level.gain, origin + 60 * fed, poll)
        if (req) pending.push([req, poll])
      }
      fed += 1
    }
    drain(poll)
  })
}
for (let t = T0; t <= T0 + total * 60 + 2000; t += 200) {
  at(t + 0.7, () => {
    const req = session.onTick(s, t)
    if (req) pending.push([req, t])
    drain(t)
  })
}

// ---- run, sampling what the screen would show every 50 ms ---------------------------
const samples = []
for (let t = T0; t <= T0 + total * 60; t += 50) at(t + 0.9, () => sample(t))

const matchTrace = []
let lastChecks = 0
// The song that is playing at t, or during a silence the one that was playing before it.
function songAtTime(t) {
  let i = Math.min(songOf.length - 1, Math.floor((t - T0) / 60))
  while (i >= 0 && songOf[i] === null) i -= 1
  return i >= 0 ? songOf[i] : null
}

function sample(t) {
  if (s.match && s.match.checks !== lastChecks) {
    lastChecks = s.match.checks
    matchTrace.push([t, s.match.last])
  }
  const tr = truthAt(t)
  const pos = s.song && clock.isKnown(s.clock) ? clock.songAt(s.clock, t) : null
  const same = !STREAM.song || (s.song && s.song.id === songAtTime(t))
  samples.push({ t, truth: tr, pos: same ? pos : null, paused: clock.isPaused(s.clock), known: pos !== null && !!same })
}

while (events.length) {
  const [, fn] = events.shift()
  fn()
  while (pending.length) {
    const [req, now] = pending.shift()
    await send(req, now)
  }
}

// ---- report ------------------------------------------------------------------------
const fmt = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(2) + ' s')
const segments = []
for (let i = 0; i < truth.length; i++) {
  const kind = truth[i] === null ? 'silence' : 'play'
  const prev = segments[segments.length - 1]
  const lastSong = segments.filter((x) => x.kind === 'play').map((x) => x.song).pop()
  const newSong = kind === 'play' && lastSong !== undefined && lastSong !== songOf[i]
  const jump = prev && prev.kind === 'play' && kind === 'play' && (newSong || Math.abs(truth[i] - truth[i - 1] - 60) > 200)
  if (!prev || prev.kind !== kind || jump) segments.push({ kind, start: T0 + i * 60, from: truth[i], skip: !!jump && !newSong, song: songOf[i], newSong })
}
console.log(`script: ${STREAM.script}`)
console.log(`link model: ${BASE_MS} ms + ${BLE_BYTES_PER_MS} KB/s each way; ` +
  (TAKES ? `takes back to back (${takes}), ${TAKE_START_MS} ms lost at each start, ${TAKE_GAP_MS} ms from stop to start` : `recorder flushes every ${FLUSH_MS} ms`))
const firstSong = log.find((e) => e.type === 'song')
console.log(`identified after ${fmt(firstSong ? firstSong.t - T0 : null)}`)
for (let k = 1; k < segments.length; k++) {
  const seg = segments[k]
  const after = (types) => log.find((e) => types.includes(e.type) && e.t >= seg.start)
  if (seg.kind === 'silence') {
    const e = after(['pause'])
    const frozen = samples.find((x) => x.t >= (e ? e.t : seg.start) + 100)
    const shouldBe = truthAt(seg.start - 60)
    console.log(`music stops at ${fmt(seg.start - T0)}: pause seen after ${fmt(e ? e.t - seg.start : null)}; lyrics frozen at ${frozen && frozen.pos !== null ? (frozen.pos / 1000).toFixed(2) : '—'} s (stopped at ${(shouldBe / 1000).toFixed(2)} s, error ${frozen && frozen.pos !== null ? Math.round(frozen.pos - shouldBe) : '—'} ms)`)
  } else if (seg.newSong) {
    const e = log.find((x) => x.type === 'song' && x.t >= seg.start)
    const ended = log.find((x) => (x.type === 'ended' || x.type === 'lost') && x.t >= seg.start - 8000)
    console.log(`next song starts at ${fmt(seg.start - T0)}: previous ${ended ? ended.type + ' at ' + fmt(ended.t - T0) : 'never ended'}; new song shown after ${fmt(e ? e.t - seg.start : null)}`)
  } else if (seg.skip) {
    const e = after(['seek', 'song'])
    console.log(`skip to ${fmt(seg.from)} at ${fmt(seg.start - T0)}: followed after ${fmt(e ? e.t - seg.start : null)}`)
  } else {
    const e = after(['resume'])
    const ok = log.find((x) => x.type === 'request' && x.purpose === 'resume' && x.t >= seg.start)
    const x = samples.find((y) => e && y.t >= e.t + 50)
    console.log(`music back at ${fmt(seg.start - T0)}: resumed after ${fmt(e ? e.t - seg.start : null)}, error then ${x && x.truth !== null ? Math.round(x.pos - x.truth) + ' ms' : '—'}; server check ${ok ? ok.method || ok.reason : '—'} (${ok ? ok.tripMs + ' ms round trip' : ''})`)
  }
}
const playing = samples.filter((x) => x.truth !== null && x.known && !x.paused)
const err = playing.map((x) => Math.abs(x.pos - x.truth)).sort((a, b) => a - b)
const q = (p) => err[Math.min(err.length - 1, Math.floor(p * err.length))]
console.log(`while playing (after identification): |lyrics - music| median ${Math.round(q(0.5))} ms, p90 ${Math.round(q(0.9))} ms; within 100 ms ${Math.round((err.filter((e) => e < 100).length / err.length) * 100)}% of the time`)
const signed = playing.map((x) => x.pos - x.truth).filter((d) => Math.abs(d) < 1000).sort((a, b) => a - b)
console.log(`  signed median (lyrics ahead +, behind -): ${Math.round(signed[Math.floor(signed.length / 2)])} ms over ${signed.length} samples within 1 s`)
const silentRunning = samples.filter((x) => x.truth === null && x.known && !x.paused).length
console.log(`time the lyrics ran on during silence: ${fmt(silentRunning * 50)}`)
if (lines) {
  let same = 0
  let n = 0
  for (const x of playing) {
    const a = sync.displayAt(lines, x.pos, LINE_LEAD, WORD_LEAD)
    const b = sync.displayAt(lines, x.truth, LINE_LEAD, WORD_LEAD)
    if (b.line < 0 || !lines[b.line][2]) continue
    n += 1
    if (a.line === b.line && a.word === b.word) same += 1
  }
  console.log(`word on screen = word being sung: ${n ? Math.round((same / n) * 100) : '—'}% of word-timed time (${lines.filter((l) => l[2]).length}/${lines.length} lines word-timed)`)
}
const mism = log.filter((e) => e.type === 'mismatch')
console.log(`skips noticed from the loudness track: ${mism.length}${mism.length ? ' (at ' + mism.map((e) => fmt(e.t - T0)).join(', ') + ')' : ''}`)
if (args['trace-error']) {
  const rows = []
  for (const x of samples) if ((x.t - T0) % 1000 === 0) rows.push(`${((x.t - T0) / 1000).toFixed(0)}:${x.truth === null ? 'sil' : x.pos === null ? '-' : Math.round(x.pos - x.truth)}${x.paused ? 'P' : ''}`)
  console.log('error over time (s:ms, P = paused):')
  console.log(rows.join(' '))
  console.log('events:', log.filter((e) => e.type !== 'request').map((e) => `${((e.t - T0) / 1000).toFixed(1)}:${e.type}`).join(' '))
}
if (args['trace-match']) {
  console.log('loudness-track correlation (time: r):')
  console.log(matchTrace.map(([t, r]) => `${((t - T0) / 1000).toFixed(1)}:${r === null ? '-' : r.toFixed(2)}`).join(' '))
}
if (args['trace-takes']) {
  const from = Number(args['trace-from'] || 0) * 1000 + T0
  const to = Number(args['trace-to'] || 1e9) * 1000 + T0
  for (const e of log) {
    if (e.t < from || e.t > to) continue
    const ts = ((e.t - T0) / 1000).toFixed(2)
    if (e.type === 'take') console.log(`${ts} take packets ${((e.first * 60) / 1000).toFixed(2)}..${(((e.last + 1) * 60) / 1000).toFixed(2)} s gain ${e.gain}`)
    else if (e.type !== 'request') console.log(`${ts} ${e.type}${e.packet !== undefined ? ' packet@' + ((e.packet * 60) / 1000).toFixed(2) + 's' : ''}${e.at !== undefined ? ' at ' + ((e.at - T0) / 1000).toFixed(2) + 's' : ''}${e.r !== undefined ? ' r ' + e.r + ' lag ' + e.lagMs : ''}`)
    else console.log(`${ts} request ${e.purpose} ${e.method || e.reason || ''}`)
  }
}
const reqs = log.filter((e) => e.type === 'request')
console.log(`requests: ${reqs.length} (${reqs.map((r) => r.purpose + (r.method ? ':' + r.method : r.ok === false ? ':' + r.reason : '') + (r.matchErr !== null && r.matchErr !== undefined ? ' ' + r.matchErr + 'ms' : '')).join(', ')})`)
