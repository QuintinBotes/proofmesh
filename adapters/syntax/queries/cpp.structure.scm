; Appended to the package's tags query: the class an out-of-class member definition belongs to, so `int A::f() {}` is named `A.f` (FR146).
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @name))) @scope
; Includes, base classes and call sites (FR231, FR232, FR233). A qualified or template callee is resolved to its last name in main.ts.
(preproc_include path: [(system_lib_string) (string_literal)] @import.module) @import
(base_class_clause [(type_identifier) (qualified_identifier) (template_type)] @inherits)
(call_expression function: [(identifier) (qualified_identifier) (template_function)] @name) @reference.call
(call_expression function: (field_expression field: [(field_identifier) (template_method) (dependent_name)] @name)) @reference.call
; A method defined outside its template class, `A<T>::f`, is named under the class like `A::f`.
(function_declarator declarator: (qualified_identifier scope: (template_type) name: (identifier) @name)) @definition.method
