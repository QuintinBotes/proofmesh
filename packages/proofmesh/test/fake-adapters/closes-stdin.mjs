// Closes its input before it answers initialize, then keeps running without ever reading again.
import { closeSync } from 'node:fs'
import { serve } from './dying-lib.mjs'
setInterval(() => {}, 1000)
serve(() => {}, () => { process.stdin.destroy(); closeSync(0) })
