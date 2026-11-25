; Appended to the package's tags query: `use` imports and the supertypes a class or interface names (FR221, FR222). A grouped `use A\{B, C}` keeps its prefix as the module and the written clauses as names.
(namespace_use_declaration (namespace_use_clause [(qualified_name) (name)] @import.module alias: (name)? @import.alias)) @import
(namespace_use_declaration (namespace_name) @import.module body: (namespace_use_group) @import.names) @import
(class_declaration (base_clause [(name) (qualified_name)] @inherits))
(interface_declaration (base_clause [(name) (qualified_name)] @inherits))
(class_declaration (class_interface_clause [(name) (qualified_name)] @implements))
