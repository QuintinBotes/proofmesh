# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture, and the names (orders, inventory, legacy) are invented.

One repository with a TypeScript front end (`web/`), a FastAPI service (`api/`), a Go handler (`services/inventory/`) and two API descriptions: `openapi.yaml` (OpenAPI 3.0, YAML) and `services/inventory/swagger.json` (Swagger 2.0, JSON, with a `basePath`). It exercises the HTTP seams of FR250 to FR259:

- `web/src/orders.ts`: a `fetch` with a template literal and an `axios.get`, each served by a FastAPI route that `app.include_router(router, prefix="/api")` mounts.
- `web/src/edge.ts`: a call nothing serves (`/api/unknown`), a call to an endpoint the description declares and no code serves (`POST /api/legacy`), and a path built on a base held in a variable.
- `web/src/inventory.ts`: a call served only by the Go function the Swagger document's `operationId` names (Go has no route rules, so no code declares `GET /api/inventory`).

The expected facts are written by hand in `packages/proofmesh/test/seams-http.test.ts`.
