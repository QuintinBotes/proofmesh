# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A small project in four languages (TypeScript in `src` and `test`, Python in `py`, Java in `java`, Go in `go`) and one coverage report per format, each written by hand in the shape its tool writes: no test was run and no coverage tool was installed. `packages/proofmesh/test/coverage-import.test.ts` imports them (#241).

| Report | Format, as written by | Covers |
|---|---|---|
| `lcov.info` | LCOV, as istanbul and c8 write it, with a `TN:` record per test and absolute paths under `/ci/build` | `src/calc.ts`: `add` run by `addsTwoNumbers`, `viaRegistry` run by `runsTheRegistry` (which no call reaches statically), `rarely` and `untouched` not run; `src/helper.ts`; one path, `util.ts`, that matches two files, and one, `src/generated.ts`, that is not in the snapshot |
| `cobertura.xml` | Cobertura XML, as coverage.py writes it | `py/shop.py` (`total` run; `discount` only by its `def` line, which runs at import) and `py/test_shop.py` |
| `jacoco.xml` | JaCoCo XML | `java/src/com/acme/Cart.java` as `com/acme/Cart.java`: `count` run, `empty` not |
| `cover.out` | a Go coverprofile, as `go test -coverprofile` writes it | `go/calc/calc.go` as `example.com/cov/go/calc/calc.go`: `Add` run, `Sub` not |
