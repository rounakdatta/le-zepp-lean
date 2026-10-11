const STUBS = './zos-stubs.mjs'
const map = {
  '@zos/ui': './zos-ui.mjs',
  '@zos/utils': './zos-utils.mjs',
  '@zos/interaction': STUBS,
  '@zos/display': STUBS,
  '@zos/sensor': STUBS,
  '@zos/settings': STUBS,
  '@zos/media': STUBS,
  '@zos/fs': STUBS,
  '@zeppos/zml/base-page': STUBS,
}
export async function resolve(specifier, context, next) {
  if (map[specifier]) return next(new URL(map[specifier], import.meta.url).href, context)
  return next(specifier, context)
}
