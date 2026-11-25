; Appended to the package's tags query, which finds no call: includes and call sites (FR224, FR226). A call with no written name, `(*fp)(x)`, has no callee to record.
(preproc_include path: [(system_lib_string) (string_literal)] @import.module) @import
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
