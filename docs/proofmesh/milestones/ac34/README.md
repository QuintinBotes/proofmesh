# AC34: Trace view screenshot baselines, approved by the maintainer

AC34 is a human gate: the maintainer approves the Trace view screenshot baselines in both themes. These two files are the candidates, written by `e2e/trace.spec.ts` during the final `pnpm verify` on 2026-11-12, at 1400 by 900, over `fixtures/ts-invoicing`: the path from `handleInvoice` through `invoiceTotal` to `formatAmount`, with its legend.

- `trace-dark.png`: the dark theme.
- `trace-light.png`: the light theme.

To approve, record the approval in the ADR's revision history or a commit that names AC34. To reject, say what to change; the test rewrites both files on every run.

Approved by the maintainer on 2026-11-12, recorded in the ADR's revision 20.
