// Answers analyze with a line that is not JSON and stays alive.
import { serve } from './dying-lib.mjs'
setInterval(() => {}, 1000)
serve(() => process.stdout.write('this is not json\n'))
