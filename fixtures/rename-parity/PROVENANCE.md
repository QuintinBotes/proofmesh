# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture. Its shapes follow the parity benchmark's TypeORM fixture (`bench/parity`), whose code is never committed here: an interface member that several drivers implement and one driver inherits, a barrel `index.ts` with `export *` and `export { } from`, a package entry, an error class whose subclasses call `super`, a static method, a type alias, and an interface used as a type on many lines of one function.

It exercises the rename plan of FR980 to FR987 (`packages/proofmesh/test/rename-plan.test.ts`): the code sites `plan_rename` lists for ten pinned symbols are compared with the TypeScript language service's `findRenameLocations`, computed by the test, so no expected site is written by hand except the members of `Driver.escape` that must be renamed together:

- `src/driver/postgres/PostgresDriver.ts`, `src/driver/mysql/MysqlDriver.ts` (two: `MysqlDriver` and `MariaDriver`, which overrides it) and `src/driver/sqlite/SqliteDriver.ts` each declare `escape`; `AuroraDriver` implements `Driver` through what it inherits and declares none, so no site of it changes.
- `src/repository/Repository.ts` imports through the barrel (`from ".."`) and imports `camelCase` under an alias; `src/globals.ts` exports `getMetadataStorage` under another name; `src/data-source/DataSource.ts` destructures `escape`.
- `src/index.ts`, the entry, imports `bracketed` under an alias and exports the alias, so `bracketed` is public (FR1288); `quoteBy` in `src/connect.ts` calls `escape` on a receiver of the same name written on the line above (FR1289).
