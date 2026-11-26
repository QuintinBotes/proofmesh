// Exits as soon as the first bytes of an analyze request arrive, while the host is still writing the rest.
import { serve } from './dying-lib.mjs'
serve(() => {})
process.stdin.on('data', (chunk) => { if (chunk.includes('"analyze"')) process.exit(9) })
