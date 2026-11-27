; Appended to the package's tags query: `use` imports and the supertypes a class or interface names (FR221, FR222). A grouped `use A\{B, C}` keeps its prefix as the module and the written clauses as names.
(namespace_use_declaration (namespace_use_clause [(qualified_name) (name)] @import.module alias: (name)? @import.alias)) @import
(namespace_use_declaration (namespace_name) @import.module body: (namespace_use_group) @import.names) @import
(class_declaration (base_clause [(name) (qualified_name)] @inherits))
(interface_declaration (base_clause [(name) (qualified_name)] @inherits))
(class_declaration (class_interface_clause [(name) (qualified_name)] @implements))
; The package's query matches a call or `new` only through a qualified name or a variable; a plain `f()` or `new C()` names a bare name (FR850).
(function_call_expression function: (name) @name) @reference.call
(object_creation_expression (name) @name) @reference.class
