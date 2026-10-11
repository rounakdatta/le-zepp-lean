export const px = (x) => x
// What the code logged as an error (the page's guard() logs anything a handler threw).
export const errors = []
export const log = { getLogger: () => ({ log() {}, error(m) { errors.push(m) }, warn() {}, info() {} }) }
