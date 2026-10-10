// Small persisted settings. Uses a plain file rather than LocalStorage, which a T-Rex 3
// developer measured returning empty reads 27-67% of the time.
import { readFileSync, writeFileSync } from '@zos/fs'

const FILE = 'prefs.json'
const DEFAULTS = { adjustMs: 0 }

export function loadPrefs() {
  try {
    const text = readFileSync({ path: FILE, options: { encoding: 'utf8' } })
    const saved = text ? JSON.parse(String(text)) : {}
    return { adjustMs: Number(saved.adjustMs) || 0 }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs) {
  try {
    writeFileSync({ path: FILE, data: JSON.stringify(prefs), options: { encoding: 'utf8' } })
  } catch (e) {
    // not fatal: the adjustment just won't survive a restart
  }
}
