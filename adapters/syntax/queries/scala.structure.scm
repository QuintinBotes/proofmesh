; Appended to the package's tags query: imports, which main.ts reads whole, and the supertypes a type names (FR224, FR225). `extends` names the first, `with` and a comma each name another.
(import_declaration) @import
(_ extend: (extends_clause . type: [(type_identifier) (stable_type_identifier)] @inherits))
(_ extend: (extends_clause . type: (generic_type . [(type_identifier) (stable_type_identifier)] @inherits)))
(_ extend: (extends_clause "with" . type: [(type_identifier) (stable_type_identifier)] @implements))
(_ extend: (extends_clause "," . type: [(type_identifier) (stable_type_identifier)] @implements))
(_ extend: (extends_clause "with" . type: (generic_type . [(type_identifier) (stable_type_identifier)] @implements)))
(_ extend: (extends_clause "," . type: (generic_type . [(type_identifier) (stable_type_identifier)] @implements)))
