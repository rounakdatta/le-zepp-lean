// Word-by-word layout of one lyric line: positions for every word, inside the box, balanced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutWords } from '../../watch-app/lib/layout.js'

const measure = (text, size) => Math.round(text.length * size * 0.5) // a monospace-ish stand-in
const BOX = { x: 22, y: 188, w: 436, h: 118 }
const SIZES = [44, 40, 36, 32, 28]

function rowsOf(layout) {
  const ys = [...new Set(layout.items.map((it) => it.y))].sort((a, b) => a - b)
  return ys.map((y) => layout.items.filter((it) => it.y === y))
}

test('a short line gets the biggest size, one centred row', () => {
  const l = layoutWords(['Today', 'is', 'gonna', 'be'], BOX, SIZES, measure)
  assert.equal(l.size, 44)
  const rows = rowsOf(l)
  assert.equal(rows.length, 1)
  const left = rows[0][0].x - BOX.x
  const right = BOX.x + BOX.w - (rows[0].at(-1).x + rows[0].at(-1).w)
  assert.ok(Math.abs(left - right) <= 1, 'centred')
})

test('every word stays inside the box, in reading order', () => {
  const words = 'And backbeat, the word is on the street that the fire in your heart is out'.split(' ')
  const l = layoutWords(words, BOX, SIZES, measure)
  assert.ok(l)
  for (const it of l.items) {
    assert.ok(it.x >= BOX.x && it.x + it.w <= BOX.x + BOX.w && it.y >= BOX.y && it.y + it.h <= BOX.y + BOX.h, JSON.stringify(it))
  }
  for (let i = 1; i < l.items.length; i++) {
    const a = l.items[i - 1]
    const b = l.items[i]
    assert.ok(b.y > a.y || b.x > a.x, `word ${i} comes after word ${i - 1}`)
  }
})

test('rows are balanced: no last row left holding a single short word', () => {
  // Greedy filling gave "…in your heart is / out" here.
  const words = 'And backbeat, the word is on the street that the fire in your heart is out'.split(' ')
  const rows = rowsOf(layoutWords(words, BOX, SIZES, measure))
  const widths = rows.map((r) => r.at(-1).x + r.at(-1).w - r[0].x)
  assert.ok(Math.min(...widths) > 0.6 * Math.max(...widths), `row widths ${widths}`)
})

test('a word too wide for the box at every size gives no layout (the line is shown as text)', () => {
  assert.equal(layoutWords(['Supercalifragilisticexpialidocious-and-then-some'], BOX, SIZES, measure), null)
})
