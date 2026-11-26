// Ignores SIGTERM and goes silent during analyze; its pid is on stderr before it answers initialize.
import { serve } from './dying-lib.mjs'
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
serve(() => {}, () => process.stderr.write(`pid=${process.pid}\n`))
