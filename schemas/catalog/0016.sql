-- Proofmesh catalog, migration 0016: a note may list text patterns (regular expressions) that the code it targets writes, such as a
-- SQL clause a query helper adds, so a search for that text or a query-source lookup can point at the helper.
ALTER TABLE note ADD COLUMN patterns TEXT NOT NULL DEFAULT '[]';
