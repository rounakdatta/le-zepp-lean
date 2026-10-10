"""Decode (and, for tests, encode) the audio files the Zepp OS Recorder writes.

The watch's `@zos/media` Recorder (codec.OPUS) does not write an Ogg file. It writes
raw Opus packets in the `opus_demo` framing, at 16 kHz, mono:

    [4-byte big-endian payload length][4-byte encoder final range][payload] ...

Source: docs.zepp.com "Watch recorded opus audio file format conversion" FAQ, and
zepp-health discussion #556, which confirms the same framing on a real watch.
"""

from __future__ import annotations

import io
import struct
import wave
from dataclasses import dataclass
from fractions import Fraction

import av

SAMPLE_RATE = 16_000
HEADER_BYTES = 8
MAX_PACKET_BYTES = 1275 * 3  # the Opus spec caps a packet at 1275 bytes per frame; allow multi-frame packets


class ZeppOpusError(ValueError):
    pass


@dataclass
class DecodedClip:
    pcm: bytes          # signed 16-bit little-endian mono samples at SAMPLE_RATE
    packets: int
    trailing_bytes: int  # bytes after the last complete packet (a truncated write shows up here)

    @property
    def samples(self) -> int:
        return len(self.pcm) // 2

    @property
    def duration_ms(self) -> float:
        return self.samples * 1000 / SAMPLE_RATE


def split_packets(data: bytes) -> tuple[list[bytes], int]:
    """Split a Zepp recorder file into Opus packets. Returns (packets, trailing_bytes)."""
    packets: list[bytes] = []
    pos = 0
    while pos + HEADER_BYTES <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        if length == 0 or length > MAX_PACKET_BYTES:
            raise ZeppOpusError(f"implausible packet length {length} at byte {pos}; not a Zepp Opus file?")
        end = pos + HEADER_BYTES + length
        if end > len(data):
            break  # truncated final packet
        packets.append(data[pos + HEADER_BYTES:end])
        pos = end
    return packets, len(data) - pos


def decode(data: bytes) -> DecodedClip:
    """Decode a Zepp recorder file into 16 kHz mono PCM."""
    packets, trailing = split_packets(data)
    if not packets:
        raise ZeppOpusError("no Opus packets found (empty or truncated recording)")

    decoder = av.CodecContext.create("libopus", "r")
    decoder.sample_rate = SAMPLE_RATE
    decoder.layout = "mono"
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    out = bytearray()
    for payload in packets:
        for frame in decoder.decode(av.Packet(payload)):
            for converted in resampler.resample(frame):
                out += _frame_bytes(converted)
    for converted in resampler.resample(None):
        out += _frame_bytes(converted)
    return DecodedClip(pcm=bytes(out), packets=len(packets), trailing_bytes=trailing)


def _frame_bytes(frame: av.AudioFrame) -> bytes:
    # Packed s16 mono: one plane; the plane buffer can be padded, so trim to the real sample count.
    return bytes(frame.planes[0])[: frame.samples * 2]


def pcm_to_wav(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def encode(pcm: bytes, bitrate: int = 24_000, frame_ms: int = 20) -> bytes:
    """Encode 16 kHz mono s16le PCM into the Zepp recorder framing (used to fake watch clips in tests)."""
    encoder = av.CodecContext.create("libopus", "w")
    encoder.sample_rate = SAMPLE_RATE
    encoder.layout = "mono"
    encoder.format = "s16"
    encoder.bit_rate = bitrate
    encoder.time_base = Fraction(1, SAMPLE_RATE)
    encoder.options = {"frame_duration": str(frame_ms), "application": "audio"}

    samples_per_frame = SAMPLE_RATE * frame_ms // 1000
    out = bytearray()

    def write(packets) -> None:
        for p in packets:
            payload = bytes(p)
            out.extend(struct.pack(">II", len(payload), 0))  # final range isn't needed for decoding
            out.extend(payload)

    pts = 0
    for start in range(0, len(pcm) // 2, samples_per_frame):
        chunk = pcm[start * 2:(start + samples_per_frame) * 2]
        if len(chunk) < samples_per_frame * 2:
            chunk = chunk + b"\x00" * (samples_per_frame * 2 - len(chunk))
        frame = av.AudioFrame(format="s16", layout="mono", samples=samples_per_frame)
        frame.planes[0].update(chunk)
        frame.sample_rate = SAMPLE_RATE
        frame.pts = pts
        pts += samples_per_frame
        write(encoder.encode(frame))
    write(encoder.encode(None))
    return bytes(out)


def load_audio_as_pcm(path_or_url: str, start_s: float = 0.0, duration_s: float | None = None) -> bytes:
    """Decode any audio file/URL (m4a, mp3, wav, ...) to 16 kHz mono s16le PCM, optionally cropped."""
    container = av.open(path_or_url)
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    out = bytearray()
    for frame in container.decode(stream):
        for converted in resampler.resample(frame):
            out += _frame_bytes(converted)
    for converted in resampler.resample(None):
        out += _frame_bytes(converted)
    container.close()
    begin = int(start_s * SAMPLE_RATE) * 2
    end = len(out) if duration_s is None else begin + int(duration_s * SAMPLE_RATE) * 2
    return bytes(out[begin:end])
