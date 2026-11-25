; Appended to the package's tags query: the type an impl block is for, so its methods are named under it (FR146).
(impl_item type: [(type_identifier) @name (generic_type type: (type_identifier) @name) (scoped_type_identifier name: (type_identifier) @name) (reference_type type: (type_identifier) @name)]) @scope
; Imports and heritage (FR221, FR222). A grouped `use` keeps its path as the module and the written entries as names; `mod x;` names the module `x`.
(use_declaration argument: (scoped_use_list path: (_) @import.module list: (use_list) @import.names)) @import
(use_declaration argument: [(scoped_identifier) (identifier) (use_wildcard)] @import.module) @import
(use_declaration argument: (use_as_clause path: (_) @import.module alias: (identifier) @import.alias)) @import
(mod_item name: (identifier) @import.module !body) @import
; An impl names its trait, and the implementing type is its owner. A trait names the traits it requires.
(impl_item trait: [(type_identifier) (scoped_type_identifier) (generic_type type: (_))] @implements type: (_) @owner)
(trait_item bounds: (trait_bounds [(type_identifier) (scoped_type_identifier) (generic_type type: (_))] @inherits))
(trait_item bounds: (trait_bounds (higher_ranked_trait_bound type: [(type_identifier) (scoped_type_identifier) (generic_type type: (_))] @inherits)))
(trait_item bounds: (trait_bounds (higher_ranked_trait_bound type: (function_type trait: (_) @inherits))))
