# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture, and the names (mailer, orders, alerts) are invented.

It exercises the move plan of FR1280 to FR1285 (`packages/proofmesh/test/move-plan.test.ts`): every site a move of a file or of a symbol must change.

- `src/mail/mailer.ts` is imported by `src/orders.ts` (two names), by `src/alerts.ts` (with a `.js` extension, as ESM writes it) and dynamically by `test/mailer.test.ts`, and `src/index.ts`, the package's `main`, re-exports it with `export *`. It imports `../util/text` itself, so a move to another depth changes its own import.
- `Mailer` uses `formatSubject` of its own file and, through it, nothing else; `defaultMailer` in the same file uses `Mailer`, so a move of `Mailer` alone leaves its old file needing an import.
- Path seams: `test/mailer.test.ts` names the file in a string a mock registry reads, and `package.json` exports it as `./mailer`. `console.log("mail/mailer")` names no file and is no seam.
- Doc mentions: `docs/mail.md` links to the file and names it in inline code.
