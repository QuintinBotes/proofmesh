# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A root module and one local child module covering the cases the plan names for Terraform: resources, a data source, a variable, a local, outputs, a local module whose output the root reads, and a remote module, which stays unresolved because nothing runs `terraform init`. `output.ghost` references an undeclared resource as a decoy. The expected facts in `expected.json`, including the `relationships` section, are written by hand.
