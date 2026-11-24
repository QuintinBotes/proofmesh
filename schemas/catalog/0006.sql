-- Proofmesh catalog, migration 0006: index jobs requested over MCP or HTTP, with progress a person or agent can poll.
CREATE TABLE index_job (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repository(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  phase TEXT,
  done INTEGER,
  total INTEGER,
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  error TEXT,
  owner TEXT
) STRICT;
CREATE INDEX index_job_by_repository ON index_job (repository_id, requested_at);
