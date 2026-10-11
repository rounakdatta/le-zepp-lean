// The listening session: what it asks the server, and how it reacts to the music stopping,
// coming back, going quiet on purpose, skipping and ending. Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as session from '../../watch-app/lib/session.js'
import * as clock from '../../watch-app/lib/clock.js'
import { decodeEnvelope } from '../../watch-app/lib/envelope.js'

const MS = session.PACKET_MS
const LOUD = 28
const QUIET = 15

// Feeds packets [from, to) with a gain function; returns the requests the session made.
function feed(s, from, to, gainAt, t0 = 0) {
  const out = []
  for (let i = from; i < to; i++) {
    const at = t0 + i * MS
    const req = session.onPacket(s, i, gainAt(i), at, at + MS)
    if (req) out.push(req)
  }
  return out
}

const LINES = [
  [10_000, 'Today is gonna be the day', [10_000, 10_400, 10_700, 11_100, 11_400, 11_700], 12_500],
  [14_000, "That they're gonna throw it back to you", null, null],
]

function found(offsetMs, extra = {}) {
  return {
    ok: true,
    song: { id: 'wonderwall', title: 'Wonderwall', artist: 'Oasis', durationMs: 258_000 },
    match: { offsetMs, skew: 0, method: 'shazam' },
    lyrics: { version: 'v1', kind: 'synced', lines: LINES },
    words: { status: 'ready' },
    sync: { fast: true }, // the server has the song's audio: short windows are enough
    ...extra,
  }
}

// A session that knows the song: identified from packets 0..83 at song position 5000.
function following() {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000), 84 * MS + 1500)
  session.takeEvents(s)
  return s
}

test('silence is not sent anywhere; 5 s of music is sent to be identified', () => {
  const s = session.createSession()
  assert.deepEqual(feed(s, 0, 200, () => QUIET), [], 'no requests while the room is quiet')
  const reqs = feed(s, 200, 284, () => LOUD)
  assert.equal(reqs.length, 1)
  assert.equal(reqs[0].purpose, 'find')
  assert.equal(reqs[0].to - reqs[0].from + 1, session.IDENTIFY_PACKETS)
})

test('a match starts the song, and the clock places the start of the audio, not its arrival', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000), 7000) // answered 2 s after the window ended
  const events = session.takeEvents(s).map((e) => e.type)
  assert.ok(events.includes('song') && events.includes('lyrics'))
  // the window began at watch time 0, at song 5000: at watch time 7000 the song is at 12000
  assert.equal(session.position(s, 7000), 12_000)
  assert.equal(s.song.lines[0][2].length, 6, 'word timings kept for the line that has them')
  assert.equal(s.song.lines[1][2], null)
})

test('the music stopping freezes the lyrics on the packet it stopped, and nothing is sent while paused', () => {
  const s = following()
  // music stops at packet 200 (watch time 12,000 -> song 17,000)
  const reqs = feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const events = session.takeEvents(s)
  const pause = events.find((e) => e.type === 'pause')
  assert.ok(pause, 'a pause was detected')
  assert.equal(pause.packet, 200, 'backdated to the first quiet packet')
  // frozen where it stopped, less the room's ringing: two packets before the first quiet one
  assert.equal(session.position(s, 400 * MS), 17_000 - 2 * MS)
  assert.ok(reqs.every((r) => r.from < 200), 'no audio sent from the silence')
})

test('the music coming back resumes from the same place at once, then asks the server to confirm', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const reqs = feed(s, 400, 460, () => LOUD)
  const resume = session.takeEvents(s).find((e) => e.type === 'resume')
  assert.ok(resume)
  assert.equal(resume.packet, 400)
  // 240 ms after the music came back the lyrics have moved on by exactly 240 ms
  assert.equal(session.position(s, 400 * MS + 240), 16_880 + 240)
  const check = reqs.find((r) => r.purpose === 'resume')
  assert.ok(check, 'a resume check was sent')
  assert.equal(check.from, 400)
  assert.equal(check.expectMs, 16_880, 'the server is told where we think the music resumed')
})

test('a "resume" that was only someone talking is undone, and talking on keeps it undone', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const reqs = feed(s, 400, 440, () => 24) // talking: loud enough to look like music
  const check = reqs.find((r) => r.purpose === 'resume')
  session.onResponse(s, check, { ok: false, reason: 'no_match' }, 440 * MS)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'resume_rejected'))
  const frozen = session.position(s, 440 * MS)
  // the talking goes on: no new "resume", the lyrics stay where the music stopped, and the
  // server is asked again with 5 s, then less and less often
  const asks = feed(s, 440, 900, () => 24).filter((r) => r.purpose === 'resume')
  assert.ok(!session.takeEvents(s).some((e) => e.type === 'resume'))
  assert.equal(session.position(s, 900 * MS), frozen)
  assert.ok(asks.length >= 1)
  asks.forEach((a) => assert.equal(a.to - a.from + 1, session.IDENTIFY_PACKETS))
  session.onResponse(s, asks[0], { ok: false, reason: 'no_match' }, 900 * MS)
  const sooner = s.doubt.due
  assert.ok(s.doubt.wait > session.IDENTIFY_PACKETS, 'backing off')
  assert.ok(sooner > 900, 'not again at once')
})

test("with the song's loudness track, a quiet passage in the song is not a pause", () => {
  const s = following()
  // The song (as the server heard it) is loud everywhere except 20-30 s, where it goes quiet.
  const step = 60
  const gains = []
  for (let t = 0; t < 60_000; t += step) gains.push(t >= 20_000 && t < 30_000 ? 8 : 40)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const data = gains.map((g) => alphabet[g]).join('')
  session.onResponse(s, { id: 99, kind: 'lyrics' }, { song: { id: 'wonderwall' }, envelope: { version: 'e1', startMs: 0, stepMs: step, data } }, 84 * MS)
  // Song position = 5000 + watch time. The room is quiet exactly while the song is quiet.
  const songAt = (i) => 5000 + i * MS
  feed(s, 84, 700, (i) => (songAt(i) >= 20_000 && songAt(i) < 30_000 ? QUIET : LOUD))
  const events = session.takeEvents(s)
  assert.ok(!events.some((e) => e.type === 'pause'), 'no pause during the quiet passage')
  assert.ok(s.stats.quietForgiven > 100, 'and it knew why: quiet packets were expected')
  // Now the music really stops while the song should be loud.
  feed(s, 700, 760, () => QUIET)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'pause'), 'a real stop is still caught')
})

test('re-syncs come 10 s after the first match, then more slowly, while playing', () => {
  const s = following()
  const reqs = feed(s, 84, 84 + Math.round(45_000 / MS), () => LOUD)
  const syncs = reqs.filter((r) => r.purpose === 'sync')
  assert.equal(syncs.length, 1, 'one request in flight at a time')
  assert.ok(syncs[0].startAt >= 84 * MS + 1500 + 10_000 - 3000, 'not before 10 s')
  session.onResponse(s, syncs[0], found(syncs[0].expectMs + 20), syncs[0].sentAt + 1500)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'synced'))
  // the next ones space out: +10 s, +20 s, then every 30 s
  assert.ok(s.nextVerifyAt - syncs[0].sentAt >= 10_000)
  s.matches = 10
  session.onResponse(s, syncs[0], found(syncs[0].expectMs + 20), syncs[0].sentAt + 1500)
  assert.ok(s.nextVerifyAt - syncs[0].sentAt >= 30_000)
})

test('a skip in the music is followed: the clock jumps to where the server says', () => {
  const s = following()
  const reqs = feed(s, 84, 84 + Math.round(20_000 / MS), () => LOUD)
  const sync = reqs.find((r) => r.purpose === 'sync')
  session.onResponse(s, sync, found(sync.expectMs + 60_000), sync.sentAt + 1000)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'seek'))
  assert.equal(Math.round(session.position(s, sync.startAt)), Math.round(sync.expectMs + 60_000))
})

test('word timings still being computed are fetched when the server expects them ready', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000, { lyrics: { version: 'v0', kind: 'synced', lines: [[10_000, 'Today is gonna be the day']] }, words: { status: 'pending', etaMs: 9000 } }), 6000)
  assert.equal(s.nextLyricsAt, 15_000)
  assert.equal(session.onTick(s, 14_000), null)
  const poll = session.onTick(s, 15_000)
  assert.equal(poll.kind, 'lyrics')
  assert.deepEqual(poll.known, { lyrics: 'v0', envelope: null })
  session.onResponse(s, poll, { song: { id: 'wonderwall' }, lyrics: { version: 'v1', kind: 'synced', lines: LINES }, words: { status: 'ready' } }, 15_500)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'lyrics' && e.words === 1))
  assert.equal(s.nextLyricsAt, Infinity)
})

test('the same lyrics version is not re-applied (nothing re-draws on every re-sync)', () => {
  const s = following()
  const reqs = feed(s, 84, 84 + Math.round(15_000 / MS), () => LOUD)
  const sync = reqs.find((r) => r.purpose === 'sync')
  const res = found(sync.expectMs)
  delete res.lyrics // the server leaves them out when `known` matches
  session.onResponse(s, sync, res, sync.sentAt + 1000)
  assert.ok(!session.takeEvents(s).some((e) => e.type === 'lyrics'))
  assert.equal(s.song.lines.length, 2, 'the lyrics we had are kept')
})

test('the song ending starts the search for the next one', () => {
  const s = following()
  // durationMs 258,000; position = 5000 + watch time
  session.onTick(s, 258_000 - 5000 + 3000)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'ended'))
  assert.equal(s.song, null)
  const reqs = feed(s, 5000, 5084, () => LOUD, 0)
  assert.ok(reqs.some((r) => r.purpose === 'find'))
})

test('a phone that does not answer backs off instead of hammering the link', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, { ok: false, reason: 'phone', message: 'Bluetooth disconnected' }, 6000)
  assert.equal(session.decide(s, 7000), null)
  assert.ok(s.holdUntil >= 12_000)
})

test('a line whose word list does not match its text is shown line by line', () => {
  const lines = session.normalizeLines([[1000, 'two words', [1000, 1200, 1400]], [500, 'first', [500]]])
  assert.equal(lines[0][1], 'first', 'sorted by time')
  assert.deepEqual(lines[0][2], [500])
  assert.equal(lines[1][2], null)
})

// Takes mode: a take's packets (watch time t0 on) go through onPacket, then takeRequest.
function take(s, from, to, gainAt, t0, now) {
  for (let i = from; i <= to; i++) session.onPacket(s, i, gainAt(i), t0 + (i - from) * MS, now)
  return session.takeRequest(s, from, to, t0, now)
}

test('a match while paused means the music is playing again', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  assert.ok(clock.isPaused(s.clock))
  s.mode = 'takes'
  // SELECT while paused: the next take, recorded from watch time 30,000, matched at song 40,000
  session.checkNow(s, 29_000)
  const req = session.takeRequest(s, 500, 544, 30_000, 33_000)
  assert.equal(req.purpose, 'resume')
  session.onResponse(s, req, found(40_000), 34_000)
  assert.ok(!clock.isPaused(s.clock))
  assert.equal(Math.round(session.position(s, 34_000)), 44_000)
})

test('in takes mode, a take that finishes while a find is out never replaces it', () => {
  const s = session.createSession()
  s.mode = 'takes'
  const find = take(s, 0, 77, () => LOUD, 0, 5000)
  assert.equal(find.purpose, 'find')
  // the answer is slow (lyrics took 6 s): two more takes finish meanwhile
  assert.equal(take(s, 87, 114, () => LOUD, 5_500, 7_500), null)
  assert.equal(s.takeSkip, 'busy')
  assert.equal(take(s, 124, 151, () => LOUD, 7_700, 9_700), null)
  session.onResponse(s, find, found(5000), 11_000)
  assert.equal(s.song && s.song.id, 'wonderwall', 'the slow answer still counts')
})

test('in takes mode, a quiet take is not sent while looking for a song', () => {
  const s = session.createSession()
  s.mode = 'takes'
  assert.equal(take(s, 0, 77, () => QUIET, 0, 5000), null)
  assert.equal(s.takeSkip, 'quiet')
  assert.equal(s.stats.requests, 0)
})

test('in takes mode, the music stopping is noticed from the take itself, without the server', () => {
  const s = following()
  s.mode = 'takes'
  s.nextVerifyAt = Infinity
  // a 2 s take (28 packets) in which the music stops after 10 packets
  const req = take(s, 300, 327, (i) => (i < 310 ? LOUD : QUIET), 300 * MS, 330 * MS)
  assert.equal(req, null, 'nothing to ask: the room says it all')
  assert.ok(clock.isPaused(s.clock))
  assert.ok(session.takeEvents(s).some((e) => e.type === 'pause'))
})

test('in takes mode, while following, takes go to the server only when a re-sync is due', () => {
  const s = following()
  s.mode = 'takes'
  s.nextVerifyAt = 400 * MS
  assert.equal(session.wantsAudio(s, 300 * MS), false, 'the page records 2 s takes')
  assert.equal(take(s, 300, 327, () => LOUD, 300 * MS, 330 * MS), null, 'not due yet: loudness only')
  assert.equal(session.wantsAudio(s, 400 * MS), true, 'due: the page makes the next take long enough to place')
  assert.equal(take(s, 400, 427, () => LOUD, 400 * MS, 430 * MS), null, 'a 2 s take is too short to place')
  const sync = take(s, 440, 484, () => LOUD, 440 * MS, 490 * MS)
  assert.equal(sync && sync.purpose, 'sync')
})

// A loudness track that moves (beats, phrases), and the room hearing it a little quieter.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const trackGain = (k) => 28 + Math.round(5 * Math.sin(k / 2.3) + 3 * Math.sin(k / 7.1 + 1))
const TRACK = { startMs: 0, stepMs: MS, data: Array.from({ length: 6000 }, (_, k) => ALPHA[trackGain(k)]).join('') }
const roomAt = (songMs) => trackGain(Math.floor(songMs / MS)) - 1

// following(), the music stopping at packet 200, and the song's loudness track known.
function pausedWithTrack() {
  const s = following()
  s.song.envelope = decodeEnvelope(TRACK)
  const pos = (i) => session.position(s, i * MS)
  feed(s, 84, 200, (i) => roomAt(pos(i)))
  const stopped = session.position(s, 200 * MS)
  feed(s, 200, 400, () => QUIET)
  assert.ok(clock.isPaused(s.clock))
  s.mode = 'takes'
  return { s, stopped }
}

test('in takes mode, the song coming back where it stopped carries the lyrics on at once, from the right place', () => {
  const { s, stopped } = pausedWithTrack()
  const frozen = session.position(s, 30_000)
  // a 2 s take; the song comes back 6 packets in, at exactly where it stopped
  const req = take(s, 500, 527, (i) => (i < 506 ? QUIET : roomAt(stopped + (i - 506) * MS)), 30_000, 32_000)
  assert.equal(req, null, 'placed on the watch: nothing to wait for')
  assert.ok(!clock.isPaused(s.clock), 'running again')
  const ev = session.takeEvents(s).find((e) => e.type === 'resume')
  assert.equal(ev && ev.verified, 'local')
  // at the end of the take the lyrics are where the music is: the stop point + what played since
  assert.ok(Math.abs(session.position(s, 30_000 + 28 * MS) - (stopped + 22 * MS)) <= MS, 'within a packet')
  assert.ok(Math.abs(frozen - stopped) < 200, 'the freeze was right too')
  assert.equal(session.wantsAudio(s, 32_000), true, 'the next take goes to the server, in case it skipped while paused')
})

test('in takes mode, someone talking during a pause never moves the lyrics', () => {
  const { s } = pausedWithTrack()
  const frozen = session.position(s, 30_000)
  // talking: loud, but nothing like the song's loudness here
  const talk = (i) => 30 + ((i * 7919) % 9) - 4
  assert.equal(take(s, 500, 527, talk, 30_000, 32_000), null)
  assert.ok(clock.isPaused(s.clock), 'still frozen')
  assert.equal(session.wantsAudio(s, 32_000), true, 'the next take is long enough for the server to decide')
  const check = take(s, 537, 581, talk, 32_600, 35_500)
  assert.equal(check && check.purpose, 'resume', 'the server is asked')
  assert.ok(clock.isPaused(s.clock), 'and the lyrics wait for its answer')
  session.onResponse(s, check, { ok: false, reason: 'no_match' }, 36_000)
  assert.ok(clock.isPaused(s.clock), 'not the song: still frozen')
  assert.equal(Math.round(session.position(s, 40_000)), Math.round(frozen))
})

test('in takes mode, with no loudness track for the song the server decides a resume, and the lyrics wait for it', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  s.mode = 'takes'
  assert.equal(take(s, 500, 527, (i) => (i < 508 ? QUIET : LOUD), 30_000, 32_000), null)
  assert.ok(clock.isPaused(s.clock), 'sound alone does not move the lyrics')
  assert.equal(session.wantsAudio(s, 32_000), true)
  const req = take(s, 537, 581, () => LOUD, 32_600, 35_500)
  assert.equal(req && req.purpose, 'resume')
  session.onResponse(s, req, found(20_000), 37_000)
  assert.ok(!clock.isPaused(s.clock), 'the server placed it: running again')
  assert.equal(Math.round(session.position(s, 37_000)), 20_000 + 37_000 - 32_600)
})

test('music stopping in the last seconds of a song is the song ending: the next song is looked for', () => {
  const s = following()
  // position = 5000 + watch time; durationMs 258,000. Play to 255 s, then silence.
  const stopAt = Math.round((255_000 - 5000) / MS)
  feed(s, 84, stopAt + 40, (i) => (i < stopAt ? LOUD : QUIET))
  const events = session.takeEvents(s).map((e) => e.type)
  assert.ok(events.includes('ended'), 'ended, not paused')
  assert.ok(!events.includes('pause'))
  s.inflight = null // the last re-sync of the old song was never answered in this test
  const reqs = feed(s, stopAt + 40, stopAt + 40 + 90, () => LOUD)
  assert.ok(reqs.some((r) => r.purpose === 'find'), 'the next song is identified')
})

test('after a rejected resume the next check carries enough audio for Shazam to name a new song', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const first = feed(s, 400, 440, () => 30).find((r) => r.purpose === 'resume')
  assert.equal(first.to - first.from + 1, session.RESUME_PACKETS)
  session.onResponse(s, first, { ok: false, reason: 'no_match' }, 440 * MS)
  const second = feed(s, 440, 560, () => 36).find((r) => r.purpose === 'resume')
  assert.ok(second, 'the music goes on, so it is asked about again')
  assert.equal(second.to - second.from + 1, session.IDENTIFY_PACKETS)
  // it was another song: the server says so, and the session follows it
  session.onResponse(s, second, { ...found(30_000), song: { id: 'champagne', title: 'Champagne Supernova', durationMs: 450_000 } }, 600 * MS)
  assert.equal(s.song.id, 'champagne')
})

test('in takes mode, packets never leave a request in flight that nobody will send', () => {
  const s = following()
  s.mode = 'takes'
  s.song.words = { status: 'pending' }
  s.nextLyricsAt = 0 // a word poll is due
  const reqs = feed(s, 84, 170, () => LOUD)
  assert.deepEqual(reqs, [], 'packets in takes mode come from a finished take; the page sends the take itself')
  assert.equal(s.inflight, null)
  // the poll goes out with the next decision the page asks for
  const poll = session.decide(s, 10_000)
  assert.equal(poll && poll.kind, 'lyrics')
})

test('a song whose lyrics are still being looked up shows at once, and its lyrics follow', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000, { lyrics: { version: 'p1', kind: 'pending', lines: [] }, words: { status: 'pending' } }), 6000)
  assert.equal(s.song && s.song.kind, 'pending', 'the name is on screen; its lyrics are on the way')
  assert.equal(session.decide(s, 6500), null)
  const poll = session.decide(s, 7600)
  assert.equal(poll && poll.kind, 'lyrics', 'asked again after 1.5 s')
  session.onResponse(s, poll, { ok: true, song: { id: 'wonderwall' }, lyrics: { version: 'v1', kind: 'synced', lines: LINES }, words: { status: 'pending', etaMs: 15000 } }, 8000)
  assert.equal(s.song.kind, 'synced')
  assert.equal(s.song.lines.length, 2)
})

// ---- the phone's own player (the LeZeppLean helper, via the server) ----

const onPhone = (s, now, v) => session.onPhone(s, { version: v.version, title: 'Wonderwall', artist: 'Oasis', durationMs: 258_000, playing: true, positionMs: 0, speed: 1, songId: 'wonderwall', ...v }, now)

test('music on the phone is followed exactly: where it is, when it pauses, when it is dragged', () => {
  const s = session.createSession()
  assert.equal(onPhone(s, 10_000, { version: 1, positionMs: 30_000 }), true)
  assert.equal(s.source, 'phone')
  assert.equal(Math.round(session.position(s, 12_000)), 32_000, 'runs with the player')
  onPhone(s, 15_000, { version: 2, playing: false, positionMs: 35_000 })
  assert.equal(Math.round(session.position(s, 20_000)), 35_000, 'frozen where the player paused')
  onPhone(s, 21_000, { version: 3, positionMs: 35_000 })
  assert.equal(Math.round(session.position(s, 22_000)), 36_000)
  onPhone(s, 23_000, { version: 4, positionMs: 90_000 })
  assert.equal(Math.round(session.position(s, 23_500)), 90_500, 'dragged on the phone: followed')
  const types = session.takeEvents(s).map((e) => e.type)
  assert.deepEqual(types.filter((t) => t !== 'synced'), ['song', 'pause', 'resume', 'seek'])
})

test('a track the server is still working out shows at once; its lyrics are asked for once it is known', () => {
  const s = session.createSession()
  onPhone(s, 1000, { version: 1, songId: null, positionMs: 5000 })
  assert.equal(s.song.title, 'Wonderwall')
  assert.equal(session.decide(s, 1500), null, 'nothing to ask yet')
  onPhone(s, 2000, { version: 2, songId: 'wonderwall', positionMs: 6000 })
  const req = session.decide(s, 2100)
  assert.equal(req && req.kind, 'lyrics')
  assert.equal(req.song, 'wonderwall')
})

test('while the phone plays, the room changes nothing', () => {
  const s = session.createSession()
  onPhone(s, 0, { version: 1, positionMs: 30_000 })
  const reqs = feed(s, 0, 200, () => QUIET)
  assert.deepEqual(reqs, [], 'no requests from the mic')
  assert.ok(!clock.isPaused(s.clock), 'a quiet room does not pause music in earphones')
  s.mode = 'takes'
  assert.equal(session.takeRequest(s, 300, 383, 18_000, 23_000), null)
})

test('a new track on the phone is a new song; a minute paused, the room is listened to again', () => {
  const s = session.createSession()
  onPhone(s, 0, { version: 1, positionMs: 30_000 })
  onPhone(s, 5000, { version: 2, title: 'Champagne Supernova', songId: 'champagne', positionMs: 0 })
  assert.equal(s.song.title, 'Champagne Supernova')
  assert.equal(Math.round(session.position(s, 6000)), 1000)
  onPhone(s, 10_000, { version: 3, title: 'Champagne Supernova', songId: 'champagne', playing: false, positionMs: 5000 })
  session.onTick(s, 30_000)
  assert.equal(s.source, 'phone', 'a short pause: still the phone')
  session.onTick(s, 71_000)
  assert.equal(s.source, 'room')
  assert.equal(s.song, null)
})

// ---- review findings (2026-10-10): each of these failed before its fix ----

test('an answer about audio from before a pause does not un-pause the lyrics', () => {
  const s = following()
  // a re-sync goes out while the music still plays (its audio starts before the stop)...
  const sync = feed(s, 84, 300, () => LOUD).find((r) => r.purpose === 'sync')
  assert.ok(sync, 'a re-sync was in flight')
  // ...the music stops at packet 300...
  feed(s, 300, 360, () => QUIET)
  assert.ok(clock.isPaused(s.clock))
  const frozen = session.position(s, 360 * MS)
  // ...and its answer arrives after the pause: still paused, still frozen
  session.onResponse(s, sync, found(sync.expectMs + 10), 360 * MS)
  assert.ok(clock.isPaused(s.clock), 'still paused')
  assert.ok(Math.abs(session.position(s, 400 * MS) - frozen) < 20, 'still frozen')
})

test('a resume check the server cannot place does not freeze the lyrics for good', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const varying = (i) => 22 + ((i * 7) % 13) // music at 22-34, as on the real recordings
  const first = feed(s, 400, 440, varying).find((r) => r.purpose === 'resume')
  session.onResponse(s, first, { ok: false, reason: 'no_match' }, 440 * MS)
  assert.ok(clock.isPaused(s.clock), 'frozen back while unsure')
  // the music goes on: a longer check is sent, and when it is placed the lyrics carry on
  const later = feed(s, 440, 560, varying).filter((r) => r.purpose === 'resume')
  assert.ok(later.length >= 1, 'it asks again, with more audio')
  const second = later[0]
  assert.equal(second.to - second.from + 1, session.IDENTIFY_PACKETS)
  session.onResponse(s, second, found(40_000), 560 * MS)
  assert.ok(!clock.isPaused(s.clock), 'playing again')
})

test('a resume check that fails for a server reason keeps the lyrics running and tries again', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const check = feed(s, 400, 440, () => LOUD).find((r) => r.purpose === 'resume')
  session.onResponse(s, check, { ok: false, reason: 'recognizer_timeout' }, 440 * MS)
  assert.ok(!clock.isPaused(s.clock), 'a timeout says nothing about the music')
  const again = feed(s, 440, 520, () => LOUD).find((r) => r.purpose === 'resume')
  assert.ok(again, 'the check is retried')
})

test('loud talking during a pause cannot raise the bar above the music itself', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const check = feed(s, 400, 440, () => 40).find((r) => r.purpose === 'resume') // the wearer talking at the wrist
  session.onResponse(s, check, { ok: false, reason: 'no_match' }, 440 * MS)
  feed(s, 440, 500, () => QUIET)
  session.takeEvents(s) // drained: the talking's own provisional resume must not count
  const varying = (i) => 22 + ((i * 7) % 13) // the music again, at 22-34 as on the real recordings
  const reqs = feed(s, 500, 560, varying)
  assert.ok(session.takeEvents(s).some((e) => e.type === 'resume'), 'the music at its usual level resumes')
  assert.ok(reqs.some((r) => r.purpose === 'resume'), 'and is checked')
  assert.ok(s.act.musicLevel < 32, `the music level did not learn the talking (${s.act.musicLevel.toFixed(1)})`)
})

test('no window reaches back past what the recorder keeps, or past the music coming back', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  s.holdUntil = 400 * MS + 30_000 // the phone was unreachable for a while
  feed(s, 400, 800, () => LOUD)
  s.holdUntil = 0
  const req = session.decide(s, 800 * MS)
  assert.ok(req, 'a check goes out once the link is back')
  assert.ok(req.to - req.from + 1 <= session.MAX_WINDOW_PACKETS, `window of ${req.to - req.from + 1} packets`)
  assert.ok(req.from >= 400, 'and only from after the music came back')
})

test('an answer that arrives after the song ended does not bring it back', () => {
  const s = following()
  const sync = feed(s, 84, 84 + Math.round(15_000 / MS), () => LOUD).find((r) => r.purpose === 'sync')
  session.onTick(s, 258_000) // past the end of the song
  assert.equal(s.song, null)
  session.takeEvents(s)
  session.onResponse(s, sync, found(sync.expectMs), 258_100)
  assert.equal(s.song, null, 'still looking for the next song')
  assert.ok(!session.takeEvents(s).some((e) => e.type === 'song'))
})

test('every new song starts with quick re-syncs, not just the first one', () => {
  const s = following()
  s.matches = 7 // the first song has been followed for a while
  const sync = feed(s, 84, 84 + Math.round(15_000 / MS), () => LOUD).find((r) => r.purpose === 'sync')
  // the music is now another song
  session.onResponse(s, sync, { ...found(1000), song: { id: 'other', title: 'Other', durationMs: 200_000 } }, 20_000)
  assert.equal(s.song.id, 'other')
  assert.equal(s.nextVerifyAt, 20_000 + 10_000)
})

test('without fast re-sync on the server, re-syncs carry enough audio for Shazam', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000, { sync: { fast: false } }), 84 * MS + 1500)
  const sync = feed(s, 84, 84 + Math.round(15_000 / MS), () => LOUD).find((r) => r.purpose === 'sync')
  assert.equal(sync.to - sync.from + 1, session.IDENTIFY_PACKETS)
  session.onResponse(s, sync, found(sync.expectMs, { sync: { fast: true } }), sync.sentAt + 1000)
  const next = feed(s, sync.to + 1, sync.to + 1 + Math.round(15_000 / MS), () => LOUD).find((r) => r.purpose === 'sync')
  assert.equal(next.to - next.from + 1, session.VERIFY_PACKETS)
})

test('a "no" to an old re-check, arriving after the music really came back, changes nothing', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  // someone talks; the server says no; the lyrics freeze back; a 5 s re-check goes out...
  const first = feed(s, 400, 440, () => 30).find((r) => r.purpose === 'resume')
  session.onResponse(s, first, { ok: false, reason: 'no_match' }, 440 * MS)
  const recheck = feed(s, 440, 530, () => 30).find((r) => r.purpose === 'resume')
  assert.ok(recheck)
  // ...the room goes quiet, then the music really comes back and resumes...
  feed(s, 530, 560, () => QUIET)
  feed(s, 560, 600, () => 36)
  assert.ok(!clock.isPaused(s.clock), 'playing again')
  const before = session.position(s, 600 * MS)
  // ...and only now does the "no" about the talking arrive
  session.onResponse(s, recheck, { ok: false, reason: 'no_match' }, 600 * MS)
  assert.ok(!clock.isPaused(s.clock), 'still playing')
  assert.ok(Math.abs(session.position(s, 600 * MS) - before) < 1, 'and in the same place')
})

test('a doubtful resume confirmed only after the room went quiet again stays stopped at the quiet', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const first = feed(s, 400, 440, () => 30).find((r) => r.purpose === 'resume')
  session.onResponse(s, first, { ok: false, reason: 'no_match' }, 440 * MS)
  const recheck = feed(s, 440, 530, () => 30).find((r) => r.purpose === 'resume')
  feed(s, 530, 600, () => QUIET) // the music stops again while the re-check is in flight
  // the re-check comes back: it was the song after all (audio from before the new stop)
  session.onResponse(s, recheck, found(30_000), 600 * MS)
  assert.ok(clock.isPaused(s.clock), 'paused again: the room went quiet at packet 530')
  const at530 = session.position(s, 530 * MS)
  assert.ok(Math.abs(session.position(s, 700 * MS) - at530) < 2 * MS * 2, 'frozen at the second stop, not running on')
})

test('timeouts during a doubtful resume back off instead of re-sending at once', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const first = feed(s, 400, 440, () => 30).find((r) => r.purpose === 'resume')
  session.onResponse(s, first, { ok: false, reason: 'no_match' }, 440 * MS)
  let sent = 0
  for (let i = 440; i < 1040; i++) {
    const req = session.onPacket(s, i, 30, i * MS, i * MS + MS)
    if (req) {
      sent += 1
      session.onResponse(s, req, { ok: false, reason: 'recognizer_timeout' }, i * MS + MS) // instant answers
    }
  }
  assert.ok(sent <= 6, `${sent} re-checks in 36 s`)
})

test('a re-check after a timeout still carries 5 s when the server lacks the song audio', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000, { sync: { fast: false } }), 84 * MS + 1500)
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  const check = feed(s, 400, 500, () => LOUD).find((r) => r.purpose === 'resume')
  assert.equal(check.to - check.from + 1, session.IDENTIFY_PACKETS)
  session.onResponse(s, check, { ok: false, reason: 'recognizer_timeout' }, 500 * MS)
  const again = feed(s, 500, 700, () => LOUD).find((r) => r.purpose === 'resume')
  assert.ok(again, 'asked again after a fresh 5 s')
  assert.equal(again.to - again.from + 1, session.IDENTIFY_PACKETS)
})

test('words far off (the server is waiting to retry) are not polled for; re-syncs carry them', () => {
  const s = session.createSession()
  const [req] = feed(s, 0, 84, () => LOUD)
  session.onResponse(s, req, found(5000, { words: { status: 'pending', etaMs: 300_000 } }), 6000)
  assert.equal(s.nextLyricsAt, Infinity)
})

test('after talking during a pause, the music comes back without false pauses later', () => {
  // The review's scenario, over 40 seeds: music at random gains 22-34 for 18 s, a 6 s pause,
  // 10 s of talking at the wrist (mostly 40), 3 s quiet, then the music for two minutes. The
  // server answers truthfully 2.4 s after each request. Before the fix the room's floor
  // learned the first music packets (held back by the raised bar) and false pauses followed:
  // 51 over these seeds, up to 16 in one session.
  let falsePauses = 0
  for (let seed0 = 1; seed0 <= 40; seed0++) {
    let seed = seed0 * 7919
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const songAt = (i) => (i < 300 ? 5000 + i * MS : i < 617 ? null : 5000 + 300 * MS + (i - 617) * MS)
    const gainAt = (i) => (songAt(i) !== null ? 22 + Math.floor(rnd() * 13) : i >= 400 && i < 567 ? (rnd() < 0.7 ? 40 : 33) : 16)
    const s = session.createSession()
    const pending = []
    const send = (req, i) => {
      let res = {}
      if (req.kind === 'identify') {
        const p = songAt(req.from)
        res = p === null ? { ok: false, reason: 'no_match' } : { ...found(p), song: { id: 'wonderwall', title: 'W', durationMs: 400_000 } }
      }
      pending.push({ due: i + 40, req, res })
    }
    for (let i = 0; i < 2617; i++) {
      const at = i * MS
      while (pending.length && pending[0].due <= i) {
        const q = pending.shift()
        session.onResponse(s, q.req, q.res, at)
        const r = session.decide(s, at)
        if (r) send(r, i)
      }
      const r = session.onPacket(s, i, gainAt(i), at, at + MS)
      if (r) send(r, i)
      for (const e of session.takeEvents(s)) if (e.type === 'pause' && i > 700) falsePauses += 1
    }
  }
  assert.equal(falsePauses, 0)
})

// ---- review findings (2026-10-11): each of these failed before its fix ----

// Back-to-back takes as the page makes them (3 s when it wants the audio, else 2 s), from
// packet `i` at watch time `t`, until `until(req)` says stop; returns what was sent, and when.
function takesFrom(s, i, t, gainAt, count, until) {
  for (let k = 0; k < count; k++) {
    const len = session.wantsAudio(s, t) ? 45 : 28
    const req = take(s, i, i + len - 1, gainAt, t, t + len * MS)
    if (req && until(req)) return { req, at: t + len * MS, i: i + len }
    i += len + 4
    t += (len + 4) * MS
  }
  return { req: null, at: t, i }
}

for (const reason of ['phone', 'http_502', 'recognizer_timeout']) {
  test(`in takes mode, a resume check lost on the way ("${reason}") is asked again, and the lyrics carry on`, () => {
    const s = following()
    feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
    s.mode = 'takes'
    assert.equal(take(s, 500, 527, (i) => (i < 508 ? QUIET : LOUD), 30_000, 32_000), null)
    const req = take(s, 537, 581, () => LOUD, 32_600, 35_300)
    assert.equal(req && req.purpose, 'resume')
    session.onResponse(s, req, { ok: false, reason }, 36_000)
    // the music plays on
    const again = takesFrom(s, 592, 36_500, () => LOUD, 10, () => true)
    assert.equal(again.req && again.req.purpose, 'resume', 'asked again')
    assert.ok(again.at - 36_000 <= 10_000, `within 10 s (${again.at - 36_000} ms)`)
    session.onResponse(s, again.req, found(20_000), again.at + 500)
    assert.ok(!clock.isPaused(s.clock), 'placed: the lyrics carry on')
  })
}

test('in takes mode, after a resume asked for with SELECT, the re-syncs carry on', () => {
  const { s } = pausedWithTrack()
  // sound back 4 packets before a take ends: too little to place on the watch
  assert.equal(take(s, 500, 527, (i) => (i < 524 ? QUIET : LOUD), 30_000, 32_000), null)
  session.checkNow(s, 32_100) // SELECT: the lyrics look frozen
  const req = take(s, 532, 576, () => LOUD, 32_300, 35_000)
  assert.equal(req && req.purpose, 'resume')
  session.onResponse(s, req, found(18_000), 35_500)
  assert.ok(!clock.isPaused(s.clock))
  // a minute of the song, sounding in the room like its own loudness track
  const room = (i) => roomAt(session.position(s, 35_600 + (i - 590) * MS))
  let syncs = 0
  takesFrom(s, 590, 35_600, room, 25, (r) => {
    if (r.purpose === 'sync') syncs += 1
    session.onResponse(s, r, found(session.position(s, r.startAt)), r.sentAt + 500)
    return false
  })
  assert.ok(syncs >= 2, `${syncs} re-syncs in a minute`)
})

test('in takes mode, the music coming back is placed on the watch while a word poll is out', () => {
  const { s, stopped } = pausedWithTrack()
  s.nextLyricsAt = 0
  const poll = session.decide(s, 29_000)
  assert.equal(poll && poll.kind, 'lyrics', 'a word poll is on its way')
  const req = take(s, 500, 527, (i) => (i < 506 ? QUIET : roomAt(stopped + (i - 506) * MS)), 30_000, 32_000)
  assert.equal(req, null, 'nothing sent: one request at a time')
  assert.ok(!clock.isPaused(s.clock), 'but running again at once')
})

test('in takes mode, the music coming back is placed on the watch while errors are backing off', () => {
  const { s, stopped } = pausedWithTrack()
  s.nextLyricsAt = 0
  session.onResponse(s, session.decide(s, 29_000), { ok: false, reason: 'phone' }, 29_500)
  const req = take(s, 500, 527, (i) => (i < 506 ? QUIET : roomAt(stopped + (i - 506) * MS)), 30_000, 32_000)
  assert.equal(req, null)
  assert.ok(!clock.isPaused(s.clock), 'running again at once')
})

test('in takes mode, SELECT is answered with a take long enough to place, not the 2 s one already recording', () => {
  const s = following()
  s.mode = 'takes'
  s.nextVerifyAt = Infinity
  assert.equal(session.wantsAudio(s, 20_000), false, 'a 2 s take is recording')
  session.checkNow(s, 20_500)
  assert.equal(take(s, 340, 367, () => LOUD, 20_000, 21_700), null, 'that one is too short to place')
  assert.equal(session.wantsAudio(s, 21_950), true, 'so the next one is made long enough')
  const req = take(s, 372, 416, () => LOUD, 21_950, 24_650)
  assert.equal(req && req.purpose, 'sync')
  assert.equal(req.to - req.from + 1, 45)
})

test('a find answered after the phone took over does not replace the song in the earphones', () => {
  const s = session.createSession()
  s.mode = 'takes'
  const find = take(s, 0, 77, () => LOUD, 0, 5000)
  assert.equal(find.purpose, 'find')
  onPhone(s, 6000, { version: 3, title: 'Champagne Supernova', songId: 'champagne', positionMs: 60_000 })
  session.onResponse(s, find, found(5000), 9000)
  assert.equal(s.song.title, 'Champagne Supernova')
  assert.equal(Math.round(session.position(s, 10_000)), 64_000, "on the phone's clock")
})

test('with the phone as the clock, a lyrics poll lost on the way is made again', () => {
  const s = session.createSession()
  onPhone(s, 1000, { version: 1, positionMs: 30_000 })
  const poll = session.decide(s, 1000)
  assert.equal(poll && poll.kind, 'lyrics')
  session.onResponse(s, poll, { ok: false, reason: 'phone' }, 10_000)
  let again = null
  for (let t = 10_200; t < 60_000 && !again; t += 200) again = session.onTick(s, t)
  assert.equal(again && again.kind, 'lyrics')
})

test('with the phone as the clock, word timings due in minutes are asked for then', () => {
  const s = session.createSession()
  onPhone(s, 1000, { version: 1, positionMs: 30_000 })
  const poll = session.decide(s, 1000)
  const res = { ok: true, song: { id: 'wonderwall' }, lyrics: { version: 'v1', kind: 'synced', lines: LINES }, words: { status: 'pending', etaMs: 120_000 } }
  session.onResponse(s, poll, res, 2000)
  assert.equal(session.decide(s, 60_000), null, 'not before')
  const again = session.decide(s, 122_000)
  assert.equal(again && again.kind, 'lyrics')
})

test("with the phone as the clock, the watch's clock never ends the song: the phone says when", () => {
  const s = session.createSession()
  onPhone(s, 0, { version: 1, positionMs: 250_000 }) // 8 s before the end
  for (let t = 0; t <= 20_000; t += 200) session.onTick(s, t)
  assert.equal(s.source, 'phone')
  assert.ok(s.song, "still the phone's song")
  // the helper went quiet: the server marks it paused under a new version; a minute on, the room
  onPhone(s, 40_000, { version: 2, playing: false, positionMs: 275_000 })
  session.onTick(s, 70_000)
  assert.equal(s.source, 'phone')
  session.onTick(s, 100_500)
  assert.equal(s.source, 'room', 'the room is listened to again')
})

// (not a finding: a guard for its fix, which now clears a comeback on a "no")
test('in takes mode, a "no" about sound from before the room went quiet again leaves the new sound to be checked', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  s.mode = 'takes'
  assert.equal(take(s, 500, 527, (i) => (i < 508 ? QUIET : LOUD), 30_000, 32_000), null)
  const old = take(s, 537, 581, () => LOUD, 32_600, 35_300)
  assert.equal(old && old.purpose, 'resume')
  // it stops, and something is loud again, while that answer is on its way
  assert.equal(take(s, 590, 617, (i) => (i < 600 ? QUIET : LOUD), 35_400, 37_100), null)
  session.onResponse(s, old, { ok: false, reason: 'no_match' }, 37_200)
  assert.ok(s.comeback, 'the new sound is still to be checked')
  const req = take(s, 627, 671, () => LOUD, 37_700, 40_400)
  assert.equal(req && req.purpose, 'resume')
})

// ---- the phone link (Bluetooth) dropping and coming back ----

test('with the phone link down nothing is sent, and the moment it is back what waited goes', () => {
  const s = following()
  s.mode = 'takes'
  s.nextLyricsAt = 0 // a word poll is due
  session.onLink(s, false, 10_000)
  assert.equal(session.decide(s, 10_100), null, 'nothing goes while the link is down')
  assert.equal(take(s, 300, 344, () => LOUD, 10_000, 12_700), null)
  assert.equal(s.takeSkip, 'link')
  assert.equal(s.errors, 0, 'and nothing counts as an error')
  const req = session.onLink(s, true, 20_000)
  assert.equal(req && req.kind, 'lyrics', 'the waiting poll goes at once')
})

test('errors from before the link dropped hold nothing up once it is back', () => {
  const s = session.createSession()
  s.mode = 'takes'
  const find = take(s, 0, 77, () => LOUD, 0, 5000)
  // the link was going: four searches failed on the way, and the next waits 24 s
  for (let k = 0; k < 4; k++) session.onResponse(s, find, { ok: false, reason: 'phone' }, 5000 + k)
  assert.ok(s.holdUntil >= 29_000)
  session.onLink(s, false, 6000)
  session.onLink(s, true, 9000)
  const again = take(s, 82, 159, () => LOUD, 9000, 14_000)
  assert.equal(again && again.purpose, 'find', 'the first take after the link is back goes')
})

// ---- priority: the phone's player first; when it doesn't play, the mics ----

test('the phone paused: the mics look for a song, and one found in the room takes over', () => {
  const s = session.createSession()
  s.mode = 'takes'
  onPhone(s, 0, { version: 1, title: 'Champagne Supernova', songId: 'champagne', positionMs: 30_000 })
  assert.equal(session.takeRequest(s, 0, 77, 0, 5000), null, 'playing: the mics are off')
  onPhone(s, 6000, { version: 2, title: 'Champagne Supernova', songId: 'champagne', playing: false, positionMs: 36_000 })
  assert.ok(session.looking(s))
  assert.equal(session.wantsAudio(s, 6000), true, 'a take long enough to find a song')
  const find = take(s, 100, 177, () => LOUD, 6500, 11_500)
  assert.equal(find && find.purpose, 'find')
  assert.equal(s.song.title, 'Champagne Supernova', 'the paused song stays up meanwhile')
  session.onResponse(s, find, found(5000), 12_000)
  assert.equal(s.song.title, 'Wonderwall', 'the room took over')
  assert.equal(s.source, 'room')
  // and the phone playing again takes over at once
  onPhone(s, 20_000, { version: 3, title: 'Champagne Supernova', songId: 'champagne', positionMs: 37_000 })
  assert.equal(s.song.title, 'Champagne Supernova')
  assert.ok(session.phonePlaying(s))
})

test('a song found while the phone was paused does not replace it once it plays again', () => {
  const s = session.createSession()
  s.mode = 'takes'
  onPhone(s, 0, { version: 1, title: 'Champagne Supernova', songId: 'champagne', positionMs: 30_000 })
  onPhone(s, 6000, { version: 2, title: 'Champagne Supernova', songId: 'champagne', playing: false, positionMs: 36_000 })
  const find = take(s, 100, 177, () => LOUD, 6500, 11_500)
  onPhone(s, 11_800, { version: 3, title: 'Champagne Supernova', songId: 'champagne', positionMs: 36_000 }) // play again
  session.onResponse(s, find, found(5000), 12_000)
  assert.equal(s.song.title, 'Champagne Supernova', 'the phone playing comes first')
  assert.ok(session.phonePlaying(s))
})

// ---- what the phone's mic heard ----

const heard = (v) => ({ id: 'r1', songId: 'wonderwall', title: 'Wonderwall', artist: 'Oasis', durationMs: 258_000, positionMs: 41_000, ...v })

test("the phone's mic names the song while the watch looks: it starts there, and its lyrics are asked for at once", () => {
  const s = session.createSession()
  s.mode = 'takes'
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  assert.equal(s.song && s.song.title, 'Wonderwall')
  assert.equal(s.source, 'room', 'the room is the clock: the watch follows it from here')
  assert.equal(Math.round(session.position(s, 12_000)), 43_000)
  assert.equal(session.takeEvents(s).some((e) => e.type === 'song'), true)
  const poll = session.decide(s, 10_000)
  assert.equal(poll && poll.kind, 'lyrics')
  // the watch's own search gets there too: same song, it only refines where it is
  const own = take(s, 0, 77, () => LOUD, 5_500, 10_500)
  assert.equal(own, null, 'one request at a time')
  session.onResponse(s, poll, { ok: true, song: { id: 'wonderwall' }, lyrics: { version: 'v1', kind: 'synced', lines: LINES }, words: { status: 'ready' } }, 11_000)
  assert.equal(s.song.kind, 'synced')
})

test("what the phone's mic names never replaces the phone's playing song, nor a song followed in the room", () => {
  const s = session.createSession()
  onPhone(s, 0, { version: 1, title: 'Champagne Supernova', songId: 'champagne', positionMs: 30_000 })
  session.onPhone(s, { version: 2, title: 'Champagne Supernova', artist: 'Oasis', durationMs: 258_000, playing: true, positionMs: 32_000, speed: 1, songId: 'champagne', heard: heard() }, 2000)
  assert.equal(s.song.title, 'Champagne Supernova')
  const r = following()
  r.mode = 'takes'
  session.onPhone(r, { version: 1, title: '', playing: false, heard: heard({ id: 'r2', songId: 'other', title: 'Other' }) }, 9000)
  assert.equal(r.song.id, 'wonderwall', 'a song followed in the room stays')
})

test("the same news from the phone's mic, passed on twice, starts the song once", () => {
  const s = session.createSession()
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  session.takeEvents(s)
  session.onPhone(s, { version: 4, title: '', playing: false, heard: heard({ positionMs: 45_000 }) }, 14_000)
  assert.deepEqual(session.takeEvents(s).filter((e) => e.type === 'song'), [])
  assert.equal(Math.round(session.position(s, 14_000)), 45_000)
})

// ---- the server unable to answer (Shazam refusing calls) ----

test('while Shazam refuses calls the watch holds its song searches until the server says, then goes on', () => {
  const s = session.createSession()
  s.mode = 'takes'
  const find = take(s, 0, 77, () => LOUD, 0, 5000)
  session.onResponse(s, find, { ok: false, reason: 'recognizer_busy', retryInMs: 20_000 }, 5500)
  assert.equal(take(s, 82, 140, () => LOUD, 5600, 9000), null, 'held: it would only be refused too')
  assert.equal(s.takeSkip, 'busy')
  const later = take(s, 300, 360, () => LOUD, 25_600, 29_000)
  assert.equal(later && later.purpose, 'find', 'and searching again once the server said it could')
})

test("a re-sync the server couldn't answer never ends the song", () => {
  const s = following()
  for (let k = 0; k < 5; k++) {
    const req = { id: 900 + k, kind: 'identify', purpose: 'sync', song: 'wonderwall', startAt: 10_000 + k * 1000, from: 0, to: 49 }
    session.onResponse(s, req, { ok: false, reason: k % 2 ? 'recognizer_busy' : 'recognizer_timeout' }, 20_000 + k * 1000)
  }
  assert.equal(s.song && s.song.id, 'wonderwall')
  assert.ok(s.nextVerifyAt > 24_000, 'and the next re-sync comes later')
})

// ---- review of the phone listening (2026-10-11): each of these failed before its fix ----

test("a song only the phone's mic has heard is not frozen by the watch's quiet mic, and the phone keeps listening for it", () => {
  const s = session.createSession()
  s.mode = 'takes'
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  // the watch's own takes are near-silent: that is why the phone's mic was needed
  take(s, 0, 33, () => QUIET, 10_000, 12_000)
  take(s, 38, 71, () => QUIET, 12_300, 14_300)
  assert.ok(!clock.isPaused(s.clock), 'still running')
  assert.equal(session.wantsPhoneEars(s), true, 'and the phone is asked to keep listening')
  // the phone's mic again, 20 s on: where the song is now, taken as a match like any other
  const before = session.position(s, 30_000)
  session.onPhone(s, { version: 5, title: '', playing: false, heard: heard({ id: 'r2', positionMs: 61_120 }) }, 30_000)
  assert.equal(s.clock.samples.length, 2)
  assert.ok(Math.abs(session.position(s, 30_000) - 61_120) < Math.abs(before - 61_120), 'and the clock moves toward it')
})

test("once the watch's own mic places a song the phone's mic named, the watch's silence counts again", () => {
  const s = session.createSession()
  s.mode = 'takes'
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  const sync = { id: 950, kind: 'identify', purpose: 'sync', song: 'wonderwall', startAt: 20_000, from: 0, to: 49 }
  session.onResponse(s, sync, found(51_000), 21_000)
  assert.equal(session.wantsPhoneEars(s), false)
  take(s, 0, 33, () => QUIET, 22_000, 24_000)
  assert.ok(clock.isPaused(s.clock), 'the music stopping is heard again')
})

test("a song the phone's mic named learns its length from the lyrics answer", () => {
  const s = session.createSession()
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard({ durationMs: null }) }, 10_000)
  assert.equal(s.song.durationMs, null)
  const poll = session.decide(s, 10_000)
  session.onResponse(s, poll, { ok: true, song: { id: 'wonderwall', durationMs: 258_000 }, lyrics: { version: 'v1', kind: 'synced', lines: LINES }, words: { status: 'ready' } }, 11_000)
  assert.equal(s.song.durationMs, 258_000, 'so it can end, and the next song be looked for')
})

test('a request out when the link dropped is let go when it is back, and its late failure means nothing', () => {
  const s = session.createSession()
  s.mode = 'takes'
  const find = take(s, 0, 77, () => LOUD, 0, 5000)
  session.onLink(s, false, 5200)
  session.onLink(s, true, 9000)
  const next = take(s, 82, 159, () => LOUD, 9000, 14_000)
  assert.equal(next && next.purpose, 'find', 'the take after the link is back goes at once')
  session.onResponse(s, find, { ok: false, reason: 'phone', message: 'request timed out' }, 30_000) // ZML, 25 s on
  assert.equal(s.holdUntil, 0, 'no hold for it')
  assert.deepEqual(session.takeEvents(s).filter((e) => e.type === 'problem'), [])
})

test('the phone buffering (a skip, a stalled stream) is still its music: the mics stay off and the room waits', () => {
  const s = session.createSession()
  s.mode = 'takes'
  onPhone(s, 0, { version: 1, positionMs: 30_000 })
  onPhone(s, 2000, { version: 2, playing: false, active: true, positionMs: 32_000 }) // buffering
  assert.ok(session.phonePlaying(s))
  assert.equal(session.takeRequest(s, 0, 77, 2000, 7000), null, 'no mic')
  assert.ok(clock.isPaused(s.clock), 'no sound yet: the lyrics wait')
  session.onTick(s, 90_000)
  assert.equal(s.source, 'phone', 'a long stall is not a minute paused')
})

test('a search made while the phone is paused is about whatever plays, not the song on screen', () => {
  const s = session.createSession()
  s.mode = 'takes'
  onPhone(s, 0, { version: 1, positionMs: 30_000 })
  onPhone(s, 2000, { version: 2, playing: false, positionMs: 32_000 })
  const find = take(s, 100, 177, () => LOUD, 2500, 7500)
  assert.equal(find && find.purpose, 'find')
  assert.equal(find.song, null)
  assert.equal(find.known, null, "else the server left out lyrics it thought the watch had")
})

// ---- the follow-up review (2026-10-11) ----

test("a song only the phone's mic heard stops when the phone hears nothing, and carries on when it hears it again", () => {
  const s = session.createSession()
  s.mode = 'takes'
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  session.onPhone(s, { version: 4, title: '', playing: false, heard: { id: 'r2', quiet: true } }, 40_000)
  assert.ok(clock.isPaused(s.clock), 'the music stopped: the phone that named it hears nothing')
  const frozen = session.position(s, 40_000)
  assert.equal(Math.round(session.position(s, 60_000)), Math.round(frozen))
  session.onPhone(s, { version: 5, title: '', playing: false, heard: heard({ id: 'r3', positionMs: 74_000 }) }, 70_000)
  assert.ok(!clock.isPaused(s.clock), 'heard again: on it goes')
  assert.equal(Math.round(session.position(s, 70_000)), 74_000, 'from where the phone heard it')
})

test("the phone's player taking over is never undone by a late word from its mic", () => {
  const s = session.createSession()
  s.mode = 'takes'
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000) // a song only the phone heard
  onPhone(s, 20_000, { version: 4, title: 'Champagne Supernova', songId: 'champagne', positionMs: 30_000 }) // then it plays
  session.onPhone(s, { version: 5, title: 'Champagne Supernova', artist: 'Oasis', durationMs: 258_000, playing: true, active: true,
    positionMs: 31_000, speed: 1, songId: 'champagne', heard: heard({ id: 'r9', songId: 'other', title: 'Other' }) }, 21_000)
  assert.equal(s.song.title, 'Champagne Supernova')
  assert.ok(session.phonePlaying(s))
  assert.equal(session.wantsPhoneEars(s), false)
})

test("in a room too loud for the watch to place its audio, its misses don't end a song the phone vouches for", () => {
  const s = session.createSession()
  session.onPhone(s, { version: 3, title: '', playing: false, heard: heard() }, 10_000)
  for (let k = 0; k < 5; k++) {
    const req = { id: 960 + k, kind: 'identify', purpose: 'sync', song: 'wonderwall', startAt: 20_000 + k * 1000, from: 0, to: 49 }
    session.onResponse(s, req, { ok: false, reason: 'no_match' }, 21_000 + k * 1000)
  }
  assert.equal(s.song && s.song.id, 'wonderwall')
})
