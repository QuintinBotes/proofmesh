// Starts a grandchild that outlives its parent, names it on stderr, then goes silent during analyze.
import { spawn } from 'node:child_process'
import { serve } from './dying-lib.mjs'
setInterval(() => {}, 1000)
serve(() => {}, () => {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  process.stderr.write(`grandchild=${g.pid}\n`)
})
