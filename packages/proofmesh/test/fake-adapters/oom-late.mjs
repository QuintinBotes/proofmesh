// Exits 1 with the out-of-memory marker far past the head of its stderr line.
import { serve } from './dying-lib.mjs'
serve(() => process.stderr.write(`${'z'.repeat(500)} FATAL: Out of memory\n`, () => process.exit(1)))
