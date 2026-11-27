# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code is copied: every file was written for this fixture, and the names (shop, orders) are invented.

One repository whose services meet through schema-first contracts. It exercises FR400 to FR405:

- `proto/orders.proto`: package `shop.v1`, a `go_package` option, service `Orders` with `GetOrder` (implemented and called) and `CancelOrder` (declared, implemented by nothing), and messages `GetOrderRequest` and `Order`.
- `server/orders.go`: a Go server type that embeds `pb.UnimplementedOrdersServer` and implements `GetOrder`.
- `client/fetch.py`: a Python function that builds `orders_pb2_grpc.OrdersStub(channel)` and calls `stub.GetOrder(req)`.
- `schema.graphql`: `type Query { order(id: ID!): Order }` and `type Order { id: ID! }`.
- `api/resolvers.ts`: a resolver map whose `Query.order` is an inline function.
- `web/query.ts`: a `gql` operation that selects `order`, inside `loadOne`.

The generated stubs (`orders_pb2_grpc.py`, `orders_grpc.pb.go`) are not part of the fixture: the rules read the names generated code gives, not its files. The expected facts are written by hand in `packages/proofmesh/test/seams-schema.test.ts`.
