// The side service signs the request to the helper (HMAC-SHA256 in plain JS): it must agree
// with the real thing, which is what the helper checks it with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { hmacHex, listenAuthorization } from '../../watch-app/app-side/sign.js'

test('the signature is HMAC-SHA256, for any key and message', () => {
  const cases = [
    ['abc', 'lezepplean-listen:1700000000000'],
    ['', ''],
    ['k'.repeat(64), 'exactly one block of key'],
    ['a key longer than one sixty-four byte block, which is hashed first: ' + 'x'.repeat(40), 'm'],
    ['tökén ✓', 'mültibyte 🎵 message'],
    ['abc', 'y'.repeat(200)], // several blocks of message
  ]
  for (const [key, msg] of cases) assert.equal(hmacHex(key, msg), createHmac('sha256', key).update(msg).digest('hex'), key)
})

test('the helper is sent when the request was made and its signature, never the token', () => {
  const header = listenAuthorization('s3cret-token', 1700000000000)
  assert.equal(header, 'LZL 1700000000000.' + createHmac('sha256', 's3cret-token').update('lezepplean-listen:1700000000000').digest('hex'))
  assert.ok(!header.includes('s3cret-token'))
})
