// Ignores SIGTERM. When analyze starts it writes its pid to adapter.pid in its working directory (the ready gate) and goes silent.
import fs from 'node:fs'
import { serve } from './dying-lib.mjs'
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
serve(() => fs.writeFileSync('adapter.pid', String(process.pid)))
