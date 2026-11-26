; The syntax tier's query for C# (FR310). Names are Roslyn's, so a declaration has the same key under both tiers: the namespace is
; read from the source by the tier (a block or a file-scoped one), a generic type is named with its parameters, and an overload is
; not told apart by its parameter types here. A namespace is no symbol.
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(record_declaration "struct" name: (identifier) @name) @definition.struct
(struct_declaration name: (identifier) @name) @definition.struct
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(delegate_declaration name: (identifier) @name) @definition.type
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.member
(enum_member_declaration name: (identifier) @name) @definition.field
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name) @definition.field))
; Calls: the name is the last one written, and the target is never claimed.
(invocation_expression function: (identifier) @name) @reference.call
(invocation_expression function: (generic_name (identifier) @name)) @reference.call
(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.call
(invocation_expression function: (member_access_expression name: (generic_name (identifier) @name))) @reference.call
(invocation_expression function: (conditional_access_expression (member_binding_expression name: (identifier) @name))) @reference.call
(object_creation_expression type: (identifier) @name) @reference.call
(object_creation_expression type: (generic_name (identifier) @name)) @reference.call
(object_creation_expression type: (qualified_name name: (identifier) @name)) @reference.call
(object_creation_expression type: (qualified_name name: (generic_name (identifier) @name))) @reference.call
; Usings (FR115): the namespace or type as written, and the alias of `using A = B.C;`.
(using_directive !name . [(identifier) (qualified_name)] @import.module) @import
(using_directive name: (identifier) @import.alias . [(identifier) (qualified_name)] @import.module) @import
