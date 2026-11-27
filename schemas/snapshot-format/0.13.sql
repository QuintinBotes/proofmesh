-- Proofmesh snapshot file, format 0.13. Superset of 0.12: the term index of concept search (FR581), the words of each indexed file by line, filled at index time from its captured text. Format 0.12 was a superset of 0.11: an assertion may be of type mentions, a Markdown doc's line naming a symbol or a file in inline code or a link (FR820, FR821). Format 0.11 was a superset of 0.10: a symbol's detail, the JSON object an adapter gave it beside its name (protocol 1.2), such as scip, the SCIP index's own symbol for a definition the SCIP importer declared (FR441); null when it gave none. Format 0.10 was a superset of 0.9: an assertion and each of its candidates carry the site they are ordered by, the repository-relative path and byte position of the assertion's first evidence, filled at index time and indexed so a page of rows in that order is read without sorting them all (FR234). Format 0.9 was a superset of 0.8: a symbol's roles, the JSON array an adapter gave it (protocol 1.1): test for a test entry point, test_support for test code that is none (FR193); null when it gave none. Sealed and immutable after publication; no timestamps or random values.
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
  kind TEXT NOT NULL CHECK (kind IN ('function','class','method','interface','type_alias','variable','module','struct','enum','property','field','constructor','namespace','project','package','endpoint','table','message','channel','job','feature_flag','config_key','team','service','resource','output','module_call')),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL,
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  signature TEXT, stable_key TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence(id), body_hash TEXT, body_tokens INTEGER,
  roles TEXT CHECK (roles IS NULL OR json_valid(roles)),
  detail TEXT CHECK (detail IS NULL OR json_valid(detail))
) STRICT;
CREATE TABLE external_symbol (id TEXT PRIMARY KEY, module TEXT NOT NULL, name TEXT NOT NULL) STRICT;
CREATE TABLE assertion (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('calls','imports','contains','inherits','implements','overrides','references','injects','registered_as','exposes','maps_to','runs','dispatches_to','handles','publishes','consumes','sends_to','listens_on','evaluates_flag','reads_config','depends_on','depends_on_package','owned_by','calls_service','renders','uses_hook','provides_context','uses_context','mentions')),
  origin TEXT NOT NULL CHECK (origin IN ('syntax','semantic_resolver','configuration_adapter','framework_adapter','contract_match','runtime_observation','documentation','human_assertion','model_hypothesis')),
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved','resolved_external','candidate','ambiguous','unresolved')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('symbol','file')), source_id TEXT NOT NULL,
  target_kind TEXT CHECK (target_kind IN ('symbol','file','external')), target_id TEXT,
  reason TEXT, detail TEXT CHECK (detail IS NULL OR json_valid(detail)), adapter TEXT NOT NULL, adapter_version TEXT NOT NULL,
  analysis_mode TEXT NOT NULL CHECK (analysis_mode IN ('no_execution','trusted_build')),
  site_path TEXT NOT NULL DEFAULT '', site_byte INTEGER NOT NULL DEFAULT 0,
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
  rank INTEGER NOT NULL, reason TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', site_path TEXT NOT NULL DEFAULT '', site_byte INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (assertion_id, symbol_id)
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
CREATE INDEX candidate_by_site ON assertion_candidate (symbol_id, site_path, site_byte, type, assertion_id);
CREATE INDEX assertion_by_source_site ON assertion (source_id, site_path, site_byte, type, id);
CREATE INDEX assertion_by_target_site ON assertion (target_id, site_path, site_byte, type, id);
CREATE INDEX symbol_by_file ON symbol (file_id, start_line);
CREATE UNIQUE INDEX symbol_by_key ON symbol (stable_key);
CREATE VIRTUAL TABLE symbol_fts USING fts5(symbol_id UNINDEXED, name, qualified_name, tokenize = 'trigram');
-- Aggregates for the overview, filled at index time: resolved relationships between files by type, and symbols per file.
CREATE TABLE file_link (src_file TEXT NOT NULL, dst_file TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (src_file, dst_file, type)) STRICT, WITHOUT ROWID;
CREATE TABLE file_stat (file_id TEXT PRIMARY KEY, symbols INTEGER NOT NULL, entries INTEGER NOT NULL) STRICT, WITHOUT ROWID;
-- Concept search (FR581): each term of an indexed file (identifier words split from camelCase, PascalCase and snake_case, a multi-word identifier whole with its words joined, and the words of comments, docstrings and string literals) with the lines it occurs on, once per occurrence, space-separated and ascending; line 0 is the file's path. term_file holds a file's count of occurrences, its length for ranking.
CREATE TABLE term (term TEXT NOT NULL, file_id TEXT NOT NULL, lines TEXT NOT NULL, PRIMARY KEY (term, file_id)) STRICT, WITHOUT ROWID;
CREATE TABLE term_file (file_id TEXT PRIMARY KEY, terms INTEGER NOT NULL) STRICT, WITHOUT ROWID;
