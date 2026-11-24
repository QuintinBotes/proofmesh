-- Proofmesh catalog, migration 0008: SCIP indexes a person named for a repository (A24, A27). Proofmesh reads them and never runs an indexer.
CREATE TABLE scip_index (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  tool TEXT NOT NULL,
  files TEXT NOT NULL CHECK (json_valid(files)),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, name)
) STRICT;
