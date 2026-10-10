// Places the words of one lyric line as centred rows inside a box, each word as its own
// positioned item so it can be highlighted on its own. Pure logic: the caller supplies
// `measure(text, size) -> width in px` (on the watch, backed by getTextLayout).

// Largest size in `sizes` at which the words fit the box; null if they don't fit at all.
export function layoutWords(words, box, sizes, measure, lineHeight) {
  const lh = lineHeight || ((size) => Math.round(size * 1.25))
  for (let s = 0; s < sizes.length; s++) {
    const size = sizes[s]
    const rowH = lh(size)
    const maxRows = Math.floor(box.h / rowH)
    const space = Math.max(1, measure('a a', size) - 2 * measure('a', size))
    const widths = words.map((w) => measure(w, size))
    if (!maxRows || widths.some((w) => w > box.w)) continue

    const rows = []
    let row = []
    let rowW = 0
    for (let i = 0; i < words.length; i++) {
      const need = row.length ? rowW + space + widths[i] : widths[i]
      if (row.length && need > box.w) {
        rows.push({ items: row, width: rowW })
        row = [i]
        rowW = widths[i]
      } else {
        row.push(i)
        rowW = need
      }
    }
    if (row.length) rows.push({ items: row, width: rowW })
    if (rows.length > maxRows) continue

    const top = box.y + Math.round((box.h - rows.length * rowH) / 2)
    const items = []
    rows.forEach((r, ri) => {
      let x = box.x + Math.round((box.w - r.width) / 2)
      r.items.forEach((i) => {
        items[i] = { x, y: top + ri * rowH, w: widths[i], h: rowH }
        x += widths[i] + space
      })
    })
    return { size, items }
  }
  return null
}
