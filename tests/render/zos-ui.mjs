// A stand-in for @zos/ui that records what the watch would draw, so screens can be rendered
// (render.py) and looked at without a watch. Text is measured with real font metrics
// (widths.json, made by render.py from the same font it draws with).
import { readFileSync, existsSync } from 'node:fs'

const W = existsSync(new URL('./widths.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('./widths.json', import.meta.url))) : null

export const widgets = []
export const widget = { TEXT: 'TEXT', FILL_RECT: 'FILL_RECT', ARC: 'ARC', IMG: 'IMG', BUTTON: 'BUTTON' }
export const prop = { MORE: 'MORE', TEXT: 'text', VISIBLE: 'visible', COLOR: 'color', X: 'x', Y: 'y', W: 'w', H: 'h' }
export const align = { LEFT: 'left', RIGHT: 'right', CENTER_H: 'center_h', TOP: 'top', BOTTOM: 'bottom', CENTER_V: 'center_v' }
export const text_style = { ELLIPSIS: 'ellipsis', NONE: 'none', WRAP: 'wrap' }
export const event = { CLICK_UP: 'click_up', CLICK_DOWN: 'click_down' }
export let setCalls = 0

export function createWidget(type, props) {
  const w = {
    type,
    props: { visible: true, ...props },
    setProperty(key, value) {
      setCalls += 1
      if (key === prop.MORE) Object.assign(this.props, value)
      else this.props[key] = value
    },
    getProperty(key) {
      return this.props[key]
    },
    addEventListener() {},
  }
  widgets.push(w)
  return w
}

export function textWidth(text, size) {
  if (!W) return Math.round(text.length * size * 0.55)
  let total = 0
  for (const ch of text) total += W.widths[ch] !== undefined ? W.widths[ch] : W.fallback
  return Math.round((total * size) / W.size)
}

export function getTextLayout(text, opts) {
  const size = opts.text_size
  if (!opts.wrapped) return { width: textWidth(text, size), height: Math.round(size * 1.25), rows: 1, result: 0, text }
  const rows = wrap(text, size, opts.text_width)
  return { width: Math.max(...rows.map((r) => textWidth(r, size))), height: Math.round(rows.length * size * 1.25), rows: rows.length, result: 0, text }
}

export function wrap(text, size, width) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const rows = []
  let row = ''
  for (const w of words) {
    const next = row ? row + ' ' + w : w
    if (row && textWidth(next, size) > width) {
      rows.push(row)
      row = w
    } else row = next
  }
  if (row || !rows.length) rows.push(row)
  return rows
}

export function snapshot() {
  return widgets.map((w) => ({ type: w.type, ...w.props }))
}
