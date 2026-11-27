-- Proofmesh catalog, migration 0022: snapshots imported from a file another data directory exported (#39, FR1080 to FR1085). The
-- sealed file is the exporter's, unchanged; this row says where it came from and which of its files differed from the working tree
-- it was imported into, so every answer from it can say so.
CREATE TABLE imported_snapshot (
  snapshot_id TEXT PRIMARY KEY REFERENCES snapshot(id),
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  stale TEXT NOT NULL CHECK (json_valid(stale))
) STRICT;
