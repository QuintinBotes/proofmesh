; Appended to the package's tags query: import declarations, the enums, records and annotation types the package's query lacks, and the supertypes a type names (FR115, FR116).
(import_declaration . [(scoped_identifier) (identifier)] @import.module (asterisk)? @import.wildcard) @import
(superclass [(type_identifier) (scoped_type_identifier)] @inherits)
(superclass (generic_type . [(type_identifier) (scoped_type_identifier)] @inherits))
(super_interfaces (type_list [(type_identifier) (scoped_type_identifier)] @implements))
(super_interfaces (type_list (generic_type . [(type_identifier) (scoped_type_identifier)] @implements)))
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.class
(annotation_type_declaration name: (identifier) @name) @definition.interface
; A `new` of a qualified or generic type: the callee is the last identifier, and the qualifier is read from the node (FR171).
(object_creation_expression type: (scoped_type_identifier (type_identifier) @name .)) @reference.class
(object_creation_expression type: (generic_type . (type_identifier) @name)) @reference.class
(object_creation_expression type: (generic_type . (scoped_type_identifier (type_identifier) @name .))) @reference.class
