// The lyrics screen, laid out for a 480x480 round display.
//
//          title / artist            (y 50-120, inside the narrowing top of the circle)
//          previous line (dim)
//        ▶ CURRENT LINE ◀            (the widest band; word by word when timings exist)
//          ─── line progress ───     (only for lines without word timings)
//          next line
//          line after next (dimmer)
//          status                    (y 420-448)
//    plus a song-progress ring around the bezel.
//
// Word by word: every word of the current line is its own TEXT widget, from a pool made
// once, placed by layout.js and lit as it is sung. Unsung words are grey, sung ones white.
// The highlight is the only thing on the screen that moves often, so it is the only thing
// that draws the eye; the bar under the line duplicates it, so it is hidden for those lines.
import { createWidget, widget, prop, align, text_style, event, getTextLayout } from '@zos/ui'
import { px } from '@zos/utils'
import { layoutWords } from './layout.js'
import { splitWords } from './sync.js'

// The logo's colours (brand/logo-source.png): coral while a song plays, its cream while
// listening for one, and the cream again for the word being sung.
const ACCENT = 0xfe5641
const LISTENING = 0xf8f4eb
const PAUSED = 0x5a5a5a
const SUNG = 0xf8f4eb
const UNSUNG = 0x8a8a8a
const PREV = 0x444444
const NEXT = 0x6a6a6a
const NEXT2 = 0x3c3c3c
const RING = { x: 0, y: 0, w: 480, h: 480, radius: 234, line_width: 8 }
const BAR = { x: 160, y: 310, w: 160, h: 4 }
const CURRENT = { x: 22, y: 188, w: 436, h: 118 }
const CURRENT_SIZES = [44, 40, 36, 32, 28]
const POOL = 24 // more words than fit in the box at the smallest size
const GAP = '• • •' // shown for instrumental gaps (safe glyphs, unlike ♪)

export function createView(options) {
  const onTap = (options && options.onTap) || (() => {})

  // Black backdrop that also catches taps anywhere on the screen.
  const backdrop = createWidget(widget.FILL_RECT, { x: 0, y: 0, w: px(480), h: px(480), radius: 0, angle: 0, color: 0x000000 })
  listen(backdrop, onTap)

  const ringBase = { x: px(RING.x), y: px(RING.y), w: px(RING.w), h: px(RING.h), radius: px(RING.radius), line_width: px(RING.line_width) }
  createWidget(widget.ARC, { ...ringBase, start_angle: -90, end_angle: 270, color: 0x1c1c1c })
  const ring = createWidget(widget.ARC, { ...ringBase, start_angle: -90, end_angle: -89, color: ACCENT })

  const title = text({ x: 95, y: 50, w: 290, h: 38, size: 26, color: 0xffffff, style: text_style.ELLIPSIS })
  // The logo stands where the song's name will, until there is a song.
  const logo = createWidget(widget.IMG, { x: px(192), y: px(30), src: 'logo-96.png' })
  const artist = text({ x: 70, y: 88, w: 340, h: 32, size: 22, color: 0x8a8a8a, style: text_style.ELLIPSIS })
  const prev = text({ x: 40, y: 128, w: 400, h: 58, size: 24, color: PREV, style: text_style.WRAP })
  const current = text({ ...CURRENT, size: 40, color: SUNG, style: text_style.WRAP })
  const barTrack = createWidget(widget.FILL_RECT, { x: px(BAR.x), y: px(BAR.y), w: px(BAR.w), h: px(BAR.h), radius: px(2), angle: 0, color: 0x262626 })
  const bar = createWidget(widget.FILL_RECT, { x: px(BAR.x), y: px(BAR.y), w: px(1), h: px(BAR.h), radius: px(2), angle: 0, color: ACCENT })
  const next = text({ x: 46, y: 322, w: 388, h: 64, size: 26, color: NEXT, style: text_style.WRAP })
  const next2 = text({ x: 84, y: 388, w: 312, h: 30, size: 22, color: NEXT2, style: text_style.ELLIPSIS })
  const status = text({ x: 124, y: 420, w: 232, h: 28, size: 20, color: 0x6a6a6a, style: text_style.ELLIPSIS })

  // The word pool. Created once: making widgets per line would cost a line's worth of time.
  const pool = []
  for (let i = 0; i < POOL; i++) {
    const w = createWidget(widget.TEXT, {
      x: 0, y: 0, w: px(1), h: px(1), text: '', text_size: px(40), color: UNSUNG,
      align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE,
    })
    listen(w, onTap)
    pool.push({ widget: w, used: false, lit: false, box: null, size: 40, text: '' })
  }

  // Diagnostics sit on their own black panel: drawn over the lyrics they were unreadable.
  const debugPanel = createWidget(widget.FILL_RECT, { x: px(40), y: px(120), w: px(400), h: px(296), radius: px(12), angle: 0, color: 0x000000 })
  const debug = text({ x: 60, y: 128, w: 360, h: 280, size: 19, color: 0xffd000, style: text_style.WRAP })
  debugPanel.setProperty(prop.VISIBLE, false)
  debug.setProperty(prop.VISIBLE, false)

  ;[title, artist, prev, current, next, next2].forEach((w) => listen(w, onTap))

  let ringDeg = -1
  let ringColor = ACCENT
  let barW = -1
  let barShown = true
  let currentText = null
  let wordMode = false
  let lit = -1 // last lit word index in word mode
  let shownKey = null // which line is on screen (index + lyrics version)
  let paused = false
  const layouts = {} // key -> { size, items } | null
  const widths = {} // measurement cache: size + '|' + word -> px

  function drawRing() {
    ring.setProperty(prop.MORE, { ...ringBase, start_angle: -90, end_angle: -90 + Math.max(1, ringDeg), color: ringColor })
  }

  function setCurrent(str, size) {
    if (str === currentText) return
    currentText = str
    current.setProperty(prop.MORE, {
      x: px(CURRENT.x), y: px(CURRENT.y), w: px(CURRENT.w), h: px(CURRENT.h),
      text: str, text_size: px(size || fitSize(str)),
    })
  }

  // The bar under a line shows how far through it we are; a line lit word by word already
  // shows that, so there the bar (and its track) go.
  function showBar(on) {
    if (on === barShown) return
    barShown = on
    barTrack.setProperty(prop.VISIBLE, on)
    bar.setProperty(prop.VISIBLE, on)
    if (!on) barW = -1
  }

  function measure(word, size) {
    const k = size + '|' + word
    let w = widths[k]
    if (w === undefined) {
      try {
        const r = getTextLayout(word, { text_size: px(size), text_width: 0, wrapped: 0 })
        w = r && r.width ? r.width : Math.round(size * 0.55 * word.length)
      } catch (e) {
        w = Math.round(size * 0.55 * word.length) // a rough average glyph width
      }
      widths[k] = w
    }
    return w
  }

  function layoutFor(key, words) {
    if (layouts[key] === undefined) {
      const box = { x: CURRENT.x, y: CURRENT.y, w: CURRENT.w, h: CURRENT.h }
      layouts[key] = words.length && words.length <= POOL ? layoutWords(words, box, CURRENT_SIZES, measure) : null
    }
    return layouts[key]
  }

  function clearWords() {
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]
      if (!p.used) continue
      p.used = false
      p.text = ''
      p.widget.setProperty(prop.TEXT, '')
    }
  }

  function placeWords(words, layout) {
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]
      if (i >= words.length) {
        if (p.used) {
          p.used = false
          p.text = ''
          p.widget.setProperty(prop.TEXT, '')
        }
        continue
      }
      const item = layout.items[i]
      p.used = true
      p.lit = false
      p.text = words[i]
      p.size = layout.size
      // A few px of slack either side: a word measured a pixel short must not scroll.
      p.box = { x: item.x - 4, y: item.y, w: item.w + 8, h: item.h }
      p.widget.setProperty(prop.MORE, {
        x: px(p.box.x), y: px(p.box.y), w: px(p.box.w), h: px(p.box.h),
        text: words[i], text_size: px(layout.size), color: UNSUNG,
      })
    }
  }

  function light(p, on) {
    if (p.lit === on) return
    p.lit = on
    p.widget.setProperty(prop.MORE, {
      x: px(p.box.x), y: px(p.box.y), w: px(p.box.w), h: px(p.box.h), color: on ? SUNG : UNSUNG,
    })
  }

  return {
    showSong(song) {
      logo.setProperty(prop.VISIBLE, false)
      set(title, song.title || '')
      set(artist, song.artist || '')
      set(prev, '')
      clearWords()
      wordMode = false
      shownKey = null
      const synced = song.kind === 'synced'
      const pending = song.kind === 'pending'
      setCurrent(synced ? GAP : pending ? 'Loading lyrics…' : 'No synced lyrics for this song', synced ? 40 : 30)
      set(next, synced || pending ? '' : 'Showing the title only')
      set(next2, '')
      showBar(true)
      this.setLineProgress(0)
      this.setSongProgress(0)
    },

    // Draw line `idx` as the current one (idx -1: before the first line). `version`
    // keys the layout cache, so new word timings for the same text re-layout.
    showLine(lines, idx, version) {
      const key = idx + '@' + (version || '')
      if (key === shownKey) return
      shownKey = key
      const at = (i) => (i >= 0 && i < lines.length ? lines[i][1] : null)
      const label = (t) => (t === null ? '' : t === '' ? GAP : t)
      set(prev, label(at(idx - 1)))
      set(next, label(at(idx + 1)))
      set(next2, label(at(idx + 2)))
      lit = -1
      const line = idx >= 0 ? lines[idx] : null
      const words = line && line[2] ? splitWords(line[1]) : null
      const layout = words ? layoutFor(key, words) : null
      if (layout) {
        wordMode = true
        setCurrent('', 40)
        placeWords(words, layout)
        showBar(false)
      } else {
        wordMode = false
        clearWords()
        setCurrent(idx < 0 ? GAP : label(at(idx)))
        showBar(true)
      }
    },

    // Light every word up to and including `wi` (-1: none yet).
    setWord(wi) {
      if (!wordMode || wi === lit) return
      lit = wi
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i]
        if (!p.used) break
        light(p, i <= wi)
      }
    },

    // Work out the layout of a line ahead of time, so switching to it is just a few property sets.
    prepare(lines, idx, version) {
      const line = idx >= 0 && idx < lines.length ? lines[idx] : null
      if (line && line[2]) layoutFor(idx + '@' + (version || ''), splitWords(line[1]))
    },

    showMessage(main, sub) {
      logo.setProperty(prop.VISIBLE, true)
      set(title, '')
      set(artist, '')
      set(prev, '')
      clearWords()
      wordMode = false
      shownKey = null
      setCurrent(main, 32)
      set(next, sub || '')
      set(next2, '')
      showBar(false) // a progress track under "Listening…" would be chrome for nothing
    },

    setListening(on) {
      ringColor = on ? LISTENING : paused ? PAUSED : ACCENT
      drawRing()
    },

    // The music stopped: everything stays where it is, the ring goes grey, and the status
    // line says so in plain grey. It is a normal state, not a fault.
    setPaused(on) {
      if (on === paused) return
      paused = on
      ringColor = on ? PAUSED : ACCENT
      drawRing()
      set(status, on ? 'Paused' : '')
    },

    // fraction 0..1 of the song, drawn as the bezel ring
    setSongProgress(fraction) {
      const deg = Math.round(Math.min(1, Math.max(0, fraction)) * 360)
      if (deg === ringDeg) return
      ringDeg = deg
      drawRing()
    },

    // fraction 0..1 of the current line, drawn as the bar under it (line-by-line lines only)
    setLineProgress(fraction) {
      if (!barShown) return
      const w = Math.max(1, Math.round(Math.min(1, Math.max(0, fraction)) * BAR.w))
      if (w === barW) return
      barW = w
      bar.setProperty(prop.MORE, { x: px(BAR.x), y: px(BAR.y), w: px(w), h: px(BAR.h), color: ACCENT })
    },

    setStatus(str) {
      set(status, str || '')
    },

    setDebug(str) {
      debugPanel.setProperty(prop.VISIBLE, !!str)
      debug.setProperty(prop.VISIBLE, !!str)
      if (str) set(debug, str)
    },

    // A new song: drop the old one's layouts and measured widths (the watch's memory is small).
    forgetLayouts() {
      for (const k in layouts) delete layouts[k]
      for (const k in widths) delete widths[k]
    },
  }
}

function text(o) {
  return createWidget(widget.TEXT, {
    x: px(o.x), y: px(o.y), w: px(o.w), h: px(o.h),
    text: '',
    text_size: px(o.size),
    color: o.color,
    align_h: align.CENTER_H,
    align_v: align.CENTER_V,
    text_style: o.style,
  })
}

// Tap handling is a convenience (SELECT does the same), so never let it break the screen.
function listen(w, handler) {
  try {
    w.addEventListener(event.CLICK_UP, handler)
  } catch (e) {
    // this widget type doesn't take listeners on this firmware
  }
}

function set(w, str) {
  w.setProperty(prop.TEXT, str)
}

// Largest font size at which a line fits the current-line box as one wrapped text.
function fitSize(str) {
  for (const size of CURRENT_SIZES) {
    try {
      const layout = getTextLayout(str, { text_size: px(size), text_width: px(CURRENT.w), wrapped: 1 })
      if (layout && layout.height <= px(CURRENT.h)) return size
    } catch (e) {
      return 36
    }
  }
  return CURRENT_SIZES[CURRENT_SIZES.length - 1]
}
