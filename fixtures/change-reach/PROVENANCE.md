# Provenance

Project-authored for Proofmesh. Apache-2.0. A change to a stats function moves the roles that call it; `impact_completeness` must list each changed symbol with every caller, implementer and importer, and mark each changed, tested or neither. `base/` is the first commit; `head/` and `head-delete/` hold only the files each changes on top of it. `expected/` holds what `proofmesh completeness --format markdown|sarif|github` prints for base..head, commits and snapshot ids written as placeholders (#245).
