---
description: Check a claim that something is unused, unreachable or absent before asserting it
argument-hint: <claim, such as "nothing calls LegacyExporter.Run">
---

Turn `$ARGUMENTS` into the structured claim the Proofmesh `verify_claim` tool takes, resolving each named symbol with `find_symbols` first and passing it as `{ name, path }`, the name its row shows and the file that declares it. Call `verify_claim` and repeat its conclusion exactly as given, with its layers and the evidence it cites. A claim that is only `bounded` or `qualified` is not "none": say what bounded it.
