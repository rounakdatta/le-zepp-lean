const map = { '@zos/ui': './zos-ui.mjs', '@zos/utils': './zos-utils.mjs' }
export async function resolve(specifier, context, next) {
  if (map[specifier]) return next(new URL(map[specifier], import.meta.url).href, context)
  return next(specifier, context)
}
