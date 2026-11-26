-- Proofmesh catalog, migration 0019: a SCIP index Proofmesh produced by running a pinned indexer (A38) records the indexer, its version
-- and digest, and the trust grant that allowed the run. An index a person named has none of this (NULL).
ALTER TABLE scip_index ADD COLUMN run TEXT CHECK (run IS NULL OR json_valid(run));
