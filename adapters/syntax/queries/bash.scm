(function_definition name: (word) @name) @definition.function
(command name: (command_name (word) @name)) @reference.call
; `source` and `.` of a literal path are imports too (FR231), and stay calls. A path with an expansion in it names no module.
(command name: (command_name (word) @_c) . argument: [(word) (raw_string) (string . (string_content) .)] @import.module (#any-of? @_c "source" ".")) @import
