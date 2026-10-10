// Decides, packet by packet, whether the music is playing or has stopped, from the SILK
// gain index of each 60 ms packet (see silk.js). Pure logic, no Zepp APIs.
//
// Tuned on real T-Rex 3 recordings: inside music the gain never stayed below 20 for more
// than 2 packets (120 ms), so 4 quiet packets in a row (240 ms) means the music stopped.
// Room noise and talking can look loud for up to ~600 ms, so a resume is provisional:
// the caller confirms it with the server and calls rejectResume() if it was just noise.
//
// "Quiet" is relative. Those recordings had music at 22-31 and silence at 16-18, and fixed
// thresholds around 20 work there. A room with a louder floor (a simulated one had music at
// 42 and silence at 24) never looked quiet to them, and no pause was ever seen. So:
// - until the room's floor is known, the thresholds measured on the real recordings;
// - once it is (any silence teaches it: before the music starts, or a pause), they sit
//   between the learned floor and the learned music level;
// - and whenever the song's loudness track is calibrated, "far below what the song should
//   sound like here" counts as quiet too, whatever the absolute level.
//
// When the server has sent the song's own loudness track (envelope.js), the detector also
// knows what the song *should* sound like here. A quiet intro, a breakdown or a dramatic
// stop in the song is then expected quiet, not a pause: without the track, those froze the
// lyrics and they came back late by however long the quiet part lasted.

export const PAUSE_PACKETS = 4
export const RESUME_PACKETS = 4
const MUSIC_LEVEL_GUESS = 28
const FLOOR_PACKETS = 10 // quiet packets needed before the room floor is trusted
const AUDIBLE_MARGIN = 3 // expected level must clear the pause threshold by this to count as audible
const OFFSET_PACKETS = 15 // loud packets needed before the song's track is trusted
const TRACK_DROP = 8 // this far (~11 dB) below what the song's track predicts is quiet
// A pause is dated from the first quiet packet of the stretch, forgiven ones included, unless
// that stretch began longer ago than this (then it was a quiet passage of the song, and the
// music stopped later). Restarting the count at every forgiven packet dated a stop 1.4 s late
// when the song's track hovered around "audible" just after it.
const FORGIVEN_SPAN_PACKETS = 25

export function createActivity() {
  return {
    playing: true,
    run: 0, // consecutive packets pointing at a change of state
    runStart: -1, // packet index where that run began
    quietFrom: -1, // first packet of the current quiet stretch, forgiven packets included (-1: not quiet)
    runSum: 0, // sum of the gains in a quiet run (seeds the floor when that run turns out to be a pause)
    musicLevel: MUSIC_LEVEL_GUESS, // typical gain while music plays (adapts)
    floor: 17, // typical gain while stopped (adapts once seen)
    floorN: 0, // quiet packets that went into it
    noiseCeiling: 0, // loudest sound that fooled us into a false resume, until music is confirmed
    offset: 0, // room gain minus the song track's gain (volume, distance, mic)
    offsetN: 0, // packets that went into it
    expectedQuiet: 0, // quiet packets forgiven because the song itself is quiet there (diagnostics)
  }
}

function floorKnown(a) {
  return a.floorN >= FLOOR_PACKETS
}

function floorOf(a) {
  return Math.min(a.floor, a.musicLevel - 4)
}

// 40% of the way from the room's floor up to the music.
export function pauseThreshold(a) {
  if (!floorKnown(a)) return Math.min(20, a.musicLevel - 6)
  const f = floorOf(a)
  return f + 0.4 * (a.musicLevel - f)
}

// The floor learns a noisy room by itself; noiseCeiling covers the moments before it has.
// (A margin added on top of the learned floor counted the same noise twice, and then real
// music at 32 could not get past a threshold of 33.)
export function resumeThreshold(a) {
  let base
  if (!floorKnown(a)) {
    base = Math.max(21, a.musicLevel - 8)
  } else {
    const f = floorOf(a)
    base = Math.max(f + 0.55 * (a.musicLevel - f), f + 4)
  }
  return Math.max(base, a.noiseCeiling + 1)
}

// Whether the song should be clearly audible here: true / false, or null when the song's
// track is missing or not yet calibrated against this room.
export function expectedAudible(a, expected) {
  if (expected === null || expected === undefined || a.offsetN < OFFSET_PACKETS) return null
  return expected + a.offset >= pauseThreshold(a) + AUDIBLE_MARGIN
}

// Feed one packet. `expected` is the song track's gain at this packet's song position
// (null if unknown). Returns { type: 'pause' | 'resume', packet } where `packet` is the
// index of the first packet of the change (so the caller can backdate it), or null.
export function pushLevel(a, gain, packet, expected) {
  if (a.playing) {
    const audible = expectedAudible(a, expected)
    let quiet = gain < pauseThreshold(a)
    if (audible === true) {
      // The track says the song is loud here: also quiet if far below what it predicts.
      quiet = quiet || (gain < expected + a.offset - TRACK_DROP && gain < a.musicLevel - 5)
    }
    if (quiet) {
      if (a.quietFrom < 0) a.quietFrom = packet
      if (audible === false) {
        // The song is quiet here: a quiet room is what playing sounds like. Not evidence of
        // a pause, but not the end of the quiet stretch either.
        a.expectedQuiet += 1
        return null
      }
      if (a.run === 0) {
        a.runStart = packet - a.quietFrom <= FORGIVEN_SPAN_PACKETS ? a.quietFrom : packet
        a.runSum = 0
      }
      a.run += 1
      a.runSum += gain
      if (a.run >= PAUSE_PACKETS) {
        a.playing = false
        if (!a.floorN) {
          // The quiet that made this a pause is the room: the first floor comes from it. (In a
          // room whose silence sits at 20 or more, nothing else would ever seed it.)
          a.floor = a.runSum / a.run
          a.floorN = 1
        }
        a.run = 0
        a.quietFrom = -1
        return { type: 'pause', packet: a.runStart }
      }
    } else {
      a.run = 0
      a.quietFrom = -1
      if (a.learn !== false) {
        a.musicLevel += (gain - a.musicLevel) * 0.05
        learnOffset(a, gain, expected)
      }
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
    // The floor is the room with nothing playing, so it is learned only from sound near it.
    // Learning from everything below the resume bar let music held back by a raised bar
    // (after someone talked over a pause) count as "room": the floor went from 16 to 25 and
    // quiet beats of the music read as pauses, 51 times over 40 simulated sessions. A room
    // that really gets louder (a fan) still moves it, a few steps at a time.
    // (The first pause always seeds the floor, above; from then on it moves only this way.)
    if (gain <= a.floor + 4) {
      a.floor += (gain - a.floor) * 0.1
      a.floorN += 1
    }
  }
  return null
}

// Slow and clipped, so a few odd packets (a cough, a door) can't move it.
function learnOffset(a, gain, expected) {
  if (expected === null || expected === undefined) return
  const d = gain - expected
  if (a.offsetN === 0) a.offset = d
  else a.offset += Math.max(-3, Math.min(3, d - a.offset)) * 0.08
  a.offsetN += 1
}

// The song's track changed (a new song) or the clock jumped: re-learn the room offset.
export function forgetTrack(a) {
  a.offsetN = 0
  a.offset = 0
}

// The server couldn't place what looked like a resume. The room is still loud, so this
// stays "playing" (the session keeps the lyrics frozen and asks again); what changes is the
// bar for the next resume after a quiet spell: above that sound, so the same talking can't
// fool it twice, but never above the music's own level, or the music itself never could.
export function rejectResume(a, noiseGain) {
  a.run = 0
  a.noiseCeiling = Math.min(Math.max(a.noiseCeiling, noiseGain || 0), a.musicLevel - 3)
}

// Music is confirmed to be playing (e.g. a successful re-sync) even if levels were ambiguous.
// The confirmation also ends any distrust of the room's noise.
export function markPlaying(a) {
  a.playing = true
  a.run = 0
  a.noiseCeiling = 0
}
