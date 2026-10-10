// LeZeppLean main page: a listening session.
//
// Open the app and it starts listening. Each take is a short mic clip sent through the
// phone to the recognition server, which answers with the song, where in the song the
// clip started, and time-stamped lyrics. The page then shows the lyrics in time and keeps
// re-listening to stay in sync and to notice when the next song starts.
//
// Keys: SELECT = listen now, UP = lyrics earlier, DOWN = lyrics later,
//       hold SELECT = diagnostics, BACK = exit. Tapping the screen also listens.
//
// Entry file: imports only, never `export` (an export here gives a black screen).
import { onKey, offKey, KEY_UP, KEY_DOWN, KEY_SELECT, KEY_EVENT_CLICK, KEY_EVENT_LONG_PRESS, showToast } from '@zos/interaction'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { Vibrator, VIBRATOR_SCENE_SHORT_STRONG } from '@zos/sensor'
import { getSystemInfo } from '@zos/settings'
import { log } from '@zos/utils'
import { BasePage } from '@zeppos/zml/base-page'
import { recordClip } from '../../lib/recorder'
import { createView } from '../../lib/view'
import { loadPrefs, savePrefs } from '../../lib/prefs'
import * as sync from '../../lib/sync'

const logger = log.getLogger('lezepplean')

const CLIP_MS = 5000
const MIN_GAP_MS = 8000 // between one take's stop() and the next start(): quick re-takes can lock the mic
const RESYNC_SOON_MS = 20000 // a second take soon after the first confirms and tightens the sync
const RESYNC_MS = 45000
const RETRY_MS = 5000 // plus MIN_GAP_MS, so about every 13 s while nothing matches
const MAX_MISSES = 6
const LEAD_MS = 150 // show each line slightly before it is sung
const NUDGE_MS = 100
const REQUEST_TIMEOUT_MS = 25000

let page = null
let view = null
let prefs = { adjustMs: 0 }
let song = null // { key, title, artist, durationMs, kind, lines }
let clock = sync.createClock()
let recording = false
let recordingSince = 0
let lastStopAt = 0
let misses = 0
let lastIdx = -2
let lineTimer = null
let tickTimer = null
let listenTimer = null
let debugOn = false
let diag = {}
let system = {}

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
      view = createView({ onTap: guard('tap', () => listen('tap')) })
      view.showMessage('Listening…', 'Hold the watch near the music')
      view.setStatus(hint())
      setPageBrightTime({ brightTime: 60 * 60 * 1000 })
      pauseDropWristScreenOff({ duration: 0 })
      onKey({ callback: guard('key', onKeyEvent) })
      tickTimer = setInterval(guard('tick', tick), 200)
      listen('launch')
    }),

    onDestroy: guard('onDestroy', function () {
      clearTimeout(lineTimer)
      clearTimeout(listenTimer)
      clearInterval(tickTimer)
      offKey()
      resetDropWristScreenOff()
      resetPageBrightTime()
      savePrefs(prefs)
    }),
  }),
)

// ---- listening ------------------------------------------------------------------

function listen(reason) {
  clearTimeout(listenTimer)
  listenTimer = null
  if (recording) return
  const wait = lastStopAt + MIN_GAP_MS - Date.now()
  if (wait > 0) {
    listenTimer = setTimeout(guard('listen', () => listen(reason)), wait)
    if (!song) view.setStatus('Listening in ' + Math.ceil(wait / 1000) + ' s…')
    return
  }
  recording = true
  recordingSince = Date.now()
  view.setListening(true)
  view.setStatus(song ? '● Re-syncing' : '● Listening')
  if (!song) view.showMessage('Listening…', 'Hold the watch near the music')

  recordClip(
    CLIP_MS,
    guard('recorded', (rec) => {
      recording = false
      lastStopAt = Date.now()
      view.setListening(false)
      if (rec.error) {
        onProblem(rec.error, rec.message)
        return
      }
      identify(rec, reason)
    }),
  )
}

function identify(rec, reason) {
  if (!song) view.showMessage('Finding the song…', formatKb(rec.bytes) + ' clip sent to phone')
  const sentAt = Date.now()
  const audio = Buffer.from(rec.buffer).toString('base64')
  diag = {
    reason,
    bytes: rec.bytes,
    recMs: rec.stoppedAt - rec.startedAt,
    startCallMs: rec.startCallMs,
    settleMs: rec.settleMs,
    os: system.osVersion,
    fw: system.firmwareVersion,
    api: system.minAPI,
  }
  page
    .request({ method: 'identify', params: { audio, clipMs: CLIP_MS, diag } }, { timeout: REQUEST_TIMEOUT_MS })
    .then(guard('result', (res) => onResult(res || {}, rec, Date.now() - sentAt)))
    .catch(guard('request', (err) => onProblem('phone', describeRequestError(err))))
}

function onResult(res, rec, roundTripMs) {
  diag.roundTripMs = roundTripMs
  diag.serverMs = res.timing && res.timing.totalMs
  diag.phoneMs = res.phoneMs
  diag.decodedMs = res.clip && res.clip.ms
  diag.levelDb = res.clip && res.clip.rmsDb
  if (!res.ok) {
    onMiss(res)
    return
  }

  const start = sync.clipStartMs(rec.startedAt, rec.stoppedAt, res.clip && res.clip.ms)
  diag.anchor = start.anchor
  diag.latencyMs = start.latencyMs
  diag.offsetMs = res.match.offsetMs

  const key = ((res.track.title || '') + '|' + (res.track.artist || '')).toLowerCase()
  if (!song || song.key !== key) {
    song = {
      key,
      title: res.track.title,
      artist: res.track.artist,
      durationMs: res.track.durationMs,
      kind: res.lyrics && res.lyrics.kind,
      lines: (res.lyrics && res.lyrics.kind === 'synced' && res.lyrics.lines) || [],
    }
    clock = sync.createClock()
    lastIdx = -2
    view.showSong(song)
    buzz()
  }
  sync.addEstimate(clock, start.at - res.match.offsetMs)
  misses = 0
  view.setStatus(hint())
  refreshDebug()
  scheduleLine()
  scheduleListen(clock.samples.length < 2 ? RESYNC_SOON_MS : RESYNC_MS)
}

function onMiss(res) {
  const reason = res.reason || 'error'
  refreshDebug()
  if (reason === 'no_server') {
    view.showMessage('Server not set', 'Zepp app → LeZeppLean → settings')
    view.setStatus('Then press SELECT')
    return
  }
  if (song) {
    // Keep the lyrics running; the song-end check starts listening for the next one.
    view.setStatus(reasonText(res) + ' · keeping sync')
    scheduleListen(reason === 'no_match' ? 15000 : 30000)
    return
  }
  misses += 1
  if (misses >= MAX_MISSES) {
    misses = 0
    view.showMessage(reasonText(res), 'Press SELECT to listen again')
    view.setStatus(hint())
    return
  }
  view.showMessage(reasonText(res), 'Trying again…')
  scheduleListen(RETRY_MS)
}

function onProblem(code, message) {
  logger.error('problem ' + code + ' ' + (message || ''))
  diag.problem = code + (message ? ': ' + message : '')
  refreshDebug()
  if (code === 'empty_recording') {
    view.showMessage('Mic returned no audio', 'If this repeats, restart the watch')
    scheduleListen(RETRY_MS * 2)
    return
  }
  if (code === 'recorder_unavailable' || code === 'recorder_start_failed') {
    view.showMessage('Microphone unavailable', message || '')
    view.setStatus('Press SELECT to retry')
    return
  }
  onMiss({ ok: false, reason: code, message })
}

function scheduleListen(ms) {
  clearTimeout(listenTimer)
  listenTimer = setTimeout(guard('scheduled', () => listen('resync')), ms)
}

// ---- lyrics timing ----------------------------------------------------------------

// Shows the right line now and sets a timer for the exact moment the next one starts.
function scheduleLine() {
  clearTimeout(lineTimer)
  lineTimer = null
  if (!song || clock.start === null || !song.lines.length) return
  const displayPos = sync.positionAt(clock, Date.now(), prefs.adjustMs) + LEAD_MS
  const idx = sync.lineIndexAt(song.lines, displayPos)
  if (idx !== lastIdx) {
    lastIdx = idx
    view.showLine(song.lines, idx)
  }
  const wait = sync.msUntilNextLine(song.lines, idx, displayPos)
  if (wait !== null) lineTimer = setTimeout(guard('line', scheduleLine), Math.max(10, wait + 5))
}

function tick() {
  const now = Date.now()
  if (recording && !song) {
    view.setSongProgress((now - recordingSince) / CLIP_MS)
    return
  }
  if (!song || clock.start === null) return
  const pos = sync.positionAt(clock, now, prefs.adjustMs)
  if (song.durationMs && pos > song.durationMs + 1500) {
    endSong()
    return
  }
  if (song.durationMs) view.setSongProgress(pos / song.durationMs)
  if (song.lines.length) view.setLineProgress(sync.lineProgress(song.lines, lastIdx, pos + LEAD_MS, song.durationMs))
}

function endSong() {
  song = null
  clock = sync.createClock()
  clearTimeout(lineTimer)
  view.showMessage('Song ended', 'Listening for the next one')
  view.setSongProgress(0)
  listen('next-song')
}

// ---- input ----------------------------------------------------------------------

function onKeyEvent(key, keyEvent) {
  if (keyEvent === KEY_EVENT_CLICK) {
    if (key === KEY_SELECT) {
      listen('manual')
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
  scheduleLine()
}

// ---- helpers --------------------------------------------------------------------

function refreshDebug() {
  if (!debugOn) {
    view.setDebug(null)
    return
  }
  const d = diag
  view.setDebug(
    [
      'API ' + (d.api || '?') + ' · FW ' + (d.fw || '?'),
      'clip ' + formatKb(d.bytes) + ' · rec ' + d.recMs + ' ms · decoded ' + (d.decodedMs || '?') + ' ms',
      'start() ' + d.startCallMs + ' ms · settle ' + d.settleMs + ' ms · level ' + (d.levelDb != null ? d.levelDb + ' dB' : '?'),
      'round trip ' + (d.roundTripMs || '?') + ' ms (server ' + (d.serverMs || '?') + ', phone ' + (d.phoneMs || '?') + ')',
      'offset ' + (d.offsetMs != null ? (d.offsetMs / 1000).toFixed(2) + ' s' : '?') + ' · anchor ' + (d.anchor || '?') + ' ' + (d.latencyMs != null ? d.latencyMs + ' ms' : ''),
      'estimates ' + clock.samples.length + ' · adjust ' + prefs.adjustMs + ' ms',
      d.problem ? 'last problem: ' + d.problem : '',
    ].join('\n'),
  )
}

function hint() {
  return 'SELECT listen · ▲▼ sync'
}

function reasonText(res) {
  switch (res.reason) {
    case 'no_match':
      return 'No match'
    case 'phone':
      return 'Phone unreachable'
    case 'bad_audio':
      return 'Recording unreadable'
    case 'recognizer_timeout':
    case 'recognizer_error':
      return 'Recognizer unavailable'
    default:
      return res.message || 'Something went wrong'
  }
}

function describeRequestError(err) {
  const code = err && (err.code || err.errorCode)
  if (code === 1) return 'phone did not answer (is the Zepp app running?)'
  if (code === 2) return 'Bluetooth disconnected'
  if (code === 3) return 'phone-side service not running'
  if (code === 4) return 'request timed out'
  return (err && err.message) || String(err)
}

function formatKb(bytes) {
  return bytes ? (bytes / 1024).toFixed(1) + ' KB' : '?'
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
