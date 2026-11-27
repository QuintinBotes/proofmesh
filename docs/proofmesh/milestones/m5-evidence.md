# M5 evidence: workspaces, cross-repository links, discovery, the ecosystem overview, and table reach

M5 as the goal states it: multi-repository workspaces and contract adapters (A7), discovery (A10), the ecosystem overview with drill-down (A11), and data models and table reach with runtime-observation import (A9).

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests, and `pnpm check:traceability` checks the mapping. The M5 code was built on ten parallel branches and merged with `--no-ff`, in pre-publication history.

## Items and proof

| Item | Proof |
|---|---|
| Named workspaces: `proofmesh workspace add`, `list`, `remove`; catalog migration 0009 (A29) | `packages/proofmesh/test/workspace.test.ts` |
| Cross-repository links sealed in a workspace link file (format 0.1): HTTP routes, channels, packages and service names, each with a confidence; unmatched client facts are boundaries; `proofmesh workspace link` (A7, A28) | `packages/proofmesh/test/links.test.ts`, `fixtures/cs-links` |
| `get_ecosystem`: the workspace's members, links and boundaries from one sealed link file; the envelope admits a link file as its snapshot (A11, A28) | `packages/proofmesh/test/ecosystem.test.ts` |
| The Observatory Ecosystem view: repositories as nodes coloured by their relation to the selected one, links as edges, boundaries as stubs, a table equivalent, the selected repository's links and samples beside the graph, and drill-down that loads only the chosen repository, with browser history; unlinked repositories never share a point (B19) (A11) | `apps/observatory/test/ecosystem.test.ts`, `e2e/ecosystem.spec.ts` |
| `proofmesh discover --anchor` ranks related repositories by the anchor's evidence through read-only `gh` queries: a name maps exactly, then by name tokens, then (for a service) by code search; code search excludes the anchor; ties prefer non-empty, then recently pushed repositories (prototype bugs B21, B22); `proofmesh clone` fetches one repository (A10) | `packages/proofmesh/test/discover.test.ts` |
| Named HTTP clients as `service` symbols and `calls_service` (C#), linked by `service_name` end to end; service registry files linked by `service_registry` (A7, A10) | `packages/proofmesh/test/service-links.test.ts`, `fixtures/cs-services` |
| A table is its name (A36): `get_table_reach` joins `table` symbols that share a qualified name, ignoring case, whichever adapter declared them, so an EF entity meets a SQL `CREATE TABLE` and a Prisma model meets the TypeScript code that queries it through Prisma Client | `packages/proofmesh/test/table-reach.test.ts`, `packages/proofmesh/test/prisma.test.ts`, `fixtures/ts-prisma` |
| Inbound endpoints and jobs in Python (FastAPI, Flask, Django, Celery), so tables reached from them and `http_route` links into Python services (A7, A9) | `packages/proofmesh/test/python.frameworks.test.ts`, `packages/proofmesh/test/links.test.ts`, `fixtures/py-routes` |
| Inbound HTTP endpoints in TypeScript (Express, NestJS), so tables reached from them and `http_route` links into Node services (A7, A9) | `packages/proofmesh/test/typescript.routes.test.ts`, `packages/proofmesh/test/typeorm.test.ts`, `packages/proofmesh/test/links.test.ts`, `fixtures/ts-routes` |
| Entity-to-table rules beyond EF: SQLAlchemy and Django (Python), TypeORM (TypeScript) (A9) | `packages/proofmesh/test/python.frameworks.test.ts`, `packages/proofmesh/test/typeorm.test.ts` |
| `get_table_reach`: which endpoints and jobs statically reach a table, labelled "static reach, not load"; `proofmesh observe import` reads a Proofmesh JSON observations file (0.1: counts per endpoint, table or channel; 0.2 adds entity property reads per endpoint from an instrumented run, reported per table with the property symbol when the snapshot has one; 0.3 adds who read it, ORM or application, with `get_property_reads` by endpoint or entity); catalog migrations 0010, 0014 and 0015 (A9, A30) | `packages/proofmesh/test/table-reach.test.ts`, `fixtures/cs-tables` (`observations.json`, `property-reads.json`) |

## Link rules

| Rule | Source fact | Target | Confidence |
|---|---|---|---|
| `http_route` | an outbound `dispatches_to` to an `endpoint`, from C# Refit interfaces or Python HTTP clients | an `endpoint` another member `exposes`, matched after normalising verb, slashes and case, with `{param}` matching one segment | 1.0 exact, 0.9 literal against a parameter, 0.6 client path a suffix of the server path, 0.8 when only the verb differs; `ANY` on either side is a wildcard; a catch-all server route (`{*path}`) never matches, nor does a match in which no literal segment matched literally (rule version 3); several targets are `candidate`, none is `unresolved`/`no_match` |
| `messaging` | `publishes` to a `channel` | the same channel another member `consumes` | 1.0 |
| `package` | `depends_on_package` | a `project` symbol with the package's name | 0.9 |
| `service_name` | `calls_service` to a `service` | a member repository whose name matches after stripping `Service`, `.Api` and `-api` | 0.7, repository-level |
| `service_registry` | an entry of a member's service registry file (`proofmesh workspace add ... --registry <repository>:<path>`, catalog migration 0018), read from that member's snapshot | the member repository the entry names | 1.0 exact repository name, 0.8 service-name match; a tie gives candidates, no match a boundary on the registry's member |

| `cloud_deploy` (link format 0.2, A35) | a hosting resource in Terraform or Pulumi (web, container or function app, App Service, Lambda, ECS service or task definition, Cloud Run, Kubernetes deployment, Helm release), by the attribute that names it for its type, its Pulumi logical name, or the repository part of a container image literal, read from its block in the declaring member's snapshot | the member repository that name denotes (`deploys`) | 0.9 exact repository name, 0.7 service-name match; ties are candidates; a resource naming nothing in the workspace is no link and no boundary |
| `cloud_messaging` (link format 0.2, A35) | a channel a member publishes or consumes | a messaging resource (Service Bus topic, queue or subscription, Event Hub, SNS, SQS, Kafka or Pub/Sub topic) another member declares with that name (`uses_resource`) | 1.0 exact, 0.9 ignoring case |
| `package_symbol` (link format 0.3, #28) | a TypeScript `calls`, `inherits`, `implements` or `references` site resolved to a symbol of an installed npm package | the symbol of that name in the member whose `package.json` builds the package (the link's type is the site's) | 1.0 when the installed version is the built one; 0.8, `detail.inferred` `version_mismatch`, otherwise; two builders or two symbols of the name are candidates; a package no member builds is no link |

A fact whose match is inside its own repository is not a link. The link file's identity is the member snapshot ids and the rule versions, plus the registry paths when a workspace names any, so re-indexing one member rebuilds only the link file. The link format version joins the identity too, and a link's id includes its rule, since two rules can extend the same fact. A registry entry is a fact of the callee's file, not of the caller's code, so its link records the entry (`<path>#<name>`) where other links record the caller's symbol, and an unmatched entry is a boundary on the registry's member: a decision taken to keep the link columns as they are.

## Measured on a private workspace

A workspace of two private repositories, a Python service and a C# repository, was linked on 2026-11-10 (http_route rule version 3). The run found that linking read each member's endpoints and projects once per fact; they are now read once per link. Its counts are kept with the private evaluation results; the repositories are not named here.

## Amendments made during M5

A28 to A30, revision 14 of the ADR, decided by the maintainer: cross-repository links live in a sealed workspace link file apart from the member snapshots; an ecosystem is a named workspace; runtime observations are imported from a Proofmesh JSON schema and never from a vendor's service.

## Known limits

- Candidate (`ambiguous`) links have no fixture; only their code exists.
- `get_table_reach` reports the shortest path length but no path sample; `analyze_impact` does not keep parents.
- Observations are stored for endpoints and channels too, but only `get_table_reach` reports them.
- `discover` ranks heuristically: name equality or name tokens for packages and services, raw code-search hits for the rest, at most 20 terms, no pagination beyond 20 hits per term. It needs an authenticated `gh`; the real `gh` is never run in tests, so the `-repo:` exclusion is checked as the query sent, not as GitHub's answer.
- Cloud links read a resource's literal names with a small tokenizer, not an HCL parser: a heredoc or a value on the line after its key is missed, and a name built from variables or interpolation is never matched.
