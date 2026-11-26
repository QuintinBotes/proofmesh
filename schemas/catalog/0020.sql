-- Proofmesh catalog, migration 0020: an index job records, per running adapter, the language, files done and total, files a second
-- and the estimate of seconds left, so get_job shows what the index prints to stderr.
ALTER TABLE index_job ADD COLUMN adapter_progress TEXT CHECK (adapter_progress IS NULL OR json_valid(adapter_progress));
