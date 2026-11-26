// Prints an environment-style secret and a line of source to stderr, then exits during analyze.
import { serve } from './dying-lib.mjs'
serve(() => {
  process.stderr.write(`LEDGER_API_TOKEN=${['tok', 'live', '5f2a9c1e7b3d4a68'].join('_')}\n`)
  process.stderr.write('const invoiceTotal = ledger.lines.reduce((sum, l) => sum + l.amount, 0)\n')
  process.stderr.write('unhandled failure in the analyzer\n', () => process.exit(3))
})
