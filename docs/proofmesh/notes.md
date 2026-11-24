# Notes

A note is a Markdown file a person keeps in a notes directory, with frontmatter between `---` lines. Proofmesh reads it, ties it to the symbols it names, and tells agents when the code under it has changed since a person accepted it.

```
proofmesh notes add <dir>      # a directory of notes
proofmesh notes sync           # read every note again
proofmesh notes list
proofmesh notes accept <id>    # accept a note against the current snapshot
```

```markdown
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
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits and hyphens; defaults to the file name. |
| `title` | Required. |
| `kind` | One of `domain`, `capability`, `decision`, `gotcha`, `invariant`, `glossary`, `ownership`; default `gotcha`. |
| `target`, `nodes` | Symbols as `kind:qualified name`. Accepting a note records a fingerprint of their relationships; when it changes, `get_memory` marks the note changed. |
| `patterns` | Regular expressions, matched without regard to case, for text the target code writes, such as a SQL clause a helper adds (A33). `search_sources` names an accepted note whose pattern the searched text matches, and `find_query_source` counts a candidate that reaches the note's target. |

Agents can propose notes with `save_memory`; those live only in the catalog and stay unaccepted until a person accepts them.
