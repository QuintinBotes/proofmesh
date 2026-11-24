# Threat model

Proofmesh indexes repositories a person names and answers questions about them to coding agents and to people. It hosts no model, calls no network service at run time except the `gh` commands a person invokes, and runs no repository code unless a person grants it.

## Assets

Repository source, the evidence store and sealed snapshots in the data directory, the catalog (trust grants, workspaces, installed adapters), and the host the person runs Proofmesh on.

## Trust boundaries

| Boundary | Who may cross it | How |
|---|---|---|
| Repository code → execution | Only a person | `proofmesh repo trust --build-evaluation` (D14) enables build evaluation for one repository; every fact produced that way carries `trusted_build`. Without it, adapters do static analysis only (INV16, FR079). |
| Third-party adapter code → the indexing process | Only a person | `proofmesh adapter add` pins the entry file by hash; it stops running when the file changes (D13). |
| Indexed files → the adapter | The core | Adapters see a materialized copy of captured content, never the live repository, and have no protocol operation that executes repository code (FR071). |
| Read tools → side effects | Nobody | Read requests cannot start tests, builds or installs, or mutate source (INV06). Verification execution is a separate, disabled-by-default capability with one-time approvals (D07, INV09). |
| Snapshot → tampering | Nobody | Sealed files are read-only and verified against their recorded digest on open (INV14). |
| History → public artifact | Only the fresh-history export and its leak scan | `pnpm release:export` (INV17, D12). |

## What Proofmesh does not defend against

A person who trusts a hostile repository or installs a hostile adapter has granted that code their permissions. Containers used by the verification launcher limit damage but are not a security boundary against a determined attacker. Observatory binds to loopback and is not designed for shared hosting (FR054).

## Residual risks

Python's Pyright and the TypeScript compiler read installed packages' type declarations; a malicious package cannot execute through them, but can mislabel symbols. Name-matched cross-repository links carry a confidence, never certainty.
