-- Proofmesh catalog, migration 0021: the session trail (#114). What a Claude Code session searched, opened, changed and claimed, kept
-- only for a repository a person turned recording on for: repository-relative paths and symbol ids, never source text or patterns.
CREATE TABLE trail_setting (
  repository_id TEXT PRIMARY KEY,
  recording INTEGER NOT NULL CHECK (recording IN (0, 1)),
  changed_at TEXT NOT NULL
) STRICT;
CREATE TABLE trail_entry (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  agent_id TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('searched', 'opened', 'changed', 'claimed')),
  tool TEXT NOT NULL,
  path TEXT,
  symbol_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;
CREATE INDEX trail_entry_recorded ON trail_entry(recorded_at);
-- A session whose trail reached the cap; entries past it were dropped.
CREATE TABLE trail_cut (session_id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL) STRICT;
