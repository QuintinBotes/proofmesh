-- Proofmesh catalog, migration 0023: SARIF files a person imported for a repository (#30, FR1900 to FR1905). Proofmesh reads them and
-- never runs an analyser. files holds the hash of each file a finding is in, as the tree stood at import, so a later edit marks it stale.
CREATE TABLE sarif_import (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  tools TEXT NOT NULL CHECK (json_valid(tools)),
  findings TEXT NOT NULL CHECK (json_valid(findings)),
  unattached TEXT NOT NULL CHECK (json_valid(unattached)),
  files TEXT NOT NULL CHECK (json_valid(files)),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, name)
) STRICT;
