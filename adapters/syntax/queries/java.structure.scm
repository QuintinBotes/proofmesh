; Appended to the package's tags query: import declarations, and the supertypes a class, enum or record names (FR115, FR116).
(import_declaration . [(scoped_identifier) (identifier)] @import.module (asterisk)? @import.wildcard) @import
(superclass [(type_identifier) (scoped_type_identifier)] @inherits)
(superclass (generic_type . [(type_identifier) (scoped_type_identifier)] @inherits))
(super_interfaces (type_list [(type_identifier) (scoped_type_identifier)] @implements))
(super_interfaces (type_list (generic_type . [(type_identifier) (scoped_type_identifier)] @implements)))
