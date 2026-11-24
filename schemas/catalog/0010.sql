-- Proofmesh catalog, migration 0010: runtime observations a person imported from a metrics file (A9, A30). Never part of snapshot identity.
CREATE TABLE observation (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  source TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('endpoint','table','channel')),
  subject_name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('requests','rows_read','rows_written','messages')),
  value REAL NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, source, window_from, window_to, subject_kind, subject_name, metric)
) STRICT;
