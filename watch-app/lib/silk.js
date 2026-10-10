// Reads loudness straight from the watch recorder's Opus packets, without decoding audio.
//
// The recorder encodes in SILK mode (wideband, 60 ms packets). Every SILK packet starts
// with the encoder's voice-activity flags and then, a few range-coded symbols in, the gain
// of its first 5 ms subframe: an index 0..63 in ~1.37 dB steps. On real T-Rex 3 recordings
// that index tracked the loudness of the audio with r = 0.87, which is all a pause detector
// needs. Reference implementation and tests: server/scripts/silk_levels.py.
//
// Range decoder: port of libopus ec_dec (RFC 6716 §4.1). Values above 2^31 can't go
// through JS bitwise operators, so the wide arithmetic uses plain numbers.

const TYPE_VAD = [232, 158, 10, 0]
const TYPE_NO_VAD = [230, 0]
const GAIN = [
  [224, 112, 44, 15, 3, 2, 1, 0],
  [254, 237, 192, 132, 70, 23, 4, 0],
  [255, 252, 226, 155, 61, 11, 2, 0],
]
const UNIFORM8 = [224, 192, 160, 128, 96, 64, 32, 0]
const CODE_TOP = 2147483648 // 2^31
const CODE_BOT = 8388608 // 2^23

function decoder(bytes, start, end) {
  const d = { bytes, pos: start, end, rng: 128, val: 0, rem: 0 }
  d.rem = nextByte(d)
  d.val = d.rng - 1 - (d.rem >> 1)
  normalize(d)
  return d
}

function nextByte(d) {
  const b = d.pos < d.end ? d.bytes[d.pos] : 0
  d.pos += 1
  return b
}

function normalize(d) {
  while (d.rng <= CODE_BOT) {
    d.rng *= 256
    const prev = d.rem
    d.rem = nextByte(d)
    const sym = ((prev << 8) | d.rem) >> 1
    d.val = (d.val * 256 + (255 & ~sym)) % CODE_TOP
  }
}

function bit(d) {
  const s = Math.floor(d.rng / 2)
  const one = d.val < s
  if (!one) d.val -= s
  d.rng = one ? s : d.rng - s
  normalize(d)
  return one ? 1 : 0
}

function symbol(d, icdf) {
  const r = Math.floor(d.rng / 256)
  let s = d.rng
  let t
  let k = -1
  do {
    t = s
    k += 1
    s = r * icdf[k]
  } while (d.val < s)
  d.val -= s
  d.rng = t - s
  normalize(d)
  return k
}

// Level of one packet: { gain: 0..63, vad: active 20 ms frames } or null when the packet
// isn't a plain single-frame SILK packet (the watch recorder always writes those).
export function silkLevel(bytes, start, end) {
  const toc = bytes[start]
  const config = toc >> 3
  if (config > 11 || (toc & 3) !== 0 || end - start < 2) return null
  const frameMs = [10, 20, 40, 60][config & 3]
  const frames = frameMs <= 20 ? 1 : frameMs / 20
  const d = decoder(bytes, start + 1, end)
  let vad = 0
  let firstVad = 0
  for (let i = 0; i < frames; i++) {
    const v = bit(d)
    if (i === 0) firstVad = v
    vad += v
  }
  if (bit(d)) return null // LBRR (in-band FEC) frames would come first; the recorder doesn't use them
  const type = firstVad ? symbol(d, TYPE_VAD) + 2 : symbol(d, TYPE_NO_VAD)
  const gain = symbol(d, GAIN[type >> 1]) * 8 + symbol(d, UNIFORM8)
  return { gain, vad }
}
