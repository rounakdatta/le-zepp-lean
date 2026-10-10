// The lyrics screen, laid out for a 480x480 round display.
//
//          title / artist            (y 50-120, inside the narrowing top of the circle)
//          previous line (dim)
//        ▶ CURRENT LINE ◀            (the widest band, auto-sized to fit)
//          ─── line progress ───
//          next line
//          line after next (dimmer)
//          status                    (y 420-448)
//    plus a song-progress ring around the bezel.
import { createWidget, widget, prop, align, text_style, event, getTextLayout } from '@zos/ui'
import { px } from '@zos/utils'

const ACCENT = 0x0986d4
const LISTENING = 0xe0484b
const RING = { x: 0, y: 0, w: 480, h: 480, radius: 234, line_width: 8 }
const BAR = { x: 160, y: 310, w: 160, h: 4 }
const CURRENT = { x: 22, y: 188, w: 436, h: 118 }
const CURRENT_SIZES = [44, 40, 36, 32, 28]
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
  const artist = text({ x: 70, y: 88, w: 340, h: 32, size: 22, color: 0x8a8a8a, style: text_style.ELLIPSIS })
  const prev = text({ x: 40, y: 128, w: 400, h: 58, size: 24, color: 0x505050, style: text_style.WRAP })
  const current = text({ ...CURRENT, size: 40, color: 0xffffff, style: text_style.WRAP })
  createWidget(widget.FILL_RECT, { x: px(BAR.x), y: px(BAR.y), w: px(BAR.w), h: px(BAR.h), radius: px(2), angle: 0, color: 0x262626 })
  const bar = createWidget(widget.FILL_RECT, { x: px(BAR.x), y: px(BAR.y), w: px(1), h: px(BAR.h), radius: px(2), angle: 0, color: ACCENT })
  const next = text({ x: 46, y: 322, w: 388, h: 64, size: 28, color: 0x9a9a9a, style: text_style.WRAP })
  const next2 = text({ x: 84, y: 388, w: 312, h: 30, size: 22, color: 0x484848, style: text_style.ELLIPSIS })
  const status = text({ x: 124, y: 420, w: 232, h: 28, size: 20, color: 0x6a6a6a, style: text_style.ELLIPSIS })
  const debug = text({ x: 70, y: 128, w: 340, h: 280, size: 20, color: 0xffd000, style: text_style.WRAP })
  debug.setProperty(prop.VISIBLE, false)

  ;[title, artist, prev, current, next, next2].forEach((w) => listen(w, onTap))

  let ringDeg = -1
  let ringColor = ACCENT

  // Some widgets need their full geometry on every update, so always pass it.
  function drawRing() {
    ring.setProperty(prop.MORE, { ...ringBase, start_angle: -90, end_angle: -90 + Math.max(1, ringDeg), color: ringColor })
  }

  let barW = -1
  let currentText = null

  function setCurrent(str, size) {
    if (str === currentText) return
    currentText = str
    current.setProperty(prop.MORE, {
      x: px(CURRENT.x), y: px(CURRENT.y), w: px(CURRENT.w), h: px(CURRENT.h),
      text: str, text_size: px(size || fitSize(str)),
    })
  }

  return {
    showSong(song) {
      set(title, song.title || '')
      set(artist, song.artist || '')
      set(prev, '')
      setCurrent(song.kind === 'synced' ? GAP : 'No synced lyrics for this song', song.kind === 'synced' ? 40 : 30)
      set(next, song.kind === 'synced' ? '' : 'Showing the title only')
      set(next2, '')
      this.setLineProgress(0)
      this.setSongProgress(0)
    },

    showLine(lines, idx) {
      const at = (i) => (i >= 0 && i < lines.length ? lines[i][1] : null)
      const label = (t) => (t === null ? '' : t === '' ? GAP : t)
      set(prev, label(at(idx - 1)))
      setCurrent(idx < 0 ? GAP : label(at(idx)))
      set(next, label(at(idx + 1)))
      set(next2, label(at(idx + 2)))
    },

    showMessage(main, sub) {
      set(title, 'LeZeppLean')
      set(artist, '')
      set(prev, '')
      setCurrent(main, 32)
      set(next, sub || '')
      set(next2, '')
      this.setLineProgress(0)
    },

    setListening(on) {
      ringColor = on ? LISTENING : ACCENT
      drawRing()
    },

    // fraction 0..1 of the song, drawn as the bezel ring
    setSongProgress(fraction) {
      const deg = Math.round(Math.min(1, Math.max(0, fraction)) * 360)
      if (deg === ringDeg) return
      ringDeg = deg
      drawRing()
    },

    // fraction 0..1 of the current line, drawn as the bar under it
    setLineProgress(fraction) {
      const w = Math.max(1, Math.round(Math.min(1, Math.max(0, fraction)) * BAR.w))
      if (w === barW) return
      barW = w
      bar.setProperty(prop.MORE, { x: px(BAR.x), y: px(BAR.y), w: px(w), h: px(BAR.h) })
    },

    setStatus(str) {
      set(status, str || '')
    },

    setDebug(str) {
      debug.setProperty(prop.VISIBLE, !!str)
      if (str) set(debug, str)
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

// Largest font size at which the current line fits its box.
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
