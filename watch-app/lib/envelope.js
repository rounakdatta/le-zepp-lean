// The song's own loudness, one value per 60 ms, as the watch's SILK reader would see it.
// Pure logic, no Zepp APIs.
//
// The server encodes the reference recording the way the watch's recorder does and reads
// the same gain index from every packet (server/lezepplean/silk.py `gain_track`). It sends
// one character per packet: a 4-minute song is 4,000 characters, sent once per song.
//
// The detector uses it to tell "the song is quiet here" from "the music stopped".

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const LOOKUP = {}
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i

// env: { startMs, stepMs, data } from the server -> { startMs, stepMs, gains } or null
export function decodeEnvelope(env) {
  if (!env || typeof env.data !== 'string' || !env.data.length) return null
  const gains = new Uint8Array(env.data.length)
  for (let i = 0; i < env.data.length; i++) {
    const v = LOOKUP[env.data[i]]
    gains[i] = v === undefined ? 0 : v
  }
  return { startMs: Number(env.startMs) || 0, stepMs: Number(env.stepMs) || 60, gains, version: env.version || null }
}

// Expected gain index at song position songMs, or null outside the song.
export function expectedAt(envelope, songMs) {
  if (!envelope || songMs === null || songMs === undefined) return null
  const i = Math.floor((songMs - envelope.startMs) / envelope.stepMs)
  if (i < 0 || i >= envelope.gains.length) return null
  return envelope.gains[i]
}
