// Exits 137 with an out-of-memory message on stderr, as a container runtime reports a killed child.
import { serve } from './dying-lib.mjs'
serve(() => { process.stderr.write('FATAL ERROR: Out of memory\n'); process.exit(137) })
