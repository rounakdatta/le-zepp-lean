// The listening session's decisions, kept apart from the watch APIs so that the whole thing
// can be tested and simulated under Node. Packets and server answers go in; requests to
// send and events to draw come out. Pure logic: time is always passed in.
//
//   onPacket(s, index, gain, at, now) -> request | null   one 60 ms mic packet, `at` = when it began
//   onTick(s, now)                    -> request | null   timers: re-sync, word polling, song end
//   onResponse(s, request, res, now)                      what the server said
//   s.events                                              what changed, for the screen (drained by the page)
//
// One request is in flight at a time. The phone link carries a few KB/s, so what is sent
// is chosen with care: 5 s of audio to find a song, 3 s to re-check it, 2 s after the
// music comes back, and nothing at all while it is paused.

import * as clock from './clock.js'
import * as activity from './activity.js'
import { decodeEnvelope, expectedAt } from './envelope.js'
import { splitWords } from './sync.js'

export const PACKET_MS = 60
export const IDENTIFY_PACKETS = 84 // 5 s: what Shazam needs to be sure
export const VERIFY_PACKETS = 50 // 3 s: enough to place audio inside a song the server knows
export const RESUME_PACKETS = 34 // 2 s of the music after it comes back
export const CHECK_PACKETS = 70 // 4.2 s after a suspected skip: enough for Shazam if it's another song
// Takes mode: a take must be this long to be worth asking Shazam about (a 3.5 s take holds
// ~53 packets: the mic starts ~0.32 s after start(); on room clips cut 3-4.7 s long Shazam
// named the song 60-70% of the time at every length), and this long to place inside a song
// the server knows: fast re-sync was measured on 2 s windows, and on a T-Rex 3 the 1.56 s
// left of a take after the music came back could not be placed.
export const FIND_TAKE_PACKETS = 50
export const PLACE_TAKE_PACKETS = 34
// Takes mode: sound coming back during a pause moves the lyrics only once it is shown to be
// the song, where it stopped. First on the watch: the room's loudness against the song's
// own loudness track at the frozen position. In a simulated room, 1.4 s of the real song
// there correlated 0.72 or more nine times in ten and placed it within one packet; someone
// talking never passed 0.47. Shorter windows need more (talk reached 0.63 at 1 s).
// Otherwise the server places it.
const LOCAL_MIN_PACKETS = 17
const LOCAL_FULL_PACKETS = 23
const LOCAL_R_SHORT = 0.7
const LOCAL_R = 0.6
// Where the music is expected: the frozen position plus however long it has been back. It is
// looked for this many packets either side (the freeze itself can be off by half a gap):
// within +-0.6 s, 1.7 s of room loudness placed the song within a packet every time; within
// +-1.5 s, only 80% of the time (a song's loudness repeats with its beat).
const LOCAL_LAG = 10
// No window is longer than this. live.js keeps 140 packets; a window stretched by a slow
// phone (25 s timeout) or an error back-off used to reach past them, and the audio sent then
// started up to 15 s after the time it was anchored to.
export const MAX_WINDOW_PACKETS = 100
const LOUD_SHARE = 0.6 // a window worth identifying is mostly music
// Re-syncs come quickly at first (they also measure the playback speed, which needs matches
// spread over 30 s), then settle to every 30 s.
const VERIFY_STEPS_MS = [10000, 10000, 20000]
const VERIFY_MS = 30000
const IDENTIFY_RETRY_PACKETS = 50 // ~3 s of new audio before trying again
const DOUBT_BACKOFF_MAX = 8 // after a doubtful resume, re-checks space out: 5 s, 10 s, 20 s, ... 40 s
const ERROR_BACKOFF_MS = 6000
// The server answers a new song within 1.5 s, lyrics or not ("pending" while its lookup
// runs): ask again this soon, then less and less often (LRCLIB can be down for a while).
const LYRICS_PENDING_POLL_MS = 1500
const LYRICS_PENDING_POLL_MAX_MS = 10000
// Phone mode: paused this long, the phone is no longer what plays here; the room is listened
// to again (and the phone takes over the moment it plays).
const PHONE_IDLE_MS = 60000
const PHONE_SEEK_MS = 1000
const END_GRACE_MS = 2500
const END_ZONE_MS = 5000 // music stopping this close to the end is the song ending, not a pause
// The room keeps ringing after the music stops, so the first packet quiet enough to count
// comes a couple of packets late: in simulated rooms (RT60 0.45 s) the lyrics froze 150-210 ms
// past the stop. A pause is dated this many packets before its first quiet packet.
const PAUSE_TAIL_PACKETS = 2
const MAX_GAINS = 256
// Skip detection: every MATCH_EVERY packets, correlate the last MATCH_WINDOW packets of room
// loudness with the song's track at the clock's position (allowing +-MATCH_LAG packets of
// clock error). In a simulated room that was 0.8-0.93 in sync, and only fell to 0.26-0.6
// after a skip: songs keep their tempo, so a misplaced window still half-matches. So the
// test is relative to this room's own baseline: twice MISMATCH_DROP below it, and the music
// is elsewhere.
const MATCH_WINDOW = 50
const MATCH_EVERY = 10
const MATCH_LAG = 3
const MISMATCH_DROP = 0.3
const MATCH_BASELINE_MIN = 0.6

export function createSession() {
  return {
    mode: 'live', // 'live': packets as they are recorded | 'takes': separate 5 s recordings (the page sends them)
    song: null, // { id, title, artist, album, durationMs, kind, lines, lyricsVersion, words, envelope }
    clock: clock.createClock(),
    act: activity.createActivity(),
    last: -1, // newest packet index
    lastAt: 0, // and when it began
    gains: [], // recent gains, gains[index % MAX_GAINS]
    inflight: null,
    seq: 0,
    nextIdentifyPacket: IDENTIFY_PACKETS - 1,
    nextVerifyAt: 0,
    nextLyricsAt: Infinity,
    holdUntil: 0, // after errors: no requests before this
    findHoldUntil: 0, // Shazam refusing calls (the server says until when): no song searches before this
    linkUp: true, // the Bluetooth link to the phone (see onLink)
    linkDownAt: -Infinity,
    heardId: null, // the last song news from the phone's mic, acted on once
    heardOnly: false, // the song came from the phone's mic, and the watch's hasn't heard it yet
    resumeCheck: null, // { from, due }: confirm a resume once `due` arrives
    doubt: null, // { due, wait }: a "resume" the server couldn't place; the room is loud, the lyrics frozen
    provisional: false, // resumed on loudness alone; the server hasn't confirmed it is the song yet
    retries: 0, // resume checks that failed for a server reason, this episode
    quietAt: null, // when the room last went quiet while the lyrics were stopped
    levelAtPause: null, // the activity's music level when the music stopped, to undo what talking taught it
    check: null, // { from, due }: the room stopped matching the song; re-sync on fresh audio
    wantCheck: false, // the person asked (SELECT): check now, whatever state we are in
    playingFrom: 0, // first packet of the current stretch of music: no window reaches back past it
    track: [], // recent [packet, gain, expected gain] while playing, for skip detection
    match: { last: null, baseline: null, low: 0, checks: 0 },
    source: 'room', // 'room': the mic decides | 'phone': the phone's player does (see onPhone)
    phone: null, // { version, track, playing, pausedSince } the phone's last word
    takeSkip: null, // takes mode: why the last take stayed on the watch ('busy' | 'quiet' | null)
    comeback: null, // takes mode: { from, failed, due } sound back during a pause, not yet shown to be the song
    gapFrom: -1, // takes mode: the packets [gapFrom, gapTo] fell between two takes
    gapTo: -2,
    misses: 0,
    matches: 0, // matches since the song started
    errors: 0,
    noServer: false,
    events: [],
    stats: { pauses: 0, resumes: 0, rejected: 0, seeks: 0, refines: 0, requests: 0, quietForgiven: 0 },
  }
}

// Watch time packet `index` began, from the newest packet's time.
export function packetTime(s, index) {
  return s.lastAt - (s.last - index) * PACKET_MS
}

export function position(s, now, adjustMs) {
  return clock.songAt(s.clock, now, adjustMs)
}

export function isPlaying(s) {
  return !!s.song && clock.isKnown(s.clock) && !clock.isPaused(s.clock)
}

// The phone's player is playing (or buffering: skipping, a stalled stream; still its music):
// it is the clock, and nothing the mics hear changes that.
export function phonePlaying(s) {
  return s.source === 'phone' && !!s.phone && s.phone.active
}

// Nothing to follow in the room: no song yet, or only the phone's, paused. The mics look
// for one (the watch's, and the phone's when it listens too), and what they find takes over.
export function looking(s) {
  return !s.song || (s.source === 'phone' && !phonePlaying(s))
}

// The phone's mic is wanted: looking for a song, or following one only it has heard.
export function wantsPhoneEars(s) {
  return looking(s) || s.heardOnly
}

function emit(s, type, extra) {
  const e = extra || {}
  e.type = type
  s.events.push(e)
}

// ---- input: packets ---------------------------------------------------------------

export function onPacket(s, index, gain, at, now) {
  if (phonePlaying(s)) return null // the phone's player is the clock; the room says nothing now
  if (s.last >= 0 && index > s.last + 1) {
    s.gapFrom = s.last + 1
    s.gapTo = index - 1
  }
  s.last = index
  s.lastAt = at
  s.gains[index % MAX_GAINS] = gain
  let expected = null
  if (s.song && s.song.envelope && isPlaying(s)) expected = expectedAt(s.song.envelope, clock.songAt(s.clock, at))
  // The music level is only learned while the song is confirmed playing: someone talking at
  // the wrist during a pause, taken for a resume, taught it 38 where the music was 28, and the
  // music could then never resume again.
  s.act.learn = looking(s) || (isPlaying(s) && !s.provisional)
  const ev = activity.pushLevel(s.act, gain, index, expected)
  s.stats.quietForgiven = s.act.expectedQuiet
  if (ev) onActivity(s, ev)
  if (expected !== null && isPlaying(s)) followTrack(s, index, gain, at)
  // Takes mode replays a finished take here; the page sends the take itself, and a request
  // decided now would sit in flight with nobody to send it.
  return s.mode === 'takes' ? null : decide(s, now)
}

// Does the room still sound like the song at the clock's position? A skip that came with
// no gap (or one too short to be a pause) is only otherwise noticed at the next re-sync.
function followTrack(s, index, gain, at) {
  const env = s.song.envelope
  s.track.push([index, gain])
  if (s.track.length > MATCH_WINDOW + 2 * MATCH_LAG) s.track.shift()
  if (index % MATCH_EVERY !== 0 || s.track.length < MATCH_WINDOW + 2 * MATCH_LAG) return
  let best = -1
  for (let lag = -MATCH_LAG; lag <= MATCH_LAG; lag++) {
    const obs = []
    const exp = []
    for (let k = MATCH_LAG; k < s.track.length - MATCH_LAG; k++) {
      const [i, g] = s.track[k]
      const e = expectedAt(env, clock.songAt(s.clock, packetTime(s, i + lag)))
      if (e === null) continue
      obs.push(g)
      exp.push(e)
    }
    const r = correlation(obs, exp)
    if (r !== null && r > best) best = r
  }
  if (best < -0.5) return // the track was flat over this window: nothing to compare
  const m = s.match
  m.last = best
  m.checks += 1
  const usable = m.baseline !== null && m.baseline >= MATCH_BASELINE_MIN
  const low = usable && best < m.baseline - MISMATCH_DROP
  m.low = low ? m.low + 1 : 0
  if (!low) m.baseline = m.baseline === null ? best : m.baseline + (best - m.baseline) * 0.2
  if (m.low >= 2 && !s.check) {
    // Only audio from after this moment: a window reaching back would half-match the old place.
    m.low = 0
    s.track = []
    s.check = { from: s.last + 1, due: s.last + CHECK_PACKETS }
    emit(s, 'mismatch', { correlation: best, baseline: m.baseline })
  }
}

function correlation(a, b, minN) {
  const n = a.length
  if (n < (minN || 20)) return null
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  if (sbb < n * 4) return -1 // the song's own loudness barely moves here (std < 2 steps)
  return saa > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

function onActivity(s, ev) {
  if (s.source === 'phone') return // its player paused: the room's stops and starts aren't its song's
  // A song only the phone's mic has heard: the watch hearing quiet says nothing about it (that
  // is why the phone's mic was needed). It used to freeze the song at the watch's first take.
  if (s.heardOnly && ev.type === 'pause') return
  let at = packetTime(s, ev.type === 'pause' ? ev.packet - PAUSE_TAIL_PACKETS : ev.packet)
  if (ev.type === 'pause' && ev.packet === s.gapTo + 1) {
    // The quiet began between two takes: somewhere between the last packet heard and this
    // one. The middle is the best guess (dating it at this packet froze the lyrics up to
    // 1.4 s late); placing the music when it comes back corrects it.
    at = packetTime(s, Math.round((s.gapFrom - 1 + ev.packet) / 2) - PAUSE_TAIL_PACKETS)
  }
  if (ev.type === 'pause') {
    s.comeback = null // the sound that might have been the music has stopped again
    if (s.song && s.song.durationMs && clock.isKnown(s.clock) && !clock.isPaused(s.clock) &&
      clock.songAt(s.clock, at) > s.song.durationMs - END_ZONE_MS) {
      // The song finished: what comes next is a new song, not this one resuming.
      endSong(s)
      return
    }
    s.doubt = null // the room went quiet again: an ordinary pause
    s.quietAt = at
    if (s.song && clock.isKnown(s.clock) && !clock.isPaused(s.clock)) {
      clock.pause(s.clock, at)
      s.resumeCheck = null
      s.check = null
      s.track = []
      s.retries = 0
      if (!s.provisional) s.levelAtPause = s.act.musicLevel
      s.provisional = false
      s.stats.pauses += 1
      emit(s, 'pause', { at, packet: ev.packet })
    }
    return
  }
  if (s.song && clock.isPaused(s.clock) && s.mode === 'takes') {
    // Loud again: maybe the music, maybe someone talking. The lyrics stay where they are
    // until takeRequest has shown it is the song (sound alone used to set them running).
    s.comeback = { from: ev.packet, failed: false, due: 0 }
    return
  }
  if (s.song && clock.isPaused(s.clock)) {
    clock.resume(s.clock, at)
    s.provisional = true
    s.quietAt = null
    // 2 s is enough to place the same song when the server has its audio; otherwise Shazam
    // decides, and it needs 5 s.
    const n = s.song.fast ? RESUME_PACKETS : IDENTIFY_PACKETS
    s.resumeCheck = { from: ev.packet, due: ev.packet + n - 1 }
    s.playingFrom = ev.packet
    s.track = []
    s.stats.resumes += 1
    emit(s, 'resume', { at, packet: ev.packet })
  }
}

// ---- input: time ------------------------------------------------------------------

export function onTick(s, now) {
  if (s.source === 'phone' && s.phone && !s.phone.active && now - s.phone.pausedSince >= PHONE_IDLE_MS) leavePhone(s)
  // The watch's clock ends a song only when the room is the clock. The phone says itself when
  // its track ends, or stops (a helper gone quiet is marked paused by the server); ended here,
  // the song left the watch in earphones mode with nothing to follow and the mic off.
  if (s.source !== 'phone' && s.song && clock.isKnown(s.clock) && !clock.isPaused(s.clock) && s.song.durationMs) {
    const pos = clock.songAt(s.clock, now)
    if (pos > s.song.durationMs + END_GRACE_MS) endSong(s)
  }
  return decide(s, now)
}

function endSong(s) {
  emit(s, 'ended', { title: s.song.title })
  s.song = null
  clock.reset(s.clock)
  activity.forgetTrack(s.act)
  activity.markPlaying(s.act)
  s.resumeCheck = null
  s.comeback = null
  s.doubt = null
  s.check = null
  s.heardOnly = false
  s.nextLyricsAt = Infinity
  s.nextIdentifyPacket = s.last + 1
}

// ---- output: what to ask the server ---------------------------------------------------

function loudShare(s, from, to) {
  let loud = 0
  const threshold = activity.pauseThreshold(s.act)
  for (let i = from; i <= to; i++) if ((s.gains[i % MAX_GAINS] || 0) >= threshold) loud += 1
  return loud / (to - from + 1)
}

function request(s, kind, purpose, from, to, now, startAtOverride) {
  if (from >= 0 && startAtOverride === undefined) from = Math.max(from, to - MAX_WINDOW_PACKETS + 1)
  s.seq += 1
  const startAt = startAtOverride !== undefined ? startAtOverride : from >= 0 ? packetTime(s, from) : null
  // A search is about whatever plays, not the song on screen (a paused phone song: its lyrics,
  // marked known, were left out of the answer when the room played that same song).
  const about = purpose === 'find' ? null : s.song
  const req = {
    id: s.seq,
    kind, // 'identify' (audio) | 'lyrics' (no audio)
    purpose, // 'find' | 'sync' | 'resume' | 'check' | 'words'
    from,
    to, // packets [from, to] inclusive
    startAt,
    expectMs: about && startAt !== null ? clock.songAt(s.clock, startAt) : null,
    song: about ? about.id : null,
    known: about ? { lyrics: about.lyricsVersion || null, envelope: about.envelope ? about.envelope.version : null } : null,
    sentAt: now,
  }
  s.inflight = req
  s.stats.requests += 1
  return req
}

// Takes mode: will the next take probably go to the server? Then the page makes it long
// enough to place (a resume to confirm, a re-sync due, a suspected skip, SELECT).
export function wantsAudio(s, now) {
  if (looking(s) || s.wantCheck || s.check) return true
  if (s.comeback) return s.comeback.failed || !s.song.envelope
  if (s.resumeCheck && !clock.isPaused(s.clock)) return true
  return isPlaying(s) && now >= s.nextVerifyAt
}

// Takes mode: the watch hands over a recording only when it stops, so the page records
// takes back to back and feeds each through onPacket (that alone notices pauses and
// resumes). This says whether a finished take [from, to] also goes to the server, and as
// what. One request at a time: a take that finishes while one is out only feeds the
// loudness. (Each take used to replace the request in flight; with takes every few seconds
// a find whose lyrics took 6 s was replaced every time, and the song never appeared.)
export function takeRequest(s, from, to, startAt, now) {
  s.takeSkip = null
  if (phonePlaying(s)) return null
  // Sound back during a pause is first placed on the watch, against the song's own loudness
  // track. That needs no server, so it doesn't wait for one (a word poll out, an error
  // back-off). This take alone: what came before it may be someone talking, or the gap.
  let placed = null
  if (s.song && s.comeback && !s.comeback.failed && clock.isPaused(s.clock)) {
    const f = Math.max(from, s.comeback.from)
    const v = placeLocally(s, f, to)
    if (v && v.ok) {
      resumeAt(s, v, now)
      placed = { from: f, n: v.n }
    } else if (!v || v.n >= LOCAL_FULL_PACKETS) {
      s.comeback.failed = true // the song's track can't say: ask the server
    }
  }
  if (s.inflight || s.noServer || now < s.holdUntil || !s.linkUp) {
    s.takeSkip = s.linkUp ? 'busy' : 'link'
    return null
  }
  if (placed) {
    // and the server places the same audio exactly (it also catches a skip made while paused)
    return placed.n >= LOCAL_FULL_PACKETS ? request(s, 'identify', 'sync', placed.from, to, now, startAt + (placed.from - from) * PACKET_MS) : null
  }
  const n = to - from + 1
  // SELECT: this take, if it is long enough to answer. The one recording when SELECT came may
  // be a 2 s take: then the next one, made long enough (see wantsAudio), is sent instead.
  if (s.wantCheck && n >= (looking(s) || !s.song.fast ? FIND_TAKE_PACKETS : PLACE_TAKE_PACKETS)) {
    s.wantCheck = false
    const purpose = looking(s) ? 'find' : clock.isPaused(s.clock) ? 'resume' : 'sync'
    return request(s, 'identify', purpose, from, to, now, startAt)
  }
  if (looking(s)) {
    if (now < s.findHoldUntil) {
      s.takeSkip = 'busy'
      return null
    }
    if (n >= FIND_TAKE_PACKETS && loudShare(s, from, to) >= LOUD_SHARE) {
      return request(s, 'identify', 'find', from, to, now, startAt)
    }
    s.takeSkip = 'quiet'
    return null
  }
  if (s.comeback && clock.isPaused(s.clock)) {
    // Not placed on the watch: the server decides, from enough of it to place. The comeback
    // stays until an answer settles it (cleared on the way, a lost answer left the lyrics
    // frozen while the music played); after a failed answer, the next try waits until `due`.
    const f = Math.max(from, s.comeback.from)
    if (s.comeback.failed && to - f + 1 >= PLACE_TAKE_PACKETS && to >= s.comeback.due) {
      return request(s, 'identify', 'resume', f, to, now, startAt + (f - from) * PACKET_MS)
    }
    return null
  }
  // The music came back: confirm it with the first take that is all music (the take it
  // came back in also holds the silence before it, and its music part is too short).
  if (s.resumeCheck && !clock.isPaused(s.clock)) {
    if (from <= s.resumeCheck.from || n < (s.song.fast ? PLACE_TAKE_PACKETS : FIND_TAKE_PACKETS)) return null
    s.resumeCheck = null
    return request(s, 'identify', 'resume', from, to, now, startAt)
  }
  if (s.doubt && clock.isPaused(s.clock) && s.act.playing && s.last >= s.doubt.due) {
    return request(s, 'identify', 'resume', from, to, now, startAt)
  }
  if (n < PLACE_TAKE_PACKETS) return null // a 2 s take: loudness only
  if (s.check && isPlaying(s)) {
    s.check = null
    return request(s, 'identify', 'check', from, to, now, startAt)
  }
  if (isPlaying(s) && now >= s.nextVerifyAt && loudShare(s, from, to) >= LOUD_SHARE) {
    return request(s, 'identify', 'sync', from, to, now, startAt)
  }
  return null
}

// Takes mode: is the sound since `from` the song carrying on from where it stopped? The
// room's loudness against the song's own track at the frozen position, allowing the music
// to have come back a little early or, between two takes, up to ~1 s before it was heard.
// null: no track to compare with (here, or not yet).
function placeLocally(s, from, to) {
  const env = s.song.envelope
  if (!env) return null
  const frozen = clock.songAt(s.clock, s.clock.pausedAt)
  const t0 = packetTime(s, from)
  // when the music came back: its first loud packet, or, if that came right after a gap,
  // the middle of the gap
  const c = s.comeback.from
  const onset = c === s.gapTo + 1 && c > from - 1 ? packetTime(s, Math.round((s.gapFrom - 1 + c) / 2)) : packetTime(s, c)
  const expect = Math.round((t0 - onset) / PACKET_MS)
  const obs = []
  const offs = []
  for (let i = from; i <= to; i++) {
    const g = s.gains[i % MAX_GAINS]
    if (g === undefined || g === null || i - s.last >= MAX_GAINS || s.last - i >= MAX_GAINS) continue
    if (i >= s.gapFrom && i <= s.gapTo) continue
    obs.push(g)
    offs.push(packetTime(s, i) - t0)
  }
  const n = obs.length
  if (n < LOCAL_MIN_PACKETS) return { ok: false, n }
  let best = { r: -2, lag: 0 }
  for (let lag = expect - LOCAL_LAG; lag <= expect + LOCAL_LAG; lag++) {
    const a = []
    const b = []
    for (let j = 0; j < n; j++) {
      const e = expectedAt(env, frozen + lag * PACKET_MS + offs[j])
      if (e === null) continue
      a.push(obs[j])
      b.push(e)
    }
    if (a.length < n * 0.8) continue
    const r = correlation(a, b, LOCAL_MIN_PACKETS)
    if (r !== null && r > best.r) best = { r, lag }
  }
  if (best.r === -2 || best.r === -1) return null // the track is flat here: it can't tell
  const need = n >= LOCAL_FULL_PACKETS ? LOCAL_R : LOCAL_R_SHORT
  return { ok: best.r >= need, r: best.r, lag: best.lag, n, at: t0, frozen }
}

// The music is back: the take starting at v.at is at song position frozen + lag packets.
// Run the lyrics from there.
function resumeAt(s, v, now) {
  const at = Math.max(s.clock.pausedAt + 1, v.at - v.lag * PACKET_MS)
  clock.resume(s.clock, at)
  s.comeback = null
  s.provisional = false
  s.doubt = null
  s.quietAt = null
  s.retries = 0
  s.playingFrom = s.last
  s.track = []
  activity.markPlaying(s.act)
  s.nextVerifyAt = now
  s.stats.resumes += 1
  emit(s, 'resume', { at, verified: 'local', r: Math.round(v.r * 100) / 100, lagMs: v.lag * PACKET_MS })
}

// ---- input: the phone ---------------------------------------------------------------

// What the phone says, from the LeZeppLean helper on it via the server: what its player
// plays (`view`: { version, title, artist, durationMs, playing, positionMs (as of `now`),
// speed, songId }) and what its mic named (`view.heard`). The player comes first: while it
// plays it is the clock, exact, and the only way to follow music in earphones, and nothing
// the mics hear changes that. Returns true while the phone's player is what is followed.
export function onPhone(s, view, now) {
  if (!view || typeof view.version !== 'number') return s.source === 'phone'
  followPlayer(s, view, now)
  if (view.heard) onHeard(s, view.heard, now)
  return s.source === 'phone'
}

// The phone's mic named a song: { id, songId, title, artist, durationMs, positionMs (as of
// `now`) }. Taken while the watch is looking (no song, or only the phone's, paused): the
// watch's own search, if it gets there too, then only refines where the song is.
function onHeard(s, h, now) {
  if (!h.id || h.id === s.heardId) return
  s.heardId = h.id
  if (phonePlaying(s)) return // the phone's player comes first, always
  if (h.quiet) {
    // The phone, whose mic named the song, hears nothing now: the music stopped (the watch's
    // mic couldn't tell). Its next listen that hears the song carries it on.
    if (s.heardOnly && isPlaying(s)) {
      clock.pause(s.clock, now)
      s.stats.pauses += 1
      emit(s, 'pause', { at: now, source: 'heard' })
    }
    return
  }
  if (!h.songId) return
  if (s.heardOnly && s.song && s.song.id === h.songId) {
    // the phone's ears again: where the song is now (and playing again, if it had stopped)
    if (clock.isPaused(s.clock)) {
      clock.resume(s.clock, now)
      s.stats.resumes += 1
      emit(s, 'resume', { at: now, source: 'heard' })
    }
    clock.addMatch(s.clock, now, h.positionMs)
    return
  }
  if (!looking(s) && !s.heardOnly) return
  if (s.source === 'phone') leavePhone(s)
  const song = { id: h.songId, title: h.title, artist: h.artist, durationMs: h.durationMs }
  startSong(s, { song, match: { offsetMs: h.positionMs, skew: 0 } }, { startAt: now, from: s.last + 1 }, now)
  s.song.kind = 'pending' // its lyrics are asked for at once
  s.nextLyricsAt = now
  s.nextVerifyAt = now + VERIFY_STEPS_MS[0]
  s.heardOnly = true // until the watch's own mic places it
}

function followPlayer(s, view, now) {
  if (!view || typeof view.version !== 'number') return s.source === 'phone'
  if (s.phone && view.version === s.phone.version && view.title === s.phone.title) return s.source === 'phone'
  const track = view.title ? view.title + '\u0000' + (view.artist || '') : ''
  const prev = s.phone
  const active = view.active !== undefined ? !!view.active : !!view.playing // buffering is still its music
  const pausedSince = active ? null : prev && prev.track === track && prev.pausedSince !== null ? prev.pausedSince : now
  s.phone = { version: view.version, title: view.title, track, playing: !!view.playing, active, pausedSince }
  const follow = !!track && (active || (s.source === 'phone' && now - pausedSince < PHONE_IDLE_MS))
  if (!follow) {
    if (s.source === 'phone') leavePhone(s)
    return false
  }
  if (s.source !== 'phone' || !s.song || s.phoneTrack !== track) {
    s.source = 'phone'
    s.phoneTrack = track
    s.heardOnly = false
    s.inflight = null // whatever the mic asked about is moot now
    s.song = {
      id: view.songId || null,
      title: view.title || '',
      artist: view.artist || '',
      album: '',
      durationMs: view.durationMs || null,
      kind: 'pending',
      lines: [],
      lyricsVersion: null,
      words: null,
      envelope: null,
      fast: true,
    }
    clock.reset(s.clock)
    s.nextLyricsAt = view.songId ? now : Infinity
    emit(s, 'song', { title: s.song.title, artist: s.song.artist, source: 'phone' })
  } else if (view.songId && s.song.id !== view.songId) {
    s.song.id = view.songId // the server has worked out which song it is: lyrics next
    s.nextLyricsAt = now
  } else if (view.songId && s.song.kind !== 'synced') {
    s.nextLyricsAt = now // something changed on the server: its lyrics may have come
  }
  if (view.durationMs) s.song.durationMs = view.durationMs
  const before = clock.isKnown(s.clock) ? clock.songAt(s.clock, now) : null
  const wasPaused = clock.isKnown(s.clock) && clock.isPaused(s.clock)
  clock.reset(s.clock)
  clock.setRatePrior(s.clock, (view.speed || 1) - 1)
  clock.addMatch(s.clock, now, view.positionMs)
  if (!view.playing) clock.pause(s.clock, now)
  if (before !== null && Math.abs(view.positionMs - before) > PHONE_SEEK_MS) emit(s, 'seek', { deltaMs: view.positionMs - before })
  if (before !== null && wasPaused !== !view.playing) emit(s, view.playing ? 'resume' : 'pause', { at: now, source: 'phone' })
  return true
}

// The phone stopped (or has been paused for a minute): the room decides again.
function leavePhone(s) {
  s.source = 'room'
  s.phoneTrack = null
  emit(s, 'ended', { title: s.song ? s.song.title : null, source: 'phone' })
  s.song = null
  clock.reset(s.clock)
  activity.forgetTrack(s.act)
  activity.markPlaying(s.act)
  s.resumeCheck = null
  s.comeback = null
  s.doubt = null
  s.check = null
  s.nextLyricsAt = Infinity
  s.nextIdentifyPacket = s.last + 1
}

// The Bluetooth link to the phone, as the page polls it. While it is down nothing is sent: a
// request then fails at once, and counted as an error it held off the next one for up to
// 24 s after the link was back. The moment the link is back, whatever waited goes.
export function onLink(s, up, now) {
  if (up === s.linkUp) return null
  s.linkUp = up
  emit(s, up ? 'link_up' : 'link_down')
  if (!up) {
    s.linkDownAt = now
    return null
  }
  s.errors = 0
  s.holdUntil = 0
  // A request out when the link dropped is lost (ZML never rejects it: it would time out 25 s
  // later and hold everything up meanwhile). Let it go; a lyrics poll is made again.
  if (s.inflight && s.inflight.sentAt <= s.linkDownAt) {
    s.inflight.lost = true
    if (s.inflight.kind === 'lyrics') s.nextLyricsAt = Math.min(s.nextLyricsAt, now)
    s.inflight = null
  }
  return decide(s, now)
}

// SELECT or a tap: check now. Paused or not, with or without a song: the person is the
// judge that something is off, and nothing else would send audio while paused.
export function checkNow(s, now) {
  s.wantCheck = true
  s.noServer = false
  s.holdUntil = 0
  return decide(s, now)
}

export function decide(s, now) {
  if (s.inflight || s.noServer || now < s.holdUntil || !s.linkUp) return null
  if (s.source === 'phone') {
    // The phone says where its song is: lyrics and word timings are all that is asked for.
    if (now >= s.nextLyricsAt && s.song && s.song.id) {
      s.nextLyricsAt = Infinity
      return request(s, 'lyrics', 'words', -1, -1, now)
    }
    // Its player paused, the mics look for a song (in takes mode, the takes carry that).
    if (phonePlaying(s) || s.mode === 'takes') return null
  }
  if (s.wantCheck && s.mode !== 'takes' && s.last >= VERIFY_PACKETS - 1) {
    s.wantCheck = false
    const n = looking(s) || clock.isPaused(s.clock) || !s.song.fast ? IDENTIFY_PACKETS : VERIFY_PACKETS
    const purpose = looking(s) ? 'find' : clock.isPaused(s.clock) ? 'resume' : 'sync'
    return request(s, 'identify', purpose, Math.max(0, s.last - n + 1), s.last, now)
  }
  if (s.mode === 'takes') {
    // Audio goes with each take; only word polling is decided here.
    if (now >= s.nextLyricsAt && s.song) {
      s.nextLyricsAt = Infinity
      return request(s, 'lyrics', 'words', -1, -1, now)
    }
    return null
  }
  // 1. Music came back: check it is the same song, at the same place.
  if (s.resumeCheck && s.last >= s.resumeCheck.due) {
    const n = s.song && s.song.fast ? RESUME_PACKETS : IDENTIFY_PACKETS
    const from = Math.max(s.resumeCheck.from, s.last - n + 1)
    s.resumeCheck = null
    if (s.song && !clock.isPaused(s.clock)) return request(s, 'identify', 'resume', from, s.last, now)
  }
  // 1b. The room has been loud since a "resume" the server couldn't place: ask again, with
  // enough audio for Shazam (it may be a different song), less and less often.
  if (s.doubt && s.song && clock.isPaused(s.clock) && s.act.playing && s.last >= s.doubt.due) {
    return request(s, 'identify', 'resume', s.last - IDENTIFY_PACKETS + 1, s.last, now)
  }
  // 2. No song yet: identify once there are 5 s that are mostly music.
  if (looking(s)) {
    if (s.last >= s.nextIdentifyPacket && s.last >= IDENTIFY_PACKETS - 1) {
      const from = s.last - IDENTIFY_PACKETS + 1
      if (loudShare(s, from, s.last) >= LOUD_SHARE) {
        s.nextIdentifyPacket = s.last + IDENTIFY_RETRY_PACKETS
        return request(s, 'identify', 'find', from, s.last, now)
      }
    }
    return null
  }
  // 3. The room stopped sounding like the song: check where the music is, with enough
  // fresh audio for Shazam in case it is a different song.
  if (s.check && s.last >= s.check.due) {
    const from = Math.max(s.check.from, s.playingFrom)
    s.check = null
    if (isPlaying(s) && s.last - from + 1 >= VERIFY_PACKETS) return request(s, 'identify', 'check', from, s.last, now)
  }
  // 4. Playing: re-check the position now and then. Never before a pending resume check
  // (it is the more urgent question), and never with a window that reaches back into the
  // silence before the music came back: the server would place the silence, not the music.
  const from = s.last - (s.song.fast ? VERIFY_PACKETS : IDENTIFY_PACKETS) + 1
  if (isPlaying(s) && !s.resumeCheck && !s.check && now >= s.nextVerifyAt && from >= Math.max(0, s.playingFrom)) {
    if (loudShare(s, from, s.last) >= LOUD_SHARE) return request(s, 'identify', 'sync', from, s.last, now)
  }
  // 5. Word timings still being computed: ask for them when they should be ready.
  if (now >= s.nextLyricsAt) {
    s.nextLyricsAt = Infinity
    return request(s, 'lyrics', 'words', -1, -1, now)
  }
  return null
}

// ---- input: answers -----------------------------------------------------------------

export function onResponse(s, req, res, now) {
  if (s.inflight && s.inflight.id === req.id) s.inflight = null
  // The phone's player plays: what the mics heard is moot (a café's song, found after the
  // earphones started, replaced the song playing in them).
  if (phonePlaying(s) && req.kind === 'identify') return
  res = res || {}
  if (req.lost && !res.ok) return // given up on when the link dropped: its failure means nothing now
  if (res.reason === 'no_server') {
    s.noServer = true
    emit(s, 'no_server')
    return
  }
  if (res.reason === 'phone' || (res.reason && String(res.reason).indexOf('http_') === 0)) {
    s.errors += 1
    s.holdUntil = now + ERROR_BACKOFF_MS * Math.min(s.errors, 4)
    if (req.purpose === 'find') s.nextIdentifyPacket = s.last + 1
    // A lyrics poll lost on the way is made again: with the phone as the clock, no re-sync
    // would bring the lyrics instead.
    if (req.kind === 'lyrics' && s.song) s.nextLyricsAt = Math.min(s.nextLyricsAt, s.holdUntil)
    emit(s, 'problem', { reason: res.reason, message: res.message })
    return
  }
  s.errors = 0
  if (req.kind === 'lyrics') {
    if (s.song && res.song && res.song.id === s.song.id) mergeSongData(s, res, now)
    return
  }
  // An answer about a song we are no longer following (it ended, or another song started
  // while this was in flight) is stale: it restarted the ended song, with a buzz.
  if (req.purpose !== 'find' && (!s.song || req.song !== s.song.id)) return
  if (!res.ok) {
    onMiss(s, req, res, now)
    return
  }
  const id = res.song ? res.song.id : null
  const offset = res.match ? res.match.offsetMs : null
  if (offset === null || offset === undefined || req.startAt === null) return
  // Found by the mics while the phone's player is paused: the room is the clock now (if
  // the phone plays again, it takes over again).
  if (s.source === 'phone') leavePhone(s)
  if (!s.song || s.song.id !== id) {
    startSong(s, res, req, now)
  } else {
    // Audio from after the stop that the server placed in this song: the music is back.
    // Audio from before the stop says nothing about now: an answer to a re-sync sent just
    // before a pause used to un-pause the lyrics, which then ran on past the stop.
    let resumed = false
    if (clock.isPaused(s.clock) && req.startAt > s.clock.pausedAt) {
      clock.resume(s.clock, req.startAt)
      resumed = true
    }
    const r = clock.addMatch(s.clock, req.startAt, offset)
    if (r.kind === 'jump') {
      s.stats.seeks += 1
      activity.forgetTrack(s.act)
      s.track = []
      emit(s, 'seek', { deltaMs: r.deltaMs })
    } else {
      s.stats.refines += 1
      emit(s, 'synced', { kind: r.kind, deltaMs: r.deltaMs, method: res.match.method })
    }
    if (resumed && s.quietAt !== null && s.quietAt > req.startAt) {
      // It was the song, but the room has gone quiet again since: stop where it went quiet,
      // not run on from the confirmation. Any sound since is another stretch (a comeback of
      // its own, in takes mode) and is checked on its own.
      clock.pause(s.clock, s.quietAt)
      resumed = false
      s.doubt = null
      emit(s, 'pause', { at: s.quietAt, confirmed: true })
    }
    if (resumed) {
      s.doubt = null
      s.playingFrom = req.from
      s.stats.resumes += 1
      emit(s, 'resume', { at: req.startAt, packet: req.from, confirmed: true })
    }
    if (!clock.isPaused(s.clock)) {
      activity.markPlaying(s.act)
      s.provisional = false
      s.retries = 0
      s.comeback = null // placed, whoever asked (left behind, it stopped every later re-sync)
    }
    s.heardOnly = false // the watch's own mic has the song now
    mergeSongData(s, res, now)
  }
  s.misses = 0
  s.matches += 1
  s.nextVerifyAt = now + (s.matches <= VERIFY_STEPS_MS.length ? VERIFY_STEPS_MS[s.matches - 1] : VERIFY_MS)
}

function onMiss(s, req, res, now) {
  if (req.purpose === 'find') {
    // Shazam refusing calls: the takes meanwhile would only be refused too (and cost Bluetooth)
    if (res.reason === 'recognizer_busy') s.findHoldUntil = now + (res.retryInMs || 30000)
    emit(s, 'miss', { reason: res.reason })
    return
  }
  if (req.purpose === 'resume') {
    // Only an answer about audio from this stretch of music decides anything about it. A
    // re-check sent while someone was still talking, answered after the music really came
    // back, re-froze the lyrics at a time before that comeback, and the song jumped 7.5 s back.
    if (!clock.isPaused(s.clock) && req.startAt < s.clock.lastPauseEnd) return
    // Nor does one about sound from before the room last went quiet: the sound now is another
    // stretch, and is checked on its own.
    if (clock.isPaused(s.clock) && s.quietAt !== null && req.startAt < s.quietAt) return
    if (res.reason !== 'no_match' && res.reason !== 'bad_audio') {
      // A timeout or a recognizer error says nothing about the music: keep things as they are
      // and ask again with fresh audio, less and less often (instant failures re-sent a 5 s
      // window on every packet: 484 requests in 36 s).
      s.retries += 1
      const n = s.song && s.song.fast ? RESUME_PACKETS : IDENTIFY_PACKETS
      const wait = n * Math.min(DOUBT_BACKOFF_MAX, Math.pow(2, s.retries - 1)) // a fresh window, then 2, 4, 8
      if (clock.isPaused(s.clock)) {
        if (s.doubt) s.doubt = { due: s.last + wait, wait: Math.max(s.doubt.wait, wait) }
        if (s.comeback) s.comeback.due = s.last + wait
      } else if (s.retries <= 3) {
        s.resumeCheck = { from: s.last + 1, due: s.last + wait }
      } else {
        s.provisional = false // the server can't say; the room says music: believe the room
      }
      return
    }
    // The server couldn't place it in this song: maybe noise or talking, maybe music it can't
    // place from this little audio (a different song, or no fast re-sync yet). Freeze again
    // where we were, and keep asking with 5 s while the room stays loud. (Treating the first
    // "no" as final, with a bar raised above that sound, left real music unable to resume.)
    if (s.song && clock.isKnown(s.clock) && !clock.isPaused(s.clock)) clock.pause(s.clock, req.startAt)
    const wait = s.doubt ? Math.min(s.doubt.wait * 2, IDENTIFY_PACKETS * DOUBT_BACKOFF_MAX) : IDENTIFY_PACKETS
    s.doubt = { due: s.last + wait, wait }
    s.comeback = null // the doubt asks from here on
    s.provisional = false
    if (s.levelAtPause !== null) s.act.musicLevel = s.levelAtPause // undo anything the sound taught it
    activity.rejectResume(s.act, maxGain(s, req.from, req.to))
    s.stats.rejected += 1
    emit(s, 'resume_rejected')
    return
  }
  // A periodic check failed. Keep the lyrics running; two in a row and look for a new song.
  // Unless the server couldn't say (Shazam refusing calls, a timeout): that says nothing about
  // the song, and three such in a row used to end it. Nor can the watch's own mic say, for a
  // song only the phone's mic has heard (a gym too loud to place the watch's audio in).
  if (s.heardOnly || (res.reason !== 'no_match' && res.reason !== 'bad_audio')) {
    s.nextVerifyAt = now + 15000
    return
  }
  s.misses += 1
  s.nextVerifyAt = now + (s.misses >= 2 ? 5000 : 15000)
  if (s.misses >= 3) {
    emit(s, 'lost', { title: s.song ? s.song.title : null })
    endSong(s)
  }
}

function maxGain(s, from, to) {
  let m = 0
  for (let i = Math.max(from, s.last - MAX_GAINS + 1); i <= to; i++) m = Math.max(m, s.gains[i % MAX_GAINS] || 0)
  return m
}

function startSong(s, res, req, now) {
  s.track = []
  s.match = { last: null, baseline: null, low: 0, checks: 0 }
  s.check = null
  const song = res.song || {}
  s.song = {
    id: song.id,
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    durationMs: song.durationMs || null,
    kind: 'none',
    lines: [],
    lyricsVersion: null,
    words: null,
    envelope: null,
    fast: false, // the server has this song's audio: 2-3 s windows are enough to place it
  }
  clock.reset(s.clock)
  clock.setRatePrior(s.clock, res.match.skew)
  clock.addMatch(s.clock, req.startAt, res.match.offsetMs)
  activity.forgetTrack(s.act)
  activity.markPlaying(s.act)
  s.resumeCheck = null
  s.comeback = null
  s.doubt = null
  s.heardOnly = false
  s.provisional = false
  s.retries = 0
  s.quietAt = null
  s.levelAtPause = null
  s.playingFrom = req.from
  s.misses = 0
  s.matches = 0
  mergeSongData(s, res, now)
  emit(s, 'song', { title: s.song.title, artist: s.song.artist })
}

// Lyrics, word status and the loudness track, each only when the server sent a new version.
function mergeSongData(s, res, now) {
  const song = s.song
  // its length, if it wasn't known when the song started (a song the phone's mic named first)
  if (res.song && res.song.durationMs && !song.durationMs) song.durationMs = res.song.durationMs
  if (res.lyrics && res.lyrics.version !== song.lyricsVersion) {
    song.kind = res.lyrics.kind || 'none'
    song.lines = normalizeLines(res.lyrics.lines || [])
    song.lyricsVersion = res.lyrics.version || null
    emit(s, 'lyrics', { version: song.lyricsVersion, words: countWordLines(song.lines) })
  }
  if (res.envelope && (!song.envelope || res.envelope.version !== song.envelope.version)) {
    song.envelope = decodeEnvelope(res.envelope)
    activity.forgetTrack(s.act)
  }
  if (res.sync) song.fast = !!res.sync.fast
  if (song.kind === 'pending') {
    s.pendingPolls = (s.pendingPolls || 0) + 1
    s.nextLyricsAt = now + Math.min(LYRICS_PENDING_POLL_MAX_MS, LYRICS_PENDING_POLL_MS * Math.pow(1.5, s.pendingPolls - 1))
    return
  }
  s.pendingPolls = 0
  if (res.words) {
    song.words = res.words
    const eta = res.words.etaMs || 8000
    // Words due soon: ask then. Words far off (the server is waiting to retry a download):
    // don't poll; the re-syncs every 30 s carry `known` and bring them when they exist. With
    // the phone as the clock there are no re-syncs: ask when they are due, however far off.
    if (res.words.status === 'pending' && (eta <= 30000 || s.source === 'phone')) s.nextLyricsAt = now + Math.max(3000, eta)
    else s.nextLyricsAt = Infinity
  }
}

// Lines arrive as [startMs, text, wordStartsOrNull, endMsOrNull]. A word list that doesn't
// match the text's words (it should always) is dropped: that line is shown line by line.
export function normalizeLines(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || typeof l[0] !== 'number') continue
    const text = typeof l[1] === 'string' ? l[1] : ''
    let words = Array.isArray(l[2]) ? l[2] : null
    if (words && words.length !== splitWords(text).length) words = null
    out.push([l[0], text, words, typeof l[3] === 'number' ? l[3] : null])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

function countWordLines(lines) {
  let n = 0
  for (let i = 0; i < lines.length; i++) if (lines[i][2]) n += 1
  return n
}

// The page drains events after each call.
export function takeEvents(s) {
  const e = s.events
  s.events = []
  return e
}
