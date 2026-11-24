-- Proofmesh catalog, migration 0005: structured claims and their verification runs (FR027, FR028).
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  proposition TEXT NOT NULL CHECK (json_valid(proposition)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE verification_run (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claim(id),
  snapshot_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  layers TEXT NOT NULL CHECK (json_valid(layers)),
  dependencies TEXT NOT NULL CHECK (json_valid(dependencies)),
  verified_at TEXT NOT NULL
) STRICT;
CREATE INDEX verification_run_by_claim ON verification_run (claim_id, verified_at);
