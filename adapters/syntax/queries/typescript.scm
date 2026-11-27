; The syntax tier's whole query for TypeScript, TSX and JavaScript (FR310): the package's own query is only the part meant to be
; appended to JavaScript's. Names follow the precise adapter: a top-level declaration, a class or interface member, a namespace member.
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: [(type_identifier) (identifier)] @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(type_alias_declaration name: (type_identifier) @name) @definition.type
; A namespace is a scope, as for the precise tier: no symbol, but part of the name of what it holds.
(internal_module name: [(identifier) (nested_identifier)] @name) @scope
; A constructor is no method of the precise tier; a get or set accessor is one (a get/set pair is one method, as in the precise tier).
(class_body (method_definition name: [(property_identifier) (private_property_identifier)] @name (#not-eq? @name "constructor")) @definition.method)
(abstract_method_signature name: (property_identifier) @name) @definition.method
(interface_body (method_signature name: (property_identifier) @name) @definition.method)
; A top-level constant holding a function is a function; any other top-level declaration is a variable (A5).
(program (_ (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @definition.function))
(program (export_statement declaration: (_ (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)]) @definition.function)))
(program (_ (variable_declarator name: (identifier) @name) @definition.constant))
(program (export_statement declaration: (_ (variable_declarator name: (identifier) @name) @definition.constant)))
; Calls: the name is the last one written, and the target is never claimed.
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: [(property_identifier) (private_property_identifier)] @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.call
(new_expression constructor: (member_expression property: (property_identifier) @name)) @reference.call
; Imports, re-exports and `import x = require()` (FR115).
(import_statement source: (string) @import.module) @import
(import_statement (import_require_clause source: (string) @import.module)) @import
(export_statement source: (string) @import.module) @import
; Heritage (FR116): `extends` and `implements` are told apart by the syntax.
(class_heritage (extends_clause value: [(identifier) (member_expression)] @inherits))
(class_heritage (implements_clause [(type_identifier) (nested_type_identifier) (generic_type)] @implements))
(interface_declaration (extends_type_clause type: [(type_identifier) (nested_type_identifier) (generic_type)] @inherits))
