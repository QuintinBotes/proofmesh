---
id: sql-tag-clause
title: The query tag clause comes from Trellis.Twine
kind: gotcha
target: method:Shop.Data.Trellis.Twine
nodes:
  - method:Shop.Data.Trellis.Twine
patterns:
  - @p\d+ = @p\d+
---
Query reports show `@pN = @pN` where code calls `Trellis.Twine`; the clause text appears nowhere in source.
