// Places the words of one lyric line as centred rows inside a box, each word as its own
// positioned item so it can be highlighted on its own. Pure logic: the caller supplies
// `measure(text, size) -> width in px` (on the watch, backed by getTextLayout).
//
// Rows are balanced: filling each row greedily left a long line as two full rows and a
// last row holding one word ("…the fire in your heart is / out"). Once the greedy pass has
// found how many rows the line needs, the words are re-split into that many rows so the
// widest one is as narrow as it can be.

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

    const count = greedyRows(widths, space, box.w)
    if (count > maxRows) continue
    const rows = balancedRows(widths, space, box.w, count)

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

function greedyRows(widths, space, maxW) {
  let rows = 1
  let rowW = 0
  for (let i = 0; i < widths.length; i++) {
    const need = rowW ? rowW + space + widths[i] : widths[i]
    if (rowW && need > maxW) {
      rows += 1
      rowW = widths[i]
    } else {
      rowW = need
    }
  }
  return rows
}

// Split words into exactly `count` rows minimising the widest row (and never wider than
// maxW). n is at most a couple of dozen words and count at most 3, so a plain DP is cheap.
function balancedRows(widths, space, maxW, count) {
  const n = widths.length
  const rowWidth = (a, b) => {
    let w = 0
    for (let i = a; i < b; i++) w += widths[i] + (i > a ? space : 0)
    return w
  }
  // best[k][i]: smallest possible widest row when the first i words form k rows
  const best = []
  const cut = []
  for (let k = 0; k <= count; k++) {
    best.push(new Array(n + 1).fill(Infinity))
    cut.push(new Array(n + 1).fill(-1))
  }
  best[0][0] = 0
  for (let k = 1; k <= count; k++) {
    for (let i = 1; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        if (best[k - 1][j] === Infinity) continue
        const w = rowWidth(j, i)
        if (w > maxW) continue
        const worst = Math.max(best[k - 1][j], w)
        if (worst < best[k][i]) {
          best[k][i] = worst
          cut[k][i] = j
        }
      }
    }
  }
  const rows = []
  let i = n
  for (let k = count; k > 0; k--) {
    const j = cut[k][i]
    const items = []
    for (let t = j; t < i; t++) items.push(t)
    rows.unshift({ items, width: rowWidth(j, i) })
    i = j
  }
  return rows
}
