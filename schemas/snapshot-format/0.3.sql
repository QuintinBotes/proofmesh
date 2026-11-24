-- Proofmesh snapshot file, format 0.3. Superset of 0.2: the service symbol kind and the calls_service relationship (A17). Sealed and immutable after publication; no timestamps or random values.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE file (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_hash TEXT, size INTEGER NOT NULL,
  language TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('indexed','excluded_by_rule','unsupported','failed','pending')),
  disposition_detail TEXT,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  CHECK ((disposition = 'indexed') = (content_hash IS NOT NULL))
) STRICT;
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES file(id), object_hash TEXT NOT NULL,
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('declaration','call_site','import_statement','reference_site','configuration')),
  extractor TEXT NOT NULL, extractor_version TEXT NOT NULL,
  analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('no_execution','trusted_build')),
  CHECK (start_byte >= 0 AND end_byte > start_byte AND end_line >= start_line)
) STRICT;
CREATE TABLE symbol (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES file(id),
  kind TEXT NOT NULL CHECK (kind IN ('function','class','method','interface','type_alias','variable','module','struct','enum','property','field','constructor','namespace','project','package','endpoint','table','message','channel','job','feature_flag','config_key','team','service')),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL,
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature TEXT, stable_key TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id)
) STRICT;
CREATE TABLE external_symbol (id TEXT PRIMARY KEY, module TEXT NOT NULL, name TEXT NOT NULL) STRICT;
CREATE TABLE assertion (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('calls','imports','contains','inherits','implements','overrides','references','injects','registered_as','exposes','maps_to','runs','dispatches_to','handles','publishes','consumes','sends_to','listens_on','evaluates_flag','reads_config','depends_on','depends_on_package','owned_by','calls_service')),
  origin TEXT NOT NULL CHECK (origin IN ('syntax','semantic_resolver','configuration_adapter','framework_adapter','contract_match','runtime_observation','documentation','human_assertion','model_hypothesis')),
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved','resolved_external','candidate','ambiguous','unresolved')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('symbol','file')), source_id TEXT NOT NULL,
  target_kind TEXT CHECK (target_kind IN ('symbol','file','external')), target_id TEXT,
  reason TEXT, detail TEXT CHECK (detail IS NULL OR json_valid(detail)), adapter TEXT NOT NULL, adapter_version TEXT NOT NULL,
  analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('no_execution','trusted_build')),
  CHECK ((resolution IN ('resolved','resolved_external')) = (target_id IS NOT NULL)),
  CHECK ((resolution = 'resolved_external') = (target_kind IS 'external')),
  CHECK ((resolution IN ('resolved','resolved_external')) OR reason IS NOT NULL)
) STRICT;
CREATE TABLE assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES assertion(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (assertion_id, evidence_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE assertion_candidate (
  assertion_id TEXT NOT NULL REFERENCES assertion(id), symbol_id TEXT NOT NULL REFERENCES symbol(id),
  rank INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (assertion_id, symbol_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE edge (
  src TEXT NOT NULL, type TEXT NOT NULL, dst TEXT NOT NULL, resolution TEXT NOT NULL,
  assertion_id TEXT NOT NULL REFERENCES assertion(id),
  PRIMARY KEY (src, type, dst, assertion_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX edge_by_dst ON edge (dst, type, src);
CREATE INDEX assertion_by_source ON assertion (source_id, type);
CREATE INDEX assertion_by_resolution ON assertion (resolution, type, id);
CREATE INDEX assertion_by_target ON assertion (target_id, type);
CREATE INDEX candidate_by_symbol ON assertion_candidate (symbol_id);
CREATE VIRTUAL TABLE symbol_fts USING fts5(symbol_id UNINDEXED, name, qualified_name, tokenize = 'trigram');
-- Aggregates for the overview, filled at index time: resolved relationships between files by type, and symbols per file.
CREATE TABLE file_link (src_file TEXT NOT NULL, dst_file TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (src_file, dst_file, type)) STRICT, WITHOUT ROWID;
CREATE TABLE file_stat (file_id TEXT PRIMARY KEY, symbols INTEGER NOT NULL, entries INTEGER NOT NULL) STRICT, WITHOUT ROWID;
