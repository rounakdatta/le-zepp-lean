// Decides, packet by packet, whether the music is playing or has stopped, from the SILK
// gain index of each 60 ms packet (see silk.js). Pure logic, no Zepp APIs.
//
// Tuned on real T-Rex 3 recordings: inside music the gain never stayed below 20 for more
// than 2 packets (120 ms), so 4 quiet packets in a row (240 ms) means the music stopped.
// Room noise and talking can look loud for up to ~600 ms, so a resume is provisional:
// the caller confirms it with the server and calls rejectResume() if it was just noise.

export const PAUSE_PACKETS = 4
export const RESUME_PACKETS = 4
const MUSIC_LEVEL_GUESS = 28
const ROOM_FLOOR_GUESS = 17

export function createActivity() {
  return {
    playing: true,
    run: 0, // consecutive packets pointing at a change of state
    runStart: -1, // packet index where that run began
    musicLevel: MUSIC_LEVEL_GUESS, // typical gain while music plays (adapts)
    floor: ROOM_FLOOR_GUESS, // typical gain while stopped (adapts)
    bump: 0, // extra resume margin after false resumes in this pause
  }
}

export function pauseThreshold(a) {
  return Math.min(20, a.musicLevel - 6)
}

export function resumeThreshold(a) {
  return Math.max(21, a.floor + 5, a.musicLevel - 8) + a.bump
}

// Feed one packet. Returns { type: 'pause' | 'resume', packet } where `packet` is the index
// of the first packet of the change (so the caller can backdate it), or null.
export function pushLevel(a, gain, packet) {
  if (a.playing) {
    if (gain < pauseThreshold(a)) {
      if (a.run === 0) a.runStart = packet
      a.run += 1
      if (a.run >= PAUSE_PACKETS) {
        a.playing = false
        a.run = 0
        a.bump = 0
        return { type: 'pause', packet: a.runStart }
      }
    } else {
      a.run = 0
      a.musicLevel += (gain - a.musicLevel) * 0.05
    }
    return null
  }
  if (gain >= resumeThreshold(a)) {
    if (a.run === 0) a.runStart = packet
    a.run += 1
    if (a.run >= RESUME_PACKETS) {
      a.playing = true
      a.run = 0
      return { type: 'resume', packet: a.runStart }
    }
  } else {
    a.run = 0
    a.floor += (gain - a.floor) * 0.1
  }
  return null
}

// The server heard no music in what looked like a resume: stay paused and demand a louder
// signal next time, so the same background noise doesn't fool us twice.
export function rejectResume(a, noiseGain) {
  const base = resumeThreshold(a) - a.bump
  a.playing = false
  a.run = 0
  a.bump = Math.max(a.bump + 2, (noiseGain || 0) + 1 - base)
}

// Music is confirmed to be playing (e.g. a successful re-sync) even if levels were ambiguous.
export function markPlaying(a) {
  a.playing = true
  a.run = 0
}
