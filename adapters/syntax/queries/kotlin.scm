(class_declaration name: (_) @name) @definition.class
(object_declaration name: (_) @name) @definition.class
(companion_object name: (_) @name) @definition.class
(function_declaration name: (_) @name) @definition.function
(call_expression . (identifier) @name) @reference.call
(call_expression . (navigation_expression (identifier) @name .)) @reference.call
; Imports and supertypes (FR221, FR222). A class named in a constructor call is a class; the tier cannot tell what any other entry is. An anonymous object has no name, so its supertypes are not the enclosing type's.
(import . (qualified_identifier) @import.module "*"? @import.wildcard (identifier)? @import.alias) @import
(_ name: (_) (delegation_specifiers (delegation_specifier (constructor_invocation (user_type) @inherits))))
(_ name: (_) (delegation_specifiers (delegation_specifier . (user_type) @inherits.supertype)))
(_ name: (_) (delegation_specifiers (delegation_specifier (explicit_delegation . (user_type) @inherits.supertype))))
