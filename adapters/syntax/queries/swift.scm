; The package's query names a type's whole body as each of its methods and finds no calls or imports, so this one replaces it.
(class_declaration declaration_kind: ["class" "actor"] name: (type_identifier) @name) @definition.class
(class_declaration declaration_kind: "struct" name: (type_identifier) @name) @definition.struct
(class_declaration declaration_kind: "enum" name: (type_identifier) @name) @definition.enum
(protocol_declaration name: (type_identifier) @name) @definition.interface
; An extension declares nothing itself; its members are named after the type it extends.
(class_declaration declaration_kind: "extension" name: (_) @name) @scope
(function_declaration name: (simple_identifier) @name) @definition.function
(class_body (function_declaration name: (simple_identifier) @name) @definition.method)
(enum_class_body (function_declaration name: (simple_identifier) @name) @definition.method)
(protocol_body (protocol_function_declaration name: (simple_identifier) @name) @definition.method)
(class_body (property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition.member)
(enum_class_body (property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition.member)
(protocol_body (protocol_property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition.member)
(import_declaration (identifier) @name) @import
(call_expression . (simple_identifier) @name) @reference.call
(call_expression . (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @name))) @reference.call
