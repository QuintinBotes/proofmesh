-- Proofmesh catalog, migration 0012: a person pins a snapshot so retention never retires it (FR051).
ALTER TABLE snapshot ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
