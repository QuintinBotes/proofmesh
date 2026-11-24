-- Proofmesh catalog, migration 0003: adapter extensions a person installed (amendment A14), applied to every
-- repository in the workspace. The file's hash is recorded so a changed extension is refused, not silently run.
CREATE TABLE extension (
  adapter_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (adapter_id, path)
) STRICT;
