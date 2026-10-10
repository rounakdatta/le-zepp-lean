// Runs inside the Zepp app on the phone. The watch has no internet of its own, so this
// relays each mic clip to the recognition server and hands the answer back.
import { BaseSideService, settingsLib } from '@zeppos/zml/base-side'
import { DEFAULT_SERVER_URL, DEFAULT_TOKEN } from './defaults'

// The phone's HTTP client is reported to drop requests after ~10 s of silence, so answer
// well before that; the server itself gives the recognizer at most 6 s.
const FETCH_TIMEOUT_MS = 9500

// Values typed into the LeZeppLean settings win; otherwise use the ones built into this install.
function config() {
  const url = String(settingsLib.getItem('serverUrl') || DEFAULT_SERVER_URL || '').trim().replace(/\/+$/, '')
  const token = String(settingsLib.getItem('token') || DEFAULT_TOKEN || '').trim()
  return { url, token }
}

function headers(token, json) {
  const h = {}
  if (json) h['Content-Type'] = 'application/json'
  if (token) h.Authorization = 'Bearer ' + token
  return h
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
    client: params.diag,
  })
}

// No audio: word timings (and the loudness track) for a song, if they have changed.
function lyrics(params) {
  return post('/lyrics', { song: params.song, known: params.known || null })
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
