-- Proofmesh catalog, migration 0017: an index job records when it last reported progress, when its current phase began, and its
-- plan (incremental or full, and how many files it analyses), so a caller can tell a slow run from a stuck one.
ALTER TABLE index_job ADD COLUMN progress_at TEXT;
ALTER TABLE index_job ADD COLUMN phase_started_at TEXT;
ALTER TABLE index_job ADD COLUMN plan TEXT;
