# Security policy

## Reporting

Report a vulnerability privately through the repository's security advisory form ("Report a vulnerability" under the Security tab). Do not open a public issue. You will get an acknowledgement within 3 working days and a status update at least every 14 days until the report is resolved.

## Disclosure

We aim to ship a fix within 90 days of a confirmed report, sooner for anything that lets repository code run during indexing without a trust grant (INV16), lets a query mutate source or start execution (INV06), or lets a sealed snapshot change undetected (INV14). We credit reporters in the release notes unless they ask otherwise. Please give us the chance to release a fix before publishing details.

## Supported versions

Only the latest minor release receives security fixes. Snapshot format 0.5 and adapter protocol 1.x are the supported contracts; see COMPATIBILITY.md.

## Scope

In scope: the `proofmesh` CLI and MCP server, Observatory, the first-party adapters, the adapter protocol, the conformance kit and the release tooling. Out of scope: adapters a person installed with `proofmesh adapter add`, repositories a person trusted with `proofmesh repo trust`, and the host that runs a verification launcher, which are trust decisions documented in THREAT_MODEL.md.
