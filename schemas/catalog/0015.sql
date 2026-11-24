-- Proofmesh catalog, migration 0015: observations 0.3 add who read a property (the ORM or application code), the declaring type,
-- getter calls and callers; the kind joins the key, so one property can carry an ORM row and an application row for one window.
CREATE TABLE observation_property_read_v2 (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  source TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  entity TEXT NOT NULL,
  property TEXT NOT NULL,
  read_kind TEXT NOT NULL DEFAULT 'application' CHECK (read_kind IN ('orm','application')),
  reads REAL NOT NULL,
  declaring_type TEXT,
  calls REAL,
  callers TEXT CHECK (callers IS NULL OR json_valid(callers)),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, source, window_from, window_to, endpoint, entity, property, read_kind)
) STRICT;
INSERT INTO observation_property_read_v2 (repository_id, source, window_from, window_to, endpoint, entity, property, reads, imported_by, imported_at)
  SELECT repository_id, source, window_from, window_to, endpoint, entity, property, reads, imported_by, imported_at FROM observation_property_read;
DROP TABLE observation_property_read;
ALTER TABLE observation_property_read_v2 RENAME TO observation_property_read;
