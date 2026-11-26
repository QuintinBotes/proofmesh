// Killed by a signal in the middle of an analyze call, as the kernel's out-of-memory killer does.
import { serve } from './dying-lib.mjs'
serve(() => process.kill(process.pid, 'SIGKILL'))
