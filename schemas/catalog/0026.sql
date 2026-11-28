-- Revision-bound evidence explicitly imported from a producer (#298, #300).
CREATE TABLE producer_import (
  repository_id TEXT NOT NULL REFERENCES repository(id),
  kind TEXT NOT NULL CHECK (kind IN ('cquery','generates')),
  name TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshot(id),
  revision TEXT NOT NULL,
  producer TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  PRIMARY KEY (repository_id, kind, name, snapshot_id)
) STRICT;
CREATE TABLE generated_link (
  repository_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generates' CHECK(kind = 'generates'),
  name TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(json_valid(source)),
  target TEXT NOT NULL CHECK(json_valid(target)),
  FOREIGN KEY(repository_id,kind,name,snapshot_id) REFERENCES producer_import(repository_id,kind,name,snapshot_id) ON DELETE CASCADE,
  PRIMARY KEY(repository_id,snapshot_id,name,source_id,target_id)
) STRICT;
CREATE INDEX generated_link_to ON generated_link(repository_id,snapshot_id,target_id);
CREATE INDEX generated_link_from ON generated_link(repository_id,snapshot_id,source_id);
