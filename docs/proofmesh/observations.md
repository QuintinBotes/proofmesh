# Runtime observations

Proofmesh never connects to a metrics system or a running service (A30). A person exports what they observed into a JSON file in the Proofmesh observations schema and imports it with `proofmesh observe import <repository> <file>`. The counts are then shown beside static facts as what was observed in that window, never as load derived from code.

## The file

`schemas/observations/0.3.schema.json` (0.1 and 0.2 files are still accepted):

- `source`: where the numbers came from; `window`: the observed interval, RFC 3339.
- `counts`: requests per endpoint, rows read or written per table, messages per channel.
- `property_reads`: entity properties observed read while serving an endpoint. `entity` is the runtime type of the instance and `declaring_type` the declaring type when it differs (inherited or table-per-hierarchy properties). `reads` counts requests that read the property, `calls` counts getter calls. `read_kind` separates reads the ORM makes while materialising or tracking an entity (`orm`: loaded, not necessarily used) from reads by application code (`application`).

`proofmesh observe validate <file>` checks a file without importing it.

## Queries

- `get_table_reach` lists the reads of the entities mapped to a table beside the static reach.
- `get_property_reads` answers by endpoint or by entity, independent of table mapping: every read with its kind and callers, `loaded_not_used` (ORM reads with no application read, the candidates to leave out of a projection) and `unread_mapped_properties` (properties the snapshot declares on the entity that no import mentions).
- With an endpoint, `get_property_reads` also gives the static side: `static_reads`, the properties of mapped entities (their subtypes and base types) that code on a resolved path from the endpoint reads, with up to five readers and the hop count; `static_bound`, the calls on those paths with no single resolved target, past which reads are not seen; and `comparison`, which properties were read statically and observed, only statically, or only observed, counting application reads only. Static reads are an upper bound on one request and miss reflection and serialization: an entity returned whole is read property by property by the serializer.

A property absent from the imports was not seen read in that window. That is not evidence that nothing reads it, and every answer says so.

## Recording property reads in a .NET test run

A recipe that produced valid files for an ASP.NET application with an EF6 model, in an integration-test project. It is a capture helper a person adds to their own test project; Proofmesh ships no agent and runs nothing.

1. Patch every entity getter with a Harmony postfix. Enumerate the element types of every `DbSet` on the context and every subtype of them in the model assembly: patching only the `DbSet` element types misses every subtype.
2. Label each request. A Harmony prefix on the endpoint middleware's invoke method stores `METHOD RoutePattern.RawText` in an `AsyncLocal`, which matches Proofmesh endpoint names exactly. Clear the label when the request ends, or later reads inherit it.
3. Classify each read by walking the stack of every getter call: a frame inside the ORM's namespaces is an `orm` read, anything else an `application` read, and the nearest application frame is the caller. Sampling the first few stacks per property misclassifies everything as ORM, because the ORM reads first.
4. Aggregate per endpoint, runtime type, declaring type, property and kind: requests that read it, getter calls, up to twenty callers. Write the file and run `proofmesh observe validate`.
