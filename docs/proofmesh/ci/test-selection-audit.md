# Audit changed-test selection

Keep running the full suite at the selected head commit. The impact workflow uploads `proofmesh-selection.json` from `proofmesh tests --changed --json`. It records the base and head commits and snapshots, each selected file's graph evidence, and the reasons ProofMesh advises a full run. Compare it with the complete JUnit XML produced by the full-suite job for that same commit.

```sh
python3 docs/proofmesh/ci/audit-tests.py proofmesh-selection.json junit.xml \
  --head "$TESTED_COMMIT" --suite-exit "$TEST_EXIT" \
  --repo-url https://github.com/OWNER/REPO > selection-audit.json
```

Use the actual runner exit code, 0 for success or 1 for test failures. A crashed or cancelled run has no complete report. Keep it out of the audit. For sharded runs, merge every expected shard and retain the aggregate counts before replaying. Each testsuite must declare its test count. An XML error, count mismatch, empty suite report or conflicting runner status exits 2 without a result.

Test files come from the JUnit testcase's repository-relative `file` attribute. Supply `--mapping test-files.json` for runners that omit it, for example `{"billing.InvoiceTest::rounds cents":"tests/billing/invoice.test.ts"}`. A missing mapping stays visible with the test's outcome. Skipped tests are counted separately. Failure recall is uninformative on green runs and unknown when a failing test cannot be mapped. Omitted test seconds sum only recorded per-test durations. Parallel execution and job overhead affect elapsed CI time.

In CI, add the following reporting job to the example impact workflow alongside the repository's existing `full-suite` job. Have that job upload a `full-suite-junit` artifact containing `junit.xml`, `head.txt` from `git rev-parse HEAD`, and `exit.txt` with the runner's exit status. Run the full suite on the PR head (a synthetic merge commit differs). Preserve the full-suite job's own exit status.

```yaml
  audit:
    needs: [impact, full-suite]
    if: always() && !cancelled() && needs.impact.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          repository: QuintinBotes/proofmesh
          ref: main # pin the same revision used in the impact job
      - uses: actions/download-artifact@v4
        with:
          name: proofmesh-selection
          path: inputs
      - uses: actions/download-artifact@v4
        with:
          name: full-suite-junit
          path: inputs/full
      - run: |
          python3 docs/proofmesh/ci/audit-tests.py inputs/proofmesh-selection.json inputs/full/junit.xml \
            --head "$(cat inputs/full/head.txt)" --suite-exit "$(cat inputs/full/exit.txt)" \
            --repo-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" > selection-audit.json
      - uses: actions/upload-artifact@v4
        with:
          name: selection-audit
          path: selection-audit.json
          if-no-files-found: error
```

The JSON includes changed-source links at their exact commits, the selection reasons, observed omissions and unmapped outcomes. Review misses across changes before enabling any pruning.

### Warm-cache timing on TypeORM

On 28 November 2026 the report step ran against the 504-file TypeORM parity fixture at upstream commit `3d55188c0dd1256f520143379ecf97f45e71acba`. In a private copy of that fixture, the benchmark inserted `void "impact benchmark"` before the first `super(` in each of the first ten files in `src/error` (sorted by filename) that contained both `constructor(` and `super(`. It committed the change and ran the sample's five local commands in order, with the same data directory across runs. Timing includes process startup, repository registration, both report formats and JSON test selection.

| Cache state | Elapsed |
| --- | ---: |
| First run, including indexing both commits | 9.97 s |
| Warm run 1 | 1.44 s |
| Warm run 2 | 1.35 s |
| Warm run 3 | 1.30 s |

Each report found ten changed symbols and 40 dependent rows. Both report commands exited 1. Test selection exited 3 and reported the depth limit, so a CI job would run the full suite. The local timings cover the ProofMesh commands. Hosted checkout, cache transfer, artifact upload and comment posting have separate costs.

The offline SARIF report test reads the OASIS 2.1.0 Errata 01 schema from a pinned development dependency. Its draft-07 adaptation changes only the schema dialect and identifier keys. The release source export includes the test and lockfile, and the published package contains the report writer. The canonical schema and terms are available in the [OASIS publication](https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html).
