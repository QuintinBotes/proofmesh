-- Proofmesh catalog, migration 0004: memory notes. A person registers note directories and syncs them; a note's
-- fingerprint records its referenced symbols' relationships when a person accepted it, so drift shows as staleness.
CREATE TABLE note_source (
  path TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
) STRICT;
CREATE TABLE note (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL REFERENCES note_source(path),
  file TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT,
  target TEXT,
  refs TEXT NOT NULL CHECK (json_valid(refs)),
  sources TEXT NOT NULL CHECK (json_valid(sources)),
  body TEXT NOT NULL,
  fingerprint TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  synced_at TEXT NOT NULL
) STRICT;
