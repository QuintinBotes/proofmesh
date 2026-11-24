-- Proofmesh link file format 0.1 (A28): cross-repository links (A7) between the member snapshots of a workspace (A29).
-- Sealed like a snapshot and opened read-only; identity is the member snapshot ids and the link rules' versions.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- meta keys: format_version, link_file_id, workspace, identity (canonical JSON of {members, rules}), rules (JSON {rule: version}), sealed_at
CREATE TABLE member (
  repository_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  name TEXT NOT NULL
) STRICT;
-- One link extends one fact of a member snapshot (its source assertion) across a repository boundary.
CREATE TABLE link (
  id TEXT PRIMARY KEY,
  -- calls_endpoint: an outbound HTTP client fact to an endpoint another member exposes
  -- messages: a channel a member publishes to, to the same channel another member consumes
  -- depends_on_package: a package reference to the member project that builds that package
  -- calls_service: a named downstream service to the member repository that is that service (target_symbol_id is NULL)
  type TEXT NOT NULL CHECK (type IN ('calls_endpoint','messages','depends_on_package','calls_service')),
  rule TEXT NOT NULL,
  source_repository_id TEXT NOT NULL REFERENCES member(repository_id),
  source_symbol_id TEXT NOT NULL,
  source_assertion_id TEXT NOT NULL,
  target_repository_id TEXT REFERENCES member(repository_id),
  target_symbol_id TEXT,
  confidence REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved','candidate','unresolved')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('no_match','ambiguous','outside_workspace')),
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  CHECK ((resolution = 'resolved') = (target_repository_id IS NOT NULL))
) STRICT;
CREATE TABLE link_candidate (
  link_id TEXT NOT NULL REFERENCES link(id),
  target_repository_id TEXT NOT NULL REFERENCES member(repository_id),
  target_symbol_id TEXT,
  confidence REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  PRIMARY KEY (link_id, target_repository_id, target_symbol_id)
) STRICT;
CREATE INDEX link_source ON link(source_repository_id, source_symbol_id);
CREATE INDEX link_target ON link(target_repository_id, target_symbol_id);
