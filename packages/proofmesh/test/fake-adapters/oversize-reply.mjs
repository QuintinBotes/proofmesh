// Writes one reply line over the host's cap: its first path says whether the bytes come from multi-byte characters or one chunk with a newline.
import { serve } from './dying-lib.mjs'
setInterval(() => {}, 1000)
serve((req) => {
  if (req.params.paths[0] === 'multibyte') process.stdout.write('€'.repeat(400))
  else process.stdout.write(`${'a'.repeat(1100)}\n`)
})
