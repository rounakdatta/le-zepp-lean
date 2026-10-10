// The listening session: what it asks the server, and how it reacts to the music stopping,
// coming back, going quiet on purpose, skipping and ending. Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as session from '../../watch-app/lib/session.js'
import * as clock from '../../watch-app/lib/clock.js'

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

test('a match while paused means the music is playing again', () => {
  const s = following()
  feed(s, 84, 400, (i) => (i < 200 ? LOUD : QUIET))
  assert.ok(clock.isPaused(s.clock))
  // takes mode: a take recorded at watch time 30,000 matched at song 40,000
  const req = session.takeRequest(s, 500, 583, 30_000, 35_000)
  assert.equal(req.purpose, 'resume')
  session.onResponse(s, req, found(40_000), 36_000)
  assert.ok(!clock.isPaused(s.clock))
  assert.equal(Math.round(session.position(s, 36_000)), 46_000)
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
