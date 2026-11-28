-- Proofmesh catalog, migration 0025: coverage reports a person imported for a repository (#241, FR2060 to FR2066). Proofmesh reads them and
-- never runs a test. files holds, per matched snapshot path, the file's content hash in the snapshot at import, its executable lines and the
-- lines each test hit, so a later edit marks it stale. unmatched holds the report paths no indexed file matched, with the reason.
CREATE TABLE coverage_import (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  source TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  files TEXT NOT NULL CHECK (json_valid(files)),
  unmatched TEXT NOT NULL CHECK (json_valid(unmatched)),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, source)
) STRICT;
