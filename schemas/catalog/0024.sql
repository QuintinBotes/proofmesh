-- Proofmesh catalog, migration 0024: the subjects of each MCP query (#50), kept beside its query record only for a repository a
-- person turned recording on for (proofmesh trail on): the symbol ids and repository-relative paths it named or found, never
-- source text, grouped by the session id the MCP server holds. Deleted with its query record (gc) and by proofmesh trail purge.
CREATE TABLE query_subject (
  session_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  -- The snapshot the symbol ids belong to when it is not the query record's: the base side of compare_snapshots.
  snapshot_id TEXT,
  symbols TEXT NOT NULL CHECK (json_valid(symbols)),
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  PRIMARY KEY (session_id, query_id)
) STRICT, WITHOUT ROWID;
