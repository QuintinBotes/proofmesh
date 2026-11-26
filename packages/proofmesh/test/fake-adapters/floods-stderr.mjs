// Writes a great deal to stderr, once as one endless line and once as many lines, then exits during analyze.
import { serve } from './dying-lib.mjs'
serve(() => {
  const noise = 'x'.repeat(1 << 20)
  for (let i = 0; i < 40; i++) process.stderr.write(noise)
  for (let i = 0; i < 100000; i++) process.stderr.write(`noise line ${i}\n`)
  for (let i = 0; i < 30; i++) process.stderr.write(`${'y'.repeat(1000)}\n`)
  process.stderr.write('the last words\n', () => process.exit(1))
})
