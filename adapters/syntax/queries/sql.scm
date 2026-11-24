; The package ships no tags query. A view is queried as a table is, so it is one.
(create_table (object_reference) @name) @definition.table
(create_view (object_reference) @name) @definition.table
(create_materialized_view (object_reference) @name) @definition.table
(create_function (object_reference) @name) @definition.function
(create_procedure (object_reference) @name) @definition.function
; A common table expression's name is local to its statement, so a relation that names it is not a table.
(cte (identifier) @name) @local
(relation (object_reference) @name) @reference.table
(insert (object_reference) @name) @reference.table
(from (object_reference) @name) @reference.table
(column_definition (keyword_references) (object_reference) @name) @reference.table
(invocation (object_reference) @name) @reference.call
