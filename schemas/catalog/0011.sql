-- Proofmesh catalog, migration 0011: verification execution (D07, FR043 to FR047). Off until a person enables it; each approval is one-time.
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repository(id),
  snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'approved', 'consumed', 'finished', 'failed', 'expired')),
  binding TEXT NOT NULL CHECK (json_valid(binding)),
  binding_hash TEXT NOT NULL,
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  consumed_at TEXT,
  record TEXT CHECK (record IS NULL OR json_valid(record)),
  error TEXT
) STRICT;
