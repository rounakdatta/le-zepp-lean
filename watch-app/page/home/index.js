// LeZeppLean main page: a listening session.
//
// Open the app and it listens. The mic records continuously; every 60 ms packet is read
// as it is written (lib/live.js), so the watch knows within a quarter of a second when
// the music stops or comes back, and freezes or resumes the lyrics on the packet it
// happened. Short windows of that recording go through the phone to the server, which
// names the song, says where in it the window started, and sends lyrics timed word by
// word. Between those, the song clock (lib/clock.js) runs on its own.
//
// If this firmware only makes the recording readable once it stops, the page falls back
// to separate 5-second takes, as v0.1 did: everything still works, pauses are just
// noticed at the next take instead of at the next packet.
//
// Keys: SELECT = re-sync now, UP = lyrics earlier, DOWN = lyrics later,
//       hold SELECT = diagnostics, BACK = exit. Tapping the screen also re-syncs.
//
// Entry file: imports only, never `export` (an export here gives a black screen).
import { onKey, offKey, KEY_UP, KEY_DOWN, KEY_SELECT, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS, showToast } from '@zos/interaction'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { Vibrator, VIBRATOR_SCENE_SHORT_STRONG } from '@zos/sensor'
import { getSystemInfo } from '@zos/settings'
import { log } from '@zos/utils'
import { BasePage } from '@zeppos/zml/base-page'
import { recordClip } from '../../lib/recorder.js'
import { startLive, stopLive, packetTime as livePacketTime } from '../../lib/live.js'
import { createPacketStream, feed, windowBytes } from '../../lib/stream.js'
import { silkLevel } from '../../lib/silk.js'
import { createView } from '../../lib/view.js'
import { loadPrefs, savePrefs } from '../../lib/prefs.js'
import * as sync from '../../lib/sync.js'
import * as clock from '../../lib/clock.js'
import * as session from '../../lib/session.js'
import { pauseThreshold } from '../../lib/activity.js'

const logger = log.getLogger('lezepplean')

const LINE_LEAD_MS = 300 // a line appears this early, so it can be read before it is sung
const WORD_LEAD_MS = 40 // a word lights this early, to cover the time it takes to draw
const NUDGE_MS = 100
const REQUEST_TIMEOUT_MS = 25000
const TICK_MS = 200
const HINT_MS = 8000 // the key hint shows when the first lyrics do, then gets out of the way
// Takes (fallback when the recording can't be read while it's written)
const TAKE_MS = 5000
const TAKE_GAP_MS = 8000 // between one take's stop() and the next start(): quick re-takes can lock the mic
const STALL_MS = 4000 // live packets stopped arriving this long: the recording is stuck; switch to takes

let page = null
let view = null
let prefs = { adjustMs: 0 }
let s = session.createSession()
let mode = 'starting' // 'live' | 'takes'
let live = null
let takePacket = 0
let takeTimer = null
let lastStopAt = 0
let recording = false
let lineTimer = null
let tickTimer = null
let shown = { line: -2, word: -2, version: null }
let debugOn = false
let diag = {}
let system = {}
let startedAt = 0
let hintShownAt = 0

function guard(name, fn) {
  return function () {
    try {
      return fn.apply(this, arguments)
    } catch (e) {
      logger.error(name + ': ' + e)
      if (e && e.stack) String(e.stack).split('\n').forEach((l) => logger.error(l))
    }
  }
}

Page(
  BasePage({
    onInit: guard('onInit', function () {
      page = this
      prefs = loadPrefs()
      try {
        system = getSystemInfo() || {}
      } catch (e) {
        system = {}
      }
    }),

    build: guard('build', function () {
      page = this
      startedAt = Date.now()
      view = createView({ onTap: guard('tap', () => resyncNow('tap')) })
      view.showMessage('Listening…', 'Hold the watch near the music')
      setPageBrightTime({ brightTime: 60 * 60 * 1000 })
      pauseDropWristScreenOff({ duration: 0 })
      onKey({ callback: guard('key', onKeyEvent) })
      tickTimer = setInterval(guard('tick', tick), TICK_MS)
      startListening()
    }),

    onDestroy: guard('onDestroy', function () {
      clearTimeout(lineTimer)
      clearTimeout(takeTimer)
      clearInterval(tickTimer)
      stopLive(live)
      offKey()
      resetDropWristScreenOff()
      resetPageBrightTime()
      savePrefs(prefs)
    }),
  }),
)

// ---- listening ------------------------------------------------------------------

function startListening() {
  live = startLive({
    onLive: guard('onLive', () => {
      mode = 'live'
      diag.mode = 'live'
      diag.firstGrowthMs = live.firstGrowthMs
      refreshDebug()
    }),
    onPacket: guard('onPacket', (index, gain) => {
      if (gain === null) return
      const now = Date.now()
      const req = session.onPacket(s, index, gain, livePacketTime(live, index), now)
      afterSession(req, now)
    }),
    onTake: guard('onTake', (take) => {
      // This firmware writes the file only at stop(): carry on with separate takes.
      mode = 'takes'
      diag.mode = 'takes'
      diag.probe = take.probe
      s.mode = 'takes'
      lastStopAt = Date.now()
      if (take.buffer && take.bytes) onTake(take)
      else scheduleTake(TAKE_GAP_MS)
    }),
    onError: guard('onLiveError', (code, message) => {
      diag.problem = code + (message ? ': ' + message : '')
      logger.error('live ' + diag.problem)
      if (code === 'recorder_unavailable' || code === 'recorder_start_failed') {
        view.showMessage('Microphone unavailable', message || '')
        view.setStatus('Press SELECT to retry')
        mode = 'stopped'
      }
      refreshDebug()
    }),
  })
}

// Takes mode: record, hand the take to the session, wait, repeat.
function scheduleTake(ms) {
  clearTimeout(takeTimer)
  takeTimer = setTimeout(guard('take', takeNow), Math.max(0, ms))
}

function takeNow() {
  if (recording || mode !== 'takes') return
  const wait = lastStopAt + TAKE_GAP_MS - Date.now()
  if (wait > 0) {
    scheduleTake(wait)
    return
  }
  recording = true
  view.setListening(true)
  recordClip(
    TAKE_MS,
    guard('recorded', (rec) => {
      recording = false
      lastStopAt = Date.now()
      view.setListening(false)
      if (rec.error) {
        diag.problem = rec.error
        refreshDebug()
        scheduleTake(rec.error === 'empty_recording' ? TAKE_GAP_MS * 2 : TAKE_GAP_MS)
        return
      }
      onTake(rec)
    }),
  )
}

function onTake(take) {
  // Feed the take's packets through the session (its loudness drives pause detection),
  // timed back from the stop: capture starts late, but ends at stop().
  const stream = createPacketStream(140)
  const packets = []
  feed(stream, new Uint8Array(take.buffer), (bytes) => packets.push(bytes))
  const n = packets.length
  const firstAt = take.stoppedAt - n * session.PACKET_MS
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    const level = silkLevel(packets[i], 0, packets[i].length)
    if (level) session.onPacket(s, takePacket + i, level.gain, firstAt + i * session.PACKET_MS, now)
  }
  const from = takePacket
  takePacket += n + 1000 // a gap in the indices marks the gap between takes
  handleEvents()
  const req = session.takeRequest(s, from, from + n - 1, firstAt, now)
  req.take = { startedAt: take.startedAt, stoppedAt: take.stoppedAt } // its answer is anchored on this take, not the latest
  send(req, take.buffer)
}

// After any session input: draw what changed, and send what it asked for.
function afterSession(req, now) {
  handleEvents()
  if (req) send(req, null)
}

function send(req, takeBuffer) {
  const params = {
    purpose: req.purpose,
    song: req.song,
    expectMs: req.expectMs === null ? null : Math.round(req.expectMs),
    known: req.known,
    diag: requestDiag(),
  }
  let method = 'lyrics'
  if (req.kind === 'identify') {
    method = 'identify'
    let bytes = null
    if (takeBuffer) {
      bytes = takeBuffer
    } else if (live) {
      const w = windowBytes(live.stream, req.from, req.to + 1)
      bytes = w.bytes
      if (w.packets && w.first !== req.from) {
        // Some of the window had already left the buffer: anchor on the audio actually sent.
        req.startAt += (w.first - req.from) * session.PACKET_MS
        if (req.expectMs !== null) req.expectMs += (w.first - req.from) * session.PACKET_MS * s.clock.rate
        req.from = w.first
      }
    }
    if (!bytes || !bytes.byteLength) {
      session.onResponse(s, req, { ok: false, reason: 'bad_audio' }, Date.now())
      return
    }
    params.audio = Buffer.from(bytes).toString('base64')
    params.clipMs = (req.to - req.from + 1) * session.PACKET_MS
  }
  const sentAt = Date.now()
  page
    .request({ method, params }, { timeout: REQUEST_TIMEOUT_MS })
    .then(guard('result', (res) => onAnswer(req, res || {}, Date.now() - sentAt)))
    .catch(guard('request', (err) => onAnswer(req, { ok: false, reason: 'phone', message: describeRequestError(err) }, Date.now() - sentAt)))
}

function onAnswer(req, res, roundTripMs) {
  diag.roundTripMs = roundTripMs
  diag.serverMs = res.timing && res.timing.totalMs
  diag.method = res.match && res.match.method
  diag.reason = res.ok ? null : res.reason
  if (req.take && res.clip && res.clip.ms && req.kind === 'identify') {
    // The decoded length pins the take's real start (the mic starts ~0.33 s after start()).
    const start = sync.clipStartMs(req.take.startedAt, req.take.stoppedAt, res.clip.ms)
    req.startAt = start.at
    diag.anchor = start.anchor
  }
  const now = Date.now()
  session.onResponse(s, req, res, now)
  handleEvents()
  if (mode === 'takes' && req.kind === 'identify') scheduleTake(TAKE_GAP_MS)
  const next = session.decide(s, now)
  if (next) send(next, null)
}

// ---- what the session says happened ----------------------------------------------------

function handleEvents() {
  const events = session.takeEvents(s)
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    diag.lastEvent = e.type
    if (e.type === 'song') {
      view.forgetLayouts()
      view.showSong(s.song)
      shown = { line: -2, word: -2, version: null }
      buzz()
      if (!hintShownAt) {
        // The nudge keys only mean something once there are lyrics to nudge: say so then, once.
        hintShownAt = Date.now()
        view.setStatus(hint())
      }
    } else if (e.type === 'pause') {
      view.setPaused(true)
    } else if (e.type === 'resume' || e.type === 'resume_rejected') {
      view.setPaused(e.type === 'resume_rejected')
    } else if (e.type === 'ended' || e.type === 'lost') {
      clearTimeout(lineTimer)
      view.setPaused(false)
      view.showMessage(e.type === 'ended' ? 'Song ended' : 'Lost the song', 'Listening for the next one')
      view.setSongProgress(0)
    } else if (e.type === 'no_server') {
      view.showMessage('Server not set', 'Zepp app → LeZeppLean → settings')
      view.setStatus('Then press SELECT')
    } else if (e.type === 'problem') {
      view.setStatus(problemText(e.reason))
    } else if (e.type === 'miss' && !s.song) {
      view.showMessage('Listening…', 'Not recognised yet — still trying')
    }
  }
  if (events.length) {
    refresh()
    refreshDebug()
  }
}

// ---- lyrics timing ----------------------------------------------------------------

// Shows the right line and word now, and sets one timer for the exact moment either changes.
function refresh() {
  clearTimeout(lineTimer)
  lineTimer = null
  const song = s.song
  if (!song || !clock.isKnown(s.clock)) return
  if (!song.lines.length) {
    if (shown.line !== -3) {
      view.showSong(song)
      shown = { line: -3, word: -2, version: song.lyricsVersion }
    }
    return
  }
  const now = Date.now()
  const pos = session.position(s, now, prefs.adjustMs)
  const d = sync.displayAt(song.lines, pos, LINE_LEAD_MS, WORD_LEAD_MS)
  if (d.line !== shown.line || song.lyricsVersion !== shown.version) {
    view.showLine(song.lines, d.line, song.lyricsVersion)
    shown = { line: d.line, word: -2, version: song.lyricsVersion }
    // Lay the next line out now, while nothing else is happening.
    setTimeout(guard('prepare', () => view.prepare(song.lines, d.line + 1, song.lyricsVersion)), 0)
  }
  if (d.word !== shown.word) {
    view.setWord(d.word)
    shown.word = d.word
  }
  if (clock.isPaused(s.clock) || d.waitMs === null) return
  const wait = d.waitMs / s.clock.rate
  lineTimer = setTimeout(guard('line', refresh), Math.max(10, wait + 5))
}

function tick() {
  const now = Date.now()
  if (mode === 'live' && live && live.lastGrowthAt && now - live.lastGrowthAt > STALL_MS) {
    // The recording stopped growing (the recorder gave up, or the file is stuck): carry on
    // with takes rather than sit there frozen with a "playing" song.
    logger.error('live recording stalled; switching to takes')
    diag.problem = 'live stalled'
    stopLive(live)
    live = null
    mode = 'takes'
    s.mode = 'takes'
    lastStopAt = now
    scheduleTake(TAKE_GAP_MS)
  }
  const req = session.onTick(s, now)
  afterSession(req, now)
  if (!s.song || !clock.isKnown(s.clock)) {
    if (mode === 'takes' && recording) view.setSongProgress(0)
    return
  }
  const pos = session.position(s, now, prefs.adjustMs)
  if (s.song.durationMs) view.setSongProgress(pos / s.song.durationMs)
  if (s.song.lines.length && shown.line >= 0) {
    view.setLineProgress(sync.lineProgress(s.song.lines, shown.line, pos + LINE_LEAD_MS, s.song.durationMs))
  }
  if (hintShownAt && now - hintShownAt > HINT_MS && !diag.hintCleared) {
    diag.hintCleared = true
    if (!clock.isPaused(s.clock)) view.setStatus('')
  }
  if (debugOn && now % 1000 < TICK_MS) refreshDebug()
}

// ---- input ----------------------------------------------------------------------

function resyncNow(reason) {
  if (mode === 'stopped') {
    mode = 'starting'
    view.showMessage('Listening…', 'Hold the watch near the music')
    startListening()
    return
  }
  if (mode === 'takes') {
    takeNow()
    return
  }
  const now = Date.now()
  afterSession(session.checkNow(s, now), now)
  diag.lastManual = reason
}

function onKeyEvent(key, keyEvent) {
  if (keyEvent === KEY_EVENT_CLICK) {
    if (key === KEY_SELECT) {
      resyncNow('select')
      return true
    }
    if (key === KEY_UP || key === KEY_DOWN) {
      nudge(key === KEY_UP ? NUDGE_MS : -NUDGE_MS)
      return true
    }
  }
  if (keyEvent === KEY_EVENT_LONG_PRESS && key === KEY_SELECT) {
    debugOn = !debugOn
    refreshDebug()
    return true
  }
  return false
}

function nudge(deltaMs) {
  prefs.adjustMs += deltaMs
  savePrefs(prefs)
  const total = (prefs.adjustMs > 0 ? '+' : '') + (prefs.adjustMs / 1000).toFixed(1) + ' s'
  showToast({ content: (deltaMs > 0 ? 'Lyrics earlier' : 'Lyrics later') + ' (' + total + ')' })
  refresh()
}

// ---- helpers --------------------------------------------------------------------

function requestDiag() {
  return {
    mode,
    os: system.osVersion,
    fw: system.firmwareVersion,
    api: system.minAPI,
    firstGrowthMs: live ? live.firstGrowthMs : null,
    growths: live ? live.growths : null,
    probe: live && live.probe && live.probe.length <= 30 ? live.probe : undefined,
    stats: s.stats,
    rate: s.clock.rate,
  }
}

function refreshDebug() {
  if (!debugOn) {
    view.setDebug(null)
    return
  }
  const a = s.act
  const c = s.clock
  const w = s.song && s.song.words
  view.setDebug(
    [
      'API ' + (system.minAPI || '?') + ' · FW ' + (system.firmwareVersion || '?') + ' · ' + mode,
      'gain thr ' + Math.round(pauseThreshold(a)) + ' · floor ' + Math.round(a.floor) + ' · music ' + Math.round(a.musicLevel) + (a.offsetN ? ' · track ' + Math.round(a.offset) : ''),
      (c.pausedAt !== null ? 'paused' : 'playing') + ' · matches ' + c.samples.length + ' · rate ' + c.rate.toFixed(4) + ' · adj ' + prefs.adjustMs,
      'pauses ' + s.stats.pauses + ' · resumes ' + s.stats.resumes + ' · refused ' + s.stats.rejected,
      'skips ' + s.stats.seeks + ' · round trip ' + (diag.roundTripMs || '?') + ' ms',
      'server ' + (diag.serverMs || '?') + ' ms · ' + (diag.method || diag.reason || '—') + (w ? ' · words ' + w.status + (w.aligned !== undefined ? ' ' + w.aligned + '/' + w.of : '') : ''),
      diag.problem ? 'last problem: ' + diag.problem : '',
    ].join('\n'),
  )
}

function hint() {
  return '▲▼ lyrics earlier / later'
}

function problemText(reason) {
  if (reason === 'phone') return 'Phone unreachable — retrying'
  if (reason && String(reason).indexOf('http_') === 0) return 'Server error — retrying'
  return 'Something went wrong — retrying'
}

function describeRequestError(err) {
  const code = err && (err.code || err.errorCode)
  if (code === 1) return 'phone did not answer (is the Zepp app running?)'
  if (code === 2) return 'Bluetooth disconnected'
  if (code === 3) return 'phone-side service not running'
  if (code === 4) return 'request timed out'
  return (err && err.message) || String(err)
}

function buzz() {
  try {
    const vibrator = new Vibrator()
    vibrator.stop()
    vibrator.start({ mode: VIBRATOR_SCENE_SHORT_STRONG })
  } catch (e) {
    // haptics are a nicety
  }
}
