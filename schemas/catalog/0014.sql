-- Proofmesh catalog, migration 0014: observed entity property reads per endpoint, imported from an observations 0.2 file (A30). Never part of snapshot identity.
CREATE TABLE observation_property_read (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  source TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  entity TEXT NOT NULL,
  property TEXT NOT NULL,
  reads REAL NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, source, window_from, window_to, endpoint, entity, property)
) STRICT;
