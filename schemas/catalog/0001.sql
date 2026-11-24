-- Proofmesh catalog, migration 0001. Mutable registry of repositories, snapshots, and leases.
CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
CREATE TABLE repository (
  id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE snapshot (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repository(id),
  state TEXT NOT NULL CHECK (state IN ('staging','published','failed','retired')),
  identity_hash TEXT NOT NULL,
  store_digest TEXT,
  analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('no_execution','trusted_build')),
  created_at TEXT NOT NULL, published_at TEXT, failure TEXT,
  CHECK ((state = 'published') = (store_digest IS NOT NULL AND published_at IS NOT NULL))
) STRICT;
CREATE TABLE current_snapshot (
  repository_id TEXT PRIMARY KEY REFERENCES repository(id),
  snapshot_id TEXT NOT NULL REFERENCES snapshot(id)
) STRICT;
CREATE TABLE index_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), owner TEXT NOT NULL, expires_at TEXT NOT NULL
) STRICT;
