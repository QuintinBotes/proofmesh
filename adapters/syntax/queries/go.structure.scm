; Appended to the package's tags query: import specs and struct embedding (FR115, FR116).
(import_spec name: (_)? @import.alias path: (_) @import.module) @import
(field_declaration_list (field_declaration !name type: [(type_identifier) (qualified_type)] @inherits.embedding))
(field_declaration_list (field_declaration !name type: (pointer_type [(type_identifier) (qualified_type)] @inherits.embedding)))
(field_declaration_list (field_declaration !name type: (generic_type type: (_) @inherits.embedding)))
; The type a method's receiver names, pointer or value, so the method is named under it (FR146).
(method_declaration receiver: (parameter_list (parameter_declaration type: [(type_identifier) @name (generic_type type: (type_identifier) @name) (pointer_type [(type_identifier) @name (generic_type type: (type_identifier) @name)])]))) @scope
