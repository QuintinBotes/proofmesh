# Accessibility audit

The checklist for NFR012, SC013 and FR067, with the evidence for each item. `pnpm verify` runs every automated check named here. Items that are not verified are listed as such, with the reason.

## Checklist

| Requirement | Check | Evidence |
|---|---|---|
| NFR012 CLI | The CLI writes plain text and never colour; `status --json` gives JSON | `packages/proofmesh/src/cli/main.ts`; `packages/proofmesh/test/sealing.test.ts` |
| NFR012 textual equivalent | Every Observatory view has a table or text form: the Galaxy's areas and their coverage, or its matches; the Map's areas and matches; Explore's neighbours and edges; Trace's nodes in order and its edges, each with its evidence; Claims is text | `e2e/accessibility.spec.ts` (every view toggled to its table), `e2e/galaxy.spec.ts`, `e2e/trace.spec.ts`, `e2e/claims.spec.ts` |
| NFR012 WCAG 2.2 AA, automated | axe finds no serious or critical violation in any view or its table, in the dark and the light scheme | `e2e/accessibility.spec.ts` |
| NFR012 keyboard-only operation | With Tab, Enter, `/` and typing alone: search the Galaxy, open a match in Explore, trace a path from it, open a hop's evidence, open Claims | `e2e/accessibility.spec.ts` |
| SC013 | Every view has a non-visual equivalent that passes this checklist | the rows above |
| FR067 reduced motion | `prefers-reduced-motion` is honoured | `e2e/a11y.spec.ts` |
| FR067 colour scheme | The light scheme is drawn and passes axe as the dark one does | `e2e/accessibility.spec.ts`, `e2e/trace.spec.ts` |
| FR067 contrast | `prefers-contrast: more` gives secondary text and lines the full text colour and thickens fog outlines | `e2e/accessibility.spec.ts` |
| FR057, not colour alone | Edges and boundaries carry words as well as colour: unresolved stubs name their reason and line, framework edges their type and rule, horizon badges their count and stop reason, claim layers their outcome | `apps/observatory/test/scene.test.ts`, `apps/observatory/test/explore.test.ts`, `e2e/claims.spec.ts` |
| Untrusted text | Repository text renders as text, with bidirectional and invisible characters made visible | `e2e/security.spec.ts`, `apps/observatory/test/scene.test.ts` |

## Not verified

- Screen readers. No pass with VoiceOver or NVDA has been made. The tables and live regions are written for them, and axe checks their roles and names, but that is not the same as listening to them.
- Reflow at 320 CSS pixels (WCAG 1.4.10). The graph canvases are two-dimensional content, which the criterion exempts, but the side panels have not been checked at that width.
- Automated checks cover only part of WCAG 2.2 AA. axe does not judge reading order, the meaning of link text, or whether focus is easy to follow; those need a person.
