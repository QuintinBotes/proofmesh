-- Proofmesh catalog, migration 0013: a record of every tool query, for list_queries. Only the input's hash is kept, never its text or results (NFR008).
CREATE TABLE query_record (
  query_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  input_hash TEXT NOT NULL
) STRICT;
CREATE INDEX query_record_recent ON query_record(requested_at DESC);
