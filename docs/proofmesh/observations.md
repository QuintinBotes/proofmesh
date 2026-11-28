# Runtime observations

Proofmesh never connects to a metrics system or a running service (A30). A person exports what they observed into a JSON file in the Proofmesh observations schema and imports it with `proofmesh observe import <repository> <file>`. The counts are then shown beside static facts as what was observed in that window, never as load derived from code.

## The file

`schemas/observations/0.3.schema.json` (0.1 and 0.2 files are still accepted):

- `source`: where the numbers came from; `window`: the observed interval, RFC 3339.
- `counts`: requests per endpoint, rows read or written per table, messages per channel.
- `property_reads`: entity properties observed read while serving an endpoint. `entity` is the runtime type of the instance and `declaring_type` the declaring type when it differs (inherited or table-per-hierarchy properties). `reads` counts requests that read the property, `calls` counts getter calls. `read_kind` separates reads the ORM makes while materialising or tracking an entity (`orm`: loaded, not necessarily used) from reads by application code (`application`).

`proofmesh observe validate <file>` checks a file without importing it.

## Queries

- `get_table_reach` lists the reads of the entities mapped to a table beside the static reach.
- `get_property_reads` answers by endpoint or by entity, independent of table mapping: every read with its kind and callers, `loaded_not_used` (ORM reads with no application read, the candidates to leave out of a projection) and `unread_mapped_properties` (properties the snapshot declares on the entity that no import mentions).
- With an endpoint, `get_property_reads` also gives the static side: `static_reads`, the properties of mapped entities (their subtypes and base types) that code on a resolved path from the endpoint reads, with up to five readers and the hop count; `static_bound`, the calls on those paths with no single resolved target, past which reads are not seen; and `comparison`, which properties were read statically and observed, only statically, or only observed, counting application reads only. Static reads are an upper bound on one request and miss reflection and serialization: an entity returned whole is read property by property by the serializer.

A property absent from the imports was not seen read in that window. That is not evidence that nothing reads it, and every answer says so.

## Coverage reports (#241, FR2060 to FR2067)

`find_tests` and `impact_completeness` find tests by static reach through the call graph, which misses a test that runs code through reflection, dependency injection, a framework or an HTTP call, and lists tests that could reach code but never do. A coverage report a test run wrote settles it, and Proofmesh imports one beside the static facts. It runs no test; a person or CI produces the report.

`proofmesh observe import <repository> <report> --format lcov|cobertura|jacoco|go-cover [--source NAME] [--test NAME] [--strip-prefix P]`:

- Formats: LCOV (istanbul, c8, gcov and lcov for JavaScript and C/C++), Cobertura XML (coverage.py, coverlet for Python and .NET), JaCoCo XML (JVM) and the Go coverprofile (`go test -coverprofile`). Others convert to one of them. Line coverage only: a line is executed when it has a hit.
- Paths: a report path is matched to the snapshot path it equals, else, after `--strip-prefix` is stripped, to the one indexed path it ends with or that ends with it, the longest shared suffix winning. A path two indexed paths match equally (`util.ts` with `src/a/util.ts` and `src/b/util.ts`) is `ambiguous`, and one no indexed path matches `not_in_snapshot`; the command lists both and attaches neither. It prints the files matched and the lines covered.
- Each matched file is stored with its content hash in the current snapshot. Coverage of a file whose content in the asked snapshot differs is `stale`: it is shown, and sets no status, until a new report is imported.
- `--source` labels the import (default: the file name without its extension); a report of the same source replaces the earlier one. Tests: LCOV `TN:` records name the test of each record; with `--test NAME` the whole report is that test's, and it replaces only that test's lines in the source, so one report per test builds a per-test map.
- `proofmesh observe validate <report> --format F` reads a report and prints its files, lines covered and tests without importing it. `observe list` lists coverage imports beside observations.

What the answers say:

- Each executable line belongs to the innermost symbol holding it, as `get_symbols_at` picks it, or to the file's module; a file asked for by path holds every line. A symbol is executed when at least one of its lines has a hit; `lines_covered` and `lines_total` let a caller ask for more. A declaration line that runs at import, such as a Python `def`, counts for its function.
- `find_tests` and `get_symbol` (full envelope) carry `coverage: { executed, lines_covered, lines_total, source, format, window, stale, at }` when an import covers the subject's file, from the newest import of that file that is not stale; `at` is the first executed line. `window` is the report file's modification time. The lean header of `find_tests` says `executed by coverage <source>`, `not executed by coverage <source>` or `coverage stale <source>`. Every test a report names as running the subject, that is one test symbol of the snapshot and that no static chain lists, is a row with `evidence: coverage`, depth 1 and no chain; static rows are never removed.
- `impact_completeness` marks a dependent that no test reaches statically and whose lines the report shows executed `covered`, with the report's source, and counts `covered` apart in `totals` and the summary; `neither` is then neither changed, statically tested nor covered. `proofmesh completeness` treats covered as tested for its exit code unless `--static-only` is given.
- `workspace_status` lists each import with its source, format, time, window, files matched and stale files.
- Coverage adds no relationship and changes no basis (FR189). With no import, every answer is as it was.

## Recording property reads in a .NET test run

A recipe that produced valid files for an ASP.NET application with an EF6 model, in an integration-test project. It is a capture helper a person adds to their own test project; Proofmesh ships no agent and runs nothing.

1. Patch every entity getter with a Harmony postfix. Enumerate the element types of every `DbSet` on the context and every subtype of them in the model assembly: patching only the `DbSet` element types misses every subtype.
2. Label each request. A Harmony prefix on the endpoint middleware's invoke method stores `METHOD RoutePattern.RawText` in an `AsyncLocal`, which matches Proofmesh endpoint names exactly. Clear the label when the request ends, or later reads inherit it.
3. Classify each read by walking the stack of every getter call: a frame inside the ORM's namespaces is an `orm` read, anything else an `application` read, and the nearest application frame is the caller. Sampling the first few stacks per property misclassifies everything as ORM, because the ORM reads first.
4. Aggregate per endpoint, runtime type, declaring type, property and kind: requests that read it, getter calls, up to twenty callers. Write the file and run `proofmesh observe validate`.
