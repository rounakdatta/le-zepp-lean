// Incremental reader for the recorder's growing file. The file is a sequence of
// [4-byte big-endian length][4-byte final range][Opus packet]; bytes arrive in arbitrary
// chunks while recording continues. Pure logic, no Zepp APIs.

const HEADER = 8
const MAX_PACKET = 3825

export function createPacketStream(keep) {
  return {
    pending: new Uint8Array(0), // bytes of an incomplete packet carried to the next chunk
    count: 0, // packets seen so far; also the index of the next packet
    keep: keep || 120, // packets kept for re-sync windows (120 x 60 ms = 7.2 s)
    recent: [], // [{ index, bytes }] newest last
    broken: false,
  }
}

// Feed newly read bytes; calls onPacket(bytes, index) for each complete packet.
export function feed(s, chunk, onPacket) {
  if (s.broken || !chunk || !chunk.length) return
  let buf = chunk
  if (s.pending.length) {
    buf = new Uint8Array(s.pending.length + chunk.length)
    buf.set(s.pending, 0)
    buf.set(chunk, s.pending.length)
  }
  let pos = 0
  while (pos + HEADER <= buf.length) {
    const len = ((buf[pos] << 24) >>> 0) + (buf[pos + 1] << 16) + (buf[pos + 2] << 8) + buf[pos + 3]
    if (len === 0 || len > MAX_PACKET) {
      s.broken = true // not the framing we expect; stop rather than misread everything after
      return
    }
    if (pos + HEADER + len > buf.length) break
    const packet = buf.slice(pos + HEADER, pos + HEADER + len)
    const index = s.count
    s.count += 1
    s.recent.push({ index, bytes: packet })
    if (s.recent.length > s.keep) s.recent.shift()
    if (onPacket) onPacket(packet, index)
    pos += HEADER + len
  }
  s.pending = buf.slice(pos)
}

// Re-frame packets [from, to) still in memory as a Zepp recorder file, for the server.
export function windowBytes(s, from, to) {
  const picked = s.recent.filter((p) => p.index >= from && p.index < to)
  let size = 0
  picked.forEach((p) => (size += HEADER + p.bytes.length))
  const out = new Uint8Array(size)
  let pos = 0
  picked.forEach((p) => {
    const len = p.bytes.length
    out[pos] = (len >>> 24) & 255
    out[pos + 1] = (len >>> 16) & 255
    out[pos + 2] = (len >>> 8) & 255
    out[pos + 3] = len & 255
    out.set(p.bytes, pos + HEADER)
    pos += HEADER + len
  })
  return { bytes: out, first: picked.length ? picked[0].index : -1, packets: picked.length }
}
