# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A package with a re-export in `__init__.py`, relative imports, methods called through `self` and through an instance whose type must be inferred, a dynamic `getattr` call, standard library calls, and a call into `requests`, which is deliberately not installed. `legacy.py` holds a same-named `total` as a decoy. The expected facts in `expected.json` are written by hand.
