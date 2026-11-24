-- Proofmesh catalog, migration 0018: a workspace member may name its service registry (A7), a file relative to its root that lists the
-- callers it grants. Indexing the member captures the file, and the workspace's link file reads it from the member's snapshot.
ALTER TABLE workspace_member ADD COLUMN registry TEXT;
