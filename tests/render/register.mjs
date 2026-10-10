// node --import ./tests/render/register.mjs …: point @zos/* imports at the stand-ins.
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
