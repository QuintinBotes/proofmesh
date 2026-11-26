(function_definition name: (word) @name) @definition.function
(command name: (command_name (word) @name)) @reference.call
; `source` and `.` of a literal path are imports too (FR231), and stay calls. A path with an expansion, or a glob, in it names no module.
(command name: (command_name (word) @_c) . argument: [(raw_string) (string . (string_content) .)] @import.module (#any-of? @_c "source" ".")) @import
; An unquoted word with a glob character names no one module.
(command name: (command_name (word) @_c) . argument: (word) @import.module (#any-of? @_c "source" ".") (#not-match? @import.module "[*?\\[]")) @import
