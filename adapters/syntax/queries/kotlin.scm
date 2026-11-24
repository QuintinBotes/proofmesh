(class_declaration name: (_) @name) @definition.class
(object_declaration name: (_) @name) @definition.class
(function_declaration name: (_) @name) @definition.function
(call_expression . (identifier) @name) @reference.call
(call_expression . (navigation_expression (identifier) @name .)) @reference.call
