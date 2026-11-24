-- Proofmesh catalog, migration 0009: named workspaces (A29) and the link files sealed for them (A28).
CREATE TABLE workspace (
  name TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE workspace_member (
  workspace TEXT NOT NULL REFERENCES workspace(name),
  repository_id TEXT NOT NULL REFERENCES repository(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace, repository_id)
) STRICT;
CREATE TABLE link_file (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL REFERENCES workspace(name),
  digest TEXT NOT NULL,
  members TEXT NOT NULL CHECK (json_valid(members)),
  sealed_at TEXT NOT NULL
) STRICT;
