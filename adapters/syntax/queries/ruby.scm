(method name: (_) @name) @definition.method
(singleton_method name: (_) @name) @definition.method
(class name: [(constant) @name (scope_resolution name: (_) @name)]) @definition.class
(module name: [(constant) @name (scope_resolution name: (_) @name)]) @definition.module
(call method: (identifier) @name) @reference.call
; Imports and heritage (FR221, FR222): require and require_relative of a string, the superclass, and include inside a class or module.
(call !receiver method: (identifier) @_m arguments: (argument_list . (string) @import.module) (#any-of? @_m "require" "require_relative")) @import
(class superclass: (superclass [(constant) (scope_resolution)] @inherits))
(class body: (body_statement (call !receiver method: (identifier) @_m arguments: (argument_list [(constant) (scope_resolution)] @inherits.include) (#eq? @_m "include"))))
(module body: (body_statement (call !receiver method: (identifier) @_m arguments: (argument_list [(constant) (scope_resolution)] @inherits.include) (#eq? @_m "include"))))
