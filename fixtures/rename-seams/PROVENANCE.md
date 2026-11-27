# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture, and the names (orders, mailer, wire) are invented.

One repository with a TypeScript service (`src/*.ts`), a C# wire type (`src/Wire/`), an OpenAPI description (`openapi.yaml`) and a doc (`docs/orders.md`). It exercises the seams of the rename plan, FR980 to FR987: places a rename of a symbol breaks although no compiler binds them there, each to be listed as an inferred site with its kind.

- `route`: `openapi.yaml` names the handler `listOrders` by its `operationId`, and no code route serves `GET /orders`.
- `di_key`: `src/container.ts` registers the class `Mailer` under the string key `"Mailer"`, and `src/orders.ts` resolves it by that key.
- `serialised_key`: `src/Wire/OrderDto.cs` reads and writes the property `CustomerName` under the dictionary key `"CustomerName"`.
- `doc_mention`: `docs/orders.md` names `listOrders()`, `Mailer` and `OrderDto.CustomerName`.
- Not seams: `console.log("Mailer")` and a template that holds the name among other text.
- `tools/report.py` imports `Totals` and `add` from `tools/totals.py`, names `Totals` as a type and `add` as a value besides calling them, and `totals.py` names `Totals` twice on one line (FR1287). `OrderWire.Describe` reads `CustomerName` on two lines (FR1286).

The expected seams are written by hand in `expected.json`.
