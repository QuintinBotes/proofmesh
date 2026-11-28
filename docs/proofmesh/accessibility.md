# Accessibility audit

The checklist for NFR012, SC013 and FR067, with the evidence for each item. `pnpm verify` runs every automated check named here. Items that are not verified are listed as such, with the reason.

## Checklist

| Requirement | Check | Evidence |
|---|---|---|
| NFR012 CLI | The CLI writes plain text and never colour; `status --json` gives JSON | `packages/proofmesh/src/cli/main.ts`; `packages/proofmesh/test/sealing.test.ts` |
| NFR012 textual equivalent | Every Observatory view has a table or text form: the Terrain's areas and their coverage, every bundle between them with its counts, or its matches, and the drawn bundles as a list of buttons; Explore's neighbours and edges, or, while the lens shows a path, its nodes in order and its edges, each with its evidence; Claims is text | `e2e/accessibility.spec.ts` (every view toggled to its table, Explore with and without a path), `e2e/terrain.spec.ts`, `e2e/terrain-typeorm.spec.ts`, `e2e/trace.spec.ts`, `e2e/lens.spec.ts`, `e2e/claims.spec.ts` |
| NFR012 WCAG 2.2 AA, automated | axe finds no serious or critical violation in any view or its table, in the dark and the light scheme | `e2e/accessibility.spec.ts` |
| NFR012 keyboard-only operation | With Tab, Enter and typing alone: search the Terrain, open a bundle's relationships, open a match in Explore, trace a path from it in the lens's Path to field, open a hop's evidence, open Claims | `e2e/accessibility.spec.ts` |
| NFR012 command palette (FR1140 to FR1146) | `Control+K`, `⌘K` or `/` opens a palette of symbols, files and commands; Enter on a symbol opens it in Explore and moves focus to its evidence; `1` to `6` open the views, `t` switches table and graph, `d` shows or hides the Diff overlay, `[` and `]` step Time one snapshot older or newer, and `?` lists every key. The palette is a modal dialog with a combobox whose active descendant is the highlighted option; Escape returns focus where it was; repository text in it is escaped as everywhere else; axe finds no serious violation with it open, in either scheme | `e2e/accessibility.spec.ts`, `e2e/palette.spec.ts`, `e2e/a11y.spec.ts` |
| FR1184 Proof lens keyboard | Explore draws its neighbourhood as the Proof lens, three lists of rows; an opened symbol takes the focus, ↑ ↓ move between rows, ← → between callers, focus and callees, Enter opens the row's call site with the cited span highlighted, `f` explores from the row, all with no pointer | `e2e/lens.spec.ts` |
| FR1183 lens rows, not colour alone | Each lens row says `observed`, `inferred` or `unresolved · <reason>` in words, with its own glyph (● ◌ ┄) and marker style (solid, dashed, dotted) | `apps/observatory/test/card.test.ts`, `e2e/lens.spec.ts` |
| FR1300 paths in the lens | The Trace a path tab is folded into Explore: Path to, Depth and Follow framework relationships are labelled controls beside the focus; the path reads as hops at their call sites with their basis in words, or, with no path, the conclusion and the horizon in words; Clear path and Trace again are buttons; axe finds no serious violation with a path shown, as graph and as table, in both schemes | `e2e/lens.spec.ts`, `e2e/accessibility.spec.ts`, `e2e/a11y.spec.ts`, `e2e/trace.spec.ts` |
| FR1761 FR1762 FR1764 Time | The scrubber is a labelled slider and the strip a list of buttons, each snapshot with its symbols and unresolved share in words; `[` and `]` step one snapshot. Each change is a shape as well as a colour (a dot, a ghost cross, a ring), and the step's counts and every change are text, in a status line and a table; under reduced motion the marks switch without animation | `e2e/time.spec.ts`, `e2e/replay.spec.ts` |
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
