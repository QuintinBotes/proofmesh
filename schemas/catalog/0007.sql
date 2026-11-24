-- Proofmesh catalog, migration 0007: adapters a person installed for other languages (US18). Installing one is trusting its code (D13).
CREATE TABLE adapter_install (
  id TEXT PRIMARY KEY,
  entry TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  extensions TEXT NOT NULL CHECK (json_valid(extensions)),
  config_names TEXT NOT NULL CHECK (json_valid(config_names)),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  kit TEXT CHECK (kit IS NULL OR json_valid(kit))
) STRICT;
