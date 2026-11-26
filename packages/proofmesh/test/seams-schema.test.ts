import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, indexedRepo, symbolId, tool, withSnapshot } from './helpers.js'

type Rel = { type: string; direction: string; resolution: string; origin: string; basis?: string; reason: string | null; other: { qualified_name?: string }; site: { path: string; start_line: number }; detail: Record<string, string> | null; candidates?: unknown[] }
/** The id of the symbol of that name declared in that file: a GraphQL field has one in its schema, its resolver's file and each caller's. */
const idIn = (dataDir: string, file: string, qualified: string) => withSnapshot(dataDir, (db) => (db.prepare('select s.id from symbol s join file f on f.id = s.file_id where f.path = ? and s.qualified_name = ?').get(file, qualified) as { id: string } | undefined)?.id ?? `missing ${qualified} in ${file}`)
const rels = (dataDir: string, id: string, types: string[], direction: 'in' | 'out') => tool(dataDir, 'get_relationships', { subject_id: id, direction, types }).data.relationships as Rel[]
/** The rows the schema seams pass wrote, as `source -> target` with their resolution, reason and detail. */
const seams = (dataDir: string) => withSnapshot(dataDir, (db) => db.prepare(`select a.type, a.resolution, a.reason, s.qualified_name as src, t.qualified_name as dst, a.detail from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id
  where a.adapter = 'seams-schema' order by a.type, src, dst`).all() as Array<{ type: string; resolution: string; reason: string | null; src: string; dst: string | null; detail: string }>).map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, string> }))
const declared = (dataDir: string, file: string) => withSnapshot(dataDir, (db) => db.prepare('select s.kind, s.qualified_name, s.start_line from symbol s join file f on f.id = s.file_id where f.path = ? and s.kind <> \'module\' order by s.start_line, s.qualified_name').all(file))
const TS = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true } })
const PROTO = 'syntax = "proto3";\npackage shop.v1;\nservice Orders {\n  rpc GetOrder(Req) returns (Res);\n}\nmessage Req {}\nmessage Res {}\n'

describe('FR400 to FR405 schema-first contracts on fixtures/seams-schema: RPCs and GraphQL fields linked to implementations and callers, labelled inferred', () => {
  let dataDir = ''
  beforeAll(async () => { dataDir = (await indexedDataDir(fixtureRepo('seams-schema'))).dataDir }, 120000)

  it('FR400 scenario 1: proto/orders.proto declares endpoint grpc shop.v1.Orders/GetOrder and messages shop.v1.GetOrderRequest and shop.v1.Order, each at its line; go_package changes no name', () => {
    expect(declared(dataDir, 'proto/orders.proto')).toEqual([
      { kind: 'endpoint', qualified_name: 'grpc shop.v1.Orders/GetOrder', start_line: 8 },
      { kind: 'endpoint', qualified_name: 'grpc shop.v1.Orders/CancelOrder', start_line: 10 },
      { kind: 'message', qualified_name: 'shop.v1.GetOrderRequest', start_line: 13 },
      { kind: 'message', qualified_name: 'shop.v1.Order', start_line: 17 },
    ])
    expect(withSnapshot(dataDir, (db) => db.prepare("select s.signature, f.disposition, e.source_kind from symbol s join file f on f.id = s.file_id join evidence e on e.id = s.evidence_id where s.qualified_name = 'grpc shop.v1.Orders/GetOrder'").get())).toEqual({ signature: 'rpc GetOrder(GetOrderRequest) returns (Order)', disposition: 'indexed', source_kind: 'declaration' })
  })

  it('FR403 scenario 2: the endpoint exposes server.GetOrder in server/orders.go (rule grpc_server) and fetch in client/fetch.py dispatches_to it (rule grpc_client), both inferred', () => {
    const id = idIn(dataDir, 'proto/orders.proto', 'grpc shop.v1.Orders/GetOrder')
    expect(rels(dataDir, id, ['exposes'], 'out').map((r) => ({ to: r.other.qualified_name, resolution: r.resolution, origin: r.origin, basis: r.basis, rule: r.detail!.rule, base: r.detail!.base, path: r.site.path, line: r.site.start_line }))).toEqual([
      { to: 'server/orders:server.GetOrder', resolution: 'resolved', origin: 'contract_match', basis: 'inferred', rule: 'grpc_server', base: 'pb.UnimplementedOrdersServer', path: 'proto/orders.proto', line: 8 },
    ])
    expect(rels(dataDir, id, ['dispatches_to'], 'in').map((r) => ({ from: r.other.qualified_name, resolution: r.resolution, basis: r.basis, rule: r.detail!.rule, stub: r.detail!.stub, path: r.site.path, line: r.site.start_line }))).toEqual([
      { from: 'client/fetch:fetch', resolution: 'resolved', basis: 'inferred', rule: 'grpc_client', stub: 'OrdersStub', path: 'client/fetch.py', line: 11 },
    ])
  })

  it('FR401 FR402 FR404 scenario 3: schema.graphql declares graphql Query.order and types Order and Query; the resolver map function exposes-links to it and loadOne dispatches_to it, inferred', () => {
    expect(declared(dataDir, 'schema.graphql')).toEqual([
      { kind: 'class', qualified_name: 'schema:Query', start_line: 1 },
      { kind: 'endpoint', qualified_name: 'graphql Query.order', start_line: 2 },
      { kind: 'class', qualified_name: 'schema:Order', start_line: 5 },
    ])
    const id = idIn(dataDir, 'schema.graphql', 'graphql Query.order')
    expect(rels(dataDir, id, ['exposes'], 'out').map((r) => ({ to: r.other.qualified_name, basis: r.basis, rule: r.detail!.rule }))).toEqual([{ to: 'api/resolvers:resolvers.Query.order', basis: 'inferred', rule: 'graphql_resolver_map' }])
    expect(rels(dataDir, id, ['dispatches_to'], 'in').map((r) => ({ from: r.other.qualified_name, basis: r.basis, rule: r.detail!.rule, path: r.site.path, line: r.site.start_line }))).toEqual([{ from: 'web/query:loadOne', basis: 'inferred', rule: 'graphql_operation', path: 'web/query.ts', line: 4 }])
    // The inline resolver is a function of its own, so the call inside it is its call and not the map's.
    expect(rels(dataDir, symbolId(dataDir, 'api/resolvers:resolvers.Query.order'), ['calls'], 'out').map((r) => r.other.qualified_name)).toEqual(['api/resolvers:load'])
  })

  it('FR404 scenario 4: analyze_impact on server.GetOrder with include_inferred lists fetch in client/fetch.py as an inferred dependent', () => {
    const impact = tool(dataDir, 'analyze_impact', { subject_ids: [symbolId(dataDir, 'server/orders:server.GetOrder')], include_inferred: true, limits: { max_depth: 3 } }).data as { dependents: Array<{ qualified_name: string; path: string; basis: string }> }
    expect(impact.dependents.find((d) => d.qualified_name === 'client/fetch:fetch')).toMatchObject({ path: 'client/fetch.py', basis: 'inferred' })
  })

  it('FR405 scenario 5: an RPC no code implements is listed as declared with no implementation, and no link is invented for it', () => {
    const id = idIn(dataDir, 'proto/orders.proto', 'grpc shop.v1.Orders/CancelOrder')
    expect(rels(dataDir, id, ['exposes', 'dispatches_to'], 'out').map((r) => ({ type: r.type, resolution: r.resolution, reason: r.reason, why: r.detail!.why, line: r.site.start_line }))).toEqual([
      { type: 'exposes', resolution: 'unresolved', reason: 'unknown_name', why: 'declared_without_handler', line: 10 },
    ])
    expect(rels(dataDir, id, ['dispatches_to'], 'in')).toEqual([])
    // Every row of the pass is one the schema already had.
    expect(new Set(seams(dataDir).map((r) => r.type))).toEqual(new Set(['exposes', 'dispatches_to']))
  })
})

describe('FR400 FR401 contracts are read from their text and nothing else', () => {
  it('FR400 nested messages, streams, rpc options and comments; FR401 .gql files, extend, interfaces, enums, unions, inputs and a schema block that renames a root', async () => {
    const { dataDir } = await indexedRepo({
      'api.proto': [
        '// service Fake { rpc No(A) returns (B); }',
        'syntax = "proto3";',
        'package a.b;',
        'option java_package = "x.y";',
        'message Outer {',
        '  message Inner { string message = 1; }',
        '  map<string, Inner> items = 2;',
        '}',
        'service Feed {',
        '  /* rpc Hidden(A) returns (B); */',
        '  rpc Watch(stream .a.b.Outer) returns (stream Outer) { option deprecated = true; }',
        '}',
      ].join('\n') + '\n',
      'api.gql': [
        '"""The root."""',
        'schema { query: Root, mutation: Change }',
        'type Root implements Node & Base @key(fields: "id") {',
        '  "a field" me(first: Int = 10, filter: In = { a: [1, 2] }): [User!]! @deprecated(reason: "x")',
        '}',
        'type Query { notRoot: Int }',
        'extend type Change { rename(id: ID!): User }',
        'type Change { add: User }',
        'interface Node { id: ID! }',
        'input In { a: [Int] = [] }',
        'enum Role { ADMIN USER }',
        'union Who = | User | Root',
        'scalar Date @specifiedBy(url: "u")',
        'directive @key(fields: String!) repeatable on OBJECT | INTERFACE',
        'type User { id: ID! }',
      ].join('\n') + '\n',
    })
    expect(declared(dataDir, 'api.proto')).toEqual([
      { kind: 'message', qualified_name: 'a.b.Outer', start_line: 5 },
      { kind: 'message', qualified_name: 'a.b.Outer.Inner', start_line: 6 },
      { kind: 'endpoint', qualified_name: 'grpc a.b.Feed/Watch', start_line: 11 },
    ])
    expect(withSnapshot(dataDir, (db) => db.prepare("select signature, end_line from symbol where qualified_name = 'grpc a.b.Feed/Watch'").get())).toEqual({ signature: 'rpc Watch(stream . a.b.Outer) returns (stream Outer)', end_line: 11 })
    expect(declared(dataDir, 'api.gql')).toEqual([
      { kind: 'class', qualified_name: 'api:Root', start_line: 3 },
      { kind: 'endpoint', qualified_name: 'graphql Query.me', start_line: 4 },
      { kind: 'class', qualified_name: 'api:Query', start_line: 6 },
      { kind: 'endpoint', qualified_name: 'graphql Mutation.rename', start_line: 7 },
      { kind: 'class', qualified_name: 'api:Change', start_line: 8 },
      { kind: 'endpoint', qualified_name: 'graphql Mutation.add', start_line: 8 },
      { kind: 'interface', qualified_name: 'api:Node', start_line: 9 },
      { kind: 'class', qualified_name: 'api:In', start_line: 10 },
      { kind: 'enum', qualified_name: 'api:Role', start_line: 11 },
      { kind: 'type_alias', qualified_name: 'api:Who', start_line: 12 },
      { kind: 'type_alias', qualified_name: 'api:Date', start_line: 13 },
      { kind: 'class', qualified_name: 'api:User', start_line: 15 },
    ])
  })

  it('FR400 FR401 a contract that does not parse, or nests deeper than 200 levels, is failed with invalid_proto or invalid_graphql and the line, and declares nothing', async () => {
    const { dataDir } = await indexedRepo({ 'bad.proto': 'syntax = "proto3";\nservice S {\n  rpc A(B) returns (C);\n', 'bad.graphql': 'type Query {\n  a: Int\n  b\n}\n', 'bad.deep.graphql': `{ ${'... on Query { '.repeat(300)}a${' }'.repeat(300)} }\n` })
    expect(withSnapshot(dataDir, (db) => db.prepare("select path, disposition_detail from file where path like 'bad.%' order by path").all())).toEqual([
      { path: 'bad.deep.graphql', disposition_detail: 'invalid_graphql:line 1: fragments nest deeper than 200 levels' },
      { path: 'bad.graphql', disposition_detail: 'invalid_graphql:line 3: field b has no type' },
      { path: 'bad.proto', disposition_detail: 'invalid_proto:line 2: "{" is never closed' },
    ])
    expect(withSnapshot(dataDir, (db) => db.prepare("select count(*) as n from symbol where kind in ('endpoint', 'message')").get())).toEqual({ n: 0 })
  })
})

describe('FR402 FR404 FR405 GraphQL in TypeScript: resolver maps, gql operations and SDL templates', () => {
  it('FR402 aliases, inline and named fragments, mutations and __typename; a named resolver; SDL in a gql template declares; an undeclared field stays an unresolved boundary with its name', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'schema.ts': "declare function gql(s: TemplateStringsArray, ...v: unknown[]): string\nexport const typeDefs = gql`\n  type Query { order: Int, orders: [Int] }\n  type Mutation { cancel(id: ID!): Int }\n`\n",
      'resolvers.ts': "function cancelOrder() { return 1 }\nexport const resolvers = {\n  Query: { order() { return 1 }, 'orders': () => [] },\n  Mutation: { cancel: cancelOrder },\n}\n",
      'client.ts': [
        "declare function gql(s: TemplateStringsArray, ...v: unknown[]): string",
        "const F = gql`fragment F on Query { orders }`",
        "export function one() { return gql`query { first: order __typename ... on Query { orders } ...F ${F} }` }",
        "export function two() { return gql`mutation M($id: ID!) { cancel(id: $id) }` }",
        "export function three() { return gql`{ missing { id } }` }",
      ].join('\n') + '\n',
    })
    const rows = seams(dataDir).map((r) => `${r.type} ${r.src} -> ${r.dst ?? r.reason} ${r.detail.rule}${r.detail.field ? ` ${r.detail.field}` : ''}`)
    expect(rows).toEqual([
      'dispatches_to client:one -> graphql Query.order graphql_operation',
      'dispatches_to client:one -> graphql Query.orders graphql_operation',
      'dispatches_to client:three -> unknown_name graphql_operation Query.missing',
      'dispatches_to client:two -> graphql Mutation.cancel graphql_operation',
      'exposes graphql Mutation.cancel -> resolvers:cancelOrder graphql_resolver_map',
      'exposes graphql Query.order -> resolvers:resolvers.Query.order graphql_resolver_map',
      'exposes graphql Query.orders -> resolvers:resolvers.Query.orders graphql_resolver_map',
    ])
    // The SDL template's fields are declared in schema.ts, each at its line.
    expect(declared(dataDir, 'schema.ts').filter((s) => (s as { kind: string }).kind === 'endpoint')).toEqual([
      { kind: 'endpoint', qualified_name: 'graphql Query.order', start_line: 3 },
      { kind: 'endpoint', qualified_name: 'graphql Query.orders', start_line: 3 },
      { kind: 'endpoint', qualified_name: 'graphql Mutation.cancel', start_line: 4 },
    ])
  })

  it('FR405 a field two contracts declare makes its operation ambiguous between them; a gql template that is no GraphQL makes the file framework partial', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'a.graphql': 'type Query { order: Int }\n',
      'b.graphql': 'type Query { order: Int }\n',
      'client.ts': "declare function gql(s: TemplateStringsArray): string\nexport const q = () => gql`{ order }`\nexport const bad = () => gql`{ order`\n",
    })
    expect(seams(dataDir).filter((r) => r.type === 'dispatches_to').map((r) => ({ src: r.src, resolution: r.resolution }))).toEqual([{ src: 'client:q', resolution: 'ambiguous' }])
    expect(withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select capabilities from file where path = 'client.ts'").get() as { capabilities: string }).capabilities).framework)).toBe('partial')
  })
})

describe('FR403 FR405 gRPC servers and clients by the conventions of generated code', () => {
  it('FR403 Go, Python, Java, C# and TypeScript servers and clients link to the RPC, inferred, and each adapter names a supertype it cannot bind', async () => {
    const { dataDir } = await indexedRepo({
      'tsconfig.json': TS,
      'orders.proto': PROTO,
      'go/server.go': 'package main\n\nimport pb "x/pb"\n\ntype impl struct {\n\tpb.UnimplementedOrdersServer\n}\n\nfunc (s *impl) GetOrder() {}\n\nfunc run(conn int) {\n\tc := pb.NewOrdersClient(conn)\n\tc.GetOrder(nil, nil)\n}\n',
      'py/server.py': 'import orders_pb2_grpc\n\n\nclass Impl(orders_pb2_grpc.OrdersServicer):\n    def GetOrder(self, request, context):\n        return None\n',
      'java/Server.java': 'package shop;\n\nclass Impl extends OrdersGrpc.OrdersImplBase {\n  public void getOrder(Req r, Obs o) {}\n}\n\nclass Cli {\n  void run(Ch ch) {\n    OrdersGrpc.OrdersBlockingStub s = OrdersGrpc.newBlockingStub(ch);\n    s.getOrder(null);\n  }\n}\n',
      'cs/Server.cs': 'namespace Shop;\n\npublic class Impl : Orders.OrdersBase {\n  public void GetOrder(object r) {}\n}\n\npublic class Cli {\n  public void Run(object ch) {\n    var c = new Orders.OrdersClient(ch);\n    c.GetOrderAsync(null);\n  }\n}\n',
      'cs/app.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
      'ts/server.ts': "import { IOrdersServer, OrdersClient } from './gen/orders_grpc_pb'\n\nexport class Impl implements IOrdersServer {\n  getOrder(call: unknown, cb: unknown) {}\n}\n\nexport function run() {\n  const c = new OrdersClient('x', null)\n  c.getOrder({}, () => {})\n}\n",
    })
    expect(seams(dataDir).map((r) => `${r.type} ${r.src} -> ${r.dst} ${r.detail.rule} ${r.detail.base ?? r.detail.stub}`)).toEqual([
      'dispatches_to Shop.Cli.Run -> grpc shop.v1.Orders/GetOrder grpc_client OrdersClient',
      'dispatches_to go/server:run -> grpc shop.v1.Orders/GetOrder grpc_client NewOrdersClient',
      'dispatches_to shop.Cli.run -> grpc shop.v1.Orders/GetOrder grpc_client newBlockingStub',
      'dispatches_to ts/server:run -> grpc shop.v1.Orders/GetOrder grpc_client OrdersClient',
      'exposes grpc shop.v1.Orders/GetOrder -> Shop.Impl.GetOrder grpc_server Orders.OrdersBase',
      'exposes grpc shop.v1.Orders/GetOrder -> go/server:impl.GetOrder grpc_server pb.UnimplementedOrdersServer',
      'exposes grpc shop.v1.Orders/GetOrder -> py/server:Impl.GetOrder grpc_server orders_pb2_grpc.OrdersServicer',
      'exposes grpc shop.v1.Orders/GetOrder -> shop.Impl.getOrder grpc_server OrdersGrpc.OrdersImplBase',
      'exposes grpc shop.v1.Orders/GetOrder -> ts/server:Impl.getOrder grpc_server IOrdersServer',
    ])
  })

  it('FR405 generated stubs are flagged generated and are binding targets, not implementations; a call of an RPC no stub makes links nothing', async () => {
    const { dataDir } = await indexedRepo({
      'orders.proto': PROTO,
      'pb/orders_grpc.pb.go': '// Code generated by protoc-gen-go-grpc. DO NOT EDIT.\n\npackage pb\n\ntype OrdersServer interface {\n\tGetOrder() error\n}\n\ntype UnimplementedOrdersServer struct{}\n\nfunc (UnimplementedOrdersServer) GetOrder() error { return nil }\n\nfunc NewOrdersClient(cc int) int { return cc }\n',
      'server/impl.go': 'package server\n\nimport "x/pb"\n\ntype impl struct {\n\tpb.UnimplementedOrdersServer\n}\n\nfunc (s *impl) GetOrder() error { return nil }\n\nfunc other(x interface{ GetOrder() }) {\n\tx.GetOrder()\n}\n',
    })
    expect(withSnapshot(dataDir, (db) => JSON.parse((db.prepare("select capabilities from file where path = 'pb/orders_grpc.pb.go'").get() as { capabilities: string }).capabilities).generated)).toBe('true')
    expect(seams(dataDir).map((r) => `${r.type} ${r.src} -> ${r.dst ?? r.reason}`)).toEqual(['exposes grpc shop.v1.Orders/GetOrder -> server/impl:impl.GetOrder'])
  })
})
