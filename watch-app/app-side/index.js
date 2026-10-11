// Runs inside the Zepp app on the phone. The watch has no internet of its own, so this
// relays each mic clip to the recognition server and hands the answer back. It also
// follows what the phone itself is playing (the LeZeppLean helper app reports it to the
// server) and tells the watch the moment that changes: music in earphones, followed
// exactly, with no mic at all.
import { BaseSideService, settingsLib } from '@zeppos/zml/base-side'
import { DEFAULT_SERVER_URL, DEFAULT_TOKEN } from './defaults'
import { listenAuthorization } from './sign'

// The phone's HTTP client is reported to drop requests after ~10 s of silence, so answer
// well before that; the server itself gives the recognizer at most 6 s.
const FETCH_TIMEOUT_MS = 9500

// Values typed into the LeZeppLean settings win; otherwise use the ones built into this install.
function config() {
  const url = String(settingsLib.getItem('serverUrl') || DEFAULT_SERVER_URL || '').trim().replace(/\/+$/, '')
  const token = String(settingsLib.getItem('token') || DEFAULT_TOKEN || '').trim()
  return { url, token }
}

// The scripts the person reads (the settings page's toggles): their songs come in their own
// script; everything else in English letters.
function readScripts() {
  const out = []
  ;['Devanagari', 'Bengali', 'Tamil', 'Malayalam', 'Kannada', 'Arabic'].forEach((s) => {
    const v = settingsLib.getItem('read_' + s)
    if (v === true || v === 'true') out.push(s)
  })
  return out
}

function headers(token, json) {
  const h = {}
  if (json) h['Content-Type'] = 'application/json'
  if (token) h.Authorization = 'Bearer ' + token
  return h
}

function get(path) {
  const { url, token } = config()
  if (!url) return Promise.reject(new Error('no server'))
  return fetch({ url: url + path, method: 'GET', headers: headers(token, false), timeout: FETCH_TIMEOUT_MS }).then((res) => {
    if (res.status >= 400) throw new Error('http ' + res.status)
    return parseBody(res)
  })
}

function parseBody(res) {
  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body
}

function post(path, payload) {
  const { url, token } = config()
  if (!url) return Promise.resolve({ ok: false, reason: 'no_server', message: 'Set the server URL in LeZeppLean settings' })
  const startedAt = Date.now()
  return fetch({
    url: url + path,
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(payload),
    timeout: FETCH_TIMEOUT_MS,
  }).then((res) => {
    const body = parseBody(res) || {}
    if (res.status >= 400) {
      return { ok: false, reason: 'http_' + res.status, message: 'Server error ' + res.status + (body.detail ? ': ' + body.detail : '') }
    }
    body.phoneMs = Date.now() - startedAt
    return body
  })
}

// A recording from the watch: which song, where in it, and what has changed.
function identify(params) {
  return post('/identify', {
    audio: params.audio,
    format: 'zepp-opus',
    clipMs: params.clipMs,
    purpose: params.purpose || 'find',
    song: params.song || null,
    expectMs: params.expectMs === undefined ? null : params.expectMs,
    known: params.known || null,
    read: readScripts(),
    client: params.diag,
  })
}

// No audio: word timings (and the loudness track) for a song, if they have changed.
function lyrics(params) {
  return post('/lyrics', { song: params.song, known: params.known || null, read: readScripts() })
}

// ---- what the phone is playing ----------------------------------------------------

// The server's answer is its view as it sent it; it spends ~this long getting here.
const SERVER_TO_PHONE_MS = 50
// The watch says it is still there this often; without it, stop asking the server.
const WATCH_GONE_MS = 60000

let phone = { version: -1, view: null, at: 0 }
let polling = false
let lastWatchAt = 0

// The phone's state as of now: the position moves on while it plays, and so does that of a
// song its mic named.
function phoneNow() {
  const v = phone.view
  if (!v) return { version: -1, title: '' }
  const since = Date.now() - phone.at + SERVER_TO_PHONE_MS
  const out = Object.assign({}, v, { positionMs: Math.round(v.positionMs + (v.playing ? since * (v.speed || 1) : 0)), sentAt: Date.now() })
  if (v.heard && typeof v.heard.positionMs === 'number') out.heard = Object.assign({}, v.heard, { positionMs: Math.round(v.heard.positionMs + since) })
  return out
}

// The watch is looking for a song: the LeZeppLean helper on this phone listens too (its mic
// is better than the watch's), if it is set up to. Asked on the phone itself, so it costs
// nothing when it isn't; at most every 30 s while the watch keeps looking. The request is
// signed with the token, never carries it: whatever holds that port is told nothing.
const HELPER_URL = 'http://127.0.0.1:47391/listen'
const LISTEN_EVERY_MS = 30000
let listenedAt = 0

function listenOnPhone() {
  if (Date.now() - listenedAt < LISTEN_EVERY_MS) return
  listenedAt = Date.now()
  const { token } = config()
  if (!token) return // nothing to sign with: the helper wouldn't listen anyway
  const now = Date.now()
  const h = { 'Content-Type': 'application/json', Authorization: listenAuthorization(token, now) }
  // its answer is only logged: the watch's own search goes on either way
  fetch({ url: HELPER_URL, method: 'POST', headers: h, body: '{}', timeout: 1500 })
    .then((res) => console.log('lezepplean: phone mic asked, helper answered ' + res.status))
    .catch((e) => console.log('lezepplean: phone mic not reached: ' + ((e && e.message) || e)))
}

// Ask the server for changes (it holds the question up to 8 s), and pass each one to the
// watch at once, for as long as the watch app is open.
function followPhone(service) {
  if (polling) return
  polling = true
  const next = () => {
    if (Date.now() - lastWatchAt > WATCH_GONE_MS) {
      polling = false
      return
    }
    get('/phone/next?since=' + phone.version + '&wait=8')
      .then((view) => {
        if (view && typeof view.version === 'number') {
          const changed = view.version !== phone.version
          phone = { version: view.version, view, at: Date.now() }
          if (changed) service.call({ method: 'phone', params: phoneNow() })
        }
        next()
      })
      .catch(() => setTimeout(next, 3000))
  }
  next()
}

function ping() {
  const { url, token } = config()
  if (!url) {
    settingsLib.setItem('pingResult', 'Enter a server URL first')
    return
  }
  const startedAt = Date.now()
  settingsLib.setItem('pingResult', 'Testing ' + url + ' …')
  fetch({ url: url + '/health', method: 'GET', headers: headers(token, false), timeout: FETCH_TIMEOUT_MS })
    .then((res) => {
      const ms = Date.now() - startedAt
      if (res.status === 200) settingsLib.setItem('pingResult', 'Connected in ' + ms + ' ms')
      else if (res.status === 401) settingsLib.setItem('pingResult', 'Reached the server, but the token is wrong')
      else settingsLib.setItem('pingResult', 'Server answered HTTP ' + res.status)
    })
    .catch((e) => settingsLib.setItem('pingResult', 'Could not reach the server: ' + ((e && e.message) || e)))
}

AppSideService(
  BaseSideService({
    onInit() {},

    onRequest(req, res) {
      if (req.method === 'phone') {
        lastWatchAt = Date.now()
        if (req.params && req.params.listen) listenOnPhone()
        followPhone(this)
        res(null, phoneNow())
        return
      }
      const handler = req.method === 'identify' ? identify : req.method === 'lyrics' ? lyrics : null
      if (!handler) {
        res(null, { ok: false, reason: 'unknown_method' })
        return
      }
      handler(req.params || {})
        .then((body) => res(null, body))
        .catch((e) => res(null, { ok: false, reason: 'phone', message: 'Could not reach the server: ' + ((e && e.message) || e) }))
    },

    onSettingsChange({ key }) {
      if (key === 'pingRequest') ping()
    },

    onRun() {},

    onDestroy() {},
  }),
)
