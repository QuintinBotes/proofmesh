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
