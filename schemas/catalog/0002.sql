-- Proofmesh catalog, migration 0002: build-evaluation trust grants (D14) and per-repository adapter configuration.
CREATE TABLE trust_grant (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repository(id),
  mode TEXT NOT NULL CHECK (mode IN ('build_evaluation')),
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT
) STRICT;
CREATE INDEX trust_grant_by_repository ON trust_grant (repository_id, revoked_at);
CREATE TABLE adapter_config (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  adapter_id TEXT NOT NULL,
  config TEXT NOT NULL CHECK (json_valid(config)),
  PRIMARY KEY (repository_id, adapter_id)
) STRICT;
